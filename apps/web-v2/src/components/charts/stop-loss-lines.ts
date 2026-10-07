/**
 * The stop-loss levels to draw on the chart, folded out of the RESTING orders
 * that actually protect the position.
 *
 * WHY THE RESTING ORDERS AND NOT THE DATABASE. `orders.stopMarketPrice` and
 * `exitPlan.stopPrice` record what a stop was ASKED to be at submission time.
 * A line drawn from those survives the position: it keeps painting after the
 * stop fills, after it is cancelled, and after the user moves it at the venue.
 * A stop line that is wrong is worse than no stop line, because it is read as
 * "I am protected here". Both venues already expose the live resting orders
 * (`positions.list` resolves Alpaca's open orders and their OCO legs per
 * position; `positions.listPerpOpenOrders` returns Hyperliquid's trigger
 * orders), so the line exists exactly as long as the protection does.
 *
 * Pure: no React, no network, no widget. The drawing itself lives in
 * `use-stop-loss-lines.ts`.
 */

/**
 * At most this many stop lines per chart. Scaled entries legitimately produce
 * several stops at different prices; a hundred of them would paint the pane
 * solid and hide the price action the lines exist to contextualize.
 */
export const MAX_STOP_LOSS_LINES = 5;

export interface StopLossLine {
  /** Stable across polls so the reconciler updates rather than recreates. */
  id: string;
  price: number;
  /** Rendered at the line's right edge, e.g. "SL" or "Trailing SL". */
  label: string;
  /** A trailing stop moves on its own; the line is a snapshot, not a level. */
  trailing: boolean;
}

/** The shape `positions.list` returns for one Alpaca position. */
export interface EquityStopSource {
  symbol: string;
  stopLossOrders?: ReadonlyArray<{ stopPrice: number | null }>;
  trailingStopOrders?: ReadonlyArray<{ stopPrice: number | null }>;
}

/** The shape `positions.listPerpOpenOrders` returns for one resting HL order. */
export interface PerpStopSource {
  coin: string;
  triggerPx: string | null;
  tpsl: "tp" | "sl" | null;
  isTrigger: boolean;
}

function usablePrice(value: number | string | null | undefined): number | null {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Dedupe by price and cap. Two stops at the same level are one line: drawing
 * them twice says nothing extra and doubles the label clutter. A trailing stop
 * wins the tie, because the label it carries is the more cautionary of the two.
 */
function collapse(
  candidates: ReadonlyArray<{ price: number; trailing: boolean; label: string }>,
  prefix: string,
): StopLossLine[] {
  const byPrice = new Map<number, { price: number; trailing: boolean; label: string }>();
  for (const candidate of candidates) {
    const existing = byPrice.get(candidate.price);
    if (!existing || (candidate.trailing && !existing.trailing)) {
      byPrice.set(candidate.price, candidate);
    }
  }
  return [...byPrice.values()]
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_STOP_LOSS_LINES)
    .map((candidate) => ({
      id: `${prefix}:${candidate.price}`,
      price: candidate.price,
      label: candidate.label,
      trailing: candidate.trailing,
    }));
}

/**
 * Stop lines for an equity chart.
 *
 * A trailing stop only reports a `stopPrice` once the broker has computed one;
 * before that there is no level to draw and the position is skipped rather
 * than drawn at zero.
 */
export function equityStopLossLines(
  positions: ReadonlyArray<EquityStopSource>,
  chartSymbol: string,
): StopLossLine[] {
  const canonical = chartSymbol.trim().toUpperCase();
  if (!canonical) return [];

  const candidates: Array<{ price: number; trailing: boolean; label: string }> = [];
  for (const position of positions) {
    if (position.symbol.trim().toUpperCase() !== canonical) continue;
    for (const order of position.stopLossOrders ?? []) {
      const price = usablePrice(order.stopPrice);
      if (price !== null) candidates.push({ price, trailing: false, label: "SL" });
    }
    for (const order of position.trailingStopOrders ?? []) {
      const price = usablePrice(order.stopPrice);
      if (price !== null) candidates.push({ price, trailing: true, label: "Trailing SL" });
    }
  }
  return collapse(candidates, `eq:${canonical}`);
}

/**
 * Stop lines for a perp chart.
 *
 * Only `tpsl === "sl"` trigger orders count. A take-profit is also a resting
 * trigger on the same coin, and drawing it in the stop-loss color would invert
 * the single most important read on the chart.
 */
export function perpStopLossLines(
  orders: ReadonlyArray<PerpStopSource>,
  chartCoin: string,
): StopLossLine[] {
  const canonical = chartCoin.trim().toUpperCase();
  if (!canonical) return [];

  const candidates: Array<{ price: number; trailing: boolean; label: string }> = [];
  for (const order of orders) {
    if (!order.isTrigger || order.tpsl !== "sl") continue;
    if (order.coin.trim().toUpperCase() !== canonical) continue;
    const price = usablePrice(order.triggerPx);
    if (price !== null) candidates.push({ price, trailing: false, label: "SL" });
  }
  return collapse(candidates, `hl:${canonical}`);
}
