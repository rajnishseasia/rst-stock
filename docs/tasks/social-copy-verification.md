# Social Copy Verification

## Status

2026-09-06 resumed: user requested finishing the contributor-side PR work.
Four correction batches are being brought onto source `9478b9ae` in new
detached worktrees; their older paused worktrees remain untouched references.
Settings candidate `fddefd20` received scoped STRICT ACCEPT and was integrated
as `aaa2930a`. The credential-save and legacy-selection follow-ups are now
assigned separately on that accepted base; existing account links stay intact.
Worker `34d1df38`, API `d53a843d`, ticket `12c3a0cd` and quotes `dc2502a4`
subsequently received scoped STRICT ACCEPT and were integrated as `b2469b80`,
`b21f4057`, `52b3a49b` and `2180d6b5`. Selection `d593dd0b` was rejected for
the missed inline Mirror arming path and is being corrected on the combined
accepted base. Perp remainder and database-to-mock pipeline proof are underway;
fairness follows remainder acceptance. Final combined and browser gates remain.
The user clarified they are a contributor, not a maintainer. Vercel access,
preview deployment remediation, merge and production rollout are out of scope;
do not require the user to resolve these to complete contributor-side work.

2026-09-06 priority completed: synced to latest `main` `f3cfcb4f`, per user.
Merge `a824cd58` preserves both parents; correction `08c23cfa` closes the two
merge-induced defects after STRICT round-two ACCEPT. The integration branch is
zero commits behind main at that sync. Other correction batches and browser QA
were paused at that point; the correction batches have since resumed as above.
No rejected batch was imported.

See `reviews/verify-copy-main-sync.md` for the initial rejection and accepted
correction. This is acceptance of the main synchronization only, not the global
copy feature. Remaining feature findings below are still open.

Final verification in progress. Cold reviews returned REJECT at `6b856a4e`.
Historical test totals are not the current gate, and green tests are not acceptance.
No production execution, signatures, settings changes or production database
access. Database checks use disposable local PostgreSQL only.

## Repository

