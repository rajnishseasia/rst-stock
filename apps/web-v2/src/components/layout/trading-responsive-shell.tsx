"use client";

import { useRef, type ReactNode } from "react";
import { useMarketSearch } from "@/components/terminal/terminal-market-search";
import { formatPerpQuote } from "@/components/perps/perp-format";
import { getQuoteFreshness } from "@/lib/quote-freshness";
import { trpc } from "@/lib/trpc";
import { useVenue } from "@/lib/venue-context";
import {
  activeMarketSymbol,
  resolveEnterSelection,
  type MarketSearchFilter,
  type MarketSearchItem,
  type MarketSelection,
  type VenueAvailability,
} from "@/lib/market-selection";
import {
  ResponsiveShell,
  type ResponsiveShellMode,
} from "@/components/layout/responsive-shell";

export type MobileSubscriptionInput = {
  activeSymbol: string;
  /**
   * Canonical HL coin for the perps venue (casing preserved, e.g. "kPEPE").
   * Optional so stock-only callers/tests stay unchanged; defaults to "".
   */
  activeCoin?: string;
  searchValue: string;
  /** Legacy stock-only pick (kept for compatibility; unused by the search). */
  onPickSymbol: (symbol: string) => void;
  /**
   * Navigation-only side effect after a venue-aware market pick (remember +
   * open the mobile chart). Symbol slot + venue are set by `selectMarket`.
   */
  onSelectMarket?: (selection: MarketSelection) => void;
  /** Whether each venue is usable (drives wrong-venue notes in the dropdown). */
  availability?: VenueAvailability;
  /**
   * Search scope for the mobile Search screen. Overrides the venue context's
   * global `searchFilter` when supplied.
   *
   * The venue switch's filter also flips the TRADED venue (`venue-switch.tsx`),
   * and the mobile chart resolves its symbol from the venue, so narrowing a
   * search through it moved the chart off whatever the user was looking at.
   * The browse surface owns its own scope instead; the venue switch keeps
   * switching venues, from the screens that actually read one.
   */
  searchFilter?: MarketSearchFilter;
  /** Rows requested from `markets.search`. Defaults to the dropdown's 8. */
  searchLimit?: number;
  /**
   * Stop searching markets entirely, for a screen that keeps this mounted while
   * showing something else. The People tab is the case: it kept feeding CALLER
   * names to `markets.search` on every debounced keystroke, and the resulting
   * suggestions could then be resolved by the submit handler, so typing a caller
   * whose name contains a company word and pressing Enter opened that market.
   */
  searchDisabled?: boolean;
};

const DEFAULT_AVAILABILITY: VenueAvailability = { stocks: false, perps: false };

