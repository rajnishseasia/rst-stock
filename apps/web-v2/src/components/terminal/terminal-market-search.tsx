"use client";

/**
 * Unified market search: the single symbol picker that spans both venues.
 *
 * A user types a symbol and sees whether it is tradable as a Stock, a Perp, or
 * both (one row per symbol, venue chips per row). Picking a suggestion (or a
 * specific venue chip on a both-venues row) flips to the right venue and sets
 * the right symbol slot in ONE action via `selectMarket`. This replaces the old
 * "pick a venue, then search that venue" model.
 *
 * Three exports:
 *  - `useMarketSearch`      headless state (debounce, `markets.search`, nav).
 *  - `MarketSuggestionsList` the venue-tagged dropdown (chips + wrong-venue notes).
 *  - `TerminalMarketSearch`  the desktop chart-bar search box (self-contained).
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { Search, X } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useVenue } from "@/lib/venue-context";
import { PERPS_ENABLED } from "@/lib/perps-config";
import {
  canSelectMarket,
  resolveEnterSelection,
  searchVenuesFilter,
  shouldShowRecentMarkets,
  visibleMarketSuggestions,
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
  rememberRecentMarket,
} from "@/lib/recent-markets";
import {
  marketSelectionKey,
  shouldCommitOnClick,
  type PointerCommit,
} from "@/components/terminal/market-browse";

const DEBOUNCE_MS = 150;
const DEFAULT_SUGGESTION_LIMIT = 8;

interface UseMarketSearchArgs {
  value: string;
  filter: MarketSearchFilter;
  /**
   * Called on Enter with the highlighted suggestion (or `null` when the list is
   * empty). The consumer resolves the venue and calls `selectMarket`.
   */
  onEnter: (item: MarketSearchItem | null) => void;
  limit?: number;
  /**
   * Switch the market search off entirely.
   *
   * For surfaces that keep this hook mounted while showing something other than
   * markets, notably the People tab. Without it, every debounced keystroke of a
   * CALLER name ran `markets.search`, a database hit for results nothing
   * rendered. The hook stays mounted so returning to a market tab keeps its
   * state; only the request stops.
   */
  disabled?: boolean;
}

export interface MarketSearchController {
  containerRef: RefObject<HTMLDivElement | null>;
  listboxId: string;
  /** Whether the floating dropdown should render (query present + open). */
  showList: boolean;
  /** Shared visibility state for suggestions and the empty-query recents menu. */
  isOpen: boolean;
  suggestions: MarketSearchItem[];
  highlight: number;
  setHighlight: (index: number) => void;
  activeDescendantId: string | undefined;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  handleFocus: () => void;
  close: () => void;
  /** True while the query is in flight. */
  isLoading: boolean;
  /**
   * The market search FAILED, as opposed to succeeding with nothing.
   *
   * React Query hands back an absent response on error, which the hook turns
   * into an empty suggestion list, so a consumer with only `isLoading` cannot
   * tell an outage from "no such market" and says the symbol is not tradable.
   */
  hasError: boolean;
  /** True once the (trimmed) query is non-empty. Drives the empty/loading UI. */
  hasQuery: boolean;
}

/**
 * Headless search state for the unified typeahead: debounce, the tRPC
 * `markets.search` query (venue-filtered), highlight index, open/close,
 * click-outside dismissal, keyboard nav. Presentation lives in the consumer.
 */
export function useMarketSearch({
  value,
  filter,
  onEnter,
  limit = DEFAULT_SUGGESTION_LIMIT,
  disabled = false,
}: UseMarketSearchArgs): MarketSearchController {
  const listboxId = useId();
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setDebouncedQuery("");
      return;
    }
    const handle = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value]);

  // With perps disabled this scopes the query to stocks so perp-only rows never
  // come back; when perps are enabled the dropdown filter drives it as before.
  const venues = searchVenuesFilter(filter, PERPS_ENABLED);
  const searchQuery = trpc.markets.search.useQuery(
    { q: debouncedQuery, limit, ...(venues ? { venues } : {}) },
    {
      enabled: !disabled && debouncedQuery.length > 0,
      staleTime: 60_000,
    },
  );

  // Defense in depth: even a stale/racey response can't surface a selectable
  // perp row while perps are disabled. `PERPS_ENABLED` is a build-time constant,
  // so it never changes across renders and is intentionally not a dep.
  const suggestions = useMemo<MarketSearchItem[]>(
    () => visibleMarketSuggestions(searchQuery.data ?? [], PERPS_ENABLED),
    [searchQuery.data],
  );

  useEffect(() => {
    setHighlight(0);
  }, [suggestions]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!open) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (suggestions.length > 0) setHighlight((highlight + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (suggestions.length > 0) {
        setHighlight((highlight - 1 + suggestions.length) % suggestions.length);
      }
    } else if (event.key === "Enter") {
      // Always intercept Enter while the dropdown is open so a bare symbol
      // resolves through the unified path (never silently submits as a stock).
      event.preventDefault();
      onEnter(suggestions[highlight] ?? null);
    }
  }

  const hasQuery = value.trim().length > 0;
  const showList = open && hasQuery;
  const activeDescendantId =
    showList && suggestions.length > 0
      ? `${listboxId}-opt-${highlight}`
      : undefined;

  return {
    containerRef,
    listboxId,
    showList,
    isOpen: open,
    suggestions,
    highlight,
    setHighlight,
    activeDescendantId,
    handleKeyDown,
    handleFocus: () => setOpen(true),
    close: () => setOpen(false),
    isLoading: searchQuery.isLoading && debouncedQuery.length > 0,
    // Scoped the same way as isLoading: with no query there is nothing to have
    // failed, and a disabled search must not report a stale error.
    hasError: !disabled && !!searchQuery.error && debouncedQuery.length > 0,
    hasQuery,
  };
}

