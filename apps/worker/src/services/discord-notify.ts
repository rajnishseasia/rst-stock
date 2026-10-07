/**
 * Discord Webhook Notification Service
 *
 * Sends compact, single-line order updates to a Discord channel. The previous
 * format was a multi-line "Order Submitted" / "Order Filled" card that fired
 * twice for every limit order (once on submit, again on fill) and was hard to
 * scan on mobile. The new format collapses to one line per order:
 *
 *   📥 📈 Buy 1 LIN @ $552.73 (limit) - from SwiftFalcon123    ← limit submit
 *   ✅ 📈 Buy 1 LIN @ $552.73 (market) - from SwiftFalcon123   ← market fill
 *   ✅ 🩳 Short 5 SPY @ $450.00 (stop) - from BoldMarlin42     ← short fill
 *   🚫 Cancelled - 📉 Sell 3 TSLA @ $200.00 (limit) - from QuietOtter567
 *
 * Each line leads with a status emoji (fill state) followed by a direction
 * emoji (trade action), the human-readable action word, and a pseudonymized
 * trader name. "Sell short" positions say "Short" instead of "Sell" so the
 * direction is immediately obvious.
 *
 * For LIMIT/STOPLIMIT orders we notify on both SUBMITTED and FILLED: the submit
 * shows the resting price, and the fill confirms execution. For MARKET/STOPMARKET
 * orders we notify only on the FILL, because the submit carries no price
 * information. Terminal non-fill states (CANCELLED / REJECTED / EXPIRED) always
 * notify so a failed order is never silently swallowed.
 *
 * Venue-close alerts additionally pass through a one-per-person-per-ticker-per-
 * minute throttle, because a close that fills in pieces is one event reported
 * several times. See discord-alert-throttle.ts.
 */

import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { and, eq } from "drizzle-orm";
import {
  anonymizeTrader,
  resolveTraderIdentity,
} from "../../../api/src/lib/trader-identity";
import {
  createCloseAlertThrottle,
  type AlertThrottle,
} from "./discord-alert-throttle";

export interface OrderNotification {
  symbol: string;
  side?: string;
  quantity: number;
  /** Fractional perp size. When present it is displayed instead of quantity. */
  quantityDecimal?: string | null;
  status: string;
  previousStatus: string;
  executedPrice?: number | null;
  orderId: string;
  assetType?: string | null;
  /** DB order type: Market | Limit | StopMarket | StopLimit | OCO */
  orderType?: string | null;
  /** The resting limit price for Limit / StopLimit orders. */
  limitPrice?: number | null;
  /** User id — used to derive the pseudonymized trader name appended to the line. */
  userId?: string | null;
  /** Resolved linked-X name. Falls back to the deterministic pseudonym. */
  traderName?: string | null;
  /**
   * Why a position ended, when the venue (not the app) ended it.
   *
   * A stop firing and a close the user made deliberately previously rendered
   * as the same line, which is precisely how a stop-out goes unnoticed until
   * someone opens the broker. Only set this when it is evidenced; a guess here
   * is worse than the silence it replaces.
   */
  closeReason?: "stop_loss" | "take_profit" | "liquidation" | null;
  /**
   * The fill was found at the venue rather than placed through the app. Read
   * by the line so an externally-placed trade is not presented as one of ours.
   */
  externalOrigin?: boolean;
  /**
   * Attribution set on orders placed by the copy mirror. Those fills belong to
   * the follower's account history but must not echo the source trade into the
   * public Discord channel once per follower.
   */
  copySourceLabel?: string | null;
  /**
   * Position direction (long or short). Used by the formatter to disambiguate
   * perp orders where tradeAction is always "Buy"/"Sell" regardless of whether
   * the order opens or closes a position. Passing "short" with side "Sell"
   * renders "Short" (opening a short) rather than "Sell" (closing a long).
   */
  direction?: "long" | "short";
  /**
   * Whether the venue will only reduce an existing position. For perp orders,
   * this distinguishes a sell that closes a long from one that opens a short,
   * and a buy that covers a short from one that opens a long.
   */
  reduceOnly?: boolean | null;
  /**
   * When the VENUE filled this order, not when we reconciled it.
   *
   * Drives the staleness guard (see `isStaleFill`). Pass the venue's own fill
   * timestamp: Hyperliquid's `time` / `executedAtMs`, or Alpaca's `filled_at`.
   * Never pass `statusUpdatedAt` or `createdAt`. Reconcile time is exactly the
   * value that makes a month-old fill look like it just happened, which is the
   * bug this field exists to prevent.
   *
   * Absent means "unknown age" and the alert is sent, so callers that genuinely
   * have no fill time (an Alpaca cancellation, say) keep their current behaviour.
   */
  executedAt?: Date | number | null;
}

