# Cold Verification Report: RST-001

- **Verdict:** REJECT
- **Reviewed commit:** `398c29817060263e189f49a4daaaef1531a2a8b0`
- **Base:** `c2e98ec7ed263c7a6a12a810f790a6c40aad0818`
- **Mode:** Strict, cold verifier; round 1
- **Scope:** Hyperliquid weighted REST admission and delivery ordering in the assigned commit. No source/test edits or production/live operations were performed during verification.

The implementation establishes weighted admission, close priority, a background reserve, abort removal, and per-follower delivery ordering. Acceptance is blocked because the scheduler does not preserve FIFO among equal-priority requests: a later, lighter close can pass an earlier close that does not currently fit, allowing the earlier request to starve. The same scheduler is used for RST-002 wallet closes, so this shared blocker is recorded in both reports. A separate test gap remains around timeout wakeups and cleanup.

## Findings

### RST-001-F1 — Blocking: equal-priority FIFO is violated

`packages/hyperliquid/src/client.ts:228` sorts by priority and sequence, but `:235` searches for the first *fitting* waiter anywhere in the highest-priority class and `:241` removes that waiter. If the queue head is a close of weight 201 while current usage is 900/1100, a later close of weight 1 is admitted first. Sustained small same-class requests can keep passing the head. This fails the explicit FIFO-within-priority contract and can delay protective work. Existing priority tests (`packages/hyperliquid/src/client.test.ts:196`, `:227`) assert close-before-open behavior, but do not queue a non-fitting close ahead of a fitting close.

**Required correction:** preserve sequence order within each priority. Only admit the head of the highest-priority class; if it cannot fit, wait for capacity or its abort/timeout, without admitting later same-class waiters. Add a deterministic fake-clock regression with a heavy close at the head and a lighter close behind it; assert the second cannot execute first and both eventually drain in FIFO order.

### RST-001-F2 — Coverage gap: timeout and wake-timer cleanup are not verified

Queued abort removal is implemented at `packages/hyperliquid/src/client.ts:186` and `:192`; the wake timer is clamped to at least 1 ms at `:250` and calls `pump` at `:251`. Tests abort queued requests (`packages/hyperliquid/src/client.test.ts:149` and `:240`) and advance a fake clock by one 60-second window (`:162`, `:256`), but do not exercise `AbortSignal.timeout()` while queued or assert that wake timers are cancelled/drained across repeated queue changes. No timer leak is demonstrated, but the requested timeout/no-leak behavior is not established by the tests.

**Required correction:** add deterministic queued-timeout and repeated-wakeup tests. Assert the timed-out waiter rejects, is never sent, abort listeners are detached through settlement, and no stale wake timer continues firing after the queue drains.

## Scheduler And TDD Evidence

| Requirement | Result | Evidence |
|---|---|---|
| Weighted cap and priority budgets | PASS | `packages/hyperliquid/src/client.ts:159` rejects invalid/over-budget requests; exact usage assertions at `packages/hyperliquid/src/client.test.ts:157`, `:186`, `:216`, `:237`, and `:259` would fail if the tested budgets/weight accounting admitted above the cap. |
| Close/protection reserve over ordinary opens and background reads | PASS | `packages/hyperliquid/src/client.test.ts:167` and `:227` would fail if close priority were downgraded or lower-priority reads/opens consumed the reserve. |
| Priority classification for closes | PASS | The exchange action is inspected by `packages/hyperliquid/src/client.ts:110`; expected close-first order at `packages/hyperliquid/src/client.test.ts:190` and `:258` would fail if close classification were wrong. |
| FIFO within priority | FAIL | `packages/hyperliquid/src/client.ts:235` bypasses a non-fitting head; no equal-priority FIFO regression exists. See F1. |
| Abort cancellation | PASS for cancellation; cleanup coverage incomplete | Tests assert queued abort rejection and non-admission at `packages/hyperliquid/src/client.test.ts:149` and `:240`; they would fail if an aborted waiter were sent or left pending, but do not inspect listener/timer cleanup. |
| No busy-loop | PASS by implementation inspection | `packages/hyperliquid/src/client.ts:250` clamps wake delay to at least 1 ms, and `:221` cancels the previous timer before rescheduling. Repeated-wakeup behavior is not directly stress-tested (F2). |
| No starvation | FAIL | `packages/hyperliquid/src/client.ts:235` permits later same-priority requests to pass an unfit head; see F1. |
| Timeout abort and wake-timer cleanup | FAIL for coverage | Timer wakeup exists at `packages/hyperliquid/src/client.ts:251`; queued-timeout and drained-timer assertions are absent, as detailed in F2. |
| No false cross-process guarantee | PASS | `packages/hyperliquid/src/client.ts:292` explicitly says state is process-local and separate processes do not share it. |
| Tests exercise transport behavior without live network | PASS | Fake `fetch` captures requests at `packages/hyperliquid/src/client.test.ts:70`; priority tests call the production transport at `:141`. |

