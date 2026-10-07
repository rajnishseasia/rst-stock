# Copy-Trade Auto-Mirror: Hardening Report

**Scope:** the auto-mirror feature end to end (worker poller and execution, consent gates, discovery, perp sizing/execution, Alpaca reconciler, tRPC surface, follow/delivery schema, and the copy-trade UI).

**Threat model:** ranked as if `COPY_TRADE_AUTOMIRROR_ENABLED=true`, `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE=true`, `PERPS_ENABLED=true`, `COPY_TRADE_AUTOMIRROR_PERPS_ENABLED=true`, `PERPS_ALLOW_MAINNET=true`, with real broker credentials attached to follows.

**Method:** every item below was independently re-derived by three adversarial verifiers whose job was to refute it. Only findings that at least two of three could not refute appear here. Four other candidate findings were refuted and are deliberately absent; the two most likely to be re-raised are named in "Checked and found sound" so they are not re-audited.

Two known items are out of scope by prior decision: signal-sourced perp mirrors having no exit (documented at `copy-mirror-perp-execution.ts:14-18`), and the already-fixed duplicated $10 mirror floor.

| # | Finding | Anchor | Group |
|---|---------|--------|-------|
| 1 | Mirrors are republished as source trades, so mutual/chained follows loop live orders | `copy-mirror.ts:3326` | MUST FIX |
| 2 | Equity PENDING-resume re-sends a stored SELL with no live position read | `copy-mirror.ts:1485` | MUST FIX |
| 3 | Sizing-mode tab commits the mode alone, changing a live follow's size by 10x to 15x | `manage-follows.tsx:504` | MUST FIX |
| 4 | Reconciler strands a never-submitted mirror as SYNCING, copy-mirror then drops it as "duplicate" | `order-sync.ts:413`, `copy-mirror.ts:1363` | MUST FIX |
| 5 | Daily and per-order caps block exits, and the skip permanently spends the exit | `copy-mirror.ts:722-735` | SHOULD FIX |
| 6 | An equity close that finds no long is consumed while its paired open is still queued | `copy-mirror.ts:1596-1602` | SHOULD FIX |

---

## MUST FIX BEFORE ENABLING

### 1. Mirrored equity/option orders are republished to `social_trades` with no origin marker, so they are rediscovered as mirror sources

**What breaks.** After a successful Alpaca submission, `placeMirrorOrder` publishes the follower's mirror into the social feed with nothing marking it as a mirror:

```ts
// apps/worker/src/services/copy-mirror.ts:3326-3337
if (follower?.shareTrades) {
  await this.db.insert(schema.socialTrades).values({
    userId: params.followerUserId,
    symbol: params.symbol,
    side: params.side,
    qty: submissionQty,
    ...
    brokerOrderId: result.id,
  });
}
```

Discovery then reads every social row in the cycle window with no provenance filter at all:

```ts
// apps/worker/src/services/copy-mirror-candidate-sources.ts:292-306
.from(schema.socialTrades)
.leftJoin(schema.orders, and(
  eq(schema.socialTrades.brokerOrderId, schema.orders.brokerOrderId),
  eq(schema.socialTrades.userId, schema.orders.userId)))
.where(and(gt(schema.socialTrades.createdAt, windowStart)))
```

The projection never selects `orders.clientOrderId`, `orders.notes`, or `orders.copySourceLabel`, so the mirror markers the worker already writes are not even available downstream. The only exclusion is the self-mirror guard at `copy-mirror-candidate-sources.ts:501` (`if (follow.followerUserId === trade.userId) continue;`), which stops A mirroring A and nothing else. `packages/db/src/schema/social-trades.ts` has no origin column.

The Hyperliquid reconciler already implements exactly this guard and the equity path does not: `hyperliquid-order-sync.ts:672` publishes only when `!isAutoMirroredOrder(updatedOrder)`, defined at `:63-65` as `order.clientOrderId?.startsWith("copymirror:")`. That is the only occurrence in the repo, and it has a dedicated test (`hyperliquid-order-sync.test.ts:396`, "does not republish an auto-mirrored fill as a new source trade"). The equity path has neither.

Idempotency cannot break the chain: the key is `copymirror:<follower>:user:<socialTradeId>` (`apps/api/src/lib/copy-mirror.ts:146`) and every hop mints a new `social_trades.id`, so the dedupe at `copy-mirror.ts:1363` and the delivery unique key `(followerUserId, sourceItemId)` never collide.

