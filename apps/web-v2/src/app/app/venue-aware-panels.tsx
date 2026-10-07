"use client";

/**
 * Venue-aware wrappers: thin React components that call useVenue() inside the
 * VenueProvider tree. They must be proper components (not plain functions) so
 * React hooks work correctly when they're rendered as JSX children.
 *
 * They sit beside the page instead of inside it because a Next.js page file may
 * export only `default` plus the framework's own config keys (`metadata`,
 * `dynamic`, `viewport`, ...). Exporting anything else fails the page-type
 * check `next build` generates into .next/types, which is a production build
 * failure `bun run check-types` alone does NOT catch: those generated types do
 * not exist until the build writes them. page-layout.test.ts renders five of
 * these directly against a mocked venue context, so they have to be importable
 * from somewhere that is allowed to export them, and this is that somewhere.
 * Nothing about the components themselves changed in the move: TradingAppContent
 * (./trading-app-content) still renders exactly these, in the same places, with
 * the same props.
 */

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import {
  SignalFeed,
  type PerpCopySelection,
  type SelectedSignal,
} from "@/components/feed/signal-feed";
import { equityOrderSignalId } from "@/components/feed/signal-perp";
import { TradeForm } from "@/components/trade/trade-form";
import { StockTradeMarketHeader } from "@/components/trade/trade-market-header";
import type {
  SignalPrefillOrderType,
  SignalPrefillEntryOrderType,
  SignalPrefillDirection,
  SignalPrefillTimeInForce,
} from "@/components/trade/signal-prefill";
import { PositionsPanel } from "@/components/trade/positions-panel";
import { OpenOrdersPanel } from "@/components/trade/open-orders-panel";
import { PortfolioHistoryChart } from "@/components/charts/portfolio-history-chart";
import { TerminalChartPanel } from "@/components/terminal/terminal-chart-panel";
import { TerminalMarketSearch } from "@/components/terminal/terminal-market-search";
import { PerpPositionsPanel } from "@/components/trade/perp-positions-panel";
import { PerpOrdersPanel } from "@/components/trade/perp-orders-panel";
import { PerpTradeForm } from "@/components/trade/perp-trade-form";
import { PerpPortfolioPanel } from "@/components/perps/perp-portfolio-panel";
import { PerpFillsPanel } from "@/components/perps/perp-fills-panel";
import { ClosedOrdersPanel } from "@/components/trade/closed-orders-panel";
import {
  PerpBalancesPanel,
  StockBalancesPanel,
} from "@/components/trade/balances-panel";
import { PerpOrderBook } from "@/components/perps/perp-order-book";
import { CopyTradePanel } from "@/components/copy-trade/copy-trade-panel";
import {
  MobileAccountScreen,
  type MobileAccountScreenProps,
} from "./mobile-v2/account-screen";
import { useVenue, type Venue } from "@/lib/venue-context";
import { PERPS_ENABLED } from "@/lib/perps-config";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";
import {
  BOTTOM_TERMINAL_TABS,
  PERPS_BOTTOM_TERMINAL_TABS,
  resolveBottomSubTab,
  type BottomTerminalTab,
} from "./terminal-shell-config";
import { isPerpsAccountActive } from "./venue-routing";
import type { AccountMode, OptionCopyPrefill } from "./terminal-account-types";
import type {
  ManualCopyPrefillEvent,
  PerpManualCopyPrefill,
  StockManualCopyPrefill,
} from "@/components/trade/manual-copy-prefill";

