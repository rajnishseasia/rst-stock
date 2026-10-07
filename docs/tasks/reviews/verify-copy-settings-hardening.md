# Destination Settings Round-Two Review

## Scoped Verdict

**REJECT** at `b41f1b9b5da3fc8ed793d14259bfb8fdf1b42a45`, verified parent
`6b856a4efe211d8f086c01142deb3af3b3572c30`.

Reviewed the complete seven-file commit in
`/Users/frankciafardini/Documents/Codex/rst-copy-ui-hardening`, the settings
brief, and standing verifier rules. Scope: original findings 1, 5, 6 and the
off-to-off settings toast. Ticket and quote commits are independent and excluded.
The global release gate remains REJECT.

## Remaining Findings

### 1. P2 - Exact network labels still do not reach the real picker or Stop confirmation

`use-manage-follows.ts:116-122` builds account options from
`userSettings.hasApiCredentials`. That endpoint returns id, provider,
accountId, accountType, username, baseUrl and updatedAt at
`apps/api/src/routers/user-settings.ts:281-290`; it never returns the new
optional credentialAccountLabel. Consequently, `account-targeting.ts:75`
stores null and `:84-87` falls back to generic Hyperliquid perps.

The picker at `manage-follows.tsx:1811-1814` only uses that account label.
Although saved text and ordinary arming now prefer the saved destination's
exact label, Stop at `:662` prefers the resolved account's generic label and
only reads the saved exact label when the account is missing. Repointing to a
different credential likewise uses the generic new account at `:575-579`.
Thus real mainnet/testnet identities remain hidden in required confirmations.

Fresh helper probes with the actual endpoint's field shape returned, for each
network:

| Network | Saved destination | Picker | Resolved-account Stop |
| --- | --- | --- | --- |
| mainnet | Hyperliquid mainnet perps | Hyperliquid perps | Hyperliquid perps |
| testnet | Hyperliquid testnet perps | Hyperliquid perps | Hyperliquid perps |

Correction: provide server-authoritative exact labels on the actual selectable
account response, or obtain them through an existing authoritative server
contract that covers every selectable credential. Prefer the matching saved
label where appropriate, including Stop. Do not infer network from a browser
environment. If the required endpoint falls outside coder ownership, have the
controller assign that bounded API contract change. Add tests using the real
response shape and actual picker/arm/repoint/Stop wiring for both networks.
The new account-targeting test supplies a field production never supplies and
therefore does not prove the integration.

### 2. P2 - Off-to-off sizing saves still announce Stop when the account is empty

`mirror-consent.ts:729-731` unconditionally emits account-cleared-and-stopped
text whenever credentialId is null, before checking whether a stop occurred.
A disabled destination with no selected account is valid, and its sizing edit
passes the full config through the existing destination update handler.

Fresh real-helper probes for both Stocks and Perps, enabled false,
credentialId null and sizingValue 123.45, returned:

- Stocks mirror account cleared and automatic orders stopped.
- Perps mirror account cleared and automatic orders stopped.

No account was cleared and no on-to-off transition occurred. The new test only
covers a disabled destination with a non-null credential.

Correction: classify the actual transition/action before choosing either
account-cleared or stopped wording. Ordinary off-to-off edits must report
settings saved, with or without an account. Preserve genuine on-to-off and
explicit account-clear feedback. Add both destinations and null/non-null
credential cases, plus actual confirmation-to-mutation-to-toast tests.

## Accepted Parts Of This Scope

Finding 1's destination confirmation wording is corrected: disarm and clear
state that only the selected venue stops and the other venue is unchanged and
may remain active. Existing exposure and queued-close caveats remain scoped.
The removed global claims are absent. True global unfollow retains its global
summary. The confirmation still constructs a partial patch containing only the
selected destination. Fresh helper assertions covered both directions and both
Stop kinds; existing behavioral tests cover destination-specific update paths.

Finding 6's heading/control namespace is corrected using immutable follow.id
plus destination at `manage-follows.tsx:1637`. Heading, account, sizing,
leverage and protection IDs use that namespace. The fresh two-follow rendered
markup test passes uniqueness and single-target aria-labelledby assertions
and explicitly checks both destinations for both follows. This is actual
rendered markup testing, not source-string matching. Browser focus and layout
are not newly certified by this review.

The ordinary off-to-off save with a selected account now reports Follow
settings updated. A marked true on-to-off config still reports the selected
destination stopped. Fresh probes verified both. The hook shallow-spreads the
patch at `use-manage-follows.ts:173`, retaining the nested config identity
used by the WeakSet marker. These passing cases do not cover correction 2.

