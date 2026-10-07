import { describe, expect, test } from "bun:test";

import {
  chartSignalLookupSymbols,
  collectChartSignalsForVenue,
  signalMatchesChartVenue,
} from "../lib/signal-chart-match";

describe("chartSignalLookupSymbols", () => {
  test("queries both the canonical perp coin and its stored underlying ticker", () => {
    expect(chartSignalLookupSymbols("xyz:GOOGL", "perps")).toEqual([
      "XYZ:GOOGL",
      "GOOGL",
    ]);
    expect(chartSignalLookupSymbols("BTC", "perps")).toEqual(["BTC"]);
  });
});

describe("signalMatchesChartVenue", () => {
  test("matches a perp signal by its canonical hlTicker", () => {
    expect(
      signalMatchesChartVenue(
        {
          symbol: "GOOGL",
          metadata: {
            platform: "hyperliquid",
            instrument: "perps",
            hlTicker: "xyz:GOOGL",
          },
        },
        "xyz:GOOGL",
        "perps",
      ),
    ).toBe(true);
  });

  test("does not put an equity signal on a same-name perp chart", () => {
    expect(
      signalMatchesChartVenue(
        { symbol: "GOOGL", metadata: { instrument: "stock" } },
        "xyz:GOOGL",
        "perps",
      ),
    ).toBe(false);
  });

  test("does not put a perp signal on a same-name stock chart", () => {
    expect(
      signalMatchesChartVenue(
        {
          symbol: "GOOGL",
          metadata: { instrument: "perp", hlTicker: "xyz:GOOGL" },
        },
        "GOOGL",
        "stocks",
      ),
    ).toBe(false);
  });

  test("supports legacy perp metadata without hlTicker by underlying symbol", () => {
    expect(
      signalMatchesChartVenue(
        { symbol: "BTC", metadata: { platform: "hyperliquid" } },
        "BTC",
        "perps",
      ),
    ).toBe(true);
  });

  test("does not cross one canonical perp namespace into another", () => {
    expect(
      signalMatchesChartVenue(
        {
          symbol: "GOOGL",
          metadata: { instrument: "perp", hlTicker: "xyz:GOOGL" },
        },
        "other:GOOGL",
        "perps",
      ),
    ).toBe(false);
  });
});

describe("collectChartSignalsForVenue", () => {
  test("continues paging until the requested venue limit is filled", async () => {
    const base = new Date("2026-07-27T12:00:00Z").getTime();
    const candidates = [
      ...Array.from({ length: 400 }, (_, index) => ({
        id: `stock-${String(400 - index).padStart(4, "0")}`,
        timestamp: new Date(base - index * 1_000),
        venue: "stocks" as const,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `perp-${String(5 - index).padStart(4, "0")}`,
        timestamp: new Date(base - (400 + index) * 1_000),
        venue: "perps" as const,
      })),
    ];
    let offset = 0;
    let pageCalls = 0;

    const results = await collectChartSignalsForVenue({
      limit: 5,
      pageSize: 100,
      matches: (candidate) => candidate.venue === "perps",
      fetchPage: async ({ limit }) => {
        pageCalls += 1;
        const page = candidates.slice(offset, offset + limit);
        offset += page.length;
        return page;
      },
    });

    expect(results).toHaveLength(5);
    expect(results.every((candidate) => candidate.venue === "perps")).toBe(true);
    expect(pageCalls).toBe(5);
  });

  test("stops at the hard candidate cap when no rows match", async () => {
    let scanned = 0;
    const results = await collectChartSignalsForVenue({
      limit: 5,
      pageSize: 10,
      maxCandidates: 25,
      matches: () => false,
      fetchPage: async ({ cursor, limit }) => {
        const start = scanned;
        scanned += limit;
        return Array.from({ length: limit }, (_, index) => ({
          id: `${start + index}`,
          timestamp: new Date(1_000_000 - start - index),
          cursor,
        }));
      },
    });

    expect(results).toEqual([]);
    expect(scanned).toBe(25);
  });
});
