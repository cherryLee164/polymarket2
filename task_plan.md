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
