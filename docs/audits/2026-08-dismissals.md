# Copy-trade audit: what was examined and found sound

This records the findings that were RAISED by the copy-trade audits and then
DISMISSED, with the reasoning. It exists so the next person to audit this feature
does not re-derive the same conclusions, and so a dismissal can be challenged on its
merits rather than rediscovered as if new.

Both audit reports recommended a section exactly like this. It is the other half of
the fix log: knowing what was checked and found fine is worth nearly as much as
knowing what was broken.

## How to read this

Each finding was put to an adjudicator that judged two things separately:

- **Still live** - can the described failure actually occur in the current code?
- **Worth fixing** - if it can, does it justify changing code on a real-money path?

A finding was dismissed if either answer was no. The adjudicators were instructed to
dismiss when uncertain, on the grounds that editing correct code to satisfy an
unverified claim is worse than leaving it alone.

Dismissed does NOT mean disproved forever. It means: someone read the code, checked
the claim, and wrote down why it does not warrant a change today. If you disagree,
the reasoning below is the thing to argue with.

## Scope and threat model

Every finding was assessed as if the deployment were fully enabled with real money:
`COPY_TRADE_AUTOMIRROR_ENABLED`, `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE`, `PERPS_ENABLED`,
`COPY_TRADE_AUTOMIRROR_PERPS_ENABLED` and `PERPS_ALLOW_MAINNET` all true. A defect
gated behind a currently-off flag was still in scope, ranked by what it does when the
flag is on.

## The numbers

Four audits raised roughly 160 raw findings across the auto-mirror path, the
perp/stock seam, the Alpaca integration and the Hyperliquid integration. After
deduplication and adjudication, about half were fixed and about half were dismissed.
Critical and high findings were each put to two or three independent adversarial
verifiers whose instruction was to REFUTE them; medium and low findings went to a
single strict adjudicator.

The dismissals with recorded reasoning are listed below. Dismissals from the
critical/high verification rounds are not itemized here because they were refuted by
majority vote rather than by a single written verdict; those live in the audit reports
themselves.

## Dismissed: auto-mirror and cross-venue tail

28 findings, all medium or low severity.

### social.feed joins orders on brokerOrderId alone, unscoped by owner and undeduped, unlike the two sibling joins over the same tables

*Severity claimed: low*

The finder read the code accurately, apps/api/src/routers/social.ts:66-69 still joins
orders on brokerOrderId alone, unscoped by userId and with no collapse, unlike copy-
trade.ts:596-601 (+collapseUserTradeRows) and leaderboard.ts:674-681
(+groupTradeEventsByUser).

### A mirrored equity SELL is sized from the follow's own rule instead of the source's exit, so a partial source trim closes the follower's entire position

*Severity claimed: medium*

