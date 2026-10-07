/**
 * Leaderboard Router (Phase 4 — "Top Traders")
 *
 * Two ranked leaderboards so a user can VET and DISCOVER traders before they
 * blind-follow, then Follow / auto-copy straight from the ranking. Each row
 * exposes the SAME `followTarget` shape the copy-trade feed uses, so following
 * from the leaderboard hits the same copyTradeFollows.follow API and matches the
 * feed/Following filter.
 *
 * Two tabs, two DIFFERENT metric families — never blended:
 *   - users:    fellow users ranked by reconstructed realized P&L plus live
 *               Hyperliquid unrealized P&L, with win rate + trade count derived
 *               from shared trade EVENTS only (FIFO-paired).
 *   - xCallers: X authors ranked by HIT RATE + DIRECTION-ADJUSTED AVG FORWARD
 *               RETURN over a horizon
 *               + call count. A SIGNAL-QUALITY heuristic (provider-qualified
 *               market move after the call), NOT the caller's realized P&L.
 *               Stock and Hyperliquid source failures degrade per market while
 *               preserving the requested ranking over measurable calls.
 *
 * Caching: the users aggregate is broad and the xCallers bars are expensive, so
 * both keep a one-hour fresh value plus a one-hour stale-while-revalidate
 * window. If Redis is unavailable we degrade to live compute.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { waitUntil } from "@vercel/functions";
import { router, protectedProcedure } from "../trpc.js";
import { createProductionLogger } from "@trade-bot/logger";
import { schema, type PoolDb } from "@trade-bot/db";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  lt,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getRedisClient } from "@trade-bot/redis";
import { getUserLeaderboardCacheEpoch, isUserLeaderboardCacheKey } from "../lib/leaderboard-identity-cache.js";
import {
  CANONICAL_AUTHOR_KEY_PREFIX,
  classifySignalInstrument,
  canonicalAuthorKey,
  canonicalAuthorSource,
  isCanonicalAuthorKey,
  normalizeAuthorAlias,
  parseSourceAuthorAliasKey,
  sourceAuthorAliasKey,
  resolveCanonicalAuthorAlias,
} from "@trade-bot/utils";
import { networkFromEnv, parseCanonicalPerpCoin } from "@trade-bot/hyperliquid";
import { symbolSchema } from "./orders.js";
import {
  fetchXCallerMarketData,
  makeXCallerMarketRef,
  type XCallerDailyBar,
  type XCallerMarketData,
  type XCallerMarketDataHealth,
  type XCallerMarketRef,
} from "../lib/x-caller-market-data.js";
import {
  buildAuthoritativeOrderJoin,
  publiclyEligibleOrderCondition,
  validOptionContractCondition,
} from "../lib/authoritative-order.js";
import {
  traderKey,
  traderProfileSlug,
  traderProfileSlugAliases,
  normalizeTraderSlug,
  deriveAuthor,
  resolveTraderIdentity,
} from "../lib/trader-identity.js";
import { createHyperliquidInfoClient } from "../lib/hyperliquid.js";
import { normalizeAuthorKey, type FollowTarget } from "./copy-trade.js";
import { deriveXCallDirection, type XCallDirection } from "../lib/x-call-direction.js";
import {
  forwardReturnPct,
  aggregateCallerStats,
  scoreXCallReturn,
  canonicalizeTradeRows,
  UserLeaderboardAccumulator,
  LeaderboardFifoCapacityError,
  computeLeaderboardMeta,
  DEFAULT_MAX_LEADERBOARD_BUCKETS,
  DEFAULT_MAX_LEADERBOARD_EVENTS,
  DEFAULT_MAX_LEADERBOARD_USERS,
  DEFAULT_MAX_OPEN_FIFO_LOTS,
  LEADERBOARD_FILL_STATUSES,
  MAX_SAFE_LEADERBOARD_PERP_SIZE,
  MAX_SAFE_LEADERBOARD_NON_PERP_VALUE_SQL,
  type LeaderboardEventCursor,
} from "../lib/leaderboard.js";

const logger = createProductionLogger();

// Bound the X-caller work so a degenerate signal table can't fan out into
// thousands of market-data fetches. Detail display and eligible measurement
// populations have separate per-author caps.
export const MAX_X_MARKET_COUNT = 60;
export const MAX_X_RECENT_CALLS_PER_AUTHOR = 50;
export const MAX_X_MEASUREMENT_CALLS_PER_AUTHOR = 50;
export const USER_HISTORY_PAGE_SIZE = 1_000;
export const USER_LEADERBOARD_MEASUREMENT_DAYS = 365;
export const USER_HISTORY_CANDIDATE_CAP = 30_000;
export const USER_HISTORY_CANDIDATE_FETCH_LIMIT = USER_HISTORY_CANDIDATE_CAP + 1;
export const USER_LEADERBOARD_QUERY_TIMEOUT_MS = 8_000;
/** A leaderboard may be up to one hour old; expensive refreshes run behind it. */
export const LEADERBOARD_FRESH_TTL_SECONDS = 60 * 60;
/** Keep one additional hour so an expired value can be served during refresh. */
export const LEADERBOARD_STALE_TTL_SECONDS = 60 * 60;
export const USER_LEADERBOARD_HEALTHY_TTL_SECONDS = LEADERBOARD_FRESH_TTL_SECONDS;
/**
 * Live account reads are an additive ranking input, not permission to fan out
 * across the entire users table. One snapshot may read the main DEX plus every
 * discovered HIP-3 DEX, so this cap deliberately stays well below the shared
 * Hyperliquid request-weight budget.
 */
export const USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP = 25;
export const USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CONCURRENCY = 4;
export const USER_LEADERBOARD_HL_WALLET_SNAPSHOT_TIMEOUT_MS = 5_000;
/**
 * Bound on the Hyperliquid credential rows read to build the wallet map
 * (audit H6). Sits above the snapshot cap on purpose: exceeding the snapshot
 * cap has to be *observed* to be reported as `market_data_cap`, so this read
 * must be able to see past it rather than silently truncating to it.
 */
export const USER_LEADERBOARD_HL_CREDENTIAL_FETCH_LIMIT = 500;
/**
 * Hard upper bound on the number of platform users fetched when building the
 * leaderboard. The shared cache retains this bounded, unsorted population so
 * every requested sort can reuse the same expensive measurement. Set high
 * enough to remain unobservable in practice while
 * satisfying the audit H6 "every scan must have a named limit" rule. The
 * query orders by creation date, so once the platform exceeds this cap the
 * newest accounts would silently drop out of ranking eligibility; the fetch
 * limit below adds one sentinel row so truncation can be detected and
 * reported as degraded instead.
 */
export const USER_LEADERBOARD_PLATFORM_USERS_CAP = 10_000;
export const USER_LEADERBOARD_PLATFORM_USERS_FETCH_LIMIT =
  USER_LEADERBOARD_PLATFORM_USERS_CAP + 1;
export const USER_LEADERBOARD_DEGRADED_TTL_SECONDS = 5 * 60;
export function usersCacheTtlSeconds(degraded: boolean): number {
  return degraded
    ? USER_LEADERBOARD_DEGRADED_TTL_SECONDS
    : USER_LEADERBOARD_HEALTHY_TTL_SECONDS;
}
export const XCALLERS_HEALTHY_TTL_SECONDS = LEADERBOARD_FRESH_TTL_SECONDS;
export const XCALLERS_DEGRADED_TTL_SECONDS = 5 * 60;
/**
 * Hard cap on signals rows scanned by the xCallers leaderboard (audit H6).
 * The "all" window has no time floor, so cost otherwise grows with total
 * platform history on every cache miss. Newest-first ordering keeps the most
 * recent calls under the cap.
 */
export const XCALLER_SIGNAL_SCAN_CAP = 5_000;

type LeaderboardSelectDb = Pick<PoolDb, "select">;

function finiteNumericColumnCondition(column: AnyColumn): SQL {
  return sql`${column} is not null and ${column}::text not in ('NaN', 'Infinity', '-Infinity')`;
}

type LeaderboardCursorExpression = SQL | SQL.Aliased | AnyColumn;

function cursorGreaterThan(
  expression: LeaderboardCursorExpression,
  value: SQL,
): SQL {
  return gt(expression as SQL, value);
}

function cursorEqual(
  expression: LeaderboardCursorExpression,
  value: SQL,
): SQL {
  return eq(expression as SQL, value);
}

/**
 * Build the exact tuple continuation used by the users leaderboard query.
 * `eventAtExpression` is the fixed-width UTC text key from the canonical SQL
 * subquery, so this comparison cannot lose PostgreSQL microseconds in a Date.
 */
export function buildLeaderboardCursorCondition(
  eventAtExpression: LeaderboardCursorExpression,
  socialTradeIdExpression: LeaderboardCursorExpression,
  orderIdExpression: LeaderboardCursorExpression,
  cursor: LeaderboardEventCursor,
): SQL {
  const eventAt = sql`${cursor.eventAt}`;
  const socialTradeId = sql`${cursor.socialTradeId}`;
  const orderId = sql`${cursor.orderId}`;
  return or(
    cursorGreaterThan(eventAtExpression, eventAt),
    and(
      cursorEqual(eventAtExpression, eventAt),
      cursorGreaterThan(socialTradeIdExpression, socialTradeId),
    ),
    and(
      cursorEqual(eventAtExpression, eventAt),
      cursorEqual(socialTradeIdExpression, socialTradeId),
      cursorGreaterThan(orderIdExpression, orderId),
    ),
  )!;
}

function leaderboardRealFillCondition(orders: {
  status: AnyColumn;
  executedPrice: AnyColumn;
  assetType: AnyColumn;
  executedSizeDecimal: AnyColumn;
  executedQuantity: AnyColumn;
  optionExpiration: AnyColumn;
  optionStrike: AnyColumn;
  optionType: AnyColumn;
}): SQL {
  return and(
    inArray(orders.status, [...LEADERBOARD_FILL_STATUSES]),
    finiteNumericColumnCondition(orders.executedPrice),
    gt(orders.executedPrice, "0"),
    lte(orders.executedPrice, MAX_SAFE_LEADERBOARD_NON_PERP_VALUE_SQL),
    or(
      and(
        eq(orders.assetType, "PERP"),
        finiteNumericColumnCondition(orders.executedSizeDecimal),
        gt(orders.executedSizeDecimal, "0"),
        lte(orders.executedSizeDecimal, MAX_SAFE_LEADERBOARD_PERP_SIZE),
      ),
      and(
        ne(orders.assetType, "PERP"),
        finiteNumericColumnCondition(orders.executedQuantity),
        gt(orders.executedQuantity, 0),
        lte(orders.executedQuantity, MAX_SAFE_LEADERBOARD_NON_PERP_VALUE_SQL),
        validOptionContractCondition(orders),
      ),
    ),
  )!;
}

/**
 * Build the bounded candidate stream for one users-leaderboard measurement.
 * New social events join by their authoritative orders.id. Legacy rows without
 * that link are admitted only when every matching order belongs to one account
 * scope; broker IDs reused across scopes make the event conservatively absent.
 */
export function buildLeaderboardCanonicalEventSubquery(
  db: LeaderboardSelectDb,
  measurementFloor: Date | null,
  measurementCeiling: Date | null = null,
) {
  const socialTrades = alias(schema.socialTrades, "leaderboard_social_trades");
  const orders = alias(schema.orders, "leaderboard_orders");
  const users = alias(schema.users, "leaderboard_users");
  const venueEventTimestamp = sql`
    coalesce(${orders.executedAt}, ${socialTrades.createdAt})
  `;
  const eventAtExpression = sql<string>`
    to_char(
      ${venueEventTimestamp} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  `.as("event_at");
  const socialTradeIdExpression = sql<string>`${socialTrades.id}`.as("social_trade_id");
  const orderIdExpression = sql<string>`${orders.id}`.as("order_id");
  const authoritativeOrderJoin = buildAuthoritativeOrderJoin(
    db,
    socialTrades,
    orders,
    alias(schema.orders, "leaderboard_other_orders"),
  );

  return db
    .select({
      socialTradeId: socialTradeIdExpression,
      userId: socialTrades.userId,
      brokerOrderId: socialTrades.brokerOrderId,
      orderId: orderIdExpression,
      brokerAccountId: orders.brokerAccountId,
      brokerCredentialId: orders.brokerCredentialId,
      venue: orders.venue,
      symbol: orders.symbol,
      assetType: orders.assetType,
      tradeAction: orders.tradeAction,
      direction: orders.direction,
      reduceOnly: orders.reduceOnly,
      optionExpiration: orders.optionExpiration,
      optionStrike: orders.optionStrike,
      optionType: orders.optionType,
      executedPrice: orders.executedPrice,
      executedQuantity: orders.executedQuantity,
      executedSizeDecimal: orders.executedSizeDecimal,
      status: orders.status,
      executedAt: orders.executedAt,
      createdAt: socialTrades.createdAt,
      eventAt: eventAtExpression,
    })
    .from(socialTrades)
    .innerJoin(users, eq(socialTrades.userId, users.id))
    .innerJoin(orders, authoritativeOrderJoin)
    .where(and(
      leaderboardRealFillCondition({
        ...orders,
        optionExpiration: orders.optionExpiration,
        optionStrike: orders.optionStrike,
        optionType: orders.optionType,
      }),
      publiclyEligibleOrderCondition(db, orders),
      ...(measurementFloor ? [gte(venueEventTimestamp, measurementFloor)] : []),
      ...(measurementCeiling ? [lt(venueEventTimestamp, measurementCeiling)] : []),
    ))
    .orderBy(
      asc(venueEventTimestamp),
      asc(socialTrades.id),
      asc(orders.id),
    )
    .limit(USER_HISTORY_CANDIDATE_FETCH_LIMIT);
}

/** SQL wrapper exported for generated-query tests without a database connection. */
export function buildLeaderboardCanonicalMaterializationQuery(
  db: LeaderboardSelectDb,
  measurementFloor: Date | null,
  measurementCeiling: Date | null = null,
): SQL {
  return sql`${buildLeaderboardCanonicalEventSubquery(db, measurementFloor, measurementCeiling)}`;
}

/**
 * How deep the users ranking is retained so the caller's own standing can be
 * located (plan A11's pinned "you" row).
 *
 * The board is anonymized (`anonymizeTrader`), so a signed-in user cannot find
 * themselves by name; without a rank lookup they have no way to see their own
 * standing at all. The lookup must therefore reach past the page the client
 * asked for, but it must stay bounded: this is what gets JSON-serialized into
 * the response on every request. Past this depth the pinned row reports
 * "outside the top N" rather than inventing a rank.
 *
 * Must stay >= `limitSchema`'s max (100) so a full page is always servable from
 * the shared cached population.
 */
