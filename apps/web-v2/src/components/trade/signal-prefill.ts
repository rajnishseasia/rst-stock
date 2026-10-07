/**
 * Pure mapping from the trade ticket's `initial*` prefill props to the concrete
 * form-field values the ticket should adopt. Extracted from `TradeForm` so the
 * load-bearing "which ticket do we show?" logic is unit-testable without
 * mounting the whole form (which pulls in tRPC, sessions, and market-data
 * hooks). `TradeForm`'s prefill effect calls this and applies the returned plan
 * with `setValue` / `replaceTps`.
 *
 * This module performs no I/O and never submits an order: it only decides which
 * fields to seed. The user still reviews and submits the ticket by hand.
 */

/** Order types the trade ticket can represent. Mirrors `TradeForm`'s enum. */
export type SignalPrefillOrderType =
  | "Market"
  | "Limit"
  | "StopMarket"
  | "StopLimit"
  | "OCO";

/** Entry-leg types an OCO ticket supports. Mirrors `TradeForm`'s enum. */
export type SignalPrefillEntryOrderType = "Market" | "Limit";

/** Position intent from a chat draft. Mirrors `TradeForm`'s direction enum. */
export type SignalPrefillDirection = "long" | "short";

/** Trade actions a prefill may select. Subset of `TradeForm`'s action enum. */
export type SignalPrefillAction = "SellShort";

/** Time-in-force values a chat draft may carry. Subset of `TradeForm`'s TIF
 *  enum (drafts never ask for IOC/FOK). */
export type SignalPrefillTimeInForce = "day" | "gtc";

export interface SignalPrefillInput {
  /** Suggested entry price. Anchors the OCO R:R calculator and, absent an
   *  explicit limit price, seeds the Limit Price field. */
  entry?: number;
  /** Suggested stop loss. Paired with `takeProfit` this switches to OCO. */
  stopLoss?: number;
  /** Suggested take-profit target. Paired with `stopLoss` this switches to OCO. */
  takeProfit?: number;
  /** Explicit order type from a chat draft. When provided it sets the ticket's
   *  order type (a plain Market/Limit draft must not show an OCO ticket). */
  orderType?: SignalPrefillOrderType;
  /** Explicit limit price from a chat draft. Used for Limit/StopLimit tickets;
   *  falls back to `entry` when absent. */
  limitPrice?: number;
  /** Entry-leg type for an OCO ticket. A limit bracket draft collapses to OCO
   *  but must keep its Limit entry; without this the form's OCO entry defaults
   *  to Market. Only honored when the resolved ticket is OCO. */
  entryOrderType?: SignalPrefillEntryOrderType;
  /** Explicit position intent from a chat draft. "short" switches the ticket
   *  to an opening short (SellShort + direction short) instead of a plain
   *  Sell that reads as closing a long. Absent = prior behavior. */
  direction?: SignalPrefillDirection;
  /** Time in force from a chat draft. Sets the form's TIF field so a "DAY
   *  order" request doesn't silently fall back to the GTC default. Absent =
   *  form default untouched. */
  timeInForce?: SignalPrefillTimeInForce;
}

/**
 * The subset of trade-form fields a prefill may seed. Any field left
 * `undefined` is not touched, so the form's defaults survive.
 */
export interface SignalPrefillPlan {
  stopMarketPrice?: string;
  entryPriceRef?: string;
  limitPrice?: string;
  orderType?: SignalPrefillOrderType;
  /** OCO entry-leg type. Set so a limit bracket keeps its Limit entry. */
  entryOrderType?: SignalPrefillEntryOrderType;
  /** Trade action override; "SellShort" for an opening-short draft. */
  action?: SignalPrefillAction;
  /** Direction override paired with `action` for an opening short. */
  direction?: SignalPrefillDirection;
  /** TIF override from a chat draft ("DAY order" must not default to GTC). */
  timeInForce?: SignalPrefillTimeInForce;
  takeProfits?: Array<{ price: string; quantity: string }>;
}