**Concrete failure.** A and B follow each other (`copy-trade-follows.ts` `follow` mutation has no reciprocity or cycle check; the unique constraint is only on `(followerUserId, targetType, targetKey)`), both armed with live Alpaca credentials, both with `shareTrades` on (which is implied, since a user only appears in the "user" copy feed by publishing social rows). B buys 100 AAPL by hand. Cycle N: A mirrors it, and line 3326 publishes A's mirror. Cycle N+1 (about 30s later, `POLL_INTERVAL_MS = 30_000`): discovery matches A's row to B's follow, the self-guard does not fire because B is not A, the source event timestamp is seconds old so the 15 minute staleness bound passes, and B places a second real market buy. This alternates once per poll cycle until `countMirrorsToday` hits `DEFAULT_MIRROR_DAILY_CAP = 20` on each side. One deliberate trade becomes roughly 19 additional unrequested live market orders per account per day, each up to `DEFAULT_MIRROR_MAX_ORDER_DOLLARS = 1000`.

A one-way chain needs no cycle: with A following B and C following A, C receives a mirror-of-a-mirror published under A's identity and trades a symbol chosen by B, whom C never followed. That is a consent and attribution break, not only an amplification bug.

**Fix.**
1. At the publish site, gate on origin exactly as the perp path does. `placeMirrorOrder` already has `params.clientOrderId` in hand, so the minimal change is to skip the insert when it starts with `copymirror:`, or (clearer) thread an explicit `isAutoMirror: true` param through and check that.
2. Because that leaves already-published rows in the table, add the same test at discovery: select `schema.orders.clientOrderId` in the `copy-mirror-candidate-sources.ts:255-291` projection and drop any row whose joined order id starts with `copymirror:`. This is defense in depth and it retro-fixes historical rows.
3. If the product wants mirrors visible in the feed, keep the row but add an explicit provenance column to `social_trades` (for example `origin: "manual" | "mirror"`, defaulting to `"manual"`) and filter on the column rather than on the join, since the join is a `leftJoin` and an unmatched row cannot be classified.
4. Port `hyperliquid-order-sync.test.ts:396` to the equity path, plus a regression test that a mutual follow pair produces exactly one mirror per source trade.

---

### 2. Equity PENDING-resume re-sends the stored SELL quantity with no live position read, so a mirrored close can open a naked short

**What breaks.** `processCandidate` short-circuits a stored PENDING equity/option order straight back into `placeMirrorOrder`, deliberately ahead of any fresh reads:

```ts
// apps/worker/src/services/copy-mirror.ts:1481-1495
// A prior transient attempt already passed sizing and all guardrails before
// it wrote this PENDING order. Recover that exact durable intent before any
// fresh account/quote reads can change its quantity or consume it as a skip.
if (existing?.status === "PENDING" && !existing.brokerOrderId) {
  ...
  return this.placeMirrorOrder(client, { ... side: cand.side, qty: existing.quantity, ... });
}
```

The naked-short clamp lives strictly below that return, at `copy-mirror.ts:1593-1612` (`fetchLongQty` then `decideSellMirrorQty`, whose own doc at `:767-782` says a follower with no long "would have that sell placed as a naked SHORT"). `fetchLongQty` has no other call site. Nothing downstream compensates: the equity request is built as bare `type: "market", side: "sell"`, and `position_intent` is set only inside the `assetType === "OPTION"` branch, so Alpaca receives no reduce-only instruction. Note also `copy-mirror.ts:3206`, `const submissionQty = insertedOrder ? params.qty : order.quantity;` on a resume the *stored row quantity* is what goes to the broker regardless of what the caller passes.

This directly falsifies an invariant the file asserts 60 lines earlier at `copy-mirror.ts:1421-1427` ("The sell path independently reads the follower's real long ... so an exempted sell still cannot open a short"), which is the stated justification for exempting closing sells from the consent gate. The perp module treats the identical hazard as unacceptable and re-sizes on resume rather than re-sending ("`reduceOnly` prevents a flip; it does not preserve ownership", `copy-mirror-perp-execution.ts:589-600`).

