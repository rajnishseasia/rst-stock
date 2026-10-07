import { describe, it, expect } from "bun:test";
import {
  computeRPrice,
  computeTrailPercent,
  defaultStopForDirection,
  entryBasisFromQuote,
  splitQty,
  sizeByRisk,
  sizeByExitPlanRisk,
  resolveSizingPrice,
  riskAtQty,
  shouldShowStopSizingFeedback,
  resolveStalePriceReset,
  shouldResetStalePriceFields,
} from "../smart-exit";

describe("entryBasisFromQuote", () => {
  it("prefers the best bid for longs (default direction)", () => {
    expect(entryBasisFromQuote({ bid: 99.97, ask: 100.03, last: 100.12 })).toBe(
      99.97,
    );
    expect(
      entryBasisFromQuote({
        bid: 99.97,
        ask: 100.03,
        last: 100.12,
        direction: "long",
      }),
    ).toBe(99.97);
  });

  it("prefers the best ask for shorts so the sell-limit rests on the ask", () => {
    expect(
      entryBasisFromQuote({
        bid: 99.97,
        ask: 100.03,
        last: 100.12,
        direction: "short",
      }),
    ).toBe(100.03);
  });

  it("falls back to last when the direction's quote side is missing", () => {
    expect(entryBasisFromQuote({ bid: 0, last: 100.12 })).toBe(100.12);
    expect(entryBasisFromQuote({ bid: null, last: 100.12 })).toBe(100.12);
    expect(
      entryBasisFromQuote({ ask: 0, last: 100.12, direction: "short" }),
    ).toBe(100.12);
    expect(
      entryBasisFromQuote({ ask: null, last: 100.12, direction: "short" }),
    ).toBe(100.12);
  });

  it("returns null when neither the quote side nor last is usable", () => {
    expect(entryBasisFromQuote({ bid: 0, last: 0 })).toBeNull();
    expect(entryBasisFromQuote({ bid: NaN, last: null })).toBeNull();
    expect(
      entryBasisFromQuote({ ask: NaN, last: null, direction: "short" }),
    ).toBeNull();
  });
});

describe("computeRPrice", () => {
  it("computes a long 0.4R target above entry", () => {
    // entry 100, stop 90 → 1R = 10 → 0.4R target = 104
    expect(computeRPrice({ entry: 100, stop: 90, direction: "long", multiple: 0.4 })).toBe(104);
  });

  it("computes a short 0.4R target below entry", () => {
    // entry 100, stop 110 → 1R = 10 → 0.4R target = 96
    expect(computeRPrice({ entry: 100, stop: 110, direction: "short", multiple: 0.4 })).toBe(96);
  });

  it("returns null when the stop is on the wrong side of entry", () => {
    expect(computeRPrice({ entry: 100, stop: 110, direction: "long", multiple: 0.4 })).toBeNull();
    expect(computeRPrice({ entry: 100, stop: 90, direction: "short", multiple: 0.4 })).toBeNull();
  });

  it("returns null for missing/invalid inputs", () => {
    expect(computeRPrice({ entry: 0, stop: 90, direction: "long", multiple: 0.4 })).toBeNull();
    expect(computeRPrice({ entry: NaN, stop: 90, direction: "long", multiple: 0.4 })).toBeNull();
  });
});

describe("computeTrailPercent", () => {
  it("returns 1R as a percent of entry", () => {
    // entry 100, stop 90 → distance 10 → 10% of entry
    expect(computeTrailPercent({ entry: 100, stop: 90 })).toBe(10);
  });

  it("floors tiny auto-filled trails at the documented default", () => {
    // entry 1000, stop 999.9 -> 0.01% -> floored to the 5% auto-fill default
    expect(computeTrailPercent({ entry: 1000, stop: 999.9 })).toBe(5);
  });

  it("returns null when entry equals stop", () => {
    expect(computeTrailPercent({ entry: 100, stop: 100 })).toBeNull();
  });
});

describe("defaultStopForDirection", () => {
  it("uses low of day for longs", () => {
    expect(defaultStopForDirection({ direction: "long", low: 98.123, high: 105 })).toBe(98.12);
  });

  it("uses high of day for shorts", () => {
    expect(defaultStopForDirection({ direction: "short", low: 98, high: 105.678 })).toBe(105.68);
  });

  it("returns null when the relevant bar is missing", () => {
    expect(defaultStopForDirection({ direction: "long", low: null, high: 105 })).toBeNull();
    expect(defaultStopForDirection({ direction: "short", high: 0 })).toBeNull();
  });
});

