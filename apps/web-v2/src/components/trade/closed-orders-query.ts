"use client";

/**
 * The closed-orders (stock/option history) query, owned in one place.
 *
 * Both surfaces that show trade history read it through this hook: the
 * positions panel's Open | Closed toggle, and the desktop bottom drawer's
 * History tab. Two copies of the paging/placeholder rules would drift, and the
 * placeholder rule in particular is a correctness rule, not a preference (see
 * `closedOrdersQueryCredentialId`).
 *
 * Paging is bounded on purpose (audit H6): one page at a time up to the
 * server's hard cap, never an unbounded scan of the orders table.
 */

import { useState } from "react";

import { closedOrdersRefetchInterval } from "@/components/trade/closed-orders-polling";
import { getClosedOrdersPaging } from "@/components/trade/open-orders-display";
import type { ClosedOrder } from "@/components/trade/closed-orders-list";
import { trpc } from "@/lib/trpc";

// Closed-order history is a bounded, paginated query (audit H6). We request one
// page at a time and let the user pull more up to the server's hard cap
// (positions.closedOrders zod input caps `limit` at 200).
export const CLOSED_ORDERS_PAGE_SIZE = 50;
export const CLOSED_ORDERS_MAX = 200;

/**
 * Read the `credentialId` out of a previous closedOrders query's key so
 * placeholder rows are only carried forward within the SAME account. The tRPC
 * key shape is `[path[], { input, type }]`; anything unexpected returns
 * undefined, which fails safe (no placeholder, so a loading state shows).
 */
export function closedOrdersQueryCredentialId(
  prevQuery: { queryKey?: unknown } | undefined,
): string | undefined {
  const key = prevQuery?.queryKey;
  if (!Array.isArray(key)) return undefined;
  const meta = key[1] as { input?: { credentialId?: unknown } } | undefined;
  const credentialId = meta?.input?.credentialId;
  return typeof credentialId === "string" ? credentialId : undefined;
}

export interface ClosedOrdersQueryResult {
  orders: ClosedOrder[];
  isLoading: boolean;
  error: string | null;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

/**
 * @param active Whether the closed list is the visible view. Gates both the
 * request and the 15s poll, so a hidden history tab spends nothing.
 */
export function useClosedOrders({
  credentialId,
  active,
}: {
  credentialId: string | undefined;
  active: boolean;
}): ClosedOrdersQueryResult {
  const [limit, setLimit] = useState(CLOSED_ORDERS_PAGE_SIZE);

  const query = trpc.positions.closedOrders.useQuery(
    { credentialId, limit },
    {
      enabled: !!credentialId && active,
      refetchInterval: closedOrdersRefetchInterval(active),
      // Hold the visible rows in place while a LARGER page loads, but only for
      // the same account. `credentialId` is part of the query key, so an
      // unscoped `(prev) => prev` would keep showing the previous account's
      // closed orders (with its realized P&L) after a Paper/Live switch, with no
      // loading state, until the new fetch lands.
      placeholderData: (prev, prevQuery) =>
        closedOrdersQueryCredentialId(prevQuery) === credentialId ? prev : undefined,
    },
  );

  const orders = query.data ?? [];
  // True only while a larger page is in flight (not on the 15s background
  // refetch).
  const isLoadingMore = query.isFetching && query.isPlaceholderData;
  const { canLoadMore } = getClosedOrdersPaging({
    loadedCount: orders.length,
    limit,
    max: CLOSED_ORDERS_MAX,
    isLoadingMore,
  });

  return {
    orders,
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
    canLoadMore,
    isLoadingMore,
    loadMore: () => setLimit((n) => Math.min(n + CLOSED_ORDERS_PAGE_SIZE, CLOSED_ORDERS_MAX)),
  };
}
