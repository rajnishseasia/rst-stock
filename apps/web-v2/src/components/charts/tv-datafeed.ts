/**
 * Datafeed adapter that connects TradingView Advanced Charts to our existing
 * Alpaca-backed tRPC endpoints. The factory takes already-bound async fetchers
 * (the React wrapper supplies them via `trpc.useUtils()`), so this file stays
 * pure / framework-free and easy to unit-test.
 *
 * Surface implemented:
 *   - onReady               → static DatafeedConfiguration
 *   - resolveSymbol         → minimal LibrarySymbolInfo (NYSE/NASDAQ defaults)
 *   - searchSymbols         → stub (returns the typed value as a single result)
 *   - getBars               → wraps quotes.getHistoricalBars
 *   - subscribeBars         → polls quotes.getChartQuote on a 30 s timer and
 *                             rolls the in-progress candle forward. The fetch
 *                             goes through React Query's cache (staleTime 12 s
 *                             - see advanced-chart.tsx), so when the
 *                             trade-form / terminal-chart-panel queries are
 *                             already running for the same symbol we serve
 *                             from cache and add zero Alpaca load.
 *   - unsubscribeBars       → clears the interval
 *   - getMarks              → fans out to charts.getChartAnnotations
 *                             (execution B/S bubbles) AND signals.getForChart
 *                             (X/Discord signal bubbles), returning both as
 *                             on-chart Marks so they stack on the candles
 *                             instead of the timescale axis
 */

import {
  CHART_DOWN_BORDER,
  CHART_DOWN_COLOR,
  CHART_UP_BORDER,
  CHART_UP_COLOR,
} from "./chart-brand-colors";
import type {
  IDatafeedChartApi,
  IExternalDatafeed,
  LibrarySymbolInfo,
  Bar,
  Mark,
  ResolutionString,
  PeriodParams,
  HistoryCallback,
  DatafeedErrorCallback,
  ResolveCallback,
  SearchSymbolsCallback,
  SubscribeBarsCallback,
  OnReadyCallback,
  DatafeedConfiguration,
} from "@/vendor/charting_library";
import {
  normalizeAuthorName,
  stripTweetShift,
} from "@/lib/signal-display";

/** Timeframes the existing quotes router accepts. */
export type ApiTimeframe = "1Min" | "5Min" | "15Min" | "1H" | "1D";

/** Map a TV resolution string to our API's enum. Resolution can be "1", "5",
 *  "15", "60", "1D" etc. Unknown values fall back to 5Min. */
function resolutionToTimeframe(resolution: string): ApiTimeframe {
  switch (resolution) {
    case "1":
      return "1Min";
    case "5":
      return "5Min";
    case "15":
      return "15Min";
    case "60":
    case "1H":
      return "1H";
    case "D":
    case "1D":
      return "1D";
    default:
      return "5Min";
  }
}

/** Bar duration in seconds for snapping live ticks to a candle. */
const TIMEFRAME_SECONDS: Record<ApiTimeframe, number> = {
  "1Min": 60,
  "5Min": 300,
  "15Min": 900,
  "1H": 3600,
  "1D": 86400,
};

/**
 * Brand mark palette. TradingView renders inside an iframe that cannot read
 * the app's CSS variables, so the direction (green-500/red-500) and gold
 * accent hexes are duplicated here as literal values; they must track any
 * brand-token change. Executions carry direction color, X signals carry the
 * gold accent (with a dark label, since white fails on gold), and Discord
 * keeps its recognizable indigo.
 */
const BUY_MARK_COLOR = {
  border: CHART_UP_BORDER,
  background: CHART_UP_COLOR,
} as const;
const SELL_MARK_COLOR = {
  border: CHART_DOWN_BORDER,
  background: CHART_DOWN_COLOR,
} as const;
const X_MARK_COLOR = { border: "#8a6a2a", background: "#d8b35a" } as const;
const DISCORD_MARK_COLOR = { border: "#3730a3", background: "#4f46e5" } as const;
const X_MARK_LABEL_COLOR = "#0c151e";
const DEFAULT_MARK_LABEL_COLOR = "#ffffff";

