import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MOBILE_LOCATION,
  mobileBackTarget,
  mergeMobileLocationSearch,
  parseMobileLocation,
  serializeMobileLocation,
  type MobileLocationState,
  type MobileLocationStateInput,
} from "./mobile-history";

const FALLBACK: MobileLocationState = {
  screen: "markets",
  origin: null,
  market: null,
  accountTab: "positions",
  tradersTab: "following",
};

describe("mobile URL/history codecs", () => {
  test("migrates compact legacy destinations into the v2 state", () => {
    expect(parseMobileLocation("?s=copy&t=users", FALLBACK)).toEqual({
      ...FALLBACK,
      screen: "traders",
      tradersTab: "users",
    });
    expect(parseMobileLocation("?s=tools&t=portfolio-perps", FALLBACK)).toEqual({
      ...FALLBACK,
      screen: "account",
      accountTab: "portfolio",
    });
    expect(parseMobileLocation("?s=search&t=people", FALLBACK)).toEqual({
      ...FALLBACK,
      screen: "search",
    });
    expect(parseMobileLocation("?t=watchlist", FALLBACK)).toEqual({
      ...FALLBACK,
      screen: "traders",
      tradersTab: "watchlist",
    });
  });

  test("migrates verbose legacy tabs and keeps canonical fields authoritative", () => {
    expect(
      parseMobileLocation("?screen=markets&s=markets&t=signals", FALLBACK),
    ).toMatchObject({
      screen: "markets",
    });
    expect(
      parseMobileLocation(
        "?screen=copy&s=tools&copyTab=users&t=x-callers&toolsTab=orders",
        FALLBACK,
      ),
    ).toEqual({
      ...FALLBACK,
      screen: "traders",
      tradersTab: "users",
    });
    expect(
      parseMobileLocation(
        "?s=tools&tab=closed&feedTab=watchlist&chartTab=ai&portfolioView=stocks",
        FALLBACK,
      ),
    ).toEqual({
      ...FALLBACK,
      screen: "account",
      accountTab: "closed",
    });
    expect(
      parseMobileLocation(
        "?screen=tools&toolsTab=portfolio&portfolioView=perps",
        FALLBACK,
      ),
    ).toMatchObject({
      screen: "account",
      accountTab: "portfolio",
    });
    expect(parseMobileLocation("?s=chart&chartTab=ai", FALLBACK)).toMatchObject({
      screen: "chart",
    });
    expect(parseMobileLocation("?s=search&browseTab=people", FALLBACK)).toMatchObject({
      screen: "search",
    });
    expect(parseMobileLocation("?s=copy&copyTab=feed", FALLBACK)).toEqual({
      ...FALLBACK,
      screen: "traders",
      tradersTab: "following",
    });
    expect(
      parseMobileLocation("?s=copy&t=users&copyTab=feed", FALLBACK),
    ).toMatchObject({
      screen: "traders",
      tradersTab: "users",
    });
  });

  test("canonicalizes legacy links without leaving contradictory route keys", () => {
    const serialized = serializeMobileLocation(
      parseMobileLocation(
        "?s=chart&t=ai&chartMarket=xyz%3AGOOGL&venue=perps&feedTab=watchlist",
        FALLBACK,
      ),
    );

    expect(serialized).toContain("symbol=xyz%3AGOOGL");
    expect(serialized).not.toContain("chartMarket");

    const merged = mergeMobileLocationSearch(
      "?returnTo=%2Fapp&s=chart&t=ai&tab=ai&feedTab=watchlist&chartTab=ai" +
        "&toolsTab=orders&portfolioView=perps&browseTab=people&legacy=1" +
        "&copyTab=users&copy=feed",
      serialized,
    );

    expect(merged).toBe(
      "?returnTo=%2Fapp&legacy=1&screen=chart&venue=perps&symbol=xyz%3AGOOGL" +
        "&tradersTab=following",
    );
    for (const key of [
      "s",
      "t",
      "tab",
      "feedTab",
      "chartTab",
      "toolsTab",
      "portfolioView",
      "browseTab",
      "copyTab",
      "copy",
    ]) {
      expect(merged).not.toContain(`${key}=`);
    }
  });

  test("round-trips a contextual chart location and active account/traders tabs", () => {
    const state: MobileLocationState = {
      screen: "chart",
      origin: "traders",
      market: { symbol: "xyz:GOOGL", venue: "perps" },
      accountTab: "portfolio",
      tradersTab: "x-callers",
    };

    expect(parseMobileLocation(serializeMobileLocation(state), FALLBACK)).toEqual(
      state,
    );
  });

  test("falls back safely for invalid screen, origin, market, and tab values", () => {
    const fallback: MobileLocationState = {
      screen: "account",
      origin: "markets",
      market: { symbol: "AAPL", venue: "stocks" },
      accountTab: "orders",
      tradersTab: "users",
    };

    expect(
      parseMobileLocation(
        "?screen=unknown&origin=nowhere&venue=options&symbol=&accountTab=unknown&tradersTab=unknown&copyTab=unknown",
        fallback,
      ),
    ).toEqual(fallback);
  });

  test("preserves canonical Hyperliquid casing and namespaces", () => {
    const parsed = parseMobileLocation(
      "?screen=chart&origin=search&venue=perps&symbol=xyz%3AGOOGL",
      FALLBACK,
    );

    expect(parsed.market).toEqual({ symbol: "xyz:GOOGL", venue: "perps" });
    expect(serializeMobileLocation(parsed)).toContain("symbol=xyz%3AGOOGL");

    const kPepe = parseMobileLocation(
      "?screen=chart&venue=perps&symbol=kPEPE",
      FALLBACK,
    );
    expect(kPepe.market?.symbol).toBe("kPEPE");
  });

  test("normalizes the legacy copy feed query to canonical Following state", () => {
    const parsed = parseMobileLocation(
      "?screen=copy&copyTab=feed",
      FALLBACK,
    );

    expect(parsed.tradersTab).toBe("following");
    expect(serializeMobileLocation(parsed)).toContain("tradersTab=following");
    expect(serializeMobileLocation(parsed)).not.toContain("copyTab");
  });

  test("never serializes a legacy copy value supplied at the input boundary", () => {
    expect(
      serializeMobileLocation({
        ...FALLBACK,
        screen: "copy",
        copyTab: "feed",
      }),
    ).toContain("screen=traders&tradersTab=following");
    expect(
      serializeMobileLocation({
        screen: "account",
        copyTab: "x-callers",
      }),
    ).toContain("tradersTab=x-callers");
  });

  test("merges mobile state without dropping unrelated query parameters", () => {
    const serialized = serializeMobileLocation({
      ...FALLBACK,
      screen: "markets",
      tradersTab: "following",
    });

    expect(
      mergeMobileLocationSearch(
        "?returnTo=%2Fapp&screen=feed&legacy=1&copy=feed",
        serialized,
      ),
    ).toBe(
      "?returnTo=%2Fapp&legacy=1&screen=markets&tradersTab=following",
    );
  });
});

