import { describe, expect, test } from "bun:test";

import { MOBILE_TRADERS_TAB_VALUES } from "../mobile-shell";
import {
  MOBILE_VENUE_SCOPED_SCREENS,
  isMobileVenueScopedScreen,
  isMobileVenueScopedTradersTab,
  mobileScreenHostsVenueSwitch,
} from "./mobile-venue-scope";

const ALL_SCREENS = [
  "markets",
  "traders",
  "search",
  "chart",
  "account",
] as const;

describe("the mobile venue control is routed, not pinned", () => {
  // The bar used to sit between the app header and `main` on four of the five
  // destinations. Two of those four read the venue nowhere at all, so the row
  // was pure chrome there.
  test("only the destinations whose content the venue scopes host the control", () => {
    const hosting = ALL_SCREENS.filter((screen) =>
      isMobileVenueScopedScreen(screen),
    );

    expect([...hosting]).toEqual(["markets", "traders", "chart"]);
  });

  test("Account and Search host nothing, because neither reads the venue", () => {
    // Account renders BOTH venues at once (Positions and Orders stack them,
    // Closed is perps-only, Portfolio has its own Overview/Stocks/Perps
    // navigation). Search's browse surface owns its own All/Stocks/Perps
    // filter. A venue control on either changed nothing on screen.
    expect(isMobileVenueScopedScreen("account")).toBe(false);
    expect(isMobileVenueScopedScreen("search")).toBe(false);
    expect(mobileScreenHostsVenueSwitch("account", true)).toBe(false);
    expect(mobileScreenHostsVenueSwitch("search", true)).toBe(false);
  });

  test("Trade, Markets and Traders keep the control", () => {
    for (const screen of MOBILE_VENUE_SCOPED_SCREENS) {
      expect(mobileScreenHostsVenueSwitch(screen, true)).toBe(true);
    }
    expect(MOBILE_VENUE_SCOPED_SCREENS).toContain("chart");
    expect(MOBILE_VENUE_SCOPED_SCREENS).toContain("markets");
    expect(MOBILE_VENUE_SCOPED_SCREENS).toContain("traders");
  });

  test("a deployment without perps hosts the control nowhere", () => {
    for (const screen of ALL_SCREENS) {
      expect(mobileScreenHostsVenueSwitch(screen, false)).toBe(false);
    }
  });
});

describe("inside Traders, the control follows the venue-scoped tab", () => {
  test("Following is the only Traders tab the venue scopes", () => {
    const scoped = MOBILE_TRADERS_TAB_VALUES.filter((tab) =>
      isMobileVenueScopedTradersTab(tab),
    );

    expect([...scoped]).toEqual(["following"]);
  });

  test("the feed, the leaderboards and the watchlist do not", () => {
    // Feed carries an explicit All/Stocks/Perps scope of its own that
    // deliberately never touches the shared venue; the leaderboards rank
    // people rather than markets; the watchlist lists both venues at once.
    for (const tab of ["feed", "x-callers", "users", "watchlist"] as const) {
      expect(isMobileVenueScopedTradersTab(tab)).toBe(false);
    }
  });
});
