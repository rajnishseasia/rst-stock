# Verification: RST-013

- Ticket ID: RST-013
- Base SHA: `3da8785def13228cd78602e85624f9f40708a1bd` (round 2 correction base)
- Reviewed-tree SHA: `83dc378b1db4204f9eea5e03567a463508b33d5b`
- Model: Codex GPT-5, PRAGMATIC cold verification
- Round: 2
- Result: ACCEPT

## Round 1 Record

- Base SHA: `f88343f3aa0a45ea0b5177ffdd7a08e80b1ba8a2`
- Reviewed-tree SHA: `3da8785def13228cd78602e85624f9f40708a1bd`
- Result: REJECT, with the two test-coverage findings below. Both are resolved in round 2.

## Round 1: Numbered Checks

1. PASS. `MOBILE_SHORTCUTS` maps Perps, Copy Trading, and AI Chat to `perps`, `copy-trading`, and `ai-chat` (`apps/web-v2/src/app/guide/page.tsx:56-60`). The overview renders these links (`apps/web-v2/src/app/guide/page.tsx:275-290`); the existing section IDs are at `apps/web-v2/src/app/guide/page.tsx:571`, `:850`, and `:884`. The focused render test passed.
2. PASS. The complete `HEAD^..HEAD` diff adds only the shortcut constant and overview nav to `apps/web-v2/src/app/guide/page.tsx`, plus the new test. Existing overview content and the desktop table of contents remain unchanged; the desktop nav is still `hidden lg:block` (`apps/web-v2/src/app/guide/page.tsx:231-258`).
3. FAIL. The test imports and renders `GuidePage` (`apps/web-v2/src/app/guide/page.test.tsx:1-11`), so it tests rendered component output rather than reading source text. Against the base, the overview goes from its intro directly to its existing cards (`HEAD^:apps/web-v2/src/app/guide/page.tsx:263-269`), so the test's `mobileNav` assertion at current `apps/web-v2/src/app/guide/page.test.tsx:13` would fail. I did not run that test in a second checkout. However, the test does not verify each label is paired with its destination, and its responsive assertion does not prove mobile visibility. See Findings.
4. PASS. `git diff-tree` shows exactly the two assigned paths: `apps/web-v2/src/app/guide/page.tsx` and `apps/web-v2/src/app/guide/page.test.tsx`. The worktree was clean before this assigned report; no unrelated edits were present.
5. PASS for implementation. The mobile nav uses base `flex` with `lg:hidden` (`apps/web-v2/src/app/guide/page.tsx:275`); the desktop nav uses `hidden lg:block` (`apps/web-v2/src/app/guide/page.tsx:231`). These breakpoint classes make the navs mutually exclusive, and the mobile links are in the overview. Test coverage for mobile visibility remains inadequate as described in Finding 2.
6. PASS. Focused test, canonical suite, type check, and lint all completed successfully. Exact totals and baseline comparison are below.

## Round 1: Findings (Resolved in Round 2)

1. [P2] Assert label and destination on the same link. `apps/web-v2/src/app/guide/page.test.tsx:16-23` checks that each expected `href` and each expected label occur somewhere in the nav, independently. Swapping the Perps and Copy Trading targets would leave all expected labels, hrefs, and section IDs present, so this test would pass with incorrect destinations. Parse the rendered shortcut anchors and compare exact `(label, href)` pairs for all three links.

2. [P2] Assert the mobile nav is visible below `lg`. `apps/web-v2/src/app/guide/page.test.tsx:13-15` only requires the `lg:hidden` token. Adding an unprefixed `hidden` class to the current nav would hide it on mobile while preserving `lg:hidden`, and the test would still pass. Assert the base-visible display class and reject an unprefixed `hidden` class, or verify computed visibility at mobile and desktop viewports.

## Strict Checklist Results

All items are N/A because this change only adds static guide-section links and a hash/scroll handler (`apps/web-v2/src/app/guide/page.tsx:190-195,275-290`). It does not place trades, manage positions, persist trading state, or process external events.

