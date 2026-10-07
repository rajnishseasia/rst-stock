# Hyperliquid perps copy-mirror hardening audit

Scope: the Hyperliquid perps half of copy trading only. Threat model assumed throughout: `PERPS_ENABLED=true`, `COPY_TRADE_AUTOMIRROR_PERPS_ENABLED=true`, `PERPS_ALLOW_MAINNET=true`, real leverage, real money, mainnet. Branch `fix/copy-trade-auto-mirror-hardening` at HEAD; nothing already fixed in `cbcf236..HEAD` is reported here. Vendor documentation is treated as authority; every finding names the statement the repo disagrees with.

---

## 1. The HIP-3 collateral question

The repo records this as the thing that blocks mainnet (`docs/deployment/perps-auto-mirror-testnet-checklist.md:52-76`, "Does the main-dex cross-margin summary actually back a HIP-3 order?", with the note that the repo "cannot prove it: it is venue behaviour"). The vendor docs do answer it, and they answer it in two parts. One part goes the repo's way. The other does not.

### 1.1 Does the collateral pool exist across dexes? Yes, in exactly the two modes the gate requires

Hyperliquid, `/trading/margining`, "HIP-3 Margin Modes": *"For unified account and portfolio margin, the user's cross margin positions in DEXs with the same collateral all share margin. For standard abstraction, cross margin only applies to the assets within the same DEX."*

`/trading/account-abstraction-modes` names the trade.xyz dex explicitly under unified account: *"single balance for each asset. This balance collateralizes all cross margin positions in that asset and is unified with spot balance in that asset. For example, USDC balance is the single source for validator-operated perps, XYZ perps, and spot trading against USDC as a quote asset."*

So `isDexAbstractionReady`'s refusal of standard/manual mode (`copy-mirror-consent.ts:183-187`, gated by `perpDexModeReady` at `copy-mirror.ts:2970-2991`) is correct and matches the venue rule. The pooling premise the sizing path depends on is real for `unifiedAccount` and `portfolioMargin`.

### 1.2 Is the main-dex `crossMarginSummary` how you read that pool? No, and the venue says so on the endpoint page itself

Hyperliquid, `/for-developers/api/info-endpoint/perpetuals`, directly under "Retrieve user's perpetuals account summary" (the endpoint the repo calls): *"Under unified account or portfolio margin, use spot balances endpoint instead for trading account balance across spot and perps."*

`/trading/account-abstraction-modes`, API integration details: *"For API users, unified account and portfolio margin show all balances and holds in the spot clearinghouse state. Individual perp dex user states are not meaningful."*

The venue's own reference implementation on that page, `computeUnifiedAccountRatio`, takes its collateral base from the spot balance per token and charges it with `crossMaintenanceMarginUsed` summed over every perp dex state plus isolated `marginUsed`. It never reads any perp dex's `accountValue`.

The repo does the opposite. `perpAccountSnapshot` sets `crossMargin: readCrossMargin(mainState)` from a single `clearinghouseState(address)` with no `dex` argument (`packages/hyperliquid/src/client.ts:901`, `:1001`), and `readCrossMargin` (`client.ts:1474-1485`) is a raw pass-through of `crossMarginSummary.accountValue` and `.totalMarginUsed`. `freeCrossCollateralUsd` (`copy-mirror-perp-sizing.ts:81-92`) subtracts one from the other. That figure is consumed at `copy-mirror-perp-execution.ts:1062` on the open path and `:330` on the resume path, is the `pct` sizing base at `copy-mirror-perp-decisions.ts:244`, and is the only input to `withinPerpMarginCapacity` (`copy-mirror-perp-sizing.ts:179-196`), the sole guard bounding how much leveraged exposure a mirror may open. `crossAccountValueUsd(snapshot.crossMargin)` (`execution.ts:1065`) is the `pct_equity` base from the same summary.

**Answer to the checklist question: the pool exists, and main-dex `crossMarginSummary` is not how to read it.** The repo's open question was scoped to whether the pool exists. The actual gap is the endpoint.

### 1.3 Empirical confirmation, mainnet

Measured during this audit against `https://api.hyperliquid.xyz/info`, address `0xa87a233e8a7d8951ff790a2e39738086cb5f71b7`, `userAbstraction` returning `"unifiedAccount"`. Values drifted between samples (live account); sign and magnitude were stable across them:

| Read | Value |
|---|---|
| perp `crossMarginSummary.accountValue` | ~3,346,860 |
| perp `crossMarginSummary.totalMarginUsed` | ~4,493,691 |
| `freeCrossCollateralUsd()` therefore returns | **~ -1,146,830** |
| spot `USDC.total` | ~6,504,121 |
| spot `USDC.hold` | ~4,493,691 |
| actual free collateral | **~ +2,010,430** |

The spot `hold` matched the perp `totalMarginUsed` to the cent in one sample and to 0.013% in another. That is direct evidence that the margin the repo subtracts is held against a spot balance the perp `accountValue` does not contain. The venue's own `tokenToAvailableAfterMaintenance[USDC]` reported ~6,272,478 available on the same account. The repo computes minus 1.15M.

The two terms of `accountValue - totalMarginUsed` are drawn from different ledgers under these modes, so the result is not free collateral in either direction. The measured case fails closed (every mirror skipped `insufficient-margin` at `copy-mirror-perp-decisions.ts:215-217`, silently, forever, for exactly the accounts the HIP-3 gate declares eligible). A regime in which it overstates is derivable (large unrealized profit relative to posted margin) but was not reproduced live. Documentation does not settle which occurs on an arbitrary account.