// Header account metrics: reads the active venue so it can hide the Perps
// Balance metric when the user is in stocks mode (it is confusing to show a
// Hyperliquid equity number while viewing stocks) and labels change to reflect
// the active context. Data is passed as props from the parent (which owns the
// tRPC queries); only the venue discriminant comes from context.
export function VenueAwareHeaderMetrics({
  selectedCredentialId,
  perpsWalletAddress,
  headerPortfolioValue,
  headerBuyingPower,
  headerPerpsEquity,
}: {
  selectedCredentialId: string | undefined;
  perpsWalletAddress: string | null | undefined;
  headerPortfolioValue: number | null | undefined;
  headerBuyingPower: number | null | undefined;
  headerPerpsEquity: string | number | null | undefined;
}) {
  const { venue } = useVenue();
  return (
    <div className="hidden items-center gap-2 sm:gap-4 xl:flex">
      {selectedCredentialId && (
        <div className="terminal-account-metric text-right leading-tight">
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Stocks Portfolio</div>
          <div className="font-data tabular-nums text-sm font-semibold">
            {headerPortfolioValue != null ? formatUsd(headerPortfolioValue) : "-"}
          </div>
        </div>
      )}
      {perpsWalletAddress && venue === "perps" && (
        <div
          className="terminal-account-metric text-right leading-tight"
          title="Total value of your Hyperliquid account, including spot holdings and unrealized PnL."
        >
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Perps Balance</div>
          <div className="font-data tabular-nums text-sm font-semibold">
            {headerPerpsEquity != null ? formatUsd(headerPerpsEquity) : "-"}
          </div>
        </div>
      )}
      {(selectedCredentialId || perpsWalletAddress) && (
        <div
          className="terminal-account-metric text-right leading-tight"
          title="Combined total account value across stocks portfolio and perps balance."
        >
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">Total Balance</div>
          <div className="font-data tabular-nums text-sm font-semibold">
            {headerPortfolioValue != null || headerPerpsEquity != null
              ? formatUsd(
                  (headerPortfolioValue ?? 0) +
                    (typeof headerPerpsEquity === "number"
                      ? headerPerpsEquity
                      : typeof headerPerpsEquity === "string"
                        ? Number(headerPerpsEquity) || 0
                        : 0),
                )
              : "-"}
          </div>
        </div>
      )}
    </div>
  );
}

export function VenueAwareMobileAccountScreen(
  props: MobileAccountScreenProps,
) {
  const { venue } = useVenue();
  return <MobileAccountScreen {...props} venue={venue} />;
}

// Fix 4: Whenever stocks is the active venue, move the left drawer to X Signals
// (the primary stocks discovery surface). This also applies on first render: a
// persisted secondary tab must not outrank the active top-level market choice.
// The callback is captured in a ref to avoid stale closures without invalidating
// the venue-change effect.
export function VenueAwareLeftTabSync({
  onSwitchToStocks,
}: {
  onSwitchToStocks: () => void;
}) {
  const { venue } = useVenue();
  const callbackRef = useRef(onSwitchToStocks);
  useEffect(() => { callbackRef.current = onSwitchToStocks; });
  useEffect(() => {
    if (venue === "stocks") callbackRef.current();
  }, [venue]);
  return null;
}

// The mobile Markets destination keeps its own All / Stocks / Perps browse
// scope, so picking a venue at the top of the app used to leave the screen
// below it unchanged: the one control the user reaches for on Markets appeared
// to do nothing. Switching venue now scopes the browse list to that venue, the
// same way it scopes the unified search. Only an actual change is forwarded, so
// the "All" default the discovery surface opens on survives first render and
// the in-page filter row stays free to widen the scope back afterwards.
/**
 * The whole decision, as a pure function: what to remember, and what (if
 * anything) to scope the Markets list to.
 *
 * Both halves matter and neither is testable through the component (this suite
 * has no DOM to run effects in), so they are computed here rather than being
 * spread across the effect body:
 *
 *  - `record` is what the next run should compare against. Before hydration it
 *    stays `null`: the provider renders a provisional venue before reading
 *    localStorage, and remembering that makes the hydration which restores a
 *    returning perps user look like a switch INTO perps -- narrowing the
 *    Markets list on first load, which is the exact default this sync exists
 *    to preserve.
 *  - `scopeTo` is non-null only for a real venue change between two known
 *    venues, so neither mount nor hydration nor an idle re-render can clobber
 *    a scope the user widened back with the in-page filter row.
 */
export function nextMarketsScopeState(
  previousVenue: Venue | null,
  venue: Venue,
  venueHydrated: boolean,
): { record: Venue | null; scopeTo: Venue | null } {
  if (!venueHydrated) return { record: null, scopeTo: null };
  // First hydrated run: adopt the real venue silently. The Markets screen
  // opens on its own "All" discovery scope deliberately.
  if (previousVenue === null) return { record: venue, scopeTo: null };
  return { record: venue, scopeTo: previousVenue === venue ? null : venue };
}

