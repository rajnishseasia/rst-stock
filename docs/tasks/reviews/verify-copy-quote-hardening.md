# Quote And Routing Round-Two Review

## Scoped Verdict

**REJECT** at `652d454a5d80552207da35610ad8024fa27f9c1c`, parent
`6b856a4efe211d8f086c01142deb3af3b3572c30`.

Reviewed the entire eleven-file committed diff in
`/Users/frankciafardini/Documents/Codex/rst-copy-quote-hardening`, the quote
brief, repository rules and standing verifier instructions. Scope is original
P1 A/B only. Ticket and settings acceptance remain separate; the global release
gate remains REJECT. No unrelated source changes were found in this commit.

## Required Corrections

### 1. P1 - Quote age does not expire independently of query renders

`copy-trade-panel.tsx:1080` calculates readiness with the current clock only
while rendering. No panel timer or expiry subscription advances that clock.
The three quote queries poll every 30 seconds (`:671`, `:686`, `:724`), but
polling is not a guaranteed render at the 90-second boundary. An already
in-flight request can remain unresolved, and background or offline behavior
can suppress useful query changes. Feed polling is likewise not an expiry
contract. The row can retain its enabled state and old calculated size.

The click handler at `:1400` only checks sizing hydration before dispatching
the captured qty at `:1421-1435`. It neither recalculates quote readiness nor
checks the current timestamp. `resolveCopyDispatch` has no quote-readiness
input. Thus an enabled row can still prefill from an expired quote after the
last render. This affects stocks, perps and options.

Fresh real TanStack QueryObserver probes with the production readiness helper
showed a cached snapshot becoming stale at 90,001 ms, but clock advancement
alone generated zero observer notifications. Explicitly recomputing readiness
blocked it; the panel has no mechanism that performs that recomputation just
because time passes. This is query/helper behavioral evidence plus actual
panel control-flow inspection, not a mounted-browser reproduction.

Correction: introduce an independently scheduled expiry update with cleanup,
and revalidate the current snapshot and clock in the Copy action before any
dispatch. Preserve healthy background refresh while data is genuinely fresh.
Add actual panel/handler tests that hold network responses unresolved, advance
the clock through 90,000 and 90,001 ms without query data changes, and assert
both disabled UI and no dispatch for each instrument. Cover background resume
and a click that occurs before a delayed expiry callback has rendered.

### 2. P2 - Future cache timestamps extend the freshness window without bound

`copy-trade-quote-state.ts:46` rejects absent, non-finite and non-positive
timestamps, but accepts timestamps after now. The reused helper at
`lib/quote-freshness.ts:53-54` computes `now - updatedAt` and only rejects age
greater than 90,000. Negative ages become Updated just now.

Fresh production-helper probes accepted both `updatedAt = now + 1` and
`updatedAt = now + 86_400_000`. The latter can remain usable for more than a
day on that clock. This is not an exchange timestamp: installed TanStack
query-core `src/query.ts:714` defaults dataUpdatedAt to local `Date.now()` on
success. A backwards system-clock adjustment can therefore create this state
even without server clock skew. Query hydration/custom updatedAt can also
supply timestamps, although this review does not claim the application uses
those mechanisms for these queries.

Correction: define and enforce a conservative future-clock policy at this
money-affecting gate, rather than silently accepting negative age. Either
reject future timestamps and require a fresh response, or use an explicitly
approved bounded tolerance/monotonic elapsed-age strategy. Test a backwards
clock step after a real successful query, future timestamps, and recovery.
Do not invent a permissive tolerance without policy authorization.

## Verified Improvements

The routing correction passes this scoped review. The shared classifier is
used by quote identity, eligibility, perp route, panel view selection, row
state and dispatch. Each own perp-only marker, including perpVenue, perpCoin,
perpDirection, perpReduceOnly and perpLeverage, takes precedence over assetType.
Incomplete metadata stays on the refused-perp path rather than becoming an
equity. Explicit unknown asset types fail closed. A genuinely absent assetType
with no perp markers retains the existing legacy stock behavior.

Fresh table-driven tests cover individual markers, partial metadata, SOL
stock/perp collision, HIP-3 spelling, malformed markers, conflicting metadata
and dispatch with no perp route. Dispatch reclassifies the actual item, so
an inconsistent caller-supplied route cannot turn a marked perp into equity.
No new venue, fallback coin, price or precision is invented.

The error gate also works when evaluated. A read-only Bun probe imported real
QueryClient/QueryObserver from the installed @tanstack/react-query and the
candidate's real getCopyTradeQuoteReadiness helper. For independent stock,
perp and option query keys it seeded cached data, started a deferred query,
rejected it, then successfully resolved a new refetch:

| State | Cached Data | isError | isFetching | Copy Blocked |
| --- | --- | --- | --- | --- |
| Healthy background refresh | present | false | true | false |
| Failed refresh | retained | true | false | true |
| Retry still in flight | retained | true | true | true |
| Successful recovery | present | false | false | false |
| Exactly 90 seconds old | present | false | false | false |
| 90 seconds plus 1 ms, explicitly reassessed | present | false | false | true |

