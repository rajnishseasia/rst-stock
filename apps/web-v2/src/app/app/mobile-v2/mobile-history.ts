import {
  normalizeMarketSymbol,
  type MarketSelection,
  type MarketVenue,
} from "@/lib/market-selection";
import {
  DEFAULT_MOBILE_TRADERS_TAB,
  MOBILE_COPY_TAB_VALUES,
  MOBILE_TRADERS_TAB_VALUES,
  isCopyTradersTab,
  isMobileTradersTab,
  type MobileCopyTab,
  type MobileTradersTab as MobileShellTradersTab,
} from "../mobile-shell";

/**
 * The mobile screens that can be represented in the URL.
 *
 * The trade TICKET is intentionally absent: it is a modal sheet and therefore
 * should never become a durable destination in browser history. The chart
 * screen is the Trade destination (the bottom nav's Trade item and the home
 * screen); it doubles as a contextual screen when reached by tapping an
 * instrument elsewhere, in which case it carries an origin. Search is
 * contextual only, but is included because refreshing it must restore the
 * same surface. Traders is the merged Feed, Copy and Watchlist destination;
 * the old `feed` and `copy` screen names are still read, below, and land on
 * it with the matching tab selected.
 */
export const MOBILE_HISTORY_SCREENS = [
  "markets",
  "traders",
  "search",
  "chart",
  "account",
] as const;

export type MobileHistoryScreen = (typeof MOBILE_HISTORY_SCREENS)[number];

/**
 * A surface from which a contextual Search or Chart screen may be opened.
 * Chart is one: Search opened from the Trade home screen must come back to it.
 */
export const MOBILE_HISTORY_ORIGINS = [
  "markets",
  "traders",
  "search",
  "chart",
  "account",
] as const;

export type MobileHistoryOrigin = (typeof MOBILE_HISTORY_ORIGINS)[number];

/** Account workspace tabs that need to survive a refresh/deep link. */
export const MOBILE_HISTORY_ACCOUNT_TABS = [
  "positions",
  "closed",
  "orders",
  "portfolio",
  "ai",
] as const;

export type MobileHistoryAccountTab =
  (typeof MOBILE_HISTORY_ACCOUNT_TABS)[number];

/** Traders tabs use the same canonical values as the mobile Traders screen. */
export const MOBILE_HISTORY_TRADERS_TABS = MOBILE_TRADERS_TAB_VALUES;

export type MobileHistoryTradersTab = MobileShellTradersTab;

/** The complete, serializable mobile navigation state. */
export interface MobileLocationState {
  screen: MobileHistoryScreen;
  /** Origin used by contextual Back; null for primary destinations. */
  origin: MobileHistoryOrigin | null;
  /** Venue-tagged identity for the contextual chart, or null when absent. */
  market: MarketSelection | null;
  accountTab: MobileHistoryAccountTab;
  tradersTab: MobileHistoryTradersTab;
}

/** Common aliases make the state discoverable at integration call sites. */
export type MobileHistoryState = MobileLocationState;
export type MobileLocation = MobileLocationState;
export type MobileAccountTab = MobileHistoryAccountTab;
export type MobileTradersTab = MobileHistoryTradersTab;

/**
 * The mobile home is the signal feed (traders) screen: the app opens on the
 * live signal feed by default. Markets and chart remain accessible via nav.
 */
export const DEFAULT_MOBILE_LOCATION: MobileLocationState = {
  screen: "traders",
  origin: null,
  market: null,
  accountTab: "positions",
  tradersTab: DEFAULT_MOBILE_TRADERS_TAB,
};

/** Marker stored on history entries created by a mobile destination push. */
export const MOBILE_HISTORY_PUSH_MARKER = "__rstMobileHistoryPush";

/** Return whether a history entry was pushed by the mobile destination controller. */
export function isMobileHistoryPushState(value: unknown): boolean {
  return isRecord(value) && value[MOBILE_HISTORY_PUSH_MARKER] === true;
}

