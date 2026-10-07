import { AlpacaClient, deriveClientOrderId, type AlpacaOrder } from "@trade-bot/alpaca";
import {
  ORDER_STATUS_RANK,
  monotonicOrderStatusValue,
  orderStatusRankSql,
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
  schema,
  type WorkerPoolDb,
} from "@trade-bot/db";
import { randomUUID } from "node:crypto";
import { eq, ne, inArray, and, or, lte, isNull, sql } from "drizzle-orm";
import { createProductionLogger } from "@trade-bot/logger";
import {
  getDecryptedCredentials,
  type DecryptedCredentials,
} from "../../../api/src/lib/credentials";
import { isPaperAccount } from "../../../api/src/lib/alpaca";
import { parseStrictFiniteNumber } from "../../../api/src/lib/strict-number";
import { MAX_SAFE_TRADING_VALUE } from "@trade-bot/utils";
import { sendDiscordNotification } from "./discord-notify";
import { describeError } from "../lib/log-safe-error";

const logger = createProductionLogger();

const LOG_SERVICE = "order-sync";

/**
 * Compact, loggable description of a failed broker or database call.
 *
 * `describeError` handles the two rules every service here shares (never log
 * the raw error, always mask credentials). This adds the one field specific to
 * a broker call: the HTTP status is what actually classifies the failure, so it
 * is lifted out rather than left buried in the message.
 *
 * Replacing a raw `console.error` here fixed something beyond readability.
 * Those sites were invisible to the error-burst alerter, which only sees
 * `logger.error`, so the loudest failure in the worker could never trip the
 * alert that exists to catch exactly this.
 */
export function describeSyncError(error: unknown): {
  status?: number;
  errorName: string;
  errorMessage: string;
} {
  const value = error as
    | { response?: { status?: unknown }; status?: unknown }
    | undefined;
  const rawStatus = value?.response?.status ?? value?.status;
  return {
    ...(typeof rawStatus === "number" ? { status: rawStatus } : {}),
    ...describeError(error),
  };
}

/**
 * Resolve Alpaca's `filled_at` into a fill-time Date for persistence, or null
 * when absent/unparseable. Guards against persisting an Invalid Date (e.g. a
 * malformed timestamp), which would otherwise corrupt the chart marker anchor.
 */
