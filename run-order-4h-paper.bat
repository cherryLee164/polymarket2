@echo off
setlocal
chcp 65001 >nul
title [4H-PAPER]
echo [4H-PAPER]
echo.
cd /d %~dp0
python -u scripts\order_4h_paper.py
pause
