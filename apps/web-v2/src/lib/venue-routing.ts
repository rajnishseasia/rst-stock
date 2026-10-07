/**
 * Venue routing for picked tickers (pure, no React / no tRPC).
 *
 * The stock terminal used to funnel EVERY picked symbol into `activeSymbol`,
 * which forced the stocks venue. A crypto ticker (HYPE, BTC) has no Alpaca
 * equity datafeed, so that produced an EMPTY chart. This module is the single,
 * unit-testable decision for "given where a symbol actually lists + whether
 * perps are wired up in this deployment, which venue should it chart/trade on".
 *
 * It pairs with `market-selection.ts` (which owns the stocks->activeSymbol /
 * perps->activeCoin slot mapping): first decide the venue here, then commit the
 * slot there via `selectMarket`.
 */

import type { MarketVenue } from "@/lib/market-selection";

/** A concrete venue to route to, or "none" when the symbol isn't chartable here. */
export type VenueRouteTarget = MarketVenue | "none";

/** Where a symbol lists: as an Alpaca equity, as a Hyperliquid perp, or both. */
export interface VenueMembership {
  /** True when the ticker exists in the Alpaca equity catalog. */
  onEquityCatalog: boolean;
  /** True when the ticker exists (non-delisted) in the Hyperliquid perp universe. */
  onHlUniverse: boolean;
}

/**
 * Decide which venue a picked symbol should route to.
 *
 * - crypto / perp-only (HL universe, not an equity): route to perps when perps
 *   are enabled for this deployment, else "none" (the caller surfaces a "not
 *   available as a stock" notice instead of a blank chart).
 * - equity-only: stocks (unchanged legacy behavior).
 * - both venues: never hijack a normal equity, so stay on stocks unless the user
 *   is ALREADY trading perps (and perps are enabled), in which case keep perps.
 * - neither venue: "none" (no datafeed anywhere; the caller surfaces a notice).
 */
export function routeSymbolVenue(input: {
  membership: VenueMembership;
  perpsEnabled: boolean;
  currentVenue: MarketVenue;
}): VenueRouteTarget {
  const { onEquityCatalog, onHlUniverse } = input.membership;

  if (onHlUniverse && !onEquityCatalog) {
    return input.perpsEnabled ? "perps" : "none";
  }
  if (onEquityCatalog && !onHlUniverse) {
    return "stocks";
  }
  if (onEquityCatalog && onHlUniverse) {
    return input.currentVenue === "perps" && input.perpsEnabled ? "perps" : "stocks";
  }
  return "none";
}

/**
 * One entry of the tradable perp universe, tagged with whether the SAME ticker
 * is also an Alpaca equity. This is exactly what the `markets.perpUniverse`
 * procedure returns; the server owns the catalog join because the browser never
 * ships the full equity catalog.
 */
export interface PerpUniverseEntry {
  /** Canonical Hyperliquid coin spelling (case-sensitive, e.g. `kPEPE`). */
  coin: string;
  /** True when this coin's ticker is also listed as an Alpaca equity. */
  alsoEquity: boolean;
}

/**
 * A click-time lookup keyed by UPPERCASED coin (tickers are picked
 * case-insensitively) whose value keeps the canonical HL spelling to feed
 * `selectMarket`, plus the equity-overlap flag.
 */
export type PerpUniverseIndex = Map<string, PerpUniverseEntry>;

/** Build the click-time index from the `markets.perpUniverse` rows. */
export function buildPerpUniverseIndex(
  entries: readonly PerpUniverseEntry[],
): PerpUniverseIndex {
  const index: PerpUniverseIndex = new Map();
  for (const entry of entries) {
    const key = entry.coin.trim().toUpperCase();
    if (key) index.set(key, entry);
  }
  return index;
}

/** The outcome of routing a picked symbol: the venue plus the coin to commit. */
export interface VenueRouteResolution {
  target: VenueRouteTarget;
  /**
   * The canonical HL coin to hand to `selectMarket` when `target === "perps"`,
   * else null. Carries HL's exact casing (kPEPE, not KPEPE) so downstream candle
   * and order lookups resolve.
   */
  canonicalPerpSymbol: string | null;
}

/**
 * Resolve a picked symbol against the perp-universe index into a concrete route.
 *
 * A symbol IN the index carries its precise equity-overlap flag. A symbol NOT in
 * the index is, by definition, not a perp; whether it is a real equity can't be
 * known in the browser (the full Alpaca catalog isn't shipped), so callers on an
 * equity surface pass `assumeEquityWhenUnknown: true` to keep the legacy "chart
 * it as a stock" behavior for anything that isn't a known crypto coin.
 */
export function resolveVenueRoute(input: {
  symbol: string;
  index: PerpUniverseIndex;
  perpsEnabled: boolean;
  currentVenue: MarketVenue;
  assumeEquityWhenUnknown: boolean;
}): VenueRouteResolution {
  const key = input.symbol.trim().toUpperCase();
  if (key === "") return { target: "none", canonicalPerpSymbol: null };

  const hit = input.index.get(key);
  const membership: VenueMembership = hit
    ? { onEquityCatalog: hit.alsoEquity, onHlUniverse: true }
    : { onEquityCatalog: input.assumeEquityWhenUnknown, onHlUniverse: false };

  const target = routeSymbolVenue({
    membership,
    perpsEnabled: input.perpsEnabled,
    currentVenue: input.currentVenue,
  });

  return {
    target,
    canonicalPerpSymbol: target === "perps" && hit ? hit.coin : null,
  };
}
