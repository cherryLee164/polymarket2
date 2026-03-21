import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import requests

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.paper_adaptive_strategy import (
    build_adaptive_strategy_def,
    build_adaptive_strategy_state,
    is_adaptive_strategy_def,
    is_adaptive_strategy_state,
    placed_order_count,
    apply_adaptive_strategy_sample,
    resolve_adaptive_strategy,
)


UTC = timezone.utc


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
        existing = os.environ.get(key)
        if existing is not None and str(existing).strip() != "":
            continue
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        if value == "" and existing is not None:
            continue
        os.environ[key] = value


for env_name in (".env.order.local", ".env.order", ".env.local", ".env"):
    load_env_file(ROOT_DIR / env_name)


def get_first_env(keys, fallback=""):
    for key in keys:
        value = os.getenv(key)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return fallback


def ensure_dir(dir_path: Path) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)


API_BASE = get_first_env(["API_BASE"], "https://gamma-api.polymarket.com")
CLOB_BASE = get_first_env(["CLOB_BASE"], "https://clob.polymarket.com")
TIME_ZONE = get_first_env(["TIME_ZONE"], "America/New_York")
LOG_TIME_ZONE = get_first_env(["LOG_TIME_ZONE"], "Asia/Shanghai")
WINDOW_MINUTES = int(float(get_first_env(["ORDER_15M_PAPER_WINDOW_MINUTES"], "15")))
EVENT_PREFIX = get_first_env(["ORDER_15M_PAPER_EVENT_PREFIX"], "btc-updown-15m-")
EVENT_SUFFIX = get_first_env(["ORDER_15M_PAPER_EVENT_SUFFIX"], "")
SLUG_MODE = get_first_env(["ORDER_15M_PAPER_SLUG_MODE"], "timestamp-start").strip().lower()
WINDOW_LABEL = get_first_env(["ORDER_15M_PAPER_WINDOW_LABEL"], f"{WINDOW_MINUTES}M")
PRICE_SIDE = "BUY"
PAPER_VARIANT_ID = get_first_env(["ORDER_15M_PAPER_VARIANT_ID"], "15m-paper")
PAPER_OUTPUT_DIR = get_first_env(["ORDER_15M_PAPER_OUTPUT_DIR"], "paper-15m")
PAPER_LOG_PREFIX = get_first_env(["ORDER_15M_PAPER_LOG_PREFIX"], "15M paper")
SAMPLE_INTERVAL_MS = int(get_first_env(["ORDER_15M_PAPER_SAMPLE_INTERVAL_MS"], "5000"))
USD_PER_LEG = float(get_first_env(["ORDER_15M_PAPER_USD_PER_LEG"], "1"))
REFERENCE_LOOKBACK_WINDOWS = int(
    get_first_env(["ORDER_15M_PAPER_REFERENCE_LOOKBACK_WINDOWS"], "2")
)
REFERENCE_LOOKBACK_MINUTES = int(
    get_first_env(
        ["ORDER_15M_PAPER_REFERENCE_LOOKBACK_MINUTES"],
        str(REFERENCE_LOOKBACK_WINDOWS * WINDOW_MINUTES),
    )
)
FIRST_ENTRY_DEADLINE_MINUTES = float(
    get_first_env(["ORDER_15M_PAPER_FIRST_ENTRY_DEADLINE_MINUTES"], "7")
)
MAX_SAMPLES_DEFAULT = int(get_first_env(["ORDER_15M_PAPER_MAX_SAMPLES"], "0"))

SESSION = requests.Session()
SESSION.headers.update(
    {
        "accept": "application/json",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
    }
)

NY_TZ = ZoneInfo(TIME_ZONE)
LOG_TZ = ZoneInfo(LOG_TIME_ZONE)

DEFAULT_STRATEGY_GROUPS = [
    {"id": "g30_30", "label": "30/30", "firstEntryCents": 30.0, "hedgeEntryCents": 30.0},
    {"id": "g30_35", "label": "30/35", "firstEntryCents": 30.0, "hedgeEntryCents": 35.0},
    {"id": "g30_40", "label": "30/40", "firstEntryCents": 30.0, "hedgeEntryCents": 40.0},
    {"id": "g30_45", "label": "30/45", "firstEntryCents": 30.0, "hedgeEntryCents": 45.0},
    {"id": "g30_50", "label": "30/50", "firstEntryCents": 30.0, "hedgeEntryCents": 50.0},
    {"id": "g30_52", "label": "30/52", "firstEntryCents": 30.0, "hedgeEntryCents": 52.0},
    {"id": "g30_55", "label": "30/55", "firstEntryCents": 30.0, "hedgeEntryCents": 55.0},
    {"id": "g35_35", "label": "35/35", "firstEntryCents": 35.0, "hedgeEntryCents": 35.0},
    {"id": "g40_40", "label": "40/40", "firstEntryCents": 40.0, "hedgeEntryCents": 40.0},
    build_adaptive_strategy_def(),
]


def build_strategy_id(first_entry_cents: float, hedge_entry_cents: float) -> str:
    first_text = f"{first_entry_cents:g}".replace(".", "p")
    hedge_text = f"{hedge_entry_cents:g}".replace(".", "p")
    return f"g{first_text}_{hedge_text}"


