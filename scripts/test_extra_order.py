"""对今天已下单的城市每个再额外下单指定金额（加仓）。
排序规则：昨天亏损的城市优先（亏损金额越大越靠前），其余按城市优先级排序。
余额不足时按排序结果只下能负担得起的城市。
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "scripts"))

import order as order_engine  # noqa: E402

DATA_DIR = ROOT_DIR / "data" / "weather_predictions"
LIVE_ORDERS_PATH = DATA_DIR / "live-orders.json"

POST_ORDER_WAIT = 90

# 城市优先级（与 config/stake-plan.json 保持一致）
PRIORITY_CITIES = [
    "beijing", "hong-kong", "taipei", "shanghai", "guangzhou",
    "shenzhen", "wuhan", "chengdu", "chongqing", "qingdao",
]


def get_beijing_date():
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz).strftime("%Y-%m-%d")


def get_yesterday_date():
    tz = timezone(timedelta(hours=8))
    yesterday = datetime.now(tz) - timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d")


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def get_yesterday_losing_cities(live_orders, yesterday_date):
    """获取昨天亏损的城市及亏损金额，按亏损从大到小排序。"""
    losses = {}
    for o in live_orders:
        if (
            o.get("date") == yesterday_date
            and str(o.get("status", "")).lower() == "resolved"
        ):
            pnl = float(o.get("pnlUsd", 0) or 0)
            if pnl < 0:
                city = o.get("citySlug", "")
                if city:
                    losses[city] = losses.get(city, 0) + pnl
    # 按亏损金额从小到大（即亏损越大越靠前）排序
    sorted_losses = sorted(losses.items(), key=lambda x: x[1])
    return [city for city, _ in sorted_losses]


def sort_orders_by_priority(today_orders, losing_cities):
    """排序：昨天亏损的城市优先（亏损越大越靠前），其余按城市优先级排序。"""
    def sort_key(o):
        city = o.get("citySlug", "")
        if city in losing_cities:
            # 亏损城市排最前，亏损越大 index 越小
            return (0, losing_cities.index(city))
        # 其余按优先级排序
        priority_idx = PRIORITY_CITIES.index(city) if city in PRIORITY_CITIES else 99
        return (1, priority_idx)

    return sorted(today_orders, key=sort_key)


def find_market(event, market_slug):
    markets = order_engine.parse_json_array(event.get("markets"))
    for m in markets:
        if str(m.get("slug")) == market_slug:
            return m
    return None


def select_no_token(market):
    outcomes = order_engine.parse_json_array(market.get("outcomes"))
    token_ids = order_engine.parse_json_array(market.get("clobTokenIds"))
    prices = order_engine.parse_json_array(market.get("outcomePrices"))
    no_idx = -1
    for idx, outcome in enumerate(outcomes):
        if str(outcome).strip().lower() == "no":
            no_idx = idx
            break
    if no_idx < 0 or no_idx >= len(token_ids):
        raise RuntimeError("No token not found")
    return {
        "tokenId": str(token_ids[no_idx]),
        "currentNoPrice": float(prices[no_idx]) if no_idx < len(prices) else None,
    }


def main():
    parser = argparse.ArgumentParser(description="对今天已下单的城市每个加仓指定金额")
    parser.add_argument("--amount", type=float, default=1.0, help="每个城市加仓金额（美元），默认 1.0")
    parser.add_argument("--date", type=str, default=None, help="目标日期（YYYY-MM-DD），默认北京时间今天")
    args = parser.parse_args()

    target_date = args.date or get_beijing_date()
    extra_stake = args.amount

    live_orders = read_json(LIVE_ORDERS_PATH, [])
    today_orders = [
        o for o in live_orders
        if o.get("date") == target_date
        and o.get("status") == "pending"
        and (
            o.get("fillStatus") == "position-detected"
            or (float(o.get("actualBuyCostUsd", 0) or 0) > 0 and float(o.get("actualBuyShares", 0) or 0) > 0)
        )
    ]
    if not today_orders:
        print(f"no today orders found for {target_date}")
        return

    # 获取昨天亏损城市，按亏损金额排序
    yesterday_date = get_yesterday_date()
    losing_cities = get_yesterday_losing_cities(live_orders, yesterday_date)
    if losing_cities:
        print(f"yesterday losing cities (priority): {losing_cities}")

    # 排序：亏损城市优先，其余按优先级
    today_orders = sort_orders_by_priority(today_orders, losing_cities)
    city_order = [o.get("citySlug", "?") for o in today_orders]
    print(f"order sequence: {city_order}")

    trader = order_engine.create_trader()
    trader.initialize()

    balance = trader.get_balance_status()
    balance_usd = float(balance.get("balance", 0))
    print(f"balance=${balance_usd:.3f}")

    # 余额预检：只下能负担得起的城市
    affordable_count = int(balance_usd / extra_stake)
    if affordable_count < len(today_orders):
        print(f"balance ${balance_usd:.2f} can only afford {affordable_count}/{len(today_orders)} cities, truncating")
        today_orders = today_orders[:affordable_count]

    if not today_orders:
        print("balance too low, cannot afford any extra orders")
        return

    print(f"will place extra ${extra_stake} each for {len(today_orders)} cities")

    bought = 0
    failed = 0

    for order in today_orders:
        city = order.get("cityZh", order.get("citySlug"))
        event_slug = order.get("eventSlug")
        market_slug = order.get("marketSlug")
        price_cap = float(order.get("priceCap", 0.9))

        try:
            event = order_engine.fetch_event(str(event_slug))
            if not event:
                print(f"SKIP {city} event not found")
                failed += 1
                continue

            market = find_market(event, str(market_slug))
            if not market:
                print(f"SKIP {city} market not found")
                failed += 1
                continue

            token = select_no_token(market)
            token_id = token["tokenId"]

            raw_tick_size = market.get("orderPriceMinTickSize") or ""
            tick_size = str(raw_tick_size) if raw_tick_size != "" else None
            neg_risk = bool(market.get("negRisk") or event.get("negRisk") or False)

            print(f"WAIT before-order {city} seconds=60")
            time.sleep(60)

            trader.ensure_funds(extra_stake)
            response = trader.place_buy(token_id, extra_stake, price_cap, tick_size, neg_risk)
            order_id = ""
            if isinstance(response, dict):
                order_id = response.get("orderID") or response.get("orderId") or ""

            print(f"WAIT after-order {city} seconds={POST_ORDER_WAIT}")
            time.sleep(POST_ORDER_WAIT)

            after = float(trader.get_position_size(token_id) or 0.0)
            baseline = float(order.get("positionAfter", 0) or 0.0)
            delta = max(0.0, after - baseline)
            cost_est = round(delta * float(token["currentNoPrice"] or 0.9), 6) if delta > 0 else 0

            if delta > 0.001 or (isinstance(response, dict) and response.get("success")):
                print(f"BOUGHT {city} No requested=${extra_stake:.3f} delta={delta:.6f} cost_est=${cost_est:.3f} orderId={order_id}")
                bought += 1
            else:
                print(f"FAILED {city} No response={response}")
                failed += 1

        except Exception as exc:
            print(f"ERROR {city}: {exc}")
            failed += 1

    print(f"SUMMARY date={target_date} bought={bought} failed={failed}")


if __name__ == "__main__":
    main()
