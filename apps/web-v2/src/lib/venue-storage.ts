/**
 * Venue persistence helpers.
 *
 * The active trading venue (stocks vs. perps) is persisted to `localStorage`
 * so a page reload restores the overlay the user was last in. Parsing/serializing
 * live here as pure functions (mirroring `parseTerminalLayout`/`serializeTerminalLayout`)
 * so they can be unit-tested without a DOM and reused by the provider's hydration
 * guard.
 */

export type Venue = "stocks" | "perps";
export type StoredMarketFilter = "all" | Venue;

export const VENUE_STORAGE_KEY = "ready-set-trade.venue.v1";
export const MARKET_FILTER_STORAGE_KEY = "ready-set-trade.market-filter.v1";

export const DEFAULT_VENUE: Venue = "stocks";

/** True for the two known venue string literals. */
export function isVenue(value: unknown): value is Venue {
  return value === "stocks" || value === "perps";
}

/**
 * Parse a persisted venue string. Unknown / malformed values fall back to the
 * default venue (stocks) so a corrupt key can never strand the user in perps.
 */
export function parseVenue(persisted: string | null | undefined): Venue {
  if (!persisted) return DEFAULT_VENUE;
  const trimmed = persisted.trim();
  return isVenue(trimmed) ? trimmed : DEFAULT_VENUE;
}

/** Serialize a venue for persistence. */
export function serializeVenue(venue: Venue): string {
  return venue;
}

/** Restore the top-level All / Stocks / Perps selection safely. */
export function parseMarketFilter(
  persisted: string | null | undefined,
): StoredMarketFilter {
  if (!persisted) return "all";
  const trimmed = persisted.trim();
  return trimmed === "all" || isVenue(trimmed) ? trimmed : "all";
}
