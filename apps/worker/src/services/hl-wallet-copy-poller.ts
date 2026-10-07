/**
 * Read-only Hyperliquid wallet source watcher.
 *
 * This service never owns signing authority and never submits, cancels, closes,
 * or modifies a venue order. It converts newly observed fills from an armed
 * `hl_wallet` follow into the same durable `MirrorSourceCandidate` inbox used by
 * every other copy source. CopyMirrorPoller remains the one execution owner, so
 * wallet follows inherit its consent re-read, wallet-owned sizing/leverage,
 * idempotency, reconciliation, protection and fail-closed behavior.
 */

import { schema, type WorkerPoolDb } from "@trade-bot/db";
import {
  isCanonicalPerpCoin,
  networkFromEnv,
  type HyperliquidNetwork,
  type PerpSide,
} from "@trade-bot/hyperliquid";
import { createProductionLogger } from "@trade-bot/logger";
import { and, count, eq, isNotNull, or, sql } from "drizzle-orm";

import { createHyperliquidInfoClient } from "../../../api/src/lib/hyperliquid";
import type { SizingMode } from "../../../api/src/lib/copy-mirror";
import { signedPerpExposure } from "./copy-mirror-perp-decimal";
import type { MirrorSourceCandidate } from "./copy-mirror";
import { readMirrorDestination } from "./copy-mirror-destinations";

const logger = createProductionLogger();
const LOG_SERVICE = "hl-wallet-copy";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const FILL_SCAN_LIMIT = 100;
const MAX_GROUPS_PER_CYCLE = 500;
export const MIRRORED_EXPOSURE_SCAN_LIMIT = 1_000;

type FollowRow = typeof schema.copyTradeFollows.$inferSelect;

export interface WalletSourceFill {
  coin: string;
  side: "buy" | "sell";
  dir: string;
  sz: string;
  time: number;
  tid: number;
}

export interface WalletCloseContext {
  mirroredExposureSizeDecimal: string;
  mirroredExposureClientOrderIds: readonly string[];
}

/**
 * The shape of rows returned by the exposure history scan.
 * Exported so pure computation can be tested without a database.
 */
export interface ExposureHistoryRow {
  clientOrderId: string | null;
  direction: string | null;
  reduceOnly: boolean | null;
  executedSizeDecimal: string | null;
}

/**
 * Pure: classify a fetched exposure-history row set as an attributed open position.
 * Returns null when the history is truncated (exceeds the scan limit), no net open
 * exposure remains in positionSide, or no open-direction client order IDs can be
 * attributed. Extracted from computeMirroredExposure so the fail-closed truncation
 * behavior is testable without a live database.
 */
export function computeExposureFromRows(
  rows: ExposureHistoryRow[],
  positionSide: PerpSide,
  scanLimit: number = MIRRORED_EXPOSURE_SCAN_LIMIT,
): WalletCloseContext | null {
  if (rows.length > scanLimit) return null;

  const exposure = signedPerpExposure(rows);
  if (!exposure || exposure.side !== positionSide) return null;

  const attributedClientOrderIds = rows
    .filter((row) => row.direction === positionSide && row.reduceOnly === false)
    .map((row) => row.clientOrderId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (attributedClientOrderIds.length === 0) return null;
  return {
    mirroredExposureSizeDecimal: exposure.size,
    mirroredExposureClientOrderIds: [...new Set(attributedClientOrderIds)],
  };
}

export interface BuildWalletMirrorCandidateInput {
  followerUserId: string;
  followId: string;
  credentialId: string;
  walletAddress: string;
  sizingMode: SizingMode;
  sizingValue: number;
  userMaxLeverage: number;
  followMaxLeverage: number | null;
  sourceLeverage: number;
  sourceVenueNetwork: string;
  closeContext?: WalletCloseContext;
  fill: WalletSourceFill;
}

export type StageWalletMirrorCandidates = (
  candidates: MirrorSourceCandidate[],
) => Promise<void>;

function asAddress(value: string | null | undefined): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as `0x${string}`)
    : null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function validLeverage(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100;
}

