# Copy Frontend Integration Review

## Verdict

**REJECT** at candidate `6b856a4efe21` against `origin/main`
`a36d065a75af`.

This is a cold STRICT review of the independent stock/perp mirror UI, manual
copy lifecycle, destination account presentation, and accessibility boundary.
The four assigned findings are `1`, `4`, `5`, and `6` below. Two additional P1
boundary defects are recorded for the separately assigned quote/routing owner;
they are not part of this UI fix scope. No source, task-ledger, service,
broker, or production state was changed by this review.

## Assigned Findings

### 1. P1 - Destination-specific Stop makes globally false assurances

`apps/web-v2/src/components/copy-trade/manage-follows.tsx:648` builds a Stop
summary for one destination, and lines 668-680 patch only that destination.
However, `buildDestinationStopSummary` delegates to the global summary at
`apps/web-v2/src/components/copy-trade/mirror-consent.ts:480` and spreads all
of its points at line 498. Those points promise at lines 522 and 549 that no
new orders will be placed from the trader and, for account clearing, that the
follow can place nothing. The other independently armed destination is not
changed and can continue opening orders, including leveraged perps.

Required correction: make destination Stop/clear text explicitly venue-scoped
and state that the other destination is unchanged and may remain active. Keep
the global wording only for true global operations such as unfollow. Add
behavioral tests for Stocks armed while stopping Perps and Perps armed while
stopping Stocks, asserting both the saved patch and every displayed claim.

### 4. P2 - Consumed manual-copy provenance survives dismissal and successful submission

Consuming a prefill only toggles `consumed` at
`apps/web-v2/src/app/app/trading-app-content.tsx:1301-1307`; it leaves the
event and source identity resident. The event still contributes to
`tradeIsPrefilled` at lines 1279-1291 and is passed into desktop and mobile
forms at lines 2474-2483 and 3184-3193. Closing the mobile ticket at line 3168
does not clear it.

The wrapper correctly avoids reapplying consumed values at
`apps/web-v2/src/app/app/venue-aware-panels.tsx:362-365`, but still forwards
the consumed source at lines 384-389 and 423-430. The stock submit reads
`manualCopyPrefill.value` without checking `consumed` at
`apps/web-v2/src/components/trade/trade-form.tsx:1941-1951`; the perp form
similarly receives the stale source and resolves it at
`apps/web-v2/src/components/trade/perp-trade-form.tsx:840-847`. Successful
stock/perp submissions reset child form fields at `trade-form.tsx:802-850`
and `perp-trade-form.tsx:713-745`, but cannot clear the parent-owned event.

Consequently, close/reopen or a second same-symbol/same-direction order can be
attributed to an old feed item. Required correction: give the parent an
explicit provenance completion/cancel callback. Clear source identity after a
successful submission and explicit ticket dismissal/reset, while retaining it
through the current review and retry attempt. Add behavioral tests for
close/reopen, success followed by a same-symbol order, and retry after failure
for both stock and perp tickets.

The source-wiring checks at
`apps/web-v2/src/components/trade/trade-form-review.test.ts:416-435` read and
search component source. This conflicts with the repository test convention
at `CLAUDE.md:257-260` and did not detect the lifecycle bug. Replace them with
behavioral submission/lifecycle tests.

### 5. P2 - Exact Hyperliquid network labels are discarded by the web contract

The API constructs `Hyperliquid mainnet perps` or `Hyperliquid testnet perps`
at `apps/api/src/routers/copy-trade-follows.ts:476-483` and returns the exact
`credentialAccountLabel` on each destination at lines 648-656. The web
`MirrorDestinationConfig` omits that field at
`apps/web-v2/src/components/copy-trade/account-targeting.ts:11-16`, its account
option type also has no server label at lines 44-49, and
`accountOptionLabel` always returns generic `Hyperliquid perps` at lines 79-84.
Manage follows then uses that generic label in the picker, saved-account text,
and Stop confirmation at
`apps/web-v2/src/components/copy-trade/manage-follows.tsx:648-656` and
1781-1800.

For a live leveraged venue, hiding mainnet versus testnet defeats the purpose
of the server-provided account identity. Required correction: preserve a
server-produced, non-secret account label through both destination state and
the selectable-account contract, and use it consistently in picker, selected
state, arming, repointing, and Stop confirmations. Test both networks; do not
derive the network from an unrelated browser environment value.

### 6. P2 accessibility - Follow rows need immutable follow-and-destination ID namespaces

Every follow renders both destination sections at
`apps/web-v2/src/components/copy-trade/manage-follows.tsx:1494-1549`, but each
section uses only `${destination}-mirror-heading` for its `id` and
`aria-labelledby` at lines 1714-1723. With multiple follows, every stock
section repeats `stock-mirror-heading` and every perp section repeats
`perp-mirror-heading`. Assistive technology can resolve later sections to the
first trader's heading, so the controls lose their correct group context.

Required correction: derive the heading ID and every related control/label ID
from the immutable `follow.id` plus `destination` (for example, a stable
`follow.id`/destination namespace), and use that same namespace for all
`htmlFor`, `aria-labelledby`, `aria-describedby`, and control references in
the section. Do not rely on the destination alone or on array position. Add a
rendered-DOM regression with at least two follows: collect every `id`, assert
all IDs are unique, assert every `aria-labelledby` target exists exactly once,
and assert each label/control association resolves inside the intended
follow-and-destination section.

## Separately Owned P1 Boundary Findings

These defects were independently reproduced during the cold pass and are
listed so they are not lost. They are owned by the separate quote/routing
workstream. This review made no edits to `copy-trade-panel.tsx`,
`copy-trade-quotes.ts`, `copy-perp-route.ts`, `copy-eligibility.ts`, or
`copy-trade-row-state.ts`.