interface DiscordTraderProfile {
  twitterLinked: boolean;
  name?: string | null;
  twitterName?: string | null;
  username?: string | null;
  image?: string | null;
}

export interface DiscordNotificationDependencies {
  loadTraderProfile: (userId: string) => Promise<DiscordTraderProfile | null>;
}

/**
 * Read identity and linked-account evidence in one query. The previous two
 * relational queries failed as a unit: an accounts lookup problem discarded a
 * user row that already contained the synced X display name. A single join is
 * both cheaper and gives the webhook the same linkage contract as leaderboard.
 */
async function loadTraderProfile(
  db: WorkerPoolDb,
  userId: string,
): Promise<DiscordTraderProfile | null> {
  const [row] = await db
    .select({
      name: schema.users.name,
      twitterName: schema.users.twitterName,
      username: schema.users.username,
      image: schema.users.image,
      twitterAccountId: schema.accounts.id,
    })
    .from(schema.users)
    .leftJoin(
      schema.accounts,
      and(
        eq(schema.accounts.userId, schema.users.id),
        eq(schema.accounts.providerId, "twitter"),
      ),
    )
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!row) return null;
  return {
    twitterLinked: Boolean(row.twitterAccountId),
    name: row.name,
    twitterName: row.twitterName,
    username: row.username,
    image: row.image,
  };
}

const defaultDependencies: DiscordNotificationDependencies = {
  loadTraderProfile: async () => {
    throw new Error(
      "Discord trader-profile lookup requires a worker database dependency",
    );
  },
};

/**
 * Bind Discord identity lookups to the worker's long-lived database pool.
 *
 * The worker is configured with DATABASE_URL_DIRECT and constructs this pool
 * once at startup. Calling the API/serverless `getDb()` helper from here tried
 * to build a second connection from DATABASE_URL(_POOLED), which the worker
 * intentionally does not have, so every alert fell back to a pseudonym.
 */
export function createDiscordNotificationSender(db: WorkerPoolDb) {
  const dependencies: DiscordNotificationDependencies = {
    loadTraderProfile: (userId) => loadTraderProfile(db, userId),
  };
  return (order: OrderNotification): Promise<void> =>
    sendDiscordNotification(order, dependencies);
}

/** Emoji + optional prefix word for each status we emit. */
const STATUS_PRESENTATION: Record<string, { emoji: string; prefix?: string }> = {
  SUBMITTED: { emoji: "📥" },
  FILLED: { emoji: "" },
  PARTIAL: { emoji: "⏳", prefix: "Partial" },
  CANCELLED: { emoji: "🚫", prefix: "Cancelled" },
  REJECTED: { emoji: "❌", prefix: "Rejected" },
  EXPIRED: { emoji: "⏰", prefix: "Expired" },
};

/**
 * Maps the DB tradeAction (or legacy lowercase side) to the human-readable
 * word shown in the webhook line. "SellShort" and "SellToOpen" both map to
 * "Short" so it is immediately clear this is a short position, not a plain
 * sale of existing shares.
 */
const SIDE_WORD: Record<string, string> = {
  Buy: "Buy",
  BuyToOpen: "Buy",
  BuyToCover: "Close Short",
  BuyToClose: "Close",
  Sell: "Sell",
  SellToClose: "Close",
  SellShort: "Short",
  SellToOpen: "Short",
};