**Concrete failure.** Follower holds 100 AAPL opened by the mirror. Source sells; the fresh path sizes, clamps to 100, inserts the order row PENDING, and `client.createOrder` throws ECONNRESET. In `packages/alpaca/src/client.ts:333-364` the ambiguity lookup 404s and rethrows the *original* error, so it is not an `AlpacaAmbiguousOrderError`; `classifyMirrorFailure` calls it transient, so neither the SYNCING nor the REJECTED branch runs and the row stays PENDING with a null broker id. The delivery is requeued at +30s. Before the retry the follower's long shrinks (their own stop fills, they exit by hand, or a second mirrored sell of the same shares flattens them). On retry the resume branch fires and submits a 100 share market SELL with no position read. On a margin account with a shortable symbol the follower is now short 100 AAPL, unbounded downside, in the opposite direction of every guardrail in the file. A partial reduction produces an oversell rather than a full flip, which is the more common shape.

**Reachability caveat, stated honestly.** `OrderSyncPoller` runs unconditionally in the same process on the same 30s cadence and, in the quiet single-worker case, usually claims the row first and flips it to SYNCING, at which point the dedupe at `copy-mirror.ts:1363` returns "duplicate" and the resume never fires. That interception is finding 4, not a guard, and when it wins the outcome is a silently dropped exit instead of a short. The resume genuinely wins on process restart (both pollers kick immediately and un-awaited, and an overdue delivery drains at once) and whenever order-sync's sequential per-order broker round trips push a cycle past 30s. Options are covered by `position_intent: sell_to_close`; equities are the exposed asset type.

**Fix.** In the resume branch at `copy-mirror.ts:1485`, before calling `placeMirrorOrder`, when `cand.side === "sell"` and the asset type is EQUITY:
1. Read `const heldLongQty = await this.fetchLongQty(client, tradingSymbol);`
2. Run `decideSellMirrorQty(Number(existing.quantity), heldLongQty)`. On `skip`, return `"no-long-position"` (and see finding 6 about deferring rather than consuming). On `place`, take the clamped quantity, which can only move down.
3. Because `placeMirrorOrder` uses `order.quantity` on the resume path (`copy-mirror.ts:3206`), the clamped value must be **persisted onto the order row** before resubmitting, or `placeMirrorOrder` must accept an explicit resume-quantity override. Passing a smaller `params.qty` alone will not change what is submitted.
4. Keep the intent-recovery property for buys: only sells need the re-read, so the "no fresh reads" comment stays true for the open path.
5. Add the missing test. The only resume test today, `copy-mirror.test.ts:6297`, drives an OPEN into the consent gate.

**Correction to an earlier claim:** the resume does not bypass the daily cap. `countMirrorsToday` (`copy-mirror.ts:3050-3092`) already counts the PENDING row written by the first attempt, so the slot was consumed on attempt one and re-counting on resume would double count. The perp resume's explicit self-exclusion (`copy-mirror-perp-execution.ts:445-455`) exists for the same reason.

---

### 3. The sizing-mode tab commits the mode alone, so one click changes a live follow's order size by 10x to 15x with no confirmation

**What breaks.** The mode selector on a follow row writes immediately, and writes only the mode:

```tsx
// apps/web-v2/src/components/copy-trade/manage-follows.tsx:500-505
<SizingModeTabs
  value={follow.sizingMode}
  disabled={disabled}
  compact
  onChange={(mode) => onUpdate({ sizingMode: mode })}
/>
```

`SizingModeTabs` fires on a plain click (`sizing-mode-tabs.tsx:45`, `onClick={() => onChange(mode)}`), `ManageFollows` passes the patch through verbatim, and `use-manage-follows.ts` sends `{ targetType, targetKey, ...patch }` without backfilling `sizingValue`. The API accepts the half-patch by design and says so:

```ts
// apps/api/src/routers/copy-trade-follows.ts:57-64
function validateSizingForMode(mode, value): string | null {
  if (mode === undefined || value === undefined) return null;
```

and persists it unconditionally at `copy-trade-follows.ts:375` (`if (input.sizingMode !== undefined) updateSet.sizingMode = input.sizingMode;`) with no companion write to `sizing_value` and no DB CHECK tying the two. The follow stays armed, because neither `autoMirror` nor `credentialId` is in the patch. Sizing is not part of consent (`decideFollowConsent` checks only follow id, follower, `autoMirror`, `credentialId`), so the worker picks up the new pair on the next cycle.

The row's own guard cannot help: `draftOutOfRange` is computed against `SIZING_MODE_PRESENTATION[follow.sizingMode]`, that is, the *new* mode, one round trip after the write already landed, and it only feeds `sizingInvalid`, which `autoMirrorSwitchState` (`account-targeting.ts:110-128`) consults only when arming. Arming, disarming, re-pointing, clearing the account, and unfollowing all route through a confirmation dialog. The sizing tab is the only consequential control on the row that does not.

