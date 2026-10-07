import { describe, expect, it } from "bun:test";
import {
  fetchXCallerMarketData,
  normalizeAlpacaDailyBars,
  normalizeHyperliquidDailyCandles,
  X_CALLER_MARKET_DATA_CONCURRENCY,
  X_CALLER_MARKET_DATA_BUDGET_MS,
  type XCallerMarketDataSource,
} from "../lib/x-caller-market-data.js";

const refs = [
  { provider: "hyperliquid" as const, symbol: "xyz:GOOGL", key: "hyperliquid:xyz:GOOGL" },
  { provider: "hyperliquid" as const, symbol: "xyz:GOOGL", key: "hyperliquid:xyz:GOOGL" },
  { provider: "alpaca" as const, symbol: "AAPL", key: "alpaca:AAPL" },
  { provider: "alpaca" as const, symbol: "AAPL", key: "alpaca:AAPL" },
];

describe("X-caller market data", () => {
  it("coalesces duplicate provider-qualified markets and caps concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requested: string[] = [];
    const source: XCallerMarketDataSource = {
      async fetch(ref) {
        requested.push(ref.key);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return [{ time: 1, close: 100 }, { time: 2, close: 110 }];
      },
    };

    const result = await fetchXCallerMarketData(refs, 1, {
      sources: { alpaca: source, hyperliquid: source },
      maxConcurrency: 1,
    });

    expect(requested).toEqual(["hyperliquid:xyz:GOOGL", "alpaca:AAPL"]);
    expect(maxInFlight).toBe(1);
    expect(result.health).toMatchObject({
      requestedMarketCount: 2,
      availableMarketCount: 2,
      unavailableMarketCount: 0,
      complete: true,
    });
  });

  it("keeps the default venue cap even when a larger caller limit is requested", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const source: XCallerMarketDataSource = {
      async fetch() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return [{ time: 1, close: 100 }];
      },
    };
    const manyRefs = Array.from({ length: 8 }, (_, index) => ({
      provider: "hyperliquid" as const,
      symbol: `BTC${index}`,
      key: `hyperliquid:BTC${index}`,
    }));

    await fetchXCallerMarketData(manyRefs, 1, {
      sources: { hyperliquid: source },
      maxConcurrency: 100,
    });

    expect(maxInFlight).toBeLessThanOrEqual(X_CALLER_MARKET_DATA_CONCURRENCY);
  });

  it("keeps missing source data unavailable instead of falling back across venues", async () => {
    const source: XCallerMarketDataSource = {
      async fetch(ref) {
        if (ref.provider === "hyperliquid") throw new Error("venue unavailable");
        return [{ time: 1, close: 100 }, { time: 2, close: 110 }];
      },
    };

    const result = await fetchXCallerMarketData(refs.slice(0, 2), 1, {
      sources: { alpaca: source, hyperliquid: source },
    });

    expect(result.data.get("hyperliquid:xyz:GOOGL")).toMatchObject({
      status: "unavailable",
      bars: [],
      provider: "hyperliquid",
    });
    expect(result.health.complete).toBe(false);
  });

  it("drops an incomplete current-day Hyperliquid candle and requires completed observations", () => {
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const candles = normalizeHyperliquidDailyCandles([
      { t: Date.parse("2026-08-19T00:00:00.000Z"), T: Date.parse("2026-08-19T23:59:59.000Z"), c: "100" },
      { t: Date.parse("2026-08-20T00:00:00.000Z"), T: Date.parse("2026-08-20T23:59:59.000Z"), c: "110" },
      { t: Date.parse("2026-08-21T00:00:00.000Z"), T: Date.parse("2026-08-21T11:00:00.000Z"), c: "999" },
    ], now);

    expect(candles).toEqual([
      { time: Date.parse("2026-08-19T23:59:59.000Z") / 1000, close: 100 },
      { time: Date.parse("2026-08-20T23:59:59.000Z") / 1000, close: 110 },
    ]);
  });

  it("drops current and future UTC-day Alpaca bars at a deterministic as-of boundary", () => {
    const asOfMs = Date.parse("2026-08-21T12:00:00.000Z");
    expect(
      normalizeAlpacaDailyBars(
        [
          { t: "2026-08-20T23:59:59.000Z", c: "100" },
          { t: "2026-08-21T00:00:00.000Z", c: "110" },
          { t: "2026-08-22T00:00:00.000Z", c: "120" },
          { t: "2026-08-20T23:59:59.000Z", c: "not-a-price" },
        ],
        asOfMs,
      ),
    ).toEqual([
      { time: Date.parse("2026-08-20T23:59:59.000Z") / 1000, close: 100 },
    ]);
  });

  it("aborts timed-out providers and clears deadlines after an early rejection", async () => {
    let timedOutSignal: AbortSignal | undefined;
    const timedOut = await fetchXCallerMarketData(
      [{ provider: "alpaca", symbol: "AAPL", key: "alpaca:AAPL" }],
      1,
      {
        providerTimeoutMs: 5,
        sources: {
          alpaca: {
            fetch: (_ref, signal) => {
              timedOutSignal = signal;
              return new Promise<never>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              });
            },
          },
        },
      },
    );
    expect(timedOut.data.get("alpaca:AAPL")).toMatchObject({ status: "unavailable" });
    expect(timedOutSignal?.aborted).toBe(true);

    let rejectedSignal: AbortSignal | undefined;
    await fetchXCallerMarketData(
      [{ provider: "alpaca", symbol: "MSFT", key: "alpaca:MSFT" }],
      1,
      {
        providerTimeoutMs: 20,
        sources: {
          alpaca: {
            fetch: (_ref, signal) => {
              rejectedSignal = signal;
              return Promise.reject(new Error("provider rejected"));
            },
          },
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejectedSignal?.aborted).toBe(false);
  });

  it("stops assigning new markets at the aggregate deadline and marks the remainder unavailable", async () => {
    const requested: string[] = [];
    const aborted: string[] = [];
    const manyRefs = Array.from({ length: 8 }, (_, index) => ({
      provider: "alpaca" as const,
      symbol: `A${index}`,
      key: `alpaca:A${index}`,
    }));
    const startedAt = Date.now();

    const result = await fetchXCallerMarketData(manyRefs, 1, {
      maxConcurrency: 2,
      providerTimeoutMs: 1_000,
      marketDataBudgetMs: 15,
      sources: {
        alpaca: {
          fetch: (ref, signal) => {
            requested.push(ref.key);
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted.push(ref.key);
                reject(new Error("aborted"));
              }, { once: true });
            });
          },
        },
      },
    });

    expect(X_CALLER_MARKET_DATA_BUDGET_MS).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requested.length).toBeLessThanOrEqual(2);
    expect([...aborted].sort()).toEqual([...requested].sort());
    expect(result.data.size).toBe(manyRefs.length);
    expect(result.health).toMatchObject({
      requestedMarketCount: requested.length,
      availableMarketCount: 0,
      unavailableMarketCount: requested.length,
      deadlineMarketCount: requested.length,
      skippedMarketCount: manyRefs.length - requested.length,
      providerComplete: false,
      complete: false,
    });
    expect(
      manyRefs.filter((ref) => requested.includes(ref.key)).every(
        (ref) => result.data.get(ref.key)?.unavailableReason === "deadline",
      ),
    ).toBe(true);
    expect(
      manyRefs.filter((ref) => !requested.includes(ref.key)).every(
        (ref) => result.data.get(ref.key)?.unavailableReason === "skipped",
      ),
    ).toBe(true);
  });
});
