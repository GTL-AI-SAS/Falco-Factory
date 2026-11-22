param([switch]$SetConsoleIcon)

$ErrorActionPreference = 'Stop'
$studioRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherPath = Join-Path $studioRoot 'main.cmd'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { $launcherPath = Join-Path $studioRoot 'ABRIR_FALCO_STUDIO.cmd' }
$iconPath = Join-Path $studioRoot 'ui\assets\falco-studio.ico'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw 'Falco Studio launcher not found.' }
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw 'Falco Studio icon not found.' }

# Retain the existing CMD hook, but create a real executable with an embedded
# icon instead of an Explorer shortcut. No system overlay settings are changed.
& (Join-Path $PSScriptRoot 'build-studio-launcher.ps1') | Out-Null

if ($SetConsoleIcon) {
  # SetConsoleIcon affects this launcher's classic console window only. Windows
  # Terminal may manage its own tab icon; no file associations are modified.
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FalcoStudio {
  public static class ConsoleBrand {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleIcon(IntPtr icon);
  }
}
'@
    $studioIcon = New-Object System.Drawing.Icon($iconPath, 32, 32)
    try { [void][FalcoStudio.ConsoleBrand]::SetConsoleIcon($studioIcon.Handle) }
    finally { $studioIcon.Dispose() }
  } catch { Write-Verbose 'This console host manages its own icon.' }
}
Write-Output (Join-Path $studioRoot 'Falco Studio.exe')
