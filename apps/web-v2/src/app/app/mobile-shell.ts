/**
 * Rules of the mobile (sub-xl) shell, kept out of page.tsx so they can be tested
 * directly instead of by reading the page as a string (audit H7).
 *
 * Nothing here touches order construction: it decides which SCREEN a user lands
 * on, never what is sent to a broker.
 */

/** The tabs on the mobile Markets screen. */
export type MobileFeedTab = "signals" | "watchlist" | "signa";

/**
 * Markets-screen tabs in display order. The aggregated social signal feed leads
 * because it is the product; the watchlist and Signa are secondary reads.
 */
export const MOBILE_FEED_TABS: ReadonlyArray<{
  value: MobileFeedTab;
  label: string;
}> = [
  { value: "signals", label: "Signals" },
  { value: "watchlist", label: "Watchlist" },
  { value: "signa", label: "Signa" },
];

/** The tab the mobile Markets screen opens on. */
export const DEFAULT_MOBILE_FEED_TAB: MobileFeedTab = "signals";

/**
 * The tabs on the mobile Chart screen: reads ABOUT THE MARKET on screen.
 *
 * News is the aggregated signal feed scoped to nothing else on this screen, and
 * AI is a conversation about this symbol. Both answer "what is happening with
 * this market", which is what a user who just tapped a ticker asked.
 */
export type MobileChartTab = "portfolio" | "feed" | "ai";

export const MOBILE_CHART_TABS: ReadonlyArray<{
  value: MobileChartTab;
  label: string;
}> = [
  { value: "portfolio", label: "Portfolio" },
  { value: "feed", label: "Feed" },
  { value: "ai", label: "AI" },
];

/** The chart screen opens on the user's position in the selected market. */
export const DEFAULT_MOBILE_CHART_TAB: MobileChartTab = "portfolio";

/**
 * The chart tabs available for a venue.
 *
 * AI is an EQUITY assistant: it is handed the equity symbol slot, and its order
 * drafts flow into the equity ticket. On a perp chart that produced a
 * conversation about a completely different instrument (a BTC chart analyzing
 * whatever equity was last selected, e.g. SPY) and could draft an equity order
 * from it, while the user believed they were discussing the perp on screen.
 *
 * Handing it the perp coin instead would only trade one wrong behavior for
 * another, since the draft still lands in the equity ticket. Until the panel is
 * venue-aware, the honest thing is not to offer it on a perp chart rather than
 * to present an assistant that is silently talking about something else.
 */
export function mobileChartTabsForVenue(
  isPerps: boolean,
): ReadonlyArray<{ value: MobileChartTab; label: string }> {
  return isPerps
    ? MOBILE_CHART_TABS.filter((tab) => tab.value !== "ai")
    : MOBILE_CHART_TABS;
}

/**
 * The tab to actually render. A user who selects AI on an equity chart and then
 * switches venue would otherwise keep an AI panel that the tab strip no longer
 * offers, which is the same wrong-instrument conversation by another route.
 */
export function resolveMobileChartTab(
  selected: MobileChartTab,
  isPerps: boolean,
): MobileChartTab {
  return mobileChartTabsForVenue(isPerps).some((tab) => tab.value === selected)
    ? selected
    : DEFAULT_MOBILE_CHART_TAB;
}

/**
 * The tabs on the mobile Account screen: reads ABOUT THE ACCOUNT.
 *
 * Positions, Orders and Portfolio span every symbol and both venues, so they are
 * not "detail about the market on screen" and do not belong on the chart. AI
 * appears on both surfaces deliberately: it is a conversation, and the useful
 * question differs by where you are ("what is NVDA doing" vs "how is my book").
 */
export type MobileAccountTab =
  | "positions"
  | "closed"
  | "orders"
  | "portfolio"
  | "ai";

export const MOBILE_ACCOUNT_TABS: ReadonlyArray<{
  value: MobileAccountTab;
  label: string;
}> = [
  { value: "positions", label: "Positions" },
  // Directly after Positions: the two answer the same question ("what am I in,
  // and what happened to what I was in"), and a stop that fired is only ever
  // visible on this one.
  { value: "closed", label: "Closed" },
  { value: "orders", label: "Orders" },
  { value: "portfolio", label: "Portfolio" },
  { value: "ai", label: "AI" },
];

