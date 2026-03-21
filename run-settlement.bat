@echo off
setlocal
chcp 65001 >nul
title [SETTLE]
echo [SETTLE]
echo.
cd /d %~dp0
set ORDER_SETTLEMENT_IDLE_INTERVAL_MS=300000
set ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS=300000
node scripts\settlement-launcher.js
pause
