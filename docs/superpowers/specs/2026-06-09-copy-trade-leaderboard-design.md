# Copy Trade Leaderboard Design

## Goal

Give a user a "Top Traders" leaderboard so they can **vet and discover** traders
to follow — instead of blind-following a name off the live feed. The leaderboard
ranks two distinct populations in two tabs, then lets the user **Follow /
auto-copy** any row through the SAME `copyTradeFollows` API the feed uses, so a
follow from the ranking behaves exactly like a follow from a feed row.

Two tabs, two DIFFERENT metric families — **never blended**, because the
underlying data and what each number *means* are not comparable:

- **Users tab** — fellow users ranked by RECONSTRUCTED realized P&L + win rate +
  trade count. We only have shared trade EVENTS (`social_trades` buy/sell + qty,
  joined to `orders.executedPrice` for the fill). We FIFO-pair buys against sells
  per `(userId, symbol)` into closed lots to derive realized P&L and win rate.
  Honest and **fully local-testable** — no external data required.
- **X Callers tab** — X authors ranked by HIT RATE + AVG FORWARD RETURN over a
  horizon (default 7d) + call count. For each signal `(author, symbol, callTime)`
  we measure the % move of the ticker from the call to the horizon using master
  Alpaca historical bars. This is a **signal-quality heuristic**, NOT the
  caller's realized P&L.

> ## Metrics are directional, not audited
>
> **Nothing on this leaderboard is audited truth.** Both tabs are deliberately
> approximate and must be labeled as such in the API field names AND the UI copy:
>
> - **Users metrics are APPROXIMATE and shared-trades-only.** They are
>   reconstructed by FIFO-pairing the trade events a user chose to share. They
>   have **no account-size context** (a $40 gain means nothing without knowing the
>   book), exclude **unfilled** events (null fill price) and **open lots** (a buy
>   with no matching sell), and reflect only trades the user shared — not their
>   real, complete P&L. The `users` payload carries `approximate: true`.
> - **X metrics are forward-return heuristics, not caller P&L.** They measure how
>   the *ticker* moved after a call, not what the caller actually made (no entry,
>   no size, no exit discipline). The `xCallers` payload carries
>   `heuristic: true`.
>
> Treat these as a way to *narrow down who to research*, not a verdict. The UI
> must say so plainly next to each tab.

This builds directly on the Phase-1/Phase-3 copy-trade work: the same
privacy-preserving anonymization (`social.ts`), the same `FollowTarget` contract
(`copy-trade.ts`), the same follow persistence (`copyTradeFollows`), and the same
master-Alpaca historical-bars path (`quotes.ts getHistoricalBars`).

## Design

### Two tabs, two metric families (the central rule)

A user's reconstructed realized P&L and an X author's forward-return hit rate are
**not the same kind of number** and must never share a column or a sort. The
router exposes them as two separate procedures (`leaderboard.users`,
`leaderboard.xCallers`) returning two distinct row shapes, and the UI renders
them in two separate tabs with their own honesty caption.

### Identity reuse — leaderboard rows match the feed (NON-NEGOTIABLE)

The whole point is "vet, then Follow." A Follow from a leaderboard row MUST land
on the same follow target as a Follow from the feed, or the Following filter and
auto-mirror won't recognize it. So every row carries the **exact** `FollowTarget`
shape `copy-trade.ts` emits, built from the **same** helpers:

- **Users tab** → `followTarget: { type: "user", key: traderKey(userId), label:
  traderName }`. `traderKey` and `anonymizeTrader` are imported from `social.ts`,
  so the row's pseudonym, avatar, and follow key are byte-for-byte what the feed
  shows for that user. **The raw `userId` is never serialized** — only the
  pseudonym, avatar, and the one-way `traderKey` hash leave the server.
- **X Callers tab** → `followTarget: { type: "x_author", key:
  normalizeAuthorKey(author), label: author }`. `normalizeAuthorKey` is imported
  from `copy-trade.ts`, and the author is derived from the signal's metadata with
  the same TweetShift-suffix cleaning the feed uses (`cleanAuthorName`). "Unknown"
  / empty authors normalize to `null` and are dropped (nothing followable).

