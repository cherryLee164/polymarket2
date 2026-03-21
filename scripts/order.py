import atexit
import importlib.util
import json
import os
import subprocess
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx
import requests
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import (
    BalanceAllowanceParams,
    MarketOrderArgs,
    OrderType,
    PartialCreateOrderOptions,
)
from py_clob_client.exceptions import PolyApiException
from py_clob_client.http_helpers import helpers as clob_http_helpers
from py_clob_client.order_builder.constants import BUY, SELL


ROOT_DIR = Path(__file__).resolve().parents[1]


def load_env_file(file_path: Path) -> None:
    if not file_path.exists():
        return
    for raw_line in file_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
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


def backfill_env(target: str, source_keys) -> None:
    existing = os.getenv(target)
    if existing is not None and str(existing).strip() != "":
        return
    for source_key in source_keys:
        value = os.getenv(source_key)
        if value is not None and str(value).strip() != "":
            os.environ[target] = str(value).strip()
            return


backfill_env("BUILDER_API_KEY", ["RELAYER_API_KEY", "apiKey"])
backfill_env("BUILDER_SECRET", ["RELAYER_SECRET", "secret"])
backfill_env(
    "BUILDER_PASS_PHRASE",
    ["BUILDER_PASS_PHRASE", "BUILDER_PASSPHRASE", "RELAYER_PASS_PHRASE", "passphrase"],
)
backfill_env("RELAYER_API_KEY", ["BUILDER_API_KEY", "apiKey"])
backfill_env("RELAYER_SECRET", ["BUILDER_SECRET", "secret"])
backfill_env(
    "RELAYER_PASS_PHRASE",
    ["BUILDER_PASS_PHRASE", "BUILDER_PASSPHRASE", "passphrase"],
)


def load_legacy_config():
    config_path = ROOT_DIR / "config.py"
    if not config_path.exists():
        return None
    spec = importlib.util.spec_from_file_location("_ploymarket_legacy_config", config_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


LEGACY_CONFIG = load_legacy_config()


def get_first_env(keys, fallback=""):
    for key in keys:
        value = os.getenv(key)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return fallback


def get_variant_scope() -> str:
    return {"1h": "1H", "4h": "4H", "5m": "5M"}.get(ORDER_VARIANT, ORDER_VARIANT.upper())


def get_variant_setting(name: str, default, allow_global_for_1h: bool = True) -> str:
    variant_key = f"ORDER_{get_variant_scope()}_{name}"
    value = get_first_env([variant_key], "")
    if value != "":
        return value
    if ORDER_VARIANT == "1h" and allow_global_for_1h:
        return get_first_env([f"ORDER_{name}"], str(default))
    return str(default)


def get_optional_number(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except Exception:
        return None


def parse_bool(value, default=False):
    if value in (None, ""):
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_legacy_value(name: str, fallback=None):
    if LEGACY_CONFIG is None:
        return fallback
    return getattr(LEGACY_CONFIG, name, fallback)


API_BASE = get_first_env(
    ["API_BASE"],
    str(get_legacy_value("API_BASE", "https://gamma-api.polymarket.com")),
)
DATA_API_BASE = get_first_env(
    ["DATA_API_URL"],
    str(get_legacy_value("DATA_API_URL", "https://data-api.polymarket.com")),
)
CLOB_BASE = get_first_env(
    ["CLOB_BASE"],
    str(get_legacy_value("HOST", "https://clob.polymarket.com")),
)
ORDER_VARIANT = get_first_env(["ORDER_VARIANT"], "1h").strip().lower()
ORDER_VARIANT_DEFAULTS = {
    "1h": {
        "eventPrefix": "bitcoin-up-or-down-",
        "eventSuffix": "-et",
        "slugMode": "calendar-et",
        "windowMinutes": 60,
        "sampleIntervalMs": 5000,
        "minOrderIntervalMs": 0,
        "attemptCooldownMs": 15000,
        "signalMinDurationMinutes": 50,
        "minFirstEntryMinutesRemaining": 30,
        "minStartupMinutesRemaining": 0,
        "firstEntryCents": 38,
        "hedgeEntryCents": 38,
        "baseUsd": 1,
        "escalatedUsd": 2,
        "riskPauseEnabled": False,
        "riskWindowHours": 12,
        "riskMaxLossUsd": 10,
        "riskPauseHours": 8,
    },
    "4h": {
        "eventPrefix": "btc-updown-4h-",
        "eventSuffix": "",
        "slugMode": "timestamp-start",
        "windowMinutes": 240,
        "sampleIntervalMs": 30000,
        "minOrderIntervalMs": 0,
        "attemptCooldownMs": 15000,
        "signalMinDurationMinutes": 210,
        "minFirstEntryMinutesRemaining": 60,
        "minStartupMinutesRemaining": 0,
        "firstEntryCents": 35,
        "hedgeEntryCents": 35,
        "baseUsd": 1,
        "escalatedUsd": 1,
        "riskPauseEnabled": False,
        "riskWindowHours": 12,
        "riskMaxLossUsd": 10,
        "riskPauseHours": 8,
    },
    "5m": {
        "eventPrefix": "btc-updown-5m-",
        "eventSuffix": "",
        "slugMode": "timestamp-start",
        "windowMinutes": 5,
        "sampleIntervalMs": 2000,
        "minOrderIntervalMs": 4000,
        "attemptCooldownMs": 4000,
        "signalMinDurationMinutes": 4.5,
        "minFirstEntryMinutesRemaining": 1.5,
        "minStartupMinutesRemaining": 4.5,
        "firstEntryCents": 30,
        "hedgeEntryCents": 50,
        "baseUsd": 1,
        "escalatedUsd": 1,
        "riskPauseEnabled": True,
        "riskWindowHours": 12,
        "riskMaxLossUsd": 10,
        "riskPauseHours": 8,
    },
}
ORDER_VARIANT_CONFIG = ORDER_VARIANT_DEFAULTS.get(ORDER_VARIANT, ORDER_VARIANT_DEFAULTS["1h"])
EVENT_PREFIX = get_first_env(["EVENT_PREFIX"], ORDER_VARIANT_CONFIG["eventPrefix"])
EVENT_SUFFIX = get_first_env(["EVENT_SUFFIX"], ORDER_VARIANT_CONFIG["eventSuffix"])
ORDER_SLUG_MODE = get_first_env(["ORDER_SLUG_MODE"], ORDER_VARIANT_CONFIG["slugMode"]).strip().lower()
ORDER_WINDOW_MINUTES = float(
    get_variant_setting("WINDOW_MINUTES", ORDER_VARIANT_CONFIG["windowMinutes"])
)
TIME_ZONE = get_first_env(["TIME_ZONE"], "America/New_York")
LOG_TIME_ZONE = get_first_env(["LOG_TIME_ZONE"], "Asia/Shanghai")

ORDER_SAMPLE_INTERVAL_MS = int(
    get_variant_setting("SAMPLE_INTERVAL_MS", ORDER_VARIANT_CONFIG["sampleIntervalMs"])
)
ORDER_MIN_ORDER_INTERVAL_MS = int(
    get_variant_setting("MIN_ORDER_INTERVAL_MS", ORDER_VARIANT_CONFIG["minOrderIntervalMs"])
)
ORDER_START_RETRY_MS = int(get_first_env(["ORDER_START_RETRY_MS"], "10000"))
ORDER_EVENT_MISSING_RETRY_MS = int(get_first_env(["ORDER_EVENT_MISSING_RETRY_MS"], "30000"))
ORDER_ATTEMPT_COOLDOWN_MS = int(
    get_variant_setting("ATTEMPT_COOLDOWN_MS", ORDER_VARIANT_CONFIG["attemptCooldownMs"])
)
ORDER_CONFIRMATION_PENDING_MS = max(ORDER_ATTEMPT_COOLDOWN_MS, ORDER_MIN_ORDER_INTERVAL_MS)
ORDER_RECONCILE_INTERVAL_MS = int(get_first_env(["ORDER_RECONCILE_INTERVAL_MS"], "60000"))
ORDER_AUTO_REDEEM_ENABLED = parse_bool(
    get_first_env(["ORDER_AUTO_REDEEM_ENABLED"], "false"),
    False,
)
ORDER_REDEEM_INTERVAL_MS = int(
    get_first_env(["ORDER_REDEEM_INTERVAL_MS"], str(ORDER_RECONCILE_INTERVAL_MS))
)
ORDER_REDEEM_START_DELAY_MINUTES = float(
    get_first_env(["ORDER_REDEEM_START_DELAY_MINUTES"], "120")
)
ORDER_REDEEM_RETRY_COOLDOWN_MS = int(
    get_first_env(["ORDER_REDEEM_RETRY_COOLDOWN_MS"], "300000")
)
ORDER_SETTLEMENT_IDLE_INTERVAL_MS = int(
    get_first_env(["ORDER_SETTLEMENT_IDLE_INTERVAL_MS"], "3600000")
)
ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS = int(
    get_first_env(["ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS"], "600000")
)
ORDER_FIRST_ENTRY_CENTS = float(
    get_variant_setting("FIRST_ENTRY_CENTS", ORDER_VARIANT_CONFIG["firstEntryCents"])
)
ORDER_HEDGE_ENTRY_CENTS = float(
    get_variant_setting("HEDGE_ENTRY_CENTS", ORDER_VARIANT_CONFIG["hedgeEntryCents"])
)
ORDER_MIN_FIRST_ENTRY_MINUTES_REMAINING = float(
    get_variant_setting(
        "MIN_FIRST_ENTRY_MINUTES_REMAINING",
        str(ORDER_VARIANT_CONFIG["minFirstEntryMinutesRemaining"]),
    )
)
ORDER_MIN_STARTUP_MINUTES_REMAINING = float(
    get_variant_setting(
        "MIN_STARTUP_MINUTES_REMAINING",
        str(ORDER_VARIANT_CONFIG["minStartupMinutesRemaining"]),
    )
)
ORDER_BASE_USD = float(get_variant_setting("BASE_USD", ORDER_VARIANT_CONFIG["baseUsd"]))
ORDER_ESCALATED_USD = float(
    get_variant_setting("ESCALATED_USD", ORDER_VARIANT_CONFIG["escalatedUsd"])
)
ORDER_MIN_BALANCE_USD = float(get_first_env(["ORDER_MIN_BALANCE_USD"], "2"))
ORDER_MAX_SAMPLES = int(get_first_env(["ORDER_MAX_SAMPLES"], "0"))
ORDER_PRICE_SIDE = get_first_env(["ORDER_PRICE_SIDE"], "BUY").upper()
ORDER_EXECUTION_TYPE = get_first_env(["ORDER_EXECUTION_TYPE"], "FOK").upper()
ORDER_DRY_RUN = parse_bool(get_first_env(["ORDER_DRY_RUN"], "true"), True)
ORDER_AUTO_APPROVE = parse_bool(get_first_env(["ORDER_AUTO_APPROVE"], "false"), False)
ORDER_CLOB_HTTP2 = parse_bool(get_first_env(["ORDER_CLOB_HTTP2"], "false"), False)
ORDER_CLOB_HTTP_TIMEOUT_MS = int(get_first_env(["ORDER_CLOB_HTTP_TIMEOUT_MS"], "15000"))
ORDER_CLOB_CONNECT_TIMEOUT_MS = int(
    get_first_env(["ORDER_CLOB_CONNECT_TIMEOUT_MS"], "5000")
)
ORDER_SIGNAL_MIN_DURATION_MINUTES = float(
    get_variant_setting(
        "SIGNAL_MIN_DURATION_MINUTES",
        str(ORDER_VARIANT_CONFIG["signalMinDurationMinutes"]),
    )
)
ORDER_RISK_PAUSE_ENABLED = parse_bool(
    get_variant_setting("RISK_PAUSE_ENABLED", ORDER_VARIANT_CONFIG["riskPauseEnabled"], False),
    bool(ORDER_VARIANT_CONFIG["riskPauseEnabled"]),
)
ORDER_RISK_WINDOW_HOURS = float(
    get_variant_setting("RISK_WINDOW_HOURS", ORDER_VARIANT_CONFIG["riskWindowHours"], False)
)
ORDER_RISK_MAX_LOSS_USD = float(
    get_variant_setting("RISK_MAX_LOSS_USD", ORDER_VARIANT_CONFIG["riskMaxLossUsd"], False)
)
ORDER_RISK_PAUSE_HOURS = float(
    get_variant_setting("RISK_PAUSE_HOURS", ORDER_VARIANT_CONFIG["riskPauseHours"], False)
)
ORDER_5M_EXECUTION_GUARD_ENABLED = parse_bool(
    get_first_env(["ORDER_5M_EXECUTION_GUARD_ENABLED"], "true"),
    True,
)
ORDER_5M_EXECUTION_GUARD_LOOKBACK = int(
    get_first_env(["ORDER_5M_EXECUTION_GUARD_LOOKBACK"], "5")
)
ORDER_5M_EXECUTION_GUARD_MAX_FAILURES = int(
    get_first_env(["ORDER_5M_EXECUTION_GUARD_MAX_FAILURES"], "4")
)
ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS = float(
    get_first_env(["ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS"], "8")
)
ORDER_DETECTED_FILL_MIN_SHARE_RATIO = 0.9

POLY_CHAIN_ID = int(
    get_first_env(
        ["POLY_CHAIN_ID", "CHAIN_ID"],
        str(get_legacy_value("CHAIN_ID", "137")),
    )
)
POLY_SIGNATURE_TYPE = get_optional_number(
    get_first_env(
        ["POLY_SIGNATURE_TYPE", "CLOB_SIGNATURE_TYPE", "SIGNATURE_TYPE"],
        str(get_legacy_value("SIGNATURE_TYPE", "")),
    )
)
POLY_PRIVATE_KEY = get_first_env(
    ["POLY_PRIVATE_KEY", "PORTFOLIO_PRIVATE_KEY", "PRIVATE_KEY", "PK", "pk"],
    str(get_legacy_value("PRIVATE_KEY", "")),
)
POLY_FUNDER = get_first_env(
    [
        "POLY_FUNDER",
        "FUNDER",
        "FUNDER_ADDRESS",
        "PROFILE_ADDRESS",
        "PROXY_WALLET",
        "PORTFOLIO_ADDRESS",
    ],
    str(get_legacy_value("FUNDER", get_legacy_value("PROXY_ADDRESS", ""))),
)
POLY_GEO_BLOCK_TOKEN = get_first_env(
    ["POLY_GEO_BLOCK_TOKEN", "FOOTBALL_DATA_TOKEN"],
    str(get_legacy_value("FOOTBALL_DATA_TOKEN", "")),
)
BUILDER_API_KEY = get_first_env(["BUILDER_API_KEY"], str(get_legacy_value("BUILDER_API_KEY", "")))
BUILDER_SECRET = get_first_env(["BUILDER_SECRET"], str(get_legacy_value("BUILDER_SECRET", "")))
BUILDER_PASS_PHRASE = get_first_env(
    ["BUILDER_PASS_PHRASE", "BUILDER_PASSPHRASE"],
    str(get_legacy_value("BUILDER_PASS_PHRASE", get_legacy_value("BUILDER_PASSPHRASE", ""))),
)
RELAYER_URL = get_first_env(
    ["RELAYER_URL"],
    str(get_legacy_value("RELAYER_URL", "https://relayer-v2.polymarket.com/")),
)
POLY_RPC_URL = get_first_env(
    ["POLY_RPC_URL", "RPC_URL"],
    str(get_legacy_value("RPC_URL", "https://polygon-bor-rpc.publicnode.com")),
)
if not POLY_RPC_URL or str(POLY_RPC_URL).strip().lower() == "none":
    POLY_RPC_URL = "https://polygon-bor-rpc.publicnode.com"
CLAIM_AUTO_DEPLOY_SAFE = parse_bool(
    get_first_env(["CLAIM_AUTO_DEPLOY_SAFE"], str(get_legacy_value("CLAIM_AUTO_DEPLOY_SAFE", "false"))),
    False,
)
CLAIM_SIZE_THRESHOLD = get_first_env(
    ["CLAIM_SIZE_THRESHOLD"],
    str(get_legacy_value("CLAIM_SIZE_THRESHOLD", "0.1")),
)
COLLATERAL_TOKEN_ADDRESS = get_first_env(
    ["COLLATERAL_TOKEN_ADDRESS"],
    str(get_legacy_value("COLLATERAL_TOKEN_ADDRESS", "")),
)
CTF_ADDRESS = get_first_env(
    ["CTF_ADDRESS"],
    str(get_legacy_value("CTF_ADDRESS", "")),
)
NEG_RISK_ADAPTER_ADDRESS = get_first_env(
    ["NEG_RISK_ADAPTER_ADDRESS"],
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
)
PROXY_FACTORY_ADDRESS = get_first_env(
    ["PROXY_FACTORY_ADDRESS"],
    "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
)
PROXY_RELAY_HUB_ADDRESS = get_first_env(
    ["PROXY_RELAY_HUB_ADDRESS"],
    "0xD216153c06E857cD7f72665E0aF1d7D82172F494",
)
PROXY_INIT_CODE_HASH = get_first_env(
    ["PROXY_INIT_CODE_HASH"],
    "0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b",
)

DATA_DIR = ROOT_DIR / "data" / "orders"
HOURS_DIR = DATA_DIR / "hours"
LOGS_DIR = DATA_DIR / "logs"
REPORTS_DIR = DATA_DIR / "reports"
LEGACY_RUNTIME_STATE_PATH = DATA_DIR / "runtime-state.json"
RUNTIME_STATE_PATH = DATA_DIR / f"runtime-state-{ORDER_VARIANT}.json"
RISK_STATE_PATH = DATA_DIR / "risk-state.json"
MONITOR_SUMMARIES_DIR = ROOT_DIR / "data" / "summaries"
HOUR_DETAILS_REPORT_PATH = REPORTS_DIR / "hour-details.json"
ORDER_DETAILS_REPORT_PATH = REPORTS_DIR / "order-details.json"
ORDER_SUMMARY_REPORT_PATH = REPORTS_DIR / "summary.json"

NY_TZ = ZoneInfo(TIME_ZONE)
LOG_TZ = ZoneInfo(LOG_TIME_ZONE)
UTC = timezone.utc
SESSION = requests.Session()
ZERO_BYTES32 = "0x" + "0" * 64
SESSION.headers.update(
    {
        "accept": "application/json",
        "cache-control": "no-cache, no-store",
        "pragma": "no-cache",
    }
)
REDEEM_WARNING_EMITTED = False
RELAY_CLIENT = None
RELAY_SAFE_READY = False
REDEEM_CONTRACTS = None
RPC_WEB3 = None
ORDER_SUBMIT_EXECUTOR = None
ACTIVE_ORDER_SUBMISSIONS: Dict[str, Future] = {}


def configure_clob_http_transport() -> None:
    timeout = httpx.Timeout(
        connect=max(1.0, ORDER_CLOB_CONNECT_TIMEOUT_MS / 1000),
        read=max(1.0, ORDER_CLOB_HTTP_TIMEOUT_MS / 1000),
        write=max(1.0, ORDER_CLOB_HTTP_TIMEOUT_MS / 1000),
        pool=max(1.0, ORDER_CLOB_CONNECT_TIMEOUT_MS / 1000),
    )
    previous_client = getattr(clob_http_helpers, "_http_client", None)
    if previous_client is not None:
        try:
            previous_client.close()
        except Exception:
            pass

    clob_http_helpers._http_client = httpx.Client(
        http2=ORDER_CLOB_HTTP2,
        timeout=timeout,
    )

    def request_with_detail(endpoint: str, method: str, headers=None, data=None):
        try:
            headers = clob_http_helpers.overloadHeaders(method, headers)
            if isinstance(data, str):
                response = clob_http_helpers._http_client.request(
                    method=method,
                    url=endpoint,
                    headers=headers,
                    content=data.encode("utf-8"),
                )
            else:
                response = clob_http_helpers._http_client.request(
                    method=method,
                    url=endpoint,
                    headers=headers,
                    json=data,
                )

            if response.status_code != 200:
                raise PolyApiException(response)

            try:
                return response.json()
            except ValueError:
                return response.text
        except httpx.RequestError as exc:
            request = getattr(exc, "request", None)
            request_ref = ""
            if request is not None:
                request_ref = f" [{request.method} {request.url}]"
            raise PolyApiException(
                error_msg=f"Request exception! {exc.__class__.__name__}: {exc}{request_ref}"
            ) from exc

    clob_http_helpers.request = request_with_detail


configure_clob_http_transport()


def claim_credentials_available() -> bool:
    return all(value.strip() for value in (BUILDER_API_KEY, BUILDER_SECRET, BUILDER_PASS_PHRASE))


def ensure_dir(dir_path: Path) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)


def log(message: str) -> None:
    now = datetime.now(LOG_TZ).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now} {LOG_TIME_ZONE}] {message}", flush=True)


