# Leaderboard Keyset Scaling Plan

## Goal

Bound database and application allocation during users-leaderboard computation without changing full-history FIFO P&L semantics.

## Approach

- Read the social-trade/order join in deterministic keyset pages ordered by social timestamp, social row ID, and order row ID.
- Feed rows into a pure online FIFO accumulator that retains open lots and aggregate closed-lot statistics instead of every joined row and event object.
- Preserve pre-window opens, close-time window attribution, long/short separation, option multipliers, and broker-order deduplication.
- Keep X-caller ranking unchanged.

## Verification

- Prove opens and closes split across pages reconstruct correctly.
- Prove duplicate broker rows split across pages are counted once.
- Compare the online result with the legacy full-batch implementation on mixed long/short fixtures.
- Run leaderboard tests, API typecheck, and diff validation.

No schema or production migration is required.