All web filenames above are under
`apps/web-v2/src/components/copy-trade/` in the reviewed checkout.

## Fresh Evidence

```sh
bun test apps/web-v2/src/components/copy-trade/account-targeting.test.ts apps/web-v2/src/components/copy-trade/independent-mirror.test.tsx apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx
```

**143 pass, 0 fail, 463 assertions, 3 files.**

Additional read-only Bun probes imported the real account, destination-patch,
saved-state and toast helpers. They checked destination-only patch keys,
scoped Stop text, selected-account off saves, true marked stops, empty-account
off saves, and real account-response label handling. Results are recorded above.
No audit test file or source file was added for this settings review.

Verified exact candidate/parent and clean candidate working tree.
`git diff --check HEAD^ HEAD` passes. The reported full-suite 4758 count is
not independently accepted here; no full build or browser run was performed.
Baseline QA persistence/arm-cancel evidence is not browser acceptance of b41f1b9b.

Return the two corrections and integration tests to the same settings coder.
Only this new report was written; no ledger/source/push/agent/production actions.

---

## Final Settings Candidate Review - 2026-09-06

### Scoped Verdict: ACCEPT

Candidate: `fddefd20f346a3c096b49107e474af51cc108f07`.
Compared base: `9478b9ae898b6c6d90003ae5505aea33f8d6ef11`.
Checkout: `/Users/frankciafardini/Documents/Codex/rst-copy-settings-final`.

Independently read the complete ten-file `9478b9ae..fddefd20` diff, current
endpoint and UI wiring, repository rules, standing verifier instructions and
the original rejection above. The original rejection remains intact and applies
to its original candidate. No remaining correction is required for this exact
settings label/confirmation/toast/ID batch.

The known legacy Alpaca null-identity selection guard is explicitly excluded
and remains a separate coordinated follow-up. This verdict does not approve
that guard, other candidates, global release, deployment or merge. No contributor
PR, access, Vercel, deployment or merge operations were performed.

### Resolution Of Prior Findings

1. **Actual endpoint-to-picker labels are fixed.**
   `apps/api/src/routers/user-settings.ts:284-289` now returns
   credentialAccountLabel for Hyperliquid using server-side networkFromEnv.
   The non-secret database projection remains unchanged at lines 269-278;
   no encrypted key/token column was added. Alpaca receives null for the new
   label and retains its existing Paper/Live account formatting. This uses the
   same network resolver as the existing saved-follow label function at
   `apps/api/src/routers/copy-trade-follows.ts:477-483`. The network name is the
   effective server execution environment, not a claim that credentials carry
   an independently persisted network identity.

   `use-manage-follows.ts:116-122` consumes the real endpoint response through
   `toAccountOptions`; `account-targeting.ts:78` preserves its label and `:87`
   displays it. The picker and saved-selection text now have exact network
   labels. `manage-follows.tsx:576-595` distinguishes the current saved account
   from a newly selected repoint account; `:663` preserves the saved exact
   label for Stop, including when the account response lacks that optional
   field. Successful arm/repoint updates carry the new selected account's label
   at `:622`; clear removes it at `:685-688`. No browser environment inference
   or cross-provider selection was introduced.

2. **Null-account off-to-off sizing no longer reports a false Stop.**
   `mirror-consent.ts:692-716` records explicit stop/clear actions on the
   specific config object. `:731-742` consumes that action instead of treating
   every disabled/null-account config as a stop. Ordinary sizing saves with
   either null or selected credentials report Follow settings updated.
   `manage-follows.tsx:681-694` marks confirmed transitions; `:1784-1788` marks
   explicit account clearing while off. A genuine on-to-off transition still
   reports Stop, and an explicit clear of an existing credential reports Clear.
   The real hook's shallow request spread at `use-manage-follows.ts:172-178`
   preserves the nested object identity through mutation success. The new
   behavioral tests exercise this actual hook path, not only the toast helper.

3. **Previously accepted destination scope and DOM identity remain intact.**
   Destination Stop/clear summaries explicitly leave the other venue unchanged,
   preserve open-position and queued-close caveats, and send only the selected
   destination in the patch. True global unfollow retains its global behavior.
   `manage-follows.tsx:1628-1633` uses follow.id plus destination for the control
   namespace. The fresh two-follow rendered-markup test verifies unique IDs and
   single-target aria-labelledby relationships for both destinations.

All unqualified web filenames above are in
`apps/web-v2/src/components/copy-trade/` in the exact candidate checkout.

### STRICT Boundary And Regression Audit

