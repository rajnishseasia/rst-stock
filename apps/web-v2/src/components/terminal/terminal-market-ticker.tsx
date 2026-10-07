"use client";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useVenue } from "@/lib/venue-context";
import { formatChangePct, formatPriceUsd, toFiniteNumber } from "@/lib/format";
import { formatPerpChangePct, formatPerpUsd } from "@/components/perps/perp-format";
import { getQuoteFreshness, type QuoteFreshnessTone } from "@/lib/quote-freshness";
import { ChangeBadge } from "@/components/ui/change-badge";
import { LiveDataValue } from "@/components/ui/live-data-value";

type TerminalMarketTickerProps = {
  activeSymbol: string;
  activePerpSymbol: string;
  /**
   * Selecting a ticker loads it into the chart/trade form, the same as picking
   * a symbol anywhere else in the terminal. When omitted, the tape renders as
   * static (non-interactive) text.
   */
  onSelectSymbol?: (symbol: string, venue: "stocks" | "perps") => void;
};

export const TICKER_DEFAULT_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA"];
type TickerItem = { symbol: string; venue: "stocks" | "perps" };

// getChartQuotes caps its input at 30 symbols; keep the tape within that so a
// long watchlist degrades gracefully instead of failing the whole quote query.
const TICKER_SYMBOL_CAP = 30;

// getChartQuotes caps each STOCK symbol at 10 chars, while the watchlist
// accepts up to 15. One over-long entry would fail zod for the whole batch and
// blank every cell in the tape, re-erroring on each 30s refetch, so those
// symbols are dropped rather than poisoning the request. STOCKS ONLY: perp
// symbols never enter that request, and Hyperliquid names run long
// ("xyz:brentoil" is 12 chars, the watchlist schema allows 32). Capping perps
// at 10 dropped real markets from the tape, and a watchlist of only long perp
// names filtered to empty and fell back to the default stock indices.
const TICKER_STOCK_SYMBOL_MAX_LENGTH = 10;
// Mirrors the perp watchlist schema's bound (apps/api/src/routers/watchlist.ts).
const TICKER_PERP_SYMBOL_MAX_LENGTH = 32;

function fitsTickerLength(item: TickerItem): boolean {
  const cap =
    item.venue === "perps"
      ? TICKER_PERP_SYMBOL_MAX_LENGTH
      : TICKER_STOCK_SYMBOL_MAX_LENGTH;
  return item.symbol.length <= cap;
}

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

/**
 * The spelling an item carries through the tape. Stocks normalize to
 * uppercase; perp coins keep Hyperliquid's canonical case-sensitive spelling
 * ("kPEPE", "xyz:GOOGL"). Uppercasing perps broke every canonical-keyed
 * consumer at once: the allMids price lookup, the marketStats 24h-change
 * lookup, and the click handler, which navigated to a coin HL does not know.
 * Identity (dedupe, active-cell match) stays case-insensitive via
 * normalizeSymbol; the canonical spelling is what gets displayed, looked up,
 * and sent onward.
 */
function canonicalizeSymbol(symbol: string, venue: "stocks" | "perps") {
  return venue === "perps" ? symbol.trim() : normalizeSymbol(symbol);
}

/** Quote payloads carry prices as decimal strings; LiveDataValue compares numbers. */
/**
 * The tape's freshness tones compress to one-word labels: the strip is 10px
 * tall, and getQuoteFreshness's sentence labels ("Refreshing - last 5s ago")
 * would dominate it. The dot is never color-only; this label always renders.
 */
const CONNECTION_LABELS: Record<QuoteFreshnessTone, string> = {
  live: "Live",
  refreshing: "Updating",
  stale: "Stale",
  error: "Offline",
  idle: "Updating",
};

const CONNECTION_DOT_CLASSES: Record<QuoteFreshnessTone, string> = {
  live: "bg-green-500",
  refreshing: "bg-blue-400",
  stale: "bg-amber-400",
  error: "bg-red-500",
  idle: "bg-muted-foreground",
};

