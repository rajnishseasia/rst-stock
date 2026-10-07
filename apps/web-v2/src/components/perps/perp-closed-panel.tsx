"use client";

/**
 * PerpClosedPanel: the perps "Closed" tab.
 *
 * One row per completed round-trip rather than per execution, folded out of
 * the same `positions.listPerpFills` feed the History tab reads (see
 * `perp-closed-positions.ts` for the fold). The column that justifies the tab
 * is "Closed by": it is the only place in the product that says a stop-loss,
 * rather than the user, ended a position.
 *
 * Reuses the table chrome, P&L tone tokens and `formatPerpPx` / `formatPerpUsd`
 * idiom from `PerpFillsPanel` so Positions, Closed and History read as one
 * system.
 */

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  formatPerpNotionalUsd,
  formatPerpPx,
  formatPerpUsd,
} from "@/components/perps/perp-format";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";
import {
  CLOSED_POSITION_FILL_SCAN,
  closedPerpPositions,
  type ClosedPositionReason,
} from "@/components/perps/perp-closed-positions";
import type { PositionsSortKey } from "@/components/trade/positions-panel-header";

/**
 * Re-exported for this panel's own tests and call sites. It lives beside the
 * walk in `perp-closed-positions` because every surface that reconstructs runs
 * has to ask for the same window; see the constant's own doc.
 */
export { CLOSED_POSITION_FILL_SCAN };

export interface PerpClosedPanelProps {
  /** Whether perps have been enabled (gates the query). */
  enabled: boolean;
  /** Whether this tab is the visible one. Hidden tabs must not poll. */
  active?: boolean;
  /** Select this position's canonical coin in the perpetual chart. */
  onViewChart?: (coin: string) => void;
  /**
   * Render order, shared with the open list so the header's sort control means
   * the same thing on both sides of the Open | Closed toggle. "date" keeps the
   * fold's own newest-first order.
   */
  sortBy?: PositionsSortKey;
  /**
   * Render the rows only, without this panel's own full-height scroll wrapper.
   * Set when the closed list is shown INSIDE the positions panel's Closed
   * view, whose card content already scrolls; a nested scroller there would
   * give the drawer two scrollbars.
   */
  bare?: boolean;
}

const REASON_LABEL: Record<ClosedPositionReason, string> = {
  stop_loss: "Stop loss",
  take_profit: "Take profit",
  liquidation: "Liquidated",
  manual: "Manual",
  unknown: "At venue",
};

