# Main Synchronization Merge Review

## Scoped Verdict

**REJECT** the main synchronization merge
`a824cd58991e50130aa280dcf079dd58b7d71b0f` until the two merge-induced
findings below are corrected and covered by the required regressions.

- First parent: `77914c19625be7fb212050742e6d2a1796dc418e`.
- Incoming `main` parent: `f3cfcb4f497555b800171c52072717ed577b1c65`.
- Merge tree: `8e598c4129da6876ee68794c3dbe8fdc6855cd71`.
- Subject: `merge: sync copy review with main`.
- Candidate checkout:
  `/Users/frankciafardini/Documents/Codex/rst-copy-main-sync`.

This is a bounded merge-resolution verdict. It covers the four declared
conflicts and the named semantic auto-merges only. The unchanged incoming
files were not re-audited. Existing global copy-feature REJECT findings are
outside this verdict and are not reasons for this synchronization REJECT.

## Findings

### 1. P1 - Manual-copy state shadows or converts ordinary direct perp actions

The two parents define distinct, compatible contracts:

- The first parent's **actual manual Copy** is an identity-bearing event. The
  merged handler creates it with coin, side, leverage and `copySourceItemId` at
  `apps/web-v2/src/app/app/trading-app-content.tsx:2080-2089`. The form sees a
  consume callback and intentionally performs a complete ticket replacement at
  `apps/web-v2/src/components/trade/perp-trade-form.tsx:510-533`: side and
  leverage are applied while size, exits, advanced state and pending review are
  cleared. Its source is accepted only for a matching opening order at
  `perp-trade-form.tsx:930-937` and is sent at lines 969-971. This full-prefill
  and provenance behavior must remain intact for a real Copy action.
- Incoming parent `f3cfcb4f` defines **ordinary mobile side selection and
  order-book price selection** as lightweight direct prefills. Its mobile
  handler at `trading-app-content.tsx:3043-3050` sets only side/direct-prefill
  state and creates no manual-copy event. Its order-book handler at lines
  1703-1710 sets a direct limit price and nonce. The corresponding no-callback
  form branch changes only represented fields at merged
  `apps/web-v2/src/components/trade/perp-trade-form.tsx:534-551`. Existing
  size, margin mode, user leverage, TP/SL and other unrelated ticket state are
  therefore retained, and an ordinary action carries no Copy provenance.

The resolution does not keep those channels separate. A consumed manual event
remains non-null, and `VenueAwareTradeRail` gives any non-null event precedence
over the direct channel at
`apps/web-v2/src/app/app/venue-aware-panels.tsx:362-393`. Even when the event is
consumed, the rail forwards its old nonce, coin, consumed flag, consume callback
and source while suppressing the new direct side and leverage. The form returns
on `prefillConsumed` at `perp-trade-form.tsx:504-509`, before the direct limit
price can switch the ticket to Limit at lines 548-550.

A fresh no-write probe invoked the real merged rail with a consumed same-coin
manual event at nonce 7 and a newer order-book prefill at nonce 8. It emitted:

```text
initialIsLong=null
initialLeverage=null
initialLimitPrice="61234.5"
prefillNonce=7
prefillCoin="BTC"
prefillConsumed=true
hasConsumeCallback=true
copySourceItemId="user:prior-copy"
```

Thus the form ignores the new price and does not switch to a Limit ticket.
`handleBookPriceSelect` updates only the direct state at
`trading-app-content.tsx:1771-1778`; it does not retire the manual event that
shadows that state.

The inverse failure occurs on the ordinary mobile Long/Short action. The merge
adds a new manual-copy event at `trading-app-content.tsx:3167-3175` and then
also performs the incoming direct update at lines 3179-3183. The rail chooses
the event and supplies a consume callback, so the form takes the full manual
reset branch. This contradicts the adjacent merged comment and regresses the
incoming parent's partial side-selection behavior.

Required correction, without adding product semantics: preserve exactly one
prefill kind per action. A real manual Copy must keep its full reset, matching
coin/side source attribution and nonce consumption. An ordinary mobile side or
order-book action must use the direct nonce with `prefillConsumed=false`, no
manual consume callback and no Copy source; a prior manual event must be cleared
or excluded from arbitration when that ordinary action supersedes it. The
direct branch must retain unrelated ticket fields. Do not import the excluded
ticket-lifecycle patch to make this correction.

