# Manual Ticket Lifecycle Round-Two Review

## Scoped Verdict

**REJECT** for finding 4 only.

- Candidate: `885066a1b06ad882b2c124a250d635dc79f80d84`.
- Verified parent: `6b856a4efe211d8f086c01142deb3af3b3572c30`.
- Checkout: `/Users/frankciafardini/Documents/Codex/rst-copy-ticket-hardening`.
- Read the entire committed six-file diff, ticket brief, repository rules, and
  integration standing verifier instructions.

Other frontend settings/accessibility findings and quote P1 A/B are excluded.
The global gate remains REJECT independently of this scoped verdict.

## Corrections Required

### 1. P2 - Perp failure discards the identity needed to complete or cancel the retry

At `apps/web-v2/src/components/trade/perp-trade-form.tsx:1747`, Confirm reads
the pending nonce/source and immediately clears both refs at lines 1749-1750,
before invoking the asynchronous submit. A transport error, `success:false`,
or preparation refusal leaves the review open, but nothing restores those refs.
The next Confirm supplies an explicit null nonce. Its successful response
therefore skips the parent completion callback at lines 899-901. Cancel after
the failure also finds a null nonce at lines 1658-1660 and skips cancellation.

The parent event remains consumed but resident and continues supplying source
identity to subsequent same-coin/direction orders. This affects the shared perp
form on both desktop and mobile. Mobile sheet dismissal can still clear an
event, but retry-success and review Cancel must work independently.

Fresh isolated audit invokes the real PerpTradeForm form, Confirm, and Cancel
handlers with mocked transport responses:

- First-attempt success: completion callback receives nonce 7 (passing control).
- Transport error, then retry success: two orders submitted with the source,
  but no completion callback (expected [7], received []).
- Transport error, then Cancel: no cancellation callback.
- `success:false`, then retry success: no completion callback.
- `success:false`, then Cancel: no cancellation callback.

Correction: keep the reviewed nonce and immutable source for the whole review
attempt, including retries and local validation failures. Clear them only when
that review successfully completes, is explicitly cancelled, or is replaced.
Keep each asynchronous submission's own snapshot so an older completion cannot
settle a newer review. Add real-handler regressions for both error categories,
retry and Cancel, plus replacement while a response is pending.

### 2. P2 - X-feed stock Copy bypasses the new lifecycle entirely

`apps/web-v2/src/components/feed/signal-feed.tsx:1027` invokes
`stockSignalSelection`, which supplies `copySourceItemId` at
`apps/web-v2/src/components/feed/signal-selection.ts:74`.
The parent handler at
`apps/web-v2/src/app/app/trading-app-content.tsx:1797` clears old copy events
and stores the new source only in `selectedSignal`; it does not create an
`activeStockCopy` nonce event.

The rail continues forwarding this fallback source at
`apps/web-v2/src/app/app/venue-aware-panels.tsx:437`. However, stock review
captures its lifecycle nonce exclusively from `manualCopyPrefill` at
`apps/web-v2/src/components/trade/trade-form.tsx:964`. The new completion and
review-cancellation callbacks are all conditional on a non-null nonce.
Similarly, mobile dismissal at
`apps/web-v2/src/app/app/trading-app-content.tsx:3242` only cancels active
stock/perp events. Thus X-feed stock Copy has no event to complete or cancel,
and the original selectedSignal source survives success or dismissal/reopen.

This is the original provenance-lifetime defect in another existing stock
entry path, within the requested lifecycle scope. Evidence is the complete
source-to-parent-to-rail-to-submit control flow, not a browser reproduction of
this candidate.

Correction: give every manual stock-copy entry path an identity-bearing
lifecycle event, including X-feed Copy, or provide equivalent nonce-bound
ownership for selectedSignal provenance. Clear the matching source and signal
linkage on completion/dismissal without clearing a newer selection. Test both
the Copy Trade panel and X-feed stock chip, success then a same-symbol ordinary
order, review cancellation, and mobile dismiss/reopen.

### 3. P2 - Replacement tests do not exercise the required lifecycle wiring

`apps/web-v2/src/components/trade/trade-form-review.test.ts:423` replaces
two source-string tests with eight tests of create/consume/apply helper calls.
The tests import the real helper, so they do not copy its implementation.
However, the failure test at line 466 never submits or fails anything; the
reopen test creates a new copy event instead of reopening an ordinary ticket;
and the async test at line 481 has no asynchronous completion or parent state.
None invokes the new callbacks through either form or TradingAppContent.

These tests would pass if all newly added parent/rail/form callback wiring were
removed. The existing source regex was also broadened at lines 417-418 rather
than replaced. The 97 green tests consequently miss both defects above.

Correction: retain useful helper tests, but add behavioral coverage of actual
parent/rail/form lifecycle transitions and mutation outcomes. Include ordinary
stock, Smart Exit, bracket success/failure, perp retry/cancel, both stock Copy
entry points, mobile dismissal, reset/account changes, and an old completion
after a newer same-source and different-source prefill. Assert submitted
provenance and parent state, not just a helper return value. Replace the affected
source-wiring regex with handler behavior per CLAUDE.md:257-260.

