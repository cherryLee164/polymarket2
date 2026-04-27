@echo off
setlocal
cd /d "%~dp0"
node scripts\weather_settlement_worker.js
