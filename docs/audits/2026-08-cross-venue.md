# Cross-Venue Hardening Report: Copy Trading Across Alpaca and Hyperliquid

Scope: the seam where perp copy trading and stock copy trading touch. Threat model: fully enabled, real money, `COPY_TRADE_AUTOMIRROR_ENABLED=true`, `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE=true`, `PERPS_ENABLED=true`, `COPY_TRADE_AUTOMIRROR_PERPS_ENABLED=true`, `PERPS_ALLOW_MAINNET=true`.

Findings survived three independent adversarial verifiers each. Twelve additional candidate findings were refuted during verification and are summarized under "Checked and found sound" so nobody re-reports them.

---

## MUST FIX BEFORE ENABLING PERPS

### 1. The manual Copy button turns a Hyperliquid perp into an Alpaca equity ticket

**Seam: symbol collision + guard asymmetry (manual path vs auto path).**

This is PR #176's defect reproduced on the surface PR #176 did not cover. The classifier fix (`classifySignalInstrument` -> `meta.mirrorableEquity = false`) was wired into `mapSignalToItem` only. The rows that come from real on-platform Hyperliquid fills go through `mapUserTradeToItem`, which carries the venue in `meta.assetType` and drops the veto.

The chain, every link read:

1. `apps/worker/src/services/hyperliquid-order-sync.ts:724-731` publishes a perp fill into the shared social feed: `assetType: "PERP"`, `side: updatedOrder.tradeAction === "Sell" ? "sell" : "buy"`. A long open lands as `side: "buy"`. Symbol is the bare Hyperliquid coin (`apps/api/src/lib/perp-orders.ts:216` `symbol: input.coin`).
2. `packages/db/src/schema/social-trades.ts:25` is `assetType: text("asset_type"), // "EQUITY", "OPTION"`. Free text, no enum, no CHECK. The comment is stale; `"PERP"` persists.
3. `apps/api/src/routers/copy-trade.ts:556-594` the user-source query filters on cursor and optional symbol only. No asset-type or venue predicate.
4. `apps/api/src/routers/copy-trade.ts:269` inside `mapUserTradeToItem`: `assetType: resolvedAssetType,` with no `mirrorableEquity` sibling. Repo-wide, `mirrorableEquity: false` is written in exactly one place, `copy-trade.ts:173`, inside `mapSignalToItem`.
5. `apps/web-v2/src/components/copy-trade/copy-eligibility.ts:30` `if (meta?.mirrorableEquity === false) {` plus a `side === "sell"` arm is the entire instrument veto. Nothing reads `meta.assetType`.
6. `apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx:786` `const isOption = item.meta?.assetType === "OPTION";` is the panel's only read of asset type. `copyDisabled` (:833-841) has no PERP term. Line 1034 hard-codes `assetType: isOption ? "OPTION" : "EQUITY",` and `CopyTradePayload` (:91) is typed `"EQUITY" | "OPTION"` with no PERP member.
7. `apps/web-v2/src/app/app/page.tsx:1255` `routeIfCrypto(symbol, "tradeSheet")` calls `symbolVenueRouter.resolveRoute(symbol)` with no venue argument, and `apps/web-v2/src/lib/hooks/use-symbol-venue-router.ts:70` defaults `currentVenue = "stocks"`. `apps/web-v2/src/lib/venue-routing.ts:52-54` then returns `"stocks"` for a both-venue ticker: `if (onEquityCatalog && onHlUniverse) { return input.currentVenue === "perps" && input.perpsEnabled ? "perps" : "stocks"; }`. `selectStockMarket` (page.tsx:799-805) does no catalog validation.

**Concrete scenario.** Trader T has `shareTrades: true` and opens a 10x long on the Hyperliquid SOL perp. The social row is `{symbol: "SOL", side: "buy", assetType: "PERP"}`. Any viewer of the default copy feed sees a card reading `$SOL` priced off the Alpaca SOL equity (`apps/api/src/routers/quotes.ts:684-709` calls `createMasterAlpacaClient().getSnapshot(sym)`), a green BUY badge, no perp indicator of any kind, and an enabled button reading `Copy N sh`. Click. Payload asset type is `EQUITY`. SOL is tagged `alsoEquity: true` (`apps/api/src/lib/markets/market-search.ts:300`, asserted at `apps/api/src/__tests__/market-search.test.ts:139`). Route resolves to stocks. The Alpaca equity ticket is prefilled BUY SOL, N shares, sized off the unrelated listed company's price. Submit buys the wrong company, on the wrong venue, with no leverage and no short capability.

