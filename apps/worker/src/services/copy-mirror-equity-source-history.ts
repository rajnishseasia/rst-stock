import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import {
  normalizeTradeAction,
  tradeActionDirection,
  tradeActionSide,
} from "../../../api/src/lib/trade-action";

/** A bounded source-order read is safer than sizing from truncated history. */
export const EQUITY_SOURCE_HISTORY_SCAN_CAP = 5_000;

export type EquitySourceAssetType = "EQUITY" | "OPTION";

export interface EquitySourceCloseInput {
  sourceUserId?: string;
  sourceOrderId?: string;
  sourceOrderCreatedAt?: string;
  symbol: string;
  assetType: EquitySourceAssetType;
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: string;
}

export interface EquitySourceSocialIdentity {
  userId: string | null | undefined;
  orderId: string | null | undefined;
}

export interface EquitySourceCloseMetadata {
  sourceUserId: string;
  sourceOrderId: string;
  sourceOrderCreatedAt: string;
}

export interface EquitySourceOrderIdentity {
  id: string;
  userId: string;
  symbol: string;
  assetType: string;
  brokerAccountId: string | null;
  venue: string | null;
  optionExpiration: string | null;
  optionStrike: string | null;
  optionType: string | null;
  createdAt: Date;
  executedAt: Date | null;
}

export type EquitySourceCloseContext =
  | {
      sourceAccountId: string;
      sourceCloseQty: number;
      sourcePositionQty: number;
      reason?: undefined;
    }
  | {
      sourceAccountId: null;
      sourceCloseQty: 0;
      sourcePositionQty: 0;
      reason: "missing-source-metadata" | "source-history-unavailable" | "source-history-saturated";
    };

