from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Dict, Optional


ADAPTIVE_MODE = "adaptive-40-30-45"


def build_adaptive_strategy_def(
    strategy_id: str = "g_adaptive_40_30_45_1",
    label: str = "A40/30->40/45($1)",
    usd_per_order: float = 1.0,
) -> Dict[str, Any]:
    return {
        "id": strategy_id,
        "label": label,
        "mode": ADAPTIVE_MODE,
        "firstEntryCents": 40.0,
        "hedgeEntryCents": 45.0,
        "deepEntryCents": 30.0,
        "mirrorEntryCents": 45.0,
        "usdPerOrder": float(usd_per_order),
        "ruleLines": [
            "first side <= 40c",
            "if same side hits <= 30c first: opposite side <= 40c, then <= 45c",
            "if opposite side hits <= 40c first: next <= 30c wins, remaining side <= 45c",
        ],
    }


def is_adaptive_strategy_def(strategy_def: Dict[str, Any]) -> bool:
    return str(strategy_def.get("mode") or "").strip().lower() == ADAPTIVE_MODE


def is_adaptive_strategy_state(strategy: Dict[str, Any]) -> bool:
    return str(strategy.get("mode") or "").strip().lower() == ADAPTIVE_MODE


def build_adaptive_strategy_state(strategy_def: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": strategy_def["id"],
        "label": strategy_def["label"],
        "mode": ADAPTIVE_MODE,
        "firstEntryCents": float(strategy_def.get("firstEntryCents") or 40.0),
        "hedgeEntryCents": float(strategy_def.get("hedgeEntryCents") or 45.0),
        "deepEntryCents": float(strategy_def.get("deepEntryCents") or 30.0),
        "mirrorEntryCents": float(strategy_def.get("mirrorEntryCents") or 45.0),
        "usdPerOrder": float(strategy_def.get("usdPerOrder") or 1.0),
        "ruleLines": list(strategy_def.get("ruleLines") or []),
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
        "orders": [],
        "branch": None,
        "firstFortySide": None,
        "secondFortySide": None,
        "thirtySide": None,
        "fortyFiveSide": None,
    }


def opposite_side(side: str) -> str:
    return "down" if side == "up" else "up"


def price_for_side(prices: Dict[str, float], side: str) -> float:
    return float(prices["upCents"] if side == "up" else prices["downCents"])


def placed_order_count(strategy: Dict[str, Any]) -> int:
    return len(strategy.get("orders") or [])


def place_order(
    strategy: Dict[str, Any],
    slot: str,
    side: str,
    threshold_cents: float,
    observed_cents: float,
    now: datetime,
    log_func: Optional[Callable[[str], None]] = None,
    slug: Optional[str] = None,
) -> bool:
    shares = round(strategy["usdPerOrder"] / (float(threshold_cents) / 100.0), 6)
    order = {
        "slot": slot,
        "side": side,
        "thresholdCents": float(threshold_cents),
        "observedCents": float(observed_cents),
        "shares": shares,
        "triggeredAt": now.isoformat(),
    }
    strategy.setdefault("orders", []).append(order)
    if strategy["firstSide"] is None:
        strategy["firstSide"] = side
        strategy["firstTriggeredAt"] = order["triggeredAt"]
        strategy["firstObservedCents"] = order["observedCents"]
        strategy["firstShares"] = shares
    elif strategy["hedgeSide"] is None:
        strategy["hedgeSide"] = side
        strategy["hedgeTriggeredAt"] = order["triggeredAt"]
        strategy["hedgeObservedCents"] = order["observedCents"]
        strategy["hedgeShares"] = shares
    strategy["status"] = f"adaptive-open-{len(strategy['orders'])}"
    if log_func:
        target = f" for {slug}" if slug else ""
        log_func(
            f"{strategy['label']} {slot} {side.upper()} hit at {float(observed_cents):.3f}c{target}"
        )
    return True


