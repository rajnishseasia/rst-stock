"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp, RotateCcw, Search } from "lucide-react";
import { AdvancedChart } from "@/components/charts/advanced-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { LiveDataValue } from "@/components/ui/live-data-value";
import { ChangeBadge } from "@/components/ui/change-badge";
import { normalizeMarketSymbol } from "@/lib/market-selection";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  formatCompactUsd,
  formatPriceUsd,
  formatSignedNumber,
  formatSignedUsd,
} from "@/lib/format";
import {
  formatPerpFundingPct,
  formatPerpQuote,
  formatPerpUsd,
} from "@/components/perps/perp-format";
import { perpMarketOpenInterestUsd } from "@/components/perps/perp-market-sort";
import { ChartOverlayToggleGroup } from "./chart-overlay-toggle-group";
import { ChartResizeHandle } from "./chart-resize-handle";
import {
  attachGlobalPointerDrag,
  canResizeDrawer,
  clamp,
  computeDragResizedHeight,
  computeKeyboardResizedHeight,
  computeTradeHeightBounds,
  finiteNumber,
  parseStoredTradeHeight,
  resolveChromeHeight,
  INITIAL_BOTTOM_DRAWER_HEIGHT,
  MIN_BOTTOM_DRAWER_HEIGHT,
  MIN_CHART_HEIGHT,
  MOBILE_MIN_CHART_HEIGHT,
} from "./terminal-chart-panel-layout";

export interface TerminalChartPanelProps {
  symbol: string;
  credentialId?: string;
  tradePanel?: ReactNode;
  bottomDrawer?: ReactNode;
  bottomDrawerHeader?: ReactNode;
  bottomDrawerLabel?: string;
  compactChrome?: boolean;
  /**
   * Data-source venue. Defaults to "stocks" (Alpaca bars/quote). Perps pass
   * "perps" so the chart datafeed branches to the Hyperliquid source; the branch
   * itself lands in the datafeed step, so today this is a forward-compatible
   * passthrough that leaves the stock chart path untouched.
   */
  venue?: "stocks" | "perps";
  onSymbolCommit: (symbol: string) => void;
  /**
   * Optional rail rendered as a right-hand flex sibling of the chart canvas
   * (desktop perps order book). It sits OUTSIDE `.terminal-chart-canvas` on
   * purpose: that class is pointer-events-disabled while the command bar's
   * dropdown is open, and a rail the user can click must not inherit that.
   * The rail owns its own `xl:` visibility and its own query gating.
   */
  chartSideRail?: ReactNode;
  /** Called when the user clicks the Trade button (in addition to committing the symbol). */
  onTrade?: (symbol: string) => void;
  /**
   * Optional unified-search node rendered in the header in place of the plain
   * symbol input. When provided (desktop terminal), it becomes the primary
   * market picker and can switch venues; the plain `InputGroup` below is the
   * fallback for surfaces that don't wire the unified search.
   */
  headerSearch?: ReactNode;
}

const FALLBACK_SYMBOL = "SPY";
const CHART_BOTTOM_DRAWER_STORAGE_KEY =
  "ready-set-trade.terminal-chart-bottom-drawer.v1";
const CHART_BOTTOM_DRAWER_COLLAPSED_STORAGE_KEY =
  "ready-set-trade.terminal-chart-bottom-drawer-collapsed.v1";
const RESET_CHART_LAYOUT_EVENT = "ready-set-trade:reset-chart-layout";

