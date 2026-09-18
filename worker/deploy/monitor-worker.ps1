[CmdletBinding()]
param(
  [string]$WorkerRoot,
  [ValidateRange(1, 3600)][int]$IntervalSeconds = 2,
  [switch]$Once,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $WorkerRoot) {
  $WorkerRoot = Join-Path $repoRoot 'runtime'
}
$WorkerRoot = [IO.Path]::GetFullPath($WorkerRoot)
$config = Join-Path $WorkerRoot 'config\worker.env.ps1'
$keys = @('CONTROL_URL', 'WORKER_ID', 'WORKER_TOKEN', 'YAHAHAGAME_WORKER_ROOT')
$previous = @{}
foreach ($key in $keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
  if (Test-Path -LiteralPath $config -PathType Leaf) { . $config }
  $monitorArgs = @((Join-Path $repoRoot 'worker\tools\worker-monitor.mjs'), '--root', $WorkerRoot, '--interval', [string]$IntervalSeconds)
  if ($Once) { $monitorArgs += '--once' }
  if ($Json) { $monitorArgs += '--json' }
  & node @monitorArgs
  if ($LASTEXITCODE -ne 0) { throw "Worker monitor exited with code $LASTEXITCODE." }
} finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
}
