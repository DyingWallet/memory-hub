' qq-bridge control center without a console window.
' Opens the control center page in your browser. Use the "exit" button on the page to quit.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
' Without Node.js the hidden window would fail silently - check first and tell the user.
If sh.Run("cmd /d /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js was not found on PATH." & vbCrLf & vbCrLf & _
    "Install Node.js 22 LTS from https://nodejs.org (tick ""Add to PATH"")," & vbCrLf & _
    "then run ""node scripts\setup-dsh.mjs"" again in this folder and reopen this launcher.", _
    vbExclamation, "qq-bridge control center"
  WScript.Quit 1
End If
sh.Run "cmd /d /c node src\launcher\control-center.mjs", 0, False
