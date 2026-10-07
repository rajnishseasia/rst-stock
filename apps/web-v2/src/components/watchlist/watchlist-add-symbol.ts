/**
 * Watchlist "add symbol" resolution - pure helpers for turning the raw text a
 * user typed into the input into the exact symbol to submit.
 *
 * Stocks are trimmed and uppercased; the server validates tradability.
 *
 * Perps are matched case-insensitively against the live Hyperliquid universe
 * (`trpc.markets.perpUniverse`), so typing "eth" resolves to the market's
 * canonical "ETH" listing rather than being submitted verbatim. Kept
 * side-effect free so the matching logic can be unit tested independently of
 * the form and the tRPC query it reads from.
 */

import type { MarketVenue } from "@/lib/market-selection";

/** Trim, and uppercase only for stocks (perp tickers can be mixed-case, e.g. "xyz:GOOGL"). */
export function normalizeInputSymbol(value: string, venue: MarketVenue): string {
  const trimmed = value.trim();
  return venue === "stocks" ? trimmed.toUpperCase() : trimmed;
}

/** The subset of a Hyperliquid universe entry the match needs. */
export interface PerpMarketOption {
  coin: string;
}

/**
 * Resolves the watchlist "add" input to the symbol to submit.
 *
 * Stocks: the normalized (trimmed + uppercased) input, even if empty -
 * callers check for an empty result themselves.
 *
 * Perps: the canonical `coin` of the first listed market whose ticker matches
 * the input case-insensitively, or `undefined` when the venue is perps and no
 * currently listed market matches. Callers must not submit an unmatched perp
 * symbol - Hyperliquid's list changes over time, and submitting an unlisted
 * ticker verbatim would send an order the exchange doesn't recognize.
 */
export function resolveAddSymbol({
  input,
  venue,
  perpMarkets,
}: {
  input: string;
  venue: MarketVenue;
  perpMarkets: PerpMarketOption[] | undefined;
}): string | undefined {
  const normalized = normalizeInputSymbol(input, venue);
  if (venue === "stocks") return normalized;
  return perpMarkets?.find(
    (market) => market.coin.toUpperCase() === normalized.toUpperCase(),
  )?.coin;
}
