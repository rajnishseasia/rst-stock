import { describe, expect, test } from "bun:test";

import {
  buildMobilePortfolio,
  describeMobileBalanceLabel,
  parseUsdAmount,
  perpsStatusSettled,
  resolveMobileAccountValueProps,
  resolveMobileAccountValueReason,
  resolveMobileAccountValueState,
  resolveMobilePortfolioNavigation,
  showMobilePerpsSection,
  venueConnectionState,
  type MobilePortfolioSummary,
} from "./mobile-portfolio";

const BOTH_VENUES = {
  stocksConnected: true,
  stocksValue: 12_500.25,
  stocksBuyingPower: 8_250.5,
  perpsConnected: true,
  perpsValue: "3499.75",
} as const;

describe("parseUsdAmount", () => {
  test("parses the string Hyperliquid puts on the wire", () => {
    expect(parseUsdAmount("3499.75")).toBe(3499.75);
  });

  test("treats absent, blank and non-numeric values as not reported", () => {
    expect(parseUsdAmount(null)).toBeNull();
    expect(parseUsdAmount(undefined)).toBeNull();
    expect(parseUsdAmount("")).toBeNull();
    expect(parseUsdAmount("   ")).toBeNull();
    expect(parseUsdAmount("n/a")).toBeNull();
    expect(parseUsdAmount(Number.NaN)).toBeNull();
  });

  test("keeps a real zero balance distinct from a missing one", () => {
    expect(parseUsdAmount("0")).toBe(0);
    expect(parseUsdAmount(0)).toBe(0);
  });
});

describe("showMobilePerpsSection", () => {
  test("shows the perps section only when wired AND provisioned", () => {
    expect(showMobilePerpsSection({ wired: true, provisioned: true })).toBe(true);
  });

  test("hides it on a deployment with perps switched off", () => {
    // The mobile venue bar hides itself too, so the section would be dead weight.
    expect(showMobilePerpsSection({ wired: false, provisioned: true })).toBe(false);
  });

  test("hides it from an equities-only user who never enabled perps", () => {
    expect(showMobilePerpsSection({ wired: true, provisioned: false })).toBe(false);
  });
});

describe("buildMobilePortfolio", () => {
  test("sums a numeric Alpaca value with a string Hyperliquid value", () => {
    const summary = buildMobilePortfolio(BOTH_VENUES);

    expect(summary.total).toBe(16_000);
    expect(summary.totalComplete).toBe(true);
    expect(summary.rows.map((row) => row.venue)).toEqual(["stocks", "perps"]);
    expect(summary.rows.map((row) => row.value)).toEqual([12_500.25, 3499.75]);
    expect(summary.rows.map((row) => row.buyingPower)).toEqual([8_250.5, null]);
  });

  test("labels the venues without leaking perps grammar into equities", () => {
    const summary = buildMobilePortfolio(BOTH_VENUES);

    expect(summary.rows[0]?.label).toBe("Stocks & options");
    expect(summary.rows[1]?.label).toBe("Perps");
  });

  test("omits a venue that is not connected instead of showing it at zero", () => {
    const summary = buildMobilePortfolio({
      ...BOTH_VENUES,
      perpsConnected: false,
      perpsValue: "3499.75",
    });

    expect(summary.rows.map((row) => row.venue)).toEqual(["stocks"]);
    expect(summary.total).toBe(12_500.25);
    expect(summary.totalComplete).toBe(true);
  });

  test("flags the total as partial when a connected venue has not reported", () => {
    const summary = buildMobilePortfolio({
      ...BOTH_VENUES,
      perpsValue: null,
    });

    expect(summary.total).toBe(12_500.25);
    expect(summary.totalComplete).toBe(false);
    expect(summary.rows[1]).toEqual({
      venue: "perps",
      label: "Perps",
      value: null,
      buyingPower: null,
    });
  });

  test("reports no total at all when nothing is connected", () => {
    const summary = buildMobilePortfolio({
      stocksConnected: false,
      stocksValue: 12_500.25,
      perpsConnected: false,
      perpsValue: "3499.75",
    });

    expect(summary.rows).toEqual([]);
    expect(summary.total).toBeNull();
    expect(summary.totalComplete).toBe(true);
  });

  test("keeps a funded perps account visible when the broker is disconnected", () => {
    // The A7 bug in reverse: a perps-only user must still see their money.
    const summary = buildMobilePortfolio({
      stocksConnected: false,
      stocksValue: undefined,
      perpsConnected: true,
      perpsValue: "3499.75",
    });

    expect(summary.rows.map((row) => row.venue)).toEqual(["perps"]);
    expect(summary.total).toBe(3499.75);
  });
});

