@echo off
setlocal
chcp 65001 >nul
title [1H-4H-ORDER]
echo [1H-4H-ORDER]
echo.
cd /d %~dp0
node scripts\order-launcher.js
pause
