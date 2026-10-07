import { describe, expect, test } from "bun:test";
import {
  describeCallerRecord,
  formatForwardReturn,
  formatHitRate,
  type CallerProfileLike,
} from "./caller-record";

function profile(overrides: Partial<CallerProfileLike> = {}): CallerProfileLike {
  return {
    hitRate: 0.6,
    avgForwardReturnPct: 1.25,
    callCount: 10,
    directionalCallCount: 8,
    measuredCallCount: 5,
    needsMarketData: false,
    ...overrides,
  };
}

const BASE = {
  isSignedIn: true,
  hasKey: true,
  isLoading: false,
  errorCode: null,
  horizonDays: 1,
};

describe("describeCallerRecord: no measured result is never 'they were wrong'", () => {
  test("a signed-out reader is told to sign in, not shown a blank record", () => {
    const record = describeCallerRecord({
      ...BASE,
      isSignedIn: false,
      profile: null,
    });

    expect(record.kind).toBe("unavailable");
    expect(record.kind === "unavailable" && record.note).toContain("Sign in");
  });

  test("an unattributable author says so, rather than showing an empty record", () => {
    const record = describeCallerRecord({ ...BASE, hasKey: false, profile: null });

    expect(record.kind).toBe("unavailable");
    expect(record.kind === "unavailable" && record.note).toContain(
      "no attributable author",
    );
  });

  test("a lookup miss reads as 'nothing measured yet', not as an error", () => {
    // The router 404s a caller with no calls in the window. To the reader that
    // is a fact about the caller, not a failure of the app.
    const record = describeCallerRecord({
      ...BASE,
      errorCode: "NOT_FOUND",
      profile: null,
    });

    expect(record.kind).toBe("unavailable");
    expect(record.kind === "unavailable" && record.note).toContain("nothing measured");
  });

  test("an OUTAGE is not reported as a fact about the caller", () => {
    // The distinction the boolean could not carry. A failed request says nothing
    // about whether this person has been posting; claiming they went quiet for a
    // month because our API was down is a claim about a named person that we
    // have no evidence for.
    for (const code of ["INTERNAL_SERVER_ERROR", "TIMEOUT", "TOO_MANY_REQUESTS"]) {
      const record = describeCallerRecord({ ...BASE, errorCode: code, profile: null });

      expect(record.kind).toBe("unavailable");
      const note = record.kind === "unavailable" ? record.note : "";
      expect(note).toContain("Could not load");
      expect(note).not.toContain("No calls");
      expect(note).not.toContain("last 30 days");
    }
  });

  test("the three distinct causes of an unmeasured caller stay distinguishable", () => {
    const noDirection = describeCallerRecord({
      ...BASE,
      profile: profile({ measuredCallCount: 0, directionalCallCount: 0 }),
    });
    const noBars = describeCallerRecord({
      ...BASE,
      profile: profile({ measuredCallCount: 0, needsMarketData: true }),
    });
    const tooSoon = describeCallerRecord({
      ...BASE,
      profile: profile({ measuredCallCount: 0 }),
    });

    expect(noDirection.kind === "unavailable" && noDirection.note).toContain(
      "clear direction",
    );
    expect(noBars.kind === "unavailable" && noBars.note).toContain("Market data");
    expect(tooSoon.kind === "unavailable" && tooSoon.note).toContain("Waiting");
    // All three still report the call volume, which IS measured.
    for (const record of [noDirection, noBars, tooSoon]) {
      expect(record.summary).toBe("10 calls in 30d");
    }
  });

  test("a single call is not pluralized", () => {
    const record = describeCallerRecord({
      ...BASE,
      profile: profile({ callCount: 1, measuredCallCount: 0 }),
    });

    expect(record.summary).toBe("1 call in 30d");
  });

  test("does not present author-scoped detail as a comparable score", () => {
    const record = describeCallerRecord({
      ...BASE,
      profile: profile({
        hitRate: null,
        avgForwardReturnPct: null,
        measuredCallCount: 0,
        measurementStatus: "not_comparable",
      }),
    });

    expect(record.kind).toBe("unavailable");
    expect(record.kind === "unavailable" && record.note).toContain("not comparable");
    expect(record.kind === "unavailable" && record.note).not.toContain("Market data");
  });
});

describe("describeCallerRecord: a measured caller", () => {
  test("reports the forward return, hit rate and measured coverage", () => {
    const record = describeCallerRecord({ ...BASE, profile: profile() });

    expect(record.kind).toBe("measured");
    if (record.kind !== "measured") return;
    expect(record.metrics.map((metric) => metric.value)).toEqual([
      "+1.25%",
      "60%",
      "5/10",
    ]);
  });

  test("states what the number IS NOT, on the same surface as the number", () => {
    // A percentage next to a person's name is the kind of thing that gets
    // screenshotted. It is a ticker-move heuristic, not their realized P&L.
    const record = describeCallerRecord({ ...BASE, profile: profile() });

    expect(record.kind === "measured" && record.caveat).toContain(
      "Not this caller's realized P&L",
    );
    expect(record.kind === "measured" && record.caveat).toContain("1 day");
  });

  test("pluralizes a multi-day horizon", () => {
    const record = describeCallerRecord({
      ...BASE,
      horizonDays: 7,
      profile: profile(),
    });

    expect(record.kind === "measured" && record.caveat).toContain("7 days");
    expect(record.kind === "measured" && record.metrics[0]?.label).toBe("7D avg");
  });

  test("tone follows the sign, and a flat result is neutral rather than green", () => {
    const up = describeCallerRecord({ ...BASE, profile: profile() });
    const down = describeCallerRecord({
      ...BASE,
      profile: profile({ avgForwardReturnPct: -2 }),
    });
    const flat = describeCallerRecord({
      ...BASE,
      profile: profile({ avgForwardReturnPct: 0 }),
    });

    expect(up.kind === "measured" && up.metrics[0]?.tone).toBe("positive");
    expect(down.kind === "measured" && down.metrics[0]?.tone).toBe("negative");
    expect(flat.kind === "measured" && flat.metrics[0]?.tone).toBe("neutral");
  });

  test("loading is its own state, so an empty record never flashes first", () => {
    expect(
      describeCallerRecord({ ...BASE, isLoading: true, profile: undefined }).kind,
    ).toBe("loading");
  });
});

describe("metric formatters", () => {
  test("render a dash rather than NaN for a missing value", () => {
    expect(formatHitRate(null)).toBe("-");
    expect(formatHitRate(Number.NaN)).toBe("-");
    expect(formatForwardReturn(null)).toBe("-");
    expect(formatForwardReturn(Number.POSITIVE_INFINITY)).toBe("-");
  });

  test("a negative forward return keeps its own sign, unduplicated", () => {
    expect(formatForwardReturn(-3.5)).toBe("-3.50%");
    expect(formatForwardReturn(3.5)).toBe("+3.50%");
    expect(formatHitRate(0.666)).toBe("67%");
  });
});

describe("a transport failure has no error code but is still an error", () => {
  test("an error without a tRPC code does not read as an empty history", () => {
    // The hole in the earlier fix: reading `error.data.code` alone yielded null
    // for a network-level failure, and null is the value for "no error at all",
    // so a dropped request was reported as the caller having gone quiet.
    const record = describeCallerRecord({
      ...BASE,
      errorCode: "UNKNOWN_ERROR",
      profile: null,
    });

    expect(record.kind).toBe("unavailable");
    const note = record.kind === "unavailable" ? record.note : "";
    expect(note).toContain("Could not load");
    expect(note).not.toContain("No calls");
  });
});
