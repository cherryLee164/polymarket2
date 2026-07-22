#!/bin/bash
# 天气预测+模拟下单启动脚本（替代 run-weather-predict.bat）
# 由 cron 在每天 00:00 拉起，或手动运行

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

# 优先使用项目本地的 .venv 虚拟环境
if [ -d "$ROOT_DIR/.venv/bin" ]; then
  export PATH="$ROOT_DIR/.venv/bin:$PATH"
  export PYTHON="$ROOT_DIR/.venv/bin/python3"
fi

export WEATHER_MISSING_CAPTURE_RETRY_MS=300000

LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/weather-sync-$(date '+%Y%m%d').log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 weather_sync (python=$(which python3))..." | tee -a "$LOG_FILE"
node scripts/weather_sync_launcher.js >> "$LOG_FILE" 2>&1
SYNC_EXIT=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] weather_sync 退出 exit=$SYNC_EXIT" | tee -a "$LOG_FILE"

# weather_sync 成功退出后，自动启动实盘下单
if [ $SYNC_EXIT -eq 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] weather_sync 成功完成，启动实盘下单..." | tee -a "$LOG_FILE"
  bash "$(dirname "$0")/weather-live-order.sh" >> "$LOG_FILE" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 实盘下单退出 exit=$?" | tee -a "$LOG_FILE"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] weather_sync 异常退出($SYNC_EXIT)，跳过实盘下单" | tee -a "$LOG_FILE"
fi
