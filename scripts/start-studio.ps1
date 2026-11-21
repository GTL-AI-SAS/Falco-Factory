param(
  [int]$Port = 4317,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Test-Path '.\package.json')) { throw 'Falco Factory package.json not found.' }
if (-not (Test-Path '.\node_modules\wrangler\bin\wrangler.js')) {
  Write-Host 'Wrangler is not installed. Running npm.cmd install...'
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$args = @('run', 'falco:ui', '--', '--port', "$Port")
if ($NoOpen) { $args += '--no-open' }
& npm.cmd @args
exit $LASTEXITCODE
