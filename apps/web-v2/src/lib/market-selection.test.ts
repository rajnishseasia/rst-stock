import { describe, expect, test } from "bun:test";
import {
  activeMarketSymbol,
  applyMarketSelection,
  marketSelectionTarget,
  normalizeMarketSymbol,
  resolveEnterSelection,
  resolveSubmitSelection,
  searchVenuesFilter,
  visibleMarketSuggestions,
  wrongVenueNotice,
  type MarketSearchItem,
  type MarketSelectionState,
} from "@/lib/market-selection";

const START: MarketSelectionState = {
  activeSymbol: "SPY",
  activeCoin: "BTC",
  venue: "stocks",
};

describe("normalizeMarketSymbol", () => {
  test("stocks trim and uppercase (tickers are case-insensitive)", () => {
    expect(normalizeMarketSymbol("stocks", " aapl ")).toBe("AAPL");
  });

  test("perps trim but preserve HL canonical casing", () => {
    expect(normalizeMarketSymbol("perps", " kPEPE ")).toBe("kPEPE");
    expect(normalizeMarketSymbol("perps", "kBONK")).toBe("kBONK");
    expect(normalizeMarketSymbol("perps", "xyz:GOOGL")).toBe("xyz:GOOGL");
    expect(normalizeMarketSymbol("perps", "BTC")).toBe("BTC");
  });
});

describe("marketSelectionTarget", () => {
  test("routes a stock pick to activeSymbol", () => {
    expect(marketSelectionTarget({ symbol: "aapl", venue: "stocks" })).toEqual({
      venue: "stocks",
      symbol: "AAPL",
      field: "activeSymbol",
    });
  });

  test("routes a perp pick to activeCoin", () => {
    expect(marketSelectionTarget({ symbol: " ETH ", venue: "perps" })).toEqual({
      venue: "perps",
      symbol: "ETH",
      field: "activeCoin",
    });
  });

  test("preserves HL canonical coin casing for a perp pick (kPEPE)", () => {
    // HL coins are case-sensitive canonical spellings; uppercasing to "KPEPE"
    // breaks chart candles and order submission downstream.
    expect(marketSelectionTarget({ symbol: "kPEPE", venue: "perps" })).toEqual({
      venue: "perps",
      symbol: "kPEPE",
      field: "activeCoin",
    });
  });
});

describe("applyMarketSelection", () => {
  test("a stock pick sets activeSymbol + flips venue, leaving activeCoin", () => {
    const next = applyMarketSelection(START, { symbol: "aapl", venue: "stocks" });
    expect(next).toEqual({ activeSymbol: "AAPL", activeCoin: "BTC", venue: "stocks" });
  });

  test("a perp pick sets activeCoin + flips venue, leaving activeSymbol", () => {
    const next = applyMarketSelection(START, { symbol: "SOL", venue: "perps" });
    expect(next).toEqual({ activeSymbol: "SPY", activeCoin: "SOL", venue: "perps" });
  });

  test("a perp pick keeps canonical casing in activeCoin (kPEPE)", () => {
    const next = applyMarketSelection(START, { symbol: "kPEPE", venue: "perps" });
    expect(next).toEqual({ activeSymbol: "SPY", activeCoin: "kPEPE", venue: "perps" });
  });

  test("switching venues back and forth preserves each slot", () => {
    const toPerp = applyMarketSelection(START, { symbol: "ETH", venue: "perps" });
    const backToStock = applyMarketSelection(toPerp, { symbol: "TSLA", venue: "stocks" });
    expect(backToStock).toEqual({
      activeSymbol: "TSLA",
      activeCoin: "ETH",
      venue: "stocks",
    });
  });
});

describe("activeMarketSymbol", () => {
  test("stocks venue reads the stock slot", () => {
    expect(
      activeMarketSymbol({ activeSymbol: "SPY", activeCoin: "kPEPE", venue: "stocks" }),
    ).toBe("SPY");
  });

  test("perps venue reads the coin slot with canonical casing intact", () => {
    expect(
      activeMarketSymbol({ activeSymbol: "SPY", activeCoin: "kPEPE", venue: "perps" }),
    ).toBe("kPEPE");
  });

  test("a perp pick then routes the venue-active symbol to the coin", () => {
    const next = applyMarketSelection(START, { symbol: "kBONK", venue: "perps" });
    expect(activeMarketSymbol(next)).toBe("kBONK");
  });
});