### 1.4 The blast radius is not limited to HIP-3

`perpDexModeReady` returns `true` unconditionally when `!requiresDexAbstraction(ctx.coin)`, and `requiresDexAbstraction` is only `coin.includes(":")` (`copy-mirror-consent.ts:190`). So a follower sitting in `unifiedAccount` has **every** plain-coin mirror (BTC, ETH, HYPE) sized from the main perp-dex summary with no mode check at all. For dex-prefixed coins the mode check exists but runs at `copy-mirror-perp-execution.ts:1138-1146`, after `decidePerpMirror` at `:1085`. Sizing happens before the mode is ever queried.

The product actively creates this state. `apps/api/src/routers/orders.ts:2113` calls `client.ensureDexAbstraction(walletAddress)` for any coin containing `:`, which posts `agentSetAbstraction({ abstraction: "u" })` (`client.ts:576-578`); the SDK documents `"u"` as `unifiedAccount`. One hand-placed `xyz:` order from the ticket migrates the follower permanently, after which every later mirror reads the wrong figure.

The correct read already exists in the same package and is never called from the worker: `accountBalanceUsd` (`client.ts:638-670`) branches on `userAbstraction`, reads `spotClearinghouseState` for `unifiedAccount`, and LTV-weights spot balances via borrow-lend reserves for `portfolioMargin`. Its only non-test caller is `apps/api/src/routers/hyperliquid.ts:101`. A repo-wide grep finds zero live uses of `accountBalanceUsd`, `spotClearinghouseState` or `activeAssetData` anywhere in `apps/worker`.

### 1.5 What the repo must size from instead

1. **Resolve `userAbstraction` before sizing, for every perp coin, not only dex-prefixed ones.** Today it is resolved after sizing and only for HIP-3 coins.
2. **`unifiedAccount`:** read `spotClearinghouseState`, per collateral token. Free collateral is `balance.total - balance.hold`. `accountBalanceUsd` already performs the spot read; it needs to return `hold` as well as `total`, and the mirror path needs to call it.
3. **`portfolioMargin`:** the same spot read, LTV-weighted, which `accountBalanceUsd` already implements.
4. **`default` / standard:** the current main-dex read is correct for main-dex coins. For a dex-prefixed coin it is wrong and the per-dex `clearinghouseState` applies. The gate refuses HIP-3 in this mode, so this branch is mostly moot, but the per-dex states are already fetched and then discarded (`client.ts:915-933`, only `assetPositions` survives into `:1001`).
5. **`dexAbstraction`:** this is the one mode where the current read is defensible. The exchange-endpoint page documents `userDexAbstraction` as *"actions on HIP-3 perps will automatically transfer collateral from validator-operated USDC perps balance for HIP-3 DEXs where USDC is the collateral token, and spot otherwise."* The main perp balance genuinely is the funding source there. Note the inversion this creates: **the repo's collateral read is valid in the single mode the vendor has discontinued, and invalid in the two modes the vendor recommends and the gate requires.**
6. **Strongly preferred single fix:** call `activeAssetData({ coin, user })`. The SDK ships it (`esm/api/info/_methods/activeAssetData.d.ts`), it returns `availableToTrade` and `maxTradeSzs`, and Hyperliquid documents it with an explicit HIP-3 response tab (example coin `xyz:XYZ100`). It is the venue's own per-coin answer and it collapses the entire mode matrix. Use it as the sizing ceiling and keep a mode-aware balance read as a cross-check, so the two disagreeing is an alarm rather than a silent wrong number. The repo never calls it.
7. **`pct_equity`** should follow the shape of `computeUnifiedAccountRatio` rather than a single dex's `accountValue`.

### 1.6 One caveat on this question that is still open: the collateral token

Unified account's guarantee is stated per asset. The same doc gives a non-USDC example (USDT spot balance as the single source for CASH perps). `buildPerpAssetCache` (`client.ts:91-114`) discards `collateralToken`, so nothing in the repo can tell that a HIP-3 dex is margined in something other than USDC, and `requiresDexAbstraction` admits every dex-prefixed coin, not only `xyz:`. For trade.xyz the docs name USDC, so the flagship path is covered; for any other builder dex the mirror would admit, the collateral asset is unverified and the USDC pool would not back it. This item is on the unverified list below; it is repeated here because it is load-bearing on the same question.

### 1.7 What a human must confirm on testnet before mainnet

1. On a funded account holding open cross positions on both the main dex and a HIP-3 dex, read `clearinghouseState` (main), `clearinghouseState(dex)` for each dex, and `spotClearinghouseState` back to back, in `unifiedAccount` and again in `portfolioMargin`. Record whether spot `hold` equals the sum of perp margin across dexes, and whether per-dex `accountValue` is zero, partial, or pooled.
2. On the same account and coin, call `activeAssetData({coin, user})` and compare `availableToTrade` against both the repo's `accountValue - totalMarginUsed` and against `spot.total - spot.hold`.
3. Repeat with a position carrying large unrealized profit, to determine whether the repo's formula can exceed true free collateral rather than only fall short of it. This is the one branch that separates "silently inert" from "over-leveraged".
4. Place one HIP-3 order sized at the repo's computed free collateral and record whether the venue accepts, rejects for margin, or fills at a margin figure neither read predicted.
5. Confirm the collateral token of every dex the mirror will admit, not only `xyz`.

