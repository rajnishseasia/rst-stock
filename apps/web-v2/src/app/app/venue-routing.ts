/**
 * Pure venue-routing decisions shared by the desktop terminal's venue-aware
 * right-rail wrappers (positions, orders, portfolio).
 *
 * `isPerpsAccountActive` is the single boolean every one of those wrappers
 * branches on: perps content renders only when the traded venue AND the
 * resolved account context both agree it is perps. A stale/mismatched
 * `accountContext` (still resolving, or carrying the other venue's shape)
 * must fall through to the stocks surface, never show perps data next to an
 * Alpaca credential id, and never route a perps portfolio tab to Alpaca
 * history. Extracted (audit H7) so that property is checked directly against
 * the real function every wrapper calls, instead of by reading page.tsx.
 *
 * `stockMarketSelection` is the same kind of extraction for the copy-trade
 * paths: whatever venue the terminal is currently showing, copying an equity
 * signal or a Signa "Copy signal" row must always target the stocks venue
 * (never leave a prior perps pick in effect), on the normalized symbol.
 */

import type { AccountContext, PerpsAccountContext, Venue } from "@/lib/venue-context";
import {
  normalizeMarketSymbol,
  type MarketSelection,
} from "@/lib/market-selection";

/**
 * True only when both the active venue and its resolved account agree it's
 * perps. A type predicate (not just `boolean`) so call sites keep the same
 * `accountContext.walletAddress`/`.enabled` narrowing they had when this was
 * an inline `venue === "perps" && accountContext.venue === "perps"` check.
 */
export function isPerpsAccountActive(
  venue: Venue,
  accountContext: AccountContext,
): accountContext is PerpsAccountContext {
  return venue === "perps" && accountContext.venue === "perps";
}

/**
 * The market-selection command a stock copy action should issue: always
 * venue "stocks", regardless of the venue the terminal happened to be
 * showing when the copy fired. Returns null for a blank/whitespace symbol.
 */
export function stockMarketSelection(symbol: string): MarketSelection | null {
  const normalized = normalizeMarketSymbol("stocks", symbol);
  return normalized ? { symbol: normalized, venue: "stocks" } : null;
}
