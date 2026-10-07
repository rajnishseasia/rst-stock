/**
 * Hyperliquid External Fill Poller
 *
 * ============================================================================
 *  ⚠️  REAL ACCOUNTS.  READ-ONLY, INSERT-ONLY.  NEVER PLACES ORDERS.  ⚠️
 * ============================================================================
 *
 * `HyperliquidOrderSyncPoller` is row-driven: it iterates the DB's open perp
 * orders and asks Hyperliquid about each one. A fill with no matching row is
 * therefore not "missed", it is structurally invisible. The case that costs
 * money is exactly that one: a stop-loss attached in Hyperliquid's own UI
 * fires, the position closes, and the app never says a word. The user finds
 * out by opening the venue.
 *
 * This poller is the inverse, and the perp counterpart to the equity-side
 * `ExternalFillPoller`: it LISTs each user's fills, classifies each as either
 * known (already an `orders` row) or external, and for external fills inserts
 * a reconciled row tagged `externalOrigin=true` with a deterministic
 * `hlextfill:<digest>` client order id, so the unique index on
 * `orders_client_order_id_unique` absorbs any restart or re-read overlap.
 *
 * Guarantees:
 *
 *   1. KILL SWITCH — start() does nothing at all unless
 *      HYPERLIQUID_EXTERNAL_FILL_ENABLED is exactly the string "true". No
 *      interval, no DB reads, no venue calls. Ships inert; flip it on after a
 *      testnet run, the same way the Alpaca poller was rolled out.
 *
 *   2. READ-ONLY AT THE VENUE — only the keyless `createHyperliquidInfoClient`
 *      is constructed, exactly as `hyperliquid-order-sync.ts` does. No signing
 *      ExchangeClient is ever built, so this structurally cannot place,
 *      cancel, close, transfer or withdraw.
 *
 *   3. INSERT-ONLY LOCALLY — it inserts into `orders` and updates its own row
 *      in `external_fill_cursors`. It never modifies an existing order row,
 *      which is what keeps it from fighting the row-driven sync over the same
 *      order.
 *
 *   4. NO HISTORY REPLAY — a user's first scan seeds the cursor at
 *      (now - HYPERLIQUID_EXTERNAL_FILL_BACKFILL_MS, default 0) BEFORE reading
 *      anything, so enabling the poller can never ingest an account's whole
 *      trade history as "new" and spray stale alerts.
 *
 *   5. NOTIFY ONCE — the webhook fires only when the insert actually created a
 *      row, so a re-read of the same fill cannot double-ping.
 *
 *   6. WATERMARK HELD ON FAILURE — a user whose read or write fails keeps their
 *      cursor where it was, so the next cycle retries the same window rather
 *      than skipping past it. One user's failure never blocks the others.
 *
 *   7. CLOSE FAN-OUT ONLY. Externally detected opens remain private, but a
 *      closing fill is published atomically with its order row. Followers can
 *      therefore exit exposure the mirror opened without turning an arbitrary
 *      outside entry into new follower exposure.
 *
 *   8. BACKGROUND CAPACITY ONLY. Credentials are rotated through small batches
 *      and their Info traffic uses the background REST allowance. Detection
 *      remains continuous without starving live copy-order preflight or exits.
 *
 *   9. MIRROR PROTECTION IS PRIVATE. A TP/SL fill whose cloid belongs to an
 *      auto-mirrored opening order is recorded with the same provenance, but
 *      it is not published to Discord or inserted into the follower fan-out.
 *
 * Every state decision is made by the pure, unit-tested functions in
 * apps/api/src/lib/hyperliquid-external-fill.ts, which touch neither DB nor
 * network.
 */

import { schema, type WorkerPoolDb } from "@trade-bot/db";
import {
  hyperliquidRestWeightSnapshot,
  hyperliquidReadStatus,
  isTransientHyperliquidReadError,
  networkFromEnv,
  toCloid,
  type HyperliquidOpenOrdersSnapshot,
} from "@trade-bot/hyperliquid";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { createProductionLogger } from "@trade-bot/logger";