**Scope, precisely.** HIP-3 dex-prefixed coins are incidentally safe: `xyz:GOOGL` is not an Alpaca ticker, `alsoEquity` is false, the route flips to perps, and the Alpaca snapshot returns `0.00` so `qty <= 0` disables the button anyway. Short opens and reduce-only closes map to `side: "sell"` and are blocked by the existing buy-only rule. What leaks is long opens and short covers on bare coins whose ticker collides with an Alpaca listing. The repo names that set itself: `market-search.ts:307` "names such as SOL and APT can collide with stocks", and `venue-routing.test.ts:87` carries `{ coin: "MSTR", alsoEquity: true }`.

**The asymmetry is exact.** The worker consuming the identical `social_trades` row does branch on venue: `apps/worker/src/services/copy-mirror-candidate-sources.ts:383` `const resolvedAssetType = normalizeAssetType(trade.orderAssetType ?? trade.assetType);` then `:393` `if (resolvedAssetType === "PERP") {` routes into the perp mirror with canonical-coin validation and an `orderVenue !== "hyperliquid"` reject. Same field, same row, guarded on the auto path and unguarded on the manual path.

**No test covers it.** `copy-eligibility.test.ts` has no `assetType: "PERP"` case; its user-trade case asserts `copyDisabledReason({ copiedFrom: "someone" })` returns null. `copy-trade-panel.test.ts` greps `assetType` only for the OPTION string. `apps/api/src/__tests__/copy-trade.test.ts:341-368` asserts a PERP user row maps through with no veto field, pinning the gap in place.

**Fix.**
- Server side, in `mapUserTradeToItem` (`apps/api/src/routers/copy-trade.ts:264-272`), set `mirrorableEquity: false` whenever `resolvedAssetType === "PERP"`. One line, and it immediately activates the existing UI veto and its tooltip.
- Client side, do not rely on that alone. Add an explicit `if (meta?.assetType === "PERP")` arm to `copyDisabledReason` (`copy-eligibility.ts`), so the gate reads the venue rather than a derived flag that only one of two mappers sets.
- Widen `CopyTradePayload.assetType` to include `"PERP"` and route a PERP payload through `handleCopyPerpSignal` (`page.tsx:1388-1418`), which already does the venue-correct thing for the x_signal feed and is currently wired only to `VenueAwareSignalFeed` via `onPerpCopyPrefill` (page.tsx:1771). `CopyTradePanel` gets only `onCopy={handleCopy}` (page.tsx:1810, 2449).
- Render a PERP badge on the row. Today the card is visually indistinguishable from an equity buy, so the deception starts before the ticket.
- Add the missing test: a user-sourced row with `meta.assetType: "PERP"` must produce a disabled Copy button.

Severity note: verifiers uniformly corrected critical to high because this is a prefill the follower must still submit, unlike the fully automatic worker-side PR #176 bug. It stays in MUST FIX because the ticker shown is identical to what the follower expects and nothing on the path discloses the venue change.

---

### 2. The attempt-ceiling exemption for closes is keyed on `perpReduceOnly`, so a mirrored equity exit is abandoned permanently

**Seam: cross-venue exits + guard asymmetry.**

`markDeliveryFailed` decides whether a delivery may outlive the retry ceiling from a single perp-only field.

`apps/worker/src/services/copy-mirror.ts:1262-1263`:
```
const reduceOnlyClose = row.candidate?.perpReduceOnly === true;
const exhausted = hasExhaustedDeliveryAttempts(attempts) && !reduceOnlyClose;
```
`MIRROR_MAX_DELIVERY_ATTEMPTS = 8` (`copy-mirror-consent.ts:41`). The non-exempt branch writes `status: "permanent_failure"`, `completedAt: now` (copy-mirror.ts:1291-1299).

`perpReduceOnly` is set in exactly two places, both Hyperliquid: `copy-mirror-candidate-sources.ts:484` `perpReduceOnly: trade.orderReduceOnly === true` inside the `resolvedAssetType === "PERP"` branch, and `copy-mirror-perp-execution.ts:909`. The Alpaca branch (candidate-sources ~530-580) stages `side: "sell"` and never sets it, and `stageWindow` freezes the candidate verbatim (`copy-mirror.ts:1176` `candidate: { ...candidate }`). So `reduceOnlyClose` is structurally always false for an equity exit.

Every other equity call site in the same subsystem treats a sell as a close:
- `copy-mirror.ts:1544` `const isClosingIntent = cand.side === "sell";`
- `copy-mirror-consent.ts:361` `if (input.closing) return { action: "proceed", closeExempt: true };`, whose doc block states "A mirrored SELL is the equity equivalent of a reduce-only perp order"
- `copy-mirror-close-pairing.ts:156-161` `isClosingDelivery` reads both venues: `perpReduceOnly === true` OR `assetType !== "PERP" && side === "sell"`, with the comment "An Alpaca order has no reduce-only flag, so `side === "sell"` is the exit there, which is the same reading every other equity call site takes."

