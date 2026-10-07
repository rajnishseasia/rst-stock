/**
 * Pure terminal-shell configuration: the desktop drawer tab lists, the bottom
 * activity tabs/venue views, and the per-tab subheader filter definitions.
 *
 * Extracted out of page.tsx (audit H7: pure data first) so this configuration
 * is importable and directly assertable, instead of only checkable by reading
 * page.tsx as a string. None of these values depend on React or on any other
 * page.tsx state; moving them here is a pure relocation, not a behavior
 * change. See page-layout.test.ts for the behavioral coverage this enables,
 * mirroring the pattern already used for the mobile shell in ./mobile-shell.ts.
 */

import type {
  LeftTerminalTab,
  RightTerminalTab,
} from "@/components/terminal/terminal-layout-state";
import { PERPS_ENABLED } from "@/lib/perps-config";
import type { SignalFeedSubheaderAction } from "@/components/feed/signal-feed";
import type { SignaSubheaderAction } from "@/components/signa/signa-signals-panel";
import type { WatchlistSubheaderAction } from "@/components/watchlist/watchlist-panel";
import type { CopyTradeSubheaderAction } from "@/components/copy-trade/copy-trade-panel";
import type { SocialSubheaderAction } from "@/components/social/social-feed-panel";

export type BottomTerminalTab =
  | "positions"
  | "orders"
  | "history"
  | "balances"
  | "portfolio"
  | "closed";

export const LEFT_TERMINAL_TABS: Array<{
  value: LeftTerminalTab;
  label: string;
  /** Short pill label rendered next to the tab text for discoverability. */
  badge?: string;
}> = [
  { value: "x_signals", label: "X Signals" },
  { value: "signa", label: "Signa" },
  { value: "watchlist", label: "Watchlist" },
  { value: "copy_trade", label: "Copy Trade", badge: "Stocks · Perps" },
  { value: "social", label: "Social" },
  ...(PERPS_ENABLED ? [{ value: "hl_markets" as const, label: "HL Markets" }] : []),
];

export const RIGHT_TERMINAL_TABS: Array<{
  value: RightTerminalTab;
  label: string;
  iconSrc?: string;
}> = [
  { value: "trade", label: "Trade" },
  { value: "positions", label: "Positions" },
  { value: "orders", label: "Orders" },
  { value: "portfolio", label: "Portfolio" },
  { value: "ai", label: "AI", iconSrc: "/brand/rst-bull-ai.png" },
];

/**
 * The bottom drawer's sub-tabs, in the order a trader asks the questions:
 * what am I holding, what is working, what happened, what can I spend, and how
 * has the whole account done.
 *
 * History and Balances were added because the terminal already had both
 * answers and was hiding them. History (perp fills / closed stock orders) was
 * reachable only by opening Positions and flipping its Open | Closed toggle, or
 * by scrolling past a portfolio chart. Balances is the cash, buying-power and
 * margin half of the `positions.account` response the header was already
 * polling and dropping, plus Hyperliquid's collateral figures.
 */
export const BOTTOM_TERMINAL_TABS: Array<{ value: BottomTerminalTab; label: string }> = [
  { value: "positions", label: "Positions" },
  { value: "orders", label: "Open Orders" },
  { value: "history", label: "History" },
  { value: "balances", label: "Balances" },
  { value: "portfolio", label: "Portfolio" },
];

/**
 * The bottom drawer's sub-tabs are the SAME set for both venues.
 *
 * Perps used to carry a fourth, "Closed" (the completed round-trips folded out
 * of the fills feed), which stocks had no counterpart for. That asymmetry is
 * gone: closed perp round-trips live behind the positions panel's own
 * Open | Closed toggle, which is the identical control the equity panel has
 * always had. The drawer no longer offers a venue choice at all either - it
 * shows whichever venue is selected at the top of the app - so a per-venue tab
 * list would have nothing left to vary.
 *
 * The "closed" member of BottomTerminalTab is kept because the mobile account
 * shell still routes to a standalone Closed screen; `resolveBottomSubTab`
 * folds it back to Positions for this drawer, and its return type states that.
 */
export const PERPS_BOTTOM_TERMINAL_TABS = BOTTOM_TERMINAL_TABS;

/**
 * The sub-tab to actually render in the bottom drawer.
 *
 * A persisted "closed" selection (from when perps had that sub-tab, or from
 * the mobile shell, which shares the type) has no button in this drawer and
 * would leave it on a tab nothing is highlighting. Fall back to Positions,
 * where the Closed view now lives anyway.
 */
export function resolveBottomSubTab(
  tab: BottomTerminalTab,
): Exclude<BottomTerminalTab, "closed"> {
  return tab === "closed" ? "positions" : tab;
}

export const RIGHT_TERMINAL_TAB_VALUES = RIGHT_TERMINAL_TABS.map((tab) => tab.value);

export type LeftSubheaderActionByTab = {
  x_signals: SignalFeedSubheaderAction;
  signa: SignaSubheaderAction;
  watchlist: WatchlistSubheaderAction;
  copy_trade: CopyTradeSubheaderAction;
  social: SocialSubheaderAction;
  hl_markets: "all_coins";
};

export type LeftSubheaderAction = LeftSubheaderActionByTab[keyof LeftSubheaderActionByTab];

export type LeftSubheaderItem = {
  id: LeftSubheaderAction;
  label: string;
  title: string;
};

export const DEFAULT_LEFT_SUBHEADER_ACTIONS: LeftSubheaderActionByTab = {
  x_signals: "all_authors",
  signa: "best_picks",
  watchlist: "saved",
  copy_trade: "feed",
  social: "hot_symbols",
  hl_markets: "all_coins",
};

export const LEFT_TERMINAL_SUBHEADERS: Record<LeftTerminalTab, LeftSubheaderItem[]> = {
  x_signals: [
    { id: "all_authors", label: "All authors", title: "Clear author filters" },
    { id: "latest", label: "Latest", title: "Refresh the latest X signals" },
    { id: "price_pills", label: "Price pills", title: "Show quote badges on signal tickers" },
  ],
  signa: [
    { id: "best_picks", label: "Best picks", title: "Show Signa's curated best picks" },
    { id: "risk_reward", label: "Risk/reward", title: "Sort signals by available risk/reward" },
    { id: "copy_signal", label: "Copy signal", title: "Show signals with copy-ready stop and target" },
  ],
  watchlist: [
    { id: "saved", label: "Saved", title: "Use watchlist rows to open the trade form" },
    { id: "live_quotes", label: "Live quotes", title: "Refresh and emphasize live quote data" },
    { id: "ai", label: "AI", title: "Use watchlist rows to ask AI about symbols" },
  ],
  copy_trade: [
    { id: "feed", label: "Feed", title: "Show the full copy-trade feed" },
    { id: "following", label: "Following", title: "Show targets you follow" },
    { id: "mirror", label: "Mirror", title: "Focus auto-mirror setup and follows" },
  ],
  social: [
    { id: "hot_symbols", label: "Hot symbols", title: "Focus hot community symbols" },
    { id: "live_feed", label: "Live feed", title: "Refresh the community trade feed" },
  ],
  hl_markets: [], // coin universe has no subheader filter buttons
};
