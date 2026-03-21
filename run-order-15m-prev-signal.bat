@echo off
setlocal
chcp 65001 >nul
title [15M-PREV]
echo [15M-PREV]
echo.
cd /d %~dp0
python -u scripts\order_15m_prev_signal.py
pause
