# Repository Operating Notes

## Requirements Doc

The product requirements and task tracker for this project lives at:
https://docs.google.com/document/d/1rzwy36CG4aCpkWw_Ly0MUUKtO1MAbe0YGRwzdprM7U0/edit?tab=t.0

## Local Dev Setup and Browser Testing

### Port map

The user also runs an unrelated project (Olympus) that occupies ports 3000
and 3001. Do NOT confuse those for the RST app.

| Service        | Port | How to start                                              |
|----------------|------|-----------------------------------------------------------|
| RST API        | 5001 | `cd apps/api && bun run --watch src/index.ts`             |
| RST Web (Next) | 5100 | `cd apps/web-v2 && bun run dev`                           |

Always verify the correct app is loaded before screenshotting or testing:
the page title must read "Ready Set Trade", not "Olympus".

### Signing in locally

Google OAuth does not work on a dev machine. Use the "Local development
sign-in" form on the landing page at `http://localhost:5100`:

- Email: any address (e.g. `qa-tester@local.test`)
- Password: any string

On first use the API creates the account automatically (Better Auth
email/password provider is enabled only when `NODE_ENV=development`).
After sign-in the browser redirects to `http://localhost:5100/app`.

### Taking mobile screenshots with Playwright

1. Set viewport to 375x812 before navigating:
   `mcp__plugin_playwright__browser_resize { width: 375, height: 812 }`
