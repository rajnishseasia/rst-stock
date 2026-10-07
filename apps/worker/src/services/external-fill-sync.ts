/**
 * External Fill Poller
 *
 * ============================================================================
 *  ⚠️  REAL ACCOUNTS.  READ-ONLY, INSERT-ONLY.  NEVER PLACES ORDERS.  ⚠️
 * ============================================================================
 *
 * The existing OrderSyncPoller is row-driven: it iterates RST-owned orders and
 * asks Alpaca for each one. That means any fill that happened at the broker
 * without a matching RST row (e.g. the user placed a trade directly on Alpaca,
 * or an on-site stop-loss that was persisted and forgotten because the create
 * response was lost) is invisible to us. It never fires a Discord webhook and
 * never fans out to copy traders.
 *
 * This poller is the inverse: it LISTs Alpaca orders per-credential using
 * `submitted_at` as an ascending cursor, classifies each order as either known
 * (already in `orders`) or external, and — for external fills — inserts a
 * reconciled `orders` row tagged `externalOrigin=true` with a deterministic
 * `extfill:<digest>` client_order_id so the unique index
 * absorbs any restart/re-read overlap.
 *
 * Guarantees:
 *
 *   1. KILL SWITCH — start() does nothing at all unless the env flag
 *      EXTERNAL_FILL_DETECT_ENABLED is exactly the string "true". No interval,
 *      no DB reads, no Alpaca calls. This is the default in every environment.
 *
 *   2. READ + INSERT ONLY — the poller only lists orders at Alpaca and inserts
 *      into `orders` / `external_fill_cursors`. It NEVER modifies existing
 *      order rows and NEVER places, cancels, or replaces any broker order.
 *
 *   3. NOTIFY GATING — LIVE-only Discord webhook via the existing
 *      `sendDiscordNotification` path, matching OrderSyncPoller's behavior.
 *
 *   4. RESTART SAFE — inserts use ON CONFLICT DO NOTHING against the unique
 *      `orders_client_order_id_unique` index, and the notify / phase-2 emit
 *      only fires when the insert actually created a row. Watermark advances
 *      only after a page is durably persisted, so crashing mid-page re-reads
 *      rather than skips.
 *
 *   5. PER-ACCOUNT BACKOFF — a failing account (429, 5xx, unusable creds) is
 *      skipped for the cycle without blocking other accounts, and its
 *      watermark is NOT advanced so the next cycle retries the same window.
 *
 *   6. NO HISTORY REPLAY — a credential's first scan seeds its cursor at
 *      (now - EXTERNAL_FILL_BACKFILL_MS, default 0) BEFORE reading, so
 *      enabling the poller can never ingest years of old broker orders as
 *      "new" fills and spray stale Discord pings / copy-mirror orders.
 *
 *   7. FINAL FILLS ONLY — an order is ingested once its broker state is
 *      terminal (filled, or canceled/expired/etc. with a non-zero
 *      `filled_qty`). Still-open orders, including `partially_filled`, are
 *      skipped AND hold the watermark back so they stay inside the scan
 *      window until they settle. This poller emits exactly one social /
 *      mirror event per broker order and never has to revise it.
 *
 *   8. PUBLICATION POLICY — live Alpaca fills reach the social feed and
 *      copy-mirror pipeline automatically. Paper/SIM fills stay private,
 *      matching apps/api/src/lib/social-publish.ts.
 *
 * See docs/tasks/COPY-TRADE-EXTERNAL-FILLS-SCOPE.md for the full design.
 */

import { AlpacaClient, type GetOrdersOptions } from "@trade-bot/alpaca";
import type { AlpacaOrder } from "@trade-bot/alpaca";
import { schema, type WorkerPoolDb } from "@trade-bot/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { getDecryptedCredentials, type DecryptedCredentials } from "../../../api/src/lib/credentials";
import { isPaperAccount } from "../../../api/src/lib/alpaca";
import { isValidOptionContractIdentity, parseAlpacaOptionSymbol } from "../../../api/src/lib/options";
import { tradeActionSide } from "../../../api/src/lib/trade-action";
import { MAX_SAFE_TRADING_VALUE } from "@trade-bot/utils";
import { sendDiscordNotification } from "./discord-notify";
import { mapAlpacaStatus, resolveExecutedAt } from "./order-sync";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PAGE_LIMIT = 500;
/**
 * Re-read this much of the tail every cycle so a boundary event or small clock
 * skew cannot skip a fill. Duplicates are absorbed by the `extfill:` unique
 * client_order_id.
 */
const CURSOR_SAFETY_OVERLAP_MS = 60_000;
/** Cap total pages per credential per cycle so a huge history can't monopolize the loop. */
const MAX_PAGES_PER_CYCLE = 20;
/**
 * How far back the FIRST scan for a credential reaches. Zero by default: a
 * brand-new cursor starts at enablement time, so turning the poller on cannot
 * replay a lifetime of broker history into Discord and the copy-mirror
 * pipeline. EXTERNAL_FILL_BACKFILL_MS opts into a deliberate bounded backfill.
 */
const DEFAULT_FIRST_RUN_BACKFILL_MS = 0;
/** Hard ceiling on EXTERNAL_FILL_BACKFILL_MS (7 days) so a typo can't mean "all of it". */
const MAX_FIRST_RUN_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;

/** Safety cap on credentials per poll cycle; prevents an unbounded full-table scan. */
const MAX_CREDENTIALS_PER_CYCLE = 10_000;

/**
 * Hard ceiling on how far back the rescan cursor can be pinned by a long-resting
 * open order. Without this, a single broker-direct limit/stop order that never
 * fills can hold the scan window at its submitted_at indefinitely, delaying
 * detection of all newer fills on that account forever. When the pin exceeds
 * this window we log a warning and advance the floor.
 */
const MAX_RESCAN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Scope external-fill dedupe to the credential/account/venue being polled.
 * Broker order IDs are only unique inside an Alpaca account, and older local
 * rows may have a null venue or credential, so those legacy rows are admitted
 * only through the matching account fallback.
 */
