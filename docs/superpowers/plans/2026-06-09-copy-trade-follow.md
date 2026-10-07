# Copy Trade Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user FOLLOW specific traders/authors from the copy-trade feed via a privacy-preserving NON-PII key. One `copy_trade_follows` row drives two behaviors off a single `auto_mirror` flag: `false` → a filtered **Following** view (user still clicks Copy); `true` → a background worker auto-places the sized order on the follower's account.

> **Auto-mirror is OFF by default and must be deliberately enabled.** Every follow row defaults `auto_mirror = false`. The worker that places real orders is INERT unless `COPY_TRADE_AUTOMIRROR_ENABLED === "true"`, and refuses LIVE accounts unless `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"`. **No order is placed during this build.**

**Architecture:** Each `CopyTradeItem` carries a stable, NON-PII `followTarget { type, key, label }` — `x_author` keyed by `normalizeAuthorKey`, `user` keyed by `traderKey(userId)` (the same one-way FNV hash `anonymizeTrader` uses; the raw id never leaves the server). A `copyTradeFollows` router (list/follow/unfollow/update, scoped to `ctx.userId`) persists follows in `copy_trade_follows`. `copyTrade.feed` gains `followedOnly` to filter the unified feed to the caller's follow set. Auto-mirror sizing/cap/idempotency live as pure functions in `apps/api/src/lib/copy-mirror.ts`; a flag-gated `apps/worker` poller consumes them but stays inert.

**Tech Stack:** tRPC, Drizzle (PostgreSQL), Zod, React 19, Next.js, TypeScript, Tailwind CSS, shadcn/ui, Bun test runner

