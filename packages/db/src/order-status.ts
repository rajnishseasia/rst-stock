import { sql, type SQL } from "drizzle-orm";
import { orders } from "./schema/orders.js";

export type OrderStatus = (typeof orders.$inferSelect)["status"];

/**
 * Lifecycle precedence used by every writer of `orders.status`.
 *
 * PENDING -> SYNCING -> SUBMITTED -> PARTIAL -> terminal -> FILLED.
 * Terminal states share a rank, but a terminal state never replaces another
 * terminal state unless it is the same value. This keeps cancellation and
 * rejection writes compare-and-set operations instead of last-writer-wins.
 */
export const ORDER_STATUS_RANK: Record<OrderStatus, number> = {
  PENDING: 0,
  SYNCING: 1,
  SUBMITTED: 2,
  PARTIAL: 3,
  CANCELLED: 4,
  REJECTED: 4,
  EXPIRED: 4,
  FILLED: 5,
};

export function canAdvanceOrderStatus(
  current: OrderStatus,
  incoming: OrderStatus,
): boolean {
  return current === incoming || ORDER_STATUS_RANK[incoming] > ORDER_STATUS_RANK[current];
}

export function orderStatusRankSql(): SQL<number> {
  return sql<number>`case ${orders.status}
    when 'FILLED' then 5
    when 'CANCELLED' then 4
    when 'REJECTED' then 4
    when 'EXPIRED' then 4
    when 'PARTIAL' then 3
    when 'SUBMITTED' then 2
    when 'SYNCING' then 1
    else 0
  end`;
}

/** SQL value that advances status only when the incoming status is newer. */
export function monotonicOrderStatusValue(incoming: OrderStatus): SQL<OrderStatus> {
  const incomingRank = ORDER_STATUS_RANK[incoming];
  return sql<OrderStatus>`case
    when ${incomingRank} > ${orderStatusRankSql()}
      then ${incoming}::order_status
    else ${orders.status}
  end`;
}

/**
 * Compare-and-set predicate for a status write. Same-status metadata updates
 * are allowed; a stale writer can never replace a newer status or peer terminal
 * state.
 */
export function orderStatusTransitionCondition(incoming: OrderStatus): SQL<boolean> {
  const incomingRank = ORDER_STATUS_RANK[incoming];
  return sql<boolean>`(
    ${orders.status} = ${incoming}::order_status
    or ${incomingRank} > ${orderStatusRankSql()}
  )`;
}

/** A broker identity is write-once for an order, apart from idempotent repeats. */
export function preserveBrokerOrderIdCondition(
  brokerOrderId: string | null | undefined,
): SQL<boolean> {
  if (!brokerOrderId) return sql<boolean>`true`;
  return sql<boolean>`(
    ${orders.brokerOrderId} is null
    or ${orders.brokerOrderId} = ${brokerOrderId}
  )`;
}
