/**
 * Order-review pure helpers - extracted from the trade-form god component
 * (audit H7). These decide WHETHER an order must pass through the "Review
 * order before submitting" confirmation dialog, and compute the dollar-impact
 * numbers shown inside it. Kept side-effect free so they can be unit tested
 * and reasoned about independently of the React form.
 */

/** Fraction of total portfolio value risked on a default-sized position: the
 *  Max $ Risk field defaults to this share of the account, and the review
 *  modal flags positions whose stop-out loss exceeds it. Change here to retune. */
export const RISK_BUDGET_PCT = 0.01;
export const RISK_BUDGET_LABEL = `${Math.round(RISK_BUDGET_PCT * 100)}%`;

/** Any action containing "buy" (Buy, BuyToOpen, BuyToCover, BuyToClose) is a
 *  buy; everything else (Sell, SellShort, SellToClose, SellToOpen) is a sell. */
export function getActionSide(action: string): "buy" | "sell" {
  if (action.toLowerCase().includes("buy")) return "buy";
  return "sell";
}

export interface ShouldReviewOrderInput {
  assetType: "EQUITY" | "OPTION";
  direction: "long" | "short";
  action: string;
}

export interface ShouldReviewOrderContext {
  /** Ticket is embedded (e.g. inside a signal card) - always reviewed. */
  embedded: boolean;
  activeAccountType?: "PAPER" | "LIVE";
  isPrefilledOrder: boolean;
}

/**
 * Whether an order must pass through the confirmation dialog before it is
 * submitted (instead of firing immediately). True for every embedded ticket,
 * every LIVE-account order, every option, every short, every sell, and every
 * prefilled (chat-sourced) order - i.e. everywhere a mistake is expensive or
 * the user didn't type the numbers themselves.
 */
export function shouldReviewOrder(
  data: ShouldReviewOrderInput,
  context: ShouldReviewOrderContext,
): boolean {
  return (
    context.embedded ||
    context.activeAccountType === "LIVE" ||
    data.assetType === "OPTION" ||
    data.direction === "short" ||
    getActionSide(data.action) === "sell" ||
    context.isPrefilledOrder
  );
}

export interface ReviewMetricsOrder {
  orderType: string;
  quantity: string;
  entryOrderType: string;
  assetType: "EQUITY" | "OPTION";
  entryPriceRef?: string;
  limitPrice?: string;
  stopMarketPrice?: string;
  trailingEnabled: boolean;
  trailingQty?: string;
  trailingPercent?: string;
  takeProfits?: { quantity: string; price: string }[];
}

export interface ReviewMetrics {
  positionSize: number;
  riskIfStopped: number | null;
  riskPctOfPortfolio: number | null;
  /** Flag positions whose stop-out loss exceeds the risk-budget guideline. */
  riskExceedsBudget: boolean;
  hasTrailingRunner: boolean;
}

/**
 * Dollar figures for the review modal: how much cash the position commits and
 * how much is lost if the stop is hit. Computed from the order being reviewed
 * so the numbers match exactly what's about to be sent. Risk is also expressed
 * as a % of the portfolio so an oversized position is obvious before submit.
 *
 * Returns null when there is no order to review, the order isn't an OCO exit
 * plan (a plain order carries no attached protective stop to size against),
 * or the quantity/entry price can't be resolved to a usable positive number.
 */
export function computeReviewMetrics(
  order: ReviewMetricsOrder | null,
  liveQuoteLast: string | undefined,
  portfolioValue: number | null | undefined,
): ReviewMetrics | null {
  if (!order) return null;
  const qty = parseFloat(order.quantity || "0");
  // Mirror resolveSizingPrice: limit entries fill at their anchor/limit price;
  // market entries fill at the live quote. Using entryPriceRef for a market
  // order is wrong - it's only a calculator anchor, not the actual fill price,
  // and it would produce a number inconsistent with the main-form risk readout.
  const isLimitEntry = order.entryOrderType === "Limit";
  const entry = parseFloat(
    (isLimitEntry
      ? order.entryPriceRef || order.limitPrice || liveQuoteLast
      : liveQuoteLast || order.entryPriceRef || order.limitPrice) || "0",
  );
  // For non-OCO orders (plain Market/Limit), still surface the estimated
  // position size so the user can see total cost before confirming. No stop
  // risk is shown since there is no attached protective stop.
  if (order.orderType !== "OCO") {
    if (!(qty > 0) || !(entry > 0)) return null;
    const multiplier = order.assetType === "OPTION" ? 100 : 1;
    return {
      positionSize: qty * entry * multiplier,
      riskIfStopped: null,
      riskPctOfPortfolio: null,
      riskExceedsBudget: false,
      hasTrailingRunner: false,
    };
  }
  const stop = parseFloat(order.stopMarketPrice || "0");
  if (!(qty > 0) || !(entry > 0)) return null;
  const multiplier = order.assetType === "OPTION" ? 100 : 1;
  const positionSize = qty * entry * multiplier;

  // Determine whether a trailing runner is part of this exit plan. When it
  // is, the fixed stop price only protects the take-profit OCO legs - the
  // trailing runner shares have a dynamic floor, not the fixed stop price.
  const trailQty = parseInt(order.trailingQty || "0") || 0;
  const trailPct = parseFloat(order.trailingPercent || "0") || 0;
  const hasTrailingRunner = !!(
    order.trailingEnabled &&
    trailQty > 0 &&
    trailPct > 0
  );

  // Count only the shares that are actually protected by the fixed stop (the
  // TP OCO legs). When no trailing runner is present every share is covered.
  const tpQty = hasTrailingRunner
    ? (order.takeProfits || []).reduce(
        (s, tp) => s + (parseInt(tp.quantity || "0") || 0),
        0,
      )
    : qty;

  const fixedStopRisk =
    stop > 0 && tpQty > 0 ? tpQty * Math.abs(entry - stop) * multiplier : null;
  const runnerInitialRisk = hasTrailingRunner
    ? trailQty * entry * (trailPct / 100) * multiplier
    : 0;
  const riskIfStopped =
    fixedStopRisk !== null || runnerInitialRisk > 0
      ? (fixedStopRisk ?? 0) + runnerInitialRisk
      : null;
  const riskPctOfPortfolio =
    riskIfStopped !== null && portfolioValue && portfolioValue > 0
      ? riskIfStopped / portfolioValue
      : null;

  return {
    positionSize,
    riskIfStopped,
    riskPctOfPortfolio,
    riskExceedsBudget:
      riskPctOfPortfolio !== null && riskPctOfPortfolio > RISK_BUDGET_PCT,
    hasTrailingRunner,
  };
}
