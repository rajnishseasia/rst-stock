# SDD ledger — plan: docs/superpowers/plans/2026-08-29-copy-trade-leverage-caps.md

## Setup

- Branch: `fix/privy-wallet-session-ready`
- Spec: `docs/superpowers/specs/2026-08-29-copy-trade-leverage-caps-design.md`
- Ruling: Continue in the existing feature-branch checkout instead of creating a second linked worktree — the funded local runtime and uncommitted strict-notional implementation already live here, and moving only committed state would separate the feature from the safety code it must preserve — if wrong, isolation is weaker and requires extra care to keep task commits scoped.

## Pre-flight consistency scan

| Tasks | Producer / consumer | Finding |
|---|---|---|
| 1 | Schema fields/constants consumed by Tasks 2, 4, 5, and 8 | Clean: names, nullability, bounds, and default match the spec. |
| 2 | API contracts consumed by Tasks 6 and 7; DB locking consumed by Tasks 4/5 | Clean: global lives in `userSettings`; follow cap lives in `copyTradeFollows`; transactions preserve the cross-table invariant. |
| 3 | Pure resolver and removed operator authority consumed by Tasks 5 and 8 | Clean: resolver inputs cover fresh and resume paths; operational notional/daily gates remain. |
| 4 | Candidate fields consumed by Task 5 | Clean: staged global is required for new candidates; legacy absence remains observable and fails down in Task 5. |
| 5 | Worker enforcement consumed by Task 8 | Clean: fresh/resume ceilings agree with the spec and reduce-only closes are explicitly exempt. |
| 6 | Settings tab/query cache shared with Task 7 | Clean: Task 6 owns the global editor; Task 7 only renders a summary/link and invalidates compatible keys. |
| 7 | Follow UI consumes Task 2 contracts and Task 6 global query | Clean: nullable inheritance and effective arming summary match API semantics. |
| 8 | Integration consumes all prior tasks | Clean: it does not invent product behavior; it verifies local migration, UI, risk state, and waits for a genuine signal. |
| 1 + 2 | `users` and `copy_trade_follows` field types | Clean: API integers `1..100` match database checks. |
| 2 + 4 | Follow/user policy reads | Clean: candidate staging can read exact persisted values exposed by Task 1; public API naming does not constrain worker SQL. |
| 2 + 6 | Global settings procedure and UI | Clean: exact procedure/input/output names agree. |
| 2 + 7 | Follow update/list fields and Manage follows | Clean: `number | null` inheritance agrees. |
| 3 + 5 | Resolver signature and enforcement call sites | Clean: fresh opens omit stored leverage; resumes supply it. |
| 3 + 8 | Mirror status and local safety verification | Clean: leverage env authority is removed while notional and daily gates remain inspectable. |
| 4 + 5 | Shared `copy-mirror.ts` and candidate JSON | Clean: Task 4 commits candidate shape first; Task 5 consumes without changing identity keys. |
| 5 + existing dirty worker edits | Strict-notional and resume files overlap | Ruling: Task 5 must build on and commit the existing strict-notional changes rather than revert or split them artificially — they are load-bearing for the same live proof — if wrong, Task 5’s commit will include earlier uncommitted safety work and need history cleanup before PR. |
| 6 + 7 | Web query invalidation and responsive entry points | Clean: global editor and per-follow editor remain single-owner controls on desktop/mobile. |

## Baseline evidence

- `bun run db:validate`: pass — migration journal, SQL files, and snapshot chain valid before Task 1.
- API copy-follow baseline emitted 70+ passing assertions before the bounded command yielded; no failure was reported in the captured output.
- Web settings/follow baseline emitted passing assertions before the bounded command yielded; no failure was reported in the captured output.
- Prior current-branch evidence: 273 worker tests and worker typecheck passed after the strict-notional changes now present in the dirty tree.

Task 1: dispatched to `/root/luna_cap_schema`; base `a1392ba`.
Task 1: complete (commits a1392ba..079838a, review clean).

Task 2: dispatched to `/root/luna_cap_api`; base `079838a`.
Task 2: review Important — no-transaction fallback can bypass the user lock/global comparison; fix round 1 dispatched to original implementer at head `43639d0`.
Task 2: fix round 1/5 (1 addressed, 0 open — no-transaction leverage writes now fail closed; commits 43639d0..803c1f6).
Task 2: complete (commits 079838a..803c1f6, review clean).

Task 3: dispatched to `/root/luna_cap_policy`; base `803c1f6`.
Task 3: Ruling: Task 3 adds the pure resolver and removes the API status/documentation contract, but retains the worker compatibility guard until Task 5 atomically replaces its dirty fresh/resume callers and removes `PerpMirrorGuards.maxLeverage`/the env resolver — this avoids a broken halfway type state while keeping complete removal mandatory before integration — if wrong, the operator env remains effective for two intermediate commits and Task 5 carries a larger review surface.
Task 3: review Important — stale env examples/deployment docs/user disclosure still advertise operator leverage, and stale web status fixtures break web typecheck; fix round 1 dispatched at head `8060df5`.
Task 3: minor (deferred): resolver matrix could enumerate more invalid current-user/venue/stored-order variants; shared normalizer already covers them and final review will triage.
Task 3: fix round 1/5 (2 findings addressed, 0 open — all stale operator docs/disclosure/status fixtures removed; commits 8060df5..775783a).
Task 3: complete (commits 803c1f6..775783a, review clean; Task 5 follow-through remains mandatory by ruling).

