# Task 5 fix round 1: serialize copy leverage policy at placement

## Result

Fresh and resumed non-reduce-only Hyperliquid opens now acquire the exact
follower `users` row with `FOR UPDATE` inside a transaction, then re-read the
owned follow and registered Hyperliquid credential and re-check consent. The
transaction remains open through final leverage resolution, leverage
application, placement, and the transaction-scoped order/protection writes.
The lock order is user first, then plain reads of the owned follow and
credential, matching the API policy mutations. Missing, malformed, foreign,
deleted, or changed policy data fails closed. Reduce-only fresh closes and
resumed closes never enter this policy wrapper or acquire the lock.

Resume leverage-application failure now treats a venue-reported leverage as
untrusted above the effective final clamp: a valid report is persisted only
after `Math.min(reported, finalParity.leverage)`, while an invalid or absent
report leaves the effective clamp/unknown state rather than restoring an unsafe
stored value.

Short opens are enabled again. `validatePerpVenueNotional` validates the exact
venue-formatted size multiplied by the aggressive sell limit price, while the
existing conservative pre-sizing high-bound cap remains in `decidePerpMirror`.
The submitted-payload cap is intentionally distinct from an unbounded favorable
future fill price on a sell IOC. Fresh, resumed, and direct placement short
tests cover this behavior.

## TDD and verification evidence

The controller captured the expected RED suite before the production fixes:
261 passing / 5 expected failures (short payload validation, direct short
placement, fresh short open, resumed short open, and unsafe resume clamp
persistence). After the first production changes, the controller captured
263 passing / 3 stale/conflicting expectation failures; the obsolete short
rejection expectations were then replaced with exact-payload and preserved
high-bound assertions.

GREEN:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-sizing.test.ts
  269 pass, 0 fail, 599 expect() calls

bun --filter @trade-bot/worker test
  1,138 pass, 0 fail, 2,677 expect() calls across 60 files

bun --filter @trade-bot/worker typecheck
  pass

bunx oxlint apps/worker/src
  pass

git diff --check
  pass (line-ending normalization warnings only)
```

No migration, restart, push, or deployment was performed.
