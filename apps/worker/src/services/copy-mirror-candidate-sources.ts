/**
 * Where mirror candidates COME FROM (audit H7: own module).
 *
 * `findMirrorCandidates` and the small readers it runs on were lifted verbatim
 * out of `copy-mirror.ts`, which was far over the size ceiling. Nothing about
 * their behavior changed in the move: the same queries run in the same order,
 * the same rows are skipped for the same reasons, and the same log lines are
 * emitted.
 *
 * This module DISCOVERS work; it never places an order. Every candidate it
 * returns is still re-gated at execution time.
 */

import {
  millisecondTimestamp,
  millisecondTimestampValue,
  schema,
  type WorkerPoolDb,
} from "@trade-bot/db";
import { createProductionLogger } from "@trade-bot/logger";
// Pure, shared classifier: a signal tagged with a perp/derivatives venue, a perp
// instrument, or a SHORT direction (e.g. paste.trade "GOOGL short 20x perp") must
// NOT be mirrored as a plain equity BUY. Legacy X/Discord signals carry none of
// these fields and remain mirrorable.
import {
  classifySignalInstrument,
  canonicalAuthorSource,
  isCanonicalAuthorKey,
  MAX_SAFE_TRADING_PERP_SIZE,
  MAX_SAFE_TRADING_VALUE,
  normalizeAuthorAlias,
  parseSourceAuthorAliasKey,
  readCanonicalAuthorForSource,
  sourceAuthorAliasKey,
} from "@trade-bot/utils";
import { networkFromEnv, parseCanonicalPerpCoin } from "@trade-bot/hyperliquid";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

// traderKey is the SAME one-way hash that produced the stored follow target_key.
// deriveAuthor is the same signal-author extraction used by the Copy Trade feed.
// Import them from the LIB (NOT a router) so the worker never executes a tRPC
// module (which would pull @trpc/server etc.) just to resolve identities.
import { traderKey } from "../../../api/src/lib/trader-identity";
import { parseOptionSignal } from "../../../api/src/lib/option-signal-parser";
import {
  buildAuthoritativeOrderJoin,
  publiclyEligibleOrderCondition,
  validOptionContractCondition,
} from "../../../api/src/lib/authoritative-order";
import { isValidOptionContractIdentity } from "../../../api/src/lib/options";
import { parseStrictFiniteNumber } from "../../../api/src/lib/strict-number";
import {
  normalizeTradeAction,
  isSupportedAlpacaMirrorAction,
  tradeActionSide,
  tradeActionDirection,
  type TradeAction,
  type TradeDirection,
} from "../../../api/src/lib/trade-action";
import { explicitPerpSide, parsePositiveDecimal } from "./copy-mirror-perp-decimal";
import type { PerpLogLine } from "./copy-mirror-perp-observability";
import { isPerpsAutoMirrorEnabled } from "./copy-mirror-perp-sync-gate";
import type {
  MirrorAssetType,
  MirrorOptionType,
  MirrorSourceCandidate,
} from "./copy-mirror";
import { readMirrorDestination } from "./copy-mirror-destinations";

const logger = createProductionLogger();

const LOG_SERVICE = "copy-mirror";
export const COPY_MIRROR_SIGNAL_PAGE_SIZE = 1_000;
export const COPY_MIRROR_SOCIAL_PAGE_SIZE = 1_000;
export const COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE = 100;
const COPY_MIRROR_ALIAS_SCAN_CAP = 5_000;

/** Resolve the execution direction followers submit from the source producer's row. */
export function mirroredPerpOrderSide(
  storedDirection: "long" | "short",
  reduceOnly: boolean,
  tradeAction?: TradeAction | null,
  externalOrigin = false,
): "long" | "short" {
  if (!reduceOnly) return storedDirection;

  // Native orders store the submitted execution direction. Externally observed
  // fills store the position direction that was closed. The action is the one
  // common, explicit execution-side field across both producers, so prefer it.
  const actionSide = tradeActionSide(tradeAction);
  if (actionSide === "buy") return "long";
  if (actionSide === "sell") return "short";

  // Defensive fallback for legacy rows whose action cannot be interpreted.
  if (!externalOrigin) return storedDirection;
  return storedDirection === "long" ? "short" : "long";
}

export interface MirrorAuthorAliasOwner {
  alias: string;
  canonicalKey: string;
  source?: string | null;
}

/** Resolve signal author keys while keeping ambiguous aliases out of matching. */
export function resolveMirrorAuthorMatchKeys(
  metadata: unknown,
  aliasOwners: readonly MirrorAuthorAliasOwner[] = [],
  options: { durableLookupAvailable?: boolean; durableLookupFailed?: boolean } = {},
  source?: string | null,
): string[] {
  const author = readCanonicalAuthorForSource(metadata, source);
  if (author.identityKind === "relay") return [];
  const durableLookupAvailable = options.durableLookupAvailable === true;
  const durableLookupFailed = options.durableLookupFailed === true;
  const ownersByScopedAlias = new Map<string, Set<string>>();
  const ownersByPlainAlias = new Map<string, Set<string>>();
  for (const owner of aliasOwners) {
    const alias = normalizeAuthorAlias(owner.alias);
    if (!alias || !isCanonicalAuthorKey(owner.canonicalKey)) continue;
    const ownerSource = owner.source ?? canonicalAuthorSource(owner.canonicalKey);
    if (!ownerSource) continue;
    const owners = ownersByScopedAlias.get(`${ownerSource}\u0000${alias}`) ?? new Set<string>();
    owners.add(owner.canonicalKey);
    ownersByScopedAlias.set(`${ownerSource}\u0000${alias}`, owners);
    const plainOwners = ownersByPlainAlias.get(alias) ?? new Set<string>();
    plainOwners.add(owner.canonicalKey);
    ownersByPlainAlias.set(alias, plainOwners);
  }

  const keys: string[] = [];
  const candidateAliases = [...new Set([
    ...author.authorAliases,
    ...author.authorAliasHistory,
    normalizeAuthorAlias(author.authorName),
  ].filter((key): key is string => key !== null))];
  const candidateKeys = author.canonicalAuthorKey
    ? [author.canonicalAuthorKey]
    : [];
  for (const key of candidateKeys) {
    if (isCanonicalAuthorKey(key)) {
      keys.push(key);
    }
  }
  if (durableLookupFailed) return [...new Set(keys)];
  const scopedSource = author.source ?? canonicalAuthorSource(author.canonicalAuthorKey);
  for (const candidate of candidateAliases) {
    const alias = normalizeAuthorAlias(parseSourceAuthorAliasKey(candidate)?.alias ?? candidate);
    if (!alias) continue;
    const scopedOwners = scopedSource
      ? ownersByScopedAlias.get(`${scopedSource}\u0000${alias}`)
      : undefined;
    if (scopedOwners?.size && scopedOwners.size > 1) continue;
    if (author.canonicalAuthorKey && scopedOwners?.size === 1 && !scopedOwners.has(author.canonicalAuthorKey)) {
      continue;
    }
    if (scopedSource) {
      const scopedAliasKey = sourceAuthorAliasKey(scopedSource, alias);
      if (scopedAliasKey) keys.push(scopedAliasKey);
    }
    const plainOwners = ownersByPlainAlias.get(alias);
    if (plainOwners?.size === 1) {
      const owner = [...plainOwners][0]!;
      if (!author.canonicalAuthorKey || owner === author.canonicalAuthorKey) {
        keys.push(alias, owner);
      }
    } else if (!durableLookupAvailable && !scopedSource && !author.canonicalAuthorKey) {
      keys.push(alias);
    }
  }
  return [...new Set(keys)];
}

interface DurableMirrorAliasState {
  available: boolean;
  failed: boolean;
  owners: MirrorAuthorAliasOwner[];
}

