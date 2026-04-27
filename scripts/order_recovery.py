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
EPSILON = 1e-9


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
        os.environ[key] = value


for env_name in (
    ".env.order.recovery.local",
    ".env.order.recovery",
    ".env.order.local",
    ".env.order",
    ".env.local",
    ".env",
):
    load_env_file(ROOT_DIR / env_name)


def get_first_env(keys: List[str], fallback: str = "") -> str:
    for key in keys:
        value = os.getenv(key)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return fallback


def parse_bool(value: Optional[str], default: bool = False) -> bool:
    if value in (None, ""):
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_float(value: Optional[str], fallback: float) -> float:
    try:
        parsed = float(str(value))
        return parsed if parsed > 0 else fallback
    except Exception:
        return fallback


def parse_nonnegative_float(value: Optional[str], fallback: float) -> float:
    try:
        parsed = float(str(value))
        return parsed if parsed >= 0 else fallback
    except Exception:
        return fallback


def parse_int(value: Optional[str], fallback: int) -> int:
    try:
        parsed = int(float(str(value)))
        return parsed if parsed > 0 else fallback
    except Exception:
        return fallback


RECOVERY_CONFIG_PATH = ROOT_DIR / "data" / "orders_recovery" / "config.json"
RECOVERY_ENTRY_MODES = {"limit-pair", "trigger-threshold"}
DEFAULT_RECOVERY_ENTRY_MODE = "limit-pair"

VARIANT = get_first_env(["RECOVERY_VARIANT", "ORDER_VARIANT"], "15m").strip().lower()
VARIANT_SCOPE = {"15m": "15M", "1h": "1H", "4h": "4H"}.get(VARIANT, VARIANT.upper())
VARIANT_LABEL = {"15m": "15分钟", "1h": "1小时", "4h": "4小时"}.get(VARIANT, VARIANT.upper())
VARIANT_SHORT = {"15m": "15M", "1h": "1H", "4h": "4H"}.get(VARIANT, VARIANT.upper())
VARIANT_EVENT_PREFIX = {
    "15m": "btc-updown-15m-",
    "1h": "bitcoin-up-or-down-",
    "4h": "btc-updown-4h-",
}.get(VARIANT)
VARIANT_DEFAULTS = {
    "15m": {
        "sampleIntervalMs": 5000,
        "thresholdCents": 38,
        "retryGapMs": 60000,
        "firstEntryDeadlineMinutes": 7.5,
        "recoveryTriggerLosses": 5,
    },
    "1h": {
        "sampleIntervalMs": 5000,
        "thresholdCents": 38,
        "retryGapMs": 60000,
        "firstEntryDeadlineMinutes": 30,
        "recoveryTriggerLosses": 4,
    },
    "4h": {
        "sampleIntervalMs": 15000,
        "thresholdCents": 38,
        "retryGapMs": 60000,
        "firstEntryDeadlineMinutes": 120,
        "recoveryTriggerLosses": 3,
    },
}
VARIANT_CONFIG = VARIANT_DEFAULTS.get(VARIANT, VARIANT_DEFAULTS["15m"])

ORDER_DRY_RUN = parse_bool(os.getenv("RECOVERY_DRY_RUN"), True)
os.environ["ORDER_VARIANT"] = VARIANT
os.environ["ORDER_DRY_RUN"] = "true" if ORDER_DRY_RUN else "false"
os.environ["ORDER_EXECUTION_TYPE"] = get_first_env(
    ["RECOVERY_EXECUTION_TYPE", "ORDER_EXECUTION_TYPE"],
    "FAK",
).upper()
os.environ["ORDER_PRICE_SIDE"] = get_first_env(
    ["RECOVERY_PRICE_SIDE", "ORDER_PRICE_SIDE"],
    "BUY",
).upper()
os.environ["ORDER_MIN_BALANCE_USD"] = get_first_env(
    ["RECOVERY_WALLET_MIN_BALANCE_USD", "ORDER_MIN_BALANCE_USD"],
    "1",
)

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts import order as legacy  # noqa: E402


def variant_env(name: str, fallback: str) -> str:
    return get_first_env(
        [f"RECOVERY_{VARIANT_SCOPE}_{name}", f"RECOVERY_{name}"],
        fallback,
    )


def normalize_recovery_entry_mode(value: Any, fallback: Optional[str] = None) -> str:
    text = str(value or "").strip().lower()
    return text if text in RECOVERY_ENTRY_MODES else (fallback or DEFAULT_RECOVERY_ENTRY_MODE)


def normalize_base_multiplier(value: Any, fallback: int) -> int:
    try:
        parsed = int(round(float(value)))
    except Exception:
        return fallback
    return min(5, max(1, parsed))


def load_recovery_runtime_config() -> Dict[str, Any]:
    default_entry_mode = normalize_recovery_entry_mode(
        variant_env("ENTRY_MODE", DEFAULT_RECOVERY_ENTRY_MODE),
        DEFAULT_RECOVERY_ENTRY_MODE,
    )
    default_base_multiplier = normalize_base_multiplier(variant_env("BASE_LEG_USD", "1"), 1)
    config: Dict[str, Any] = {
        "entryMode": default_entry_mode,
        "baseMultiplier": default_base_multiplier,
    }
    try:
        payload = json.loads(RECOVERY_CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            config["entryMode"] = normalize_recovery_entry_mode(
                payload.get("entryMode"),
                default_entry_mode,
            )
            config["baseMultiplier"] = normalize_base_multiplier(
                payload.get("baseMultiplier"),
                default_base_multiplier,
            )
    except Exception:
        pass
    config["baseLegUsd"] = float(config["baseMultiplier"])
    config["recoveryLegUsd"] = float(config["baseMultiplier"] * 2)
    return config


RECOVERY_RUNTIME_CONFIG = load_recovery_runtime_config()
ENTRY_MODE = RECOVERY_RUNTIME_CONFIG["entryMode"]
BASE_MULTIPLIER = int(RECOVERY_RUNTIME_CONFIG["baseMultiplier"])
START_BALANCE_USD = parse_float(variant_env("START_BALANCE_USD", "5"), 5.0)
BASE_LEG_USD = float(RECOVERY_RUNTIME_CONFIG["baseLegUsd"])
RECOVERY_LEG_USD = float(RECOVERY_RUNTIME_CONFIG["recoveryLegUsd"])
MIN_EVENT_BALANCE_USD = parse_float(variant_env("MIN_EVENT_BALANCE_USD", "4"), 4.0)
RESTART_DELAY_HOURS = parse_float(variant_env("RESTART_DELAY_HOURS", "12"), 12.0)
MAX_BANKROLL_TRANCHES = max(1, parse_int(variant_env("MAX_BANKROLL_TRANCHES", "3"), 3))
PROFIT_WITHDRAW_RATE = min(
    1.0,
    max(0.0, parse_float(variant_env("PROFIT_WITHDRAW_RATE", "0.10"), 0.10)),
)
THRESHOLD_CENTS = parse_float(
    variant_env("THRESHOLD_CENTS", str(VARIANT_CONFIG["thresholdCents"])),
    float(VARIANT_CONFIG["thresholdCents"]),
)
SAMPLE_INTERVAL_MS = parse_int(
    variant_env("SAMPLE_INTERVAL_MS", str(VARIANT_CONFIG["sampleIntervalMs"])),
    int(VARIANT_CONFIG["sampleIntervalMs"]),
)
RETRY_GAP_MS = parse_int(
    variant_env("RETRY_GAP_MS", str(VARIANT_CONFIG["retryGapMs"])),
    int(VARIANT_CONFIG["retryGapMs"]),
)
FIRST_ENTRY_DEADLINE_MINUTES = parse_float(
    variant_env(
        "FIRST_ENTRY_DEADLINE_MINUTES",
        str(VARIANT_CONFIG["firstEntryDeadlineMinutes"]),
    ),
    float(VARIANT_CONFIG["firstEntryDeadlineMinutes"]),
)
RECOVERY_TRIGGER_LOSSES = parse_int(
    variant_env(
        "RECOVERY_TRIGGER_LOSSES",
        str(VARIANT_CONFIG["recoveryTriggerLosses"]),
    ),
    int(VARIANT_CONFIG["recoveryTriggerLosses"]),
)
LOG_EVERY_SAMPLES = parse_int(variant_env("LOG_EVERY_SAMPLES", "1"), 1)
MAX_HISTORY_ITEMS = parse_int(variant_env("MAX_HISTORY_ITEMS", "240"), 240)
RESOLUTION_RETRY_MS = parse_int(variant_env("RESOLUTION_RETRY_MS", "15000"), 15000)
POSITION_CONFIRM_DELAY_MS = parse_int(variant_env("POSITION_CONFIRM_DELAY_MS", "1500"), 1500)
TRIGGER_ORDER_CHUNK_USD = max(
    0.1,
    parse_float(variant_env("TRIGGER_ORDER_CHUNK_USD", "1"), 1.0),
)
REQUIRE_ORDER_ID_CONFIRMATION = parse_bool(
    variant_env("REQUIRE_ORDER_ID_CONFIRMATION", "true"),
    True,
)
LIMIT_FALLBACK_ENABLED = parse_bool(
    variant_env("LIMIT_FALLBACK_ENABLED", "true"),
    True,
)
LIMIT_FALLBACK_PRICE_CENTS = parse_float(
    variant_env("LIMIT_FALLBACK_PRICE_CENTS", str(THRESHOLD_CENTS)),
    THRESHOLD_CENTS,
)
LIMIT_FALLBACK_EXPIRY_BUFFER_SECONDS = parse_int(
    variant_env("LIMIT_FALLBACK_EXPIRY_BUFFER_SECONDS", "60"),
    60,
)
STARTUP_LIMIT_DELAY_MINUTES = parse_nonnegative_float(
    variant_env("STARTUP_LIMIT_DELAY_MINUTES", "5" if VARIANT == "4h" else "0"),
    5.0 if VARIANT == "4h" else 0.0,
)
PRESTART_ONLY_ENABLED = parse_bool(
    variant_env("PRESTART_ONLY_ENABLED", "true" if VARIANT == "4h" else "false"),
    VARIANT == "4h",
)
PRESTART_ENTRY_LEAD_MINUTES = parse_nonnegative_float(
    variant_env("PRESTART_ENTRY_LEAD_MINUTES", "5" if VARIANT == "4h" else "0"),
    5.0 if VARIANT == "4h" else 0.0,
)
PRESTART_ENTRY_WINDOW_SECONDS = parse_int(
    variant_env("PRESTART_ENTRY_WINDOW_SECONDS", "90"),
    90,
)
LIMIT_PARTIAL_MARKET_TOP_UP_ENABLED = False
LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD = parse_float(
    variant_env("LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD", "0.5"),
    0.5,
)
LIMIT_PARTIAL_TOP_UP_MIN_ORDER_USD = parse_float(
    variant_env("LIMIT_PARTIAL_TOP_UP_MIN_ORDER_USD", "1"),
    1.0,
)
LIMIT_PARTIAL_TOP_UP_PRICE_CAP_CENTS = parse_float(
    variant_env("LIMIT_PARTIAL_TOP_UP_PRICE_CAP_CENTS", "99"),
    99.0,
)
MAX_EVENT_TOTAL_SPEND_USD = parse_float(
    variant_env("MAX_EVENT_TOTAL_SPEND_USD", str(max(BASE_LEG_USD, RECOVERY_LEG_USD) * 2.0)),
    max(BASE_LEG_USD, RECOVERY_LEG_USD) * 2.0,
)

DATA_ROOT = ROOT_DIR / "data" / "orders_recovery"
RUNTIME_DIR = DATA_ROOT / "runtime"
REPORTS_DIR = DATA_ROOT / "reports"
LOGS_DIR = DATA_ROOT / "logs"
LOCKS_DIR = ROOT_DIR / "data" / "locks"
LOCK_PATH = LOCKS_DIR / f"order-recovery-{VARIANT}.lock.json"
RUNTIME_PATH = RUNTIME_DIR / f"runtime-state-{VARIANT}.json"
GROUP_SUMMARY_PATH = REPORTS_DIR / f"group-summary-{VARIANT}.json"
EVENT_DETAILS_PATH = REPORTS_DIR / f"event-details-{VARIANT}.json"
TRADE_DETAILS_PATH = REPORTS_DIR / f"trade-details-{VARIANT}.json"


def uses_limit_pair_entry_mode() -> bool:
    return ENTRY_MODE == "limit-pair"


def uses_trigger_threshold_entry_mode() -> bool:
    return ENTRY_MODE == "trigger-threshold"


def event_entry_mode(event: Optional[Dict[str, Any]]) -> str:
    if isinstance(event, dict):
        return normalize_recovery_entry_mode(event.get("entryMode"))
    return ENTRY_MODE


def event_uses_limit_pair_entry_mode(event: Optional[Dict[str, Any]]) -> bool:
    return event_entry_mode(event) == "limit-pair"


def event_uses_trigger_threshold_entry_mode(event: Optional[Dict[str, Any]]) -> bool:
    return event_entry_mode(event) == "trigger-threshold"


def ensure_dir(dir_path: Path) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)


def round_money(value: float) -> float:
    return round(float(value) + 0.0, 6)


def now_utc() -> datetime:
    return datetime.now(UTC)


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return legacy.parse_date(value)
    except Exception:
        return None