describe("splitQty", () => {
  it("splits 50/50 for an even total", () => {
    expect(splitQty(10, 0.5)).toEqual({ tpQty: 5, trailQty: 5 });
  });

  it("gives the rounding remainder to the runner for odd totals", () => {
    expect(splitQty(11, 0.5)).toEqual({ tpQty: 5, trailQty: 6 });
  });

  it("puts the whole position on the runner when tpFraction is 0", () => {
    expect(splitQty(7, 0)).toEqual({ tpQty: 0, trailQty: 7 });
  });

  it("gives a single share to the TP leg so the plan never seeds trailing + fixed stop with no TP", () => {
    // Regression: 1 share split 50/50 used to floor the TP leg to 0, leaving
    // trailing + fixed stop + no take-profit, which errors the ticket on open.
    expect(splitQty(1, 0.5)).toEqual({ tpQty: 1, trailQty: 0 });
  });

  it("keeps at least one TP share for tiny positions when a TP is requested", () => {
    expect(splitQty(2, 0.4)).toEqual({ tpQty: 1, trailQty: 1 });
  });

  it("puts the whole position on the TP leg when tpFraction is 1", () => {
    expect(splitQty(7, 1)).toEqual({ tpQty: 7, trailQty: 0 });
  });

  it("returns zeros for non-positive totals", () => {
    expect(splitQty(0, 0.5)).toEqual({ tpQty: 0, trailQty: 0 });
  });
});

describe("sizeByRisk", () => {
  it("sizes shares from risk and stop distance", () => {
    // $100 risk, entry 100, stop 90 → 100 / 10 = 10 shares
    expect(sizeByRisk({ maxRisk: 100, entry: 100, stop: 90, direction: "long" })).toBe(10);
  });

  it("rounds to the nearest share", () => {
    // $100 / 3 = 33.33 → 33
    expect(sizeByRisk({ maxRisk: 100, entry: 100, stop: 97, direction: "long" })).toBe(33);
  });

  it("returns 0 when the stop is on the wrong side", () => {
    expect(sizeByRisk({ maxRisk: 100, entry: 100, stop: 110, direction: "long" })).toBe(0);
  });
});

describe("sizeByExitPlanRisk", () => {
  it("targets the budget using fixed-stop plus initial trailing risk", () => {
    expect(
      sizeByExitPlanRisk({
        maxRisk: 48,
        entry: 149,
        stop: 138.26,
        direction: "long",
        tpFraction: 0.5,
        trailingPercent: 5,
      }),
    ).toBe(5);
  });

  it("returns the largest whole-share split that remains under budget", () => {
    const qty = sizeByExitPlanRisk({
      maxRisk: 48,
      entry: 149,
      stop: 138.26,
      direction: "long",
      tpFraction: 0.5,
      trailingPercent: 5,
    });
    const split = splitQty(qty, 0.5);
    const risk =
      split.tpQty * (149 - 138.26) + split.trailQty * (149 * 0.05);
    expect(risk).toBeCloseTo(43.83, 2);
    expect(risk).toBeLessThanOrEqual(48);
  });
});

describe("resolveSizingPrice", () => {
  it("prefers the entry anchor over the limit and the live quote", () => {
    expect(
      resolveSizingPrice({ entryAnchor: 1150.08, limitPrice: 1149, liveLast: 1201.32 }),
    ).toBe(1150.08);
  });

  it("falls back to the limit price when there's no entry anchor", () => {
    expect(
      resolveSizingPrice({ entryAnchor: 0, limitPrice: 1149, liveLast: 1201.32 }),
    ).toBe(1149);
  });

  it("falls back to the live quote for a market order with no anchor", () => {
    expect(
      resolveSizingPrice({ entryAnchor: NaN, limitPrice: 0, liveLast: 1201.32 }),
    ).toBe(1201.32);
  });

  it("uses the live quote for market entries even when a hidden entry anchor exists", () => {
    expect(
      resolveSizingPrice({
        entryAnchor: 1121.4,
        limitPrice: 1121.4,
        liveLast: 1123.84,
        preferEntryAnchor: false,
      }),
    ).toBe(1123.84);
  });

  it("returns 0 when no usable price is available", () => {
    expect(resolveSizingPrice({ entryAnchor: 0, limitPrice: NaN, liveLast: 0 })).toBe(0);
  });
});

