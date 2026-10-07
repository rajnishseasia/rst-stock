/**
 * Pure order-DRAFT builder for the chat "order drafting with confirm-before-
 * submit" tool. This module turns natural-language-derived fields into a
 * validated draft plus a client prefill payload. It is the hard stop in the
 * design: there is NO code path from here to a broker order-create call.
 *
 * Guarantees enforced by the type system and asserted by the unit tests:
 *  - Every draft carries `status: "draft"`, a string literal. There is no
 *    `submitted` / `orderId` / broker-id field anywhere in the shape, so a
 *    draft can never masquerade as a placed order.
 *  - The builder performs no I/O and returns a plain object. The only way an
 *    order reaches the broker is the user reviewing the prefilled ticket and
 *    clicking submit by hand (which runs the normal, idempotent order path).
 */

import type { OrderDraftPrefill } from "../types.js";
import { computeRiskReward, type RiskRewardResult } from "./risk-math.js";

export type DraftSide = "buy" | "sell";
export type DraftEntryType = "market" | "limit";

export interface OrderDraftInput {
  symbol: string;
  side: DraftSide;
  /**
   * Explicit position intent. "short" means the user asked to OPEN a short
   * ("short AAPL"), which the ticket must render as SellShort rather than a
   * plain Sell (which reads as closing a long). Omit for ordinary buys and
   * sells so existing behavior is preserved.
   */
  direction?: "long" | "short" | null;
  quantity?: number | null;
  /** "market" or "limit" entry. Defaults to "market". */
  orderType?: DraftEntryType;
  limitPrice?: number | null;
  /** Entry basis for the risk math. Falls back to limitPrice when absent. */
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Risk budget in dollars, used to size quantity when quantity is absent. */
  maxRisk?: number | null;
  timeInForce?: "day" | "gtc";
  notes?: string | null;
}

export interface OrderDraft {
  /**
   * ALWAYS the literal "draft". A draft never represents a live/placed order;
   * the client must show it for review and the user submits it manually.
   */
  status: "draft";
  symbol: string;
  side: DraftSide;
  /** Explicit position intent carried from the input; null when not given. */
  direction: "long" | "short" | null;
  orderType: DraftEntryType;
  quantity: number | null;
  limitPrice: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  timeInForce: "day" | "gtc";
  /** Risk/reward math for the draft, when entry + stop are known. */
  riskReward: RiskRewardResult | null;
  /** Exact fields the browser uses to pre-fill the trade ticket. */
  prefill: OrderDraftPrefill;
  /** True when the draft is complete enough to hand to the ticket. */
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SYMBOL_REGEX = /^[A-Z][A-Z0-9.-]{0,10}$/;

function toFiniteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function isPositive(value: number | null): value is number {
  return value != null && value > 0;
}

/**
 * Build a validated order draft. Never submits, never performs I/O. Returns a
 * best-effort draft even when inputs are incomplete, with the problems listed
 * in `errors` (blocking) and `warnings` (non-blocking).
 */
export function buildOrderDraft(input: OrderDraftInput): OrderDraft {
  const errors: string[] = [];
  const warnings: string[] = [];

  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    errors.push("A ticker symbol is required.");
  } else if (!SYMBOL_REGEX.test(symbol)) {
    errors.push(`"${symbol}" is not a valid ticker symbol.`);
  }

  const side: DraftSide = input.side === "sell" ? "sell" : "buy";
  if (input.side !== "buy" && input.side !== "sell") {
    errors.push('Order side must be "buy" or "sell".');
  }

  const orderType: DraftEntryType = input.orderType === "limit" ? "limit" : "market";

  // Explicit position intent. Only honored when it is coherent with the side:
  // "short" on a buy is contradictory (a buy opens/adds to a long, or covers),
  // so it is dropped with a warning rather than producing a confusing ticket.
  let direction: "long" | "short" | null =
    input.direction === "short" ? "short" : input.direction === "long" ? "long" : null;
  if (direction === "short" && side === "buy") {
    warnings.push(
      'Ignoring direction "short" on a buy order. To open a short, use side "sell" with direction "short".'
    );
    direction = null;
  }

