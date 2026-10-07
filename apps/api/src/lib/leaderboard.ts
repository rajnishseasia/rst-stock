/**
 * Leaderboard performance helpers (Phase 4).
 *
 * Pure, DB/broker-free functions that reconstruct APPROXIMATE trader/caller
 * performance from the data we actually have. They are deliberately side-effect
 * free so the router can unit-test the math without a database or Alpaca.
 *
 * HONESTY: these are heuristics, not audited P&L.
 *   - User metrics are reconstructed from shared trade EVENTS only (social_trades
 *     side/qty + the joined orders fill price, direction, assetType and option
 *     contract identity). FIFO-paired into closed lots, direction-aware (long AND
 *     short), with the options 100x contract multiplier applied at the contract
 *     level. No account-size context; open/unfilled lots excluded — see
 *     reconstructRealizedPnl.
 *   - X-caller metrics are forward-return heuristics on the ticker after a call,
 *     NOT the caller's realized P&L — see aggregateCallerStats.
 */

import type { XCallDirection } from "./x-call-direction.js";
import { isValidOptionContractIdentity } from "./options.js";
import { parseStrictFiniteNumber } from "./strict-number.js";
import {
  MAX_SAFE_TRADING_PERP_SIZE,
  MAX_SAFE_TRADING_VALUE,
} from "@trade-bot/utils";

// ============================================
// Users tab: reconstructed realized P&L (FIFO)
// ============================================

/** Options contracts settle 100 shares per contract; equities are 1:1. */
export const OPTION_CONTRACT_MULTIPLIER = 100;

/** Broker lifecycle states that can carry an authoritative cumulative fill. */
export const LEADERBOARD_FILL_STATUSES = [
  "FILLED",
  "CANCELLED",
  "EXPIRED",
  "REJECTED",
  "PARTIAL",
] as const;

/** Shared precedence ranks used by application canonicalization and SQL. */
export const LEADERBOARD_EXECUTION_STATUS_RANK = {
  PARTIAL: 1,
  CANCELLED: 2,
  EXPIRED: 2,
  REJECTED: 2,
  FILLED: 3,
} as const;

/**
 * Open lots must remain available for a later FIFO close. The router therefore
 * fails closed at this bound instead of dropping old lots and fabricating P&L.
 */
export const DEFAULT_MAX_OPEN_FIFO_LOTS = 20_000;
export const DEFAULT_MAX_LEADERBOARD_EVENTS = 20_000;
export const DEFAULT_MAX_LEADERBOARD_USERS = 5_000;
export const DEFAULT_MAX_LEADERBOARD_BUCKETS = 20_000;

/** orders.executed_size_decimal is decimal(24,8); FIFO uses the same fixed scale. */
export const LEADERBOARD_PERP_SIZE_SCALE = 8;
export const MAX_SAFE_LEADERBOARD_PERP_SIZE_UNITS = BigInt(MAX_SAFE_TRADING_VALUE);
export const MAX_SAFE_LEADERBOARD_PERP_SIZE = MAX_SAFE_TRADING_PERP_SIZE;
/** Bound non-PERP values before price * quantity * multiplier arithmetic. */
export const MAX_SAFE_LEADERBOARD_NON_PERP_VALUE = MAX_SAFE_TRADING_VALUE;
export const MAX_SAFE_LEADERBOARD_NON_PERP_VALUE_SQL = String(
  MAX_SAFE_LEADERBOARD_NON_PERP_VALUE,
);
/** X forward-return guardrails keep hostile or corrupt bar data from poisoning rankings. */
export const MAX_SAFE_X_RETURN_PCT = 1_000_000;
export const MAX_SAFE_X_BAR_PRICE = 1_000_000_000;

export class LeaderboardFifoCapacityError extends Error {
  readonly resource: "events" | "users" | "buckets" | "openLots";
  readonly limit: number;

  constructor(
    limit: number,
    resource: "events" | "users" | "buckets" | "openLots" = "openLots",
  ) {
    super(
      `Leaderboard FIFO state exceeded the ${resource} limit of ${limit}`,
    );
    this.name = "LeaderboardFifoCapacityError";
    this.resource = resource;
    this.limit = limit;
  }
}

/**
 * A single chronological trade event for ONE contract bucket (one user + one
 * contract identity).
 *
 * `direction` is the position direction the event opens/closes against:
 *   - "long":  buy opens, sell closes.
 *   - "short": sell opens (SellShort), buy closes (BuyToCover).
 * It comes from the joined orders.direction; social_trades.side alone is
 * ambiguous (it collapses SellShort -> "sell" and BuyToCover -> "buy").
 */
export interface TradeEvent {
  side: "buy" | "sell";
  /** Position direction this event belongs to (from orders.direction). */
  direction: "long" | "short";
  /** Authoritative cumulative fill quantity (orders.executedQuantity). */
  qty: number;
  /** Fill price (orders.executedPrice). Null when unfilled — such events are ignored. */
  price: number | null;
  /**
   * Per-unit value multiplier: 100 for OPTION (contract multiplier), 1 for
   * EQUITY. Applied to every closed-lot P&L so option contracts aren't valued
   * like single shares.
   */
  multiplier: number;
  /** ISO timestamp of this event (used to attribute closed lots to a window). */
  at: string | null;
}

/** One closed lot: a FIFO pairing of an open event against a later close event. */
export interface ClosedLot {
  /** Realized P&L for this lot (already includes the contract multiplier). */
  pnl: number;
  /** True when pnl > 0. */
  win: boolean;
  /** ISO timestamp of the CLOSE event (sell for long / cover for short). */
  closeAt: string | null;
}

export interface RealizedPnlResult {
  realizedPnl: number;
  /** closedLotsWithPositivePnl / closedTrades, in [0,1]. 0 when there are no closed trades. */
  winRate: number;
  /** Count of closed lots produced by FIFO-pairing closes against prior opens. */
  closedTrades: number;
  /** Per-closed-lot detail so the router can window by close-time + re-aggregate. */
  closedLots: ClosedLot[];
}

/** One open lot still waiting to be matched by a future close (same direction). */
interface OpenLot {
  qty: number;
  price: number;
  multiplier: number;
}

