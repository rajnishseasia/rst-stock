import { describe, expect, test } from "bun:test";
import {
  PEOPLE_SEARCH_UNIVERSE,
  describeCallerSummary,
  describePeopleSearch,
  matchCallers,
} from "./people-search";
import {
  isPeopleBrowseTab,
  marketSearchScope,
  visibleBrowseTabs,
} from "./mobile-market-browse";

const CALLERS = [
  { displayName: "Alpha Signals", callCount: 40 },
  { displayName: "Shardi", callCount: 12 },
  { displayName: "shark tank", callCount: 30 },
  { displayName: "Zeta", callCount: 5 },
];

describe("matchCallers", () => {
  test("an empty query is the browse state: the server's ranking, untouched", () => {
    expect(matchCallers(CALLERS, "  ").map((c) => c.displayName)).toEqual([
      "Alpha Signals",
      "Shardi",
      "shark tank",
      "Zeta",
    ]);
  });

  test("a prefix match outranks a substring match", () => {
    // Typing "sha" should surface Shardi and shark tank before Alpha Signals,
    // which only contains the letters incidentally.
    expect(matchCallers(CALLERS, "sha").map((c) => c.displayName)).toEqual([
      "shark tank",
      "Shardi",
    ]);
  });

  test("within a rank, the busier caller comes first", () => {
    const rows = [
      { displayName: "ann quiet", callCount: 2 },
      { displayName: "ann loud", callCount: 50 },
    ];

    expect(matchCallers(rows, "ann").map((c) => c.displayName)).toEqual([
      "ann loud",
      "ann quiet",
    ]);
  });

  test("matching is case insensitive both ways", () => {
    expect(matchCallers(CALLERS, "ZETA")).toHaveLength(1);
    expect(matchCallers([{ displayName: "ZETA", callCount: 1 }], "zeta")).toHaveLength(
      1,
    );
  });

  test("a caller with a blank name is skipped rather than matching everything", () => {
    expect(matchCallers([{ displayName: "   ", callCount: 9 }], "a")).toHaveLength(0);
  });

  test("no match returns empty, not the whole list", () => {
    expect(matchCallers(CALLERS, "qqqq")).toEqual([]);
  });
});

describe("describePeopleSearch: five different reasons for an empty list", () => {
  const base = {
    isSignedIn: true,
    isLoading: false,
    query: "",
    universeSize: 100,
    matchCount: 3,
  };

  test("rows win when there is something to show", () => {
    expect(describePeopleSearch(base)).toEqual({ kind: "rows" });
  });

  test("signed out, loading and an empty universe each say their own thing", () => {
    const signedOut = describePeopleSearch({ ...base, isSignedIn: false });
    const loading = describePeopleSearch({ ...base, isLoading: true });
    const empty = describePeopleSearch({
      ...base,
      universeSize: 0,
      matchCount: 0,
    });

    expect(signedOut.kind === "notice" && signedOut.message).toContain("Sign in");
    expect(loading.kind === "notice" && loading.message).toContain("Loading");
    expect(empty.kind === "notice" && empty.message).toContain("last 30 days");
  });

  test("a failed request is not reported as an empty platform", () => {
    // With `retry: false` a failed query settles with no rows and isLoading
    // false, which is byte-for-byte the shape of a genuinely empty universe.
    // Reported as one, it told the reader that nobody on the platform had
    // posted in a month, which is a claim about everyone based on one failed
    // request. Checked BEFORE the empty-universe branch.
    const failed = describePeopleSearch({
      ...base,
      hasError: true,
      universeSize: 0,
      matchCount: 0,
    });

    expect(failed.kind).toBe("notice");
    const message = failed.kind === "notice" ? failed.message : "";
    expect(message).toContain("Could not load");
    expect(message).not.toContain("last 30 days");
  });

  test("a genuine miss names the SCOPE, not just 'not found'", () => {
    // "No callers found" would let the reader conclude the person is not on the
    // platform. The truth is narrower and needs saying.
    const miss = describePeopleSearch({
      ...base,
      query: " Cobie ",
      matchCount: 0,
    });

    expect(miss.kind).toBe("notice");
    expect(miss.kind === "notice" && miss.message).toBe(
      'No match for "Cobie" among the 100 callers active in the last 30 days.',
    );
  });

  test("signed out beats loading beats an empty universe", () => {
    // Order matters: a signed-out user must never be told the platform has no
    // callers, which is a claim about us rather than about their session.
    const record = describePeopleSearch({
      ...base,
      isSignedIn: false,
      isLoading: true,
      universeSize: 0,
      matchCount: 0,
    });

    expect(record.kind === "notice" && record.message).toContain("Sign in");
  });
});

describe("describeCallerSummary", () => {
  test("an unmeasured caller says so instead of showing a bare dash", () => {
    // In a list someone picks a person to follow from, "-" and "0%" read the
    // same. They are not the same.
    expect(
      describeCallerSummary({
        callCount: 7,
        measuredCallCount: 0,
        hitRate: null,
        horizonDays: 1,
      }),
    ).toBe("7 calls in 30d · not yet measured");
  });

  test("a measured caller reports the hit rate with its horizon attached", () => {
    expect(
      describeCallerSummary({
        callCount: 20,
        measuredCallCount: 12,
        hitRate: 0.625,
        horizonDays: 1,
      }),
    ).toBe("20 calls in 30d · 63% hit rate at 1D");
  });

  test("a single call is not pluralized", () => {
    expect(
      describeCallerSummary({
        callCount: 1,
        measuredCallCount: 0,
        hitRate: null,
        horizonDays: 7,
      }),
    ).toBe("1 call in 30d · not yet measured");
  });

  test("a non-finite hit rate degrades to unmeasured rather than NaN%", () => {
    expect(
      describeCallerSummary({
        callCount: 3,
        measuredCallCount: 2,
        hitRate: Number.NaN,
        horizonDays: 1,
      }),
    ).toContain("not yet measured");
  });
});

describe("the Search screen's tabs", () => {
  test("People is not a market scope, so it maps back to the open one", () => {
    // The market query key must never carry "people": `useMarketSearch` and
    // `resolveEnterSelection` only understand venues.
    expect(marketSearchScope("people")).toBe("all");
    expect(marketSearchScope("stocks")).toBe("stocks");
    expect(marketSearchScope("perps")).toBe("perps");
    expect(marketSearchScope("all")).toBe("all");
  });

  test("only People selects the caller surface", () => {
    expect(isPeopleBrowseTab("people")).toBe(true);
    expect(isPeopleBrowseTab("all")).toBe(false);
    expect(isPeopleBrowseTab("perps")).toBe(false);
  });

  test("Perps drops out without the venue; People never does", () => {
    expect(visibleBrowseTabs(true).map((tab) => tab.value)).toEqual([
      "all",
      "stocks",
      "perps",
      "people",
    ]);
    expect(visibleBrowseTabs(false).map((tab) => tab.value)).toEqual([
      "all",
      "stocks",
      "people",
    ]);
  });

  test("the searched universe stays within the leaderboard's own limit cap", () => {
    // leaderboard.xCallers validates `limit` at max 100. Asking for more is a
    // runtime zod rejection, not a bigger list.
    expect(PEOPLE_SEARCH_UNIVERSE).toBeLessThanOrEqual(100);
  });
});
