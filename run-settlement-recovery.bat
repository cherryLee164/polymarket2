@echo off
setlocal
chcp 65001 >nul
title [RECOVERY-SETTLEMENT]
echo [RECOVERY-SETTLEMENT]
echo.
cd /d %~dp0
node scripts\settlement_recovery_launcher.js
pause