---

## 2. MUST FIX BEFORE ENABLING PERPS

### M1. Every perp mirror is sized and margin-gated from a state the vendor documents as not the trading-account balance

**Severity: blocker.** Full detail in section 1. Anchors: `copy-mirror-perp-sizing.ts:81-92` (the subtraction), `copy-mirror-perp-execution.ts:1062` and `:1065` and `:330` (the consumers), `packages/hyperliquid/src/client.ts:1001` and `:1474-1485` (the source), `copy-mirror.ts:2975` (no mode check for main-dex coins). Vendor statements violated: the `clearinghouseState` note and the "individual perp dex user states are not meaningful" clause quoted above. Fix: section 1.5. The in-file comment at `copy-mirror-perp-execution.ts:1005-1012` marks this an "UNVERIFIED ASSUMPTION"; it is now verified, and it is wrong.

Severity note: two verifiers held critical, two corrected to high on the grounds that only the fail-closed direction is empirically demonstrated. Either way it is the item that blocks mainnet.

### M2. `openOrders` is never given a `dex`, so no HIP-3 resting order can be seen and its absence is read as proof of cancellation

**Severity: high.**

`HyperliquidClient.openOrders()` sends `{ user: address }` with no `dex` (`packages/hyperliquid/src/client.ts:821-823`). `listOpenOrders` has the identical omission on `frontendOpenOrders` (`:833-836`), so the UI cannot contradict the database either. A repo-wide grep finds no call site anywhere that passes a dex. The community SDK exposes the field: `OpenOrdersRequest` declares `dex: v.optional(v.string())`. This is the wrapper's omission, not an SDK limit.

**Vendor statement violated:** info-endpoint, both `openOrders` and `frontendOpenOrders` request bodies: *"dex | String | Perp dex name. Defaults to the empty string which represents the first perp dex. Spot open orders are only included with the first perp dex."* By contrast `userFills` has no `dex` field and the docs show a HIP-3 fill with the dex name as a coin prefix. Fills cross dexes; open orders do not. That asymmetry is exactly what the reconciler assumes away.

**What breaks:** `reconcilePerpOrder`'s CANCELLED verdict is an argument from absence (`apps/api/src/lib/hyperliquid-order-sync.ts:415` `if (restingMatch) return null;`, then `:464` `status: "CANCELLED"` with executed size forced to `"0"`), and the same absent array decides FILLED versus PARTIAL at `:544`. For a HIP-3 order the absence is structural and permanent, so the 45s min-age guard can never save it. CANCELLED and FILLED are terminal and outside the scan set (`apps/worker/src/services/hyperliquid-order-sync.ts:301`), so later fills are never recorded. The `placedAt` backfill from the resting entry's venue timestamp (`worker .../hyperliquid-order-sync.ts:525-527`) is likewise structurally unreachable for every HIP-3 row.

**Concrete failure, and the narrowing that matters:** mirror-placed orders are always `orderType: "Market"` (`copy-mirror.ts:3678`), which `resolveTif` maps to `Ioc` (`client.ts:1030-1038`). An IOC never rests, so for the mirror's *own* rows absence is genuine and the verdict is correct. The harm lands on rows that do rest:

- A follower's HIP-3 entry placed from the ticket with `stopLossPx` set. `pendingTpSlOrderRows` (`apps/api/src/routers/orders.ts:121-146`, `:2314-2334`) writes durable reduce-only StopMarket rows, `finalizeTpSlOrders` (`:291-305`) moves them to SUBMITTED with the venue oid, and the trigger rests on the xyz dex. 45 seconds later the row is CANCELLED with executed size 0 while the stop is live. The UI agrees, because `frontendOpenOrders` has the same gap. The user re-arms a duplicate stop on the same position.
- **The copy-trade link:** `copy-mirror.ts:3367-3388` reads every one of the *source user's* Hyperliquid PERP rows for the symbol with no `copymirror:` prefix filter, and `sourceBefore` (`:3489`) is built from their `executedSizeDecimal`. A source's resting `xyz:` limit settled CANCELLED at 0, or written terminally FILLED at a partial size via `:544`, permanently loses its later fills. Source exposure is understated, and every follower's mirrored close is undersized from that number.

**Fix:** pass `dex` on both wrappers, derived the way `allMids` and `clearinghouseState` already do it (`client.ts:484-486`, `:778-792`), and fan out one read per covered dex the way `perpAccountSnapshot` already fans out `clearinghouseState` (`:915-933`). Until then, apply the rule the repo wrote for itself in `isPerpDexCovered` (`client.ts:71-73`): *"False means 'we do not know', never 'the account is flat there'."* Refuse to settle a dex-prefixed row CANCELLED from an absence in a snapshot that could not have contained it.

### M3. The venue's placement response is discarded, so a mirrored order has no recorded identity, no recorded fill, and a short IoC fill silently strands the remainder

**Severity: high.** Two failures, one root cause, one fix.

`placePerpMirrorOrder` calls `await client.placeOrder({...})` and binds nothing (`copy-mirror.ts:3740`); the success write sets only `{ status: "SUBMITTED", statusUpdatedAt, placedAt }` (`:3870`). The wrapper does return the result and has already parsed it: `orderRejectionMessage` (`client.ts:359-376`) reaches into `result.response.data.statuses[]` before `placeOrder` returns it at `:1149-1151`. The API path drops it identically (`apps/api/src/routers/orders.ts:2189-2273`, `result` assigned and never persisted).