/** Preserve any existing router state while marking a mobile push entry. */
export function mobileHistoryPushState(value: unknown): Record<string, unknown> {
  return {
    ...(isRecord(value) ? value : {}),
    [MOBILE_HISTORY_PUSH_MARKER]: true,
  };
}

/**
 * Input accepted by the codec. The canonical shape is `market`, `accountTab`,
 * and `tradersTab`; the aliases are deliberately read-only compatibility
 * affordances for controller code that still calls the chart identity
 * `chartMarket`, and for the pre-merge `copyTab`/`copy` keys, which are
 * normalized onto the Traders tab set at the parsing boundary.
 */
export interface MobileLocationStateInput {
  screen?: unknown;
  origin?: unknown;
  from?: unknown;
  market?: unknown;
  marketSelection?: unknown;
  chartMarket?: unknown;
  symbol?: unknown;
  venue?: unknown;
  marketSymbol?: unknown;
  marketVenue?: unknown;
  chartSymbol?: unknown;
  chartVenue?: unknown;
  accountTab?: unknown;
  account?: unknown;
  tradersTab?: unknown;
  traders?: unknown;
  copyTab?: unknown;
  copy?: unknown;
}

type SearchInput =
  | string
  | URLSearchParams
  | null
  | undefined;

/** Query keys owned by the mobile location codec, including read-only aliases. */
const MOBILE_LOCATION_QUERY_KEYS = [
  "screen",
  // Legacy mobile-route-state compact and verbose route keys. They are read
  // below for deep-link compatibility, but never emitted by the v2 codec.
  "s",
  "t",
  "tab",
  "feedTab",
  "chartTab",
  "toolsTab",
  "portfolioView",
  "browseTab",
  "xWindow",
  "xSort",
  "horizon",
  "usersWindow",
  "usersSort",
  "origin",
  "from",
  "market",
  "marketSelection",
  "chartMarket",
  "symbol",
  "marketSymbol",
  "chartSymbol",
  "venue",
  "marketVenue",
  "chartVenue",
  "accountTab",
  "account",
  "tradersTab",
  "traders",
  // The pre-merge Copy tab keys. Read for compatibility, never emitted.
  "copyTab",
  "copy",
] as const;

/**
 * Screen names that no longer exist but are still live in URLs. `tools` was
 * the first shell's Account; `feed` and `copy` were nav slots of their own
 * until they merged into Traders. Each maps onto the destination that now
 * carries its content; the tab it lands on is resolved separately below.
 */
const LEGACY_MOBILE_SCREEN_ALIASES: Readonly<Record<string, MobileHistoryScreen>> = {
  tools: "account",
  feed: "traders",
  copy: "traders",
};

/** Values accepted by the pre-v2 mobile-route-state parser. */
const LEGACY_MOBILE_FEED_TABS = [
  "signals",
  "watchlist",
  "signa",
] as const;
// These values remain in the cleanup set below. Their old screen-local
// controls (Chart News/AI and Search All/Stocks/Perps/People) are not part of
// the v2 location state, so parsing retains the destination and safely drops
// the transient sub-tab during canonicalization.
const LEGACY_MOBILE_TOOLS_TABS = [
  "positions",
  "closed",
  "orders",
  "portfolio",
  "ai",
] as const;
const LEGACY_MOBILE_PORTFOLIO_VIEWS = [
  "overview",
  "stocks",
  "perps",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fromAlias(value: unknown): unknown {
  return isRecord(value) ? value.from : undefined;
}

function isMobileHistoryScreen(
  value: unknown,
): value is MobileHistoryScreen {
  return (
    typeof value === "string" &&
    (MOBILE_HISTORY_SCREENS as readonly string[]).includes(value)
  );
}

function isMobileHistoryAccountTab(
  value: unknown,
): value is MobileHistoryAccountTab {
  return (
    typeof value === "string" &&
    (MOBILE_HISTORY_ACCOUNT_TABS as readonly string[]).includes(value)
  );
}

function isMobileCopyTab(value: unknown): value is MobileCopyTab {
  return (
    typeof value === "string" &&
    (MOBILE_COPY_TAB_VALUES as readonly string[]).includes(value)
  );
}

/**
 * The pre-merge `copyTab` vocabulary. `feed` was the first mobile shell's
 * name for the Following surface, so under this key it still means
 * Following: it must not be confused with the Traders `feed` tab, which is
 * the signal feed. Accepted only while parsing and never part of state.
 */
function parseLegacyCopyTab(value: unknown): MobileCopyTab | null {
  if (value === "feed") return "following";
  return isMobileCopyTab(value) ? value : null;
}

function parseMobileHistoryTradersTab(
  value: unknown,
): MobileHistoryTradersTab | null {
  return isMobileTradersTab(value) ? value : null;
}

function firstParam(params: URLSearchParams, ...names: string[]): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return value;
  }
  return null;
}