### P1-A - Partial perp metadata can dispatch an Alpaca equity order

Three independent readers treat a row as a perp only when `assetType` is
exactly `PERP`: `copyTradeQuoteIdentity` at
`apps/web-v2/src/components/copy-trade/copy-trade-quotes.ts:29-49`,
`perpCopyFromTradeRow` at
`apps/web-v2/src/components/copy-trade/copy-perp-route.ts:97-103`, and
`copyDisabledReason` at `apps/web-v2/src/components/copy-trade/copy-eligibility.ts:47-69`.
A partial row carrying authoritative-looking perp fields but missing
`assetType` therefore becomes a stock quote, gets no perp refusal, and reaches
the equity payload at `copy-trade-row-state.ts:269-295`.

Reproduction against the real pure modules used:

```ts
{
  perpVenue: "hyperliquid",
  perpCoin: "SOL",
  perpDirection: "long",
  perpReduceOnly: false,
}
```

With a `$10` quote and `$100` sizing, the result was an identity of
`{ venue: "stocks", symbol: "SOL" }`, no route, no disabled reason, and an
enabled equity dispatch of `SOL` for `10` shares. This is a wrong-venue order
payload, not merely a missing badge. The separate owner must use one
conservative classifier across quote selection, eligibility, route/view
selection, and dispatch; any perp-only marker in malformed metadata must fail
closed from equity routing. Add table-driven regressions for each partial
marker, symbol collisions, and a HIP-3-prefixed market.

### P1-B - Failed quote refreshes leave Copy enabled with retained sizing data

The stock query at
`apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx:654-665`, perp
query at lines 671-676, and option query at lines 707-729 configure periodic
refreshes, but the component does not gate on `dataUpdatedAt`, `isError`, or a
maximum quote age before using `query.data`. It feeds retained data directly
into quantity calculation at lines 991-1077.

TanStack Query `5.90.16` was reproduced directly: after seeding an `AAPL`
quote at `100` and making the next fetch throw, cached data remained present
while query status was `error` and fetch status was `idle`. Copy can therefore
continue using a materially stale price after a failed refresh. The separate
owner must define and test an explicit freshness/error policy for stocks,
perps, and options, including the age boundary, missing timestamps, failed
refresh, recovery, and healthy background refetch behavior.

## Positive Evidence

Well-formed perp routing preserves canonical case and HIP-3 prefixes, refuses
missing venue/coin/direction/reduce-only state, keeps perp chart selection on
the perp venue, and prevents an equity signal ID from crossing venue identity.
The server-side manual-source endpoint validates canonical source identity,
venue, symbol, direction, and replay identity. Independent destination patches
also preserve the unrelated destination in the inspected normal cases.

Changed UI controls are generally semantic and viewport-bounded: dialogs and
menus constrain width, content can scroll, rows use `min-w-0`/truncation, and
the primary narrow-viewport controls retain usable target sizes. The duplicate
ID finding is the concrete accessibility blocker from the static pass.

## Test Receipt

Fresh focused execution on exact candidate `6b856a4e`:

```text
bun test \
  apps/web-v2/src/components/copy-trade/copy-trade-quotes.test.ts \
  apps/web-v2/src/components/copy-trade/copy-perp-route.test.ts \
  apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts \
  apps/web-v2/src/components/copy-trade/independent-mirror.test.tsx \
  apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx \
  apps/web-v2/src/components/feed/signal-selection.test.ts \
  apps/web-v2/src/components/feed/signal-perp.test.ts \
  apps/web-v2/src/components/trade/manual-copy-prefill.test.ts \
  apps/web-v2/src/components/trade/trade-form-review.test.ts \
  apps/web-v2/src/components/trade/__tests__/trade-form.test.ts \
  apps/api/src/__tests__/manual-copy-source.test.ts \
  apps/api/src/__tests__/order-idempotency-router.case.ts \
  apps/api/src/__tests__/copy-trade-independent-destinations.test.ts

348 pass, 0 fail, 1090 expect() calls, 12 test files
```

The green tests cover well-formed routes, destination persistence, and current
submission wiring. They omit the destination-wording regression, opposite-
destination liveness after Stop, parent-owned provenance disposal,
network-specific labels, multi-follow ID uniqueness, partial-perp markers, and
quote-error freshness.

No browser rendering was performed by this verifier. Desktop/mobile observed
behavior and screenshots remain the separately assigned QA gate; module tests
and this static accessibility pass are not browser proof. No live broker or
production checks were performed.

## Controller Documentation

The inspected maintenance cutover in
`docs/tasks/social-copy-maintainer-notes.md:11-31` correctly requires a
non-rolling window: block old writers, drain mutations, pause old workers,
migrate through the worker's direct database connection, deploy all new API
instances and web, verify, then resume. The runtime controls and disposable-
database limitations are accurately scoped.

The two previously ambiguous statements are now appropriately qualified in
the inspected controller copies: the Stop boundary is marked as pending the
stock race correction and cold verification, and
`social-copy-verification.md:7-8` distinguishes no production database access
from disposable local PostgreSQL proof. The verification checklist remains
unchecked. Recorded candidate and baseline test totals, 11/11 type/build
totals, lint exit, one-test migration proof, and `git diff --check` receipt are
evidence, not acceptance.

## Round-Two Acceptance

Round two must review the complete correction diff for assigned findings
`1, 4, 5, 6`, reproduce each behaviorally, rerun the focused suites, and
confirm no unrelated source changed. The separately owned P1-A/P1-B fixes
must receive their own cold verification before the combined gate can pass.
Acceptance also requires the separately assigned desktop/mobile browser
evidence and the controller's fresh combined gate. PR CI and deployed exchange
readiness remain later release checks and cannot be inferred from local
fixtures.