export const USER_RANK_LOOKUP_CAP = 500;
/**
 * How deep the membership check goes when deciding whether a caller who is not
 * on the visible board is nonetheless ranked. Bounded so the shared cache entry
 * cannot grow with the user base; beyond it, membership is reported as unknown
 * rather than guessed.
 */
export const SELF_MEMBERSHIP_KEY_CAP = 5_000;

// ============================================
// Shared input shapes
// ============================================

const windowSchema = z.enum(["7d", "30d", "all"]).default("30d");
const limitSchema = z.number().min(1).max(100).default(25);

/** Convert a window enum into an inclusive lower-bound Date, or null for "all". */
function windowStart(window: "7d" | "30d" | "all"): Date | null {
  if (window === "all") return null;
  const days = window === "7d" ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ============================================
// Row shapes (what the client renders)
// ============================================

export interface UserLeaderboardRow {
  /** SAME shape as the copy-trade feed's user followTarget -> Follow matches the feed. */
  followTarget: FollowTarget & { type: "user" };
  displayName: string;
  avatar: string;
  /**
   * Readable, non-unique `/lb/users/<slug>` segment (X handle, else pseudonym).
   * Routing/display only — `followTarget.key` stays the collision-resistant key.
   * Optional so a leaderboard payload cached before slugs existed still parses;
   * the link builder falls back to the follow key.
   */
  profileSlug?: string;
  twitterHandle?: string | null;
  twitterLinked?: boolean;
  /** Displayed P&L: reconstructed realized plus live Hyperliquid unrealized. */
  realizedPnl: number;
  /** Reconstructed Alpaca (stocks/equities) realized portion. */
  alpacaPnl: number;
  /** Hyperliquid reconstructed realized plus live unrealized portion. */
  hyperliquidPnl: number;
  /** [0,1] win rate over closed lots. */
  winRate: number;
  /** Number of closed lots (NOT raw trade events). */
  tradeCount: number;
  /** ISO timestamp of the user's most recent shared trade, or null. */
  lastTradeAt: string | null;
  /** True when the user has a Hyperliquid credential configured. Copy-follow gating. */
  hasHyperliquid: boolean;
}

export interface UserLeaderboardCapacityState {
  reason:
    | "query_timeout"
    | "query_unavailable"
    | "candidate_cap"
    | "state_cap"
    | "platform_users_cap"
    | "market_data_cap"
    | "market_data_unavailable";
  limit: number;
  resource: string;
}

type HyperliquidLeaderboardSnapshot = {
  positions: ReadonlyArray<{ unrealizedPnl: string }>;
};

export type HyperliquidUnrealizedPnlResult =
  | {
      complete: true;
      values: Map<string, number>;
      /**
       * Users whose snapshot reported at least one open position. Tracked
       * separately from `values` because the P&L of an open position can be
       * legitimately 0.00 (break-even, or several positions netting to zero),
       * which is indistinguishable from the 0 a wallet with no positions
       * produces. Callers deciding whether a user is *active* must read this,
       * never `values.get(id) !== 0`.
       */
      openPositionUserIds: Set<string>;
    }
  | {
      complete: false;
      reason: "cap" | "unavailable";
      values: Map<string, number>;
      openPositionUserIds: Set<string>;
      failedUserIds: string[];
    };

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("operation aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error("operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Read a bounded set of wallets without converting missing market data to $0.
 * Successful wallet reads survive failures elsewhere in the batch. Callers
 * merge failures with recent last-known-good values instead of converting
 * missing market data to $0 or discarding the whole leaderboard.
 */
export async function measureHyperliquidUnrealizedPnl(
  entries: ReadonlyArray<readonly [string, `0x${string}`]>,
  loadSnapshot: (
    address: `0x${string}`,
    signal: AbortSignal,
  ) => Promise<HyperliquidLeaderboardSnapshot>,
  options: {
    cap?: number;
    concurrency?: number;
    timeoutMs?: number;
  } = {},
): Promise<HyperliquidUnrealizedPnlResult> {
  const cap = options.cap ?? USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP;
  if (entries.length > cap) {
    return {
      complete: false,
      reason: "cap",
      values: new Map(),
      openPositionUserIds: new Set(),
      failedUserIds: entries.map(([userId]) => userId),
    };
  }
  if (entries.length === 0)
    return { complete: true, values: new Map(), openPositionUserIds: new Set() };

  const concurrency = Math.max(
    1,
    Math.min(
      Math.floor(options.concurrency ?? USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CONCURRENCY),
      entries.length,
    ),
  );
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? USER_LEADERBOARD_HL_WALLET_SNAPSHOT_TIMEOUT_MS),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Hyperliquid leaderboard snapshot deadline exceeded"));
  }, timeoutMs);
  const values = new Map<string, number>();
  const openPositionUserIds = new Set<string>();
  const failedUserIds = new Set<string>();
  let cursor = 0;

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      if (!entry) return;
      const [userId, address] = entry;
      try {
        const snapshot = await awaitWithAbort(
          loadSnapshot(address, controller.signal),
          controller.signal,
        );
        let unrealizedPnl = 0;
        for (const position of snapshot.positions) {
          const rawValue = position.unrealizedPnl.trim();
          const value = rawValue === "" ? Number.NaN : Number(rawValue);
          if (!Number.isFinite(value)) {
            throw new Error("Hyperliquid returned a non-finite unrealized P&L");
          }
          unrealizedPnl += value;
          if (!Number.isFinite(unrealizedPnl)) {
            throw new Error("Hyperliquid unrealized P&L sum overflowed");
          }
        }
        values.set(userId, unrealizedPnl);
        // Recorded from the position COUNT, not the summed P&L: a break-even
        // position sums to exactly 0, the same number an empty wallet gives.
        if (snapshot.positions.length > 0) openPositionUserIds.add(userId);
      } catch (error) {
        failedUserIds.add(userId);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    clearTimeout(timeout);
  }

  for (const [userId] of entries) {
    if (!values.has(userId)) failedUserIds.add(userId);
  }
  if (failedUserIds.size > 0) {
    return {
      complete: false,
      reason: "unavailable",
      values,
      openPositionUserIds,
      failedUserIds: [...failedUserIds],
    };
  }
  return { complete: true, values, openPositionUserIds };
}

function asHyperliquidAddress(value: string | null | undefined): `0x${string}` | null {
  return value && /^0x[0-9a-fA-F]{40}$/u.test(value)
    ? (value as `0x${string}`)
    : null;
}

/**
 * A readable `/lb/users/<slug>` segment: an X handle, a pseudonym, or a legacy
 * 32-hex traderKey. All three fit `[A-Za-z0-9_]`, so one schema covers them.
 * The optional leading "@" lets a pasted `@handle` resolve.
 */
const traderProfileSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((val) => val.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^@?[A-Za-z0-9_]+$/u));

/** Identity columns needed to derive every candidate's profile slug. */
function selectProfileSlugCandidates(db: LeaderboardSelectDb) {
  return db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      twitterName: schema.users.twitterName,
      username: schema.users.username,
      image: schema.users.image,
      twitterLinked: sql<boolean>`exists (
        select 1 from accounts
        where accounts.user_id = users.id
          and accounts.provider_id = 'twitter'
      )`.mapWith(Boolean),
    })
    .from(schema.users)
    .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
    .limit(USER_LEADERBOARD_PLATFORM_USERS_FETCH_LIMIT);
}

type ProfileSlugCandidate = Awaited<ReturnType<typeof selectProfileSlugCandidates>>[number];

/**
 * Resolve a public profile URL segment to a platform user.
 *
 * Two passes. The first matches the CANONICAL slug, so when a handle and some
 * other user's pseudonym collide the trader whose canonical URL it is wins. The
 * second accepts every other form that should resolve to a trader
 * (`traderProfileSlugAliases`): the legacy `traderKey` hash, the stored X handle
 * even when the linked-account row did not come back, and the pseudonym after an
 * X account is linked. A profile that 404s on a form the user reasonably typed
 * (their own handle, a link shared before they linked X) is worse than one that
 * resolves and redirects to the canonical URL, which the page already does.
 *
 * Readable slugs are NOT unique; the `createdAt`/`id` ordering makes "oldest
 * matching account wins" deterministic rather than arbitrary. This is a
 * read-only public profile lookup — never reuse it on a money-moving path.
 */
async function resolveTraderByProfileSlug(
  db: LeaderboardSelectDb,
  slug: string,
): Promise<ProfileSlugCandidate | null> {
  const wanted = normalizeTraderSlug(slug);
  const candidates = await selectProfileSlugCandidates(db);
  const profileOf = (candidate: ProfileSlugCandidate) => ({
    twitterLinked: candidate.twitterLinked,
    name: candidate.name,
    twitterName: candidate.twitterName,
    username: candidate.username,
    image: candidate.image,
  });

  const canonical = candidates.find((candidate) => {
    const identity = resolveTraderIdentity(candidate.id, profileOf(candidate));
    const candidateSlug = traderProfileSlug(candidate.id, identity.twitterHandle);
    return normalizeTraderSlug(candidateSlug) === wanted;
  });
  if (canonical) return canonical;

  return (
    candidates.find((candidate) =>
      traderProfileSlugAliases(candidate.id, profileOf(candidate)).includes(wanted),
    ) ?? null
  );
}

export interface UserLeaderboardMeasurementState {
  /** Null for true all-history retrieval. */
  startedAt: string | null;
  horizonLabel: string;
  /** False when a query/state cap means the requested horizon was truncated. */
  complete: boolean;
  candidateCap: number;
  eventCap: number;
  measuredEvents: number;
  /** Oldest wallet snapshot contributing live unrealized P&L, if any. */
  marketDataAsOf: string | null;
  /** Wallets using a last-known-good snapshot because their refresh failed. */
  staleWalletCount: number;
  /** Wallets omitted because neither a fresh nor recent last-known value existed. */
  unavailableWalletCount: number;
}

type WalletPnlSnapshot = { unrealizedPnl: number; measuredAt: string };

type UsersLeaderboardBasePayload = {
  /** Bounded, public/anonymized rows. Sorting is a cheap request-time operation. */
  rows: UserLeaderboardRow[];
  walletSnapshots: Record<string, WalletPnlSnapshot>;
  capacity: UserLeaderboardCapacityState | null;
  measurement: UserLeaderboardMeasurementState;
};

/** Pure capacity classifier shared by the users procedure and its tests. */
export function resolveUsersLeaderboardCapacity(input: {
  dbCode?: string | null;
  candidateRows?: number;
  eventRows?: number;
  platformUserRows?: number;
  /**
   * Connected Hyperliquid wallets needing a live snapshot. Over the snapshot
   * cap the measurement fails as a group, which would otherwise drop every
   * perp trader from the board silently; classify it as a capacity failure.
   */
  hlWalletRows?: number;
}): UserLeaderboardCapacityState | null {
  if (
    input.hlWalletRows !== undefined &&
    input.hlWalletRows > USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP
  ) {
    return {
      reason: "market_data_cap",
      limit: USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP,
      resource: "hyperliquid_wallets",
    };
  }
  if (input.dbCode !== undefined && input.dbCode !== null) {
    return {
      reason: input.dbCode === "57014" ? "query_timeout" : "query_unavailable",
      limit: USER_LEADERBOARD_QUERY_TIMEOUT_MS,
      resource: "database_query",
    };
  }
  if (
    input.candidateRows !== undefined &&
    input.candidateRows > USER_HISTORY_CANDIDATE_CAP
  ) {
    return {
      reason: "candidate_cap",
      limit: USER_HISTORY_CANDIDATE_CAP,
      resource: "candidate_rows",
    };
  }
  if (
    input.eventRows !== undefined &&
    input.eventRows > DEFAULT_MAX_LEADERBOARD_EVENTS
  ) {
    return {
      reason: "state_cap",
      limit: DEFAULT_MAX_LEADERBOARD_EVENTS,
      resource: "events",
    };
  }
  if (
    input.platformUserRows !== undefined &&
    input.platformUserRows > USER_LEADERBOARD_PLATFORM_USERS_CAP
  ) {
    return {
      reason: "platform_users_cap",
      limit: USER_LEADERBOARD_PLATFORM_USERS_CAP,
      resource: "platform_users",
    };
  }
  return null;
}

export function userLeaderboardMeasurementStart(now: Date): Date {
  return new Date(
    now.getTime() - USER_LEADERBOARD_MEASUREMENT_DAYS * 24 * 60 * 60 * 1000,
  );
}

export function userLeaderboardHorizon(
  window: "7d" | "30d" | "all",
  now: Date,
): { floor: Date | null; label: string; complete: boolean } {
  if (window === "all") {
    return {
      floor: null,
      label: `all available history (bounded at ${USER_HISTORY_CANDIDATE_CAP.toLocaleString()} fills)`,
      complete: true,
    };
  }
  const days = window === "7d" ? 7 : 30;
  return {
    floor: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    label: `the newest ${days} days`,
    complete: true,
  };
}

/**
 * The caller's own standing on the users board (plan A11).
 *
 * Carries no raw user id: the row is the same anonymized shape everyone else
 * gets, located by the caller's one-way `traderKey`.
 */
export interface UserLeaderboardSelf {
  /** The caller's own aggregated row, or null when they are not ranked. */
  row: UserLeaderboardRow | null;
  /** 1-based rank in the full ranking; null exactly when `row` is null. */
  rank: number | null;
  /**
   * True when the ranking was truncated at `USER_RANK_LOOKUP_CAP`, so a missing
   * row means "below that rank" rather than "no shared trades in this window".
   * The two read very differently to the user, so the UI must be able to tell
   * them apart instead of guessing.
   */
  belowRankCap: boolean;
  /**
   * We could not determine whether the caller is on the board at all.
   *
   * The membership key set is bounded, so on a board larger than that bound a
   * caller who is not in the prefix may be ranked deep OR not ranked at all.
   * Reporting the second told a user with real shared trades that they had
   * none, which is a claim about their activity we cannot support. The UI must
   * say it does not know rather than pick one.
   */
  standingUnknown: boolean;
  /**
   * The depth the rank lookup covered. Returned rather than duplicated as a
   * client constant so the "outside the top N" copy can never drift from the
   * number the server actually used.
   */
  rankCap: number;
}

/**
 * Locate the caller in a ranked (already sorted, already capped) users board.
 *
 * Pure so the "not ranked" vs "below the cap" distinction is testable without a
 * database. `rankedTotal` is the count BEFORE the cap was applied.
 */