Because both keys are derived by the same functions the feed uses, a row's
`followTarget` can be handed straight to `copyTradeFollows.follow(...)` and the
resulting follow row matches `copyTrade.feed`'s `followedOnly` filter — no new
follow API, no key translation.

### Users leaderboard — reconstructed realized P&L (FIFO)

We do not have account balances or position snapshots for other users; we have
the trade **events** they shared. So we reconstruct an APPROXIMATE realized P&L:

1. Read `social_trades` in the window, oldest-first, LEFT JOIN `orders` on
   `broker_order_id` to pick up the executed fill price (`orders.executedPrice`).
   Fall back to `limit_price` only when there is no fill; price stays `null` when
   neither exists.
2. Group events by `(userId, symbol)`, preserving chronological order.
3. Per group, `reconstructRealizedPnl(events)` (pure, in `lib/leaderboard.ts`)
   FIFO-pairs sells against the oldest open buy lots, emitting one **closed lot**
   per `(buyLot, sellSlice)`:
   - `realizedPnl = Σ (sellPrice − buyPrice) × lotQty` over closed lots.
   - `winRate = closedLotsWithPositivePnl / closedTrades`, in `[0,1]`.
   - **Honest exclusions** (so we never overstate): events with a `null` price
     (unfilled) are skipped; a sell with no prior open buy is skipped (no shorting
     assumption); **leftover open buy lots are NOT counted** (open/unrealized).
4. `aggregateUserStats(...)` combines a user's per-symbol reconstructions into
   per-user totals: `realizedPnl` summed; `winRate` re-derived over **all** closed
   lots (so a 40-trade symbol outweighs a 1-trade symbol — not a naive mean of
   per-symbol rates); `tradeCount` = total **closed lots** (not raw events);
   `lastTradeAt` = newest event across symbols.
5. Anonymize via `anonymizeTrader(userId)`, drop users with zero closed lots
   (nothing to rank), sort by `sortBy` (`pnl` | `winRate` | `trades`) desc, slice
   to `limit`.

**Row shape (`UserLeaderboardRow`):** `followTarget` (`type:"user"`),
`displayName`, `avatar`, `realizedPnl`, `winRate` (`[0,1]`), `tradeCount` (closed
lots), `lastTradeAt`. The procedure returns `{ rows, approximate: true }` — the
`approximate` flag is the contract-level honesty marker the UI reads to render the
"shared-trades-only, FIFO" caveat.

> **Users caveat (must surface in UI):** approximate, shared-trades-only, no
> account-size context, excludes unfilled events and open lots. `tradeCount` is
> closed lots, not orders. Long-only reconstruction.

### X Callers leaderboard — forward-return / hit-rate heuristic

For each signal we measure how the *ticker* moved after the call — a signal
quality proxy, explicitly **not** the caller's P&L:

1. Read `signals` in the window, derive the author (`deriveAuthor` +
   `cleanAuthorName`, mirroring the feed), skip "Unknown"/empty authors
   (`normalizeAuthorKey → null`). Group calls by author key; each call keeps its
   `symbol` + `callTime`.
2. Bound the work: rank only the busiest authors, keep at most
   `MAX_CALLS_PER_AUTHOR = 50` most-recent calls per author, and fetch bars for at
   most `MAX_X_SYMBOLS = 60` unique tickers — a degenerate signal table can't fan
   out into thousands of Alpaca fetches.
3. For each call, `computeCallForwardReturn(bars, callTime, horizonDays)`: entry =
   first daily close at/after the call; exit = first daily close at/after
   `callTime + horizonDays`; `forwardReturnPct = (exit − entry) / entry × 100`.
   Returns `null` (unmeasurable) when either anchor or the bars are missing.
4. `aggregateCallerStats(returns)`: `hitRate` = fraction of **measured** calls
   with a positive return; `avgForwardReturnPct` = mean over measured calls;
   `callCount` = ALL calls (measured or not). If **no** call could be measured,
   `hitRate` and `avg` are `null` — we claim nothing.