def parse_strategy_groups(value: str):
    groups = []
    seen_ids = set()
    for raw_item in str(value or "").split(","):
        item = raw_item.strip()
        if not item:
            continue
        if item.lower() in {"adaptive2", "adaptive", "a40", "adaptive40"}:
            strategy = build_adaptive_strategy_def()
            if strategy["id"] in seen_ids:
                continue
            seen_ids.add(strategy["id"])
            groups.append(strategy)
            continue
        first_text, separator, hedge_text = item.partition("/")
        if separator != "/" or not first_text.strip() or not hedge_text.strip():
            continue
        try:
            first_entry_cents = float(first_text.strip())
            hedge_entry_cents = float(hedge_text.strip())
        except Exception:
            continue
        strategy_id = build_strategy_id(first_entry_cents, hedge_entry_cents)
        if strategy_id in seen_ids:
            continue
        seen_ids.add(strategy_id)
        groups.append(
            {
                "id": strategy_id,
                "label": f"{first_entry_cents:g}/{hedge_entry_cents:g}",
                "firstEntryCents": first_entry_cents,
                "hedgeEntryCents": hedge_entry_cents,
            }
        )
    return groups


DEFAULT_STRATEGY_GROUPS_SPEC = ",".join(
    "adaptive2" if is_adaptive_strategy_def(strategy) else strategy["label"]
    for strategy in DEFAULT_STRATEGY_GROUPS
)
STRATEGY_GROUPS = parse_strategy_groups(
    get_first_env(["ORDER_15M_PAPER_STRATEGIES"], DEFAULT_STRATEGY_GROUPS_SPEC)
) or DEFAULT_STRATEGY_GROUPS


def log(message: str) -> None:
    now = datetime.now(LOG_TZ).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now} {LOG_TIME_ZONE}] {message}", flush=True)


