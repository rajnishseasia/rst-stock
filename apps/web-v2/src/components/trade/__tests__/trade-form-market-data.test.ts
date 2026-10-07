import { describe, expect, test } from "bun:test";
import { selectMatchingMarketData } from "../trade-form-market-data";

describe("trade form market data", () => {
  test("hides cached data while the debounced symbol trails the current input", () => {
    const cachedQuote = { symbol: "AAPL", last: "200.00" };

    expect(selectMatchingMarketData("MSFT", "AAPL", cachedQuote)).toBeUndefined();
  });

  test("returns data once the requested symbol matches the normalized input", () => {
    const quote = { symbol: "AAPL", last: "200.00" };

    expect(selectMatchingMarketData(" aapl ", "AAPL", quote)).toBe(quote);
  });
});
