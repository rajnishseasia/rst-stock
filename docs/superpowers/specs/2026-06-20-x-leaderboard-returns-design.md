# Direction-Aware X Leaderboard Returns

## Goal

Make the X Callers leaderboard report honest return and hit-rate data for posts that mention one or more tickers.

## Scoring Contract

- Each unique ticker extracted from an X post remains one independent call.
- Duplicate mentions of the same ticker in one post count once, matching ingestion behavior.
- A clearly bullish call uses the ticker's raw forward return.
- A clearly bearish call uses the inverse of the ticker's raw forward return.
- A ticker mention with no unambiguous direction remains in `Calls` but is excluded from return and hit-rate calculations.
- An exit such as sell-to-close is not treated as a new directional recommendation.
- Options are scored on the underlying ticker, not option-premium P&L.
- A call is measurable only after its selected forward horizon has elapsed and a closing market bar exists.

## Direction Derivation

Direction is derived per signal row from the full stored post and that row's ticker.

1. Reuse the existing option-signal parser for explicit single-leg option calls.
2. Classify buy-to-open calls as bullish and buy-to-open puts as bearish.
3. Classify explicit ticker-local equity language such as buy/long/bullish as bullish and short/bearish as bearish.
4. When bullish and bearish evidence conflict, or no direction is clear, return `unknown`.

Mixed posts are evaluated independently per ticker. For example, `$AAPL long, $TSLA short` produces one bullish AAPL call and one bearish TSLA call.

## API And UI

- Add measured and directional call counts to each X caller row.
- Keep total `callCount` unchanged.
- Separate `market data unavailable` from `waiting for horizon` and `direction unclear` states.
- Add `1D`, `3D`, and `7D` horizon controls; default to `1D` so recent mature calls become useful sooner.
- Display return and hit rate only from measured directional calls, with a compact measured/total sample label.

## Testing

- Pure parser tests for bullish, bearish, mixed-ticker, conflicting, ambiguous, and option cases.
- Aggregation tests proving bearish returns are inverted and ambiguous calls are excluded from metrics but retained in call count.
- UI source tests for horizon controls and distinct unavailable/pending states.
- API/web typechecks, full unit suite, production web build, and local browser verification.

## Non-Goals

- No LLM-based direction inference.
- No option-premium performance calculation.
- No historical database backfill or schema migration.
- No changes to copy-trade execution behavior.
