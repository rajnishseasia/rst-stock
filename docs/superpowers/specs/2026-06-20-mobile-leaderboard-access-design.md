# Mobile Leaderboard Access Design

## Goal

Keep the Copy Trade leaderboard and follow-management controls visible and touch-friendly on narrow mobile screens.

## Design

- Stack the Copy Trade source filters and action controls on mobile.
- Keep source filters in the first wrapping row.
- Place `Top Traders` and `Manage follows` in a second full-width row.
- Give both actions a minimum 44px mobile touch height.
- Let `Top Traders` consume the remaining row width so its label cannot be clipped.
- Restore the existing compact, side-by-side layout at the `sm` breakpoint and above.

## Scope

Only the Copy Trade header layout and the Manage Follows trigger sizing change. The leaderboard route, filters, data, dialogs, and desktop behavior remain unchanged. No API, database, or migration changes are required.

## Testing

- Add a source-contract regression test for the stacked mobile layout, full-width leaderboard link, and mobile touch heights.
- Run focused Copy Trade tests, web typecheck, lint, full tests, and the production web build.
- At a mobile viewport in the in-app browser, confirm `Top Traders` is visible without horizontal scrolling, opens `/leaderboard`, and has no overlap or clipping.
