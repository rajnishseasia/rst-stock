# Copy Backend Integration Review

## Verdict

**REJECT** at candidate `6b856a4efe211d8f086c01142deb3af3b3572c30`
against `origin/main` `a36d065a75af6d07e34b69a3ce7491e0b73de2e0`.

This was a cold STRICT review of independent stock/perp destinations, durable
delivery and replay, source attribution, exit routing, consent serialization,
Alpaca and Hyperliquid ambiguity handling, and migration/cutover safety. No
source, ledger, broker, wallet, production configuration, or production data was
changed. The uncommitted worker hardening worktree was deliberately excluded.

## Findings

### 1. P1 - A delayed equity close can liquidate a later re-entry

`apps/worker/src/services/copy-mirror.ts:6994-7015` loads every mirrored follower
order for the user/instrument, but does not select or constrain the follower
row's source-event time. The attribution filter at lines 7187-7207 verifies the
source user, instrument, and source broker account, but not whether that source
event happened at or before the close being processed. Lines 7255-7282 then net
all attributed rows into the closeable follower exposure.

The source side is correctly bounded to the authoritative close event in
`apps/worker/src/services/copy-mirror-equity-source-history.ts:301-313`. The
follower side is not. Because transient closes remain retryable indefinitely at
`apps/worker/src/services/copy-mirror.ts:2306-2328`, an old close retried after a
new entry from the same source/account can size against both the old exposure and
the later re-entry.

Required correction: bind each follower mirror row to an authoritative source
event and include only events at or before the close fill. Fail closed when that
identity or time cannot be proven. Add full-close and partial-close regressions
where a delayed retry occurs after a later re-entry.

### 2. P1 - X-author option exits cannot pair with their entries

The X-signal query at
`apps/worker/src/services/copy-mirror-candidate-sources.ts:1205-1217` does not
select the immutable `sourceAuthorId`. The option candidate at lines 1401-1421
stores the follow ID and `x_signal:<current signal id>`, but no canonical author
or follow-lifecycle identity. The close attribution at
`apps/worker/src/services/copy-mirror.ts:7187-7192` accepts prior X rows only when
their complete source item ID equals the current signal ID.

A BuyToOpen and SellToClose necessarily have different signal IDs. The prior
entry is therefore excluded, and the close resolves to missing/unavailable
source metadata instead of finding the exposure it must exit.

Required correction: persist immutable canonical author identity plus the follow
lifecycle on X candidates and use event-bounded contract attribution. Add tests
for two authors trading the same contract, BuyToOpen -> partial SellToClose ->
full SellToClose, and re-entry after a completed lifecycle.

### 3. P1 - Alpaca credential replacement can route an exit to the wrong account

The shipped form omits `accountId` at
`apps/web-v2/src/lib/broker-credentials-form.ts:10-21`. The integrated API checks
the keys but discards Alpaca's returned account identity at
`apps/api/src/routers/user-settings.ts:182-191`, then matches a null-account row
by account type and overwrites that UUID in place at lines 196-227.

The worker only probes live account identity when a close has no usable Alpaca
credential, has a non-Alpaca credential, or lost its recorded credential UUID at
`apps/worker/src/services/copy-mirror.ts:2909-2935`. If the same UUID still
resolves after its keys were replaced with keys for another Paper or Live
account, the probe is skipped. The client is built from the replacement keys at
lines 3173-3190 without comparing live `account_number` to the account recorded
on the mirrored exposure. A same-symbol manual holding on the replacement
account can be sold while the original mirrored position remains open.

Required correction: persist only Alpaca-verified account identity, preserve an
existing UUID only for a verified rotation of the same account/environment, and
verify every close destination live against the exposure account even when the
credential UUID still resolves. A mismatch or unreadable identity must retain
the close for retry without submitting.

### 4. P1 - Stock Stop/unfollow is not serialized with broker submission

Follow updates and unfollow take the user-first policy lock in
`apps/api/src/routers/copy-trade-follows.ts:958-975`,
`apps/api/src/routers/copy-trade-follows.ts:1308-1324`, and lines 1385-1418. Perp
opens take that same user-row lock and retain the transaction through final
authorization and execution at
`apps/worker/src/services/copy-mirror.ts:6322-6344` and lines 6475-6547.

Stock/option opens perform one unlocked follow read at
`apps/worker/src/services/copy-mirror.ts:3083-3092` through `loadFollowRow` at
lines 6196-6222. Fresh and pending-resume paths then submit outside a policy
transaction at lines 3438-3464 and 3814-3835; the irreversible Alpaca call is at
line 10222. Stop or unfollow can commit after the read but before `createOrder`,
allowing new exposure after the user was told the destination stopped.