**Status note (already on `feat/copy-trade-phase3-follow`):** the schema, the `followTarget` key model, the follows router, the `followedOnly` feed filter, and the pure mirror helpers + their tests are already implemented (Tasks 1–4 are largely done — verify, don't rewrite). The remaining new work is the panel Follow/Following UI (Task 5) and the inert auto-mirror worker service (Task 6).

---

### Task 1: `copy_trade_follows` table

**Files:**
- Create: `packages/db/src/schema/copy-trade-follows.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Define the table**

Mirror the column style of `social-trades.ts` / `signals.ts`. Columns:
`id` (uuid pk), `follower_user_id` (text → `users.id`, cascade), `target_type`
(text: `"x_author" | "user" | "politician"`), `target_key` (text, NON-PII),
`target_label` (text), `sizing_mode` (text default `"pct"`), `sizing_value`
(`numeric(12,2)` default `"5"`), `auto_mirror` (boolean default **`false`**),
`created_at` (timestamptz default now). Indexes on `follower_user_id` and on
`(target_type, target_key)`; a `unique (follower_user_id, target_type,
target_key)` so Follow is an upsert.

- [ ] **Step 2: Re-export and typecheck**

Add `export * from "./copy-trade-follows.js";` to
`packages/db/src/schema/index.ts`. Do NOT run `db:generate` (broken repo-wide);
the table is applied later with `bun run db:push`.

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

---

### Task 2: `followTarget` key model on `CopyTradeItem`

**Files:**
- Modify: `apps/api/src/routers/social.ts`
- Modify: `apps/api/src/routers/copy-trade.ts`
- Modify: `apps/api/src/__tests__/copy-trade-follows.test.ts`

- [ ] **Step 1: Write the failing pure-logic tests**

In `copy-trade-follows.test.ts`, assert:
- `traderKey(userId)` is deterministic, never equals the raw id, and matches the
  `anonymizeTrader` avatar seed (`traderImage` contains `seed=${traderKey(id)}`).
- `normalizeAuthorKey` lowercases/trims/collapses whitespace and returns `null`
  for empty/`"Unknown"`.
- `followSetKey(type, key)` → `"type|key"`.
- `mapSignalToItem` sets `followTarget { type: "x_author", key, label }` from the
  normalized author and `null` for an Unknown author.
- `mapUserTradeToItem` sets `followTarget { type: "user", key: traderKey(userId),
  label: traderName }` and `JSON.stringify(item)` does NOT contain the raw id.

- [ ] **Step 2: Add `traderKey` to `social.ts`**

Export `traderKey(userId) = stableHash(userId).toString(36)` — the SAME FNV hash
`anonymizeTrader` uses. The raw `userId` stays server-only.

- [ ] **Step 3: Extend the `CopyTradeItem` contract**

Add `FollowTargetType`, `FollowTarget`, and `followTarget: FollowTarget | null`
to `CopyTradeItem`. Add pure exports `normalizeAuthorKey(name): string | null`
and `followSetKey(type, key): string`. Populate `followTarget` in
`mapSignalToItem` (x_author, `null` for Unknown) and `mapUserTradeToItem`
(`type: "user"`, `key: traderKey(row.userId)`). All relative imports use `.js`.

- [ ] **Step 4: Run the test and typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun test src/__tests__/copy-trade-follows.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

---

### Task 3: Following view (`followedOnly`) in `copyTrade.feed`

**Files:**
- Modify: `apps/api/src/routers/copy-trade.ts`

- [ ] **Step 1: Add the `followedOnly` input**

Add `followedOnly: z.boolean().default(false)` to the `feed` input.

- [ ] **Step 2: Load the follow set and filter**

When `followedOnly` is true, select `(target_type, target_key)` from
`copy_trade_follows` where `follower_user_id = ctx.userId`, build a
`Set<followSetKey>`, and filter each source's mapped items to those whose
`followTarget` is non-null and in the set — BEFORE the merge, so paging and the
`(timestamp, id)` cursor are unaffected. Wrap the follow-set read in try/catch:
a missing table (pre-`db:push`) degrades to an empty Following feed, logged via
`createProductionLogger`, never a 500.

- [ ] **Step 3: Typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

---

### Task 4: Follow router + pure mirror helpers

**Files:**
- Create: `apps/api/src/routers/copy-trade-follows.ts`
- Modify: `apps/api/src/routers/index.ts`
- Create: `apps/api/src/lib/copy-mirror.ts`
- Modify: `apps/api/src/__tests__/copy-trade-follows.test.ts`

- [ ] **Step 1: Write the failing mirror-helper tests**

Import from `../lib/copy-mirror.js` and assert:
- `computeMirrorQty` sizes pct/usd, floors to whole shares, and returns `0` for
  `price <= 0`, a sub-one-share target, or any non-finite/negative input.
- `mirrorIdempotencyKey({ followerUserId, sourceItemId })` is deterministic and
  unique per `(follower, source item)`.
- `withinDailyCap` / `withinDollarCap` are inclusive/exclusive at the boundary
  and **fail closed** (return `false`) for invalid cap/amount.

- [ ] **Step 2: Implement the pure mirror helpers**

In `apps/api/src/lib/copy-mirror.ts`, export `computeMirrorQty`,
`mirrorIdempotencyKey`, `withinDailyCap`, `withinDollarCap`, and the defaults
`DEFAULT_MIRROR_DAILY_CAP = 20`, `DEFAULT_MIRROR_MAX_ORDER_DOLLARS = 1000`. No DB,
no broker, no side effects — pure value computation only. Document at the top
that the consuming worker stays inert unless `COPY_TRADE_AUTOMIRROR_ENABLED ===
"true"` (and refuses LIVE unless `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"`).

- [ ] **Step 3: Implement the `copyTradeFollows` router**

`list`, `follow` (idempotent upsert via `onConflictDoUpdate` on the unique
constraint), `unfollow` (returns `{ removed }`), `update` (partial sizing /
`auto_mirror`). Every procedure scoped to `ctx.userId`; only the NON-PII
`targetKey` is accepted (never the raw user id). Write `sizing_value` via
`toFixed(2)`, surface it to the client as a number. Register `copyTradeFollows`
in `apps/api/src/routers/index.ts`.

- [ ] **Step 4: Run tests and typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun test src/__tests__/copy-trade-follows.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

---

### Task 5: Panel Follow buttons + Following toggle (NEW)

**Files:**
- Modify: `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx`
- Modify: `apps/web-v2/src/components/copy-trade/__tests__/copy-trade-panel.test.ts`
- Modify: `apps/web-v2/src/app/app/page.tsx`

- [ ] **Step 1: Write the failing source-string panel tests**

Read the component source via `readFileSync(new URL("../copy-trade-panel.tsx",
import.meta.url), "utf8")` and assert `source.toContain(...)`:
- queries `trpc.copyTradeFollows.list` and calls `trpc.copyTradeFollows.follow` /
  `unfollow`.
- passes `followedOnly` to `trpc.copyTrade.feed`.
- renders a Following / All toggle and a per-row Follow control bound to
  `item.followTarget` (only when `followTarget` is non-null).

- [ ] **Step 2: Add the Following toggle**

Add a "Following" view toggle beside the source-filter tabs. When active, pass
`followedOnly: true` to the existing `trpc.copyTrade.feed.useInfiniteQuery`. Keep
the persisted source filter and sizing controls untouched.

- [ ] **Step 3: Add the per-row Follow button**

For each item with a non-null `followTarget`, render a Follow / Following toggle.
Load the user's follows via `trpc.copyTradeFollows.list` and key membership with
`followSetKey(type, key)`. Follow calls `trpc.copyTradeFollows.follow` with the
item's `followTarget` plus the current sizing rule and `autoMirror: false`;
unfollow calls `trpc.copyTradeFollows.unfollow`. Invalidate `list` on success.
Do NOT expose any `auto_mirror = true` control wired to a LIVE account in this UI
pass — arming mirror is a deliberate, separate action.

- [ ] **Step 4: Keep Copy unchanged**

The Phase-1 Copy button (client-sized `{ symbol, side, qty, signalId? }` via
`onCopy`) is unchanged. Following/Follow are additive — Copy never auto-submits.

- [ ] **Step 5: Run web tests and typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun test src/components/copy-trade/__tests__/copy-trade-panel.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun run typecheck)
```

Expected: tests pass; TypeScript exits cleanly (web check may take 60–180s).

- [ ] **Step 6: Inspect in the browser**

```bash
bun dev:web
```

Open `http://localhost:4001/app` and verify: Follow a trader from a row;
switch to the Following view and confirm it is filtered to followed targets;
unfollow and confirm the row leaves the Following view. Copy still prefills the
trade form and never submits.

