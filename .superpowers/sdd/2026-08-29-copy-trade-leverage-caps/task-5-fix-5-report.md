# Task 5 fix round 5: close perp mirror release races

## Result

The frozen Task 5 patch is complete. Hyperliquid perp opens now have one
authoritative, fail-closed cloid handoff; protection attachment records and
cleans up every submitted deterministic leg; daily reservations and lease
decisions use PostgreSQL time; and protection plans/status transitions preserve
leg ids under row locks and compare-and-set races. Resume quantity parity now
refuses a value-changing precision conversion while allowing trailing-zero
normalization.

## TDD evidence

The required narrow tests were run before the fixes:

```text
bun test apps/worker/src/services/__tests__/copy-mirror-round5.test.ts
  4 pass, 1 fail, 12 expect() calls
  RED: aggregate-only absence returned `accepted` instead of `not-submitted/reconcile`.

bun test apps/worker/src/services/__tests__/copy-mirror-perp-protection-attach.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-protection.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-protection-wiring.test.ts
  55 pass, 12 fail, 118 expect() calls
  RED: protection attach hit `ReferenceError: deps is not defined`.
```

## Diagnostics closure

1. Critical exact-status authority: `copy-mirror.ts` now uses only
   `orderStatusByClientOrderId`/`orderStatus`; unavailable, transport-error, or
   malformed exact responses fail closed, and an expired lease permits POST only
   after two valid `unknownOid` probes plus the exact claim/status recheck.
   Aggregate fills/open-orders are never absence authority. Covered by the
   round-5 aggregate-only, unavailable, and malformed tests.
2. Critical protection attach crash: `deps` is threaded into `attachOnce`, so
   plan checkpoints and attached/unprotected writes use the injected dependency.
   The attach/recovery suite is green, including FILLED + NULL protection
   recovery in `copy-mirror.test.ts`.
3. Critical stale-leg cleanup: each success, transport failure, and
   partial/rejected `setPositionTpSl` result returns submitted leg ids. A
   cancelled record race cancels only ids submitted by that stale attempt and
   never rewrites the cancelled status. Covered by “cancels every leg submitted
   by a stale attach whose record lost to cancellation”.
4. Critical daily-one clock: placement/lease metadata reads PostgreSQL
   `CURRENT_TIMESTAMP`; daily windows are UTC lower-inclusive/upper-exclusive
   SQL expressions independent of session timezone. The concurrent Phase-A test
   monkeypatches the worker clock to the prior day, supplies a later DB UTC day,
   and proves one user-row-locked reservation wins.
5. Important plan merge/CAS: production protection persistence runs inside an
   exact opening-row `FOR UPDATE` transaction, unions deterministic leg ids, and
   uses `RETURNING` plus an authoritative reread on a lost CAS. Cancellation
   does the same and treats only an already-cancelled row as benign.
6. Important trigger retry: persisted plans exact-probe every deterministic leg
   before using aggregate data; missing/malformed readers fail closed, while an
   exact found leg suppresses repost despite a lagging aggregate snapshot.
7. Important future lease: `perpPlacementLeaseState` distinguishes active,
   bounded-future, and quarantined-future markers. Preparation and
   Hyperliquid order-sync use DB time; quarantined markers are exact-CAS cleared
   before reclaim, with a production-path self-heal regression.
8. Important resume precision: current venue precision canonicalizes the stored
   decimal and compares its numeric value. `0.125` at precision 2 is refused;
   `0.120` to `0.12` is accepted without resizing.

Required gaps are covered by the new round-5 tests (ratio below-floor skip,
exact oversized-ratio cap, concurrent reservations, all-age PENDING/SYNCING
stable ranking, DB UTC skew, exact-status fail-closed behavior) and existing
focused regressions for phased $10.55 long/short placement, real reduce-only
two-attempt retry, strict fresh reduce-only identity, claim-held resume
protection immutability, and durable FILLED/NULL protection recovery.

## Verification evidence

Focused suites, final source state:

```text
bun test apps/worker/src/services/__tests__/copy-mirror-round5.test.ts
  13 pass, 0 fail, 40 expect() calls; 13 tests across 1 file
bun test apps/worker/src/services/__tests__/copy-mirror.test.ts
  295 pass, 0 fail, 716 expect() calls; 295 tests across 1 file
bun test apps/worker/src/services/__tests__/copy-mirror-perp-protection-attach.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-protection.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-protection-wiring.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-protection-partial-close.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-close-resume.test.ts
  86 pass, 0 fail, 185 expect() calls; 86 tests across 5 files
bun test apps/worker/src/services/__tests__/copy-mirror-perp-sizing.test.ts apps/worker/src/services/__tests__/copy-mirror-resume-dollar-cap.test.ts apps/worker/src/services/__tests__/copy-mirror-resume-sell-clamp.test.ts
  31 pass, 0 fail, 75 expect() calls; 31 tests across 3 files
bun test apps/worker/src/services/__tests__/copy-mirror-perp-resume-parity.test.ts
  26 pass, 0 fail, 60 expect() calls; 26 tests across 1 file
bun test apps/worker/src/services/__tests__/copy-mirror-perp-leverage.test.ts
  32 pass, 0 fail, 32 expect() calls; 32 tests across 1 file
bun test apps/worker/src/services/__tests__/hyperliquid-order-sync.test.ts apps/worker/src/services/__tests__/copy-mirror-integration.test.ts apps/worker/src/services/__tests__/order-sync.test.ts apps/worker/src/services/__tests__/order-sync-status-map.test.ts apps/worker/src/services/__tests__/order-sync-replaced-chain.test.ts
  98 pass, 0 fail, 293 expect() calls; 98 tests across 5 files
bun test apps/worker/src
  1203 pass, 0 fail, 2898 expect() calls; 1203 tests across 60 files
bun test packages/hyperliquid/src/client.test.ts packages/hyperliquid/src/config.test.ts packages/hyperliquid/src/coin.test.ts packages/hyperliquid/src/privy.test.ts
  168 pass, 0 fail, 424 expect() calls; 168 tests across 4 files
```

Static checks:

```text
bun run --cwd apps/worker typecheck                         pass
bunx oxlint <Task 5 worker/Hyperliquid source and tests>   pass
git diff --check                                            pass (line-ending warnings only)
```

No database, service, browser, migration, live-order, deployment, or push
operation was run. The pre-existing unrelated edits in
`apps/web-v2/next-config.test.ts`, `apps/web-v2/next-env.d.ts`, and
`apps/web-v2/next.config.ts` were not changed and remain unstaged. The
`readDatabaseNow` helper retains a compatibility process-clock fallback only
for legacy test doubles without `execute`; production `WorkerPoolDb` uses the
PostgreSQL clock path.

Requested commit message: `fix: close perp mirror release races`.
