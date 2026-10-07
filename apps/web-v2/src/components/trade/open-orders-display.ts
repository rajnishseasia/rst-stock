type DisplayOrderLeg = {
  type: string;
  stopPrice: number | null;
  limitPrice: number | null;
};

type DisplayOrder = {
  legs?: DisplayOrderLeg[];
};

export function getVisibleOpenOrderCount(orders: DisplayOrder[]) {
  return orders.reduce((count, order) => count + 1 + (order.legs?.length ?? 0), 0);
}

export function isStopLossOrderType(type: string) {
  return type === "stop" || type === "stop_limit";
}

export function getLinkedExitLabel(leg: DisplayOrderLeg) {
  if (leg.stopPrice !== null || isStopLossOrderType(leg.type)) {
    return "Stop Loss";
  }

  if (leg.limitPrice !== null || leg.type === "limit") {
    return "Take Profit";
  }

  return "Linked Exit";
}

/** Inputs for the closed-orders "Load more" paging decision. */
export interface ClosedOrdersPagingInput {
  /** Rows currently rendered (may be the previous, smaller page). */
  loadedCount: number;
  /** The limit currently requested from the server. */
  limit: number;
  /** Hard cap, matching the server's own `limit` max. */
  max: number;
  /** Whether a larger page is in flight right now. */
  isLoadingMore: boolean;
}

export interface ClosedOrdersPaging {
  /** Whether to render the "Load more" control at all. */
  canLoadMore: boolean;
  /** Whether that control should read "Loading..." and be disabled. */
  isLoadingMore: boolean;
}

/**
 * Decide whether more closed-order history can be pulled, and whether a pull is
 * in flight.
 *
 * `isLoadingMore` must keep the control MOUNTED. While a larger page loads, the
 * visible rows are still the previous, smaller page, so `loadedCount` is below
 * the new `limit`; without the in-flight term the control unmounts the instant
 * it is clicked and pops back when the rows land (a layout shift, and the
 * "Loading..." state would be unreachable dead code).
 */
export function getClosedOrdersPaging(
  input: ClosedOrdersPagingInput,
): ClosedOrdersPaging {
  const underCap = input.limit < input.max;
  const hasFullPage = input.loadedCount >= input.limit;
  return {
    canLoadMore: (hasFullPage || input.isLoadingMore) && underCap,
    isLoadingMore: input.isLoadingMore,
  };
}

/**
 * Statuses every freshly-submitted, still-open order passes through. They carry
 * no signal on an OPEN-orders list (the list itself already means "open"), so
 * badging them added noise to every row.
 *
 * `new` is the in-hours resting state; `accepted` and `pending_new` are the
 * equivalents Alpaca reports outside market hours, so hiding only `new` left the
 * pre-market panel exactly as noisy as before.
 */
const NOISE_ORDER_STATUSES = new Set(["new", "accepted", "pending_new"]);

/** Whether an order status is pure submission noise on an open-orders list. */
export function isNoiseOrderStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return NOISE_ORDER_STATUSES.has(status.trim().toLowerCase());
}