2. Navigate to `http://localhost:5100/app` (NOT localhost:3000 or 3001).
3. If redirected to the landing page, sign in via the dev form above.
4. Take screenshots with `scale: "device"` and save inside the repo root
   (Playwright's allowed root). Then upload to catbox.moe per the global
   CLAUDE.md screenshot instructions.

### Checking the typecheck before committing

```bash
cd apps/web-v2 && /usr/local/bin/bun run typecheck
```

No output means clean. The `bun` binary is at `/usr/local/bin/bun`.

## Writing Style

- Do not use em dashes (the U+2014 character) in replies, commit
  messages, docs, PR descriptions, or code comments. Use a comma,
  period, colon, or parentheses instead.

## Secrets & Env Files — NEVER back up .env inside the repo

- **Never create a copy or backup of any `.env` file inside the repo** — no
  `.env.bak`, `.env.bak-claude`, `.env.old`, `.env.backup`, `env-copy`, etc.
  `.gitignore` only excludes `.env`, `.env.local`, and `.env.*.local`; any
  other filename is tracked by git and will be committed.
- If you need a rollback point before editing an env file, copy it to the
  session scratchpad directory (outside the repo), never alongside the
  original.
- Before every commit, review `git status` and the staged file list for
  env-like or secret-bearing files. If one is staged, stop and unstage it —
  do not commit and fix later; the secret lands in history immediately.
- Never print, log, or paste values from any `.env` file, even in local
  debugging output. Reference variables by name only.

## Workspace Preferences

- Do not create or use git worktrees for this repository. Make changes in the
  current workspace while preserving unrelated user edits.

## Screenshot and Temporary Image Files

- Never save screenshots, PNGs, or other temporary image files inside the
  repo directory. Always write them to `/tmp/` (e.g. `/tmp/screenshot.png`).
- This keeps the working tree clean and prevents accidental commits of binary
  blobs. The `/tmp/` path is also where the global CLAUDE.md instructs you to
  upload from when sharing images via catbox.moe.

## Response Length

- If a reply will exceed ~2000 characters, split it into two (or more)
  sequential messages instead of sending one long block. The transport
  sometimes truncates long replies, so a long answer should be sent as
  "Part 1 / N" followed by "Part 2 / N", each self-contained.

## Commit and Push Workflow

- **Do not commit, push, or open a pull request unless the user explicitly
  requests it.** Leave completed changes in the working tree by default.
- When the user requests a commit or push, commit the requested changes and
  push them directly to `main`. Do not create or use a feature branch or pull
  request unless the user explicitly requests that workflow.
- Preserve unrelated working-tree changes. Stage and commit only the files
  within the user's requested scope.

## Database Workflow

This repo uses PostgreSQL with Drizzle ORM.

### Local Development

- Local Postgres runs from `docker-compose.local.yml`.
- Database: `tradebot`
- Host: `localhost:5432`
- User/password: `postgres/postgres`
- Local env files point to this Docker database:
  - `apps/api/.env`
  - `apps/worker/.env`

For schema changes:

1. Update Drizzle schema files in `packages/db/src/schema/**/*.ts`.
2. Export any new schema module from `packages/db/src/schema/index.ts`.
3. Generate migrations:

   ```bash
   bun run db:generate
   ```

4. Review generated SQL in `packages/db/migrations/`.
5. Apply migrations locally:

   ```bash
   bun run db:migrate
   ```

6. Verify the app locally against `http://localhost:3000`.

If `db:generate` reports malformed snapshot metadata, do not guess silently. Inspect
`packages/db/migrations/meta/`, repair/regenerate snapshots deliberately, and mention the
state in the PR. Manual SQL migrations must still be committed and tested locally.

### Production / Supabase

Production Postgres is Supabase. Runtime API connections should use the pooled URL, but
migrations must use the direct Supabase database URL.

- API runtime: `DATABASE_URL_POOLED` or `DATABASE_URL`, Supabase pooler port `6543`.
- Worker and migrations: `DATABASE_URL_DIRECT`, direct Postgres port `5432`.
- Do not run DDL through the pooled PgBouncer URL.

The production workflow applies the committed migration journal. For a
maintainer with confirmed Supabase production access:

```bash
# point DATABASE_URL_DIRECT at the Supabase direct URL (port 5432), then:
bun run db:validate
bun run db:migrate:production
bun run db:verify-worker-schema
```

Railway runs those three commands as its pre-deploy sequence before starting
the worker, and the Railway worker is the ONLY thing that applies migrations.
The Vercel API build does not touch the database.

That pre-deploy command is stored in the Railway worker service's settings, not
in this repo. Railway has deprecated config-as-code (`railway.json` /
`railway.toml`) in favour of Infrastructure as Code (`.railway/railway.ts`), and
refuses to read a committed `railway.json` at all. Do not add one back: it is
inert, and a stale copy is what let the worker crash-loop against an unmigrated
schema on 2026-08-31. To change the pre-deploy sequence, edit the service
setting (Railway dashboard, or `serviceInstanceUpdate` via `railway api`), and
keep `apps/worker/railway-config.test.ts` in sync so the scripts it invokes
cannot be renamed out from under it. Nothing in CI can detect that setting being
cleared, so verify it directly before trusting a deploy: see "Verifying the
service settings" and the 2026-08-31 incident record in
[docs/deployment/worker-railway.md](docs/deployment/worker-railway.md).
That sequence uses a shared PostgreSQL advisory lock, and the runner validates
the live migration journal as a contiguous prefix with matching SQL hashes
before applying anything new. It fails closed on missing, unknown, duplicate,
or tampered journal rows.

The current forward repair `0035_restore_copy_mirror_indexes` accepts only the
two reviewed historical `0032_new_moon_knight` hashes and restores the five
copy-mirror indexes with explicit `public` qualification. It is safe to retry
after an interrupted concurrent index operation. The migration and schema
verification commands share a bounded advisory lock, and `SKIP_DB_MIGRATE`
is no longer read by any build.

`db:generate` is schema-only and works without a database URL. `db:migrate`,
`db:push`, and `db:studio` refuse missing or pooled URLs. Use `db:push` only for
disposable local databases or explicit drift investigation; it is not the
normal production deployment mechanism.

Do not print, commit, or paste production database credentials.

For PRs that include DB changes, include a checklist item like:

- [ ] Production schema update: normally automatic. The Railway worker's
  pre-deploy sequence applies the journal on its next deploy, so do NOT run the
  migration by hand unless that deploy is blocked. To apply manually, point
  `DATABASE_URL_DIRECT` at the confirmed Supabase direct/session-mode port-5432
  endpoint and run `bun run db:validate`, `bun run db:migrate:production`, and
  `bun run db:verify-worker-schema`.
- [ ] If the change spans the API and the worker, **deploy the worker first.**
  The Vercel API build no longer applies or verifies migrations, so the API can
  otherwise deploy against a schema that has not been migrated yet.
- [ ] Verify the new table/columns exist in Supabase before enabling the feature in prod.
- [ ] Confirm the worker-required copy-mirror indexes pass
  `bun run db:verify-worker-schema`; never repair them by editing an applied
  migration or using `db:push`.

### Current Supabase Access Note

The connected Supabase account in this Codex workspace may not be the production Ready Set
Trade project. Confirm the project name/ref with the repo or deployment owner before applying
any migration through the Supabase connector.

## Lessons from the 2026-07 Audit (`docs/AUDIT-2026-07-02.md`)

### CI type-checking

- Fixed since the audit: every workspace now exposes a `check-types` script
  (delegating to its `typecheck`), so `turbo check-types` in CI covers all
  workspaces. Any new workspace must include a `check-types` script. It is
  still good practice to run the affected app's typecheck locally
  (e.g. `bun run --filter @trade-bot/api typecheck`) before pushing.
  See `docs/AUDIT-2026-07-02-STATUS.md` for the current status of all audit
  items.

### Broker order code rules (real-money paths)

- **Every Alpaca order-creating call must pass a deterministic
  `client_order_id`.** The Alpaca client wraps order POSTs in `withRetry`, so
  a lost HTTP response re-submits; without a client order id the broker
  places a duplicate order. Follow the copy-mirror pattern
  (`apps/api/src/lib/copy-mirror.ts`).
- **Once a broker call succeeds, never mark the order failed/`REJECTED`
  locally.** If a post-broker DB write throws, the order is still live at
  Alpaca; surface it for reconciliation (OrderSync) instead of overwriting
  state. Broker state is the source of truth.

### Test conventions

- Do not write tests that `readFileSync` a component's source and regex it,
  or that re-declare a copy of a schema "for testing". Import the real
  module and assert behavior; extract pure logic into a `lib/` module if the
  component is hard to test (see `smart-exit.ts` for the pattern).

### Config hygiene

- Do not add env vars to `turbo.json` `globalEnv` unless code actually reads
  them. The file still carries dead Polymarket-era vars; don't pattern-match
  new entries off those.

### God-component size rule (audit H7)

- When a component file exceeds roughly 500 lines of combined logic (hooks,
  handlers, derived state) plus JSX, stop adding to it and extract first.
  Extraction order: (1) pure math into a `lib/` module, (2) stateful logic
  into a named hook, (3) self-contained UI sections into their own component.
- Before extracting any large component, replace any `readFileSync`/regex
  source-string tests that cover it with behavioral tests. The source-string
  allowlist must shrink, never grow.
- Reference implementations: `use-trade-order-submission.ts`,
  `review-metrics.ts`, `review-dialog.tsx`, `use-mobile-nav.ts`,
  `terminal-selection-store.ts`.

### Responsive terminal shell (audit M3 / frontend runtime)

- The app page renders two terminal shells (mobile + desktop) in markup but
  must only mount one at a time. Use the hydration-safe `xl` viewport hook so
  the inactive shell is never rendered to the DOM. Never add polling, queries,
  or subscriptions to a shell that will be hidden on the current viewport.

### Query pagination and scan caps (audit H6 / M leaderboard)

- Every user-history and leaderboard query must call `.limit()` with a named
  constant. Do not add unbounded `SELECT * FROM ...` scans on the orders,
  signals, or copy-mirror tables.
- Signal-feed scans are capped at `XCALLER_SIGNAL_SCAN_CAP` (5,000 rows).
  Do not remove or bypass this cap.

### Input validation (audit M7)

- Every new tRPC procedure that accepts a stock/perp symbol must use
  `symbolSchema` (max 21 chars, charset-checked). Option expiration strings
  must use `optionExpirationSchema` (strict YYMMDD). Free-text notes fields
  must use `notesSchema` (max 2,000 chars). All three live in the shared
  validation module; do not inline duplicates.

### Production scripts guard (audit M2)

- Any script that reads or mutates production data must import
  `apps/api/scripts/lib/guard.ts` and require the `--yes-prod` flag.
- All email/user output from scripts must be masked. Never log raw email
  addresses or user IDs from production queries.

### CORS rules (audit M1)

- Localhost origins are assembled by `buildCorsOrigins`
  (`apps/api/src/lib/cors-origins.ts`). Never add `localhost` or
  `127.0.0.1` to the allowed-origins list unconditionally. They are
  included only when `NODE_ENV !== "production"`.

### Shared number/currency formatters (audit M16)

- All currency and compact-number display must go through the helpers in
  `apps/web-v2/src/lib/format.ts`: `formatUsd`, `formatCompactUsd`,
  `formatSignedNumber`. Do not add inline `toFixed`, `Intl.NumberFormat`,
  or `$${value}` string templates for user-facing numbers.
- There are exactly TWO sanctioned exceptions. Do not add a third without
  updating this list:
  1. The portfolio chart's axis-compact formatter.
  2. `apps/web-v2/src/components/perps/perp-format.ts`
     (`formatPerpPx`, `formatPerpUsd`, `formatPerpFundingPct`,
     `formatPerpChangePct`). Hyperliquid quotes prices as decimal strings
     across a huge dynamic range, from BTC in the tens of thousands to a
     1000x coin in fractions of a cent, and funding rates are routinely
     below 0.01%. The fixed 2-decimal helpers in `format.ts` collapse those
     to "$0.00" / "0.00%", so real values read as missing. These helpers
     scale precision to magnitude instead. Use them for every perps price,
     funding rate and 24h change; do not reimplement the scaling inline.

### Alpaca credential verification (audit settings)

- Before storing any user-supplied Alpaca API key pair, verify them against
  `GET /v2/account` using `apps/api/src/lib/alpaca-credential-check.ts`.
  Return distinct error messages for: rejected keys, Paper/Live environment
  mismatch, Alpaca unreachable, and missing fields. Never silently encrypt
  and store keys that fail the check.

### Social-publish helper (audit M12)

- Use `publishSocialTrade()` (`apps/api/src/lib/social-publish.ts`) for all
  social-feed posting. Do not copy-paste the four social-feed blocks inline
  in order or position routers. Use `getAlpacaClient()` to share credential
  guard logic across position procedures.
