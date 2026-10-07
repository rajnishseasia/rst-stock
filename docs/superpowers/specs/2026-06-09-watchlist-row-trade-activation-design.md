# Watchlist Row Trade Activation Design

## Goal

Make each populated watchlist row open its symbol in the New Trade panel when the user clicks anywhere on the row's non-control area, including empty space.

## Interaction

- Clicking a watchlist row's non-control area calls `onTradeSymbol` with that row's symbol.
- The full-row trade target is a native button, so Enter or Space performs the same action.
- The trade target has a symbol-specific accessible label.
- Existing nested controls keep their current behavior:
  - Trade opens the New Trade panel.
  - Ask AI opens AI research.
  - Remove deletes the item.
  - Organize arrows reorder the item.
- Activating a nested control must not also trigger the row action.

## Implementation

Add a full-row native button layer inside the watchlist row in `watchlist-panel.tsx`. Keep the visible row content and existing controls above that layer. Non-interactive symbol, quote, and empty-space content allows pointer events to reach the row button, while action controls remain independent interactive siblings.

The symbol and price no longer need separate button elements once the row provides the shared trade target. The explicit Trade button remains for discoverability and calls the trade action exactly once.

Add pointer and focus styling so the expanded interaction is visible without changing the row layout.

## Testing

Add a focused component regression test that verifies:

- Clicking empty row space calls `onTradeSymbol` with the row symbol.
- Enter and Space on the row call `onTradeSymbol`.
- Clicking Trade calls `onTradeSymbol` once.
- Clicking Ask AI calls only `onAskAi`.
- Clicking Remove does not call `onTradeSymbol`.
- Clicking organize controls does not call `onTradeSymbol`.

Run the focused test, web type checking, and the relevant broader test suite available in the repository.

## Scope

This change does not alter watchlist data, quote loading, sorting behavior, trade form behavior, or the visual structure of the row.