const VENUE_LABEL: Record<MarketVenue, string> = {
  stocks: "Stock",
  perps: "Perp",
};

/** The pair of handlers a selectable control in this file binds. */
interface CommitHandlers {
  onMouseDown: (event: ReactMouseEvent) => void;
  onClick: () => void;
}

/**
 * Plan A6. Every selectable control here committed on `onMouseDown` alone, so
 * keyboard and assistive activation (which emit a `click` and no `mousedown`)
 * could not commit at all. That mattered most on a dual-listed symbol, where
 * `resolveEnterSelection` returns "ambiguous" under filter "all" and the venue
 * chip is the ONLY control that can disambiguate.
 *
 * The mousedown path stays, because it has to: it fires before the input's blur
 * closes the dropdown. The paired click is de-duplicated against it so a mouse
 * click still commits exactly once.
 */
function useSelectionCommit(onSelect: (selection: MarketSelection) => void) {
  const lastPointerCommit = useRef<PointerCommit | null>(null);
  return (selection: MarketSelection): CommitHandlers => ({
    onMouseDown: (event: ReactMouseEvent) => {
      event.preventDefault();
      lastPointerCommit.current = {
        key: marketSelectionKey(selection),
        at: Date.now(),
      };
      onSelect(selection);
    },
    onClick: () => {
      const key = marketSelectionKey(selection);
      if (!shouldCommitOnClick(lastPointerCommit.current, key, Date.now())) {
        return;
      }
      onSelect(selection);
    },
  });
}

function VenueChip({
  venue,
  available,
  interactive,
  commit,
}: {
  venue: MarketVenue;
  available: boolean;
  interactive: boolean;
  commit?: CommitHandlers;
}) {
  const label = VENUE_LABEL[venue];
  const className = cn(
    "rounded px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide",
    venue === "stocks"
      ? "bg-sky-500/15 text-sky-500"
      : "bg-amber-500/15 text-amber-500",
    !available && "opacity-60",
  );
  if (interactive && commit) {
    return (
      <button
        type="button"
        // mousedown (not click) fires before the input blur, so the pick lands
        // before the outside-click handler closes the dropdown; the paired
        // click is what keyboard and assistive activation use.
        onMouseDown={commit.onMouseDown}
        onClick={commit.onClick}
        className={cn(className, "transition-colors hover:brightness-110")}
        title={
          available
            ? `Trade ${label.toLowerCase()}`
            : venue === "stocks"
              ? "Connect an Alpaca account to trade stocks"
              : "Enable Perps in Settings to trade this market"
        }
      >
        {label}
      </button>
    );
  }
  return <span className={className}>{label}</span>;
}

interface MarketSuggestionsListProps {
  listboxId: string;
  suggestions: MarketSearchItem[];
  highlight: number;
  setHighlight: (index: number) => void;
  filter: MarketSearchFilter;
  availability: VenueAvailability;
  onSelect: (selection: MarketSelection) => void;
  isLoading?: boolean;
  className?: string;
}

/**
 * Venue-tagged suggestion dropdown. Single-venue rows are one click target;
 * both-venue rows expose a chip per venue so the user picks explicitly (no
 * silent guess). Rows whose venue isn't usable show an inline "wrong venue"
 * note but stay selectable so the user lands on the connect/enable CTA.
 */
