' Microsoft Rewards Auto - silent startup at logon (no console window)
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
shell.Run """" & base & "\boot.bat""", 0, False