**Concrete failure.** An armed live follow is sized `usd` / 50 ($50 per order). The user clicks the "Buying power" tab intending to type 5 next. The click alone persists `sizingMode: "pct"` with `sizingValue` still 50, so the follow is now "50% of buying power". Nothing warns, because 50 is inside pct bounds [0.01, 100]. On $1,500 buying power the row prints "About $750.00 per order at current balance", which is under the $1,000 per-order ceiling, so `withinDollarCap` passes and the worker places it. If a source trade arrives before the user retypes (a 30s window at worst, indefinite if they close the dropdown or get interrupted), the mirror is 15x the configured size on live money.

The reverse direction (`pct` / 5, click "Dollars", leaving `usd` 5.00) is a silent mis-size rather than the clean kill originally claimed: `MIRROR_MIN_ORDER_NOTIONAL_USD` is enforced only on the Hyperliquid path (`copy-mirror-perp-sizing.ts:49,165`), so a perp destination skips every mirror while the row still reads valid and the switch still reads On, whereas an Alpaca destination places a ~$5 order or floors to zero shares and returns `no-qty`.

**Fix.**
1. Client: make the tab stage a draft rather than commit. Either have `SizingModeTabs` set local draft state and commit `{ sizingMode, sizingValue }` together from the existing `commitValue` path (`manage-follows.tsx:459-471`), or, if immediate commit is wanted, send both fields at once with a mode-appropriate value: `onUpdate({ sizingMode: mode, sizingValue: convertOrDefaultForMode(mode, follow.sizingValue) })`. Also clear the `valueDrafts` entry for that follow on a mode change, since it currently keeps showing the old number under the new mode's caption.
2. Server: the `update` mutation already loads `current` at `copy-trade-follows.ts:344`. Cross-validate the effective pair there: `validateSizingForMode(input.sizingMode ?? current.sizingMode, input.sizingValue ?? Number(current.sizingValue))` and throw `BAD_REQUEST` on failure. That closes the hole for any client, not just this one.
3. Product: route a sizing change on an *armed* follow through the existing `ConsentAsk` flow, the same way `repoint` is gated, so the confirmation set is consistent.
4. Replace `copy-trade-follow.test.ts:112`, which asserts the source string `onUpdate({ sizingMode:` and therefore pins the current bug, with a behavioral test that a mode change sends a coherent pair.

---

### 4. `OrderSyncPoller` flips a never-submitted mirror row PENDING to SYNCING, and copy-mirror then abandons the delivery as a "duplicate"

**What breaks.** `placeMirrorOrder` inserts the local order row PENDING with `brokerClientOrderId` set and `brokerOrderId` null *before* calling Alpaca, and on a transient submit failure deliberately leaves it PENDING so the resume path at `copy-mirror.ts:1485` can recover it.

`OrderSyncPoller` is started unconditionally (`apps/worker/src/index.ts:62-63`, 30s interval), scans every non-PERP row in PENDING/SYNCING/SUBMITTED/PARTIAL with no age floor and no "was this ever submitted" predicate (`order-sync.ts:290-297`), and for a row with no broker id asks Alpaca by client id (`order-sync.ts:339-341`). The order was never submitted, so Alpaca 404s, and the catch rewrites the row:

```ts
// apps/worker/src/services/order-sync.ts:407-419
} catch (err) {
   if (order.status === "PENDING" || order.status === "SYNCING") {
     ... .set({ status: "SYNCING", syncReason: ..., syncAttempts: order.syncAttempts + 1, ... })
```

There is no 404 branch here, even though the file defines `isNotFoundError` at `:171` and uses it correctly in the smart-exit leg path at `:570`. Copy-mirror's dedupe then treats anything not exactly PENDING as already mirrored:

```ts
// apps/worker/src/services/copy-mirror.ts:1363-1370
if (existing && (existing.status !== "PENDING" || existing.brokerOrderId)) {
  logger.info(LOG_SERVICE, "[copy-mirror] skip: duplicate (already mirrored)", {...});
  return "duplicate";
}
```

`markDeliveryCompleted(row.id, outcome, ...)` at `copy-mirror.ts:959` retires the delivery permanently, and `stageWindow`'s `onConflictDoNothing` on `(followerUserId, sourceItemId)` plus the advanced checkpoint mean it can never be re-staged. The existing CANCELLED revival CAS at `copy-mirror.ts:1287-1296` does not cover this: it is restricted to `assetType === "PERP" && cand.perpReduceOnly === true`.

