# Signal Ticker Live Chart Design

## Goal

Make ticker labels across the dashboard's signal and user feeds open that symbol in the existing Live Chart without turning the ticker into a trade-placement action.

## Interaction

- Render ticker labels as keyboard-accessible buttons in X Signals, Signa Signals, Copy Trade rows, Community Trades, and the Community Hot Symbols strip.
- Label the control as `View $SYMBOL live chart` for assistive technology and hover text.
- Clicking the ticker invokes a dedicated symbol-view callback; it does not invoke Copy, Copy Signal, Follow, or any order action.
- The dashboard updates the active symbol, switches to the `New Trade` tab so the embedded Live Chart is visible, and scrolls the chart column into view on viewports below the existing `xl` breakpoint.
- Keep the existing `Copy SYMBOL`, `Copy Signal`, Follow, and Community sharing controls unchanged.
- Preserve multi-ticker signal behavior: each badge opens its own symbol, and the matching signal remains highlighted.

## Architecture

Add a small `onViewSymbol(symbol)` callback to `SignalFeed`, `SignaSignalsPanel`, `CopyTradePanel`, and `SocialFeedPanel`. Their nested row components forward the ticker to this callback. The dashboard remains the single owner of the active symbol, active tab, and responsive chart scrolling.

The dashboard handler clears source-specific copy prefills, updates the active symbol, selects the `quick` tab, and then scrolls the chart column on narrow viewports. This guarantees that a user who is currently viewing AI Chat sees the chart and does not carry stale signal-specific trade intent into the new symbol.

## Accessibility And Styling

Use a native `button` with the current badge styling, a visible pointer/hover state, and a focus-visible ring. Keep the price and daily-change presentation unchanged.

## Testing

- Add source-contract tests that fail until X, Signa, Copy Trade, Community Trade, and Hot Symbol tickers call `onViewSymbol` and expose chart-specific accessible text.
- Add a dashboard source-contract test that fails until the shared symbol-view handler switches to the `quick` tab before scrolling.
- Run the focused feed/dashboard tests, full web tests, and web typecheck.
- Start the local API and web app, then use the in-app browser to click representative ticker buttons and confirm the symbol appears in the Live Chart, the New Trade tab is active, no framework overlay appears, and no relevant console errors are introduced.

## Scope

No new route, modal, API endpoint, database table, or migration is required. Watchlist behavior and every existing trade/copy action remain unchanged.
