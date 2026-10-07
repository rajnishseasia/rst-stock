"use client";

/**
 * The mobile Search screen's BROWSE surface (plan A5 + A6).
 *
 * Not a dropdown. The desktop keeps its floating `MarketSuggestionsList`; this
 * is a static, full-height, scrolling surface that owns the whole screen below
 * the input, so:
 *
 *  - results are GROUPED for our product (Stocks, then Perps), not rendered as
 *    one undifferentiated list,
 *  - every row carries a live price, so search doubles as market discovery,
 *  - an empty query is not an empty screen: it shows venue-tagged Recents and
 *    the Market Pulse rankings,
 *  - a dual-listed symbol is two full-width rows, not one row with an ~18px
 *    venue chip that only a mouse can reach.
 *
 * Deliberately separate from `terminal-market-search.tsx`: `MarketSuggestionsList`
 * is shared with the desktop chart-bar search, and every size change made there
 * inflates the desktop dropdown.
 *
 * Prices only. Nothing in this file constructs, validates or submits an order.
 */

import { useEffect, useMemo, useState } from "react";
import { CandlestickChart, Coins } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { PERPS_ENABLED } from "@/lib/perps-config";
import { formatSignedNumber } from "@/lib/format";
import { ChangeBadge } from "@/components/ui/change-badge";
import {
  wrongVenueNotice,
  type MarketSearchFilter,
  type MarketSearchItem,
  type MarketSelection,
  type MarketVenue,
  type VenueAvailability,
} from "@/lib/market-selection";
import {
  browserRecentMarketsStore,
  readRecentMarkets,
} from "@/lib/recent-markets";
import {
  browseQuoteSymbols,
  browseQueryNeeds,
  groupMarketSuggestions,
  type MarketBrowseRow,
} from "@/components/terminal/market-browse";
// One composer for the row metric line, shared with the desktop HL Markets
// list (via perp-market-row.ts) so Vol / OI / Fund cannot mean two things.
import {
  perpLeverageMetric,
  perpRowMetrics,
  stockRowMetrics,
  type MarketRowMetric,
} from "@/components/terminal/market-row-metrics";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";
import {
  formatPerpChangePct,
  formatPerpUsd,
} from "@/components/perps/perp-format";
// The feed already owns the "a batch quote of 0.00 is a failed lookup, not a
// price" rule and routes through the sanctioned shared formatters. Reusing it
// here keeps one implementation rather than adding a fourth money formatter.
import {
  formatSignalChipChange,
  formatSignalChipPrice,
  signalChangeTone,
} from "@/components/feed/signal-quote-format";
import type { MarketTile } from "@/components/market-pulse/market-pulse-types";
// The rankings block owns its own loading, empty and error states, so this
// surface never renders a "Market pulse" heading over nothing.
import { BrowseSection, MobileMarketPulse } from "./mobile-market-pulse";
// Plan S3. The People tab: search the callers, not just the markets.
import { MobilePeopleBrowse } from "./mobile-people-browse";

const VENUE_LABEL: Record<MarketVenue, string> = {
  stocks: "Stock",
  perps: "Perp",
};

export type MarketVenueAccent = "teal" | "gold";

export interface MarketVenuePresentation {
  label: string;
  groupLabel: string;
  accent: MarketVenueAccent;
}

/**
 * Compact copy for venue-qualified market rows. The venue is part of the
 * instrument identity on mobile, not decorative metadata: SOL can be a stock
 * or a perp, and the two rows need to scan differently at a glance.
 *
 * There is deliberately no long asset-type word here any more. Rows used to
 * print "Perpetual" beside a PERP badge and "Equity" beside a STOCK badge,
 * spending the row's only free line restating the chip next to it. That line
 * now carries volume, open interest and funding instead.
 */
export function marketVenuePresentation(
  venue: MarketVenue,
): MarketVenuePresentation {
  return venue === "stocks"
    ? {
        label: VENUE_LABEL.stocks,
        groupLabel: "Stocks",
        accent: "teal",
      }
    : {
        label: VENUE_LABEL.perps,
        groupLabel: "Perps",
        accent: "gold",
      };
}

