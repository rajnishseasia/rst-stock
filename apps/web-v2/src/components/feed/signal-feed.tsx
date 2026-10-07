"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ListFilter, RefreshCw, Zap } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { signInWithGoogle } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  CollapseButton,
  useCollapsible,
} from "@/components/ui/section-collapse";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedUnavailableState } from "./feed-unavailable-state";
import { cn } from "@/lib/utils";
import { capTickerChips } from "@/lib/signal-display";
import { PERPS_ENABLED } from "@/lib/perps-config";
import { hasValidStockQuote, signalFeedCardClassName } from "./signal-feed-utils";
import {
  FEED_AUTO_ACCEPT_SCROLL_PX,
  acknowledgedGroups,
  feedPollIntervalMs,
  isFeedUnavailable,
  pendingSignalCount,
  resolveAcknowledgedKey,
} from "./feed-live-updates";
import {
  MAX_QUOTE_SYMBOLS,
  QUOTE_ANCHOR_STEP,
  quantizeFeedAnchor,
  quoteWindowSymbols,
} from "./feed-quote-window";
import {
  SignalContent,
  SignalSourceLink,
  SignalTimestamp,
} from "./signal-content";
import type { SignalThesis } from "./signal-thesis";
import { PerpCopyChip, StockCopyChip } from "./signal-ticker-chips";
import { DirectionBadge } from "./direction-badge";
import {
  collectFeedAuthors,
  dedupeSignalsById,
  filterGroupsByVenue,
  groupFeedSignals,
  groupStatedDirection,
  normalizeFeedSignals,
} from "./signal-groups";
import {
  NO_CALLER_FILTER,
  applyCallerFilter,
  clearCallerFilter,
  describeCallerFilter,
  isAuthorVisible,
  isCallerFilterEmpty,
  isOnlyAuthor,
  parseCallerFilter,
  serializeCallerFilter,
  toggleHiddenAuthor,
  toggleOnlyAuthor as narrowToAuthor,
  type CallerFilter,
} from "./caller-filter";
import { CallerSheet } from "./caller-sheet";
import {
  perpSignalSelection,
  signalTickerChartSelection,
  stockChartSelection,
  stockFromPerpSelection,
  stockSignalSelection,
} from "./signal-selection";
import type {
  PerpCopySelection,
  SelectedSignal,
  SignalChartSelection,
} from "./signal-selection";

export { cleanAuthorName } from "./signal-feed-utils";
// The copy payload shapes live in signal-selection.ts (audit H7); re-exported
// here so existing importers keep their path.
export type {
  PerpCopySelection,
  SelectedSignal,
  SignalChartSelection,
} from "./signal-selection";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function feedRevealScrollBehavior(
  prefersReducedMotion: boolean,
): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

/** How many signals to render initially and reveal per infinite-scroll page. */
const PAGE_SIZE = 30;

/** Cap on pages the sentinel will auto-fetch before the user must ask for more.
 *  Bounds a narrow filter (perps-only, heavily hidden authors) from walking the
 *  whole signals table, and bounds the per-poll refetch cost, since React Query
 *  refetches every loaded page on each interval. */
const MAX_AUTO_FETCH_PAGES = 5;

/**
 * localStorage key holding the author filter. Plan S2 widened the stored value
 * from a bare `string[]` of hidden names to a `CallerFilter`; the KEY is
 * deliberately unchanged and `parseCallerFilter` reads the legacy array, so
 * anyone who had callers muted keeps them muted through the upgrade.
 */
const HIDDEN_AUTHORS_KEY = "signal-feed:hidden-authors";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * The author is an interactive control on the embedded/mobile feed. Keep its
 * target at the mobile accessibility floor while allowing the terminal's xl
 * layout to retain its dense row height.
 */
export function signalAuthorClassName(embedded: boolean): string {
  return cn(
    "min-w-0 shrink truncate text-left text-xs font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    embedded &&
      "-my-3 inline-flex min-h-11 items-center xl:my-0 xl:min-h-0",
  );
}

/**
 * The feed body owns the remaining card height so its nested observer root can
 * measure the visible rows instead of growing to the full list height.
 */
export function signalFeedCardContentClassName(): string {
  return "flex min-h-0 flex-1 flex-col p-0";
}

/**
 * The observer root must remain a bounded flex item. Keeping `h-full` here
 * preserves the embedded card's full-height contract while `min-h-0 flex-1`
 * lets it yield the space occupied by the feed header and notices.
 *
 * Scroll chaining is only cut at xl. In the desktop drawer the page behind is
 * `fixed` and never scrolls, so containing the overscroll costs nothing. On the
 * phone chart screen this list sits inside a fixed-height box at the bottom of
 * a scrolling page, directly under a chart iframe that swallows touches: with
 * `overscroll-contain` a finger that reached the top of the list could not
 * drag the page back up, because the scroll was not allowed to chain to it.
 */
