@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bridge.ps1" %*
if errorlevel 1 pause
