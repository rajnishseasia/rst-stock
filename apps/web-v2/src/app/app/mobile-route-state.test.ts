import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MOBILE_ROUTE_STATE,
  canonicalMobileRouteParams,
  mobileSearchRouteContext,
  parseMobileRouteState,
} from "./mobile-route-state";

describe("mobile app route state", () => {
  test("parses compact screen and active-tab deep links", () => {
    expect(parseMobileRouteState(new URLSearchParams("s=copy&t=users"))).toMatchObject({
      screen: "copy",
      copyTab: "users",
    });
    expect(
      parseMobileRouteState(new URLSearchParams("s=tools&t=portfolio-perps")),
    ).toMatchObject({
      screen: "tools",
      toolsTab: "portfolio",
      portfolioView: "perps",
    });
    expect(parseMobileRouteState(new URLSearchParams("t=watchlist"))).toMatchObject({
      screen: "markets",
      feedTab: "watchlist",
    });
  });

  test("normalizes missing and invalid values to the visible UI defaults", () => {
    expect(parseMobileRouteState(new URLSearchParams("screen=nope&horizon=30"))).toEqual(
      DEFAULT_MOBILE_ROUTE_STATE,
    );
  });

  test("keeps the default home route free of invisible defaults", () => {
    const current = new URLSearchParams("symbol=SOL&screen=bad");
    const canonical = canonicalMobileRouteParams(current, DEFAULT_MOBILE_ROUTE_STATE);

    expect(canonical.get("symbol")).toBe("SOL");
    expect(canonical.get("s")).toBeNull();
    expect(canonical.get("t")).toBeNull();
    expect([...canonical.keys()]).toEqual(["symbol"]);
  });

  test("normalizes verbose links to at most screen and tab", () => {
    const verbose = new URLSearchParams(
      "screen=copy&feedTab=signals&chartTab=news&copyTab=users&toolsTab=positions" +
      "&portfolioView=overview&browseTab=all&xWindow=7d&xSort=calls&horizon=7" +
      "&usersWindow=30d&usersSort=winRate",
    );
    const canonical = canonicalMobileRouteParams(
      verbose,
      parseMobileRouteState(verbose),
    );

    expect(canonical.toString()).toBe("s=copy&t=users");
    expect([...canonical.keys()]).toHaveLength(2);
  });

  test("preserves a legacy portfolio drill-down while compacting it", () => {
    const verbose = new URLSearchParams(
      "screen=tools&toolsTab=portfolio&portfolioView=perps",
    );
    const canonical = canonicalMobileRouteParams(
      verbose,
      parseMobileRouteState(verbose),
    );

    expect(canonical.toString()).toBe("s=tools&t=portfolio-perps");
  });

  test("gives every app surface one unique URL with no more than two route params", () => {
    const cases = [
      { state: DEFAULT_MOBILE_ROUTE_STATE, href: "/app" },
      {
        state: { ...DEFAULT_MOBILE_ROUTE_STATE, feedTab: "watchlist" as const },
        href: "/app?t=watchlist",
      },
      {
        state: { ...DEFAULT_MOBILE_ROUTE_STATE, feedTab: "signa" as const },
        href: "/app?t=signa",
      },
      {
        state: { ...DEFAULT_MOBILE_ROUTE_STATE, screen: "search" as const },
        href: "/app?s=search",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "search" as const,
          browseTab: "stocks" as const,
        },
        href: "/app?s=search&t=stocks",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "search" as const,
          browseTab: "perps" as const,
        },
        href: "/app?s=search&t=perps",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "search" as const,
          browseTab: "people" as const,
        },
        href: "/app?s=search&t=people",
      },
      {
        state: { ...DEFAULT_MOBILE_ROUTE_STATE, screen: "chart" as const },
        href: "/app?s=chart",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "chart" as const,
          chartTab: "ai" as const,
        },
        href: "/app?s=chart&t=ai",
      },
      {
        state: { ...DEFAULT_MOBILE_ROUTE_STATE, screen: "copy" as const },
        href: "/app?s=copy",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "copy" as const,
          copyTab: "x-callers" as const,
        },
        href: "/app?s=copy&t=x-callers",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "copy" as const,
          copyTab: "users" as const,
        },
        href: "/app?s=copy&t=users",
      },
      {
        state: { ...DEFAULT_MOBILE_ROUTE_STATE, screen: "tools" as const },
        href: "/app?s=tools",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "tools" as const,
          toolsTab: "closed" as const,
        },
        href: "/app?s=tools&t=closed",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "tools" as const,
          toolsTab: "orders" as const,
        },
        href: "/app?s=tools&t=orders",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "tools" as const,
          toolsTab: "portfolio" as const,
        },
        href: "/app?s=tools&t=portfolio",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "tools" as const,
          toolsTab: "portfolio" as const,
          portfolioView: "stocks" as const,
        },
        href: "/app?s=tools&t=portfolio-stocks",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "tools" as const,
          toolsTab: "portfolio" as const,
          portfolioView: "perps" as const,
        },
        href: "/app?s=tools&t=portfolio-perps",
      },
      {
        state: {
          ...DEFAULT_MOBILE_ROUTE_STATE,
          screen: "tools" as const,
          toolsTab: "ai" as const,
        },
        href: "/app?s=tools&t=ai",
      },
    ];

    const generatedHrefs = cases.map(({ state }) => {
      const compact = canonicalMobileRouteParams(new URLSearchParams(), state);
      expect([...compact.keys()].length).toBeLessThanOrEqual(2);
      expect(parseMobileRouteState(compact)).toMatchObject({
        screen: state.screen,
        feedTab: state.feedTab,
        chartTab: state.chartTab,
        copyTab: state.copyTab,
        toolsTab: state.toolsTab,
        portfolioView: state.portfolioView,
        browseTab: state.browseTab,
      });
      const query = compact.toString();
      return query ? `/app?${query}` : "/app";
    });

    expect(generatedHrefs).toEqual(cases.map(({ href }) => href));
    expect(new Set(generatedHrefs).size).toBe(cases.length);
    expect(cases).toHaveLength(19);
  });

  test("opens Search on the venue selected at the top of the app", () => {
    const perpsVenue = { defaultBrowseTab: "perps" as const };

    // No tab in the URL: the perps venue decides the Search screen's tab.
    expect(
      parseMobileRouteState(new URLSearchParams("s=search"), perpsVenue),
    ).toMatchObject({ screen: "search", browseTab: "perps" });
    // The stocks venue (no options) still lands on All.
    expect(parseMobileRouteState(new URLSearchParams("s=search"))).toMatchObject({
      browseTab: "all",
    });

    // An explicit pick outranks the venue in both directions.
    expect(
      parseMobileRouteState(new URLSearchParams("s=search&t=all"), perpsVenue),
    ).toMatchObject({ browseTab: "all" });
    expect(
      parseMobileRouteState(new URLSearchParams("s=search&t=people"), perpsVenue),
    ).toMatchObject({ browseTab: "people" });

    // Canonicalization omits whichever tab IS the default, so "All" on the perps
    // venue survives a round trip instead of parsing back to Perps.
    const allOnPerps = canonicalMobileRouteParams(
      new URLSearchParams(),
      { ...DEFAULT_MOBILE_ROUTE_STATE, screen: "search", browseTab: "all" },
      perpsVenue,
    );
    expect(allOnPerps.toString()).toBe("s=search&t=all");
    expect(parseMobileRouteState(allOnPerps, perpsVenue)).toMatchObject({
      browseTab: "all",
    });

    const perpsOnPerps = canonicalMobileRouteParams(
      new URLSearchParams(),
      { ...DEFAULT_MOBILE_ROUTE_STATE, screen: "search", browseTab: "perps" },
      perpsVenue,
    );
    expect(perpsOnPerps.toString()).toBe("s=search");
  });

  test("does not canonicalize an explicit Search tab before venue hydration", () => {
    const initial = mobileSearchRouteContext(null, true);
    const current = new URLSearchParams("s=search&t=all");

    expect(initial).toEqual({
      defaultBrowseTab: "all",
      canCanonicalize: false,
    });
    expect(parseMobileRouteState(current, initial)).toMatchObject({
      screen: "search",
      browseTab: "all",
    });

    const hydrated = mobileSearchRouteContext("perps", true);
    expect(hydrated.canCanonicalize).toBe(true);
    expect(
      canonicalMobileRouteParams(
        current,
        parseMobileRouteState(current, hydrated),
        hydrated,
      ).toString(),
    ).toBe("s=search&t=all");
  });
});