| Category | Item | Result and evidence |
|---|---|---|
| Money-loss | Wrong account | N/A. No account-scoped action; guide navigation only (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Money-loss | Size | N/A. No order sizing or size input (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Money-loss | Side | N/A. No order-side behavior (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Money-loss | Leverage | N/A. No leverage behavior (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Money-loss | Consent | N/A. No trade or consent flow (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Money-loss | Attribution | N/A. No user, account, source, or follower attribution (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Parity | Stocks and perps | N/A. No trading behavior for either venue (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Parity | Entry behavior | N/A. No entry path (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Parity | Exit behavior | N/A. No exit path (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Boundaries | Empty state | N/A. Links are a fixed constant, with no data/result-set input (`apps/web-v2/src/app/guide/page.tsx:56-60,275-290`). |
| Boundaries | Malformed state | N/A. No external or persisted state is consumed by the shortcuts (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Boundaries | Missing state | N/A. No record or trading state is consumed (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Boundaries | Stale state | N/A. No cached or time-sensitive state is consumed (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Boundaries | Partial state | N/A. No writes, fills, or updates occur (`apps/web-v2/src/app/guide/page.tsx:190-195,275-290`). |
| Duplication | Replay | N/A. Link clicks only update the URL hash and scroll (`apps/web-v2/src/app/guide/page.tsx:190-195`). |
| Duplication | Retries | N/A. No external or financial effects to retry (`apps/web-v2/src/app/guide/page.tsx:190-195,275-290`). |
| Duplication | Reconciliation | N/A. No reconciliation path (`apps/web-v2/src/app/guide/page.tsx:275-290`). |
| Duplication | Competing workers | N/A. No worker or shared work queue (`apps/web-v2/src/app/guide/page.tsx:275-290`). |

## Round 1: Commands and Results

- `bun test apps/web-v2/src/app/guide/page.test.tsx`: 1 pass, 0 fail, 13 expectations.
- `bun test --timeout 30000`: 5,236 pass, 46 skip, 0 fail; 5,282 tests across 331 files, 15,551 expectations. Compared with the supplied clean baseline of 5,184 pass, 40 skip, 0 fail: +52 pass, +6 skip, 0 additional failures.
- `bun run check-types`: 11/11 packages successful.
- `bun run lint`: exit 0, 23 warnings, matching the supplied baseline. Warnings are in files outside this diff.
- `git diff --check HEAD^ HEAD`: exit 0, no whitespace errors.
- `git show --stat --oneline HEAD`: exactly 2 assigned files changed, 52 insertions.

## Round 1: Remaining Operational or Release Proof

No production, account, broker, or live-release proof is required for this guide-only navigation change. Browser-computed responsive visibility was not run; the source classes were checked, and test coverage for mobile visibility is a rejection finding above.

## Round 2 Review

The round 2 correction commit `83dc378b1db4204f9eea5e03567a463508b33d5b` has parent `3da8785def13228cd78602e85624f9f40708a1bd`, the reviewed source commit. Its complete diff changes only `apps/web-v2/src/app/guide/page.test.tsx`; no source files or other tests changed. The worktree had no source/test modifications, and only this assigned report is untracked.

1. RESOLVED. `apps/web-v2/src/app/guide/page.test.tsx:19-34` parses each rendered shortcut anchor into its label and href, then compares the ordered pairs to the expected list. The section IDs are still checked at `apps/web-v2/src/app/guide/page.test.tsx:36-38`.
2. RESOLVED. `apps/web-v2/src/app/guide/page.test.tsx:13-17` tokenizes the shortcut container's classes, rejects the base `hidden` token, and requires `lg:hidden`. Desktop navigation remains `hidden lg:block` in the unchanged source (`apps/web-v2/src/app/guide/page.tsx:231`), and the test retains its desktop TOC class assertion at `apps/web-v2/src/app/guide/page.test.tsx:40-41`.

### Round 2 Commands and Results

- `bun test apps/web-v2/src/app/guide/page.test.tsx`: 1 pass, 0 fail, 9 expectations.
- `bun test --timeout 30000`: 5,185 pass, 40 skip, 0 fail; 5,225 tests across 325 files, 15,256 expectations. Against the supplied clean baseline of 5,184 pass, 40 skip, 0 fail: +1 pass, unchanged skips, no failures.
- `bun run check-types`: 11/11 packages successful.
- `bun run lint`: exit 0, 23 warnings.
- `git diff --check 3da8785def13228cd78602e85624f9f40708a1bd 83dc378b1db4204f9eea5e03567a463508b33d5b`: exit 0, no whitespace errors.
- `git diff --name-status 3da8785def13228cd78602e85624f9f40708a1bd 83dc378b1db4204f9eea5e03567a463508b33d5b`: only `M apps/web-v2/src/app/guide/page.test.tsx`.

## Round 2: Remaining Operational or Release Proof

None. Both round 1 findings are resolved, the guide source is unchanged, and all requested local gates pass. No production or live-release proof applies to this UI-only test correction.
