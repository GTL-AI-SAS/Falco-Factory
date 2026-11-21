@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Falco - Demo local HTTP

echo.
echo  Falco Frontend Kit - Abrir demo (http://localhost:3000/)
echo  IMPORTANTE: NO abras demo\index.html con doble clic.
echo.
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Necesitas Node.js 20 o superior en PATH.
  echo Instala Node.js en https://nodejs.org
  goto :failed
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Se requiere Node.js 20 o superior.
  goto :failed
)
if not exist "demo\server.mjs" (
  echo [ERROR] No se encuentra demo\server.mjs. Extrae todo el ZIP.
  goto :failed
)
set "PORT=3000"
echo  El sitio se abrira en http://localhost:3000/
echo  Deja esta ventana abierta. Ctrl+C para detener.
echo.
start "" /B powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1400; Start-Process 'http://localhost:3000/'" >nul 2>&1
node.exe ".\demo\server.mjs"
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo  No se pudo abrir la demo. Revisa el error anterior.
pause
exit /b 1
