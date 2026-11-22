# Run this script from any working directory: .\scripts\first-deploy.ps1
# Requires Node.js and npm installed. No API keys are accepted in script parameters.
param(
  [string]$Name = 'falco-gallinas',
  [string]$Business = 'Gallinas y Valientes',
  [ValidateSet('mock', 'openai', 'gemini')][string]$Provider = 'mock',
  [string]$Origin = 'http://localhost:3000',
  [string]$AccountId = ''
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $root
try {
  Write-Host 'FALCO FACTORY - Windows First Deployment'
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }
  & npm.cmd run falco:auth:secure
  if ($LASTEXITCODE -ne 0) { throw 'Secure Wrangler authentication failed' }
  $args = @('run', 'falco:new', '--', '--name', $Name, '--business', $Business,
    '--provider', $Provider, '--origin', $Origin,
    '--faq', '.\examples\gallinas\faq.md', '--instructions', '.\examples\gallinas\instructions.md', '--deploy')
  if ($AccountId) { $args += @('--account-id', $AccountId) }
  & npm.cmd @args
  if ($LASTEXITCODE -ne 0) { throw 'Falco Factory reported incomplete deployment or verification. See output above.' }
} finally { Pop-Location }
