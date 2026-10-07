/**
 * Copy-Trade Router
 *
 * Merges multiple "copy-able" signal sources into a single, normalized,
 * timestamp-paginated feed for the copy-trade panel:
 *   - "x_signal": tweet-derived trade signals (schema.signals)
 *   - "user":     trades shared by other users (schema.socialTrades), anonymized
 *   - "politician": congressional disclosures — NO-OP in Phase 1 (table TBD)
 *
 * The router maps every source onto the CopyTradeItem contract, merges them
 * newest-first, and pages by a (timestamp, id) cursor. DB reads are wrapped in
 * try/catch so one failing source degrades to [] instead of killing the feed.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { createProductionLogger } from "@trade-bot/logger";
import { millisecondTimestamp, millisecondTimestampValue, schema, type PoolDb } from "@trade-bot/db";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  lt,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  buildAuthoritativeOrderJoin,
  publiclyEligibleOrderCondition,
  validOptionContractCondition,
} from "../lib/authoritative-order.js";
import { isValidOptionContractIdentity } from "../lib/options.js";
import {
  anonymizeTrader,
  traderKey,
  deriveAuthor,
  resolveTraderIdentity,
} from "../lib/trader-identity.js";
import { parseOptionSignal } from "../lib/option-signal-parser.js";
import { isProfessorUser, shardiSignalCondition } from "../lib/signal-visibility.js";
// Pure classifier shared with the auto-mirror worker: honor a signal's stored
// perp/derivatives venue, instrument, and direction so a paste.trade-style
// "GOOGL short 20x perp" row is not surfaced as a plain equity BUY.
import { classifySignalInstrument } from "@trade-bot/utils";
import {
  canonicalAuthorSource,
  isCanonicalAuthorKey,
  normalizeAuthorAlias,
  parseSourceAuthorAliasKey,
  sourceAuthorAliasKey,
} from "@trade-bot/utils";
// Deployment gating readers shared with the auto-mirror worker. The API reads
// them through the SAME functions the worker gates on so a status read can never
// describe rules the worker does not actually apply.
import { resolveMirrorStatus, type MirrorStatus } from "../lib/copy-mirror.js";
// Same canonical-coin gate the auto-mirror worker applies to this exact join
// (copy-mirror-candidate-sources.ts): a shared perp fill's symbol is validated
// here, once, so every consumer of meta.perpCoin gets an HL-resolvable coin or
// nothing - never a guess reconstructed from the uppercased display symbol.
import { parseCanonicalPerpCoin } from "@trade-bot/hyperliquid";
import { tradeActionDirection, tradeActionSide } from "../lib/trade-action.js";
import { parseStrictFiniteNumber } from "../lib/strict-number.js";

const COPY_FEED_X_SIGNAL_RAW_SCAN_CAP = 5_000;
const COPY_FEED_USER_RAW_SCAN_CAP = 5_000;
const COPY_FEED_ALIAS_SCAN_CAP = 5_000;
const COPY_FEED_FOLLOW_PAGE_SIZE = 100;

const logger = createProductionLogger();

const NOTIFICATION_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
const NOTIFICATION_LIMIT = 20;

function formatNotificationNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function fillNotificationMessage(order: {
  symbol: string;
  tradeAction: string;
  executedQuantity: number | null;
  executedSizeDecimal: string | null;
  executedPrice: string | null;
}): string {
  const quantity = order.executedSizeDecimal ??
    (order.executedQuantity === null ? null : String(order.executedQuantity));
  const parsedQuantity = quantity === null ? null : parseStrictFiniteNumber(quantity);
  const parsedPrice = order.executedPrice === null
    ? null
    : parseStrictFiniteNumber(order.executedPrice);
  const action = order.tradeAction.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const quantityText = parsedQuantity !== null
    ? ` ${formatNotificationNumber(parsedQuantity)} ${order.symbol}`
    : "";
  const priceText = parsedPrice !== null
    ? ` at $${formatNotificationNumber(parsedPrice)}`
    : "";
  const details = `${quantityText}${priceText}`;
  return `${order.symbol} ${action} filled${details ? `:${details}` : ""}.`;
}

// ============================================
// Normalized item contract
// ============================================

export type CopyTradeSource = "x_signal" | "user" | "politician";

export type CopyTradeAssetClass = "all" | "stocks" | "perps";

export type FollowTargetType = "x_author" | "user" | "politician";

/**
 * Stable, NON-PII handle for the trader/author behind an item. Powers the
 * Follow button and the "Following" feed filter. `key` is never the raw user id:
 * for "user" it is a one-way hash (see social.ts traderKey); for "x_author" it
 * is a normalized author key. Null when there is no followable author
 * (e.g. an "Unknown" x_signal author).
 */
export interface FollowTarget {
  type: FollowTargetType;
  key: string;
  label: string;
}

export interface CopyTradeItem {
  source: CopyTradeSource;
  /** SOURCE-PREFIXED id, e.g. "x_signal:<uuid>" / "user:<uuid>" — unique across the merge. */
  id: string;
  symbol: string;
  side: "buy" | "sell";
  displayName: string;
  avatar: string | null;
  /** ISO timestamp — the merge/sort/cursor key. */
  timestamp: string;
  content: string | null;
  url: string | null;
  /** NON-PII follow handle, or null when the item has no followable author. */
  followTarget: FollowTarget | null;
  meta: Record<string, unknown>;
}

export function copyTradeItemMatchesAssetClass(
  item: CopyTradeItem,
  assetClass: CopyTradeAssetClass,
): boolean {
  if (assetClass === "all") return true;
  const isPerp =
    typeof item.meta.assetType === "string" && item.meta.assetType.toUpperCase() === "PERP";
  return assetClass === "perps" ? isPerp : !isPerp;
}

/**
 * Normalize an author display name into a stable follow key: lowercased,
 * trimmed, internal whitespace collapsed. Returns null for empty/"Unknown"
 * authors (nothing followable). Pure + exported so the follow set can be keyed
 * identically on the client.
 */
export function normalizeAuthorKey(authorName: string | null | undefined): string | null {
  if (!authorName) return null;
  const normalized = authorName.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || normalized === "unknown") return null;
  return normalized;
}

/** Compatibility keys for one signal, including the immutable identity key. */
export function signalAuthorFollowKeys(
  metadata: unknown,
  allMetadata: readonly unknown[] = [metadata],
  source?: string | null,
): string[] {
  const author = deriveAuthor(metadata, source);
  if (author.identityKind === "relay") return [];
  const observations = allMetadata
    .map((candidate) => {
      if (
        candidate &&
        typeof candidate === "object" &&
        "metadata" in candidate
      ) {
        const row = candidate as { metadata?: unknown; source?: unknown };
        return deriveAuthor(
          row.metadata,
          typeof row.source === "string" ? row.source : null,
        );
      }
      return deriveAuthor(candidate);
    })
    .filter(
      (candidate): candidate is typeof candidate & { canonicalAuthorKey: string } =>
        Boolean(candidate.canonicalAuthorKey),
    )
    .map((candidate) => ({
      source: candidate.source ?? canonicalAuthorSource(candidate.canonicalAuthorKey),
      canonicalKey: candidate.canonicalAuthorKey,
      aliases: [
        ...candidate.authorAliases,
        ...candidate.authorAliasHistory,
        normalizeAuthorAlias(candidate.authorName),
      ].filter((alias): alias is string => alias !== null),
    }));
  const aliases = [...new Set([
    ...author.authorAliases,
    ...author.authorAliasHistory,
    normalizeAuthorAlias(author.authorName),
  ])].filter((alias): alias is string => alias !== null);
  const scopedSource = author.source ?? canonicalAuthorSource(author.canonicalAuthorKey);
  const compatibilityKeys: string[] = [];
  for (const alias of aliases) {
    const normalizedAlias = normalizeAuthorAlias(alias);
    if (!normalizedAlias) continue;
    const ownerKeys = new Set(
      observations
        .filter((observation) => observation.source === scopedSource)
        .filter((observation) => observation.aliases.some(
          (candidate) => normalizeAuthorAlias(candidate) === normalizedAlias,
        ))
        .map((observation) => observation.canonicalKey),
    );
    if (ownerKeys.size > 1) continue;
    if (author.canonicalAuthorKey) {
      if (ownerKeys.size !== 1 || !ownerKeys.has(author.canonicalAuthorKey)) continue;
    } else if (ownerKeys.size === 1) {
      compatibilityKeys.push([...ownerKeys][0]!);
    }
    const scopedAliasKey = scopedSource
      ? sourceAuthorAliasKey(scopedSource, normalizedAlias)
      : normalizedAlias;
    if (scopedAliasKey) compatibilityKeys.push(scopedAliasKey);
  }
  const fallback = normalizeAuthorKey(author.authorName);
  return [
    ...(author.canonicalAuthorKey ? [author.canonicalAuthorKey] : []),
    ...compatibilityKeys,
    ...(!scopedSource && fallback ? [fallback] : []),
  ].filter((key, index, keys) => keys.indexOf(key) === index);
}