function isFiniteNumber(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Resolve the trade-form field values a prefill should apply.
 *
 * Behavior (preserved from the original inline effect when `orderType` and
 * `limitPrice` are absent):
 *  - A finite stop seeds `stopMarketPrice`.
 *  - A finite entry seeds `entryPriceRef` and the Limit Price (so a limit entry
 *    rests at the suggested price).
 *  - A stop + target pair replaces the take-profit rows with a single target
 *    row and, when no explicit order type is given, switches the ticket to OCO
 *    so the broker attaches protective legs (the copy-signal behavior).
 *
 * New behavior (chat order drafts):
 *  - An explicit `orderType` sets the ticket's order type, so a plain Market or
 *    Limit draft shows the matching ticket instead of the default OCO.
 *  - A stop WITHOUT a target upgrades a plain Market/Limit draft to the
 *    OCO/exit-plan ticket (entry type preserved as the entry leg), because only
 *    the exit-plan path broker-attaches the stop; the plain ticket would submit
 *    a naked entry with the stop stored locally.
 *  - For a Limit/StopLimit ticket the explicit `limitPrice` fills the Limit
 *    Price, falling back to the entry price when the draft omitted it.
 *  - An explicit `timeInForce` sets the form's TIF field (a "DAY order" draft
 *    must not fall back to the GTC default).
 */
export function resolveSignalPrefillPlan(
  input: SignalPrefillInput,
): SignalPrefillPlan {
  const {
    entry,
    stopLoss,
    takeProfit,
    orderType,
    limitPrice,
    entryOrderType,
    direction,
    timeInForce,
  } = input;
  const plan: SignalPrefillPlan = {};

  if (isFiniteNumber(stopLoss)) {
    plan.stopMarketPrice = stopLoss.toFixed(2);
  }

  if (isFiniteNumber(entry)) {
    plan.entryPriceRef = entry.toFixed(2);
    // Default the Limit Price to the entry; an explicit limit price below wins.
    plan.limitPrice = entry.toFixed(2);
  }

  const hasBracket = isFiniteNumber(stopLoss) && isFiniteNumber(takeProfit);
  const hasStopOnly = isFiniteNumber(stopLoss) && !isFiniteNumber(takeProfit);

  // Entry-leg type the OCO branch below should honor. Normally the explicit
  // draft value; the stop-only upgrade fills it from the plain entry type.
  let resolvedEntryOrderType = entryOrderType;

  // An explicit draft order type wins; otherwise a stop+target pair still
  // auto-switches to OCO exactly as before.
  //
  // Exception: a stop WITHOUT a target on a plain Market/Limit ticket routes
  // to the OCO/exit-plan ticket instead. TradeForm only broker-attaches
  // `stopMarketPrice` on the exit-plan path (stop-only submits via
  // submitWithExitPlan as an OTO with a stop child); the plain path stores
  // the stop locally and sends a naked entry. The draft's entry type is
  // preserved as the OCO entry leg.
  if (orderType === "Market" || orderType === "Limit") {
    if (hasStopOnly) {
      plan.orderType = "OCO";
      resolvedEntryOrderType = entryOrderType ?? orderType;
    } else {
      plan.orderType = orderType;
    }
  } else if (orderType != null) {
    plan.orderType = orderType;
  } else if (hasBracket) {
    plan.orderType = "OCO";
  }

  // A Limit/StopLimit ticket needs a concrete limit price. Prefer the explicit
  // draft limit price; the entry-derived value above is the fallback.
  if (
    (plan.orderType === "Limit" || plan.orderType === "StopLimit") &&
    isFiniteNumber(limitPrice)
  ) {
    plan.limitPrice = limitPrice.toFixed(2);
  }

  // OCO entry-leg type: a limit bracket draft ("limit buy at 180 with stop and
  // target") collapses to an OCO ticket, but the entry must stay a Limit
  // resting at the requested price rather than the form's Market default. The
  // explicit draft limit price seeds the Limit Price and, when the entry price
  // was absent, the R:R anchor too.
  if (plan.orderType === "OCO" && resolvedEntryOrderType != null) {
    plan.entryOrderType = resolvedEntryOrderType;
    if (resolvedEntryOrderType === "Limit" && isFiniteNumber(limitPrice)) {
      plan.limitPrice = limitPrice.toFixed(2);
      if (plan.entryPriceRef == null) {
        plan.entryPriceRef = limitPrice.toFixed(2);
      }
    }
  }

  // Opening-short intent: switch the ticket to SellShort/short so the reviewed
  // order opens a short instead of reading as closing a long. An explicit
  // "long" only pins the direction (the form's action default already fits).
  if (direction === "short") {
    plan.action = "SellShort";
    plan.direction = "short";
  } else if (direction === "long") {
    plan.direction = "long";
  }

  // Explicit TIF from a chat draft. Absent = the form's default survives.
  if (timeInForce != null) {
    plan.timeInForce = timeInForce;
  }

  if (isFiniteNumber(stopLoss) && isFiniteNumber(takeProfit)) {
    plan.takeProfits = [{ price: takeProfit.toFixed(2), quantity: "1" }];
  }

  return plan;
}