export function TerminalStat({
  label,
  value,
  tone = "neutral",
  priority = "normal",
  liveValue,
  badge = false,
  className,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative";
  priority?: "primary" | "normal";
  liveValue?: number;
  /** Render the value as the shared gain/loss ChangeBadge instead of text. */
  badge?: boolean;
  className?: string;
}) {
  const content = badge ? (
    <ChangeBadge text={value} tone={tone} className="font-data" />
  ) : (
    value
  );
  return (
    <div
      data-terminal-stat-priority={priority}
      data-terminal-stat-tone={tone}
      className={cn(
        "terminal-stat min-w-24 shrink-0 border-l border-border/55 px-2.5 py-0.5 sm:min-w-0",
        priority === "primary" && "min-w-28 first:border-l-0",
        className,
      )}
    >
      <div className="text-3xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "truncate font-data text-sm font-semibold tabular-nums",
          !badge && tone === "positive" && "text-green-400",
          !badge && tone === "negative" && "text-red-400",
        )}
      >
        {liveValue == null ? (
          content
        ) : (
          <LiveDataValue value={liveValue} format={() => content} fallback={content} />
        )}
      </div>
    </div>
  );
}

export function TerminalChartPanel({
  symbol,
  credentialId,
  tradePanel,
  bottomDrawer,
  bottomDrawerHeader,
  bottomDrawerLabel = "Chart bottom drawer",
  compactChrome = false,
  venue = "stocks",
  chartSideRail,
  onSymbolCommit,
  onTrade,
  headerSearch,
}: TerminalChartPanelProps) {
  const isPerps = venue === "perps";
  const terminalPanelRef = useRef<HTMLElement>(null);
  const chartHostRef = useRef<HTMLDivElement>(null);
  // Venue-aware normalization: stocks trim + uppercase; perp coins keep HL's
  // canonical case-sensitive spelling (kPEPE), or candle/snapshot lookups fail.
  const activeSymbol = normalizeMarketSymbol(venue, symbol) || FALLBACK_SYMBOL;
  const [draftSymbol, setDraftSymbol] = useState(activeSymbol);
  const [chartHeight, setChartHeight] = useState(compactChrome ? 400 : 520);
  const [tradePanelHeight, setTradePanelHeight] = useState(
    INITIAL_BOTTOM_DRAWER_HEIGHT,
  );
  const [tradeHeightBounds, setTradeHeightBounds] = useState({
    min: MIN_BOTTOM_DRAWER_HEIGHT,
    max: INITIAL_BOTTOM_DRAWER_HEIGHT,
  });
  const [isResizingTradePanel, setIsResizingTradePanel] = useState(false);
  const [tradeSplitHydrated, setTradeSplitHydrated] = useState(false);
  const [bottomDrawerCollapsed, setBottomDrawerCollapsed] = useState(false);
  // Once the user drags/keys the split (or we restore a saved value), stop
  // auto-sizing the trade panel to a share of the height and respect the chosen
  // value instead.
  const tradeHeightUserSetRef = useRef(false);
  const [showExecutions, setShowExecutions] = useState(true);
  const [showSignals, setShowSignals] = useState(true);
  const bottomDrawerContent = bottomDrawer ?? tradePanel;
  const hasBottomDrawer = !!bottomDrawerContent;

  // The equity quote/position readouts are Alpaca-shaped; for perps we skip them
  // (the perp positions live in the bottom drawer's PerpPositionsPanel) so we
  // never call the stock endpoints with a coin symbol.
  const quoteQuery = trpc.quotes.getChartQuote.useQuery(
    { symbol: activeSymbol },
    {
      enabled: !!activeSymbol && !isPerps,
      refetchInterval: 15_000,
      staleTime: 10_000,
      retry: false,
    },
  );
  const positionsQuery = trpc.positions.list.useQuery(
    { credentialId },
    {
      enabled: !!credentialId && !isPerps,
      refetchInterval: 30_000,
      staleTime: 10_000,
      retry: false,
    },
  );
  // Perps use Hyperliquid market data (keyless): mark / prevDay / bid-ask feed
  // the same header strip. Poll on a short interval since crypto trades 24/7 and
  // moves faster than the 15s equity quote cadence.
  const perpSnapshotQuery = trpc.hyperliquid.assetSnapshot.useQuery(
    { coin: activeSymbol },
    {
      enabled: !!activeSymbol && isPerps,
      refetchInterval: 5_000,
      staleTime: 3_000,
      retry: false,
    },
  );
  const perpSnapshot = perpSnapshotQuery.data;
  const perpQuote = formatPerpQuote(perpSnapshot);
  // HL reports open interest in coin units, which is unreadable across coins
  // that differ by five orders of magnitude in unit price. Value it at the mark
  // so the strip shows the notional dollars a trader actually compares.
  const perpOpenInterestUsd = perpSnapshot
    ? perpMarketOpenInterestUsd(perpSnapshot)
    : null;

  const quote = quoteQuery.data;
  const activePosition = positionsQuery.data?.find(
    (position) => position.symbol.toUpperCase() === activeSymbol,
  );
  const changePercent = Number(quote?.changePercent ?? 0);
  const changeTone =
    !Number.isFinite(changePercent) || changePercent === 0
      ? "neutral"
      : changePercent > 0
        ? "positive"
        : "negative";
  const positionPnl = activePosition?.unrealizedPL;
  const positionPnlTone =
    positionPnl == null || positionPnl === 0
      ? "neutral"
      : positionPnl > 0
        ? "positive"
        : "negative";

  useEffect(() => {
    setDraftSymbol(activeSymbol);
  }, [activeSymbol]);

  // Restore the persisted chart/trade vertical split (desktop only - the
  // compact mobile chart has no resizable trade panel). The clamp effect below
  // keeps the restored value within the currently available bounds.
  useEffect(() => {
    if (!hasBottomDrawer) return;
    const storedHeight = parseStoredTradeHeight(
      window.localStorage.getItem(CHART_BOTTOM_DRAWER_STORAGE_KEY),
    );
    if (storedHeight != null) {
      tradeHeightUserSetRef.current = true;
      setTradePanelHeight(storedHeight);
    }
    setBottomDrawerCollapsed(
      window.localStorage.getItem(CHART_BOTTOM_DRAWER_COLLAPSED_STORAGE_KEY) ===
        "true",
    );
    setTradeSplitHydrated(true);
  }, [hasBottomDrawer]);

  useEffect(() => {
    if (!hasBottomDrawer || !tradeSplitHydrated) return;
    // Only persist a height the user actually chose. The proportional auto
    // default is recomputed from the viewport on each load, so saving it would
    // freeze the split and lose the responsive default on later visits.
    if (!tradeHeightUserSetRef.current) return;
    window.localStorage.setItem(
      CHART_BOTTOM_DRAWER_STORAGE_KEY,
      String(Math.round(tradePanelHeight)),
    );
  }, [hasBottomDrawer, tradeSplitHydrated, tradePanelHeight]);

  useEffect(() => {
    if (!hasBottomDrawer || !tradeSplitHydrated) return;
    window.localStorage.setItem(
      CHART_BOTTOM_DRAWER_COLLAPSED_STORAGE_KEY,
      String(bottomDrawerCollapsed),
    );
  }, [bottomDrawerCollapsed, hasBottomDrawer, tradeSplitHydrated]);

  useEffect(() => {
    const resetChartLayout = () => {
      tradeHeightUserSetRef.current = false;
      window.localStorage.removeItem(CHART_BOTTOM_DRAWER_STORAGE_KEY);
      window.localStorage.removeItem(CHART_BOTTOM_DRAWER_COLLAPSED_STORAGE_KEY);
      const bounds = getTradeHeightBounds();
      setTradePanelHeight(bounds.autoDefault);
      setBottomDrawerCollapsed(false);
    };

    window.addEventListener(RESET_CHART_LAYOUT_EVENT, resetChartLayout);
    return () => window.removeEventListener(RESET_CHART_LAYOUT_EVENT, resetChartLayout);
  }, [hasBottomDrawer]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;

    const updateHeight = () => {
      const minChartHeight =
        window.innerWidth < 1024 ? MOBILE_MIN_CHART_HEIGHT : MIN_CHART_HEIGHT;
      const nextHeight = Math.max(
        minChartHeight,
        Math.floor(host.getBoundingClientRect().height),
      );
      setChartHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(host);

    return () => observer.disconnect();
  }, []);

  const commitDraftSymbol = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const nextSymbol = normalizeMarketSymbol(venue, draftSymbol);
    if (!nextSymbol) return;
    onSymbolCommit(nextSymbol);
  };

  const getTradeHeightBounds = () => {
    const panel = terminalPanelRef.current;
    if (!panel) {
      return {
        min: MIN_BOTTOM_DRAWER_HEIGHT,
        max: INITIAL_BOTTOM_DRAWER_HEIGHT,
        autoDefault: INITIAL_BOTTOM_DRAWER_HEIGHT,
      };
    }

    const viewportWidth = window.innerWidth;
    const panelHeight = panel.getBoundingClientRect().height;
    const isCompact = viewportWidth < 1024;

    // The compact branch sizes the drawer to a fixed mobile/tablet height and
    // never consults the chart chrome, so skip measuring it there.
    const chromeHeight = isCompact
      ? 0
      : resolveChromeHeight(
          Array.from(panel.children).reduce((height: number, child) => {
            if (child === chartHostRef.current) return height;
            if (child.getAttribute("aria-label") === bottomDrawerLabel) return height;
            return height + child.getBoundingClientRect().height;
          }, 0),
        );

    return computeTradeHeightBounds({ viewportWidth, panelHeight, chromeHeight });
  };

  useEffect(() => {
    if (!hasBottomDrawer) return;
    const panel = terminalPanelRef.current;
    if (!panel) return;

    // Only track the available bounds here. The rendered height is clamped to
    // these bounds at render time (`clampedTradePanelHeight`), so we must NOT
    // mutate `tradePanelHeight` itself during the first layout passes.
    const updateBounds = () => {
      const bounds = getTradeHeightBounds();
      setTradeHeightBounds({ min: bounds.min, max: bounds.max });
      // Until the user picks a size, keep the bottom drawer at its proportional
      // default so the chart stays dominant as the column/window resizes.
      if (!tradeHeightUserSetRef.current) {
        setTradePanelHeight((height) =>
          height === bounds.autoDefault ? height : bounds.autoDefault,
        );
      }
    };

    updateBounds();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateBounds);
      return () => window.removeEventListener("resize", updateBounds);
    }

    const observer = new ResizeObserver(updateBounds);
    observer.observe(panel);

    return () => observer.disconnect();
  }, [hasBottomDrawer, bottomDrawerLabel]);

  useEffect(() => {
    if (!isResizingTradePanel) return;

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isResizingTradePanel]);

  const resizeTradePanelFromPointer = (clientY: number) => {
    const panel = terminalPanelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const { min, max } = getTradeHeightBounds();
    tradeHeightUserSetRef.current = true;
    setTradePanelHeight(
      computeDragResizedHeight({ panelBottom: rect.bottom, pointerClientY: clientY, min, max }),
    );
  };

  useEffect(() => {
    if (!isResizingTradePanel) return;

    return attachGlobalPointerDrag(window, {
      onMove: resizeTradePanelFromPointer,
      onEnd: () => setIsResizingTradePanel(false),
    });
  }, [isResizingTradePanel]);

  const handleResizePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    const { min, max } = getTradeHeightBounds();
    if (!canResizeDrawer(min, max)) return;

    event.preventDefault();
    setBottomDrawerCollapsed(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingTradePanel(true);
    resizeTradePanelFromPointer(event.clientY);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isResizingTradePanel) return;
    event.preventDefault();
    resizeTradePanelFromPointer(event.clientY);
  };

  const handleResizePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizingTradePanel(false);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!bottomDrawerContent) return;

    const { min, max } = getTradeHeightBounds();
    if (!canResizeDrawer(min, max)) return;

    const nextHeight = computeKeyboardResizedHeight({
      key: event.key,
      shiftKey: event.shiftKey,
      currentHeight: tradePanelHeight,
      min,
      max,
    });
    if (nextHeight == null) return;

    if (event.key === "ArrowUp") {
      setBottomDrawerCollapsed(false);
    }

    event.preventDefault();
    tradeHeightUserSetRef.current = true;
    setTradePanelHeight(nextHeight);
  };

  const { min: minTradeHeight, max: maxTradeHeight } = tradeHeightBounds;
  const clampedTradePanelHeight = clamp(
    tradePanelHeight,
    minTradeHeight,
    maxTradeHeight,
  );
  const canResizeTradePanel = canResizeDrawer(minTradeHeight, maxTradeHeight);
  const resetChartLayout = () => {
    window.dispatchEvent(new Event(RESET_CHART_LAYOUT_EVENT));
  };
  const overlayToggleGroup = (
    <ChartOverlayToggleGroup
      showExecutions={showExecutions}
      showSignals={showSignals}
      onToggleExecutions={() => setShowExecutions((visible) => !visible)}
      onToggleSignals={() => setShowSignals((visible) => !visible)}
    />
  );

  return (
    <section
      ref={terminalPanelRef}
      aria-label="Terminal chart"
      className={cn(
        "terminal-chart-shell terminal-pane flex h-full flex-col overflow-hidden border bg-background",
        compactChrome
          ? "min-h-[400px]"
          : "min-h-[520px] sm:min-h-[720px] xl:min-h-[520px]",
      )}
    >
      {!compactChrome && (
        <form
          onSubmit={commitDraftSymbol}
          className="terminal-command-bar terminal-instrument-strip @container/chartbar relative z-20 flex shrink-0 items-center gap-2 overflow-visible border-b bg-background/95 p-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.03)]"
        >
          {headerSearch ?? (
          <InputGroup className="h-10 w-[180px] shrink-0 bg-card/80 @[760px]/chartbar:w-[220px] @[920px]/chartbar:w-[250px]">
            <InputGroupAddon align="inline-start">
              <Search data-icon="inline-start" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Chart symbol"
              value={draftSymbol}
              onChange={(event) =>
                setDraftSymbol(normalizeMarketSymbol(venue, event.target.value))
              }
              onBlur={() => commitDraftSymbol()}
              placeholder="Search ticker..."
              className="font-data text-sm font-semibold uppercase tracking-normal"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                variant="secondary"
                size="sm"
                aria-label="Trade symbol"
                onClick={(e) => {
                  e.preventDefault();
                  const next = normalizeMarketSymbol(venue, draftSymbol);
                  if (!next) return;
                  onSymbolCommit(next);
                  onTrade?.(next);
                }}
              >
                Trade
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          )}

          <div className="flex min-w-max shrink-0 items-center gap-2">
            {isPerps ? (
              <>
                <TerminalStat
                  label="Price"
                  value={perpQuote.price}
                  liveValue={finiteNumber(perpSnapshot?.markPx)}
                  priority="primary"
                />
                <TerminalStat
                  label="Day Change"
                  badge
                  value={perpQuote.dayChange}
                  liveValue={
                    finiteNumber(perpSnapshot?.markPx) != null &&
                    finiteNumber(perpSnapshot?.prevDayPx) != null &&
                    Number(perpSnapshot?.prevDayPx) !== 0
                      ? ((Number(perpSnapshot?.markPx) - Number(perpSnapshot?.prevDayPx)) /
                          Number(perpSnapshot?.prevDayPx)) *
                        100
                      : undefined
                  }
                  tone={perpQuote.dayChangeTone}
                  priority="primary"
                />
                {/*
                  Perps order these by what a perp trader scans, which is not
                  the stocks order below. Funding (what the position costs to
                  hold) and open interest (how crowded the book is) take the
                  first two optional breakpoints; Bid / Ask drops behind them
                  because the desktop perps chart already renders a live L2
                  rail beside it, and the index price is the last thing read.
                  Nothing is lost as the column narrows: every one of these is
                  also in the "More" menu below, at any width.
                */}
                {/*
                  The interval is part of the label, not a detail: Hyperliquid
                  funds hourly while several venues quote an 8h rate, so a bare
                  "Funding" invites a reader to compare this figure against a
                  number eight times its size. The "More" menu says the same.
                */}
                <TerminalStat
                  label="Funding (1h)"
                  value={formatPerpFundingPct(perpSnapshot?.funding)}
                  className="hidden @[760px]/chartbar:block"
                />
                <TerminalStat
                  label="24h Vol"
                  value={formatCompactUsd(perpSnapshot?.dayNtlVlm)}
                  className="hidden @[880px]/chartbar:block"
                />
                <TerminalStat
                  label="Open Interest"
                  value={formatCompactUsd(perpOpenInterestUsd)}
                  className="hidden @[1020px]/chartbar:block"
                />
                <TerminalStat
                  label="Bid / Ask"
                  value={perpQuote.bidAsk}
                  className="hidden @[1180px]/chartbar:block"
                />
                <TerminalStat
                  label="Oracle"
                  value={formatPerpUsd(perpSnapshot?.oraclePx)}
                  className="hidden @[1320px]/chartbar:block"
                />
              </>
            ) : (
              <>
                <TerminalStat
                  label="Price"
                  value={formatPriceUsd(quote?.last)}
                  liveValue={finiteNumber(quote?.last)}
                  priority="primary"
                />
                <TerminalStat
                  label="Day Change"
                  badge
                  value={formatSignedNumber(quote?.changePercent, "%")}
                  liveValue={finiteNumber(quote?.changePercent)}
                  tone={changeTone}
                  priority="primary"
                />
                <TerminalStat
                  label="Bid / Ask"
                  value={`${formatPriceUsd(quote?.bid)} / ${formatPriceUsd(quote?.ask)}`}
                  className="hidden @[760px]/chartbar:block"
                />
                <TerminalStat
                  label="Position"
                  value={
                    activePosition
                      ? `${activePosition.qty} @ ${formatPriceUsd(activePosition.avgEntryPrice)}`
                      : "Flat"
                  }
                  className="hidden @[880px]/chartbar:block"
                />
                <TerminalStat
                  label="Position P&L"
                  value={
                    activePosition
                      ? `${formatSignedUsd(activePosition.unrealizedPL)} (${formatSignedNumber(activePosition.unrealizedPLPercent, "%")})`
                      : "-"
                  }
                  tone={positionPnlTone}
                  className="hidden @[1020px]/chartbar:block"
                />
              </>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {isPerps ? (
                  <DropdownMenuGroup>
                    <DropdownMenuItem className="justify-between">
                      <span>Bid / Ask</span>
                      <span className="font-data tabular-nums">
                        {perpQuote.bidAsk}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Mark</span>
                      <span className="font-data tabular-nums">
                        {formatPerpUsd(perpSnapshot?.markPx)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Oracle</span>
                      <span className="font-data tabular-nums">
                        {formatPerpUsd(perpSnapshot?.oraclePx)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Funding (1h)</span>
                      <span className="font-data tabular-nums">
                        {formatPerpFundingPct(perpSnapshot?.funding)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>24h Volume</span>
                      <span className="font-data tabular-nums">
                        {formatCompactUsd(perpSnapshot?.dayNtlVlm)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Open Interest</span>
                      <span className="font-data tabular-nums">
                        {formatCompactUsd(perpOpenInterestUsd)}
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                ) : (
                  <DropdownMenuGroup>
                    <DropdownMenuItem className="justify-between">
                      <span>Bid / Ask</span>
                      <span className="font-data tabular-nums">
                        {formatPriceUsd(quote?.bid)} / {formatPriceUsd(quote?.ask)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Day Range</span>
                      <span className="font-data tabular-nums">
                        {formatPriceUsd(quote?.low)} - {formatPriceUsd(quote?.high)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Volume</span>
                      <span className="font-data tabular-nums">
                        {quote?.volume || "-"}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Position</span>
                      <span className="font-data tabular-nums">
                        {activePosition
                          ? `${activePosition.qty} @ ${formatPriceUsd(activePosition.avgEntryPrice)}`
                          : "Flat"}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="justify-between">
                      <span>Position P&L</span>
                      <span className="font-data tabular-nums">
                        {activePosition
                          ? `${formatSignedUsd(activePosition.unrealizedPL)} (${formatSignedNumber(activePosition.unrealizedPLPercent, "%")})`
                          : "-"}
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={resetChartLayout}>
                  <RotateCcw className="size-3.5" aria-hidden />
                  Reset chart layout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </form>
      )}

      {/* The measured host is this ROW, not the canvas, so the chrome-height
          math in `getTradeHeightBounds` still recognises it as the chart's
          direct child and the reported height is unchanged by the rail. */}
      <div ref={chartHostRef} className="flex min-h-0 flex-1">
        <div className="terminal-chart-canvas terminal-canvas min-h-0 min-w-0 flex-1">
          <AdvancedChart
            symbol={activeSymbol}
            venue={venue}
            credentialId={credentialId}
            height={chartHeight}
            className={cn(
              "h-full w-full",
              compactChrome ? "min-h-[320px]" : "min-h-[260px]",
            )}
            showExecutions={showExecutions}
            showSignals={showSignals}
            // Compact chrome is the phone chart screen, where this chart sits in
            // a scrolling page: a vertical swipe on it must scroll that page.
            allowVerticalPageScroll={compactChrome}
          />
        </div>
        {chartSideRail}
      </div>

      {!compactChrome && !bottomDrawerContent && (
        <div className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-b bg-background/95 px-3">
          <span className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
            Chart overlays
          </span>
          {overlayToggleGroup}
        </div>
      )}

      {bottomDrawerContent && (
        <>
          <ChartResizeHandle
            canResize={canResizeTradePanel}
            isDragging={isResizingTradePanel}
            min={minTradeHeight}
            max={maxTradeHeight}
            value={clampedTradePanelHeight}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
            onKeyDown={handleResizeKeyDown}
          />

          <div
            aria-label={bottomDrawerLabel}
            className={cn(
              "terminal-bottom-drawer terminal-pane flex shrink-0 flex-col overflow-hidden bg-background transition-[height] duration-[var(--motion-panel)] ease-[var(--ease-terminal)]",
              isResizingTradePanel && "transition-none",
            )}
            style={{ height: bottomDrawerCollapsed ? 40 : clampedTradePanelHeight }}
          >
            <div className="terminal-pane-header flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
              <div className="min-w-0 flex-1">
                {bottomDrawerHeader ?? (
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className="font-data text-3xs">
                      {activeSymbol}
                    </Badge>
                    {quote && (
                      <span className="flex min-w-0 items-center gap-1.5 font-data text-2xs tabular-nums">
                        <span className="font-semibold text-foreground">
                          {formatPriceUsd(quote.last)}
                        </span>
                        <span
                          className={cn(
                            "shrink-0",
                            changeTone === "positive" && "text-green-400",
                            changeTone === "negative" && "text-red-400",
                            changeTone === "neutral" && "text-muted-foreground",
                          )}
                        >
                          {formatSignedNumber(quote.changePercent, "%")}
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!isPerps && !bottomDrawerCollapsed && (
                  <>
                  <span className="hidden text-3xs font-semibold uppercase tracking-wide text-muted-foreground sm:inline">
                    Chart overlays
                  </span>
                  {overlayToggleGroup}
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    bottomDrawerCollapsed
                      ? "Expand account activity"
                      : "Collapse account activity"
                  }
                  aria-expanded={!bottomDrawerCollapsed}
                  title={
                    bottomDrawerCollapsed
                      ? "Expand account activity"
                      : "Collapse account activity"
                  }
                  onClick={() => setBottomDrawerCollapsed((collapsed) => !collapsed)}
                >
                  {bottomDrawerCollapsed ? (
                    <ChevronUp className="size-3.5" aria-hidden />
                  ) : (
                    <ChevronDown className="size-3.5" aria-hidden />
                  )}
                </Button>
              </div>
            </div>
            {!bottomDrawerCollapsed && (
              <div className="terminal-pane-enter min-h-0 flex-1 overflow-hidden">
                {bottomDrawerContent}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