function isLegacyValue<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

/** Map the old `s`/`screen` vocabulary onto the v2 destination names. */
function parseMobileHistoryScreen(value: unknown): MobileHistoryScreen | null {
  if (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(LEGACY_MOBILE_SCREEN_ALIASES, value)
  ) {
    return LEGACY_MOBILE_SCREEN_ALIASES[value];
  }
  return isMobileHistoryScreen(value) ? value : null;
}

/** Origins share the screen vocabulary, legacy names included. */
function parseMobileHistoryOrigin(value: unknown): MobileHistoryOrigin | null {
  return parseMobileHistoryScreen(value);
}

/**
 * The tab a legacy Markets link lands on now that its Signals, Watchlist and
 * Signa tabs all live on Traders. Signa was a signal view, so it lands on the
 * feed with Signals.
 */
function tradersTabForLegacyMarketsTab(
  feedTab: (typeof LEGACY_MOBILE_FEED_TABS)[number],
): MobileHistoryTradersTab {
  return feedTab === "watchlist" ? "watchlist" : "feed";
}

/**
 * Choose the Traders tab from every spelling a URL or state object can carry,
 * most authoritative first:
 *
 * 1. a canonical `tradersTab`;
 * 2. a legacy Markets tab (`?t=signals`, `?feedTab=watchlist`) that moved here;
 * 3. the old `screen=feed` destination, which is the signal feed regardless of
 *    whatever remembered `copyTab` rode along in the same URL;
 * 4. the old `screen=copy` destination, which keeps its own precedence: an
 *    explicit `copyTab`, then the compact `t`, then Following, never a
 *    non-Copy tab (a Copy link must land on a Copy surface);
 * 5. a remembered legacy `copyTab` on any other screen;
 * 6. the fallback.
 */
function resolveTradersTab(input: {
  rawScreen: unknown;
  tradersValue: unknown;
  copyValue: unknown;
  activeTab: string | null;
  migratedTab: MobileHistoryTradersTab | null;
  fallback: MobileHistoryTradersTab;
}): MobileHistoryTradersTab {
  const canonical = parseMobileHistoryTradersTab(input.tradersValue);
  if (canonical) return canonical;
  if (input.migratedTab) return input.migratedTab;
  if (input.rawScreen === "feed") return "feed";
  if (input.rawScreen === "copy") {
    if (isMobileCopyTab(input.copyValue)) return input.copyValue;
    const compact = parseLegacyCopyTab(input.activeTab);
    if (compact) return compact;
    if (input.copyValue === "feed") return "following";
    return isCopyTradersTab(input.fallback) ? input.fallback : "following";
  }
  return parseLegacyCopyTab(input.copyValue) ?? input.fallback;
}

function parseLegacyAccountTab(value: string | null): MobileHistoryAccountTab | null {
  return isLegacyValue(value, LEGACY_MOBILE_TOOLS_TABS)
    ? value
    : null;
}

