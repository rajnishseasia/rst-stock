# Maintainer notes: production environment for trading, perps and copy trading

The complete set of environment variables that decide whether trading, perps and
copy trading actually run, and the value each one needs for a **fully enabled
production deployment**. Nothing here is a placeholder and nothing is set to a
testing value: every entry is what production should hold to have the feature
working, not gated.

Written because the worker's copy of these flags is the only one that decides
anything, and nothing else can see it. `copyTrade.mirrorStatus` now reports the
flags as the **API** process holds them, and the copy-trade UI renders that, but
the API is a separate deployment: what it does not carry it reports as
`unknown` rather than "off", and what it does carry is its own copy, which
nothing verifies against the worker. So this file and the worker's deployment
console remain the only authoritative places.

## Where each variable lives

| Service | Platform | Reads |
|---|---|---|
| `@trade-bot/worker` | Railway | every flag in this document |
| `apps/api` | Vercel | database, auth, Privy, Alpaca master, Hyperliquid builder. Optional `COPY_TRADE_AUTOMIRROR_*` copies are read for `mirrorStatus` **status only**, never execution |
| `apps/web-v2` | Vercel | none of these |

Setting a copy-mirror flag on Vercel has no effect on execution. API-side copies
are status-only inputs to `copyTrade.mirrorStatus`; they must never be treated as
worker configuration. The execution flags must be on the worker.

### What the API says when it carries a subset

Mirroring copies of these variables onto the API is optional, and mirroring
**some** of them is expected. `copyTrade.mirrorStatus` therefore answers one
variable at a time (`resolveMirrorStatus`, `apps/api/src/lib/copy-mirror.ts`):

- **Each field is read only from its own variable.** Set on the API, the field
  carries that value. Not set, the field is `null`, meaning "this deployment was
  never told". A declared-but-empty value (`""`) counts as not set.
- **`null` is never rendered as off.** The UI shows an "Auto-mirroring status:
  unknown" note. It does not by itself turn the worker off, but destination-
  specific arming requirements still apply (a Hyperliquid follow also needs a
  valid loaded global copy leverage cap). Only an explicit
  `COPY_TRADE_AUTOMIRROR_ENABLED` that is not `true` produces "Auto-mirroring is
  turned off on this deployment", which does block arming.
- **One mirrored variable says nothing about the others.** Copying only
  `COPY_TRADE_AUTOMIRROR_DAILY_CAP` reports that cap and leaves the master
  switch, the live opt-in, the perps flags and the other caps `unknown`. It does
  not turn them into a confident `false`.
- **`visibility` tracks the master switch alone.** It is `visible` only when
  `COPY_TRADE_AUTOMIRROR_ENABLED` is set on the API, whatever else is present.
- **An unset cap is reported as `unknown`, not as its default.** The compiled-in
  fallbacks (daily cap 20 and per-order $1,000) travel separately in `defaults`,
  and the UI labels them as built-in defaults rather than as this deployment's
  configuration. `MirrorStatus.defaults` does not claim a leverage default;
  leverage is a persisted user setting and must not be inferred from API env.
- **`network` follows `HYPERLIQUID_NETWORK`,** and is `null` unless that is
  `mainnet`, or `testnet` with `HYPERLIQUID_ALLOW_TESTNET=true`.

So: to have the UI state the deployment's real posture, mirror
`COPY_TRADE_AUTOMIRROR_ENABLED` onto the API at minimum, and mirror it with the
same value the worker has. Mirroring a variable whose value differs from the
worker's is worse than not mirroring it, because the API reports its own copy
with no way to detect the disagreement. Everything left off reads as unknown,
which is the honest answer and is never a lie about the worker.

To read the current state:

```bash
railway variables --service <worker-service> --environment production --kv | grep -E '^(COPY_TRADE_AUTOMIRROR|HYPERLIQUID_|PASTE_TRADE|EXTERNAL_FILL)'
```

That output also contains credentials, so filter it rather than pasting it whole.

## The two venues are not symmetric

Worth stating before the tables, because the flag names imply a symmetry that
does not exist:

- **Alpaca is stocks, and has paper and live.** Paper is a real product mode, and
  `ALLOW_LIVE` is what moves a follower from one to the other.
- **Hyperliquid perps are always mainnet and always real funds.** There is no
  paper perps mode in this product. Hyperliquid testnet exists in the code as the
  paper equivalent, but production never runs it.