/** Account opens on what you hold, not on what you asked. */
export const DEFAULT_MOBILE_ACCOUNT_TAB: MobileAccountTab = "positions";

/**
 * Compatibility aliases for the pre-v2 controller while it is migrated to the
 * Account destination. They point at the same immutable tab contract and can
 * be removed once the controller no longer imports the old Tools names.
 */
/** @deprecated Use MobileAccountTab. */
export type MobileToolsTab = MobileAccountTab;
/** @deprecated Use MOBILE_ACCOUNT_TABS. */
export const MOBILE_TOOLS_TABS = MOBILE_ACCOUNT_TABS;
/** @deprecated Use DEFAULT_MOBILE_ACCOUNT_TAB. */
export const DEFAULT_MOBILE_TOOLS_TAB = DEFAULT_MOBILE_ACCOUNT_TAB;

/**
 * The tabs whose content is account-wide rather than market-specific.
 *
 * This is the rule the Chart / Account split enforces. It was previously asserted
 * by reading page.tsx as a string and grepping the two panels' JSX; naming it
 * here makes it a property both tab lists are checked against instead.
 *
 * Why it matters beyond tidiness: an account-wide panel on the chart screen
 * shows a stocks-only user's Alpaca positions next to a Hyperliquid chart, and
 * (with A7's venue stack) a perps section under an equity chart. Account
 * surfaces carry BOTH venues, so they only make sense where no single market
 * owns the screen.
 */
export const ACCOUNT_WIDE_MOBILE_TABS: ReadonlyArray<string> = [
  "positions",
  "closed",
  "orders",
  "portfolio",
];

export function isAccountWideMobileTab(tab: string): boolean {
  return ACCOUNT_WIDE_MOBILE_TABS.includes(tab);
}

/**
 * The tabs on the mobile Copy screen (plan A10).
 *
 * The leaderboard used to be reachable on a phone only through the Copy panel's
 * "Top Traders" link out to `/lb`, a separate route with its own header
 * and no bottom nav, so opening it exited the shell and discarded the screen,
 * feed tab and selected signal. These three tabs pull it inside the shell.
 *
 * ONE level, not two. `LeaderboardView` renders its own X Callers / Users tabs,
 * so a `Feed | Top Traders` header above it would stack the venue bar, an outer
 * control row and an inner control row on a 375px screen. The mobile shell
 * mounts the two leaderboard bodies directly instead, and this flattened list is
 * the single control row.
 */
/** Canonical Copy destinations shared by the shell, screen, and URL codec. */
export const MOBILE_COPY_TAB_VALUES = [
  "following",
  "x-callers",
  "users",
] as const;

export type MobileCopyTab = (typeof MOBILE_COPY_TAB_VALUES)[number];

export const MOBILE_COPY_TABS: ReadonlyArray<{
  value: MobileCopyTab;
  label: string;
}> = [
  { value: MOBILE_COPY_TAB_VALUES[0], label: "Following" },
  { value: MOBILE_COPY_TAB_VALUES[1], label: "Top X" },
  { value: MOBILE_COPY_TAB_VALUES[2], label: "Top Users" },
];

/**
 * The Copy screen opens on Following. Copy-trading is the signal-first read;
 * the rankings are the vetting step you take after seeing a call.
 */
export const DEFAULT_MOBILE_COPY_TAB: MobileCopyTab = "following";

/**
 * Whether a Copy-screen tab shows a leaderboard rather than the copy feed.
 *
 * Load-bearing: the two bodies are mounted EXCLUSIVELY, never rendered together
 * and hidden with CSS. `CopyTradePanel` runs a polling infinite query and the
 * leaderboard bodies run their own ranked queries, so keeping the inactive one
 * mounted would poll a surface nobody is looking at (audit M3).
 */
export function isLeaderboardCopyTab(tab: MobileCopyTab): boolean {
  return tab !== "following";
}

/**
 * The tabs on the mobile Traders destination: the signal feed, the three Copy
 * surfaces, and the watchlist, in that order.
 *
 * Before the merge these were three places, each paying for its own screen
 * chrome: Feed and Copy were bottom-nav slots of their own, and Watchlist was
 * a section switch inside Markets. One destination with one tab strip costs
 * one control row and frees a nav slot. The values are shared with the URL
 * codec, the menu and the screen, so a tab can never be spelled two ways.
 */
