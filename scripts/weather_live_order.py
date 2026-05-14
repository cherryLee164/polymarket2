import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data" / "weather_predictions"
WEATHER_RECORDS_PATH = DATA_DIR / "records.json"
LIVE_ORDERS_PATH = DATA_DIR / "live-orders.json"
WEATHER_CONFIG_PATH = DATA_DIR / "config.json"
TZ = ZoneInfo("Asia/Shanghai")
STRATEGY_ID = "weather-live-125"
OFFSET_OPTIONS = {-1, 0, 1}


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except Exception:
        return default


CAPTURE_SLOT_ID = os.getenv("WEATHER_LIVE_CAPTURE_SLOT_ID", "00")
CAPTURE_SLOT_LABEL = os.getenv("WEATHER_LIVE_CAPTURE_SLOT_LABEL", "00:10")
MAX_PRICE_CAP = env_float("WEATHER_LIVE_MAX_PRICE_CAP", 0.95)
MAX_NO_PRICE = env_float("WEATHER_LIVE_MAX_NO_PRICE", 0.95)
HIGH_PRICE_SKIP_REASON = f"no-price-above-{MAX_NO_PRICE:.2f}"
USE_MAX_PRICE_CAP = str(os.getenv("WEATHER_LIVE_USE_MAX_PRICE_CAP", "true")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
POSITION_CONFIRM_WAIT_SECONDS = float(os.getenv("WEATHER_LIVE_CONFIRM_WAIT_SECONDS", "1.5"))
MAX_ORDER_ATTEMPTS = max(1, int(os.getenv("WEATHER_LIVE_MAX_ORDER_ATTEMPTS", "288")))
ORDER_RETRY_AFTER_SECONDS = float(os.getenv("WEATHER_LIVE_RETRY_AFTER_SECONDS", "300"))
ORDER_RETRY_WAIT_SECONDS = float(os.getenv("WEATHER_LIVE_ORDER_RETRY_WAIT_SECONDS", "3"))
MIN_SUCCESS_SHARES = float(os.getenv("WEATHER_LIVE_MIN_SUCCESS_SHARES", "0.000001"))
RETRY_FAILED_ORDERS = str(os.getenv("WEATHER_LIVE_RETRY_FAILED_ORDERS", "true")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
RETRYABLE_FAILED_ERROR_MARKERS = (
    "order_version_mismatch",
    "collateral balance",
    "request exception",
    "500 server error",
    "internal server error",
    "server error",
    "service not ready",
    "timeout",
    "connection",
    "temporarily",
)


if "--dry-run" in sys.argv:
    os.environ["ORDER_DRY_RUN"] = "true"

# Weather orders should behave like the web UI's direct buy: take whatever can be
# filled immediately instead of requiring the whole $1 to fill atomically.
os.environ.setdefault("ORDER_EXECUTION_TYPE", "FAK")

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import order as order_engine  # noqa: E402


def now_iso() -> str:
    return datetime.now(TZ).isoformat()


def today_ymd() -> str:
    return os.getenv("WEATHER_LIVE_DATE") or datetime.now(TZ).date().isoformat()


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_base_stake(value: Any) -> int:
    try:
        numeric = int(float(value))
    except Exception:
        return 1
    return numeric if numeric in {1, 2, 3, 4, 5} else 1


# 旧序列: (1, 2, 2, 2, 3) — 递进翻倍模式，已暂停使用
def build_stake_sequence(base_stake: Any) -> List[float]:
    base = normalize_base_stake(base_stake)
    return [float(base * multiplier) for multiplier in (1, 1, 1, 1, 1)]


def normalize_multipliers(value: Any) -> List[float]:
    if isinstance(value, list):
        raw = value
    else:
        raw = str(value or "").replace(",", "-").split("-")
    multipliers: List[float] = []
    for item in raw:
        numeric = as_float(item)
        if numeric > 0 and numeric <= 20:
            multipliers.append(float(numeric))
    # 旧默认: [1.0, 2.0, 2.0, 2.0, 3.0] — 递进翻倍模式，已暂停使用
    return multipliers[:8] if multipliers else [1.0, 1.0, 1.0, 1.0, 1.0]


def build_stake_sequence_from_parts(base_stake: Any, multipliers: Any) -> List[float]:
    base = normalize_base_stake(base_stake)
    return [float(base * multiplier) for multiplier in normalize_multipliers(multipliers)]


def format_stake_sequence(sequence: List[float]) -> str:
    parts = []
    for item in sequence:
        numeric = float(item)
        parts.append(str(int(numeric)) if numeric.is_integer() else str(numeric))
    return "-".join(parts)


def read_live_stake_settings() -> Dict[str, Any]:
    raw_sequence = str(os.getenv("WEATHER_LIVE_STAKE_SEQUENCE", "")).strip()
    if raw_sequence:
        parsed = []
        for item in raw_sequence.split(","):
            item = item.strip()
            if not item:
                continue
            try:
                parsed.append(float(item))
            except Exception:
                continue
        # 旧默认: [1.0, 2.0, 2.0, 2.0, 3.0] — 递进翻倍模式，已暂停使用
        sequence = parsed or [1.0, 1.0, 1.0, 1.0, 1.0]
        base = normalize_base_stake(sequence[0] if sequence else 1)
    else:
        config = read_json(WEATHER_CONFIG_PATH, {})
        base = normalize_base_stake(config.get("liveBaseStake"))
        sequence = build_stake_sequence(base)

    return {
        "base": base,
        "sequence": sequence,
        "label": format_stake_sequence(sequence),
    }


def normalize_offsets(value: Any) -> List[int]:
    raw = value if isinstance(value, list) else [0]
    normalized: List[int] = []
    for item in raw:
        try:
            numeric = int(float(item))
        except Exception:
            continue
        if numeric in OFFSET_OPTIONS and numeric not in normalized:
            normalized.append(numeric)
    return sorted(normalized) if normalized else [0]


def read_live_strategy_config() -> Dict[str, Any]:
    config = read_json(WEATHER_CONFIG_PATH, {})
    mode = str(config.get("executionMode") or "live").strip().lower()
    if mode not in {"simulation", "live"}:
        mode = "live"
    raw_strategies = config.get("offsetStrategies") if isinstance(config.get("offsetStrategies"), dict) else {}
    enabled_offsets = normalize_offsets(config.get("temperatureOffsets"))
    offset_strategies: Dict[int, Dict[str, Any]] = {}
    for offset in sorted(OFFSET_OPTIONS):
        raw = raw_strategies.get(str(offset)) or {}
        enabled = bool(raw.get("enabled", offset in enabled_offsets))
        base = normalize_base_stake(raw.get("baseStake", config.get("liveBaseStake")))
        multipliers = normalize_multipliers(raw.get("multipliers", config.get("stakeMultipliers")))
        sequence = build_stake_sequence_from_parts(base, multipliers)
        offset_strategies[offset] = {
            "offset": offset,
            "enabled": enabled,
            "base": base,
            "multipliers": multipliers,
            "sequence": sequence,
            "label": format_stake_sequence(sequence),
        }
    if not any(item["enabled"] for item in offset_strategies.values()):
        offset_strategies[0]["enabled"] = True
    return {
        "executionMode": mode,
        "temperatureOffsets": [offset for offset, item in offset_strategies.items() if item["enabled"]],
        "offsetStrategies": offset_strategies,
    }


def round_money(value: Any, digits: int = 6) -> Optional[float]:
    try:
        numeric = float(value)
    except Exception:
        return None
    return round(numeric, digits)


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric


LIVE_STAKE_SETTINGS = read_live_stake_settings()
LIVE_STRATEGY_CONFIG = read_live_strategy_config()
CONFIGURED_BASE_STAKE_USD = float(LIVE_STAKE_SETTINGS.get("base") or 1)
STAKE_SEQUENCE = LIVE_STAKE_SETTINGS["sequence"]
BASE_STAKE_USD = STAKE_SEQUENCE[0] if STAKE_SEQUENCE else 1.0
STRATEGY_LABEL = f"天气实盘同城 {LIVE_STAKE_SETTINGS['label']}"

def get_offset_stake_settings(temperature_offset: Any) -> Dict[str, Any]:
    offset = normalize_offset(temperature_offset)
    return LIVE_STRATEGY_CONFIG["offsetStrategies"].get(offset) or LIVE_STRATEGY_CONFIG["offsetStrategies"][0]


def parse_iso_datetime(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ)


def order_key(record: Dict[str, Any]) -> str:
    return ":".join(
        [
            str(record.get("date")),
            STRATEGY_ID,
            str(record.get("captureSlotId") or CAPTURE_SLOT_ID),
            str(record.get("citySlug")),
            str(record.get("marketSlug")),
        ]
    )


def normalize_offset(value: Any) -> int:
    try:
        numeric = int(float(value))
    except Exception:
        return 0
    return numeric if numeric in OFFSET_OPTIONS else 0


def expand_weather_candidates(records: List[Dict[str, Any]], target_date: str) -> List[Dict[str, Any]]:
    enabled_offsets = set(LIVE_STRATEGY_CONFIG["temperatureOffsets"])
    expanded: List[Dict[str, Any]] = []
    for item in records:
        if (
            item.get("date") != target_date
            or item.get("captureSlotId") != CAPTURE_SLOT_ID
            or not item.get("eventSlug")
            or str(item.get("status") or "").lower() == "resolved"
        ):
            continue
        candidate_markets = item.get("candidateMarkets")
        if isinstance(candidate_markets, list) and candidate_markets:
            for candidate in candidate_markets:
                if not isinstance(candidate, dict):
                    continue
                offset = normalize_offset(candidate.get("temperatureOffsetC"))
                if offset not in enabled_offsets:
                    continue
                no_price = as_float(candidate.get("buyNoPrice"))
                if not candidate.get("marketSlug") or no_price <= 0 or no_price >= 1 or no_price > MAX_NO_PRICE:
                    continue
                source = dict(item)
                source.update(
                    {
                        "temperatureOffsetC": offset,
                        "targetTempC": candidate.get("targetTempC", item.get("targetTempC")),
                        "marketSlug": candidate.get("marketSlug"),
                        "marketTitle": candidate.get("marketTitle"),
                        "marketQuestion": candidate.get("marketQuestion"),
                        "marketSelectionMode": candidate.get("marketSelectionMode"),
                        "marketBucketKind": candidate.get("marketBucketKind"),
                        "marketBucketValue": candidate.get("marketBucketValue"),
                        "buyNoPrice": candidate.get("buyNoPrice"),
                        "sharesBought": candidate.get("sharesBought"),
                        "marketClosed": candidate.get("marketClosed"),
                    }
                )
                source["key"] = order_key(source)
                expanded.append(source)
            continue

        offset = normalize_offset(item.get("temperatureOffsetC"))
        if offset in enabled_offsets and item.get("marketSlug") and as_float(item.get("buyNoPrice")) <= MAX_NO_PRICE:
            source = dict(item)
            source["temperatureOffsetC"] = offset
            source["key"] = order_key(source)
            expanded.append(source)
    return expanded


def is_active_order(record: Dict[str, Any]) -> bool:
    status = str(record.get("status") or "").lower()
    return status not in {"failed", "skipped", "cancelled", "canceled", "no-fill"}


def order_attempt_count(record: Dict[str, Any]) -> int:
    attempts = record.get("orderAttempts")
    if isinstance(attempts, list) and attempts:
        return len(attempts)
    return 1 if record.get("orderId") else 0


def has_submitted_order(record: Dict[str, Any]) -> bool:
    if record.get("orderId"):
        return True
    order_ids = record.get("orderIds")
    if isinstance(order_ids, list) and any(order_ids):
        return True
    attempts = record.get("orderAttempts")
    if not isinstance(attempts, list):
        return False
    for attempt in attempts:
        if not isinstance(attempt, dict):
            continue
        response = attempt.get("response")
        if not isinstance(response, dict):
            response = {}
        if (
            attempt.get("orderId")
            or response.get("orderID")
            or response.get("orderId")
            or response.get("success") is True
        ):
            return True
    return False


def last_attempt_at(record: Dict[str, Any]) -> Optional[datetime]:
    attempts = record.get("orderAttempts")
    if isinstance(attempts, list) and attempts:
        last_attempt = attempts[-1] if isinstance(attempts[-1], dict) else {}
        parsed = parse_iso_datetime(last_attempt.get("attemptedAt"))
        if parsed:
            return parsed
    for key in ("lastAttemptAt", "failedAt", "placedAt"):
        parsed = parse_iso_datetime(record.get(key))
        if parsed:
            return parsed
    return None


def has_confirmed_fill(record: Dict[str, Any]) -> bool:
    fill_status = str(record.get("fillStatus") or "").lower()
    if fill_status in {
        "submitted-unconfirmed",
        "no-position-after-attempt",
        "no-position-after-retries",
        "missing-order-id",
        "no-bot-order-fill",
    }:
        return False

    actual_cost = as_float(record.get("actualBuyCostUsd"))
    actual_shares = as_float(record.get("actualBuyShares"))
    if actual_cost > 0 and actual_shares > MIN_SUCCESS_SHARES:
        return True

    cost = max(as_float(record.get("spentUsd")), as_float(record.get("stakeUsd")))
    shares = as_float(record.get("sharesBought"))
    return fill_status == "position-detected" and cost > 0 and shares > MIN_SUCCESS_SHARES


def is_high_price_blocked(record: Dict[str, Any]) -> bool:
    return (
        str(record.get("fillStatus") or "").lower() == "price-above-limit"
        or str(record.get("skipReason") or "") == HIGH_PRICE_SKIP_REASON
    )


def is_retryable_unconfirmed_order(record: Dict[str, Any]) -> bool:
    if is_high_price_blocked(record):
        return False
    status = str(record.get("status") or "").lower()
    if status == "failed":
        if not RETRY_FAILED_ORDERS:
            return False
        error_text = str(record.get("error") or "").lower()
        if not any(marker in error_text for marker in RETRYABLE_FAILED_ERROR_MARKERS):
            return False
    elif status not in {"pending", "placing", "no-fill"}:
        return False
    if has_confirmed_fill(record):
        return False
    if has_submitted_order(record):
        return False
    if order_attempt_count(record) >= MAX_ORDER_ATTEMPTS:
        return False
    attempted_at = last_attempt_at(record)
    if not attempted_at:
        return True
    return (datetime.now(TZ) - attempted_at).total_seconds() >= ORDER_RETRY_AFTER_SECONDS


def upsert_live_order(live_orders: List[Dict[str, Any]], record: Dict[str, Any]) -> None:
    key = record.get("key")
    for index, existing in enumerate(live_orders):
        if existing.get("key") == key:
            live_orders[index] = record
            return
    live_orders.append(record)


def accounting_stake_usd(record: Dict[str, Any]) -> float:
    for key in ("actualBuyCostUsd", "stakeUsd", "requestedStakeUsd"):
        value = as_float(record.get(key))
        if value > 0:
            return value
    return 0.0


def estimated_no_win_pnl_usd(record: Dict[str, Any]) -> Optional[float]:
    actual_cost = as_float(record.get("actualBuyCostUsd"))
    actual_shares = as_float(record.get("actualBuyShares"))
    if actual_cost > 0 and actual_shares > MIN_SUCCESS_SHARES:
        return round_money(actual_shares - actual_cost, 6)
    existing = record.get("estimatedNoWinPnlUsd")
    if existing not in (None, ""):
        return round_money(existing, 6)
    stake = accounting_stake_usd(record)
    price = as_float(record.get("buyNoPrice"))
    if stake <= 0 or price <= 0:
        return None
    return round_money(stake / price - stake, 6)


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
        return round_money(-stake, 6) if stake > 0 else None
    existing = record.get("accountingPnlUsd")
    if existing not in (None, ""):
        return round_money(existing, 6)
    return None


def compute_city_progression(
    city_slug: str,
    live_orders: List[Dict[str, Any]],
    target_date: str,
    temperature_offset: int = 0,
) -> Dict[str, Any]:
    city_rows = [
        item
        for item in live_orders
        if item.get("citySlug") == city_slug
        and normalize_offset(item.get("temperatureOffsetC")) == temperature_offset
        and is_active_order(item)
        and str(item.get("date")) < target_date
    ]
    by_date: Dict[str, List[Dict[str, Any]]] = {}
    for row in city_rows:
        by_date.setdefault(str(row.get("date")), []).append(row)

    sequence = get_offset_stake_settings(temperature_offset)["sequence"]
    cycle_pnl = 0.0
    step_index = 0
    for date_key in sorted(by_date):
        day_rows = by_date[date_key]
        if any(row.get("status") != "resolved" for row in day_rows):
            continue
        day_pnl = sum(accounting_pnl_usd(row) or 0.0 for row in day_rows)
        if day_pnl > 0:
            cycle_pnl = 0.0
            step_index = 0
        elif sequence:
            cycle_pnl += day_pnl
            step_index = min(step_index + 1, len(sequence) - 1)

    return {
        "stepIndex": step_index,
        "lossStreakBefore": step_index,
        "cyclePnlBefore": round_money(cycle_pnl, 6) or 0,
    }


def normalize_sequence(sequence: Any) -> List[float]:
    if not isinstance(sequence, list):
        return [BASE_STAKE_USD]
    normalized = []
    for item in sequence:
        numeric = as_float(item)
        if numeric > 0:
            normalized.append(float(numeric))
    return normalized or [BASE_STAKE_USD]


def compute_city_stake(
    city_slug: str,
    live_orders: List[Dict[str, Any]],
    target_date: str,
    temperature_offset: int = 0,
    stake_plan: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    progression = compute_city_progression(city_slug, live_orders, target_date, temperature_offset)
    offset_settings = get_offset_stake_settings(temperature_offset)
    planned_sequences = (stake_plan or {}).get("sequencesByOffset") or {}
    sequence = normalize_sequence(planned_sequences.get(str(temperature_offset)) or offset_settings["sequence"])
    step_index = min(int(progression["stepIndex"]), len(sequence) - 1)
    stake_usd = sequence[step_index]
    context = stake_plan or {}
    return {
        "stakeUsd": round_money(stake_usd, 6),
        "stepIndex": step_index,
        "lossStreakBefore": progression["lossStreakBefore"],
        "cyclePnlBefore": progression["cyclePnlBefore"],
        "configuredBaseStakeUsd": offset_settings["base"],
        "effectiveBaseStakeUsd": sequence[0] if sequence else offset_settings["base"],
        "configuredStakeSequenceLabel": offset_settings["label"],
        "effectiveStakeSequenceLabel": context.get("effectiveSequenceLabel", format_stake_sequence(sequence)),
        "plannedStakeTotalUsd": context.get("requiredStakeUsd"),
        "availableBalanceUsd": context.get("balanceUsd"),
        "stakeDowngradedByBalance": bool(context.get("downgraded")),
        "stakeDowngradeReason": context.get("downgradeReason"),
    }


def build_balance_aware_stake_plan(
    candidates: List[Dict[str, Any]],
    live_orders: List[Dict[str, Any]],
    existing_by_key: Dict[str, Dict[str, Any]],
    target_date: str,
    balance_usd: float,
) -> Dict[str, Any]:
    planned_entries = []
    for source in candidates:
        existing_record = existing_by_key.get(order_key(source))
        if existing_record and has_confirmed_fill(existing_record):
            continue
        if existing_record and not is_retryable_unconfirmed_order(existing_record):
            continue
        progression = compute_city_progression(
            str(source.get("citySlug")),
            live_orders,
            target_date,
            normalize_offset(source.get("temperatureOffsetC")),
        )
        offset = normalize_offset(source.get("temperatureOffsetC"))
        sequence = get_offset_stake_settings(offset)["sequence"]
        planned_entries.append(
            {
                "offset": offset,
                "stepIndex": int(progression["stepIndex"]),
                "stakeUsd": sequence[min(int(progression["stepIndex"]), len(sequence) - 1)],
            }
        )

    required_stake = round(sum(entry["stakeUsd"] for entry in planned_entries), 6)
    downgraded = False
    sequences_by_offset = {
        str(offset): get_offset_stake_settings(offset)["sequence"]
        for offset in sorted(OFFSET_OPTIONS)
    }
    return {
        "configuredBaseStakeUsd": None,
        "effectiveBaseStakeUsd": None,
        "configuredSequence": None,
        "sequence": None,
        "sequencesByOffset": sequences_by_offset,
        "configuredSequenceLabel": "per-offset",
        "effectiveSequenceLabel": "per-offset",
        "balanceUsd": round_money(balance_usd, 6) if balance_usd != float("inf") else None,
        "baseOneRequiredStakeUsd": required_stake,
        "requiredStakeUsd": required_stake,
        "plannedOrderCount": len(planned_entries),
        "downgraded": downgraded,
        "downgradeReason": None,
    }


def select_no_token(market: Dict[str, Any]) -> Dict[str, Any]:
    outcomes = order_engine.parse_json_array(market.get("outcomes"))
    token_ids = order_engine.parse_json_array(market.get("clobTokenIds"))
    prices = order_engine.parse_json_array(market.get("outcomePrices"))
    no_index = next(
        (idx for idx, outcome in enumerate(outcomes) if str(outcome).strip().lower() == "no"),
        -1,
    )
    if no_index < 0 or no_index >= len(token_ids):
        raise RuntimeError("market has no No token")
    no_price = None
    if no_index < len(prices):
        no_price = round_money(prices[no_index], 6)
    return {
        "tokenId": str(token_ids[no_index]),
        "currentNoPrice": no_price,
    }


def find_market(event: Dict[str, Any], market_slug: str) -> Dict[str, Any]:
    for market in event.get("markets") or []:
        if market.get("slug") == market_slug:
            return market
    raise RuntimeError(f"market not found: {market_slug}")


def response_order_id(response: Any) -> Optional[str]:
    if isinstance(response, dict):
        for key in ("orderID", "orderId", "id"):
            if response.get(key):
                return str(response[key])
    return None


def has_any_order_id(record: Dict[str, Any]) -> bool:
    if record.get("orderId"):
        return True
    return any(bool(item) for item in (record.get("orderIds") or []))


def to_jsonable(value: Any):
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


def build_live_record(
    source: Dict[str, Any],
    stake: Dict[str, Any],
    token_id: str,
    current_no_price: Optional[float],
    price_cap: float,
    baseline_position: float,
) -> Dict[str, Any]:
    placed_at = now_iso()
    record = {
        "key": order_key(source),
        "strategyId": STRATEGY_ID,
        "strategyLabel": STRATEGY_LABEL,
        "date": source.get("date"),
        "captureSlotId": source.get("captureSlotId") or CAPTURE_SLOT_ID,
        "captureSlotLabel": source.get("captureSlotLabel") or CAPTURE_SLOT_LABEL,
        "captureSlotHour": source.get("captureSlotHour", 0),
        "captureSlotMinute": source.get("captureSlotMinute", 10),
        "citySlug": source.get("citySlug"),
        "cityZh": source.get("cityZh"),
        "cityEn": source.get("cityEn"),
        "forecastTarget": source.get("forecastTarget"),
        "forecastMinTempC": source.get("forecastMinTempC"),
        "forecastMaxTempC": source.get("forecastMaxTempC"),
        "targetTempC": source.get("targetTempC"),
        "temperatureOffsetC": normalize_offset(source.get("temperatureOffsetC")),
        "dayWeather": source.get("dayWeather"),
        "nightWeather": source.get("nightWeather"),
        "eventSlug": source.get("eventSlug"),
        "eventUrl": source.get("eventUrl"),
        "marketSlug": source.get("marketSlug"),
        "marketTitle": source.get("marketTitle"),
        "marketQuestion": source.get("marketQuestion"),
        "marketSelectionMode": source.get("marketSelectionMode"),
        "marketBucketKind": source.get("marketBucketKind"),
        "marketBucketValue": source.get("marketBucketValue"),
        "capturedAt": source.get("capturedAt"),
        "placedAt": placed_at,
        "tokenId": token_id,
        "buyNoPrice": current_no_price or source.get("buyNoPrice"),
        "recordedBuyNoPrice": source.get("buyNoPrice"),
        "priceCap": price_cap,
        "stakeUsd": stake["stakeUsd"],
        "requestedStakeUsd": stake["stakeUsd"],
        "estimatedShares": round_money(float(stake["stakeUsd"]) / float(current_no_price), 6)
        if current_no_price
        else None,
        "estimatedNoWinPayoutUsd": round_money(float(stake["stakeUsd"]) / float(current_no_price), 6)
        if current_no_price
        else None,
        "estimatedNoWinPnlUsd": round_money(
            float(stake["stakeUsd"]) / float(current_no_price) - float(stake["stakeUsd"]),
            6,
        )
        if current_no_price
        else None,
        "progressiveStepIndex": stake["stepIndex"],
        "progressiveLossStreakBefore": stake["lossStreakBefore"],
        "progressiveCyclePnlBefore": stake.get("cyclePnlBefore"),
        "configuredBaseStakeUsd": stake.get("configuredBaseStakeUsd"),
        "effectiveBaseStakeUsd": stake.get("effectiveBaseStakeUsd"),
        "configuredStakeSequenceLabel": stake.get("configuredStakeSequenceLabel"),
        "effectiveStakeSequenceLabel": stake.get("effectiveStakeSequenceLabel"),
        "plannedStakeTotalUsd": stake.get("plannedStakeTotalUsd"),
        "availableBalanceUsd": stake.get("availableBalanceUsd"),
        "stakeDowngradedByBalance": stake.get("stakeDowngradedByBalance"),
        "stakeDowngradeReason": stake.get("stakeDowngradeReason"),
        "status": "placing",
        "result": "待结算",
        "payoutUsd": None,
        "pnlUsd": None,
        "baselinePosition": round_money(baseline_position, 6),
    }
    record["key"] = order_key(record)
    return record


def build_high_price_skip_record(
    source: Dict[str, Any],
    existing_record: Optional[Dict[str, Any]],
    stake: Dict[str, Any],
    token_id: str,
    current_no_price: float,
    price_cap: float,
) -> Dict[str, Any]:
    record = dict(existing_record) if existing_record else build_live_record(
        source,
        stake,
        token_id,
        current_no_price,
        price_cap,
        0.0,
    )
    has_submitted_order = has_any_order_id(record)
    record.update(
        {
            "strategyLabel": STRATEGY_LABEL,
            "tokenId": token_id,
            "buyNoPrice": current_no_price,
            "recordedBuyNoPrice": source.get("buyNoPrice"),
            "priceCap": price_cap,
            "temperatureOffsetC": normalize_offset(source.get("temperatureOffsetC")),
            "targetTempC": source.get("targetTempC"),
            "marketSelectionMode": source.get("marketSelectionMode"),
            "marketBucketKind": source.get("marketBucketKind"),
            "marketBucketValue": source.get("marketBucketValue"),
            "requestedStakeUsd": stake["stakeUsd"],
            "estimatedShares": round_money(float(stake["stakeUsd"]) / float(current_no_price), 6),
            "estimatedNoWinPayoutUsd": round_money(float(stake["stakeUsd"]) / float(current_no_price), 6),
            "estimatedNoWinPnlUsd": round_money(
                float(stake["stakeUsd"]) / float(current_no_price) - float(stake["stakeUsd"]),
                6,
            ),
            "progressiveStepIndex": stake["stepIndex"],
            "progressiveLossStreakBefore": stake["lossStreakBefore"],
            "progressiveCyclePnlBefore": stake.get("cyclePnlBefore"),
            "configuredBaseStakeUsd": stake.get("configuredBaseStakeUsd"),
            "effectiveBaseStakeUsd": stake.get("effectiveBaseStakeUsd"),
            "configuredStakeSequenceLabel": stake.get("configuredStakeSequenceLabel"),
            "effectiveStakeSequenceLabel": stake.get("effectiveStakeSequenceLabel"),
            "plannedStakeTotalUsd": stake.get("plannedStakeTotalUsd"),
            "availableBalanceUsd": stake.get("availableBalanceUsd"),
            "stakeDowngradedByBalance": stake.get("stakeDowngradedByBalance"),
            "stakeDowngradeReason": stake.get("stakeDowngradeReason"),
            "fillStatus": "price-above-limit",
            "skipReason": HIGH_PRICE_SKIP_REASON,
            "skipLimitNoPrice": MAX_NO_PRICE,
            "skippedAt": now_iso(),
            "result": "price-above-limit",
        }
    )
    if has_submitted_order:
        record["status"] = "pending"
    else:
        record.update(
            {
                "status": "skipped",
                "stakeUsd": 0,
                "spentUsd": 0,
                "sharesBought": 0,
            }
        )
    record["key"] = order_key(record)
    return record


def main() -> int:
    target_date = today_ymd()
    if LIVE_STRATEGY_CONFIG["executionMode"] != "live":
        print(
            "Weather live order disabled by config "
            f"mode={LIVE_STRATEGY_CONFIG['executionMode']} offsets={LIVE_STRATEGY_CONFIG['temperatureOffsets']}"
        )
        return 0
    weather_records = read_json(WEATHER_RECORDS_PATH, [])
    live_orders = read_json(LIVE_ORDERS_PATH, [])
    if not isinstance(weather_records, list):
        raise RuntimeError("weather records file is not a list")
    if not isinstance(live_orders, list):
        live_orders = []

    candidates = expand_weather_candidates(weather_records, target_date)
    candidates.sort(
        key=lambda item: (
            str(item.get("cityZh") or item.get("citySlug") or ""),
            normalize_offset(item.get("temperatureOffsetC")),
        )
    )
    if not candidates:
        print(f"No weather candidates for {target_date} slot={CAPTURE_SLOT_ID}")
        return 1

    existing_by_key = {
        item.get("key"): item
        for item in live_orders
        if item.get("date") == target_date and item.get("key")
    }

    trader = order_engine.create_trader()
    trader.initialize()
    balance_status = trader.get_balance_status()
    balance_usd = float(balance_status.get("balance") or 0.0)
    stake_plan = build_balance_aware_stake_plan(candidates, live_orders, existing_by_key, target_date, balance_usd)
    print(
        "STAKE_PLAN "
        f"date={target_date} configured=per-offset "
        f"effective=per-offset "
        f"orders={stake_plan['plannedOrderCount']} "
        f"base1_required=${stake_plan['baseOneRequiredStakeUsd']:.3f} "
        f"required=${stake_plan['requiredStakeUsd']:.3f} "
        f"balance=${balance_usd:.3f}"
    )
    results = []

    for source in candidates:
        key = order_key(source)
        city = source.get("cityZh") or source.get("citySlug")
        existing_record = existing_by_key.get(key)
        if existing_record and has_confirmed_fill(existing_record):
            print(f"SKIP filled {city} {source.get('marketTitle')}")
            results.append({"city": city, "status": "skipped-existing"})
            continue
        if existing_record and not is_retryable_unconfirmed_order(existing_record):
            attempts = order_attempt_count(existing_record)
            print(
                f"SKIP waiting {city} {source.get('marketTitle')} "
                f"attempts={attempts}/{MAX_ORDER_ATTEMPTS}"
            )
            results.append({"city": city, "status": "skipped-existing"})
            continue

        live_record = None
        try:
            stake = compute_city_stake(
                str(source.get("citySlug")),
                live_orders,
                target_date,
                normalize_offset(source.get("temperatureOffsetC")),
                stake_plan,
            )
            event = order_engine.fetch_event(str(source.get("eventSlug")))
            if not event:
                raise RuntimeError(f"event not found: {source.get('eventSlug')}")
            market = find_market(event, str(source.get("marketSlug")))
            token = select_no_token(market)
            current_no_price = token["currentNoPrice"] or round_money(source.get("buyNoPrice"), 6)
            if not current_no_price or current_no_price <= 0:
                raise RuntimeError("missing No price")
            if USE_MAX_PRICE_CAP:
                price_cap = MAX_PRICE_CAP
            else:
                price_cap = min(MAX_PRICE_CAP, max(float(current_no_price), float(source.get("buyNoPrice") or 0)))
            if price_cap <= 0:
                raise RuntimeError("invalid price cap")
            if float(current_no_price) > MAX_NO_PRICE:
                live_record = build_high_price_skip_record(
                    source,
                    existing_record,
                    stake,
                    token["tokenId"],
                    float(current_no_price),
                    price_cap,
                )
                upsert_live_order(live_orders, live_record)
                write_json(LIVE_ORDERS_PATH, live_orders)
                print(
                    f"SKIP high-price {city} No current={float(current_no_price):.3f} "
                    f"limit={MAX_NO_PRICE:.3f}"
                )
                results.append({"city": city, "status": "skipped-price"})
                continue

            baseline = float(trader.get_position_size(token["tokenId"]) or 0.0)
            if existing_record:
                live_record = dict(existing_record)
                live_record.update(
                    {
                        "strategyLabel": STRATEGY_LABEL,
                        "tokenId": token["tokenId"],
                        "buyNoPrice": current_no_price or source.get("buyNoPrice"),
                        "recordedBuyNoPrice": source.get("buyNoPrice"),
                        "priceCap": price_cap,
                        "temperatureOffsetC": normalize_offset(source.get("temperatureOffsetC")),
                        "targetTempC": source.get("targetTempC"),
                        "marketSelectionMode": source.get("marketSelectionMode"),
                        "marketBucketKind": source.get("marketBucketKind"),
                        "marketBucketValue": source.get("marketBucketValue"),
                        "requestedStakeUsd": stake["stakeUsd"],
                        "estimatedShares": round_money(float(stake["stakeUsd"]) / float(current_no_price), 6),
                        "estimatedNoWinPayoutUsd": round_money(
                            float(stake["stakeUsd"]) / float(current_no_price),
                            6,
                        ),
                        "estimatedNoWinPnlUsd": round_money(
                            float(stake["stakeUsd"]) / float(current_no_price) - float(stake["stakeUsd"]),
                            6,
                        ),
                        "progressiveStepIndex": stake["stepIndex"],
                        "progressiveLossStreakBefore": stake["lossStreakBefore"],
                        "progressiveCyclePnlBefore": stake.get("cyclePnlBefore"),
                        "configuredBaseStakeUsd": stake.get("configuredBaseStakeUsd"),
                        "effectiveBaseStakeUsd": stake.get("effectiveBaseStakeUsd"),
                        "configuredStakeSequenceLabel": stake.get("configuredStakeSequenceLabel"),
                        "effectiveStakeSequenceLabel": stake.get("effectiveStakeSequenceLabel"),
                        "plannedStakeTotalUsd": stake.get("plannedStakeTotalUsd"),
                        "availableBalanceUsd": stake.get("availableBalanceUsd"),
                        "stakeDowngradedByBalance": stake.get("stakeDowngradedByBalance"),
                        "stakeDowngradeReason": stake.get("stakeDowngradeReason"),
                        "baselinePosition": round_money(baseline, 6),
                        "status": "placing",
                        "result": "pending",
                    }
                )
            else:
                live_record = build_live_record(source, stake, token["tokenId"], current_no_price, price_cap, baseline)
            upsert_live_order(live_orders, live_record)
            write_json(LIVE_ORDERS_PATH, live_orders)

            raw_tick_size = market.get("orderPriceMinTickSize") or ""
            tick_size = str(raw_tick_size) if raw_tick_size != "" else None
            neg_risk = bool(market.get("negRisk") or event.get("negRisk") or False)
            existing_attempts = live_record.get("orderAttempts")
            order_attempts = list(existing_attempts) if isinstance(existing_attempts, list) else []
            attempt_index = len(order_attempts) + 1
            if attempt_index > MAX_ORDER_ATTEMPTS:
                print(f"SKIP max attempts {city} attempts={len(order_attempts)}/{MAX_ORDER_ATTEMPTS}")
                results.append({"city": city, "status": "skipped-existing"})
                continue

            order_ids = []
            if live_record.get("orderId"):
                order_ids.append(str(live_record.get("orderId")))
            for item in live_record.get("orderIds") or []:
                if item:
                    order_ids.append(str(item))

            trader.ensure_funds(float(stake["stakeUsd"]))
            attempted_at = now_iso()
            response = trader.place_buy(
                token["tokenId"],
                float(stake["stakeUsd"]),
                price_cap,
                tick_size,
                neg_risk,
            )
            order_id = response_order_id(response)
            if order_id:
                order_ids.append(order_id)
            submitted = bool(order_id) or bool(isinstance(response, dict) and response.get("success"))
            time.sleep(max(0.0, POSITION_CONFIRM_WAIT_SECONDS))
            after = float(trader.get_position_size(token["tokenId"]) or 0.0)
            delta = max(0.0, after - baseline)
            order_attempts.append(
                {
                    "attempt": attempt_index,
                    "attemptedAt": attempted_at,
                    "orderId": order_id,
                    "response": to_jsonable(response),
                    "positionAfter": round_money(after, 6),
                    "deltaShares": round_money(delta, 6),
                }
            )

            actual_cost_estimate = round_money(delta * float(current_no_price), 6) or 0
            unique_order_ids = list(dict.fromkeys(order_ids))
            if delta > MIN_SUCCESS_SHARES or submitted:
                fill_status = "position-detected" if delta > MIN_SUCCESS_SHARES else "submitted-unconfirmed"
                live_record.update(
                    {
                        "status": "pending",
                        "fillStatus": fill_status,
                        "orderId": unique_order_ids[0] if unique_order_ids else None,
                        "orderIds": unique_order_ids,
                        "response": to_jsonable(response),
                        "orderAttempts": order_attempts,
                        "lastAttemptAt": attempted_at,
                        "positionAfter": round_money(after, 6),
                        "sharesBought": round_money(delta, 6),
                        "stakeUsd": actual_cost_estimate,
                        "spentUsd": actual_cost_estimate,
                        "result": "pending",
                        "error": None,
                        "failedAt": None,
                    }
                )
                log_status = "BOUGHT" if delta > MIN_SUCCESS_SHARES else "SUBMITTED"
                print(
                    f"{log_status} {city} No requested=${stake['stakeUsd']:.3f} "
                    f"filled_est=${actual_cost_estimate:.3f} cap={price_cap:.3f} "
                    f"shares={live_record['sharesBought']} attempts={len(order_attempts)}"
                )
                results.append({"city": city, "status": "pending", "stakeUsd": actual_cost_estimate})
            else:
                exhausted = attempt_index >= MAX_ORDER_ATTEMPTS
                live_record.update(
                    {
                        "status": "no-fill" if exhausted else "pending",
                        "fillStatus": "no-position-after-retries"
                        if exhausted
                        else "no-position-after-attempt",
                        "orderId": unique_order_ids[0] if unique_order_ids else None,
                        "orderIds": unique_order_ids,
                        "response": to_jsonable(response),
                        "orderAttempts": order_attempts,
                        "lastAttemptAt": attempted_at,
                        "positionAfter": round_money(after, 6),
                        "sharesBought": 0,
                        "stakeUsd": 0,
                        "spentUsd": 0,
                        "payoutUsd": None,
                        "pnlUsd": None,
                        "result": "no-fill",
                    }
                )
                print(
                    f"NO_FILL {city} requested=${stake['stakeUsd']:.3f} cap={price_cap:.3f} "
                    f"attempts={len(order_attempts)}"
                )
                results.append({"city": city, "status": "no-fill" if exhausted else "pending", "stakeUsd": 0})
            continue
        except Exception as exc:
            if live_record is None:
                live_record = {
                    "key": key,
                    "strategyId": STRATEGY_ID,
                    "date": source.get("date"),
                    "captureSlotId": source.get("captureSlotId") or CAPTURE_SLOT_ID,
                    "captureSlotLabel": source.get("captureSlotLabel") or CAPTURE_SLOT_LABEL,
                    "citySlug": source.get("citySlug"),
                    "cityZh": source.get("cityZh"),
                    "eventSlug": source.get("eventSlug"),
                    "marketSlug": source.get("marketSlug"),
                    "marketTitle": source.get("marketTitle"),
                    "placedAt": now_iso(),
                    "stakeUsd": BASE_STAKE_USD,
                }
                upsert_live_order(live_orders, live_record)
            live_record.update(
                {
                    "status": "failed",
                    "result": "下单失败",
                    "error": str(exc),
                    "failedAt": now_iso(),
                }
            )
            print(f"FAILED {city}: {exc}")
            results.append({"city": city, "status": "failed", "error": str(exc)})
        finally:
            write_json(LIVE_ORDERS_PATH, live_orders)

    bought = sum(1 for item in results if item["status"] == "pending")
    failed = sum(1 for item in results if item["status"] == "failed")
    skipped = sum(1 for item in results if item["status"] in {"skipped-existing", "skipped-price"})
    print(f"SUMMARY date={target_date} bought={bought} failed={failed} skipped={skipped}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
