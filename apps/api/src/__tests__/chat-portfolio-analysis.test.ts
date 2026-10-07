import { describe, it, expect } from "bun:test";
import {
  analyzePortfolio,
  type PortfolioOrderInput,
  type PortfolioPositionInput,
} from "../lib/chat/tools/lib/portfolio-analysis.js";

function pos(
  symbol: string,
  overrides: Partial<PortfolioPositionInput> = {}
): PortfolioPositionInput {
  const qty = overrides.qty ?? 10;
  const currentPrice = overrides.currentPrice ?? 100;
  const avgEntryPrice = overrides.avgEntryPrice ?? 90;
  const marketValue = overrides.marketValue ?? qty * currentPrice;
  const costBasis = overrides.costBasis ?? qty * avgEntryPrice;
  const unrealizedPl = overrides.unrealizedPl ?? marketValue - costBasis;
  return {
    symbol,
    side: overrides.side ?? "long",
    qty,
    avgEntryPrice,
    currentPrice,
    marketValue,
    costBasis,
    unrealizedPl,
    unrealizedPlPct: overrides.unrealizedPlPct ?? unrealizedPl / costBasis,
    changeTodayPct: overrides.changeTodayPct ?? 0.01,
    assetClass: overrides.assetClass ?? "us_equity",
  };
}

describe("analyzePortfolio", () => {
  const positions: PortfolioPositionInput[] = [
    // +$100 winner
    pos("AAPL", { qty: 10, avgEntryPrice: 90, currentPrice: 100 }),
    // -$150 loser
    pos("TSLA", { qty: 5, avgEntryPrice: 230, currentPrice: 200 }),
    // +$500 biggest winner, biggest position by value
    pos("NVDA", { qty: 20, avgEntryPrice: 100, currentPrice: 125 }),
  ];

  it("aggregates totals and exposure", () => {
    const a = analyzePortfolio(positions, []);
    expect(a.positionCount).toBe(3);
    // 1000 + 1000 + 2500
    expect(a.totalMarketValue).toBe(4500);
    // +100 -150 +500
    expect(a.totalUnrealizedPl).toBe(450);
    expect(a.grossExposure).toBe(4500);
    expect(a.longExposure).toBe(4500);
    expect(a.shortExposure).toBe(0);
    expect(a.netExposure).toBe(4500);
  });

  it("identifies the biggest winner and biggest loser by dollar P/L", () => {
    const a = analyzePortfolio(positions, []);
    expect(a.biggestWinner?.symbol).toBe("NVDA");
    expect(a.biggestWinner?.unrealizedPl).toBe(500);
    expect(a.biggestLoser?.symbol).toBe("TSLA");
    expect(a.biggestLoser?.unrealizedPl).toBe(-150);
  });

  it("returns concentration as the largest position's share of gross exposure", () => {
    const a = analyzePortfolio(positions, []);
    // NVDA 2500 / 4500 gross
    expect(a.concentration?.symbol).toBe("NVDA");
    expect(a.concentration?.pctOfPortfolio).toBeCloseTo(2500 / 4500, 3);
  });

  it("answers 'how much X do I hold' via focusSymbol (case-insensitive)", () => {
    const a = analyzePortfolio(positions, [], { focusSymbol: "aapl" });
    expect(a.focusHolding?.symbol).toBe("AAPL");
    expect(a.focusHolding?.qty).toBe(10);
    expect(a.focusHolding?.marketValue).toBe(1000);
  });

  it("returns a null focusHolding when the symbol is not held", () => {
    const a = analyzePortfolio(positions, [], { focusSymbol: "META" });
    expect(a.focusHolding).toBeNull();
  });

  it("counts open orders and surfaces recent fills newest-first", () => {
    const orders: PortfolioOrderInput[] = [
      {
        symbol: "AAPL",
        side: "buy",
        qty: 10,
        status: "new",
        type: "limit",
        submittedAt: "2026-07-20T10:00:00Z",
        filledAt: null,
        filledAvgPrice: null,
      },
      {
        symbol: "NVDA",
        side: "buy",
        qty: 20,
        status: "filled",
        type: "market",
        submittedAt: "2026-07-18T10:00:00Z",
        filledAt: "2026-07-18T10:00:01Z",
        filledAvgPrice: 100,
      },
      {
        symbol: "TSLA",
        side: "sell",
        qty: 5,
        status: "filled",
        type: "market",
        submittedAt: "2026-07-19T10:00:00Z",
        filledAt: "2026-07-19T10:00:01Z",
        filledAvgPrice: 210,
      },
    ];
    const a = analyzePortfolio(positions, orders);
    expect(a.openOrderCount).toBe(1);
    expect(a.recentFills.length).toBe(2);
    // TSLA fill (2026-07-19) is newer than NVDA (2026-07-18)
    expect(a.recentFills[0]?.symbol).toBe("TSLA");
    expect(a.recentFills[1]?.symbol).toBe("NVDA");
  });

  it("excludes canceled orders from recentFills even when filledAt is set", () => {
    const orders: PortfolioOrderInput[] = [
      {
        // Partially filled, then canceled: carries fill fields but must NOT
        // be reported as a recent fill.
        symbol: "AAPL",
        side: "buy",
        qty: 10,
        status: "canceled",
        type: "limit",
        submittedAt: "2026-07-20T10:00:00Z",
        filledAt: "2026-07-20T10:00:01Z",
        filledAvgPrice: 99,
      },
      {
        // Still-working partial fill: a real fill, must be included.
        symbol: "NVDA",
        side: "buy",
        qty: 20,
        status: "partially_filled",
        type: "limit",
        submittedAt: "2026-07-19T10:00:00Z",
        filledAt: "2026-07-19T10:00:01Z",
        filledAvgPrice: 100,
      },
      {
        // Filled status but no filledAt timestamp: excluded (no fill time).
        symbol: "TSLA",
        side: "sell",
        qty: 5,
        status: "filled",
        type: "market",
        submittedAt: "2026-07-18T10:00:00Z",
        filledAt: null,
        filledAvgPrice: 210,
      },
    ];
    const a = analyzePortfolio(positions, orders);
    expect(a.recentFills.length).toBe(1);
    expect(a.recentFills[0]?.symbol).toBe("NVDA");
  });

  it("nets long and short exposure separately", () => {
    const mixed: PortfolioPositionInput[] = [
      pos("AAPL", { qty: 10, currentPrice: 100, marketValue: 1000 }),
      pos("SPY", {
        side: "short",
        qty: -4,
        currentPrice: 500,
        marketValue: -2000,
        costBasis: -2100,
        unrealizedPl: 100,
      }),
    ];
    const a = analyzePortfolio(mixed, []);
    expect(a.longExposure).toBe(1000);
    expect(a.shortExposure).toBe(2000);
    expect(a.grossExposure).toBe(3000);
    expect(a.netExposure).toBe(-1000);
  });

  it("handles an empty portfolio without throwing", () => {
    const a = analyzePortfolio([], []);
    expect(a.positionCount).toBe(0);
    expect(a.biggestWinner).toBeNull();
    expect(a.biggestLoser).toBeNull();
    expect(a.concentration).toBeNull();
    expect(a.totalUnrealizedPlPct).toBeNull();
  });
});