5. Sort by `sortBy` (`forwardReturn` | `hitRate` | `calls`) desc, with `null`
   metrics sorting **last** so authors with real numbers rank first. Slice to
   `limit`.

**Row shape (`XCallerLeaderboardRow`):** `followTarget` (`type:"x_author"`),
`displayName`, `avatar`, `hitRate` (`[0,1]` or `null`), `avgForwardReturnPct`
(`number` or `null`), `callCount`, `needsMarketData` (`true` when metrics are
`null` because bars were unavailable). The procedure returns `{ rows,
needsMarketData, heuristic: true }`.

> **X caveat (must surface in UI):** forward-return heuristic on the ticker after
> the call — NOT realized caller P&L. No entry/size/exit. `callCount` includes
> unmeasured calls. Label it a signal-quality signal, never a track record.

### Market-data dependency + graceful degradation (`needsMarketData`)

The X tab reuses the **master-Alpaca historical bars path** from `quotes.ts`
(`createMasterAlpacaClient()` + `client.getBars(symbol, "1D", limit)`), which
requires `ALPACA_MASTER_KEY` / `ALPACA_MASTER_SECRET`. Those are present in
**prod** but **absent in local dev**. The X metrics therefore compute in prod and
must **degrade gracefully** everywhere else — never throw:

- **No master creds** (checked before any fetch): return authors ranked by
  `callCount` only, with `hitRate`/`avgForwardReturnPct = null` and
  `needsMarketData: true`.
- **Per-symbol fetch failure**: that symbol's bars degrade to `[]`, its calls
  become unmeasurable (counted, excluded from metrics) — one bad ticker can't sink
  the board.
- **All symbols failed**: `needsMarketData: true` on the payload (bars
  unavailable), rows still returned with `null` metrics.

The UI reads `needsMarketData` and shows a "live in production / market data
required" note instead of empty/zeroed metrics. The Users tab has **no** market
data dependency and is fully testable locally.

### Caching + TTLs

The Users aggregate scans the whole window broadly, and the X bars are expensive
(dozens of Alpaca round-trips). Both procedures wrap their compute in a
`cachedOrLive(cacheKey, ttl, compute)` helper over Redis (`@trade-bot/redis`
`getRedisClient`), keyed by the full input tuple:

- **Users** — key `users:{window}:{sortBy}:{limit}`, **TTL ~60s**.
- **X Callers** — key `xCallers:{window}:{horizonDays}:{sortBy}:{limit}`,
  **TTL ~15min** (bars move slowly relative to fetch cost).

Caching **degrades to live compute** whenever Redis is unavailable, the cached
JSON fails to parse, or a read/write throws — a cache outage logs a warning and
recomputes, never failing the request. A cache-write failure is non-fatal (the
freshly computed value is still returned).

### Follow from a row — reuse `copyTradeFollows` (no new API)