function externalOrderScopeCondition(
  credential: Pick<typeof schema.userApiCredentials.$inferSelect, "userId" | "id" | "accountId">,
) {
  const venue = or(eq(schema.orders.venue, "alpaca"), isNull(schema.orders.venue));
  // An account id is the authoritative Alpaca clearing scope even when the
  // saved credential was rotated. When no account id exists, the credential
  // itself is the strongest available identity. Null legacy fields are only
  // admitted through the matching account branch, never as a global wildcard.
  const accountScope = credential.accountId
    ? eq(schema.orders.brokerAccountId, credential.accountId)
    : sql`false`;
  const credentialScope = and(
    eq(schema.orders.brokerCredentialId, credential.id),
    credential.accountId
      ? or(eq(schema.orders.brokerAccountId, credential.accountId), isNull(schema.orders.brokerAccountId))
      : undefined,
  );
  return and(
    eq(schema.orders.userId, credential.userId),
    venue,
    or(accountScope, credentialScope),
  );
}

/**
 * Alpaca statuses where the order is finished and its `filled_qty` will never
 * change again. Anything not in this set is still live at the broker.
 *
 * `done_for_day` is deliberately EXCLUDED: docs.alpaca.markets defines it as
 * "done executing for the day, and will not receive further updates until the
 * next trading day" -- the order resumes and its filled_qty can still grow
 * (or the remainder can later cancel/expire) once the next session opens.
 * Treating it as terminal here caused a GTC order's day-one partial fill to
 * be published as a final mirror (undersizing followers) or, for a zero-fill
 * day, to drop out of the scan window entirely before it ever resumed.
 * order-sync.ts's mapAlpacaStatus already treats it as non-terminal
 * (SUBMITTED); this matches that.
 */
const TERMINAL_ALPACA_STATUSES: ReadonlySet<string> = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "replaced",
  "rejected",
]);

/** True when Alpaca will not change this order's fill quantity any further. */
export function isTerminalAlpacaStatus(status: string | null | undefined): boolean {
  return TERMINAL_ALPACA_STATUSES.has((status ?? "").toLowerCase());
}

/**
 * Maps an Alpaca terminal status to the RST order status for an external-fill
 * row. Differs from `mapAlpacaStatus` in order-sync.ts for `replaced`: the
 * general mapper keeps it as SUBMITTED so OrderSyncPoller can continue
 * polling for the replacement state on RST-created orders. For external fills
 * the fill quantity is already final, so we map to the correct terminal RST
 * status; leaving it SUBMITTED would cause OrderSyncPoller to re-poll the row
 * forever and show "Submitted" in history/UI permanently.
 *
 * `done_for_day` has no special case here: it is no longer in
 * TERMINAL_ALPACA_STATUSES, so classifyAlpacaOrder never reaches "external"
 * for it and this function never sees that status for a row we're about to
 * insert. It falls through to mapAlpacaStatus, matching order-sync.ts.
 */
export function mapAlpacaStatusForExternalFill(
  status: string | null | undefined,
): typeof schema.orders.$inferInsert["status"] {
  const s = (status ?? "").toLowerCase();
  if (s === "replaced") return "CANCELLED";
  return mapAlpacaStatus(s, "PENDING");
}

type ExternalOrder = typeof schema.orders.$inferInsert;

export interface ExternalFillDependencies {
  getCredentials: typeof getDecryptedCredentials;
  createClient: (credentials: DecryptedCredentials) => AlpacaClient;
  notify: typeof sendDiscordNotification;
  now: () => Date;
}

const defaultDependencies: ExternalFillDependencies = {
  getCredentials: getDecryptedCredentials,
  createClient: (credentials) => new AlpacaClient({
    keyId: credentials.username!,
    secretKey: credentials.accessToken,
    paper: isPaperAccount(credentials.accountType),
  }),
  notify: sendDiscordNotification,
  now: () => new Date(),
};

/**
 * The subset of an Alpaca order this poller reads. Kept narrow so tests don't
 * have to fake every field on the SDK's Order type.
 */
type ExternalAlpacaOrderFields = Pick<
  AlpacaOrder,
  | "id"
  | "client_order_id"
  | "symbol"
  | "asset_class"
  | "side"
  | "type"
  | "order_type"
  | "status"
  | "qty"
  | "filled_qty"
  | "filled_avg_price"
  | "filled_at"
  | "submitted_at"
  | "limit_price"
  | "stop_price"
  | "order_class"
  | "position_intent"
>;

export type ExternalAlpacaOrder = ExternalAlpacaOrderFields & {
  /**
   * Populated when GetOrders is called with `nested: true` (see the poller's
   * page fetch below): the child legs of a bracket/OCO/OTO order, rolled up
   * under the parent instead of being returned as their own list entries.
   * Narrowed recursively to the same field subset as the parent -- a real
   * Alpaca leg is a full Order entity, but this poller only ever reads the
   * fields above off of it, same as any top-level order.
   */
  legs: ExternalAlpacaOrder[] | null;
};

/** Alpaca `type`/`order_type` -> RST order_type enum. */
export function mapAlpacaOrderType(alpacaType: string | null | undefined): typeof schema.orders.$inferInsert["orderType"] {
  switch (alpacaType) {
    case "market":
      return "Market";
    case "limit":
      return "Limit";
    case "stop":
      return "StopMarket";
    case "stop_limit":
      return "StopLimit";
    case "trailing_stop":
      // The RST enum doesn't have TrailingStop; fold into StopMarket (closest
      // sibling that reads sensibly on the Discord line and in the UI). The
      // externalOrigin flag preserves the fact that RST didn't place it.
      return "StopMarket";
    default:
      return "Market";
  }
}

/**
 * Why an externally-observed Alpaca fill closed a position.
 *
 * A bracket / OTO stop is a CHILD order at the broker and gets no `orders` row
 * of its own, so when it fires the row-driven OrderSyncPoller sees nothing at
 * all. This poller is what surfaces it; without a reason on the line, the
 * resulting webhook reads exactly like a manual sale, which is the confusion
 * being fixed rather than a new one.
 *
 * Only `position_intent` is trusted. A stop-market order is equally the shape
 * of a stop ENTRY (buy_to_open on a breakout), and announcing a position being
 * opened as a stop-out is worse than saying nothing about the reason. Legacy
 * responses that omit the field therefore return null and the alert still
 * fires, just without the prefix.
 */
export function externalCloseReason(
  alpaca: Pick<ExternalAlpacaOrder, "type" | "order_type" | "position_intent">,
): "stop_loss" | null {
  const type = (alpaca.type ?? alpaca.order_type ?? "").toLowerCase();
  if (type !== "stop" && type !== "stop_limit" && type !== "trailing_stop") return null;
  const intent = alpaca.position_intent?.toLowerCase();
  return intent === "sell_to_close" || intent === "buy_to_close" ? "stop_loss" : null;
}