def format_log_timestamp(value: datetime) -> str:
    return value.astimezone(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")


def log(message: str) -> None:
    print(f"[{format_log_timestamp(now_utc())}] [{VARIANT_SHORT}] {message}", flush=True)


def read_json_file(file_path: Path) -> Any:
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_json_file(file_path: Path, payload: Any) -> None:
    ensure_dir(file_path.parent)
    temp_path = file_path.with_suffix(file_path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(file_path)


def append_history_row(file_path: Path, row: Dict[str, Any], limit: int) -> None:
    existing = read_json_file(file_path)
    items = existing if isinstance(existing, list) else []
    items.insert(0, row)
    write_json_file(file_path, items[:limit])


def upsert_history_row(
    file_path: Path,
    row: Dict[str, Any],
    limit: int,
    identity_keys: List[str],
) -> None:
    existing = read_json_file(file_path)
    items = existing if isinstance(existing, list) else []
    row_identity = tuple(row.get(key) for key in identity_keys)
    filtered: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_identity = tuple(item.get(key) for key in identity_keys)
        if item_identity == row_identity:
            continue
        filtered.append(item)
    filtered.insert(0, row)
    write_json_file(file_path, filtered[:limit])


def parse_json_array(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def trim_text(value: Any, limit: int = 260) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:limit]


def event_log_path(event: Dict[str, Any]) -> Path:
    safe_start = str(event["eventStart"]).replace(":", "-")
    return LOGS_DIR / f"{VARIANT}_{event['slug']}_{safe_start}.jsonl"


def write_event_log(event: Dict[str, Any], action: str, payload: Optional[Dict[str, Any]] = None) -> None:
    ensure_dir(LOGS_DIR)
    record = {
        "ts": now_utc().isoformat(),
        "variant": VARIANT,
        "eventKey": event["eventKey"],
        "slug": event["slug"],
        "action": action,
    }
    if payload:
        record.update(payload)
    with event_log_path(event).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def pid_is_running(pid: Optional[int]) -> bool:
    if not pid or pid <= 0 or pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_lock() -> None:
    ensure_dir(LOCKS_DIR)
    existing = read_json_file(LOCK_PATH)
    if isinstance(existing, dict) and pid_is_running(int(existing.get("pid") or 0)):
        raise RuntimeError(f"{VARIANT} recovery worker already running (pid={existing['pid']})")
    write_json_file(
        LOCK_PATH,
        {
            "pid": os.getpid(),
            "variant": VARIANT,
            "startedAt": now_utc().isoformat(),
        },
    )


def release_lock() -> None:
    try:
        current = read_json_file(LOCK_PATH)
        if isinstance(current, dict) and int(current.get("pid") or 0) == os.getpid():
            LOCK_PATH.unlink(missing_ok=True)
    except Exception:
        pass


atexit.register(release_lock)


def group_leg_size(group: Dict[str, Any]) -> float:
    return RECOVERY_LEG_USD if group.get("recoveryMode") else BASE_LEG_USD


def create_default_group_state() -> Dict[str, Any]:
    started_at = now_utc().isoformat()
    return {
        "variant": VARIANT,
        "label": VARIANT_LABEL,
        "status": "active",
        "startBalanceUsd": round_money(START_BALANCE_USD),
        "trancheSizeUsd": round_money(START_BALANCE_USD),
        "tranchesUsed": 1,
        "maxTranches": MAX_BANKROLL_TRANCHES,
        "restartDelayHours": RESTART_DELAY_HOURS,
        "profitWithdrawRate": PROFIT_WITHDRAW_RATE,
        "withdrawnProfitUsd": 0.0,
        "totalCommittedUsd": round_money(START_BALANCE_USD),
        "lastTopUpAt": started_at,
        "nextRestartAt": None,
        "stoppedAt": None,
        "balanceUsd": round_money(START_BALANCE_USD),
        "realizedNetPnlUsd": 0.0,
        "peakBalanceUsd": round_money(START_BALANCE_USD),
        "maxDrawdownUsd": 0.0,
        "baseLegUsd": round_money(BASE_LEG_USD),
        "recoveryLegUsd": round_money(RECOVERY_LEG_USD),
        "minEventBalanceUsd": round_money(MIN_EVENT_BALANCE_USD),
        "currentLegUsd": round_money(BASE_LEG_USD),
        "thresholdCents": THRESHOLD_CENTS,
        "sampleIntervalMs": SAMPLE_INTERVAL_MS,
        "retryGapMs": RETRY_GAP_MS,
        "firstEntryDeadlineMinutes": FIRST_ENTRY_DEADLINE_MINUTES,
        "recoveryTriggerLosses": RECOVERY_TRIGGER_LOSSES,
        "totalEvents": 0,
        "tradedEvents": 0,
        "skippedEvents": 0,
        "winningEvents": 0,
        "losingEvents": 0,
        "flatEvents": 0,
        "currentLossStreak": 0,
        "lossStreakAnchorPnlUsd": None,
        "lossStreakAnchorEventKey": None,
        "recoveryMode": False,
        "recoveryAnchorPnlUsd": None,
        "recoveryAnchorEventKey": None,
        "recoveryPnlSinceAnchorUsd": 0.0,
        "recoveryStartedAt": None,
        "pausedAt": None,
        "pauseReason": None,
        "lastResolvedEventKey": None,
        "lastResolvedAt": None,
        "updatedAt": now_utc().isoformat(),
    }


def sanitize_group_state(payload: Any) -> Dict[str, Any]:
    group = create_default_group_state()
    if isinstance(payload, dict):
        group.update(payload)
    group["variant"] = VARIANT
    group["label"] = VARIANT_LABEL
    group["trancheSizeUsd"] = round_money(float(group.get("trancheSizeUsd") or START_BALANCE_USD))
    group["tranchesUsed"] = max(1, int(group.get("tranchesUsed") or 1))
    group["maxTranches"] = max(1, int(group.get("maxTranches") or MAX_BANKROLL_TRANCHES))
    group["restartDelayHours"] = float(group.get("restartDelayHours") or RESTART_DELAY_HOURS)
    group["profitWithdrawRate"] = min(
        1.0,
        max(0.0, float(group.get("profitWithdrawRate") or PROFIT_WITHDRAW_RATE)),
    )
    group["withdrawnProfitUsd"] = round_money(float(group.get("withdrawnProfitUsd") or 0.0))
    group["totalCommittedUsd"] = round_money(
        float(group.get("totalCommittedUsd") or 0.0)
        or float(group["trancheSizeUsd"]) * float(group["tranchesUsed"])
    )
    group["startBalanceUsd"] = round_money(float(group.get("startBalanceUsd") or group["trancheSizeUsd"]))
    group["balanceUsd"] = round_money(float(group.get("balanceUsd") or 0.0))
    group["realizedNetPnlUsd"] = round_money(float(group.get("realizedNetPnlUsd") or 0.0))
    group["peakBalanceUsd"] = round_money(float(group.get("peakBalanceUsd") or max(float(group["balanceUsd"]), 0.0)))
    group["maxDrawdownUsd"] = round_money(float(group.get("maxDrawdownUsd") or 0.0))
    group["baseLegUsd"] = round_money(BASE_LEG_USD)
    group["recoveryLegUsd"] = round_money(RECOVERY_LEG_USD)
    group["minEventBalanceUsd"] = round_money(MIN_EVENT_BALANCE_USD)
    group["thresholdCents"] = THRESHOLD_CENTS
    group["sampleIntervalMs"] = SAMPLE_INTERVAL_MS
    group["retryGapMs"] = RETRY_GAP_MS
    group["firstEntryDeadlineMinutes"] = FIRST_ENTRY_DEADLINE_MINUTES
    group["recoveryTriggerLosses"] = RECOVERY_TRIGGER_LOSSES
    group["currentLegUsd"] = round_money(group_leg_size(group))
    return group


def current_available_cash(group: Dict[str, Any], active_event: Optional[Dict[str, Any]]) -> float:
    reserved = float(active_event.get("spentUsd") or 0.0) if active_event else 0.0
    return round_money(max(0.0, float(group.get("balanceUsd") or 0.0) - reserved))


def clear_recovery_cycle(group: Dict[str, Any]) -> None:
    group["currentLossStreak"] = 0
    group["lossStreakAnchorPnlUsd"] = None
    group["lossStreakAnchorEventKey"] = None
    group["recoveryMode"] = False
    group["recoveryAnchorPnlUsd"] = None
    group["recoveryAnchorEventKey"] = None
    group["recoveryPnlSinceAnchorUsd"] = 0.0
    group["recoveryStartedAt"] = None


def schedule_group_cooldown(group: Dict[str, Any]) -> None:
    paused_at = parse_iso(group.get("pausedAt")) or now_utc()
    group["pausedAt"] = paused_at.isoformat()
    group["balanceUsd"] = round_money(max(0.0, float(group.get("balanceUsd") or 0.0)))
    if int(group.get("tranchesUsed") or 1) >= int(group.get("maxTranches") or MAX_BANKROLL_TRANCHES):
        group["status"] = "stopped"
        group["pauseReason"] = "max-tranches-exhausted"
        group["nextRestartAt"] = None
        group["stoppedAt"] = group.get("stoppedAt") or paused_at.isoformat()
        return
    restart_at = parse_iso(group.get("nextRestartAt"))
    if restart_at is None:
        restart_at = paused_at + timedelta(hours=float(group.get("restartDelayHours") or RESTART_DELAY_HOURS))
    group["status"] = "paused"
    group["pauseReason"] = "bankroll-cooldown"
    group["nextRestartAt"] = restart_at.isoformat()
    group["stoppedAt"] = None


def maybe_reactivate_group(group: Dict[str, Any]) -> bool:
    if group.get("status") != "paused":
        return False
    next_restart = parse_iso(group.get("nextRestartAt"))
    if next_restart is None or now_utc() + timedelta(seconds=1) < next_restart:
        return False
    used = int(group.get("tranchesUsed") or 1)
    max_tranches = int(group.get("maxTranches") or MAX_BANKROLL_TRANCHES)
    if used >= max_tranches:
        group["status"] = "stopped"
        group["pauseReason"] = "max-tranches-exhausted"
        group["nextRestartAt"] = None
        group["stoppedAt"] = group.get("stoppedAt") or now_utc().isoformat()
        return False
    tranche_size = round_money(float(group.get("trancheSizeUsd") or START_BALANCE_USD))
    group["tranchesUsed"] = used + 1
    group["totalCommittedUsd"] = round_money(float(group.get("totalCommittedUsd") or 0.0) + tranche_size)
    group["balanceUsd"] = tranche_size
    group["peakBalanceUsd"] = round_money(max(float(group.get("peakBalanceUsd") or 0.0), tranche_size))
    group["status"] = "active"
    group["pausedAt"] = None
    group["pauseReason"] = None
    group["nextRestartAt"] = None
    group["stoppedAt"] = None
    group["lastTopUpAt"] = now_utc().isoformat()
    clear_recovery_cycle(group)
    group["updatedAt"] = now_utc().isoformat()
    return True


def update_pause_state(group: Dict[str, Any]) -> None:
    required = group_leg_size(group)
    if str(group.get("status") or "") == "stopped" or group.get("pauseReason") == "max-tranches-exhausted":
        group["status"] = "stopped"
        group["nextRestartAt"] = None
        group["stoppedAt"] = group.get("stoppedAt") or now_utc().isoformat()
    elif float(group.get("balanceUsd") or 0.0) <= EPSILON:
        schedule_group_cooldown(group)
    elif str(group.get("status") or "") == "paused" and parse_iso(group.get("nextRestartAt")):
        group["status"] = "paused"
        group["pauseReason"] = group.get("pauseReason") or "bankroll-cooldown"
    else:
        group["status"] = "active"
        group["pausedAt"] = None
        group["pauseReason"] = None
        group["nextRestartAt"] = None
        group["stoppedAt"] = None
    group["currentLegUsd"] = round_money(required)


def get_wallet_balance_status(trader) -> Dict[str, Any]:
    if hasattr(trader, "get_balance_status"):
        status = trader.get_balance_status() or {}
        return {
            "balance": round_money(float(status.get("balance") or 0.0)),
            "allowance": None
            if status.get("allowance") is None
            else round_money(float(status.get("allowance") or 0.0)),
            "checkedAt": now_utc().isoformat(),
        }
    return {
        "balance": 0.0,
        "allowance": None,
        "checkedAt": now_utc().isoformat(),
    }


def refresh_runtime_wallet_status(runtime: Dict[str, Any], trader) -> Dict[str, Any]:
    try:
        status = get_wallet_balance_status(trader)
        runtime["wallet"] = {
            "balanceUsd": status["balance"],
            "allowanceUsd": status["allowance"],
            "checkedAt": status["checkedAt"],
            "lastError": None,
            "lastErrorAt": None,
        }
    except Exception as exc:
        wallet = runtime.get("wallet") if isinstance(runtime.get("wallet"), dict) else {}
        if not wallet:
            raise
        wallet["lastError"] = trim_text(exc)
        wallet["lastErrorAt"] = now_utc().isoformat()
        runtime["wallet"] = wallet
    return runtime["wallet"]


def wallet_below_minimum(runtime: Dict[str, Any]) -> bool:
    wallet = runtime.get("wallet") if isinstance(runtime.get("wallet"), dict) else {}
    return float(wallet.get("balanceUsd") or 0.0) + EPSILON < MIN_EVENT_BALANCE_USD


def ensure_funds_or_use_cached(runtime: Dict[str, Any], trader, required_usd: float) -> Optional[Dict[str, Any]]:
    if not hasattr(trader, "ensure_funds"):
        return None
    try:
        fund_status = trader.ensure_funds(required_usd)
        if isinstance(fund_status, dict):
            runtime["wallet"] = {
                "balanceUsd": round_money(float(fund_status.get("balance") or 0.0)),
                "allowanceUsd": None
                if fund_status.get("allowance") is None
                else round_money(float(fund_status.get("allowance") or 0.0)),
                "checkedAt": now_utc().isoformat(),
                "lastError": None,
                "lastErrorAt": None,
            }
        return fund_status if isinstance(fund_status, dict) else None
    except Exception as exc:
        wallet = runtime.get("wallet") if isinstance(runtime.get("wallet"), dict) else {}
        cached_balance = float(wallet.get("balanceUsd") or 0.0)
        wallet["lastError"] = trim_text(exc)
        wallet["lastErrorAt"] = now_utc().isoformat()
        runtime["wallet"] = wallet
        if cached_balance + EPSILON >= max(float(required_usd), MIN_EVENT_BALANCE_USD):
            return {
                "balance": cached_balance,
                "allowance": wallet.get("allowanceUsd"),
                "cachedAfterError": True,
                "error": trim_text(exc),
            }
        raise


def create_default_runtime_state() -> Dict[str, Any]:
    group = create_default_group_state()
    update_pause_state(group)
    return {
        "version": 2,
        "variant": VARIANT,
        "label": VARIANT_LABEL,
        "mode": "dry-run" if ORDER_DRY_RUN else "live",
        "workerPid": os.getpid(),
        "strategy": {
            "entryMode": ENTRY_MODE,
            "baseMultiplier": BASE_MULTIPLIER,
            "thresholdCents": THRESHOLD_CENTS,
            "baseLegUsd": BASE_LEG_USD,
            "recoveryLegUsd": RECOVERY_LEG_USD,
            "minEventBalanceUsd": MIN_EVENT_BALANCE_USD,
            "restartDelayHours": RESTART_DELAY_HOURS,
            "maxBankrollTranches": MAX_BANKROLL_TRANCHES,
            "profitWithdrawRate": PROFIT_WITHDRAW_RATE,
            "firstEntryDeadlineMinutes": FIRST_ENTRY_DEADLINE_MINUTES,
            "retryGapMs": RETRY_GAP_MS,
            "sampleIntervalMs": SAMPLE_INTERVAL_MS,
            "recoveryTriggerLosses": RECOVERY_TRIGGER_LOSSES,
            "executionType": "LIMIT" if uses_limit_pair_entry_mode() else "TRIGGER",
            "requireOrderIdConfirmation": REQUIRE_ORDER_ID_CONFIRMATION,
            "limitFallbackEnabled": LIMIT_FALLBACK_ENABLED,
            "limitFallbackPriceCents": LIMIT_FALLBACK_PRICE_CENTS,
            "startupLimitDelayMinutes": STARTUP_LIMIT_DELAY_MINUTES,
            "prestartOnlyEnabled": PRESTART_ONLY_ENABLED,
            "prestartEntryLeadMinutes": PRESTART_ENTRY_LEAD_MINUTES,
            "prestartEntryWindowSeconds": PRESTART_ENTRY_WINDOW_SECONDS,
            "limitPartialMarketTopUpEnabled": LIMIT_PARTIAL_MARKET_TOP_UP_ENABLED,
            "limitPartialTopUpMinGapUsd": LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD,
            "limitPartialTopUpMinOrderUsd": LIMIT_PARTIAL_TOP_UP_MIN_ORDER_USD,
            "limitPartialTopUpPriceCapCents": LIMIT_PARTIAL_TOP_UP_PRICE_CAP_CENTS,
            "maxEventTotalSpendUsd": MAX_EVENT_TOTAL_SPEND_USD,
        },
        "group": group,
        "wallet": {
            "balanceUsd": None,
            "allowanceUsd": None,
            "checkedAt": None,
        },
        "activeEvent": None,
        "lastEvaluatedEventKey": None,
        "lastSkipReason": None,
        "lastUpdatedAt": now_utc().isoformat(),
    }


def load_runtime_state() -> Dict[str, Any]:
    payload = read_json_file(RUNTIME_PATH)
    runtime = create_default_runtime_state()
    if isinstance(payload, dict):
        runtime.update(payload)
    runtime["strategy"] = {
        "entryMode": ENTRY_MODE,
        "baseMultiplier": BASE_MULTIPLIER,
        "thresholdCents": THRESHOLD_CENTS,
        "baseLegUsd": BASE_LEG_USD,
        "recoveryLegUsd": RECOVERY_LEG_USD,
        "minEventBalanceUsd": MIN_EVENT_BALANCE_USD,
        "restartDelayHours": RESTART_DELAY_HOURS,
        "maxBankrollTranches": MAX_BANKROLL_TRANCHES,
        "profitWithdrawRate": PROFIT_WITHDRAW_RATE,
        "firstEntryDeadlineMinutes": FIRST_ENTRY_DEADLINE_MINUTES,
        "retryGapMs": RETRY_GAP_MS,
        "sampleIntervalMs": SAMPLE_INTERVAL_MS,
        "recoveryTriggerLosses": RECOVERY_TRIGGER_LOSSES,
        "executionType": "LIMIT" if uses_limit_pair_entry_mode() else "TRIGGER",
        "requireOrderIdConfirmation": REQUIRE_ORDER_ID_CONFIRMATION,
        "limitFallbackEnabled": LIMIT_FALLBACK_ENABLED,
        "limitFallbackPriceCents": LIMIT_FALLBACK_PRICE_CENTS,
        "startupLimitDelayMinutes": STARTUP_LIMIT_DELAY_MINUTES,
        "prestartOnlyEnabled": PRESTART_ONLY_ENABLED,
        "prestartEntryLeadMinutes": PRESTART_ENTRY_LEAD_MINUTES,
        "prestartEntryWindowSeconds": PRESTART_ENTRY_WINDOW_SECONDS,
        "limitPartialMarketTopUpEnabled": LIMIT_PARTIAL_MARKET_TOP_UP_ENABLED,
        "limitPartialTopUpMinGapUsd": LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD,
        "limitPartialTopUpMinOrderUsd": LIMIT_PARTIAL_TOP_UP_MIN_ORDER_USD,
        "limitPartialTopUpPriceCapCents": LIMIT_PARTIAL_TOP_UP_PRICE_CAP_CENTS,
        "maxEventTotalSpendUsd": MAX_EVENT_TOTAL_SPEND_USD,
    }
    runtime["mode"] = "dry-run" if ORDER_DRY_RUN else "live"
    runtime["variant"] = VARIANT
    runtime["label"] = VARIANT_LABEL
    runtime["workerPid"] = os.getpid()
    runtime["group"] = sanitize_group_state(runtime.get("group"))
    runtime["activeEvent"] = sanitize_active_event_state(runtime.get("activeEvent"))
    if not isinstance(runtime.get("wallet"), dict):
        runtime["wallet"] = {
            "balanceUsd": None,
            "allowanceUsd": None,
            "checkedAt": None,
        }
    update_pause_state(runtime["group"])
    return runtime


def build_event_key(meta: Dict[str, Any]) -> str:
    event_start = meta.get("eventStart")
    start_key = event_start.isoformat() if isinstance(event_start, datetime) else str(event_start or "")
    return f"{VARIANT}:{meta['slug']}:{start_key}"


def meta_matches_variant(meta: Dict[str, Any]) -> bool:
    slug = str(meta.get("slug") or "").lower()
    if not slug or not VARIANT_EVENT_PREFIX:
        return False
    return slug.startswith(VARIANT_EVENT_PREFIX)


def create_order_state(side: str, token_id: str) -> Dict[str, Any]:
    return {
        "side": side,
        "label": "看涨" if side == "up" else "看跌",
        "tokenId": token_id,
        "targetUsd": 0.0,
        "placed": False,
        "placedAt": None,
        "orderId": None,
        "orderIds": [],
        "attemptCount": 0,
        "fillCount": 0,
        "lastAttemptAt": None,
        "lastError": None,
        "lastErrorAt": None,
        "retryEligibleAt": None,
        "status": "watching",
        "triggerType": None,
        "entryPriceCents": None,
        "lastEstimatedPriceCents": None,
        "thresholdCents": THRESHOLD_CENTS,
        "sharesBought": 0.0,
        "spentUsd": 0.0,
        "firstQualifiedAt": None,
        "lastQualifiedAt": None,
        "lastObservedCents": None,
        "matchedAfterError": False,
        "blocked": False,
        "blockedAt": None,
        "blockedReason": None,
        "externalPositionDetectedAt": None,
        "externalPositionDeltaShares": 0.0,
        "executionMode": None,
        "limitOrderId": None,
        "limitOrderPlacedAt": None,
        "limitPriceCents": None,
        "limitShares": 0.0,
        "limitBaselineShares": 0.0,
        "limitExpiresAt": None,
        "limitFillCount": 0,
        "lastLimitFillAt": None,
        "limitCompletedAt": None,
        "limitCancelledAt": None,
        "marketTopUpAttemptCount": 0,
        "marketTopUpSpentUsd": 0.0,
        "marketTopUpShares": 0.0,
        "marketTopUpOrderIds": [],
        "marketTopUpLastAttemptAt": None,
        "marketTopUpLastError": None,
        "marketTopUpLastErrorAt": None,
        "marketTopUpPriceCapCents": None,
        "marketTopUpSkippedSmallGapUsd": 0.0,
    }


def create_event_state(meta: Dict[str, Any], group: Dict[str, Any]) -> Dict[str, Any]:
    event_start = meta["eventStart"].astimezone(UTC)
    event_end = meta["eventEnd"].astimezone(UTC)
    if PRESTART_ONLY_ENABLED:
        first_entry_deadline = event_start
        startup_limit_ready_at = event_start - timedelta(minutes=PRESTART_ENTRY_LEAD_MINUTES)
    else:
        first_entry_deadline = event_start + timedelta(minutes=FIRST_ENTRY_DEADLINE_MINUTES)
        startup_limit_ready_at = event_start + timedelta(minutes=STARTUP_LIMIT_DELAY_MINUTES)
    leg_size = group_leg_size(group)
    event = {
        "eventKey": build_event_key(meta),
        "slug": meta["slug"],
        "eventId": meta.get("eventId"),
        "marketId": meta.get("marketId"),
        "entryMode": ENTRY_MODE,
        "eventStart": event_start.isoformat(),
        "eventEnd": event_end.isoformat(),
        "firstEntryDeadline": first_entry_deadline.isoformat(),
        "startupLimitReadyAt": startup_limit_ready_at.isoformat(),
        "startupLimitDelayMinutes": STARTUP_LIMIT_DELAY_MINUTES,
        "prestartOnly": PRESTART_ONLY_ENABLED,
        "prestartEntryLeadMinutes": PRESTART_ENTRY_LEAD_MINUTES,
        "maxEventTotalSpendUsd": round_money(MAX_EVENT_TOTAL_SPEND_USD),
        "thresholdCents": THRESHOLD_CENTS,
        "legSizeUsd": round_money(leg_size),
        "recoveryMode": bool(group.get("recoveryMode")),
        "groupBalanceBeforeUsd": round_money(float(group.get("balanceUsd") or 0.0)),
        "groupRealizedPnlBeforeUsd": round_money(float(group.get("realizedNetPnlUsd") or 0.0)),
        "tickSize": meta.get("tickSize"),
        "negRisk": bool(meta.get("negRisk")),
        "orderMinSize": float(meta.get("orderMinSize") or 0.0),
        "sampleCount": 0,
        "lastSampleAt": None,
        "lastSample": None,
        "firstEntryPlaced": False,
        "firstEntrySide": None,
        "firstEntryPlacedAt": None,
        "status": "watching",
        "statusReason": None,
        "spentUsd": 0.0,
        "payoutUsd": 0.0,
        "pnlUsd": 0.0,
        "winnerSide": None,
        "finalizedAt": None,
        "resolutionCheckedAt": None,
        "orders": {
            "up": create_order_state("up", meta["upTokenId"]),
            "down": create_order_state("down", meta["downTokenId"]),
        },
    }
    event["orders"]["up"]["targetUsd"] = round_money(leg_size)
    event["orders"]["down"]["targetUsd"] = round_money(leg_size)
    write_event_log(
        event,
        "event-started",
        {
            "legSizeUsd": leg_size,
            "entryMode": ENTRY_MODE,
            "thresholdCents": THRESHOLD_CENTS,
            "deadline": event["firstEntryDeadline"],
            "startupLimitReadyAt": event["startupLimitReadyAt"],
            "recoveryMode": event["recoveryMode"],
        },
    )
    return event


def hydrate_order_state(order: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(order, dict):
        return {}
    order.setdefault("targetUsd", 0.0)
    order.setdefault("blocked", False)
    order.setdefault("blockedAt", None)
    order.setdefault("blockedReason", None)
    order.setdefault("externalPositionDetectedAt", None)
    order.setdefault("externalPositionDeltaShares", 0.0)
    order.setdefault("executionMode", None)
    order.setdefault("limitOrderId", None)
    order.setdefault("limitOrderPlacedAt", None)
    order.setdefault("limitPriceCents", None)
    order.setdefault("limitShares", 0.0)
    order.setdefault("limitBaselineShares", 0.0)
    order.setdefault("limitExpiresAt", None)
    order.setdefault("limitFillCount", 0)
    order.setdefault("lastLimitFillAt", None)
    order.setdefault("limitCompletedAt", None)
    order.setdefault("limitCancelledAt", None)
    order.setdefault("marketTopUpAttemptCount", 0)
    order.setdefault("marketTopUpSpentUsd", 0.0)
    order.setdefault("marketTopUpShares", 0.0)
    order.setdefault("marketTopUpOrderIds", [])
    if not isinstance(order.get("marketTopUpOrderIds"), list):
        order["marketTopUpOrderIds"] = []
    order.setdefault("marketTopUpLastAttemptAt", None)
    order.setdefault("marketTopUpLastError", None)
    order.setdefault("marketTopUpLastErrorAt", None)
    order.setdefault("marketTopUpPriceCapCents", None)
    order.setdefault("marketTopUpSkippedSmallGapUsd", 0.0)
    order.setdefault("orderIds", [])
    if not isinstance(order.get("orderIds"), list):
        order["orderIds"] = []
    order.setdefault("fillCount", 0)
    order.setdefault("lastEstimatedPriceCents", None)
    return order


def order_counts_as_confirmed(order: Dict[str, Any]) -> bool:
    if not isinstance(order, dict) or not order.get("placed"):
        return False
    if not REQUIRE_ORDER_ID_CONFIRMATION:
        return True
    return bool(order.get("orderId"))


def recompute_event_order_state(event: Dict[str, Any]) -> None:
    confirmed_orders = []
    spent_usd = 0.0
    for side in ("up", "down"):
        order = hydrate_order_state(event["orders"].get(side) or {})
        event["orders"][side] = order
        if order_counts_as_confirmed(order):
            spent_usd += float(order.get("spentUsd") or 0.0)
            confirmed_orders.append((side, order))

    event["spentUsd"] = round_money(spent_usd)
    if confirmed_orders:
        confirmed_orders.sort(key=lambda item: parse_iso(item[1].get("placedAt")) or now_utc())
        first_side, first_order = confirmed_orders[0]
        event["firstEntryPlaced"] = True
        event["firstEntrySide"] = first_side
        event["firstEntryPlacedAt"] = first_order.get("placedAt")
        if str(event.get("status") or "") in {"watching", "placing", "live"}:
            event["status"] = "live"
        return

    event["firstEntryPlaced"] = False
    event["firstEntrySide"] = None
    event["firstEntryPlacedAt"] = None
    if str(event.get("status") or "") in {"watching", "placing", "live"}:
        event["status"] = "watching"


def flag_external_position_interference(
    runtime: Dict[str, Any],
    event: Dict[str, Any],
    side: str,
    observed_cents: float,
    shares_delta: float,
    reason: str,
) -> bool:
    current_time = now_utc()
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    order["placed"] = False
    order["placedAt"] = None
    order["orderId"] = None
    order["status"] = "external-position-detected"
    order["entryPriceCents"] = None
    order["sharesBought"] = 0.0
    order["spentUsd"] = 0.0
    order["matchedAfterError"] = False
    order["blocked"] = True
    order["blockedAt"] = current_time.isoformat()
    order["blockedReason"] = reason
    order["externalPositionDetectedAt"] = current_time.isoformat()
    order["externalPositionDeltaShares"] = round_money(shares_delta)
    order["lastObservedCents"] = round_money(observed_cents)
    order["lastError"] = reason
    order["lastErrorAt"] = current_time.isoformat()
    runtime["lastSkipReason"] = "external-position-interference"
    write_event_log(
        event,
        "external-position-detected",
        {
            "side": side,
            "observedCents": observed_cents,
            "positionDeltaShares": round_money(shares_delta),
            "reason": reason,
        },
    )
    recompute_event_order_state(event)
    if float(event.get("spentUsd") or 0.0) <= EPSILON:
        event["status"] = "external-position-skip"
        event["statusReason"] = reason
        finalize_active_event(runtime, event, winner_side=None)
        return True
    event["statusReason"] = reason
    return False


def sanitize_active_event_state(event: Any) -> Any:
    if not isinstance(event, dict):
        return event
    orders = event.get("orders")
    if not isinstance(orders, dict):
        return event

    sanitized = False
    for side in ("up", "down"):
        order = hydrate_order_state(orders.get(side) or {})
        orders[side] = order
        if REQUIRE_ORDER_ID_CONFIRMATION and order.get("placed") and not order.get("orderId"):
            order["placed"] = False
            order["placedAt"] = None
            order["status"] = "external-position-detected"
            order["entryPriceCents"] = None
            order["blocked"] = True
            order["blockedAt"] = order.get("blockedAt") or now_utc().isoformat()
            order["blockedReason"] = order.get("blockedReason") or "ambiguous-match-without-order-id"
            order["externalPositionDetectedAt"] = (
                order.get("externalPositionDetectedAt") or now_utc().isoformat()
            )
            order["externalPositionDeltaShares"] = round_money(float(order.get("sharesBought") or 0.0))
            order["lastError"] = order.get("lastError") or "ambiguous-match-without-order-id"
            order["lastErrorAt"] = order.get("lastErrorAt") or now_utc().isoformat()
            order["sharesBought"] = 0.0
            order["spentUsd"] = 0.0
            order["matchedAfterError"] = False
            sanitized = True

    recompute_event_order_state(event)
    if sanitized and float(event.get("spentUsd") or 0.0) <= EPSILON:
        event["statusReason"] = "ambiguous-match-without-order-id"
    return event


def build_event_row(event: Dict[str, Any]) -> Dict[str, Any]:
    start = parse_iso(event.get("eventStart"))
    end = parse_iso(event.get("eventEnd"))
    finalized = parse_iso(event.get("finalizedAt"))
    return {
        "variant": VARIANT,
        "variantLabel": VARIANT_LABEL,
        "entryMode": event.get("entryMode") or ENTRY_MODE,
        "eventKey": event.get("eventKey"),
        "slug": event.get("slug"),
        "eventStart": event.get("eventStart"),
        "eventEnd": event.get("eventEnd"),
        "firstEntryDeadline": event.get("firstEntryDeadline"),
        "startupLimitReadyAt": event.get("startupLimitReadyAt"),
        "startupLimitDelayMinutes": event.get("startupLimitDelayMinutes"),
        "status": event.get("status"),
        "statusReason": event.get("statusReason"),
        "thresholdCents": event.get("thresholdCents"),
        "legSizeUsd": round_money(float(event.get("legSizeUsd") or 0.0)),
        "recoveryMode": bool(event.get("recoveryMode")),
        "groupBalanceBeforeUsd": round_money(float(event.get("groupBalanceBeforeUsd") or 0.0)),
        "sampleCount": int(event.get("sampleCount") or 0),
        "spentUsd": round_money(float(event.get("spentUsd") or 0.0)),
        "payoutUsd": round_money(float(event.get("payoutUsd") or 0.0)),
        "pnlUsd": round_money(float(event.get("pnlUsd") or 0.0)),
        "winnerSide": event.get("winnerSide"),
        "firstEntryPlaced": bool(event.get("firstEntryPlaced")),
        "firstEntrySide": event.get("firstEntrySide"),
        "firstEntryPlacedAt": event.get("firstEntryPlacedAt"),
        "upPlaced": bool(event["orders"]["up"].get("placed")),
        "downPlaced": bool(event["orders"]["down"].get("placed")),
        "upAttempts": int(event["orders"]["up"].get("attemptCount") or 0),
        "downAttempts": int(event["orders"]["down"].get("attemptCount") or 0),
        "upStatus": event["orders"]["up"].get("status"),
        "downStatus": event["orders"]["down"].get("status"),
        "lastSample": event.get("lastSample"),
        "finalizedAt": event.get("finalizedAt"),
        "sortMs": int((finalized or end or start or now_utc()).timestamp() * 1000),
    }


def append_trade_rows(event: Dict[str, Any]) -> None:
    for side in ("up", "down"):
        order = event["orders"][side]
        if not order.get("placed"):
            continue
        placed_at = parse_iso(order.get("placedAt"))
        row = {
            "variant": VARIANT,
            "variantLabel": VARIANT_LABEL,
            "entryMode": event.get("entryMode") or ENTRY_MODE,
            "eventKey": event.get("eventKey"),
            "slug": event.get("slug"),
            "side": side,
            "sideLabel": order.get("label"),
            "placedAt": order.get("placedAt"),
            "triggerType": order.get("triggerType"),
            "triggerCents": order.get("entryPriceCents"),
            "thresholdCents": event.get("thresholdCents"),
            "legSizeUsd": round_money(float(event.get("legSizeUsd") or 0.0)),
            "spentUsd": round_money(float(order.get("spentUsd") or 0.0)),
            "sharesBought": round_money(float(order.get("sharesBought") or 0.0)),
            "orderId": order.get("orderId"),
            "matchedAfterError": bool(order.get("matchedAfterError")),
            "executionMode": order.get("executionMode"),
            "limitOrderId": order.get("limitOrderId"),
            "limitPriceCents": order.get("limitPriceCents"),
            "marketTopUpSpentUsd": round_money(float(order.get("marketTopUpSpentUsd") or 0.0)),
            "marketTopUpShares": round_money(float(order.get("marketTopUpShares") or 0.0)),
            "marketTopUpOrderIds": order.get("marketTopUpOrderIds") or [],
            "marketTopUpSkippedSmallGapUsd": round_money(
                float(order.get("marketTopUpSkippedSmallGapUsd") or 0.0)
            ),
            "status": order.get("status"),
            "sortMs": int((placed_at or now_utc()).timestamp() * 1000),
        }
        append_history_row(TRADE_DETAILS_PATH, row, MAX_HISTORY_ITEMS * 3)


def persist_reports(runtime: Dict[str, Any]) -> None:
    active_event = runtime.get("activeEvent")
    group = runtime["group"]
    active_exposure = float(active_event.get("spentUsd") or 0.0) if isinstance(active_event, dict) else 0.0
    update_pause_state(group)
    summary = {
        "variant": VARIANT,
        "variantLabel": VARIANT_LABEL,
        "mode": runtime.get("mode"),
        "workerPid": os.getpid(),
        "strategy": runtime.get("strategy"),
        "status": group.get("status"),
        "thresholdCents": THRESHOLD_CENTS,
        "startBalanceUsd": round_money(float(group.get("startBalanceUsd") or 0.0)),
        "trancheSizeUsd": round_money(float(group.get("trancheSizeUsd") or START_BALANCE_USD)),
        "tranchesUsed": int(group.get("tranchesUsed") or 1),
        "maxTranches": int(group.get("maxTranches") or MAX_BANKROLL_TRANCHES),
        "restartDelayHours": float(group.get("restartDelayHours") or RESTART_DELAY_HOURS),
        "profitWithdrawRate": float(group.get("profitWithdrawRate") or PROFIT_WITHDRAW_RATE),
        "withdrawnProfitUsd": round_money(float(group.get("withdrawnProfitUsd") or 0.0)),
        "totalCommittedUsd": round_money(float(group.get("totalCommittedUsd") or 0.0)),
        "nextRestartAt": group.get("nextRestartAt"),
        "stoppedAt": group.get("stoppedAt"),
        "lastTopUpAt": group.get("lastTopUpAt"),
        "balanceUsd": round_money(float(group.get("balanceUsd") or 0.0)),
        "availableUsd": round_money(current_available_cash(group, active_event)),
        "walletBalanceUsd": None
        if runtime.get("wallet", {}).get("balanceUsd") is None
        else round_money(float(runtime["wallet"]["balanceUsd"] or 0.0)),
        "walletAllowanceUsd": None
        if runtime.get("wallet", {}).get("allowanceUsd") is None
        else round_money(float(runtime["wallet"]["allowanceUsd"] or 0.0)),
        "walletCheckedAt": runtime.get("wallet", {}).get("checkedAt"),
        "activeExposureUsd": round_money(active_exposure),
        "realizedNetPnlUsd": round_money(float(group.get("realizedNetPnlUsd") or 0.0)),
        "peakBalanceUsd": round_money(float(group.get("peakBalanceUsd") or 0.0)),
        "maxDrawdownUsd": round_money(float(group.get("maxDrawdownUsd") or 0.0)),
        "currentLegUsd": round_money(group_leg_size(group)),
        "baseLegUsd": round_money(BASE_LEG_USD),
        "recoveryLegUsd": round_money(RECOVERY_LEG_USD),
        "minEventBalanceUsd": round_money(MIN_EVENT_BALANCE_USD),
        "recoveryMode": bool(group.get("recoveryMode")),
        "recoveryPnlSinceAnchorUsd": round_money(float(group.get("recoveryPnlSinceAnchorUsd") or 0.0)),
        "currentLossStreak": int(group.get("currentLossStreak") or 0),
        "recoveryTriggerLosses": RECOVERY_TRIGGER_LOSSES,
        "totalEvents": int(group.get("totalEvents") or 0),
        "tradedEvents": int(group.get("tradedEvents") or 0),
        "skippedEvents": int(group.get("skippedEvents") or 0),
        "winningEvents": int(group.get("winningEvents") or 0),
        "losingEvents": int(group.get("losingEvents") or 0),
        "flatEvents": int(group.get("flatEvents") or 0),
        "pauseReason": group.get("pauseReason"),
        "pausedAt": group.get("pausedAt"),
        "activeEventKey": active_event.get("eventKey") if isinstance(active_event, dict) else None,
        "activeEventStart": active_event.get("eventStart") if isinstance(active_event, dict) else None,
        "activeEventEnd": active_event.get("eventEnd") if isinstance(active_event, dict) else None,
        "lastResolvedEventKey": group.get("lastResolvedEventKey"),
        "lastResolvedAt": group.get("lastResolvedAt"),
        "updatedAt": now_utc().isoformat(),
    }
    write_json_file(GROUP_SUMMARY_PATH, summary)


def persist_runtime(runtime: Dict[str, Any]) -> None:
    runtime["lastUpdatedAt"] = now_utc().isoformat()
    runtime["workerPid"] = os.getpid()
    update_pause_state(runtime["group"])
    write_json_file(RUNTIME_PATH, runtime)
    persist_reports(runtime)


def safe_get_position_size(trader, token_id: str) -> float:
    try:
        return float(trader.get_position_size(token_id) or 0.0)
    except Exception:
        return 0.0


def extract_order_id(response: Any) -> Optional[str]:
    if isinstance(response, dict):
        for key in ("orderID", "id", "orderId"):
            value = response.get(key)
            if value:
                return str(value)
    return None


def extract_response_fill(response: Any) -> Dict[str, Optional[float]]:
    if not isinstance(response, dict):
        return {"spentUsd": None, "sharesBought": None}
    return {
        "spentUsd": round_money(parse_float(response.get("makingAmount"), 0.0) or 0.0)
        if response.get("makingAmount") not in (None, "")
        else None,
        "sharesBought": round_money(parse_float(response.get("takingAmount"), 0.0) or 0.0)
        if response.get("takingAmount") not in (None, "")
        else None,
    }


def split_trigger_order_amounts(total_usd: float) -> List[float]:
    remaining = round_money(max(0.0, float(total_usd or 0.0)))
    if remaining <= EPSILON:
        return []
    chunk_size = round_money(max(0.1, TRIGGER_ORDER_CHUNK_USD))
    chunks: List[float] = []
    while remaining > EPSILON:
        amount = min(chunk_size, remaining)
        if remaining - amount <= EPSILON:
            amount = remaining
        chunks.append(round_money(amount))
        remaining = round_money(remaining - amount)
    return chunks


def order_target_spend_usd(event: Dict[str, Any], order: Dict[str, Any]) -> float:
    target = float(order.get("targetUsd") or 0.0)
    if target > EPSILON:
        return round_money(target)
    return round_money(float(event.get("legSizeUsd") or 0.0))


def order_remaining_trigger_usd(event: Dict[str, Any], order: Dict[str, Any]) -> float:
    return round_money(
        max(0.0, order_target_spend_usd(event, order) - float(order.get("spentUsd") or 0.0))
    )


def order_trigger_complete(event: Dict[str, Any], order: Dict[str, Any]) -> bool:
    return order_remaining_trigger_usd(event, order) <= EPSILON


def event_remaining_budget_usd(event: Dict[str, Any]) -> float:
    return round_money(
        max(
            0.0,
            float(event.get("maxEventTotalSpendUsd") or MAX_EVENT_TOTAL_SPEND_USD)
            - float(event.get("spentUsd") or 0.0),
        )
    )


def order_is_retry_ready(order: Dict[str, Any], current_time: datetime) -> bool:
    retry_at = parse_iso(order.get("retryEligibleAt"))
    return retry_at is None or current_time >= retry_at


def order_is_qualified(observed_cents: float) -> bool:
    return float(observed_cents) <= THRESHOLD_CENTS + EPSILON


def pick_trigger_entry_side(event: Dict[str, Any], prices: Dict[str, Any]) -> Optional[str]:
    qualified: List[tuple] = []
    for side in ("up", "down"):
        observed_cents = float(prices[f"{side}Cents"])
        if not order_is_qualified(observed_cents):
            continue
        order = hydrate_order_state(event["orders"].get(side) or {})
        event["orders"][side] = order
        first_qualified_at = parse_iso(order.get("firstQualifiedAt")) or datetime.max.replace(tzinfo=UTC)
        qualified.append(
            (
                0 if int(order.get("attemptCount") or 0) > 0 else 1,
                first_qualified_at,
                observed_cents,
                0 if side == "up" else 1,
                side,
            )
        )
    if not qualified:
        return None
    qualified.sort()
    return qualified[0][4]


def estimate_shares_bought(leg_size_usd: float, observed_cents: float) -> float:
    price_cents = max(1.0, min(float(observed_cents), THRESHOLD_CENTS))
    return round_money(float(leg_size_usd) / (price_cents / 100.0))


def limit_entry_price_cents() -> float:
    return max(1.0, min(float(LIMIT_FALLBACK_PRICE_CENTS), THRESHOLD_CENTS))


def estimate_limit_shares(event: Dict[str, Any]) -> float:
    price_cents = limit_entry_price_cents()
    shares = float(event["legSizeUsd"]) / (price_cents / 100.0)
    min_size = float(event.get("orderMinSize") or 0.0)
    return round_money(max(shares, min_size))


def estimate_limit_cost_usd(shares: float, price_cents: float) -> float:
    return round_money(float(shares) * (float(price_cents) / 100.0))


def target_limit_spend_usd(event: Dict[str, Any], order: Dict[str, Any]) -> float:
    price_cents = float(order.get("limitPriceCents") or limit_entry_price_cents())
    target_shares = float(order.get("limitShares") or estimate_limit_shares(event))
    return estimate_limit_cost_usd(target_shares, price_cents)


def remaining_order_spend_usd(event: Dict[str, Any], order: Dict[str, Any]) -> float:
    return round_money(max(0.0, target_limit_spend_usd(event, order) - float(order.get("spentUsd") or 0.0)))


def market_top_up_amount_usd(remaining_usd: float) -> float:
    if remaining_usd + EPSILON < LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD:
        return 0.0
    return round_money(max(float(remaining_usd), LIMIT_PARTIAL_TOP_UP_MIN_ORDER_USD))


def market_top_up_price_cap() -> float:
    return max(0.01, min(float(LIMIT_PARTIAL_TOP_UP_PRICE_CAP_CENTS), 99.0)) / 100.0


def can_submit_market_top_up(event: Dict[str, Any]) -> bool:
    event_end = parse_iso(event.get("eventEnd"))
    if event_end is None:
        return True
    return now_utc() < event_end - timedelta(seconds=30)


def limit_expiration_ts(event: Dict[str, Any]) -> Optional[int]:
    event_end = parse_iso(event.get("eventEnd"))
    if event_end is None:
        return None
    expires_at = event_end - timedelta(seconds=LIMIT_FALLBACK_EXPIRY_BUFFER_SECONDS)
    if expires_at <= now_utc() + timedelta(seconds=30):
        return None
    return int(expires_at.timestamp())


def event_has_open_limit_order(event: Dict[str, Any]) -> bool:
    orders = event.get("orders") if isinstance(event.get("orders"), dict) else {}
    return any(
        str(hydrate_order_state(orders.get(side) or {}).get("status") or "") == "limit-open"
        for side in ("up", "down")
    )


def event_order_spent_usd(event: Dict[str, Any]) -> float:
    orders = event.get("orders") if isinstance(event.get("orders"), dict) else {}
    return round_money(
        sum(float(hydrate_order_state(orders.get(side) or {}).get("spentUsd") or 0.0) for side in ("up", "down"))
    )


def event_planned_limit_spend_usd(event: Dict[str, Any]) -> float:
    orders = event.get("orders") if isinstance(event.get("orders"), dict) else {}
    total = event_order_spent_usd(event)
    for side in ("up", "down"):
        order = hydrate_order_state(orders.get(side) or {})
        if str(order.get("status") or "") == "limit-open":
            total += target_limit_spend_usd(event, order)
    return round_money(total)


def block_event_for_external_position(event: Dict[str, Any], trader) -> bool:
    blocked = False
    for side in ("up", "down"):
        order = hydrate_order_state(event["orders"].get(side) or {})
        event["orders"][side] = order
        if order.get("placed") or order.get("limitOrderId"):
            continue
        current_position = safe_get_position_size(trader, order["tokenId"])
        if current_position <= EPSILON:
            continue
        order["blocked"] = True
        order["blockedAt"] = now_utc().isoformat()
        order["blockedReason"] = "external-position-before-entry"
        order["externalPositionDetectedAt"] = order["blockedAt"]
        order["externalPositionDeltaShares"] = round_money(current_position)
        blocked = True
    if blocked:
        event["status"] = "external-position-skip"
        event["statusReason"] = "external-position-before-entry"
        write_event_log(event, "external-position-entry-blocked", {"reason": event["statusReason"]})
    return blocked


def cancel_open_limit_orders(event: Dict[str, Any], trader) -> None:
    for side in ("up", "down"):
        order = hydrate_order_state(event["orders"].get(side) or {})
        event["orders"][side] = order
        order_id = order.get("limitOrderId")
        if not order_id or str(order.get("status") or "") != "limit-open":
            continue
        try:
            trader.cancel_orders([order_id])
            order["limitCancelledAt"] = now_utc().isoformat()
            if float(order.get("sharesBought") or 0.0) > EPSILON:
                order["status"] = "partial-matched"
            else:
                order["status"] = "limit-cancelled"
            write_event_log(
                event,
                "limit-order-cancelled",
                {
                    "side": side,
                    "orderId": order_id,
                    "filledShares": round_money(float(order.get("sharesBought") or 0.0)),
                    "spentUsd": round_money(float(order.get("spentUsd") or 0.0)),
                    "status": order["status"],
                },
            )
        except Exception as exc:
            order["lastError"] = trim_text(exc)
            order["lastErrorAt"] = now_utc().isoformat()
            write_event_log(
                event,
                "limit-order-cancel-error",
                {"side": side, "orderId": order_id, "error": trim_text(exc)},
            )


def cancel_limit_order_for_top_up(event: Dict[str, Any], side: str, trader) -> None:
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    order_id = order.get("limitOrderId")
    if not order_id or str(order.get("status") or "") != "limit-open":
        return
    try:
        trader.cancel_orders([order_id])
        order["limitCancelledAt"] = now_utc().isoformat()
        write_event_log(
            event,
            "limit-order-cancelled-for-market-top-up",
            {
                "side": side,
                "orderId": order_id,
                "filledShares": round_money(float(order.get("sharesBought") or 0.0)),
                "spentUsd": round_money(float(order.get("spentUsd") or 0.0)),
                "remainingUsd": remaining_order_spend_usd(event, order),
            },
        )
    except Exception as exc:
        order["lastError"] = trim_text(exc)
        order["lastErrorAt"] = now_utc().isoformat()
        write_event_log(
            event,
            "limit-order-cancel-for-top-up-error",
            {"side": side, "orderId": order_id, "error": trim_text(exc)},
        )


def mark_order_complete_or_small_gap(event: Dict[str, Any], side: str, reason: str) -> bool:
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    remaining_usd = remaining_order_spend_usd(event, order)
    if remaining_usd + EPSILON >= LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD:
        return False
    current_time = now_utc()
    order["status"] = "matched"
    order["limitCompletedAt"] = order.get("limitCompletedAt") or current_time.isoformat()
    order["marketTopUpSkippedSmallGapUsd"] = round_money(remaining_usd)
    recompute_event_order_state(event)
    event["status"] = "live" if float(event.get("spentUsd") or 0.0) > EPSILON else "watching"
    event["statusReason"] = None
    write_event_log(
        event,
        "order-complete-small-gap-skipped",
        {
            "side": side,
            "reason": reason,
            "remainingUsd": round_money(remaining_usd),
            "minGapUsd": LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD,
            "spentUsd": round_money(float(order.get("spentUsd") or 0.0)),
            "sharesBought": round_money(float(order.get("sharesBought") or 0.0)),
        },
    )
    return True


def attempt_market_top_up(
    runtime: Dict[str, Any],
    event: Dict[str, Any],
    side: str,
    trader,
    reason: str,
) -> bool:
    if not LIMIT_PARTIAL_MARKET_TOP_UP_ENABLED or not hasattr(trader, "place_buy"):
        return False

    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    if mark_order_complete_or_small_gap(event, side, reason):
        runtime["lastSkipReason"] = None
        return True
    if not can_submit_market_top_up(event):
        order["status"] = "partial-matched-too-late"
        runtime["lastSkipReason"] = "market-top-up-too-late"
        write_event_log(
            event,
            "market-top-up-too-late",
            {
                "side": side,
                "remainingUsd": remaining_order_spend_usd(event, order),
                "eventEnd": event.get("eventEnd"),
            },
        )
        return False

    remaining_usd = remaining_order_spend_usd(event, order)
    amount_usd = market_top_up_amount_usd(remaining_usd)
    if amount_usd <= EPSILON:
        return mark_order_complete_or_small_gap(event, side, reason)

    current_time = now_utc()
    order["marketTopUpAttemptCount"] = int(order.get("marketTopUpAttemptCount") or 0) + 1
    order["marketTopUpLastAttemptAt"] = current_time.isoformat()
    order["retryEligibleAt"] = (current_time + timedelta(milliseconds=RETRY_GAP_MS)).isoformat()
    order["status"] = "market-topup-placing"
    event["status"] = "market-topup-placing"
    price_cap = market_top_up_price_cap()

    try:
        ensure_funds_or_use_cached(runtime, trader, amount_usd)
        baseline = safe_get_position_size(trader, order["tokenId"])
        response = trader.place_buy(
            order["tokenId"],
            amount_usd,
            price_cap,
            event.get("tickSize"),
            event.get("negRisk"),
        )
        order_id = extract_order_id(response)
        if order_id:
            order["marketTopUpOrderIds"].append(order_id)
            order["orderId"] = order.get("orderId") or order_id
        time.sleep(POSITION_CONFIRM_DELAY_MS / 1000.0)
        current_position = safe_get_position_size(trader, order["tokenId"])
        shares_delta = max(0.0, current_position - baseline)
        if shares_delta <= EPSILON:
            raise RuntimeError("market top-up did not increase position")

        order["placed"] = True
        order["placedAt"] = order.get("placedAt") or current_time.isoformat()
        order["entryPriceCents"] = round_money((amount_usd / shares_delta) * 100.0)
        order["sharesBought"] = round_money(float(order.get("sharesBought") or 0.0) + shares_delta)
        order["spentUsd"] = round_money(float(order.get("spentUsd") or 0.0) + amount_usd)
        order["marketTopUpSpentUsd"] = round_money(float(order.get("marketTopUpSpentUsd") or 0.0) + amount_usd)
        order["marketTopUpShares"] = round_money(float(order.get("marketTopUpShares") or 0.0) + shares_delta)
        order["marketTopUpPriceCapCents"] = round_money(price_cap * 100.0)
        order["marketTopUpLastError"] = None
        order["marketTopUpLastErrorAt"] = None
        order["executionMode"] = "limit+market-topup"
        order["matchedAfterError"] = False
        if not event.get("firstEntryPlaced"):
            event["firstEntryPlaced"] = True
            event["firstEntrySide"] = side
            event["firstEntryPlacedAt"] = order["placedAt"]
        recompute_event_order_state(event)
        if remaining_order_spend_usd(event, order) + EPSILON < LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD:
            order["status"] = "matched"
            order["limitCompletedAt"] = now_utc().isoformat()
            event["status"] = "live"
        else:
            order["status"] = "market-topup-waiting-retry"
            event["status"] = "live"
        event["statusReason"] = None
        runtime["lastSkipReason"] = None
        write_event_log(
            event,
            "market-top-up-matched",
            {
                "side": side,
                "reason": reason,
                "remainingBeforeUsd": round_money(remaining_usd),
                "amountUsd": round_money(amount_usd),
                "priceCapCents": round_money(price_cap * 100.0),
                "sharesBought": round_money(shares_delta),
                "orderId": order_id,
                "totalSpentUsd": round_money(float(order.get("spentUsd") or 0.0)),
                "totalSharesBought": round_money(float(order.get("sharesBought") or 0.0)),
                "remainingAfterUsd": remaining_order_spend_usd(event, order),
            },
        )
        return True
    except Exception as exc:
        order["status"] = "market-topup-waiting-retry"
        order["marketTopUpLastError"] = trim_text(exc)
        order["marketTopUpLastErrorAt"] = now_utc().isoformat()
        event["status"] = "live" if float(event.get("spentUsd") or 0.0) > EPSILON else "watching"
        runtime["lastSkipReason"] = "market-top-up-failed-waiting-retry"
        write_event_log(
            event,
            "market-top-up-error",
            {
                "side": side,
                "reason": reason,
                "remainingUsd": round_money(remaining_usd),
                "amountUsd": round_money(amount_usd),
                "priceCapCents": round_money(price_cap * 100.0),
                "error": trim_text(exc),
            },
        )
        return False


def record_trigger_fill(
    event: Dict[str, Any],
    side: str,
    observed_cents: float,
    shares_bought: float,
    spent_usd: float,
    response: Any,
    matched_after_error: bool,
) -> None:
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    current_time = now_utc()
    previous_spent = float(order.get("spentUsd") or 0.0)
    previous_shares = float(order.get("sharesBought") or 0.0)
    total_spent = round_money(previous_spent + float(spent_usd))
    total_shares = round_money(previous_shares + float(shares_bought))
    order["placed"] = True
    order["placedAt"] = order.get("placedAt") or current_time.isoformat()
    order_id = extract_order_id(response)
    if order_id:
        order["orderId"] = order_id
        if order_id not in order["orderIds"]:
            order["orderIds"].append(order_id)
    order["fillCount"] = int(order.get("fillCount") or 0) + 1
    order["sharesBought"] = total_shares
    order["spentUsd"] = total_spent
    order["entryPriceCents"] = (
        round_money((total_spent / total_shares) * 100.0)
        if total_shares > EPSILON
        else round_money(observed_cents)
    )
    order["lastError"] = None
    order["lastErrorAt"] = None
    order["matchedAfterError"] = bool(matched_after_error)
    order["executionMode"] = "trigger-threshold"
    order["blocked"] = False
    order["blockedAt"] = None
    order["blockedReason"] = None
    remaining_usd = order_remaining_trigger_usd(event, order)
    order["status"] = "matched" if remaining_usd <= EPSILON else "partial"
    recompute_event_order_state(event)
    event["status"] = "live" if float(event.get("spentUsd") or 0.0) > EPSILON else "watching"
    event["statusReason"] = None
    write_event_log(
        event,
        "trigger-order-fill",
        {
            "side": side,
            "observedCents": round_money(observed_cents),
            "sharesBought": round_money(shares_bought),
            "spentUsd": round_money(spent_usd),
            "orderId": order_id,
            "matchedAfterError": matched_after_error,
            "fillCount": order["fillCount"],
            "totalSpentUsd": total_spent,
            "targetUsd": order_target_spend_usd(event, order),
            "remainingUsd": remaining_usd,
        },
    )


def mark_order_success(
    event: Dict[str, Any],
    side: str,
    observed_cents: float,
    shares_bought: float,
    response: Any,
    matched_after_error: bool,
    spent_usd: Optional[float] = None,
    execution_mode: Optional[str] = None,
) -> None:
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    current_time = now_utc()
    order["placed"] = True
    order["placedAt"] = current_time.isoformat()
    order["orderId"] = extract_order_id(response)
    order["status"] = "matched"
    order["entryPriceCents"] = round_money(observed_cents)
    order["sharesBought"] = round_money(shares_bought)
    actual_spent = float(spent_usd) if spent_usd is not None else float(event["legSizeUsd"])
    order["spentUsd"] = round_money(actual_spent)
    order["matchedAfterError"] = bool(matched_after_error)
    order["executionMode"] = execution_mode or order.get("executionMode") or "market"
    order["blocked"] = False
    order["blockedAt"] = None
    order["blockedReason"] = None
    event["spentUsd"] = round_money(float(event.get("spentUsd") or 0.0) + actual_spent)
    if not event.get("firstEntryPlaced"):
        event["firstEntryPlaced"] = True
        event["firstEntrySide"] = side
        event["firstEntryPlacedAt"] = order["placedAt"]
    event["status"] = "live" if event["spentUsd"] > 0 else "watching"
    event["statusReason"] = None
    write_event_log(
        event,
        "order-matched",
        {
            "side": side,
            "observedCents": observed_cents,
            "sharesBought": shares_bought,
            "spentUsd": actual_spent,
            "orderId": order["orderId"],
            "matchedAfterError": matched_after_error,
            "executionMode": order["executionMode"],
        },
    )


def reconcile_limit_order_fill(
    runtime: Dict[str, Any],
    event: Dict[str, Any],
    side: str,
    trader,
) -> bool:
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    if str(order.get("status") or "") != "limit-open" or not order.get("limitOrderId"):
        return False

    current_position = safe_get_position_size(trader, order["tokenId"])
    shares_delta = max(0.0, current_position - float(order.get("limitBaselineShares") or 0.0))
    if shares_delta <= EPSILON:
        return False

    price_cents = float(order.get("limitPriceCents") or limit_entry_price_cents())
    target_shares = float(order.get("limitShares") or estimate_limit_shares(event))
    target_spend = target_limit_spend_usd(event, order)
    incremental_spent = estimate_limit_cost_usd(shares_delta, price_cents)
    previous_shares = float(order.get("sharesBought") or 0.0)
    previous_spent = float(order.get("spentUsd") or 0.0)
    total_shares = previous_shares + shares_delta
    total_spent = previous_spent + incremental_spent
    current_time = now_utc()

    order["placed"] = True
    order["placedAt"] = order.get("placedAt") or current_time.isoformat()
    order["orderId"] = order.get("orderId") or order.get("limitOrderId")
    order["entryPriceCents"] = round_money(price_cents)
    order["sharesBought"] = round_money(total_shares)
    order["spentUsd"] = round_money(total_spent)
    order["matchedAfterError"] = False
    order["executionMode"] = "limit"
    order["blocked"] = False
    order["blockedAt"] = None
    order["blockedReason"] = None
    order["limitBaselineShares"] = round_money(current_position)
    order["limitFillCount"] = int(order.get("limitFillCount") or 0) + 1
    order["lastLimitFillAt"] = current_time.isoformat()

    if not event.get("firstEntryPlaced"):
        event["firstEntryPlaced"] = True
        event["firstEntrySide"] = side
        event["firstEntryPlacedAt"] = order["placedAt"]

    recompute_event_order_state(event)
    if total_spent + EPSILON >= target_spend or total_shares + EPSILON >= target_shares:
        order["status"] = "matched"
        order["limitCompletedAt"] = current_time.isoformat()
        event["status"] = "live"
        event["statusReason"] = None
        write_event_log(
            event,
            "limit-order-filled",
            {
                "side": side,
                "limitPriceCents": price_cents,
                "filledDeltaShares": round_money(shares_delta),
                "totalFilledShares": round_money(total_shares),
                "targetShares": round_money(target_shares),
                "incrementalSpentUsd": incremental_spent,
                "totalSpentUsd": round_money(total_spent),
                "targetSpentUsd": round_money(target_spend),
                "orderId": order.get("limitOrderId"),
            },
        )
    else:
        order["status"] = "limit-open"
        event["status"] = "limit-open"
        event["statusReason"] = None
        remaining_usd = round_money(max(0.0, target_spend - total_spent))
        write_event_log(
            event,
            "limit-order-partial-fill",
            {
                "side": side,
                "limitPriceCents": price_cents,
                "filledDeltaShares": round_money(shares_delta),
                "totalFilledShares": round_money(total_shares),
                "targetShares": round_money(target_shares),
                "incrementalSpentUsd": incremental_spent,
                "totalSpentUsd": round_money(total_spent),
                "targetSpentUsd": round_money(target_spend),
                "remainingUsd": remaining_usd,
                "orderId": order.get("limitOrderId"),
            },
        )
    runtime["lastSkipReason"] = None
    return True


def reconcile_limit_orders(runtime: Dict[str, Any], event: Dict[str, Any], trader) -> None:
    for side in ("up", "down"):
        reconcile_limit_order_fill(runtime, event, side, trader)


def retry_market_top_ups(runtime: Dict[str, Any], event: Dict[str, Any], trader) -> None:
    if not LIMIT_PARTIAL_MARKET_TOP_UP_ENABLED:
        return
    if not can_submit_market_top_up(event):
        return
    current_time = now_utc()
    for side in ("up", "down"):
        order = hydrate_order_state(event["orders"].get(side) or {})
        event["orders"][side] = order
        if str(order.get("status") or "") not in {"partial-matched", "market-topup-waiting-retry"}:
            continue
        if remaining_order_spend_usd(event, order) + EPSILON < LIMIT_PARTIAL_TOP_UP_MIN_GAP_USD:
            mark_order_complete_or_small_gap(event, side, "retry-small-gap")
            continue
        if not order_is_retry_ready(order, current_time):
            continue
        attempt_market_top_up(runtime, event, side, trader, "retry")


def place_starting_limit_orders(runtime: Dict[str, Any], event: Dict[str, Any], trader) -> None:
    current_time = now_utc()
    event_start = parse_iso(event.get("eventStart"))
    ready_at = parse_iso(event.get("startupLimitReadyAt"))
    if ready_at is not None and current_time < ready_at:
        event["status"] = "waiting-start-delay"
        event["statusReason"] = f"startup-limit-delay-until-{ready_at.isoformat()}"
        runtime["lastSkipReason"] = event["statusReason"]
        return

    deadline = parse_iso(event.get("firstEntryDeadline"))
    if deadline is not None and current_time >= deadline and not event_has_open_limit_order(event):
        event["status"] = event.get("status") or "entry-window-closed"
        event["statusReason"] = event.get("statusReason") or "entry-window-closed"
        runtime["lastSkipReason"] = event["statusReason"]
        return

    if PRESTART_ONLY_ENABLED and event_start is not None and current_time >= event_start:
        runtime["lastSkipReason"] = "prestart-entry-window-closed"
        if not event_has_open_limit_order(event) and float(event.get("spentUsd") or 0.0) <= EPSILON:
            event["status"] = "prestart-entry-window-closed"
            event["statusReason"] = runtime["lastSkipReason"]
        return

    if str(event.get("status") or "") == "waiting-start-delay":
        event["status"] = "watching"
        event["statusReason"] = None
        runtime["lastSkipReason"] = None

    if block_event_for_external_position(event, trader):
        runtime["lastSkipReason"] = event.get("statusReason")
        return

    for side in ("up", "down"):
        order = hydrate_order_state(event["orders"].get(side) or {})
        event["orders"][side] = order
        if order.get("placed") or str(order.get("status") or "") == "limit-open" or order.get("blocked"):
            continue
        if not order_is_retry_ready(order, current_time):
            continue

        estimated_cost = estimate_limit_cost_usd(estimate_limit_shares(event), limit_entry_price_cents())
        planned_total = event_planned_limit_spend_usd(event)
        if planned_total + estimated_cost > MAX_EVENT_TOTAL_SPEND_USD + EPSILON:
            order["blocked"] = True
            order["blockedAt"] = current_time.isoformat()
            order["blockedReason"] = "event-spend-cap"
            order["status"] = "blocked"
            event["status"] = "spend-cap-blocked"
            event["statusReason"] = "event-spend-cap"
            runtime["lastSkipReason"] = event["statusReason"]
            write_event_log(
                event,
                "event-spend-cap-blocked",
                {
                    "side": side,
                    "plannedTotalUsd": round_money(planned_total),
                    "estimatedCostUsd": round_money(estimated_cost),
                    "maxEventTotalSpendUsd": round_money(MAX_EVENT_TOTAL_SPEND_USD),
                },
            )
            continue

        order["attemptCount"] = int(order.get("attemptCount") or 0) + 1
        order["lastAttemptAt"] = current_time.isoformat()
        order["retryEligibleAt"] = (current_time + timedelta(milliseconds=RETRY_GAP_MS)).isoformat()
        order["lastObservedCents"] = round_money(limit_entry_price_cents())
        order["firstQualifiedAt"] = order.get("firstQualifiedAt") or current_time.isoformat()
        order["lastQualifiedAt"] = current_time.isoformat()
        order["status"] = "placing"
        write_event_log(
            event,
            "startup-limit-attempt",
            {
                "side": side,
                "attemptCount": order["attemptCount"],
                "limitPriceCents": limit_entry_price_cents(),
                "legSizeUsd": event["legSizeUsd"],
                "estimatedShares": estimate_limit_shares(event),
            },
        )
        before_position = safe_get_position_size(trader, order["tokenId"])
        place_limit_entry_order(
            runtime,
            event,
            side,
            limit_entry_price_cents(),
            trader,
            before_position,
        )


def place_limit_entry_order(
    runtime: Dict[str, Any],
    event: Dict[str, Any],
    side: str,
    observed_cents: float,
    trader,
    before_position: Optional[float] = None,
) -> bool:
    if not LIMIT_FALLBACK_ENABLED or not hasattr(trader, "place_limit_buy"):
        return False

    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    price_cents = limit_entry_price_cents()
    shares = estimate_limit_shares(event)
    estimated_cost = estimate_limit_cost_usd(shares, price_cents)
    current_time = now_utc()
    planned_total = event_planned_limit_spend_usd(event)
    if planned_total + estimated_cost > MAX_EVENT_TOTAL_SPEND_USD + EPSILON:
        order["status"] = "blocked"
        order["blocked"] = True
        order["blockedAt"] = current_time.isoformat()
        order["blockedReason"] = "event-spend-cap"
        event["status"] = "spend-cap-blocked"
        event["statusReason"] = "event-spend-cap"
        runtime["lastSkipReason"] = event["statusReason"]
        write_event_log(
            event,
            "limit-order-blocked-by-spend-cap",
            {
                "side": side,
                "plannedTotalUsd": round_money(planned_total),
                "estimatedCostUsd": round_money(estimated_cost),
                "maxEventTotalSpendUsd": round_money(MAX_EVENT_TOTAL_SPEND_USD),
            },
        )
        return False

    try:
        ensure_funds_or_use_cached(runtime, trader, estimated_cost)
        baseline = safe_get_position_size(trader, order["tokenId"]) if before_position is None else before_position
        expiration_ts = limit_expiration_ts(event)
        response = trader.place_limit_buy(
            order["tokenId"],
            shares,
            price_cents,
            event.get("tickSize"),
            event.get("negRisk"),
            expiration_ts,
        )
        order_id = extract_order_id(response)
        if not order_id:
            raise RuntimeError("limit order did not return order id")

        order["status"] = "limit-open"
        order["triggerType"] = "limit-pair"
        order["executionMode"] = "limit"
        order["limitOrderId"] = order_id
        order["limitOrderPlacedAt"] = current_time.isoformat()
        order["limitPriceCents"] = round_money(price_cents)
        order["limitShares"] = round_money(shares)
        order["limitBaselineShares"] = round_money(baseline)
        order["limitExpiresAt"] = datetime.fromtimestamp(expiration_ts, tz=UTC).isoformat() if expiration_ts else None
        order["lastError"] = None
        order["lastErrorAt"] = None
        event["status"] = "limit-open"
        event["statusReason"] = None
        runtime["lastSkipReason"] = None
        write_event_log(
            event,
            "limit-order-opened",
            {
                "side": side,
                "observedCents": observed_cents,
                "limitPriceCents": price_cents,
                "shares": shares,
                "estimatedCostUsd": estimated_cost,
                "orderId": order_id,
                "expiresAt": order["limitExpiresAt"],
            },
        )
        time.sleep(POSITION_CONFIRM_DELAY_MS / 1000.0)
        reconcile_limit_order_fill(runtime, event, side, trader)
        return True
    except Exception as exc:
        order["status"] = "waiting-retry"
        order["lastError"] = trim_text(exc)
        order["lastErrorAt"] = now_utc().isoformat()
        runtime["lastSkipReason"] = "limit-order-failed-waiting-retry"
        write_event_log(
            event,
            "limit-order-error",
            {
                "side": side,
                "observedCents": observed_cents,
                "limitPriceCents": price_cents,
                "shares": shares,
                "estimatedCostUsd": estimated_cost,
                "error": trim_text(exc),
            },
        )
        return False


def place_trigger_entry_order(
    runtime: Dict[str, Any],
    event: Dict[str, Any],
    side: str,
    observed_cents: float,
    trader,
    before_position: Optional[float] = None,
) -> bool:
    if not hasattr(trader, "place_buy"):
        return False

    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    baseline = safe_get_position_size(trader, order["tokenId"]) if before_position is None else before_position
    price_cap_cents = round_money(THRESHOLD_CENTS)
    budget_remaining_usd = event_remaining_budget_usd(event)
    order_remaining_usd = order_remaining_trigger_usd(event, order)
    amount_usd = round_money(min(order_remaining_usd, budget_remaining_usd))
    if amount_usd <= EPSILON:
        order["status"] = "matched" if order_trigger_complete(event, order) else "event-cap-reached"
        runtime["lastSkipReason"] = "event-max-spend-reached"
        return False

    try:
        estimated_price_cents = None
        if hasattr(trader, "estimate_buy_price"):
            estimated_price = trader.estimate_buy_price(order["tokenId"], float(amount_usd))
            if estimated_price is not None:
                estimated_price_cents = round_money(float(estimated_price) * 100.0)
                order["lastEstimatedPriceCents"] = estimated_price_cents
                if estimated_price_cents > THRESHOLD_CENTS + EPSILON:
                    order["status"] = "waiting-retry"
                    order["lastError"] = f"estimated fill {estimated_price_cents:.3f}c above threshold {THRESHOLD_CENTS:.3f}c"
                    order["lastErrorAt"] = now_utc().isoformat()
                    runtime["lastSkipReason"] = "trigger-estimated-price-above-threshold"
                    write_event_log(
                        event,
                        "trigger-order-depth-blocked",
                        {
                            "side": side,
                            "observedCents": round_money(observed_cents),
                            "estimatedPriceCents": estimated_price_cents,
                            "thresholdCents": round_money(THRESHOLD_CENTS),
                            "amountUsd": amount_usd,
                        },
                    )
                    return False

        ensure_funds_or_use_cached(runtime, trader, amount_usd)
        order["triggerType"] = "trigger-threshold"
        response = trader.place_buy(
            order["tokenId"],
            float(amount_usd),
            round(price_cap_cents / 100.0, 4),
            event.get("tickSize"),
            event.get("negRisk"),
        )
        time.sleep(POSITION_CONFIRM_DELAY_MS / 1000.0)
        current_position = safe_get_position_size(trader, order["tokenId"])
        shares_delta = max(0.0, current_position - baseline)
        fill = extract_response_fill(response)
        response_shares = float(fill.get("sharesBought") or 0.0)
        response_spent = float(fill.get("spentUsd") or 0.0)
        if response_shares > shares_delta:
            shares_delta = response_shares
        if shares_delta <= EPSILON:
            raise RuntimeError("trigger order did not increase position")

        actual_spent = response_spent
        if actual_spent <= EPSILON:
            actual_spent = round_money(min(amount_usd, shares_delta * (price_cap_cents / 100.0)))
        if actual_spent <= EPSILON:
            actual_spent = amount_usd

        record_trigger_fill(
            event,
            side,
            observed_cents,
            shares_delta,
            actual_spent,
            response,
            False,
        )
        runtime["lastSkipReason"] = None
        return True
    except Exception as exc:
        try:
            time.sleep(POSITION_CONFIRM_DELAY_MS / 1000.0)
            current_position = safe_get_position_size(trader, order["tokenId"])
            shares_delta = max(0.0, current_position - baseline)
            if shares_delta > EPSILON:
                aggregate_spent = round_money(min(amount_usd, shares_delta * (price_cap_cents / 100.0)))
                record_trigger_fill(
                    event,
                    side,
                    observed_cents,
                    shares_delta,
                    aggregate_spent if aggregate_spent > EPSILON else amount_usd,
                    {"orderID": order.get("orderId")},
                    True,
                )
                runtime["lastSkipReason"] = None
                return True
        except Exception:
            pass

        order["status"] = "waiting-retry"
        order["lastError"] = trim_text(exc)
        order["lastErrorAt"] = now_utc().isoformat()
        runtime["lastSkipReason"] = "trigger-order-failed-waiting-retry"
        write_event_log(
            event,
            "trigger-order-error",
            {
                "side": side,
                "observedCents": observed_cents,
                "priceCapCents": price_cap_cents,
                "requestedUsd": amount_usd,
                "remainingUsd": order_remaining_trigger_usd(event, order),
                "estimatedPriceCents": order.get("lastEstimatedPriceCents"),
                "error": trim_text(exc),
            },
        )
        return False


def attempt_place_order(
    runtime: Dict[str, Any],
    event: Dict[str, Any],
    side: str,
    observed_cents: float,
    trader,
) -> None:
    order = hydrate_order_state(event["orders"][side])
    event["orders"][side] = order
    current_time = now_utc()
    if event_uses_trigger_threshold_entry_mode(event) and order_trigger_complete(event, order):
        return
    if str(order.get("status") or "") == "limit-open":
        return
    if order.get("blocked"):
        runtime["lastSkipReason"] = order.get("blockedReason") or "order-blocked"
        return
    if not order_is_qualified(observed_cents):
        return
    if current_time >= parse_iso(event["firstEntryDeadline"]):
        return
    if not order_is_retry_ready(order, current_time):
        return
    remaining_usd = order_remaining_trigger_usd(event, order)
    if remaining_usd <= EPSILON:
        order["status"] = "matched"
        return
    remaining_budget_usd = event_remaining_budget_usd(event)
    if remaining_budget_usd <= EPSILON:
        runtime["lastSkipReason"] = "event-max-spend-reached"
        return
    order["attemptCount"] = int(order.get("attemptCount") or 0) + 1
    order["lastAttemptAt"] = current_time.isoformat()
    order["retryEligibleAt"] = (current_time + timedelta(milliseconds=RETRY_GAP_MS)).isoformat()
    order["lastObservedCents"] = round_money(observed_cents)
    if not order.get("firstQualifiedAt"):
        order["firstQualifiedAt"] = current_time.isoformat()
    order["lastQualifiedAt"] = current_time.isoformat()
    order["status"] = "placing"
    execution_mode = "limit-pair" if event_uses_limit_pair_entry_mode(event) else "trigger-threshold"
    write_event_log(
        event,
        "order-attempt",
        {
            "side": side,
            "attemptCount": order["attemptCount"],
            "observedCents": observed_cents,
            "targetUsd": order_target_spend_usd(event, order),
            "remainingUsd": remaining_usd,
            "eventBudgetRemainingUsd": remaining_budget_usd,
            "executionMode": execution_mode,
        },
    )

    before_position = safe_get_position_size(trader, order["tokenId"])
    if event_uses_limit_pair_entry_mode(event):
        place_limit_entry_order(runtime, event, side, observed_cents, trader, before_position)
    else:
        place_trigger_entry_order(runtime, event, side, observed_cents, trader, before_position)


def maybe_finalize_late_skip(runtime: Dict[str, Any], event: Dict[str, Any]) -> bool:
    if event.get("firstEntryPlaced"):
        return False
    if event_has_open_limit_order(event):
        return False
    deadline = parse_iso(event.get("firstEntryDeadline"))
    if deadline is None or now_utc() < deadline:
        return False
    event["status"] = "late-no-entry"
    event["statusReason"] = "first-entry-deadline-passed"
    finalize_active_event(runtime, event, winner_side=None)
    return True


def try_resolve_winner(event: Dict[str, Any]) -> Optional[str]:
    payload = legacy.fetch_event(event["slug"])
    if not isinstance(payload, dict) or not payload.get("markets"):
        return None
    market = payload["markets"][0]
    prices = parse_json_array(market.get("outcomePrices"))
    token_ids = parse_json_array(market.get("clobTokenIds"))
    if len(prices) != len(token_ids) or len(prices) < 2:
        return None
    try:
        up_index = token_ids.index(event["orders"]["up"]["tokenId"])
        down_index = token_ids.index(event["orders"]["down"]["tokenId"])
        up_price = float(prices[up_index])
        down_price = float(prices[down_index])
    except Exception:
        return None
    if up_price >= 0.999 and down_price <= 0.001:
        return "up"
    if down_price >= 0.999 and up_price <= 0.001:
        return "down"
    return None


def update_group_after_event(group: Dict[str, Any], event: Dict[str, Any]) -> None:
    pnl = round_money(float(event.get("pnlUsd") or 0.0))
    traded = float(event.get("spentUsd") or 0.0) > EPSILON
    realized_before = round_money(float(group.get("realizedNetPnlUsd") or 0.0))
    realized_after = round_money(realized_before + pnl)
    withdraw_rate = float(group.get("profitWithdrawRate") or PROFIT_WITHDRAW_RATE)
    withdrawn_now = round_money(max(0.0, pnl) * withdraw_rate)
    retained_now = round_money(pnl - withdrawn_now)
    balance_before = round_money(float(group.get("balanceUsd") or 0.0))
    balance_after = round_money(balance_before + retained_now)

    group["totalEvents"] = int(group.get("totalEvents") or 0) + 1
    group["realizedNetPnlUsd"] = realized_after
    group["withdrawnProfitUsd"] = round_money(float(group.get("withdrawnProfitUsd") or 0.0) + withdrawn_now)
    group["balanceUsd"] = balance_after
    group["peakBalanceUsd"] = max(float(group.get("peakBalanceUsd") or 0.0), float(group["balanceUsd"]))
    drawdown = float(group["peakBalanceUsd"]) - float(group["balanceUsd"])
    group["maxDrawdownUsd"] = round_money(max(float(group.get("maxDrawdownUsd") or 0.0), drawdown))
    event["withdrawnProfitUsd"] = withdrawn_now
    event["retainedPnlUsd"] = retained_now
    event["groupBalanceAfterUsd"] = round_money(float(group.get("balanceUsd") or 0.0))

    if traded:
        group["tradedEvents"] = int(group.get("tradedEvents") or 0) + 1
        if pnl > EPSILON:
            group["winningEvents"] = int(group.get("winningEvents") or 0) + 1
        elif pnl < -EPSILON:
            group["losingEvents"] = int(group.get("losingEvents") or 0) + 1
        else:
            group["flatEvents"] = int(group.get("flatEvents") or 0) + 1
    else:
        group["skippedEvents"] = int(group.get("skippedEvents") or 0) + 1

    if group.get("recoveryMode"):
        anchor = float(group.get("recoveryAnchorPnlUsd") or 0.0)
        group["recoveryPnlSinceAnchorUsd"] = round_money(realized_after - anchor)
        if realized_after > anchor + EPSILON:
            group["recoveryMode"] = False
            group["recoveryAnchorPnlUsd"] = None
            group["recoveryAnchorEventKey"] = None
            group["recoveryPnlSinceAnchorUsd"] = 0.0
            group["recoveryStartedAt"] = None
            group["currentLossStreak"] = 0
            group["lossStreakAnchorPnlUsd"] = None
            group["lossStreakAnchorEventKey"] = None
        elif pnl >= -EPSILON:
            group["currentLossStreak"] = 0
    else:
        if traded and pnl < -EPSILON:
            previous_streak = int(group.get("currentLossStreak") or 0)
            if previous_streak <= 0:
                group["lossStreakAnchorPnlUsd"] = realized_before
                group["lossStreakAnchorEventKey"] = event.get("eventKey")
            group["currentLossStreak"] = previous_streak + 1
            if group["currentLossStreak"] >= RECOVERY_TRIGGER_LOSSES:
                group["recoveryMode"] = True
                group["recoveryStartedAt"] = now_utc().isoformat()
                group["recoveryAnchorPnlUsd"] = group.get("lossStreakAnchorPnlUsd")
                group["recoveryAnchorEventKey"] = group.get("lossStreakAnchorEventKey")
                group["recoveryPnlSinceAnchorUsd"] = round_money(
                    realized_after - float(group.get("recoveryAnchorPnlUsd") or 0.0)
                )
        else:
            group["currentLossStreak"] = 0
            group["lossStreakAnchorPnlUsd"] = None
            group["lossStreakAnchorEventKey"] = None

    group["lastResolvedEventKey"] = event.get("eventKey")
    group["lastResolvedAt"] = now_utc().isoformat()
    group["updatedAt"] = now_utc().isoformat()
    update_pause_state(group)


def finalize_active_event(runtime: Dict[str, Any], event: Dict[str, Any], winner_side: Optional[str]) -> None:
    payout = 0.0
    if winner_side in ("up", "down"):
        payout = float(event["orders"][winner_side].get("sharesBought") or 0.0)
    event["winnerSide"] = winner_side
    event["payoutUsd"] = round_money(payout)
    event["pnlUsd"] = round_money(float(event.get("payoutUsd") or 0.0) - float(event.get("spentUsd") or 0.0))
    event["finalizedAt"] = now_utc().isoformat()
    if not event.get("status"):
        event["status"] = "resolved" if float(event.get("spentUsd") or 0.0) > EPSILON else "skipped"
    if float(event.get("spentUsd") or 0.0) > EPSILON and event.get("status") not in {"late-no-entry"}:
        event["status"] = "resolved"
    row = build_event_row(event)
    upsert_history_row(EVENT_DETAILS_PATH, row, MAX_HISTORY_ITEMS, ["eventKey"])
    append_trade_rows(event)
    update_group_after_event(runtime["group"], event)
    runtime["lastEvaluatedEventKey"] = event.get("eventKey")
    runtime["lastSkipReason"] = event.get("statusReason") if row["spentUsd"] <= EPSILON else None
    runtime["activeEvent"] = None
    write_event_log(
        event,
        "event-finalized",
        {
            "status": event.get("status"),
            "statusReason": event.get("statusReason"),
            "winnerSide": winner_side,
            "spentUsd": event.get("spentUsd"),
            "payoutUsd": event.get("payoutUsd"),
            "pnlUsd": event.get("pnlUsd"),
        },
    )
    persist_runtime(runtime)


def record_paused_skip(runtime: Dict[str, Any], meta: Dict[str, Any]) -> None:
    event = create_event_state(meta, runtime["group"])
    event["status"] = "paused-skip"
    event["statusReason"] = runtime["group"].get("pauseReason") or "group-paused"
    finalize_active_event(runtime, event, winner_side=None)


def record_low_balance_skip(runtime: Dict[str, Any], meta: Dict[str, Any]) -> None:
    event = create_event_state(meta, runtime["group"])
    event["status"] = "balance-skip"
    event["statusReason"] = f"wallet-balance-below-minimum-{MIN_EVENT_BALANCE_USD:.2f}"
    finalize_active_event(runtime, event, winner_side=None)


def low_balance_reason() -> str:
    return f"wallet-balance-below-minimum-{MIN_EVENT_BALANCE_USD:.2f}"


def mark_event_waiting_funds(runtime: Dict[str, Any], event: Dict[str, Any]) -> None:
    reason = low_balance_reason()
    current_status = str(event.get("status") or "")
    if float(event.get("spentUsd") or 0.0) <= EPSILON and current_status not in {"late-no-entry", "awaiting-resolution"}:
        event["status"] = "waiting-funds"
    event["statusReason"] = reason
    runtime["lastSkipReason"] = reason


def clear_waiting_funds_status(runtime: Dict[str, Any], event: Dict[str, Any]) -> None:
    if str(event.get("statusReason") or "") != low_balance_reason():
        return
    event["statusReason"] = None
    if float(event.get("spentUsd") or 0.0) > EPSILON:
        event["status"] = "live"
    elif not event.get("firstEntryPlaced"):
        event["status"] = "watching"
    runtime["lastSkipReason"] = None


def can_still_enter_event(meta: Dict[str, Any]) -> bool:
    event_start = meta.get("eventStart")
    if not isinstance(event_start, datetime):
        return False
    first_entry_deadline = event_start.astimezone(UTC) + timedelta(minutes=FIRST_ENTRY_DEADLINE_MINUTES)
    return now_utc() < first_entry_deadline


def should_reopen_same_event_for_funds(runtime: Dict[str, Any], event_key: str, meta: Dict[str, Any]) -> bool:
    if runtime.get("activeEvent"):
        return False
    if runtime.get("lastEvaluatedEventKey") != event_key:
        return False
    if str(runtime.get("lastSkipReason") or "") != low_balance_reason():
        return False
    return can_still_enter_event(meta)


def resolve_entry_event_for_now() -> Optional[Dict[str, Any]]:
    if not PRESTART_ONLY_ENABLED:
        return legacy.resolve_event_for_date(now_utc())

    current_time = now_utc()
    window_minutes = float(getattr(legacy, "ORDER_WINDOW_MINUTES", 240.0) or 240.0)
    current_window_start = legacy.align_to_window_start(current_time)
    next_start = current_window_start + timedelta(minutes=window_minutes)
    entry_open = next_start - timedelta(minutes=PRESTART_ENTRY_LEAD_MINUTES)
    entry_close = entry_open + timedelta(seconds=PRESTART_ENTRY_WINDOW_SECONDS)
    if not (entry_open <= current_time < min(entry_close, next_start)):
        return None

    return legacy.resolve_event_for_date(next_start + timedelta(seconds=1))


def sample_active_event(runtime: Dict[str, Any], trader) -> None:
    event = runtime["activeEvent"]
    if not isinstance(event, dict):
        return

    refresh_runtime_wallet_status(runtime, trader)
    if event_uses_limit_pair_entry_mode(event):
        reconcile_limit_orders(runtime, event, trader)
    if maybe_finalize_late_skip(runtime, event):
        return

    if float(event.get("spentUsd") or 0.0) <= EPSILON and any(
        hydrate_order_state(event["orders"].get(side) or {}).get("blocked") for side in ("up", "down")
    ):
        event["status"] = "external-position-skip"
        event["statusReason"] = event.get("statusReason") or "external-position-interference"
        finalize_active_event(runtime, event, winner_side=None)
        return

    now_value = now_utc()
    event_end = parse_iso(event.get("eventEnd"))
    if event_end and now_value >= event_end:
        reconcile_limit_orders(runtime, event, trader)
        cancel_open_limit_orders(event, trader)
        if float(event.get("spentUsd") or 0.0) <= EPSILON:
            event["status"] = "ended-no-entry"
            event["statusReason"] = "window-ended-no-entry"
            finalize_active_event(runtime, event, winner_side=None)
            return
        winner_side = try_resolve_winner(event)
        event["resolutionCheckedAt"] = now_value.isoformat()
        if winner_side is None:
            event["status"] = "awaiting-resolution"
            return
        finalize_active_event(runtime, event, winner_side=winner_side)
        return

    if wallet_below_minimum(runtime) and not event_has_open_limit_order(event):
        mark_event_waiting_funds(runtime, event)
        return

    clear_waiting_funds_status(runtime, event)
    if event_uses_limit_pair_entry_mode(event):
        retry_market_top_ups(runtime, event, trader)
        place_starting_limit_orders(runtime, event, trader)
        reconcile_limit_orders(runtime, event, trader)
        retry_market_top_ups(runtime, event, trader)

    prices = legacy.fetch_live_prices(
        {
            "tokens": {
                "up": event["orders"]["up"]["tokenId"],
                "down": event["orders"]["down"]["tokenId"],
            }
        }
    )
    event["sampleCount"] = int(event.get("sampleCount") or 0) + 1
    event["lastSampleAt"] = now_value.isoformat()
    event["lastSample"] = {
        "upCents": round_money(float(prices["upCents"])),
        "downCents": round_money(float(prices["downCents"])),
    }
    event["orders"]["up"]["lastObservedCents"] = round_money(float(prices["upCents"]))
    event["orders"]["down"]["lastObservedCents"] = round_money(float(prices["downCents"]))

    if event_uses_trigger_threshold_entry_mode(event):
        candidates = []
        for side in ("up", "down"):
            observed_cents = float(prices[f"{side}Cents"])
            if not order_is_qualified(observed_cents):
                continue
            order = hydrate_order_state(event["orders"].get(side) or {})
            event["orders"][side] = order
            if order_trigger_complete(event, order):
                continue
            candidates.append((observed_cents, 0 if side == "up" else 1, side))
        for _, _, trigger_side in sorted(candidates):
            attempt_place_order(runtime, event, trigger_side, float(prices[f"{trigger_side}Cents"]), trader)

    if LOG_EVERY_SAMPLES > 0 and event["sampleCount"] % LOG_EVERY_SAMPLES == 0:
        log(
            f"Sample {event['sampleCount']} | Up {float(prices['upCents']):.3f}c "
            f"Down {float(prices['downCents']):.3f}c | "
            f"spent=${float(event.get('spentUsd') or 0.0):.3f} | status={event.get('status')}"
        )


def maybe_start_current_event(runtime: Dict[str, Any], trader) -> None:
    meta = resolve_entry_event_for_now()
    if not meta or not meta.get("eventStart") or not meta.get("eventEnd"):
        runtime["lastSkipReason"] = "waiting-prestart-window" if PRESTART_ONLY_ENABLED else "no-active-event"
        persist_runtime(runtime)
        return
    if not meta_matches_variant(meta):
        runtime["lastSkipReason"] = "variant-mismatch"
        runtime["lastUpdatedAt"] = now_utc().isoformat()
        persist_runtime(runtime)
        log(
            f"Skipped mismatched event for {VARIANT}: slug={meta.get('slug')} "
            f"expectedPrefix={VARIANT_EVENT_PREFIX}"
        )
        return
    event_key = build_event_key(meta)
    if not can_still_enter_event(meta):
        runtime["lastEvaluatedEventKey"] = event_key
        runtime["lastSkipReason"] = "first-entry-deadline-passed"
        runtime["lastUpdatedAt"] = now_utc().isoformat()
        persist_runtime(runtime)
        return
    reactivated = maybe_reactivate_group(runtime["group"])
    if reactivated:
        log(
            f"Reactivated bankroll tranche for {VARIANT}: "
            f"tranche {runtime['group'].get('tranchesUsed')}/{runtime['group'].get('maxTranches')} "
            f"balance=${float(runtime['group'].get('balanceUsd') or 0.0):.2f}"
        )
    update_pause_state(runtime["group"])
    if runtime.get("lastEvaluatedEventKey") == event_key and not reactivated:
        if should_reopen_same_event_for_funds(runtime, event_key, meta):
            runtime["lastEvaluatedEventKey"] = None
        else:
            runtime["lastUpdatedAt"] = now_utc().isoformat()
            persist_runtime(runtime)
            return
    if runtime["group"].get("status") in {"paused", "stopped"}:
        record_paused_skip(runtime, meta)
        return
    runtime["activeEvent"] = create_event_state(meta, runtime["group"])
    runtime["lastSkipReason"] = None
    refresh_runtime_wallet_status(runtime, trader)
    if wallet_below_minimum(runtime):
        mark_event_waiting_funds(runtime, runtime["activeEvent"])
    elif uses_limit_pair_entry_mode():
        place_starting_limit_orders(runtime, runtime["activeEvent"], trader)
    persist_runtime(runtime)
    log(
        f"Recovery worker active | variant={VARIANT} entryMode={ENTRY_MODE} "
        f"threshold={THRESHOLD_CENTS:.1f}c leg=${group_leg_size(runtime['group']):.2f} "
        f"deadline={FIRST_ENTRY_DEADLINE_MINUTES}m"
    )


def main() -> None:
    ensure_dir(RUNTIME_DIR)
    ensure_dir(REPORTS_DIR)
    ensure_dir(LOGS_DIR)
    acquire_lock()

    trader = legacy.create_trader()
    if hasattr(trader, "initialize"):
        trader.initialize()
    runtime = load_runtime_state()
    refresh_runtime_wallet_status(runtime, trader)
    persist_runtime(runtime)
    log(
        f"Recovery trader ready | variant={VARIANT} mode={runtime['mode']} entryMode={ENTRY_MODE} "
        f"threshold={THRESHOLD_CENTS:.1f}c startBalance=${START_BALANCE_USD:.2f} "
        f"base=${BASE_LEG_USD:.2f} recovery=${RECOVERY_LEG_USD:.2f} "
        f"restart={RESTART_DELAY_HOURS:.1f}h maxTranches={MAX_BANKROLL_TRANCHES} "
        f"withdraw={PROFIT_WITHDRAW_RATE * 100:.1f}%"
    )

    while True:
        try:
            if runtime.get("activeEvent"):
                sample_active_event(runtime, trader)
            else:
                maybe_start_current_event(runtime, trader)
            persist_runtime(runtime)
        except Exception as exc:
            runtime["lastSkipReason"] = trim_text(exc)
            persist_runtime(runtime)
            log(f"Loop error: {exc}")
        active_event = runtime.get("activeEvent")
        if isinstance(active_event, dict) and active_event.get("status") == "awaiting-resolution":
            time.sleep(max(1, RESOLUTION_RETRY_MS // 1000))
        else:
            time.sleep(max(1, SAMPLE_INTERVAL_MS // 1000))


if __name__ == "__main__":
    main()
