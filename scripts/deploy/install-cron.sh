#!/bin/bash
# 安装 cron 定时任务（替代 Windows 计划任务）
# 功能：
#   1. 每天 00:00 启动天气预测+模拟下单
#   2. 每天 00:02 启动实盘下单循环
#   3. 每小时检查进程存活，未运行则重启天气预测
# 用法: bash scripts/deploy/install-cron.sh

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/deploy"

# 确保脚本有执行权限
chmod +x "$SCRIPT_DIR"/weather-sync.sh
chmod +x "$SCRIPT_DIR"/weather-live-order.sh

# 备份现有 crontab
crontab -l > /tmp/crontab-backup-$(date '+%Y%m%d%H%M%S').txt 2>/dev/null || true

# 构建新的 crontab 内容
# 注意：服务器时区已设为 Asia/Shanghai，cron 时间按北京时间
NEW_CRON="# Polymarket 天气交易系统定时任务"
NEW_CRON="$NEW_CRON\n# 每天 00:00 启动天气预测+模拟下单"
NEW_CRON="$NEW_CRON\n0 0 * * * $SCRIPT_DIR/weather-sync.sh"
NEW_CRON="$NEW_CRON\n# 每天 00:02 启动实盘下单循环"
NEW_CRON="$NEW_CRON\n2 0 * * * $SCRIPT_DIR/weather-live-order.sh"
NEW_CRON="$NEW_CRON\n# 每小时检查天气预测进程，未运行则重启（守护任务）"
NEW_CRON="$NEW_CRON\n10 * * * * pgrep -f weather_sync_launcher > /dev/null || $SCRIPT_DIR/weather-sync.sh"

# 移除旧的 Polymarket 任务，添加新的
( crontab -l 2>/dev/null | grep -v "Polymarket" | grep -v "weather-sync.sh" | grep -v "weather-live-order.sh" | grep -v "weather_sync_launcher" ; echo -e "$NEW_CRON" ) | crontab -

echo "========================================="
echo "  Cron 定时任务安装完成"
echo "========================================="
echo ""
echo "已安装的任务:"
crontab -l | grep -A1 "Polymarket"
echo ""
echo "查看完整 crontab: crontab -l"
echo "查看任务日志: tail -f logs/weather-sync-*.log"
echo "手动启动天气预测: bash scripts/deploy/weather-sync.sh"
echo "手动启动实盘下单: bash scripts/deploy/weather-live-order.sh"
