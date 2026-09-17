[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Bundle,
  [string]$WorkerRoot = 'D:\YahahaGameWorker',
  [string]$WorkerId = $(if ($env:WORKER_ID) { $env:WORKER_ID } else { 'yahahagame-sandbox-0' }),
  [string]$ControlUrl = 'http://139.224.32.61'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Bundle)) { throw "Bundle not found: $Bundle" }
if (-not (Test-Path -LiteralPath $WorkerRoot) -and (Test-Path -LiteralPath 'D:\StoneWorker')) {
  $WorkerRoot = 'D:\StoneWorker'
  Write-Host "Using existing worker root $WorkerRoot"
}

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
tar -xzf $Bundle -C $release

$sourceWorker = Join-Path $release 'worker'
New-Item -ItemType Directory -Force -Path (Join-Path $WorkerRoot 'agent') | Out-Null
Copy-Item -Path (Join-Path $sourceWorker 'agent\*') -Destination (Join-Path $WorkerRoot 'agent') -Recurse -Force
Copy-Item -Path (Join-Path $sourceWorker 'deploy\*') -Destination (Join-Path $WorkerRoot 'deploy') -Recurse -Force

$skillTarget = Join-Path $env:USERPROFILE '.codex\skills'
$skillSource = Join-Path $release 'skills'
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
