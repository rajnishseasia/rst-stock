# Task 6 report: global Copy Trading settings UI

## Scope

Implemented the global automatic-perp leverage editor in Settings. The new
responsive Copy Trading tab deep-links through `?tab=copy-trading`, keeps the
existing Perps wallet tab unchanged, and renders a bounded 1..100 integer
control backed by the authenticated `userSettings` procedures.

The editor loads the saved value, keeps Save disabled when unchanged or while
pending, validates integer bounds client-side, preserves the last confirmed
value after an API error, shows saved/error states, and invalidates both the
global settings query and `copyTradeFollows.list` after success.

## TDD evidence

The focused tests were written before the implementation. The initial red run
failed for the expected reasons: `resolveSettingsTab("copy-trading")` fell
back to `broker`, and the new component module did not exist. After the
implementation, the same focused run passed.

## Verification

```text
bun test apps/web-v2/src/lib/settings-tabs.test.ts apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.test.tsx
14 pass, 0 fail, 41 expect() calls

bun --filter @trade-bot/web typecheck
@trade-bot/web typecheck: Exited with code 0

bunx oxlint apps/web-v2/src/lib/settings-tabs.ts apps/web-v2/src/lib/settings-tabs.test.ts apps/web-v2/src/app/settings/page.tsx apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.tsx apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.test.tsx
passed with no diagnostics

git diff --check
passed (only Git line-ending normalization warnings for existing Windows checkout files)
```

The commit contains only the Task 6 files, this report, and the SDD ledger
entry. Existing unrelated working-tree changes were left untouched. No
migration, deployment, push, or service restart was performed.

Commit message: `feat: add global copy leverage setting`
