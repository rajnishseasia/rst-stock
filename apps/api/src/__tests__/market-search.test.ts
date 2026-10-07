import { describe, expect, test } from "bun:test";
import {
  mergeMarketSearchResults,
  resolveSymbolVenues,
  tagRoutablePerpUniverse,
  tagPerpUniverseWithEquityOverlap,
  type EquityCatalogEntry,
  type HlUniverseEntry,
} from "../lib/markets/market-search.js";

const EQUITIES: EquityCatalogEntry[] = [
  { symbol: "AAPL", name: "Apple Inc" },
  { symbol: "TSLA", name: "Tesla Inc" },
  { symbol: "COIN", name: "Coinbase Global Inc" },
  // Deliberately a ticker that is ALSO a perp coin, to exercise the collapse.
  { symbol: "SOL", name: "SOL Strategies" },
];

const HL_UNIVERSE: HlUniverseEntry[] = [
  { coin: "BTC" },
  { coin: "ETH" },
  { coin: "SOL" },
  { coin: "OLD", isDelisted: true },
];

describe("resolveSymbolVenues", () => {
  const sources = { equityCatalog: EQUITIES, hlUniverse: HL_UNIVERSE };

  test("stock-only symbol resolves to [stocks]", () => {
    expect(resolveSymbolVenues("AAPL", sources)).toEqual(["stocks"]);
  });

  test("perp-only symbol resolves to [perps]", () => {
    expect(resolveSymbolVenues("ETH", sources)).toEqual(["perps"]);
  });

  test("both-venue symbol resolves to [stocks, perps] in canonical order", () => {
    expect(resolveSymbolVenues("SOL", sources)).toEqual(["stocks", "perps"]);
  });

  test("unknown symbol resolves to []", () => {
    expect(resolveSymbolVenues("NOPE", sources)).toEqual([]);
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(resolveSymbolVenues("  eth  ", sources)).toEqual(["perps"]);
    expect(resolveSymbolVenues("sol", sources)).toEqual(["stocks", "perps"]);
  });

  test("a delisted HL asset does not count as a perp venue", () => {
    expect(resolveSymbolVenues("OLD", sources)).toEqual([]);
  });

  test("empty / blank input resolves to []", () => {
    expect(resolveSymbolVenues("", sources)).toEqual([]);
    expect(resolveSymbolVenues("   ", sources)).toEqual([]);
  });
});

