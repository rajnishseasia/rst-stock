/**
 * Venue-tagged recent markets, persisted to localStorage.
 *
 * Extracted from `TerminalMarketSearch`, which owned the only copy of this
 * logic inline. Plan A5 gives the mobile Search screen a default browse state
 * whose first section is Recents, and a recents list that only the DESKTOP
 * search ever writes would be permanently empty for a phone-only user. One
 * module, one storage key, both call sites.
 *
 * Pure apart from the injected store, so the ordering and de-duplication rules
 * are testable without a DOM (audit H7: behavior tests, not source-string
 * tests).
 */

import {
  canSelectMarket,
  sanitizeRecentMarketSelections,
  type MarketSelection,
} from "@/lib/market-selection";

export const RECENT_MARKETS_STORAGE_KEY = "ready-set-trade.recent-markets.v1";

/** How many recent markets are kept. Short on purpose: this is a shortcut row. */
export const MAX_RECENT_MARKETS = 5;

/**
 * The slice of the `Storage` API this module needs. Narrow so tests can pass a
 * plain object and so a throwing store (Safari private mode, quota) is a
 * contained failure rather than a crashed render.
 */
export interface RecentMarketsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A stable identity for a market pick: the same symbol on two venues is two. */
export function recentMarketKey(selection: MarketSelection): string {
  return `${selection.venue}:${selection.symbol}`;
}

/**
 * Read + sanitize the stored list. Malformed entries and perp picks made in a
 * deployment that no longer has perps are dropped rather than rendered as
 * unusable rows.
 */
export function readRecentMarkets(
  store: RecentMarketsStore | null | undefined,
  perpsEnabled: boolean,
  limit = MAX_RECENT_MARKETS,
): MarketSelection[] {
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_MARKETS_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeRecentMarketSelections(JSON.parse(raw), perpsEnabled, limit);
  } catch {
    return [];
  }
}

/**
 * Most-recent-first list with `selection` promoted to the front, de-duplicated
 * on symbol AND venue (picking the AAPL perp must not evict the AAPL stock),
 * then truncated.
 */
export function addRecentMarket(
  current: readonly MarketSelection[],
  selection: MarketSelection,
  limit = MAX_RECENT_MARKETS,
): MarketSelection[] {
  const key = recentMarketKey(selection);
  return [
    selection,
    ...current.filter((item) => recentMarketKey(item) !== key),
  ].slice(0, limit);
}

/** Persist a list, swallowing storage failures (a full quota is not fatal). */
export function writeRecentMarkets(
  store: RecentMarketsStore | null | undefined,
  markets: readonly MarketSelection[],
): void {
  if (!store) return;
  try {
    store.setItem(RECENT_MARKETS_STORAGE_KEY, JSON.stringify(markets));
  } catch {
    // Recents are a convenience; never let persistence break a market pick.
  }
}

/**
 * Read, promote, write. Returns the new list so a caller holding React state
 * can use it directly.
 *
 * A selection whose venue this deployment cannot trade is ignored outright, so
 * a stale UI can never write a perp into the recents of a perps-off build.
 */
export function rememberRecentMarket(
  store: RecentMarketsStore | null | undefined,
  selection: MarketSelection,
  perpsEnabled: boolean,
  limit = MAX_RECENT_MARKETS,
): MarketSelection[] {
  const current = readRecentMarkets(store, perpsEnabled, limit);
  if (!canSelectMarket(selection, perpsEnabled)) return current;
  const next = addRecentMarket(current, selection, limit);
  writeRecentMarkets(store, next);
  return next;
}

/** The browser store, or null during SSR / when storage is blocked. */
export function browserRecentMarketsStore(): RecentMarketsStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