Required behavioral regressions:

1. Compose the production parent/rail/form path for a consumed same-coin manual
   Copy followed by an order-book click. Assert the newer direct nonce wins,
   the selected price and `Limit` type apply, unrelated fields remain, and the
   old source/callback are not attached to the ordinary action.
2. Invoke the production mobile Long/Short handler through the rail/form. Assert
   only direction changes, no `ManualCopyPrefillEvent` or Copy source is created,
   and existing size, order type/price, margin mode, leverage and TP/SL remain.
3. Keep a control for an actual manual Copy. Assert its side/leverage perform the
   complete reset, its nonce is consumed, and its `copySourceItemId` is retained
   only for the matching opening order. These must exercise rendered handlers
   and effects, not source-text searches or isolated helper fixtures.

### 2. P2 - The stacked sizing selector keeps two-column borders after becoming a row

The first parent supplies `stackOnNarrow`: a two-column selector with vertical
and horizontal grid dividers. The incoming parent supplies the flat mobile tab
styling and an inline selector before the `xl` terminal treatment. Both can be
preserved, but the merged responsive classes leave the two layouts overlapping.

At `apps/web-v2/src/components/copy-trade/sizing-mode-tabs.tsx:43-52`, the
selector starts as a two-column grid and switches to `sm:inline-flex`. The
two-column left borders at line 73 and second-row top borders at line 74 are
unprefixed, however, and the top borders are not removed until `xl`. From `sm`
through `lg`, all four buttons are in one row while buttons three and four keep
top borders, buttons two and four keep left borders, and there is no divider
between buttons two and three.

The added test at
`apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx:776-797` checks
only that `grid-cols-2` exists and that a button callback works. It does not
exercise the `sm` transition or detect the malformed row dividers.

Required correction, without changing the control's meaning: retain the first
parent's coherent 2-by-2 layout below `sm`, the incoming flat inline treatment
when it becomes a row, and the incoming compact terminal treatment at `xl`.
Remove or replace the grid-only dividers at the same breakpoint where display
changes.

Required behavioral regression: render the `stackOnNarrow` control at below
`sm`, `sm` through `lg`, and `xl`; verify a coherent 2-by-2 grid, a single row
with consistent dividers, and the terminal frame respectively, while retaining
selection and click behavior. The regression must evaluate the responsive
result rather than merely assert that mutually conflicting class tokens exist.

## Merge Boundary Verified

The merge object has the exact requested two parents. The complete incoming
first-parent path is present and ancestral:

```text
dfe4ea68ea0f742320fe9a2f52bc21c059f1033a  #238 mobile parity
2e8044baf1b783398db3eccd0e0daa88afd759ae  #240 mobile trade flow / alerts
9186c064370a0128031abeb87a58782b6d887181  #241 Sentry / positions
f3cfcb4f497555b800171c52072717ed577b1c65  #242 PNL label
```

The excluded commits `79b14614`, `885066a1`, `b41f1b9b`, `652d454a` and
`65cc322e` are all non-ancestors. A one-commit `git cherry` comparison marks
each `+`, confirming that none of their complete patches is present.

From merge base `a36d065a`, the parents overlap on exactly seven paths: the
four conflicts plus `copy-trade-panel.tsx`, `copy-trade-panel.test.ts` and
`mirror-consent.test.tsx`. Parent-only blob comparison found no blanket loss:
every incoming-only candidate blob equals the incoming parent and every
first-parent-only candidate blob equals the first parent.

`git show --remerge-diff` identifies the manual-resolution write set as exactly
the four conflict files plus a 23-line test in `mirror-consent.test.tsx`. The
copy-trade panel and its test are clean auto-merges: incoming flattening/style
changes coexist with the first parent's independent destination and Copy
behavior. The mirror-consent additions retain both parents' assertions. No
additional semantic auto-merge defect was found beyond sizing finding 2.

## Fresh Verification

Fresh focused run on the exact merge:

```sh
bun test \
  apps/web-v2/src/app/app/trading-app-content.mobile.test.tsx \
  apps/web-v2/src/app/app/page-layout.test.ts \
  apps/web-v2/src/components/trade/perp-form-math.test.ts \
  apps/web-v2/src/components/trade/manual-copy-prefill.test.ts \
  apps/web-v2/src/components/trade/perp-tpsl-input.test.ts \
  apps/web-v2/src/components/copy-trade/independent-mirror.test.tsx \
  apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx \
  apps/web-v2/src/components/copy-trade/copy-perp-route.test.ts \
  apps/web-v2/src/components/copy-trade/copy-trade-quotes.test.ts \
  apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts \
  apps/web-v2/src/components/copy-trade/copy-eligibility.test.ts \
  apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx
```

