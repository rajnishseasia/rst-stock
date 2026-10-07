"use client";

/**
 * Stock/option trade history as a standalone panel.
 *
 * The desktop bottom drawer's History tab. It is the SAME list the positions
 * panel shows behind its Open | Closed toggle (`ClosedOrdersList`, fed by
 * `useClosedOrders`), not a second implementation: history was previously
 * reachable only by first opening Positions and then flipping that toggle,
 * which is two steps for the second-most-asked question about an account.
 *
 * Scroll classes are `xl:`-gated, matching the embedded positions panel. The
 * drawer that hosts this exists only at `xl`; on any narrower surface the page
 * owns the single scroll region and this panel must not open a nested one.
 */

import { BarChart2 } from "lucide-react";

import { ClosedOrdersList } from "@/components/trade/closed-orders-list";
import { useClosedOrders } from "@/components/trade/closed-orders-query";
import type { PositionsSortKey } from "@/components/trade/positions-panel-header";
import { EmptyState } from "@/components/ui/empty-state";

export function ClosedOrdersPanel({
  isSignedIn,
  activeCredentialId,
  credentialsLoading = false,
  sortBy = "date",
  onViewChart,
  onTrade,
}: {
  isSignedIn: boolean;
  activeCredentialId?: string;
  /** True while saved credentials are still loading, so no account is known yet. */
  credentialsLoading?: boolean;
  /** History is newest-first unless a host surface says otherwise. */
  sortBy?: PositionsSortKey;
  onViewChart?: (symbol: string) => void;
  onTrade?: (symbol: string) => void;
}) {
  const awaitingCredentials = isSignedIn && credentialsLoading && !activeCredentialId;
  const closed = useClosedOrders({
    credentialId: activeCredentialId,
    active: true,
  });

  return (
    <section
      aria-label="Stock trade history"
      className="flex min-w-0 flex-col bg-background xl:h-full xl:min-h-0"
    >
      <div className="min-w-0 p-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
        {awaitingCredentials ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading closed orders...
          </div>
        ) : !isSignedIn ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Sign in to see closed orders.
          </div>
        ) : !activeCredentialId ? (
          <EmptyState
            icon={BarChart2}
            title="No stock account connected"
            body="Closed Alpaca stock and option orders show up here. Perp fills live on the perps venue."
            actions={[
              {
                label: "Connect Alpaca",
                href: "/settings",
                emphasis: "secondary" as const,
              },
            ]}
          />
        ) : (
          <ClosedOrdersList
            isLoading={closed.isLoading}
            error={closed.error}
            orders={closed.orders}
            sortBy={sortBy}
            onViewChart={onViewChart}
            onTrade={onTrade}
            canLoadMore={closed.canLoadMore}
            isLoadingMore={closed.isLoadingMore}
            onLoadMore={closed.loadMore}
          />
        )}
      </div>
    </section>
  );
}
