/**
 * Plan S2. What the caller sheet SAYS about a caller's measured record.
 *
 * Separated from the sheet because every branch here is a claim about a named
 * person's track record, and those claims need to be assertable in a test rather
 * than buried in JSX conditionals.
 *
 * The governing rule: a caller with no measured result must never read as a
 * caller who was WRONG. There are five different reasons the numbers can be
 * missing (signed out, unattributable author, still loading, no calls in the
 * window, market data unavailable) and collapsing them into one "-" invites the
 * reader to fill in the blank themselves.
 *
 * PURE. No React, no IO.
 */

/** The shape of `leaderboard.xCallerProfile` this module reads. */
export interface CallerProfileLike {
  hitRate: number | null;
  avgForwardReturnPct: number | null;
  callCount: number;
  directionalCallCount: number;
  measuredCallCount: number;
  needsMarketData: boolean;
  measurementStatus?: "measured" | "unmeasured" | "not_comparable";
}

export interface CallerRecordInput {
  isSignedIn: boolean;
  /** False when the row carries no attributable author (metadata said Unknown). */
  hasKey: boolean;
  isLoading: boolean;
  /**
   * The failed query's tRPC error code, or null if it did not fail.
   *
   * A boolean is not enough. `NOT_FOUND` means the router looked and this caller
   * has no measured window, which IS a fact about the caller. Every other code
   * means we never found out. Collapsing them turned an outage into a claim
   * about someone's record, which is the one thing this sheet must not do.
   */
  errorCode: string | null;
  profile: CallerProfileLike | null | undefined;
  horizonDays: number;
}

export type MetricTone = "positive" | "negative" | "neutral";

export interface CallerMetric {
  label: string;
  value: string;
  tone: MetricTone;
}

export type CallerRecord =
  | { kind: "loading"; summary: string }
  | { kind: "unavailable"; summary: string; note: string }
  | {
      kind: "measured";
      summary: string;
      metrics: CallerMetric[];
      /** The honesty line: what this number is, and what it is not. */
      caveat: string;
    };

/** A fraction in [0,1] as a whole percent, or "-". */
export function formatHitRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

/** An already-percent value, signed, or "-". */
export function formatForwardReturn(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function describeCallerRecord({
  isSignedIn,
  hasKey,
  isLoading,
  errorCode,
  profile,
  horizonDays,
}: CallerRecordInput): CallerRecord {
  if (!isSignedIn) {
    return {
      kind: "unavailable",
      summary: "Caller record",
      note: "Sign in to see this caller's measured record.",
    };
  }
  if (!hasKey) {
    // The relayed post carried no usable author name, so there is nothing to
    // look up and nothing to follow. Say that, rather than showing an empty
    // record that reads as "measured, and bad".
    return {
      kind: "unavailable",
      summary: "Caller record",
      note: "This post has no attributable author, so there is no record to measure.",
    };
  }
  if (isLoading) {
    return { kind: "loading", summary: "Loading record…" };
  }
  // An outage is not a verdict. Say we could not load it, and do not imply the
  // caller has been quiet for a month.
  if (errorCode !== null && errorCode !== "NOT_FOUND") {
    return {
      kind: "unavailable",
      summary: "Caller record",
      note: "Could not load this caller's record just now. Try again in a moment.",
    };
  }
  if (errorCode === "NOT_FOUND" || !profile) {
    return {
      kind: "unavailable",
      summary: "Caller record",
      note: "No calls from this caller in the last 30 days, so there is nothing measured yet.",
    };
  }

  const callsLine =
    profile.callCount === 1 ? "1 call in 30d" : `${profile.callCount} calls in 30d`;

  if (profile.measurementStatus === "not_comparable") {
    return {
      kind: "unavailable",
      summary: callsLine,
      note: "This caller's detail is outside the newest 5,000-signal global scan, so the record is not comparable to the leaderboard.",
    };
  }

  if (profile.measuredCallCount === 0) {
    return {
      kind: "unavailable",
      summary: callsLine,
      note: profile.needsMarketData
        ? "Market data for these tickers is unavailable right now, so nothing is scored."
        : profile.directionalCallCount === 0
          ? "None of these calls state a clear direction, so none can be scored."
          : `Waiting for a complete ${horizonDays}D result on these calls.`,
    };
  }

  const forward = profile.avgForwardReturnPct;
  return {
    kind: "measured",
    summary: callsLine,
    metrics: [
      {
        label: `${horizonDays}D avg`,
        value: formatForwardReturn(forward),
        tone:
          forward === null || !Number.isFinite(forward) || forward === 0
            ? "neutral"
            : forward > 0
              ? "positive"
              : "negative",
      },
      {
        label: "Hit rate",
        value: formatHitRate(profile.hitRate),
        tone: "neutral",
      },
      {
        label: "Measured",
        value: `${profile.measuredCallCount}/${profile.callCount}`,
        tone: "neutral",
      },
    ],
    // Load-bearing. This is a ticker-move heuristic, not the caller's realized
    // P&L: they may have sized differently, exited earlier, or hedged. Printing
    // a percentage next to a person's name without saying so is the kind of
    // number that gets copied into a screenshot.
    caveat: `How the ticker moved in the ${horizonDays} ${horizonDays === 1 ? "day" : "days"} after each directional call. Not this caller's realized P&L.`,
  };
}
