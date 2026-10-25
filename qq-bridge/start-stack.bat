@echo off
rem One-click launcher for the QQ bridge stack (DSH -> SnowLuma -> bridge).
rem DSH must already be running: start-stack.ps1 reuses the live port and only
rem starts what is missing (memd / pet / bridge).
chcp 65001 >nul
title QQ bridge stack
cd /d "%~dp0"

echo ============================================
echo   QQ bridge stack
echo   log: %~dp0logs\stack.log
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-stack.ps1"

echo.
netstat -ano | findstr ":3100" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [WARN] bridge console is not listening on 3100
  echo        check logs\stack.log
) else (
  echo [OK] bridge console: http://127.0.0.1:3100
)
echo.
pause
