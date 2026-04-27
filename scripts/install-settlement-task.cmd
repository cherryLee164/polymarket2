@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

set "TASK_NAME=Ploymarket Settlement"
set "TASK_CMD=%ROOT%\run-settlement-all-once.bat"

schtasks /Create /TN "%TASK_NAME%" /SC HOURLY /MO 2 /ST 16:00 /TR "\"%TASK_CMD%\"" /F
powershell -NoProfile -ExecutionPolicy Bypass -Command "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72); Set-ScheduledTask -TaskName '%TASK_NAME%' -Settings $settings | Out-Null"

endlocal
