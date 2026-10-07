# Worker Hardening Round 2: REJECT

Reviewed on 2026-09-05. This is a **scoped REJECT**, not a global release verdict.

- Candidate: `79b14614bb6e76cc8db9e23343672afa8b388e9d`.
- Parent: `6b856a4efe211d8f086c01142deb3af3b3572c30`.
- Detached candidate worktree: `/Users/frankciafardini/Documents/Codex/rst-copy-worker-hardening`.
- Read the full committed diff, original external `brief-worker-hardening.md`, repository rules, and `docs/tasks/social-copy-verifier.md`.
- Scope is original findings 1, 2, the worker half of 3, and 4. No source edits, commits, pushes, ledger edits, subagents, production access, or real broker calls were performed.

## Blocking Findings

### 1. P1: The new locked consent query disables valid stock/option opens

Evidence: candidate `apps/worker/src/services/copy-mirror.ts:10402` selects `stockAutoMirror` and `stockCredentialId`, but neither `stockSizingMode` nor `stockSizingValue`, before passing the projection to `readMirrorDestination` at line 10412. The actual reader in `copy-mirror-destinations.ts:70` requires both sizing fields and returns a disabled destination when they are absent. This affects fresh and resumed stock/option opens on the transactional production path, not just malformed follows.

A read-only, projection-aware probe called the real `loadLockedEquityOpenAuthorization` with a valid enabled `usd:100` follow and a fresh ISO source timestamp. Its selected row contained exactly the six requested columns. **Actual result: `{ refusal: "consent-withdrawn" }`.** No broker or database connection was involved.

The four new Stop/unfollow tests at `__tests__/copy-mirror-equity-exit-proportionality.test.ts:484` and line 529 only exercise refusal. Their `findFirst` fake ignores requested columns and returns a whole fixture. None asserts a valid open reaches the broker while the lock is held. Thus all four pass despite this regression.

Required correction: select the full authoritative destination policy needed by the reader, including its initialization marker and sizing fields; preserve valid enabled behavior. Add projection-aware successful fresh and resumed OPEN tests. Use explicit barriers to prove both orderings of Stop/unfollow versus broker submission: withdrawal winning the lock prevents submission; submission winning the lock keeps withdrawal blocked through the irreversible call. Also exercise rollback/ambiguous acceptance with the durable intent and deterministic broker ID. The current negative fixtures do not prove these interleavings.

### 2. P1: Follower attribution still uses submission time, so old closes can sell later fills

Evidence: `copy-mirror.ts:7334` obtains the close cutoff from `sourceOrderCreatedAt`; lines 7357-7364 compare it with `equitySourceOrderEventAt(sourceOrder)`. That helper in `copy-mirror-equity-source-history.ts:76` chooses the earlier of creation and execution time. By contrast, the source denominator at that helper file's lines 265 and 300-312 is bounded by the close's execution time. Immutable discovery timing is not the authoritative fill cutoff required by original finding 1.

Read-only probes called the real `mirroredEquityExposure`, including its real source-history helper, with these fixtures:

- Original source open: 100 shares filled at 09:00; follower mirrored 40.
- Another source buy: submitted at 10:00 but filled at 15:00, after the source close at 14:00; follower mirrored another 40 at 15:00.
- Attribution query returns both source order identities. The source-history fixture correctly returns only the original open, matching the SQL execution-time cutoff.
- For a 25-share source close, actual attribution is 80, source denominator 100, and the resulting proportional ceiling is **20 instead of 10**.
- For a 100-share full source close, actual attribution is 80 and the resulting ceiling is **80 instead of 40**.

These are actual helper outputs, not real broker submissions. A live holding of 80 would not remove the excess at the position clamp. The same timestamp inconsistency can also exclude an open filled between a resting close's submission and execution.

Required correction: separate immutable candidate/discovery identity from execution cutoff; use authoritative source fill timing consistently for follower attribution and source position history. Preserve fail-closed handling for missing/ambiguous history. Add real `processCandidate` regressions for full AND partial delayed closes, including an order submitted before but filled after the close, and a resting close with intervening opening fills. The added test at `__tests__/copy-mirror-equity-exit-proportionality.test.ts:684` covers only a 25/100 partial close with creation equal to execution on all source orders. It misses both the full-close requirement and this timestamp distinction.

### 3. P1: X partial/full lifecycle sizing invents quantities and does not complete the required sequence

Evidence: `copy-mirror.ts:1582` reads optional quantities, but line 1595 defaults an unquantified post to one contract. The source timeline at lines 7720-7731 subtracts that invented unit for every STC. A plain BTO followed by a plain `STC ... partial` therefore yields a close fraction of 1/1; the subsequent `STC ... full close` has zero source position and is unanswerable.

