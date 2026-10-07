/**
 * Pure ladder math for the perps L2 order book.
 *
 * `hyperliquid.l2Book` returns two arrays of raw decimal strings, best price
 * first on each side. Everything a ladder needs on top of that (cumulative size,
 * cumulative notional, the depth-bar share, the mid and the spread) is derived,
 * and derived identically for both sides, so it lives here rather than inside
 * the component: the component is then a table renderer with no arithmetic, and
 * this stays unit-testable without React (the audit's "extract pure math into a
 * lib module" rule).
 *
 * Framework-free on purpose: no React, no `@trade-bot/hyperliquid` import. The
 * input is a structural subset of the tRPC output.
 */

import { formatPerpPx, formatPerpSpreadBps } from "./perp-format";

/** Structural subset of one `hyperliquid.l2Book` level. */
export interface PerpBookLevelInput {
  px: string;
  sz: string;
  n: number;
}

/** Structural subset of the `hyperliquid.l2Book` payload. */
export interface PerpBookInput {
  bids: readonly PerpBookLevelInput[];
  asks: readonly PerpBookLevelInput[];
}

/** One rendered ladder row: the level plus everything derived from it. */
export interface PerpBookRow {
  /** HL's raw price string, preserved verbatim so a click can prefill it. */
  px: string;
  /** Parsed price, for the mid / spread math and the notional. */
  price: number;
  /** Resting size at this level, in coin units. */
  size: number;
  /** Size summed from the best price through this level, in coin units. */
  cumulativeSize: number;
  /** `cumulativeSize` valued at each level's own price, in USD. */
  cumulativeNotional: number;
  /**
   * This row's share (0..1) of the deepest cumulative size across BOTH sides,
   * so the two ladders' depth bars are directly comparable rather than each
   * being normalized to its own side's maximum.
   */
  depthRatio: number;
}

/** A ready-to-render ladder plus its top-of-book summary. */
export interface PerpBookLadder {
  /** Bid rows, highest price first. */
  bids: PerpBookRow[];
  /** Ask rows, lowest price first. */
  asks: PerpBookRow[];
  bestBid: number | null;
  bestAsk: number | null;
  /** Midpoint of the top of book; null unless BOTH sides have a level. */
  mid: number | null;
  /** Best ask minus best bid; null unless both sides have a level. */
  spread: number | null;
  /** The spread in basis points of the mid; null when the mid is unusable. */
  spreadBps: number | null;
  /** True when neither side has a single usable level. */
  isEmpty: boolean;
}

/** Parse a raw HL decimal string to a finite number, else null. */
function toFinite(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Drop levels HL could not price and accumulate the rest in arrival order
 * (best first). A level with an unparseable or non-positive price is skipped
 * entirely rather than rendered as a zero row.
 */
function accumulate(levels: readonly PerpBookLevelInput[]): PerpBookRow[] {
  const rows: PerpBookRow[] = [];
  let cumulativeSize = 0;
  let cumulativeNotional = 0;
  for (const level of levels) {
    const price = toFinite(level?.px);
    if (price == null || price <= 0) continue;
    const size = Math.max(0, toFinite(level?.sz) ?? 0);
    cumulativeSize += size;
    cumulativeNotional += size * price;
    rows.push({
      px: level.px,
      price,
      size,
      cumulativeSize,
      cumulativeNotional,
      // Filled in below, once both sides' deepest total is known.
      depthRatio: 0,
    });
  }
  return rows;
}

/**
 * Build both ladders from an L2 book payload.
 *
 * `maxRows` caps each side after the unusable levels are dropped, so a book
 * padded with junk levels still renders a full ladder. The server already
 * clamps depth; this is the render-side cap for a short rail.
 */
export function buildPerpBookLadder(
  book: PerpBookInput | null | undefined,
  maxRows: number,
): PerpBookLadder {
  const limit = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : 1;
  const bids = accumulate(book?.bids ?? []).slice(0, limit);
  const asks = accumulate(book?.asks ?? []).slice(0, limit);

  const deepest = Math.max(
    bids[bids.length - 1]?.cumulativeSize ?? 0,
    asks[asks.length - 1]?.cumulativeSize ?? 0,
  );
  if (deepest > 0) {
    for (const row of bids) row.depthRatio = row.cumulativeSize / deepest;
    for (const row of asks) row.depthRatio = row.cumulativeSize / deepest;
  }

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid =
    bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const spread =
    bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadBps =
    spread != null && mid != null && mid > 0 ? (spread / mid) * 10_000 : null;

  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps,
    isEmpty: bids.length === 0 && asks.length === 0,
  };
}

/**
 * The spread cell's text: the absolute spread at the ladder's own price
 * precision, plus the same figure in basis points, which is the only way a
 * spread compares across coins that differ by five orders of magnitude in unit
 * price. Returns "-" when the book is one-sided.
 */
export function formatPerpBookSpread(
  spread: number | null,
  spreadBps: number | null,
): string {
  if (spread == null) return "-";
  const absolute = formatPerpPx(spread);
  if (spreadBps == null) return absolute;
  return `${absolute} (${formatPerpSpreadBps(spreadBps)} bps)`;
}
