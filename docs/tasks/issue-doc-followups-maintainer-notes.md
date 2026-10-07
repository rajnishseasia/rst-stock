# Issue-doc follow-up maintainer notes

This branch is based on `origin/main` at `55e9ddb` and closes the verified issues in the RST & DB tasks document. It is intended for review and staged production rollout; it has not been merged, deployed, or used to place live orders.

## Included fixes

- Cursor-safe merged signal feeds, integer limits, and fail-closed copy-trading cap updates.
- Database migration `0041_copy_trade_cap_constraints` with bounded nullable global/follow caps and a worker startup compatibility gate.
- Privy wallet import/export recovery that only operates on the authenticated user's EVM embedded wallet; no unsupported address-only export or silent wallet creation.
- JWT cache invalidation on logout, including fail-closed handling for an in-flight token response from a previous user/session.
- Privy perps mutations and signing controls now require a positively verified custom-auth subject; unresolved identity state is read-only.
- Copy-trade `maxTradeSize` and `maxCoinSize` are carried into every mirror candidate and re-read at execution. Per-order caps apply to both equity and Hyperliquid perps; total coin exposure includes filled and reserved intent under a user-row transaction lock, with short/open sell intents kept distinct from closes.
- Copy-trade cap inputs now match `numeric(12,2)` storage (`0.01` minimum, two-decimal precision, explicit `null` preserved), and the worker schema gate validates migration 0041's exact nullable bound semantics rather than permissive constraint fragments.
- Copy-source discovery on mobile, touch-safe position exits, and pane-aware position-to-trade navigation.
- Delayed source-fill retention and canonical historical follow aliases in mirror execution.
- Stop-loss/take-profit close-reason regression coverage and refreshed perps/copy-trading guide content.
- CI test timeout and migration ownership documentation corrections.

## Production rollout notes

- `0041_copy_trade_cap_constraints` must run through the existing Railway migration release path before worker/API traffic that relies on the new bounds. Vercel is not the production migration runner.
- Copy-trading caps, leverage, sizing, and exit settings remain user/follow configuration. The `$10.55` ceiling used in the prior local proof is not a production hard-coded runtime cap.
- Privy export/import behavior follows the documented authenticated embedded-wallet contract:
  - https://docs.privy.io/api-reference/wallets/export
  - https://docs.privy.io/recipes/hd-wallets
  - https://docs.privy.io/controls/authorization-keys/owners/overview
- Production smoke checks still required after deployment: two-account wallet-session recovery, imported-wallet balance/activation, delayed source fill to follower fill, 429/backoff telemetry, Discord close-reason notification, and migration compatibility on the live worker. Keep those checks read-only or use the separately approved production test account; do not use a user's funded wallet for synthetic orders.

## Validation on this branch

- `bun test` — 4,936 passed, 32 skipped, 0 failed across 312 files (14,389 expectations).
- `bun check-types` — all 11 workspaces pass.
- `bun lint` — passes; remaining output is the repository's existing unused-import/unused-variable warning set.
- `bun run db:validate` — migration journal, SQL files, and snapshot chain valid.
- Focused API (105), DB (126 + 14 skipped), web/Privy/mobile (154), and worker mirror/cap (405) suites pass.
- `git diff --check` passes.

The branch was fetched against `origin/main` at `55e9ddb` immediately before push; that commit is an ancestor of this branch. No live order, deployment, merge, or production database mutation was performed.
