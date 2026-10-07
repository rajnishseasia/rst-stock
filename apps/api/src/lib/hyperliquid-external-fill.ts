/**
 * Pure decision logic for the Hyperliquid external-fill poller.
 *
 * ============================================================================
 *  THE GAP THIS CLOSES
 * ============================================================================
 *
 * Both existing perp reconcilers are ROW-DRIVEN: `HyperliquidOrderSyncPoller`
 * iterates the DB's open perp orders and asks Hyperliquid about each one. A
 * fill with no matching row is therefore not "missed", it is structurally
 * invisible. That covers the case that actually costs money: a stop-loss the
 * user attached in Hyperliquid's own UI fires, the position closes, and the
 * app never says a word. The equity side has `ExternalFillPoller` for exactly
 * this; the perp side had no counterpart at all.
 *
 * Everything here is pure: no DB, no network, no clock. The poller in
 * `apps/worker/src/services/hyperliquid-external-fill-sync.ts` supplies the IO.
 */

import { createHash } from "node:crypto";

/** The fill fields the classifier reads (a subset of our normalized PerpFill). */
export interface ExternalHlFill {
  time: number;
  coin: string;
  side: "buy" | "sell";
  px: string;
  sz: string;
  closedPnl: string;
  fee: string;
  dir: string;
  oid: number;
  hash: string;
  tid: number;
  cloid: string | null;
}

/** Why a fill was skipped, for logging that can be reasoned about. */
export type SkipReason = "known-order" | "at-or-before-watermark" | "malformed";

export type FillDecision =
  | { ingest: true }
  | { ingest: false; reason: SkipReason };

/**
 * Should this fill be ingested as an external one?
 *
 * `knownOids` are the broker order ids the DB already tracks for this account.
 * `knownCloids` are the client ids Hyperliquid received when the app placed an
 * order. They exist before the venue can fill, unlike the broker oid which is
 * written by reconciliation and can briefly be null.
 * A fill on one of those belongs to `HyperliquidOrderSyncPoller`, which owns
 * the row's lifecycle; ingesting it here would create a duplicate order and a
 * duplicate webhook for a trade the app already knows about.
 */
export function classifyExternalFill({
  fill,
  knownOids,
  knownCloids,
  watermarkMs,
}: {
  fill: ExternalHlFill;
  knownOids: ReadonlySet<number>;
  knownCloids: ReadonlySet<string>;
  /** Fills at or before this are already processed. */
  watermarkMs: number;
}): FillDecision {
  const size = Number.parseFloat(fill.sz);
  const price = Number.parseFloat(fill.px);
  if (
    !Number.isFinite(fill.time) ||
    fill.time <= 0 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return { ingest: false, reason: "malformed" };
  }
  if (fill.time <= watermarkMs) {
    return { ingest: false, reason: "at-or-before-watermark" };
  }
  if (
    knownOids.has(fill.oid) ||
    (fill.cloid !== null && knownCloids.has(fill.cloid.toLowerCase()))
  ) {
    return { ingest: false, reason: "known-order" };
  }
  return { ingest: true };
}

/**
 * Deterministic client order id for an ingested external fill.
 *
 * The unique index on `orders.client_order_id` is what makes a re-read
 * idempotent, so this must depend only on immutable venue facts. `tid` is
 * Hyperliquid's own per-trade identifier and is unique within an account; the
 * hash and oid are included so a venue that ever recycled a tid still lands on
 * a distinct id rather than silently swallowing a real second fill.
 *
 * Prefixed distinctly from Alpaca's `extfill:` so the two ingests can never
 * collide and so the origin of a row is readable straight off the column.
 */
export function externalHlClientOrderId(fill: Pick<ExternalHlFill, "tid" | "oid" | "hash">): string {
  const digest = createHash("sha256")
    .update(`${fill.hash}:${fill.oid}:${fill.tid}`)
    .digest("hex")
    .slice(0, 32);
  return `hlextfill:${digest}`;
}

/** Did this fill reduce a position rather than open one? */
export function isClosingFill(dir: string): boolean {
  return /close|liquidat|>/i.test(dir);
}

/**
 * The trade action to record, in the DB's vocabulary.
 *
 * Hyperliquid's `dir` already states both the side and whether the position
 * was being opened or closed, which is exactly the distinction the enum draws.
 * A `dir` we do not recognize falls back to the raw side rather than guessing
 * at intent.
 *
 * FLIPS ARE READ FROM THE LEFT OF THE ARROW, not from a substring search. Both
 * "Long > Short" and "Short > Long" contain the word "short", so asking whether
 * the whole string mentions a short cannot tell them apart, and a short being
 * covered would be recorded as a long being sold. `"X > Y"` closes X, so X is
 * the only half that describes the position this fill ended.
 */
export function tradeActionForFill(fill: Pick<ExternalHlFill, "dir" | "side">): {
  tradeAction: "Buy" | "Sell" | "SellShort" | "BuyToClose" | "SellToClose" | "BuyToCover";
  direction: "long" | "short";
} {
  const dir = fill.dir.toLowerCase();
  const closing = isClosingFill(fill.dir);
  const short = dir.includes("short");

  if (closing) {
    const closedShort = dir.includes(">")
      ? (dir.split(">")[0] ?? "").includes("short")
      : short;
    return closedShort
      ? { tradeAction: "BuyToCover", direction: "short" }
      : { tradeAction: "SellToClose", direction: "long" };
  }
  if (short) return { tradeAction: "SellShort", direction: "short" };
  if (dir.includes("long")) return { tradeAction: "Buy", direction: "long" };
  return fill.side === "buy"
    ? { tradeAction: "Buy", direction: "long" }
    : { tradeAction: "Sell", direction: "short" };
}

/** How an externally-closed position ended, as far as we can honestly tell. */
export type ExternalCloseReason = "stop_loss" | "take_profit" | "liquidation" | null;

/**
 * Why this fill closed the position.
 *
 * `triggerKinds` maps a resting trigger order's oid to its kind, captured from
 * `frontendOpenOrders` on an EARLIER cycle. Hyperliquid's fill rows carry no
 * order type, so a stop is only recognizable by having seen the order resting
 * before it fired. Stops rest for hours or days and the poller reads open
 * orders every cycle, so in practice this catches them; a stop that was placed
 * and hit inside a single cycle, or one that predates a worker restart, falls
 * back to null.
 *
 * Null means "we do not know", NOT "the user did it deliberately". The alert
 * wording depends on that distinction being kept.
 */
export function closeReasonForFill({
  fill,
  triggerKinds,
}: {
  fill: Pick<ExternalHlFill, "dir" | "oid">;
  triggerKinds: ReadonlyMap<number, "tp" | "sl">;
}): ExternalCloseReason {
  if (/liquidat/i.test(fill.dir)) return "liquidation";
  const kind = triggerKinds.get(fill.oid);
  if (kind === "sl") return "stop_loss";
  if (kind === "tp") return "take_profit";
  return null;
}

/**
 * The watermark to persist after a page.
 *
 * Advances only to the newest fill actually PROCESSED, never to "now": a fill
 * the venue has not surfaced yet must still be inside the next scan window.
 * Never moves backwards, so an out-of-order page cannot rewind the cursor and
 * replay a burst of already-notified fills.
 */
export function nextWatermarkMs(
  processed: ReadonlyArray<Pick<ExternalHlFill, "time">>,
  currentMs: number,
): number {
  let next = currentMs;
  for (const fill of processed) {
    if (Number.isFinite(fill.time) && fill.time > next) next = fill.time;
  }
  return next;
}
