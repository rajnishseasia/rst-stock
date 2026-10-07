# Terminal Workspace Layout Design

## Goal

Recompose the existing Ready Set Trade dashboard into a viewport-filling trading terminal inspired by the supplied Fomo reference while preserving Ready Set Trade branding, data sources, trading behavior, and account safety controls.

The chart is the primary surface. Discovery and account tools live in unified side drawers that can be collapsed or split into two independently configured panes.

## Approved Direction

- Use a fresh feature branch from `origin/main`.
- Fill the browser viewport beneath the existing global header; remove the centered max-width container, page padding, large inter-card gaps, and document-level vertical dead space.
- Keep the center chart visible and dominant at desktop widths.
- Replace the current stacked left column with one unified discovery drawer.
- Move AI into the right drawer beside trading and account tools.
- Give both left and right drawers double-chevron collapse controls and split-bottom/split-right actions.
- Build directly in the live local application for browser annotation rather than creating a disposable static mock.

## Desktop Layout

The application uses a fixed-height terminal shell beneath the 56px header:

```text
+----------------+----------------------------------------+------------------+
| Left drawer    | Symbol toolbar + dominant live chart  | Right drawer     |
| tabbed/split   |                                        | tabbed/split     |
| discovery      |                                        | trading/account  |
+----------------+----------------------------------------+------------------+
```

- Left drawer default width: approximately 300px.
- Right drawer default width: approximately 340px.
- Center: `minmax(0, 1fr)` and never wrapped in a decorative card.
- The center chart consumes all available height below its compact symbol toolbar.
- Each side drawer has a single outer border and background. Tiles inside are separated by one hairline divider, not nested cards.
- Each drawer collapses to a narrow icon rail. Collapsing either side immediately gives its width to the chart.

## Center Chart

- The initial symbol is `SPY` so the terminal never opens to a blank centerpiece.
- A compact toolbar above the chart displays an editable symbol field and the active account context.
- Selecting a ticker from any left-side feed updates the center chart.
- Editing the symbol in the right-side trade ticket also updates the center chart.
- Existing timeframes, timezone controls, reset, fullscreen mode, signal bubbles, and buy/sell execution markers remain intact.
- The chart uses a measured container height so it fills the available terminal space instead of a fixed 250px card.

## Left Discovery Drawer

Each discovery tile has an embedded top tab bar with:

- `X Signals`
- `Signa`
- `Watchlist`
- `Copy Trade`
- `Social`

The default tile opens to `X Signals`. Existing panel titles/collapse headers are suppressed in embedded mode so the drawer has only one visual frame and one navigation banner.

Ticker selection and copy actions keep their existing behavior: they update the active symbol, prefill the trade ticket where appropriate, and keep chart navigation working.

## Right Tool Drawer

Each tool tile has an embedded top tab bar with:

- `Trade`
- `AI`
- `Positions`
- `Orders`
- `Portfolio`

The default tile opens to `Trade`. The trade form renders without its internal chart because the center chart is now persistent. AI receives the same active symbol, selected signal, account mode, and credential context it receives today.

## Collapse And Split Behavior

Each drawer supports:

- Double-chevron collapse/expand for the entire drawer.
- `Split bottom`: two equal-height tiles with independent tab selections and scroll regions.
- `Split right`: two equal-width tiles with independent tab selections and scroll regions.
- Close on either child tile; closing one restores the surviving tile to the full drawer.
- A maximum of two tiles per side in this first iteration. Split actions disable once a drawer already contains two tiles.
- Independent tile content: for example, Watchlist above Copy Trade on the left, and AI beside Positions on the right.

Drawer state is persisted in local storage, including collapse state, split direction, and selected tab per tile. Invalid or outdated saved state falls back to the defaults.

## Responsive Behavior

- Desktop terminal mode starts at `xl` (1280px), matching the existing side-by-side breakpoint.
- Below `xl`, drawers stop behaving as fixed columns. The center chart remains first, and left/right tools become full-width tabbed sections in normal document flow.
- Split-right is hidden below `xl`; saved split layouts render as stacked tiles on narrow screens.
- Existing 44px mobile touch targets remain intact.
- The page must not introduce horizontal scrolling at 1280px, 1440px, or 1920px desktop widths.

## Component Boundaries

- `terminal-layout-state.ts`: pure state model, validation, split/close/tab/collapse reducers, and persistence contract.
- `terminal-drawer.tsx`: reusable left/right drawer chrome, embedded tab bars, split controls, and compact collapsed rail.
- `terminal-chart-panel.tsx`: active-symbol toolbar, responsive height measurement, and persistent `LiveChart` host.
- `page.tsx`: owns trading/account/selection state and maps tile IDs to existing product panels.
- Existing feature panels gain narrow optional presentation props such as `embedded` or `showChart`; their API/data behavior stays unchanged.

## Testing

- Pure unit tests for default state, validation, split, close, tab selection, collapse, and local-storage recovery.
- Dashboard source tests for the full-height shell, persistent center chart, left/right content registries, and active-symbol wiring.
- Existing feed, chart, trade, AI, positions, orders, portfolio, copy-trade, and watchlist tests must remain green.
- Web typecheck and production build must pass.
- Browser verification at desktop and mobile widths must cover:
  - dominant chart size;
  - left and right collapse/expand;
  - split bottom and split right on both sides;
  - independent tabs in split tiles;
  - ticker-to-chart navigation;
  - Trade-to-chart symbol synchronization;
  - no overlap, clipping, or unintended page dead space.

## Non-Goals

- Recursive tiling beyond two tiles per drawer.
- Drag resizing or drag-and-drop tile rearrangement.
- A new market-data source, order workflow, or database schema.
- Copying Fomo branding, crypto-specific data, or social mechanics.
- Replacing the existing chart engine.

