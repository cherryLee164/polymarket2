@echo off
setlocal
chcp 65001 >nul
title [RECOVERY-ORDER]
echo [RECOVERY-ORDER]
echo.
cd /d %~dp0
node scripts\order_recovery_launcher.js
pause
