# Copy-Trade Leverage Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each user a global maximum leverage for automatic Hyperliquid perp copies plus an optional stricter maximum per follow, while leaving manual perp leverage unchanged and preserving the existing notional and daily safety gates.

**Architecture:** Persist both user-owned ceilings in PostgreSQL, expose the global ceiling through `userSettings` and the follow ceiling through `copyTradeFollows`, snapshot both when a copy candidate is staged, and re-read current values immediately before fresh or resumed opens. The worker applies the minimum of source, staged policy, current policy, persisted-order leverage on resume, and live venue maximum; reduce-only closes bypass leverage policy.

**Tech Stack:** TypeScript, Bun, Drizzle ORM/PostgreSQL, tRPC/Zod, React 19, Next.js 16, TanStack Query, Hyperliquid SDK.

**Spec:** `docs/superpowers/specs/2026-08-29-copy-trade-leverage-caps-design.md`

## Global Constraints

- Automatic-copy leverage belongs to the user: one required global cap and one optional lower per-follow cap.
- Manual perp trade ticket behavior and its per-order leverage input must not change.
- The operator environment must not select user leverage. Keep the existing master, live, perps, and mainnet gates. The `$10.55` notional and one-order-per-day limits used by this plan belong only to the funded proof account's configuration; they are not production constants.
- For a new open, effective leverage is the integer minimum of source leverage (missing/invalid becomes `1`), staged global cap, staged optional follow cap, current global cap, current optional follow cap, and current Hyperliquid asset maximum.
- For a resumed open, persisted `orders.leverage` is one more immutable ceiling. No queued or persisted intent may increase leverage after staging.
- Lowering a user-owned cap applies to already-queued opens; raising one affects only subsequently discovered candidates.
- A missing legacy staged global cap fails down to `1`; a missing staged follow cap means inheritance; an invalid non-null cap fails down to `1`.
- Reduce-only closes are not blocked or resized by leverage caps.
- All mutations must be ownership-scoped. Global lowering and per-follow writes must lock the user row so `follow.perpMaxLeverage <= user.copyPerpMaxLeverage` remains true under concurrency.
- Preserve all pre-existing dirty strict-notional edits in worker and web configuration files. Do not revert or rewrite unrelated user/agent work.
- Do not deploy, push, merge, or place a manual order. For this local-mainnet proof, configure the funded account for at most `$10.55` notional, at most `2x`, and at most one mirrored order per day.

---

## Task 1: Persist the global and per-follow leverage caps

**Files:**

- Modify: `packages/types/src/index.ts`
- Modify: `packages/db/src/schema/users.ts`
- Modify: `packages/db/src/schema/copy-trade-follows.ts`
- Create: `packages/db/src/__tests__/copy-trade-leverage-schema.test.ts`
- Create through Drizzle: `packages/db/migrations/0038_copy_trade_leverage_caps.sql`
- Modify through Drizzle: `packages/db/migrations/meta/_journal.json`
- Create through Drizzle: `packages/db/migrations/meta/0038_snapshot.json`

**Interfaces:**

```ts
export const COPY_PERP_MAX_LEVERAGE_MIN = 1;
export const COPY_PERP_MAX_LEVERAGE_MAX = 100;

users.copyPerpMaxLeverage: integer("copy_perp_max_leverage").notNull().default(1)
copyTradeFollows.perpMaxLeverage: integer("perp_max_leverage")
```

- [ ] Add a failing `copy-trade-leverage-schema.test.ts` that uses Drizzle table metadata to prove `users.copyPerpMaxLeverage` is non-null with default `1`, `copyTradeFollows.perpMaxLeverage` is nullable, and both columns use integer SQL types.
- [ ] Run `bun test packages/db/src/__tests__/copy-trade-leverage-schema.test.ts` and record the expected missing-field failure.
- [ ] Add the shared bounds constants and both Drizzle fields.
- [ ] Run `bun --filter @trade-bot/db db:generate --name copy_trade_leverage_caps` from the repository root so Drizzle produces the exact `0038_copy_trade_leverage_caps.sql` journal tag and snapshot rather than hand-editing metadata.
- [ ] Review the generated SQL and add database `CHECK` constraints for `1..100` to both columns if Drizzle does not generate them from schema declarations.
- [ ] Run `bun run db:validate` and `bun --filter @trade-bot/db check-types`.
- [ ] Run `git diff --check` and commit only Task 1 files with message `feat: persist copy-trade leverage caps`.