// Relative, extensionless imports match the worker's "bundler" moduleResolution
// and the way order-sync.ts / hyperliquid-order-sync.ts already reach API libs.
import { createHyperliquidInfoClient } from "../../../api/src/lib/hyperliquid";
import {
  classifyExternalFill,
  closeReasonForFill,
  externalHlClientOrderId,
  isClosingFill,
  nextWatermarkMs,
  tradeActionForFill,
  type ExternalHlFill,
} from "../../../api/src/lib/hyperliquid-external-fill";
import { sendDiscordNotification } from "./discord-notify";

const logger = createProductionLogger();
const LOG_SERVICE = "hyperliquid-external-fill-sync";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** Trigger wording is optional enrichment, so do not fan it out every minute. */
const TRIGGER_REFRESH_INTERVAL_MS = 15 * 60_000;
/** Smooth optional trigger reads when rotating through many accounts. */
const TRIGGER_REFRESH_GLOBAL_INTERVAL_MS = 60_000;
/** Fills read per user per cycle. HL returns newest-first. */
const FILL_SCAN_LIMIT = 500;
/** Total credentials loaded for the bounded in-memory rotation. */
const MAX_TRACKED_USERS = 500;
/** Small batches avoid one burst consuming the whole rolling REST allowance. */
export const DEFAULT_EXTERNAL_FILL_USERS_PER_CYCLE = 5;
const MAX_EXTERNAL_FILL_USERS_PER_CYCLE = 25;
/** Ingests per user per cycle, so a pathological account cannot flood alerts. */
const MAX_INGESTS_PER_USER = 50;
/** Default: no backfill at all. Enabling the poller starts from now. */
const DEFAULT_FIRST_RUN_BACKFILL_MS = 0;
const MAX_FIRST_RUN_BACKFILL_MS = 24 * 60 * 60 * 1000;

type MirroredProtectionCandidate = {
  copySourceLabel: string | null;
  perpProtection: { legClientOrderIds?: unknown } | null;
};

/**
 * Identify a venue fill produced by a protection leg attached to a mirrored
 * position. Hyperliquid reports the hashed cloid, while the opening order
 * keeps the pre-hash ids needed to cancel only its own legs.
 */
export function mirroredProtectionSourceLabel(
  fillCloid: string | null,
  candidates: readonly MirroredProtectionCandidate[],
): string | null {
  const normalizedFillCloid = fillCloid?.trim().toLowerCase();
  if (!normalizedFillCloid) return null;

  for (const candidate of candidates) {
    const sourceLabel = candidate.copySourceLabel?.trim();
    const legIds = candidate.perpProtection?.legClientOrderIds;
    if (!sourceLabel || !Array.isArray(legIds)) continue;
    for (const legId of legIds) {
      if (typeof legId !== "string" || !legId.trim()) continue;
      if (toCloid(legId).toLowerCase() === normalizedFillCloid) {
        return sourceLabel;
      }
    }
  }
  return null;
}

type TriggerOrder = {
  oid: number;
  tpsl: "tp" | "sl" | null;
  isTrigger: boolean;
};

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
  failures: HyperliquidOpenOrdersSnapshot<TriggerOrder>["failures"] = [],
): void {
  const context = {
    failedSources: failures.map(({ source, status }) => ({
      source,
      ...(status !== undefined ? { status } : {}),
    })),
  };
  if (failures.every((failure) => failure.transient)) {
    logger.warn(
      LOG_SERVICE,
      "[hyperliquid-external-fill] trigger coverage incomplete",
      context,
    );
  } else {
    logger.error(
      LOG_SERVICE,
      "[hyperliquid-external-fill] trigger coverage incomplete",
      context,
    );
  }
}

function isEnabled(): boolean {
  return process.env.HYPERLIQUID_EXTERNAL_FILL_ENABLED === "true";
}