describe("the merged Traders destination keeps every old deep link", () => {
  // Feed and Copy were bottom-nav slots of their own; `?screen=feed` and
  // `?screen=copy` are live URLs. Both land on Traders with the tab that
  // carries what the link used to open, never on a default or a 404.
  test("?screen=feed lands on the Feed tab, whatever remembered copyTab rides along", () => {
    expect(parseMobileLocation("?screen=feed")).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
    // Every URL the old codec wrote carried a copyTab; it must not pull an
    // old Feed link onto a Copy surface.
    expect(
      parseMobileLocation(
        "?screen=feed&accountTab=positions&copyTab=x-callers",
      ),
    ).toMatchObject({ screen: "traders", tradersTab: "feed" });
    expect(parseMobileLocation("?s=feed", FALLBACK)).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
  });

  test("?screen=copy lands on the Copy tab it named, defaulting to Following", () => {
    expect(parseMobileLocation("?screen=copy")).toMatchObject({
      screen: "traders",
      tradersTab: "following",
    });
    for (const tab of ["following", "x-callers", "users"] as const) {
      expect(
        parseMobileLocation(`?screen=copy&accountTab=orders&copyTab=${tab}`),
      ).toMatchObject({ screen: "traders", tradersTab: tab, accountTab: "orders" });
    }
    // A Copy link never lands on a non-Copy tab, even when the fallback
    // remembers one.
    expect(
      parseMobileLocation("?screen=copy", { ...FALLBACK, tradersTab: "watchlist" }),
    ).toMatchObject({ screen: "traders", tradersTab: "following" });
    expect(
      parseMobileLocation("?screen=copy", { ...FALLBACK, tradersTab: "users" }),
    ).toMatchObject({ screen: "traders", tradersTab: "users" });
  });

  test("a remembered legacy copyTab on any other screen maps onto the Traders tab set", () => {
    expect(
      parseMobileLocation("?screen=account&accountTab=closed&copyTab=users", FALLBACK),
    ).toMatchObject({ screen: "account", tradersTab: "users" });
    expect(
      parseMobileLocation("?screen=markets&copyTab=feed", FALLBACK),
    ).toMatchObject({ screen: "markets", tradersTab: "following" });
  });

  test("the canonical tradersTab wins over every legacy spelling", () => {
    expect(
      parseMobileLocation("?screen=traders&tradersTab=watchlist&copyTab=users"),
    ).toMatchObject({ screen: "traders", tradersTab: "watchlist" });
    // Under the new key, `feed` is the signal feed, not the old Following alias.
    expect(parseMobileLocation("?screen=traders&tradersTab=feed")).toMatchObject({
      tradersTab: "feed",
    });
    expect(parseMobileLocation("?screen=copy&tradersTab=feed")).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
  });

  test("legacy Feed and Copy origins become the Traders origin", () => {
    expect(
      parseMobileLocation("?screen=chart&venue=perps&symbol=BTC&origin=feed"),
    ).toMatchObject({ screen: "chart", origin: "traders" });
    expect(parseMobileLocation("?screen=search&origin=copy")).toMatchObject({
      screen: "search",
      origin: "traders",
    });
    expect(mobileBackTarget({ screen: "chart", origin: "feed" })).toBe("traders");
  });

  test("old Markets tabs (Signals, Watchlist, Signa) land on the Traders tab that holds them", () => {
    expect(parseMobileLocation("?s=markets&t=signals")).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
    expect(parseMobileLocation("?s=markets&feedTab=signa")).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
    expect(parseMobileLocation("?s=markets&t=watchlist")).toMatchObject({
      screen: "traders",
      tradersTab: "watchlist",
    });
    // A canonical `screen=markets` is not moved by a stale alias beside it.
    expect(parseMobileLocation("?screen=markets&feedTab=watchlist")).toMatchObject({
      screen: "markets",
    });
  });

  test("never emits the retired screen names or tab keys", () => {
    for (const screen of ["feed", "copy"] as const) {
      const serialized = serializeMobileLocation({ screen });
      expect(serialized).toContain("screen=traders");
      expect(serialized).not.toContain("copyTab");
    }
    // "feed" is the default tradersTab, so it is omitted from the URL; parsing
    // a ?screen=traders URL without tradersTab lands on feed by default.
    expect(serializeMobileLocation({ screen: "feed" })).not.toContain("tradersTab");
    expect(serializeMobileLocation({ screen: "copy" })).toContain(
      "tradersTab=following",
    );
  });
});