export function VenueAwareMarketsFilterSync({
  onVenueChange,
}: {
  onVenueChange: (venue: Venue) => void;
}) {
  const { venue, venueHydrated } = useVenue();
  const callbackRef = useRef(onVenueChange);
  useEffect(() => { callbackRef.current = onVenueChange; });
  const previousVenueRef = useRef<Venue | null>(null);
  useEffect(() => {
    const { record, scopeTo } = nextMarketsScopeState(
      previousVenueRef.current,
      venue,
      venueHydrated,
    );
    if (scopeTo) callbackRef.current(scopeTo);
    previousVenueRef.current = record;
  }, [venue, venueHydrated]);
  return null;
}

// X Signals feed with venue-aware Copy routing. A perp signal's Copy flips the
// venue to perps + sets the coin slot via `selectMarket` (one action) and then
// seeds the perp form's direction/leverage; an equity Copy ensures the stocks
// venue (a prior perp copy may have left the terminal on perps) before running
// the existing equity handler. On the perps venue the feed also narrows to perp
// signals, so perp calls are reachable from the perps context as well as the
// full feed.
export function VenueAwareSignalFeed({
  onSelectSignal,
  onPerpCopyPrefill,
  signalVenueFilter: signalVenueFilterOverride,
  tickerClickVenue: tickerClickVenueOverride,
  onShowAllSignals: onShowAllSignalsOverride,
  ...props
}: Omit<
  ComponentProps<typeof SignalFeed>,
  "onCopyPerpSignal" | "signalVenueFilter" | "tickerClickVenue" | "onShowAllSignals"
> & {
  onPerpCopyPrefill: (payload: PerpCopySelection) => void;
  /**
   * Scope this feed without changing the terminal's shared market filter. When
   * omitted, the venue context remains the source of truth (legacy behavior).
   */
  signalVenueFilter?: "all" | "stocks" | "perps";
  /**
   * Choose the venue used when a ticker's identity half opens a chart. This is
   * independent from the feed scope so a dedicated perps feed can chart HIP-3
   * coins (for example `xyz:GOOGL`) as perps while the terminal stays on stocks.
   */
  tickerClickVenue?: "stocks" | "perps";
  /**
   * Optional local escape from an explicitly scoped empty feed. An explicit
   * feed scope must not fall back to the global context setter.
   */
  onShowAllSignals?: () => void;
}) {
  const { venue, searchFilter, selectMarket, setSearchFilter } = useVenue();
  const signalVenueFilter = signalVenueFilterOverride ?? searchFilter;
  const tickerClickVenue = tickerClickVenueOverride ?? venue;
  const onShowAllSignals =
    onShowAllSignalsOverride ??
    (signalVenueFilterOverride === undefined
      ? () => setSearchFilter("all")
      : undefined);
  return (
    <SignalFeed
      {...props}
      signalVenueFilter={signalVenueFilter}
      tickerClickVenue={tickerClickVenue}
      // The venue owns the perps-only narrowing, so the escape out of an empty
      // perp feed is a venue switch. Symbol slots are left alone: this is a
      // feed-scope change, not a market pick.
      onShowAllSignals={onShowAllSignals}
      onSelectSignal={(signal) => {
        selectMarket({ symbol: signal.symbol, venue: "stocks" });
        onSelectSignal(signal);
      }}
      onCopyPerpSignal={(payload) => {
        selectMarket({ symbol: payload.coin, venue: "perps" });
        onPerpCopyPrefill(payload);
      }}
    />
  );
}

export function VenueAwareCopyTradePanel(
  props: ComponentProps<typeof CopyTradePanel>,
) {
  const { searchFilter } = useVenue();
  return <CopyTradePanel {...props} marketFilter={searchFilter} />;
}