Required correction: use the user-first policy lock for the final stock consent
read and hold it through durable intent ownership and irreversible submission,
for both fresh and resumed opens. Add deterministic Stop and unfollow
interleavings that pause after the preliminary read and prove no order can be
submitted after the policy mutation wins.

### 5. P1 - A partially filled Hyperliquid close consumes the one exit instruction

Every reduce-only close is IoC. The primary close gets one bounded sweep at
`apps/worker/src/services/copy-mirror.ts:9453-9480`. If the sweep is also short,
lines 9620-9638 only log the surviving remainder and line 9640 returns the
cumulative partial fill. `executePerpCloseMirror` keeps protection attached, but
still returns the `placed` outcome at
`apps/worker/src/services/copy-mirror-perp-execution.ts:1931-1984`. The poll loop
marks every non-`syncing` delivery complete at
`apps/worker/src/services/copy-mirror.ts:1997-1999`.

The existing regression makes the defect reproducible:
`apps/worker/src/services/__tests__/copy-mirror-perp-close-fill-shortfall.test.ts:104-118`
requests 1.0, fills 0.3 on the primary and 0.2 on the sweep, and expects
`{ outcome: "placed", filledSizeCoin: "0.5" }`. Protection remains, but no
durable delivery remains to submit the surviving 0.5. Reconciling the two order
rows records what happened; it does not create the missing close.

Required correction: retain a restart-safe remainder obligation until the
authoritative target close is satisfied or the position is flat. Use
deterministic per-attempt identities, re-read and clamp to live exposure, and
never duplicate an ambiguous sweep. Test partial primary plus partial sweep,
restart, ambiguous response, concurrent reconciliation, and eventual flatness.

### 6. P1 - The global due-page can starve fresh entries and exits

`loadDueDeliveries` reads one global page ordered only by oldest
`next_attempt_at`, with `limit: 100`, at
`apps/worker/src/services/copy-mirror.ts:2175-2187`. The in-memory source ordering
happens after that limit. There is no keyset continuation, fresh-work lane,
per-follower fairness, or later page in the poll loop at lines 1950-2033.

Transient closes are retained and rescheduled forever at lines 2306-2363, with a
15-minute maximum backoff. The table has no pending-row retention or quarantine;
`packages/db/src/schema/copy-mirror-state.ts:32-62` contains only status/time
indexing and the permanent follower/source uniqueness key. At ideal zero-cost
processing, 3,000 recurring retries can consume all 100 slots every 30 seconds
as the earliest rows become due again; broker I/O lowers that threshold. New
deliveries remain behind older retry rows, and delayed opens can then expire at
the 15-minute intent bound. Fresh exits can be delayed too.

Required correction: preserve exits without letting one retry population own the
global queue. Add bounded keyset draining or separate weighted fresh/retry lanes,
fairness across followers, and explicit ordering rules within each follower.
Test more than 100 mixed old retries and new entries/exits over repeated cycles,
including a saturated retry population that never becomes placeable.

## API Patch Review

Candidate API commit `65cc322ea43a1b72001b703ac07236bd7fed4fc7`
(`fix(credentials): retain verified Alpaca account identity`) has parent
`6b856a4e` and changes exactly these four owned files:

- `apps/api/src/__tests__/alpaca-credential-check.test.ts`
- `apps/api/src/__tests__/user-settings-save-credentials.test.ts`
- `apps/api/src/lib/alpaca-credential-check.ts`
- `apps/api/src/routers/user-settings.ts`

Its mechanics are verified: a successful check requires a non-empty trimmed
Alpaca `account_number`; caller-supplied disagreement is rejected; the verified
identity is persisted; same account plus environment updates the existing row;
another account of the same type inserts a separate row; and the save is under
the user lock. The focused suite passed 21 tests with 66 assertions.

The policy is **not accepted**. In that commit,
`apps/api/src/routers/user-settings.ts:240-260` blocks every new verified account
in an environment whenever any same-environment legacy row has a null
`accountId`, unless the exact verified row already exists. That can prevent adding an
unrelated legitimate account. A stored `accountType = "SIM"` null row is missed
entirely because input is normalized to `PAPER` at line 170 before the legacy
query compares account types.

The pending user decision must be implemented before acceptance:

1. Recommended: insert the new verified row and leave the legacy UUID and every
   existing mirror link untouched.
2. Alternative: block until an explicit legacy repair workflow proves identity.