`markDeliveryFailed` is the single outlier, at the exact point where the queue decides whether to give up.

**Concrete scenario.** The mirror opens 100 shares for a follower. The trader exits; a `side: "sell"` delivery is staged. `classifyMirrorFailure` (copy-mirror.ts:437-491) marks 408/409/425/429/>=500, `EAGAIN`, and unknown-shape errors transient; `mirrorRetryDelayMs` is `min(30s * 2^(n-1), 15min)`, so attempts 1 through 7 span about 46 minutes. On attempt 8, `hasExhaustedDeliveryAttempts(8)` is true and `reduceOnlyClose` is false. The row is written `permanent_failure` with `completedAt` set. Nothing regenerates it: the delivery insert is a single site (`copy-mirror.ts:1170`) inside the transaction that advances the checkpoint, with `onConflictDoNothing` against `unique(follower_user_id, source_item_id)` (`packages/db/src/schema/copy-mirror-state.ts:56-60`), `loadDueDeliveries` reads only `status = "pending"`, and no code path anywhere resets `attempts` or resurrects `permanent_failure`. The follower is left holding a position the mirror opened with its only exit instruction destroyed. The identical Hyperliquid close in the same outage retries indefinitely at one attempt per 15 minutes.

**No outage required.** The equity close path deliberately throws `EAGAIN` and depends on this retry loop in three places: unreadable exposure (`copy-mirror.ts:1546-1566`), paired-open hold (`:2633-2636`), unpriceable exit (`:1975-1979`). `fetchOptionPrice` reads the bid, so an illiquid or after-hours `SellToClose` with no resting bid burns the whole 46-minute budget on a normal market condition and lands in `permanent_failure`.

**Compounding.** `readDeferredCloseBacklog` filters `candidate->>'perpReduceOnly' = 'true'` (`copy-mirror.ts:1333`), so a stuck or abandoned equity exit is also invisible to the only operator-facing queue monitor. Abandoned and unmonitored.

**The same asymmetry appears a second time.** The PENDING-order revival at `copy-mirror.ts:1706-1710` is gated on `existing.assetType === "PERP" && cand.perpReduceOnly === true`.

**Fix.** Replace the perp-only predicate with the venue-generic one that already exists in this codebase:
```
const reduceOnlyClose = isClosingDelivery({
  assetType: row.candidate?.assetType,
  side: row.candidate?.side,
  perpReduceOnly: row.candidate?.perpReduceOnly,
});
```
`isClosingDelivery` is exported from `copy-mirror-close-pairing.ts:156` and already reads both venues correctly. Then widen `readDeferredCloseBacklog`'s filter the same way so equity exits burning down their budget show up on the operator dashboard. Add the mirror of `copy-mirror-durability.test.ts:334-354` ("never abandons a reduce-only close at the ceiling") for an `assetType: "EQUITY", side: "sell"` candidate; note that existing test fabricates its case by attaching `perpReduceOnly: true` to an EQUITY fixture, so it does not cover the real shape.

---

### 3. An equity exit is re-sized from the follow's OPEN rule, so one `sizing_mode` column means two different things on exit

**Seam: shared units + cross-venue exits.**

One database column, `copy_trade_follows.sizing_mode` (`packages/db/src/schema/copy-trade-follows.ts:36`), drives both venues. `copy-mirror-candidate-sources.ts` reads `follow.sizingMode` off the same `userFollowsByKey` match at `:462` for the PERP candidate and `:556` for the EQUITY candidate. On exit, the two venues interpret it differently.

**Perp exit** (`copy-mirror-perp-decisions.ts:157-171`): for every non-ratio mode,
```
: candidate.sourcePositionSizeDecimal
  ? proportionalDecimal(candidate.sourceSizeDecimal, candidate.mirroredExposureSizeDecimal, candidate.sourcePositionSizeDecimal, candidate.sizeDecimals)
```
which is `mirroredExposure * (sourceClosed / sourcePosition)`. A 100% source exit closes 100% of the mirrored size. `sourcePositionSizeDecimal` is supplied at `copy-mirror.ts:3247-3249` from the reconstructed pre-close source position.