export const MOBILE_TRADERS_TAB_VALUES = [
  "feed",
  ...MOBILE_COPY_TAB_VALUES,
  "watchlist",
] as const;

export type MobileTradersTab = (typeof MOBILE_TRADERS_TAB_VALUES)[number];

/** Labels are the ones the old screens already painted; nothing is renamed. */
export const MOBILE_TRADERS_TABS: ReadonlyArray<{
  value: MobileTradersTab;
  label: string;
}> = [
  { value: "feed", label: "Feed" },
  ...MOBILE_COPY_TABS,
  { value: "watchlist", label: "Watchlist" },
];

/**
 * Traders opens on the signal feed: the aggregated feed is the product, and
 * it was the first of the merged destinations in the old nav.
 */
export const DEFAULT_MOBILE_TRADERS_TAB: MobileTradersTab = "feed";

export function isMobileTradersTab(value: unknown): value is MobileTradersTab {
  return (
    typeof value === "string" &&
    (MOBILE_TRADERS_TAB_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Whether a Traders tab is one of the Copy surfaces (Following, Top X, Top
 * Users). Those three share the copy panel, its automation disclosure and its
 * risk-settings action; the feed and the watchlist are their own panels.
 */
export function isCopyTradersTab(tab: MobileTradersTab): tab is MobileCopyTab {
  return (MOBILE_COPY_TAB_VALUES as readonly string[]).includes(tab);
}

/**
 * The product's name for the ranked boards.
 *
 * The two boards are already mounted inside Traders (Top X and Top Users), but
 * until this constant existed the word "Leaderboard" appeared in exactly one
 * place on a phone: the hamburger's Pages row out to `/lb`. So the feature read
 * as a menu item even though its content lives on the destination. Anything
 * that names the boards as a group uses this string, so the shell and the menu
 * cannot drift into two names for one feature.
 */
export const MOBILE_LEADERBOARD_LABEL = "Leaderboard";

/**
 * Which board a leaderboard entry point opens: the callers board, the same
 * one `/lb` opens on. Deep links keep their own tab; this is only the answer
 * to "take me to the leaderboard" when no board was named.
 */
export const DEFAULT_MOBILE_LEADERBOARD_TAB: MobileCopyTab =
  MOBILE_COPY_TAB_VALUES[1];

/**
 * Whether a Traders tab is one of the ranked leaderboard boards.
 *
 * One definition, composed from the two predicates that already exist rather
 * than a third hand-written list, so a new Copy surface cannot quietly start
 * or stop counting as the leaderboard.
 */
export function isLeaderboardTradersTab(tab: MobileTradersTab): boolean {
  return isCopyTradersTab(tab) && isLeaderboardCopyTab(tab);
}

/**
 * Tailwind's `xl` breakpoint. At or above it the desktop terminal is the mounted
 * shell and the mobile trade sheet does not exist; below it the mobile shell is.
 */
export const DESKTOP_TERMINAL_MIN_WIDTH = 1280;

/** Whether the current viewport renders the mobile shell rather than the terminal. */
export function isNarrowViewport(width: number | null | undefined): boolean {
  return (
    typeof width === "number" &&
    Number.isFinite(width) &&
    width < DESKTOP_TERMINAL_MIN_WIDTH
  );
}

/** Where a copy-prefilled ticket ended up. */
export type CopyPrefillLanding = "trade-sheet" | "chart";

/**
 * Lands a copy-prefilled ticket somewhere the user can see it. On the mobile
 * shell that is the trade sheet. On the desktop terminal the sheet must NOT be
 * opened: it would sit in state, invisible at xl, holding the body scroll lock
 * until a resize popped a surprise full-screen sheet, so the chart takes focus
 * instead. A copy never prefills invisibly.
 */
export function landCopyPrefill(handlers: {
  openTradeSheetOnNarrowViewport: () => boolean;
  focusChartOnNarrowViewport: () => void;
}): CopyPrefillLanding {
  if (handlers.openTradeSheetOnNarrowViewport()) return "trade-sheet";
  handlers.focusChartOnNarrowViewport();
  return "chart";
}
