# Portfolio Panel Placement Design

## Goal

Place the Portfolio card below Open Orders in the desktop right column while keeping it as
the final dashboard section on mobile.

## Design

Move the existing `PortfolioHistoryChart` instance from the middle-column stack to the end
of the right-column stack, immediately after `OpenOrdersPanel`.

The dashboard already renders the middle, left, and right stacks in responsive order on
small screens. Because Portfolio becomes the final child of the final mobile stack, it
remains at the bottom without duplicate components or breakpoint-specific rendering.

## Verification

- Add a source-order regression test confirming the chart is rendered once and follows
  Open Orders.
- Run the regression test and web TypeScript checks.
- Inspect desktop and mobile layouts in the browser.
