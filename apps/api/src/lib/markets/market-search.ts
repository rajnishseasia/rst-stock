/**
 * Unified market search + venue resolution (pure, no network / no tRPC).
 *
 * Backs the `markets.search` procedure and the "which venues list this symbol"
 * checks. A symbol can be tradable as an equity (Alpaca), a perp (Hyperliquid),
 * or BOTH. The merge collapses a both-venue symbol into ONE result whose
 * `venues` array carries both tags, so the UI can render a single row with a
 * "Stock" and a "Perp" chip instead of two duplicate rows.
 *
 * Everything here is pure and exported so it can be unit-tested against
 * hand-built catalogs with no live Alpaca/HL client.
 */

export type MarketVenue = "stocks" | "perps";

/** Canonical order used when serializing a symbol's venue set. */
const VENUE_ORDER: readonly MarketVenue[] = ["stocks", "perps"];

/** Minimal equity catalog entry (a subset of Alpaca `/v2/assets`). */
export interface EquityCatalogEntry {
  symbol: string;
  name: string;
  exchange?: string;
  tradable?: boolean;
}

/** Minimal Hyperliquid universe entry (a subset of `getUniverse()`). */
export interface HlUniverseEntry {
  coin: string;
  isDelisted?: boolean;
}

/** One unified, venue-tagged search result. */
export interface MarketSearchItem {
  /** Display ticker (equity symbol when present, else the HL coin spelling). */
  symbol: string;
  /** Company / instrument name. Empty for perp-only coins (no issuer name). */
  name: string;
  /** Venues that list this symbol, in canonical order (stocks before perps). */
  venues: MarketVenue[];
}

/**
 * Which venues list `symbol` (case-insensitive), given cached catalogs. Returns
 * the venues in canonical order: `[]` (neither), `["stocks"]`, `["perps"]`, or
 * `["stocks", "perps"]`. A DELISTED HL asset does NOT count as a perp venue.
 *
 * This is the single source of truth for both search tagging and the
 * "wrong venue" states in the terminal.
 */
export function resolveSymbolVenues(
  symbol: string,
  sources: {
    equityCatalog: ReadonlyArray<EquityCatalogEntry>;
    hlUniverse: ReadonlyArray<HlUniverseEntry>;
  },
): MarketVenue[] {
  const target = symbol.trim().toUpperCase();
  if (target === "") return [];

  const venues: MarketVenue[] = [];
  const onStocks = sources.equityCatalog.some(
    (entry) => entry.symbol.trim().toUpperCase() === target,
  );
  if (onStocks) venues.push("stocks");

  const onPerps = sources.hlUniverse.some(
    (asset) => asset.coin.trim().toUpperCase() === target && !asset.isDelisted,
  );
  if (onPerps) venues.push("perps");

  return venues;
}

/**
 * Rank one catalog entry against a needle. Lower is a stronger match; `-1` means
 * no match. Mirrors the tiered ranking the watchlist symbol search has always
 * used (exact symbol, symbol prefix, name word-prefix, name substring) so the
 * unified search stays consistent with it.
 */
function rankMatch(
  entry: { symbol: string; name?: string },
  needleUpper: string,
  needleLower: string,
): number {
  const sym = entry.symbol.toUpperCase();
  const nameLower = (entry.name ?? "").toLowerCase();

  if (sym === needleUpper) return 0;
  if (sym.startsWith(needleUpper)) return 1;
  if (nameLower.startsWith(needleLower)) return 2;
  // Word-prefix on name: "appl" matches "Apple Inc" but not "Snapple Inc".
  if (nameLower.includes(` ${needleLower}`)) return 3;
  if (nameLower.includes(needleLower)) return 4;
  return -1;
}

/**
 * Prefix/substring search + ranking over an equity catalog. Extracted so both
 * the equity-only `symbols.search` and the unified `markets.search` rank the
 * same way. Generic over the entry so callers keep their full row shape.
 */
