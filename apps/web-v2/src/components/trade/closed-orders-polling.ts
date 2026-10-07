/**
 * Background refetch interval (ms) for the closed-orders history query, or
 * `false` to disable polling entirely.
 *
 * The Closed tab polls every 15s while it is the visible view so a fill (or a
 * mirrored copy-trade close) that lands while the user is looking at history
 * shows up without a manual refresh. Polling while the tab is hidden would
 * just spend requests on data nobody is looking at.
 */
export const CLOSED_ORDERS_REFETCH_MS = 15000;

export function closedOrdersRefetchInterval(showClosed: boolean): number | false {
  return showClosed ? CLOSED_ORDERS_REFETCH_MS : false;
}