- Money/account/consent: endpoint-derived labels reach the actual picker and
  arm/repoint/Stop summaries for both mainnet and explicitly enabled testnet.
  Confirmation handlers send the intended credential ID and only one venue.
  Missing or wrong-provider accounts cannot produce an arm mutation. Backend
  ownership/provider validation remains unchanged and its regressions pass.
- Parity: stock and perp ordinary off saves, true stops and explicit clears
  pass through the real row/dialog/hook handlers. The opposite destination is
  absent from each scoped mutation, and API persistence tests preserve it.
- Malformed/partial state: absent/null optional labels remain compatible.
  Numeric, object, array and boolean saved labels fail the destination guard;
  malformed independent state does not re-arm from a legacy top-level flag.
  Unknown provider and missing accountType entries are filtered. Label text is
  server-generated display data, not credential authority. The unchanged
  destination input schema at `copy-trade-follows.ts:106-124` does not accept
  display labels as an authorization input; account lookup remains authoritative.
- Duplication/failure: this batch changes no broker execution or idempotency
  path. Existing null-server-response hook tests still emit an error instead of
  success. Action markers are per-config and consumed by success feedback;
  independently created sizing patches do not inherit a prior stop action.

### Independent Evidence

Fresh run from the candidate root:

```sh
bun test apps/api/src/__tests__/has-api-credentials-label.test.ts apps/web-v2/src/components/copy-trade/account-targeting.test.ts apps/web-v2/src/components/copy-trade/independent-mirror.test.tsx apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx
```

**178 pass, 1 skip, 0 fail, 594 assertions, 5 files.** The skipped test is
the existing responsive sizing-divider case, not a label or toast case.

```sh
bun test apps/api/src/__tests__/copy-trade-follows.test.ts apps/api/src/__tests__/copy-trade-independent-destinations.test.ts packages/hyperliquid/src/config.test.ts
```

**110 pass, 0 fail, 258 assertions, 3 files.** This regression set includes
API caller tests and some existing migration/source checks; it is not entirely
mounted UI or persistence-against-a-real-database coverage.

Additional independent read-only `bun -e` probes imported the actual endpoint,
account mapper, destination resolver, arm/Stop components and toast helper.
For each network they supplied a mocked database account response, checked
exact labels, invoked all four confirmation handlers, asserted no pre-confirm
mutation, exact destination keys and credential IDs, and checked missing/wrong-
provider arm refusal. Both destinations also passed absent/null/string label
compatibility, malformed-label rejection and null/non-null off-save checks.
The probe's first import path was corrected before execution; that setup error
was not a product failure. The successful probe emitted expected local rate-
limit fallback warnings because its isolated caller had no Redis logger.
No real database, broker or production settings were used.

These tests materially improve on the original candidate: the endpoint
projection is exercised through a real router caller, network labels flow into
actual components, and toast tests invoke the real mutation-success callback.
DOM uniqueness uses rendered markup. This remains handler/static-render
evidence, not a fresh browser focus/layout or network-driven UI certification.

Verified exact HEAD, clean candidate worktree and passing
`git diff --check 9478b9ae..fddefd20`. No full suite, typecheck, lint, build or
browser run was performed for this bounded review. External QA receipts were
not used as substitutes for the independent evidence above.

Only this append to the existing report was written. No candidate source/test
edits, new settings report, ledger changes, pushes, subagents, production or
release operations occurred.

---

## Account Selection Follow-Up Review - 2026-09-06

### Scoped Verdict: REJECT

Candidate: `d593dd0becaad4e1fee7f31a7a87e7769e509b3b`.
Base: `fddefd20f346a3c096b49107e474af51cc108f07`.
Checkout: `/Users/frankciafardini/Documents/Codex/rst-copy-account-selection-final`.

Read the full four-file +133/-16 diff and selection-final-evidence receipt.
This is the separately queued unknown-Alpaca-identity selection/arming review.
It does not reverse acceptance of fddefd20's label/toast batch, and preserves
both earlier verdicts above. The candidate corrects Manage Follows but leaves
the same new-arm invariant bypassable in the existing inline Copy feed surface.

### P2 - Inline Mirror Still Arms Unknown Alpaca Identities

The shared predicate added at `account-targeting.ts:86-88` is only applied in
Manage Follows, not all existing Copy UI arming paths. In the unchanged but
reachable `copy-trade-panel.tsx:1238-1242`, accountForDestination resolves saved
Alpaca rows even when accountId is null, empty or whitespace. Keeping that
lookup available is correct for Stop, but inline readiness at `:1290-1292`
treats any resolved account as available for arming. `:1302` opens arm consent.
The actual confirmation at `:1527-1558` rereads accounts but checks only
Boolean(account), then sends enabled true for that credential at `:1560-1569`.
It never calls accountIsSelectable.

