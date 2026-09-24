[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$WorkerRoot,
  [string]$TaskName = 'YahahaGame-Worker-Autostart',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not $WorkerRoot) { $WorkerRoot = Join-Path $RepoRoot 'runtime' }
$WorkerRoot = [IO.Path]::GetFullPath($WorkerRoot)
$entry = Join-Path $RepoRoot 'worker\deploy\autostart-worker.ps1'
$executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -RepoRoot "{1}" -WorkerRoot "{2}"' -f $entry, $RepoRoot, $WorkerRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
function Resolve-AccountSid([string]$Account) {
  if ($Account -like 'S-1-*') { return $Account }
  return (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}
foreach ($file in @($entry, (Join-Path $PSScriptRoot 'deploy-worker.ps1'), (Join-Path $WorkerRoot 'config\worker.env.ps1'))) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing autostart dependency: $file" }
}

if (-not $CheckOnly) {
  $action = New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $RepoRoot
  # Unreal/playtest need the worker account's desktop and credentials. A boot
  # trigger alone cannot supply a desktop before that account signs in.
  $triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $userSid),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
  )
  $principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Start the committed YahahaGame worker in the worker desktop session; retry every minute without interrupting tasks or updating Git.' -Force | Out-Null
}

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
$taskSid = Resolve-AccountSid $task.Principal.UserId
if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $executable -or $task.Actions[0].Arguments -cne $arguments -or $task.Actions[0].WorkingDirectory -ne $RepoRoot) {
  throw 'Autostart action does not match this checkout and runtime. Re-register the task.'
}
if ($taskSid -ne $userSid -or [string]$task.Principal.LogonType -ne 'Interactive' -or [string]$task.Principal.RunLevel -ne 'Highest') { throw 'Autostart must use the current worker account with its interactive desktop.' }
$enabled = @($task.Triggers | Where-Object { $_.Enabled })
if (-not @($enabled | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -or
    -not @($enabled | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.UserId -and (Resolve-AccountSid $_.UserId) -eq $userSid }).Count -or
    -not @($enabled | Where-Object { $_.Repetition.Interval -eq 'PT1M' -and -not $_.Repetition.Duration -and -not $_.EndBoundary }).Count) {
  throw 'Autostart needs enabled boot, worker logon and indefinite one-minute retry triggers.'
}
if (-not $task.Settings.Enabled -or -not $task.Settings.StartWhenAvailable -or
    [string]$task.Settings.MultipleInstances -ne 'IgnoreNew' -or $task.Settings.ExecutionTimeLimit -ne 'PT0S' -or
    $task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) { throw 'Autostart task settings are incomplete or disabled.' }
if ($CheckOnly -and (Test-Path -LiteralPath (Join-Path $WorkerRoot 'config\autostart.paused'))) { throw 'Autostart is paused for maintenance.' }
$info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\'
if ($CheckOnly -and $info.LastTaskResult -notin @(0, 267009, 267011)) { throw "Last autostart invocation failed ($($info.LastTaskResult)). Inspect runtime/logs/autostart-status.json." }
Write-Output "PASS: $TaskName; account $($identity.Name); boot/logon triggers and one-minute retry; repository $RepoRoot; runtime $WorkerRoot."
Write-Output 'A logged-in worker desktop is required. Git updates are not automatic.'
