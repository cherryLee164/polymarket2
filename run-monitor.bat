@echo off
setlocal
chcp 65001 >nul
title [MONITOR]
echo [MONITOR]
echo.
cd /d %~dp0
node scripts\monitor-launcher.js
pause