export function resolveExecutedAt(filledAt: string | null | undefined): Date | null {
  if (!filledAt) return null;
  const date = new Date(filledAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Re-derive concrete exit-order quantities for a filled entry. Take-profit legs
 * floor their share of the filled quantity; the trailing runner takes whatever
 * remains. Returns `null` when the position is too small to split (so the
 * caller can skip attaching rather than place a zero/negative-qty order).
 */
export function computeExitLegs(
  plan: schema.OrderExitPlan,
  filledQty: number
): {
  takeProfits: Array<{ price: number; qty: number }>;
  trailingStop?: { qty: number; trailPercent: number };
} | null {
  if (
    !Number.isFinite(filledQty) ||
    filledQty <= 0 ||
    filledQty > MAX_SAFE_TRADING_VALUE
  ) return null;
  const qty = Math.floor(filledQty);
  if (qty <= 0) return null;

  const takeProfits: Array<{ price: number; qty: number }> = [];
  let used = 0;
  for (const tp of plan.takeProfits) {
    const legQty = Math.floor(qty * tp.qtyFraction);
    if (legQty > 0) {
      takeProfits.push({ price: tp.price, qty: legQty });
      used += legQty;
    }
  }

  const remainder = qty - used;
  let trailingStop: { qty: number; trailPercent: number } | undefined;
  if (plan.trailingStop && remainder > 0) {
    trailingStop = { qty: remainder, trailPercent: plan.trailingStop.trailPercent };
  } else if (!plan.trailingStop && remainder > 0 && takeProfits.length > 0) {
    // No trailing runner: give the rounding remainder to the last TP so the
    // whole position is covered.
    takeProfits[takeProfits.length - 1].qty += remainder;
  }

  if (takeProfits.length === 0 && !trailingStop) return null;
  return { takeProfits, trailingStop };
}

type SyncOrder = typeof schema.orders.$inferSelect;
type SmartExitLeg = typeof schema.smartExitLegs.$inferSelect;

type ExecutionStatus = SyncOrder["status"];

interface OrderExecutionSnapshot {
  status: ExecutionStatus;
  executedQuantity: number;
  executedPrice: number | null;
  executedAt: Date | null;
}

interface IncomingOrderExecutionSnapshot extends OrderExecutionSnapshot {
  brokerOrderId: string;
  statusUpdatedAt: Date;
  /**
   * The broker order id this snapshot SUPERSEDES, set only when Alpaca's own
   * `replaced_by` chain moved the live state to a different order id.
   *
   * The ordinary write coalesces `broker_order_id` so a stale writer can never
   * repoint a row at another order. A documented replacement is the one case
   * where repointing is the correct answer: `replaced` is terminal for the old
   * id and the successor is where every later fill lands, so a row left on the
   * retired id freezes on SUBMITTED forever. Scoped to the exact id being
   * replaced, so it can still only ever move the row off the order this
   * snapshot actually followed.
   */
  supersedesBrokerOrderId?: string | null;
}

function isIncomingExecutionAuthoritative(
  current: OrderExecutionSnapshot,
  incoming: OrderExecutionSnapshot,
): boolean {
  if (
    !Number.isFinite(incoming.executedQuantity) ||
    incoming.executedQuantity < 0 ||
    incoming.executedQuantity > MAX_SAFE_TRADING_VALUE
  ) return false;
  if (incoming.executedQuantity !== current.executedQuantity) {
    return incoming.executedQuantity > current.executedQuantity;
  }
  if (
      ORDER_STATUS_RANK[incoming.status] > ORDER_STATUS_RANK[current.status]
  ) return true;
  if (incoming.executedAt === null) return false;
  if (current.executedAt === null) return true;
  return incoming.executedAt.getTime() >= current.executedAt.getTime();
}

/** Pure counterpart to the conditional SQL update used by the poller. */
export function mergeOrderExecutionSnapshot(
  current: OrderExecutionSnapshot,
  incoming: OrderExecutionSnapshot,
): OrderExecutionSnapshot {
  const statusAdvances = ORDER_STATUS_RANK[incoming.status] >
    ORDER_STATUS_RANK[current.status];
  const executionAdvances = isIncomingExecutionAuthoritative(current, incoming);

  if (!statusAdvances && !executionAdvances) return current;

  return {
    status: statusAdvances ? incoming.status : current.status,
    executedQuantity: executionAdvances
      ? incoming.executedQuantity
      : current.executedQuantity,
    executedPrice: executionAdvances && incoming.executedPrice !== null &&
        Number.isFinite(incoming.executedPrice) &&
        incoming.executedPrice > 0 &&
        incoming.executedPrice <= MAX_SAFE_TRADING_VALUE
      ? incoming.executedPrice
      : current.executedPrice,
    executedAt: executionAdvances && incoming.executedAt !== null
      ? incoming.executedAt
      : current.executedAt,
  };
}

/**
 * Bind a fill timestamp as an explicitly typed parameter.
 *
 * A bare `${date}` binds an untyped parameter, and Postgres cannot infer a type
 * for one whose only use is `$n is not null`. It rejects the entire statement
 * with "could not determine data type of parameter $n".
 *
 * That is unrecoverable for the row rather than a one-off failure. This UPDATE
 * is the only thing that advances the order, so a row it can never commit keeps
 * an active status, stays in the scan set above, and rebuilds the identical
 * failing statement on every 30s tick. An order with no `filled_at` yet (a null
 * here) is therefore frozen: its fill can never be persisted no matter what the
 * broker reports, and it logs an error twice a minute until someone notices.
 * Seven orders were in exactly this state in production on 2026-08-26.
 *
 * Every interpolation binds its OWN placeholder, so the cast has to be on every
 * occurrence and not only on the `is not null` one.
 */
function executedAtSql(executedAt: Date | null) {
  return sql`${executedAt}::timestamptz`;
}

function incomingExecutionIsAuthoritativeSql(incoming: IncomingOrderExecutionSnapshot) {
  const incomingStatusRank = ORDER_STATUS_RANK[incoming.status];
  const incomingExecutedAt = executedAtSql(incoming.executedAt);
  return sql<boolean>`(
    ${incoming.executedQuantity} > coalesce(${schema.orders.executedQuantity}, 0)
    or (
      ${incoming.executedQuantity} = coalesce(${schema.orders.executedQuantity}, 0)
      and (
        ${incomingStatusRank} > ${orderStatusRankSql()}
        or (
          ${incomingExecutedAt} is not null
          and (${schema.orders.executedAt} is null or ${incomingExecutedAt} >= ${schema.orders.executedAt})
        )
      )
    )
  )`;
}

/**
 * Build expressions that compare a broker snapshot with the persisted row at
 * UPDATE time. This keeps overlapping worker instances from regressing a
 * cumulative fill even when an older broker response commits last.
 */
export function buildMonotonicOrderExecutionUpdate(
  incoming: IncomingOrderExecutionSnapshot,
) {
  const authoritativeExecution = incomingExecutionIsAuthoritativeSql(incoming);
  const hasValidPrice = incoming.executedPrice !== null &&
    Number.isFinite(incoming.executedPrice) &&
    incoming.executedPrice > 0 &&
    incoming.executedPrice <= MAX_SAFE_TRADING_VALUE;

  return {
    status: monotonicOrderStatusValue(incoming.status),
    brokerOrderId: incoming.supersedesBrokerOrderId
      ? sql<string>`case
          when ${schema.orders.brokerOrderId} = ${incoming.supersedesBrokerOrderId}
            then ${incoming.brokerOrderId}
          else coalesce(${schema.orders.brokerOrderId}, ${incoming.brokerOrderId})
        end`
      : sql<string>`coalesce(${schema.orders.brokerOrderId}, ${incoming.brokerOrderId})`,
    executedQuantity: sql<number>`greatest(
      coalesce(${schema.orders.executedQuantity}, 0),
      ${incoming.executedQuantity}
    )`,
    executedPrice: hasValidPrice
      ? sql<string>`case
          when ${authoritativeExecution} then ${incoming.executedPrice}
          else ${schema.orders.executedPrice}
        end`
      : sql<string>`${schema.orders.executedPrice}`,
    executedAt: sql<Date | null>`case
      when ${authoritativeExecution} and ${executedAtSql(incoming.executedAt)} is not null
        then ${executedAtSql(incoming.executedAt)}
      else ${schema.orders.executedAt}
    end`,
    statusUpdatedAt: incoming.statusUpdatedAt,
    syncReason: null,
    syncAttempts: sql<number>`${schema.orders.syncAttempts} + 1`,
    lastSyncAttemptAt: incoming.statusUpdatedAt,
  };
}

function buildMonotonicOrderExecutionCondition(
  incoming: IncomingOrderExecutionSnapshot,
) {
  const incomingStatusRank = ORDER_STATUS_RANK[incoming.status];
  const authoritativeExecution = incomingExecutionIsAuthoritativeSql(incoming);
  const hasValidPrice = incoming.executedPrice !== null &&
    Number.isFinite(incoming.executedPrice) &&
    incoming.executedPrice > 0 &&
    incoming.executedPrice <= MAX_SAFE_TRADING_VALUE;

  return or(
    sql<boolean>`${incomingStatusRank} > ${orderStatusRankSql()}`,
    sql<boolean>`${incoming.executedQuantity} > coalesce(${schema.orders.executedQuantity}, 0)`,
    isNull(schema.orders.brokerOrderId),
    sql<boolean>`${schema.orders.syncReason} is not null`,
    hasValidPrice
      ? sql<boolean>`${authoritativeExecution} and ${schema.orders.executedPrice} is distinct from ${incoming.executedPrice}`
      : sql<boolean>`false`,
    incoming.executedAt
      ? sql<boolean>`${authoritativeExecution} and ${schema.orders.executedAt} is distinct from ${executedAtSql(incoming.executedAt)}`
      : sql<boolean>`false`,
  );
}

interface DesiredSmartExitLeg {
  legKey: string;
  legType: SmartExitLeg["legType"];
  clientOrderId: string;
  quantity: number;
  limitPrice: string | null;
  stopPrice: string | null;
  trailPercent: string | null;
}

const SMART_EXIT_CLAIM_MS = 60_000;
const SMART_EXIT_RETRY_BASE_MS = 30_000;
const SMART_EXIT_RETRY_MAX_MS = 15 * 60_000;

function brokerErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  const status = candidate.response?.status ?? candidate.response?.statusCode ??
    candidate.status ?? candidate.statusCode;
  return typeof status === "number" ? status : undefined;
}

function brokerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Failed");
  const candidate = error as {
    message?: unknown;
    response?: { data?: unknown };
  };
  const data = candidate.response?.data;
  const responseMessage = data && typeof data === "object" && "message" in data
    ? (data as { message?: unknown }).message
    : data;
  const message = candidate.message ?? responseMessage;
  return typeof message === "string" && message.length > 0 ? message : "Failed";
}

