# Copy Trade: External Fill Detection Scope

Status: SCOPING ONLY (no feature code in this branch)
Author: agent/task8-copytrade-scope
Date: 2026-07-21

## Problem statement (from the product doc)

> If you're following another trader and they do a limit sell through our app,
> OR if they manually sell directly on Alpaca, we need to detect and copy that
> (and add to our database if needed, and send to the webhook channel). I
> noticed when I did a limit sell today it didn't send out a webhook.

Open question from the doc: "Do we need an Alpaca orders poll for fills not in
the RST DB? How often? New worker job?"

Stretch item: hyperdash.com/copytrading equities top-trader ingestion.

This document maps the current state, pinpoints the missed-webhook root cause,
and designs the external-fill detection worker. It proposes no code changes in
this branch beyond this file.

---

## 1. Current-state map

### 1.1 Order placement (in-app)

- The API places and persists an order directly in status `SUBMITTED`:
  `apps/api/src/routers/orders.ts:208`.
- The API does NOT emit any Discord/webhook notification at placement time.
  There is no `sendDiscordNotification` call anywhere in `orders.ts`. The only
  API-side webhook is a separate "Position Closed" message in
  `apps/api/src/routers/positions.ts:398-425` (called at `:597`), which is
  unrelated to order fills.

### 1.2 Fill reconciliation: `OrderSyncPoller`

File: `apps/worker/src/services/order-sync.ts`. Registered and started in
`apps/worker/src/index.ts:61-64`. Not env-gated, always runs.

- Interval: hardcoded `pollIntervalMs = 30000` (30s),
  `order-sync.ts:212`; immediate `pollOnce()` then `setInterval`,
  `order-sync.ts:226-227`.
- It selects only RST rows that are already known and non-terminal (or FILLED
  with a pending exit plan), `order-sync.ts:243-251`:
  statuses `PENDING`, `SYNCING`, `SUBMITTED`, `PARTIAL`, plus `FILLED` with
  `exitPlanStatus = "pending"`.
- Alpaca query is a per-order point lookup, NOT a list query. For each known
  row it calls `client.getOrder(brokerOrderId)` or
  `client.getOrderByClientId(brokerClientOrderId)`, `order-sync.ts:287-293`.
  These map to `GET /v2/orders/{id}` and
  `GET /v2/orders:by_client_order_id`, `packages/alpaca/src/client.ts:606-616`.
  A list form `getOrders({status:"all", ...})` exists (`client.ts:278,298,622`)
  but this poller does not use it.
- Matching direction is RST row -> Alpaca. Lookup key preference is
  `brokerOrderId`, else `brokerClientOrderId || clientOrderId`,
  `order-sync.ts:287-293`. Write-back is tenant-scoped by `id` + `userId` plus
  the stored broker ids (`tenantOrderWhere`, `order-sync.ts:191-206`).
- Grouping / multi-account: active orders are grouped by
  `${userId}:${brokerCredentialId || brokerAccountId || "legacy"}` so paper and
  live never share a client, `order-sync.ts:257-265`; one Alpaca client is
  built per credential group, `order-sync.ts:272-283`.
- PAPER vs LIVE: client `paper` flag derives from
  `isPaperAccount(credentials.accountType)`, `order-sync.ts:149-153`. The only
  behavioral divergence is that the Discord webhook fires for LIVE only,
  `order-sync.ts:324`.
- Idempotency: write-back only occurs when status, filled qty, broker id, or
  `syncReason` changed, `order-sync.ts:300-305`; repeated polls converge to
  no-ops.

Key gap: an Alpaca order with NO matching RST row is invisible. The poller only
iterates rows it already holds and looks each up at Alpaca. It never lists
Alpaca orders/activities, so a fill with no local row is never inserted,
logged, or mirrored. There is no insert into `schema.orders` in this file (the
only inserts are `smartExitLegs`, `order-sync.ts:446-455`).

### 1.3 Copy-mirror path (independent of fills)

- Pure helpers: `apps/api/src/lib/copy-mirror.ts`. Side-effect free. Exposes
  `computeMirrorQty` (`:77`), `mirrorIdempotencyKey` (`:145`, returns
  `copymirror:${followerUserId}:${sourceItemId}`), `withinDailyCap` (`:153`),
  `withinDollarCap` (`:164`), `decideSellMirrorQty` (`:409-417`, clamps a SELL
  mirror to held long qty so it cannot open a short).