def apply_adaptive_strategy_sample(
    strategy: Dict[str, Any],
    prices: Dict[str, float],
    now: datetime,
    *,
    event_end: Optional[datetime] = None,
    deadline_at: Optional[datetime] = None,
    log_func: Optional[Callable[[str], None]] = None,
    slug: Optional[str] = None,
) -> bool:
    if strategy.get("resolvedAt"):
        return False

    changed = False
    first_threshold = float(strategy.get("firstEntryCents") or 40.0)
    deep_threshold = float(strategy.get("deepEntryCents") or 30.0)
    mirror_threshold = float(strategy.get("mirrorEntryCents") or 45.0)
    first_side = strategy.get("firstFortySide")

    if first_side is None:
        if deadline_at and now > deadline_at:
            strategy["status"] = "skipped-deadline"
            strategy["skipReason"] = f"no side <= {first_threshold:g}c before deadline"
            strategy["resolvedAt"] = now.isoformat()
            return True
        candidates = []
        if price_for_side(prices, "up") <= first_threshold:
            candidates.append(("up", price_for_side(prices, "up")))
        if price_for_side(prices, "down") <= first_threshold:
            candidates.append(("down", price_for_side(prices, "down")))
        if candidates:
            candidates.sort(key=lambda item: (item[1], item[0]))
            side, observed = candidates[0]
            strategy["firstFortySide"] = side
            changed = place_order(strategy, "first40", side, first_threshold, observed, now, log_func, slug)
    else:
        same_side = first_side
        other_side = opposite_side(same_side)

        if strategy.get("branch") is None:
            if price_for_side(prices, same_side) <= deep_threshold:
                strategy["branch"] = "same-side-30-first"
                strategy["thirtySide"] = same_side
                changed = place_order(
                    strategy,
                    "same30",
                    same_side,
                    deep_threshold,
                    price_for_side(prices, same_side),
                    now,
                    log_func,
                    slug,
                )
            elif price_for_side(prices, other_side) <= first_threshold:
                strategy["branch"] = "other-side-40-first"
                strategy["secondFortySide"] = other_side
                changed = place_order(
                    strategy,
                    "other40",
                    other_side,
                    first_threshold,
                    price_for_side(prices, other_side),
                    now,
                    log_func,
                    slug,
                )

        if strategy.get("branch") == "same-side-30-first":
            if strategy.get("secondFortySide") is None and price_for_side(prices, other_side) <= first_threshold:
                strategy["secondFortySide"] = other_side
                changed = place_order(
                    strategy,
                    "other40",
                    other_side,
                    first_threshold,
                    price_for_side(prices, other_side),
                    now,
                    log_func,
                    slug,
                ) or changed
            if strategy.get("secondFortySide") == other_side and strategy.get("fortyFiveSide") is None:
                if price_for_side(prices, other_side) <= mirror_threshold:
                    strategy["fortyFiveSide"] = other_side
                    changed = place_order(
                        strategy,
                        "other45",
                        other_side,
                        mirror_threshold,
                        price_for_side(prices, other_side),
                        now,
                        log_func,
                        slug,
                    ) or changed

        elif strategy.get("branch") == "other-side-40-first":
            if strategy.get("thirtySide") is None:
                thirty_candidates = []
                if price_for_side(prices, same_side) <= deep_threshold:
                    thirty_candidates.append((same_side, price_for_side(prices, same_side)))
                if price_for_side(prices, other_side) <= deep_threshold:
                    thirty_candidates.append((other_side, price_for_side(prices, other_side)))
                if thirty_candidates:
                    thirty_candidates.sort(key=lambda item: (item[1], item[0]))
                    side, observed = thirty_candidates[0]
                    strategy["thirtySide"] = side
                    changed = place_order(
                        strategy,
                        "late30",
                        side,
                        deep_threshold,
                        observed,
                        now,
                        log_func,
                        slug,
                    ) or changed
            if strategy.get("thirtySide") in {"up", "down"} and strategy.get("fortyFiveSide") is None:
                remaining_side = opposite_side(strategy["thirtySide"])
                if price_for_side(prices, remaining_side) <= mirror_threshold:
                    strategy["fortyFiveSide"] = remaining_side
                    changed = place_order(
                        strategy,
                        "remaining45",
                        remaining_side,
                        mirror_threshold,
                        price_for_side(prices, remaining_side),
                        now,
                        log_func,
                        slug,
                    ) or changed

    if event_end and now >= event_end and not strategy.get("orders"):
        strategy["status"] = "skipped-window-end"
        strategy["skipReason"] = "window ended before first trigger"
        strategy["resolvedAt"] = now.isoformat()
        changed = True

    return changed


def resolve_adaptive_strategy(strategy: Dict[str, Any], winner_side: Optional[str], checked_at: str) -> None:
    if strategy.get("resolvedAt") and strategy.get("winnerSide") is not None:
        return
    strategy["winnerSide"] = winner_side
    orders = list(strategy.get("orders") or [])
    if not orders:
        strategy["status"] = (
            strategy["status"] if str(strategy.get("status") or "").startswith("skipped") else "no-trade"
        )
        strategy["resolvedAt"] = checked_at
        return

    total_spent = round(sum(float(strategy.get("usdPerOrder") or 0.0) for _ in orders), 6)
    payout = 0.0
    if winner_side in {"up", "down"}:
        payout = round(
            sum(float(order.get("shares") or 0.0) for order in orders if order.get("side") == winner_side),
            6,
        )
    strategy["status"] = "resolved-multi" if len(orders) > 1 else "resolved-first-only"
    strategy["totalSpentUsd"] = total_spent
    strategy["totalPayoutUsd"] = payout
    strategy["netPnlUsd"] = round(payout - total_spent, 6)
    strategy["resolvedAt"] = checked_at