/**
 * Direction emoji paired with each trade action. Shown inline right before
 * the side word so readers can scan the trade direction at a glance.
 *   📈  going long / buying
 *   📉  reducing a long / selling
 *   🩳  opening a short
 *   🔄  closing a short
 */
const ACTION_EMOJI: Record<string, string> = {
  Buy: "📈",
  BuyToOpen: "📈",
  BuyToCover: "🔄",
  BuyToClose: "📉",
  Sell: "📉",
  SellToClose: "📉",
  SellShort: "🩳",
  SellToOpen: "🩳",
};

/**
 * The close reason implied by a DB order type, for the row-driven pollers.
 *
 * Only a REDUCE-ONLY trigger closes a position. An opening stop-market entry
 * is the same order type and must not be announced as a stop-out.
 */
export function closeReasonForOrderType(
  orderType: string | null | undefined,
  reduceOnly: boolean | null | undefined,
): "stop_loss" | "take_profit" | null {
  if (!reduceOnly) return null;
  if (orderType === "StopMarket" || orderType === "StopLimit") return "stop_loss";
  if (orderType === "TakeProfitMarket" || orderType === "TakeProfitLimit") {
    return "take_profit";
  }
  return null;
}

/** Leading label for a position the venue closed. Loud on purpose. */
const CLOSE_REASON_LABEL: Record<"stop_loss" | "take_profit" | "liquidation", string> = {
  stop_loss: "🛑 STOP HIT -",
  take_profit: "🎯 TARGET HIT -",
  liquidation: "☠️ LIQUIDATED -",
};

/** Short, lowercase order-type label that fits inline at the end of the line. */
const ORDER_TYPE_SHORT: Record<string, string> = {
  Market: "market",
  Limit: "limit",
  StopMarket: "stop",
  StopLimit: "stop-limit",
  TakeProfitMarket: "take-profit",
  TakeProfitLimit: "take-profit-limit",
  OCO: "bracket",
};

function isLimitType(orderType?: string | null): boolean {
  // TakeProfitLimit belongs here for the same reason StopLimit does: it rests on
  // the book at a known limit price. Listing it in ORDER_TYPE_SHORT without
  // adding it here left it in the "unknown, let it through" branch of
  // shouldSuppress, so it notified on every status transition rather than on
  // SUBMITTED and FILLED, against this file's own one-webhook-per-order rule.
  // It also kept priceToShow from surfacing the resting limit price, which is
  // known at SUBMITTED.
  return (
    orderType === "Limit" ||
    orderType === "StopLimit" ||
    orderType === "TakeProfitLimit"
  );
}

function isMarketType(orderType?: string | null): boolean {
  return (
    orderType === "Market" ||
    orderType === "StopMarket" ||
    orderType === "TakeProfitMarket"
  );
}

/**
 * Returns true if we should suppress this notification. The intent is exactly
 * one webhook per order in the happy path:
 *  - Limit-type: keep SUBMITTED and FILLED, drop PARTIAL.
 *  - Market-type: drop SUBMITTED, keep FILLED. PARTIAL is dropped (wait for
 *    the consolidating FILLED ping).
 *  - Any order: terminal non-fill states always fire.
 *
 * Note on the limit-type FILLED branch: in-app limit orders are persisted
 * directly as SUBMITTED (apps/api/src/routers/orders.ts) so the OrderSyncPoller
 * never observes a transition INTO SUBMITTED, meaning the intended "limit
 * submitted" ping never actually fires. Previously we also suppressed the
 * FILLED transition on the theory that the SUBMITTED ping had already gone
 * out, so limits silently emitted zero webhooks. Allowing FILLED through here
 * fixes the silent miss and keeps one ping per limit in the common case (the
 * fill, matching market-order behavior). See
 * docs/tasks/COPY-TRADE-EXTERNAL-FILLS-SCOPE.md section 1.6.
 */