- Worker: `apps/worker/src/services/copy-mirror.ts` (`CopyMirrorPoller`),
  registered in `index.ts:77-79`. Ships INERT unless
  `COPY_TRADE_AUTOMIRROR_ENABLED === "true"` (`:196-198`); refuses LIVE unless
  `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"` (`:201-203`). `POLL_INTERVAL_MS
  = 30000` (`:80`).
- Source discovery: it scans `socialTrades` (`:753-903`) and X-author
  `signals` (`:905-983`) on a watermark checkpoint
  (`copyMirrorCheckpoints`, consumer `"copy-mirror-v1"`, `:578-592`), stages
  candidates into `copyMirrorDeliveries` (durable retry inbox), and places via
  `placeMirrorOrder` (`:1387`). Placement inserts a PENDING order with
  `clientOrderId` = the idempotency key (`:1460`) and a bounded broker client
  id via `createBrokerClientOrderId(..., "copy")` (`:1433`).

Critical: copy-mirror consumes `socialTrades` / `signals`, NOT order fills.
There is no wiring today from fill reconciliation into copy-mirror. To mirror a
leader's fills, that edge must be built.

### 1.4 Webhook emission (all sites)

There are exactly two Discord webhook emitters, both gated on
`process.env.DISCORD_WEBHOOK_URL` and LIVE-accounts-only:

- Order lifecycle: `sendDiscordNotification`,
  `apps/worker/src/services/discord-notify.ts:129`, called from
  `order-sync.ts:326` inside the status-change branch, LIVE only
  (`order-sync.ts:324`).
- Position close: `notifyDiscord`, `apps/api/src/routers/positions.ts:398-425`,
  called once at `:597`. Separate "Position Closed" message.

(The webhook grep hits in `apps/api/src/.../trader-identity.ts:14,84` are
inbound TweetShift parsing, not emission.)

### 1.5 Orders schema (idempotency-relevant)

File: `packages/db/src/schema/orders.ts`, table at `:115`.

- Status enum (`:13-22`): `PENDING`, `SYNCING`, `SUBMITTED`, `FILLED`,
  `PARTIAL`, `CANCELLED`, `REJECTED`, `EXPIRED`. Note: these are RST-internal
  states, not Alpaca's raw `new`/`accepted`/`partially_filled`.
- Order type enum (`:28-40`): `Market`, `Limit`, `StopMarket`, `StopLimit`,
  `TakeProfitMarket`, `TakeProfitLimit`, `OCO`.
- Trade action enum (`:43-52`): `Buy`, `Sell`, `SellShort`, `BuyToCover`,
  `BuyToOpen`, `SellToClose`, `SellToOpen`, `BuyToClose`.
- Broker id columns: `clientOrderId` (`:158`), `brokerClientOrderId` (`:159`),
  `brokerOrderId` (`:160`), `brokerAccountId` (`:161`), `brokerCredentialId`
  FK -> `userApiCredentials.id` (`:162-165`).
- Fill columns are named `executedQuantity` (`:170`), `executedPrice` (`:169`),
  `executedAt` (`:206`), plus perp `executedSizeDecimal` (`:180`). There is NO
  `filledQty`/`filledAvgPrice`/`filledAt`.
- Attribution: `copySourceLabel` (`:192`, null for manual orders), `signalId`
  (`:124`), `venue` (`:185`, default `"alpaca"`).
- Indexes (`:212-238`): non-unique on `brokerOrderId` (`:219`), plus per-user
  composite indexes on `clientOrderId`/`brokerOrderId`/`brokerClientOrderId`.
  THE idempotency guarantee is `orders_client_order_id_unique`, a
  `uniqueIndex` on `clientOrderId` (`:236`). NULLs are distinct in Postgres, so
  legacy null rows are unaffected. There is NO unique constraint on
  `brokerOrderId`.
- Brokerage accounts are modeled by `user_api_credentials`
  (`packages/db/src/schema/user-credentials.ts:11`). PAPER vs LIVE is a plain
  text `accountType` (`:30`, values `"PAPER"`/`"LIVE"`/legacy `"SIM"`).
  Credentials are AES-256-GCM encrypted (`encryptedAccessToken` `:25`,
  `encryptedRefreshToken` `:26`). There is NO dedicated webhook table anywhere
  in the schema.

### 1.6 Root-cause hypothesis for the missed limit-sell webhook (verified)

The bug is real and pinpointed to the interaction of two facts:

1. An in-app limit order is persisted directly as `SUBMITTED`
   (`orders.ts:208`), and the API sends no webhook at placement.
2. The suppression rule in `discord-notify.ts:72-87`:

   ```
   if (isLimitType(order.orderType)) {
     return order.status !== "SUBMITTED";   // suppress FILLED/PARTIAL for limit orders
   }
   ```

Trace:

- The `OrderSyncPoller` first observes the order already at `SUBMITTED`.
  `mapAlpacaStatus("new"/"accepted", "SUBMITTED")` returns `"SUBMITTED"`
  (`order-sync.ts:157-189`), so `newStatus === order.status`, filled qty
  unchanged, and the change guard at `order-sync.ts:300-305` is false. No
  `notify` fires. The intended SUBMITTED ping never happens because there was
  no transition INTO SUBMITTED for the poller to observe (the row was born
  SUBMITTED).
- When the order fills, `mapAlpacaStatus("filled") = "FILLED"`, status changes,
  and `notify(...)` is called (`order-sync.ts:326`). But `shouldSuppress` sees
  a limit-type order with `status === "FILLED"`, and `"FILLED" !== "SUBMITTED"`
  is `true`, so the fill is suppressed (`discord-notify.ts:79-80`).

Net: a limit order (buy or sell) that is born SUBMITTED and later fills emits
ZERO webhooks. Market orders are unaffected because `shouldSuppress` keeps
FILLED for market types (`discord-notify.ts:82-83`), which is why the symptom
presents specifically on limit orders (the user observed it on a limit sell).

Note this is also LIVE-only: paper accounts never emit either way
(`order-sync.ts:324`), so the fix must respect that gating unless the team
decides paper should notify too (see open questions).

One-line-level fix options (do NOT implement here):

- Preferred: relax the limit branch so a limit fill notifies when no prior
  SUBMITTED ping was sent. Concretely, in `discord-notify.ts:79-80`, allow
  `FILLED` (and terminal states) through for limit types, e.g. change the limit
  branch to suppress only `PARTIAL` and any non-`SUBMITTED`/non-`FILLED` state.
  This keeps "one webhook per order" for the common case (fill ping) and drops
  the assumption that a SUBMITTED ping already fired.
- Alternative: emit the SUBMITTED notification at placement time in
  `orders.ts` near `:208`. This restores the two-event model but doubles pings
  for limits that fill quickly and needs its own LIVE gating and idempotency.

The preferred fix is the smaller and more robust change and is what Phase 1
should ship alongside external-fill detection. External fills (section 2) reuse
the same notification path, so fixing suppression is a prerequisite for them to
webhook correctly.

---

## 2. Design: external-fill detection worker

Goal: detect fills that exist at Alpaca but not in the RST DB, whether an
in-app order the poller missed or an order placed directly on Alpaca, record
them, webhook them, and (Phase 2) mirror them to followers.

### 2.1 New worker poller: `ExternalFillPoller`

New file: `apps/worker/src/services/external-fill-sync.ts`, registered in
`apps/worker/src/index.ts` alongside the existing pollers. It is a distinct job
from `OrderSyncPoller` because it is list-driven (Alpaca -> RST), the inverse of
the existing row-driven poller.

Per connected account (one `user_api_credentials` row with a usable Alpaca
token), each cycle:

1. Resolve the account's Alpaca client (paper flag from
   `isPaperAccount(accountType)`, mirroring `order-sync.ts:149-153`).
2. Call the Alpaca orders LIST endpoint:
   `GET /v2/orders?status=all&after=<cursor>&direction=asc&limit=500&nested=true`
   using the existing `getOrders(...)` wrapper
   (`packages/alpaca/src/client.ts:278,298,622`, extended to accept
   `after`/`until`/`direction`/`page_token` if not already present).
   `status=all` is required so cancelled/expired legs and already-filled orders
   are visible, and so a fill is not missed if it transitions between polls.
3. For each returned Alpaca order, classify:
   - Known: matches an RST row by `brokerOrderId` OR by
     `brokerClientOrderId`/`clientOrderId`. Skip (the existing OrderSyncPoller
     owns lifecycle for known rows). Optionally backfill `brokerOrderId` if the
     RST row was matched by client id and lacks it.
   - External: no RST row matches. This is the target case.
4. For external orders that are filled or partially filled, insert an RST row
   (section 2.3), then trigger the notification path (section 2.4) and, in
   Phase 2, enqueue a mirror candidate (section 2.5).
