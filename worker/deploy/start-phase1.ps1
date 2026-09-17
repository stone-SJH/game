param(
  [string]$ControlUrl = $(if ($env:CONTROL_URL) { $env:CONTROL_URL } else { 'http://139.224.32.61' }),
  [string]$WorkerId = $(if ($env:WORKER_ID) { $env:WORKER_ID } else { 'yahahagame-sandbox-0' }),
  [string]$WorkerToken = $env:WORKER_TOKEN,
  [string]$WorkerRoot = $(if ($env:YAHAHAGAME_WORKER_ROOT) { $env:YAHAHAGAME_WORKER_ROOT } else { 'D:\YahahaGameWorker' })
)

$ErrorActionPreference = 'Stop'

$config = Join-Path $WorkerRoot 'config\worker.env.ps1'
if (Test-Path -LiteralPath $config) {
  . $config
  if (-not $PSBoundParameters.ContainsKey('ControlUrl') -and $env:CONTROL_URL) { $ControlUrl = $env:CONTROL_URL }
  if (-not $PSBoundParameters.ContainsKey('WorkerId') -and $env:WORKER_ID) { $WorkerId = $env:WORKER_ID }
  if (-not $PSBoundParameters.ContainsKey('WorkerToken') -and $env:WORKER_TOKEN) { $WorkerToken = $env:WORKER_TOKEN }
  if (-not $PSBoundParameters.ContainsKey('WorkerRoot') -and $env:YAHAHAGAME_WORKER_ROOT) { $WorkerRoot = $env:YAHAHAGAME_WORKER_ROOT }
}
if ([string]::IsNullOrWhiteSpace($WorkerToken)) { throw 'Set WORKER_TOKEN before starting the worker.' }

$env:CONTROL_URL = $ControlUrl
$env:WORKER_ID = $WorkerId
$env:WORKER_TOKEN = $WorkerToken
$env:YAHAHAGAME_WORKER_ROOT = $WorkerRoot
if (-not $env:BLENDER_EXE) { $env:BLENDER_EXE = 'D:\Tools\Blender\blender-5.2.1-windows-x64\blender.exe' }
if (-not $env:UNREAL_CMD) { $env:UNREAL_CMD = 'D:\UE\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe' }
$env:SESSION_ID = [string](Get-Process -Id $PID).SessionId

node (Join-Path $PSScriptRoot '..\agent\agent.mjs')
exit $LASTEXITCODE
