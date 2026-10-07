# External Discord Signal Poller

The worker can ingest Discord-originated Hyperliquid calls for caller profiles
and leaderboard scoring. Direct follower execution is separately gated and is
disabled unless the operator opts in.

## Deployment gates

- `EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED=true` starts Redis stream polling.
- `EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET=true` additionally permits real-money
  Hyperliquid mainnet execution. Leave it unset or set to any other value to
  keep mainnet calls research-only.
- `EXTERNAL_DISCORD_SIGNAL_MAX_AGE_MS` optionally changes the maximum age of a
  call that may execute. It must be a positive integer and defaults to `300000`
  (five minutes). Older calls are still persisted for research and ranking.

Follower settings live in
`apps/worker/src/config/external-discord-followers.json`. The worker validates
email, positive dollar risk, integer leverage from 1 through 50, margin mode,
enabled state, and confidence threshold. An invalid file fails closed with no
enabled followers.

## Required services

- The Discord bridge writes version 1 entries to Redis stream
  `discord:external:signals`.
- The worker needs its normal direct PostgreSQL and Redis connections.
- Hyperliquid order reconciliation must be running for ambiguous or accepted
  but not immediately filled venue responses.

## Database rollout

This change adds no migration. It uses the existing `signals` and `orders`
tables, including the globally unique `orders.client_order_id` index. Apply all
repository migrations already on `main` before enabling the worker.

## Safety behavior

- Every source event is inserted before execution; replayed events do not trade.
- Every follower order is reserved in `orders` before Hyperliquid is called.
- Leverage setup failure stops the order.
- Only a confirmed fill can create TP/SL orders or a success webhook.
- Definitive venue failures become `REJECTED`; ambiguous outcomes stay
  reconcilable rather than being guessed from error text.