def parse_date(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def format_filename(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace(":", "-").replace(".", "-")


def request_json(url: str, params: Optional[Dict[str, Any]] = None, retries: int = 3) -> Any:
    last_exc = None
    for attempt in range(retries):
        try:
            response = SESSION.get(url, params=params, timeout=20)
            response.raise_for_status()
            return response.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.ChunkedEncodingError) as exc:
            last_exc = exc
            if attempt < retries - 1:
                wait = 2 ** attempt  # exponential backoff: 1s, 2s, 4s
                log(f"Request failed (attempt {attempt + 1}/{retries}), retrying in {wait}s: {exc}")
                time.sleep(wait)
            else:
                raise last_exc
    raise last_exc


def parse_json_array(value):
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return []
    return []


def to_cents(price: float) -> float:
    return round(price * 100, 3)


def align_to_window_start(target: datetime) -> datetime:
    window_ms = WINDOW_MINUTES * 60 * 1000
    aligned_ms = int(target.timestamp() * 1000) // window_ms * window_ms
    return datetime.fromtimestamp(aligned_ms / 1000, tz=UTC)


def slug_candidates_for_date(target: datetime) -> List[str]:
    if SLUG_MODE == "timestamp-start":
        event_start = align_to_window_start(target.astimezone(UTC))
        return [f"{EVENT_PREFIX}{int(event_start.timestamp())}{EVENT_SUFFIX}"]
    local = target.astimezone(NY_TZ)
    month = local.strftime("%B").lower()
    day = str(local.day)
    year = str(local.year)
    hour = local.strftime("%I").lstrip("0") or "12"
    day_period = local.strftime("%p").lower()
    base = f"{EVENT_PREFIX}{month}-{day}-{hour}{day_period}{EVENT_SUFFIX}"
    with_year = f"{EVENT_PREFIX}{month}-{day}-{year}-{hour}{day_period}{EVENT_SUFFIX}"
    return list(dict.fromkeys([with_year, base]))


def build_event_slug(target: datetime) -> str:
    return slug_candidates_for_date(target)[0]


def fetch_event(slug: str):
    payload = request_json(f"{API_BASE}/events", params={"slug": slug, "_ts": int(time.time() * 1000)})
    if isinstance(payload, list):
        return payload[0] if payload else None
    if isinstance(payload, dict):
        return payload
    return None


def extract_outcome_map(market: Dict[str, Any]):
    outcomes = parse_json_array(market.get("outcomes"))
    token_ids = parse_json_array(market.get("clobTokenIds"))
    if len(outcomes) < 2 or len(outcomes) != len(token_ids):
        raise RuntimeError("missing outcomes or token ids")
    pairs = [{"outcome": str(outcomes[idx]), "tokenId": str(token_ids[idx])} for idx in range(len(outcomes))]
    up_entry = next((item for item in pairs if item["outcome"].lower() == "up"), pairs[0])
    down_entry = next(
        (item for item in pairs if item["outcome"].lower() == "down"),
        pairs[1 if pairs[0] == up_entry else 0],
    )
    return {
        "outcomes": [item["outcome"] for item in pairs],
        "upTokenId": up_entry["tokenId"],
        "downTokenId": down_entry["tokenId"],
    }


def build_event_meta(slug: str, event: Dict[str, Any], market: Dict[str, Any]):
    event_end = parse_date(market.get("endDate") or event.get("endDate"))
    event_start = parse_date(
        market.get("eventStartTime") or market.get("startDate") or event.get("startDate")
    )
    if event_start is None and event_end is not None:
        event_start = event_end - timedelta(minutes=WINDOW_MINUTES)
    outcome_map = extract_outcome_map(market)
    return {
        "slug": slug,
        "eventId": event.get("id"),
        "marketId": market.get("id"),
        "eventStart": event_start,
        "eventEnd": event_end,
        "tickSize": str(market.get("orderPriceMinTickSize") or "") or None,
        "orderMinSize": float(market.get("orderMinSize") or 0),
        "negRisk": bool(market.get("negRisk") or event.get("negRisk") or False),
        "marketClosed": bool(market.get("closed")),
        "eventClosed": bool(event.get("closed")),
        **outcome_map,
    }


def resolve_current_event_meta(now: datetime):
    selected = None
    for slug in slug_candidates_for_date(now):
        event = fetch_event(slug)
        if not event or not event.get("markets"):
            continue
        meta = build_event_meta(slug, event, event["markets"][0])
        event_start = meta.get("eventStart")
        event_end = meta.get("eventEnd")
        if event_start is None or event_end is None:
            continue
        if event_start <= now.astimezone(UTC) < event_end:
            return meta
        if selected is None:
            selected = meta
    return selected


def fetch_live_prices(event_state: Dict[str, Any]):
    up_payload = request_json(
        f"{CLOB_BASE}/price",
        params={"token_id": event_state["tokens"]["up"], "side": PRICE_SIDE},
    )
    down_payload = request_json(
        f"{CLOB_BASE}/price",
        params={"token_id": event_state["tokens"]["down"], "side": PRICE_SIDE},
    )
    up_price = float(up_payload["price"])
    down_price = float(down_payload["price"])
    return {
        "upPrice": up_price,
        "downPrice": down_price,
        "upCents": to_cents(up_price),
        "downCents": to_cents(down_price),
    }


def build_strategy_state(strategy_def: Dict[str, Any]):
    if is_adaptive_strategy_def(strategy_def):
        return build_adaptive_strategy_state(strategy_def)
    return {
        "id": strategy_def["id"],
        "label": strategy_def["label"],
        "firstEntryCents": float(strategy_def["firstEntryCents"]),
        "hedgeEntryCents": float(strategy_def["hedgeEntryCents"]),
        "usdPerLeg": USD_PER_LEG,
        "status": "waiting-first",
        "skipReason": None,
        "firstSide": None,
        "firstTriggeredAt": None,
        "firstObservedCents": None,
        "firstShares": None,
        "hedgeSide": None,
        "hedgeTriggeredAt": None,
        "hedgeObservedCents": None,
        "hedgeShares": None,
        "winnerSide": None,
        "totalSpentUsd": 0.0,
        "totalPayoutUsd": 0.0,
        "netPnlUsd": 0.0,
        "resolvedAt": None,
    }


def build_reference_state(event_start: datetime):
    reference_start = event_start - timedelta(minutes=REFERENCE_LOOKBACK_MINUTES)
    reference_end = reference_start + timedelta(minutes=WINDOW_MINUTES)
    reference_slug = build_event_slug(reference_start)
    return {
        "lookbackMinutes": REFERENCE_LOOKBACK_MINUTES,
        "slug": reference_slug,
        "eventStart": reference_start.isoformat(),
        "eventEnd": reference_end.isoformat(),
        "status": "pending",
        "checkedAt": None,
        "winnerSide": None,
        "winnerOutcome": None,
        "outcomePricesCents": None,
    }


def build_event_state(meta: Dict[str, Any], session_label: str):
    event_start = meta["eventStart"]
    event_end = meta["eventEnd"]
    deadline_at = event_start + timedelta(minutes=FIRST_ENTRY_DEADLINE_MINUTES)
    hour_key = f"{meta['slug']}_{event_start.isoformat().replace(':', '-')}"
    return {
        "sessionLabel": session_label,
        "variant": PAPER_VARIANT_ID,
        "slug": meta["slug"],
        "hourKey": hour_key,
        "eventId": meta.get("eventId"),
        "marketId": meta.get("marketId"),
        "eventStart": event_start.isoformat(),
        "eventEnd": event_end.isoformat(),
        "firstEntryDeadlineAt": deadline_at.isoformat(),
        "windowMinutes": WINDOW_MINUTES,
        "sampleIntervalMs": SAMPLE_INTERVAL_MS,
        "usdPerLeg": USD_PER_LEG,
        "sampleCount": 0,
        "firstSampleAt": None,
        "lastSampleAt": None,
        "lastSample": None,
        "tickSize": meta.get("tickSize"),
        "orderMinSize": meta.get("orderMinSize"),
        "negRisk": meta.get("negRisk"),
        "tokens": {
            "up": meta["upTokenId"],
            "down": meta["downTokenId"],
        },
        "reference": build_reference_state(event_start),
        "strategies": {
            strategy_def["id"]: build_strategy_state(strategy_def) for strategy_def in STRATEGY_GROUPS
        },
        "settlement": {
            "status": "pending",
            "checkedAt": None,
            "winnerSide": None,
            "winnerOutcome": None,
            "outcomePricesCents": None,
        },
        "finalizedAt": None,
    }


def write_json_file(file_path: Path, payload) -> None:
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_json_line(file_path: Path, payload) -> None:
    with file_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def ensure_reference_state(event_state: Dict[str, Any]) -> bool:
    event_start = parse_date(event_state.get("eventStart"))
    if event_start is None:
        return False
    reference = event_state.get("reference")
    if (
        isinstance(reference, dict)
        and int(reference.get("lookbackMinutes") or -1) == REFERENCE_LOOKBACK_MINUTES
    ):
        return False
    event_state["reference"] = build_reference_state(event_start)
    return True


def refresh_reference_state(event_state: Dict[str, Any]) -> bool:
    if ensure_reference_state(event_state):
        changed = True
    else:
        changed = False
    reference = event_state.get("reference") or {}
    if reference.get("status") == "resolved":
        return changed
    slug = reference.get("slug")
    if not slug:
        reference["status"] = "missing"
        reference["checkedAt"] = datetime.now(UTC).isoformat()
        return True
    payload = fetch_event(slug)
    if not payload:
        reference["status"] = "missing"
        reference["checkedAt"] = datetime.now(UTC).isoformat()
        return True
    settlement = extract_resolution_snapshot(payload)
    if not settlement:
        return changed
    next_status = settlement["status"]
    next_checked_at = settlement["checkedAt"]
    next_winner_side = settlement["winnerSide"]
    next_winner_outcome = settlement["winnerOutcome"]
    next_prices = settlement["outcomePricesCents"]
    if (
        reference.get("status") == next_status
        and reference.get("winnerSide") == next_winner_side
        and reference.get("winnerOutcome") == next_winner_outcome
        and reference.get("outcomePricesCents") == next_prices
    ):
        reference["checkedAt"] = next_checked_at
        return changed
    reference["status"] = next_status
    reference["checkedAt"] = next_checked_at
    reference["winnerSide"] = next_winner_side
    reference["winnerOutcome"] = next_winner_outcome
    reference["outcomePricesCents"] = next_prices
    return True


def replay_event_strategies(event_state: Dict[str, Any], log_path: Path) -> Dict[str, Any]:
    replay_state = dict(event_state)
    replay_state["strategies"] = {
        strategy_def["id"]: build_strategy_state(strategy_def) for strategy_def in STRATEGY_GROUPS
    }
    for record in read_json_lines(log_path):
        if record.get("type") != "sample":
            continue
        sample_at = parse_date(record.get("ts"))
        if sample_at is None:
            continue
        prices = {
            "upCents": float(record.get("upCents") or 0.0),
            "downCents": float(record.get("downCents") or 0.0),
        }
        for strategy in replay_state["strategies"].values():
            apply_strategy_sample(strategy, prices, sample_at, replay_state)
    settlement = replay_state.get("settlement") or {}
    if settlement.get("status") == "resolved":
        checked_at = settlement.get("checkedAt") or datetime.now(UTC).isoformat()
        winner_side = settlement.get("winnerSide")
        for strategy in replay_state["strategies"].values():
            resolve_strategy(strategy, winner_side, checked_at)
        replay_state["finalizedAt"] = replay_state.get("finalizedAt") or checked_at
    return replay_state["strategies"]


def refresh_session_history(session_state: Dict[str, Any], session_paths: Dict[str, Path]) -> bool:
    changed = False
    for hour_key, event_state in (session_state.get("events") or {}).items():
        event_changed = ensure_reference_state(event_state)
        event_changed = refresh_reference_state(event_state) or event_changed
        log_path = session_paths["logs"] / f"{hour_key}.jsonl"
        if not log_path.exists():
            if event_changed:
                write_event_state(session_paths, event_state)
                changed = True
            continue
        next_strategies = replay_event_strategies(event_state, log_path)
        serialized_next = json.dumps(next_strategies, sort_keys=True, ensure_ascii=False)
        serialized_current = json.dumps(event_state.get("strategies") or {}, sort_keys=True, ensure_ascii=False)
        if serialized_next != serialized_current:
            event_state["strategies"] = next_strategies
            if (event_state.get("settlement") or {}).get("status") == "resolved":
                event_state["finalizedAt"] = (
                    event_state.get("finalizedAt")
                    or (event_state.get("settlement") or {}).get("checkedAt")
                    or datetime.now(UTC).isoformat()
                )
            event_changed = True
        if event_changed:
            write_event_state(session_paths, event_state)
            changed = True
    if changed:
        write_session_files(session_paths, session_state)
    return changed


def pick_first_side(prices: Dict[str, float], threshold_cents: float):
    candidates = []
    if prices["upCents"] <= threshold_cents:
        candidates.append(("up", prices["upCents"]))
    if prices["downCents"] <= threshold_cents:
        candidates.append(("down", prices["downCents"]))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[1], item[0]))
    return candidates[0]


