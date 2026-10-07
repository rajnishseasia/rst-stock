# Railway Worker Deployment

Railway is the only supported production deployment path for
`@trade-bot/worker`. The worker is a persistent process responsible for Discord
polling, order reconciliation, optional copy mirroring, and optional P&L image
rendering. Vercel must not run this process.

## Service configuration

1. Create one Railway service from this GitHub repository.
2. Keep the service root at `/` so Bun can resolve the monorepo workspaces.
3. Do NOT set Railway's config-file setting. Railway has deprecated
   config-as-code (`railway.json` / `railway.toml`) in favour of Infrastructure
   as Code (`.railway/railway.ts`), and rejects the former outright:
   "Config as Code is deprecated." A committed `railway.json` is inert, and a
   stale one is what let the worker crash-loop against an unmigrated schema on
   2026-08-31. Configure the service directly instead.
4. Set these in the service settings (Railpack builder):
   - build: `bun --filter @trade-bot/worker build`
   - pre-deploy: `bun run db:validate`, `bun run db:migrate:production`, then
     `bun run db:verify-worker-schema`
   - start: `bun run --filter=@trade-bot/worker start`

   These are the values the production service actually runs; verify with the
   query under "Verifying the service settings" below rather than trusting this
   list. Note the start command runs `src/` directly under Bun, so the build
   step's `dist/` output is currently unused. That is a known inconsistency, not
   a typo: switching to `start:production` is untested in this service and
   should be done deliberately, not as a drive-by edit.
5. The pre-deploy sequence runs in the application environment before the
   worker is started. If validation, migration, or schema verification fails,
   Railway must not start the new worker release. Keep the startup compatibility
   guard as the final defense; it intentionally does not migrate a remote
   database during worker startup.

For an empty database, `bun run db:migrate:production` uses the committed
forward runner:
it applies and commits the batch ending at
`0015_overrated_franklin_richards`, then applies the remaining journal in a
second transaction. This ordering is mandatory because the later
`0025_easy_ezekiel` index predicate uses the `PERP` enum value introduced by
`0015`. Existing production databases are resumed from their latest journal
row and do not replay applied migrations. Before selecting pending migrations,
the runner checks that production's journal is an exact contiguous prefix of
the committed journal and that each recorded SQL hash matches the checked-in
file. It stops on missing, unknown, duplicate, or tampered rows. Do not edit
old migration SQL or delete journal rows.

Migration `0035_restore_copy_mirror_indexes` is a forward-only repair for
databases that journaled one of the two reviewed historical `0032` SQL hashes.
It drops and recreates the five worker-required copy-mirror indexes with
explicit `public` qualification and journals only after every concurrent index
operation succeeds. A failed concurrent index repair is safe to retry through
the same command; do not manually edit the `0032` file or delete its journal
row. The migration runner and the worker-schema verifier share a bounded
PostgreSQL advisory lock, so a second deployment fails with a retryable
diagnostic rather than inspecting a partially repaired schema.

The worker performs a startup compatibility check before Redis or any poller is
started. The current worker requires the committed chain through
`0041_copy_trade_cap_constraints`, including migrations
`0029_free_whirlwind`, `0030_curious_vindicator`, `0031_useful_pixie`, and
`0035_restore_copy_mirror_indexes`.
Migration `0035` restores the five copy-mirror indexes whose exact definitions
are required by the worker. Migration `0038` adds the leverage settings that the
arming and execution paths require:

- `copy_trade_follows.perp_max_leverage` is `integer`, nullable, with no
  default. Constraint `copy_trade_follows_perp_max_leverage_range_check`
  permits `NULL` or an integer from `1` through `100`.
- `users.copy_perp_max_leverage` is `integer NOT NULL DEFAULT 1`. Constraint
  `users_copy_perp_max_leverage_range_check` requires an integer from `1`
  through `100`.
- Migration `0039` adds the durable per-follower/per-source-wallet fill cursor.
  Its exact columns, composite primary key, cascading user foreign key and
  follower index are required before wallet-source polling can start.
- Migration `0040_shiny_paibok` adds the optional per-follow
  `copy_trade_follows.max_trade_size` and `max_coin_size` columns as nullable
  `numeric(12, 2)` values with no defaults. Migration
  `0041_copy_trade_cap_constraints` adds the validated constraints for both
  columns: `NULL` or a value strictly greater than `0` and less than or equal
  to `1,000,000`.

