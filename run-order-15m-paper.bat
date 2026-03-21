@echo off
setlocal
chcp 65001 >nul
title [15M-PAPER]
echo [15M-PAPER]
echo.
cd /d %~dp0
python -u scripts\order_15m_paper.py
pause
