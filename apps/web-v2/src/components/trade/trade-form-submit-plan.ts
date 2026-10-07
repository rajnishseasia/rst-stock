/**
 * Pure decisions extracted from the trade-form god component (audit H7 style
 * extraction) so they can be unit tested directly instead of via source-string
 * assertions. Each function here mirrors logic that used to live inline in
 * trade-form.tsx; the component calls these instead of re-deriving the same
 * thing in several places.
 */

import { DEFAULT_TP_FRACTION, riskAtQty, type Direction } from "./smart-exit";

export type EntryOrderType = "Market" | "Limit";
export type TicketOrderType =
  | "Market"
  | "Limit"
  | "StopMarket"
  | "StopLimit"
  | "OCO";
export type TicketAssetType = "EQUITY" | "OPTION";
export type EquitySide = "buy" | "sell";
export type QuickTradeAction = "Buy" | "Sell" | "BuyToOpen" | "SellToOpen";

export interface QuickTradeIntent {
  direction: Direction;
  action: QuickTradeAction;
}

/**
 * Resolves the "quick intent" shortcut the asset-type/direction toggles use
 * to set direction and action together. Options only have a long/short axis
 * and always map onto BuyToOpen/SellToOpen. Equity maps buy/sell onto
 * Buy/Sell directly, but a sell resolves to `null` (meaning: make no change)
 * unless the account actually holds a sellable long position - this is what
 * stops the quick toggle from quietly arming a short sale the account can't
 * cover.
 */
export function resolveQuickTradeIntent(params: {
  assetType: TicketAssetType;
  side: Direction | EquitySide;
  canSellLongEquity: boolean;
}): QuickTradeIntent | null {
  if (params.assetType === "OPTION") {
    const direction: Direction = params.side === "short" ? "short" : "long";
    return {
      direction,
      action: direction === "long" ? "BuyToOpen" : "SellToOpen",
    };
  }
  if (params.side === "sell" && !params.canSellLongEquity) return null;
  return {
    direction: "long",
    action: params.side === "sell" ? "Sell" : "Buy",
  };
}

/**
 * Caption under "Stop loss & targets" describing what protection (if any)
 * applies to the current ticket.
 */
export function stopLossSectionCaption(
  orderType: TicketOrderType,
  isOptions: boolean,
): string {
  if (orderType === "OCO") return "Broker-managed protection after fill";
  if (isOptions) return "Options do not support attached exits";
  return "No broker-managed exits";
}

/**
 * Order type to restore when "Attach exit plan" is turned off (or the
 * "Continue without exit plan" shortcut is used). Preserves the user's Entry
 * choice - hard-coding Market here would silently downgrade a Limit ticket
 * while the Entry control still read Limit.
 */
export function plainOrderTypeForEntry(
  entryOrderType: EntryOrderType,
): EntryOrderType {
  return entryOrderType === "Limit" ? "Limit" : "Market";
}

/**
 * Single price basis for risk math: a Limit entry prefers the explicit
 * entry/limit anchor, falling back to `sizingPrice` only if neither is set
 * yet. A Market entry always sizes off `sizingPrice` (the live quote) - the
 * anchor fields are seeded by applySmartExit for OCO bookkeeping and can go
 * stale as the quote moves, so using them for a Market entry would let the
 * submitted position drift from the configured risk budget.
 */
export function resolveLimitAwareBasis(params: {
  entryOrderType: EntryOrderType;
  watchEntry?: string;
  limitPrice?: string;
  sizingPrice: number;
}): number {
  const { entryOrderType, watchEntry, limitPrice, sizingPrice } = params;
  if (entryOrderType !== "Limit") return sizingPrice;
  return parseFloat(watchEntry || limitPrice || "0") || sizingPrice;
}

/**
 * Whether the risk-budget auto-sizer should recompute the share quantity.
 * Runs for every non-option order type (Market, Limit, or OCO - the plain-mode
 * stop is a sizing anchor only, not just OCO), and only while the user hasn't
 * hand-typed a quantity or forced the 3-contract override.
 */
export function shouldRunAutoSizer(params: {
  assetType: TicketAssetType;
  userEditedQty: boolean;
  forceThreeContracts: boolean;
}): boolean {
  if (params.assetType === "OPTION") return false;
  if (params.userEditedQty || params.forceThreeContracts) return false;
  return true;
}

export interface EstimatedNotionalInput {
  quantity?: string;
  isOptions: boolean;
  entryOrderType: EntryOrderType;
  orderType: TicketOrderType;
  watchEntry?: string;
  limitPrice?: string;
  currentQuoteLast?: string;
}

/**
 * Estimated $ size of the position shown in the amount header. An option
 * contract controls 100 shares, so its notional is 100x the equity formula -
 * getting this multiplier wrong under- or over-states the real dollar
 * exposure by two orders of magnitude.
 */
export function computeEstimatedNotional(
  input: EstimatedNotionalInput,
): number | null {
  const qty = parseFloat(input.quantity || "0");
  const multiplier = input.isOptions ? 100 : 1;
  const notionalPrice =
    input.entryOrderType === "Limit"
      ? input.watchEntry || input.limitPrice || input.currentQuoteLast
      : input.orderType === "Limit" || input.orderType === "StopLimit"
        ? input.limitPrice || input.currentQuoteLast
        : input.currentQuoteLast;
  const price = parseFloat(notionalPrice || "0") || 0;
  if (
    !Number.isFinite(qty) ||
    !Number.isFinite(price) ||
    qty <= 0 ||
    price <= 0
  )
    return null;
  return qty * price * multiplier;
}

