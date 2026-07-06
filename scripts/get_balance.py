#!/usr/bin/env python
# 独立获取 Polymarket 账户资产组合（现金 + 持仓市值），不依赖 engine.py
# 输出 JSON: {"portfolioUsd": 22.40, "cashUsd": 20.37, "positionsUsd": 2.03} 或 {"error": "..."}
import sys
import os
import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
os.chdir(ROOT_DIR)

# 加载 .env.order（PK 在这个文件里）
def load_env_file(path):
    if not Path(path).exists():
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

for env_name in [".env.order", ".env.local", ".env"]:
    load_env_file(env_name)

PK = os.environ.get("PK", "")
FUNDER = os.environ.get("PROXY_ADDRESS", "0x3468375cbCe77260779805706a06A5D326163965")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "137"))
SIGNATURE_TYPE = int(os.environ.get("SIGNATURE_TYPE", "1"))
HOST = os.environ.get("HOST", "https://clob.polymarket.com")
DATA_API_BASE = os.environ.get("DATA_API_URL", "https://data-api.polymarket.com")

if not PK:
    print(json.dumps({"error": "PK not found in .env.order"}))
    sys.exit(1)

try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import BalanceAllowanceParams
    import urllib.request

    client = ClobClient(
        host=HOST,
        key=PK,
        chain_id=CHAIN_ID,
        signature_type=SIGNATURE_TYPE,
        funder=FUNDER,
    )
    client.set_api_creds(client.create_or_derive_api_creds())

    # 1. 获取现金余额
    raw = client.get_balance_allowance(BalanceAllowanceParams(asset_type="COLLATERAL"))
    balance_raw = raw.get("balance") or "0"
    cash_usd = int(balance_raw) / 1_000_000

    # 2. 获取持仓市值
    positions_usd = 0.0
    offset = 0
    while True:
        url = (
            f"{DATA_API_BASE}/positions?"
            f"user={FUNDER}&sizeThreshold=0.0001&limit=200&offset={offset}"
            f"&sortBy=CURRENT&sortDirection=DESC"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not isinstance(data, list) or len(data) == 0:
            break
        for pos in data:
            # currentValue 是持仓当前市值（USD）
            val = pos.get("currentValue")
            if val is not None:
                try:
                    positions_usd += float(val)
                except (TypeError, ValueError):
                    pass
        if len(data) < 200:
            break
        offset += 200

    # 3. 资产组合 = 现金 + 持仓市值，保留2位小数
    portfolio_usd = round(cash_usd + positions_usd, 2)
    cash_usd = round(cash_usd, 2)
    positions_usd = round(positions_usd, 2)
    print(json.dumps({
        "portfolioUsd": portfolio_usd,
        "cashUsd": cash_usd,
        "positionsUsd": positions_usd,
        "funder": FUNDER,
    }))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
