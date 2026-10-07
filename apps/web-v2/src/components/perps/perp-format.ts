/**
 * Shared perps price/quote formatting.
 *
 * Hyperliquid reports prices as raw decimal strings across a huge dynamic range
 * (BTC in the tens of thousands, a 1000x coin in fractions of a cent). A fixed
 * 2-decimal currency format collapses low-priced coins and sub-cent 24h moves
 * to "$0.00" and makes real values read as missing. These helpers scale the
 * decimal precision to the price magnitude (the same idiom the perp positions /
 * fills tables use) and derive the header strip's price / 24h-change / bid-ask
 * display strings from a market snapshot.
 *
 * Framework-free (no React, no `@trade-bot/hyperliquid`) so it stays importable
 * from both client components and unit tests. The snapshot input is a
 * structural subset of the `hyperliquid.assetSnapshot` tRPC output.
 */

import { formatUsd } from "@/lib/format";

/** Coerce a string | number | null | undefined price to a finite number or null. */
function toFiniteNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decimal precision scaled to price magnitude: large prices stay tidy at 2dp,
 * sub-$1 prices widen (log-based) so a low-priced coin keeps its significant
 * figures instead of collapsing to "0.00".
 */
function adaptiveMaxFractionDigits(abs: number): number {
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs > 0) return Math.min(12, Math.ceil(-Math.log10(abs)) + 4);
  return 2;
}

/**
 * Adaptive plain number (no currency symbol), e.g. entry / mark / liq prices in
 * a table cell. Returns "-" when the value is genuinely absent / non-numeric.
 */
export function formatPerpPx(
  value: string | number | null | undefined,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: adaptiveMaxFractionDigits(Math.abs(parsed)),
  }).format(parsed);
}

/** Compact SL / TP price: omit trailing .00 without losing sub-$1 precision. */
export function formatPerpExitPx(
  value: string | number | null | undefined,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Math.abs(parsed) < 1 ? 2 : 0,
    maximumFractionDigits: adaptiveMaxFractionDigits(Math.abs(parsed)),
  }).format(parsed);
}

/** Adaptive USD (currency symbol), e.g. the header Price / Bid / Ask cells. */
export function formatPerpUsd(
  value: string | number | null | undefined,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: adaptiveMaxFractionDigits(Math.abs(parsed)),
  }).format(parsed);
}

/**
 * A position's USD notional: the coin size valued at `price` (the mark for an
 * open position, the average close for a closed one).
 *
 * Position tables show this instead of the raw coin quantity: "0.0231 BTC" does
 * not tell a user how much money is in the trade, and the quantity is meaningless
 * across coins that differ by five orders of magnitude in unit price. Notional is
 * a plain dollar amount, so it uses the shared 2-decimal `formatUsd` rather than
 * the adaptive price precision above. Returns "-" when either input is unusable.
 */
export function formatPerpNotionalUsd(
  sizeCoin: string | number | null | undefined,
  price: string | number | null | undefined,
): string {
  const size = toFiniteNumber(sizeCoin);
  const px = toFiniteNumber(price);
  if (size == null || px == null || px <= 0) return "-";
  return formatUsd(Math.abs(size) * px);
}

/** Signed adaptive percentage, widening precision for sub-0.01% moves. */
function formatSignedPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  const abs = Math.abs(pct);
  const digits =
    abs !== 0 && abs < 0.01 ? Math.min(6, Math.ceil(-Math.log10(abs)) + 2) : 2;
  return `${sign}${pct.toFixed(digits)}%`;
}

/**
 * Format an HL funding rate (a per-hour rate as a decimal, e.g. "0.0000125")
 * as a signed percentage ("+0.00125%"). Funding is routinely sub-0.01%, so the
 * precision widens for small magnitudes rather than rounding to "0.00%".
 * Returns "-" when the rate is absent / non-numeric.
 */
export function formatPerpFundingPct(
  value: string | number | null | undefined,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return "-";
  return formatSignedPct(parsed * 100);
}

/**
 * Format an order book spread in basis points.
 *
 * Precision scales to magnitude for the same reason every other helper here
 * does: a liquid perp sits under a basis point, where a single decimal rounds
 * the spread to nothing, while an illiquid one runs to hundreds, where two
 * decimals are noise. Lives beside the other perps helpers rather than inline
 * at the call site so the scaling rule stays in one place.
 */
