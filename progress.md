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
