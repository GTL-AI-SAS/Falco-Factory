param([switch]$SetConsoleIcon)

$ErrorActionPreference = 'Stop'
$studioRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherPath = Join-Path $studioRoot 'ABRIR_FALCO_STUDIO.cmd'
$iconPath = Join-Path $studioRoot 'ui\assets\falco-studio.ico'
$shortcutPath = Join-Path $studioRoot 'ABRIR_FALCO_STUDIO.lnk'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw 'Falco Studio launcher not found.' }
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw 'Falco Studio icon not found.' }

# A CMD file has no individual Explorer icon. This shortcut opens the original
# launcher and is refreshed when it runs, so moving the Factory folder is safe.
$shortcutShell = New-Object -ComObject WScript.Shell
try {
  $studioShortcut = $shortcutShell.CreateShortcut($shortcutPath)
  try {
    $studioShortcut.TargetPath = $launcherPath
    $studioShortcut.WorkingDirectory = $studioRoot
    $studioShortcut.IconLocation = "$iconPath,0"
    $studioShortcut.Description = 'FALCO Factory Studio - GTL AI'
    $studioShortcut.WindowStyle = 1
    $studioShortcut.Save()
  } finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($studioShortcut) }
} finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcutShell) }

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
Write-Output $shortcutPath
