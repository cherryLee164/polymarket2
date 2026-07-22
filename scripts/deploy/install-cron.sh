#!/bin/bash
# 安装 cron 定时任务（替代 Windows 计划任务）
# 用法: bash scripts/deploy/install-cron.sh

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/deploy"

# 确保脚本有执行权限
chmod +x "$SCRIPT_DIR"/weather-sync.sh 2>/dev/null
chmod +x "$SCRIPT_DIR"/weather-live-order.sh 2>/dev/null

# 写入临时文件
TMP_FILE=$(mktemp)

cat > "$TMP_FILE" << CRONEOF
# Polymarket 天气交易系统定时任务
# 每天 00:00 启动天气预测（跑完后自动链式启动实盘下单）
0 0 * * * $SCRIPT_DIR/weather-sync.sh
# 每小时检查天气预测进程，未运行则重启
10 * * * * pgrep -f weather_sync_launcher > /dev/null || $SCRIPT_DIR/weather-sync.sh
CRONEOF

# 安装 crontab
crontab "$TMP_FILE"
rm -f "$TMP_FILE"

echo "========================================="
echo "  Cron 定时任务安装完成"
echo "========================================="
echo ""
echo "已安装的任务:"
crontab -l