function isPermanentBrokerError(error: unknown): boolean {
  const status = brokerErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500 &&
    ![408, 425, 429].includes(status);
}

function isUnsafeBrokerLegStatus(status: string | null | undefined): boolean {
  if (!status) return false;

  // A filled exit has already protected the position by closing its assigned
  // quantity. All other allowed states still represent an accepted/live leg.
  return ![
    "new",
    "partially_filled",
    "filled",
    "accepted",
    "pending_new",
    "accepted_for_bidding",
  ].includes(status.toLowerCase());
}

function smartExitNextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, attempts - 1);
  const delayMs = Math.min(
    SMART_EXIT_RETRY_MAX_MS,
    SMART_EXIT_RETRY_BASE_MS * 2 ** exponent,
  );
  return new Date(now.getTime() + delayMs);
}

function isNotFoundError(error: unknown): boolean {
  return brokerErrorStatus(error) === 404;
}

interface OrderSyncDependencies {
  getCredentials: typeof getDecryptedCredentials;
  createClient: (credentials: DecryptedCredentials) => AlpacaClient;
  notify: typeof sendDiscordNotification;
}

const defaultDependencies: OrderSyncDependencies = {
  getCredentials: getDecryptedCredentials,
  createClient: (credentials) => new AlpacaClient({
    keyId: credentials.username!,
    secretKey: credentials.accessToken,
    paper: isPaperAccount(credentials.accountType),
  }),
  notify: sendDiscordNotification,
};

/** Exported for tests: pure Alpaca-status to local-status mapping. */
export function mapAlpacaStatus(
  status: string,
  current: SyncOrder["status"],
): SyncOrder["status"] {
  if (status === "filled") return "FILLED";
  if (status === "canceled") return "CANCELLED";
  if (status === "rejected") return "REJECTED";
  if (status === "expired") return "EXPIRED";
  if (status === "partially_filled") return "PARTIAL";
  if (
    [
      "new",
      "accepted",
      "pending_new",
      "accepted_for_bidding",
      // pending_cancel is NOT terminal (audit M5): the cancel request is in
      // flight and Alpaca can still fill the order before honoring it. Mapping
      // it to CANCELLED froze the local row, so a subsequent fill was never
      // synced and the user held a position their app said was cancelled.
      // Keep it SUBMITTED; the next poll picks up the terminal state.
      "pending_cancel",
      "pending_replace",
      "replaced",
      "stopped",
      "calculated",
      "done_for_day",
      // suspended is NOT terminal either, despite Alpaca listing it near the
      // terminal states. Alpaca defines `rejected` as "no further updates will
      // occur for the order" but defines `suspended` only as "not eligible
      // for trading (rare)", with no such clause. Collapsing it into REJECTED
      // dropped the row from OrderSyncPoller's scan set (which excludes
      // REJECTED) permanently: if Alpaca later un-suspended the order and it
      // filled, nothing ever polled again to notice. Keep it SUBMITTED so the
      // poller keeps reading the row until a real terminal state arrives.
      "suspended",
    ].includes(status)
  ) {
    return "SUBMITTED";
  }
  return current;
}

/**
 * Alpaca lists `replaced` among the order's terminal states, but a replace
 * does not end the trader's intent: the broker creates a successor order
 * that inherits whatever quantity had not yet filled, and only that
 * successor's `filled_qty` reflects what the account actually ended up
 * holding. Alpaca hands back `replaced_by`, "The order ID that this order
 * was replaced by," precisely so a caller can follow the fill instead of
 * reading the retired order forever.
 *
 * A replace can itself be replaced (the trader nudges price twice), so this
 * walks the whole chain rather than one hop. Capped so a corrupted or
 * circular chain cannot spin the poller forever; hitting the cap returns the
 * last order actually read rather than throwing, which is still strictly
 * more correct than never following the chain at all.
 */
async function resolveReplacementChain(
  client: Pick<AlpacaClient, "getOrder">,
  order: AlpacaOrder,
): Promise<AlpacaOrder> {
  const MAX_REPLACE_HOPS = 10;
  let current = order;
  let hops = 0;
  while (current.status === "replaced" && current.replaced_by && hops < MAX_REPLACE_HOPS) {
    current = await client.getOrder(current.replaced_by);
    hops += 1;
  }
  return current;
}

function tenantOrderWhere(order: SyncOrder) {
  const conditions = [
    eq(schema.orders.id, order.id),
    eq(schema.orders.userId, order.userId),
  ];
  if (order.clientOrderId) {
    conditions.push(eq(schema.orders.clientOrderId, order.clientOrderId));
  }
  if (order.brokerClientOrderId) {
    conditions.push(eq(schema.orders.brokerClientOrderId, order.brokerClientOrderId));
  }
  if (order.brokerOrderId) {
    conditions.push(eq(schema.orders.brokerOrderId, order.brokerOrderId));
  }
  return and(...conditions);
}

