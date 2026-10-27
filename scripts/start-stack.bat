@echo off
rem One-click launcher for the QQ bridge stack. Orchestration lives in the
rem sibling start-stack.ps1; this file only starts it and shows the log path.
chcp 65001 >nul
title QQ bridge stack
cd /d "%~dp0"

echo ============================================
echo   QQ bridge stack
echo   log: %~dp0..\..\qq-bridge\logs\stack.log
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-stack.ps1"

echo.
pause