describe("mergeMarketSearchResults", () => {
  const base = { equityCatalog: EQUITIES, hlUniverse: HL_UNIVERSE, limit: 10 };

  test("collapses a both-venue symbol into ONE item with both tags", () => {
    const results = mergeMarketSearchResults({ ...base, query: "SOL" });
    const sol = results.filter((item) => item.symbol.toUpperCase() === "SOL");
    expect(sol).toHaveLength(1);
    expect(sol[0]?.venues).toEqual(["stocks", "perps"]);
    // Equity metadata wins the shared display row.
    expect(sol[0]?.name).toBe("SOL Strategies");
  });

  test("tags a stock-only match with [stocks]", () => {
    const results = mergeMarketSearchResults({ ...base, query: "AAPL" });
    expect(results[0]?.symbol).toBe("AAPL");
    expect(results[0]?.venues).toEqual(["stocks"]);
  });

  test("tags a perp-only match with [perps]", () => {
    const results = mergeMarketSearchResults({ ...base, query: "BTC" });
    expect(results[0]?.symbol).toBe("BTC");
    expect(results[0]?.venues).toEqual(["perps"]);
  });

  test("ranks an exact symbol match ahead of a name substring match", () => {
    // "COIN" is an exact ticker; it must beat "Coinbase" name matches (none
    // here) and any prefix noise. Add a decoy that only matches by name.
    const catalog: EquityCatalogEntry[] = [
      { symbol: "ZZZZ", name: "Coin Holdings" },
      ...EQUITIES,
    ];
    const results = mergeMarketSearchResults({
      ...base,
      equityCatalog: catalog,
      query: "COIN",
    });
    expect(results[0]?.symbol).toBe("COIN");
  });

  test("venues filter restricts inclusion but keeps both chips on a shared row", () => {
    const perpsOnly = mergeMarketSearchResults({
      ...base,
      query: "SOL",
      venues: ["perps"],
    });
    // SOL is included because it lists on perps; its stock tag is retained.
    const sol = perpsOnly.find((item) => item.symbol.toUpperCase() === "SOL");
    expect(sol?.venues).toEqual(["stocks", "perps"]);

    // A stock-only symbol is excluded under a perps-only filter.
    const aapl = mergeMarketSearchResults({
      ...base,
      query: "AAPL",
      venues: ["perps"],
    });
    expect(aapl).toHaveLength(0);
  });

  test("excludes delisted perps from results", () => {
    const results = mergeMarketSearchResults({ ...base, query: "OLD" });
    expect(results).toHaveLength(0);
  });

  test("empty query returns []", () => {
    expect(mergeMarketSearchResults({ ...base, query: "" })).toEqual([]);
    expect(mergeMarketSearchResults({ ...base, query: "   " })).toEqual([]);
  });

  test("respects the result limit", () => {
    const results = mergeMarketSearchResults({ ...base, query: "S", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("tagPerpUniverseWithEquityOverlap", () => {
  test("tags a coin that is ALSO an equity so routing keeps it on stocks", () => {
    // SOL is both an HL perp and an equity (SOL Strategies). It must be tagged
    // alsoEquity so a SOL pick from an equity surface is never hijacked to perps.
    const tags = tagPerpUniverseWithEquityOverlap(HL_UNIVERSE, EQUITIES);
    expect(tags.find((t) => t.coin === "SOL")?.alsoEquity).toBe(true);
  });

  test("tags crypto-only coins as not-equity so they route to perps", () => {
    const tags = tagPerpUniverseWithEquityOverlap(HL_UNIVERSE, EQUITIES);
    expect(tags.find((t) => t.coin === "BTC")?.alsoEquity).toBe(false);
    expect(tags.find((t) => t.coin === "ETH")?.alsoEquity).toBe(false);
  });

  test("excludes delisted coins, which are not chartable", () => {
    const tags = tagPerpUniverseWithEquityOverlap(HL_UNIVERSE, EQUITIES);
    expect(tags.some((t) => t.coin === "OLD")).toBe(false);
  });

  test("matches case-insensitively and ignores surrounding whitespace", () => {
    const tags = tagPerpUniverseWithEquityOverlap(
      [{ coin: "sol" }],
      [{ symbol: " SOL ", name: "SOL Strategies" }],
    );
    expect(tags[0]?.alsoEquity).toBe(true);
  });

  test("an empty equity catalog would tag every coin as crypto-only", () => {
    // Documents exactly WHY the router must fail closed instead of calling this
    // with an empty catalog: the equity collision silently disappears, which
    // would route a real equity to perps.
    const tags = tagPerpUniverseWithEquityOverlap(HL_UNIVERSE, []);
    expect(tags.every((t) => t.alsoEquity === false)).toBe(true);
    expect(tags.find((t) => t.coin === "SOL")?.alsoEquity).toBe(false);
  });
});

describe("tagRoutablePerpUniverse", () => {
  test("keeps full collision-aware routing when the equity catalog is available", () => {
    const tags = tagRoutablePerpUniverse(HL_UNIVERSE, EQUITIES);

    expect(tags.find((tag) => tag.coin === "BTC")?.alsoEquity).toBe(false);
    expect(tags.find((tag) => tag.coin === "SOL")?.alsoEquity).toBe(true);
  });

  test("keeps explicit HIP-3 coins routable when the equity catalog is unavailable", () => {
    const tags = tagRoutablePerpUniverse(
      [
        { coin: "BTC" },
        { coin: "SOL" },
        { coin: "xyz:NVDA" },
        { coin: "xyz:OLD", isDelisted: true },
      ],
      [],
    );

    expect(tags).toEqual([{ coin: "xyz:NVDA", alsoEquity: false }]);
  });
});
