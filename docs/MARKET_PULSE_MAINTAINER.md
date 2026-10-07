# Market Pulse Production Notes

Market Pulse is a shared, read-only market workspace. It combines Alpaca stock
screeners/news with Hyperliquid's public perpetual-market universe, then caches
the normalized response in Redis.

## Deployment requirements

- No database migration or schema change is required.
- Reuse the production Redis instance through `REDIS_URL`.
- Configure the server-owned Alpaca market-data credentials:
  - `ALPACA_MASTER_KEY`
  - `ALPACA_MASTER_SECRET`
  - `ALPACA_MASTER_PAPER=true` for the IEX feed, or `false` only when the key has
    SIP entitlement.
- Hyperliquid market stats are read from the public Info API and require no user
  wallet or signing key.

The API caches healthy overviews for 60 seconds. Partial results use a 15-second
TTL so a temporarily unavailable provider recovers quickly. If Redis is down,
the endpoint fails open to live provider requests and reports a bypass cache
state; this keeps the UI available but increases Alpaca request volume.
Hyperliquid DEX partitions are fetched independently: healthy main/HIP-3 rows
remain visible when another partition fails, while the overview is marked
partial and receives the shorter TTL.
Alpaca movers, most-active stocks, snapshots, and news are also tracked
independently. Healthy stock rows remain visible when an optional source fails,
while the overview reports partial coverage and uses the same shorter TTL.

## Data semantics

- Stock trending and heatmap weights use current activity (share volume) plus
  absolute daily movement.
- Perpetual trending and heatmap weights use 24-hour USD notional volume plus
  absolute daily movement.
- The first version groups stock tiles by Gainers, Losers, and Most Active. It
  does not claim sector or market-cap weighting because Alpaca's asset catalog
  does not provide dependable sector or market-cap fundamentals.
- Pulse news links preserve the source URL and publisher returned by Alpaca.
  The summary is deterministic market data plus sourced news, not generated
  copy.

## Production verification

1. Confirm `REDIS_URL` is present in both preview and production API settings.
2. Confirm the Alpaca master key can call movers, most-actives, batch snapshots,
   and news endpoints with the selected IEX/SIP feed.
3. Deploy the API before or together with the web app so
   `marketPulse.overview` exists when the workspace becomes visible.
4. Open Market Pulse, switch between Stocks and Perps, and confirm the `Updated`
   timestamp advances after the cache TTL.
5. Click a stock and perp heatmap tile and confirm the terminal opens the correct
   chart venue. Use the explicit Trade action and confirm the right Trade module
   opens on the same market.
6. Temporarily disconnect Redis in a non-production environment and confirm the
   workspace still loads with a degraded/bypass indicator.

## Local verification

```bash
docker compose -f docker-compose.local.yml up -d postgres redis
bun install --frozen-lockfile
bun test apps/api/src/lib/markets/market-pulse.test.ts \
  apps/api/src/__tests__/market-pulse.test.ts \
  packages/alpaca/src/client.test.ts \
  packages/hyperliquid/src/client.test.ts \
  apps/web-v2/src/components/market-pulse/market-pulse-components.test.tsx \
  apps/web-v2/src/components/market-pulse/market-pulse-utils.test.ts
bun --filter @trade-bot/alpaca typecheck
bun --filter @trade-bot/hyperliquid typecheck
bun --filter @trade-bot/api typecheck
bun --filter @trade-bot/web typecheck
bun --filter @trade-bot/web build
```