const REASON_CLASS: Record<ClosedPositionReason, string> = {
  stop_loss: "bg-red-500/15 text-red-400",
  take_profit: "bg-green-500/15 text-green-400",
  liquidation: "bg-red-500/25 text-red-300",
  manual: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function PerpClosedPanel({
  enabled,
  active = true,
  onViewChart,
  sortBy = "date",
  bare = false,
}: PerpClosedPanelProps) {
  const fillsQuery = trpc.positions.listPerpFills.useQuery(
    { limit: CLOSED_POSITION_FILL_SCAN },
    {
      enabled: enabled && active,
      refetchInterval: active ? 30_000 : false,
      staleTime: 15_000,
      retry: false,
    },
  );

  const positions = useMemo(() => {
    const rows = closedPerpPositions(fillsQuery.data?.fills ?? []);
    if (sortBy === "date") return rows;
    return [...rows].sort((a, b) => {
      if (sortBy === "pnl") return b.realizedPnl - a.realizedPnl;
      return (
        Math.abs(Number(b.sizeCoin) * Number(b.avgClosePx)) -
        Math.abs(Number(a.sizeCoin) * Number(a.avgClosePx))
      );
    });
  }, [fillsQuery.data, sortBy]);

  if (!enabled) {
    const notice = (
      <div className="px-3 py-4 text-sm text-muted-foreground">
        Set up perpetual futures in the Trade panel to view closed positions.
      </div>
    );
    if (bare) return notice;
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="min-h-0 flex-1 overflow-y-auto">{notice}</div>
      </div>
    );
  }

  const content = (
    <>
      {fillsQuery.isLoading ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Loading closed positions...
          </div>
        ) : fillsQuery.error ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {fillsQuery.error.message}
          </div>
        ) : positions.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No closed perp positions yet.
          </div>
        ) : (
          // One table, two layouts, decided by the container's own width (the
          // same @container idiom as the open perp positions table). Below
          // 720px, which is every phone and the narrower desktop drawers, a
          // row is Coin | Realized PnL with the close time, size, close price
          // and fee stacked under the coin, so nothing needs a sideways
          // scroll. The old fixed 760px minimum width was cut off inside the
          // positions panel's Closed view, whose content box is
          // `overflow-x-hidden`: on a 390px phone the size, close price,
          // realized PnL and fee columns were simply unreachable.
          <div className="@container/perpclosed min-w-0">
          <table className="w-full table-fixed border-collapse text-xs @[720px]/perpclosed:table-auto @[720px]/perpclosed:text-sm">
            <thead className="sticky top-0 z-10 bg-background/95 text-3xs uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr className="border-b">
                <th className="hidden px-2 py-1.5 text-left font-medium @[720px]/perpclosed:table-cell">Closed</th>
                <th className="w-[62%] px-2 py-1.5 text-left font-medium @[720px]/perpclosed:w-auto">Coin</th>
                <th className="hidden px-2 py-1.5 text-left font-medium @[720px]/perpclosed:table-cell">Side</th>
                <th className="hidden px-2 py-1.5 text-left font-medium @[720px]/perpclosed:table-cell">Closed by</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[720px]/perpclosed:table-cell">Size</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[720px]/perpclosed:table-cell">Avg close</th>
                <th className="w-[38%] px-2 py-1.5 text-right font-medium @[720px]/perpclosed:w-auto">Realized PnL</th>
                <th className="hidden px-2 py-1.5 text-right font-medium @[720px]/perpclosed:table-cell">Fee</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const coin = perpDisplayCoin(position.coin);
                const pnlTone =
                  position.realizedPnl === 0
                    ? "neutral"
                    : position.realizedPnl > 0
                      ? "positive"
                      : "negative";
                const closedAt = formatTime(position.closedAt);
                const sizeCoinLabel = `${position.sizeCoin} ${coin}`;
                const sizeUsd = formatPerpNotionalUsd(
                  position.sizeCoin,
                  position.avgClosePx,
                );
                const avgClose = formatPerpPx(position.avgClosePx);
                const fee = formatPerpUsd(position.feeUsd);
                // Rendered twice on purpose: inline beside the coin in the
                // stacked phone row, and in their own cells from 720px up.
                // Only one of the two is displayed at any width.
                const renderSideBadge = () => (
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-3xs font-semibold uppercase",
                      position.side === "long"
                        ? "bg-green-500/15 text-green-400"
                        : "bg-red-500/15 text-red-400",
                    )}
                  >
                    {position.side}
                  </span>
                );
                const renderReasonBadge = () => (
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-3xs font-semibold",
                      REASON_CLASS[position.closedBy],
                    )}
                  >
                    {REASON_LABEL[position.closedBy]}
                  </span>
                );
                return (
                  <tr
                    key={position.id}
                    className="border-b transition-colors hover:bg-accent/40"
                  >
                    <td className="hidden whitespace-nowrap px-2 py-2 text-left font-data tabular-nums text-muted-foreground @[720px]/perpclosed:table-cell">
                      {closedAt}
                    </td>
                    <td className="min-w-0 px-2 py-2 text-left align-top @[720px]/perpclosed:align-middle">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {onViewChart ? (
                          <button
                            type="button"
                            onClick={() => onViewChart(position.coin)}
                            className="min-h-11 font-data font-semibold hover:underline @[720px]/perpclosed:min-h-0"
                            aria-label={`View the ${coin} chart`}
                          >
                            {coin}
                          </button>
                        ) : (
                          <span className="font-data font-semibold">{coin}</span>
                        )}
                        {position.partial ? (
                          <span
                            className="text-3xs text-muted-foreground"
                            title="This position opened before the visible fill history, so its entry is not shown."
                          >
                            partial
                          </span>
                        ) : null}
                        <span className="flex items-center gap-1.5 @[720px]/perpclosed:hidden">
                          {renderSideBadge()}
                          {renderReasonBadge()}
                        </span>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-data text-3xs leading-tight text-muted-foreground @[720px]/perpclosed:hidden">
                        <span className="flex justify-between gap-1">
                          <span>Closed</span>
                          <span className="text-foreground">{closedAt}</span>
                        </span>
                        <span className="flex justify-between gap-1" title={sizeCoinLabel}>
                          <span>Size</span>
                          <span className="text-foreground">{sizeUsd}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Avg close</span>
                          <span className="text-foreground">{avgClose}</span>
                        </span>
                        <span className="flex justify-between gap-1">
                          <span>Fee</span>
                          <span className="text-foreground">{fee}</span>
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-2 py-2 text-left @[720px]/perpclosed:table-cell">
                      {renderSideBadge()}
                    </td>
                    <td className="hidden px-2 py-2 text-left @[720px]/perpclosed:table-cell">
                      {renderReasonBadge()}
                    </td>
                    <td
                      className="hidden px-2 py-2 text-right font-data tabular-nums @[720px]/perpclosed:table-cell"
                      title={sizeCoinLabel}
                    >
                      {sizeUsd}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums @[720px]/perpclosed:table-cell">
                      {avgClose}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-right align-top font-data tabular-nums @[720px]/perpclosed:align-middle",
                        pnlTone === "positive" && "text-green-400",
                        pnlTone === "negative" && "text-red-400",
                      )}
                    >
                      {formatPerpUsd(position.realizedPnl)}
                    </td>
                    <td className="hidden px-2 py-2 text-right font-data tabular-nums text-muted-foreground @[720px]/perpclosed:table-cell">
                      {fee}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
    </>
  );

  if (bare) return content;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto">{content}</div>
    </div>
  );
}
