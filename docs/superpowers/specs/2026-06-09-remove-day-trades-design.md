# Remove Day Trades Design

## Goal

Remove day-trade and pattern-day-trader information from product-facing account data, UI, documentation, and AI context.

## Scope

- Remove the Day Trades metric and PDT badge from the Account Summary card.
- Remove `daytradeCount` and `patternDayTrader` from the account API response.
- Remove the day-trade count from the AI stock context.
- Remove Day Trades, Day Trade, and PDT guidance from the web guide and its tracked glossary source.
- Keep `daytrade_count` and `pattern_day_trader` in `AlpacaAccount` because that interface mirrors Alpaca's raw broker response.
- Do not edit generated or untracked build output such as `apps/api/index.js`.

## UI Behavior

The Account Summary card continues to use its existing two-column grid. It displays Portfolio Value, Buying Power, and Cash, with no replacement fourth metric.

## Data Flow

The Alpaca client may still receive day-trade fields in the broker response. The positions account router stops forwarding them to the web client, and the stock-context builder stops exposing them to AI prompts.

## Documentation

The guide's account-summary description and metric list mention only Portfolio Value, Buying Power, and Cash. Day Trade and PDT entries and warnings are removed from the guide and tracked glossary source.

## Verification

- Add a focused source-level regression test that checks product-facing source files no longer contain the removed account response fields or user-facing Day Trades/PDT copy.
- Run the regression test.
- Run the web TypeScript check.
- Search tracked product source and documentation for remaining day-trade/PDT references, allowing only the raw Alpaca response type.