A fresh read-only probe invoked the actual CopyTradePanel, InlineMirrorSwitch
request callback and ArmMirrorDialog confirmation callback. It used a saved
disabled stock destination, real account mapping, stubbed query/mutation
transport and isolated persistent hook storage. Results:

| Current Alpaca accountId | Inline Interactive | Confirmation Mutation |
| --- | --- | --- |
| null | true | stock enabled true, credentialId legacy |
| empty string | true | stock enabled true, credentialId legacy |
| whitespace | true | stock enabled true, credentialId legacy |
| identified when opened, null after refreshed render | initially true | stock enabled true, credentialId legacy |

Each case produced exactly one mutation. The refreshed-confirmation case used
the newly rendered callback, not an artificially retained stale callback.
Thus this is both an ordinary saved-unknown-arm bypass and an identity-loss
while-consent-is-open bypass. The displayed Previous connection, account unknown
label does not enforce the required disabled arming behavior.

This probe records a client mutation request only; it did not persist data or
place orders. A separately hardened credential API may reject the request, but
that would not establish the explicit UI no-new-selection/no-new-arm invariant.
The missing inline path is the same selection follow-up requirement, not a
request to reopen the independent ticket, quote or label batches.

Correction: apply the shared selectable predicate to inline arming readiness,
the arm-request guard and current-account confirmation guard. Preserve the
saved lookup and disarm path for existing unknown-identity references. Verify
valid identified LIVE and supported null-accountId Hyperliquid accounts still
arm through existing consent, without an additional approval step. Add actual
inline-component/handler regressions for all three unknown values and identity
loss between consent opening and confirmation, plus Stop and valid controls.
The controller must assign the bounded panel/test ownership expansion because
copy-trade-panel.tsx is outside this coder's four-file commit. No such source
edit was made by this reviewer.

All file references above are under
`apps/web-v2/src/components/copy-trade/` in the exact candidate checkout.

### Passing Parts

- Independent and legacy Manage Follows pickers render null/empty/whitespace
  Alpaca identities as disabled Previous connection, account unknown options.
  Their actual onValueChange handlers also refuse the values, so the guard is
  not only a DOM attribute. Collections retain those rows for saved lookup.
- Independent arm/repoint checks current selectable identity and disables
  confirmation on refreshed ambiguous accounts; the actual handler sends no
  update. The legacy Manage Follows confirmation also checks current account
  eligibility in source. Its newly added tests exercise legacy row selection
  and arm/Stop requests, not a full mounted legacy consent-refresh workflow.
- Already enabled unknown-identity follows retain Stop. Independent Stop sends
  enabled false while retaining a still-resolved saved credential reference;
  it does not infer a replacement account or mutate legacy identity/linkage.
- Identified LIVE accounts and Hyperliquid null-accountId accounts remain
  selectable and arm/repoint normally. Exact server labels and earlier
  off-to-off toast fixes remain covered by the fresh focused run.

### Fresh Evidence And Limits

Run from the exact candidate root:

```sh
RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test apps/web-v2/src/components/copy-trade/account-targeting.test.ts apps/web-v2/src/components/copy-trade/independent-mirror.test.tsx apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx
```

**199 pass, 0 fail, 790 assertions, 4 files.** Without the browser-module flag,
the initial run produced 198 pass/1 responsive-layout skip/701 assertions; the
flagged rerun executed that case. No candidate test failed. The inline bypass
is missing coverage, independently demonstrated by the real-handler probe.

Probe recipe: stub hasApiCredentials with a saved LIVE Alpaca credential and
copyTradeFollows.list with a disabled stock destination referencing it; render
the actual panel with subheaderAction mirror and an EQUITY feed row for that
follow; invoke its InlineMirrorSwitch onRequestArm, rerender, then invoke its
actual ArmMirrorDialog onConfirm. Observe the captured nested stock mutation.
Repeat for null, empty and whitespace accountId. For the refreshed case, start
identified and replace the query account with null before rerender/Confirm.
No production lifecycle implementation was copied and no source strings were
used as behavioral assertions. The probe doubles React hook storage and does
not claim a browser or real concurrent-scheduling reproduction.

Verified exact candidate/base and passing `git diff --check fddefd20..d593dd0b`.
No fresh full-suite, typecheck, lint or application-browser run was needed to
establish this scoped rejection; the receipt's 5041 full passes are not newly
certified here. Only this append was written. No candidate source/test changes,
new report, ledger edits, agents, pushes, production, orders, Vercel, deployment
or merge operations. Return the bounded inline correction to the controller
for ownership assignment and independent re-review.
