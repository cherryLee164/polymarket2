import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from py_clob_client.clob_types import TradeParams


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data" / "weather_predictions"
LIVE_ORDERS_PATH = DATA_DIR / "live-orders.json"
BACKUP_PATH = DATA_DIR / "live-orders.before-reconcile.json"
PLACED_AT_TOLERANCE_SECONDS = int(os.getenv("WEATHER_LIVE_RECONCILE_PLACED_TOLERANCE_SECONDS", "90"))
NO_FILL_AFTER_SECONDS = int(os.getenv("WEATHER_LIVE_RECONCILE_NO_FILL_AFTER_SECONDS", "1800"))
EPSILON = 1e-9

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import order as order_engine  # noqa: E402


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except Exception:
        return default
    return result if math.isfinite(result) else default


def round_money(value: Any, digits: int = 6) -> float:
    return round(as_float(value), digits)


def parse_timestamp(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except Exception:
        pass
    try:
        normalized = text.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except Exception:
        return None


def normalize_id(value: Any) -> str:
    return str(value or "").strip().lower()


def side_of(row: Dict[str, Any]) -> str:
    return str(row.get("side") or "").strip().upper()


def value_of(size: float, price: float) -> float:
    return size * price if size > EPSILON and price > EPSILON else 0.0


def response_order_id(record: Dict[str, Any]) -> str:
    order_id = record.get("orderId")
    if order_id:
        return str(order_id)
    response = record.get("response")
    if isinstance(response, dict):
        for key in ("orderID", "orderId", "id"):
            if response.get(key):
                return str(response[key])
    return ""


def response_order_ids(record: Dict[str, Any]) -> List[str]:
    ids: List[str] = []
    primary = response_order_id(record)
    if primary:
        ids.append(primary)
    attempts = record.get("orderAttempts")
    if isinstance(attempts, list):
        for attempt in attempts:
            if not isinstance(attempt, dict):
                continue
            if attempt.get("orderId"):
                ids.append(str(attempt["orderId"]))
            response = attempt.get("response")
            if isinstance(response, dict):
                for key in ("orderID", "orderId", "id"):
                    if response.get(key):
                        ids.append(str(response[key]))
    for value in record.get("botExtraOrderIds") or []:
        if value:
            ids.append(str(value))
    if not ids:
        for value in record.get("orderIds") or []:
            if value:
                ids.append(str(value))
    return list(dict.fromkeys(ids))


def find_market(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    event_slug = str(record.get("eventSlug") or "").strip()
    market_slug = str(record.get("marketSlug") or "").strip()
    if not event_slug or not market_slug:
        return None
    event = order_engine.fetch_event(event_slug)
    for market in event.get("markets") or []:
        if market.get("slug") == market_slug:
            return market
    return None


def no_token_id_from_market(market: Dict[str, Any]) -> Optional[str]:
    outcomes = order_engine.parse_json_array(market.get("outcomes"))
    token_ids = order_engine.parse_json_array(market.get("clobTokenIds"))
    no_index = next(
        (idx for idx, outcome in enumerate(outcomes) if str(outcome).strip().lower() == "no"),
        -1,
    )
    if no_index < 0 or no_index >= len(token_ids):
        return None
    return str(token_ids[no_index])


def fetch_order_trades(trader, record: Dict[str, Any]) -> List[Dict[str, Any]]:
    market = find_market(record)
    if not market:
        return []
    token_id = str(record.get("tokenId") or no_token_id_from_market(market) or "").strip()
    if not token_id:
        return []
    after = parse_timestamp(record.get("placedAt"))
    before = int(datetime.now(timezone.utc).timestamp())
    params = TradeParams(
        asset_id=token_id,
        after=(after - PLACED_AT_TOLERANCE_SECONDS) if after else None,
        before=before,
    )
    try:
        trades = trader.client.get_trades(params)
    except Exception:
        return []
    return trades if isinstance(trades, list) else []


def maker_orders(trade: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = trade.get("maker_orders")
    return rows if isinstance(rows, list) else []


def extract_bot_fills(record: Dict[str, Any], trades: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    order_ids = {normalize_id(item) for item in response_order_ids(record) if item}
    token_id = normalize_id(record.get("tokenId"))
    if not order_ids:
        return []

    fills: List[Dict[str, Any]] = []
    for trade in trades:
        if not isinstance(trade, dict):
            continue

        if normalize_id(trade.get("taker_order_id")) in order_ids:
            asset_id = normalize_id(trade.get("asset_id") or trade.get("token_id"))
            if token_id and asset_id and asset_id != token_id:
                continue
            size = as_float(trade.get("size") or trade.get("matched_amount"))
            price = as_float(trade.get("price"))
            fills.append(
                {
                    "role": "taker",
                    "side": side_of(trade) or "BUY",
                    "size": size,
                    "price": price,
                    "raw": trade,
                }
            )

        for maker in maker_orders(trade):
            if not isinstance(maker, dict):
                continue
            if normalize_id(maker.get("order_id") or maker.get("orderId") or maker.get("id")) not in order_ids:
                continue
            asset_id = normalize_id(maker.get("asset_id") or maker.get("token_id"))
            if token_id and asset_id and asset_id != token_id:
                continue
            size = as_float(
                maker.get("matched_amount")
                or maker.get("matchedAmount")
                or maker.get("size")
                or trade.get("size")
            )
            price = as_float(maker.get("price") or trade.get("price"))
            fills.append(
                {
                    "role": "maker",
                    "side": side_of(maker) or "BUY",
                    "size": size,
                    "price": price,
                    "raw": maker,
                }
            )

    return [fill for fill in fills if fill["size"] > EPSILON and fill["price"] > EPSILON]


def aggregate_fills(fills: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    buy_shares = 0.0
    buy_cost = 0.0
    sell_shares = 0.0
    sell_proceeds = 0.0
    for fill in fills:
        size = as_float(fill.get("size"))
        price = as_float(fill.get("price"))
        value = value_of(size, price)
        if side_of(fill) == "SELL":
            sell_shares += size
            sell_proceeds += value
        else:
            buy_shares += size
            buy_cost += value
    return {
        "buyShares": buy_shares,
        "buyCost": buy_cost,
        "sellShares": sell_shares,
        "sellProceeds": sell_proceeds,
    }


def compute_live_payout(record: Dict[str, Any], aggregate: Dict[str, float]) -> Tuple[Optional[float], Optional[float]]:
    buy_shares = aggregate["buyShares"]
    buy_cost = aggregate["buyCost"]
    sell_shares = aggregate["sellShares"]
    sell_proceeds = aggregate["sellProceeds"]
    if buy_shares <= EPSILON or buy_cost <= EPSILON:
        return None, None

    credited_sell_shares = min(sell_shares, buy_shares)
    sell_price = sell_proceeds / sell_shares if sell_shares > EPSILON else 0.0
    credited_sell_proceeds = credited_sell_shares * sell_price
    remaining_shares = max(0.0, buy_shares - credited_sell_shares)
    resolved_outcome = str(record.get("resolvedOutcome") or "").strip().lower()

    if resolved_outcome == "no":
        payout = credited_sell_proceeds + remaining_shares
        return payout, payout - buy_cost
    if resolved_outcome == "yes":
        payout = credited_sell_proceeds
        return payout, payout - buy_cost
    if credited_sell_shares > EPSILON:
        payout = credited_sell_proceeds
        return payout, payout - buy_cost
    return None, None


def accounting_stake_usd(record: Dict[str, Any]) -> float:
    for key in ("actualBuyCostUsd", "stakeUsd", "requestedStakeUsd"):
        value = as_float(record.get(key))
        if value > EPSILON:
            return value
    return 0.0


def estimated_no_win_pnl_usd(record: Dict[str, Any]) -> Optional[float]:
    actual_cost = as_float(record.get("actualBuyCostUsd"))
    actual_shares = as_float(record.get("actualBuyShares"))
    if actual_cost > EPSILON and actual_shares > EPSILON:
        return round_money(actual_shares - actual_cost)
    existing = record.get("estimatedNoWinPnlUsd")
    if existing not in (None, ""):
        return round_money(existing)
    stake = accounting_stake_usd(record)
    price = as_float(record.get("buyNoPrice"))
    if stake <= EPSILON or price <= EPSILON:
        return None
    return round_money(stake / price - stake)


def accounting_pnl_usd(record: Dict[str, Any]) -> Optional[float]:
    if str(record.get("status") or "").lower() != "resolved":
        return None
    outcome = str(record.get("resolvedOutcome") or "").strip().lower()
    if not outcome:
        result = str(record.get("result") or "").strip().lower()
        legacy_pnl = as_float(record.get("pnlUsd"))
        if result == "profit" or legacy_pnl > 0:
            outcome = "no"
        elif result == "loss" or legacy_pnl < 0:
            outcome = "yes"
    if outcome == "no":
        return estimated_no_win_pnl_usd(record)
    if outcome == "yes":
        stake = accounting_stake_usd(record)
        return round_money(-stake) if stake > EPSILON else None
    return None


def no_fill_update(record: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    status = str(record.get("status") or "").lower()
    placed_at = parse_timestamp(record.get("placedAt"))
    now_ts = int(datetime.now(timezone.utc).timestamp())
    if status not in {"pending", "placing", "no-fill"}:
        return record, False
    if placed_at is None or now_ts - placed_at < NO_FILL_AFTER_SECONDS:
        return record, False

    updates = {
        "actualBuyCostUsd": 0,
        "actualBuyShares": 0,
        "actualSellProceedsUsd": 0,
        "actualSellShares": 0,
        "actualRemainingShares": 0,
        "actualTradeCount": 0,
        "stakeUsd": 0,
        "spentUsd": 0,
        "sharesBought": 0,
        "payoutUsd": None,
        "pnlUsd": None,
        "status": "no-fill",
        "result": "no-fill",
        "fillStatus": "no-bot-order-fill",
    }
    if "requestedStakeUsd" not in record:
        updates["requestedStakeUsd"] = record.get("stakeUsd")
    if all(record.get(key) == value for key, value in updates.items()):
        return record, False
    return {**record, **updates, "reconciledAt": datetime.now(timezone.utc).isoformat()}, True


def reconcile_record(record: Dict[str, Any], trader) -> Tuple[Dict[str, Any], bool]:
    if not record.get("marketSlug") or str(record.get("status") or "").lower() in {
        "failed",
        "skipped",
        "cancelled",
        "canceled",
    }:
        return record, False

    if not response_order_ids(record):
        updated = {
            **record,
            "fillStatus": "missing-order-id",
            "reconciledAt": datetime.now(timezone.utc).isoformat(),
        }
        return updated, updated != record

    trades = fetch_order_trades(trader, record)
    fills = extract_bot_fills(record, trades)
    aggregate = aggregate_fills(fills)
    if aggregate["buyShares"] <= EPSILON or aggregate["buyCost"] <= EPSILON:
        return no_fill_update(record)

    payout, pnl = compute_live_payout(record, aggregate)
    order_ids = response_order_ids(record)
    updates = {
        "orderIds": order_ids,
        "actualBuyCostUsd": round_money(aggregate["buyCost"]),
        "actualBuyShares": round_money(aggregate["buyShares"]),
        "actualSellProceedsUsd": round_money(aggregate["sellProceeds"]),
        "actualSellShares": round_money(aggregate["sellShares"]),
        "actualRemainingShares": round_money(
            max(0.0, aggregate["buyShares"] - min(aggregate["sellShares"], aggregate["buyShares"]))
        ),
        "actualTradeCount": len(fills),
        "stakeUsd": round_money(aggregate["buyCost"]),
        "spentUsd": round_money(aggregate["buyCost"]),
        "sharesBought": round_money(aggregate["buyShares"]),
        "estimatedNoWinPnlUsd": round_money(aggregate["buyShares"] - aggregate["buyCost"]),
        "fillStatus": "bot-order-fill",
        "error": None,
        "failedAt": None,
    }
    if "requestedStakeUsd" not in record:
        updates["requestedStakeUsd"] = record.get("stakeUsd")
    if str(record.get("status") or "").lower() == "no-fill":
        updates["status"] = "pending"
        updates["result"] = "pending"

    if payout is not None and pnl is not None:
        resolved_record = {**record, **updates}
        accounting_pnl = accounting_pnl_usd(resolved_record)
        updates.update(
            {
                "payoutUsd": round_money(payout),
                "pnlUsd": round_money(pnl),
                "accountingStakeUsd": round_money(accounting_stake_usd(resolved_record)),
                "accountingPnlUsd": accounting_pnl,
                "accountingPnlMethod": "estimated-win-or-stake-loss" if accounting_pnl is not None else None,
                "result": "profit" if pnl > 0 else "loss" if pnl < 0 else "flat",
            }
        )

    if all(record.get(key) == value for key, value in updates.items()):
        return record, False

    return {**record, **updates, "reconciledAt": datetime.now(timezone.utc).isoformat()}, True


def main() -> int:
    records = read_json(LIVE_ORDERS_PATH, [])
    if not isinstance(records, list):
        raise RuntimeError("live-orders.json is not a list")
    if not records:
        print("No live weather orders to reconcile")
        return 0

    trader = order_engine.create_trader()
    trader.initialize()
    updated_records = []
    changed = 0
    for record in records:
        updated, did_change = reconcile_record(record, trader)
        updated_records.append(updated)
        if did_change:
            changed += 1

    if changed:
        if not BACKUP_PATH.exists():
            write_json(BACKUP_PATH, records)
        write_json(LIVE_ORDERS_PATH, updated_records)

    print(f"Reconciled live weather orders by orderId: records={len(records)} changed={changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
