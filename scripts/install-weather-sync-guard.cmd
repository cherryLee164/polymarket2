@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "NODE_BIN=D:\Program Files\nodejs\node.exe"
set "GUARD_SCRIPT=%ROOT%\scripts\weather_sync_guard.js"
set "TASK_NAME_PREFIX=Ploymarket Weather Sync"

echo Installing Weather Sync Guard scheduled tasks...

REM Task 1: Auto-start launcher on user logon
schtasks /Create /TN "%TASK_NAME_PREFIX% OnLogon" /SC ONLOGON /TR "\"%NODE_BIN%\" \"%GUARD_SCRIPT%\"" /F
echo Created OnLogon task.

REM Task 2: Hourly check if launcher is alive, restart if not running
schtasks /Create /TN "%TASK_NAME_PREFIX% Hourly" /SC HOURLY /ST 00:10 /TR "\"%NODE_BIN%\" \"%GUARD_SCRIPT%\"" /F
echo Created Hourly guard task.

REM Configure task settings: allow battery, no timeout
powershell -NoProfile -ExecutionPolicy Bypass -Command "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Set-ScheduledTask -TaskName '%TASK_NAME_PREFIX% OnLogon' -Settings $settings | Out-Null; Set-ScheduledTask -TaskName '%TASK_NAME_PREFIX% Hourly' -Settings $settings | Out-Null"

echo.
echo Done. Tasks installed:
echo   - "%TASK_NAME_PREFIX% OnLogon"  (auto-start on logon)
echo   - "%TASK_NAME_PREFIX% Hourly"   (hourly guard check)
echo.
echo To verify: schtasks /Query /TN "%TASK_NAME_PREFIX% OnLogon"
echo To verify: schtasks /Query /TN "%TASK_NAME_PREFIX% Hourly"

endlocal
