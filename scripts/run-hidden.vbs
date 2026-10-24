' run-hidden.vbs - launch a command with no console window at all.
'
'   wscript.exe //nologo "D:\...\run-hidden.vbs" "C:\...\powershell.exe" -NoProfile -File "D:\...\start.ps1"
'
' Why: when Task Scheduler starts powershell.exe / node.exe directly, the console
' window is created by the system before the program runs, so `-WindowStyle Hidden`
' only hides it afterwards - every run flashes a black box. WScript.Shell.Run with
' window style 0 never creates the window at all.
'
' Args are joined back into a command line; args containing spaces get quotes
' (WScript.Arguments has already stripped the outer ones).
'
' Keep this file ASCII-only: WSH reads .vbs as ANSI unless it has a BOM, and a
' mis-decoded non-ASCII byte can swallow the following quote.
Option Explicit

Dim shell, cmd, i, arg
If WScript.Arguments.Count = 0 Then WScript.Quit 2

Set shell = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 Then arg = """" & arg & """"
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & arg
Next

' 0 = hidden window, False = do not wait for the child to exit
shell.Run cmd, 0, False
