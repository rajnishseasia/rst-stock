/**
 * External Discord Signal Poller
 *
 * Consumes a Redis stream written by the Discord bot that lives in the
 * nft-relay-group repo at
 * functions/functions/code/bots/python-discord-bot/run_prof_discord_rst_copying.py
 * (the sole deployed producer; its parser tests live alongside it) and executes
 * Hyperliquid perp trades on behalf of configured followers.
 *
 * Flow:
 *   1. Python bot reads messages from Neil's Discord channel, regex-parses
 *      them, and pushes structured JSON to the Redis stream
 *      "discord:external:signals".
 *   2. This poller reads that stream every POLL_INTERVAL_MS.
 *   3. For each new entry signal:
 *      a. Validate coin (must be a known HL perp).
 *      b. For each enabled follower of THAT CHANNEL in
 *         external-discord-followers.json (risk, leverage and margin mode are
 *         per channel, so following two callers can size differently):
 *         - Look up their RST user by email.
 *         - Find their Hyperliquid credential.
 *         - Compute position size from riskPerTradeUsd and SL distance.
 *         - Set the correct leverage on HL.
 *         - Place a market order.
 *         - Immediately set a stop-loss trigger.
 *         - Set take-profit trigger(s) if the signal included numeric TPs.
 *         - Send a Discord webhook notification.
 *   4. Persist the last-processed stream entry ID so restarts don't replay.
 *
 * Opt-in: start() is fully inert unless
 * EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED is exactly "true". A channel with no
 * entry under "channels" is not followed at all. Within a channel, set
 * enabled=false on the channel to pause every entry from that caller, or on a
 * single follower to pause just that person.
 */

import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { getRedisClient } from "@trade-bot/redis";
import { createProductionLogger, type Logger } from "@trade-bot/logger";
import {
  HyperliquidOrderPreparationError,
  HyperliquidOrderRejectedError,
  networkFromEnv,
  parseCanonicalPerpCoin,
  toCloid,
} from "@trade-bot/hyperliquid";
import {
  buildCanonicalAuthorMetadata,
  isPlausibleSourceEventTimestamp,
} from "@trade-bot/utils";
import { eq, and } from "drizzle-orm";
import { createHyperliquidExchangeClient, createHyperliquidInfoClient, HL_AGENT_REGISTERED } from "../../../api/src/lib/hyperliquid";
import {
  perpOrderSubmitSchema,
  toPerpOrderRow,
  toPlacePerpOrderRequest,
} from "../../../api/src/lib/perp-orders";
import { parseStrictFiniteNumber } from "../../../api/src/lib/strict-number";
import { tradeActionSide } from "../../../api/src/lib/trade-action";
import {
  anonymizeTrader,
  resolveTraderIdentity,
} from "../../../api/src/lib/trader-identity";
import type {
  ParsedSignal,
  ParsedExitSignal,
  ExternalDiscordExitAction,
  FollowerConfig,
  FollowersConfigFile,
  ChannelConfig,
  OpenRateLimitWindow,
} from "./external-discord-signal-types";
import {
  evaluateOpenRateLimit,
  longestWindowSeconds,
  openRateLimitKey,
} from "./external-discord-open-rate-limit";
import followersConfigRaw from "../config/external-discord-followers.json";
import { tryObserveCanonicalAuthor } from "./canonical-author-store";
import { applySourceEventDedup } from "./ingestion-dedup";

// ---- Constants ---------------------------------------------------------------

const LOG_SERVICE = "external-discord-signal";

/** Redis stream key the Python bot writes to. */
const STREAM_KEY = "discord:external:signals";

/** Redis key where we persist the last-processed stream entry ID. */
const CURSOR_KEY = "discord:external:signals:cursor";

/** Poll interval between stream reads. */
const POLL_INTERVAL_MS = 3_000;

/**
 * After placing a market order, wait this long before setting SL/TP triggers.
 * HL market orders fill in milliseconds; this is just a small safety buffer.
 */
const POST_ORDER_DELAY_MS = 800;

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/**
 * How far adverse to the live entry to place a derived stop when the source
 * message carried none. Unleveraged: 20% of the coin price, not of margin.
 */
const SL_FALLBACK_FRACTION = 0.2;

export function deriveExternalDiscordFallbackStop(
  entryPrice: number,
  side: "long" | "short",
): number {
  return side === "long"
    ? entryPrice * (1 - SL_FALLBACK_FRACTION)
    : entryPrice * (1 + SL_FALLBACK_FRACTION);
}

/**
 * Entry caps applied to any channel that does not configure its own:
 * at most one position per 10 minutes and five per 24 hours.
 */
const DEFAULT_OPEN_RATE_LIMITS: OpenRateLimitWindow[] = [
  { windowSeconds: 600, maxOpens: 1 },
  { windowSeconds: 86_400, maxOpens: 5 },
];

/** One week. Bounds config values so a typo cannot create an effectively permanent block. */
const MAX_OPEN_RATE_LIMIT_WINDOW_SECONDS = 604_800;
const MAX_OPEN_RATE_LIMIT_OPENS = 1_000;
export const EXTERNAL_DISCORD_SOURCE = "discord";
export const EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED_ENV =
  "EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED";
const DIRECT_CLIENT_ORDER_ID_MAX_LENGTH = 128;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FOLLOWER_RISK_USD = 1_000_000;
const MAX_FOLLOWER_LEVERAGE = 50;
const DEFAULT_MAX_SIGNAL_AGE_MS = 5 * 60_000;
export const EXTERNAL_DISCORD_SIGNAL_MAX_AGE_MS_ENV =
  "EXTERNAL_DISCORD_SIGNAL_MAX_AGE_MS";
export const EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET_ENV =
  "EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET";

// ---- Config ------------------------------------------------------------------

const defaultLogger = createProductionLogger();

export function parseExternalDiscordFollowersConfig(
  value: unknown,
): FollowersConfigFile | null {
  if (typeof value !== "object" || value === null) return null;
  const minConfidence = Reflect.get(value, "minConfidence");
  if (minConfidence !== "low" && minConfidence !== "medium" && minConfidence !== "high") {
    return null;
  }

  const defaultOpenRateLimits = parseOpenRateLimitWindows(
    Reflect.get(value, "defaultOpenRateLimits"),
    DEFAULT_OPEN_RATE_LIMITS,
  );
  if (!defaultOpenRateLimits) return null;

  const rawChannels = Reflect.get(value, "channels");
  if (typeof rawChannels !== "object" || rawChannels === null || Array.isArray(rawChannels)) {
    return null;
  }
  const channels: Record<string, ChannelConfig> = {};
  for (const [channelId, rawChannel] of Object.entries(rawChannels)) {
    if (!DISCORD_SNOWFLAKE_PATTERN.test(channelId)) return null;
    if (typeof rawChannel !== "object" || rawChannel === null) return null;
    const label = Reflect.get(rawChannel, "label");
    if (label !== undefined && typeof label !== "string") return null;
    const rawEnabled = Reflect.get(rawChannel, "enabled");
    if (rawEnabled !== undefined && typeof rawEnabled !== "boolean") return null;
    const openRateLimits = parseOpenRateLimitWindows(
      Reflect.get(rawChannel, "openRateLimits"),
      defaultOpenRateLimits,
    );
    if (!openRateLimits) return null;
    const followers = parseChannelFollowers(Reflect.get(rawChannel, "followers"));
    if (!followers) return null;
    channels[channelId] = {
      ...(typeof label === "string" ? { label } : {}),
      enabled: rawEnabled ?? true,
      openRateLimits,
      followers,
    };
  }

  return { minConfidence, defaultOpenRateLimits, channels };
}

/**
 * Parse one channel's follower list. Sizing lives here rather than globally so
 * the same person can follow one caller at $150 of risk and another at $10.
 * A missing or malformed list fails the whole config closed.
 */