All three produced the same results. Missing/zero/NaN/Infinity timestamps
blocked. Stock last, perp markPx and side-appropriate option bid/ask use their
respective query's dataUpdatedAt/isError/isFetching in the actual panel.
The probe is not a claim of mounted three-venue UI coverage: its three keys
test the common query/helper contract, while wiring was checked in source.

## Threshold Provenance

The 90,000 ms value genuinely predates this patch in
`apps/web-v2/src/lib/quote-freshness.ts:9`; its last parent-history change is
`d5796323` (polish mobile terminal workflows). Existing consumers include the
watchlist, terminal market ticker and responsive trading shell. They also use
query dataUpdatedAt and the strict greater-than boundary, so exactly 90 seconds
is fresh under the reused calculation.

This establishes an existing trading-surface freshness-display convention,
not an independently verified broker execution expiry policy or an exchange
tick-age guarantee. The candidate duplicates the numeric value in its new
constant while calling the existing helper. Receipt time measures successful
client cache updates; it does not prove when the underlying market tick was
generated. No new threshold is required to fix correction 1.

## Fresh Verification

Run from the candidate root:

```sh
bun test apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts apps/web-v2/src/components/copy-trade/copy-trade-quote-freshness.test.ts apps/web-v2/src/components/copy-trade/copy-trade-quote-state.test.ts apps/web-v2/src/components/copy-trade/copy-trade-venue-hardening.test.ts apps/web-v2/src/components/copy-trade/copy-eligibility.test.ts apps/web-v2/src/components/copy-trade/copy-trade-quotes.test.ts apps/web-v2/src/components/copy-trade/copy-perp-route.test.ts
```

**125 pass, 0 fail, 459 assertions, 7 files.**

The real-query probes used retry false and deferred promises, no external
requests. They advanced an isolated process's Date.now, inspected observer
notifications and restored the clock. To reproduce: seed a QueryClient entry
with updatedAt equal to now, subscribe a QueryObserver with staleTime Infinity,
start/refuse/refetch/resolve its deferred query, and pass its current result's
data presence/dataUpdatedAt/isFetching/isError to the production helper at each
step. After success, advance now by 90,000 then 1 ms without resolving another
query. Observer notifications stay unchanged; explicitly called readiness
changes from allowed to blocked. Infinity isolates the query-event contract;
the panel's 15-second staleTime is also not a 90-second expiry subscription.

Committed freshness tests pass manually supplied snapshots and now values;
they do not mount the panel or prove time-driven expiration. Their three-venue
labels mostly exercise the same helper arguments, not real query integration.
The fresh real-query probe closes the retained-cache-error evidence gap, but
does not repair the missing panel/clock regressions.

Verified clean candidate worktree and passing `git diff --check HEAD^ HEAD`.
No fresh full suite, typecheck, lint, build or browser run was performed; the
coder-reported 4780 full-suite total is not independently certified here.

Return the two corrections and actual panel clock/dispatch tests to the same
coder. Only this new integration report was written. No candidate source or
test files, ledger, pushes, agents, orders or production state were changed.

---

## Final Quote Candidate Review - 2026-09-06

### Scoped Verdict: ACCEPT

Candidate: `dc2502a43a703a34198c1a0c77f0ae0a408fad2a`.
Base: `9478b9ae898b6c6d90003ae5505aea33f8d6ef11`.
Checkout: `/Users/frankciafardini/Documents/Codex/rst-copy-quotes-final`.

Read the full fifteen-file bounded diff, original rejection above, standing
verifier instructions and final-quotes receipt. No remaining correction found
in this exact conservative-classification and quote-freshness scope. Original
rejection history is preserved and still describes its original candidate.
This acceptance is not combined integration, deployment or release approval.

### Verified Corrections

- **Independent expiry:** `use-copy-trade-quote-clock.ts:26-59` subscribes to
  the actual query cache and schedules one earliest-expiry timeout at receipt
  time plus 90,001 ms. It refreshes on focus, pageshow and visibilitychange,
  and cleans up timer, subscription and listeners. Unresolved polling requests
  no longer prevent expiry. `copy-trade-panel.tsx:750-756` supplies the same
  exact tRPC query keys used by stocks, perps and credential-specific options.
- **Action-time safety:** panel `:1413-1440` reads current cache state directly,
  finds the current row quote, recomputes readiness and quantity, and refuses
  dispatch when blocked. It does not rely on captured DOM disabled state,
  observer notification delivery or the expiry callback rendering first.
  Current stock/option price changes affect submitted prefill quantity even
  when the visible button still shows the old quantity.
