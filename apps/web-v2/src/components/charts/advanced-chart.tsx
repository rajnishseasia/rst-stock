"use client";

/**
 * Single unified chart component built on TradingView's Advanced Charts
 * library (self-hosted bundle in `public/charting_library/`). Replaces both
 * the old `TradingViewChart` (free embed) and `LiveChart` (lightweight-charts)
 * components so there is one chart everywhere.
 *
 * What we get from TV out of the box:
 *   - Timeframe + timezone selectors, save layout, drawings, indicators,
 *     reset view, etc. - no custom toolbar code needed.
 *   - Marks / timescale marks for trade-execution and signal bubbles, fed by
 *     the datafeed adapter so we don't have to draw on a sibling canvas.
 *
 * What we keep custom:
 *   - The expand-to-near-fullscreen button (TV has fullscreen but we want the
 *     same in-page modal UX users already know).
 */

import { brandCandleOverrides } from "./chart-brand-colors";
import { useChartStopLosses } from "./use-chart-stop-losses";
import { useStopLossLines } from "./use-stop-loss-lines";
import { useChartPositionEntry } from "./use-chart-position-entry";
import { usePositionEntryLines } from "./use-position-entry-lines";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { Maximize2, Minimize2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  createTradingViewDatafeed,
  type ApiBar,
  type ApiExecutionGroup,
  type ApiSignal,
  type ApiSnapshot,
  type ApiTimeframe,
} from "./tv-datafeed";
import { perpFillsForChart } from "./perp-chart-annotations";
import { perpMidsQueryInput } from "./perp-market-data";
import type {
  IChartingLibraryWidget,
  ResolutionString,
  ThemeName,
} from "@/vendor/charting_library";

const LIBRARY_SCRIPT_SRC = "/charting_library/charting_library.standalone.js";
const LIBRARY_SCRIPT_ID = "tv-charting-library-script";
const CHART_INTERVAL_KEY = "tv_chart_interval";

type HlInterval = "1m" | "5m" | "15m" | "1h" | "1d";

/** Map our ApiTimeframe enum to an HL candle interval for the perps datafeed. */
const TIMEFRAME_TO_HL_INTERVAL: Record<ApiTimeframe, HlInterval> = {
  "1Min": "1m",
  "5Min": "5m",
  "15Min": "15m",
  "1H": "1h",
  "1D": "1d",
};

/** Milliseconds per HL interval, for computing a candle-snapshot start window. */
const HL_INTERVAL_MS: Record<HlInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

interface AdvancedChartProps {
  /** Symbol to display, e.g. "AAPL". */
  symbol: string;
  /**
   * Data-source venue. "stocks" (default) keeps the Alpaca bars/quote path
   * unchanged; "perps" branches the datafeed to Hyperliquid candles/mids.
   */
  venue?: "stocks" | "perps";
  /** Optional Alpaca credential id - scopes execution bubbles to one account. */
  credentialId?: string;
  /** Optional Alpaca account id - alternative scoping when credential isn't known. */
  accountId?: string;
  /** Initial bar resolution. Defaults to 1-hour (overridden by the user's
   *  last-used interval saved in localStorage). */
  initialResolution?: ResolutionString;
  /** Pixel height of the chart. */
  height?: number;
  /** Force light / dark theme. Auto-detected from <html class="dark"> if omitted. */
  theme?: ThemeName;
  /** Hide both trade-execution and signal bubbles (chart-preview surfaces).
   *  Convenience flag - equivalent to `showExecutions={false} showSignals={false}`. */
  hideAnnotations?: boolean;
  /** Show B/S trade-execution bubbles. Defaults to true unless `hideAnnotations`. */
  showExecutions?: boolean;
  /** Show X/Discord signal timescale bubbles. Defaults to true unless `hideAnnotations`. */
  showSignals?: boolean;
  /**
   * Draw the resting stop-loss levels for this instrument as red horizontal
   * lines. Defaults to true unless `hideAnnotations`. Off on preview surfaces,
   * which have no position context to draw against.
   */
  showStopLoss?: boolean;
  /**
   * Draw horizontal green line for active position entry price.
   * Defaults to true unless `hideAnnotations`.
   */
  showPositionEntry?: boolean;
  /**
   * Let a vertical touch drag over the chart scroll the PAGE instead of
   * panning the chart. For a chart embedded in a scrolling phone screen: the
   * widget's iframe otherwise captures every vertical swipe that lands on it,
   * and at 400px tall it is most of the screen, so the page below it (tabs,
   * feed, AI) could only be reached by swiping in the strip beside it.
   * Horizontal drags still scrub time and pinch still zooms. Construction-time
   * only, like `initialResolution`.
   */
  allowVerticalPageScroll?: boolean;
  /** Extra wrapper class names. */
  className?: string;
}