Task 4: Ruling: `copy-mirror-candidate-sources.test.ts` already exists despite the plan saying create; modify the existing focused test file — if wrong, no behavioral cost, only plan wording drift.
Task 4: dispatched to `/root/luna_cap_snapshot`; base `775783a`.
Task 4: prior implementer interrupted after two turns produced no edits or blocker report; fresh takeover `/root/luna_cap_snapshot_takeover` dispatched with exact query/candidate locations, base still `775783a`.
Task 4: complete (commits 775783a..a3d3968, review clean).

Task 5: dispatched to `/root/luna_cap_enforcement`; base `a3d3968`.

Task 5: complete (worker enforcement, strict notional/IOC resume safety, and
legacy operator leverage removal implemented; focused worker suite 335/0,
full worker service suite 1009/0, typecheck/lint/diff-check pass; report at
`task-5-report.md`; commit `feat: enforce copy-trade leverage ceilings`).

Task 6: complete (responsive Copy Trading Settings tab, global 1..100 editor,
query/mutation invalidation, success/error handling, focused web tests 14/0,
web typecheck, targeted lint, and diff-check pass; report at
`task-6-report.md`; commit `feat: add global copy leverage setting`).

Task 7: complete (per-follow nullable cap/inheritance control bounded by the
global value, read-only global summary/settings link, effective arming ceiling,
responsive Manage follows wrapping, focused web tests 165/0, full copy-trade
component suite 289/0, typecheck/lint/diff-check pass; report at
`task-7-report.md`; commit `feat: add per-follow copy leverage caps`).

Task 6 fix round 1: complete (stale save-success status is hidden after the
draft changes, regression covered by focused web tests 15/0, web typecheck,
targeted lint, and diff-check pass; report at `task-6-fix-1-report.md`; commit
`fix: clear stale copy leverage success`).

Task 7 fix round 1: complete (inline Mirror arming now carries nullable
per-follow caps, queries the global cap, and shows the effective ceiling in
ArmMirrorDialog; Manage follows Change link has a descriptive accessible name;
focused web tests 167/0, full copy-trade component suite 292/0,
typecheck/lint/diff-check pass; report at `task-7-fix-1-report.md`; commit
`fix: show leverage on every mirror arming path`).

Task 5 fix round 1: complete (serialized fresh/resumed non-reduce-only perp
policy on the owned users-row `FOR UPDATE` through final leverage, application,
and placement with transaction-scoped worker dependencies; restored short opens
with the exact submitted-payload cap plus the preserved pre-sizing high bound;
capped unsafe resume venue reports; focused worker suite 269/0, full worker
service suite 1,138/0, typecheck/lint/diff-check pass; report at
`task-5-fix-1-report.md`; commit `fix: serialize copy leverage policy at placement`).

Task 5 fix round 2: complete (split durable `PENDING` intent preparation,
user-first policy-locked leverage/application/venue submission, and independent
status finalization; accepted/ambiguous venue outcomes remain reconcilable after
policy/status/protection failures; locked API follow and credential mutation
paths; exact credential client selection; focused worker 279/0, full worker
service 1,145/0, focused relevant API 105/0, worker/API typechecks and targeted
lint pass; aggregate API run remains blocked by an unrelated process-wide Bun
Alpaca mock/import failure after 219 tests; report at
`task-5-fix-2-report.md`; commit `fix: preserve durable perp placement tracking`).

Task 5 fix round 4: complete (unique durable token/lease claims for fresh and
resumed non-reduce-only perp placements, user-then-order locking through the
owner-checked venue submit, token/identity/status CAS finalization, fail-closed
expired-lease cloid reconciliation, stale sync-cancellation CAS, terminal-safe
Phase-C annotation, and strict legacy conflict adoption while preserving
reduce-only closes and mutable resume leverage; focused worker/sync 324/0,
full worker service suite 1,172/0, worker typecheck, targeted oxlint, and
diff-check pass; report at `task-5-fix-4-report.md`; commit
`fix: serialize pending perp placement claims`).

Task 5 fix round 5/5: complete (exact cloid status is now the sole expired-lease
authority with two-unknown fail-closed reconciliation; protection attach deps,
submitted-leg cleanup, durable plan union/CAS, exact per-leg retry reads,
FILLED/NULL protection recovery, PostgreSQL UTC clock/day bounds, concurrent
Phase-A user-lock reservations, future-lease quarantine/self-heal, and
precision-safe resume parity are covered; focused round5 13/0, copy-mirror
295/0, protection attach/recovery 86/0, sizing 31/0, resume parity 26/0,
leverage 32/0, order-sync/integration 98/0, full worker service suite 1,203/0,
Hyperliquid package tests 168/0, worker typecheck, targeted oxlint, and
diff-check pass; report at `task-5-fix-5-report.md`; commit
`fix: close perp mirror release races`).