**Equity exit** (`copy-mirror.ts:1907-1927` -> `:723-736`): `decideMirror` passes `sizingMode` and `sizingValue` straight into `computeMirrorQty` exactly as a BUY does. `apps/api/src/lib/copy-mirror.ts:116-131`: `usd` mode is `targetDollars = input.sizingValue` then `Math.floor(targetDollars / (price * multiplier))`, priced from the live quote (`copy-mirror.ts:3646` `client.getLatestTrade`). `ComputeMirrorQtyInput` has no side, no source position size, and no mirrored-exposure field, so nothing there can be proportional. The two things applied afterwards are pure downward clamps that can only reduce:
- `copy-mirror.ts:1994` `const sellDecision = decideSellMirrorQty(decision.qty, heldLongQty);` -> `:833` `Math.min(computedQty, Math.floor(heldLongQty))`
- `copy-mirror.ts:2027` `const attributed = clampSellToMirroredExposure(sellDecision.qty, mirroredLongQty);` -> `:936` `Math.min(sellQty, mirroredLongQty)`

**Concrete scenario.** Follow row: `sizingMode: 'usd'`, `sizingValue: 900`. Mirror opens $900 of XYZ at $9, i.e. 100 shares. XYZ runs to $45. The source fully exits. `computeMirrorQty` returns `floor(900 / 45) = 20`. `decideSellMirrorQty(20, 100) = 20`. `clampSellToMirroredExposure(20, 100) = 20`. Twenty shares sell. The follower keeps 80 shares of a position the source is completely out of. The delivery is marked `completed` (`copy-mirror.ts:1113`), and the unique `(follower_user_id, source_item_id)` constraint means the close is one-shot. The identical follow row on Hyperliquid closes the full mirrored size.

**Direction of failure is systematically wrong.** If price falls, `floor(900/price)` exceeds the holding and the clamp produces a full exit. Losers close completely; winners are left partially open. The default mode is `pct` (schema default), which recomputes from exit-time buying power and is essentially never the mirrored size. On a 10% partial source exit the divergence runs the other way: the perp closes 10% of mirrored exposure while the equity sells `sizingValue` dollars' worth, which at an unchanged price is the entire position. Only `ratio` is consistent across venues, because both size it as ratio times source qty.

**Nothing reconciles it later.** No residual/sweep/flatten path exists in `apps/worker/src`; `copy-mirror-close-pairing.ts` only defers closes that found no exposure at all, never a partially filled exit.

The in-tree acknowledgement is the doc on `decideSellMirrorQty` at `copy-mirror.ts:812`, "A mirrored SELL is sized like a buy by decideMirror", which states the behavior rather than guarding against it.

**Fix.** Give the equity close the same proportional sizing the perp close has. The exposure ledger already exists and is already read on every sell: `mirroredEquityExposure` (`copy-mirror.ts:2695-2797`) returns `qty`, and the perp path's third input, source position size before the close, is the only missing piece. Add `sourcePositionQty` to the equity candidate in `copy-mirror-candidate-sources.ts` alongside the existing `sourceQty`, then size a close as `mirroredLongQty * (sourceQty / sourcePositionQty)` clamped by the two existing ceilings, falling back to a full exit of mirrored exposure when the source position size is unavailable. Do not simply size closes as "all mirrored exposure": that would over-exit on partial source closes, which is the other half of the divergence. Existing tests encode the gap and will need updating: `copy-mirror-sell-attribution.test.ts:167-175` builds its sell fixture as `sizingMode: "usd", sizingValue: 5_000` with the comment "$5,000 at $100 a share is 50 shares", and every case there has rule-qty >= mirrored exposure. The inverse case is absent from the entire suite.

---

## SHOULD FIX

### 4. `perpCopyPayload` guesses a Hyperliquid coin from the uppercased equity ticker

**Seam: symbol collision + guard asymmetry (worker refuses, UI guesses).**

`apps/web-v2/src/components/feed/signal-perp.ts:84`:
```
const coin = readString(meta, "hlTicker") ?? fallbackSymbol.trim();
```
`fallbackSymbol` is `signal.symbol` (`signal-groups.ts:154`), which is equity-normalized at ingest: `paste-trade-poller.ts:88-92` `pasteTradeTickerSchema = z.string()...regex(/^[A-Za-z0-9./-]+$/)...transform((val) => val.toUpperCase())`. Case is destroyed and `:` cannot survive.

`packages/hyperliquid/src/coin.ts:31-36` states the exact opposite rule for this input: case is meaningful, `KPEPE` is not an alias of `kPEPE`, and `xyz:GOOGL` and a bare `GOOGL` are different markets so substituting one for the other is a wrong-market order, not a near miss.

The worker follows that rule and refuses. `copy-mirror-candidate-sources.ts:649-656` carries the comment "There is deliberately NO fallback to `signal.symbol`", then `const coin = parseCanonicalPerpCoin(rawCoin); if (!coin) { ... skip: unusable-perp-coin }`. The UI, on the same row, guesses.