function accountTabFromLegacyRoute(
  activeTab: string | null,
  toolsTab: string | null,
  portfolioView: string | null,
): MobileHistoryAccountTab | null {
  // The compact active tab was the old parser's first choice, even when a
  // contradictory verbose value was also present. Keep that precedence while
  // translating the old portfolio drill-down into the v2 Portfolio tab.
  if (activeTab !== null) {
    if (activeTab === "portfolio-stocks" || activeTab === "portfolio-perps") {
      return "portfolio";
    }
    return parseLegacyAccountTab(activeTab);
  }
  const parsedToolsTab = parseLegacyAccountTab(toolsTab);
  if (parsedToolsTab) return parsedToolsTab;
  return isLegacyValue(portfolioView, LEGACY_MOBILE_PORTFOLIO_VIEWS)
    ? "portfolio"
    : null;
}

/**
 * Normalize a venue-tagged market without ever uppercasing a Hyperliquid coin.
 * Stocks are case-insensitive and use the shared stock normalizer; perps may
 * contain a HIP-3 namespace (`xyz:GOOGL`) and must retain canonical casing.
 */
function normalizeMarket(
  value: unknown,
  venueHint?: unknown,
): MarketSelection | null {
  let symbol: unknown;
  let venue: unknown = venueHint;

  if (isRecord(value)) {
    symbol = value.symbol;
    venue = value.venue ?? venue;
  } else if (typeof value === "string") {
    symbol = value;
  } else {
    return null;
  }

  if ((venue !== "stocks" && venue !== "perps") || typeof symbol !== "string") {
    return null;
  }

  const normalized = normalizeMarketSymbol(venue as MarketVenue, symbol);
  return normalized ? { symbol: normalized, venue: venue as MarketVenue } : null;
}

function stateMarketInput(state: MobileLocationStateInput): unknown {
  if (state.market !== undefined) return state.market;
  if (state.marketSelection !== undefined) return state.marketSelection;
  if (state.chartMarket !== undefined) return state.chartMarket;

  const symbol =
    state.symbol ?? state.marketSymbol ?? state.chartSymbol;
  const venue = state.venue ?? state.marketVenue ?? state.chartVenue;
  return symbol === undefined && venue === undefined
    ? undefined
    : { symbol, venue };
}

function normalizeStateInput(
  input: MobileLocationStateInput | null | undefined,
): MobileLocationState {
  const state = input ?? {};
  const screen =
    parseMobileHistoryScreen(state.screen) ?? DEFAULT_MOBILE_LOCATION.screen;
  const origin = parseMobileHistoryOrigin(state.origin ?? state.from);
  const market = normalizeMarket(stateMarketInput(state));
  const accountTab = isMobileHistoryAccountTab(state.accountTab ?? state.account)
    ? (state.accountTab ?? state.account) as MobileHistoryAccountTab
    : DEFAULT_MOBILE_LOCATION.accountTab;
  const tradersTab = resolveTradersTab({
    rawScreen: state.screen,
    tradersValue: state.tradersTab ?? state.traders,
    copyValue: state.copyTab ?? state.copy,
    activeTab: null,
    migratedTab: null,
    fallback: DEFAULT_MOBILE_LOCATION.tradersTab,
  });

  return { screen, origin, market, accountTab, tradersTab };
}

/**
 * Clone a URLSearchParams-like input before reading it. This keeps the parser
 * pure even when a caller hands it a mutable URLSearchParams instance.
 */
function toSearchParams(search: SearchInput): URLSearchParams {
  if (search instanceof URLSearchParams) {
    return new URLSearchParams(search.toString());
  }
  if (typeof search !== "string" || search.length === 0) {
    return new URLSearchParams();
  }

  // `location.search` is normally just `?…`, but accepting a full pathname is
  // useful for server-side deep-link tests and costs nothing. Hash fragments
  // never belong to the query state.
  const queryStart = search.indexOf("?");
  const query = queryStart >= 0 ? search.slice(queryStart + 1) : search;
  const hashStart = query.indexOf("#");
  return new URLSearchParams(hashStart >= 0 ? query.slice(0, hashStart) : query);
}