5. Advance the account's cursor watermark (section 2.2).

### 2.2 Cursoring and pagination

- Store a per-account watermark keyed by credential. Reuse the checkpoint
  pattern from `copyMirrorCheckpoints` (`packages/db/src/schema/copy-mirror-state.ts:15`)
  with a new consumer namespace, e.g. `external-fill-v1:<credentialId>`, or add
  a small dedicated table `external_fill_cursors(credentialId, watermark,
  updatedAt)`. Recommendation: a dedicated table, because the watermark is
  per-credential (not a single global consumer) and this keeps the copy-mirror
  checkpoint semantics clean.
- Cursor value: Alpaca `submitted_at`/`updated_at` timestamp of the last
  processed order. Query with `after=<watermark - overlap>` using a small
  safety overlap (for example 60s) to avoid boundary misses, relying on
  `clientOrderId` uniqueness (section 2.3) to absorb the re-reads.
- Pagination: Alpaca caps `limit` at 500 per page. When a page returns 500
  rows, keep paging with an advancing `after` (or `page_token` if the account
  is on a paginated tier) until a short page is returned, then commit the
  watermark. Never commit the watermark until the full page batch is durably
  inserted, so a crash re-reads rather than skips.

### 2.3 Insert convention for external fills

Insert into `orders` (`packages/db/src/schema/orders.ts:115`) with:

- `userId`, `brokerCredentialId`, `brokerAccountId`: the owning account.
- `brokerOrderId`: Alpaca order `id`.
- `clientOrderId`: a deterministic, namespaced key so the unique index
  (`orders_client_order_id_unique`, `orders.ts:236`) makes re-inserts idempotent.
  Convention: `extfill:<credentialId>:<alpacaOrderId>`. If the Alpaca order was
  itself placed with a client_order_id, prefer preserving it in
  `brokerClientOrderId` and still use the `extfill:` namespace for
  `clientOrderId` to avoid colliding with in-app `copymirror:`/HL cloids.
- `status`: mapped via the existing `mapAlpacaStatus` helper (FILLED/PARTIAL).
- `symbol`, `assetType` (EQUITY for now), `orderType` (map Alpaca
  `market`/`limit`/`stop`/`stop_limit`), `tradeAction` (map Alpaca `side`
  buy/sell to `Buy`/`Sell`), `quantity`, `executedQuantity`, `executedPrice`,
  `executedAt`, `limitPrice`/`stopPrice` when present.
