export type PortfolioHistoryPeriod = "1D" | "1W" | "1M" | "ALL";

export type RawPortfolioHistory = {
  timestamp?: (number | null)[];
  equity?: (number | null)[];
  profit_loss?: (number | null)[];
  profit_loss_pct?: (number | null)[];
  base_value?: number | null;
};

export type NormalizedPortfolioHistory = {
  points: Array<{ t: number; equity: number; pnl: number; pnlPct: number }>;
  baseValue: number;
  period: string;
};

export const portfolioHistoryPeriodParams: Record<
  PortfolioHistoryPeriod,
  { period: string; timeframe: string }
> = {
  "1D": { period: "1D", timeframe: "5Min" },
  "1W": { period: "1W", timeframe: "1H" },
  "1M": { period: "1M", timeframe: "1D" },
  ALL: { period: "all", timeframe: "1D" },
};

/**
 * Normalize a raw Alpaca portfolio-history payload into a flat, client-friendly
 * series. Alpaca returns parallel arrays where index i is the same point in
 * time, with timestamps in seconds.
 */
export function normalizePortfolioHistory(
  raw: RawPortfolioHistory,
  period: string
): NormalizedPortfolioHistory {
  const timestamps = raw.timestamp ?? [];
  const equity = raw.equity ?? [];
  const profitLoss = raw.profit_loss ?? [];
  const profitLossPct = raw.profit_loss_pct ?? [];

  const points: NormalizedPortfolioHistory["points"] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const eq = equity[i];
    if (eq == null) continue;
    points.push({
      t: (timestamps[i] ?? 0) * 1000,
      equity: eq,
      pnl: profitLoss[i] ?? 0,
      pnlPct: (profitLossPct[i] ?? 0) * 100,
    });
  }

  const baseValue = raw.base_value ?? equity[0] ?? 0;

  return { points, baseValue, period };
}
