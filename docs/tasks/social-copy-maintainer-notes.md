# Social Copy Maintainer Notes

## Required Cutover

Migration 0040 introduces independent stock/perp destination configuration,
an initialization marker, and nullable manual-copy source item/order columns.
Legacy consent migrates only to its owned, compatible destination. Invalid
legacy sizing/destination combinations are disarmed. The other venue is not
enabled automatically. No wallet migration, new secret or Redis change is needed.

This is a maintenance-window cutover, not a rolling-compatible deployment:

1. Block all old API writers, including admin scripts and background jobs. Drain
   in-flight mutations and pause every old copy-mirror worker before migration.
   Blocking the entire old API during the window is safest. An old API can
   otherwise update legacy fields without updating authoritative typed policies.
2. Let the Railway worker pre-deploy sequence validate/apply the migration and
   verify the schema, but prevent automatic copy processing from starting yet.
3. Deploy the new API to every serving instance, then the web application.
   Verify saved destination accounts, consent and sizing before resuming workers
   and reopening writes. Do not serve old API or worker binaries afterward.
4. If verification fails, keep maintenance active and forward-fix. Do not roll
   back to an old binary after 0040. Never edit an applied migration or use
   `db:push` to repair production.

The Railway worker owns production migration execution; the Vercel API build
does not migrate. The existing commands are `bun run db:validate`,
`bun run db:migrate:production`, and `bun run db:verify-worker-schema`, using
the confirmed direct database connection, never the transaction pooler.
These are maintainer release steps, not commands executed against production
during this review.

Existing positions stay open during the pause. Exchange-native protective
orders remain at the exchange, but worker reconciliation and new source-event
processing pause. Recent events may replay through the bounded recovery window.
Communicate the interval and monitor reconciliation before declaring restoration.

## Runtime Controls

The PR does not activate consent or trading flags. Confirm API/worker agreement
on existing `COPY_TRADE_AUTOMIRROR_ENABLED`, `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE`,
`COPY_TRADE_AUTOMIRROR_PERPS_ENABLED`, and
`COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET` controls. This is not an instruction
to enable them all. Retain intended limits and restrictions. Hyperliquid mainnet
uses real collateral and is not an Alpaca-style paper destination.

## Behavioral Boundaries

- Stocks and perps have independent accounts, sizing and enablement.
- Required boundary (pending stock Stop race correction and cold verification):
  Stop blocks new entries; it does not immediately liquidate existing exposure.
- Source-driven exits use attributable exposure and its original account.
- Manual copy pre-fills a reviewed order; it does not subscribe to source exits.
- Old user-authored notes are not backfilled as verified manual-source identity.
- Unknown broker outcomes require reconciliation. Unknown perp close fill sizes
  must not remove protection from potentially surviving exposure.

## Verification

See `social-copy-verification.md` and `reviews/` for the current gate and gaps.
Tests use mocks and disposable local PostgreSQL with dummy credentials. No live
orders, wallet signatures, production settings or production DB writes are used.
Actual exchange fills, collateral and deployed account readiness remain separate
maintainer release checks.

CI adds a disposable PostgreSQL 16 migration-proof job. For local proof, set
`COPY_TRADE_MIRROR_MIGRATION_TEST_DATABASE_URL` to a loopback admin database and
run `bun test packages/db/scripts/copy-trade-mirror-migration.test.ts`. It creates
and drops a random prefixed database. Missing opt-in skips the test; opted-in
connection failures fail it. Never use production credentials.
