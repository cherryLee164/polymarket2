import time
import os
import sys
import requests
from datetime import datetime, timezone, timedelta
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import BalanceAllowanceParams
import config
from scanner import OpportunityScanner
from executor import TradeExecutor

# --- 强制设置输出编码为 UTF-8 ---
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
# ------------------------------

import py_clob_client.http_helpers.helpers as helpers

def patched_overloadHeaders(method: str, headers: dict) -> dict:
    if headers is None: 
        headers = dict()
    headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    headers["Accept"] = "*/*"
    headers["Connection"] = "keep-alive"
    headers["Content-Type"] = "application/json"
    if method == "GET": 
        headers["Accept-Encoding"] = "gzip"
    return headers

helpers.overloadHeaders = patched_overloadHeaders

ZERO_BYTES32 = "0x" + "0" * 64

def _parse_token_ids(raw_value):
    if not raw_value:
        return []
    normalized = raw_value.replace(",", " ").replace(";", " ")
    parts = [part.strip() for part in normalized.split() if part.strip()]
    return parts

def _load_claim_tokens_from_log(max_tokens=None, lookback_days=None):
    if not os.path.exists(config.TRADE_LOG_FILE):
        return []
    cutoff = None
    if lookback_days and lookback_days > 0:
        cutoff = datetime.now() - timedelta(days=lookback_days)

    token_ids = []
    seen = set()
    with open(config.TRADE_LOG_FILE, "r", encoding="utf-8") as f:
        lines = f.readlines()
    for line in reversed(lines):
        parts = line.strip().split(",")
        if len(parts) < 4:
            continue
        token_id = parts[0].strip()
        timestamp_str = parts[1].strip()
        status = parts[3].strip()

        if status == "PENDING" or status.startswith("FAILED") or status.startswith("ERROR"):
            continue

        if cutoff:
            try:
                ts = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S")
                if ts < cutoff:
                    continue
            except Exception:
                pass

        if token_id and token_id not in seen:
            seen.add(token_id)
            token_ids.append(token_id)
            if max_tokens and len(token_ids) >= max_tokens:
                break
    return token_ids

def _resolve_contract_addresses(client=None):
    collateral = getattr(config, "COLLATERAL_TOKEN_ADDRESS", "") or ""
    conditional = getattr(config, "CTF_ADDRESS", "") or ""

    if client is not None:
        try:
            collateral = collateral or client.get_collateral_address() or ""
            conditional = conditional or client.get_conditional_address() or ""
        except Exception:
            pass

    if not collateral or not conditional:
        try:
            from py_clob_client.config import get_contract_config
            contract_config = get_contract_config(config.CHAIN_ID)
            collateral = collateral or contract_config.collateral
            conditional = conditional or contract_config.conditional_tokens
        except Exception:
            pass

    return collateral, conditional

def _fetch_market_for_token(token_id, session):
    book_url = f"{config.HOST}/book?token_id={token_id}"
    try:
        book_resp = session.get(book_url, timeout=10)
    except Exception:
        return None
    if book_resp.status_code != 200:
        return None
    book_payload = book_resp.json()
    condition_id = book_payload.get("market")
    if not condition_id:
        return None

    market_url = f"{config.HOST}/markets/{condition_id}"
    try:
        market_resp = session.get(market_url, timeout=10)
    except Exception:
        return None
    if market_resp.status_code != 200:
        return None
    market_payload = market_resp.json()
    if "condition_id" not in market_payload:
        market_payload["condition_id"] = condition_id
    return market_payload

def _market_is_resolved(market_payload):
    tokens = market_payload.get("tokens") or []
    if any(token.get("winner") is True for token in tokens):
        return True
    return bool(market_payload.get("is_50_50_outcome"))

def _build_index_sets(tokens):
    return [1 << idx for idx, _ in enumerate(tokens or [])]

def _fetch_redeemable_positions(proxy_address, session):
    if not proxy_address:
        return []
    limit = 100
    offset = 0
    positions = []
    while True:
        params = {
            "user": proxy_address,
            "sizeThreshold": str(getattr(config, "CLAIM_SIZE_THRESHOLD", "0.1")),
            "redeemable": "true",
            "limit": str(limit),
            "offset": str(offset),
        }
        try:
            resp = session.get(f"{config.DATA_API_URL}/positions", params=params, timeout=10)
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