function shouldSuppress(order: OrderNotification): boolean {
  // A copied order is a delivery of an already-announced source trade. Every
  // follower gets a distinct order id, so order-level dedupe alone cannot stop
  // a popular trade from flooding the webhook once per follower.
  if (order.copySourceLabel?.trim()) return true;

  // A stop-out, take-profit or liquidation always fires. These are the events
  // a user most needs told about and least expects, and gating them behind the
  // order-type table is how one of them ends up silently dropped: an external
  // fill has no order type at all, which lands in the "unknown" branch by luck
  // rather than by decision.
  if (order.closeReason) return false;

  const terminalProblem =
    order.status === "CANCELLED" ||
    order.status === "REJECTED" ||
    order.status === "EXPIRED";
  if (terminalProblem) return false;

  if (isLimitType(order.orderType)) {
    return order.status !== "SUBMITTED" && order.status !== "FILLED";
  }
  if (isMarketType(order.orderType)) {
    return order.status !== "FILLED";
  }
  // Unknown / OCO etc. — keep the existing behaviour and let it through.
  return false;
}

/**
 * Fills use only confirmed execution prices. Other order states can show their
 * resting limit price; market submits return null and are suppressed anyway.
 */
function priceToShow(order: OrderNotification): number | null {
  if (order.status === "FILLED" || order.status === "PARTIAL") {
    return order.executedPrice ?? null;
  }
  if (order.executedPrice != null) return order.executedPrice;
  if (isLimitType(order.orderType) && order.limitPrice != null) {
    return order.limitPrice;
  }
  return null;
}

/**
 * Normalize "sell" -> "Sell", "SellShort" -> "SellShort". Capitalizes only
 * the first character so camelCase trade actions like "SellShort" are
 * preserved intact (unlike a full capitalize which lowercases the tail).
 */
function normalizeSide(side: string): string {
  return side.charAt(0).toUpperCase() + side.slice(1);
}

/**
 * Formats a price with precision scaled to its magnitude. A plain
 * toFixed(2) collapses a low-priced Hyperliquid perp fill (executed_price is
 * decimal(24,8) specifically because these can carry many fractional digits,
 * see packages/db/src/schema/orders.ts) to "$0.00", which is indistinguishable
 * from a genuinely unpriced order in the one channel that tells followers what
 * the auto-mirror paid. Mirrors the scaling idiom in
 * apps/web-v2/src/components/perps/perp-format.ts (adaptiveMaxFractionDigits)
 * without importing across the app boundary: prices >= $1 keep the existing
 * fixed 2dp so normal equity/perp fills render exactly as before, and only
 * sub-$1 prices widen to keep their significant figures.
 */
function formatPrice(price: number): string {
  const abs = Math.abs(price);
  if (abs === 0 || abs >= 1) return price.toFixed(2);
  const digits = Math.min(12, Math.ceil(-Math.log10(abs)) + 4);
  return price.toFixed(digits);
}

/**
 * An equity option's premium is quoted PER SHARE and one contract covers 100.
 * Multiplying the quantity by the bare premium understates what was spent by
 * exactly this factor, which is the same 100x trap the "(option)" marker below
 * exists to flag.
 */
const OPTION_CONTRACT_MULTIPLIER = 100;

/**
 * What the trade is worth in dollars: size x price, with the option multiplier
 * applied. Null when there is no usable price or size, in which case the line
 * falls back to showing the quantity.
 *
 * Not a claim about cash outlay. A leveraged perp costs margin rather than
 * notional, and a close returns money rather than spending it; this is the
 * position's dollar size, which is the figure that makes one trade comparable
 * to another.
 */
export function notionalUsd(order: OrderNotification): number | null {
  const price = priceToShow(order);
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const size = Number(order.quantityDecimal ?? order.quantity);
  if (!Number.isFinite(size) || size === 0) return null;
  const multiplier = order.assetType === "OPTION" ? OPTION_CONTRACT_MULTIPLIER : 1;
  return Math.abs(size) * price * multiplier;
}

