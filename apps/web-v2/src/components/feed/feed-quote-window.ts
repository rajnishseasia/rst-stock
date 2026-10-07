/**
 * Which feed rows get a live price (plan A13).
 *
 * `quotes.getChartQuotes` validates `symbols` with `.max(30)` server-side, and
 * every symbol in the batch costs one Alpaca snapshot call per tick, so the cap
 * stays at 30. The defect was never the size of the budget, it was the ORDER it
 * was spent in: the window was filled from the top of the loaded list, so once
 * a reader scrolled past roughly the first thirty tickers every equity row
 * below rendered a bare "Copy $SYM". Perp rows kept their prices, because
 * `hyperliquid.marketStats` takes no arguments, so the feed visibly degraded
 * into "perp calls have prices, stock calls do not".
 *
 * This spends the same budget around wherever the reader actually is.
 */

/** Maximum symbols per quote batch. Mirrors the router's `.max(30)`. */
export const MAX_QUOTE_SYMBOLS = 30;

/**
 * Rows above the anchor kept priced, so scrolling back a little does not blank
 * the rows that just left the viewport.
 */
export const QUOTE_WINDOW_LOOKBACK = 4;

/**
 * Anchor quantization. The window feeds a query key, so an anchor that moved
 * with every pixel would refetch continuously while scrolling. Rounding the
 * anchor down to a multiple of this keeps the key stable within a band.
 */
export const QUOTE_ANCHOR_STEP = 10;

/** Round an anchor row index down to the nearest `step`. */
export function quantizeFeedAnchor(
  index: number,
  step: number = QUOTE_ANCHOR_STEP,
): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  if (!Number.isFinite(step) || step <= 1) return Math.floor(index);
  return Math.floor(index / step) * step;
}

export interface QuoteWindowOptions {
  /** Index of the topmost row currently on screen (pre-quantization). */
  anchorIndex: number;
  cap?: number;
  lookBack?: number;
  step?: number;
}

/**
 * Unique, uppercased symbols for the rows around `anchorIndex`, capped.
 *
 * `rowSymbols[i]` is the symbol list of rendered row `i` (already narrowed by
 * whatever chip cap the row applies, since a chip that is never painted is not
 * worth a quote).
 *
 * When the window runs off the end of the list before the cap is spent, the
 * remainder is spent BACKWARD from the start of the window rather than wrapping
 * to row 0: at the bottom of a long feed the useful rows are the ones just
 * above, not the ones 140 rows away.
 */
export function quoteWindowSymbols(
  rowSymbols: readonly (readonly string[])[],
  options: QuoteWindowOptions,
): string[] {
  const cap = options.cap ?? MAX_QUOTE_SYMBOLS;
  if (cap <= 0 || rowSymbols.length === 0) return [];
  const lookBack = options.lookBack ?? QUOTE_WINDOW_LOOKBACK;
  const anchor = quantizeFeedAnchor(options.anchorIndex, options.step);
  const start = Math.max(0, Math.min(anchor, rowSymbols.length - 1) - lookBack);

  const seen = new Set<string>();
  const take = (row: readonly string[] | undefined) => {
    if (!row) return;
    for (const symbol of row) {
      if (seen.size >= cap) return;
      const normalized = symbol?.trim().toUpperCase();
      if (normalized) seen.add(normalized);
    }
  };

  for (let i = start; i < rowSymbols.length && seen.size < cap; i += 1) {
    take(rowSymbols[i]);
  }
  for (let i = start - 1; i >= 0 && seen.size < cap; i -= 1) {
    take(rowSymbols[i]);
  }

  return [...seen].slice(0, cap);
}
