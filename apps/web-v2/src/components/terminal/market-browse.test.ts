import { describe, expect, test } from "bun:test";
import {
  MAX_QUOTE_SYMBOL_LENGTH,
  MOBILE_BROWSE_SEARCH_LIMIT,
  POINTER_COMMIT_WINDOW_MS,
  browseQueryNeeds,
  browseQuoteSymbols,
  groupMarketSuggestions,
  marketSelectionKey,
  shouldCommitOnClick,
  type MarketBrowseRow,
} from "./market-browse";
import { MAX_QUOTE_SYMBOLS } from "@/components/feed/feed-quote-window";
import type { MarketSearchItem } from "@/lib/market-selection";

const AAPL: MarketSearchItem = {
  symbol: "AAPL",
  name: "Apple Inc",
  venues: ["stocks"],
};
const SOL_BOTH: MarketSearchItem = {
  symbol: "SOL",
  name: "ReneSola Ltd",
  venues: ["stocks", "perps"],
};
const KPEPE: MarketSearchItem = {
  symbol: "kPEPE",
  name: "",
  venues: ["perps"],
};

function stockRow(symbol: string): MarketBrowseRow {
  return { key: `stocks:${symbol}`, symbol, venue: "stocks", name: "" };
}

describe("groupMarketSuggestions", () => {
  test("splits a dual-listed symbol into one row per venue", () => {
    const groups = groupMarketSuggestions([SOL_BOTH], true);

    expect(groups.stocks).toEqual([
      { key: "stocks:SOL", symbol: "SOL", venue: "stocks", name: "ReneSola Ltd" },
    ]);
    expect(groups.perps).toEqual([
      { key: "perps:SOL", symbol: "SOL", venue: "perps", name: "ReneSola Ltd" },
    ]);
  });

  test("groups by venue while preserving search ranking inside each group", () => {
    const groups = groupMarketSuggestions([AAPL, KPEPE, SOL_BOTH], true);

    expect(groups.stocks.map((row) => row.symbol)).toEqual(["AAPL", "SOL"]);
    expect(groups.perps.map((row) => row.symbol)).toEqual(["kPEPE", "SOL"]);
  });

  test("keeps Hyperliquid canonical casing on the perp row", () => {
    const groups = groupMarketSuggestions([KPEPE], true);
    expect(groups.perps[0]?.symbol).toBe("kPEPE");
  });

  test("drops every perp row when perps are disabled", () => {
    const groups = groupMarketSuggestions([AAPL, KPEPE, SOL_BOTH], false);

    expect(groups.perps).toEqual([]);
    expect(groups.stocks.map((row) => row.symbol)).toEqual(["AAPL", "SOL"]);
  });

  test("ignores blank symbols and de-duplicates repeated rows", () => {
    const groups = groupMarketSuggestions(
      [{ symbol: "   ", name: "", venues: ["stocks"] }, AAPL, AAPL],
      true,
    );

    expect(groups.stocks).toHaveLength(1);
    expect(groups.stocks[0]?.symbol).toBe("AAPL");
  });
});

describe("browseQuoteSymbols", () => {
  test("takes only stock rows, uppercased and de-duplicated", () => {
    const rows: MarketBrowseRow[] = [
      stockRow("aapl"),
      { key: "perps:BTC", symbol: "BTC", venue: "perps", name: "" },
      stockRow("AAPL"),
      stockRow("SPY"),
    ];

    expect(browseQuoteSymbols(rows)).toEqual(["AAPL", "SPY"]);
  });

  test("never exceeds the router's batch cap", () => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      stockRow(`S${index}`),
    );

    expect(browseQuoteSymbols(rows)).toHaveLength(MAX_QUOTE_SYMBOLS);
  });

  test("drops symbols longer than the router's per-symbol cap", () => {
    const overLong = "A".repeat(MAX_QUOTE_SYMBOL_LENGTH + 1);

    expect(browseQuoteSymbols([stockRow(overLong), stockRow("SPY")])).toEqual([
      "SPY",
    ]);
  });

  test("asks for fewer search rows than the quote batch can price", () => {
    expect(MOBILE_BROWSE_SEARCH_LIMIT).toBeLessThanOrEqual(MAX_QUOTE_SYMBOLS);
  });
});