A read-only probe called the real `readXOptionAttribution` for three distinct signals with the same canonical author, follow, and contract. No quantity metadata was supplied:

```text
BTO AAPL 250C 7/19/2026 -> STC ... partial -> STC ... full close
partial: sourceCloseQty=1, sourcePositionQty=1, reason=null
full: sourceCloseQty=null, sourcePositionQty=null, reason=source-history-unavailable
```

This permits a partial instruction to liquidate the entire attributed follower position, then prevents the final exit from resolving. The new execution test at `__tests__/copy-mirror-equity-exit-proportionality.test.ts:765` supplies synthetic explicit counts (4, 1, 2), executes only one close, and has no prior follower STC row. Discovery assertions for BTO/partial/full do not establish execution behavior.

Required correction: do not infer authoritative position fractions from the count of posts. Use supported, authoritative quantity/partial-close semantics; when absent or ambiguous, hold without guessing and surface the required source/product decision as directed by the brief. Add an actual BTO -> partial STC -> full STC execution sequence with persisted follower fills, two authors sharing a contract, later re-entry, and unknown/malformed quantities. Assert exact sell sizes and remaining exposure after each step.

### 4. P1: An old, completed X follow lifecycle blocks a new lifecycle's exit

Evidence: `copy-mirror.ts:7757` treats every same-author/symbol delivery with a different follow ID as an integrity failure. It does so before old lifecycle exposure can net to zero. The mirror history query intentionally retains old orders, so a completed old BTO/STC pair remains present after unfollow/refollow.

A read-only real-method probe used four explicit one-contract signals: old BTO, old full STC, new BTO, current new STC. The old pair belonged to `old-follow`, the new pair to `new-follow`; the author and contract were identical. The old source position was completely closed and the new source position was one contract. **Actual result: `source-attribution-unavailable`**, although the current lifecycle is unambiguous.

Required correction: partition historical attribution by immutable author AND follow lifecycle, excluding an independently completed prior lifecycle without borrowing its exposure. Retain conservative behavior for genuinely unresolved ownership. Add unfollow/refollow regressions with old flat and old non-flat lifecycles. The committed X execution test uses one follow ID throughout, so it cannot verify the requested lifecycle boundary.

Related boundary within this same X reconstruction: the history query at `copy-mirror.ts:7678` selects all earlier signals for source `x`, then applies author/contract filtering only after the global 5,000-row cap. Unrelated authors can therefore make this lifecycle permanently unanswerable. Preserve a bounded scan, but scope it to provable source ownership before consuming the cap, with saturation coverage. This observation is about the assigned X attribution path, not global queue fairness finding 6.

## What Passed

Original finding 3's same-UUID worker correction is materially present: `copy-mirror.ts:3287` verifies live `GET /v2/account` identity for an attributed close with a known exposure account before position/resume/submission logic. The new regression at `__tests__/copy-mirror-close-credential-rotation.test.ts:421` uses the same credential UUID on the exposure, candidate, and resolved row, returns a different live account, asserts `EAGAIN`, and asserts zero broker POSTs. It passed independently. Existing matching-account, reconnection, and repointed-account close tests also passed.

This is not approval of unknown legacy account identity: the API/legacy policy decision remains a separate gate. Do not interpret the known-account pass as proof for every malformed or missing-identity case.

The user-first transaction structure and durable pre-transaction PENDING intent are present for fresh and resumed equity opens. They are useful structural progress, but finding 1 above and the missing successful/interleaving assertions prevent accepting original finding 4.

## Verification And Scope

Independently ran from the exact clean detached candidate tree:

```sh
bun test \
  apps/worker/src/services/__tests__/copy-mirror-candidate-sources.test.ts \
  apps/worker/src/services/__tests__/copy-mirror-cap-exempt-close.test.ts \
  apps/worker/src/services/__tests__/copy-mirror-close-credential-rotation.test.ts \
  apps/worker/src/services/__tests__/copy-mirror-equity-close-pairing.test.ts \
  apps/worker/src/services/__tests__/copy-mirror-equity-exit-proportionality.test.ts \
  apps/worker/src/services/__tests__/copy-mirror-reserved-long.test.ts \
  apps/worker/src/services/__tests__/copy-mirror-source-fill-gate.test.ts
```

Result: **89 pass, 0 fail, 229 assertions across 7 files**, Bun 1.3.11. There are no failing committed test names to report. REJECT is based on reproduced behavior and missing required assertions, not a red committed test suite.

