[CmdletBinding()]
param([string]$RepoRoot, [string]$WorkerRoot)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not $WorkerRoot) { $WorkerRoot = Join-Path $RepoRoot 'runtime' }
$WorkerRoot = [IO.Path]::GetFullPath($WorkerRoot)
$logDirectory = Join-Path $WorkerRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Write-StartupStatus([string]$State, [string]$Detail, [int[]]$AgentPids = @()) {
  $record = [ordered]@{ checkedAt = (Get-Date).ToString('o'); state = $State; detail = $Detail;
    repository = $RepoRoot; workerRoot = $WorkerRoot; agentPids = @($AgentPids) }
  $destination = Join-Path $logDirectory 'autostart-status.json'
  $temporary = "$destination.$PID.tmp"
  $record | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $destination -Force
  Write-Output "$State`: $Detail"
}

$failureState = 'ERROR'
try {
  # A persistent maintenance marker prevents the scheduled retry from undoing an
  # operator's intentional stop. Never remove it automatically.
  if (Test-Path -LiteralPath (Join-Path $WorkerRoot 'config\autostart.paused')) {
    Write-StartupStatus 'PAUSED' 'Autostart is paused for maintenance.'
    return
  }
  $agents = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match '(?i)[\\/]agent[\\/]agent\.mjs(?:"|\s|$)'
  })
  if ($agents.Count) {
    $expected = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'worker\agent\agent.mjs'))
    $ours = @($agents | Where-Object {
      $match = [regex]::Match($_.CommandLine, '(?:"([^"\r\n]*[\\/]agent[\\/]agent\.mjs)"|(\S*[\\/]agent[\\/]agent\.mjs))(?=\s|$)', 'IgnoreCase')
      $file = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
      $match.Success -and [IO.Path]::IsPathRooted($file) -and [IO.Path]::GetFullPath($file) -eq $expected
    })
    if ($agents.Count -ne 1 -or $ours.Count -ne 1) { throw 'Unexpected or multiple worker agents; inspect processes before deployment.' }
    Write-StartupStatus 'RUNNING' 'The existing worker was left running.' @($ours.ProcessId)
    return
  }
  if (Test-Path -LiteralPath (Join-Path $WorkerRoot 'journal\execution.json')) {
    $failureState = 'BLOCKED'
    throw 'Execution journal retained. Inspect interrupted work or pending results before restarting.'
  }
  # Start the checked-in revision through the normal preflight/registration path.
  # Remote updates remain an explicit, verified deployment between jobs.
  & (Join-Path $RepoRoot 'worker\deploy\deploy-worker.ps1') -RepoRoot $RepoRoot -WorkerRoot $WorkerRoot
  Write-StartupStatus 'STARTED' 'Worker registration confirmed by the Git deployment script.'
} catch {
  $detail = $_.Exception.Message
  foreach ($secret in @($env:WORKER_TOKEN, $env:TRIPO_API_KEY)) {
    if ($secret) { $detail = $detail.Replace($secret, '[redacted]') }
  }
  Write-StartupStatus $failureState $detail
  throw 'Worker autostart failed. Inspect runtime/logs/autostart-status.json and the deployment logs.'
}
