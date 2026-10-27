' qq-stack hidden launcher: starts DSH / SnowLuma / qq-bridge without windows.
' Orchestration lives in memory-hub\scripts\start-stack.ps1; this file only launches it.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
bridgeRoot = fso.GetParentFolderName(scriptDir)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & bridgeRoot & "\memory-hub\scripts\start-stack.ps1""", 0, False