/** Normalize legacy ordinary short actions for feed display only. */
function displayTradeAction(
  action: string | null | undefined,
  direction: string | null | undefined,
): string | null | undefined {
  if (direction === "short" && action === "Buy") return "BuyToCover";
  if (direction === "short" && action === "Sell") return "SellShort";
  return action;
}

/** Stable Set key for a follow target / follow row: "type|key". */
export function followSetKey(type: FollowTargetType, key: string): string {
  return `${type}|${key}`;
}

/** Expand canonical follows with only unambiguous durable historical aliases. */
async function expandFollowSetWithCanonicalAliases(
  db: PoolDb,
  follows: readonly { targetType: string; targetKey: string }[],
  followSet: Set<string>,
): Promise<void> {
  const canonicalKeys = follows
    .filter((follow) => follow.targetType === "x_author" && isCanonicalAuthorKey(follow.targetKey))
    .map((follow) => follow.targetKey);
  const legacyAliases = follows
    .filter((follow) =>
      follow.targetType === "x_author" &&
      !isCanonicalAuthorKey(follow.targetKey) &&
      !parseSourceAuthorAliasKey(follow.targetKey),
    )
    .map((follow) => normalizeAuthorAlias(follow.targetKey))
    .filter((alias): alias is string => alias !== null);
  const sourceAliases = follows
    .filter((follow) => follow.targetType === "x_author")
    .map((follow) => parseSourceAuthorAliasKey(follow.targetKey))
    .filter((value): value is { source: string; alias: string } => value !== null);
  const conditions: SQL[] = [];
  if (canonicalKeys.length > 0) {
    conditions.push(inArray(schema.sourceAuthorIdentities.canonicalKey, canonicalKeys));
  }
  if (legacyAliases.length > 0) {
    conditions.push(inArray(schema.sourceAuthorAliases.alias, legacyAliases));
  }
  for (const sourceAlias of sourceAliases) {
    conditions.push(and(
      eq(schema.sourceAuthorAliases.source, sourceAlias.source),
      eq(schema.sourceAuthorAliases.alias, sourceAlias.alias),
    )!);
  }
  if (conditions.length === 0) return;

  try {
    const query = db
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
      .where(or(...conditions));
    const rows = await query.limit(COPY_FEED_ALIAS_SCAN_CAP + 1);
    if (rows.length > COPY_FEED_ALIAS_SCAN_CAP) {
      logger.warn("copy-trade", "Historical alias expansion exceeded its safety cap", {
        cap: COPY_FEED_ALIAS_SCAN_CAP,
      });
      return;
    }

    const ownersByAlias = new Map<string, Set<string>>();
    const ownersByPlainAlias = new Map<string, Set<string>>();
    const sourceByCanonical = new Map<string, string>();
    const aliasesByCanonical = new Map<string, Set<string>>();
    for (const row of rows) {
      const alias = normalizeAuthorAlias(row.alias);
      if (!alias || !isCanonicalAuthorKey(row.canonicalKey)) continue;
      const source = row.source ?? canonicalAuthorSource(row.canonicalKey);
      if (!source) continue;
      const scopedKey = `${source}\u0000${alias}`;
      const owners = ownersByAlias.get(scopedKey) ?? new Set<string>();
      owners.add(row.canonicalKey);
      ownersByAlias.set(scopedKey, owners);
      const plainOwners = ownersByPlainAlias.get(alias) ?? new Set<string>();
      plainOwners.add(row.canonicalKey);
      ownersByPlainAlias.set(alias, plainOwners);
      sourceByCanonical.set(row.canonicalKey, source);
      const aliases = aliasesByCanonical.get(row.canonicalKey) ?? new Set<string>();
      const scopedAliasKey = sourceAuthorAliasKey(source, alias);
      if (scopedAliasKey) aliases.add(scopedAliasKey);
      aliasesByCanonical.set(row.canonicalKey, aliases);
    }

    for (const follow of follows) {
      if (follow.targetType !== "x_author") continue;
      if (isCanonicalAuthorKey(follow.targetKey)) {
        for (const alias of aliasesByCanonical.get(follow.targetKey) ?? []) {
          const parsed = parseSourceAuthorAliasKey(alias);
          const source = parsed?.source ?? sourceByCanonical.get(follow.targetKey);
          const normalizedAlias = parsed?.alias ?? normalizeAuthorAlias(alias);
          if (
            source &&
            normalizedAlias &&
            ownersByAlias.get(`${source}\u0000${normalizedAlias}`)?.size === 1
          ) {
            followSet.add(followSetKey("x_author", alias));
          }
        }
        continue;
      }
      const sourceAlias = parseSourceAuthorAliasKey(follow.targetKey);
      if (sourceAlias) {
        const owners = ownersByAlias.get(`${sourceAlias.source}\u0000${sourceAlias.alias}`);
        if (owners?.size === 1) followSet.add(followSetKey("x_author", [...owners][0]!));
        continue;
      }
      const alias = normalizeAuthorAlias(follow.targetKey);
      const owners = alias ? ownersByPlainAlias.get(alias) : undefined;
      if (owners?.size === 1) {
        const owner = [...owners][0]!;
        followSet.add(followSetKey("x_author", owner));
        const source = sourceByCanonical.get(owner);
        if (source && alias) {
          const scopedAliasKey = sourceAuthorAliasKey(source, alias);
          if (scopedAliasKey) {
            followSet.add(followSetKey("x_author", scopedAliasKey));
          }
        }
      }
    }
  } catch (error) {
    // The compatibility expansion is additive. A missing migration or a
    // transient lookup failure must not turn a healthy legacy follow set into
    // a failed feed, and it must not cause an unsafe name-based merge.
    logger.warn("copy-trade", "Could not expand historical author aliases", { error });
  }
}

/** Read the bounded follow set with the same stable keyset used by listPage. */
async function readFollowRowsForFeed(
  db: PoolDb,
  userId: string,
): Promise<{ targetType: string; targetKey: string }[]> {
  const rows: { targetType: string; targetKey: string }[] = [];
  let cursor: { createdAt: Date; id: string } | null = null;
  while (true) {
    const conditions: SQL[] = [eq(schema.copyTradeFollows.followerUserId, userId)];
    if (cursor) {
      const createdAtKey = millisecondTimestamp(schema.copyTradeFollows.createdAt);
      conditions.push(
        or(
          lt(createdAtKey, cursor.createdAt),
          and(
            eq(createdAtKey, cursor.createdAt),
            lt(schema.copyTradeFollows.id, cursor.id),
          ),
        )!,
      );
    }
    const page = await db
      .select({
        id: schema.copyTradeFollows.id,
        targetType: schema.copyTradeFollows.targetType,
        targetKey: schema.copyTradeFollows.targetKey,
        createdAt: schema.copyTradeFollows.createdAt,
      })
      .from(schema.copyTradeFollows)
      .where(and(...conditions)!)
      .orderBy(
        desc(millisecondTimestamp(schema.copyTradeFollows.createdAt)),
        desc(schema.copyTradeFollows.id),
      )
      .limit(COPY_FEED_FOLLOW_PAGE_SIZE);
    rows.push(...page.map(({ targetType, targetKey }) => ({ targetType, targetKey })));
    if (page.length < COPY_FEED_FOLLOW_PAGE_SIZE) return rows;
    const last = page.at(-1);
    if (!last?.createdAt || !last.id) throw new Error("follow feed page ended without a cursor");
    const createdAt = millisecondTimestampValue(last.createdAt);
    if (!createdAt) throw new Error("follow feed page ended with an invalid cursor");
    const next = { createdAt, id: last.id };
    if (
      cursor &&
      (next.createdAt > cursor.createdAt ||
        (next.createdAt.getTime() === cursor.createdAt.getTime() && next.id >= cursor.id))
    ) {
      throw new Error("follow feed page did not advance");
    }
    cursor = next;
  }
}

// ============================================
// Pure, side-effect-free helpers (DB-free; unit-testable)
// ============================================

