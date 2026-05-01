from __future__ import annotations

import atexit
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo


ROOT_DIR = Path(__file__).resolve().parents[1]
UTC = timezone.utc
LOCAL_TZ = ZoneInfo("Asia/Shanghai")


def load_env_file(file_path: Path) -> None:
    if not file_path.exists():
        return
    for raw_line in file_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        os.environ.setdefault(key, value)


for env_name in (
    ".env.order.recovery.local",
    ".env.order.recovery",
    ".env.order.local",
    ".env.order",
    ".env.local",
    ".env",
):
    load_env_file(ROOT_DIR / env_name)


def env_value(name: str, fallback: str) -> str:
    value = os.getenv(name)
    return str(value).strip() if value is not None and str(value).strip() else fallback


def parse_bool(value: Optional[str], fallback: bool = False) -> bool:
    if value in (None, ""):
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_float(value: Optional[str], fallback: float) -> float:
    try:
        parsed = float(str(value))
        return parsed if parsed > 0 else fallback
    except Exception:
        return fallback


def bounded_float(value: Optional[Any], fallback: float, minimum: float, maximum: float, decimals: int = 4) -> float:
    try:
        parsed = float(str(value))
        if not parsed or parsed <= 0:
            return fallback
        bounded = min(maximum, max(minimum, parsed))
        return round(bounded, decimals)
    except Exception:
        return fallback


def parse_int(value: Optional[str], fallback: int) -> int:
    try:
        parsed = int(float(str(value)))
        return parsed if parsed > 0 else fallback
    except Exception:
        return fallback


def safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(str(value))
    except Exception:
        return fallback


VARIANT = env_value("RECOVERY_VARIANT", env_value("ORDER_VARIANT", "4h")).lower()
VARIANT_LABEL = "4小时"
VARIANT_SHORT = "4H"

os.environ["ORDER_VARIANT"] = "4h"
ORDER_DRY_RUN = parse_bool(os.getenv("RECOVERY_DRY_RUN"), True)
os.environ["ORDER_DRY_RUN"] = "true" if ORDER_DRY_RUN else "false"
os.environ["ORDER_EXECUTION_TYPE"] = env_value("RECOVERY_EXECUTION_TYPE", "GTC").upper()
os.environ["ORDER_PRICE_SIDE"] = env_value("RECOVERY_PRICE_SIDE", "BUY").upper()

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts import order as legacy  # noqa: E402


DATA_ROOT = ROOT_DIR / "data" / "orders_recovery"
CONFIG_PATH = DATA_ROOT / "config.json"
RUNTIME_DIR = DATA_ROOT / "runtime"
REPORTS_DIR = DATA_ROOT / "reports"
LOGS_DIR = DATA_ROOT / "logs"
LOCKS_DIR = ROOT_DIR / "data" / "locks"
LOCK_PATH = LOCKS_DIR / "order-recovery-4h.lock.json"
RUNTIME_PATH = RUNTIME_DIR / "runtime-state-4h.json"
GROUP_SUMMARY_PATH = REPORTS_DIR / "group-summary-4h.json"
EVENT_DETAILS_PATH = REPORTS_DIR / "event-details-4h.json"
TRADE_DETAILS_PATH = REPORTS_DIR / "trade-details-4h.json"

LIMIT_PRICE_CENTS = bounded_float(
    env_value("RECOVERY_4H_LIMIT_PRICE_CENTS", env_value("RECOVERY_4H_THRESHOLD_CENTS", "40")),
    40.0,
    1.0,
    99.0,
    2,
)
LIMIT_SHARES = bounded_float(env_value("RECOVERY_4H_LIMIT_ORDER_SHARES", "5"), 5.0, 0.01, 10000.0, 4)
PRESTART_LEAD_MINUTES = bounded_float(
    env_value("RECOVERY_4H_PRESTART_ENTRY_LEAD_MINUTES", "60"),
    60.0,
    1.0,
    240.0,
    0,
)
LOOP_SECONDS = parse_int(env_value("RECOVERY_4H_LIMIT_LOOP_SECONDS", "15"), 15)
RETRY_SECONDS = parse_int(env_value("RECOVERY_4H_LIMIT_RETRY_SECONDS", "300"), 300)
EXPIRY_BUFFER_SECONDS = parse_int(env_value("RECOVERY_4H_LIMIT_EXPIRY_BUFFER_SECONDS", "60"), 60)
MAX_STORED_EVENTS = parse_int(env_value("RECOVERY_4H_LIMIT_MAX_EVENTS", "80"), 80)
ORDER_USD = round(LIMIT_SHARES * LIMIT_PRICE_CENTS / 100.0, 6)
CONFIG_UPDATED_AT: Optional[str] = None
EMPTY_TERMINAL_ORDER_STATUSES = {"invalid", "cancelled", "canceled", "expired"}
OPEN_ORDER_STATUSES = {"live", "open"}
FILLED_ORDER_STATUSES = {"matched", "filled", "complete", "completed"}


