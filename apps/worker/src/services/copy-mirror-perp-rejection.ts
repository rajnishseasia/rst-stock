/**
 * PURE classification of a Hyperliquid order-placement failure for the
 * copy-mirror path. Split out of `copy-mirror.ts` (audit H7) so the decision
 * that stands between a live leveraged position and a row the product believes
 * is dead is unit-testable without a client, a DB or a poller. No IO here.
 *
 * WHY THIS EXISTS
 *
 * `HyperliquidClient.placeOrder` converts EVERY `ApiRequestError` into a single
 * `HyperliquidOrderRejectedError`, on the reasoning that the HTTP round-trip
 * completed and the venue answered, so the order was never placed. That holds
 * for the ordinary rejections (margin, tick size, minimum value) and fails for
 * exactly one family: a rejection that says the client order id / cloid is
 * ALREADY IN USE. That message is not "your order did not happen", it is "an
 * order with this identity already exists at the venue", which is the opposite
 * claim. The mirror re-places on the resume path with the SAME deterministic
 * cloid, so it is the one path where that family is reachable.
 *
 * Treating it as terminal wrote `REJECTED` onto a row whose position may be
 * live and filled, and `hyperliquid-order-sync` only scans PENDING / SUBMITTED /
 * PARTIAL, so the row left reconciliation permanently: the follower carries
 * leveraged mainnet risk that this system no longer believes exists. That is the
 * CLAUDE.md rule about broker state being the source of truth, inverted.
 *
 * CORRECT UNDER BOTH HYPERLIQUID BEHAVIORS
 *
 * Whether Hyperliquid actually rejects a re-used cloid whose original order
 * filled cannot be determined from this repository, so nothing here assumes it.
 * The design does not need to know:
 *
 *   - If HL DOES reject the re-used cloid, the message is duplicate-shaped, the
 *     row keeps PENDING, and the reconciler finds the original fill by cloid and
 *     moves it to FILLED / PARTIAL.
 *   - If HL DOES NOT reject it, this classifier is never consulted for that
 *     case at all; the placement simply succeeds or fails on its own merits.
 *   - If the duplicate rejection came from something else entirely and no order
 *     exists at the venue, the reconciler's own no-fills / not-resting rule
 *     retires the PENDING row as CANCELLED once it clears the minimum age.
 *
 * Every branch converges on the reconciler, which reads the venue. None of them
 * needs this module to guess.
 *
 * FAIL-CLOSED DEFAULT
 *
 * A message we do not recognize resolves to "reconcile", not "terminal". The
 * two mistakes are not symmetric. Wrongly marking a live order REJECTED hides
 * real money forever and takes a human to find. Wrongly leaving a genuinely
 * rejected order PENDING costs one reconciler pass, after which the same
 * reconciler retires it. So the terminal list is a positive allowlist of
 * venue answers that definitively mean "this order was never accepted and never
 * will be", and everything else is handed to the component that can actually
 * look.
 */

/**
 * `terminal`  - the venue definitively refused; the order does not exist and
 *               never will, so the row may be written REJECTED.
 * `reconcile` - an order with this identity may exist at the venue. Leave the
 *               row in a status the sync poller scans and let it read the truth.
 */
export type PerpRejectionDisposition = "terminal" | "reconcile" | "retry";

export interface PerpRejectionVerdict {
  disposition: PerpRejectionDisposition;
  /** Stable slug for logs and order notes. Never user-facing copy. */
  reason:
    | "duplicate-client-order-id"
    | "unrecognized-rejection"
    | "venue-rejected"
    | "not-submitted"
    | "not-submitted-retryable"
    | "market-unavailable-retryable";
}

/**
 * Messages that assert an order with this client order id / cloid ALREADY
 * EXISTS. Hyperliquid says "cloid"; Postgres unique-violation text and the
 * Alpaca side say "client order id". Both shapes live here so there is exactly
 * one definition of "duplicate-shaped" in the worker.
 */
const DUPLICATE_IDENTITY_PATTERNS: readonly RegExp[] = [
  /client[_ -]?order[_ -]?id.*(?:unique|duplicate|exists|in use|already|reuse)/i,
  /(?:unique|duplicate|already).*client[_ -]?order[_ -]?id/i,
  /cloid.*(?:unique|duplicate|exists|in use|already|reuse)/i,
  /(?:unique|duplicate|already).*cloid/i,
];