/** Encode a cursor as base64 JSON. Old callers still get the original two fields. */
export function encodeCursor(cursor: FeedCursor): string {
  const normalized = canonicalCursorPoint(cursor);
  if (!normalized) throw new Error("Cannot encode an invalid feed cursor timestamp");
  const payload = {
    ts: normalized.ts,
    id: normalized.id,
    ...(cursor.sourceCursors && Object.keys(cursor.sourceCursors).length > 0
      ? {
          sourceCursors: Object.fromEntries(
            Object.entries(cursor.sourceCursors).map(([source, value]) => [
              source,
              value ? canonicalCursorPoint(value) : null,
            ]),
          ) as SourceCursorMap,
        }
      : {}),
    ...(cursor.retrySources && cursor.retrySources.length > 0
      ? { retrySources: cursor.retrySources }
      : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function isCursorPoint(value: unknown): value is CursorPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as { ts?: unknown; id?: unknown };
  return typeof point.ts === "string" &&
    typeof point.id === "string" &&
    !Number.isNaN(new Date(point.ts).getTime());
}

/** Decode a base64 JSON cursor. Returns null for null/undefined/malformed input. */
export function decodeCursor(s: string | null | undefined): FeedCursor | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as unknown;
    if (!isCursorPoint(parsed)) return null;
    const { ts: rawTs, id } = parsed;
    const ts = canonicalFeedTimestamp(rawTs);
    if (!ts) return null;
    const rawSourceCursors = (parsed as { sourceCursors?: unknown }).sourceCursors;
    if (
      rawSourceCursors !== undefined &&
      (!rawSourceCursors || typeof rawSourceCursors !== "object" || Array.isArray(rawSourceCursors))
    ) {
      return null;
    }

    const sourceCursors: SourceCursorMap = {};
    if (rawSourceCursors !== undefined) {
      for (const [source, value] of Object.entries(rawSourceCursors)) {
        if (source !== "x_signal" && source !== "user" && source !== "politician") return null;
        if (value !== null && !isCursorPoint(value)) return null;
        sourceCursors[source] = value === null ? null : canonicalCursorPoint(value);
        if (value !== null && sourceCursors[source] === null) return null;
      }
    }
    const rawRetrySources = (parsed as { retrySources?: unknown }).retrySources;
    let retrySources: CopyTradeSource[] | undefined;
    if (rawRetrySources !== undefined) {
      if (!Array.isArray(rawRetrySources)) return null;
      retrySources = [];
      for (const source of rawRetrySources) {
        if (
          (source !== "x_signal" && source !== "user" && source !== "politician") ||
          retrySources.includes(source)
        ) return null;
        retrySources.push(source);
      }
    }
    return Object.keys(sourceCursors).length > 0 || (retrySources?.length ?? 0) > 0
      ? {
          ts,
          id,
          ...(Object.keys(sourceCursors).length > 0 ? { sourceCursors } : {}),
          ...(retrySources && retrySources.length > 0 ? { retrySources } : {}),
        }
      : { ts, id };
  } catch {
    return null;
  }
}

/** Shape of a signals row this mapper needs (a subset of schema.signals.$inferSelect). */
interface SignalRowLike {
  id: string;
  source?: string | null;
  symbol: string | null;
  content: string | null;
  url: string | null;
  timestamp: Date | string | null;
  metadata: unknown;
}

function signalMetadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Map a tweet-derived signal row onto the normalized CopyTradeItem contract. */
export function mapSignalToItem(row: SignalRowLike): CopyTradeItem {
  const author = deriveAuthor(row.metadata, row.source);
  const { authorName, authorAvatar } = author;
  const authorKey = author.identityKind === "relay"
    ? null
    : author.canonicalAuthorKey ?? (
        author.source ?? row.source
          ? sourceAuthorAliasKey(author.source ?? row.source, normalizeAuthorKey(authorName))
          : normalizeAuthorKey(authorName)
      );
  // Classify the stored metadata before parsing prose. A structured PERP (or a
  // surviving perp-only hint such as hlTicker/leverage) is authoritative: an
  // option-looking phrase in the post must not turn a leveraged market row into
  // an Alpaca option order.
  const instrument = classifySignalInstrument(row.metadata, row.content);
  const signalMeta = signalMetadataRecord(row.metadata);
  const isStructuredPerp =
    instrument.perpVenue || instrument.perpInstrument || instrument.perpHint;
  const hasUnrecognizedStructuredMetadata = instrument.unrecognizedShape;
  const optionParse = parseOptionSignal(row.content, {
    symbolHint: row.symbol,
    referenceDate: row.timestamp,
  });
  const optionMeta =
    !isStructuredPerp && !hasUnrecognizedStructuredMetadata && optionParse.kind === "option"
      ? {
          assetType: optionParse.option.assetType,
          optionExpiration: optionParse.option.optionExpiration,
          optionStrike: optionParse.option.optionStrike,
          optionType: optionParse.option.optionType,
          tradeAction: optionParse.option.tradeAction,
        }
      : !isStructuredPerp && !hasUnrecognizedStructuredMetadata && optionParse.kind === "unsupported"
        ? {
            instrumentParseStatus: "unsupported",
            instrumentParseReason: optionParse.reason,
          }
        : {};

  // Honor the stored venue/instrument/direction for non-option signals. A short
  // surfaces as side "sell" (not a forced "buy"), and a perp/derivatives row is
  // marked so it does not read as a plain equity buy. Legacy signals with none of
  // these fields classify as a mirrorable equity long (side "buy", no extra meta),
  // so existing feed output is unchanged.
  // Content too: a free-text perp or short call carries no instrument metadata,
  // and without the prose check manual Copy would prefill an equity ticket from
  // it, the same defect the auto-mirror worker had.
  const perpCoin = isStructuredPerp
    ? parseCanonicalPerpCoin(signalMeta?.hlTicker)
    : null;
  const rawPerpLeverage = isStructuredPerp
    ? parseStrictFiniteNumber(signalMeta?.leverage as string | number | null | undefined)
    : null;
  const perpLeverage = rawPerpLeverage !== null && rawPerpLeverage > 0
    ? Math.round(rawPerpLeverage)
    : null;
  const perpMeta = isStructuredPerp
    ? {
        assetType: "PERP",
        perpVenue: instrument.platform,
        ...(perpCoin ? { perpCoin } : {}),
        perpDirection: instrument.short ? "short" : "long",
        ...(perpLeverage !== null ? { perpLeverage } : {}),
        perpReduceOnly: false,
      }
    : {};
  const instrumentMeta =
    !hasUnrecognizedStructuredMetadata &&
    ((!isStructuredPerp && optionParse.kind === "option") ||
      instrument.mirrorableEquityLong)
      ? {}
      : {
          platform: instrument.platform,
          instrument: instrument.instrument,
          direction: instrument.direction,
          // Not a plain equity long: consumers must not treat this as an equity buy.
          mirrorableEquity: false,
          ...(hasUnrecognizedStructuredMetadata
            ? {
                instrumentParseStatus: "unsupported",
                instrumentParseReason: "unrecognized structured signal metadata",
              }
            : {}),
        };

  return {
    source: "x_signal",
    id: `x_signal:${row.id}`,
    symbol:
      !isStructuredPerp && optionParse.kind === "option"
        ? optionParse.option.symbol
        : (row.symbol ?? "").toUpperCase(),
    side: !isStructuredPerp && optionParse.kind === "option"
      ? optionParse.option.side
      : instrument.side,
    displayName: authorName,
    avatar: authorAvatar,
    timestamp: new Date(row.timestamp ?? Date.now()).toISOString(),
    content: row.content ?? null,
    url: row.url ?? null,
    // No followable handle for an "Unknown"/empty author (normalizeAuthorKey -> null).
    followTarget: authorKey ? { type: "x_author", key: authorKey, label: authorName } : null,
    meta: { signalId: row.id, ...optionMeta, ...instrumentMeta, ...perpMeta },
  };
}

/** Shape of the joined user-trade row this mapper needs. */
interface UserTradeRowLike {
  id: string;
  userId: string;
  userName?: string | null;
  userTwitterName?: string | null;
  userUsername?: string | null;
  userImage?: string | null;
  twitterLinked?: boolean | null;
  symbol: string | null;
  orderSymbol?: string | null;
  side: string | null;
  qty: number | null;
  executedSizeDecimal?: string | null;
  orderType: string | null;
  assetType: string | null;
  orderAssetType?: string | null;
  limitPrice: string | null;
  fillPrice: string | null;
  optionExpiration?: string | null;
  optionStrike?: string | number | null;
  optionType?: string | null;
  tradeAction?: string | null;
  direction?: string | null;
  orderId?: string | null;
  createdAt: Date | string | null;
  copySourceLabel?: string | null;
  /** Perp facts, all from the joined `orders` row. Optional/nullable because a
   * missed join (L-11's fan-out, or a legacy row) leaves them absent - see the
   * fail-closed defaults in perpMeta below, none of these are ever guessed. */
  orderDirection?: string | null;
  orderLeverage?: number | null;
  orderReduceOnly?: boolean | null;
  orderVenue?: string | null;
}

/**
 * Map an anonymized shared user trade onto the normalized contract.
 * `anonymize` derives a stable pseudonym + avatar from the real user id so the
 * real identity never leaves the server.
 */
