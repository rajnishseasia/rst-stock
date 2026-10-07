/**
 * Unit tests for the copy-mirror perp sizing/margin math.
 *
 * These cover the arithmetic that decides how much leverage a follower ends up
 * carrying, so the cases that matter are the ones where an input is MISSING or
 * ambiguous. Every one of those must produce "no" rather than a number that
 * permits an order.
 */

import { describe, expect, it } from "bun:test";
import {
  freeCrossCollateralUsd,
  validatePerpVenueNotional,
  meetsPerpMinimumNotional,
  perpMarketNotionalBoundsUsd,
  withinPerpMarginCapacity,
  MIRROR_PERP_MARGIN_HEADROOM,
  MIRROR_PERP_MARKET_SLIPPAGE,
} from "../copy-mirror-perp-sizing";
import { MIRROR_MIN_ORDER_NOTIONAL_USD } from "@trade-bot/types";

describe("freeCrossCollateralUsd", () => {
  it("subtracts committed margin from account value", () => {
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "10000.5", totalMarginUsedUsd: "9500.25" }),
    ).toBeCloseTo(500.25, 6);
  });

  it("returns null rather than the account total when the summary is missing", () => {
    // The whole point of the change: a missing summary must not degrade to
    // "everything is free", which is what reading the total value amounted to.
    expect(freeCrossCollateralUsd(null)).toBeNull();
    expect(freeCrossCollateralUsd(undefined)).toBeNull();
  });

  it("treats a blank margin figure as unknown, not as zero committed margin", () => {
    // Number("") is 0, so a blank totalMarginUsed would otherwise report every
    // committed dollar as free.
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "10000", totalMarginUsedUsd: "" }),
    ).toBeNull();
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "  ", totalMarginUsedUsd: "10" }),
    ).toBeNull();
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "10000", totalMarginUsedUsd: "not-a-number" }),
    ).toBeNull();
  });

  it("reports a fully committed account as no free collateral", () => {
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "1000", totalMarginUsedUsd: "1000" }),
    ).toBe(0);
  });
});

describe("perpMarketNotionalBoundsUsd", () => {
  it("brackets the mark notional by the slippage band the order is submitted with", () => {
    const bounds = perpMarketNotionalBoundsUsd(2, 100);
    expect(bounds).not.toBeNull();
    expect(bounds!.markUsd).toBe(200);
    expect(bounds!.highUsd).toBeCloseTo(200 * (1 + MIRROR_PERP_MARKET_SLIPPAGE), 8);
    expect(bounds!.lowUsd).toBeCloseTo(200 * (1 - MIRROR_PERP_MARKET_SLIPPAGE), 8);
  });

  it("returns null for any unusable input instead of a zero notional", () => {
    expect(perpMarketNotionalBoundsUsd(0, 100)).toBeNull();
    expect(perpMarketNotionalBoundsUsd(-1, 100)).toBeNull();
    expect(perpMarketNotionalBoundsUsd(1, 0)).toBeNull();
    expect(perpMarketNotionalBoundsUsd(1, Number.NaN)).toBeNull();
    expect(perpMarketNotionalBoundsUsd(1, 100, 1)).toBeNull();
    expect(perpMarketNotionalBoundsUsd(1, 100, -0.1)).toBeNull();
  });
});