/**
 * Venue answers that definitively mean the order was never accepted. Anything
 * outside this list is deliberately NOT terminal; see the fail-closed note above.
 *
 * Each entry is a rejection whose cause is a property of the REQUEST (its size,
 * its price, the collateral behind it, the market it names), never a property of
 * an order that already exists.
 */
/**
 * Market states that LIFT. A halt ends, a market reopens.
 *
 * Grouped with `delisted` until now, which made them terminal for everything.
 * That is right for an open, whose whole point is that it should not go out into
 * a market that will not take it, and wrong for a close: the delivery is
 * completed, trading resumes, and the follower is left holding a leveraged
 * position with no instruction left to exit it. `delisted` stays terminal
 * because it does not lift, and retrying into it forever would wedge the queue
 * on a market that is gone.
 */
const TRANSIENT_MARKET_STATE_PATTERNS: readonly RegExp[] = [
  /halted/i,
  /not trading/i,
  /trading is closed/i,
];

const DEFINITIVE_REJECTION_PATTERNS: readonly RegExp[] = [
  /minimum value/i,
  /insufficient (?:margin|balance|collateral)/i,
  /invalid (?:price|size|order size|asset|coin|leverage|tif|order type)/i,
  /price cannot be more than/i,
  /reduce only/i,
  /zero size/i,
  /tick size/i,
  /delisted/i,
  ...TRANSIENT_MARKET_STATE_PATTERNS,
  /unknown (?:asset|coin)/i,
  /post only/i,
  /builder fee/i,
  /(?:open interest cap|position cap|max position)/i,
];

/** True when the message asserts this order identity already exists at a venue. */
export function isDuplicateOrderIdentityMessage(message: string): boolean {
  return DUPLICATE_IDENTITY_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Classify a `HyperliquidOrderRejectedError` message.
 *
 * The duplicate check runs FIRST and wins outright, so a rejection worded as
 * "Invalid order: cloid already used" can never be pulled terminal by the
 * "invalid ..." entry in the definitive list.
 */
export function classifyPerpRejection(
  message: string,
  intent: { reduceOnly?: boolean } = {},
): PerpRejectionVerdict {
  if (isDuplicateOrderIdentityMessage(message)) {
    return { disposition: "reconcile", reason: "duplicate-client-order-id" };
  }
  // A CLOSE refused because the market is momentarily shut is not finished, it
  // is early. Retiring it completes the one-shot delivery, so when trading
  // resumes the follower still holds the position and nothing remains to exit
  // it. Opens keep the terminal treatment: refusing to enter a halted market is
  // the correct outcome, not a deferral.
  if (
    intent.reduceOnly === true &&
    TRANSIENT_MARKET_STATE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return { disposition: "retry", reason: "market-unavailable-retryable" };
  }
  if (DEFINITIVE_REJECTION_PATTERNS.some((pattern) => pattern.test(message))) {
    return { disposition: "terminal", reason: "venue-rejected" };
  }
  return { disposition: "reconcile", reason: "unrecognized-rejection" };
}

/**
 * Classify a `HyperliquidOrderPreparationError` message.
 *
 * These are raised before the SDK reaches its transport (formatting, signing,
 * serialization), so the default is the opposite of the rejection case: nothing
 * was sent, and the row is safe to retire. The duplicate family is still carved
 * out, because a wrapped cause that says the identity is already in use is
 * evidence of an existing order no matter which class carried it here.
 *
 * A REDUCE-ONLY close is the exception, because "safe to retire" is only true of
 * the ORDER. Retiring the order also completes the delivery, and a close is a
 * one-shot instruction: the follower's position stays open with nothing left to
 * exit it. This class is not all permanent either. It covers request formatting
 * (which will never work) and signing (which fails while the Privy-backed signer
 * is unavailable and succeeds once it is back), and the two are not reliably
 * distinguishable from the message.
 *
 * So a close retries rather than being retired. The order row must be left
 * PENDING for it: `orders.client_order_id` is UNIQUE and the id is deterministic,
 * so a retry resumes that row instead of inserting a second one. Retrying a
 * genuinely malformed close costs one attempt per 15 minutes and an error line;
 * retiring a recoverable one costs the follower their exit.
 */
export function classifyPerpPreparationFailure(
  message: string,
  intent: { reduceOnly?: boolean } = {},
): PerpRejectionVerdict {
  if (isDuplicateOrderIdentityMessage(message)) {
    return { disposition: "reconcile", reason: "duplicate-client-order-id" };
  }
  if (intent.reduceOnly === true) {
    return { disposition: "retry", reason: "not-submitted-retryable" };
  }
  return { disposition: "terminal", reason: "not-submitted" };
}