export function formatPerpSpreadBps(
  value: string | number | null | undefined,
): string {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return "-";
  return Math.abs(parsed) < 10 ? parsed.toFixed(2) : parsed.toFixed(1);
}

/**
 * Format Hyperliquid's position return-on-equity decimal as a signed percent.
 * Older normalized payloads did not preserve `returnOnEquity`, so fall back to
 * unrealized P&L divided by margin used when both values are usable.
 */
export function formatPerpRoePct(
  returnOnEquity: string | number | null | undefined,
  unrealizedPnl: string | number | null | undefined,
  marginUsed: string | number | null | undefined,
): string {
  let roe = toFiniteNumber(returnOnEquity);
  if (roe == null) {
    const pnl = toFiniteNumber(unrealizedPnl);
    const margin = toFiniteNumber(marginUsed);
    if (pnl == null || margin == null || margin === 0) return "-";
    roe = pnl / Math.abs(margin);
  }
  return formatSignedPct(roe * 100);
}

export type PerpQuoteTone = "positive" | "negative" | "neutral";

/**
 * Compact 24h change for a market-list row: just the signed percentage plus a
 * tone, derived from mark vs previous-day price. Returns "-"/neutral when it
 * cannot be computed (missing price or a zero reference), never a
 * divide-by-zero. Pure + exported for unit testing.
 */
export function formatPerpChangePct(
  markPx: string | number | null | undefined,
  prevDayPx: string | number | null | undefined,
): { text: string; tone: PerpQuoteTone } {
  const mark = toFiniteNumber(markPx);
  const prev = toFiniteNumber(prevDayPx);
  if (mark == null || prev == null || prev === 0) {
    return { text: "-", tone: "neutral" };
  }
  const pct = ((mark - prev) / prev) * 100;
  const tone: PerpQuoteTone =
    pct > 0 ? "positive" : pct < 0 ? "negative" : "neutral";
  return { text: formatSignedPct(pct), tone };
}

/** Structural subset of `hyperliquid.assetSnapshot` the header strip consumes. */
export interface PerpQuoteSnapshot {
  markPx: string | null;
  midPx?: string | null;
  prevDayPx: string | null;
  bid: string | null;
  ask: string | null;
}

/** Header-strip display strings derived from a perp market snapshot. */
export interface PerpHeaderQuote {
  /** Mark price (falls back to mid), currency-formatted; "-" when absent. */
  price: string;
  /** Signed 24h percentage change; "-" when it cannot be computed. */
  dayChange: string;
  dayChangeTone: PerpQuoteTone;
  /** "$bid / $ask" top-of-book; "-" when neither side is available. */
  bidAsk: string;
  /** Whether a headline (mark/mid) price is present yet. */
  hasData: boolean;
}

/**
 * Map a perp market snapshot to the header strip's display strings. Pure and
 * exported for unit testing. The 24h change is derived from the headline price
 * (mark, falling back to mid) versus the previous day's close; a zero or
 * missing reference yields a "-" change rather than a divide-by-zero.
 */
export function formatPerpQuote(
  snapshot: PerpQuoteSnapshot | null | undefined,
): PerpHeaderQuote {
  const mark = toFiniteNumber(snapshot?.markPx);
  const mid = toFiniteNumber(snapshot?.midPx);
  const headline = mark ?? mid;
  const prevDay = toFiniteNumber(snapshot?.prevDayPx);
  const bid = toFiniteNumber(snapshot?.bid);
  const ask = toFiniteNumber(snapshot?.ask);

  let dayChange = "-";
  let dayChangeTone: PerpQuoteTone = "neutral";
  if (headline != null && prevDay != null && prevDay !== 0) {
    const pct = ((headline - prevDay) / prevDay) * 100;
    dayChangeTone = pct > 0 ? "positive" : pct < 0 ? "negative" : "neutral";
    dayChange = formatSignedPct(pct);
  }

  const bidAsk =
    bid == null && ask == null
      ? "-"
      : `${formatPerpUsd(bid)} / ${formatPerpUsd(ask)}`;

  return {
    price: formatPerpUsd(headline),
    dayChange,
    dayChangeTone,
    bidAsk,
    hasData: headline != null,
  };
}
