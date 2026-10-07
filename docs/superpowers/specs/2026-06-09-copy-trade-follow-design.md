# Copy Trade Follow Design

## Goal

Let a user FOLLOW specific traders/authors from the copy-trade feed so they do
not have to watch the live list. One per-user follow row drives two behaviors
off a single `auto_mirror` flag:

- `auto_mirror = false` — a curated **Following** view: the same unified feed,
  filtered to the user's followed targets. The user still clicks Copy.
- `auto_mirror = true` — a background worker **auto-places** the trade on the
  follower's account using their stored sizing rule (REAL auto-execution).

> **Auto-mirror is OFF by default and must be deliberately enabled.** Every new
> follow row defaults `auto_mirror = false`, and the worker that would place real
> orders is INERT unless `COPY_TRADE_AUTOMIRROR_ENABLED === "true"`. Nothing in
> this design places a real order until an operator opts in explicitly (and
> opts in again for LIVE accounts). See **Auto-mirror safety model** below.

This builds directly on the Phase-1 copy-trade feed: the normalized
`CopyTradeItem` contract, the `(timestamp, id)` cursor, and the
privacy-preserving anonymization in `social.ts`.

## Design

### Privacy-preserving follow target (the key model)

A follower cannot follow a raw `userId` — the user source is anonymized and the
real id never reaches the client (`social.ts`). So every `CopyTradeItem` carries
a stable, NON-PII `followTarget` that the Follow button and the Following filter
key off:

```ts
type FollowTargetType = "x_author" | "user" | "politician";
interface FollowTarget {
  type: FollowTargetType;
  key: string;   // stable, NON-PII handle — NEVER the raw user id
  label: string; // display name / pseudonym
}
// CopyTradeItem gains:
followTarget: FollowTarget | null;  // null when there is no followable author
```

Per source:

- **x_signal → `type: "x_author"`** — `key` is the author name run through
  `normalizeAuthorKey` (TweetShift suffix stripped, trimmed, internal whitespace
  collapsed, lowercased); `label` is the cleaned display name. `key` is `null`
  for an empty/"Unknown" author, so `followTarget` is `null` and the item is not
  followable.
- **user → `type: "user"`** — `key` is `traderKey(userId)`: the SAME one-way FNV
  hash `anonymizeTrader` uses, as base36. `label` is the pseudonym
  (`traderName`). The raw `userId` is hashed server-side and never serialized —
  a test asserts the real id never appears in the JSON.
- **politician → `type: "politician"`** — Phase-2, inactive now (the source is a
  no-op in the feed).

Two helpers keep the key model identical on both sides of the wire:

```ts
normalizeAuthorKey(name): string | null   // x_author key derivation (pure)
followSetKey(type, key): string            // "type|key" — Set membership key
traderKey(userId): string                  // social.ts — base36 of the FNV hash
```

Because `traderKey` reuses the exact hash that seeds the anonymized avatar, the
follow key always lines up with the displayed identity without ever handling the
real id.

### `copy_trade_follows` table

One row per `(follower, target)`. It stores the NON-PII target, a sizing rule,
and the `auto_mirror` flag — mirroring the `CopyTradeItem.followTarget` contract:

```
copy_trade_follows
  id                uuid pk
  follower_user_id  text  -> users.id (cascade)         // who is following
  target_type       text  // "x_author" | "user" | "politician"
  target_key        text  // NON-PII; never the raw user id
  target_label      text  // display label snapshot
  sizing_mode       text  default "pct"  // "pct" | "usd"
  sizing_value      numeric(12,2) default "5"
  auto_mirror       boolean default false // OFF by default
  created_at        timestamptz default now()

  index (follower_user_id)
  index (target_type, target_key)
  unique (follower_user_id, target_type, target_key)   // one row per target; upsert
```

The unique constraint makes Follow an idempotent upsert (re-following updates the
label/sizing/flag in place). The table lives in
`packages/db/src/schema/copy-trade-follows.ts` and is re-exported from
`packages/db/src/schema/index.ts`, matching the column style of
`social-trades.ts` / `signals.ts`. It is applied with `bun run db:push`
(`db:generate` is broken repo-wide).

### Following view (`followedOnly`)

The `copyTrade.feed` procedure takes a `followedOnly: boolean` (default `false`).
When `true`, it loads the caller's follow set once as `followSetKey` strings and
keeps only items whose `followTarget` is in that set. The follow-set read is
wrapped in try/catch so a missing table (pre-`db:push`) degrades to an empty
Following feed rather than a 500. Filtering happens per-source before the merge,
so paging, the `(timestamp, id)` cursor, and per-source isolation are unchanged.
Items with a `null` followTarget can never match — they are excluded from the
Following view by construction.

### Follow / unfollow / update router (`copyTradeFollows`)

A new router, every procedure scoped to `ctx.userId` (a user can only see/mutate
their own follow rows). The raw source `userId` is never accepted — only the
NON-PII `targetKey`.

- `list` → the caller's follows, newest-first.
- `follow({ targetType, targetKey, targetLabel?, sizingMode?, sizingValue?, autoMirror? })`
  → idempotent upsert on the unique constraint. Omitted fields fall back to DB
  defaults on insert and are left untouched on update.
- `unfollow({ targetType, targetKey })` → delete, returns `{ removed }`.
- `update({ targetType, targetKey, autoMirror?, sizingMode?, sizingValue? })`
  → partial update of the sizing rule / `auto_mirror` flag (the toggle that arms
  or disarms mirroring for that one target).

Numeric `sizing_value` is `numeric(12,2)` — written via `toFixed(2)`, surfaced to
the client as a `number`.