def parse_date(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
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


def resolve_claim_contract_addresses():
    global REDEEM_CONTRACTS
    if REDEEM_CONTRACTS is not None:
        return REDEEM_CONTRACTS

    collateral = COLLATERAL_TOKEN_ADDRESS or ""
    conditional = CTF_ADDRESS or ""
    if not collateral or not conditional:
        try:
            from py_clob_client.config import get_contract_config

            contract_config = get_contract_config(POLY_CHAIN_ID)
            collateral = collateral or contract_config.collateral
            conditional = conditional or contract_config.conditional_tokens
        except Exception:
            pass

    REDEEM_CONTRACTS = (collateral, conditional)
    return REDEEM_CONTRACTS


def fetch_market_for_token(token_id: str):
    if not token_id:
        return None
    try:
        book_resp = SESSION.get(f"{CLOB_BASE}/book", params={"token_id": token_id}, timeout=10)
    except Exception:
        return None
    if book_resp.status_code != 200:
        return None
    book_payload = book_resp.json()
    condition_id = book_payload.get("market")
    if not condition_id:
        return None
    try:
        market_resp = SESSION.get(f"{CLOB_BASE}/markets/{condition_id}", timeout=10)
    except Exception:
        return None
    if market_resp.status_code != 200:
        return None
    market_payload = market_resp.json()
    if "condition_id" not in market_payload:
        market_payload["condition_id"] = condition_id
    return market_payload


def market_is_resolved(market_payload) -> bool:
    tokens = market_payload.get("tokens") or []
    return any(token.get("winner") is True for token in tokens) or bool(
        market_payload.get("is_50_50_outcome")
    )


def fetch_redeemable_positions(proxy_address: str):
    if not proxy_address:
        return []
    limit = 100
    offset = 0
    positions = []
    while True:
        params = {
            "user": proxy_address,
            "sizeThreshold": str(CLAIM_SIZE_THRESHOLD),
            "redeemable": "true",
            "limit": str(limit),
            "offset": str(offset),
        }
        try:
            resp = SESSION.get(f"{DATA_API_BASE}/positions", params=params, timeout=10)
        except Exception:
            break
        if resp.status_code != 200:
            break
        batch = resp.json()
        if not batch:
            break
        positions.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return positions


def fetch_user_positions(proxy_address: str, size_threshold: float = 0.0):
    if not proxy_address:
        return []
    limit = 100
    offset = 0
    positions = []
    while True:
        params = {
            "user": proxy_address,
            "sizeThreshold": str(size_threshold),
            "limit": str(limit),
            "offset": str(offset),
        }
        try:
            resp = SESSION.get(f"{DATA_API_BASE}/positions", params=params, timeout=10)
        except Exception:
            break
        if resp.status_code != 200:
            break
        batch = resp.json()
        if not batch:
            break
        positions.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return positions


def fetch_position_size(proxy_address: str, token_id: str) -> float:
    if not proxy_address or not token_id:
        return 0.0
    token_text = str(token_id)
    for position in fetch_user_positions(proxy_address, size_threshold=0):
        if str(position.get("asset") or "") != token_text:
            continue
        try:
            return float(position.get("size") or 0.0)
        except Exception:
            return 0.0
    return 0.0


def group_positions_by_condition(positions):
    grouped = {}
    for position in positions:
        condition_id = position.get("conditionId")
        outcome_index = position.get("outcomeIndex")
        if condition_id is None or outcome_index is None:
            continue
        grouped.setdefault(condition_id, set()).add(1 << int(outcome_index))
    return grouped


def encode_redeem_call_data(ctf_address: str, collateral_address: str, condition_id: str, index_sets):
    try:
        from web3 import Web3
    except Exception as exc:
        raise RuntimeError("web3 is required to encode redeemPositions call data") from exc

    checksum = getattr(Web3, "to_checksum_address", None) or getattr(Web3, "toChecksumAddress")
    contract = Web3().eth.contract(
        address=checksum(ctf_address),
        abi=[
            {
                "inputs": [
                    {"internalType": "address", "name": "collateralToken", "type": "address"},
                    {"internalType": "bytes32", "name": "parentCollectionId", "type": "bytes32"},
                    {"internalType": "bytes32", "name": "conditionId", "type": "bytes32"},
                    {"internalType": "uint256[]", "name": "indexSets", "type": "uint256[]"},
                ],
                "name": "redeemPositions",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function",
            }
        ],
    )
    args = [checksum(collateral_address), ZERO_BYTES32, condition_id, index_sets]
    if hasattr(contract, "encode_abi"):
        return contract.encode_abi("redeemPositions", args=args)
    return contract.encodeABI(fn_name="redeemPositions", args=args)


def encode_neg_risk_redeem_call_data(adapter_address: str, condition_id: str, outcome_index: int, size: float):
    try:
        from web3 import Web3
    except Exception as exc:
        raise RuntimeError("web3 is required to encode neg-risk redeemPositions call data") from exc

    checksum = getattr(Web3, "to_checksum_address", None) or getattr(Web3, "toChecksumAddress")
    contract = Web3().eth.contract(
        address=checksum(adapter_address),
        abi=[
            {
                "inputs": [
                    {"internalType": "bytes32", "name": "conditionId", "type": "bytes32"},
                    {"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"},
                ],
                "name": "redeemPositions",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function",
            }
        ],
    )
    amount = max(0, int(float(size or 0) * 1_000_000))
    amounts = [0, 0]
    while len(amounts) <= int(outcome_index):
        amounts.append(0)
    amounts[int(outcome_index)] = amount
    args = [condition_id, amounts]
    if hasattr(contract, "encode_abi"):
        return contract.encode_abi("redeemPositions", args=args)
    return contract.encodeABI(fn_name="redeemPositions", args=args)


def get_relay_client(require_safe: bool = True):
    global RELAY_CLIENT, RELAY_SAFE_READY

    if RELAY_CLIENT is None:
        try:
            from py_builder_relayer_client.client import RelayClient
            from py_builder_signing_sdk.config import BuilderConfig
            from py_builder_signing_sdk.sdk_types import BuilderApiKeyCreds
        except Exception as exc:
            raise RuntimeError("builder relayer dependencies are not installed") from exc

        builder_creds = BuilderApiKeyCreds(
            key=BUILDER_API_KEY,
            secret=BUILDER_SECRET,
            passphrase=BUILDER_PASS_PHRASE,
        )
        builder_config = BuilderConfig(local_builder_creds=builder_creds)
        RELAY_CLIENT = RelayClient(
            RELAYER_URL,
            POLY_CHAIN_ID,
            private_key=POLY_PRIVATE_KEY,
            builder_config=builder_config,
        )

    if require_safe and not RELAY_SAFE_READY:
        expected_safe = RELAY_CLIENT.get_expected_safe()
        if not RELAY_CLIENT.get_deployed(expected_safe):
            if CLAIM_AUTO_DEPLOY_SAFE:
                deploy_resp = RELAY_CLIENT.deploy()
                deploy_resp.wait()
            else:
                raise RuntimeError(
                    f"safe {expected_safe} is not deployed. Set CLAIM_AUTO_DEPLOY_SAFE=true to deploy automatically."
                )
        RELAY_SAFE_READY = True

    return RELAY_CLIENT


def get_rpc_web3():
    global RPC_WEB3
    if RPC_WEB3 is not None:
        return RPC_WEB3
    try:
        from web3 import Web3
    except Exception as exc:
        raise RuntimeError("web3 is required for proxy gas estimation") from exc
    if not POLY_RPC_URL:
        raise RuntimeError("missing POLY_RPC_URL/RPC_URL for proxy gas estimation")
    RPC_WEB3 = Web3(Web3.HTTPProvider(POLY_RPC_URL))
    return RPC_WEB3


def normalize_address(value: Optional[str]) -> str:
    return str(value or "").strip().lower()


def addresses_match(left: Optional[str], right: Optional[str]) -> bool:
    return bool(normalize_address(left)) and normalize_address(left) == normalize_address(right)


def derive_proxy_wallet_address(signer_address: str) -> str:
    try:
        from eth_utils import keccak, to_bytes, to_checksum_address
    except Exception as exc:
        raise RuntimeError("eth-utils is required to derive proxy wallet addresses") from exc
    salt = keccak(to_bytes(hexstr=signer_address))
    address_hash = keccak(
        b"\xff"
        + to_bytes(hexstr=PROXY_FACTORY_ADDRESS)
        + salt
        + to_bytes(hexstr=PROXY_INIT_CODE_HASH)
    )
    return to_checksum_address(address_hash[-20:])


def encode_proxy_transaction_data(transactions):
    try:
        from web3 import Web3
    except Exception as exc:
        raise RuntimeError("web3 is required to encode proxy transactions") from exc

    checksum = getattr(Web3, "to_checksum_address", None) or getattr(Web3, "toChecksumAddress")
    contract = Web3().eth.contract(
        address=checksum(PROXY_FACTORY_ADDRESS),
        abi=[
            {
                "constant": False,
                "inputs": [
                    {
                        "components": [
                            {"name": "typeCode", "type": "uint8"},
                            {"name": "to", "type": "address"},
                            {"name": "value", "type": "uint256"},
                            {"name": "data", "type": "bytes"},
                        ],
                        "name": "calls",
                        "type": "tuple[]",
                    }
                ],
                "name": "proxy",
                "outputs": [{"name": "returnValues", "type": "bytes[]"}],
                "payable": True,
                "stateMutability": "payable",
                "type": "function",
            }
        ],
    )
    calls = [
        (
            int(txn.get("typeCode") or 1),
            checksum(txn["to"]),
            int(txn.get("value") or 0),
            txn["data"],
        )
        for txn in transactions
    ]
    if hasattr(contract, "encode_abi"):
        return contract.encode_abi("proxy", args=[calls])
    return contract.encodeABI(fn_name="proxy", args=[calls])


def fetch_proxy_relay_payload(signer_address: str):
    resp = SESSION.get(
        f"{RELAYER_URL.rstrip('/')}/relay-payload",
        params={"address": signer_address, "type": "PROXY"},
        timeout=20,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("address") or payload.get("nonce") is None:
        raise RuntimeError("invalid PROXY relay payload")
    return payload


def estimate_proxy_gas_limit(from_address: str, proxy_data: str) -> str:
    try:
        web3_client = get_rpc_web3()
        gas_limit = web3_client.eth.estimate_gas(
            {
                "from": from_address,
                "to": PROXY_FACTORY_ADDRESS,
                "data": proxy_data,
            }
        )
        return str(int(gas_limit))
    except Exception as exc:
        log(f"Proxy gas estimate failed, fallback to 10000000: {exc}")
        return "10000000"


def create_proxy_struct_hash(
    from_address: str,
    to_address: str,
    data: str,
    tx_fee: str,
    gas_price: str,
    gas_limit: str,
    nonce: str,
    relay_hub_address: str,
    relay_address: str,
):
    try:
        from eth_utils import keccak, to_bytes
    except Exception as exc:
        raise RuntimeError("eth-utils is required to build proxy relay transactions") from exc
    return keccak(
        b"rlx:"
        + to_bytes(hexstr=from_address)
        + to_bytes(hexstr=to_address)
        + to_bytes(hexstr=data)
        + int(tx_fee).to_bytes(32, "big")
        + int(gas_price).to_bytes(32, "big")
        + int(gas_limit).to_bytes(32, "big")
        + int(nonce).to_bytes(32, "big")
        + to_bytes(hexstr=relay_hub_address)
        + to_bytes(hexstr=relay_address)
    )


def execute_proxy_transactions(transactions, metadata: Optional[str] = None, funder: Optional[str] = None):
    relayer = get_relay_client(require_safe=False)
    signer_address = relayer.signer.address()
    proxy_wallet = derive_proxy_wallet_address(signer_address)
    if funder and not addresses_match(funder, proxy_wallet):
        raise RuntimeError(f"funder {funder} does not match derived proxy wallet {proxy_wallet}")

    proxy_data = encode_proxy_transaction_data(transactions)
    relay_payload = fetch_proxy_relay_payload(signer_address)
    nonce = str(relay_payload["nonce"])
    relay_address = str(relay_payload["address"])
    gas_price = "0"
    tx_fee = "0"
    gas_limit = estimate_proxy_gas_limit(signer_address, proxy_data)
    struct_hash = create_proxy_struct_hash(
        signer_address,
        PROXY_FACTORY_ADDRESS,
        proxy_data,
        tx_fee,
        gas_price,
        gas_limit,
        nonce,
        PROXY_RELAY_HUB_ADDRESS,
        relay_address,
    )
    signature = relayer.signer.sign_eip712_struct_hash(struct_hash)
    request_payload = {
        "from": signer_address,
        "to": PROXY_FACTORY_ADDRESS,
        "proxyWallet": proxy_wallet,
        "data": proxy_data,
        "nonce": nonce,
        "signature": signature,
        "signatureParams": {
            "gasPrice": gas_price,
            "gasLimit": gas_limit,
            "relayerFee": tx_fee,
            "relayHub": PROXY_RELAY_HUB_ADDRESS,
            "relay": relay_address,
        },
        "type": "PROXY",
        "metadata": metadata or "",
    }
    response_payload = relayer._post_request("POST", "/submit", request_payload)
    transaction_id = response_payload.get("transactionID")
    transaction_hash = response_payload.get("transactionHash")
    receipt = None
    if transaction_id:
        receipt = relayer.poll_until_state(
            transaction_id,
            ["STATE_MINED", "STATE_CONFIRMED"],
            "STATE_FAILED",
            max_polls=45,
            poll_frequency=2000,
        )
    return {
        "transaction_id": transaction_id,
        "transaction_hash": transaction_hash,
        "receipt": receipt,
        "gas_limit": gas_limit,
        "proxy_wallet": proxy_wallet,
        "mode": "proxy",
    }


def select_redeem_execution_mode(funder: Optional[str] = None, signature_type: Optional[int] = None) -> str:
    relayer = get_relay_client(require_safe=False)
    signer_address = relayer.signer.address()
    proxy_wallet = derive_proxy_wallet_address(signer_address)
    if funder and addresses_match(funder, proxy_wallet):
        return "proxy"
    expected_safe = relayer.get_expected_safe()
    if funder and addresses_match(funder, expected_safe):
        return "safe"
    if signature_type in (1, 2):
        return "proxy"
    return "safe"


def execute_redeem(
    condition_id: str,
    index_sets,
    funder: Optional[str] = None,
    signature_type: Optional[int] = None,
    negative_risk: bool = False,
    outcome_index: Optional[int] = None,
    size: Optional[float] = None,
):
    collateral, conditional = resolve_claim_contract_addresses()
    if not collateral or not conditional:
        raise RuntimeError("missing collateral or conditional token contract address")

    target_contract = conditional
    if negative_risk:
        if outcome_index is None:
            raise RuntimeError("negative-risk redeem requires outcome_index")
        if not NEG_RISK_ADAPTER_ADDRESS:
            raise RuntimeError("missing NEG_RISK_ADAPTER_ADDRESS")
        target_contract = NEG_RISK_ADAPTER_ADDRESS
        call_data = encode_neg_risk_redeem_call_data(
            NEG_RISK_ADAPTER_ADDRESS,
            condition_id,
            int(outcome_index),
            float(size or 0.0),
        )
    else:
        call_data = encode_redeem_call_data(conditional, collateral, condition_id, index_sets)
    if ORDER_DRY_RUN:
        return {
            "condition_id": condition_id,
            "index_sets": index_sets,
            "dry_run": True,
            "source": "data-api",
            "mode": select_redeem_execution_mode(funder, signature_type),
        }

    mode = select_redeem_execution_mode(funder, signature_type)
    if mode == "proxy":
        proxy_result = execute_proxy_transactions(
            [{"to": target_contract, "typeCode": 1, "data": call_data, "value": "0"}],
            metadata=f"redeem:{condition_id}",
            funder=funder,
        )
        return {
            "condition_id": condition_id,
            "transaction_id": proxy_result.get("transaction_id"),
            "transaction_hash": proxy_result.get("transaction_hash"),
            "receipt": proxy_result.get("receipt"),
            "dry_run": False,
            "source": "data-api",
            "mode": "proxy",
            "gas_limit": proxy_result.get("gas_limit"),
            "proxy_wallet": proxy_result.get("proxy_wallet"),
        }

    relayer = get_relay_client(require_safe=True)
    try:
        from py_builder_relayer_client.models import OperationType, SafeTransaction
    except Exception as exc:
        raise RuntimeError("py-builder-relayer-client is required for live claims") from exc

    tx = SafeTransaction(
        to=target_contract,
        operation=OperationType.Call,
        data=call_data,
        value="0",
    )
    resp = relayer.execute([tx], metadata=f"redeem:{condition_id}")
    receipt = resp.wait()
    return {
        "condition_id": condition_id,
        "transaction_id": resp.transaction_id,
        "transaction_hash": resp.transaction_hash,
        "receipt": receipt,
        "dry_run": False,
        "source": "data-api",
        "mode": "safe",
    }


def to_cents(price: float) -> float:
    return round(price * 100, 3)


def parse_float(value, fallback=None):
    if value in (None, ""):
        return fallback
    try:
        return float(value)
    except Exception:
        return fallback


def parse_json_array(value):
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return []
    return []


def request_json(url: str, params: Optional[Dict[str, Any]] = None) -> Any:
    response = SESSION.get(url, params=params, timeout=20)
    response.raise_for_status()
    return response.json()


def align_to_window_start(target: datetime) -> datetime:
    window_ms = max(1, int(ORDER_WINDOW_MINUTES * 60 * 1000))
    aligned_ms = int(target.timestamp() * 1000) // window_ms * window_ms
    return datetime.fromtimestamp(aligned_ms / 1000, tz=UTC)


def slug_candidates_for_date(target: datetime):
    if ORDER_SLUG_MODE == "timestamp-start":
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


def fetch_event(slug: str):
    payload = request_json(f"{API_BASE}/events", params={"slug": slug, "_ts": int(time.time() * 1000)})
    if isinstance(payload, list):
        return payload[0] if payload else None
    if isinstance(payload, dict):
        return payload
    return None


def fetch_public_profile(address: str):
    if not address:
        return None
    payload = request_json(
        f"{API_BASE}/public-profile",
        params={"address": address, "_ts": int(time.time() * 1000)},
    )
    return payload if isinstance(payload, dict) else None


def extract_outcome_map(market: Dict[str, Any]):
    outcomes = parse_json_array(market.get("outcomes"))
    token_ids = parse_json_array(market.get("clobTokenIds"))
    if len(outcomes) < 2 or len(outcomes) != len(token_ids):
        raise RuntimeError("missing outcomes or token ids")
    pairs = [{"outcome": str(outcomes[idx]), "tokenId": str(token_ids[idx])} for idx in range(len(outcomes))]
    up_entry = next((item for item in pairs if item["outcome"].lower() == "up"), pairs[0])
    down_entry = next((item for item in pairs if item["outcome"].lower() == "down"), pairs[1 if pairs[0] == up_entry else 0])
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
        event_start = event_end - timedelta(minutes=ORDER_WINDOW_MINUTES)
    outcome_map = extract_outcome_map(market)
    return {
        "slug": slug,
        "event": event,
        "market": market,
        "eventId": event.get("id"),
        "marketId": market.get("id"),
        "variant": ORDER_VARIANT,
        "windowMinutes": ORDER_WINDOW_MINUTES,
        "eventStart": event_start,
        "eventEnd": event_end,
        "tickSize": str(market.get("orderPriceMinTickSize") or "") or None,
        "orderMinSize": float(market.get("orderMinSize") or 0),
        "negRisk": bool(market.get("negRisk") or event.get("negRisk") or False),
        **outcome_map,
    }


def resolve_event_for_date(target: datetime):
    selected = None
    for slug in slug_candidates_for_date(target):
        event = fetch_event(slug)
        if not event or not event.get("markets"):
            continue
        meta = build_event_meta(slug, event, event["markets"][0])
        event_start = meta["eventStart"]
        event_end = meta["eventEnd"]
        if event_start and event_end and event_start <= target.astimezone(UTC) < event_end:
            return meta
        if selected is None:
            selected = meta
    return selected


def read_json_file(file_path: Path):
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_json_file(file_path: Path, payload) -> None:
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_json_line(file_path: Path, payload) -> None:
    with file_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def list_json_files(dir_path: Path):
    if not dir_path.exists():
        return []
    return [path for path in dir_path.iterdir() if path.is_file() and path.suffix.lower() == ".json"]


LAST_RISK_GATE_LOG_KEY = None
LAST_EXECUTION_GUARD_LOG_KEY = None


def load_risk_state() -> Dict[str, Any]:
    payload = read_json_file(RISK_STATE_PATH)
    if isinstance(payload, dict):
        return payload
    return {}


def save_risk_state(payload: Dict[str, Any]) -> None:
    write_json_file(RISK_STATE_PATH, payload)


def build_risk_anchor(row: Dict[str, Any]) -> Optional[datetime]:
    return parse_date(row.get("eventEnd") or row.get("resolvedAt") or row.get("eventStart"))


def resolve_report_variant(row: Dict[str, Any]) -> str:
    return str(
        row.get("variant") or row.get("monitorVariant") or detect_variant_from_slug(row.get("slug"))
    ).lower()


def get_resolved_hour_rows_for_variant(variant: str) -> List[Dict[str, Any]]:
    rows = read_json_file(HOUR_DETAILS_REPORT_PATH)
    if not isinstance(rows, list):
        return []

    normalized_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if resolve_report_variant(row) != variant:
            continue
        if row.get("settlementStatus") != "resolved":
            continue
        anchor = build_risk_anchor(row)
        net_pnl = parse_float(row.get("netPnlUsd"))
        if anchor is None or net_pnl is None:
            continue
        enriched = dict(row)
        enriched["_anchor"] = anchor
        enriched["_netPnlUsd"] = net_pnl
        normalized_rows.append(enriched)

    normalized_rows.sort(key=lambda row: row["_anchor"])
    return normalized_rows


def get_recent_execution_guard_rows(variant: str) -> List[Dict[str, Any]]:
    rows = []
    for file_path in list_json_files(HOURS_DIR):
        state = read_json_file(file_path)
        if not isinstance(state, dict):
            continue
        if str(state.get("variant") or detect_variant_from_slug(state.get("slug"))).lower() != variant:
            continue
        if not state.get("finalizedAt"):
            continue
        health = state.get("executionHealth")
        if not isinstance(health, dict):
            health = build_execution_health(state)
        if not health.get("expectedPair"):
            continue
        anchor = parse_date(state.get("eventEnd") or state.get("finalizedAt") or state.get("eventStart"))
        if anchor is None:
            continue
        rows.append(
            {
                "hourKey": state.get("hourKey"),
                "slug": state.get("slug"),
                "eventEnd": state.get("eventEnd"),
                "finalizedAt": state.get("finalizedAt"),
                "missedPair": bool(health.get("missedPair")),
                "failureCount": int(health.get("failureCount") or 0),
                "failureRows": health.get("failureRows") or [],
                "_anchor": anchor,
            }
        )
    rows.sort(key=lambda row: row["_anchor"])
    return rows


def evaluate_risk_gate(now: datetime) -> Dict[str, Any]:
    window_start = now - timedelta(hours=ORDER_RISK_WINDOW_HOURS)
    rows = get_resolved_hour_rows_for_variant(ORDER_VARIANT)
    recent_rows = [row for row in rows if window_start <= row["_anchor"] <= now]
    rolling_net_pnl = round(sum(row["_netPnlUsd"] for row in recent_rows), 6)
    latest_row = rows[-1] if rows else None

    if ORDER_VARIANT != "5m" or not ORDER_RISK_PAUSE_ENABLED:
        return {
            "enabled": False,
            "active": False,
            "windowHours": ORDER_RISK_WINDOW_HOURS,
            "maxLossUsd": ORDER_RISK_MAX_LOSS_USD,
            "pauseHours": ORDER_RISK_PAUSE_HOURS,
            "rollingNetPnlUsd": rolling_net_pnl,
            "resolvedHours": len(recent_rows),
            "latestHourKey": latest_row.get("hourKey") if latest_row else None,
            "latestEventEnd": latest_row.get("eventEnd") if latest_row else None,
            "pauseUntil": None,
            "justTriggered": False,
            "justResumed": False,
        }

    state = load_risk_state()
    pause_until = parse_date(state.get("pauseUntil"))
    latest_hour_key = latest_row.get("hourKey") if latest_row else None
    latest_event_end = latest_row.get("eventEnd") if latest_row else None
    just_triggered = False
    just_resumed = False
    changed = False

    if pause_until is not None and pause_until <= now and state.get("status") == "paused":
        state["status"] = "ready"
        state["resumedAt"] = now.isoformat()
        changed = True
        just_resumed = True
        pause_until = None

    active = pause_until is not None and pause_until > now
    trigger_limit = -abs(ORDER_RISK_MAX_LOSS_USD)

    if (
        not active
        and latest_hour_key
        and rolling_net_pnl <= trigger_limit
        and state.get("lastTriggerHourKey") != latest_hour_key
    ):
        pause_until_dt = now + timedelta(hours=ORDER_RISK_PAUSE_HOURS)
        state.update(
            {
                "variant": ORDER_VARIANT,
                "status": "paused",
                "pausedAt": now.isoformat(),
                "pauseUntil": pause_until_dt.isoformat(),
                "windowHours": ORDER_RISK_WINDOW_HOURS,
                "maxLossUsd": ORDER_RISK_MAX_LOSS_USD,
                "pauseHours": ORDER_RISK_PAUSE_HOURS,
                "rollingNetPnlUsd": rolling_net_pnl,
                "resolvedHours": len(recent_rows),
                "lastTriggerHourKey": latest_hour_key,
                "lastTriggerEventEnd": latest_event_end,
            }
        )
        pause_until = pause_until_dt
        active = True
        changed = True
        just_triggered = True

    if changed:
        save_risk_state(state)

    return {
        "enabled": True,
        "active": active,
        "windowHours": ORDER_RISK_WINDOW_HOURS,
        "maxLossUsd": ORDER_RISK_MAX_LOSS_USD,
        "pauseHours": ORDER_RISK_PAUSE_HOURS,
        "rollingNetPnlUsd": rolling_net_pnl,
        "resolvedHours": len(recent_rows),
        "latestHourKey": latest_hour_key,
        "latestEventEnd": latest_event_end,
        "pauseUntil": pause_until.isoformat() if pause_until else None,
        "justTriggered": just_triggered,
        "justResumed": just_resumed,
    }


def evaluate_execution_guard(now: datetime) -> Dict[str, Any]:
    if ORDER_VARIANT != "5m" or not ORDER_5M_EXECUTION_GUARD_ENABLED:
        return {
            "enabled": False,
            "active": False,
            "lookback": ORDER_5M_EXECUTION_GUARD_LOOKBACK,
            "maxFailures": ORDER_5M_EXECUTION_GUARD_MAX_FAILURES,
            "pauseHours": ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS,
            "recentWindowCount": 0,
            "recentFailureCount": 0,
            "pauseUntil": None,
            "justTriggered": False,
            "justResumed": False,
        }

    payload = load_risk_state()
    guard = payload.get("executionGuard")
    if not isinstance(guard, dict):
        guard = {}
        payload["executionGuard"] = guard

    recent_rows = get_recent_execution_guard_rows(ORDER_VARIANT)
    window_rows = recent_rows[-max(1, ORDER_5M_EXECUTION_GUARD_LOOKBACK) :]
    failure_rows = [row for row in window_rows if row.get("missedPair")]
    latest_row = window_rows[-1] if window_rows else None
    pause_until = parse_date(guard.get("pauseUntil"))
    just_triggered = False
    just_resumed = False
    changed = False

    if pause_until is not None and pause_until <= now and guard.get("status") == "paused":
        guard["status"] = "ready"
        guard["resumedAt"] = now.isoformat()
        changed = True
        just_resumed = True
        pause_until = None

    active = pause_until is not None and pause_until > now

    if (
        not active
        and len(window_rows) >= max(1, ORDER_5M_EXECUTION_GUARD_LOOKBACK)
        and len(failure_rows) >= max(1, ORDER_5M_EXECUTION_GUARD_MAX_FAILURES)
        and latest_row is not None
        and guard.get("lastTriggerHourKey") != latest_row.get("hourKey")
    ):
        pause_until_dt = now + timedelta(hours=ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS)
        guard.update(
            {
                "variant": ORDER_VARIANT,
                "status": "paused",
                "pausedAt": now.isoformat(),
                "pauseUntil": pause_until_dt.isoformat(),
                "lookback": ORDER_5M_EXECUTION_GUARD_LOOKBACK,
                "maxFailures": ORDER_5M_EXECUTION_GUARD_MAX_FAILURES,
                "pauseHours": ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS,
                "recentWindowCount": len(window_rows),
                "recentFailureCount": len(failure_rows),
                "lastTriggerHourKey": latest_row.get("hourKey"),
                "lastTriggerEventEnd": latest_row.get("eventEnd"),
                "recentWindowKeys": [row.get("hourKey") for row in window_rows],
                "recentFailureKeys": [row.get("hourKey") for row in failure_rows],
            }
        )
        pause_until = pause_until_dt
        active = True
        changed = True
        just_triggered = True

    if changed:
        payload["executionGuard"] = guard
        save_risk_state(payload)

    return {
        "enabled": True,
        "active": active,
        "lookback": ORDER_5M_EXECUTION_GUARD_LOOKBACK,
        "maxFailures": ORDER_5M_EXECUTION_GUARD_MAX_FAILURES,
        "pauseHours": ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS,
        "recentWindowCount": len(window_rows),
        "recentFailureCount": len(failure_rows),
        "pauseUntil": pause_until.isoformat() if pause_until else None,
        "justTriggered": just_triggered,
        "justResumed": just_resumed,
        "recentWindowKeys": [row.get("hourKey") for row in window_rows],
        "recentFailureKeys": [row.get("hourKey") for row in failure_rows],
    }


def maybe_log_risk_gate(gate: Dict[str, Any]) -> None:
    global LAST_RISK_GATE_LOG_KEY
    if not gate.get("enabled"):
        LAST_RISK_GATE_LOG_KEY = None
        return

    if gate.get("active"):
        log_key = f"paused:{gate.get('pauseUntil')}"
        if log_key != LAST_RISK_GATE_LOG_KEY:
            log(
                f"5M risk pause active until {gate.get('pauseUntil')} | "
                f"rolling{gate.get('windowHours')}h=${gate.get('rollingNetPnlUsd')}"
            )
            LAST_RISK_GATE_LOG_KEY = log_key
        return

    if gate.get("justResumed"):
        log("5M risk pause cleared, order engine resumed new entries.")
    LAST_RISK_GATE_LOG_KEY = None


def maybe_log_execution_guard(gate: Dict[str, Any]) -> None:
    global LAST_EXECUTION_GUARD_LOG_KEY
    if not gate.get("enabled"):
        LAST_EXECUTION_GUARD_LOG_KEY = None
        return

    if gate.get("active"):
        log_key = f"exec-paused:{gate.get('pauseUntil')}"
        if log_key != LAST_EXECUTION_GUARD_LOG_KEY:
            log(
                f"5M execution pause active until {gate.get('pauseUntil')} | "
                f"recentMisses={gate.get('recentFailureCount')}/{gate.get('recentWindowCount')}"
            )
            LAST_EXECUTION_GUARD_LOG_KEY = log_key
        return

    if gate.get("justResumed"):
        log("5M execution pause cleared, order engine resumed new entries.")
    LAST_EXECUTION_GUARD_LOG_KEY = None


def wait_for_risk_gate_clear() -> Dict[str, Any]:
    while True:
        gate = evaluate_risk_gate(datetime.now(UTC))
        maybe_log_risk_gate(gate)
        if not gate.get("active"):
            return gate
        pause_until = parse_date(gate.get("pauseUntil"))
        remaining_seconds = max(
            1.0,
            (pause_until - datetime.now(UTC)).total_seconds() if pause_until else 60.0,
        )
        time.sleep(min(300.0, remaining_seconds))


def build_hour_key(meta):
    anchor = meta.get("eventStart") or meta.get("eventEnd") or datetime.now(UTC)
    return f"{meta['slug']}_{format_filename(anchor)}"


def create_order_record(side: str):
    return {
        "side": side,
        "placed": False,
        "mode": "dry-run" if ORDER_DRY_RUN else "live",
        "amountUsd": None,
        "triggerType": None,
        "thresholdCents": None,
        "priceCap": None,
        "observedCents": None,
        "requestedAt": None,
        "attemptCount": 0,
        "lastAttemptAt": None,
        "orderId": None,
        "status": None,
        "response": None,
        "error": None,
        "attemptBlocked": False,
        "lastFailureKind": None,
        "lastFailureAt": None,
        "submissionPending": False,
        "submissionStartedAt": None,
        "submissionBaselineSize": None,
        "submissionLastCheckedAt": None,
        "confirmationPending": False,
        "confirmationStartedAt": None,
        "confirmationBaselineSize": None,
        "confirmationLastCheckedAt": None,
    }


def create_claim_record():
    return {
        "status": "pending",
        "mode": "dry-run" if ORDER_DRY_RUN else "live",
        "startDelayMinutes": ORDER_REDEEM_START_DELAY_MINUTES,
        "readyAt": None,
        "attemptCount": 0,
        "lastAttemptAt": None,
        "lastCheckedAt": None,
        "tokenId": None,
        "conditionId": None,
        "claimedAt": None,
        "transactionId": None,
        "transactionHash": None,
        "receipt": None,
        "source": None,
        "lastError": None,
    }


def build_carry_plan(next_order_usd: float, source: str, reason: str, reference=None):
    return {
        "nextOrderUsd": next_order_usd,
        "source": source,
        "reason": reason,
        "referenceHourKey": reference,
    }


def create_hour_state(meta, carry_plan):
    return {
        "version": 1,
        "mode": "dry-run" if ORDER_DRY_RUN else "live",
        "variant": meta.get("variant") or ORDER_VARIANT,
        "windowMinutes": meta.get("windowMinutes") or ORDER_WINDOW_MINUTES,
        "slug": meta["slug"],
        "hourKey": build_hour_key(meta),
        "eventId": meta.get("eventId"),
        "marketId": meta.get("marketId"),
        "eventStart": meta["eventStart"].isoformat() if meta.get("eventStart") else None,
        "eventEnd": meta["eventEnd"].isoformat() if meta.get("eventEnd") else None,
        "runStartedAt": datetime.now(UTC).isoformat(),
        "orderUsd": carry_plan["nextOrderUsd"],
        "carryPlan": carry_plan,
        "priceSource": f"clob-{ORDER_PRICE_SIDE.lower()}",
        "tickSize": meta.get("tickSize"),
        "orderMinSize": meta.get("orderMinSize"),
        "negRisk": meta.get("negRisk"),
        "tokens": {"up": meta["upTokenId"], "down": meta["downTokenId"]},
        "outcomes": meta["outcomes"],
        "firstSampleAt": None,
        "lastSampleAt": None,
        "sampleCount": 0,
        "minUpCents": None,
        "minDownCents": None,
        "firstEntrySide": None,
        "firstEntryPlacedAt": None,
        "firstEntryTriggerCents": None,
        "firstEntryBlockedLate": False,
        "firstEntryBlockedAt": None,
        "firstEntryBlockedRemainingMinutes": None,
        "pairedAt": None,
        "opportunity": {
            "upLe35": False,
            "downLe35": False,
            "upLe40": False,
            "downLe40": False,
        },
        "orders": {"up": create_order_record("up"), "down": create_order_record("down")},
        "lastOrderAttemptAt": None,
        "claim": create_claim_record(),
        "lastSample": None,
        "executionGuardActive": False,
        "finalizedAt": None,
        "endReason": None,
        "durationMinutes": 0,
        "carrySignalQualified": False,
        "bothSidesLe40": False,
        "nextOrderUsd": None,
    }


def get_runtime_state():
    payload = read_json_file(RUNTIME_STATE_PATH)
    if isinstance(payload, dict):
        return payload
    if ORDER_VARIANT == "1h":
        legacy_payload = read_json_file(LEGACY_RUNTIME_STATE_PATH)
        if isinstance(legacy_payload, dict):
            return legacy_payload
    return None


def save_runtime_state(state) -> None:
    write_json_file(RUNTIME_STATE_PATH, state)
    if ORDER_VARIANT == "1h" and LEGACY_RUNTIME_STATE_PATH.exists():
        try:
            LEGACY_RUNTIME_STATE_PATH.unlink()
        except Exception:
            pass


def clear_runtime_state() -> None:
    if RUNTIME_STATE_PATH.exists():
        RUNTIME_STATE_PATH.unlink()
    if ORDER_VARIANT == "1h" and LEGACY_RUNTIME_STATE_PATH.exists():
        try:
            LEGACY_RUNTIME_STATE_PATH.unlink()
        except Exception:
            pass


def build_log_path(state) -> Path:
    return LOGS_DIR / f"{state['hourKey']}.jsonl"


def build_hour_summary_path(state) -> Path:
    return HOURS_DIR / f"{state['hourKey']}.json"


def write_hour_log(state, record_type: str, details=None) -> None:
    payload = {
        "ts": datetime.now(UTC).isoformat(),
        "type": record_type,
        "slug": state["slug"],
        "hourKey": state["hourKey"],
    }
    if details:
        payload.update(details)
    append_json_line(build_log_path(state), payload)


def update_min(current_value, next_value):
    if current_value is None or next_value < current_value:
        return next_value
    return current_value


def clear_order_confirmation(order_record: Dict[str, Any]) -> None:
    order_record["confirmationPending"] = False
    order_record["confirmationStartedAt"] = None
    order_record["confirmationBaselineSize"] = None
    order_record["confirmationLastCheckedAt"] = None


def clear_order_submission(order_record: Dict[str, Any]) -> None:
    order_record["submissionPending"] = False
    order_record["submissionStartedAt"] = None
    order_record["submissionBaselineSize"] = None
    order_record["submissionLastCheckedAt"] = None


def build_order_submission_key(state, side: str) -> str:
    return f"{state.get('variant') or ORDER_VARIANT}:{state['hourKey']}:{side}"


def get_order_submit_executor():
    global ORDER_SUBMIT_EXECUTOR
    if ORDER_SUBMIT_EXECUTOR is None:
        ORDER_SUBMIT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="order-submit")
    return ORDER_SUBMIT_EXECUTOR


def shutdown_order_submit_executor() -> None:
    global ORDER_SUBMIT_EXECUTOR
    if ORDER_SUBMIT_EXECUTOR is None:
        return
    try:
        ORDER_SUBMIT_EXECUTOR.shutdown(wait=False, cancel_futures=False)
    except Exception:
        pass
    ORDER_SUBMIT_EXECUTOR = None


atexit.register(shutdown_order_submit_executor)


def mark_first_entry_side(state, order_record, fallback_now: Optional[datetime] = None) -> None:
    if state.get("firstEntrySide"):
        return
    requested_at = (
        order_record.get("requestedAt")
        or order_record.get("confirmationStartedAt")
        or order_record.get("lastAttemptAt")
    )
    state["firstEntrySide"] = order_record.get("side")
    state["firstEntryPlacedAt"] = requested_at or (
        fallback_now.isoformat() if fallback_now is not None else None
    )
    state["firstEntryTriggerCents"] = order_record.get("observedCents")


def mark_pair_complete_if_ready(state, now: datetime) -> bool:
    orders = state.get("orders") or {}
    up_placed = isinstance(orders.get("up"), dict) and orders["up"].get("placed")
    down_placed = isinstance(orders.get("down"), dict) and orders["down"].get("placed")
    if not (up_placed and down_placed):
        return False
    if state.get("pairedAt"):
        return True
    state["pairedAt"] = now.isoformat()
    write_hour_log(state, "pair-complete", {"pairedAt": state["pairedAt"]})
    return True


def has_placed_orders(state) -> bool:
    orders = state.get("orders") or {}
    return any(
        isinstance(orders.get(side), dict) and orders[side].get("placed")
        for side in ("up", "down")
    )


def get_claim_ready_at(state) -> Optional[datetime]:
    event_end = parse_date(state.get("eventEnd"))
    if event_end is None:
        return None
    return event_end + timedelta(minutes=ORDER_REDEEM_START_DELAY_MINUTES)


def ensure_claim_record(state):
    claim = state.get("claim")
    if not isinstance(claim, dict):
        claim = create_claim_record()
        state["claim"] = claim
    claim["mode"] = "dry-run" if ORDER_DRY_RUN else "live"
    claim["startDelayMinutes"] = ORDER_REDEEM_START_DELAY_MINUTES
    ready_at = get_claim_ready_at(state)
    if ready_at is not None:
        claim["readyAt"] = ready_at.isoformat()
    return claim


def is_claim_complete(state) -> bool:
    claim = ensure_claim_record(state)
    return claim.get("status") in {"claimed", "dry-run-claimed", "manual-cleared"}


def choose_claim_token_id(state) -> Optional[str]:
    settlement = state.get("settlement") or {}
    winner_side = settlement.get("winnerSide")
    tokens = state.get("tokens") or {}
    if winner_side in {"up", "down"} and tokens.get(winner_side):
        return tokens[winner_side]
    for side in ("up", "down"):
        order_record = (state.get("orders") or {}).get(side)
        if isinstance(order_record, dict) and order_record.get("placed") and tokens.get(side):
            return tokens[side]
    return tokens.get("up") or tokens.get("down")


def should_retry_claim(claim_record: Dict[str, Any], now: datetime) -> bool:
    if claim_record.get("status") in {"claimed", "dry-run-claimed", "manual-cleared"}:
        return False
    last_attempt = parse_date(claim_record.get("lastAttemptAt"))
    if last_attempt is None:
        return True
    return (now - last_attempt).total_seconds() * 1000 >= ORDER_REDEEM_RETRY_COOLDOWN_MS


def outcome_to_side(outcome: str) -> str:
    text = str(outcome or "").strip().lower()
    if text == "up":
        return "up"
    if text == "down":
        return "down"
    return text


def build_order_fill_snapshot(order_record, winner_side=None, resolved=False):
    response = order_record.get("response") or {}
    cost_usd = parse_float(response.get("makingAmount"), parse_float(order_record.get("amountUsd"), 0.0))
    shares_bought = parse_float(response.get("takingAmount"))
    avg_price_cents = None
    if shares_bought and shares_bought > 0 and cost_usd is not None:
        avg_price_cents = round((cost_usd / shares_bought) * 100, 3)

    tx_hashes = response.get("transactionsHashes") or []
    if not isinstance(tx_hashes, list):
        tx_hashes = [tx_hashes]

    payout_usd = None
    net_pnl_usd = None
    is_winner = None
    if resolved:
        is_winner = order_record.get("side") == winner_side
        if shares_bought is not None and cost_usd is not None:
            payout_usd = round(shares_bought if is_winner else 0.0, 6)
            net_pnl_usd = round(payout_usd - cost_usd, 6)

    return {
        "costUsd": round(cost_usd, 6) if cost_usd is not None else None,
        "sharesBought": round(shares_bought, 6) if shares_bought is not None else None,
        "avgPriceCents": avg_price_cents,
        "transactionHashes": tx_hashes,
        "winnerSide": winner_side if resolved else None,
        "isWinner": is_winner,
        "payoutUsd": payout_usd,
        "netPnlUsd": net_pnl_usd,
        "resolved": resolved,
    }


def build_execution_health(state: Dict[str, Any]) -> Dict[str, Any]:
    opportunity = state.get("opportunity") or {}
    orders = state.get("orders") or {}
    up_first_seen = bool(opportunity.get("upLe35"))
    down_first_seen = bool(opportunity.get("downLe35"))
    up_hedge_seen = bool(opportunity.get("upLe40"))
    down_hedge_seen = bool(opportunity.get("downLe40"))

    expected_paths = []
    if up_first_seen and down_hedge_seen:
        expected_paths.append("up-then-down")
    if down_first_seen and up_hedge_seen:
        expected_paths.append("down-then-up")

    failure_rows = []
    for side in ("up", "down"):
        order_record = orders.get(side)
        if not isinstance(order_record, dict):
            continue
        kind = str(order_record.get("lastFailureKind") or "").strip().lower()
        if not kind:
            continue
        failure_rows.append(
            {
                "side": side,
                "kind": kind,
                "status": order_record.get("status"),
                "observedCents": order_record.get("observedCents"),
                "triggerType": order_record.get("triggerType"),
                "attemptCount": int(order_record.get("attemptCount") or 0),
            }
        )

    expected_pair = bool(expected_paths) and not state.get("firstEntryBlockedLate")
    missed_pair = bool(
        state.get("variant") == "5m"
        and expected_pair
        and not state.get("pairedAt")
        and failure_rows
    )
    return {
        "expectedPair": expected_pair,
        "expectedPaths": expected_paths,
        "missedPair": missed_pair,
        "failureCount": len(failure_rows),
        "failureRows": failure_rows,
    }


def update_opportunity_flags(state, up_cents: float, down_cents: float) -> None:
    if up_cents <= ORDER_FIRST_ENTRY_CENTS:
        state["opportunity"]["upLe35"] = True
    if down_cents <= ORDER_FIRST_ENTRY_CENTS:
        state["opportunity"]["downLe35"] = True
    if up_cents <= ORDER_HEDGE_ENTRY_CENTS:
        state["opportunity"]["upLe40"] = True
    if down_cents <= ORDER_HEDGE_ENTRY_CENTS:
        state["opportunity"]["downLe40"] = True


def pick_first_entry_side(state, up_cents: float, down_cents: float):
    candidates = []
    if can_attempt_order(state["orders"]["up"]) and up_cents <= ORDER_FIRST_ENTRY_CENTS:
        candidates.append({"side": "up", "cents": up_cents})
    if can_attempt_order(state["orders"]["down"]) and down_cents <= ORDER_FIRST_ENTRY_CENTS:
        candidates.append({"side": "down", "cents": down_cents})
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item["cents"], item["side"]))
    return candidates[0]


