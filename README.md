# Trading Platform

A production stock trading platform with live Discord signal forwarding, Alpaca brokerage integration, and encrypted multi-user credential storage.

- **API Server**: Hono + tRPC (deploys to Vercel)
- **Background Worker**: persistent Discord/order-sync service (Railway)
- **Frontend**: Next.js 16 + React 19 + Tailwind CSS
- **Database**: PostgreSQL + Drizzle ORM
- **Cache**: Redis (Upstash)
- **Auth**: Better Auth + Google OAuth

## Project Structure

```
├── apps/
│   ├── api/              # Hono + tRPC API server
│   ├── worker/           # Discord polling + notifications + PNL image HTTP server
│   └── web-v2/           # Next.js frontend
├── packages/
│   ├── db/               # Drizzle ORM (schemas, repositories)
│   ├── alpaca/           # Alpaca brokerage client
│   ├── pnl-image/        # Shareable PNL card renderer (@napi-rs/canvas)
│   ├── utils/            # Shared utilities
│   ├── logger/           # Winston logging
│   ├── redis/            # Redis client
│   └── types/            # Shared TypeScript types
├── turbo.json            # Build orchestration
└── package.json          # Workspace root
```

## Environment Variables (Verified Against Source Code)

### API (`apps/api/.env`)

These are validated by `apps/api/src/config/index.ts`:

| Variable               | Required        | Notes                                                  |
| ---------------------- | --------------- | ------------------------------------------------------ |
| `DATABASE_URL`         | Optional in dev | Pooled connection string                               |
| `DATABASE_URL_POOLED`  | Optional in dev | Transaction pooler (Supabase port 6543)                |
| `REDIS_URL`            | Yes             | Defaults to `redis://localhost:6379`                   |
| `ENCRYPTION_KEY`       | Yes             | Min 32 chars. `openssl rand -hex 32`                   |
| `BETTER_AUTH_SECRET`   | Yes             | Min 32 chars. `openssl rand -hex 32`                   |
| `GOOGLE_CLIENT_ID`     | Yes             | From Google Cloud Console                              |
| `GOOGLE_CLIENT_SECRET` | Yes             | From Google Cloud Console                              |
| `TWITTER_CLIENT_ID`     | For X linking   | From the X Developer Portal                            |
| `TWITTER_CLIENT_SECRET` | For X linking   | From the X Developer Portal                            |
| `API_PUBLIC_URL`       | Optional        | Your API's public URL (for OAuth callbacks)            |
| `WEB_URL`              | Yes             | Frontend URL for CORS. Default `http://localhost:3000` |
| `PORT`                 | Optional        | Default `3001`                                         |
| `NODE_ENV`             | Optional        | `development` / `production` / `test`                  |
| `TRUSTED_ORIGINS`      | Optional        | Additional CORS origins                                |
| `WORKER_HTTP_URL`      | Optional        | Worker HTTP server URL for PNL images (e.g. `http://localhost:3002`). Unset = feature disabled |
| `WORKER_API_SECRET`    | Optional        | Shared secret for worker HTTP calls. Must match the worker's value |

### How to get Google OAuth Credentials

To enable Google sign-in, you need to create OAuth credentials in Google Cloud:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project or select an existing one.
3. Navigate to **APIs & Services > Credentials**.
4. Click **Create Credentials** and select **OAuth client ID**.
5. _Note: If prompted, configure the OAuth consent screen first (choose "External", fill in the app name and your email)._
6. For Application type, select **Web application**.
7. Name your OAuth client (e.g., "Trading Platform Auth").
8. Under **Authorized redirect URIs**, add:
   - For Local _(If you are running the project on your personal computer/PC)_: `http://localhost:3000/api/auth/callback/google`
   - For Production(Vercel and others): `https://<your-frontend-domain>.vercel.app/api/auth/callback/google` _(This must be your Frontend Vercel URL, NOT your API URL!)_
9. Click **Create**. You will be presented with your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Worker (`apps/worker/.env`)

These are read via `process.env` in `apps/worker/src/`:

| Variable              | Required | Notes                                 |
| --------------------- | -------- | ------------------------------------- |
| `DATABASE_URL_DIRECT` | Yes      | Direct (non-pooled) connection string |
| `REDIS_URL`           | Yes      | Same Redis instance as API            |
| `ENCRYPTION_KEY`      | Yes      | Must match API; decrypts broker credentials |
| `DISCORD_BOT_TOKEN`   | Yes      | For Discord channel polling           |
| `DISCORD_WEBHOOK_URL` | Optional | For trade notification embeds         |
| `WORKER_API_SECRET`   | Optional | Enables the PNL image HTTP server. Must match the API's value |
| `WORKER_HTTP_PORT`    | Optional | PNL image server port. Default `3002` |

### Frontend (`apps/web-v2/.env.local`)

| Variable              | Required | Notes                 |
| --------------------- | -------- | --------------------- |
| `NEXT_PUBLIC_API_URL` | Yes      | Your deployed API URL |