export function VenueAwareTradeRail({
  activeSymbol,
  activeCoin,
  activeSide,
  activeQty,
  activeSignaEntry,
  activeSignaStop,
  activeSignaTarget,
  activeSignaOrderType,
  activeSignaLimitPrice,
  activeSignaEntryOrderType,
  activeSignaDirection,
  activeSignaTimeInForce,
  activeOptionCopy,
  activePerpSide,
  activePerpLeverage,
  activePerpLimitPrice,
  perpPrefillNonce,
  activePerpPrefillCoin,
  manualCopyPrefill,
  manualCopyResetNonce,
  onManualCopyPrefillConsumed,
  onManualCopyPrefillCompleted,
  onManualCopyPrefillCancelled,
  perpCopyPrefill,
  onPerpCopyPrefillConsumed,
  onPerpCopyPrefillCompleted,
  onPerpCopyPrefillCancelled,
  selectedSignal,
  selectedCredentialId,
  selectedAccountType,
  selectedAccountLabel,
  tradeIsPrefilled,
  onSymbolCommit,
  hideMarketHeader = false,
}: {
  activeSymbol: string;
  activeCoin: string;
  activeSide?: "buy" | "sell";
  activeQty?: number;
  activeSignaEntry?: number;
  activeSignaStop?: number;
  activeSignaTarget?: number;
  activeSignaOrderType?: SignalPrefillOrderType;
  activeSignaLimitPrice?: number;
  activeSignaEntryOrderType?: SignalPrefillEntryOrderType;
  activeSignaDirection?: SignalPrefillDirection;
  activeSignaTimeInForce?: SignalPrefillTimeInForce;
  activeOptionCopy?: OptionCopyPrefill;
  activePerpSide?: "long" | "short";
  activePerpLeverage?: number;
  /**
   * A price clicked in the desktop perps order book (HL's raw decimal string).
   * Applied on the next `perpPrefillNonce` bump, which also flips the ticket to
   * Limit. The mobile trade sheet never receives this: no order book is mounted
   * in the mobile shell.
   */
  activePerpLimitPrice?: string;
  perpPrefillNonce?: number;
  activePerpPrefillCoin?: string;
  manualCopyPrefill?: ManualCopyPrefillEvent<StockManualCopyPrefill> | null;
  manualCopyResetNonce?: number;
  onManualCopyPrefillConsumed?: (nonce: number) => void;
  onManualCopyPrefillCompleted?: (nonce: number) => void;
  onManualCopyPrefillCancelled?: (nonce: number) => void;
  perpCopyPrefill?: ManualCopyPrefillEvent<PerpManualCopyPrefill> | null;
  onPerpCopyPrefillConsumed?: (nonce: number) => void;
  onPerpCopyPrefillCompleted?: (nonce: number) => void;
  onPerpCopyPrefillCancelled?: (nonce: number) => void;
  selectedSignal: SelectedSignal | null;
  selectedCredentialId?: string;
  selectedAccountType?: AccountMode;
  selectedAccountLabel: string;
  tradeIsPrefilled: boolean;
  onSymbolCommit: (symbol: string) => void;
  /**
   * The host already states the market. Set by the mobile trade sheet (plan A1),
   * whose own header carries the symbol, the venue tag and the live price; the
   * desktop rail leaves it off because the ticket is the only thing in the pane.
   * The equity ticket has never had a market header, so this only reaches the
   * perp form.
   */
  hideMarketHeader?: boolean;
}) {
  const { venue, accountContext } = useVenue();
  if (venue === "perps" && accountContext.venue === "perps") {
    // While the perps status query is still in flight, show a plain loading
    // state. Without this gate, `agentReady` defaults to false and the form
    // immediately renders the "Set up perpetual futures" onboarding card on
    // every page refresh, even for users who are fully configured.
    if (accountContext.isLoading) {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Checking your perps account…
        </div>
      );
    }
    // Direct actions explicitly supersede the manual-copy channel. Nonces are
    // identities, not timestamps to compare across event producers.
    const manualCopy = perpPrefillNonce ? undefined : perpCopyPrefill;
    const activePerpCopy =
      manualCopy && !manualCopy.consumed
        ? manualCopy.value
        : undefined;
    return (
      <PerpTradeForm
        coin={activeCoin}
        enabled={accountContext.agentReady}
        hideMarketHeader={hideMarketHeader}
        initialIsLong={
          activePerpCopy
            ? activePerpCopy.side === "long"
            : manualCopy
              ? undefined
              : activePerpSide === undefined
                ? undefined
                : activePerpSide === "long"
        }
        initialLeverage={
          activePerpCopy?.leverage ??
          (manualCopy ? undefined : activePerpLeverage)
        }
        prefillNonce={manualCopy?.nonce ?? perpPrefillNonce}
        prefillCoin={manualCopy?.value.coin ?? activePerpPrefillCoin}
        prefillConsumed={manualCopy?.consumed ?? false}
        copySourceItemId={manualCopy?.value.copySourceItemId}
        copySourceCoin={manualCopy?.value.coin}
        copySourceSide={manualCopy?.value.side}
        onPrefillConsumed={
          manualCopy ? onPerpCopyPrefillConsumed : undefined
        }
        onManualCopyPrefillCompleted={
          manualCopy ? onPerpCopyPrefillCompleted : undefined
        }
        onManualCopyPrefillCancelled={
          manualCopy ? onPerpCopyPrefillCancelled : undefined
        }
        initialLimitPrice={activePerpLimitPrice}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!hideMarketHeader && (
        <StockTradeMarketHeader symbol={activeSymbol} />
      )}
      <div className="min-h-0 flex-1">
        <TradeForm
          initialSymbol={activeSymbol}
          initialSide={activeSide}
          initialQty={activeQty}
          initialEntry={activeSignaEntry}
          initialStopLoss={activeSignaStop}
          initialTakeProfit={activeSignaTarget}
          initialOrderType={activeSignaOrderType}
          initialLimitPrice={activeSignaLimitPrice}
          initialEntryOrderType={activeSignaEntryOrderType}
          initialDirection={activeSignaDirection}
          initialTimeInForce={activeSignaTimeInForce}
          initialAssetType={activeOptionCopy?.assetType ?? "EQUITY"}
          initialOptionExpiration={activeOptionCopy?.optionExpiration}
          initialOptionStrike={activeOptionCopy?.optionStrike}
          initialOptionType={activeOptionCopy?.optionType}
          initialTradeAction={activeOptionCopy?.tradeAction}
          // Venue-checked, not just symbol-checked: tickers collide across venues,
          // so a perp copy must never link its signal to an equity order. See
          // `equityOrderSignalId`.
          signalId={equityOrderSignalId(selectedSignal, activeSymbol)}
          copySourceItemId={
            manualCopyPrefill?.value.copySourceItemId ??
            selectedSignal?.copySourceItemId
          }
          copySourceSymbol={
            manualCopyPrefill?.value.symbol ?? selectedSignal?.symbol
          }
          copySourceSide={manualCopyPrefill?.value.side}
          activeCredentialId={selectedCredentialId}
          activeAccountType={selectedAccountType}
          activeAccountLabel={selectedAccountLabel}
          embedded
          isPrefilledOrder={tradeIsPrefilled}
          manualCopyPrefill={manualCopyPrefill}
          manualCopyResetNonce={manualCopyResetNonce}
          onManualCopyPrefillConsumed={onManualCopyPrefillConsumed}
          onManualCopyPrefillCompleted={onManualCopyPrefillCompleted}
          onManualCopyPrefillCancelled={onManualCopyPrefillCancelled}
          onSymbolCommit={onSymbolCommit}
        />
      </div>
    </div>
  );
}