Additional probes used `NODE_ENV=test bun -e`, imported the real worker module, called the named methods on `Object.create(CopyMirrorPoller.prototype)` with in-memory DB fixtures, and did not start the worker. For finding 1, the DB fake honors `columns` via `Object.fromEntries(Object.keys(columns).map(k => [k, row[k]]))`. For finding 2, ordered `orders.findMany` responses are follower rows, joined source identities, then execution-bounded source history; `orders.findFirst` returns the close. Findings 3 and 4 use `signals.findMany` and `copyMirrorDeliveries.findMany` fixtures with the precise signal sequences above. These probes are narrower than end-to-end broker tests, and that limitation is explicit.

Inspected external coder receipts: `worker-full-final-20260905.log` reports 4,757 pass / 27 skip / 0 fail across 300 files; `worker-typecheck-final-20260905.log` reports worker typecheck exit 0; the lint receipt contains warnings. Those are supplied receipts, not independently rerun canonical gates, and do not override the behavior failures. No full suite, typecheck, lint, or production gate is claimed as independently verified in this review.

`git diff --name-only HEAD^ HEAD` confirms exactly nine files: the seven tests listed above and only two source files, `copy-mirror.ts` and `copy-mirror-candidate-sources.ts`. No API, web, database, migration, or unrelated source file changed. Candidate worktree remained clean. Only this new report was written in the integration worktree; its pre-existing ledger modification was preserved untouched.

## Retained Global Gate

Do not cherry-pick this candidate as accepted. Correct and independently reverify the scoped blockers first.

The original six-finding global review remains **REJECT**. Original finding 5 (perp remainder), finding 6 (queue fairness), and the separate API legacy-account decision are NOT fixed by this candidate and remain later integration/release gates. They are not demanded as changes in this worker patch and are not the basis for this scoped rejection. This report grants no global release, deployment, or live-trading acceptance.

---

## 2026-09-06 Final Worker Review: Scoped ACCEPT

Candidate `34d1df386bf4f5c22a64babd92041078c7aa44ca`, exact parent `9478b9ae898b6c6d90003ae5505aea33f8d6ef11`, reviewed independently in `/Users/frankciafardini/Documents/Codex/rst-copy-worker-final`. The earlier rejection above remains intact and applies to the earlier candidate, not this one.

**ACCEPT for the assigned worker patch only. No remaining blocker was found in the four assigned correction areas.** This is not acceptance of the combined release, credentials API patch, perp remainder durability, or queue fairness.

### Scope And Prior Corrections

Read the complete base-to-candidate diff: exactly ten owned worker files, three source modules and seven test files, 1,653 additions / 103 deletions. No API, web, migration, schema, lockfile, or unrelated source changes. The candidate was clean before and after verification. No source modifications or publication were performed.

- **Valid locked opens:** `copy-mirror.ts:10435` now includes both sizing fields and `destinationPolicyInitialized`. The real destination reader receives a complete projection. The projection-aware test fixture honors requested columns; fresh/resumed EQUITY and OPTION tests at `copy-mirror-equity-exit-proportionality.test.ts:821` assert exact quantities and broker invocation before transaction completion.
- **Fill cutoff:** `copy-mirror.ts:7342` and `:7365` use `equitySourceOrderFillAt`, separately from immutable discovery timing. The source-history helper uses the same execution boundary at `copy-mirror-equity-source-history.ts:273`; positive fills without authoritative execution time hold. Four real `processCandidate` cases cover full/partial delayed closes and resting closes with intervening opening fills, asserting sell quantities 10, 40, 20, and 80. The ratio-close test now explicitly requires EAGAIN and zero POSTs for an unknown execution cutoff; it was changed, not omitted or skipped.
- **X quantities and full sequence:** `copy-mirror.ts:1602` has no default count. Only consistent explicit positive integer quantities are usable. Unknown/malformed units produce `source-quantity-unavailable` and EAGAIN, with zero POSTs in handler tests. This matches the user's confirmed HOLD policy for unquantified partial exits. The real process sequence at `copy-mirror-equity-exit-proportionality.test.ts:673` uses counts in source text, persists each follower fill between deliveries, and asserts buy 4 / sell 2 / sell 2, leaving the other author's 3 contracts and later 5-contract re-entry untouched.
- **X ownership/lifecycle:** canonical author is frozen on candidates; current delivery/follow/action conflicts hold. `copy-mirror.ts:7785` excludes a proven different follow lifecycle instead of rejecting the current one. Tests cover old flat and non-flat lifecycles, missing source signals, missing follow ownership, and conflicting current delivery ownership. The source denominator correctly remains the author's source position, while follower attribution is limited to the selected follow. The historical query now scopes source, canonical author alternatives, and symbol before LIMIT; compiled Drizzle query assertions plus handler fixtures cover 5,001 unrelated-author rows versus genuine selected-author saturation.
- **Known-account close identity:** the live account comparison remains before close position/resume/submission logic, including a resolvable same UUID whose keys authenticate a different account. The regression asserts EAGAIN and zero POSTs. A locked OPEN also rejects same-UUID account/environment drift, retaining the prepared intent's original account binding.