**Concrete failure.** Source trader sells their whole NVDA position. The follower's mirror sell is sized, clamped to their held long, inserted PENDING, and `client.createOrder` throws ECONNRESET; the delivery is requeued at +30s. Within that window order-sync ticks, gets a 404, and writes SYNCING. On the retry copy-mirror logs "skip: duplicate (already mirrored)", returns "duplicate", and marks the delivery completed. No sell is ever placed. The follower stays long a position the source exited, every log line and the delivery record report success, and the phantom SYNCING row with a null `placed_at` keeps counting against the daily cap forever, because `countMirrorsToday`'s fallback (`copy-mirror.ts:3074-3078`) excludes only REJECTED and CANCELLED. Order-sync then re-404s that row every 30 seconds indefinitely.

The timing favors order-sync rather than being a coin flip: `mirrorRetryDelayMs(1)` equals `POLL_INTERVAL_MS` (30s) and copy-mirror only evaluates due deliveries on its own 30s ticks, so the retry typically lands about 60s after the failure while order-sync gets one or two ticks in the gap. The same mechanism silently drops buy mirrors.

**Fix.** Both ends, and note the ordering constraint below.
1. `order-sync.ts:407-419`: branch on `isNotFoundError(err)`. A 404 on a row that has **no** `brokerOrderId` is positive evidence the order never reached the broker, which is the opposite of "we could not read the broker". Leave the row PENDING (record `syncReason` and bump `syncAttempts` if useful for observability) so the copy-mirror resume can still claim it. Keep the existing SYNCING write for genuine lookup failures and for rows that do have a broker id.
2. Optionally add an age floor so order-sync does not touch a PENDING row with a null `brokerOrderId` until it is older than a few copy-mirror retry backoffs, which removes the race rather than only its current outcome.
3. `copy-mirror.ts:1363`: extend the revival CAS at `:1287-1296` to cover a non-PERP row in SYNCING with a null `brokerOrderId`, resetting it to PENDING under the same compare-and-set, so historical stranded rows recover instead of being called duplicates.
4. `countMirrorsToday` (`copy-mirror.ts:3068-3078`): stop counting rows that have both a null `placed_at` and a null `broker_order_id`, so a phantom never consumes a cap slot.
5. Add a test that exercises both pollers against one order row. Today `order-reconciliation.test.ts:83-138` asserts the PENDING to SYNCING flip for an order the broker *does* have, and `copy-mirror.test.ts:2175` asserts the row stays PENDING on a transient failure. The two tests each pin half of a contradiction and no test crosses them.

**Ordering constraint:** fix 4.1 or 4.3 alone makes finding 2 far more reachable, because the reconciler interception is what currently absorbs most stranded sell resumes. **Land finding 2's clamp in the same change.**

---

## SHOULD FIX

### 5. Daily and per-order dollar caps apply to closing sells, and the skip permanently spends the one-shot exit

**What breaks.** `decideMirror` is called for buys and sells alike and applies both caps unconditionally:

```ts
// apps/worker/src/services/copy-mirror.ts:722-735
if (!withinDollarCap({ orderDollars, maxOrderDollars: c.maxOrderDollars })) {
  return { action: "skip", reason: "dollar-cap", clientOrderId, orderDollars, maxOrderDollars: c.maxOrderDollars };
}
if (!withinDailyCap({ mirrorsToday: c.mirrorsToday, dailyCap: c.dailyCap })) {
  return { action: "skip", reason: "daily-cap", clientOrderId };
}
```

`MirrorCandidate` has no closing flag at all, and `isClosingIntent` (`copy-mirror.ts:1428`) is used only for the consent exemption. The skip is returned out of `processCandidate` and the poll loop turns any returned outcome into `markDeliveryCompleted` (`copy-mirror.ts:959`), which is terminal: `loadDueDeliveries` selects only `status = "pending"`, and re-staging is blocked by the `(followerUserId, sourceItemId)` unique constraint plus the advanced checkpoint.

This contradicts the invariant the codebase states in three other places: `copy-mirror-consent.ts:322-338` ("a mirrored SELL is the equity equivalent of a reduce-only perp order"), the perp exemption at `copy-mirror-perp-execution.ts:451-455` ("an exit is not new exposure, and a daily cap must never be the reason a follower cannot get out"), asserted by `copy-mirror.test.ts:4810-4841`, and `docs/deployment/copy-mirror-env-reference.md:100`, which tells operators reduce-only closes are exempt on purpose. On the equity path that documentation is simply false.

