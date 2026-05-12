@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

cd /d "%ROOT%"

if not exist "data\monitor_logs" mkdir "data\monitor_logs"
if not exist "data\weather_predictions" mkdir "data\weather_predictions"
if not exist "data\orders_recovery" mkdir "data\orders_recovery"

start "" /min cmd /c "cd /d \"%ROOT%\" && node scripts\monitor-launcher.js >> data\monitor_logs\worker.out.log 2>> data\monitor_logs\worker.err.log"
start "" /min cmd /c "cd /d \"%ROOT%\" && node scripts\weather_sync_launcher.js >> data\weather_predictions\worker.out.log 2>> data\weather_predictions\worker.err.log"
start "" /min "%ROOT%\scripts\run-order-recovery-worker.cmd"
start "" /min "%ROOT%\scripts\run-settlement-recovery-worker.cmd"

endlocal