describe("resolveEnterSelection", () => {
  test("a unique venue is selected", () => {
    expect(resolveEnterSelection(["stocks"])).toEqual({ kind: "select", venue: "stocks" });
    expect(resolveEnterSelection(["perps"])).toEqual({ kind: "select", venue: "perps" });
  });

  test("both venues with no filter is ambiguous (never guesses)", () => {
    expect(resolveEnterSelection(["stocks", "perps"])).toEqual({
      kind: "ambiguous",
      venues: ["stocks", "perps"],
    });
  });

  test("a concrete filter disambiguates a both-venue symbol", () => {
    expect(resolveEnterSelection(["stocks", "perps"], "perps")).toEqual({
      kind: "select",
      venue: "perps",
    });
    expect(resolveEnterSelection(["stocks", "perps"], "stocks")).toEqual({
      kind: "select",
      venue: "stocks",
    });
  });

  test("no venues resolves to none", () => {
    expect(resolveEnterSelection([])).toEqual({ kind: "none" });
  });
});

describe("resolveSubmitSelection", () => {
  const suggestions: MarketSearchItem[] = [
    { symbol: "kPEPE", name: "kPEPE Perp", venues: ["perps"] },
    { symbol: "AAPL", name: "Apple", venues: ["stocks"] },
    { symbol: "TSLA", name: "Tesla", venues: ["stocks", "perps"] },
  ];

  test("perp-only text selects the perps venue with HL canonical casing", () => {
    // Search inputs uppercase as the user types, so the typed text arrives as
    // "KPEPE"; the selection must carry the canonical "kPEPE" spelling.
    expect(resolveSubmitSelection("KPEPE", suggestions)).toEqual({
      kind: "select",
      selection: { symbol: "kPEPE", venue: "perps" },
    });
  });

  test("plain equity text selects the stocks venue", () => {
    expect(resolveSubmitSelection("AAPL", suggestions)).toEqual({
      kind: "select",
      selection: { symbol: "AAPL", venue: "stocks" },
    });
    expect(resolveSubmitSelection(" aapl ", suggestions)).toEqual({
      kind: "select",
      selection: { symbol: "AAPL", venue: "stocks" },
    });
  });

  test("a both-venues symbol with no filter is ambiguous (never guesses)", () => {
    expect(resolveSubmitSelection("TSLA", suggestions)).toEqual({
      kind: "ambiguous",
      venues: ["stocks", "perps"],
    });
  });

  test("a concrete filter disambiguates a both-venues symbol", () => {
    expect(resolveSubmitSelection("TSLA", suggestions, "perps")).toEqual({
      kind: "select",
      selection: { symbol: "TSLA", venue: "perps" },
    });
    expect(resolveSubmitSelection("TSLA", suggestions, "stocks")).toEqual({
      kind: "select",
      selection: { symbol: "TSLA", venue: "stocks" },
    });
  });

  test("no exact match falls back to the top suggestion, mirroring Enter", () => {
    expect(resolveSubmitSelection("kPEP", suggestions)).toEqual({
      kind: "select",
      selection: { symbol: "kPEPE", venue: "perps" },
    });
  });

  test("unknown text or empty suggestions resolve to none", () => {
    expect(resolveSubmitSelection("ZZZZ", [])).toEqual({ kind: "none" });
    expect(resolveSubmitSelection("", suggestions)).toEqual({ kind: "none" });
    expect(resolveSubmitSelection("   ", suggestions)).toEqual({ kind: "none" });
  });
});