/**
 * Index close reasons by the broker order id, including nested bracket legs.
 * The legs are where the stop actually lives, so a page walked without
 * flattening them finds nothing to label.
 */
export function closeReasonsByBrokerId(
  page: ReadonlyArray<ExternalAlpacaOrder>,
): Map<string, "stop_loss"> {
  const reasons = new Map<string, "stop_loss">();
  for (const alpaca of flattenAlpacaLegs(page)) {
    const reason = externalCloseReason(alpaca);
    if (reason && alpaca.id) reasons.set(alpaca.id, reason);
  }
  return reasons;
}

/** Alpaca `side` -> RST trade_action enum for equities. */
export function mapAlpacaSide(side: string | null | undefined): typeof schema.orders.$inferInsert["tradeAction"] {
  return side === "sell" ? "Sell" : "Buy";
}

export interface ExternalOrderIntent {
  tradeAction: typeof schema.orders.$inferInsert["tradeAction"];
  direction: typeof schema.orders.$inferInsert["direction"];
}

/**
 * Resolve the position effect of a broker-observed fill. Side alone is not
 * enough: a sell can close a long or open a short, and a buy can open a long or
 * cover a short. Position intent is authoritative. For legacy equity responses,
 * bracket/OTO entries and OCO exits carry enough order-class context; ambiguous
 * simple orders are refused instead of being labeled long.
 */
export function resolveExternalOrderIntent(
  alpaca: Pick<ExternalAlpacaOrder, "asset_class" | "side" | "order_class" | "position_intent">,
): ExternalOrderIntent | null {
  const assetType = mapAlpacaAssetType(alpaca.asset_class);
  const intent = alpaca.position_intent?.toLowerCase();
  const expectedSide = intent?.startsWith("buy_") ? "buy" :
    intent?.startsWith("sell_") ? "sell" : null;
  if (expectedSide && alpaca.side !== expectedSide) return null;

  if (intent === "buy_to_open") {
    return { tradeAction: assetType === "OPTION" ? "BuyToOpen" : "Buy", direction: "long" };
  }
  if (intent === "sell_to_close") {
    return { tradeAction: assetType === "OPTION" ? "SellToClose" : "Sell", direction: "long" };
  }
  if (intent === "sell_to_open") {
    return {
      tradeAction: assetType === "OPTION" ? "SellToOpen" : "SellShort",
      direction: "short",
    };
  }
  if (intent === "buy_to_close") {
    return {
      tradeAction: assetType === "OPTION" ? "BuyToClose" : "BuyToCover",
      direction: "short",
    };
  }

  if (assetType === "OPTION") return null;
  const orderClass = (alpaca.order_class ?? "").toLowerCase();
  if (orderClass === "bracket" || orderClass === "oto") {
    return alpaca.side === "buy"
      ? { tradeAction: "Buy", direction: "long" }
      : alpaca.side === "sell"
      ? { tradeAction: "SellShort", direction: "short" }
      : null;
  }
  if (orderClass === "oco") {
    return alpaca.side === "sell"
      ? { tradeAction: "Sell", direction: "long" }
      : alpaca.side === "buy"
      ? { tradeAction: "BuyToCover", direction: "short" }
      : null;
  }
  return null;
}

/** Alpaca `asset_class` -> RST asset_type enum. */
export function mapAlpacaAssetType(assetClass: string | null | undefined): typeof schema.orders.$inferInsert["assetType"] {
  // Alpaca uses "us_equity" for stocks, "us_option" for options, "crypto" for
  // spot crypto (filtered out in classifyAlpacaOrder before this function is reached).
  // Default to EQUITY for anything unrecognized so a stray asset class doesn't corrupt the row.
  if (assetClass === "us_option") return "OPTION";
  return "EQUITY";
}

export interface ClassificationInput {
  alpaca: ExternalAlpacaOrder;
  /** RST rows already tied to this credential; matched by broker/client id. */
  knownBrokerOrderIds: Set<string>;
  knownClientOrderIds: Set<string>;
}

export type Classification =
  | { kind: "known" }
  | { kind: "external"; reason: "filled" | "partial" }
  /** `open` means the order is still live at the broker, so its fill isn't final yet. */
  | { kind: "skip"; reason: string; open: boolean };

const STRICT_POSITIVE_NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parse one complete decimal numeric string, rejecting coercion-only values. */
function parseStrictPositiveNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || !STRICT_POSITIVE_NUMBER_RE.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Decide whether an Alpaca order is already known to RST, an external fill
 * worth ingesting, or a state we don't care about (yet). Pure so it's
 * straightforward to test.
 *
 * We ingest only orders whose fill quantity is FINAL. This poller is
 * insert-only and emits a single social/mirror event per order, so ingesting a
 * `partially_filled` order would freeze that snapshot forever: later polls
 * classify the same broker order as known, and neither the completion nor a
 * subsequent cancellation would ever update the row or the followers' view.
 * Instead we skip it and flag it open, which holds the cursor back so the same
 * order is re-read next cycle until it settles.
 */
export function classifyAlpacaOrder(input: ClassificationInput): Classification {
  const { alpaca, knownBrokerOrderIds, knownClientOrderIds } = input;
  // Spot-crypto orders are not supported: mapAlpacaAssetType falls through to
  // EQUITY for "crypto", which would mislabel the row. Skip them silently.
  if (alpaca.asset_class === "crypto") {
    return { kind: "skip", reason: "crypto not ingested", open: false };
  }
  if (knownBrokerOrderIds.has(alpaca.id)) return { kind: "known" };
  if (alpaca.client_order_id && knownClientOrderIds.has(alpaca.client_order_id)) {
    return { kind: "known" };
  }
  if (!isTerminalAlpacaStatus(alpaca.status)) {
    // new / accepted / partially_filled / pending_* / held ... still live.
    return { kind: "skip", reason: `open:status=${alpaca.status}`, open: true };
  }
  if (!resolveExternalOrderIntent(alpaca)) {
    return { kind: "skip", reason: "ambiguous position intent", open: false };
  }
  const assetType = mapAlpacaAssetType(alpaca.asset_class);
  if (assetType === "OPTION" && !parseAlpacaOptionSymbol(alpaca.symbol)) {
    return { kind: "skip", reason: "malformed option contract", open: false };
  }
  const executionPrice = parseStrictPositiveNumber(alpaca.filled_avg_price);
  if (executionPrice === null || executionPrice > MAX_SAFE_TRADING_VALUE) {
    return { kind: "skip", reason: "invalid execution price", open: false };
  }
  const filledQty = parseStrictPositiveNumber(alpaca.filled_qty);
  // A terminal FILLED row with a zero/invalid fill is not a fill. Do not let
  // the requested quantity become a fabricated social event or mirror.
  if (filledQty !== null && filledQty <= MAX_SAFE_TRADING_VALUE) {
    return {
      kind: "external",
      reason: (alpaca.status ?? "").toLowerCase() === "filled" ? "filled" : "partial",
    };
  }
  // Terminal but not "filled": canceled/expired/replaced without a fill is
  // safely ignored and does not hold the cursor.
  return { kind: "skip", reason: `status=${alpaca.status}`, open: false };
}