def opposite_side(side: str) -> str:
    return "down" if side == "up" else "up"


def can_attempt_order(order_record: Dict[str, Any]) -> bool:
    if order_record["placed"]:
        return False
    if order_record.get("attemptBlocked"):
        return False
    if order_record.get("submissionPending"):
        return False
    if order_record.get("confirmationPending"):
        return False
    if ORDER_VARIANT == "5m" and int(order_record.get("attemptCount") or 0) >= 2:
        return False
    return True


def should_retry_order(order_record: Dict[str, Any], now: datetime) -> bool:
    if not can_attempt_order(order_record):
        return False
    if not order_record["lastAttemptAt"]:
        return True
    last_attempt = parse_date(order_record["lastAttemptAt"])
    if last_attempt is None:
        return True
    return (now - last_attempt).total_seconds() * 1000 >= ORDER_ATTEMPT_COOLDOWN_MS


def classify_order_exception(exc: Exception) -> Dict[str, str]:
    message = str(exc or "").strip() or "unknown order exception"
    normalized = message.lower()
    if "fully filled or killed" in normalized or "couldn't be fully filled" in normalized:
        return {"kind": "unfilled", "message": message}
    if (
        "request exception" in normalized
        or "read timed out" in normalized
        or "timed out" in normalized
        or "connection" in normalized
    ):
        return {"kind": "transient", "message": message}
    return {"kind": "error", "message": message}


