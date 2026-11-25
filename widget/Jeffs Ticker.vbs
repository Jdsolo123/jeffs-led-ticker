' Launches the Jeff's Ticker desktop bar with no console window.
' Double-click this (or the Desktop shortcut) to start the widget.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run """node_modules\electron\dist\electron.exe"" "".""", 0, False