describe("mobile contextual Back", () => {
  test("returns a chart or search origin when it is valid", () => {
    expect(mobileBackTarget({ ...FALLBACK, screen: "chart", origin: "traders" })).toBe(
      "traders",
    );
    expect(
      mobileBackTarget({ ...FALLBACK, screen: "search", origin: "account" }),
    ).toBe("account");
  });

  test("uses the Trade home for a missing or self-referential contextual origin", () => {
    expect(mobileBackTarget({ ...FALLBACK, screen: "chart", origin: null })).toBe(
      "chart",
    );
    expect(
      mobileBackTarget({ ...FALLBACK, screen: "chart", origin: "chart" }),
    ).toBe("chart");
    expect(mobileBackTarget({ ...FALLBACK, screen: "search", origin: null })).toBe(
      "chart",
    );
    expect(mobileBackTarget({ ...FALLBACK, screen: "account", origin: "traders" })).toBe(
      "chart",
    );
  });

  test("Search opened from the Trade home comes back to it", () => {
    expect(mobileBackTarget({ ...FALLBACK, screen: "search", origin: "chart" })).toBe(
      "chart",
    );
  });

  test("accepts the compatibility `from` input when choosing a contextual Back target", () => {
    const input = {
      screen: "search",
      from: "copy",
    } satisfies MobileLocationStateInput;

    expect(mobileBackTarget(input)).toBe("traders");
  });
});