The compatibility gate checks the live social order link, canonical author
tables, source-event columns and partial unique index, alias foreign key,
identity uniqueness, cursor CAS/backfill columns, copy-mirror indexes, and the
0038 leverage columns plus their defaults, nullability, and range constraints,
the complete 0039 wallet-copy cursor contract, and the exact 0041 copy-trade
cap contract. The 0041 check requires both cap columns to be nullable
`numeric(12, 2)` with no default and requires both named range constraints to
be present and validated. It runs before Redis or any poller starts, alongside
the other startup compatibility checks.
If Railway starts the worker before those migrations are applied, or against a
schema with a missing or malformed 0038, 0039, or 0041 contract, startup stops
with a `[worker schema compatibility]` error; it must not be bypassed or
treated as a successful deployment. Apply committed migrations through the
maintainer workflow first, then restart the worker. This guard checks the live
schema and does not run a remote migration itself.

## Verifying the service settings

Because the pre-deploy sequence lives in Railway's settings and not in this
repo, nothing in CI can detect it being cleared. Check it directly:

```bash
railway api 'query { serviceInstance(
  serviceId: "032e1267-31ba-4720-b352-790f4c4e3b40",
  environmentId: "fedd46fc-e1e2-4679-b0d4-306fa150967a"
) { preDeployCommand buildCommand startCommand railwayConfigFile } }'
```

Expected: `preDeployCommand` is the three-command sequence and
`railwayConfigFile` is `null`. To set it after a service is recreated:

```bash
railway api 'mutation { serviceInstanceUpdate(
  serviceId: "...", environmentId: "...",
  input: { preDeployCommand: "bun run db:validate && bun run db:migrate:production && bun run db:verify-worker-schema" }
) }'
```

A deploy proves it ran only if the deploy logs show all three markers before
`Starting Container`:

```
Migration journal, SQL files, and snapshot chain are valid.
Forward migrations applied successfully.
Worker schema compatibility checks passed.
```

`railway deployment redeploy` does NOT prove this. It replays the previous
deployment's config snapshot, so it reuses the settings captured at that
deployment's creation and will not pick up a setting changed since. Only a
fresh build (a push to `main`) does.

## Deploy order when a change spans the API and the worker

The Vercel API build no longer applies or verifies migrations, so **the API can
deploy against a schema the worker has not migrated yet.** Deploy the worker
first whenever a change needs both. This is a deliberate trade-off for having a
single migrator; the previous arrangement had the API build migrate too, and
two migrators racing the same database is what produced the 2026-08-31 crash
loop.

## Incident: 2026-08-31 worker crash loop

The worker crash-looped in production against an unmigrated schema:

```
[worker schema compatibility] 0038_copy_trade_leverage_caps is required:
copy-trade leverage columns or their exact 1..100 range constraints are
missing or have the wrong definition.
```

**Root cause.** Railway has deprecated config-as-code. The service had
`railwayConfigFile: null` and `preDeployCommand: null`, so it silently used
dashboard settings that had no pre-deploy step, and the committed
`railway.json` was inert. Attempting to point the service at the file is
refused: "Config as Code (railway.json / railway.toml) is deprecated. Use
Infrastructure as Code (.railway/railway.ts) instead."

**Why it was invisible.** `apps/worker/railway-config.test.ts` asserted the
committed file's contents and never that Railway reads it, so CI stayed green
while production had no pre-deploy at all. The file had been decorative since
Railway shipped the deprecation. The test now asserts no such file exists and
that every script the pre-deploy invokes is still present.

**Contributing factor.** The Vercel API build was independently migrating, which
masked the missing pre-deploy for months: whichever deploy ran last happened to
fix the schema. The 2026-08-31 ordering (worker deployed ~9 minutes before the
API build migrated) exposed it.

**Fix.** Pre-deploy set directly on the service; the DB step removed from the
Vercel build; the inert `railway.json` deleted.

**Open follow-up.** The pre-deploy command now lives only in Railway's settings,
so recreating the service will not reproduce it and nothing in CI can catch it
being cleared. The sanctioned path back into version control is
`.railway/railway.ts`, which requires the `railway-ts-sdk` dependency.