def opposite_side(side: str) -> str:
    return "down" if side == "up" else "up"


def apply_strategy_sample(strategy: Dict[str, Any], prices: Dict[str, float], now: datetime, event_state: Dict[str, Any]):
    changed = False
    event_end = parse_date(event_state.get("eventEnd"))
    deadline_at = parse_date(event_state.get("firstEntryDeadlineAt"))
    if strategy["resolvedAt"]:
        return changed

    if is_adaptive_strategy_state(strategy):
        return apply_adaptive_strategy_sample(
            strategy,
            prices,
            now,
            event_end=event_end,
            deadline_at=deadline_at,
            log_func=log,
            slug=event_state.get("slug"),
        )

    if strategy["firstSide"] is None:
        if deadline_at and now > deadline_at:
            strategy["status"] = "skipped-deadline"
            strategy["skipReason"] = (
                f"no side <= {strategy['firstEntryCents']}c in first "
                f"{FIRST_ENTRY_DEADLINE_MINUTES}m"
            )
            strategy["resolvedAt"] = now.isoformat()
            return True
        pick = pick_first_side(prices, strategy["firstEntryCents"])
        if pick is not None:
            side, observed_cents = pick
            strategy["firstSide"] = side
            strategy["firstTriggeredAt"] = now.isoformat()
            strategy["firstObservedCents"] = observed_cents
            strategy["firstShares"] = round(
                strategy["usdPerLeg"] / (strategy["firstEntryCents"] / 100.0), 6
            )
            strategy["status"] = "first-open"
            changed = True
            log(
                f"{strategy['label']} first {side.upper()} hit at {observed_cents:.3f}c "
                f"for {event_state['slug']}"
            )
    elif strategy["hedgeSide"] is None:
        hedge_side = opposite_side(strategy["firstSide"])
        hedge_cents = prices["upCents"] if hedge_side == "up" else prices["downCents"]
        if hedge_cents <= strategy["hedgeEntryCents"]:
            strategy["hedgeSide"] = hedge_side
            strategy["hedgeTriggeredAt"] = now.isoformat()
            strategy["hedgeObservedCents"] = hedge_cents
            strategy["hedgeShares"] = round(
                strategy["usdPerLeg"] / (strategy["hedgeEntryCents"] / 100.0), 6
            )
            strategy["status"] = "paired-open"
            changed = True
            log(
                f"{strategy['label']} hedge {hedge_side.upper()} hit at {hedge_cents:.3f}c "
                f"for {event_state['slug']}"
            )

    if event_end and now >= event_end and strategy["resolvedAt"] is None and strategy["firstSide"] is None:
        strategy["status"] = "skipped-window-end"
        strategy["skipReason"] = "window ended before first trigger"
        strategy["resolvedAt"] = now.isoformat()
        changed = True

    return changed