def _group_positions_by_condition(positions):
    grouped = {}
    for pos in positions:
        condition_id = pos.get("conditionId")
        outcome_index = pos.get("outcomeIndex")
        if condition_id is None or outcome_index is None:
            continue
        index_set = 1 << int(outcome_index)
        grouped.setdefault(condition_id, set()).add(index_set)
    return grouped

def _encode_redeem_call_data(ctf_address, collateral_address, condition_id, index_sets):
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

    parent_collection_id = getattr(config, "CLAIM_PARENT_COLLECTION_ID", ZERO_BYTES32)
    args = [checksum(collateral_address), parent_collection_id, condition_id, index_sets]
    if hasattr(contract, "encode_abi"):
        return contract.encode_abi("redeemPositions", args=args)
    return contract.encodeABI(fn_name="redeemPositions", args=args)

def _build_relayer_client():
    try:
        from py_builder_relayer_client.client import RelayClient
    except Exception as exc:
        raise RuntimeError("py-builder-relayer-client is required for live claims") from exc

    from py_builder_signing_sdk.config import BuilderConfig
    from py_builder_signing_sdk.sdk_types import BuilderApiKeyCreds

    api_key = os.getenv("BUILDER_API_KEY") or getattr(config, "BUILDER_API_KEY", "")
    api_secret = os.getenv("BUILDER_SECRET") or getattr(config, "BUILDER_SECRET", "")
    api_passphrase = (
        os.getenv("BUILDER_PASS_PHRASE")
        or os.getenv("BUILDER_PASSPHRASE")
        or getattr(config, "BUILDER_PASS_PHRASE", "")
        or getattr(config, "BUILDER_PASSPHRASE", "")
    )

    if not api_key or not api_secret or not api_passphrase:
        raise RuntimeError("missing builder API credentials")

    if not config.PRIVATE_KEY:
        raise RuntimeError("missing private key for relayer signer")

    builder_creds = BuilderApiKeyCreds(key=api_key, secret=api_secret, passphrase=api_passphrase)
    builder_config = BuilderConfig(local_builder_creds=builder_creds)
    return RelayClient(config.RELAYER_URL, config.CHAIN_ID, private_key=config.PRIVATE_KEY, builder_config=builder_config)

def load_trade_history():
    history = set()
    pending_trades = set()  # 新增：处理中的交易

    if os.path.exists(config.TRADE_LOG_FILE):
        with open(config.TRADE_LOG_FILE, "r", encoding='utf-8') as f:
            # 只加载最近1小时的PENDING状态
            cutoff_time = time.time() - 3600  # 1小时前

            for line in f:
                try:
                    parts = line.strip().split(",")
                    if len(parts) >= 3:
                        token_id = parts[0]
                        timestamp_str = parts[1]  # YYYY-MM-DD HH:MM:SS
                        status = parts[3] if len(parts) > 3 else 'UNKNOWN'

                        history.add(token_id)

                        # 只保留最近1小时的PENDING状态，避免死锁
                        if status == 'PENDING':
                            try:
                                timestamp = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S")
                                if timestamp.timestamp() > cutoff_time:
                                    pending_trades.add(token_id)
                            except:
                                pass  # 时间解析失败，忽略该PENDING状态
                except:
                    pass

    print(f"[加载历史] 历史记录: {len(history)} | 活跃PENDING: {len(pending_trades)}")
    return history, pending_trades

def _load_token_history():
    history = {}
    file_path = getattr(config, "TOKEN_HISTORY_FILE", "token_history.log")
    retention_days = getattr(config, "TOKEN_HISTORY_RETENTION_DAYS", 30)
    cutoff_ts = time.time() - (retention_days * 86400)
    has_purged = False

    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split(",")
                if len(parts) < 2:
                    continue
                token_id = parts[0]
                ts_str = parts[1]
                try:
                    ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").timestamp()
                except Exception:
                    continue
                if ts >= cutoff_ts:
                    history[token_id] = ts
                else:
                    has_purged = True

    if has_purged:
        _rewrite_token_history(file_path, history)

    return history

def _rewrite_token_history(file_path, history):
    with open(file_path, "w", encoding="utf-8") as f:
        for token_id, ts in sorted(history.items(), key=lambda item: item[1]):
            ts_str = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
            f.write(f"{token_id},{ts_str}\n")

def _record_token_history(token_id, history):
    file_path = getattr(config, "TOKEN_HISTORY_FILE", "token_history.log")
    ts = time.time()
    history[token_id] = ts
    ts_str = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(f"{token_id},{ts_str}\n")
        f.flush()  # 立即刷新到磁盘
    print(f"[记录] Token已记录到历史: {token_id[:20]}...")