export function signalFeedScrollerClassName(embedded: boolean): string {
  return cn(
    "no-scrollbar h-full min-h-0 flex-1 overflow-y-auto xl:overscroll-contain",
    embedded ? "px-0 pb-3 pt-2 xl:px-0 xl:py-0" : "px-4 pb-4",
  );
}

/**
 * Persists the author filter (plan S2). Two modes, one stored value: hide a set
 * of callers, or narrow to exactly one. Every decision about which mode wins and
 * what each control says lives in `caller-filter.ts`; this hook is the storage
 * and state shell around it.
 *
 * SSR-safe: starts open and reconciles from localStorage after mount to avoid a
 * hydration mismatch.
 */
function useCallerFilter() {
  const [filter, setFilter] = useState<CallerFilter>(NO_CALLER_FILTER);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setFilter(parseCallerFilter(window.localStorage.getItem(HIDDEN_AUTHORS_KEY)));
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        HIDDEN_AUTHORS_KEY,
        serializeCallerFilter(filter),
      );
    } catch {
      // ignore
    }
  }, [filter, hydrated]);

  const toggleMute = useCallback((name: string) => {
    setFilter((prev) => toggleHiddenAuthor(prev, name));
  }, []);

  const toggleOnly = useCallback((name: string) => {
    setFilter((prev) => narrowToAuthor(prev, name));
  }, []);

  const clear = useCallback(() => setFilter(clearCallerFilter()), []);

  return { filter, toggleMute, toggleOnly, clear };
}

interface SignalFeedProps {
  isSignedIn: boolean;
  onSelectSignal: (signal: SelectedSignal) => void;
  /**
   * Chart the tapped ticker. Takes the whole selection rather than
   * `(symbol, venue)` because the signal has to survive the trip: charting is the
   * primary route to the ticket on mobile, so a bare symbol would strip the
   * order's signal link (see SignalChartSelection).
   */
  onViewSignal: (selection: SignalChartSelection) => void;
  /**
   * Route a PERP signal's Copy into the perps venue + perp trade form. When
   * omitted (or when perps are not configured for this deployment) the perp Copy
   * chip renders disabled with an "Enable perps to copy" tooltip.
   */
  onCopyPerpSignal?: (selection: PerpCopySelection) => void;
  /** Scope the feed using the terminal's All / Stocks / Perps market filter. */
  signalVenueFilter?: "all" | "stocks" | "perps";
  /** The header venue is authoritative for ticker identity clicks. */
  tickerClickVenue?: "stocks" | "perps";
  /**
   * Escape hatch out of the Perps narrowing, offered from the empty
   * state when the perps venue has no perp calls yet. The venue owns the
   * narrowing, so the parent has to perform the switch; omit it and the empty
   * state simply drops the button.
   */
  onShowAllSignals?: () => void;
  selectedSignalId?: string;
  subheaderAction?: SignalFeedSubheaderAction;
  subheaderActionNonce?: number;
  embedded?: boolean;
  /**
   * Embedded on a page that is itself the scroller (the phone Feed screen):
   * size to content and grow into free space instead of filling a bounded
   * box, so the list never scrolls on its own. See `signalFeedCardClassName`.
   */
  scrollsWithPage?: boolean;
}

export type SignalFeedSubheaderAction =
  | "all_authors"
  | "latest"
  | "price_pills";