## Task 2: Add transactional global and per-follow API contracts

**Files:**

- Modify: `apps/api/src/routers/user-settings.ts`
- Modify: `apps/api/src/routers/copy-trade-follows.ts`
- Create: `apps/api/src/__tests__/user-settings-copy-trade.test.ts`
- Modify: `apps/api/src/__tests__/copy-trade-follows.test.ts`

**Interfaces:**

```ts
userSettings.getCopyPerpLeverageSettings.query() => {
  globalPerpMaxLeverage: number;
}

userSettings.setCopyPerpMaxLeverage.mutate({
  globalPerpMaxLeverage: z.number().int().min(1).max(100),
}) => { globalPerpMaxLeverage: number }

copyTradeFollows.follow/update input addition:
perpMaxLeverage: z.number().int().min(1).max(100).nullable().optional()

copyTradeFollows list/follow/update output addition:
perpMaxLeverage: number | null
```

- [ ] Write failing API tests for default global `1`, setting a valid global value, rejecting `0` and `101`, clamping stored follow caps when global is lowered, follow inheritance with `null`, rejecting a follow cap above global, and returning the new field from list/follow/update.
- [ ] Add a concurrency regression test whose mocked transaction verifies global and follow writes lock the owned user row with `FOR UPDATE` before validation/update.
- [ ] Run `bun test apps/api/src/__tests__/user-settings-copy-trade.test.ts apps/api/src/__tests__/copy-trade-follows.test.ts` and record the expected failures.
- [ ] Implement the user-settings getter and setter. The setter transaction locks the authenticated user row, updates `users.copyPerpMaxLeverage`, and clamps that user’s non-null higher `copyTradeFollows.perpMaxLeverage` values before commit.
- [ ] Extend `toFollowItem`, pagination/list queries, follow creation, and update responses with nullable `perpMaxLeverage`.
- [ ] Make follow creation and update transactionally lock the authenticated user row before comparing a non-null requested follow cap to the current global cap. Keep all existing ownership and credential checks.
- [ ] Run both focused tests, `bun --filter @trade-bot/api typecheck`, and `git diff --check`.
- [ ] Commit only Task 2 files with message `feat: expose copy-trade leverage settings`.

## Task 3: Centralize effective leverage policy and remove operator leverage authority

**Files:**

- Create: `apps/worker/src/services/copy-mirror-perp-leverage.ts`
- Create: `apps/worker/src/services/__tests__/copy-mirror-perp-leverage.test.ts`
- Modify: `apps/worker/src/services/copy-mirror-perp-decisions.ts`
- Modify: `apps/api/src/lib/copy-mirror.ts`
- Modify: `apps/api/src/__tests__/copy-trade-mirror-status.test.ts`
- Modify: `docs/deployment/worker-railway.md`

**Interfaces:**

```ts
export function resolveEffectivePerpLeverage(input: {
  sourceLeverage: unknown;
  stagedUserMaxLeverage: unknown;
  stagedFollowMaxLeverage: unknown | null | undefined;
  currentUserMaxLeverage: unknown;
  currentFollowMaxLeverage: unknown | null | undefined;
  venueMaxLeverage: unknown;
  storedOrderLeverage?: unknown;
}): number;
```

- [ ] Write table-driven failing tests for valid minima, fractional/zero/negative/NaN inputs, missing source, missing legacy staged user cap, inherited null follow caps, invalid non-null follow caps, venue ceilings, and persisted-order ceilings.
- [ ] Run `bun test apps/worker/src/services/__tests__/copy-mirror-perp-leverage.test.ts` and record the expected missing-module failure.
- [ ] Implement one pure normalizer/resolver. Normalize every required input to a positive integer or `1`; treat null/undefined follow values as no extra ceiling; treat invalid non-null follow values as `1`.
- [ ] Remove `COPY_TRADE_AUTOMIRROR_PERPS_MAX_LEVERAGE` from `PerpMirrorGuards`, worker exposure decisions, API mirror-status response/enablement logic, deployment documentation, and tests. Do not remove the other operational safety gates.
- [ ] Run the focused worker test, `bun test apps/api/src/__tests__/copy-trade-mirror-status.test.ts`, both package typechecks, and `git diff --check`.
- [ ] Commit only Task 3 files with message `refactor: make copy leverage user controlled`.

## Task 4: Snapshot user policy on every durable perp candidate

**Files:**