/** Plain 2dp currency for a dollar amount. Prices use `formatPrice` instead. */
function formatUsdAmount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Builds the single-line message body. Exported for tests / reuse. */
export function formatOrderLine(order: OrderNotification): string {
  const presentation =
    STATUS_PRESENTATION[order.status] ?? { emoji: "📋", prefix: order.status };

  const normalized = order.side ? normalizeSide(order.side) : "";
  // Perp orders store "Buy"/"Sell" for every order regardless of position
  // intent. Reduce-only is the authoritative close signal. For opening orders,
  // direction recovers the remaining semantic distinction: a short-directed
  // sell opens a short rather than selling a long.
  const effective =
    order.reduceOnly && normalized === "Sell" ? "SellToClose" :
    order.reduceOnly && normalized === "Buy"  ? "BuyToCover" :
    order.direction === "short" && normalized === "Sell" ? "SellShort" :
    order.direction === "short" && normalized === "Buy"  ? "BuyToCover" :
    normalized;
  const sideWord = SIDE_WORD[effective] ?? (effective || "Order");
  const actionEmoji = ACTION_EMOJI[effective] ?? "📋";

  const typeWord = order.orderType
    ? ORDER_TYPE_SHORT[order.orderType] ?? order.orderType.toLowerCase()
    : null;
  const price = priceToShow(order);

  // Copy-mirror and in-app order placement both store the UNDERLYING in
  // `symbol` and the per-share premium (not the OCC contract price) in
  // limitPrice/executedPrice: the strike, expiration and 100x multiplier
  // never reach this row. Without this marker an option fill rendered
  // identically to an equity fill at the bare premium (e.g. "Buy 2 AAPL @
  // $3.52"), reading as ~65x below the underlying's real price with the
  // notional understated 100x and no indication a derivative was traded.
  // We don't have strike/expiration to show here (they're not part of
  // OrderNotification), so the minimal correct fix is to label what we do
  // know: this is a contract, not a share, and the price is per-contract.
  const isOption = order.assetType === "OPTION";

  // "📈 Buy $552.73 of LIN @ $552.73 (limit)" — the core trade summary.
  //
  // The DOLLAR AMOUNT leads, not the quantity. A reader of this channel is
  // sizing someone else's trade against their own account, and "5561.0 ENA"
  // requires knowing ENA's price to mean anything, while unit counts are not
  // comparable across an equity, an option contract and a perp coin. The
  // quantity remains the fallback for the one case with no dollar figure to
  // show: an order with no price yet.
  const amount = notionalUsd(order);
  const size =
    amount != null
      ? `${formatUsdAmount(amount)} of`
      : order.quantityDecimal ?? String(order.quantity);
  let core = `${actionEmoji} ${sideWord} ${size} ${order.symbol}${isOption ? " (option)" : ""}`;
  if (price != null) {
    core += ` @ $${formatPrice(price)}${isOption ? "/share" : ""}`;
  }
  if (typeWord) core += ` (${typeWord})`;

  // Pseudonymized trader name appended so readers know who traded.
  const traderSuffix = order.userId
    ? ` - from ${order.traderName || anonymizeTrader(order.userId).traderName}`
    : "";

  // For terminal-problem statuses prepend a short label so "Cancelled" /
  // "Rejected" reads at a glance instead of relying on the emoji alone.
  const statusPrefix =
    presentation.prefix && presentation.prefix !== presentation.emoji
      ? `${presentation.emoji} ${presentation.prefix} - `
      : presentation.emoji
        ? `${presentation.emoji} `
        : "";
  const line = statusPrefix + core;

  // A venue-ended position leads with WHY. Buried at the end of the line it
  // reads as a footnote on a routine fill, which is how the event that most
  // needs attention gets the least.
  const reasonPrefix = order.closeReason ? `${CLOSE_REASON_LABEL[order.closeReason]} ` : "";

  // Externally-placed fills are marked so a trade the app never submitted is
  // not read as one it did.
  const originSuffix = order.externalOrigin ? " [at venue]" : "";

  return reasonPrefix + line + originSuffix + traderSuffix;
}