**Vendor statement violated:** exchange-endpoint order responses are `statuses: [{resting: {oid}}]` or `[{filled: {totalSz, avgPx, oid}}]`. The oid and the executed size are returned synchronously. Also: *"IOC (immediate or cancel) will have the unfilled part canceled instead of resting."*

**Failure A, stranded remainder.** The source closes a position the mirror opened at 1.0 SOL. `executePerpCloseMirror` sizes the exit to 1.0 and submits it reduce-only as Market/IoC priced at mark times 0.95 (`MIRROR_PERP_MARKET_SLIPPAGE = 0.05`, `copy-mirror-perp-sizing.ts:59`). The book is thin inside that band, which is the normal condition for a HIP-3 equity perp outside regular hours. Hyperliquid fills 0.3 and cancels 0.7, returning `status:"ok"` with `filled.totalSz "0.3"`. No error string, so nothing throws. The row is written SUBMITTED, the placement logs PLACED, and `markDeliveryCompleted` (`copy-mirror.ts:1174`) retires the delivery. The reconciler then records `executed_size_decimal = 0.3` and status **FILLED**, because `restingMatch || partialSnapshot ? "PARTIAL" : "FILLED"` (`apps/api/src/lib/hyperliquid-order-sync.ts:544`) and an IoC never rests. Nothing anywhere compares `quantity_decimal` against `executed_size_decimal` for a reduce-only row (`worker .../hyperliquid-order-sync.ts:590-593` states the requested size "is intentionally NOT touched here"). The follower holds 0.7 SOL of leveraged exposure with the source's close already spent, reported as success end to end. Note the asymmetry: a *zero*-fill IoC returns `statuses:[{error:"..."}]`, which is caught and classified. Only the partial fill passes silently.

**Failure B, identity and fill exist only inside a bounded window.** With `broker_order_id` and `executed_size_decimal` left NULL, the reconciler's `userFills` scan is the only source of the follower's mirrored exposure. Vendor docs cap `userFills` at *"at most 2000 most recent fills"*. If a reconciliation gap outlasts that window (a sustained worker outage, or an operator setting `HYPERLIQUID_SYNC_ENABLED=false`, which this repo supports as incident response), the next pass sees no fill, no resting order, and an aged row, and writes CANCELLED with executed size 0 (`api .../hyperliquid-order-sync.ts:446-471`). The exposure query at `copy-mirror.ts:3165` (`gt(executedSizeDecimal, "0")`) then reports zero mirrored exposure and `decidePerpReduceOnlyMirror` refuses every close with `no-qty` (`copy-mirror-perp-decisions.ts:155-157`). The reconciler's own comment calls this a KNOWN LIMIT and says the real fix "is a new call" (`api .../hyperliquid-order-sync.ts:434-443`). On the success path no new call is needed. The answer was already parsed and thrown away.

**Fix:**
- Capture the `placeOrder` result. Persist `oid` into `broker_order_id` and `filled.totalSz` into `executed_size_decimal` on the same write that sets SUBMITTED. This is compatible with the existing accumulator: with `lastCountedFillId` still null, `hasCursor === false` makes the next reconciler pass recompute from the window rather than add to the recorded value, and `neverDecreasingSize` is the backstop, so no double count. It also makes the CANCELLED branch preserve the real size instead of writing 0.
- On a reduce-only row, compare `filled.totalSz` against the requested size. On a shortfall, do not complete the delivery. Requeue the residual. Note the constraint: the cloid from `mirrorIdempotencyKey` is deterministic, so a naive retry hits the duplicate branch at `copy-mirror.ts:3700-3706`. The residual leg needs its own derived cloid.

### M4. A mirrored reduce-only close is never checked against the venue minimum, and the venue's refusal is classified terminal, spending the one-shot exit

**Severity: high.**

`decidePerpReduceOnlyMirror` clamps to the mirrored exposure and the live position and returns `{action: "place", sizeCoin}` with no notional check (`copy-mirror-perp-decisions.ts:174-182`). It never receives a price, so it cannot perform one. The open path calls `meetsPerpMinimumNotional` at `:273` and the resume path at `copy-mirror-perp-resume-parity.ts:195`. The omission is deliberate and rests on a stated premise: `copy-mirror-perp-resume-parity.ts:38-40`, *"A close can only shrink exposure, it is exempt from the venue minimum"*.

**Vendor statement:** the error-responses page lists *"Order must have minimum value of $10."* and the HIP-3 variant *"Order must have minimum value of 10 {quote_token}."* unconditionally. The only reduce-only error documented is *"Reduce only order would increase position."* No first-party page states an exemption for reduce-only or position-closing orders.

**What breaks:** `classifyPerpRejection` matches `/minimum value/i` in `DEFINITIVE_REJECTION_PATTERNS` (`copy-mirror-perp-rejection.ts:113-127`) and the `reduceOnly` carve-out at `:141-165` covers only `TRANSIENT_MARKET_STATE_PATTERNS`, so the verdict is `terminal`. `copy-mirror.ts:3843-3861` writes the row REJECTED and returns `"rejected"`, and `markDeliveryCompleted` (`:1303`) retires the delivery. The `retry` and `reconcile` dispositions both have reduce-only requeue branches; `terminal` does not. The revive path is restricted to CANCELLED rows with a null broker order id (`:1534-1540`), so a REJECTED close is never revived. Nothing regenerates a source close.

