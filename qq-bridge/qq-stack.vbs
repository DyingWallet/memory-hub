' qq-stack hidden launcher: starts DSH / SnowLuma / qq-bridge without windows.
' 用脚本自身所在目录拼路径，不写死本机绝对路径。
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\start-stack.ps1""", 0, False
