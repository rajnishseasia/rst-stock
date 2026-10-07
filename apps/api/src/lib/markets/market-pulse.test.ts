import { describe, expect, it } from "bun:test";
import {
  buildMarketPulse,
  cachedOrLive,
  fetchAlpacaPulseSource,
  isMarketPulseOverview,
  type MarketPulseSources,
} from "./market-pulse.js";
import type { AlpacaClient } from "@trade-bot/alpaca";

function sources(overrides: Partial<MarketPulseSources> = {}): MarketPulseSources {
  return {
    stocks: async () => ({
      movers: {
        gainers: [
          { symbol: "NVDA", price: 140, change: 8, percentChange: 6.1 },
          { symbol: "AAPL", price: 210, change: 3, percentChange: 1.45 },
        ],
        losers: [{ symbol: "TSLA", price: 280, change: -14, percentChange: -4.76 }],
      },
      mostActive: [
        { symbol: "AAPL", volume: 52_000_000, tradeCount: 480_000 },
        { symbol: "TSLA", volume: 41_000_000, tradeCount: 390_000 },
      ],
      snapshots: {
        NVDA: { price: 140, previousClose: 131.95, volume: 31_000_000 },
        AAPL: { price: 210, previousClose: 207, volume: 52_000_000 },
        TSLA: { price: 280, previousClose: 294, volume: 41_000_000 },
      },
      news: [
        {
          id: "news-1",
          headline: "Chip demand lifts semiconductor outlook",
          summary: "A sourced market update.",
          source: "Reuters",
          url: "https://example.com/news-1",
          createdAt: "2026-07-29T12:00:00.000Z",
          symbols: ["NVDA"],
        },
      ],
    }),
    perps: async () => [
      { coin: "BTC", maxLeverage: 40, markPx: "68000", prevDayPx: "66000", dayNtlVlm: "2200000000" },
      { coin: "ETH", maxLeverage: 25, markPx: "3600", prevDayPx: "3700", dayNtlVlm: "1400000000" },
      { coin: "BAD", maxLeverage: 5, markPx: null, prevDayPx: "1", dayNtlVlm: "500" },
    ],
    ...overrides,
  };
}

