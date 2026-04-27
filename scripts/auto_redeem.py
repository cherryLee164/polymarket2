import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import order as order_engine


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = ROOT_DIR / "data" / "orders" / "redeems"
DATA_DIR = Path(
    order_engine.get_first_env(["ORDER_AUTO_REDEEM_DATA_DIR"], str(DEFAULT_DATA_DIR))
).expanduser()
STATE_PATH = DATA_DIR / "auto-redeem-state.json"
LOG_PATH = DATA_DIR / "auto-redeem-log.jsonl"
RECOVERY_REPORTS_DIR = Path(
    order_engine.get_first_env(
        ["ORDER_AUTO_REDEEM_RECOVERY_REPORTS_DIR"],
        str(ROOT_DIR / "data" / "orders_recovery" / "reports"),
    )
).expanduser()
COOLDOWN_MS = order_engine.ORDER_REDEEM_RETRY_COOLDOWN_MS
AUTO_SELL_ENABLED = order_engine.parse_bool(
    order_engine.get_first_env(["ORDER_AUTO_SELL_ENABLED"], "true"),
    True,
)
AUTO_SELL_TARGET_CENTS = float(
    order_engine.get_first_env(["ORDER_AUTO_SELL_TARGET_CENTS"], "99.9")
)
AUTO_SELL_MIN_POSITION_USD = float(
    order_engine.get_first_env(["ORDER_AUTO_SELL_MIN_POSITION_USD"], "0.5")
)
AUTO_SELL_VERIFY_WAIT_MS = int(
    order_engine.get_first_env(["ORDER_AUTO_SELL_VERIFY_WAIT_MS"], "5000")
)
MAX_SELLS_PER_RUN = int(
    order_engine.get_first_env(["ORDER_SETTLEMENT_MAX_SELLS_PER_RUN"], "1")
)
MAX_CLAIMS_PER_RUN = int(
    order_engine.get_first_env(["ORDER_SETTLEMENT_MAX_CLAIMS_PER_RUN"], "0")
)
AUTO_CLAIM_ENABLED = order_engine.parse_bool(
    order_engine.get_first_env(["ORDER_AUTO_CLAIM_ENABLED", "ORDER_AUTO_REDEEM_ENABLED"], "true"),
    True,
)
AUTO_CLAIM_VERIFY_WAIT_MS = int(
    order_engine.get_first_env(["ORDER_AUTO_CLAIM_VERIFY_WAIT_MS"], "5000")
)
AUTO_REDEEM_TRACKED_ONLY = order_engine.parse_bool(
    order_engine.get_first_env(["ORDER_AUTO_REDEEM_TRACKED_ONLY"], "true"),
    True,
)
AUTO_REDEEM_TRACK_SOURCE = (
    order_engine.get_first_env(["ORDER_AUTO_REDEEM_TRACK_SOURCE"], "legacy").strip().lower()
)
AUTO_REDEEM_SLUG_PREFIXES = tuple(
    prefix.strip().lower()
    for prefix in order_engine.get_first_env(
        ["ORDER_AUTO_REDEEM_SLUG_PREFIXES"],
        "",
    ).split(",")
    if prefix.strip()
)
AUTO_SELL_SLUG_PREFIXES = tuple(
    prefix.strip().lower()
    for prefix in order_engine.get_first_env(
        ["ORDER_AUTO_SELL_SLUG_PREFIXES"],
        "bitcoin-up-or-down-,btc-updown-",
    ).split(",")
    if prefix.strip()
)
QUOTA_RESET_PATTERN = re.compile(r"quota exceeded: .*?resets in (\d+) seconds", re.IGNORECASE)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_log(entry: Dict[str, Any]) -> None:
    ensure_dir(DATA_DIR)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"loggedAt": utc_now_iso(), **entry}, ensure_ascii=False) + "\n")


