# Task 6 fix round 1 report

## Reviewer finding

The global Copy Trading settings card could keep showing its successful-save
message after a user edited the draft to a different value. That stale status
could imply that the new unsaved draft was already persisted.

## TDD fix

Added a failing regression for success visibility after the draft changes.
The component now renders the success status only while the draft parses to
the last confirmed saved value. Editing away from that value hides the stale
success message while preserving the existing save, loading, error, and
invalidation behavior.

## Verification

```text
RED: the new regression failed because shouldShowCopyTradeLeverageSuccess was
not present in the component module.

bun test apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.test.tsx apps/web-v2/src/lib/settings-tabs.test.ts
15 pass, 0 fail, 43 expect() calls

bun --filter @trade-bot/web typecheck
@trade-bot/web typecheck: Exited with code 0

bunx oxlint apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.tsx apps/web-v2/src/components/copy-trade/copy-trade-leverage-settings.test.tsx
passed with no diagnostics

git diff --check
passed (only Git line-ending normalization warnings for the Windows checkout)
```

Task 7 files and the existing next-config files were left untouched. No
migration, deployment, push, or service restart was performed.

Commit message: `fix: clear stale copy leverage success`
