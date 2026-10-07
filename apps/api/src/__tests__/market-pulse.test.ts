import { beforeEach, describe, expect, it, vi } from "bun:test";

const getRedisClient = vi.fn();
const createMasterAlpacaClient = vi.fn();
const createHyperliquidInfoClient = vi.fn();

vi.mock("@trade-bot/redis", () => ({ getRedisClient }));
vi.mock("../lib/alpaca.js", () => ({ createMasterAlpacaClient }));
vi.mock("../lib/hyperliquid.js", () => ({ createHyperliquidInfoClient }));

const { marketPulseRouter } = await import("../routers/market-pulse.js");

function caller() {
  return marketPulseRouter.createCaller({
    db: {} as any,
    session: { userId: "user-1" },
    userId: "user-1",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
  });
}

describe("marketPulseRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    });
    createMasterAlpacaClient.mockReturnValue({
      getStockMovers: vi.fn().mockResolvedValue({ gainers: [], losers: [] }),
      getMostActiveStocks: vi.fn().mockResolvedValue({ most_actives: [] }),
      getStockSnapshots: vi.fn().mockResolvedValue({ snapshots: {} }),
      getMarketNews: vi.fn().mockResolvedValue({ news: [] }),
    });
    createHyperliquidInfoClient.mockReturnValue({
      getUniverseStatsWithStatus: vi.fn().mockResolvedValue({
        stats: [],
        unavailableDexes: [],
      }),
    });
  });

  it("returns the shared market overview and records a cache miss", async () => {
    const result = await caller().overview();

    expect(result.meta.status).toBe("ok");
    expect(result.meta.cacheState).toBe("miss");
    expect(createMasterAlpacaClient).toHaveBeenCalledTimes(1);
    expect(createHyperliquidInfoClient).toHaveBeenCalledTimes(1);
  });

  it("still returns live data when Redis is unavailable", async () => {
    getRedisClient.mockRejectedValue(new Error("Redis offline"));

    const result = await caller().overview();

    expect(result.meta.status).toBe("ok");
    expect(result.meta.cacheState).toBe("bypass");
  });

  it("shortens the cache TTL when one provider is unavailable", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set,
    });
    createMasterAlpacaClient.mockReturnValue({
      getStockMovers: vi.fn().mockRejectedValue(new Error("Alpaca unavailable")),
      getMostActiveStocks: vi.fn().mockRejectedValue(new Error("Alpaca unavailable")),
      getStockSnapshots: vi.fn().mockResolvedValue({ snapshots: {} }),
      getMarketNews: vi.fn().mockResolvedValue({ news: [] }),
    });

    const result = await caller().overview();

    expect(result.meta.status).toBe("partial");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith(
      "market-pulse:overview:v1",
      expect.any(String),
      15,
    );
  });

  it("shortens the cache TTL when a Hyperliquid DEX partition is unavailable", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set,
    });
    createHyperliquidInfoClient.mockReturnValue({
      getUniverseStatsWithStatus: vi.fn().mockResolvedValue({
        stats: [],
        unavailableDexes: ["xyz"],
      }),
    });

    const result = await caller().overview();

    expect(result.meta.status).toBe("partial");
    expect(result.warnings.join(" ")).toContain("xyz");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith(
      "market-pulse:overview:v1",
      expect.any(String),
      15,
    );
  });
});
