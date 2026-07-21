#!/bin/bash
# 天气预测+模拟下单启动脚本（替代 run-weather-predict.bat）
# 由 cron 在每天 00:00 拉起，或手动运行

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

export WEATHER_MISSING_CAPTURE_RETRY_MS=300000

LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/weather-sync-$(date '+%Y%m%d').log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 weather_sync..." | tee -a "$LOG_FILE"
node scripts/weather_sync_launcher.js >> "$LOG_FILE" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] weather_sync 退出 exit=$?" | tee -a "$LOG_FILE"
