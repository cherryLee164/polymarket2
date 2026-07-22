#!/bin/bash
# 实盘下单循环启动脚本（替代 run-weather-live-order.bat）
# 由 cron 在每天 00:02 拉起，或手动运行

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

# 优先使用项目本地的 .venv 虚拟环境
if [ -d "$ROOT_DIR/.venv/bin" ]; then
  export PATH="$ROOT_DIR/.venv/bin:$PATH"
  export PYTHON="$ROOT_DIR/.venv/bin/python3"
fi

# 从 .env.order 加载环境变量（Node.js 不会自动加载 .env.order）
if [ -f ".env.order" ]; then
  # 提取 WEATHER_LIVE_CITY_SLUGS（可能带引号）
  CITY_SLUGS=$(grep '^WEATHER_LIVE_CITY_SLUGS=' .env.order | head -1 | cut -d'=' -f2- | sed 's/^["\x27]//;s/["\x27]$//')
  if [ -n "$CITY_SLUGS" ]; then
    export WEATHER_LIVE_CITY_SLUGS="$CITY_SLUGS"
  fi
fi

LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/weather-live-order-$(date '+%Y%m%d').log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 weather_live_order_loop..." | tee -a "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] WEATHER_LIVE_CITY_SLUGS=$WEATHER_LIVE_CITY_SLUGS" >> "$LOG_FILE"
node scripts/weather_live_order_loop.js >> "$LOG_FILE" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] weather_live_order_loop 退出 exit=$?" | tee -a "$LOG_FILE"
