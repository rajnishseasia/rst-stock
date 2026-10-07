import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MobileV2Header } from "./mobile-v2/mobile-frame";
import {
  type MobileMarketsScreenProps,
} from "./mobile-v2/markets-screen";
import {
  MobileFeedPanel,
  type MobileFeedPanelProps,
} from "./mobile-v2/feed-panel";
import {
  type MobileAccountScreenProps,
} from "./mobile-v2/account-screen";
import {
  type MobileTradersScreenProps,
} from "./mobile-v2/traders-screen";
import {
  DEFAULT_MOBILE_LOCATION,
  MOBILE_HISTORY_PUSH_MARKER,
  mobileBackHistoryMode,
  mergeMobileLocationSearch,
  mobileBackTarget,
  parseMobileLocation,
  serializeMobileLocation,
} from "./mobile-v2/mobile-history";
import {
  mobileFeedTickerClickVenue,
  mobileChartBackLabel,
  MobileChartInsights,
  MobileChartMarketSummary,
  MobileTradeSheet,
  MobileV2Menu,
  renderMobileV2Destination,
  renderMobileV2Shell,
  resolveMobileAccountValueProps,
  resolveMobileAccountValueState,
} from "./trading-app-content";
import * as tradingAppContent from "./trading-app-content";
import {
  signalTickerChartSelection,
  stockChartSelection,
} from "@/components/feed/signal-selection";
import {
  click,
  elementText,
  flattenElements,
  findByAriaLabel,
} from "@/testing/element-tree";

// The integration boundary is intentionally presentational: real panel/query
// elements are supplied by TradingAppContent, while this helper chooses which
// one is in-flow. Marker nodes make these tests independent of tRPC/Privy
// providers and prove that inactive screens are not mounted together.
const marker = (name: string): ReactNode =>
  createElement("div", { "data-mobile-marker": name }, name);

const marketsProps = (
  overrides: Partial<MobileMarketsScreenProps> = {},
): MobileMarketsScreenProps => ({
  accountSummary: marker("account-summary"),
  marketBrowse: marker("market-browse"),
  onOpenSearch: () => {},
  ...overrides,
});

const feedProps = (
  overrides: Partial<MobileFeedPanelProps> = {},
): MobileFeedPanelProps => ({
  signalFeed: marker("signal-feed"),
  venueFilter: "all",
  perpsAvailable: true,
  onVenueFilterChange: () => {},
  ...overrides,
});

const accountProps = (
  overrides: Partial<MobileAccountScreenProps> = {},
): MobileAccountScreenProps => ({
  activeTab: "positions",
  onTabChange: () => {},
  positions: marker("positions"),
  closed: marker("closed"),
  orders: marker("orders"),
  portfolio: marker("portfolio"),
  ai: marker("account-ai"),
  ...overrides,
});

// The merged Traders destination opens on the Feed tab; the feed slot is the
// real MobileFeedPanel around a marker so venue-scope behaviour stays under
// test through the destination switch.
const tradersProps = (
  overrides: Partial<MobileTradersScreenProps> = {},
): MobileTradersScreenProps => ({
  activeTab: "feed",
  onTabChange: () => {},
  feed: createElement(MobileFeedPanel, feedProps()),
  copyFeed: marker("copy-feed"),
  xCallers: marker("x-callers"),
  users: marker("users"),
  watchlist: marker("watchlist"),
  ...overrides,
});