## Strict Checklist

| Checklist item | Result | Evidence / N/A reason |
|---|---|---|
| Money-loss: wrong account | N/A | Scheduler only admits the unchanged Hyperliquid transport request; it does not select an account (`packages/hyperliquid/src/client.ts:292`, `:307`). |
| Money-loss: size | N/A | No trade sizing is performed; `packages/hyperliquid/src/client.ts:260` estimates REST request weight only. |
| Money-loss: side | N/A | No side/position decision is changed; this diff classifies traffic priority, not order intent (`packages/hyperliquid/src/client.ts:110`). |
| Money-loss: leverage | N/A | No leverage selection or validation is in the scheduler path (`packages/hyperliquid/src/client.ts:146`). |
| Money-loss: consent | N/A | No consent state is read or changed by REST admission (`packages/hyperliquid/src/client.ts:153`). |
| Money-loss: attribution | N/A | No follower/source attribution is performed by the scheduler (`packages/hyperliquid/src/client.ts:146`). |
| Parity: stocks and perps | N/A | This change is limited to Hyperliquid REST transport; no stock path is changed (`packages/hyperliquid/src/client.ts:296`). |
| Parity: entry behavior | N/A | Entry decisions are unchanged; only request admission is modified (`packages/hyperliquid/src/client.ts:307`). |
| Parity: exit behavior | N/A | Exit execution is unchanged; request priority is the only exit-related behavior (`packages/hyperliquid/src/client.ts:110`). |
| Boundaries: empty state | N/A | Scheduler does not consume source or delivery result sets (`packages/hyperliquid/src/client.ts:146`). |
| Boundaries: malformed state | N/A | No business-state parsing occurs here; request weight validation is separately guarded at `packages/hyperliquid/src/client.ts:159`. |
| Boundaries: missing state | N/A | Scheduler does not read persisted mirror records (`packages/hyperliquid/src/client.ts:146`). |
| Boundaries: stale state | N/A | Source and delivery staleness are outside the transport scheduler (`packages/hyperliquid/src/client.ts:146`). |
| Boundaries: partial state | N/A | Scheduler does not write delivery/checkpoint state (`packages/hyperliquid/src/client.ts:146`). |
| Duplication: replay | N/A | Admission does not create or deduplicate source events (`packages/hyperliquid/src/client.ts:146`); RST-002 replay evidence is audited separately. |
| Duplication: retries | N/A | The scheduler neither retries nor reconciles exchange writes (`packages/hyperliquid/src/client.ts:307`). |
| Duplication: reconciliation | N/A | No reconciliation logic is modified by this transport-only path (`packages/hyperliquid/src/client.ts:296`). |
| Duplication: competing workers | N/A | Scheduler state is intentionally process-local, not a worker claim mechanism (`packages/hyperliquid/src/client.ts:292`). |

## Tree And Verification

The reviewed commit is exactly the requested SHA and has parent `c2e98ec7ed263c7a6a12a810f790a6c40aad0818`. Its complete base-to-commit diff contains eight owned files, 1,212 insertions and 80 deletions: `packages/hyperliquid/src/client.ts`, its test, `apps/worker/src/services/copy-mirror-delivery-order.ts`, its test, `apps/worker/src/services/copy-mirror.ts`, `apps/worker/src/services/hl-wallet-copy-poller.ts`, its test, and `apps/worker/src/services/__tests__/copy-mirror-durability.test.ts`. No schema or migration path changed. The worktree was clean before report creation; no unrelated edits were present.

- Focused brief command: 229 pass, 0 fail, 545 expect calls.
- Canonical `bun test`: 5,228 pass / 46 skip / 0 fail across 329 files. Supplied baseline: 5,165 / 40 / 0; no failing names in either result.
- `bun run check-types`: 11/11 targets successful (10 cache hits; worker target executed).
- `bun run lint`: exit 0, 23 warnings; none in changed files.
- `git diff --check` from base to reviewed commit: clean.
- Tests used fake transport/clock and did not make production or live broker calls. No live p95 or close-latency measurement was made.

The only required correction for the scheduler blocker is the FIFO fix and deterministic regression in F1. F2 requires the additional timeout/wakeup cleanup coverage before the strict scheduler verification is complete.

## Round 2 Verification