The triggering state is reachable, not defensive dead code. `paste-trade-poller.ts:463` writes `hlTicker: parseCanonicalPerpCoin(row.hl_ticker)`, which is null whenever upstream sends a missing or non-canonical coin, and `processBoard` (`:726-747`) only warns ("Dropping non-canonical hl_ticker") before inserting the row with platform, instrument, direction and leverage intact. `classifySignalInstrument` then returns `perpVenue = true` and the feed renders a perp chip. The fallback is locked in by `apps/web-v2/src/components/feed/signal-perp.test.ts:63-68` ("falls back to the signal ticker when hlTicker is absent").

**How bad it actually is.** Verifiers narrowed this substantially and it belongs here rather than in MUST FIX. Hyperliquid's own lookup is exact-match: `packages/hyperliquid/src/client.ts:94-119` keys the asset cache by `asset.name`, and `:465-472` `resolveAsset` throws `HyperliquidUnknownCoinError` on a miss. So `GOOGL` guessed from `xyz:GOOGL`, and `KPEPE` guessed from `kPEPE`, both fail closed: a rejected order and a perps ticket parked on an unresolvable coin, not a wrong fill. `apps/api/src/lib/perp-orders.ts:44` `perpCoinSchema = z.string().trim().min(1).max(20)` adds no canonicalization but also no charset that would change this. And the copy is a prefill only: `page.tsx:1408-1415` seeds side, leverage and coin but no size, and `perp-form-math.ts:266` `PERP_REVIEW_LEVERAGE_THRESHOLD = 10` forces the review dialog at 20x.

The residual money case is real but narrow: a name listed on both the main dex and a builder dex, where the guess silently lands on the wrong one. The user cannot detect it because `perpDisplayCoin` (`ticker-chart-action.ts:23-30`) strips the dex prefix in the market header, orders panel, positions and fills, so `xyz:SPX` and main-dex `SPX` render identically at the point of decision.

**Fix.** Do what the other two paths already do. Run the fallback through the perp universe index (the same index `venue-routing.ts:78-88` uses, which returns `canonicalPerpSymbol` and is tested at `venue-routing.test.ts:111` to preserve `kPEPE`), or through `parseCanonicalPerpCoin` plus a universe membership check, and return null instead of guessing. Note `parseCanonicalPerpCoin` currently has zero call sites in `apps/web-v2` or `apps/api`. Update `signal-perp.test.ts:63-68`, which currently asserts the wrong behavior. Separately, consider showing the dex prefix in the perp ticket header so a wrong-market prefill is visible.

---

### 5. Arming consent says "% of your buying power" for a Hyperliquid destination

**Seam: shared units + UI.**

`apps/web-v2/src/components/copy-trade/mirror-sizing.ts:83`:
```
if (mode === "pct") return `${value}% of your buying power`;
```
`describeSizePerOrder` takes only `(mode, value)`. `mirror-consent.ts:198-201` puts it in the arming facts unconditionally, while `:213` `showPerpDisclosure: input.destinationProvider === "hyperliquid"` is the only venue branch. The provider is available and dropped.

The bases are genuinely different concepts:
- Alpaca: `apps/api/src/lib/copy-mirror.ts:110` `targetDollars = (clampedPct / 100) * buyingPower;` fed by `copy-mirror.ts:1893` `parseFloat(account.buying_power)`. `apps/api/src/routers/positions.ts:719` comments that buying power is margin-inflated, 2x or 4x equity.
- Hyperliquid: `copy-mirror-perp-decisions.ts:244-252` `const percentBase = c.sizingMode === "pct_equity" ? c.accountValueUsd : c.freeCollateralUsd;` then `targetNotional = (min(sizingValue,100)/100) * percentBase`, where free collateral is `accountValue - marginUsed` (`copy-mirror-perp-sizing.ts:81-90`) with no inflation.

`pct` is the schema default with `sizingValue` default 5, and nothing gates sizing mode by provider: `apps/api/src/routers/copy-trade-follows.ts:44-66` keys `SIGNING_BOUNDS` / `validateSizingForMode` by mode alone, taking no credential or provider argument, and `requireOwnedMirrorCredential` (:105-146) checks provider and account type only. So an untouched follow pointed at a Hyperliquid credential arms on exactly this sentence.

Nothing corrects it downstream: the five items in `PERP_MIRROR_DISCLOSURES` (`perp-mirror-disclosure.tsx:34-60`) cover leverage source, missing exits, liquidation and account-level writes, not the sizing base. The phrase also leaks into the row line at `manage-follows.tsx:734`.

