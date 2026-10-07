/**
 * Pure aggregation over a snapshot of positions and recent orders for the chat
 * "portfolio Q&A" tool. No I/O: the tool handler fetches from Alpaca and maps
 * the broker rows into these lean inputs, then calls `analyzePortfolio` so the
 * math is unit-testable against the real implementation.
 *
 * Everything is denominated in the account's currency; percentages are
 * fractions on input (0.05 = 5%) and returned as fractions unless a field name
 * says otherwise.
 */

export interface PortfolioPositionInput {
  symbol: string;
  side: "long" | "short";
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPl: number;
  /** Unrealized P/L as a fraction of cost basis (0.05 = +5%). */
  unrealizedPlPct: number;
  /** Intraday change as a fraction (0.02 = +2% today). */
  changeTodayPct: number;
  assetClass?: string;
}

export interface PortfolioOrderInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  status: string;
  type: string;
  submittedAt: string | null;
  filledAt: string | null;
  filledAvgPrice: number | null;
}

export interface PositionSummary {
  symbol: string;
  side: "long" | "short";
  qty: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  /** Signed share of gross exposure this position represents (0..1). */
  pctOfPortfolio: number;
}

export interface HoldingSummary {
  symbol: string;
  qty: number;
  marketValue: number;
  unrealizedPl: number;
}

export interface FillSummary {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filledAvgPrice: number | null;
  filledAt: string | null;
}

export interface PortfolioAnalysis {
  positionCount: number;
  totalMarketValue: number;
  totalCostBasis: number;
  totalUnrealizedPl: number;
  /** Total unrealized P/L as a fraction of total cost basis, or null. */
  totalUnrealizedPlPct: number | null;
  longExposure: number;
  shortExposure: number;
  netExposure: number;
  grossExposure: number;
  biggestWinner: PositionSummary | null;
  biggestLoser: PositionSummary | null;
  /** Positions sorted by absolute market value, largest first (capped). */
  topByValue: PositionSummary[];
  /** Per-symbol aggregated holdings, sorted by absolute market value. */
  holdings: HoldingSummary[];
  /** Largest single position as a fraction of gross exposure, or null. */
  concentration: { symbol: string; pctOfPortfolio: number } | null;
  openOrderCount: number;
  /** Most recent fills, newest first (capped). */
  recentFills: FillSummary[];
  /** When a focus symbol was requested, the matching aggregated holding. */
  focusHolding: HoldingSummary | null;
}