- **Clock anomalies:** `copy-trade-quote-state.ts:34-55` rejects future
  timestamps without a permissive tolerance. Hook `:12-23` latches an observed
  future timestamp against query identity and dataUpdateCount; merely letting
  the clock catch up does not release it. A new successful cache update can
  recover. Tests verify a backward clock step that puts now before a previous
  real response, plus future timestamps at +1 ms and +1 day. This is not a
  claim of monotonic detection for every backwards step that still leaves now
  after the receipt timestamp, nor exchange tick-age validation.
- **Conservative routing:** one classifier governs quote input, eligibility,
  perp route, view/mirror destination, row state and dispatch. Any own perp-only
  marker wins over conflicting assetType; incomplete metadata remains refused
  rather than becoming an equity. Unknown explicit asset types are refused.
  Truly missing assetType without markers keeps legacy manual stock Copy,
  while mirror arming still requires an explicit venue contract. SOL collision
  and HIP-3 market identity remain separated; no venue/price/precision fallback
  was introduced.

Paths above are under `apps/web-v2/src/components/copy-trade/` in the candidate.
The leaderboard test adjustment only supplies the real QueryClientProvider
required by its existing embedded-panel render; no unrelated source change
was found in the bounded diff.

### Actual-Component Evidence

Independently ran the committed browser child against the actual CopyTradePanel,
real React, tRPC and TanStack clients, not copied helper logic or hook doubles.
The in-page transport permits queries only, supplies fixture responses and can
hold them unresolved. Copy callbacks collect payloads without sending orders.
Browser time and observer delivery are controlled to expose stale-DOM races.

All **12 browser cases passed, 82 assertions**, covering:

- One expiry timer and three resume listeners, all removed on unmount.
- Stock/perp/option controls usable through exactly 90,000 ms during healthy
  background fetch; all disabled at 90,001 with unchanged unresolved snapshots.
- Still-enabled stale DOM buttons produce zero dispatches before the delayed
  expiry callback, then reflect disabled state on browser resume.
- For each instrument, a failed refresh with retained cache data blocks a click
  before observer rendering; successful response restores eligibility.
- Fresh stock and option prices determine current sizing before observer render.
  Perp checks assert the correct coin/side payload; manual perp Copy intentionally
  does not dispatch a priced quantity in this contract.
- Future and observed backwards-clock anomalies remain blocked through clock
  catch-up and recover after a new response, independently for all three queries.

An additional read-only Bun probe imported the actual classifier, dispatch and
readiness modules. **140 partial/conflicting marker cases** (five markers,
seven malformed/partial values, four assetType combinations) all classified as
perp and produced noop rather than equity dispatch when route was absent.
Explicit unknown/empty/null/non-string asset types were refused; missing type
remained legacy equity. Missing/null/zero/negative/NaN/Infinity/future timestamps
blocked, exact 90 seconds stayed fresh, and 90,001 ms blocked while fetching.

### Threshold And Limits

Verified the existing 90,000 ms convention in `lib/quote-freshness.ts:9`, last
parent-history change `d5796323`. Copy's constant is used by both readiness and
scheduling, with no numerical or boundary drift. Exporting the existing shared
constant remains a nonblocking centralization follow-up, not a reason to reject
this minimal correction. This remains client-cache receipt age, not exchange
tick age or an independently established broker execution expiry policy.

The browser fixture is a mounted functional regression test, not authenticated
application navigation, mobile visual acceptance or live market/broker proof.
It does not certify every browser throttling mode or system-clock behavior.
The action-time guard provides the fallback when timer delivery is delayed.

### Fresh Commands And Totals

From the candidate checkout, with
`RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`:

```sh
RST_QUOTE_CLOCK_TEST_CHILD=1 bun test apps/web-v2/src/components/copy-trade/copy-trade-panel-clock.test.ts
bun test apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts apps/web-v2/src/components/copy-trade/copy-trade-quote-freshness.test.ts apps/web-v2/src/components/copy-trade/copy-trade-quote-state.test.ts apps/web-v2/src/components/copy-trade/copy-trade-venue-hardening.test.ts apps/web-v2/src/components/copy-trade/copy-eligibility.test.ts apps/web-v2/src/components/copy-trade/copy-trade-quotes.test.ts apps/web-v2/src/components/copy-trade/copy-perp-route.test.ts apps/web-v2/src/components/copy-trade/copy-trade-panel-clock.test.ts apps/web-v2/src/components/copy-trade/leaderboard.test.ts
bun test
```

- Standalone browser child: **12 pass, 0 fail, 82 assertions**.
- Focused: **171 outer pass, 0 fail, 580 assertions, 9 files**; embedded
  browser child also passed, counted as one outer wrapper.
- Full exact candidate: **5016 pass, 33 skip, 0 fail, 14788 assertions,
  323 files**; embedded browser child passed again. Exit 0.

These are fresh independent executions, not adopted receipt totals. Verified
exact HEAD, clean starting tree and passing
`git diff --check 9478b9ae..dc2502a4`. No fresh typecheck, lint or Next build
was performed. Only this report append was written; no source/test/ledger edits,
agents, pushes, production, orders, Vercel, deployment or merge operations.