export function MarketSuggestionsList({
  listboxId,
  suggestions,
  highlight,
  setHighlight,
  filter,
  availability,
  onSelect,
  isLoading = false,
  className,
}: MarketSuggestionsListProps) {
  // `null` (not yet known) is treated as available for PRESENTATION: dimming a
  // chip and offering "Connect an account" for a venue the user may already
  // have is the same false claim the notice avoids. Selection is unaffected;
  // the real gate is server-side.
  const isAvailable = (venue: MarketVenue) =>
    (venue === "stocks" ? availability.stocks : availability.perps) !== false;
  const commitFor = useSelectionCommit(onSelect);

  return (
    <div
      className={cn(
        "absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-md border bg-popover py-1 text-sm shadow-floating",
        className,
      )}
    >
      {suggestions.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          {isLoading ? "Searching markets…" : "Not tradable on Ready Set Trade."}
        </div>
      ) : (
        <ul id={listboxId} role="listbox">
          {suggestions.map((item, index) => {
            const isActive = index === highlight;
            const bothVenues = item.venues.length > 1;
            const soleVenue = item.venues[0];
            // Inline wrong-venue note for the highlighted row (keeps the list
            // uncluttered while still surfacing the HL8 messaging on focus).
            const note =
              isActive && soleVenue
                ? item.venues
                    .map((venue) =>
                      wrongVenueNotice(venue, availability) ?? undefined,
                    )
                    .find(Boolean)
                : undefined;
            return (
              <li
                key={item.symbol}
                id={`${listboxId}-opt-${index}`}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "px-2 py-1.5",
                  isActive && "bg-accent text-accent-foreground",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  {/* Single-venue rows: the whole label is the click target.
                      Both-venue rows: label is inert; the chips are the picks. */}
                  {bothVenues || !soleVenue ? (
                    <div className="flex min-w-0 flex-col">
                      <span className="font-mono text-xs font-semibold">
                        {item.symbol}
                      </span>
                      {item.name && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.name}
                        </span>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      {...commitFor({
                        symbol: item.symbol,
                        venue: soleVenue,
                      })}
                      className="flex min-w-0 flex-1 cursor-pointer flex-col text-left"
                    >
                      <span className="font-mono text-xs font-semibold">
                        {item.symbol}
                      </span>
                      {item.name && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.name}
                        </span>
                      )}
                    </button>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    {item.venues.map((venue) => (
                      <VenueChip
                        key={venue}
                        venue={venue}
                        available={isAvailable(venue)}
                        interactive={bothVenues}
                        commit={
                          bothVenues
                            ? commitFor({ symbol: item.symbol, venue })
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
                {note && (
                  <div className="mt-1 text-3xs leading-tight text-amber-500">
                    {note}
                  </div>
                )}
                {bothVenues && isActive && (
                  <div className="mt-1 text-3xs leading-tight text-muted-foreground">
                    Listed on both venues, pick a chip.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* Filter hint so users understand a narrowed result set. */}
      {filter !== "all" && suggestions.length > 0 && (
        <div className="border-t px-3 py-1 text-3xs text-muted-foreground">
          Filtered to {filter === "stocks" ? "stocks" : "perps"}.
        </div>
      )}
    </div>
  );
}

export interface TerminalMarketSearchProps {
  /** Current active symbol (stock ticker or perp coin) for the input default. */
  activeSymbol: string;
  /**
   * Whether the user can trade stocks (Alpaca account connected), or `null`
   * while the credentials read has not answered. See `VenueAvailability`:
   * collapsing unknown into false tells a connected user to go connect.
   */
  stocksAvailable: boolean | null;
  /** Whether the user can trade perps (HL wallet enabled), or `null` if unknown. */
  perpsAvailable: boolean | null;
  className?: string;
}

/**
 * Desktop chart-bar search box. Self-contained: reads `venue` / `searchFilter` /
 * `selectMarket` from the venue context and owns its own input state. Rendered
 * in place of the plain chart symbol input via `TerminalChartPanel`'s
 * `headerSearch` slot, so it sits right next to HL-2's quote strip.
 */
export function TerminalMarketSearch({
  activeSymbol,
  stocksAvailable,
  perpsAvailable,
  className,
}: TerminalMarketSearchProps) {
  const { searchFilter, selectMarket } = useVenue();
  const [value, setValue] = useState(activeSymbol);
  const [recentMarkets, setRecentMarkets] = useState<MarketSelection[]>([]);
  const [showRecents, setShowRecents] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const availability: VenueAvailability = {
    stocks: stocksAvailable,
    perps: perpsAvailable,
  };

  // Keep the box showing the active symbol until the user starts typing.
  useEffect(() => {
    setValue(activeSymbol);
  }, [activeSymbol]);

  useEffect(() => {
    setRecentMarkets(
      readRecentMarkets(browserRecentMarketsStore(), PERPS_ENABLED),
    );
  }, []);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      const isCommandSearch =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const isSlashSearch = event.key === "/" && !isTyping;
      if (!isCommandSearch && !isSlashSearch) return;

      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // The Enter handler needs `search` (for suggestions/close), but `search` needs
  // the handler; break the cycle with a ref that always points at the latest.
  const onEnterRef = useRef<(item: MarketSearchItem | null) => void>(() => {});
  const search = useMarketSearch({
    value,
    filter: searchFilter,
    onEnter: (item) => onEnterRef.current(item),
  });

  const commit = (selection: MarketSelection) => {
    if (!canSelectMarket(selection, PERPS_ENABLED)) return;
    selectMarket(selection);
    setValue(selection.symbol);
    search.close();
    setShowRecents(false);
    setRecentMarkets(
      rememberRecentMarket(
        browserRecentMarketsStore(),
        selection,
        PERPS_ENABLED,
      ),
    );
  };

  onEnterRef.current = (item: MarketSearchItem | null) => {
    const target = item ?? search.suggestions[0];
    if (!target) return;
    const resolution = resolveEnterSelection(target.venues, searchFilter);
    if (resolution.kind === "select") {
      commit({ symbol: target.symbol, venue: resolution.venue });
    }
    // "ambiguous" (both venues, no filter) and "none" leave the dropdown open so
    // the user picks a chip / sees the not-tradable state. We never guess.
  };

  const commitRecent = useSelectionCommit(commit);
  const placeholder = PERPS_ENABLED ? "Search stocks & perps…" : "Search ticker…";
  const showRecentMarkets = shouldShowRecentMarkets({
    requested: showRecents,
    isOpen: search.isOpen,
    hasQuery: search.hasQuery,
    count: recentMarkets.length,
  });

  return (
    <div
      ref={search.containerRef}
      className={cn(
        "relative h-10 w-[190px] shrink-0 @[760px]/chartbar:w-[250px] @[920px]/chartbar:w-[300px]",
        className,
      )}
    >
      <div className="terminal-command-surface flex h-full items-center gap-2 rounded-md border px-2.5 focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-ring/45">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value.toUpperCase());
            setShowRecents(event.target.value.length === 0);
            search.handleFocus();
          }}
          onFocus={() => {
            search.handleFocus();
            setShowRecents(value.trim().length === 0);
          }}
          onKeyDown={search.handleKeyDown}
          placeholder={placeholder}
          aria-label="Search markets"
          autoComplete="off"
          role="combobox"
          aria-expanded={search.showList || showRecentMarkets}
          aria-controls={search.showList ? search.listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={search.activeDescendantId}
          className="min-w-0 flex-1 bg-transparent font-data text-sm font-semibold uppercase tracking-normal outline-none placeholder:normal-case placeholder:font-normal placeholder:text-muted-foreground"
        />
        {value.length > 0 ? (
          <button
            type="button"
            aria-label="Clear market search"
            title="Clear search"
            onClick={() => {
              setValue("");
              setShowRecents(true);
              search.handleFocus();
              inputRef.current?.focus();
            }}
            className="terminal-icon-action inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : (
          <kbd className="hidden rounded-sm border border-border/60 bg-background/55 px-1.5 py-0.5 font-data text-3xs text-muted-foreground @[760px]/chartbar:inline-flex">
            /
          </kbd>
        )}
      </div>
      {showRecentMarkets && (
        <div className="terminal-floating-surface absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border py-1">
          <div className="px-3 py-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent markets
          </div>
          {recentMarkets.map((market) => (
            <button
              key={`${market.venue}:${market.symbol}`}
              type="button"
              // mousedown keeps the input from losing focus on a pointer
              // interaction; the paired click carries keyboard activation, and
              // is de-duplicated so a mouse click no longer commits twice.
              {...commitRecent(market)}
              className="terminal-list-row flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
            >
              <span className="font-data text-xs font-semibold">
                {market.symbol}
              </span>
              <VenueChip
                venue={market.venue}
                available={
                  // Unknown presents as available: dimming a chip and offering
                  // "connect an account" for a venue the user may already have
                  // is the same false claim the notice avoids.
                  (market.venue === "stocks" ? stocksAvailable : perpsAvailable) !==
                  false
                }
                interactive={false}
              />
            </button>
          ))}
        </div>
      )}
      {search.showList && (
        <MarketSuggestionsList
          listboxId={search.listboxId}
          suggestions={search.suggestions}
          highlight={search.highlight}
          setHighlight={search.setHighlight}
          filter={searchFilter}
          availability={availability}
          onSelect={commit}
          isLoading={search.isLoading}
        />
      )}
    </div>
  );
}
