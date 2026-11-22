param(
  [int]$Port = 4317,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Test-Path '.\package.json')) { throw 'Falco Factory package.json not found.' }
$nodeVersion = [version](node.exe -p 'process.versions.node')
if ($nodeVersion -lt [version]'22.12.0') { throw 'Falco Factory v1.6.1 requires Node.js 22.12.0 or newer.' }
$needsInstall = -not (Test-Path '.\node_modules\wrangler\bin\wrangler.js') -or -not (Test-Path '.\package-lock.json')
if (-not $needsInstall) {
  node.exe -e "try { const p=require('./package.json'), w=require('./node_modules/wrangler/package.json'), l=require('./package-lock.json'); process.exit(w.version===p.devDependencies.wrangler && l.packages[''].devDependencies.wrangler===p.devDependencies.wrangler ? 0 : 1) } catch { process.exit(1) }"
  $needsInstall = $LASTEXITCODE -ne 0
}
if ($needsInstall) {
  Write-Host 'Installing the pinned Factory dependencies with npm.cmd install...'
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$args = @('run', 'falco:ui', '--', '--port', "$Port")
if ($NoOpen) { $args += '--no-open' }
& npm.cmd @args
exit $LASTEXITCODE
