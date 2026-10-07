import { describe, expect, it } from "bun:test";
import {
  MAX_SAFE_TRADING_PERP_SIZE,
  isSafePositiveTradingPerpDecimal,
  isSafeTradingPerpDecimal,
} from "../utils/safe-trading-number";

describe("safe perp decimal domain", () => {
  it("accepts the inclusive boundary and rejects the first value above it", () => {
    expect(MAX_SAFE_TRADING_PERP_SIZE).toBe("90071992.54740991");
    expect(isSafePositiveTradingPerpDecimal(MAX_SAFE_TRADING_PERP_SIZE)).toBe(true);
    expect(isSafePositiveTradingPerpDecimal("90071992.54740992")).toBe(false);
  });

  it("compares decimal strings before numeric conversion", () => {
    expect(isSafeTradingPerpDecimal("0")).toBe(true);
    expect(isSafeTradingPerpDecimal("00090071992.5474099100")).toBe(true);
    expect(isSafeTradingPerpDecimal("9999999999999999.99999999")).toBe(false);
    expect(isSafeTradingPerpDecimal("1e3")).toBe(false);
    expect(isSafePositiveTradingPerpDecimal("0.00000000")).toBe(false);
  });
});
