@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Website + Falco - Demo local

echo.
echo  WEB DEL CLIENTE + FALCO - ABRIR POR HTTP
echo  URL: http://localhost:3000/
echo.
if not exist "index.html" (
  echo [ERROR] Este CMD debe estar junto al index.html de la WEB FINAL.
  echo Si tu pagina usa React o Vite, el agente debe adaptar este lanzador al servidor del proyecto.
  goto :failed
)
if not exist "tools\falco-static-server.mjs" (
  echo [ERROR] Falta tools\falco-static-server.mjs
  echo Copia la carpeta integration\tools del kit a tools\ de la web.
  goto :failed
)
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Instala Node.js 20+ desde https://nodejs.org
  goto :failed
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Se requiere Node.js 20 o superior.
  goto :failed
)
set "PORT=3000"
echo  No uses file://. La URL real de prueba sera http://localhost:3000/
echo  El Worker debe autorizar ese origen exacto en ALLOWED_ORIGINS.
echo  Deja esta ventana abierta. Ctrl+C para detener.
echo.
start "" /B powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1400; Start-Process 'http://localhost:3000/'" >nul 2>&1
node.exe ".\tools\falco-static-server.mjs"
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo  No se pudo iniciar la web con Falco.
pause
exit /b 1