**Concrete failures.** `meetsPerpMinimumNotional` gates on the low bound, `0.95 * markUsd >= 10`, so the open path admits mirrors from about $10.53 of notional upward. Three permanent cases follow:
- The final full close of a mirror whose notional has drifted below roughly $10.53. Any modest adverse move on a floor-sized mirror produces this.
- A residual after a partial close that did fill: the remaining exposure sits under $10, and the source's final close requests exactly that residual.
- **`ratio` sizing mode has no self-heal.** In every other mode the last close requests everything remaining, so a rejected partial trim costs one slice and a later full close still works. In `ratio` mode the request is `sourceFillSize * ratio` per fill, so a source exiting through many small fills (a TWAP exit is the clean case) produces a whole sequence of sub-$10 closes, every one terminal, leaving the entire mirrored position with no exit left.
- Also reachable regardless of mode: a "full" mirrored close is a *partial* venue close whenever the follower holds non-mirrored exposure in the same coin, since the size is clamped to mirrored exposure. That is ineligible for any exact-close exemption under either reading of the rule.

**Fix:** three changes, all small.
1. Give `decidePerpReduceOnlyMirror` the mark price and check `meetsPerpMinimumNotional`, exactly as the open and resume paths do. On a shortfall, defer through the existing `deferClose` machinery rather than placing.
2. Move `/minimum value/i` out of terminal for `reduceOnly: true`. A close refused for size is a *retry later* condition, not a permanent one; the position still exists and the price may move it back over the floor.
3. Delete the claimed exemption comment at `copy-mirror-perp-resume-parity.ts:38-40` or replace it with the tested behaviour.

**Honest caveat:** first-party docs are silent on whether the minimum applies to a reduce-only order that *exactly* closes a position. A third-party integration reference (Chainstack) states that exact-close reduce-only is the one exception. That reading does not rescue the finding, because a proportional partial trim is not an exact close under either reading, but it does mean the full-close variant should be confirmed on testnet rather than assumed. See section 7.

### M5. No placement timestamp on the ambiguous transport path, so the reconciler's 45s guard is already expired for a resumed row

**Severity: high.**

`orders.placed_at` is written in exactly two places on the perp path: after Hyperliquid accepts (`copy-mirror.ts:3870`) and in the cloid-recovery branch (`:3728`). On the one path where the order's fate is genuinely unknown, an `HttpRequestError` from the SDK transport, `placePerpMirrorOrder` rethrows with no write at all (`:3863-3864`, comment: "Unknown transport outcome: preserve PENDING for cloid reconciliation"). The wrapper deliberately rethrows that class bare, with its own comment that it *"may have happened after HL accepted the payload, so callers must reconcile by cloid"* (`client.ts:1139-1143`), and `placeOrder` has no retry. The SDK's `HttpTransport` is constructed with no timeout override (`client.ts:414-416`), so the 10 second default applies.

The reconciler ages every row from `order.placedAt ?? order.createdAt` (`worker .../hyperliquid-order-sync.ts:495`), and its comment at `:489-494` states precisely why: *"a resumed row can be hours old while its placement is seconds old: aged from created_at it is instantly eligible, so one empty snapshot settles it CANCELLED."* For a resumed PENDING row with a null `placed_at`, that is exactly what happens. `orderIsYoung` is false at the instant of submission, so `DEFAULT_MIN_CANCEL_AGE_MS` (45,000, `api .../hyperliquid-order-sync.ts:134`) provides zero protection. The empty-snapshot escape at `:446` is itself gated on `orderIsYoung`, so it does not help either. `venueNetwork` is always stamped at insert (`perp-orders.ts:238`), so `networkUnproven` does not fire.

**Vendor statement violated:** `openOrders` returns resting orders only, and IoC *"will have the unfilled part canceled instead of resting"*, so a mirror order can never appear there. `userFills` is the sole evidence and is capped at 2000 recent fills. Absence from the pair cannot distinguish "never placed" from "placed and filled", which is the inference the age guard exists to defer.

**Concrete failure and its reachability.** Both pollers run at 30s against a 45s minimum age, and the first mirror retry is scheduled at now+30s, so *any* second attempt submits at least 45s after `created_at`. No hours-old row is required. The revive path makes it deterministic for closes: `copy-mirror.ts:1541-1556` flips a reconciler-CANCELLED close back to PENDING setting only status and notes, leaving `created_at` (immutable) and `placed_at` (null) untouched, and a revival can only occur after the row already cleared the 45s guard. Hyperliquid accepts and fills the IoC, the HTTP response is lost, nothing is written, and within 30 seconds the reconciler writes CANCELLED with executed size 0 over a live leveraged position and retires the row permanently.

**Fix:** write `placed_at = now()` before the transport call, not after the response. The column then means "a submission was attempted at this time", which is what the age guard actually needs. Alternatively stamp it in the transport-error branch at `:3863` before rethrowing. Either is a one-line change and both preserve the cloid-recovery intent.

---

## 3. SHOULD FIX

### S1. The HIP-3 gate accepts `dexAbstraction`, the one mode the vendor flags for HIP-3 cross margin

**Severity: medium.**