- Modify: `apps/worker/src/services/copy-mirror.ts`
- Modify: `apps/worker/src/services/copy-mirror-candidate-sources.ts`
- Modify: `apps/worker/src/services/__tests__/copy-mirror.test.ts`
- Create: `apps/worker/src/services/__tests__/copy-mirror-candidate-sources.test.ts`

**Interfaces:**

```ts
type MirrorSourceCandidate = {
  // existing fields
  perpLeverage?: number;
  perpUserMaxLeverage?: number;
  perpFollowMaxLeverage?: number | null;
};
```

- [ ] Add failing tests proving both user-trade and X-perp discovery queries include the follower’s global cap and the exact follow’s optional cap, and serialize both into candidate JSON.
- [ ] Add a legacy-candidate test proving absent `perpUserMaxLeverage` is retained as absent for the policy resolver to fail down to `1`, not silently filled from current policy.
- [ ] Run the focused worker tests and record the expected failures.
- [ ] Extend candidate discovery projections and mappings for both source paths. Keep `perpLeverage` as the leader/source leverage.
- [ ] Ensure durable staging serializes the two new fields without changing candidate identity/idempotency keys.
- [ ] Run focused tests, `bun --filter @trade-bot/worker typecheck`, and `git diff --check`.
- [ ] Commit only Task 4 files with message `feat: snapshot copy leverage policy`.

## Task 5: Enforce staged plus current policy for fresh and resumed opens

**Files:**

- Modify: `apps/worker/src/services/copy-mirror-perp-execution.ts`
- Modify: `apps/worker/src/services/copy-mirror-perp-resume-parity.ts`
- Modify: `apps/worker/src/services/copy-mirror.ts`
- Modify: `apps/worker/src/services/__tests__/copy-mirror-perp-sizing.test.ts`
- Modify: `apps/worker/src/services/__tests__/copy-mirror-perp-resume-parity.test.ts`
- Modify: `apps/worker/src/services/__tests__/copy-mirror.test.ts`

- [ ] Write failing fresh-open tests showing: global `2` caps source `10`; follow `1` caps global `2`; lowering current global/follow below staged wins; raising current values above staged does not raise the queued trade; live venue max wins; unreadable/foreign/deleted follow policy fails closed before venue placement.
- [ ] Write failing resume tests showing stored order leverage is a ceiling, a lower current cap clamps and persists before `updateLeverage`, and higher current/staged values never raise the stored order.
- [ ] Preserve explicit tests that reduce-only closes proceed without reading or applying leverage ceilings.
- [ ] Run the focused worker tests and record the expected failures.
- [ ] Re-read the exact owned follow and user row immediately before each non-reduce-only fresh placement or resume. Use one consistent observation/transaction with the existing consent, arming, and credential validation.
- [ ] Call `resolveEffectivePerpLeverage` with source, staged, current, live venue, and on resume stored-order inputs. Record the final value in `orders.leverage` and structured non-secret decision logs.
- [ ] Preserve IOC/limit, existing-position, idempotency, and reduce-only behavior. Preserve the proof account's configured `$10.55` notional and one-order-per-day limits without turning them into production constants.
- [ ] Run all affected worker tests, `bun --filter @trade-bot/worker typecheck`, and `git diff --check`.
- [ ] Commit only Task 5 files with message `feat: enforce copy-trade leverage ceilings`.

## Task 6: Add the global Copy Trading settings UI

**Files:**

- Modify: `apps/web-v2/src/lib/settings-tabs.ts`
- Modify: `apps/web-v2/src/lib/settings-tabs.test.ts`
- Modify: `apps/web-v2/src/app/settings/page.tsx`
- Create: `apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.tsx`
- Create: `apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.test.tsx`

- [ ] Add failing tab-resolver tests for `?tab=copy-trading`, existing tabs, and invalid fallback.
- [ ] Add failing component tests for loading default/current value, integer bounds `1..100`, explanatory copy, disabled save while unchanged/pending, success state, and API error state.
- [ ] Run the focused web tests and record the expected failures.
- [ ] Add a responsive fifth `Copy Trading` Settings tab without changing the existing Perps wallet tab.
- [ ] Implement the global editor against `userSettings.getCopyPerpLeverageSettings` and `setCopyPerpMaxLeverage`; invalidate both global settings and follow-list queries after success.
- [ ] Render: `Copy-trading maximum leverage` and `Applies to every automatic perp copy. Leaders and markets can use less; no follow can use more.`
- [ ] Run focused tests, `bun --filter @trade-bot/web typecheck`, and `git diff --check`.
- [ ] Commit only Task 6 files with message `feat: add global copy leverage setting`.

