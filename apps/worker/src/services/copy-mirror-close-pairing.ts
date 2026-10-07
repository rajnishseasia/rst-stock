/**
 * PURE pairing rules for a copy-mirror CLOSE (audit H7: own module).
 *
 * A mirrored CLOSE is a ONE-SHOT instruction. The delivery row that
 * carries it is marked completed the moment `processCandidate` returns any
 * outcome, including a skip, and a completed delivery is never retried. So a
 * close that runs before the position it is meant to reduce exists is not
 * merely a no-op: it is the permanent loss of the only instruction the mirror
 * ever had to exit that position.
 *
 * `copy-mirror-delivery-order.ts` fixed the ORDERING half of this. Opens are
 * handed over before their own closes, so a same-window scalp no longer lands
 * back to front. It did not fix the FAILURE half:
 *
 *   1. The due batch is loaded once and iterated in memory.
 *   2. The OPEN sorts first and THROWS (RPC blip, venue timeout, DB error). Its
 *      delivery is requeued as pending, so it will be retried.
 *   3. The CLOSE, later in the very same batch, runs anyway. The follower has
 *      no position, so the reduce-only decision skips with "no-position" and
 *      the delivery is marked completed, forever.
 *   4. The open's retry succeeds minutes later and opens leveraged exposure
 *      whose close has already been spent.
 *
 * The follower is left holding a leveraged position alone, and every delivery
 * in the sequence reports success.
 *
 * The rule here is therefore: a close that found NOTHING TO REDUCE must not be
 * consumed while an open that could still create that exposure is queued. It is
 * deferred instead, which places no order and keeps the instruction alive for a
 * later cycle. If the queued open eventually settles without creating exposure,
 * the close finds no sibling on a later pass and completes normally; if it never
 * settles, the close burns its retry budget and fails terminally with an error
 * an operator can see, rather than reporting a success that never happened.
 *
 * Nothing here reads venue state or invents one. It answers a single narrow
 * question from the queue's own contents: is there still a queued open that
 * belongs in front of this close? Every input we cannot read resolves to "yes",
 * because deferring places no order while consuming is irreversible.
 *
 * BOTH VENUES, not perps alone. The rules were written against the Hyperliquid
 * close and wired only into `executePerpCloseMirror`, but nothing in the
 * argument is about perps: an Alpaca equity or option close is discovered,
 * ordered, retried and consumed by the very same delivery queue, and its skip
 * ("no-long-position" when the follower holds nothing yet) is returned straight
 * out of `processCandidate` and marked completed exactly the same way. A source
 * that buys 200 MSFT and sells them twenty seconds later stages both in one
 * window, and an open that throws is requeued while the close later in that
 * same in-memory batch runs anyway against a position that does not exist yet.
 * The venue only changes what marks a row as a close: `perpReduceOnly` on
 * Hyperliquid, or a long-position `sell` intent on Alpaca. A short/option-open
 * sell is still new exposure and must retain the entry guardrails.
 *
 * No IO in this module, so all of it is unit testable without a DB or a client.
 */

import { sourceEventTimeMs } from "./copy-mirror-delivery-order";

/** The candidate fields pairing depends on. Structural, so tests need no DB. */
export interface PairedPerpDelivery {
  sourceItemId: string;
  followerUserId: string;
  /** Canonical coin or ticker. Empty when the payload did not carry one. */
  symbol: string;
  assetType?: string;
  /** ISO source event time (the trade/signal timestamp), when known. */
  sourceEventAt?: string;
  /** Reduce-only perp mirrors are closes; everything else opens or adds. */
  perpReduceOnly?: boolean;
  /**
   * Mirror side, which is what marks a close on the Alpaca path: there is no
   * reduce-only flag on an equity order, so a `sell` is the exit (the same
   * reading `processCandidate` and `decideEquityMirrorConsent` take). Absent
   * when the payload did not carry a readable one.
   */
  side?: "buy" | "sell";
  /** Full position intent when the source carries one (SellToOpen is not a close). */
  tradeAction?: string;
  /** Authoritative long/short direction; short sell-side entries stay opens. */
  direction?: "long" | "short";
}

/** A still-queued delivery row, as loaded from the durable delivery table. */
export interface QueuedDeliveryRow {
  sourceItemId: string;
  followerUserId: string;
  /** The frozen candidate payload. Typed as unknown: it is JSON from the DB. */
  candidate: unknown;
}

