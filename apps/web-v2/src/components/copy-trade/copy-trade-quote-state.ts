import {
  getQuoteFreshness,
  type QuoteFreshnessState,
} from "@/lib/quote-freshness";

/** Keep manual Copy aligned with the established trading-surface policy. */
export const COPY_TRADE_QUOTE_STALE_AFTER_MS = 90_000;

export interface CopyTradeQuoteReadiness {
  copyBlocked: boolean;
  copyBlockedReason: string | null;
  freshness: QuoteFreshnessState;
}

/**
 * Convert a TanStack quote snapshot into an order-sizing decision. Cached data
 * may remain present after a failed refetch, so query error and data age are
 * checked independently of whether a price object exists.
 */
export function getCopyTradeQuoteReadiness({
  hasQuote,
  updatedAt,
  now = Date.now(),
  isFetching = false,
  hasError = false,
  clockRejected = false,
}: {
  hasQuote: boolean;
  updatedAt?: number;
  now?: number;
  isFetching?: boolean;
  hasError?: boolean;
  clockRejected?: boolean;
}): CopyTradeQuoteReadiness {
  const invalidClock = clockRejected || (updatedAt !== undefined && updatedAt > now);
  const freshness = getQuoteFreshness({
    updatedAt,
    now,
    isFetching,
    hasError: hasError || invalidClock,
    staleAfterMs: COPY_TRADE_QUOTE_STALE_AFTER_MS,
  });

  let copyBlockedReason: string | null = null;
  if (hasError) {
    copyBlockedReason = "Current quote refresh failed. Refresh before copying.";
  } else if (!hasQuote) {
    copyBlockedReason = "Current quote is unavailable. Refresh before copying.";
  } else if (!Number.isFinite(updatedAt) || (updatedAt ?? 0) <= 0) {
    copyBlockedReason = "Current quote timestamp is unavailable. Refresh before copying.";
  } else if (invalidClock) {
    copyBlockedReason = "Current quote timestamp is ahead of the clock. Refresh before copying.";
  } else if (freshness.isStale) {
    copyBlockedReason = "Current quote is stale. Refresh before copying.";
  }

  return {
    copyBlocked: copyBlockedReason !== null,
    copyBlockedReason,
    freshness,
  };
}
