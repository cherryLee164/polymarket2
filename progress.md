# Progress

## Completed
- Added `estimate_buy_price()` to the BTC trader wrapper using the official Polymarket Python client.
- Reworked 4h trigger entry so each side tracks its own target spend and remaining spend.
- Removed the old single-side `firstEntryPlaced` trigger gate from active sampling.
- Removed the intentional `$1` chunk split behavior from BTC trigger entry.
- Stopped BTC monitor and BTC recovery processes.
- Cleared BTC monitor data, BTC recovery logs/reports/runtime, and stale BTC locks.
- Rebuilt clean default BTC recovery runtime/report snapshots.

## Current State
- BTC auto-order is stopped.
- BTC monitor processes are stopped.
- Weather sync is still running.
- BTC 4h summary is reset to a fresh `$1` base state.

## Weather Retry 2026-04-29
- Found 8 weather live orders failed at `00:15` due `order_version_mismatch`.
- Checked chain state before retry: Shanghai already had `1.4084` No shares, other 7 cities had no position/open order.
- Retried 7 cities excluding Shanghai.
- Beijing, Chengdu, Chongqing, Shenzhen, Taipei returned successful submitted orders with CLOB status `delayed`.
- Wuhan and Hong Kong were not submitted because collateral balance had fallen below the `$2.0` minimum.
- Rechecked after delay: Beijing, Chengdu, Chongqing, Shenzhen, Taipei became `MATCHED`.
- Retried Wuhan and Hong Kong after balance was available; both became `MATCHED` after reconcile.
- Reconciled Shanghai from CLOB trade history: No `1.408448` shares at price `0.71`, cost `$0.999998`.
- Final state: all 8 weather records for `2026-04-29` are `pending` with `fillStatus=bot-order-fill`; no weather open orders remain.

## BTC 4h Prestart Guard
- Added `PRESTART_SINGLE_SIDE_GUARD_MINUTES`, default `5` minutes for 4h.
- Added guard behavior: in the final 5 minutes before event start, stop new limit-pair retries.
- Added single-sided protection: if exactly one side has a live limit order in that guard window, cancel that one side and close the other side for entry.
- Verified with `python -m py_compile scripts\order_recovery.py`.
- Restarted 4h recovery worker; runtime now shows `retryGapMs=300000` and `prestartSingleSideGuardMinutes=5.0`.
- Confirmed current event `btc-updown-4h-1777464000`: Up filled at 20:14 CST, Down remains a live limit order.
- Tightened prestart-only behavior so no new limit-pair order is submitted after the event start, even if one side is still open and the other side becomes retryable.
- Tightened the final 5-minute guard again: only two `LIVE` limit orders count as "both sides hung"; filled/matched positions are recorded but do not count as successful hanging orders.

## Weather Retry 2026-04-30
- Found 9 weather records for `2026-04-30`: Chongqing had filled, 8 cities failed from Gamma API `500 Server Error`.
- Added Gamma `500/Internal Server Error` to weather failed-order retry markers.
- Ran `weather_reconcile_live_orders.py`, then `weather_live_order.py`, then reconciled again.
- Final state: all 9 weather live orders for `2026-04-30` are `pending` with `fillStatus=bot-order-fill`.

## BTC 4h Independent Events
- Added `pendingResolutionEvents` to keep old 4h events waiting for end/resolution without blocking the next event's prestart order placement.
- Changed the main loop to always process pending events, sample the current active event, and then check whether a new prestart event should be opened.
- Changed `maybe_start_current_event()` so a different active event is moved to pending resolution when the next event's prestart window opens.
- Verified `scripts/order_recovery.py` with `python -m py_compile`.
- Simulated handoff: old active event moved to pending and new event became active.
- Restarted `order_recovery_launcher.js`; new launcher PID `28664`, 4h worker PID `29204`.
- Confirmed current 4h active event `btc-updown-4h-1777492800` has both Up and Down 40c limit orders in `LIVE` status.
- Tightened the loop again so entry/opening runs before active sampling and pending settlement, with settlement errors isolated from order placement.
- Restarted `order_recovery_launcher.js` again after loop-order change; new launcher PID `29908`, 4h worker PID `9524`.

## Weather Simulation Slots 2026-04-30
- Fixed threshold simulation normalization to infer the slot from record keys or labels before falling back to `captureSlotId`.
- Added explicit slot fields when creating threshold simulation scan/trade/error records.
- Changed strategy rows to always expose all 24 combinations: 10:00, 11:00, 12:00, 13:00 times 85/88/90/92/95/97.
- Added `WEATHER_SIM_MAX_NO_PRICE` / `WEATHER_SIM_MAX_THRESHOLD` support with default `0.99`; simulated trades above 99c are ignored.
- Resynced `data/weather_predictions/records-threshold-sim.json`: 324 trade records remain, max No price is 0.99, and `>99c` count is 0.
- Verified `node --check lib/weather-trading-data.js`, snapshot output, and `npx eslint lib\weather-trading-data.js app\components\weather-simulation-section.js`.

## BTC 4h Full Rewrite
- Deleted the old `scripts/order_recovery.py` implementation and replaced it with a fixed 4h limit-order worker.
- New logic only finds the next 4h event and, from 60 minutes before start until start, submits Up and Down limit buys at 40c for 5 shares each.
- Removed the old running-path concepts for 4h: realized PnL, recovery mode, loss streak, settlement, half-window deadline, external-position blocking, top-up, and single-side guard cancellation.
- Restarted `order_recovery_launcher.js`; new launcher PID `27136`, new 4h worker PID `25684`.
- New runtime is reset to `version=1`, active event `btc-updown-4h-1777550400`, entry opens at `2026-04-30T11:00:00+00:00`, no trades submitted yet.

## Weather Rotation Simulation
- Started a standalone simulation task for overseas 18:00 BJT and domestic next-day 06:00 BJT weather rotation.
- User explicitly required existing weather/live behavior to remain untouched.

## Weather Offset Strategies
- Replaced the old weather threshold simulation UI with `-1C / 0C / +1C` offset strategy reporting.
- Added weather config fields for `executionMode` (`simulation` or `live`) and selected `temperatureOffsets`.
- Expanded weather config so `-1C`, `0C`, and `+1C` each have independent enablement, base stake, and multiplier sequence.
- Changed the default weather live multiplier sequence from `1-2-2-3-5` to `1-2-2-2-3`.
- Weather records now store offset candidate markets when available; old current-day records can be backfilled with candidates during sync.
- Weather live ordering now expands selected offsets and computes progression independently by `citySlug + temperatureOffsetC`.
- Verified `node --check`, `python -m py_compile`, targeted ESLint, offset snapshot output, and localhost simulation page content.
