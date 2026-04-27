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