/**
 * How old a venue fill may be and still be worth announcing.
 *
 * Reconciliation normally lands within seconds of the fill. When it does not,
 * the line this file emits is actively misleading rather than merely late: a
 * position that closed a month ago was announced at a month-old price, which
 * anyone reading the channel would size a live trade against. See the
 * 2026-08-31 BTC incident, where an order wedged since 2026-07-29 resolved on a
 * worker redeploy and posted "Close $10.95 of BTC @ $64391.00" while BTC traded
 * near $78,000.
 *
 * The window is deliberately wider than a healthy reconcile and far narrower
 * than the outages that produce ghosts. Override it with the env var when a
 * known-long outage is being drained and the late alerts are still wanted.
 */
export const DEFAULT_STALE_FILL_MAX_AGE_MS = 15 * 60_000;
export const STALE_FILL_MAX_AGE_MS_ENV = "DISCORD_STALE_FILL_MAX_AGE_MS";

/**
 * Ceiling on the env override, mirroring copy-mirror-consent.ts. A typo'd
 * value large enough to disable the guard should fall back to the default
 * rather than silently restoring the behaviour this exists to stop.
 */
const STALE_FILL_MAX_AGE_CEILING_MS = 24 * 60 * 60_000;

/**
 * True when the venue fill is old enough that announcing it would mislead.
 *
 * FAILS OPEN in every uncertain case. An absent or unparseable timestamp means
 * "unknown age", and an unknown age must still notify: Alpaca terminal
 * non-fills (CANCELLED / REJECTED / EXPIRED) legitimately carry no filled_at,
 * and silently swallowing a rejection is a worse failure than a late line.
 *
 * A future-dated fill is also let through. That is venue/worker clock skew, not
 * staleness, and treating it as stale would drop live alerts.
 */
export function isStaleFill(
  executedAt: Date | number | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = DEFAULT_STALE_FILL_MAX_AGE_MS,
): boolean {
  if (executedAt == null) return false;
  const filledAtMs =
    executedAt instanceof Date ? executedAt.getTime() : Number(executedAt);
  if (!Number.isFinite(filledAtMs)) return false;
  if (!Number.isFinite(now) || !(maxAgeMs > 0)) return false;

  const ageMs = now - filledAtMs;
  if (ageMs < 0) return false;
  return ageMs > maxAgeMs;
}

/**
 * The configured staleness window. Reads the env var per call so a redeploy is
 * not needed to widen it; invalid, non-positive and above-ceiling values fall
 * back to the default rather than failing the send.
 */
export function staleFillMaxAgeMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[STALE_FILL_MAX_AGE_MS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALE_FILL_MAX_AGE_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_STALE_FILL_MAX_AGE_MS;
  }
  if (parsed > STALE_FILL_MAX_AGE_CEILING_MS) return DEFAULT_STALE_FILL_MAX_AGE_MS;
  return parsed;
}

/** Warn once at startup if the webhook is not configured. */
let _webhookMissingWarned = false;

export interface DiscordMirrorSummary {
  sourceLabel: string;
  /** Authoritative source account, used to refresh a stale follow label. */
  sourceUserId?: string | null;
  mirroredCount: number;
}

/** Bind aggregate mirror identity lookups to the worker's database pool. */
export function createDiscordMirrorSummarySender(db: WorkerPoolDb) {
  const dependencies: DiscordNotificationDependencies = {
    loadTraderProfile: (userId) => loadTraderProfile(db, userId),
  };
  return (input: DiscordMirrorSummary): Promise<void> =>
    sendDiscordMirrorSummary(input, dependencies);
}

/** Send the one aggregate confirmation for a source trade's successful mirrors. */
export async function sendDiscordMirrorSummary(
  input: DiscordMirrorSummary,
  dependencies: DiscordNotificationDependencies = defaultDependencies,
): Promise<void> {
  if (input.mirroredCount <= 0) return;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  let sourceLabel = input.sourceLabel;
  if (input.sourceUserId) {
    try {
      const profile = await dependencies.loadTraderProfile(input.sourceUserId);
      sourceLabel = resolveTraderIdentity(input.sourceUserId, profile).traderName;
    } catch {
      // The staged label is a safe fallback if the identity read is unavailable.
    }
  }
  const noun = input.mirroredCount === 1 ? "person" : "people";
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "TradeBot",
      content: `🪞 ${input.mirroredCount} ${noun} mirrored this trade from ${sourceLabel}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Discord mirror summary failed with HTTP ${response.status}`);
  }
}