### Privy + Hyperliquid Production & Deposit Setup

The zero-extra-login perps wallet connects users to Hyperliquid L2 via Privy embedded wallet authentication.

#### Deposit Address & Funding Rules:
- **Location in App**: Switch venue to **Perps** -> navigate to **Settings** or the **Perps Rail Card**.
- **Deposit Network**: **Arbitrum One (Chain ID 42161)**.
- **Deposit Token**: Native **USDC** on Arbitrum.
- **Minimum Balance**: **$10 USDC** recommended to meet Hyperliquid minimum order size requirements.
- **Maintainer Handoff**: Maintainers should follow [the Privy custom-auth production checklist](docs/deployment/privy-production.md) before enabling perps for production users. Local tunnel URLs and local JWKS keys must not be copied into the production Privy app.

## Key Trading Features & Venue Awareness

- **Perpetual Futures (Hyperliquid)**: Real-time buying power calculation (`Free Collateral × Leverage`), preset sizing chips (`25%`, `50%`, `75%`, `Max`), margin mode indicators, and 3-card mobile account metrics (`STOCKS PORTFOLIO | PERPS BALANCE | TOTAL BALANCE`).
- **Equities (Alpaca)**: Market/limit order tickets, 2-card mobile account metrics (`STOCKS PORTFOLIO | TOTAL BALANCE`), and live chart execution markers.
- **Theme-Aware Chart Position Entry Lines**: Dynamic lightweight chart overlays that render locked entry price lines using brand green tokens across light/dark themes.

## Live Charts (Lightweight Charts + Alpaca)

The app uses [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0, free) with Alpaca as the data source, replacing the old TradingView delayed embed.

### How it works

- **Historical bars** — fetched via `trpc.quotes.getHistoricalBars` using the master Alpaca account (see env vars below)
- **Near-real-time** — latest snapshot polled every 15 seconds via `trpc.quotes.getChartQuote` using the master Alpaca account
- **Trade bubbles** — filled orders fetched from the DB via `trpc.charts.getChartAnnotations` and rendered as positioned HTML overlays using Lightweight Charts' coordinate APIs (`timeToCoordinate` / `priceToCoordinate`)
- **Data feed** — determined by the master account type (IEX for paper, SIP for live)

Chart market data does **not** use the individual user's linked Alpaca credentials. All users share the master account's data feed.

### Required environment variables (API server)

Add these to `apps/api/.env` (and to your production environment):

```env
# Master Alpaca account for chart market data (shared across all users)
# Get your key/secret from https://alpaca.markets → Paper Trading or Live Trading → API Keys
ALPACA_MASTER_KEY=your_alpaca_key_id
ALPACA_MASTER_SECRET=your_alpaca_secret_key

# Optional — controls whether the master account uses the IEX or SIP data feed.
# "true"  (default) → paper account → IEX feed, free, real-time for S&P 500 names.
# "false"           → live account  → SIP feed, requires Algo Trader Plus ($99/mo).
ALPACA_MASTER_PAPER=true
```

The master account can be a free **paper trading** account (IEX feed, real-time for S&P 500 names) or a live account with an Algo Trader Plus subscription (SIP feed, full market coverage).

### Data feed: IEX vs SIP

| Feed | Cost | Coverage |
|------|------|----------|
| IEX (paper master account) | Free | Real-time, ~2–5% of market volume. Works well for S&P 500 names. |
| SIP (live master account + Algo Trader Plus) | $99/month | 100% of market volume. Required for accurate small/mid-cap data. |

### TODO: Real-time WebSocket streaming (needs persistent server)

Currently the chart polls for new prices every 15 seconds via `trpc.quotes.getChartQuote` (master credentials). This is good enough for most use cases, but true tick-by-tick updates require a long-running server (Railway, Render, Fly.io) because Vercel serverless functions close after ~60 s.

When the API is moved off Vercel, upgrade like this:

1. **Add a SSE proxy endpoint** `GET /api/market-stream?symbol=AAPL&credentialId=<uuid>` to `apps/api/src/index.ts`:
   - Auth-gate via session cookie (same pattern as `/api/chat/stream`)
   - Decrypt the user's Alpaca credentials with `getDecryptedCredentials`
   - Open `alpaca.data_stream_v2`, subscribe with `subscribeForUpdatedBars([symbol])` and `subscribeForBars([symbol])`
   - Forward each `onStockUpdatedBar` / `onStockBar` event as `data: {"t","o","h","l","c","v"}\n\n`
   - Send a `: ping\n\n` heartbeat every 20 s; disconnect the WebSocket on request abort

2. **Connect the frontend** in `LiveChart`:
   - Open `new EventSource(url, { withCredentials: true })`
   - On each message: align `bar.t` to the current timeframe period (`Math.floor(bar.t / periodSec) * periodSec`), keep the period's open from history, update high/low/close incrementally, call `series.update(bar)`
   - Show a "LIVE" badge when `es.onopen` fires; fall back to 15 s polling on `es.onerror`