## Verified Improvements And Limits

The new callbacks are threaded through both desktop and mobile rails. For
nonce-backed events, parent settlement checks the current event nonce and uses
a functional update with the real lifecycle helper
(`trading-app-content.tsx:1191` and `:1219`). This protects the active event
when a callback for an older nonce arrives after a newer event has rendered.
That is useful source-level evidence; the committed tests do not establish
the full asynchronous parent/child behavior.

Ordinary stock success associates its callback with the submitted idempotency
key (`trade-form.tsx:807`, `:2150`); Smart Exit and bracket paths retain the
captured nonce through their await and complete only after success
(`:2083`, `:2137`). Their failure paths do not explicitly complete the parent.
The account-change reset and mobile sheet dismissal now invoke cancellation
for existing nonce-backed events. Applying a prefill remains distinct from
completion. No unrelated source files changed in the committed diff.

These improvements are insufficient for acceptance because the perp review
lifetime and X-feed stock ownership gaps remain.

## Fresh Verification

Run in the candidate checkout:

```sh
bun test apps/web-v2/src/components/trade/manual-copy-prefill.test.ts apps/web-v2/src/components/trade/trade-form-review.test.ts apps/web-v2/src/components/trade/__tests__/trade-form.test.ts
```

Result: **97 pass, 0 fail, 293 assertions, 3 files**.

Permitted isolated audit file:
`/Users/frankciafardini/Documents/Codex/rst-copy-ticket-hardening/tests/audit-ticket-lifecycle.test.ts`.

Run separately, from candidate `apps/web-v2`:

```sh
bun test ../../tests/audit-ticket-lifecycle.test.ts
```

Result: **1 pass, 4 fail, 26 assertions, 1 file**. Each failure is the missing
expected lifecycle callback described in correction 1. The harness calls the
real component handlers and doubles hook storage, form input, and tRPC; it does
not copy production lifecycle logic or inspect source strings. It intentionally
does not run effects, mount child UI, or simulate a browser. Run it in its own
process because its module mocks are isolated audit instrumentation, not a
candidate suite addition. Initial harness setup failures were resolved before
this receipt; they are not counted as product failures.

`git diff --check HEAD^ HEAD` passes. No fresh full suite, typecheck, build, or
browser run was needed to establish this scoped rejection. The coder-reported
4756 full-suite total is not independently accepted here.

## QA And Handoff

The controller reports baseline desktop 1440/mobile 375 persistence and arm
cancellation, plus baseline mobile AAPL stale-prefill reproduction with zero
follower orders. AAPL/BTC fixtures and an isolated local perp-UI flag check are
being prepared. These are explicitly baseline observations, not browser
acceptance of candidate 885066a1.

Return corrections 1-3 to the same coder, then independently review the
replacement commit and real lifecycle tests. Candidate browser proof remains
pending. This review changed only its new integration report and the explicitly
authorized isolated audit file; no source, ledger, broker, production state,
push, or agent operations occurred.

---

## Final Ticket Candidate Review - 2026-09-06

### Scoped Verdict: ACCEPT

Candidate: `12c3a0cd42b21ab172ab911eabb450044e369fb7`.
Base: `9478b9ae898b6c6d90003ae5505aea33f8d6ef11`.
Checkout: `/Users/frankciafardini/Documents/Codex/rst-copy-ticket-final`.

Read the complete seven-file bounded diff, original rejection above, standing
verifier rules and outside-QA final-ticket receipt. This verdict supersedes the
original findings only for this exact candidate and scope. The original
rejection history remains unchanged. No remaining in-scope correction found.

### Verified Corrections

- **Perp retry/cancel identity:** `perp-trade-form.tsx:808-817` now holds one
  reviewed identity object. `:844-846` captures it for each attempt, `:930-936`
  resolves source from that snapshot, and `:976-995` retains it after transport
  failure or definitive refusal. A rejection releases the rejected cloid, while
  an ambiguous transport failure does not. Successful completion reports the
  captured nonce; matching-identity checks prevent resetting a newer review.
  Review cancellation at `:1743-1749` cancels the same retained nonce. Local
  precision refusal occurs before mutation and also retains the review identity.
- **Both stock entry paths:** `trading-app-content.tsx:1879-1892` gives X-feed
  stock Copy a parent-owned nonce, source and selected-account identity. It
  deliberately omits qty; `trade-form.tsx:1274-1280` consumes that ownership
  without replacing the existing unsized ticket fields. Copy-panel events keep
  their sized reset path. Completion/cancellation at parent `:1249-1303` checks
  nonce and clears corresponding source/signal linkage. Mobile close at
  `:860-866`, account changes and explicit market resets use that lifecycle.