- `copySourceLabel`: null (this is the leader's own trade, not a mirror). A new
  marker for "external/reconciled" origin is worth adding: either a boolean
  `externalOrigin` column or a distinct `venue`/`notes` marker. Recommendation:
  add a nullable `externalOrigin boolean default false` (or reuse `notes` with
  a stable tag) so external fills are queryable and excluded from any logic that
  assumes RST placed the order. This is a schema change (db:generate + migrate),
  flagged in open questions.

Do NOT overwrite or "fail" an external row after a successful insert, per the
broker-state-is-source-of-truth rule in CLAUDE.md.

### 2.4 Triggering the existing webhook path

- Reuse `sendDiscordNotification` (`discord-notify.ts:129`) via the same
  `OrderNotification` shape used at `order-sync.ts:326-337`.
- This depends on the suppression fix from section 1.6: without it, an external
  LIMIT fill would be inserted but suppressed, reproducing the same silent
  miss. Ship the suppression fix in the same phase.
- Preserve LIVE-only gating (`isPaperAccount(accountType)`), unless the team
  decides paper should notify (open question 4a).

### 2.5 Triggering copy-mirror (Phase 2)

- The cleanest integration is to publish external fills into the same source
  feed copy-mirror already consumes rather than calling placement directly.
  Two options:
  - Insert a `socialTrades` row for the external fill so the existing
    `CopyMirrorPoller` discovery (`copy-mirror.ts:753-903`) picks it up with no
    new mirror-placement code. `traderKey(userId)` matching already exists
    (`copy-mirror.ts:856-858`).
  - Or add a new source scanner in `findMirrorCandidates` that reads external
    fill rows directly.
- Recommendation: emit a `socialTrades` row. It reuses the durable
  `copyMirrorDeliveries` inbox, the sizing rules, the SELL-clamp
  (`decideSellMirrorQty`), and the existing idempotency
  (`copy_mirror_deliveries_follower_source_unique`), so Phase 2 adds an emit,
  not a second mirror engine.

### 2.6 Polling frequency (recommendation)

- Recommend 60s for `ExternalFillPoller`. Rationale: external/manual fills are
  not latency-critical the way an in-app fill's exit plan is, and 60s keeps the
  request budget comfortable across many accounts (section 2.7). The existing
  fill poller stays at 30s for known in-app orders where exit-plan attachment
  is time-sensitive.
- Make the interval an env var (for example `EXTERNAL_FILL_POLL_MS`, default
  60000) rather than hardcoding, so it can be tuned in prod without a deploy.

### 2.7 Rate limits, fan-out, backoff

- Alpaca limit is 200 requests/min per account key. Each account's cycle is at
  least one list call plus pagination. At 60s cadence with < 500 orders/window
  per account, that is roughly 1 to 2 calls/account/min, comfortably inside
  200/min.
- Multi-account fan-out: iterate credentials sequentially or with a small
  concurrency cap (for example 5). Because the 200/min budget is per account
  key, cross-account concurrency is safe; the practical limit is worker CPU and
  DB write throughput, not Alpaca.
- Backoff: on HTTP 429 or 5xx, exponential backoff per account with jitter, and
  skip that account for the cycle rather than blocking others. Do NOT advance
  the watermark on a failed page. Reuse the retry-counter pattern already in
  `order-sync.ts` (`syncAttempts`/`lastSyncAttemptAt`) or the
  `copyMirrorDeliveries.nextAttemptAt` backoff shape.

### 2.8 Idempotency and restart safety

- The `orders_client_order_id_unique` index on the `extfill:<credentialId>:<alpacaOrderId>`
  key makes duplicate inserts a no-op (use `onConflictDoNothing`), so a restart
  mid-page or an overlapping `after` window cannot create duplicate rows.
- The webhook and mirror emits must be tied to the INSERT result: only notify /
  enqueue when the insert actually created a row (conflict = already handled),
  so restarts do not double-notify or double-mirror.
- For Phase 2, the `copy_mirror_deliveries_follower_source_unique` constraint
  provides the second idempotency layer at the mirror level.

### 2.9 PAPER vs LIVE gating

- Follow the existing convention: auto-mirror stays inert unless
  `COPY_TRADE_AUTOMIRROR_ENABLED === "true"`, and LIVE mirroring requires
  `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true"` (`copy-mirror.ts:196-203`).
- The detection/webhook half (Phase 1) can run for LIVE accounts immediately
  (matching current webhook gating). Add its own kill switch, for example
  `EXTERNAL_FILL_DETECT_ENABLED`, defaulting off, so it can be rolled out
  gradually.

---

## 3. Phasing

### Phase 1: detect + webhook + DB record

- Fix the limit-fill suppression bug (`discord-notify.ts:79-80`).
- Add `ExternalFillPoller` (list Alpaca orders, classify unknown as external,
  insert with `extfill:` clientOrderId, notify via existing webhook path).
- Add per-credential cursor storage and the `EXTERNAL_FILL_DETECT_ENABLED`
  kill switch.
- Schema: add the external-origin marker column and the cursor table
  (db:generate + migrate; flagged for prod).

### Phase 2: mirror external fills to followers

- Emit a `socialTrades` row (or new source scanner) for each external fill so
  the existing `CopyMirrorPoller` mirrors it under the current sizing / caps /
  SELL-clamp / delivery-inbox machinery.
- Keep the existing `COPY_TRADE_AUTOMIRROR_ENABLED` / `..._ALLOW_LIVE` gating.

### Phase 3: hyperdash top-trader ingestion (feasibility assessment)

Honest assessment based on hyperdash.com and docs.hyperdash.info:

- Hyperdash has NO public developer API or documented REST endpoints for
  leaderboard/trader data (docs.hyperdash.info describes the product only).
- Hyperdash copytrading covers Hyperliquid PERPETUALS only ("replicate the
  perpetual positions of up to three selected wallets on Hyperliquid"). It does
  NOT cover real equities brokerages like Alpaca. Its "Equities Focused"
  leaderboard filter refers to Hyperliquid wallets trading equity-style perps,
  not Alpaca equities.
- Therefore "hyperdash equities top-trader ingestion into our Alpaca copy
  system" is not feasible as literally stated: there is no equities data and no
  API to pull.
- What IS feasible: the underlying leader positions are Hyperliquid on-chain
  data, which has its own public API (Hyperliquid info endpoints). If the team
  wants "top traders" for the existing PERP venue (`orders.venue =
  "hyperliquid"`, `orders.ts:185`), ingest from Hyperliquid's public API and
  optionally rank with our own copy-score, rather than depending on hyperdash.
- Scraping hyperdash's site for leaderboard HTML is technically possible but
  fragile (no stable contract), likely against their terms, and still yields
  only Hyperliquid perp wallets. Recommendation: do not scrape; if perp
  top-trader ingestion is wanted, source it from Hyperliquid's public API
  directly. Treat Phase 3 as "Hyperliquid perp top-traders" and drop the
  "equities via hyperdash" framing.

---

## 4. Open product questions

1. External fills placed directly on Alpaca have no RST intent (no signal, no
   exit plan). Do we attach our standard preset TP/exit plan to a detected
   external fill, or record it flat? (Current exit-plan logic assumes RST
   placed the entry, `order-sync.ts:351-357`.)
2. For a partial fill detected externally, do we webhook once at first
   detection, or on each partial increment? (Existing design consolidates to a
   single FILLED ping for market orders.)
3. Should external-fill detection cover only equities, or also options? (Alpaca
   returns both; `assetType` mapping differs.)
4. a) Should PAPER accounts webhook at all? Current behavior is LIVE-only.
   b) Should the limit-fill webhook fix also apply to paper, or stay LIVE-only?
