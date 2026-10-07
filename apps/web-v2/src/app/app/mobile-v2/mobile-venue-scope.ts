/**
 * Where the mobile venue control belongs.
 *
 * The venue used to be a bar pinned between the app header and `main` on
 * every destination except Markets, which had already folded it into its own
 * control row. That cost 49px of permanent chrome on Trade, Traders, Account
 * and Search, and on three of those four the control changed nothing on
 * screen. This module states, as data, which mobile surfaces actually read
 * the venue, so the switch can be routed to those surfaces and hosted inside
 * a control row they already paint.
 *
 * The measurements behind the list (all below `xl`, mobile shell only):
 *
 *  - `chart` (Trade): the venue selects the charted market, the insight tabs,
 *    the ticket the pinned Long/Short pair opens, and the app-bar subtitle.
 *  - `markets`: `VenueAwareMarketsFilterSync` scopes Browse to the venue.
 *  - `traders`: the Following tab's copy feed is queried with the venue-driven
 *    `assetClass` filter (`VenueAwareCopyTradePanel` -> `marketFilter`).
 *  - `account`: nothing reads the venue. Positions and Orders render BOTH
 *    venues through `MobileVenueStack`, Closed is perps-only, Portfolio has
 *    its own Overview / Stocks / Perps navigation, and AI is account-level.
 *  - `search`: nothing reads the venue. The Browse surface inside Search owns
 *    its own All / Stocks / Perps filter, and picking a result flips the venue
 *    through `selectMarket` anyway.
 *
 * Nothing here renders. The screens own their own presentation, and the
 * controller owns the element; this is only the routing rule.
 */

import type { MobileScreen } from "@/components/layout/mobile-nav";
import type { MobileTradersTab } from "../mobile-shell";

/** Mobile destinations whose content changes with the traded venue. */
export const MOBILE_VENUE_SCOPED_SCREENS = [
  "chart",
  "markets",
  "traders",
] as const;

export type MobileVenueScopedScreen =
  (typeof MOBILE_VENUE_SCOPED_SCREENS)[number];

/**
 * Traders tabs whose content changes with the traded venue.
 *
 * Only Following: its copy feed is queried with the venue-derived asset-class
 * filter. The Feed tab carries an explicit All / Stocks / Perps scope of its
 * own that deliberately does not touch the shared venue, the two leaderboards
 * rank people rather than markets, and the Watchlist lists both venues at
 * once and uses the venue for nothing but which row reads as selected.
 */
export const MOBILE_VENUE_SCOPED_TRADERS_TABS = ["following"] as const;

export type MobileVenueScopedTradersTab =
  (typeof MOBILE_VENUE_SCOPED_TRADERS_TABS)[number];

/** Whether a mobile destination reads the traded venue. */
export function isMobileVenueScopedScreen(
  screen: MobileScreen,
): screen is MobileVenueScopedScreen {
  return (MOBILE_VENUE_SCOPED_SCREENS as readonly string[]).includes(screen);
}

/** Whether a Traders tab reads the traded venue. */
export function isMobileVenueScopedTradersTab(
  tab: MobileTradersTab,
): tab is MobileVenueScopedTradersTab {
  return (MOBILE_VENUE_SCOPED_TRADERS_TABS as readonly string[]).includes(tab);
}

/**
 * Whether a destination should be handed the venue switch.
 *
 * `perpsEnabled` is the build-time deployment capability. With perps unwired
 * there is no second venue to switch to, so no destination hosts the control
 * and no screen pays a row (or a cell) for it.
 */
export function mobileScreenHostsVenueSwitch(
  screen: MobileScreen,
  perpsEnabled: boolean,
): boolean {
  return perpsEnabled && isMobileVenueScopedScreen(screen);
}