def extract_resolution_snapshot(event_payload: Dict[str, Any]):
    market = (event_payload.get("markets") or [None])[0]
    if not isinstance(market, dict):
        return None
    outcomes = parse_json_array(market.get("outcomes"))
    prices = parse_json_array(market.get("outcomePrices"))
    if len(outcomes) < 2 or len(outcomes) != len(prices):
        return None
    outcome_prices_cents = {}
    winner_side = None
    winner_outcome = None
    for outcome, raw_price in zip(outcomes, prices):
        try:
            price = float(raw_price)
        except Exception:
            continue
        label = str(outcome).lower()
        if label == "up":
            outcome_prices_cents["up"] = to_cents(price)
        elif label == "down":
            outcome_prices_cents["down"] = to_cents(price)
        if price >= 0.999 and winner_side is None:
            if label in {"up", "down"}:
                winner_side = label
                winner_outcome = str(outcome)
    if not market.get("closed") or winner_side not in {"up", "down"}:
        return {
            "status": "pending",
            "checkedAt": datetime.now(UTC).isoformat(),
            "winnerSide": None,
            "winnerOutcome": None,
            "outcomePricesCents": outcome_prices_cents or None,
        }
    return {
        "status": "resolved",
        "checkedAt": datetime.now(UTC).isoformat(),
        "winnerSide": winner_side,
        "winnerOutcome": winner_outcome,
        "outcomePricesCents": outcome_prices_cents or None,
    }


def resolve_strategy(strategy: Dict[str, Any], winner_side: Optional[str], checked_at: str):
    if is_adaptive_strategy_state(strategy):
        resolve_adaptive_strategy(strategy, winner_side, checked_at)
        return
    if strategy["resolvedAt"] and strategy["winnerSide"] is not None:
        return
    strategy["winnerSide"] = winner_side
    if strategy["firstSide"] is None:
        strategy["status"] = strategy["status"] if strategy["status"].startswith("skipped") else "no-trade"
        strategy["resolvedAt"] = checked_at
        return
    total_spent = strategy["usdPerLeg"]
    payout = strategy["firstShares"] if winner_side == strategy["firstSide"] else 0.0
    if strategy["hedgeSide"] is not None:
        total_spent += strategy["usdPerLeg"]
        if winner_side == strategy["hedgeSide"]:
            payout = strategy["hedgeShares"]
        strategy["status"] = "resolved-paired"
    else:
        strategy["status"] = "resolved-first-only"
    strategy["totalSpentUsd"] = round(total_spent, 6)
    strategy["totalPayoutUsd"] = round(float(payout), 6)
    strategy["netPnlUsd"] = round(float(payout) - total_spent, 6)
    strategy["resolvedAt"] = checked_at


def build_strategy_bucket(strategy_def: Dict[str, Any]):
    return {
        "id": strategy_def["id"],
        "label": strategy_def["label"],
        "mode": strategy_def.get("mode") or "fixed",
        "firstEntryCents": float(strategy_def["firstEntryCents"]),
        "hedgeEntryCents": float(strategy_def["hedgeEntryCents"]),
        "deepEntryCents": float(strategy_def.get("deepEntryCents") or 0.0),
        "mirrorEntryCents": float(strategy_def.get("mirrorEntryCents") or 0.0),
        "usdPerOrder": float(strategy_def.get("usdPerOrder") or USD_PER_LEG),
        "ruleLines": list(strategy_def.get("ruleLines") or []),
        "eventsSeen": 0,
        "resolvedEvents": 0,
        "noTradeEvents": 0,
        "deadlineMissEvents": 0,
        "firstOnlyEvents": 0,
        "pairedEvents": 0,
        "winningEvents": 0,
        "losingEvents": 0,
        "flatEvents": 0,
        "eventsWithReference": 0,
        "sameAsReferenceEvents": 0,
        "totalSpentUsd": 0.0,
        "totalPayoutUsd": 0.0,
        "totalNetPnlUsd": 0.0,
        "totalNetPnlUsdWhenReferenceUp": 0.0,
        "totalNetPnlUsdWhenReferenceDown": 0.0,
        "lastNetPnlUsd": None,
    }


