@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title GTL AI - Falco Factory Studio
if exist "%~dp0scripts\update-studio-shortcut.ps1" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-studio-shortcut.ps1" -SetConsoleIcon >nul 2>&1

echo.
echo  ==================================================
echo        GTL AI - FALCO FACTORY STUDIO v1.8.0
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
  echo Instala Node.js 22.12.0 o superior desde https://nodejs.org
  echo Luego cierra y vuelve a abrir este archivo.
  goto :failed
)

node.exe -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22 || (a===22 && b>=12) ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Esta version requiere Node.js 22.12.0 o superior.
  node.exe --version
  echo Actualiza desde https://nodejs.org
  goto :failed
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro npm.cmd. Reinstala Node.js con npm.
  goto :failed
)

node.exe -e "try {const p=require('./package.json'), w=require('./node_modules/wrangler/package.json'), l=require('./package-lock.json'); process.exit(w.version===p.devDependencies.wrangler && l.packages[''].devDependencies.wrangler===p.devDependencies.wrangler ? 0 : 1)} catch {process.exit(1)}"
if errorlevel 1 (
  echo [1/2] Primera apertura: instalando las dependencias...
  echo       Esto solo es necesario una vez por carpeta.
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install fallo. Revisa tu conexion y el error anterior.
    goto :failed
  )
  node.exe -e "try {const p=require('./package.json'), w=require('./node_modules/wrangler/package.json'), l=require('./package-lock.json'); process.exit(w.version===p.devDependencies.wrangler && l.packages[''].devDependencies.wrangler===p.devDependencies.wrangler ? 0 : 1)} catch {process.exit(1)}"
  if errorlevel 1 (
    echo [ERROR] La instalacion no coincide con la version requerida de Wrangler.
    echo Cierra Studio, elimina node_modules y package-lock.json, y vuelve a abrir este archivo.
    goto :failed
  )
) else (
  echo [1/2] Dependencias ya instaladas.
)

if /i "%~1"=="--check" (
  call npm.cmd run falco:doctor
  if errorlevel 1 exit /b 1
  exit /b 0
)

echo [2/2] Iniciando Falco Factory Studio...
echo       El navegador se abrira automaticamente.
echo       Administra conexiones Cloudflare desde Studio.
echo       Si no se abre: http://127.0.0.1:4317
echo.
echo  Studio se detendra al cerrar su ultima pestana.
echo  Si hay un despliegue en curso, esperara a que termine.
echo.
call npm.cmd run falco:ui -- %*
if errorlevel 1 (
  echo.
  echo [ERROR] Falco Studio no pudo iniciarse.
  echo Si el puerto 4317 esta ocupado, cierra otra instancia de Studio.
  goto :failed
)
exit /b 0

:failed
if "%FALCO_STUDIO_BACKGROUND%"=="1" exit /b 1
if /i "%~1"=="--check" exit /b 1
echo.
echo No se completo el inicio. Revisa los mensajes anteriores.
pause
exit /b 1