def get_remaining_minutes(state, now: datetime) -> float:
    event_end = parse_date(state.get("eventEnd"))
    if not event_end:
        return 0
    return (event_end - now).total_seconds() / 60


def detect_variant_from_slug(slug: Optional[str]) -> str:
    text = str(slug or "").lower()
    if text.startswith("btc-updown-4h-"):
        return "4h"
    if text.startswith("btc-updown-5m-"):
        return "5m"
    return "1h"


def summary_matches_current_variant(summary: Dict[str, Any]) -> bool:
    if not isinstance(summary, dict):
        return False
    variant = str(
        summary.get("variant")
        or summary.get("monitorVariant")
        or detect_variant_from_slug(summary.get("slug"))
    ).lower()
    return variant == ORDER_VARIANT


def extract_carry_from_order_summary(summary):
    if not isinstance(summary, dict) or not summary.get("carrySignalQualified"):
        return None
    both = bool(summary.get("bothSidesLe40"))
    return build_carry_plan(
        ORDER_BASE_USD if both else ORDER_ESCALATED_USD,
        "orders",
        "previous-order-hour-both-sides-le40" if both else "previous-order-hour-missing-both-sides-le40",
        summary.get("hourKey"),
    )


def extract_carry_from_monitor_summary(summary):
    if not isinstance(summary, dict):
        return None
    try:
        duration = float(summary.get("durationMinutes") or 0)
    except Exception:
        duration = 0
    if duration < ORDER_SIGNAL_MIN_DURATION_MINUTES:
        return None
    thresholds = summary.get("thresholds") or {}
    up = bool((thresholds.get("up") or {}).get("lt40"))
    down = bool((thresholds.get("down") or {}).get("lt40"))
    both = up and down
    return build_carry_plan(
        ORDER_BASE_USD if both else ORDER_ESCALATED_USD,
        "monitor",
        "previous-monitor-hour-both-sides-le40" if both else "previous-monitor-hour-missing-both-sides-le40",
        summary.get("runId") or summary.get("fileName"),
    )


