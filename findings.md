# Findings

## BTC Logic Issues Found
- The old 4h trigger path stopped after the first filled side because it gated on `firstEntryPlaced`.
- The old trigger path intentionally split recovery orders into `$1` chunks, which no longer matches the requested behavior.
- Trigger qualification used a shallow quoted price signal, while order placement still depended on live book liquidity.
- `order_recovery_launcher.js` could silently respawn the BTC worker after only killing the Python process.

## Official API Alignment
- The Python client exposes `calculate_market_price(token_id, side, amount, order_type)`.
- BTC trigger placement now uses amount-aware estimated market price before submitting a capped market order.
- Actual submission still caps at the configured threshold price, so the bot does not intentionally buy above the trigger threshold.

## Reset Outcome
- BTC monitor data directories are empty again.
- BTC recovery runtime and reports are reset to a clean state with:
  - `baseLegUsd = 1`
  - `recoveryLegUsd = 2`
  - `recoveryMode = false`
  - `totalEvents = 0`
- Weather sync is still running and weather data was not cleared in this step.

## Weather Failed Orders Investigation
- Weather service logs after the V2 client change show live-order runs using `Signature type 1` successfully.
- Recent weather live-order summaries show `bought=0 failed=0 skipped=8` while current candidates are still in `waiting` state.
- Need inspect `data/weather_predictions/live-orders.json` for today's actual record statuses before re-submitting.
- `data/weather_predictions/live-orders.json` contains 8 records for `2026-04-29` failed around `00:15` with `order_version_mismatch`.
- `scripts/weather_live_order.py` treats `failed` as inactive but not retryable, so these records are skipped as existing instead of being retried.

## BTC 4h Prestart Guard
- `scripts/order_recovery.py` already retries failed limit submissions through `retryEligibleAt` and `RETRY_GAP_MS`.
- Current 4h config uses `limit-pair` with prestart entry; there is no dedicated 5-minute guard to stop new retries before event start.
- `cancel_open_limit_orders()` is globally disabled for 4h, so single-sided risk cancellation needs a separate targeted path.

## BTC 4h Missed Event Root Cause
- The missed 4h event was not caused by a rejected limit order.
- `order_recovery.py` had a single `activeEvent` slot that was used for both the current order lifecycle and old-event settlement.
- When one 4h event was still active or waiting to resolve, the next event's 1-hour prestart window was skipped because `maybe_start_current_event()` was only called when `activeEvent` was empty.
- Required behavior is event-independent: each event must get its own fixed Up/Down limit orders, while previous events can remain pending for settlement.

## Weather Rotation Simulation Requirements
- Keep the current weather live ordering and current weather page behavior unchanged.
- Add a separate simulated strategy that first models overseas weather orders around 18:00 Beijing time, then domestic weather orders around 06:00 Beijing time after overseas results are expected.
- The simulation must not place real orders or write to live weather order records.
- Domestic and overseas legs should be one combined rotation strategy for reporting, but separate from the existing live strategy.

## Weather Offset Strategy Decision
- The `-1C`, `0C`, and `+1C` weather temperature targets should be independent strategies for both reporting and live progression.
- Combining same-city offsets into one progression is not desirable because normal winning combinations may not recover the combined stake; each offset needs its own loss ladder.
- Each offset also needs independent live stake settings, so users can enable all three while giving each offset a different base stake and multiplier sequence.
- The old 10/11/12/13 threshold simulation is no longer useful for the main weather page after sustained negative performance.