/** Resolve the bounded account batch size used by the background fill scan. */
export function resolveExternalFillUsersPerCycle(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number.parseInt(env.HYPERLIQUID_EXTERNAL_FILL_USERS_PER_CYCLE ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_EXTERNAL_FILL_USERS_PER_CYCLE;
  return Math.min(raw, MAX_EXTERNAL_FILL_USERS_PER_CYCLE);
}

/** Take one non-wrapping slice so every credential gets a turn without a burst. */
export function rotatingCredentialBatch<T>(
  rows: readonly T[],
  offset: number,
  batchSize: number,
): { batch: T[]; nextOffset: number } {
  if (rows.length === 0) return { batch: [], nextOffset: 0 };
  const start = Number.isSafeInteger(offset) && offset >= 0 && offset < rows.length
    ? offset
    : 0;
  const size = Math.max(1, Math.floor(batchSize));
  const batch = rows.slice(start, start + size);
  const end = start + batch.length;
  return { batch, nextOffset: end >= rows.length ? 0 : end };
}

/** A 0x-prefixed 20-byte address, or null when the stored value is not one. */
function asAddress(value: string | null | undefined): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as `0x${string}`)
    : null;
}

export interface HyperliquidExternalFillDependencies {
  createInfoClient: typeof createHyperliquidInfoClient;
  notify: typeof sendDiscordNotification;
  now: () => Date;
}

const defaultDependencies: HyperliquidExternalFillDependencies = {
  createInfoClient: createHyperliquidInfoClient,
  notify: sendDiscordNotification,
  now: () => new Date(),
};

export class HyperliquidExternalFillPoller {
  private readonly db: WorkerPoolDb;
  private readonly deps: HyperliquidExternalFillDependencies;
  private readonly pollIntervalMs: number;
  private readonly firstRunBackfillMs: number;
  private readonly usersPerCycle: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private inFlightPoll = false;
  private triggerRefreshesRemaining = 0;
  private credentialOffset = 0;
  private lastAnyTriggerRefreshAt = 0;

  /**
   * Resting trigger orders seen on an EARLIER cycle, per wallet.
   *
   * Hyperliquid's fill rows carry no order type, so a stop is only recognizable
   * by having seen the order resting before it fired. In memory on purpose: it
   * is a cache, not a record. A restart loses it and the affected fill is
   * reported as a venue close with no stated reason, which is the honest
   * degradation. Persisting it would be a schema change to improve the wording
   * of an alert that already fires.
   */
  private readonly triggerKinds = new Map<string, Map<number, "tp" | "sl">>();
  private readonly lastTriggerRefreshAt = new Map<string, number>();

  constructor(
    db: WorkerPoolDb,
    dependencies: Partial<HyperliquidExternalFillDependencies> = {},
  ) {
    this.db = db;
    this.deps = { ...defaultDependencies, ...dependencies };
    const envInterval = Number.parseInt(
      process.env.HYPERLIQUID_EXTERNAL_FILL_POLL_MS ?? "",
      10,
    );
    this.pollIntervalMs =
      Number.isFinite(envInterval) && envInterval > 0
        ? envInterval
        : DEFAULT_POLL_INTERVAL_MS;
    const envBackfill = Number.parseInt(
      process.env.HYPERLIQUID_EXTERNAL_FILL_BACKFILL_MS ?? "",
      10,
    );
    this.firstRunBackfillMs =
      Number.isFinite(envBackfill) && envBackfill >= 0
        ? Math.min(envBackfill, MAX_FIRST_RUN_BACKFILL_MS)
        : DEFAULT_FIRST_RUN_BACKFILL_MS;
    this.usersPerCycle = resolveExternalFillUsersPerCycle();
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    // ⚠️ Kill switch — see file header. Ships INERT.
    if (!isEnabled()) {
      logger.info(
        LOG_SERVICE,
        "[hyperliquid-external-fill] Disabled (HYPERLIQUID_EXTERNAL_FILL_ENABLED != 'true'). No interval scheduled.",
      );
      return;
    }
    this.isRunning = true;
    logger.info(
      LOG_SERVICE,
      `[hyperliquid-external-fill] Starting external perp fill polling every ${this.pollIntervalMs}ms.`,
    );
    void this.pollOnce();
    this.intervalId = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    logger.info(LOG_SERVICE, "[hyperliquid-external-fill] stopped");
  }

