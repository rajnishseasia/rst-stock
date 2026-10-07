import { describe, expect, it } from "bun:test";

import {
  decidePerpProtection,
  parsePerpProtectionRule,
  parseSourcePerpProtectionRule,
  perpProtectionCancelPlan,
  type PerpProtectionRule,
} from "../copy-mirror-perp-protection";

/** A long entered at exactly 100, so every derived price reads as a percentage. */
function longAt100(rule: PerpProtectionRule | null, leverage = 1) {
  return decidePerpProtection({
    rule,
    side: "long",
    entryPx: "100",
    leverage,
    sizeCoin: "1",
  });
}

describe("copy-mirror perp protection: reading the follow's rule", () => {
  it("reads immutable source prices without inventing a missing leg", () => {
    expect(parseSourcePerpProtectionRule({
      initialTakeProfitPx: "125.5",
      initialStopLossPx: null,
    })).toEqual({
      takeProfitRoePct: null,
      stopLossRoePct: null,
      takeProfitPx: "125.5",
    });
    expect(parseSourcePerpProtectionRule({
      initialTakeProfitPx: "not-a-price",
      initialStopLossPx: null,
    })).toBeNull();
  });

  it("treats a follow with neither leg configured as having no rule at all", () => {
    // The whole feature is off by default. A row where both columns are null is
    // every row that existed before this shipped, and it must attach nothing.
    expect(parsePerpProtectionRule({ perpTakeProfitPct: null, perpStopLossPct: null })).toBeNull();
    expect(parsePerpProtectionRule(null)).toBeNull();
    expect(longAt100(null)).toEqual({ action: "none", reason: "not-configured" });
  });

  it("reads one configured leg without inventing the other", () => {
    expect(parsePerpProtectionRule({ perpStopLossPct: "25.00", perpTakeProfitPct: null })).toEqual({
      takeProfitRoePct: null,
      stopLossRoePct: 25,
    });
  });

  it("drops an out-of-bounds leg rather than clamping it to a number nobody chose", () => {
    // 5000% is past the take-profit ceiling. Clamping would place a target the
    // follower never picked and then report it back as theirs.
    const rule = parsePerpProtectionRule({
      perpTakeProfitPct: "5000.00",
      perpStopLossPct: "25.00",
    });
    expect(rule).toEqual({ takeProfitRoePct: null, stopLossRoePct: 25 });
  });

  it("drops a stop at or past the margin, which is a stop that could never fire", () => {
    // 100% of margin is liquidation territory, and at 1x it derives a trigger of
    // exactly zero. The bound is what keeps that out.
    expect(parsePerpProtectionRule({ perpStopLossPct: "100.00" })).toBeNull();
    expect(parsePerpProtectionRule({ perpStopLossPct: "90.00" })).toEqual({
      takeProfitRoePct: null,
      stopLossRoePct: 90,
    });
  });
});