- Workspace: `/Users/frankciafardini/Documents/Codex/rst-copy-mirror-review`
- Branch: `codex/perps-mirror-review`; base: `origin/main`
- Remote: `napindc/rst-stock-site`; open [PR #243](https://github.com/napindc/rst-stock-site/pull/243)
  targets `main`. Not ready to merge; global feature findings remain open.
- Gate: `bun test`, `bun run check-types`, `bun run lint`, `bun run build`.
- Artifacts: sibling directory `rst-copy-qa-artifacts`, outside Git.

## Pipeline

The controller owns plans, sequencing and the final gate. Luna 5.6 Max owns
source/test changes in a detached worktree with bounded file ownership. Sol
5.6 Max performs a cold review and returns ACCEPT or REJECT with file/line and
test evidence. Rejections return to the coder and then the verifier. Coders do
not push, edit this ledger or spawn agents. Reviews live in `reviews/`.

STRICT categories: money loss; stock/perp and entry/exit parity; invalid,
empty and boundary state; duplication and retry safety. No source changes
are accepted on self-report alone. No silent product or money decisions.

## Checklist

- [x] (commit `08c23cfa`, merge `a824cd58`; verified
      `reviews/verify-copy-main-sync.md`, STRICT, 2 rounds, ACCEPT; preserved both
      prefill channels and responsive sizing) Sync latest main before fixes.
      Latest-main baseline `f3cfcb4f`: 4883 pass / 32 skip / 0 fail, 310 files;
      types 11/11 pass. Integrated gate: 4985 pass / 33 skip / 0 fail, types and
      build 11/11 pass, lint exit 0.
- [x] Controller: restore environment and measure clean-base canonical gate
      (a36d065a; bun test 4652 pass, 26 skip, 0 fail; types 11/11 pass).
- [ ] Sol backend: verify independent destinations, consent, source attribution,
      exits, credential rotation, retries and migration/cutover safety.
- [ ] Sol frontend: verify manual copy and independent mirror UI wiring,
      confirmation, saved settings and venue-aware quotes.
- [ ] Luna QA: exercise desktop/mobile local browser with isolated dummy account;
      document observed viewport, persistence, cancellation and errors.
- [ ] Controller: rerun combined canonical tests/types/lint/build and actual
      isolated PostgreSQL migration proof; review reports and screenshots.
- [x] Controller: publish draft PR #243 with maintainer notes and explicit blockers.
- [ ] Controller: review contributor-side PR CI and complete remaining feature
      gates for maintainer review. Do not merge or manage deployments.

## Review Blockers

- [x] Goodall (Luna): old equity close retries must not liquidate later re-entry.
      `34d1df38` / `b2469b80`, Sagan STRICT ACCEPT, worker hardening report.
- [x] Goodall (Luna): X option BTO/STC must match canonical author/lifecycle,
      not require the entry and exit to have the same signal ID.
      Same accepted worker batch; ambiguous quantities hold without guessing.
- [x] Archimedes (Luna/API) and Goodall (Luna/worker): preserve verified Alpaca
      account identity; in-place key replacement must not route old exits elsewhere.
      API `d53a843d` / `b21f4057` and worker above, Sagan scoped ACCEPT.
- [x] Goodall (Luna): stock Stop/unfollow must serialize with final submission.
      Projection-aware valid opens and both lock orderings in accepted worker batch.
- [ ] Pending sequential Luna worker batch: preserve durable Hyperliquid close
      remainder through partial fills, ambiguity and restart.
- [ ] Pending sequential Luna worker batch: prevent retry-queue starvation of
      fresh entries/exits with bounded draining and follower fairness.
- [x] Hubble (Luna): destination Stop copy must not promise the other venue stops.
      `fddefd20` integrated as `aaa2930a`; Rawls STRICT ACCEPT, settings report.
- [x] Luna ticket-lifecycle batch: clear manual provenance on dismissal/success/reset, retain
      it during the current review/retry; replace source-string tests with behavior.
      `12c3a0cd` / `52b3a49b`, Rawls STRICT ACCEPT, ticket hardening report.
- [x] Hubble (Luna): preserve exact mainnet/testnet labels and unique control IDs.
      Same settings candidate and independent ACCEPT as above.
- [x] Hubble (Luna): off-to-off sizing saves must not show a stopped toast.
      Real endpoint/UI/hook regressions included in the accepted settings batch.
- [ ] Archimedes/Hubble/Lovelace: reject new ambiguous Alpaca account selection
      across server, copy UI and terminal auto-selection while preserving old
      follow references, exposure and Stop behavior.
- [x] Galileo (Luna): partial perp metadata must never fall through to
      equity dispatch; use one conservative classifier across row decisions.
      `dc2502a4` / `2180d6b5`, Rawls STRICT ACCEPT, quote hardening report.
- [x] Galileo (Luna): failed/stale quote refreshes must disable Copy;
      cached data alone is not freshness evidence.
      Same accepted quote batch, 12 actual-component browser cases passed.
- [ ] Archimedes (Luna): real local PostgreSQL API-save/follow/discovery/delivery
      pipeline proof with broker I/O mocked, including replay and consent guards.
- [ ] Sagan/Rawls (Sol): verify each correction and remaining bounded review areas.

## Decisions

- 2026-09-06: User is not a maintainer and can only submit a PR. Leave Vercel,
  deployment access and rollout to maintainers; finish code, tests and review.
- 2026-09-06: User confirmed holding ambiguous X partial exits rather than
  guessing a quantity or percentage.
- 2026-09-06: User clarified that users enter Alpaca credentials for live
  trading, with no extra verification workflow. Existing server-side key
  validation stays behind the scenes. Check SIM/PAPER behavior before changing
  it; valid live keys must not be blocked merely by an old null-identity row,
  and old mirror links must not silently move to another account.
- 2026-09-06: User requested a non-draft PR. Marked PR #243 ready for review,
  not ready to merge; all feature blockers and required verification remain.
- 2026-09-06: User requested a PR. Pushed the synced branch and opened draft
  PR #243 against main, explicitly not ready to merge. This publication does not
  accept the pending fixes or authorize production deployment.
- 2026-09-06: User requested main synchronization first. Completed locally;
  preserve and pause the separate correction worktrees. No push or PR publication
  as part of this sync; the broader feature remains rejected.
- 2026-09-05: Local broker mocks prove application behavior, not live fills.
- 2026-09-05: Migration 0040 requires a controlled maintenance cutover: freeze
  old API writers, drain mutations, pause old workers, migrate, deploy new API
  and web, verify destinations, then resume workers/writes. No old-binary rollback.
- 2026-09-05: No production trades, wallet exports, signatures or flag changes.
- 2026-09-05: Progress is posted in this conversation; no webhook configured.
- Resolved by the Live-key clarification: allow a separate identified credential
  without retargeting existing mirrors when legacy account identity is unknown.
  Candidate API commit `65cc322e` blocks that save and requires correction; it is
  not accepted or integrated. Different-account keys must never overwrite the
  old UUID. Existing Paper execution remains unchanged.
- Confirmed: unquantified X option partial-close posts hold without guessing.
  No default percentage is authorized; do not infer one contract per post.

## Current Receipts

Controller combined source `2180d6b5`: fresh `bun test` with browser module
opt-in, 5127 pass / 33 skip / 0 fail, 15197 assertions, 325 files. Both browser
wrappers passed. Forced root types: 11/11 uncached; lint exit 0 with existing
warnings. This is the accepted intermediate batch, not the final remainder,
fairness, pipeline or authenticated-browser gate. Combined build still pending.

Settings candidate `fddefd20`, integrated unchanged as `aaa2930a`: coder
canonical 5019 pass / 33 skip / 0 fail, types 11/11 and lint exit 0.
Rawls independently ran 288 passing focused regressions with 1 responsive
opt-in skip and endpoint/confirmation/boundary probes, returning scoped ACCEPT.
See `reviews/verify-copy-settings-hardening.md`; combined final gate remains open.

On 2026-09-06, accepted sync source `08c23cfa` (ancestor main `f3cfcb4f`):

- Fresh integrated canonical run: 4985 pass, 33 skip, 0 fail, 14653 assertions,
  319 files, with the responsive Playwright regression opted in.
- Fresh integrated types: 11/11 pass, no cached tasks; lint exit 0.
- Corrected source production build: 11/11 pass in the clean merge-helper
  checkout. The first attempt failed with ENOSPC after compilation and static
  generation. Removing only agent-generated caches and rerunning the same build
  tasks with Turbo `--cache=local:r` passed; no source/config change was needed.
- Independent scoped review: 120 focused tests pass, including twelve computed
  responsive browser cases and real parent/rail/form handler coverage.
- No production work, real orders, push or PR CI was performed for the sync.

Logs: `main-sync-integrated-{tests,types,lint}-20260906.log`,
`main-sync-corrected-build-retry-20260906.log` and the independent review receipt,
all in the external artifact directory. Earlier receipts below are historical.

Worker candidate `79b14614` received scoped REJECT from Sagan; see
`reviews/verify-copy-worker-hardening.md`. Independent 89-test pass did not catch
the reproduced valid-open rejection, fill-time over-attribution, or X lifecycle
size/partition defects. Goodall's corrective work is paused with required
behavioral regressions. Reported full 4757 pass / 27 skip / 0 fail, worker types
pass and lint exit 0 do not override rejection. No worker fix is integrated. The perp
remainder and queue fairness findings remain outside that patch.

Frontend candidates received scoped REJECT reports from Rawls. The same coders
have paused corrective work for the findings below. None is accepted or integrated:

- Ticket lifecycle `885066a1`: reported focused 97 pass; full 4756 pass / 27 skip /
  0 fail; types and lint pass.
- Settings `b41f1b9b`: reported focused 143 pass; full 4758 pass / 27 skip /
  0 fail; web types and lint pass.
- Quote/routing `652d454a`: reported focused 125 pass; full 4780 pass / 27 skip /
  0 fail; types and lint pass. Coder reports reusing existing 90000ms freshness.

See the three `reviews/verify-copy-*-hardening.md` frontend reports. Required
corrections are real retry/cancel and X-feed ticket ownership, actual API account
labels and null-account save feedback, and independently timed quote expiry with
click-time validation and a fail-closed future-clock policy. The settings coder
may extend only `hasApiCredentials` and its response tests, not credential-saving
or the unresolved legacy policy. Helper-only tests did not prove these flows.

The baseline browser manual-copy test reproduced stale stock prefill after
mobile dismissal/reopen. Synthetic AAPL/BTC feed rows returned HTTP 200 with
correct metadata; follower orders remained zero. The local perps feature was
disabled, so the isolated QA configuration is being adjusted for perp prefill
only, with auto-execution flags off and no worker/order submissions.

On 2026-09-05, committed source HEAD `6b856a4e`:

- `bun test`: 4750 pass, 27 skip, 0 fail, 300 files. Clean baseline has no
  failing names and the candidate introduces none. The new opt-in PostgreSQL
  proof accounts for the additional skip in the default run.
- `bun run check-types`: all 11 packages pass.
- `bun run lint`: exit 0, warnings remain; no lint errors.
- `bun run build`: all 11 packages pass, including Next production build.
- Opted-in local PostgreSQL migration proof: 1 pass, 12 assertions, no failure.
- `git diff --check origin/main...HEAD`: passes.
- Local browser baseline: dummy DB and reload preserved Stocks USD 123.45 and
  Perps USD 25 with both off; both arm dialogs cancelled without enabling.
  Observed desktop 1440x900 and mobile 375x812, no horizontal overflow.
  Manual-copy prefill checks still need source-trade fixtures. These browser
  checks used the pre-fix source build, not the pending corrections.

Logs are outside Git in `rst-copy-qa-artifacts/`. These receipts do not replace
the pending cold reviews, actual browser checks, PR CI or live release checks.
