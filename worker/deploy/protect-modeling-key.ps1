param([Parameter(Mandatory = $true)][string]$RepoRoot)
$ErrorActionPreference = 'Stop'
$tracked = @(& git.exe -C $RepoRoot ls-files -- ':(top,icase)tripo.txt')
if ($LASTEXITCODE -ne 0) { throw 'Cannot check Tripo key Git tracking.' }
if ($tracked.Count) { throw 'tripo.txt is tracked or staged. Remove it from the Git index before starting or deploying the worker.' }
$exclude = & git.exe -C $RepoRoot rev-parse --git-path info/exclude
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve local Git excludes.' }
if (-not [IO.Path]::IsPathRooted($exclude)) { $exclude = Join-Path $RepoRoot $exclude }
$content = if (Test-Path -LiteralPath $exclude) { [IO.File]::ReadAllText($exclude) } else { '' }
if (($content -split '\r?\n') -notcontains '/tripo.txt') {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $exclude)) | Out-Null
  [IO.File]::AppendAllText($exclude, "`n/tripo.txt`n", (New-Object Text.UTF8Encoding($false)))
}