def find_latest_carry_plan_before(event_start_iso: str, directory: Path, extractor):
    event_start = parse_date(event_start_iso)
    if event_start is None:
        return None
    max_gap_seconds = int((ORDER_WINDOW_MINUTES + 5) * 60)
    candidates = []
    for file_path in list_json_files(directory):
        summary = read_json_file(file_path)
        if not isinstance(summary, dict):
            continue
        if not summary_matches_current_variant(summary):
            continue
        end_iso = summary.get("eventEnd") or summary.get("lastSampleAt") or summary.get("eventStart")
        end_date = parse_date(end_iso)
        if end_date is None:
            continue
        delta_seconds = (event_start - end_date).total_seconds()
        if delta_seconds < 0 or delta_seconds > max_gap_seconds:
            continue
        candidates.append((end_date, summary))
    candidates.sort(key=lambda item: item[0], reverse=True)
    for _, summary in candidates:
        carry_plan = extractor(summary)
        if carry_plan:
            return carry_plan
    return None


def determine_carry_plan(event_start_iso: Optional[str]):
    if ORDER_VARIANT in {"5m", "4h"}:
        reason = "5m-fixed-size" if ORDER_VARIANT == "5m" else "4h-fixed-size"
        return build_carry_plan(ORDER_BASE_USD, "variant-default", reason)
    return (
        find_latest_carry_plan_before(event_start_iso, HOURS_DIR, extract_carry_from_order_summary)
        or find_latest_carry_plan_before(
            event_start_iso, MONITOR_SUMMARIES_DIR, extract_carry_from_monitor_summary
        )
        or build_carry_plan(ORDER_BASE_USD, "default", "no-qualified-history")
    )


def build_settlement_snapshot(state):
    checked_at = datetime.now(UTC).isoformat()
    event = fetch_event(state["slug"])
    if not event or not event.get("markets"):
        return {
            "status": "missing",
            "checkedAt": checked_at,
            "eventClosed": None,
            "marketClosed": None,
            "winnerSide": None,
            "winnerOutcome": None,
            "outcomePricesCents": None,
            "resolutionSource": None,
            "lastError": "market not found",
        }

    market = event["markets"][0]
    outcomes = parse_json_array(market.get("outcomes"))
    prices = parse_json_array(market.get("outcomePrices"))
    outcome_prices_cents = {}
    winner_side = None
    winner_outcome = None

    if len(outcomes) == len(prices):
        for index, outcome in enumerate(outcomes):
            price = parse_float(prices[index])
            if price is None:
                continue
            side = outcome_to_side(outcome)
            if side in {"up", "down"}:
                outcome_prices_cents[side] = to_cents(price)
            if price >= 0.999 and winner_side is None:
                winner_side = side
                winner_outcome = str(outcome)

    is_resolved = bool(market.get("closed")) and winner_side in {"up", "down"}
    return {
        "status": "resolved" if is_resolved else "pending",
        "checkedAt": checked_at,
        "eventClosed": bool(event.get("closed")),
        "marketClosed": bool(market.get("closed")),
        "winnerSide": winner_side if is_resolved else None,
        "winnerOutcome": winner_outcome if is_resolved else None,
        "outcomePricesCents": outcome_prices_cents or None,
        "resolutionSource": market.get("resolutionSource"),
        "lastError": None,
    }


def reconcile_hour_state(state):
    if not isinstance(state, dict) or not state.get("finalizedAt") or not has_placed_orders(state):
        return False, False

    before = json.dumps(state, sort_keys=True, ensure_ascii=False)
    previous_status = (state.get("settlement") or {}).get("status")
    settlement = dict(state.get("settlement") or {})

    if settlement.get("status") != "resolved":
        try:
            settlement.update(build_settlement_snapshot(state))
        except Exception as exc:
            settlement["status"] = settlement.get("status") or "pending"
            settlement["checkedAt"] = datetime.now(UTC).isoformat()
            settlement["lastError"] = str(exc)

    resolved = settlement.get("status") == "resolved"
    winner_side = settlement.get("winnerSide") if resolved else None

    total_spent_usd = 0.0
    total_payout_usd = 0.0
    order_count = 0
    for side in ("up", "down"):
        order_record = (state.get("orders") or {}).get(side)
        if not isinstance(order_record, dict) or not order_record.get("placed"):
            continue
        order_count += 1
        order_record["fill"] = build_order_fill_snapshot(order_record, winner_side, resolved)
        fill = order_record["fill"]
        if fill.get("costUsd") is not None:
            total_spent_usd += fill["costUsd"]
        if fill.get("payoutUsd") is not None:
            total_payout_usd += fill["payoutUsd"]

    settlement["hasOrders"] = True
    settlement["orderCount"] = order_count
    settlement["totalSpentUsd"] = round(total_spent_usd, 6)
    settlement["totalPayoutUsd"] = round(total_payout_usd, 6) if resolved else None
    settlement["netPnlUsd"] = (
        round(total_payout_usd - total_spent_usd, 6) if resolved else None
    )
    if resolved and not settlement.get("resolvedAt"):
        settlement["resolvedAt"] = datetime.now(UTC).isoformat()
    state["settlement"] = settlement

    after = json.dumps(state, sort_keys=True, ensure_ascii=False)
    newly_resolved = previous_status != "resolved" and settlement.get("status") == "resolved"
    return before != after, newly_resolved


def build_hour_report_row(state):
    if not isinstance(state, dict) or not has_placed_orders(state):
        return None
    settlement = state.get("settlement") or {}
    claim = ensure_claim_record(state)
    orders = state.get("orders") or {}
    execution_health = state.get("executionHealth")
    if not isinstance(execution_health, dict):
        execution_health = build_execution_health(state)
    placed_sides = [
        side
        for side in ("up", "down")
        if isinstance(orders.get(side), dict) and orders[side].get("placed")
    ]
    return {
        "hourKey": state.get("hourKey"),
        "slug": state.get("slug"),
        "variant": state.get("variant"),
        "windowMinutes": state.get("windowMinutes"),
        "mode": state.get("mode"),
        "eventStart": state.get("eventStart"),
        "eventEnd": state.get("eventEnd"),
        "orderUsd": state.get("orderUsd"),
        "carryPlan": state.get("carryPlan"),
        "firstEntrySide": state.get("firstEntrySide"),
        "paired": bool(
            isinstance(orders.get("up"), dict)
            and orders["up"].get("placed")
            and isinstance(orders.get("down"), dict)
            and orders["down"].get("placed")
        ),
        "placedSides": placed_sides,
        "orderCount": len(placed_sides),
        "triggerSummary": {
            "firstEntryTriggerCents": state.get("firstEntryTriggerCents"),
            "firstEntryBlockedLate": state.get("firstEntryBlockedLate"),
            "firstEntryBlockedRemainingMinutes": state.get("firstEntryBlockedRemainingMinutes"),
        },
        "settlementStatus": settlement.get("status"),
        "winnerSide": settlement.get("winnerSide"),
        "winnerOutcome": settlement.get("winnerOutcome"),
        "outcomePricesCents": settlement.get("outcomePricesCents"),
        "totalSpentUsd": settlement.get("totalSpentUsd"),
        "totalPayoutUsd": settlement.get("totalPayoutUsd"),
        "netPnlUsd": settlement.get("netPnlUsd"),
        "durationMinutes": state.get("durationMinutes"),
        "endReason": state.get("endReason"),
        "bothSidesLe40": state.get("bothSidesLe40"),
        "executionExpectedPair": execution_health.get("expectedPair"),
        "executionMissedPair": execution_health.get("missedPair"),
        "executionFailureCount": execution_health.get("failureCount"),
        "executionFailureRows": execution_health.get("failureRows"),
        "carrySignalQualified": state.get("carrySignalQualified"),
        "resolvedAt": settlement.get("resolvedAt"),
        "checkedAt": settlement.get("checkedAt"),
        "claimStatus": claim.get("status"),
        "claimReadyAt": claim.get("readyAt"),
        "claimAttemptCount": claim.get("attemptCount"),
        "claimLastAttemptAt": claim.get("lastAttemptAt"),
        "claimLastCheckedAt": claim.get("lastCheckedAt"),
        "claimConditionId": claim.get("conditionId"),
        "claimTransactionId": claim.get("transactionId"),
        "claimTransactionHash": claim.get("transactionHash"),
        "claimLastError": claim.get("lastError"),
        "claimedAt": claim.get("claimedAt"),
    }


def build_order_report_rows(state):
    settlement = state.get("settlement") or {}
    claim = ensure_claim_record(state)
    rows = []
    for side in ("up", "down"):
        order_record = (state.get("orders") or {}).get(side)
        if not isinstance(order_record, dict) or not order_record.get("placed"):
            continue
        fill = order_record.get("fill") or build_order_fill_snapshot(order_record)
        rows.append(
            {
                "hourKey": state.get("hourKey"),
                "slug": state.get("slug"),
                "variant": state.get("variant"),
                "windowMinutes": state.get("windowMinutes"),
                "mode": state.get("mode"),
                "eventStart": state.get("eventStart"),
                "eventEnd": state.get("eventEnd"),
                "side": side,
                "requestedAt": order_record.get("requestedAt"),
                "triggerType": order_record.get("triggerType"),
                "thresholdCents": order_record.get("thresholdCents"),
                "observedCents": order_record.get("observedCents"),
                "amountUsd": order_record.get("amountUsd"),
                "orderId": order_record.get("orderId"),
                "status": order_record.get("status"),
                "costUsd": fill.get("costUsd"),
                "sharesBought": fill.get("sharesBought"),
                "avgPriceCents": fill.get("avgPriceCents"),
                "transactionHashes": fill.get("transactionHashes"),
                "settlementStatus": settlement.get("status"),
                "winnerSide": settlement.get("winnerSide"),
                "payoutUsd": fill.get("payoutUsd"),
                "netPnlUsd": fill.get("netPnlUsd"),
                "resolvedAt": settlement.get("resolvedAt"),
                "claimStatus": claim.get("status"),
                "claimedAt": claim.get("claimedAt"),
                "claimTransactionHash": claim.get("transactionHash"),
            }
        )
    return rows


def build_local_day_key(iso_value: Optional[str]) -> Optional[str]:
    parsed = parse_date(iso_value)
    if parsed is None:
        return None
    return parsed.astimezone(LOG_TZ).date().isoformat()


def build_empty_day_bucket(date_text: str):
    return {
        "date": date_text,
        "hours": 0,
        "spentUsd": 0.0,
        "payoutUsd": 0.0,
        "netPnlUsd": 0.0,
    }


def rebuild_order_reports():
    ensure_dir(REPORTS_DIR)
    tracked_hours = 0
    hour_rows = []
    order_rows = []

    for file_path in list_json_files(HOURS_DIR):
        state = read_json_file(file_path)
        if not isinstance(state, dict):
            continue
        tracked_hours += 1
        hour_row = build_hour_report_row(state)
        if hour_row is None:
            continue
        hour_rows.append(hour_row)
        order_rows.extend(build_order_report_rows(state))

    hour_rows.sort(
        key=lambda row: parse_date(row.get("eventStart")) or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )
    order_rows.sort(
        key=lambda row: parse_date(row.get("requestedAt") or row.get("eventStart"))
        or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )

    daily_map = {}
    for hour_row in hour_rows:
        if hour_row.get("settlementStatus") != "resolved":
            continue
        day_key = build_local_day_key(hour_row.get("eventEnd") or hour_row.get("eventStart"))
        if not day_key:
            continue
        bucket = daily_map.setdefault(day_key, build_empty_day_bucket(day_key))
        bucket["hours"] += 1
        bucket["spentUsd"] += hour_row.get("totalSpentUsd") or 0.0
        bucket["payoutUsd"] += hour_row.get("totalPayoutUsd") or 0.0
        bucket["netPnlUsd"] += hour_row.get("netPnlUsd") or 0.0

    daily_rows = []
    for bucket in daily_map.values():
        daily_rows.append(
            {
                "date": bucket["date"],
                "hours": bucket["hours"],
                "spentUsd": round(bucket["spentUsd"], 6),
                "payoutUsd": round(bucket["payoutUsd"], 6),
                "netPnlUsd": round(bucket["netPnlUsd"], 6),
            }
        )
    daily_rows.sort(key=lambda row: row["date"], reverse=True)

    resolved_hours = [row for row in hour_rows if row.get("settlementStatus") == "resolved"]
    today_key = datetime.now(LOG_TZ).date().isoformat()
    yesterday_key = (datetime.now(LOG_TZ).date() - timedelta(days=1)).isoformat()
    daily_lookup = {row["date"]: row for row in daily_rows}

    summary = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "logTimeZone": LOG_TIME_ZONE,
        "trackedHours": tracked_hours,
        "hoursWithOrders": len(hour_rows),
        "settledHours": len(resolved_hours),
        "unsettledHours": len([row for row in hour_rows if row.get("settlementStatus") != "resolved"]),
        "pairedHours": len([row for row in hour_rows if row.get("paired")]),
        "singleSideHours": len([row for row in hour_rows if row.get("orderCount") == 1]),
        "totalOrders": len(order_rows),
        "totalSpentUsd": round(sum((row.get("costUsd") or 0.0) for row in order_rows), 6),
        "totalPayoutUsd": round(
            sum((row.get("payoutUsd") or 0.0) for row in order_rows if row.get("settlementStatus") == "resolved"),
            6,
        ),
        "totalNetPnlUsd": round(
            sum((row.get("netPnlUsd") or 0.0) for row in order_rows if row.get("netPnlUsd") is not None),
            6,
        ),
        "winningHours": len([row for row in resolved_hours if (row.get("netPnlUsd") or 0.0) > 0]),
        "losingHours": len([row for row in resolved_hours if (row.get("netPnlUsd") or 0.0) < 0]),
        "flatHours": len([row for row in resolved_hours if (row.get("netPnlUsd") or 0.0) == 0]),
        "claimedHours": len([row for row in resolved_hours if row.get("claimStatus") == "claimed"]),
        "pendingClaimHours": len(
            [row for row in resolved_hours if row.get("claimStatus") not in {"claimed", "dry-run-claimed", "manual-cleared"}]
        ),
        "today": daily_lookup.get(today_key, build_empty_day_bucket(today_key)),
        "yesterday": daily_lookup.get(yesterday_key, build_empty_day_bucket(yesterday_key)),
        "daily": daily_rows,
    }

    write_json_file(HOUR_DETAILS_REPORT_PATH, hour_rows)
    write_json_file(ORDER_DETAILS_REPORT_PATH, order_rows)
    write_json_file(ORDER_SUMMARY_REPORT_PATH, summary)


