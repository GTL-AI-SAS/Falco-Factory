@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title GTL AI - Falco Factory Studio

echo.
echo  ==================================================
echo        GTL AI - FALCO FACTORY STUDIO v0.8
echo  ==================================================
echo.

if not exist "package.json" (
  echo [ERROR] Falta package.json.
  echo Extrae TODO el ZIP en una carpeta antes de abrir este archivo.
  goto :failed
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js 20 o superior desde https://nodejs.org
  echo Luego cierra y vuelve a abrir este archivo.
  goto :failed
)

node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Esta version requiere Node.js 20 o superior.
  node.exe --version
  echo Actualiza desde https://nodejs.org
  goto :failed
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro npm.cmd. Reinstala Node.js con npm.
  goto :failed
)

if not exist "node_modules\wrangler\bin\wrangler.js" (
  echo [1/2] Primera apertura: instalando las dependencias...
  echo       Esto solo es necesario una vez por carpeta.
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install fallo. Revisa tu conexion y el error anterior.
    goto :failed
  )
) else (
  echo [1/2] Dependencias ya instaladas.
)

echo [2/2] Iniciando Falco Factory Studio...
echo       El navegador se abrira automaticamente.
echo       Si no se abre: http://127.0.0.1:4317
echo.
echo  IMPORTANTE: deja esta ventana abierta mientras uses Studio.
echo  Para detenerlo, presiona Ctrl+C o cierra esta ventana.
echo.
call npm.cmd run falco:ui
if errorlevel 1 (
  echo.
  echo [ERROR] Falco Studio no pudo iniciarse.
  echo Si el puerto 4317 esta ocupado, cierra otra instancia de Studio.
  goto :failed
)
exit /b 0

:failed
echo.
echo No se completo el inicio. Revisa los mensajes anteriores.
pause
exit /b 1