def save_trade_record(token_id, title, price, mode):
    with open(config.TRADE_LOG_FILE, "a", encoding='utf-8') as f:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        f.write(f"{token_id},{timestamp},{price},{mode},{title}\n")

def get_cash_balance(client):
    try:
        # 使用字符串而不是枚举
        collateral = client.get_balance_allowance(BalanceAllowanceParams(asset_type="COLLATERAL"))
        return int(collateral.get('balance')) / 10**6
    except:
        return 0.0

def get_est_time():
    return datetime.now().strftime("%H:%M:%S")

def authenticate_client():
    try:
        print(f"[认证/Auth] 开始认证...")
        client = ClobClient(
            config.HOST, 
            key=config.PRIVATE_KEY, 
            chain_id=config.CHAIN_ID, 
            signature_type=config.SIGNATURE_TYPE, 
            funder=config.FUNDER
        )
        client.set_api_creds(client.create_or_derive_api_creds())
        print(f"[认证/Auth] 认证成功！")
        return client
    except Exception as e:
        error_msg = str(e)
        if "10054" in error_msg or "reset" in error_msg.lower():
            print(f"[Engine] 网络连接重置 (10054). 正在冷却 30s...")
            time.sleep(30)
        else:
            print(f"[Engine Error] {error_msg}")
            time.sleep(10)
        print(f"[认证/Auth] 失败/Failed: {e}")
        return None