### Auto-mirror worker (flag-gated, paper-first)

When a follow has `auto_mirror = true`, a background poller in `apps/worker`
places the order for the follower. It is registered in
`apps/worker/src/index.ts` but stays INERT behind an env flag — during this build
it does NOT place any order.

Flow when (and only when) enabled:

1. Find new source trades (signals / shared user trades) since the last cursor.
2. For each, find the follows whose `followTarget` matches and have
   `auto_mirror = true`.
3. Resolve the follower's Alpaca credentials; **skip LIVE accounts** unless
   `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"`.
4. Size with `computeMirrorQty` from the follower's own buying power + a live
   price (never the source author's quantity).
5. Enforce guardrails: per-follow daily cap (`withinDailyCap`) and per-order
   dollar cap (`withinDollarCap`). Both fail closed.
6. Idempotency: derive a deterministic `client_order_id` with
   `mirrorIdempotencyKey({ followerUserId, sourceItemId })` and reuse the orders
   idempotency path so the same source trade is never mirrored to the same
   follower twice.
7. Submit through the same Alpaca order path the manual `orders.submit` uses, and
   write a full audit log line via `createProductionLogger`.

### Auto-mirror safety model (NON-NEGOTIABLE — this places real orders)

- **Inert by default.** The whole service is gated on
  `COPY_TRADE_AUTOMIRROR_ENABLED`. If it is not exactly `"true"`, the service
  logs that it is disabled and does NOTHING — no DB reads, no orders.
- **`auto_mirror = false` by default** on every follow row. Mirroring a target
  requires a deliberate per-target toggle.
- **Paper-first.** Even when enabled, the worker refuses to mirror onto a LIVE
  account unless `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"`. Default is
  paper-only (`isPaperAccount` from `apps/api/src/lib/alpaca.ts`).
- **Per-follow guardrails.** A daily mirror cap (`DEFAULT_MIRROR_DAILY_CAP = 20`)
  and a per-order dollar cap (`DEFAULT_MIRROR_MAX_ORDER_DOLLARS = 1000`), both
  configurable via env, both fail closed on invalid input.
- **Idempotency.** Deterministic `client_order_id` via `mirrorIdempotencyKey`,
  reusing the existing `orders.clientOrderId` idempotency check — never mirror
  the same source trade to the same follower twice.
- **Pure, unit-tested core.** Sizing/cap/idempotency live in
  `apps/api/src/lib/copy-mirror.ts` as pure, exported functions, tested without a
  DB or broker.
- **Audit logging.** Every decision and submission is logged via
  `createProductionLogger`.

### Reuse

- `social.ts` → `anonymizeTrader`, `traderKey` (same FNV hash).
- `copy-trade.ts` → `CopyTradeItem`, `normalizeAuthorKey`, `followSetKey`,
  `mapSignalToItem`, `mapUserTradeToItem`, `buildPage`, the `(timestamp, id)`
  cursor.
- `orders.ts` → the `orders.submit` Alpaca path, `clientOrderId` idempotency,
  rate limit, and social-feed publication.
- `apps/api/src/lib/alpaca.ts` → `getAlpacaClient`, `isPaperAccount`.
- `positions.account` → follower buying power for `pct` sizing.
- `apps/worker/src/index.ts` → the interval-poller registration pattern
  (`DiscordPoller` / `OrderSyncPoller`).

## Scope

- **In scope:** the `copy_trade_follows` table; the `followTarget` key model on
  `CopyTradeItem`; the Following view (`followedOnly`); the follow/unfollow/update
  router; the panel Follow buttons + Following toggle; the pure mirror helpers;
  and the flag-gated auto-mirror worker, registered but INERT (no order placed
  during the build).
- **Out of scope:** the Phase-2 politician source (the `politician` target type
  exists in the contract but the feed source is a no-op); fractional shares;
  partial-fill reconciliation beyond what `OrderSyncPoller` already does.

## Verification

- **API:** TypeScript check and `bun test`. Pure tests cover `computeMirrorQty`
  (pct/usd, floor, zero/invalid → 0), `mirrorIdempotencyKey` (deterministic,
  per-follower, per-item), `withinDailyCap` / `withinDollarCap` (fail closed),
  `traderKey` (deterministic, one-way, matches the avatar seed),
  `normalizeAuthorKey`, `followSetKey`, and the `followTarget` mapping
  (x_author from a normalized author, `null` for Unknown, user keyed by
  `traderKey` with the raw id absent from the JSON).
- **Web:** TypeScript check and `bun test` (source-string assertions on the
  panel: Follow/Following controls, `copyTrade.feed followedOnly`, and the
  `copyTradeFollows` mutations).
- **DB:** point `DATABASE_URL_DIRECT` at the target DB and run `bun run db:push`
  to create `copy_trade_follows` (review the proposed statements;
  `db:generate` is broken repo-wide). Verify the table exists before enabling the
  feature.
- **Browser:** in `/app`, Follow a trader from a feed row; switch to the
  Following view and confirm it is filtered to followed targets; unfollow and
  confirm the row disappears.
- **Safely enable auto-mirror on PAPER (test only):** with a PAPER credential
  linked, set `COPY_TRADE_AUTOMIRROR_ENABLED=true`, leave
  `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE` unset (default paper-only), set a follow to
  `auto_mirror = true`, and confirm the worker mirrors exactly one order per
  source trade (idempotent), stays under the daily/dollar caps, and refuses any
  LIVE account. Unset `COPY_TRADE_AUTOMIRROR_ENABLED` to return the worker to
  inert.
