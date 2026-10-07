# Verification Report: RST-014

**Decision: ACCEPT**

- Ticket: RST-014
- Base SHA: `f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2`
- Reviewed-tree SHA: `a52b8eb2fa512d139ae8528718517ff57e347dff`
- Model: GPT-5 (Codex)
- Round: 1
- Mode: PRAGMATIC. This is a navigation-only UI change; no order execution or persistence path changed.
- Full diff reviewed with `git show --no-ext-diff --no-renames --format=fuller HEAD`.

No blocking implementation findings. Evidence correction: after the controller removed generated `packages/db/dist`, the canonical suite was rerun before any new typecheck. Its totals match the clean base plus the one added regression test. The failing-name comparison is empty on both trees. No live profile/API or production access was performed.

## Numbered Checks

1. **PASS.** `UserRowCard` gates the action on `row.hasHyperliquid` and passes that same row plus `"fills"` to `buildUserProfileHref` ([leaderboard-row-cells.tsx](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard-row-cells.tsx:377), helper at [leaderboard-row-cells.tsx](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard-row-cells.tsx:87)). The helper retains the row's readable profile slug, falls back to its follow key, and adds `t=fills`. The profile page accepts that tab at [page.tsx](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/app/lb/users/[slug]/page.tsx:26), reads `t` at line 44, and renders the Fills tab at lines 200 and 277. The rendered regression uses slug `SOL_Decoder` with a different follow key and asserts the exact `?t=fills` destination ([leaderboard.test.ts](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard.test.ts:744)). The API row contract defines `hasHyperliquid` as a configured Hyperliquid credential at [leaderboard.ts](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/api/src/routers/leaderboard.ts:408) and sets it from the user's Hyperliquid membership at line 2342.

2. **PASS.** The stock-only fixture has `hasHyperliquid: false`; the rendered output must not contain `Perp trades` or Follow, and must retain the ordinary `/lb/users/Stock_Only` profile URL ([leaderboard.test.ts](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard.test.ts:766)). The eligible fixture still asserts the ordinary profile URL and Follow title at lines 763-764. In the component, the existing profile link remains at lines 361-375 and Follow remains gated as before at lines 391-393.

3. **PASS, structurally verified.** The action has the shared `h-11 sm:h-7` touch sizing and `sm:hidden` classes ([leaderboard-row-cells.tsx](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard-row-cells.tsx:382), [touch-target.ts](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/ui/touch-target.ts:21)); the test checks `sm:hidden` at [leaderboard.test.ts](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard.test.ts:762). The containing row uses `flex flex-wrap` ([leaderboard-row-cells.tsx](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard-row-cells.tsx:347)), the new link is `shrink-0`, and the metrics use a full-width mobile row at line 395. This keeps the action in normal wrapping flow and hides it at desktop widths. No browser viewport screenshot was part of this local-only verification.

4. **PASS.** The regression renders `UserRowCard` with `renderToStaticMarkup`, checks the eligible row's exact href and checks that a false eligibility flag removes the action ([leaderboard.test.ts](/Users/frankciafardini/Documents/Codex/2026-09-12/rst-p1-rst014/apps/web-v2/src/components/copy-trade/leaderboard.test.ts:746)). It exercises rendered component behavior rather than reading or regex-matching source. A wrong eligibility condition or destination would fail these assertions.

5. **PASS.** `HEAD^` is exactly the assigned base SHA. `git diff --name-only HEAD^ HEAD` lists only `apps/web-v2/src/components/copy-trade/leaderboard-row-cells.tsx` and `apps/web-v2/src/components/copy-trade/leaderboard.test.ts`, exactly the two owned files. The worktree was clean before this report was created; `git diff --check HEAD^ HEAD` exited 0.

6. **PASS.** After the controller removed generated `packages/db/dist`, `bun test --timeout 30000` produced `5,185 pass, 40 skip, 0 fail` across 5,225 tests in 324 files. This is the supplied clean-base total (`5,184 pass, 40 skip, 0 fail`) plus the one new regression test. Failing-name comparison: clean base, none; reviewed tree, none. This corrected canonical run occurred before any new typecheck. Typecheck remains `11/11` and lint remains at the expected 23 warnings.

## Gate Results

- `bun test apps/web-v2/src/components/copy-trade/leaderboard.test.ts`: 46 pass, 0 fail, 127 expectations.
- `bun test --timeout 30000`: 5,185 pass, 40 skip, 0 fail across 5,225 tests in 324 files; run after generated `packages/db/dist` removal and before any new typecheck.
- Failing-name comparison: clean-base reference, none; reviewed tree, none.
- `bun run check-types`: 11 successful, 11 total.
- `bun run lint`: exit 0, 23 warnings.
- `git diff --check HEAD^ HEAD`: exit 0, no whitespace errors.

## Remaining Proof

No live profile, API, broker, production, or deployment check was performed, per instruction. The exact route and rendered link are covered locally; deployment visibility remains outside this review. The strict money-loss/persistence audit is not applicable because the change only adds a profile-navigation link and does not alter trading or persisted state.
