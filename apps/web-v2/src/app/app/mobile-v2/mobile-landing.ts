import type { MarketSelection, MarketVenue } from "@/lib/market-selection";

/**
 * What the mobile Trade home screen should show per venue on a cold open.
 *
 * Trade is the landing screen now, so it has to open on SOMETHING before the
 * user has tapped anything. The controller already persists two things that
 * decide it: the venue-tagged Recents list (`lib/recent-markets`, written on
 * every market pick) and the active venue (`lib/venue-storage`). This rule
 * turns the first into a symbol per venue slot; the persisted venue then
 * decides which slot is on screen. The venue is never flipped by a recent
 * pick: a user who last switched to stocks must not reopen on a perp.
 *
 * Pure, so the priority order is a test rather than a comment:
 *
 * 1. A market named in the URL wins for its venue (it is applied by the
 *    history codec, so that slot is left alone here).
 * 2. Otherwise the most recent pick on that venue.
 * 3. Otherwise nothing: the controller keeps its per-venue default (SPY, BTC).
 */
export type MobileLandingSlots = Partial<Record<MarketVenue, string>>;

export function mobileLandingSlots(
  recentMarkets: readonly MarketSelection[],
  urlMarket: MarketSelection | null,
): MobileLandingSlots {
  const slots: MobileLandingSlots = {};
  for (const market of recentMarkets) {
    if (urlMarket?.venue === market.venue) continue;
    if (slots[market.venue] !== undefined) continue;
    if (!market.symbol) continue;
    slots[market.venue] = market.symbol;
  }
  return slots;
}