/**
 * Builds the ordered, de-duped ticker item list. The active market always
 * leads so the chart's current market is visible and highlighted; the tape
 * then reflects the user's watchlist, falling back to the major-index
 * defaults when the watchlist is empty. (The stock-only buildTickerSymbols
 * predecessor was deleted once this venue-aware version replaced it.)
 */
export function buildTickerItems({
  activeStockSymbol,
  activePerpSymbol,
  activeVenue,
  watchlistItems,
}: {
  /** RAW active symbols per venue, exactly as the shell holds them. The
   * builder selects and canonicalizes internally: the first version accepted
   * one pre-normalized `activeSymbol`, and the caller fed it the uppercased
   * value, silently re-breaking the canonical perp spelling this file just
   * fixed AND winning dedupe over the correctly cased watchlist copy. Taking
   * both raw values removes the caller's opportunity to pre-normalize. */
  activeStockSymbol: string;
  activePerpSymbol: string;
  activeVenue: "stocks" | "perps";
  watchlistItems?: readonly TickerItem[] | null;
}): TickerItem[] {
  const activeSymbol =
    activeVenue === "perps" ? activePerpSymbol : activeStockSymbol;
  const normalizedWatchlist = (watchlistItems ?? [])
    .map((item) => ({ ...item, symbol: canonicalizeSymbol(item.symbol, item.venue) }))
    .filter((item) => !!item.symbol && fitsTickerLength(item));
  const base =
    normalizedWatchlist.length > 0
      ? normalizedWatchlist
      : TICKER_DEFAULT_SYMBOLS.map((symbol) => ({ symbol, venue: "stocks" as const }));
  const ordered = [
    { symbol: canonicalizeSymbol(activeSymbol, activeVenue), venue: activeVenue },
    ...base,
  ];
  const seen = new Set<string>();
  return ordered
    .filter((item) => {
      if (!item.symbol || !fitsTickerLength(item)) return false;
      const key = `${item.venue}:${normalizeSymbol(item.symbol)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, TICKER_SYMBOL_CAP);
}

export function TerminalMarketTicker({
  activeSymbol,
  activePerpSymbol,
  onSelectSymbol,
}: TerminalMarketTickerProps) {
  const { venue: activeVenue } = useVenue();
  const normalizedActiveSymbol = normalizeSymbol(
    activeVenue === "perps" ? activePerpSymbol : activeSymbol,
  );

  // The watchlist drives the tape; on error/empty we fall back to the defaults
  // inside buildTickerItems. retry:false keeps an unauthed/failed query quiet.
  const watchlistQuery = trpc.watchlist.list.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    retry: false,
  });
  const items = buildTickerItems({
    activeStockSymbol: activeSymbol,
    activePerpSymbol,
    activeVenue,
    watchlistItems: watchlistQuery.data,
  });
  const stockSymbols = items
    .filter((item) => item.venue === "stocks")
    .map((item) => item.symbol);
  const hasPerps = items.some((item) => item.venue === "perps");

  const quotesQuery = trpc.quotes.getChartQuotes.useQuery(
    { symbols: stockSymbols },
    {
      enabled: stockSymbols.length > 0,
      refetchInterval: 30_000,
      staleTime: 15_000,
      retry: false,
    },
  );
  const quotesBySymbol = new Map((quotesQuery.data ?? []).map((quote) => [quote.symbol, quote]));
  const perpMidsQuery = trpc.hyperliquid.allMids.useQuery(undefined, {
    enabled: hasPerps,
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
  });
  const perpMids = perpMidsQuery.data as Record<string, string> | undefined;
  // 24h change needs previous-day prices, which allMids lacks. marketStats is
  // already cached by the perps rail with the same options, so this usually
  // dedupes into that subscription instead of adding a request.
  const perpStatsQuery = trpc.hyperliquid.marketStats.useQuery(undefined, {
    enabled: hasPerps,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const perpStatsByCoin = new Map(
    (perpStatsQuery.data ?? []).map((asset) => [asset.coin, asset]),
  );

  // One freshness readout for the whole tape, derived from the real fetch
  // state of every quote query the tape has enabled; never a faked pulse.
  const quoteQueries = [
    { enabled: stockSymbols.length > 0, query: quotesQuery },
    { enabled: hasPerps, query: perpMidsQuery },
    { enabled: hasPerps, query: perpStatsQuery },
  ].filter((entry) => entry.enabled);
  const newestUpdatedAt = quoteQueries.reduce(
    (newest, entry) => Math.max(newest, entry.query.dataUpdatedAt ?? 0),
    0,
  );
  const freshness = getQuoteFreshness({
    updatedAt: newestUpdatedAt > 0 ? newestUpdatedAt : undefined,
    isFetching: quoteQueries.some((entry) => entry.query.isFetching),
    hasError: quoteQueries.some((entry) => entry.query.isError),
    enabled: quoteQueries.length > 0,
  });

  return (
    <footer
      aria-label="Market ticker"
      className="no-scrollbar flex min-h-7 shrink-0 items-center gap-1 overflow-x-auto border-t bg-background px-2 pb-[env(safe-area-inset-bottom)] text-xs"
    >
      {items.map(({ symbol, venue }, index) => {
        const quote = venue === "stocks" ? quotesBySymbol.get(symbol) : undefined;
        const perpMid = venue === "perps" ? perpMids?.[symbol] : undefined;
        const perpStats = venue === "perps" ? perpStatsByCoin.get(symbol) : undefined;
        const change =
          venue === "perps"
            ? formatPerpChangePct(perpStats?.markPx, perpStats?.prevDayPx)
            : formatChangePct(quote?.changePercent);
        const isActive =
          normalizeSymbol(symbol) === normalizedActiveSymbol && venue === activeVenue;

        const cellClass = cn(
          "flex h-full shrink-0 items-center gap-1.5 border-r px-2 font-data tabular-nums",
          isActive && "text-primary",
        );

        const cellContent = (
          <>
            <span className="font-semibold">{symbol}</span>
            {/* Perp mids span sub-cent coins, so they take the adaptive perps
                formatter instead of the fixed-precision stock one. */}
            <LiveDataValue
              value={toFiniteNumber(venue === "perps" ? perpMid : quote?.last)}
              format={venue === "perps" ? formatPerpUsd : formatPriceUsd}
              fallback="-"
            />
            <ChangeBadge text={change.text} tone={change.tone} />
          </>
        );

        if (!onSelectSymbol) {
          return (
            <div key={`${venue}-${symbol}-${index}`} className={cellClass}>
              {cellContent}
            </div>
          );
        }

        return (
          <button
            key={`${venue}-${symbol}-${index}`}
            type="button"
            onClick={() => onSelectSymbol(symbol, venue)}
            aria-label={`Load ${symbol} into the chart`}
            title={`Load ${symbol} into the chart`}
            className={cn(
              cellClass,
              "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive && "hover:text-primary",
            )}
          >
            {cellContent}
          </button>
        );
      })}
      <div
        role="status"
        aria-label={freshness.label}
        title={freshness.label}
        className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 pr-1"
      >
        <span aria-hidden="true" className="relative flex size-1.5">
          {freshness.tone === "live" && (
            <span className="pulse-ring absolute inset-0 rounded-full bg-green-500" />
          )}
          <span
            className={cn(
              "relative inline-flex size-1.5 rounded-full",
              CONNECTION_DOT_CLASSES[freshness.tone],
            )}
          />
        </span>
        <span className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {CONNECTION_LABELS[freshness.tone]}
        </span>
      </div>
    </footer>
  );
}