describe("copy-mirror perp protection: ROE to trigger price", () => {
  it("copies exact initial source prices for a long", () => {
    expect(longAt100({
      takeProfitRoePct: null,
      stopLossRoePct: null,
      takeProfitPx: "125.5",
      stopLossPx: "91.25",
    })).toMatchObject({
      action: "attach",
      takeProfitPx: "125.5",
      stopLossPx: "91.25",
      droppedLegs: [],
    });
  });

  it("drops a copied source leg that crossed the follower entry", () => {
    const decision = longAt100({
      takeProfitRoePct: null,
      stopLossRoePct: null,
      takeProfitPx: "99",
      stopLossPx: "90",
    });
    expect(decision).toMatchObject({
      action: "attach",
      stopLossPx: "90",
      droppedLegs: ["tp"],
    });
    expect(decision).not.toHaveProperty("takeProfitPx");
  });

  it("prices a stop off MARGIN, so the same 25% is a different price at 1x and at 20x", () => {
    // This is the whole reason the basis is ROE. A 25% price move and a 25%
    // margin move are the same thing only at 1x; at 20x the follower asking to
    // risk a quarter of their margin is asking for a 1.25% price move, and
    // reading their number as a price move would risk twenty times what they
    // said.
    const rule: PerpProtectionRule = { takeProfitRoePct: null, stopLossRoePct: 25 };
    expect(longAt100(rule, 1)).toMatchObject({ action: "attach", stopLossPx: "75" });
    expect(longAt100(rule, 20)).toMatchObject({ action: "attach", stopLossPx: "98.75" });
  });

  it("puts a long's take-profit above the entry and its stop below it", () => {
    const decision = longAt100({ takeProfitRoePct: 50, stopLossRoePct: 25 }, 2);
    expect(decision).toMatchObject({
      action: "attach",
      takeProfitPx: "125",
      stopLossPx: "87.5",
    });
  });

  it("mirrors both legs for a short: take-profit below the entry, stop above it", () => {
    const decision = decidePerpProtection({
      rule: { takeProfitRoePct: 50, stopLossRoePct: 25 },
      side: "short",
      entryPx: "100",
      leverage: 2,
      sizeCoin: "1",
    });
    expect(decision).toMatchObject({
      action: "attach",
      takeProfitPx: "75",
      stopLossPx: "112.5",
    });
  });

  it("drops a leg that prices at or below zero and still attaches the other", () => {
    // A short taking profit at 500% of margin at 1x would need the coin to be
    // worth minus four times what it is now.
    const decision = decidePerpProtection({
      rule: { takeProfitRoePct: 500, stopLossRoePct: 25 },
      side: "short",
      entryPx: "100",
      leverage: 1,
      sizeCoin: "1",
    });
    expect(decision).toMatchObject({
      action: "attach",
      stopLossPx: "125",
      droppedLegs: ["tp"],
    });
    expect(decision).not.toHaveProperty("takeProfitPx");
  });

  it("attaches nothing when the entry, the leverage or the size is unusable", () => {
    const rule: PerpProtectionRule = { takeProfitRoePct: 50, stopLossRoePct: 25 };
    const base = { rule, side: "long" as const, entryPx: "100", leverage: 2, sizeCoin: "1" };
    expect(decidePerpProtection({ ...base, entryPx: "0" })).toEqual({
      action: "none",
      reason: "unusable-entry",
    });
    expect(decidePerpProtection({ ...base, entryPx: "not-a-price" })).toEqual({
      action: "none",
      reason: "unusable-entry",
    });
    expect(decidePerpProtection({ ...base, leverage: 0 })).toEqual({
      action: "none",
      reason: "unusable-leverage",
    });
    expect(decidePerpProtection({ ...base, sizeCoin: "0" })).toEqual({
      action: "none",
      reason: "unusable-size",
    });
  });

  it("keeps sub-dollar coins at real precision instead of rounding them to zero", () => {
    // Hyperliquid quotes across a huge dynamic range. A two-decimal trigger on a
    // fraction-of-a-cent coin is "0.00", which is not a price.
    const decision = decidePerpProtection({
      rule: { takeProfitRoePct: null, stopLossRoePct: 25 },
      side: "long",
      entryPx: "0.00004",
      leverage: 1,
      sizeCoin: "1000000",
    });
    expect(decision).toMatchObject({ action: "attach", stopLossPx: "0.00003" });
  });
});

describe("copy-mirror perp protection: retiring the legs", () => {
  it("names only the legs this plan actually placed", () => {
    expect(
      perpProtectionCancelPlan({ legClientOrderIds: ["seed:sl:75", "seed:tp:125"] }, "attached"),
    ).toEqual(["seed:sl:75", "seed:tp:125"]);
  });

  it("has nothing to cancel for an order that never had protection", () => {
    expect(perpProtectionCancelPlan(null, null)).toEqual([]);
    expect(perpProtectionCancelPlan({ legClientOrderIds: [] }, "attached")).toEqual([]);
  });

  it("does not re-cancel a plan a previous close already retired", () => {
    expect(
      perpProtectionCancelPlan({ legClientOrderIds: ["seed:sl:75"] }, "cancelled"),
    ).toEqual([]);
  });
});