/**
 * FIFO-reconstruct realized P&L from a chronological event stream for ONE
 * CONTRACT BUCKET (one user + one contract identity — equity ticker, or a
 * specific option expiration/strike/type).
 *
 * Direction-aware model (two independent FIFO queues per bucket):
 *   LONG lots:  a "long" buy OPENS a lot; a "long" sell CLOSES the oldest open
 *               long lot; pnl = (closePrice - openPrice) * qty * multiplier.
 *   SHORT lots: a "short" sell OPENS a lot; a "short" buy CLOSES the oldest open
 *               short lot; pnl = (openPrice - closePrice) * qty * multiplier.
 *
 *   A short-cover (direction "short", side "buy") NEVER opens a long lot, and a
 *   short-open (direction "short", side "sell") NEVER touches the long queue —
 *   the two directions are matched in fully separate queues so the collapsed
 *   social_trades.side can no longer fabricate phantom long P&L on shorts.
 *
 * Honest exclusions (so we never overstate performance):
 *   - Events with a null price (unfilled) are skipped entirely.
 *   - Non-positive quantities are skipped.
 *   - A close with no matching prior open of the SAME direction is skipped.
 *   - Leftover open lots at the end are NOT counted (open, unrealized).
 *
 * Returns one ClosedLot per (openLot, closeQtySlice) pairing, stamped with the
 * CLOSE event timestamp so the router can attribute a round-trip to a window by
 * when it CLOSED (not by when raw events fell). Deterministic: same input order
 * -> same output.
 */
export function reconstructRealizedPnl(events: TradeEvent[]): RealizedPnlResult {
  const longLots: OpenLot[] = [];
  const shortLots: OpenLot[] = [];
  let realizedPnl = 0;
  let wins = 0;
  const closedLots: ClosedLot[] = [];

  for (const ev of events) {
    // Skip unfilled, non-finite, and unreasonably large values before any
    // multiplication can turn a finite input into Infinity.
    if (
      ev.price === null ||
      !Number.isFinite(ev.price) ||
      ev.price <= 0 ||
      ev.price > MAX_SAFE_LEADERBOARD_NON_PERP_VALUE
    ) continue;
    if (
      !Number.isFinite(ev.qty) ||
      ev.qty <= 0 ||
      ev.qty > MAX_SAFE_LEADERBOARD_NON_PERP_VALUE
    ) continue;
    const mult = Number.isFinite(ev.multiplier) && ev.multiplier > 0 ? ev.multiplier : 1;

    const isOpen =
      (ev.direction === "long" && ev.side === "buy") ||
      (ev.direction === "short" && ev.side === "sell");

    if (isOpen) {
      const queue = ev.direction === "long" ? longLots : shortLots;
      queue.push({ qty: ev.qty, price: ev.price, multiplier: mult });
      continue;
    }

    // Close event: FIFO-match against the oldest open lots of the SAME direction.
    const queue = ev.direction === "long" ? longLots : shortLots;
    let remaining = ev.qty;
    while (remaining > 0 && queue.length > 0) {
      const lot = queue[0]!;
      const matchedQty = Math.min(remaining, lot.qty);
      // Long: profit when close > open. Short: profit when open > close.
      const perUnit =
        ev.direction === "long" ? ev.price - lot.price : lot.price - ev.price;
      const lotPnl = perUnit * matchedQty * lot.multiplier;

      const nextRealizedPnl = realizedPnl + lotPnl;
      if (!Number.isFinite(lotPnl) || !Number.isFinite(nextRealizedPnl)) {
        lot.qty -= matchedQty;
        remaining -= matchedQty;
        if (lot.qty <= 0) queue.shift();
        continue;
      }

      realizedPnl = nextRealizedPnl;
      const win = lotPnl > 0;
      if (win) wins += 1;
      closedLots.push({ pnl: lotPnl, win, closeAt: ev.at });

      lot.qty -= matchedQty;
      remaining -= matchedQty;
      if (lot.qty <= 0) queue.shift();
    }
    // Any `remaining` here is a close with no matching open of this direction ->
    // skipped (we never open the opposite direction from a stray close).
  }

  const closedTrades = closedLots.length;
  const winRate = closedTrades > 0 ? wins / closedTrades : 0;
  return { realizedPnl, winRate, closedTrades, closedLots };
}

// ============================================
// Users tab: social×order JOIN rows -> per-user event buckets (pure)
// ============================================

/**
 * One raw row from the social_trades × orders join the users leaderboard reads.
 * Kept loose (strings from pg) so the pure grouper can be tested without a DB.
 */
export interface SocialOrderRow {
  userId: string;
  /** The fill identity. Multiple rows can share this (non-unique index fan-out). */
  brokerOrderId: string | null;
  /**
   * social_trades.id. The router supplies this as the first stable tie-breaker
   * when multiple events have the same venue timestamp.
   */
  socialTradeId?: string | null;
  /** orders.id — a stable tie-breaker and canonical-row selector. */
  orderId: string;
  /** Broker account identity. Paper and Live accounts must never share FIFO lots. */
  brokerAccountId?: string | null;
  /** Credential identity, which distinguishes accounts with reused broker IDs. */
  brokerCredentialId?: string | null;
  /** Venue identity, for example "alpaca" or "hyperliquid". */
  venue?: string | null;
  symbol: string | null;
  assetType: string | null;
  tradeAction: string | null;
  direction: string | null;
  reduceOnly?: boolean | null;
  optionExpiration: string | null;
  optionStrike: string | null;
  optionType: string | null;
  executedPrice: string | null;
  executedQuantity: number | null;
  /** Exact Hyperliquid fill size; authoritative when assetType is PERP. */
  executedSizeDecimal?: string | null;
  status: string | null;
  /** Broker/venue fill event time, preferred over the social submission time. */
  executedAt?: Date | string | null;
  /** Lossless six-digit UTC event key selected by the leaderboard query. */
  eventAt?: string | null;
  /** Social-trade submission time, used as the deterministic legacy fallback. */
  createdAt: Date | string | null;
}

/** A user's contract bucket: chronological events + the bucket's last trade time. */
export interface ContractBucket {
  events: TradeEvent[];
  lastTradeAt: string | null;
}