describe("searchVenuesFilter", () => {
  test("perps disabled hard-scopes the query to stocks for every filter", () => {
    expect(searchVenuesFilter("all", false)).toEqual(["stocks"]);
    expect(searchVenuesFilter("stocks", false)).toEqual(["stocks"]);
    // Even an explicit perps filter can't broaden the query when perps are off.
    expect(searchVenuesFilter("perps", false)).toEqual(["stocks"]);
  });

  test("perps enabled keeps the existing filter behavior", () => {
    // "all" sends no venue filter (search every venue).
    expect(searchVenuesFilter("all", true)).toBeUndefined();
    expect(searchVenuesFilter("stocks", true)).toEqual(["stocks"]);
    expect(searchVenuesFilter("perps", true)).toEqual(["perps"]);
  });
});

describe("visibleMarketSuggestions", () => {
  const rows: MarketSearchItem[] = [
    { symbol: "AAPL", name: "Apple", venues: ["stocks"] },
    { symbol: "BTC", name: "Bitcoin", venues: ["perps"] },
    { symbol: "TSLA", name: "Tesla", venues: ["stocks", "perps"] },
  ];

  test("perps disabled drops perp-only rows and collapses both-venue rows", () => {
    expect(visibleMarketSuggestions(rows, false)).toEqual([
      { symbol: "AAPL", name: "Apple", venues: ["stocks"] },
      { symbol: "TSLA", name: "Tesla", venues: ["stocks"] },
    ]);
  });

  test("perps disabled makes a perp selection impossible via Enter resolution", () => {
    const visible = visibleMarketSuggestions(rows, false);
    // No surviving row resolves to a perp venue, so a bare-symbol Enter can
    // never land on perps once perps are disabled.
    for (const row of visible) {
      const resolution = resolveEnterSelection(row.venues, "all");
      expect(resolution).not.toEqual({ kind: "select", venue: "perps" });
    }
    // The former both-venue row now resolves straight to stocks (unambiguous).
    const tsla = visible.find((row) => row.symbol === "TSLA");
    expect(tsla).toBeDefined();
    expect(resolveEnterSelection(tsla!.venues, "all")).toEqual({
      kind: "select",
      venue: "stocks",
    });
  });

  test("perps enabled leaves every row untouched", () => {
    expect(visibleMarketSuggestions(rows, true)).toEqual(rows);
  });
});

describe("wrongVenueNotice", () => {
  test("warns when picking a stock with no Alpaca account", () => {
    const note = wrongVenueNotice("stocks", { stocks: false, perps: true });
    expect(note).toContain("Alpaca");
  });

  test("warns when picking a perp with perps not enabled", () => {
    const note = wrongVenueNotice("perps", { stocks: true, perps: false });
    expect(note).toContain("Perps");
  });

  test("no note when the venue is available", () => {
    expect(wrongVenueNotice("stocks", { stocks: true, perps: false })).toBeNull();
    expect(wrongVenueNotice("perps", { stocks: false, perps: true })).toBeNull();
  });
});

describe("wrongVenueNotice: unknown availability says nothing", () => {
  test("an unresolved perps status does not tell the user to enable perps", () => {
    // `perpsEnabled` is false while hyperliquid.status loads and after it
    // fails, so a user who HAD enabled perps was instructed to go enable them,
    // on every perp row, and permanently through an outage.
    expect(wrongVenueNotice("perps", { stocks: true, perps: null })).toBeNull();
  });

  test("an unresolved broker state does not tell the user to connect one", () => {
    expect(wrongVenueNotice("stocks", { stocks: null, perps: true })).toBeNull();
  });

  test("a CONFIRMED unavailable venue still gets its notice", () => {
    // The notice has to survive: this is the case it exists for.
    expect(wrongVenueNotice("perps", { stocks: true, perps: false })).toContain(
      "Enable Perps",
    );
    expect(wrongVenueNotice("stocks", { stocks: false, perps: true })).toContain(
      "Alpaca",
    );
  });

  test("an available venue gets no notice", () => {
    expect(wrongVenueNotice("perps", { stocks: true, perps: true })).toBeNull();
    expect(wrongVenueNotice("stocks", { stocks: true, perps: true })).toBeNull();
  });
});
