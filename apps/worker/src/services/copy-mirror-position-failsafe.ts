/**
 * Periodic last-line reconciliation for Hyperliquid copy-mirror exposure.
 *
 * The ordinary mirror path reacts to source fills. This poller instead compares
 * current venue positions, so it can recover when the worker was offline for
 * the entire lifetime of a source close. It never signs an order itself. Once
 * a source-flat venue snapshot is observed, it immediately stages a reduce-only
 * candidate in the existing durable mirror inbox.
 */
import { createHash } from "node:crypto";

import { schema, type WorkerPoolDb } from "@trade-bot/db";
import {
  networkFromEnv,
  type HyperliquidNetwork,
  type PerpPosition,
  type PerpSide,
} from "@trade-bot/hyperliquid";
import { createProductionLogger } from "@trade-bot/logger";
import { eq, sql } from "drizzle-orm";

import { createHyperliquidInfoClient } from "../../../api/src/lib/hyperliquid";
import { signedPerpExposure } from "./copy-mirror-perp-decimal";
import type { MirrorSourceCandidate } from "./copy-mirror";

const logger = createProductionLogger();
const LOG_SERVICE = "copy-mirror-failsafe";
const DEFAULT_INTERVAL_MS = 3 * 60_000;
const SCAN_LIMIT = 5_000;

export interface FailsafeHistoryRow {
  followerUserId: string;
  followerWallet: string;
  credentialId: string | null;
  venueNetwork: string;
  coin: string;
  direction: PerpSide;
  reduceOnly: boolean;
  executedSizeDecimal: string;
  clientOrderId: string;
  candidate: MirrorSourceCandidate;
}

export interface FailsafeExposure {
  exposureKey: string;
  followerUserId: string;
  followerWallet: `0x${string}`;
  sourceWallet: `0x${string}`;
  credentialId: string | null;
  followId?: string;
  venueNetwork: HyperliquidNetwork;
  coin: string;
  side: PerpSide;
  size: string;
  openingClientOrderIds: string[];
  copySourceLabel?: string;
  sourceOrderId?: string;
}

/** Build a complete close intent that can be sized by the shared perp executor. */
export function buildFailsafeCloseCandidate(
  exposure: FailsafeExposure,
  sourceEventAt: string,
): MirrorSourceCandidate {
  // Followers of the same source order share one source item id, allowing the
  // ordinary delivery summary to report one collective mirror count. Fall back
  // to the follower-specific exposure key when historical attribution lacks a
  // source order id, since merging unrelated closes would be unsafe.
  const recoveryGroupKey = exposure.sourceOrderId
    ? exposureHash([
        exposure.sourceWallet,
        exposure.venueNetwork,
        exposure.coin,
        exposure.side,
        exposure.sourceOrderId,
      ])
    : exposure.exposureKey;
  return {
    followerUserId: exposure.followerUserId,
    followId: exposure.followId,
    credentialId: exposure.credentialId,
    // v2 retries recoveries consumed by the original incomplete no-qty payload.
    sourceItemId: `failsafe:v3:${recoveryGroupKey}`,
    sourceEventAt,
    symbol: exposure.coin,
    side: exposure.side === "long" ? "sell" : "buy",
    sizingMode: "usd",
    sizingValue: 1,
    assetType: "PERP",
    perpSide: exposure.side === "long" ? "short" : "long",
    perpLeverage: 1,
    perpMarginMode: "cross",
    perpReduceOnly: true,
    sourceVenueNetwork: exposure.venueNetwork,
    copySourceLabel: exposure.copySourceLabel,
    sourceQtyDecimal: exposure.size,
    sourcePositionSizeDecimal: exposure.size,
    mirroredExposureSizeDecimal: exposure.size,
    mirroredExposureClientOrderIds: exposure.openingClientOrderIds,
    sourceOrderId: exposure.sourceOrderId,
  };
}

function address(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as `0x${string}`)
    : null;
}

function exposureHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** Net history into independently attributable live mirrored positions. */
export function deriveFailsafeExposures(
  rows: readonly FailsafeHistoryRow[],
  sourceWalletByOrderId: ReadonlyMap<string, string>,
): FailsafeExposure[] {
  const groups = new Map<string, FailsafeHistoryRow[]>();
  const groupByOpeningClientOrderId = new Map<string, string>();
  for (const row of rows) {
    if (row.reduceOnly) continue;
    const candidate = row.candidate;
    const sourceWallet = address(
      candidate.sourceOrderId
        ? sourceWalletByOrderId.get(candidate.sourceOrderId)
        : candidate.copySourceLabel,
    );
    const followerWallet = address(row.followerWallet);
    if (!sourceWallet || !followerWallet) continue;
    if (row.venueNetwork !== "mainnet" && row.venueNetwork !== "testnet")
      continue;
    const sourceIdentity = candidate.sourceOrderId ?? candidate.sourceItemId;
    const key = [
      row.followerUserId,
      followerWallet,
      sourceIdentity,
      sourceWallet,
      row.venueNetwork,
      row.coin,
    ].join("\0");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    groupByOpeningClientOrderId.set(row.clientOrderId, key);
  }
  // A copied close carries the exact opening client-order IDs it was allowed to
  // reduce. Apply it only to those exposure generations. Legacy closes without
  // that proof are ignored here, which can cause a later audit warning but can
  // never authorize selling a newer mirrored position.
  for (const row of rows) {
    if (!row.reduceOnly) continue;
    const targetKeys = new Set(
      (row.candidate.mirroredExposureClientOrderIds ?? [])
        .map((id) => groupByOpeningClientOrderId.get(id))
        .filter((key): key is string => Boolean(key)),
    );
    for (const key of targetKeys) groups.get(key)?.push(row);
  }

  const exposures: FailsafeExposure[] = [];
  for (const group of groups.values()) {
    const net = signedPerpExposure(
      group.map((row) => ({
        direction: row.direction,
        executedSizeDecimal: row.executedSizeDecimal,
      })),
    );
    if (!net) continue;
    const opens = group
      .filter((row) => !row.reduceOnly && row.direction === net.side)
      .map((row) => row.clientOrderId)
      .sort();
    if (opens.length === 0) continue;
    const first = group[0]!;
    const sourceWallet = address(
      first.candidate.sourceOrderId
        ? sourceWalletByOrderId.get(first.candidate.sourceOrderId)
        : first.candidate.copySourceLabel,
    )!;
    const followerWallet = address(first.followerWallet)!;
    const identity = [
      first.followerUserId,
      followerWallet,
      sourceWallet,
      first.venueNetwork,
      first.coin,
      net.side,
      ...opens,
    ];
    exposures.push({
      exposureKey: exposureHash(identity),
      followerUserId: first.followerUserId,
      followerWallet,
      sourceWallet,
      credentialId: first.credentialId,
      followId: first.candidate.followId,
      venueNetwork: first.venueNetwork as HyperliquidNetwork,
      coin: first.coin,
      side: net.side,
      size: net.size,
      openingClientOrderIds: opens,
      copySourceLabel: first.candidate.copySourceLabel,
      sourceOrderId: first.candidate.sourceOrderId,
    });
  }
  return exposures;
}

export function matchingPosition(
  positions: readonly PerpPosition[],
  coin: string,
  side: PerpSide,
): PerpPosition | null {
  return (
    positions.find(
      (position) => position.coin === coin && position.side === side,
    ) ?? null
  );
}