`isDexAbstractionReady(mode)` returns true for `"unifiedAccount" | "portfolioMargin" | "dexAbstraction"` (`copy-mirror-consent.ts:183-187`), and this predicate is the entire HIP-3 gate (`copy-mirror.ts:2970-2991`). The vendor's positive enumeration of modes that pool margin across dexes names exactly two: *"For unified account and portfolio margin, the user's cross margin positions in DEXs with the same collateral all share margin."* `dexAbstraction` is absent from it. `/trading/account-abstraction-modes` lists mode 4 as *"DEX abstraction (discontinued): USDC balances default to perps balance, all other collateral defaults to spot balance"* with the callout *"IMPORTANT: Cross margin on HIP-3 DEXs does not behave intuitively for DEX abstraction users."*

The mode is live: the SDK's `UserAbstractionResponse` union includes `"dexAbstraction"`, and `userSetAbstraction` still accepts it even though `agentSetAbstraction`'s picklist is `["i","u","p"]`. The repo also pins such an account there: `ensureDexAbstraction`'s local readiness predicate (`client.ts:561-566`) duplicates the same three-mode test, so an account already in `dexAbstraction` short-circuits the migration to `unifiedAccount` and never leaves.

The repo's checklist compounds it: `docs/deployment/perps-auto-mirror-testnet-checklist.md:63-67` calls all three "shared-collateral mode" and instructs a tester to "put a testnet account into a shared-collateral mode", which a tester satisfies with `unifiedAccount` alone.

**Fix:** drop `dexAbstraction` from the predicate in both places. Note the interaction with M1: `dexAbstraction` is the one mode where the *current* collateral read is defensible, so fixing M1 and S1 together means the gate keeps the two modes the vendor documents as pooling, and reads their collateral from the spot state as the vendor directs. Severity is medium rather than high because the harm is not quantifiable from the vendor's wording ("does not behave intuitively" is a warning, not a specification) and the affected population is a discontinued mode.

### S2. The reduce-only close is gated on account-abstraction mode and defers forever

**Severity: medium.**

`executePerpCloseMirror` calls `deps.perpDexModeReady` before placing the reduce-only order and, on false, calls `deferClose('dex-abstraction-required')` (`copy-mirror-perp-execution.ts:952`, `:958`), which throws EAGAIN. The resume path does the same at `:421-435`. EAGAIN is transient (`copy-mirror.ts:512-527`) and closes are exempt from the attempt ceiling (`copy-mirror.ts:1354`), so the requeue is unbounded on a 15 minute backoff. A test comment states it outright: "A deferred perp close is held on purpose and never expires."

Account mode is a collateral question. A reduce-only order takes no new margin: the exchange-endpoint docs define `r: true` as an order that will be rejected if it would increase position size in the same direction, and the position's own margin is already posted on that dex. Nor does Hyperliquid condition HIP-3 order placement on an abstraction mode: `/trading/margining` describes standard-abstraction accounts holding HIP-3 cross positions, just with per-dex cross margin. The gate blocks an exit the venue would accept.

**Concrete failure:** the mirror opens `xyz:GOOGL` while the follower is in a pooled mode; the follower moves to standard, which the vendor recommends for high-volume automated users and requires to accrue builder fees, and which has no 50k-actions-per-day cap. The source closes. `userAbstraction` returns `"default"`, EAGAIN fires every cycle forever, and the leveraged equity-perp exit never places. The close path already avoids the account-wide leverage write for exactly the reason that a close should not mutate account state; the same argument applies to gating it on account mode.

**Fix:** skip `perpDexModeReady` when `reduceOnly` is true. Keep the gate on opens. Severity is medium rather than high because it requires an out-of-band mode change, no wrong order is placed, the follower can still exit manually, and the stuck close is surfaced every cycle by `readDeferredCloseBacklog` / `reportDeferredCloseBacklog` (`copy-mirror.ts:1400-1445`).

### S3. UI-placed perp orders record no `brokerAccountId`, defeating the reconciler's account pinning

**Severity: medium.** Adjacent to the copy path rather than in it, but it shares the reconciler.

`orders.submitPerp` inserts with `toPerpOrderRow(input, ctx.userId, null)` (`apps/api/src/routers/orders.ts:2175`) and never backfills it; the only post-placement write is `.set({ status: "SUBMITTED" })` (`:2258-2263`). `walletAddress` is in scope at that line, and the TP/SL legs of the *same request* do pass it (`:2311-2318`). The reconciler groups on that column: `const key = recorded ? \`address:${recorded}\` : \`user:${order.userId}\`` (`worker .../hyperliquid-order-sync.ts:348-361`), and its comment at `:332-343` asserts the mitigation as fact: *"The row already records the account it went to, so that is what it is reconciled against."* That is false for every row this endpoint creates. Null rows fall to the `user:` branch, which resolves the user's *current* master address (`:368-384`).

**Vendor statement:** `userFills` and `openOrders` are addressed by `user`, *"Address in 42-character hexadecimal format"*. A snapshot for address B carries no information about an order placed by address A. The reconciler converts that absence into a terminal CANCELLED with executed size 0 over a live order.

**Reachability, corrected:** the claimed trigger of simply re-running "Enable Perps" does not work; `hyperliquid.enable` early-returns when a credential exists. The reachable path is Settings, "Remove perps" (`userSettings.deleteApiCredentials`, no open-order guard), then Enable Perps with a different embedded wallet. That is a deliberate multi-step account change, which is why both verifiers put this at medium.

