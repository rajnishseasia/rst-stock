# Signa API integration notes

External signal/analysis provider at **getsigna.ai**. Their platform produces
multi-pillar "confluence" picks (trend + options flow + GEX + multi-agent
consensus + Wyckoff/Elliott stage analysis) plus per-symbol Action Cards. This
doc captures everything we currently know so we can layer it into Ready Set
Trade later — surface picks in the feed, route signals into Copy Trade, run
nightly scoring, etc.

> **Status:** investigation. We have a working API key and a verified live
> response. No code lives in `apps/*` yet — the only thing committed is the
> local pull script at `scripts/signa-todays-best.ts`.

---

## TL;DR — pulling today's best picks

```bash
SIGNA_API_KEY=cmts_xxxxxxxxxxxx \
  bun run scripts/signa-todays-best.ts
```

Tries `/api/v1/confluence/best-picks` first (the Best Trades board), and on
401 (plan-gated) automatically falls back to `/api/signals/run?scored=true`
and prints the top 10 unique tickers by composite_score plus AMD's
position-in-list.

**Heads up on entitlements.** The confluence/best-picks endpoint that powers
the in-app "Best Trades" view is plan-gated. With a Founding-Member API key
(no `confluence` / `best_picks` scope listed under `entitlements` in `/me`),
it returns `401 Unauthorized` regardless of bearer auth. The browser
dashboard auths via Supabase cookie, which behaves differently — that's why
the HAR shows AMD #1 by `confluence_score=56` while the script gets 401.

The fallback `/api/signals/run?scored=true` is fully accessible to a
Founding-Member key. AMD shows up there at **#13 of 56 unique tickers** with
composite_score=91 and 8-model bullish consensus — same underlying view of
the symbol, just a different scoring/ranking surface.

If we want true parity with the dashboard's Best Trades board, we need to:
1. Upgrade the API key's plan tier so the `confluence` scope is included, OR
2. Auth our server against Signa with the Supabase session cookie path
   (more brittle, not recommended for production).

---

## Base URL & auth

| | |
|---|---|
| **Base URL** | `https://app.getsigna.ai` |
| **API prefix** | `/api/v1` |
| **Auth** | `Authorization: Bearer <api_key>` |

Tokens look like `cmts_...`. Generated in Signa dashboard → API Keys. The
session-cookie path also works but is for in-app calls; we should always use
the bearer key for server-side / scripted access.

