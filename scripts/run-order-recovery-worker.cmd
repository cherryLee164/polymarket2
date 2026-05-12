@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

cd /d "%ROOT%"

if not exist "data\orders_recovery" mkdir "data\orders_recovery"
if not exist "data\locks" mkdir "data\locks"

if exist "data\orders_recovery\order-paused.json" exit /b 0

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='data\locks\order-recovery-launcher.lock.json'; if (Test-Path $p) { try { $lockPid=(Get-Content $p -Raw | ConvertFrom-Json).pid; Get-Process -Id $lockPid -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 } }; exit 1"
if "%ERRORLEVEL%"=="0" exit /b 0

node scripts\order_recovery_launcher.js >> data\orders_recovery\worker.out.log 2>> data\orders_recovery\worker.err.log

endlocal