The consequence is that `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE` and
`COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET` are not "extra risk" opt-ins for
perps. They are load-bearing: with either one unset, perps refuse every order,
because every perp order is a real mainnet order. For stocks, `ALLOW_LIVE`
genuinely is optional and the feature still works in paper without it.

## Copy trading: the gating flags

Every boolean is an **exact string match on `"true"`**. Not `"TRUE"`, not `"1"`,
not `"yes"`. A typo fails to the OFF side and is announced only at info level, so
an operator who believes they enabled something gets no error. Two variables
invert this and are marked.

| Variable | Set to | Effect | Read at |
|---|---|---|---|
| `COPY_TRADE_AUTOMIRROR_ENABLED` | `true` | Master switch. While unset the poller schedules nothing and reads no rows, and every other flag here is irrelevant. | `copy-mirror.ts:463` |
| `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE` | `true` | The real-money gate for BOTH venues. For Alpaca it allows LIVE accounts as opposed to paper. For perps it is mandatory, not optional: perps are mainnet only in this product, so unset means every perp mirror is refused. | `copy-mirror.ts:468`, `copy-mirror-perp-preflight.ts:167` |
| `COPY_TRADE_AUTOMIRROR_PERPS_ENABLED` | `true` | Allows perp mirrors. Unset leaves equity mirroring running and perps refused. | `copy-mirror-perp-sync-gate.ts:41` |
| `COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET` | `true` | Mandatory for perps. It gates mainnet specifically, and perps only ever run on mainnet here, so unset means perps do not trade at all. | `copy-mirror.ts:474`, `copy-mirror-perp-preflight.ts:157` |
| `COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS` | `1000` | Deployment-wide emergency per-order ceiling. This is also the default. It may only reduce a follow's saved sizing request; it is not a wallet sizing setting. | `copy-mirror.ts:692` |
| `COPY_TRADE_AUTOMIRROR_DAILY_CAP` | `20` | Deployment-wide mirrored-orders-per-follower-per-day emergency ceiling. Also the default. It does not choose a follower's order size or leverage. Reduce-only closes are exempt on purpose: a cap must never stop someone exiting. | `copy-mirror.ts:691` |
| `COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS` | leave unset | How stale a perp OPEN may be before it is dropped. Defaults to 15 minutes, which is the intended value. | `copy-mirror-consent.ts` |
| `COPY_TRADE_AUTOMIRROR_EQUITY_MAX_INTENT_AGE_MS` | leave unset | The same bound for a stock or option OPEN, deliberately a separate variable so widening it for a Hyperliquid outage does not also widen it for equities. Defaults to 15 minutes. Closes are exempt on both venues. | `copy-mirror-consent.ts` |

## Hyperliquid perp sizing authority

The follower's saved Mirror Settings are the product authority for a copied
Hyperliquid perp OPEN:

- `sizing_mode` plus `sizing_value` on the follow chooses requested notional.
- the follower's persisted global automatic-perps leverage maximum, an optional
  lower per-follow maximum, the source leverage and the venue maximum determine
  effective leverage; no deployment variable chooses it.
- optional stop-loss and take-profit values are persisted per follow. Both null
  means no automatic protection is attached.

The **$10.55 order ceiling and one-entry-per-UTC-day limit used during the funded
local proof were test configuration only**. They are not compiled-in product
rules and must not be described or deployed as wallet policy. The generic
deployment caps above remain emergency ceilings: they can reduce/skip a request,
but they do not replace the follower's saved sizing or leverage settings.

Venue constraints remain fixed because the venue enforces them: copied opens
must meet Hyperliquid's $10 minimum notional, asset precision and live asset
maximum leverage. Reduce-only closes remain exempt from entry-count/notional
minimum policy where required so a safety control cannot prevent an exit.

## Hyperliquid

