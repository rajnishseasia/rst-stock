/**
 * The one-line market identity shown at the top of the mobile chart screen and,
 * since plan A1, at the top of the trade sheet: which market this is, what it
 * costs, and which way it moved today.
 *
 * Extracted from page.tsx because the same rules were written out twice, once
 * per surface, and because the only thing that used to assert them read page.tsx
 * as a string (audit H7). PURE: no React, no queries. Nothing here constructs,
 * validates or submits an order. It decides what a header SAYS.
 *
 * The venue split is the load-bearing part, and it is not cosmetic:
 *
 * - Hyperliquid namespaces its stock-backed perps, so the canonical coin is
 *   literally "xyz:GOOGL". `perpDisplayCoin` reduces that to "GOOGL" for
 *   display, which is also a real Alpaca ticker. After that reduction the two
 *   venues' headers are character-identical, so the perp tag is the only thing
 *   left telling a leveraged perp apart from 100 shares of the same name.
 * - Prices come from different formatters on purpose (CLAUDE.md audit M16).
 *   Equities go through the shared `formatCompactUsd` / `formatSignedNumber`;
 *   perps arrive pre-formatted by `formatPerpQuote`, whose precision scales with
 *   magnitude because a 1000x coin priced in fractions of a cent renders as
 *   "$0.00" under the fixed 2-decimal helpers.
 */

import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";
import { formatCompactUsd, formatSignedNumber } from "@/lib/format";
import type { PerpHeaderQuote } from "@/components/perps/perp-format";

/** Direction tone for the price line. Shared spelling with `PerpQuoteTone`. */
export type MobileQuoteTone = "positive" | "negative" | "neutral";

/** The equity quote fields the header reads (trpc `quotes.getChartQuote`). */
export interface MobileStockQuote {
  last?: string | null;
  changePercent?: string | null;
}

/**
 * Tone for an equity quote.
 *
 * A missing, unparseable or exactly-zero change is neutral, never "positive".
 * Green on an unknown value reads as a gain that did not happen.
 */
export function getMobileQuoteTone(
  changePercent: string | number | null | undefined,
): MobileQuoteTone {
  const change = Number(changePercent ?? 0);
  if (!Number.isFinite(change) || change === 0) return "neutral";
  return change > 0 ? "positive" : "negative";
}

export interface MobileMarketHeader {
  /** Display spelling of the market, perp namespace already stripped. */
  symbol: string;
  /** Whether to render the Perp tag. True exactly when the venue is perps. */
  showPerpTag: boolean;
  /** "price · change", already formatted by the venue's own formatter. */
  quoteLine: string;
  tone: MobileQuoteTone;
}

/**
 * Describe the market header for whichever venue is active.
 *
 * `marketSymbol` is the venue-active market (`activeMarketSymbol`): the perp
 * coin on the perps venue, the stock symbol otherwise. Both quotes are passed in
 * regardless of venue because both subscriptions live on the shell; only the
 * active venue's is read, so a stale quote from the other venue can never reach
 * the line.
 */
export function describeMobileMarketHeader({
  marketSymbol,
  isPerps,
  perpQuote,
  stockQuote,
}: {
  marketSymbol: string | null | undefined;
  isPerps: boolean;
  perpQuote: Pick<PerpHeaderQuote, "price" | "dayChange" | "dayChangeTone">;
  stockQuote: MobileStockQuote | null | undefined;
}): MobileMarketHeader {
  const symbol = perpDisplayCoin(marketSymbol ?? "");
  if (isPerps) {
    return {
      symbol,
      showPerpTag: true,
      quoteLine: `${perpQuote.price} · ${perpQuote.dayChange}`,
      tone: perpQuote.dayChangeTone,
    };
  }
  return {
    symbol,
    showPerpTag: false,
    quoteLine: `${formatCompactUsd(stockQuote?.last)} · ${formatSignedNumber(stockQuote?.changePercent, "%")}`,
    tone: getMobileQuoteTone(stockQuote?.changePercent),
  };
}
