"use client";

/**
 * The authenticated trading terminal: every pane, drawer, and mobile screen the
 * /app route renders once a session resolves. `page.tsx` keeps only the
 * anonymous-visitor redirect guard and the `export default` Next.js routes to,
 * so that guard can be rendered for real in a test without also mounting this
 * entire terminal, which needs a live VenueProvider/tRPC context that test has
 * no reason to fake.
 *
 * It sits beside the page instead of inside it because a Next.js page file may
 * export only `default` plus the framework's own config keys (`metadata`,
 * `dynamic`, `viewport`, ...), and page-layout.test.ts has to import
 * `TradingAppContent` by name: the guard test recognizes this exact function as
 * the element type TradingApp mounts. Exporting it from page.tsx instead fails
 * the page-type check `next build` generates into .next/types, which is a
 * production build failure `bun run check-types` alone does NOT catch: those
 * generated types do not exist until the build writes them.
 */

import { isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { type SelectedSignal, type SignalChartSelection } from "@/components/feed/signal-feed";
// Plan S1. The caller's thesis follows the user onto the chart screen and into
// the pinned CTA. `signalThesisForMarket` is the venue-aware guard that keeps a
// perp caller's words off an unrelated equity chart on a colliding ticker.
import { SignalThesisCard } from "@/components/feed/signal-thesis-card";
import {
  signalThesisForMarket,
} from "@/components/feed/signal-thesis";
import type {
  SignalPrefillOrderType,
  SignalPrefillEntryOrderType,
  SignalPrefillDirection,
  SignalPrefillTimeInForce,
} from "@/components/trade/signal-prefill";
import { UserMenu } from "@/components/auth/user-menu";
import { PositionsPanel } from "@/components/trade/positions-panel";
import { OpenOrdersPanel } from "@/components/trade/open-orders-panel";
import { SocialFeedPanel } from "@/components/social/social-feed-panel";
import type {
  CopyTradePayload,
  CopyPerpTradePayload,
} from "@/components/copy-trade/copy-trade-panel";
// Plan A10: the two leaderboard bodies, mounted one at a time inside the mobile
// Copy screen. LeaderboardView (which wraps them in its own Tabs) stays the
// desktop /lb route's body.
import { UsersTab, XCallersTab } from "@/components/copy-trade/leaderboard-view";
import { StockChatPanel, type ChatOrderDraft } from "@/components/chat/stock-chat-panel";
import { WatchlistPanel } from "@/components/watchlist/watchlist-panel";
import { SignaSignalsPanel } from "@/components/signa/signa-signals-panel";
import { PortfolioHistoryChart } from "@/components/charts/portfolio-history-chart";
import { TerminalChartPanel } from "@/components/terminal/terminal-chart-panel";
import { TerminalDrawer } from "@/components/terminal/terminal-drawer";
import { TerminalMarketTicker } from "@/components/terminal/terminal-market-ticker";
import { VenueSwitch } from "@/components/terminal/venue-switch";
import {
  MobileMarketBrowse,
  isPeopleBrowseTab,
  marketSearchScope,
  type MobileBrowseTab,
} from "@/components/terminal/mobile-market-browse";
import { MOBILE_BROWSE_SEARCH_LIMIT } from "@/components/terminal/market-browse";
import { PerpSymbolUniverse } from "@/components/perps/perp-symbol-universe";
import { PerpPositionsPanel } from "@/components/trade/perp-positions-panel";
import { PerpOrdersPanel } from "@/components/trade/perp-orders-panel";
import { PerpPortfolioPanel } from "@/components/perps/perp-portfolio-panel";
import { PerpClosedPanel } from "@/components/perps/perp-closed-panel";
import { VenueProvider } from "@/lib/venue-context";
import {
  marketSelectionTarget,
  normalizeMarketSymbol,
  resolveSubmitSelection,
  type MarketSearchFilter,
  type MarketSelection,
  type MarketVenue,
} from "@/lib/market-selection";
import {
  browserRecentMarketsStore,
  readRecentMarkets,
  rememberRecentMarket,
} from "@/lib/recent-markets";
import { PERPS_ENABLED } from "@/lib/perps-config";
import { useSymbolVenueRouter } from "@/lib/use-symbol-venue-router";
import { useCompleteApiCredentials } from "@/lib/use-complete-api-credentials";
import { toast } from "sonner";
import type { ResponsiveShellMode } from "@/components/layout/responsive-shell";
import {
  TradingResponsiveShell,
  type MobileShellSubscriptions,
} from "@/components/layout/trading-responsive-shell";
import {
  MobileBottomNav,
  navigateMobileScreen,
  type MobileScreen,
} from "@/components/layout/mobile-nav";
import {
  DEFAULT_MOBILE_CHART_TAB,
  mobileChartTabsForVenue,
  resolveMobileChartTab,
  isNarrowViewport,
  landCopyPrefill,
  type MobileChartTab,
} from "./mobile-shell";
import {
  tradeSheetLabel,
  tradeSheetScrollLockEffect,
} from "./trade-sheet";
import {
  describeMobileMarketHeader,
  type MobileMarketHeader,
} from "./mobile-market-header";
import { MobileVenueStack } from "./mobile-venue-stack";
import {
  buildMobilePortfolio,
  describeMobileBalanceLabel,
  resolveMobileAccountValueProps,
  resolveMobilePortfolioNavigation,
  perpsStatusSettled,
  venueConnectionState,
  showMobilePerpsSection,
  type MobilePortfolioSummary,
  type MobilePortfolioView,
} from "./mobile-portfolio";
// The account-value resolvers live with the portfolio rules now (audit H7);
// re-exported so existing imports of this module keep working.
export {
  resolveMobileAccountValueProps,
  resolveMobileAccountValueState,
} from "./mobile-portfolio";
import {
  MobileV2Frame,
  MobileV2Header,
} from "./mobile-v2/mobile-frame";
import {
  MobileV2Menu,
  navigateMobileMenuSection,
  type MobileMenuSection,
} from "./mobile-v2/mobile-menu";
import {
  MobileChartInsights,
  MobileChartMarketSummary,
} from "./mobile-v2/chart-market-summary";
import {
  MobilePrimaryActionBar,
  type MobilePrimaryActionSide,
} from "./mobile-v2/primary-action-bar";
import { mobileLandingSlots } from "./mobile-v2/mobile-landing";
import { mobileScreenHostsVenueSwitch } from "./mobile-v2/mobile-venue-scope";
import {
  MobileChartEmptyState,
  MobileChartHeader,
} from "./mobile-v2/chart-header";
// Extracted presentational surfaces (audit H7). Re-exported so their tests and
// any older importer keep one import path for the mobile shell.
export { MobileV2Menu } from "./mobile-v2/mobile-menu";
export {
  MobileChartInsights,
  MobileChartMarketSummary,
} from "./mobile-v2/chart-market-summary";
import { MobileMarketsScreen } from "./mobile-v2/markets-screen";
import {
  MobileFeedPanel,
  normalizeMobileFeedVenueFilter,
  type MobileFeedVenueFilter,
} from "./mobile-v2/feed-panel";
import {
  MobileAccountScreen,
  type MobileAccountTab,
} from "./mobile-v2/account-screen";
import {
  MobileTradersScreen,
  type MobileTradersTab,
} from "./mobile-v2/traders-screen";
import {
  DEFAULT_MOBILE_LOCATION,
  mobileBackHistoryMode,
  mergeMobileLocationSearch,
  mobileBackTarget,
  mobileHistoryPushState,
  parseMobileLocation,
  serializeMobileLocation,
  type MobileHistoryOrigin,
  type MobileLocationState,
} from "./mobile-v2/mobile-history";
import {
  DEFAULT_TERMINAL_LAYOUT,
  closePane,
  collapseDrawer,
  parseTerminalLayout,
  serializeTerminalLayout,
  splitPane,
  updatePaneTab,
  type LeftTerminalTab,
  type RightTerminalTab,
  type TerminalLayoutState,
  type TerminalSplit,
} from "@/components/terminal/terminal-layout-state";
import { Button } from "@/components/ui/button";
import { MarketPulseWorkspace } from "@/components/market-pulse";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  Bell,
  CandlestickChart,
  ChevronRight,
  Maximize2,
  Menu,
  Newspaper,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Search,
  Settings,
  Trophy,
  X,
  FileText,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import {
  AlpacaCredentialReimportNotice,
  findUsableAlpacaAccount,
} from "@/lib/alpaca-credential-reimport-notice";
import { cn } from "@/lib/utils";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { DESKTOP_TERMINAL_MEDIA_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { formatUsd } from "@/lib/format";
import {
  LEFT_DRAWER_MIN_WIDTH,
  LEFT_DRAWER_MAX_WIDTH,
  RIGHT_DRAWER_MIN_WIDTH,
  RIGHT_DRAWER_MAX_WIDTH,
  RIGHT_DRAWER_DEFAULT_WIDTH,
  COLLAPSED_DRAWER_WIDTH,
  CHART_COLUMN_MIN_WIDTH,
  clampNumber,
  balanceDrawerWidths,
  parseStoredDrawerWidths,
} from "@/components/terminal/drawer-layout";
import {
  TERMINAL_DRAWER_WIDTHS_STORAGE_KEY,
  DISCOVERY_COLLAPSED_STORAGE_KEY,
  TERMINAL_LAYOUT_STORAGE_KEY,
  parseDiscoveryCollapsed,
  useTerminalLayoutSync,
} from "./use-terminal-layout-sync";
import {
  LEFT_TERMINAL_TABS,
  RIGHT_TERMINAL_TABS,
  RIGHT_TERMINAL_TAB_VALUES,
  DEFAULT_LEFT_SUBHEADER_ACTIONS,
  type BottomTerminalTab,
  type LeftSubheaderAction,
  type LeftSubheaderActionByTab,
} from "./terminal-shell-config";
import { stockMarketSelection } from "./venue-routing";
import { LeftSubheaderBar } from "./left-subheader-bar";
import { DrawerResizeHandle } from "./drawer-resize-handle";
import {
  VenueAwareBottomContent,
  VenueAwareBottomHeader,
  VenueAwareChartPanel,
  VenueAwareCopyTradePanel,
  VenueAwareHeaderMetrics,
  VenueAwareLeftTabSync,
  VenueAwareMarketsFilterSync,
  VenueAwareMobileAccountScreen,
  VenueAwareRightOrders,
  VenueAwareRightPortfolio,
  VenueAwareRightPositions,
  VenueAwareSignalFeed,
  VenueAwareTradeRail,
} from "./venue-aware-panels";
import type { AccountMode } from "./terminal-account-types";
import {
  applyManualCopyPrefillLifecycle,
  consumeManualCopyPrefill,
  copyPrefillAccountMatches,
  createManualCopyPrefill,
  nextManualCopyNonce,
  type ManualCopyPrefillEvent,
  type PerpManualCopyPrefill,
  type StockManualCopyPrefill,
} from "@/components/trade/manual-copy-prefill";

type CenterWorkspaceMode = "chart" | "pulse";

// Drawer-layout constants + pure balancing math live in
// components/terminal/drawer-layout.ts (audit H7 extraction; unit tested).
// The account-sync wiring (hydration, the serialized write queue, the debounced
// save and the account half of a reset) lives in ./use-terminal-layout-sync,
// which also owns the two localStorage keys above it re-exports.
// The desktop drawer tab lists, the bottom activity tabs/venue views and the
// per-tab subheader filter config live in ./terminal-shell-config (audit H7
// extraction; unit tested directly there instead of by reading this file).

type BrokerAccount = {
  id: string;
  accountId: string | null;
  accountType: string | null;
  username: string | null;
};

function formatAccountLabel(account: BrokerAccount | undefined): string {
  if (!account) return "";
  return account.accountId || account.username || "Connected";
}

/**
 * Resolve the Alpaca account read for display without allowing React Query's
 * retained data from an errored request to look current.
 */
export function resolveHeaderAccountQueryState(input: {
  data:
    | {
        portfolioValue?: number | null;
        nonMarginableBuyingPower?: number | null;
      }
    | null
    | undefined;
  isError: boolean;
}) {
  const data = input.isError ? undefined : input.data;
  return {
    portfolioValue: data?.portfolioValue,
    buyingPower: data?.nonMarginableBuyingPower,
    failed: input.isError,
  };
}

/**
 * Icon per mobile chart tab. The tab list itself lives in `./mobile-shell` so it
 * stays testable without React; only the glyph is bound here.
 */
const MOBILE_CHART_TAB_ICONS: Record<MobileChartTab, LucideIcon> = {
  portfolio: BriefcaseBusiness,
  feed: Newspaper,
  ai: Bot,
};

/**
 * The mobile controller's one destination switch.
 *
 * The authenticated controller still owns every query and mutation. These
 * helpers only choose the already-built destination nodes, which gives the
 * responsive shell one compositional boundary and keeps Search/Chart
 * contextual instead of turning them into bottom-nav destinations.
 */
export interface MobileV2DestinationProps {
  screen: MobileScreen;
  markets: ComponentProps<typeof MobileMarketsScreen>;
  search: ReactNode;
  chart: ReactNode;
  traders: ComponentProps<typeof MobileTradersScreen> | ReactNode;
  account: ComponentProps<typeof MobileAccountScreen> | ReactNode;
}

/**
 * Shared width, gutter, and bottom breathing room for contextual destinations.
 * Search and Chart are controller-owned nodes rather than standalone screen
 * components, so they need this same frame that Markets/Traders/Account
 * provide themselves.
 */
export function MobileV2DestinationShell({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      data-mobile-v2-destination-shell="true"
      className="mx-auto min-w-0 w-full max-w-[760px] overflow-x-clip px-3 pb-8 pt-3 sm:px-4"
    >
      {children}
    </div>
  );
}

export interface MobileSearchSurfaceProps {
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  searchDisabled: boolean;
  onBack: () => void;
  onQueryChange: (value: string) => void;
  onClear: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  browse: ReactNode;
}

/**
 * Natural-flow frame for the controller-owned mobile Search destination. The
 * frame owns only compact search chrome; the supplied browse surface keeps its
 * venue filters, market selection, and direct Trade actions.
 */
export function MobileSearchSurface({
  query,
  inputRef,
  searchDisabled,
  onBack,
  onQueryChange,
  onClear,
  onSubmit,
  browse,
}: MobileSearchSurfaceProps) {
  return (
    <section
      data-mobile-search-surface="true"
      className="min-w-0 space-y-3"
    >
      <div
        data-mobile-search-header="true"
        className="sticky top-0 z-20 -mx-3 space-y-2 border-b border-border/60 bg-background/95 px-3 pb-2 pt-1 backdrop-blur sm:-mx-4 sm:px-4"
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back from search"
            className="h-11 w-11"
            onClick={onBack}
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        </div>
        <form
          data-mobile-search-form="true"
          onSubmit={onSubmit}
          className="min-w-0"
        >
          <div className="flex h-12 min-w-0 items-center gap-2 rounded-xl border bg-background px-3 focus-within:ring-2 focus-within:ring-primary/40">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              aria-label="Search markets"
              autoCapitalize="characters"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-data text-base font-semibold uppercase outline-none [&::-webkit-search-cancel-button]:hidden"
              placeholder="Ticker, coin or company"
            />
            {query && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                aria-label="Clear market search"
                onClick={onClear}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            {!searchDisabled && (
              <Button
                type="submit"
                size="sm"
                className="h-11 shrink-0"
                aria-label="Open the searched market"
              >
                Open
              </Button>
            )}
          </div>
        </form>
      </div>

      {browse}
    </section>
  );
}

export function renderMobileV2Destination({
  screen,
  markets,
  search,
  chart,
  traders,
  account,
}: MobileV2DestinationProps): ReactNode {
  switch (screen) {
    case "markets":
      return <MobileMarketsScreen {...markets} />;
    case "search":
      return <MobileV2DestinationShell>{search}</MobileV2DestinationShell>;
    case "chart":
      return <MobileV2DestinationShell>{chart}</MobileV2DestinationShell>;
    case "traders":
      return isValidElement(traders) ? traders : <MobileTradersScreen {...(traders as ComponentProps<typeof MobileTradersScreen>)} />;
    case "account":
      return isValidElement(account) ? account : <MobileAccountScreen {...(account as ComponentProps<typeof MobileAccountScreen>)} />;
  }
}

export interface MobileV2ShellRenderProps
  extends Omit<MobileV2DestinationProps, "screen"> {
  screen: MobileScreen;
  header: ReactNode;
  notice?: ReactNode;
  /** Persistent primary action pinned above the navigation (chart screen). */
  actionBar?: ReactNode;
  navigation: ReactNode;
  overlay?: ReactNode;
  /** Isolate the shell from assistive technology while a modal is open. */
  modalOpen?: boolean;
}

function hasRenderableMobileOverlay(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false;
}

export function renderMobileV2Shell({
  screen,
  header,
  notice,
  actionBar,
  navigation,
  overlay,
  modalOpen,
  ...destinations
}: MobileV2ShellRenderProps): ReactNode {
  // An overlay supplied by older callers is itself enough evidence that the
  // frame is behind a modal. `modalOpen` additionally covers the trade sheet,
  // which is intentionally rendered beside the frame so it can own focus.
  const backgroundIsolated =
    modalOpen ?? hasRenderableMobileOverlay(overlay);

  return (
    <>
      <div
        data-mobile-v2-background="true"
        aria-hidden={backgroundIsolated ? "true" : undefined}
        inert={backgroundIsolated ? true : undefined}
        className="contents"
      >
        <MobileV2Frame
          header={header}
          notice={notice}
          contentKey={screen}
          content={renderMobileV2Destination({ screen, ...destinations })}
          actionBar={actionBar}
          navigation={navigation}
          overlay={null}
        />
      </div>
      {overlay}
    </>
  );
}

/**
 * The mobile venue control, routed rather than pinned.
 *
 * It used to be a bar between the app header and `main` on every destination
 * except Markets, which had already folded it into its own control row. That
 * cost 49px of permanent chrome on Trade, Traders, Account and Search, and on
 * Account and Search the control changed nothing at all: those screens render
 * both venues at once (or own their own scope), and read the venue nowhere.
 *
 * `mobileScreenHostsVenueSwitch` is the whole rule and lives beside the
 * screens it describes; this only turns its answer into the element, so the
 * three venue-scoped destinations can host it inside a row they already
 * paint. A deployment without perps has nothing to switch between and gets
 * null, so no screen pays a cell for it either.
 */
export function mobileVenueSwitchForScreen(
  screen: MobileScreen,
  perpsEnabled: boolean,
): ReactNode {
  return mobileScreenHostsVenueSwitch(screen, perpsEnabled) ? (
    <VenueSwitch showLabels fill />
  ) : null;
}

/**
 * Keep the mobile Traders strip as the owner of destination navigation while
 * leaving the copy feed's own source controls reachable. A venue-scoped Copy
 * feed still needs All / Following / Callers / Users: locking it to Following
 * made other users' perp fills impossible to discover on a phone. The outer
 * strip chooses the surface (feed or leaderboard); the inner source row
 * chooses which copy activity that surface queries.
 */
export function mobileCopyFeedProps(
  props: ComponentProps<typeof VenueAwareCopyTradePanel>,
): ComponentProps<typeof VenueAwareCopyTradePanel> {
  return { ...props, hideSourceTabs: false, lockSource: undefined };
}

/**
 * Scope the Feed tab's explicit venue filter to the existing signal feed.
 * `VenueAwareSignalFeed` remains the only owner of its query, polling,
 * pagination and selection builders; the explicit override keeps this local
 * Feed filter from mutating the app-wide venue context.
 */
function MobileFeedSignalFeed({
  venueFilter,
  onShowAllSignals,
  ...props
}: {
  venueFilter: MobileFeedVenueFilter;
  onShowAllSignals: () => void;
} & Pick<
  ComponentProps<typeof VenueAwareSignalFeed>,
  | "isSignedIn"
  | "onSelectSignal"
  | "onPerpCopyPrefill"
  | "onViewSignal"
  | "selectedSignalId"
>) {
  return (
    <VenueAwareSignalFeed
      {...props}
      embedded
      scrollsWithPage
      signalVenueFilter={venueFilter}
      tickerClickVenue={mobileFeedTickerClickVenue(venueFilter)}
      onShowAllSignals={onShowAllSignals}
    />
  );
}

/**
 * An All feed contains both signal kinds. Keep perp ticker identity on perps;
 * stock chips already select stocks explicitly in SignalFeed.
 */
export function mobileFeedTickerClickVenue(
  venueFilter: MobileFeedVenueFilter,
): "stocks" | "perps" {
  return venueFilter === "stocks" ? "stocks" : "perps";
}

/**
 * Name the chart's in-flow Back action after the contextual destination that
 * will receive it. Primary destinations intentionally fall back to a neutral
 * label because the chart may have been reached from browser history rather
 * than from a single known surface.
 */
export function mobileChartBackLabel(
  state: Pick<MobileLocationState, "screen" | "origin">,
): string {
  switch (mobileBackTarget(state)) {
    case "markets":
      return "Back to Markets";
    case "traders":
      return "Back to Traders";
    case "search":
      return "Back to Search";
    case "account":
      return "Back to Account";
    default:
      return "Back to previous screen";
  }
}

export function TradingAppContent() {
  const { data: session } = useSession();
  const isSignedIn = !!session?.user;
  const isDesktopViewport = useMediaQuery(DESKTOP_TERMINAL_MEDIA_QUERY);
  const responsiveShellMode: ResponsiveShellMode =
    isDesktopViewport === null
      ? null
      : isDesktopViewport
        ? "desktop"
        : "mobile";
  const [selectedSignal, setSelectedSignal] = useState<SelectedSignal | null>(null);
  const [activeSymbol, setActiveSymbol] = useState("SPY");
  const [activeCoin, setActiveCoin] = useState("BTC");
  // Bridge to the venue context's `selectMarket` (published by VenueProvider,
  // which renders below this component). Lets the pick handlers here flip to the
  // perps venue when a crypto ticker is chosen, without threading props.
  const selectMarketRef = useRef<((selection: MarketSelection) => void) | null>(null);
  // Crypto-ticker venue routing: resolves a picked symbol to stocks / perps /
  // "none" from the loaded perp universe. Drives HL-1/HL-2 (route crypto to
  // perps instead of an empty stock chart) and the "not available here" guard.
  const symbolVenueRouter = useSymbolVenueRouter({ enabled: isSignedIn });
  // Copy Trade prefill state is parent-owned and nonce-tagged. The child marks
  // an event consumed after applying it, so a mobile unmount/remount cannot
  // replay an old side, quantity, leverage, or order state.
  const [activeSide, setActiveSide] = useState<"buy" | "sell" | undefined>(undefined);
  const [activeQty, setActiveQty] = useState<number | undefined>(undefined);
  const [activeStockCopy, setActiveStockCopy] = useState<
    ManualCopyPrefillEvent<StockManualCopyPrefill> | null
  >(null);
  const stockCopyNonceRef = useRef(0);
  const [selectedCopyItemId, setSelectedCopyItemId] = useState<string | undefined>(undefined);
  const [activePerpCopy, setActivePerpCopy] = useState<
    ManualCopyPrefillEvent<PerpManualCopyPrefill> | null
  >(null);
  // One identity sequence for both direct actions and manual Copy, so clearing
  // a channel never reuses a nonce already applied by the mounted perp form.
  const perpCopyNonceRef = useRef(0);
  const [copyResetNonce, setCopyResetNonce] = useState(0);
  const activeStockCopyRef = useRef(activeStockCopy);
  activeStockCopyRef.current = activeStockCopy;
  const activePerpCopyRef = useRef(activePerpCopy);
  activePerpCopyRef.current = activePerpCopy;
  const selectedAccountAtRenderRef = useRef<{
    credentialId?: string;
    accountType?: AccountMode;
  }>({});
  // Perp-signal copy prefill: direction + leverage pushed into the perp trade
  // form when a perp call is copied from the X Signals feed. The coin + venue
  // flip are handled by the venue context's `selectMarket`; these two seed the
  // perp form via a nonce so a repeat copy re-applies.
  const [activePerpSide, setActivePerpSide] = useState<"long" | "short" | undefined>(undefined);
  const [activePerpLeverage, setActivePerpLeverage] = useState<number | undefined>(undefined);
  const [perpPrefillNonce, setPerpPrefillNonce] = useState(0);
  // The coin a perp prefill was copied FOR, so a stale side/leverage can never
  // be applied to a different market after a remount or a coin change.
  const [activePerpPrefillCoin, setActivePerpPrefillCoin] = useState<string | undefined>(
    undefined,
  );
  // A price clicked in the DESKTOP perps order book, as HL's raw decimal
  // string. It rides the same nonce as the side/leverage prefill above, so
  // every other perp prefill path must clear it or a stale level would be
  // re-stamped onto the next copy.
  const [activePerpLimitPrice, setActivePerpLimitPrice] = useState<string | undefined>(
    undefined,
  );
  const [accountMode, setAccountMode] = useState<AccountMode>("PAPER");
  const [terminalLayout, setTerminalLayout] =
    useState<TerminalLayoutState>(DEFAULT_TERMINAL_LAYOUT);
  const [terminalLayoutHydrated, setTerminalLayoutHydrated] = useState(false);

  /**
   * Synchronously read the Discovery-collapsed preference from localStorage
   * BEFORE the browser paints, so the sidebar never flashes from collapsed to
   * expanded on every page load. useLayoutEffect is the right tool here because:
   *   - it runs on the client only (SSR renders the default collapsed state)
   *   - it runs synchronously after the DOM is ready but before paint, so React
   *     commits the update in the same frame as the initial render
   *   - useEffect would run AFTER paint, producing a visible collapsed→expanded
   *     flash on every load
   * This reads only the collapsed key, not the full layout; the full layout
   * (tabs, widths, account sync) is reconciled by useTerminalLayoutSync below.
   */
  useLayoutEffect(() => {
    const raw = window.localStorage.getItem(DISCOVERY_COLLAPSED_STORAGE_KEY);
    const collapsed = parseDiscoveryCollapsed(raw);
    if (collapsed === null) return; // no preference stored yet; keep default
    setTerminalLayout((layout) =>
      layout.left.collapsed === collapsed
        ? layout // already correct, no re-render
        : { ...layout, left: { ...layout.left, collapsed } },
    );
  }, []);
  const [leftSubheaderActionsByPane, setLeftSubheaderActionsByPane] = useState<
    Record<string, LeftSubheaderActionByTab>
  >({});
  const [leftSubheaderCommandsByPane, setLeftSubheaderCommandsByPane] = useState<
    Record<string, number>
  >({});
  const [leftDrawerWidth, setLeftDrawerWidth] = useState(() => {
    if (typeof window === "undefined") return LEFT_DRAWER_MAX_WIDTH;
    const stored = parseStoredDrawerWidths(
      window.localStorage.getItem(TERMINAL_DRAWER_WIDTHS_STORAGE_KEY),
    );
    return stored.left ?? LEFT_DRAWER_MAX_WIDTH;
  });
  const [rightDrawerWidth, setRightDrawerWidth] = useState(() => {
    if (typeof window === "undefined") return RIGHT_DRAWER_DEFAULT_WIDTH;
    const stored = parseStoredDrawerWidths(
      window.localStorage.getItem(TERMINAL_DRAWER_WIDTHS_STORAGE_KEY),
    );
    return stored.right ?? RIGHT_DRAWER_DEFAULT_WIDTH;
  });
  const [terminalViewportWidth, setTerminalViewportWidth] = useState(1440);
  const [resizingDrawer, setResizingDrawer] = useState<"left" | "right" | null>(null);
  const [aiPopoutOpen, setAiPopoutOpen] = useState(false);
  // Per-row state for the Signa Signals tab: when "Copy signal" is clicked
  // we push entry/stop/target into the trade form via initialStopLoss /
  // initialTakeProfit. The selected ticker stays highlighted in the list.
  const [activeSignaStop, setActiveSignaStop] = useState<number | undefined>(undefined);
  const [activeSignaTarget, setActiveSignaTarget] = useState<number | undefined>(undefined);
  const [activeSignaEntry, setActiveSignaEntry] = useState<number | undefined>(undefined);
  // Explicit order type + limit price for a chat order draft. Undefined for
  // Signa "Copy signal" (which relies on the stop+target -> OCO default), so a
  // plain Market or Limit draft shows the ticket the user actually asked for.
  const [activeSignaOrderType, setActiveSignaOrderType] = useState<
    SignalPrefillOrderType | undefined
  >(undefined);
  const [activeSignaLimitPrice, setActiveSignaLimitPrice] = useState<number | undefined>(undefined);
  // OCO entry-leg type + explicit direction for a chat order draft. The entry
  // type keeps a limit bracket's Limit entry on the OCO ticket; the direction
  // makes a "short X" draft open a short (SellShort) instead of a plain Sell.
  const [activeSignaEntryOrderType, setActiveSignaEntryOrderType] = useState<
    SignalPrefillEntryOrderType | undefined
  >(undefined);
  const [activeSignaDirection, setActiveSignaDirection] = useState<
    SignalPrefillDirection | undefined
  >(undefined);
  // Time in force for a chat order draft. Undefined for Signa "Copy signal"
  // and plain flows, so the form's TIF default survives when no draft set it.
  const [activeSignaTimeInForce, setActiveSignaTimeInForce] = useState<
    SignalPrefillTimeInForce | undefined
  >(undefined);
  const [selectedSignaTicker, setSelectedSignaTicker] = useState<string | undefined>(undefined);
  const [chatDraftPrompt, setChatDraftPrompt] = useState<{ id: number; text: string } | null>(null);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>(DEFAULT_MOBILE_LOCATION.screen);
  const [mobileScreenOrigin, setMobileScreenOrigin] =
    useState<MobileHistoryOrigin | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileFeedVenueFilter, setMobileFeedVenueFilter] =
    useState<MobileFeedVenueFilter>("all");
  const [mobileChartTab, setMobileChartTab] = useState<MobileChartTab>(
    DEFAULT_MOBILE_CHART_TAB,
  );
  const [mobileChartCurrentTickerOnly, setMobileChartCurrentTickerOnly] =
    useState(true);
  // Which Traders tab is mounted: the signal feed, the following feed, one of
  // the two leaderboards, or the watchlist. Exactly one is rendered at a time;
  // the others are unmounted, not hidden, so nothing polls off-screen.
  const [mobileTradersTab, setMobileTradersTab] = useState<MobileTradersTab>(
    DEFAULT_MOBILE_LOCATION.tradersTab,
  );
  const [mobileAccountTab, setMobileAccountTab] =
    useState<MobileAccountTab>("positions");
  // Plan A8. Which surface the mobile Portfolio tab is showing: the venue
  // breakdown, or one venue drilled into. Requested value only; what actually
  // renders is resolved against the connected venues below.
  const [mobilePortfolioView, setMobilePortfolioView] =
    useState<MobilePortfolioView>("overview");
  const [bottomTerminalTab, setBottomTerminalTab] =
    useState<BottomTerminalTab>("positions");
  const [centerWorkspaceMode, setCenterWorkspaceMode] =
    useState<CenterWorkspaceMode>("chart");
  const [mobileSearchSymbol, setMobileSearchSymbol] = useState(activeSymbol);
  // Blanks the search input without clearing the remembered symbol. Plan A5 set
  // this on entry: Search now opens on a browse surface (Recents plus the market
  // rankings), and pre-filling the box with the active symbol would hide all of
  // it behind a search for a ticker the user is already looking at.
  const [clearMobileSearchOnOpen, setClearMobileSearchOnOpen] = useState(false);
  // Plan A5 + S3. Search owns a four-way browse filter, including People. The
  // Markets destination has its own market-only filter so choosing People in
  // Search cannot leak an unsupported tab into the Markets browse panel when
  // the user navigates back.
  const [mobileSearchBrowseFilter, setMobileSearchBrowseFilter] =
    useState<MobileBrowseTab>("all");
  const [mobileMarketsBrowseFilter, setMobileMarketsBrowseFilter] =
    useState<MarketSearchFilter>("all");
  const [mobileTradeSheetOpen, setMobileTradeSheetOpen] = useState(false);
  const [mobileHistoryMarket, setMobileHistoryMarket] =
    useState<MarketSelection | null>(null);
  const [mobileHistoryHydrated, setMobileHistoryHydrated] = useState(false);
  const mobileHistoryWriteModeRef = useRef<"push" | "replace">("replace");
  // The Trade home seeds its symbol slots from persisted Recents once per mount;
  // a later desktop-to-mobile resize re-runs hydration and must not overwrite them.
  const mobileLandingSeededRef = useRef(false);
  // Search and Chart are contextual screens, so a Chart opened from Search
  // needs to remember Search's own origin when its in-flow Back returns there
  // (Feed -> Search -> Chart -> Back -> Search(origin Feed)).
  const mobileContextOriginTrailRef = useRef<MobileHistoryOrigin[]>([]);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  // Middle (chart) column - used to scroll the chart into view when a signal is
  // tapped on narrow viewports, where the signal list sits below the chart.
  // The mobile trade ticket is `aria-modal`, which promises assistive tech that
  // nothing outside it is reachable. Keyed on the open flag because the sheet is
  // rendered conditionally inside this long-lived component rather than mounted
  // and unmounted on its own. Shares `use-modal-focus` with the caller sheet, so
  // there is one implementation rather than two that drift.
  const closeMobileTradeSheet = useCallback(
    () => {
      const stock = activeStockCopyRef.current;
      const perp = activePerpCopyRef.current;
      if (stock) cancelStockCopyPrefill(stock.nonce);
      if (perp) cancelPerpCopyPrefill(perp.nonce);
      setMobileTradeSheetOpen(false);
    },
    [],
  );
  const tradeSheetRef = useModalFocus({
    onClose: closeMobileTradeSheet,
    isOpen: mobileTradeSheetOpen,
  });

  const chartColumnRef = useRef<HTMLDivElement>(null);

  /**
   * Keep mobile navigation in the URL without ever putting the Trade sheet in
   * history. Primary destinations are pushed; popstate and the initial deep
   * link are replaced so Back returns to the surface the user came from.
   */
  const setMobileDestination = (
    screen: MobileScreen,
    origin: MobileHistoryOrigin | null = null,
    historyMode: "push" | "replace" = "push",
  ) => {
    if (mobileScreen === screen && mobileScreenOrigin === origin) {
      // A repeated tap on the active destination is a no-op. In particular it
      // must not leave a pending push mode that the next unrelated state update
      // turns into a duplicate URL entry.
      mobileHistoryWriteModeRef.current = "replace";
      return;
    }
    // A destination with no origin is a primary one (a nav tap, including
    // Trade landing on the chart), so any contextual trail behind it is over.
    if (origin === null) {
      mobileContextOriginTrailRef.current = [];
    }
    setMobileScreen(screen);
    setMobileScreenOrigin(origin);
    mobileHistoryWriteModeRef.current = historyMode;
  };

  // Desktop chart/position interactions still use these shared handlers, but
  // mobile history must remain a mobile-only concern. Guarding the market
  // write prevents an xl interaction from unexpectedly rewriting the URL with
  // a mobile `market=` query while preserving the same handler contracts.
  const rememberMobileHistoryMarket = (market: MarketSelection) => {
    if (
      typeof window === "undefined" ||
      isNarrowViewport(window.innerWidth)
    ) {
      setMobileHistoryMarket(market);
    }
  };

  const currentMobileOrigin = (): MobileHistoryOrigin => {
    // A chart with no origin is the Trade home screen, and is its own origin:
    // Search opened from it comes back to it, not to Markets.
    if (mobileScreen === "chart") return mobileScreenOrigin ?? "chart";
    if (mobileScreen === "search") {
      return mobileScreenOrigin ?? DEFAULT_MOBILE_LOCATION.screen;
    }
    return mobileScreen;
  };

  const openMobileContextualScreen = (
    screen: "search" | "chart",
    origin = currentMobileOrigin(),
  ) => {
    if (mobileScreen !== screen || mobileScreenOrigin !== origin) {
      const previousOrigin =
        mobileScreen === "search" || mobileScreen === "chart"
          ? mobileScreenOrigin
          : null;
      if (previousOrigin) {
        mobileContextOriginTrailRef.current.push(previousOrigin);
      }
    }
    setMobileDestination(screen, origin);
  };

  const goBackMobileContext = () => {
    const target = mobileBackTarget({
      screen: mobileScreen,
      origin: mobileScreenOrigin,
    });
    if (
      typeof window !== "undefined" &&
      mobileBackHistoryMode(
        { screen: mobileScreen, origin: mobileScreenOrigin },
        window.history.state,
      ) === "pop"
    ) {
      // Contextual destinations are pushed entries. Consuming the current
      // entry keeps an in-flow Back followed by browser Back from revisiting
      // the stale Search/Chart entry underneath it.
      mobileContextOriginTrailRef.current = [];
      window.history.back();
      return;
    }
    const targetOrigin =
      (target === "search" || target === "chart") &&
      mobileContextOriginTrailRef.current.length > 0
        ? mobileContextOriginTrailRef.current.pop() ?? null
        : null;
    // A deep link has no controller-owned preceding entry to consume, so
    // replace it in place and keep the user inside the app.
    setMobileDestination(target, targetOrigin, "replace");
  };

  const applyMobileLocation = (location: MobileLocationState) => {
    mobileContextOriginTrailRef.current = [];
    setMobileScreen(location.screen);
    setMobileScreenOrigin(location.origin);
    setMobileTradersTab(location.tradersTab);
    setMobileAccountTab(location.accountTab);
    setMobileHistoryMarket(location.market);
    if (location.market) {
      if (location.market.venue === "stocks") {
        setActiveSymbol(location.market.symbol);
        setMobileSearchSymbol(location.market.symbol);
      } else {
        setActiveCoin(location.market.symbol);
      }
      // The provider is rendered below this controller. Its effect publishes
      // the bridge before this parent effect runs in the browser; the null
      // guard keeps SSR and a cold mount harmless.
      selectMarketRef.current?.(location.market);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined" || responsiveShellMode !== "mobile") {
      setMobileHistoryHydrated(false);
      return;
    }
    const location = parseMobileLocation(window.location.search, {
      ...DEFAULT_MOBILE_LOCATION,
      market: null,
    });
    applyMobileLocation(location);
    if (!mobileLandingSeededRef.current) {
      mobileLandingSeededRef.current = true;
      // Trade lands on each venue's last picked instrument (persisted Recents),
      // the URL market winning for its venue; first run keeps SPY / BTC. The
      // persisted venue, not the recent pick, decides which slot is shown.
      const landing = mobileLandingSlots(
        readRecentMarkets(browserRecentMarketsStore(), PERPS_ENABLED),
        location.market,
      );
      if (landing.stocks) {
        setActiveSymbol(landing.stocks);
        setMobileSearchSymbol(landing.stocks);
      }
      if (landing.perps) setActiveCoin(landing.perps);
    }
    mobileHistoryWriteModeRef.current = "replace";
    setMobileHistoryHydrated(true);
    // The URL is the source of truth only at mount. Subsequent navigation is
    // represented by the state-to-history effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responsiveShellMode]);

  useEffect(() => {
    if (typeof window === "undefined" || responsiveShellMode !== "mobile") {
      return;
    }
    const onPopState = () => {
      const location = parseMobileLocation(window.location.search, {
        screen: mobileScreen,
        origin: mobileScreenOrigin,
        market: mobileHistoryMarket,
        accountTab: mobileAccountTab,
        tradersTab: mobileTradersTab,
      });
      mobileHistoryWriteModeRef.current = "replace";
      applyMobileLocation(location);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // The listener must read the latest state only when a popstate occurs;
    // refs would add unnecessary complexity to this small controller bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responsiveShellMode]);

  useEffect(() => {
    if (
      responsiveShellMode !== "mobile" ||
      !mobileHistoryHydrated ||
      typeof window === "undefined"
    ) {
      return;
    }
    const serializedLocation = serializeMobileLocation({
      screen: mobileScreen,
      origin: mobileScreenOrigin,
      market: mobileHistoryMarket,
      accountTab: mobileAccountTab,
      tradersTab: mobileTradersTab,
    });
    const nextSearch = mergeMobileLocationSearch(
      window.location.search,
      serializedLocation,
    );
    if (window.location.search === nextSearch) {
      mobileHistoryWriteModeRef.current = "replace";
      return;
    }
    const method = mobileHistoryWriteModeRef.current;
    const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
    if (method === "push") {
      window.history.pushState(
        mobileHistoryPushState(window.history.state),
        "",
        nextUrl,
      );
    } else {
      window.history.replaceState({}, "", nextUrl);
    }
    mobileHistoryWriteModeRef.current = "replace";
  }, [
    mobileAccountTab,
    mobileTradersTab,
    mobileHistoryHydrated,
    mobileHistoryMarket,
    mobileScreen,
    mobileScreenOrigin,
    responsiveShellMode,
  ]);

  // Account sync for the workspace: hydration precedence, the serialized
  // cross-mount write queue, the debounced account save, and the flush on
  // unmount. Extracted per audit H7 (stateful logic to a named hook) so a bug in
  // it is reachable from a test rather than only by reading this file.
  const layoutSync = useTerminalLayoutSync({
    isSignedIn,
    userId: session?.user?.id ?? null,
    terminalLayout,
    setTerminalLayout,
    terminalLayoutHydrated,
    setTerminalLayoutHydrated,
    leftDrawerWidth,
    setLeftDrawerWidth,
    rightDrawerWidth,
    setRightDrawerWidth,
  });

  const rightModulePaneSignature = terminalLayout.right.panes
    .map((pane) => `${pane.id}:${pane.tab}`)
    .join("|");

  useEffect(() => {
    setTerminalLayout((layout) => {
      if (layout.right.panes.length < 2) return layout;

      const usedTabs = new Set<RightTerminalTab>();
      let changed = false;
      const panes = layout.right.panes.map((pane) => {
        if (!usedTabs.has(pane.tab)) {
          usedTabs.add(pane.tab);
          return pane;
        }

        const replacement = RIGHT_TERMINAL_TAB_VALUES.find(
          (tab) => !usedTabs.has(tab),
        );
        if (!replacement) return pane;

        changed = true;
        usedTabs.add(replacement);
        return { ...pane, tab: replacement };
      });

      return changed
        ? { ...layout, right: { ...layout.right, panes } }
        : layout;
    });
  }, [rightModulePaneSignature]);

  useEffect(() => {
    const updateViewportWidth = () => setTerminalViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    if (!terminalLayoutHydrated) return;
    window.localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      serializeTerminalLayout(terminalLayout),
    );
  }, [terminalLayout, terminalLayoutHydrated]);

  useEffect(() => {
    if (!terminalLayoutHydrated) return;
    window.localStorage.setItem(
      DISCOVERY_COLLAPSED_STORAGE_KEY,
      String(terminalLayout.left.collapsed),
    );
  }, [terminalLayout.left.collapsed, terminalLayoutHydrated]);

  useEffect(() => {
    if (!terminalLayoutHydrated) return;
    window.localStorage.setItem(
      TERMINAL_DRAWER_WIDTHS_STORAGE_KEY,
      JSON.stringify({ left: leftDrawerWidth, right: rightDrawerWidth }),
    );
  }, [leftDrawerWidth, rightDrawerWidth, terminalLayoutHydrated]);

  // #162 replaces main's plain body-overflow lock with this one: it is scoped to
  // the mobile shell, because `mobileTradeSheetOpen` survives a resize past xl
  // where the sheet is not rendered at all and a locked document would freeze
  // the terminal the user can actually see.
  // Plan A1. One scroll owner while the ticket is up. The sheet's scrim and its
  // own `overscroll-contain` handle chaining inside the mobile shell; this lock
  // stops the page BEHIND the shell from rubber-banding. Scoped to the mobile
  // shell so the two never disagree: `mobileTradeSheetOpen` survives a resize
  // past xl, where the sheet is not rendered at all and a locked document would
  // freeze the terminal the user can actually see.
  useEffect(
    () =>
      tradeSheetScrollLockEffect({
        sheetOpen: mobileTradeSheetOpen,
        shellMode: responsiveShellMode,
        doc: document,
      }),
    [mobileTradeSheetOpen, responsiveShellMode],
  );

  // ALPACA ONLY. Hyperliquid lives in the same credentials table (settings
  // filters it out of the Broker tab for the same reason), and its row carries
  // accountType LIVE: unfiltered, a perps-only user's HL row was picked up as
  // the "live account", flipped the account mode to LIVE, marked stocks as
  // connected in the bottom-drawer layout, and fed an HL credential id into
  // every Alpaca-backed query on this page.
  const credentialsQuery = useCompleteApiCredentials("alpaca", {
    enabled: !!session?.user,
  });

  // Perps enablement status, fetched at the page level so the unified search
  // (wrong-venue messaging) and the sectioned "All" bottom view can read the HL
  // wallet/enabled state regardless of which venue is currently being traded.
  // Shares the React Query cache with the venue context's own status query.
  const perpsStatusQuery = trpc.hyperliquid.status.useQuery(undefined, {
    enabled: !!session?.user && PERPS_ENABLED,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const perpsEnabled = perpsStatusQuery.data?.enabled ?? false;
  // Whether that `false` is knowledge. The bottom drawer's layout must not
  // treat "status still loading" as "perps not configured": the flag defaults
  // to false while the read is in flight, which is unknown, not no.
  const perpsStatusIsSettled = perpsStatusSettled({
    wired: PERPS_ENABLED,
    isSignedIn: !!session?.user,
    statusSucceeded: perpsStatusQuery.isSuccess,
  });
  const perpsWalletAddress = perpsStatusQuery.data?.walletAddress ?? null;
  // EQUITY, not the collateral balance. Every surface below presents this as
  // "what the user has on Hyperliquid" (the cross-venue total, the nav balance,
  // the header's account-value cell), and collateral excludes spot holdings
  // entirely: a unified account holding non-USDC spot measured $3.9k collateral
  // against $35.1k of actual value. The trade ticket and onboarding still read
  // `hlBalanceUsd`, because what can back an order is a different question.
  const headerPerpsEquity = perpsStatusQuery.data?.hlEquityUsd;

  const brokerAccounts = credentialsQuery.accounts;
  // Legacy rows without broker identity remain linked to existing exposure;
  // only an identified account may become a fresh terminal order destination.
  // Match both "PAPER" and the legacy "SIM" value that old credential rows
  // carry. The orders router already accepts both; without this the frontend
  // filter misses SIM rows, leaving paperAccount undefined, which hides the
  // toggle and causes the useEffect below to auto-force the user into LIVE
  // with no way to switch back.
  const paperAccount = findUsableAlpacaAccount(brokerAccounts, "PAPER");
  const liveAccount = findUsableAlpacaAccount(brokerAccounts, "LIVE");

  useEffect(() => {
    if (accountMode === "PAPER" && !paperAccount && liveAccount) {
      setAccountMode("LIVE");
    }
    if (accountMode === "LIVE" && !liveAccount && paperAccount) {
      setAccountMode("PAPER");
    }
  }, [accountMode, liveAccount, paperAccount]);

  const selectedAccount = accountMode === "LIVE" ? liveAccount : paperAccount;
  const selectedCredentialId = selectedAccount?.id;
  const selectedAccountType = selectedAccount ? accountMode : undefined;
  const selectedAccountLabel = formatAccountLabel(selectedAccount);

  const settleStockCopyPrefill = useCallback(
    (nonce: number, lifecycle: "completed" | "cancelled") => {
      const event = activeStockCopyRef.current;
      if (!event || event.nonce !== nonce) return;
      const sourceItemId = event.value.copySourceItemId;
      setActiveStockCopy((current) =>
        applyManualCopyPrefillLifecycle(current, nonce, lifecycle),
      );
      setSelectedCopyItemId((current) =>
        sourceItemId && current === sourceItemId ? undefined : current,
      );
      if (sourceItemId) {
        setSelectedSignal((current) =>
          current?.copySourceItemId === sourceItemId ? null : current,
        );
      }
    },
    [],
  );
  const completeStockCopyPrefill = useCallback(
    (nonce: number) => settleStockCopyPrefill(nonce, "completed"),
    [settleStockCopyPrefill],
  );
  const cancelStockCopyPrefill = useCallback(
    (nonce: number) => settleStockCopyPrefill(nonce, "cancelled"),
    [settleStockCopyPrefill],
  );

  const settlePerpCopyPrefill = useCallback(
    (nonce: number, lifecycle: "completed" | "cancelled") => {
      const event = activePerpCopyRef.current;
      if (!event || event.nonce !== nonce) return;
      const sourceItemId = event.value.copySourceItemId;
      setActivePerpCopy((current) =>
        applyManualCopyPrefillLifecycle(current, nonce, lifecycle),
      );
      setSelectedCopyItemId((current) =>
        sourceItemId && current === sourceItemId ? undefined : current,
      );
      if (sourceItemId) {
        setSelectedSignal((current) =>
          current?.copySourceItemId === sourceItemId ? null : current,
        );
      }
    },
    [],
  );
  const completePerpCopyPrefill = useCallback(
    (nonce: number) => settlePerpCopyPrefill(nonce, "completed"),
    [settlePerpCopyPrefill],
  );
  const cancelPerpCopyPrefill = useCallback(
    (nonce: number) => settlePerpCopyPrefill(nonce, "cancelled"),
    [settlePerpCopyPrefill],
  );

  // A manual stock copy is tied to the credential whose buying power sized it.
  // If Paper/Live changes before or after the child applies the event, discard
  // the event and bump a reset nonce so the mounted ticket cannot submit a
  // copied quantity against a different account.
  useEffect(() => {
    const previousAccount = selectedAccountAtRenderRef.current;
    selectedAccountAtRenderRef.current = {
      credentialId: selectedCredentialId,
      accountType: selectedAccountType,
    };
    if (
      previousAccount.credentialId === selectedCredentialId &&
      previousAccount.accountType === selectedAccountType
    ) {
      return;
    }
    if (
      copyPrefillAccountMatches(
        activeStockCopy,
        selectedCredentialId,
        selectedAccountType,
      )
    ) {
      return;
    }

    if (activeStockCopy) cancelStockCopyPrefill(activeStockCopy.nonce);
    setSelectedCopyItemId(undefined);
    setCopyResetNonce((nonce) => nextManualCopyNonce(nonce));
  }, [activeStockCopy, cancelStockCopyPrefill, selectedAccountType, selectedCredentialId]);

  const headerAccountQuery = trpc.positions.account.useQuery(
    { credentialId: selectedCredentialId },
    { enabled: !!selectedCredentialId, refetchInterval: 60000 }
  );
  const headerAccountState = resolveHeaderAccountQueryState(headerAccountQuery);
  const headerPortfolioValue = headerAccountState.portfolioValue;
  // Use nonMarginableBuyingPower (cash floor) so the displayed figure
  // matches what Alpaca actually checks for non-marginable securities.
  // buyingPower is margin-inflated and can cause "insufficient buying
  // power" rejections even when the header shows plenty.
  const headerBuyingPower = headerAccountState.buyingPower;

  // Plan A7/A8. On a phone there is one portfolio across both venues. Whether
  // the perps half of every mobile account surface is shown at all: perps wired
  // for this deployment AND provisioned for this user, so a stocks-only user
  // never gets an empty perps section eating half the screen.
  const mobilePerpsConnected = showMobilePerpsSection({
    wired: PERPS_ENABLED,
    provisioned: perpsEnabled,
  });
  // Both inputs are already polled at page level (headerAccountQuery above,
  // perpsStatusQuery near the top), so the venue breakdown adds no query.
  // Both venues, tri-state. Either one still unresolved blocks a "complete"
  // total, and neither may claim the user does not trade there.
  const stocksVenueCheckFailed =
    credentialsQuery.isError || headerAccountState.failed;
  const stocksVenueState = venueConnectionState({
    // A signed-out user has no credentials to wait for.
    settled:
      !isSignedIn ||
      (credentialsQuery.isSuccess &&
        (!selectedCredentialId || headerAccountQuery.isSuccess)),
    connected: !!selectedCredentialId,
  });
  const perpsVenueState = venueConnectionState({
    settled: perpsStatusSettled({
      wired: PERPS_ENABLED,
      isSignedIn,
      statusSucceeded: perpsStatusQuery.isSuccess,
    }),
    connected: mobilePerpsConnected,
  });
  const mobilePortfolio = buildMobilePortfolio({
    stocksConnected: stocksVenueState,
    stocksValue: headerPortfolioValue,
    stocksBuyingPower: headerBuyingPower,
    perpsConnected: perpsVenueState,
    perpsValue: headerPerpsEquity,
    // Either read having given up is different from either read still running.
    venueCheckFailed:
      stocksVenueCheckFailed || perpsStatusQuery.isError,
  });
  const mobilePortfolioNavigation = resolveMobilePortfolioNavigation(
    mobilePortfolioView,
    mobilePortfolio,
  );
  // Plan A9. The same cross-venue total the Portfolio tab shows, rendered as the
  // label of its own nav destination so funding state is ambient on every mobile
  // screen. Null (and the static "Info" label stands) until a venue reports.
  const mobileNavBalance = describeMobileBalanceLabel(mobilePortfolio);
  const mobileAccountValueProps = resolveMobileAccountValueProps(mobilePortfolio);

  const tradeIsPrefilled =
    activeStockCopy != null ||
    activePerpCopy != null ||
    activeSide != null ||
    activeQty != null ||
    activeSignaEntry != null ||
    activeSignaStop != null ||
    activeSignaTarget != null ||
    activeSignaOrderType != null ||
    activeSignaLimitPrice != null ||
    activeSignaEntryOrderType != null ||
    activeSignaDirection != null ||
    activeSignaTimeInForce != null;

  const clearCopyPrefill = () => {
    if (activeStockCopy) cancelStockCopyPrefill(activeStockCopy.nonce);
    if (activePerpCopy) cancelPerpCopyPrefill(activePerpCopy.nonce);
    setSelectedCopyItemId(undefined);
    setActiveSide(undefined);
    setActiveQty(undefined);
    setActiveStockCopy(null);
    setActivePerpCopy(null);
    setPerpPrefillNonce(0);
    setActivePerpSide(undefined);
    setActivePerpLeverage(undefined);
    setActivePerpLimitPrice(undefined);
    setActivePerpPrefillCoin(undefined);
  };

  const consumeStockCopyPrefill = (nonce: number) => {
    setActiveStockCopy((event) => consumeManualCopyPrefill(event, nonce) ?? null);
  };

  const consumePerpCopyPrefill = (nonce: number) => {
    setActivePerpCopy((event) => consumeManualCopyPrefill(event, nonce) ?? null);
  };

  const clearSignaPrefill = () => {
    setActiveSignaEntry(undefined);
    setActiveSignaStop(undefined);
    setActiveSignaTarget(undefined);
    setActiveSignaOrderType(undefined);
    setActiveSignaLimitPrice(undefined);
    setActiveSignaEntryOrderType(undefined);
    setActiveSignaDirection(undefined);
    setActiveSignaTimeInForce(undefined);
    setSelectedSignaTicker(undefined);
  };

  const focusChartOnNarrowViewport = () => {
    if (typeof window !== "undefined" && isNarrowViewport(window.innerWidth)) {
      openMobileContextualScreen("chart");
      chartColumnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const openTradeSheetOnNarrowViewport = () => {
    if (typeof window !== "undefined" && isNarrowViewport(window.innerWidth)) {
      setMobileTradeSheetOpen(true);
      return true;
    }

    return false;
  };

  const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

  // Position and copy actions can originate while the terminal is showing
  // perps. Update the venue and stock slot together so chart and trade actions
  // reveal the requested equity instead of leaving the perp surface visible.
  const selectStockMarket = (symbol: string) => {
    const selection = stockMarketSelection(symbol);
    if (!selection) return null;
    selectMarketRef.current?.(selection);
    if (!selectMarketRef.current) setActiveSymbol(selection.symbol);
    return selection.symbol;
  };

  /**
   * Keeps the mobile search box showing the symbol the user just navigated to.
   *
   * It used to also maintain a stock-only, in-memory "recent tickers" list. Plan
   * A5 replaced that with the venue-tagged, persisted list in
   * `lib/recent-markets`, written from `handleMobileMarketPick`, because this
   * helper is called with an uppercased symbol and would have corrupted HL's
   * canonical perp casing (kPEPE) on the way in.
   */
  const rememberSymbol = (symbol: string, options: { syncSearch?: boolean } = {}) => {
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;
    if (options.syncSearch ?? true) {
      setClearMobileSearchOnOpen(false);
      setMobileSearchSymbol(nextSymbol);
    }
  };

  // Post-perps navigation for a routed pick: mirror what the stock path would
  // have done (focus the chart on narrow viewports, open the mobile chart, or
  // pop the mobile trade sheet).
  type CryptoRouteNav = "focus" | "chart" | "tradeSheet" | "none";

  // A ticker picked before `markets.perpUniverse` resolved, held so it can be
  // re-resolved once venue classification is actually available.
  const pendingCryptoRouteRef = useRef<{
    symbol: string;
    nav: CryptoRouteNav;
  } | null>(null);

  /** Tell the user a picked symbol has no datafeed on any usable venue, instead
   *  of pointing a chart at it and rendering an empty one. */
  const notifySymbolNotChartable = (symbol: string) => {
    toast.error(`${normalizeSymbol(symbol)} isn't available to chart here.`, {
      description: PERPS_ENABLED
        ? "This market has no stock or perp datafeed."
        : "It trades as a perp, which isn't enabled in this workspace.",
    });
  };

  /**
   * Route a picked ticker by venue BEFORE the stock path runs. Returns the
   * resolved target:
   *   - "stocks": a normal equity; the caller keeps its existing stock behavior.
   *   - "perps": a crypto coin (HYPE, BTC); this already flipped the venue + wrote
   *     the coin slot, so the caller stops (it may add perps-only navigation).
   *   - "none": no usable datafeed; this surfaced the "not available to chart
   *     here" guard, so the caller stops. Perps-disabled crypto lands here.
   */
  const routeIfCrypto = (
    symbol: string,
    nav: CryptoRouteNav = "focus",
  ): "stocks" | "perps" | "none" => {
    // Until the perp universe loads, nothing can be classified, so every ticker
    // resolves to stocks and a crypto pick would briefly chart as an empty
    // stock: the very bug this routing exists to fix. Remember the pick and
    // re-resolve it once the router is ready (see the effect below).
    if (!symbolVenueRouter.ready) {
      pendingCryptoRouteRef.current = { symbol, nav };
    }
    const route = symbolVenueRouter.resolveRoute(symbol);
    if (route.target === "stocks") return "stocks";

    if (route.target === "perps" && route.canonicalPerpSymbol) {
      const perpSelection: MarketSelection = {
        symbol: route.canonicalPerpSymbol,
        venue: "perps",
      };
      clearCopyPrefill();
      clearSignaPrefill();
      setSelectedSignal(null);
      setSelectedCopyItemId(undefined);
      // Flip the venue + write the perp coin slot in one action, reusing the
      // same `selectMarket` path the unified search uses.
      selectMarketRef.current?.(perpSelection);
      // A crypto pick can enter through the symbol-only legacy callbacks (for
      // example a watchlist row). Keep the venue-tagged identity in mobile
      // history just as the explicit-selection path does, so a refresh never
      // falls back to the stock slot or loses the HIP-3 namespace.
      rememberMobileHistoryMarket(perpSelection);
      rememberSymbol(route.canonicalPerpSymbol, { syncSearch: false });
      if (nav === "chart") openMobileContextualScreen("chart");
      // Mirror the stock path's viewport gate: opening the mobile trade sheet
      // from a DESKTOP surface would leave it open in state (invisible at xl)
      // and engage the body scroll lock, so a later resize pops a surprise
      // full-screen sheet.
      else if (nav === "tradeSheet") {
        landCopyPrefill({
          openTradeSheetOnNarrowViewport,
          focusChartOnNarrowViewport,
        });
      } else if (nav === "focus") focusChartOnNarrowViewport();
      return "perps";
    }

    // target === "none": no datafeed on a usable venue. Keep the current chart
    // and tell the user instead of blanking it. Perps-disabled crypto lands here.
    notifySymbolNotChartable(symbol);
    return "none";
  };

  // Re-resolve a pick that arrived before the perp universe loaded. Only acts
  // when that symbol is STILL the one on the chart, so a correction never yanks
  // the user away from something they navigated to in the meantime. A pick that
  // was genuinely an equity re-resolves to "stocks" and changes nothing.
  useEffect(() => {
    if (!symbolVenueRouter.ready) return;
    const pending = pendingCryptoRouteRef.current;
    pendingCryptoRouteRef.current = null;
    if (!pending) return;
    if (normalizeSymbol(pending.symbol) !== normalizeSymbol(activeSymbol)) return;
    routeIfCrypto(pending.symbol, pending.nav);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolVenueRouter.ready]);

  /**
   * Drop the "this order came from that call" context.
   *
   * `equityOrderSignalId` matches a stored signal to an order by SYMBOL, so a
   * selection that outlives the navigation which created it silently attributes
   * the next order on that ticker to a caller the user never acted on, and the
   * chart shows that caller's thesis over an unrelated visit. The desktop
   * handlers have always cleared this (`handleViewSymbol`); the mobile
   * navigation added here did not.
   *
   * Called by paths that constitute PICKING A MARKET. Not by "trade what is
   * already on screen", which is exactly the signal-originated case this
   * feature exists to preserve.
   */
  const clearSignalProvenance = () => {
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    setSelectedCopyItemId(undefined);
    setActiveSide(undefined);
    setActiveQty(undefined);
  };

  const openMobileChart = (symbol = activeSymbol, venue?: MarketVenue) => {
    clearSignalProvenance();
    if (venue) {
      handlePulseMarketView({ symbol, venue });
      return;
    }
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;
    if (routeIfCrypto(nextSymbol, "chart") !== "stocks") return;
    selectStockMarket(nextSymbol);
    rememberSymbol(nextSymbol);
    rememberMobileHistoryMarket({ symbol: nextSymbol, venue: "stocks" });
    openMobileContextualScreen("chart");
  };

  const openMobileTradeSheet = (symbol = activeSymbol, venue?: MarketVenue) => {
    if (venue) {
      if (handlePulseMarketView({ symbol, venue })) {
        activateRightTab("trade");
        setMobileTradeSheetOpen(true);
      }
      return;
    }
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;
    if (routeIfCrypto(nextSymbol, "tradeSheet") !== "stocks") return;
    selectStockMarket(nextSymbol);
    rememberSymbol(nextSymbol);
    rememberMobileHistoryMarket({ symbol: nextSymbol, venue: "stocks" });
    setMobileTradeSheetOpen(true);
  };

  /**
   * "Trade THIS one", from a list. Distinct from the chart CTA below, which
   * trades whatever is already on screen: that market may well be one the user
   * arrived at from a signal, and clearing there would strip the attribution
   * this feature exists to keep.
   */
  const pickMarketAndOpenTradeSheet = (symbol: string, venue?: MarketVenue) => {
    clearSignalProvenance();
    openMobileTradeSheet(symbol, venue);
  };

  // Venue-aware Trade entry shared by the bottom nav, the chart CTA, and the
  // header hamburger. Perps: the coin is already in activeCoin, just open the
  // sheet (the venue-aware trade rail renders the perp form). Stocks keep the
  // symbol-slot + recents side effects.
  const openTradeSheetForVenue = (isPerps: boolean) =>
    isPerps ? setMobileTradeSheetOpen(true) : openMobileTradeSheet(activeSymbol);

  /**
   * The signal-first escape from any empty state in a mobile account panel:
   * the Feed tab of the Traders destination, routed through the shared
   * destination/history adapter.
   */
  const openMobileSignals = () => {
    setMobileTradersTab("feed");
    setMobileDestination("traders");
  };

  /**
   * Plan A5. Search opens on a BROWSE surface, so it opens blank and without
   * stealing focus: seeding the active symbol would show a search for the market
   * already on screen, and auto-focusing would raise the keyboard over the very
   * Recents and rankings the blank state exists to show. The remembered symbol
   * is kept, so any caller that seeds one still wins.
   */
  const openMobileSearch = () => {
    setClearMobileSearchOnOpen(true);
    openMobileContextualScreen("search");
  };

  const mobileSearchInputValue = clearMobileSearchOnOpen ? "" : mobileSearchSymbol;
  const handleMobileSymbolPick = (symbol: string) => {
    setClearMobileSearchOnOpen(false);
    setMobileSearchSymbol(symbol);
    openMobileChart(symbol);
  };
  // Navigation-only side effect after a venue-aware unified-search pick. The
  // symbol slot + venue are already set by the context's `selectMarket`, so this
  // just remembers the symbol and opens the mobile chart (never touches
  // activeSymbol, which would clobber the perp coin slot).
  const handleMobileMarketPick = (selection: MarketSelection) => {
    // Venue-aware normalization: stocks uppercase, perp coins keep HL's
    // canonical casing (kPEPE, not KPEPE).
    const target = marketSelectionTarget(selection);
    const nextSymbol = target.symbol;
    clearSignalProvenance();
    setClearMobileSearchOnOpen(false);
    setMobileSearchSymbol(nextSymbol);
    rememberSymbol(nextSymbol, { syncSearch: false });
    // Plan A5. The single choke point for every mobile market pick (row tap,
    // Enter, and the "Open" submit all funnel through `pickMarket`), so the
    // venue-tagged Recents on the browse surface get written exactly once and
    // are no longer desktop-only.
    rememberRecentMarket(
      browserRecentMarketsStore(),
      { symbol: nextSymbol, venue: target.venue },
      PERPS_ENABLED,
    );
    rememberMobileHistoryMarket({ symbol: nextSymbol, venue: target.venue });
    openMobileContextualScreen("chart", mobileScreen === "search" ? "search" : currentMobileOrigin());
  };

  // Perps status unresolved: the section must not VANISH. Collapsing unknown
  // into "not connected" hid a provisioned user's real positions and orders
  // entirely, permanently through an outage, on the screen they would open to
  // check exactly those things.
  //
  // But "unresolved" is two states, and the placeholder I first wrote said
  // "Checking…" for both, so a status read that had already FAILED sat there
  // claiming to still be working, forever. A request that is over does not get
  // to describe itself as in progress.
  const perpsUnresolvedNotice = (
    <div className="rounded-2xl border bg-card/50 px-3 py-6 text-center text-xs text-muted-foreground">
      {perpsStatusQuery.isError
        ? "Could not check your perps account just now. Retrying automatically."
        : "Checking your perps account…"}
    </div>
  );

  const balancedDrawerWidths = balanceDrawerWidths({
    leftCollapsed: terminalLayout.left.collapsed,
    leftWidth: leftDrawerWidth,
    rightCollapsed: terminalLayout.right.collapsed,
    rightWidth: rightDrawerWidth,
    viewportWidth: terminalViewportWidth,
  });

  // Mobile search "Open" submit: resolve the typed text through the SAME
  // venue-aware path as Enter/suggestion picks (never assume stocks). A
  // perp-only coin flips to the perps venue with HL canonical casing; a
  // both-venues symbol is never guessed (the dropdown stays open so the user
  // picks a chip, matching desktop Enter semantics); unknown text surfaces the
  // dropdown's existing "Not tradable" message.
  const handleMobileSearchSubmit = (
    event: FormEvent<HTMLFormElement>,
    subscriptions: MobileShellSubscriptions,
  ) => {
    event.preventDefault();
    setClearMobileSearchOnOpen(false);
    // People is a caller directory, not a market scope. Submitting there used to
    // resolve the typed text against the hidden market suggestions, so a caller
    // whose name happens to contain a company word ("Apple") navigated to that
    // ticker instead of staying in caller search.
    if (subscriptions.searchDisabled) return;
    const resolution = resolveSubmitSelection(
      mobileSearchInputValue,
      subscriptions.mobileSymbolSearch.suggestions,
      subscriptions.searchFilter,
    );
    if (resolution.kind === "select") {
      subscriptions.pickMarket(resolution.selection);
      return;
    }
    // Ambiguous (listed on both venues) or not tradable. We never guess: the
    // browse surface below is already showing both venue rows, or the
    // "Not tradable" state, so there is nothing to open or dismiss.
  };

  const activateRightTab = (tab: RightTerminalTab, preferredPaneId?: string) => {
    if (tab === "ai") {
      setAiPopoutOpen(true);
      return;
    }

    setTerminalLayout((layout) => {
      const activePane =
        (preferredPaneId
          ? layout.right.panes.find((pane) => pane.id === preferredPaneId)
          : undefined) ??
        layout.right.panes.find((pane) => pane.tab === tab) ??
        layout.right.panes[0];
      if (!activePane) return layout;
      const next = updatePaneTab(layout, "right", activePane.id, tab);
      // Also uncollapse the drawer so the tab content is actually visible
      // (the drawer stays collapsed if the user had closed it with the chevron).
      return next.right.collapsed ? { ...next, right: { ...next.right, collapsed: false } } : next;
    });
  };

  // Desktop twin of openMobileSignals: focus the left drawer on the signals
  // feed. Empty positions/portfolio states offer this as their PRIMARY action
  // (the EmptyState contract: signal-first, funding second).
  const openSignalsFeed = () => {
    setTerminalLayout((layout) => {
      const activePane =
        layout.left.panes.find((pane) => pane.tab === "x_signals") ??
        layout.left.panes[0];
      if (!activePane) return layout;
      const next = updatePaneTab(layout, "left", activePane.id, "x_signals");
      // Uncollapse so the feed is actually visible, same as the right-drawer
      // activation above.
      return next.left.collapsed
        ? { ...next, left: { ...next.left, collapsed: false } }
        : next;
    });
  };

  const handleTradeSymbolCommit = (symbol: string) => {
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;
    if (routeIfCrypto(nextSymbol, "focus") !== "stocks") return;
    if (nextSymbol !== activeSymbol) {
      clearCopyPrefill();
      clearSignaPrefill();
      setSelectedSignal(null);
    }
    setActiveSymbol(nextSymbol);
    rememberSymbol(nextSymbol, { syncSearch: false });
  };

  const handleCoinCommit = (coin: string) => {
    // HL coins are canonical, case-sensitive spellings (e.g. kPEPE): trim
    // only, never uppercase, or downstream HL candle and order lookups get
    // the wrong coin.
    const nextCoin = normalizeMarketSymbol("perps", coin);
    if (!nextCoin) return;
    if (nextCoin !== activeCoin) clearCopyPrefill();
    setActiveCoin(nextCoin);
    rememberMobileHistoryMarket({ symbol: nextCoin, venue: "perps" });
  };

  /**
   * A level clicked in the DESKTOP perps order book. Rides the existing perp
   * prefill nonce, scoped to the coin the book was showing, and clears the
   * side/leverage prefill first so clicking a price changes ONLY the price
   * (an unrelated earlier copy must not be re-stamped by this bump). Also
   * brings the Trade tab forward, since the ticket is where the price lands.
   */
  const handleBookPriceSelect = (px: string) => {
    if (!px) return;
    clearCopyPrefill();
    setActivePerpSide(undefined);
    setActivePerpLeverage(undefined);
    setActivePerpLimitPrice(px);
    setActivePerpPrefillCoin(activeCoin);
    perpCopyNonceRef.current = nextManualCopyNonce(perpCopyNonceRef.current);
    setPerpPrefillNonce(perpCopyNonceRef.current);
    activateRightTab("trade");
  };

  const handleViewPerpPosition = (coin: string) => {
    // Position rows already carry Hyperliquid's canonical, case-sensitive coin.
    // Select the venue and coin together so a click from the combined positions
    // drawer cannot leave the stock chart mounted.
    const nextCoin = normalizeMarketSymbol("perps", coin);
    if (!nextCoin) return;
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    setSelectedCopyItemId(undefined);
    selectMarketRef.current?.({ symbol: nextCoin, venue: "perps" });
    if (!selectMarketRef.current) setActiveCoin(nextCoin);
    rememberMobileHistoryMarket({ symbol: nextCoin, venue: "perps" });
    focusChartOnNarrowViewport();
  };

  /**
   * Copy an EQUITY signal into the stock ticket. This is the INTENT half of a
   * feed chip: the user asked for order entry, so it lands on the ticket (the
   * mobile trade sheet, the Trade module on the terminal) instead of the chart.
   * Charting is the identity half, `handleViewSignalSymbol` below.
   */
  const handleSelectSignal = (signal: SelectedSignal) => {
    if (routeIfCrypto(signal.symbol, "focus") !== "stocks") return;
    clearCopyPrefill();
    clearSignaPrefill();
    if (signal.copySourceItemId) {
      const nonce = nextManualCopyNonce(stockCopyNonceRef.current);
      stockCopyNonceRef.current = nonce;
      setActiveStockCopy(createManualCopyPrefill(nonce, {
        symbol: normalizeSymbol(signal.symbol),
        side: "buy",
        assetType: "EQUITY",
        copySourceItemId: signal.copySourceItemId,
        accountId: selectedCredentialId,
        accountType: selectedAccountType,
      }));
      setSelectedCopyItemId(signal.copySourceItemId);
    }
    setSelectedSignal(signal);
    setActiveSymbol(normalizeSymbol(signal.symbol));
    rememberSymbol(signal.symbol);
    activateRightTab("trade");
    landCopyPrefill({
      openTradeSheetOnNarrowViewport,
      focusChartOnNarrowViewport,
    });
  };

  /**
   * Chart a ticker tapped in the X Signals feed. This is the IDENTITY half of a
   * feed chip: a symbol tap answers "what is this", and order entry stays one
   * deliberate tap further (F1).
   *
   * PROVENANCE: it re-stamps `selectedSignal` after navigating. The generic
   * chart handlers deliberately CLEAR that state (a chart tap from the watchlist
   * or search has no signal behind it), but on mobile the chart is now the main
   * route into the ticket, so clearing here would silently strip the signal id
   * from every order placed after a feed tap: no "mark signal TRADED", no social
   * or leaderboard credit. The selection is venue-tagged, so
   * `equityOrderSignalId` still refuses to hand a perp call's id to an equity
   * order on a colliding ticker (SOL, APT).
   */
  const handleViewSignalSymbol = (selection: SignalChartSelection) => {
    if (selection.venue === "perps") {
      // Flips the venue + coin slot and focuses the chart, and returns false
      // (with a toast) when perps are not enabled here.
      if (!handlePulseMarketView({ symbol: selection.symbol, venue: "perps" })) {
        return;
      }
      setSelectedSignal({
        symbol: selection.symbol,
        signalId: selection.signalId,
        content: selection.content,
        // Plan S1. The caller context rides along so the chart screen can show
        // WHY the user is here, not just what the ticker is doing.
        thesis: selection.thesis ?? null,
        venue: "perps",
      });
      return;
    }

    const nextSymbol = normalizeSymbol(selection.symbol);
    if (!nextSymbol) return;
    // A ticker that only trades as a perp routes itself to the perps venue and
    // stops here, exactly as the Copy path does.
    if (routeIfCrypto(nextSymbol, "focus") !== "stocks") return;
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedCopyItemId(undefined);
    setActiveSide(undefined);
    setActiveQty(undefined);
    selectStockMarket(nextSymbol);
    rememberMobileHistoryMarket({ symbol: nextSymbol, venue: "stocks" });
    rememberSymbol(nextSymbol);
    setSelectedSignal({
      symbol: nextSymbol,
      signalId: selection.signalId,
      content: selection.content,
      thesis: selection.thesis ?? null,
      venue: "stocks",
    });
    focusChartOnNarrowViewport();
  };

  const handleCopy = (payload: CopyTradePayload) => {
    const {
      symbol,
      side,
      qty,
      signalId,
      assetType,
      optionExpiration,
      optionStrike,
      optionType,
      tradeAction,
      copySourceItemId: payloadCopySourceItemId,
    } = payload;
    const copySourceItemId =
      payloadCopySourceItemId ??
      (signalId ? `x_signal:${signalId}` : undefined);
    // A crypto ticker has no stock order form: flip to perps and bring the perp
    // trade surface forward instead of prefilling a stock ticket. The stock
    // side/qty/option copy below only applies to an equity.
    const routed = routeIfCrypto(symbol, "tradeSheet");
    if (routed === "perps") {
      activateRightTab("trade");
      return;
    }
    if (routed === "none") return;
    clearCopyPrefill();
    clearSignaPrefill();
    const nextSymbol = selectStockMarket(symbol);
    if (!nextSymbol) return;
    rememberSymbol(nextSymbol);
    const optionCopy =
      assetType === "OPTION" && optionExpiration && optionStrike && optionType
        ? {
            assetType: "OPTION" as const,
            optionExpiration,
            optionStrike,
            optionType,
            tradeAction,
          }
        : undefined;
    const nextNonce = nextManualCopyNonce(stockCopyNonceRef.current);
    stockCopyNonceRef.current = nextNonce;
    setActiveStockCopy(
      createManualCopyPrefill(nextNonce, {
        symbol: nextSymbol,
        side,
        qty,
        copySourceItemId,
        accountId: selectedCredentialId,
        accountType: selectedAccountType,
        assetType: optionCopy ? "OPTION" : "EQUITY",
        ...optionCopy,
      }),
    );
    setActiveSide(undefined);
    setActiveQty(undefined);
    // For X-signal rows, carry the signalId through so the existing
    // "mark signal TRADED" wiring (TradeForm submit -> orders.submit { signalId })
    // fires on submit. User rows have no signalId.
    if (signalId) {
      setSelectedSignal({
        symbol,
        signalId,
        content: "",
        copySourceItemId,
        venue: "stocks",
      });
      setSelectedCopyItemId(copySourceItemId);
    } else {
      setSelectedSignal(null);
      setSelectedCopyItemId(copySourceItemId);
    }
    activateRightTab("trade");
    landCopyPrefill({
      openTradeSheetOnNarrowViewport,
      focusChartOnNarrowViewport,
    });
  };

  /**
   * Prefill the trade form from a Signa pick. Sets symbol + side, then
   * pushes the suggested entry/stop/target into the form via the
   * initialStopLoss / initialTakeProfit / initialEntry props. The form
   * auto-switches to OCO order type when stop + target are both present
   * so a real broker stop + take-profit get attached.
   */
  const handleCopySignaSignal = ({
    symbol,
    side,
    entry,
    stop,
    target,
  }: {
    symbol: string;
    side: "buy" | "sell";
    entry?: number;
    stop?: number;
    target?: number;
  }) => {
    // A crypto ticker has no stock ticket to prefill: flip to perps and bring the
    // perp trade surface forward.
    const routed = routeIfCrypto(symbol, "tradeSheet");
    if (routed === "perps") {
      activateRightTab("trade");
      return;
    }
    if (routed === "none") return;
    clearCopyPrefill();
    setSelectedSignal(null);
    const nextSymbol = selectStockMarket(symbol);
    if (!nextSymbol) return;
    rememberSymbol(nextSymbol);
    setActiveSide(side);
    setActiveQty(undefined);
    setActiveSignaEntry(entry);
    setActiveSignaStop(stop);
    setActiveSignaTarget(target);
    // A copied signal relies on the stop+target -> OCO default, so clear any
    // explicit order type / limit price / entry type / direction / TIF left
    // over from a prior chat draft.
    setActiveSignaOrderType(undefined);
    setActiveSignaLimitPrice(undefined);
    setActiveSignaEntryOrderType(undefined);
    setActiveSignaDirection(undefined);
    setActiveSignaTimeInForce(undefined);
    setSelectedSignaTicker(nextSymbol);
    activateRightTab("trade");
    landCopyPrefill({
      openTradeSheetOnNarrowViewport,
      focusChartOnNarrowViewport,
    });
  };

  const handleTradeSymbol = (
    symbol: string,
    venue?: MarketVenue,
    preferredPaneId?: string,
  ) => {
    if (venue) {
      handlePulseMarketTrade({ symbol, venue });
      return;
    }
    const routed = routeIfCrypto(symbol, "tradeSheet");
    if (routed === "perps") {
      activateRightTab("trade", preferredPaneId);
      return;
    }
    if (routed === "none") return;
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    setSelectedCopyItemId(undefined);
    setActiveSide(undefined);
    setActiveQty(undefined);
    setActiveSignaEntry(undefined);
    setActiveSignaStop(undefined);
    setActiveSignaTarget(undefined);
    setSelectedSignaTicker(undefined);
    const nextSymbol = selectStockMarket(symbol);
    if (!nextSymbol) return;
    rememberSymbol(nextSymbol);
    activateRightTab("trade", preferredPaneId);
    focusChartOnNarrowViewport();
  };

  /**
   * Copy a PERP signal from the X Signals feed. The venue flip + coin slot are
   * already done by the venue context's `selectMarket({venue:"perps"})` (invoked
   * in VenueAwareSignalFeed); this handler seeds the perp trade form's direction
   * + leverage via a parent-owned nonce event, highlights the copied row, brings
   * the Trade tab forward, and opens the mobile trade sheet. It NEVER touches
   * the equity ticket - a leveraged perp short must not prefill the stock form.
   */
  const handleCopyPerpSignal = ({
    coin,
    side,
    leverage,
    signalId,
    content,
    copySourceItemId,
  }: {
    coin: string;
    side: "long" | "short";
    leverage?: number;
    // Optional: a shared-user-trade perp copy (handleCopyPerpTrade below) has
    // no tweet-derived signal to attribute, so it calls this with neither set,
    // which takes the `signalId ? ... : null` branch below exactly like an
    // X-signal call that never had one.
    signalId?: string;
    content?: string;
    copySourceItemId?: string;
  }) => {
    clearCopyPrefill();
    clearSignaPrefill();
    // Highlight the copied row. Perp submission uses orders.submitPerp (no
    // signalId consumption), so this is purely the same selection-ring feedback
    // an equity copy gives.
    // Tagged with its venue so the equity ticket can never consume a perp
    // signal's id. A symbol comparison is not enough: SOL, APT and friends
    // exist on both venues, so a same-ticker collision would slip through.
    setSelectedSignal(
      signalId
        ? {
            symbol: coin,
            signalId,
            content: content ?? "",
            copySourceItemId,
            venue: "perps",
          }
        : null,
    );
    const nextNonce = nextManualCopyNonce(perpCopyNonceRef.current);
    perpCopyNonceRef.current = nextNonce;
    setActivePerpCopy(
      createManualCopyPrefill(nextNonce, {
        coin,
        side,
        leverage,
        copySourceItemId,
      }),
    );
    activateRightTab("trade");
    landCopyPrefill({
      openTradeSheetOnNarrowViewport,
      focusChartOnNarrowViewport,
    });
  };

  /**
   * Copy a shared user's Hyperliquid PERP fill from the copy-trade feed.
   * `coin`/`side`/`leverage` here are ALREADY the validated output of
   * `perpCopyFromTradeRow` (copy-perp-route.ts) - this handler trusts them
   * verbatim rather than re-deriving anything from a symbol string, for the
   * same reason handleCopyPerpSignal does.
   *
   * Flips the venue itself (handleCopyPerpSignal's contract is that the caller
   * already did so - see its doc comment), then reuses handleCopyPerpSignal
   * for the direction/leverage prefill, Trade-tab activation, and mobile sheet
   * handling. Passing no signalId/content leaves `selectedSignal` null (a
   * user's fill has no tweet-derived call to attribute an order to), so the
   * selection ring for THIS copy is driven by `selectedCopyItemId` instead,
   * set after the call because handleCopyPerpSignal's clearCopyPrefill() would
   * otherwise clear it.
   *
   * Failure mode when perps aren't set up for this user: selectMarket flips
   * the venue and PerpTradeForm renders `enabled={accountContext.agentReady}`
   * false, landing on the shared PerpsOnboardingCard for this coin instead of
   * a dead-end disabled button - see perp-trade-form.tsx's `enabled` gate.
   */
  const handleCopyPerpTrade = ({ itemId, coin, side, leverage }: CopyPerpTradePayload) => {
    selectMarketRef.current?.({ symbol: coin, venue: "perps" });
    handleCopyPerpSignal({
      coin,
      side,
      leverage,
      copySourceItemId: itemId,
    });
    setSelectedCopyItemId(itemId);
  };

  /**
   * Pre-fill the trade ticket from an AI order draft (chat capability #4).
   * Reuses the same prefill state the Signa "Copy signal" path drives, so the
   * draft rides the identical review-before-submit flow: because the ticket is
   * prefilled, `isPrefilledOrder` forces the confirmation dialog and the user
   * must click submit. This handler NEVER submits an order; it only fills the
   * form and brings the trade tab forward.
   */
  const handleDraftOrderFromChat = (draft: ChatOrderDraft) => {
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    setActiveSymbol(normalizeSymbol(draft.symbol));
    rememberSymbol(draft.symbol);
    setActiveSide(draft.side);
    setActiveQty(draft.quantity ?? undefined);
    // Reuse the Signa entry/stop/target prefill channel into TradeForm's
    // initialEntry / initialStopLoss / initialTakeProfit props, and thread the
    // draft's order type + limit price so the ticket matches what the user
    // asked for: a Market draft shows a Market ticket, a Limit draft shows a
    // Limit ticket with the limit price filled, and a stop+target bracket still
    // shows OCO. The entry-leg type keeps a limit bracket's Limit entry on the
    // OCO ticket, and an explicit "short" direction makes the ticket an
    // opening short (SellShort) instead of a plain Sell.
    setActiveSignaEntry(draft.entry ?? undefined);
    setActiveSignaStop(draft.stopLoss ?? undefined);
    setActiveSignaTarget(draft.takeProfit ?? undefined);
    setActiveSignaOrderType(draft.orderType);
    setActiveSignaLimitPrice(draft.limitPrice ?? undefined);
    setActiveSignaEntryOrderType(draft.entryOrderType ?? undefined);
    setActiveSignaDirection(draft.direction ?? undefined);
    // TIF from the draft, so a "DAY order" request actually sets the form's
    // Time in Force instead of leaving the GTC default.
    setActiveSignaTimeInForce(draft.timeInForce ?? undefined);
    setSelectedSignaTicker(normalizeSymbol(draft.symbol));
    activateRightTab("trade");
    landCopyPrefill({
      openTradeSheetOnNarrowViewport,
      focusChartOnNarrowViewport,
    });
  };

  const handleViewSymbol = (symbol: string, venue?: MarketVenue) => {
    if (venue) {
      handlePulseMarketView({ symbol, venue });
      return;
    }
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol || routeIfCrypto(nextSymbol, "focus") !== "stocks") return;
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    setSelectedCopyItemId(undefined);
    setActiveSide(undefined);
    setActiveQty(undefined);
    selectStockMarket(nextSymbol);
    rememberMobileHistoryMarket({ symbol: nextSymbol, venue: "stocks" });
    rememberSymbol(nextSymbol);
    focusChartOnNarrowViewport();
  };

  const handlePulseMarketView = (selection: MarketSelection) => {
    const symbol = normalizeMarketSymbol(selection.venue, selection.symbol);
    if (!symbol) return false;
    if (selection.venue === "perps" && !PERPS_ENABLED) {
      notifySymbolNotChartable(symbol);
      return false;
    }
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    setSelectedCopyItemId(undefined);
    selectMarketRef.current?.({ symbol, venue: selection.venue });
    // Keep the page-owned symbol slot in sync even when the venue bridge is
    // available. The bridge owns the venue switch, while these state updates
    // guarantee that the chart mounted immediately after leaving Pulse uses
    // the selected market instead of the previously active symbol.
    if (selection.venue === "perps") setActiveCoin(symbol);
    else setActiveSymbol(symbol);
    rememberMobileHistoryMarket({ symbol, venue: selection.venue });
    rememberSymbol(symbol, { syncSearch: selection.venue === "stocks" });
    setCenterWorkspaceMode("chart");
    focusChartOnNarrowViewport();
    return true;
  };

  const handlePulseMarketTrade = (selection: MarketSelection) => {
    if (handlePulseMarketView(selection)) activateRightTab("trade");
  };

  const handleAskAiAboutSymbol = (symbol: string, venue?: MarketVenue) => {
    clearCopyPrefill();
    clearSignaPrefill();
    setSelectedSignal(null);
    // AI research works for any market, so never block it. But still flip a
    // crypto coin to the perps venue so the chart renders the coin (not an empty
    // stock) while the AI answers, and research the canonical HL spelling.
    if (venue === "perps" && !PERPS_ENABLED) {
      notifySymbolNotChartable(symbol);
    } else if (venue) {
      selectMarketRef.current?.({ symbol, venue });
      rememberSymbol(symbol, { syncSearch: venue === "stocks" });
    }
    const route = venue
      ? {
          target: venue,
          canonicalPerpSymbol: venue === "perps" ? symbol : null,
        }
      : symbolVenueRouter.resolveRoute(symbol);
    const isPerpPick = route.target === "perps" && !!route.canonicalPerpSymbol;
    const nextSymbol = isPerpPick ? route.canonicalPerpSymbol! : normalizeSymbol(symbol);
    const isMobileViewport = typeof window !== "undefined" && window.innerWidth < 1280;
    if (isPerpPick) {
      selectMarketRef.current?.({ symbol: nextSymbol, venue: "perps" });
      rememberSymbol(nextSymbol, { syncSearch: false });
    } else if (route.target === "none") {
      // An HL coin that cannot be charted here (perps disabled). Research it,
      // but keep the current chart rather than pointing the stock chart at a
      // symbol with no equity datafeed, which would render an empty chart.
      notifySymbolNotChartable(symbol);
    } else {
      setActiveSymbol(nextSymbol);
      rememberSymbol(nextSymbol);
    }
    if (isMobileViewport) {
      setMobileAccountTab("ai");
      setMobileDestination("account");
    } else {
      activateRightTab("ai");
    }
    setChatDraftPrompt((current) => ({
      id: (current?.id ?? 0) + 1,
      text: `Research ${nextSymbol}. Start with recent news, filings, price action, and anything material I should know. Cite sources where available.`,
    }));
  };

  const handleDrawerSplit = (side: "left" | "right", direction: TerminalSplit) => {
    setTerminalLayout((layout) =>
      side === "left"
        ? splitPane(layout, "left", direction)
        : splitPane(layout, "right", direction),
    );
  };

  const handleDrawerCollapse = (side: "left" | "right", collapsed: boolean) => {
    setTerminalLayout((layout) =>
      side === "left"
        ? collapseDrawer(layout, "left", collapsed)
        : collapseDrawer(layout, "right", collapsed),
    );
  };

  const handleResetTerminalWorkspace = async () => {
    // Before the setState calls, so the persistence effect they schedule sees
    // the reset guard on its very first run and never arms a debounced save that
    // would race the reset.
    layoutSync.beginReset();
    const resetLayout = parseTerminalLayout(null);
    setTerminalLayout(resetLayout);
    setLeftDrawerWidth(LEFT_DRAWER_MAX_WIDTH);
    setRightDrawerWidth(RIGHT_DRAWER_DEFAULT_WIDTH);
    window.localStorage.removeItem(TERMINAL_LAYOUT_STORAGE_KEY);
    window.localStorage.removeItem(TERMINAL_DRAWER_WIDTHS_STORAGE_KEY);
    window.localStorage.removeItem(DISCOVERY_COLLAPSED_STORAGE_KEY);
    window.dispatchEvent(new Event("ready-set-trade:reset-chart-layout"));

    // Clear the ACCOUNT copy too. Without this, reset would only clear this
    // browser and the next load would restore the old workspace from the saved
    // setting, making the button look broken. A signed-out user has no account
    // copy, so that case reports cleared as well.
    const cleared = await layoutSync.commitReset();

    if (cleared) {
      toast.success("Terminal layout reset");
      return;
    }
    // Do NOT claim success: the account still holds the old layout, so the next
    // load would restore it and make the confirmation a lie. Say what actually
    // happened instead.
    toast.error(
      "Layout reset on this device, but the saved layout could not be cleared. It may come back on your next visit.",
    );
  };

  const handlePaneClose = (side: "left" | "right", paneId: string) => {
    if (side === "right") {
      if (terminalLayout.right.panes.length <= 1) return;
      setTerminalLayout((layout) => closePane(layout, "right", paneId));
      return;
    }

    setTerminalLayout((layout) =>
      closePane(layout, "left", paneId),
    );
  };

  const handleLeftTabChange = (paneId: string, tab: LeftTerminalTab) => {
    setTerminalLayout((layout) => updatePaneTab(layout, "left", paneId, tab));
  };

  const handleRightTabChange = (paneId: string, tab: RightTerminalTab) => {
    if (tab === "ai") {
      setAiPopoutOpen(true);
      return;
    }

    setTerminalLayout((layout) => updatePaneTab(layout, "right", paneId, tab));
  };

  const getLeftSubheaderActions = (paneId: string) =>
    leftSubheaderActionsByPane[paneId] ?? DEFAULT_LEFT_SUBHEADER_ACTIONS;

  const getLeftSubheaderCommand = (paneId: string) =>
    leftSubheaderCommandsByPane[paneId] ?? 0;

  const handleLeftSubHeaderAction = (
    paneId: string,
    tab: LeftTerminalTab,
    action: LeftSubheaderAction,
  ) => {
    setLeftSubheaderActionsByPane((current) => {
      const nextActions = {
        ...DEFAULT_LEFT_SUBHEADER_ACTIONS,
        ...current[paneId],
        [tab]: action,
      } as LeftSubheaderActionByTab;

      return {
        ...current,
        [paneId]: nextActions,
      };
    });
    setLeftSubheaderCommandsByPane((current) => ({
      ...current,
      [paneId]: (current[paneId] ?? 0) + 1,
    }));
  };

  const renderLeftSubHeader = (tab: LeftTerminalTab, paneId: string) => (
    <LeftSubheaderBar
      tab={tab}
      activeAction={getLeftSubheaderActions(paneId)[tab]}
      onSelect={(action) => handleLeftSubHeaderAction(paneId, tab, action)}
    />
  );

  const startDrawerResize = (
    side: "left" | "right",
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingDrawer(side);
    resizeDrawer(side, event.clientX);
  };

  const resizeDrawer = (side: "left" | "right", clientX: number) => {
    const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;

    if (side === "left") {
      const rightReserve = terminalLayout.right.collapsed
        ? COLLAPSED_DRAWER_WIDTH
        : balancedDrawerWidths.right;
      const maxLeftWidth = Math.max(
        LEFT_DRAWER_MIN_WIDTH,
        Math.min(LEFT_DRAWER_MAX_WIDTH, viewportWidth - CHART_COLUMN_MIN_WIDTH - rightReserve),
      );

      setLeftDrawerWidth(
        clampNumber(clientX, LEFT_DRAWER_MIN_WIDTH, maxLeftWidth),
      );
      return;
    }

    const leftReserve = terminalLayout.left.collapsed
      ? COLLAPSED_DRAWER_WIDTH
      : balancedDrawerWidths.left;
    const maxRightWidth = Math.max(
      RIGHT_DRAWER_MIN_WIDTH,
      Math.min(RIGHT_DRAWER_MAX_WIDTH, viewportWidth - CHART_COLUMN_MIN_WIDTH - leftReserve),
    );

    setRightDrawerWidth(
      clampNumber(viewportWidth - clientX, RIGHT_DRAWER_MIN_WIDTH, maxRightWidth),
    );
  };

  const handleDrawerResizeMove = (
    side: "left" | "right",
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (resizingDrawer !== side) return;
    event.preventDefault();
    resizeDrawer(side, event.clientX);
  };

  const endDrawerResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizingDrawer(null);
  };

  useEffect(() => {
    if (!resizingDrawer) return;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [resizingDrawer]);

  const renderLeftPane = (tab: LeftTerminalTab, paneId: string) => {
    const subheaderActions = getLeftSubheaderActions(paneId);
    const subheaderCommand = getLeftSubheaderCommand(paneId);

    switch (tab) {
      case "x_signals":
        return (
          <VenueAwareSignalFeed
            isSignedIn={isSignedIn}
            onSelectSignal={handleSelectSignal}
            onPerpCopyPrefill={handleCopyPerpSignal}
            onViewSignal={handleViewSignalSymbol}
            selectedSignalId={selectedSignal?.signalId}
            subheaderAction={subheaderActions.x_signals}
            subheaderActionNonce={subheaderCommand}
            embedded
          />
        );
      case "signa":
        return (
          <SignaSignalsPanel
            isSignedIn={isSignedIn}
            selectedTicker={selectedSignaTicker}
            onCopySignal={handleCopySignaSignal}
            onViewSymbol={handleViewSymbol}
            onAskAi={handleAskAiAboutSymbol}
            subheaderAction={subheaderActions.signa}
            subheaderActionNonce={subheaderCommand}
            embedded
          />
        );
      case "watchlist":
        return (
          <WatchlistPanel
            activeCredentialId={selectedCredentialId}
            selectedSymbol={activeSymbol}
            selectedPerpSymbol={activeCoin}
            onTradeSymbol={handleTradeSymbol}
            onAskAi={handleAskAiAboutSymbol}
            onViewSymbol={handleViewSymbol}
            subheaderAction={subheaderActions.watchlist}
            subheaderActionNonce={subheaderCommand}
            embedded
          />
        );
      case "copy_trade":
        return (
          <VenueAwareCopyTradePanel
            isSignedIn={isSignedIn}
            onCopy={handleCopy}
            onCopyPerp={handleCopyPerpTrade}
            onViewSymbol={handleViewSymbol}
            selectedItemId={selectedCopyItemId}
            activeCredentialId={selectedCredentialId}
            activeAccountType={selectedAccountType}
            activeAccountLabel={selectedAccountLabel}
            subheaderAction={subheaderActions.copy_trade}
            subheaderActionNonce={subheaderCommand}
            embedded
          />
        );
      case "social":
        return (
          <SocialFeedPanel
            onViewSymbol={handleViewSymbol}
            subheaderAction={subheaderActions.social}
            subheaderActionNonce={subheaderCommand}
            embedded
          />
        );
      case "hl_markets":
        return (
          <PerpSymbolUniverse
            activeCoin={activeCoin}
            // Picking a coin here must reveal its chart: route through the venue
            // context's `selectMarket` so the venue flips to perps (and the coin
            // slot is set via `onSelectPerpCoin`) instead of only mutating
            // `activeCoin` while the stocks chart stays mounted.
            onSelect={(coin) =>
              selectMarketRef.current?.({ symbol: coin, venue: "perps" })
            }
          />
        );
    }
  };

  const renderRightPane = (tab: RightTerminalTab, paneId: string) => {
    switch (tab) {
      case "trade":
        return (
          <VenueAwareTradeRail
            activeSymbol={activeSymbol}
            activeCoin={activeCoin}
            activeSide={activeSide}
            activeQty={activeQty}
            activeSignaEntry={activeSignaEntry}
            activeSignaStop={activeSignaStop}
            activeSignaTarget={activeSignaTarget}
            activeSignaOrderType={activeSignaOrderType}
            activeSignaLimitPrice={activeSignaLimitPrice}
            activeSignaEntryOrderType={activeSignaEntryOrderType}
            activeSignaDirection={activeSignaDirection}
            activeSignaTimeInForce={activeSignaTimeInForce}
            manualCopyPrefill={activeStockCopy}
            manualCopyResetNonce={copyResetNonce}
            onManualCopyPrefillConsumed={consumeStockCopyPrefill}
            onManualCopyPrefillCompleted={completeStockCopyPrefill}
            onManualCopyPrefillCancelled={cancelStockCopyPrefill}
            perpCopyPrefill={activePerpCopy}
            onPerpCopyPrefillConsumed={consumePerpCopyPrefill}
            onPerpCopyPrefillCompleted={completePerpCopyPrefill}
            onPerpCopyPrefillCancelled={cancelPerpCopyPrefill}
            activePerpSide={activePerpSide}
            activePerpLeverage={activePerpLeverage}
            // Desktop-only: the order book that produces this price is mounted
            // in the desktop chart panel, so the mobile trade sheet below is
            // deliberately NOT given it.
            activePerpLimitPrice={activePerpLimitPrice}
            perpPrefillNonce={perpPrefillNonce}
            activePerpPrefillCoin={activePerpPrefillCoin}
            selectedSignal={selectedSignal}
            selectedCredentialId={selectedCredentialId}
            selectedAccountType={selectedAccountType}
            selectedAccountLabel={selectedAccountLabel}
            tradeIsPrefilled={tradeIsPrefilled}
            onSymbolCommit={handleTradeSymbolCommit}
          />
        );
      case "ai":
        return (
          <StockChatPanel
            isSignedIn={isSignedIn}
            selectedSignal={selectedSignal}
            activeSymbol={activeSymbol}
            activeCredentialId={selectedCredentialId}
            activeAccountType={selectedAccountType}
            activeAccountLabel={selectedAccountLabel}
            draftPrompt={chatDraftPrompt}
            onDraftOrder={handleDraftOrderFromChat}
            embedded
          />
        );
      case "positions":
        return (
          <VenueAwareRightPositions
            isSignedIn={isSignedIn}
            selectedSymbol={activeSymbol}
            activeCredentialId={selectedCredentialId}
            activeAccountType={selectedAccountType}
            credentialsLoading={credentialsQuery.isLoading}
            onAskAi={handleAskAiAboutSymbol}
            onSelectSymbol={(symbol) => setActiveSymbol(normalizeSymbol(symbol))}
            onViewChart={handleViewSymbol}
            onViewPerpChart={handleViewPerpPosition}
            onTrade={(symbol) => handleTradeSymbol(symbol, undefined, paneId)}
          />
        );
      case "orders":
        return (
          <VenueAwareRightOrders
            activeCredentialId={selectedCredentialId}
            activeAccountType={selectedAccountType}
            credentialsLoading={credentialsQuery.isLoading}
            onViewPerpChart={handleViewPerpPosition}
          />
        );
      case "portfolio":
        return (
          <VenueAwareRightPortfolio
            credentialId={selectedCredentialId}
          />
        );
    }
  };

  const renderBottomPane = () => (
    <VenueAwareBottomContent
      isSignedIn={isSignedIn}
      activeSymbol={activeSymbol}
      selectedCredentialId={selectedCredentialId}
      selectedAccountType={selectedAccountType}
      credentialsLoading={credentialsQuery.isLoading}
      bottomTerminalTab={bottomTerminalTab}
      perpsWalletAddress={perpsWalletAddress}
      perpsEnabled={perpsEnabled}
      perpsStatusSettled={perpsStatusIsSettled}
      onBrowseSignals={openSignalsFeed}
      onAskAi={handleAskAiAboutSymbol}
      onSelectSymbol={(symbol) => setActiveSymbol(normalizeSymbol(symbol))}
      onViewChart={handleViewSymbol}
      onViewPerpChart={handleViewPerpPosition}
      onTrade={handleTradeSymbol}
    />
  );

  const renderBottomDrawerHeader = () => (
    <VenueAwareBottomHeader
      bottomTerminalTab={bottomTerminalTab}
      onTabChange={setBottomTerminalTab}
    />
  );

  const mobileAccountSummary = (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Portfolio value
        </p>
        <p className="font-data text-xl font-semibold tabular-nums">
          {mobilePortfolio.total != null ? formatUsd(mobilePortfolio.total) : "-"}
        </p>
      </div>
      <p className="max-w-[16rem] text-right text-xs text-muted-foreground">
        {mobilePortfolio.hasUnresolvedVenue
          ? mobilePortfolio.venueCheckFailed
            ? "Could not check every venue just now."
            : "Checking your connected venues…"
          : mobilePortfolio.rows.length === 0
            ? "Connect a broker or set up perpetual futures to view account data."
            : !mobilePortfolio.totalComplete
              ? "One venue has not reported a value yet."
              : `${mobilePortfolio.rows.length} connected venue${mobilePortfolio.rows.length === 1 ? "" : "s"}`}
      </p>
    </div>
  );

  const renderMobileSearchPanel = (
    subscriptions: MobileShellSubscriptions,
  ) => {
    const mobileSymbolSearch = subscriptions.mobileSymbolSearch;
    return (
      <MobileSearchSurface
        query={mobileSearchInputValue}
        inputRef={mobileSearchInputRef}
        searchDisabled={subscriptions.searchDisabled}
        onBack={goBackMobileContext}
        onQueryChange={(value) => {
          setClearMobileSearchOnOpen(false);
          setMobileSearchSymbol(value.toUpperCase());
        }}
        onClear={() => {
          setClearMobileSearchOnOpen(false);
          setMobileSearchSymbol("");
          mobileSearchInputRef.current?.focus();
        }}
        onSubmit={(event) => handleMobileSearchSubmit(event, subscriptions)}
        browse={
          <MobileMarketBrowse
            query={mobileSearchInputValue}
            filter={mobileSearchBrowseFilter}
            onFilterChange={setMobileSearchBrowseFilter}
            suggestions={mobileSymbolSearch.suggestions}
            isSearching={mobileSymbolSearch.isLoading}
            searchFailed={mobileSymbolSearch.hasError}
            availability={subscriptions.availability}
            isSignedIn={isSignedIn}
            onSelect={subscriptions.pickMarket}
            onTrade={(selection) =>
              pickMarketAndOpenTradeSheet(selection.symbol, selection.venue)
            }
          />
        }
      />
    );
  };

  const renderMobileChartPanel = ({
    activeQuote,
    activeQuoteFreshness,
    perpSnapshot,
    perpQuote,
    venue,
    isPerps,
    marketSymbol,
  }: Pick<
    MobileShellSubscriptions,
    | "activeQuote"
    | "activeQuoteFreshness"
    | "perpSnapshot"
    | "perpQuote"
    | "venue"
    | "isPerps"
    | "marketSymbol"
  >) => {
    // Same header rules as the trade sheet's own market line, from one module:
    // display spelling, venue tag, price line and tone.
    const header = describeMobileMarketHeader({
      marketSymbol,
      isPerps,
      perpQuote,
      stockQuote: activeQuote,
    });
    // Never render a tab the strip no longer offers: selecting AI on an equity
    // chart and then switching venue would otherwise leave an equity assistant
    // running against a perp chart.
    const visibleChartTab = resolveMobileChartTab(mobileChartTab, isPerps);
    // Plan S1. The caller's thesis, but only when the current selection actually
    // belongs to the market on screen. Venue-matched, not symbol-matched: SOL is
    // Solana on Hyperliquid and ReneSola on Nasdaq, so a symbol comparison alone
    // would attribute a perp caller's words to an unrelated equity chart.
    const chartThesis = signalThesisForMarket(
      selectedSignal,
      marketSymbol,
      isPerps,
    );
    // Trade is the landing screen, so it must land on something: with no
    // market for the venue, name the next action (the shell hides the pinned
    // Buy/Sell pair in the same condition).
    if (!marketSymbol) {
      return (
        <MobileChartEmptyState
          onSearch={openMobileSearch}
          onBrowse={() => setMobileDestination("markets")}
          venueSwitch={mobileVenueSwitchForScreen("chart", PERPS_ENABLED)}
        />
      );
    }
    return (
      <section
        aria-labelledby="mobile-chart-screen-title"
        className="space-y-2"
      >
        <MobileChartHeader
          symbol={header.symbol}
          freshness={activeQuoteFreshness}
          // As the Trade home (no origin) the chart has nowhere to go back to.
          backLabel={
            mobileScreenOrigin === null
              ? null
              : mobileChartBackLabel({
                  screen: "chart",
                  origin: mobileScreenOrigin,
                })
          }
          onBack={goBackMobileContext}
          // Trade is the destination the venue changes completely, so the
          // switch ends this row instead of getting a pinned bar of its own.
          venueSwitch={mobileVenueSwitchForScreen("chart", PERPS_ENABLED)}
        />

      <MobileChartMarketSummary
        symbol={header.symbol}
        isPerps={isPerps}
        stockQuote={activeQuote}
        perpSnapshot={perpSnapshot}
        perpQuote={perpQuote}
        onExpand={focusChartOnNarrowViewport}
      />

      {/* Plan S1. The thesis sits directly under the market header, ABOVE the
          metrics and the chart: signal-first means the reason for being here
          outranks the bid/ask. Bullpen's chart cannot render this row at all,
          because a wallet never states a reason. */}
      {chartThesis && (
        <SignalThesisCard
          thesis={chartThesis}
          content={selectedSignal?.content ?? ""}
        />
      )}

      {/* Shares the desktop chart column's ref: only one shell is mounted at a
          time, and this is what `focusChartOnNarrowViewport` scrolls into view.
          Without it the summary's "Expand chart" button was a dead control on
          the phone, because the only element the ref ever pointed at lives in
          the desktop workspace. */}
      <div ref={chartColumnRef} className="overflow-hidden bg-background">
        <TerminalChartPanel
          symbol={marketSymbol}
          venue={venue}
          credentialId={isPerps ? undefined : selectedCredentialId}
          compactChrome
          onSymbolCommit={isPerps ? handleCoinCommit : openMobileChart}
        />
      </div>

      {/* Market-scoped reads only. The account-wide tabs live on Account. */}
      <div
        data-mobile-chart-tabs="true"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {mobileChartTabsForVenue(isPerps).map(({ value, label }) => {
          const Icon = MOBILE_CHART_TAB_ICONS[value];
          return (
            <button
              key={value}
              type="button"
              aria-pressed={visibleChartTab === value}
              onClick={() => setMobileChartTab(value)}
              className={cn(
                "inline-flex h-11 min-w-0 touch-manipulation items-center justify-center gap-1 rounded-xl border px-3 text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#020f16]",
                visibleChartTab === value
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border bg-card/60 text-muted-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <MobileChartInsights>
        {visibleChartTab === "portfolio" && (
          <div className="min-w-0">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 border-b border-border/70 px-3 text-xs font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={mobileChartCurrentTickerOnly}
                onChange={(event) =>
                  setMobileChartCurrentTickerOnly(event.target.checked)
                }
                className="size-4 rounded border-border accent-primary"
              />
              View only {header.symbol}
            </label>
            {isPerps ? (
              <PerpPositionsPanel
                walletAddress={perpsWalletAddress}
                enabled={perpsEnabled}
                selectedCoin={activeCoin}
                onlySelectedCoin={mobileChartCurrentTickerOnly}
                onViewChart={handleViewPerpPosition}
              />
            ) : (
              <PositionsPanel
                isSignedIn={isSignedIn}
                selectedSymbol={activeSymbol}
                onlySelectedSymbol={mobileChartCurrentTickerOnly}
                activeCredentialId={selectedCredentialId}
                activeAccountType={selectedAccountType}
                credentialsLoading={credentialsQuery.isLoading}
                onAskAi={handleAskAiAboutSymbol}
                onSelectSymbol={(symbol) => setActiveSymbol(normalizeSymbol(symbol))}
                onViewChart={openMobileChart}
                onTrade={(symbol) => pickMarketAndOpenTradeSheet(symbol)}
                onBrowseSignals={openMobileSignals}
                embedded
              />
            )}
          </div>
        )}
        {visibleChartTab === "feed" && (
          <VenueAwareSignalFeed
            isSignedIn={isSignedIn}
            onSelectSignal={handleSelectSignal}
            onPerpCopyPrefill={handleCopyPerpSignal}
            onViewSignal={handleViewSignalSymbol}
            selectedSignalId={selectedSignal?.signalId}
            embedded
          />
        )}
        {visibleChartTab === "ai" && (
          <StockChatPanel
            isSignedIn={isSignedIn}
            selectedSignal={selectedSignal}
            activeSymbol={activeSymbol}
            activeCredentialId={selectedCredentialId}
            activeAccountType={selectedAccountType}
            activeAccountLabel={selectedAccountLabel}
            draftPrompt={chatDraftPrompt}
            onDraftOrder={handleDraftOrderFromChat}
            embedded
          />
        )}
      </MobileChartInsights>

      </section>
    );
  };

  // The merged Traders destination. Every slot is a production element; the
  // screen mounts exactly one of them for the selected tab, so the signal
  // feed poll, the copy poll, the leaderboard queries and the watchlist query
  // only ever run for the surface on screen.
  const renderMobileTradersScreen = () => (
    <MobileTradersScreen
      activeTab={mobileTradersTab}
      onTabChange={setMobileTradersTab}
      feed={
        // PERPS_ENABLED is a build-time deployment capability. Resolve a stale
        // scope before constructing VenueAwareSignalFeed so an unavailable
        // deployment never issues a perps-scoped feed query.
        <MobileFeedPanel
          venueFilter={normalizeMobileFeedVenueFilter(
            mobileFeedVenueFilter,
            PERPS_ENABLED,
          )}
          signalFeed={
            <MobileFeedSignalFeed
              venueFilter={normalizeMobileFeedVenueFilter(
                mobileFeedVenueFilter,
                PERPS_ENABLED,
              )}
              onShowAllSignals={() => setMobileFeedVenueFilter("all")}
              isSignedIn={isSignedIn}
              onSelectSignal={handleSelectSignal}
              onPerpCopyPrefill={handleCopyPerpSignal}
              onViewSignal={handleViewSignalSymbol}
              selectedSignalId={selectedSignal?.signalId}
            />
          }
          perpsAvailable={PERPS_ENABLED}
          onVenueFilterChange={(filter) =>
            setMobileFeedVenueFilter(
              normalizeMobileFeedVenueFilter(filter, PERPS_ENABLED),
            )
          }
        />
      }
      watchlist={
        <WatchlistPanel
          activeCredentialId={selectedCredentialId}
          selectedSymbol={activeSymbol}
          selectedPerpSymbol={activeCoin}
          onTradeSymbol={pickMarketAndOpenTradeSheet}
          onAskAi={handleAskAiAboutSymbol}
          onViewSymbol={openMobileChart}
          embedded
        />
      }
      copyFeed={
        <VenueAwareCopyTradePanel
          {...mobileCopyFeedProps({
            isSignedIn,
            onCopy: handleCopy,
            onCopyPerp: handleCopyPerpTrade,
            onViewSymbol: openMobileChart,
            selectedItemId: selectedCopyItemId,
            activeCredentialId: selectedCredentialId,
            activeAccountType: selectedAccountType,
            activeAccountLabel: selectedAccountLabel,
            // This explicit action keeps the legacy CopyTradePanel's internal
            // source tab in sync with the V2 Following destination. A nonzero
            // nonce is required so a previously selected source is refreshed.
            subheaderAction: "following",
            subheaderActionNonce: 1,
            showLeaderboardLink: false,
            embedded: true,
          })}
        />
      }
      xCallers={<XCallersTab isSignedIn={isSignedIn} />}
      users={<UsersTab isSignedIn={isSignedIn} />}
      // Travels down to the Following tab, the one Traders surface the venue
      // scopes (its copy feed is queried with the venue-derived asset class).
      venueSwitch={mobileVenueSwitchForScreen("traders", PERPS_ENABLED)}
      riskSettingsAction={
        <Link
          href="/settings?tab=copy-trading"
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-3 text-sm font-medium text-primary"
        >
          Risk settings
        </Link>
      }
    />
  );

  const renderMobileAccountScreen = () => (
    <VenueAwareMobileAccountScreen
      activeTab={mobileAccountTab}
      onTabChange={setMobileAccountTab}
      connectionSummary={{
        stocks: stocksVenueState,
        perps: perpsVenueState,
        venueCheckFailed: stocksVenueCheckFailed || perpsStatusQuery.isError,
      }}
      accountValue={mobileAccountValueProps.accountValue}
      accountValueState={mobileAccountValueProps.accountValueState}
      portfolioSummary={mobilePortfolio}
      positions={
        <MobileVenueStack
          stocks={
            <PositionsPanel
              isSignedIn={isSignedIn}
              selectedSymbol={activeSymbol}
              activeCredentialId={selectedCredentialId}
              activeAccountType={selectedAccountType}
              credentialsLoading={credentialsQuery.isLoading}
              onAskAi={handleAskAiAboutSymbol}
              onSelectSymbol={(symbol) => setActiveSymbol(normalizeSymbol(symbol))}
              onViewChart={openMobileChart}
              onTrade={(symbol) => pickMarketAndOpenTradeSheet(symbol)}
              onBrowseSignals={openMobileSignals}
              embedded
            />
          }
          perps={
            perpsVenueState === null ? (
              perpsUnresolvedNotice
            ) : mobilePerpsConnected ? (
              <PerpPositionsPanel
                walletAddress={perpsWalletAddress}
                enabled={perpsEnabled}
                onViewChart={handleViewPerpPosition}
              />
            ) : null
          }
        />
      }
      closed={
        perpsVenueState === null ? (
          perpsUnresolvedNotice
        ) : mobilePerpsConnected ? (
          <PerpClosedPanel
            enabled={perpsEnabled}
            onViewChart={handleViewPerpPosition}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            Closed perpetual-futures rounds appear here when that venue is connected.
          </p>
        )
      }
      orders={
        <MobileVenueStack
          stocks={
            <OpenOrdersPanel
              activeCredentialId={selectedCredentialId}
              activeAccountType={selectedAccountType}
              credentialsLoading={credentialsQuery.isLoading}
              embedded
            />
          }
          perps={
            perpsVenueState === null ? (
              perpsUnresolvedNotice
            ) : mobilePerpsConnected ? (
              <PerpOrdersPanel
                enabled={perpsEnabled}
                onViewChart={handleViewPerpPosition}
              />
            ) : null
          }
        />
      }
      portfolio={
        <MobilePortfolioPanel
          summary={mobilePortfolio}
          navigation={mobilePortfolioNavigation}
          onViewChange={setMobilePortfolioView}
          stocksSurface={
            <PortfolioHistoryChart
              credentialId={selectedCredentialId}
              onBrowseSignals={openMobileSignals}
              embedded
            />
          }
          perpsSurface={<PerpPortfolioPanel enabled={perpsEnabled} />}
        />
      }
      ai={
        <StockChatPanel
          isSignedIn={isSignedIn}
          selectedSignal={selectedSignal}
          activeSymbol={activeSymbol}
          activeCredentialId={selectedCredentialId}
          activeAccountType={selectedAccountType}
          activeAccountLabel={selectedAccountLabel}
          draftPrompt={chatDraftPrompt}
          onDraftOrder={handleDraftOrderFromChat}
          embedded
        />
      }
    />
  );

  const renderMobileDestinations = (subscriptions: MobileShellSubscriptions) => ({
    markets: {
      accountSummary: mobileAccountSummary,
      marketBrowse: (
        <MobileMarketBrowse
          // Markets is a browse destination. It must not inherit the last
          // text entered on contextual Search (or the active ticker seed),
          // otherwise its Recents/rankings surface opens as an SPY search.
          query=""
          filter={mobileMarketsBrowseFilter}
          onFilterChange={(filter) => {
            if (filter === "all" || filter === "stocks" || filter === "perps") {
              setMobileMarketsBrowseFilter(filter);
            }
          }}
          suggestions={subscriptions.mobileSymbolSearch.suggestions}
          isSearching={subscriptions.mobileSymbolSearch.isLoading}
          searchFailed={subscriptions.mobileSymbolSearch.hasError}
          availability={subscriptions.availability}
          isSignedIn={isSignedIn}
          onSelect={subscriptions.pickMarket}
        />
      ),
      onOpenSearch: openMobileSearch,
      // The traded-venue switch as the first cell of the Markets control row.
      venueSwitch: mobileVenueSwitchForScreen("markets", PERPS_ENABLED),
    },
    search: renderMobileSearchPanel(subscriptions),
    chart: renderMobileChartPanel(subscriptions),
    traders: renderMobileTradersScreen(),
    account: renderMobileAccountScreen(),
  });

  const renderMobileShell = (subscriptions: MobileShellSubscriptions) => {
    const { activeQuote, perpQuote, isPerps, marketSymbol } = subscriptions;
    // Plan A1. The sheet owns the market line now (the tickets hide theirs via
    // `hideMarketHeader`), so it states the same identity the chart screen does,
    // from the same module.
    const sheetHeader = describeMobileMarketHeader({
      marketSymbol,
      isPerps,
      perpQuote,
      stockQuote: activeQuote,
    });
    // The chart screen's pinned Long/Short (Buy/Sell) pair: the same sheet
    // the Trade CTA opens, with the side pre-selected. Perps go through the
    // prefill nonce the perp form already honors; the leverage prefill is
    // cleared first so a side tap never re-applies a stale copied leverage.
    const openTradeSheetWithSide = (side: MobilePrimaryActionSide) => {
      openTradeSheetForVenue(isPerps);
      if (isPerps) {
        clearCopyPrefill();
        const nextNonce = nextManualCopyNonce(perpCopyNonceRef.current);
        perpCopyNonceRef.current = nextNonce;
        setActivePerpSide(side);
        setActivePerpLeverage(undefined);
        setActivePerpLimitPrice(undefined);
        setActivePerpPrefillCoin(activeCoin);
        setPerpPrefillNonce(nextNonce);
        return;
      }
      setActiveSide(side === "long" ? "buy" : "sell");
    };
    const destinations = renderMobileDestinations(subscriptions);
    // The frame header is app chrome, not a second destination heading. Keep
    // the product brand here and let each V2 screen own its single h1 (now
    // visually hidden: the subtitle names the screen, so the destinations do
    // not spend a title row repeating what the app bar and nav already say).
    const mobileHeaderTitle = "Ready Set Trade";
    const mobileHeaderSubtitle = (() => {
      switch (mobileScreen) {
        case "chart":
          return isPerps ? "Perpetual futures" : "Stocks & options";
        case "search":
          return "Search";
        case "markets":
          return "Markets";
        case "traders":
          return "Traders";
        case "account":
          return "Account";
      }
    })();
    const handleMobileNavChange = (screen: MobileScreen) => {
      setMobileMenuOpen(false);
      // A tap on the current destination stays put. This matters for Trade:
      // a chart reached from Markets or Traders keeps its instrument and its Back
      // instead of being re-pushed as a fresh home entry.
      if (screen === mobileScreen) return;
      navigateMobileScreen(screen, {
        openSearch: () => {
          setMobileMenuOpen(false);
          openMobileSearch();
        },
        setScreen: (nextScreen) => setMobileDestination(nextScreen),
      });
    };
    // A Sections row in the menu: the tab setter the strip on that screen
    // already calls, then the destination switch the bottom nav makes (which
    // closes the menu and stays put when that screen is already on).
    const handleMobileNavSection = (section: MobileMenuSection) =>
      navigateMobileMenuSection(section, {
        setTradersTab: setMobileTradersTab,
        setAccountTab: setMobileAccountTab,
        setScreen: handleMobileNavChange,
      });
    const navigation = (
      <MobileBottomNav
        active={mobileScreen}
        balance={mobileNavBalance}
        onChange={handleMobileNavChange}
      />
    );
    const menu = mobileMenuOpen ? (
      <MobileV2Menu
        active={mobileScreen}
        paperAccount={paperAccount}
        liveAccount={liveAccount}
        accountMode={accountMode}
        balance={mobileNavBalance}
        onAccountModeChange={setAccountMode}
        onChange={handleMobileNavChange}
        onNavigateSection={handleMobileNavSection}
        onClose={() => setMobileMenuOpen(false)}
      />
    ) : null;

    return (
      <>
        {renderMobileV2Shell({
          screen: mobileScreen,
          header: (
            <MobileV2Header
              title={mobileHeaderTitle}
              subtitle={mobileHeaderSubtitle}
              onOpenMenu={() => setMobileMenuOpen(true)}
              onOpenSearch={openMobileSearch}
              {...mobileAccountValueProps}
              accountValueCompact={mobileNavBalance?.short}
              onOpenAccount={() => handleMobileNavChange("account")}
            />
          ),
          notice: (
            <AlpacaCredentialReimportNotice
              accounts={brokerAccounts}
              className="xl:hidden"
            />
          ),
          // Hidden with the chart's empty state: no market, no ticket to open.
          actionBar:
            mobileScreen === "chart" && marketSymbol ? (
              <MobilePrimaryActionBar
                symbol={sheetHeader.symbol}
                isPerps={isPerps}
                onTrade={openTradeSheetWithSide}
              />
            ) : null,
          navigation,
          modalOpen: mobileMenuOpen || mobileTradeSheetOpen,
          overlay: menu,
          ...destinations
        })}

        {/* Plan A1. A bottom sheet, not a screen: the shell stays mounted while
            this full-height ticket takes focus. The frame only owns presentation;
            the supplied rail keeps every real form and order handler intact. */}
        {mobileTradeSheetOpen && (
          <MobileTradeSheet
            sectionRef={tradeSheetRef}
            marketHeader={sheetHeader}
            isPerps={isPerps}
            onChangeMarket={() => {
              closeMobileTradeSheet();
              openMobileSearch();
            }}
            onClose={closeMobileTradeSheet}
          >
            <VenueAwareTradeRail
              hideMarketHeader
              activeSymbol={activeSymbol}
              activeCoin={activeCoin}
              activeSide={activeSide}
              activeQty={activeQty}
              activeSignaEntry={activeSignaEntry}
              activeSignaStop={activeSignaStop}
              activeSignaTarget={activeSignaTarget}
              activeSignaOrderType={activeSignaOrderType}
              activeSignaLimitPrice={activeSignaLimitPrice}
              activeSignaEntryOrderType={activeSignaEntryOrderType}
              activeSignaDirection={activeSignaDirection}
              activeSignaTimeInForce={activeSignaTimeInForce}
              manualCopyPrefill={activeStockCopy}
              manualCopyResetNonce={copyResetNonce}
              onManualCopyPrefillConsumed={consumeStockCopyPrefill}
              onManualCopyPrefillCompleted={completeStockCopyPrefill}
              onManualCopyPrefillCancelled={cancelStockCopyPrefill}
              perpCopyPrefill={activePerpCopy}
              onPerpCopyPrefillConsumed={consumePerpCopyPrefill}
              onPerpCopyPrefillCompleted={completePerpCopyPrefill}
              onPerpCopyPrefillCancelled={cancelPerpCopyPrefill}
              activePerpSide={activePerpSide}
              activePerpLeverage={activePerpLeverage}
              perpPrefillNonce={perpPrefillNonce}
              activePerpPrefillCoin={activePerpPrefillCoin}
              selectedSignal={selectedSignal}
              selectedCredentialId={selectedCredentialId}
              selectedAccountType={selectedAccountType}
              selectedAccountLabel={selectedAccountLabel}
              tradeIsPrefilled={tradeIsPrefilled}
              onSymbolCommit={handleTradeSymbolCommit}
            />
          </MobileTradeSheet>
        )}
      </>
    );
  };

  return (
    <VenueProvider
      stocksAccount={{
        credentialId: selectedCredentialId,
        accountMode: selectedAccountType,
        accountLabel: selectedAccountLabel,
      }}
      onSelectStockSymbol={handleTradeSymbolCommit}
      onSelectPerpCoin={handleCoinCommit}
      selectMarketRef={selectMarketRef}
    >
    {/* min-h in dvh, not vh: the mobile frame inside is exactly 100dvh, and a
        100vh floor made this wrapper taller than it by the browser chrome on a
        phone (Safari's 100vh is the bar-collapsed height), so the document
        itself scrolled by that much and dragged the header and bottom nav off
        the screen. */}
    <div className="rst-terminal min-h-[100dvh] bg-background xl:fixed xl:inset-0 xl:flex xl:flex-col xl:overflow-hidden">
      {/* Header */}
      <header className="terminal-global-header hidden justify-center sticky top-0 z-50 border-b bg-background/95 backdrop-blur xl:flex">
        <div className="terminal-global-header-inner flex h-14 items-center justify-between gap-2 px-2 sm:px-4 w-full max-w-400">
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            <HeaderMenu
              paperAccount={paperAccount}
              liveAccount={liveAccount}
              accountMode={accountMode}
              onAccountModeChange={setAccountMode}
            />
            <Link href="/app" className="flex min-w-0 shrink-0 items-center gap-2.5" aria-label="Ready Set Trade home">
            <Image
              src="/brand/emblem-light.png"
              alt=""
              width={32}
              height={32}
              priority
              className="h-8 w-8 dark:hidden"
            />
            <Image
              src="/brand/emblem-dark.png"
              alt=""
              width={32}
              height={32}
              priority
              className="hidden h-8 w-8 dark:block"
            />
            <span className="hidden font-wordmark text-base font-semibold uppercase tracking-[0.18em] sm:inline">
              Ready Set Trade
            </span>
            </Link>
            {/* Desktop terminal (xl+) surfaces the venue switch as a primary
                control in the header, set off from the wordmark by a divider.
                Below xl the mobile shell has no header venue control at all:
                the switch is routed to the three destinations that read it and
                sits inside a control row each of them already paints (see
                `mobile-venue-scope.ts`). Only one shell mounts at a time, so
                the two never show at once, and both share the venue context. */}
            {PERPS_ENABLED && (
              <span aria-hidden className="ml-2 hidden h-6 w-px shrink-0 bg-border xl:block" />
            )}
            <VenueSwitch className="ml-2 hidden xl:flex" />
          </div>
          {/* Primary desktop links (Leaderboard/Guide/Settings) now live in the
              header hamburger; "Trade" is dropped since /app is this page. */}
          <div className="flex flex-1" />
          <div className="flex min-w-0 shrink-0 items-center gap-1 sm:gap-2">
            <TerminalLayoutMenu
              leftCollapsed={terminalLayout.left.collapsed}
              rightCollapsed={terminalLayout.right.collapsed}
              onToggleLeft={() =>
                handleDrawerCollapse("left", !terminalLayout.left.collapsed)
              }
              onToggleRight={() =>
                handleDrawerCollapse("right", !terminalLayout.right.collapsed)
              }
              onFocusChart={() => {
                handleDrawerCollapse("left", true);
                handleDrawerCollapse("right", true);
              }}
              onReset={handleResetTerminalWorkspace}
            />
            {/* Plan A9. xl and up only. `.terminal-account-metric` is styled
                inside a `min-width: 1280px` block in globals.css, so below xl
                these rendered as unstyled text crowded against the hamburger.
                Nothing is lost on mobile: the cross-venue total is now the nav
                balance, buying power is on the equity ticket and perps
                collateral on the perp ticket (both via TicketContextRow), and
                the per-venue values are the Portfolio tab's rows. */}
            {(selectedCredentialId || perpsWalletAddress) && (
              <VenueAwareHeaderMetrics
                selectedCredentialId={selectedCredentialId}
                perpsWalletAddress={perpsWalletAddress}
                headerPortfolioValue={headerPortfolioValue}
                headerBuyingPower={headerBuyingPower}
                headerPerpsEquity={headerPerpsEquity}
              />
            )}
            <AppNotifications enabled={isSignedIn} />
            <Link href="/guide" aria-label="Guide" className="lg:hidden">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 min-w-11 gap-2 font-semibold text-primary"
              >
                <BookOpen className="h-4 w-4" />
                <span className="sr-only">Guide</span>
              </Button>
            </Link>
            <Link href="/settings" aria-label="Settings">
              <Button variant="ghost" size="icon" className="min-h-11 min-w-11 lg:min-h-0 lg:min-w-0">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
            <UserMenu />
          </div>
        </div>
      </header>
      {responsiveShellMode === "desktop" && (
        <AlpacaCredentialReimportNotice
          accounts={brokerAccounts}
          className="fixed inset-x-0 top-14 z-40 hidden xl:block"
        />
      )}

      {/* Mobile App Shell. MobileV2Frame owns the one header, venue bar,
          bounded content scroll region, and in-flow bottom navigation. */}
      <TradingResponsiveShell
        mode={responsiveShellMode}
        mobileSubscriptionInput={{
          activeSymbol,
          activeCoin,
          // The mobile search query is only meaningful on contextual Search.
          // The subscription stays mounted for the shell, but Markets should
          // request the blank browse dataset rather than the last Search text.
          searchValue: mobileScreen === "search" ? mobileSearchInputValue : "",
          onPickSymbol: handleMobileSymbolPick,
          onSelectMarket: handleMobileMarketPick,
          // Same tri-state the portfolio uses: neither venue may be reported
          // as unavailable while its read is still in flight or has failed.
          availability: { stocks: stocksVenueState, perps: perpsVenueState },
          // Plan A5: the browse surface owns its own scope, and asks for more
          // rows than the 8-row dropdown default since it is a full-height list.
          // S3: People is not a market scope, so it maps back to the open one.
          searchFilter:
            mobileScreen === "markets"
              ? mobileMarketsBrowseFilter
              : marketSearchScope(mobileSearchBrowseFilter),
          searchLimit: MOBILE_BROWSE_SEARCH_LIMIT,
          // S3: People renders callers, so no market request is issued while
          // the Search destination is showing it. Markets always stays on its
          // own market-only filter and therefore can never inherit People.
          searchDisabled:
            mobileScreen === "search" &&
            isPeopleBrowseTab(mobileSearchBrowseFilter),
        }}
        renderMobile={renderMobileShell}
        desktop={
          /* Terminal Workspace */
          <main className="terminal-workspace hidden min-h-[calc(100dvh-3.5rem-1.75rem)] flex-col bg-background xl:flex xl:h-[calc(100dvh-3.5rem-1.75rem)] xl:min-h-0 xl:flex-row xl:overflow-hidden">
        <div
          className={cn(
            "terminal-drawer-shell terminal-drawer-shell-left order-2 w-full shrink-0 xl:order-none xl:h-full xl:min-h-0",
            terminalLayout.left.collapsed && "min-h-12 xl:w-12",
            !terminalLayout.left.collapsed && "min-h-[360px] sm:min-h-[460px] xl:min-h-0",
            !terminalLayout.left.collapsed && "xl:w-[var(--terminal-left-width)]",
          )}
          style={
            terminalLayout.left.collapsed
              ? undefined
              : ({ "--terminal-left-width": `${balancedDrawerWidths.left}px` } as CSSProperties)
          }
        >
          <TerminalDrawer
            side="left"
            title="Discovery"
            collapsedLabel="Discovery"
            tabs={LEFT_TERMINAL_TABS}
            state={terminalLayout.left}
            renderPane={(tab, paneId) => renderLeftPane(tab, paneId)}
            renderSubHeader={(tab, paneId) => renderLeftSubHeader(tab, paneId)}
            resizeHandle={
              <DrawerResizeHandle
                drawerSide="left"
                ariaLabel="Resize discovery drawer"
                min={LEFT_DRAWER_MIN_WIDTH}
                max={LEFT_DRAWER_MAX_WIDTH}
                now={balancedDrawerWidths.left}
                onPointerDown={(event) => startDrawerResize("left", event)}
                onPointerMove={(event) => handleDrawerResizeMove("left", event)}
                onPointerUp={endDrawerResize}
                onPointerCancel={endDrawerResize}
              />
            }
            onCollapse={(collapsed) => handleDrawerCollapse("left", collapsed)}
            onSplit={(direction) => handleDrawerSplit("left", direction)}
            onClosePane={(paneId) => handlePaneClose("left", paneId)}
            onTabChange={handleLeftTabChange}
          />
        </div>

        <div
          ref={chartColumnRef}
          className="terminal-chart-column order-1 flex min-h-[calc(100dvh-3.5rem)] min-w-0 flex-1 scroll-mt-16 flex-col sm:min-h-[720px] xl:order-none xl:h-full xl:min-h-0"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 bg-card/80 px-2">
              <span className="px-1 text-3xs font-semibold uppercase text-muted-foreground">
                Workspace
              </span>
              <div className="flex items-center gap-1" role="group" aria-label="Center workspace">
                <Button
                  type="button"
                  size="xs"
                  variant={centerWorkspaceMode === "chart" ? "secondary" : "ghost"}
                  className="h-6 gap-1 px-2 text-3xs"
                  aria-pressed={centerWorkspaceMode === "chart"}
                  onClick={() => setCenterWorkspaceMode("chart")}
                >
                  <CandlestickChart className="size-3" aria-hidden="true" />
                  Chart
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={centerWorkspaceMode === "pulse" ? "secondary" : "ghost"}
                  className="h-6 gap-1 px-2 text-3xs"
                  aria-pressed={centerWorkspaceMode === "pulse"}
                  onClick={() => setCenterWorkspaceMode("pulse")}
                >
                  <Newspaper className="size-3" aria-hidden="true" />
                  Pulse
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {centerWorkspaceMode === "chart" ? (
                <VenueAwareChartPanel
                  activeSymbol={activeSymbol}
                  activeCoin={activeCoin}
                  credentialId={selectedCredentialId}
                  stocksAvailable={stocksVenueState}
                  perpsAvailable={perpsVenueState}
                  onSymbolCommit={handleTradeSymbolCommit}
                  onCoinCommit={handleCoinCommit}
                  onSymbolTrade={(symbol) => {
                    handleTradeSymbolCommit(symbol);
                    activateRightTab("trade");
                  }}
                  onCoinTrade={(coin) => {
                    handleCoinCommit(coin);
                    activateRightTab("trade");
                  }}
                  bottomDrawer={renderBottomPane()}
                  bottomDrawerHeader={renderBottomDrawerHeader()}
                  bottomDrawerLabel="Account activity"
                  onBookPriceSelect={handleBookPriceSelect}
                />
              ) : (
                <MarketPulseWorkspace
                  perpsEnabled={PERPS_ENABLED}
                  onViewMarket={handlePulseMarketView}
                  onTradeMarket={handlePulseMarketTrade}
                />
              )}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "terminal-drawer-shell terminal-drawer-shell-right relative order-3 w-full shrink-0 xl:order-none xl:h-full xl:min-h-0",
            terminalLayout.right.collapsed && "min-h-12 xl:w-12",
            !terminalLayout.right.collapsed && "min-h-[360px] sm:min-h-[460px] xl:min-h-0",
            !terminalLayout.right.collapsed && "xl:flex xl:w-[var(--terminal-right-width)] xl:flex-col",
          )}
          style={
            terminalLayout.right.collapsed
              ? undefined
              : ({ "--terminal-right-width": `${balancedDrawerWidths.right}px` } as CSSProperties)
          }
        >
          <TerminalDrawer
            side="right"
            title="Modules"
            collapsedLabel="Modules"
            tabs={RIGHT_TERMINAL_TABS}
            state={terminalLayout.right}
            renderPane={(tab, paneId) => renderRightPane(tab, paneId)}
            resizeHandle={
              <DrawerResizeHandle
                drawerSide="right"
                ariaLabel="Resize modules drawer"
                min={RIGHT_DRAWER_MIN_WIDTH}
                max={RIGHT_DRAWER_MAX_WIDTH}
                now={balancedDrawerWidths.right}
                onPointerDown={(event) => startDrawerResize("right", event)}
                onPointerMove={(event) => handleDrawerResizeMove("right", event)}
                onPointerUp={endDrawerResize}
                onPointerCancel={endDrawerResize}
              />
            }
            onCollapse={(collapsed) => handleDrawerCollapse("right", collapsed)}
            onSplit={(direction) => handleDrawerSplit("right", direction)}
            onClosePane={(paneId) => handlePaneClose("right", paneId)}
            onTabChange={handleRightTabChange}
          />
        </div>
          </main>
        }
      />
      {responsiveShellMode === "desktop" && (
        <div className="hidden xl:block">
          <TerminalMarketTicker
            activeSymbol={activeSymbol}
            activePerpSymbol={activeCoin}
            onSelectSymbol={handleViewSymbol}
          />
        </div>
      )}

      {responsiveShellMode === "desktop" && aiPopoutOpen && (
        <aside
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+2.25rem)] right-3 z-40 hidden h-[min(56vh,520px)] w-[min(380px,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border/80 bg-background shadow-2xl xl:flex xl:flex-col"
          role="dialog"
          aria-label="AI research assistant"
          data-ai-popout="open"
        >
          <StockChatPanel
            isSignedIn={isSignedIn}
            selectedSignal={selectedSignal}
            activeSymbol={activeSymbol}
            activeCredentialId={selectedCredentialId}
            activeAccountType={selectedAccountType}
            activeAccountLabel={selectedAccountLabel}
            draftPrompt={chatDraftPrompt}
            onDraftOrder={handleDraftOrderFromChat}
            embedded
            onClose={() => setAiPopoutOpen(false)}
          />
        </aside>
      )}

      {/* Fix 4: Null-rendering side-effect component inside VenueProvider that
          switches the left drawer to X Signals when the user goes to stocks. */}
      <VenueAwareLeftTabSync
        onSwitchToStocks={() =>
          setTerminalLayout((layout) => {
            let next = layout;
            for (const pane of layout.left.panes) {
              next = updatePaneTab(next, "left", pane.id, "x_signals");
            }
            return next;
          })
        }
      />

      {/* Scope the mobile Markets browse list to the venue the user just
          picked, so the top switch visibly changes the screen under it. */}
      <VenueAwareMarketsFilterSync onVenueChange={setMobileMarketsBrowseFilter} />

    </div>
    </VenueProvider>
  );
}

/**
 * Plan A8. The mobile Portfolio tab: ONE portfolio spanning both venues.
 *
 * Overview is a total, then a row per connected venue with its own value and a
 * chevron into that venue's surface (Bullpen capture section 10). The rules for
 * which surface shows live in `./mobile-portfolio` so they are testable: with a
 * single connected venue this renders that venue directly, because an overview
 * would be a total restating the one row beneath it plus an extra tap.
 *
 * The two venue surfaces are deliberately different components, not two
 * instances of one: Alpaca has a portfolio-history endpoint (the equity curve),
 * Hyperliquid does not, so its venue-specific portfolio surface shows total
 * equity, trading collateral, and realized fills instead.
 *
 * There is no money-action row here. Mounting PerpsOnboardingCard would fire its
 * auto-enable effect and provision an agent wallet just from a user opening this
 * tab, and there is no withdraw or transfer path in the codebase to pair with a
 * Deposit button anyway.
 */
export function MobilePortfolioPanel({
  summary,
  navigation,
  onViewChange,
  stocksSurface,
  perpsSurface,
}: {
  summary: MobilePortfolioSummary;
  navigation: { view: MobilePortfolioView; canReturnToOverview: boolean };
  onViewChange: (view: MobilePortfolioView) => void;
  stocksSurface: ReactNode;
  perpsSurface: ReactNode;
}) {
  if (navigation.view !== "overview") {
    const row = summary.rows.find((item) => item.venue === navigation.view);
    return (
      <div
        data-mobile-portfolio-detail="true"
        className="flex min-w-0 flex-col rounded-2xl border bg-background"
      >
        {/* Skipped for a single-venue user: there is nothing to go back to, so
            the header would be a dead control. */}
        {navigation.canReturnToOverview && (
          <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
            <button
              type="button"
              onClick={() => onViewChange("overview")}
              aria-label="Back to portfolio overview"
              className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="h-4 w-4" />
              Portfolio
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {row?.label}
            </span>
          </div>
        )}
        {navigation.view === "stocks" && (
          <div className="grid shrink-0 grid-cols-2 border-b bg-card/40">
            <MobileVenueMetric
              label="Portfolio value"
              value={row?.value ?? null}
            />
            <MobileVenueMetric
              label="Buying power"
              value={row?.buyingPower ?? null}
            />
          </div>
        )}
        <div
          data-mobile-portfolio-detail-surface="true"
          className="min-w-0"
        >
          {navigation.view === "perps" ? perpsSurface : stocksSurface}
        </div>
      </div>
    );
  }

  return (
    <div
      data-mobile-portfolio-overview="true"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="shrink-0 rounded-2xl border bg-card/70 p-4">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">
          Total portfolio value
        </div>
        <div className="font-data tabular-nums text-3xl font-semibold leading-tight">
          {summary.total != null ? formatUsd(summary.total) : "-"}
        </div>
        {summary.hasUnresolvedVenue ? (
          // Checked FIRST. An unknown venue is given no row, so "no rows" also
          // covers "we have not heard back yet", and telling someone with a
          // connected broker to go connect one is the claim this whole tri-state
          // exists to prevent. A check that has FAILED is not still running, so
          // it must not keep saying it is.
          <p className="mt-1.5 text-xs text-muted-foreground">
            {/* No "retrying automatically" here, unlike the perps panel notice:
                that one covers `hyperliquid.status` alone, which carries a 60s
                refetchInterval. This covers `hasApiCredentials` too, which has
                no timer and only refetches on focus/reconnect after its
                retries, so promising a retry would be a claim we cannot keep. */}
            {summary.venueCheckFailed
              ? "Could not check your connected venues just now."
              : "Checking your connected venues…"}
          </p>
        ) : summary.rows.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Connect a broker or set up perpetual futures to see a value here.
          </p>
        ) : !summary.totalComplete ? (
          // Never present a short sum as the user's whole net worth.
          <p className="mt-1.5 text-xs text-muted-foreground">
            One venue has not reported a value yet, so this total is partial.
          </p>
        ) : null}
      </div>

      {summary.rows.length > 0 && (
        <div className="shrink-0 overflow-hidden rounded-2xl border bg-card/50">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b px-4 py-2 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
            <span>Account</span>
            <span className="w-24 text-right">Value</span>
            <span className="w-24 text-right">Buying power</span>
          </div>
          <ul className="divide-y">
            {summary.rows.map((row) => (
              <li key={row.venue}>
                <button
                  type="button"
                  onClick={() => onViewChange(row.venue)}
                  className="grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0 truncate text-sm font-medium">
                    {row.label}
                  </span>
                  <span className="w-24 shrink-0 text-right font-data tabular-nums text-sm font-semibold">
                    {row.value != null ? formatUsd(row.value) : "-"}
                  </span>
                  <span className="flex w-24 shrink-0 items-center justify-end gap-1 font-data tabular-nums text-sm font-semibold">
                    {row.venue === "stocks"
                      ? row.buyingPower != null
                        ? formatUsd(row.buyingPower)
                        : "-"
                      : "-"}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MobileVenueMetric({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  return (
    <div className="min-w-0 border-r px-3 py-2.5 last:border-r-0">
      <div className="truncate text-3xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate font-data tabular-nums text-base font-semibold">
        {value != null ? formatUsd(value) : "-"}
      </div>
    </div>
  );
}

/**
 * Mobile Trade is a presentation frame around the existing venue-aware rail.
 * The frame owns focus, backdrop, and the market identity line; its children
 * remain the real stock/perps forms supplied by TradingAppContent.
 */
export function MobileTradeSheet({
  sectionRef,
  marketHeader,
  isPerps,
  onChangeMarket,
  onClose,
  children,
}: {
  sectionRef: RefObject<HTMLElement | null>;
  marketHeader: MobileMarketHeader;
  isPerps: boolean;
  onChangeMarket: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-mobile-trade-sheet="true"
      className="fixed inset-0 z-[60] isolate flex min-h-[100dvh] items-end justify-center overscroll-none xl:hidden"
    >
      <button
        type="button"
        aria-label="Dismiss trade ticket"
        data-mobile-trade-sheet-backdrop="true"
        className="absolute inset-0 h-full w-full touch-manipulation bg-[#01080d]/75 backdrop-blur-[3px] transition-[background-color,opacity] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-reduce:animate-none motion-reduce:transition-none motion-reduce:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d]"
        onClick={onClose}
      />
      <section
        ref={sectionRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tradeSheetLabel({
          symbol: marketHeader.symbol,
          isPerps,
        })}
        data-mobile-trade-sheet-surface="true"
        className="relative flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden border-[#16313d] bg-[radial-gradient(circle_at_84%_0%,rgba(231,198,93,0.06),transparent_30%),#020f16] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200 motion-reduce:animate-none motion-reduce:transition-none motion-reduce:duration-0 shadow-[0_24px_80px_rgba(0,0,0,0.48)]"
      >
        <div
          aria-hidden="true"
          data-mobile-trade-sheet-handle="true"
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[#315463]"
        />
        <header
          data-mobile-trade-sheet-header="true"
          className="relative shrink-0 border-b border-[#17313c] bg-[#04141c]/96 px-4 py-2.5 shadow-[inset_0_1px_0_rgba(231,198,93,0.06)]"
        >
          <div className="flex min-h-14 items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-3xs font-semibold uppercase tracking-[0.16em] text-[#728d98]">
                  Trade ticket
                </span>
                {marketHeader.showPerpTag && (
                  <span className="shrink-0 rounded-md border border-[#786529]/80 bg-[#2a2412] px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-[0.12em] text-[#e7c65d]">
                    Perp
                  </span>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-baseline gap-2">
                <span className="truncate font-data text-base font-semibold text-[#f0f5f6]">
                  {marketHeader.symbol}
                </span>
                <span
                  className={cn(
                    "truncate font-data text-xs tabular-nums",
                    marketHeader.tone === "positive" && "text-[#48d597]",
                    marketHeader.tone === "negative" && "text-[#f17f7a]",
                    marketHeader.tone === "neutral" && "text-[#9fb3bb]",
                  )}
                >
                  {marketHeader.quoteLine}
                </span>
              </div>
            </div>
            {/* Switching markets is a distinct action, rather than metadata
                wedged between the ticker and its live quote. */}
            <button
              type="button"
              data-mobile-trade-sheet-market={marketHeader.symbol}
              onClick={onChangeMarket}
              aria-label={`Trading ${marketHeader.symbol}. Tap to change ticker.`}
              className="inline-flex min-h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-lg border border-[#274652] bg-[#081b24] px-2.5 text-xs font-semibold text-[#b7c9cf] transition-[background-color,border-color,color,transform] hover:border-[#786529] hover:bg-[#272414] hover:text-[#f0d56c] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#04141c]"
            >
              <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden min-[390px]:inline">Change market</span>
              <span className="min-[390px]:hidden">Market</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close trade ticket"
              className="relative h-9 w-9 shrink-0 rounded-lg border border-[#1f3d49] bg-[#081b24] text-[#9bb2bb] before:absolute before:-inset-1 before:content-[''] transition-[background-color,border-color,color,transform] hover:border-[#315463] hover:bg-[#0c2530] hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#04141c]"
              onClick={onClose}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </header>
        <div
          data-testid="mobile-trade-sheet-scroll"
          className="min-h-0 min-w-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        >
          {children}
        </div>
      </section>
    </div>
  );
}

// Desktop header hamburger: the page-level links that used to sit in the
// center nav. "Trade" is dropped (it just pointed at this page); Leaderboard,
type AppNotification = {
  kind: "fill" | "copy_failure";
  id: string;
  symbol: string;
  occurredAt: string | null;
  readAt: string | null;
  message: string;
};

/** Persistent, private inbox for trade fills and mirror failures. */
function AppNotifications({ enabled }: { enabled: boolean }) {
  const utils = trpc.useUtils();
  const notificationsQuery = trpc.copyTrade.recentNotifications.useQuery(undefined, {
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const markRead = trpc.copyTrade.markNotificationRead.useMutation({
    onSuccess: (_result, input) => {
      utils.copyTrade.recentNotifications.setData(undefined, (current) =>
        current?.map((notification) =>
          notification.kind === input.kind && notification.id === input.id
            ? { ...notification, readAt: new Date().toISOString() }
            : notification,
        ),
      );
    },
  });
  const markAllRead = trpc.copyTrade.markAllNotificationsRead.useMutation({
    onSuccess: () => {
      const readAt = new Date().toISOString();
      utils.copyTrade.recentNotifications.setData(undefined, (current) =>
        current?.map((notification) => ({ ...notification, readAt })),
      );
    },
  });
  const notifications = (notificationsQuery.data ?? []) as AppNotification[];
  const unread = notifications.filter((notification) => notification.readAt === null).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative min-h-11 min-w-11 lg:min-h-0 lg:min-w-0"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-background"
              aria-hidden
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="terminal-floating-surface w-96 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {unread > 0 && (
            <span className="flex items-center gap-2">
              <span className="text-xs font-normal text-muted-foreground">{unread} unread</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs font-medium"
                disabled={markAllRead.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  markAllRead.mutate();
                }}
              >
                {markAllRead.isPending ? "Marking…" : "Mark all read"}
              </Button>
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {notificationsQuery.isLoading ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">Loading notifications…</div>
        ) : notificationsQuery.error ? (
          <div className="px-2 py-4 text-sm text-destructive">Could not load notifications.</div>
        ) : notifications.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">No notifications yet.</div>
        ) : (
          notifications.map((notification) => (
            <DropdownMenuItem
              key={`${notification.kind}:${notification.id}`}
              className="items-start gap-2 whitespace-normal py-3"
              onSelect={() => {
                if (notification.readAt === null && !markRead.isPending) {
                  markRead.mutate({ kind: notification.kind, id: notification.id });
                }
              }}
            >
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  notification.readAt === null ? "bg-destructive" : "bg-muted-foreground/30",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-sm leading-snug">{notification.message}</span>
                {notification.occurredAt && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(notification.occurredAt))}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Guide, and Settings move in here. Settings also stays as a header gear.
function HeaderMenu({
  paperAccount,
  liveAccount,
  accountMode,
  onAccountModeChange,
}: {
  paperAccount?: BrokerAccount;
  liveAccount?: BrokerAccount;
  accountMode: AccountMode;
  onAccountModeChange: (mode: AccountMode) => void;
}) {
  const hasBothAccounts = !!paperAccount && !!liveAccount;
  const items = [
    { href: "/lb", label: "Leaderboard", icon: Trophy },
    { href: "/guide", label: "Guide", icon: BookOpen },
    { href: "/settings", label: "Settings", icon: Settings },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          className="hidden shrink-0 lg:inline-flex"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Menu</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map(({ href, label, icon: Icon }) => (
          <DropdownMenuItem key={href} asChild>
            <Link href={href}>
              <Icon className="mr-2 h-4 w-4" />
              <span>{label}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        {hasBothAccounts && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Alpaca Settings</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => onAccountModeChange("PAPER")}
              className={cn(accountMode === "PAPER" && "bg-accent text-accent-foreground")}
            >
              <FileText className="mr-2 h-4 w-4" />
              <span>Paper</span>
              {accountMode === "PAPER" && <span className="ml-auto text-xs opacity-60">active</span>}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onAccountModeChange("LIVE")}
              className={cn(accountMode === "LIVE" && "bg-destructive/15 text-destructive")}
            >
              <Zap className="mr-2 h-4 w-4" />
              <span>Live</span>
              {accountMode === "LIVE" && <span className="ml-auto text-xs opacity-60">active</span>}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TerminalLayoutMenu({
  leftCollapsed,
  rightCollapsed,
  onToggleLeft,
  onToggleRight,
  onFocusChart,
  onReset,
}: {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onFocusChart: () => void;
  onReset: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="terminal-icon-action hidden xl:inline-flex"
          aria-label="Customize terminal layout"
          title="Customize layout"
        >
          <PanelRight className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="terminal-floating-surface w-56">
        <DropdownMenuLabel>Workspace layout</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onToggleLeft}>
          <PanelLeft className="size-4" aria-hidden />
          {leftCollapsed ? "Show discovery" : "Hide discovery"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleRight}>
          <PanelRight className="size-4" aria-hidden />
          {rightCollapsed ? "Show modules" : "Hide modules"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onFocusChart}>
          <Maximize2 className="size-4" aria-hidden />
          Focus chart
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset}>
          <RotateCcw className="size-4" aria-hidden />
          Reset layout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