export interface ExitPlanRoutingInput {
  orderType: TicketOrderType;
  assetType: TicketAssetType;
  stopMarketPrice?: string;
  trailingEnabled: boolean;
  trailingPercent?: string;
  trailingQty?: string;
  takeProfits?: Array<{ price: string; quantity: string }>;
}

export interface ExitPlanRouting {
  /** Route through submitWithExitPlan (worker-attached, or an OTO stop_loss
   *  child for a stop-only ticket) instead of the plain-order/bracket paths. */
  useExitPlan: boolean;
  /** Trailing-stop payload to send to submitWithExitPlan, or undefined when no
   *  runner is actually configured (qty and percent both > 0). A stop-only
   *  submit must never ship a trailing leg it doesn't have. */
  trailingStop: { trailPercent: number } | undefined;
  /** Whether at least one fixed take-profit row is usable (price and qty > 0). */
  hasFixedTps: boolean;
}

/**
 * Decide how an OCO-ticket submission routes at submit time. A stop-only
 * order (no TP, no trailing) still goes through submitWithExitPlan so the
 * server attaches the stop as an Alpaca OTO stop_loss child - only trailing,
 * a fixed take-profit, or a fixed stop makes the plan real; an OCO ticket with
 * none of the three is a naked entry and must not silently exit-plan-submit.
 */
export function resolveExitPlanRouting(
  data: ExitPlanRoutingInput,
): ExitPlanRouting {
  const trailQtyNum = parseInt(data.trailingQty || "0") || 0;
  const trailPctNum = parseFloat(data.trailingPercent || "0") || 0;
  const hasFixedTps =
    !!data.takeProfits &&
    data.takeProfits.some(
      (tp) => parseFloat(tp.price) > 0 && parseInt(tp.quantity || "0") > 0,
    );
  const trailingConfigured =
    data.trailingEnabled && trailQtyNum > 0 && trailPctNum > 0;
  const useExitPlan =
    data.orderType === "OCO" &&
    data.assetType === "EQUITY" &&
    (trailingConfigured || hasFixedTps || !!data.stopMarketPrice);

  return {
    useExitPlan,
    trailingStop: trailingConfigured
      ? { trailPercent: trailPctNum }
      : undefined,
    hasFixedTps,
  };
}

export interface ActiveTrailingRunnerInput {
  trailingEnabled: boolean;
  trailingQty?: string;
  trailingPercent?: string;
}

/**
 * Whether the trailing runner is genuinely configured (on, with a positive
 * quantity and percent) - as opposed to merely toggled on with empty fields.
 */
export function hasActiveTrailingRunner(
  input: ActiveTrailingRunnerInput,
): boolean {
  return (
    input.trailingEnabled &&
    (parseInt(input.trailingQty || "0", 10) || 0) > 0 &&
    (parseFloat(input.trailingPercent || "0") || 0) > 0
  );
}

/** Live risk-readout label: the runner has no stop-out, only an entry-time cost. */
export function riskReadoutSuffix(runnerActive: boolean): string {
  return runnerActive ? " at entry" : " if stopped";
}

/**
 * Take-profit share of the position: 0 when the user opted out of a preset
 * take-profit entirely, DEFAULT_TP_FRACTION when a trailing runner rides the
 * remainder, or the whole position when there is no trailing runner to split
 * with. Shared by the auto-fill (applySmartExit) and the risk-budget
 * auto-resize effect so a re-size always covers the same shape of plan the
 * auto-fill would have produced.
 */
export function resolveTpFraction(params: {
  tpActive: boolean;
  trailingActive: boolean;
}): number {
  if (!params.tpActive) return 0;
  return params.trailingActive ? DEFAULT_TP_FRACTION : 1;
}

export interface CurrentRiskInput extends ActiveTrailingRunnerInput {
  quantity?: string;
  takeProfits?: Array<{ quantity: string }>;
  sizingPrice: number;
  stopMarketPrice?: string;
  direction: Direction;
  isOption: boolean;
}

/**
 * Live $ risk for the currently entered quantity, shown on the main form
 * (presentation only - never touches quantity, schema, or submit). With an
 * active trailing runner, the fixed stop only protects the take-profit OCO
 * legs (the runner rides its own dynamic floor, not the fixed stop), so the
 * readout adds the runner's own initial (trail %) risk on top of the fixed
 * stop's - pricing every share against the fixed stop would overstate the
 * runner shares' actual downside.
 */
export function computeCurrentRisk(input: CurrentRiskInput): number | null {
  const runnerActive = hasActiveTrailingRunner(input);
  const fixedStopQty = runnerActive
    ? (input.takeProfits || []).reduce(
        (sum, tp) => sum + (parseInt(tp.quantity || "0", 10) || 0),
        0,
      )
    : parseFloat(input.quantity || "0");
  const fixedStopRisk = riskAtQty({
    qty: fixedStopQty,
    price: input.sizingPrice,
    stop: parseFloat(input.stopMarketPrice || "0"),
    direction: input.direction,
    isOption: input.isOption,
  });
  if (!runnerActive) return fixedStopRisk;

  const runnerQty = parseInt(input.trailingQty || "0", 10) || 0;
  const trailPct = parseFloat(input.trailingPercent || "0") || 0;
  const multiplier = input.isOption ? 100 : 1;
  const runnerInitialRisk =
    runnerQty * input.sizingPrice * (trailPct / 100) * multiplier;
  return (fixedStopRisk ?? 0) + runnerInitialRisk;
}