def build_session_summary(session_state: Dict[str, Any]):
    buckets = {strategy_def["id"]: build_strategy_bucket(strategy_def) for strategy_def in STRATEGY_GROUPS}
    events = list((session_state.get("events") or {}).values())
    reference_summary = {
        "lookbackMinutes": REFERENCE_LOOKBACK_MINUTES,
        "eventsWithResolvedReference": 0,
        "referenceUpEvents": 0,
        "referenceDownEvents": 0,
        "winnerMatchesReferenceEvents": 0,
        "winnerDiffersReferenceEvents": 0,
    }
    for event_state in events:
        reference = event_state.get("reference") or {}
        reference_side = reference.get("winnerSide")
        current_winner = (event_state.get("settlement") or {}).get("winnerSide")
        if reference_side in {"up", "down"}:
            reference_summary["eventsWithResolvedReference"] += 1
            if reference_side == "up":
                reference_summary["referenceUpEvents"] += 1
            else:
                reference_summary["referenceDownEvents"] += 1
            if current_winner in {"up", "down"}:
                if current_winner == reference_side:
                    reference_summary["winnerMatchesReferenceEvents"] += 1
                else:
                    reference_summary["winnerDiffersReferenceEvents"] += 1
        for strategy_id, strategy in (event_state.get("strategies") or {}).items():
            bucket = buckets[strategy_id]
            bucket["eventsSeen"] += 1
            if strategy.get("resolvedAt"):
                bucket["resolvedEvents"] += 1
            order_count = (
                placed_order_count(strategy)
                if is_adaptive_strategy_state(strategy)
                else 0
                if strategy.get("firstSide") is None
                else 1
                if strategy.get("hedgeSide") is None
                else 2
            )
            if order_count == 0:
                bucket["noTradeEvents"] += 1
            elif order_count == 1:
                bucket["firstOnlyEvents"] += 1
            else:
                bucket["pairedEvents"] += 1
            if strategy.get("status") == "skipped-deadline":
                bucket["deadlineMissEvents"] += 1
            net_pnl = float(strategy.get("netPnlUsd") or 0.0)
            bucket["totalSpentUsd"] += float(strategy.get("totalSpentUsd") or 0.0)
            bucket["totalPayoutUsd"] += float(strategy.get("totalPayoutUsd") or 0.0)
            bucket["totalNetPnlUsd"] += net_pnl
            if reference_side == "up":
                bucket["eventsWithReference"] += 1
                bucket["sameAsReferenceEvents"] += int(current_winner == "up")
                bucket["totalNetPnlUsdWhenReferenceUp"] += net_pnl
            elif reference_side == "down":
                bucket["eventsWithReference"] += 1
                bucket["sameAsReferenceEvents"] += int(current_winner == "down")
                bucket["totalNetPnlUsdWhenReferenceDown"] += net_pnl
            if strategy.get("resolvedAt"):
                if net_pnl > 0:
                    bucket["winningEvents"] += 1
                elif net_pnl < 0:
                    bucket["losingEvents"] += 1
                else:
                    bucket["flatEvents"] += 1
                bucket["lastNetPnlUsd"] = net_pnl

    summary_rows = []
    for strategy_def in STRATEGY_GROUPS:
        bucket = buckets[strategy_def["id"]]
        resolved_events = max(1, bucket["resolvedEvents"])
        row = {
            **bucket,
            "totalSpentUsd": round(bucket["totalSpentUsd"], 6),
            "totalPayoutUsd": round(bucket["totalPayoutUsd"], 6),
            "totalNetPnlUsd": round(bucket["totalNetPnlUsd"], 6),
            "totalNetPnlUsdWhenReferenceUp": round(bucket["totalNetPnlUsdWhenReferenceUp"], 6),
            "totalNetPnlUsdWhenReferenceDown": round(bucket["totalNetPnlUsdWhenReferenceDown"], 6),
            "avgNetPnlUsd": round(bucket["totalNetPnlUsd"] / resolved_events, 6),
        }
        summary_rows.append(row)
    ranking = sorted(summary_rows, key=lambda row: (row["totalNetPnlUsd"], row["avgNetPnlUsd"]), reverse=True)
    return {
        "sessionLabel": session_state["sessionLabel"],
        "startedAt": session_state["startedAt"],
        "updatedAt": datetime.now(UTC).isoformat(),
        "variant": PAPER_VARIANT_ID,
        "sampleIntervalMs": SAMPLE_INTERVAL_MS,
        "usdPerLeg": USD_PER_LEG,
        "referenceLookbackMinutes": REFERENCE_LOOKBACK_MINUTES,
        "firstEntryDeadlineMinutes": FIRST_ENTRY_DEADLINE_MINUTES,
        "eventsTracked": len(events),
        "referenceSummary": reference_summary,
        "strategies": summary_rows,
        "ranking": [{"rank": idx + 1, **row} for idx, row in enumerate(ranking)],
    }