describe("production mobile controller destination integration", () => {
  test("keeps mobile Copy source navigation reachable for venue-scoped discovery", () => {
    type MobileCopyFeedProps = {
      isSignedIn: boolean;
      onCopy: () => void;
      onViewSymbol: () => void;
    };
    type MobileCopyFeedPropsFactory = (
      props: MobileCopyFeedProps,
    ) => MobileCopyFeedProps & {
      hideSourceTabs: boolean;
      lockSource?: "all" | "following" | "callers" | "users";
    };
    const mobileCopyFeedProps = (
      tradingAppContent as unknown as {
        mobileCopyFeedProps?: MobileCopyFeedPropsFactory;
      }
    ).mobileCopyFeedProps;

    expect(typeof mobileCopyFeedProps).toBe("function");
    if (!mobileCopyFeedProps) return;

    const props = mobileCopyFeedProps({
      isSignedIn: false,
      onCopy: () => {},
      onViewSymbol: () => {},
    });
    // The outer Traders tabs choose the destination; the inner source row
    // must remain available so users can find other users' perp fills.
    expect(props.hideSourceTabs).toBe(false);
    expect(props.lockSource).toBeUndefined();
  });

  test("marks a partial portfolio unavailable when an Alpaca account read failed", async () => {
    const { buildMobilePortfolio } = await import("./mobile-portfolio");
    const summary = buildMobilePortfolio({
      stocksConnected: null,
      stocksValue: 12_345.67,
      perpsConnected: true,
      perpsValue: "2500",
      venueCheckFailed: true,
    });

    expect(resolveMobileAccountValueState(summary)).toBe("unavailable");
  });

  test("keeps a complete portfolio total available", async () => {
    const { buildMobilePortfolio } = await import("./mobile-portfolio");
    const summary = buildMobilePortfolio({
      stocksConnected: true,
      stocksValue: 12_345.67,
      perpsConnected: false,
      perpsValue: null,
    });

    expect(resolveMobileAccountValueState(summary)).toBe("available");
  });

  test("keeps an incomplete but still-running portfolio total loading", async () => {
    const { buildMobilePortfolio } = await import("./mobile-portfolio");
    const summary = buildMobilePortfolio({
      stocksConnected: null,
      stocksValue: 12_345.67,
      perpsConnected: true,
      perpsValue: "2500",
    });

    expect(resolveMobileAccountValueState(summary)).toBe("loading");
  });

  test("reuses the honest header account-value contract for the Account destination", async () => {
    const { buildMobilePortfolio } = await import("./mobile-portfolio");
    const complete = buildMobilePortfolio({
      stocksConnected: true,
      stocksValue: 12_345.67,
      perpsConnected: true,
      perpsValue: "2500",
    });
    const partial = buildMobilePortfolio({
      stocksConnected: true,
      stocksValue: 12_345.67,
      perpsConnected: null,
      perpsValue: null,
    });
    const failed = buildMobilePortfolio({
      stocksConnected: true,
      stocksValue: 12_345.67,
      perpsConnected: null,
      perpsValue: null,
      venueCheckFailed: true,
    });

    expect(resolveMobileAccountValueProps(complete)).toEqual({
      accountValue: "portfolio $14,845.67",
      accountValueState: "available",
      accountValueReason: null,
    });
    expect(resolveMobileAccountValueProps(partial)).toEqual({
      accountValue: "portfolio $12,345.67 so far, still checking your venues",
      accountValueState: "loading",
      accountValueReason: null,
    });
    expect(resolveMobileAccountValueProps(failed)).toEqual({
      accountValue: "portfolio $12,345.67 so far, a venue could not be checked",
      accountValueState: "unavailable",
      accountValueReason: "venue-check-failed",
    });
  });

  test("routes an All-feed perp ticker to perps while stock signals stay on stocks", () => {
    const perp = signalTickerChartSelection({
      activeVenue: mobileFeedTickerClickVenue("all"),
      source: {
        symbol: "SOL",
        signalId: "perp-row-1",
        content: "long SOL",
      },
      perp: { coin: "SOL", side: "long" },
    });
    const stock = stockChartSelection({
      symbol: "AAPL",
      signalId: "stock-row-1",
      content: "long AAPL",
    });

    expect(perp).toMatchObject({
      symbol: "SOL",
      signalId: "perp-row-1",
      venue: "perps",
    });
    expect(stock).toMatchObject({
      symbol: "AAPL",
      signalId: "stock-row-1",
      venue: "stocks",
    });
  });

  test("selects exactly one of Markets, Traders, and Account and keeps Search/Chart contextual", () => {
    const common = {
      markets: marketsProps(),
      search: marker("search"),
      chart: marker("chart"),
      traders: tradersProps(),
      account: accountProps(),
    };

    const cases = [
      ["markets", "market-browse"],
      ["traders", "signal-feed"],
      ["account", "positions"],
      ["search", "search"],
      ["chart", "chart"],
    ] as const;

    for (const [screen, expectedMarker] of cases) {
      const markup = renderToStaticMarkup(
        renderMobileV2Destination({ ...common, screen }),
      );
      expect(markup).toContain(`data-mobile-marker="${expectedMarker}"`);
      const allMarkers = [
        "market-browse",
        "signal-feed",
        "copy-feed",
        "x-callers",
        "users",
        "watchlist",
        "positions",
        "search",
        "chart",
      ].filter((name) => markup.includes(`data-mobile-marker="${name}"`));
      expect(allMarkers).toEqual([expectedMarker]);
    }
  });

  test("mounts one Traders tab at a time: the feed, a Copy surface, or the watchlist", () => {
    const cases = [
      ["feed", "signal-feed"],
      ["following", "copy-feed"],
      ["x-callers", "x-callers"],
      ["users", "users"],
      ["watchlist", "watchlist"],
    ] as const;

    for (const [activeTab, expectedMarker] of cases) {
      const markup = renderToStaticMarkup(
        renderMobileV2Destination({
          screen: "traders",
          markets: marketsProps(),
          search: marker("search"),
          chart: marker("chart"),
          traders: tradersProps({ activeTab }),
          account: accountProps(),
        }),
      );
      const mounted = [
        "signal-feed",
        "copy-feed",
        "x-callers",
        "users",
        "watchlist",
      ].filter((name) => markup.includes(`data-mobile-marker="${name}"`));
      expect(mounted).toEqual([expectedMarker]);
      expect(markup).toContain('data-testid="mobile-traders-screen"');
    }
  });

  test("keeps venue-aware Feed filters and real market identity in supplied panels", () => {
    const changes: string[] = [];
    const feed = feedProps({
      venueFilter: "perps",
      onVenueFilterChange: (value) => changes.push(value),
      signalFeed: createElement(
        "button",
        { type: "button", "data-market": "xyz:GOOGL", onClick: () => changes.push("copy") },
        "Copy perp",
      ),
    });
    const tree = renderMobileV2Destination({
      screen: "traders",
      markets: marketsProps(),
      search: marker("search"),
      chart: createElement("div", { "data-market": "xyz:GOOGL" }, "chart"),
      traders: tradersProps({ feed: createElement(MobileFeedPanel, feed) }),
      account: accountProps(),
    });
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("Perps");
    expect(markup).toContain('data-market="xyz:GOOGL"');
    expect(markup).toContain('data-testid="mobile-traders-screen"');
    expect(markup).toContain('data-testid="mobile-feed-panel"');
  });

  test("fails closed when a stale Perps Feed scope meets an unavailable deployment", () => {
    const tree = renderMobileV2Destination({
      screen: "traders",
      markets: marketsProps(),
      search: marker("search"),
      chart: marker("chart"),
      traders: tradersProps({
        feed: createElement(
          MobileFeedPanel,
          feedProps({ venueFilter: "perps", perpsAvailable: false }),
        ),
      }),
      account: accountProps(),
    });
    const markup = renderToStaticMarkup(tree);

    expect(markup).not.toContain(">Perps<");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>All</);
  });

  test("mounts one Trade overlay above the same shell without changing destination content", () => {
    const markup = renderToStaticMarkup(
      renderMobileV2Shell({
        screen: "chart",
        header: createElement("header", null, "global mobile header"),
        navigation: marker("navigation"),
        overlay: marker("trade-overlay"),
        markets: marketsProps(),
        search: marker("search"),
        chart: createElement("div", { "data-market": "BTC", "data-mobile-marker": "chart" }, "chart"),
        traders: tradersProps(),
        account: accountProps(),
      }),
    );
    expect(markup.match(/data-mobile-v2-frame="true"/g)?.length).toBe(1);
    expect(markup.match(/data-mobile-v2-content="true"/g)?.length).toBe(1);
    expect(markup.match(/data-mobile-v2-navigation-slot="true"/g)?.length).toBe(1);
    expect(markup).toContain('data-mobile-marker="trade-overlay"');
    expect(markup).toContain('data-market="BTC"');
    expect(markup).not.toContain("tools");
  });

  test("places the recovery alert between the mobile header and scroll region", () => {
    const markup = renderToStaticMarkup(
      renderMobileV2Shell({
        screen: "chart",
        header: createElement("header", null, "global mobile header"),
        notice: createElement(
          "div",
          { role: "alert", "data-testid": "alpaca-recovery" },
          "Re-enter your Alpaca key pair",
        ),
        navigation: marker("navigation"),
        markets: marketsProps(),
        search: marker("search"),
        chart: marker("chart"),
        traders: tradersProps(),
        account: accountProps(),
      }),
    );
    const headerEnd = markup.indexOf("</header>");
    const notice = markup.indexOf('data-testid="alpaca-recovery"');
    const main = markup.indexOf("<main");

    expect(headerEnd).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(headerEnd);
    expect(notice).toBeLessThan(main);
  });

  test("wraps contextual Search and Chart in the shared bounded destination shell", () => {
    const common = {
      markets: marketsProps(),
      search: marker("search"),
      chart: marker("chart"),
      traders: tradersProps(),
      account: accountProps(),
    };

    for (const screen of ["search", "chart"] as const) {
      const markup = renderToStaticMarkup(
        renderMobileV2Destination({ ...common, screen }),
      );
      const shell = markup.match(
        /<div[^>]*data-mobile-v2-destination-shell="true"[^>]*class="([^"]+)"/,
      )?.[1];

      expect(shell).toBeDefined();
      expect(shell).toContain("max-w-[760px]");
      expect(shell).toContain("px-3");
      expect(shell).toContain("sm:px-4");
      expect(shell).toContain("min-w-0");
      expect(shell).toContain("pb-8");
      expect(shell).not.toContain("h-full");
      expect(shell).not.toContain("min-h-0");
      expect(shell).not.toContain("flex-1");
      expect(shell).not.toContain("overflow-y-auto");
      expect(markup).toContain(`data-mobile-marker="${screen}"`);
    }
  });

  test("keeps contextual Search compact, pinned, natural-flow, and handler-complete", () => {
    type SearchSurfaceProps = {
      query: string;
      inputRef: { current: HTMLInputElement | null };
      searchDisabled: boolean;
      onBack: () => void;
      onQueryChange: (value: string) => void;
      onClear: () => void;
      onSubmit: (event: unknown) => void;
      browse: ReactNode;
    };
    type SearchSurface = (props: SearchSurfaceProps) => ReactNode;
    const searchSurface = (
      tradingAppContent as unknown as {
        MobileSearchSurface?: SearchSurface;
      }
    ).MobileSearchSurface;

    expect(typeof searchSurface).toBe("function");
    if (!searchSurface) return;

    const calls: string[] = [];
    const tree = searchSurface({
      query: "BTC",
      inputRef: { current: null },
      searchDisabled: false,
      onBack: () => calls.push("back"),
      onQueryChange: (value) => calls.push(`query:${value}`),
      onClear: () => calls.push("clear"),
      onSubmit: () => calls.push("submit"),
      browse: createElement(
        "div",
        { "data-mobile-search-results": "true" },
        createElement(
          "div",
          { "data-mobile-market-filters": "true" },
          "All Stocks Perps People",
        ),
        createElement("button", { type: "button" }, "BTC perps"),
      ),
    });
    const markup = renderToStaticMarkup(tree);
    const surfaceClass =
      markup.match(
        /data-mobile-search-surface="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";
    const headerClass =
      markup.match(
        /data-mobile-search-header="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";
    const formClass =
      markup.match(
        /data-mobile-search-form="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";

    expect(markup).toContain('data-mobile-search-surface="true"');
    expect(markup).toContain('data-mobile-search-results="true"');
    expect(markup).toContain('aria-label="Back from search"');
    expect(markup).toContain('aria-label="Search markets"');
    expect(markup).toContain('aria-label="Open the searched market"');
    expect(headerClass).toContain("sticky");
    expect(headerClass).toContain("top-0");
    expect(headerClass).toContain("z-20");
    expect(surfaceClass).not.toContain("h-full");
    expect(surfaceClass).not.toContain("min-h-0");
    expect(surfaceClass).not.toContain("flex-1");
    expect(surfaceClass).not.toContain("overflow-y-auto");
    expect(formClass).not.toContain("rounded-2xl");
    expect(formClass).not.toContain("bg-card");

    click(findByAriaLabel(tree, "Back from search"));
    click(findByAriaLabel(tree, "Clear market search"));
    const input = findByAriaLabel(tree, "Search markets");
    (input?.props.onChange as
      | ((event: { target: { value: string } }) => void)
      | undefined)?.({ target: { value: "ETH" } });
    const form = flattenElements(tree).find((element) => element.type === "form");
    (form?.props.onSubmit as ((event: unknown) => void) | undefined)?.({
      preventDefault: () => {},
    });

    expect(calls).toEqual(["back", "clear", "query:ETH", "submit"]);
  });

  test("keeps the controller-owned Account portfolio surface in frame flow", () => {
    type PortfolioSurfaceProps = {
      summary: {
        rows: Array<{
          venue: "stocks" | "perps";
          label: string;
          value: number | null;
          buyingPower: number | null;
        }>;
        total: number | null;
        totalComplete: boolean;
        hasUnresolvedVenue: boolean;
        venueCheckFailed: boolean;
      };
      navigation: {
        view: "overview" | "stocks" | "perps";
        canReturnToOverview: boolean;
      };
      onViewChange: (view: "overview" | "stocks" | "perps") => void;
      stocksSurface: ReactNode;
      perpsSurface: ReactNode;
    };
    type PortfolioSurface = (props: PortfolioSurfaceProps) => ReactNode;
    const portfolioSurface = (
      tradingAppContent as unknown as {
        MobilePortfolioPanel?: PortfolioSurface;
      }
    ).MobilePortfolioPanel;

    expect(typeof portfolioSurface).toBe("function");
    if (!portfolioSurface) return;

    const summary = {
      rows: [
        {
          venue: "stocks" as const,
          label: "Stocks & options",
          value: 12_345.67,
          buyingPower: 4_000,
        },
      ],
      total: 12_345.67,
      totalComplete: true,
      hasUnresolvedVenue: false,
      venueCheckFailed: false,
    };
    const overviewMarkup = renderToStaticMarkup(
      portfolioSurface({
        summary,
        navigation: { view: "overview", canReturnToOverview: false },
        onViewChange: () => {},
        stocksSurface: createElement("div", { "data-testid": "stocks-surface" }),
        perpsSurface: createElement("div", { "data-testid": "perps-surface" }),
      }),
    );
    const overviewClass =
      overviewMarkup.match(
        /data-mobile-portfolio-overview="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";

    expect(overviewClass).not.toContain("h-full");
    expect(overviewClass).not.toContain("min-h-0");
    expect(overviewClass).not.toContain("overflow-y-auto");
    expect(overviewClass).not.toContain("overscroll-contain");

    const detailMarkup = renderToStaticMarkup(
      portfolioSurface({
        summary,
        navigation: { view: "stocks", canReturnToOverview: true },
        onViewChange: () => {},
        stocksSurface: createElement("div", { "data-testid": "stocks-surface" }),
        perpsSurface: createElement("div", { "data-testid": "perps-surface" }),
      }),
    );
    const detailClass =
      detailMarkup.match(
        /data-mobile-portfolio-detail="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";
    const detailSurfaceClass =
      detailMarkup.match(
        /data-mobile-portfolio-detail-surface="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";

    expect(detailClass).not.toContain("h-full");
    expect(detailClass).not.toContain("min-h-0");
    expect(detailClass).not.toContain("overflow-hidden");
    expect(detailSurfaceClass).not.toContain("min-h-0");
    expect(detailSurfaceClass).not.toContain("flex-1");
    expect(detailSurfaceClass).not.toContain("overflow-hidden");
    expect(detailMarkup).toContain('data-testid="stocks-surface"');
  });

  // The venue used to be a bar pinned between the app header and `main` on
  // every destination except Markets: 49px of permanent chrome, including on
  // Account and Search, where nothing reads the venue at all. It is routed
  // now, so the shell itself paints no venue slot and the control reaches only
  // the destinations whose content it scopes.
  test("the shell paints no venue slot of its own on any destination", () => {
    for (const screen of [
      "markets",
      "traders",
      "search",
      "chart",
      "account",
    ] as const) {
      const markup = renderToStaticMarkup(
        renderMobileV2Shell({
          screen,
          header: marker("header"),
          navigation: marker("navigation"),
          markets: marketsProps(),
          search: marker("search"),
          chart: marker("chart"),
          traders: tradersProps(),
          account: accountProps(),
        }),
      );

      expect(markup).not.toContain('data-mobile-v2-venue-bar="true"');
      expect(markup).not.toContain('data-mobile-venue-bar="true"');
    }
  });

  test("routes the venue switch to the destinations that read it, and nowhere else", () => {
    const switchFor = tradingAppContent.mobileVenueSwitchForScreen;

    // Trade, Markets and Traders each read the venue; Account renders both
    // venues at once and Search owns its own browse scope, so neither pays a
    // control for a venue they never consult.
    for (const screen of ["chart", "markets", "traders"] as const) {
      expect(switchFor(screen, true)).not.toBeNull();
    }
    for (const screen of ["account", "search"] as const) {
      expect(switchFor(screen, false)).toBeNull();
      expect(switchFor(screen, true)).toBeNull();
    }

    // A deployment without perps has no second venue to switch to, so no
    // destination hosts the control and none of them pays a cell for it.
    for (const screen of ["chart", "markets", "traders"] as const) {
      expect(switchFor(screen, false)).toBeNull();
    }
  });

  test("isolates the mobile frame behind an open modal while keeping the modal outside that inert subtree", () => {
    const markup = renderToStaticMarkup(
      renderMobileV2Shell({
        screen: "chart",
        header: marker("header"),
        navigation: marker("navigation"),
        overlay: marker("modal"),
        markets: marketsProps(),
        search: marker("search"),
        chart: marker("chart"),
        traders: tradersProps(),
        account: accountProps(),
      }),
    );
    const background = markup.match(
      /<div[^>]*data-mobile-v2-background="true"[^>]*>/,
    )?.[0];

    expect(background).toBeDefined();
    expect(background).toContain('aria-hidden="true"');
    expect(background).toContain('inert=""');
    expect(markup).toContain('data-mobile-marker="modal"');
    expect(markup.indexOf('data-mobile-marker="modal"')).toBeGreaterThan(
      markup.indexOf("data-mobile-v2-background"),
    );
    expect(markup.lastIndexOf('data-mobile-marker="modal"')).toBeGreaterThan(
      markup.lastIndexOf('data-mobile-v2-frame="true"'),
    );
  });

  test("global Search is one header action and contextual Back follows URL origin", () => {
    const calls: string[] = [];
    const header = MobileV2Header({
      title: "Traders",
      onOpenMenu: () => calls.push("menu"),
      onOpenSearch: () => calls.push("search"),
      accountValue: "$12.4K",
      accountValueState: "available",
    });
    expect(flattenElements(header).filter((element) => element.type === "header").length).toBe(1);
    const search = findByAriaLabel(header, "Search");
    expect(search).toBeDefined();
    (search as { props?: { onClick?: () => void } } | undefined)?.props?.onClick?.();
    expect(calls).toEqual(["search"]);

    // A live pre-merge link: the Feed origin now names the Traders destination.
    const deepLink = parseMobileLocation(
      "?screen=chart&origin=feed&venue=perps&symbol=xyz%3AGOOGL",
    );
    expect(deepLink.market).toEqual({ symbol: "xyz:GOOGL", venue: "perps" });
    expect(mobileBackTarget(deepLink)).toBe("traders");
  });

  test("names Chart Back for its contextual target, with a safe previous-screen fallback", () => {
    expect(mobileChartBackLabel({ screen: "chart", origin: "traders" })).toBe(
      "Back to Traders",
    );
    expect(mobileChartBackLabel({ screen: "chart", origin: "markets" })).toBe(
      "Back to Markets",
    );
    expect(mobileChartBackLabel({ screen: "chart", origin: "search" })).toBe(
      "Back to Search",
    );
    expect(mobileChartBackLabel({ screen: "chart", origin: null })).toBe(
      "Back to previous screen",
    );
  });

  test("consumes nested contextual pushes before browser Back", () => {
    const entries = ["?returnTo=%2Fapp&legacy=1"];
    let index = 0;

    const write = (
      state: Parameters<typeof serializeMobileLocation>[0],
      mode: "push" | "replace",
    ) => {
      const next = mergeMobileLocationSearch(
        entries[index] ?? "",
        serializeMobileLocation(state),
      );
      if (mode === "push") {
        entries.splice(index + 1);
        entries.push(next);
        index += 1;
      } else {
        entries[index] = next;
      }
      return parseMobileLocation(entries[index], DEFAULT_MOBILE_LOCATION);
    };

    write({ ...DEFAULT_MOBILE_LOCATION, screen: "traders" }, "push");
    write(
      { ...DEFAULT_MOBILE_LOCATION, screen: "search", origin: "traders" },
      "push",
    );
    const chart = write(
      {
        ...DEFAULT_MOBILE_LOCATION,
        screen: "chart",
        origin: "search",
        market: { symbol: "xyz:GOOGL", venue: "perps" },
      },
      "push",
    );
    expect(mobileBackTarget(chart)).toBe("search");

    expect(mobileBackHistoryMode(chart, { [MOBILE_HISTORY_PUSH_MARKER]: true })).toBe(
      "pop",
    );
    index -= 1;
    const searchAfterChartBack = parseMobileLocation(
      entries[index],
      DEFAULT_MOBILE_LOCATION,
    );
    expect(mobileBackTarget(searchAfterChartBack)).toBe("traders");

    expect(
      mobileBackHistoryMode(searchAfterChartBack, {
        [MOBILE_HISTORY_PUSH_MARKER]: true,
      }),
    ).toBe("pop");
    index -= 1;
    const feedAfterSearchBack = parseMobileLocation(
      entries[index],
      DEFAULT_MOBILE_LOCATION,
    );
    expect(feedAfterSearchBack.screen).toBe("traders");
    expect(feedAfterSearchBack.origin).toBeNull();
    expect(entries[index]).toContain("returnTo=%2Fapp");
    expect(entries[index]).toContain("legacy=1");

    // A subsequent browser Back reaches the initial surrounding route (which
    // parses to the Trade home) rather than resurrecting the stale Search
    // entry.
    index -= 1;
    const popped = parseMobileLocation(entries[index], DEFAULT_MOBILE_LOCATION);
    expect(popped.screen).toBe("chart");
    expect(popped.origin).toBeNull();
    expect(popped.market).toBeNull();
  });
});

describe("premium mobile trade surfaces", () => {
  const balance = { short: "$12.4K", long: "$12,400.00" };
  const account = {
    id: "paper-account",
    accountId: "PA123",
    accountType: "PAPER",
    username: "trader",
  };

  test("gives the navigation drawer an explicit modal name and polished backdrop", () => {
    const markup = renderToStaticMarkup(
      <MobileV2Menu
        onNavigateSection={() => {}}
        active="markets"
        paperAccount={account}
        liveAccount={{ ...account, id: "live-account", accountType: "LIVE" }}
        accountMode="PAPER"
        balance={balance}
        onAccountModeChange={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('data-mobile-v2-menu="true"');
    expect(markup).toContain('aria-labelledby="mobile-navigation-title"');
    expect(markup).toContain('id="mobile-navigation-title"');
    expect(markup).toContain('data-mobile-menu-backdrop="true"');
    expect(markup).toContain("backdrop-blur");
    expect(markup).toContain("overscroll-contain");
  });

  test("lists Trade as a destination while keeping destination identity and balance", () => {
    const markup = renderToStaticMarkup(
      <MobileV2Menu
        onNavigateSection={() => {}}
        active="traders"
        accountMode="PAPER"
        balance={balance}
        onAccountModeChange={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Trade"');
    expect(markup).not.toContain("Open trade ticket");
    expect(markup).toContain('data-mobile-menu-destinations="true"');
    expect(markup).toContain("Markets");
    expect(markup).toContain("Traders");
    expect(markup).toContain("Account");
    expect(markup).toContain("$12.4K");
  });

  test("keeps touch, focus, safe-area, and account-mode affordances explicit", () => {
    const markup = renderToStaticMarkup(
      <MobileV2Menu
        onNavigateSection={() => {}}
        active="account"
        paperAccount={account}
        liveAccount={{ ...account, id: "live-account", accountType: "LIVE" }}
        accountMode="LIVE"
        onAccountModeChange={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("env(safe-area-inset-top)");
    expect(markup).toContain("env(safe-area-inset-bottom)");
    expect(markup).toContain("touch-manipulation");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain('data-mobile-menu-account-mode="true"');
    expect(markup).toContain("Execution mode");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Live");
  });

  test("gives the trade sheet a named surface and an inset-aware backdrop", () => {
    const markup = renderToStaticMarkup(
      <MobileTradeSheet
        sectionRef={{ current: null }}
        marketHeader={{
          symbol: "AAPL",
          showPerpTag: false,
          quoteLine: "$198.20 · +0.4%",
          tone: "positive",
        }}
        isPerps={false}
        onChangeMarket={() => {}}
        onClose={() => {}}
      >
        <div data-testid="real-trade-form">real trade form</div>
      </MobileTradeSheet>,
    );

    expect(markup).toContain('data-mobile-trade-sheet="true"');
    expect(markup).toContain('data-mobile-trade-sheet-surface="true"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Trade AAPL"');
    expect(markup).toContain('data-mobile-trade-sheet-backdrop="true"');
    expect(markup).toContain("backdrop-blur");
    expect(markup).toContain("min-h-[100dvh]");
    expect(markup).toContain("env(safe-area-inset-top)");
    expect(markup).toContain('data-testid="real-trade-form"');
  });

  test("presents Trade as a bounded bottom sheet with an internal scroller", () => {
    const markup = renderToStaticMarkup(
      <MobileTradeSheet
        sectionRef={{ current: null }}
        marketHeader={{
          symbol: "AAPL",
          showPerpTag: false,
          quoteLine: "$198.20 · +0.4%",
          tone: "positive",
        }}
        isPerps={false}
        onChangeMarket={() => {}}
        onClose={() => {}}
      >
        <div className="sticky bottom-0" data-testid="real-trade-cta">
          real sticky trade CTA
        </div>
      </MobileTradeSheet>,
    );

    expect(markup).toContain("items-end");
    expect(markup).toContain("h-[100dvh]");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(markup).toContain('data-testid="real-trade-cta"');
    expect(markup).toContain("sticky");
  });

  test("keeps the trade sheet market switch and close controls touch-safe", () => {
    const markup = renderToStaticMarkup(
      <MobileTradeSheet
        sectionRef={{ current: null }}
        marketHeader={{
          symbol: "BTC",
          showPerpTag: true,
          quoteLine: "$102,320 · +1.2%",
          tone: "positive",
        }}
        isPerps
        onChangeMarket={() => {}}
        onClose={() => {}}
      >
        <div data-testid="real-perp-form">real perp form</div>
      </MobileTradeSheet>,
    );

    expect(markup).toContain('aria-label="Trading BTC. Tap to change ticker."');
    expect(markup).toContain('aria-label="Close trade ticket"');
    expect(markup).toContain('data-mobile-trade-sheet-market="BTC"');
    expect(markup).toContain("touch-manipulation");
    expect(markup).toContain("active:scale");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("Perp");
    expect(markup).toContain('data-testid="real-perp-form"');
  });

  test("bounds the trade sheet around safe areas and disables motion when requested", () => {
    const markup = renderToStaticMarkup(
      <MobileTradeSheet
        sectionRef={{ current: null }}
        marketHeader={{
          symbol: "AAPL",
          showPerpTag: false,
          quoteLine: "$198.20 · +0.4%",
          tone: "positive",
        }}
        isPerps={false}
        onChangeMarket={() => {}}
        onClose={() => {}}
      >
        <div>real trade form</div>
      </MobileTradeSheet>,
    );
    const surfaceClass =
      markup.match(
        /data-mobile-trade-sheet-surface="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";

    expect(markup).toContain('data-mobile-trade-sheet-handle="true"');
    expect(surfaceClass).toContain("h-[100dvh]");
    expect(surfaceClass).toContain("motion-safe:animate-in");
    expect(surfaceClass).toContain("motion-safe:slide-in-from-bottom-");
    expect(surfaceClass).toContain("motion-reduce:animate-none");
    expect(surfaceClass).toContain("motion-reduce:transition-none");
    expect(surfaceClass).toContain("motion-reduce:duration-0");
  });

  test("keeps the mobile menu a left drawer with a reduced-motion fallback", () => {
    const markup = renderToStaticMarkup(
      <MobileV2Menu
        onNavigateSection={() => {}}
        active="markets"
        accountMode="PAPER"
        onAccountModeChange={() => {}}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    const drawerClass =
      markup.match(
        /data-mobile-menu-surface="true"[^>]*class="([^"]+)"/,
      )?.[1] ?? "";

    expect(markup).toContain('data-mobile-menu-drawer="left"');
    expect(drawerClass).toContain("left-0");
    expect(drawerClass).toContain("motion-safe:animate-in");
    expect(drawerClass).toContain("motion-safe:slide-in-from-left-");
    expect(drawerClass).toContain("motion-reduce:animate-none");
    expect(drawerClass).toContain("motion-reduce:transition-none");
    expect(drawerClass).toContain("motion-reduce:duration-0");
  });

  test("routes the trade sheet controls through the supplied close and market handlers", () => {
    const calls: string[] = [];
    const tree = MobileTradeSheet({
      sectionRef: { current: null },
      marketHeader: {
        symbol: "MSFT",
        showPerpTag: false,
        quoteLine: "$410.12 · -0.2%",
        tone: "negative",
      },
      isPerps: false,
      onChangeMarket: () => calls.push("change-market"),
      onClose: () => calls.push("close"),
      children: <div data-testid="real-trade-form">real trade form</div>,
    });

    click(findByAriaLabel(tree, "Trading MSFT. Tap to change ticker."));
    click(findByAriaLabel(tree, "Close trade ticket"));

    expect(calls).toEqual(["change-market", "close"]);
  });

  test("dismisses the bottom-sheet scrim through the existing close handler", () => {
    const calls: string[] = [];
    const tree = MobileTradeSheet({
      sectionRef: { current: null },
      marketHeader: {
        symbol: "MSFT",
        showPerpTag: false,
        quoteLine: "$410.12 · -0.2%",
        tone: "negative",
      },
      isPerps: false,
      onChangeMarket: () => calls.push("change-market"),
      onClose: () => calls.push("close"),
      children: <div data-testid="real-trade-form">real trade form</div>,
    });

    click(findByAriaLabel(tree, "Dismiss trade ticket"));

    expect(calls).toEqual(["close"]);
  });
});

describe("premium mobile chart surface", () => {
  const stockQuote = {
    last: "198.2",
    changePercent: "1.25",
    bid: "198.1",
    ask: "198.3",
    low: "195",
    high: "200",
    volume: "1.2M",
  };
  const perpSnapshot = {
    markPx: "102320",
    midPx: "102319.5",
    prevDayPx: "100000",
    bid: "102319",
    ask: "102321",
    funding: "0.0001",
    dayNtlVlm: "123456789",
  };
  const perpQuote = {
    price: "$102,320.00",
    dayChange: "+2.32%",
    dayChangeTone: "positive" as const,
    bidAsk: "$102,319.00 / $102,321.00",
    hasData: true,
  };
  const missingPerpQuote = {
    price: "-",
    dayChange: "-",
    dayChangeTone: "neutral" as const,
    bidAsk: "-",
    hasData: false,
  };

  test("gives an equity chart a prominent live price, change, compact metrics, and expand target", () => {
    const calls: string[] = [];
    const tree = MobileChartMarketSummary({
      symbol: "AAPL",
      isPerps: false,
      stockQuote,
      perpSnapshot: undefined,
      perpQuote: missingPerpQuote,
      onExpand: () => calls.push("expand"),
    });
    const markup = renderToStaticMarkup(tree);

    expect(markup).toContain('data-mobile-chart-market-summary="true"');
    expect(markup).toContain('data-mobile-chart-primary-value="true"');
    expect(markup).toMatch(/font-data text-\[2\.25rem\]/);
    expect(markup).toContain("tabular-nums");
    // One caption names the number. It is not followed by "Price" again.
    expect(markup).toContain(">Live price<");
    expect(markup).not.toContain(">Price<");
    expect((markup.match(/data-mobile-chart-caption="true"/g) ?? []).length).toBe(1);
    expect(markup).toContain(">$198.20<");
    expect(markup).toContain('data-mobile-chart-change="true"');
    expect(markup).toContain(">+1.25%<");
    expect(markup).toContain('data-mobile-chart-metrics="true"');
    expect(markup).toContain("Bid / Ask");
    expect(markup).toContain('aria-label="Expand chart"');
    expect(markup).toContain('data-mobile-chart-action="expand"');
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("min-w-11");

    click(findByAriaLabel(tree, "Expand chart"));
    expect(calls).toEqual(["expand"]);
  });

  test("wraps long prices and changes instead of truncating them at phone width", () => {
    const tree = MobileChartMarketSummary({
      symbol: "LONG",
      isPerps: false,
      stockQuote: {
        last: "12345678901234567890",
        changePercent: "98765432109876543210",
      },
      perpSnapshot: undefined,
      perpQuote: missingPerpQuote,
      onExpand: () => {},
    });
    const elements = flattenElements(tree);
    const primary = elements.find(
      (element) => element.props["data-mobile-chart-primary-value"] === "true",
    );
    const change = elements.find(
      (element) => element.props["data-mobile-chart-change"] === "true",
    );
    const primaryClass = String(primary?.props.className);
    const changeClass = String(change?.props.className);

    expect(elementText(primary)).toContain("$");
    expect(elementText(change)).toContain("%");
    expect(primaryClass).toContain("whitespace-normal");
    expect(primaryClass).toContain("break-all");
    expect(primaryClass).not.toContain("truncate");
    expect(changeClass).toContain("whitespace-normal");
    expect(changeClass).toContain("break-all");
    expect(changeClass).not.toContain("truncate");
  });

  test("uses a real perp mark and change while keeping venue metrics distinct", () => {
    const markup = renderToStaticMarkup(
      <MobileChartMarketSummary
        symbol="BTC"
        isPerps
        stockQuote={undefined}
        perpSnapshot={perpSnapshot}
        perpQuote={perpQuote}
        onExpand={() => {}}
      />,
    );

    expect(markup).toContain(">Live mark<");
    expect(markup).not.toContain(">Mark<");
    expect(markup).toContain(">$102,320.00<");
    expect(markup).toContain(">+2.32%<");
    expect(markup).toContain("Funding / hr");
    expect(markup).toContain("24h Volume");
    expect(markup).toContain("$123.5M");
  });

  test("keeps unresolved price, change, and metrics honest instead of inventing zeros", () => {
    const markup = renderToStaticMarkup(
      <MobileChartMarketSummary
        symbol="AAPL"
        isPerps={false}
        stockQuote={undefined}
        perpSnapshot={undefined}
        perpQuote={missingPerpQuote}
        onExpand={() => {}}
      />,
    );

    expect(markup).toContain(">-<");
    expect(markup).not.toContain("0.00%");
    expect(markup).not.toContain("$0.00");
    expect(markup).toContain('data-mobile-chart-unresolved="true"');
    // An unresolved number is named, not called live.
    expect(markup).toContain(">Price<");
    expect(markup).not.toContain("Live price");
  });

  test("sizes the News/AI panel from the viewport so short screens keep the read visible", () => {
    const markup = renderToStaticMarkup(
      <MobileChartInsights>
        <div data-testid="chart-insight-content">News content</div>
      </MobileChartInsights>,
    );

    expect(markup).toContain('data-mobile-chart-insights="true"');
    expect(markup).toContain("h-[min(420px,calc(100dvh-15rem))]");
    expect(markup).toContain("max-h-[calc(100dvh-15rem)]");
    expect(markup).toContain("min-h-[min(14rem,calc(100dvh-15rem))]");
    expect(markup).toContain("overflow-y-auto");
    // Scroll must chain to the page at the box edges, otherwise a drag inside a
    // barely-overflowing positions table goes nowhere on mobile.
    expect(markup).toContain("overscroll-auto");
    expect(markup).not.toContain("overscroll-contain");
    expect(markup).toContain("touch-pan-y");
    expect(markup).toContain('data-testid="chart-insight-content"');
  });
});
