$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('worker-autostart-tests-' + [guid]::NewGuid().ToString('N'))
$checkout = Join-Path $testRoot 'checkout with spaces'
$runtime = Join-Path $checkout 'runtime'
$testTask = 'YahahaGame-Autostart-Test-' + [guid]::NewGuid().ToString('N')
$autostartTestState = @{ Processes = @(); Cases = 0 }
$savedToken = $env:WORKER_TOKEN
$lockProcess = $null

function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Get-CimInstance { param($ClassName, $Filter) return $autostartTestState.Processes }
function Write-Fixture($relative, $content) {
  $file = Join-Path $checkout $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
  [IO.File]::WriteAllText($file, $content)
}
function Status { Get-Content -LiteralPath (Join-Path $runtime 'logs/autostart-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
function Starts { if (Test-Path -LiteralPath (Join-Path $runtime 'starts.txt')) { @(Get-Content -LiteralPath (Join-Path $runtime 'starts.txt')).Count } else { 0 } }
function Run-Case([string]$Expected, [switch]$Fails) {
  $failure = $null
  try { & (Join-Path $source 'worker/deploy/autostart-worker.ps1') -RepoRoot $checkout -WorkerRoot $runtime }
  catch { $failure = $_ }
  Assert ([bool]$failure -eq [bool]$Fails) "Unexpected failure state for $Expected : $failure"
  Assert ((Status).state -eq $Expected) "Expected $Expected startup status."
  $autostartTestState.Cases++
}

try {
  Write-Fixture 'worker/deploy/deploy-worker.ps1' @'
param($RepoRoot, $WorkerRoot)
if (Test-Path -LiteralPath (Join-Path $WorkerRoot 'fail.txt')) { throw "Test deployment failed: $env:WORKER_TOKEN" }
Add-Content -LiteralPath (Join-Path $WorkerRoot 'starts.txt') -Value 'started'
'@
  Write-Fixture 'runtime/config/worker.env.ps1' '# Test configuration; no production credentials.'
  Write-Fixture 'runtime/config/autostart.paused' 'maintenance'
  Run-Case 'PAUSED'
  Assert ((Starts) -eq 0) 'Paused startup deployed a worker.'
  Remove-Item -LiteralPath (Join-Path $runtime 'config/autostart.paused')

  $agentPath = Join-Path $checkout 'worker/deploy/../agent/agent.mjs'
  $autostartTestState.Processes = @([pscustomobject]@{ ProcessId = 123; CommandLine = 'node.exe "' + $agentPath + '"' })
  Write-Fixture 'runtime/journal/execution.json' '{"phase":"RUNNING","sentinel":"keep"}'
  Run-Case 'RUNNING'
  Assert ((Starts) -eq 0 -and (Status).agentPids[0] -eq 123) 'Existing active worker was not preserved.'
  $autostartTestState.Processes += [pscustomobject]@{ ProcessId = 124; CommandLine = 'node.exe "' + $agentPath + '"' }
  Run-Case 'ERROR' -Fails
  $autostartTestState.Processes = @([pscustomobject]@{ ProcessId = 125; CommandLine = 'node.exe D:\unrelated\agent\agent.mjs' })
  Run-Case 'ERROR' -Fails
  $autostartTestState.Processes = @()
  foreach ($content in @('{"phase":"RUNNING","sentinel":"keep"}', '{"phase":"RESULT","sentinel":"keep"}', 'broken-json')) {
    Write-Fixture 'runtime/journal/execution.json' $content
    Run-Case 'BLOCKED' -Fails
    Assert ((Get-Content -LiteralPath (Join-Path $runtime 'journal/execution.json') -Raw) -eq $content) 'Journal was changed.'
  }
  Assert ((Starts) -eq 0) 'Blocked worker was deployed.'
  Remove-Item -LiteralPath (Join-Path $runtime 'journal/execution.json')
  $env:WORKER_TOKEN = 'startup-fixture-secret'
  Write-Fixture 'runtime/fail.txt' 'simulated network/deployment failure'
  Run-Case 'ERROR' -Fails
  Assert ((Status).detail -notmatch 'startup-fixture-secret') 'Credential appeared in startup status.'
  Remove-Item -LiteralPath (Join-Path $runtime 'fail.txt')
  Run-Case 'STARTED'
  Assert ((Starts) -eq 1) 'A later invocation did not recover after deployment failure.'

  # Exercise cross-process deployment exclusion before any Git/process mutation.
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($runtime.TrimEnd('\').ToUpperInvariant()))).Replace('-', '') }
  finally { $hash.Dispose() }
  Write-Fixture 'hold-lock.ps1' @'
param($Name, $Ready, $Release)
$mutex = New-Object Threading.Mutex($false, $Name)
try {
  if (-not $mutex.WaitOne(0)) { throw 'Cannot acquire fixture mutex.' }
  [IO.File]::WriteAllText($Ready, 'ready')
  $until = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $Release) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
'@
  $lockArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $checkout 'hold-lock.ps1')),
    '-Name', "Global\YahahaGame-Deploy-$key", '-Ready', ('"{0}"' -f (Join-Path $runtime 'lock-ready')), '-Release', ('"{0}"' -f (Join-Path $runtime 'lock-release')))
  $lockProcess = Start-Process powershell.exe -ArgumentList $lockArgs -WindowStyle Hidden -PassThru
  $until = (Get-Date).AddSeconds(10)
  while (-not (Test-Path -LiteralPath (Join-Path $runtime 'lock-ready')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
  Assert (Test-Path -LiteralPath (Join-Path $runtime 'lock-ready')) 'Mutex fixture did not become ready.'
  $failure = $null
  try { & (Join-Path $source 'worker/deploy/deploy-worker.ps1') -RepoRoot $checkout -WorkerRoot $runtime -CheckOnly }
  catch { $failure = $_.Exception.Message }
  Assert ($failure -match 'Another deployment owns') 'Concurrent deployment was not blocked.'
  Write-Fixture 'runtime/lock-release' 'release'
  Assert ($lockProcess.WaitForExit(10000)) 'Mutex fixture did not exit.'
  $autostartTestState.Cases++

  # Register a real, isolated scheduled task. Its harmless action proves quoted
  # paths, hidden launch and execution in this account's desktop session.
  Write-Fixture 'worker/deploy/autostart-worker.ps1' @'
param($RepoRoot, $WorkerRoot)
@{repository=$RepoRoot; root=$WorkerRoot; session=(Get-Process -Id $PID).SessionId; user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $WorkerRoot 'scheduled-receipt.json') -Encoding UTF8
'@
  $installer = Join-Path $source 'worker/deploy/register-worker-autostart.ps1'
  & $installer -RepoRoot $checkout -WorkerRoot $runtime -TaskName $testTask
  & $installer -RepoRoot $checkout -WorkerRoot $runtime -TaskName $testTask -CheckOnly
  Start-ScheduledTask -TaskName $testTask
  $until = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath (Join-Path $runtime 'scheduled-receipt.json')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 200 }
  $receipt = Get-Content -LiteralPath (Join-Path $runtime 'scheduled-receipt.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert ($receipt.repository -eq $checkout -and $receipt.root -eq $runtime) 'Scheduled arguments were not preserved.'
  Assert ($receipt.session -eq (Get-Process -Id $PID).SessionId -and $receipt.user -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Scheduled task used the wrong desktop/account.'
  Disable-ScheduledTask -TaskName $testTask | Out-Null
  $failure = $null
  try { & $installer -RepoRoot $checkout -WorkerRoot $runtime -TaskName $testTask -CheckOnly }
  catch { $failure = $_.Exception.Message }
  Assert ($failure -match 'disabled') 'Disabled autostart was not detected.'
  $autostartTestState.Cases++
  Write-Output "PASS: $($autostartTestState.Cases) autostart cases, including real scheduled execution and deployment mutex contention."
} finally {
  $env:WORKER_TOKEN = $savedToken
  if (Get-ScheduledTask -TaskName $testTask -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $testTask
    Unregister-ScheduledTask -TaskName $testTask -Confirm:$false
  }
  if ($lockProcess -and -not $lockProcess.HasExited) {
    Write-Fixture 'runtime/lock-release' 'release'
    [void]$lockProcess.WaitForExit(10000)
  }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'worker-autostart-tests-*') {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