def write_event_state(session_paths: Dict[str, Path], event_state: Dict[str, Any]) -> None:
    event_path = session_paths["events"] / f"{event_state['hourKey']}.json"
    write_json_file(event_path, event_state)


def write_session_files(session_paths: Dict[str, Path], session_state: Dict[str, Any]) -> None:
    summary = build_session_summary(session_state)
    write_json_file(session_paths["runtime"], session_state)
    write_json_file(session_paths["summary"], summary)


def log_rankings(session_state: Dict[str, Any]) -> None:
    ranking = build_session_summary(session_state)["ranking"]
    if not ranking:
        return
    top_lines = []
    for row in ranking[:6]:
        top_lines.append(
            f"{row['label']} net=${row['totalNetPnlUsd']:.4f} "
            f"paired={row['pairedEvents']} firstOnly={row['firstOnlyEvents']} noTrade={row['noTradeEvents']}"
        )
    log(f"{PAPER_LOG_PREFIX} ranking | " + " | ".join(top_lines))


def resolve_event_if_ready(session_state: Dict[str, Any], session_paths: Dict[str, Path], event_state: Dict[str, Any]) -> bool:
    if event_state.get("settlement", {}).get("status") == "resolved":
        return False
    event_end = parse_date(event_state.get("eventEnd"))
    if event_end is None or datetime.now(UTC) < event_end:
        return False
    refresh_reference_state(event_state)
    event_payload = fetch_event(event_state["slug"])
    if not event_payload:
        return False
    settlement = extract_resolution_snapshot(event_payload)
    if not settlement:
        return False
    event_state["settlement"] = settlement
    if settlement["status"] != "resolved":
        write_event_state(session_paths, event_state)
        return False
    checked_at = settlement["checkedAt"]
    winner_side = settlement["winnerSide"]
    for strategy in (event_state.get("strategies") or {}).values():
        resolve_strategy(strategy, winner_side, checked_at)
    event_state["finalizedAt"] = checked_at
    write_event_state(session_paths, event_state)
    write_session_files(session_paths, session_state)
    reference_side = (event_state.get("reference") or {}).get("winnerSide")
    log(
        f"Resolved {event_state['slug']} | winner={winner_side} ref{REFERENCE_LOOKBACK_MINUTES}m={reference_side} | "
        + ", ".join(
            f"{strategy['label']}={strategy['netPnlUsd']:+.4f}"
            for strategy in (event_state.get("strategies") or {}).values()
        )
    )
    log_rankings(session_state)
    return True


def sample_event(session_state: Dict[str, Any], session_paths: Dict[str, Path], event_state: Dict[str, Any]) -> None:
    now = datetime.now(UTC)
    prices = fetch_live_prices(event_state)
    event_state["sampleCount"] += 1
    event_state["firstSampleAt"] = event_state.get("firstSampleAt") or now.isoformat()
    event_state["lastSampleAt"] = now.isoformat()
    event_state["lastSample"] = {
        "ts": now.isoformat(),
        "upCents": prices["upCents"],
        "downCents": prices["downCents"],
    }
    refresh_reference_state(event_state)
    waiting_first = 0
    active_positions = 0
    skipped = 0
    resolved = 0
    for strategy in (event_state.get("strategies") or {}).values():
        apply_strategy_sample(strategy, prices, now, event_state)
        if strategy["status"] == "waiting-first":
            waiting_first += 1
        elif strategy["status"] in {"first-open", "paired-open"} or str(strategy["status"]).startswith("adaptive-open"):
            active_positions += 1
        elif strategy["status"].startswith("skipped"):
            skipped += 1
        elif strategy["status"].startswith("resolved") or strategy["status"] == "no-trade":
            resolved += 1
    append_json_line(
        session_paths["logs"] / f"{event_state['hourKey']}.jsonl",
        {
            "ts": now.isoformat(),
            "type": "sample",
            "slug": event_state["slug"],
            "hourKey": event_state["hourKey"],
            "sampleCount": event_state["sampleCount"],
            "referenceWinner": (event_state.get("reference") or {}).get("winnerSide"),
            **prices,
        },
    )
    write_event_state(session_paths, event_state)
    write_session_files(session_paths, session_state)
    log(
        f"{PAPER_LOG_PREFIX} sample {event_state['sampleCount']} | Up {prices['upCents']:.3f}c "
        f"Down {prices['downCents']:.3f}c | waiting={waiting_first} active={active_positions} "
        f"skipped={skipped} resolved={resolved} ref{REFERENCE_LOOKBACK_MINUTES}m="
        f"{(event_state.get('reference') or {}).get('winnerSide')}"
    )


def build_session_paths(session_label: str):
    session_dir = ROOT_DIR / "data" / "orders" / PAPER_OUTPUT_DIR / session_label
    events_dir = session_dir / "events"
    logs_dir = session_dir / "logs"
    ensure_dir(events_dir)
    ensure_dir(logs_dir)
    return {
        "root": session_dir,
        "events": events_dir,
        "logs": logs_dir,
        "runtime": session_dir / "session.json",
        "summary": session_dir / "summary.json",
    }