describe("resolveMobilePortfolioNavigation", () => {
  const both = buildMobilePortfolio(BOTH_VENUES);
  const stocksOnly = buildMobilePortfolio({
    ...BOTH_VENUES,
    perpsConnected: false,
  });
  const perpsOnly = buildMobilePortfolio({
    ...BOTH_VENUES,
    stocksConnected: false,
  });
  const nothing: MobilePortfolioSummary = buildMobilePortfolio({
    stocksConnected: false,
    stocksValue: null,
    perpsConnected: false,
    perpsValue: null,
  });

  test("opens on the overview when both venues are connected", () => {
    expect(resolveMobilePortfolioNavigation("overview", both)).toEqual({
      view: "overview",
      canReturnToOverview: false,
    });
  });

  test("drills into a connected venue and offers a way back", () => {
    expect(resolveMobilePortfolioNavigation("perps", both)).toEqual({
      view: "perps",
      canReturnToOverview: true,
    });
    expect(resolveMobilePortfolioNavigation("stocks", both)).toEqual({
      view: "stocks",
      canReturnToOverview: true,
    });
  });

  test("skips the overview entirely for a single-venue user", () => {
    expect(resolveMobilePortfolioNavigation("overview", stocksOnly)).toEqual({
      view: "stocks",
      canReturnToOverview: false,
    });
    expect(resolveMobilePortfolioNavigation("overview", perpsOnly)).toEqual({
      view: "perps",
      canReturnToOverview: false,
    });
  });

  test("never strands the user in a drill-down for a venue that went away", () => {
    // Held "perps" from a previous render, then perps stopped being connected.
    expect(resolveMobilePortfolioNavigation("perps", stocksOnly)).toEqual({
      view: "stocks",
      canReturnToOverview: false,
    });
    expect(resolveMobilePortfolioNavigation("perps", nothing)).toEqual({
      view: "overview",
      canReturnToOverview: false,
    });
  });

  test("falls back to the overview when nothing is connected", () => {
    expect(resolveMobilePortfolioNavigation("overview", nothing)).toEqual({
      view: "overview",
      canReturnToOverview: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Plan A9 - the balance shown as the mobile nav label.
// ---------------------------------------------------------------------------
describe("describeMobileBalanceLabel", () => {
  test("sums both venues and formats compactly for the nav cell", () => {
    const label = describeMobileBalanceLabel(buildMobilePortfolio(BOTH_VENUES));

    expect(label).not.toBeNull();
    expect(label!.partial).toBe(false);
    // 12,500.25 + 3,499.75 = 16,000. formatCompactUsd (the sanctioned shared
    // helper, audit M16) compacts above $10k with no trailing zeros.
    expect(label!.short).toBe("$16K");
    // The accessible name carries the exact figure, not the rounded one.
    expect(label!.long).toContain("$16,000.00");
    expect(label!.long).not.toContain("not reported");
  });

  test("marks a partial total instead of presenting it as complete", () => {
    // Perps connected but the balance has not arrived: the total is real but
    // short, and money must never overstate itself.
    const label = describeMobileBalanceLabel(
      buildMobilePortfolio({
        stocksConnected: true,
        stocksValue: 12_500.25,
        perpsConnected: true,
        perpsValue: null,
      }),
    );

    expect(label!.partial).toBe(true);
    expect(label!.short.startsWith("~")).toBe(true);
    expect(label!.long).toContain("has not reported yet");
  });

  test("returns null when there is nothing honest to show", () => {
    // No venue connected at all.
    expect(
      describeMobileBalanceLabel(
        buildMobilePortfolio({
          stocksConnected: false,
          stocksValue: null,
          perpsConnected: false,
          perpsValue: null,
        }),
      ),
    ).toBeNull();

    // Connected, but nothing has reported: a "$0.00" label would read as an
    // empty account rather than an unknown one.
    expect(
      describeMobileBalanceLabel(
        buildMobilePortfolio({
          stocksConnected: true,
          stocksValue: undefined,
          perpsConnected: false,
          perpsValue: null,
        }),
      ),
    ).toBeNull();
  });

  test("a perps-only user gets their Hyperliquid collateral, string and all", () => {
    const label = describeMobileBalanceLabel(
      buildMobilePortfolio({
        stocksConnected: false,
        stocksValue: null,
        perpsConnected: true,
        perpsValue: "3499.75",
      }),
    );

    expect(label!.partial).toBe(false);
    expect(label!.short).toBe("$3,499.75");
  });
});

describe("an unresolved perps status never yields a COMPLETE total", () => {
  const base = {
    stocksConnected: true,
    stocksValue: "10000",
    perpsConnected: false,
    perpsValue: null,
  };

  test("a stocks-only sum is not final while perps status is still unknown", () => {
    // The bug: on a cold load or a failed hyperliquid.status, perpsEnabled is
    // false because nothing came back, which is byte-for-byte a confirmed
    // stocks-only account. Treated as one, a provisioned user's perps row was
    // dropped AND the remaining sum was marked complete, so the nav and the
    // portfolio screen showed an understated number with no hint it was partial.
    const summary = buildMobilePortfolio({ ...base, perpsConnected: null });

    expect(summary.total).toBe(10000);
    expect(summary.totalComplete).toBe(false);
  });

  test("no phantom Perps row is invented for the unknown case", () => {
    // We have no evidence this user trades perps. Showing a "Perps" line for a
    // stocks-only account would be its own false claim; the total is simply not
    // asserted as final.
    const summary = buildMobilePortfolio({ ...base, perpsConnected: null });

    expect(summary.rows.map((row) => row.venue)).toEqual(["stocks"]);
  });

  test("a settled status still reports a complete total", () => {
    expect(
      buildMobilePortfolio({ ...base, perpsConnected: false }).totalComplete,
    ).toBe(true);
    expect(buildMobilePortfolio(base).totalComplete).toBe(true);
  });

  test("a connected venue that has not reported is still incomplete", () => {
    const summary = buildMobilePortfolio({
      ...base,
      perpsConnected: true,
      perpsValue: null,
    });
    expect(summary.totalComplete).toBe(false);
  });
});

describe("perpsStatusSettled: a failed status read is not an answer", () => {
  const base = { wired: true, isSignedIn: true, statusSucceeded: false };

  test("a FAILED status read is not settled", () => {
    // The bug, twice over. `isFetched` is true after an error too, so the first
    // fix gated on it and a failed hyperliquid.status still looked answered:
    // data absent, perpsEnabled false, and a provisioned user's stock-only sum
    // marked a complete portfolio total.
    expect(perpsStatusSettled(base)).toBe(false);
  });

  test("a successful read is settled", () => {
    expect(perpsStatusSettled({ ...base, statusSucceeded: true })).toBe(true);
  });

  test("nothing to wait for when perps are not wired, or nobody is signed in", () => {
    expect(perpsStatusSettled({ ...base, wired: false })).toBe(true);
    expect(perpsStatusSettled({ ...base, isSignedIn: false })).toBe(true);
  });

  test("feeds through to the total: a failed status blocks completeness", () => {
    // End to end, which is the claim that actually matters to a reader.
    const summary = buildMobilePortfolio({
      stocksConnected: true,
      stocksValue: "10000",
      perpsValue: null,
      // `base` here has statusSucceeded: false, so this resolves to null.
      perpsConnected: perpsStatusSettled(base) ? false : null,
    });
    expect(summary.total).toBe(10000);
    expect(summary.totalComplete).toBe(false);
  });
});

describe("BOTH venues carry the unknown state, not just perps", () => {
  test("an unresolved STOCKS state blocks a complete perps-only total", () => {
    // The asymmetry that kept the bug alive: perps was made tri-state and
    // stocks was left binary, so `selectedCredentialId` being absent while the
    // credentials read was in flight marked a perps-only subtotal as the whole
    // portfolio.
    const summary = buildMobilePortfolio({
      stocksConnected: null,
      stocksValue: null,
      perpsConnected: true,
      perpsValue: "2500",
    });

    expect(summary.total).toBe(2500);
    expect(summary.totalComplete).toBe(false);
    expect(summary.rows.map((row) => row.venue)).toEqual(["perps"]);
  });

  test("either venue unresolved is enough to block completeness", () => {
    const both = { stocksValue: "1", perpsValue: "1" };
    expect(
      buildMobilePortfolio({
        ...both,
        stocksConnected: null,
        perpsConnected: null,
      }).totalComplete,
    ).toBe(false);
    expect(
      buildMobilePortfolio({
        ...both,
        stocksConnected: true,
        perpsConnected: true,
      }).totalComplete,
    ).toBe(true);
  });
});

describe("venueConnectionState", () => {
  test("unsettled is null, never false", () => {
    // false is a claim ("you do not trade there"); null is the absence of one.
    expect(venueConnectionState({ settled: false, connected: false })).toBeNull();
    expect(venueConnectionState({ settled: false, connected: true })).toBeNull();
  });

  test("settled passes the answer through", () => {
    expect(venueConnectionState({ settled: true, connected: true })).toBe(true);
    expect(venueConnectionState({ settled: true, connected: false })).toBe(false);
  });
});

describe("an unresolved venue reaches every consumer, not just the total", () => {
  const unresolved = {
    stocksConnected: null,
    stocksValue: null,
    perpsConnected: true,
    perpsValue: "2500",
  };

  test("the summary reports that a venue is unresolved", () => {
    // The rows alone cannot say it: an unknown venue is deliberately given no
    // row, so "no rows" covers both "you trade nowhere" and "we have not heard
    // back", and the overview told users with a broker to go connect one.
    expect(buildMobilePortfolio(unresolved).hasUnresolvedVenue).toBe(true);
    expect(
      buildMobilePortfolio({ ...unresolved, stocksConnected: false })
        .hasUnresolvedVenue,
    ).toBe(false);
  });

  test("does NOT collapse to a single venue while one is still unknown", () => {
    // Otherwise the user was dropped into the venue that happened to answer
    // first, with canReturnToOverview false, and the ground moved when the
    // other one arrived.
    const nav = resolveMobilePortfolioNavigation(
      "overview",
      buildMobilePortfolio(unresolved),
    );
    expect(nav.view).toBe("overview");
  });

  test("collapses once the other venue is CONFIRMED absent", () => {
    // The real single-venue case still has to work.
    const nav = resolveMobilePortfolioNavigation(
      "overview",
      buildMobilePortfolio({ ...unresolved, stocksConnected: false }),
    );
    expect(nav.view).toBe("perps");
    expect(nav.canReturnToOverview).toBe(false);
  });

  test("the nav balance does not call an unresolved venue 'connected'", () => {
    const label = describeMobileBalanceLabel(buildMobilePortfolio(unresolved));
    expect(label?.partial).toBe(true);
    expect(label?.long).not.toContain("connected venue");
  });
});

describe("a FAILED venue check does not describe itself as still running", () => {
  const unresolved = {
    stocksConnected: null,
    stocksValue: null,
    perpsConnected: true,
    perpsValue: "2500",
  };

  test("the summary separates failed from still-loading", () => {
    // Both land on hasUnresolvedVenue, and describing both as "checking" left
    // every surface claiming a request was in progress long after it gave up.
    const failed = buildMobilePortfolio({ ...unresolved, venueCheckFailed: true });
    expect(failed.hasUnresolvedVenue).toBe(true);
    expect(failed.venueCheckFailed).toBe(true);

    const loading = buildMobilePortfolio(unresolved);
    expect(loading.hasUnresolvedVenue).toBe(true);
    expect(loading.venueCheckFailed).toBe(false);
  });

  test("a settled board never reports a failed check", () => {
    // Nothing is unresolved, so there is nothing for a stale error to describe.
    const settled = buildMobilePortfolio({
      ...unresolved,
      stocksConnected: false,
      venueCheckFailed: true,
    });
    expect(settled.hasUnresolvedVenue).toBe(false);
    expect(settled.venueCheckFailed).toBe(false);
  });

  test("the nav label stops claiming it is still checking", () => {
    const label = describeMobileBalanceLabel(
      buildMobilePortfolio({ ...unresolved, venueCheckFailed: true }),
    );
    expect(label?.long).toContain("could not be checked");
    expect(label?.long).not.toContain("still checking");
  });
});

describe("resolveMobileAccountValueReason", () => {
  test("nothing connected and nothing pending is a Connect prompt", () => {
    const summary = buildMobilePortfolio({
      stocksConnected: false,
      stocksValue: null,
      perpsConnected: false,
      perpsValue: null,
    });

    expect(resolveMobileAccountValueState(summary)).toBe("unavailable");
    expect(resolveMobileAccountValueReason(summary)).toBe("not-connected");
    expect(resolveMobileAccountValueProps(summary)).toEqual({
      accountValue: undefined,
      accountValueState: "unavailable",
      accountValueReason: "not-connected",
    });
  });

  test("a failed venue check is named as such, not as a missing broker", () => {
    const summary = buildMobilePortfolio({
      stocksConnected: null,
      stocksValue: null,
      perpsConnected: false,
      perpsValue: null,
      venueCheckFailed: true,
    });

    expect(resolveMobileAccountValueState(summary)).toBe("unavailable");
    expect(resolveMobileAccountValueReason(summary)).toBe("venue-check-failed");
  });

  test("a venue still being checked has no reason: it is loading, not unavailable", () => {
    const summary = buildMobilePortfolio({
      stocksConnected: null,
      stocksValue: null,
      perpsConnected: false,
      perpsValue: null,
    });

    expect(resolveMobileAccountValueState(summary)).toBe("loading");
    expect(resolveMobileAccountValueReason(summary)).toBeNull();
  });

  test("an available total carries the value and no reason", () => {
    const props = resolveMobileAccountValueProps(
      buildMobilePortfolio(BOTH_VENUES),
    );

    expect(props.accountValueState).toBe("available");
    expect(props.accountValueReason).toBeNull();
    expect(props.accountValue).toContain("portfolio $16,000.00");
  });
});