function detectTheme(): ThemeName {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Everything the widget cannot inherit from CSS, per theme: the dark pane
 * chrome that matches the terminal canvas, plus the brand candle colors for
 * BOTH themes. One definition, applied at construction and re-applied after
 * every changeTheme: TV repaints with its own stock palette on theme change,
 * so a light-initialized chart switched to dark otherwise shows unbranded
 * candles on TradingView's default dark chrome until remount.
 */
function themeChartOverrides(theme: "light" | "dark") {
  return {
    ...(theme === "dark"
      ? {
          "paneProperties.backgroundType": "solid" as const,
          "paneProperties.background": "#040d14",
          "paneProperties.vertGridProperties.color": "#10232d",
          "paneProperties.horzGridProperties.color": "#10232d",
          "scalesProperties.lineColor": "#18313f",
          "scalesProperties.textColor": "#91a4b3",
        }
      : {}),
    ...brandCandleOverrides(theme),
  };
}

export function AdvancedChart({
  symbol,
  venue = "stocks",
  credentialId,
  accountId,
  initialResolution = "60" as ResolutionString,
  height = 420,
  theme,
  hideAnnotations,
  showExecutions = !hideAnnotations,
  showSignals = !hideAnnotations,
  showStopLoss = !hideAnnotations,
  showPositionEntry = !hideAnnotations,
  allowVerticalPageScroll = false,
  className,
}: AdvancedChartProps) {
  const isPerps = venue === "perps";
  const containerId = "tv_chart_" + useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const readyRef = useRef(false);
  const utils = trpc.useUtils();

  const [scriptLoaded, setScriptLoaded] = useState<boolean>(
    typeof window !== "undefined" && !!window.TradingView
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [chartRevision, setChartRevision] = useState(0);
  const [expandedHeight, setExpandedHeight] = useState(height);
  const chartHeight = isExpanded ? expandedHeight : height;
  const resolvedTheme = theme ?? detectTheme();

  // Perp price precision comes from the HL universe (szDecimals). Fetched only
  // for the perps venue so the stock chart adds zero requests.
  const perpMetaQuery = trpc.hyperliquid.meta.useQuery(undefined, {
    enabled: isPerps,
    staleTime: 60_000,
  });
  const perpUniverse = perpMetaQuery.data?.universe;

  /**
   * Build async fetchers bound to the current scoping arguments. Recreated
   * when scoping props change so the datafeed always queries the right
   * account / signal feed. We don't want it to depend on `symbol`, because TV
   * passes the symbol to every datafeed call itself.
   *
   * Perps branch here: bars come from `hyperliquid.candleSnapshot`, live ticks
   * from `hyperliquid.allMids`, recent user fills provide execution bubbles,
   * and venue-filtered X calls provide signal bubbles. A `resolveSymbolInfo`
   * override gives the chart a 24x7 UTC session + a szDecimals-derived
   * pricescale.
   */
  const datafeed = useMemo(() => {
    if (isPerps) {
      return createTradingViewDatafeed({
        fetchBars: async ({ symbol: s, timeframe, limit }) => {
          const interval = TIMEFRAME_TO_HL_INTERVAL[timeframe];
          const intervalMs = HL_INTERVAL_MS[interval];
          const startTime = Date.now() - intervalMs * Math.max(limit, 1);
          try {
            // The coin is HL's canonical case-sensitive spelling (kPEPE):
            // pass it through untouched or the candle lookup misses.
            const candles = await utils.hyperliquid.candleSnapshot.fetch({
              coin: s,
              interval,
              startTime,
            });
            return (candles ?? []).map((c) => ({
              time: Math.floor(c.t / 1000), // HL ms -> our seconds
              open: Number(c.o),
              high: Number(c.h),
              low: Number(c.l),
              close: Number(c.c),
              volume: Number(c.v),
            })) as ApiBar[];
          } catch {
            return [];
          }
        },
        fetchSnapshot: async ({ symbol: s }) => {
          try {
            const mids = await utils.hyperliquid.allMids.ensureData(
              perpMidsQueryInput(s),
              { staleTime: 5_000 },
            );
            // Mids are keyed by canonical coin; try the exact spelling first.
            const mid = mids?.[s] ?? mids?.[s.toUpperCase()];
            if (mid == null) return null;
            return { last: mid } as ApiSnapshot;
          } catch {
            return null;
          }
        },
        fetchExecutionGroups: async ({ symbol: s }) => {
          if (!showExecutions) return [];
          try {
            const result = await utils.positions.listPerpFills.fetch({ limit: 500 });
            return perpFillsForChart(result?.fills ?? [], s);
          } catch {
            return [];
          }
        },
        fetchSignals: async ({ symbol: s }) => {
          if (!showSignals) return [];
          try {
            const result = await utils.signals.getForChart.fetch({
              symbol: s,
              venue: "perps",
              limit: 100,
            });
            return (result ?? []) as ApiSignal[];
          } catch {
            return [];
          }
        },
        resolveSymbolInfo: (s) => {
          const asset = perpUniverse?.find(
            (a) => a.coin.toUpperCase() === s.toUpperCase(),
          );
          // Price decimals on HL are (MAX_DECIMALS - szDecimals); perps use 6
          // max decimals for price. Fall back to 2 when meta isn't loaded yet.
          const priceDecimals =
            asset != null ? Math.max(0, 6 - asset.szDecimals) : 2;
          return {
            type: "crypto",
            session: "24x7",
            timezone: "Etc/UTC",
            pricescale: 10 ** priceDecimals,
            minmov: 1,
          };
        },
      });
    }
    return createTradingViewDatafeed({
      fetchBars: async ({ symbol: s, timeframe, limit }) => {
        const bars = await utils.quotes.getHistoricalBars.fetch({
          symbol: s,
          timeframe,
          limit,
        });
        return (bars ?? []) as ApiBar[];
      },
      fetchSnapshot: async ({ symbol: s }) => {
        try {
          // `ensureData` reads React Query's cache first and only fetches if
          // the entry is missing or stale. With staleTime: 12_000 we piggyback
          // on the trade-form / terminal-chart-panel queries (which already
          // refetch every 15 s) for the active symbol, so the chart adds zero
          // network load when those panels are mounted. For a chart shown
          // outside those surfaces it still polls - just at the slower 30 s
          // cadence (set in subscribeBars).
          const snap = await utils.quotes.getChartQuote.ensureData(
            { symbol: s },
            { staleTime: 12_000 }
          );
          return (snap as ApiSnapshot) ?? null;
        } catch {
          return null;
        }
      },
      fetchExecutionGroups: async ({ symbol: s }) => {
        if (!showExecutions) return [];
        try {
          const res = await utils.charts.getChartAnnotations.fetch({
            symbol: s,
            credentialId,
            accountId,
          });
          return ((res?.executionGroups ?? []) as unknown) as ApiExecutionGroup[];
        } catch {
          return [];
        }
      },
      fetchSignals: async ({ symbol: s }) => {
        if (!showSignals) return [];
        try {
          const res = await utils.signals.getForChart.fetch({
            symbol: s,
            venue: "stocks",
            limit: 100,
          });
          return (res ?? []) as ApiSignal[];
        } catch {
          return [];
        }
      },
    });
    // utils is a stable object from tRPC; including it would needlessly
    // rebuild the datafeed (and tear down the widget) on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId, accountId, showExecutions, showSignals, isPerps, perpUniverse]);

  /** Construct / destroy the widget. Rebuilt only when datafeed identity
   *  changes - symbol updates go through `setSymbol`, theme updates through
   *  `changeTheme`. */
  useEffect(() => {
    if (!scriptLoaded) return;
    if (typeof window === "undefined" || !window.TradingView) return;
    const container = containerRef.current;
    if (!container) return;

    readyRef.current = false;
    // Prefer the user's last-used interval from localStorage; fall back to the
    // prop (which itself defaults to "60" / 1H).
    const startInterval = (
      (typeof window !== "undefined" &&
        (localStorage.getItem(CHART_INTERVAL_KEY) as ResolutionString | null)) ||
      initialResolution
    );
    const widget = new window.TradingView.widget({
      container,
      symbol,
      interval: startInterval,
      datafeed,
      library_path: "/charting_library/",
      locale: "en",
      theme: resolvedTheme,
      autosize: true,
      timezone: isPerps ? "Etc/UTC" : "America/New_York",
      disabled_features: [
        // We don't expose multi-user save/load; turn off the cloud-save UI.
        "header_saveload",
        "use_localstorage_for_settings",
        // Volume profile etc. are paid TV extras we don't need.
        "popup_hints",
        // TradingView: "If disabled, the webpage is scrolled instead." See the
        // prop doc; this is what makes the mobile chart screen scrollable
        // past the chart.
        ...(allowVerticalPageScroll ? (["vert_touch_drag_scroll"] as const) : []),
      ],
      enabled_features: [
        "hide_left_toolbar_by_default",
        // Blob iframe loading can silently fail to paint in embedded browsers.
        // The vendored TradingView bundle includes sameorigin.html for this path.
        "iframe_loading_same_origin",
      ],
      custom_css_url: undefined,
      overrides: themeChartOverrides(resolvedTheme),
      loading_screen: {
        backgroundColor: resolvedTheme === "dark" ? "#040d14" : "#ffffff",
      },
    });
    widgetRef.current = widget;

    widget.onChartReady(() => {
      readyRef.current = true;
      setChartRevision((revision) => revision + 1);
      // Persist the interval whenever the user changes it so the next mount
      // starts on the same timeframe.
      try {
        widget
          .activeChart()
          .onIntervalChanged()
          .subscribe(null, (newInterval: ResolutionString) => {
            localStorage.setItem(CHART_INTERVAL_KEY, newInterval);
          });
      } catch {
        // ignore: chart may have been disposed before ready callback fires
      }
    });

    return () => {
      readyRef.current = false;
      try {
        widget.remove();
      } catch {
        // remove() throws if the iframe was already torn down by React's
        // strict-mode double-mount; swallow it.
      }
      widgetRef.current = null;
    };
    // initialResolution is a one-time seed; ignoring it deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptLoaded, datafeed]);

  /** Symbol changes: update in place rather than rebuilding the widget. */
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;
    const apply = () => {
      try {
        widget
          .activeChart()
          .setSymbol(symbol, () => {
            setChartRevision((revision) => revision + 1);
            // TV is supposed to refetch marks when symbolInfo changes, but in
            // practice the cache often holds the previous symbol's marks. Force
            // a refresh so B/S execution bubbles and signal timescale marks
            // both repaint for the new symbol.
            try {
              widget.activeChart().refreshMarks();
            } catch {
              // ignore - chart may have been disposed mid-flight
            }
          });
      } catch {
        // Chart not ready yet - onChartReady will fire and the next symbol
        // change will succeed. Initial mount already passes the symbol.
      }
    };
    if (readyRef.current) {
      apply();
    } else {
      widget.onChartReady(apply);
    }
  }, [symbol]);

  /** Theme changes: TV exposes `changeTheme` once the chart is ready. */
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;
    const apply = () => {
      try {
        // Re-apply our overrides AFTER the theme lands: changeTheme repaints
        // with TV's stock palette for the new theme, which would silently
        // drop the brand candles (and, on dark, the terminal-matched chrome).
        void widget
          .changeTheme(resolvedTheme)
          .then(() => widget.applyOverrides(themeChartOverrides(resolvedTheme)))
          .catch(() => {});
      } catch {
        // ignore: same reason as setSymbol above
      }
    };
    if (readyRef.current) apply();
    else widget.onChartReady(apply);
  }, [resolvedTheme]);

  /** Resting stop-loss levels, drawn as locked red horizontal lines. The
   *  reconciler is id-keyed, so a poll that returns the same levels redraws
   *  nothing and the lines do not flicker under the user. */
  const stopLossLines = useChartStopLosses({
    symbol,
    isPerps,
    credentialId,
    accountId,
    enabled: showStopLoss,
  });
  useStopLossLines({
    widgetRef,
    readyRef,
    lines: stopLossLines,
    theme: resolvedTheme,
    symbol,
    chartRevision,
  });

  /** Active position entry levels, drawn as locked green horizontal lines. */
  const positionEntryLines = useChartPositionEntry({
    symbol,
    isPerps,
    credentialId,
    accountId,
    enabled: showPositionEntry,
  });
  usePositionEntryLines({
    widgetRef,
    readyRef,
    lines: positionEntryLines,
    theme: resolvedTheme,
    symbol,
    chartRevision,
  });

  /** Expanded-mode: lock body scroll, escape to close, recalc height. */
  useEffect(() => {
    if (!isExpanded) return;
    const updateExpandedHeight = () => {
      setExpandedHeight(Math.max(360, window.innerHeight - 24));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsExpanded(false);
    };
    const prevOverflow = document.body.style.overflow;
    updateExpandedHeight();
    document.body.style.overflow = "hidden";
    window.addEventListener("resize", updateExpandedHeight);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("resize", updateExpandedHeight);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isExpanded]);

  const handleScriptReady = useCallback(() => setScriptLoaded(true), []);

  const rootClassName = isExpanded
    ? "fixed inset-3 z-50 overflow-hidden rounded-lg border border-border bg-card shadow-floating"
    : cn("relative", className);

  return (
    <div className={rootClassName} style={{ height: chartHeight }}>
      {/* The TV library serves its own bundle from /charting_library. We load
          it once globally; subsequent mounts skip the network call. */}
      <Script
        id={LIBRARY_SCRIPT_ID}
        src={LIBRARY_SCRIPT_SRC}
        strategy="afterInteractive"
        onReady={handleScriptReady}
        onLoad={handleScriptReady}
      />

      {/* Expand / collapse toggle - mirrors the LiveChart UX. The rest of the
          toolbar (timeframe, timezone, reset, drawings) lives inside TV. */}
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        aria-label={isExpanded ? "Collapse expanded chart" : "Expand chart"}
        title={isExpanded ? "Collapse chart" : "Expand chart"}
        className="absolute right-2 top-2 z-30 rounded-md bg-background/80 p-1 text-muted-foreground backdrop-blur hover:bg-muted/60"
      >
        {isExpanded ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </button>

      <div
        id={containerId}
        ref={containerRef}
        style={{ width: "100%", height: chartHeight }}
      />
    </div>
  );
}