async function readSourceDatabaseNow(db: WorkerPoolDb): Promise<number> {
  const execute = (db as any).execute;
  if (typeof execute !== "function") return Date.now();
  const result = await execute.call(db, sql`SELECT CURRENT_TIMESTAMP AS now`);
  const row = Array.isArray(result)
    ? result[0]
    : Array.isArray(result?.rows)
      ? result.rows[0]
      : result;
  const raw = row && typeof row === "object" ? Reflect.get(row, "now") : undefined;
  const timestamp = raw instanceof Date
    ? raw.getTime()
    : typeof raw === "string" && raw.trim() !== ""
      ? Date.parse(raw)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new Error("wallet source database clock is malformed");
  return timestamp;
}

/**
 * The wallet source watcher is intentionally stricter than the generic worker:
 * sync and network selection must be explicit before a mainnet fill is even
 * staged. Execution still repeats every live/mainnet/consent gate later.
 */
export function walletCopyRuntimeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (
    env.HL_WALLET_COPY_ENABLED !== "true" ||
    env.COPY_TRADE_AUTOMIRROR_ENABLED !== "true" ||
    env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED !== "true" ||
    env.HYPERLIQUID_SYNC_ENABLED !== "true"
  ) {
    return false;
  }
  const network = env.HYPERLIQUID_NETWORK?.trim().toLowerCase();
  if (network === "mainnet") {
    return (
      env.COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true" &&
      env.COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET === "true"
    );
  }
  if (network === "testnet") {
    return env.HYPERLIQUID_ALLOW_TESTNET === "true";
  }
  return false;
}

/** Freeze one source-wallet fill into the normal durable mirror candidate. */
export function buildWalletMirrorCandidate(
  input: BuildWalletMirrorCandidateInput,
): MirrorSourceCandidate | null {
  const walletAddress = asAddress(input.walletAddress);
  if (
    !walletAddress ||
    !input.followerUserId ||
    !input.followId ||
    !input.credentialId ||
    !isCanonicalPerpCoin(input.fill.coin) ||
    !Number.isFinite(input.fill.time) ||
    !Number.isSafeInteger(input.fill.tid) ||
    input.fill.tid < 0 ||
    !Number.isFinite(input.sizingValue) ||
    input.sizingValue <= 0 ||
    !validLeverage(input.userMaxLeverage)
  ) {
    return null;
  }
  if (input.followMaxLeverage !== null && !validLeverage(input.followMaxLeverage)) {
    return null;
  }

  const isOpen = input.fill.dir.startsWith("Open");
  const isClose = input.fill.dir.startsWith("Close");
  if (!isOpen && !isClose) return null;
  if (isClose && !input.closeContext) return null;

  const perpSide: PerpSide = input.fill.side === "buy" ? "long" : "short";
  const sourceLeverage = validLeverage(input.sourceLeverage) ? input.sourceLeverage : 1;
  const sourceItemId = `hl_wallet:${walletAddress}:${input.fill.tid}`;
  // Attribution must stay stable across both the source OPEN and CLOSE. A
  // mutable display label cannot be used here because close exposure is scoped
  // by this exact value before it reaches the shared mirror engine.
  const copySourceLabel = walletAddress;

  return {
    followerUserId: input.followerUserId,
    followId: input.followId,
    credentialId: input.credentialId,
    sourceItemId,
    sourceEventAt: new Date(input.fill.time).toISOString(),
    symbol: input.fill.coin,
    side: input.fill.side,
    sizingMode: input.sizingMode,
    sizingValue: input.sizingValue,
    assetType: "PERP",
    sourceQtyDecimal: input.fill.sz,
    perpSide,
    perpLeverage: sourceLeverage,
    perpUserMaxLeverage: input.userMaxLeverage,
    perpFollowMaxLeverage: input.followMaxLeverage,
    perpMarginMode: "cross",
    perpReduceOnly: isClose,
    sourceVenueNetwork: input.sourceVenueNetwork,
    copySourceLabel,
    ...(isClose
      ? {
          sourcePositionSizeDecimal: input.fill.sz,
          mirroredExposureSizeDecimal: input.closeContext!.mirroredExposureSizeDecimal,
          mirroredExposureClientOrderIds:
            input.closeContext!.mirroredExposureClientOrderIds,
        }
      : {}),
  };
}

