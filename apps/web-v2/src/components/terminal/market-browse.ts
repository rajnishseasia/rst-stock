/**
 * Pure logic behind the mobile market BROWSE surface (plan A5 / A6).
 *
 * The desktop search is a dropdown: one row per symbol, with a venue chip per
 * venue on a dual-listed row. On a phone that chip is an ~18px tap target and,
 * because `resolveEnterSelection` returns "ambiguous" for a dual-listed symbol
 * under filter "all", it is also the ONLY control that can commit that symbol,
 * so there is no keyboard or assistive path to it at all (plan A6).
 *
 * The browse surface fixes both by flattening: one row per (symbol, venue), so
 * `AAPL` listed on both venues renders as two full-width rows instead of one
 * row plus two chips. Every row is its own button, in tab order, at a real
 * touch size.
 *
 * Nothing here changes what is SENT anywhere: a row still commits exactly the
 * `{ symbol, venue }` the dropdown's chip would have committed, with the
 * canonical symbol the unified search returned.
 */

import { MAX_QUOTE_SYMBOLS } from "@/components/feed/feed-quote-window";
import type {
  MarketSearchItem,
  MarketSelection,
  MarketVenue,
} from "@/lib/market-selection";

/**
 * Per-symbol character cap in `quotes.getChartQuotes` (`.max(10)`). Zod
 * validates the whole array, so ONE over-long symbol fails the entire batch and
 * blanks every price on the screen. Over-long symbols are dropped from the
 * batch instead; their row simply renders without a price.
 */
export const MAX_QUOTE_SYMBOL_LENGTH = 10;

/**
 * Rows the search asks `markets.search` for. Above the 8-row dropdown default
 * because this is a full-height browse list, and well under the router's
 * `SEARCH_LIMIT_MAX` of 25 and the 30-symbol quote cap.
 */
export const MOBILE_BROWSE_SEARCH_LIMIT = 16;

/** One venue-specific browse row. `symbol` stays canonical (HL casing intact). */
export interface MarketBrowseRow {
  /** Stable React key: venue-qualified, since a symbol can appear on both. */
  key: string;
  symbol: string;
  venue: MarketVenue;
  /** Company / instrument name. Empty for perp-only coins (no issuer name). */
  name: string;
}

/** Browse results split into the two venue groups, in display order. */
export interface MarketBrowseGroups {
  stocks: MarketBrowseRow[];
  perps: MarketBrowseRow[];
}

/** A venue-qualified identity for a pick. */
export function marketSelectionKey(selection: MarketSelection): string {
  return `${selection.venue}:${selection.symbol}`;
}

/**
 * Flatten unified search results into one row per (symbol, venue), grouped by
 * venue and preserving the search's ranking within each group.
 *
 * With perps disabled, perp rows are dropped entirely: same defense-in-depth
 * rule as `visibleMarketSuggestions`, so a stale or racey response can never
 * put a selectable perp row on a screen whose venue switch is hidden.
 */
export function groupMarketSuggestions(
  items: readonly MarketSearchItem[],
  perpsEnabled: boolean,
): MarketBrowseGroups {
  const groups: MarketBrowseGroups = { stocks: [], perps: [] };
  for (const item of items) {
    const symbol = item.symbol?.trim();
    if (!symbol) continue;
    for (const venue of item.venues) {
      if (venue === "perps" && !perpsEnabled) continue;
      if (venue !== "stocks" && venue !== "perps") continue;
      const row: MarketBrowseRow = {
        key: `${venue}:${symbol}`,
        symbol,
        venue,
        name: item.name ?? "",
      };
      if (groups[venue].some((existing) => existing.key === row.key)) continue;
      groups[venue].push(row);
    }
  }
  return groups;
}

/**
 * The stock symbols to price in one `quotes.getChartQuotes` batch: unique,
 * uppercased, length-filtered and hard-capped.
 *
 * The cap is the router's own `.max(30)` (mirrored by `MAX_QUOTE_SYMBOLS`), not
 * a new budget: a browse screen must never turn into an unbounded fan-out of
 * broker snapshot calls.
 */
export function browseQuoteSymbols(
  rows: readonly MarketBrowseRow[],
  cap: number = MAX_QUOTE_SYMBOLS,
): string[] {
  if (cap <= 0) return [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= cap) break;
    if (row.venue !== "stocks") continue;
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol || symbol.length > MAX_QUOTE_SYMBOL_LENGTH) continue;
    seen.add(symbol);
  }
  return [...seen].slice(0, cap);
}

/** A commit already made by a pointer interaction, for the click de-duplicator. */
export interface PointerCommit {
  key: string;
  at: number;
}

/**
 * How long after a pointer commit an identical click is treated as the same
 * interaction. A mouse click is `mousedown` THEN `click`, and `preventDefault()`
 * on mousedown suppresses focus, not the click.
 */
export const POINTER_COMMIT_WINDOW_MS = 700;

/**
 * Whether a `click` should commit, given the last pointer commit.
 *
 * The dropdown commits on `mousedown` so the pick lands before the input's blur
 * closes the list. That leaves keyboard and assistive activation, which emit a
 * `click` and no `mousedown`, with no way to commit at all (plan A6). Pairing
 * an `onClick` fixes that but double-commits every mouse click, so the click is
 * suppressed only when the SAME selection was just committed by a pointer.
 *
 * Deliberately biased toward committing: an unrecognized activation path
 * commits twice (harmless, selection is idempotent) rather than not at all.
 */
export function shouldCommitOnClick(
  last: PointerCommit | null | undefined,
  key: string,
  now: number,
  windowMs: number = POINTER_COMMIT_WINDOW_MS,
): boolean {
  if (!last || last.key !== key) return true;
  const elapsed = now - last.at;
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  return elapsed > windowMs;
}

/**
 * Which background queries a browse tab actually needs.
 *
 * The browse component stays MOUNTED across tab changes, so a query left
 * enabled keeps polling for a surface the user cannot see (audit M3: nothing
 * queries for a surface that is not on screen). That is invisible in review,
 * which is why the rule lives here as a value instead of inline in three
 * `enabled:` expressions.
 */
export interface BrowseQueryNeeds {
  /** Hyperliquid market stats: the perp rows' price and 24h change. */
  perpStats: boolean;
  /** Market rankings, which back the empty-query discovery state only. */
  marketPulse: boolean;
}

export function browseQueryNeeds({
  isSignedIn,
  perpsCompiledIn,
  showPeople,
  showsPerpRows,
  hasQuery,
}: {
  isSignedIn: boolean;
  /** The build-time perps flag. */
  perpsCompiledIn: boolean;
  /** The People tab is selected, so no market rows are rendered at all. */
  showPeople: boolean;
  /**
   * The active filter actually renders perp rows (All or Perps).
   *
   * `showPeople` alone was not enough: a user browsing the STOCKS tab renders no
   * perp rows either, yet kept polling Hyperliquid market stats every 30s for
   * the whole time they were there.
   */
  showsPerpRows: boolean;
  /** The user has typed something, so results replace the discovery state. */
  hasQuery: boolean;
}): BrowseQueryNeeds {
  if (!isSignedIn || showPeople) {
    return { perpStats: false, marketPulse: false };
  }
  return {
    perpStats: perpsCompiledIn && showsPerpRows,
    // Rankings back the empty-query browse state only, so typing must not keep
    // a discovery query alive behind the results.
    marketPulse: !hasQuery,
  };
}