function queryMarket(
  params: URLSearchParams,
  fallback: MarketSelection | null,
): MarketSelection | null {
  const marketValue = firstParam(params, "market", "marketSelection", "chartMarket");
  const symbol = firstParam(params, "symbol", "marketSymbol", "chartSymbol");
  const venue = firstParam(params, "venue", "marketVenue", "chartVenue");

  if (marketValue !== null) {
    // A combined `venue:symbol` form is accepted for links produced by early
    // callers. Split only the first colon so `xyz:GOOGL` remains intact.
    const direct = normalizeMarket(marketValue, venue);
    if (direct) return direct;
    if (venue === null) {
      const separator = marketValue.indexOf(":");
      if (separator > 0) {
        const combined = normalizeMarket(marketValue.slice(separator + 1), marketValue.slice(0, separator));
        if (combined) return combined;
      }
    }
    return fallback;
  }

  if (symbol !== null || venue !== null) {
    return normalizeMarket(
      { symbol, venue },
    ) ?? fallback;
  }

  return fallback;
}

/**
 * Parse a location search string into a complete, validated mobile state.
 * Unknown values are rejected field-by-field and leave the corresponding
 * fallback value intact. No browser globals are read.
 */
export function parseMobileLocation(
  search: SearchInput,
  fallback: MobileLocationStateInput | null | undefined = DEFAULT_MOBILE_LOCATION,
): MobileLocationState {
  const base = normalizeStateInput(fallback);
  const params = toSearchParams(search);

  // `screen` is the v2 spelling and therefore wins over the old compact `s`
  // alias whenever both are present. A present-but-invalid canonical value is
  // still authoritative: falling through to `s` would make contradictory URLs
  // depend on which key happened to be emitted first.
  const canonicalScreenValue = params.get("screen");
  const legacyScreenValue = params.get("s");
  const rawScreen =
    canonicalScreenValue !== null ? canonicalScreenValue : legacyScreenValue;
  const activeTab = firstParam(params, "t", "tab");
  // The pre-v2 Markets destination carried Signals, Watchlist and Signa tabs,
  // and the pre-v2 parser defaulted the screen to Markets, so a legacy link
  // that names only one of those tabs (`?t=watchlist`, `?feedTab=signals`)
  // meant Markets even though it never said so. All three tabs live on
  // Traders now, so those links, and compact `s=markets` links naming them,
  // land there with the matching tab. An already-canonical `screen=markets`
  // is never overridden by stale aliases riding along with it.
  const legacyFeedTab = activeTab ?? params.get("feedTab");
  const legacyMarketsTab = isLegacyValue(legacyFeedTab, LEGACY_MOBILE_FEED_TABS)
    ? legacyFeedTab
    : null;
  const legacyTabOnlyMarkets =
    canonicalScreenValue === null &&
    legacyScreenValue === null &&
    legacyMarketsTab !== null;
  const parsedScreen =
    parseMobileHistoryScreen(rawScreen) ??
    (legacyTabOnlyMarkets ? "markets" : base.screen);
  const migratedTab =
    canonicalScreenValue === null &&
    parsedScreen === "markets" &&
    legacyMarketsTab !== null
      ? tradersTabForLegacyMarketsTab(legacyMarketsTab)
      : null;
  const screen = migratedTab ? "traders" : parsedScreen;
  const originValue = firstParam(params, "origin", "from");
  const accountValue = firstParam(params, "accountTab", "account");
  const legacyToolsTab = params.get("toolsTab");
  const legacyPortfolioView = params.get("portfolioView");

  return {
    screen,
    origin:
      originValue === null
        ? base.origin
        : parseMobileHistoryOrigin(originValue) ?? base.origin,
    market: queryMarket(params, base.market),
    accountTab:
      accountValue === null
        ? screen === "account"
          ? accountTabFromLegacyRoute(
              activeTab,
              legacyToolsTab,
              legacyPortfolioView,
            ) ?? base.accountTab
          : base.accountTab
        : isMobileHistoryAccountTab(accountValue)
          ? accountValue
          : base.accountTab,
    tradersTab: resolveTradersTab({
      rawScreen,
      tradersValue: firstParam(params, "tradersTab", "traders"),
      copyValue: firstParam(params, "copyTab", "copy"),
      activeTab,
      migratedTab,
      fallback: base.tradersTab,
    }),
  };
}

