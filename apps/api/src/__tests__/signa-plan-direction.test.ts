import { describe, expect, it } from "bun:test";

import { planMatchesSide } from "../routers/signa.js";

/**
 * Regression tests for the Signa direction/plan mismatch.
 *
 * The panel was rendering "BULLISH" badges over short-shaped trade plans:
 * DAL showed entry 84.26 with a stop at 88.10 (above entry) and a target at
 * 76.59 (below entry). Copy signal prefilled exactly that into the trade
 * form as a buy.
 *
 * Root cause: `direction` comes from /api/signals/run (nightly multi-model
 * consensus) while entry/stop/target come from /api/v1/signal (live single
 * pass). When the single pass has no directional read it still emits a
 * mechanical 2R plan, and that fallback plan is short-shaped.
 *
 * The fixtures below are real payloads captured from Signa on 2026-07-23.
 */

/** Real /api/v1/signal?sym=X responses, paired with the direction the scored
 *  run reported for the same ticker in the same window. */
const LIVE_FIXTURES = [
  // Card direction LONG, bias bullish: plan agrees with the badge. Keep.
  { ticker: "UNP", runDirection: "BULLISH", cardDirection: "LONG", bias: "bullish", entry: 292.30, stop: 283.97, target: 308.96 },
  { ticker: "NSC", runDirection: "BULLISH", cardDirection: "LONG", bias: "bullish", entry: 331.20, stop: 322.40, target: 348.81 },
  { ticker: "AFL", runDirection: "BULLISH", cardDirection: "LONG", bias: "bullish", entry: 123.64, stop: 120.56, target: 129.80 },
  { ticker: "CVX", runDirection: "BULLISH", cardDirection: "LONG", bias: "bullish", entry: 192.31, stop: 186.74, target: 203.44 },
  // Card direction WAIT but bias bullish, and the plan is still long-shaped.
  // This one must survive: the fix keys off plan geometry, not off the
  // literal string "WAIT".
  { ticker: "BAC", runDirection: "BULLISH", cardDirection: "WAIT", bias: "bullish", entry: 61.70, stop: 59.88, target: 65.35 },

  // Card direction WAIT with a neutral bias: short-shaped placeholder plan
  // under a BULLISH badge. These are the broken ones.
  { ticker: "DAL", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 84.31, stop: 88.15, target: 76.64 },
  { ticker: "KO", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 82.28, stop: 84.86, target: 77.12 },
  { ticker: "FDX", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 319.35, stop: 332.52, target: 293.01 },
  { ticker: "PH", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 970.77, stop: 1005.66, target: 901.01 },
  { ticker: "SPLV", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 76.04, stop: 77.39, target: 73.34 },
  { ticker: "SVXY", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 57.81, stop: 59.49, target: 54.47 },
  { ticker: "MAR", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 368.72, stop: 381.08, target: 343.99 },
  { ticker: "DE", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 603.87, stop: 630.32, target: 550.96 },
  { ticker: "CSX", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 49.66, stop: 51.03, target: 46.90 },
  { ticker: "TFC", runDirection: "BULLISH", cardDirection: "WAIT", bias: "neutral", entry: 51.86, stop: 53.64, target: 48.31 },
] as const;

const KEEP = ["UNP", "NSC", "AFL", "CVX", "BAC"];

describe("planMatchesSide", () => {
  it("accepts a long plan with the stop below entry and target above", () => {
    expect(planMatchesSide("buy", 292.3, 283.97, 308.96)).toBe(true);
  });

  it("rejects a long plan with the stop above entry", () => {
    // The DAL case from the bug report.
    expect(planMatchesSide("buy", 84.31, 88.15, 76.64)).toBe(false);
  });

  it("accepts a short plan with the stop above entry and target below", () => {
    expect(planMatchesSide("sell", 84.31, 88.15, 76.64)).toBe(true);
  });

  it("rejects a short plan with the stop below entry", () => {
    expect(planMatchesSide("sell", 292.3, 283.97, 308.96)).toBe(false);
  });

  it("rejects an incomplete plan", () => {
    expect(planMatchesSide("buy", 100, undefined, 120)).toBe(false);
    expect(planMatchesSide("buy", undefined, 90, 120)).toBe(false);
    expect(planMatchesSide("buy", 100, 90, undefined)).toBe(false);
  });

  it("rejects non-finite values rather than letting NaN comparisons pass", () => {
    expect(planMatchesSide("buy", Number.NaN, 90, 120)).toBe(false);
    expect(planMatchesSide("buy", 100, Number.POSITIVE_INFINITY, 120)).toBe(false);
  });

  it("rejects a degenerate plan where entry equals the stop", () => {
    expect(planMatchesSide("buy", 100, 100, 120)).toBe(false);
  });
});

describe("live Signa fixtures (2026-07-23)", () => {
  it("keeps exactly the picks whose plan agrees with the scored run", () => {
    const kept = LIVE_FIXTURES.filter((f) =>
      planMatchesSide("buy", f.entry, f.stop, f.target),
    ).map((f) => f.ticker);

    expect(kept.sort()).toEqual([...KEEP].sort());
  });

  it("drops the 10 tickers that showed a short plan under a bullish badge", () => {
    const dropped = LIVE_FIXTURES.filter(
      (f) => !planMatchesSide("buy", f.entry, f.stop, f.target),
    );

    expect(dropped).toHaveLength(10);
    // Every dropped plan is internally coherent as a short, which is exactly
    // why the old direction-agnostic sanity check rewarded them.
    for (const f of dropped) {
      expect(planMatchesSide("sell", f.entry, f.stop, f.target)).toBe(true);
    }
  });

  it("does not simply drop everything the card marked WAIT", () => {
    const bac = LIVE_FIXTURES.find((f) => f.ticker === "BAC");
    expect(bac?.cardDirection).toBe("WAIT");
    expect(planMatchesSide("buy", bac!.entry, bac!.stop, bac!.target)).toBe(true);
  });
});
