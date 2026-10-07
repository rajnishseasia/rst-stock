/**
 * Copy-Mirror sizing math — exhaustive cases for the four sizing modes.
 *
 * These tests cover the new modes (pct_equity, ratio), the H-2 worker-side
 * clamp on out-of-range pct values, and the M-2 fractional path (off by
 * default). The existing decision-logic suite in
 * apps/worker/src/services/__tests__/copy-mirror.test.ts covers the live
 * decideMirror guardrails; this file targets pure sizing math.
 */

import { describe, expect, it } from "bun:test";
import { computeMirrorQty, type SizingMode } from "../lib/copy-mirror";

describe("computeMirrorQty — usd mode (baseline regression)", () => {
  it("floors $500 / $100 to 5 shares", () => {
    expect(
      computeMirrorQty({ sizingMode: "usd", sizingValue: 500, buyingPower: 0, price: 100 }),
    ).toBe(5);
  });

  it("returns 0 when target dollars buy less than one whole share", () => {
    expect(
      computeMirrorQty({ sizingMode: "usd", sizingValue: 99, buyingPower: 0, price: 100 }),
    ).toBe(0);
  });
});

describe("computeMirrorQty — pct mode (M-1 baseline)", () => {
  it("sizes 5% of $100k buying power at $50 → 100 shares", () => {
    expect(
      computeMirrorQty({
        sizingMode: "pct",
        sizingValue: 5,
        buyingPower: 100_000,
        price: 50,
      }),
    ).toBe(100);
  });

  it("returns 0 when buying power is missing or zero", () => {
    expect(
      computeMirrorQty({ sizingMode: "pct", sizingValue: 5, buyingPower: 0, price: 50 }),
    ).toBe(0);
    expect(
      computeMirrorQty({
        sizingMode: "pct",
        sizingValue: 5,
        buyingPower: Number.NaN,
        price: 50,
      }),
    ).toBe(0);
  });

  // H-2: defensive clamp so a legacy row with pct>100 can never silently size
  // multiple times the buying power. Bound at 100% even if the API zod is
  // somehow bypassed.
  it("clamps pct>100 to 100% (H-2 worker-side defense)", () => {
    const clamped = computeMirrorQty({
      sizingMode: "pct",
      sizingValue: 500, // 500% — should clamp to 100%
      buyingPower: 100_000,
      price: 100,
    });
    const ceiling = computeMirrorQty({
      sizingMode: "pct",
      sizingValue: 100,
      buyingPower: 100_000,
      price: 100,
    });
    expect(clamped).toBe(ceiling);
    expect(clamped).toBe(1000); // floor(100_000 / 100) = 1000
  });
});

describe("computeMirrorQty — pct_equity mode (M-1)", () => {
  it("sizes 10% of $40k equity at $80 → 50 shares", () => {
    expect(
      computeMirrorQty({
        sizingMode: "pct_equity",
        sizingValue: 10,
        equity: 40_000,
        buyingPower: 0, // irrelevant for pct_equity
        price: 80,
      }),
    ).toBe(50);
  });

  it("returns 0 when equity is missing or zero (does NOT fall back to buying power)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "pct_equity",
        sizingValue: 10,
        equity: 0,
        buyingPower: 100_000, // ignored
        price: 50,
      }),
    ).toBe(0);

    expect(
      computeMirrorQty({
        sizingMode: "pct_equity",
        sizingValue: 10,
        // equity: undefined — should not size off buying power.
        buyingPower: 100_000,
        price: 50,
      }),
    ).toBe(0);
  });

  it("clamps pct_equity>100 to 100% (H-2 defense, mirrors pct)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "pct_equity",
        sizingValue: 250,
        equity: 50_000,
        buyingPower: 0,
        price: 100,
      }),
    ).toBe(500); // 100% of 50k / 100 = 500
  });
});