export function rankEquityMatches<T extends { symbol: string; name: string }>(
  query: string,
  catalog: ReadonlyArray<T>,
  limit: number,
): T[] {
  const q = query.trim();
  if (q.length === 0 || catalog.length === 0) return [];

  const needleUpper = q.toUpperCase();
  const needleLower = q.toLowerCase();

  const matches: Array<{ entry: T; rank: number }> = [];
  for (const entry of catalog) {
    const rank = rankMatch(entry, needleUpper, needleLower);
    if (rank < 0) continue;
    matches.push({ entry, rank });
    // Early exit once we have plenty of strong matches. Scanning a 10k+ symbol
    // catalog fully on every keystroke would be wasteful.
    if (matches.length > limit * 8) break;
  }

  matches.sort((a, b) => compareRanked(a.rank, a.entry.symbol, b.rank, b.entry.symbol));
  return matches.slice(0, limit).map((m) => m.entry);
}

/** Shared sort: rank, then shorter symbol, then lexicographic. */
function compareRanked(
  rankA: number,
  symbolA: string,
  rankB: number,
  symbolB: string,
): number {
  if (rankA !== rankB) return rankA - rankB;
  if (symbolA.length !== symbolB.length) return symbolA.length - symbolB.length;
  return symbolA.localeCompare(symbolB);
}

interface MergeArgs {
  query: string;
  equityCatalog: ReadonlyArray<EquityCatalogEntry>;
  hlUniverse: ReadonlyArray<HlUniverseEntry>;
  limit: number;
  /**
   * Optional venue filter. When set to a non-empty subset, only symbols listed
   * on at least one of those venues are returned. `undefined` / all venues
   * returns everything. A both-venue result keeps BOTH chips even under a
   * single-venue filter (the filter decides inclusion, not the tags shown).
   */
  venues?: ReadonlyArray<MarketVenue>;
}

interface MergeAccumulator {
  symbol: string;
  name: string;
  venues: Set<MarketVenue>;
  rank: number;
}

/**
 * Merge equity + perp matches for `query` into one venue-tagged, ranked list.
 * A symbol present on both venues collapses to a single item; equity metadata
 * (display symbol + name) wins for the shared row, and the perp side just adds
 * its venue tag.
 */
export function mergeMarketSearchResults(args: MergeArgs): MarketSearchItem[] {
  const q = args.query.trim();
  if (q.length === 0) return [];

  const needleUpper = q.toUpperCase();
  const needleLower = q.toLowerCase();
  const wanted = normalizeVenueFilter(args.venues);

  // Key by uppercased symbol so equity + perp entries for the same ticker merge.
  const byKey = new Map<string, MergeAccumulator>();

  const upsert = (
    key: string,
    rank: number,
    venue: MarketVenue,
    display: { symbol: string; name: string },
    preferDisplay: boolean,
  ) => {
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        symbol: display.symbol,
        name: display.name,
        venues: new Set([venue]),
        rank,
      });
      return;
    }
    existing.venues.add(venue);
    existing.rank = Math.min(existing.rank, rank);
    // Equity rows carry the human-readable name/casing, so let them win the
    // shared display fields even if the perp side was seen first.
    if (preferDisplay) {
      existing.symbol = display.symbol;
      existing.name = display.name;
    } else if (!existing.name && display.name) {
      existing.name = display.name;
    }
  };

  // Fetch a generous slice of each side before merging so the collapse + global
  // re-rank can still surface the strongest cross-venue matches within `limit`.
  const scan = Math.max(args.limit * 4, args.limit);

  for (const entry of rankEquityMatches(q, args.equityCatalog, scan)) {
    const rank = rankMatch(entry, needleUpper, needleLower);
    upsert(entry.symbol.toUpperCase(), rank, "stocks", {
      symbol: entry.symbol,
      name: entry.name,
    }, true);
  }

  for (const asset of args.hlUniverse) {
    if (asset.isDelisted) continue;
    const rank = rankMatch({ symbol: asset.coin }, needleUpper, needleLower);
    if (rank < 0) continue;
    upsert(asset.coin.toUpperCase(), rank, "perps", {
      symbol: asset.coin,
      name: "",
    }, false);
  }

  const items = [...byKey.values()]
    .filter((item) => venueMatchesFilter(item.venues, wanted))
    .sort((a, b) => compareRanked(a.rank, a.symbol, b.rank, b.symbol))
    .slice(0, args.limit)
    .map<MarketSearchItem>((item) => ({
      symbol: item.symbol,
      name: item.name,
      venues: VENUE_ORDER.filter((venue) => item.venues.has(venue)),
    }));

  return items;
}