export function mapUserTradeToItem(
  row: UserTradeRowLike,
  anonymize: (userId: string) => { traderName: string; traderImage: string },
): CopyTradeItem | null {
  const resolvedAssetType = row.orderAssetType;
  const resolvedSymbol = row.orderSymbol;
  const resolvedTradeAction = displayTradeAction(row.tradeAction, row.direction);
  const actionSide = tradeActionSide(resolvedTradeAction);
  if (
    !row.orderId ||
    !resolvedAssetType ||
    !resolvedSymbol ||
    !resolvedTradeAction ||
    !row.direction ||
    !actionSide ||
    tradeActionDirection(resolvedTradeAction) !== row.direction
  ) return null;

  const { traderName, traderImage } = row.twitterLinked
    ? resolveTraderIdentity(row.userId, {
        twitterLinked: true,
        name: row.userName,
        twitterName: row.userTwitterName,
        username: row.userUsername,
        image: row.userImage,
      })
    : anonymize(row.userId);
  const exactPerpQty =
    resolvedAssetType === "PERP" && row.executedSizeDecimal
      ? parseStrictFiniteNumber(row.executedSizeDecimal)
      : null;
  const resolvedQty = exactPerpQty !== null && exactPerpQty > 0
    ? exactPerpQty
    : row.qty;
  const optionStrike =
    row.optionStrike === null || row.optionStrike === undefined
      ? null
      : typeof row.optionStrike === "number"
        ? row.optionStrike
        : parseStrictFiniteNumber(row.optionStrike);
  if (
    resolvedAssetType === "OPTION" &&
    !isValidOptionContractIdentity({
      optionExpiration: row.optionExpiration,
      optionStrike,
      optionType: row.optionType,
    })
  ) return null;
  const optionMeta =
    resolvedAssetType === "OPTION"
      ? {
          optionExpiration: row.optionExpiration ?? null,
          optionStrike: Number.isFinite(optionStrike) ? optionStrike : null,
          optionType: row.optionType ?? null,
          tradeAction: resolvedTradeAction,
        }
      : {};
  const actionMeta = { tradeAction: resolvedTradeAction, direction: row.direction };

  // A Hyperliquid perp fill is not a mirrorable equity long. It reaches the feed
  // as a bare ticker whose long open maps to side "buy", i.e. byte-for-byte an
  // equity buy to every consumer. mapSignalToItem already vetoes perp rows via
  // classifySignalInstrument, but that veto only ever covered x_signal rows, so
  // real fills arrived unmarked. The tickers genuinely collide (SOL is ReneSola
  // on Nasdaq, APT collides too), so an unmarked perp row prefills a stock
  // ticket for a different company in a different asset class.
  //
  // mirrorableEquity is the ONLY field the equity veto (copyDisabledReason)
  // reads, and it is unconditional: every field added below is additive, for a
  // SEPARATE client-side decision (can this row prefill the PERP ticket
  // instead) that must never be able to loosen the equity veto above it.
  //
  //   - perpCoin: parsed with the SAME validator the auto-mirror worker uses on
  //     this exact join (parseCanonicalPerpCoin), omitted when the symbol isn't
  //     HL-resolvable. Never reconstructed from the uppercased `item.symbol`:
  //     that charset cannot express "kPEPE" (becomes the unknown coin "KPEPE")
  //     or a HIP-3 route like "xyz:GOOGL" (becomes the bare, DIFFERENT market
  //     "GOOGL").
  //   - perpDirection: carried verbatim from orders.direction, never derived
  //     from `side`. The two agree today (toPerpOrderRow sets both from the
  //     same isLong), but direction is the perp-specific column every other
  //     consumer of this join (the worker) already trusts, so keep the two
  //     paths reading the same source.
  //   - perpLeverage: omitted (never defaulted to 1) when the row carries none.
  //     A missing leverage on a client copy path must read as "unknown", not as
  //     "1x" - a false 1x would silently overwrite whatever the user's form
  //     already holds.
  //   - perpReduceOnly: fails closed to `true` (treated as a position close,
  //     which the client route refuses to copy) when the orders join is
  //     missing, exactly like perpDirection/perpLeverage staying absent.
  //   - perpVenue: lets the client require "hyperliquid" the same way
  //     `copy-mirror-candidate-sources.ts` does before trusting anything else
  //     on the row.
  const perpCoin =
    resolvedAssetType === "PERP" ? parseCanonicalPerpCoin(resolvedSymbol) : null;
  const perpDirection =
    resolvedAssetType === "PERP" &&
    (row.orderDirection === "long" || row.orderDirection === "short")
      ? row.orderDirection
      : null;
  const perpLeverage =
    resolvedAssetType === "PERP" &&
    typeof row.orderLeverage === "number" &&
    Number.isFinite(row.orderLeverage) &&
    row.orderLeverage > 0
      ? Math.round(row.orderLeverage)
      : null;
  const perpMeta =
    resolvedAssetType === "PERP"
      ? {
          mirrorableEquity: false,
          ...(perpCoin ? { perpCoin } : {}),
          ...(perpDirection ? { perpDirection } : {}),
          ...(perpLeverage !== null ? { perpLeverage } : {}),
          perpReduceOnly: row.orderReduceOnly === false ? false : true,
          perpVenue: row.orderVenue ?? null,
        }
      : {};

  return {
    source: "user",
    id: `user:${row.id}`,
    symbol: resolvedSymbol.toUpperCase(),
    side: actionSide,
    displayName: traderName,
    avatar: traderImage,
    timestamp: new Date(row.createdAt ?? Date.now()).toISOString(),
    content: null,
    url: null,
    // Key off a one-way hash of the user id — the raw user id never leaves the server.
    followTarget: { type: "user", key: traderKey(row.userId), label: traderName },
    meta: {
      qty: resolvedQty,
      orderType: row.orderType,
      fillPrice: parseStrictFiniteNumber(row.fillPrice),
      limitPrice: parseStrictFiniteNumber(row.limitPrice),
      assetType: resolvedAssetType,
      copiedFrom: row.copySourceLabel ?? null,
      orderId: row.orderId,
      ...actionMeta,
      ...optionMeta,
      ...perpMeta,
    },
  };
}

interface JoinedUserTradeInstrument {
  id: string;
  orderSymbol?: unknown;
  orderAssetType?: unknown;
  tradeAction?: unknown;
  direction?: unknown;
  optionExpiration?: unknown;
  optionStrike?: unknown;
  optionType?: unknown;
  // Perp discriminators. Optional like the rest, so an equity-only caller (and
  // every existing fixture) still satisfies the constraint with them absent.
  orderDirection?: unknown;
  orderLeverage?: unknown;
  orderReduceOnly?: unknown;
  orderVenue?: unknown;
}

export function collapseUserTradeRows<T extends JoinedUserTradeInstrument>(
  rawRows: readonly T[],
): T[] {
  const grouped = new Map<string, T[]>();
  for (const row of rawRows) {
    const group = grouped.get(row.id) ?? [];
    group.push(row);
    grouped.set(row.id, group);
  }

  const rows: T[] = [];
  for (const group of grouped.values()) {
    const instrumentFingerprints = new Set(
      group.map((row) =>
        JSON.stringify([
          row.orderSymbol ?? null,
          row.orderAssetType ?? null,
          row.tradeAction ?? null,
          row.direction ?? null,
          row.optionExpiration ?? null,
          row.optionStrike ?? null,
          row.optionType ?? null,
          // The perp fields belong in the fingerprint now that the copy button
          // reads them. `broker_order_id` is not unique (see the L-11 note on the
          // user-trade join below), so a fan-out on the same coin used to resolve
          // to group[0] arbitrarily. That only mis-displayed a fill price before;
          // it can now hand the Copy button the wrong direction, the wrong
          // leverage, or present a reduce-only CLOSE as a copyable OPEN.
          //
          // Adding them is strictly stricter: a group where they all agree (or are
          // all absent, as on every equity row) still collapses exactly as before.
          // A group where they disagree is now dropped rather than guessed at,
          // which is the same fail-closed choice the rest of this path makes.
          row.orderDirection ?? null,
          row.orderLeverage ?? null,
          row.orderReduceOnly ?? null,
          row.orderVenue ?? null,
        ]),
      ),
    );
    if (instrumentFingerprints.size === 1) rows.push(group[0]!);
  }
  return rows;
}

/** A (timestamp, id) keyset point — the merge/sort/cursor ordering key. */
export interface CursorPoint {
  ts: string;
  id: string;
}

/** Independent raw keyset state for each source in a merged page. */
export type SourceCursorMap = Partial<Record<CopyTradeSource, CursorPoint | null>>;

export interface FeedCursor extends CursorPoint {
  sourceCursors?: SourceCursorMap;
  /** Sources that failed on the page which produced this cursor. */
  retrySources?: CopyTradeSource[];
}

function rawSourceId(source: CopyTradeSource, cursor: CursorPoint): string | null {
  const prefix = `${source}:`;
  return cursor.id.startsWith(prefix) ? cursor.id.slice(prefix.length) : null;
}

