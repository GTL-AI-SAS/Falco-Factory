param([switch]$Force)

$ErrorActionPreference = 'Stop'
$studioRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executablePath = Join-Path $studioRoot 'Falco Studio.exe'
$sourcePath = Join-Path $PSScriptRoot 'studio-launcher.cs'
$iconPath = Join-Path $studioRoot 'ui\assets\falco-studio.ico'
if ((Test-Path -LiteralPath $executablePath -PathType Leaf) -and -not $Force -and
    (Get-Item -LiteralPath $executablePath).LastWriteTimeUtc -ge (Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc -and
    (Get-Item -LiteralPath $executablePath).LastWriteTimeUtc -ge (Get-Item -LiteralPath $iconPath).LastWriteTimeUtc) {
  Write-Output $executablePath
  return
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw 'Falco Studio icon not found.' }
$compilerPaths = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compilerPath) { throw 'The Windows .NET Framework C# compiler was not found. Open main.cmd directly.' }
$temporaryPath = Join-Path $studioRoot ('falco-launcher-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
  & $compilerPath /nologo /target:winexe /optimize+ /platform:anycpu "/out:$temporaryPath" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll $sourcePath
  if ($LASTEXITCODE -ne 0) { throw 'The Falco Studio launcher could not be built.' }
  Move-Item -LiteralPath $temporaryPath -Destination $executablePath -Force
} finally {
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
}
Write-Output $executablePath