/** Normalize a venue filter to a set, treating "both venues" as no filter. */
function normalizeVenueFilter(
  venues: ReadonlyArray<MarketVenue> | undefined,
): Set<MarketVenue> | null {
  if (!venues || venues.length === 0) return null;
  const set = new Set(venues);
  // Requesting every venue is the same as no filter.
  if (VENUE_ORDER.every((venue) => set.has(venue))) return null;
  return set;
}

function venueMatchesFilter(
  venues: Set<MarketVenue>,
  wanted: Set<MarketVenue> | null,
): boolean {
  if (!wanted) return true;
  for (const venue of venues) {
    if (wanted.has(venue)) return true;
  }
  return false;
}

/** One tradable perp coin tagged with whether the same ticker is also an equity. */
export interface PerpUniverseTag {
  coin: string;
  alsoEquity: boolean;
}

/** Hyperliquid namespaces HIP-3 markets with a DEX prefix (`xyz:NVDA`). */
function isExplicitPerpCoin(coin: string): boolean {
  const separator = coin.indexOf(":");
  return separator > 0 && separator < coin.length - 1;
}

/**
 * Tag each tradable perp coin with whether the SAME ticker is also an Alpaca
 * equity. Drives synchronous venue routing in the terminal: a coin that is not
 * also an equity is crypto-only and charts on perps, while a coin that IS also
 * an equity stays on stocks so a real equity is never hijacked into perps.
 *
 * Delisted coins are excluded (they are not chartable). Pure and exported so
 * the join and the equity-collision cases are unit-testable.
 *
 * The CALLER must reject an empty `equityCatalog` before calling: with no
 * equity symbols to join against, every coin comes back `alsoEquity: false`,
 * which would classify real collisions (SOL, APT) as crypto-only.
 */
export function tagPerpUniverseWithEquityOverlap(
  hlUniverse: readonly HlUniverseEntry[],
  equityCatalog: readonly EquityCatalogEntry[],
): PerpUniverseTag[] {
  const equitySymbols = new Set(
    equityCatalog.map((entry) => entry.symbol.trim().toUpperCase()),
  );
  return hlUniverse
    .filter((asset) => !asset.isDelisted)
    .map((asset) => ({
      coin: asset.coin,
      alsoEquity: equitySymbols.has(asset.coin.trim().toUpperCase()),
    }));
}

/**
 * Build the client-side routing index without letting an Alpaca catalog outage
 * disable explicitly venue-qualified HIP-3 markets. Bare coins still require
 * the equity join because names such as SOL and APT can collide with stocks;
 * `xyz:NVDA` cannot be an Alpaca ticker and is therefore safe to route as a
 * perp even when the equity catalog is unavailable.
 */
export function tagRoutablePerpUniverse(
  hlUniverse: readonly HlUniverseEntry[],
  equityCatalog: readonly EquityCatalogEntry[],
): PerpUniverseTag[] {
  if (equityCatalog.length > 0) {
    return tagPerpUniverseWithEquityOverlap(hlUniverse, equityCatalog);
  }

  return hlUniverse
    .filter((asset) => !asset.isDelisted && isExplicitPerpCoin(asset.coin))
    .map((asset) => ({ coin: asset.coin, alsoEquity: false }));
}
