# Task Plan

## Goal
Rewrite BTC auto-order logic only, leave weather unchanged, reset BTC to a clean `$1` start, keep the existing `2`-loss recovery rule, and keep BTC auto-order stopped until explicitly restarted.

## Status
- [completed] Inspect current BTC 4h runtime, trigger flow, and launcher behavior
- [completed] Replace old single-side trigger behavior with dual-side independent fill targets
- [completed] Align trigger entry with official amount-aware market price estimation
- [completed] Reset BTC runtime, reports, logs, monitor data, and stale locks
- [pending] Restart BTC automation only after explicit confirmation

## Decisions
- BTC 4h trigger logic now allows both `up` and `down` to fill independently inside the same event.
- Base target remains `$1` per side; recovery target remains `$2` per side after `2` losing events.
- Recovery orders are no longer intentionally split into `1 + 1`; they place the remaining target directly.
- Weather processes and weather data remain untouched.

## Current Task: Weather Failed Orders
- [completed] Inspect today's weather live order records and logs.
- [completed] Verify on-chain/open-order/position state for each failed candidate.
- [completed] Re-submit only candidates that are still active, not filled, and not already open.
- [completed] Restart services if code/client changes are needed.

## Current Task: BTC 4h Prestart Guard
- [completed] Inspect limit-pair retry and prestart entry state machine.
- [completed] Add a 5-minute prestart guard that stops new orders and cancels single-sided open limits.
- [completed] Verify syntax and restart the 4h recovery worker.

## Current Task: BTC 4h Independent Events
- [completed] Identify why the next 4h event was not opened during its prestart window.
- [completed] Split active ordering from old-event settlement with `pendingResolutionEvents`.
- [completed] Verify syntax and simulate active-to-pending handoff.
- [completed] Restart the recovery launcher and confirm the runtime uses the new state machine.

## Current Task: Weather Simulation Slots
- [completed] Fix threshold simulation slot attribution so 11:00, 12:00, and 13:00 do not collapse into 10:00.
- [completed] Return a full 10/11/12/13 x 85/88/90/92/95/97 strategy grid.
- [completed] Exclude simulated No prices above 99c and resync stored simulation records.
- [completed] Verify with Node snapshot and ESLint.

## Current Task: BTC 4h Rewrite
- [completed] Delete old 4h recovery/state-machine implementation from `scripts/order_recovery.py`.
- [completed] Replace it with a fixed 4h limit-order worker only.
- [completed] Remove 4h PnL/recovery/settlement/half-window/single-side-guard behavior from the running path.
- [completed] Restart the worker and confirm new runtime/reports are reset.