  /** One scan pass across every Hyperliquid credential. Exposed for tests. */
  public async pollOnce(): Promise<void> {
    if (this.inFlightPoll) return; // single-flight
    this.inFlightPoll = true;
    const pollStartedAt = Date.now();
    let trackedAccountCount = 0;
    let scannedAccountCount = 0;
    // One full trigger snapshot is enough background enrichment for a cycle.
    // This naturally rotates through credentials after a restart instead of
    // bursting every account across every HIP-3 DEX at once.
    this.triggerRefreshesRemaining =
      this.deps.now().getTime() - this.lastAnyTriggerRefreshAt >=
          TRIGGER_REFRESH_GLOBAL_INTERVAL_MS
        ? 1
        : 0;
    try {
      const credentials = await this.db.query.userApiCredentials.findMany({
        where: eq(schema.userApiCredentials.provider, "hyperliquid"),
        orderBy: [asc(schema.userApiCredentials.id)],
        limit: MAX_TRACKED_USERS,
      });
      trackedAccountCount = credentials.length;
      const rotation = rotatingCredentialBatch(
        credentials,
        this.credentialOffset,
        this.usersPerCycle,
      );
      this.credentialOffset = rotation.nextOffset;
      scannedAccountCount = rotation.batch.length;

      // Start every fill read in the batch together. The shared background
      // limiter still enforces the same REST ceiling, but an optional multi-DEX
      // trigger snapshot from one account can no longer sit ahead of the other
      // accounts' correctness-critical fill reads in this batch.
      await Promise.all(
        rotation.batch.map(async (credential) => {
          try {
            await this.processCredential(credential);
          } catch (error) {
            // One account's failure must not stop the others, and its watermark
            // is untouched, so the next cycle retries the same window.
            logReadFailure(
              "[hyperliquid-external-fill] credential failed",
              error,
            );
          }
        }),
      );
    } catch (error) {
      logger.error(
        LOG_SERVICE,
        "[hyperliquid-external-fill] poll cycle error",
        {
          ...safeErrorContext(error),
        },
      );
    } finally {
      logger.info(
        LOG_SERVICE,
        "[hyperliquid-external-fill] REST weight snapshot",
        {
          ...hyperliquidRestWeightSnapshot("background"),
          trackedAccountCount,
          scannedAccountCount,
          nextAccountOffset: this.credentialOffset,
          pollDurationMs: Date.now() - pollStartedAt,
        },
      );
      this.inFlightPoll = false;
    }
  }