def refresh_order_reports():
    updated_count = 0
    resolved_count = 0
    for file_path in list_json_files(HOURS_DIR):
        state = read_json_file(file_path)
        if not isinstance(state, dict):
            continue
        try:
            changed, newly_resolved = reconcile_hour_state(state)
        except Exception as exc:
            log(f"Settlement refresh error for {file_path.name}: {exc}")
            continue
        if changed:
            write_json_file(file_path, state)
            updated_count += 1
        if newly_resolved:
            resolved_count += 1
            settlement = state.get("settlement") or {}
            write_hour_log(
                state,
                "settlement-resolved",
                {
                    "winnerSide": settlement.get("winnerSide"),
                    "totalSpentUsd": settlement.get("totalSpentUsd"),
                    "totalPayoutUsd": settlement.get("totalPayoutUsd"),
                    "netPnlUsd": settlement.get("netPnlUsd"),
                },
            )
            log(
                f"Settled {state['slug']} | winner={settlement.get('winnerSide')} "
                f"spent=${settlement.get('totalSpentUsd')} payout=${settlement.get('totalPayoutUsd')} "
                f"net=${settlement.get('netPnlUsd')}"
            )

    rebuild_order_reports()
    return {"updated": updated_count, "resolved": resolved_count}


def refresh_auto_redeem(resolved_funder: Optional[str] = None):
    if not ORDER_AUTO_REDEEM_ENABLED:
        return {
            "enabled": False,
            "busy": False,
            "nextIntervalMs": ORDER_SETTLEMENT_IDLE_INTERVAL_MS,
            "autoSell": {"candidateCount": 0, "sold": []},
            "redeemableCount": 0,
            "claimed": False,
        }

    command = [sys.executable, str(ROOT_DIR / "scripts" / "auto_redeem.py"), "--once"]
    result = subprocess.run(
        command,
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )

    if result.returncode != 0:
        log(f"Settlement worker failed: {result.stderr.strip() or result.stdout.strip() or 'unknown error'}")
        return {
            "enabled": True,
            "busy": True,
            "nextIntervalMs": ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS,
            "error": result.stderr.strip() or result.stdout.strip() or "unknown error",
        }

    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    payload = {}
    for line in reversed(lines):
        if line.startswith("{") and line.endswith("}"):
            try:
                payload = json.loads(line)
                break
            except Exception:
                continue

    if not isinstance(payload, dict) or not payload:
        log("Settlement worker returned no JSON payload.")
        return {
            "enabled": True,
            "busy": True,
            "nextIntervalMs": ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS,
            "error": "no-json-payload",
        }

    sold_rows = payload.get("autoSell", {}).get("sold") or []
    if sold_rows:
        first_sell = sold_rows[0]
        log(
            f"Auto sold {first_sell.get('slug') or first_sell.get('title')} "
            f"{first_sell.get('outcome')} size={first_sell.get('shares')} "
            f"price={first_sell.get('sellPrice')} balance=${first_sell.get('balanceAfterUsd')}"
        )
    elif payload.get("claimed"):
        log(
            f"Auto claimed {payload.get('entries', [{}])[0].get('slug') or 'position'} "
            f"balance=${payload.get('afterBalanceUsd')}"
        )

    payload["enabled"] = True
    payload["nextIntervalMs"] = (
        ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS
        if payload.get("busy")
        else ORDER_SETTLEMENT_IDLE_INTERVAL_MS
    )
    return payload


def finalize_state(state, reason: str) -> None:
    first_sample_at = parse_date(state.get("firstSampleAt"))
    last_sample_at = parse_date(state.get("lastSampleAt"))
    duration_minutes = 0.0
    if first_sample_at and last_sample_at:
        duration_minutes = round((last_sample_at - first_sample_at).total_seconds() / 60, 2)
    state["durationMinutes"] = duration_minutes
    state["finalizedAt"] = datetime.now(UTC).isoformat()
    state["endReason"] = reason
    state["bothSidesLe40"] = bool(
        state["opportunity"]["upLe40"] and state["opportunity"]["downLe40"]
    )
    state["carrySignalQualified"] = bool(state.get("pairedAt")) or (
        duration_minutes >= ORDER_SIGNAL_MIN_DURATION_MINUTES
    )
    if state.get("variant") == "5m":
        state["nextOrderUsd"] = ORDER_BASE_USD
    else:
        state["nextOrderUsd"] = (
            ORDER_ESCALATED_USD
            if state["carrySignalQualified"] and not state["bothSidesLe40"]
            else ORDER_BASE_USD
        )
    state["executionHealth"] = build_execution_health(state)
    write_json_file(build_hour_summary_path(state), state)


def summarize_state(state) -> str:
    if state["orders"]["up"]["placed"] and state["orders"]["down"]["placed"]:
        status = "paired"
    elif state["orders"]["up"].get("submissionPending"):
        status = "submitting:up"
    elif state["orders"]["down"].get("submissionPending"):
        status = "submitting:down"
    elif state["orders"]["up"].get("confirmationPending"):
        status = "confirming:up"
    elif state["orders"]["down"].get("confirmationPending"):
        status = "confirming:down"
    elif state.get("executionGuardActive"):
        status = "guard-pause"
    elif state["firstEntrySide"]:
        status = f"first:{state['firstEntrySide']}"
    elif state["firstEntryBlockedLate"]:
        status = "late-skip"
    else:
        status = "waiting"
    return (
        f"Sample {state['sampleCount']} | "
        f"Up {float(state.get('lastSample', {}).get('upCents', 0)):.3f}c "
        f"Down {float(state.get('lastSample', {}).get('downCents', 0)):.3f}c | "
        f"${state['orderUsd']} | {status}"
    )


def fetch_live_prices(state):
    up_payload = request_json(
        f"{CLOB_BASE}/price",
        params={"token_id": state["tokens"]["up"], "side": ORDER_PRICE_SIDE},
    )
    down_payload = request_json(
        f"{CLOB_BASE}/price",
        params={"token_id": state["tokens"]["down"], "side": ORDER_PRICE_SIDE},
    )
    up_price = float(up_payload["price"])
    down_price = float(down_payload["price"])
    return {
        "upPrice": up_price,
        "downPrice": down_price,
        "upCents": to_cents(up_price),
        "downCents": to_cents(down_price),
    }


def resolve_funder_address(signer_address: str) -> str:
    if POLY_FUNDER:
        return POLY_FUNDER
    profile = fetch_public_profile(signer_address)
    if profile and profile.get("proxyWallet"):
        return profile["proxyWallet"]
    return signer_address


def create_level1_client(signature_type: int, funder: str):
    return ClobClient(
        CLOB_BASE,
        chain_id=POLY_CHAIN_ID,
        key=POLY_PRIVATE_KEY,
        signature_type=signature_type,
        funder=funder,
    )


def probe_client(signature_type: int, funder: str):
    client = create_level1_client(signature_type, funder)
    client.set_api_creds(client.create_or_derive_api_creds())
    snapshot = client.get_balance_allowance(
        BalanceAllowanceParams(asset_type="COLLATERAL", signature_type=signature_type)
    )
    return client, snapshot


def snapshot_balance_usd(snapshot) -> float:
    try:
        raw_value = snapshot.get("balance")
        if raw_value in (None, "", "null"):
            return 0.0
        return int(raw_value) / 10**6
    except Exception:
        return 0.0


def create_trader():
    if ORDER_DRY_RUN:
        log("Order engine is running in dry-run mode")

        class DryRunTrader:
            mode = "dry-run"
            signature_type = None
            funder = None

            def initialize(self):
                return None

            def ensure_funds(self, required_usd: float):
                return {"requiredUsd": required_usd, "mode": "dry-run"}

            def place_buy(self, token_id: str, amount_usd: float, price_cap: float, tick_size, neg_risk):
                return {
                    "success": True,
                    "dryRun": True,
                    "status": "simulated",
                    "orderID": f"dry-{int(time.time() * 1000)}",
                    "amountUsd": amount_usd,
                    "priceCap": price_cap,
                    "tokenId": token_id,
                }

            def place_sell(self, token_id: str, shares: float, price_floor: float, tick_size, neg_risk):
                return {
                    "success": True,
                    "dryRun": True,
                    "status": "simulated",
                    "orderID": f"dry-{int(time.time() * 1000)}",
                    "shares": shares,
                    "priceFloor": price_floor,
                    "tokenId": token_id,
                }

            def get_position_size(self, token_id: str) -> float:
                return 0.0

        return DryRunTrader()

    if not POLY_PRIVATE_KEY:
        raise RuntimeError("missing private key for live trading")

    temp_client = create_level1_client(0, POLY_FUNDER or "")
    signer_address = temp_client.signer.address()
    resolved_funder = resolve_funder_address(signer_address)
    signature_candidates = [POLY_SIGNATURE_TYPE] if POLY_SIGNATURE_TYPE is not None else [1, 2, 0]

    selected_client = None
    selected_snapshot = None
    selected_signature_type = None
    selected_funder = None
    selected_balance = -1.0

    for signature_type in signature_candidates:
        funder = signer_address if signature_type == 0 else resolved_funder
        try:
            candidate_client, snapshot = probe_client(signature_type, funder)
            balance_usd = snapshot_balance_usd(snapshot)
            log(
                f"Signature type {signature_type} probe ok: balance=${balance_usd:.6f} funder={funder}"
            )
            if balance_usd > selected_balance:
                selected_client = candidate_client
                selected_snapshot = snapshot
                selected_signature_type = signature_type
                selected_funder = funder
                selected_balance = balance_usd
        except Exception as exc:
            log(f"Signature type {signature_type} probe failed: {exc}")

    if selected_client is None:
        raise RuntimeError("unable to authenticate with Polymarket Python client")

    class LiveTrader:
        mode = "live"
        signature_type = selected_signature_type
        funder = selected_funder

        def __init__(self, client, first_snapshot):
            self.client = client
            self._first_snapshot = first_snapshot

        def initialize(self):
            log(
                f"Live trading client ready for {signer_address} "
                f"(signatureType={self.signature_type}, funder={self.funder})"
            )

        def _get_balance_snapshot(self):
            if self._first_snapshot is not None:
                snapshot = self._first_snapshot
                self._first_snapshot = None
                return snapshot
            return self.client.get_balance_allowance(
                BalanceAllowanceParams(
                    asset_type="COLLATERAL", signature_type=self.signature_type
                )
            )

        def ensure_funds(self, required_usd: float):
            snapshot = self._get_balance_snapshot()
            balance = int(snapshot.get("balance") or 0) / 10**6
            allowance_raw = snapshot.get("allowance")
            allowance = (
                int(allowance_raw) / 10**6
                if allowance_raw not in (None, "", "null")
                else None
            )
            if balance < ORDER_MIN_BALANCE_USD:
                raise RuntimeError(
                    f"Collateral balance {balance:.6f} is below minimum ${ORDER_MIN_BALANCE_USD}. Order skipped."
                )
            if balance < required_usd:
                raise RuntimeError(
                    f"Insufficient collateral balance for ${required_usd}. Current balance: {balance:.6f}"
                )
            if allowance is None:
                return {"balance": balance, "allowance": allowance, "autoApproved": False}
            if allowance >= required_usd:
                return {"balance": balance, "allowance": allowance, "autoApproved": False}
            if not ORDER_AUTO_APPROVE:
                log(
                    f"Allowance {allowance:.6f} is below required ${required_usd}, "
                    f"but continuing to match engine.py behavior."
                )
                return {"balance": balance, "allowance": allowance, "autoApproved": False}
            raise RuntimeError("ORDER_AUTO_APPROVE is not implemented for the Python path yet.")

        def place_buy(self, token_id: str, amount_usd: float, price_cap: float, tick_size, neg_risk):
            order_type = OrderType.FAK if ORDER_EXECUTION_TYPE == "FAK" else OrderType.FOK
            order = self.client.create_market_order(
                MarketOrderArgs(
                    token_id=token_id,
                    amount=amount_usd,
                    side=BUY,
                    price=price_cap,
                    order_type=order_type,
                ),
                PartialCreateOrderOptions(tick_size=tick_size, neg_risk=neg_risk),
            )
            return self.client.post_order(order, order_type)

        def place_sell(self, token_id: str, shares: float, price_floor: float, tick_size, neg_risk):
            order_type = OrderType.FAK if ORDER_EXECUTION_TYPE == "FAK" else OrderType.FOK
            order = self.client.create_market_order(
                MarketOrderArgs(
                    token_id=token_id,
                    amount=shares,
                    side=SELL,
                    price=price_floor,
                    order_type=order_type,
                ),
                PartialCreateOrderOptions(tick_size=tick_size, neg_risk=neg_risk),
            )
            return self.client.post_order(order, order_type)

        def get_position_size(self, token_id: str) -> float:
            return fetch_position_size(self.funder, token_id)

    return LiveTrader(selected_client, selected_snapshot)


def start_event_with_risk_gate(target: datetime):
    if ORDER_VARIANT == "5m" and ORDER_RISK_PAUSE_ENABLED:
        wait_for_risk_gate_clear()
        target = datetime.now(UTC)
    return start_event(target)


def start_event(target: datetime):
    while True:
        try:
            meta = resolve_event_for_date(target)
            if not meta or not meta.get("eventEnd"):
                log(
                    f"No event found. Retrying in {int(ORDER_EVENT_MISSING_RETRY_MS / 1000)}s."
                )
                time.sleep(ORDER_EVENT_MISSING_RETRY_MS / 1000)
                target = datetime.now(UTC)
                continue

            runtime_state = get_runtime_state()
            hour_key = build_hour_key(meta)
            if (
                isinstance(runtime_state, dict)
                and runtime_state.get("hourKey") == hour_key
                and parse_date(runtime_state.get("eventEnd")) is not None
                and parse_date(runtime_state.get("eventEnd")) > datetime.now(UTC)
            ):
                if (
                    ORDER_MIN_STARTUP_MINUTES_REMAINING > 0
                    and not has_placed_orders(runtime_state)
                    and parse_date(runtime_state.get("eventEnd")) is not None
                ):
                    remaining_minutes = (
                        parse_date(runtime_state.get("eventEnd")) - datetime.now(UTC)
                    ).total_seconds() / 60
                    if remaining_minutes < ORDER_MIN_STARTUP_MINUTES_REMAINING:
                        clear_runtime_state()
                        log(
                            f"Skipped resumed {ORDER_VARIANT.upper()} event {runtime_state['slug']} because only "
                            f"{remaining_minutes:.2f} minutes remained and no order had been placed"
                        )
                        target = parse_date(runtime_state.get("eventEnd")) + timedelta(seconds=1)
                        continue
                if runtime_state.get("finalizedAt"):
                    log(f"Resumed idle hour {runtime_state['slug']} from runtime state")
                else:
                    log(f"Resumed {runtime_state['slug']} from runtime state")
                return runtime_state

            if ORDER_MIN_STARTUP_MINUTES_REMAINING > 0 and meta.get("eventEnd"):
                remaining_minutes = (meta["eventEnd"] - datetime.now(UTC)).total_seconds() / 60
                if remaining_minutes < ORDER_MIN_STARTUP_MINUTES_REMAINING:
                    log(
                        f"Skipped fresh {ORDER_VARIANT.upper()} event {meta['slug']} because only "
                        f"{remaining_minutes:.2f} minutes remained at startup"
                    )
                    target = meta["eventEnd"] + timedelta(seconds=1)
                    continue

            carry_plan = determine_carry_plan(
                meta["eventStart"].isoformat() if meta.get("eventStart") else None
            )
            state = create_hour_state(meta, carry_plan)
            save_runtime_state(state)
            write_hour_log(state, "hour-start", {"orderUsd": state["orderUsd"], "carryPlan": carry_plan})
            log(
                f"Started {state.get('variant', '1h').upper()} order {state['slug']} "
                f"(${state['orderUsd']}, {state['mode']}, {state['priceSource']}) "
                f"until {state['eventEnd']}"
            )
            return state
        except Exception as exc:
            log(f"Order start error: {exc}. Retrying in {int(ORDER_START_RETRY_MS / 1000)}s.")
            time.sleep(ORDER_START_RETRY_MS / 1000)
            target = datetime.now(UTC)


