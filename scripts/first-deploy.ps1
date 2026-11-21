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
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }
  & npx.cmd wrangler whoami
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Cloudflare authentication required; opening official Wrangler login...'
    & npx.cmd wrangler login
    if ($LASTEXITCODE -ne 0) { throw 'Wrangler login failed' }
  }
  $args = @('run', 'falco:new', '--', '--name', $Name, '--business', $Business,
    '--provider', $Provider, '--origin', $Origin,
    '--faq', '.\examples\gallinas\faq.md', '--instructions', '.\examples\gallinas\instructions.md', '--deploy')
  if ($AccountId) { $args += @('--account-id', $AccountId) }
  & npm.cmd @args
  if ($LASTEXITCODE -ne 0) { throw 'Falco Factory reported incomplete deployment or verification. See output above.' }
} finally { Pop-Location }
