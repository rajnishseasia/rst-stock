"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  LineChart,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { getQuoteFreshness, type QuoteFreshnessTone } from "@/lib/quote-freshness";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
import { SymbolSearchInput } from "@/components/watchlist/symbol-search-input";
import { Input } from "@/components/ui/input";
import { PERPS_ENABLED } from "@/lib/perps-config";
import type { MarketVenue } from "@/lib/market-selection";
import { useVenue } from "@/lib/venue-context";
import { formatPerpChangePct, formatPerpUsd } from "@/components/perps/perp-format";
import { formatChangePct, formatPriceUsd, formatSignedNumber, toFiniteNumber } from "@/lib/format";
import { ChangeBadge } from "@/components/ui/change-badge";
import { LiveDataValue } from "@/components/ui/live-data-value";
import { resolveAddSymbol } from "@/components/watchlist/watchlist-add-symbol";
import { buildWatchlistRowActions } from "@/components/watchlist/watchlist-row-actions";
// The same metric composer the mobile market rows use, which in turn wraps the
// desktop HL Markets list's `perpMarketRowMetrics`. One definition of Vol / OI
// / Fund across every surface that shows them.
import {
  perpRowMetrics,
  stockRowMetrics,
} from "@/components/terminal/market-row-metrics";

type WatchlistPanelProps = {
  activeCredentialId?: string;
  selectedSymbol?: string;
  selectedPerpSymbol?: string;
  onTradeSymbol: (symbol: string, venue?: MarketVenue) => void;
  onAskAi: (symbol: string, venue?: MarketVenue) => void;
  onViewSymbol: (symbol: string, venue?: MarketVenue) => void;
  subheaderAction?: WatchlistSubheaderAction;
  subheaderActionNonce?: number;
  embedded?: boolean;
};

export type WatchlistSubheaderAction = "saved" | "live_quotes" | "ai";

/** Quote payloads carry prices as decimal strings; LiveDataValue compares numbers. */
function quoteFreshnessClass(tone: QuoteFreshnessTone) {
  if (tone === "live") return "text-green-400";
  if (tone === "refreshing") return "text-blue-300";
  if (tone === "stale") return "text-amber-300";
  if (tone === "error") return "text-red-400";
  return "text-muted-foreground";
}