export function useMobileShellSubscriptions({
  activeSymbol,
  activeCoin = "",
  searchValue,
  onSelectMarket,
  availability = DEFAULT_AVAILABILITY,
  searchFilter: searchFilterOverride,
  searchLimit,
  searchDisabled = false,
}: MobileSubscriptionInput) {
  const { selectMarket, searchFilter: venueSearchFilter, venue } = useVenue();
  const searchFilter = searchFilterOverride ?? venueSearchFilter;
  const isPerps = venue === "perps";
  // The symbol the active venue is displaying (perp coin slot vs stock slot),
  // mirroring the desktop VenueAwareChartPanel routing.
  const marketSymbol = activeMarketSymbol({ activeSymbol, activeCoin, venue });
  const activeQuoteQuery = trpc.quotes.getChartQuote.useQuery(
    { symbol: activeSymbol },
    {
      enabled: !!activeSymbol && !isPerps,
      refetchInterval: 15_000,
      staleTime: 10_000,
      retry: false,
    },
  );
  // Perps venue: HL market snapshot (mark / prevDay / bid-ask) on the faster
  // 24/7 crypto cadence, mirroring the desktop chart panel's perp header strip.
  const perpSnapshotQuery = trpc.hyperliquid.assetSnapshot.useQuery(
    { coin: activeCoin },
    {
      enabled: !!activeCoin && isPerps,
      refetchInterval: 5_000,
      staleTime: 3_000,
      retry: false,
    },
  );
  const activeQuote = activeQuoteQuery.data;
  const perpSnapshot = isPerps ? perpSnapshotQuery.data : undefined;
  const perpQuote = formatPerpQuote(perpSnapshot);
  // Freshness tracks whichever venue's feed is live for the current market.
  const activeQuoteFreshness = getQuoteFreshness(
    isPerps
      ? {
          updatedAt: perpSnapshot ? perpSnapshotQuery.dataUpdatedAt : undefined,
          isFetching: perpSnapshotQuery.isFetching,
          hasError: !!perpSnapshotQuery.error,
          enabled: !!activeCoin,
        }
      : {
          updatedAt: activeQuote ? activeQuoteQuery.dataUpdatedAt : undefined,
          isFetching: activeQuoteQuery.isFetching,
          hasError: !!activeQuoteQuery.error,
          enabled: !!activeSymbol,
        },
  );

  // Venue-aware pick: flip the venue + set the right symbol slot, then run the
  // page navigation side effect. Used by both a tap and an Enter.
  const pickMarket = (selection: MarketSelection) => {
    selectMarket(selection);
    onSelectMarket?.(selection);
  };

  // onEnter needs the controller (for suggestions); break the cycle with a ref.
  const onEnterRef = useRef<(item: MarketSearchItem | null) => void>(() => {});
  const mobileSymbolSearch = useMarketSearch({
    value: searchValue,
    filter: searchFilter,
    onEnter: (item) => onEnterRef.current(item),
    ...(searchLimit != null ? { limit: searchLimit } : {}),
    disabled: searchDisabled,
  });
  onEnterRef.current = (item) => {
    // Belt and braces with the disabled query: a cached suggestion list must not
    // survive a tab change and let Enter open a market from a caller search.
    if (searchDisabled) return;
    const target = item ?? mobileSymbolSearch.suggestions[0];
    if (!target) return;
    const resolution = resolveEnterSelection(target.venues, searchFilter);
    if (resolution.kind === "select") {
      pickMarket({ symbol: target.symbol, venue: resolution.venue });
    }
    // Ambiguous / none: leave the dropdown open so the user taps a chip.
  };

  return {
    activeQuote,
    activeQuoteFreshness,
    perpSnapshot,
    perpQuote,
    venue,
    isPerps,
    marketSymbol,
    mobileSymbolSearch,
    pickMarket,
    searchFilter,
    searchDisabled,
    availability,
  };
}

export type MobileShellSubscriptions = ReturnType<
  typeof useMobileShellSubscriptions
>;

function MobileSubscriptionRuntime<T>({
  input,
  useSubscriptions,
  render,
}: {
  input: MobileSubscriptionInput;
  useSubscriptions: (input: MobileSubscriptionInput) => T;
  render: (subscriptions: T) => ReactNode;
}) {
  const subscriptions = useSubscriptions(input);
  return render(subscriptions);
}

export function TradingResponsiveShell<T = MobileShellSubscriptions>({
  mode,
  mobileSubscriptionInput,
  useMobileSubscriptions,
  renderMobile,
  desktop,
}: {
  mode: ResponsiveShellMode;
  mobileSubscriptionInput: MobileSubscriptionInput;
  useMobileSubscriptions?: (input: MobileSubscriptionInput) => T;
  renderMobile: (subscriptions: T) => ReactNode;
  desktop: ReactNode;
}) {
  const subscriptionsHook =
    useMobileSubscriptions ??
    (useMobileShellSubscriptions as unknown as (
      input: MobileSubscriptionInput,
    ) => T);

  return (
    <ResponsiveShell
      mode={mode}
      mobile={
        <MobileSubscriptionRuntime
          input={mobileSubscriptionInput}
          useSubscriptions={subscriptionsHook}
          render={renderMobile}
        />
      }
      desktop={desktop}
    />
  );
}