/**
 * Serialize mobile state as a browser `location.search` value. The leading
 * question mark makes the result safe to pass directly to pushState or
 * replaceState; parseMobileLocation also accepts the no-question-mark form.
 */
export function serializeMobileLocation(
  input: MobileLocationStateInput,
): string {
  const state = normalizeStateInput(input);
  const params = new URLSearchParams();

  params.set("screen", state.screen);
  if (state.origin) params.set("origin", state.origin);
  if (state.market) {
    params.set("venue", state.market.venue);
    params.set("symbol", state.market.symbol);
  }
  // Omit tab params that match their defaults so the URL stays clean when
  // the user is on the default home state. parseMobileLocation falls back to
  // these same values when the keys are absent.
  if (state.accountTab !== DEFAULT_MOBILE_LOCATION.accountTab) {
    params.set("accountTab", state.accountTab);
  }
  if (state.tradersTab !== DEFAULT_MOBILE_LOCATION.tradersTab) {
    params.set("tradersTab", state.tradersTab);
  }

  return `?${params.toString()}`;
}

/**
 * Merge a serialized mobile location into an existing query string while
 * preserving keys owned by the surrounding route. Mobile compatibility
 * aliases are removed before canonical values are written, so stale aliases
 * cannot survive a navigation update.
 */
export function mergeMobileLocationSearch(
  currentSearch: SearchInput,
  serializedLocation: string,
): string {
  const merged = toSearchParams(currentSearch);
  for (const key of MOBILE_LOCATION_QUERY_KEYS) merged.delete(key);

  const nextLocation = new URLSearchParams(serializedLocation);
  nextLocation.forEach((value, key) => merged.set(key, value));

  const query = merged.toString();
  return query ? `?${query}` : "";
}

/**
 * Return the surface that should receive a contextual Back action. Primary
 * destinations, and a contextual screen with no usable origin, intentionally
 * return the home screen; browser history handles the preceding primary
 * destination, while this pure target handles the in-shell Back button for
 * Search and Chart.
 */
export function mobileBackTarget(
  state: Pick<MobileLocationState, "screen" | "origin"> | MobileLocationStateInput,
): MobileHistoryScreen {
  const screen =
    parseMobileHistoryScreen(state.screen) ?? DEFAULT_MOBILE_LOCATION.screen;
  const origin = parseMobileHistoryOrigin(
    state.origin ?? fromAlias(state),
  );

  if ((screen === "chart" || screen === "search") && origin && origin !== screen) {
    return origin;
  }
  return DEFAULT_MOBILE_LOCATION.screen;
}

/**
 * Choose how an in-flow contextual Back should update browser history. A
 * mobile destination push has a real preceding entry to consume; an initial
 * deep link (or a non-mobile entry) must be corrected in place instead.
 */
export function mobileBackHistoryMode(
  state: Pick<MobileLocationState, "screen" | "origin"> | MobileLocationStateInput,
  historyState: unknown,
): "pop" | "replace" {
  const screen =
    parseMobileHistoryScreen(state.screen) ?? DEFAULT_MOBILE_LOCATION.screen;
  return (screen === "chart" || screen === "search") &&
      isMobileHistoryPushState(historyState)
    ? "pop"
    : "replace";
}