def maybe_finalize_stale_runtime_state():
    runtime_state = get_runtime_state()
    if not isinstance(runtime_state, dict):
        return
    event_end = parse_date(runtime_state.get("eventEnd"))
    if runtime_state.get("finalizedAt"):
        if event_end and event_end <= datetime.now(UTC):
            clear_runtime_state()
            log(f"Cleared stale finalized runtime state for {runtime_state['slug']}")
        return
    if event_end and event_end <= datetime.now(UTC):
        finalize_state(runtime_state, "resume-after-end")
        clear_runtime_state()
        log(f"Recovered and finalized stale runtime state for {runtime_state['slug']}")


def submit_buy_order_task(trader, token_id: str, amount_usd: float, price_cap: float, tick_size, neg_risk):
    trader.ensure_funds(amount_usd)
    return trader.place_buy(token_id, amount_usd, price_cap, tick_size, neg_risk)


def detect_position_fill_after_attempt(
    state,
    trader,
    side: str,
    pre_attempt_size: Optional[float],
    error_message: str,
    sleep_before_check_seconds: float = 0.6,
):
    if ORDER_DRY_RUN or pre_attempt_size is None:
        return None
    if sleep_before_check_seconds > 0:
        time.sleep(sleep_before_check_seconds)
    try:
        post_attempt_size = trader.get_position_size(state["tokens"][side])
    except Exception as exc:
        log(
            f"Post-attempt position check failed for {state['slug']}:{side}: {exc}"
        )
        return None
    if post_attempt_size <= pre_attempt_size + 1e-6:
        return None
    order_record = ((state.get("orders") or {}).get(side) or {})
    delta_shares = float(post_attempt_size) - float(pre_attempt_size)
    amount_usd = float(order_record.get("amountUsd") or state.get("orderUsd") or 0.0)
    price_cap = float(order_record.get("priceCap") or 0.0)
    min_expected_shares = None
    implied_avg_price_cents = None
    if delta_shares > 1e-6 and amount_usd > 0:
        implied_avg_price_cents = round((amount_usd / delta_shares) * 100, 4)
    if price_cap > 0 and amount_usd > 0:
        min_expected_shares = (amount_usd / price_cap) * ORDER_DETECTED_FILL_MIN_SHARE_RATIO
        if delta_shares + 1e-6 < min_expected_shares:
            log(
                f"Ignoring {side.upper()} position increase after request issue for {state['slug']}: "
                f"delta shares {round(delta_shares, 6)} is too small for ${round(amount_usd, 6)} "
                f"at <= {order_record.get('thresholdCents')}c (implied avg {implied_avg_price_cents}c). "
                "This looks like an external/manual fill, not the bot order."
            )
            return None
    return {
        "detectedAfterException": True,
        "preAttemptSize": round(pre_attempt_size, 6),
        "postAttemptSize": round(post_attempt_size, 6),
        "deltaShares": round(delta_shares, 6),
        "impliedAvgPriceCents": implied_avg_price_cents,
        "minExpectedShares": round(min_expected_shares, 6) if min_expected_shares is not None else None,
        "error": error_message,
    }


def resolve_fill_during_submission(state, trader, side: str, now: datetime) -> bool:
    order_record = (state.get("orders") or {}).get(side)
    if not isinstance(order_record, dict) or not order_record.get("submissionPending"):
        return False
    baseline_size = order_record.get("submissionBaselineSize")
    if ORDER_DRY_RUN:
        return False
    try:
        current_size = trader.get_position_size(state["tokens"][side])
    except Exception as exc:
        log(f"Pending submit check failed for {state['slug']}:{side}: {exc}")
        return False
    order_record["submissionLastCheckedAt"] = now.isoformat()
    if baseline_size is None:
        detected_fill = current_size > 1e-6
    else:
        detected_fill = current_size > float(baseline_size) + 1e-6
    if not detected_fill:
        return False
    delta_shares = float(current_size) - float(baseline_size or 0.0)
    amount_usd = float(order_record.get("amountUsd") or state.get("orderUsd") or 0.0)
    price_cap = float(order_record.get("priceCap") or 0.0)
    if price_cap > 0 and amount_usd > 0:
        min_expected_shares = (amount_usd / price_cap) * ORDER_DETECTED_FILL_MIN_SHARE_RATIO
        if delta_shares + 1e-6 < min_expected_shares:
            implied_avg_price_cents = round((amount_usd / delta_shares) * 100, 4) if delta_shares > 1e-6 else None
            log(
                f"Ignoring {side.upper()} position increase during pending submit for {state['slug']}: "
                f"delta shares {round(delta_shares, 6)} is too small for ${round(amount_usd, 6)} "
                f"at <= {order_record.get('thresholdCents')}c (implied avg {implied_avg_price_cents}c). "
                "This looks like an external/manual fill, not the bot order."
            )
            return False
    order_record["placed"] = True
    order_record["attemptBlocked"] = True
    clear_order_submission(order_record)
    clear_order_confirmation(order_record)
    order_record["requestedAt"] = (
        order_record.get("requestedAt")
        or order_record.get("submissionStartedAt")
        or order_record.get("lastAttemptAt")
        or now.isoformat()
    )
    order_record["status"] = "detected-during-submission"
    order_record["response"] = {
        "detectedDuringSubmission": True,
        "baselineSize": round(float(baseline_size), 6) if baseline_size is not None else None,
        "postAttemptSize": round(float(current_size), 6),
        "deltaShares": round(delta_shares, 6),
    }
    order_record["error"] = None
    order_record["lastFailureKind"] = None
    order_record["lastFailureAt"] = None
    if order_record.get("triggerType") == "first-entry":
        mark_first_entry_side(state, order_record, now)
    paired_now = mark_pair_complete_if_ready(state, now)
    write_hour_log(
        state,
        "order-detected-during-submission",
        {
            "side": side,
            "triggerType": order_record.get("triggerType"),
            "thresholdCents": order_record.get("thresholdCents"),
            "observedCents": order_record.get("observedCents"),
            "amountUsd": order_record.get("amountUsd"),
            "response": order_record["response"],
        },
    )
    save_runtime_state(state)
    log(
        f"Detected filled {side.upper()} while the 5M submit was still pending for {state['slug']} "
        f"(size -> {round(float(current_size), 6)})"
    )
    ACTIVE_ORDER_SUBMISSIONS.pop(build_order_submission_key(state, side), None)
    return paired_now


def recover_missing_submission(state, side: str, now: datetime) -> None:
    order_record = (state.get("orders") or {}).get(side)
    if not isinstance(order_record, dict) or not order_record.get("submissionPending"):
        return
    baseline_size = order_record.get("submissionBaselineSize")
    clear_order_submission(order_record)
    order_record["confirmationPending"] = True
    order_record["confirmationStartedAt"] = order_record.get("lastAttemptAt") or now.isoformat()
    order_record["confirmationBaselineSize"] = baseline_size
    order_record["confirmationLastCheckedAt"] = now.isoformat()
    order_record["status"] = "pending-confirmation"
    write_hour_log(
        state,
        "order-submit-recovered",
        {
            "side": side,
            "triggerType": order_record.get("triggerType"),
            "thresholdCents": order_record.get("thresholdCents"),
            "observedCents": order_record.get("observedCents"),
            "amountUsd": order_record.get("amountUsd"),
        },
    )
    save_runtime_state(state)
    log(
        f"Recovered pending 5M submit for {state['slug']}:{side}; "
        "switching to delayed confirmation mode."
    )


def process_completed_submission_result(state, trader, side: str, now: datetime) -> bool:
    order_record = (state.get("orders") or {}).get(side)
    if not isinstance(order_record, dict) or not order_record.get("submissionPending"):
        ACTIVE_ORDER_SUBMISSIONS.pop(build_order_submission_key(state, side), None)
        return False
    key = build_order_submission_key(state, side)
    future = ACTIVE_ORDER_SUBMISSIONS.get(key)
    if future is None:
        recover_missing_submission(state, side, now)
        return False
    if resolve_fill_during_submission(state, trader, side, now):
        return True
    if not future.done():
        return False

    ACTIVE_ORDER_SUBMISSIONS.pop(key, None)
    baseline_size = order_record.get("submissionBaselineSize")
    clear_order_submission(order_record)

    try:
        response = future.result()
    except Exception as exc:
        classification = classify_order_exception(exc)
        error_message = classification["message"]
        detected_fill = detect_position_fill_after_attempt(
            state,
            trader,
            side,
            baseline_size,
            error_message,
            sleep_before_check_seconds=0.0,
        )
        if detected_fill is not None:
            order_record["placed"] = True
            order_record["attemptBlocked"] = True
            clear_order_confirmation(order_record)
            order_record["requestedAt"] = now.isoformat()
            order_record["status"] = "detected-after-exception"
            order_record["response"] = detected_fill
            order_record["error"] = None
            order_record["lastFailureKind"] = None
            order_record["lastFailureAt"] = None
            if order_record.get("triggerType") == "first-entry":
                mark_first_entry_side(state, order_record, now)
            paired_now = mark_pair_complete_if_ready(state, now)
            write_hour_log(
                state,
                "order-detected-after-exception",
                {
                    "side": side,
                    "triggerType": order_record.get("triggerType"),
                    "thresholdCents": order_record.get("thresholdCents"),
                    "observedCents": order_record.get("observedCents"),
                    "amountUsd": state["orderUsd"],
                    "response": detected_fill,
                },
            )
            save_runtime_state(state)
            log(
                f"Detected filled {side.upper()} after request issue for {state['slug']} "
                f"(shares {detected_fill['preAttemptSize']} -> {detected_fill['postAttemptSize']})"
            )
            return paired_now

        order_record["error"] = error_message
        order_record["response"] = None
        order_record["lastFailureKind"] = classification.get("kind")
        order_record["lastFailureAt"] = now.isoformat()
        transient_confirmation_pending = (
            ORDER_VARIANT == "5m" and classification.get("kind") == "transient"
        )
        allow_5m_retry = (
            ORDER_VARIANT == "5m"
            and classification.get("kind") in {"transient", "unfilled"}
            and int(order_record.get("attemptCount") or 0) < 2
        )
        if ORDER_VARIANT == "5m":
            order_record["attemptBlocked"] = transient_confirmation_pending or not allow_5m_retry
        if transient_confirmation_pending:
            order_record["confirmationPending"] = True
            order_record["confirmationStartedAt"] = order_record.get("lastAttemptAt") or now.isoformat()
            order_record["confirmationBaselineSize"] = baseline_size
            order_record["confirmationLastCheckedAt"] = now.isoformat()
            order_record["status"] = "pending-confirmation"
        else:
            clear_order_confirmation(order_record)
        log_type = {
            "unfilled": "order-unfilled",
            "transient": "order-transient-error",
        }.get(classification.get("kind"), "order-error")
        write_hour_log(
            state,
            log_type,
            {
                "side": side,
                "triggerType": order_record.get("triggerType"),
                "thresholdCents": order_record.get("thresholdCents"),
                "observedCents": order_record.get("observedCents"),
                "amountUsd": state["orderUsd"],
                "error": error_message,
                "confirmationPending": transient_confirmation_pending,
            },
        )
        save_runtime_state(state)

        if classification["kind"] == "unfilled":
            log(
                f"No fill for {state['slug']}:{side} at <= {order_record.get('thresholdCents')}c "
                f"(observed {order_record.get('observedCents')}c, FOK not filled)"
            )
        elif classification["kind"] == "transient":
            log(f"Transient order issue for {state['slug']}:{side}: {error_message}")
        else:
            log(f"Order error for {state['slug']}:{side}: {error_message}")
        if ORDER_VARIANT == "5m":
            if transient_confirmation_pending:
                log(
                    f"5M is holding {state['slug']}:{side} in delayed confirmation mode for "
                    f"{round(ORDER_CONFIRMATION_PENDING_MS / 1000, 1)}s before any same-side retry."
                )
            elif allow_5m_retry:
                retry_after_ms = max(ORDER_ATTEMPT_COOLDOWN_MS, ORDER_MIN_ORDER_INTERVAL_MS)
                log(
                    f"5M will allow one more retry for {state['slug']}:{side} "
                    f"after {round(retry_after_ms / 1000, 1)}s if the threshold still holds."
                )
            else:
                log(
                    f"5M will not retry {state['slug']}:{side} in the current event; "
                    f"next chance is the next 5M window."
                )
        return False

    order_record["placed"] = True
    order_record["attemptBlocked"] = True
    clear_order_confirmation(order_record)
    order_record["requestedAt"] = order_record.get("lastAttemptAt") or now.isoformat()
    order_record["response"] = response
    order_record["orderId"] = response.get("orderID") or response.get("orderId")
    order_record["status"] = response.get("status", "submitted")
    order_record["error"] = None
    order_record["lastFailureKind"] = None
    order_record["lastFailureAt"] = None
    write_hour_log(
        state,
        "order-placed",
        {
            "side": side,
            "triggerType": order_record.get("triggerType"),
            "thresholdCents": order_record.get("thresholdCents"),
            "observedCents": order_record.get("observedCents"),
            "amountUsd": state["orderUsd"],
            "response": response,
        },
    )
    save_runtime_state(state)
    log(
        f"{'[DRY-RUN] ' if ORDER_DRY_RUN else ''}Bought {side.upper()} ${state['orderUsd']} "
        f"at <= {order_record.get('thresholdCents')}c for {state['slug']}"
    )
    if order_record.get("triggerType") == "first-entry":
        mark_first_entry_side(state, order_record, now)
    paired_now = mark_pair_complete_if_ready(state, now)
    save_runtime_state(state)
    return paired_now


def refresh_pending_order_submissions(state, trader, now: datetime) -> bool:
    paired_now = False
    for side in ("up", "down"):
        if process_completed_submission_result(state, trader, side, now):
            paired_now = True
    return paired_now


def is_confirmation_retry_ready(order_record: Dict[str, Any], now: datetime) -> bool:
    confirmation_started_at = parse_date(
        order_record.get("confirmationStartedAt") or order_record.get("lastAttemptAt")
    )
    if confirmation_started_at is None:
        return True
    return (now - confirmation_started_at).total_seconds() * 1000 >= ORDER_CONFIRMATION_PENDING_MS


def resolve_pending_order_confirmation(state, trader, side: str, now: datetime) -> bool:
    order_record = (state.get("orders") or {}).get(side)
    if not isinstance(order_record, dict) or not order_record.get("confirmationPending"):
        return False

    try:
        current_size = trader.get_position_size(state["tokens"][side])
    except Exception as exc:
        log(f"Pending confirmation check failed for {state['slug']}:{side}: {exc}")
        return False

    baseline_size = order_record.get("confirmationBaselineSize")
    order_record["confirmationLastCheckedAt"] = now.isoformat()
    if baseline_size is None:
        detected_fill = current_size > 1e-6
    else:
        detected_fill = current_size > float(baseline_size) + 1e-6

    if detected_fill:
        order_record["placed"] = True
        order_record["attemptBlocked"] = True
        order_record["requestedAt"] = (
            order_record.get("requestedAt")
            or order_record.get("confirmationStartedAt")
            or order_record.get("lastAttemptAt")
            or now.isoformat()
        )
        order_record["status"] = "detected-after-confirmation"
        order_record["response"] = {
            "detectedAfterPendingConfirmation": True,
            "baselineSize": round(float(baseline_size), 6)
            if baseline_size is not None
            else None,
            "postAttemptSize": round(float(current_size), 6),
        }
        order_record["error"] = None
        order_record["lastFailureKind"] = None
        order_record["lastFailureAt"] = None
        clear_order_confirmation(order_record)
        if order_record.get("triggerType") == "first-entry":
            mark_first_entry_side(state, order_record, now)
        paired_now = mark_pair_complete_if_ready(state, now)
        write_hour_log(
            state,
            "order-detected-after-confirmation",
            {
                "side": side,
                "triggerType": order_record.get("triggerType"),
                "thresholdCents": order_record.get("thresholdCents"),
                "observedCents": order_record.get("observedCents"),
                "amountUsd": order_record.get("amountUsd"),
                "response": order_record["response"],
            },
        )
        save_runtime_state(state)
        log(
            f"Detected filled {side.upper()} after delayed confirmation for {state['slug']} "
            f"(size -> {round(float(current_size), 6)})"
        )
        return paired_now

    if not is_confirmation_retry_ready(order_record, now):
        return False

    clear_order_confirmation(order_record)
    allow_retry = (
        ORDER_VARIANT == "5m"
        and order_record.get("lastFailureKind") == "transient"
        and int(order_record.get("attemptCount") or 0) < 2
    )
    order_record["attemptBlocked"] = not allow_retry
    if allow_retry:
        order_record["status"] = "retry-ready"
    else:
        order_record["status"] = "confirmation-cleared-no-retry"
    write_hour_log(
        state,
        "order-confirmation-cleared",
        {
            "side": side,
            "triggerType": order_record.get("triggerType"),
            "amountUsd": order_record.get("amountUsd"),
            "allowRetry": allow_retry,
            "baselineSize": round(float(baseline_size), 6)
            if baseline_size is not None
            else None,
            "currentSize": round(float(current_size), 6),
        },
    )
    save_runtime_state(state)
    if allow_retry:
        log(
            f"Confirmed no delayed fill for {state['slug']}:{side}; "
            "the same side can be retried once if the threshold still holds."
        )
    else:
        log(
            f"Confirmed no delayed fill for {state['slug']}:{side}; "
            "the current event will not retry this side."
        )
    return False


