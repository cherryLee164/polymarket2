# Task Plan

## Goal
Keep monitoring and trading separate, then implement a standalone Polymarket order engine for the hourly BTC Up/Down strategy.

## Phases
- [completed] Confirm the order strategy rules and the requirement to keep trading separate from monitoring.
- [completed] Review the current script flow and official Polymarket CLOB order placement requirements.
- [completed] Implement shared Polymarket helpers plus a standalone order engine with persistent hourly state.
- [completed] Add BAT launcher and document configuration for live trading versus dry-run mode.
- [completed] Run validation commands and smoke-check the new order path.
- [completed] Add an automatic settlement worker that can sell matured BTC positions via API before falling back to browser-based redeem handling.
- [completed] Split settlement back out of `run-order.bat` into its own launcher and keep the buy engine focused on entries only.
- [completed] Add a dormant `5m` trading variant to the Python order engine without enabling it in live runtime config.
- [completed] Replay existing `5m` monitor data and capture an initial threshold recommendation for later live activation.
- [completed] Replace monitor-page sample-count cards with threshold aggregate summaries and translate the user-facing README into Chinese.
- [completed] Wire dormant `5M` order defaults (`30 / 50`, fixed `$1`) into the shared Python order engine without changing the live `1H` runtime path.
- [completed] Add a `5M` rolling-loss pause gate (`12h <= -$10` => pause `8h`) that blocks new `5M` entries before the next window starts.
- [completed] Replace the single `run-order.bat` process with a unified launcher that starts `1H + 5M` together while keeping variant runtime state isolated.
- [completed] Split admin profit summaries by `1H` and `5M` while leaving order-level details in one combined ledger.
- [completed] Fix the live `5M` duplicate-attempt bug so the same side is not auto-submitted multiple times within one 5-minute window after request failures.
- [completed] Tighten settlement worker observability so idle scans clearly log their result and the launcher uses unbuffered Python output.
- [completed] Relax the `5M` failure gate so a transient/unfilled hedge can get one verified retry within the same 5-minute window instead of forcing the engine to wait for the next event.
- [completed] Align the `5M` retry cooldown with the 4-second submit rhythm so the single allowed retry can actually happen inside the same 5-minute window.
- [completed] Diagnose and fix the `5M` same-side duplicate entry bug where a transient first-entry exception can still lead to a second `UP` order in the same event.
- [completed] Re-enable API redeem/claim in the settlement worker so tracked positions follow the order: sell at `>=99.9c` first, otherwise redeem/claim via API.
- [completed] Improve live CLOB transport stability/observability for `5M` request exceptions and expand settlement scope from tracked-only to all redeemable positions in the account.
- [completed] Replace the planned hard-stop-on-fail idea with a persistent `5M` execution pause flag that keeps the process alive but skips new `5M` order logic after repeated missed windows, while restoring settlement to tracked-only and updating `1H` sizing to `2/3`.
- [completed] Replay the collected `15M` monitor history to identify whether a simple two-leg entry/hedge rule is worth testing before any live implementation.
- [completed] Add standalone paper-simulation runners for `15M` and `5M` so new short-window ideas can be tracked separately from the live `1H` order engine.
- [completed] Expand the standalone `5M` and `15M` paper runners to a shared six-group strategy set (`30/30`, `30/35`, `30/40`, `30/45`, `35/35`, `40/40`) and surface their rolling profit summaries inside the monitor UI as dedicated tabs.
- [completed] Add a standalone `4H` paper runner, align `5M/15M` prior-window reference handling to the new "look back two windows" rule, expose the three paper runners with clearer BAT window titles, and wire the missing `4H` paper tab into the monitor UI.
- [completed] Re-evaluate the current rolling `15M` paper sample against the user's newer `35/x` ideas and identify which simple equal-dollar pair is least bad before any new custom state-machine script is attempted.
- [completed] Add a second standalone `15M` paper runner for the new `35/x` test set (`35/36`, `35/40`, `35/45`) without disturbing the existing `15M` rolling session, and surface it as a separate monitor tab.

## Notes
- `scripts/monitor.js` remains a pure observer; live trading logic belongs in a separate script and data directory.
- Order sizing is binary: use `$1` by default, switch the next hour to `$2` when the previous hour did not show both sides at `<= 40`, and revert to `$1` after an hour that did show both sides at `<= 40`.
- Carry-over sizing now only looks at the immediately previous qualified hour, not any older hour farther back in history.
- The Next.js home route now serves as a single admin console entry point, with tabs for monitor summaries, order-hour summaries, and order execution details backed by local report files.
- Monitor summaries now need richer analysis fields so strategy tuning can happen in the admin UI without re-reading raw JSONL manually.
- The current monitor enhancement scope is: first-hit timestamps per threshold, sampling-health metrics, and per-variant retention defaults that keep short windows from growing storage too quickly.
- Settlement should prefer API execution. For matured winner positions, use `positions.curPrice/currentValue` only as a candidate signal, then confirm with the actual executable CLOB sell price before sending a `SELL` market order.
- The order launcher should remain the single operational entry point. Settlement scanning therefore runs off `scripts/order.py` on a low-frequency scheduler, rather than requiring a separate always-on BAT.
- Operational direction changed again: buying and settlement are separate launchers. `run-order.bat` stays focused on entry logic, and `run-settlement.bat` becomes the standalone sell/redeem watcher.
- The `5m` path should share the same order engine as `1h`, but it must stay dormant until thresholds are reviewed against collected data.
- The monitor page now needs top-level aggregate cards driven by the current filtered dataset, not raw runtime sample counters, so threshold hit frequency is visible at a glance.
- `5M` strategy defaults must ignore the existing global `1H` env thresholds unless the user explicitly provides `ORDER_5M_*` overrides; otherwise `order:5m` would inherit `38/38`.
- Running `1H + 5M` together cannot share one `runtime-state.json`; the order engine must persist per-variant runtime state files so the two processes do not overwrite each other.
- For `5M`, safety now takes priority over aggressive fills: one side gets at most one live submission per event, request-exception paths immediately check whether position size actually increased, and otherwise the engine waits for the next `5M` event instead of retrying inside the same window.
- The current live issue shows that an immediate post-exception position check is not sufficient on its own; `5M` needs a persisted per-side "confirmation pending" gate so the same side is not re-selected while the first submit is still being verified.
- The implemented fix keeps `5M` retry capability, but only after the engine spends the existing retry window verifying whether the first transient submit actually produced a position increase.
- Read-only settlement probing now shows the account has redeemable tracked entries, claim credentials are present, claim contracts resolve, and the relayer safe is already deployed; the current blocker is that `scripts/auto_redeem.py` hardcodes `claim=off`.
- `scripts/auto_redeem.py` now uses `ORDER_AUTO_CLAIM_ENABLED` / `ORDER_AUTO_REDEEM_ENABLED` to enable API redeem, keeps sell-first ordering, persists claim attempt metadata, and logs claim success/error explicitly.
- The current `15M` request is analysis-only. Do not wire any new `15M` live order path until the local replay shows a simple rule with acceptable drawdown and operational complexity.
- Short-window experiments should stay in standalone paper runners. Do not merge any `5M` or `15M` test strategy back into `scripts/order.py` until the rolling paper stats look stable enough to justify live risk.