describe("shouldShowStopSizingFeedback", () => {
  it("hides stop-sizing feedback for embedded plain orders with no visible stop control", () => {
    expect(
      shouldShowStopSizingFeedback({ orderType: "Market", embedded: true }),
    ).toBe(false);
  });

  it("shows stop-sizing feedback when the stop control is visible or the exit plan is active", () => {
    expect(
      shouldShowStopSizingFeedback({ orderType: "Market", embedded: false }),
    ).toBe(true);
    expect(
      shouldShowStopSizingFeedback({ orderType: "OCO", embedded: true }),
    ).toBe(true);
  });
});

describe("shouldResetStalePriceFields", () => {
  it("clears stale stop/target when the traded symbol changes with no prefill", () => {
    // The reported bug: a SPY ticket (stop 737.35, target 737.93) switched to
    // HYPE via a plain "Copy $HYPE" chip must not carry SPY's price levels.
    expect(
      shouldResetStalePriceFields({
        previousSymbol: "SPY",
        nextSymbol: "HYPE",
      }),
    ).toBe(true);
  });

  it("normalizes case/whitespace before comparing symbols", () => {
    // A switch that only differs by case/spacing is the same symbol - no reset.
    expect(
      shouldResetStalePriceFields({
        previousSymbol: "spy",
        nextSymbol: "  SPY ",
      }),
    ).toBe(false);
    // A genuine change survives normalization.
    expect(
      shouldResetStalePriceFields({
        previousSymbol: " spy ",
        nextSymbol: "hype",
      }),
    ).toBe(true);
  });

  it("still resets when a prefill is present (the prefill only narrows fields)", () => {
    // A prefill no longer suppresses the reset wholesale: resolveStalePriceReset
    // decides which fields the prefill owns.
    expect(
      shouldResetStalePriceFields({
        previousSymbol: "SPY",
        nextSymbol: "HYPE",
        prefill: { hasStop: true },
      }),
    ).toBe(true);
  });

  it("does not wipe user input on a same-symbol re-render", () => {
    expect(
      shouldResetStalePriceFields({
        previousSymbol: "SPY",
        nextSymbol: "SPY",
      }),
    ).toBe(false);
  });

  it("does not reset on the first mount (no prior symbol)", () => {
    expect(
      shouldResetStalePriceFields({ previousSymbol: null, nextSymbol: "SPY" }),
    ).toBe(false);
    expect(
      shouldResetStalePriceFields({ previousSymbol: "", nextSymbol: "SPY" }),
    ).toBe(false);
  });

  it("does not reset when the next symbol is empty", () => {
    expect(
      shouldResetStalePriceFields({ previousSymbol: "SPY", nextSymbol: "" }),
    ).toBe(false);
  });
});