export interface AnalyzePortfolioOptions {
  /** Answer "how much X do I hold" by surfacing a single symbol's holding. */
  focusSymbol?: string;
  /** How many rows to include in topByValue / recentFills. Defaults to 5. */
  topN?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

const OPEN_ORDER_STATUSES = new Set([
  "new",
  "partially_filled",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "pending_replace",
  "pending_cancel",
  "held",
  "replaced",
  "calculated",
  "done_for_day",
  "stopped",
  "suspended",
]);

/**
 * Aggregate a positions + orders snapshot into the figures a portfolio Q&A
 * turn needs: totals, exposure, biggest winner/loser, per-symbol holdings,
 * concentration, and recent fills. Deterministic and side-effect free.
 */
export function analyzePortfolio(
  positions: PortfolioPositionInput[],
  orders: PortfolioOrderInput[] = [],
  options: AnalyzePortfolioOptions = {}
): PortfolioAnalysis {
  const topN = Number.isFinite(options.topN) && (options.topN as number) > 0
    ? Math.floor(options.topN as number)
    : 5;

  let totalMarketValue = 0;
  let totalCostBasis = 0;
  let totalUnrealizedPl = 0;
  let longExposure = 0;
  let shortExposure = 0;

  for (const p of positions) {
    totalMarketValue += p.marketValue;
    totalCostBasis += p.costBasis;
    totalUnrealizedPl += p.unrealizedPl;
    if (p.side === "short") shortExposure += Math.abs(p.marketValue);
    else longExposure += Math.abs(p.marketValue);
  }

  const grossExposure = longExposure + shortExposure;
  const netExposure = longExposure - shortExposure;

  const toSummary = (p: PortfolioPositionInput): PositionSummary => ({
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    marketValue: round2(p.marketValue),
    unrealizedPl: round2(p.unrealizedPl),
    unrealizedPlPct: round4(p.unrealizedPlPct),
    pctOfPortfolio:
      grossExposure > 0 ? round4(Math.abs(p.marketValue) / grossExposure) : 0,
  });

  const summaries = positions.map(toSummary);

  // Biggest winner / loser by absolute dollar P/L. A winner needs P/L > 0, a
  // loser needs P/L < 0; an all-green or all-red book yields one null.
  let biggestWinner: PositionSummary | null = null;
  let biggestLoser: PositionSummary | null = null;
  for (const s of summaries) {
    if (s.unrealizedPl > 0 && (!biggestWinner || s.unrealizedPl > biggestWinner.unrealizedPl)) {
      biggestWinner = s;
    }
    if (s.unrealizedPl < 0 && (!biggestLoser || s.unrealizedPl < biggestLoser.unrealizedPl)) {
      biggestLoser = s;
    }
  }

  const topByValue = [...summaries]
    .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue))
    .slice(0, topN);

  // Per-symbol holdings: fold multiple rows of the same symbol together (rare
  // for equities, but robust for options-like duplicates).
  const holdingMap = new Map<string, HoldingSummary>();
  for (const p of positions) {
    const existing = holdingMap.get(p.symbol);
    if (existing) {
      existing.qty += p.qty;
      existing.marketValue = round2(existing.marketValue + p.marketValue);
      existing.unrealizedPl = round2(existing.unrealizedPl + p.unrealizedPl);
    } else {
      holdingMap.set(p.symbol, {
        symbol: p.symbol,
        qty: p.qty,
        marketValue: round2(p.marketValue),
        unrealizedPl: round2(p.unrealizedPl),
      });
    }
  }
  const holdings = [...holdingMap.values()].sort(
    (a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue)
  );

  const largestByValue = topByValue[0];
  const concentration =
    largestByValue && grossExposure > 0
      ? {
          symbol: largestByValue.symbol,
          pctOfPortfolio: largestByValue.pctOfPortfolio,
        }
      : null;

  const openOrderCount = orders.filter((o) =>
    OPEN_ORDER_STATUSES.has(o.status.toLowerCase())
  ).length;

  const recentFills: FillSummary[] = orders
    .filter((o) => {
      // A non-null filledAt alone is not proof of a completed fill: a
      // partially-filled order that was later canceled can still carry fill
      // fields. Require an explicit filled/partially_filled status too.
      const status = o.status.toLowerCase();
      return (
        (status === "filled" || status === "partially_filled") &&
        o.filledAt != null
      );
    })
    .sort((a, b) => {
      const ta = a.filledAt ? Date.parse(a.filledAt) : 0;
      const tb = b.filledAt ? Date.parse(b.filledAt) : 0;
      return tb - ta;
    })
    .slice(0, topN)
    .map((o) => ({
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      filledAvgPrice: o.filledAvgPrice,
      filledAt: o.filledAt,
    }));

  const focus = options.focusSymbol?.trim().toUpperCase();
  const focusHolding = focus
    ? holdings.find((h) => h.symbol.toUpperCase() === focus) ?? null
    : null;

  return {
    positionCount: positions.length,
    totalMarketValue: round2(totalMarketValue),
    totalCostBasis: round2(totalCostBasis),
    totalUnrealizedPl: round2(totalUnrealizedPl),
    totalUnrealizedPlPct:
      totalCostBasis !== 0 ? round4(totalUnrealizedPl / Math.abs(totalCostBasis)) : null,
    longExposure: round2(longExposure),
    shortExposure: round2(shortExposure),
    netExposure: round2(netExposure),
    grossExposure: round2(grossExposure),
    biggestWinner,
    biggestLoser,
    topByValue,
    holdings,
    concentration,
    openOrderCount,
    recentFills,
    focusHolding,
  };
}
