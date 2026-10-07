import { describe, expect, test } from "bun:test";

import {
  buildPerpUniverseIndex,
  resolveVenueRoute,
  routeSymbolVenue,
  type PerpUniverseEntry,
} from "@/lib/venue-routing";

describe("routeSymbolVenue", () => {
  test("crypto/perp-only routes to perps when perps are enabled", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: false, onHlUniverse: true },
        perpsEnabled: true,
        currentVenue: "stocks",
      }),
    ).toBe("perps");
  });

  test("equity-only routes to stocks", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: true, onHlUniverse: false },
        perpsEnabled: true,
        currentVenue: "stocks",
      }),
    ).toBe("stocks");
  });

  test("both venues stay on stocks by default (never hijack a normal equity)", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: true, onHlUniverse: true },
        perpsEnabled: true,
        currentVenue: "stocks",
      }),
    ).toBe("stocks");
  });

  test("both venues keep perps when the user is already on perps", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: true, onHlUniverse: true },
        perpsEnabled: true,
        currentVenue: "perps",
      }),
    ).toBe("perps");
  });

  test("both venues fall back to stocks on the perps venue when perps are disabled", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: true, onHlUniverse: true },
        perpsEnabled: false,
        currentVenue: "perps",
      }),
    ).toBe("stocks");
  });

  test("unknown symbol (neither venue) routes to none", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: false, onHlUniverse: false },
        perpsEnabled: true,
        currentVenue: "stocks",
      }),
    ).toBe("none");
  });

  test("perps-disabled crypto routes to none (surface a not-a-stock notice)", () => {
    expect(
      routeSymbolVenue({
        membership: { onEquityCatalog: false, onHlUniverse: true },
        perpsEnabled: false,
        currentVenue: "stocks",
      }),
    ).toBe("none");
  });
});

const UNIVERSE: PerpUniverseEntry[] = [
  { coin: "HYPE", alsoEquity: false },
  { coin: "BTC", alsoEquity: false },
  { coin: "kPEPE", alsoEquity: false },
  // A ticker that lists on BOTH venues (shares its spelling with an equity).
  { coin: "MSTR", alsoEquity: true },
];

describe("buildPerpUniverseIndex", () => {
  test("keys by uppercased coin and keeps the canonical spelling", () => {
    const index = buildPerpUniverseIndex(UNIVERSE);
    expect(index.get("KPEPE")?.coin).toBe("kPEPE");
    expect(index.get("HYPE")?.alsoEquity).toBe(false);
    expect(index.get("MSTR")?.alsoEquity).toBe(true);
  });
});

describe("resolveVenueRoute", () => {
  const index = buildPerpUniverseIndex(UNIVERSE);

  test("crypto-only symbol routes to perps with canonical casing", () => {
    const result = resolveVenueRoute({
      symbol: "kpepe",
      index,
      perpsEnabled: true,
      currentVenue: "stocks",
      assumeEquityWhenUnknown: true,
    });
    expect(result.target).toBe("perps");
    expect(result.canonicalPerpSymbol).toBe("kPEPE");
  });

  test("both-venue symbol stays on stocks and carries no perp coin", () => {
    const result = resolveVenueRoute({
      symbol: "MSTR",
      index,
      perpsEnabled: true,
      currentVenue: "stocks",
      assumeEquityWhenUnknown: true,
    });
    expect(result.target).toBe("stocks");
    expect(result.canonicalPerpSymbol).toBeNull();
  });

  test("unknown symbol on an equity surface stays on stocks (assume equity)", () => {
    const result = resolveVenueRoute({
      symbol: "AAPL",
      index,
      perpsEnabled: true,
      currentVenue: "stocks",
      assumeEquityWhenUnknown: true,
    });
    expect(result.target).toBe("stocks");
    expect(result.canonicalPerpSymbol).toBeNull();
  });

  test("unknown symbol routes to none when equity can't be assumed", () => {
    const result = resolveVenueRoute({
      symbol: "ZZZZ",
      index,
      perpsEnabled: true,
      currentVenue: "stocks",
      assumeEquityWhenUnknown: false,
    });
    expect(result.target).toBe("none");
  });

  test("crypto-only symbol routes to none when perps are disabled", () => {
    const result = resolveVenueRoute({
      symbol: "HYPE",
      index,
      perpsEnabled: false,
      currentVenue: "stocks",
      assumeEquityWhenUnknown: true,
    });
    expect(result.target).toBe("none");
    expect(result.canonicalPerpSymbol).toBeNull();
  });

  test("blank symbol routes to none", () => {
    const result = resolveVenueRoute({
      symbol: "   ",
      index,
      perpsEnabled: true,
      currentVenue: "stocks",
      assumeEquityWhenUnknown: true,
    });
    expect(result.target).toBe("none");
  });
});