/**
 * One venue-close alert per person, per ticker, per minute. A close that fills
 * in pieces is one event, not several; see discord-alert-throttle.ts. Shared by
 * every poller because they all send through this function.
 */
const closeAlertThrottle = createCloseAlertThrottle();

export async function sendDiscordNotification(
  order: OrderNotification,
  dependencies: DiscordNotificationDependencies = defaultDependencies,
  /** Overridable for tests; production shares the module-level window. */
  throttle: AlertThrottle = closeAlertThrottle,
  /** Overridable for tests; production reads the wall clock. */
  now: () => number = () => Date.now(),
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    if (!_webhookMissingWarned) {
      _webhookMissingWarned = true;
      console.warn(
        "[Discord] DISCORD_WEBHOOK_URL is not set — order notifications are disabled. " +
        "Set this env var in the worker to enable Discord alerts.",
      );
    }
    return;
  }

  if (shouldSuppress(order)) return;

  // A fill old enough to mislead is dropped, INCLUDING a venue close.
  //
  // This deliberately sits outside shouldSuppress: that function opens with an
  // unconditional `if (order.closeReason) return false`, so a check placed
  // inside it would let precisely the stale stop-out / liquidation through.
  // Checked before the throttle and the identity lookup, so a dropped alert
  // costs no database round trip, matching the throttle's own placement.
  //
  // Logged at warn, not info: unlike a throttled duplicate, nothing else is
  // going to report this event, so the log line is the only remaining record
  // that an alert was withheld.
  const maxAgeMs = staleFillMaxAgeMs();
  if (isStaleFill(order.executedAt, now(), maxAgeMs)) {
    const filledAtMs =
      order.executedAt instanceof Date
        ? order.executedAt.getTime()
        : Number(order.executedAt);
    const ageMinutes = Math.round((now() - filledAtMs) / 60_000);
    console.warn(
      `[Discord] Suppressed a stale ${order.closeReason ?? order.status} alert for ${order.symbol} ` +
      `(order ${order.orderId}): filled ${ageMinutes} minutes ago, past the ` +
      `${Math.round(maxAgeMs / 60_000)}-minute window. Set ${STALE_FILL_MAX_AGE_MS_ENV} to widen it.`,
    );
    return;
  }

  // Staggered fills of one stop are one event. Checked before the identity
  // lookup so a duplicate costs no database round trip. Logged rather than
  // dropped silently: the alert is being withheld, and that should be visible
  // when someone asks why a second line never appeared.
  if (!throttle.allow(order)) {
    console.info(
      `[Discord] Suppressed a repeat ${order.closeReason ?? "venue-close"} alert for ${order.symbol} within the 1-minute window (order ${order.orderId})`,
    );
    return;
  }

  let resolvedOrder = order;
  let webhookAvatarUrl: string | undefined;
  if (order.userId) {
    try {
      const profile = await dependencies.loadTraderProfile(order.userId);
      const identity = resolveTraderIdentity(order.userId, profile);
      resolvedOrder = { ...order, traderName: identity.traderName };
      // Use the Twitter profile picture as the webhook avatar when available.
      // Only use a real image (not the DiceBear robot fallback) so the avatar
      // is either the user's actual Twitter photo or the default bot avatar.
      if (identity.twitterLinked && profile?.image?.trim()) {
        webhookAvatarUrl = profile.image.trim();
      }
    } catch (err) {
      console.error("[Discord] Failed to resolve trader identity for user", order.userId, ":", err);
      resolvedOrder = order;
    }
  }

  const content = formatOrderLine(resolvedOrder);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "TradeBot",
        ...(webhookAvatarUrl ? { avatar_url: webhookAvatarUrl } : {}),
        content,
      }),
    });

    if (!response.ok) {
      console.error(
        `[Discord] Webhook failed: ${response.status} ${response.statusText}`
      );
    }
  } catch (err) {
    console.error("[Discord] Failed to send notification:", err);
  }
}
