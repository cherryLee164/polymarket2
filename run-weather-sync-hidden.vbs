Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

repoDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd /c cd /d """ & repoDir & """ && call run-weather-sync.bat >> data\weather_predictions\worker.out.log 2>> data\weather_predictions\worker.err.log"

shell.Run command, 0, False