def compact_cycle_summary(summary: Dict[str, Any]) -> Dict[str, Any]:
    auto_sell = summary.get("autoSell") if isinstance(summary.get("autoSell"), dict) else {}
    sold_rows = auto_sell.get("sold") or []
    return {
        "beforeBalanceUsd": summary.get("beforeBalanceUsd"),
        "afterBalanceUsd": summary.get("afterBalanceUsd"),
        "busy": summary.get("busy"),
        "trackedSlugCount": summary.get("trackedSlugCount"),
        "trackedSlugSource": summary.get("trackedSlugSource"),
        "redeemableCount": summary.get("redeemableCount"),
        "afterRedeemableCount": summary.get("afterRedeemableCount"),
        "claimed": summary.get("claimed"),
        "claimedCount": summary.get("claimedCount"),
        "claimErrorCount": summary.get("claimErrorCount"),
        "claimError": summary.get("claimError"),
        "claimBackoffActive": summary.get("claimBackoffActive"),
        "claimBackoffUntilAt": summary.get("claimBackoffUntilAt"),
        "claimBackoffReason": summary.get("claimBackoffReason"),
        "claimApiOnly": summary.get("claimApiOnly"),
        "claimDisabled": summary.get("claimDisabled"),
        "claimDisabledReason": summary.get("claimDisabledReason"),
        "claimResult": summary.get("claimResult"),
        "claimResultsPreview": [
            {
                "slug": row.get("slug"),
                "conditionId": row.get("conditionId"),
                "outcome": row.get("outcome"),
                "success": row.get("success"),
                "error": row.get("error"),
                "txHash": (
                    row.get("result", {}).get("transaction_hash")
                    if isinstance(row.get("result"), dict)
                    else None
                ),
            }
            for row in (summary.get("claimResults") or [])[:5]
        ],
        "cooldownSkipped": summary.get("cooldownSkipped"),
        "entriesPreview": [
            {
                "slug": entry.get("slug"),
                "conditionId": entry.get("conditionId"),
                "indexSets": entry.get("indexSets"),
            }
            for entry in (summary.get("entries") or [])[:5]
        ],
        "autoSell": {
            "enabled": auto_sell.get("enabled"),
            "targetCents": auto_sell.get("targetCents"),
            "positionCount": auto_sell.get("positionCount"),
            "candidateCount": auto_sell.get("candidateCount"),
            "candidates": (auto_sell.get("candidates") or [])[:5],
            "sold": [
                {
                    "slug": row.get("slug"),
                    "title": row.get("title"),
                    "outcome": row.get("outcome"),
                    "shares": row.get("shares"),
                    "sellPrice": row.get("sellPrice"),
                    "pageLikePrice": row.get("pageLikePrice"),
                    "currentValueUsd": row.get("currentValueUsd"),
                    "realizedUsd": row.get("realizedUsd"),
                    "sold": row.get("sold"),
                    "balanceBeforeUsd": row.get("balanceBeforeUsd"),
                    "balanceAfterUsd": row.get("balanceAfterUsd"),
                    "orderId": row.get("response", {}).get("orderID") if isinstance(row.get("response"), dict) else None,
                    "txHash": (row.get("response", {}).get("transactionsHashes") or [None])[0]
                    if isinstance(row.get("response"), dict)
                    else None,
                }
                for row in sold_rows[:3]
            ],
        },
    }


def load_state() -> Dict[str, Any]:
    if not STATE_PATH.exists():
        return {"conditions": {}, "assets": {}, "claims": {}, "meta": {}}
    try:
        payload = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        payload.setdefault("conditions", {})
        payload.setdefault("assets", {})
        payload.setdefault("claims", {})
        payload.setdefault("meta", {})
        return payload
    except Exception:
        return {"conditions": {}, "assets": {}, "claims": {}, "meta": {}}


def save_state(state: Dict[str, Any]) -> None:
    ensure_dir(DATA_DIR)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def extract_quota_reset_seconds(message: Optional[str]) -> Optional[int]:
    text = str(message or "")
    match = QUOTA_RESET_PATTERN.search(text)
    if not match:
        return None
    try:
        seconds = int(match.group(1))
    except Exception:
        return None
    return max(0, seconds)


