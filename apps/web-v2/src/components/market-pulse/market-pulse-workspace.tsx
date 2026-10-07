"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Clock3, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MarketPulseBrief } from "./market-pulse-brief";
import { MarketPulseHeatmap } from "./market-pulse-heatmap";
import { MarketPulseRankings } from "./market-pulse-rankings";
import type { MarketPulseActions } from "./market-pulse-types";
import { getPulseFreshness } from "./market-pulse-utils";

type MarketPulseWorkspaceProps = MarketPulseActions & {
  perpsEnabled: boolean;
};

function formatAsOf(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function MarketPulseLoading() {
  return (
    <div className="premium-pane min-h-[34rem] overflow-hidden rounded-md" aria-busy="true" aria-label="Loading market pulse">
      <div className="flex h-11 items-center justify-between border-b border-border px-3 sm:px-4">
        <div className="flex items-center gap-2 text-xs font-semibold"><RefreshCw className="size-3 animate-spin" />Loading market pulse</div>
        <Skeleton className="h-5 w-24 rounded-sm" />
      </div>
      <div className="grid gap-4 border-b border-border p-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-2"><Skeleton className="h-3 w-20 rounded-sm" /><Skeleton className="h-6 w-3/4 rounded-sm" /><Skeleton className="h-3 w-full rounded-sm" /><Skeleton className="h-3 w-5/6 rounded-sm" /></div>
        <div className="space-y-2"><Skeleton className="h-3 w-16 rounded-sm" /><Skeleton className="h-8 w-full rounded-sm" /><Skeleton className="h-8 w-full rounded-sm" /></div>
      </div>
      <div className="grid border-b border-border lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="m-3 h-56 rounded-sm" />)}
      </div>
      <div className="grid grid-cols-6 gap-1.5 p-3 md:grid-cols-12">
        {Array.from({ length: 12 }, (_, index) => <Skeleton key={index} className="col-span-3 h-20 rounded-md" />)}
      </div>
    </div>
  );
}

function MarketPulseError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="premium-pane flex min-h-72 flex-col items-center justify-center rounded-md px-5 text-center" role="alert">
      <div className="mb-3 flex size-9 items-center justify-center rounded-md border border-red-500/30 bg-loss-tint text-red-500">
        <WifiOff className="size-4" aria-hidden="true" />
      </div>
      <h2 className="text-sm font-semibold">Market Pulse unavailable</h2>
      <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        <RefreshCw className="size-3" aria-hidden="true" />
        Retry
      </Button>
    </section>
  );
}

export function MarketPulseWorkspace({
  onViewMarket,
  onTradeMarket,
  perpsEnabled,
}: MarketPulseWorkspaceProps) {
  const [venue, setVenue] = useState<"stocks" | "perps">("stocks");
  const [now, setNow] = useState(() => Date.now());
  const overviewQuery = trpc.marketPulse.overview.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
  });
  const overview = overviewQuery.data;

  useEffect(() => {
    if (!overview) return;
    const staleAt = Date.parse(overview.meta.staleAfter);
    setNow(Date.now());
    if (!Number.isFinite(staleAt)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, staleAt - Date.now()) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [overview, overviewQuery.dataUpdatedAt]);

  if (overviewQuery.isLoading && !overview) return <MarketPulseLoading />;
  if (!overview) {
    return (
      <MarketPulseError
        message={overviewQuery.error?.message ?? "No market data was returned. Please try again."}
        onRetry={() => void overviewQuery.refetch()}
      />
    );
  }

  const isStale = getPulseFreshness(overview.meta, new Date(now)) === "stale";
  const isPartial = overview.meta.status === "partial";
  const isUnavailable = overview.meta.status === "unavailable";
  const hasBackgroundError = overviewQuery.isError;
  const heatmap = venue === "stocks" ? overview.stocks.heatmap : overview.perps.heatmap;

  return (
    <div className="premium-pane premium-panel-enter min-w-0 overflow-hidden rounded-md bg-[#090b0e] text-foreground">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-[#0c0f13] px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-primary/35 bg-primary/10 text-primary">
            <Wifi className="size-3" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xs font-semibold uppercase text-foreground">Market Pulse</h1>
            <p className="truncate font-data text-3xs tabular-nums text-muted-foreground">
              AS OF {formatAsOf(overview.meta.asOf)} / {overview.meta.cacheState.toUpperCase()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 font-data text-3xs font-semibold uppercase",
              overviewQuery.isFetching && "border-sky-900/60 bg-sky-950/40 text-sky-300",
              !overviewQuery.isFetching && !isStale && !isPartial && !isUnavailable && !hasBackgroundError && "border-green-500/30 bg-gain-tint text-green-500",
              !overviewQuery.isFetching && (isStale || isPartial || isUnavailable || hasBackgroundError) && "border-amber-900/60 bg-amber-950/40 text-amber-300",
            )}
          >
            {overviewQuery.isFetching ? <RefreshCw className="size-2.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
            {overviewQuery.isFetching ? "Updating" : isUnavailable ? "Unavailable" : isPartial ? "Partial" : isStale || hasBackgroundError ? "Stale" : "Live"}
          </span>
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => void overviewQuery.refetch()} aria-label="Refresh market pulse" title="Refresh market pulse">
            <RefreshCw className={cn("size-3", overviewQuery.isFetching && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>
      </header>

      {(isPartial || isUnavailable || isStale || hasBackgroundError || overview.warnings.length > 0) && (
        <div className="flex items-start gap-2 border-b border-amber-900/50 bg-amber-950/25 px-3 py-2 text-2xs leading-4 text-amber-200 sm:px-4" role="status">
          {isStale || hasBackgroundError ? <Clock3 className="mt-0.5 size-3 shrink-0" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />}
          <span>
            {hasBackgroundError
              ? "Refresh failed. Showing the last available market snapshot."
              : isStale
                ? "This market snapshot is past its freshness window. Refreshing data may still be in progress."
                : isUnavailable
                  ? "Live market sources are unavailable. Rankings may be empty."
                  : isPartial
                    ? "Some market sources are unavailable. Available rankings remain actionable."
                    : overview.warnings[0]}
            {overview.warnings.length > 0 && (isPartial || isUnavailable || isStale || hasBackgroundError)
              ? ` ${overview.warnings.join(" ")}`
              : ""}
          </span>
        </div>
      )}

      <MarketPulseBrief brief={overview.brief} />
      <MarketPulseRankings
        overview={overview}
        venue={venue}
        perpsEnabled={perpsEnabled}
        onVenueChange={setVenue}
        onViewMarket={onViewMarket}
        onTradeMarket={onTradeMarket}
      />
      <MarketPulseHeatmap
        items={heatmap}
        venue={venue}
        onViewMarket={onViewMarket}
        onTradeMarket={onTradeMarket}
      />
    </div>
  );
}
