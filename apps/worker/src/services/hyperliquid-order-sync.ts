/**
 * Hyperliquid Perp Order-Sync Poller
 *
 * ============================================================================
 *  Mirrors OrderSyncPoller (order-sync.ts), but for the Hyperliquid venue.
 * ============================================================================
 *
 * Reconciles the DB's open PERP orders (venue="hyperliquid", status
 * SUBMITTED/PARTIAL) against Hyperliquid's `userFills` + `openOrders` for each
 * user's master account, moving them to FILLED / PARTIAL / CANCELLED and
 * recording executed size/price/funding. It reuses the SAME credential
 * decryption + the SAME `@trade-bot/hyperliquid` factory the API uses (imported
 * relatively, exactly like OrderSyncPoller imports the Alpaca helpers) — no
 * duplicated factory logic.
 *
 * SAFETY — this poller is strictly READ-ONLY reconciliation:
 *
 *   1. ON BY DEFAULT, with a kill switch. Perp orders should always be in sync
 *      with the venue, so this runs unless HYPERLIQUID_SYNC_ENABLED is exactly
 *      the string "false". It is NOT gated like CopyMirrorPoller, whose flag
 *      guards spending money; this one only reads. See isHyperliquidSyncEnabled
 *      for why off is the broken default rather than the cautious one.
 *
 *   2. READ-ONLY — it only calls the keyless InfoClient (userFills / openOrders /
 *      exact orderStatus)
 *      via `createHyperliquidInfoClient`. It NEVER constructs a signing
 *      ExchangeClient, so it structurally cannot place, cancel, close, or
 *      transfer/withdraw. Withdrawals are additionally denied enclave-side by the
 *      Privy policy (defense in depth).
 *
 *   3. PURE DECISIONS — every state transition is computed by the exported,
 *      unit-tested `reconcilePerpOrder()` in apps/api/src/lib/hyperliquid-order-sync.ts,
 *      which never touches a DB or the network.
 */

import {
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
  schema,
  type WorkerPoolDb,
} from "@trade-bot/db";
import {
  hyperliquidReadStatus,
  isPerpDexCovered,
  isTransientHyperliquidReadError,
  networkFromEnv,
  perpDexName,
  type HyperliquidOpenOrdersSnapshot,
} from "@trade-bot/hyperliquid";
import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { createProductionLogger } from "@trade-bot/logger";

// Reuse — do NOT reinvent — the per-user credential decryption and the shared
// Hyperliquid client factory that the API order path already uses. Relative,
// extensionless imports match the worker's "bundler" moduleResolution (see
// order-sync.ts / copy-mirror.ts, which import API libs the same way).
import { getDecryptedCredentials } from "../../../api/src/lib/credentials";
import { createHyperliquidInfoClient } from "../../../api/src/lib/hyperliquid";
import { tradeActionSide } from "../../../api/src/lib/trade-action";
import {
  closeReasonForOrderType,
  sendDiscordNotification,
} from "./discord-notify";
import {
  perpPlacementLeaseState,
} from "./copy-mirror-perp-placement-lease";

// Pure, DB-free, network-free reconciliation logic shared with the unit tests.
import {
  reconcilePerpOrder,
  findRestingMatch,
  isMeaningfulUpdate,
  venueEntryMatcher,
  type HlFill,
  type HlOpenOrder,
  type OpenPerpOrder,
} from "../../../api/src/lib/hyperliquid-order-sync";

const logger = createProductionLogger();

const LOG_SERVICE = "hyperliquid-order-sync";
const ACTIVE_ORDER_SCAN_CAP = 5_000;

