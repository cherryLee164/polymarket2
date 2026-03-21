@echo off
setlocal
chcp 65001 >nul
title [5M-PAPER]
echo [5M-PAPER]
echo.
cd /d %~dp0
python -u scripts\order_5m_paper.py
pause