function sourceKeysetBefore(
  source: CopyTradeSource,
  timestampColumn: SQLWrapper,
  idColumn: SQLWrapper,
  cursor: CursorPoint | null,
): SQL | null {
  if (!cursor) return null;
  const timestamp = millisecondTimestampValue(cursor.ts);
  const id = rawSourceId(source, cursor);
  if (!timestamp || !id) return null;
  const timestampKey = millisecondTimestamp(timestampColumn);
  return or(
    lt(timestampKey, timestamp),
    and(eq(timestampKey, timestamp), lt(idColumn, id)),
  )!;
}

function sourceHighWaterAtOrBefore(
  source: CopyTradeSource,
  timestampColumn: SQLWrapper,
  idColumn: SQLWrapper,
  highWater: CursorPoint,
): SQL | null {
  const timestamp = millisecondTimestampValue(highWater.ts);
  const id = rawSourceId(source, highWater);
  if (!timestamp || !id) return null;
  const timestampKey = millisecondTimestamp(timestampColumn);
  return or(
    lt(timestampKey, timestamp),
    and(eq(timestampKey, timestamp), lte(idColumn, id)),
  )!;
}

function canonicalFeedTimestamp(value: Date | string): string | null {
  return millisecondTimestampValue(value)?.toISOString() ?? null;
}

function canonicalCursorPoint(point: CursorPoint): CursorPoint | null {
  const ts = canonicalFeedTimestamp(point.ts);
  return ts ? { ts, id: point.id } : null;
}

// A retry-only page can have no visible row, no source floor, and no incoming
// cursor. Keep the legacy top-level (ts,id) cursor shape, but anchor it at a
// stable point newer than any practical feed row. Per-source null cursors carry
// the real recovery state, so this sentinel cannot skip rows when a source
// recovers on the next request.
const FIRST_PAGE_RETRY_CURSOR: CursorPoint = {
  ts: "9999-12-31T23:59:59.999Z",
  id: "__retry__",
};

/** Convert the oldest row in a full raw user batch into the feed cursor space. */
export function rawUserBatchBoundary(
  rows: readonly { id: string; createdAt: Date | string | null }[],
): CursorPoint | null {
  const oldest = rows[rows.length - 1];
  if (!oldest || oldest.createdAt === null) return null;
  const timestamp = canonicalFeedTimestamp(oldest.createdAt);
  return timestamp ? { ts: timestamp, id: `user:${oldest.id}` } : null;
}

/** True when point `a` is strictly OLDER than `b` in the newest-first order. */
function isOlder(a: CursorPoint, b: CursorPoint): boolean {
  const aTs = canonicalFeedTimestamp(a.ts);
  const bTs = canonicalFeedTimestamp(b.ts);
  if (!aTs || !bTs) return false;
  return aTs < bTs || (aTs === bTs && a.id < b.id);
}

/**
 * The deepest (oldest) cursor we can safely page to without skipping any row
 * from a source whose raw batch was FULL.
 *
 * A source whose raw batch was NOT full is exhausted within the window and
 * imposes no lower bound. For a source whose raw batch WAS full, we only fetched
 * down to its oldest raw row, so anything older than that row is unseen — a
 * cursor older than that boundary would skip those unseen rows (the exact H-3
 * "Following dead-end": the followed row could live in the skipped gap). The
 * safe cursor is therefore the NEWEST of the full sources' oldest-raw boundaries
 * (the shallowest depth that is fully covered across every full source). Returns
 * null when no source was full (nothing more to page).
 */
export function fullSourceFloorCursor(rawBoundaries: (CursorPoint | null)[]): CursorPoint | null {
  let floor: CursorPoint | null = null;
  for (const b of rawBoundaries) {
    if (!b) continue;
    // Keep the NEWEST boundary: a cursor must be >= every full source's oldest
    // raw row to avoid skipping that source's unfetched older rows.
    if (floor === null || isOlder(floor, b)) floor = b;
  }
  return floor;
}

/**
 * Concat per-source item arrays, sort newest-first (timestamp desc, tie-break
 * by id desc for a stable total order), and slice to `limit`.
 */
export function mergeItems(itemArrays: CopyTradeItem[][], limit: number): CopyTradeItem[] {
  const merged = itemArrays.flat();
  merged.sort((a, b) => {
    const aTimestamp = canonicalFeedTimestamp(a.timestamp) ?? "";
    const bTimestamp = canonicalFeedTimestamp(b.timestamp) ?? "";
    if (aTimestamp !== bTimestamp) return aTimestamp < bTimestamp ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });
  return merged.slice(0, limit);
}

/**
 * Apply the compound (timestamp, id) cursor boundary, merge newest-first, slice
 * to `limit`, and compute the next cursor.
 *
 * The SQL layer and this merge use the same millisecond-normalized timestamp
 * plus id key. The in-memory cut remains necessary for legacy cursors and for
 * sources that were fetched together before the per-source SQL boundary.
 *
 * `anySourceFull` is true when any source returned a full `limit` batch, meaning
 * older rows may remain beyond the fetch window — so we still hand back a cursor
 * even when the merged page came up short. The source boundary carries the
 * oldest returned (millisecond, id) key, so a large tie cluster remains pageable.
 *
 * `followedFloorCursor` (H-3): in the "Following" view, items are filtered to
 * the user's follow set BEFORE this merge, so the newest `limit` raw rows can
 * contain NO followed items — yielding a 0-item page. If we terminated there
 * (nextCursor null), the Following view would dead-end even though OLDER followed
 * activity exists. When provided (only under followedOnly, and only when a raw
 * batch was full), it is the deepest safe (ts,id) we can page to; we return it as
 * the nextCursor even for a 0-item page so the client keeps paging into older
 * history. The non-followedOnly path is unchanged (this stays null there).
 */
export function buildPage(
  itemArrays: CopyTradeItem[][],
  cursor: FeedCursor | null,
  limit: number,
  anySourceFull: boolean,
  followedFloorCursor: CursorPoint | null = null,
  sourceBoundaries: (CursorPoint | null)[] = [],
  sourceKeys: CopyTradeSource[] = [],
  retrySources: CopyTradeSource[] = [],
): { items: CopyTradeItem[]; nextCursor: string | null } {
  const hasPerSourceState = sourceKeys.length > 0;
  const incomingRetrySourceSet = new Set(cursor?.retrySources ?? []);
  const retrySourceSet = new Set([...incomingRetrySourceSet, ...retrySources]);
  const outgoingRetrySourceSet = new Set(retrySources);
  const candidatesBySource = itemArrays.map((items, index) => {
    const source = sourceKeys[index];
    const hasExplicitSourceCursor = source !== undefined &&
      cursor?.sourceCursors !== undefined &&
      Object.prototype.hasOwnProperty.call(cursor.sourceCursors, source);
    const sourceFailed = source !== undefined && retrySourceSet.has(source);
    const sourceCursor = hasExplicitSourceCursor
      ? cursor!.sourceCursors![source] ?? null
      : cursor;
    if (sourceCursor === null && hasExplicitSourceCursor && !sourceFailed) return [];
    return items.filter((it) =>
      sourceCursor === null ||
      sourceCursor === undefined ||
      isOlder({ ts: it.timestamp, id: it.id }, sourceCursor),
    );
  });
  const items = mergeItems(candidatesBySource, limit);
  const last = items[items.length - 1];
  const sourceFloor = hasPerSourceState ? fullSourceFloorCursor(sourceBoundaries) : null;
  const more = items.length === limit ||
    (hasPerSourceState ? anySourceFull : anySourceFull && items.length > 0) ||
    retrySources.length > 0;
  const cursorPoint = last
    ? canonicalCursorPoint({ ts: last.timestamp, id: last.id })
    : sourceFloor ?? cursor ?? (retrySources.length > 0 ? FIRST_PAGE_RETRY_CURSOR : null);

  /**
   * A source cursor must never jump past a row that was fetched but lost the
   * merged page to another source. The old implementation always used the raw
   * batch boundary, which made a newer X page permanently hide older user
   * trades (and therefore older perp fills) on the next request.
   *
   * When at least one item from a source made the page, its oldest returned item
   * is the safe boundary. When none made the page but candidates were present,
   * preserve an existing source cursor; on the first page, use a synthetic
   * one-millisecond-ahead point so the next request can revisit every candidate
   * without treating the source as exhausted. Empty candidate arrays may still
   * advance to the raw boundary because every row inspected for that source was
   * filtered out or the source was exhausted.
   */
  const nextSourceCursor = (source: CopyTradeSource, index: number): CursorPoint | null => {
    if (outgoingRetrySourceSet.has(source)) {
      return cursor?.sourceCursors &&
        Object.prototype.hasOwnProperty.call(cursor.sourceCursors, source)
        ? cursor.sourceCursors[source] ?? null
        : cursor ?? null;
    }

    const returned = items.filter((item) => item.source === source);
    if (returned.length > 0) {
      const oldestReturned = returned[returned.length - 1];
      return oldestReturned
        ? canonicalCursorPoint({ ts: oldestReturned.timestamp, id: oldestReturned.id })
        : null;
    }

    const candidates = candidatesBySource[index] ?? [];
    if (candidates.length === 0) return sourceBoundaries[index] ?? null;

    const hasExplicitSourceCursor = cursor?.sourceCursors !== undefined &&
      Object.prototype.hasOwnProperty.call(cursor.sourceCursors, source);
    if (hasExplicitSourceCursor && cursor!.sourceCursors![source] !== null) {
      return cursor!.sourceCursors![source] ?? null;
    }

    const newest = candidates[0];
    const timestamp = newest ? millisecondTimestampValue(newest.timestamp) : null;
    if (!timestamp) return sourceBoundaries[index] ?? null;
    const nextMillisecond = timestamp.getTime() < 253402300799999
      ? new Date(timestamp.getTime() + 1).toISOString()
      : timestamp.toISOString();
    return { ts: nextMillisecond, id: `${source}:\uffff` };
  };

  const nextSourceCursors: SourceCursorMap | undefined = hasPerSourceState
    ? Object.fromEntries(sourceKeys.map((source, index) => [
        source,
        nextSourceCursor(source, index),
      ])) as SourceCursorMap
    : undefined;
  let nextCursor = more && cursorPoint
    ? encodeCursor({
        ...cursorPoint,
        ...(nextSourceCursors ? { sourceCursors: nextSourceCursors } : {}),
        ...(retrySources.length > 0 ? { retrySources } : {}),
      })
    : null;

  // H-3: don't dead-end the Following view. When a followed-filter page came up
  // SHORT but a raw batch was full, keep paging from the deepest safe raw
  // boundary — even when the page is empty (last is undefined). Guard for strict
  // forward progress so we never stall or page backwards:
  //   - the floor must be OLDER than the page's own last item (if any), and
  //   - OLDER than the incoming cursor, so a malformed source boundary cannot
  //     stall the client on the same compound key.
  if (!hasPerSourceState && followedFloorCursor && items.length < limit) {
    const olderThanLast =
      last === undefined || isOlder(followedFloorCursor, { ts: last.timestamp, id: last.id });
    const olderThanCursor = cursor === null || isOlder(followedFloorCursor, cursor);
    if (olderThanLast && olderThanCursor) {
      nextCursor = encodeCursor(followedFloorCursor);
    }
  }
  return { items, nextCursor };
}

