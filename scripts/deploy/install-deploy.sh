#!/bin/bash
# Polymarket 天气交易系统 - Linux 一键部署脚本
# 适用于 Ubuntu 22.04 LTS (AWS Lightsail)
# 用法: bash install-deploy.sh

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

echo "========================================="
echo "  Polymarket 天气交易系统部署"
echo "  目录: $ROOT_DIR"
echo "========================================="

# 1. 安装系统依赖
echo ""
echo "[1/6] 安装系统依赖..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git python3 python3-pip python3-venv

# 2. 安装 Node.js 20.x
echo ""
echo "[2/6] 安装 Node.js 20.x..."
if ! command -v node &>/dev/null || [[ "$(node -v)" < "v20" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "  Node.js: $(node -v)"
echo "  npm: $(npm -v)"

# 3. 安装 Python 依赖
echo ""
echo "[3/6] 安装 Python 依赖..."
python3 -m pip install --upgrade pip -q
python3 -m pip install -r requirements.txt -q
echo "  Python: $(python3 --version)"

# 4. 安装 Node 依赖
echo ""
echo "[4/6] 安装 Node 依赖..."
npm install --production
echo "  npm install 完成"

# 5. 检查配置文件
echo ""
echo "[5/6] 检查配置文件..."
if [ ! -f ".env.order" ]; then
  echo "  [警告] .env.order 不存在！请从本地复制到此目录"
  echo "  命令: scp .env.order ubuntu@<VPS-IP>:~/polymarket2/.env.order"
else
  echo "  .env.order ✓"
fi

if [ ! -f "data/weather_predictions/config.json" ]; then
  echo "  [警告] data/weather_predictions/config.json 不存在！"
  echo "  需要从本地复制 data/ 目录: scp -r data/ ubuntu@<VPS-IP>:~/polymarket2/"
else
  echo "  config.json ✓"
fi

if [ ! -f "config/stake-plan.json" ]; then
  echo "  [警告] config/stake-plan.json 不存在！"
else
  echo "  stake-plan.json ✓"
fi

# 6. 设置时区为亚洲/上海
echo ""
echo "[6/6] 设置时区..."
sudo timedatectl set-timezone Asia/Shanghai
echo "  当前时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"

# 完成
echo ""
echo "========================================="
echo "  部署完成！"
echo "========================================="
echo ""
echo "后续步骤:"
echo "  1. 确保 .env.order 和 data/ 目录已从本地复制"
echo "  2. 安装 cron 定时任务: bash scripts/deploy/install-cron.sh"
echo "  3. 手动测试: bash scripts/deploy/weather-sync.sh"
echo ""