Result: **384 pass, 0 fail, 1,352 assertions, 12 files**.
Log: `/Users/frankciafardini/Documents/Codex/rst-copy-qa-artifacts/main-sync-verifier-focused-20260906.log`.

Additional fresh gates:

- `bun test`: **4,983 pass, 33 skip, 0 fail, 14,563 assertions, 318 files**.
  Log: `main-sync-verifier-tests-20260906.log`.
- `TURBO_FORCE=true bun run check-types`: **11/11 successful, 0 cached**.
  Log: `main-sync-verifier-types-20260906.log`.
- `TURBO_FORCE=true bun run lint`: **exit 0** with existing warnings.
  Log: `main-sync-verifier-lint-20260906.log`.
- `git diff --check 77914c19 a824cd58`: clean.
- Conflict-marker scan across the four conflicts and three semantic auto-merges:
  no matches.

The green suites do not compose a consumed manual event with a later direct
prefill and do not evaluate the sizing control across responsive breakpoints,
so they do not contradict the two findings. The controller independently
reports the exact merge build **11/11 successful**; that build is corroborating
evidence, not browser proof or resolution acceptance.

## Final Status

The candidate remains detached at exact merge `a824cd58`; no candidate source,
test, configuration, generated file, migration, ledger, environment, broker or
production state was edited by this verifier. No push or agent operation was
performed. The only verifier-authored integration change is this report.

Acceptance requires a scoped correction of findings 1 and 2, the specified
behavioral regressions, and a cold review of that correction. The existing
global copy-feature verdict remains separate.

## Round Two: Scoped ACCEPT

**ACCEPT** corrective commit
`08c23cfaa5aa23757d514f9a98f4960ec0808c81`, whose sole parent is
`a824cd58991e50130aa280dcf079dd58b7d71b0f`, for the two synchronization
findings above. The first-round rejection remains historical evidence for the
uncorrected merge. This acceptance closes only those two findings; the global
copy-feature REJECT remains unchanged.

Read the complete five-file corrective diff and compared it with the required
behavior in this report. Ownership is confined to three production files
(`trading-app-content.tsx`, `venue-aware-panels.tsx`, `sizing-mode-tabs.tsx`),
the existing `mirror-consent.test.tsx`, and the new
`trade/__tests__/perp-prefill-main-sync.test.ts`. No unrelated production,
dependency, lockfile, migration, API, worker or lifecycle patch was added.

### Finding 1 Closed: Distinct Prefill Actions

At corrected `apps/web-v2/src/app/app/trading-app-content.tsx:1347-1357`,
clearing Copy state now also zeros the direct prefill nonce and clears its
values. The real order-book handler at lines 1774-1783 clears the previous
event, sets only the direct price/coin, and allocates a new nonce from the
shared `perpCopyNonceRef`. The mobile side handler at lines 3160-3171 uses
the same sequence and sets direct side state without creating a manual event.
The actual Copy handler clears the direct state at line 2066 and creates its
identity-bearing event at lines 2085-2094; it no longer duplicates that event
into the direct channel.

At corrected `apps/web-v2/src/app/app/venue-aware-panels.tsx:362-396`, an active
direct nonce selects direct props and excludes manual source identity and the
consume callback. Otherwise the real manual event supplies its nonce, consumed
flag and source. This uses explicit channel state, not a comparison of unrelated
nonce magnitudes. Sharing the producer sequence prevents a fresh Copy from
reusing the identity of an already applied direct action.

The unchanged form at `perp-trade-form.tsx:504-551` therefore reaches the
appropriate branch: ordinary actions retain size, margin mode, user leverage,
order fields and exits except for the fields represented by that action;
order-book selection changes price and order type to Limit, and mobile side
selection changes direction. Actual Copy still performs the complete reset,
clears exits and review state, and preserves matching opening-order provenance.
The unchanged source guard at `manual-copy-prefill.ts:113-131` rejects a
different coin, opposite direction or reduce-only order.

