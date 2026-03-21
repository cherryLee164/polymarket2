@echo off
setlocal
chcp 65001 >nul
title [15M-PAPER-3]
echo [15M-PAPER-3]
echo.
cd /d %~dp0
set ORDER_15M_PAPER_VARIANT_ID=15m-paper-37x
set ORDER_15M_PAPER_OUTPUT_DIR=paper-15m-37x
set ORDER_15M_PAPER_LOG_PREFIX=15M paper 3
set ORDER_15M_PAPER_STRATEGIES=37/52,37/53,37/56
python -u scripts\order_15m_paper.py
pause