ALREADY FIXED in ef4bda2, the claim describes pre-fix code. `git diff cbcf236..HEAD --
apps/worker/src/services/copy-mirror.ts` shows the exact line the claim hinges on was
replaced: `let placeQty = decision.qty;` became `let placeQty =
sizeExitFromMirroredPosition ? mirroredLongQty : entryRuleQty;`, where `const
sizeExitFromMirroredPosit ...

### Arming confirmation states the daily cap is per-follow; the worker enforces it per-follower across every armed follow

*Severity claimed: medium*

ALREADY FIXED, the finder audited the base commit, not HEAD. The claim is a verbatim
description of cbcf236: `git show cbcf236:apps/web-v2/src/components/copy-trade/mirror-
consent.ts` has line 220 as exactly `const sentence = `Up to ${limits.dailyCap} mirrored
orders a day for this follow.`;` and line 94 as "Mirrored orders allowed per fo ...

### Arming from the panel's inline Mirror switch silently re-points the follow's saved destination and uses the plain arm dialog instead of the repoint one

*Severity claimed: medium*

Already fixed, this is verbatim item 4 of commit 5df89ab ("Arming from the feed panel
silently re-pointed a follow to the terminal's current Paper/Live account with no
disclosure of what it was moving from"). The finder read pre-5df89ab source; every
quoted line is gone.

### Delivery ordering also treats a close as perp-only, so an equity open/close pair sharing a source timestamp can be delivered close-first

*Severity claimed: medium*

The finder's code reading is accurate but the failure chain is already closed by a
different mechanism. Accurate half: in apps/worker/src/services/copy-mirror-delivery-
order.ts, compareDeliveryOrder's same-instant tiebreak still scores closes from
perpReduceOnly alone, and orderDueDeliveries' reader narrows a loaded row to
{sourceItemId, ...

### Discord line cannot distinguish a mirrored perp short-open from a long-close, both render " Sell"

*Severity claimed: medium*

The finder read the code correctly and nothing has fixed it. formatOrderLine in
apps/worker/src/services/discord-notify.ts (:185-217) derives both the side word and the
emoji from order.side alone; OrderNotification (:28-45) has no direction/reduceOnly
field and never reads assetType.

### Equity delivery ordering uses the order's write time, not the venue fill time, and the open-before-close tie-break is perp-only

*Severity claimed: medium*

The two code facts are accurate but the failure the finder built on them cannot occur,
and two of the claim's supporting premises are misreadings.

### Every Hyperliquid perp Discord line reports the wrong trade direction: an opening leveraged short renders as ' Sell' and a short-covering close renders as ' Buy'

*Severity claimed: medium*

The code is unchanged since cbcf236 (no commit touched discord-notify.ts, hyperliquid-
order-sync.ts, or perp-orders.ts), so the described rendering does happen:
apps/worker/src/services/hyperliquid-order-sync.ts passes only `side:
persisted.tradeAction` (plus an unused `assetType: "PERP"`) and formatOrderLine maps
Buy->" Buy" / Sell->" Se ...

### Mirrored equity SELLs have no attribution to the mirror's own exposure, so they sell shares the mirror never bought

*Severity claimed: medium*

Already fixed, in the six commits the finding was supposed to account for. The finder
read pre-fix code (their line numbers 1594/775/2954 are now 2340/889/4027). Current code
in apps/worker/src/services/copy-mirror.ts: 1. `mirroredEquityExposure(cand)` is read at
the top of every closing-intent candidate (~line 1668).

### OrderSyncPoller rewrites a copy-mirror PENDING row to SYNCING, after which the mirror's dedupe reports "duplicate" and silently drops the order

*Severity claimed: medium*

Already fixed by commit ffc3e02 ("fix(copy-mirror): six verified defects on the equity
execution path"), one of the six commits on this branch.

### Per-order dollar projection in Manage follows is computed from the terminal's active account, not the follow's destination

*Severity claimed: medium*

Already fixed in commit 5df89ab ("fix(copy-trade): four verified defects in follow
sizing, consent copy and arming"), one of the six commits on this branch. `git log -S
"balancesCredentialId"` on manage-follows.tsx points to exactly that commit.

### Resuming a stored PENDING equity order re-places it with no dollar-cap, daily-cap or sizing re-check, while the perp resume re-runs all of them

*Severity claimed: medium*

The headline failure, a resumed equity mirror placing a 21st order past the daily cap,
is already fixed, and the finder's quoted code no longer exists. WHAT THE CODE ACTUALLY
DOES NOW (apps/worker/src/services/copy-mirror.ts, `processCandidate` spans 1531-2485):
1. Daily cap IS re-taken on the equity resume.

### Social feed joins orders on brokerOrderId alone, unscoped by userId and undeduplicated, unlike all three sibling call sites

*Severity claimed: medium*

The finder read the join correctly but the failure it enables is not reachable. WHAT IS
TRUE: `apps/api/src/routers/social.ts` (join now at ~line 66-69, still unchanged after
all six commits, `git log cbcf236..HEAD -- apps/api/src/routers/social.ts` shows only
01d6a03, which added `executedSizeDecimal`, not the join) really does `.leftJoi ...

### The Hyperliquid perp fill notifier has no live/network gate, so testnet mirror fills post to the shared Discord channel indistinguishable from real-money mainnet fills

*Severity claimed: medium*

The finder misread the code, and the residual observation is a deployment-config
question, not a defect. 1. The "missing paper gate" parallel is false. `isPaperAccount`
(C:\Users\fciaf\OneDrive\Desktop\Projects\rst-stock-site\apps\api\src\lib\alpaca.ts:11)
returns true only for accountType "PAPER" or "SIM".

### The arming gate reads only the master mirror switch; the perps gate, mainnet opt-in and network are fetched and ignored

*Severity claimed: medium*

The code fact is accurate but the claimed failure is mostly a misread of the null/false
contract, and what survives is a zero-dollar no-op. VERIFIED AS DESCRIBED.

### The attempt-ceiling exemption for closes is keyed on `perpReduceOnly`, so equity exits are abandoned after 8 attempts

*Severity claimed: medium*