/**
 * Flatten a page of Alpaca orders and their nested legs into one flat list of
 * order-shaped entities.
 *
 * docs.alpaca.markets: GET /v2/orders' `nested` parameter "will roll up
 * multi-leg orders under the legs field of primary order", and `legs` is
 * "an array of Order entities associated with this order" -- each leg (the
 * take-profit, the stop-loss, the other side of an OCO) IS a full order, but
 * with `nested: true` it is not also returned as a top-level list entry. A
 * caller that iterates only the top-level list therefore never classifies or
 * ingests a leg's fill. Recurses (Alpaca does not currently nest more than
 * one level, but this is cheap and keeps the invariant correct if that ever
 * changes) so every leg gets the identical classify/ingest treatment as a
 * top-level order.
 */
export function flattenAlpacaLegs(
  page: ReadonlyArray<ExternalAlpacaOrder>,
): ExternalAlpacaOrder[] {
  const flat: ExternalAlpacaOrder[] = [];
  const visit = (order: ExternalAlpacaOrder) => {
    flat.push(order);
    for (const leg of order.legs ?? []) {
      visit(leg);
    }
  };
  for (const order of page) visit(order);
  return flat;
}

/**
 * True when a top-level order's nested legs include one that has not yet
 * reached a terminal broker state (e.g. the entry of a bracket filled and the
 * take-profit leg is still working).
 *
 * GetOrders pagination filters on the TOP-LEVEL order's `submitted_at` only;
 * a leg has no `submitted_at` cursor position of its own. Once the watermark
 * advances past the parent, the parent (and everything nested under it,
 * including a still-open leg) drops out of every future page and its
 * eventual fill can never be seen. Callers must pin the cursor to the
 * parent's own `submitted_at` whenever this is true, independent of the
 * parent's own classification (the parent itself may already be filled and
 * known while a leg is still live).
 */
export function hasOpenLeg(order: ExternalAlpacaOrder): boolean {
  const legs = order.legs ?? [];
  return legs.some((leg) => !isTerminalAlpacaStatus(leg.status));
}

/** Deterministic, collision-resistant client_order_id for an external fill. */
export function externalFillClientOrderId(credentialId: string, alpacaOrderId: string): string {
  // Alpaca caps client_order_id at 48 characters. Hash the complete pair so
  // shared prefixes in either identity cannot alias two external fills.
  const digest = createHash("sha256")
    .update(credentialId)
    .update("\0")
    .update(alpacaOrderId)
    .digest("hex")
    .slice(0, 40);
  return `extfill:${digest}`;
}

/**
 * Build the ORDER row we insert for an external fill. Extracted so tests can
 * assert the mapping without spinning up a DB.
 */
export function buildExternalOrderRow(params: {
  alpaca: ExternalAlpacaOrder;
  userId: string;
  credentialId: string;
  credentialAccountId: string | null;
  now: Date;
}): ExternalOrder | null {
  const { alpaca, userId, credentialId, credentialAccountId, now } = params;
  const alpacaType = alpaca.type ?? alpaca.order_type ?? "market";
  const filledQty = parseStrictPositiveNumber(alpaca.filled_qty);
  // Only an executed quantity is authoritative. A zero-filled FILLED response
  // must be ineligible; falling back to requested `qty` creates a false fill.
  if (
    filledQty === null ||
    filledQty > MAX_SAFE_TRADING_VALUE
  ) return null;
  const quantity = Math.max(1, Math.round(filledQty));
  const executedPrice = parseStrictPositiveNumber(alpaca.filled_avg_price);
  if (executedPrice === null || executedPrice > MAX_SAFE_TRADING_VALUE) return null;
  const status = mapAlpacaStatusForExternalFill(alpaca.status);
  const intent = resolveExternalOrderIntent(alpaca);
  if (!intent) return null;
  const optionContract = mapAlpacaAssetType(alpaca.asset_class) === "OPTION"
    ? parseAlpacaOptionSymbol(alpaca.symbol)
    : null;
  if (
    mapAlpacaAssetType(alpaca.asset_class) === "OPTION" &&
    (!optionContract || !isValidOptionContractIdentity(optionContract))
  ) return null;
  return {
    userId,
    symbol: optionContract?.symbol ?? alpaca.symbol,
    assetType: mapAlpacaAssetType(alpaca.asset_class),
    orderType: mapAlpacaOrderType(alpacaType),
    tradeAction: intent.tradeAction,
    direction: intent.direction,
    quantity,
    status,
    statusUpdatedAt: now,
    clientOrderId: externalFillClientOrderId(credentialId, alpaca.id),
    brokerClientOrderId: alpaca.client_order_id ?? null,
    brokerOrderId: alpaca.id,
    brokerAccountId: credentialAccountId,
    brokerCredentialId: credentialId,
    executedPrice: executedPrice !== null ? executedPrice.toString() : null,
    executedQuantity: filledQty,
    executedAt: resolveExecutedAt(alpaca.filled_at),
    limitPrice: alpaca.limit_price ?? null,
    stopPrice: alpaca.stop_price ?? null,
    optionExpiration: optionContract?.optionExpiration,
    optionStrike: optionContract?.optionStrike !== undefined
      ? String(optionContract.optionStrike)
      : undefined,
    optionType: optionContract?.optionType,
    venue: "alpaca",
    externalOrigin: true,
    notes: "Detected by ExternalFillPoller (broker-observed fill with no in-app order)",
  } as ExternalOrder;
}

