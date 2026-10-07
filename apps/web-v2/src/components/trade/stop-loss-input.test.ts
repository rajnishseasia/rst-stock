import { describe, expect, test } from "bun:test";
import {
  normalizeStopLossInput,
  roundUpToCents,
  validateStopLossDirection,
} from "./stop-loss-input";

describe("stop loss price input", () => {
  test("rounds prices up to the nearest cent", () => {
    expect(roundUpToCents(101.231)).toBe(101.24);
    expect(roundUpToCents(101.23)).toBe(101.23);
    expect(roundUpToCents(0.001)).toBe(0.01);
  });

  test("sanitizes repeated decimal points before rounding", () => {
    expect(normalizeStopLossInput("101...234")).toEqual({
      success: true,
      value: 101.24,
      displayValue: "101.24",
      wasSanitized: true,
      wasRoundedUp: true,
    });
  });

  test("accepts common money formatting", () => {
    expect(normalizeStopLossInput(" $1,234.5 ")).toEqual({
      success: true,
      value: 1234.5,
      displayValue: "1234.50",
      wasSanitized: false,
      wasRoundedUp: false,
    });
  });

  test("returns a clean validation error for invalid prices", () => {
    expect(normalizeStopLossInput("...")).toEqual({
      success: false,
      error: "Enter a positive stop price.",
    });
    expect(normalizeStopLossInput("abc")).toEqual({
      success: false,
      error: "Use digits and a decimal point only.",
    });
    expect(normalizeStopLossInput("0")).toEqual({
      success: false,
      error: "Enter a positive stop price.",
    });
  });
});

describe("stop loss direction validation", () => {
  test("rejects a long stop at or above the current price", () => {
    expect(validateStopLossDirection(105, "long", 100)).toBe(
      "For a long, set the stop BELOW the current price."
    );
    expect(validateStopLossDirection(100, "long", 100)).toBe(
      "For a long, set the stop BELOW the current price."
    );
  });

  test("accepts a long stop below the current price", () => {
    expect(validateStopLossDirection(95, "long", 100)).toBeNull();
  });

  test("rejects a short stop at or below the current price", () => {
    expect(validateStopLossDirection(95, "short", 100)).toBe(
      "For a short, set the stop ABOVE the current price."
    );
    expect(validateStopLossDirection(100, "short", 100)).toBe(
      "For a short, set the stop ABOVE the current price."
    );
  });

  test("accepts a short stop above the current price", () => {
    expect(validateStopLossDirection(105, "short", 100)).toBeNull();
  });

  test("fails closed when the current market price is missing or invalid", () => {
    const invalidPrices = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];

    for (const currentPrice of invalidPrices) {
      expect(validateStopLossDirection(95, "long", currentPrice)).toBe(
        "Cannot validate exit price without a valid current market price."
      );
      expect(validateStopLossDirection(105, "short", currentPrice)).toBe(
        "Cannot validate exit price without a valid current market price."
      );
    }
  });
});
