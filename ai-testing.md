# AI Browser-Testing Playbook (Playwright)

How an AI agent (or a human with Playwright) tests Ready Set Trade end to end
in a real local browser, including placing small test buys. Written from a
real run on 2026-07-20; the Blockers section at the bottom records exactly
what stopped that run so the next one can succeed.

## Hard safety rules (read first)

1. **Never trade with live keys.** Before entering any Alpaca credential,
   check the key prefix WITHOUT printing the value:
   `grep -c '^ALPACA_TEST_KEY_ID=PK' apps/api/.env` (or wherever the key
   lives). `PK...` = paper, `AK...` = live. If it is not `PK`, STOP and ask
   the human. "Small test buys" on a live account is real money.
2. **Never print, log, or paste values from any `.env` file.** Reference
   variables by name; check prefixes with `grep -c`.
3. Keep test orders tiny: 1 share, on a cheap NYSE/NASDAQ-listed stock.
   Note: Alpaca does NOT support OTC, so true "penny stocks" (OTC) will not
   resolve; use listed sub-$5 tickers instead (examples at time of writing:
   OPEN, SNDL-class names; verify with the in-app symbol search).
4. The dev email/password auth path exists ONLY when the API runs with
   `NODE_ENV=development`. Never attempt it against a production URL.
5. This stack points at the SHARED Supabase database even in local dev.
   Creating one throwaway test user is acceptable for testing; do not seed
   fake trades/signals into shared tables.

## Prerequisites

- `bun install` at the repo root has been run.
- `apps/api/.env` has a WORKING `DATABASE_URL` (see Blockers), plus
  `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `NODE_ENV=development`.
- `apps/web-v2/.env.local` has `NEXT_PUBLIC_API_URL=http://localhost:4002`
  (the web app reads the API port from here; keep them in sync).
- Alpaca PAPER keys available as env vars for the run (never committed):
  `ALPACA_TEST_KEY_ID` (must start with `PK`) and `ALPACA_TEST_SECRET`.
- Playwright MCP tools (or `playwright` via CDP; see
  `.claude/skills/verify/SKILL.md` for the fallback recipe).

## 1. Start the stack

```bash
# API (port comes from apps/api/.env PORT, expected 4002)
cd apps/api && bun run dev &
# Web (pinned to 5100 in its dev script)
cd apps/web-v2 && bun run dev &
```

Verify before driving the browser:

```bash
curl -s http://localhost:4002/health        # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}' http://localhost:5100/   # 200
```

If `/health` is not ok, read the API process output; a `28P01` Postgres error
means the DB credential is bad and NOTHING auth-related will work.

## 2. Create + sign in a test user (dev only)

The UI only offers Google OAuth, which automation cannot complete. Use the
better-auth REST endpoints (enabled in development) instead.

Create the user once (idempotent-ish; a duplicate email errors, that is fine):

```bash
curl -s -X POST http://localhost:4002/api/auth/sign-up/email \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5100' \
  -d '{"email":"ai-tester@readysettrade.test","password":"<pick-one>","name":"AI Tester"}'
```

Sign in INSIDE the browser page context so the session cookie lands in the
browser (the API sets cookies for its own origin; CORS allows credentialed
localhost:5100 calls in dev):

1. `browser_navigate` to `http://localhost:5100/`.
2. `browser_evaluate`:
   ```js
   async () => {
     const res = await fetch("http://localhost:4002/api/auth/sign-in/email", {
       method: "POST",
       credentials: "include",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ email: "ai-tester@readysettrade.test", password: "<same>" }),
     });
     return res.status;
   }
   ```
3. Expect 200, then `browser_navigate` to `http://localhost:5100/app`.
   The terminal should render signed-in (no "Enter the Terminal" bounce).

## 3. Test Alpaca credential validation (Settings)

Navigate to `/settings`. This exercises the PR #118 verification feature.

Negative case first (MUST fail cleanly):
- Account Type: Paper. API Key ID: `PKGARBAGE123`. Secret Key: `wrong`.
- Click save. EXPECT an inline error containing "Alpaca rejected these API
  keys" and "Nothing was saved". If instead it saves, the validation
  regressed; file that as a bug.

Positive case (paper keys only, after the prefix check from the safety rules):
- Enter `ALPACA_TEST_KEY_ID` / `ALPACA_TEST_SECRET` by typing them into the
  form fields (type from env into the browser; do not echo them to logs).
- EXPECT "Credentials saved successfully!" and the account to appear in the
  saved-accounts list as Paper.

## 4. Trade ticket auto-plan checks (no order yet)

Back in `/app`, use the symbol search to open a cheap listed ticker (verify
price < $5 in the header; try OPEN first, else search for another).

Assert on the trade ticket (all shipped in PR #117):
- Max Risk ($) prefilled to about 1% of the account's portfolio value.
- Stop loss prefilled from LOD with the "Filled from LOD" breadcrumb.
- A take-profit row seeded at 0.7R with the `+0.7R` pill rendered selected
  (highlighted / aria-pressed=true).
- Trailing runner enabled, Trail % = 5 (unless a saved preference overrides).
- NO red validation error visible on first render.

Also worth a quick check: click an open position row later and confirm the
ticket symbol prefills (PR #83 behavior).

## 5. Place the small test buy

With the paper credential active and a sub-$5 listed symbol loaded:

1. Leave the seeded exit plan as-is (this tests the whole bracket path), or
   set quantity to 1 explicitly.
2. Click "Review buy + auto-exit", confirm in the review dialog that the
   $ risk figure is sane, then submit.
3. EXPECT a success toast and the order to appear in the Orders panel.

Market-hours note: outside regular hours (the 2026-07-20 run was a Sunday)
a market order is accepted by Alpaca paper and RESTS until the next open;
status shows accepted/new, not filled. That still validates the full path:
form -> API -> Alpaca -> orders panel. Optionally verify the worker attaches
exit legs after the fill on the next trading day.

Repeat once more on a second cheap ticker if a second data point is wanted.
Keep it to 1 share each.

## 6. Feed / misc smoke (fast)

- Signals feed renders without the amber "having trouble loading" degraded
  banner (that banner appearing means a source is erroring server-side).
- Copy Trade panel loads; no "Part of the feed failed to load" notice.
- Landing page `/` renders headline + CTA (see `.claude/skills/verify` for
  the word-split/nbsp assertion gotchas).

## 7. Cleanup

- Cancel any resting test orders from the Orders panel (or leave them to
  expire if `day` TIF).
- Do not delete the `ai-tester@readysettrade.test` user (reusable; deleting
  users via SQL on the shared DB is riskier than leaving it).
- Kill the two dev servers you started.

## Blockers hit on the 2026-07-20 run (fix these first)

1. **DB credential rejected**: the local API failed with Postgres `28P01`
   (`password authentication failed for user "postgres"`) against the
   `DATABASE_URL` in `apps/api/.env`. That credential appears stale or the
   URL needs the Supabase pooler user format. Until it is fixed, sign-up,
   sign-in, and everything behind auth 500s locally.
2. **No paper keys on the machine**: the only Alpaca keys in
   `apps/api/.env` are `ALPACA_MASTER_KEY/SECRET` with an `AK` (LIVE)
   prefix. Trading with them was refused. Provide `PK`-prefixed paper keys
   as `ALPACA_TEST_KEY_ID` / `ALPACA_TEST_SECRET` for the buy steps.
3. Stray process note: something else (a Next server) listens on :3001;
   the real API belongs on :4002 per `NEXT_PUBLIC_API_URL`. Do not assume
   the API is up just because :3001 answers.