/**
 * Skip reasons from the reduce-only sizing decision that all mean the same
 * thing: the exposure this close was meant to reduce was NOT THERE.
 *
 *  - "no-position": the follower holds nothing in this coin.
 *  - "wrong-side": they hold the opposite side, so this close addresses a
 *    position the mirror has not opened (yet).
 *  - "no-qty": the size could not be derived, which is what proportional
 *    sizing produces when the mirrored exposure it divides by is still zero,
 *    and what the equity clamp produces when the attributed size rounds away.
 *  - "no-long-position": the equity reading of "no-position". `fetchLongQty`
 *    reports 0 for an account that is flat in the symbol, so a mirrored open
 *    that has not filled yet looks exactly like a position that never existed.
 *  - "no-mirrored-exposure": nothing on file attributes any of the follower's
 *    holding to the mirror, which is also true for the seconds before the
 *    paired open manages to write its own order row.
 *
 * Any other skip is about the close itself rather than a missing open, and is
 * consumed normally.
 */
const UNSATISFIED_CLOSE_REASONS = new Set([
  "no-position",
  "wrong-side",
  "no-qty",
  "no-long-position",
  "no-mirrored-exposure",
]);

/** Did this close skip because the exposure it targets does not exist yet? */
export function closeFoundNoExposure(reason: string): boolean {
  return UNSATISFIED_CLOSE_REASONS.has(reason);
}

/**
 * Read the pairing fields out of a frozen candidate payload.
 *
 * Returns null when the payload is not an object at all. A payload we cannot
 * read is not evidence that the row is unrelated, and the caller treats it as a
 * sibling rather than assuming it away.
 */
export function readPairedDelivery(candidate: unknown): PairedPerpDelivery | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const value = candidate as Record<string, unknown>;
  return {
    sourceItemId: typeof value.sourceItemId === "string" ? value.sourceItemId : "",
    followerUserId: typeof value.followerUserId === "string" ? value.followerUserId : "",
    symbol: typeof value.symbol === "string" ? value.symbol.trim() : "",
    ...(typeof value.assetType === "string" ? { assetType: value.assetType } : {}),
    ...(typeof value.sourceEventAt === "string"
      ? { sourceEventAt: value.sourceEventAt }
      : {}),
    ...(value.side === "buy" || value.side === "sell" ? { side: value.side } : {}),
    perpReduceOnly: value.perpReduceOnly === true,
    ...(typeof value.tradeAction === "string" ? { tradeAction: value.tradeAction } : {}),
    ...(value.direction === "long" || value.direction === "short"
      ? { direction: value.direction }
      : {}),
  };
}

/**
 * Is this delivery itself a CLOSE?
 *
 * Read per venue, because the two paths mark an exit differently. A perp says
 * so outright with `perpReduceOnly`. An Alpaca order has no reduce-only flag,
 * so a long-position sell intent is the exit there. The full action/direction
 * fields prevent a short or option-open sell from being treated as one.
 *
 * A row whose asset type is unreadable is NOT resolved by side: a perp SHORT
 * ENTRY is also a `sell` (candidate sources stage `perpSide === "long" ? "buy"
 * : "sell"`), and calling that an exit would be wrong in both directions. It
 * would release a close the entry could still fill for in the pairing use
 * below, and it would exempt an ENTRY from the attempt ceiling in
 * `markDeliveryFailed`. Unknown therefore stays an open, which is the reading
 * that neither places an order nor arms one indefinitely.
 *
 * EXPORTED because "is this delivery a close" is the same question the queue
 * asks when it decides whether a row may outlive the attempt ceiling, and the
 * two must not drift: keying that decision on `perpReduceOnly` alone is what
 * let an Alpaca exit be retired as a permanent failure after eight transient
 * broker errors while the identical perp exit retried forever.
 */
export function isClosingDelivery(delivery: PairedPerpDelivery): boolean {
  if (delivery.perpReduceOnly === true) return true;
  // A sell-side short/option-open is NEW exposure. Do not let the lossy broker
  // side exempt it from consent, staleness, retry, or cap checks.
  if (
    delivery.side !== "sell" ||
    delivery.direction === "short" ||
    delivery.tradeAction === "SellShort" ||
    delivery.tradeAction === "SellToOpen"
  ) {
    return false;
  }
  return (
    delivery.assetType !== undefined &&
    delivery.assetType !== "PERP" &&
    delivery.side === "sell"
  );
}

/**
 * `isClosingDelivery` for a raw frozen candidate payload straight off a
 * delivery row, which is JSON from the DB and typed as unknown.
 *
 * An unreadable payload is not a close. A close is the claim that unlocks the
 * exemptions (no attempt ceiling), so it must rest on positive evidence rather
 * than on the absence of any.
 */
export function isClosingCandidate(candidate: unknown): boolean {
  const delivery = readPairedDelivery(candidate);
  return delivery !== null && isClosingDelivery(delivery);
}