export class OrderSyncPoller {
  private db: WorkerPoolDb;
  private isRunning: boolean = false;
  private pollPromise?: Promise<void>;
  // `ReturnType<typeof setInterval>` rather than `NodeJS.Timeout`: this workspace
  // resolves Bun's `setInterval`, which returns its own Timer type, so the
  // Node-specific annotation failed `check-types` for the whole worker even
  // though the runtime value was always correct. Deriving the type from the
  // function that produces it is right under either runtime.
  private intervalId?: ReturnType<typeof setInterval>;
  private pollIntervalMs: number = 30000; // 30 seconds

  private readonly dependencies: OrderSyncDependencies;

  constructor(db: WorkerPoolDb, dependencies: Partial<OrderSyncDependencies> = {}) {
    this.db = db;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    console.log("[OrderSyncPoller] Starting order sync polling...");
    this.pollOnce(); // initial run
    this.intervalId = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    console.log("[OrderSyncPoller] Stopped order sync polling.");
  }

  public pollOnce(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;

    this.pollPromise = this.runPollOnce().finally(() => {
      this.pollPromise = undefined;
    });
    return this.pollPromise;
  }

  private async runPollOnce(): Promise<void> {
    try {
      // PENDING/SYNCING rows may already exist at Alpaca when the create response
      // or local acceptance update failed. They are read-only reconciliation
      // candidates; this poller never re-submits them.
      const activeOrders = await this.db.query.orders.findMany({
        where: and(
          // ALPACA ONLY. This poller resolves every candidate through Alpaca
          // credentials and Alpaca order ids; perps live on Hyperliquid and are
          // reconciled by HyperliquidOrderSyncPoller.
          //
          // Without this filter a perp order was handed to `client.getOrder()`
          // with its Hyperliquid oid, which is numeric rather than a UUID.
          // Alpaca answered 422 Unprocessable Entity, the order stayed active,
          // and the next tick asked again, forever. In production one such
          // order produced roughly 115 failures an hour, each dumping a raw
          // ~150-line axios object, which is most of what was in the worker
          // log.
          ne(schema.orders.assetType, "PERP"),
          or(
            inArray(schema.orders.status, ["PENDING", "SYNCING", "SUBMITTED", "PARTIAL"]),
            and(
              eq(schema.orders.status, "FILLED"),
              eq(schema.orders.exitPlanStatus, "pending"),
            ),
          ),
        ),
      });

      if (activeOrders.length === 0) return;

      console.log(`[OrderSyncPoller] Found ${activeOrders.length} active orders to sync.`);

      // Group by tenant and exact saved credential. A user can have Paper and
      // Live orders simultaneously; sharing one client between them is unsafe.
      const ordersByCredential = activeOrders.reduce((acc, order) => {
        const credentialScope = order.brokerCredentialId || order.brokerAccountId || "legacy";
        const key = `${order.userId}:${credentialScope}`;
        if (!acc[key]) acc[key] = [];
        acc[key].push(order);
        return acc;
      }, {} as Record<string, typeof activeOrders>);

      for (const userOrders of Object.values(ordersByCredential)) {
        const userId = userOrders[0].userId;
        try {
          const brokerAccountId = userOrders[0].brokerAccountId || undefined;
          const brokerCredentialId = userOrders[0].brokerCredentialId || undefined;
          const credentials = await this.dependencies.getCredentials(this.db as any, userId, {
            provider: "alpaca",
            credentialId: brokerCredentialId,
            accountId: brokerAccountId,
          });

          if (!credentials.username || !credentials.accessToken) {
            console.warn(`[OrderSyncPoller] No credentials for user ${userId}, skipping.`);
            continue;
          }

          const client = this.dependencies.createClient(credentials);

          // Process each order for this user
          for (const order of userOrders) {
             const brokerClientOrderId = order.brokerClientOrderId || order.clientOrderId;
             if (!order.brokerOrderId && !brokerClientOrderId) continue;

             let winningOrder: SyncOrder | undefined;
             const readAuthoritativeOrder = async (): Promise<SyncOrder | undefined> => {
               const findFirst = this.db.query.orders.findFirst;
               return typeof findFirst === "function"
                 ? await findFirst.call(this.db.query.orders, {
                     where: tenantOrderWhere(order),
                   })
                 : undefined;
             };
             try {
                let alpacaOrder = order.brokerOrderId
                  ? await client.getOrder(order.brokerOrderId)
                  : await client.getOrderByClientId(brokerClientOrderId!);
                // "replaced" is terminal for THIS order id, not for the
                // trader's intent: follow Alpaca's replaced_by to the
                // successor that actually carries the live fill state. See
                // resolveReplacementChain for why this can't just be folded
                // into mapAlpacaStatus (it needs another broker round-trip).
                const replacedFromBrokerOrderId =
                  alpacaOrder.status === "replaced" ? alpacaOrder.id : null;
                if (alpacaOrder.status === "replaced") {
                  alpacaOrder = await resolveReplacementChain(client, alpacaOrder);
                }
                const newStatus = mapAlpacaStatus(alpacaOrder.status, order.status);

                // Update if status changed or executed quantity changed
                const filledQty = parseStrictFiniteNumber(alpacaOrder.filled_qty);
                const hasBrokerPrice = alpacaOrder.filled_avg_price !== null;
                const executedPrice = hasBrokerPrice
                  ? parseStrictFiniteNumber(alpacaOrder.filled_avg_price)
                  : null;
                if (
                  filledQty === null ||
                  filledQty < 0 ||
                  filledQty > MAX_SAFE_TRADING_VALUE ||
                  (hasBrokerPrice && (
                    executedPrice === null ||
                    executedPrice <= 0 ||
                    executedPrice > MAX_SAFE_TRADING_VALUE
                  )) ||
                  (filledQty > 0 && executedPrice === null) ||
                  ((newStatus === "FILLED" || newStatus === "PARTIAL") &&
                    (filledQty <= 0 || executedPrice === null))
                ) {
                  logger.warn(LOG_SERVICE, "Ignoring malformed broker execution snapshot", {
                    orderId: order.id,
                    brokerOrderId: alpacaOrder.id,
                  });
                  continue;
                }
                const statusUpdatedAt = new Date();
                const incomingSnapshot: IncomingOrderExecutionSnapshot = {
                  status: newStatus,
                  brokerOrderId: alpacaOrder.id,
                  executedQuantity: filledQty,
                  executedPrice,
                  executedAt: resolveExecutedAt(alpacaOrder.filled_at),
                  statusUpdatedAt,
                  // Only when the chain actually moved: the successor id has to
                  // land on the row, or the next poll reads the retired id again
                  // and the fill is never seen.
                  ...(replacedFromBrokerOrderId && replacedFromBrokerOrderId !== alpacaOrder.id
                    ? { supersedesBrokerOrderId: replacedFromBrokerOrderId }
                    : {}),
                };

                let persistedOrder: SyncOrder | undefined;
                let persistenceWon = false;

                if (
                  newStatus !== order.status ||
                  filledQty !== order.executedQuantity ||
                  alpacaOrder.id !== order.brokerOrderId ||
                  order.syncReason !== null
                ) {
                   console.log(`[OrderSyncPoller] Order ${order.id} status changed: ${order.status} -> ${newStatus}`);
                   
                   const persistedRows = await this.db
                     .update(schema.orders)
                     .set(buildMonotonicOrderExecutionUpdate(incomingSnapshot))
                     .where(and(
                       tenantOrderWhere(order),
                       buildMonotonicOrderExecutionCondition(incomingSnapshot),
                     ))
                     .returning();

                   if (persistedRows.length === 1) {
                     persistedOrder = persistedRows[0];
                     persistenceWon = true;
                   } else {
                     // Zero rows mean the transition was already advanced (or
                     // the row vanished); multiple rows are an ambiguous CAS.
                     // Neither outcome authorizes a notification.
                     winningOrder = await readAuthoritativeOrder();
                     logger.warn(LOG_SERVICE, "Order execution CAS was not singular", {
                       orderId: order.id,
                       returnedRows: persistedRows.length,
                     });
                   }

                   // Only the row returned by the conditional UPDATE won the
                   // monotonic race. A stale broker response that loses that
                   // race must not emit a stale notification.
                   if (persistenceWon && persistedOrder && !isPaperAccount(credentials.accountType)) {
                     try {
                       await this.dependencies.notify({
                         symbol: persistedOrder.symbol,
                         // Alpaca's filled_at, not the reconcile time, so a
                         // long-delayed sync cannot announce an old fill as
                         // live. Null on terminal non-fills, which still
                         // notify (see isStaleFill).
                         executedAt: incomingSnapshot.executedAt,
                         side: persistedOrder.tradeAction || undefined,
                         quantity: persistedOrder.executedQuantity ?? persistedOrder.quantity,
                         status: persistedOrder.status,
                         previousStatus: order.status,
                         executedPrice: persistedOrder.executedPrice
                           ? parseFloat(persistedOrder.executedPrice)
                           : null,
                         orderId: persistedOrder.id,
                         assetType: persistedOrder.assetType,
                         orderType: persistedOrder.orderType,
                         limitPrice: persistedOrder.limitPrice
                           ? parseFloat(persistedOrder.limitPrice)
                           : null,
                         userId,
                         copySourceLabel: persistedOrder.copySourceLabel,
                       });
                     } catch (notifyError) {
                       logger.error(LOG_SERVICE, "Failed to notify for order", {
                         orderId: order.id,
                         ...describeSyncError(notifyError),
                       });
                     }
                   }
                }

                // Side effects read the persisted winner, not the broker
                // snapshot. If this poll lost the conditional UPDATE, re-read
                // the row so a concurrent FILLED winner can still attach its
                // protection legs with the winning cumulative quantity.
                winningOrder = persistedOrder ??
                  winningOrder ??
                  await readAuthoritativeOrder();
                if (
                  winningOrder?.status === "FILLED" &&
                  winningOrder.exitPlanStatus === "pending" &&
                  winningOrder.exitPlan &&
                  winningOrder.executedQuantity !== null &&
                  Number.isFinite(winningOrder.executedQuantity) &&
                  winningOrder.executedQuantity > 0
                ) {
                  await this.attachExitPlan(
                    client,
                    winningOrder,
                    winningOrder.executedQuantity,
                  );
                }
             } catch (err) {
                const winnerIsTerminalOrFilled = winningOrder !== undefined &&
                  ORDER_STATUS_RANK[winningOrder.status] >= ORDER_STATUS_RANK.CANCELLED;
                if (winnerIsTerminalOrFilled) {
                  // The broker snapshot already won persistence. Side effects
                  // are best-effort and may fail independently; record the
                  // error without touching the authoritative lifecycle state.
                  try {
                    const persistedRows = await this.db
                      .update(schema.orders)
                      .set({
                        syncReason: err instanceof Error ? err.message : String(err),
                        syncAttempts: order.syncAttempts + 1,
                        lastSyncAttemptAt: new Date(),
                      })
                      .where(tenantOrderWhere(order))
                      .returning({ id: schema.orders.id });
                    if (persistedRows.length !== 1) {
                      winningOrder = await readAuthoritativeOrder();
                      logger.warn(LOG_SERVICE, "Post-fill sync-reason update was not singular", {
                        orderId: order.id,
                        returnedRows: persistedRows.length,
                      });
                    }
                  } catch (persistError) {
                    logger.error(
                      LOG_SERVICE,
                      "Failed to persist post-fill reconciliation error",
                      { orderId: order.id, ...describeSyncError(persistError) },
                    );
                  }
                } else if (order.status === "PENDING" || order.status === "SYNCING") {
                  // A 404 on a row that never carried a broker order id is PROOF
                  // of absence, not an order we failed to read, so the status is
                  // left exactly as its owner wrote it.
                  //
                  // The lookup above only reached getOrderByClientId because
                  // there is no brokerOrderId, i.e. nothing here ever saw the
                  // broker accept this order. Alpaca answering "no such client
                  // order id" therefore settles the question: the submission
                  // never landed. SYNCING asserts the opposite ("the broker has
                  // this and we cannot read it"), and asserting it cost a real
                  // order. copy-mirror deliberately leaves its row PENDING after
                  // a transient createOrder failure, because PENDING is the
                  // marker its next delivery attempt reads to RESUME the stored
                  // intent, and its dedupe treats anything else as already
                  // mirrored. This poller ticks every 30s and copy-mirror's
                  // first retry is also at +30s, so this write usually got there
                  // first: the retry then logged "duplicate (already mirrored)",
                  // returned that outcome, and the poll loop marked the delivery
                  // COMPLETED, which is terminal. No order existed anywhere,
                  // every log line said the delivery succeeded, and a mirrored
                  // exit was silently never placed.
                  //
                  // The attempt is still recorded (reason, count, timestamp).
                  // Nothing is lost by keeping the truthful status: PENDING and
                  // SYNCING are both inside this poller's scan set, so the row is
                  // re-read on the next tick either way.
                  //
                  // Deliberately narrow. An AMBIGUOUS failure (timeout, 5xx,
                  // transport) still escalates to SYNCING, because there the
                  // broker may genuinely be holding the order and this row is not
                  // ours to call never-submitted.
                  const provenAbsentAtBroker = !order.brokerOrderId && isNotFoundError(err);
                  try {
                    const persistedRows = await this.db
                      .update(schema.orders)
                      .set({
                        // statusUpdatedAt travels with the status: leaving it
                        // untouched keeps it meaning "when this row last changed
                        // state", which is what the chart markers read it as.
                        ...(provenAbsentAtBroker
                          ? {}
                          : { status: "SYNCING" as const, statusUpdatedAt: new Date() }),
                        syncReason: err instanceof Error ? err.message : String(err),
                        syncAttempts: order.syncAttempts + 1,
                        lastSyncAttemptAt: new Date(),
                      })
                      .where(and(
                        tenantOrderWhere(order),
                        orderStatusTransitionCondition("SYNCING"),
                        preserveBrokerOrderIdCondition(order.brokerOrderId),
                      ))
                      .returning({ id: schema.orders.id });
                    if (persistedRows.length !== 1) {
                      winningOrder = await readAuthoritativeOrder();
                      logger.warn(LOG_SERVICE, "Reconciliation status update was not singular", {
                        orderId: order.id,
                        returnedRows: persistedRows.length,
                      });
                    }
                  } catch (persistError) {
                    logger.error(
                      LOG_SERVICE,
                      "Failed to persist reconciliation attempt",
                      { orderId: order.id, ...describeSyncError(persistError) },
                    );
                  }
                }
                logger.error(LOG_SERVICE, "Failed to sync order", {
                  orderId: order.id,
                  symbol: order.symbol,
                  assetType: order.assetType,
                  ...describeSyncError(err),
                });
             }
          }
        } catch (err) {
          logger.error(LOG_SERVICE, "Failed processing user", {
            userId,
            ...describeSyncError(err),
          });
        }
      }
    } catch (error) {
      logger.error(LOG_SERVICE, "Polling error", describeSyncError(error));
    }
  }