Independent execution of the committed real-handler regressions passed:

- A consumed manual event followed by a direct price supplies nonce 8 instead
  of 7, applies Limit and its price without another reset, retains the other
  populated fields, and submits without the previous Copy source.
- The actual mobile handler preserves a populated StopLimit ticket, size,
  margin mode, leverage, trigger/limit prices, post-only state and both TP/SL
  inputs while changing direction. No manual event, source or callback remains.
- Actual Copy after a direct book action resets the ticket to the copied
  side/leverage with empty size/prices and cleared exits. Its consumed event
  remains the source for the matching opening submission; an opposite-side
  submission omits it. The direct nonce is zero, and another render does not
  revive the older direct price or overwrite newly entered size.
- The actual parent book handler after that consumed Copy again preserves
  unrelated fields, applies the new Limit price and removes manual provenance.

Assertion assessment: these tests import the real parent, rail and form,
obtain handlers from their returned JSX, execute form effects, and inspect
resulting fields and mutation payloads. They do not search production source
or reproduce the prefill implementation in a helper. React hook storage,
react-hook-form state and transport are doubled in a child process; parent
effects are deliberately disabled. Thus this proves the requested handler and
form-effect composition, not a full React application mount, network lifecycle
or broker execution. The final book submission assertion alone does not assert
a submission-count increment, but its preceding real effect/field/source
assertions and the separate direct-price submission control establish this
correction. These limits do not reopen the unrelated lifecycle review.

### Finding 2 Closed: Computed Responsive Dividers

At corrected `apps/web-v2/src/components/copy-trade/sizing-mode-tabs.tsx:73-74`,
both grid-only dividers now use `max-sm`. They cease at the same breakpoint
where line 52 changes the grid to an inline row. The existing `xl` dividers and
frame are retained.

Independently ran the new browser regression at
`apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx:799` with its
Playwright opt-in enabled. All twelve combinations passed: `stackOnNarrow`
false and true, each at 375, 639, 640, 1024, 1279 and 1280 pixels. It mounts the
real React selector, compiles its real classes with Tailwind, reads computed
display/borders/frame/height and button coordinates, and clicks the dollar
option to verify selected state. Assertions distinguish the two-row grid below
sm, the border-consistent flat row through lg, and the framed terminal row at
xl. This addresses the original class-token-only test weakness. It is component
browser evidence using Tailwind's theme/preflight, not full-app CSS or page QA.

### Independent Test Receipt

From the candidate checkout, on exact correction `08c23cfa`:

```sh
RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test apps/web-v2/src/components/trade/__tests__/perp-prefill-main-sync.test.ts apps/web-v2/src/components/trade/manual-copy-prefill.test.ts apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx
```

**120 pass, 0 fail, 485 assertions, 3 files**, with the responsive browser
test executed (not skipped). Log:
`/Users/frankciafardini/Documents/Codex/rst-copy-qa-artifacts/main-sync-round2-verifier-focused.log`.

```sh
RST_PREFILL_TEST_CHILD=1 bun test apps/web-v2/src/components/trade/__tests__/perp-prefill-main-sync.test.ts
```

**2 pass, 0 fail, 31 assertions** in the isolated handler process. This is
the child coverage also exercised by the outer suite, not two additional
independent scenarios. Log:
`/Users/frankciafardini/Documents/Codex/rst-copy-qa-artifacts/main-sync-round2-verifier-handlers.log`.

`git diff --check a824cd58 08c23cfa` passed. No further canonical or type/build
run was performed by this verifier, as requested. The correction receipt's
4,985 pass / 33 skip, types 11/11 and lint exit 0 remain reported evidence.
The controller reports that the corrected build reached compilation, types
and static pages but failed with ENOSPC while writing a Next manifest; cache
cleanup and rebuild are pending. A successful corrected build is not claimed.

### Round-Two Final Status

The inspected HEAD is exact correction `08c23cfa` with parent `a824cd58`.
The candidate status during verification contains only modified
`apps/web-v2/next-env.d.ts`, associated with the controller's concurrent build;
the verifier left it untouched. The integration checkout retains its existing
ledger and other review files. This appended report is the only integration
file edited by the verifier. All verifier exec sessions have completed.

No further correction is required for these two findings. Controller final
gates, including the pending corrected build, remain the controller's next
step before integration; this report performs no fast-forward or publication.