For option 1, verified rows are distinguishable today because
`apps/web-v2/src/components/copy-trade/account-targeting.ts:80-84` includes the
full account ID. Legacy null rows remain selectable and collapse to the identical
label `Paper account` or `Live account`; `toAccountOptions` at lines 56-76 does
not exclude them, and the settings page prints a blank identity at
`apps/web-v2/src/app/settings/page.tsx:388`. Those legacy rows must be clearly
identified and disabled or repaired before multiple-account selection is safe.

The worker half is still uncommitted in
`/Users/frankciafardini/Documents/Codex/rst-copy-worker-hardening`. Its unstable
diff was not reviewed and cannot satisfy findings 1-4 in this round.

## Bounded Results

- **Late source/fill discovery:** no additional replay defect was established.
  Live Alpaca source orders publish their social row immediately after broker
  acceptance at `apps/api/src/routers/orders.ts:1059-1089`; that row is staged
  durably, and normal retries no longer depend on the five-minute discovery
  overlap. Ordinary equity source time intentionally remains submission time at
  `apps/worker/src/services/copy-mirror-candidate-sources.ts:445-477`, and opens
  older than 15 minutes intentionally fail closed at
  `apps/worker/src/services/copy-mirror-consent.ts:358-383`. A product change to
  mirror long-resting orders at their later fill time would require an explicit
  policy decision, not a replay bug fix.
- **Ambiguous Alpaca placement:** deterministic broker client IDs, local PENDING
  intent, exact lookup before repost, and SYNCING reconciliation are present at
  `apps/worker/src/services/copy-mirror.ts:10047-10181` and 10222-10315. No
  additional blocker was found in the bounded path.
- **Migration 0040:** the migration backfills only owned, provider-compatible,
  valid destinations and disarms invalid legacy rows at
  `packages/db/migrations/0042_independent_copy_mirrors.sql:22-123`. Worker
  startup verifies the exact columns, foreign keys, checks, and indexes at
  `packages/db/src/migration-compatibility.ts:797-898`; the verifier is invoked in
  `packages/db/scripts/verify-worker-schema.ts:27-35`. CI has a PostgreSQL 16 job
  at `.github/workflows/ci.yml:58-98`.
- **Cutover:** migration 0040 is not rolling compatible. The maintenance sequence
  in `docs/tasks/social-copy-maintainer-notes.md:11-31` correctly requires old
  writers and workers to stop, migration/schema verification, all new API/web
  instances, destination verification, and only then worker/write resumption.
  This remains a release requirement, not evidence that the code blockers pass.

## Verification

Fresh on integrated candidate `6b856a4e`:

- Six focused worker files: **118 pass, 0 fail, 275 assertions**.
- Disposable loopback PostgreSQL migration proof: **1 pass, 0 fail, 12
  assertions**; the test created and dropped its own random database.
- `git diff --check origin/main...HEAD`: previously recorded pass on this exact
  candidate.

Fresh on API candidate `65cc322e`:

- Two focused API files: **21 pass, 0 fail, 66 assertions**.
- Detached worktree clean; exact four-file ownership confirmed.

Controller receipts for integrated `6b856a4e` report `bun test` 4,750 pass / 27
skip / 0 fail, all 11 typecheck packages passing, lint exit 0, and all 11 build
packages passing. These totals do not exercise the missing interleavings,
event-bounded histories, remainder durability, or queue fairness above.

There is also no single local integration proof covering API credential save ->
follow selection -> candidate discovery -> durable delivery -> broker mock for
same-account rotation and different-account replacement. Broker mocks remain the
appropriate pre-release proof; no real order is required for review acceptance.

## Round-Two Gate

Acceptance requires committed, ownership-bounded fixes for all six findings;
resolution of the legacy-null policy; focused red/green regressions for every
scenario named above; and a cold review of the final committed worker/API diffs.
After integration, rerun the canonical test/type/lint/build gates and the
isolated PostgreSQL proof. Live broker execution and production database access
remain outside this review.

---

## 2026-09-06 Credential API Review: Scoped ACCEPT

**ACCEPT** candidate `d53a843dca0a92bce48dce5554cdbf769e6bffd6` against exact parent `fddefd20f346a3c096b49107e474af51cc108f07`, reviewed in `/Users/frankciafardini/Documents/Codex/rst-copy-credential-final`. No blocking finding remains in the assigned credential API correction. This supersedes the earlier API candidate's scoped rejection only; the historical global findings and release gates above are preserved.

Read the complete six-file committed diff and the earlier API rejection. Scope is exactly three API source files and three corresponding test files, 214 additions / 41 deletions. No web, worker, schema, migration, credential-list response, or unrelated source changes. Candidate working tree was clean before and after verification. The supplied `credential-final-evidence.md` was treated as a receipt to verify, not as acceptance.