describe("validatePerpVenueNotional", () => {
  it("returns the exact venue-formatted size, price, and notional", () => {
    expect(validatePerpVenueNotional({
      sizeCoin: "0.123456789",
      markPrice: "100",
      side: "long",
      sizeDecimals: 3,
      maxOrderDollars: 1_000,
    })).toEqual({
      action: "place",
      sizeCoin: "0.123",
      price: "105",
      notionalUsd: 12.915,
    });
  });

  it("uses the venue's widened coarse-tick price for the hard cap", () => {
    // The nominal 5% long limit is 11.97, but szDecimals=6 truncates prices to
    // whole dollars. aggressivePrice widens until it produces 12, which must be
    // judged against the cap rather than the unformatted nominal bound.
    expect(validatePerpVenueNotional({
      sizeCoin: "1",
      markPrice: "11.4",
      side: "long",
      sizeDecimals: 6,
      maxOrderDollars: 11.99,
    })).toEqual({ action: "skip", reason: "dollar-cap" });
  });

  it("uses the exact pinned mark for the venue minimum", () => {
    expect(validatePerpVenueNotional({
      sizeCoin: "0.1",
      markPrice: "100",
      side: "short",
      sizeDecimals: 3,
      maxOrderDollars: 1_000,
    })).toEqual({
      action: "place",
      sizeCoin: "0.1",
      price: "95",
      notionalUsd: 9.5,
    });
  });

  it("validates a short against its exact submitted sell limit payload", () => {
    // The short payload limit is 95. The strict guard is for the exact
    // venue-formatted request (0.125 * 95), while the pre-sizing high bound
    // remains a separate conservative fill-risk check.
    expect(validatePerpVenueNotional({
      sizeCoin: "0.125",
      markPrice: "100",
      side: "short",
      sizeDecimals: 3,
      maxOrderDollars: 1_000,
    })).toEqual({
      action: "place",
      sizeCoin: "0.125",
      price: "95",
      notionalUsd: 11.875,
    });
  });

  it("fails closed when the mark or cap cannot be represented safely", () => {
    expect(validatePerpVenueNotional({
      sizeCoin: "1",
      markPrice: "1e2",
      side: "long",
      sizeDecimals: 3,
      maxOrderDollars: 1_000,
    })).toEqual({ action: "skip", reason: "no-qty" });
    expect(validatePerpVenueNotional({
      sizeCoin: "1",
      markPrice: "100",
      side: "long",
      sizeDecimals: 3,
      maxOrderDollars: Number.NaN,
    })).toEqual({ action: "skip", reason: "dollar-cap" });
  });
});

describe("meetsPerpMinimumNotional", () => {
  it("measures the pinned mark against the venue floor", () => {
    // The venue minimum is measured at the mark, not the side-specific IOC
    // limit, so a $10 short at the mark remains valid even though its sell
    // payload notional is $9.50.
    expect(meetsPerpMinimumNotional(perpMarketNotionalBoundsUsd(0.1, 100))).toBe(true);
    expect(meetsPerpMinimumNotional(perpMarketNotionalBoundsUsd(0.099, 100))).toBe(false);
    expect(MIRROR_MIN_ORDER_NOTIONAL_USD).toBe(10);
  });

  it("is false when the bounds could not be computed", () => {
    expect(meetsPerpMinimumNotional(null)).toBe(false);
  });
});

describe("withinPerpMarginCapacity", () => {
  const bounds = perpMarketNotionalBoundsUsd(10, 100);

  it("compares the worst-case margin against free collateral with headroom", () => {
    // 10 coins at $100 can fill at $1,050 of notional; at 5x that is $210 of
    // margin, so $200 free is not enough even though $1,000/5 = $200 would fit.
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: 200, leverage: 5 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: 400, leverage: 5 }),
    ).toBe(true);
  });

  it("leaves the configured headroom for fees and the mark-to-fill gap", () => {
    const requiredMargin = bounds!.highUsd / 5;
    const exact = requiredMargin / MIRROR_PERP_MARGIN_HEADROOM;
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: exact, leverage: 5 }),
    ).toBe(true);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: exact * 0.999, leverage: 5 }),
    ).toBe(false);
  });

  it("fails closed on unknown collateral and on unusable leverage", () => {
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: null, leverage: 5 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: Number.NaN, leverage: 5 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: 0, leverage: 5 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: -100, leverage: 5 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: 1_000_000, leverage: 0 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds, freeCollateralUsd: 1_000_000, leverage: 2.5 }),
    ).toBe(false);
    expect(
      withinPerpMarginCapacity({ bounds: null, freeCollateralUsd: 1_000_000, leverage: 5 }),
    ).toBe(false);
  });
});
