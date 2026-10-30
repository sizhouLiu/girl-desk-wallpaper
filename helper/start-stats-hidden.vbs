' Starts the wallpaper's system-stats helper with no console window.
' To run it at login, put a shortcut to this file in shell:startup.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "node """ & dir & "\stats-server.mjs""", 0, False