/**
 * The accessible name for one live browse result. Stock search results can
 * share a ticker with a perp, so keep the venue in every name and include the
 * issuer when the search returned one. Perp symbols intentionally use the
 * canonical display spelling (including namespaced HIP-3 coins).
 */
export function marketBrowseRowAriaLabel(
  row: Pick<MarketBrowseRow, "symbol" | "venue" | "name">,
): string {
  const display =
    row.venue === "perps" ? perpDisplayCoin(row.symbol) : row.symbol;
  const venue = VENUE_LABEL[row.venue].toLowerCase();
  const name = row.venue === "stocks" ? row.name.trim() : "";
  return name ? `${display} ${venue}, ${name}` : `${display} ${venue}`;
}

/**
 * Plan S3. The Search screen's tabs. `MobileBrowseTab` deliberately EXTENDS
 * `MarketSearchFilter` rather than replacing it: "all" / "stocks" / "perps" are
 * still market scopes and still feed `useMarketSearch`, while "people" selects a
 * different surface entirely.
 *
 * The type stays local to the mobile browse screen. `MarketSearchFilter` is the
 * shared venue-context type, and widening it would put "people" in front of the
 * venue switcher, the desktop dropdown and `resolveEnterSelection`, none of
 * which have anything to say about a person.
 */
export type MobileBrowseTab = MarketSearchFilter | "people";

const FILTER_TABS: ReadonlyArray<{ value: MobileBrowseTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "stocks", label: "Stocks" },
  { value: "perps", label: "Perps" },
  { value: "people", label: "People" },
];

/**
 * The market scope a tab implies.
 *
 * "people" has no market scope of its own, so it reports the open one. That is
 * only the scope the search would USE if it ran; on People the search is turned
 * off outright (`searchDisabled`), because mapping the tab onto a live scope
 * meant every debounced keystroke of a caller name ran `markets.search` for
 * results nothing rendered.
 */
export function marketSearchScope(tab: MobileBrowseTab): MarketSearchFilter {
  return tab === "people" ? "all" : tab;
}

/** Whether this tab renders the caller directory rather than markets. */
export function isPeopleBrowseTab(tab: MobileBrowseTab): boolean {
  return tab === "people";
}

export interface MobileBrowseStatusInput {
  isSignedIn: boolean;
  isUpdating: boolean;
  hasDataError: boolean;
}

export interface MobileBrowseStatus {
  label: string;
  dotClassName: string;
}

export function mobileBrowseStatus(
  tab: MobileBrowseTab,
  { isSignedIn, isUpdating, hasDataError }: MobileBrowseStatusInput,
): MobileBrowseStatus | null {
  if (tab === "people") {
    return null;
  }

  const label = !isSignedIn
    ? "Sign in for live quotes"
    : isUpdating
      ? "Updating quotes"
      : hasDataError
        ? "Data delayed"
        : "Quotes ready";
  const dotClassName = !isSignedIn
    ? "bg-[#657f89]"
    : isUpdating
      ? "bg-[#e7c65d]"
      : hasDataError
        ? "bg-[#e27c6a]"
        : "bg-[#65c7b6]";
  return { label, dotClassName };
}

/**
 * The tabs to render for a deployment. Perps drop out when the venue is not
 * configured; People never does, because callers are not a venue.
 */
export function visibleBrowseTabs(
  perpsEnabled: boolean,
): ReadonlyArray<{ value: MobileBrowseTab; label: string }> {
  return perpsEnabled
    ? FILTER_TABS
    : FILTER_TABS.filter((tab) => tab.value !== "perps");
}

type BrowseTone = "positive" | "negative" | "neutral";