## Task 7: Add per-follow caps and arming visibility on desktop and mobile

**Files:**

- Modify: `apps/web-v2/src/components/copy-trade/manage-follows.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/use-manage-follows.ts`
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-follow.test.ts`
- Modify: `apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts`

- [ ] Add failing tests for the global summary/link, `Use global (Nx)` inheritance, integer follow cap bounded by the global value, saving `null` or a number, API errors, and existing follow controls remaining reachable.
- [ ] Add failing arming-confirmation tests showing the effective ceiling `min(global, optional follow)` next to size/destination/exits.
- [ ] Run focused web tests and record the expected failures.
- [ ] Extend Manage follows state/query mapping with `perpMaxLeverage` and the global settings query.
- [ ] Render a read-only global summary plus link to `/settings?t=copy-trading`; do not create a second global editor.
- [ ] Add a per-follow control that remains visible before a Hyperliquid credential is selected, supports inheritance via `null`, and saves through `copyTradeFollows.update`.
- [ ] Keep the dropdown reachable and usable at narrow mobile widths without horizontal clipping or removing existing controls.
- [ ] Run focused tests, `bun --filter @trade-bot/web typecheck`, and `git diff --check`.
- [ ] Commit only Task 7 files with message `feat: add per-follow copy leverage caps`.

## Task 8: Integrate, migrate locally, and prove the guarded path

**Files:**

- Modify only when a real integration defect requires it; add a regression test in the owning package before each fix.
- Update: this plan’s SDD ledger and test evidence reports in `.superpowers/sdd/2026-08-29-copy-trade-leverage-caps/`.

- [ ] Run `bun run db:validate` and apply migration `0038` to the local `tradebot_privy_test_20260829` database with the existing local worker environment.
- [ ] Set the funded local user’s `users.copy_perp_max_leverage` to `2`; leave the four armed follows at `NULL` so they inherit `2` unless a specific test temporarily exercises a lower follow cap.
- [ ] Restart local API and worker so compiled schema and policy paths are active; keep web on `http://localhost:5100`.
- [ ] Run `bun test apps/api/src/__tests__/user-settings-copy-trade.test.ts apps/api/src/__tests__/copy-trade-follows.test.ts apps/api/src/__tests__/copy-trade-mirror-status.test.ts`.
- [ ] Run `bun test apps/worker/src/services/__tests__/copy-mirror-perp-leverage.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-sizing.test.ts apps/worker/src/services/__tests__/copy-mirror-perp-resume-parity.test.ts apps/worker/src/services/__tests__/copy-mirror.test.ts`.
- [ ] Run the focused web tests from Tasks 6 and 7, then run all three package typechecks and `git diff --check`.
- [ ] Use only `browser:control-in-app-browser` to verify desktop and narrow mobile layouts at `http://localhost:5100/settings?t=copy-trading` and Manage follows; do not use Playwright.
- [ ] Query the local API/DB to prove the funded user global cap is `2`, each active follow inherits it, and the worker respects the proof account's configured `$10.55` notional and one-order/day limits without an operator leverage cap.
- [ ] Continue read-only source, database, and official Hyperliquid watchers until a genuinely new followed perp entry occurs. If one occurs, verify exactly one local-mainnet mirrored order/fill under the proof account's configured `$10.55` notional and daily-entry limits, applied leverage at most `2x`, and durable source/delivery/order audit linkage. Do not synthesize or manually submit a trade.
- [ ] Commit any test-backed integration fix separately. Do not push, deploy, merge, or open a PR until local/live proof is complete and the user requests the PR step.

## Final Verification and Review

- [ ] Run a whole-branch code review against the merge base, explicitly checking manual-trade isolation, transaction locking, legacy-candidate fail-down, resume non-escalation, reduce-only exemptions, secrets hygiene, and preservation of strict-notional edits.
- [ ] Resolve every Critical/Important finding through the SDD fix loop and scoped re-review.
- [ ] Run `bun run db:validate`, all affected package tests, all three package typechecks, and `git diff --check` one final time.
- [ ] Record the exact local migration, browser verification, watcher cutoff, source signal, delivery, order, fill, notional, and leverage evidence. If no genuinely new leader entry occurs during the implementation window, report the implementation as verified by tests/local state but keep the live-trade goal active and monitoring rather than claiming an on-chain proof.