describe("computeMirrorQty — ratio mode (M-3)", () => {
  it("1.0 × source 10 = 10 shares", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 1.0,
        sourceQty: 10,
        buyingPower: 0,
        price: 50, // price doesn't matter for ratio; required for type
      }),
    ).toBe(10);
  });

  it("0.5 × source 11 = 5 shares (floors fractional intent on whole-share)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 0.5,
        sourceQty: 11, // 0.5 * 11 = 5.5 → floor to 5
        buyingPower: 0,
        price: 50,
      }),
    ).toBe(5);
  });

  it("2.0 × source 7 = 14 shares (multiplier scales up)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 2.0,
        sourceQty: 7,
        buyingPower: 0,
        price: 50,
      }),
    ).toBe(14);
  });

  it("returns 0 when sourceQty is missing (e.g., x_signal content-only)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 1.0,
        // sourceQty: undefined
        buyingPower: 0,
        price: 50,
      }),
    ).toBe(0);

    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 1.0,
        sourceQty: 0,
        buyingPower: 0,
        price: 50,
      }),
    ).toBe(0);
  });

  it("clamps ratio>10 to 10× (H-2 defense)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 50,
        sourceQty: 3,
        buyingPower: 0,
        price: 50,
      }),
    ).toBe(30); // 10 * 3 = 30
  });

  it("scales option contracts (multiplier doesn't affect ratio)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 0.5,
        sourceQty: 6,
        contractMultiplier: 100,
        buyingPower: 0,
        price: 1.25,
      }),
    ).toBe(3); // 0.5 * 6 = 3 contracts
  });
});

describe("computeMirrorQty — fractional shares (M-2 math, off by default)", () => {
  it("by default floors to whole shares (allowFractional unset = false)", () => {
    expect(
      computeMirrorQty({ sizingMode: "usd", sizingValue: 99, buyingPower: 0, price: 100 }),
    ).toBe(0);
  });

  it("with allowFractional=true on EQUITY, returns the fractional qty rounded to 6dp", () => {
    expect(
      computeMirrorQty({
        sizingMode: "usd",
        sizingValue: 99,
        buyingPower: 0,
        price: 100,
        allowFractional: true,
      }),
    ).toBe(0.99);
  });

  it("with allowFractional=true ignores fractional for OPTIONS (whole contracts only)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "usd",
        sizingValue: 99,
        buyingPower: 0,
        price: 1,
        contractMultiplier: 100, // option
        allowFractional: true,
      }),
    ).toBe(0); // 99 / (1*100) = 0.99 → floored (whole contract only)
  });

  it("fractional honors ratio mode too (0.5 × 11 = 5.5 shares when allowed)", () => {
    expect(
      computeMirrorQty({
        sizingMode: "ratio",
        sizingValue: 0.5,
        sourceQty: 11,
        buyingPower: 0,
        price: 50,
        allowFractional: true,
      }),
    ).toBe(5.5);
  });
});

describe("computeMirrorQty — invalid inputs across modes", () => {
  const modes: SizingMode[] = ["pct", "pct_equity", "usd", "ratio"];

  it.each(modes)("returns 0 for non-finite price (%s)", (mode) => {
    expect(
      computeMirrorQty({
        sizingMode: mode,
        sizingValue: 5,
        buyingPower: 100_000,
        equity: 100_000,
        sourceQty: 10,
        price: Number.NaN,
      }),
    ).toBe(0);
  });

  it.each(modes)("returns 0 for non-positive sizingValue (%s)", (mode) => {
    expect(
      computeMirrorQty({
        sizingMode: mode,
        sizingValue: 0,
        buyingPower: 100_000,
        equity: 100_000,
        sourceQty: 10,
        price: 100,
      }),
    ).toBe(0);
    expect(
      computeMirrorQty({
        sizingMode: mode,
        sizingValue: -5,
        buyingPower: 100_000,
        equity: 100_000,
        sourceQty: 10,
        price: 100,
      }),
    ).toBe(0);
  });
});