**The escalation half of the original claim does not hold, and that is why this is SHOULD FIX.** `copy-mirror-perp-sizing.ts:185-193` `const requiredMarginUsd = bounds.highUsd / leverage; return requiredMarginUsd <= freeCollateralUsd * headroom;` with `MIRROR_PERP_MARGIN_HEADROOM = 0.995`. At `pct = 100` the perp target notional equals free collateral, so required margin is notional divided by leverage, not the whole account. At leverage 1 the order is skipped outright for insufficient margin. Maximum reachable perp exposure under `pct` is 1x free collateral, strictly more conservative than the same words on Alpaca. The misstatement errs toward under-sizing.

**The repo's own standard makes this an oversight, not a simplification.** `ticket-context-row.tsx:10-16` says the two venues share a row "but the VALUES are the caller's problem, because they are not the same concept". `manage-follows.tsx:715-720` already suppresses the Alpaca dollar projection for a Hyperliquid follow, commenting "perp sizing scales free cross collateral with leverage, so there is no honest dollar figure to print here at all", with a regression test at `mirror-consent.test.tsx:1241`. And two lines below the defect, `describeDailyCap` (`mirror-consent.ts:249-261`) was explicitly rewritten to say "across Alpaca and Hyperliquid together" for exactly this class of cross-venue misstatement. The sizing sentence in the same fact list never got that treatment.

**Fix.** Give `describeSizePerOrder` the `destinationProvider` argument the summary already holds and branch the wording: "% of your free collateral" for Hyperliquid, "% of your buying power" for Alpaca. Same for the mode-tab labels at `mirror-sizing.ts:41-42` (`label: "Buying power"`, `caption: "% of buying power"`), which carry Alpaca-only wording into the sizing tabs on both venues. Note the existing test `mirror-consent.test.tsx:1130` asserts `expect(facts["Size per order"]).toBe("5% of your buying power")` under `destinationProvider: "hyperliquid"`, so it pins the wrong wording and must be updated with the fix. Also reconcile with `perp-size-presets.ts:174`, where the manual perp ticket says "of buying power" for `free * headroom * leverage`, a third meaning of the same phrase.

---

## WORTH KNOWING

The daily mirror cap is one budget per follower, shared by every armed follow and by both venues. `countMirrorsToday` (`copy-mirror.ts:3713-3756`) filters only on `userId`, today's window, and `like(orders.clientOrderId, 'copymirror:${followerUserId}:%')`, with no venue, asset-type or follow predicate, and perp rows carry the same prefix (`apps/api/src/lib/perp-orders.ts:239`). This is deliberate and correctly disclosed: `mirror-consent.ts:253-257` reads "shared by every follow you have armed, across Alpaca and Hyperliquid together", pinned by `mirror-consent.test.tsx:545`. It is listed here only because a busy perp morning throttling afternoon stock opens is surprising if you have not read the consent text, and because two separate audit passes flagged it before confirming it is by design. It fails safe: opens are capped on both venues, exits are exempt on both, so it can never strand a position.

---

## GUARD ASYMMETRY TABLE

