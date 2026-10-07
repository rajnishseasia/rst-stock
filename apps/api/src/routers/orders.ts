/**
 * Orders Router
 *
 * tRPC router for order submission and management.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
  schema,
} from "@trade-bot/db";
import type { OrderStatus, PoolDb } from "@trade-bot/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  deriveClientOrderId,
  createBrokerClientOrderId,
  isAlpacaAmbiguousOrderError,
  resolveTimeInForce,
  type CreateOrderRequest,
} from "@trade-bot/alpaca";
import { getAlpacaClient } from "../lib/alpaca.js";
import {
  createHyperliquidExchangeClient,
  HL_AGENT_REGISTERED,
} from "../lib/hyperliquid.js";
import {
  HYPERLIQUID_MIN_NOTIONAL_MESSAGE,
  effectivePerpOrderPrice,
  formatPerpOrderSizeForVenue,
  isPerpOrderNotionalAtLeastMinimum,
  perpCoinSchema,
  perpOrderSubmitSchema,
  toPlacePerpOrderRequest,
  toPerpOrderRow,
} from "../lib/perp-orders.js";
import {
  HyperliquidOrderPreparationError,
  HyperliquidOrderRejectedError,
  TpSlPartialError,
  buildTpSlLegs,
  type MarginMode,
  type SetPositionTpSlRequest,
} from "@trade-bot/hyperliquid";
import { friendlyOrderError, isConnectionError } from "../lib/friendly-error.js";
// Re-export the shared OSI builder so existing importers of this module keep
// working. The single source of truth lives in ../lib/options.ts.
import { buildOptionsSymbol } from "../lib/options.js";
export { buildOptionsSymbol };
import { getRedisClient } from "@trade-bot/redis";
import { isSafePositiveTradingPerpDecimal } from "@trade-bot/utils";
import { createProductionLogger } from "@trade-bot/logger";
import { clientOrderIdSchema, resolveClientOrderId } from "../lib/order-idempotency.js";
import { publishSocialTrade } from "../lib/social-publish.js";
import { tradeActionDirection } from "../lib/trade-action.js";
import {
  assertManualCopySourceReplayMatches,
  copySourceItemIdSchema,
  manualCopyOrderProvenance,
  resolveManualCopySource,
  type ResolvedManualCopySource,
} from "../lib/manual-copy-source.js";
export { resolveClientOrderId } from "../lib/order-idempotency.js";

const logger = createProductionLogger();
const PERP_CLOSE_PREFLIGHT_TIMEOUT_MS = 8_000;

function comparePositiveDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const leftWhole = (leftParts[0] ?? "").replace(/^0+/, "") || "0";
  const rightWhole = (rightParts[0] ?? "").replace(/^0+/, "") || "0";

  if (leftWhole.length !== rightWhole.length) {
    return leftWhole.length < rightWhole.length ? -1 : 1;
  }
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;

  const leftFraction = (leftParts[1] ?? "").replace(/0+$/, "");
  const rightFraction = (rightParts[1] ?? "").replace(/0+$/, "");
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  for (let index = 0; index < fractionLength; index += 1) {
    const leftDigit = leftFraction[index] ?? "0";
    const rightDigit = rightFraction[index] ?? "0";
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

type PendingTpSlOrderRow = ReturnType<typeof toPerpOrderRow>;
type ReservedTpSlOrderRow = PendingTpSlOrderRow & { id: string };
type TpSlReservation = {
  clientOrderId: string;
  rows: ReservedTpSlOrderRow[];
};
type TpSlReservationRetry = {
  clientOrderId: string;
  rebuildRows: (clientOrderId: string) => PendingTpSlOrderRow[];
  nextClientOrderId: () => string;
};

const DEFINITIVE_TPSL_FAILURE_STATUSES = new Set(["REJECTED", "CANCELLED"]);

class TerminalTpSlReplayError extends Error {
  constructor(clientOrderId: string) {
    super(`TP/SL cloid ${clientOrderId} has only terminal broker failures`);
    this.name = "TerminalTpSlReplayError";
  }
}

export class TpSlPersistenceError extends Error {
  readonly acceptedCount: number;
  readonly failedCount: number;

  constructor(acceptedCount: number, failedCount: number) {
    super(
      `Hyperliquid accepted ${acceptedCount} TP/SL leg(s), but ${failedCount} local order record(s) need reconciliation`,
    );
    this.name = "TpSlPersistenceError";
    this.acceptedCount = acceptedCount;
    this.failedCount = failedCount;
  }
}

export function resolveTpSlClientOrderId(
  userId: string,
  logicalId: string,
): string {
  return resolveClientOrderId(userId, logicalId, "perp-tpsl");
}

function orderStatuses(result: unknown): unknown[] {
  if (!result || typeof result !== "object") return [];
  const response = Reflect.get(result, "response");
  if (!response || typeof response !== "object") return [];
  const data = Reflect.get(response, "data");
  if (!data || typeof data !== "object") return [];
  const statuses = Reflect.get(data, "statuses");
  return Array.isArray(statuses) ? statuses : [];
}

function acceptedBrokerOrderId(status: unknown): string | null {
  if (!status || typeof status !== "object") return null;
  for (const key of ["resting", "filled"] as const) {
    const accepted = Reflect.get(status, key);
    if (!accepted || typeof accepted !== "object") continue;
    const oid = Reflect.get(accepted, "oid");
    if (typeof oid === "number" || typeof oid === "string") return String(oid);
  }
  return null;
}

/** Build the durable rows that must exist before any TP/SL broker submission. */
export function pendingTpSlOrderRows(input: {
  request: SetPositionTpSlRequest & { clientOrderId: string };
  userId: string;
  brokerAccountId: string;
  leverage: number;
  marginMode: MarginMode;
}): PendingTpSlOrderRow[] {
  const legs = buildTpSlLegs(input.request);
  return legs.map((leg) => {
    if (!leg.clientOrderId) {
      throw new Error("TP/SL leg is missing its tenant-scoped cloid");
    }
    const legInput = perpOrderSubmitSchema.parse({
        coin: leg.coin,
        isLong: leg.side === "long",
        marginMode: input.marginMode,
        orderType: leg.orderType,
        sizeCoin: String(leg.size),
        ...(leg.limitPrice !== undefined ? { limitPrice: String(leg.limitPrice) } : {}),
        ...(leg.triggerPx !== undefined ? { triggerPx: String(leg.triggerPx) } : {}),
        reduceOnly: true,
        postOnly: false,
        leverage: input.leverage,
        cloid: leg.clientOrderId,
      });
    return toPerpOrderRow(
      legInput,
      input.userId,
      input.brokerAccountId,
    );
  });
}

function canonicalDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return String(value);
  const integer = (match[2] ?? "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const sign = match[1] === "-" && (integer !== "0" || fraction) ? "-" : "";
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}

function sameDecimalValue(left: unknown, right: unknown): boolean {
  return canonicalDecimal(left) === canonicalDecimal(right);
}

function matchesImmutableTpSlOrder(
  existing: Record<string, unknown>,
  row: PendingTpSlOrderRow,
): boolean {
  return (
    existing.userId === row.userId &&
    existing.clientOrderId === row.clientOrderId &&
    existing.brokerAccountId === row.brokerAccountId &&
    existing.symbol === row.symbol &&
    existing.assetType === row.assetType &&
    existing.orderType === row.orderType &&
    existing.tradeAction === row.tradeAction &&
    existing.direction === row.direction &&
    existing.quantity === row.quantity &&
    sameDecimalValue(existing.quantityDecimal, row.quantityDecimal) &&
    sameDecimalValue(existing.limitPrice, row.limitPrice) &&
    sameDecimalValue(existing.priceTrigger, row.priceTrigger) &&
    existing.leverage === row.leverage &&
    existing.marginMode === row.marginMode &&
    existing.reduceOnly === row.reduceOnly &&
    existing.venue === row.venue
  );
}

/**
 * Atomically reserve every leg. A conflict is never reused for submission: an
 * exact prior row may represent an ambiguous earlier attempt, while a mismatch
 * is an ownership/identity violation. A definitive rejected/cancelled group can
 * be retried with a new cloid; open or ambiguous rows stay protected.
 */
export async function persistPendingTpSlOrders(
  db: PoolDb,
  rows: PendingTpSlOrderRow[],
  retry?: TpSlReservationRetry,
): Promise<TpSlReservation> {
  let candidateRows = rows;
  let candidateClientOrderId = retry?.clientOrderId ?? rows[0]?.clientOrderId ?? "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reservedRows = await db.transaction(async (tx) => {
        const reserved: ReservedTpSlOrderRow[] = [];
        let terminalConflict = false;

        for (const row of candidateRows) {
          const [inserted] = await tx
            .insert(schema.orders)
            .values(row)
            .onConflictDoNothing({
              target: schema.orders.clientOrderId,
            })
            .returning({ id: schema.orders.id });
          if (inserted) {
            reserved.push({ ...row, id: inserted.id });
            continue;
          }

          const existing = await tx.query.orders.findFirst({
            where: eq(schema.orders.clientOrderId, row.clientOrderId),
          });
          if (!existing || !matchesImmutableTpSlOrder(existing, row)) {
            throw new Error(
              `TP/SL cloid conflict does not match tenant and immutable order identity: ${row.clientOrderId}`,
            );
          }
          if (DEFINITIVE_TPSL_FAILURE_STATUSES.has(String(existing.status))) {
            terminalConflict = true;
            continue;
          }
          throw new Error(
            `TP/SL cloid already has a local order and will not be resubmitted: ${row.clientOrderId}`,
          );
        }

        if (terminalConflict) {
          throw new TerminalTpSlReplayError(candidateClientOrderId);
        }
        return reserved;
      });

      return { clientOrderId: candidateClientOrderId, rows: reservedRows };
    } catch (error) {
      if (!(error instanceof TerminalTpSlReplayError) || !retry || attempt > 0) {
        throw error;
      }
      candidateClientOrderId = retry.nextClientOrderId();
      candidateRows = retry.rebuildRows(candidateClientOrderId);
    }
  }

  throw new Error("TP/SL reservation retry was exhausted");
}

function rejectedStatusMessage(status: unknown): string | null {
  if (!status || typeof status !== "object") return null;
  const error = Reflect.get(status, "error");
  return typeof error === "string" ? error : null;
}

