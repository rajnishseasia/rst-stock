"use client";

/**
 * Venue context.
 *
 * A deliberately *narrow* context: it carries only the active venue and a
 * discriminated `accountContext` describing which account the venue trades on.
 * The stock terminal stays prop-drilled (page.tsx remains the source of truth for
 * `selectedCredentialId`/`accountMode`); this context is a thin seam layered over
 * the top so the header switch and the perps overlay can read/flip the venue and
 * so perp components can reach the Privy-HL wallet without threading props.
 *
 * The overlay nests a second `<VenueProvider venue="perps">` around the perps
 * terminal so its children read `venue === "perps"` and the perps account half,
 * without the outer stock shell ever changing venue.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { trpc } from "@/lib/trpc";
import { PERPS_ENABLED } from "@/lib/perps-config";
import {
  DEFAULT_VENUE,
  MARKET_FILTER_STORAGE_KEY,
  VENUE_STORAGE_KEY,
  parseMarketFilter,
  parseVenue,
  serializeVenue,
  type Venue,
} from "@/lib/venue-storage";
import {
  marketSelectionTarget,
  type MarketSearchFilter,
  type MarketSelection,
} from "@/lib/market-selection";

export type { Venue } from "@/lib/venue-storage";

/** Alpaca side of the discriminated account context (fed from page-level props). */
export interface StocksAccountContext {
  venue: "stocks";
  /** Selected Alpaca credential id, or undefined when no broker is connected. */
  credentialId: string | undefined;
  /** PAPER/LIVE, or undefined when no account is selected. */
  accountMode: "PAPER" | "LIVE" | undefined;
  /** Human-readable account label for headers/tickets. */
  accountLabel: string | undefined;
}

/** Privy-HL side of the discriminated account context (from `hyperliquid.status`). */
export interface PerpsAccountContext {
  venue: "perps";
  /** Whether perps have been enabled (Privy wallet provisioned). */
  enabled: boolean;
  /**
   * Whether the trading agent is activated on HL (embedded master signed
   * `approveAgent`, confirmed via `markAgentRegistered`). The trade form gates
   * on THIS — orders (agent-signed, server-side) are only accepted once true.
   */
  agentReady: boolean;
  /** HL master wallet address, or null until enabled. */
  walletAddress: string | null;
  /** Free/equity USD balance on Hyperliquid, or null until fetched. */
  hlBalanceUsd: string | null;
  /** Active HL network (mainnet/testnet). */
  network: string | null;
  /** True while the status query is loading. */
  isLoading: boolean;
}

export type AccountContext = StocksAccountContext | PerpsAccountContext;

interface VenueContextValue {
  venue: Venue;
  setVenue: (venue: Venue) => void;
  /** True once the persisted venue has been read from localStorage on the client. */
  venueHydrated: boolean;
  /** Discriminated account context for the *current* venue. */
  accountContext: AccountContext;
  /**
   * Unified-search dropdown filter (All / Stocks / Perps). The demoted venue
   * indicator sets this; the search box reads it. Distinct from `venue`: it
   * scopes which results are shown, not which venue is being traded.
   */
  searchFilter: MarketSearchFilter;
  setSearchFilter: (filter: MarketSearchFilter) => void;
  /**
   * Pick a market in ONE action: write the correct symbol slot (activeSymbol for
   * stocks, activeCoin for perps) via the page handlers AND flip the venue. This
   * collapses the old split commit handlers for the search path.
   */
  selectMarket: (selection: MarketSelection) => void;
}

const VenueContext = createContext<VenueContextValue | null>(null);

/** Props feeding the stocks half of the account context (page.tsx stays source of truth). */
export interface VenueStocksAccount {
  credentialId: string | undefined;
  accountMode: "PAPER" | "LIVE" | undefined;
  accountLabel: string | undefined;
}

export interface VenueProviderProps {
  children: ReactNode;
  /**
   * When set, this provider is *locked* to a venue (used by the nested perps
   * provider inside the overlay). Omit at the top level to get the persisted,
   * switchable venue.
   */
  venue?: Venue;
  /** Stocks-account inputs derived at the page level. */
  stocksAccount: VenueStocksAccount;
  /**
   * Page-level commit handlers that own the symbol slots. `selectMarket` routes
   * a stock pick to `onSelectStockSymbol` (activeSymbol) and a perp pick to
   * `onSelectPerpCoin` (activeCoin). Optional so a locked/nested provider works
   * without them.
   */
  onSelectStockSymbol?: (symbol: string) => void;
  onSelectPerpCoin?: (coin: string) => void;
  /**
   * Optional imperative bridge for the PAGE component (which renders above this
   * provider and so can't call `useVenue`). The top-level provider publishes its
   * `selectMarket` here so page-level pick handlers (signal click, "Copy $TICKER"
   * chip, watchlist select) can route a crypto ticker to the perps venue in one
   * action. A locked/nested provider never touches the ref.
   */
  selectMarketRef?: MutableRefObject<((selection: MarketSelection) => void) | null>;
  /**
   * Reports the active venue UP to the page component (which renders above this
   * provider and so cannot call `useVenue`). The mobile Search screen uses it to
   * open on the venue selected at the top of the app: with Perps active, an
   * unqualified search browses perps rather than everything.
   *
   * Only the top-level (unlocked) provider reports; a locked/nested provider is
   * pinned to its own venue and would otherwise announce "perps" for the whole
   * page the moment the overlay mounts.
   */
  onVenueChange?: (venue: Venue) => void;
}