| Guard | Equity / Alpaca path | Perp / Hyperliquid path | Verdict |
|---|---|---|---|
| Instrument veto on the AUTO-mirror path | `isMirrorableAsset` EQUITY/OPTION, candidate-sources:100 | `resolvedAssetType === "PERP"` branch + `orderVenue !== "hyperliquid"` reject, candidate-sources:383-417 | Deliberate, both present |
| Instrument veto on the MANUAL Copy path, signal rows | `mirrorableEquity: false` via `classifySignalInstrument`, copy-trade.ts:164-175 | same flag blocks perp signals | Deliberate, present |
| Instrument veto on the MANUAL Copy path, user rows | **absent** (`mapUserTradeToItem` never sets the flag, copy-trade.ts:264-272) | n/a, the row IS the perp | **GAP, finding 1** |
| PERP badge / venue indicator in the copy feed | Option badge only, copy-trade-panel.tsx:918 | none | **GAP, finding 1** |
| Coin canonicalization on the manual perp copy | n/a | **absent**, guesses from uppercased equity ticker, signal-perp.ts:84 | **GAP, finding 4** |
| Coin canonicalization on the auto path | n/a | `parseCanonicalPerpCoin`, no fallback, skip `unusable-perp-coin`, candidate-sources:649-656 | Deliberate, present |
| Attempt-ceiling exemption for closes | **absent** (`perpReduceOnly` is never set on equity), copy-mirror.ts:1262 | present, retries indefinitely | **GAP, finding 2** |
| Deferred-close operator backlog visibility | **absent**, filter is `perpReduceOnly = 'true'`, copy-mirror.ts:1333 | present | **GAP, finding 2** |
| PENDING revival for a re-armed close | **absent**, gated `assetType === "PERP" && perpReduceOnly`, copy-mirror.ts:1706 | present | **GAP, finding 2** |
| Close sizing proportional to source exit | **absent**, re-runs the open rule then clamps down, copy-mirror.ts:1994/2027 | `proportionalDecimal`, perp-decisions.ts:158-171 | **GAP, finding 3** |
| Sizing-base wording in the arming consent | "% of your buying power", correct | same string, wrong base, mirror-sizing.ts:83 | **GAP, finding 5** |
| Consent exemption for closes | `if (input.closing) proceed closeExempt`, consent.ts:361 | same exemption, copy-mirror.ts:2285 | Deliberate, symmetric |
| Staleness bound exemption for closes | exempt | exempt | Deliberate, symmetric |
| Per-order dollar cap | opens only, `!isClosingIntent`, copy-mirror.ts:767 | no cap on `decidePerpReduceOnlyMirror` | Deliberate, symmetric |
| Daily mirror cap | opens only, copy-mirror.ts:781 | opens only, perp-decisions.ts:286 | Deliberate, symmetric, shared counter |
| Daily cap on the resume path | buy branch only, copy-mirror.ts:1837 | `if (!resumeReduceOnly)`, perp-execution.ts:454 | Deliberate, symmetric |
| Mirrored-exposure attribution ceiling on a close | `clampSellToMirroredExposure` + `mirroredEquityExposure`, copy-mirror.ts:929/2695 | `mirroredExposureSizeDecimal` required | Deliberate, symmetric |
| Close routed to the account that received the open | `exposure?.credentialId ?? cand.credentialId`, copy-mirror.ts:1571 | `mirroredExposureCredentialId` | Deliberate, symmetric |
| Ambiguous exposure defers instead of resolving to zero | EAGAIN on `spans-accounts` / `scan-saturated`, copy-mirror.ts:1546 | EAGAIN on `ambiguous`, copy-mirror.ts:2172 | Deliberate, symmetric |
| Close held while its paired open is still queued | `holdEquityCloseIfPairedOpenQueued`, copy-mirror.ts:2593/2601 | via `executePerpCloseMirror`, perp-execution.ts:902 | Deliberate, symmetric |
| `openOutcomeAmbiguous` input to the pairing guard | **not passed**, copy-mirror.ts:2612-2619 | passed | Deliberate, documented, no Alpaca equivalent exists |
| Live-long re-clamp on a PENDING resume | `fetchLongQty` + `decideSellMirrorQty`, copy-mirror.ts:1743 | re-clamp to live position | Deliberate, symmetric |
| Attribution re-derived on a PENDING resume | **not re-derived**, copy-mirror.ts:1735-1742 | not re-derived | Deliberate, documented, re-reading would net the row against itself |
| Credential-reconnection fallback on a close | **absent** | falls back to the current registered agent, copy-mirror.ts:2247 | Defensible asymmetry: an HL reconnect is the same wallet, an Alpaca reconnect may be a different brokerage account |
| Reconciler single-flight + scan cap | **absent** in `order-sync.ts:256`, present in `external-fill-sync.ts:439` | present, hyperliquid-order-sync.ts:278/320 | Per-poller omission, not a venue seam (see below) |
| Compare-and-set on the reconciler write | absent, write is absolute values from a fresh fetch | present, write extends cumulative state | Deliberate, driven by write shape not venue |

---

## CHECKED AND FOUND SOUND

Each of these was investigated as a suspected cross-venue defect and refuted with code. Listed so they are not re-reported.