**Fix:** pass `walletAddress` at `orders.ts:2175`, exactly as the TP/SL rows 130 lines below already do. Copy-mirror rows are already pinned correctly (`copy-mirror.ts:3689`; `copy-mirror-perp-execution.ts:783`, `:971`, `:1162`).

---

## 4. WORTH KNOWING

These are unresolved leads from this audit that did not reach the verification bar. They are stated as questions, not defects.

1. `crossAccountValueUsd` is used as net equity for `pct_equity` sizing but reads the cross-only, single-dex summary, which excludes every isolated position. If trade.xyz markets are Isolated-Only as their docs indicate, the `pct_equity` base may exclude the entire HIP-3 book. Related: each isolated mirror the system opens may shrink the base for the next one.
2. `coveredDexes` proves only that the per-dex read resolved, never that the account mode makes that per-dex state meaningful. Under the vendor's "not meaningful" clause, a one-shot HIP-3 close could be retired on a state that carries no information.
3. `openOrders` / `frontendOpenOrders` being dex-blind also affects the cloid-recovery check at `copy-mirror.ts:3715` before a PENDING row is re-submitted. Inert today because mirror orders are IoC, but it is the same blind read and would matter the moment a resting mirror order type is introduced. (Same root cause as M2.)
4. Nothing appears to claim a `copy_mirror_deliveries` row while it is being executed. Whether a second worker process can place a second real order under the same cloid was not established; the deterministic cloid and `onConflictDoNothing` may or may not close it under concurrency.
5. A refused or venue-rejected mirror may leave the follower's per-coin leverage and margin mode permanently rewritten, because `applyPerpLeverage` runs before `placePerpMirrorOrder` on the open path.
6. `buildPerpAssetCache` discards `collateralToken`, so nothing can tell that a HIP-3 market is margined in a token other than USDC. See section 1.6; this is the highest-value item on this list.
7. The reconciler fan-out has no rate-limit weight budget and no fairness rotation across account groups, and the grouping key is not lowercased while `copy-mirror.ts:3225-3236` documents and applies lowercasing elsewhere, which can split one wallet into two groups and double its reads. This was investigated and found not to be a defect today (see section 6), but it is a capacity item worth an owner before scale.

---

## 5. On `@nktkas/hyperliquid` v0.33.1

This is a community SDK, not an official Hyperliquid client, and it is on the real-money path. What the repo relies on it for, and what should be pinned by a test rather than trusted:

**What the repo depends on:**
- Request and response schemas for `info` reads (`clearinghouseState`, `spotClearinghouseState`, `userFills`, `openOrders`, `frontendOpenOrders`, `userAbstraction`, `allMids`, `metaAndAssetCtxs`).
- `exchange.order()` and its response envelope, plus `agentSetAbstraction` / `userSetAbstraction`.
- `HttpTransport` behaviour: a 10,000 ms default timeout, throwing `HttpRequestError` on any non-OK response, with no built-in retry and no rate limiting. Constructed with no timeout override at `client.ts:414-416`.
- The identity of the thrown error classes. `client.ts:1139-1143` branches on `error instanceof HttpRequestError` to decide that an outcome is *ambiguous* rather than terminal.

**Behaviour that should be pinned by a test, not trusted:**

1. **The ok-envelope-with-error contract.** A `status: "ok"` response can carry a per-order failure in `statuses[].error`, and the only thing that converts it into a throw is the repo's own `orderRejectionMessage` (`client.ts:359-376`). Pin: an ok envelope whose `statuses[0]` is an `error` must throw `HyperliquidOrderRejectedError` carrying the verbatim string; an ok envelope whose `statuses[0]` is `filled` with `totalSz` less than the requested size must not be treated as a full fill.
2. **`resolveTif` mapping Market to Ioc** (`client.ts:1030-1038`). Every mirrored order's non-resting behaviour, and therefore the entire "absence from `openOrders` means cancelled" inference, hangs on this one line. Pin it against the SDK's own tif schema so an SDK change cannot silently make mirror orders rest.
3. **Error class identity under a version bump.** If a future SDK wraps or renames `HttpRequestError` / `ApiRequestError`, the `instanceof` check at `client.ts:1141` fails open and an ambiguous transport outcome silently becomes a terminal rejection, with the row written REJECTED instead of preserved PENDING. Pin with a fake transport that raises each class.
4. **The `userAbstraction` union.** The SDK types it as `"unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction"`. `isDexAbstractionReady` is an allowlist over that union. A new member added upstream silently becomes "not ready" and strands HIP-3 closes (see S2). Pin the union membership so the build breaks instead.
5. **The optional fields the wrapper does not pass.** `OpenOrdersRequest.dex` and `FrontendOpenOrdersRequest.dex` both exist as `v.optional(v.string())`; `activeAssetData({coin, user})` exists and is never called. A test that asserts these are supplied (or deliberately not) turns M2 and the section 1.5 fix into regressions the suite catches.
6. **`toCloid`.** The repo hashes its idempotency key with keccak256 and takes the first 16 bytes (`client.ts:128-132`), because the venue requires a 128-bit hex cloid and `orderStatus` accepts *"a 16-byte hex string representing the client order id"*. Pin the width and determinism; the whole duplicate-suppression and recovery story depends on it.
7. **HIP-3 asset indexing.** `buildPerpAssetCache` (`client.ts:91-114`) computes the HIP-3 asset index arithmetically from the dex's position in `perpDexs`. A change in dex ordering upstream silently reindexes every HIP-3 asset. This should be asserted against a live `meta` fetch in a testnet integration test, not derived and trusted.
8. **Rate limiting.** The SDK provides none, and `withRetry` wraps info reads with 3 attempts and no `retryOn` predicate, so a 429 is re-issued twice more. The vendor documents *"REST requests share an aggregated weight limit of 1200 per minute"*, with `clearinghouseState` and `spotClearinghouseState` at weight 2, "all other documented info requests" at weight 20, and additional weight per 20 items for `userFills`. Any fix for M1 that adds a `spotClearinghouseState` read per follower per cycle should be costed against that budget before it ships.