interface MirrorAliasLookupRef {
  /** A mutable display-name alias, optionally qualified by source. */
  alias?: string;
  source?: string;
  /** A canonical follow whose historical aliases should also be resolved. */
  canonicalKey?: string;
}

export interface CreatedAtIdCursor {
  createdAt: Date;
  id: string;
}

export type CreatedAtIdFence = CreatedAtIdCursor;

export interface MirrorSourceScanFences {
  socialTrades: CreatedAtIdFence | null;
  signals: CreatedAtIdFence | null;
}

export function createdAtIdAfter(cursor: CreatedAtIdCursor | null, createdAt: any, id: any): SQL | null {
  if (!cursor) return null;
  const createdAtKey = millisecondTimestamp(createdAt);
  return or(
    gt(createdAtKey, cursor.createdAt),
    and(eq(createdAtKey, cursor.createdAt), gt(id, cursor.id)),
  )!;
}

/** Inclusive upper fence for a scan ordered by the complete normalized key. */
export function createdAtIdAtOrBefore(
  fence: CreatedAtIdFence | null,
  createdAt: any,
  id: any,
): SQL {
  if (!fence) return sql`false`;
  const createdAtKey = millisecondTimestamp(createdAt);
  return or(
    lt(createdAtKey, fence.createdAt),
    and(eq(createdAtKey, fence.createdAt), lte(id, fence.id)),
  )!;
}

export function createdAtIdFenceFromRow(
  row: { createdAt?: Date | string | null; id?: string | null } | undefined,
): CreatedAtIdFence | null {
  if (!row?.id) return null;
  const createdAt = millisecondTimestampValue(row.createdAt);
  return createdAt ? { createdAt, id: row.id } : null;
}

async function captureCreatedAtIdFence(
  db: WorkerPoolDb,
  table: any,
): Promise<CreatedAtIdFence | null> {
  const createdAtKey = millisecondTimestamp(table.createdAt);
  const rows = await db
    .select({ createdAt: table.createdAt, id: table.id })
    .from(table)
    .orderBy(desc(createdAtKey), desc(table.id))
    .limit(1);
  return createdAtIdFenceFromRow(rows[0]);
}

/** Capture both source fences before either source table starts paging. */
export async function captureMirrorSourceFences(db: WorkerPoolDb): Promise<MirrorSourceScanFences> {
  const [socialTrades, signals] = await Promise.all([
    captureCreatedAtIdFence(db, schema.socialTrades),
    captureCreatedAtIdFence(db, schema.signals),
  ]);
  return { socialTrades, signals };
}

function advanceCreatedAtIdCursor(
  page: readonly { createdAt: Date | null; id: string | null }[],
  previous: CreatedAtIdCursor | null,
): CreatedAtIdCursor {
  const last = page.at(-1);
  if (!last?.createdAt || !last.id) {
    throw new Error("copy-mirror keyset page ended without a created_at/id cursor");
  }
  const createdAt = millisecondTimestampValue(last.createdAt);
  if (!createdAt) {
    throw new Error("copy-mirror keyset cursor had an invalid created_at value");
  }
  const next = { createdAt, id: last.id };
  if (
    previous &&
    (next.createdAt < previous.createdAt ||
      (next.createdAt.getTime() === previous.createdAt.getTime() && next.id <= previous.id))
  ) {
    throw new Error("copy-mirror keyset page did not advance");
  }
  return next;
}

async function loadDurableMirrorAliasOwners(
  db: WorkerPoolDb,
  aliases: readonly MirrorAliasLookupRef[],
): Promise<DurableMirrorAliasState> {
  const dbAny = db as any;
  const hasTables = Boolean(
    dbAny.query?.sourceAuthorAliases &&
      dbAny.query?.sourceAuthorIdentities &&
      typeof dbAny.select === "function",
  );
  if (!hasTables || aliases.length === 0) {
    return { available: false, failed: false, owners: [] };
  }

  try {
    const conditions: SQL[] = [];
    const canonicalKeys = aliases
      .map((ref) => ref.canonicalKey)
      .filter((key): key is string => typeof key === "string" && isCanonicalAuthorKey(key));
    if (canonicalKeys.length > 0) {
      conditions.push(
        inArray(schema.sourceAuthorIdentities.canonicalKey, [...new Set(canonicalKeys)]),
      );
    }
    const plainAliases = aliases
      .filter((ref) => !ref.source && typeof ref.alias === "string")
      .map((ref) => ref.alias!);
    if (plainAliases.length > 0) {
      conditions.push(
        inArray(schema.sourceAuthorAliases.alias, [...new Set(plainAliases)]),
      );
    }
    for (const ref of aliases) {
      if (!ref.source || typeof ref.alias !== "string") continue;
      conditions.push(
        and(
          eq(schema.sourceAuthorAliases.source, ref.source),
          eq(schema.sourceAuthorAliases.alias, ref.alias),
        )!,
      );
    }
    if (conditions.length === 0) return { available: true, failed: false, owners: [] };
    const query = dbAny
      .select({
        alias: schema.sourceAuthorAliases.alias,
        source: schema.sourceAuthorAliases.source,
        canonicalKey: schema.sourceAuthorIdentities.canonicalKey,
      })
      .from(schema.sourceAuthorAliases)
      .innerJoin(
        schema.sourceAuthorIdentities,
        eq(
          schema.sourceAuthorIdentities.id,
          schema.sourceAuthorAliases.identityId,
        ),
      )
      .where(or(...conditions)!);
    const rows = await (typeof query.limit === "function"
      ? query.limit(COPY_MIRROR_ALIAS_SCAN_CAP + 1)
      : query);
    if (rows.length > COPY_MIRROR_ALIAS_SCAN_CAP) {
      logger.warn(LOG_SERVICE, "Alias ownership lookup exceeded its safety cap", {
        aliasCount: aliases.length,
        cap: COPY_MIRROR_ALIAS_SCAN_CAP,
      });
      return { available: true, failed: true, owners: [] };
    }
    return {
      available: true,
      failed: false,
      owners: rows
        .filter(
          (row: { alias?: unknown; canonicalKey?: unknown }) =>
            typeof row.alias === "string" &&
            typeof row.canonicalKey === "string",
        )
        .map((row: { alias: string; canonicalKey: string }) => ({
          alias: row.alias,
          canonicalKey: row.canonicalKey,
          source: (row as { source?: string }).source ?? null,
        })),
    };
  } catch (error) {
    logger.warn(LOG_SERVICE, "Alias ownership lookup failed; historical aliases are held", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { available: true, failed: true, owners: [] };
  }
}

/**
 * Stamp the SOURCE event time onto a candidate, or leave it absent.
 *
 * Absent is a real answer: it makes the perp intent age unknowable, and an
 * unknown age fails the freshness bound instead of defaulting to "now", which
 * would certify every stale intent as fresh.
 */
function sourceEventAtFields(
  eventAt: Date | string | null | undefined,
): { sourceEventAt?: string } {
  if (eventAt instanceof Date) {
    return Number.isFinite(eventAt.getTime()) ? { sourceEventAt: eventAt.toISOString() } : {};
  }
  if (typeof eventAt === "string" && eventAt.trim() !== "") {
    const parsed = new Date(eventAt);
    return Number.isFinite(parsed.getTime()) ? { sourceEventAt: parsed.toISOString() } : {};
  }
  return {};
}

interface PerpLeverageSnapshot {
  perpUserMaxLeverage?: number;
  perpFollowMaxLeverage?: number | null;
}

/**
 * Read the policy owned by each exact armed follow before discovering either
 * source kind. The follow page is a caller-provided snapshot, but loading the
 * two policy columns here keeps the candidate's durable snapshot tied to the
 * persisted follow id and its owning user rather than to a partial test or
 * legacy row shape.
 */
async function loadPerpLeverageSnapshots(
  db: WorkerPoolDb,
  follows: readonly (typeof schema.copyTradeFollows.$inferSelect)[],
): Promise<Map<string, PerpLeverageSnapshot>> {
  const followIds = follows
    .map((follow) => follow.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (followIds.length === 0) return new Map();

  const rows = await db
    .select({
      followId: schema.copyTradeFollows.id,
      perpUserMaxLeverage: schema.users.copyPerpMaxLeverage,
      perpFollowMaxLeverage: schema.copyTradeFollows.perpMaxLeverage,
    })
    .from(schema.copyTradeFollows)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.copyTradeFollows.followerUserId),
    )
    .where(inArray(schema.copyTradeFollows.id, followIds))
    .limit(followIds.length);

  return new Map(
    rows
      .filter((row) => typeof row.followId === "string" && row.followId.length > 0)
      .map((row) => [
        row.followId,
        {
          perpUserMaxLeverage: row.perpUserMaxLeverage,
          perpFollowMaxLeverage: row.perpFollowMaxLeverage,
        },
      ] as const),
  );
}