## Environment contract

Required:

- `DATABASE_URL_DIRECT`: direct PostgreSQL endpoint, normally port 5432. Do not
  use the Supabase transaction pooler/PgBouncer URL on port 6543. Use the
  direct database endpoint or a session-mode endpoint on port 5432, with SSL
  enabled according to the production connection string.
- `REDIS_URL`: the same Redis deployment used by the API.
- `ENCRYPTION_KEY`: must exactly match the API value so order sync and
  auto-mirror can decrypt saved broker credentials.
- `DISCORD_BOT_TOKEN`: token used by the Discord signal poller.

Optional features:

- `DISCORD_WEBHOOK_URL`: notification embeds.
- `DISCORD_HISTORY_BACKFILL_PAGES`: number of 100-message Discord history pages
  fetched per bounded recovery pass. Defaults to `10`; valid values are
  strictly bounded to `1..100` (invalid values fall back to `1`). Forward
  recovery uses the same page bound and a hard cap of 5,000 messages per pass.
  When startup recovery reaches the cap, the separate durable backfill
  boundary resumes older messages on a later pass instead of skipping them.
- `WORKER_ERROR_ALERT_WEBHOOK_URL`: dedicated Discord-compatible reliability
  webhook. The worker sends a redacted alert after more than 20 errors in a rolling hour
  and suppresses duplicate alerts for one hour. It is intentionally separate
  from end-user notification webhooks.
- `WORKER_API_SECRET`: enables the private P&L image HTTP endpoint; must match
  the API value.
- `WORKER_HTTP_PORT`: HTTP port, default `3002`.
- `COPY_TRADE_AUTOMIRROR_ENABLED=true`: enables copy-mirror polling.
- `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE=true`: separately permits real-money
  mirroring on BOTH venues, live Alpaca accounts and Hyperliquid mainnet. Leave
  false for paper-only operation (Alpaca paper plus Hyperliquid testnet).
- `COPY_TRADE_AUTOMIRROR_PERPS_ENABLED=true`: enables perpetual-futures
  candidates after the master copy-mirror switch is enabled. A running
  Hyperliquid reconciler is a HARD PRECONDITION, but it runs by default, so
  normally there is nothing to set. If you switch it off with
  `HYPERLIQUID_SYNC_ENABLED=false`, no perp is mirrored at all, the worker logs
  one loud `REFUSING` line naming both variables, and every perp candidate is
  skipped with outcome `perps-sync-disabled` (stock and option mirroring are
  unaffected). The sync poller writes `orders.executed_size_decimal`, which sizes
  percent- and dollar-sized perp closes, and it is the only process that resolves
  a PENDING perp order against the venue. `HYPERLIQUID_NETWORK` must also be set
  explicitly, or every perp candidate is skipped with outcome
  `perps-network-unset`.
- `COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET=true`: separate explicit opt-in
  for real Hyperliquid orders, required IN ADDITION to
  `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE`. Leave false while validating on testnet.
- `COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS`: how old a perp OPEN may be,
  measured from the source trade, before the worker refuses to copy it. Default
  900000 (15 minutes). Reduce-only closes are exempt.
- `COPY_TRADE_AUTOMIRROR_DAILY_CAP=20`: deployment-wide emergency ceiling for
  mirrored entries per follower per day. Reduce-only closes are exempt. It does
  not choose the follower's requested order size or leverage.
- The **$10.55 USD per-open ceiling** and **one accepted non-reduce-only perp
  entry per follower per UTC calendar day** used for the funded local proof were
  sample configuration, not production wallet policy. Production requested
  exposure comes from each follow's saved sizing mode/value; persisted global
  and optional lower per-follow caps control leverage.
- There is no deployment default stop-loss or take-profit for a mirrored perp.
  Per-follow SL/TP values are nullable; both `NULL` means that no automatic
  SL/TP is attached. Do not invent or document a default.
- Automatic perp leverage is controlled by each follower's persisted
  copy-trading settings: the user global maximum and an optional lower
  per-follow maximum. Deployment environment does not select a user's leverage.
