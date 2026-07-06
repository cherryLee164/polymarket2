@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "NODE_BIN=D:\Program Files\nodejs\node.exe"
set "GUARD_SCRIPT=%ROOT%\scripts\weather_sync_guard.js"
set "TASK_NAME_PREFIX=Ploymarket Weather Sync"

echo Installing Weather Sync Guard scheduled tasks...

REM 任务1：用户登录时自动启动 launcher
schtasks /Create /TN "%TASK_NAME_PREFIX% OnLogon" /SC ONLOGON /TR "\"%NODE_BIN%\" \"%GUARD_SCRIPT%\"" /F
echo Created OnLogon task.

REM 任务2：每小时检查一次 launcher 是否存活，未运行则拉起
schtasks /Create /TN "%TASK_NAME_PREFIX% Hourly" /SC HOURLY /ST 00:10 /TR "\"%NODE_BIN%\" \"%GUARD_SCRIPT%\"" /F
echo Created Hourly guard task.

REM 配置任务设置：允许电池运行、不超时
powershell -NoProfile -ExecutionPolicy Bypass -Command "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Set-ScheduledTask -TaskName '%TASK_NAME_PREFIX% OnLogon' -Settings $settings | Out-Null; Set-ScheduledTask -TaskName '%TASK_NAME_PREFIX% Hourly' -Settings $settings | Out-Null"

echo.
echo Done. Tasks installed:
echo   - "%TASK_NAME_PREFIX% OnLogon"  (登录时自动拉起)
echo   - "%TASK_NAME_PREFIX% Hourly"   (每小时检查保活)
echo.
echo To verify: schtasks /Query /TN "%TASK_NAME_PREFIX% OnLogon"
echo To verify: schtasks /Query /TN "%TASK_NAME_PREFIX% Hourly"

endlocal