export class HlWalletCopyPoller {
  private readonly db: WorkerPoolDb;
  private readonly stageCandidates: StageWalletMirrorCandidates;
  private readonly pollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private inFlightPoll = false;
  private rotationOffset = 0;

  constructor(db: WorkerPoolDb, stageCandidates: StageWalletMirrorCandidates) {
    this.db = db;
    this.stageCandidates = stageCandidates;
    const envInterval = Number.parseInt(process.env.HL_WALLET_COPY_POLL_MS ?? "", 10);
    this.pollIntervalMs = Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_POLL_INTERVAL_MS;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    if (!walletCopyRuntimeEnabled()) {
      logger.info(LOG_SERVICE, "[hl-wallet-copy] disabled by source-staging gates");
      return;
    }
    this.isRunning = true;
    logger.info(LOG_SERVICE, `[hl-wallet-copy] starting, polling every ${this.pollIntervalMs}ms`);
    void this.pollOnce();
    this.intervalId = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    logger.info(LOG_SERVICE, "[hl-wallet-copy] stopped");
  }

  /** One read-only source scan. Exposed for focused tests. */
  public async pollOnce(): Promise<void> {
    if (this.inFlightPoll) return;
    this.inFlightPoll = true;
    try {
      await this.runCycle();
    } catch (error) {
      logger.error(LOG_SERVICE, "[hl-wallet-copy] poll cycle error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlightPoll = false;
    }
  }

  private async runCycle(): Promise<void> {
    if (!walletCopyRuntimeEnabled()) return;
    const eligibleWhere = and(
      eq(schema.copyTradeFollows.targetType, "hl_wallet"),
      or(
        eq(schema.copyTradeFollows.perpAutoMirror, true),
        eq(schema.copyTradeFollows.autoMirror, true),
      ),
    );
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(schema.copyTradeFollows)
      .where(eligibleWhere);
    const total = toNumber(totalRow?.value);
    if (total === 0) {
      this.rotationOffset = 0;
      return;
    }
    if (this.rotationOffset >= total) this.rotationOffset = 0;

    const follows = await this.db
      .select()
      .from(schema.copyTradeFollows)
      .where(eligibleWhere)
      .orderBy(schema.copyTradeFollows.id)
      .limit(MAX_GROUPS_PER_CYCLE)
      .offset(this.rotationOffset);
    this.rotationOffset = this.rotationOffset + MAX_GROUPS_PER_CYCLE >= total
      ? 0
      : this.rotationOffset + MAX_GROUPS_PER_CYCLE;

    type Group = { followerUserId: string; walletAddress: string; rows: FollowRow[] };
    const groups = new Map<string, Group>();
    for (const follow of follows) {
      const walletAddress = asAddress(follow.targetKey);
      if (!walletAddress) continue;
      const key = `${follow.followerUserId}\0${walletAddress}`;
      const existing = groups.get(key);
      if (existing) existing.rows.push(follow);
      else groups.set(key, { followerUserId: follow.followerUserId, walletAddress, rows: [follow] });
    }

    const network = networkFromEnv();
    for (const group of groups.values()) {
      try {
        await this.processGroup({ ...group, network });
      } catch (error) {
        logger.error(LOG_SERVICE, "[hl-wallet-copy] group staging failed", {
          followerUserId: group.followerUserId,
          walletPrefix: `${group.walletAddress.slice(0, 10)}...`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async processGroup({
    followerUserId,
    walletAddress,
    rows,
    network,
  }: {
    followerUserId: string;
    walletAddress: string;
    rows: FollowRow[];
    network: HyperliquidNetwork;
  }): Promise<void> {
    const follow = rows[0];
    const destination = follow
      ? readMirrorDestination(follow, "perp", { legacyProvider: "hyperliquid" })
      : null;
    if (!follow || !destination?.enabled || !destination.credentialId) return;

    const user = await this.db.query.users.findFirst({
      where: (u, { eq: e }) => e(u.id, followerUserId),
      columns: { copyPerpMaxLeverage: true },
    });
    const userMaxLeverage = Number(user?.copyPerpMaxLeverage);
    const followMaxLeverage = follow.perpMaxLeverage == null
      ? null
      : Number(follow.perpMaxLeverage);
    if (!validLeverage(userMaxLeverage) || (followMaxLeverage !== null && !validLeverage(followMaxLeverage))) {
      logger.warn(LOG_SERVICE, "[hl-wallet-copy] invalid wallet-owned leverage policy", {
        followerUserId,
        followId: follow.id,
      });
      return;
    }

    const cursorRow = await this.db.query.hlWalletCopyCursors.findFirst({
      where: (c, { and: a, eq: e }) =>
        a(e(c.followerUserId, followerUserId), e(c.walletAddress, walletAddress)),
    });
    const now = await readSourceDatabaseNow(this.db);
    let watermarkMs = cursorRow?.watermarkMs ?? 0;
    let watermarkTid = cursorRow?.watermarkTid ?? 0;
    if (watermarkMs === 0) {
      watermarkMs = now;
      await this.db
        .insert(schema.hlWalletCopyCursors)
        .values({ followerUserId, walletAddress, watermarkMs, watermarkTid: 0 })
        .onConflictDoNothing();
      logger.info(LOG_SERVICE, "[hl-wallet-copy] first-run cursor seeded", {
        followerUserId,
        walletPrefix: `${walletAddress.slice(0, 10)}...`,
        watermarkMs,
      });
      return;
    }

    const info = createHyperliquidInfoClient({ network, trafficClass: "background" });
    const [allFills, sourcePositions] = await Promise.all([
      info.listFills(walletAddress as `0x${string}`),
      info.listPositions(walletAddress as `0x${string}`).catch(() => []),
    ]);
    const sourceLeverageMap = new Map<string, number>();
    for (const position of sourcePositions) {
      sourceLeverageMap.set(position.coin, position.leverage);
    }

    const isNewer = (fill: WalletSourceFill): boolean =>
      fill.time > watermarkMs || (fill.time === watermarkMs && fill.tid > watermarkTid);
    const fills = allFills as WalletSourceFill[];
    for (const fill of fills) {
      if (!fill || typeof fill !== "object" || !Number.isFinite(fill.time)) {
        logger.warn(LOG_SERVICE, "[hl-wallet-copy] holding cursor for an unorderable source fill", {
          followerUserId,
          walletPrefix: `${walletAddress.slice(0, 10)}...`,
        });
        return;
      }
      if (
        fill.time >= watermarkMs &&
        (!Number.isSafeInteger(fill.tid) || fill.tid < 0)
      ) {
        logger.warn(LOG_SERVICE, "[hl-wallet-copy] holding cursor for a fill without a stable identity", {
          followerUserId,
          walletPrefix: `${walletAddress.slice(0, 10)}...`,
        });
        return;
      }
    }

    const ordered = fills
      .filter(isNewer)
      .sort((a, b) => a.time - b.time || a.tid - b.tid)
      .slice(0, FILL_SCAN_LIMIT);
    if (ordered.length === 0) return;

    let newWatermarkMs = watermarkMs;
    let newWatermarkTid = watermarkTid;
    const advanceTo = (fill: WalletSourceFill): void => {
      newWatermarkMs = fill.time;
      newWatermarkTid = fill.tid;
    };

    const sizingMode = destination.sizingMode as SizingMode;
    const sizingValue = destination.sizingValue;
    for (const fill of ordered) {
      const isClose = fill.dir.startsWith("Close");
      const isOpen = fill.dir.startsWith("Open");
      // Liquidations ("Liquidated Long" / "Liquidated Short") and position
      // flips ("Long > Short") are legitimate Hyperliquid fill dir values that
      // will never produce a mirror candidate. Advance past them so the cursor
      // is never permanently stuck at a fill that cannot be retried to success.
      if (!isOpen && !isClose) {
        logger.info(LOG_SERVICE, "[hl-wallet-copy] skipping non-open/close fill (e.g. liquidation or position flip)", {
          followerUserId,
          dir: String(fill.dir).slice(0, 32),
          walletPrefix: `${walletAddress.slice(0, 10)}...`,
          coin: typeof fill.coin === "string" ? fill.coin.slice(0, 24) : null,
        });
        advanceTo(fill);
        continue;
      }
      if (fill.time > now && isClose) break;
      let closeContext: WalletCloseContext | undefined;
      if (isClose) {
        const orderSide: PerpSide = fill.side === "buy" ? "long" : "short";
        const positionSide: PerpSide = orderSide === "long" ? "short" : "long";
        closeContext = await this.computeMirroredExposure(
          followerUserId,
          walletAddress,
          fill.coin,
          positionSide,
        ) ?? undefined;
        // Do not consume the source close before its attributed open is visible.
        // The next cycle retries this same fill after the shared engine executes.
        if (!closeContext) break;
      }

      const candidate = buildWalletMirrorCandidate({
        followerUserId,
        followId: follow.id,
        credentialId: destination.credentialId,
        walletAddress,
        sizingMode,
        sizingValue,
        userMaxLeverage,
        followMaxLeverage,
        sourceLeverage: sourceLeverageMap.get(fill.coin) ?? 1,
        sourceVenueNetwork: network,
        ...(closeContext ? { closeContext } : {}),
        fill,
      });
      if (!candidate) {
        logger.warn(LOG_SERVICE, "[hl-wallet-copy] holding cursor for a fill without an eligible mirror candidate", {
          followerUserId,
          walletPrefix: `${walletAddress.slice(0, 10)}...`,
          coin: typeof fill.coin === "string" ? fill.coin.slice(0, 24) : null,
        });
        break;
      }

      // Durable staging succeeds before the source cursor advances. A database
      // failure therefore retries the fill; no venue mutation happens here.
      await this.stageCandidates([candidate]);
      // A future-dated open is durably terminalized as stale by the shared
      // delivery inbox, but the source cursor must wait until venue time catches
      // up so later real fills cannot sit behind a future watermark.
      if (fill.time > now) break;
      advanceTo(fill);
    }

    if (newWatermarkMs > watermarkMs || newWatermarkTid > watermarkTid) {
      await this.db
        .insert(schema.hlWalletCopyCursors)
        .values({
          followerUserId,
          walletAddress,
          watermarkMs: newWatermarkMs,
          watermarkTid: newWatermarkTid,
        })
        .onConflictDoUpdate({
          target: [
            schema.hlWalletCopyCursors.followerUserId,
            schema.hlWalletCopyCursors.walletAddress,
          ],
          set: { watermarkMs: newWatermarkMs, watermarkTid: newWatermarkTid },
        });
    }
  }

  private async computeMirroredExposure(
    followerUserId: string,
    walletAddress: string,
    coin: string,
    positionSide: PerpSide,
  ): Promise<WalletCloseContext | null> {
    const closingSide: PerpSide = positionSide === "long" ? "short" : "long";
    const rows = await this.db
      .select({
        clientOrderId: schema.orders.clientOrderId,
        direction: schema.orders.direction,
        reduceOnly: schema.orders.reduceOnly,
        executedSizeDecimal: schema.orders.executedSizeDecimal,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.userId, followerUserId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.symbol, coin),
          eq(schema.orders.copySourceLabel, walletAddress),
          isNotNull(schema.orders.executedSizeDecimal),
          or(
            and(eq(schema.orders.direction, positionSide), eq(schema.orders.reduceOnly, false)),
            and(eq(schema.orders.direction, closingSide), eq(schema.orders.reduceOnly, true)),
          ),
        ),
      )
      .limit(MIRRORED_EXPOSURE_SCAN_LIMIT + 1);

    if (rows.length > MIRRORED_EXPOSURE_SCAN_LIMIT) {
      logger.warn(LOG_SERVICE, "[hl-wallet-copy] attributed exposure history exceeds scan bound", {
        followerUserId,
        walletPrefix: `${walletAddress.slice(0, 10)}...`,
        coin,
        scanLimit: MIRRORED_EXPOSURE_SCAN_LIMIT,
      });
    }

    return computeExposureFromRows(rows, positionSide);
  }
}