### Four STRICT Categories

1. **Money loss:** exact exit sizing, source fill timing, author/follow attribution, and known-account routing are exercised with mocked broker POST assertions. Missing or conflicting authoritative evidence holds. Stop/unfollow cannot pass the final stock consent check without the user lock in the transactional path.
2. **Parity:** valid stock and option opens execute in fresh and resumed paths. Equity and X option closes use attributable exposure; ambiguous X counts are intentionally unsupported and held. No new short/perp behavior or broader supported trade semantics were inferred.
3. **Boundaries:** projection-aware policy reads, missing execution timestamps, malformed/absent X quantities, unresolved ownership, scan saturation, and account/environment changes fail closed. The bounded history limits remain. Unknown legacy account identity is outside this worker acceptance and still requires its separate API/policy review.
4. **Duplication:** the PENDING intent is durable before the policy transaction; deterministic broker IDs are retained. Eight barrier cases cover fresh/resumed opens, Stop/unfollow, and both lock acquisition orderings. The writer cannot commit while the simulated broker call holds the user lock. Commit-failure and ambiguous-acceptance tests roll back to a durable intent, reconcile acceptance, and assert only one POST. API `copy-trade-follows.ts:963`, `:1312`, and `:1387` were inspected to confirm update/unfollow use the same user-row FOR UPDATE lock. These are real worker/router handlers with simulated DB transactions, not a claim of real PostgreSQL concurrency testing.

### Independent Verification

All commands below ran on the exact candidate, Bun 1.3.11:

```text
bun test apps/worker/src/services/__tests__/copy-mirror*.test.ts
990 pass, 0 fail, 2,373 assertions, 43 files

bun test apps/worker/src/services/__tests__/copy-mirror-equity-exit-proportionality.test.ts
56 pass, 0 fail, 204 assertions, 1 file (standalone, avoiding cross-file mock dependence)

bun test apps/api/src/__tests__/copy-trade-follows.test.ts apps/api/src/__tests__/copy-trade-independent-destinations.test.ts apps/web-v2/src/components/trade/__tests__/perp-prefill-main-sync.test.ts
95 pass, 0 fail, 237 assertions, 3 files

RST_PLAYWRIGHT_MODULE=/Users/frankciafardini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs bun test
5,028 pass, 33 skip, 0 fail, 14,827 assertions, 319 files

bun test packages/db/src
46 pass, 6 skip, 0 fail, 232 assertions, 6 files

bun run --filter @trade-bot/worker typecheck
exit 0

git diff --check 9478b9ae HEAD
exit 0
```

**Test counts reconciled, no missing source tests:** the receipt's 4,982/27/313 canonical result was from a no-build tree. Its exact-parent log contains all six `packages/db/src` test paths but no `packages/db/dist` test paths. The six corresponding generated JS tests are present by this independent run, in addition to their unchanged source files. Their 46 passes / 6 skips account exactly for 4,982 + 46 = 5,028 passes and 27 + 6 = 33 skips. Likewise the supplied base 4,985/33 equals no-build base 4,939/27 plus that same generated duplication. The patch adds 43 passing cases. No rebuild or deletion of generated output was performed to manipulate counts. The six source DB skips are the explicitly opt-in local PostgreSQL suite; real Alpaca integration tests remain skipped. These totals do not claim live broker or database coverage.

**Accepted main arbitration preserved:** `08c23cfa` is an ancestor of the candidate. Comparing all five files changed by that correction to this candidate yields an empty diff. The actual parent/rail/perp-form prefill regression passes independently above. No regression in the accepted arbitration change was found.

The supplied full check-types/lint and red-run receipts were inspected as supplementary evidence, not represented as independent executions. Independent worker typecheck and canonical tests passed. The controller still owns final combined checks after sequential integration, and any later changes invalidate this exact-tree acceptance until reverified.

### Remaining Gates

Perp remainder durability and queue fairness are separate sequential patches, not included here and not conditions invented for this scoped worker patch. The credential API candidate requires a separate verdict. The earlier global release REJECT remains until those gates and final combined checks are resolved. No ledger updates, agents, pushes, PR changes, merges, Vercel actions, deployments, production access, or real orders were performed.