  private async processCredential(
    credential: typeof schema.userApiCredentials.$inferSelect,
  ): Promise<void> {
    // The master address lives in accountId (or username on older rows), the
    // same pair `hyperliquid-order-sync.ts` reads. The info client is keyless,
    // so nothing is decrypted here at all.
    const address =
      asAddress(credential.accountId) ?? asAddress(credential.username);
    if (!address) return;

    const cursorRow = await this.db.query.externalFillCursors.findFirst({
      where: eq(schema.externalFillCursors.credentialId, credential.id),
    });

    let watermark = cursorRow?.watermark ?? null;
    if (!watermark) {
      // FIRST RUN. Seed BEFORE reading anything: with no lower bound every
      // historical fill on the account reads as new, and enabling the poller
      // would spray an account's whole trade history at the user as alerts.
      // Persisting first also means a crash mid-cycle resumes here rather than
      // falling back to a full-history scan.
      watermark = new Date(this.deps.now().getTime() - this.firstRunBackfillMs);
      await this.db
        .insert(schema.externalFillCursors)
        .values({ credentialId: credential.id, watermark })
        .onConflictDoNothing();
      logger.info(
        LOG_SERVICE,
        "[hyperliquid-external-fill] seeded first-run cursor",
        {
          credentialId: credential.id,
          watermark: watermark.toISOString(),
        },
      );
    }

    const network = networkFromEnv();
    const info = this.deps.createInfoClient({
      network,
      trafficClass: "background",
    });

    // Fills are correctness-critical and go first. Trigger wording is optional
    // enrichment and must never hold fill ingestion behind a multi-DEX fan-out.
    const fills = (await info.listFills(
      address,
      FILL_SCAN_LIMIT,
    )) as ExternalHlFill[];

    const lastTriggerRefresh = this.lastTriggerRefreshAt.get(address) ?? 0;
    if (
      this.triggerRefreshesRemaining > 0 &&
      this.deps.now().getTime() - lastTriggerRefresh >=
        TRIGGER_REFRESH_INTERVAL_MS
    ) {
      // Record the attempt before starting it. A rate-limited optional snapshot
      // must not be retried by every one-minute fill cycle.
      this.lastTriggerRefreshAt.set(address, this.deps.now().getTime());
      this.lastAnyTriggerRefreshAt = this.deps.now().getTime();
      this.triggerRefreshesRemaining--;
      await this.refreshTriggerKinds(info, address);
    }
    if (fills.length === 0) return;

    const watermarkMs = watermark.getTime();
    const candidates = fills.filter(
      (fill) => Number.isFinite(fill.time) && fill.time > watermarkMs,
    );
    if (candidates.length === 0) return;

    // One query for every candidate rather than one per fill. Match both the
    // venue oid and our cloid: the app row exists before placement, while its
    // broker oid may not be written until the row-driven sync sees the fill.
    const { knownOids, knownCloids } = await this.knownFillAttribution(
      credential.userId,
      candidates.map((fill) => fill.oid),
      network,
    );

    // Oldest first, so the watermark advances monotonically as we go and a
    // crash part-way leaves a cursor that resumes rather than skips.
    const ordered = [...candidates].sort(
      (a, b) => a.time - b.time || a.oid - b.oid,
    );

    const processed: ExternalHlFill[] = [];
    let ingested = 0;
    let capped = false;
    for (const fill of ordered) {
      if (ingested >= MAX_INGESTS_PER_USER) {
        capped = true;
        logger.warn(
          LOG_SERVICE,
          "[hyperliquid-external-fill] per-cycle ingest cap reached",
          {
            credentialId: credential.id,
            cap: MAX_INGESTS_PER_USER,
            // Named explicitly: the cursor stops here, so the remainder is
            // deferred to the next cycle, not dropped.
            deferred: ordered.length - processed.length,
          },
        );
        break;
      }

      const decision = classifyExternalFill({
        fill,
        knownOids,
        knownCloids,
        watermarkMs,
      });
      if (!decision.ingest) {
        // A fill we deliberately skip is still processed: it must not be
        // reconsidered next cycle.
        processed.push(fill);
        continue;
      }

      const created = await this.ingest({ fill, credential, address, network });
      processed.push(fill);
      if (created) ingested++;
    }

    const advanced = nextWatermarkMs(processed, watermarkMs);
    // If the cap split a timestamp bucket, replay that bucket next cycle.
    // Deterministic client order ids make already-inserted fills idempotent.
    const firstDeferred = capped ? ordered[processed.length] : undefined;
    const nextWatermark = firstDeferred?.time === advanced
      ? Math.max(watermarkMs, advanced - 1)
      : advanced;
    if (nextWatermark > watermarkMs) {
      await this.db
        .update(schema.externalFillCursors)
        .set({ watermark: new Date(nextWatermark) })
        .where(eq(schema.externalFillCursors.credentialId, credential.id));
    }
  }

