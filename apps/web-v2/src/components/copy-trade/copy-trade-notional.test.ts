/**
 * A copy-feed row showed the ticker, the side and a live quote, but nothing
 * about size: a $50 dabble and a $50,000 conviction trade rendered identically.
 * These tests pin the dollar figure that fixes it, and the cases where showing
 * one would be a lie.
 */

import { describe, expect, test } from "bun:test";

import { copyTradeNotionalUsd } from "./copy-trade-notional";

describe("copyTradeNotionalUsd", () => {
  test("values an equity trade at the fill price", () => {
    expect(copyTradeNotionalUsd({ qty: 3, fillPrice: 550, assetType: "EQUITY" })).toBe(1650);
  });

  test("applies the 100x contract multiplier to an option", () => {
    // 2 contracts at a $3.52 premium is $704 spent, not $7.04.
    expect(copyTradeNotionalUsd({ qty: 2, fillPrice: 3.52, assetType: "OPTION" })).toBe(704);
    expect(copyTradeNotionalUsd({ qty: 2, fillPrice: 3.52, assetType: "option" })).toBe(704);
  });

  test("values a perp at its coin size, however small the unit price", () => {
    const notional = copyTradeNotionalUsd({
      qty: 5561,
      fillPrice: 0.15251,
      assetType: "PERP",
    });
    expect(notional).toBeCloseTo(848.11, 2);
  });

  test("falls back to the resting limit price when there is no fill yet", () => {
    expect(copyTradeNotionalUsd({ qty: 3, limitPrice: 550, assetType: "EQUITY" })).toBe(1650);
    // A fill price, when present, wins over the limit it was placed at.
    expect(
      copyTradeNotionalUsd({ qty: 3, fillPrice: 540, limitPrice: 550, assetType: "EQUITY" }),
    ).toBe(1620);
  });

  test("reports a size for a sell, not a negative amount", () => {
    expect(copyTradeNotionalUsd({ qty: -3, fillPrice: 550 })).toBe(1650);
  });

  test("is null when the size cannot be computed, so no $0.00 is shown", () => {
    // An x_signal row carries no qty at all; a caller's post is not a trade.
    expect(copyTradeNotionalUsd({ fillPrice: 550 })).toBeNull();
    expect(copyTradeNotionalUsd({ qty: 0, fillPrice: 550 })).toBeNull();
    expect(copyTradeNotionalUsd({ qty: 3 })).toBeNull();
    expect(copyTradeNotionalUsd({ qty: 3, fillPrice: 0 })).toBeNull();
    expect(copyTradeNotionalUsd({ qty: 3, fillPrice: -5 })).toBeNull();
    expect(copyTradeNotionalUsd(null)).toBeNull();
    expect(copyTradeNotionalUsd(undefined)).toBeNull();
  });

  test("rejects junk in the untyped meta bag rather than coercing it", () => {
    expect(copyTradeNotionalUsd({ qty: "three", fillPrice: 550 })).toBeNull();
    expect(copyTradeNotionalUsd({ qty: 3, fillPrice: {} })).toBeNull();
    expect(copyTradeNotionalUsd({ qty: Number.NaN, fillPrice: 550 })).toBeNull();
    // Numeric strings are what the API's decimal columns hand back, so those
    // must still work.
    expect(copyTradeNotionalUsd({ qty: "3", fillPrice: "550" })).toBe(1650);
  });
});