describe("resolveStalePriceReset", () => {
  it("clears every stale price field when there is no prefill", () => {
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "HYPE",
    });
    expect(plan).toEqual({
      shouldReset: true,
      clearStop: true,
      clearEntry: true,
      clearTakeProfits: true,
      clearTrigger: true,
      clearTrailingQty: true,
    });
  });

  it("keeps a full stop+target+entry prefill intact", () => {
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "HYPE",
      prefill: { hasEntry: true, hasStop: true, hasTarget: true },
    });
    expect(plan.shouldReset).toBe(true);
    expect(plan.clearStop).toBe(false);
    expect(plan.clearEntry).toBe(false);
    expect(plan.clearTakeProfits).toBe(false);
  });

  it("clears the prior symbol's take-profit and entry on a STOP-ONLY prefill", () => {
    // The real-money case: a chat draft "long HYPE with a stop at 40" whose
    // entry anchor failed (no snapshot for HYPE) carries a stop and nothing
    // else. SPY's take-profit row becomes a live broker exit leg on submit, so
    // it must not survive onto the HYPE ticket, and neither must SPY's entry.
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "HYPE",
      prefill: { hasStop: true },
    });
    expect(plan.shouldReset).toBe(true);
    expect(plan.clearStop).toBe(false); // the prefill owns the stop
    expect(plan.clearTakeProfits).toBe(true); // SPY's target must go
    expect(plan.clearEntry).toBe(true); // SPY's entry/limit must go
  });

  it("clears the take-profit legs when a prefill has a target but no stop", () => {
    // resolveSignalPrefillPlan only writes takeProfits when BOTH stop and
    // target are present, so a target-only prefill does not own the TP legs.
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "HYPE",
      prefill: { hasTarget: true },
    });
    expect(plan.clearTakeProfits).toBe(true);
    expect(plan.clearStop).toBe(true);
  });

  it("keeps an entry-only prefill's entry but clears stop and target", () => {
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "HYPE",
      prefill: { hasEntry: true },
    });
    expect(plan.clearEntry).toBe(false);
    expect(plan.clearStop).toBe(true);
    expect(plan.clearTakeProfits).toBe(true);
  });

  it("always clears the trigger and trailing qty, which no prefill supplies", () => {
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "HYPE",
      prefill: { hasEntry: true, hasStop: true, hasTarget: true },
    });
    expect(plan.clearTrigger).toBe(true);
    expect(plan.clearTrailingQty).toBe(true);
  });

  it("returns a no-op plan when the symbol did not change", () => {
    const plan = resolveStalePriceReset({
      previousSymbol: "SPY",
      nextSymbol: "SPY",
    });
    expect(plan.shouldReset).toBe(false);
    expect(plan.clearStop).toBe(false);
    expect(plan.clearTakeProfits).toBe(false);
  });
});

describe("riskAtQty", () => {
  it("computes equity stop-out loss from the given price", () => {
    expect(
      riskAtQty({ qty: 19, price: 1150.08, stop: 1136.82, direction: "long" }),
    ).toBeCloseTo(251.94, 2);
  });

  it("multiplies by 100 for option contracts", () => {
    expect(
      riskAtQty({ qty: 2, price: 5, stop: 3, direction: "long", isOption: true }),
    ).toBe(400);
  });

  it("returns null when the stop is on the wrong side or inputs are unusable", () => {
    expect(riskAtQty({ qty: 19, price: 1136, stop: 1136.82, direction: "long" })).toBeNull();
    expect(riskAtQty({ qty: 0, price: 1150, stop: 1136, direction: "long" })).toBeNull();
  });
});

// Regression: the size, the suggested size, and the risk readout must all be
// measured from the SAME price. The bug measured size off the entry anchor but
// the risk readout off the (different) live quote, so a $247 budget showed
// "19 shares" yet "you risk $1,225". Lock the consistency.
describe("entry-vs-live sizing consistency (regression)", () => {
  const budget = 247; // 5% of a ~$4,939 portfolio
  const stop = 1136.82;
  const entryAnchor = 1150.08; // OCO limit - where you actually get filled
  const liveLast = 1201.32; // live quote - NOT where you transact on a limit

  it("sizes and reads back risk off one shared (entry) price, within budget", () => {
    const price = resolveSizingPrice({ entryAnchor, limitPrice: 0, liveLast });
    expect(price).toBe(entryAnchor);

    const qty = sizeByRisk({ maxRisk: budget, entry: price, stop, direction: "long" });
    expect(qty).toBe(19);

    const risk = riskAtQty({ qty, price, stop, direction: "long" });
    // ~$252 - the rounding nudge over the $247 budget, i.e. ≈5%, NOT 25%.
    expect(risk).not.toBeNull();
    expect(risk!).toBeCloseTo(251.94, 2);
    expect(risk!).toBeLessThan(budget * 1.1);
  });

  it("demonstrates the old live-price basis produced the inconsistent numbers", () => {
    // Sizing off the live price under-sizes (4) while the readout for the
    // entry-based 19 shares, measured off live, balloons to ~$1,225.
    const liveSized = sizeByRisk({ maxRisk: budget, entry: liveLast, stop, direction: "long" });
    expect(liveSized).toBe(4);
    const liveRiskOf19 = riskAtQty({ qty: 19, price: liveLast, stop, direction: "long" });
    expect(liveRiskOf19!).toBeCloseTo(1225.5, 1);
  });
});