/**
 * Advance a cursor watermark to the max submitted_at of the batch. Falls back
 * to the current watermark if the page has no parseable timestamps. Pure so
 * it's easy to unit-test the "don't rewind" invariant.
 */
export function advanceWatermark(
  current: Date | null,
  page: ReadonlyArray<Pick<ExternalAlpacaOrder, "submitted_at">>,
): Date | null {
  let max = current ? current.getTime() : Number.NEGATIVE_INFINITY;
  for (const order of page) {
    if (!order.submitted_at) continue;
    const t = Date.parse(order.submitted_at);
    if (Number.isNaN(t)) continue;
    if (t > max) max = t;
  }
  if (max === Number.NEGATIVE_INFINITY) return current;
  return new Date(max);
}

/**
 * Hold the persisted watermark at or before the oldest still-open order we saw.
 *
 * Without this, a long-lived broker-direct limit/stop order is skipped (it has
 * no final fill yet) while its `submitted_at` still pushes the cursor forward.
 * Newer submissions then carry the cursor more than CURSOR_SAFETY_OVERLAP_MS
 * past it, the `after` filter stops returning it, and its eventual fill is
 * never seen: OrderSyncPoller can't recover it either, because no local row was
 * ever created. Pinning the cursor to the oldest open order keeps it inside the
 * scan window until it settles. The rewind is bounded by the window we just
 * read, and re-reads are idempotent via the `extfill:` unique client_order_id.
 */
export function clampWatermarkToOpenOrders(
  watermark: Date | null,
  oldestOpenSubmittedAt: Date | null,
): Date | null {
  if (!oldestOpenSubmittedAt) return watermark;
  if (!watermark) return oldestOpenSubmittedAt;
  return oldestOpenSubmittedAt < watermark ? oldestOpenSubmittedAt : watermark;
}

export class ExternalFillPoller {
  private readonly db: WorkerPoolDb;
  private readonly deps: ExternalFillDependencies;
  private isRunning = false;
  // `ReturnType<typeof setInterval>` rather than `NodeJS.Timeout`: this workspace
  // resolves Bun's `setInterval`, which returns its own Timer type, so the
  // Node-specific annotation failed `check-types` for the whole worker even
  // though the runtime value was always correct. Deriving the type from the
  // function that produces it is right under either runtime.
  private intervalId?: ReturnType<typeof setInterval>;
  private inFlightPoll = false;
  private readonly pollIntervalMs: number;
  private readonly pageLimit: number;
  private readonly firstRunBackfillMs: number;
  /** credentialId -> Set of Alpaca broker order IDs that are stuck (open older than MAX_RESCAN_WINDOW_MS). */
  private readonly stuckOrders = new Map<string, Set<string>>();

  constructor(db: WorkerPoolDb, dependencies: Partial<ExternalFillDependencies> = {}) {
    this.db = db;
    this.deps = { ...defaultDependencies, ...dependencies };
    const envInterval = Number.parseInt(process.env.EXTERNAL_FILL_POLL_MS ?? "", 10);
    this.pollIntervalMs = Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_POLL_INTERVAL_MS;
    const envPage = Number.parseInt(process.env.EXTERNAL_FILL_PAGE_LIMIT ?? "", 10);
    this.pageLimit = Number.isFinite(envPage) && envPage > 0 && envPage <= 500
      ? envPage
      : DEFAULT_PAGE_LIMIT;
    const envBackfill = Number.parseInt(process.env.EXTERNAL_FILL_BACKFILL_MS ?? "", 10);
    this.firstRunBackfillMs = Number.isFinite(envBackfill) && envBackfill >= 0
      ? Math.min(envBackfill, MAX_FIRST_RUN_BACKFILL_MS)
      : DEFAULT_FIRST_RUN_BACKFILL_MS;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    // ⚠️ Kill switch — see file header. Ships INERT.
    if (process.env.EXTERNAL_FILL_DETECT_ENABLED !== "true") {
      console.log(
        "[ExternalFillPoller] Disabled (EXTERNAL_FILL_DETECT_ENABLED != 'true'). No interval scheduled.",
      );
      return;
    }
    this.isRunning = true;
    console.log(
      `[ExternalFillPoller] Starting external-fill polling every ${this.pollIntervalMs}ms.`,
    );
    void this.pollOnce();
    this.intervalId = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    console.log("[ExternalFillPoller] Stopped external-fill polling.");
  }