describe("buildMarketPulse", () => {
  it("deduplicates stocks, ranks activity, and preserves sourced news URLs", async () => {
    const result = await buildMarketPulse(sources(), new Date("2026-07-29T12:01:00.000Z"));

    expect(result.meta.status).toBe("ok");
    expect(result.stocks.heatmap.map((item) => item.symbol)).toEqual(["AAPL", "TSLA", "NVDA"]);
    expect(new Set(result.stocks.trending.map((item) => item.symbol)).size).toBe(
      result.stocks.trending.length,
    );
    expect(result.brief.sources[0]).toMatchObject({
      title: "Chip demand lifts semiconductor outlook",
      url: "https://example.com/news-1",
      provider: "Reuters",
    });
    expect(result.brief.summary).toContain("NVDA");
  });

  it("normalizes perp stats and drops rows without a valid mark price", async () => {
    const result = await buildMarketPulse(sources());

    expect(result.perps.heatmap.map((item) => item.symbol)).toEqual(["BTC", "ETH"]);
    expect(result.perps.heatmap[0]).toMatchObject({
      venue: "perps",
      changePercent: expect.closeTo(3.0303, 3),
      volume: 2_200_000_000,
    });
  });

  it("returns partial data and a warning when one venue is unavailable", async () => {
    const result = await buildMarketPulse(
      sources({
        stocks: async () => {
          throw new Error("Alpaca rate limited");
        },
      }),
    );

    expect(result.meta.status).toBe("partial");
    expect(result.stocks.heatmap).toEqual([]);
    expect(result.perps.heatmap.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("Stocks");
  });

  it("marks a successful but incomplete perp snapshot as partial", async () => {
    const result = await buildMarketPulse(sources({
      perps: async () => ({
        markets: [
          { coin: "BTC", maxLeverage: 40, markPx: "68000", prevDayPx: "66000", dayNtlVlm: "2200000000" },
        ],
        warnings: ["Some Hyperliquid market partitions are temporarily unavailable: xyz."],
      }),
    }));

    expect(result.meta.status).toBe("partial");
    expect(result.perps.heatmap.map((item) => item.symbol)).toEqual(["BTC"]);
    expect(result.warnings.join(" ")).toContain("xyz");
  });

  it("marks successful stock rows with incomplete screener coverage as partial", async () => {
    const result = await buildMarketPulse(sources({
      stocks: async () => ({
        movers: {
          gainers: [{ symbol: "AAPL", price: 210, change: 2, percentChange: 1 }],
          losers: [],
        },
        mostActive: [],
        snapshots: {},
        news: [],
        warnings: ["Alpaca most-active stocks are temporarily unavailable."],
      }),
    }));

    expect(result.meta.status).toBe("partial");
    expect(result.stocks.heatmap.map((item) => item.symbol)).toEqual(["AAPL"]);
    expect(result.warnings.join(" ")).toContain("most-active");
  });

  it("uses the most-active screener volume when snapshot volume disagrees", async () => {
    const result = await buildMarketPulse(sources({
      stocks: async () => ({
        movers: {
          gainers: [
            { symbol: "AAPL", price: 210, change: 2, percentChange: 1 },
            { symbol: "NVDA", price: 140, change: 2, percentChange: 1.5 },
          ],
          losers: [],
        },
        mostActive: [
          { symbol: "AAPL", volume: 100, tradeCount: 10 },
          { symbol: "NVDA", volume: 1_000, tradeCount: 20 },
        ],
        snapshots: {
          AAPL: { price: 210, previousClose: 208, volume: 5_000 },
          NVDA: { price: 140, previousClose: 138, volume: 50 },
        },
        news: [],
      }),
    }));

    expect(result.stocks.mostActive.map((item) => item.symbol)).toEqual(["NVDA", "AAPL"]);
  });
});

describe("fetchAlpacaPulseSource", () => {
  it("keeps mover data when optional news and snapshots are unavailable", async () => {
    const client = {
      getStockMovers: async () => ({
        gainers: [{ symbol: "AAPL", price: 210, change: 2, percent_change: 0.96 }],
        losers: [],
      }),
      getMostActiveStocks: async () => ({ most_actives: [] }),
      getMarketNews: async () => { throw new Error("news rate limited"); },
      getStockSnapshots: async () => { throw new Error("snapshots unavailable"); },
    } as unknown as AlpacaClient;

    const source = await fetchAlpacaPulseSource(client);

    expect(source.movers.gainers[0]).toMatchObject({ symbol: "AAPL", price: 210 });
    expect(source.snapshots).toEqual({});
    expect(source.news).toEqual([]);
    expect(source.warnings).toEqual([
      "Alpaca market news is temporarily unavailable.",
      "Alpaca stock snapshots are temporarily unavailable.",
    ]);
  });

  it("preserves healthy screener rows and reports the failed screener", async () => {
    const client = {
      getStockMovers: async () => {
        throw new Error("movers unavailable");
      },
      getMostActiveStocks: async () => ({
        most_actives: [{ symbol: "AAPL", volume: 1_000, trade_count: 100 }],
      }),
      getMarketNews: async () => ({ news: [] }),
      getStockSnapshots: async () => ({
        snapshots: {
          AAPL: {
            latestTrade: { p: 210 },
            prevDailyBar: { c: 208 },
            dailyBar: { v: 1_000 },
          },
        },
      }),
    } as unknown as AlpacaClient;

    const source = await fetchAlpacaPulseSource(client);

    expect(source.mostActive).toEqual([{ symbol: "AAPL", volume: 1_000, tradeCount: 100 }]);
    expect(source.warnings).toEqual(["Alpaca movers are temporarily unavailable."]);
  });
});

describe("cachedOrLive", () => {
  it("serves live data when Redis initialization fails", async () => {
    const result = await cachedOrLive(
      "overview",
      60,
      async () => "fresh",
      async () => {
        throw new Error("redis unavailable");
      },
    );

    expect(result).toEqual({ data: "fresh", cacheState: "bypass" });
  });

  it("reports bypass when an initialized Redis client cannot read", async () => {
    let writes = 0;
    const result = await cachedOrLive(
      "read-failure",
      60,
      async () => "fresh",
      async () => ({
        get: async () => null,
        getWithStatus: async () => ({ ok: false, value: null }),
        set: async () => {
          writes += 1;
          return true;
        },
      }),
    );

    expect(result).toEqual({ data: "fresh", cacheState: "bypass" });
    expect(writes).toBe(0);
  });

  it("reports bypass when Redis rejects the cache write", async () => {
    const result = await cachedOrLive(
      "write-failure",
      60,
      async () => "fresh",
      async () => ({
        get: async () => null,
        set: async () => false,
      }),
    );

    expect(result).toEqual({ data: "fresh", cacheState: "bypass" });
  });

  it("returns a valid cached value without recomputing", async () => {
    let computed = false;
    const result = await cachedOrLive(
      "overview",
      60,
      async () => {
        computed = true;
        return "fresh";
      },
      async () => ({
        get: async () => JSON.stringify("cached"),
        set: async () => undefined,
      }),
    );

    expect(result).toEqual({ data: "cached", cacheState: "hit" });
    expect(computed).toBe(false);
  });

  it("recomputes a structurally invalid cached overview", async () => {
    const fresh = await buildMarketPulse(sources());
    let computed = false;
    const result = await cachedOrLive(
      "invalid-overview",
      60,
      async () => {
        computed = true;
        return fresh;
      },
      async () => ({
        get: async () => "null",
        set: async () => undefined,
      }),
      isMarketPulseOverview,
    );

    expect(result.cacheState).toBe("miss");
    expect(result.data.meta.status).toBe("ok");
    expect(computed).toBe(true);
  });

  it("coalesces concurrent cache misses into one upstream computation", async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compute = async () => {
      computes += 1;
      await gate;
      return "fresh";
    };
    const client = {
      get: async () => null,
      set: async () => undefined,
    };

    const first = cachedOrLive("singleflight", 60, compute, async () => client);
    const second = cachedOrLive("singleflight", 60, compute, async () => client);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(computes).toBe(1);
    release();

    expect(await Promise.all([first, second])).toEqual([
      { data: "fresh", cacheState: "miss" },
      { data: "fresh", cacheState: "miss" },
    ]);
  });
});