/** Finalize broker-confirmed statuses; failed writes deliberately remain PENDING. */
export async function finalizeTpSlOrders(
  db: PoolDb,
  rows: ReservedTpSlOrderRow[],
  result: unknown,
): Promise<void> {
  const statuses = orderStatuses(result);
  let acceptedCount = 0;
  let failedCount = 0;

  if (statuses.length !== rows.length) {
    const missingLegs = Math.max(0, rows.length - statuses.length);
    logger.error("api", "[Orders] Hyperliquid TP/SL response length mismatch", {
      requestedLegs: rows.length,
      returnedStatuses: statuses.length,
      missingLegs,
    });
    // Missing statuses are not definitive venue rejections. Keep those rows
    // pending and force the caller down the reconciliation path.
    failedCount += missingLegs;
  }

  for (const [index, row] of rows.entries()) {
    const brokerOrderId = acceptedBrokerOrderId(statuses[index]);
    const rejection = rejectedStatusMessage(statuses[index]);
    if (!brokerOrderId && !rejection) continue;
    if (brokerOrderId) acceptedCount += 1;

    try {
      const incomingStatus = brokerOrderId ? "SUBMITTED" as const : "REJECTED" as const;
      const updated = await db
        .update(schema.orders)
        .set(
          brokerOrderId
            ? { brokerOrderId, status: "SUBMITTED" as const }
            : { status: "REJECTED" as const, notes: `Venue rejection: ${rejection}` },
        )
        .where(
          and(
            eq(schema.orders.id, row.id),
            eq(schema.orders.userId, row.userId),
            eq(schema.orders.clientOrderId, row.clientOrderId),
            orderStatusTransitionCondition(incomingStatus),
            ...(brokerOrderId ? [preserveBrokerOrderIdCondition(brokerOrderId)] : []),
          ),
        )
        .returning({ id: schema.orders.id });
      if (updated.length !== 1) {
        let authoritative: { status: OrderStatus; brokerOrderId: string | null } | null = null;
        if (updated.length === 0) {
          const findFirst = db?.query?.orders?.findFirst;
          authoritative = typeof findFirst === "function"
            ? await findFirst({
                where: and(
                  eq(schema.orders.id, row.id),
                  eq(schema.orders.userId, row.userId),
                  eq(schema.orders.clientOrderId, row.clientOrderId),
                ),
                columns: { status: true, brokerOrderId: true },
              }) ?? null
            : null;
        }
        // Even when another writer already advanced the row, this invocation
        // did not win an exact-one CAS. Keep the caller on reconciliation so it
        // cannot claim the TP/SL group was attached from this attempt.
        logger.warn("api", "[Orders] TP/SL finalization CAS was not singular", {
          cloid: row.clientOrderId,
          returnedRows: updated.length,
          authoritativeStatus: authoritative?.status ?? null,
          authoritativeBrokerOrderId: authoritative?.brokerOrderId ?? null,
        });
        throw new Error(
          `reserved TP/SL CAS returned ${updated.length} rows; exactly one is required`,
        );
      }
    } catch (error) {
      failedCount += 1;
      logger.error("api", "[Orders] Failed to finalize TP/SL leg", {
        cloid: row.clientOrderId,
        brokerOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedCount > 0) {
    throw new TpSlPersistenceError(acceptedCount, failedCount);
  }
}

/**
 * Shared input primitives (audit M7). One symbol rule for every submit
 * procedure (the old schemas disagreed: max 10 vs max 50, no charset check),
 * a real YYMMDD check for option expirations, and a bounded notes field so
 * malformed instruments fail here with a clear message instead of reaching
 * Alpaca as opaque 422s.
 */
// 21 chars covers the longest OCC option symbol; charset covers equities,
// preferred-share dots, and class-share dashes/slashes.
export const symbolSchema = z
  .string()
  .min(1)
  .max(21)
  .regex(/^[A-Za-z0-9./-]+$/, "Symbol contains invalid characters")
  .transform((val) => val.toUpperCase());
export const optionExpirationSchema = z
  .string()
  .regex(/^\d{6}$/, "Option expiration must be YYMMDD, e.g. 260119")
  .optional();
export const notesSchema = z.string().max(2000).optional();

// Order submission schema
export const orderSubmitSchema = z.object({
  symbol: symbolSchema,
  assetType: z.enum(["EQUITY", "OPTION"]),
  orderType: z.enum(["Market", "Limit", "StopMarket", "StopLimit"]),
  tradeAction: z.enum([
    "Buy", "Sell", "SellShort", "BuyToCover",
    "BuyToOpen", "SellToClose", "SellToOpen", "BuyToClose"
  ]),
  direction: z.enum(["long", "short"]).default("long"),
  quantity: z.number().int().positive(),
  maxRisk: z.number().positive().optional(),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  stopMarketPrice: z.number().positive().optional(),
  priceTrigger: z.number().positive().optional(),
  // No schema default: the TIF resolver must be able to tell an EXPLICIT user
  // choice from an omitted field. A blanket .default("gtc") here made every
  // omission look like an explicit GTC request, which wrongly upgraded option
  // limit BUYS (GTC only on explicit request) from DAY to GTC. Equity behavior
  // is unchanged: the shared resolver defaults an omitted TIF to gtc.
  timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).optional(),

  // Options fields
  optionExpiration: optionExpirationSchema, // YYMMDD format, validated
  optionStrike: z.number().positive().optional(),
  optionType: z.enum(["CALL", "PUT"]).optional(),

  // Advanced options
  skipPresetTp: z.boolean().default(false),
  forceThreeContracts: z.boolean().default(false),
  notes: notesSchema,

  // Signal reference
  signalId: z.string().uuid().optional(),
  /** Canonical copy-trade feed item, verified server-side when supplied. */
  copySourceItemId: copySourceItemIdSchema.optional(),

  // Account to use
  accountId: z.string().optional(),
  credentialId: z.string().uuid().optional(),
  
  // Idempotency
  idempotencyKey: clientOrderIdSchema.optional(),
});

/**
 * Map TradeAction to Alpaca Side
 */
export function getAlpacaSide(tradeAction: string): "buy" | "sell" {
  const action = tradeAction.toLowerCase();
  if (action.includes("buy")) return "buy";
  if (action.includes("sell")) return "sell";
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Invalid trade action: ${tradeAction}`,
  });
}

/** Derive persisted position direction from the full action when available. */
export function resolveOrderDirection(
  tradeAction: string,
  requested: "long" | "short",
): "long" | "short" {
  return tradeActionDirection(tradeAction) ?? requested;
}

/**
 * Map OrderType to Alpaca Type
 */
export function getAlpacaType(orderType: string): "market" | "limit" | "stop" | "stop_limit" {
  switch (orderType) {
    case "Market": return "market";
    case "Limit": return "limit";
    case "StopMarket": return "stop";
    case "StopLimit": return "stop_limit";
    default: return "market";
  }
}

type SubmitOrderAssetType = z.infer<typeof orderSubmitSchema>["assetType"];
type SubmitOrderType = z.infer<typeof orderSubmitSchema>["orderType"];
type SubmitTradeAction = z.infer<typeof orderSubmitSchema>["tradeAction"];
// NonNullable: the schema field is optional (no default), but every resolver
// below returns a concrete TIF.
type SubmitTimeInForce = NonNullable<z.infer<typeof orderSubmitSchema>["timeInForce"]>;

export function resolveAlpacaTimeInForce(input: {
  assetType: SubmitOrderAssetType;
  orderType: SubmitOrderType;
  tradeAction: SubmitTradeAction;
  timeInForce?: SubmitTimeInForce;
}): SubmitTimeInForce {
  // Delegate to the shared Alpaca TIF rules. Options accept GTC only on limit
  // orders (buy or sell); market/stop options must be DAY. Equities keep the
  // "limit sells rest as GTC, otherwise honor the request" convention.
  return resolveTimeInForce({
    assetType: input.assetType,
    orderType: getAlpacaType(input.orderType),
    side: getAlpacaSide(input.tradeAction),
    requested: input.timeInForce,
  });
}

export function resolveAlpacaReplaceTimeInForce(input: {
  existingOrderType: string;
  existingSide: string;
  timeInForce: SubmitTimeInForce;
}): SubmitTimeInForce {
  if (input.existingOrderType === "limit" && input.existingSide === "sell") {
    return "gtc";
  }

  return input.timeInForce;
}

export interface SubmitResponse {
  success: boolean;
  orderId: string;
  brokerOrderId: string | null;
  message: string;
  syncing?: boolean;
  status?: OrderStatus;
}

function pendingSyncResponse(
  orderId: string,
  message: string,
  brokerOrderId: string | null = null,
  status: "PENDING" | "SYNCING" = "PENDING",
): SubmitResponse {
  return {
    success: false,
    syncing: true,
    status,
    orderId,
    brokerOrderId,
    message,
  };
}

function pendingReconciliationResponse(
  orderId: string,
  message: string,
  brokerOrderId: string | null = null,
): SubmitResponse {
  return {
    success: false,
    syncing: true,
    orderId,
    brokerOrderId,
    message: `${message}; local status is awaiting reconciliation`,
  };
}

async function markOrderSyncing(
  db: any,
  order: { id: string; userId: string; clientOrderId: string | null },
  reason: string,
  brokerOrderId: string | null = null,
): Promise<boolean> {
  const conditions = [
    eq(schema.orders.id, order.id),
    eq(schema.orders.userId, order.userId),
  ];
  if (order.clientOrderId) {
    conditions.push(eq(schema.orders.clientOrderId, order.clientOrderId));
  }
  const updated = await db
    .update(schema.orders)
    .set({
      status: "SYNCING",
      ...(brokerOrderId ? { brokerOrderId } : {}),
      syncReason: reason,
      syncAttempts: sql`${schema.orders.syncAttempts} + 1`,
      lastSyncAttemptAt: new Date(),
      statusUpdatedAt: new Date(),
    })
    .where(and(
      ...conditions,
      orderStatusTransitionCondition("SYNCING"),
      preserveBrokerOrderIdCondition(brokerOrderId),
    ))
    .returning({ id: schema.orders.id });
  return updated.length === 1;
}

type AuthoritativeOrderState = {
  id: string;
  status: OrderStatus;
  brokerOrderId: string | null;
};

type BrokerAcceptancePersistence =
  | { accepted: true }
  | { accepted: false; authoritative: AuthoritativeOrderState | null };

async function readAuthoritativeOrderState(
  db: any,
  order: { id: string; userId: string; clientOrderId: string | null },
): Promise<AuthoritativeOrderState | null> {
  const findFirst = db?.query?.orders?.findFirst;
  if (typeof findFirst !== "function") return null;
  const conditions = [
    eq(schema.orders.id, order.id),
    eq(schema.orders.userId, order.userId),
  ];
  if (order.clientOrderId) conditions.push(eq(schema.orders.clientOrderId, order.clientOrderId));
  const current = await findFirst({
    where: and(...conditions),
    columns: { id: true, status: true, brokerOrderId: true },
  });
  return current ?? null;
}

async function markOrderRejected(
  db: any,
  order: { id: string; userId: string; clientOrderId: string | null },
  values: Record<string, unknown> = { status: "REJECTED" },
): Promise<boolean> {
  const conditions = [
    eq(schema.orders.id, order.id),
    eq(schema.orders.userId, order.userId),
  ];
  if (order.clientOrderId) conditions.push(eq(schema.orders.clientOrderId, order.clientOrderId));
  const rejectedRows = await db
    .update(schema.orders)
    .set(values)
    .where(and(...conditions, orderStatusTransitionCondition("REJECTED")))
    .returning({ id: schema.orders.id });
  if (rejectedRows.length === 1) return true;

  let authoritative: AuthoritativeOrderState | null = null;
  try {
    authoritative = await readAuthoritativeOrderState(db, order);
  } catch (error) {
    logger.warn("api", "[Orders] Failed to reread rejected order state", {
      orderId: order.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.warn("api", "[Orders] Rejected-order CAS was not singular", {
    orderId: order.id,
    returnedRows: rejectedRows.length,
    authoritativeStatus: authoritative?.status ?? null,
  });
  return false;
}

function authoritativeOrderResponse(
  state: AuthoritativeOrderState,
  fallbackBrokerOrderId: string | null,
  message: string,
): SubmitResponse {
  const stillSyncing = state.status === "PENDING" || state.status === "SYNCING";
  return {
    success: false,
    syncing: stillSyncing,
    status: state.status,
    orderId: state.id,
    brokerOrderId: state.brokerOrderId ?? fallbackBrokerOrderId,
    message,
  };
}

async function resolveAmbiguousOrderResponse(
  db: any,
  order: { id: string; userId: string; clientOrderId: string | null },
  options: {
    operation: string;
    reason: string;
    message: string;
    brokerOrderId?: string | null;
  },
): Promise<SubmitResponse> {
  const brokerOrderId = options.brokerOrderId ?? null;
  let markedSyncing = false;
  try {
    markedSyncing = await markOrderSyncing(db, order, options.reason, brokerOrderId);
  } catch (syncError) {
    logger.error("api", `[Orders] Failed to persist ambiguous ${options.operation} state`, {
      orderId: order.id,
      error: syncError instanceof Error ? syncError.message : String(syncError),
    });
  }

  if (markedSyncing) {
    return pendingSyncResponse(order.id, options.message, brokerOrderId, "SYNCING");
  }

  logger.warn("api", `[Orders] Ambiguous ${options.operation} SYNCING CAS was not singular`, {
    orderId: order.id,
  });

  let authoritative: AuthoritativeOrderState | null = null;
  try {
    authoritative = await readAuthoritativeOrderState(db, order);
  } catch (readError) {
    logger.error("api", `[Orders] Failed to reread ambiguous ${options.operation} state`, {
      orderId: order.id,
      error: readError instanceof Error ? readError.message : String(readError),
    });
  }

  return authoritative
    ? authoritativeOrderResponse(authoritative, brokerOrderId, options.message)
    : pendingReconciliationResponse(order.id, options.message, brokerOrderId);
}

function brokerAcceptanceFailureResponse(
  result: Extract<BrokerAcceptancePersistence, { accepted: false }>,
  orderId: string,
  brokerOrderId: string | null,
  message: string,
): SubmitResponse {
  return result.authoritative
    ? authoritativeOrderResponse(result.authoritative, brokerOrderId, message)
    : pendingSyncResponse(orderId, message, brokerOrderId, "SYNCING");
}

async function persistBrokerAcceptance(
  db: any,
  order: { id: string; userId: string; clientOrderId: string | null },
  brokerOrderId: string,
): Promise<BrokerAcceptancePersistence> {
  const conditions = [
    eq(schema.orders.id, order.id),
    eq(schema.orders.userId, order.userId),
  ];
  if (order.clientOrderId) {
    conditions.push(eq(schema.orders.clientOrderId, order.clientOrderId));
  }
  try {
    const updated = await db
      .update(schema.orders)
      .set({
        status: "SUBMITTED",
        brokerOrderId,
        syncReason: null,
        statusUpdatedAt: new Date(),
      })
      .where(and(
        ...conditions,
        orderStatusTransitionCondition("SUBMITTED"),
        preserveBrokerOrderIdCondition(brokerOrderId),
      ))
      .returning({ id: schema.orders.id });
    if (updated.length !== 1) {
      throw new Error(
        `broker acceptance CAS returned ${updated.length} order rows; exactly one is required`,
      );
    }
    return { accepted: true };
  } catch (error) {
    logger.error("api", "[Orders] Broker accepted order but local persistence failed", {
      orderId: order.id,
      brokerOrderId,
      error: error instanceof Error ? error.message : String(error),
    });
    let authoritative: AuthoritativeOrderState | null = null;
    try {
      authoritative = await readAuthoritativeOrderState(db, order);
    } catch (readError) {
      logger.error("api", "[Orders] Failed to reread broker acceptance state", {
        orderId: order.id,
        brokerOrderId,
        error: readError instanceof Error ? readError.message : String(readError),
      });
    }

    // A concurrent reconciler may already have advanced the row. Never write a
    // synthetic SYNCING state over that authoritative outcome.
    if (authoritative && authoritative.status !== "PENDING" && authoritative.status !== "SYNCING") {
      return { accepted: false, authoritative };
    }

    try {
      const markedSyncing = await markOrderSyncing(
        db,
        order,
        `Broker accepted ${brokerOrderId}; local acceptance persistence failed`,
        brokerOrderId,
      );
      if (!markedSyncing) {
        logger.warn("api", "[Orders] Acceptance reconciliation CAS did not win", {
          orderId: order.id,
          brokerOrderId,
        });
      }
    } catch (syncError) {
      logger.error("api", "[Orders] Failed to mark accepted order for reconciliation", {
        orderId: order.id,
        brokerOrderId,
        error: syncError instanceof Error ? syncError.message : String(syncError),
      });
    }

    try {
      authoritative = await readAuthoritativeOrderState(db, order);
    } catch (readError) {
      logger.error("api", "[Orders] Failed to reread acceptance reconciliation state", {
        orderId: order.id,
        brokerOrderId,
        error: readError instanceof Error ? readError.message : String(readError),
      });
    }
    return { accepted: false, authoritative };
  }
}

/**
 * Guard: the Hyperliquid trading agent must be LIVE (client-signed `approveAgent`
 * confirmed via `hyperliquid.markAgentRegistered`) before any agent-signed action.
 * Agent registration is now CLIENT-driven (embedded master signs approveAgent),
 * so the server no longer lazily registers here — it only refuses if still PENDING.
 *
 * @throws NOT_FOUND if perps aren't enabled, BAD_REQUEST if the agent is PENDING.
 */
async function assertHyperliquidAgentReady(
  db: PoolDb,
  userId: string,
): Promise<void> {
  const credential = await db.query.userApiCredentials.findFirst({
    where: (creds, { eq, and }) =>
      and(eq(creds.userId, userId), eq(creds.provider, "hyperliquid")),
  });
  if (!credential) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Hyperliquid is not enabled. Enable Perps in Settings first.",
    });
  }
  if (credential.accountType !== HL_AGENT_REGISTERED) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Activate your trading agent first: fund your wallet and approve the agent to start trading.",
    });
  }
}

/**
 * Fail-closed error for order mutations whose rate limiter cannot be
 * consulted (Redis down or returning garbage). Distinct from the 429 so the
 * client can tell "slow down" apart from "the service is degraded, retry".
 */
function rateLimiterUnavailableError(): TRPCError {
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "The order rate limiter is temporarily unavailable. Please try again shortly.",
  });
}

export const ordersRouter = router({
  /**
   * Submit a new order
   */
  submit: protectedProcedure
    .input(orderSubmitSchema)
    .mutation(async ({ ctx, input }) => {
      // Rate limit check
      const redis = await getRedisClient(logger);
      const count = await redis.incrWithTtl(`rate_limit:orders:${ctx.userId}`, 1);
      if (count > 5) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded. Maximum 5 orders per second.",
        });
      }

      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "order");
      const existingOrder = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, clientOrderId),
        ),
      });
      if (existingOrder?.userId === ctx.userId) {
        assertManualCopySourceReplayMatches(
          (existingOrder as { manualCopySourceItemId?: string | null }).manualCopySourceItemId,
          input.copySourceItemId,
        );
        logger.info("api", "[Orders] Idempotency hit; returning existing order");
        if (!existingOrder.brokerOrderId) {
          return pendingSyncResponse(
            existingOrder.id,
            "Order outcome is still syncing with Alpaca",
          );
        }
        return {
          success: true,
          orderId: existingOrder.id,
          brokerOrderId: existingOrder.brokerOrderId || "",
          message: "Order already submitted (idempotency hit)",
        };
      }

      const resolvedDirection = resolveOrderDirection(input.tradeAction, input.direction);
      const manualCopySource: ResolvedManualCopySource | null = input.copySourceItemId
        ? await resolveManualCopySource(ctx.db, ctx.session, input.copySourceItemId, {
            assetType: input.assetType,
            symbol: input.symbol,
            tradeAction: input.tradeAction,
            direction: resolvedDirection,
            signalId: input.signalId,
          })
        : null;
      const manualCopyProvenance = manualCopySource
        ? manualCopyOrderProvenance(manualCopySource, input.notes)
        : null;

      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });

      // Build the symbol (options have special format)
      let tradingSymbol = input.symbol;
      if (
        input.assetType === "OPTION" &&
        input.optionExpiration &&
        input.optionStrike &&
        input.optionType
      ) {
        tradingSymbol = buildOptionsSymbol(
          input.symbol,
          input.optionExpiration,
          input.optionStrike,
          input.optionType
        );
        logger.info("api", `[Orders] Building options order`, {
          underlying: input.symbol,
          expiration: input.optionExpiration,
          strike: input.optionStrike,
          type: input.optionType,
          tradingSymbol: tradingSymbol,
        });
      }

      logger.info("api", `[Orders] Order submission`, {
        symbol: input.symbol,
        tradingSymbol,
        assetType: input.assetType,
        orderType: input.orderType,
        side: getAlpacaSide(input.tradeAction),
        quantity: input.quantity,
        limitPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        timeInForce: input.timeInForce,
      });

      // Verify signal existence if provided
      let validatedSignalId = manualCopyProvenance?.signalId ?? input.signalId;
      if (!manualCopySource && input.signalId) {
        const signal = await ctx.db.query.signals.findFirst({
          where: eq(schema.signals.id, input.signalId),
        });

        if (!signal) {
          console.warn(`Signal ID ${input.signalId} not found. Decoupling order from signal.`);
          validatedSignalId = undefined;
        }
      }

      // Create order record first
      const [order] = await ctx.db
        .insert(schema.orders)
        .values({
          userId: ctx.userId,
          signalId: manualCopyProvenance
            ? manualCopyProvenance.signalId
            : validatedSignalId,
          symbol: input.symbol,
          assetType: input.assetType,
          orderType: input.orderType,
          tradeAction: input.tradeAction,
          // Position intent is authoritative for every action. In particular,
          // a caller omitting the optional direction on SellShort/BuyToCover
          // must still persist a short row for the exact social/order join.
          direction: resolvedDirection,
          quantity: input.quantity,
          maxRisk: input.maxRisk?.toString(),
          limitPrice: input.limitPrice?.toString(),
          stopPrice: input.stopPrice?.toString(),
          stopMarketPrice: input.stopMarketPrice?.toString(),
          priceTrigger: input.priceTrigger?.toString(),
          optionExpiration: input.optionExpiration,
          optionStrike: input.optionStrike?.toString(),
          optionType: input.optionType,
          skipPresetTp: input.skipPresetTp,
          forceThreeContracts: input.forceThreeContracts,
          notes: manualCopyProvenance ? manualCopyProvenance.notes : input.notes,
          ...(manualCopyProvenance
            ? {
                manualCopySourceItemId: manualCopyProvenance.manualCopySourceItemId,
                manualCopySourceOrderId: manualCopyProvenance.manualCopySourceOrderId,
                copySourceLabel: manualCopyProvenance.copySourceLabel,
              }
            : {}),
          brokerAccountId: credentials.accountId || null,
          brokerCredentialId: credentials.credentialId || null,
          status: "PENDING",
          clientOrderId,
          brokerClientOrderId: clientOrderId,
        })
        .returning();

      if (!order) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create order record",
        });
      }

      // Submit to Alpaca
      try {


        const side = getAlpacaSide(input.tradeAction);
        const type = getAlpacaType(input.orderType);
        const timeInForce = resolveAlpacaTimeInForce(input);

        const orderRequest: CreateOrderRequest = {
          symbol: tradingSymbol,
          qty: input.quantity,
          side: side,
          type: type,
          time_in_force: timeInForce,
          client_order_id: clientOrderId,
        };

        if (input.limitPrice && (type === "limit" || type === "stop_limit")) {
          orderRequest.limit_price = input.limitPrice;
        }

        if (input.stopPrice && (type === "stop" || type === "stop_limit")) {
          orderRequest.stop_price = input.stopPrice;
        }

        // Options-specific guard rails (single-leg only).
        if (input.assetType === "OPTION") {
          // Options cannot trade in extended hours and must NOT carry an order_class.
          orderRequest.extended_hours = false;

          // Optionally set position_intent based on the trade action.
          // BuyToOpen/SellToOpen/SellToClose/BuyToClose map directly; other
          // (equity-style) actions are left unset.
          switch (input.tradeAction) {
            case "BuyToOpen":
              orderRequest.position_intent = "buy_to_open";
              break;
            case "SellToOpen":
              orderRequest.position_intent = "sell_to_open";
              break;
            case "SellToClose":
              orderRequest.position_intent = "sell_to_close";
              break;
            case "BuyToClose":
              orderRequest.position_intent = "buy_to_close";
              break;
            default:
              break;
          }
        }


        // Submit
        logger.info("api", "[Orders] Submitting to Alpaca", { orderRequest });
        const result = await client.createOrder(orderRequest);
        logger.info("api", "[Orders] Alpaca Response", { orderId: result ? result.id : "No result" });

        const acceptancePersisted = await persistBrokerAcceptance(
          ctx.db,
          order,
          result.id,
        );
        if (!acceptancePersisted.accepted) {
          return brokerAcceptanceFailureResponse(
            acceptancePersisted,
            order.id,
            result.id,
            "Alpaca accepted the order; local status is syncing",
          );
        }

        // Live trades always publish. Alpaca paper/SIM trades never do; the
        // helper owns that venue-safety rule and never throws (audit M12).
        await publishSocialTrade(ctx.db, ctx.userId, {
          symbol: input.symbol,
          side: getAlpacaSide(input.tradeAction),
          qty: input.quantity,
          orderType: getAlpacaType(input.orderType),
          assetType: input.assetType,
          limitPrice: input.limitPrice,
          brokerOrderId: result.id,
          orderId: order.id,
        }, credentials.accountType);

        return {
          success: true,
          orderId: order.id,
          brokerOrderId: result.id,
          message: "Order submitted successfully",
        };
      } catch (error: any) {
        if (isAlpacaAmbiguousOrderError(error)) {
          logger.warn("api", "[Orders] Alpaca outcome ambiguous; reconciling local order", {
            orderId: order.id,
            symbol: tradingSymbol,
          });
          return resolveAmbiguousOrderResponse(ctx.db, order, {
            operation: "order",
            reason: "Alpaca submission outcome is ambiguous",
            message: "Order outcome is syncing with Alpaca",
          });
        }

        // Extract the actual Alpaca error response body
        const alpacaErrorBody = error?.response?.data?.message || error?.response?.data || null;
        const errorMessage = alpacaErrorBody
          ? `Alpaca: ${typeof alpacaErrorBody === 'string' ? alpacaErrorBody : JSON.stringify(alpacaErrorBody)}`
          : (error instanceof Error ? error.message : "Unknown error");

        logger.error("api", "[Orders] Order submission failed", {
          symbol: tradingSymbol,
          assetType: input.assetType,
          error: errorMessage,
          status: error?.response?.status,
          responseBody: alpacaErrorBody,
        });

        // Record the raw error on the order regardless of which friendly
        // message we ultimately surface.
        await markOrderRejected(ctx.db, order, {
          status: "REJECTED",
          notes: `${input.notes || ""} | Error: ${errorMessage}`,
        });

        // Connection/socket failures get the broker-unreachable copy (T23),
        // even for options — there's no order-specific advice to give here.
        if (isConnectionError(error)) {
          throw friendlyOrderError(error, "submitting the order");
        }

        // Provide more helpful, options-specific error messages for common issues.
        if (input.assetType === "OPTION") {
          let userMessage = errorMessage;
          if (errorMessage.includes("not found") || errorMessage.includes("404")) {
            userMessage = `Options contract not found: ${tradingSymbol}. Please verify the expiration date (${input.optionExpiration}) and strike price (${input.optionStrike}) are correct, and that this contract is still trading.`;
          } else if (errorMessage.includes("options trading is not allowed")) {
            userMessage = "Options trading is not enabled on your Alpaca account. Please enable options trading in your Alpaca dashboard.";
          } else if (error?.response?.status === 422 || errorMessage.includes("422")) {
            userMessage = `Options order rejected by Alpaca: ${alpacaErrorBody || 'Invalid order parameters'}. Check that the expiration date is a valid trading day (options expire on Fridays), and the contract exists.`;
          }

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: userMessage,
          });
        }

        // Equity path -> friendly mapping (422/4xx reject, generic fallback).
        throw friendlyOrderError(error, "submitting the order");
      }
    }),

  /**
   * Get user's order history
   */
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        status: z.enum([
          "PENDING", "SYNCING", "SUBMITTED", "FILLED", "PARTIAL",
          "CANCELLED", "REJECTED", "EXPIRED"
        ]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const orders = await ctx.db.query.orders.findMany({
        where: (orders, { eq, and }) => {
          const conditions = [eq(orders.userId, ctx.userId)];
          if (input.status) {
            conditions.push(eq(orders.status, input.status));
          }
          return and(...conditions);
        },
        orderBy: [desc(schema.orders.createdAt)],
        limit: input.limit,
      });

      return orders;
    }),

  /**
   * Get a single order by ID
   */
  get: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const order = await ctx.db.query.orders.findFirst({
        where: (orders, { eq, and }) =>
          and(eq(orders.id, input.orderId), eq(orders.userId, ctx.userId)),
      });

      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Order not found",
        });
      }

      return order;
    }),

  /**
   * Look up an idempotent order intent without requiring the caller to have
   * received the original mutation response (which may be lost after the venue
   * accepted the request). Returning null keeps client reconciliation polling
   * cheap while the server is still before the local row reservation.
   */
  getByClientOrderId: protectedProcedure
    .input(z.object({ clientOrderId: z.string().min(1).max(128) }))
    .query(async ({ ctx, input }) => {
      const order = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, input.clientOrderId),
        ),
        columns: {
          id: true,
          status: true,
          brokerOrderId: true,
          statusUpdatedAt: true,
        },
      });

      return order ?? null;
    }),

  /**
   * Cancel a pending order
   */
  cancel: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const order = await ctx.db.query.orders.findFirst({
        where: (orders, { eq, and }) =>
          and(eq(orders.id, input.orderId), eq(orders.userId, ctx.userId)),
      });

      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Order not found",
        });
      }

      // This mutation only ever talks to Alpaca. Hyperliquid perp rows
      // (submitPerp / the copy-mirror perp path) are ordinary `orders` rows
      // that satisfy every check below, but their brokerOrderId is a
      // Hyperliquid numeric oid, not an Alpaca UUID, and brokerCredentialId
      // (when set) points at a provider='hyperliquid' credential. Routing
      // either shape into getAlpacaClient()/client.cancelOrder() below
      // either 404s against Alpaca or resolves the wrong credentials, all
      // while the leveraged order stays live at Hyperliquid. Reject before
      // any of that so the caller is pointed at the correct endpoint.
      if (order.assetType === "PERP" || order.venue === "hyperliquid") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Hyperliquid perp orders must be cancelled via orders.cancelPerp (coin + numeric order id).",
        });
      }

      if (order.status === "PENDING" || order.status === "SYNCING") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Order is still reconciling with Alpaca. Retry cancellation after it syncs.",
        });
      }

      if (order.status !== "SUBMITTED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Can only cancel submitted orders",
        });
      }

      if (!order.brokerOrderId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Broker order ID is still reconciling. Retry cancellation after it syncs.",
        });
      }

      // If order was submitted to Broker, cancel it
      try {
        const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
          accountId: order.brokerAccountId || undefined,
          credentialId: order.brokerCredentialId || undefined,
        });
        await client.cancelOrder(order.brokerOrderId);
      } catch (error) {
        logger.error("api", "Failed to cancel Alpaca order", { error });
        throw friendlyOrderError(error, "canceling the order");
      }

      // Update order status in database
      const cancelled = await ctx.db
        .update(schema.orders)
        .set({ status: "CANCELLED" })
        .where(and(
          eq(schema.orders.id, input.orderId),
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.brokerOrderId, order.brokerOrderId),
          orderStatusTransitionCondition("CANCELLED"),
        ))
        .returning({ id: schema.orders.id });

      if (cancelled.length !== 1) {
        let authoritative: AuthoritativeOrderState | null = null;
        try {
          authoritative = await readAuthoritativeOrderState(ctx.db, order);
        } catch (readError) {
          logger.error("api", "[Orders] Failed to reread canceled order state", {
            orderId: input.orderId,
            error: readError instanceof Error ? readError.message : String(readError),
          });
        }
        if (authoritative) {
          return authoritativeOrderResponse(
            authoritative,
            order.brokerOrderId,
            "Alpaca canceled the order; another writer owns the local outcome",
          );
        }

        try {
          const markedSyncing = await markOrderSyncing(
            ctx.db,
            order,
            "Alpaca canceled the order; local cancellation persistence is syncing",
            order.brokerOrderId,
          );
          if (!markedSyncing) {
            logger.warn("api", "[Orders] Cancellation reconciliation CAS did not win", {
              orderId: input.orderId,
              returnedRows: cancelled.length,
            });
          }
        } catch (syncError) {
          logger.error("api", "[Orders] Failed to mark canceled order for reconciliation", {
            orderId: input.orderId,
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
        }
        try {
          authoritative = await readAuthoritativeOrderState(ctx.db, order);
        } catch (readError) {
          logger.error("api", "[Orders] Failed to reread cancellation reconciliation state", {
            orderId: input.orderId,
            error: readError instanceof Error ? readError.message : String(readError),
          });
        }
        if (authoritative) {
          return authoritativeOrderResponse(
            authoritative,
            order.brokerOrderId,
            "Alpaca canceled the order; local status is syncing",
          );
        }
        return pendingSyncResponse(
          input.orderId,
          "Alpaca canceled the order; local status is syncing",
          order.brokerOrderId,
          "SYNCING",
        );
      }

      return { success: true };
    }),

  /**
   * Submit a Bracket Order (Entry + Take Profit + Stop Loss)
   *
   * This creates a single entry order with attached TP and SL.
   * When entry fills, both exit orders become active.
   * When either exit fills, the other is cancelled.
   */
  submitBracket: protectedProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        assetType: z.enum(["EQUITY", "OPTION"]).default("EQUITY"),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().int().positive(),
        orderType: z.enum(["market", "limit"]),
        limitPrice: z.number().positive().optional(),
        takeProfitPrice: z.number().positive(),
        stopLossPrice: z.number().positive(),
        stopLossLimitPrice: z.number().positive().optional(),
        timeInForce: z.enum(["day", "gtc"]).default("day"),
        // Options fields
        optionExpiration: optionExpirationSchema,
        optionStrike: z.number().positive().optional(),
        optionType: z.enum(["CALL", "PUT"]).optional(),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
        idempotencyKey: clientOrderIdSchema.optional(),
        /** Canonical copy-trade feed item, verified server-side when supplied. */
        copySourceItemId: copySourceItemIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Bracket/OCO order_class is NOT supported for options — Alpaca rejects it.
      if (input.assetType === "OPTION") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Bracket/OCO orders are not supported for options",
        });
      }

      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "bracket");
      const existingOrder = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, clientOrderId),
        ),
      });
      if (existingOrder?.userId === ctx.userId) {
        assertManualCopySourceReplayMatches(
          (existingOrder as { manualCopySourceItemId?: string | null }).manualCopySourceItemId,
          input.copySourceItemId,
        );
        if (!existingOrder.brokerOrderId) {
          return {
            ...pendingSyncResponse(existingOrder.id, "Bracket order outcome is syncing with Alpaca"),
            orders: [],
          };
        }
        return {
          success: true,
          replayed: true,
          message: `Bracket order already submitted for ${input.symbol}`,
          orders: [{ orderId: existingOrder.brokerOrderId, legs: [] }],
        };
      }

      const manualCopySource: ResolvedManualCopySource | null = input.copySourceItemId
        ? await resolveManualCopySource(ctx.db, ctx.session, input.copySourceItemId, {
            assetType: input.assetType,
            symbol: input.symbol,
            tradeAction: input.side === "buy" ? "Buy" : "SellShort",
            direction: input.side === "buy" ? "long" : "short",
          })
        : null;
      const manualCopyProvenance = manualCopySource
        ? manualCopyOrderProvenance(manualCopySource, null)
        : null;

      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });

      const [localOrder] = await ctx.db
        .insert(schema.orders)
        .values({
          userId: ctx.userId,
          symbol: input.symbol,
          assetType: input.assetType,
          orderType: input.orderType === "limit" ? "Limit" : "Market",
          // Options are rejected above; sell-side equity bracket = short entry.
          tradeAction: input.side === "buy" ? "Buy" : "SellShort",
          direction: input.side === "buy" ? "long" : "short",
          quantity: input.quantity,
          limitPrice: input.takeProfitPrice.toString(),
          stopMarketPrice: input.stopLossPrice.toString(),
          ...(manualCopyProvenance
            ? {
                signalId: manualCopyProvenance.signalId,
                manualCopySourceItemId: manualCopyProvenance.manualCopySourceItemId,
                manualCopySourceOrderId: manualCopyProvenance.manualCopySourceOrderId,
                copySourceLabel: manualCopyProvenance.copySourceLabel,
              }
            : {}),
          brokerAccountId: credentials.accountId || null,
          brokerCredentialId: credentials.credentialId || null,
          status: "PENDING",
          clientOrderId,
          brokerClientOrderId: clientOrderId,
        })
        .returning();

      if (!localOrder) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create bracket order record",
        });
      }

      try {
        // Options are blocked above (bracket/OCO unsupported), so this is the
        // equity path only — the trading symbol is the plain ticker.
        const tradingSymbol = input.symbol;

        const order = await client.createBracketOrder({
          symbol: tradingSymbol,
          qty: input.quantity,
          side: input.side,
          type: input.orderType,
          time_in_force: input.timeInForce,
          order_class: "bracket",
          limit_price: input.limitPrice,
          take_profit: {
            limit_price: input.takeProfitPrice,
          },
          stop_loss: {
            stop_price: input.stopLossPrice,
            limit_price: input.stopLossLimitPrice,
          },
          client_order_id: clientOrderId,
        });

        const acceptancePersisted = await persistBrokerAcceptance(
          ctx.db,
          localOrder,
          order.id,
        );
        if (!acceptancePersisted.accepted) {
          return {
            ...brokerAcceptanceFailureResponse(
              acceptancePersisted,
              localOrder.id,
              order.id,
              "Alpaca accepted the bracket order; local status is syncing",
            ),
            orders: [],
          };
        }

        logger.info("api", `[Orders] Bracket order created for ${input.symbol}`, { orderId: order.id });

        // Fire-and-forget social publish (audit M12).
        await publishSocialTrade(ctx.db, ctx.userId, {
          symbol: input.symbol,
          side: getAlpacaSide(input.side),
          qty: input.quantity,
          orderType: getAlpacaType(input.orderType),
          assetType: input.assetType,
          limitPrice: input.limitPrice,
          brokerOrderId: order.id,
          orderId: localOrder.id,
          label: "Bracket trade",
        }, credentials.accountType);

        return {
          success: true,
          message: `Bracket order submitted for ${input.symbol}`,
          orders: [{
            orderId: order.id,
            legs: order.legs?.map((leg) => ({
              id: leg.id,
              type: leg.order_type,
              side: leg.side,
              status: leg.status,
            })),
          }],
        };
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) {
          return {
            ...await resolveAmbiguousOrderResponse(ctx.db, localOrder, {
              operation: "bracket order",
              reason: "Alpaca bracket submission is ambiguous",
              message: "Bracket order outcome is syncing with Alpaca",
            }),
            orders: [],
          };
        }
        await markOrderRejected(ctx.db, localOrder);
        throw friendlyOrderError(error, "submitting the bracket order");
      }
    }),

  /**
   * Submit an entry order with a one-click exit plan ("Smart Exit").
   *
   * Places a single entry order for the full quantity and persists a resolved
   * exit plan (fixed take-profit leg(s) + a trailing-stop runner). The plan is
   * stored as `pending` and attached to the position by the OrderSyncPoller
   * worker once the entry fills — a trailing-stop sell can only be placed
   * against held shares, so it cannot ride along with the entry order.
   *
   * Equity-only: Alpaca rejects bracket/trailing constructs for options.
   */
  submitWithExitPlan: protectedProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        side: z.enum(["buy", "sell"]),
        direction: z.enum(["long", "short"]).default("long"),
        quantity: z.number().int().positive(),
        orderType: z.enum(["market", "limit"]),
        limitPrice: z.number().positive().optional(),
        timeInForce: z.enum(["day", "gtc"]).default("gtc"),
        // Recorded for reference / risk readouts; the protective stop itself is
        // placed by the trailing runner once the plan attaches.
        maxRisk: z.number().positive().optional(),
        stopMarketPrice: z.number().positive().optional(),
        // Resolved exit plan. Take-profit prices are absolute; quantities are
        // re-derived against the actual filled qty at attach time.
        // Capped at 10 legs to match submitOCO: each leg becomes its own
        // broker order when the exit plan attaches.
        takeProfits: z
          .array(
            z.object({
              price: z.number().positive(),
              qtyFraction: z.number().gt(0).max(1),
            })
          )
          .max(10)
          .default([]),
        trailingStop: z
          .object({ trailPercent: z.number().positive() })
          .optional(),
        notes: notesSchema,
        signalId: z.string().uuid().optional(),
        /** Canonical copy-trade feed item, verified server-side when supplied. */
        copySourceItemId: copySourceItemIdSchema.optional(),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
        idempotencyKey: clientOrderIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // An exit plan needs at least ONE protective leg. Stop-only is the newest
      // variant: no take-profit and no trailing runner, just a broker stop that
      // attaches when the entry fills. Submitted as an Alpaca OTO order so the
      // stop-loss child is placed atomically with the entry (no post-fill
      // worker attach needed).
      const isStopOnly =
        !!input.stopMarketPrice &&
        !input.trailingStop &&
        input.takeProfits.length === 0;
      if (!input.trailingStop && input.takeProfits.length === 0 && !isStopOnly) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "An exit plan needs at least a stop, a take-profit, or a trailing stop",
        });
      }

      const allocatedFraction = input.takeProfits.reduce(
        (total, takeProfit) => total + takeProfit.qtyFraction,
        0,
      );
      if (allocatedFraction > 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Take-profit quantities cannot exceed the filled position quantity",
        });
      }
      if (input.trailingStop && allocatedFraction >= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A trailing runner requires a positive quantity after take-profit allocation",
        });
      }

      // A fixed stop price is only placed as the stop-loss leg of OCO take-profit
      // orders. If there are no take-profit legs, the stop price has nowhere to go —
      // the trailing runner carries its own moving stop and Alpaca won't accept two
      // separate sell orders against the same shares. Reject early so the user isn't
      // left thinking the fixed stop is active when it isn't.
      if (input.stopMarketPrice && input.trailingStop && input.takeProfits.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A fixed stop price can only be combined with a trailing stop when take-profit targets are also set. " +
            "The stop price protects the take-profit legs (via OCO); the trailing stop covers the runner shares independently. " +
            "Either add at least one take-profit target, or remove the fixed stop price.",
        });
      }

      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "smart");
      const existingOrder = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, clientOrderId),
        ),
      });
      if (existingOrder?.userId === ctx.userId) {
        assertManualCopySourceReplayMatches(
          (existingOrder as { manualCopySourceItemId?: string | null }).manualCopySourceItemId,
          input.copySourceItemId,
        );
        if (!existingOrder.brokerOrderId) {
          return pendingSyncResponse(
            existingOrder.id,
            "Smart Exit order outcome is syncing with Alpaca",
          );
        }
        return {
          success: true,
          orderId: existingOrder.id,
          brokerOrderId: existingOrder.brokerOrderId,
          message: `Order already submitted for ${input.symbol}`,
        };
      }

      const manualCopySource: ResolvedManualCopySource | null = input.copySourceItemId
        ? await resolveManualCopySource(ctx.db, ctx.session, input.copySourceItemId, {
            assetType: "EQUITY",
            symbol: input.symbol,
            tradeAction: input.side === "buy"
              ? "Buy"
              : input.direction === "short"
                ? "SellShort"
                : "Sell",
            direction: input.direction,
            signalId: input.signalId,
          })
        : null;
      const manualCopyProvenance = manualCopySource
        ? manualCopyOrderProvenance(manualCopySource, input.notes)
        : null;

      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });

      // Exit orders close the position: sell to close a long, buy to cover a short.
      const exitSide: "buy" | "sell" = input.direction === "long" ? "sell" : "buy";

      const exitPlan: schema.OrderExitPlan = {
        exitSide,
        takeProfits: input.takeProfits,
        trailingStop: input.trailingStop,
        // Used to OCO the take-profit legs so those shares keep a hard stop.
        stopPrice: input.stopMarketPrice,
      };

      // Create the local order record up front so we always have a row to
      // reconcile against, even if the Alpaca call fails.
      const [order] = await ctx.db
        .insert(schema.orders)
        .values({
          userId: ctx.userId,
          signalId: manualCopyProvenance
            ? manualCopyProvenance.signalId
            : input.signalId || null,
          symbol: input.symbol,
          assetType: "EQUITY",
          orderType: input.orderType === "limit" ? "Limit" : "Market",
          tradeAction: input.side === "buy" ? "Buy" :
            (input.direction === "short" ? "SellShort" : "Sell"),
          direction: input.direction,
          quantity: input.quantity,
          limitPrice: input.limitPrice?.toString() ?? null,
          maxRisk: input.maxRisk?.toString() ?? null,
          stopMarketPrice: input.stopMarketPrice?.toString() ?? null,
          brokerAccountId: credentials.accountId || null,
          brokerCredentialId: credentials.credentialId || null,
          status: "PENDING",
          notes: manualCopyProvenance ? manualCopyProvenance.notes : input.notes ?? null,
          ...(manualCopyProvenance
            ? {
                manualCopySourceItemId: manualCopyProvenance.manualCopySourceItemId,
                manualCopySourceOrderId: manualCopyProvenance.manualCopySourceOrderId,
                copySourceLabel: manualCopyProvenance.copySourceLabel,
              }
            : {}),
          exitPlan,
          // Stop-only OCO ships as an Alpaca OTO order — the broker attaches
          // the stop-loss child atomically with the entry, so the exit-plan
          // worker has nothing to do. Marking "attached" up front prevents
          // OrderSyncPoller.attachExitPlan from firing (it gates on "pending").
          exitPlanStatus: isStopOnly ? "attached" : "pending",
          clientOrderId,
          brokerClientOrderId: clientOrderId,
        })
        .returning();

      if (!order) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create order record",
        });
      }

      try {
        const entryOrder = await client.createOrder({
          symbol: input.symbol,
          qty: input.quantity,
          side: input.side,
          type: input.orderType,
          time_in_force: input.timeInForce,
          client_order_id: clientOrderId,
          ...(input.limitPrice && input.orderType === "limit"
            ? { limit_price: input.limitPrice }
            : {}),
          // Stop-only variant: wrap the entry in an Alpaca OTO so a stop-loss
          // child order is placed against the filled shares atomically. Alpaca
          // handles the stop broker-side; no exit-plan worker involvement.
          ...(isStopOnly
            ? {
                order_class: "oto" as const,
                stop_loss: { stop_price: input.stopMarketPrice! },
              }
            : {}),
        });

        const acceptancePersisted = await persistBrokerAcceptance(
          ctx.db,
          order,
          entryOrder.id,
        );
        if (!acceptancePersisted.accepted) {
          return brokerAcceptanceFailureResponse(
            acceptancePersisted,
            order.id,
            entryOrder.id,
            "Alpaca accepted the Smart Exit order; local status is syncing",
          );
        }

        logger.info("api", `[Orders] Exit-plan entry submitted for ${input.symbol}`, {
          orderId: entryOrder.id,
          takeProfits: input.takeProfits.length,
          trailing: !!input.trailingStop,
        });

        // Fire-and-forget social publish (audit M12).
        await publishSocialTrade(ctx.db, ctx.userId, {
          symbol: input.symbol,
          side: input.side,
          qty: input.quantity,
          orderType: input.orderType,
          assetType: "EQUITY",
          limitPrice: input.limitPrice,
          brokerOrderId: entryOrder.id,
          orderId: order.id,
          label: "Exit-plan trade",
        }, credentials.accountType);

        return {
          success: true,
          orderId: order.id,
          brokerOrderId: entryOrder.id,
          message: isStopOnly
            ? `Order submitted for ${input.symbol}. Broker stop attached (fires when entry fills).`
            : `Order submitted for ${input.symbol}. Exit plan attaches once it fills.`,
        };
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) {
          return resolveAmbiguousOrderResponse(ctx.db, order, {
            operation: "Smart Exit order",
            reason: "Alpaca Smart Exit submission is ambiguous",
            message: "Smart Exit order outcome is syncing with Alpaca",
          });
        }
        await markOrderRejected(ctx.db, order);
        throw friendlyOrderError(error, "submitting the order");
      }
    }),

  /**
   * Submit an OCO (One-Cancels-Other) Exit Strategy
   * Specifically built for scaling out of positions with multiple Take Profits.
   * Creates one or more independent OCO exit orders.
   */
  submitOCO: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(50).transform((val) => val.toUpperCase()),
        quantity: z.number().int().positive(),
        takeProfits: z
          .array(
            z.object({
              price: z.number().positive(),
              quantity: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(10),
        stopLossPrice: z.number().positive(),
        timeInForce: z.enum(["day", "gtc"]).default("gtc"),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
        idempotencyKey: clientOrderIdSchema.optional(),
      }).superRefine((input, ctx) => {
        const allocatedQuantity = input.takeProfits.reduce(
          (total, takeProfit) => total + takeProfit.quantity,
          0,
        );
        if (allocatedQuantity > input.quantity) {
          ctx.addIssue({
            code: "custom",
            path: ["takeProfits"],
            message: "Take-profit quantities cannot exceed the total quantity.",
          });
        }
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // submitOCO is equity-only (records hardcode assetType:"EQUITY"); OCO
      // order_class is not supported for options, so no options branch here.
      //
      // Rate limit: this handler places one Alpaca order per take-profit leg,
      // so charge the shared per-user budget by the leg count atomically and
      // BEFORE any broker call. A ten-leg request therefore consumes ten of
      // the five-orders-per-second budget, not one. Unlike the fail-open
      // global limiter, a Redis outage here fails closed with a distinct,
      // friendly error (mirrors the chat rate limiter's 503 behavior) instead
      // of surfacing an opaque 500 or letting the burst through.
      const legCount = input.takeProfits.length;
      let count: number;
      try {
        const redis = await getRedisClient(logger);
        count = await redis.incrByWithTtl(
          `rate_limit:orders:${ctx.userId}`,
          legCount,
          1,
        );
      } catch (error) {
        logger.warn("api", "[Orders] Rate limiter unavailable; rejecting OCO submission", {
          error: error instanceof Error ? error.message : String(error),
          userId: ctx.userId,
        });
        throw rateLimiterUnavailableError();
      }
      // The Redis helper returns 0 (instead of throwing) on command errors;
      // treat that sentinel, and any non-integer, as limiter-unavailable.
      if (!Number.isSafeInteger(count) || count < legCount) {
        logger.warn("api", "[Orders] Rate limiter returned an invalid count; rejecting OCO submission", {
          count,
          userId: ctx.userId,
        });
        throw rateLimiterUnavailableError();
      }
      if (count > 5) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Rate limit exceeded. Maximum 5 orders per second (this OCO request counts as ${legCount} order${legCount === 1 ? "" : "s"}).`,
        });
      }

      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });
      const submittedOrderIds: string[] = [];
      let replayed = true;
      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "oco");

      for (const [index, tp] of input.takeProfits.entries()) {
        const legClientOrderId = deriveClientOrderId(clientOrderId, `oco${index}`);
        const existingOrder = await ctx.db.query.orders.findFirst({
          where: and(
            eq(schema.orders.userId, ctx.userId),
            eq(schema.orders.clientOrderId, legClientOrderId),
          ),
        });
        if (existingOrder?.userId === ctx.userId) {
          if (!existingOrder.brokerOrderId) {
            return {
              ...pendingSyncResponse(existingOrder.id, "OCO order outcome is syncing with Alpaca"),
              orders: submittedOrderIds,
            };
          }
          submittedOrderIds.push(existingOrder.brokerOrderId);
          continue;
        }

        replayed = false;
        const [localOrder] = await ctx.db
          .insert(schema.orders)
          .values({
            userId: ctx.userId,
            symbol: input.symbol,
            assetType: "EQUITY",
            orderType: "Limit",
            tradeAction: "Sell",
            direction: "long",
            quantity: tp.quantity,
            limitPrice: tp.price.toString(),
            stopMarketPrice: input.stopLossPrice.toString(),
            brokerAccountId: credentials.accountId || null,
            brokerCredentialId: credentials.credentialId || null,
            status: "PENDING",
            clientOrderId: legClientOrderId,
            brokerClientOrderId: legClientOrderId,
          })
          .returning();
        if (!localOrder) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create OCO order record",
          });
        }

        try {
          // Send an OCO exit order
          // Note: In Alpaca, OCO orders require the main order to be one of the exit conditions (usually limit/TP),
          // with the stop_loss object handling the other exit condition.
          const order = await client.createOrder({
            symbol: input.symbol,
            qty: tp.quantity,
            side: "sell", // Assume sell to close long position from UI
            type: "limit",
            time_in_force: input.timeInForce,
            limit_price: tp.price,
            order_class: "oco",
            stop_loss: {
              stop_price: input.stopLossPrice,
            },
            client_order_id: legClientOrderId,
          });
          
          const acceptancePersisted = await persistBrokerAcceptance(
            ctx.db,
            localOrder,
            order.id,
          );
          if (!acceptancePersisted.accepted) {
            return {
              ...brokerAcceptanceFailureResponse(
                acceptancePersisted,
                localOrder.id,
                order.id,
                "Alpaca accepted the OCO order; local status is syncing",
              ),
              orders: submittedOrderIds,
            };
          }
          submittedOrderIds.push(order.id);
        } catch (error) {
          if (isAlpacaAmbiguousOrderError(error)) {
            return {
              ...await resolveAmbiguousOrderResponse(ctx.db, localOrder, {
                operation: "OCO order",
                reason: "Alpaca OCO submission is ambiguous",
                message: "OCO order outcome is syncing with Alpaca",
              }),
              orders: submittedOrderIds,
            };
          }
          await markOrderRejected(ctx.db, localOrder);
          throw friendlyOrderError(error, "submitting the OCO order");
        }
      }

      logger.info("api", `[Orders] Submitted ${submittedOrderIds.length} OCO exit orders for ${input.symbol}`);

      return {
        success: true,
        replayed,
        message: `Successfully submitted ${submittedOrderIds.length} OCO order(s) for ${input.symbol}`,
        orders: submittedOrderIds,
      };
    }),

  /**
   * Submit a Trailing Stop Order
   */
  submitTrailingStop: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(50).transform((val) => val.toUpperCase()),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().int().positive(),
        trailPrice: z.number().positive().optional(),
        trailPercent: z.number().positive().optional(),
        timeInForce: z.enum(["day", "gtc"]).default("gtc"),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
        idempotencyKey: clientOrderIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Must have either trail_price or trail_percent
      if (!input.trailPrice && !input.trailPercent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Must specify either trailPrice or trailPercent",
        });
      }

      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });
      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "trail");
      const existingOrder = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, clientOrderId),
        ),
      });
      if (existingOrder?.userId === ctx.userId) {
        if (!existingOrder.brokerOrderId) {
          return pendingSyncResponse(existingOrder.id, "Trailing-stop outcome is syncing with Alpaca");
        }
        return {
          success: true,
          replayed: true,
          orderId: existingOrder.brokerOrderId,
          message: `Trailing stop already submitted for ${input.symbol}`,
          trailPrice: null,
          trailPercent: null,
        };
      }

      const [localOrder] = await ctx.db
        .insert(schema.orders)
        .values({
          userId: ctx.userId,
          symbol: input.symbol,
          assetType: "EQUITY",
          orderType: "StopMarket",
          // A trailing stop is always an exit: selling to close a long, or
          // buying to cover a short. Map side to the correct semantic action.
          tradeAction: input.side === "buy" ? "BuyToCover" : "Sell",
          direction: input.side === "buy" ? "short" : "long",
          quantity: input.quantity,
          brokerAccountId: credentials.accountId || null,
          brokerCredentialId: credentials.credentialId || null,
          status: "PENDING",
          clientOrderId,
          brokerClientOrderId: clientOrderId,
        })
        .returning();
      if (!localOrder) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create trailing-stop order record",
        });
      }

      try {
        const order = await client.createTrailingStopOrder({
          symbol: input.symbol,
          qty: input.quantity,
          side: input.side,
          type: "trailing_stop",
          time_in_force: input.timeInForce,
          trail_price: input.trailPrice,
          trail_percent: input.trailPercent,
          client_order_id: clientOrderId,
        });

        logger.info("api", "[Orders] Trailing stop order created", { orderId: order.id });
        const acceptancePersisted = await persistBrokerAcceptance(
          ctx.db,
          localOrder,
          order.id,
        );
        if (!acceptancePersisted.accepted) {
          return {
            ...brokerAcceptanceFailureResponse(
              acceptancePersisted,
              localOrder.id,
              order.id,
              "Alpaca accepted the trailing stop; local status is syncing",
            ),
            trailPrice: order.trail_price,
            trailPercent: order.trail_percent,
          };
        }

        // Fire-and-forget social publish (audit M12).
        await publishSocialTrade(ctx.db, ctx.userId, {
          symbol: input.symbol,
          side: getAlpacaSide(input.side),
          qty: input.quantity,
          orderType: "trailing_stop",
          assetType: "EQUITY", // Trailing stops form UI currently equities only
          brokerOrderId: order.id,
          orderId: localOrder.id,
          label: "Trailing stop trade",
        }, credentials.accountType);

        return {
          success: true,
          orderId: order.id,
          message: `Trailing stop order submitted for ${input.symbol}`,
          trailPrice: order.trail_price,
          trailPercent: order.trail_percent,
        };
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) {
          return resolveAmbiguousOrderResponse(ctx.db, localOrder, {
            operation: "trailing-stop order",
            reason: "Alpaca trailing-stop submission is ambiguous",
            message: "Trailing-stop outcome is syncing with Alpaca",
          });
        }
        await markOrderRejected(ctx.db, localOrder);
        throw friendlyOrderError(error, "submitting the trailing stop");
      }
    }),

  /**
   * Get orders directly from Alpaca (real-time status)
   */
  listAlpacaOrders: protectedProcedure
    .input(
      z.object({
        status: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().min(1).max(500).default(50),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });

      try {
        const orders = await client.getOrders(input.status, input.limit, true);

        // Batch-fetch copy-trade attribution from local DB by client_order_id.
        const mirrorClientIds = orders
          .map((o) => o.client_order_id)
          .filter((id): id is string =>
            typeof id === "string" &&
            (id.startsWith("copymirror:") || id.startsWith("rst-copy-")),
          );

        const copySourceByClientId = new Map<string, string>();
        if (mirrorClientIds.length > 0) {
          const localOrders = await ctx.db
            .select({
              clientOrderId: schema.orders.clientOrderId,
              copySourceLabel: schema.orders.copySourceLabel,
            })
            .from(schema.orders)
            .where(and(
              eq(schema.orders.userId, ctx.userId),
              isNotNull(schema.orders.copySourceLabel),
            ));
          for (const row of localOrders) {
            if (row.clientOrderId && row.copySourceLabel) {
              copySourceByClientId.set(row.clientOrderId, row.copySourceLabel);
              copySourceByClientId.set(
                createBrokerClientOrderId(ctx.userId, row.clientOrderId, "copy"),
                row.copySourceLabel,
              );
            }
          }
        }

        return orders.map((order) => ({
          id: order.id,
          clientOrderId: order.client_order_id,
          symbol: order.symbol,
          assetClass: order.asset_class,
          side: order.side,
          type: order.type,
          orderClass: order.order_class,
          qty: order.qty ? parseFloat(order.qty) : null,
          filledQty: parseFloat(order.filled_qty),
          filledAvgPrice: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
          limitPrice: order.limit_price ? parseFloat(order.limit_price) : null,
          stopPrice: order.stop_price ? parseFloat(order.stop_price) : null,
          trailPrice: order.trail_price ? parseFloat(order.trail_price) : null,
          trailPercent: order.trail_percent ? parseFloat(order.trail_percent) : null,
          status: order.status,
          timeInForce: order.time_in_force,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          filledAt: order.filled_at,
          copySourceLabel: copySourceByClientId.get(order.client_order_id) ?? null,
          legs: (order.legs ?? []).map((leg) => ({
            id: leg.id,
            symbol: leg.symbol,
            side: leg.side,
            type: leg.type,
            qty: leg.qty ? parseFloat(leg.qty) : null,
            limitPrice: leg.limit_price ? parseFloat(leg.limit_price) : null,
            stopPrice: leg.stop_price ? parseFloat(leg.stop_price) : null,
            status: leg.status,
          })),
        }));
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch orders: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  /**
   * Cancel an Alpaca order by broker order ID
   */
  cancelAlpacaOrder: protectedProcedure
    .input(z.object({
      brokerOrderId: z.string(),
      credentialId: z.string().uuid().optional(),
      accountId: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });

      try {
        await client.cancelOrder(input.brokerOrderId);
        return {
          success: true,
          message: "Order cancelled",
        };
      } catch (error) {
        throw friendlyOrderError(error, "canceling the order");
      }
    }),

  /**
   * Cancel all open orders
   */
  cancelAllOrders: protectedProcedure
    .input(z.object({
      credentialId: z.string().uuid().optional(),
      accountId: z.string().optional(),
    }).optional())
    .mutation(async ({ ctx, input }) => {
    const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
      accountId: input?.accountId,
      credentialId: input?.credentialId,
    });

    try {
      await client.cancelAllOrders();
      return {
        success: true,
        message: "All orders cancelled",
      };
    } catch (error) {
      throw friendlyOrderError(error, "canceling all orders");
    }
  }),

  /**
   * Modify an existing Alpaca order (replace order)
   * Allows changing qty, limit_price, stop_price, trail, time_in_force
   */
  modifyAlpacaOrder: protectedProcedure
    .input(
      z.object({
        brokerOrderId: z.string(),
        qty: z.number().int().positive().optional(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trail: z.number().positive().optional(),
        timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).optional(),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        accountId: input.accountId,
        credentialId: input.credentialId,
      });

      try {
        const updates: any = {};
        if (input.qty !== undefined) updates.qty = input.qty;
        if (input.limitPrice !== undefined) updates.limit_price = input.limitPrice;
        if (input.stopPrice !== undefined) updates.stop_price = input.stopPrice;
        if (input.trail !== undefined) updates.trail = input.trail;
        if (input.timeInForce !== undefined) {
          const existingOrder = await client.getOrder(input.brokerOrderId);
          updates.time_in_force = resolveAlpacaReplaceTimeInForce({
            existingOrderType: existingOrder.type ?? existingOrder.order_type,
            existingSide: existingOrder.side,
            timeInForce: input.timeInForce,
          });
        }

        const order = await client.replaceOrder(input.brokerOrderId, updates);

        logger.info("api", "[Orders] Order modified", {
          orderId: input.brokerOrderId,
          updates,
        });

        return {
          success: true,
          orderId: order.id,
          message: "Order modified successfully",
        };
      } catch (error) {
        throw friendlyOrderError(error, "modifying the order");
      }
    }),

  // ==========================================================================
  // Hyperliquid perpetual futures (siblings — the equity `submit` above is
  // NEVER branched). Perp sizes are DECIMAL and write `quantityDecimal`; the
  // cloid reuses the `clientOrderId` unique index for idempotency.
  // ==========================================================================

  /**
   * Submit a Hyperliquid perp order (Market IoC or Limit). Rounds size to the
   * asset's szDecimals + attaches the builder code inside the wrapper. Records
   * an `orders` row with `venue="hyperliquid"` and the fractional size in
   * `quantityDecimal` (never the INTEGER `quantity`).
   */
  submitPerp: protectedProcedure
    .input(perpOrderSubmitSchema)
    .mutation(async ({ ctx, input }) => {
      // Rate limit check (shares the equity limiter key/semantics).
      const redis = await getRedisClient(logger);
      const count = await redis.incrWithTtl(`rate_limit:orders:${ctx.userId}`, 1);
      if (count > 5) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded. Maximum 5 orders per second.",
        });
      }

      // Idempotency: mirror the equity flow — the cloid IS the clientOrderId.
      const existingOrder = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, input.cloid),
        ),
      });
      if (existingOrder) {
        assertManualCopySourceReplayMatches(
          (existingOrder as { manualCopySourceItemId?: string | null }).manualCopySourceItemId,
          input.copySourceItemId,
        );
        if (
          existingOrder.status === "PENDING" ||
          existingOrder.status === "SYNCING"
        ) {
          logger.info(
            "api",
            `[Orders] Perp idempotency hit for cloid ${input.cloid}; reconciliation is still pending.`,
          );
          return {
            success: false as const,
            syncing: true as const,
            orderId: existingOrder.id,
            brokerOrderId: existingOrder.brokerOrderId || "",
            status: existingOrder.status,
            message: "The existing order request is still being confirmed with Hyperliquid.",
          };
        }

        if (
          existingOrder.status === "REJECTED" ||
          existingOrder.status === "CANCELLED" ||
          existingOrder.status === "EXPIRED"
        ) {
          logger.warn(
            "api",
            `[Orders] Perp idempotency hit for cloid ${input.cloid}, but existing order was ${existingOrder.status}.`,
          );
          return {
            success: false as const,
            syncing: false as const,
            orderId: existingOrder.id,
            brokerOrderId: existingOrder.brokerOrderId || "",
            status: existingOrder.status,
            message:
              `The previous order is ${existingOrder.status.toLowerCase()}. Submit a new order request.`,
          };
        }
        logger.info("api", `[Orders] Perp idempotency hit for cloid ${input.cloid}, returning existing order.`);
        return {
          success: true as const,
          orderId: existingOrder.id,
          brokerOrderId: existingOrder.brokerOrderId || "",
          status: existingOrder.status,
          message: "Order already submitted (idempotency hit)",
        };
      }

      const manualCopySource: ResolvedManualCopySource | null = input.copySourceItemId
        ? await resolveManualCopySource(ctx.db, ctx.session, input.copySourceItemId, {
            assetType: "PERP",
            coin: input.coin,
            isLong: input.isLong,
            reduceOnly: input.reduceOnly,
          })
        : null;

      // The trading agent must already be approved (client-signed approveAgent,
      // confirmed via hyperliquid.markAgentRegistered). Registration is now
      // CLIENT-driven, so we only refuse here if the agent is still PENDING.
      await assertHyperliquidAgentReady(ctx.db, ctx.userId);

      const { client, walletAddress } = await createHyperliquidExchangeClient(
        ctx.db,
        ctx.userId,
      );

      // Hyperliquid validates minimum notional against the venue-rounded size
      // and the payload price. Read the asset precision and, for Market orders,
      // a fresh mid before any state-changing venue call or local PENDING row.
      // Client mark data is never authoritative for this guard.
      const closePreflightSignal =
        input.reduceOnly && input.orderType === "Market"
          ? AbortSignal.timeout(PERP_CLOSE_PREFLIGHT_TIMEOUT_MS)
          : undefined;
      let asset;
      try {
        asset = await client.resolveAsset(input.coin, closePreflightSignal);
      } catch (error) {
        if (closePreflightSignal?.aborted) {
          throw new TRPCError({
            code: "TIMEOUT",
            message:
              "Hyperliquid market data took too long to respond. No close order was placed; please retry.",
            cause: error,
          });
        }
        throw error;
      }
      let freshMarketPrice: string | undefined;
      const needsFreshMarketPrice =
        input.orderType === "Market" ||
        input.takeProfitPx !== undefined ||
        input.stopLossPx !== undefined;
      if (needsFreshMarketPrice) {
        let mids;
        try {
          mids = await client.allMids(input.coin, closePreflightSignal);
        } catch (error) {
          if (closePreflightSignal?.aborted) {
            throw new TRPCError({
              code: "TIMEOUT",
              message:
                "Hyperliquid market data took too long to respond. No close order was placed; please retry.",
              cause: error,
            });
          }
          throw error;
        }
        const rawMid = mids[input.coin];
        if (!isSafePositiveTradingPerpDecimal(rawMid)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Could not validate ${input.coin}: current market price is unavailable.`,
          });
        }
        freshMarketPrice = rawMid;
      }

      const venueSize = formatPerpOrderSizeForVenue(input.sizeCoin, asset.szDecimals);
      const effectivePrice = effectivePerpOrderPrice(
        input,
        freshMarketPrice,
        asset.szDecimals,
      );
      if (!isPerpOrderNotionalAtLeastMinimum(venueSize, effectivePrice)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: HYPERLIQUID_MIN_NOTIONAL_MESSAGE,
        });
      }

      // The same fresh market price used for preflight must reach the order
      // builder. Remove an optional Market limitPrice because the wrapper treats
      // it as the mark source for the synthetic IoC order.
      const submissionInput = input.orderType === "Market"
        ? { ...input, limitPrice: undefined, markPrice: freshMarketPrice }
        : input;

      // Re-check protective trigger direction against a fresh server-side mid.
      // Client validation is a UX aid only; direct/stale clients must never be
      // able to place an immediately-triggered exit alongside a live entry.
      if (input.takeProfitPx !== undefined || input.stopLossPx !== undefined) {
        const mid = Number(freshMarketPrice);

        const takeProfit = Number(input.takeProfitPx);
        const stopLoss = Number(input.stopLossPx);
        const takeProfitValid =
          input.takeProfitPx === undefined ||
          (input.isLong ? takeProfit > mid : takeProfit < mid);
        const stopLossValid =
          input.stopLossPx === undefined ||
          (input.isLong ? stopLoss < mid : stopLoss > mid);

        if (!takeProfitValid || !stopLossValid) {
          const invalidLegs = [
            !takeProfitValid ? "take-profit" : null,
            !stopLossValid ? "stop-loss" : null,
          ].filter((leg): leg is string => leg !== null);
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              `Invalid ${invalidLegs.join(" and ")} direction for a ${input.isLong ? "long" : "short"} ` +
              `${input.coin} position at the current market price (${freshMarketPrice}). Order not placed.`,
          });
        }
      }

      // Builder-deployed HIP-3 markets (`dex:COIN`) require a shared-collateral
      // account mode. Run every non-mutating order validation first, then let
      // the user's approved agent idempotently move a standard/manual account
      // to unified mode. Already-ready accounts and main-DEX orders skip this.
      if (input.coin.includes(":")) {
        try {
          await client.ensureDexAbstraction(walletAddress);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("api", "[Orders] HIP-3 account abstraction unavailable", {
            coin: input.coin,
            error: errorMessage,
          });
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Cannot trade ${input.coin}: ${errorMessage}`,
          });
        }
      }

      // Align on-chain leverage / margin mode BEFORE the order so the executed
      // position matches the liquidation profile the user reviewed.
      //
      // HL's updateLeverage returns ok (does not throw) when the leverage is
      // already at the requested value, so a thrown error here is always a REAL
      // failure (bad asset, network, margin constraint) — never the benign
      // "already set" case. We therefore FAIL HARD rather than swallow it:
      //   - ISOLATED: non-negotiable. The per-position margin, and thus the
      //     liquidation price, is set by this leverage. Executing at a stale
      //     leverage would give the user a liq profile they never reviewed.
      //   - CROSS: also fail hard. Account-wide leverage still shapes the
      //     reviewed risk; a real error means we could not confirm it, so we do
      //     not silently place the order at an unknown leverage.
      // No order row is created yet, so there is nothing to roll back here.
      //
      // SKIP for reduce-only orders (closes / stop-loss / take-profit legs). A
      // reduce-only order can only SHRINK an existing position, so aligning
      // leverage/margin mode is unnecessary — and actively harmful: the form's
      // leverage/margin may differ from the open position's, and calling
      // updateLeverage (which can throw when it conflicts with the live position,
      // e.g. switching cross↔isolated with margin committed) would abort a
      // legitimate EXIT. A user must never be blocked from reducing/closing.
      if (!input.reduceOnly) {
        try {
          await client.updateLeverage({
            coin: input.coin,
            leverage: input.leverage,
            marginMode: input.marginMode,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("api", "[Orders] Perp updateLeverage failed — aborting order", {
            coin: input.coin,
            marginMode: input.marginMode,
            leverage: input.leverage,
            error: errorMessage,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              `Could not set ${input.marginMode} leverage to ${input.leverage}x for ${input.coin}: ${errorMessage}. ` +
              "Order not placed — the liquidation profile would differ from the one you reviewed.",
          });
        }
      }

      // Stamp the wallet this order is actually being placed against, matching
      // what the copy-mirror path writes for the same column
      // (copy-mirror-perp-execution.ts, copy-mirror.ts). Without it the
      // reconciler's account pinning falls back to `user:${userId}` and
      // resolves whichever wallet is CURRENTLY on the user's hyperliquid
      // credential (a different address after any reconnect/rotation), which
      // can settle a still-live order CANCELLED against the wrong snapshot.
      const [order] = await ctx.db
        .insert(schema.orders)
        .values({
          ...toPerpOrderRow(submissionInput, ctx.userId, walletAddress),
          initialTakeProfitPx: input.takeProfitPx ?? null,
          initialStopLossPx: input.stopLossPx ?? null,
          ...(manualCopySource
            ? manualCopyOrderProvenance(manualCopySource, null)
            : {}),
        })
        .returning();

      if (!order) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create perp order record",
        });
      }

      // Place the order at the broker FIRST. Only an explicit venue rejection
      // is safe to persist as REJECTED. A timeout or transport exception has an
      // unknown outcome and must remain PENDING for cloid reconciliation.
      let result;
      try {
        result = await client.placeOrder(toPlacePerpOrderRequest(submissionInput));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        if (
          error instanceof HyperliquidOrderRejectedError ||
          error instanceof HyperliquidOrderPreparationError
        ) {
          const rejectionKind =
            error instanceof HyperliquidOrderRejectedError
              ? "Venue rejection"
              : "Submission preparation failed";
          logger.warn("api", `[Orders] ${rejectionKind}`, {
            coin: input.coin,
            cloid: input.cloid,
            error: errorMessage,
          });
          await markOrderRejected(ctx.db, order, {
            status: "REJECTED",
            notes: `${rejectionKind}: ${errorMessage}`,
          });
          throw new TRPCError({
            code:
              error instanceof HyperliquidOrderRejectedError
                ? "BAD_REQUEST"
                : "INTERNAL_SERVER_ERROR",
            message:
              error instanceof HyperliquidOrderRejectedError
                ? `Hyperliquid rejected the order: ${errorMessage}`
                : `The order was not submitted: ${errorMessage}`,
          });
        }

        logger.error(
          "api",
          "[Orders] Hyperliquid submission outcome unknown — leaving PENDING for reconciliation",
          { coin: input.coin, orderId: order.id, cloid: input.cloid, error: errorMessage },
        );
        try {
          await ctx.db
            .update(schema.orders)
            .set({
              notes:
                `Submission outcome unknown; awaiting cloid reconciliation. Error: ${errorMessage}`,
            })
            .where(eq(schema.orders.id, order.id));
        } catch (dbError) {
          logger.error("api", "[Orders] Failed to record ambiguous submission note", {
            orderId: order.id,
            cloid: input.cloid,
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }
        return await resolveAmbiguousOrderResponse(ctx.db, order, {
          operation: "Hyperliquid submission",
          reason: `Submission outcome unknown: ${errorMessage}`,
          message:
            "Hyperliquid did not confirm the order outcome. The existing request is being reconciled safely",
        });
      }

      // Broker call SUCCEEDED — the order is LIVE on Hyperliquid. From here we must
      // NEVER mark it REJECTED (CLAUDE.md broker-state-source-of-truth): a live
      // leveraged mainnet position would be orphaned by a terminal REJECTED row
      // that no reconciler scans. If the status write below fails (e.g. a transient
      // Supabase pooler blip), leave the row PENDING so the HL order-sync poller
      // reconciles it against broker state.
      logger.info("api", "[Orders] Hyperliquid order submitted", {
        coin: input.coin,
        cloid: input.cloid,
      });
      try {
        const updated = await ctx.db
          .update(schema.orders)
          .set({ status: "SUBMITTED" })
          .where(and(
            eq(schema.orders.id, order.id),
            orderStatusTransitionCondition("SUBMITTED"),
          ))
          .returning({ id: schema.orders.id });
        if (updated.length !== 1) {
          throw new Error(
            `Hyperliquid acceptance CAS returned ${updated.length} order rows; exactly one is required`,
          );
        }
      } catch (dbError) {
        const dbMsg = dbError instanceof Error ? dbError.message : "Unknown error";
        logger.error(
          "api",
          "[Orders] Perp order is LIVE on Hyperliquid but the status write failed — leaving PENDING for reconciliation",
          { coin: input.coin, orderId: order.id, cloid: input.cloid, error: dbMsg },
        );
        try {
          const authoritative = await readAuthoritativeOrderState(ctx.db, order);
          if (
            authoritative &&
            authoritative.status !== "PENDING" &&
            authoritative.status !== "SYNCING"
          ) {
            return {
              ...authoritativeOrderResponse(
                authoritative,
                null,
                "Hyperliquid accepted the order; another writer advanced local state",
              ),
              result,
            };
          }
        } catch (readError) {
          logger.error("api", "[Orders] Failed to reread Hyperliquid acceptance state", {
            coin: input.coin,
            orderId: order.id,
            error: readError instanceof Error ? readError.message : String(readError),
          });
        }
        return {
          success: false as const,
          syncing: true as const,
          status: "SYNCING" as const,
          orderId: order.id,
          result,
          message: "Hyperliquid accepted the order; local status is syncing",
        };
      }

      // Place TP/SL companion orders only for Market entries that fill
      // immediately. Limit entries rest unfilled, so companions placed now
      // would fire or be canceled before any position exists. Reduce-only
      // orders close an existing position and carry no new position to protect.
      let tpSlWarning: string | undefined;
      let tpSlReconciliationNeeded = false;
      if (
        input.orderType === "Market" &&
        !input.reduceOnly &&
        (input.takeProfitPx !== undefined || input.stopLossPx !== undefined)
      ) {
        // Submit both legs as one position-linked TP/SL group. Hyperliquid
        // cancels the remaining sibling when the protected position closes,
        // preventing a stale reduce-only trigger from affecting a later trade.
        try {
          const tpSlRequestBase = {
            coin: input.coin,
            positionSide: input.isLong ? "long" : "short",
            size: input.sizeCoin,
            ...(input.takeProfitPx !== undefined
              ? { takeProfitPx: input.takeProfitPx }
              : {}),
            ...(input.stopLossPx !== undefined
              ? { stopLossPx: input.stopLossPx }
              : {}),
          } as const;
          const tpSlRequest = {
            ...tpSlRequestBase,
            clientOrderId: resolveTpSlClientOrderId(ctx.userId, input.cloid),
          } as const;
          const buildPendingRows = (clientOrderId: string) =>
            pendingTpSlOrderRows({
              request: { ...tpSlRequestBase, clientOrderId },
              userId: ctx.userId,
              brokerAccountId: walletAddress,
              leverage: input.leverage,
              marginMode: input.marginMode,
            });
          const pendingRows = pendingTpSlOrderRows({
            request: tpSlRequest,
            userId: ctx.userId,
            brokerAccountId: walletAddress,
            leverage: input.leverage,
            marginMode: input.marginMode,
          });
          const reservation = await persistPendingTpSlOrders(ctx.db, pendingRows, {
            clientOrderId: tpSlRequest.clientOrderId,
            rebuildRows: buildPendingRows,
            nextClientOrderId: () =>
              resolveTpSlClientOrderId(
                ctx.userId,
                `${input.cloid}:tpsl-retry:${randomUUID()}`,
              ),
          });
          const reservedRows = reservation.rows;
          const tpSlResult = await client.setPositionTpSl({
            ...tpSlRequest,
            clientOrderId: reservation.clientOrderId,
          });
          await finalizeTpSlOrders(ctx.db, reservedRows, tpSlResult);
          const acceptedCount = orderStatuses(tpSlResult).filter(
            (status) => acceptedBrokerOrderId(status) !== null,
          ).length;
          if (acceptedCount !== reservedRows.length) {
            throw new Error("Hyperliquid accepted only part of the TP/SL group");
          }
          logger.info("api", "[Orders] Position-linked TP/SL placed", {
            coin: input.coin,
            takeProfitPx: input.takeProfitPx,
            stopLossPx: input.stopLossPx,
          });
        } catch (tpSlError) {
          const msg = tpSlError instanceof Error ? tpSlError.message : "Unknown error";
          logger.warn("api", "[Orders] TP/SL follow-up needs attention (main order is LIVE)", {
            coin: input.coin,
            cloid: input.cloid,
            error: msg,
          });
          if (tpSlError instanceof TpSlPersistenceError) {
            tpSlReconciliationNeeded = true;
            tpSlWarning =
              `Hyperliquid accepted ${tpSlError.acceptedCount} TP/SL trigger(s), but their local records need reconciliation. ` +
              "Do not place duplicate manual triggers while status is syncing.";
          } else if (tpSlError instanceof TpSlPartialError) {
            tpSlWarning =
              "Hyperliquid accepted part of the TP/SL protection. Check the live broker orders before changing protection.";
          } else {
            tpSlWarning =
              "The main order is live, but Hyperliquid did not confirm TP/SL protection. Check live broker orders before retrying.";
          }
        }
      }

      return {
        success: true,
        orderId: order.id,
        result,
        ...(tpSlWarning ? { tpSlWarning } : {}),
        ...(tpSlReconciliationNeeded
          ? { tpSlReconciliationNeeded: true as const, tpSlStatus: "RECONCILIATION_NEEDED" as const }
          : {}),
        message: "Order submitted successfully",
      };
    }),

  /**
   * Update leverage + margin mode for a Hyperliquid asset. Leverage is clamped
   * to the asset's maxLeverage inside the wrapper.
   */
  setLeverage: protectedProcedure
    .input(
      z.object({
        coin: perpCoinSchema,
        leverage: z.number().int().positive(),
        marginMode: z.enum(["cross", "isolated"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Agent must be approved (client-driven). Refuse if still PENDING.
      await assertHyperliquidAgentReady(ctx.db, ctx.userId);
      const { client } = await createHyperliquidExchangeClient(ctx.db, ctx.userId);
      try {
        const result = await client.updateLeverage({
          coin: input.coin,
          leverage: input.leverage,
          marginMode: input.marginMode,
        });
        return { success: true, result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Hyperliquid: ${errorMessage}`,
        });
      }
    }),

  /**
   * Cancel a resting Hyperliquid order by coin + numeric oid.
   */
  cancelPerp: protectedProcedure
    .input(
      z.object({
        coin: perpCoinSchema,
        orderId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { client } = await createHyperliquidExchangeClient(ctx.db, ctx.userId);
      try {
        const result = await client.cancelOrder({
          coin: input.coin,
          orderId: input.orderId,
        });
        return { success: true, result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Hyperliquid: ${errorMessage}`,
        });
      }
    }),

  /** Atomically modify one existing, protective Hyperliquid TP/SL trigger. */
  modifyPerpTpSl: protectedProcedure
    .input(
      z.object({
        coin: perpCoinSchema,
        orderId: z.number().int().positive(),
        kind: z.enum(["sl", "tp"]),
        triggerPx: z.string().refine(
          (value) => isSafePositiveTradingPerpDecimal(value),
          "triggerPx must be a positive safe decimal string",
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertHyperliquidAgentReady(ctx.db, ctx.userId);
      const { client, walletAddress } = await createHyperliquidExchangeClient(
        ctx.db,
        ctx.userId,
      );

      try {
        const [positions, openOrders] = await Promise.all([
          client.listPositions(walletAddress),
          client.listOpenOrders(walletAddress),
        ]);
        const order = openOrders.find(
          (item) =>
            item.coin === input.coin &&
            item.oid === input.orderId &&
            item.tpsl === input.kind &&
            (item.isPositionTpsl || item.reduceOnly),
        );
        if (!order) {
          throw new Error("That protective trigger is no longer open");
        }
        const position = positions.find((item) => item.coin === input.coin);
        if (!position) {
          throw new Error(`No ${input.coin} position is open`);
        }

        const result = await client.modifyPositionTpSl({
          coin: input.coin,
          orderId: input.orderId,
          positionSide: position.side,
          size: order.sz,
          triggerPx: input.triggerPx,
          kind: input.kind,
          isMarket: /market/i.test(order.orderType),
        });

        // The venue keeps the same oid after modify. Keep the local audit row's
        // requested trigger aligned when this order originated in RST.
        try {
          await ctx.db
            .update(schema.orders)
            .set({ priceTrigger: input.triggerPx, statusUpdatedAt: new Date() })
            .where(
              and(
                eq(schema.orders.userId, ctx.userId),
                eq(schema.orders.brokerOrderId, String(input.orderId)),
              ),
            );
        } catch (persistenceError) {
          logger.error("api", "[Orders] Modified Hyperliquid TP/SL but local audit update failed", {
            coin: input.coin,
            orderId: input.orderId,
            error:
              persistenceError instanceof Error
                ? persistenceError.message
                : String(persistenceError),
          });
        }

        return { success: true, result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Hyperliquid: ${errorMessage}`,
        });
      }
    }),

  /**
   * Attach a reduce-only stop-loss and/or take-profit to an OPEN Hyperliquid
   * position. Places trigger orders on the OPPOSITE side of the position
   * (`r: true`, so they only ever close): SL as tpsl "sl", TP as tpsl "tp".
   * Size may be full or partial. At least one of stopLossPx / takeProfitPx is
   * required. Full-position sizing must equal the fresh position size; omitted
   * sizeMode retains legacy partial behavior. Agent-signed; gated on LIVE.
   */
  setPerpTpSl: protectedProcedure
    .input(
      z
        .object({
          coin: perpCoinSchema,
          /** Side of the OPEN position being protected. */
          positionSide: z.enum(["long", "short"]),
          /** Size to protect, in coin units (positive decimal string). */
          size: z.string().refine(
            (value) => isSafePositiveTradingPerpDecimal(value),
            "size must be a positive safe decimal string",
          ),
          /** Full-position requests must match the fresh open size exactly. */
          sizeMode: z.enum(["full-position", "partial"]).default("partial"),
          /** Stop-loss trigger price (positive decimal string). */
          stopLossPx: z.string().refine(
            (value) => isSafePositiveTradingPerpDecimal(value),
            "stopLossPx must be a positive safe decimal string",
          ).optional(),
          /** Take-profit trigger price (positive decimal string). */
          takeProfitPx: z.string().refine(
            (value) => isSafePositiveTradingPerpDecimal(value),
            "takeProfitPx must be a positive safe decimal string",
          ).optional(),
          /** Market (aggressive-limit) exit vs resting limit at the trigger. Defaults to market. */
          isMarket: z.boolean().default(true),
          /** Idempotency seed; each leg derives `${cloid}:sl` / `${cloid}:tp`. */
          cloid: z.string().min(1).optional(),
        })
        .refine(
          (v) => v.stopLossPx !== undefined || v.takeProfitPx !== undefined,
          {
            message: "At least one of stopLossPx / takeProfitPx is required",
            path: ["stopLossPx"],
          },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      // Agent must be approved (client-driven). Refuse if still PENDING.
      await assertHyperliquidAgentReady(ctx.db, ctx.userId);
      const { client, walletAddress } = await createHyperliquidExchangeClient(ctx.db, ctx.userId);
      try {
        const position = (await client.listPositions(walletAddress)).find(
          (item) => item.coin === input.coin && item.side === input.positionSide,
        );
        if (!position) {
          throw new Error(`No ${input.positionSide} ${input.coin} position is open`);
        }
        if (!isSafePositiveTradingPerpDecimal(position.size)) {
          throw new Error("The fresh position size is missing or invalid");
        }
        const sizeOrder = comparePositiveDecimalStrings(input.size, position.size);
        if (input.sizeMode === "full-position" && sizeOrder !== 0) {
          throw new Error("Full-position TP/SL size must match the fresh position size");
        }
        if (input.sizeMode === "partial" && sizeOrder > 0) {
          throw new Error("Partial TP/SL size cannot exceed the fresh position size");
        }
        const logicalClientOrderId = input.cloid ?? [
          "position",
          input.coin,
          input.positionSide,
          input.size,
          input.stopLossPx ?? "none",
          input.takeProfitPx ?? "none",
        ].join(":");
        const clientOrderId = resolveTpSlClientOrderId(
          ctx.userId,
          logicalClientOrderId,
        );
        const requestBase = {
          coin: input.coin,
          positionSide: input.positionSide,
          size: input.size,
          isMarket: input.isMarket,
          ...(input.stopLossPx !== undefined ? { stopLossPx: input.stopLossPx } : {}),
          ...(input.takeProfitPx !== undefined ? { takeProfitPx: input.takeProfitPx } : {}),
        } as const;
        const request = { ...requestBase, clientOrderId } as const;
        const buildPendingRows = (nextClientOrderId: string) =>
          pendingTpSlOrderRows({
            request: { ...requestBase, clientOrderId: nextClientOrderId },
            userId: ctx.userId,
            brokerAccountId: walletAddress,
            leverage: position.leverage,
            marginMode: position.marginMode,
          });
        const pendingRows = pendingTpSlOrderRows({
          request,
          userId: ctx.userId,
          brokerAccountId: walletAddress,
          leverage: position.leverage,
          marginMode: position.marginMode,
        });
        const reservation = await persistPendingTpSlOrders(ctx.db, pendingRows, {
          clientOrderId,
          rebuildRows: buildPendingRows,
          nextClientOrderId: () =>
            resolveTpSlClientOrderId(
              ctx.userId,
              `${logicalClientOrderId}:tpsl-retry:${randomUUID()}`,
            ),
        });
        const reservedRows = reservation.rows;
        const result = await client.setPositionTpSl({
          ...request,
          clientOrderId: reservation.clientOrderId,
        });
        try {
          await finalizeTpSlOrders(ctx.db, reservedRows, result);
        } catch (error) {
          if (!(error instanceof TpSlPersistenceError)) throw error;
          logger.error("api", "[Orders] Accepted Hyperliquid TP/SL needs reconciliation", {
            coin: input.coin,
            acceptedLegs: error.acceptedCount,
            failedRecords: error.failedCount,
          });
          return {
            success: false as const,
            reconciliationNeeded: true as const,
            status: "RECONCILIATION_NEEDED" as const,
            acceptedLegs: error.acceptedCount,
            requestedLegs: reservedRows.length,
            result,
            message:
              error.acceptedCount > 0
                ? `Hyperliquid accepted ${error.acceptedCount} of ${reservedRows.length} TP/SL trigger(s), but their local order records could not be finalized. ` +
                  "Reconciliation is required; do not submit duplicate triggers while status is syncing."
                : "Hyperliquid returned an ambiguous TP/SL response. Live orders are being reconciled; do not submit duplicate triggers while status is syncing.",
          };
        }
        const statuses = orderStatuses(result);
        const acceptedRows = reservedRows.filter(
          (_row, index) => acceptedBrokerOrderId(statuses[index]) !== null,
        );
        if (acceptedRows.length !== reservedRows.length) {
          if (acceptedRows.length === 0) {
            throw new HyperliquidOrderRejectedError(
              "Hyperliquid rejected every TP/SL trigger leg",
            );
          }
          const placed = acceptedRows.map((row) => ({
            kind: row.orderType.startsWith("Stop") ? "sl" as const : "tp" as const,
            cloid: row.clientOrderId,
            result: statuses[reservedRows.indexOf(row)],
          }));
          const failedLeg = reservedRows.find((row) => !acceptedRows.includes(row));
          throw new TpSlPartialError(
            failedLeg?.orderType.startsWith("Stop") ? "sl" : "tp",
            placed,
            new Error("Hyperliquid rejected the trigger leg"),
          );
        }
        logger.info("api", "[Orders] Hyperliquid TP/SL attached", {
          coin: input.coin,
          positionSide: input.positionSide,
          sl: input.stopLossPx ?? null,
          tp: input.takeProfitPx ?? null,
        });
        return { success: true, result };
      } catch (error) {
        // PARTIAL failure: an earlier leg (e.g. the stop-loss) is LIVE on-chain
        // but a later leg failed. Never present this as a clean failure — the
        // user would not know a stop is already in place. Surface which legs are
        // live so they can reconcile, and make the message explicit.
        if (error instanceof TpSlPartialError) {
          logger.error("api", "[Orders] Hyperliquid setPerpTpSl PARTIAL", {
            coin: input.coin,
            placedLegs: error.placed.map((p) => p.kind),
            failedLeg: error.failedLeg,
            error: error.message,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              `${error.message} The ${error.placed
                .map((p) => p.kind.toUpperCase())
                .join("+")} order is already LIVE on Hyperliquid — check your open ` +
              `orders before retrying so you don't duplicate it.`,
          });
        }
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger.error("api", "[Orders] Hyperliquid setPerpTpSl failed", {
          coin: input.coin,
          error: errorMessage,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Hyperliquid: ${errorMessage}`,
        });
      }
    }),
});