def test_claim_winnings(client=None, dry_run=None, token_ids=None, max_tokens=None, lookback_days=None, build_call_data=None):
    try:
        if dry_run is None:
            dry_run = getattr(config, "CLAIM_DRY_RUN", True)

        log_success_only = getattr(config, "CLAIM_LOG_SUCCESS_ONLY", True)
        success_count = 0

        def _log(message):
            if not log_success_only:
                print(message)

        session = requests.Session()

        if token_ids:
            if isinstance(token_ids, str):
                tokens = _parse_token_ids(token_ids)
            else:
                tokens = list(token_ids)
            positions = []
        else:
            positions = []
            if getattr(config, "CLAIM_USE_DATA_API", True):
                proxy_address = getattr(config, "FUNDER", "") or getattr(config, "PROXY_ADDRESS", "")
                positions = _fetch_redeemable_positions(proxy_address, session)
            raw_tokens = _parse_token_ids(getattr(config, "CLAIM_TOKEN_IDS", ""))
            if raw_tokens:
                tokens = raw_tokens
            else:
                if positions:
                    tokens = []
                else:
                    tokens = _load_claim_tokens_from_log(
                        max_tokens or getattr(config, "CLAIM_MAX_TOKENS", 50),
                        lookback_days or getattr(config, "CLAIM_LOOKBACK_DAYS", 60),
                    )

        if not tokens and not positions:
            _log("[Claim] No candidate tokens found.")
            return []

        collateral, conditional = _resolve_contract_addresses(client)
        if not collateral or not conditional:
            _log("[Claim] Missing collateral or conditional token contract address.")
            return []

        if build_call_data is None:
            build_call_data = (not dry_run) or getattr(config, "CLAIM_BUILD_CALLDATA", False)

        results = []
        relayer = None
        safe_ready = False

        grouped_positions = _group_positions_by_condition(positions) if positions else {}
        if grouped_positions:
            for condition_id, index_set_values in grouped_positions.items():
                index_sets = sorted(index_set_values)
                call_data = None
                if build_call_data:
                    try:
                        call_data = _encode_redeem_call_data(conditional, collateral, condition_id, index_sets)
                    except Exception as e:
                        _log(f"[Claim] Condition {condition_id}: call data build failed: {e}")
                        if not dry_run:
                            raise

                if dry_run:
                    _log(f"[Claim Dry Run] condition={condition_id} index_sets={index_sets}")
                    results.append(
                        {
                            "condition_id": condition_id,
                            "index_sets": index_sets,
                            "dry_run": True,
                            "source": "data-api",
                        }
                    )
                    continue

                if call_data is None:
                    raise RuntimeError("call data required for live claim")

                if relayer is None:
                    relayer = _build_relayer_client()
                    expected_safe = relayer.get_expected_safe()
                    if not relayer.get_deployed(expected_safe):
                        if getattr(config, "CLAIM_AUTO_DEPLOY_SAFE", False):
                            _log(f"[Claim] Deploying safe {expected_safe}...")
                            deploy_resp = relayer.deploy()
                            deploy_resp.wait()
                        else:
                            _log(f"[Claim] Safe {expected_safe} is not deployed. Enable CLAIM_AUTO_DEPLOY_SAFE to deploy.")
                            break
                    safe_ready = True

                if not safe_ready:
                    _log("[Claim] Safe not ready, skipping remaining claims.")
                    break

                try:
                    from py_builder_relayer_client.models import SafeTransaction, OperationType
                except Exception as exc:
                    raise RuntimeError("py-builder-relayer-client is required for live claims") from exc

                tx = SafeTransaction(
                    to=conditional,
                    operation=OperationType.Call,
                    data=call_data,
                    value="0",
                )
                resp = relayer.execute([tx], metadata=f"redeem:{condition_id}")
                receipt = resp.wait()
                if receipt is not None:
                    success_count += 1
                results.append(
                    {
                        "condition_id": condition_id,
                        "transaction_id": resp.transaction_id,
                        "transaction_hash": resp.transaction_hash,
                        "receipt": receipt,
                        "dry_run": False,
                        "source": "data-api",
                    }
                )

        for token_id in tokens:
            market = _fetch_market_for_token(token_id, session)
            if not market:
                _log(f"[Claim] Token {token_id}: market lookup failed.")
                continue

            if not _market_is_resolved(market):
                _log(f"[Claim] Token {token_id}: market not resolved yet.")
                continue

            condition_id = market.get("condition_id")
            tokens_payload = market.get("tokens") or []
            if not condition_id or not tokens_payload:
                _log(f"[Claim] Token {token_id}: missing condition or tokens.")
                continue

            index_sets = _build_index_sets(tokens_payload)
            call_data = None
            if build_call_data:
                try:
                    call_data = _encode_redeem_call_data(conditional, collateral, condition_id, index_sets)
                except Exception as e:
                    _log(f"[Claim] Token {token_id}: call data build failed: {e}")
                    if not dry_run:
                        raise

            if dry_run:
                _log(f"[Claim Dry Run] token={token_id} condition={condition_id} index_sets={index_sets}")
                results.append(
                    {
                        "token_id": token_id,
                        "condition_id": condition_id,
                        "index_sets": index_sets,
                        "dry_run": True,
                    }
                )
                continue

            if call_data is None:
                raise RuntimeError("call data required for live claim")

            if relayer is None:
                relayer = _build_relayer_client()
                expected_safe = relayer.get_expected_safe()
                if not relayer.get_deployed(expected_safe):
                    if getattr(config, "CLAIM_AUTO_DEPLOY_SAFE", False):
                        _log(f"[Claim] Deploying safe {expected_safe}...")
                        deploy_resp = relayer.deploy()
                        deploy_resp.wait()
                    else:
                        _log(f"[Claim] Safe {expected_safe} is not deployed. Enable CLAIM_AUTO_DEPLOY_SAFE to deploy.")
                        break
                safe_ready = True

            if not safe_ready:
                _log("[Claim] Safe not ready, skipping remaining claims.")
                break

            try:
                from py_builder_relayer_client.models import SafeTransaction, OperationType
            except Exception as exc:
                raise RuntimeError("py-builder-relayer-client is required for live claims") from exc

            tx = SafeTransaction(
                to=conditional,
                operation=OperationType.Call,
                data=call_data,
                value="0",
            )
            resp = relayer.execute([tx], metadata=f"redeem:{condition_id}")
            receipt = resp.wait()
            if receipt is not None:
                success_count += 1
            results.append(
                {
                    "token_id": token_id,
                    "condition_id": condition_id,
                    "transaction_id": resp.transaction_id,
                    "transaction_hash": resp.transaction_hash,
                    "receipt": receipt,
                    "dry_run": False,
                }
            )

        if success_count > 0:
            print(f"[Claim] Success: {success_count}")
        return results
    except Exception as e:
        _log(f"[Claim] Failed: {e}")
        return []

