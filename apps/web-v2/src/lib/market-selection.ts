/**
 * Pure market-selection logic (no React, no tRPC).
 *
 * The terminal keeps two symbol slots: `activeSymbol` (stocks) and `activeCoin`
 * (perps). Picking a market from the unified search must set the RIGHT slot and
 * flip the venue in one action. This module is the single, unit-testable source
 * of truth for that transition and for the "bare symbol + Enter" resolution, so
 * both the venue context (`selectMarket`) and the search UI stay consistent.
 */

import type { Venue } from "@/lib/venue-storage";

/** A trading venue. Aliased so search/selection code reads clearly. */
export type MarketVenue = Venue;

/** Search-dropdown filter: "all" plus the two venues. */
export type MarketSearchFilter = "all" | MarketVenue;

/** One unified, venue-tagged search result (mirrors the `markets.search` row). */
export interface MarketSearchItem {
  symbol: string;
  name: string;
  venues: MarketVenue[];
}

/** A concrete market pick: a symbol on a specific venue. */
export interface MarketSelection {
  symbol: string;
  venue: MarketVenue;
}

/** Remove malformed or unavailable entries before restoring recent markets. */
export function sanitizeRecentMarketSelections(
  value: unknown,
  perpsEnabled: boolean,
  limit = 5,
): MarketSelection[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item): item is MarketSelection =>
        !!item &&
        typeof item.symbol === "string" &&
        (item.venue === "stocks" ||
          (item.venue === "perps" && perpsEnabled)),
    )
    .slice(0, limit);
}

/** Prevent disabled venues from being committed from stale UI state. */
export function canSelectMarket(
  selection: MarketSelection,
  perpsEnabled: boolean,
): boolean {
  return selection.venue !== "perps" || perpsEnabled;
}

/** Recent markets share the search controller's open/dismiss state. */
export function shouldShowRecentMarkets({
  requested,
  isOpen,
  hasQuery,
  count,
}: {
  requested: boolean;
  isOpen: boolean;
  hasQuery: boolean;
  count: number;
}): boolean {
  return requested && isOpen && !hasQuery && count > 0;
}

/**
 * The `venues` argument to send to the `markets.search` query, given the
 * dropdown filter and whether perps are wired up in this deployment.
 *
 * When perps are DISABLED (no Privy in this deployment) the search is hard
 * scoped to stocks so perp-only rows never come back at all: the venue switch
 * is hidden, so a perp pick would strand the user in a perps shell they have no
 * control to leave. When perps are enabled the dropdown filter drives it exactly
 * as before ("all" -> undefined -> both venues; a concrete venue -> just that
 * venue).
 *
 * Returns `undefined` (the "search every venue" signal) only when perps are
 * enabled and the filter is "all".
 */
export function searchVenuesFilter(
  filter: MarketSearchFilter,
  perpsEnabled: boolean,
): MarketVenue[] | undefined {
  if (!perpsEnabled) return ["stocks"];
  return filter === "all" ? undefined : [filter];
}

/**
 * Defense in depth on top of `searchVenuesFilter`: strip any venue the
 * deployment can't trade out of each search row, dropping rows that are left
 * with no tradable venue.
 *
 * With perps disabled this removes perp-only rows outright and collapses
 * both-venue rows down to their stocks entry, so a stale or racey
 * `markets.search` response can never put a selectable perp row on screen. When
 * perps are enabled every row passes through unchanged.
 */
export function visibleMarketSuggestions(
  items: readonly MarketSearchItem[],
  perpsEnabled: boolean,
): MarketSearchItem[] {
  if (perpsEnabled) return [...items];
  return items
    .map((item) => ({
      ...item,
      venues: item.venues.filter((venue) => venue !== "perps"),
    }))
    .filter((item) => item.venues.length > 0);
}

/** The terminal's combined symbol/venue state. */
export interface MarketSelectionState {
  activeSymbol: string;
  activeCoin: string;
  venue: MarketVenue;
}

/**
 * Venue-aware symbol normalization. Stock tickers are case-insensitive, so
 * they trim + uppercase. Hyperliquid coins are CANONICAL, case-sensitive
 * spellings (e.g. `kPEPE`, `kBONK`, `xyz:GOOGL`): uppercasing them ("KPEPE")
 * breaks downstream HL candle and order lookups, so perp symbols only trim
 * and keep the canonical casing the unified search returned.
 */
export function normalizeMarketSymbol(
  venue: MarketVenue,
  symbol: string,
): string {
  const trimmed = symbol.trim();
  return venue === "perps" ? trimmed : trimmed.toUpperCase();
}

/**
 * The symbol the active venue is currently displaying: the perp coin slot when
 * the venue is perps, the stock slot otherwise. Mobile and desktop chart/quote
 * surfaces share this routing so a perp pick never renders a stock chart.
 */
export function activeMarketSymbol(
  state: Pick<MarketSelectionState, "activeSymbol" | "activeCoin" | "venue">,
): string {
  return state.venue === "perps" ? state.activeCoin : state.activeSymbol;
}

/**
 * Which state slot a selection writes, plus the normalized symbol (venue-aware:
 * trimmed; uppercased only for stocks, see `normalizeMarketSymbol`). Used by
 * both `applyMarketSelection` and the context's `selectMarket` so the
 * "stocks → activeSymbol / perps → activeCoin" mapping lives in one place.
 */