  /**
   * Place the take-profit + trailing-stop legs of a filled entry's exit plan
   * against the now-held position. Each leg is claimed and checkpointed
   * independently; recoverable failures leave the parent pending for a later
   * poll, while structurally unsafe plans are marked failed.
   */
  private async attachExitPlan(
    client: AlpacaClient,
    order: typeof schema.orders.$inferSelect,
    filledQty: number
  ) {
    const plan = order.exitPlan;
    if (!plan) return;

    const legs = computeExitLegs(plan, filledQty);
    if (!legs) {
      const failedRows = await this.db
        .update(schema.orders)
        .set({
          exitPlanStatus: "failed",
          exitPlanError: `Filled quantity ${filledQty} too small to split into exit legs`,
        })
        .where(eq(schema.orders.id, order.id))
        .returning({ id: schema.orders.id });
      if (failedRows.length !== 1) {
        logger.warn(LOG_SERVICE, "Smart Exit invalid-plan status was not singular", {
          orderId: order.id,
          returnedRows: failedRows.length,
        });
      }
      return;
    }

    const exitPlanClientOrderId = order.clientOrderId ?? `exit_${order.id}`;
    const desiredLegs: DesiredSmartExitLeg[] = [
      ...legs.takeProfits.map((tp, index) => ({
        legKey: `tp${index}`,
        legType: "take_profit" as const,
        clientOrderId: deriveClientOrderId(exitPlanClientOrderId, `tp${index}`),
        quantity: tp.qty,
        limitPrice: tp.price.toString(),
        stopPrice: plan.stopPrice && plan.stopPrice > 0 ? plan.stopPrice.toString() : null,
        trailPercent: null,
      })),
      ...(legs.trailingStop ? [{
        legKey: "trail",
        legType: "trailing_stop" as const,
        clientOrderId: deriveClientOrderId(exitPlanClientOrderId, "trail"),
        quantity: legs.trailingStop.qty,
        limitPrice: null,
        stopPrice: null,
        trailPercent: legs.trailingStop.trailPercent.toString(),
      }] : []),
    ];

    const persistedLegs = await this.db.query.smartExitLegs.findMany({
      where: eq(schema.smartExitLegs.entryOrderId, order.id),
    });
    const legsByKey = new Map(persistedLegs.map((leg) => [leg.legKey, leg]));

    for (const desired of desiredLegs) {
      if (legsByKey.has(desired.legKey)) continue;

      const [inserted] = await this.db
        .insert(schema.smartExitLegs)
        .values({
          entryOrderId: order.id,
          ...desired,
        })
        .onConflictDoNothing({
          target: [schema.smartExitLegs.entryOrderId, schema.smartExitLegs.legKey],
        })
        .returning();
      const persisted = inserted ?? await this.db.query.smartExitLegs.findFirst({
        where: and(
          eq(schema.smartExitLegs.entryOrderId, order.id),
          eq(schema.smartExitLegs.legKey, desired.legKey),
        ),
      });
      if (!persisted) {
        throw new Error(`Could not persist Smart Exit leg ${desired.legKey}`);
      }
      legsByKey.set(desired.legKey, persisted);
    }

    for (const desired of desiredLegs) {
      const persisted = legsByKey.get(desired.legKey)!;
      if (persisted.status === "attached") continue;

      const claimToken = randomUUID();
      const claimedAt = new Date();
      const claimedRows = await this.db
        .update(schema.smartExitLegs)
        .set({
          status: "submitting",
          attempts: sql`${schema.smartExitLegs.attempts} + 1`,
          claimToken,
          claimExpiresAt: new Date(claimedAt.getTime() + SMART_EXIT_CLAIM_MS),
          nextAttemptAt: null,
          error: null,
        })
        .where(and(
          eq(schema.smartExitLegs.id, persisted.id),
          or(
            eq(schema.smartExitLegs.status, "pending"),
            and(
              eq(schema.smartExitLegs.status, "retryable"),
              or(
                isNull(schema.smartExitLegs.nextAttemptAt),
                lte(schema.smartExitLegs.nextAttemptAt, claimedAt),
              ),
            ),
            and(
              eq(schema.smartExitLegs.status, "submitting"),
              or(
                isNull(schema.smartExitLegs.claimExpiresAt),
                lte(schema.smartExitLegs.claimExpiresAt, claimedAt),
              ),
            ),
          ),
        ))
        .returning();
      if (claimedRows.length !== 1) {
        logger.warn(LOG_SERVICE, "Smart Exit leg claim was not singular", {
          orderId: order.id,
          legKey: desired.legKey,
          returnedRows: claimedRows.length,
        });
        continue;
      }
      const claimed = claimedRows[0]!;

      let brokerOrder: { id: string; status?: string };
      try {
        try {
          brokerOrder = await client.getOrderByClientId(claimed.clientOrderId);
        } catch (lookupError) {
          if (!isNotFoundError(lookupError)) throw lookupError;
          brokerOrder = await this.submitExitLeg(client, order, claimed);
        }
      } catch (err) {
        const permanent = isPermanentBrokerError(err);
        const message = claimed.legType === "take_profit"
          ? `TP at $${Number(claimed.limitPrice)}: ${brokerErrorMessage(err)}`
          : `Trailing stop: ${brokerErrorMessage(err)}`;
        const checkpointRows = await this.db
          .update(schema.smartExitLegs)
          .set({
            status: permanent ? "manual_intervention" : "retryable",
            error: message,
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: permanent ? null : smartExitNextAttemptAt(claimed.attempts, new Date()),
          })
          .where(and(
            eq(schema.smartExitLegs.id, claimed.id),
            eq(schema.smartExitLegs.status, "submitting"),
            eq(schema.smartExitLegs.claimToken, claimToken),
          ))
          .returning({ id: schema.smartExitLegs.id });
        if (checkpointRows.length !== 1) {
          logger.warn(LOG_SERVICE, "Smart Exit failure checkpoint was not singular", {
            orderId: order.id,
            legKey: claimed.legKey,
            returnedRows: checkpointRows.length,
          });
        }
        continue;
      }

      if (isUnsafeBrokerLegStatus(brokerOrder.status)) {
        const message = claimed.legType === "take_profit"
          ? `TP at $${Number(claimed.limitPrice)}: recovered broker order is ${brokerOrder.status}`
          : `Trailing stop: recovered broker order is ${brokerOrder.status}`;
        const checkpointRows = await this.db
          .update(schema.smartExitLegs)
          .set({
            status: "manual_intervention",
            brokerOrderId: brokerOrder.id,
            error: message,
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: null,
          })
          .where(and(
            eq(schema.smartExitLegs.id, claimed.id),
            eq(schema.smartExitLegs.status, "submitting"),
            eq(schema.smartExitLegs.claimToken, claimToken),
          ))
          .returning({ id: schema.smartExitLegs.id });
        if (checkpointRows.length !== 1) {
          logger.warn(LOG_SERVICE, "Smart Exit unsafe-status checkpoint was not singular", {
            orderId: order.id,
            legKey: claimed.legKey,
            returnedRows: checkpointRows.length,
          });
        }
        continue;
      }

      try {
        const checkpointRows = await this.db
          .update(schema.smartExitLegs)
          .set({
            status: "attached",
            brokerOrderId: brokerOrder.id,
            error: null,
            attachedAt: new Date(),
            claimToken: null,
            claimExpiresAt: null,
            nextAttemptAt: null,
          })
          .where(and(
            eq(schema.smartExitLegs.id, claimed.id),
            eq(schema.smartExitLegs.status, "submitting"),
            eq(schema.smartExitLegs.claimToken, claimToken),
          ))
          .returning({ id: schema.smartExitLegs.id });
        if (checkpointRows.length !== 1) {
          logger.warn(LOG_SERVICE, "Smart Exit success checkpoint was not singular", {
            orderId: order.id,
            legKey: claimed.legKey,
            returnedRows: checkpointRows.length,
          });
        }
      } catch (checkpointError) {
        logger.error(
          LOG_SERVICE,
          "Broker accepted Smart Exit leg but its checkpoint failed; the lease will expire for reconciliation",
          { legKey: claimed.legKey, ...describeSyncError(checkpointError) },
        );
      }
    }

    const finalLegs = await this.db.query.smartExitLegs.findMany({
      where: eq(schema.smartExitLegs.entryOrderId, order.id),
    });
    const expectedKeys = new Set(desiredLegs.map((leg) => leg.legKey));
    const expectedRows = finalLegs.filter((leg) => expectedKeys.has(leg.legKey));
    const legErrors = expectedRows
      .filter((leg) => ["retryable", "manual_intervention"].includes(leg.status) && leg.error)
      .map((leg) => leg.error!);
    const hasManualIntervention = expectedRows.some(
      (leg) => leg.status === "manual_intervention",
    );

    // A stop price without a take-profit row cannot be represented at Alpaca.
    if (plan.stopPrice && plan.stopPrice > 0 && legs.takeProfits.length === 0) {
      legErrors.push(
        `Fixed stop at $${plan.stopPrice} was not placed: all take-profit legs produced ` +
          `zero-lot quantities after flooring against the filled quantity (${filledQty} shares). ` +
          `The trailing stop was placed but the fixed stop was dropped. ` +
          `Please add a manual stop order via the position management panel.`
      );
      const failedRows = await this.db
        .update(schema.orders)
        .set({ exitPlanStatus: "failed", exitPlanError: legErrors.join("; ") })
        .where(and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.exitPlanStatus, "pending"),
        ))
        .returning({ id: schema.orders.id });
      if (failedRows.length !== 1) {
        logger.warn(LOG_SERVICE, "Smart Exit parent failure status was not singular", {
          orderId: order.id,
          returnedRows: failedRows.length,
        });
      }
      return;
    }

    const allAttached = expectedRows.length === desiredLegs.length &&
      expectedRows.every((leg) => leg.status === "attached");
    if (allAttached) {
      const attachedRows = await this.db
        .update(schema.orders)
        .set({ exitPlanStatus: "attached", exitPlanError: null })
        .where(and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.exitPlanStatus, "pending"),
        ))
        .returning({ id: schema.orders.id });
      if (attachedRows.length !== 1) {
        let authoritativeOrderId: string | null = null;
        let authoritativeExitPlanStatus: SyncOrder["exitPlanStatus"] | null = null;
        try {
          const ordersQuery = this.db.query?.orders;
          const findFirst = ordersQuery?.findFirst;
          if (typeof findFirst === "function") {
            const authoritative = await ordersQuery.findFirst({
              where: tenantOrderWhere(order),
              columns: { id: true, exitPlanStatus: true },
            });
            authoritativeOrderId = authoritative?.id ?? null;
            authoritativeExitPlanStatus = authoritative?.exitPlanStatus ?? null;
          }
        } catch (rereadError) {
          logger.warn(LOG_SERVICE, "Smart Exit parent exit-plan state reread failed", {
            orderId: order.id,
            ...describeSyncError(rereadError),
          });
        }
        logger.warn(LOG_SERVICE, "Smart Exit parent exit-plan status CAS was not singular", {
          orderId: order.id,
          returnedRows: attachedRows.length,
          authoritativeOrderId,
          authoritativeExitPlanStatus,
        });
      } else {
        console.log(
          `[OrderSyncPoller] Attached exit plan for ${order.symbol} (order ${order.id}): ` +
            `${legs.takeProfits.length} OCO TP + ${legs.trailingStop ? "trailing runner" : "no trailing"}`
        );
      }
    } else if (hasManualIntervention) {
      const failedRows = await this.db
        .update(schema.orders)
        .set({ exitPlanStatus: "failed", exitPlanError: legErrors.join("; ") })
        .where(and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.exitPlanStatus, "pending"),
        ))
        .returning({ id: schema.orders.id });
      if (failedRows.length !== 1) {
        logger.warn(LOG_SERVICE, "Smart Exit manual-intervention status was not singular", {
          orderId: order.id,
          returnedRows: failedRows.length,
        });
      }
      // A position left without its protective exits. Routed through the
      // logger, like every other failure here, so it counts toward the
      // error-burst alert instead of scrolling past in stdout.
      logger.error(LOG_SERVICE, "Exit plan requires manual intervention", {
        orderId: order.id,
        symbol: order.symbol,
        legErrors,
      });
    } else if (legErrors.length > 0) {
      const pendingRows = await this.db
        .update(schema.orders)
        .set({ exitPlanStatus: "pending", exitPlanError: legErrors.join("; ") })
        .where(and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.exitPlanStatus, "pending"),
        ))
        .returning({ id: schema.orders.id });
      if (pendingRows.length !== 1) {
        logger.warn(LOG_SERVICE, "Smart Exit parent retry status was not singular", {
          orderId: order.id,
          returnedRows: pendingRows.length,
        });
      }
      logger.error(LOG_SERVICE, "Exit plan will resume", {
        orderId: order.id,
        symbol: order.symbol,
        legErrors,
      });
    }
  }

  private async submitExitLeg(
    client: AlpacaClient,
    order: typeof schema.orders.$inferSelect,
    leg: SmartExitLeg,
  ): Promise<{ id: string }> {
    const plan = order.exitPlan!;
    if (leg.legType === "take_profit" && leg.stopPrice) {
      return client.createOCOOrder({
            symbol: order.symbol,
            qty: leg.quantity,
            side: plan.exitSide,
            type: "limit",
            order_class: "oco",
            time_in_force: "gtc",
            take_profit: { limit_price: Number(leg.limitPrice) },
            stop_loss: { stop_price: Number(leg.stopPrice) },
            client_order_id: leg.clientOrderId,
      });
    }
    if (leg.legType === "take_profit") {
      return client.createOrder({
        symbol: order.symbol,
        qty: leg.quantity,
        side: plan.exitSide,
        type: "limit",
        time_in_force: "gtc",
        limit_price: Number(leg.limitPrice),
        client_order_id: leg.clientOrderId,
      });
    }
    return client.createTrailingStopOrder({
      symbol: order.symbol,
      qty: leg.quantity,
      side: plan.exitSide,
      type: "trailing_stop",
      time_in_force: "gtc",
      trail_percent: Number(leg.trailPercent),
      client_order_id: leg.clientOrderId,
    });
  }
}