describe("shouldCommitOnClick", () => {
  const key = marketSelectionKey({ symbol: "AAPL", venue: "stocks" });

  test("commits a keyboard activation that had no pointer commit", () => {
    expect(shouldCommitOnClick(null, key, 1_000)).toBe(true);
  });

  test("suppresses the click that follows its own mousedown commit", () => {
    expect(shouldCommitOnClick({ key, at: 1_000 }, key, 1_010)).toBe(false);
  });

  test("still commits a different selection", () => {
    const perpKey = marketSelectionKey({ symbol: "AAPL", venue: "perps" });
    expect(shouldCommitOnClick({ key, at: 1_000 }, perpKey, 1_010)).toBe(true);
  });

  test("commits again once the interaction window has passed", () => {
    expect(
      shouldCommitOnClick(
        { key, at: 1_000 },
        key,
        1_000 + POINTER_COMMIT_WINDOW_MS + 1,
      ),
    ).toBe(true);
  });

  test("prefers committing twice over never committing on a clock oddity", () => {
    expect(shouldCommitOnClick({ key, at: 5_000 }, key, 1_000)).toBe(true);
    expect(shouldCommitOnClick({ key, at: Number.NaN }, key, 1_000)).toBe(true);
  });
});

describe("browseQueryNeeds: nothing polls for an off-screen surface", () => {
  const base = {
    isSignedIn: true,
    perpsCompiledIn: true,
    showPeople: false,
    showsPerpRows: true,
    hasQuery: false,
  };

  test("the People tab needs neither market query", () => {
    // The bug this exists for. The browse component stays MOUNTED while People
    // is selected, so a user reading the caller list kept polling Hyperliquid
    // every 30s for perp rows that were not rendered at all.
    expect(browseQueryNeeds({ ...base, showPeople: true })).toEqual({
      perpStats: false,
      marketPulse: false,
    });
  });

  test("a signed-out reader polls nothing", () => {
    expect(browseQueryNeeds({ ...base, isSignedIn: false })).toEqual({
      perpStats: false,
      marketPulse: false,
    });
  });

  test("typing drops the rankings but keeps perp prices for the result rows", () => {
    expect(browseQueryNeeds({ ...base, hasQuery: true })).toEqual({
      perpStats: true,
      marketPulse: false,
    });
  });

  test("the empty-query browse state wants both", () => {
    expect(browseQueryNeeds(base)).toEqual({ perpStats: true, marketPulse: true });
  });

  test("perp stats follow the build flag", () => {
    expect(browseQueryNeeds({ ...base, perpsCompiledIn: false })).toEqual({
      perpStats: false,
      marketPulse: true,
    });
  });
});

describe("perp stats follow the ACTIVE FILTER, not just the People tab", () => {
  const base = {
    isSignedIn: true,
    perpsCompiledIn: true,
    showPeople: false,
    showsPerpRows: true,
    hasQuery: false,
  };

  test("the Stocks tab does not poll Hyperliquid market stats", () => {
    // `showPeople` alone was not enough: the Stocks tab renders no perp rows
    // either, yet kept polling every 30s for as long as the user browsed there.
    expect(browseQueryNeeds({ ...base, showsPerpRows: false })).toEqual({
      perpStats: false,
      marketPulse: true,
    });
  });

  test("a tab that DOES show perp rows still polls", () => {
    expect(browseQueryNeeds(base).perpStats).toBe(true);
  });

  test("market rankings are unaffected by the perp filter", () => {
    // Rankings back the empty-query browse state for every market tab.
    expect(browseQueryNeeds({ ...base, showsPerpRows: false }).marketPulse).toBe(
      true,
    );
  });
});
