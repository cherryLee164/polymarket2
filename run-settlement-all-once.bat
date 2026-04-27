@echo off
setlocal
cd /d "%~dp0"
if not exist "data\orders_recovery" mkdir "data\orders_recovery"
set "SETTLEMENT_AUTO_SELL_ENABLED=true"
set "SETTLEMENT_AUTO_SELL_SLUG_PREFIXES=bitcoin-up-or-down-,btc-updown-,highest-temperature-in-"
set "SETTLEMENT_MAX_SELLS_PER_RUN=50"
set "SETTLEMENT_MAX_CLAIMS_PER_RUN=200"
node scripts\settlement_recovery_launcher.js --once >> data\orders_recovery\settlement.out.log 2>> data\orders_recovery\settlement.err.log
endlocal
