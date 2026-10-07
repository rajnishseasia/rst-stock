# Signal Bubble Hover Overlay Design

## Goal

Show the signal details overlay when a pointer hovers a chart signal bubble, while preserving click interaction for touch devices and keeping the overlay usable for links and scrolling.

## Scope

This change applies only to signal bubbles rendered by `SignalBubbleOverlay`. Trade execution bubbles and other chart interactions are unchanged.

## Interaction

- Pointer entry on a signal bubble opens its overlay immediately.
- Pointer exit from the bubble schedules the overlay to close after a short delay.
- Pointer entry on the overlay cancels the scheduled close.
- Pointer exit from the overlay closes it.
- Clicking a bubble continues to toggle the overlay for touch and click-based use.
- Clicking the backdrop or close button continues to close the overlay.
- Moving directly from a bubble to its overlay must not cause visible flicker or make overlay links unreachable.

## Implementation

`SignalBubbleOverlay` will own a close timer in a ref. Small callbacks will open a projected signal, schedule closure, cancel closure, and close immediately. Bubble and overlay pointer events will share these callbacks so the gap between the two elements is covered by the delay.

The timer will be cleared when the component unmounts to avoid a state update after teardown. Opening another bubble will cancel any pending close before replacing the active overlay.

## Accessibility And Input

The existing button elements remain keyboard-focusable. Click behavior remains available as the non-hover fallback, including touch input. The change does not make hover the only way to access signal details.

## Testing

A focused component regression test will verify:

- pointer entry on a bubble opens the overlay without a click;
- leaving the bubble does not immediately close it;
- entering the overlay during the delay keeps it open;
- leaving the overlay closes it after the intended dismissal behavior;
- click still opens or toggles the overlay.

Type checking will verify the chart overlay integration.