A row's Follow control calls the existing
`copyTradeFollows.follow({ targetType, targetKey, targetLabel?, sizingMode?,
sizingValue?, autoMirror? })` with the row's `followTarget` (`targetType =
followTarget.type`, `targetKey = followTarget.key`, `targetLabel =
followTarget.label`). Because the key model is identical to the feed:

- the resulting `copy_trade_follows` row matches `copyTrade.feed`'s `followedOnly`
  filter (the trader shows in the Following view), and
- the flag-gated auto-mirror worker matches it by the same `followTarget`.

`autoMirror` defaults to `false` from the leaderboard exactly as from the feed —
**arming auto-mirror is a separate, deliberate action and is not wired to a LIVE
account from this UI**. Membership is keyed with `followSetKey(type, key)` against
`copyTradeFollows.list`, reusing the same `follow-button.tsx` / `manage-follows.tsx`
components the feed already ships.

### Reuse

- `social.ts` → `anonymizeTrader`, `traderKey` (same FNV/seed + one-way hash).
- `copy-trade.ts` → `FollowTarget`, `normalizeAuthorKey`, `followSetKey`, the
  TweetShift author cleaning.
- `copy-trade-follows.ts` → `copyTradeFollows.follow` / `list` (the row Follow
  path; no new follow API).
- `quotes.ts getHistoricalBars` → the master-Alpaca bars path
  (`createMasterAlpacaClient` + `getBars`) for X forward returns.
- `packages/redis` → `getRedisClient` for the `cachedOrLive` wrapper.
- `lib/leaderboard.ts` → the pure metric core (`reconstructRealizedPnl`,
  `aggregateUserStats`, `forwardReturnPct`, `aggregateCallerStats`), DB/broker-free
  and unit-tested.
- UI primitives → `components/ui` (`tabs`, `badge`, `avatar`, `skeleton`,
  `button`) plus the existing `follow-button.tsx`.

## Scope

- **In scope:** the two-tab `leaderboard` router (`users`, `xCallers`); the pure
  metric helpers in `lib/leaderboard.ts`; the FIFO reconstructed-realized-P&L /
  win-rate model and its APPROXIMATE/shared-trades-only honesty flag
  (`approximate`); the X forward-return / hit-rate heuristic and its `heuristic` /
  `needsMarketData` flags; the master-Alpaca bars dependency with graceful
  degradation; Redis caching with TTLs and live-compute fallback; and the
  client "Top Traders" two-tab UI whose rows Follow via the existing
  `copyTradeFollows`.
- **Out of scope:** any audited/verified P&L; short-selling and options P&L in the
  Users reconstruction (long-only by design); account-size normalization; the
  Phase-2 politician population (the `FollowTarget` contract reserves
  `"politician"`, but there is no leaderboard tab for it yet); changing the
  auto-mirror worker (a leaderboard Follow reuses the existing path unchanged).

## Verification

- **API:** `bun test` + `bun run typecheck` in `apps/api`.
  - **Pure metric tests** (`reconstructRealizedPnl`, `aggregateUserStats`,
    `forwardReturnPct`, `aggregateCallerStats`, `computeCallForwardReturn`) run
    everywhere — no DB, no broker. Cover: FIFO pairing across multiple
    buys/sells; partial-lot matches; unfilled (`null` price) skipped; sell with no
    prior buy skipped; open lots excluded; aggregate win rate weighted by closed
    lots; `forwardReturnPct` null on `entry <= 0` / non-finite; `aggregateCallerStats`
    null hit rate when no call is measurable; `callCount` includes unmeasured calls.
  - **Identity tests:** a user row's `followTarget.key === traderKey(userId)` and
    `JSON.stringify(row)` does NOT contain the raw `userId`; an X row's
    `followTarget.key === normalizeAuthorKey(author)` and `null`/Unknown authors
    are dropped.
- **X metrics only verify where `ALPACA_MASTER` exists.** Locally (and in CI
  without master creds) the `xCallers` procedure returns `needsMarketData: true`
  with `null` metrics and `callCount`-only ranking; the **forward-return numbers
  themselves can only be verified in prod** (or any env with
  `ALPACA_MASTER_KEY`/`ALPACA_MASTER_SECRET`). Assert the degraded path
  (callCount-only, `needsMarketData: true`, never throws) in tests; assert the
  measured path manually in prod.
- **Web:** `bun test` + `bun run typecheck` in `apps/web-v2`. Source-string
  assertions (per repo convention) that the leaderboard panel: renders two tabs
  (Users / X Callers); queries `trpc.leaderboard.users` and
  `trpc.leaderboard.xCallers`; renders the `approximate` (Users) and `heuristic` /
  `needsMarketData` (X) honesty copy; and Follows a row via
  `trpc.copyTradeFollows.follow` keyed by the row's `followTarget`.
- **Caching:** with Redis down, both procedures still return (live compute, warn
  logged). With Redis up, a second identical call hits the cache within the TTL.
- **Browser:** in `/app`, open Top Traders; on Users see ranked pseudonyms with
  realized P&L / win rate / trade count and the "approximate, shared-trades-only"
  caption; on X Callers see authors with hit rate / avg forward return (or the
  "market data required" note locally) and the "heuristic, not caller P&L"
  caption; Follow a row and confirm it appears in the feed's Following view.