---

## 6. Checked and found sound

- **The pooling premise of the HIP-3 gate.** Refusing standard/manual mode for dex-prefixed coins matches the vendor's per-dex cross-margin rule exactly. The gate's shape is right; only its collateral read (M1) and its third accepted mode (S1) are wrong.
- **The margin-capacity guard's structure.** Hyperliquid sets maintenance margin to half the initial margin at max leverage, and `resolvePerpLeverage` clamps to `asset.maxLeverage`, so posted initial margin is always at least twice a position's maintenance requirement. Forcing post-trade `totalMarginUsed` under account value therefore bounds total cross maintenance at roughly 50% of account value. The concern that a cross mirror silently moves other positions' liquidation prices is real venue behaviour, inherent to cross margin, identical for a hand-placed order, and structurally bounded here. Not a defect.
- **The per-order dollar cap ordering.** `withinDollarCap` on `bounds.highUsd` runs *before* the margin check (`copy-mirror-perp-decisions.ts:266-287`), with a $1,000 default, so worst-case notional per mirror is capped independently of the collateral read. This substantially limits the blast radius of M1 at default configuration, and is the reason operators raising `COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS` should not do so before M1 is fixed.
- **The close-deferral machinery.** `pairedOpenOutcomeAmbiguous` plus `decidePerpCloseConsumption` plus the EAGAIN requeue plus the exemption of closing deliveries from the attempt ceiling (`copy-mirror.ts:2822-2856`, `copy-mirror-close-pairing.ts:277-299`, `copy-mirror.ts:1353-1372`) correctly prevents an unreconciled open from consuming a source close. This is well designed and load-bearing; several plausible-looking failure narratives die on it.
- **`coveredDexes` / `isPerpDexCovered`.** The per-dex `clearinghouseState` fan-out and the rule that "false means we do not know, never the account is flat there" is the right shape, correctly applied to positions. M2 is precisely the read where that rule was never applied.
- **Zero-fill IoC handling.** A fully unfilled aggressive IoC returns an `error` status, is caught by `orderRejectionMessage`, routed through `classifyPerpRejection`, and is covered by a test. Only the *partial* fill slips through (M3).
- **Reconciler write scope.** The Hyperliquid poller is documented and behaves as strictly read-only (`apps/worker/src/index.ts:93`). A mis-settled row lies about the venue; it never acts on the venue.
- **Tenant scoping on the equity and TP/SL cloid paths.** Both namespace by user and scope the lookup by `userId`; `orders.submitPerp` is the outlier, and its exposure is currently limited by the fact that no endpoint returns a raw internal user id.
- **Rate-limit fan-out.** No weight budget exists, but a throttled cycle fails into the deferral machinery, logs at error level every cycle, self-heals on the next 30s poll, and cannot consume an exit. Worth an owner (section 4, item 7), not a defect today.

---

## 7. What this audit could not establish

1. **Which direction the M1 collateral misread goes on a given account.** Fail-closed was reproduced live on a real unified-account address (every mirror silently skipped `insufficient-margin` while $2.0M sat genuinely free). The over-sizing branch is derivable but was not reproduced. Documentation does not settle it. Section 1.7 lists the exact testnet reads that would.
2. **Whether Hyperliquid enforces the $10 minimum on a reduce-only order that exactly closes a position.** First-party docs are silent. One third-party integration reference states exact-close is exempt. M4's partial-trim and residual cases hold under either reading; the full-close case depends on this. One testnet probe settles it.
3. **Whether `userFills` spans HIP-3 dexes.** The request body has no `dex` field and the docs show a HIP-3 fill with a dex-prefixed coin, which implies yes, but it is never stated. If it does not, M2's blast radius grows from resting orders to *every* mirrored HIP-3 market order, which would move it to blocker.
4. **What a per-dex `clearinghouseState` returns for a unified account that holds HIP-3 positions.** An all-zero response was observed for an account with no positions on that dex, which proves nothing either way.
5. **Whether Hyperliquid permits leaving `unifiedAccount` / `portfolioMargin` with open positions.** This determines S2's reachability. Third-party sources suggest disabling unified requires flattening first; first-party docs say only that mode changes exist as agent- and user-signed actions.
6. **Whether `dexAbstraction` accounts still exist in the wild, and what the venue's retirement path for them is.** S1's population size is unknown.
7. **The collateral token of any HIP-3 dex other than `xyz`.** See section 1.6. `collateralToken` is discarded before the mirror can see it, and the mirror admits every dex-prefixed coin.
8. **Live behaviour of `@nktkas/hyperliquid` 0.33.1 under 429 responses and under partial fills against the real venue.** Everything in section 5 was read from the SDK source and its schemas, not exercised against Hyperliquid.
9. **The seven leads in section 4**, which were surfaced but did not clear verification within this audit's budget. They are stated there as questions rather than defects, and none of them should be treated as cleared.