type TradeEventTimeRow = Pick<SocialOrderRow, "executedAt" | "createdAt"> & {
  eventAt?: string | null;
};

/**
 * Normalize a timestamp to a fixed-width UTC key with PostgreSQL's maximum
 * fractional precision. Dates are still accepted for legacy callers, but they
 * can only carry milliseconds; query rows use `eventAt` so their microseconds
 * survive the round trip.
 */
function normalizeTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const sourceFraction = typeof value === "string"
    ? /T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value)?.[1]
    : undefined;
  const fraction = sourceFraction === undefined
    ? `${date.getUTCMilliseconds().toString().padStart(3, "0")}000`
    : sourceFraction.padEnd(6, "0").slice(0, 6);
  return `${date.toISOString().slice(0, 19)}.${fraction}Z`;
}

function displayTimestamp(timestampKey: string): string {
  const match = /^(.*\.)(\d{6})Z$/.exec(timestampKey);
  if (!match) return timestampKey;
  let fraction = match[2]!.replace(/0+$/, "");
  if (fraction.length < 3) fraction = fraction.padEnd(3, "0");
  return `${match[1]}${fraction}Z`;
}

/**
 * Resolve the chronological event time for a social/order row.
 *
 * The venue's executedAt is authoritative when present. Older rows and some
 * legacy venue records do not have it, so the deterministic fallback is the
 * social-trade createdAt submission time. That fallback preserves visibility
 * without pretending that an unknown venue fill time is known.
 */
export function resolveTradeEventKey(row: TradeEventTimeRow): string | null {
  return normalizeTimestamp(row.eventAt) ?? normalizeTimestamp(row.executedAt) ?? normalizeTimestamp(row.createdAt);
}

export function resolveTradeEventAt(row: TradeEventTimeRow): string | null {
  const eventKey = resolveTradeEventKey(row);
  return eventKey === null ? null : displayTimestamp(eventKey);
}

function normalizedVenue(row: SocialOrderRow): string {
  return row.venue ? row.venue.toLowerCase() : "alpaca";
}

function accountScope(row: SocialOrderRow): [string | null, string | null, string] {
  return [row.brokerAccountId ?? null, row.brokerCredentialId ?? null, normalizedVenue(row)];
}

function hasExplicitPositionScope(row: SocialOrderRow): boolean {
  return row.brokerAccountId !== null && row.brokerAccountId !== undefined &&
    row.brokerCredentialId !== null && row.brokerCredentialId !== undefined &&
    row.venue !== null && row.venue !== undefined;
}

/**
 * Perp orders identify the account via the wallet address (brokerAccountId),
 * not the credential UUID. Orders placed before broker_credential_id was
 * reliably populated are in the same wallet-level position as later ones, so
 * treat brokerAccountId alone as sufficient scope for PERP FIFO matching.
 * This prevents per-social-trade bucket isolation that makes buy/sell pairs
 * unmatchable when broker_credential_id is missing.
 */
function hasPerpAccountScope(row: SocialOrderRow): boolean {
  return row.assetType === "PERP" &&
    row.brokerAccountId !== null && row.brokerAccountId !== undefined &&
    row.venue !== null && row.venue !== undefined;
}

function hasStableUnknownScopeIdentity(row: SocialOrderRow): boolean {
  return !hasExplicitPositionScope(row) && !hasPerpAccountScope(row);
}

function unknownScopeEventId(row: SocialOrderRow): string {
  return row.socialTradeId ?? row.orderId;
}

/** The deduplication identity for one user's one venue/account fill event. */
function eventIdentity(row: SocialOrderRow): string | null {
  if (!row.brokerOrderId) return null;
  const identity = [row.userId, ...accountScope(row), row.brokerOrderId];
  if (hasStableUnknownScopeIdentity(row)) identity.push(unknownScopeEventId(row));
  return JSON.stringify(identity);
}

function positionBucketKey(row: SocialOrderRow): string {
  const symbol = (row.symbol ?? "").toUpperCase();
  const isOption = row.assetType === "OPTION";
  const base = row.assetType === "PERP"
    ? `PERP|${symbol}`
    : isOption
    ? [
        "OPT",
        symbol,
        row.optionExpiration ?? "",
        row.optionStrike ?? "",
        (row.optionType ?? "").toUpperCase(),
      ].join("|")
    : `EQ|${symbol}`;

  // PERP orders: wallet address (brokerAccountId) is the unique account
  // identifier. Credential UUID is redundant for scope — use the address
  // alone so early orders (missing broker_credential_id) still land in the
  // same FIFO bucket as later ones on the same wallet.
  if (hasPerpAccountScope(row)) {
    const venue = normalizedVenue(row);
    return `${base}|perp-acct:${JSON.stringify([row.brokerAccountId, venue])}`;
  }
  if (hasExplicitPositionScope(row)) {
    return `${base}|scope:${JSON.stringify(accountScope(row))}`;
  }
  if (hasStableUnknownScopeIdentity(row)) {
    return `${base}|unknown:${eventIdentity(row)}`;
  }
  return base;
}

function stableSocialTradeId(row: SocialOrderRow): string {
  return row.socialTradeId ?? "";
}

export interface LeaderboardEventCursor {
  eventAt: string;
  socialTradeId: string;
  orderId: string;
}

export function resolveLeaderboardEventCursor(
  row: Pick<SocialOrderRow, "eventAt" | "executedAt" | "createdAt" | "socialTradeId" | "orderId">,
): LeaderboardEventCursor | null {
  const eventAt = resolveTradeEventKey(row);
  return eventAt === null
    ? null
    : { eventAt, socialTradeId: row.socialTradeId ?? "", orderId: row.orderId };
}

export function compareLeaderboardEventRows(a: SocialOrderRow, b: SocialOrderRow): number {
  const aAt = resolveTradeEventKey(a);
  const bAt = resolveTradeEventKey(b);
  if (aAt === null && bAt !== null) return 1;
  if (aAt !== null && bAt === null) return -1;
  if (aAt !== bAt) return aAt! < bAt! ? -1 : 1;

  const socialIdComparison = compareStableIds(stableSocialTradeId(a), stableSocialTradeId(b));
  if (socialIdComparison !== 0) return socialIdComparison;

  const orderIdComparison = compareStableIds(a.orderId, b.orderId);
  if (orderIdComparison !== 0) return orderIdComparison;

  // The router's socialTradeId + orderId pair is unique. This final comparison
  // keeps pure-helper inputs deterministic when those optional IDs are omitted.
  return compareStableIds(eventIdentity(a) ?? "", eventIdentity(b) ?? "");
}

