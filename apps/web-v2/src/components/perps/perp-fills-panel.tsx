"use client";

/**
 * PerpFillsPanel: the perps trade-history (fills) table.
 *
 * Rows show time / coin / side / size / price / realized PnL / fee for recent
 * Hyperliquid fills, sourced from `trpc.positions.listPerpFills` on a 30s poll.
 * Reuses the table chrome, P&L color tokens, and the shared `perp-format`
 * helpers so positions and history read as one system.
 */

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  formatPerpNotionalUsd,
  formatPerpPx as formatPx,
  formatPerpUsd as formatUsd,
} from "@/components/perps/perp-format";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";

export interface PerpFillsPanelProps {
  /** Whether perps have been enabled (gates the query). The wallet address is
   * resolved server-side from the user's credential, so the client never needs
   * it. */
  enabled: boolean;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
}

export function PerpFillsPanel({ enabled }: PerpFillsPanelProps) {
  const fillsQuery = trpc.positions.listPerpFills.useQuery(
    { limit: 100 },
    {
      enabled,
      refetchInterval: 30_000,
      staleTime: 15_000,
      retry: false,
    },
  );

  const fills = useMemo(() => fillsQuery.data?.fills ?? [], [fillsQuery.data]);

  if (!enabled) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 text-sm text-muted-foreground">
          Set up perpetual futures in the Trade panel to view trade history.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto">
        {fillsQuery.isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Loading trade history...
          </div>
        ) : fillsQuery.error ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {fillsQuery.error.message}
          </div>
        ) : fills.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No perp fills yet.
          </div>
        ) : (
          // Same two-layout table as the Closed tab: below 720px of container
          // width (every phone, and the mobile Portfolio > Perps surface that
          // hosts this) a fill is Coin | PnL with the time, size, price and fee
          // stacked under the coin. The old 720px minimum width turned this
          // into a sideways-scrolling strip on a 390px phone.
          <div className="@container/perpfills min-w-0">
          <table className="w-full table-fixed border-collapse text-xs @[720px]/perpfills:table-auto @[720px]/perpfills:text-sm">
            <thead className="sticky top-0 z-10 bg-background/95 text-3xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr className="border-b">
                <th className="hidden px-2 py-1.5 text-left font-medium @[720px]/perpfills:table-cell">Time</th>
                <th className="w-[62%] px-2 py-1.5 text-left font-medium @[720px]/perpfills:w-auto">Coin</th>
                <th className="hidden px-2 py-1.5 text-left font-medium @[720px]/perpfills:table-cell">Side</th>
                <th className="hidden px-2 py-1.5 text-left font-medium @[720px]/perpfills:table-cell">Type</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[720px]/perpfills:table-cell">Size</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[720px]/perpfills:table-cell">Price</th>
                <th className="w-[38%] px-2 py-1.5 text-right font-medium @[720px]/perpfills:w-auto">PnL</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[720px]/perpfills:table-cell">Fee</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((fill) => {
                const pnl = Number(fill.closedPnl);
                const pnlTone =
                  !Number.isFinite(pnl) || pnl === 0
                    ? "neutral"
                    : pnl > 0
                      ? "positive"
                      : "negative";
                const orderType = fill.orderType;
                const isSl = orderType === "StopMarket" || orderType === "StopLimit";
                const isTp = orderType === "TakeProfitMarket" || orderType === "TakeProfitLimit";
                const coin = perpDisplayCoin(fill.coin);
                const time = formatTime(fill.time);
                const sizeCoinLabel = `${fill.sz} ${coin}`;
                const sizeUsd = formatPerpNotionalUsd(fill.sz, fill.px);
                const price = formatPx(fill.px);
                const fee = formatUsd(fill.fee);
                // Rendered twice on purpose: inline in the stacked phone row,
                // and in their own cells from 720px up. Only one is displayed.
                const renderSideBadge = () => (
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-3xs font-semibold uppercase",
                      fill.side === "buy"
                        ? "bg-green-500/15 text-green-400"
                        : "bg-red-500/15 text-red-400",
                    )}
                  >
                    {fill.side}
                  </span>
                );
                const renderTypeBadge = () =>
                  isSl ? (
                    <span className="rounded px-1 py-0.5 text-3xs font-semibold bg-red-500/15 text-red-400">
                      SL
                    </span>
                  ) : isTp ? (
                    <span className="rounded px-1 py-0.5 text-3xs font-semibold bg-green-500/15 text-green-400">
                      TP
                    </span>
                  ) : (
                    <span className="text-3xs text-muted-foreground">-</span>
                  );
                return (
                  <tr
                    key={`${fill.hash}-${fill.tid}`}
                    className="border-b transition-colors hover:bg-accent/40"
                  >
                    <td className="hidden whitespace-nowrap px-2 py-2 text-left font-data tabular-nums text-muted-foreground @[720px]/perpfills:table-cell">
                      {time}
                    </td>
                    <td className="min-w-0 px-2 py-2 text-left align-top @[720px]/perpfills:align-middle">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span className="font-data font-semibold">{coin}</span>
                        <span className="text-3xs text-muted-foreground">
                          {fill.dir}
                        </span>
                        <span className="flex items-center gap-1.5 @[720px]/perpfills:hidden">
                          {renderSideBadge()}
                          {(isSl || isTp) && renderTypeBadge()}
                        </span>
                      </div>
                      <div className="mt-1 grid min-w-0 grid-cols-1 gap-x-3 gap-y-0.5 font-data text-3xs leading-tight text-muted-foreground @[560px]/perpfills:grid-cols-2 @[720px]/perpfills:hidden">
                        <span className="flex min-w-0 justify-between gap-1">
                          <span className="shrink-0">Time</span>
                          <span className="min-w-0 break-words text-right text-foreground">{time}</span>
                        </span>
                        <span className="flex min-w-0 justify-between gap-1" title={sizeCoinLabel}>
                          <span className="shrink-0">Size</span>
                          <span className="min-w-0 break-words text-right text-foreground">{sizeUsd}</span>
                        </span>
                        <span className="flex min-w-0 justify-between gap-1">
                          <span className="shrink-0">Price</span>
                          <span className="min-w-0 break-words text-right text-foreground">{price}</span>
                        </span>
                        <span className="flex min-w-0 justify-between gap-1">
                          <span className="shrink-0">Fee</span>
                          <span className="min-w-0 break-words text-right text-foreground">{fee}</span>
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-2 py-2 text-left @[720px]/perpfills:table-cell">
                      {renderSideBadge()}
                    </td>
                    <td className="hidden px-2 py-2 text-left @[720px]/perpfills:table-cell">
                      {renderTypeBadge()}
                    </td>
                    <td
                      className="hidden px-2 py-2 text-right font-data tabular-nums @[720px]/perpfills:table-cell"
                      title={sizeCoinLabel}
                    >
                      {sizeUsd}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums @[720px]/perpfills:table-cell">
                      {price}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-right align-top font-data tabular-nums break-words @[720px]/perpfills:align-middle",
                        pnlTone === "positive" && "text-green-400",
                        pnlTone === "negative" && "text-red-400",
                      )}
                    >
                      {Number.isFinite(pnl) && pnl !== 0 ? formatUsd(pnl) : "-"}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums text-muted-foreground @[720px]/perpfills:table-cell">
                      {fee}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