function perpLeverageSnapshotFields(
  snapshot: PerpLeverageSnapshot | undefined,
): Pick<MirrorSourceCandidate, "perpUserMaxLeverage" | "perpFollowMaxLeverage"> {
  if (!snapshot) return {};
  const fields: Pick<MirrorSourceCandidate, "perpUserMaxLeverage" | "perpFollowMaxLeverage"> = {};
  if (snapshot.perpUserMaxLeverage !== undefined) {
    fields.perpUserMaxLeverage = snapshot.perpUserMaxLeverage;
  }
  if (snapshot.perpFollowMaxLeverage !== undefined) {
    fields.perpFollowMaxLeverage = snapshot.perpFollowMaxLeverage;
  }
  return fields;
}

/**
 * When the SOURCE event actually happened, for perps.
 *
 * `orders.createdAt` is when we wrote the row. For an ordinary order that is
 * close enough to the trade, but the Hyperliquid reconciler back-fills synthetic
 * fill children with the venue time in `executedAt` and leaves `createdAt` to
 * default to the moment reconciliation ran. So after an outage every catch-up
 * row looks like it happened just now, and a batch of them looks simultaneous.
 *
 * Two things break on that. Staleness treats an hours-old open as fresh. Worse,
 * the reconciler scans parent orders newest-first, so an open and its later
 * close reconciled in one pass can be written close-first and then ordered
 * close-before-open. The delivery sorter would consume the close against a
 * position that does not exist yet and then place the stale open, leaving the
 * follower long with their exit already spent.
 *
 * `executedAt` is the venue's own timestamp and does not move with when we
 * happened to catch up, so it wins wherever it exists. Rows without one (a
 * PENDING order that never filled) fall back as before.
 */
function perpSourceEventAt(trade: {
  orderExecutedAt?: Date | null;
  orderCreatedAt?: Date | null;
  createdAt?: Date | null;
}): Date | string | null | undefined {
  return trade.orderExecutedAt ?? trade.orderCreatedAt ?? trade.createdAt;
}

/**
 * When the SOURCE event actually happened, for equities/options.
 *
 * Mirrors the reasoning in `perpSourceEventAt` above, but cannot copy its
 * "prefer executedAt whenever it exists" rule verbatim: for an ordinary
 * in-app order, `executedAt` is set (moments) AFTER `orderCreatedAt`, so
 * preferring it outright would let a source order sit hours in flight before
 * its late fill and still read as fresh, which is a real loosening the perp
 * side does not have to worry about (Hyperliquid orders resolve near-instantly).
 *
 * `ExternalFillPoller` (external-fill-sync.ts) produces the opposite shape:
 * `executedAt` is the broker's `filled_at`, the true venue time, while
 * `createdAt`/`orderCreatedAt` default to the moment ingestion wrote the row.
 * After an outage, or on a backfilled first scan, that row's `executedAt` is
 * hours BEFORE `orderCreatedAt`.
 *
 * Taking the EARLIER of the two, when both exist, catches exactly that
 * back-filled shape (executedAt < orderCreatedAt) while leaving an ordinary
 * order's stamp exactly where it already was (orderCreatedAt, since
 * executedAt >= orderCreatedAt for any fill that happens after submission).
 * Nothing here loosens the freshness bound; it only tightens the one case the
 * old `orderCreatedAt ?? createdAt` stamp mistook for "just happened".
 */
function equitySourceEventAt(trade: {
  orderExecutedAt?: Date | null;
  orderCreatedAt?: Date | null;
  createdAt?: Date | null;
}): Date | string | null | undefined {
  const { orderExecutedAt, orderCreatedAt, createdAt } = trade;
  if (orderExecutedAt && orderCreatedAt) {
    return orderExecutedAt.getTime() < orderCreatedAt.getTime() ? orderExecutedAt : orderCreatedAt;
  }
  return orderCreatedAt ?? orderExecutedAt ?? createdAt;
}

/**
 * Whether a shared trade's asset type is mirrorable by THIS worker.
 *
 * Options are mirrorable only after the candidate has been enriched with the
 * joined orders.option_* contract identity. Unknown/legacy asset types fail
 * closed so we never submit an instrument we cannot identify.
 */
export function isMirrorableAsset(assetType: string | null | undefined): boolean {
  return assetType === "EQUITY" || assetType === "OPTION";
}

type LegacyCredentialProvider = "alpaca" | "hyperliquid";
type LegacyCredentialLookup = {
  available: boolean;
  providers: Map<string, LegacyCredentialProvider>;
};

function needsLegacyCredentialProvider(follow: Record<string, unknown>): boolean {
  return (
    typeof follow.credentialId === "string" &&
    follow.credentialId.trim() !== "" &&
    follow.stockAutoMirror === false &&
    follow.perpAutoMirror === false &&
    follow.stockCredentialId == null &&
    follow.perpCredentialId == null
  );
}

/** Resolve the provider of a brand-new row written by an older API revision. */
async function loadLegacyCredentialProviders(
  db: WorkerPoolDb,
  follows: readonly Record<string, unknown>[],
): Promise<LegacyCredentialLookup> {
  const ids = [...new Set(
    follows
      .filter(needsLegacyCredentialProvider)
      .map((follow) => String(follow.credentialId)),
  )];
  if (ids.length === 0) return { available: false, providers: new Map() };
  const findMany = (db as any).query?.userApiCredentials?.findMany;
  if (typeof findMany !== "function") return { available: false, providers: new Map() };
  try {
    const rows = await findMany.call((db as any).query.userApiCredentials, {
      where: inArray(schema.userApiCredentials.id, ids),
      columns: { id: true, userId: true, provider: true, accountType: true },
    });
    const providers = new Map<string, LegacyCredentialProvider>();
    for (const row of rows as Array<Record<string, unknown>>) {
      const provider = row.provider === "alpaca" || row.provider === "hyperliquid"
        ? row.provider
        : null;
      const ready = provider === "alpaca"
        ? row.accountType === "PAPER" || row.accountType === "LIVE"
        : provider === "hyperliquid" && row.accountType === "LIVE";
      if (typeof row.id === "string" && typeof row.userId === "string" && provider && ready) {
        providers.set(`${row.userId}:${row.id}`, provider);
      }
    }
    return { available: true, providers };
  } catch {
    // A provider lookup failure must not turn an untyped legacy row into a
    // two-venue candidate. The execution-time provider gate remains a second
    // line of defense for legacy-shaped test adapters.
    return { available: true, providers: new Map() };
  }
}

function legacyDestinationOptions(
  follow: Record<string, unknown>,
  lookup: LegacyCredentialLookup,
): { legacyProvider?: LegacyCredentialProvider | null } {
  if (!needsLegacyCredentialProvider(follow) || !lookup.available) return {};
  const provider = lookup.providers.get(`${follow.followerUserId}:${follow.credentialId}`) ?? null;
  return { legacyProvider: provider };
}

