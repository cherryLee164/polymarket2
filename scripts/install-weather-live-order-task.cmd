@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "TASK_NAME=WeatherLiveOrder"
set "XML_SRC=%ROOT%\scripts\weather-live-order-task.xml"
set "XML_TMP=%TEMP%\weather-live-order-task.xml"

echo Installing %TASK_NAME% scheduled task...

REM Convert XML to UTF-16 (Unicode) encoding required by schtasks /XML
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content '%XML_SRC%' -Encoding UTF8 | Out-File '%XML_TMP%' -Encoding Unicode"

REM Create task from XML (includes all settings + triggers in one step)
schtasks /Create /TN "%TASK_NAME%" /XML "%XML_TMP%" /F
if errorlevel 1 (
    echo ERROR: Failed to create task.
    exit /b 1
)

echo.
echo Done. Task '%TASK_NAME%' installed:
echo   - Daily trigger at 00:02
echo   - Logon trigger (auto-start on user logon after missed 00:02)
echo   - StartWhenAvailable=true (run missed task ASAP after computer starts)
echo   - RunOnlyIfNetworkAvailable=true
echo   - Battery: plug-in only (DisallowStartIfOnBatteries + StopIfGoingOnBatteries)
echo.
echo To verify: schtasks /Query /TN "%TASK_NAME%" /V /FO LIST

endlocal
