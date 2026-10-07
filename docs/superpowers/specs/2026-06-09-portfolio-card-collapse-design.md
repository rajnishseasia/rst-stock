# Portfolio Card Collapse Design

## Goal

Add a persistent collapse control to the Portfolio card that matches the dashboard's other
collapsible cards.

## Design

Reuse the shared `useCollapsible` hook and `CollapseButton` component with a unique
`portfolio` storage key. Place the collapse chevron at the far right of the Portfolio
header, after the period selector.

Keep the complete header visible in both states. The title, current portfolio value, and
gain or loss remain available while collapsed. Arrange the header responsively so this
summary stays on one line whenever the available width permits, without causing overflow
at narrow widths.

Only the card content containing the loading, error, empty, or chart state is hidden when
collapsed. Period selection remains usable while collapsed, and changing the period
continues to update the portfolio query.

## Accessibility

Use the existing collapse button semantics, including `aria-expanded`, an accessible
Portfolio label, and the established chevron rotation.

## Verification

- Add a focused component test covering expanded and collapsed rendering.
- Confirm the shared collapse storage key is unique.
- Run the focused test and web TypeScript checks.
- Inspect the card at desktop and narrow widths to confirm the header stays on one line
  where practical and does not overflow.