export function isAfterLeaderboardEventCursor(
  row: Pick<SocialOrderRow, "eventAt" | "executedAt" | "createdAt" | "socialTradeId" | "orderId">,
  cursor: LeaderboardEventCursor,
): boolean {
  const rowCursor = resolveLeaderboardEventCursor(row);
  if (rowCursor === null) return false;
  if (rowCursor.eventAt !== cursor.eventAt) return rowCursor.eventAt > cursor.eventAt;
  if (rowCursor.socialTradeId !== cursor.socialTradeId) {
    return rowCursor.socialTradeId > cursor.socialTradeId;
  }
  return rowCursor.orderId > cursor.orderId;
}

function compareStableIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function leaderboardExecutionStatusRank(status: string | null | undefined): number {
  return LEADERBOARD_EXECUTION_STATUS_RANK[
    status as keyof typeof LEADERBOARD_EXECUTION_STATUS_RANK
  ] ?? 0;
}

function parseFiniteNumber(value: string | number | null | undefined): number | null {
  return parseStrictFiniteNumber(value);
}

interface DecimalParts {
  coefficient: bigint;
  scale: number;
}

function parseDecimalParts(value: string | number | null | undefined): DecimalParts | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? value.toString() : value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;

  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) return null;

  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  let coefficient = BigInt(digits);
  if (match[1] === "-") coefficient = -coefficient;
  let scale = fraction.length - exponent;

  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function compareDecimalParts(a: DecimalParts, b: DecimalParts): number {
  const scale = Math.max(a.scale, b.scale);
  const aCoefficient = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bCoefficient = b.coefficient * 10n ** BigInt(scale - b.scale);
  return aCoefficient < bCoefficient ? -1 : aCoefficient > bCoefficient ? 1 : 0;
}

function authoritativeQuantityValue(row: SocialOrderRow): string | number | null | undefined {
  return row.assetType === "PERP" ? row.executedSizeDecimal : row.executedQuantity;
}

function compareAuthoritativeExecutedQuantities(
  a: SocialOrderRow,
  b: SocialOrderRow,
): number {
  const aQuantity = parseDecimalParts(authoritativeQuantityValue(a));
  const bQuantity = parseDecimalParts(authoritativeQuantityValue(b));
  if (aQuantity === null && bQuantity === null) return 0;
  if (aQuantity === null) return 1;
  if (bQuantity === null) return -1;
  // A larger cumulative quantity is stronger, so reverse ascending decimal order.
  return -compareDecimalParts(aQuantity, bQuantity);
}

/** The cumulative executed field that is authoritative for canonical choice. */
export function resolveAuthoritativeExecutedQuantity(
  row: SocialOrderRow,
): number | null {
  return row.assetType === "PERP"
    ? parseFiniteNumber(row.executedSizeDecimal)
    : parseFiniteNumber(row.executedQuantity);
}

function resolveSafePerpQuantityUnits(value: string | null | undefined): bigint | null {
  const parts = parseDecimalParts(value);
  if (!parts || parts.coefficient <= 0n) return null;

  let units = parts.coefficient;
  if (parts.scale < LEADERBOARD_PERP_SIZE_SCALE) {
    units *= 10n ** BigInt(LEADERBOARD_PERP_SIZE_SCALE - parts.scale);
  } else if (parts.scale > LEADERBOARD_PERP_SIZE_SCALE) {
    const divisor = 10n ** BigInt(parts.scale - LEADERBOARD_PERP_SIZE_SCALE);
    if (units % divisor !== 0n) return null;
    units /= divisor;
  }
  return units <= MAX_SAFE_LEADERBOARD_PERP_SIZE_UNITS ? units : null;
}

/**
 * Canonical fan-out precedence, from strongest to weakest:
 *
 * 1. A usable real fill beats an unusable/submitted row.
 * 2. FILLED beats terminal partial states, which beat a live PARTIAL snapshot.
 * 3. The larger authoritative cumulative executed quantity wins.
 * 4. The later venue execution timestamp wins; a missing timestamp loses.
 * 5. Lower stable order ID, then lower stable social-trade ID, wins.
 *
 * The bounded router query supplies every candidate row; this comparator is
 * the single canonical precedence implementation.
 */
export function compareCanonicalCandidates(a: SocialOrderRow, b: SocialOrderRow): number {
  const aHasFill = resolveEventPriceQty(a) !== null;
  const bHasFill = resolveEventPriceQty(b) !== null;
  if (aHasFill !== bHasFill) return aHasFill ? -1 : 1;

  const statusRankDifference =
    leaderboardExecutionStatusRank(b.status) - leaderboardExecutionStatusRank(a.status);
  if (statusRankDifference !== 0) return statusRankDifference;

  const quantityComparison = compareAuthoritativeExecutedQuantities(a, b);
  if (quantityComparison !== 0) return quantityComparison;

  const aExecutedAt = normalizeTimestamp(a.executedAt);
  const bExecutedAt = normalizeTimestamp(b.executedAt);
  if (aExecutedAt !== bExecutedAt) {
    if (aExecutedAt === null) return 1;
    if (bExecutedAt === null) return -1;
    return bExecutedAt > aExecutedAt ? 1 : -1;
  }

  const orderIdComparison = compareStableIds(a.orderId, b.orderId);
  if (orderIdComparison !== 0) return orderIdComparison;
  return compareStableIds(stableSocialTradeId(a), stableSocialTradeId(b));
}

/**
 * Canonicalize join fan-out before FIFO accumulation.
 *
 * Rows are grouped by user + broker account + credential + venue + broker ID.
 * Within each event, candidates follow compareCanonicalCandidates so a
 * lower-ID partial snapshot cannot hide a later authoritative fill.
 */