// ============================================
// Router
// ============================================

export const copyTradeRouter = router({
  /** Unified private inbox for fills and actionable copy-trade failures. */
  recentNotifications: protectedProcedure.query(async ({ ctx }) => {
    const since = new Date(Date.now() - NOTIFICATION_LOOKBACK_MS);
    const [filledOrders, failures] = await Promise.all([
      ctx.db.query.orders.findMany({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.status, "FILLED"),
          gte(schema.orders.executedAt, since),
        ),
        columns: {
          id: true,
          symbol: true,
          tradeAction: true,
          executedQuantity: true,
          executedSizeDecimal: true,
          executedPrice: true,
          executedAt: true,
          notificationReadAt: true,
        },
        orderBy: [desc(schema.orders.executedAt)],
        limit: NOTIFICATION_LIMIT,
      }),
      ctx.db.query.copyMirrorDeliveries.findMany({
        where: and(
          eq(schema.copyMirrorDeliveries.followerUserId, ctx.userId),
          eq(schema.copyMirrorDeliveries.status, "completed"),
          eq(schema.copyMirrorDeliveries.outcome, "leverage-unconfirmed"),
          gte(schema.copyMirrorDeliveries.completedAt, since),
        ),
        columns: {
          id: true,
          candidate: true,
          completedAt: true,
          notificationReadAt: true,
        },
        orderBy: [desc(schema.copyMirrorDeliveries.completedAt)],
        limit: NOTIFICATION_LIMIT,
      }),
    ]);

    const notifications = [
      ...filledOrders.map((order) => ({
        kind: "fill" as const,
        id: order.id,
        symbol: order.symbol,
        occurredAt: order.executedAt?.toISOString() ?? null,
        readAt: order.notificationReadAt?.toISOString() ?? null,
        message: fillNotificationMessage(order),
      })),
      ...failures.map((row) => {
        const candidate = row.candidate as Record<string, unknown>;
        const symbol = typeof candidate.symbol === "string" ? candidate.symbol : "Perp";
        const sourceLabel = typeof candidate.copySourceLabel === "string"
          ? candidate.copySourceLabel
          : "a followed trader";
        const leverage = typeof candidate.perpLeverage === "number" && Number.isFinite(candidate.perpLeverage)
          ? candidate.perpLeverage
          : null;
        const marginMode = candidate.perpMarginMode === "cross" || candidate.perpMarginMode === "isolated"
          ? candidate.perpMarginMode
          : null;
        const setting = [leverage ? `${leverage}×` : null, marginMode].filter(Boolean).join(" ");
        return {
          kind: "copy_failure" as const,
          id: row.id,
          symbol,
          occurredAt: row.completedAt?.toISOString() ?? null,
          readAt: row.notificationReadAt?.toISOString() ?? null,
          message: `${symbol} copy from ${sourceLabel} was canceled. ` +
            `We couldn't confirm${setting ? ` ${setting}` : " the requested"} leverage with Hyperliquid, so no order was placed. Your funds were not affected.`,
        };
      }),
    ];

    return notifications
      .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""))
      .slice(0, NOTIFICATION_LIMIT);
  }),

  markNotificationRead: protectedProcedure
    .input(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("fill"), id: z.string().uuid() }),
      z.object({ kind: z.literal("copy_failure"), id: z.string().uuid() }),
    ]))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      if (input.kind === "fill") {
        const updated = await ctx.db
          .update(schema.orders)
          .set({ notificationReadAt: now, updatedAt: now })
          .where(and(
            eq(schema.orders.id, input.id),
            eq(schema.orders.userId, ctx.userId),
            eq(schema.orders.status, "FILLED"),
          ))
          .returning({ id: schema.orders.id });
        return { success: updated.length === 1 };
      }

      const updated = await ctx.db
        .update(schema.copyMirrorDeliveries)
        .set({ notificationReadAt: now, updatedAt: now })
        .where(and(
          eq(schema.copyMirrorDeliveries.id, input.id),
          eq(schema.copyMirrorDeliveries.followerUserId, ctx.userId),
          eq(schema.copyMirrorDeliveries.outcome, "leverage-unconfirmed"),
        ))
        .returning({ id: schema.copyMirrorDeliveries.id });
      return { success: updated.length === 1 };
    }),

  /** Marks every currently visible inbox notification as read for this user. */
  markAllNotificationsRead: protectedProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    const since = new Date(now.getTime() - NOTIFICATION_LOOKBACK_MS);
    const [filledOrders, failures] = await Promise.all([
      ctx.db
        .update(schema.orders)
        .set({ notificationReadAt: now, updatedAt: now })
        .where(and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.status, "FILLED"),
          gte(schema.orders.executedAt, since),
          isNull(schema.orders.notificationReadAt),
        ))
        .returning({ id: schema.orders.id }),
      ctx.db
        .update(schema.copyMirrorDeliveries)
        .set({ notificationReadAt: now, updatedAt: now })
        .where(and(
          eq(schema.copyMirrorDeliveries.followerUserId, ctx.userId),
          eq(schema.copyMirrorDeliveries.status, "completed"),
          eq(schema.copyMirrorDeliveries.outcome, "leverage-unconfirmed"),
          gte(schema.copyMirrorDeliveries.completedAt, since),
          isNull(schema.copyMirrorDeliveries.notificationReadAt),
        ))
        .returning({ id: schema.copyMirrorDeliveries.id }),
    ]);

    return { markedRead: filledOrders.length + failures.length };
  }),

  /**
   * Recent auto-mirror failures for this follower. The client persists seen
   * delivery ids locally, so a failure is announced once without exposing it
   * in the public Discord trade channel.
   */
  recentFailures: protectedProcedure.query(async ({ ctx }) => {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    const rows = await ctx.db.query.copyMirrorDeliveries.findMany({
      where: and(
        eq(schema.copyMirrorDeliveries.followerUserId, ctx.userId),
        eq(schema.copyMirrorDeliveries.status, "completed"),
        eq(schema.copyMirrorDeliveries.outcome, "leverage-unconfirmed"),
        gte(schema.copyMirrorDeliveries.completedAt, since),
      ),
      columns: {
        id: true,
        candidate: true,
        lastError: true,
        completedAt: true,
        notificationReadAt: true,
      },
      orderBy: [desc(schema.copyMirrorDeliveries.completedAt)],
      limit: 20,
    });

    return rows.map((row) => {
      const candidate = row.candidate as Record<string, unknown>;
      const symbol = typeof candidate.symbol === "string" ? candidate.symbol : "Perp";
      const sourceLabel =
        typeof candidate.copySourceLabel === "string"
          ? candidate.copySourceLabel
          : "a followed trader";
      const leverage =
        typeof candidate.perpLeverage === "number" && Number.isFinite(candidate.perpLeverage)
          ? candidate.perpLeverage
          : null;
      const marginMode =
        candidate.perpMarginMode === "cross" || candidate.perpMarginMode === "isolated"
          ? candidate.perpMarginMode
          : null;
      const setting = [leverage ? `${leverage}×` : null, marginMode]
        .filter(Boolean)
        .join(" ");
      return {
        id: row.id,
        symbol,
        sourceLabel,
        completedAt: row.completedAt?.toISOString() ?? null,
        readAt: row.notificationReadAt?.toISOString() ?? null,
        message:
          `${symbol} copy from ${sourceLabel} was canceled. ` +
          `We couldn't confirm${setting ? ` ${setting}` : " the requested"} leverage with Hyperliquid, so no order was placed. Your funds were not affected.`,
      };
    });
  }),

  markFailureRead: protectedProcedure
    .input(z.object({ deliveryId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const updated = await ctx.db
        .update(schema.copyMirrorDeliveries)
        .set({ notificationReadAt: now, updatedAt: now })
        .where(and(
          eq(schema.copyMirrorDeliveries.id, input.deliveryId),
          eq(schema.copyMirrorDeliveries.followerUserId, ctx.userId),
          eq(schema.copyMirrorDeliveries.outcome, "leverage-unconfirmed"),
        ))
        .returning({ id: schema.copyMirrorDeliveries.id });
      return { success: updated.length === 1 };
    }),

  /**
   * Unified, normalized copy-trade feed across the requested sources.
   * Paged newest-first by a (timestamp, id) base64 cursor; a non-null
   * nextCursor is only returned when the page was full (more may exist).
   */
  feed: protectedProcedure
    .input(
      z.object({
        sources: z
          .array(z.enum(["x_signal", "user", "politician"]))
          .min(1)
          .default(["x_signal", "user", "politician"]),
        symbol: z
          .string()
          .min(1)
          .max(10)
          .transform((v) => v.toUpperCase())
          .optional(),
        limit: z.number().int().min(1).max(50).default(30),
        cursor: z.string().nullish(),
        /** When true, restrict the feed to the current user's followed targets. */
        followedOnly: z.boolean().default(false),
        assetClass: z.enum(["all", "stocks", "perps"]).default("all"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const cursor = decodeCursor(input.cursor);
      const viewer = await ctx.db.query.users.findFirst({
        where: eq(schema.users.id, ctx.userId),
        columns: { name: true, username: true, email: true },
      });
      const maySeeShardi = viewer ? isProfessorUser(viewer) : false;

      // When the "Following" view is requested, load this user's follow set as
      // "type|key" strings so we can keep only items whose followTarget matches.
      // Guard the query so a missing table (pre db:push) degrades to "no follows"
      // — an empty Following feed — instead of a 500.
      let followSet: Set<string> | null = null;
      if (input.followedOnly) {
        followSet = new Set<string>();
        try {
          const follows = await readFollowRowsForFeed(ctx.db, ctx.userId);
          for (const f of follows) {
            followSet.add(followSetKey(f.targetType as FollowTargetType, f.targetKey));
          }
          await expandFollowSetWithCanonicalAliases(ctx.db, follows, followSet);
        } catch (err) {
          logger.error("copy-trade", "Failed to load follows; serving empty Following feed", {
            error: err,
          });
        }
      }

      /** Keep only items whose followTarget is in the loaded follow set. */
      const applyFollowFilter = (items: CopyTradeItem[]): CopyTradeItem[] => {
        if (!followSet) return items;
        const set = followSet;
        return items.filter(
          (it) => it.followTarget !== null && set.has(followSetKey(it.followTarget.type, it.followTarget.key)),
        );
      };
      const applyFeedFilters = (items: CopyTradeItem[]): CopyTradeItem[] =>
        applyFollowFilter(items).filter((item) =>
          copyTradeItemMatchesAssetClass(item, input.assetClass),
        );
      // Every newly paged source uses date_trunc('milliseconds', timestamp) in
      // SQL and the same millisecond key in the returned cursor. buildPage()
      // still applies the compound cut for legacy cursors and merged sources.
      let anySourceFull = false;
      const perSource: CopyTradeItem[][] = [];
      const sourceKeys: CopyTradeSource[] = [];
      // Audit M13: sources that threw. Surfaced to the client so a broken
      // source renders as a degraded state instead of silently-empty data.
      const failedSources: CopyTradeSource[] = [];
      // Per-source OLDEST raw (pre-filter) row, recorded ONLY when that source's
      // final scanned batch was full (== limit). Drives the next cursor when a
      // feed filter consumed an entire raw batch without yielding enough items.
      // A source whose final batch was short pushes null (it is exhausted).
      const rawBoundaries: (CursorPoint | null)[] = [];

      const hasExplicitSourceCursor = (source: CopyTradeSource): boolean =>
        cursor?.sourceCursors !== undefined &&
        Object.prototype.hasOwnProperty.call(cursor.sourceCursors, source);
      const sourceCursorFor = (source: CopyTradeSource): CursorPoint | null => {
        if (hasExplicitSourceCursor(source)) return cursor!.sourceCursors![source] ?? null;
        return cursor;
      };
      const sourceIsExhausted = (source: CopyTradeSource): boolean =>
        hasExplicitSourceCursor(source) &&
        sourceCursorFor(source) === null &&
        !cursor?.retrySources?.includes(source);
      // ---- x_signal: tweet-derived signals ----
      if (input.sources.includes("x_signal")) {
        if (sourceIsExhausted("x_signal")) {
          sourceKeys.push("x_signal");
          rawBoundaries.push(null);
          perSource.push([]);
        } else {
          try {
            const filteredRows: CopyTradeItem[] = [];
            let scanCursor = sourceCursorFor("x_signal");
            let scannedRawRows = 0;
            let lastBatchLength = 0;
            let lastBatchMapped: CopyTradeItem[] = [];
            let filteredPageBoundary: CursorPoint | null = null;

            // x_signal stores mixed equities/options/perps in one table. Scan
            // bounded raw batches so an asset-class (or Following) filter does
            // not turn a full page of non-matching rows into an apparent end of
            // feed. The cursor remains the deepest raw boundary actually read.
            while (scannedRawRows < COPY_FEED_X_SIGNAL_RAW_SCAN_CAP) {
              const conditions: SQL[] = [];
              const keyset = sourceKeysetBefore(
                "x_signal",
                schema.signals.timestamp,
                schema.signals.id,
                scanCursor,
              );
              if (keyset) conditions.push(keyset);
              if (input.symbol) conditions.push(eq(schema.signals.symbol, input.symbol));
              if (!maySeeShardi) conditions.push(not(shardiSignalCondition()));

              const rows = await ctx.db.query.signals.findMany({
                where: conditions.length > 0 ? and(...conditions) : undefined,
                orderBy: [
                  desc(millisecondTimestamp(schema.signals.timestamp)),
                  desc(schema.signals.id),
                ],
                limit: input.limit,
              });
              const mapped = rows.map((r) => mapSignalToItem(r));
              const followedMapped = followSet
                ? rows
                    .filter((row) =>
                      signalAuthorFollowKeys(
                        row.metadata,
                        rows.map((candidate) => ({
                          metadata: candidate.metadata,
                          source: candidate.source,
                        })),
                        row.source,
                      ).some((key) => followSet!.has(followSetKey("x_author", key))),
                    )
                    .map((row) => mapSignalToItem(row))
                : mapped;

              filteredRows.push(...applyFeedFilters(followedMapped));
              scannedRawRows += rows.length;
              lastBatchLength = rows.length;
              lastBatchMapped = mapped;

              if (filteredRows.length >= input.limit) {
                // The final raw batch can contain more matching rows than the
                // page has room for. Keep the source cursor at the last match
                // that will actually be returned; advancing to the raw batch's
                // oldest row would skip the surplus matching rows on page two.
                if (filteredRows.length > input.limit) {
                  const lastVisible = filteredRows[input.limit - 1];
                  filteredPageBoundary = lastVisible
                    ? { ts: lastVisible.timestamp, id: lastVisible.id }
                    : null;
                  filteredRows.splice(input.limit);
                }
                break;
              }
              if (rows.length < input.limit || rows.length === 0) {
                break;
              }

              // Rows are newest-first. Move the next raw batch behind the last
              // mapped row, preserving the same millisecond/tie-break cursor
              // space used by the outer feed pagination.
              const oldest = mapped[mapped.length - 1];
              if (!oldest) break;
              scanCursor = { ts: oldest.timestamp, id: oldest.id };
            }

            if (lastBatchLength === input.limit) {
              anySourceFull = true;
              const oldest = lastBatchMapped[lastBatchMapped.length - 1];
              rawBoundaries.push(
                filteredPageBoundary ??
                  (oldest ? { ts: oldest.timestamp, id: oldest.id } : null),
              );
            } else {
              rawBoundaries.push(null);
            }
            perSource.push(filteredRows);
            sourceKeys.push("x_signal");
          } catch (err) {
            failedSources.push("x_signal");
            sourceKeys.push("x_signal");
            rawBoundaries.push(sourceCursorFor("x_signal"));
            perSource.push([]);
            logger.error("copy-trade", "Failed to fetch x_signal source", { error: err });
          }
        }
      }

      // ---- user: anonymized shared trades ----
      if (input.sources.includes("user")) {
        if (sourceIsExhausted("user")) {
          sourceKeys.push("user");
          rawBoundaries.push(null);
          perSource.push([]);
        } else {
          try {
            const socialTrades = alias(schema.socialTrades, "copy_feed_social_trades");
            const orders = alias(schema.orders, "copy_feed_orders");
            const otherOrders = alias(schema.orders, "copy_feed_other_orders");
            const authoritativeOrderJoin = buildAuthoritativeOrderJoin(
              ctx.db,
              socialTrades,
              orders,
              otherOrders,
            );
            const userCursor = sourceCursorFor("user");
            const baseConditions: SQL[] = [];
            const keyset = sourceKeysetBefore(
              "user",
              socialTrades.createdAt,
              socialTrades.id,
              userCursor,
            );
            if (keyset) baseConditions.push(keyset);
            if (input.symbol) baseConditions.push(eq(socialTrades.symbol, input.symbol));
            baseConditions.push(validOptionContractCondition(orders));
            baseConditions.push(publiclyEligibleOrderCondition(ctx.db, orders));
            let userHighWater: CursorPoint | null = null;

            const selectUserRows = (offset: number, highWater: CursorPoint | null) => {
              const conditions = [...baseConditions];
              if (highWater) {
                const highWaterCondition = sourceHighWaterAtOrBefore(
                  "user",
                  socialTrades.createdAt,
                  socialTrades.id,
                  highWater,
                );
                if (highWaterCondition) conditions.push(highWaterCondition);
              }
              return ctx.db
              .select({
                id: socialTrades.id,
                userId: socialTrades.userId,
                userName: schema.users.name,
                userTwitterName: schema.users.twitterName,
                userUsername: schema.users.username,
                userImage: schema.users.image,
                twitterLinked: sql<boolean>`exists (
                  select 1 from ${schema.accounts}
                  where ${schema.accounts.userId} = ${socialTrades.userId}
                    and ${schema.accounts.providerId} = 'twitter'
                )`,
                symbol: socialTrades.symbol,
                // Return the authoritative local order even for an unambiguous
                // legacy social row whose order_id column is still null.
                orderId: orders.id,
                orderSymbol: orders.symbol,
                side: socialTrades.side,
                qty: socialTrades.qty,
                orderType: socialTrades.orderType,
                assetType: socialTrades.assetType,
                orderAssetType: orders.assetType,
                limitPrice: socialTrades.limitPrice,
                // Actual fill price reconciled into the orders table by the
                // OrderSyncPoller. Null until filled.
                fillPrice: orders.executedPrice,
                // social_trades.qty is an integer compatibility field. Perp fills
                // use the joined order's exact decimal size for display/sizing.
                executedSizeDecimal: orders.executedSizeDecimal,
                optionExpiration: orders.optionExpiration,
                optionStrike: orders.optionStrike,
                optionType: orders.optionType,
                tradeAction: orders.tradeAction,
                direction: orders.direction,
                copySourceLabel: orders.copySourceLabel,
                // Perp facts for mapUserTradeToItem's perpMeta, read off the SAME
                // join copy-mirror-candidate-sources.ts already trusts for the
                // auto-mirror path. `direction` above answers the equity/option
                // action; these answer "can this row prefill the PERP ticket".
                orderDirection: orders.direction,
                orderLeverage: orders.leverage,
                orderReduceOnly: orders.reduceOnly,
                orderVenue: orders.venue,
                createdAt: socialTrades.createdAt,
              })
              .from(socialTrades)
              .innerJoin(schema.users, eq(socialTrades.userId, schema.users.id))
              .innerJoin(
                orders,
                authoritativeOrderJoin,
              )
              .where(conditions.length > 0 ? and(...conditions) : undefined)
              .orderBy(
                desc(millisecondTimestamp(socialTrades.createdAt)),
                desc(socialTrades.id),
              )
              .limit(input.limit)
              .offset(offset);
            };

            type UserRawRow = Awaited<ReturnType<typeof selectUserRows>>[number];
            const rawRows: UserRawRow[] = [];
            let offset = 0;
            let lastBatch: UserRawRow[] = [];
            let lastBatchLength = 0;
            while (offset < COPY_FEED_USER_RAW_SCAN_CAP) {
              const batch = await selectUserRows(offset, userHighWater);
              if (!userHighWater && batch[0]?.createdAt) {
                const timestamp = canonicalFeedTimestamp(batch[0].createdAt);
                if (timestamp) {
                  userHighWater = { ts: timestamp, id: `user:${batch[0].id}` };
                }
              }
              rawRows.push(...batch);
              lastBatch = batch;
              lastBatchLength = batch.length;
              const batchMapped = collapseUserTradeRows(rawRows)
                .map((r) => mapUserTradeToItem(r, anonymizeTrader))
                .filter((item): item is CopyTradeItem =>
                  item !== null &&
                  (userCursor === null || isOlder({ ts: item.timestamp, id: item.id }, userCursor)),
                );
              if (applyFeedFilters(batchMapped).length >= input.limit || batch.length < input.limit) break;
              offset += input.limit;
            }

            // L-11: orders.broker_order_id is NOT unique, so even after scoping the
            // join to the source user it can fan a shared trade into duplicate rows.
            // De-dupe to ONE row per social_trade id so duplicates don't consume
            // `limit` slots or appear twice in the feed.
            const rows = collapseUserTradeRows(rawRows);
            const mapped = rows
              .map((r) => mapUserTradeToItem(r, anonymizeTrader))
              .filter((item): item is CopyTradeItem => item !== null);
            // Use the RAW (pre-dedupe) batch length for the full-batch test: the
            // SQL `limit` applied to the fanned-out rows, so a full raw batch is
            // what signals "older rows may remain".
            if (lastBatchLength === input.limit) {
              anySourceFull = true;
              rawBoundaries.push(rawUserBatchBoundary(lastBatch));
            } else {
              rawBoundaries.push(null);
            }
            perSource.push(applyFeedFilters(mapped));
            sourceKeys.push("user");
          } catch (err) {
            failedSources.push("user");
            sourceKeys.push("user");
            rawBoundaries.push(sourceCursorFor("user"));
            perSource.push([]);
            logger.error("copy-trade", "Failed to fetch user source", { error: err });
          }
        }
      }

      // ---- politician: NO-OP in Phase 1 (table does not exist yet) ----
      if (input.sources.includes("politician")) {
        sourceKeys.push("politician");
        rawBoundaries.push(null);
        perSource.push([]);
      }

      // H-3: in the Following view, hand buildPage the deepest SAFE raw boundary
      // so a page whose newest `limit` rows held no followed items still returns a
      // next-cursor (keeps paging into older history) instead of dead-ending. The
      // non-followedOnly path passes null (unchanged behavior).
      const followedFloorCursor = input.followedOnly
        ? fullSourceFloorCursor(rawBoundaries)
        : null;

      const page = buildPage(
        perSource,
        cursor,
        input.limit,
        anySourceFull,
        followedFloorCursor,
        rawBoundaries,
        sourceKeys,
        failedSources,
      );
      return { ...page, failedSources };
    }),

  /**
   * The deployment's REAL auto-mirror gating state.
   *
   * Arming `auto_mirror` on a follow row is a request, not a guarantee: the
   * worker that acts on it ships disabled and refuses live accounts, mainnet
   * perps and leverage independently. Without this procedure the UI could show
   * auto-mirror as on while the worker was inert, which is the single most
   * misleading thing this feature can do to a user.
   *
   * Read-only, no input, no DB. Cheap enough to poll alongside the follow list.
   *
   * The answer is only ever about the process that serves it, and it is
   * assembled one env var at a time. See `resolveMirrorStatus`: each field is
   * null unless ITS OWN var is set on this deployment, because the flags live
   * on the worker and an absent var cannot be read as "off". Operators mirror
   * subsets, so a partly configured API reports the part it has and leaves the
   * rest null; nothing here promotes an absent var to false. Clients must
   * render null as unknown, never as disabled.
   */
  mirrorStatus: protectedProcedure.query((): MirrorStatus => resolveMirrorStatus()),
});