Their docs claim `app.getsigna.ai/api/v1` is the canonical host (despite a
separate `api.getsigna.ai` subdomain that's currently unrouted).

## Rate limits & quotas

- **Per-minute:** flat **60 req/min** per key, sliding window. Returns 429 with
  `Retry-After` on overage.
- **Daily quota:** depends on plan.

  | Plan | Daily | Hourly |
  |---|---|---|
  | Follower / Community | 100 | 10 |
  | Individual | 1,000 | 100 |
  | Individual ($49/mo) | 1,000 | 100 |
  | Professional ($149/mo) | 10,000 | 500 |
  | Team | 50,000 | 1,000 |
  | Enterprise | unlimited | unlimited |

- Every response returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset`, `X-RateLimit-Window`. On a 429 add `Retry-After`.
- `GET /api/v1/me` shows live usage (`calls_used_today`, `calls_remaining`).

## Standard response envelope

```json
{
  "ok": true,
  "symbol": "AAPL",
  "data": { … },
  "meta": { "source": "signa", "cached": false, "timestamp": "…Z" }
}
```

Errors:

```json
{ "ok": false, "error": "…", "code": "RATE_LIMIT_EXCEEDED", "retryAfter": 60 }
```

Common error codes: `INVALID_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_TIMEFRAME`,
`RATE_LIMIT_EXCEEDED`, `PLAN_REQUIRED`, `NO_DATA`, `PROVIDER_UNAVAILABLE`.

---

## Endpoints we care about

### 1. ⭐ `GET /api/v1/confluence/best-picks` — today's ranked board (gated)

The big one. Returns a small list of cross-pillar high-confluence picks for
today. This is what powers `app.getsigna.ai/dashboard/best-trades`.

**⚠️ Currently gated above Founding Member.** Bearer auth returns
`401 Unauthorized` even when `/me` confirms the key is valid. The dashboard
sees it via Supabase session cookie. Surface scopes for a Founding key are
`market_data`, `signals`, `analysis`, `options_flow`, `dark_pool`,
`broker_connect`, `sms_alerts`, `custom_agents` — no `confluence` /
`best_picks` entry. Use the `/api/signals/run` fallback below until plan is
upgraded.

**Request:** no parameters. Bearer token in header.

**Response (verified live, 2026-06-16):**

```json
{
  "ok": true,
  "source": "cache",
  "stable": true,
  "regenerated": false,
  "generated_at": "2026-06-16T06:50:05.407+00:00",
  "age_minutes": 24,
  "next_refresh_after_minutes": 6,
  "manual_refresh_rate_limited": false,
  "manual_refresh_available_in_minutes": 0,
  "picks": [
    {
      "id": "8b252746-…",
      "ticker": "AMD",
      "direction": "BULLISH",
      "confluence_score": 56,
      "tier": "B",
      "pillar_scores": { "gex": 69.1, "flow": 87.4, "plan": 60, "trend": 100, "agents": 73.8 },
      "trade_plan": {
        "entry": 547.26, "stop": 488.19, "target": 665.40,
        "risk_reward": 2, "source_signal": "BUY"
      },
      "evidence": { … per-pillar breakdown … },
      "explanation": "AMD ranks bullish with 56 confluence from TREND + FLOW + AGENTS.",
      "status": "waiting",
      "spot_price_at_generation": 511.57,
      "generated_at": "…",
      "invalidated_at": null
    },
    { … MU … }, { … ADI … }, { … KLAC … }
  ]
}
```

**The five evidence pillars** (each contributes a 0–100 score, a direction, a
freshness tag, and a structured `details` object):

| Pillar | What it measures | Detail fields |
|---|---|---|
| `gex` | Gamma squeeze / dealer positioning | `net_gex`, `key_strike`, `spot_price`, `distance_pct`, `squeeze_score`, `call_put_ratio`, `iv_rank` |
| `flow` | Options order flow imbalance | `event_count`, `bullish_premium`, `bearish_premium`, `total_premium` |
| `trend` | Multi-timeframe trend alignment | `daily`/`h4`/`h1`/`weekly` bias, `stage`, `rsi`, `alignment` (0–4), `conviction`, free-form `summary` w/ Wyckoff + Elliott labels |
| `agents` | Multi-model consensus | `grade`, `raw_score`, `capped_score`, `alert_tier`, `model_count`, `family_count`, `correlation_cap_multiplier`, free-form `reason` |
| `plan` | Tradeable plan present? | `entry`, `stop`, `target`, `risk_reward`, `current_price`, `status` (`waiting` / etc.), `source_signal` |

`freshness_status` per pillar: `fresh` / `stale` / etc. `supports_final: bool`
flags whether that pillar contributed to the final score.

**Top-level "stale" semantics:** the response is cached. `age_minutes` tells
you how old; `next_refresh_after_minutes` tells you when the server will
regenerate. We don't need to poll fast — a 5-min cadence is plenty.

### 2. `GET /api/v1/signal?sym={SYM}&tf=1d` — full Action Card

Per-symbol scored card. Includes both the live single-pass technicals (`data.*`
— RSI, MACD, EMAs, Bollinger, pivots, entry/stop/target, R:R, tier, score)
and the Signa nightly engine result (`signa.*` — grade A–F, conviction,
action ACCUMULATE/HOLD/etc., riskRating, alphaEvent, component scores).

If the nightly pipeline hasn't completed yet, `engine` is `null` and a
`engine_coverage` note tells you to fall back to `data.direction`.

### 3. `GET /api/v1/analysis?ticker={SYM}` — extended technical analysis

Same data as `/signal` plus an extra `actionCard` block, `sentiment` (bullish %,
bearish %, daysOfHistory), and `technicals.stochastic`, `volatilityRegime`,
`obv`, `pivotPoints`.

### 4. `GET /api/v1/enhanced-signal?sym={SYM}` — signal + news + prediction markets

Combines the Action Card with a `prediction_markets` block and `news` block
(when present). The `enhanced_score` block re-grades the symbol with those
adjustments factored in.

### 5. `POST /api/v1/scan` — bulk scanner

Body:

```json
{ "symbols": ["AAPL","NVDA",…], "tf": "1d", "minScore": 60, "tier": "HOT" }
```

Returns up to 20 symbols ranked by score. Useful for sweeping a watchlist.

> Note: `GET /api/v1/scan` is documented but returns `400 symbols parameter required`
> if you hit it without a body — use POST.

### 6. `GET /api/v1/screener?symbols=AAPL,TSLA`

Quick technical scan over a comma-separated list. Lighter than `/scan`,
GET-only.

### 7. `GET /api/v1/history/{SYM}?tf=1d&limit=200`

OHLCV candles. Timeframes: `1d` (default), `4h`, `1h`, `15m`, `1w`, `1M`. Max
`limit=500`.

### 8. `GET /api/v1/quote/{SYM}`

Real-time/delayed quote: `price`, `open`, `high`, `low`, `close`, `volume`,
`change`, `changePercent`, `timestamp`.

### 9. `GET /api/v1/signal-index` — nightly consensus board

Returns the full nightly pipeline output across the Signa universe (≈50
symbols on the day we tested). **Returns 503 with `error: "nightly_pipeline_pending"`
before the nightly job completes** (typically 18:00–22:00 ET).

### 10. `GET /api/v1/me` — account / quota

Returns plan, scopes, entitlements, and live API usage. Cheap, useful for
self-diagnostics in a script.

### 11. `GET /api/signals/feed` — raw signal stream

Not under `/v1`. Returns the firehose of individual model outputs (each
ticker × model emits a row with `signal: BUY/HOLD/SELL`, `confidence`,
`reason`, `model_id`, `model_name`, `category`, `metadata` with whatever the
agent is measuring — earnings quality, valuation, etc.). Use to back-fill
where a confluence pick's reasoning came from.

### 12. ⭐ `GET /api/signals/run?scored=true&limit=250` — scored signal run

The pragmatic substitute for `/confluence/best-picks` while the latter is
plan-gated. Returns up to 250 multi-agent-scored signals across the Signa
universe. **Accessible to Founding Member keys.**

Per-signal fields:

```
ticker            string
direction         "BULLISH" | "BEARISH"
alert_tier        1 | 2 | 3  (3 = strongest)
composite_score   0..100
confidence        0..1
model_count       int — how many models fired on this ticker
model_ids         string[] of agent identifiers (e.g. "minervini-trend-template",
                    "low-vol-factor", "fiftytwo-week-high", "weinstein-stage", …)
regime            "TRANSITIONAL" | …
regime_multiplier number
suggested_size_pct number
conflict_detected boolean
risks             string[]
reason            free-form natural-language summary
key_drivers       string[] — bullet points behind the call
grade             "A" | "B" | …
generated_at      ISO timestamp
```

Same ticker can appear multiple times (one row per model family). Dedupe by
ticker and keep the highest `composite_score` for a leaderboard.

### 13. `GET /api/market/quotes?symbols=SPY,QQQ,IWM,…`

Batch quote endpoint used by the Signa dashboard. Lighter than per-symbol
`/quote/{SYM}`.

## Endpoints that 404 today

Per their own docs, the following are documented but not exposed on the
public router:

- `GET /signals` (and `/signals/:symbol`)
- `GET /screener/:symbol` (use `/screener?symbols=:symbol`)
- `GET /news/market`

Likely under active development or pro-plan-gated.

---

## Tier & direction values

```
score 75–100  →  HOT     (strong)
score 55–74   →  WATCH   (developing)
score 40–54   →  NEUTRAL
score  0–39   →  SKIP

direction    LONG | SHORT | WAIT
bias         bullish | bearish | neutral
action       BUY | HOLD | SELL | ACCUMULATE | …
grade        A | B+ | B | C | D | F
```

`best-picks` uses its own letter tier (`A` / `B` / `C`) alongside
`confluence_score` 0–100.

---

## MCP server (Claude Desktop / Cursor)

Signa exposes an SSE-based MCP server at
`https://app.getsigna.ai/api/mcp/sse`. Auth is the same `Bearer cmts_…`.
Tools available: `get_signal`, `get_quote`, `scan_symbols`, `get_history`,
`get_analysis`. We could wire this into `.mcp.json` if we want Claude in this
repo to talk to Signa directly.

---

## What we could build on top

Rough ideas, not commitments. Each is a follow-up:

1. **Surface confluence picks in the dashboard.** Pull `best-picks` every ~5
   min on the worker and slot into a new "Signa Picks" column or as a source
   in the Copy Trade feed (alongside X signals + user trades + politicians-soon).
2. **Auto-tag X signals with Signa scoring.** For every X-signal symbol in
   our feed, fetch `/api/v1/signal?sym=` and badge the row with `tier`,
   `score`, and `data.direction` so the user can sanity-check the caller.
3. **Watchlist scanner.** Hook `/scan` (POST) onto the user's existing
   watchlist and surface a daily "best of your watchlist" panel.
4. **Trade-form prefill.** When the user clicks a Signa pick, pre-fill the
   trade form with the suggested `entry`, `stop`, `target`, R:R, and signed
   side. Same flow we already have for Copy Trade.
5. **MCP wiring.** Add the Signa MCP server to `.mcp.json` so a developer
   can ask "what's the best LONG setup right now from {watchlist}" inside
   Claude Code without leaving the repo.

## Engineering notes / gotchas

- **Treat `engine` as optional.** `/signal` will return `engine: null` until
  the nightly pipeline completes. Always fall back to `data.direction`.
- **`/signal-index` can 503.** Same reason — don't crash, retry after market
  close.
- **Score scales differ.** `confluence_score` (best-picks) is 0–100 but
  capped lower (top pick today was 56). `data.overallScore` from
  `/signal` is also 0–100 but can be very different ranges. Don't blindly
  reuse thresholds across endpoints.
- **`freshness_status: "stale"`** on pillars is expected for things like GEX
  and flow that update intraday — the pick is still valid, the pillar
  reading just isn't from the last few minutes.
- **No CORS / no auth in the HAR.** The dashboard call we observed sent
  neither `Authorization` nor `Cookie`. Either the endpoint is permissive,
  or the HAR was sanitized. Always send `Authorization: Bearer cmts_…` from
  server-side and don't rely on the dashboard's session.

---

## API key handling

The API key is **secret-ish**. Treat like a brokerage credential:

- Read from `SIGNA_API_KEY` env var in scripts (`scripts/signa-todays-best.ts`).
- Do **not** commit a real key to git.
- For production use, store in the same secret manager as `ALPACA_MASTER_*`
  (whatever we end up using for the worker).

To run the local probe with your key:

```bash
export SIGNA_API_KEY="cmts_xxxxxxxxxxxxxxxxxxxxxxxx"
bun run scripts/signa-todays-best.ts
```

Or one-shot:

```bash
SIGNA_API_KEY=cmts_xxx bun run scripts/signa-todays-best.ts
```