Already fixed by commit ef4bda2 ("six more verified defects on the worker execution
path"), which is one of the six commits on this branch.

### The close-pairing guard that stops a one-shot exit being spent while its open is still queued is perp-only, and explicitly excludes equity rows

*Severity claimed: medium*

Already fixed in commit ffc3e02 ("six verified defects on the equity execution path");
the finder was reading pre-ffc3e02 code. What the code looks like today: 1.

### The delivery attempt ceiling exempts only perp closes; an equity closing sell is abandoned after 8 attempts

*Severity claimed: medium*

ALREADY FIXED in commit ef4bda2, one of the six commits named in the task. The finder
read pre-ef4bda2 code (the stale line 1108; the code now lives at copy-mirror.ts:1384).
The described predicate no longer exists.

### The delivery attempt-ceiling exemption for closes keys on a perp-only field, so equity exits are abandoned after 8 attempts

*Severity claimed: medium*

ALREADY FIXED in commit ef4bda2 ("fix(copy-mirror): six more verified defects on the
worker execution path"), one of the six commits named in the task. The finder was
reading a pre-ef4bda2 tree. The claim was accurate as a description of the OLD code, but
the predicate it names no longer exists.

### The delivery attempt-ceiling exit exemption keys on perpReduceOnly, so an equity closing SELL is abandoned after 8 attempts while a perp close is not

*Severity claimed: medium*

Already fixed, the finder read a pre-fix version of the file. The exact code quoted as
evidence (`const reduceOnlyClose = row.candidate?.perpReduceOnly === true;`) no longer
exists anywhere in the repo.

### The equity PENDING-resume path re-sends the stored SELL quantity without re-reading the follower's long, so a resumed mirror sell can open a naked short

*Severity claimed: medium*

Already fixed, the finder read pre-fix code. Commit ffc3e02 ("fix(copy-mirror): six
verified defects on the equity execution path", one of the six listed commits) rewrote
exactly this branch.

### The equity resume path re-submits a stored PENDING order without re-clamping the SELL, the dollar cap or the daily cap

*Severity claimed: medium*

Mostly ALREADY FIXED in ffc3e02 (one of the six commits), and the residual is prevented
upstream. 1) SELL clamp, FIXED. The equity resume branch in
apps/worker/src/services/copy-mirror.ts (~line 1962, `if (existing?.status === "PENDING"
&& !existing.brokerOrderId)`) now calls `this.fetchLongQty(client, tradingSymbol)` and
`decideSellMirro ...

### The panel's inline Mirror switch silently repoints a Hyperliquid follow onto the active Alpaca account when arming

*Severity claimed: medium*

Already fixed by commit 5df89ab, one of the six commits on this branch. The claim
describes the pre-fix code (`const armingCredentialId = follow.autoMirror ?
follow.credentialId : activeCredentialId ?? null;`), which no longer exists.

### The panel's inline switch omits sizingInvalid, so a follow Manage follows refuses to arm can be armed from the feed

*Severity claimed: medium*

The finder misread what `sizingInvalid` means and the trigger they rely on does not
exist. 1. `sizingInvalid` is a DRAFT flag, not a property of the follow.

### The per-order dollar projection on every follow row is computed from the terminal's selected account, not from the follow's own mirror destination

*Severity claimed: medium*

ALREADY FIXED by commit 5df89ab, one of the six commits named in the brief. Its commit
message item #2 states the finding verbatim: "Each follow row projected dollars from the
terminal's active account rather..." The finder was reading pre-fix code; the cited line
numbers (manage-follows.tsx:623 and :606-620) are stale by roughly 120 line ...

### The two reconcilers partition the orders table on different columns, so `venue` is never consulted by the Alpaca side

*Severity claimed: medium*

The code description is accurate, `OrderSyncPoller.pollOnce`
(apps/worker/src/services/order-sync.ts, the query under the "ALPACA ONLY" comment)
filters on `ne(schema.orders.assetType, "PERP")` and never on `orders.venue`, while
`HyperliquidOrderSyncPoller.poll` (apps/worker/src/services/hyperliquid-order-sync.ts)
filters on `eq(venue,"hy ...

### copy-trade feed republishes copySourceLabel to every signed-in user, disclosing who a follower auto-mirrors and broadcasting unvalidated client text

*Severity claimed: medium*

Already fixed by one of the six commits, and the finder also misread the surviving code.
The claim's mechanism requires a mirrored order to produce a social_trades row. At
baseline cbcf236, apps/worker/src/services/copy-mirror.ts:3327 did exactly that (git
show cbcf236:...copy-mirror.ts confirms the insert at that line).

### generateClosedOrder mints a platform-branded PNL card entirely from client-supplied numbers, with no order lookup and no ownership check

*Severity claimed: medium*

MECHANISM IS REAL BUT DOCUMENTED-BY-DESIGN; IMPACT CHAIN IS NOT. Code check
(C:\Users\fciaf\OneDrive\Desktop\Projects\rst-stock-site\apps\api\src\routers\pnl-
image.ts).

## Dismissed: Alpaca and Hyperliquid tail

7 findings, all medium or low severity.

### ALPACA_CLIENT_ORDER_ID_MAX_LENGTH = 48 is self-imposed and stale, Alpaca documents 128 and the pinned SDK enforces nothing

*Severity claimed: low*

The constant is still 48 (packages/alpaca/src/client.ts:32, untouched by the 11
commits), but the claimed defect does not hold. 1) The claimed failure is unreachable
AND rests on a misreading.

### A refused or venue-rejected mirror leaves the follower's per-coin leverage and margin mode permanently rewritten

*Severity claimed: medium*

The mechanic described is present today. In `apps/worker/src/services/copy-mirror-perp-
execution.ts` the fresh open calls `deps.applyPerpLeverage(...)` (now ~:1230)
immediately before `deps.placePerpMirrorOrder(...)`, and the resume does the same
(~:544).

### Fractional sizing is hard-disabled, so an entire legal range of `usd`/`pct` follow settings silently mirrors nothing, forever

*Severity claimed: medium*

Mechanically accurate and unchanged by the branch. isSymbolFractionable
(apps/worker/src/services/copy-mirror.ts:4307) still ends in `void client; void
tradingSymbol; return false;`; computeMirrorQty (apps/api/src/lib/copy-
mirror.ts:124-131) therefore always floors; a non-closing `no-qty` logs at info (copy-
mirror.ts:2436-2471), returns t ...

### The copy-mirror resume recovers a possibly-placed order by scanning the last 500 broker orders instead of Alpaca's by-client-order-id endpoint

*Severity claimed: medium*

The code fact is accurate and unchanged on the branch: copy-mirror.ts:4633 recovers a
possibly-placed mirror with `client.getOrders("all", 500, true)` plus an in-memory
`.find()`, where an exact `getOrderByClientId` exists and is used elsewhere. But the
claimed failure is not reachable.

### buildPerpAssetCache discards `collateralToken`, so nothing can tell that a HIP-3 market is margined in a token other than USDC

*Severity claimed: medium*

The code facts check out but the failure does not. buildPerpAssetCache
(packages/hyperliquid/src/client.ts:95-119) really does drop the per-dex collateralToken
- PerpMetaUniverseLike (lines 80-87) does not even declare it - and
requiresDexAbstraction (apps/worker/src/services/copy-mirror-consent.ts:200) is still
the bare `coin.includes(": ...

### coveredDexes proves only that the per-dex read RESOLVED, never that the account mode makes that per-dex state meaningful, so the one-shot HIP-3 close can be retired on a state Hyperliquid says is not meaningful

*Severity claimed: medium*

Code descriptions check out, but the defect does not. WHAT IS TRUE. In
`C:/Users/fciaf/OneDrive/Desktop/Projects/rst-stock-
site/packages/hyperliquid/src/client.ts`, `perpAccountSnapshot` (now ~lines 1059-1183)
does fan out `clearinghouseState(address, dex)` per discovered HIP-3 dex and does build
`coveredDexes` purely from `extraStates.fl ...

### crossAccountValueUsd is used as "NET EQUITY" for pct_equity sizing but reads the cross-only, single-dex summary, which excludes every isolated position, and on trade[XYZ] every market is Isolated-Only

*Severity claimed: medium*

The claim describes pre-326b7c2 code. Two facts kill it. (1) `crossAccountValueUsd` is
dead code. A repo-wide ripgrep returns exactly one hit, its definition at
apps/worker/src/services/copy-mirror-perp-sizing.ts:125.

## What these audits could not establish

Recorded so nobody assumes it was covered:

- No test in this repo talks to a real Alpaca or Hyperliquid endpoint. Everything
  above is reasoning over source plus vendor documentation, with one exception: the
  HIP-3 collateral defect was confirmed by a live read against mainnet, and that
  measurement is recorded in the commit that fixed it.
- The equity mirror still has no runtime record proving it has ever placed an order in
  production. `docs/deployment/copy-mirror-env-reference.md` carries the queries to
  answer that against the live database.
- Signal-sourced perp mirrors have no exit. Known, documented at
  `copy-mirror-perp-execution.ts`, deliberately out of scope, and still the
  highest-value work outstanding on the feature.