def run_main_engine():
    print(f"\n🚀 [Engine] 启动狙击手引擎 (V4.2) | 单笔限额: ${config.MAX_TRADE_AMOUNT}")
    print(f"[Engine] 风险控制: 电竞市场已禁用 | 专注NBA + 稳定收益")

    client = authenticate_client()
    if not client:
        return

    # 测试领钱功能
    test_claim_winnings(client)

    scanner = OpportunityScanner(verbose=config.VERBOSE_ESPORTS_LOGGING)
    executor = TradeExecutor(client)

    # 🔴 简化：只用一个文件做去重，保留15天
    purchased_tokens = _load_purchased_tokens()
    print(f"[加载历史] 已购买记录: {len(purchased_tokens)} 条")

    scan_count = 0
    today_sniped_count = 0

    while True:
        try:
            scan_count += 1

            opportunities = scanner.scan_markets()
            stats = scanner.last_stats

            if not opportunities:
                # 简化：无机会时只显示一个点，不换行
                print(".", end="", flush=True)
                time.sleep(config.SCAN_INTERVAL)
                continue

            # 处理每个机会
            bought_this_round = False
            skip_count = 0
            for opp in opportunities:
                token_id = opp['token_id']
                title = opp['title']

                # 🔴 核心检查：这个token是否已经买过？
                if token_id in purchased_tokens:
                    skip_count += 1
                    continue

                # 显示完整标题（新格式）
                print(f"\n💎 [发现机会]")
                print(f"   标题: {title}")
                print(f"   价格: ${opp['price']:.4f} | 预期收益: {opp['analysis']['roi']*100:.1f}%")
                print(f"   剩余: {opp['analysis']['min']:.0f}分钟 | 方向: {opp['direction']}")
                print(f"   Token: {token_id[:30]}...")

                # 🔴 先记录到文件，再执行交易
                _save_purchased_token(token_id, title, purchased_tokens)

                try:
                    result = executor.execute_trade(opp)

                    if result and result.get('success'):
                        today_sniped_count += 1
                        print(f"✅ [成功] #{today_sniped_count} | {opp['direction']} @ ${opp['price']}")
                        print(f"   Order: {result.get('order_id', 'N/A')}")
                        bought_this_round = True
                        break  # 🔴 买完一个就退出，等60秒再扫描
                    else:
                        error_msg = result.get('error', 'Unknown') if result else 'No result'
                        print(f"❌ [失败] {error_msg}")

                except Exception as e:
                    print(f"❌ [异常] {str(e)}")

            # 本轮统计 - 简化输出
            if skip_count > 0 and not bought_this_round:
                # 有机会但都跳过了，显示简短信息
                print(f"[{get_est_time()}] 有效:{stats['valid']} 跳过:{skip_count} 余额:${get_cash_balance(client):.2f}", flush=True)
            elif bought_this_round:
                # 买了东西，显示完整统计
                print(f"\n💰 余额: ${get_cash_balance(client):.2f} | 今日: {today_sniped_count} 笔")

            # 🔴 固定等待60秒再扫描
            time.sleep(config.SCAN_INTERVAL)

        except KeyboardInterrupt:
            print(f"\n🛑 [用户中断] 引擎已停止")
            break
        except Exception as e:
            print(f"\n❌ [引擎错误] {e}")
            time.sleep(10)


def _load_purchased_tokens():
    """加载已购买的token列表（保留15天）"""
    purchased = set()
    file_path = getattr(config, "TOKEN_HISTORY_FILE", "token_history.log")
    retention_days = 15  # 保留15天
    cutoff_ts = time.time() - (retention_days * 86400)

    if not os.path.exists(file_path):
        return purchased

    valid_lines = []
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split(",", 1)
            if len(parts) < 2:
                continue
            token_id = parts[0]
            ts_str = parts[1].split(",")[0]  # 只取时间部分
            try:
                ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").timestamp()
                if ts >= cutoff_ts:
                    purchased.add(token_id)
                    valid_lines.append(line)
            except:
                continue

    # 清理过期记录
    with open(file_path, "w", encoding="utf-8") as f:
        f.writelines(valid_lines)

    return purchased


def _save_purchased_token(token_id, title, purchased_set):
    """保存已购买的token"""
    file_path = getattr(config, "TOKEN_HISTORY_FILE", "token_history.log")
    ts_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 立即添加到内存
    purchased_set.add(token_id)

    # 立即写入文件
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(f"{token_id},{ts_str},{title}\n")
        f.flush()

    print(f"[记录] 已保存: {token_id[:15]}...")

if __name__ == "__main__":
    if "--claim" in sys.argv:
        claim_dry_run = getattr(config, "CLAIM_DRY_RUN", True)
        if "--claim-live" in sys.argv:
            claim_dry_run = False
        if "--claim-dry-run" in sys.argv:
            claim_dry_run = True
        test_claim_winnings(None, dry_run=claim_dry_run)
    else:
        run_main_engine()