// page-layout.test.ts renders these three directly against a mocked venue
// context: the routing rule they share - never show perps content, and never
// route a perps portfolio tab to Alpaca history, unless BOTH the traded venue
// and the resolved account context agree it's perps - is real behavior worth
// pinning against the actual component, not just the `isPerpsAccountActive`
// helper it calls.
export function VenueAwareRightPositions({
  onViewPerpChart,
  ...stocksProps
}: ComponentProps<typeof PositionsPanel> & {
  onViewPerpChart: (coin: string) => void;
}) {
  const { venue, accountContext } = useVenue();
  if (isPerpsAccountActive(venue, accountContext)) {
    return (
      <PerpPositionsPanel
        walletAddress={accountContext.walletAddress}
        enabled={accountContext.enabled}
        loading={accountContext.isLoading}
        onViewChart={onViewPerpChart}
      />
    );
  }
  return <PositionsPanel {...stocksProps} embedded />;
}

export function VenueAwareRightOrders({
  onViewPerpChart,
  ...stocksProps
}: ComponentProps<typeof OpenOrdersPanel> & {
  onViewPerpChart: (coin: string) => void;
}) {
  const { venue, accountContext } = useVenue();
  if (isPerpsAccountActive(venue, accountContext)) {
    return (
      <PerpOrdersPanel
        enabled={accountContext.enabled}
        onViewChart={onViewPerpChart}
      />
    );
  }
  return <OpenOrdersPanel {...stocksProps} embedded />;
}