**Concrete failures, three independent triggers.**
- *Daily cap.* An active source produces 20 mirrored buys in the morning, so `countMirrorsToday` returns 20 (it has no side predicate). In the afternoon the source closes one of those positions. The sell passes consent because closes are exempt, reaches `decideMirror`, `withinDailyCap({20, 20})` is false, and the exit is marked completed and gone.
- *Dollar cap, and it is worse than it looks.* The cap is evaluated on the **pre-clamp** notional, because `decideSellMirrorQty` runs only at `copy-mirror.ts:1593-1611`, after the skip has already returned. A follower holding 40 shares whose ratio-sized sell computes 100 shares at $12 is refused for a $1,200 notional, when the order that would actually have been submitted was 40 shares at $480, comfortably inside the cap. Percentage sizing reaches the same place whenever buying power has grown since the open.
- *`no-qty` on options.* `fetchOptionPrice` returns 0 when a sell has no positive bid, `computeMirrorQty` returns 0 for `price <= 0`, and the SellToClose is retired as `no-qty` while the long option rides to expiry.

**Fix.**
1. Add an explicit `closing: boolean` to `MirrorCandidate` (set from `cand.side === "sell"` for equity/option and from `perpReduceOnly` for perps) and skip guards (4) and (5) in `decideMirror` when it is true, matching `copy-mirror-perp-execution.ts:451-475`. Sizing and the sell clamp still apply, so an exempted close still cannot exceed the follower's actual long.
2. Independently, move the `withinDollarCap` check to after the sell clamp so the cap is always evaluated against the notional that will actually be submitted. That is correct even if you keep the cap on closes.
3. Make a close that fails for a *transient* reason retryable rather than terminal. For the `no-qty`-with-no-quote case specifically, throw with a retry code (as the daily-count-unavailable path already does with `08006`) so `markDeliveryFailed` requeues instead of `markDeliveryCompleted` retiring it.
4. Add equity tests for a SELL against each cap. The existing cap tests use buy candidates or the perp path, and the equity closing-sell tests stop at the consent gate before reaching `decideMirror`.

### 6. An equity close that finds no long is consumed even while its paired opening BUY is still queued

**What breaks.** `copy-mirror-close-pairing.ts` was written for exactly this hazard, and it is wired only into the perp path (`copy-mirror-perp-execution.ts:896-925`, `decidePerpCloseConsumption` with `loadQueuedSiblingDeliveries` and `pairedOpenOutcomeAmbiguous`). The module hard-excludes everything else: `copy-mirror-close-pairing.ts:130`, `if (open.assetType !== undefined && open.assetType !== "PERP") return false;`. The equity path does a bare terminal return:

```ts
// apps/worker/src/services/copy-mirror.ts:1596-1602
if (sellDecision.action === "skip") {
  logger.info(LOG_SERVICE, "[copy-mirror] skip: no-long-position", { ...auditBase, computedQty: decision.qty, heldLongQty });
  return "no-long-position";
}
```

`orderCandidatesBySourceEvent` fixes the ordering half of the problem, not the failure half: the due batch is loaded once and iterated in memory, so an OPEN that throws is requeued while the CLOSE later in the **same array** still runs against a position that does not exist yet.

**Concrete failure.** A followed trader buys 200 MSFT and sells 20 seconds later, both inside one 30s window. Both stage, and the buy is correctly ranked first. The buy is processed first and `client.createOrder` throws a transient 503, so the delivery is requeued for +30s. The sell is next in the same array: it is consent-exempt because it is a close, `fetchLongQty` returns 0 (`getPosition` 404 maps to 0 rather than throwing), and `processCandidate` returns "no-long-position", which `markDeliveryCompleted` retires permanently. Thirty seconds later the buy's retry succeeds and the follower is long 200 MSFT in a trade the source is already out of, with the only mirrored exit already spent. Every delivery reports success.

A strictly more common variant needs no failure at all: a market BUY placed milliseconds earlier in the same loop iteration has often not filled when `fetchLongQty` runs for the paired sell, so `getPosition` 404s and the exit is consumed on a fully successful pair.

