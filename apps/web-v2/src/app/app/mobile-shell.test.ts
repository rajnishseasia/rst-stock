import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_WIDE_MOBILE_TABS,
  DEFAULT_MOBILE_CHART_TAB,
  DEFAULT_MOBILE_COPY_TAB,
  DEFAULT_MOBILE_FEED_TAB,
  DEFAULT_MOBILE_ACCOUNT_TAB,
  DEFAULT_MOBILE_TRADERS_TAB,
  DESKTOP_TERMINAL_MIN_WIDTH,
  MOBILE_CHART_TABS,
  mobileChartTabsForVenue,
  resolveMobileChartTab,
  DEFAULT_MOBILE_LEADERBOARD_TAB,
  MOBILE_COPY_TABS,
  MOBILE_FEED_TABS,
  MOBILE_LEADERBOARD_LABEL,
  MOBILE_ACCOUNT_TABS,
  MOBILE_TRADERS_TABS,
  MOBILE_TRADERS_TAB_VALUES,
  isAccountWideMobileTab,
  isCopyTradersTab,
  isLeaderboardCopyTab,
  isLeaderboardTradersTab,
  isMobileTradersTab,
  isNarrowViewport,
  landCopyPrefill,
} from "./mobile-shell";

// ---------------------------------------------------------------------------
// The merged Traders destination: Feed, the Copy surfaces and Watchlist under
// one tab strip, where three surfaces used to pay for their own chrome.
// ---------------------------------------------------------------------------
describe("mobile traders tabs", () => {
  test("carry Feed, then the Copy surfaces, then Watchlist, under the labels the old screens painted", () => {
    expect(MOBILE_TRADERS_TAB_VALUES).toEqual([
      "feed",
      "following",
      "x-callers",
      "users",
      "watchlist",
    ]);
    expect(MOBILE_TRADERS_TABS.map((tab) => tab.label)).toEqual([
      "Feed",
      "Following",
      "Top X",
      "Top Users",
      "Watchlist",
    ]);
    // The Copy labels are the Copy contract itself, not a retyped copy.
    expect(MOBILE_TRADERS_TABS.slice(1, 4)).toEqual([...MOBILE_COPY_TABS]);
  });

  test("open on the signal feed", () => {
    expect(DEFAULT_MOBILE_TRADERS_TAB).toBe("feed");
    expect(MOBILE_TRADERS_TABS[0]?.value).toBe(DEFAULT_MOBILE_TRADERS_TAB);
  });

  test("classify exactly the Copy surfaces, so the copy panel mounts for those three only", () => {
    expect(isCopyTradersTab("feed")).toBe(false);
    expect(isCopyTradersTab("following")).toBe(true);
    expect(isCopyTradersTab("x-callers")).toBe(true);
    expect(isCopyTradersTab("users")).toBe(true);
    expect(isCopyTradersTab("watchlist")).toBe(false);
  });

  test("reject anything outside the tab set", () => {
    for (const value of MOBILE_TRADERS_TAB_VALUES) {
      expect(isMobileTradersTab(value)).toBe(true);
    }
    expect(isMobileTradersTab("copy")).toBe(false);
    expect(isMobileTradersTab("signals")).toBe(false);
    expect(isMobileTradersTab(null)).toBe(false);
  });
});