export function canonicalizeTradeRows(rows: SocialOrderRow[]): SocialOrderRow[] {
  const canonicalByEvent = new Map<string, SocialOrderRow>();
  for (const row of rows) {
    const key = eventIdentity(row);
    if (key === null) continue;
    const previous = canonicalByEvent.get(key);
    if (previous === undefined || compareCanonicalCandidates(row, previous) < 0) {
      canonicalByEvent.set(key, row);
    }
  }

  return [...canonicalByEvent.values()]
    .filter((row) => resolveEventPriceQty(row) !== null)
    .sort(compareLeaderboardEventRows);
}

/**
 * Resolve the (price, qty) a single social×order row contributes to FIFO, or
 * null to skip it.
 *
 * Realized P&L must depend on an ACTUAL FILL, never on mere broker acceptance.
 * OPEN and CLOSE events are symmetric: both require a REAL fill, i.e. status
 * FILLED, PARTIAL, or a terminal state carrying a partial fill, a positive
 * executed quantity/size, and a finite positive executedPrice. A SUBMITTED
 * (accepted-but-unfilled) order is NEVER counted:
 * e.g. a shared limit sell resting above the market may never fill, and counting
 * it as a realized close would fabricate a win/loss. Neither the limit price nor
 * the requested quantity is ever used as a proxy.
 *
 * NOTE: this predicate intentionally matches pre-PR behavior. A Codex review
 * rejected counting accepted-but-unfilled closes because it fabricates P&L, so
 * the "0 closed trades" symptom is NOT fixed by this PR. Closed-trade stats
 * only populate if the worker's OrderSyncPoller is actually running in the
 * deployment: it backfills executedPrice/executedQuantity from
 * filled_avg_price/filled_qty (see apps/worker/src/services/order-sync.ts),
 * which turns the row into a real-fill lifecycle state so it is counted here. If the symptom
 * persists in prod, check that the worker is deployed and reconciling.
 */
export function resolveEventPriceQty(
  row: SocialOrderRow,
): { price: number; qty: number; qtyUnits?: bigint } | null {
  if (!LEADERBOARD_FILL_STATUSES.includes(row.status as (typeof LEADERBOARD_FILL_STATUSES)[number])) {
    return null;
  }
  const price = parseFiniteNumber(row.executedPrice);
  if (
    price === null ||
    price <= 0 ||
    price > MAX_SAFE_LEADERBOARD_NON_PERP_VALUE
  ) return null;

  if (
    row.assetType === "OPTION" &&
    !isValidOptionContractIdentity({
      optionExpiration: row.optionExpiration,
      optionStrike: row.optionStrike,
      optionType: row.optionType,
    })
  ) return null;

  if (row.assetType === "PERP") {
    const qtyUnits = resolveSafePerpQuantityUnits(row.executedSizeDecimal);
    if (qtyUnits === null) return null;
    return {
      price,
      qty: Number(qtyUnits) / 10 ** LEADERBOARD_PERP_SIZE_SCALE,
      qtyUnits,
    };
  }

  const quantity = resolveAuthoritativeExecutedQuantity(row);
  if (
    quantity === null ||
    quantity <= 0 ||
    quantity > MAX_SAFE_LEADERBOARD_NON_PERP_VALUE
  ) return null;
  return { price, qty: quantity };
}

/**
 * Group social×order JOIN rows into per-user, per-contract-bucket event streams.
 *
 * The orders.broker_order_id index is NON-UNIQUE, so the join fans out two ways
 * and BOTH must be collapsed or a single fill is double-counted. Canonicalization
 * groups by user + broker account + credential + venue + brokerOrderId, prefers a
 * usable FILLED/PARTIAL execution, and then uses stable IDs for deterministic
 * selection. This handles social-side and order-side fan-out together.
 *
 * Bucketing keys by CONTRACT IDENTITY (equities on symbol; options additionally
 * on expiration/strike/type) so distinct instruments never cross-match in FIFO.
 * Only FILLED/PARTIAL rows with a usable executed qty + price are kept.
 *
 * `tradeActionSide` maps orders.tradeAction -> buy/sell (passed in so the lib
 * stays free of the router's enum mapping).
 */
export function groupTradeEventsByUser(
  rows: SocialOrderRow[],
  tradeActionSide: (action: string | null | undefined) => "buy" | "sell",
): Map<string, Map<string, ContractBucket>> {
  const byUser = new Map<string, Map<string, ContractBucket>>();
  const lastEventKeyByGroup = new Map<string, string>();
  for (const r of canonicalizeTradeRows(rows)) {
    const symbol = (r.symbol ?? "").toUpperCase();
    if (!symbol) continue;

    const isOption = r.assetType === "OPTION";
    const multiplier = isOption ? OPTION_CONTRACT_MULTIPLIER : 1;
    const storedDirection: "long" | "short" = r.direction === "short" ? "short" : "long";
    // Perp reduce-only rows store the order side (sell=short, buy=long), while
    // FIFO needs the position side being reduced. Flip only for these closes.
    const direction: "long" | "short" = r.assetType === "PERP" && r.reduceOnly
      ? storedDirection === "long" ? "short" : "long"
      : storedDirection;
    const side: "buy" | "sell" = tradeActionSide(r.tradeAction);

    // Real fills only: opens AND closes require a FILLED/PARTIAL row with
    // executed price + qty. A SUBMITTED (accepted-but-unfilled) order is never
    // counted; a genuine fill is picked up once order-sync reconciles it.
    const resolved = resolveEventPriceQty(r);
    if (!resolved) continue;
    const { price, qty } = resolved;

    const bucketKey = positionBucketKey(r);

    let userMap = byUser.get(r.userId);
    if (!userMap) {
      userMap = new Map();
      byUser.set(r.userId, userMap);
    }
    let group = userMap.get(bucketKey);
    if (!group) {
      group = { events: [], lastTradeAt: null };
      userMap.set(bucketKey, group);
    }
    const eventAtKey = resolveTradeEventKey(r);
    const eventAt = eventAtKey === null ? null : displayTimestamp(eventAtKey);
    group.events.push({ side, direction, qty, price, multiplier, at: eventAt });
    const groupIdentity = JSON.stringify([r.userId, bucketKey]);
    const previousEventKey = lastEventKeyByGroup.get(groupIdentity);
    if (eventAtKey && (previousEventKey === undefined || eventAtKey > previousEventKey)) {
      lastEventKeyByGroup.set(groupIdentity, eventAtKey);
      group.lastTradeAt = eventAt;
    }
  }

  return byUser;
}

