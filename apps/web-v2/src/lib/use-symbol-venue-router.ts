"use client";

/**
 * Client hook that powers crypto-ticker venue routing in the terminal.
 *
 * It loads the perp universe ONCE (`markets.perpUniverse`, coin + equity-overlap
 * flag), builds a fast uppercased index, and returns a synchronous
 * `resolveRoute(symbol)`. Every stock-terminal entry point that used to force
 * `activeSymbol` (signal click, "Copy $TICKER" chip, watchlist select) funnels
 * its picked symbol through this so a crypto coin (HYPE, BTC) flips to the perps
 * venue instead of charting an empty stock.
 *
 * `perpsEnabled` is the deployment gate (`PERPS_ENABLED`): when perps aren't
 * wired up, a crypto coin resolves to "none" so the caller can show a "not
 * available as a stock" notice rather than silently flipping into a venue the
 * user has no control to leave.
 */

import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import { PERPS_ENABLED } from "@/lib/perps-config";
import type { MarketVenue } from "@/lib/market-selection";
import {
  buildPerpUniverseIndex,
  resolveVenueRoute,
  type VenueRouteResolution,
} from "@/lib/venue-routing";

export interface UseSymbolVenueRouterOptions {
  /** Only fetch the perp universe once the terminal has an authed session. */
  enabled?: boolean;
}

export interface SymbolVenueRouter {
  /**
   * Resolve a picked symbol to a concrete venue route. `currentVenue` defaults to
   * "stocks" (these entry points live on the stock terminal), so a both-venue
   * ticker stays on stocks. Unknown symbols are assumed to be equities (the
   * browser can't see the full Alpaca catalog), preserving the legacy behavior
   * for anything that isn't a known crypto coin.
   */
  resolveRoute: (symbol: string, currentVenue?: MarketVenue) => VenueRouteResolution;
  /** True once the perp universe has loaded (routing is precise from here on). */
  ready: boolean;
}

export function useSymbolVenueRouter(
  options: UseSymbolVenueRouterOptions = {},
): SymbolVenueRouter {
  const enabled = options.enabled ?? true;

  // The perp universe changes slowly (new listings / delistings). One fetch per
  // session is plenty, so keep it fresh for a long window and never poll.
  const universeQuery = trpc.markets.perpUniverse.useQuery(undefined, {
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });

  const index = useMemo(
    () => buildPerpUniverseIndex(universeQuery.data ?? []),
    [universeQuery.data],
  );

  return useMemo<SymbolVenueRouter>(
    () => ({
      ready: universeQuery.isSuccess,
      resolveRoute: (symbol, currentVenue = "stocks") =>
        resolveVenueRoute({
          symbol,
          index,
          perpsEnabled: PERPS_ENABLED,
          currentVenue,
          assumeEquityWhenUnknown: true,
        }),
    }),
    [index, universeQuery.isSuccess],
  );
}
