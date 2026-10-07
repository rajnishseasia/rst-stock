# Copy Trade Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a two-tab "Top Traders" leaderboard so a user can VET and DISCOVER traders before they blind-follow, then Follow / auto-copy any row through the EXISTING `copyTradeFollows` API. The **Users** tab ranks fellow users by reconstructed realized P&L + win rate + trade count (FIFO over shared trade events). The **X Callers** tab ranks X authors by hit rate + avg forward return + call count (a forward-return heuristic on the ticker after each call). The two metric families are NEVER blended.

> ## Metrics are directional, not audited
>
> Both tabs are deliberately approximate and MUST be labeled as such in API field names AND UI copy. **Users** metrics are APPROXIMATE and shared-trades-only (FIFO, no account-size context, excludes unfilled events + open lots) — the payload carries `approximate: true`. **X** metrics are forward-return heuristics on the ticker, NOT caller P&L — the payload carries `heuristic: true`. Present them as a way to narrow down who to research, never as a verdict.

**Architecture:** A `leaderboard` router with two procedures returning two distinct row shapes. `users` reads `social_trades` (LEFT JOIN `orders` for the fill price), FIFO-reconstructs realized P&L per `(userId, symbol)` via the pure helpers in `lib/leaderboard.ts`, anonymizes, and ranks. `xCallers` reads `signals`, derives the author, and for each call measures the ticker's forward return over a horizon using the master-Alpaca bars path (`createMasterAlpacaClient` + `getBars`), degrading to a callCount-only ranking with `needsMarketData: true` when `ALPACA_MASTER` is absent. Both wrap compute in a Redis `cachedOrLive` (users ~60s, xCallers ~15min), falling back to live compute on any Redis failure. Every row carries the SAME `FollowTarget` the feed uses (`type:"user"` keyed by `traderKey(userId)`; `type:"x_author"` keyed by `normalizeAuthorKey(author)`), so a row Follows via the existing `copyTradeFollows.follow` and matches the feed's Following filter.

**Tech Stack:** tRPC, Drizzle (PostgreSQL), Zod, React 19, Next.js, TypeScript, Tailwind CSS, shadcn/ui, Redis, Bun test runner

