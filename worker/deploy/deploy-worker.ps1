[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$WorkerRoot,
  [switch]$Update,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not $WorkerRoot) { $WorkerRoot = Join-Path $RepoRoot 'runtime' }
$WorkerRoot = [IO.Path]::GetFullPath($WorkerRoot)

function Invoke-Git([string[]]$GitArgs) {
  $output = & git.exe -C $RepoRoot @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "Git failed: git $($GitArgs -join ' ')" }
  return $output
}

function Assert-NoExecution {
  $journal = Join-Path $WorkerRoot 'journal\execution.json'
  if (Test-Path -LiteralPath $journal) {
    $state = Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json
    throw "Worker journal is $($state.phase): $journal. Finish execution/result delivery before deployment."
  }
}

function Get-WorkerProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match '(?i)[\\/]agent[\\/]agent\.mjs(?:"|\s|$)'
  })
}

$gitRoot = [IO.Path]::GetFullPath((Invoke-Git @('rev-parse', '--show-toplevel')))
if ($gitRoot.TrimEnd('\') -ne $RepoRoot.TrimEnd('\')) { throw 'RepoRoot must be the Git repository root.' }
$branch = Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD')
$revision = Invoke-Git @('rev-parse', 'HEAD')
$dirty = @(Invoke-Git @('status', '--porcelain', '--untracked-files=all'))
if ($dirty.Count) { throw 'Commit or explicitly stash local changes before deployment. Nothing was overwritten. Run git status --short and git diff.' }
$ignored = @(Invoke-Git @('ls-files', '--others', '--ignored', '--exclude-standard', '--', 'worker', 'skills'))
if ($ignored.Count) { throw 'Ignored files exist under worker/ or skills/. Move runtime files outside source and commit intentional source changes before deployment.' }
$remoteUrl = Invoke-Git @('remote', 'get-url', 'origin')

# Fetch is safe while the old worker runs; changing its source tree is not.
if ($Update) {
  Invoke-Git @('fetch', '--prune', 'origin') | Out-Host
  $upstream = Invoke-Git @('rev-parse', '--abbrev-ref', '@{upstream}')
  Write-Host "Update target: $upstream"
}

$config = Join-Path $WorkerRoot 'config\worker.env.ps1'
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Configure $config using worker/deploy/worker.env.ps1.example first." }
. $config
if (-not $env:WORKER_TOKEN -or -not $env:WORKER_ID -or -not $env:CONTROL_URL) { throw 'Configuration requires WORKER_TOKEN, WORKER_ID and CONTROL_URL.' }
if ($env:YAHAHAGAME_WORKER_ROOT -and [IO.Path]::GetFullPath($env:YAHAHAGAME_WORKER_ROOT) -ne $WorkerRoot) {
  throw 'Configured YAHAHAGAME_WORKER_ROOT does not match WorkerRoot.'
}
Assert-NoExecution
$running = @(Get-WorkerProcesses)
if ($running.Count) {
  throw "A worker agent is still running (PID $($running.ProcessId -join ', ')). Stop it between jobs before deploying; do not discard its journal."
}

& node -e 'if (parseInt(process.versions.node) < 20) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 20 or newer is required.' }
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'worker\agent') -Filter '*.mjs') {
  & node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $($file.Name)" }
}
$start = Join-Path $RepoRoot 'worker\deploy\start-phase1.ps1'
$tokens = $null; $parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($start, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Launcher parse failed: $parseErrors" }
$skill = Join-Path $RepoRoot 'skills\yahahagame-production\SKILL.md'
if (-not (Test-Path -LiteralPath $skill -PathType Leaf)) { throw "Missing production skill: $skill" }

if ($CheckOnly) {
  Write-Host "Preflight passed: $branch $revision; runtime $WorkerRoot. No merge or worker start performed."
  return
}
if ($Update) {
  # Merge retains local deployment commits. Conflicts remain visible for the operator.
  Invoke-Git @('merge', '--no-edit', $upstream) | Out-Host
  if ((Invoke-Git @('rev-parse', 'HEAD')) -ne $revision) {
    & (Join-Path $RepoRoot 'worker\deploy\deploy-worker.ps1') -RepoRoot $RepoRoot -WorkerRoot $WorkerRoot
    return
  }
}

Assert-NoExecution
if (@(Get-WorkerProcesses).Count) { throw 'Another worker started during preflight.' }
$logDir = Join-Path $WorkerRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout = Join-Path $logDir "worker-$stamp.log"
$stderr = Join-Path $logDir "worker-$stamp-error.log"
# Only the root goes on the command line; the launcher loads credentials from disk.
$process = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $start), '-WorkerRoot', ('"{0}"' -f $WorkerRoot)) -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$registered = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  $process.Refresh()
  if ($process.HasExited) { throw "Worker exited ($($process.ExitCode)). Inspect $stderr" }
  if ((Test-Path -LiteralPath $stdout) -and (Select-String -LiteralPath $stdout -SimpleMatch "worker $($env:WORKER_ID) registered (protocol 2)" -Quiet)) {
    $registered = $true
    break
  }
}
if (-not $registered) { throw "Worker registration was not confirmed. Inspect $stdout and $stderr before retrying (launcher PID $($process.Id))." }
$record = [ordered]@{ deployedAt = (Get-Date).ToString('o'); repository = $RepoRoot; remote = $remoteUrl; branch = $branch; commit = $revision; workerRoot = $WorkerRoot; workerId = $env:WORKER_ID; launcherPid = $process.Id; stdout = $stdout; stderr = $stderr }
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $WorkerRoot 'deployment.json') -Encoding UTF8
Write-Host "Worker $($env:WORKER_ID) registered from Git commit $revision. Logs: $stdout"