  /** Venue identifiers among candidate fills that belong to an app order. */
  private async knownFillAttribution(
    userId: string,
    oids: number[],
    network: string,
  ): Promise<{ knownOids: Set<number>; knownCloids: Set<string> }> {
    if (oids.length === 0) {
      return { knownOids: new Set(), knownCloids: new Set() };
    }
    const rows = await this.db.query.orders.findMany({
      where: and(
        eq(schema.orders.userId, userId),
        eq(schema.orders.venue, "hyperliquid"),
        or(
          inArray(
            schema.orders.brokerOrderId,
            [...new Set(oids)].map((oid) => String(oid)),
          ),
          and(
            inArray(schema.orders.status, [
              "PENDING",
              "SYNCING",
              "SUBMITTED",
              "PARTIAL",
            ]),
            isNotNull(schema.orders.clientOrderId),
            or(
              isNull(schema.orders.venueNetwork),
              eq(schema.orders.venueNetwork, network),
            ),
          ),
        ),
      ),
      columns: { brokerOrderId: true, clientOrderId: true },
    });
    const knownOids = new Set(
      rows
        .flatMap((row) =>
          row.brokerOrderId === null ? [] : [Number(row.brokerOrderId)],
        )
        .filter((oid) => Number.isFinite(oid)),
    );
    const knownCloids = new Set(
      rows.flatMap((row) =>
        row.clientOrderId
          ? [toCloid(row.clientOrderId).toLowerCase()]
          : [],
      ),
    );
    return { knownOids, knownCloids };
  }

  /**
   * Cache which resting orders are stops and which are take-profits.
   *
   * Best-effort: a failure here costs the WORDING of an alert, never the alert
   * itself, so it must not abort the fill scan.
   */
  private async refreshTriggerKinds(
    info: {
      listOpenOrders: (address: `0x${string}`) => Promise<unknown[]>;
      listOpenOrdersWithStatus?: (
        address: `0x${string}`,
      ) => Promise<HyperliquidOpenOrdersSnapshot<TriggerOrder>>;
    },
    address: `0x${string}`,
  ): Promise<void> {
    try {
      const snapshot = info.listOpenOrdersWithStatus
        ? await info.listOpenOrdersWithStatus(address)
        : ({
            orders: (await info.listOpenOrders(address)) as TriggerOrder[],
            complete: true,
            coveredDexes: [""],
            failures: [],
          } satisfies HyperliquidOpenOrdersSnapshot<TriggerOrder>);
      const orders = snapshot.orders;
      const known =
        this.triggerKinds.get(address) ?? new Map<number, "tp" | "sl">();
      for (const order of orders) {
        if (order.isTrigger && (order.tpsl === "sl" || order.tpsl === "tp")) {
          known.set(order.oid, order.tpsl);
        }
      }
      this.triggerKinds.set(address, known);
      if (!snapshot.complete) logOpenOrdersCoverage(snapshot.failures ?? []);
    } catch (error) {
      logReadFailure(
        "[hyperliquid-external-fill] trigger snapshot failed",
        error,
      );
    }
  }