export function WatchlistPanel({
  activeCredentialId,
  selectedSymbol,
  selectedPerpSymbol,
  onTradeSymbol,
  onAskAi,
  onViewSymbol,
  subheaderAction = "saved",
  subheaderActionNonce = 0,
  embedded = false,
}: WatchlistPanelProps) {
  const { collapsed, toggle } = useCollapsible("watchlist");
  const { venue: activeVenue } = useVenue();
  const isCollapsed = embedded ? false : collapsed;
  const [symbolInput, setSymbolInput] = useState("");
  const [addVenue, setAddVenue] = useState<MarketVenue>("stocks");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [quoteFocus, setQuoteFocus] = useState(false);
  const lastSubheaderNonceRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [isTabVisible, setIsTabVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const isPanelVisible = isIntersecting && isTabVisible;
  const { data: session } = useSession();
  const trpcUtils = trpc.useUtils();

  const watchlistQuery = trpc.watchlist.list.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const perpUniverseQuery = trpc.markets.perpUniverse.useQuery(undefined, {
    enabled: addVenue === "perps",
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const items = watchlistQuery.data ?? [];
  const stockItems = items.filter((item) => item.venue === "stocks");
  const perpItems = items.filter((item) => item.venue === "perps");
  const symbols = stockItems.map((item) => item.symbol);
  // getStockQuotes caps input at 20 symbols; cap here so a long watchlist
  // degrades gracefully (rows past 20 show no quote) instead of failing the
  // entire quotes query with a Zod error.
  const quoteSymbols = symbols.slice(0, 20);

  const quotesQuery = trpc.quotes.getStockQuotes.useQuery(
    { symbols: quoteSymbols, credentialId: activeCredentialId },
    {
      enabled: Boolean(activeCredentialId && quoteSymbols.length > 0),
      refetchInterval: isPanelVisible && !isCollapsed ? 30000 : false,
      staleTime: 15000,
    }
  );
  // One market-stats call provides both live marks and previous-day prices.
  const perpStatsQuery = trpc.hyperliquid.marketStats.useQuery(undefined, {
    enabled: PERPS_ENABLED && perpItems.length > 0,
    refetchInterval: isPanelVisible && !isCollapsed ? 30_000 : false,
    staleTime: 15_000,
    retry: false,
  });
  const perpStatusQuery = trpc.hyperliquid.status.useQuery(undefined, {
    enabled: PERPS_ENABLED && perpItems.length > 0,
    staleTime: 15_000,
    retry: false,
  });
  const refetchQuotes = quotesQuery.refetch;

  const quotesBySymbol = useMemo(() => {
    return new Map((quotesQuery.data ?? []).map((quote) => [quote.symbol, quote]));
  }, [quotesQuery.data]);

  // Pause quote polling when the panel scrolls off-screen or the tab is hidden.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsIntersecting(entry?.isIntersecting ?? false),
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onVisibilityChange() {
      setIsTabVisible(document.visibilityState !== "hidden");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (
      subheaderActionNonce === 0 ||
      lastSubheaderNonceRef.current === subheaderActionNonce
    ) {
      return;
    }
    lastSubheaderNonceRef.current = subheaderActionNonce;

    if (subheaderAction === "saved") {
      setQuoteFocus(false);
      setIsOrganizing(false);
      return;
    }

    if (subheaderAction === "live_quotes") {
      setQuoteFocus(true);
      if (activeCredentialId && quoteSymbols.length > 0) {
        refetchQuotes();
      }
      return;
    }

    setQuoteFocus(false);
    if (selectedSymbol) {
      onAskAi(selectedSymbol);
    }
  }, [
    activeCredentialId,
    onAskAi,
    quoteSymbols.length,
    refetchQuotes,
    selectedSymbol,
    subheaderAction,
    subheaderActionNonce,
  ]);

  const addMutation = trpc.watchlist.add.useMutation({
    onSuccess: (result) => {
      setSymbolInput("");
      setStatusMessage(
        result.alreadyExists
          ? `${result.item.symbol} is already on your watchlist.`
          : `${result.item.symbol} added to your watchlist.`
      );
      trpcUtils.watchlist.list.invalidate();
    },
    onError: (error) => setStatusMessage(error.message),
  });

  const removeMutation = trpc.watchlist.remove.useMutation({
    onSuccess: () => {
      setStatusMessage("Removed from watchlist.");
      trpcUtils.watchlist.list.invalidate();
    },
    onError: (error) => setStatusMessage(error.message),
  });

  const reorderMutation = trpc.watchlist.reorder.useMutation({
    onMutate: async ({ itemIds }) => {
      await trpcUtils.watchlist.list.cancel();
      const previousItems = trpcUtils.watchlist.list.getData();
      trpcUtils.watchlist.list.setData(undefined, (current) => {
        if (!current) return current;
        const order = new Map(itemIds.map((id, index) => [id, index]));
        return [...current]
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
          .map((item, index) => ({ ...item, sortOrder: index }));
      });
      return { previousItems };
    },
    onError: (error, _input, context) => {
      if (context?.previousItems) {
        trpcUtils.watchlist.list.setData(undefined, context.previousItems);
      }
      setStatusMessage(error.message);
    },
    onSettled: () => trpcUtils.watchlist.list.invalidate(),
  });

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) {
      setStatusMessage("Please log in to add symbols to your watchlist.");
      return;
    }
    const symbol = resolveAddSymbol({
      input: symbolInput,
      venue: addVenue,
      perpMarkets: perpUniverseQuery.data,
    });
    if (addVenue === "perps" && !symbol) {
      setStatusMessage(
        perpUniverseQuery.isLoading
          ? "Loading Hyperliquid markets..."
          : "Choose a currently listed Hyperliquid perpetual market.",
      );
      return;
    }
    if (!symbol) return;
    addMutation.mutate({ symbol, venue: addVenue });
  }

  function moveItem(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;

    const nextItems = [...items];
    const [moved] = nextItems.splice(index, 1);
    nextItems.splice(nextIndex, 0, moved);
    reorderMutation.mutate({ itemIds: nextItems.map((item) => item.id) });
  }

  return (
    <Card
      ref={panelRef}
      className={cn(
        "w-full",
        embedded
          ? "h-full min-h-0 gap-0 overflow-hidden rounded-none bg-transparent py-0 ring-0"
          : isCollapsed
            ? ""
            : "h-[600px]",
      )}
    >
      {/* Embedded (mobile) mode moves the organize/count controls inline with
          the search bar below, so it skips this header row entirely. */}
      {!embedded && (
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Watchlist</CardTitle>
              <CardDescription>Track symbols and send them into trading or AI research.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {items.length > 1 && (
                <Button
                  type="button"
                  variant={isOrganizing ? "secondary" : "ghost"}
                  size="icon-xs"
                  className="size-6"
                  title={isOrganizing ? "Done organizing" : "Organize watchlist"}
                  onClick={() => setIsOrganizing((v) => !v)}
                >
                  <ArrowUpDown className="h-3 w-3" />
                </Button>
              )}
              <Badge variant="outline">{items.length}</Badge>
              <CollapseButton collapsed={collapsed} onToggle={toggle} label="Watchlist" />
            </div>
          </div>
        </CardHeader>
      )}
      {!isCollapsed && (
      <CardContent
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3",
          embedded && "px-3 pb-3 pt-2",
        )}
      >
        <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Watchlist venue"
            className="flex h-8 shrink-0 rounded-md bg-muted p-0.5"
          >
            {(["stocks", "perps"] as const).map((venue) => (
              <Button
                key={venue}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={addVenue === venue}
                className={cn(
                  "h-7 px-2 text-2xs",
                  addVenue === venue && "bg-background text-foreground",
                )}
                onClick={() => {
                  setAddVenue(venue);
                  setSymbolInput("");
                }}
              >
                {venue === "stocks" ? "Stocks" : "Perps"}
              </Button>
            ))}
          </div>
          {addVenue === "stocks" ? (
            <SymbolSearchInput
              value={symbolInput}
              onChange={setSymbolInput}
              onPick={(symbol) => {
                setSymbolInput(symbol);
                if (!session) {
                  setStatusMessage("Please log in to add symbols to your watchlist.");
                  return;
                }
                addMutation.mutate({ symbol, venue: "stocks" });
              }}
              placeholder="Add stock..."
              ariaLabel="Add stock to watchlist"
            />
          ) : (
            <Input
              value={symbolInput}
              onChange={(event) => setSymbolInput(event.target.value)}
              placeholder="Add Hyperliquid market..."
              aria-label="Add perp to watchlist"
              className="h-8 min-w-40 flex-1 font-data uppercase"
            />
          )}
          <Button type="submit" size="icon" disabled={addMutation.isPending || !symbolInput.trim()} title="Add symbol">
            <Plus className="h-4 w-4" />
          </Button>
          {/* In embedded mode the organize + count controls live here, inline
              to the right of the search bar, instead of in a separate header. */}
          {embedded && (
            <>
              {items.length > 1 && (
                <Button
                  type="button"
                  variant={isOrganizing ? "secondary" : "ghost"}
                  size="icon"
                  className="shrink-0"
                  title={isOrganizing ? "Done organizing" : "Organize watchlist"}
                  onClick={() => setIsOrganizing((v) => !v)}
                >
                  <ArrowUpDown className="h-4 w-4" />
                </Button>
              )}
              <Badge variant="outline" className="shrink-0">
                {items.length}
              </Badge>
            </>
          )}
        </form>

        {!activeCredentialId && stockItems.length > 0 && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-2 text-xs text-muted-foreground">
            Connect Alpaca credentials for live quotes.
          </div>
        )}

        {statusMessage && (
          <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
            {statusMessage}
          </div>
        )}

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
            {watchlistQuery.isLoading && (
              <>
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </>
            )}

            {!watchlistQuery.isLoading && items.length === 0 && (
              <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed text-center text-sm text-muted-foreground">
                <LineChart className="mb-2 h-8 w-8 opacity-30" />
                <p>Your watchlist is empty.</p>
                <p className="text-xs">Choose Stocks or Perps above to add a market.</p>
              </div>
            )}

            {items.map((item, index) => {
              const isPerp = item.venue === "perps";
              const quote = isPerp ? undefined : quotesBySymbol.get(item.symbol);
              const perpStats = isPerp
                ? perpStatsQuery.data?.find((asset) => asset.coin === item.symbol)
                : undefined;
              const perpMid = perpStats?.markPx;
              const perpChange = formatPerpChangePct(
                perpStats?.markPx,
                perpStats?.prevDayPx,
              );
              const isSelected =
                activeVenue === item.venue &&
                (isPerp
                  ? selectedPerpSymbol === item.symbol
                  : selectedSymbol === item.symbol);
              const quoteMissing =
                !isPerp &&
                !!activeCredentialId &&
                quotesQuery.isSuccess &&
                !quotesQuery.isFetching &&
                !quote;
              const quoteFreshness = getQuoteFreshness({
                updatedAt: quote ? quotesQuery.dataUpdatedAt : undefined,
                isFetching: quotesQuery.isFetching,
                hasError: !!quotesQuery.error || quoteMissing,
                enabled: !!activeCredentialId,
              });
              const rowActions = buildWatchlistRowActions(
                { symbol: item.symbol, venue: item.venue },
                { onViewSymbol, onTradeSymbol, onAskAi },
                isOrganizing,
              );
              // The compact metric line, mobile only (see the `xl:hidden`
              // element below). Perps reuse the desktop HL Markets composer;
              // Alpaca reports equity volume as a grouped locale string, which
              // `stockRowMetrics` knows how to read.
              const rowMetrics = isPerp
                ? perpRowMetrics(perpStats)
                : stockRowMetrics(quote?.volume);
              return (
                <div
                  key={item.id}
                  className={cn(
                    // A flex shell so the mobile chart disclosure sits BESIDE
                    // both content lines instead of forcing the first line to
                    // be 44px tall on its own. On desktop that button is
                    // `xl:hidden`, leaving one flex-1 child, so the desktop
                    // card lays out exactly as it did as a block.
                    "group relative flex items-stretch gap-2 rounded-lg border bg-card/70 px-3 py-2 transition-colors hover:bg-muted/30 xl:py-3",
                    // Mobile selection is the left rail rendered below, not a
                    // ring: a 2px rule reads at a glance in a dense list and
                    // costs no row height, while `ring-2` haloes the whole
                    // card. Desktop keeps the ring it already had.
                    isSelected && "xl:ring-2 xl:ring-primary",
                    quoteFocus && "border-primary/30 bg-primary/5",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`View ${item.symbol} live chart`}
                    onClick={rowActions.onRowClick}
                    className="absolute inset-0 z-0 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />

                  {isSelected && (
                    <span
                      aria-hidden="true"
                      data-watchlist-row-rail="true"
                      className="pointer-events-none absolute inset-y-1.5 left-0 z-10 w-0.5 rounded-full bg-primary xl:hidden"
                    />
                  )}

                  {embedded && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="relative z-10 pointer-events-auto min-h-11 min-w-11 shrink-0 self-center gap-0.5 rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground xl:hidden"
                      aria-label={`Open ${item.symbol} chart`}
                      title={`Open ${item.symbol} chart`}
                      onClick={rowActions.onRowClick}
                    >
                      <LineChart className="h-4 w-4" aria-hidden="true" />
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}

                  <div className="min-w-0 flex-1">
                    {/* Row 1: symbol + change */}
                    <div className="relative z-10 pointer-events-none flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1">
                        {isOrganizing && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="pointer-events-auto size-9 shrink-0 sm:size-5"
                              title="Move up"
                              aria-label={`Move ${item.symbol} up`}
                              disabled={index === 0 || reorderMutation.isPending}
                              onClick={() => moveItem(index, -1)}
                            >
                              <ArrowUp className="h-3 w-3" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="pointer-events-auto size-9 shrink-0 sm:size-5"
                              title="Move down"
                              aria-label={`Move ${item.symbol} down`}
                              disabled={index === items.length - 1 || reorderMutation.isPending}
                              onClick={() => moveItem(index, 1)}
                            >
                              <ArrowDown className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                        <div className="flex min-w-0 items-center gap-1.5">
                          <LineChart
                            aria-hidden="true"
                            className={cn(
                              "size-3 shrink-0 text-muted-foreground/70",
                              embedded && "hidden xl:inline-flex",
                            )}
                          />
                          <span className="font-data text-sm font-semibold tracking-tight">
                            {item.symbol}
                          </span>
                          <Badge variant="outline" className="px-1 py-0 text-3xs uppercase">
                            {isPerp ? "Perp" : "Stock"}
                          </Badge>
                          {isSelected && <Badge variant="secondary" className="text-3xs px-1 py-0">Active</Badge>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-end gap-1.5 font-data text-xs tabular-nums leading-tight">
                        {isPerp ? (
                          <ChangeBadge
                            text={perpChange.text}
                            tone={perpChange.tone}
                          />
                        ) : activeCredentialId ? (
                          <>
                            <span className="text-muted-foreground">
                              {formatSignedNumber(quote?.change)}
                            </span>
                            <ChangeBadge {...formatChangePct(quote?.changePercent)} />
                          </>
                        ) : null}
                      </div>
                    </div>

                    {/* Row 2: price + action buttons */}
                    <div className="relative z-10 pointer-events-none flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-data text-sm tabular-nums text-muted-foreground sm:text-xs">
                          {isPerp ? (
                            PERPS_ENABLED ? (
                              perpMid ? (
                                // Perp marks span sub-cent coins; the adaptive
                                // perps formatter keeps their significant digits
                                // instead of collapsing them to "$0.00".
                                <LiveDataValue
                                  value={toFiniteNumber(perpMid)}
                                  format={formatPerpUsd}
                                  fallback="-"
                                />
                              ) : (
                                "Loading..."
                              )
                            ) : (
                              "Perps disabled"
                            )
                          ) : activeCredentialId ? (
                            quotesQuery.isFetching && !quote ? (
                              "Loading..."
                            ) : (
                              <LiveDataValue
                                value={toFiniteNumber(quote?.last)}
                                format={formatPriceUsd}
                                fallback="-"
                              />
                            )
                          ) : (
                            "-"
                          )}
                        </div>
                        <div
                          className={cn(
                            "mt-0.5 text-2xs font-medium",
                            quoteFreshnessClass(quoteFreshness.tone),
                          )}
                        >
                          {isPerp
                            ? !PERPS_ENABLED
                              ? "Enable perps to trade"
                              : !perpStatusQuery.data?.agentReady
                                ? "Set up perps to trade"
                                : null
                            : quoteFreshness.tone === "stale" || quoteFreshness.tone === "error"
                              ? quoteFreshness.label
                              : null}
                        </div>
                        {rowMetrics.length > 0 && (
                          // Mobile only, and deliberately inside the column the
                          // action buttons already make 36px tall: the row gains
                          // three numbers without gaining a pixel of height. The
                          // desktop card is untouched (`xl:hidden`), so this is
                          // not a desktop layout change smuggled in sideways.
                          // Max leverage is left off here, unlike the browse
                          // row: this column shares its line with the Trade /
                          // Ask AI / Remove cluster and a fourth metric would be
                          // clipped at 375px.
                          <div
                            data-watchlist-row-metrics="true"
                            className="mt-0.5 flex min-w-0 items-baseline gap-2 overflow-hidden text-3xs leading-4 tabular-nums text-muted-foreground xl:hidden"
                          >
                            {rowMetrics.map((metric) => (
                              <span
                                key={metric.key}
                                data-market-row-metric={metric.key}
                                className="shrink-0"
                              >
                                <span className="opacity-70">{metric.label}</span>{" "}
                                <span className="text-foreground/80">
                                  {metric.value}
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="pointer-events-auto flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 px-3 text-xs sm:h-6 sm:px-2"
                          aria-label={`Trade ${item.symbol}`}
                          title={`Trade ${item.symbol}`}
                          disabled={isPerp && (!PERPS_ENABLED || !perpStatusQuery.data?.agentReady)}
                          onClick={rowActions.onTradeClick}
                        >
                          Trade
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="size-9 sm:size-6"
                          title={`Ask AI about ${item.symbol}`}
                          aria-label={`Ask AI about ${item.symbol}`}
                          onClick={rowActions.onAskAiClick}
                        >
                          <Sparkles className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${item.symbol}`}
                          title={`Remove ${item.symbol}`}
                          disabled={removeMutation.isPending}
                          onClick={() => removeMutation.mutate({ itemId: item.id })}
                          className="size-9 text-muted-foreground hover:text-destructive sm:size-6"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {quotesQuery.error && activeCredentialId && stockItems.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                {quotesQuery.error.message}
              </div>
            )}
          </div>
        </div>
      </CardContent>
      )}
    </Card>
  );
}
