# Task 5 report: enforce staged and current copy-trade leverage policy

## Result

Fresh and resumed non-reduce-only Hyperliquid copy opens now resolve leverage
from the minimum of the source, staged user/follow policy, current user/follow
policy, the live venue maximum, and (for resumes) the stored order leverage.
The worker reads the exact owned follow, user policy, and credential together
before consent and placement; unreadable, missing, malformed, deleted, or
foreign policy data fails closed. Reduce-only closes remain exempt from policy
reads and leverage ceilings. Effective leverage is persisted on the order and
included in non-secret structured placement logs.

The legacy operator leverage authority and compatibility resolver path were
removed, including `PerpMirrorGuards.maxLeverage`,
`resolvePerpsMaxLeverage`, and the old `resolvePerpLeverage` call shape. The
existing strict `$10.55` notional, Limit+IOC open payload, daily cap, existing
position, idempotency, and resume safety changes were preserved.

## TDD evidence

Captured RED before implementation:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts -t "caps a staged 10x source"
  failed: received 10x; expected 2x

bun test apps/worker/src/services/__tests__/copy-mirror-perp-resume-parity.test.ts -t "staged and current user policy"
  failed: all three cases returned leverage-unconfirmed
```

GREEN evidence:

```text
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-resume-parity.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-sizing.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-close-resume.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-close-fill-shortfall.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-protection-wiring.test.ts
  335 pass, 0 fail, 732 expect

bun test apps/worker/src/services/__tests__
  1,009 pass, 0 fail, 2,362 expect (51 files)
```

The controller also independently verified the focused Task 5 selection at
318 pass and 0 fail.

## Validation

```text
bun --filter @trade-bot/worker typecheck
  pass (controller verification)

bunx oxlint apps/worker/src
  pass

git diff --check
  pass (line-ending normalization warnings only)
```

Static worker source/test verification found no references to
`resolvePerpsMaxLeverage`, `resolvePerpLeverage`,
`COPY_TRADE_AUTOMIRROR_PERPS_MAX_LEVERAGE`, `operatorMaxLeverage`,
`assetMaxLeverage`, or `guards.maxLeverage`. Remaining `maxLeverage` test
fields are live Hyperliquid asset metadata, not worker guard authority.

## Integration concern

The local runtime must apply migration 0036 before restart because the current
local database did not yet contain `perp_max_leverage`. No migration or service
restart was performed as part of this task.