/**
 * Could this queued row still open the exposure `close` wants to reduce?
 *
 * Exclusions are only made on POSITIVE evidence that the row is unrelated: a
 * different follower, a different symbol, another close, a mirror in a
 * different asset class, the close's own row, or an entry the source made AFTER
 * this close (a re-entry, which this close was never meant to exit). Everything
 * else counts.
 *
 * The asset type is compared against the CLOSE's own rather than a hard-coded
 * "PERP", so an equity close is held by an equity open and a perp close by a
 * perp open, and neither is held by the other. Option contracts share the
 * underlying in `symbol`, so a close in one contract can be held by a queued
 * open in another on the same underlying. That is over-holding rather than a
 * wrong answer: it places no order and clears as soon as the sibling resolves.
 */
export function isUnresolvedSiblingOpen(
  close: PairedPerpDelivery,
  row: QueuedDeliveryRow,
): boolean {
  if (row.sourceItemId === close.sourceItemId) return false;
  if (row.followerUserId !== close.followerUserId) return false;

  const open = readPairedDelivery(row.candidate);
  // Unreadable payload for one of this follower's own queued deliveries: we
  // cannot show it is unrelated, so it holds the close back.
  if (!open) return true;
  if (open.sourceItemId !== "" && open.sourceItemId === close.sourceItemId) return false;
  if (open.followerUserId !== "" && open.followerUserId !== close.followerUserId) return false;
  if (isClosingDelivery(open)) return false;
  if (
    open.assetType !== undefined &&
    close.assetType !== undefined &&
    open.assetType !== close.assetType
  ) {
    return false;
  }
  // An empty symbol is unreadable, not "a different symbol".
  if (open.symbol !== "" && close.symbol !== "" && open.symbol !== close.symbol) return false;

  const openMs = sourceEventTimeMs(open);
  const closeMs = sourceEventTimeMs(close);
  // A source entry stamped strictly after this close is a re-entry the close
  // never addressed. Either timestamp missing leaves the sequence unknown, and
  // unknown holds the close back.
  if (openMs !== null && closeMs !== null && openMs > closeMs) return false;

  return true;
}

export type CloseConsumptionDecision =
  /** Mark the delivery completed: nothing queued can still change the answer. */
  | { action: "complete" }
  /**
   * Leave the delivery unconsumed and retry it later. No order is placed, and
   * the follower keeps the only instruction the mirror has to exit.
   */
  | {
      action: "defer";
      reason: "sibling-open-unresolved" | "sibling-scan-truncated";
      blockedBy: string[];
    };

/**
 * Decide whether a skipped close may be marked completed.
 *
 * Named for the perp path it was written for and kept that way so the existing
 * call site is untouched, but the question is venue independent and the Alpaca
 * close path asks it too. `close.assetType` is what tells the two apart.
 *
 * `pendingDeliveries` is the set of deliveries still queued for this follower,
 * read fresh at decision time. An open that failed earlier in this same drain
 * is already back in that set, which is what makes the failure case visible
 * here without tracking in-memory batch state.
 */
export function decidePerpCloseConsumption(input: {
  close: PairedPerpDelivery;
  /** The skip reason the reduce-only decision produced. */
  closeSkipReason: string;
  pendingDeliveries: readonly QueuedDeliveryRow[];
  /**
   * The pending-delivery scan hit its cap, so `pendingDeliveries` is a PREFIX
   * of the queue rather than all of it. Absence of a sibling in a partial scan
   * is not evidence of absence.
   */
  pendingScanTruncated?: boolean;
  /**
   * The paired open completed with an ambiguous outcome (for example
   * "syncing"): the venue may hold exposure that `listPositions` has not
   * surfaced yet. Completed rows are not in the pending queue, so nothing else
   * here can see them.
   */
  openOutcomeAmbiguous?: boolean;
}): CloseConsumptionDecision {
  if (!closeFoundNoExposure(input.closeSkipReason)) return { action: "complete" };

  // An ambiguous open means exposure may exist that the position read missed.
  // Consuming the close against a stale "no position" would spend the only
  // exit instruction this position will ever get.
  if (input.openOutcomeAmbiguous) {
    return { action: "defer", reason: "sibling-open-unresolved", blockedBy: [] };
  }

  const blockedBy = input.pendingDeliveries
    .filter((row) => isUnresolvedSiblingOpen(input.close, row))
    .map((row) => row.sourceItemId);

  if (blockedBy.length > 0) {
    return { action: "defer", reason: "sibling-open-unresolved", blockedBy };
  }
  // Nothing blocking WITHIN the scanned prefix, but the scan was incomplete.
  // Fail closed: the delivery retries and can complete once the backlog drains.
  if (input.pendingScanTruncated) {
    return { action: "defer", reason: "sibling-scan-truncated", blockedBy: [] };
  }
  return { action: "complete" };
}