export function VenueAwareRightPortfolio({
  credentialId,
}: {
  credentialId?: string;
}) {
  const { venue, accountContext } = useVenue();
  if (isPerpsAccountActive(venue, accountContext)) {
    return <PerpPortfolioPanel enabled={accountContext.enabled} />;
  }
  return <PortfolioHistoryChart credentialId={credentialId} embedded />;
}

/**
 * The bottom drawer's content.
 *
 * The drawer used to carry its own All | Stocks | Perps view selector, so the
 * app could be trading perps while the drawer below the chart showed a stacked
 * "All" overview, or the other venue outright. It is now driven by the venue
 * selected at the top of the app and shows exactly one table: the one for the
 * venue you are in.
 */
export function VenueAwareBottomContent(props: {
  isSignedIn: boolean;
  activeSymbol: string;
  selectedCredentialId?: string;
  selectedAccountType?: AccountMode;
  credentialsLoading: boolean;
  bottomTerminalTab: BottomTerminalTab;
  perpsWalletAddress: string | null;
  perpsEnabled: boolean;
  /** The status read settled; a false `perpsEnabled` is a real no. */
  perpsStatusSettled: boolean;
  /** Focus the signals feed; the primary action out of empty states. */
  onBrowseSignals: () => void;
  onAskAi: (symbol: string) => void;
  onSelectSymbol: (symbol: string) => void;
  onViewChart: (symbol: string) => void;
  onViewPerpChart: (coin: string) => void;
  onTrade: (symbol: string) => void;
}) {
  const { venue } = useVenue();

  const stocksPositions = (
    <PositionsPanel
      isSignedIn={props.isSignedIn}
      selectedSymbol={props.activeSymbol}
      activeCredentialId={props.selectedCredentialId}
      activeAccountType={props.selectedAccountType}
      credentialsLoading={props.credentialsLoading}
      onAskAi={props.onAskAi}
      onSelectSymbol={props.onSelectSymbol}
      onViewChart={props.onViewChart}
      onTrade={props.onTrade}
      onBrowseSignals={props.onBrowseSignals}
      embedded
    />
  );
  const stocksOrders = (
    <OpenOrdersPanel
      activeCredentialId={props.selectedCredentialId}
      activeAccountType={props.selectedAccountType}
      credentialsLoading={props.credentialsLoading}
      embedded
    />
  );
  const stocksBySubTab = () => {
    // resolveBottomSubTab folds a stale "closed" selection back to Positions
    // and narrows it out of the return type, so this switch is exhaustive over
    // what can actually arrive.
    switch (resolveBottomSubTab(props.bottomTerminalTab)) {
      case "positions":
        return stocksPositions;
      case "orders":
        return stocksOrders;
      case "history":
        // The same closed-order list the positions panel shows behind its
        // Open | Closed toggle, one click away instead of two.
        return (
          <ClosedOrdersPanel
            isSignedIn={props.isSignedIn}
            activeCredentialId={props.selectedCredentialId}
            credentialsLoading={props.credentialsLoading}
            onViewChart={props.onViewChart}
            onTrade={props.onTrade}
          />
        );
      case "balances":
        return (
          <StockBalancesPanel
            isSignedIn={props.isSignedIn}
            activeCredentialId={props.selectedCredentialId}
            credentialsLoading={props.credentialsLoading}
          />
        );
      case "portfolio":
        return <PortfolioHistoryChart credentialId={props.selectedCredentialId} embedded />;
    }
  };

  // Perps not configured: the bottom is stocks-only, exactly as before.
  if (!PERPS_ENABLED) {
    return stocksBySubTab();
  }

  const perpsPositions = (
    <PerpPositionsPanel
      walletAddress={props.perpsWalletAddress}
      enabled={props.perpsEnabled}
      loading={!props.perpsStatusSettled}
      onViewChart={props.onViewPerpChart}
    />
  );
  const perpsBySubTab = () => {
    // Closed perp round-trips are NOT a sub-tab any more: they are the Closed
    // half of the positions panel's own Open | Closed toggle, exactly as on
    // the stocks side.
    switch (resolveBottomSubTab(props.bottomTerminalTab)) {
      case "positions":
        return perpsPositions;
      case "orders":
        return (
          <PerpOrdersPanel
            enabled={props.perpsEnabled}
            onViewChart={props.onViewPerpChart}
          />
        );
      case "history":
        // The fills table itself, not the portfolio summary that used to bury
        // it under a "Realized activity" heading on the Portfolio tab.
        return <PerpFillsPanel enabled={props.perpsEnabled} />;
      case "balances":
        return <PerpBalancesPanel enabled={props.perpsEnabled} />;
      case "portfolio":
        return <PerpPortfolioPanel enabled={props.perpsEnabled} />;
    }
  };

  // ONE table, for the venue selected at the top of the app.
  return venue === "perps" ? perpsBySubTab() : stocksBySubTab();
}

function BottomTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 shrink-0 rounded-sm border border-transparent px-2.5 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/40 bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The bottom drawer's tab strip.
 *
 * It used to lead with an All | Stocks | Perps venue selector duplicating the
 * one in the app header, which meant the drawer could be showing a venue the
 * rest of the terminal was not in. The venue now comes from the top of the app
 * and this strip carries only the sub-tabs, which are the same three for both
 * venues.
 */
export function VenueAwareBottomHeader({
  bottomTerminalTab,
  onTabChange,
}: {
  bottomTerminalTab: BottomTerminalTab;
  onTabChange: (tab: BottomTerminalTab) => void;
}) {
  const { venue } = useVenue();
  const tabs = PERPS_ENABLED && venue === "perps"
    ? PERPS_BOTTOM_TERMINAL_TABS
    : BOTTOM_TERMINAL_TABS;
  const active = resolveBottomSubTab(bottomTerminalTab);

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain xl:no-scrollbar">
      {tabs.map((tab) => (
        <BottomTabButton
          key={tab.value}
          active={active === tab.value}
          label={tab.label}
          onClick={() => onTabChange(tab.value)}
        />
      ))}
    </div>
  );
}

export function VenueAwareChartPanel(props: {
  activeSymbol: string;
  activeCoin: string;
  credentialId?: string;
  // Tri-state, forwarded not decided: `null` means the venue's read has not
  // answered, and must not be reported as "you cannot trade here".
  stocksAvailable: boolean | null;
  perpsAvailable: boolean | null;
  onSymbolCommit: (symbol: string) => void;
  onCoinCommit: (coin: string) => void;
  onSymbolTrade: (symbol: string) => void;
  onCoinTrade: (coin: string) => void;
  bottomDrawer: ReactNode;
  bottomDrawerHeader: ReactNode;
  bottomDrawerLabel: string;
  /**
   * Prefill a clicked order-book price into the perp ticket's limit field.
   * Perps-only: the stocks venue has no L2 depth to click (Alpaca exposes NBBO
   * top-of-book only), so no book is rendered there.
   */
  onBookPriceSelect?: (px: string) => void;
}) {
  const { venue } = useVenue();
  const isPerps = venue === "perps";
  const symbol = isPerps ? props.activeCoin : props.activeSymbol;
  return (
    <TerminalChartPanel
      symbol={symbol}
      venue={venue}
      credentialId={isPerps ? undefined : props.credentialId}
      // Desktop perps only. This component renders inside the desktop terminal
      // shell, which the responsive-shell switch mounts only at `xl`; the rail
      // is `hidden xl:flex` and gates its own poll on the same breakpoint, so
      // it can never mount or poll in the mobile shell.
      chartSideRail={
        isPerps ? (
          <PerpOrderBook
            coin={props.activeCoin}
            onSelectPrice={props.onBookPriceSelect}
          />
        ) : undefined
      }
      onSymbolCommit={isPerps ? props.onCoinCommit : props.onSymbolCommit}
      onTrade={isPerps ? props.onCoinTrade : props.onSymbolTrade}
      headerSearch={
        <TerminalMarketSearch
          activeSymbol={symbol}
          stocksAvailable={props.stocksAvailable}
          perpsAvailable={props.perpsAvailable}
        />
      }
      bottomDrawer={props.bottomDrawer}
      bottomDrawerHeader={props.bottomDrawerHeader}
      bottomDrawerLabel={props.bottomDrawerLabel}
    />
  );
}