export function SignalFeed({
  isSignedIn,
  onSelectSignal,
  onViewSignal,
  onCopyPerpSignal,
  signalVenueFilter = "all",
  tickerClickVenue = "stocks",
  onShowAllSignals,
  selectedSignalId,
  subheaderAction = "all_authors",
  subheaderActionNonce = 0,
  embedded = false,
  scrollsWithPage = false,
}: SignalFeedProps) {
  const { collapsed, toggle } = useCollapsible("x-signals");
  const isCollapsed = embedded ? false : collapsed;
  const {
    filter: callerFilter,
    toggleMute: toggleAuthor,
    toggleOnly: toggleOnlyCaller,
    clear: clearAuthors,
  } = useCallerFilter();
  // Plan S2. Which caller's sheet is open, by display name. Held here rather
  // than per row so exactly one can be open, and so it survives the row
  // re-rendering underneath it on a poll.
  // The caller whose sheet is open, as {name, key}. Storing only the display
  // name loses which row was clicked: several raw author identities normalize to
  // one display name (the Shardi variants), so a name lookup returns the FIRST
  // match and could open another key's record and point Follow at the wrong
  // server identity.
  const [openCaller, setOpenCaller] = useState<
    { name: string; key: string | null } | null
  >(null);
  const [showPricePills, setShowPricePills] = useState(true);
  const lastSubheaderNonceRef = useRef(0);

  const perpStatsQuery = trpc.hyperliquid.marketStats.useQuery(undefined, {
    enabled: PERPS_ENABLED && isSignedIn,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const perpStatsByCoin = useMemo(
    () =>
      new Map(
        (perpStatsQuery.data ?? []).map((asset) => [
          asset.coin.toUpperCase(),
          asset,
        ]),
      ),
    [perpStatsQuery.data],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Infinite query over Discord-sourced signals in the DB, newest first;
  // older pages page strictly-older history via the timestamp cursor.
  const {
    data,
    isLoading,
    isError: feedRequestFailed,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch: refetchSignals,
  } = trpc.signals.list.useInfiniteQuery(
    { limit: PAGE_SIZE },
    {
      enabled: isSignedIn,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      // React Query refetches EVERY loaded page on each tick, so the cadence
      // has to fall as the reader pages deeper or a 5-page feed costs five
      // requests every ten seconds (plan A12). Background tabs already stop on
      // their own: refetchIntervalInBackground defaults to false, and the focus
      // manager gates on document.visibilityState.
      refetchInterval: (query) =>
        feedPollIntervalMs(query.state.data?.pages.length ?? 1),
    },
  );

  // Audit M13: the API flags pages produced while the signals query failed,
  // so an outage renders as a visible degraded notice instead of an empty
  // feed that looks like "no signals today".
  //
  // The flag only covers a request that ANSWERED. A request that failed
  // outright returns no pages at all, so `degraded` was false, the group list
  // was empty, and the feed said "No signals found yet": we told the reader the
  // traders they follow had posted nothing, when the truth was that we could
  // not reach the API. Both are the same statement to a reader, so both take
  // the same notice.
  const feedUnavailable = useMemo(
    () => isFeedUnavailable({ requestFailed: feedRequestFailed, pages: data?.pages }),
    [feedRequestFailed, data],
  );

  // Flatten all loaded pages, dropping repeat row ids across page boundaries.
  // Per-tweet grouping (one card per tweet, even when a tweet mentions several
  // tickers) happens later in `groups` - the ingest layer intentionally writes
  // one row per (tweet, ticker) so charts/per-ticker filters still work.
  const signals = useMemo(
    () => dedupeSignalsById((data?.pages ?? []).flatMap((page) => page.items)),
    [data],
  );

  // Normalize each signal's display content and metadata once.
  const processed = useMemo(() => normalizeFeedSignals(signals), [signals]);

  // Unique authors (with counts) for the filter menu, most-frequent first.
  const authors = useMemo(() => collectFeedAuthors(processed), [processed]);
  const callerFilterNote = describeCallerFilter(callerFilter);
  // The open caller's identity, resolved from the loaded rows. Falls back to the
  // name alone when the caller scrolls out of the loaded pages while their sheet
  // is open: the sheet stays usable, it just cannot show an avatar.
  const openCallerEntry = useMemo(() => {
    if (!openCaller) return null;
    // Match on the KEY the user actually clicked. Only fall back to the display
    // name when that row carried no key at all.
    if (openCaller.key) {
      const byKey = authors.find((author) => author.key === openCaller.key);
      if (byKey) return byKey;
    }
    return authors.find((author) => author.name === openCaller.name) ?? null;
  }, [authors, openCaller]);

  const visible = useMemo(
    () => applyCallerFilter(processed, callerFilter),
    [processed, callerFilter],
  );

  // Collapse the per-(tweet, ticker) rows into one card per tweet. Tweets that
  // mention several tickers (e.g. "$CBRS $NVDA $AMZN ...") would otherwise show
  // up as N near-identical cards.
  const groups = useMemo(() => groupFeedSignals(visible), [visible]);

  // When on the perps venue, narrow the feed to perp calls so the perps context
  // has its own signal surface. The full mixed feed (perps badged) shows on the
  // stocks venue.
  const displayGroups = useMemo(
    () => filterGroupsByVenue(groups, signalVenueFilter),
    [groups, signalVenueFilter],
  );
  const perpsOnly = signalVenueFilter === "perps";

  // Plan A12: new signals arriving on the poll are NOT prepended under the
  // reader's thumb. `acknowledgedKey` marks the group the reader currently
  // treats as the top of the list; anything newer is counted and offered as a
  // pill. Someone already sitting at the top accepts new rows automatically
  // (see the scroll handler below), so the pill only ever appears for someone
  // who has scrolled away and would otherwise have the page shift.
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
  const groupKeys = useMemo(
    () => displayGroups.map((group) => group.key),
    [displayGroups],
  );
  const pendingCount = pendingSignalCount(groupKeys, acknowledgedKey);
  const renderedGroups = useMemo(
    () => acknowledgedGroups(displayGroups, pendingCount),
    [displayGroups, pendingCount],
  );

  // Whether the reader is parked at the top of the feed. A passive listener
  // that only writes state on a threshold crossing, so scrolling does not
  // re-render the list.
  const [atTopOfFeed, setAtTopOfFeed] = useState(true);
  useEffect(() => {
    const root = scrollRef.current;
    if (isCollapsed || !root) return;
    const onScroll = () => {
      const next = root.scrollTop <= FEED_AUTO_ACCEPT_SCROLL_PX;
      setAtTopOfFeed((current) => (current === next ? current : next));
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [isCollapsed]);

  // Adopt the head of the list on first load, and whenever the reader is at the
  // top of the scroller. Without this the first poll after mount would present
  // a pill for signals the reader is already looking at.
  const headKey = groupKeys[0] ?? null;
  useEffect(() => {
    const next = resolveAcknowledgedKey({
      orderedKeys: groupKeys,
      acknowledgedKey,
      atTopOfFeed,
    });
    if (next !== acknowledgedKey) setAcknowledgedKey(next);
  }, [groupKeys, acknowledgedKey, atTopOfFeed]);

  // Cheap identity fingerprint of what is currently rendered. `groupKeys` is the
  // full list; this is the acknowledged slice the DOM actually holds.
  const renderedGroupSignature = useMemo(
    () => renderedGroups.map((group) => group.key).join("|"),
    [renderedGroups],
  );

  const acceptPendingSignals = useCallback(() => {
    setAcknowledgedKey(headKey);
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches;
    scrollRef.current?.scrollTo({
      top: 0,
      behavior: feedRevealScrollBehavior(prefersReducedMotion),
    });
  }, [headKey]);

  // Plan A13: the quote budget follows the reader instead of load order.
  // Perp tickers are included only to discover whether the same symbol is also
  // Alpaca-listed, enabling an explicit stock action without confusing its
  // equity quote with the Hyperliquid mark shown on the perp chip.
  // Only the chips that actually RENDER are worth a quote: iterating the full
  // uncapped ticker list let two or three spam tweets (a dozen-plus symbols
  // each) exhaust the budget on chips capTickerChips hides, leaving visible
  // chips on later cards with no price.
  const [quoteAnchorIndex, setQuoteAnchorIndex] = useState(0);
  const rowSymbols = useMemo(
    () =>
      renderedGroups.map((group) =>
        capTickerChips(group.tickers)
          .map((ticker) => ticker.symbol)
          .filter((symbol): symbol is string => !!symbol),
      ),
    [renderedGroups],
  );
  const quoteSymbols = useMemo(
    () =>
      quoteWindowSymbols(rowSymbols, {
        anchorIndex: quoteAnchorIndex,
        cap: MAX_QUOTE_SYMBOLS,
      }),
    [rowSymbols, quoteAnchorIndex],
  );

  // Live prices via master Alpaca credentials - shown to any signed-in user,
  // no linked brokerage required. Auto-refreshes every 30s; the header's
  // refresh button triggers a manual refetch.
  const quotesQuery = trpc.quotes.getChartQuotes.useQuery(
    { symbols: quoteSymbols },
    {
      enabled: isSignedIn && quoteSymbols.length > 0,
      refetchInterval: 30000,
      staleTime: 15000,
      // The symbol list is now part of the key and moves with the scroll (A13),
      // so every band change would otherwise blank every price pill until the
      // new batch lands. Overlapping symbols keep their last value instead.
      placeholderData: (previous) => previous,
    },
  );
  const refetchQuotes = quotesQuery.refetch;

  const quotesBySymbol = useMemo(
    () => new Map((quotesQuery.data ?? []).map((q) => [q.symbol, q])),
    [quotesQuery.data],
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (!isSignedIn) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refetchSignals(), refetchQuotes()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [isSignedIn, refetchQuotes, refetchSignals]);

  useEffect(() => {
    if (
      subheaderActionNonce === 0 ||
      lastSubheaderNonceRef.current === subheaderActionNonce
    ) {
      return;
    }
    lastSubheaderNonceRef.current = subheaderActionNonce;

    if (subheaderAction === "all_authors") {
      clearAuthors();
      return;
    }

    if (subheaderAction === "latest") {
      // "Latest" means show me the newest calls, so it takes whatever the pill
      // is holding back as well as refetching.
      acceptPendingSignals();
      handleRefresh();
      return;
    }

    setShowPricePills(true);
  }, [
    acceptPendingSignals,
    clearAuthors,
    handleRefresh,
    subheaderAction,
    subheaderActionNonce,
  ]);

  // Infinite scroll: fetch the next page of history when the sentinel scrolls
  // into view. Re-runs after each load so a tall/sparsely-filtered viewport
  // keeps fetching until it's full or there's no more history.
  //
  // Auto-fetch is CAPPED. When the rendered list stays shorter than the viewport
  // (a narrow filter such as the perps-only view, or many hidden authors) the
  // sentinel never leaves the root margin, so it re-fires after every page and
  // walks the entire signals table. React Query also refetches every loaded page
  // on each poll, so a deep crawl multiplies the 10s poll into N requests. Past
  // the cap the user pages manually.
  const loadedPages = data?.pages.length ?? 0;
  const autoFetchExhausted = loadedPages >= MAX_AUTO_FETCH_PAGES;
  useEffect(() => {
    if (isCollapsed || !hasNextPage || isFetchingNextPage) return;
    if (autoFetchExhausted) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) fetchNextPage();
      },
      { root, rootMargin: "200px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [
    isCollapsed,
    hasNextPage,
    isFetchingNextPage,
    autoFetchExhausted,
    fetchNextPage,
    displayGroups.length,
  ]);

  // Track the topmost row on screen so the quote window can follow it (A13).
  // An IntersectionObserver rather than a scroll listener: feed rows are
  // variable height (image cards, long tweets), so there is no row height to
  // divide scrollTop by. The anchor is quantized before it reaches state, so
  // scrolling within a band of rows does not churn the quote query key.
  const visibleRowIndicesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (isCollapsed) return;
    const root = scrollRef.current;
    if (!root) return;
    const visible = visibleRowIndicesRef.current;
    visible.clear();

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const raw = entry.target.getAttribute("data-feed-index");
          const index = raw == null ? Number.NaN : Number(raw);
          if (!Number.isFinite(index)) continue;
          if (entry.isIntersecting) visible.add(index);
          else visible.delete(index);
        }
        const top = visible.size === 0 ? 0 : Math.min(...visible);
        setQuoteAnchorIndex((current) => {
          const next = quantizeFeedAnchor(top, QUOTE_ANCHOR_STEP);
          return next === current ? current : next;
        });
      },
      { root },
    );
    root.querySelectorAll("[data-feed-index]").forEach((row) => io.observe(row));
    return () => io.disconnect();
    // Keyed on the rendered IDENTITIES, not the count. A filter change or a poll
    // can swap in a different set of the same size, and the observer would then
    // still be holding the detached nodes: the replacements are never observed,
    // so the anchor stays pinned to the old layout and the quote budget prices a
    // band the reader is not looking at.
  }, [isCollapsed, renderedGroupSignature]);

  return (
    <Card
      className={signalFeedCardClassName({
        embedded,
        collapsed: isCollapsed,
        scrollsWithPage,
      })}
    >
      <CardHeader
        className={cn(
          embedded &&
            "shrink-0 border-b border-surface-border bg-surface-canvas/40 px-0 py-1 xl:px-3 xl:py-2",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {!embedded && <CardTitle>X Signals</CardTitle>}
            {perpsOnly && (
              <Badge
                variant="secondary"
                className="shrink-0 gap-1 text-3xs uppercase tracking-wide"
                title="Showing perp signals only (perps venue)"
              >
                <Zap className="h-3 w-3" />
                Perps
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing || !isSignedIn}
              aria-label="Refresh prices"
              title="Refresh prices"
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
                embedded ? "h-11 w-11 xl:h-8 xl:w-8" : "h-8 w-8",
              )}
            >
              <RefreshCw
                className={cn("h-4 w-4", isRefreshing && "animate-spin")}
              />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Filter authors"
                  title="Filter authors"
                  className={cn(
                    "relative inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
                    embedded ? "h-11 w-11 xl:h-8 xl:w-8" : "h-8 w-8",
                  )}
                >
                  <ListFilter className="h-4 w-4" />
                  {!isCallerFilterEmpty(callerFilter) && (
                    <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-h-80 w-64 overflow-y-auto"
              >
                <DropdownMenuLabel className="flex items-center justify-between gap-2">
                  <span>Filter authors</span>
                  {!isCallerFilterEmpty(callerFilter) && (
                    <button
                      type="button"
                      onClick={clearAuthors}
                      className="text-xs font-normal text-primary hover:underline"
                    >
                      Reset
                    </button>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {authors.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No authors yet
                  </div>
                ) : (
                  authors.map((a) => (
                    <DropdownMenuCheckboxItem
                      key={a.name}
                      checked={isAuthorVisible(callerFilter, a.name)}
                      onCheckedChange={() => toggleAuthor(a.name)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span className="truncate">{a.name}</span>
                      <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">
                        {a.count}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {!embedded && (
              <CollapseButton
                collapsed={collapsed}
                onToggle={toggle}
                label="X Signals"
              />
            )}
          </div>
        </div>
      </CardHeader>
      {!isCollapsed && (
        <CardContent className={signalFeedCardContentClassName()}>
          {/* Plan A12: the pill sits above the scroller, not inside it, so it
              stays reachable no matter how far the reader has scrolled. */}
          {pendingCount > 0 && (
            <div className="pointer-events-none relative z-10 flex justify-center">
              <button
                type="button"
                onClick={acceptPendingSignals}
                className="pointer-events-auto absolute top-1 inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-semibold text-foreground shadow-floating transition-colors hover:bg-accent sm:h-7"
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                {pendingCount} new {pendingCount === 1 ? "signal" : "signals"}
              </button>
            </div>
          )}
          {/* Plan S2. The filter names its own cause. A feed narrowed to one
              caller, or with several muted, otherwise looks like a feed that has
              simply stopped receiving calls, and the control that caused it is
              hidden inside a dropdown. */}
          {callerFilterNote && (
            <div
              className={cn(
                "flex items-center justify-between gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5",
                embedded ? "" : "mx-4 mb-2 rounded-md border",
              )}
            >
              <span className="min-w-0 truncate text-2xs text-muted-foreground">
                {callerFilterNote}
              </span>
              <button
                type="button"
                onClick={clearAuthors}
                className="min-h-11 shrink-0 text-2xs font-semibold text-primary hover:underline sm:min-h-0"
              >
                Show all
              </button>
            </div>
          )}
          <div
            ref={scrollRef}
            className={signalFeedScrollerClassName(embedded)}
          >
            <div
              className={cn(
                // min-h-full: at least the scroller's height, so a `fill`
                // empty state centers in the slack. Real rows still push past
                // it and scroll as before.
                "flex min-h-full flex-col gap-2",
                embedded && "gap-1.5 xl:gap-0",
              )}
            >
              {isLoading && (
                <>
                  <Skeleton
                    className={cn(
                      "h-20 w-full",
                      embedded &&
                        "xl:rounded-none xl:border-b xl:border-border/50",
                    )}
                  />
                  <Skeleton
                    className={cn(
                      "h-20 w-full",
                      embedded &&
                        "xl:rounded-none xl:border-b xl:border-border/50",
                    )}
                  />
                  <Skeleton
                    className={cn(
                      "h-20 w-full",
                      embedded &&
                        "xl:rounded-none xl:border-b xl:border-border/50",
                    )}
                  />
                </>
              )}

              {renderedGroups.map((group, rowIndex) => {
                const authorInitials = initialsOf(group.authorName);
                const isSelected =
                  !!selectedSignalId && group.signalIds.has(selectedSignalId);
                /**
                 * Plan S1. The caller context that travels with whichever chip
                 * the reader taps, so the chart screen can say WHOSE call sent
                 * them there instead of just which ticker.
                 *
                 * Per ticker, because `direction` is stored per (post, ticker)
                 * row, and read from `ticker.direction` (presence-gated) rather
                 * than `ticker.perp.side` (which defaults an unstated direction
                 * to long so a copy has a side to open).
                 */
                const thesisFor = (
                  ticker: (typeof group.tickers)[number],
                ): SignalThesis => ({
                  authorName: group.authorName,
                  authorAvatar: group.authorAvatar,
                  timestamp: group.timestamp,
                  url: group.url,
                  imageUrl: group.imageUrl,
                  direction: ticker.direction,
                });
                /**
                 * Card-level badge: only the direction EVERY stated ticker
                 * agrees on, so the header never claims a side the post did
                 * not take (mixed or silent posts render no badge at all).
                 */
                const statedDirection = groupStatedDirection(group.tickers);

                return (
                  <div
                    key={group.key}
                    data-feed-index={rowIndex}
                    className={cn(
                      "terminal-signal-row relative flex min-w-0 gap-3 border p-3 transition-[background-color,border-color] duration-150 motion-reduce:transition-none",
                      embedded
                        ? "rounded-2xl border-surface-border-strong bg-surface-pane before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-gold before:opacity-0 before:transition-opacity before:duration-150 before:content-[''] motion-reduce:before:transition-none xl:rounded-none xl:border-x-0 xl:border-t-0 xl:border-b xl:border-surface-border xl:bg-transparent xl:px-3 xl:py-2"
                        : "rounded-lg",
                      isSelected &&
                        (embedded
                          ? "bg-gold/[0.06] before:opacity-100 xl:bg-gold/[0.05]"
                          : "bg-muted/50 ring-2 ring-primary"),
                    )}
                  >
                    <Avatar
                      size="lg"
                      className={cn("mt-0.5", embedded && "xl:size-8!")}
                    >
                      {group.authorAvatar && (
                        <AvatarImage
                          src={group.authorAvatar}
                          alt={group.authorName}
                        />
                      )}
                      <AvatarFallback>{authorInitials || "?"}</AvatarFallback>
                    </Avatar>
                    <div
                      className={cn(
                        "flex min-w-0 flex-1 flex-col gap-2",
                        embedded && "xl:gap-1",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {/* Plan S2. The author is a control, not a label. Tapping
                            it opens their measured record, their recent calls,
                            and the only/mute/follow actions. `stopPropagation`
                            because the card itself is clickable. */}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenCaller({
                              name: group.authorName,
                              key: group.authorKey,
                            });
                          }}
                          title={`Open ${group.authorName}`}
                          className={signalAuthorClassName(embedded)}
                        >
                          {group.authorName}
                        </button>
                        {statedDirection && (
                          <DirectionBadge direction={statedDirection} />
                        )}
                        <span
                          aria-hidden="true"
                          className="size-0.5 shrink-0 rounded-full bg-muted-foreground/40"
                        />
                        <SignalTimestamp
                          timestamp={group.timestamp}
                          embedded={embedded}
                        />
                        <SignalSourceLink
                          url={group.url}
                          embedded={embedded}
                        />
                      </div>
                      <SignalContent
                        content={group.content}
                        imageUrl={group.imageUrl}
                        embedded={embedded}
                      />
                      <div
                        className={cn(
                          "flex flex-wrap items-center gap-1.5",
                          embedded && "pt-0.5 xl:gap-1",
                        )}
                      >
                        {/* Cap at the first few tickers so a tweet that
                            mentions a dozen-plus symbols does not flood the
                            row with copy actions (doc #4). */}
                        {capTickerChips(group.tickers).map((t) => {
                          // Every chip is a two-part control: the ticker half
                          // charts the market (identity), the Copy half prefills
                          // a ticket (intent). Both halves carry the signal, so
                          // an order placed after either tap keeps its
                          // provenance.
                          //
                          // Perp calls route Copy into the perps venue + perp
                          // trade form (never the equity ticket) and render a
                          // distinct Perp + direction/leverage mark.
                          if (t.perp) {
                            const perpStats = perpStatsByCoin.get(
                              t.perp.coin.toUpperCase(),
                            );
                            return (
                              <PerpCopyChip
                                key={t.signalId}
                                // Canonical HL spelling (kPEPE, not KPEPE) so
                                // the label matches the coin actually copied.
                                coin={t.perp.coin}
                                payload={t.perp}
                                markPx={perpStats?.markPx ?? undefined}
                                prevDayPx={perpStats?.prevDayPx ?? undefined}
                                onTradeStock={
                                  hasValidStockQuote(
                                    quotesBySymbol.get(t.symbol.toUpperCase()),
                                  )
                                    ? () =>
                                        onSelectSignal(
                                          stockFromPerpSelection({
                                            symbol: t.symbol,
                                            signalId: t.signalId,
                                            content: group.content,
                                            thesis: thesisFor(t),
                                          }),
                                        )
                                    : undefined
                                }
                                active={selectedSignalId === t.signalId}
                                embedded={embedded}
                                onViewChart={() =>
                                  onViewSignal(
                                    signalTickerChartSelection({
                                      activeVenue: tickerClickVenue,
                                      source: {
                                        symbol: t.symbol,
                                        signalId: t.signalId,
                                        content: group.content,
                                        thesis: thesisFor(t),
                                      },
                                      perp: t.perp,
                                    }),
                                  )
                                }
                                // The perp COPY payload deliberately carries no
                                // thesis. It seeds an order ticket, and
                                // `PerpCopySelection` is the one selection shape
                                // whose fields become a trade; display context
                                // has no business on it.
                                onCopy={
                                  onCopyPerpSignal
                                    ? () =>
                                        onCopyPerpSignal(
                                          perpSignalSelection(t.perp!, {
                                            signalId: t.signalId,
                                            content: group.content,
                                          }),
                                        )
                                    : undefined
                                }
                              />
                            );
                          }
                          return (
                            <StockCopyChip
                              key={t.signalId}
                              symbol={t.symbol}
                              quote={quotesBySymbol.get(t.symbol.toUpperCase())}
                              showPrice={showPricePills}
                              active={selectedSignalId === t.signalId}
                              embedded={embedded}
                              onViewChart={() =>
                                onViewSignal(
                                  stockChartSelection({
                                    symbol: t.symbol,
                                    signalId: t.signalId,
                                    content: group.content,
                                    thesis: thesisFor(t),
                                  }),
                                )
                              }
                              onCopy={() =>
                                onSelectSignal(
                                  stockSignalSelection({
                                    symbol: t.symbol,
                                    signalId: t.signalId,
                                    content: group.content,
                                    thesis: thesisFor(t),
                                  }),
                                )
                              }
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Infinite-scroll sentinel. Past the auto-fetch cap it becomes an
                  explicit control so a narrow filter cannot crawl the table. */}
              {hasNextPage && (
                <div
                  ref={sentinelRef}
                  className="py-3 text-center text-xs text-muted-foreground"
                >
                  {isFetchingNextPage ? (
                    "Loading more…"
                  ) : autoFetchExhausted ? (
                    <button
                      type="button"
                      onClick={() => void fetchNextPage()}
                      className="rounded-sm border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                    >
                      Load older signals
                    </button>
                  ) : (
                    ""
                  )}
                </div>
              )}

              {!isSignedIn && (
                <EmptyState fill
                  icon={Zap}
                  title="Sign in to see X Signals"
                  body="The feed aggregates live calls from the traders you follow. Signing in is the only step."
                  actions={[
                    {
                      label: "Sign in with Google",
                      onClick: () => void signInWithGoogle(),
                    },
                  ]}
                />
              )}

              {feedUnavailable && (
                <FeedUnavailableState
                  hasSignals={displayGroups.length > 0}
                  onRetry={() => void handleRefresh()}
                  retrying={isRefreshing}
                />
              )}

              {isSignedIn &&
                !isLoading &&
                displayGroups.length === 0 &&
                !feedUnavailable &&
                (perpsOnly && groups.length > 0 ? (
                  // Narrowed by the venue, not by anything the user did here.
                  // Say so, and offer the way back to the full feed.
                  <EmptyState fill
                    icon={Zap}
                    title="No perp signals yet"
                    body="The perps venue only shows perp calls. Stock and option calls are still coming in on the full feed."
                    actions={
                      onShowAllSignals
                        ? [{ label: "Show all signals", onClick: onShowAllSignals }]
                        : []
                    }
                  />
                ) : processed.length === 0 ? (
                  <EmptyState fill
                    icon={Zap}
                    title="No signals found yet"
                    body="New calls land here as the traders we track post them. Pull to refresh if you have been here a while."
                    actions={[
                      { label: "Refresh feed", onClick: () => void handleRefresh() },
                    ]}
                  />
                ) : (
                  // The user hid every author that has posted. The filter is
                  // the only thing standing between them and a full feed, so
                  // clearing it is the whole empty state.
                  <EmptyState fill
                    icon={ListFilter}
                    title="No signals match your author filter"
                    body="Every author with a recent call is hidden right now."
                    actions={[
                      { label: "Show all authors", onClick: clearAuthors },
                    ]}
                  />
                ))}
            </div>
          </div>
        </CardContent>
      )}

      {/* Plan S2. Mounted only while open, so the caller-record query does not
          run for a sheet nobody asked for. Fixed-position, so it works
          identically inside the mobile shell and inside a terminal pane. */}
      {openCaller && (
        <CallerSheet
          authorName={openCaller.name}
          authorKey={openCaller.key ?? openCallerEntry?.key ?? null}
          authorAvatar={openCallerEntry?.avatar ?? null}
          isSignedIn={isSignedIn}
          filter={callerFilter}
          onToggleOnly={() => toggleOnlyCaller(openCaller.name)}
          onToggleMute={() => {
            toggleAuthor(openCaller.name);
            // Muting from the sheet closes it: the row it belongs to is about
            // to leave the feed, so leaving the sheet up over a card that no
            // longer exists reads as a failed action.
            if (isAuthorVisible(callerFilter, openCaller.name)) setOpenCaller(null);
          }}
          onClose={() => setOpenCaller(null)}
        />
      )}
    </Card>
  );
}
