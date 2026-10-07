"use client";

/**
 * PerpSymbolUniverse — the left-rail HL coin list for the perps terminal.
 *
 * Sources the Hyperliquid universe with live market data (coin / maxLeverage /
 * mark price / 24h change / volume / open interest / funding) from
 * `trpc.hyperliquid.marketStats` and lets the user pick the active coin. Prices
 * poll on a light interval so the list stays live without a per-coin snapshot
 * fan-out. The 24h change is derived on the client from mark vs previous-day
 * price via the shared `perp-format` helpers, and every row carries the same
 * three-metric line (see `perp-market-row.ts`) regardless of the active sort.
 */

import { useMemo, useState } from "react";

import {
  formatPerpChangePct,
  formatPerpPx,
} from "@/components/perps/perp-format";
import { perpMarketRowMetrics } from "@/components/perps/perp-market-row";
import {
  sortPerpMarkets,
  type PerpMarketSort,
} from "@/components/perps/perp-market-sort";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ChangeBadge } from "@/components/ui/change-badge";

export interface PerpSymbolUniverseProps {
  activeCoin: string;
  onSelect: (coin: string) => void;
}

export function PerpSymbolUniverse({ activeCoin, onSelect }: PerpSymbolUniverseProps) {
  const statsQuery = trpc.hyperliquid.marketStats.useQuery(undefined, {
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<PerpMarketSort>("volume");

  const coins = useMemo(() => {
    const universe = statsQuery.data ?? [];
    const needle = filter.trim().toUpperCase();
    const filtered = needle
      ? universe.filter((asset) => asset.coin.toUpperCase().includes(needle))
      : universe;
    return sortPerpMarkets(filtered, sort);
  }, [statsQuery.data, filter, sort]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b px-3 py-2">
        <div className="text-3xs uppercase tracking-wide text-muted-foreground">
          Markets
        </div>
        <div className="mt-1 flex gap-1.5">
          <input
            type="text"
            inputMode="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search coins"
            aria-label="Search perp markets"
            className="h-8 min-w-0 flex-1 rounded-md border bg-muted/50 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Select
            value={sort}
            onValueChange={(value) => setSort(value as PerpMarketSort)}
          >
            <SelectTrigger
              aria-label="Sort perp markets"
              className="h-8 w-[7.25rem] shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="volume">24h volume</SelectItem>
              <SelectItem value="open-interest">Open interest</SelectItem>
              <SelectItem value="gainers">Top gainers</SelectItem>
              <SelectItem value="losers">Top losers</SelectItem>
              <SelectItem value="symbol">Symbol A-Z</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {statsQuery.isLoading ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">Loading markets…</div>
        ) : coins.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">No markets found.</div>
        ) : (
          <ul>
            {coins.map((asset) => {
              const isActive = asset.coin.toUpperCase() === activeCoin.toUpperCase();
              const change = formatPerpChangePct(asset.markPx, asset.prevDayPx);
              const metrics = perpMarketRowMetrics(asset);
              return (
                <li key={asset.coin}>
                  <button
                    type="button"
                    onClick={() => onSelect(asset.coin)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/40",
                      isActive && "bg-accent/60 text-foreground",
                    )}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-data font-semibold">
                          {asset.coin}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1 py-px text-3xs font-medium tabular-nums text-muted-foreground">
                          {asset.maxLeverage}x
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                        <span className="text-xs text-foreground">
                          {formatPerpPx(asset.markPx)}
                        </span>
                        <ChangeBadge
                          size="sm"
                          text={change.text}
                          tone={change.tone}
                        />
                      </span>
                    </span>
                    {/* Fixed three-metric line: the same axes on every row at
                        every sort, so two coins can be compared without
                        re-sorting the list. Spans the full row width rather
                        than sitting under the coin, because a wide funding
                        rate would otherwise wrap against the price column. */}
                    <span className="flex w-full min-w-0 items-baseline gap-2.5 overflow-hidden text-3xs tabular-nums text-muted-foreground">
                      {metrics.map((metric) => (
                        <span
                          key={metric.key}
                          className="min-w-0 truncate"
                          data-perp-market-metric={metric.key}
                        >
                          <span className="text-muted-foreground/70">
                            {metric.label}
                          </span>{" "}
                          {metric.value}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