**Status note (already on `feat/copy-trade-phase4-leaderboard`):** the pure metric helpers (`lib/leaderboard.ts`), the `leaderboard` router (`users` + `xCallers`, caching, graceful degradation), its registration in `routers/index.ts`, and the API tests (`__tests__/leaderboard.test.ts`) are ALREADY implemented (Tasks 1–3 are largely done — **verify, don't rewrite**). The remaining NEW work is the client "Top Traders" two-tab UI (Task 4) and full verification (Task 5).

---

### Task 1: Pure metric helpers (`lib/leaderboard.ts`)

**Files:**
- Verify: `apps/api/src/lib/leaderboard.ts`
- Verify: `apps/api/src/__tests__/leaderboard.test.ts`

> **Already implemented — verify against the spec, do not rewrite.**

- [ ] **Step 1: Confirm the Users FIFO model**

`reconstructRealizedPnl(events)` FIFO-pairs sells against the oldest open buy
lots, emitting one closed lot per `(buyLot, sellSlice)`; `realizedPnl =
Σ (sellPrice − buyPrice) × lotQty`; `winRate = positiveLots / closedTrades`.
Honest exclusions: `null`-price (unfilled) events skipped; sell with no prior buy
skipped (no shorting); **leftover open buy lots NOT counted**. `aggregateUserStats`
sums P&L, re-derives win rate over ALL closed lots (lot-weighted, not a mean of
per-symbol rates), counts closed lots as `tradeCount`, takes max `lastTradeAt`.

- [ ] **Step 2: Confirm the X forward-return model**

`forwardReturnPct(entry, exit) = (exit − entry) / entry × 100`, `null` on
non-finite or `entry <= 0`. `aggregateCallerStats(returns)`: `hitRate` = fraction
of MEASURED calls that are positive; `avgForwardReturnPct` = mean over measured;
`callCount` includes UNMEASURED calls; both metrics `null` when nothing is
measurable.

- [ ] **Step 3: Run the pure tests + typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun test src/__tests__/leaderboard.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

Expected coverage: FIFO across multiple buys/sells, partial-lot matches, unfilled
skipped, sell-without-buy skipped, open lots excluded, lot-weighted aggregate win
rate; `forwardReturnPct` null cases; `aggregateCallerStats` null hit rate with no
measurable call and `callCount` including unmeasured calls.

---

### Task 2: Users leaderboard procedure (`leaderboard.users`)

**Files:**
- Verify: `apps/api/src/routers/leaderboard.ts`
- Verify/extend: `apps/api/src/__tests__/leaderboard.test.ts`

> **Already implemented — verify against the spec, do not rewrite.**

- [ ] **Step 1: Confirm the query + reconstruction**

Reads `social_trades` in the window (oldest-first), INNER JOIN `users`, LEFT JOIN
`orders` on `broker_order_id` for `executedPrice`; price falls back to
`limit_price` only when there is no fill, else `null`. Groups by `(userId,
symbol)`, runs `reconstructRealizedPnl` + `aggregateUserStats`, drops users with
zero closed lots, anonymizes via `anonymizeTrader`, sorts by `sortBy`
(`pnl` | `winRate` | `trades`) desc, slices to `limit`.

- [ ] **Step 2: Confirm identity + privacy**

Each row's `followTarget = { type: "user", key: traderKey(userId), label:
traderName }` — the SAME key the feed emits, so a row Follow matches the feed.
**The raw `userId` is never serialized.** Assert `JSON.stringify(row)` excludes the
raw id and `followTarget.key === traderKey(userId)`.

- [ ] **Step 3: Confirm the honesty flag + caching**

The procedure returns `{ rows, approximate: true }`. Compute is wrapped in
`cachedOrLive("users:{window}:{sortBy}:{limit}", 60, ...)`, which degrades to live
compute when Redis is unavailable.

- [ ] **Step 4: Typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

---

### Task 3: X-callers procedure (`leaderboard.xCallers`) + graceful degradation

**Files:**
- Verify: `apps/api/src/routers/leaderboard.ts`
- Verify/extend: `apps/api/src/__tests__/leaderboard.test.ts`

> **Already implemented — verify against the spec, do not rewrite.**

- [ ] **Step 1: Confirm the call aggregation + bounds**

Reads `signals` in the window, derives the author (`deriveAuthor` +
`cleanAuthorName`), skips "Unknown"/empty (`normalizeAuthorKey → null`), groups
calls by author key. Bounded: `MAX_CALLS_PER_AUTHOR = 50` most-recent calls per
author, `MAX_X_SYMBOLS = 60` unique tickers fetched.

- [ ] **Step 2: Confirm the forward-return measurement**

Reuses the master-Alpaca bars path: `createMasterAlpacaClient()` +
`client.getBars(symbol, "1D", limit)` (the same path as `quotes.ts
getHistoricalBars`). Per call, `computeCallForwardReturn` takes entry = first
daily close at/after the call, exit = first close at/after `callTime +
horizonDays`, then `forwardReturnPct`. `aggregateCallerStats` rolls them up; rows
sort by `sortBy` (`forwardReturn` | `hitRate` | `calls`) desc with `null` metrics
last.

- [ ] **Step 3: Confirm graceful degradation (`needsMarketData`)**

`ALPACA_MASTER_KEY`/`ALPACA_MASTER_SECRET` are present in PROD but ABSENT in local
dev. The procedure must NEVER throw:
- no master creds → `callCount`-only ranking, metrics `null`, `needsMarketData: true`;
- per-symbol fetch failure → that symbol's bars `[]`, its calls unmeasurable;
- all symbols failed → `needsMarketData: true` on the payload.

Returns `{ rows, needsMarketData, heuristic: true }`.

- [ ] **Step 4: Typecheck + degraded-path test**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun test src/__tests__/leaderboard.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/api" && bun run typecheck)
```

> **X metrics only fully verify where `ALPACA_MASTER` exists.** Tests assert the
> degraded path (callCount-only, `needsMarketData: true`, never throws). The
> forward-return NUMBERS can only be verified in prod / any env with master creds.

---

### Task 4: "Top Traders" two-tab UI (NEW)

**Files:**
- Create: `apps/web-v2/src/components/copy-trade/leaderboard-panel.tsx`
- Create: `apps/web-v2/src/components/copy-trade/__tests__/leaderboard-panel.test.ts`
- Modify: `apps/web-v2/src/app/app/page.tsx`

- [ ] **Step 1: Write the failing source-string panel tests**

Read the component source via `readFileSync(new URL("../leaderboard-panel.tsx",
import.meta.url), "utf8")` and assert `source.toContain(...)` (repo convention —
see `copy-trade-panel.test.ts`):
- queries both `trpc.leaderboard.users` and `trpc.leaderboard.xCallers`;
- renders two tabs (Users / X Callers) via `components/ui/tabs`;
- renders the Users honesty caption (reads the `approximate` flag) AND the X
  honesty caption + a market-data note when `needsMarketData` is true;
- Follows a row via `trpc.copyTradeFollows.follow` using the row's `followTarget`
  (reusing `follow-button.tsx`), and reads `trpc.copyTradeFollows.list` for
  membership keyed by `followSetKey`.

- [ ] **Step 2: Build the two-tab panel**

