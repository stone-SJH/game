$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('worker-deploy-tests-' + [guid]::NewGuid().ToString('N'))
$remote = Join-Path $testRoot 'remote.git'
$checkout = Join-Path $testRoot 'checkout with spaces'
$publisher = Join-Path $testRoot 'publisher'
$runtime = Join-Path $checkout 'runtime'
$deploymentTestState = @{ Started = 0; Running = @() }
$savedEnv = @{}
foreach ($key in @('CONTROL_URL', 'WORKER_ID', 'WORKER_TOKEN', 'YAHAHAGAME_WORKER_ROOT')) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key) }

function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Git([string]$directory, [string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  $result = & git.exe -C $directory @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Fixture Git failure: $result" }
  return $result
}
function Write-Fixture($relative, $content) {
  $file = Join-Path $checkout $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
  [IO.File]::WriteAllText($file, $content)
}
function Get-CimInstance { param($ClassName, $Filter) return $deploymentTestState.Running }
function Start-Sleep { param($Seconds) }
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  Assert ($WindowStyle -eq 'Hidden') 'Launcher must be hidden.'
  Assert (-not ($ArgumentList -join ' ').Contains($env:WORKER_TOKEN)) 'Token leaked onto command line.'
  Assert ($WorkingDirectory -eq $checkout) 'Worker must run from the checkout.'
  Assert (($ArgumentList -join ' ').Contains(('"{0}"' -f $runtime))) 'Runtime with spaces was not quoted.'
  [IO.File]::WriteAllText($RedirectStandardOutput, "worker $($env:WORKER_ID) registered (protocol 2)")
  [IO.File]::WriteAllText($RedirectStandardError, '')
  $deploymentTestState.Started++
  $fakeProcess = [pscustomobject]@{ Id = 12345; HasExited = $false }
  $fakeProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
  return $fakeProcess
}
function Expect-Failure([scriptblock]$action, [string]$pattern) {
  $before = $deploymentTestState.Started
  $failure = $null
  try { & $action } catch { $failure = $_.Exception.Message }
  Assert ($failure -match $pattern) "Expected failure '$pattern', got '$failure'."
  Assert ($deploymentTestState.Started -eq $before) 'A rejected deployment started a worker.'
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  Git $testRoot @('init', '--bare', '--initial-branch=main', $remote) | Out-Null
  Git $testRoot @('clone', $remote, $checkout) | Out-Null
  Git $checkout @('config', 'user.name', 'Deployment Test') | Out-Null
  Git $checkout @('config', 'user.email', 'deployment-test@localhost') | Out-Null
  Copy-Item -LiteralPath (Join-Path $source 'worker') -Destination $checkout -Recurse
  Copy-Item -LiteralPath (Join-Path $source 'skills') -Destination $checkout -Recurse
  Write-Fixture '.gitignore' "/runtime/`n*.log`n"
  Write-Fixture 'upstream.txt' 'base'
  Git $checkout @('add', '.') | Out-Null
  Git $checkout @('commit', '-m', 'Fixture base') | Out-Null
  Git $checkout @('push', '-u', 'origin', 'main') | Out-Null
  Git $testRoot @('clone', $remote, $publisher) | Out-Null
  Git $publisher @('config', 'user.name', 'Deployment Test') | Out-Null
  Git $publisher @('config', 'user.email', 'deployment-test@localhost') | Out-Null
  Git $checkout @('switch', '-c', 'deploy/test', '--track', 'origin/main') | Out-Null
  Write-Fixture 'runtime/config/worker.env.ps1' ('$env:CONTROL_URL = ''http://127.0.0.1:1''; $env:WORKER_ID = ''test-worker''; $env:WORKER_TOKEN = ''fixture-secret''; $env:YAHAHAGAME_WORKER_ROOT = ''' + $runtime.Replace("'", "''") + "'")
  $deploy = Join-Path $checkout 'worker/deploy/deploy-worker.ps1'

  & $deploy -RepoRoot $checkout -CheckOnly
  Assert ($deploymentTestState.Started -eq 0) 'CheckOnly started a process.'
  Write-Fixture 'worker/ignored.log' 'ignored source payload'
  Expect-Failure { & $deploy -RepoRoot $checkout } 'Ignored files exist'
  Remove-Item -LiteralPath (Join-Path $checkout 'worker/ignored.log')
  Write-Fixture 'local-fix.txt' 'local change'
  Expect-Failure { & $deploy -RepoRoot $checkout -Update } 'Commit or explicitly stash'
  # Exercise Windows PowerShell -File default parameter evaluation in a real process.
  $savedPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $external = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deploy -CheckOnly 2>&1
    $externalExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedPreference }
  Assert ($externalExit -ne 0 -and ($external -join "`n") -match 'Commit or explicitly stash') 'The -File entrypoint did not resolve its default repository before checking the dirty tree.'
  Git $checkout @('add', 'local-fix.txt') | Out-Null
  Git $checkout @('commit', '-m', 'Local deployment fix') | Out-Null
  $localCommit = Git $checkout @('rev-parse', 'HEAD')

  Write-Fixture 'runtime/journal/execution.json' '{"phase":"RUNNING"}'
  Expect-Failure { & $deploy -RepoRoot $checkout } 'journal is RUNNING'
  Write-Fixture 'runtime/journal/execution.json' '{"phase":"RESULT"}'
  Expect-Failure { & $deploy -RepoRoot $checkout } 'journal is RESULT'
  Remove-Item -LiteralPath (Join-Path $runtime 'journal/execution.json')
  $deploymentTestState.Running = @([pscustomobject]@{ ProcessId = 99; CommandLine = 'node.exe D:\StoneWorker\deploy\..\agent\agent.mjs' })
  Expect-Failure { & $deploy -RepoRoot $checkout } 'still running'
  $deploymentTestState.Running = @()

  [IO.File]::WriteAllText((Join-Path $publisher 'upstream.txt'), 'remote update')
  Git $publisher @('commit', '-am', 'Remote update') | Out-Null
  Git $publisher @('push', 'origin', 'main') | Out-Null
  & $deploy -RepoRoot $checkout -Update -CheckOnly
  Assert ((Git $checkout @('rev-parse', 'HEAD')) -eq $localCommit) 'CheckOnly merged changes.'
  & $deploy -RepoRoot $checkout -Update
  Assert ($deploymentTestState.Started -eq 1) 'Updated deployment did not launch once.'
  Git $checkout @('merge-base', '--is-ancestor', $localCommit, 'HEAD') | Out-Null
  Assert ((Get-Content -Raw (Join-Path $checkout 'local-fix.txt')) -eq 'local change') 'Local fix was lost.'
  Assert ((Get-Content -Raw (Join-Path $checkout 'upstream.txt')) -eq 'remote update') 'Remote update was lost.'
  $record = Get-Content -Raw (Join-Path $runtime 'deployment.json') | ConvertFrom-Json
  Assert ($record.commit -eq (Git $checkout @('rev-parse', 'HEAD'))) 'Recorded commit differs from deployed commit.'
  Assert ($record.remote -eq $remote) 'Git remote was not recorded.'

  Write-Fixture 'upstream.txt' 'local conflicting change'
  Git $checkout @('commit', '-am', 'Local conflict') | Out-Null
  [IO.File]::WriteAllText((Join-Path $publisher 'upstream.txt'), 'remote conflicting change')
  Git $publisher @('commit', '-am', 'Remote conflict') | Out-Null
  Git $publisher @('push', 'origin', 'main') | Out-Null
  Expect-Failure { & $deploy -RepoRoot $checkout -Update } 'Git failed'
  Assert (@(Git $checkout @('diff', '--name-only', '--diff-filter=U')).Count -eq 1) 'Conflict was not preserved for resolution.'
  Write-Host 'PASS: preflight, dirty tree, RUNNING/RESULT journals, active worker, local commits, remote merge, conflict preservation, quoted paths, credential handling and deployment record.'
} finally {
  foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key]) }
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'worker-deploy-tests-*') {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
