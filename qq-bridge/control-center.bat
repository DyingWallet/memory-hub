@echo off
rem qq-bridge control center: one local web page for the bridge and SnowLuma.
rem It does NOT start the bridge or SnowLuma by itself - use the buttons on the page.
rem Closing this window stops the control center and the processes it started.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [qq-bridge] Node.js was not found on PATH.
  echo Install Node.js 22 LTS from https://nodejs.org ^(tick "Add to PATH"^),
  echo then run "node scripts\setup-dsh.mjs" again in this folder and reopen this launcher.
  echo.
  pause
  exit /b 1
)
node scripts\harden-state-acl.mjs --quiet
node src\launcher\control-center.mjs %*
if errorlevel 1 pause