- Testnet validation requires both `HYPERLIQUID_NETWORK=testnet` and
  `HYPERLIQUID_ALLOW_TESTNET=true`. If either is missing, the shared client
  resolver treats the venue as mainnet and the mainnet auto-mirror guard stays
  enforced.
- `HYPERLIQUID_SYNC_ENABLED`: a KILL SWITCH, not an opt-in. Leave it unset.
  Reconciliation of ambiguous perp submissions and fills runs by default, and
  only the exact string `false` stops it. Setting it to `false` also stops perp
  mirroring, since a mirrored perp nothing can reconcile is worse than a missed
  one.
- `HL_WALLET_COPY_ENABLED=true`: after migration `0039`, enables the read-only
  Hyperliquid wallet source watcher. It never signs or submits an order; it
  stages source fills into the shared durable copy-mirror delivery engine.
  Wallet source staging requires `HYPERLIQUID_SYNC_ENABLED=true` explicitly,
  plus the master mirror/perps switches, explicit network, and the applicable
  mainnet/testnet gates. Production mainnet therefore also requires
  `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE=true` and
  `COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET=true`.
- `HL_WALLET_COPY_POLL_MS=15000`: source discovery interval only. It has no
  authority over follower sizing, leverage, SL/TP or emergency ceilings.
- Copy-mirror sizing/cap variables documented in `apps/worker/.env.example`.

Each followed target has exactly one explicit auto-mirror destination selected
in **Manage follows**. Select an Alpaca account for stock/options mirroring or a
ready Hyperliquid account for perp mirroring. Existing follows that point to an
Alpaca credential do not consent to perp execution and are skipped by the
worker; a user must deliberately switch that follow to Hyperliquid before any
perp order is eligible.

Never paste values into the repository, build logs, or a PR.

## Release checklist (maintainer)

1. Confirm the Railway service points at the intended branch, and that its
   `preDeployCommand` service setting is still the three-command sequence
   below. Verify with:
   `railway api 'query { serviceInstance(serviceId: "<id>", environmentId: "<id>") { preDeployCommand } }'`
2. Verify the production Supabase project reference and configure
   `DATABASE_URL_DIRECT` in Railway with its direct/session-mode port-5432
   endpoint. The Railway pre-deploy hook runs:

   ```bash
   bun run db:validate
   bun run db:migrate:production
   bun run db:verify-worker-schema
   ```

   A failed command aborts the worker deployment. Run production migrations from
   a clean canonical **LF** checkout of the exact release commit/ref, never from
   a Windows **CRLF** working copy. For a manual recovery or preflight, run the
   same commands from that checkout's repository root with
   `DATABASE_URL_DIRECT` injected; do not use a local dotenv file or print the
   URL. The Vercel API build does not run the migration runner or touch the
   database. If a release changes both API code and the schema, deploy the
   worker first and wait for these three markers before deploying the API.

   The `db:verify-worker-schema` step checks all worker compatibility contracts,
   including the required copy-mirror indexes. The worker startup gate remains
   a final diagnostic, not the migration mechanism.

   The required order is schema before worker: canonical LF checkout, journal
   validation, forward migration through `0041`, worker-schema verification,
   worker build, and only then worker start. The copy-mirror execution gates
   must be exact lowercase `true` values for `COPY_TRADE_AUTOMIRROR_ENABLED`,
   `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE`,
   `COPY_TRADE_AUTOMIRROR_PERPS_ENABLED`, and
   `COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET`. Do not start or re-enable a
   worker before schema verification succeeds.

   Do not set `SKIP_DB_MIGRATE` on any deployment. No current build reads that
   variable; production schema changes belong to the Railway pre-deploy
   sequence above.

3. Deploy one worker replica unless the change explicitly proves every poller
   safe under concurrent replicas.
4. Confirm startup logs show the expected Railway commit SHA/service name and
   `Worker started successfully`.
5. Confirm Paste.trade logs identify the expected `disabled`, `healthy`,
   `unchanged`, or `empty` state; investigate `auth_failure`, `parse_failure`,
   and `upstream_failure` states before enabling ingestion.
6. Confirm Discord polling and order sync are healthy before enabling optional
   auto-mirror flags. Verify a test follow has the intended explicit destination
   in **Manage follows**; do not infer perp consent from a legacy Alpaca follow.
