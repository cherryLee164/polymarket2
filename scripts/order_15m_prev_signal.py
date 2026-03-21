import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts import order_15m_paper as paper  # noqa: E402


DATA_DIR = ROOT_DIR / "data" / "prev-signals"
paper.ensure_dir(DATA_DIR)


def build_prev_slug(current_slug: str) -> Optional[str]:
    """从当前slug构建上上个slug（减30分钟）"""
    try:
        # slug格式: btc-updown-15m-{timestamp}
        ts_str = current_slug.replace("btc-updown-15m-", "")
        ts = int(ts_str)
        prev_ts = ts - 30 * 60  # 减30分钟
        return f"btc-updown-15m-{prev_ts}"
    except Exception:
        return None


def get_winner_side(slug: str) -> Optional[str]:
    """查询事件的赢家方向（up/down）"""
    payload = paper.fetch_event(slug)
    if not payload:
        return None
    settlement = paper.extract_resolution_snapshot(payload)
    if not settlement or settlement.get("status") != "resolved":
        return None
    return settlement.get("winnerSide")


def record_signal(current_slug: str, prev_slug: str, winner_side: str) -> Dict[str, Any]:
    """记录信号到文件"""
    now = datetime.now(paper.UTC)
    record = {
        "slug": current_slug,
        "prevSlug": prev_slug,
        "signal": winner_side,  # "up" 或 "down"
        "recordedAt": now.isoformat(),
    }
    
    # 写入当天文件
    date_str = now.strftime("%Y-%m-%d")
    file_path = DATA_DIR / f"signals-{date_str}.jsonl"
    paper.append_json_line(file_path, record)
    
    return record


def main():
    paper.log("15M prev-signal recorder started")
    paper.log(f"Data dir: {DATA_DIR}")
    
    last_slug = None
    
    while True:
        try:
            now = datetime.now(paper.UTC)
            meta = paper.resolve_current_event_meta(now)
            
            if meta is None:
                time.sleep(5)
                continue
            
            current_slug = meta["slug"]
            
            # 新事件开始
            if current_slug != last_slug:
                last_slug = current_slug
                
                # 构建上上个slug
                prev_slug = build_prev_slug(current_slug)
                if not prev_slug:
                    paper.log(f"Failed to build prev slug for {current_slug}")
                    time.sleep(5)
                    continue
                
                # 查询上上个事件的结果
                winner_side = get_winner_side(prev_slug)
                if winner_side:
                    record = record_signal(current_slug, prev_slug, winner_side)
                    paper.log(f"Signal recorded | current={current_slug} prev={prev_slug} signal={winner_side}")
                else:
                    paper.log(f"Prev event not resolved yet | prev={prev_slug}")
            
            time.sleep(5)
            
        except Exception as exc:
            paper.log(f"Error: {exc}")
            time.sleep(5)


if __name__ == "__main__":
    main()