/** Per-user input: every (bucket -> reconstruction) plus the bucket's last trade time. */
export interface UserSymbolReconstruction {
  result: RealizedPnlResult;
  /** ISO timestamp of the most recent event for this bucket (any side). */
  lastTradeAt: string | null;
}

export interface AggregatedUserStats {
  realizedPnl: number;
  /** Aggregate win rate across ALL closed lots (sum of wins / sum of closed lots). */
  winRate: number;
  /** Total closed lots across all buckets. */
  tradeCount: number;
  /** ISO timestamp of the user's most recent trade across all buckets, or null. */
  lastTradeAt: string | null;
  /** Realized P&L from Alpaca (stocks/equities) trades only. */
  alpacaPnl: number;
  /** Realized P&L from Hyperliquid (perps) trades only. */
  hyperliquidPnl: number;
}

interface StreamingOpenLot {
  qty: number;
  qtyUnits?: bigint;
  price: number;
  multiplier: number;
}

interface StreamingBucket {
  longLots: StreamingOpenLot[];
  shortLots: StreamingOpenLot[];
}

interface StreamingUserStats {
  realizedPnl: number;
  wins: number;
  tradeCount: number;
  lastTradeAt: string | null;
  lastTradeAtKey: string | null;
  alpacaPnl: number;
  hyperliquidPnl: number;
}

/**
 * Reconstruct user FIFO performance from bounded keyset pages. The router's SQL
 * subquery canonicalizes fan-out before applying the keyset, so this accumulator
 * only retains live FIFO lots and aggregate counters. Its memory use is bounded
 * by `maxOpenLots` live lots and active contract buckets, not by trade history.
 * Exceeding that cap throws instead of silently discarding lots that could be
 * needed for a later close.
 */
export class UserLeaderboardAccumulator {
  private readonly bucketsByUser = new Map<string, Map<string, StreamingBucket>>();
  private readonly statsByUser = new Map<string, StreamingUserStats>();
  private readonly windowFloorKey: string | null;
  private readonly maxOpenLots: number;
  private readonly maxEvents: number;
  private readonly maxUsers: number;
  private readonly maxBuckets: number;
  private openLotCount = 0;
  private ingestedEventCount = 0;
  private bucketCount = 0;

