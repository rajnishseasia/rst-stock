"use client";

/**
 * The closed-order (stock/option trade history) list.
 *
 * Extracted verbatim out of positions-panel.tsx, which was well past the
 * god-component line (audit H7) and was also the ONLY place this list could be
 * reached from: it rendered exclusively behind that panel's Open | Closed
 * toggle. The desktop bottom drawer now has its own History tab, and history is
 * the same list on both surfaces rather than a second implementation of it.
 *
 * One deliberate change during the move: the list no longer takes a
 * `formatCurrency` prop. positions-panel handed it a locally declared
 * `Intl.NumberFormat`, which audit M16 bans; the shared `formatUsd` renders
 * identically (currency style, two fraction digits) and is the sanctioned
 * helper.
 */

import { useState } from "react";
import { AlertTriangle, BarChart2, Share2, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SharePnlModal } from "@/components/trade/share-pnl-modal";
import type { PositionsSortKey } from "@/components/trade/positions-panel-header";
import { formatUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";

/** Compact "time ago" (e.g. "12h", "3d") to keep history rows narrow. */
export function formatCompactAgo(d: Date): string {
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export interface ClosedOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  fillPrice: number | null;
  filledAt: string | null;
  submittedAt: string;
  status: string;
  orderType: string;
  assetClass: string;
  realizedPnl: number | null;
  copySourceLabel?: string | null;
}

/**
 * Order the history rows the same way the open list is ordered, so switching
 * between them does not reshuffle the reader's mental list.
 *
 * Pure, and exported so the ordering is assertable without a render.
 */
export function sortClosedOrders(
  orders: ClosedOrder[],
  sortBy: PositionsSortKey,
): ClosedOrder[] {
  return [...orders].sort((a, b) => {
    if (sortBy === "pnl") return (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0);
    if (sortBy === "value") return b.qty * (b.fillPrice ?? 0) - a.qty * (a.fillPrice ?? 0);
    // "date": newest first
    const aMs = new Date(a.filledAt ?? a.submittedAt).getTime();
    const bMs = new Date(b.filledAt ?? b.submittedAt).getTime();
    return bMs - aMs;
  });
}

export function ClosedOrdersList({
  isLoading,
  error,
  orders,
  sortBy,
  onViewChart,
  onTrade,
  canLoadMore = false,
  isLoadingMore = false,
  onLoadMore,
}: {
  isLoading: boolean;
  error: string | null;
  orders: ClosedOrder[];
  sortBy: PositionsSortKey;
  onViewChart?: (symbol: string) => void;
  onTrade?: (symbol: string) => void;
  canLoadMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading closed orders...</div>;
  }

  if (error) {
    const isSessionError = error.includes("Authentication required");
    return (
      <div className="py-8 text-center text-sm text-destructive flex flex-col items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {isSessionError
          ? "Your session expired. Refresh the page to sign in again."
          : error}
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No closed orders yet
      </div>
    );
  }

  const sorted = sortClosedOrders(orders, sortBy);

  return (
    <div className="space-y-1.5">
      {sorted.map((order) => (
        <ClosedOrderRow
          key={order.id}
          order={order}
          onViewChart={onViewChart}
          onTrade={onTrade}
        />
      ))}
      {canLoadMore && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}

function ClosedOrderRow({
  order,
  onViewChart,
  onTrade,
}: {
  order: ClosedOrder;
  onViewChart?: (symbol: string) => void;
  onTrade?: (symbol: string) => void;
}) {
  const [showShareModal, setShowShareModal] = useState(false);
  const sharePnlMutation = trpc.pnlImage.generateClosedOrder.useMutation();
  const isBuy = order.side === "buy";
  const isFilled = order.status === "filled";

  // Prefer the fill timestamp; fall back to submit time. Guard against bad dates.
  // Use a compact form ("12h", "3d") so a long "about 12 hours ago" can't crowd
  // the row and overlap the P&L on a narrow panel.
  const tsRaw = order.filledAt ?? order.submittedAt;
  let relativeTime = "";
  if (tsRaw) {
    const d = new Date(tsRaw);
    if (!Number.isNaN(d.getTime())) {
      relativeTime = formatCompactAgo(d);
    }
  }

  // Only orders that closed a position carry realized P&L (see the API's
  // computeRealizedPnlByOrder). Opening fills leave this null.
  const pnl = order.realizedPnl;
  const hasPnl = pnl != null;
  const pnlUp = hasPnl && pnl >= 0;

  // A shareable card needs the closing fill's price/qty alongside the P&L.
  const canShare = hasPnl && order.fillPrice != null && order.qty > 0;

  return (
    <div className="premium-panel flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={`font-medium uppercase shrink-0 ${isBuy ? "text-green-500" : "text-destructive"}`}
        >
          {order.side}
        </span>
        {/* Symbol + qty/price as one truncating unit so it can never overflow
            into the P&L on the right on a narrow panel. */}
        <span className="min-w-0 truncate">
          <span className="font-medium">{order.symbol}</span>{" "}
          <span className="text-muted-foreground">
            ×{order.qty}
            {order.fillPrice != null && (
              <>
                {" @ "}
                <span className="font-data tabular-nums">{formatUsd(order.fillPrice)}</span>
              </>
            )}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {hasPnl && (
          <span
            className={`font-data tabular-nums text-xs font-medium whitespace-nowrap ${
              pnlUp ? "text-green-500" : "text-destructive"
            }`}
          >
            {pnlUp ? "+" : "-"}
            {formatUsd(Math.abs(pnl))}
          </span>
        )}
        {relativeTime && (
          <span className="hidden text-xs text-muted-foreground whitespace-nowrap sm:inline">{relativeTime}</span>
        )}
        <Badge
          variant={isFilled ? "secondary" : "outline"}
          className={`text-xs ${isFilled ? "" : "text-muted-foreground"}`}
        >
          {order.status.replace(/_/g, " ")}
        </Badge>
        {order.copySourceLabel && (
          <Badge
            variant="outline"
            className="text-xs border-primary/40 text-primary/80 whitespace-nowrap"
            title={`Auto-mirrored from ${order.copySourceLabel}`}
          >
            Copied · {order.copySourceLabel}
          </Badge>
        )}
        {onViewChart && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onViewChart(order.symbol)}
            aria-label={`View ${order.symbol} chart`}
            title="View chart"
          >
            <BarChart2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {onTrade && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onTrade(order.symbol)}
            aria-label={`Trade ${order.symbol}`}
            title="Trade"
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
        )}
        {canShare && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setShowShareModal(true)}
            aria-label={`Share ${order.symbol} P&L`}
          >
            <Share2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {canShare && (
        <SharePnlModal
          open={showShareModal}
          symbol={order.symbol}
          onClose={() => setShowShareModal(false)}
          generate={(hideAmount) =>
            sharePnlMutation.mutateAsync({
              symbol: order.symbol,
              side: order.side,
              qty: order.qty,
              fillPrice: order.fillPrice!,
              realizedPnl: pnl!,
              assetClass: order.assetClass,
              hideAmount,
            })
          }
        />
      )}
    </div>
  );
}