- **Verdict:** ACCEPT
- **Reviewed tree SHA:** `343153d58c8ec59a81c9fc7c305e318d74ee736a`
- **Base SHA:** `c2e98ec7ed263c7a6a12a810f790a6c40aad0818`
- **Round:** 2, strict cold verification
- **Model:** Controller launch configuration was `gpt-5.6-luna` / `max`; runtime identity was not independently introspectable by the verifier.
- **Compared with:** round-1 commit `398c29817060263e189f49a4daaaef1531a2a8b0`; correction commit `343153d58c8ec59a81c9fc7c305e318d74ee736a`

### Round-1 Findings Resolved

| Finding | Round-2 result | Current-tree evidence |
|---|---|---|
| RST-001-F1: equal-priority FIFO bypass | **RESOLVED** | `packages/hyperliquid/src/client.ts:251-263` sorts by priority then sequence, considers only `waiters[0]`, stops if that head cannot fit, and shifts only the admitted head. Regression `packages/hyperliquid/src/client.test.ts:302-333` fills usage to 1,099, queues a weight-2 close before a weight-1 close, proves neither dispatches early, then asserts `["heavy-close", "light-close"]` after capacity returns. |
| RST-001-F2: queued timeout and wake-timer cleanup coverage | **RESOLVED** | Settlement cleanup at `packages/hyperliquid/src/client.ts:170-198` clears the timeout and removes the abort listener on resolve/reject; queued timeout removes and rejects the waiter, then pumps at `:211-220`. `packages/hyperliquid/src/client.test.ts:336-380` asserts timeout rejection, no dispatch, zero tracked abort listeners, and zero timers. The staggered-capacity test at `:383-417` asserts two wakeups and no remaining/stale timer after drain. |

The accepted close-before-open/background ordering remains covered by `packages/hyperliquid/src/client.test.ts:232-260` and `:263-299`. The scheduler remains explicitly process-local (`packages/hyperliquid/src/client.ts:147-152`, `:276`); this review makes no cross-process or shared-IP guarantee. The round-1 strict checklist above is retained; its unrelated N/A classifications are unchanged by this correction.

### Round-2 Gates And Tree

- Focused four-file command: `bun test packages/hyperliquid/src/client.test.ts apps/worker/src/services/__tests__/copy-mirror-delivery-order.test.ts apps/worker/src/services/__tests__/hl-wallet-copy-poller.test.ts apps/worker/src/services/__tests__/copy-mirror-durability.test.ts` — **233 pass, 0 fail, 580 expect calls**.
- Earlier root `bun test --timeout 30000` output: 5,232 pass / 46 skip / 0 fail, 5,278 tests across 329 files, 15,514 expect calls. **Non-canonical post-typecheck duplicate discovery; not baseline evidence.** It included six ignored generated JavaScript tests under `packages/db/dist`, accounting for +51 pass, +6 skip, and +6 files relative to the clean run.
- Independent clean canonical `bun test --timeout 30000`, with `packages/db/dist` temporarily moved outside the worktree: **5,181 pass / 40 skip / 0 fail**, 5,221 tests across 323 files, 15,223 expect calls. This is +16 pass versus the brief-supplied 5,165 / 40 / 0 baseline, with no change to skips or failures. Round-2 ACCEPT stands because this clean run had zero failures.
- Generated duplicate test paths: `packages/db/dist/__tests__/canonical-ingestion.test.js`, `packages/db/dist/__tests__/copy-trade-leverage-schema.test.js`, `packages/db/dist/__tests__/leaderboard-task3.integration.test.js`, `packages/db/dist/__tests__/timestamp-key-indexes.test.js`, `packages/db/dist/connections/pool.test.js`, and `packages/db/dist/migration-compatibility.test.js`.
- Gate-ordering lesson: `check-types`/`tsc -b` can emit ignored test JavaScript into `packages/db/dist`, which a later root Bun run discovers. Run the canonical suite before build/typecheck artifact emission, or exclude/move generated `dist` while running the canonical suite. The moved directory was restored intact after this clean run.
- `bun run check-types` — **11 successful / 11 total** (all 11 cached on this run).
- `bun run lint` — exit 0, **23 warnings**, none in the changed paths and no increase from the stated warning baseline.
- `git diff --check c2e98ec7ed263c7a6a12a810f790a6c40aad0818 343153d58c8ec59a81c9fc7c305e318d74ee736a` — clean.
- The candidate diff remains exactly the eight assigned source/test paths listed above (1,692 insertions, 80 deletions); no schema or migration path. HEAD is the correction commit with round-1 commit as its parent and no later commit. Before this report append, the only worktree entries were these two authorized untracked reports. No source/test edit, production/live operation, commit, push, or agent use occurred during this verification.

No blocking scheduler finding remains for patch acceptance. The historical incident tuple and live release proof remain outstanding, not blockers: post-deployment evidence still needs four-follower p95 source-fill-to-submit under 10 seconds, close attempts under 5 seconds, and alerts for opens waiting over 10 seconds. No such operational evidence was gathered here.