  /**
   * Single scan pass across all Alpaca credentials. Exposed for tests and for
   * ad-hoc invocation via the worker's HTTP surface.
   */
  public async pollOnce(): Promise<void> {
    if (this.inFlightPoll) {
      console.log(
        "[ExternalFillPoller] Previous poll cycle still in flight; skipping this interval.",
      );
      return;
    }
    this.inFlightPoll = true;
    try {
      const credentials = await this.db.query.userApiCredentials.findMany({
        where: eq(schema.userApiCredentials.provider, "alpaca"),
        limit: MAX_CREDENTIALS_PER_CYCLE,
      });
      if (credentials.length === 0) return;

      for (const credential of credentials) {
        try {
          await this.processCredential(credential);
        } catch (err) {
          console.error(
            `[ExternalFillPoller] Failed processing credential ${credential.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.error("[ExternalFillPoller] Poll cycle error:", err);
    } finally {
      this.inFlightPoll = false;
    }
  }

  private async processCredential(
    credential: typeof schema.userApiCredentials.$inferSelect,
  ): Promise<void> {
    const decrypted = await this.deps.getCredentials(this.db as never, credential.userId, {
      provider: "alpaca",
      credentialId: credential.id,
    });
    if (!decrypted.username || !decrypted.accessToken) {
      console.warn(
        `[ExternalFillPoller] Skipping credential ${credential.id}: missing key/secret after decrypt.`,
      );
      return;
    }
    const client = this.deps.createClient(decrypted);

    const cursorRow = await this.db.query.externalFillCursors.findFirst({
      where: eq(schema.externalFillCursors.credentialId, credential.id),
    });
    let startingWatermark = cursorRow?.watermark ?? null;
    if (!startingWatermark) {
      // FIRST RUN for this credential. Seed the cursor BEFORE reading anything.
      // With no `after` bound, Alpaca starts at the oldest order on the account,
      // so every historical unknown fill would be ingested as new: followers
      // would mirror months- or years-old trades into live markets and LIVE
      // accounts would get a burst of stale Discord pings. Persisting the seed
      // first also means a crash mid-cycle resumes here instead of falling back
      // to a full-history scan.
      startingWatermark = new Date(this.deps.now().getTime() - this.firstRunBackfillMs);
      await this.db
        .insert(schema.externalFillCursors)
        .values({ credentialId: credential.id, watermark: startingWatermark })
        .onConflictDoNothing();
      console.log(
        `[ExternalFillPoller] Seeded first-run cursor for credential ${credential.id} at ${startingWatermark.toISOString()} (backfill ${this.firstRunBackfillMs}ms).`,
      );
    }

    // Publication is mandatory for live trades and forbidden for Alpaca
    // paper/SIM trades. Keep the decision credential-scoped because one user
    // may connect both account types.
    const publishSocialTrades = !isPaperAccount(decrypted.accountType);

    // Poll any orders that were previously stuck (open older than MAX_RESCAN_WINDOW_MS)
    // individually so they are not lost when the watermark floor advances past them.
    await this.pollStuckOrders(credential, decrypted, client, publishSocialTrades);

    let pageWatermark: Date = startingWatermark;
    let pageAfter: Date = new Date(startingWatermark.getTime() - CURSOR_SAFETY_OVERLAP_MS);
    /** Oldest still-open unknown order seen this cycle; pins the cursor back. */
    let oldestOpenSubmittedAt: Date | null = null;
    /** Aggregated across all pages: broker IDs of open unknown orders seen this cycle. */
    const cycleUnknownOpenIds: string[] = [];
    /** Aggregated submitted_at for each unknown open order ID seen this cycle. */
    const cycleUnknownOpenSubmittedAt = new Map<string, Date>();
    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_CYCLE; pageIndex++) {
      const options: GetOrdersOptions = {
        status: "all",
        limit: this.pageLimit,
        direction: "asc",
        nested: true,
        after: pageAfter,
      };

      let page: ExternalAlpacaOrder[];
      try {
        page = (await client.getOrders(options)) as ExternalAlpacaOrder[];
      } catch (err) {
        console.error(
          `[ExternalFillPoller] getOrders failed for credential ${credential.id}; watermark held:`,
          err instanceof Error ? err.message : err,
        );
        return; // don't advance watermark; retry next cycle
      }
      if (!page || page.length === 0) break;

      const { inserted, oldestOpen, unknownOpenIds, unknownOpenSubmittedAt } = await this.ingestPage({
        page,
        credential,
        decrypted,
        publishSocialTrades,
      });
      if (inserted.length > 0) {
        // A bracket stop is a CHILD order with no row of its own, so this
        // poller is the only thing that ever sees it fire. Carry WHY across
        // from the raw broker rows, keyed by the id both sides agree on.
        await this.notifyInserted(inserted, decrypted, closeReasonsByBrokerId(page));
        // Social-trade emit is now inside ingestPage, atomic with the order insert.
      }
      if (oldestOpen && (!oldestOpenSubmittedAt || oldestOpen < oldestOpenSubmittedAt)) {
        oldestOpenSubmittedAt = oldestOpen;
      }
      for (const id of unknownOpenIds) {
        cycleUnknownOpenIds.push(id);
      }
      for (const [id, date] of unknownOpenSubmittedAt) {
        cycleUnknownOpenSubmittedAt.set(id, date);
      }

      const nextWatermark = advanceWatermark(pageWatermark, page);
      if (nextWatermark) pageWatermark = nextWatermark;

      if (page.length < this.pageLimit) break;
      // Advance the paging cursor to the max submitted_at we just saw; a
      // subsequent identical timestamp is de-duped by the extfill: unique key.
      // Note this is the PAGING cursor only, the persisted watermark below is
      // clamped separately so open orders stay in the window.
      pageAfter = pageWatermark;
    }

    const clampedWatermark =
      clampWatermarkToOpenOrders(pageWatermark, oldestOpenSubmittedAt) ?? pageWatermark;
    // Cap the rescan window: a single long-resting open order cannot hold the
    // cursor further back than MAX_RESCAN_WINDOW_MS. Beyond that, log a warning
    // and move those orders to the stuck set for individual polling, then advance
    // the floor so newer fills are not delayed indefinitely.
    const minAllowedWatermark = new Date(this.deps.now().getTime() - MAX_RESCAN_WINDOW_MS);
    let finalWatermark = clampedWatermark;
    if (clampedWatermark < minAllowedWatermark) {
      // Find which unknown open orders have submitted_at older than the floor.
      const newlyStuck = cycleUnknownOpenIds.filter((id) => {
        const submitted = cycleUnknownOpenSubmittedAt.get(id);
        return submitted !== undefined && submitted < minAllowedWatermark;
      });
      if (newlyStuck.length > 0) {
        if (!this.stuckOrders.has(credential.id)) {
          this.stuckOrders.set(credential.id, new Set());
        }
        const stuckSet = this.stuckOrders.get(credential.id)!;
        for (const id of newlyStuck) stuckSet.add(id);
      }
      console.warn(
        `[ExternalFillPoller] Credential ${credential.id}: rescan window pinned by open order ` +
        `at ${oldestOpenSubmittedAt?.toISOString() ?? "unknown"} exceeds the ` +
        `${MAX_RESCAN_WINDOW_MS / (24 * 60 * 60 * 1000)}-day cap. ` +
        `Moving ${newlyStuck.length} stuck order(s) to individual polling: [${newlyStuck.join(", ")}]. ` +
        `Advancing floor to ${minAllowedWatermark.toISOString()}.`,
      );
      finalWatermark = minAllowedWatermark;
    }
    if (finalWatermark.getTime() !== startingWatermark.getTime()) {
      await this.db
        .insert(schema.externalFillCursors)
        .values({ credentialId: credential.id, watermark: finalWatermark })
        .onConflictDoUpdate({
          target: schema.externalFillCursors.credentialId,
          set: { watermark: finalWatermark, updatedAt: this.deps.now() },
        });
    }
  }

  /**
   * Classify a page and insert external-fill rows. Returns the rows that were
   * actually newly inserted (skipping conflicts) so callers only notify/mirror
   * once per fill across restarts, plus the oldest still-open unknown order in
   * the page so the caller can hold the cursor back to it.
   */
  private async ingestPage(params: {
    page: ExternalAlpacaOrder[];
    credential: typeof schema.userApiCredentials.$inferSelect;
    decrypted: DecryptedCredentials;
    publishSocialTrades: boolean;
  }): Promise<{
    inserted: Array<typeof schema.orders.$inferSelect>;
    oldestOpen: Date | null;
    unknownOpenIds: string[];
    unknownOpenSubmittedAt: Map<string, Date>;
  }> {
    const { page, credential, publishSocialTrades } = params;
    if (page.length === 0) return { inserted: [], oldestOpen: null, unknownOpenIds: [], unknownOpenSubmittedAt: new Map() };

    // Flatten in the nested legs (bracket/OCO/OTO take-profit, stop-loss, the
    // other side of an OCO) so every leg is classified and ingested exactly
    // like a top-level order. See flattenAlpacaLegs' doc comment.
    const flatOrders = flattenAlpacaLegs(page);

    // Batch-load any RST rows that already know these Alpaca order/client ids
    // so classification is one lookup per page (not per order).
    const alpacaIds = flatOrders.map((p) => p.id).filter(Boolean);
    const clientIds = flatOrders.map((p) => p.client_order_id).filter((c): c is string => Boolean(c));
    const known = alpacaIds.length === 0 && clientIds.length === 0 ? [] : await this.db
      .select({
        brokerOrderId: schema.orders.brokerOrderId,
        clientOrderId: schema.orders.clientOrderId,
        brokerClientOrderId: schema.orders.brokerClientOrderId,
      })
      .from(schema.orders)
      .where(
          and(
            externalOrderScopeCondition(credential),
            or(
            alpacaIds.length > 0 ? inArray(schema.orders.brokerOrderId, alpacaIds) : sql`false`,
            clientIds.length > 0 ? inArray(schema.orders.clientOrderId, clientIds) : sql`false`,
            clientIds.length > 0
              ? inArray(schema.orders.brokerClientOrderId, clientIds)
              : sql`false`,
          ),
        ),
      );

    const knownBrokerOrderIds = new Set<string>();
    const knownClientOrderIds = new Set<string>();
    for (const row of known) {
      if (row.brokerOrderId) knownBrokerOrderIds.add(row.brokerOrderId);
      if (row.clientOrderId) knownClientOrderIds.add(row.clientOrderId);
      if (row.brokerClientOrderId) knownClientOrderIds.add(row.brokerClientOrderId);
    }

    const insertedRows: Array<typeof schema.orders.$inferSelect> = [];
    let oldestOpen: Date | null = null;
    const unknownOpenIds: string[] = [];
    const unknownOpenSubmittedAt = new Map<string, Date>();
    /** Pins a parent's own submitted_at into the same tracking used for unknown-open orders above. */
    const pinCursorTo = (id: string, submittedAtRaw: string | null | undefined) => {
      const submittedMs = submittedAtRaw ? Date.parse(submittedAtRaw) : Number.NaN;
      if (Number.isNaN(submittedMs)) return;
      const submitted = new Date(submittedMs);
      if (!oldestOpen || submitted < oldestOpen) oldestOpen = submitted;
      unknownOpenIds.push(id);
      unknownOpenSubmittedAt.set(id, submitted);
    };
    for (const alpaca of flatOrders) {
      const classification = classifyAlpacaOrder({
        alpaca,
        knownBrokerOrderIds,
        knownClientOrderIds,
      });
      if (classification.kind === "skip" && classification.open) {
        // Unknown and still live at the broker: remember it so the cursor stays
        // at or before its submitted_at until it reaches a terminal state.
        pinCursorTo(alpaca.id, alpaca.submitted_at);
        continue;
      }
      if (classification.kind !== "external") continue;

      const row = buildExternalOrderRow({
        alpaca,
        userId: credential.userId,
        credentialId: credential.id,
        credentialAccountId: credential.accountId,
        now: this.deps.now(),
      });
      if (!row) continue;
      // Wrap the order insert and social-trade insert in a single transaction so
      // a worker restart between the two cannot silently drop the copy-mirror
      // fan-out. If the transaction fails, neither row is committed; next cycle
      // sees the Alpaca order as still-unknown and retries both.
      const inserted = await this.db.transaction(async (tx) => {
        const [newRow] = await tx
          .insert(schema.orders)
          .values(row)
          .onConflictDoNothing({ target: schema.orders.clientOrderId })
          .returning();
        if (!newRow) return null;
        if (publishSocialTrades) {
          const qty = Math.max(
            1,
            Math.round(newRow.executedQuantity ?? newRow.quantity ?? 0),
          );
          const side = tradeActionSide(newRow.tradeAction);
          if (side) {
            await tx.insert(schema.socialTrades).values({
              userId: newRow.userId,
              symbol: newRow.symbol,
              side,
              qty,
              orderType: newRow.orderType?.toLowerCase() ?? "market",
              assetType: newRow.assetType ?? "EQUITY",
              limitPrice: newRow.limitPrice,
              brokerOrderId: newRow.brokerOrderId,
              orderId: newRow.id,
            });
          }
        }
        return newRow;
      });
      if (inserted) {
        insertedRows.push(inserted);
        console.log(
          `[ExternalFillPoller] Ingested external fill ${alpaca.id} (${alpaca.symbol}) for user ${credential.userId}`,
        );
      }
    }

    // A top-level order can itself be terminal and already known (its entry
    // fill was ingested last cycle) while a nested leg is still working. The
    // loop above already pinned the cursor for unknown-and-open orders by
    // their OWN submitted_at; this covers the remaining case, pinning to the
    // PARENT's submitted_at (legs have none of their own) so the still-open
    // leg stays inside the scan window until it settles. See hasOpenLeg's
    // doc comment for why this must key off the parent, not the leg.
    for (const alpaca of page) {
      if (hasOpenLeg(alpaca)) {
        pinCursorTo(alpaca.id, alpaca.submitted_at);
      }
    }

    return { inserted: insertedRows, oldestOpen, unknownOpenIds, unknownOpenSubmittedAt };
  }

  /**
   * Poll stuck orders individually: these are open unknown orders whose submitted_at
   * fell outside the MAX_RESCAN_WINDOW_MS floor and can no longer be reached by the
   * page scan's `after` cursor. We fetch each one by ID, re-classify it, and either
   * ingest it (if it has since settled to an external fill), drop it (if it is now
   * known or terminal with no fill), or leave it in the stuck set for the next cycle.
   */
  private async pollStuckOrders(
    credential: typeof schema.userApiCredentials.$inferSelect,
    decrypted: DecryptedCredentials,
    client: AlpacaClient,
    publishSocialTrades: boolean,
  ): Promise<void> {
    const stuckSet = this.stuckOrders.get(credential.id);
    if (!stuckSet || stuckSet.size === 0) return;

    const stuckIds = Array.from(stuckSet);

    // Batch-load RST knowledge for all stuck IDs in one query.
    const known = stuckIds.length === 0 ? [] : await this.db
      .select({
        brokerOrderId: schema.orders.brokerOrderId,
        clientOrderId: schema.orders.clientOrderId,
        brokerClientOrderId: schema.orders.brokerClientOrderId,
      })
      .from(schema.orders)
      .where(
        and(
          externalOrderScopeCondition(credential),
          inArray(schema.orders.brokerOrderId, stuckIds),
        ),
      );

    const knownBrokerOrderIds = new Set<string>();
    const knownClientOrderIds = new Set<string>();
    for (const row of known) {
      if (row.brokerOrderId) knownBrokerOrderIds.add(row.brokerOrderId);
      if (row.clientOrderId) knownClientOrderIds.add(row.clientOrderId);
      if (row.brokerClientOrderId) knownClientOrderIds.add(row.brokerClientOrderId);
    }

    for (const stuckId of stuckIds) {
      let alpaca: ExternalAlpacaOrder;
      try {
        alpaca = (await client.getOrder(stuckId)) as ExternalAlpacaOrder;
      } catch (err) {
        console.error(
          `[ExternalFillPoller] pollStuckOrders: getOrder(${stuckId}) failed for credential ${credential.id}:`,
          err instanceof Error ? err.message : err,
        );
        continue; // leave in stuck set; retry next cycle
      }

      const classification = classifyAlpacaOrder({ alpaca, knownBrokerOrderIds, knownClientOrderIds });

      if (classification.kind === "known") {
        // Already ingested via another path (e.g. RST placed it after all). Remove.
        stuckSet.delete(stuckId);
        continue;
      }

      if (classification.kind === "skip" && !classification.open) {
        // Terminal with no fill (canceled with zero qty, rejected, etc.). Remove.
        stuckSet.delete(stuckId);
        continue;
      }

      if (classification.kind === "skip" && classification.open) {
        // Still open: keep in stuck set for next cycle.
        continue;
      }

      // classification.kind === "external": ingest it now.
      const row = buildExternalOrderRow({
        alpaca,
        userId: credential.userId,
        credentialId: credential.id,
        credentialAccountId: credential.accountId,
        now: this.deps.now(),
      });
      if (!row) {
        stuckSet.delete(stuckId);
        continue;
      }
      const inserted = await this.db.transaction(async (tx) => {
        const [newRow] = await tx
          .insert(schema.orders)
          .values(row)
          .onConflictDoNothing({ target: schema.orders.clientOrderId })
          .returning();
        if (!newRow) return null;
        if (publishSocialTrades) {
          const qty = Math.max(
            1,
            Math.round(newRow.executedQuantity ?? newRow.quantity ?? 0),
          );
          const side = tradeActionSide(newRow.tradeAction);
          if (side) {
            await tx.insert(schema.socialTrades).values({
              userId: newRow.userId,
              symbol: newRow.symbol,
              side,
              qty,
              orderType: newRow.orderType?.toLowerCase() ?? "market",
              assetType: newRow.assetType ?? "EQUITY",
              limitPrice: newRow.limitPrice,
              brokerOrderId: newRow.brokerOrderId,
              orderId: newRow.id,
            });
          }
        }
        return newRow;
      });
      if (inserted) {
        console.log(
          `[ExternalFillPoller] Ingested stuck external fill ${stuckId} (${alpaca.symbol}) for user ${credential.userId}`,
        );
        await this.notifyInserted([inserted], decrypted, closeReasonsByBrokerId([alpaca]));
        // Remove from stuck set: it is now persisted.
        stuckSet.delete(stuckId);
      } else {
        // onConflictDoNothing hit: already exists (race or restart). Remove from stuck.
        stuckSet.delete(stuckId);
      }
    }

    if (stuckSet.size === 0) {
      this.stuckOrders.delete(credential.id);
    }
  }

  /**
   * @param closeReasons brokerOrderId -> why the position ended, derived from
   * the raw Alpaca order (see `externalCloseReason`). Absent means the reason
   * is unknown, which is deliberately different from "the user did it".
   */
  private async notifyInserted(
    rows: Array<typeof schema.orders.$inferSelect>,
    decrypted: DecryptedCredentials,
    closeReasons: ReadonlyMap<string, "stop_loss"> = new Map(),
  ): Promise<void> {
    // Match OrderSyncPoller: LIVE accounts only. Paper stays silent to keep
    // review/dev environments from spamming Discord during regression runs.
    if (isPaperAccount(decrypted.accountType)) return;
    for (const order of rows) {
      try {
        await this.deps.notify({
          symbol: order.symbol,
          // Alpaca's filled_at, carried on the row we just inserted. Not
          // statusUpdatedAt, which is ingest time (see isStaleFill).
          executedAt: order.executedAt,
          side: order.tradeAction ?? undefined,
          quantity: order.executedQuantity || order.quantity,
          status: order.status,
          // `previousStatus` is UNKNOWN because this row was just born from the
          // broker's terminal state — use PENDING as a synthetic prior so the
          // suppression logic treats it as a fresh transition.
          previousStatus: "PENDING",
          executedPrice: order.executedPrice ? Number.parseFloat(order.executedPrice) : null,
          orderId: order.id,
          assetType: order.assetType,
          orderType: order.orderType,
          limitPrice: order.limitPrice ? Number.parseFloat(order.limitPrice) : null,
          userId: order.userId,
          copySourceLabel: order.copySourceLabel,
          closeReason: order.brokerOrderId
            ? closeReasons.get(order.brokerOrderId) ?? null
            : null,
          externalOrigin: true,
        });
      } catch (err) {
        console.error(
          `[ExternalFillPoller] Discord notify failed for external fill ${order.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

}
