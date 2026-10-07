# Task 7 report: per-follow copy leverage caps and arming visibility

## Scope

Manage follows now reads the user-owned global automatic-perp ceiling and shows
it as a read-only summary with a link to `/settings?tab=copy-trading`. Each
follow has a destination-independent `Perp leverage cap` selector: `Use global
(Nx)` stores `null`, while whole-number overrides are offered only from `1x`
through the current global value and are saved through `copyTradeFollows.update`.
The saved row remains the source of truth after a rejected mutation, and the
selector stays visible before a Hyperliquid credential is selected. The
dropdown width and row controls wrap safely at narrow viewport widths.

Arming summaries for Manage follows include the effective automatic-perp
ceiling, `min(global, optional follow)`, and retain the existing destination,
sizing, daily/notional, and exit facts. Missing or invalid global data is shown
as unavailable rather than guessed.

## TDD evidence

The new focused tests were written before the implementation. The initial red
run failed for the expected missing global state, summary/link, per-follow
control, and arming-ceiling behavior. The same focused suite passed after the
hook and Manage follows changes.

## Verification

```text
bun test apps/web-v2/src/components/copy-trade/copy-trade-follow.test.ts apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts
165 pass, 0 fail, 555 expect() calls

bun test apps/web-v2/src/components/copy-trade
289 pass, 0 fail, 875 expect() calls

bun --filter @trade-bot/web typecheck
@trade-bot/web typecheck: Exited with code 0

bunx oxlint apps/web-v2/src/components/copy-trade/manage-follows.tsx apps/web-v2/src/components/copy-trade/use-manage-follows.ts apps/web-v2/src/components/copy-trade/copy-trade-follow.test.ts apps/web-v2/src/components/copy-trade/use-manage-follows.test.tsx apps/web-v2/src/components/copy-trade/mirror-consent.test.tsx apps/web-v2/src/components/copy-trade/copy-trade-panel.test.ts
passed with no diagnostics

git diff --check
passed (only Git line-ending normalization warnings for existing Windows checkout files)
```

The commit contains only the six Task 7 files, this report, and the SDD ledger
entry. Existing Task 5/6 commits and unrelated working-tree changes were left
untouched. No migration, deployment, push, or service restart was performed.

Commit message: `feat: add per-follow copy leverage caps`