5. Should a manual Alpaca-direct SELL that closes a position also trigger the
   "Position Closed" API webhook path (`positions.ts:398-425`), or only the
   order webhook?
6. Mirror scope: do we mirror a leader's EXTERNAL manual sells to followers, or
   only their in-app trades? Manual-sell mirroring is the explicit ask, but it
   means followers act on trades the leader made outside our app entirely.
7. Do we need to backfill historical external fills on first enablement, or
   only detect fills going forward from the cursor's initial watermark?

---

## 5. Test plan

### Unit tests

- Suppression fix: extend the `discord-notify` tests to assert a limit-type
  order with `status = "FILLED"` and no prior SUBMITTED ping is NOT suppressed,
  while the happy-path single-ping behavior is preserved for market orders.
  Import the real module (no source-regex tests, per CLAUDE.md).
- Classification: given a mixed Alpaca list response, assert known orders
  (matched by `brokerOrderId` and by `clientOrderId`) are skipped and unknown
  filled orders are classified external.
- Insert idempotency: inserting the same external Alpaca order twice yields one
  row (unique `clientOrderId`) and exactly one notify/enqueue.
- Cursor: assert the watermark advances only after a durable page insert, and
  that the safety overlap re-reads without duplicating rows.
- Backoff: assert a 429 for one account does not advance its watermark and does
  not block other accounts.
- Phase 2 sizing: reuse existing `computeMirrorQty` / `decideSellMirrorQty`
  tests to confirm an external SELL fill mirrors without opening a short.

### Two-account paper live test (integration)

1. Account A (leader, paper) and Account B (follower, paper), B follows A with
   `autoMirror = true`.
2. Place a LIMIT SELL directly on Alpaca for account A (bypassing our app) and
   let it fill.
3. Assert within one poll cycle: an `extfill:` order row appears for A, a
   Discord webhook is emitted (with the suppression fix), and no duplicate row
   appears on a second cycle.
4. With Phase 2 enabled (`COPY_TRADE_AUTOMIRROR_ENABLED=true`), assert a
   corresponding mirror order is placed for B under the sizing rule, exactly
   once across restarts, and clamped so B never goes short.
5. Repeat with an in-app LIMIT SELL on A to confirm the missed-webhook bug is
   fixed end to end.

---

## Appendix: key file references

- `apps/worker/src/services/order-sync.ts` (existing fill reconciliation)
- `apps/worker/src/services/discord-notify.ts:72-87` (suppression bug)
- `apps/api/src/routers/orders.ts:208` (in-app order born SUBMITTED, no webhook)
- `apps/worker/src/services/copy-mirror.ts` (`CopyMirrorPoller`)
- `apps/api/src/lib/copy-mirror.ts` (pure mirror helpers)
- `packages/db/src/schema/orders.ts` (orders schema, `:236` unique clientOrderId)
- `packages/db/src/schema/copy-mirror-state.ts` (checkpoint + delivery inbox)
- `packages/db/src/schema/user-credentials.ts` (accounts, PAPER/LIVE)
- `packages/alpaca/src/client.ts:278,298,606-622` (getOrders / getOrder wrappers)
