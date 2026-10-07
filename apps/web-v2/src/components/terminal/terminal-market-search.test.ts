import { describe, expect, test } from "bun:test";
import {
  canSelectMarket,
  sanitizeRecentMarketSelections,
  shouldShowRecentMarkets,
} from "@/lib/market-selection";

describe("TerminalMarketSearch recent markets", () => {
  test("never restores or commits a disabled perp venue", () => {
    expect(
      sanitizeRecentMarketSelections(
        [
          { symbol: "AAPL", venue: "stocks" },
          { symbol: "BTC", venue: "perps" },
          { symbol: 42, venue: "stocks" },
        ],
        false,
      ),
    ).toEqual([{ symbol: "AAPL", venue: "stocks" }]);
    expect(canSelectMarket({ symbol: "BTC", venue: "perps" }, false)).toBe(
      false,
    );
    expect(canSelectMarket({ symbol: "AAPL", venue: "stocks" }, false)).toBe(
      true,
    );
  });

  test("shares dismissal state between search suggestions and recent markets", () => {
    const base = { requested: true, isOpen: true, hasQuery: false, count: 2 };

    expect(shouldShowRecentMarkets(base)).toBe(true);
    expect(shouldShowRecentMarkets({ ...base, isOpen: false })).toBe(false);
    expect(shouldShowRecentMarkets({ ...base, requested: false })).toBe(false);
    expect(shouldShowRecentMarkets({ ...base, hasQuery: true })).toBe(false);
    expect(shouldShowRecentMarkets({ ...base, count: 0 })).toBe(false);
  });
});
