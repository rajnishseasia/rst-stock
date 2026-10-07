import { describe, expect, it } from "bun:test";

import {
  perpMarketOpenInterestUsd,
  sortPerpMarkets,
  type SortablePerpMarket,
} from "./perp-market-sort";

const markets: SortablePerpMarket[] = [
  {
    coin: "BTC",
    markPx: "60000",
    prevDayPx: "59000",
    dayNtlVlm: "2000000",
    openInterest: "10",
  },
  {
    coin: "ETH",
    markPx: "3000",
    prevDayPx: "3100",
    dayNtlVlm: "4000000",
    openInterest: "1000",
  },
  {
    coin: "SOL",
    markPx: "150",
    prevDayPx: "100",
    dayNtlVlm: null,
    openInterest: "2000",
  },
];

describe("sortPerpMarkets", () => {
  it("sorts volume and notional open interest from largest to smallest", () => {
    expect(sortPerpMarkets(markets, "volume").map((market) => market.coin)).toEqual([
      "ETH",
      "BTC",
      "SOL",
    ]);
    expect(
      sortPerpMarkets(markets, "open-interest").map((market) => market.coin),
    ).toEqual(["ETH", "BTC", "SOL"]);
  });

  it("sorts both daily change directions and keeps unavailable values last", () => {
    expect(sortPerpMarkets(markets, "gainers").map((market) => market.coin)).toEqual([
      "SOL",
      "BTC",
      "ETH",
    ]);
    expect(sortPerpMarkets(markets, "losers").map((market) => market.coin)).toEqual([
      "ETH",
      "BTC",
      "SOL",
    ]);
  });

  it("sorts symbols alphabetically and handles invalid open interest", () => {
    expect(sortPerpMarkets(markets, "symbol").map((market) => market.coin)).toEqual([
      "BTC",
      "ETH",
      "SOL",
    ]);
    expect(
      perpMarketOpenInterestUsd({ ...markets[0]!, openInterest: "not-a-number" }),
    ).toBeNull();
  });
});