7. For P&L images, expose `WORKER_HTTP_PORT` and set the API's
   `WORKER_HTTP_URL` to the Railway domain.

## Recover missed leaderboard calls

The Discord poller stores a forward snowflake cursor plus a separate raw
backfill boundary in `signal_ingestion_cursors`. On a first deployment it walks
backward in up to the configured history pages, processes the oldest rows
first, and persists any remaining older boundary when the pass reaches its
cap. Later passes resume that boundary before forward polling, so bounded
startup recovery does not permanently skip older events. Signal writes are
deduplicated by a source-qualified event ID and the database unique index, so
retries are safe and also repair metadata on historical rows. A page boundary
advances only after every valid row in that page has been processed. The
recovery cap is 5,000 messages per pass; the health log reports pages,
rejected events, processed messages, and whether the cap was reached. Relay
webhook and bot IDs remain noncanonical; only explicit source-author identity
provenance can create an X caller key.

1. Estimate the number of channel messages posted while the worker was down.
   Set `DISCORD_HISTORY_BACKFILL_PAGES` to `ceil(messages / 100)` plus one page
   of margin, never above `100`, then restart one worker replica.
2. Confirm the Discord recovery log reports the expected cursor and that normal
   forward polling resumes. Invalid or malformed events should be counted as
   skipped, not block later messages.
3. X-caller leaderboard cache entries expire within 15 minutes. To recompute
   immediately, delete only `leaderboard:xCallers:*` keys from the shared Redis
   deployment; do not flush the database or the whole Redis instance.

The X-caller API returns `dataComplete: false` if the selected window itself
contains more than the 5,000-signal online scan cap. This flag means ranking and
call totals cover the newest bounded scan, while market-data measurement remains
limited to each caller's newest 50 directional calls. Increasing the Discord
backfill does not bypass that API safety cap.

## Rollback

Rollback is fail-safe and starts with execution disabled:

The rollback must preserve user funds and all existing Privy/Hyperliquid agent
wallets, approvals, credentials, policies, reconciliation state, and positions.
It includes no revocation, deletion, moving of funds, or replacement of any of
those resources: do not revoke or rotate approvals or credentials, delete
wallet or reconciliation state, move user funds, or replace existing agent
wallets.

Rollback here means rolling back worker application code, not rolling back the
database. The migration numbers below are historical contract landmarks: `0039`
introduced the wallet-copy cursor, `0040` added the nullable cap columns, and
`0041` added their validated range constraints. Production schema is forward-only
and must remain at `0041` or later once those migrations have been applied. Do
not restore a pre-0041 schema by deleting newer columns or constraints, removing
journal rows, or manually running a down migration.

1. Set the worker's `COPY_TRADE_AUTOMIRROR_ENABLED` to the exact off value
   `false`, redeploy/restart, and verify the boot log and subsequent cycles show
   mirroring disabled. Do this **before** rolling back application code; do not
   rely on an API-side copy of the variable.
2. Inventory copy-mirror orders and live positions before changing code. Record
   source/follower IDs, venue order IDs, sides, quantities, `reduceOnly`,
   statuses, and any pending or ambiguous intents from the database; separately
   capture open Alpaca positions and Hyperliquid positions from their
   read-only production views. Do not cancel or close positions as part of this
   inventory step.
3. Leave reconciliation, network, and schema intact: keep
   `HYPERLIQUID_SYNC_ENABLED` unset so reconciliation remains on, keep
   `HYPERLIQUID_NETWORK=mainnet`, and do not delete columns, indexes, journal
   rows, or manually down-migrate `0041`, `0040`, `0039`, or any earlier
   migration.
4. Roll back code only to a reviewed release that is compatible with the live
   schema through `0041`. If the previous worker predates the 0041 cap contract,
   leave `COPY_TRADE_AUTOMIRROR_ENABLED=false` until that release is proven
   compatible with the live schema; never re-enable an incompatible old worker
   and never bypass the startup guard. Ship a forward, reviewed compensating
   migration if a schema change is required.
5. Re-inventory orders and positions, verify reconciliation has resolved or
   preserved ambiguous submissions, and only then consider enabling the
   compatible worker with the exact gates above.