function normalizedAccount(value: string | null | undefined): string | null {
  const account = value?.trim().toLowerCase();
  return account ? account : null;
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

/** Match the timestamp persisted on equity candidates to the source event. */
export function equitySourceOrderEventAt(
  order: Pick<EquitySourceOrderIdentity, "createdAt" | "executedAt">,
): Date | null {
  const createdAt = validDate(order.createdAt);
  const executedAt = validDate(order.executedAt);
  if (createdAt && executedAt) {
    return executedAt.getTime() < createdAt.getTime() ? executedAt : createdAt;
  }
  return createdAt ?? executedAt;
}

/** Fill attribution requires execution time; submission cannot prove exposure. */
export function equitySourceOrderFillAt(
  order: Pick<EquitySourceOrderIdentity, "executedAt">,
): Date | null {
  return validDate(order.executedAt);
}

/**
 * Resolve a queued equity close's immutable source identity without changing
 * the durable candidate or its delivery key. A canonical social row and its
 * authoritative order are both required; supplied fields are assertions, not
 * fallback values.
 */
export function resolveEquitySourceCloseMetadata(
  input: Pick<EquitySourceCloseInput, "sourceUserId" | "sourceOrderId" | "sourceOrderCreatedAt">,
  social: EquitySourceSocialIdentity | undefined,
  order: EquitySourceOrderIdentity | undefined,
): EquitySourceCloseMetadata | null {
  const sourceUserId = social?.userId;
  const sourceOrderId = social?.orderId;
  const sourceOrderCreatedAt = order ? equitySourceOrderEventAt(order) : null;
  if (
    !sourceUserId?.trim() ||
    !sourceOrderId?.trim() ||
    !order ||
    order.id !== sourceOrderId ||
    order.userId !== sourceUserId ||
    !sourceOrderCreatedAt
  ) {
    return null;
  }
  if (
    (input.sourceUserId !== undefined && input.sourceUserId !== sourceUserId) ||
    (input.sourceOrderId !== undefined && input.sourceOrderId !== sourceOrderId)
  ) {
    return null;
  }
  if (input.sourceOrderCreatedAt !== undefined) {
    const suppliedAt = new Date(input.sourceOrderCreatedAt);
    if (
      !Number.isFinite(suppliedAt.getTime()) ||
      suppliedAt.getTime() !== sourceOrderCreatedAt.getTime()
    ) {
      return null;
    }
  }
  return {
    sourceUserId,
    sourceOrderId,
    sourceOrderCreatedAt: sourceOrderCreatedAt.toISOString(),
  };
}

function eventTime(order: { executedAt: Date | null; createdAt: Date }): Date {
  return order.executedAt ?? order.createdAt;
}

function sameInstrument(
  order: {
    symbol: string;
    assetType: string;
    venue: string | null;
    optionExpiration: string | null;
    optionStrike: string | null;
    optionType: string | null;
  },
  input: EquitySourceCloseInput,
): boolean {
  if (
    order.assetType !== input.assetType ||
    order.symbol.toUpperCase() !== input.symbol.toUpperCase() ||
    (order.venue && order.venue.toLowerCase() !== "alpaca")
  ) {
    return false;
  }
  if (input.assetType !== "OPTION") return true;
  return (
    (order.optionExpiration ?? null) === (input.optionExpiration ?? null) &&
    (order.optionType ?? null) === (input.optionType ?? null) &&
    Number(order.optionStrike) === Number(input.optionStrike)
  );
}

function sourceOrderSide(order: { tradeAction: string | null; direction: string | null }):
  | "buy"
  | "sell"
  | null {
  const action = order.tradeAction ? normalizeTradeAction(order.tradeAction) : null;
  if (!action) return null;
  const direction = order.direction === "short"
    ? "short"
    : tradeActionDirection(action);
  if (direction === "short") return null;
  const side = tradeActionSide(action);
  return side === "buy" || side === "sell" ? side : null;
}

/**
 * Load the account identity for source orders referenced by social rows.
 * `orderId` is the authoritative linkage; a missing or conflicting row is
 * handled by the caller as an attribution failure rather than guessed from a
 * display label or source user.
 */
export async function loadEquitySourceOrderIdentities(
  db: WorkerPoolDb,
  orderIds: readonly (string | null | undefined)[],
): Promise<{ rows: EquitySourceOrderIdentity[]; saturated: boolean }> {
  const ids = [...new Set(orderIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return { rows: [], saturated: false };

  const rows = await db.query.orders.findMany({
    where: inArray(schema.orders.id, ids),
    columns: {
      id: true,
      userId: true,
      symbol: true,
      assetType: true,
      brokerAccountId: true,
      venue: true,
      optionExpiration: true,
      optionStrike: true,
      optionType: true,
      createdAt: true,
      executedAt: true,
    },
    limit: EQUITY_SOURCE_HISTORY_SCAN_CAP + 1,
  });
  return {
    rows,
    saturated: rows.length > EQUITY_SOURCE_HISTORY_SCAN_CAP,
  };
}

/**
 * Reconstruct the source long immediately before one equity close.
 *
 * The query is intentionally bounded, then the rows are ordered by venue event
 * time in memory. A database `createdAt DESC` order is not a position history:
 * a catch-up fill can be written after a later close, and a descending scan can
 * observe a valid Sell-before-Buy sequence and reject it prematurely.
 */
export async function readEquitySourceCloseContext(
  db: WorkerPoolDb,
  input: EquitySourceCloseInput,
): Promise<EquitySourceCloseContext> {
  if (!input.sourceUserId || !input.sourceOrderId || !input.sourceOrderCreatedAt) {
    return {
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "missing-source-metadata",
    };
  }
  const cutoff = new Date(input.sourceOrderCreatedAt);
  if (!Number.isFinite(cutoff.getTime())) {
    return {
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "source-history-unavailable",
    };
  }

  const sourceOrder = await db.query.orders.findFirst({
    where: and(
      eq(schema.orders.id, input.sourceOrderId),
      eq(schema.orders.userId, input.sourceUserId),
    ),
    columns: {
      id: true,
      userId: true,
      symbol: true,
      assetType: true,
      tradeAction: true,
      direction: true,
      status: true,
      executedQuantity: true,
      brokerAccountId: true,
      venue: true,
      optionExpiration: true,
      optionStrike: true,
      optionType: true,
      createdAt: true,
      executedAt: true,
    },
  });
  const sourceAccountId = normalizedAccount(sourceOrder?.brokerAccountId);
  const sourceCloseEventAt = sourceOrder ? equitySourceOrderFillAt(sourceOrder) : null;
  if (
    !sourceOrder ||
    !sourceCloseEventAt ||
    !Number.isFinite(sourceCloseEventAt.getTime()) ||
    sourceOrder.id !== input.sourceOrderId ||
    sourceOrder.userId !== input.sourceUserId ||
    equitySourceOrderEventAt(sourceOrder)?.getTime() !== cutoff.getTime() ||
    !sourceAccountId ||
    !sameInstrument(sourceOrder, input)
  ) {
    return {
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "source-history-unavailable",
    };
  }

  const sourceCloseSide = sourceOrderSide(sourceOrder);
  const sourceCloseQty = Number(sourceOrder.executedQuantity);
  if (
    sourceCloseSide !== "sell" ||
    !Number.isFinite(sourceCloseQty) ||
    sourceCloseQty <= 0 ||
    ["PENDING", "SYNCING", "SUBMITTED"].includes(sourceOrder.status)
  ) {
    return {
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "source-history-unavailable",
    };
  }

  // Candidate timing identifies the source event; execution timing bounds its
  // position history so resting closes include intervening fills.
  const happenedAtOrBefore = or(
    lte(schema.orders.executedAt, sourceCloseEventAt),
    and(isNull(schema.orders.executedAt), lte(schema.orders.createdAt, sourceCloseEventAt)),
  );
  const priorOrders = await db.query.orders.findMany({
    where: and(
      eq(schema.orders.userId, input.sourceUserId),
      eq(schema.orders.assetType, input.assetType),
      eq(schema.orders.symbol, input.symbol),
      happenedAtOrBefore,
    ),
    columns: {
      id: true,
      symbol: true,
      assetType: true,
      tradeAction: true,
      direction: true,
      status: true,
      executedQuantity: true,
      brokerAccountId: true,
      venue: true,
      optionExpiration: true,
      optionStrike: true,
      optionType: true,
      createdAt: true,
      executedAt: true,
    },
    orderBy: [asc(schema.orders.createdAt), asc(schema.orders.id)],
    limit: EQUITY_SOURCE_HISTORY_SCAN_CAP + 1,
  });
  if (priorOrders.length > EQUITY_SOURCE_HISTORY_SCAN_CAP) {
    return {
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "source-history-saturated",
    };
  }

  const sourceRows = priorOrders
    .filter((order) =>
      order.id !== input.sourceOrderId &&
      normalizedAccount(order.brokerAccountId) === sourceAccountId &&
      sameInstrument(order, input) &&
      (!equitySourceOrderFillAt(order) || equitySourceOrderFillAt(order)!.getTime() <= sourceCloseEventAt.getTime()),
    )
    .map((order) => ({
      order,
      side: sourceOrderSide(order),
      quantity: Number(order.executedQuantity),
    }))
    .sort((left, right) => {
      const eventDelta = eventTime(left.order).getTime() - eventTime(right.order).getTime();
      if (eventDelta !== 0) return eventDelta;
      // If venue timestamps tie, establish the only safe deterministic order:
      // an opening fill is observed before a closing fill at that timestamp.
      const sideDelta = (left.side === "buy" ? 0 : 1) - (right.side === "buy" ? 0 : 1);
      if (sideDelta !== 0) return sideDelta;
      const createdDelta = left.order.createdAt.getTime() - right.order.createdAt.getTime();
      return createdDelta !== 0 ? createdDelta : left.order.id.localeCompare(right.order.id);
    });

  let positionMicro = 0;
  let invalidPositionHistory = false;
  const MICRO = 1_000_000;
  for (const { order, side, quantity } of sourceRows) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      if (!["CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)) {
        return {
          sourceAccountId: null,
          sourceCloseQty: 0,
          sourcePositionQty: 0,
          reason: "source-history-unavailable",
        };
      }
      continue;
    }
    if (!equitySourceOrderFillAt(order) || ["PENDING", "SYNCING", "SUBMITTED"].includes(order.status) || !side) {
      return {
        sourceAccountId: null,
        sourceCloseQty: 0,
        sourcePositionQty: 0,
        reason: "source-history-unavailable",
      };
    }
    positionMicro += (side === "buy" ? 1 : -1) * Math.round(quantity * MICRO);
    if (positionMicro < 0) invalidPositionHistory = true;
  }

  const sourcePositionQty = positionMicro / MICRO;
  if (
    invalidPositionHistory ||
    sourcePositionQty <= 0 ||
    sourceCloseQty > sourcePositionQty + 1 / MICRO
  ) {
    return {
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "source-history-unavailable",
    };
  }
  return { sourceAccountId, sourceCloseQty, sourcePositionQty };
}