function parseChannelFollowers(value: unknown): FollowerConfig[] | null {
  if (!Array.isArray(value)) return null;

  const followers: FollowerConfig[] = [];
  const seenEmails = new Set<string>();
  for (const rawFollower of value) {
    if (typeof rawFollower !== "object" || rawFollower === null) return null;
    const emailValue = Reflect.get(rawFollower, "email");
    const riskPerTradeUsd = Reflect.get(rawFollower, "riskPerTradeUsd");
    const leverage = Reflect.get(rawFollower, "leverage");
    const marginMode = Reflect.get(rawFollower, "marginMode");
    const enabled = Reflect.get(rawFollower, "enabled");
    const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(email)) return null;
    // Two entries for one email on one channel would double the position.
    if (seenEmails.has(email)) return null;
    seenEmails.add(email);
    if (
      typeof riskPerTradeUsd !== "number" ||
      !Number.isFinite(riskPerTradeUsd) ||
      riskPerTradeUsd <= 0 ||
      riskPerTradeUsd > MAX_FOLLOWER_RISK_USD
    ) return null;
    if (
      typeof leverage !== "number" ||
      !Number.isInteger(leverage) ||
      leverage < 1 ||
      leverage > MAX_FOLLOWER_LEVERAGE
    ) return null;
    if (marginMode !== "cross" && marginMode !== "isolated") return null;
    if (typeof enabled !== "boolean") return null;
    followers.push({ email, riskPerTradeUsd, leverage, marginMode, enabled });
  }
  return followers;
}

/**
 * Parse a list of sliding-window caps. Returns `fallback` when the key is
 * absent (so an existing config keeps working and still gets limits), and null
 * when present but malformed - which fails the whole config closed rather than
 * silently trading without a cap.
 */
function parseOpenRateLimitWindows(
  value: unknown,
  fallback: OpenRateLimitWindow[],
): OpenRateLimitWindow[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return null;

  const windows: OpenRateLimitWindow[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const windowSeconds = Reflect.get(raw, "windowSeconds");
    const maxOpens = Reflect.get(raw, "maxOpens");
    if (
      typeof windowSeconds !== "number" ||
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > MAX_OPEN_RATE_LIMIT_WINDOW_SECONDS
    ) return null;
    if (
      typeof maxOpens !== "number" ||
      !Number.isInteger(maxOpens) ||
      maxOpens < 0 ||
      maxOpens > MAX_OPEN_RATE_LIMIT_OPENS
    ) return null;
    windows.push({ windowSeconds, maxOpens });
  }
  return windows;
}

const followersConfig = parseExternalDiscordFollowersConfig(followersConfigRaw) ?? {
  minConfidence: "high" as const,
  defaultOpenRateLimits: DEFAULT_OPEN_RATE_LIMITS,
  channels: {},
};

/** Resolve the entry caps that apply to a channel, falling back to the default set. */
export function resolveOpenRateLimits(
  config: FollowersConfigFile,
  channelId: string,
): OpenRateLimitWindow[] {
  return config.channels[channelId]?.openRateLimits ?? config.defaultOpenRateLimits;
}

/**
 * Followers who should have an ENTRY placed for a call in this channel.
 * An unconfigured channel yields nobody, so a caller is only ever traded once
 * someone has written down what following them costs.
 */
export function resolveEntryFollowers(
  config: FollowersConfigFile,
  channelId: string,
): FollowerConfig[] {
  const channel = config.channels[channelId];
  if (!channel || !channel.enabled) return [];
  return channel.followers.filter((follower) => follower.enabled);
}

/**
 * Followers who should have an EXIT routed for this channel: everyone listed,
 * whether or not the channel or the follower is currently enabled. Exits are
 * reduce-only, so the worst case is closing a position that is already flat,
 * while skipping one strands real exposure that was opened while enabled.
 */
export function resolveExitFollowers(
  config: FollowersConfigFile,
  channelId: string,
): FollowerConfig[] {
  return config.channels[channelId]?.followers ?? [];
}

// ---- Helpers -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStrictPositiveNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = parseStrictFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function isFreshExternalDiscordSignal(
  timestamp: Date,
  now = new Date(),
  maxAgeMs = DEFAULT_MAX_SIGNAL_AGE_MS,
): boolean {
  const ageMs = now.getTime() - timestamp.getTime();
  return Number.isFinite(ageMs) && maxAgeMs > 0 && ageMs >= 0 && ageMs <= maxAgeMs;
}

function externalDiscordSignalMaxAgeMs(): number {
  const configured = process.env[EXTERNAL_DISCORD_SIGNAL_MAX_AGE_MS_ENV];
  if (!configured?.trim()) return DEFAULT_MAX_SIGNAL_AGE_MS;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SIGNAL_AGE_MS;
}

export function isExternalDiscordExecutionAllowed(
  network: string,
  mainnetOptIn: string | undefined,
): boolean {
  return network !== "mainnet" || mainnetOptIn === "true";
}

export interface ExternalDiscordOrderFill {
  sizeCoin: string;
  entryPrice: number;
  brokerOrderId: string;
}

export function parseExternalDiscordOrderFill(result: unknown): ExternalDiscordOrderFill | null {
  if (typeof result !== "object" || result === null || Reflect.get(result, "status") !== "ok") {
    return null;
  }
  const response = Reflect.get(result, "response");
  if (
    typeof response !== "object" ||
    response === null ||
    Reflect.get(response, "type") !== "order"
  ) return null;
  const data = Reflect.get(response, "data");
  if (typeof data !== "object" || data === null) return null;
  const statuses = Reflect.get(data, "statuses");
  if (!Array.isArray(statuses) || statuses.length !== 1) return null;
  const status = statuses[0];
  if (typeof status !== "object" || status === null) return null;
  const filled = Reflect.get(status, "filled");
  if (typeof filled !== "object" || filled === null) return null;

  const rawSize = Reflect.get(filled, "totalSz");
  const rawEntryPrice = Reflect.get(filled, "avgPx");
  const rawOrderId = Reflect.get(filled, "oid");
  const sizeCoin = typeof rawSize === "string" ? rawSize.trim() : "";
  const entryPrice = parseStrictPositiveNumber(rawEntryPrice);
  const orderIdIsValid =
    (typeof rawOrderId === "number" && Number.isSafeInteger(rawOrderId) && rawOrderId >= 0) ||
    (typeof rawOrderId === "string" && /^\d+$/.test(rawOrderId));
  if (parseStrictPositiveNumber(sizeCoin) === null || entryPrice === null || !orderIdIsValid) {
    return null;
  }
  return { sizeCoin, entryPrice, brokerOrderId: String(rawOrderId) };
}

export function toExternalDiscordFilledOrderUpdate(
  fill: ExternalDiscordOrderFill,
  filledAt: Date,
): Partial<typeof schema.orders.$inferInsert> {
  return {
    status: "FILLED",
    brokerOrderId: fill.brokerOrderId,
    executedPrice: String(fill.entryPrice),
    executedSizeDecimal: fill.sizeCoin,
    placedAt: filledAt,
    executedAt: filledAt,
    syncReason: null,
  };
}

/**
 * The social-feed row for a confirmed signal fill.
 *
 * The copy-mirror discovers a user's trades ONLY through social_trades, joined
 * to the authoritative order by `orderId`. This executor marks its own order
 * FILLED straight from the placement response, so the Hyperliquid reconciler
 * (the only other perp publisher) never sees it. Without this row a leader's
 * signal-executed open is invisible to every follower: their later close then
 * resolves as "no position", which is exactly the 2026-09-04 miss.
 *
 * Shape matches the reconciler's publish: qty is the legacy integer
 * placeholder, and the joined order's executedSizeDecimal carries the real size.
 */
export function toExternalDiscordSocialTrade(
  order: {
    id: string;
    userId: string;
    symbol: string;
    tradeAction: string;
    orderType: string;
  },
  fill: ExternalDiscordOrderFill,
): typeof schema.socialTrades.$inferInsert | null {
  const side = tradeActionSide(order.tradeAction);
  if (!side) return null;
  return {
    userId: order.userId,
    symbol: order.symbol,
    side,
    qty: 1,
    orderType: order.orderType.toLowerCase(),
    assetType: "PERP",
    limitPrice: null,
    brokerOrderId: fill.brokerOrderId,
    orderId: order.id,
  };
}