| Variable | Set to | Effect |
|---|---|---|
| `HYPERLIQUID_NETWORK` | `mainnet` | Always `mainnet` in production. Perps are a real-money product here; there is no paper mode for them. Perp mirroring refuses while this is unset rather than guessing. |
| `HYPERLIQUID_SYNC_ENABLED` | leave unset normally; `true` with wallet-copy | **Inverted for reconciliation.** The reconciler runs by default and only the exact string `"false"` stops it. It is read-only, and off is the broken state: it is the only writer of `orders.executed_size_decimal` for perps, and percent or dollar sized closes size themselves from that column. Setting it to `false` also blocks perp mirroring. The separately gated wallet-copy source watcher requires explicit `true` as deployment acknowledgement. |
| `HL_WALLET_COPY_ENABLED` | `true` only after migration `0039` and gate review | Enables read-only scanning of followed Hyperliquid wallets. It only stages immutable source candidates; the shared durable mirror engine remains the sole sizing/signing/submission path. It is inert unless the master mirror, perps, sync, explicit network and applicable mainnet/testnet gates all pass. |
| `COPY_MIRROR_POSITION_FAILSAFE_ENABLED` | `true` after migration `0044` | Runs the in-worker Hyperliquid mirrored-position audit immediately at startup and every three minutes. With the execution gate off, it records and logs source-flat exposures but cannot stage a close. |
| `COPY_MIRROR_POSITION_FAILSAFE_EXECUTE` | `true` only after reviewing dry-run output | Allows a source-flat exposure confirmed by two checks at least two minutes apart to enter the existing durable reduce-only mirror pipeline. Omitted or any value other than exact `true` is report-only. |
| `COPY_MIRROR_POSITION_FAILSAFE_INTERVAL_MS` | `180000` | Optional interval override. Values below 60000 are rejected in favor of the three-minute default. |
| `HL_WALLET_COPY_POLL_MS` | `15000` | Source-fill polling interval in milliseconds. This changes discovery latency only; it does not alter user sizing, leverage, SL/TP or deployment emergency ceilings. |
| `HYPERLIQUID_ALLOW_TESTNET` | leave unset | Only meaningful when `HYPERLIQUID_NETWORK=testnet`, which production never is. Leave it out. |
| `HL_BUILDER_ADDRESS` | the builder address | Builder-code attribution on Hyperliquid orders. |
| `HL_BUILDER_FEE_BPS` | the agreed bps | Builder fee. Must match what the builder address is approved for at the venue. |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` | the production Privy values | Server-signed perp wallets. Perps cannot trade without all three. |

## Alpaca

| Variable | Set to | Effect |
|---|---|---|
| `ALPACA_MASTER_KEY`, `ALPACA_MASTER_SECRET` | the production master credentials | Market data and the master account. |
| `ALPACA_MASTER_PAPER` | `false` | **Inverted.** Anything other than the exact string `"false"` means paper. Leaving it unset points the master account at paper data. Stocks are the only side of the product with a paper mode at all. |

Per-user trading credentials are not environment variables. They are encrypted
per user in the database, so a follower with no linked Alpaca account cannot be
mirrored to regardless of what is set here.

## Signal sources that feed copy trading

Copy trading mirrors two kinds of source. Leaving these off does not disable copy
trading, it silently narrows what there is to copy.

| Variable | Set to | Effect |
|---|---|---|
| `PASTE_TRADE_POLLER_ENABLED` | `true` | Ingests paste.trade signals. Unset means those never become mirror candidates. |
| `PASTE_TRADE_BASE_URL` | the production endpoint | Where the poller reads from. |
| `EXTERNAL_FILL_DETECT_ENABLED` | `true` | Detects fills placed outside the app, so a followed trader's manual trades are visible to the mirror. |
| `HYPERLIQUID_EXTERNAL_FILL_ENABLED` | `true` | Detects Hyperliquid fills placed outside the app, so a stop-loss attached in HL's own UI raises an alert instead of being found by opening the venue. Read-only at the venue and insert-only locally. External closes enter social/copy-mirror fan-out so followers can exit; external opens remain private. Ships inert; enable after a testnet cycle. |
| `HYPERLIQUID_EXTERNAL_FILL_POLL_MS` | `15000` | Interval between small, rotating Hyperliquid external-fill batches. The default smooths reads across the rolling REST window instead of scanning every account in one burst. |
| `HYPERLIQUID_EXTERNAL_FILL_USERS_PER_CYCLE` | `5` | Hyperliquid credentials scanned per rotating batch. Bounded to `1..25`; the default scans 20 accounts per minute while reserving REST capacity for live copy orders. |
| `HYPERLIQUID_EXTERNAL_FILL_BACKFILL_MS` | `0` | How far back the FIRST scan of an account reaches. `0` means "start from now", so switching the poller on cannot spray an account's trade history as alerts. Capped at 24h. |
| `DISCORD_BOT_TOKEN` | the production token | Discord signal ingestion. |
| `SIGNA_API_KEY` | the production key | X / signal provider ingestion. |

## Infrastructure the trading paths require

| Variable | Set to |
|---|---|
| `DATABASE_URL_DIRECT` | the Supabase **direct** URL, port 5432. Migrations and the worker use it. Never the pooler on 6543: DDL over PgBouncer is unsupported |
| `DATABASE_URL` or `DATABASE_URL_POOLED` | the pooled URL for API runtime |
| `WORKER_API_SECRET` | shared secret between API and worker |
| `WORKER_HTTP_URL`, `WORKER_HTTP_PORT` | worker HTTP surface |
| `DISCORD_WEBHOOK_URL` | order notifications. Unset means fills notify nowhere |
| `WORKER_ERROR_ALERT_WEBHOOK_URL` | the >20-errors-per-hour alert. Unset means it fires into nothing |

## If perps are live: finding positions nothing will close

A perp mirror's `client_order_id` is `copymirror:<followerUserId>:<sourceItemId>`,
and the source id says whether an exit will ever be produced:

- `user:<id>` came from a copied TRADER. When they close, that close mirrors as
  an exit. These are fine.
- `x_signal:<id>` came from a SIGNAL. Nothing in the system will ever close it.
  The follower has to close it by hand, and is not told that.

So the exposure that matters can be listed directly:

```sql
SELECT user_id, symbol, direction, status, executed_size_decimal, leverage,
       copy_source_label, created_at
