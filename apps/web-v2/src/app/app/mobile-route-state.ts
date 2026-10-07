import type { MobileBrowseTab } from "@/components/terminal/mobile-market-browse";
import type { MobilePortfolioView } from "./mobile-portfolio";
import type {
  MobileChartTab,
  MobileFeedTab,
  MobileToolsTab,
} from "./mobile-shell";

/** Legacy URL vocabulary retained only for parsing existing shared links. */
type LegacyMobileRouteScreen = "markets" | "search" | "chart" | "copy" | "tools";
type LegacyMobileCopyTab = "feed" | "x-callers" | "users";

/** Every navigable surface inside the mobile `/app` shell. */
export interface MobileRouteState {
  screen: LegacyMobileRouteScreen;
  feedTab: MobileFeedTab;
  chartTab: MobileChartTab;
  copyTab: LegacyMobileCopyTab;
  toolsTab: MobileToolsTab;
  portfolioView: MobilePortfolioView;
  browseTab: MobileBrowseTab;
}

export const DEFAULT_MOBILE_ROUTE_STATE: MobileRouteState = {
  screen: "markets",
  feedTab: "signals",
  chartTab: "portfolio",
  copyTab: "feed",
  toolsTab: "positions",
  portfolioView: "overview",
  browseTab: "all",
};

type SearchParamsReader = Pick<URLSearchParams, "get">;

/**
 * The Search screen's tab when the URL does not name one.
 *
 * Not always "all": the venue selected at the top of the app decides it, so a
 * user trading perps opens Search on Perps. Passing it through parse AND
 * canonicalize keeps the two in agreement: whichever tab is the default is the
 * one omitted from the URL, so picking "All" while on the perps venue is a real,
 * preserved choice (`?t=all`) rather than a value that parses straight back to
 * Perps.
 */
export interface MobileRouteOptions {
  defaultBrowseTab?: MobileBrowseTab;
}

export interface MobileSearchRouteContext extends MobileRouteOptions {
  /** URL defaults are unsafe to compact until the persisted venue is known. */
  canCanonicalize: boolean;
}

/**
 * Resolve Search defaults without pretending the pre-hydration stock fallback
 * is the user's saved venue. The caller can still parse and render during that
 * first paint, but must wait for `canCanonicalize` before rewriting the URL.
 */
export function mobileSearchRouteContext(
  activeVenue: "stocks" | "perps" | null,
  perpsEnabled: boolean,
): MobileSearchRouteContext {
  return {
    defaultBrowseTab:
      perpsEnabled && activeVenue === "perps" ? "perps" : "all",
    canCanonicalize: activeVenue !== null,
  };
}

function oneOf<T extends string>(raw: string | null, values: readonly T[], fallback: T): T {
  return raw !== null && values.includes(raw as T) ? (raw as T) : fallback;
}

/** Parse invalid or absent URL values to the exact defaults rendered by the UI. */
export function parseMobileRouteState(
  params: SearchParamsReader,
  { defaultBrowseTab = DEFAULT_MOBILE_ROUTE_STATE.browseTab }: MobileRouteOptions = {},
): MobileRouteState {
  const screen = oneOf(
    params.get("s") ?? params.get("screen"),
    ["markets", "search", "chart", "copy", "tools"],
    "markets",
  );
  const activeTab = params.get("t") ?? params.get("tab");
  const compactToolsTab = screen === "tools" ? activeTab : null;
  const toolsTabRaw = compactToolsTab ?? params.get("toolsTab");
  const compactPortfolioView = compactToolsTab === "portfolio-stocks"
    ? "stocks"
    : compactToolsTab === "portfolio-perps"
      ? "perps"
      : compactToolsTab === "portfolio"
        ? "overview"
        : null;

  return {
    screen,
    feedTab: oneOf(
      screen === "markets" ? activeTab ?? params.get("feedTab") : params.get("feedTab"),
      ["signals", "watchlist", "signa"],
      "signals",
    ),
    chartTab: (() => {
      const raw =
        screen === "chart"
          ? activeTab ?? params.get("chartTab")
          : params.get("chartTab");
      // Preserve old shared links after News was renamed to Feed.
      return oneOf(raw === "news" ? "feed" : raw, ["portfolio", "feed", "ai"], "portfolio");
    })(),
    copyTab: oneOf(
      screen === "copy" ? activeTab ?? params.get("copyTab") : params.get("copyTab"),
      ["feed", "x-callers", "users"],
      "feed",
    ),
    toolsTab: oneOf(
      compactPortfolioView ? "portfolio" : toolsTabRaw,
      ["positions", "closed", "orders", "portfolio", "ai"],
      "positions",
    ),
    portfolioView: compactPortfolioView ?? oneOf(
      params.get("portfolioView"),
      ["overview", "stocks", "perps"],
      "overview",
    ),
    browseTab: oneOf(
      screen === "search" ? activeTab ?? params.get("browseTab") : params.get("browseTab"),
      ["all", "stocks", "perps", "people"],
      defaultBrowseTab,
    ),
  };
}

const MOBILE_ROUTE_PARAM_KEYS = [
  "s",
  "t",
  "screen",
  "tab",
  // Remove the verbose route format so old links normalize on first load.
  "feedTab",
  "chartTab",
  "copyTab",
  "toolsTab",
  "portfolioView",
  "browseTab",
  "xWindow",
  "xSort",
  "horizon",
  "usersWindow",
  "usersSort",
] as const;

function compactActiveTab(
  state: MobileRouteState,
  defaultBrowseTab: MobileBrowseTab,
): string | null {
  if (state.screen === "markets") {
    return state.feedTab === "signals" ? null : state.feedTab;
  }
  if (state.screen === "search") {
    return state.browseTab === defaultBrowseTab ? null : state.browseTab;
  }
  if (state.screen === "chart") {
    return state.chartTab === "portfolio" ? null : state.chartTab;
  }
  if (state.screen === "copy") {
    return state.copyTab === "feed" ? null : state.copyTab;
  }
  if (state.toolsTab === "positions") return null;
  if (state.toolsTab !== "portfolio") return state.toolsTab;
  return state.portfolioView === "overview"
    ? "portfolio"
    : `portfolio-${state.portfolioView}`;
}

/** Preserve deep links with no more than one screen and one active-tab param. */
export function canonicalMobileRouteParams(
  current: URLSearchParams,
  state: MobileRouteState,
  { defaultBrowseTab = DEFAULT_MOBILE_ROUTE_STATE.browseTab }: MobileRouteOptions = {},
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of MOBILE_ROUTE_PARAM_KEYS) next.delete(key);

  if (state.screen !== "markets") next.set("s", state.screen);
  const tab = compactActiveTab(state, defaultBrowseTab);
  if (tab) next.set("t", tab);
  return next;
}