/**
 * Is this caller on the board: yes, no, or WE CANNOT TELL.
 *
 * `rankedKeys` is capped at `SELF_MEMBERSHIP_KEY_CAP`. When the whole ranking
 * fits inside that cap the key set is complete, so absence is a real answer.
 * Past it, a caller who is not in the prefix might be ranked deep or might not
 * be ranked at all, and returning "no" there told users with real shared trades
 * that they had none.
 */
export function resolveSelfMembership(
  rankedKeys: readonly string[],
  rankedTotal: number,
  selfKey: string,
  keyCap: number = SELF_MEMBERSHIP_KEY_CAP,
): boolean | null {
  if (rankedKeys.includes(selfKey)) return true;
  // The prefix covered the entire ranking, so not being in it is conclusive.
  if (rankedTotal <= keyCap) return false;
  return null;
}

export function resolveSelfStanding(
  ranked: UserLeaderboardRow[],
  selfKey: string,
  rankedTotal: number,
  rankCap: number = USER_RANK_LOOKUP_CAP,
  /**
   * Whether the caller appears ANYWHERE in the full ranking, not just in the
   * capped page. Required because global truncation says nothing about one
   * specific user: inferring `belowRankCap` from `rankedTotal > ranked.length`
   * told every user with no shared trades at all that they were ranked outside
   * the top N, which is a different and wrong statement.
   */
  selfIsRanked: boolean | null = false,
): UserLeaderboardSelf {
  const index = ranked.findIndex((row) => row.followTarget.key === selfKey);
  if (index >= 0) {
    return {
      row: ranked[index]!,
      rank: index + 1,
      belowRankCap: false,
      standingUnknown: false,
      rankCap,
    };
  }
  return {
    row: null,
    rank: null,
    // All three must hold: membership is KNOWN, the caller is genuinely ranked,
    // and the board was cut off before reaching them.
    belowRankCap: selfIsRanked === true && rankedTotal > ranked.length,
    // `null` means the membership key set was truncated before reaching this
    // caller, so "not ranked" and "ranked very deep" are indistinguishable.
    standingUnknown: selfIsRanked === null,
    rankCap,
  };
}

export interface XCallerLeaderboardRow {
  /** SAME shape as the copy-trade feed's x_author followTarget -> Follow matches the feed. */
  followTarget: FollowTarget & { type: "x_author" };
  displayName: string;
  avatar: string | null;
  /** Instruments represented by this caller's calls in the selected window. */
  assetCoverage: XCallerAssetCoverage;
  /** Counts from the same canonical classified call stream as assetCoverage. */
  assetCallCounts: XCallerAssetCounts;
  /** Fraction of measured calls that moved in the predicted direction. */
  hitRate: number | null;
  /** Mean forward-return % over the horizon, or null if unmeasured. */
  avgForwardReturnPct: number | null;
  /** Total calls attributed to this author in the window. */
  callCount: number;
  /** Calls whose text contains an unambiguous bullish or bearish direction. */
  directionalCallCount: number;
  /** Directional calls with a complete forward-horizon return. */
  measuredCallCount: number;
  /** Directional calls retained as measurement candidates before market data. */
  measurementCandidateCount: number;
  /** Retained candidate calls that were actually passed to the scorer. */
  measurementCallsRetainedCount: number;
  /** Eligible directional calls omitted by the per-author measurement cap. */
  measurementCandidateOmittedCount: number;
  /** The per-author cap applied to retained measurement candidates. */
  measurementCallCap: number;
  /** True when at least one eligible candidate was omitted by that cap. */
  measurementCapped: boolean;
  /** True when at least one directional measurement candidate lacks usable market data. */
  needsMarketData: boolean;
  /**
   * Plan S5. Link to this caller's most recent call as it was actually posted,
   * or null when no retained call carried a post-specific URL.
   *
   * The row already links INWARD (to our own caller profile). Linking outward is
   * a direct expression of the product thesis: our ranking is reconstructed from
   * things a person published, and it should be one tap to go read the thing.
   * A wallet-derived leaderboard has no equivalent because an address never
   * published anything.
   */
  latestCallUrl: string | null;
}

export type XCallerAssetClass = "stocks" | "perps";
export type XCallerAssetCoverage = XCallerAssetClass | "both";
export interface XCallerAssetCounts {
  stocks: number;
  perps: number;
}

interface XLeaderboardCall {
  id: string;
  symbol: string;
  content: string;
  url: string | null;
  source: string;
  callTime: Date;
  direction: XCallDirection;
  assetClass: XCallerAssetClass;
  marketRef: XCallerMarketRef | null;
}

interface XCallerBucket {
  canonicalKey: string | null;
  aliases: Set<string>;
  label: string;
  avatar: string | null;
  /** Newest calls retained for the caller detail page. */
  recentCalls: XLeaderboardCall[];
  /** Newest directional stock/perp calls eligible for bounded measurement. */
  measurementCalls: XLeaderboardCall[];
  totalCallCount: number;
  directionalCallCount: number;
  measurementCandidateCount: number;
  measurementCallsRetainedCount: number;
  measurementCandidateOmittedCount: number;
  measurementCallCap: number;
  measurementCapped: boolean;
  recentCallOmittedCount: number;
  assetClasses: Set<XCallerAssetClass>;
  assetCallCounts: XCallerAssetCounts;
}

export interface XSignalRow {
  id: string;
  symbol: string | null;
  content: string;
  url: string | null;
  source: string;
  /** Immutable source event identity, nullable on legacy signal rows. */
  sourceEventId?: string | null;
  /** Immutable source author identity, nullable on legacy signal rows. */
  sourceAuthorId?: string | null;
  timestamp: Date;
  metadata: unknown;
}

export type XCallerProfileMeasurementStatus =
  | "measured"
  | "unmeasured"
  | "not_comparable";

