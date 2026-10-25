@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 解析 node：优先工作区便携版（DSH 自带的会锁安装目录，升级时会 SHARING_VIOLATION），
rem 最后才退回 PATH 上的 node。不要直接写 `node`：这台机器的 PATH 里没有它。
set "NODE_EXE=%~dp0..\tools\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
"%NODE_EXE%" scripts\harden-state-acl.mjs --quiet
:loop
"%NODE_EXE%" src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
