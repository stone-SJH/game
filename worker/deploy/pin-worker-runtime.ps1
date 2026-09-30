[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$WorkerRoot)
$ErrorActionPreference = 'Stop'
$WorkerRoot = [IO.Path]::GetFullPath($WorkerRoot)
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repo
try { $entry = & node --input-type=module -e "import {codexInvocation} from './worker/agent/production-harness.mjs'; console.log(codexInvocation([]).args[0] || '')" | Select-Object -Last 1 }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not $entry -or -not (Test-Path -LiteralPath $entry)) { throw 'Resolve the installed npm Codex entrypoint before pinning.' }
$package = Split-Path -Parent (Split-Path -Parent $entry)
$metadata = Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.name -ne '@openai/codex') { throw 'Unexpected CLI package.' }
$destination = Join-Path $WorkerRoot ('toolchains\codex-' + $metadata.version)
if (Test-Path -LiteralPath $destination) { throw 'A pinned runtime already exists; verify/reuse it explicitly instead of overwriting.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $destination /inheritance:r /grant:r ($account + ':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to protect runtime configuration.' }
Copy-Item -LiteralPath $package -Destination (Join-Path $destination 'codex') -Recurse
$privateHome = Join-Path $destination 'config'
New-Item -ItemType Directory -Path $privateHome | Out-Null
$originalHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
foreach ($name in @('config.toml','auth.json')) {
  $source = Join-Path $originalHome $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $privateHome $name) }
}
$command = Join-Path $destination 'codex\bin\codex.js'
& node $command --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned CLI cannot resolve its native binary.' }
$record = [ordered]@{ protocol = 1; command = $command; codexHome = $privateHome; cliVersion = $metadata.version; createdAt = (Get-Date).ToString('o') }
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $WorkerRoot 'config\runtime-invocation.json') -Encoding UTF8
Write-Host "Pinned worker CLI $($metadata.version). Configuration contents were not logged."