function selectXSignalRows(
  db: LeaderboardSelectDb,
  start: Date | null,
  authorCondition?: SQL,
) {
  const conditions: SQL[] = [];
  if (start) conditions.push(gte(schema.signals.timestamp, start));
  if (authorCondition) conditions.push(authorCondition);

  return db
    .select({
      id: schema.signals.id,
      symbol: schema.signals.symbol,
      content: schema.signals.content,
      url: schema.signals.url,
      source: schema.signals.source,
      sourceEventId: schema.signals.sourceEventId,
      sourceAuthorId: schema.signals.sourceAuthorId,
      timestamp: schema.signals.timestamp,
      metadata: schema.signals.metadata,
    })
    .from(schema.signals)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${schema.signals.timestamp} DESC NULLS LAST`, desc(schema.signals.id))
    .limit(
      authorCondition ? XCALLER_SIGNAL_SCAN_CAP : XCALLER_SIGNAL_SCAN_CAP + 1,
    );
}

type CanonicalLeaderboardObservation = {
  source: string;
  canonicalKey: string;
  aliases: readonly string[];
};

type DurableXCallerObservation = CanonicalLeaderboardObservation;

type XCallerGroupingOptions = {
  /** True only when the durable identity/alias query completed without a cap. */
  durableOwnersComplete?: boolean;
  durableObservations?: readonly DurableXCallerObservation[];
};

/**
 * Resolve only aliases observed in the bounded signal population. A leaderboard
 * cache miss must not turn into a full durable identity/alias table scan.
 * Source-qualified predicates preserve fail-closed ownership semantics when the
 * same display name exists on more than one X identity.
 */
export async function readBoundedDurableXCallerObservations(
  db: LeaderboardSelectDb,
  signalRows: readonly XSignalRow[],
): Promise<{
  observations: DurableXCallerObservation[];
  complete: boolean;
  available: boolean;
}> {
  const relational = db as LeaderboardSelectDb & {
    query?: {
      sourceAuthorIdentities?: unknown;
      sourceAuthorAliases?: unknown;
    };
  };
  if (!relational.query?.sourceAuthorIdentities || !relational.query.sourceAuthorAliases) {
    // Lightweight unit doubles do not expose Drizzle's relational query
    // namespace. Preserve their old in-memory grouping behavior; production
    // startup compatibility requires these tables to exist.
    return { observations: [], complete: false, available: false };
  }

  const aliasRefs = new Map<string, { source: string; alias: string }>();
  for (const row of signalRows) {
    const author = deriveSignalAuthor(row);
    if (author.identityKind === "relay") continue;
    const source = author.source ?? row.source ?? null;
    if (!source) continue;
    for (const alias of [
      ...author.authorAliases,
      ...author.authorAliasHistory,
      normalizeAuthorAlias(author.authorName),
    ]) {
      const normalized = normalizeAuthorAlias(alias);
      if (!normalized) continue;
      aliasRefs.set(`${source}\u0000${normalized}`, { source, alias: normalized });
    }
  }
  if (aliasRefs.size === 0) return { observations: [], complete: true, available: true };
  if (aliasRefs.size > XCALLER_SIGNAL_SCAN_CAP) {
    logger.warn("leaderboard", "Bounded alias ownership population exceeded its safety cap", {
      aliasCount: aliasRefs.size,
      cap: XCALLER_SIGNAL_SCAN_CAP,
    });
    return { observations: [], complete: false, available: true };
  }

  try {
    const conditions = [...aliasRefs.values()].map((ref) => and(
      eq(schema.sourceAuthorAliases.source, ref.source),
      eq(schema.sourceAuthorAliases.alias, ref.alias),
    )!);
    const aliasRows = await db
      .select({
        source: schema.sourceAuthorAliases.source,
        canonicalKey: schema.sourceAuthorIdentities.canonicalKey,
        alias: schema.sourceAuthorAliases.alias,
      })
      .from(schema.sourceAuthorAliases)
      .innerJoin(
        schema.sourceAuthorIdentities,
        eq(
          schema.sourceAuthorIdentities.id,
          schema.sourceAuthorAliases.identityId,
        ),
      )
      .where(or(...conditions)!)
      .limit(XCALLER_SIGNAL_SCAN_CAP + 1);
    if (aliasRows.length > XCALLER_SIGNAL_SCAN_CAP) {
      logger.warn("leaderboard", "Bounded alias ownership lookup exceeded its safety cap", {
        aliasCount: aliasRefs.size,
        cap: XCALLER_SIGNAL_SCAN_CAP,
      });
      return { observations: [], complete: false, available: true };
    }

    const observations = new Map<string, {
      source: string;
      canonicalKey: string;
      aliases: Set<string>;
    }>();
    for (const row of aliasRows) {
      if (!row.source || !isCanonicalAuthorKey(row.canonicalKey)) continue;
      const observation = observations.get(row.canonicalKey) ?? {
        source: row.source,
        canonicalKey: row.canonicalKey,
        aliases: new Set<string>(),
      };
      const normalized = normalizeAuthorAlias(row.alias);
      if (normalized && observation.source === row.source) {
        observation.aliases.add(normalized);
      }
      observations.set(row.canonicalKey, observation);
    }

    return {
      observations: [...observations.values()].map((observation) => ({
        source: observation.source,
        canonicalKey: observation.canonicalKey,
        aliases: [...observation.aliases],
      })),
      complete: true,
      available: true,
    };
  } catch (error) {
    logger.warn("leaderboard", "Could not load bounded canonical alias owners", {
      error,
    });
    return { observations: [], complete: false, available: true };
  }
}

function aliasOwnersForSource(
  alias: string,
  source: string | null,
  observations: readonly CanonicalLeaderboardObservation[],
): Set<string> {
  const normalizedAlias = normalizeAuthorAlias(alias);
  if (!normalizedAlias || !source) return new Set();
  return new Set(
    observations
      .filter((observation) => observation.source === source)
      .filter((observation) => observation.aliases.some(
        (candidate) => normalizeAuthorAlias(candidate) === normalizedAlias,
      ))
      .map((observation) => observation.canonicalKey),
  );
}

type SignalIdentityRow = {
  id: string;
  source?: string | null;
  sourceEventId?: string | null;
};

/** Use the immutable source event when present, and UUID only for legacy rows. */
function signalIdentityKey(row: SignalIdentityRow): string {
  const source = typeof row.source === "string" ? row.source.trim() : "";
  const sourceEventId = typeof row.sourceEventId === "string"
    ? row.sourceEventId.trim()
    : "";
  return source && sourceEventId
    ? JSON.stringify(["source_event", source, sourceEventId])
    : JSON.stringify(["uuid", row.id]);
}

function deduplicateSignalRows<T extends XSignalRow>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const key = signalIdentityKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

/** Supply the persisted source author ID when older metadata omitted identity fields. */
function deriveSignalAuthor(row: XSignalRow): ReturnType<typeof deriveAuthor> {
  const author = deriveAuthor(row.metadata, row.source);
  if (author.identityKind === "relay" || author.canonicalAuthorKey) return author;

  const sourceAuthorId = author.sourceAuthorId ?? (
    typeof row.sourceAuthorId === "string" ? row.sourceAuthorId.trim() || null : null
  );
  const source = author.source ?? row.source;
  const fallbackCanonicalKey = canonicalAuthorKey(source, sourceAuthorId);
  if (!sourceAuthorId || !fallbackCanonicalKey) return author;

  return {
    ...author,
    source,
    sourceAuthorId,
    canonicalAuthorKey: fallbackCanonicalKey,
    identityKind: "source_author",
  };
}

function safeLeaderboardAliasKeys(
  author: ReturnType<typeof deriveAuthor>,
  observations: readonly CanonicalLeaderboardObservation[],
): string[] {
  const source = author.source ?? canonicalAuthorSource(author.canonicalAuthorKey);
  const aliases = [...new Set([
    ...author.authorAliases,
    ...author.authorAliasHistory,
    normalizeAuthorAlias(author.authorName),
  ])].filter((alias): alias is string => alias !== null);
  return aliases
    .map((alias) => {
      const owners = aliasOwnersForSource(alias, source, observations);
      if (author.canonicalAuthorKey && (
        owners.size !== 1 || !owners.has(author.canonicalAuthorKey)
      )) return null;
      if (!author.canonicalAuthorKey && owners.size > 1) return null;
      return sourceAuthorAliasKey(source, alias) ?? (!source ? alias : null);
    })
    .filter((alias): alias is string => alias !== null);
}

export function groupXLeaderboardCalls(
  signalRows: XSignalRow[],
  options: XCallerGroupingOptions = {},
): Map<string, XCallerBucket> {
  const byAuthor = new Map<string, XCallerBucket>();

  const orderedRows = deduplicateSignalRows(
    [...signalRows].sort(compareXSignalRowsByRecency),
  );
  const canonicalObservations = orderedRows
    .map((row) => deriveSignalAuthor(row))
    .filter(
      (author): author is typeof author & { canonicalAuthorKey: string } =>
        author.identityKind !== "relay" && Boolean(author.canonicalAuthorKey),
    )
    .map((author) => ({
      source: author.source ?? canonicalAuthorSource(author.canonicalAuthorKey) ?? "",
      canonicalKey: author.canonicalAuthorKey,
      aliases: [...new Set([
        ...author.authorAliases,
        ...author.authorAliasHistory,
        normalizeAuthorAlias(author.authorName),
      ])].filter((alias): alias is string => alias !== null),
    }));
  const aliasOwnerObservations = options.durableOwnersComplete === true
    ? options.durableObservations ?? []
    : options.durableOwnersComplete === false
      ? []
      : canonicalObservations;
  for (const row of orderedRows) {
    const rawSymbol = (row.symbol ?? "").trim();
    if (!rawSymbol) continue;
    const author = deriveSignalAuthor(row);
    if (author.identityKind === "relay") continue;
    const { authorName, authorAvatar } = author;
    const authorAliases = safeLeaderboardAliasKeys(author, aliasOwnerObservations);
    const fallbackAuthorKey = normalizeAuthorKey(authorName);
    let authorKey = author.canonicalAuthorKey;
    if (!authorKey) {
      if (options.durableOwnersComplete === false) continue;
      const source = author.source;
      for (const candidate of [
        ...author.authorAliases,
        ...author.authorAliasHistory,
        fallbackAuthorKey,
      ]) {
        if (!candidate) continue;
        const owners = aliasOwnersForSource(candidate, source, aliasOwnerObservations);
        if (owners.size > 1) continue;
        if (owners.size === 1 && source) {
          authorKey = resolveCanonicalAuthorAlias(candidate, source, aliasOwnerObservations);
          if (authorKey) break;
        }
      }
    }
    if (!authorKey) {
      const fallbackOwners = aliasOwnersForSource(
        fallbackAuthorKey ?? "",
        author.source,
        aliasOwnerObservations,
      );
      if (fallbackOwners.size <= 1) {
        const sourceAlias = sourceAuthorAliasKey(author.source, fallbackAuthorKey);
        authorKey = sourceAlias ?? (!author.source ? fallbackAuthorKey : null);
      }
    }
    if (!authorKey) continue;

    const callTime = row.timestamp ? new Date(row.timestamp) : null;
    if (!callTime || Number.isNaN(callTime.getTime())) continue;

    let bucket = byAuthor.get(authorKey);
    if (!bucket) {
      bucket = {
        canonicalKey: isCanonicalAuthorKey(authorKey) ? authorKey : null,
        aliases: new Set(authorAliases),
        label: authorName,
        avatar: authorAvatar,
        recentCalls: [],
        measurementCalls: [],
        totalCallCount: 0,
        directionalCallCount: 0,
        measurementCandidateCount: 0,
        measurementCallsRetainedCount: 0,
        measurementCandidateOmittedCount: 0,
        measurementCallCap: MAX_X_MEASUREMENT_CALLS_PER_AUTHOR,
        measurementCapped: false,
        recentCallOmittedCount: 0,
        assetClasses: new Set(),
        assetCallCounts: { stocks: 0, perps: 0 },
      };
      byAuthor.set(authorKey, bucket);
    } else {
      for (const alias of authorAliases) bucket.aliases.add(alias);
    }
    const assetClass = xCallerAssetClass(row.metadata, rawSymbol, row.content);
    const marketRef = xCallerMarketRef(row.metadata, rawSymbol, row.content);
    const symbol = marketRef?.symbol ?? rawSymbol;
    const direction = deriveXCallDirection({
      content: row.content,
      symbol,
      referenceDate: callTime,
      metadata: row.metadata,
    });
    const call: XLeaderboardCall = {
      id: row.id,
      symbol,
      content: row.content,
      url: row.url,
      source: row.source,
      callTime,
      direction,
      assetClass,
      marketRef,
    };

    bucket.totalCallCount += 1;
    bucket.assetClasses.add(assetClass);
    bucket.assetCallCounts[assetClass] += 1;
    if (bucket.recentCalls.length < MAX_X_RECENT_CALLS_PER_AUTHOR) {
      bucket.recentCalls.push(call);
    } else {
      bucket.recentCallOmittedCount += 1;
    }
    if (direction !== "unknown") {
      bucket.directionalCallCount += 1;
      bucket.measurementCandidateCount += 1;
      if (bucket.measurementCalls.length < MAX_X_MEASUREMENT_CALLS_PER_AUTHOR) {
        bucket.measurementCalls.push(call);
        bucket.measurementCallsRetainedCount += 1;
      } else {
        bucket.measurementCandidateOmittedCount += 1;
        bucket.measurementCapped = true;
      }
    }
    if (!bucket.avatar && authorAvatar) bucket.avatar = authorAvatar;
  }

  return byAuthor;
}

/** Resolve a canonical key directly or an unambiguous historical alias. */
export function resolveXCallerBucket(
  byAuthor: Map<string, XCallerBucket>,
  requestedKey: string,
): XCallerBucket | undefined {
  const direct = byAuthor.get(requestedKey);
  if (direct) return direct;
  const requestedAliasKey = parseSourceAuthorAliasKey(requestedKey);
  if (requestedAliasKey) {
    const sourceOwners = [...byAuthor.entries()].filter(
      ([key, bucket]) =>
        isCanonicalAuthorKey(key) &&
        [...bucket.aliases].some((candidate) => {
          const parsed = parseSourceAuthorAliasKey(candidate);
          return parsed?.source === requestedAliasKey.source &&
            parsed.alias === requestedAliasKey.alias;
        }),
    );
    return sourceOwners.length === 1 ? sourceOwners[0]![1] : undefined;
  }
  const alias = normalizeAuthorAlias(requestedKey);
  if (!alias) return undefined;
  const owners = [...byAuthor.entries()].filter(
    ([, bucket]) =>
      [...bucket.aliases].some((candidate) => {
        const parsed = parseSourceAuthorAliasKey(candidate);
        return normalizeAuthorAlias(parsed?.alias ?? candidate) === alias;
      }),
  );
  if (owners.length > 0) return owners.length === 1 ? owners[0]![1] : undefined;
  return direct;
}

function compareXSignalRowsByRecency(a: XSignalRow, b: XSignalRow): number {
  const aTime = a.timestamp instanceof Date ? a.timestamp.getTime() : NaN;
  const bTime = b.timestamp instanceof Date ? b.timestamp.getTime() : NaN;
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return bTime - aTime;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Classify a leaderboard call using the canonical signal classifier. */
export function xCallerAssetClass(
  metadata: unknown,
  symbol: string,
  content?: string | null,
): XCallerAssetClass {
  const instrument = classifySignalInstrument(metadata, content);
  const rawHlTicker = metadataRecord(metadata)?.hlTicker;
  const canonicalHlTicker = parseCanonicalPerpCoin(rawHlTicker);
  const rawSymbol = symbol.trim();
  return instrument.perpVenue ||
    instrument.perpInstrument ||
    canonicalHlTicker !== null ||
    // A colon is an explicit Hyperliquid namespace marker. If the remainder
    // is malformed, classify it as a perp-shaped candidate so the ref builder
    // can fail closed instead of sending the raw identity to Alpaca.
    rawSymbol.includes(":")
    ? "perps"
    : "stocks";
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
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

/** Parse the shared canonical stock grammar before creating an Alpaca ref. */
function parseCanonicalStockSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = symbolSchema.safeParse(raw.trim());
  return parsed.success ? parsed.data : null;
}

/** Provider-qualified market identity, preserving exact Hyperliquid metadata. */
export function xCallerMarketRef(
  metadata: unknown,
  symbol: string,
  content?: string | null,
): XCallerMarketRef | null {
  const assetClass = xCallerAssetClass(metadata, symbol, content);
  const rawHlTicker = metadataRecord(metadata)?.hlTicker;
  if (assetClass === "stocks") {
    // A non-empty hlTicker is an attempted provider identity. If it is not a
    // canonical coin, do not reinterpret the same call as an Alpaca symbol.
    if (
      rawHlTicker !== undefined &&
      rawHlTicker !== null &&
      (typeof rawHlTicker !== "string" || rawHlTicker.trim().length > 0) &&
      parseCanonicalPerpCoin(rawHlTicker) === null
    ) {
      return null;
    }
    const canonicalStockSymbol = parseCanonicalStockSymbol(symbol);
    return canonicalStockSymbol
      ? makeXCallerMarketRef("alpaca", canonicalStockSymbol)
      : null;
  }
  const canonicalTicker = parseCanonicalPerpCoin(rawHlTicker);
  // The shared Hyperliquid contract rejects absent or malformed hlTicker
  // values. In particular, never substitute the underlying stock symbol.
  return canonicalTicker ? makeXCallerMarketRef("hyperliquid", canonicalTicker) : null;
}

/** Summarize whether a caller's calls cover stocks, perps, or both. */
export function callerAssetCoverage(
  calls: ReadonlyArray<{ assetClass: XCallerAssetClass }>,
): XCallerAssetCoverage {
  let hasStocks = false;
  let hasPerps = false;

  for (const call of calls) {
    if (call.assetClass === "perps") hasPerps = true;
    else hasStocks = true;
    if (hasStocks && hasPerps) return "both";
  }

  return hasPerps ? "perps" : "stocks";
}

/**
 * Plan S5. The newest retained call's source URL, or null.
 *
 * Two rules, both learned from the data:
 *
 *  1. **Post-specific only.** The paste.trade poller stamps every row with the
 *     same board root (`https://paste.trade`), which identifies no post at all.
 *     A "view the call" link that lands on a board homepage is worse than no
 *     link: it looks like evidence and is not. Only a URL with a real path or
 *     query qualifies. Mirrors `isPostSpecificUrl` in the web feed, which exists
 *     for exactly this reason.
 *  2. **Newest by callTime, not by array position.** Buckets are filled from a
 *     newest-first scan today, but profile detail is deliberately kept separate
 *     from the global metric population, and a future caller could hand this an
 *     unsorted list. Comparing timestamps costs nothing and removes the assumption.
 *
 * http/https only: a stored `javascript:` or `data:` value must never become an
 * href we render.
 */
export function latestCallSourceUrl(
  calls: ReadonlyArray<{ url: string | null; callTime: Date }>,
): string | null {
  let best: { url: string; at: number } | null = null;
  for (const call of calls) {
    const url = sanitizeXCallerSourceUrl(call.url);
    if (!url) continue;
    const at = call.callTime instanceof Date ? call.callTime.getTime() : NaN;
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { url, at };
  }
  return best?.url ?? null;
}

/** An http(s) URL that identifies ONE post (has a path or a query), else null. */
export function sanitizeXCallerSourceUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname.toLowerCase().replace(/\.$/, "") === "paste.trade") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return path.length > 0 || parsed.search.length > 0 ? trimmed : null;
}

function bucketAssetCoverage(bucket: XCallerBucket): XCallerAssetCoverage {
  return bucket.assetClasses.has("stocks") && bucket.assetClasses.has("perps")
    ? "both"
    : bucket.assetClasses.has("perps")
      ? "perps"
      : "stocks";
}

export function addOmittedMarketHealth(
  health: XCallerMarketDataHealth,
  omitted: readonly XCallerMarketRef[],
  marketCap: number,
): XCallerMarketDataHealth {
  if (omitted.length === 0) return health;
  const byProvider = {
    alpaca: { ...health.byProvider.alpaca },
    hyperliquid: { ...health.byProvider.hyperliquid },
  };
  for (const ref of omitted) {
    byProvider[ref.provider].omitted += 1;
  }
  return {
    totalMarketCount: health.totalMarketCount + omitted.length,
    requestedMarketCount: health.requestedMarketCount,
    availableMarketCount: health.availableMarketCount,
    unavailableMarketCount: health.unavailableMarketCount,
    deadlineMarketCount: health.deadlineMarketCount,
    skippedMarketCount: health.skippedMarketCount,
    unresolvedCandidateCount: health.unresolvedCandidateCount,
    omittedMarketCount: health.omittedMarketCount + omitted.length,
    capped: true,
    marketCap,
    providerComplete: health.providerComplete,
    complete: false,
    byProvider,
  };
}

/** Add retained calls with no safe provider-qualified ref to market health. */
export function addUnresolvedMarketHealth(
  health: XCallerMarketDataHealth,
  unresolvedCandidateCount: number,
): XCallerMarketDataHealth {
  if (unresolvedCandidateCount <= 0) return health;
  return {
    ...health,
    unresolvedCandidateCount:
      health.unresolvedCandidateCount + Math.floor(unresolvedCandidateCount),
    complete: false,
  };
}

/** Merge modern and legacy query results into one deduplicated newest-first list. */
export function mergeSignalRowsByRecency<T extends {
  id: string;
  timestamp: Date;
  source?: string | null;
  sourceEventId?: string | null;
}>(
  primaryRows: T[],
  legacyRows: T[],
): T[] {
  const ordered = [...primaryRows, ...legacyRows].sort(
    (a, b) => {
      const timeDifference = b.timestamp.getTime() - a.timestamp.getTime();
      if (timeDifference !== 0) return timeDifference;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    },
  );
  const byIdentity = new Map<string, T>();
  for (const row of ordered) {
    const key = signalIdentityKey(row);
    if (!byIdentity.has(key)) byIdentity.set(key, row);
  }
  return [...byIdentity.values()];
}

/**
 * Canonicalize the raw signal scan used by both the global board and profile
 * metrics. The profile may fetch author-scoped detail separately, but its score
 * must come from these exact newest global rows.
 */
export function canonicalXCallerScanPopulation(
  primaryRows: XSignalRow[],
  legacyRows: XSignalRow[] = [],
): { rows: XSignalRow[]; complete: boolean } {
  const merged = mergeSignalRowsByRecency(primaryRows, legacyRows);
  return {
    rows: merged.slice(0, XCALLER_SIGNAL_SCAN_CAP),
    // Keep the existing +1 probe semantics even when the probe row is a
    // duplicate. The retained population is canonical, but a raw over-cap
    // result still means older unique rows may be outside the bounded scan.
    complete:
      merged.length <= XCALLER_SIGNAL_SCAN_CAP &&
      primaryRows.length <= XCALLER_SIGNAL_SCAN_CAP &&
      legacyRows.length <= XCALLER_SIGNAL_SCAN_CAP,
  };
}

/**
 * Match an author directly in JSONB using the same normalization rules as
 * normalizeAuthorKey(cleanAuthorName(...)). Profile lookups use an author-scoped
 * detail scan; profile metrics never use this population.
 */