/**
 * Whether an order was placed BY the mirror rather than by the account owner.
 *
 * Every mirror this worker places carries the deterministic
 * "copymirror:<follower>:<source item>" client_order_id from
 * `mirrorIdempotencyKey`, which is the same marker `countMirrorsToday` and
 * `mirroredExposureCredentialId` already match on. The Hyperliquid reconciler
 * holds the identical predicate under the name `isAutoMirroredOrder`.
 */
export function isAutoMirroredClientOrderId(
  clientOrderId: string | null | undefined,
): boolean {
  return clientOrderId?.startsWith("copymirror:") === true;
}

/**
 * Worker-local copy of the Copy Trade feed's author-key normalization.
 *
 * Kept local (instead of importing the router helper) so the worker does not
 * execute tRPC router modules at startup.
 */
function normalizeAuthorKey(authorName: string | null | undefined): string | null {
  if (!authorName) return null;
  const normalized = authorName.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || normalized === "unknown") return null;
  return normalized;
}

export function parseOptionStrike(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = parseStrictFiniteNumber(raw);
  return n !== null && n > 0 ? n : null;
}

function normalizeAssetType(raw: string | null | undefined): MirrorAssetType | null {
  return raw === "EQUITY" || raw === "OPTION" || raw === "PERP" ? raw : null;
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Direct-execution sources own their orders; generic mirroring must not replay them. */
export function isDirectExecutionManagedSignal(metadata: unknown): boolean {
  return metadataRecord(metadata)?.directExecutionManaged === true;
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Freeze the source identity needed to join separate BTO/STC signal rows. */
function sourceAuthorFields(signal: {
  source?: string | null;
  sourceAuthorId?: string | null;
  metadata?: unknown;
}): Pick<MirrorSourceCandidate, "sourceAuthorKey"> {
  const metadata = metadataRecord(signal.metadata) ?? {};
  if (signal.sourceAuthorId && !metadata.sourceAuthorId) {
    metadata.sourceAuthorId = signal.sourceAuthorId;
  }
  const author = readCanonicalAuthorForSource(metadata, signal.source);
  return author.canonicalAuthorKey ? { sourceAuthorKey: author.canonicalAuthorKey } : {};
}

function metadataPositiveInt(metadata: Record<string, unknown> | null, key: string): number | null {
  const raw = metadata?.[key];
  const value = typeof raw === "number" || typeof raw === "string"
    ? parseStrictFiniteNumber(raw)
    : null;
  return value !== null && value > 0 ? Math.floor(value) : null;
}

function normalizeOptionType(raw: string | null | undefined): MirrorOptionType | null {
  const upper = raw?.toUpperCase();
  return upper === "CALL" || upper === "PUT" ? upper : null;
}

export function resolveUserTradeAction(input: {
  assetType: "EQUITY" | "OPTION";
  tradeAction: string | null | undefined;
  side: string | null | undefined;
  direction?: string | null;
}): { tradeAction: TradeAction; side: "buy" | "sell"; direction: TradeDirection } | null {
  const action = normalizeTradeAction(input.tradeAction);
  const direction = input.direction === "short" || input.direction === "long"
    ? input.direction
    : null;
  if (!action || !direction) return null;
  const resolvedAction = action === "Buy" || action === "Sell"
    ? direction === "short"
      ? input.assetType === "EQUITY"
        ? action === "Buy" ? "BuyToCover" : "SellShort"
        : null
      : action
    : action;
  if (!resolvedAction || tradeActionDirection(resolvedAction) !== direction) return null;
  const side = tradeActionSide(resolvedAction);
  if (!side) return null;
  return { tradeAction: resolvedAction, side, direction };
}

export function resolveMirrorSourceQuantity(input: {
  executedQuantity?: number | null;
  orderQuantity?: number | null;
  socialQuantity?: number | null;
}): number | undefined {
  for (const value of [input.executedQuantity, input.orderQuantity, input.socialQuantity]) {
    if (
      value !== null &&
      value !== undefined &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= MAX_SAFE_TRADING_VALUE
    ) {
      return value;
    }
  }
  return undefined;
}

export function externalMirrorFillCondition(orders: {
  status: any;
  executedPrice: any;
  executedQuantity: any;
  executedSizeDecimal: any;
  assetType: any;
  optionExpiration: any;
  optionStrike: any;
  optionType: any;
}): SQL {
  // Provenance does not make a row mirrorable: local and external sources both
  // need a real finite fill, otherwise a submitted/invalid order can become a
  // follower order before the source ever traded.
  return and(
    inArray(orders.status, ["FILLED", "PARTIAL", "CANCELLED", "EXPIRED", "REJECTED"]),
    sql`${orders.executedPrice} is not null and ${orders.executedPrice}::text not in ('NaN', 'Infinity', '-Infinity')`,
    gt(orders.executedPrice, "0"),
    lte(orders.executedPrice, String(MAX_SAFE_TRADING_VALUE)),
    or(
      and(
        eq(orders.assetType, "PERP"),
        sql`${orders.executedSizeDecimal} is not null and ${orders.executedSizeDecimal}::text not in ('NaN', 'Infinity', '-Infinity')`,
        gt(orders.executedSizeDecimal, "0"),
        lte(orders.executedSizeDecimal, MAX_SAFE_TRADING_PERP_SIZE),
      ),
      and(
        ne(orders.assetType, "PERP"),
        sql`${orders.executedQuantity} is not null and ${orders.executedQuantity}::text not in ('NaN', 'Infinity', '-Infinity')`,
        gt(orders.executedQuantity, "0"),
        lte(orders.executedQuantity, String(MAX_SAFE_TRADING_VALUE)),
      ),
    ),
    validOptionContractCondition(orders),
  )!;
}

/**
 * Source-row predicate used by the social-trade scan.
 *
 * Alpaca social rows are published when the broker accepts an order, before
 * the order has a fill. Equity/option rows therefore have to stay visible to
 * the durable delivery queue until `processCandidate` can re-read the source
 * order and defer a still-working submission. Hyperliquid user trades are
 * different: their social rows are generated from reconciled fills, and the
 * perp execution path has no source-order fill gate, so retain the strict fill
 * predicate for that branch.
 */
export function mirrorSourceStagingCondition(orders: {
  status: any;
  executedPrice: any;
  executedQuantity: any;
  executedSizeDecimal: any;
  assetType: any;
  optionExpiration: any;
  optionStrike: any;
  optionType: any;
}): SQL {
  return or(
    and(
      eq(orders.assetType, "PERP"),
      externalMirrorFillCondition(orders),
    ),
    and(
      ne(orders.assetType, "PERP"),
      validOptionContractCondition(orders),
    ),
  )!;
}

/**
 * The one line that says a perp CLOSE was queued while the perps gate is shut.
 *
 * A reduce-only close is staged whatever the gate says, because nothing
 * recreates a source close: `stageWindow` advances the checkpoint either way, so
 * a close dropped here is gone and the follower keeps a mirrored position with
 * no exit. `assessPerpMirrorPreflight` then DEFERS it, so it waits in the
 * delivery queue until the configuration lets it through. Neither half of that
 * is changing, and this function decides nothing.
 *
 * What was missing is that the staging half was SILENT. The
 * "unsupported-user-perp" skip line below never fires for a close, so turning
 * perps off started a queue with no log line anywhere. This names the moment the
 * queue gains an entry; its depth and the age of its oldest row are reported
 * once per poll cycle by `readDeferredCloseBacklog` in `copy-mirror.ts`.
 *
 * Pure, matching `describePerpConfigFault`, so the line an operator reads during
 * an incident is unit-testable without a DB. Null when there is nothing to say.
 */
export function describeDeferredCloseStaging(input: {
  perpsGateOpen: boolean;
  reduceOnly: boolean;
}): PerpLogLine | null {
  if (input.perpsGateOpen || !input.reduceOnly) return null;
  return {
    level: "warn",
    message:
      "[copy-mirror] queuing a perp close while the perps gate is shut: it is deferred, not dropped, and stays queued until the configuration lets it through",
  };
}

/**
 * Resolve auto-mirror follow rows into concrete source trades to mirror.
 *
 * For "user" follows: join copy_trade_follows.target_key (== social.ts
 * traderKey hash) against recently shared social trades. The follow row stores
 * only the NON-PII hash; we match it to the source user by comparing the hash
 * of each social trade's userId. The real source user id stays server-only and
 * is never exposed to the follower.
 *
 * For "x_author" follows: join target_key (the normalized author key from the
 * Copy Trade feed) against recent signal rows by deriving and normalizing the
 * signal metadata author. Ordinary X signals are mirrored as BUY equities;
 * complete, explicit BTO/STC option signals retain their contract identity.
 * Explicit Hyperliquid perp signals retain their long/short, leverage, and
 * canonical coin identity, and are emitted only under the separate perps flag.
 * Other derivative venues and standalone equity SHORT signals are skipped.
 *
 * politician resolution is intentionally NOT wired up in this build.
 *
 * Returns the partial candidate shape; per-follower account context (buying
 * power / paper-or-live / price / counts / dedupe) is filled in by
 * processCandidate so we only decrypt creds / hit the broker for real matches.
 */
export async function findMirrorCandidateSources(
  db: WorkerPoolDb,
  follows: (typeof schema.copyTradeFollows.$inferSelect)[],
  windowStart: Date,
  windowEnd: Date,
  onCandidateBatch?: (batch: MirrorSourceCandidate[]) => Promise<void>,
  sourceFences?: MirrorSourceScanFences,
): Promise<MirrorSourceCandidate[]> {
  const legacyCredentialLookup = await loadLegacyCredentialProviders(
    db,
    follows as readonly Record<string, unknown>[],
  );
  const destinationReadOptions = (follow: (typeof follows)[number]) =>
    legacyDestinationOptions(follow as unknown as Record<string, unknown>, legacyCredentialLookup);

  // Index follows by their NON-PII target key for O(1) lookup.
  const userFollowsByKey = new Map<string, (typeof follows)[number][]>();
  const xAuthorFollowsByKey = new Map<string, (typeof follows)[number][]>();
  for (const f of follows) {
    if (f.targetType === "user") {
      const list = userFollowsByKey.get(f.targetKey) ?? [];
      list.push(f);
      userFollowsByKey.set(f.targetKey, list);
      continue;
    }

    if (f.targetType === "x_author") {
      const sourceAlias = parseSourceAuthorAliasKey(f.targetKey);
      const authorKey = isCanonicalAuthorKey(f.targetKey)
        ? f.targetKey
        : sourceAlias
          ? sourceAuthorAliasKey(sourceAlias.source, sourceAlias.alias)
          : normalizeAuthorKey(f.targetKey);
      if (!authorKey) continue;
      const list = xAuthorFollowsByKey.get(authorKey) ?? [];
      list.push(f);
      xAuthorFollowsByKey.set(authorKey, list);
    }
  }

  if (userFollowsByKey.size === 0 && xAuthorFollowsByKey.size === 0) return [];

  const out: MirrorSourceCandidate[] = [];
  const pendingCandidates: MirrorSourceCandidate[] = [];
  const seenCandidateKeys = new Set<string>();
  const pushCandidate = async (candidate: (typeof out)[number]): Promise<void> => {
    const key = `${candidate.followerUserId}|${candidate.sourceItemId}`;
    if (seenCandidateKeys.has(key)) return;
    seenCandidateKeys.add(key);
    if (onCandidateBatch) pendingCandidates.push(candidate);
    else out.push(candidate);
    if (onCandidateBatch && pendingCandidates.length >= COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE) {
      await flushCandidateBatch();
    }
  };
  const flushCandidateBatch = async (resetKeys = false): Promise<void> => {
    if (onCandidateBatch) {
      while (pendingCandidates.length > 0) {
        const batch = pendingCandidates.splice(0, COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE);
        await onCandidateBatch(batch);
      }
    }
    if (resetKeys) seenCandidateKeys.clear();
  };

  // The fence is captured once before the first source page. A row inserted
  // after that point is intentionally left for the bounded replay overlap on
  // the next cycle, where delivery uniqueness makes the replay idempotent.
  const fences = sourceFences ?? await captureMirrorSourceFences(db);
  const perpLeverageSnapshots = await loadPerpLeverageSnapshots(db, follows);

  // Pull social trades created in this window. We over-select and match the
  // traderKey hash in memory so the raw source user id never has to be exposed
  // to (or stored against) the follower. Option identity is read from the
  // joined orders row because social_trades only stores the underlying symbol.
  if (userFollowsByKey.size > 0) {
    const socialTrades = alias(schema.socialTrades, "mirror_social_trades");
    const orders = alias(schema.orders, "mirror_orders");
    const otherOrders = alias(schema.orders, "mirror_other_orders");
    const authoritativeOrderJoin = buildAuthoritativeOrderJoin(
      db,
      socialTrades,
      orders,
      otherOrders,
    );
    const processSocialPage = async (trades: readonly Record<string, any>[]) => {
      const tradesBySourceId = new Map<string, Array<Record<string, any>>>();
      for (const trade of trades) {
        if (trade.orderUserId && trade.orderUserId !== trade.userId) continue;
        const group = tradesBySourceId.get(trade.id) ?? [];
        group.push(trade);
        tradesBySourceId.set(trade.id, group);
      }

      for (const tradeGroup of tradesBySourceId.values()) {
        const instrumentFingerprints = new Set(
          tradeGroup.map((trade) =>
            JSON.stringify([
              trade.orderSymbol ?? null,
              trade.orderAssetType ?? null,
              trade.orderQuantityDecimal ?? null,
              trade.orderExecutedSizeDecimal ?? null,
              trade.tradeAction ?? null,
              trade.orderDirection ?? null,
              trade.orderLeverage ?? null,
              trade.orderMarginMode ?? null,
              trade.orderVenue ?? null,
              trade.orderReduceOnly ?? null,
              trade.optionExpiration ?? null,
              trade.optionStrike ?? null,
              trade.optionType ?? null,
            ]),
          ),
        );
        if (instrumentFingerprints.size > 1) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: conflicting-joined-orders", {
            sourceItemId: `user:${tradeGroup[0]!.id}`,
          });
          continue;
        }

        const trade = tradeGroup[0]!;

        // A mirror is never a source, however it reached social_trades.
        //
        // `placeMirrorOrder` no longer publishes its own orders, but rows it
        // published before that cannot be unpublished, and they stay selectable
        // for as long as they sit inside a poll window. Without this, two people
        // who auto-mirror each other keep re-copying one real trade back and
        // forth, at full size each hop, until the daily cap stops them. The
        // provenance is on the joined order, so a mirror is recognised by the same
        // client_order_id the worker wrote when it placed it.
        if (tradeGroup.some((row) => isAutoMirroredClientOrderId(row.orderClientOrderId))) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: mirror-origin", {
            sourceItemId: `user:${trade.id}`,
            symbol: trade.symbol,
          });
          continue;
        }

        if (!trade.orderId) continue;
        if (!trade.symbol) continue;
        const resolvedAssetType = normalizeAssetType(trade.orderAssetType ?? trade.assetType);
        if (!resolvedAssetType || (resolvedAssetType !== "PERP" && !isMirrorableAsset(resolvedAssetType))) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: unsupported-asset", {
            sourceItemId: `user:${trade.id}`,
            symbol: trade.symbol,
            assetType: resolvedAssetType,
          });
          continue;
        }

        if (
          resolvedAssetType !== "PERP" &&
          trade.tradeAction !== null &&
          trade.tradeAction !== undefined &&
          !normalizeTradeAction(trade.tradeAction)
        ) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: unsupported-trade-action", {
            sourceItemId: `user:${trade.id}`,
            symbol: trade.symbol,
            tradeAction: trade.tradeAction,
          });
          continue;
        }

        if (resolvedAssetType === "PERP") {
          const perpSide = explicitPerpSide(trade.orderDirection);
          const sourceQtyDecimal = trade.orderExecutedSizeDecimal ?? trade.orderQuantityDecimal;
          const perpCoin = parseCanonicalPerpCoin(trade.orderSymbol ?? trade.symbol);
          const perpsGateOpen = isPerpsAutoMirrorEnabled();
          if (
            (!perpsGateOpen && trade.orderReduceOnly !== true) ||
            trade.orderVenue !== "hyperliquid" ||
            !perpSide ||
            !perpCoin ||
            !sourceQtyDecimal ||
            !parsePositiveDecimal(sourceQtyDecimal)
          ) {
            logger.info(LOG_SERVICE, "[copy-mirror] skip: unsupported-user-perp", {
              sourceItemId: `user:${trade.id}`,
              venue: trade.orderVenue,
              direction: trade.orderDirection,
              canonicalCoin: perpCoin !== null,
              perpsGateOpen,
              reduceOnly: trade.orderReduceOnly === true,
            });
            continue;
          }

          const staging = describeDeferredCloseStaging({
            perpsGateOpen,
            reduceOnly: trade.orderReduceOnly === true,
          });
          if (staging) {
            logger[staging.level](LOG_SERVICE, staging.message, {
              sourceItemId: `user:${trade.id}`,
              coin: perpCoin,
              perpsGateOpen,
              reduceOnly: true,
            });
          }

          const matching = userFollowsByKey.get(traderKey(trade.userId));
          if (!matching) continue;
          const mirrorOrderSide = mirroredPerpOrderSide(
            perpSide,
            trade.orderReduceOnly === true,
            trade.tradeAction,
            trade.orderExternalOrigin === true,
          );
          for (const follow of matching) {
            if (follow.followerUserId === trade.userId) continue;
            const destination = readMirrorDestination(follow, "perp", destinationReadOptions(follow));
            // A close may still need to reach an existing durable exposure;
            // open discovery is gated by the current destination consent.
            if (!destination.enabled && trade.orderReduceOnly !== true) continue;
            await pushCandidate({
              followerUserId: follow.followerUserId,
              ...(follow.id ? { followId: follow.id } : {}),
              credentialId: destination.credentialId,
              sourceItemId: `user:${trade.id}`,
              ...sourceEventAtFields(perpSourceEventAt(trade)),
              symbol: perpCoin,
              side: mirrorOrderSide === "long" ? "buy" : "sell",
              sizingMode: destination.sizingMode,
              sizingValue: destination.sizingValue,
              maxTradeSize: parseStrictFiniteNumber(follow.maxTradeSize) ?? null,
              maxCoinSize: parseStrictFiniteNumber(follow.maxCoinSize) ?? null,
              assetType: "PERP",
              sourceQtyDecimal,
              sourceUserId: trade.userId,
              ...(trade.orderId ? { sourceOrderId: trade.orderId } : {}),
              ...((trade.orderExecutedAt ?? trade.orderCreatedAt)
                ? {
                    sourceOrderCreatedAt: (trade.orderExecutedAt ?? trade.orderCreatedAt)!.toISOString(),
                  }
                : {}),
              perpSide: mirrorOrderSide,
              perpLeverage: trade.orderLeverage ?? 1,
              ...perpLeverageSnapshotFields(perpLeverageSnapshots.get(follow.id)),
              perpMarginMode: trade.orderMarginMode === "cross" ? "cross" : "isolated",
              perpReduceOnly: trade.orderReduceOnly === true,
              ...(trade.orderInitialTakeProfitPx
                ? { sourceInitialTakeProfitPx: trade.orderInitialTakeProfitPx }
                : {}),
              ...(trade.orderInitialStopLossPx
                ? { sourceInitialStopLossPx: trade.orderInitialStopLossPx }
                : {}),
              ...(trade.orderVenueNetwork
                ? { sourceVenueNetwork: trade.orderVenueNetwork }
                : {}),
              copySourceLabel: follow.targetLabel ?? undefined,
            });
          }
          continue;
        }

        const symbol = (trade.orderSymbol ?? trade.symbol).toUpperCase();
        const userTradeAction = resolvedAssetType === "EQUITY" || resolvedAssetType === "OPTION"
          ? resolveUserTradeAction({
              assetType: resolvedAssetType,
              tradeAction: trade.tradeAction,
              side: trade.side,
              direction: trade.orderDirection,
            })
          : null;
        const optionStrike =
          resolvedAssetType === "OPTION" ? parseOptionStrike(trade.optionStrike) : null;
        const optionType =
          resolvedAssetType === "OPTION" ? normalizeOptionType(trade.optionType) : null;

        if (!userTradeAction) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: unresolved-trade-intent", {
            sourceItemId: `user:${trade.id}`,
            symbol,
            tradeAction: trade.tradeAction,
            direction: trade.orderDirection,
          });
          continue;
        }

        if (resolvedAssetType === "OPTION") {
          if (!isValidOptionContractIdentity({
            optionExpiration: trade.optionExpiration,
            optionStrike,
            optionType,
          })) {
            logger.info(LOG_SERVICE, "[copy-mirror] skip: missing-option-contract", {
              sourceItemId: `user:${trade.id}`,
              symbol,
              tradeAction: trade.tradeAction,
            });
            continue;
          }
          if (!isSupportedAlpacaMirrorAction("OPTION", userTradeAction.tradeAction)) {
            logger.info(LOG_SERVICE, "[copy-mirror] skip: unsupported-trade-action", {
              sourceItemId: `user:${trade.id}`,
              symbol,
              tradeAction: userTradeAction.tradeAction,
              direction: userTradeAction.direction,
            });
            continue;
          }
        }

        const matching = userFollowsByKey.get(traderKey(trade.userId));
        if (!matching || matching.length === 0) continue;
        const sourceQty = resolveMirrorSourceQuantity({
          executedQuantity: trade.orderExecutedQuantity,
          orderQuantity: trade.orderQuantity,
          socialQuantity: trade.socialQty,
        });

        for (const follow of matching) {
          if (follow.followerUserId === trade.userId) continue;
          const destination = readMirrorDestination(follow, "stock", destinationReadOptions(follow));
          if (!destination.enabled && userTradeAction.side !== "sell") continue;
          const sourceEventAt = equitySourceEventAt(trade);
          const sourceEventFields = sourceEventAtFields(sourceEventAt);
          await pushCandidate({
            followerUserId: follow.followerUserId,
            ...(follow.id ? { followId: follow.id } : {}),
            credentialId: destination.credentialId,
            sourceItemId: `user:${trade.id}`,
            ...sourceEventFields,
            symbol,
            side: userTradeAction.side,
            sizingMode: destination.sizingMode,
            sizingValue: destination.sizingValue,
            maxTradeSize: parseStrictFiniteNumber(follow.maxTradeSize) ?? null,
            maxCoinSize: parseStrictFiniteNumber(follow.maxCoinSize) ?? null,
            assetType: resolvedAssetType,
            sourceQty,
            // Equity closes need the same source-side attribution that the perp
            // path already carries.  The follower's display label is mutable and
            // is not an identity; these immutable source ids let the execution
            // path reconstruct the source position and select only this trader's
            // copied exposure.
            sourceUserId: trade.userId,
            ...(trade.orderId ? { sourceOrderId: trade.orderId } : {}),
            ...(sourceEventFields.sourceEventAt
              ? { sourceOrderCreatedAt: sourceEventFields.sourceEventAt }
              : {}),
            copySourceLabel: follow.targetLabel ?? undefined,
            ...(optionStrike && optionType
              ? {
                  optionExpiration: trade.optionExpiration!,
                  optionStrike,
                  optionType,
                  tradeAction: userTradeAction.tradeAction,
                  direction: userTradeAction.direction,
                }
              : {
                  tradeAction: userTradeAction.tradeAction,
                  direction: userTradeAction.direction,
                }),
          });
        }
      }
    };
    let socialCursor: CreatedAtIdCursor | null = null;
    while (true) {
      const createdAtKey = millisecondTimestamp(socialTrades.createdAt);
      const socialConditions: SQL[] = [
        gte(createdAtKey, windowStart),
        lte(createdAtKey, windowEnd),
        createdAtIdAtOrBefore(fences.socialTrades, socialTrades.createdAt, socialTrades.id),
        mirrorSourceStagingCondition(orders),
        publiclyEligibleOrderCondition(db, orders),
      ];
      const socialKeyset = createdAtIdAfter(
        socialCursor,
        socialTrades.createdAt,
        socialTrades.id,
      );
      if (socialKeyset) socialConditions.push(socialKeyset);
      const page = await db
        .select({
        id: socialTrades.id,
        userId: socialTrades.userId,
        symbol: socialTrades.symbol,
        side: socialTrades.side,
        assetType: socialTrades.assetType,
        // socialTrades.qty is the surfaced trade size; orders.quantity is the
        // broker-side fill qty (preferred when joined). Both feed ratio mode.
        socialQty: socialTrades.qty,
        socialOrderId: socialTrades.orderId,
        socialBrokerOrderId: socialTrades.brokerOrderId,
        orderQuantity: orders.quantity,
        orderExecutedQuantity: orders.executedQuantity,
        orderExecutedSizeDecimal: orders.executedSizeDecimal,
        orderId: orders.id,
        orderQuantityDecimal: orders.quantityDecimal,
        orderUserId: orders.userId,
        orderSymbol: orders.symbol,
        orderAssetType: orders.assetType,
        tradeAction: orders.tradeAction,
        orderDirection: orders.direction,
        orderLeverage: orders.leverage,
        orderMarginMode: orders.marginMode,
        orderVenue: orders.venue,
        orderVenueNetwork: orders.venueNetwork,
        orderReduceOnly: orders.reduceOnly,
        orderExternalOrigin: orders.externalOrigin,
        orderInitialTakeProfitPx: orders.initialTakeProfitPx,
        orderInitialStopLossPx: orders.initialStopLossPx,
        // Provenance. Read here so a published mirror can be told apart from a
        // hand-placed trade; see the mirror-origin skip below.
        orderClientOrderId: orders.clientOrderId,
        orderCreatedAt: orders.createdAt,
        // The VENUE's fill time. `createdAt` is when the row was written, which
        // for a synthetic fill child is when reconciliation ran, not when the
        // fill happened. After an outage those two are hours apart, and a whole
        // batch of catch-up rows shares roughly one createdAt. See
        // `perpSourceEventAt` for why perps order by this instead.
        orderExecutedAt: orders.executedAt,
        optionExpiration: orders.optionExpiration,
        optionStrike: orders.optionStrike,
        optionType: orders.optionType,
        createdAt: socialTrades.createdAt,
        })
        .from(socialTrades)
        .innerJoin(orders, authoritativeOrderJoin)
        .where(and(...socialConditions)!)
        .orderBy(asc(createdAtKey), asc(socialTrades.id))
        .limit(COPY_MIRROR_SOCIAL_PAGE_SIZE);
      await processSocialPage(page);
      await flushCandidateBatch(true);
      if (page.length < COPY_MIRROR_SOCIAL_PAGE_SIZE) break;
      socialCursor = advanceCreatedAtIdCursor(page, socialCursor);
    }

  }

  if (xAuthorFollowsByKey.size > 0) {
    const aliasLookups = follows
      .filter((follow) => follow.targetType === "x_author")
      .map((follow): MirrorAliasLookupRef | null => {
        const sourceAlias = parseSourceAuthorAliasKey(follow.targetKey);
        if (sourceAlias) return sourceAlias;
        if (isCanonicalAuthorKey(follow.targetKey)) {
          return { canonicalKey: follow.targetKey };
        }
        const alias = normalizeAuthorAlias(follow.targetKey);
        return alias ? { alias } : null;
      })
      .filter((ref): ref is MirrorAliasLookupRef => ref !== null);
    const durableAliasState = await loadDurableMirrorAliasOwners(db, aliasLookups);
    let signalCursor: CreatedAtIdCursor | null = null;
    while (true) {
      const createdAtKey = millisecondTimestamp(schema.signals.createdAt);
      const signalConditions: SQL[] = [
        // Window on OUR insertion time, not the source's stated timestamp.
        gte(createdAtKey, windowStart),
        lte(createdAtKey, windowEnd),
        createdAtIdAtOrBefore(fences.signals, schema.signals.createdAt, schema.signals.id),
      ];
      const signalKeyset = createdAtIdAfter(
        signalCursor,
        schema.signals.createdAt,
        schema.signals.id,
      );
      if (signalKeyset) signalConditions.push(signalKeyset);
      const signals = await db
        .select({
        id: schema.signals.id,
        source: schema.signals.source,
        sourceAuthorId: schema.signals.sourceAuthorId,
        symbol: schema.signals.symbol,
        content: schema.signals.content,
        metadata: schema.signals.metadata,
        timestamp: schema.signals.timestamp,
        // The INGEST stamp (`defaultNow()`), which is what the window is a
        // cursor over. Selected alongside `timestamp` because the two answer
        // different questions and both are needed: see the window filter below.
        createdAt: schema.signals.createdAt,
        })
        .from(schema.signals)
        .where(and(...signalConditions)!)
        .orderBy(asc(createdAtKey), asc(schema.signals.id))
        .limit(COPY_MIRROR_SIGNAL_PAGE_SIZE);

      for (const signal of signals) {
      if (!signal.symbol) continue;

      if (isDirectExecutionManagedSignal(signal.metadata)) {
        logger.info(LOG_SERVICE, "[copy-mirror] skip: direct-execution-managed-signal", {
          sourceItemId: `x_signal:${signal.id}`,
          source: signal.source,
          symbol: signal.symbol,
        });
        continue;
      }

      const matching = [...new Map(
        resolveMirrorAuthorMatchKeys(signal.metadata, durableAliasState.owners, {
          durableLookupAvailable: durableAliasState.available,
          durableLookupFailed: durableAliasState.failed,
        }, signal.source)
          .flatMap((key) => xAuthorFollowsByKey.get(key) ?? [])
          .map((follow) => [follow.id, follow] as const),
      ).values()];
      if (matching.length === 0) continue;

      // Content is passed, not just metadata: only the paste.trade poller
      // writes platform/instrument/direction, so a free-text "GOOGL 20x
      // short perp" from a followed Discord or X author used to reach the
      // equity branch below and place an inverted market BUY.
      const classification = classifySignalInstrument(
        signal.metadata,
        signal.content,
      );
      // The ENTRY test is deliberately wider than the accept test below: a row
      // that merely carries a perp-only field (leverage / hlTicker) is claimed
      // by this branch so it can never fall through to the equity BUY, even
      // when upstream dropped platform / instrument. Everything that enters
      // here either mirrors as a CONFIRMED Hyperliquid perp or is skipped.
      const isPerp =
        classification.perpVenue ||
        classification.perpInstrument ||
        classification.perpHint;
      if (isPerp) {
        if (!isPerpsAutoMirrorEnabled()) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: perps-auto-mirror-disabled", {
            sourceItemId: `x_signal:${signal.id}`,
            symbol: signal.symbol,
          });
          continue;
        }
        if (classification.platform !== "hyperliquid" && classification.platform !== "hl") {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: non-hyperliquid-perp-signal", {
            sourceItemId: `x_signal:${signal.id}`,
            platform: classification.platform,
            perpHints: classification.perpHints,
          });
          continue;
        }
        // The venue alone is NOT enough to place a leveraged perp. Hyperliquid
        // also lists spot markets, so a row tagged platform "hyperliquid" with
        // instrument "spot" (or with no instrument at all) previously reached
        // placeOrder as a LEVERAGED PERP. The instrument must say perp.
        if (!classification.perpInstrument) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: unconfirmed-perp-instrument", {
            sourceItemId: `x_signal:${signal.id}`,
            platform: classification.platform,
            instrument: classification.instrument,
            perpHints: classification.perpHints,
          });
          continue;
        }

        const metadata = metadataRecord(signal.metadata);
        const perpSide = explicitPerpSide(classification.direction);
        // The coin must be upstream's CANONICAL Hyperliquid spelling, checked
        // against the shared validator before it can reach resolveAsset /
        // updateLeverage / placeOrder. There is deliberately NO fallback to
        // `signal.symbol`: that value was uppercased at ingest, so "kPEPE"
        // arrives as "KPEPE" (an unknown coin) and a HIP-3 market's bare
        // underlying ("GOOGL" for "xyz:GOOGL") resolves to a DIFFERENT market.
        // Guessing a coin is guessing which market to lever up.
        const rawCoin = metadataString(metadata, "hlTicker");
        const coin = parseCanonicalPerpCoin(rawCoin);
        if (!coin) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: unusable-perp-coin", {
            sourceItemId: `x_signal:${signal.id}`,
            symbol: signal.symbol,
            reason: rawCoin === null ? "missing-hl-ticker" : "non-canonical-hl-ticker",
            // Truncated so a malformed external value stays diagnosable
            // without pasting an unbounded string into the logs.
            hlTicker: rawCoin === null ? null : rawCoin.slice(0, 24),
          });
          continue;
        }
        if (!perpSide) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: incomplete-perp-signal", {
            sourceItemId: `x_signal:${signal.id}`,
            direction: classification.direction,
          });
          continue;
        }

        for (const follow of matching) {
          const destination = readMirrorDestination(follow, "perp", destinationReadOptions(follow));
          if (!destination.enabled) continue;
          await pushCandidate({
            followerUserId: follow.followerUserId,
            ...(follow.id ? { followId: follow.id } : {}),
            credentialId: destination.credentialId,
            sourceItemId: `x_signal:${signal.id}`,
            ...sourceAuthorFields(signal),
            ...sourceEventAtFields(signal.timestamp),
            symbol: coin,
            side: perpSide === "long" ? "buy" : "sell",
            sizingMode: destination.sizingMode,
            sizingValue: destination.sizingValue,
            maxTradeSize: parseStrictFiniteNumber(follow.maxTradeSize) ?? null,
            maxCoinSize: parseStrictFiniteNumber(follow.maxCoinSize) ?? null,
            assetType: "PERP",
            perpSide,
            perpLeverage: metadataPositiveInt(metadata, "leverage") ?? 1,
            ...perpLeverageSnapshotFields(perpLeverageSnapshots.get(follow.id)),
            perpMarginMode: "isolated",
            // The network this intent was formed on. A signal has no source
            // ORDER to take it from, so it is the one configured at staging.
            // Without it a delivery staged or requeued on testnet could be
            // retried after the deployment moved and placed as a real leveraged
            // mainnet order, with preflight having nothing to compare.
            sourceVenueNetwork: networkFromEnv(),
            copySourceLabel: follow.targetLabel ?? undefined,
          });
        }
        continue;
      }

      const optionParse = parseOptionSignal(signal.content, {
        symbolHint: signal.symbol,
        referenceDate: signal.timestamp,
      });
      if (optionParse.kind === "unsupported") {
        logger.info(LOG_SERVICE, "[copy-mirror] skip: unsupported-x-option-signal", {
          sourceItemId: `x_signal:${signal.id}`,
          symbol: signal.symbol,
          reason: optionParse.reason,
        });
        continue;
      }

      // Real-money guard: a non-option signal is mirrored as a plain equity BUY
      // below. Skip any signal whose metadata marks it as a perp/derivatives
      // venue, a perp instrument, or a SHORT (e.g. the paste.trade perps poller).
      // Option handling is unaffected: explicit BTO/STC contracts keep their own
      // identity, and legacy X/Discord signals (no such metadata) still mirror.
      if (optionParse.kind !== "option") {
        if (!classification.mirrorableEquityLong) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: non-equity-or-short-signal", {
            sourceItemId: `x_signal:${signal.id}`,
            symbol: signal.symbol,
            platform: classification.platform,
            instrument: classification.instrument,
            direction: classification.direction,
            // Which prose checks fired, when metadata said nothing. Never
            // the post text itself: this line is for answering "why was
            // this skipped", not for archiving user content.
            textSignals: classification.text.matches,
          });
          continue;
        }
        // Fail-open visibility: platform/instrument/direction were present on
        // the metadata but unparseable, so classification treated the signal
        // as a plain equity long. Keep the behavior (legacy signals rely on
        // it) but do not let it happen silently.
        if (classification.unrecognizedShape) {
          logger.warn(
            LOG_SERVICE,
            "[copy-mirror] signal metadata present but unrecognized shape, treating as plain equity",
            {
              sourceItemId: `x_signal:${signal.id}`,
              symbol: signal.symbol,
            },
          );
        }
      }

      for (const follow of matching) {
        if (optionParse.kind === "option") {
          const destination = readMirrorDestination(follow, "stock", destinationReadOptions(follow));
          if (!destination.enabled && optionParse.option.side !== "sell") continue;
          await pushCandidate({
            followerUserId: follow.followerUserId,
            ...(follow.id ? { followId: follow.id } : {}),
            credentialId: destination.credentialId,
            sourceItemId: `x_signal:${signal.id}`,
            ...sourceAuthorFields(signal),
            ...sourceEventAtFields(signal.timestamp),
            symbol: optionParse.option.symbol,
            side: optionParse.option.side,
            sizingMode: destination.sizingMode,
            sizingValue: destination.sizingValue,
            maxTradeSize: parseStrictFiniteNumber(follow.maxTradeSize) ?? null,
            maxCoinSize: parseStrictFiniteNumber(follow.maxCoinSize) ?? null,
            assetType: "OPTION",
            optionExpiration: optionParse.option.optionExpiration,
            optionStrike: optionParse.option.optionStrike,
            optionType: optionParse.option.optionType,
            tradeAction: optionParse.option.tradeAction,
            copySourceLabel: follow.targetLabel ?? undefined,
          });
          continue;
        }

        const destination = readMirrorDestination(follow, "stock", destinationReadOptions(follow));
        if (!destination.enabled) continue;
        await pushCandidate({
          followerUserId: follow.followerUserId,
          ...(follow.id ? { followId: follow.id } : {}),
          credentialId: destination.credentialId,
          sourceItemId: `x_signal:${signal.id}`,
          ...sourceAuthorFields(signal),
          ...sourceEventAtFields(signal.timestamp),
          symbol: signal.symbol.toUpperCase(),
          // Copy Trade x_signal equity rows are buy-only until signals carry
          // explicit direction metadata.
          side: "buy",
          sizingMode: destination.sizingMode,
          sizingValue: destination.sizingValue,
          maxTradeSize: parseStrictFiniteNumber(follow.maxTradeSize) ?? null,
          maxCoinSize: parseStrictFiniteNumber(follow.maxCoinSize) ?? null,
          assetType: "EQUITY",
          tradeAction: "Buy",
          copySourceLabel: follow.targetLabel ?? undefined,
        });
      }
      }
      await flushCandidateBatch(true);
      if (signals.length < COPY_MIRROR_SIGNAL_PAGE_SIZE) break;
      signalCursor = advanceCreatedAtIdCursor(signals, signalCursor);
    }
  }

  return out;
}
