import { describe, expect, test } from "bun:test";
import {
  buildTickerItems,
  TICKER_DEFAULT_SYMBOLS,
} from "./terminal-market-ticker";

describe("buildTickerItems: fallback and caps", () => {
  const stocks = (activeStockSymbol: string, watchlistItems?: { symbol: string; venue: "stocks" | "perps" }[] | null) =>
    buildTickerItems({
      activeStockSymbol,
      activePerpSymbol: "",
      activeVenue: "stocks",
      watchlistItems,
    });

  test("falls back to the major-index defaults when the watchlist is empty", () => {
    expect(stocks("AAPL", [])).toEqual([
      { symbol: "AAPL", venue: "stocks" },
      ...TICKER_DEFAULT_SYMBOLS.map((symbol) => ({ symbol, venue: "stocks" as const })),
    ]);
  });

  test("normalizes stock casing and whitespace, de-dupes the active symbol", () => {
    expect(
      stocks("tsla", [
        { symbol: "TSLA", venue: "stocks" },
        { symbol: " nvda ", venue: "stocks" },
        { symbol: "", venue: "stocks" },
      ]),
    ).toEqual([
      { symbol: "TSLA", venue: "stocks" },
      { symbol: "NVDA", venue: "stocks" },
    ]);
  });

  test("caps the tape at 30 items with the active market first", () => {
    const watchlistItems = Array.from({ length: 40 }, (_, i) => ({
      symbol: `S${i}`,
      venue: "stocks" as const,
    }));
    const result = stocks("SPY", watchlistItems);
    expect(result.length).toBe(30);
    expect(result[0]).toEqual({ symbol: "SPY", venue: "stocks" });
  });

  test("drops over-long STOCK symbols before choosing the fallback", () => {
    // The 10-char cap protects the getChartQuotes batch: one over-long stock
    // fails zod for the whole request and blanks every cell.
    expect(stocks("AAPL", [{ symbol: "WAYTOOLONGTICKER", venue: "stocks" }])).toEqual([
      { symbol: "AAPL", venue: "stocks" },
      ...TICKER_DEFAULT_SYMBOLS.map((symbol) => ({ symbol, venue: "stocks" as const })),
    ]);
  });

  test("keeps long PERP symbols: the stock quote cap does not apply to them", () => {
    // Codex P2: Hyperliquid names run long ("xyz:brentoil" is 12 chars, the
    // watchlist schema allows 32) and perp symbols never enter the
    // getChartQuotes request. Capping them at 10 dropped real markets from
    // the tape, and a watchlist of ONLY long perp names filtered to empty and
    // fell back to unrelated stock indices.
    expect(
      buildTickerItems({
        activeStockSymbol: "",
        activePerpSymbol: "xyz:brentoil",
        activeVenue: "perps",
        watchlistItems: [{ symbol: "xyz:heatingoil", venue: "perps" }],
      }),
    ).toEqual([
      { symbol: "xyz:brentoil", venue: "perps" },
      { symbol: "xyz:heatingoil", venue: "perps" },
    ]);
  });
});

describe("buildTickerItems", () => {
  test("preserves venue identity for overlapping symbols", () => {
    expect(
      buildTickerItems({
        activeStockSymbol: "",
        activePerpSymbol: "BTC",
        activeVenue: "perps",
        watchlistItems: [
          { symbol: "BTC", venue: "stocks" },
          { symbol: "BTC", venue: "perps" },
        ],
      }),
    ).toEqual([
      { symbol: "BTC", venue: "perps" },
      { symbol: "BTC", venue: "stocks" },
    ]);
  });

  test("preserves Hyperliquid's canonical coin spelling for perp items", () => {
    // HL spells coins case-sensitively (kPEPE, xyz:GOOGL) and every consumer
    // downstream keys on that spelling: the allMids price lookup, the
    // marketStats 24h-change lookup, and the click handler that navigates the
    // chart. Uppercasing perp coins made all three miss at once (Codex P2:
    // the 24h badge rendered a permanent "-" for mixed-case coins). Stocks
    // still normalize; identity stays case-insensitive.
    expect(
      buildTickerItems({
        activeStockSymbol: "spy",
        activePerpSymbol: "xyz:GOOGL",
        activeVenue: "perps",
        watchlistItems: [
          { symbol: "kPEPE", venue: "perps" },
          { symbol: " spy ", venue: "stocks" },
        ],
      }),
    ).toEqual([
      { symbol: "xyz:GOOGL", venue: "perps" },
      { symbol: "kPEPE", venue: "perps" },
      { symbol: "SPY", venue: "stocks" },
    ]);
  });

  test("selects the RAW per-venue active symbol internally", () => {
    // Round two of the same finding: the first fix canonicalized inside the
    // builder, but the component still passed its pre-uppercased
    // normalizedActiveSymbol as the single activeSymbol input, so the active
    // perp stayed uppercase and, being first, won dedupe over the correctly
    // cased watchlist copy. The builder now takes both raw symbols and picks
    // per venue, leaving the caller no pre-normalization to get wrong.
    expect(
      buildTickerItems({
        activeStockSymbol: "SPY",
        activePerpSymbol: "kPEPE",
        activeVenue: "perps",
        watchlistItems: [{ symbol: "kPEPE", venue: "perps" }],
      }),
    ).toEqual([{ symbol: "kPEPE", venue: "perps" }]);
  });

  test("dedupes perp spellings case-insensitively without rewriting them", () => {
    // The same coin arriving in two cases must not render two cells, and the
    // FIRST spelling (the active item's, which came from the venue context and
    // is canonical) is the one that survives.
    expect(
      buildTickerItems({
        activeStockSymbol: "",
        activePerpSymbol: "kPEPE",
        activeVenue: "perps",
        watchlistItems: [{ symbol: "KPEPE", venue: "perps" }],
      }),
    ).toEqual([{ symbol: "kPEPE", venue: "perps" }]);
  });

  test("keeps perp items out of the stock-only fallback identity", () => {
    expect(
      buildTickerItems({
        activeStockSymbol: "SPY",
        activePerpSymbol: "",
        activeVenue: "stocks",
        watchlistItems: [{ symbol: "ETH", venue: "perps" }],
      }),
    ).toEqual([
      { symbol: "SPY", venue: "stocks" },
      { symbol: "ETH", venue: "perps" },
    ]);
  });
});