  /**
   * Insert one external fill and alert on it.
   *
   * Returns whether a row was actually created. The webhook is gated on that,
   * so a re-read that the unique index absorbs cannot produce a second ping.
   */
  private async ingest({
    fill,
    credential,
    address,
    network,
  }: {
    fill: ExternalHlFill;
    credential: typeof schema.userApiCredentials.$inferSelect;
    address: `0x${string}`;
    network: string;
  }): Promise<boolean> {
    const { tradeAction, direction } = tradeActionForFill(fill);
    const clientOrderId = externalHlClientOrderId(fill);

    const closing = isClosingFill(fill.dir);
    const mirrorSourceLabel = closing
      ? await this.mirroredProtectionSource(fill, credential)
      : null;
    const inserted = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(schema.orders).values({
        userId: credential.userId,
        symbol: fill.coin,
        assetType: "PERP",
        // The venue does not tell us what type the order was; Market is the
        // truthful default for an execution we only ever see as a fill.
        orderType: "Market",
        tradeAction,
        direction,
        // The legacy integer column cannot hold a fractional perp size; the
        // decimal columns are authoritative, exactly as elsewhere on this path.
        quantity: 0,
        quantityDecimal: fill.sz,
        status: "FILLED",
        statusUpdatedAt: new Date(),
        clientOrderId,
        brokerOrderId: String(fill.oid),
        brokerAccountId: address,
        brokerCredentialId: credential.id,
        venue: "hyperliquid",
        venueNetwork: network,
        externalOrigin: true,
        // Preserve the opening order's provenance. The Discord notifier also
        // suppresses copied rows, but this durable marker prevents any later
        // reader from presenting the protection fill as an independent trade.
        copySourceLabel: mirrorSourceLabel,
        reduceOnly: closing,
        executedPrice: fill.px,
        executedSizeDecimal: fill.sz,
        realizedPnl: fill.closedPnl,
        executedAt: new Date(fill.time),
        syncReason: "hyperliquid-external-fill",
        notes: `Detected at Hyperliquid (${fill.dir}); not placed through this app.`,
      }).onConflictDoNothing().returning({ id: schema.orders.id });
      const created = rows[0];
      if (!created || !closing || mirrorSourceLabel) return rows;

      // `social_trades.qty` is legacy integer compatibility only. Candidate
      // discovery reads the exact decimal size from the joined order.
      await tx.insert(schema.socialTrades).values({
        userId: credential.userId,
        symbol: fill.coin,
        side: tradeAction === "Buy" ? "buy" : "sell",
        qty: 1,
        orderType: "market",
        assetType: "PERP",
        brokerOrderId: String(fill.oid),
        orderId: created.id,
      });
      return rows;
    });

    const created = inserted[0];
    if (!created) return false;

    if (mirrorSourceLabel) {
      logger.info(
        LOG_SERVICE,
        "[hyperliquid-external-fill] suppressed mirrored protection fill from social publication",
        { orderId: created.id, symbol: fill.coin },
      );
      return true;
    }

    const closeReason = closeReasonForFill({
      fill,
      triggerKinds: this.triggerKinds.get(address) ?? new Map(),
    });

    try {
      await this.deps.notify({
        symbol: fill.coin,
        side: tradeAction,
        quantity: 0,
        quantityDecimal: fill.sz,
        status: "FILLED",
        previousStatus: "PENDING",
        // The venue's own fill time, not ingest time (see isStaleFill).
        executedAt: fill.time,
        executedPrice: Number.parseFloat(fill.px),
        orderId: created.id,
        assetType: "PERP",
        orderType: "Market",
        limitPrice: null,
        userId: credential.userId,
        reduceOnly: isClosingFill(fill.dir),
        closeReason,
        externalOrigin: true,
      });
    } catch (error) {
      // The row is already durable; a webhook failure must not roll it back or
      // it will be re-ingested and re-alerted forever.
      logger.error(LOG_SERVICE, "[hyperliquid-external-fill] notify failed", {
        orderId: created.id,
        ...safeErrorContext(error),
      });
    }
    return true;
  }

  /** Find the mirrored opening order that owns this exact TP/SL cloid. */
  private async mirroredProtectionSource(
    fill: ExternalHlFill,
    credential: typeof schema.userApiCredentials.$inferSelect,
  ): Promise<string | null> {
    if (!fill.cloid) return null;
    const candidates = await this.db.query.orders.findMany({
      where: and(
        eq(schema.orders.userId, credential.userId),
        eq(schema.orders.symbol, fill.coin),
        eq(schema.orders.assetType, "PERP"),
        eq(schema.orders.venue, "hyperliquid"),
        eq(schema.orders.brokerCredentialId, credential.id),
        isNotNull(schema.orders.copySourceLabel),
        isNotNull(schema.orders.perpProtection),
        lte(schema.orders.createdAt, new Date(fill.time)),
      ),
      columns: { copySourceLabel: true, perpProtection: true },
      orderBy: [desc(schema.orders.createdAt)],
      limit: 100,
    });
    return mirroredProtectionSourceLabel(fill.cloid, candidates);
  }
}
