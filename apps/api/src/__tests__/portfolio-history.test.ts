import { describe, it, expect } from "bun:test";
import { normalizePortfolioHistory } from "../lib/portfolio-history.js";

describe("normalizePortfolioHistory", () => {
  it("converts timestamps from seconds to milliseconds", () => {
    const result = normalizePortfolioHistory(
      {
        timestamp: [1700000000, 1700000300],
        equity: [1000, 1010],
        profit_loss: [0, 10],
        profit_loss_pct: [0, 0.01],
        base_value: 1000,
      },
      "1D"
    );
    expect(result.points.map((p) => p.t)).toEqual([1700000000000, 1700000300000]);
    expect(result.period).toBe("1D");
  });

  it("maps equity/pnl/pnlPct by index", () => {
    const result = normalizePortfolioHistory(
      {
        timestamp: [1700000000, 1700000300],
        equity: [1000, 1050],
        profit_loss: [0, 50],
        profit_loss_pct: [0, 0.05],
        base_value: 1000,
      },
      "1W"
    );
    // profit_loss_pct is a decimal ratio from Alpaca → normalized to percent.
    expect(result.points).toEqual([
      { t: 1700000000000, equity: 1000, pnl: 0, pnlPct: 0 },
      { t: 1700000300000, equity: 1050, pnl: 50, pnlPct: 5 },
    ]);
  });

  it("falls back to equity[0] for baseValue when base_value is absent, and skips null equity", () => {
    const result = normalizePortfolioHistory(
      {
        timestamp: [1700000000, 1700000300, 1700000600],
        equity: [990, null, 1010],
        profit_loss: [-10, null, 10],
        profit_loss_pct: [-0.01, null, 0.01],
        // base_value omitted on purpose
      },
      "1M"
    );
    expect(result.baseValue).toBe(990); // equity[0] fallback
    // The null-equity index is dropped; pnlPct scaled ratio→percent.
    expect(result.points).toEqual([
      { t: 1700000000000, equity: 990, pnl: -10, pnlPct: -1 },
      { t: 1700000600000, equity: 1010, pnl: 10, pnlPct: 1 },
    ]);
  });

  it("returns empty points and baseValue 0 for empty arrays", () => {
    const result = normalizePortfolioHistory(
      {
        timestamp: [],
        equity: [],
        profit_loss: [],
        profit_loss_pct: [],
      },
      "ALL"
    );
    expect(result.points).toEqual([]);
    expect(result.baseValue).toBe(0);
    expect(result.period).toBe("ALL");
  });
});