function VenueTag({ venue }: { venue: MarketVenue }) {
  const presentation = marketVenuePresentation(venue);
  const Icon = venue === "stocks" ? CandlestickChart : Coins;
  return (
    <span
      data-market-venue={venue}
      // No `title`. The badge's own text is the whole message, and a tooltip
      // that repeats it is unreachable on the touch surface this row is for.
      className={cn(
        "inline-flex min-h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-3xs font-semibold uppercase tracking-[0.12em]",
        venue === "stocks"
          ? "border-[#1b5454] bg-[#0a2a2d] text-[#8fd2c3]"
          : "border-[#5d4b21] bg-[#292616] text-[#e7c65d]",
      )}
    >
      <Icon className="size-3" strokeWidth={1.9} aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

interface BrowseRowProps {
  /** Primary line: the ticker as the user should read it. */
  display: string;
  venue: MarketVenue;
  /**
   * Secondary line, leading text: the company name for a stock. Perps have no
   * issuer name, so theirs is metrics only.
   */
  detail?: string;
  /**
   * Secondary line, trailing numbers: Vol for a stock, Vol / OI / Fund / Max
   * for a perp. Shares the existing second line rather than adding a third,
   * so the row carries more data at the same height.
   */
  metrics?: readonly MarketRowMetric[];
  price: string | null;
  change: string | null;
  tone: BrowseTone;
  ariaLabel: string;
  onSelect: () => void;
  /**
   * When provided, a "Trade" button is rendered at the right edge of the row.
   * Tapping it opens the trade sheet for this market directly, bypassing the
   * chart screen.
   */
  onTrade?: () => void;
}

/**
 * One browse row. A single full-width `<button>`, minimum 56px tall (A6): the
 * dropdown's `px-2 py-1.5 text-xs` row lands near 30px for a perp, which has no
 * company name to give it a second line.
 *
 * Plain `onClick`, deliberately. The dropdown commits on `onMouseDown` because
 * its list is dismissed by the input's blur; a static browse list has no blur to
 * race, so the ordinary click path works for touch, mouse, keyboard and
 * assistive tech alike.
 */
function BrowseRow({
  display,
  venue,
  detail,
  metrics = [],
  price,
  change,
  tone,
  ariaLabel,
  onSelect,
  onTrade,
}: BrowseRowProps) {
  const presentation = marketVenuePresentation(venue);
  const accent =
    venue === "stocks"
      ? {
          rail: "bg-[#65c7b6]",
          border: "hover:border-[#21605f] focus-visible:border-[#65c7b6]",
          hover: "hover:bg-[#0b2b31] active:bg-[#0e3539]",
        }
      : {
          rail: "bg-[#e7c65d]",
          border: "hover:border-[#685629] focus-visible:border-[#e7c65d]",
          hover: "hover:bg-[#252415] active:bg-[#322a17]",
        };
  const rowClassName = cn(
    "group relative flex min-h-14 w-full items-center justify-between gap-3 px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform] duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#071a23] active:scale-[0.995]",
    accent.border,
    accent.hover,
  );
  const rowContent = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-3 left-1 w-px rounded-full opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
          accent.rail,
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-data text-sm font-semibold tracking-tight text-[#e3ecef]">
            {display}
          </span>
          <VenueTag venue={venue} />
        </span>
        {(detail || metrics.length > 0) && (
          // One 16px line, the same height the lone detail string used to
          // occupy. The name truncates first (min-w-0 + truncate) and the
          // numbers hold their width, so a long issuer name never pushes a
          // metric off the row.
          <span
            data-market-row-metrics="true"
            className="flex min-w-0 items-baseline gap-2 overflow-hidden text-3xs leading-4 text-[#718b95]"
          >
            {detail && (
              <span className="min-w-0 truncate text-2xs">{detail}</span>
            )}
            {metrics.map((metric) => (
              <span
                key={metric.key}
                data-market-row-metric={metric.key}
                className="shrink-0 tabular-nums"
              >
                <span className="text-[#5c757e]">{metric.label}</span>{" "}
                <span className="text-[#9ab2ba]">{metric.value}</span>
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-data text-sm font-semibold tabular-nums text-[#dce7ea]">
          {price ?? "—"}
        </span>
        {change && (
          <ChangeBadge
            className="font-data"
            size="sm"
            text={change}
            tone={tone}
          />
        )}
      </span>
    </>
  );

  if (onTrade) {
    return (
      <li className="flex min-h-14 items-stretch">
        <button
          type="button"
          onClick={onSelect}
          aria-label={ariaLabel}
          className={cn(rowClassName, "border-0")}
        >
          {rowContent}
        </button>
        <button
          type="button"
          onClick={onTrade}
          aria-label={`Trade ${display} ${presentation.label.toLowerCase()}`}
          className="flex min-h-11 min-w-[4.5rem] shrink-0 items-center justify-center border-l border-[#1d3943] bg-[#0a2029] px-3 text-2xs font-semibold uppercase tracking-[0.12em] text-[#e7c65d] transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-[#685629] hover:bg-[#292616] active:scale-[0.98] active:bg-[#3a3019] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-inset"
        >
          Trade
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-label={ariaLabel}
        className={rowClassName}
      >
        {rowContent}
      </button>
    </li>
  );
}

/**
 * A labeled group of rows. The wrong-venue note lives HERE, once per group,
 * rather than on every row: the dropdown could get away with showing it on the
 * highlighted row only, but a browse list has no highlight, and repeating
 * "Stock trading needs a connected Alpaca account" under fifteen rows would bury
 * the prices the surface exists to show.
 */
export interface MobileMarketBrowseProps {
  /** Raw search input text. Trimmed here; empty means "show the browse state". */
  query: string;
  filter: MobileBrowseTab;
  onFilterChange: (filter: MobileBrowseTab) => void;
  suggestions: readonly MarketSearchItem[];
  isSearching: boolean;
  /** The market search failed, as opposed to returning nothing. */
  searchFailed?: boolean;
  availability: VenueAvailability;
  isSignedIn: boolean;
  /**
   * Commit a market pick. Wired to the same venue-aware `selectMarket` path the
   * dropdown and Enter use, so a row cannot route differently from a chip.
   */
  onSelect: (selection: MarketSelection) => void;
  /**
   * Optional direct-to-trade handler. When provided, every browse row grows a
   * "Trade" button that opens the trade sheet immediately, without navigating
   * to the chart screen first.
   */
  onTrade?: (selection: MarketSelection) => void;
}

export function MobileMarketBrowse({
  query,
  filter,
  onFilterChange,
  suggestions,
  isSearching,
  searchFailed = false,
  availability,
  isSignedIn,
  onSelect,
  onTrade,
}: MobileMarketBrowseProps) {
  const hasQuery = query.trim().length > 0;
  const showPeople = isPeopleBrowseTab(filter);
  const visibleTabs = visibleBrowseTabs(PERPS_ENABLED);
  const showStocks = !showPeople && (filter === "all" || filter === "stocks");
  const showPerps =
    !showPeople && PERPS_ENABLED && (filter === "all" || filter === "perps");

  // Recents are read once per mount. Committing a pick navigates to the chart,
  // which unmounts this surface, so the next open re-reads the fresh list.
  const [recentMarkets, setRecentMarkets] = useState<MarketSelection[]>([]);
  useEffect(() => {
    setRecentMarkets(
      readRecentMarkets(browserRecentMarketsStore(), PERPS_ENABLED),
    );
  }, []);

  const groups = useMemo(
    () => groupMarketSuggestions(suggestions, PERPS_ENABLED),
    [suggestions],
  );

  const recentRows = useMemo<MarketBrowseRow[]>(
    () =>
      recentMarkets
        .filter((market) => (market.venue === "stocks" ? showStocks : showPerps))
        .map((market) => ({
          key: `recent:${market.venue}:${market.symbol}`,
          symbol: market.symbol,
          venue: market.venue,
          name: "",
        })),
    [recentMarkets, showStocks, showPerps],
  );

  const resultRows = useMemo<MarketBrowseRow[]>(
    () => [
      ...(showStocks ? groups.stocks : []),
      ...(showPerps ? groups.perps : []),
    ],
    [groups, showStocks, showPerps],
  );

  // One capped batch for every equity row on screen (results + recents). Runs on
  // master Alpaca credentials server-side, so prices render for a perps-only
  // user with no broker connected.
  const quoteSymbols = useMemo(
    () =>
      browseQuoteSymbols(hasQuery ? resultRows : [...recentRows, ...resultRows]),
    [hasQuery, resultRows, recentRows],
  );
  const quotesQuery = trpc.quotes.getChartQuotes.useQuery(
    { symbols: quoteSymbols },
    {
      enabled: isSignedIn && quoteSymbols.length > 0,
      refetchInterval: 30_000,
      staleTime: 15_000,
      retry: false,
      // The symbol list is part of the query key and changes on every keystroke,
      // so without this every row blanks between batches.
      placeholderData: (previous) => previous,
    },
  );
  const quotesBySymbol = useMemo(
    () => new Map((quotesQuery.data ?? []).map((quote) => [quote.symbol, quote])),
    [quotesQuery.data],
  );

  // What this tab actually needs on screen. Both gates live in one tested place
  // because the component stays mounted across tab changes, so a query left
  // enabled polls for a surface nobody is looking at.
  const queryNeeds = browseQueryNeeds({
    isSignedIn,
    perpsCompiledIn: PERPS_ENABLED,
    showPeople,
    showsPerpRows: showPerps,
    hasQuery,
  });

  // Argument-free and already fetched by the feed and the watchlist, so React
  // Query serves this from the shared cache rather than issuing a new request.
  const perpStatsQuery = trpc.hyperliquid.marketStats.useQuery(undefined, {
    enabled: queryNeeds.perpStats,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const perpStatsByCoin = useMemo(
    () =>
      new Map(
        (perpStatsQuery.data ?? []).map((asset) => [
          asset.coin.trim().toUpperCase(),
          asset,
        ]),
      ),
    [perpStatsQuery.data],
  );

  const pulseQuery = trpc.marketPulse.overview.useQuery(undefined, {
    enabled: queryNeeds.marketPulse,
    staleTime: 60_000,
    refetchInterval: false,
    retry: 1,
  });

  const renderRow = (row: MarketBrowseRow, keyPrefix: string) => {
    if (row.venue === "perps") {
      const stat = perpStatsByCoin.get(row.symbol.trim().toUpperCase());
      const change = formatPerpChangePct(stat?.markPx, stat?.prevDayPx);
      const display = perpDisplayCoin(row.symbol);
      return (
        <BrowseRow
          key={`${keyPrefix}:${row.key}`}
          display={display}
          venue="perps"
          // Vol / OI / Fund from the same composer the desktop HL Markets
          // list uses, so the two never disagree, plus the venue's max
          // leverage. This replaces the word "Perpetual", which restated the
          // PERP badge sitting immediately above it.
          //
          // Leverage is dropped on any surface that also renders the Trade
          // button. That button takes about 72px, leaving roughly 170px for
          // the symbol column and 230px of metrics in a line that clips rather
          // than scrolls, so the fourth metric would be cut mid-glyph. Vol, OI
          // and funding change per market and per tick; max leverage is static
          // per venue, so it is the one to lose when the row runs out of room.
          metrics={[
            ...perpRowMetrics(stat),
            ...(onTrade ? [] : perpLeverageMetric(stat?.maxLeverage)),
          ]}
          price={stat ? formatPerpUsd(stat.markPx) : null}
          change={change.text === "-" ? null : change.text}
          tone={change.tone}
          // Tickers collide across venues (SOL is Solana on Hyperliquid and
          // ReneSola on Nasdaq), so the venue belongs in the accessible name.
          ariaLabel={marketBrowseRowAriaLabel(row)}
          onSelect={() => onSelect({ symbol: row.symbol, venue: "perps" })}
          onTrade={onTrade ? () => onTrade({ symbol: row.symbol, venue: "perps" }) : undefined}
        />
      );
    }

    const quote = quotesBySymbol.get(row.symbol.trim().toUpperCase());
    const price = formatSignalChipPrice(quote?.last);
    const change = price ? formatSignalChipChange(quote?.changePercent) : "";
    return (
      <BrowseRow
        key={`${keyPrefix}:${row.key}`}
        display={row.symbol}
        venue="stocks"
        // The issuer name when the search returned one. It used to fall back
        // to the word "Equity", which said nothing the STOCK badge beside it
        // had not already said; a nameless row now just shows its volume.
        detail={row.name || undefined}
        metrics={stockRowMetrics(quote?.volume)}
        price={price}
        change={change || null}
        tone={signalChangeTone(quote?.change)}
        ariaLabel={marketBrowseRowAriaLabel(row)}
        onSelect={() => onSelect({ symbol: row.symbol, venue: "stocks" })}
        onTrade={onTrade ? () => onTrade({ symbol: row.symbol, venue: "stocks" }) : undefined}
      />
    );
  };

  const renderTile = (tile: MarketTile) => {
    const display =
      tile.venue === "perps" ? perpDisplayCoin(tile.symbol) : tile.symbol;
    const tone: BrowseTone =
      tile.changePercent > 0
        ? "positive"
        : tile.changePercent < 0
          ? "negative"
          : "neutral";
    // A ranking tile carries a venue volume but no open interest or funding.
    // Perp tiles therefore prefer the live `marketStats` row (already fetched
    // for the perp lists on this screen) and fall back to the tile's own
    // notional volume. Stock tile volume is a share count, not dollars.
    const metrics =
      tile.venue === "perps"
        ? perpRowMetrics(
            perpStatsByCoin.get(tile.symbol.trim().toUpperCase()),
            tile.volume,
          )
        : stockRowMetrics(tile.volume);
    return (
      <BrowseRow
        key={tile.id}
        display={display}
        venue={tile.venue}
        metrics={metrics}
        price={
          tile.venue === "perps"
            ? formatPerpUsd(tile.price)
            : formatSignalChipPrice(tile.price)
        }
        change={formatSignedNumber(tile.changePercent, "%")}
        tone={tone}
        ariaLabel={marketBrowseRowAriaLabel({
          symbol: tile.symbol,
          venue: tile.venue,
          name: "",
        })}
        onSelect={() => onSelect({ symbol: tile.symbol, venue: tile.venue })}
        onTrade={onTrade ? () => onTrade({ symbol: tile.symbol, venue: tile.venue }) : undefined}
      />
    );
  };

  const isUpdating =
    isSearching ||
    quotesQuery.isFetching ||
    perpStatsQuery.isFetching ||
    pulseQuery.isFetching;
  const hasDataError =
    searchFailed ||
    quotesQuery.isError ||
    perpStatsQuery.isError ||
    pulseQuery.isError;
  const browseStatus = mobileBrowseStatus(filter, {
    isSignedIn,
    isUpdating,
    hasDataError,
  });
  // Only a search has a subheading worth a line: the result count. The browse
  // state used to caption itself ("Live instruments, ranked by venue") above
  // the filters, a label row that restated the tabs and pushed the first
  // price a further 34px down the phone.
  const searchSubheading = hasQuery
    ? isSearching
      ? "Scanning tradable instruments"
      : `${resultRows.length} matching ${resultRows.length === 1 ? "instrument" : "instruments"}`
    : null;

  return (
    <div
      data-market-browse-surface="true"
      // A growing flex column (min-height auto): the rankings block below can
      // fill the Markets screen's free space and center its empty state.
      className="flex min-w-0 flex-1 flex-col gap-2 text-[#dfe8eb]"
    >
      {
        // Local to this screen on purpose. The venue bar's filter also flips the
        // TRADED venue, so using it to narrow a search would move the chart off
        // the market the user was looking at.
        //
        // Rendered unconditionally now, not gated on PERPS_ENABLED: People is
        // not a venue, and it is the tab that makes Search a signal-first
        // surface rather than a ticker box.
      }
      <div
        role="group"
        aria-label="Search category"
        data-mobile-market-filters="true"
        // Four equal cells fit a 375px phone without a horizontal scroll; the
        // scroll classes stay as the fallback for a narrower viewport. The row
        // is a flat strip on a hairline, the same system as the Traders and
        // Account tab strips: the active filter is brighter text over a gold
        // rule, not a gold-filled pill (DESIGN.md: gold is a seasoning).
        className={cn(
          "no-scrollbar flex min-w-0 shrink-0 touch-pan-x overflow-x-auto overscroll-x-contain border-b border-[#1a3b46] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {visibleTabs.map((tab) => {
          const isActive = filter === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              aria-pressed={isActive}
              data-market-filter={tab.value}
              data-state={isActive ? "active" : "inactive"}
              onClick={() => onFilterChange(tab.value)}
              className={cn(
                "relative min-h-11 min-w-0 flex-1 whitespace-nowrap px-2 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none",
                isActive
                  ? "font-semibold text-white"
                  : "font-medium text-[#8da5ad] hover:text-white",
              )}
            >
              {tab.label}
              {isActive ? (
                <span
                  aria-hidden="true"
                  data-market-filter-rule="true"
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#e7c65d]"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {searchSubheading && (
        <div
          data-mobile-market-search-summary="true"
          className="flex shrink-0 items-center justify-between gap-3 px-1"
        >
          <p className="min-w-0 truncate font-mono text-3xs uppercase tracking-[0.12em] text-[#78929c]">
            {searchSubheading}
          </p>
          {browseStatus && (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 font-mono text-3xs uppercase tracking-[0.08em] text-[#8ca7b1]"
              aria-live="polite"
              title={browseStatus.label}
            >
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", browseStatus.dotClassName)}
              />
              {browseStatus.label}
            </span>
          )}
        </div>
      )}

      <div
        data-mobile-market-browse-content="true"
        className="flex flex-1 flex-col gap-3 pb-4"
      >
        {/* Plan S3. Rendered INSTEAD of the market lists, not beside them and not
            hidden: the caller query would otherwise run behind a Stocks tab
            nobody is looking at (audit M3). */}
        {showPeople ? (
          <MobilePeopleBrowse query={query} isSignedIn={isSignedIn} />
        ) : hasQuery ? (
          resultRows.length === 0 ? (
            <p className="border-y border-[#17313c] px-3 py-6 text-center text-xs text-[#8ba1a9]">
              {isSearching
                ? "Searching markets…"
                : /* "Not tradable" is a claim about the MARKET. A failed request
                     is a claim about us, and saying the first when we mean the
                     second tells a user their symbol does not exist here. */
                  searchFailed
                  ? "Could not search markets just now. Try again in a moment."
                  : "Not tradable on Ready Set Trade."}
            </p>
          ) : (
            <>
              {showStocks && groups.stocks.length > 0 && (
                <BrowseSection
                  title="Stocks"
                  caption={`${groups.stocks.length}`}
                  note={wrongVenueNotice("stocks", availability)}
                >
                  {groups.stocks.map((row) => renderRow(row, "result"))}
                </BrowseSection>
              )}
              {showPerps && groups.perps.length > 0 && (
                <BrowseSection
                  title="Perps"
                  caption={`${groups.perps.length}`}
                  note={wrongVenueNotice("perps", availability)}
                >
                  {groups.perps.map((row) => renderRow(row, "result"))}
                </BrowseSection>
              )}
            </>
          )
        ) : (
          <>
            {recentRows.length > 0 && (
              <BrowseSection title="Recent" caption={`${recentRows.length} saved`}>
                {recentRows.map((row) => renderRow(row, "recent"))}
              </BrowseSection>
            )}

            <MobileMarketPulse
              overview={pulseQuery.data}
              isLoading={pulseQuery.isLoading}
              isError={pulseQuery.isError}
              showStocks={showStocks}
              showPerps={showPerps}
              availability={availability}
              renderTile={renderTile}
              onRetry={() => void pulseQuery.refetch()}
              status={browseStatus}
            />
          </>
        )}
      </div>
    </div>
  );
}