---

### Task 6: Auto-mirror worker — flag-gated and INERT (NEW)

**Files:**
- Create: `apps/worker/src/services/copy-mirror-poller.ts`
- Modify: `apps/worker/src/index.ts`

> **This task wires the real-order path but ships it disabled. Do NOT place any
> order during the build. The acceptance check is that, with the flag unset, the
> service logs "disabled" and performs no DB read and no order.**

- [ ] **Step 1: Gate the whole service on the env flag**

In `copy-mirror-poller.ts`, on `start()`, if `process.env.COPY_TRADE_AUTOMIRROR_ENABLED
!== "true"`, log via `createProductionLogger` that auto-mirror is disabled and
return immediately — no interval, no DB read, no order. Default state is inert.

- [ ] **Step 2: Implement the (gated) poll loop**

When enabled, follow the `OrderSyncPoller` interval pattern. Per tick:
find new source trades since the last cursor; match `auto_mirror = true` follows
by `followTarget`; resolve the follower's Alpaca credentials and **skip LIVE
accounts** unless `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"` (use
`isPaperAccount` from `apps/api/src/lib/alpaca.ts`); size with `computeMirrorQty`
from the follower's own `positions.account` buying power + a live price; enforce
`withinDailyCap` / `withinDollarCap` (defaults `20` / `$1000`, env-overridable,
fail closed); derive `client_order_id = mirrorIdempotencyKey({ followerUserId,
sourceItemId })` and submit through the same Alpaca path `orders.submit` uses so
the existing `clientOrderId` idempotency prevents a double-mirror; audit-log
every decision and submission.

- [ ] **Step 3: Register the poller (inert)**

In `apps/worker/src/index.ts`, instantiate and `start()` the poller alongside
`DiscordPoller` / `OrderSyncPoller`. Because of the Step-1 gate it stays inert
unless the flag is set.

- [ ] **Step 4: Typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/worker" && bun run typecheck)
```

---

### Verification (full)

- **API:** `bun test` + `bun run typecheck` in `apps/api` (pure mirror helpers,
  `traderKey`, `normalizeAuthorKey`, `followSetKey`, and `followTarget` mapping
  with the raw id absent from the JSON).
- **Web:** `bun test` + `bun run typecheck` in `apps/web-v2` (panel source-string
  assertions for Follow/Following + `followedOnly`).
- **Worker:** `bun run typecheck` in `apps/worker`.
- **DB:** point `DATABASE_URL_DIRECT` at the target DB and run `bun run db:push`
  to create `copy_trade_follows` (review the proposed statements; `db:generate`
  is broken repo-wide). Confirm the table exists before enabling the feature.

  - [ ] Production schema update required: point `DATABASE_URL_DIRECT` at Supabase
    and run `bun run db:push` (review the proposed statements) before enabling.
  - [ ] Verify `copy_trade_follows` exists in the DB before enabling auto-mirror.

- **Safely enable auto-mirror on PAPER (test only):**
  1. Link a PAPER Alpaca credential.
  2. Set `COPY_TRADE_AUTOMIRROR_ENABLED=true`; leave
     `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE` UNSET (default paper-only).
  3. Set one follow to `auto_mirror = true` (via `copyTradeFollows.update`).
  4. Confirm the worker mirrors exactly one order per source trade (idempotent
     `client_order_id`), stays under the daily/dollar caps, and REFUSES any LIVE
     account.
  5. Unset `COPY_TRADE_AUTOMIRROR_ENABLED` to return the worker to inert.

> **Reminder:** auto-mirror is OFF by default. It requires
> `COPY_TRADE_AUTOMIRROR_ENABLED=true` to do anything, and a second explicit
> `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE=true` to ever touch a LIVE account. Never
> enable LIVE mirroring as part of testing.

---

### Phase 2 (later): Politician follow targets

The `followTarget` contract already reserves `type: "politician"`. Once the
Phase-2 `politician_trades` source is live, populate a politician `followTarget`
in `mapPoliticianTradeToItem`, and the existing follows router, `followedOnly`
filter, and (flag-gated) auto-mirror worker work unchanged.