/** PostgreSQL is authoritative for the timestamps persisted in orders. */
async function readDatabaseNow(db: WorkerPoolDb): Promise<Date | null> {
  const execute = (db as any).execute;
  if (typeof execute !== "function") return null;
  try {
    const result = await execute.call(db, sql`SELECT CURRENT_TIMESTAMP AS now`);
    const row = Array.isArray(result)
      ? result[0]
      : Array.isArray(result?.rows)
        ? result.rows[0]
        : result;
    const raw = row && typeof row === "object" ? Reflect.get(row, "now") : undefined;
    // PostgreSQL drivers return timestamp values as Date or text. Reject
    // numbers and other coercible values: `new Date("12345")` is a valid but
    // nonsensical year, and accepting it would re-enable clock-skewed writes.
    const parsed = raw instanceof Date
      ? new Date(raw.getTime())
      : typeof raw === "string" && raw.trim() !== ""
        ? new Date(raw)
        : null;
    return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  } catch (error) {
    logger.warn(LOG_SERVICE, "[hyperliquid-order-sync] database clock read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
type OpenOrdersRead = {
  orders: HlOpenOrder[];
  coveredDexes: readonly string[];
  complete: boolean;
  failures: Array<{ source: string; transient: boolean; status?: number }>;
};

type OrderReadCoverage = Pick<OpenOrdersRead, "complete" | "coveredDexes">;

function safeErrorContext(error: unknown): Record<string, unknown> {
  const status = hyperliquidReadStatus(error);
  return {
    errorName:
      error instanceof Error && error.name ? error.name : "UnknownError",
    ...(status !== undefined ? { status } : {}),
  };
}

function logReadFailure(message: string, error: unknown): void {
  const context = safeErrorContext(error);
  if (isTransientHyperliquidReadError(error))
    logger.warn(LOG_SERVICE, message, context);
  else logger.error(LOG_SERVICE, message, context);
}

function logOpenOrdersCoverage(
  failures: OpenOrdersRead["failures"] = [],
): void {
  const context = {
    failedSources: failures.map(({ source, status }) => ({
      source,
      ...(status !== undefined ? { status } : {}),
    })),
  };
  if (failures.length > 0 && failures.every((failure) => failure.transient)) {
    logger.warn(
      LOG_SERVICE,
      "[hyperliquid-order-sync] open-order coverage incomplete",
      context,
    );
  } else {
    logger.error(
      LOG_SERVICE,
      "[hyperliquid-order-sync] open-order coverage incomplete",
      context,
    );
  }
}

export async function readOpenOrdersWithCoverage(
  infoClient: {
    openOrders: (address: `0x${string}`) => Promise<unknown>;
    openOrdersWithStatus?: (
      address: `0x${string}`,
      dexes?: readonly string[],
    ) => Promise<HyperliquidOpenOrdersSnapshot<unknown>>;
    listOpenOrdersWithStatus?: (
      address: `0x${string}`,
      dexes?: readonly string[],
    ) => Promise<HyperliquidOpenOrdersSnapshot<unknown>>;
  },
  address: `0x${string}`,
  dexes: readonly string[],
): Promise<OpenOrdersRead> {
  // `openOrders` can omit position-linked trigger orders. The frontend view is
  // the venue endpoint that includes those live SL/TP legs, so reconciliation
  // must prefer it or an accepted manual stop can remain locally PENDING.
  if (infoClient.listOpenOrdersWithStatus) {
    return (await infoClient.listOpenOrdersWithStatus(
      address,
      dexes,
    )) as OpenOrdersRead;
  }
  if (infoClient.openOrdersWithStatus) {
    return (await infoClient.openOrdersWithStatus(
      address,
      dexes,
    )) as OpenOrdersRead;
  }
  return {
    orders: (await infoClient.openOrders(address)) as HlOpenOrder[],
    coveredDexes: [""],
    complete: true,
    failures: [],
  };
}

function isAutoMirroredOrder(
  order: Pick<typeof schema.orders.$inferSelect, "clientOrderId">,
): boolean {
  return order.clientOrderId?.startsWith(`copymirror:`) === true;
}

const EXECUTED_SIZE_SCALE = 8;
const EXECUTED_PRICE_SCALE = 8;

function decimalUnits(value: string, scale: number): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(
    value.trim(),
  );
  if (!match) return null;

  const exponent = Number.parseInt(match[4] ?? "0", 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;

  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2]}${fraction}`);
  const scaleShift = scale + exponent - fraction.length;
  let units: bigint;
  if (scaleShift >= 0) {
    units = digits * 10n ** BigInt(scaleShift);
  } else {
    const divisor = 10n ** BigInt(-scaleShift);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    units = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  return match[1] === "-" ? -units : units;
}

function executedSizeUnits(value: string): bigint | null {
  return decimalUnits(value, EXECUTED_SIZE_SCALE);
}

function hasExecutedSizeIncrease(
  previous: string | null,
  next: string,
): boolean {
  const previousSize = executedSizeUnits(previous ?? "0");
  const nextSize = executedSizeUnits(next);
  return previousSize !== null && nextSize !== null && nextSize > previousSize;
}

function formatDecimalUnits(units: bigint, scale: number): string {
  const absolute = units < 0n ? -units : units;
  const whole = absolute / 10n ** BigInt(scale);
  const fraction = (absolute % 10n ** BigInt(scale))
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/, "");
  return `${units < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatExecutedSizeUnits(units: bigint): string {
  return formatDecimalUnits(units, EXECUTED_SIZE_SCALE);
}

function executedSizeDelta(
  previous: string | null,
  next: string,
): string | null {
  const previousSize = executedSizeUnits(previous ?? "0");
  const nextSize = executedSizeUnits(next);
  if (previousSize === null || nextSize === null || nextSize <= previousSize)
    return null;
  return formatExecutedSizeUnits(nextSize - previousSize);
}

function incrementalFillPrice(
  previousSize: string | null,
  previousVwap: string | null,
  nextSize: string,
  nextVwap: string | null,
): string | null {
  if (nextVwap === null) return null;
  const previousSizeUnits = executedSizeUnits(previousSize ?? "0");
  const nextSizeUnits = executedSizeUnits(nextSize);
  const nextPriceUnits = decimalUnits(nextVwap, EXECUTED_PRICE_SCALE);
  if (
    previousSizeUnits === null ||
    nextSizeUnits === null ||
    nextPriceUnits === null ||
    nextSizeUnits <= previousSizeUnits
  ) {
    return null;
  }

  if (previousSizeUnits === 0n) {
    return formatDecimalUnits(nextPriceUnits, EXECUTED_PRICE_SCALE);
  }
  if (previousVwap === null) return null;
  const previousPriceUnits = decimalUnits(previousVwap, EXECUTED_PRICE_SCALE);
  if (previousPriceUnits === null) return null;

  const deltaSizeUnits = nextSizeUnits - previousSizeUnits;
  const deltaNotionalUnits =
    nextSizeUnits * nextPriceUnits - previousSizeUnits * previousPriceUnits;
  if (deltaNotionalUnits <= 0n) return null;
  const deltaPriceUnits =
    (deltaNotionalUnits + deltaSizeUnits / 2n) / deltaSizeUnits;
  return formatDecimalUnits(deltaPriceUnits, EXECUTED_PRICE_SCALE);
}

function fillEventId(orderId: string, cumulativeSize: string): string | null {
  const units = executedSizeUnits(cumulativeSize);
  return units === null ? null : `hyperliquid-fill-delta:${orderId}:${units}`;
}

/** How often we reconcile open perp orders. Matches OrderSyncPoller (30s). */
const POLL_INTERVAL_MS = 30_000;
export const ACTIVE_PERP_ORDER_STATUSES = [
  "PENDING",
  "SYNCING",
  "SUBMITTED",
  "PARTIAL",
] as const;
const EXACT_STATUS_PROBE_LIMIT = 2;

/**
 * How long an unreconciled perp order stays in the active scan.
 *
 * A row that never reaches a terminal state is polled forever: it keeps its
 * whole account group in the scan, and every 30-second cycle spends a
 * userFills read, an openOrders read per dex, and up to two exact orderStatus
 * probes re-deciding an order that can no longer change. One row wedged since
 * 2026-07-29 burned roughly 8,000 Hyperliquid reads a day for a month before
 * anyone noticed, and then announced its month-old fill as if it were live.
 *
 * Seven days is far past any venue lag or outage a live order could survive.
 */
export const ABANDONED_PERP_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Written to `sync_reason` so a retired row explains itself. */
export const ABANDONED_PERP_ORDER_REASON =
  "abandoned: exceeded the 7-day reconciliation window";

/**
 * Whether an unreconciled row may be retired on age alone.
 *
 * AGE IS NOT SUFFICIENT BY ITSELF. A resting leg (a limit order, or a
 * reduce-only stop/take-profit protecting an open position) is SUPPOSED to sit
 * at the venue untouched for weeks, and the venue is the source of truth for
 * its state. Expiring such a row locally would tell the app a live stop is
 * gone, which is the failure this repo's broker-state rule exists to prevent.
 *
 * So ONLY `Market` orders retire. A market order never rests: it fills or it
 * does not, within seconds, so past the window it can no longer change.
 *
 * A NULL `brokerOrderId` is deliberately NOT treated as proof the venue never
 * accepted the order. Two live paths leave an acknowledged row without one:
 * the manual perp submit persists `status: "SUBMITTED"` on its own, and the
 * broker-succeeded/DB-write-failed path leaves the row PENDING. A resting limit
 * or protective leg from either path would otherwise be expired here while the
 * venue still owns and may execute it.
 */
export function isRetirablePerpOrder(
  order: Pick<
    typeof schema.orders.$inferSelect,
    "orderType" | "brokerOrderId" | "createdAt"
  >,
  now: number,
  maxAgeMs: number = ABANDONED_PERP_ORDER_MAX_AGE_MS,
): boolean {
  const createdAtMs = order.createdAt?.getTime?.();
  if (!Number.isFinite(createdAtMs)) return false;
  if (now - (createdAtMs as number) <= maxAgeMs) return false;
  return order.orderType === "Market";
}

type ExactOrderStatusReader = (
  address: `0x${string}`,
  clientOrderId: string,
) => Promise<unknown>;

type ExactOrderStatus =
  | { kind: "unknown" }
  | { kind: "found"; brokerOrderId: string; status: string }
  | { kind: "invalid"; error: string };

type ReconcileRuntimeOptions = {
  databaseNow?: Date | null;
  accountAddress?: `0x${string}` | null;
  exactOrderStatus?: ExactOrderStatusReader;
};

interface HyperliquidOrderSyncDependencies {
  notify: typeof sendDiscordNotification;
  /** Injectable only for tests; production uses the shared info client. */
  createInfoClient?: () => ReturnType<typeof createHyperliquidInfoClient>;
  /** Exact order-status authority used before absence-derived mirror cancellation. */
  readOrderStatus?: ExactOrderStatusReader;
}

const defaultDependencies: HyperliquidOrderSyncDependencies = {
  notify: sendDiscordNotification,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function exactBrokerOrderId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

/** Parse the raw orderStatus response without allowing an unknown shape to become absence. */
function parseExactOrderStatus(raw: unknown): ExactOrderStatus {
  if (!isRecord(raw) || typeof raw.status !== "string") {
    return { kind: "invalid", error: "Hyperliquid orderStatus response was malformed" };
  }
  if (raw.status === "unknownOid") return { kind: "unknown" };
  if (raw.status !== "order" || !isRecord(raw.order)) {
    return { kind: "invalid", error: "Hyperliquid orderStatus response was incomplete" };
  }

  const detail = raw.order;
  const brokerOrderId = exactBrokerOrderId(
    isRecord(detail.order) ? detail.order.oid : undefined,
  );
  if (!brokerOrderId || typeof detail.status !== "string" || detail.status.trim() === "") {
    return { kind: "invalid", error: "Hyperliquid orderStatus had no id/status" };
  }
  return {
    kind: "found",
    brokerOrderId,
    status: detail.status.trim(),
  };
}

function exactStatusDisposition(
  status: string,
): "live" | "filled" | "terminal" | null {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "open" ||
    normalized === "triggered" ||
    normalized === "pending" ||
    normalized === "waitingfortrigger"
  ) {
    return "live";
  }
  if (normalized === "filled") return "filled";
  if (
    normalized.includes("cancel") ||
    normalized.includes("reject") ||
    normalized.includes("expire")
  ) {
    return "terminal";
  }
  return null;
}

/**
 * Exact status is intentionally bounded: one found response is authoritative,
 * while absence requires two valid unknownOid responses. Any transport or shape
 * failure is a defer, never permission to infer cancellation.
 */
async function readExactOrderStatus(
  reader: ExactOrderStatusReader | undefined,
  address: `0x${string}` | null | undefined,
  clientOrderId: string,
): Promise<ExactOrderStatus> {
  if (!reader || !address) {
    return { kind: "invalid", error: "Hyperliquid exact orderStatus reader unavailable" };
  }

  for (let attempt = 0; attempt < EXACT_STATUS_PROBE_LIMIT; attempt += 1) {
    let parsed: ExactOrderStatus;
    try {
      parsed = parseExactOrderStatus(await reader(address, clientOrderId));
    } catch (error) {
      return {
        kind: "invalid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (parsed.kind !== "unknown") return parsed;
    if (attempt + 1 < EXACT_STATUS_PROBE_LIMIT) await Promise.resolve();
  }

  return { kind: "unknown" };
}

function exactOrderStatusReaderFor(
  client: ReturnType<typeof createHyperliquidInfoClient>,
): ExactOrderStatusReader | undefined {
  const candidate = client as ReturnType<typeof createHyperliquidInfoClient> & {
    orderStatusByClientOrderId?: ExactOrderStatusReader;
    orderStatus?: ExactOrderStatusReader;
  };
  if (typeof candidate.orderStatusByClientOrderId === "function") {
    return (address, clientOrderId) =>
      candidate.orderStatusByClientOrderId!(address, clientOrderId);
  }
  if (typeof candidate.orderStatus === "function") {
    return (address, clientOrderId) => candidate.orderStatus!(address, clientOrderId);
  }
  return undefined;
}

/**
 * A KILL SWITCH, NOT AN OPT-IN. Reconciliation runs by default.
 *
 * This used to be opt-in (inert unless HYPERLIQUID_SYNC_ENABLED was exactly
 * "true"), copying CopyMirrorPoller's flag idiom. That was the wrong idiom to
 * copy. CopyMirrorPoller's flag guards something that SPENDS money, so off is
 * the safe default. This poller only reads, so off is not the safe default, it
 * is the broken one:
 *
 *   - It is the ONLY writer of `orders.executed_size_decimal` for perps, and
 *     percent/dollar sized closes size themselves from that column. Off means
 *     every perp order ever placed, mirrored or hand-placed in the UI, has no
 *     recorded fill size.
 *   - It is the only process that ever resolves a PENDING perp order against
 *     the venue. Off means those rows park at PENDING forever.
 *
 * So a deployment with perps and no reconciler is not "safer", it is one that
 * cannot account for its own open positions. Perp orders should always be in
 * sync with the venue; there is no deployment that wants otherwise.
 *
 * The cost of leaving it on where perps are unused is one indexed query per
 * cycle that returns zero rows and stops (see poll(): the early return on an
 * empty scan happens before any credential decryption or Hyperliquid call).
 *
 * That claim rests on `orders_hl_perp_active_idx`, a partial index covering
 * exactly this scan's fixed filters. Without it the poll sorts the whole orders
 * table every 30 seconds even where no perp order has ever been placed, so if
 * that index is ever dropped this comment is a lie. Measured on 240k rows and no
 * perps: 3,702 buffers per poll without it, 1 with.
 *
 * Setting HYPERLIQUID_SYNC_ENABLED=false still stops it, for incident response.
 * Note the asymmetry is deliberate: only the exact string "false" disables it,
 * so a typo ("FALSE", "0", "no") leaves reconciliation RUNNING. For a read-only
 * process that is the fail-safe direction.
 *
 * Exported for tests, and duplicated by the perp mirror gate (see
 * copy-mirror-perp-sync-gate.ts) which a test holds to this exact behaviour.
 */
export function isHyperliquidSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.HYPERLIQUID_SYNC_ENABLED !== "false";
}

export class HyperliquidOrderSyncPoller {
  private db: WorkerPoolDb;
  private readonly dependencies: HyperliquidOrderSyncDependencies;
  private isRunning = false;
  /** Single-flight guard: true while a poll cycle is in flight. */
  private polling = false;
  private intervalId?: ReturnType<typeof setInterval>;
  private pollIntervalMs = POLL_INTERVAL_MS;

  constructor(
    db: WorkerPoolDb,
    dependencies: Partial<HyperliquidOrderSyncDependencies> = {},
  ) {
    this.db = db;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  /**
   * Start the poller.
   *
   * Reconciliation runs by DEFAULT. Only HYPERLIQUID_SYNC_ENABLED set to exactly
   * "false" stops it, in which case this logs a warning and returns WITHOUT
   * scheduling anything: no interval, no DB reads, no HL calls. See
   * `isHyperliquidSyncEnabled` for why off is the broken default rather than the
   * cautious one.
   */
  public async start(): Promise<void> {
    if (!isHyperliquidSyncEnabled()) {
      // Deliberate opt-out only. Warn, not info: a deployment that holds perp
      // orders and is not reconciling them cannot size its own closes, and
      // nothing else will report that.
      logger.warn(
        LOG_SERVICE,
        "[hyperliquid-order-sync] DISABLED by HYPERLIQUID_SYNC_ENABLED=false. Open perp " +
          "orders will not be reconciled against the venue and mirrored fill sizes will not " +
          "be recorded. Perp auto-mirroring refuses to run while this is set.",
      );
      return; // <-- inert: nothing scheduled, nothing read.
    }

    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      LOG_SERVICE,
      "[hyperliquid-order-sync] starting perp order reconciliation",
      {
        pollIntervalMs: this.pollIntervalMs,
      },
    );

    void this.poll(); // initial run
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    logger.info(LOG_SERVICE, "[hyperliquid-order-sync] stopped");
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // single-flight
    this.polling = true;
    try {
      // Read the database clock before any scan, legacy sweep, or venue call.
      // A production-shaped pool with no authoritative clock must defer the
      // whole cycle; using process time here could cross a UTC-day boundary
      // differently from placement and daily-cap transactions.
      const databaseNow = await readDatabaseNow(this.db);
      if (databaseNow === null && typeof (this.db as any).execute === "function") {
        logger.warn(
          LOG_SERVICE,
          "[hyperliquid-order-sync] deferring poll because database clock is unavailable",
        );
        return;
      }

      await this.absorbLegacyRealizedPnl();
      // Open Hyperliquid perp orders awaiting reconciliation. PENDING is included
      // so an order stranded by an API crash between insert and the HL submit
      // (never advanced to SUBMITTED) still gets reconciled — the reconciler's
      // min-age + non-empty-snapshot guards keep a fresh mid-submit PENDING from
      // being wrongly cancelled.
      // The network predicate is in the QUERY, not applied to its results.
      //
      // Filtering after a newest-first cap lets rows from another network hide
      // relevant ones permanently: 5,000 newer testnet rows fill the whole scan,
      // every poll selects and discards exactly those, and older mainnet orders
      // are never reconciled. Their fills then never reach close sizing.
      //
      // NULL is included: a row written before the column existed is processed
      // as it always was, rather than being stranded.
      const network = networkFromEnv();
      // Retirement runs AFTER this cycle's reconciliation, never before.
      //
      // An aged row is not proof of a non-event: the 2026-07-29 ghost had
      // genuinely filled, and it was a late reconciliation that finally
      // recorded its size, price and pnl. Terminalizing such a row before
      // reading the venue would drop that outcome for good, since a terminal
      // row is never scanned again and the external-fill poller seeds its
      // cursor at startup rather than replaying old history. So every
      // candidate gets one more full reconciliation pass first, and only what
      // is STILL unresolved afterwards is retired.
      const retirementCutoff = new Date(
        (databaseNow?.getTime() ?? Date.now()) - ABANDONED_PERP_ORDER_MAX_AGE_MS,
      );

      const activeOrders = await this.db.query.orders.findMany({
        where: and(
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          inArray(schema.orders.status, [...ACTIVE_PERP_ORDER_STATUSES]),
          or(
            isNull(schema.orders.venueNetwork),
            eq(schema.orders.venueNetwork, network),
          ),
        ),
        // PROVEN rows first, then newest-first within each group.
        //
        // An unproven row can no longer be cancelled from absence, so it never
        // drains. Under a plain newest-first order, enough of them would fill the
        // cap on every poll and proven rows on the active network would never be
        // reached: their fills would go unrecorded and close sizing would have
        // nothing to work from. Sorting them last bounds that. They are still
        // reconciled, with whatever room is left, rather than being dropped from
        // the scan entirely and never settled at all.
        orderBy: [
          sql`(${schema.orders.venueNetwork} is null)`,
          desc(schema.orders.createdAt),
        ],
        limit: ACTIVE_ORDER_SCAN_CAP,
      });

      if (activeOrders.length === 0) return;

      logger.info(
        LOG_SERVICE,
        `[hyperliquid-order-sync] reconciling ${activeOrders.length} open perp orders`,
      );

      // Group by the ACCOUNT each order was placed on, not by user.
      //
      // A user can reconnect from wallet A to wallet B while an A order is still
      // PENDING/SYNCING/SUBMITTED/PARTIAL. Reading the user's CURRENT credential then
      // fetches B's snapshot, which of course contains no trace of the A order,
      // and once the order clears the min-age guard the reconciler declares it
      // cancelled while it may be live on A. The row already records the account
      // it went to, so that is what it is reconciled against.
      //
      // The info client is keyless and queries by address, so an order carrying a
      // brokerAccountId needs no credential read at all. Only rows without one
      // fall back to resolving the user's current master address.
      const byAccount = new Map<
        string,
        {
          userId: string;
          address: `0x${string}` | null;
          orders: typeof activeOrders;
        }
      >();
      for (const order of activeOrders) {
        const recorded = order.brokerAccountId;
        const key = recorded ? `address:${recorded}` : `user:${order.userId}`;
        const existing = byAccount.get(key);
        if (existing) {
          existing.orders.push(order);
          continue;
        }
        byAccount.set(key, {
          userId: order.userId,
          address: recorded ? (recorded as `0x${string}`) : null,
          orders: [order],
        });
      }

      const infoClient = this.dependencies.createInfoClient?.() ??
        createHyperliquidInfoClient();
      const exactStatusReader =
        this.dependencies.readOrderStatus ?? exactOrderStatusReaderFor(infoClient);

      // Rows this cycle actually read the venue for. Only these may be
      // retired below: a row whose account read failed, or that fell outside
      // the scan cap, has not had its venue outcome resolved and must wait for
      // a cycle that can resolve it.
      const reconciledOrderIds: string[] = [];

      for (const group of byAccount.values()) {
        try {
          let address = group.address;
          if (!address) {
            // The master address is stored on the hyperliquid credential row
            // (accountId/username per walletRefsToCredentialRow). Read-only — we
            // never touch the agent signing wallet here.
            const credentials = await getDecryptedCredentials(
              this.db as any,
              group.userId,
              {
                provider: "hyperliquid",
              },
            );
            const masterAddress = credentials.accountId ?? credentials.username;
            if (!masterAddress) {
              logger.warn(
                LOG_SERVICE,
                `[hyperliquid-order-sync] no master address for user ${group.userId}, skipping`,
              );
              continue;
            }
            address = masterAddress as `0x${string}`;
          }

          const [fillsResult, openOrdersResult] = await Promise.allSettled([
            infoClient.userFills(address),
            readOpenOrdersWithCoverage(infoClient, address, [
              ...new Set(
                group.orders.map((order) => perpDexName(order.symbol)),
              ),
            ]),
          ]);
          if (fillsResult.status === "rejected") throw fillsResult.reason;

          const fills = fillsResult.value as HlFill[];
          const openOrders =
            openOrdersResult.status === "fulfilled"
              ? openOrdersResult.value
              : ({
                  orders: [] as HlOpenOrder[],
                  coveredDexes: [] as readonly string[],
                  complete: false,
                  failures: [
                    {
                      source: "open-orders",
                      transient: isTransientHyperliquidReadError(
                        openOrdersResult.reason,
                      ),
                      ...(hyperliquidReadStatus(openOrdersResult.reason) !==
                      undefined
                        ? {
                            status: hyperliquidReadStatus(
                              openOrdersResult.reason,
                            ),
                          }
                        : {}),
                    },
                  ],
                } satisfies OpenOrdersRead);
          if (!openOrders.complete)
            logOpenOrdersCoverage(openOrders.failures ?? []);

          for (const order of group.orders) {
            // Only rows whose venue outcome was actually settled this cycle may
            // be handed to the retirement sweep. `reconcileOne` returns without
            // concluding anything in several safety cases (a placement lease
            // still in flight, an unreadable exact status, a venue that says
            // the order is live), and treating those as reconciled is what
            // would let the sweep mark a live order EXPIRED.
            const conclusive = await this.reconcileOne(
              order,
              fills,
              openOrders.orders,
              openOrders,
              {
                databaseNow,
                accountAddress: address,
                exactOrderStatus: exactStatusReader,
              },
            );
            if (conclusive) reconciledOrderIds.push(order.id);
          }
        } catch (err) {
          logReadFailure(
            "[hyperliquid-order-sync] account reconciliation failed",
            err,
          );
        }
      }

      // Whatever reconciliation just resolved has left the active statuses and
      // is no longer claimable here; the rest is dead weight on every future
      // cycle.
      await this.retireAbandonedOrders(
        retirementCutoff,
        reconciledOrderIds,
        network,
      );
    } catch (error) {
      logger.error(LOG_SERVICE, "[hyperliquid-order-sync] polling error", {
        ...safeErrorContext(error),
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Retire perp orders too old to ever reconcile.
   *
   * Marks them EXPIRED with an explanatory `sync_reason` so they leave the
   * active scan for good. Deliberately SILENT: nothing here calls notify. A
   * week-old order resolving today is not news, and announcing it is the exact
   * bug that surfaced this code path.
   *
   * Only claims what `isRetirablePerpOrder` allows: `Market` orders, which
   * cannot rest. A limit or reduce-only stop/take-profit is never touched here
   * at any age; the venue owns its state and it may legitimately rest for
   * months, with or without a locally recorded `brokerOrderId`.
   *
   * Scoped to `reconciledOrderIds`, the rows this cycle actually read the venue
   * for. A row is never terminalized before its venue outcome has been asked
   * for: reconciliation runs first and takes anything it can resolve out of the
   * active statuses this claims.
   *
   * Scoped to the configured network too, matching the reconciliation scan. A
   * worker on one chain must not terminalize the other chain's rows, which it
   * never queries.
   *
   * Best-effort and non-fatal: a failed sweep must not stop the cycle's real
   * work, and the next cycle retries it.
   */
  private async retireAbandonedOrders(
    cutoff: Date,
    reconciledOrderIds: readonly string[],
    network: ReturnType<typeof networkFromEnv>,
  ): Promise<void> {
    if (reconciledOrderIds.length === 0) return;
    try {
      const retired = await this.db
        .update(schema.orders)
        .set({ status: "EXPIRED", syncReason: ABANDONED_PERP_ORDER_REASON })
        .where(
          and(
            eq(schema.orders.venue, "hyperliquid"),
            eq(schema.orders.assetType, "PERP"),
            inArray(schema.orders.id, [...reconciledOrderIds]),
            inArray(schema.orders.status, [...ACTIVE_PERP_ORDER_STATUSES]),
            or(
              isNull(schema.orders.venueNetwork),
              eq(schema.orders.venueNetwork, network),
            ),
            lt(schema.orders.createdAt, cutoff),
            eq(schema.orders.orderType, "Market"),
          ),
        )
        .returning({
          id: schema.orders.id,
          symbol: schema.orders.symbol,
          orderType: schema.orders.orderType,
        });

      if (retired.length > 0) {
        logger.warn(
          LOG_SERVICE,
          `[hyperliquid-order-sync] retired ${retired.length} perp order(s) older than the reconciliation window`,
          {
            cutoff: cutoff.toISOString(),
            orders: retired.map((row) => ({
              orderId: row.id,
              symbol: row.symbol,
              orderType: row.orderType,
            })),
          },
        );
      }
    } catch (error) {
      logger.error(
        LOG_SERVICE,
        "[hyperliquid-order-sync] abandoned-order sweep failed",
        { ...safeErrorContext(error) },
      );
    }
  }

  /**
   * Move any realized PnL still sitting in the retired `funding_paid` column.
   *
   * `reconcileOne` absorbs it per row, but only for rows the ACTIVE-order scan
   * returns, and that scan covers PENDING/SYNCING/SUBMITTED/PARTIAL only. Migration 0027
   * runs in the API build while this worker deploys separately, so an old worker
   * can take an order all the way to FILLED in the window: it writes the final
   * cumulative to `funding_paid`, and the row is terminal by the time this
   * process starts, so nothing here would ever look at it again.
   *
   * COPIES, and deliberately does not clear. The old worker uses `funding_paid`
   * as its accumulation base, so emptying it mid-rollout makes its next fill
   * write back only that fill's suffix, and a reader that prefers this column
   * would then take the suffix for the whole and permanently reduce the total.
   * Both columns are kept identical instead, which is correct whichever worker
   * touches the row next.
   *
   * Runs every cycle rather than once at startup, because a rolling deploy can
   * leave the old worker writing for a while after this one comes up. It is
   * idempotent, and `orders_hl_legacy_pnl_idx` covers exactly the rows where the
   * two columns still disagree, so it empties as they converge and this costs
   * one empty index scan afterwards.
   *
   * The follow-up that retires all of this, once no old worker can be running,
   * drops the dual-write, this sweep and its index, and nulls `funding_paid`
   * once for real. Its steps and the check to run first are in
   * docs/deployment/perp-pnl-column-split.md.
   */
  private async absorbLegacyRealizedPnl(): Promise<void> {
    try {
      await this.db
        .update(schema.orders)
        .set({ realizedPnl: sql`${schema.orders.fundingPaid}` })
        .where(
          and(
            eq(schema.orders.venue, "hyperliquid"),
            isNotNull(schema.orders.fundingPaid),
            sql`${schema.orders.realizedPnl} is distinct from ${schema.orders.fundingPaid}`,
          ),
        );
    } catch (error) {
      // Never a reason to skip a reconciliation cycle: the next one retries.
      logger.error(
        LOG_SERVICE,
        "[hyperliquid-order-sync] legacy pnl absorption failed",
        {
          ...safeErrorContext(error),
        },
      );
    }
  }

  /**
   * Reconcile a single order and persist the transition. Perp sizes/prices are
   * DECIMAL: executed size → `executedSizeDecimal` (the REQUESTED size in
   * `quantityDecimal` is preserved, never overwritten), price → `executedPrice`,
   * realized pnl → `realizedPnl`. The INTEGER `quantity` / `executedQuantity` columns
   * are NEVER written for perps (they would truncate fractional sizes).
   */
  /**
   * Reconcile one order against the venue reads for its account.
   *
   * Returns whether this cycle CONCLUSIVELY settled the row's venue outcome.
   * False means "no decision was reached", which every deferral below returns:
   * an unreadable database clock, an incomplete DEX read with no matching fill,
   * a quarantine heal that hands the next poll the decision, a placement lease
   * still in flight with no positive venue evidence, an exact-status probe that
   * could not be read or understood, and an exact status of live or filled.
   *
   * Only a true return authorizes `retireAbandonedOrders` to claim the row.
   * Retirement writes a terminal status from ABSENCE of evidence, so a
   * deferral it mistook for a conclusion would terminalize an order that is
   * still resting, still being placed, or still waiting for its fill to land.
   */
  private async reconcileOne(
    order: typeof schema.orders.$inferSelect,
    fills: HlFill[],
    openOrders: HlOpenOrder[],
    coverage: OrderReadCoverage = { complete: true, coveredDexes: [] },
    runtime: ReconcileRuntimeOptions = {},
  ): Promise<boolean> {
    const databaseNow = runtime.databaseNow === undefined
      ? await readDatabaseNow(this.db)
      : runtime.databaseNow;
    if (databaseNow === null && typeof (this.db as any).execute === "function") {
      // Never substitute process time for a production pool. Every transition
      // below writes a durable timestamp or relies on age/lease state, and a
      // process/DB UTC-day disagreement can turn a stale absence into a wrong
      // cancellation (or make placement accounting bypass the daily cap).
      logger.warn(
        LOG_SERVICE,
        "[hyperliquid-order-sync] deferring order because database clock is unavailable",
        { orderId: order.id },
      );
      return false;
    }
    const effectiveDatabaseNow = databaseNow ?? new Date();

    let view: OpenPerpOrder = {
      id: order.id,
      clientOrderId: order.clientOrderId,
      quantityDecimal: order.quantityDecimal,
      executedSizeDecimal: order.executedSizeDecimal,
      lastCountedFillId: order.lastCountedFillId,
      // Needed to EXTEND the cumulative aggregates rather than replace them with
      // a suffix's own average once a cursor is in play.
      executedPrice: order.executedPrice,
      // ABSORB the legacy column. `funding_paid` carried Hyperliquid's closedPnl
      // before `realized_pnl` existed, and migration 0027 deliberately leaves it
      // populated: it runs in the API build while the worker deploys separately,
      // so an OLD worker can still be reconciling into it, advancing the shared
      // fill cursor as it goes. Preferring it here means whatever that worker
      // recorded in the window is picked up rather than stranded behind a cursor
      // that has already moved past those fills. The write below nulls it, so
      // each row is absorbed exactly once and new rows never consult it.
      realizedPnl: order.fundingPaid ?? order.realizedPnl,
      // PLACEMENT time, falling back to row creation. The cancellation guard
      // exists to give a just-placed order time to appear at the venue, and a
      // resumed row can be hours old while its placement is seconds old: aged
      // from created_at it is instantly eligible, so one empty snapshot settles
      // it CANCELLED. Terminal rows are not polled again, so a delayed fill then
      // stays hidden and its exposure cannot be attributed for a copied close.
      createdAtMs: (order.placedAt ?? order.createdAt).getTime(),
      status: order.status,
      brokerOrderId: order.brokerOrderId,
    };

    let reconciliationOpenOrders = openOrders;
    if (
      !coverage.complete &&
      !isPerpDexCovered(coverage.coveredDexes, order.symbol)
    ) {
      const matches = venueEntryMatcher(view);
      const matchedFill = fills.find((fill) => matches(fill.cloid, fill.oid));
      if (!matchedFill) return false;

      // A matching fill is positive evidence and may be reconciled. The
      // synthetic resting row keeps the status PARTIAL until the order's own
      // DEX is readable, so an incomplete absence read cannot retire it as
      // FILLED or CANCELLED.
      reconciliationOpenOrders = [
        {
          coin: matchedFill.coin,
          oid: matchedFill.oid,
          cloid: matchedFill.cloid,
          sz: matchedFill.sz,
          origSz: matchedFill.sz,
        },
      ];
    }

    const databaseNowMs = effectiveDatabaseNow.getTime();
    const placementLeaseState =
      order.status === "PENDING"
        ? perpPlacementLeaseState(
            order.syncReason,
            order.lastSyncAttemptAt,
            databaseNowMs,
          )
        : "inactive";

    // A wildly future-skewed placement marker cannot be trusted as an active
    // lease forever. Heal only the exact PENDING row/marker observed here; if a
    // concurrent owner changed either value, leave its newer claim untouched
    // and let that owner/reconciler decide the next transition.
    if (placementLeaseState === "quarantined") {
      try {
        const healed = await this.db
          .update(schema.orders)
          .set({ syncReason: null, lastSyncAttemptAt: null })
          .where(and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.status, "PENDING"),
            eq(schema.orders.syncReason, order.syncReason!),
            eq(schema.orders.lastSyncAttemptAt, order.lastSyncAttemptAt!),
          ))
          .returning({ id: schema.orders.id });
        if (healed.length !== 1) return false;
      } catch (error) {
        logger.warn(LOG_SERVICE, "[hyperliquid-order-sync] future placement lease quarantine CAS failed", {
          orderId: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      // This cycle intentionally does not make an absence-based decision after
      // healing. The next poll sees the cleared marker and can reclaim safely.
      return false;
    }

    // A resumed PENDING row can be hours old while its current venue attempt is
    // only milliseconds old. Do not infer cancellation from the absence read
    // during that active lease: the policy worker may be between leverage
    // application and venue acceptance, or waiting for its transaction commit.
    // Positive fill/resting evidence still flows through reconciliation; only
    // absence-based cancellation is held. The Phase-B exact row lock is the
    // stronger serialization path, while this marker covers ambiguous transport
    // and transaction-commit windows where the reconciler has no row lock.
    const activePlacementLease =
      placementLeaseState === "active" || placementLeaseState === "future";
    if (activePlacementLease) {
      const matches = venueEntryMatcher(view);
      const hasPositiveVenueEvidence =
        fills.some((fill) => matches(fill.cloid, fill.oid)) ||
        reconciliationOpenOrders.some((entry) => matches(entry.cloid, entry.oid));
      if (!hasPositiveVenueEvidence) return false;
    }

    // A deterministic mirror's aggregate absence is not authoritative:
    // fills/openOrders are bounded and may lag a just-accepted POST. Probe the
    // exact cloid before allowing this poll to retire an aged row. A found
    // status wins over aggregate absence; only two valid unknownOid responses
    // authorize the existing absence-derived cancellation path.
    let exactTerminalStatus = false;
    const venueMatcher = venueEntryMatcher(view);
    const hasPositiveVenueEvidence =
      fills.some((fill) => venueMatcher(fill.cloid, fill.oid)) ||
      reconciliationOpenOrders.some((entry) =>
        venueMatcher(entry.cloid, entry.oid),
      );
    if (isAutoMirroredOrder(order) && !hasPositiveVenueEvidence) {
      const exact = await readExactOrderStatus(
        runtime.exactOrderStatus ?? this.dependencies.readOrderStatus,
        runtime.accountAddress ??
          (order.brokerAccountId as `0x${string}` | null | undefined),
        order.clientOrderId!,
      );
      if (exact.kind === "invalid") {
        logger.warn(
          LOG_SERVICE,
          "[hyperliquid-order-sync] deferring mirror reconciliation because exact cloid status is unavailable",
          { orderId: order.id, reason: exact.error },
        );
        return false;
      }
      if (exact.kind === "found") {
        const disposition = exactStatusDisposition(exact.status);
        if (!disposition) {
          logger.warn(
            LOG_SERVICE,
            "[hyperliquid-order-sync] deferring mirror reconciliation because exact cloid status is unrecognized",
            { orderId: order.id, status: exact.status },
          );
          return false;
        }
        // The exact oid is stronger than any stale aggregate match and lets
        // later fill rows that only carry an oid join this order.
        view = { ...view, brokerOrderId: exact.brokerOrderId };
        // A live or positively terminal (filled) order cannot be cancelled
        // from an empty aggregate. A later fill window will record its size;
        // until then, retaining PENDING is safer than inventing a fill.
        if (disposition === "live" || disposition === "filled") return false;
        exactTerminalStatus = true;
      }
    }

    const update = reconcilePerpOrder(view, fills, reconciliationOpenOrders, {
      nowMs: databaseNowMs,
      // Exact terminal status is authoritative even when the row is younger
      // than the aggregate-absence grace period. UnknownOid probes continue
      // to use the normal age guard.
      ...(exactTerminalStatus ? { minCancelAgeMs: 0 } : {}),
      // A row written before venue_network existed could belong to the other
      // chain, and this snapshot could not contain it either way. Fills still
      // apply; only the cancellation, which argues from absence, is withheld.
      networkUnproven: order.venueNetwork == null,
    });
    // A RESTING order is the venue confirming it accepted this one, and that is
    // worth recording even when nothing else changed.
    //
    // reconcilePerpOrder returns null for a resting order with no fills, since
    // there is no state transition, so the backfill in the update below never
    // runs for it. That is exactly the order this matters most for: if the
    // post-placement write failed, the row has a null placed_at, and until the
    // first fill arrives the daily cap keeps reading coalesce(placed_at,
    // created_at) and counting it against the day the row was created rather
    // than the day it was placed.
    //
    // The time comes from the VENUE's own record, never from when this poll
    // happened to look. Observation time would misdate every order placed before
    // today: on the first rollout with 0024 every existing row has a null
    // placed_at, so a mirrored order resting since last week would be stamped
    // today and start consuming today's cap. countMirrorsToday falls back to
    // created_at precisely to get those right, and a wrong stamp destroys that
    // fallback. An entry carrying no timestamp is left alone for the same
    // reason: there is nothing honest to write.
    const restingPlacedAtMs =
      order.placedAt == null
        ? (findRestingMatch(view, reconciliationOpenOrders)?.timestamp ?? null)
        : null;
    if (restingPlacedAtMs !== null) {
      try {
        const placementRows = await this.db
          .update(schema.orders)
          .set({ placedAt: new Date(restingPlacedAtMs) })
          .where(
            and(eq(schema.orders.id, order.id), isNull(schema.orders.placedAt)),
          )
          .returning({ id: schema.orders.id });
        if (placementRows.length !== 1) {
          logger.warn(
            LOG_SERVICE,
            "Hyperliquid placement backfill was not singular",
            {
              orderId: order.id,
              returnedRows: placementRows.length,
            },
          );
        }
      } catch (error) {
        // Reconciliation is the point of this cycle; a missed backfill is not
        // worth abandoning it, and the next poll sees the same resting order.
        logger.error(
          LOG_SERVICE,
          "[hyperliquid-order-sync] placement backfill failed",
          {
            orderId: order.id,
            ...safeErrorContext(error),
          },
        );
      }
    }

    if (!update || !isMeaningfulUpdate(view, update)) return true;

    logger.info(
      LOG_SERVICE,
      `[hyperliquid-order-sync] order ${order.id} ${order.status} -> ${update.status}`,
      { coin: order.symbol, executedSize: update.executedSize },
    );

    const previousStatus = order.status;
    const isCompletedFill = update.status === "FILLED";
    const hasExecutedDelta = hasExecutedSizeIncrease(
      order.executedSizeDecimal,
      update.executedSize,
    );
    const fillDelta = executedSizeDelta(
      order.executedSizeDecimal,
      update.executedSize,
    );
    const fillDeltaPrice = incrementalFillPrice(
      order.executedSizeDecimal,
      order.executedPrice,
      update.executedSize,
      update.executedPrice,
    );
    const shouldPublishFill = hasExecutedDelta;
    const cancelledWithoutFill =
      update.status === "CANCELLED" &&
      Number(update.executedSize ?? order.executedSizeDecimal ?? "0") === 0;
    // Computed once, written to BOTH pnl columns. `funding_paid` is the legacy
    // name and is still the accumulation base for any old worker that has not
    // been replaced yet, so the two are kept identical rather than one being
    // retired mid-rollout. See the write below.
    const cumulativeRealizedPnl =
      update.realizedPnl ?? order.fundingPaid ?? order.realizedPnl;

    // Absence-based cancellation is valid only for the exact snapshot that was
    // scanned. Phase A can stamp a fresh placement lease after this row was read
    // but before the CAS below, so comparing only id/status would let this stale
    // worker cancel an active PENDING attempt. Positive fill/resting updates do
    // not need this extra predicate: they are authoritative evidence and remain
    // monotonic under the normal status/size/cursor CAS.
    const leaseSnapshotPredicate = update.status === "CANCELLED"
      ? [
          order.lastSyncAttemptAt == null
            ? isNull(schema.orders.lastSyncAttemptAt)
            : eq(schema.orders.lastSyncAttemptAt, order.lastSyncAttemptAt),
          order.syncReason == null
            ? isNull(schema.orders.syncReason)
            : eq(schema.orders.syncReason, order.syncReason),
        ]
      : [];

    // Claim the state transition and publish its social event atomically. Status
    // plus cumulative executed size form the compare-and-set: PARTIAL -> PARTIAL
    // increments retain the same status, so size is the durable exactly-once
    // cursor that prevents overlapping workers from emitting the same delta.
    const persisted = await this.db.transaction(async (tx) => {
      const updatedRows = await tx
        .update(schema.orders)
        .set({
          status: update.status,
          // A conclusively cancelled zero-fill open created no exposure and
          // therefore has nothing to protect. Clear a stale ambiguity marker
          // so the safety backlog cannot report it as a leveraged position.
          perpProtectionStatus:
            cancelledWithoutFill && order.perpProtectionStatus === "unprotected"
              ? "cancelled"
              : order.perpProtectionStatus,
          perpProtectionError:
            cancelledWithoutFill && order.perpProtectionStatus === "unprotected"
              ? null
              : order.perpProtectionError,
          // DECIMAL columns only — never the INTEGER quantity/executedQuantity.
          // Executed size goes to executedSizeDecimal; quantityDecimal (the
          // requested size) is intentionally NOT touched here.
          executedSizeDecimal: update.executedSize,
          // Advance the accumulation cursor with the size it produced, so the
          // next cycle adds only fills newer than these. Null leaves it where it
          // was, which is what a cancellation (no fills counted) reports.
          lastCountedFillId:
            update.lastCountedFillId ?? order.lastCountedFillId,
          // Null means "this response carried no price", never "the price is
          // now unknown". Same rule as executedAt below: a recorded execution
          // price is not erased by a later response that has none, which is what
          // a cancelled remainder on a partially filled order looks like.
          executedPrice: update.executedPrice ?? order.executedPrice,
          // Same rule, and for the same reason: an incomplete fill snapshot
          // withholds realized pnl rather than reporting zero, so writing it
          // through would erase pnl already recorded.
          realizedPnl: cumulativeRealizedPnl,
          // DUAL-WRITTEN, not nulled, for as long as an old worker might still
          // be running.
          //
          // Nulling it looked like the tidy end state and it is a trap: the old
          // worker uses this column as its accumulation BASE. Empty it and its
          // next fill writes back only that fill's suffix, and anything reading
          // this column in preference to realized_pnl then adopts the suffix as
          // the whole, permanently reducing the total. Keeping the two in step
          // means the old worker always extends a correct cumulative and the new
          // one always reads one.
          //
          // The follow-up that removes the fallback drops this write and nulls
          // the column once for real; see the sweep below.
          fundingPaid: cumulativeRealizedPnl,
          brokerOrderId: update.brokerOrderId,
          executedAt:
            update.executedAtMs !== null
              ? new Date(update.executedAtMs)
              : order.executedAt,
          // BACKFILL a placement time the placement path never got to write.
          //
          // The mirror sets `placed_at` right after Hyperliquid accepts, and
          // that write can fail while the order is live. The delivery reports
          // "syncing" and the row is left PENDING with a null `placed_at`, which
          // the daily cap reads through `coalesce(placed_at, created_at)`. A row
          // created before midnight and placed after it is then counted against
          // the wrong day, or against no day at all.
          //
          // ONLY from the venue's own placement timestamp, which comes from the
          // resting-order read above. The fill time is not a substitute and was
          // wrong here: a limit order placed yesterday and filled today would be
          // stamped today and eat a slot in today's cap, which is worse than the
          // created_at fallback it replaced. Nothing else the venue gives us for
          // a filled order says when it was placed, so an order that fills
          // before this ever sees it resting keeps the created_at fallback.
          placedAt:
            order.placedAt ??
            (restingPlacedAtMs !== null ? new Date(restingPlacedAtMs) : null),
          statusUpdatedAt: databaseNow,
        })
        .where(
          and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.userId, order.userId),
            eq(schema.orders.venue, "hyperliquid"),
            eq(schema.orders.status, previousStatus),
            orderStatusTransitionCondition(update.status),
            preserveBrokerOrderIdCondition(update.brokerOrderId),
            order.executedSizeDecimal === null
              ? isNull(schema.orders.executedSizeDecimal)
              : eq(
                  schema.orders.executedSizeDecimal,
                  order.executedSizeDecimal,
                ),
            // The CURSOR is part of the compare-and-set too.
            //
            // Status plus size stopped being sufficient once a cursor advance
            // became meaningful on its own: a cursor-only update leaves both
            // unchanged, so two replicas reconciling the same row both pass and
            // the slower one can write its older cursor over the newer. The next
            // poll then re-counts the fill in between, inflating cumulative
            // exposure, and an inflated figure is the dangerous direction, since
            // it is the ceiling on how much a copied close may reduce.
            order.lastCountedFillId === null ||
              order.lastCountedFillId === undefined
              ? isNull(schema.orders.lastCountedFillId)
              : eq(schema.orders.lastCountedFillId, order.lastCountedFillId),
            ...leaseSnapshotPredicate,
          ),
        )
        .returning();

      if (updatedRows.length !== 1) {
        const authoritative = await tx.query.orders.findFirst({
          where: and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.userId, order.userId),
            eq(schema.orders.venue, "hyperliquid"),
          ),
        });
        logger.warn(LOG_SERVICE, "Hyperliquid execution CAS was not singular", {
          orderId: order.id,
          returnedRows: updatedRows.length,
          authoritativeStatus: authoritative?.status ?? null,
        });
        return null;
      }

      const updatedOrder = updatedRows[0];

      if (
        shouldPublishFill &&
        !isAutoMirroredOrder(updatedOrder)
      ) {
        const eventId = fillEventId(updatedOrder.id, update.executedSize);
        if (!fillDelta || !eventId) {
          throw new Error(
            `Unable to derive fill delta event for order ${updatedOrder.id}`,
          );
        }

        // A social trade joins to orders by brokerOrderId. Persist a terminal,
        // synthetic child so every published checkpoint exposes only its exact
        // delta instead of the parent's cumulative executed size. The parent's
        // cumulative-size CAS makes this insert exactly once under concurrency.
        const fillEventOrderId = randomUUID();
        await tx.insert(schema.orders).values({
          id: fillEventOrderId,
          userId: updatedOrder.userId,
          signalId: updatedOrder.signalId,
          symbol: updatedOrder.symbol,
          assetType: "PERP",
          orderType: updatedOrder.orderType,
          tradeAction: updatedOrder.tradeAction,
          direction: updatedOrder.direction,
          quantity: 0,
          quantityDecimal: fillDelta,
          limitPrice: updatedOrder.limitPrice,
          stopPrice: updatedOrder.stopPrice,
          priceTrigger: updatedOrder.priceTrigger,
          status: "FILLED",
          statusUpdatedAt: databaseNow,
          clientOrderId: eventId,
          brokerOrderId: eventId,
          brokerAccountId: updatedOrder.brokerAccountId,
          brokerCredentialId: updatedOrder.brokerCredentialId,
          syncReason: "hyperliquid-fill-delta-event",
          // The parent's network, not the configured one. Without it these rows
          // are NULL, and the NULL arm of every network predicate means "written
          // before the column existed", so a freshly created child would be
          // admitted on every network and pollute the other chain's exposure
          // reconstruction. Copying it keeps that arm meaning genuinely legacy.
          venueNetwork: updatedOrder.venueNetwork,
          executedPrice: fillDeltaPrice,
          executedSizeDecimal: fillDelta,
          leverage: updatedOrder.leverage,
          marginMode: updatedOrder.marginMode,
          reduceOnly: updatedOrder.reduceOnly,
          initialTakeProfitPx: updatedOrder.initialTakeProfitPx,
          initialStopLossPx: updatedOrder.initialStopLossPx,
          realizedPnl: update.realizedPnl,
          venue: "hyperliquid",
          notes: `Synthetic fill delta for parent ${updatedOrder.id} at cumulative size ${update.executedSize}`,
          copySourceLabel: updatedOrder.copySourceLabel,
          executedAt:
            update.executedAtMs !== null
              ? new Date(update.executedAtMs)
              : updatedOrder.executedAt,
        });

        // social_trades retains a legacy integer quantity. Use a non-zero
        // compatibility value; the joined child order's executedSizeDecimal is the
        // authoritative exact perp quantity for feeds and leaderboards.
        const socialSide = tradeActionSide(updatedOrder.tradeAction);
        if (socialSide) {
          await tx.insert(schema.socialTrades).values({
            userId: updatedOrder.userId,
            symbol: updatedOrder.symbol,
            side: socialSide,
            qty: 1,
            orderType: updatedOrder.orderType.toLowerCase(),
            assetType: "PERP",
            limitPrice: updatedOrder.limitPrice,
            brokerOrderId: eventId,
            orderId: fillEventOrderId,
          });
        }
      }

      return updatedOrder;
    });

    if (!persisted) return true;

    const closeReason = closeReasonForOrderType(
      persisted.orderType,
      persisted.reduceOnly,
    );
    const isNewPartialStopExecution =
      update.status === "PARTIAL" &&
      hasExecutedDelta &&
      fillDelta !== null &&
      persisted.reduceOnly &&
      closeReason === "stop_loss";
    if (!isCompletedFill && !isNewPartialStopExecution) return true;

    const notificationSize = isCompletedFill ? update.executedSize : fillDelta;
    if (notificationSize === null) return true;

    const executedSize = Number.parseFloat(notificationSize);
    const executedPrice =
      update.executedPrice === null
        ? null
        : Number.parseFloat(update.executedPrice);
    try {
      await this.dependencies.notify({
        symbol: persisted.symbol,
        side: persisted.tradeAction,
        quantity: Number.isFinite(executedSize) ? executedSize : 0,
        quantityDecimal: notificationSize,
        status: update.status,
        previousStatus,
        executedPrice:
          executedPrice !== null && Number.isFinite(executedPrice)
            ? executedPrice
            : null,
        orderId: persisted.id,
        // Venue fill time, so a long-wedged row reconciled today is not
        // announced as a fill that just happened. See isStaleFill.
        executedAt: update.executedAtMs,
        assetType: "PERP",
        orderType: persisted.orderType,
        limitPrice: persisted.limitPrice
          ? Number.parseFloat(persisted.limitPrice)
          : null,
        userId: persisted.userId,
        copySourceLabel: persisted.copySourceLabel,
        // direction lets the formatter distinguish a short-entry "Sell" from a
        // long-exit "Sell" — perp orders always store "Buy"/"Sell" in
        // tradeAction (the venue column disambiguates in the DB), so without
        // this a short entry would display as "Sell" instead of "Short".
        direction: (persisted.direction as "long" | "short") ?? undefined,
        reduceOnly: persisted.reduceOnly,
        // An in-app TP/SL leg is a reduce-only trigger row, so the type on the
        // row is enough to say WHY the position ended. Without this a stop
        // firing read exactly like a manual close.
        closeReason,
      });
    } catch (notifyError) {
      logger.error(
        LOG_SERVICE,
        "[hyperliquid-order-sync] completed-fill notify failed",
        {
          orderId: persisted.id,
          ...safeErrorContext(notifyError),
        },
      );
    }

    // A full read that reached this point settled the row, whether or not it
    // changed: retirement may claim it.
    return true;
  }
}