export class CopyMirrorPositionFailsafe {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly db: WorkerPoolDb,
    private readonly stageCandidates: (
      candidates: MirrorSourceCandidate[],
    ) => Promise<void>,
  ) {}

  start(): void {
    if (process.env.COPY_MIRROR_POSITION_FAILSAFE_ENABLED !== "true") {
      logger.info(LOG_SERVICE, "disabled by env gate");
      return;
    }
    const interval = Number.parseInt(
      process.env.COPY_MIRROR_POSITION_FAILSAFE_INTERVAL_MS ?? "",
      10,
    );
    const intervalMs =
      Number.isFinite(interval) && interval >= 60_000
        ? interval
        : DEFAULT_INTERVAL_MS;
    logger.warn(LOG_SERVICE, "starting mirrored-position reconciliation", {
      intervalMs,
      dryRun: process.env.COPY_MIRROR_POSITION_FAILSAFE_EXECUTE !== "true",
    });
    void this.pollOnce();
    this.intervalId = setInterval(() => void this.pollOnce(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async pollOnce(): Promise<FailsafeExposure[]> {
    if (this.inFlight) return [];
    this.inFlight = true;
    try {
      return await this.runCycle();
    } catch (error) {
      logger.error(LOG_SERVICE, "reconciliation cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      this.inFlight = false;
    }
  }

  private async loadExposureHistory(): Promise<FailsafeHistoryRow[]> {
    const result = await this.db.execute(sql`
      SELECT
        o.user_id AS "followerUserId",
        o.broker_account_id AS "followerWallet",
        o.broker_credential_id AS "credentialId",
        o.venue_network AS "venueNetwork",
        o.symbol AS coin,
        o.direction,
        o.reduce_only AS "reduceOnly",
        o.executed_size_decimal AS "executedSizeDecimal",
        o.client_order_id AS "clientOrderId",
        d.candidate
      FROM orders o
      JOIN copy_mirror_deliveries d
        ON o.user_id = d.follower_user_id
       AND o.client_order_id = 'copymirror:' || d.follower_user_id || ':' || d.source_item_id
      WHERE o.venue = 'hyperliquid'
        AND o.asset_type = 'PERP'
        AND o.executed_size_decimal IS NOT NULL
        AND o.executed_size_decimal::numeric > 0
        AND o.client_order_id LIKE 'copymirror:%'
      ORDER BY o.created_at ASC
      LIMIT ${SCAN_LIMIT + 1}
    `);
    const queryResult = result as unknown as {
      rows?: FailsafeHistoryRow[];
      [Symbol.iterator]?: () => Iterator<FailsafeHistoryRow>;
    };
    const rows = Array.isArray(queryResult.rows)
      ? queryResult.rows
      : Array.from(queryResult as Iterable<FailsafeHistoryRow>);
    if (rows.length > SCAN_LIMIT)
      throw new Error("mirror history scan saturated");
    return rows;
  }

  private async runCycle(): Promise<FailsafeExposure[]> {
    const rogue = await this.auditOnce();
    const rogueKeys = new Set(rogue.map((exposure) => exposure.exposureKey));
    const priorChecks = await this.db.query.copyMirrorFailsafeChecks.findMany({
      columns: { exposureKey: true, status: true },
    });
    for (const check of priorChecks) {
      if (
        check.status !== "close_staged" &&
        !rogueKeys.has(check.exposureKey)
      ) {
        await this.db
          .delete(schema.copyMirrorFailsafeChecks)
          .where(
            eq(schema.copyMirrorFailsafeChecks.exposureKey, check.exposureKey),
          );
      }
    }
    for (const exposure of rogue) {
      await this.recordObservation(exposure);
    }
    return rogue;
  }

  /** Read-only production audit entry point. It performs no inserts or orders. */
  async auditExposureCandidates(): Promise<FailsafeExposure[]> {
    if (networkFromEnv() !== "mainnet" && networkFromEnv() !== "testnet")
      return [];
    const rows = await this.loadExposureHistory();
    const sourceOrderIds = [
      ...new Set(rows.flatMap((row) => row.candidate.sourceOrderId ?? [])),
    ];
    const sourceWalletByOrderId = new Map<string, string>();
    for (const id of sourceOrderIds) {
      const order = await this.db.query.orders.findFirst({
        where: eq(schema.orders.id, id),
        columns: { brokerAccountId: true },
      });
      if (order?.brokerAccountId)
        sourceWalletByOrderId.set(id, order.brokerAccountId);
    }
    return deriveFailsafeExposures(rows, sourceWalletByOrderId).filter(
      (exposure) => exposure.venueNetwork === networkFromEnv(),
    );
  }

  /** Read-only production audit entry point. It performs no inserts or orders. */
  async auditOnce(): Promise<FailsafeExposure[]> {
    const exposures = await this.auditExposureCandidates();
    if (exposures.length === 0) return [];

    const info = createHyperliquidInfoClient({ network: networkFromEnv() });
    const wallets = [
      ...new Set(
        exposures.flatMap((item) => [item.sourceWallet, item.followerWallet]),
      ),
    ];
    const positionsByWallet = new Map<string, PerpPosition[]>();
    for (const wallet of wallets) {
      positionsByWallet.set(wallet, await info.listPositions(wallet));
    }

    const rogue: FailsafeExposure[] = [];
    const lifecycleCache = new Map<string, boolean>();
    for (const exposure of exposures) {
      const lifecycleKey = exposure.sourceOrderId ?? exposure.exposureKey;
      let sourceLifecycleClosed = lifecycleCache.get(lifecycleKey);
      if (sourceLifecycleClosed === undefined) {
        sourceLifecycleClosed = await this.sourceLifecycleClosed(exposure);
        lifecycleCache.set(lifecycleKey, sourceLifecycleClosed);
      }
      const sourcePosition = matchingPosition(
        positionsByWallet.get(exposure.sourceWallet) ?? [],
        exposure.coin,
        exposure.side,
      );
      const followerPosition = matchingPosition(
        positionsByWallet.get(exposure.followerWallet) ?? [],
        exposure.coin,
        exposure.side,
      );
      if (process.env.COPY_MIRROR_FAILSAFE_AUDIT_DETAIL === "true") {
        logger.info(LOG_SERVICE, "read-only exposure audit", {
          followerUserId: exposure.followerUserId,
          followerWallet: `${exposure.followerWallet.slice(0, 8)}...${exposure.followerWallet.slice(-4)}`,
          coin: exposure.coin,
          side: exposure.side,
          attributedSize: exposure.size,
          sourceStillOpen: Boolean(sourcePosition),
          sourceLiveSize: sourcePosition?.size ?? null,
          sourceLifecycleClosed,
          followerStillOpen: Boolean(followerPosition),
          followerLiveSize: followerPosition?.size ?? null,
        });
      }
      if ((!sourceLifecycleClosed && sourcePosition) || !followerPosition) {
        continue;
      }
      rogue.push(exposure);
    }
    return rogue;
  }

  /** Check whether reduce-only source fills consumed the particular copied lot. */
  private async sourceLifecycleClosed(
    exposure: FailsafeExposure,
  ): Promise<boolean> {
    if (!exposure.sourceOrderId) return false;
    const opening = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, exposure.sourceOrderId),
      columns: {
        userId: true,
        brokerAccountId: true,
        createdAt: true,
        executedSizeDecimal: true,
      },
    });
    if (!opening?.executedSizeDecimal || !opening.brokerAccountId) return false;
    const result = await this.db.execute(sql`
      SELECT executed_size_decimal AS size
      FROM orders
      WHERE user_id = ${opening.userId}
        AND venue = 'hyperliquid'
        AND asset_type = 'PERP'
        AND symbol = ${exposure.coin}
        AND venue_network = ${exposure.venueNetwork}
        AND lower(broker_account_id) = ${opening.brokerAccountId.toLowerCase()}
        AND reduce_only = true
        AND created_at >= ${opening.createdAt}
        AND executed_size_decimal IS NOT NULL
        AND executed_size_decimal::numeric > 0
        AND client_order_id NOT LIKE 'hyperliquid-fill-delta:%'
    `);
    const closes =
      (result as unknown as { rows?: Array<{ size: string }> }).rows ?? [];
    const scale = (value: string): bigint | null => {
      if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
      const [whole, fraction = ""] = value.split(".");
      return BigInt(`${whole}${fraction.padEnd(12, "0").slice(0, 12)}`);
    };
    const opened = scale(opening.executedSizeDecimal);
    if (opened === null) return false;
    let closed = 0n;
    for (const row of closes) {
      const size = scale(row.size);
      if (size === null) return false;
      closed += size;
    }
    return closed >= opened;
  }

  private async recordObservation(exposure: FailsafeExposure): Promise<void> {
    const now = new Date();
    const prior = await this.db.query.copyMirrorFailsafeChecks.findFirst({
      where: (table, { eq: equals }) =>
        equals(table.exposureKey, exposure.exposureKey),
    });
    const observations = prior ? prior.flatObservations + 1 : 1;
    const candidate = buildFailsafeCloseCandidate(exposure, now.toISOString());
    const closeSourceItemId = candidate.sourceItemId;
    await this.db
      .insert(schema.copyMirrorFailsafeChecks)
      .values({
        exposureKey: exposure.exposureKey,
        followerUserId: exposure.followerUserId,
        sourceWallet: exposure.sourceWallet,
        followerWallet: exposure.followerWallet,
        venueNetwork: exposure.venueNetwork,
        coin: exposure.coin,
        side: exposure.side,
        exposureSizeDecimal: exposure.size,
        openingClientOrderIds: exposure.openingClientOrderIds,
        flatObservations: observations,
        firstFlatObservedAt: prior?.firstFlatObservedAt ?? now,
        lastCheckedAt: now,
        closeSourceItemId,
        status: "confirmed_flat",
      })
      .onConflictDoUpdate({
        target: schema.copyMirrorFailsafeChecks.exposureKey,
        set: {
          flatObservations: observations,
          lastCheckedAt: now,
          closeSourceItemId,
          status: "confirmed_flat",
        },
      });

    logger.warn(
      LOG_SERVICE,
      "source is flat while mirrored follower exposure remains",
      {
        followerUserId: exposure.followerUserId,
        coin: exposure.coin,
        side: exposure.side,
        exposureSizeDecimal: exposure.size,
        observations,
        dryRun: process.env.COPY_MIRROR_POSITION_FAILSAFE_EXECUTE !== "true",
      },
    );
    if (process.env.COPY_MIRROR_POSITION_FAILSAFE_EXECUTE !== "true") return;

    // A later poll may reach this block again after status is close_staged.
    // The deterministic source item id is protected by the delivery table's
    // unique follower/source constraint, so repeated staging is a no-op.
    await this.stageCandidates([candidate]);
    await this.db
      .update(schema.copyMirrorFailsafeChecks)
      .set({ status: "close_staged", lastCheckedAt: now })
      .where(
        eq(schema.copyMirrorFailsafeChecks.exposureKey, exposure.exposureKey),
      );
  }
}
