@echo off
setlocal

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

cd /d "%ROOT%"

if not exist "data\orders_recovery" mkdir "data\orders_recovery"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='data\locks\settlement-recovery-launcher.lock.json'; if (Test-Path $p) { try { $lockPid=(Get-Content $p -Raw | ConvertFrom-Json).pid; Get-Process -Id $lockPid -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 } }; exit 1"
if "%ERRORLEVEL%"=="0" exit /b 0

set "SETTLEMENT_AUTO_SELL_ENABLED=true"
set "SETTLEMENT_AUTO_SELL_SLUG_PREFIXES=bitcoin-up-or-down-,btc-updown-,highest-temperature-in-"
set "SETTLEMENT_MAX_SELLS_PER_RUN=50"
set "SETTLEMENT_MAX_CLAIMS_PER_RUN=200"

node scripts\settlement_recovery_launcher.js >> data\orders_recovery\settlement-worker.out.log 2>> data\orders_recovery\settlement-worker.err.log

endlocal
