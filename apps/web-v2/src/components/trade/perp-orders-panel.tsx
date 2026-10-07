"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { formatPerpNotionalUsd, formatPerpPx } from "@/components/perps/perp-format";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";

export interface PerpOrdersPanelProps {
  enabled: boolean;
  onViewChart?: (coin: string) => void;
}

/** Hyperliquid resting entry orders and protective exits for the active user. */
export function PerpOrdersPanel({
  enabled,
  onViewChart,
}: PerpOrdersPanelProps) {
  const utils = trpc.useUtils();
  const ordersQuery = trpc.positions.listPerpOpenOrders.useQuery(undefined, {
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
  const cancelMutation = trpc.orders.cancelPerp.useMutation({
    onSuccess: () => {
      toast.success("Order cancelled");
      void utils.positions.listPerpOpenOrders.invalidate();
      void utils.positions.listPerps.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (!enabled) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Set up Hyperliquid to view perp orders and exits.
      </div>
    );
  }
  if (ordersQuery.isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading Hyperliquid orders...
      </div>
    );
  }
  if (ordersQuery.error) {
    return (
      <div className="p-4 text-sm text-destructive">
        {ordersQuery.error.message}
      </div>
    );
  }

  const orders = ordersQuery.data?.orders ?? [];
  if (orders.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No open Hyperliquid orders.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-2">
      <div className="mb-2 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
        Hyperliquid orders & exits
      </div>
      <div className="space-y-2">
        {orders.map((order) => (
          <div
            key={order.oid}
            className="rounded-md border bg-card/70 p-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="font-data font-semibold hover:text-primary"
                onClick={() => onViewChart?.(order.coin)}
              >
                {perpDisplayCoin(order.coin)}
              </button>
              <span className="uppercase text-muted-foreground">
                {order.side} · {order.orderType}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-muted-foreground">
              <span title={`${order.sz} ${perpDisplayCoin(order.coin)}`}>
                {formatPerpNotionalUsd(order.sz, order.triggerPx ?? order.limitPx)} @{" "}
                {formatPerpPx(order.triggerPx ?? order.limitPx)}
                {order.reduceOnly ? " · Reduce only" : ""}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-destructive"
                disabled={cancelMutation.isPending}
                onClick={() =>
                  cancelMutation.mutate({
                    coin: order.coin,
                    orderId: order.oid,
                  })
                }
              >
                Cancel
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