export function normalizedSignalAuthorCondition(
  authorKey: string,
  source?: string | null,
): SQL<boolean> {
  return sql<boolean>`
    ${source ? sql`${schema.signals.source} = ${source} and ` : sql``}
    lower(
      regexp_replace(
        regexp_replace(
          btrim(coalesce(
            nullif(btrim(${schema.signals.metadata}->>'authorName'), ''),
            nullif(btrim(${schema.signals.metadata}->>'authorHandle'), ''),
            ''
          )),
          '\\s*[•·|–-]\\s*TweetShift\\s*$',
          '',
          'i'
        ),
        '\\s+',
        ' ',
        'g'
      )
    ) = ${authorKey}
  `;
}

/** Match canonical source-author metadata without depending on mutable names. */
export function canonicalSignalAuthorCondition(authorKey: string): SQL<boolean> {
  const source = canonicalAuthorSource(authorKey);
  const sourceAuthorId = canonicalAuthorId(authorKey);
  return sql`
    ${source ? sql`${schema.signals.source} = ${source} and ` : sql``}
    (
      ${schema.signals.metadata}->>'canonicalAuthorKey' = ${authorKey}
      ${sourceAuthorId ? sql`or ${schema.signals.sourceAuthorId} = ${sourceAuthorId}` : sql``}
    )
  `;
}

function canonicalAuthorId(authorKey: string): string | null {
  if (!isCanonicalAuthorKey(authorKey)) return null;
  const body = authorKey.slice(CANONICAL_AUTHOR_KEY_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator <= 0 || separator >= body.length - 1) return null;
  try {
    const source = canonicalAuthorSource(authorKey);
    const sourceAuthorId = decodeURIComponent(body.slice(separator + 1));
    return source && canonicalAuthorKey(source, sourceAuthorId) === authorKey
      ? sourceAuthorId
      : null;
  } catch {
    return null;
  }
}

/** Match a normalized, durable alias stored in an object metadata row. */
export function canonicalSignalAliasCondition(
  alias: string,
  source?: string | null,
): SQL<boolean> {
  return sql`
    ${source ? sql`${schema.signals.source} = ${source} and ` : sql``}
    jsonb_typeof(${schema.signals.metadata}) = 'object'
    ${source ? sql`and ${schema.signals.metadata}->>'authorSource' = ${source}` : sql``}
    and ${schema.signals.metadata}->'authorAliases' ? ${alias}
  `;
}

/** Read only aliases with one durable owner for canonical profile detail. */
async function readCanonicalProfileAliases(
  db: PoolDb,
  canonicalKey: string,
): Promise<string[]> {
  try {
    const directRows = await db
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
      .where(eq(schema.sourceAuthorIdentities.canonicalKey, canonicalKey))
      .limit(XCALLER_SIGNAL_SCAN_CAP + 1);
    if (directRows.length > XCALLER_SIGNAL_SCAN_CAP) return [];
    const source = canonicalAuthorSource(canonicalKey);
    const candidates = [...new Set(
      directRows
        .map((row) => normalizeAuthorAlias(row.alias))
        .filter((alias): alias is string => alias !== null),
    )];
    if (candidates.length === 0) return [];

    const ownerRows = await db
      .select({
        alias: schema.sourceAuthorAliases.alias,
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
      .where(and(
        inArray(schema.sourceAuthorAliases.alias, candidates),
        ...(source ? [eq(schema.sourceAuthorAliases.source, source)] : []),
      ))
      .limit(XCALLER_SIGNAL_SCAN_CAP + 1);
    if (ownerRows.length > XCALLER_SIGNAL_SCAN_CAP) return [];
    const owners = new Map<string, Set<string>>();
    for (const row of ownerRows) {
      const alias = normalizeAuthorAlias(row.alias);
      if (!alias) continue;
      const keys = owners.get(alias) ?? new Set<string>();
      keys.add(row.canonicalKey);
      owners.set(alias, keys);
    }
    return candidates.filter(
      (alias) => owners.get(alias)?.size === 1 && owners.get(alias)?.has(canonicalKey),
    );
  } catch (error) {
    logger.warn("leaderboard", "Could not load canonical profile aliases", { error });
    return [];
  }
}

/** Match legacy metadata that was stored as a JSON object inside a JSONB string. */
export function normalizedLegacySignalAuthorCondition(
  authorKey: string,
  source?: string | null,
): SQL<boolean> {
  return sql<boolean>`
    ${source ? sql`${schema.signals.source} = ${source} and ` : sql``}
    jsonb_typeof(${schema.signals.metadata}) = 'string'
    and lower(
      regexp_replace(
        regexp_replace(
          btrim(
            coalesce(
              nullif(
                btrim(substring(
                  ${schema.signals.metadata} #>> '{}'
                  from '"authorName"\\s*:\\s*"([^"\\\\]+)"'
                )),
                ''
              ),
              nullif(
                btrim(
                  substring(
                    ${schema.signals.metadata} #>> '{}'
                    from '"authorHandle"\\s*:\\s*"([^"\\\\]+)"'
                  )
                ),
                ''
              ),
              ''
            )
          ),
          '\\s*[•·|–-]\\s*TweetShift\\s*$',
          '',
          'i'
        ),
        '\\s+',
        ' ',
        'g'
      )
    ) = ${authorKey}
  `;
}

// X-caller author parsing reuses the shared trader-identity helpers
// (cleanAuthorName / deriveAuthor), imported above so the X-author label/avatar
// derivation stays byte-identical with the copy-trade feed.

// ============================================
// Cache helper — degrade to live compute when Redis is down
// ============================================

const leaderboardInFlight = new Map<string, Promise<unknown>>();
const LEADERBOARD_CACHE_OPERATION_TIMEOUT_MS = 500;

async function withLeaderboardCacheDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Leaderboard cache operation timed out")),
          LEADERBOARD_CACHE_OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type LeaderboardCacheEnvelope<T> = {
  version: 1;
  cachedAt: number;
  freshUntil: number;
  data: T;
};

function parseLeaderboardCacheEnvelope<T>(raw: string): LeaderboardCacheEnvelope<T> | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LeaderboardCacheEnvelope<T>>;
    return parsed.version === 1 &&
      typeof parsed.cachedAt === "number" &&
      typeof parsed.freshUntil === "number" &&
      "data" in parsed
      ? parsed as LeaderboardCacheEnvelope<T>
      : null;
  } catch {
    return null;
  }
}

function refreshLeaderboardCache<T>(
  fullKey: string,
  redis: Awaited<ReturnType<typeof getRedisClient>> | null,
  ttlSeconds: number | ((data: T) => number),
  compute: (previous?: T) => Promise<T>,
  previous?: T,
): Promise<T> {
  const existing = leaderboardInFlight.get(fullKey);
  if (existing) return existing as Promise<T>;

  const guardIdentityEpoch = isUserLeaderboardCacheKey(fullKey) && redis ? redis : null;

  const work = (async () => {
    const startEpoch = guardIdentityEpoch
      ? await getUserLeaderboardCacheEpoch(guardIdentityEpoch).catch(() => null)
      : null;
    const data = await compute(previous);
    const ttl = typeof ttlSeconds === "function" ? ttlSeconds(data) : ttlSeconds;
    if (redis && ttl > 0) {
      if (guardIdentityEpoch) {
        const currentEpoch = await getUserLeaderboardCacheEpoch(guardIdentityEpoch).catch(() => startEpoch);
        if (currentEpoch !== startEpoch) {
          logger.info("leaderboard", "Skipping stale user leaderboard cache write; identity changed mid-refresh", {
            fullKey,
          });
          return data;
        }
      }
      const now = Date.now();
      const envelope: LeaderboardCacheEnvelope<T> = {
        version: 1,
        cachedAt: now,
        freshUntil: now + ttl * 1_000,
        data,
      };
      try {
        await withLeaderboardCacheDeadline(
          redis.set(
            fullKey,
            JSON.stringify(envelope),
            ttl + LEADERBOARD_STALE_TTL_SECONDS,
          ),
        );
      } catch (err) {
        logger.warn("leaderboard", "Failed to write leaderboard cache", { error: err });
      }
    }
    return data;
  })();
  let tracked!: Promise<T>;
  tracked = work.finally(() => {
    if (leaderboardInFlight.get(fullKey) === tracked) leaderboardInFlight.delete(fullKey);
  });
  leaderboardInFlight.set(fullKey, tracked);
  return tracked;
}

/**
 * getOrFetch through Redis (JSON-serialized, TTL'd); if Redis is unavailable, the
 * cache read fails to parse, or the read/write throws, fall back to a live compute
 * so the leaderboard never fails on a cache outage. A cache-write failure is
 * non-fatal — we still return the freshly computed value.
 *
 * Implemented directly against getRedisClient (a single-hop package re-export)
 * rather than the CacheService barrel export, which Bun's multi-hop static
 * re-export analysis mis-resolves inside the combined test process.
 */
export async function cachedOrLive<T>(
  cacheKey: string,
  ttlSeconds: number | ((data: T) => number),
  compute: (previous?: T) => Promise<T>,
): Promise<T> {
  const fullKey = `leaderboard:${cacheKey}`;
  const cacheReadStartedAt = Date.now();
  let redis: Awaited<ReturnType<typeof getRedisClient>> | null = null;
  let stale: LeaderboardCacheEnvelope<T> | null = null;
  try {
    redis = await withLeaderboardCacheDeadline(getRedisClient(logger));
    const raw = await withLeaderboardCacheDeadline(redis.get(fullKey));
    if (raw !== null) {
      const envelope = parseLeaderboardCacheEnvelope<T>(raw);
      if (envelope && envelope.freshUntil > Date.now()) {
        logger.debug("leaderboard", "Leaderboard cache hit", {
          cacheKey,
          cacheReadMs: Date.now() - cacheReadStartedAt,
        });
        return envelope.data;
      }
      if (envelope) stale = envelope;
    }
  } catch (err) {
    logger.warn("leaderboard", "Redis unavailable; computing leaderboard live", { error: err });
  }

  if (stale) {
    logger.info("leaderboard", "Serving stale leaderboard during refresh", {
      cacheKey,
      cacheReadMs: Date.now() - cacheReadStartedAt,
      ageMs: Date.now() - stale.cachedAt,
    });
    const refresh = refreshLeaderboardCache(fullKey, redis, ttlSeconds, compute, stale.data)
      .catch((error) => logger.warn("leaderboard", "Background refresh failed", { error }));
    // Keep the Vercel invocation alive after the stale response is returned so
    // the refreshed value is reliably written for the next request.
    waitUntil(refresh);
    return stale.data;
  }

  logger.info("leaderboard", "Leaderboard cache miss", {
    cacheKey,
    cacheReadMs: Date.now() - cacheReadStartedAt,
  });
  return refreshLeaderboardCache(fullKey, redis, ttlSeconds, compute);
}

// ============================================
// Router
// ============================================