describe("mobile markets screen", () => {
  test("opens on the aggregated signal feed", () => {
    // Signal-first: the feed IS the product, so it is never demoted behind the
    // watchlist or Signa.
    expect(DEFAULT_MOBILE_FEED_TAB).toBe("signals");
    expect(MOBILE_FEED_TABS[0]?.value).toBe("signals");
  });

  test("offers the three market reads with stable labels", () => {
    expect(MOBILE_FEED_TABS.map((tab) => tab.value)).toEqual([
      "signals",
      "watchlist",
      "signa",
    ]);
    expect(MOBILE_FEED_TABS.every((tab) => tab.label.length > 0)).toBe(true);
  });

  test("the default tab is one of the rendered tabs", () => {
    expect(
      MOBILE_FEED_TABS.some((tab) => tab.value === DEFAULT_MOBILE_FEED_TAB),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Chart / Account split. Restores coverage that was previously asserted by
// reading page.tsx as a string and grepping the two panels' JSX (audit H7): the
// rule is now a property of the two tab lists, checked directly.
// ---------------------------------------------------------------------------
describe("mobile chart screen tabs", () => {
  test("leads with a market-filterable portfolio, then Feed", () => {
    expect(MOBILE_CHART_TABS.slice(0, 2).map((tab) => tab.value)).toEqual([
      "portfolio",
      "feed",
    ]);
  });

  test("offers the market-scoped reads with stable labels", () => {
    expect(MOBILE_CHART_TABS.map((tab) => tab.value)).toEqual([
      "portfolio",
      "feed",
      "ai",
    ]);
    expect(MOBILE_CHART_TABS.every((tab) => tab.label.length > 0)).toBe(true);
  });

  test("opens on the selected market's portfolio", () => {
    expect(DEFAULT_MOBILE_CHART_TAB).toBe("portfolio");
    expect(
      MOBILE_CHART_TABS.some((tab) => tab.value === DEFAULT_MOBILE_CHART_TAB),
    ).toBe(true);
  });
});

describe("mobile account screen tabs", () => {
  test("is where every account-wide surface lives", () => {
    const account = MOBILE_ACCOUNT_TABS.map((tab) => tab.value as string);
    for (const accountWide of ACCOUNT_WIDE_MOBILE_TABS) {
      expect(account).toContain(accountWide);
    }
  });

  test("keeps Positions, Closed, Orders, Portfolio and AI in that order", () => {
    expect(MOBILE_ACCOUNT_TABS.map((tab) => tab.value)).toEqual([
      "positions",
      "closed",
      "orders",
      "portfolio",
      "ai",
    ]);
    expect(MOBILE_ACCOUNT_TABS.every((tab) => tab.label.length > 0)).toBe(true);
  });

  test("opens on what the user holds", () => {
    expect(DEFAULT_MOBILE_ACCOUNT_TAB).toBe("positions");
    expect(
      MOBILE_ACCOUNT_TABS.some((tab) => tab.value === DEFAULT_MOBILE_ACCOUNT_TAB),
    ).toBe(true);
  });

  test("shares portfolio and AI with Account while keeping Feed market-local", () => {
    const chart = new Set(MOBILE_CHART_TABS.map((tab) => tab.value as string));
    const shared = MOBILE_ACCOUNT_TABS.map((tab) => tab.value as string).filter(
      (value) => chart.has(value),
    );

    // A conversation is scoped by what you ask, so it belongs on both. Anything
    // else appearing twice means one of the two screens is showing the wrong
    // altitude of information.
    expect(shared).toEqual(["portfolio", "ai"]);
  });
});

describe("isAccountWideMobileTab", () => {
  test("classifies the surfaces that span every symbol and both venues", () => {
    expect(isAccountWideMobileTab("positions")).toBe(true);
    expect(isAccountWideMobileTab("orders")).toBe(true);
    expect(isAccountWideMobileTab("portfolio")).toBe(true);
  });

  test("a market-scoped read is not account-wide", () => {
    expect(isAccountWideMobileTab("feed")).toBe(false);
    expect(isAccountWideMobileTab("ai")).toBe(false);
    expect(isAccountWideMobileTab("signals")).toBe(false);
  });
});

describe("isNarrowViewport", () => {
  test("matches the xl breakpoint the shells switch on", () => {
    expect(DESKTOP_TERMINAL_MIN_WIDTH).toBe(1280);
    expect(isNarrowViewport(DESKTOP_TERMINAL_MIN_WIDTH - 1)).toBe(true);
    expect(isNarrowViewport(DESKTOP_TERMINAL_MIN_WIDTH)).toBe(false);
    expect(isNarrowViewport(390)).toBe(true);
    expect(isNarrowViewport(1920)).toBe(false);
  });

  test("an unknown width is never treated as mobile", () => {
    // Server render / no window: opening the sheet would be worse than not.
    expect(isNarrowViewport(undefined)).toBe(false);
    expect(isNarrowViewport(null)).toBe(false);
    expect(isNarrowViewport(Number.NaN)).toBe(false);
  });
});

describe("landCopyPrefill", () => {
  test("a copy on the mobile shell opens the trade sheet", () => {
    let sheets = 0;
    let charts = 0;

    const landing = landCopyPrefill({
      openTradeSheetOnNarrowViewport: () => {
        sheets += 1;
        return true;
      },
      focusChartOnNarrowViewport: () => {
        charts += 1;
      },
    });

    expect(landing).toBe("trade-sheet");
    expect(sheets).toBe(1);
    expect(charts).toBe(0);
  });

  test("a copy on the desktop terminal focuses the chart instead", () => {
    // Opening the sheet at xl would leave it invisible in state, holding the
    // body scroll lock until a resize popped it open.
    let charts = 0;

    const landing = landCopyPrefill({
      openTradeSheetOnNarrowViewport: () => false,
      focusChartOnNarrowViewport: () => {
        charts += 1;
      },
    });

    expect(landing).toBe("chart");
    expect(charts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Plan A10 - the leaderboard, inside the shell.
// ---------------------------------------------------------------------------
describe("mobile copy screen", () => {
  test("opens on Following, not a ranking", () => {
    // Signal-first holds here too: the rankings are the vetting step you take
    // after seeing a call, not the landing read. Following is the one
    // canonical value shared with the URL/history codec.
    expect(DEFAULT_MOBILE_COPY_TAB).toBe("following");
    expect(MOBILE_COPY_TABS[0]?.value).toBe("following");
  });

  test("flattens both leaderboard boards into ONE control row", () => {
    // The whole point of A10's constraint: LeaderboardView renders its own
    // X Callers / Users tabs, so a Feed | Top Traders header above it would
    // stack the venue bar plus two control rows on a 375px screen.
    expect(MOBILE_COPY_TABS.map((tab) => tab.value)).toEqual([
      "following",
      "x-callers",
      "users",
    ]);
    expect(MOBILE_COPY_TABS.every((tab) => tab.label.length > 0)).toBe(true);
  });

  test("classifies exactly the leaderboard tabs, so only one body mounts", () => {
    expect(isLeaderboardCopyTab("following")).toBe(false);
    expect(isLeaderboardCopyTab("x-callers")).toBe(true);
    expect(isLeaderboardCopyTab("users")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The leaderboard is a Traders destination, not a menu link: both ranked
// boards `/lb` renders are mounted as tabs here, so the shell needs one answer
// to "is this tab the leaderboard" and one place to send someone who asks for
// it without naming a board.
// ---------------------------------------------------------------------------
describe("the leaderboard inside Traders", () => {
  test("names exactly the two ranked boards, and no other Traders tab", () => {
    expect(isLeaderboardTradersTab("x-callers")).toBe(true);
    expect(isLeaderboardTradersTab("users")).toBe(true);
    expect(isLeaderboardTradersTab("following")).toBe(false);
    expect(isLeaderboardTradersTab("feed")).toBe(false);
    expect(isLeaderboardTradersTab("watchlist")).toBe(false);
  });

  test("agrees with the Copy-surface predicates it is composed from", () => {
    for (const { value } of MOBILE_TRADERS_TABS) {
      expect(isLeaderboardTradersTab(value)).toBe(
        isCopyTradersTab(value) && isLeaderboardCopyTab(value),
      );
    }
  });

  test("opens on a board that the Traders strip actually paints", () => {
    expect(isLeaderboardTradersTab(DEFAULT_MOBILE_LEADERBOARD_TAB)).toBe(true);
    expect(
      MOBILE_TRADERS_TABS.some(
        (tab) => tab.value === DEFAULT_MOBILE_LEADERBOARD_TAB,
      ),
    ).toBe(true);
    // The callers board, the same one `/lb` opens on with no query.
    expect(DEFAULT_MOBILE_LEADERBOARD_TAB).toBe("x-callers");
  });

  test("keeps one name for the feature, distinct from the board names", () => {
    expect(MOBILE_LEADERBOARD_LABEL).toBe("Leaderboard");
    expect(
      MOBILE_TRADERS_TABS.map((tab) => tab.label),
    ).not.toContain(MOBILE_LEADERBOARD_LABEL);
  });
});

describe("mobile chart tabs are venue-aware", () => {
  test("an equity chart offers Portfolio, Feed, and AI", () => {
    expect(mobileChartTabsForVenue(false).map((tab) => tab.value)).toEqual([
      "portfolio",
      "feed",
      "ai",
    ]);
  });

  test("a perp chart does not offer the equity AI assistant", () => {
    // The panel is handed the EQUITY symbol slot and its order drafts land in
    // the equity ticket, so on a BTC chart it discussed whatever equity was last
    // selected (SPY) and could draft an equity order from that conversation,
    // while the user believed they were talking about the perp on screen.
    expect(mobileChartTabsForVenue(true).map((tab) => tab.value)).toEqual([
      "portfolio",
      "feed",
    ]);
  });

  test("a tab the strip no longer offers falls back rather than staying rendered", () => {
    // Selecting AI on an equity chart and then switching venue is the same
    // wrong-instrument conversation by another route.
    expect(resolveMobileChartTab("ai", true)).toBe(DEFAULT_MOBILE_CHART_TAB);
    expect(resolveMobileChartTab("ai", true)).not.toBe("ai");
  });

  test("a valid selection is left alone on both venues", () => {
    expect(resolveMobileChartTab("ai", false)).toBe("ai");
    expect(resolveMobileChartTab("feed", true)).toBe("feed");
    expect(resolveMobileChartTab("feed", false)).toBe("feed");
  });
});