### Four STRICT Categories

1. **Money loss / identity:** `alpaca-credential-check.ts:106` accepts only a parseable successful account response with a nonblank trimmed account number. Save at `user-settings.ts:193` rejects supplied identity disagreement and persists only the broker-verified identity. The lookup at `:211` matches authenticated user, provider, account identity, and environment before retaining a UUID. Other identities and unknown legacy rows receive a distinct UUID; old key material and exposure/follow references are not overwritten. Requested SIM normalizes to Paper, and an identified stored SIM row can rotate through the Paper match. Live and Paper cannot overwrite each other even when the synthetic account string matches.
2. **Parity / legacy policy:** valid new Live credentials save through the real account-check helper with a mocked Live endpoint even when an unknown legacy Live row exists. No extra repair workflow or manual identity input is imposed. The legacy UUID remains untouched. Hyperliquid does not acquire an Alpaca account-number requirement. The accepted account-label/list contract is unchanged.
3. **Boundaries / consent:** `copy-trade-follows.ts:531` blocks new selection or explicit arming of null, empty, or whitespace-only Alpaca identities. This includes new disabled selections, preventing an unidentified account from entering saved selectable state. Existing owned Paper/Live selections can still be stopped while retaining their saved UUID; unrelated legacy sizing edits preserve existing consent rather than turning into a new credential-selection workflow. Tests assert independent perp consent and sizing survive stock Stop. Invalid JSON, null/array/missing/numeric/blank broker identity, 401/403, network failure, and unexpected HTTP statuses fail closed. Verification uses only fixed Paper/Live hosts with a ten-second abort signal.
4. **Duplication / serialization:** save retains the existing user-first transaction lock around identity lookup and update/insert. Matching rotations update one existing UUID; different or unproven identities insert instead of redirecting old references. The save tests evaluate the real relational predicate, compile the actual UPDATE predicate, mutate stored row projections, and decrypt the resulting synthetic ciphertext. They assert the original referenced row still decrypts to the original material after adding a different or unknown-legacy account. Real PostgreSQL concurrent-save execution was not performed; no claim of live broker behavior is made.

### Independent Evidence

Executed on the exact candidate, Bun 1.3.11:

```text
bun test apps/api/src/__tests__/user-settings-save-credentials.test.ts apps/api/src/__tests__/alpaca-credential-check.test.ts apps/api/src/__tests__/copy-trade-independent-destinations.test.ts
58 pass, 0 fail, 183 assertions, 3 files

RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test
5,055 pass, 33 skip, 0 fail, 14,896 assertions, 320 files

bun run --filter @trade-bot/api typecheck
exit 0

git diff --check fddefd20 HEAD
exit 0
```

The focused tests call the real save/follow/update routers. In particular, the Live legacy-unknown case delegates to the real account-check implementation with mocked HTTP, checks the chosen Live URL and normalized headers, and asserts only the credential table receives a new row. Bad-key/unavailable/unidentified-success save tests assert no INSERT or UPDATE. No passing total substitutes for these assertions.

An additional read-only `NODE_ENV=test bun -e` probe called the real `hasApiCredentials` handler with a projection-aware in-memory DB and private sentinel fields. The query did not request encrypted access/refresh tokens and the response did not contain them. Its returned keys remain `id`, `provider`, `accountId`, `accountType`, `credentialAccountLabel`, `username`, `baseUrl`, and `updatedAt`. The accepted label response was not edited by this patch. Save itself returns only success/message, not key material.

Canonical totals reproduce the supplied candidate receipt exactly. Skips remain explicitly opt-in live broker/local database suites, including generated DB-test duplicates; no source tests were removed or newly skipped. The supplied all-package types/lint and red-test receipts are supplementary, not represented here as independently rerun gates. Independent API typecheck and canonical tests passed.

### Acceptance Boundary

This accepts the API half of the account-identity correction and the requested legacy-unknown policy: add a separate verified account without moving old links, reject new unidentified selection/arming, and retain safe Stop behavior for saved owned Paper/Live links. It does not retrofit unknown historical identities or claim that every legacy row is now safe for execution. The separately accepted worker candidate checks known-account close destinations against the live broker identity.

UI treatment of legacy account choices and final save -> selection -> worker integration remain controller-owned combined validation. Perp remainder durability, queue fairness, migration/cutover, and final release gates are not solved or waived by this verdict. No source edits, agents, ledger updates, pushes, PR changes, merges, production access, Vercel actions, deployments, or real orders were performed. Only this append was written for the credential review, preserving prior rejections.