  constructor(
    windowFloorIso: string | null,
    options: {
      maxOpenLots?: number;
      maxEvents?: number;
      maxUsers?: number;
      maxBuckets?: number;
    } = {},
  ) {
    this.windowFloorKey = normalizeTimestamp(windowFloorIso);
    this.maxOpenLots = options.maxOpenLots ?? DEFAULT_MAX_OPEN_FIFO_LOTS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_LEADERBOARD_EVENTS;
    this.maxUsers = options.maxUsers ?? DEFAULT_MAX_LEADERBOARD_USERS;
    this.maxBuckets = options.maxBuckets ?? DEFAULT_MAX_LEADERBOARD_BUCKETS;
    for (const [name, value] of Object.entries({
      maxOpenLots: this.maxOpenLots,
      maxEvents: this.maxEvents,
      maxUsers: this.maxUsers,
      maxBuckets: this.maxBuckets,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  get retainedOpenLotCount(): number {
    return this.openLotCount;
  }

  ingest(
    rows: SocialOrderRow[],
    tradeActionSide: (action: string | null | undefined) => "buy" | "sell",
  ): void {
    for (const row of rows) {
      this.ingestCanonicalRow(row, tradeActionSide);
    }
  }

  private ingestCanonicalRow(
    row: SocialOrderRow,
    tradeActionSide: (action: string | null | undefined) => "buy" | "sell",
  ): void {
    const symbol = (row.symbol ?? "").toUpperCase();
    if (!symbol || eventIdentity(row) === null) return;

    const resolved = resolveEventPriceQty(row);
    if (!resolved) return;
    if (this.ingestedEventCount >= this.maxEvents) {
      throw new LeaderboardFifoCapacityError(this.maxEvents, "events");
    }
    this.ingestedEventCount += 1;

    const isPerp = row.assetType === "PERP";
    const isOption = row.assetType === "OPTION";
    const bucketKey = positionBucketKey(row);
    const storedDirection: "long" | "short" =
      row.direction === "short" ? "short" : "long";
    const direction: "long" | "short" = isPerp && row.reduceOnly
      ? storedDirection === "long" ? "short" : "long"
      : storedDirection;
    const side = tradeActionSide(row.tradeAction);
    const isOpen =
      (direction === "long" && side === "buy") ||
      (direction === "short" && side === "sell");
    const { price, qty } = resolved;
    const eventAtKey = resolveTradeEventKey(row);
    const eventAt = eventAtKey === null ? null : displayTimestamp(eventAtKey);

    let stats = this.statsByUser.get(row.userId);
    if (!stats) {
      if (this.statsByUser.size >= this.maxUsers) {
        throw new LeaderboardFifoCapacityError(this.maxUsers, "users");
      }
      stats = {
        realizedPnl: 0,
        wins: 0,
        tradeCount: 0,
        lastTradeAt: null,
        lastTradeAtKey: null,
        alpacaPnl: 0,
        hyperliquidPnl: 0,
      };
      this.statsByUser.set(row.userId, stats);
    }
    if (eventAtKey && (stats.lastTradeAtKey === null || eventAtKey > stats.lastTradeAtKey)) {
      stats.lastTradeAtKey = eventAtKey;
      stats.lastTradeAt = eventAt;
    }

    if (isOpen) {
      if (this.openLotCount >= this.maxOpenLots) {
        throw new LeaderboardFifoCapacityError(this.maxOpenLots, "openLots");
      }
      let userBuckets = this.bucketsByUser.get(row.userId);
      if (!userBuckets) {
        userBuckets = new Map();
        this.bucketsByUser.set(row.userId, userBuckets);
      }
      let bucket = userBuckets.get(bucketKey);
      if (!bucket) {
        if (this.bucketCount >= this.maxBuckets) {
          throw new LeaderboardFifoCapacityError(this.maxBuckets, "buckets");
        }
        bucket = { longLots: [], shortLots: [] };
        userBuckets.set(bucketKey, bucket);
        this.bucketCount += 1;
      }
      const queue = direction === "long" ? bucket.longLots : bucket.shortLots;
      queue.push({
        qty,
        ...(resolved.qtyUnits === undefined ? {} : { qtyUnits: resolved.qtyUnits }),
        price,
        multiplier: isOption ? OPTION_CONTRACT_MULTIPLIER : 1,
      });
      this.openLotCount += 1;
      return;
    }

    const bucket = this.bucketsByUser.get(row.userId)?.get(bucketKey);
    if (!bucket) return;
    const queue = direction === "long" ? bucket.longLots : bucket.shortLots;
    let remaining = qty;
    let remainingUnits = resolved.qtyUnits;
    while ((remainingUnits !== undefined ? remainingUnits > 0n : remaining > 0) && queue.length > 0) {
      const lot = queue[0]!;
      const matchedUnits = remainingUnits !== undefined && lot.qtyUnits !== undefined
        ? (remainingUnits < lot.qtyUnits ? remainingUnits : lot.qtyUnits)
        : undefined;
      const matchedQty = matchedUnits === undefined
        ? Math.min(remaining, lot.qty)
        : Number(matchedUnits) / 10 ** LEADERBOARD_PERP_SIZE_SCALE;
      const perUnit = direction === "long" ? price - lot.price : lot.price - price;
      const pnl = perUnit * matchedQty * lot.multiplier;
      const inWindow =
        this.windowFloorKey === null ||
        (eventAtKey !== null && eventAtKey >= this.windowFloorKey);
      if (inWindow) {
        stats.realizedPnl += pnl;
        stats.tradeCount += 1;
        if (pnl > 0) stats.wins += 1;
        if (row.venue?.toLowerCase() === "hyperliquid") {
          stats.hyperliquidPnl += pnl;
        } else {
          stats.alpacaPnl += pnl;
        }
      }

      if (matchedUnits === undefined) {
        lot.qty -= matchedQty;
        remaining -= matchedQty;
      } else {
        lot.qtyUnits! -= matchedUnits;
        remainingUnits! -= matchedUnits;
      }
      if (matchedUnits === undefined ? lot.qty <= 0 : lot.qtyUnits === 0n) {
        queue.shift();
        this.openLotCount -= 1;
      }
    }
    if (bucket.longLots.length === 0 && bucket.shortLots.length === 0) {
      const userBuckets = this.bucketsByUser.get(row.userId)!;
      userBuckets.delete(bucketKey);
      this.bucketCount -= 1;
      if (userBuckets.size === 0) this.bucketsByUser.delete(row.userId);
    }
  }

  finalize(): Map<string, AggregatedUserStats> {
    const result = new Map<string, AggregatedUserStats>();
    for (const [userId, stats] of this.statsByUser) {
      if (stats.tradeCount === 0) continue;
      result.set(userId, {
        realizedPnl: stats.realizedPnl,
        winRate: stats.wins / stats.tradeCount,
        tradeCount: stats.tradeCount,
        lastTradeAt: stats.lastTradeAt,
        alpacaPnl: stats.alpacaPnl,
        hyperliquidPnl: stats.hyperliquidPnl,
      });
    }
    return result;
  }
}

/**
 * Combine a user's per-bucket reconstructions into per-user totals.
 *
 * realizedPnl: sum across buckets.
 * winRate: aggregate over ALL closed lots (re-derived from the per-lot win flags
 *   so a bucket with many trades is weighted more than one with a single trade —
 *   NOT a naive mean of per-bucket win rates). 0 when there are no closed trades.
 * tradeCount: total closed lots.
 * lastTradeAt: max ISO timestamp across buckets.
 */
export function aggregateUserStats(rows: UserSymbolReconstruction[]): AggregatedUserStats {
  let realizedPnl = 0;
  let tradeCount = 0;
  let wins = 0;
  let lastTradeAt: string | null = null;
  let lastTradeAtKey: string | null = null;

  for (const row of rows) {
    realizedPnl += row.result.realizedPnl;
    tradeCount += row.result.closedTrades;
    const lots = row.result.closedLots;
    if (lots && lots.length > 0) {
      // Exact win count from per-lot flags.
      for (const lot of lots) if (lot.win) wins += 1;
    } else {
      // Fallback for synthetic inputs without closedLots: derive from winRate.
      wins += Math.round(row.result.winRate * row.result.closedTrades);
    }
    const rowLastTradeAtKey = normalizeTimestamp(row.lastTradeAt);
    if (
      rowLastTradeAtKey !== null &&
      (lastTradeAtKey === null || rowLastTradeAtKey > lastTradeAtKey)
    ) {
      lastTradeAtKey = rowLastTradeAtKey;
      lastTradeAt = displayTimestamp(rowLastTradeAtKey);
    }
  }

  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  // aggregateUserStats operates on UserSymbolReconstruction which has no venue
  // information, so venue-split P&L defaults to zero here.
  return { realizedPnl, winRate, tradeCount, lastTradeAt, alpacaPnl: 0, hyperliquidPnl: 0 };
}

// ============================================
// X-callers tab: forward-return heuristics
// ============================================

/**
 * Forward return of a ticker from entry to exit, as a percent.
 * (exit - entry) / entry * 100. Returns null on bad inputs (non-finite, or
 * entry/exit <= 0 which would make the percent meaningless).
 */
export function forwardReturnPct(
  entryPrice: number | null | undefined,
  exitPrice: number | null | undefined,
): number | null {
  if (entryPrice === null || entryPrice === undefined) return null;
  if (exitPrice === null || exitPrice === undefined) return null;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return null;
  if (
    entryPrice <= 0 ||
    exitPrice <= 0 ||
    entryPrice > MAX_SAFE_X_BAR_PRICE ||
    exitPrice > MAX_SAFE_X_BAR_PRICE
  ) return null;
  const result = ((exitPrice - entryPrice) / entryPrice) * 100;
  if (!Number.isFinite(result) || Math.abs(result) > MAX_SAFE_X_RETURN_PCT) return null;
  return result;
}

export function scoreXCallReturn(
  rawReturnPct: number | null,
  direction: XCallDirection,
): number | null {
  if (
    rawReturnPct === null ||
    !Number.isFinite(rawReturnPct) ||
    Math.abs(rawReturnPct) > MAX_SAFE_X_RETURN_PCT
  ) return null;
  if (direction === "unknown") return null;
  return direction === "bearish" ? -rawReturnPct : rawReturnPct;
}

export interface CallerStats {
  /** Fraction of MEASURED calls with a positive forward return, or null if none measured. */
  hitRate: number | null;
  /** Mean forward return % over MEASURED calls, or null if none measured. */
  avgForwardReturnPct: number | null;
  /** Total calls attributed to the author (includes calls we could not measure). */
  callCount: number;
  /** Calls with a finite, direction-adjusted return. */
  measuredCallCount: number;
}

/**
 * Aggregate a caller's per-call forward returns into summary stats.
 *
 * `calls` is the array of forward returns (one per call); a null entry means the
 * call could not be measured (missing bars). Such calls are still counted in
 * `callCount` but excluded from `hitRate`/`avg`. If NO call could be measured,
 * both `hitRate` and `avgForwardReturnPct` are null (we have nothing to claim).
 */
export function aggregateCallerStats(calls: Array<number | null>): CallerStats {
  const measured = calls.filter((r): r is number => r !== null && Number.isFinite(r));
  const callCount = calls.length;

  if (measured.length === 0) {
    return { hitRate: null, avgForwardReturnPct: null, callCount, measuredCallCount: 0 };
  }

  const wins = measured.filter((r) => r > 0).length;
  let sum = 0;
  for (const value of measured) {
    sum += value;
    if (!Number.isFinite(sum) || Math.abs(sum) > MAX_SAFE_X_RETURN_PCT * measured.length) {
      return {
        hitRate: null,
        avgForwardReturnPct: null,
        callCount,
        measuredCallCount: measured.length,
      };
    }
  }
  const average = sum / measured.length;
  if (!Number.isFinite(average) || Math.abs(average) > MAX_SAFE_X_RETURN_PCT) {
    return {
      hitRate: null,
      avgForwardReturnPct: null,
      callCount,
      measuredCallCount: measured.length,
    };
  }

  return {
    hitRate: wins / measured.length,
    avgForwardReturnPct: average,
    callCount,
    measuredCallCount: measured.length,
  };
}

// ============================================
// X-callers leaderboard response metadata
// ============================================

export interface LeaderboardMetaInput {
  /**
   * Legacy stock-provider availability hint. New callers should pass
   * `hasAnyMarketData` so keyless perp data can keep a response measurable.
  */
  hasMaster: boolean;
  /**
   * True when at least one row in the response has needsMarketData=true.
   * It represents partial source coverage whenever the response is measurable.
   */
  anyRowNeedsMarketData: boolean;
  /** True when at least one retained directional candidate needs a market. */
  hasMarketCandidates?: boolean;
  /** Provider failures only, excluding intentional measurement-cap omissions. */
  providerMarketDataUnavailable?: boolean;
  /** True only when every retained market candidate has usable data. */
  marketDataComplete?: boolean;
  /** Unresolved candidate count, kept distinct from provider failures. */
  unresolvedMarketCandidateCount?: number;
  /**
   * True when the signal scan returned <= XCALLER_SIGNAL_SCAN_CAP rows,
   * meaning no signals were dropped by the cap.
   */
  signalsWithinCap: boolean;
  /**
   * Optional provider health override. Keyless Hyperliquid data can keep a
   * perp-only result measurable even when Alpaca credentials are absent.
   */
  hasAnyMarketData?: boolean;
}

export interface LeaderboardMeta {
  /**
   * True only when no provider returned usable market data and the response
   * therefore falls back to call-count ranking.
   */
  rankingFallback: boolean;
  /**
   * True when some (but not necessarily all) rows could not be measured
   * due to missing or intentionally omitted market data. Only set on the full
   * path; always false on the degraded (rankingFallback=true) path.
   */
  partialMarketData: boolean;
  /**
   * False when the signal scan hit the hard cap or retained market coverage is
   * incomplete. Intentional market-cap omissions are incomplete retained
   * coverage and therefore affect this flag.
   */
  dataComplete: boolean;
}

/**
 * Pure function: compute the three leaderboard metadata flags from context.
 *
 * This is the single source of truth for `rankingFallback`, `partialMarketData`,
 * and `dataComplete` so the router stays thin and the logic is unit-testable.
 *
 * Semantics (per Codex P2 comment):
 *   - `rankingFallback` is ONLY true when the WHOLE response uses call-count
 *     ranking (no usable provider data). It is NOT set just because some rows
 *     lack market data - that is `partialMarketData`.
 *   - `partialMarketData` is true when some rows are unmeasured (missing bars)
 *     or intentionally omitted from the retained market set, and the response
 *     still uses return-based ranking.
 *   - `dataComplete` is independent of ranking mode: it is false whenever the
 *     hard scan cap truncated signal history or retained market coverage is
 *     incomplete.
 */
export function computeLeaderboardMeta(input: LeaderboardMetaInput): LeaderboardMeta {
  const hasMarketCandidates = input.hasMarketCandidates ?? input.anyRowNeedsMarketData;
  const hasAnyMarketData = input.hasAnyMarketData === undefined
    ? input.hasMaster
    : input.hasAnyMarketData;
  const marketDataComplete = input.marketDataComplete ?? !input.anyRowNeedsMarketData;
  const rankingFallback = hasMarketCandidates && !hasAnyMarketData;
  const incompleteMarketData =
    !marketDataComplete ||
    (input.providerMarketDataUnavailable ?? false) ||
    (input.unresolvedMarketCandidateCount ?? 0) > 0;
  if (rankingFallback) {
    return {
      rankingFallback: true,
      partialMarketData: false,
      dataComplete: input.signalsWithinCap && !incompleteMarketData,
    };
  }
  return {
    rankingFallback: false,
    partialMarketData: incompleteMarketData,
    dataComplete: input.signalsWithinCap && !incompleteMarketData,
  };
}
