import { describe, expect, test } from "bun:test";
import type { MarketPulseOverview, MarketTile } from "./market-pulse-types";
import {
  getExternalSourceUrl,
  getHeatmapSpan,
  getPulseFreshness,
  getVenueRankings,
} from "./market-pulse-utils";

function tile(symbol: string, volume: number, weight: number): MarketTile {
  return {
    id: `perps:${symbol}`,
    venue: "perps",
    symbol,
    price: 100,
    changePercent: 1,
    volume,
    weight,
    trendScore: 50,
    group: "Advancers",
    maxLeverage: 10,
  };
}

describe("getHeatmapSpan", () => {
  test("assigns deterministic spans from activity weight", () => {
    expect(getHeatmapSpan(0.8)).toEqual({ size: "large", columns: 6, rows: 2 });
    expect(getHeatmapSpan(0.5)).toEqual({ size: "medium", columns: 3, rows: 2 });
    expect(getHeatmapSpan(0.2)).toEqual({ size: "small", columns: 3, rows: 1 });
  });

  test("clamps invalid weights to the smallest tile", () => {
    expect(getHeatmapSpan(Number.NaN)).toEqual({ size: "small", columns: 3, rows: 1 });
    expect(getHeatmapSpan(-1)).toEqual({ size: "small", columns: 3, rows: 1 });
  });
});

describe("getVenueRankings", () => {
  test("derives most active perps from heatmap volume without mutating it", () => {
    const lower = tile("ETH", 50, 0.5);
    const higher = tile("BTC", 100, 1);
    const heatmap = [lower, higher];
    const overview = {
      perps: {
        trending: [lower],
        gainers: [higher],
        losers: [],
        heatmap,
      },
    } as unknown as MarketPulseOverview;

    expect(getVenueRankings(overview, "perps").mostActive).toEqual([higher, lower]);
    expect(heatmap).toEqual([lower, higher]);
  });

  test("uses the server-provided stock activity ranking", () => {
    const active = { ...tile("NVDA", 300, 1), id: "stocks:NVDA", venue: "stocks" as const };
    const overview = {
      stocks: {
        trending: [],
        gainers: [],
        losers: [],
        mostActive: [active],
        heatmap: [],
      },
    } as unknown as MarketPulseOverview;

    expect(getVenueRankings(overview, "stocks").mostActive).toEqual([active]);
  });
});

describe("getPulseFreshness", () => {
  test("marks data stale at and after staleAfter", () => {
    const meta = { staleAfter: "2026-07-29T14:02:00.000Z" };

    expect(getPulseFreshness(meta, new Date("2026-07-29T14:01:59.999Z"))).toBe("fresh");
    expect(getPulseFreshness(meta, new Date("2026-07-29T14:02:00.000Z"))).toBe("stale");
  });

  test("treats an invalid staleAfter value as stale", () => {
    expect(getPulseFreshness({ staleAfter: "invalid" }, new Date())).toBe("stale");
  });
});

describe("getExternalSourceUrl", () => {
  test("allows only http and https citation links", () => {
    expect(getExternalSourceUrl("https://example.com/story")).toBe("https://example.com/story");
    expect(getExternalSourceUrl("http://example.com/story")).toBe("http://example.com/story");
    expect(getExternalSourceUrl("javascript:alert(1)")).toBeNull();
    expect(getExternalSourceUrl("not a url")).toBeNull();
  });
});