export function marketSelectionTarget(selection: MarketSelection): {
  venue: MarketVenue;
  symbol: string;
  field: "activeSymbol" | "activeCoin";
} {
  const symbol = normalizeMarketSymbol(selection.venue, selection.symbol);
  return selection.venue === "perps"
    ? { venue: "perps", symbol, field: "activeCoin" }
    : { venue: "stocks", symbol, field: "activeSymbol" };
}

/**
 * Apply a market selection to the combined state: writes the correct symbol slot
 * and flips the venue, leaving the other slot untouched (so switching back and
 * forth restores the last symbol on each venue).
 */
export function applyMarketSelection(
  state: MarketSelectionState,
  selection: MarketSelection,
): MarketSelectionState {
  const target = marketSelectionTarget(selection);
  if (target.venue === "perps") {
    return { ...state, activeCoin: target.symbol, venue: "perps" };
  }
  return { ...state, activeSymbol: target.symbol, venue: "stocks" };
}

/** The outcome of pressing Enter on a bare typed symbol. */
export type EnterResolution =
  | { kind: "select"; venue: MarketVenue }
  | { kind: "ambiguous"; venues: MarketVenue[] }
  | { kind: "none" };

/**
 * Resolve a bare-symbol Enter against the venues that list it:
 *   - unique venue  → select it,
 *   - both venues   → ambiguous (let the user choose; never silently guess),
 *   - neither       → none ("not tradable").
 *
 * A concrete search filter counts as the user's explicit choice, so a
 * both-venue symbol resolves to the filtered venue instead of staying ambiguous.
 */
export function resolveEnterSelection(
  venues: readonly MarketVenue[],
  filter: MarketSearchFilter = "all",
): EnterResolution {
  if (venues.length === 0) return { kind: "none" };
  if (venues.length === 1) return { kind: "select", venue: venues[0]! };
  if (filter !== "all" && venues.includes(filter)) {
    return { kind: "select", venue: filter };
  }
  return { kind: "ambiguous", venues: [...venues] };
}

/** The outcome of submitting free-typed search text (mobile "Open" button). */
export type SubmitResolution =
  | { kind: "select"; selection: MarketSelection }
  | { kind: "ambiguous"; venues: MarketVenue[] }
  | { kind: "none" };

/**
 * Resolve free-typed search text against the current suggestions with the SAME
 * semantics as a bare-symbol Enter (`resolveEnterSelection`), so a form submit
 * can never bypass venue routing:
 *   - the suggestion whose symbol matches the text case-insensitively wins
 *     (search inputs uppercase as the user types, so "KPEPE" must resolve to
 *     the canonical "kPEPE"), falling back to the top suggestion exactly like
 *     Enter does with its default highlight,
 *   - a unique venue selects it (perp symbols keep HL canonical casing),
 *   - a both-venues symbol stays ambiguous unless a concrete filter picks one,
 *   - no matching suggestion means the text isn't tradable here.
 */
export function resolveSubmitSelection(
  text: string,
  suggestions: readonly MarketSearchItem[],
  filter: MarketSearchFilter = "all",
): SubmitResolution {
  const query = text.trim().toUpperCase();
  if (!query) return { kind: "none" };
  const match =
    suggestions.find((item) => item.symbol.toUpperCase() === query) ??
    suggestions[0];
  if (!match) return { kind: "none" };
  const resolution = resolveEnterSelection(match.venues, filter);
  if (resolution.kind === "select") {
    return {
      kind: "select",
      selection: { symbol: match.symbol, venue: resolution.venue },
    };
  }
  return resolution;
}

/**
 * Whether each venue is actually usable for the current user.
 *
 * `null` means NOT YET KNOWN, and is deliberately distinct from `false`. The
 * perps flag is derived from `hyperliquid.status`, which defaults to false
 * while loading and after a failure, so a user who HAS enabled perps was told
 * "Perps aren't enabled yet. Enable Perps in Settings" on every perp row until
 * the status resolved, and permanently through an outage: an instruction to go
 * do a thing they had already done.
 */
export interface VenueAvailability {
  /** Stocks are usable once an Alpaca broker account is connected. */
  stocks: boolean | null;
  /** Perps are usable once the HL wallet + agent are enabled. */
  perps: boolean | null;
}

/**
 * A short inline note when a chosen venue isn't usable for this user, or `null`
 * when it is. Drives the HL8 "wrong venue" messaging: an HL-only user picking a
 * stock, or a perps-not-enabled user picking a perp.
 */
export function wrongVenueNotice(
  venue: MarketVenue,
  availability: VenueAvailability,
): string | null {
  const usable = venue === "stocks" ? availability.stocks : availability.perps;
  // Unknown says nothing. Telling someone to enable a venue they may already
  // have enabled is worse than saying nothing for the moment it takes to find
  // out, and the notice reappears by itself once the answer arrives.
  if (usable === null) return null;
  if (usable) return null;
  return venue === "stocks"
    ? "Stock trading needs a connected Alpaca account. Add one in Settings."
    : "Perps aren't enabled yet. Enable Perps in Settings to trade this market.";
}