Use `components/ui/tabs` for Users / X Callers. Each tab has its own sort control
(`pnl|winRate|trades` for Users; `forwardReturn|hitRate|calls` for X) and a window
selector (`7d|30d|all`); X adds the horizon (default 7d). Render rows with
`avatar`, pseudonym/author `displayName`, and the tab's metrics
(`badge`/`skeleton` from `components/ui`). **Never** show a Users metric column in
the X tab or vice-versa.

- [ ] **Step 3: Wire the honesty copy (REQUIRED)**

Under the Users tab: "Approximate — reconstructed from shared trades only (FIFO).
No account-size context; excludes unfilled and open positions." Under the X tab:
"Forward-return heuristic on the ticker after each call — not the caller's
realized P&L." When the X payload has `needsMarketData: true`, show "Market data
required — full metrics compute in production" instead of zeroed numbers. A
prominent "Directional, not audited" line sits above both tabs.

- [ ] **Step 4: Follow from a row (reuse, no new API)**

For each row, render the existing `follow-button.tsx` bound to the row's
`followTarget`. Follow calls `trpc.copyTradeFollows.follow({ targetType:
followTarget.type, targetKey: followTarget.key, targetLabel: followTarget.label,
autoMirror: false })`; membership is keyed with `followSetKey(type, key)` against
`trpc.copyTradeFollows.list`; invalidate `list` on success. Do NOT expose any
`autoMirror = true` / LIVE-account control here — arming mirror stays a deliberate,
separate action.

- [ ] **Step 5: Mount the panel**

Add the leaderboard panel to `apps/web-v2/src/app/app/page.tsx` beside the existing
`CopyTradePanel` (a "Top Traders" tab/section). Keep the existing copy-trade feed
and Following view untouched.

- [ ] **Step 6: Run web tests + typecheck**

```bash
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun test src/components/copy-trade/__tests__/leaderboard-panel.test.ts)
(cd "/Users/frankciafardini/Documents/rst stocks/rst-stock-site/apps/web-v2" && bun run typecheck)
```

Expected: tests pass; TypeScript exits cleanly (web check may take 60–180s).

- [ ] **Step 7: Inspect in the browser**

```bash
bun dev:web
```

Open `http://localhost:4001/app` → Top Traders. Verify: Users tab shows ranked
pseudonyms with realized P&L / win rate / trade count and the
"approximate, shared-trades-only" caption; X Callers tab shows authors with hit
rate / avg forward return (or the "market data required" note locally, since
`ALPACA_MASTER` is absent in dev) and the "heuristic, not caller P&L" caption;
Following a row makes that trader appear in the feed's Following view.

---

### Task 5: Verification (full)

- [ ] **API:** `bun test` + `bun run typecheck` in `apps/api`.
  - Pure metric tests (FIFO reconstruction, lot-weighted aggregate win rate,
    `forwardReturnPct`, `aggregateCallerStats`) run everywhere — no DB, no broker.
  - Identity/privacy: user row `followTarget.key === traderKey(userId)` and the
    raw `userId` is absent from `JSON.stringify(row)`; X row `followTarget.key ===
    normalizeAuthorKey(author)`, Unknown authors dropped.
  - X degraded path: with no master creds, `xCallers` returns callCount-only rows,
    `needsMarketData: true`, and never throws.

- [ ] **X metrics only verify where `ALPACA_MASTER` exists.** The forward-return
  NUMBERS (hit rate, avg return) require `ALPACA_MASTER_KEY`/`ALPACA_MASTER_SECRET`
  and can only be confirmed in prod (or an env with master creds). Locally, verify
  only the graceful-degradation contract.

- [ ] **Web:** `bun test` + `bun run typecheck` in `apps/web-v2` (panel
  source-string assertions: two tabs, both procedures, the honesty captions, and
  Follow via `copyTradeFollows.follow` keyed by `followTarget`).

- [ ] **Caching:** with Redis down, both procedures still return (live compute,
  warn logged); with Redis up, a repeat identical call hits the cache within the
  TTL (users ~60s, xCallers ~15min).

- [ ] **Browser:** Top Traders renders both tabs with the correct, NON-blended
  metrics and honesty copy; Following a row surfaces the trader in the feed's
  Following view (proving the leaderboard `followTarget` matches the feed).

> **No DB schema change.** The leaderboard reads existing tables (`social_trades`,
> `orders`, `signals`) and writes follows through the existing `copy_trade_follows`
> table (created in Phase 3). No `db:push` is required for this phase.

---

### Phase 2 (later): Politician leaderboard tab

The `FollowTarget` contract reserves `type: "politician"`. Once the Phase-2
`politician_trades` source is live, a third leaderboard tab can rank politicians
on a disclosure-appropriate metric (its OWN metric family — never blended with
users or X callers) and reuse the same `followTarget` → `copyTradeFollows.follow`
path unchanged.
