@echo off
setlocal
chcp 65001 >nul
title [15M-PAPER-2]
echo [15M-PAPER-2]
echo.
cd /d %~dp0
set ORDER_15M_PAPER_VARIANT_ID=15m-paper-35x
set ORDER_15M_PAPER_OUTPUT_DIR=paper-15m-35x
set ORDER_15M_PAPER_LOG_PREFIX=15M paper 2
set ORDER_15M_PAPER_STRATEGIES=35/36,35/40,35/45,30/50,30/52,30/55,adaptive2
python -u scripts\order_15m_paper.py
pause
