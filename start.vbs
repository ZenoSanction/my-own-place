' My Own Place - Silent Launcher
' Double-click this to open the app with no CMD window.
' Requires Start.bat to have been run at least once (to install node_modules).

Dim oShell, sDir, sExe
Set oShell = CreateObject("WScript.Shell")

' Get the folder this script lives in (no trailing backslash)
sDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
sExe = sDir & "\node_modules\electron\dist\electron.exe"

' Set working directory first, then pass "." as the app path.
' This avoids all quoted-path-with-spaces problems.
oShell.CurrentDirectory = sDir
oShell.Run Chr(34) & sExe & Chr(34) & " .", 1, False
