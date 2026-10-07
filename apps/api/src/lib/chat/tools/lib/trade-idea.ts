/**
 * Pure assembly of a ticker "trade-idea readout" from a price snapshot, a
 * window of OHLC bars, recent news, and recent signals. No I/O: the tool
 * handler gathers the raw inputs (Alpaca quote + bars, SEC/GDELT research, the
 * signals table) and calls `buildTradeIdeaReadout` so the trend math stays
 * unit-testable.
 *
 * This is an ANALYTICAL SUMMARY, not personalized investment advice: it reports
 * measurable facts (trend, distance from range extremes, momentum) and echoes
 * third-party news/signals. It deliberately does not tell the user to buy or
 * sell.
 */

export interface TradeIdeaBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TradeIdeaQuote {
  last: number | null;
  bid: number | null;
  ask: number | null;
  dayHigh: number | null;
  dayLow: number | null;
}

export interface TradeIdeaNewsItem {
  title: string;
  url: string;
  source: string | null;
  publishedAt: string | null;
}

export interface TradeIdeaSignalItem {
  content: string;
  source: string;
  status: string;
  timestamp: string;
}

export type TrendDirection = "up" | "down" | "sideways" | "unknown";

export interface TradeIdeaTrend {
  direction: TrendDirection;
  shortSma: number | null;
  longSma: number | null;
  /** First-to-last close change over the window, as a fraction. */
  changePct: number | null;
  /** Distance below the window's highest close, as a fraction (>= 0). */
  pctFromHigh: number | null;
  /** Distance above the window's lowest close, as a fraction (>= 0). */
  pctFromLow: number | null;
  /** Where the last price sits between window low (0) and high (1). */
  rangePosition: number | null;
  barsAnalyzed: number;
}

export interface TradeIdeaReadout {
  symbol: string;
  price: number | null;
  trend: TradeIdeaTrend;
  news: TradeIdeaNewsItem[];
  signals: TradeIdeaSignalItem[];
  /** Neutral, factual observations the model can weave into prose. */
  notes: string[];
}

export interface BuildTradeIdeaInput {
  symbol: string;
  quote?: TradeIdeaQuote | null;
  bars?: TradeIdeaBar[] | null;
  news?: TradeIdeaNewsItem[] | null;
  signals?: TradeIdeaSignalItem[] | null;
  /** Short SMA window. Defaults to 10. */
  shortWindow?: number;
  /** Long SMA window. Defaults to 30. */
  longWindow?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function sma(closes: number[], window: number): number | null {
  if (window <= 0 || closes.length < window) return null;
  const slice = closes.slice(closes.length - window);
  const sum = slice.reduce((a, b) => a + b, 0);
  return round2(sum / window);
}

/**
 * Build the structured readout. Trend classification is intentionally simple
 * and deterministic: an up/down call needs the short SMA on the expected side
 * of the long SMA AND a same-direction net change over the window; otherwise it
 * reads "sideways". With too few bars the trend is "unknown".
 */
export function buildTradeIdeaReadout(input: BuildTradeIdeaInput): TradeIdeaReadout {
  const symbol = input.symbol.trim().toUpperCase();
  const bars = (input.bars ?? []).filter(
    (b) => Number.isFinite(b.c) && b.c > 0
  );
  const closes = bars.map((b) => b.c);
  const shortWindow = input.shortWindow ?? 10;
  const longWindow = input.longWindow ?? 30;

  const lastClose = closes.length > 0 ? closes[closes.length - 1]! : null;
  const firstClose = closes.length > 0 ? closes[0]! : null;

  const price =
    input.quote?.last != null && Number.isFinite(input.quote.last)
      ? round2(input.quote.last)
      : lastClose != null
        ? round2(lastClose)
        : null;

  const shortSma = sma(closes, Math.min(shortWindow, closes.length || 1));
  const longSma = sma(closes, Math.min(longWindow, closes.length || 1));

  const changePct =
    closes.length >= 2 && firstClose != null && lastClose != null && firstClose > 0
      ? round4((lastClose - firstClose) / firstClose)
      : null;

  const windowHigh = closes.length > 0 ? Math.max(...closes) : null;
  const windowLow = closes.length > 0 ? Math.min(...closes) : null;
  const reference = price ?? lastClose ?? null;

  const pctFromHigh =
    windowHigh != null && windowHigh > 0 && reference != null
      ? round4((windowHigh - reference) / windowHigh)
      : null;
  const pctFromLow =
    windowLow != null && windowLow > 0 && reference != null
      ? round4((reference - windowLow) / windowLow)
      : null;

  const rangePosition =
    windowHigh != null && windowLow != null && windowHigh > windowLow && reference != null
      ? round4((reference - windowLow) / (windowHigh - windowLow))
      : null;

  let direction: TrendDirection = "unknown";
  if (closes.length >= 3 && shortSma != null && longSma != null && changePct != null) {
    if (shortSma > longSma && changePct > 0.005) direction = "up";
    else if (shortSma < longSma && changePct < -0.005) direction = "down";
    else direction = "sideways";
  }

  const notes: string[] = [];
  if (bars.length === 0) {
    notes.push("No price bars were available to assess the trend.");
  } else {
    notes.push(
      `Trend over the last ${bars.length} bars reads ${direction}` +
        (changePct != null ? ` (${(changePct * 100).toFixed(2)}% net).` : ".")
    );
    if (rangePosition != null) {
      const pos =
        rangePosition >= 0.8
          ? "near the top of its recent range"
          : rangePosition <= 0.2
            ? "near the bottom of its recent range"
            : "mid-range";
      notes.push(`Price is ${pos} for the window.`);
    }
  }
  if ((input.news ?? []).length === 0) {
    notes.push("No recent news was found in the window.");
  }
  if ((input.signals ?? []).length === 0) {
    notes.push("No recent signals were found for this symbol.");
  }
  notes.push(
    "This is an analytical summary of price, news, and signals, not personalized investment advice."
  );

  return {
    symbol,
    price,
    trend: {
      direction,
      shortSma,
      longSma,
      changePct,
      pctFromHigh,
      pctFromLow,
      rangePosition,
      barsAnalyzed: bars.length,
    },
    news: (input.news ?? []).slice(0, 5),
    signals: (input.signals ?? []).slice(0, 5),
    notes,
  };
}