/** Shape of a historical bar coming back from quotes.getHistoricalBars. */
export interface ApiBar {
  time: number; // seconds since epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Shape of the snapshot quote we poll for live updates. */
export interface ApiSnapshot {
  last: string | number;
}

/** Trade-execution bubble shape from charts.getChartAnnotations. */
export interface ApiExecutionGroup {
  id: string;
  anchorTime: number; // seconds
  anchorPrice: number;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: string | null;
  tradeAction: string | null;
}

/** Signal bubble shape from signals.getForChart. */
export interface ApiSignal {
  id: string;
  anchorTime: number; // seconds
  content: string;
  authorName: string;
  authorAvatar?: string | null;
  source: string;
}

/**
 * Optional per-symbol overrides the wrapper can inject. Perps supply this so the
 * chart gets a 24x7 UTC session and a decimals-derived pricescale instead of the
 * NYSE equity defaults, without forking the datafeed. When omitted, the equity
 * defaults in `resolveSymbol` apply unchanged.
 */
export interface ResolvedSymbolInfoOverrides {
  session?: string;
  timezone?: LibrarySymbolInfo["timezone"];
  /** 10^priceDecimals, e.g. 2 decimals -> 100. */
  pricescale?: number;
  type?: string;
  minmov?: number;
}

/** Async fetchers the React wrapper passes in. */
export interface DatafeedDeps {
  fetchBars(args: {
    symbol: string;
    timeframe: ApiTimeframe;
    limit: number;
  }): Promise<ApiBar[]>;
  fetchSnapshot(args: { symbol: string }): Promise<ApiSnapshot | null>;
  fetchExecutionGroups(args: {
    symbol: string;
  }): Promise<ApiExecutionGroup[]>;
  fetchSignals(args: { symbol: string }): Promise<ApiSignal[]>;
  /**
   * Optional hook to override the resolved symbol info per symbol. Perps use it
   * to return `session: "24x7"`, `timezone: "Etc/UTC"`, and a decimals-derived
   * pricescale. Stocks omit it and keep the NYSE defaults.
   */
  resolveSymbolInfo?(symbol: string): ResolvedSymbolInfoOverrides | undefined;
}

const CONFIGURATION: DatafeedConfiguration = {
  supported_resolutions: ["1", "5", "15", "60", "1D"] as ResolutionString[],
  exchanges: [
    { value: "", name: "All Exchanges", desc: "" },
    { value: "NASDAQ", name: "NASDAQ", desc: "NASDAQ" },
    { value: "NYSE", name: "NYSE", desc: "New York Stock Exchange" },
  ],
  symbols_types: [
    { name: "All types", value: "" },
    { name: "Stock", value: "stock" },
  ],
  supports_marks: true,
  // We render signals as on-chart Marks instead of timescale marks (see
  // getMarks below), so leave this off - TV won't call getTimescaleMarks.
  supports_timescale_marks: false,
  supports_time: true,
};

/**
 * Build a fully-formed Datafeed object the TradingView widget can consume.
 *
 * Calling shape matches `IExternalDatafeed & IDatafeedChartApi` - the widget
 * accepts that union for the `datafeed` field.
 */
export function createTradingViewDatafeed(
  deps: DatafeedDeps
): IExternalDatafeed & IDatafeedChartApi {
  /** Per-subscription state for live bar updates. */
  type Sub = {
    symbol: string;
    timeframe: ApiTimeframe;
    onTick: SubscribeBarsCallback;
    interval: ReturnType<typeof setInterval> | null;
    lastBar: Bar | null;
  };
  const subs = new Map<string, Sub>();

  return {
    onReady(callback: OnReadyCallback) {
      // Spec requires this to be asynchronous.
      setTimeout(() => callback(CONFIGURATION), 0);
    },

    searchSymbols(
      userInput: string,
      _exchange: string,
      _symbolType: string,
      onResult: SearchSymbolsCallback
    ) {
      const symbol = userInput.trim().toUpperCase();
      if (!symbol) {
        onResult([]);
        return;
      }
      // Until we wire a real symbol search, echo the typed symbol back so the
      // user can still pick it from the dropdown.
      onResult([
        {
          symbol,
          description: symbol,
          exchange: "",
          ticker: symbol,
          type: "stock",
        },
      ]);
    },

    resolveSymbol(
      symbolName: string,
      onResolve: ResolveCallback,
      onError: DatafeedErrorCallback
    ) {
      const trimmed = symbolName.trim();
      if (!trimmed) {
        onError("Empty symbol");
        return;
      }
      // Perps inject overrides (24x7 UTC session, decimals-derived pricescale);
      // stocks return undefined and keep the NYSE equity defaults below.
      const overrides = deps.resolveSymbolInfo?.(trimmed);
      // HL coins are canonical case-sensitive spellings (kPEPE, xyz:GOOGL);
      // this resolved symbol feeds getBars/fetchSnapshot lookups, so only the
      // stock path may uppercase. Perps (overrides present) keep the casing.
      const symbol = overrides ? trimmed : trimmed.toUpperCase();
      const info: LibrarySymbolInfo = {
        name: symbol,
        ticker: symbol,
        description: symbol,
        type: overrides?.type ?? "stock",
        // US equities regular session in NYSE time. Pre/post sessions left off
        // since the Alpaca bars endpoint we use returns regular-hours data.
        session: overrides?.session ?? "0930-1600",
        timezone: overrides?.timezone ?? "America/New_York",
        exchange: "",
        listed_exchange: "",
        format: "price",
        pricescale: overrides?.pricescale ?? 100,
        minmov: overrides?.minmov ?? 1,
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: false,
        visible_plots_set: "ohlcv",
        supported_resolutions: [
          "1",
          "5",
          "15",
          "60",
          "1D",
        ] as ResolutionString[],
        volume_precision: 0,
        data_status: "streaming",
      };
      setTimeout(() => onResolve(info), 0);
    },

    async getBars(
      symbolInfo: LibrarySymbolInfo,
      resolution: ResolutionString,
      periodParams: PeriodParams,
      onResult: HistoryCallback,
      onError: DatafeedErrorCallback
    ) {
      // Critical: our backend (quotes.getHistoricalBars) only supports
      // "give me the last N bars" - it has no time-range / pagination
      // parameter. TV calls getBars repeatedly when the user scrolls left
      // through history (`firstDataRequest === false`); if we keep returning
      // the same most-recent bars, the chart sees no new data and asks
      // *again*, producing an infinite retry loop (>3 req/s on the bars
      // endpoint, observed in production).
      //
      // For any non-first call, declare end-of-data with `noData: true` so
      // TV stops asking. The cost is that users can't infinitely scroll
      // back - but they couldn't see meaningful data there anyway since the
      // API caps at 1000 bars per request.
      if (!periodParams.firstDataRequest) {
        onResult([], { noData: true });
        return;
      }

      const timeframe = resolutionToTimeframe(resolution);
      // `countBack` is the most reliable signal of how many bars TV needs to
      // paint the visible window. Cap at the API limit (1000).
      const limit = Math.min(Math.max(periodParams.countBack ?? 200, 1), 1000);

      try {
        const apiBars = await deps.fetchBars({
          symbol: symbolInfo.ticker ?? symbolInfo.name,
          timeframe,
          limit,
        });

        if (!apiBars || apiBars.length === 0) {
          onResult([], { noData: true });
          return;
        }

        // API returns time in seconds; TV expects ms.
        const bars: Bar[] = apiBars
          .map((b) => ({
            time: b.time * 1000,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }))
          .sort((a, b) => a.time - b.time);

        onResult(bars, { noData: false });
      } catch (err) {
        onError(err instanceof Error ? err.message : "Failed to load bars");
      }
    },

    subscribeBars(
      symbolInfo: LibrarySymbolInfo,
      resolution: ResolutionString,
      onTick: SubscribeBarsCallback,
      listenerGuid: string
    ) {
      const symbol = symbolInfo.ticker ?? symbolInfo.name;
      const timeframe = resolutionToTimeframe(resolution);
      const periodSec = TIMEFRAME_SECONDS[timeframe];

      const sub: Sub = {
        symbol,
        timeframe,
        onTick,
        interval: null,
        lastBar: null,
      };
      subs.set(listenerGuid, sub);

      const tick = async () => {
        try {
          const snap = await deps.fetchSnapshot({ symbol });
          if (!snap) return;
          const lastPrice =
            typeof snap.last === "number" ? snap.last : parseFloat(snap.last);
          if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;

          const nowSec = Math.floor(Date.now() / 1000);
          const periodStartSec =
            Math.floor(nowSec / periodSec) * periodSec;
          const periodStartMs = periodStartSec * 1000;

          if (!sub.lastBar || periodStartMs > sub.lastBar.time) {
            // New candle: open = high = low = close = last price.
            const newBar: Bar = {
              time: periodStartMs,
              open: lastPrice,
              high: lastPrice,
              low: lastPrice,
              close: lastPrice,
            };
            sub.lastBar = newBar;
            sub.onTick(newBar);
          } else {
            // Roll the in-progress candle.
            const base = sub.lastBar;
            const updated: Bar = {
              time: base.time,
              open: base.open,
              high: Math.max(base.high, lastPrice),
              low: Math.min(base.low, lastPrice),
              close: lastPrice,
            };
            sub.lastBar = updated;
            sub.onTick(updated);
          }
        } catch {
          // Swallow polling errors so a transient API blip doesn't kill the
          // subscription. TV will keep showing the last good bar.
        }
      };

      // Start polling. We deliberately do NOT kick once immediately - the
      // initial bars from getBars are already painted, so an extra burst
      // request on every symbol change just adds load to Alpaca and risks
      // hitting the snapshot rate limit. The first live-candle refresh
      // arrives after one interval (30 s). Coupled with the React Query
      // cache in advanced-chart.tsx, when the trade-form panel is mounted
      // for the same symbol we serve from cache and the chart adds zero
      // network requests.
      sub.interval = setInterval(tick, 30_000);
    },

    unsubscribeBars(listenerGuid: string) {
      const sub = subs.get(listenerGuid);
      if (sub?.interval) clearInterval(sub.interval);
      subs.delete(listenerGuid);
    },

    async getMarks(
      symbolInfo: LibrarySymbolInfo,
      from: number,
      to: number,
      onDataCallback: (marks: Mark[]) => void,
      resolution: ResolutionString
    ) {
      const symbol = symbolInfo.ticker ?? symbolInfo.name;
      const timeframe = resolutionToTimeframe(resolution);
      const periodSec = TIMEFRAME_SECONDS[timeframe];
      // Snap any event time to the start of its bar - TV requires Mark.time
      // to match a bar.time exactly, and auto-stacks multiple marks that
      // land on the same bar (up to ~10 per bar).
      const snap = (t: number) => Math.floor(t / periodSec) * periodSec;

      // Fan both fetches out in parallel and render execution + signal
      // bubbles in a single Mark[] response, so they appear together on
      // the candles instead of split between the chart body (executions)
      // and the timescale axis (signals).
      try {
        const [groups, signals] = await Promise.all([
          deps.fetchExecutionGroups({ symbol }),
          deps.fetchSignals({ symbol }),
        ]);

        // Normalize both event streams into a common BarEvent shape so we
        // can group them by snapped bar time and emit one Mark per bar.
        // TV's default "stack 10 marks vertically" behavior pushes the
        // stack so far above the bar that it overflows the chart area for
        // busy tickers (10+ X signals at the open, for example), so we
        // collapse to a single bubble with a count badge instead. The
        // tooltip text concatenates every event in the bar so users still
        // see all the activity on hover.
        type BarEvent = {
          id: string;
          time: number; // already snapped to bar boundary
          kind: "exec" | "signal";
          label: string; // single-event label (B/S, 𝕏, D)
          color: { border: string; background: string };
          // Label color paired with the bubble background (gold needs dark).
          labelFontColor: string;
          // ASCII text shown by TV in the tooltip on hover.
          text: string;
          // Optional avatar URL - when present and we're rendering a
          // single-event bubble we use it as the on-mark image.
          avatar?: string;
        };

        const events: BarEvent[] = [];

        for (const g of groups ?? []) {
          if (g.anchorTime < from || g.anchorTime > to) continue;
          const isBuy = g.side === "BUY";
          events.push({
            id: `exec:${g.id}`,
            time: snap(g.anchorTime),
            kind: "exec",
            label: isBuy ? "B" : "S",
            color: isBuy ? BUY_MARK_COLOR : SELL_MARK_COLOR,
            labelFontColor: DEFAULT_MARK_LABEL_COLOR,
            text: `${g.side} ${g.quantity} @ $${g.anchorPrice.toFixed(2)}${
              g.orderType ? ` (${g.orderType})` : ""
            }`,
          });
        }

        for (const s of signals ?? []) {
          if (s.anchorTime < from || s.anchorTime > to) continue;
          const isDiscord = s.source === "discord";
          events.push({
            id: `sig:${s.id}`,
            time: snap(s.anchorTime),
            kind: "signal",
            label: isDiscord ? "D" : "𝕏",
            color: isDiscord ? DISCORD_MARK_COLOR : X_MARK_COLOR,
            labelFontColor: isDiscord
              ? DEFAULT_MARK_LABEL_COLOR
              : X_MARK_LABEL_COLOR,
            // Normalize the author (rename Shardi variants, strip the
            // TweetShift relay label) and clean the body so the chart marker
            // tooltip matches the X Signals feed (doc #9).
            text: `${normalizeAuthorName(s.authorName)}: ${stripTweetShift(
              s.content,
            )}`,
            avatar: s.authorAvatar ?? undefined,
          });
        }

        // Group by snapped bar time.
        const byBar = new Map<number, BarEvent[]>();
        for (const ev of events) {
          const bucket = byBar.get(ev.time);
          if (bucket) bucket.push(ev);
          else byBar.set(ev.time, [ev]);
        }

        const marks: Mark[] = [];
        for (const [time, bucket] of byBar) {
          if (bucket.length === 1) {
            // Single event → use its natural styling. If it's a signal
            // with an avatar URL, the caller's face IS the mark: hide the
            // letter label behind the loaded image and render the bubble
            // larger so the avatar is recognizable at a glance.
            const ev = bucket[0]!;
            marks.push({
              id: ev.id,
              time,
              color: ev.color,
              text: ev.text,
              label: ev.label,
              labelFontColor: ev.labelFontColor,
              minSize: ev.avatar ? 24 : 18,
              imageUrl: ev.avatar,
              showLabelWhenImageLoaded: false,
            });
          } else {
            // Multi-event bar → one bubble with a numeric badge + a
            // newline-separated tooltip listing every event. Use the
            // color of the most "important" event (executions over
            // signals; sells over buys) so the bubble still conveys
            // urgency at a glance.
            const hasSell = bucket.some(
              (e) => e.kind === "exec" && e.label === "S"
            );
            const hasBuy = bucket.some(
              (e) => e.kind === "exec" && e.label === "B"
            );
            const hasDiscord = bucket.some(
              (e) => e.kind === "signal" && e.label === "D"
            );
            const groupColor: Mark["color"] = hasSell
              ? SELL_MARK_COLOR
              : hasBuy
              ? BUY_MARK_COLOR
              : hasDiscord
              ? DISCORD_MARK_COLOR
              : X_MARK_COLOR;
            // Gold is the only bubble background a white numeral fails on.
            const groupLabelColor =
              groupColor === X_MARK_COLOR
                ? X_MARK_LABEL_COLOR
                : DEFAULT_MARK_LABEL_COLOR;
            // Put a face on the busy bar too: the first avatared signal
            // fronts the bubble while the count label stays visible.
            const groupAvatar = bucket.find((e) => e.avatar)?.avatar;

            // Sort by id so the order in the tooltip is stable across
            // refreshes (the underlying APIs already sort by time, but
            // events within the same bar can interleave).
            const lines = bucket
              .slice()
              .sort((a, b) => (a.id < b.id ? -1 : 1))
              .map((e, i) => `${i + 1}. ${e.text}`);

            marks.push({
              // Stable group id so React Query / TV cache invalidation
              // matches across refreshes that return the same events.
              id: `group:${time}:${bucket.length}`,
              time,
              color: groupColor,
              text: `${bucket.length} events at this bar:\n${lines.join("\n")}`,
              label: String(bucket.length),
              labelFontColor: groupLabelColor,
              minSize: 20,
              imageUrl: groupAvatar,
              showLabelWhenImageLoaded: true,
            });
          }
        }

        onDataCallback(marks);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[tv-datafeed] getMarks failed", err);
        onDataCallback([]);
      }
    },

    // getTimescaleMarks intentionally omitted: signals now render as
    // on-chart Marks (above the candles) instead of timescale marks (below
    // the axis), so users see all activity in one place and TV auto-stacks
    // clustered events. supports_timescale_marks is flipped to false in
    // CONFIGURATION so TV doesn't call it.

    getServerTime(callback: (serverTime: number) => void) {
      callback(Math.floor(Date.now() / 1000));
    },
  };
}