/**
 * A placement response that carries no parseable fill is not proof that no
 * position was opened. `placeOrder` throws on every definitive venue
 * rejection, so a returned-but-unparseable response means Hyperliquid accepted
 * the order and the outcome is ambiguous. The single exception is an explicit
 * `resting` status, which is a live resting order with no position behind it.
 */
export interface ExternalDiscordPlacementOutcome {
  fill: ExternalDiscordOrderFill | null;
  /** Size to protect with SL/TP, or null when no position can exist yet. */
  protectionSize: string | null;
  orderUpdate: Partial<typeof schema.orders.$inferInsert>;
}

/**
 * Decide what a returned placement response means for the reserved order row
 * and for stop-loss placement. `placeOrder` throws on every definitive venue
 * rejection, so a response that reaches here was accepted: an unparseable
 * shape is ambiguous, not proof that nothing filled, and must still be
 * protected off the requested size. Only an explicit resting status provably
 * has no position behind it.
 */
export function resolveExternalDiscordPlacementOutcome(
  placementResult: unknown,
  requestedSizeCoin: string,
  now: Date,
): ExternalDiscordPlacementOutcome {
  const fill = parseExternalDiscordOrderFill(placementResult);
  if (fill) {
    return {
      fill,
      protectionSize: fill.sizeCoin,
      orderUpdate: toExternalDiscordFilledOrderUpdate(fill, now),
    };
  }

  const resting = isExternalDiscordRestingPlacement(placementResult);
  return {
    fill: null,
    protectionSize: resting ? null : requestedSizeCoin,
    orderUpdate: {
      status: "SUBMITTED",
      placedAt: now,
      syncReason: resting
        ? "Hyperliquid accepted the order; awaiting fill reconciliation"
        : "Hyperliquid accepted the order; fill unconfirmed, protection placed off requested size",
    },
  };
}

export function isExternalDiscordRestingPlacement(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const response = Reflect.get(result, "response");
  if (typeof response !== "object" || response === null) return false;
  const data = Reflect.get(response, "data");
  if (typeof data !== "object" || data === null) return false;
  const statuses = Reflect.get(data, "statuses");
  if (!Array.isArray(statuses) || statuses.length === 0) return false;
  return statuses.every((status) => {
    if (typeof status !== "object" || status === null) return false;
    const resting = Reflect.get(status, "resting");
    return typeof resting === "object" && resting !== null;
  });
}

function parseOptionalStrictPositiveNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  return parseStrictPositiveNumber(value);
}

function parseRequiredDate(value: string | undefined): Date | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTakeProfits(value: string | undefined): number[] | null {
  try {
    const parsed = JSON.parse(value?.trim() || "[]");
    if (!Array.isArray(parsed)) return null;
    const takeProfits = parsed.map(parseStrictPositiveNumber);
    return takeProfits.every((takeProfit): takeProfit is number => takeProfit !== null)
      ? takeProfits
      : null;
  } catch {
    return null;
  }
}

function normalizeSourceUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Independent semantic backstop for structured parser output. The producer is
 * allowed to improve, but an explicit raw direction may never be contradicted
 * by the side that authorizes a real order.
 */
