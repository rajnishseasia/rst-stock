# Other Notes & Unverified Docs

This file contains documentation that has NOT been independently tested. Use at your own risk.

---

## Quick Start (Not Tested)


```bash
# 1. Install dependencies
bun install


# 2. Copy environment files
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
cp apps/web-v2/.env.example apps/web-v2/.env.local

# 3. Set up your database
bun db:push

# 4. Start development
bun dev
```

---

## Development Commands

```bash
# Start all apps in development mode
bun dev

# Start individual apps
bun dev:web          # Frontend only (port 3000)
bun dev:server       # API only (port 3001)

# Database
bun db:generate      # Generate migrations from schema changes
bun db:validate      # Validate journal, SQL, and snapshot history
bun db:migrate       # Apply committed migrations to the local database
bun db:studio        # Open Drizzle Studio (GUI)

# Type checking
bun check-types      # Check all packages

# Building
bun build            # Build all apps
```

---

## Vercel Deployment Instructions (Verified)

These instructions include specific dashboard fixes to bypass known build errors.

### Phase 1: Deploying the API Server (Backend)

The API is a Hono + tRPC application. Deploy this first to get the URL needed for the frontend.

1. Connect your GitHub repository to Vercel and create a new project.
2. In the "Build and Output Settings" configure exactly:
   - **Root Directory**: `apps/api`
   - **Framework Preset**: `Hono`
   - **Install Command**: `cd ../.. && bun install --frozen-lockfile`
   - **Build Command**: `cd ../.. && bun run build --filter=@trade-bot/api`
   - **Output Directory**: *(Leave completely blank to prevent "public directory" errors)*
3. **Environment Variables Required**:
   - `API_DEPLOY=true`
   - `DATABASE_URL` (Your pooled connection string)
   - `REDIS_URL`
   - `GOOGLE_CLIENT_ID` (See main README for how to get this)
   - `GOOGLE_CLIENT_SECRET` (See main README for how to get this)
   - `BETTER_AUTH_SECRET` (Generate with this command on terminal `openssl rand -hex 32`)
   - `API_PUBLIC_URL` (leave blank for now, this will be the url you get after deploying the API Server)
   - `ENCRYPTION_KEY` (Generate with this command on terminal`openssl rand -hex 32`)
   - `WEB_URL` (Leave blank for now, this will be the url you get after deploying the frontend on vercel)
4. Click **Deploy**. After deployment, copy the API URL.

### Phase 2: Deploying the Frontend Web App

1. Connect your GitHub repository to Vercel and create a second project.
2. In the "Build and Output Settings" configure exactly:
   - **Root Directory**: `apps/web-v2`
   - **Framework Preset**: `Next.js`
   - **Build Command**: *(Leave default / No override needed)*
3. **Environment Variables Required**:
   - `NEXT_PUBLIC_API_URL` (Paste your deployed API Server URL from Phase 1, that is the apps/api project deployed on vercel)
4. Click **Deploy**. After deployment, copy the Frontend URL.
5. **IMPORTANT**: Take this newly generated Frontend URL, add `/api/auth/callback/google` to the end of it, and save it in your Google Cloud Console as an **Authorized redirect URI**. *(See "How to get Google OAuth Credentials and how to add this url in the list of Authorized redirect URIs" in the main `README.md` for exact instructions).*

### Phase 3: Deploying the Background Worker (Railway)

Use the single supported worker procedure in
[docs/deployment/worker-railway.md](./docs/deployment/worker-railway.md). Do not
create a second worker service from the web/API deployment or run multiple
copies without first reviewing poller concurrency and order idempotency.

### Phase 4: Final Link-Up
To ensure CORS and Authentication work, you must fill in the blank environment variables you left earlier after successful deployments:
1. Go to your API Project in Vercel.
2. In Settings > Environment Variables, add/update the previously blank variables:
   - `WEB_URL` = (Your finished Frontend URL(the vercel url created for this project) from Phase 2)
   - `API_PUBLIC_URL` = (Your finished API URL(the vercel url created for this project) from Phase 1)
3. Redeploy the API project to apply these changes.

---

## User Onboarding & Testing Guide

### Step 1: Create an Alpaca Paper Trading Account

1. Go to [alpaca.markets](https://alpaca.markets) and sign up with just an email.
2. Once logged in, make sure you are in **Paper Trading** mode.
3. Find **"Your API Keys"** and click **"Generate New Key"**.

### Step 2: Sign In & Connect Your Alpaca Account

1. Open the app and sign in with your Google account.
2. Navigate to **Settings** → "Add Broker Account" form:
   - **Broker**: Alpaca
   - **Account ID**: Your Alpaca paper account ID
   - **Account Type**: Simulation
   - **API Key ID / Secret Key**: Your Alpaca keys
   - **Base URL**: Leave empty
3. Click **Save Credentials**.

### Step 3: Quick Functional Tests

- **View a Stock Quote**: Type **AAPL** into the trade form → live price badge appears.
- **Place a Market Order**: AAPL, Market, Long, Qty 1 → Submit.
- **One-Click Exit Plan (Smart Exit)**: Equities default to the "Buy + Auto-Exits (OCO)"
  order type with an auto-filled **Exit plan** — stop = Low/High of Day, quantity sized from
  your last Max $ Risk, a 0.4R take-profit on half, and a trailing stop on the rest. Pick a
  symbol (or click a signal), review, and Submit. The take-profit + trailing stop attach to
  the position automatically once the entry fills (a trailing sell can only sit against held
  shares). Toggle the trailing runner off for plain fixed-TP brackets, or check "Trail the
  whole position" to let it all ride the trailing stop.
- **Check Positions & Orders**: Verify on dashboard.
- **View Live Signals**: Discord-forwarded signals appear in the feed.

> Paper trading orders only fill during US market hours (9:30 AM – 4:00 PM ET, Mon–Fri).

> **Exit-plan attachment** is handled by the worker's `OrderSyncPoller` (polls every ~30s):
> when an entry order carrying a pending exit plan fills, the poller places the OCO
> take-profit + trailing-stop legs against the new position. So exits appear shortly after the
> entry fills, not at submit time.

---