def get_claim_backoff(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    meta = state.setdefault("meta", {})
    until_ms = int(meta.get("claimBackoffUntilMs") or 0)
    if until_ms <= int(time.time() * 1000):
        if until_ms:
            meta.pop("claimBackoffUntilMs", None)
            meta.pop("claimBackoffUntilAt", None)
            meta.pop("claimBackoffReason", None)
        return None
    return {
        "untilMs": until_ms,
        "untilAt": meta.get("claimBackoffUntilAt"),
        "reason": meta.get("claimBackoffReason"),
    }


def apply_claim_quota_backoff(state: Dict[str, Any], message: Optional[str]) -> Optional[Dict[str, Any]]:
    seconds = extract_quota_reset_seconds(message)
    if seconds is None:
        return None
    until_ms = int(time.time() * 1000) + (seconds + 60) * 1000
    until_at = datetime.fromtimestamp(until_ms / 1000, tz=timezone.utc).isoformat()
    meta = state.setdefault("meta", {})
    meta["claimBackoffUntilMs"] = until_ms
    meta["claimBackoffUntilAt"] = until_at
    meta["claimBackoffReason"] = str(message or "")
    return {
        "untilMs": until_ms,
        "untilAt": until_at,
        "reason": str(message or ""),
    }


def get_balance_snapshot(trader=None) -> Dict[str, Any]:
    if trader is None:
        trader = order_engine.create_trader()
        trader.initialize()
    raw = trader.client.get_balance_allowance(order_engine.BalanceAllowanceParams(asset_type="COLLATERAL"))
    balance_raw = raw.get("balance") or "0"
    return {
        "balanceRaw": balance_raw,
        "balanceUsd": round(int(balance_raw) / 1_000_000, 6),
        "funder": getattr(trader, "funder", None),
        "signatureType": getattr(trader, "signature_type", None),
    }


def fetch_open_positions(funder: str) -> List[Dict[str, Any]]:
    if not funder:
        return []
    limit = 200
    offset = 0
    positions: List[Dict[str, Any]] = []
    while True:
        params = {
            "user": funder,
            "sizeThreshold": "0.0001",
            "limit": str(limit),
            "offset": str(offset),
            "sortBy": "CURRENT",
            "sortDirection": "DESC",
        }
        resp = order_engine.SESSION.get(
            f"{order_engine.DATA_API_BASE}/positions",
            params=params,
            timeout=20,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        positions.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return positions


def get_legacy_tracked_slugs() -> set[str]:
    tracked = set()
    for file_path in order_engine.list_json_files(order_engine.HOURS_DIR):
        state = order_engine.read_json_file(file_path)
        if not isinstance(state, dict) or not order_engine.has_placed_orders(state):
            continue
        slug = state.get("slug")
        if slug:
            tracked.add(str(slug))
    return tracked


def get_recovery_tracked_slugs() -> set[str]:
    tracked = set()
    if not RECOVERY_REPORTS_DIR.exists():
        return tracked
    for file_path in sorted(RECOVERY_REPORTS_DIR.glob("trade-details-*.json")):
        rows = order_engine.read_json_file(file_path)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            status = str(row.get("status") or "").strip().lower()
            spent_usd = order_engine.parse_float(row.get("spentUsd"), 0.0) or 0.0
            if status not in {"matched", "filled", "bought"} and spent_usd <= 0:
                continue
            slug = str(row.get("slug") or "").strip()
            if slug:
                tracked.add(slug)
    return tracked


def get_tracked_slugs() -> set[str]:
    source = AUTO_REDEEM_TRACK_SOURCE
    if source == "recovery":
        return get_recovery_tracked_slugs()
    if source in {"all", "both"}:
        return get_legacy_tracked_slugs() | get_recovery_tracked_slugs()
    return get_legacy_tracked_slugs()


def is_tracked_redeemable_position(position: Dict[str, Any], tracked_slugs: set[str]) -> bool:
    slug = str(position.get("eventSlug") or position.get("slug") or "").lower()
    if AUTO_REDEEM_SLUG_PREFIXES and not any(slug.startswith(prefix) for prefix in AUTO_REDEEM_SLUG_PREFIXES):
        return False
    if not AUTO_REDEEM_TRACKED_ONLY:
        return True
    if not slug:
        return False
    return bool(tracked_slugs) and slug in tracked_slugs


def get_redeemable_entries(funder: str, tracked_slugs: set[str]) -> List[Dict[str, Any]]:
    positions = order_engine.fetch_redeemable_positions(funder)
    positions = [
        position
        for position in positions
        if is_tracked_redeemable_position(position, tracked_slugs)
    ]
    entries = []
    seen_assets = set()
    for position in positions:
        asset = asset_key(position)
        if not asset or asset in seen_assets:
            continue
        seen_assets.add(asset)
        try:
            outcome_index = int(position.get("outcomeIndex"))
        except Exception:
            continue
        entries.append(
            {
                "asset": asset,
                "conditionId": position.get("conditionId"),
                "indexSets": [1 << outcome_index],
                "slug": position.get("eventSlug") or position.get("slug"),
                "title": position.get("title"),
                "positions": [position],
                "outcomeIndex": outcome_index,
                "outcome": position.get("outcome"),
                "size": float(position.get("size") or 0),
                "currentValue": float(position.get("currentValue") or 0),
                "curPrice": float(position.get("curPrice") or 0),
                "negativeRisk": bool(position.get("negativeRisk")),
            }
        )
    entries.sort(
        key=lambda entry: (
            float(entry.get("currentValue") or 0),
            float(entry.get("curPrice") or 0),
            float(entry.get("size") or 0),
        ),
        reverse=True,
    )
    return entries


def condition_key(entry: Dict[str, Any]) -> str:
    return entry.get("conditionId") or entry.get("slug") or "unknown"


def asset_key(position: Dict[str, Any]) -> str:
    return str(position.get("asset") or position.get("tokenId") or "")


def claim_key(entry: Dict[str, Any]) -> str:
    return str(entry.get("asset") or entry.get("tokenId") or entry.get("conditionId") or "unknown")


def should_attempt_claim(state: Dict[str, Any], entry: Dict[str, Any]) -> bool:
    key = claim_key(entry)
    record = state.setdefault("claims", {}).get(key, {})
    last_attempt_ms = int(record.get("lastClaimAttemptMs") or 0)
    return int(time.time() * 1000) - last_attempt_ms >= COOLDOWN_MS


def mark_claim_attempt(
    state: Dict[str, Any],
    entry: Dict[str, Any],
    success: bool,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    key = claim_key(entry)
    record = state.setdefault("claims", {}).setdefault(key, {})
    record["lastClaimAttemptMs"] = int(time.time() * 1000)
    record["lastClaimAttemptAt"] = utc_now_iso()
    record["lastClaimSuccess"] = success
    record["asset"] = entry.get("asset")
    record["slug"] = entry.get("slug")
    record["title"] = entry.get("title")
    record["conditionId"] = entry.get("conditionId")
    record["outcome"] = entry.get("outcome")
    record["indexSets"] = entry.get("indexSets")
    if details:
        record["lastClaimDetails"] = details


def should_attempt_sell(state: Dict[str, Any], position: Dict[str, Any]) -> bool:
    key = asset_key(position)
    record = state.setdefault("assets", {}).get(key, {})
    last_attempt_ms = int(record.get("lastSellAttemptMs") or 0)
    return int(time.time() * 1000) - last_attempt_ms >= COOLDOWN_MS


def mark_sell_attempt(
    state: Dict[str, Any],
    position: Dict[str, Any],
    success: bool,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    key = asset_key(position)
    record = state.setdefault("assets", {}).setdefault(key, {})
    record["lastSellAttemptMs"] = int(time.time() * 1000)
    record["lastSellAttemptAt"] = utc_now_iso()
    record["lastSellSuccess"] = success
    record["slug"] = position.get("slug") or position.get("eventSlug")
    record["title"] = position.get("title")
    record["outcome"] = position.get("outcome")
    if details:
        record["lastSellDetails"] = details


def is_strategy_position(position: Dict[str, Any]) -> bool:
    slug = str(position.get("slug") or position.get("eventSlug") or "").lower()
    return bool(slug) and any(slug.startswith(prefix) for prefix in AUTO_SELL_SLUG_PREFIXES)


def round_to_six(value: float) -> float:
    return round(float(value), 6)


def summarize_position(position: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "asset": position.get("asset"),
        "slug": position.get("slug") or position.get("eventSlug"),
        "title": position.get("title"),
        "outcome": position.get("outcome"),
        "size": position.get("size"),
        "curPrice": position.get("curPrice"),
        "currentValue": position.get("currentValue"),
        "redeemable": position.get("redeemable"),
        "mergeable": position.get("mergeable"),
    }


def estimate_sell_candidate(trader, position: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not AUTO_SELL_ENABLED:
        return None
    if not is_strategy_position(position):
        return None

    token_id = asset_key(position)
    if not token_id:
        return None

    size = float(position.get("size") or 0)
    current_value = float(position.get("currentValue") or 0)
    current_price = float(position.get("curPrice") or 0)
    if size <= 0 or current_value < AUTO_SELL_MIN_POSITION_USD:
        return None

    implied_value_price = current_value / size if size else 0.0
    page_like_price = max(current_price, implied_value_price)
    if page_like_price * 100 < AUTO_SELL_TARGET_CENTS:
        return None

    try:
        book = trader.client.get_order_book(token_id)
        executable_price = float(
            trader.client.calculate_market_price(
                token_id,
                order_engine.SELL,
                size,
                order_engine.OrderType.FOK,
            )
        )
    except Exception:
        return None
    if executable_price * 100 < AUTO_SELL_TARGET_CENTS:
        return None

    market = order_engine.fetch_market_for_token(token_id) or {}
    top_bid = float(book.bids[-1].price) if getattr(book, "bids", None) else 0.0
    return {
        "position": position,
        "tokenId": token_id,
        "shares": size,
        "apiCurrentPrice": round_to_six(current_price),
        "impliedValuePrice": round_to_six(implied_value_price),
        "pageLikePrice": round_to_six(page_like_price),
        "currentValueUsd": round_to_six(current_value),
        "topBid": round_to_six(top_bid),
        "sellPrice": round_to_six(executable_price),
        "tickSize": str(book.tick_size),
        "negRisk": bool(market.get("negativeRisk")),
    }


def perform_auto_sell(state: Dict[str, Any], trader, funder: str, before_balance: Dict[str, Any]) -> Dict[str, Any]:
    positions = fetch_open_positions(funder)
    candidates: List[Dict[str, Any]] = []
    for position in positions:
        if not should_attempt_sell(state, position):
            continue
        candidate = estimate_sell_candidate(trader, position)
        if candidate:
            candidates.append(candidate)

    summary: Dict[str, Any] = {
        "enabled": AUTO_SELL_ENABLED,
        "targetCents": AUTO_SELL_TARGET_CENTS,
        "positionCount": len(positions),
        "candidateCount": len(candidates),
        "candidates": [
            {
                "slug": candidate["position"].get("slug") or candidate["position"].get("eventSlug"),
                "title": candidate["position"].get("title"),
                "outcome": candidate["position"].get("outcome"),
                "shares": candidate["shares"],
                "pageLikePrice": candidate["pageLikePrice"],
                "sellPrice": candidate["sellPrice"],
                "currentValueUsd": candidate["currentValueUsd"],
            }
            for candidate in candidates
        ],
        "sold": [],
        "afterBalanceUsd": before_balance["balanceUsd"],
    }

    if not AUTO_SELL_ENABLED or not candidates:
        return summary

    running_balance = before_balance["balanceUsd"]
    for candidate in sorted(candidates, key=lambda item: item["currentValueUsd"], reverse=True)[:MAX_SELLS_PER_RUN]:
        position = candidate["position"]
        response = trader.place_sell(
            candidate["tokenId"],
            candidate["shares"],
            candidate["sellPrice"],
            candidate["tickSize"],
            candidate["negRisk"],
        )
        time.sleep(max(1, AUTO_SELL_VERIFY_WAIT_MS / 1000))

        refreshed_positions = fetch_open_positions(funder)
        remaining = next(
            (item for item in refreshed_positions if asset_key(item) == candidate["tokenId"]),
            None,
        )
        refreshed_balance = get_balance_snapshot(trader)
        sold = bool(response.get("success")) and (
            refreshed_balance["balanceUsd"] > running_balance
            or remaining is None
            or float(remaining.get("size") or 0) < float(position.get("size") or 0)
        )
        sell_summary = {
            "slug": position.get("slug") or position.get("eventSlug"),
            "title": position.get("title"),
            "outcome": position.get("outcome"),
            "tokenId": candidate["tokenId"],
            "shares": candidate["shares"],
            "pageLikePrice": candidate["pageLikePrice"],
            "sellPrice": candidate["sellPrice"],
            "currentValueUsd": candidate["currentValueUsd"],
            "response": response,
            "sold": sold,
            "remainingSize": float(remaining.get("size") or 0) if remaining else 0.0,
            "balanceBeforeUsd": running_balance,
            "balanceAfterUsd": refreshed_balance["balanceUsd"],
            "realizedUsd": round_to_six(refreshed_balance["balanceUsd"] - running_balance),
        }
        summary["sold"].append(sell_summary)
        running_balance = refreshed_balance["balanceUsd"]
        mark_sell_attempt(state, position, sold, sell_summary)

    summary["afterBalanceUsd"] = running_balance
    return summary


def get_claim_disabled_reason() -> Optional[str]:
    if not AUTO_CLAIM_ENABLED:
        return "disabled-by-env"
    if not order_engine.claim_credentials_available():
        return "missing-builder-credentials"
    return None


def compact_claim_result(result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(result, dict):
        return None
    receipt = result.get("receipt")
    compact: Dict[str, Any] = {
        "condition_id": result.get("condition_id"),
        "transaction_id": result.get("transaction_id"),
        "transaction_hash": result.get("transaction_hash"),
        "dry_run": result.get("dry_run"),
        "source": result.get("source"),
        "mode": result.get("mode"),
        "gas_limit": result.get("gas_limit"),
        "proxy_wallet": result.get("proxy_wallet"),
    }
    if isinstance(receipt, dict):
        compact["receipt"] = receipt
    elif receipt is not None:
        compact["receipt"] = str(receipt)
    return compact


def execute_claim(
    state: Dict[str, Any],
    entry: Dict[str, Any],
    funder: Optional[str] = None,
    signature_type: Optional[int] = None,
) -> Dict[str, Any]:
    claim_summary: Dict[str, Any] = {
        "asset": entry.get("asset"),
        "conditionId": entry.get("conditionId"),
        "slug": entry.get("slug"),
        "title": entry.get("title"),
        "outcome": entry.get("outcome"),
        "indexSets": entry.get("indexSets"),
        "success": False,
        "error": None,
        "result": None,
    }
    try:
        result = order_engine.execute_redeem(
            entry["conditionId"],
            entry["indexSets"],
            funder=funder,
            signature_type=signature_type,
            negative_risk=bool(entry.get("negativeRisk")),
            outcome_index=entry.get("outcomeIndex"),
            size=entry.get("size"),
        )
        claim_summary["result"] = compact_claim_result(result)
        claim_summary["success"] = True
        mark_claim_attempt(state, entry, True, claim_summary)
    except Exception as exc:
        claim_summary["error"] = str(exc)
        quota_backoff = apply_claim_quota_backoff(state, claim_summary["error"])
        if quota_backoff is not None:
            claim_summary["quotaBackoff"] = quota_backoff
        mark_claim_attempt(state, entry, False, claim_summary)
    return claim_summary


def process_once(state: Dict[str, Any], trader=None) -> Dict[str, Any]:
    if trader is None:
        trader = order_engine.create_trader()
        trader.initialize()
    before_balance = get_balance_snapshot(trader)
    tracked_slugs = get_tracked_slugs()
    sell_summary = perform_auto_sell(state, trader, before_balance["funder"], before_balance)
    post_sell_balance = get_balance_snapshot(trader)
    entries = get_redeemable_entries(post_sell_balance["funder"], tracked_slugs)
    claim_disabled_reason = get_claim_disabled_reason()
    claim_work_enabled = bool(entries) and claim_disabled_reason is None

    summary: Dict[str, Any] = {
        "beforeBalanceUsd": before_balance["balanceUsd"],
        "funder": before_balance["funder"],
        "signatureType": before_balance.get("signatureType"),
        "autoSell": sell_summary,
        "redeemableCount": len(entries),
        "entries": [
            {
                "asset": entry.get("asset"),
                "conditionId": entry["conditionId"],
                "slug": entry["slug"],
                "outcome": entry.get("outcome"),
                "indexSets": entry["indexSets"],
                "currentValue": entry.get("currentValue"),
            }
            for entry in entries
        ],
        "claimApiOnly": True,
        "claimDisabled": claim_disabled_reason is not None,
        "claimDisabledReason": claim_disabled_reason,
        "afterBalanceUsd": post_sell_balance["balanceUsd"],
        "afterRedeemableCount": len(entries),
        "claimed": False,
        "claimedCount": 0,
        "claimErrorCount": 0,
        "claimError": None,
        "claimResult": None,
        "claimResults": [],
        "busy": bool(sell_summary.get("candidateCount") or claim_work_enabled),
        "trackedSlugCount": len(tracked_slugs),
        "trackedSlugSource": AUTO_REDEEM_TRACK_SOURCE,
        "claimBackoffActive": False,
        "claimBackoffUntilAt": None,
        "claimBackoffReason": None,
    }

    if not entries:
        return summary
    if claim_disabled_reason is not None:
        return summary
    active_backoff = get_claim_backoff(state)
    if active_backoff is not None:
        summary["claimBackoffActive"] = True
        summary["claimBackoffUntilAt"] = active_backoff.get("untilAt")
        summary["claimBackoffReason"] = active_backoff.get("reason")
        summary["busy"] = True
        return summary

    eligible_entries = [entry for entry in entries if should_attempt_claim(state, entry)]
    if not eligible_entries:
        summary["cooldownSkipped"] = True
        return summary

    limit = len(eligible_entries) if MAX_CLAIMS_PER_RUN <= 0 else MAX_CLAIMS_PER_RUN
    claim_results = []
    for entry in eligible_entries[:limit]:
        result = execute_claim(
            state,
            entry,
            funder=before_balance.get("funder"),
            signature_type=before_balance.get("signatureType"),
        )
        claim_results.append(result)
        if result.get("quotaBackoff"):
            summary["claimBackoffActive"] = True
            summary["claimBackoffUntilAt"] = result["quotaBackoff"].get("untilAt")
            summary["claimBackoffReason"] = result["quotaBackoff"].get("reason")
            break

    summary["claimResults"] = claim_results
    summary["claimResult"] = claim_results[0] if claim_results else None
    summary["claimedCount"] = sum(1 for row in claim_results if row.get("success"))
    summary["claimErrorCount"] = sum(1 for row in claim_results if row.get("error"))
    summary["claimed"] = summary["claimedCount"] > 0
    first_error = next((row.get("error") for row in claim_results if row.get("error")), None)
    summary["claimError"] = first_error
    if summary["claimed"]:
        time.sleep(max(1, AUTO_CLAIM_VERIFY_WAIT_MS / 1000))
        refreshed_balance = get_balance_snapshot(trader)
        refreshed_entries = get_redeemable_entries(refreshed_balance["funder"], tracked_slugs)
        summary["afterBalanceUsd"] = refreshed_balance["balanceUsd"]
        summary["afterRedeemableCount"] = len(refreshed_entries)
    if summary["claimErrorCount"] > 0:
        summary["busy"] = True
    return summary


def log_cycle_summary(summary: Dict[str, Any], next_interval_ms: int) -> None:
    auto_sell = summary.get("autoSell") if isinstance(summary.get("autoSell"), dict) else {}
    sold_rows = [row for row in (auto_sell.get("sold") or []) if row.get("sold")]
    if sold_rows:
        first_sell = sold_rows[0]
        order_engine.log(
            "Settlement sold "
            f"{first_sell.get('slug') or first_sell.get('title') or '--'} "
            f"{first_sell.get('outcome') or '--'} @ {first_sell.get('sellPrice')} "
            f"shares={first_sell.get('shares')} realized=${first_sell.get('realizedUsd')}"
        )
        return

    if summary.get("claimed"):
        claim_result = summary.get("claimResult") if isinstance(summary.get("claimResult"), dict) else {}
        result = claim_result.get("result") if isinstance(claim_result.get("result"), dict) else {}
        receipt = result.get("receipt") if isinstance(result.get("receipt"), dict) else {}
        receipt_state = str(receipt.get("state") or "").upper()
        tx_ref = result.get("transaction_hash") or result.get("transaction_id") or "submitted"
        claimed_count = int(summary.get("claimedCount") or 0)
        if receipt_state in {"STATE_MINED", "STATE_CONFIRMED"}:
            prefix = "Settlement claimed "
        else:
            prefix = "Settlement claim submitted "
        order_engine.log(
            prefix
            + f"{claimed_count} entries; first={claim_result.get('slug') or claim_result.get('title') or '--'} "
            f"condition={claim_result.get('conditionId') or '--'} "
            f"tx={tx_ref}"
        )
        return

    if summary.get("claimBackoffActive"):
        order_engine.log(
            "Settlement claim backoff until "
            f"{summary.get('claimBackoffUntilAt') or '--'} "
            f"{summary.get('claimBackoffReason') or '--'}"
        )
        return

    if summary.get("claimError"):
        claim_result = summary.get("claimResult") if isinstance(summary.get("claimResult"), dict) else {}
        order_engine.log(
            "Settlement claim error "
            f"{claim_result.get('slug') or claim_result.get('conditionId') or '--'} "
            f"{summary.get('claimError')}"
        )
        return

    order_engine.log(
        "Settlement scan | "
        f"source={summary.get('trackedSlugSource') or '--'} "
        f"tracked={summary.get('trackedSlugCount', 0)} "
        f"candidates={auto_sell.get('candidateCount', 0)} "
        f"redeemable={summary.get('redeemableCount', 0)} "
        f"next={int(next_interval_ms / 60000)}m"
    )


def should_log_cycle(summary: Dict[str, Any]) -> bool:
    auto_sell = summary.get("autoSell") if isinstance(summary.get("autoSell"), dict) else {}
    sold_rows = auto_sell.get("sold") or []
    if any(bool(row.get("sold")) for row in sold_rows):
        return True
    return bool(
        summary.get("claimed")
        or summary.get("claimError")
        or summary.get("claimBackoffActive")
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Polymarket auto settle worker")
    parser.add_argument("--once", action="store_true", help="Process one settle cycle and exit")
    args = parser.parse_args()

    ensure_dir(DATA_DIR)
    state = load_state()
    trader = None
    claim_disabled_reason = get_claim_disabled_reason()
    claim_mode = "api" if claim_disabled_reason is None else f"off({claim_disabled_reason})"
    if args.once:
        trader = order_engine.create_trader()
        trader.initialize()
        summary = process_once(state, trader)
        next_interval_ms = (
            order_engine.ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS
            if summary.get("busy")
            else order_engine.ORDER_SETTLEMENT_IDLE_INTERVAL_MS
        )
        log_cycle_summary(summary, next_interval_ms)
        if should_log_cycle(summary):
            append_log({"type": "cycle", **compact_cycle_summary(summary)})
        save_state(state)
        print(json.dumps(summary, ensure_ascii=False))
        return

    order_engine.log(
        "Settlement worker ready | "
        f"idle={int(order_engine.ORDER_SETTLEMENT_IDLE_INTERVAL_MS / 60000)}m "
        f"active={int(order_engine.ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS / 60000)}m "
        f"sell={'on' if AUTO_SELL_ENABLED else 'off'} "
        f"target={AUTO_SELL_TARGET_CENTS}c "
        f"claim={claim_mode} "
        f"trackSource={AUTO_REDEEM_TRACK_SOURCE} "
        f"maxSell={MAX_SELLS_PER_RUN}"
    )

    while True:
        try:
            if trader is None:
                trader = order_engine.create_trader()
                trader.initialize()
            summary = process_once(state, trader)
            if should_log_cycle(summary):
                append_log({"type": "cycle", **compact_cycle_summary(summary)})
            save_state(state)
            next_interval_ms = (
                order_engine.ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS
                if summary.get("busy")
                else order_engine.ORDER_SETTLEMENT_IDLE_INTERVAL_MS
            )
            log_cycle_summary(summary, next_interval_ms)
        except Exception as exc:
            trader = None
            append_log({"type": "error", "message": str(exc)})
            order_engine.log(f"Settlement error: {exc}")
            next_interval_ms = order_engine.ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS
        time.sleep(max(1, next_interval_ms / 1000))


if __name__ == "__main__":
    main()