export function rawDiscordDirection(text: string): "long" | "short" | null {
  const coinFirst = text.match(/^\s*\$?[A-Za-z0-9:]{2,20}\s+(long|short)\b/i);
  const explicit = coinFirst ?? text.match(/\b(?:going|market|im|i'm)\s+(long|short)\b/i);
  return explicit?.[1]?.toLowerCase() === "short"
    ? "short"
    : explicit?.[1]?.toLowerCase() === "long"
      ? "long"
      : null;
}

export function isDiscordPositionUpdate(text: string): boolean {
  return /^\s*\$?[A-Za-z0-9:]{2,20}\s+(?:long|short)\s+from\s+(?:the\s+)?stream\b/i.test(text) ||
    /\bfrom\s+(?:the\s+)?stream\s+(?:is\s+)?up\s+[\d.]+\s?R\b/i.test(text);
}

function requireExternalEventIdentity(
  signal: Pick<ParsedSignal, "messageId" | "channelId" | "authorId">,
): {
  messageId: string;
  channelId: string;
  authorId: string;
} {
  const messageId = typeof signal.messageId === "string" ? signal.messageId.trim() : "";
  const channelId = typeof signal.channelId === "string" ? signal.channelId.trim() : "";
  const authorId = typeof signal.authorId === "string" ? signal.authorId.trim() : "";
  if (!messageId || !channelId || !authorId) {
    throw new Error("external Discord signal requires messageId and channelId and authorId");
  }
  return { messageId, channelId, authorId };
}

const EXIT_ACTIONS = new Set<ExternalDiscordExitAction>(["close", "reduce", "stop_be"]);

/**
 * Parse an exit instruction (close / reduce / stop_be) out of the stream.
 *
 * Kept deliberately separate from the entry parser rather than folded into it:
 * the entry path is hardened around sizing, protection and order reservation,
 * and none of that applies to a reduce-only exit. Returns null for anything
 * that is not an exit, so entries fall through to the existing parser
 * untouched.
 */
export function parseExternalDiscordExitEntry(
  fields: Record<string, string>,
): ParsedExitSignal | null {
  try {
    if (fields.v !== "1" && fields.v !== "2") return null;

    const action = fields.action?.trim() as ExternalDiscordExitAction | undefined;
    if (!action || !EXIT_ACTIONS.has(action)) return null;

    const coin = fields.coin?.trim();
    if (!coin) return null;

    const messageId = fields.messageId?.trim();
    const channelId = fields.channelId?.trim();
    const authorId = fields.authorId?.trim();
    if (
      !messageId ||
      !channelId ||
      !authorId ||
      !DISCORD_SNOWFLAKE_PATTERN.test(messageId) ||
      !DISCORD_SNOWFLAKE_PATTERN.test(channelId) ||
      !DISCORD_SNOWFLAKE_PATTERN.test(authorId)
    ) return null;

    const authorName = fields.authorName?.trim();
    const rawMessage = fields.rawMessage?.trim();
    if (!authorName || !rawMessage) return null;

    // A reduce without a usable percentage is dropped rather than guessed at.
    let reducePct: number | null = null;
    if (action === "reduce") {
      const parsed = parseStrictPositiveNumber(fields.reducePct);
      if (parsed === null || parsed > 100) return null;
      reducePct = parsed;
    }

    const parsedAt = fields.parsedAt?.trim()
      ? parseRequiredDate(fields.parsedAt)
      : new Date();
    if (!parsedAt) return null;

    const messageTimestamp = parseRequiredDate(fields.messageTimestamp);
    if (!messageTimestamp || !isPlausibleSourceEventTimestamp(messageTimestamp)) return null;

    return {
      action,
      messageId,
      channelId,
      authorId,
      authorName,
      rawMessage,
      coin,
      reducePct,
      parsedAt,
      messageTimestamp,
    };
  } catch {
    return null;
  }
}

/** Parse the raw Redis stream fields into a typed signal. Returns null if not actionable. */
export function parseExternalDiscordStreamEntry(
  fields: Record<string, string>,
): ParsedSignal | null {
  try {
    if (fields.v !== "1" && fields.v !== "2") return null;
    // v2 carries an explicit action; v1 only ever expressed an entry. Exits are
    // handled by parseExternalDiscordExitEntry before this runs.
    if (fields.action !== undefined && fields.action !== "open") return null;
    if (fields.isNewEntry !== "true") return null;

    // Hyperliquid coin case is significant: kPEPE and xyz:GOOGL are not
    // interchangeable with their uppercased forms. Validate the exact value
    // after parsing instead of normalizing it like an equity ticker.
    const coin = fields.coin?.trim();
    if (!coin) return null;

    const messageId = fields.messageId?.trim();
    const channelId = fields.channelId?.trim();
    const authorId = fields.authorId?.trim();
    if (
      !messageId ||
      !channelId ||
      !authorId ||
      !DISCORD_SNOWFLAKE_PATTERN.test(messageId) ||
      !DISCORD_SNOWFLAKE_PATTERN.test(channelId) ||
      !DISCORD_SNOWFLAKE_PATTERN.test(authorId)
    ) return null;

    const authorName = fields.authorName?.trim();
    const rawMessage = fields.rawMessage?.trim();
    if (!authorName || !rawMessage) return null;

    const side = fields.side === "long" || fields.side === "short"
      ? fields.side
      : null;
    if (!side) return null;
    // Never execute a position/performance update as a fresh order, and never
    // trust structured direction that contradicts explicit source text.
    if (isDiscordPositionUpdate(rawMessage)) return null;
    const rawDirection = rawDiscordDirection(rawMessage);
    if (rawDirection !== null && rawDirection !== side) return null;

    // A stop is still required UNLESS the producer explicitly flagged that the
    // message carried none, in which case the worker derives one from the live
    // entry. A malformed stop is always rejected.
    const slFallback = fields.slFallback === "true";
    const hasStopLossField = Boolean(fields.stopLoss?.trim());
    const stopLoss = parseStrictPositiveNumber(fields.stopLoss);
    if (stopLoss === null && (hasStopLossField || !slFallback)) return null;

    let entryPrice = parseOptionalStrictPositiveNumber(fields.entryPrice);
    if (fields.entryPrice?.trim() && entryPrice === null) return null;

    const takeProfits = parseTakeProfits(fields.takeProfits);
    if (takeProfits === null) return null;

    // The bridge can see several prices in one message. Never trust a price it
    // selected as the entry when that exact value is also explicitly labelled
    // as a TP in the source text. Treat the call as market/CMP instead so the
    // worker resolves a live mid, rather than dropping the signal or sizing it
    // from the target. DCA and stop prices remain non-entry annotations.
    if (
      entryPrice !== null &&
      takeProfits.includes(entryPrice) &&
      rawMessageLabelsTakeProfit(rawMessage, entryPrice)
    ) {
      entryPrice = null;
    }
    if (
      entryPrice !== null &&
      takeProfits.some((price) => side === "long" ? price <= entryPrice : price >= entryPrice)
    ) return null;

    const confidence = fields.confidence === "high" ||
      fields.confidence === "medium" ||
      fields.confidence === "low"
      ? fields.confidence
      : null;
    if (!confidence) return null;

    // `parsedAt` is processing metadata. A missing value can use the worker's
    // current time, but an explicitly malformed value is rejected.
    const parsedAt = fields.parsedAt?.trim()
      ? parseRequiredDate(fields.parsedAt)
      : new Date();
    if (!parsedAt) return null;

    // The source timestamp is evidence from Discord, never a processing-time
    // fallback. Reject missing, malformed, and implausibly future timestamps.
    const messageTimestamp = parseRequiredDate(fields.messageTimestamp);
    if (!messageTimestamp || !isPlausibleSourceEventTimestamp(messageTimestamp)) return null;

    return {
      messageId,
      channelId,
      authorId,
      authorName,
      authorHandle: fields.authorHandle?.trim() || null,
      authorAvatar: normalizeSourceUrl(fields.authorAvatar),
      sourceUrl: normalizeSourceUrl(fields.sourceUrl),
      rawMessage,
      coin,
      side,
      entryPrice,
      stopLoss,
      slFallback,
      takeProfits,
      confidence,
      parsedAt,
      messageTimestamp,
    };
  } catch {
    return null;
  }
}

function rawMessageLabelsTakeProfit(rawMessage: string, price: number): boolean {
  const pricePattern = String(price).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b(?:final\\s+)?tps?\\s*(?:at|@|:|=)?\\s*\\$?${pricePattern}(?![\\d.])`,
    "i",
  ).test(rawMessage);
}

export function mapExternalDiscordSignal(
  signal: ParsedSignal,
  canonicalCoin: string,
): typeof schema.signals.$inferInsert {
  const { messageId, channelId, authorId } = requireExternalEventIdentity(signal);
  const sourceUrl = normalizeSourceUrl(signal.sourceUrl ?? undefined);
  const authorAvatar = normalizeSourceUrl(signal.authorAvatar ?? undefined);
  const metadata = buildCanonicalAuthorMetadata(
    {
      authorId,
      authorName: signal.authorName,
      authorHandle: signal.authorHandle,
      authorAvatar,
      authorSource: EXTERNAL_DISCORD_SOURCE,
      sourceAuthorId: authorId,
      authorIdentityKind: "source_author",
      messageId,
      channelId,
      sourceUrl,
      direction: signal.side,
      platform: "hyperliquid",
      instrument: "perp",
      hlTicker: canonicalCoin,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits,
      confidence: signal.confidence,
      parsedAt: signal.parsedAt.toISOString(),
      sourceTimestamp: signal.messageTimestamp.toISOString(),
    },
    {
      source: EXTERNAL_DISCORD_SOURCE,
      sourceAuthorId: authorId,
      identityKind: "source_author",
      currentHandle: signal.authorHandle ?? signal.authorName,
      displayName: signal.authorName,
      avatar: authorAvatar,
    },
  );

  return {
    source: EXTERNAL_DISCORD_SOURCE,
    sourceEventId: `${EXTERNAL_DISCORD_SOURCE}:${channelId}:${messageId}:${canonicalCoin}`,
    sourceAuthorId: authorId,
    symbol: canonicalCoin,
    content: signal.rawMessage.slice(0, 8_000),
    url: sourceUrl,
    timestamp: signal.messageTimestamp,
    metadata: {
      ...metadata,
      directExecutionManaged: true,
    },
  };
}

export async function persistExternalDiscordSignal(
  db: WorkerPoolDb,
  signal: ParsedSignal,
  canonicalCoin: string,
): Promise<
  | { status: "inserted"; signalId: string }
  | { status: "duplicate"; signalId: null }
> {
  const { authorId } = requireExternalEventIdentity(signal);
  if (parseCanonicalPerpCoin(canonicalCoin) !== canonicalCoin) {
    throw new Error("external Discord signal requires a canonical Hyperliquid coin");
  }

  const insert = mapExternalDiscordSignal(signal, canonicalCoin);
  const builder = db.insert(schema.signals).values(insert) as any;
  const conflictBuilder = applySourceEventDedup(builder) as any;
  if (typeof conflictBuilder.returning === "function") {
    const rows = await conflictBuilder.returning({ id: schema.signals.id });
    if (!Array.isArray(rows) || rows.length === 0) {
      return { status: "duplicate", signalId: null };
    }

    const signalId = String(rows[0]?.id ?? "");
    if (!signalId) throw new Error("external Discord signal insert returned no id");

    const authorAvatar = normalizeSourceUrl(signal.authorAvatar ?? undefined);
    const observedAuthor = await tryObserveCanonicalAuthor(db, insert.metadata, {
      source: EXTERNAL_DISCORD_SOURCE,
      sourceAuthorId: authorId,
      identityKind: "source_author",
      currentHandle: signal.authorHandle ?? signal.authorName,
      displayName: signal.authorName,
      avatar: authorAvatar,
    });
    if (typeof (db as unknown as { update?: unknown }).update === "function") {
      await db
        .update(schema.signals)
        .set({
          sourceAuthorId: observedAuthor.sourceAuthorId,
          metadata: observedAuthor.metadata,
        })
        .where(eq(schema.signals.id, signalId));
    }
    return { status: "inserted", signalId };
  }
  await conflictBuilder;
  throw new Error("external Discord signal insert must return its durable id");
}

export interface ExternalDiscordClientOrderIdentity {
  channelId: string;
  messageId: string;
  canonicalCoin: string;
  followerUserId: string;
}

/**
 * Build a deterministic direct-execution identity from every source and
 * destination dimension. Normal Discord IDs fit in the readable form; unusual
 * oversized values retain a digest suffix so truncation cannot collapse them.
 * The Hyperliquid client hashes this seed again into its fixed 128-bit cloid.
 */
export function buildExternalDiscordClientOrderId(
  identity: ExternalDiscordClientOrderIdentity,
): string {
  const seed = [
    "discord-signal",
    identity.channelId,
    identity.messageId,
    identity.canonicalCoin,
    identity.followerUserId,
  ].join(":");
  if (seed.length <= DIRECT_CLIENT_ORDER_ID_MAX_LENGTH) return seed;

  const digest = toCloid(seed).slice(2);
  const suffix = `:${digest}`;
  return `${seed.slice(0, DIRECT_CLIENT_ORDER_ID_MAX_LENGTH - suffix.length)}${suffix}`;
}

class ExternalDiscordSignalPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super("external Discord signal persistence failed");
    this.name = "ExternalDiscordSignalPersistenceError";
  }
}

/**
 * Size the position so a stop-loss hit costs exactly riskPerTradeUsd.
 * sizeCoin = riskPerTradeUsd / |entry - stopLoss|
 */
function computeSizeCoin(params: {
  riskPerTradeUsd: number;
  entryPrice: number;
  stopLoss: number;
  side: "long" | "short";
}): string | null {
  const { riskPerTradeUsd, entryPrice, stopLoss, side } = params;
  if (side === "long" && stopLoss >= entryPrice) return null;
  if (side === "short" && stopLoss <= entryPrice) return null;
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance <= 0) return null;
  return (riskPerTradeUsd / slDistance).toFixed(6);
}

/** Send a one-line Discord webhook notification for a signal trade. No-op if DISCORD_WEBHOOK_URL is unset. */
async function sendSignalTradeWebhook(params: {
  db: WorkerPoolDb;
  coin: string;
  side: "long" | "short";
  sizeCoin: string;
  sizeUsd: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | undefined;
  /** Follower whose account traded. Rendered as a pseudonym, never as the raw id. */
  userId: string;
  riskUsd: number;
}): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  let traderName = anonymizeTrader(params.userId).traderName;
  try {
    const [user, twitterAccount] = await Promise.all([
      params.db.query.users.findFirst({
        where: eq(schema.users.id, params.userId),
        columns: { name: true, twitterName: true, username: true, image: true },
      }),
      params.db.query.accounts.findFirst({
        where: (account, operators) => operators.and(
          operators.eq(account.userId, params.userId),
          operators.eq(account.providerId, "twitter"),
        ),
        columns: { id: true },
      }),
    ]);
    traderName = resolveTraderIdentity(params.userId, {
      twitterLinked: Boolean(twitterAccount),
      name: user?.name,
      twitterName: user?.twitterName,
      username: user?.username,
      image: user?.image,
    }).traderName;
  } catch {
    // Identity lookup is cosmetic. Never block a trade notification on it.
  }

  // The headline is the DOLLAR size, not the coin count. "5561.0 ENA" requires
  // knowing ENA's price to mean anything, and coin counts are not comparable
  // across a venue whose unit prices span five orders of magnitude. The coin
  // size still follows, in parentheses, because it is what was actually sent to
  // Hyperliquid and what a reader would check a fill against.
  const content = buildSignalTradeWebhookContent({ ...params, traderName });

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "TradeBot", content }),
    });
    if (!res.ok) {
      defaultLogger.warn(LOG_SERVICE, "Webhook delivery failed", { status: res.status });
    }
  } catch {
    // Non-fatal - webhook failure never blocks trade execution
  }
}

/** Builds the notification only after the venue has returned a confirmed fill. */
export function buildSignalTradeWebhookContent(params: {
  coin: string;
  side: "long" | "short";
  sizeCoin: string;
  sizeUsd: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | undefined;
  riskUsd: number;
  traderName: string;
}): string {
  const emoji = params.side === "long" ? "📈" : "📉";
  const sideWord = params.side === "long" ? "Long" : "Short";
  const tp = params.takeProfit ? ` | TP: ${params.takeProfit}` : "";
  const notional = `$${params.sizeUsd.toFixed(0)}`;
  const executedPrice = formatWebhookPrice(params.entryPrice);

  return (
    `🎯 ${emoji} **${sideWord} ${notional} of ${params.coin}** @ $${executedPrice}` +
    ` (${params.sizeCoin} ${params.coin})` +
    ` | SL: ${params.stopLoss}${tp}` +
    ` | Risk: $${params.riskUsd}` +
    ` - from ${params.traderName}`
  );
}

function formatWebhookPrice(price: number): string {
  const abs = Math.abs(price);
  if (abs === 0 || abs >= 1) return price.toFixed(2);
  const digits = Math.min(12, Math.ceil(-Math.log10(abs)) + 4);
  return price.toFixed(digits);
}

// ---- Poller ------------------------------------------------------------------

export class ExternalDiscordSignalPoller {
  private readonly db: WorkerPoolDb;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(db: WorkerPoolDb, logger?: Logger) {
    this.db = db;
    this.logger = logger ?? defaultLogger;
  }

  private isEnabled(): boolean {
    return process.env[EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED_ENV] === "true";
  }

  public async start(): Promise<void> {
    const enabled = this.isEnabled();
    this.logger.info(LOG_SERVICE, "External Discord signal poller gate", {
      enabled,
      envVar: EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED_ENV,
    });
    if (!enabled) {
      this.logger.info(
        LOG_SERVICE,
        "External Discord signal poller disabled; no polling scheduled",
      );
      return;
    }

    this.stopped = false;
    const channels = Object.entries(followersConfig.channels).map(([channelId, channel]) => ({
      channelId,
      label: channel.label ?? null,
      enabled: channel.enabled,
      enabledFollowers: channel.followers.filter((f) => f.enabled).length,
      totalFollowers: channel.followers.length,
    }));
    this.logger.info(LOG_SERVICE, "Poller started", {
      channels,
      followedChannels: channels.length,
      minConfidence: followersConfig.minConfidence,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    await this.poll();
    this.scheduleNext();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info(LOG_SERVICE, "Poller stopped.");
  }

  private scheduleNext(): void {
    if (this.stopped || !this.isEnabled()) return;
    this.timer = setTimeout(
      () => void this.poll().then(() => this.scheduleNext()),
      POLL_INTERVAL_MS,
    );
  }

  private async poll(): Promise<void> {
    if (!this.isEnabled()) return;
    let redis: Awaited<ReturnType<typeof getRedisClient>> | undefined;
    try {
      redis = await getRedisClient(this.logger);
    } catch (err) {
      this.logger.error(LOG_SERVICE, "Redis unavailable, skipping cycle", { error: String(err) });
      return;
    }

    let cursor = "0";
    try {
      const stored = await redis.get(CURSOR_KEY);
      if (stored) cursor = stored;
    } catch {
      // use default
    }

    let entries: Awaited<ReturnType<typeof redis.xread>>;
    try {
      entries = await redis.xread(STREAM_KEY, cursor, { count: 20, blockMs: 0 });
    } catch (err) {
      this.logger.error(LOG_SERVICE, "Stream read failed", { error: String(err) });
      return;
    }

    if (entries.length === 0) return;

    for (const entry of entries) {
      let retryEntry = false;
      try {
        await this.processEntry(entry.fields as Record<string, string>, entry.id);
      } catch (err) {
        this.logger.error(LOG_SERVICE, "Unhandled error processing entry", {
          entryId: entry.id,
          error: String(err),
        });
        retryEntry = err instanceof ExternalDiscordSignalPersistenceError;
      }
      if (retryEntry) break;
      cursor = entry.id;

      // Persist cursor after every entry so a mid-batch crash does not replay
      // already-processed entries. If this write fails, the worst outcome is one
      // extra replay, which the source-event and order reservations reject.
      try {
        await redis.set(CURSOR_KEY, cursor);
      } catch (cursorErr) {
        this.logger.warn(LOG_SERVICE, "Failed to persist per-entry cursor", {
          entryId: entry.id,
          error: String(cursorErr),
        });
      }
    }
  }

  private async processEntry(fields: Record<string, string>, entryId: string): Promise<void> {
    // Exits are handled on their own path: they carry no stop loss, need no
    // sizing, and must never fall through to the entry parser.
    const exitSignal = parseExternalDiscordExitEntry(fields);
    if (exitSignal) {
      await this.processExitEntry(exitSignal, entryId);
      return;
    }

    const signal = parseExternalDiscordStreamEntry(fields);
    if (!signal) return; // not an actionable entry signal

    // Validate coin against known HL perps
    const canonicalCoin = parseCanonicalPerpCoin(signal.coin);
    if (!canonicalCoin) {
      this.logger.warn(LOG_SERVICE, "Coin not recognised as an HL perp, skipping", {
        entryId,
        coin: signal.coin,
      });
      return;
    }

    let persistence:
      | { status: "inserted"; signalId: string }
      | { status: "duplicate"; signalId: null };
    try {
      persistence = await persistExternalDiscordSignal(this.db, signal, canonicalCoin);
    } catch (error) {
      throw new ExternalDiscordSignalPersistenceError(error);
    }

    this.logger.info(LOG_SERVICE, "New signal", {
      entryId,
      coin: canonicalCoin,
      side: signal.side,
      entryPrice: signal.entryPrice ?? "market",
      stopLoss: signal.stopLoss,
      author: signal.authorName,
      persistence: persistence.status,
    });

    if (persistence.status === "duplicate") {
      this.logger.info(LOG_SERVICE, "Duplicate source event, not executing", { entryId });
      return;
    }

    if (!isFreshExternalDiscordSignal(
      signal.messageTimestamp,
      new Date(),
      externalDiscordSignalMaxAgeMs(),
    )) {
      this.logger.info(LOG_SERVICE, "Stale source event retained for research, not executing", {
        entryId,
        sourceTimestamp: signal.messageTimestamp.toISOString(),
      });
      return;
    }

    // Confidence is an execution policy for configured followers, not an
    // ingestion policy. Low-confidence calls still belong in the leaderboard
    // and profile history once their signal and canonical market are valid.
    const minRank = CONFIDENCE_RANK[followersConfig.minConfidence] ?? 1;
    if ((CONFIDENCE_RANK[signal.confidence] ?? 0) < minRank) {
      this.logger.info(LOG_SERVICE, "Signal confidence below follower threshold, not executing", {
        entryId,
        coin: canonicalCoin,
        confidence: signal.confidence,
      });
      return;
    }

    const network = networkFromEnv();
    if (!isExternalDiscordExecutionAllowed(
      network,
      process.env[EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET_ENV],
    )) {
      this.logger.warn(LOG_SERVICE, "Mainnet follower execution is not explicitly enabled", {
        entryId,
        envVar: EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET_ENV,
      });
      return;
    }

    const entryFollowers = resolveEntryFollowers(followersConfig, signal.channelId);
    if (entryFollowers.length === 0) {
      this.logger.info(LOG_SERVICE, "No enabled followers for this channel, not executing", {
        entryId,
        channelId: signal.channelId,
        channelConfigured: signal.channelId in followersConfig.channels,
      });
      return;
    }
    for (const follower of entryFollowers) {
      await this.executeForFollower(
        signal,
        canonicalCoin,
        follower,
        entryId,
        persistence.signalId,
      );
    }
  }

  /**
   * Route an exit instruction to every follower of the source channel.
   *
   * Exits are not persisted as signals: a close is not a call, and the
   * leaderboard scores entries. Idempotency comes from the deterministic cloid
   * on the reduce-only order instead of the source-event table.
   */
  private async processExitEntry(signal: ParsedExitSignal, entryId: string): Promise<void> {
    const canonicalCoin = parseCanonicalPerpCoin(signal.coin);
    if (!canonicalCoin) {
      this.logger.warn(LOG_SERVICE, "Exit coin not recognised as an HL perp, skipping", {
        entryId,
        coin: signal.coin,
        action: signal.action,
      });
      return;
    }

    this.logger.info(LOG_SERVICE, "Exit instruction", {
      entryId,
      action: signal.action,
      coin: canonicalCoin,
      reducePct: signal.reducePct,
      author: signal.authorName,
    });

    // A stale exit is more dangerous than a missed one: replaying an old close
    // after a restart would flatten a position opened since.
    if (!isFreshExternalDiscordSignal(
      signal.messageTimestamp,
      new Date(),
      externalDiscordSignalMaxAgeMs(),
    )) {
      this.logger.info(LOG_SERVICE, "Stale exit instruction, not executing", {
        entryId,
        sourceTimestamp: signal.messageTimestamp.toISOString(),
      });
      return;
    }

    const network = networkFromEnv();
    if (!isExternalDiscordExecutionAllowed(
      network,
      process.env[EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET_ENV],
    )) {
      this.logger.warn(LOG_SERVICE, "Mainnet follower execution is not explicitly enabled", {
        entryId,
        envVar: EXTERNAL_DISCORD_SIGNAL_ALLOW_MAINNET_ENV,
      });
      return;
    }

    const exitFollowers = resolveExitFollowers(followersConfig, signal.channelId);
    if (exitFollowers.length === 0) {
      this.logger.info(LOG_SERVICE, "No followers configured for this channel, no exit to route", {
        entryId,
        channelId: signal.channelId,
      });
      return;
    }
    for (const follower of exitFollowers) {
      await this.executeExitForFollower(signal, canonicalCoin, follower, entryId);
    }
  }

  /**
   * Read the sliding-window open counters for one (channel, follower), pruning
   * anything older than the longest configured window as a side effect.
   *
   * Redis being unavailable returns null, which the caller treats as "do not
   * open". A rate limit that fails open would let a burst through in exactly
   * the situation where the system is already unhealthy.
   */
  private async readOpenTimestamps(
    channelId: string,
    followerUserId: string,
    windows: OpenRateLimitWindow[],
    nowMs: number,
  ): Promise<number[] | null> {
    const key = openRateLimitKey(channelId, followerUserId);
    const retentionMs = longestWindowSeconds(windows) * 1000;
    try {
      const redis = await getRedisClient(this.logger);
      await redis.zremrangebyscore(key, 0, nowMs - retentionMs);
      const withScores = await redis.zrange(key, 0, -1, true);
      // zrange withScores returns a flat [member, score, member, score, ...]
      const timestamps: number[] = [];
      for (let index = 1; index < withScores.length; index += 2) {
        const score = Number(withScores[index]);
        if (Number.isFinite(score)) timestamps.push(score);
      }
      return timestamps;
    } catch (err) {
      this.logger.error(LOG_SERVICE, "Rate limit state unreadable, refusing to open", {
        channelId,
        error: String(err),
      });
      return null;
    }
  }

  /** Consume one unit of entry budget. Called only once a position may be live. */
  private async recordOpen(
    channelId: string,
    followerUserId: string,
    messageId: string,
    windows: OpenRateLimitWindow[],
    nowMs: number,
  ): Promise<void> {
    const key = openRateLimitKey(channelId, followerUserId);
    try {
      const redis = await getRedisClient(this.logger);
      await redis.zadd(key, nowMs, messageId);
      await redis.expire(key, longestWindowSeconds(windows));
    } catch (err) {
      // Non-fatal: the position is already open. Losing the counter can only
      // permit one extra entry later, never affect the trade just placed.
      this.logger.warn(LOG_SERVICE, "Failed to record open against rate limit", {
        channelId,
        error: String(err),
      });
    }
  }

  private async executeExitForFollower(
    signal: ParsedExitSignal,
    coin: string,
    follower: FollowerConfig,
    entryId: string,
  ): Promise<void> {
    const logCtx = { entryId, coin, action: signal.action, email: follower.email };

    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, follower.email.toLowerCase()),
      columns: { id: true, email: true },
    });
    if (!user) {
      this.logger.warn(LOG_SERVICE, "User not found by email", logCtx);
      return;
    }

    let client: Awaited<ReturnType<typeof createHyperliquidExchangeClient>>["client"];
    let walletAddress: Awaited<
      ReturnType<typeof createHyperliquidExchangeClient>
    >["walletAddress"];
    try {
      ({ client, walletAddress } = await createHyperliquidExchangeClient(this.db, user.id));
    } catch (err) {
      this.logger.error(LOG_SERVICE, "Failed to create HL client", {
        ...logCtx,
        error: String(err),
      });
      return;
    }

    // Every exit resolves the LIVE position first. No position means no-op -
    // never an order that could open exposure in the opposite direction.
    let position: Awaited<ReturnType<typeof client.listPositions>>[number] | undefined;
    try {
      position = (await client.listPositions(walletAddress)).find((item) => item.coin === coin);
    } catch (err) {
      this.logger.error(LOG_SERVICE, "Failed to read positions for exit", {
        ...logCtx,
        error: String(err),
      });
      return;
    }
    if (!position) {
      this.logger.info(LOG_SERVICE, "No open position for exit instruction, nothing to do", logCtx);
      return;
    }

    const clientOrderId = `${buildExternalDiscordClientOrderId({
      channelId: signal.channelId,
      messageId: signal.messageId,
      canonicalCoin: coin,
      followerUserId: user.id,
    })}:${signal.action}`;

    const positionSize = parseStrictPositiveNumber(position.size);
    if (positionSize === null) {
      this.logger.warn(LOG_SERVICE, "Live position has an unusable size, skipping exit", {
        ...logCtx,
        size: position.size,
      });
      return;
    }

    const markPrice = position.markPx ?? undefined;

    try {
      if (signal.action === "close") {
        // PerpPosition.size is absolute with a separate side; marketClose wants
        // the signed szi and derives the closing direction from its sign.
        const signedSize = position.side === "long" ? positionSize : -positionSize;
        await client.marketClose({
          coin,
          positionSize: signedSize,
          markPrice: markPrice ?? "",
          clientOrderId,
        });
        this.logger.info(LOG_SERVICE, "Position closed", {
          ...logCtx,
          size: positionSize,
          side: position.side,
        });
        return;
      }

      if (signal.action === "reduce") {
        const pct = signal.reducePct ?? 0;
        const { szDecimals } = await client.resolveAsset(coin);
        const rawSize = (positionSize * pct) / 100;
        const rounded = parseFloat(rawSize.toFixed(szDecimals));

        if (!(rounded > 0)) {
          this.logger.info(LOG_SERVICE, "Trim rounds to zero at this size, skipping", {
            ...logCtx,
            positionSize,
            reducePct: pct,
            szDecimals,
          });
          return;
        }
        if (rounded >= positionSize) {
          // A trim that meets or exceeds the position is a close.
          const signedSize = position.side === "long" ? positionSize : -positionSize;
          await client.marketClose({
            coin,
            positionSize: signedSize,
            markPrice: markPrice ?? "",
            clientOrderId,
          });
          this.logger.info(LOG_SERVICE, "Trim covered the whole position, closed instead", {
            ...logCtx,
            positionSize,
            reducePct: pct,
          });
          return;
        }

        await client.placeOrder({
          coin,
          side: position.side === "long" ? "short" : "long",
          size: rounded,
          orderType: "Market",
          reduceOnly: true,
          clientOrderId,
          ...(markPrice ? { markPrice } : {}),
        });
        this.logger.info(LOG_SERVICE, "Position reduced", {
          ...logCtx,
          reducePct: pct,
          size: rounded,
          positionSize,
        });
        return;
      }

      // stop_be
      const entryPx = parseStrictPositiveNumber(position.entryPx);
      const markPx = parseStrictPositiveNumber(position.markPx);
      if (entryPx === null || markPx === null) {
        this.logger.info(LOG_SERVICE, "Missing entry/mark price, cannot move stop to BE", logCtx);
        return;
      }

      // Only move to breakeven when the stop would land on the profitable side
      // of mark. On an underwater position a BE stop sits the wrong side of the
      // market and triggers an immediate exit at a loss.
      const favourable = position.side === "long" ? markPx > entryPx : markPx < entryPx;
      if (!favourable) {
        this.logger.info(LOG_SERVICE, "Position not in profit, refusing to move stop to BE", {
          ...logCtx,
          entryPx,
          markPx,
          side: position.side,
        });
        return;
      }

      await client.setPositionTpSl({
        coin,
        positionSide: position.side,
        size: positionSize,
        stopLossPx: String(entryPx),
        clientOrderId: `${clientOrderId}:tpsl`,
        isMarket: true,
      });
      this.logger.info(LOG_SERVICE, "Stop moved to breakeven", {
        ...logCtx,
        entryPx,
        size: positionSize,
      });
    } catch (err) {
      // Exits never retry. A stale close firing minutes later is worse than a
      // missed one, so the failure is logged loudly and the cursor moves on.
      this.logger.error(LOG_SERVICE, `Exit action failed (${signal.action})`, {
        ...logCtx,
        clientOrderId,
        error: String(err),
      });
    }
  }

  private async executeForFollower(
    signal: ParsedSignal,
    coin: string,
    follower: FollowerConfig,
    entryId: string,
    signalId: string,
  ): Promise<void> {
    const logCtx = { entryId, signalId, coin, email: follower.email };

    // Look up user by email (normalize to lowercase to match DB storage convention)
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, follower.email.toLowerCase()),
      columns: { id: true, email: true },
    });
    if (!user) {
      this.logger.warn(LOG_SERVICE, "User not found by email", logCtx);
      return;
    }

    // Find their registered HL credential
    const credential = await this.db.query.userApiCredentials.findFirst({
      where: and(
        eq(schema.userApiCredentials.userId, user.id),
        eq(schema.userApiCredentials.provider, "hyperliquid"),
        eq(schema.userApiCredentials.accountType, HL_AGENT_REGISTERED),
      ),
    });
    if (!credential) {
      this.logger.warn(LOG_SERVICE, "No registered HL credential, skipping", {
        ...logCtx,
        userId: user.id,
      });
      return;
    }

    // Entry rate limit, per (channel, follower). Exits are never limited.
    const rateLimitWindows = resolveOpenRateLimits(followersConfig, signal.channelId);
    const nowMs = Date.now();
    const openTimestamps = await this.readOpenTimestamps(
      signal.channelId,
      user.id,
      rateLimitWindows,
      nowMs,
    );
    if (openTimestamps === null) return; // Redis down - fail closed
    const rateLimit = evaluateOpenRateLimit(openTimestamps, nowMs, rateLimitWindows);
    if (!rateLimit.allowed) {
      this.logger.info(LOG_SERVICE, "Entry rate limit reached, not opening", {
        ...logCtx,
        channelId: signal.channelId,
        windowSeconds: rateLimit.exceeded?.windowSeconds,
        maxOpens: rateLimit.exceeded?.maxOpens,
        observedOpens: rateLimit.observed,
        retryAt: rateLimit.retryAtMs ? new Date(rateLimit.retryAtMs).toISOString() : null,
      });
      return;
    }

    // Build HL exchange client
    let client: Awaited<ReturnType<typeof createHyperliquidExchangeClient>>["client"];
    try {
      ({ client } = await createHyperliquidExchangeClient(this.db, user.id));
    } catch (err) {
      this.logger.error(LOG_SERVICE, "Failed to create HL client", {
        ...logCtx,
        error: String(err),
      });
      return;
    }

    // Resolve entry price - use live mid when signal says market/CMP
    let entryPrice = signal.entryPrice;
    if (entryPrice === null) {
      try {
        const infoClient = createHyperliquidInfoClient();
        const mids = await infoClient.allMids(coin);
        const mid = mids[coin];
        const parsedMid = parseStrictPositiveNumber(mid);
        if (parsedMid === null) throw new Error(`No valid mid for ${coin}`);
        entryPrice = parsedMid;
      } catch (err) {
        this.logger.error(LOG_SERVICE, "Failed to fetch live mid price", {
          ...logCtx,
          error: String(err),
        });
        return;
      }
    }

    // When the message carried no stop, derive one 20% adverse to the live
    // entry. No extra size cut is applied: computeSizeCoin is
    // risk/stop-distance, so the wider stop already yields a proportionally
    // smaller position at the same riskPerTradeUsd.
    const effectiveStopLoss = signal.stopLoss
      ?? deriveExternalDiscordFallbackStop(entryPrice, signal.side);

    if (signal.stopLoss === null) {
      this.logger.info(LOG_SERVICE, "No stop in message, using fallback stop", {
        ...logCtx,
        entryPrice,
        fallbackStopLoss: effectiveStopLoss,
        fractionAdverse: SL_FALLBACK_FRACTION,
      });
    }

    // Size the position
    const sizeCoin = computeSizeCoin({
      riskPerTradeUsd: follower.riskPerTradeUsd,
      entryPrice,
      stopLoss: effectiveStopLoss,
      side: signal.side,
    });
    if (!sizeCoin) {
      this.logger.warn(LOG_SERVICE, "Invalid SL/entry - cannot size position", {
        ...logCtx,
        entryPrice,
        stopLoss: effectiveStopLoss,
        side: signal.side,
      });
      return;
    }

    const sizeUsd = parseFloat(sizeCoin) * entryPrice;
    // Deterministic cloid - deduplicates if the same stream entry is processed twice
    const clientOrderId = buildExternalDiscordClientOrderId({
      channelId: signal.channelId,
      messageId: signal.messageId,
      canonicalCoin: coin,
      followerUserId: user.id,
    });

    const firstTp = signal.takeProfits[0];
    if (
      firstTp !== undefined &&
      (signal.side === "long" ? firstTp <= entryPrice : firstTp >= entryPrice)
    ) {
      this.logger.warn(LOG_SERVICE, "Take-profit is on the wrong side of live entry", {
        ...logCtx,
        entryPrice,
        takeProfit: firstTp,
      });
      return;
    }

    const inputResult = perpOrderSubmitSchema.safeParse({
      coin,
      isLong: signal.side === "long",
      marginMode: follower.marginMode,
      orderType: "Market",
      sizeCoin,
      reduceOnly: false,
      postOnly: false,
      leverage: follower.leverage,
      cloid: clientOrderId,
      markPrice: String(entryPrice),
    });
    if (!inputResult.success) {
      this.logger.warn(LOG_SERVICE, "Unsafe perp order input, not executing", {
        ...logCtx,
        issues: inputResult.error.issues.map((issue) => issue.message),
      });
      return;
    }

    const orderRow = toPerpOrderRow(inputResult.data, user.id, credential.accountId);
    const [reservedOrder] = await this.db
      .insert(schema.orders)
      .values({
        ...orderRow,
        signalId,
        brokerCredentialId: credential.id,
        maxRisk: String(follower.riskPerTradeUsd),
        initialStopLossPx: String(effectiveStopLoss),
        initialTakeProfitPx: firstTp !== undefined ? String(firstTp) : null,
        notes: "[external-discord] direct Hyperliquid signal execution",
        copySourceLabel: signal.authorName,
      })
      .onConflictDoNothing({ target: schema.orders.clientOrderId })
      .returning({ id: schema.orders.id });
    if (!reservedOrder) {
      this.logger.info(LOG_SERVICE, "Follower order already reserved, not replaying", {
        ...logCtx,
        clientOrderId,
      });
      return;
    }

    const updateReservedOrder = async (
      values: Partial<typeof schema.orders.$inferInsert>,
    ): Promise<void> => {
      await this.db
        .update(schema.orders)
        .set({ ...values, statusUpdatedAt: new Date() })
        .where(eq(schema.orders.id, reservedOrder.id));
    };

    this.logger.info(LOG_SERVICE, "Placing order", {
      ...logCtx,
      sizeCoin,
      sizeUsd: sizeUsd.toFixed(2),
      riskUsd: follower.riskPerTradeUsd,
      leverage: follower.leverage,
    });

    // Setting leverage is part of preparing the requested order. If it fails,
    // proceeding could execute with a materially different risk profile.
    try {
      await client.updateLeverage({
        coin,
        leverage: follower.leverage,
        marginMode: follower.marginMode,
      });
    } catch (err) {
      await updateReservedOrder({
        status: "REJECTED",
        syncReason: `Leverage update failed before submission: ${String(err)}`,
      });
      this.logger.error(LOG_SERVICE, "Leverage update failed, not placing order", {
        ...logCtx,
        error: String(err),
      });
      return;
    }

    let placementResult: unknown;
    try {
      placementResult = await client.placeOrder(toPlacePerpOrderRequest(inputResult.data));
    } catch (err) {
      if (
        err instanceof HyperliquidOrderRejectedError ||
        err instanceof HyperliquidOrderPreparationError
      ) {
        await updateReservedOrder({
          status: "REJECTED",
          syncReason: `Hyperliquid rejected the order: ${err.message}`,
        });
      } else {
        await updateReservedOrder({
          syncReason: `Hyperliquid submission outcome is ambiguous: ${String(err)}`,
        });
      }
      this.logger.error(LOG_SERVICE, "Market order failed", {
        ...logCtx,
        error: String(err),
        outcome: err instanceof HyperliquidOrderRejectedError ||
          err instanceof HyperliquidOrderPreparationError
          ? "rejected"
          : "ambiguous",
      });
      return;
    }

    // The order was accepted, so a position may now be live. Consume one unit
    // of entry budget here rather than at the gate above, so rejected or failed
    // submissions never eat the allowance.
    await this.recordOpen(
      signal.channelId,
      user.id,
      signal.messageId,
      rateLimitWindows,
      Date.now(),
    );

    // Protection must be attempted for any size that may be live on the venue,
    // whether the fill was confirmed or only assumed from an accepted order.
    const placeProtection = async (protectedSize: string): Promise<void> => {
      await sleep(POST_ORDER_DELAY_MS);
      try {
        await client.setPositionTpSl({
          coin,
          positionSide: signal.side,
          size: protectedSize,
          stopLossPx: String(effectiveStopLoss),
          ...(firstTp !== undefined ? { takeProfitPx: String(firstTp) } : {}),
          clientOrderId: `${clientOrderId}:tpsl`,
          isMarket: true,
        });
        this.logger.info(LOG_SERVICE, "SL set", {
          ...logCtx,
          stopLoss: effectiveStopLoss,
          takeProfit: firstTp ?? null,
          size: protectedSize,
        });
      } catch (err) {
        // Non-fatal but loud - position may be open without SL
        this.logger.error(
          LOG_SERVICE,
          "SL placement failed - POSITION IS OPEN WITHOUT STOP LOSS",
          { ...logCtx, stopLoss: effectiveStopLoss, size: protectedSize, error: String(err) },
        );
      }
    };

    const outcome = resolveExternalDiscordPlacementOutcome(placementResult, sizeCoin, new Date());
    await updateReservedOrder(outcome.orderUpdate);
    if (outcome.fill) {
      // Followers only ever see this trade through the social feed (see
      // toExternalDiscordSocialTrade). Publish before the protection delay so
      // the mirror can stage it promptly. Never let a feed failure abort the
      // stop-loss placement below: the position is already live.
      const socialTrade = toExternalDiscordSocialTrade(
        {
          id: reservedOrder.id,
          userId: user.id,
          symbol: coin,
          tradeAction: orderRow.tradeAction,
          orderType: orderRow.orderType,
        },
        outcome.fill,
      );
      if (socialTrade) {
        try {
          await this.db.insert(schema.socialTrades).values(socialTrade);
        } catch (err) {
          this.logger.error(LOG_SERVICE, "Social feed publish failed; followers will not see this fill", {
            ...logCtx,
            orderId: reservedOrder.id,
            error: String(err),
          });
        }
      }
    } else {
      this.logger.warn(LOG_SERVICE, "Order accepted without a confirmed fill", {
        ...logCtx,
        clientOrderId,
        protectionSize: outcome.protectionSize,
      });
    }
    if (outcome.protectionSize) await placeProtection(outcome.protectionSize);
    const fill = outcome.fill;
    if (!fill) return;

    // Webhook notification
    await sendSignalTradeWebhook({
      db: this.db,
      coin,
      side: signal.side,
      sizeCoin: fill.sizeCoin,
      sizeUsd: parseFloat(fill.sizeCoin) * fill.entryPrice,
      entryPrice: fill.entryPrice,
      stopLoss: effectiveStopLoss,
      takeProfit: firstTp,
      userId: user.id,
      riskUsd: follower.riskPerTradeUsd,
    });
  }
}