def refresh_pending_order_confirmations(state, trader, now: datetime) -> bool:
    paired_now = False
    for side in ("up", "down"):
        if resolve_pending_order_confirmation(state, trader, side, now):
            paired_now = True
    return paired_now


def is_order_submit_throttled(state, now: datetime) -> bool:
    if ORDER_MIN_ORDER_INTERVAL_MS <= 0:
        return False
    last_attempt_at = parse_date(state.get("lastOrderAttemptAt"))
    if last_attempt_at is None:
        return False
    return (now - last_attempt_at).total_seconds() * 1000 < ORDER_MIN_ORDER_INTERVAL_MS


def place_side_order(state, trader, side: str, threshold_cents: float, trigger_type: str, observed_cents: float, now: datetime):
    order_record = state["orders"][side]
    if not should_retry_order(order_record, now):
        return False
    if is_order_submit_throttled(state, now):
        return False

    pre_attempt_size = None
    if not ORDER_DRY_RUN:
        try:
            pre_attempt_size = trader.get_position_size(state["tokens"][side])
        except Exception as exc:
            log(f"Pre-attempt position check failed for {state['slug']}:{side}: {exc}")

    order_record["attemptCount"] += 1
    order_record["lastAttemptAt"] = now.isoformat()
    order_record["amountUsd"] = state["orderUsd"]
    order_record["triggerType"] = trigger_type
    order_record["thresholdCents"] = threshold_cents
    order_record["priceCap"] = round(threshold_cents / 100, 4)
    order_record["observedCents"] = observed_cents
    order_record["error"] = None
    order_record["lastFailureKind"] = None
    order_record["lastFailureAt"] = None
    state["lastOrderAttemptAt"] = now.isoformat()
    save_runtime_state(state)

    if ORDER_VARIANT == "5m" and not ORDER_DRY_RUN:
        order_record["submissionPending"] = True
        order_record["submissionStartedAt"] = now.isoformat()
        order_record["submissionBaselineSize"] = pre_attempt_size
        order_record["submissionLastCheckedAt"] = now.isoformat()
        order_record["status"] = "submitting"
        write_hour_log(
            state,
            "order-submit-start",
            {
                "side": side,
                "triggerType": trigger_type,
                "thresholdCents": threshold_cents,
                "observedCents": observed_cents,
                "amountUsd": state["orderUsd"],
            },
        )
        save_runtime_state(state)
        log(
            f"Triggering 5M {side.upper()} submit for {state['slug']} "
            f"at observed {observed_cents}c (cap {threshold_cents}c)"
        )
        try:
            ACTIVE_ORDER_SUBMISSIONS[build_order_submission_key(state, side)] = get_order_submit_executor().submit(
                submit_buy_order_task,
                trader,
                state["tokens"][side],
                state["orderUsd"],
                round(threshold_cents / 100, 4),
                state.get("tickSize"),
                state.get("negRisk"),
            )
            return False
        except Exception as exc:
            ACTIVE_ORDER_SUBMISSIONS.pop(build_order_submission_key(state, side), None)
            clear_order_submission(order_record)
            log(f"Failed to start 5M background submit for {state['slug']}:{side}: {exc}")

    classification = None
    response = None
    max_submit_attempts = 1 if ORDER_VARIANT == "5m" else 2
    for attempt_index in range(max_submit_attempts):
        try:
            trader.ensure_funds(state["orderUsd"])
            response = trader.place_buy(
                state["tokens"][side],
                state["orderUsd"],
                round(threshold_cents / 100, 4),
                state.get("tickSize"),
                state.get("negRisk"),
            )
            break
        except Exception as exc:
            classification = classify_order_exception(exc)
            if classification["kind"] == "transient" and ORDER_VARIANT != "5m" and attempt_index == 0:
                time.sleep(0.35)
                continue
            response = None
            break

    if response is not None:
        order_record["placed"] = True
        order_record["attemptBlocked"] = True
        clear_order_confirmation(order_record)
        order_record["requestedAt"] = now.isoformat()
        order_record["response"] = response
        order_record["orderId"] = response.get("orderID") or response.get("orderId")
        order_record["status"] = response.get("status", "submitted")
        write_hour_log(
            state,
            "order-placed",
            {
                "side": side,
                "triggerType": trigger_type,
                "thresholdCents": threshold_cents,
                "observedCents": observed_cents,
                "amountUsd": state["orderUsd"],
                "response": response,
            },
        )
        save_runtime_state(state)
        log(
            f"{'[DRY-RUN] ' if ORDER_DRY_RUN else ''}Bought {side.upper()} ${state['orderUsd']} "
            f"at <= {threshold_cents}c for {state['slug']}"
        )
        return True

    error_message = classification["message"] if classification else "unknown order exception"
    detected_fill = detect_position_fill_after_attempt(
        state,
        trader,
        side,
        pre_attempt_size,
        error_message,
    )
    if detected_fill is not None:
        order_record["placed"] = True
        order_record["attemptBlocked"] = True
        clear_order_confirmation(order_record)
        order_record["requestedAt"] = now.isoformat()
        order_record["status"] = "detected-after-exception"
        order_record["response"] = detected_fill
        order_record["error"] = None
        write_hour_log(
            state,
            "order-detected-after-exception",
            {
                "side": side,
                "triggerType": trigger_type,
                "thresholdCents": threshold_cents,
                "observedCents": observed_cents,
                "amountUsd": state["orderUsd"],
                "response": detected_fill,
            },
        )
        save_runtime_state(state)
        log(
            f"Detected filled {side.upper()} after request issue for {state['slug']} "
            f"(shares {detected_fill['preAttemptSize']} -> {detected_fill['postAttemptSize']})"
        )
        return True

    order_record["error"] = error_message
    order_record["response"] = None
    order_record["lastFailureKind"] = (classification or {}).get("kind")
    order_record["lastFailureAt"] = now.isoformat()
    transient_confirmation_pending = (
        ORDER_VARIANT == "5m" and (classification or {}).get("kind") == "transient"
    )
    allow_5m_retry = (
        ORDER_VARIANT == "5m"
        and (classification or {}).get("kind") in {"transient", "unfilled"}
        and int(order_record.get("attemptCount") or 0) < 2
    )
    if ORDER_VARIANT == "5m":
        order_record["attemptBlocked"] = transient_confirmation_pending or not allow_5m_retry
    if transient_confirmation_pending:
        order_record["confirmationPending"] = True
        order_record["confirmationStartedAt"] = now.isoformat()
        order_record["confirmationBaselineSize"] = pre_attempt_size
        order_record["confirmationLastCheckedAt"] = now.isoformat()
        order_record["status"] = "pending-confirmation"
    else:
        clear_order_confirmation(order_record)
    log_type = {
        "unfilled": "order-unfilled",
        "transient": "order-transient-error",
    }.get((classification or {}).get("kind"), "order-error")
    write_hour_log(
        state,
        log_type,
        {
            "side": side,
            "triggerType": trigger_type,
            "thresholdCents": threshold_cents,
            "observedCents": observed_cents,
            "amountUsd": state["orderUsd"],
            "error": error_message,
            "confirmationPending": transient_confirmation_pending,
        },
    )
    save_runtime_state(state)

    if classification and classification["kind"] == "unfilled":
        log(
            f"No fill for {state['slug']}:{side} at <= {threshold_cents}c "
            f"(observed {observed_cents}c, FOK not filled)"
        )
    elif classification and classification["kind"] == "transient":
        log(f"Transient order issue for {state['slug']}:{side}: {error_message}")
    else:
        log(f"Order error for {state['slug']}:{side}: {error_message}")
    if ORDER_VARIANT == "5m":
        if transient_confirmation_pending:
            log(
                f"5M is holding {state['slug']}:{side} in delayed confirmation mode for "
                f"{round(ORDER_CONFIRMATION_PENDING_MS / 1000, 1)}s before any same-side retry."
            )
        elif allow_5m_retry:
            retry_after_ms = max(ORDER_ATTEMPT_COOLDOWN_MS, ORDER_MIN_ORDER_INTERVAL_MS)
            log(
                f"5M will allow one more retry for {state['slug']}:{side} "
                f"after {round(retry_after_ms / 1000, 1)}s if the threshold still holds."
            )
        else:
            log(
                f"5M will not retry {state['slug']}:{side} in the current event; "
                f"next chance is the next 5M window."
            )
    return False


def maybe_place_hedge(state, trader, prices, now: datetime):
    if not state.get("firstEntrySide"):
        return False
    hedge_side = opposite_side(state["firstEntrySide"])
    if state["orders"][hedge_side]["placed"]:
        return False
    hedge_cents = prices["upCents"] if hedge_side == "up" else prices["downCents"]
    if hedge_cents > ORDER_HEDGE_ENTRY_CENTS:
        return False
    did_place = place_side_order(
        state, trader, hedge_side, ORDER_HEDGE_ENTRY_CENTS, "hedge", hedge_cents, now
    )
    if did_place and mark_pair_complete_if_ready(state, now):
        save_runtime_state(state)
        return True
    return False


def record_sample(state, trader):
    prices = fetch_live_prices(state)
    now = datetime.now(UTC)
    if not state.get("firstSampleAt"):
        state["firstSampleAt"] = now.isoformat()
    state["lastSampleAt"] = now.isoformat()
    state["sampleCount"] += 1
    state["minUpCents"] = update_min(state.get("minUpCents"), prices["upCents"])
    state["minDownCents"] = update_min(state.get("minDownCents"), prices["downCents"])
    state["lastSample"] = {
        "ts": now.isoformat(),
        "upCents": prices["upCents"],
        "downCents": prices["downCents"],
    }
    update_opportunity_flags(state, prices["upCents"], prices["downCents"])
    write_hour_log(
        state,
        "sample",
        {
            "sampleCount": state["sampleCount"],
            "upCents": prices["upCents"],
            "downCents": prices["downCents"],
        },
    )

    if refresh_pending_order_submissions(state, trader, now):
        save_runtime_state(state)
        log(summarize_state(state))
        return "paired-complete"

    if refresh_pending_order_confirmations(state, trader, now):
        save_runtime_state(state)
        log(summarize_state(state))
        return "paired-complete"

    execution_guard = evaluate_execution_guard(now)
    maybe_log_execution_guard(execution_guard)
    state["executionGuardActive"] = bool(
        execution_guard.get("active")
        and ORDER_VARIANT == "5m"
        and not state.get("firstEntrySide")
        and not has_placed_orders(state)
    )

    if not state.get("firstEntrySide") and not state.get("firstEntryBlockedLate"):
        if state.get("executionGuardActive"):
            save_runtime_state(state)
            log(summarize_state(state))
            if ORDER_MAX_SAMPLES > 0 and state["sampleCount"] >= ORDER_MAX_SAMPLES:
                return "max-samples"
            return None
        candidate = pick_first_entry_side(state, prices["upCents"], prices["downCents"])
        if candidate:
            remaining_minutes = get_remaining_minutes(state, now)
            if remaining_minutes <= ORDER_MIN_FIRST_ENTRY_MINUTES_REMAINING:
                state["firstEntryBlockedLate"] = True
                state["firstEntryBlockedAt"] = now.isoformat()
                state["firstEntryBlockedRemainingMinutes"] = round(remaining_minutes, 2)
                write_hour_log(
                    state,
                    "late-block",
                    {
                        "remainingMinutes": state["firstEntryBlockedRemainingMinutes"],
                        "candidateSide": candidate["side"],
                        "candidateCents": candidate["cents"],
                    },
                )
                log(
                    f"Skipped {state['slug']} first entry because only "
                    f"{state['firstEntryBlockedRemainingMinutes']} minutes remained"
                )
            else:
                did_place = place_side_order(
                    state,
                    trader,
                    candidate["side"],
                    ORDER_FIRST_ENTRY_CENTS,
                    "first-entry",
                    candidate["cents"],
                    now,
                )
                if did_place:
                    mark_first_entry_side(state, state["orders"][candidate["side"]], now)

    if state.get("firstEntrySide"):
        paired_now = maybe_place_hedge(state, trader, prices, now)
        if paired_now:
            save_runtime_state(state)
            log(summarize_state(state))
            return "paired-complete"

    save_runtime_state(state)
    log(summarize_state(state))

    if ORDER_MAX_SAMPLES > 0 and state["sampleCount"] >= ORDER_MAX_SAMPLES:
        return "max-samples"
    return None


def main():
    ensure_dir(DATA_DIR)
    ensure_dir(HOURS_DIR)
    ensure_dir(LOGS_DIR)
    ensure_dir(REPORTS_DIR)

    if ORDER_PRICE_SIDE != "BUY":
        log(f"Warning: ORDER_PRICE_SIDE={ORDER_PRICE_SIDE}. This strategy expects BUY prices.")

    maybe_finalize_stale_runtime_state()
    refresh_order_reports()
    last_reconcile_at_ms = int(time.time() * 1000)

    trader = create_trader()
    trader.initialize()
    log(
        "Order worker ready | "
        f"variant={ORDER_VARIANT} "
        f"first={ORDER_FIRST_ENTRY_CENTS}c "
        f"hedge={ORDER_HEDGE_ENTRY_CENTS}c "
        f"sample={int(ORDER_SAMPLE_INTERVAL_MS / 1000)}s "
        f"submitGap={int(ORDER_MIN_ORDER_INTERVAL_MS / 1000)}s "
        f"retryGap={int(ORDER_ATTEMPT_COOLDOWN_MS / 1000)}s"
    )
    state = start_event_with_risk_gate(datetime.now(UTC))

    try:
        while True:
            loop_started_at = time.monotonic()
            event_end = parse_date(state.get("eventEnd"))
            now = datetime.now(UTC)
            if state.get("finalizedAt"):
                if event_end and now >= event_end:
                    clear_runtime_state()
                    state = start_event_with_risk_gate(event_end + timedelta(seconds=1))
                    continue
            elif event_end and now >= event_end:
                finalize_state(state, "complete")
                refresh_order_reports()
                clear_runtime_state()
                log(
                    f"Finalized {state['slug']} | qualified={state['carrySignalQualified']} "
                    f"bothSidesLe40={state['bothSidesLe40']} next=${state['nextOrderUsd']}"
                )
                state = start_event_with_risk_gate(event_end + timedelta(seconds=1))
                continue

            if not state.get("finalizedAt"):
                try:
                    exit_reason = record_sample(state, trader)
                    if exit_reason == "paired-complete":
                        finalize_state(state, "paired-complete")
                        save_runtime_state(state)
                        refresh_order_reports()
                        log(
                            f"Closed trading for {state['slug']} after both sides filled. "
                            f"Waiting until {state['eventEnd']} to roll forward."
                        )
                        continue
                    if exit_reason:
                        log(f"Stopping because {exit_reason} was reached")
                        return
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    write_hour_log(state, "sample-error", {"error": str(exc)})
                    log(f"Sample error: {exc}")

            now_ms = int(time.time() * 1000)
            if now_ms - last_reconcile_at_ms >= ORDER_RECONCILE_INTERVAL_MS:
                refresh_order_reports()
                last_reconcile_at_ms = now_ms

            elapsed_seconds = time.monotonic() - loop_started_at
            sleep_seconds = max(0.0, (ORDER_SAMPLE_INTERVAL_MS / 1000) - elapsed_seconds)
            time.sleep(sleep_seconds)
    except KeyboardInterrupt:
        log("Received SIGINT, shutting down order engine.")
        save_runtime_state(state)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
