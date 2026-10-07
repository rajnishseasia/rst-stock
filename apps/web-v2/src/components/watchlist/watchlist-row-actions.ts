/**
 * Watchlist row click wiring - pure builder for the three actions a row
 * exposes, kept separate from the JSX so the wiring itself is unit testable.
 *
 * The full-row overlay always opens the chart (`onViewSymbol`), never trade
 * or AI. A past regression let that overlay fall back to `onTradeSymbol`
 * (`onViewSymbol ?? onTradeSymbol`) or branch on a `primaryRowAction` flag, so
 * the same click fired a different navigation depending on unrelated state.
 * The explicit Trade and Ask AI buttons are the only callers of their
 * respective handlers - the overlay never calls them.
 *
 * The overlay is a no-op while the row is in "organize" (reorder) mode, so
 * dragging the up/down controls doesn't also open the chart underneath them.
 */

import type { MarketVenue } from "@/lib/market-selection";

export interface WatchlistRowActionHandlers {
  onViewSymbol: (symbol: string, venue?: MarketVenue) => void;
  onTradeSymbol: (symbol: string, venue?: MarketVenue) => void;
  onAskAi: (symbol: string, venue?: MarketVenue) => void;
}

export interface WatchlistRowActionItem {
  symbol: string;
  venue: MarketVenue;
}

export interface WatchlistRowActions {
  onRowClick: () => void;
  onTradeClick: () => void;
  onAskAiClick: () => void;
}

export function buildWatchlistRowActions(
  item: WatchlistRowActionItem,
  handlers: WatchlistRowActionHandlers,
  isOrganizing: boolean,
): WatchlistRowActions {
  return {
    onRowClick: () => {
      if (isOrganizing) return;
      handlers.onViewSymbol(item.symbol, item.venue);
    },
    onTradeClick: () => handlers.onTradeSymbol(item.symbol, item.venue),
    onAskAiClick: () => handlers.onAskAi(item.symbol, item.venue),
  };
}