export const leaderboardRouter = router({
  /**
   * Users leaderboard — fellow users ranked by reconstructed realized P&L.
   *
   * Reads the selected newest-days horizon, or all available history up to the
   * explicit candidate/state caps, and joins social events to their exact
   * orders.id. Legacy broker-id joins are accepted only when every candidate
   * belongs to one account scope; ambiguous legacy events are omitted.
   * Application canonicalization then chooses one authoritative cumulative fill
   * per user/account/credential/venue/brokerOrderId.
   *
   * Bucketing — events group by CONTRACT IDENTITY so distinct instruments never
   * cross-match in FIFO:
   *   EQUITY:  (userId, symbol)
   *   OPTION:  (userId, symbol, optionExpiration, optionStrike, optionType)
   * An AAPL option and AAPL shares (and two different AAPL contracts) land in
   * separate buckets. Option P&L carries the 100x contract multiplier.
   *
   * Windowing — FIFO runs over the complete explicit measurement horizon so a
   * round-trip that opened before the selected 7d/30d window but closed inside
   * it is retained. "all" means all available history until a named cap is
   * reached; capped results are returned as degraded/unknown.
   *
   * Then aggregates per user and anonymizes once into a shared, unsorted cache.
   * Each request sorts that population by `sortBy`, retains the top
   * `USER_RANK_LOOKUP_CAP`, and resolves both the requested page and caller rank.
   *
   * Privacy: the raw userId is NEVER returned — rows carry only the pseudonym,
   * avatar, and the one-way traderKey hash (same as the feed). `me` is resolved
   * OUTSIDE the cache, against the caller's traderKey, so the shared cache entry
   * never holds caller-specific data.
   */
  users: protectedProcedure
    .input(
      z.object({
        window: windowSchema,
        sortBy: z.enum(["pnl", "winRate", "trades"]).default("pnl"),
        limit: limitSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      // v12: fresh identity lookup for the me row so Twitter-linked users
      // see their display name immediately without waiting for the cache to expire.
      // v15: cache the expensive measurement by window only. Sorting does not
      // re-run FIFO reconstruction or fan out to every Hyperliquid wallet.
      const cacheKey = `users:v17:${input.window}`;

      const payload = await cachedOrLive<UsersLeaderboardBasePayload>(
        cacheKey,
        (data) => usersCacheTtlSeconds(
          data.capacity !== null || data.measurement.unavailableWalletCount > 0,
        ),
        async (previous) => {
        const computeStartedAt = Date.now();
        const measuredAt = new Date();
        const horizon = userLeaderboardHorizon(input.window, measuredAt);
        const measurementFloor = horizon.floor;
        const windowFloor = windowStart(input.window);
        const windowFloorIso = windowFloor ? windowFloor.toISOString() : null;
        const measurement = (
          measuredEvents: number,
          complete = horizon.complete,
        ): UserLeaderboardMeasurementState => ({
          startedAt: measurementFloor?.toISOString() ?? null,
          horizonLabel: horizon.label,
          complete,
          candidateCap: USER_HISTORY_CANDIDATE_CAP,
          eventCap: DEFAULT_MAX_LEADERBOARD_EVENTS,
          measuredEvents,
          marketDataAsOf: null,
          staleWalletCount: 0,
          unavailableWalletCount: 0,
        });

        const identityDbStartedAt = Date.now();
        const [platformUsers, hyperliquidCredRows] = await Promise.all([
          ctx.db
            .select({
              id: schema.users.id,
              name: schema.users.name,
              twitterName: schema.users.twitterName,
              username: schema.users.username,
              image: schema.users.image,
              twitterLinked: sql<boolean>`exists (
                select 1 from accounts
                where accounts.user_id = users.id
                  and accounts.provider_id = 'twitter'
              )`.mapWith(Boolean),
            })
            .from(schema.users)
            .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
            .limit(USER_LEADERBOARD_PLATFORM_USERS_FETCH_LIMIT),
          ctx.db
            .select({
              userId: schema.userApiCredentials.userId,
              accountId: schema.userApiCredentials.accountId,
              username: schema.userApiCredentials.username,
            })
            .from(schema.userApiCredentials)
            .where(eq(schema.userApiCredentials.provider, "hyperliquid"))
            // Audit H6: every leaderboard read carries a named bound. This is
            // also the input whose size trips the wallet snapshot cap above, so
            // an unbounded scan here is the one that grows until the ranking
            // breaks.
            .limit(USER_LEADERBOARD_HL_CREDENTIAL_FETCH_LIMIT),
        ]);
        const identityDbMs = Date.now() - identityDbStartedAt;
        const hyperliquidUserIds = new Set(hyperliquidCredRows.map((r) => r.userId));
        // Build a map of userId -> wallet address for open-position fetching.
        const hlWalletByUserId = new Map<string, `0x${string}`>();
        for (const cred of hyperliquidCredRows) {
          const addr =
            asHyperliquidAddress(cred.accountId) ??
            asHyperliquidAddress(cred.username);
          if (addr) {
            hlWalletByUserId.set(cred.userId, addr);
          }
        }
        const degraded = (
          capacity: UserLeaderboardCapacityState,
          measuredEvents = 0,
        ) => ({
          rows: previous?.rows ?? [],
          walletSnapshots: previous?.walletSnapshots ?? {},
          capacity,
          measurement: measurement(measuredEvents, false),
        });

        const platformUsersCapacity = resolveUsersLeaderboardCapacity({
          platformUserRows: platformUsers.length,
        });
        if (platformUsersCapacity) {
          logger.warn("leaderboard", "Users leaderboard platform users cap reached", {
            ...platformUsersCapacity,
          });
          return degraded(platformUsersCapacity);
        }

        let candidateRows;
        const historyDbStartedAt = Date.now();
        try {
          candidateRows = await ctx.db.transaction(async (tx) => {
            await tx.execute(sql`
              select set_config(
                'statement_timeout',
                ${String(USER_LEADERBOARD_QUERY_TIMEOUT_MS)},
                true
              )
            `);
            const currentWindowRows = await buildLeaderboardCanonicalEventSubquery(
              tx,
              measurementFloor,
            );
            if (!measurementFloor) return currentWindowRows;

            // FIFO needs the bounded history immediately before the selected
            // window to reconstruct lots that close inside it. The accumulator
            // still scores only in-window closes, and the combined sentinel
            // count keeps the existing degraded/cap contract honest.
            const preWindowRows = await buildLeaderboardCanonicalEventSubquery(
              tx,
              null,
              measurementFloor,
            );
            return [...currentWindowRows, ...preWindowRows];
          });
        } catch (error) {
          const dbCode = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : "";
          const capacity = resolveUsersLeaderboardCapacity({ dbCode })!;
          logger.warn("leaderboard", "Users leaderboard measurement unavailable", {
            reason: capacity.reason,
            dbCode: dbCode || undefined,
          });
          return degraded(capacity);
        }
        const historyDbMs = Date.now() - historyDbStartedAt;

        const candidateCapacity = resolveUsersLeaderboardCapacity({
          candidateRows: candidateRows.length,
        });
        if (candidateCapacity) {
          logger.warn("leaderboard", "Users leaderboard candidate cap reached", {
            ...candidateCapacity,
          });
          return degraded(candidateCapacity, candidateRows.length);
        }

        const canonicalRows = canonicalizeTradeRows(candidateRows);
        const eventCapacity = resolveUsersLeaderboardCapacity({
          eventRows: canonicalRows.length,
        });
        if (eventCapacity) {
          logger.warn("leaderboard", "Users leaderboard event cap reached", {
            ...eventCapacity,
          });
          return degraded(eventCapacity, canonicalRows.length);
        }

        const accumulator = new UserLeaderboardAccumulator(windowFloorIso, {
          maxEvents: DEFAULT_MAX_LEADERBOARD_EVENTS,
          maxUsers: DEFAULT_MAX_LEADERBOARD_USERS,
          maxBuckets: DEFAULT_MAX_LEADERBOARD_BUCKETS,
          maxOpenLots: DEFAULT_MAX_OPEN_FIFO_LOTS,
        });
        try {
          accumulator.ingest(canonicalRows, tradeActionSide);
        } catch (error) {
          if (!(error instanceof LeaderboardFifoCapacityError)) throw error;
          const capacity: UserLeaderboardCapacityState = {
            reason: "state_cap",
            limit: error.limit,
            resource: error.resource,
          };
          logger.warn("leaderboard", "Users leaderboard retained-state cap reached", {
            ...capacity,
          });
          return degraded(capacity, canonicalRows.length);
        }

        const statsByUser = new Map(accumulator.finalize());

        // Fetch live unrealized P&L for every connected HL wallet so the
        // leaderboard P&L reflects open positions, not just closed trades.
        // Reads are bounded and fail closed as a group: silently substituting
        // $0 for one failed wallet would produce an inaccurate ranking.
        const hlInfo = createHyperliquidInfoClient({ network: networkFromEnv() });
        const marketDataStartedAt = Date.now();
        const unrealizedMeasurement = await measureHyperliquidUnrealizedPnl(
          [...hlWalletByUserId.entries()],
          (address, signal) => hlInfo.perpAccountSnapshot(address, signal),
        );
        // The wallet cap is all-or-nothing: over it, `measureHyperliquidUnrealizedPnl`
        // returns no values and fails every wallet. The row loop below omits any
        // HL-connected user it cannot measure, so a capped run does not omit "the
        // unmeasurable wallet" as that comment intends - it omits EVERY perp
        // trader, and the board renders as if they had simply stopped trading.
        // Report it as a capacity failure instead, which is what the
        // `market_data_cap` reason (declared, never produced until now) is for:
        // the cached previous board is served and `degraded` is true, rather than
        // publishing a confident ranking that silently lost its perp half.
        if (!unrealizedMeasurement.complete && unrealizedMeasurement.reason === "cap") {
          const marketDataCapacity = resolveUsersLeaderboardCapacity({
            hlWalletRows: hlWalletByUserId.size,
          })!;
          logger.warn("leaderboard", "Users leaderboard HL wallet snapshot cap reached", {
            ...marketDataCapacity,
            wallets: hlWalletByUserId.size,
          });
          return degraded(marketDataCapacity, canonicalRows.length);
        }
        const walletSnapshots: Record<string, WalletPnlSnapshot> = {};
        const unrealizedPnlByUserId = new Map<string, number>();
        let staleWalletCount = 0;
        let unavailableWalletCount = 0;
        const oldestAllowedSnapshotMs = measuredAt.getTime() - LEADERBOARD_FRESH_TTL_SECONDS * 1_000;
        for (const [userId] of hlWalletByUserId) {
          const key = traderKey(userId);
          const freshValue = unrealizedMeasurement.values.get(userId);
          if (freshValue !== undefined) {
            unrealizedPnlByUserId.set(userId, freshValue);
            walletSnapshots[key] = {
              unrealizedPnl: freshValue,
              measuredAt: measuredAt.toISOString(),
            };
            continue;
          }
          const lastGood = previous?.walletSnapshots[key];
          const lastGoodMs = lastGood ? Date.parse(lastGood.measuredAt) : Number.NaN;
          if (lastGood && Number.isFinite(lastGoodMs) && lastGoodMs >= oldestAllowedSnapshotMs) {
            unrealizedPnlByUserId.set(userId, lastGood.unrealizedPnl);
            walletSnapshots[key] = lastGood;
            staleWalletCount += 1;
          } else {
            unavailableWalletCount += 1;
          }
        }
        if (!unrealizedMeasurement.complete) {
          logger.warn("leaderboard", "Users leaderboard live P&L partially unavailable", {
            reason: unrealizedMeasurement.reason,
            wallets: hlWalletByUserId.size,
            freshWallets: unrealizedMeasurement.values.size,
            staleWallets: staleWalletCount,
            unavailableWallets: unavailableWalletCount,
          });
        }

        const result: UserLeaderboardRow[] = [];
        for (const user of platformUsers) {
          if (hlWalletByUserId.has(user.id) && !unrealizedPnlByUserId.has(user.id)) {
            // Omit only the unmeasurable wallet. Other traders remain visible,
            // and the response metadata reports the partial market population.
            continue;
          }
          const upnl = unrealizedPnlByUserId.get(user.id) ?? 0;
          const measuredStats = statsByUser.get(user.id);
          // `finalize()` drops users with no closed trades on purpose. Re-adding
          // them here with synthesized zeros put every account that had merely
          // signed up onto the board at exactly $0, which sorts ABOVE every
          // trader who is down on the window, and made the "No closed trades in
          // this window yet" empty state unreachable. A user with no closed
          // trades but a live open position still belongs.
          //
          // Activity is read from the position COUNT, never from `upnl !== 0`:
          // a break-even position (or several netting to zero) has an
          // unrealized P&L of exactly 0, the same number a wallet with no
          // positions at all reports, so inferring activity from the figure
          // would drop a real open trader off the board.
          if (!measuredStats && !unrealizedMeasurement.openPositionUserIds.has(user.id)) {
            continue;
          }
          const stats = measuredStats ?? {
            realizedPnl: 0,
            winRate: 0,
            tradeCount: 0,
            lastTradeAt: null,
            alpacaPnl: 0,
            hyperliquidPnl: 0,
          };
          const identity = resolveTraderIdentity(user.id, {
            twitterLinked: user.twitterLinked,
            name: user.name,
            twitterName: user.twitterName,
            username: user.username,
            image: user.image,
          });
          result.push({
            followTarget: { type: "user", key: traderKey(user.id), label: identity.traderName },
            displayName: identity.traderName,
            avatar: identity.traderImage,
            profileSlug: traderProfileSlug(user.id, identity.twitterHandle),
            twitterHandle: identity.twitterHandle,
            twitterLinked: identity.twitterLinked,
            realizedPnl: stats.realizedPnl + upnl,
            alpacaPnl: stats.alpacaPnl,
            hyperliquidPnl: stats.hyperliquidPnl + upnl,
            winRate: stats.winRate,
            tradeCount: stats.tradeCount,
            lastTradeAt: stats.lastTradeAt,
            hasHyperliquid: hyperliquidUserIds.has(user.id),
          });
        }

        const snapshotTimes = Object.values(walletSnapshots)
          .map((snapshot) => Date.parse(snapshot.measuredAt))
          .filter(Number.isFinite);
        logger.info("leaderboard", "Users leaderboard recomputed", {
          totalMs: Date.now() - computeStartedAt,
          identityDbMs,
          historyDbMs,
          marketDataMs: Date.now() - marketDataStartedAt,
          users: platformUsers.length,
          events: canonicalRows.length,
          wallets: hlWalletByUserId.size,
          staleWallets: staleWalletCount,
          unavailableWallets: unavailableWalletCount,
        });
        return {
          rows: result,
          walletSnapshots,
          capacity: null,
          measurement: {
            ...measurement(canonicalRows.length),
            marketDataAsOf: snapshotTimes.length > 0
              ? new Date(Math.min(...snapshotTimes)).toISOString()
              : null,
            staleWalletCount,
            unavailableWalletCount,
          },
        };
      });

      const ranked = [...payload.rows].sort((a, b) => {
        let metricDifference: number;
        if (input.sortBy === "winRate") {
          metricDifference = b.winRate !== a.winRate
            ? b.winRate - a.winRate
            : b.tradeCount - a.tradeCount;
        } else if (input.sortBy === "trades") {
          metricDifference = b.tradeCount - a.tradeCount;
        } else {
          metricDifference = b.realizedPnl - a.realizedPnl;
        }
        if (metricDifference !== 0) return metricDifference;
        return a.followTarget.key < b.followTarget.key ? -1 :
          a.followTarget.key > b.followTarget.key ? 1 : 0;
      });
      const rankedTotal = ranked.length;
      const retainedRanked = ranked.slice(0, USER_RANK_LOOKUP_CAP);
      const rankedKeys = ranked
        .slice(0, SELF_MEMBERSHIP_KEY_CAP)
        .map((row) => row.followTarget.key);

      const selfMembership = payload.capacity !== null || !payload.measurement.complete
        ? null
        : resolveSelfMembership(
            rankedKeys,
            rankedTotal,
            traderKey(ctx.userId),
          );

      const cachedMe = resolveSelfStanding(
        retainedRanked,
        traderKey(ctx.userId),
        rankedTotal,
        USER_RANK_LOOKUP_CAP,
        selfMembership,
      );

      // Fresh identity lookup for the current user so their displayed name
      // reflects the latest Twitter link without waiting for the cache to rebuild.
      // This is a cheap two-query read by primary key and runs outside the cached block.
      let me = cachedMe;
      if (cachedMe.row !== null) {
        try {
          const [currentUser, currentTwitterAccount] = await Promise.all([
            ctx.db.query.users.findFirst({
              where: eq(schema.users.id, ctx.userId),
              columns: { name: true, twitterName: true, username: true, image: true },
            }),
            ctx.db.query.accounts.findFirst({
              where: (account, { and, eq: eqFn }) => and(
                eqFn(account.userId, ctx.userId),
                eqFn(account.providerId, "twitter"),
              ),
              columns: { id: true },
            }),
          ]);
          const freshIdentity = resolveTraderIdentity(ctx.userId, {
            twitterLinked: Boolean(currentTwitterAccount),
            name: currentUser?.name,
            twitterName: currentUser?.twitterName,
            username: currentUser?.username,
            image: currentUser?.image,
          });
          me = {
            ...cachedMe,
            row: {
              ...cachedMe.row,
              displayName: freshIdentity.traderName,
              avatar: freshIdentity.traderImage,
              profileSlug: traderProfileSlug(ctx.userId, freshIdentity.twitterHandle),
              twitterHandle: freshIdentity.twitterHandle,
              twitterLinked: freshIdentity.twitterLinked,
              followTarget: {
                ...cachedMe.row.followTarget,
                label: freshIdentity.traderName,
              },
            },
          };
        } catch {
          // Fresh identity lookup failed; fall through to the cached value.
        }
      }

      return {
        rows: retainedRanked.slice(0, input.limit),
        // Plan A11. The caller's own standing, whatever their rank, so an
        // anonymized board is still legible to the person on it. Identity is
        // resolved fresh (above) so Twitter-linked users see their name immediately.
        me,
        approximate: true as const,
        degraded: payload.capacity !== null,
        capacity: payload.capacity,
        measurement: payload.measurement,
      };
    }),

  /** Bare public profile identity for a platform trader profile slug. */
  userProfile: protectedProcedure
    .input(z.object({ slug: traderProfileSlugSchema }))
    .query(async ({ ctx, input }) => {
      const user = await resolveTraderByProfileSlug(ctx.db, input.slug);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Trader not found" });

      const credential = await ctx.db.query.userApiCredentials.findFirst({
        where: (row, { and, eq }) => and(
          eq(row.userId, user.id),
          eq(row.provider, "hyperliquid"),
        ),
        columns: { accountId: true, username: true },
      });
      const identity = resolveTraderIdentity(user.id, {
        twitterLinked: user.twitterLinked,
        name: user.name,
        twitterName: user.twitterName,
        username: user.username,
        image: user.image,
      });
      return {
        // The canonical slug for this trader. The page redirects to it so a
        // legacy traderKey link settles on the readable URL.
        slug: traderProfileSlug(user.id, identity.twitterHandle),
        displayName: identity.traderName,
        avatar: identity.traderImage,
        twitterHandle: identity.twitterHandle,
        twitterLinked: identity.twitterLinked,
        walletAddress:
          asHyperliquidAddress(credential?.accountId) ??
          asHyperliquidAddress(credential?.username),
      };
    }),

  /** Provider-proxied Hyperliquid snapshot for a platform trader profile. */
  userProfilePerps: protectedProcedure
    .input(z.object({ slug: traderProfileSlugSchema }))
    .query(async ({ ctx, input }) => {
      const user = await resolveTraderByProfileSlug(ctx.db, input.slug);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Trader not found" });
      const credential = await ctx.db.query.userApiCredentials.findFirst({
        where: (row, { and, eq }) => and(
          eq(row.userId, user.id),
          eq(row.provider, "hyperliquid"),
        ),
        columns: { accountId: true, username: true },
      });
      const address =
        asHyperliquidAddress(credential?.accountId) ??
        asHyperliquidAddress(credential?.username);
      if (!address) {
        return { positions: [], fills: [], crossMargin: null, network: networkFromEnv() };
      }
      const network = networkFromEnv();
      const info = createHyperliquidInfoClient({ network });
      const [snapshot, fills] = await Promise.all([
        info.perpAccountSnapshot(address),
        info.listFills(address, 100),
      ]);
      return {
        positions: snapshot.positions,
        crossMargin: snapshot.crossMargin,
        fills,
        network,
      };
    }),

  /**
   * X-callers leaderboard — X authors ranked by forward-return heuristics.
   *
   * Reads signals in the window, derives the author (skipping "Unknown"), and for
   * each call computes the % move of the provider-qualified market from the call
   * time to ~horizonDays later using Alpaca equities or keyless Hyperliquid 1D
   * candles. Aggregates per author via
   * aggregateCallerStats.
   *
   * Graceful degradation: an unavailable provider leaves only that provider's
   * calls unmeasured. Partial source failures keep the requested metric sort over
   * measurable calls and are reported separately.
   */
  xCallers: protectedProcedure
    .input(
      z.object({
        window: windowSchema,
        horizonDays: z.number().min(1).max(60).default(7),
        sortBy: z.enum(["forwardReturn", "hitRate", "calls"]).default("forwardReturn"),
        limit: limitSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      // v12 (Task 2 final correction): market coverage, deadline health, and
      // completeness metadata are part of the cached contract, so older
      // payloads must not be reused.
      // The key is versioned rather than reused because an older entry would
      // deserialize with the new fields missing.
      // v14: market measurements are independent of display sort and page size.
      const cacheKey = `xCallers:v14:${input.window}:${input.horizonDays}`;

      const payload = await cachedOrLive<{
        rows: XCallerLeaderboardRow[];
        needsMarketData: boolean;
        rankingFallback: boolean;
        partialMarketData: boolean;
        dataComplete: boolean;
        marketDataHealth: XCallerMarketDataHealth;
        signalScan: {
          cap: number;
          retainedCount: number;
          observedCount: number;
          truncated: boolean;
        };
      }>(
        cacheKey,
        // Branch the TTL so a degraded result retries after five minutes instead
        // of remaining fresh for the full hour once market data is back.
        (data) => xCallersCacheTtlSeconds(data.needsMarketData),
        async () => {
        const computeStartedAt = Date.now();
        const start = windowStart(input.window);

        // Hard scan cap (audit H6): the "all" window has no time floor, so
        // without a limit this query reads every signals row ever written on
        // each cache miss. Newest-first ordering means the cap keeps the most
        // recent N calls; the +1 probe reports whether older rows were excluded.
        const signalRows = await selectXSignalRows(ctx.db, start);
        const globalPopulation = canonicalXCallerScanPopulation(signalRows);
        const durableOwners = await readBoundedDurableXCallerObservations(
          ctx.db,
          globalPopulation.rows,
        );
        const durableGroupingOptions = durableOwners.available
          ? {
              durableOwnersComplete: durableOwners.complete,
              durableObservations: durableOwners.observations,
            }
          : undefined;
        const dataComplete = globalPopulation.complete && durableOwners.complete;
        const signalScan = {
          cap: XCALLER_SIGNAL_SCAN_CAP,
          retainedCount: globalPopulation.rows.length,
          observedCount: signalRows.length,
          truncated: !globalPopulation.complete,
        };
        const byAuthor = groupXLeaderboardCalls(globalPopulation.rows, durableGroupingOptions);

        const hasMaster = Boolean(
          process.env.ALPACA_MASTER_KEY && process.env.ALPACA_MASTER_SECRET,
        );

        // Fetch the same provider-qualified market set used by both ranking and
        // profile measurements. The cap is over distinct markets, not authors.
        const allMarketRefs = collectBoundedMarketRefs(byAuthor, Number.MAX_SAFE_INTEGER);
        const marketRefs = allMarketRefs.slice(0, MAX_X_MARKET_COUNT);
        const marketDataStartedAt = Date.now();
        const fetchedMarketData = await fetchXCallerMarketData(
          marketRefs,
          input.horizonDays,
        );
        const marketDataHealth = addOmittedMarketHealth(
          addUnresolvedMarketHealth(
            fetchedMarketData.health,
            countUnresolvedMarketCandidates(byAuthor),
          ),
          allMarketRefs.slice(MAX_X_MARKET_COUNT),
          MAX_X_MARKET_COUNT,
        );

        const rows: XCallerLeaderboardRow[] = [];
        for (const [authorKey, bucket] of byAuthor) {
          rows.push(
            xCallerRowForBucket(
              authorKey,
              bucket,
              fetchedMarketData.data,
              input.horizonDays,
            ),
          );
        }

        // Sort by the requested metric. Nulls (unmeasured) sort last in metric
        // sorts so authors with real numbers rank first.
        const anyMarketData = marketDataHealth.availableMarketCount > 0;
        const hasMarketCandidates = [...byAuthor.values()].some(
          (bucket) => bucket.measurementCalls.length > 0,
        );
        const needsMarketData = rows.some((row) => row.needsMarketData);
        const meta = computeLeaderboardMeta({
          hasMaster,
          anyRowNeedsMarketData: needsMarketData,
          hasMarketCandidates,
          providerMarketDataUnavailable:
            marketDataHealth.unavailableMarketCount > marketDataHealth.deadlineMarketCount,
          unresolvedMarketCandidateCount: marketDataHealth.unresolvedCandidateCount,
          marketDataComplete: marketDataHealth.complete,
          signalsWithinCap: dataComplete,
          hasAnyMarketData: anyMarketData,
        });
        const result = {
          rows,
          needsMarketData,
          marketDataHealth,
          signalScan,
          ...meta,
        };
        logger.info("leaderboard", "X callers leaderboard recomputed", {
          totalMs: Date.now() - computeStartedAt,
          marketDataMs: Date.now() - marketDataStartedAt,
          signals: globalPopulation.rows.length,
          authors: rows.length,
          markets: marketRefs.length,
          availableMarkets: marketDataHealth.availableMarketCount,
        });
        return result;
      });

      const sortedRows = [...payload.rows];
      sortXCallerRows(
        sortedRows,
        payload.rankingFallback ? "calls" : input.sortBy,
      );

      return {
        rows: sortedRows.slice(0, input.limit),
        needsMarketData: payload.needsMarketData,
        rankingFallback: payload.rankingFallback,
        partialMarketData: payload.partialMarketData,
        dataComplete: payload.dataComplete,
        marketDataHealth: payload.marketDataHealth,
        signalScan: payload.signalScan,
        heuristic: true as const,
      };
    }),

  xCallerProfile: protectedProcedure
    .input(
      z.object({
        authorKey: z.string().trim().min(1).max(256),
        window: windowSchema,
        horizonDays: z.number().min(1).max(60).default(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      let rawAuthorKey = input.authorKey.trim();
      if (rawAuthorKey.includes("%")) {
        try {
          rawAuthorKey = decodeURIComponent(rawAuthorKey);
        } catch {}
      }
      const normalizedAuthorKey = isCanonicalAuthorKey(rawAuthorKey)
        ? rawAuthorKey
        : normalizeAuthorKey(rawAuthorKey);
      const requestedAliasKey = parseSourceAuthorAliasKey(rawAuthorKey);
      if (!normalizedAuthorKey) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Caller not found" });
      }

      const cacheKey = [
        "xCallerProfile:v14",
        normalizedAuthorKey,
        input.window,
        input.horizonDays,
      ].join(":");
      const payload = await cachedOrLive(
        cacheKey,
        (data: { needsMarketData: boolean }) =>
          xCallersCacheTtlSeconds(data.needsMarketData),
        async () => {
        const start = windowStart(input.window);
        // Metrics come from the exact same canonical global population as the
        // leaderboard. The author-scoped query below is detail-only: it may show
        // older calls, but those calls cannot create a profile score.
        const globalScanRows = await selectXSignalRows(ctx.db, start);
        const globalPopulation = canonicalXCallerScanPopulation(globalScanRows);
        const durableOwners = await readBoundedDurableXCallerObservations(
          ctx.db,
          globalPopulation.rows,
        );
        const durableGroupingOptions = durableOwners.available
          ? {
              durableOwnersComplete: durableOwners.complete,
              durableObservations: durableOwners.observations,
            }
          : undefined;
        const signalScan = {
          cap: XCALLER_SIGNAL_SCAN_CAP,
          retainedCount: globalPopulation.rows.length,
          observedCount: globalScanRows.length,
          truncated: !globalPopulation.complete,
        };
        const globalByAuthor = groupXLeaderboardCalls(
          globalPopulation.rows,
          durableGroupingOptions,
        );
        const globalMetricBucket = resolveXCallerBucket(globalByAuthor, normalizedAuthorKey);
        const globalMetricEntry = globalMetricBucket
          ? [...globalByAuthor.entries()].find(([, bucket]) => bucket === globalMetricBucket)
          : undefined;
        const profileSource = isCanonicalAuthorKey(normalizedAuthorKey)
          ? canonicalAuthorSource(normalizedAuthorKey)
          : requestedAliasKey?.source ??
            canonicalAuthorSource(globalMetricEntry?.[0]) ??
            parseSourceAuthorAliasKey(globalMetricEntry?.[0])?.source;

        let detailConditions: SQL[] = [];
        if (isCanonicalAuthorKey(normalizedAuthorKey)) {
          detailConditions.push(canonicalSignalAuthorCondition(normalizedAuthorKey));
          for (const alias of await readCanonicalProfileAliases(ctx.db, normalizedAuthorKey)) {
            detailConditions.push(
              normalizedSignalAuthorCondition(alias, profileSource),
              normalizedLegacySignalAuthorCondition(alias, profileSource),
              canonicalSignalAliasCondition(alias, profileSource),
            );
          }
        } else {
          const detailAuthorKey = requestedAliasKey?.alias ?? normalizedAuthorKey;
          detailConditions = [
            normalizedSignalAuthorCondition(detailAuthorKey, profileSource),
            normalizedLegacySignalAuthorCondition(detailAuthorKey, profileSource),
            canonicalSignalAliasCondition(detailAuthorKey, profileSource),
          ];
        }
        const authorCondition = or(...detailConditions)!;
        const authorDetailRows = await selectXSignalRows(ctx.db, start, authorCondition);
        const authorDetailBucket = resolveXCallerBucket(
          groupXLeaderboardCalls(authorDetailRows, durableGroupingOptions),
          normalizedAuthorKey,
        );

        if (!authorDetailBucket) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Caller not found" });
        }

        const summaryBucket = globalMetricBucket ?? authorDetailBucket;
        const resolvedAuthorKey =
          globalMetricEntry?.[0] ?? summaryBucket.canonicalKey ?? normalizedAuthorKey;

        // Use the same globally capped market population as xCallers. If the
        // shared cap omitted a market, the profile must omit it too or its
        // metrics could disagree with the row shown on the leaderboard.
        const allMarketRefs = collectBoundedMarketRefs(
          globalByAuthor,
          Number.MAX_SAFE_INTEGER,
        );
        const marketRefs = allMarketRefs.slice(0, MAX_X_MARKET_COUNT);
        const fetchedMarketData = await fetchXCallerMarketData(
          marketRefs,
          input.horizonDays,
        );
        const marketDataHealth = addOmittedMarketHealth(
          addUnresolvedMarketHealth(
            fetchedMarketData.health,
            countUnresolvedMarketCandidates(globalByAuthor),
          ),
          allMarketRefs.slice(MAX_X_MARKET_COUNT),
          MAX_X_MARKET_COUNT,
        );
        const hasMaster = Boolean(
          process.env.ALPACA_MASTER_KEY && process.env.ALPACA_MASTER_SECRET,
        );
        const anyMarketData = marketDataHealth.availableMarketCount > 0;
        const hasMarketCandidates = [...globalByAuthor.values()].some(
          (bucket) => bucket.measurementCalls.length > 0,
        );
        const meta = computeLeaderboardMeta({
          hasMaster,
          anyRowNeedsMarketData: globalMetricBucket
            ? xCallsNeedMarketData(globalMetricBucket.measurementCalls, fetchedMarketData.data)
            : false,
          hasMarketCandidates,
          providerMarketDataUnavailable:
            marketDataHealth.unavailableMarketCount > marketDataHealth.deadlineMarketCount,
          unresolvedMarketCandidateCount: marketDataHealth.unresolvedCandidateCount,
          marketDataComplete: marketDataHealth.complete,
          signalsWithinCap: globalPopulation.complete && durableOwners.complete,
          hasAnyMarketData: anyMarketData,
        });

        // When the author is in the global scoring population, show the exact
        // retained candidate calls passed to the scorer. The outside-scan path
        // remains author-scoped context and is explicitly labeled below.
        const scoreCalls = globalMetricBucket
          ? globalMetricBucket.measurementCalls
          : authorDetailBucket.recentCalls;
        const calls = scoreCalls.map((call) => {
          const measurement = globalMetricBucket
            ? computeXCallMeasurement(
              call,
              barsForXCall(call, fetchedMarketData.data),
              input.horizonDays,
            )
            : {
              forwardReturnPct: null,
              measurementStatus: "not_comparable" as const,
            };

          return {
            id: call.id,
            symbol: call.symbol,
            assetClass: call.assetClass,
            content: call.content,
            url: sanitizeXCallerSourceUrl(call.url),
            source: call.source,
            calledAt: call.callTime.toISOString(),
            direction: call.direction,
            ...measurement,
          };
        });
        const stats = globalMetricBucket
          ? measureXCallerBucket(
              globalMetricBucket,
              fetchedMarketData.data,
              input.horizonDays,
            ).stats
          : aggregateCallerStats([]);
        const measurementStatus: XCallerProfileMeasurementStatus =
          globalMetricBucket === undefined
            ? "not_comparable"
            : stats.measuredCallCount > 0
              ? "measured"
              : "unmeasured";

        return {
          followTarget: {
            type: "x_author" as const,
            key: resolvedAuthorKey,
            label: summaryBucket.label,
          },
          displayName: summaryBucket.label,
          avatar: authorDetailBucket.avatar,
          assetCoverage: bucketAssetCoverage(summaryBucket),
          assetCallCounts: summaryBucket.assetCallCounts,
          hitRate: globalMetricBucket ? stats.hitRate : null,
          avgForwardReturnPct: globalMetricBucket ? stats.avgForwardReturnPct : null,
          callCount: summaryBucket.totalCallCount,
          directionalCallCount: summaryBucket.directionalCallCount,
          measuredCallCount: globalMetricBucket ? stats.measuredCallCount : 0,
          measurementCandidateCount: globalMetricBucket
            ? globalMetricBucket.measurementCandidateCount
            : 0,
          measurementCallsRetainedCount: globalMetricBucket
            ? globalMetricBucket.measurementCallsRetainedCount
            : 0,
          measurementCandidateOmittedCount: globalMetricBucket
            ? globalMetricBucket.measurementCandidateOmittedCount
            : 0,
          measurementCallCap: MAX_X_MEASUREMENT_CALLS_PER_AUTHOR,
          measurementCapped: globalMetricBucket
            ? globalMetricBucket.measurementCandidateOmittedCount > 0
            : false,
          needsMarketData: globalMetricBucket
            ? xCallsNeedMarketData(globalMetricBucket.measurementCalls, fetchedMarketData.data)
            : false,
          measurementStatus,
          ...meta,
          marketDataHealth,
          signalScan,
          calls,
        };
      });

      return { ...payload, heuristic: true as const };
    }),
});

// ============================================
// Users compute helpers (module-private)
// ============================================

/**
 * Map an orders.tradeAction enum value to a buy/sell side. Any action containing
 * "buy" or "cover" (Buy, BuyToCover, BuyToOpen, BuyToClose) is a buy; everything
 * else (Sell, SellShort, SellToClose, SellToOpen) is a sell. Mirrors orders.ts
 * getAlpacaSide but is null-safe and never throws.
 */
function tradeActionSide(action: string | null | undefined): "buy" | "sell" {
  const a = (action ?? "").toLowerCase();
  if (a.includes("buy") || a.includes("cover")) return "buy";
  return "sell";
}

// ============================================
// X-caller compute helpers (module-private)
// ============================================

export function sortXCallerRows(
  rows: XCallerLeaderboardRow[],
  sortBy: "forwardReturn" | "hitRate" | "calls",
): XCallerLeaderboardRow[] {
  rows.sort((a, b) => {
    if (sortBy === "calls") {
      const countDifference = b.callCount - a.callCount;
      if (countDifference !== 0) return countDifference;
    } else {
      const aMetric = sortBy === "hitRate" ? a.hitRate : a.avgForwardReturnPct;
      const bMetric = sortBy === "hitRate" ? b.hitRate : b.avgForwardReturnPct;
      if (aMetric !== null || bMetric !== null) {
        if (aMetric === null) return 1;
        if (bMetric === null) return -1;
        const metricDifference = bMetric - aMetric;
        if (metricDifference !== 0 && Number.isFinite(metricDifference)) return metricDifference;
      }
      const countDifference = b.callCount - a.callCount;
      if (countDifference !== 0) return countDifference;
    }
    const aKey = a.followTarget.key;
    const bKey = b.followTarget.key;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return rows;
}

/** Use a short cache lifetime whenever an eligible call lacks market data. */
export function xCallersCacheTtlSeconds(needsMarketData: boolean): number {
  return needsMarketData
    ? XCALLERS_DEGRADED_TTL_SECONDS
    : XCALLERS_HEALTHY_TTL_SECONDS;
}

/** True when at least one candidate has no usable data from its own provider. */
export function xCallsNeedMarketData(
  calls: ReadonlyArray<{ symbol: string; marketRef?: XCallerMarketRef | null }>,
  marketData: ReadonlyMap<string, ReadonlyArray<unknown> | XCallerMarketData>,
): boolean {
  return calls.some((call) => {
    if (call.marketRef === null) return true;
    if (call.marketRef && !isUsableXCallerMarketRef(call.marketRef)) return true;
    const keys = call.marketRef ? [call.marketRef.key] : [call.symbol];
    const value = keys.map((key) => marketData.get(key)).find((entry) => entry !== undefined);
    if (Array.isArray(value)) return value.length === 0;
    return !value || !isXCallerMarketData(value) || value.status !== "available" || value.bars.length === 0;
  });
}

function barsForXCall(
  call: { symbol: string; marketRef?: XCallerMarketRef | null },
  marketData: ReadonlyMap<string, ReadonlyArray<DailyBar> | XCallerMarketData>,
): DailyBar[] | undefined {
  if (call.marketRef === null) return undefined;
  if (call.marketRef && !isUsableXCallerMarketRef(call.marketRef)) return undefined;
  const keys = call.marketRef ? [call.marketRef.key] : [call.symbol];
  for (const key of keys) {
    const value = marketData.get(key);
    if (Array.isArray(value)) return [...value];
    if (value && isXCallerMarketData(value)) return value.bars;
  }
  return undefined;
}

function isXCallerMarketData(
  value: ReadonlyArray<unknown> | XCallerMarketData,
): value is XCallerMarketData {
  return typeof value === "object" && value !== null && "status" in value && "bars" in value;
}

function isUsableXCallerMarketRef(ref: XCallerMarketRef): boolean {
  const canonical = ref.provider === "alpaca"
    ? parseCanonicalStockSymbol(ref.symbol)
    : parseCanonicalPerpCoin(ref.symbol);
  return canonical === ref.symbol && ref.key === `${ref.provider}:${ref.symbol}`;
}

export function aggregateXCallMeasurements(
  calls: ReadonlyArray<{
    symbol: string;
    assetClass: XCallerAssetClass;
    direction: XCallDirection;
    callTime: Date;
    marketRef?: XCallerMarketRef | null;
  }>,
  marketData: ReadonlyMap<string, DailyBar[] | XCallerMarketData>,
  horizonDays: number,
) {
  const returns = calls.map((call) => {
    const measurement = computeXCallMeasurement(
      call,
      barsForXCall(call, marketData),
      horizonDays,
    );
    return measurement.forwardReturnPct;
  });
  return aggregateCallerStats(returns);
}

/** The single bucket measurement used by both the global row and profile. */
function measureXCallerBucket(
  bucket: XCallerBucket,
  marketData: ReadonlyMap<string, DailyBar[] | XCallerMarketData>,
  horizonDays: number,
) {
  const stats = aggregateXCallMeasurements(bucket.measurementCalls, marketData, horizonDays);
  return {
    stats,
    needsMarketData: xCallsNeedMarketData(bucket.measurementCalls, marketData),
  };
}

function xCallerRowForBucket(
  authorKey: string,
  bucket: XCallerBucket,
  marketData: ReadonlyMap<string, DailyBar[] | XCallerMarketData>,
  horizonDays: number,
): XCallerLeaderboardRow {
  const measurement = measureXCallerBucket(bucket, marketData, horizonDays);
  return {
    followTarget: { type: "x_author", key: authorKey, label: bucket.label },
    displayName: bucket.label,
    avatar: bucket.avatar,
    assetCoverage: bucketAssetCoverage(bucket),
    assetCallCounts: bucket.assetCallCounts,
    hitRate: measurement.stats.hitRate,
    avgForwardReturnPct: measurement.stats.avgForwardReturnPct,
    callCount: bucket.totalCallCount,
    directionalCallCount: bucket.directionalCallCount,
    measuredCallCount: measurement.stats.measuredCallCount,
    measurementCandidateCount: bucket.measurementCandidateCount,
    measurementCallsRetainedCount: bucket.measurementCallsRetainedCount,
    measurementCandidateOmittedCount: bucket.measurementCandidateOmittedCount,
    measurementCallCap: MAX_X_MEASUREMENT_CALLS_PER_AUTHOR,
    measurementCapped: bucket.measurementCandidateOmittedCount > 0,
    needsMarketData: measurement.needsMarketData,
    latestCallUrl: latestCallSourceUrl(bucket.recentCalls),
  };
}

/** Collect unique provider-qualified markets across all authors, capped at `max`. */
export function collectBoundedMarketRefs(
  byAuthor: Map<string, XCallerBucket>,
  max: number,
): XCallerMarketRef[] {
  const seen = new Map<string, XCallerMarketRef>();
  for (const bucket of byAuthor.values()) {
    for (const call of bucket.measurementCalls) {
      if (!call.marketRef || !isUsableXCallerMarketRef(call.marketRef)) continue;
      if (!seen.has(call.marketRef.key)) seen.set(call.marketRef.key, call.marketRef);
    }
  }
  const all = [...seen.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  if (all.length > max) {
    logger.warn("leaderboard", "X-caller symbol set truncated", {
      total: all.length,
      cap: max,
    });
    return all.slice(0, max);
  }
  return all;
}

/** Count retained directional calls that cannot be assigned a safe market ref. */
export function countUnresolvedMarketCandidates(
  byAuthor: Map<string, XCallerBucket>,
): number {
  let count = 0;
  for (const bucket of byAuthor.values()) {
    for (const call of bucket.measurementCalls) {
      if (!call.marketRef || !isUsableXCallerMarketRef(call.marketRef)) count += 1;
    }
  }
  return count;
}

/** Collect unique symbols from one caller so unrelated authors cannot consume its cap. */
export function collectBoundedCallSymbols(
  calls: ReadonlyArray<{ symbol: string }>,
  max: number,
): string[] {
  return [...new Set(calls.map((call) => call.symbol))].slice(0, max);
}

/** Normalized daily bar: unix-seconds time + close. */
export type DailyBar = XCallerDailyBar;

export type XCallMeasurementStatus =
  | "direction_unknown"
  | "asset_class_unsupported"
  | "market_data_unavailable"
  | "horizon_incomplete"
  | "measured";

/** Measure one directional stock or perp call against its own provider bars. */
export function computeXCallMeasurement(
  call: {
    assetClass: XCallerAssetClass;
    direction: XCallDirection;
    callTime: Date;
  },
  bars: DailyBar[] | undefined,
  horizonDays: number,
): {
  forwardReturnPct: number | null;
  measurementStatus: XCallMeasurementStatus;
} {
  if (call.direction === "unknown") {
    return { forwardReturnPct: null, measurementStatus: "direction_unknown" };
  }
  if (!bars || bars.length === 0) {
    return {
      forwardReturnPct: null,
      measurementStatus: "market_data_unavailable",
    };
  }

  const rawReturn = computeCallForwardReturn(bars, call.callTime, horizonDays);
  const adjustedReturn = scoreXCallReturn(rawReturn, call.direction);
  return adjustedReturn === null
    ? { forwardReturnPct: null, measurementStatus: "horizon_incomplete" }
    : { forwardReturnPct: adjustedReturn, measurementStatus: "measured" };
}

/**
 * Max gap (seconds) tolerated between the call time and the chosen ENTRY bar. The
 * bar window (getBars("1D", ~400)) only spans ~400 calendar days, so a call older
 * than the oldest bar would otherwise snap its entry to bars[0] and report a
 * fabricated return. 5 CALENDAR days of slack covers a market closure of a long
 * weekend plus an adjacent holiday (e.g. Fri call, markets closed Mon) while still
 * rejecting an out-of-range anchor.
 */
const ENTRY_ANCHOR_MAX_GAP_SEC = 5 * 24 * 60 * 60;

/**
 * Compute the forward return for one call: entry = the first daily close
 * at/after the call time; exit = the first daily close at/after (callTime +
 * horizonDays). Returns null (UNMEASURABLE) when:
 *   - bars is empty;
 *   - no bar exists at/after the call (call is newer than the latest bar); or
 *   - the entry bar is more than 5 CALENDAR days after the call — i.e. the call
 *     predates the bar window and snapped to the oldest bar (fabricated return);
 *   - no bar exists at/after the exit anchor (horizon runs past the bar window).
 *
 * `bars` must be ascending by time (getBars returns ascending).
 */
export function computeCallForwardReturn(
  bars: DailyBar[],
  callTime: Date,
  horizonDays: number,
): number | null {
  if (
    bars.length === 0 ||
    !Number.isFinite(callTime.getTime()) ||
    !Number.isFinite(horizonDays) ||
    horizonDays <= 0 ||
    horizonDays > 3650
  ) return null;
  const callSec = Math.floor(callTime.getTime() / 1000);
  const exitSec = callSec + horizonDays * 24 * 60 * 60;

  const entry = firstCloseAtOrAfter(bars, callSec);
  if (entry === null) return null;
  // Range-check the entry anchor: if the nearest bar at/after the call is more
  // than ~5 trading days out, the call predates the bar window and we'd be
  // anchoring to an unrelated (oldest available) bar — refuse to measure.
  if (entry.time - callSec > ENTRY_ANCHOR_MAX_GAP_SEC) return null;

  const exit = firstCloseAtOrAfter(bars, exitSec);
  if (exit === null) return null; // horizon ran past the available bars
  if (exit.time <= entry.time) return null; // market closure resolved both anchors to one bar

  return forwardReturnPct(entry.close, exit.close);
}

/** First bar whose time is >= `sec` (bars ascending), or null if none. */
function firstCloseAtOrAfter(bars: DailyBar[], sec: number): DailyBar | null {
  for (const bar of bars) {
    if (bar.time >= sec) return bar;
  }
  return null;
}
