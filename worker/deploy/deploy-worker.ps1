[CmdletBinding()]
param(
  [string]$Repo = $(if ($env:GAME_REPO) { $env:GAME_REPO } else { Join-Path $HOME 'workspace\game' }),
  [string]$Remote = 'origin',
  [string]$Ref = 'main',
  [string]$WorkerRoot = 'D:\YahahaGameWorker',
  [string]$WorkerId = $(if ($env:WORKER_ID) { $env:WORKER_ID } else { 'yahahagame-sandbox-0' }),
  [string]$ControlUrl = 'http://139.224.32.61'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $WorkerRoot) -and (Test-Path -LiteralPath 'D:\StoneWorker')) {
  $WorkerRoot = 'D:\StoneWorker'
  Write-Host "Using existing worker root $WorkerRoot"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required on the worker.' }
$repoPath = (Resolve-Path -LiteralPath $Repo -ErrorAction Stop).Path
$repoRoot = (& git -C $repoPath rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) { throw "Not a Git worktree: $Repo" }
$repoRoot = (Resolve-Path -LiteralPath $repoRoot).Path
if ($repoRoot -ne $repoPath) { throw "-Repo must point to the Git worktree root: $repoRoot" }
$currentBranch = (& git -C $repoPath symbolic-ref --quiet --short HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $Ref) { throw "Expected checked-out branch '$Ref', found '$currentBranch'." }
& git -C $repoPath remote get-url $Remote *> $null
if ($LASTEXITCODE -ne 0) { throw "Git remote not found: $Remote" }
& git -C $repoPath fetch --prune $Remote $Ref
if ($LASTEXITCODE -ne 0) { throw "Failed to fetch $Remote/$Ref." }
$status = @(& git -C $repoPath status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Git worktree status.' }
$ignored = @(& git -C $repoPath ls-files --others --ignored --exclude-standard -- worker skills)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect ignored worker files.' }
if ($status.Count -gt 0 -or $ignored.Count -gt 0) {
  if ($status.Count -gt 0) { $status | Write-Host }
  if ($ignored.Count -gt 0) { $ignored | Write-Host }
  throw 'The Git worktree has local or ignored changes. Commit or remove them before deployment.'
}
& git -C $repoPath merge --ff-only "$Remote/$Ref"
if ($LASTEXITCODE -ne 0) { throw "Cannot fast-forward $Ref from $Remote/$Ref." }
$sourceCommit = (& git -C $repoPath rev-parse HEAD).Trim()
$sourceCommitShort = (& git -C $repoPath rev-parse --short HEAD).Trim()
Write-Host "Deploying $Ref at $sourceCommitShort ($sourceCommit)"

$config = Join-Path $WorkerRoot 'config\worker.env.ps1'
if (Test-Path -LiteralPath $config) { . $config }

$journal = Join-Path $WorkerRoot 'journal\execution.json'
if (Test-Path -LiteralPath $journal) {
  $state = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
  if ($state.phase -eq 'RUNNING') { throw 'Worker journal still records RUNNING work. Verify the old tool process before deploying.' }
}

$running = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'worker[\\/]agent[\\/]agent\.mjs'
})
foreach ($process in $running) { & taskkill.exe /PID $process.ProcessId /T /F | Out-Null }
Start-Sleep -Seconds 3
$remaining = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'worker[\\/]agent[\\/]agent\.mjs'
})
if ($remaining.Count -gt 0) { throw 'Existing worker agent did not stop; deployment is aborted.' }
if (-not $env:WORKER_TOKEN) { throw 'WORKER_TOKEN is not set. Configure it in config\worker.env.ps1 or the service environment.' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$release = Join-Path $WorkerRoot "releases\$stamp"
New-Item -ItemType Directory -Force -Path $release | Out-Null

$sourceWorker = Join-Path $repoRoot 'worker'
if (-not (Test-Path -LiteralPath $sourceWorker)) { throw "Repository has no worker directory: $sourceWorker" }
Copy-Item -LiteralPath $sourceWorker -Destination $release -Recurse -Force
$sourceSkills = Join-Path $repoRoot 'skills'
if (Test-Path -LiteralPath $sourceSkills) { Copy-Item -LiteralPath $sourceSkills -Destination $release -Recurse -Force }
@(
  "repository=$((& git -C $repoRoot remote get-url $Remote).Trim())"
  "remote=$Remote"
  "ref=$Ref"
  "commit=$sourceCommit"
  "deployed_at=$([DateTime]::UtcNow.ToString('o'))"
  'worktree_status=clean'
) | Set-Content -LiteralPath (Join-Path $release 'deployment-metadata.txt') -Encoding UTF8

$sourceWorker = Join-Path $release 'worker'
$skillSource = Join-Path $release 'skills'
$agentTarget = Join-Path $WorkerRoot 'agent'
$deployTarget = Join-Path $WorkerRoot 'deploy'
if (Test-Path -LiteralPath $agentTarget) { Remove-Item -LiteralPath $agentTarget -Recurse -Force }
if (Test-Path -LiteralPath $deployTarget) { Remove-Item -LiteralPath $deployTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $agentTarget, $deployTarget | Out-Null
Copy-Item -Path (Join-Path $sourceWorker 'agent\*') -Destination $agentTarget -Recurse -Force
Copy-Item -Path (Join-Path $sourceWorker 'deploy\*') -Destination $deployTarget -Recurse -Force

$skillTarget = Join-Path $env:USERPROFILE '.codex\skills'
New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
if (Test-Path -LiteralPath $skillSource) {
  Copy-Item -Path (Join-Path $skillSource '*') -Destination $skillTarget -Recurse -Force
} else {
  Write-Warning 'Release bundle has no skills directory; preserving the worker skill installation.'
}

node --check (Join-Path $WorkerRoot 'agent\agent.mjs')
$env:CONTROL_URL = $ControlUrl
$env:WORKER_ID = $WorkerId
$env:YAHAHAGAME_WORKER_ROOT = $WorkerRoot
$start = Join-Path $WorkerRoot 'deploy\start-phase1.ps1'
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $start, '-ControlUrl', $ControlUrl, '-WorkerId', $WorkerId, '-WorkerToken', $env:WORKER_TOKEN, '-WorkerRoot', $WorkerRoot) -WorkingDirectory $WorkerRoot -WindowStyle Hidden
Write-Host "Worker $WorkerId deployment completed: $stamp"