  const limitPrice = toFiniteOrNull(input.limitPrice);
  const entryPriceInput = toFiniteOrNull(input.entryPrice);
  const stopLoss = toFiniteOrNull(input.stopLoss);
  const takeProfit = toFiniteOrNull(input.takeProfit);
  const maxRisk = toFiniteOrNull(input.maxRisk);
  const explicitQty = toFiniteOrNull(input.quantity);
  const timeInForce: "day" | "gtc" = input.timeInForce === "day" ? "day" : "gtc";

  if (orderType === "limit" && !isPositive(limitPrice)) {
    errors.push("A limit order needs a positive limit price.");
  }

  // Entry basis for risk math: explicit entry, else the limit price. A market
  // order with no entry basis can still be a valid draft (qty must be given);
  // it just can't show risk numbers until the ticket picks up the live quote.
  const entryBasis = entryPriceInput ?? (orderType === "limit" ? limitPrice : null);

  // Directional basis for risk checks: an explicit intent wins; otherwise
  // buy => long, sell => short (unchanged).
  const riskDirection = direction ?? (side === "buy" ? "long" : "short");

  let riskReward: RiskRewardResult | null = null;
  if (isPositive(entryBasis) && isPositive(stopLoss)) {
    riskReward = computeRiskReward({
      side: riskDirection,
      entry: entryBasis,
      stop: stopLoss,
      target: takeProfit,
      quantity: explicitQty,
      maxRisk,
    });
    // Surface directional problems (e.g. long stop above entry) as warnings so
    // the user still gets a prefilled ticket to fix, rather than a hard block.
    for (const e of riskReward.errors) warnings.push(e);
  } else if (isPositive(stopLoss) && !isPositive(entryBasis)) {
    warnings.push(
      "Stop provided without an entry price; risk can't be computed until the ticket loads a quote."
    );
  }

  // Quantity resolution: an explicit qty wins; otherwise use the risk-budget
  // size when we could compute one.
  const quantity =
    isPositive(explicitQty)
      ? Math.floor(explicitQty)
      : riskReward?.suggestedQuantityByRisk != null
        ? riskReward.suggestedQuantityByRisk
        : null;

  if (!isPositive(quantity)) {
    errors.push(
      "Quantity is required (give a share count, or a stop plus a max-risk budget to size it)."
    );
  }

  // Ticket order type: ANY stop routes to the OCO/exit-plan ticket so the
  // broker actually attaches the protective leg(s). This covers both a full
  // stop + target bracket and a stop-only draft ("buy 100 AAPL with a stop at
  // 185"): the plain Market/Limit ticket only stores a stop locally and would
  // submit a naked entry.
  const ticketOrderType: OrderDraftPrefill["orderType"] = isPositive(stopLoss)
    ? "OCO"
    : orderType === "limit"
      ? "Limit"
      : "Market";

  // OCO entry-leg type: a limit bracket keeps its Limit entry (with the limit
  // price as the resting entry) instead of degrading to the form's Market
  // default. Non-OCO tickets don't use the field.
  const entryOrderType: OrderDraftPrefill["entryOrderType"] =
    ticketOrderType === "OCO" ? (orderType === "limit" ? "Limit" : "Market") : null;

  const prefill: OrderDraftPrefill = {
    symbol,
    side,
    direction,
    quantity: isPositive(quantity) ? quantity : null,
    entry: isPositive(entryBasis) ? entryBasis : null,
    stopLoss: isPositive(stopLoss) ? stopLoss : null,
    takeProfit: isPositive(takeProfit) ? takeProfit : null,
    orderType: ticketOrderType,
    entryOrderType,
    limitPrice: isPositive(limitPrice) ? limitPrice : null,
    timeInForce,
  };

  return {
    status: "draft",
    symbol,
    side,
    direction,
    orderType,
    quantity: isPositive(quantity) ? quantity : null,
    limitPrice: isPositive(limitPrice) ? limitPrice : null,
    entryPrice: isPositive(entryBasis) ? entryBasis : null,
    stopLoss: isPositive(stopLoss) ? stopLoss : null,
    takeProfit: isPositive(takeProfit) ? takeProfit : null,
    timeInForce,
    riskReward,
    prefill,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
