/**
 * Pure label helpers for feed ticker chart/prefill actions. Extracted from
 * component JSX so the logic can be unit-tested directly.
 *
 * A feed ticker chip is a two-part control: the ticker half is IDENTITY (tap =
 * chart it) and the Copy half is INTENT (tap = prefilled ticket). Every label
 * below belongs to exactly one of those halves, and they must stay distinct: a
 * control that says "trade form" and opens a chart is the bug F1/F4 fixes.
 */

/**
 * Strip Hyperliquid's internal namespace from a coin for DISPLAY ONLY.
 *
 * HL namespaces its stock-backed perps, so the canonical coin for GOOGL is
 * literally `xyz:GOOGL`. That prefix is a venue implementation detail: showing
 * "Copy $xyz:GOOGL" to a user is noise, and on a 375px feed row it is noise that
 * costs real width.
 *
 * DISPLAY ONLY. The canonical spelling is what the API, the order payload and
 * `perpCopyPayload` must keep, because it is the coin Hyperliquid actually
 * trades. Never feed the result of this back into a request.
 */
export function perpDisplayCoin(coin: string): string {
  const separator = coin.indexOf(":");
  if (separator === -1) return coin;
  const bare = coin.slice(separator + 1).trim();
  // A prefix with nothing after it is malformed; keep the original rather than
  // render an empty chip.
  return bare === "" ? coin : bare;
}

/** Aria-label for an X-signal "prefill equity trade form" button. */
export function stockPrefillLabel(symbol: string): string {
  return `Copy ${symbol} to the trade form`;
}

/** Aria-label for a perp-signal "prefill perp trade form" button. */
export function perpPrefillLabel(coin: string): string {
  return `Copy ${perpDisplayCoin(coin)} perp into the perps trade form`;
}

/** Aria-label for a "view symbol live chart" button in any feed panel. */
export function feedChartViewLabel(symbol: string): string {
  return `View $${symbol} live chart`;
}

/**
 * Aria-label for charting a PERP row. Distinct from `feedChartViewLabel` because
 * tickers collide across venues (SOL is Solana on Hyperliquid and ReneSola on
 * Nasdaq), so "View $SOL live chart" on both a perp and an equity chip would be
 * two different destinations under one name.
 */
export function perpChartViewLabel(coin: string): string {
  return `View $${perpDisplayCoin(coin)} perp live chart`;
}

/** Visible text on the identity half of a chip ("$NVDA"). */
export function tickerChipLabel(symbol: string): string {
  return `$${perpDisplayCoin(symbol)}`;
}

/** Visible text on the intent half of a chip. The symbol lives on the identity
 *  half, so this stays compact; the aria-label still names the ticker. */
export const COPY_ACTION_LABEL = "Copy";

/** Native tooltip on an EQUITY copy chip. */
export function stockPrefillTitle(symbol: string): string {
  return `Prefill the trade form with $${symbol}`;
}

/**
 * Native tooltip on a PERP copy chip. Carries the direction/leverage badge
 * ("20x Short") so a leveraged call reads differently from an equity call.
 */
export function perpPrefillTitle(coin: string, badgeLabel: string): string {
  return `Prefill the perp trade form with ${perpDisplayCoin(coin)} (${badgeLabel})`;
}

/** Native tooltip on the "Trade stock" escape hatch of a PERP chip. */
export function stockFromPerpPrefillTitle(coin: string): string {
  return `Prefill the stock trade form with ${perpDisplayCoin(coin)}`;
}