def ensure_dir(path_value: Path) -> None:
    path_value.mkdir(parents=True, exist_ok=True)


def now_utc() -> datetime:
    return datetime.now(UTC)


def format_log_time(value: datetime) -> str:
    return value.astimezone(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")


def log(message: str) -> None:
    print(f"[{format_log_time(now_utc())}] [{VARIANT_SHORT}] {message}", flush=True)


def read_json(path_value: Path, fallback: Any) -> Any:
    try:
        return json.loads(path_value.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path_value: Path, payload: Any) -> None:
    ensure_dir(path_value.parent)
    path_value.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_json_line(path_value: Path, payload: Dict[str, Any]) -> None:
    ensure_dir(path_value.parent)
    with path_value.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def refresh_limit_config() -> None:
    global LIMIT_PRICE_CENTS, LIMIT_SHARES, PRESTART_LEAD_MINUTES, ORDER_USD, CONFIG_UPDATED_AT

    env_price = bounded_float(
        env_value("RECOVERY_4H_LIMIT_PRICE_CENTS", env_value("RECOVERY_4H_THRESHOLD_CENTS", "40")),
        40.0,
        1.0,
        99.0,
        2,
    )
    env_shares = bounded_float(env_value("RECOVERY_4H_LIMIT_ORDER_SHARES", "5"), 5.0, 0.01, 10000.0, 4)
    env_lead = bounded_float(
        env_value("RECOVERY_4H_PRESTART_ENTRY_LEAD_MINUTES", "60"),
        60.0,
        1.0,
        240.0,
        0,
    )
    payload = read_json(CONFIG_PATH, {})
    if not isinstance(payload, dict):
        payload = {}

    LIMIT_PRICE_CENTS = bounded_float(payload.get("limitPriceCents"), env_price, 1.0, 99.0, 2)
    LIMIT_SHARES = bounded_float(payload.get("limitShares"), env_shares, 0.01, 10000.0, 4)
    PRESTART_LEAD_MINUTES = bounded_float(
        payload.get("entryLeadMinutes"),
        env_lead,
        1.0,
        240.0,
        0,
    )
    ORDER_USD = round(LIMIT_SHARES * LIMIT_PRICE_CENTS / 100.0, 6)
    CONFIG_UPDATED_AT = str(payload.get("updatedAt") or "") or None


def pid_alive(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def acquire_lock() -> None:
    ensure_dir(LOCKS_DIR)
    existing = read_json(LOCK_PATH, None)
    if isinstance(existing, dict) and pid_alive(int(existing.get("pid") or 0)):
        raise RuntimeError(f"4h limit worker already running pid={existing.get('pid')}")
    write_json(LOCK_PATH, {"pid": os.getpid(), "variant": "4h", "startedAt": now_utc().isoformat()})


def release_lock() -> None:
    current = read_json(LOCK_PATH, None)
    if isinstance(current, dict) and int(current.get("pid") or 0) == os.getpid():
        try:
            LOCK_PATH.unlink(missing_ok=True)
        except Exception:
            pass


atexit.register(release_lock)


def extract_order_id(response: Any) -> Optional[str]:
    if isinstance(response, dict):
        for key in ("orderID", "id", "orderId"):
            value = response.get(key)
            if value:
                return str(value)
    return None


def event_key(meta: Dict[str, Any]) -> str:
    start = meta["eventStart"].astimezone(UTC).isoformat()
    return f"4h:{meta['slug']}:{start}"


def log_path(event: Dict[str, Any]) -> Path:
    safe_start = str(event.get("eventStart") or "").replace(":", "-")
    return LOGS_DIR / f"4h_{event['slug']}_{safe_start}.jsonl"


def write_event_log(event: Dict[str, Any], action: str, payload: Optional[Dict[str, Any]] = None) -> None:
    append_json_line(
        log_path(event),
        {
            "ts": now_utc().isoformat(),
            "variant": "4h",
            "eventKey": event.get("eventKey"),
            "slug": event.get("slug"),
            "action": action,
            **(payload or {}),
        },
    )


def empty_order(side: str, token_id: str) -> Dict[str, Any]:
    return {
        "side": side,
        "tokenId": str(token_id),
        "status": "waiting",
        "attemptCount": 0,
        "lastAttemptAt": None,
        "retryEligibleAt": None,
        "orderId": None,
        "limitOrderId": None,
        "limitPriceCents": LIMIT_PRICE_CENTS,
        "limitShares": LIMIT_SHARES,
        "estimatedCostUsd": ORDER_USD,
        "lastError": None,
        "lastErrorAt": None,
        "response": None,
    }


def create_event(meta: Dict[str, Any]) -> Dict[str, Any]:
    start = meta["eventStart"].astimezone(UTC)
    end = meta["eventEnd"].astimezone(UTC)
    event = {
        "variant": "4h",
        "variantLabel": VARIANT_LABEL,
        "eventKey": event_key(meta),
        "slug": meta["slug"],
        "eventId": meta.get("eventId"),
        "marketId": meta.get("marketId"),
        "eventStart": start.isoformat(),
        "eventEnd": end.isoformat(),
        "entryOpenAt": (start - timedelta(minutes=PRESTART_LEAD_MINUTES)).isoformat(),
        "status": "waiting-window",
        "statusReason": None,
        "limitPriceCents": LIMIT_PRICE_CENTS,
        "limitShares": LIMIT_SHARES,
        "estimatedOrderUsd": ORDER_USD,
        "submittedUsd": 0.0,
        "pnlUsd": 0.0,
        "createdAt": now_utc().isoformat(),
        "updatedAt": now_utc().isoformat(),
        "tickSize": meta.get("tickSize"),
        "negRisk": bool(meta.get("negRisk")),
        "orders": {
            "up": empty_order("up", meta["upTokenId"]),
            "down": empty_order("down", meta["downTokenId"]),
        },
    }
    write_event_log(
        event,
        "event-created",
        {
            "eventStart": event["eventStart"],
            "eventEnd": event["eventEnd"],
            "entryOpenAt": event["entryOpenAt"],
            "limitPriceCents": LIMIT_PRICE_CENTS,
            "limitShares": LIMIT_SHARES,
        },
    )
    return event


def sync_event_config(event: Dict[str, Any]) -> Dict[str, Any]:
    start = legacy.parse_date(event.get("eventStart"))
    if start:
        event["entryOpenAt"] = (start - timedelta(minutes=PRESTART_LEAD_MINUTES)).isoformat()
    event["variantLabel"] = VARIANT_LABEL
    event["limitPriceCents"] = LIMIT_PRICE_CENTS
    event["limitShares"] = LIMIT_SHARES
    event["estimatedOrderUsd"] = ORDER_USD
    orders = event.get("orders")
    if isinstance(orders, dict):
        for side in ("up", "down"):
            order = orders.get(side)
            if not isinstance(order, dict):
                continue
            if order.get("orderId") or order.get("limitOrderId"):
                continue
            order["limitPriceCents"] = LIMIT_PRICE_CENTS
            order["limitShares"] = LIMIT_SHARES
            order["estimatedCostUsd"] = ORDER_USD
    return event


def sort_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(events, key=lambda item: item.get("eventStart") or "", reverse=True)[:MAX_STORED_EVENTS]


def load_state() -> Dict[str, Any]:
    state = read_json(RUNTIME_PATH, {})
    if not isinstance(state, dict):
        state = {}
    events = state.get("events")
    if not isinstance(events, list):
        events = []
    return {
        "version": 1,
        "variant": "4h",
        "mode": "dry-run" if ORDER_DRY_RUN else "live",
        "workerPid": os.getpid(),
        "strategy": strategy_snapshot(),
        "activeEvent": state.get("activeEvent") if isinstance(state.get("activeEvent"), dict) else None,
        "events": sort_events([item for item in events if isinstance(item, dict)]),
        "lastError": state.get("lastError"),
        "lastUpdatedAt": now_utc().isoformat(),
    }


def strategy_snapshot() -> Dict[str, Any]:
    return {
        "type": "fixed-4h-limit-orders",
        "entryLeadMinutes": PRESTART_LEAD_MINUTES,
        "limitPriceCents": LIMIT_PRICE_CENTS,
        "limitShares": LIMIT_SHARES,
        "limitOrderShares": LIMIT_SHARES,
        "estimatedOrderUsd": ORDER_USD,
        "fixedLimitLegUsd": ORDER_USD,
        "retrySeconds": RETRY_SECONDS,
        "loopSeconds": LOOP_SECONDS,
        "expiryBufferSeconds": EXPIRY_BUFFER_SECONDS,
        "configUpdatedAt": CONFIG_UPDATED_AT,
        "noSettlement": True,
        "noPnlRecovery": True,
    }


def current_target_meta() -> Optional[Dict[str, Any]]:
    current = now_utc()
    window_minutes = float(getattr(legacy, "ORDER_WINDOW_MINUTES", 240.0) or 240.0)
    window_start = legacy.align_to_window_start(current)
    next_start = window_start + timedelta(minutes=window_minutes)
    entry_open = next_start - timedelta(minutes=PRESTART_LEAD_MINUTES)
    if current < entry_open:
        return None
    if current >= next_start:
        return None
    return legacy.resolve_event_for_date(next_start + timedelta(seconds=1))


def next_waiting_meta() -> Optional[Dict[str, Any]]:
    current = now_utc()
    window_minutes = float(getattr(legacy, "ORDER_WINDOW_MINUTES", 240.0) or 240.0)
    window_start = legacy.align_to_window_start(current)
    next_start = window_start + timedelta(minutes=window_minutes)
    return legacy.resolve_event_for_date(next_start + timedelta(seconds=1))


def upsert_event(state: Dict[str, Any], event: Dict[str, Any]) -> None:
    events = [item for item in state.get("events", []) if item.get("eventKey") != event.get("eventKey")]
    events.append(event)
    state["events"] = sort_events(events)
    state["activeEvent"] = event


def get_or_create_event(state: Dict[str, Any], meta: Dict[str, Any]) -> Dict[str, Any]:
    key = event_key(meta)
    active = state.get("activeEvent")
    if isinstance(active, dict) and active.get("eventKey") == key:
        sync_event_config(active)
        return active
    for item in state.get("events", []):
        if isinstance(item, dict) and item.get("eventKey") == key:
            sync_event_config(item)
            state["activeEvent"] = item
            return item
    event = create_event(meta)
    upsert_event(state, event)
    return event


def expiration_ts(event: Dict[str, Any]) -> int:
    event_end = legacy.parse_date(event["eventEnd"])
    expires = event_end - timedelta(seconds=EXPIRY_BUFFER_SECONDS)
    return max(0, int(expires.timestamp()))


def summarize_order_detail(detail: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": detail.get("id"),
        "status": detail.get("status"),
        "sizeMatched": detail.get("size_matched") or detail.get("sizeMatched"),
        "originalSize": detail.get("original_size") or detail.get("originalSize"),
        "price": detail.get("price"),
        "outcome": detail.get("outcome"),
    }


def reconcile_side_order(event: Dict[str, Any], side: str, trader) -> None:
    order = event.get("orders", {}).get(side)
    if not isinstance(order, dict):
        return
    order_id = order.get("orderId") or order.get("limitOrderId")
    if not order_id or not hasattr(trader, "get_order_detail"):
        return

    try:
        detail = trader.get_order_detail(str(order_id))
    except Exception as exc:
        order["lastClobCheckError"] = str(exc)[:500]
        order["lastClobCheckedAt"] = now_utc().isoformat()
        write_event_log(
            event,
            "limit-order-check-error",
            {
                "side": side,
                "orderId": str(order_id),
                "error": order["lastClobCheckError"],
            },
        )
        return

    if not isinstance(detail, dict):
        return

    current = now_utc()
    status = str(detail.get("status") or "").strip().lower()
    matched_shares = safe_float(detail.get("size_matched") or detail.get("sizeMatched"), 0.0)
    order["lastClobStatus"] = status or None
    order["lastClobCheckedAt"] = current.isoformat()
    order["lastClobDetail"] = summarize_order_detail(detail)

    if status in OPEN_ORDER_STATUSES:
        order["status"] = "limit-open"
        return

    if matched_shares > 0:
        order["status"] = "matched" if status in FILLED_ORDER_STATUSES else f"matched-{status or 'unknown'}"
        order["matchedShares"] = round(matched_shares, 6)
        return

    if status in EMPTY_TERMINAL_ORDER_STATUSES:
        order["status"] = "failed-retry"
        order["orderId"] = None
        order["limitOrderId"] = None
        order["lastError"] = f"clob-order-{status}"
        order["lastErrorAt"] = current.isoformat()
        order["lastInvalidOrderId"] = str(order_id)
        if not order.get("retryEligibleAt"):
            order["retryEligibleAt"] = current.isoformat()
        write_event_log(
            event,
            "limit-order-invalid",
            {
                "side": side,
                "orderId": str(order_id),
                "clobStatus": status,
                "matchedShares": matched_shares,
                "retryEligibleAt": order.get("retryEligibleAt"),
            },
        )


def reconcile_event_orders(event: Dict[str, Any], trader) -> None:
    for side in ("up", "down"):
        reconcile_side_order(event, side, trader)


def order_ready(order: Dict[str, Any]) -> bool:
    if order.get("orderId") or order.get("limitOrderId"):
        return False
    retry_at = order.get("retryEligibleAt")
    if not retry_at:
        return True
    try:
        return now_utc() >= legacy.parse_date(retry_at)
    except Exception:
        return True


def submit_side(event: Dict[str, Any], side: str, trader) -> None:
    order = event["orders"][side]
    if not order_ready(order):
        return
    current = now_utc()
    order["attemptCount"] = int(order.get("attemptCount") or 0) + 1
    order["lastAttemptAt"] = current.isoformat()
    order["retryEligibleAt"] = (current + timedelta(seconds=RETRY_SECONDS)).isoformat()
    order["status"] = "placing"
    write_event_log(
        event,
        "limit-order-attempt",
        {
            "side": side,
            "attemptCount": order["attemptCount"],
            "limitPriceCents": LIMIT_PRICE_CENTS,
            "limitShares": LIMIT_SHARES,
        },
    )
    try:
        response = trader.place_limit_buy(
            order["tokenId"],
            LIMIT_SHARES,
            LIMIT_PRICE_CENTS,
            event.get("tickSize"),
            event.get("negRisk"),
            expiration_ts(event),
        )
        order_id = extract_order_id(response)
        if not order_id:
            raise RuntimeError(f"limit order accepted without order id: {response}")
        order["status"] = "limit-open"
        order["orderId"] = order_id
        order["limitOrderId"] = order_id
        order["response"] = response
        order["lastError"] = None
        order["lastErrorAt"] = None
        write_event_log(
            event,
            "limit-order-opened",
            {
                "side": side,
                "orderId": order_id,
                "limitPriceCents": LIMIT_PRICE_CENTS,
                "limitShares": LIMIT_SHARES,
                "estimatedCostUsd": ORDER_USD,
            },
        )
    except Exception as exc:
        order["status"] = "failed-retry"
        order["lastError"] = str(exc)[:500]
        order["lastErrorAt"] = now_utc().isoformat()
        write_event_log(
            event,
            "limit-order-error",
            {
                "side": side,
                "error": order["lastError"],
                "retryEligibleAt": order["retryEligibleAt"],
            },
        )


def refresh_event_totals(event: Dict[str, Any]) -> None:
    submitted = [
        order for order in event["orders"].values() if order.get("orderId") or order.get("limitOrderId")
    ]
    event["submittedUsd"] = round(
        sum(float(order.get("estimatedCostUsd") or ORDER_USD) for order in submitted),
        6,
    )
    event["spentUsd"] = event["submittedUsd"]
    event["pnlUsd"] = 0.0
    event["upPlaced"] = bool(event["orders"]["up"].get("orderId"))
    event["downPlaced"] = bool(event["orders"]["down"].get("orderId"))
    if event["upPlaced"] and event["downPlaced"]:
        event["status"] = "limit-open"
        event["statusReason"] = None
    elif event["upPlaced"] or event["downPlaced"]:
        event["status"] = "partial-limit-open"
        errors = [
            order.get("lastError")
            for order in event["orders"].values()
            if order.get("lastError")
        ]
        event["statusReason"] = errors[-1] if errors else "one-side-submitted"
    else:
        event["status"] = "waiting-retry"
        errors = [
            order.get("lastError")
            for order in event["orders"].values()
            if order.get("lastError")
        ]
        event["statusReason"] = errors[-1] if errors else None
    event["updatedAt"] = now_utc().isoformat()


def submit_event_orders(state: Dict[str, Any], trader) -> None:
    meta = current_target_meta()
    if not meta:
        waiting = next_waiting_meta()
        if waiting:
            event = get_or_create_event(state, waiting)
            event["status"] = "waiting-window"
            event["statusReason"] = "waiting-for-one-hour-prestart"
            upsert_event(state, event)
        return

    event = get_or_create_event(state, meta)
    reconcile_event_orders(event, trader)
    event_start = legacy.parse_date(event["eventStart"])
    if now_utc() >= event_start:
        event["status"] = "missed-window"
        event["statusReason"] = "event-already-started"
        upsert_event(state, event)
        return

    for side in ("up", "down"):
        submit_side(event, side, trader)
    refresh_event_totals(event)
    upsert_event(state, event)


def event_row(event: Dict[str, Any]) -> Dict[str, Any]:
    start = legacy.parse_date(event["eventStart"])
    price_cents = float(event.get("limitPriceCents") or LIMIT_PRICE_CENTS)
    shares = float(event.get("limitShares") or LIMIT_SHARES)
    return {
        "variant": "4h",
        "variantLabel": VARIANT_LABEL,
        "entryMode": "fixed-limit",
        "eventKey": event.get("eventKey"),
        "slug": event.get("slug"),
        "eventStart": event.get("eventStart"),
        "eventEnd": event.get("eventEnd"),
        "status": event.get("status"),
        "statusReason": event.get("statusReason"),
        "thresholdCents": price_cents,
        "limitPriceCents": price_cents,
        "limitShares": shares,
        "spentUsd": event.get("spentUsd", 0.0),
        "submittedUsd": event.get("submittedUsd", 0.0),
        "payoutUsd": 0.0,
        "pnlUsd": 0.0,
        "winnerSide": None,
        "upPlaced": bool(event.get("orders", {}).get("up", {}).get("orderId")),
        "downPlaced": bool(event.get("orders", {}).get("down", {}).get("orderId")),
        "upAttempts": int(event.get("orders", {}).get("up", {}).get("attemptCount") or 0),
        "downAttempts": int(event.get("orders", {}).get("down", {}).get("attemptCount") or 0),
        "upStatus": event.get("orders", {}).get("up", {}).get("status"),
        "downStatus": event.get("orders", {}).get("down", {}).get("status"),
        "finalizedAt": None,
        "sortMs": int((start or now_utc()).timestamp() * 1000),
    }


def trade_rows(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for event in events:
        for side in ("up", "down"):
            order = event.get("orders", {}).get(side, {})
            if not order.get("orderId"):
                continue
            price_cents = float(order.get("limitPriceCents") or event.get("limitPriceCents") or LIMIT_PRICE_CENTS)
            shares = float(order.get("limitShares") or event.get("limitShares") or LIMIT_SHARES)
            spent_usd = float(order.get("estimatedCostUsd") or round(shares * price_cents / 100.0, 6))
            rows.append(
                {
                    "variant": "4h",
                    "variantLabel": VARIANT_LABEL,
                    "eventKey": event.get("eventKey"),
                    "slug": event.get("slug"),
                    "eventStart": event.get("eventStart"),
                    "eventEnd": event.get("eventEnd"),
                    "side": side,
                    "placedAt": order.get("lastAttemptAt"),
                    "triggerType": "fixed-limit",
                    "status": order.get("status"),
                    "triggerCents": price_cents,
                    "thresholdCents": price_cents,
                    "spentUsd": spent_usd,
                    "sharesBought": 0.0,
                    "limitShares": shares,
                    "orderId": order.get("orderId"),
                    "sortMs": int((legacy.parse_date(order.get("lastAttemptAt")) or now_utc()).timestamp() * 1000),
                }
            )
    return sorted(rows, key=lambda item: item["sortMs"], reverse=True)[:MAX_STORED_EVENTS * 2]


def persist_reports(state: Dict[str, Any]) -> None:
    events = sort_events(state.get("events", []))
    active = state.get("activeEvent") if isinstance(state.get("activeEvent"), dict) else None
    open_orders = 0
    if active:
        open_orders = sum(
            1
            for order in active.get("orders", {}).values()
            if order.get("status") == "limit-open"
        )
    summary = {
        "variant": "4h",
        "variantLabel": VARIANT_LABEL,
        "mode": state.get("mode"),
        "workerPid": os.getpid(),
        "strategy": strategy_snapshot(),
        "status": "active",
        "balanceUsd": 0.0,
        "availableUsd": 0.0,
        "activeExposureUsd": active.get("submittedUsd", 0.0) if active else 0.0,
        "realizedNetPnlUsd": 0.0,
        "totalEvents": len(events),
        "tradedEvents": 0,
        "skippedEvents": 0,
        "winningEvents": 0,
        "losingEvents": 0,
        "flatEvents": 0,
        "currentLegUsd": ORDER_USD,
        "baseLegUsd": ORDER_USD,
        "recoveryLegUsd": ORDER_USD,
        "recoveryMode": False,
        "currentLossStreak": 0,
        "activeEventKey": active.get("eventKey") if active else None,
        "activeEventStart": active.get("eventStart") if active else None,
        "activeEventEnd": active.get("eventEnd") if active else None,
        "openLimitOrders": open_orders,
        "updatedAt": now_utc().isoformat(),
    }
    write_json(GROUP_SUMMARY_PATH, summary)
    write_json(EVENT_DETAILS_PATH, [event_row(event) for event in events])
    write_json(TRADE_DETAILS_PATH, trade_rows(events))


def persist_state(state: Dict[str, Any]) -> None:
    state["workerPid"] = os.getpid()
    state["mode"] = "dry-run" if ORDER_DRY_RUN else "live"
    state["strategy"] = strategy_snapshot()
    state["lastUpdatedAt"] = now_utc().isoformat()
    write_json(RUNTIME_PATH, state)
    persist_reports(state)


def main() -> None:
    ensure_dir(RUNTIME_DIR)
    ensure_dir(REPORTS_DIR)
    ensure_dir(LOGS_DIR)
    acquire_lock()
    refresh_limit_config()

    if VARIANT != "4h":
        log(f"Unsupported variant {VARIANT}; this worker only runs fixed 4h limit orders.")
        while True:
            time.sleep(60)

    trader = legacy.create_trader()
    if hasattr(trader, "initialize"):
        trader.initialize()

    state = load_state()
    log(
        f"Fixed 4h limit worker ready | mode={state['mode']} "
        f"lead={PRESTART_LEAD_MINUTES:.0f}m price={LIMIT_PRICE_CENTS:.1f}c shares={LIMIT_SHARES:.3f}"
    )
    while True:
        try:
            refresh_limit_config()
            submit_event_orders(state, trader)
            state["lastError"] = None
        except Exception as exc:
            state["lastError"] = str(exc)[:500]
            log(f"Loop error: {exc}")
        persist_state(state)
        time.sleep(LOOP_SECONDS)


if __name__ == "__main__":
    main()