**Fix.**
1. Generalize the pairing module rather than duplicating it. Drop the `assetType !== "PERP"` early return at `copy-mirror-close-pairing.ts:130` (keep the symbol, follower, source-item and timestamp-ordering tests, which are asset agnostic) and rename `decidePerpCloseConsumption` to something venue neutral.
2. Call it from the equity branch at `copy-mirror.ts:1596-1602` with the same inputs the perp path builds: `loadQueuedSiblingDeliveries(cand)` plus `pairedOpenOutcomeAmbiguous(cand)`. On `action === "defer"`, throw with a retry code so `markDeliveryFailed` requeues the close instead of `markDeliveryCompleted` retiring it, and log at warn as the perp path does.
3. Treat "a sibling open for this symbol was placed in this same cycle" as ambiguous, not resolved, so the no-failure variant (unfilled market buy, position not yet visible) also defers rather than consuming the exit.
4. Test with a two-row batch: a failing open followed by its paired close, asserting the close delivery is still pending afterwards.

---

## WORTH KNOWING

Non-defect facts that a fixer needs, and corrections to claims made during the audit.

- **Fix findings 2 and 4 together.** The reconciler flipping never-submitted rows to SYNCING is currently what absorbs most stranded equity sell resumes. Fixing 4 in isolation converts a silently dropped exit into a live naked-short path.
- **The dollar cap is evaluated before the sell clamp** (`decideMirror` at `copy-mirror.ts:722` versus `decideSellMirrorQty` at `:1593`). This affects finding 5 and is worth fixing even if the cap-on-closes decision goes the other way.
- **Phantom order rows consume daily-cap slots.** `countMirrorsToday`'s fallback at `copy-mirror.ts:3074-3078` excludes only REJECTED and CANCELLED, so a PENDING or SYNCING row with a null `placed_at` that never reached the broker counts all day.
- **Options are protected where equities are not.** `position_intent` is set only in the `assetType === "OPTION"` branch of the order request, so an option SellToClose carries a broker-enforced close instruction. Every equity finding above is equity-specific for this reason.
- **`countMirrorsToday` counts both sides.** It matches on `client_order_id LIKE 'copymirror:<user>:%'` with no side predicate, so mirrored exits consume the same budget as opens. That is the mechanism behind finding 5's daily-cap trigger.
- **`social_trades.qty` is an `integer` column.** A fractional mirror quantity would make the publish insert throw, and the throw is swallowed by the `try/catch` around it. That accidentally breaks finding 1's chain for fractional mirrors only; whole-share mirrors, the common case, publish cleanly. Do not rely on it.
- **Correction:** the equity PENDING-resume does **not** bypass the daily cap. The PENDING row from the first attempt is already inside `countMirrorsToday`, and the perp resume excludes its own row for exactly that reason (`copy-mirror-perp-execution.ts:445-455`).
- **Correction:** `MIRROR_MIN_ORDER_NOTIONAL_USD` (`packages/types/src/copy-mirror.ts:38`) is referenced only by `copy-mirror-perp-sizing.ts:49,165`. The Alpaca equity path has no notional floor, so a sub-$10 usd rule there produces a tiny or zero-share order rather than a clean skip.

---

## Checked and found sound

These were examined and either hold up or are intentional. They do not need re-auditing.