- **Stock mutation outcomes:** ordinary submit associates its idempotency key
  with the reviewed nonce (`trade-form.tsx:2160-2163`, `:812-834`); only success
  completes it. Smart Exit and retained bracket submission complete the captured
  nonce after successful awaits (`:2096-2098`, `:2152-2154`). Failures retain the
  parent event for a new review/retry. Ordinary late success does not reset a
  newer nonce-backed ticket. Review Cancel clears matching ownership.
- **Accepted main-sync behavior:** the existing direct/manual perp arbiter and
  shared nonce sequence remain in place. The accepted
  `__tests__/perp-prefill-main-sync.test.ts` has no bounded-diff changes and its
  isolated suite passes in the fresh focused run. The rail only supplies manual
  completion/cancellation callbacks for the selected manual event.
- **Terminal legacy account auto-selection:** parent `:1232-1236` selects only
  identified nonblank PAPER/LIVE accounts instead of coercing unknown types to
  PAPER or preferring a legacy null-identity row. Real parent/form handler tests
  select a new identified LIVE row and submit its credential ID, preserve the
  old row unchanged, and refuse fresh orders when only null/blank/unknown-type
  rows exist. This does not certify the separate Copy UI picker follow-up.

All unqualified form paths are under `apps/web-v2/src/components/trade/`;
parent/rail paths are under `apps/web-v2/src/app/app/` in the candidate checkout.

### Test Quality And Fresh Evidence

The new lifecycle harness invokes the actual parent, rail, stock/perp form,
review and mutation callbacks. It doubles hook storage, form/query transports
and browser globals, not lifecycle implementation. It explicitly runs effects
and rerenders. Tests cover transport/refusal retry and Cancel on desktop/mobile
perps, local precision refusal, both stock entry paths, ordinary/Smart Exit/
bracket outcomes, same-symbol ordinary orders after settlement, account/reset
paths, mobile dismiss/ordinary reopen, and late responses with same-source and
different-source newer prefills/reviews/edited fields.

This is materially stronger than the removed three source-string assertions.
It is not browser rendering or real React scheduling coverage: hook updates
and rerenders are controlled by the harness, mutation isPending is doubled,
and form validation is not exercised end to end. The retained option bracket
handler uses an injected validated payload because the interactive selector
normalizes that OCO combination. No broker or production behavior is claimed.

Fresh commands in the exact candidate:

```sh
bun test apps/web-v2/src/components/trade/manual-copy-prefill.test.ts apps/web-v2/src/components/trade/trade-form-review.test.ts apps/web-v2/src/components/trade/__tests__/trade-form.test.ts apps/web-v2/src/components/trade/__tests__/ticket-lifecycle.test.ts apps/web-v2/src/components/trade/__tests__/perp-prefill-main-sync.test.ts
RST_TICKET_LIFECYCLE_CHILD=1 bun test apps/web-v2/src/components/trade/__tests__/ticket-lifecycle.test.ts
RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test
```

- Focused: **90 outer pass, 0 fail, 270 assertions, 5 files**, including the
  passing main-sync child and lifecycle wrapper.
- Lifecycle child, separately rerun: **51 pass, 0 fail**. Its assertions use
  node:assert; Bun does not include them in an expect() total.
- Full exact candidate: **4937 pass, 27 skip, 0 fail, 14413 assertions,
  314 files**; exit 0. The child cases are reported separately, not added to
  the outer total. No fresh typecheck/lint/build/browser run was performed.

### Independently Reconciled Counts

Compared `git ls-tree -r --name-only 9478b9ae` and HEAD and checked candidate
filesystem existence for every tracked test path: all **313 baseline source
test files remain present**, with only the new lifecycle test file added.
The full diff removes three test cases, not any source test file.

The fresh ticket tree has no generated packages/db/dist tests. The quote tree
contains the six generated files named below; independently running those exact
files produced **46 pass, 6 skip, 0 fail, 232 assertions**:

```text
packages/db/dist/migration-compatibility.test.js
packages/db/dist/connections/pool.test.js
packages/db/dist/__tests__/canonical-ingestion.test.js
packages/db/dist/__tests__/copy-trade-leverage-schema.test.js
packages/db/dist/__tests__/timestamp-key-indexes.test.js
packages/db/dist/__tests__/leaderboard-task3.integration.test.js
```

Thus supplied baseline 4985/33 reconciles as 4985 - 46 - 3 + 1 = **4937 pass**,
33 - 6 = **27 skip**, and 319 - 6 + 1 = **314 files**. Generated duplicates
explain the inventory difference; no missing source tests or hidden new skip
is needed to explain it. The baseline total itself was supplied, not rerun in
a newly created baseline checkout during this review.

Verified exact HEAD, clean starting candidate tree and passing
`git diff --check 9478b9ae..12c3a0cd`. Only this report append was written.
No source/test/ledger edits, agents, pushes, orders, production, Vercel,
deployment or merge operations. Global integration/release gates remain
separate; this is a scoped ticket acceptance.
