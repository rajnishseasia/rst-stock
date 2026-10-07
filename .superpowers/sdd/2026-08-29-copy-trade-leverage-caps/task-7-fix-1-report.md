# Task 7 fix round 1 report: inline Mirror arming leverage ceiling

## Scope

The inline Mirror setup now carries each follow's nullable `perpMaxLeverage`
through its local follow map and arming-consent state, reads the same global
copy-perp ceiling as Manage follows, and adds the effective
`min(global, optional follow)` fact to its `ArmMirrorDialog`. The shared
`buildFollowArmingSummary` wording is reused so Manage follows and inline
Mirror arming cannot disagree or omit the ceiling. The Manage follows global
settings link now has the descriptive accessible name `Change copy-trading
leverage setting` while retaining its visible `Change` label and settings URL.

## TDD evidence

Focused regression tests were added before the implementation. The initial red
run failed because the inline summary helper was absent and the Change link
had no descriptive accessible name. The implementation then made both tests
pass and added coverage for inherited global and stricter per-follow ceilings.

## Verification

```text
bun test apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts apps/web-v2/src/components/copy-trade/copy-trade-follow.test.ts apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx
167 pass, 0 fail, 558 expect() calls

bun test apps/web-v2/src/components/copy-trade
292 pass, 0 fail, 880 expect() calls

bun --filter @trade-bot/web typecheck
@trade-bot/web typecheck: Exited with code 0

bunx oxlint apps/web-v2/src/components/copy-trade/copy-trade-panel.tsx apps/web-v2/src/components/copy-trade/manage-follows.tsx apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts apps/web-v2/src/components/copy-trade/copy-trade-follow.test.ts
passed with no diagnostics

git diff --check
passed (only Git line-ending normalization warnings for the Windows checkout)
```

No migration, deployment, push, or service restart was performed. Existing
Task 6, worker, and Next config working-tree changes were left untouched.

Commit message: `fix: show leverage on every mirror arming path`