FROM orders
WHERE venue = 'hyperliquid'
  AND asset_type = 'PERP'
  AND client_order_id LIKE '%:x_signal:%'   -- signal sourced
  AND reduce_only IS NOT TRUE               -- opens, not exits
  AND status IN ('SUBMITTED', 'PARTIAL', 'FILLED')
ORDER BY created_at DESC;
```

And the split across both source types, to see at a glance whether any
signal-sourced perp has ever been placed:

```sql
SELECT CASE WHEN client_order_id LIKE '%:x_signal:%' THEN 'signal (no exit)'
            WHEN client_order_id LIKE '%:user:%'     THEN 'copied trader'
            ELSE 'other' END AS source_type,
       count(*) AS orders,
       count(*) FILTER (WHERE reduce_only IS TRUE) AS closes,
       max(created_at) AS last_seen
FROM orders
WHERE venue = 'hyperliquid' AND asset_type = 'PERP'
  AND client_order_id LIKE 'copymirror:%'
GROUP BY 1;
```

If the signal row returns zero, the gap is theoretical so far and closing it is
planned work rather than an incident. If it returns rows, those followers are
holding leveraged positions the product will not exit for them.

## Has the equity mirror ever placed an order?

Ask this before believing copy trading works.

Every guarantee about the equity mirror in this repo is unit level. Perps at
least have `docs/deployment/perps-auto-mirror-testnet-checklist.md`, which opens
by saying CI passing proves none of it. The equity path has no equivalent
document and no recorded run, so the honest position is that nothing here shows
it has ever placed an order against a real broker.

That is not for want of instrumentation. `apps/worker/src/services/copy-mirror.ts`
logs `[copy-mirror] PLACED mirror order` on every equity success. Nobody has
looked. These two queries look.

An equity mirror order carries the same `copymirror:<followerUserId>:<sourceItemId>`
client id as a perp one, and is told apart by venue and asset type:

```sql
SELECT count(*) AS mirror_orders,
       count(*) FILTER (WHERE o.status = 'FILLED')                  AS filled,
       count(*) FILTER (WHERE o.status = 'REJECTED')                AS rejected,
       count(*) FILTER (WHERE c.account_type = 'LIVE')              AS live_account,
       count(*) FILTER (WHERE c.account_type IN ('PAPER', 'SIM'))   AS paper_account,
       min(o.created_at) AS first_seen,
       max(o.created_at) AS last_seen
FROM orders o
LEFT JOIN user_api_credentials c ON c.id = o.broker_credential_id
WHERE o.client_order_id LIKE 'copymirror:%'
  AND o.asset_type IN ('EQUITY', 'OPTION')
  AND (o.venue = 'alpaca' OR o.venue IS NULL);
```

Paper and live are not columns on `orders`. They come from the credential the
order was routed through (`user_api_credentials.account_type`, which is
`"PAPER"`, `"LIVE"` or the legacy `"SIM"`), so the join is what makes the
distinction, and a null there means the credential row has since been deleted.

**Zero is the answer worth acting on.** It means the feature has never done the
one thing it exists to do, and no amount of green CI changes that. It does not
say where it stopped, which is the second query.

Every discovered candidate is staged into `copy_mirror_deliveries` before the
broker is touched, and its `outcome` column records the exact gate that ended
it. Grouping by that column turns "nothing happened" into a named cause:

```sql
SELECT coalesce(d.outcome, '(still pending)') AS outcome,
       count(*) AS deliveries,
       max(d.created_at) AS last_seen