def read_json_file(file_path: Path):
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def read_json_lines(file_path: Path):
    try:
        content = file_path.read_text(encoding="utf-8").strip()
    except Exception:
        return []
    if not content:
        return []
    rows = []
    for line in content.splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def initialize_session(session_label: str, started_at: datetime, reset: bool = False):
    session_paths = build_session_paths(session_label)
    existing_state = None if reset else read_json_file(session_paths["runtime"])
    if isinstance(existing_state, dict):
        session_state = existing_state
        session_state["sessionLabel"] = session_label
        session_state.setdefault("startedAt", started_at.isoformat())
        session_state.setdefault("events", {})
        session_state["lastProcessStartedAt"] = started_at.isoformat()
    else:
        session_state = {
            "sessionLabel": session_label,
            "startedAt": started_at.isoformat(),
            "lastProcessStartedAt": started_at.isoformat(),
            "events": {},
        }
    refresh_session_history(session_state, session_paths)
    write_session_files(session_paths, session_state)
    return session_state, session_paths


def parse_args(argv: List[str]):
    parser = argparse.ArgumentParser(description=f"{PAPER_LOG_PREFIX} strategy runner")
    parser.add_argument("--session-label", default="", help="Optional explicit session label")
    parser.add_argument(
        "--fresh-session",
        action="store_true",
        help="Start a fresh paper session instead of continuing the rolling cumulative session",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=MAX_SAMPLES_DEFAULT,
        help="Exit after this many samples (0 = run forever)",
    )
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    process_started_at = datetime.now(UTC)
    if args.session_label:
        session_label = args.session_label
    elif args.fresh_session:
        session_label = f"{PAPER_OUTPUT_DIR}-{format_filename(process_started_at)}"
    else:
        session_label = "rolling"
    session_state, session_paths = initialize_session(
        session_label,
        process_started_at,
        reset=args.fresh_session,
    )
    log(
        f"{PAPER_LOG_PREFIX} worker ready | session={session_label} sample={round(SAMPLE_INTERVAL_MS / 1000, 1)}s "
        f"usdPerLeg=${USD_PER_LEG} refLookback={REFERENCE_LOOKBACK_MINUTES}m "
        f"firstDeadline={FIRST_ENTRY_DEADLINE_MINUTES}m "
        f"groups={','.join(strategy['label'] for strategy in STRATEGY_GROUPS)}"
    )
    log(f"{PAPER_LOG_PREFIX} data dir: {session_paths['root']}")

    active_hour_key = None
    skipped_partial_window_logged = False
    sample_counter = 0

    while True:
        now = datetime.now(UTC)
        try:
            meta = resolve_current_event_meta(now)
        except Exception as exc:
            log(f"{PAPER_LOG_PREFIX} event lookup failed: {exc}")
            time.sleep(max(1.0, SAMPLE_INTERVAL_MS / 1000))
            continue

        if meta is None:
            time.sleep(max(1.0, SAMPLE_INTERVAL_MS / 1000))
            continue

        hour_key = f"{meta['slug']}_{meta['eventStart'].isoformat().replace(':', '-')}"
        event_state = session_state["events"].get(hour_key)

        if event_state is None and meta["eventStart"] < process_started_at:
            if not skipped_partial_window_logged:
                log(
                    f"Current {WINDOW_LABEL} window {meta['slug']} started at {meta['eventStart'].isoformat()} "
                    f"before this process started. Waiting for the next full {WINDOW_LABEL} window."
                )
                skipped_partial_window_logged = True
            time.sleep(max(1.0, SAMPLE_INTERVAL_MS / 1000))
            continue

        if event_state is None:
            event_state = build_event_state(meta, session_label)
            refresh_reference_state(event_state)
            session_state["events"][hour_key] = event_state
            write_event_state(session_paths, event_state)
            write_session_files(session_paths, session_state)
            active_hour_key = hour_key
            skipped_partial_window_logged = False
            log(
                f"Started {PAPER_LOG_PREFIX} event {meta['slug']} | "
                f"{meta['eventStart'].astimezone(LOG_TZ).strftime('%H:%M:%S')} -> "
                f"{meta['eventEnd'].astimezone(LOG_TZ).strftime('%H:%M:%S')} | "
                f"ref{REFERENCE_LOOKBACK_MINUTES}m={(event_state.get('reference') or {}).get('winnerSide')}"
            )
        else:
            active_hour_key = hour_key

        try:
            sample_event(session_state, session_paths, event_state)
            sample_counter += 1
        except Exception as exc:
            log(f"{PAPER_LOG_PREFIX} sample failed for {event_state['slug']}: {exc}")

        for pending_hour_key, pending_state in list((session_state.get("events") or {}).items()):
            if pending_hour_key == active_hour_key or pending_state.get("settlement", {}).get("status") == "resolved":
                continue
            try:
                resolve_event_if_ready(session_state, session_paths, pending_state)
            except Exception as exc:
                log(f"{PAPER_LOG_PREFIX} resolve failed for {pending_state['slug']}: {exc}")

        try:
            resolve_event_if_ready(session_state, session_paths, event_state)
        except Exception as exc:
            log(f"{PAPER_LOG_PREFIX} resolve failed for {event_state['slug']}: {exc}")

        if args.max_samples > 0 and sample_counter >= args.max_samples:
            log(f"{PAPER_LOG_PREFIX} reached max samples={args.max_samples}; exiting.")
            return 0

        time.sleep(max(1.0, SAMPLE_INTERVAL_MS / 1000))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