### TODO: Apply for TradingView Advanced Charts (optional upgrade)

If you want the full TradingView indicator suite (MACD, RSI, drawing tools, multi-pane), apply for the free Advanced Charts self-hosted library:
- Apply at https://www.tradingview.com/advanced-charts/
- Plug Alpaca's data feed into their JS Datafeed API instead of Lightweight Charts
- The bubble overlay architecture works with both libraries since it uses the same coordinate APIs

---

## Share PNL Images

Every open position ("Share P&L" in the expanded row) and every closed order
with realized P&L (share icon) can generate a shareable 1536x1024 card image
with preview, "Hide $ size", download, and copy-to-clipboard.

Rendering uses native canvas, which can't run on Vercel, so the worker hosts
a small secret-protected HTTP server that the API proxies to. The feature is
**disabled until env vars are set** — see [docs/pnl-image.md](./docs/pnl-image.md)
for the after-pull dev checklist, architecture, and production deployment.

**Just pulled this change?** Run `bun install`, build the renderer
(`bun --filter @trade-bot/pnl-image build` or a full `bun run build`), then
set `WORKER_API_SECRET` (worker + API) and `WORKER_HTTP_URL` (API) per the
doc above. No DB migrations.

## Deployment: Background Worker on Railway

Railway is the repository's single supported production path for the persistent
worker. Its build, start, and pre-deploy commands live in the Railway service's
own settings (Railway has deprecated committed `railway.json` config); the complete
service setup, environment contract, and maintainer checklist are in
[docs/deployment/worker-railway.md](./docs/deployment/worker-railway.md).

---

> **Everything else** (other deployment steps, dev commands, onboarding guide, VPS setup) is in [readme-other.md](./readme-other.md).

## Database Migrations

Use Drizzle migrations for every database schema change. Do not manually add columns in the database UI and leave them untracked, because other developers and deployed environments will not get those changes.

When adding or changing columns, tell the AI to:

1. Edit the schema files in `packages/db/src/schema/`.
2. From the repository root, run `bun run db:generate`.
3. Review the generated SQL in `packages/db/migrations/`.
4. Commit the schema change, generated migration SQL, and `packages/db/migrations/meta/` files together.
5. Run `bun run db:validate` to verify the journal, SQL files, and snapshot chain.
6. Apply migrations locally with `bun run db:migrate`.

`db:generate` is schema-only and does not require database credentials.
`db:migrate`, `db:push`, and `db:studio` require `DATABASE_URL_DIRECT`; their
preflight rejects Supabase pooler/PgBouncer endpoints. Local commands load
`apps/worker/.env` when present, while CI/production can inject the variable.

For production, use `db:migrate:production` with an explicitly injected
`DATABASE_URL_DIRECT`; it intentionally does not load a local dotenv file. The
Railway worker pre-deploy hook runs `db:validate`, `db:migrate:production`, and
`db:verify-worker-schema` in that order, and a failed step prevents the worker
from starting. The Vercel API build does not apply or verify migrations and does
not touch the database. If a change spans the API and worker, deploy the worker
first so its pre-deploy migration completes before the API starts using the new
schema.

`db:migrate` uses the committed forward runner locally. On a clean PostgreSQL database
it commits the migration batch ending at `0015_overrated_franklin_richards`
before applying `0025_easy_ezekiel` and later migrations, because the latter
uses the `PERP` enum value introduced by the former. The runner preserves the
existing journal and SQL checksums. In production, the Railway pre-deploy
sequence runs `db:validate`, `db:migrate:production`, and
`db:verify-worker-schema` to completion before the worker starts. Run that
same sequence manually when recovering or validating a production deployment.

Before finding pending migrations, the runner validates that the database
journal is a contiguous prefix of the committed journal and that every
recorded SQL hash matches the checked-in migration. It fails closed on
missing, unknown, duplicated, or tampered journal rows instead of silently
treating a later timestamp as sufficient.

The forward repair migration `0035_restore_copy_mirror_indexes` handles
production databases that journaled either of the two reviewed historical
`0032_new_moon_knight` SQL hashes. It restores the five copy-mirror indexes
with explicit `public` qualification and journals only after all concurrent
index operations succeed. The migration runner and worker-schema verifier
share a bounded PostgreSQL advisory lock, so concurrent deploys cannot verify
a partially repaired schema. No Vercel build applies migrations or reads a
`SKIP_DB_MIGRATE` escape hatch; the Railway pre-deploy sequence is the sole
production migration path.

Committed migrations are the deployment contract. `db:push` is for disposable
local development and drift investigation only; do not use it as the normal
production rollout path.

Before running `db:generate`, pull the latest branch changes so your migration is created on top of the migration files other developers already committed. If two people create migrations at the same time, rebase or merge first, then rerun `bun run db:generate` so the migration history stays in order (or just delete your changes in the migrations folder, then run `bun run db:generate` again, after pulling their changes)