FROM copy_mirror_deliveries d
WHERE d.candidate->>'assetType' IN ('EQUITY', 'OPTION')
GROUP BY 1
ORDER BY deliveries DESC
LIMIT 50;
```

How to read the outcomes that stop an equity mirror. They are worth telling
apart because they point at four different people:

| Outcome | What it means | Whose problem |
|---|---|---|
| `placed`, `syncing` | an order reached Alpaca | nobody, this is the working case |
| `duplicate` | this source trade was already mirrored | nobody |
| `live-not-allowed` | the destination is a LIVE account and `COPY_TRADE_AUTOMIRROR_ALLOW_LIVE` is not `"true"` | the operator |
| `missing-credential`, `unusable-credential` | the follower has no usable Alpaca account selected | the follower |
| `incompatible-destination` | the selected account cannot take this instrument | the follower |
| `consent-withdrawn`, `consent-unverifiable` | the follow was turned off, re-pointed or deleted after staging | nobody, this is the safety gate working |
| `stale-intent` | the source event aged past the bound before the delivery ran | the operator, if it is frequent |
| `no-qty`, `dollar-cap`, `daily-cap` | sizing produced nothing, or a cap bound | the follower's sizing settings |
| `no-long-position` | a mirrored SELL had no follower long to reduce | nobody |
| `rejected` | Alpaca refused it | read `last_error` |

An empty result from the second query is a different finding from a populated
one. Empty means no equity candidate was ever discovered, so the question is
upstream of the mirror: whether `COPY_TRADE_AUTOMIRROR_ENABLED` is on, whether
any follow is armed, and whether the signal sources are producing rows at all.

If deliveries exist and the first query still returns zero, the outcome column
names the gate, and no guessing is required.

## Operational notes for a fully enabled deployment

These are properties of the system as it stands, not arguments against enabling
it. They are recorded because each one has a cost that shows up only in
production, and a maintainer should know them before the first user is affected.

**1. Signal-sourced perp mirrors have no exit.** A perp mirror opened from an
x_signal or paste.trade source has no reduce-only close, no stop and no take
profit attached; only a mirrored SOURCE close produces an exit
(`copy-mirror-perp-execution.ts:14-18`). Copying a real trader is fine, since
their close mirrors as an exit. Copying a signal is not: that position stays open
until the follower closes it by hand, and the follower is not told which kind of
source they are following. With `PERPS_ENABLED=true` and
`PERPS_ALLOW_MAINNET=true` this runs with real funds and real leverage. Closing
this gap is the highest-value work outstanding on this feature.

**2. Automatic perp leverage is user-controlled, not deployment-controlled.**
The applied leverage starts from what the source used and is reduced to the
lowest of the follower's persisted global automatic-perps maximum, an optional
lower maximum saved for that follow (null inherits the global maximum), and the
live market maximum on Hyperliquid. A persisted order leverage is an additional
non-escalating ceiling, so later policy changes cannot raise an order that was
already staged. No deployment environment variable sets a user's leverage.

Two consequences follow from allowing each follower to choose those ceilings:

  - The mirror can reproduce a source trader's most aggressive positions up to
    the follower's saved ceilings. The follow's saved sizing remains the source
    of requested exposure; deployment emergency ceilings may only reduce it.
  - Leverage multiplies the loss as well as the gain, and a liquidation on a
    mirrored perp is not recoverable by turning the feature off afterwards.

**3. Turning perps back off does not drain the queue.** Perp closes are still
staged while the gate is shut, then deferred indefinitely and exempt from the
attempt ceiling, which is correct for a one-shot exit. Nothing bounds or alerts
on that queue today.

**4. What users see is the API's copy, not the worker's state.**
`copyTrade.mirrorStatus` surfaces the flags this API deployment holds, per the
contract above, and the copy-trade UI renders them. Nothing reads the worker, so
an API that carries none of these vars can only say "unknown", and an API whose
copy disagrees with the worker will state its own copy confidently. Keeping the
two in step is manual.

**5. No startup validation of the names.** None of these are declared in
`turbo.json` `globalEnv`, and all are exact string comparisons, so
`COPY_TRADE_AUTOMIRROR_ENABLE=true` (missing D) is silently off. After changing
any of them, confirm from the worker's boot logs rather than from the console.

## After changing any flag

The worker reads these at boot and re-checks the master switch every cycle.
Restart the worker service, then confirm from its logs that the state is what you
intended, since a mistyped name is otherwise indistinguishable from a deliberate
off.