- **Idempotency and duplicate prevention.** `mirrorIdempotencyKey` (`apps/api/src/lib/copy-mirror.ts:146`), the `orders.client_order_id` unique index (documented at `packages/db/src/schema/orders.ts:305-309` as the atomic dedupe for the mirror worker), the `onConflictDoNothing` insert at `copy-mirror.ts:3193` plus the re-read guard at `:3196-3205`, and the `copy_mirror_deliveries` unique `(followerUserId, sourceItemId)` constraint. Overlapping cycles cannot double-place a given (follower, source trade).
- **Checkpoint and window advance.** `stageWindow`'s compare-and-set on `copy_mirror_checkpoints` (`copy-mirror.ts:1036-1048`, throwing `40001` on contention) correctly serializes staging, including across concurrent replicas. The multi-replica "two real orders for one mirror" hypothesis was investigated and refuted: the CAS runs before `loadDueDeliveries`, and the documented deployment is one replica (`docs/deployment/worker-railway.md:99-100`). A claim/lease on `copy_mirror_deliveries` is worth adding only if multi-replica ever becomes supported.
- **Stop and disarm semantics.** Disarm/unfollow stopping future discovery while leaving open positions untouched is deliberate, disclosed in a blocking confirmation on all three stop paths (`buildStopSummary`, `mirror-consent.ts:265-308`), and covered by `mirror-consent.test.tsx:483-495` and `:540-549`. Already-staged closes still drain. This was investigated as a stranding bug and refuted. One documentation nit: `docs/deployment/perps-auto-mirror-testnet-checklist.md:99-101` ("Turn auto-mirror off ... the close must still place") reads as if it means the per-follow flag when it means the deployment flag, and is worth one clarifying word.
- **Arming from the panel's inline Mirror switch binding to the terminal's active account** (`copy-trade-panel.tsx:953-955`) is intentional and tested (`copy-trade-follow.test.ts:172-178`), the switch is non-interactive until an account is chosen, the control carries a Live/Paper badge, and the arm dialog names the account. Investigated as a money-misrouting bug and refuted. The residual is a disclosure nuance only: the plain `arm` summary omits the `Moving from` line that the `repoint` variant emits, so a user re-arming a follow that had a different saved destination is not told it moved.
- **Perp close pairing, resume, and cap exemptions.** `copy-mirror-close-pairing.ts`, `copy-mirror-perp-resume-parity.ts`, and the reduce-only resume re-sizing in `copy-mirror-perp-execution.ts` are correct and well reasoned. Findings 2, 5 and 6 are all cases of the equity path lacking the protection the perp path already has.
- **Consent and staleness gates** (`copy-mirror-consent.ts`): credential ownership, follow re-read at execution time, the 15 minute equity intent bound, and the close exemption are coherent. The close exemption's stated justification depends on finding 2's clamp, which is the one hole.
- **`traderKey` hashing** (`apps/api/src/lib/trader-identity.ts`) and the follow-target shape emitted by `copy-trade.ts:263`: no identity leak found, and the key round-trips correctly between the feed and discovery.
- **Failure classification and retry backoff** (`classifyMirrorFailure`, `mirrorRetryDelayMs`, `markDeliveryFailed`): transient versus permanent classification is sound and the ambiguous-create handling in `packages/alpaca/src/client.ts:332-364` is correct (it rethrows the original error when the lookup proves the order never landed).
- **Live and mainnet gating**: `liveAllowed`, the paper/live split, the perps enable and mainnet opt-in checks, and the `EAGAIN` pause on the resume path all fail closed.
- **Cap helpers** `withinDailyCap` and `withinDollarCap` (`apps/api/src/lib/copy-mirror.ts:153-169`) fail closed on non-finite or non-positive inputs. The problem in finding 5 is where they are applied, not how they compute.

---

## What this audit could not establish

Honest limits. These need a real broker, a real venue, or production data.

- **Hyperliquid duplicate-cloid behavior.** Whether the venue rejects or accepts a resubmitted identical `cloid` is not determinable from this repository, and `copy-mirror-perp-rejection.ts:22-40` says so explicitly, claiming correctness under both behaviors. Several retry and resume paths lean on broker-side dedupe. Confirming it requires a testnet or mainnet submission of a duplicated cloid.
- **Alpaca's actual response to an unbacked market SELL** (finding 2). Whether a given account and symbol produces a naked short, a partial fill, or a rejection depends on margin status, the symbol's shortability and locate availability, and account-level settings that are not visible here. The code sends no reduce-only instruction, which is the defect; the exact broker outcome per account is not verifiable statically.
- **Real-world timing of the order-sync versus copy-mirror race** (findings 2 and 4). Both pollers are on 30s intervals in one process, and order-sync's cycle is unbounded sequential per-order broker round trips. Which one wins under production order volume, and how often, needs production timing data. The static analysis establishes both orderings are reachable, not their frequency.
- **How common mutual and chained auto-mirror follows are** (finding 1). The topology is unrestricted by the API and reachable directly from the feed UI, but the actual population of reciprocal follows with `shareTrades` on both sides is a production data question. The one-hop chain variant (A follows B, C follows A) needs no cycle at all.
- **Fill latency versus poll cadence** (finding 6's no-failure variant). Whether a market buy submitted milliseconds earlier is visible in `getPosition` when the paired sell runs depends on Alpaca fill and position propagation latency, which cannot be measured here.
- **Whether option quotes go absent often enough to matter** (finding 5's `no-qty` trigger). `fetchOptionPrice` returning 0 on a missing bid is confirmed in code; how often that happens for a real SellToClose, particularly around the open, close and illiquid strikes, requires live market data.
- **Historical data impact of finding 1.** How many `social_trades` rows already in the database are mirror-originated, and therefore how much the discovery-side filter (fix 1.2) needs to retro-exclude, requires a production query.