describe("mobile Trade home", () => {
  test("lands on the chart screen when the URL names no screen", () => {
    expect(DEFAULT_MOBILE_LOCATION.screen).toBe("chart");
    expect(DEFAULT_MOBILE_LOCATION.tradersTab).toBe("feed");
    expect(parseMobileLocation("")).toMatchObject({ screen: "chart", origin: null });
    expect(parseMobileLocation("?returnTo=%2Fapp")).toMatchObject({ screen: "chart" });
    expect(serializeMobileLocation(DEFAULT_MOBILE_LOCATION)).toContain("screen=chart");
  });

  test("keeps every existing screen deep link, Markets included", () => {
    for (const screen of ["markets", "traders", "account", "search", "chart"] as const) {
      expect(parseMobileLocation(`?screen=${screen}`).screen).toBe(screen);
      expect(parseMobileLocation(`?s=${screen}`).screen).toBe(screen);
    }
    expect(parseMobileLocation("?s=tools&t=orders")).toMatchObject({
      screen: "account",
      accountTab: "orders",
    });
    expect(
      parseMobileLocation("?screen=chart&venue=perps&symbol=BTC&origin=traders"),
    ).toMatchObject({
      screen: "chart",
      origin: "traders",
      market: { symbol: "BTC", venue: "perps" },
    });
  });

  test("still reads a legacy tab-only link as the old Markets tab it named", () => {
    // Before v2 the screen defaulted to Markets, so `?t=watchlist` meant the
    // Markets watchlist without saying so. Those tabs live on Traders now;
    // moving the default must not move those links onto the Trade home.
    expect(parseMobileLocation("?t=watchlist")).toMatchObject({
      screen: "traders",
      tradersTab: "watchlist",
    });
    expect(parseMobileLocation("?feedTab=watchlist")).toMatchObject({
      screen: "traders",
      tradersTab: "watchlist",
    });
    expect(parseMobileLocation("?t=signals")).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
    expect(parseMobileLocation("?tab=signa")).toMatchObject({
      screen: "traders",
      tradersTab: "feed",
    });
    // An unrelated or unknown tab value says nothing about the screen.
    expect(parseMobileLocation("?t=users").screen).toBe("chart");
  });
});

describe("mobile refresh/deep links", () => {
  test("restores an account tab from a URL while retaining fallback context", () => {
    const fallback: MobileLocationState = {
      ...FALLBACK,
      market: { symbol: "BTC", venue: "perps" },
    };

    expect(
      parseMobileLocation("screen=account&accountTab=closed&tradersTab=users", fallback),
    ).toEqual({
      ...fallback,
      screen: "account",
      accountTab: "closed",
      tradersTab: "users",
    });
  });
});