- **Equity SELL attribution.** `clampSellToMirroredExposure` (`copy-mirror.ts:929-937`) plus `mirroredEquityExposure` (`:2695-2797`, scanning `copymirror:${followerUserId}:%` and netting per broker account) is a full equity counterpart to the perp `mirroredExposureSizeDecimal` requirement, wired at `:2026-2044` with `placeQty = attributed.qty`. A copied close cannot touch hand-bought shares. Covered by `copy-mirror-sell-attribution.test.ts:264-277`. Rejected/cancelled opens net to zero (`mirroredEquityRowQty`, `:872-886`), and option rows are matched on expiration, strike and type so a mirrored $300 call cannot license selling the follower's own $250 calls.
- **Equity resume path naked-short risk.** The PENDING resume branch (`copy-mirror.ts:1690`) re-reads `fetchLongQty` and re-clamps at `:1743-1744`, persists the clamp with a status-scoped UPDATE and `throw ... { code: "EAGAIN" }` if zero rows matched (`:1790-1809`), because `placeMirrorOrder` resubmits the row's quantity on client-order-id conflict. Regression coverage at `copy-mirror-resume-sell-clamp.test.ts:276`.
- **Close-pairing guard on the equity path.** `decidePerpCloseConsumption` has two callers, not one: the second is `holdEquityCloseIfPairedOpenQueued` (`copy-mirror.ts:2593/2601`), invoked before every equity close skip return (`:1750`, `:1764`, `:2000`, `:2032`, `:2047`). `copy-mirror-close-pairing.ts` is venue-generic throughout: `isClosingDelivery` reads the equity exit marker and `UNSATISFIED_CLOSE_REASONS` includes the equity-only `"no-long-position"` and `"no-mirrored-exposure"`. Covered by `copy-mirror-equity-close-pairing.test.ts`.
- **Daily and dollar caps consuming equity exits.** Both guards are gated on `!isClosingIntent` (`copy-mirror.ts:767`, `:781`), on the fresh path and the resume path alike, matching the perp reduce-only exemption. Regression suite at `copy-mirror-cap-exempt-close.test.ts:248-292`.
- **Equity close routing after a repoint.** `const isClosingIntent = cand.side === "sell"; const exposure = isClosingIntent ? await this.mirroredEquityExposure(cand) : null;` and `destinationCredentialId = exposure?.credentialId ?? cand.credentialId` (`copy-mirror.ts:1544-1571`) route an exit to the account that received the open, not the account the follow now points at. Asserted at `copy-mirror-sell-attribution.test.ts:428-444`. `spans-accounts` defers via EAGAIN rather than misrouting.
- **x_signal OPTION branch bypassing the classifier.** The bypass exists (`candidate-sources:725`) but is not exploitable: `parseOptionSignal` requires an explicit BTO/STC token, exactly one strike, exactly one future expiry and a matching underlying, and rejects `STO/BTC/SHORT` outright (`option-signal-parser.ts:36`, `:194`, `:199`, `:226-231`, `:241-244`). Everything else returns `unsupported` and is skipped. The only reachable outcome mirrors an explicitly written option leg with an explicitly written side.
- **Daily-cap consent copy.** `describeDailyCap` already discloses the shared cross-venue budget verbatim, pinned by `mirror-consent.test.tsx:545`.
- **Manage-follows dollar projection for a Hyperliquid follow.** Gated on credential identity (`manage-follows.tsx:722-739`), and `balancesCredentialId` is Alpaca-only end to end, so a perp follow always takes the early return. Regression test at `mirror-consent.test.tsx:1241`.
- **Alpaca reconciler re-entrancy.** `order-sync.ts:256` genuinely lacks a single-flight flag and a scan cap, and the compare-and-set asymmetry against `hyperliquid-order-sync.ts` is real. But it is not a venue-seam defect: the two scans are row-disjoint (`ne(assetType, "PERP")` vs `eq(venue, "hyperliquid") + eq(assetType, "PERP")`), the Alpaca write is absolute values re-derived from a fetch issued one microtask earlier so a stale write requires a single response to stall longer than the 30s cycle, the HL CAS defends a cursor accumulation plus an exactly-once insert that Alpaca does not have, and `mirroredEquityRowQty` values unsettled rows at their request so the copy-trade consumer is immune to a status flap. The other Alpaca poller (`external-fill-sync.ts:439`) has both missing guards, making this a per-poller omission. Worth fixing on its own merits (duplicate Discord fill alerts, unbounded cycles amplified by an unfiltered `withRetry` on 404s), just not in this audit.

---

## WHAT THIS AUDIT COULD NOT ESTABLISH

- Whether a HIP-3 builder dex actually lists a coin whose bare name also exists on the main dex (for example a builder `xyz:SPX` alongside a main-dex `SPX`). That collision is the only remaining money-losing case for finding 4, and the repo's own fixtures do not contain one. It needs a live universe fetch against a real Hyperliquid deployment.
- The real-world frequency of the finding 1 collision set. `market-search.ts` names SOL and APT and `venue-routing.test.ts` carries MSTR, but the full intersection of the Hyperliquid main-dex universe with the Alpaca equity catalog can only be enumerated against both live catalogs.
- Whether Alpaca's transient error rate ever sustains for the roughly 46 minutes needed to exhaust the eight-attempt ceiling in finding 2 on the outage path. The no-bid option path reaches it with no outage at all, so the finding stands regardless, but the outage variant's likelihood needs production telemetry.
- Actual fill behavior of a wrong-market perp order. Everything here is reasoned from `resolveAsset`'s exact-match lookup; whether the exchange rejects identically under load, and what a partial fill on a substituted market does to the exposure ledger, needs a funded testnet account.
- Whether `permanent_failure` deliveries are being generated in production today. The status is terminal and unmonitored for equities (finding 2), so the only way to know is to query the table on a live database.