export function VenueProvider({
  children,
  venue: lockedVenue,
  stocksAccount,
  onSelectStockSymbol,
  onSelectPerpCoin,
  selectMarketRef,
  onVenueChange,
}: VenueProviderProps) {
  const [storedVenue, setStoredVenue] = useState<Venue>(DEFAULT_VENUE);
  const [venueHydrated, setVenueHydrated] = useState(false);
  const [searchFilter, setSearchFilter] = useState<MarketSearchFilter>("all");

  // Hydrate the persisted venue on mount (mirrors terminalLayoutHydrated).
  useEffect(() => {
    if (lockedVenue) return;
    setStoredVenue(parseVenue(window.localStorage.getItem(VENUE_STORAGE_KEY)));
    setSearchFilter(
      parseMarketFilter(window.localStorage.getItem(MARKET_FILTER_STORAGE_KEY)),
    );
    setVenueHydrated(true);
  }, [lockedVenue]);

  // Persist venue changes once hydrated.
  useEffect(() => {
    if (lockedVenue || !venueHydrated) return;
    window.localStorage.setItem(VENUE_STORAGE_KEY, serializeVenue(storedVenue));
    window.localStorage.setItem(MARKET_FILTER_STORAGE_KEY, searchFilter);
  }, [lockedVenue, searchFilter, venueHydrated, storedVenue]);

  const rawVenue = lockedVenue ?? storedVenue;
  // A persisted `venue=perps` from localStorage must never be treated as
  // authoritative when Privy isn't configured for this deployment - there'd
  // be no Stocks toggle visible in VenueSwitch (it hides itself) to escape
  // the perps shell paths this drives.
  const venue: Venue = rawVenue === "perps" && !PERPS_ENABLED ? "stocks" : rawVenue;

  // Only fetch HL status when perps could actually be shown. A locked-perps
  // provider (the overlay) always needs it; the top-level provider fetches it
  // lazily once the user has entered perps at least once this session.
  const perpsStatusQuery = trpc.hyperliquid.status.useQuery(undefined, {
    enabled: venue === "perps",
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const accountContext = useMemo<AccountContext>(() => {
    if (venue === "perps") {
      const data = perpsStatusQuery.data;
      return {
        venue: "perps",
        enabled: data?.enabled ?? false,
        agentReady: data?.agentReady ?? false,
        walletAddress: data?.walletAddress ?? null,
        hlBalanceUsd: data?.hlBalanceUsd ?? null,
        network: data?.network ?? null,
        isLoading: perpsStatusQuery.isLoading,
      };
    }
    return {
      venue: "stocks",
      credentialId: stocksAccount.credentialId,
      accountMode: stocksAccount.accountMode,
      accountLabel: stocksAccount.accountLabel,
    };
  }, [
    venue,
    perpsStatusQuery.data,
    perpsStatusQuery.isLoading,
    stocksAccount.credentialId,
    stocksAccount.accountMode,
    stocksAccount.accountLabel,
  ]);

  // Pick a market in one action: flip the venue (persisted via the effect
  // above, unless this provider is locked) and write the matching symbol slot
  // through the page-level handler. `marketSelectionTarget` owns the
  // stocks→activeSymbol / perps→activeCoin mapping.
  const selectMarket = useCallback(
    (selection: MarketSelection) => {
      const target = marketSelectionTarget(selection);
      // Defense in depth: with perps unwired for this deployment, refuse a perp
      // pick outright. The venue switch is hidden, so flipping into the perps
      // shell would strand the user with no control to leave. This is the single
      // chokepoint every pick path (desktop, mobile, chip, Enter) funnels
      // through, so no stale/racey perp row can flip the venue here.
      if (target.venue === "perps" && !PERPS_ENABLED) return;
      if (!lockedVenue) setStoredVenue(target.venue);
      if (target.venue === "perps") {
        onSelectPerpCoin?.(target.symbol);
      } else {
        onSelectStockSymbol?.(target.symbol);
      }
    },
    [lockedVenue, onSelectStockSymbol, onSelectPerpCoin],
  );

  // Report only after localStorage hydration. Announcing DEFAULT_VENUE first
  // would let the page canonicalize an explicit Search tab against "stocks"
  // before a persisted "perps" venue is known, losing the user's tab choice.
  useEffect(() => {
    if (lockedVenue || !venueHydrated) return;
    onVenueChange?.(venue);
  }, [lockedVenue, onVenueChange, venue, venueHydrated]);

  // Publish `selectMarket` to the page-level bridge so pick handlers rendered
  // ABOVE this provider can flip the venue. Only the top-level (unlocked)
  // provider owns the switchable venue; a locked/nested provider must never
  // clobber the ref with its no-op-venue `selectMarket`.
  useEffect(() => {
    if (lockedVenue || !selectMarketRef) return;
    selectMarketRef.current = selectMarket;
    return () => {
      selectMarketRef.current = null;
    };
  }, [lockedVenue, selectMarketRef, selectMarket]);

  const value = useMemo<VenueContextValue>(
    () => ({
      venue,
      setVenue: setStoredVenue,
      venueHydrated: lockedVenue ? true : venueHydrated,
      accountContext,
      searchFilter,
      setSearchFilter,
      selectMarket,
    }),
    [venue, lockedVenue, venueHydrated, accountContext, searchFilter, selectMarket],
  );

  return <VenueContext.Provider value={value}>{children}</VenueContext.Provider>;
}

export function useVenue(): VenueContextValue {
  const ctx = useContext(VenueContext);
  if (!ctx) {
    throw new Error("useVenue must be used within a <VenueProvider>");
  }
  return ctx;
}
