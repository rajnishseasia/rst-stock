/**
 * Smart Exit math - pure helpers for the one-click exit plan.
 *
 * The trade form auto-fills a protective stop, a risk-sized quantity, and an
 * exit plan that takes part of the position at a fixed R-multiple and trails
 * the rest. These functions are kept side-effect free so they can be unit
 * tested and reasoned about independently of the React form.
 */

export type Direction = "long" | "short";

/** Smallest trailing percent Alpaca will accept, used to clamp tiny trails. */
export const MIN_TRAIL_PERCENT = 0.1;

/**
 * UX floor for the auto-filled trailing percent. Traders reported the previous
 * 1R-derived trail was often too tight (e.g. a $100 stock with a $99 stop
 * yielded a 1% trail that whipsawed on normal noise). We floor the auto-fill
 * at 5% and let a wider computed value (from a wider stop) take precedence.
 * A user who wants tighter than 5% can still type it in manually - this is
 * only the auto-fill floor, not a hard minimum.
 */
export const DEFAULT_TRAIL_PERCENT = 5;

/** Default share of the position taken at the fixed take-profit (the rest trails). */
export const DEFAULT_TP_FRACTION = 0.5;

/** Default fixed take-profit multiple (in R). */
export const DEFAULT_TP_R = 0.7;

/** Default runner multiple (in R) - informational; the runner uses a trailing stop. */
export const DEFAULT_RUNNER_R = 0.75;

/**
 * Price at `multiple` R from entry, given the entry and stop. R is the
 * entry→stop distance. Long targets sit above entry, short targets below.
 * Returns null when entry/stop are missing or non-positive.
 */
export function computeRPrice(params: {
  entry: number;
  stop: number;
  direction: Direction;
  multiple: number;
}): number | null {
  const { entry, stop, direction, multiple } = params;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0) {
    return null;
  }
  const r = direction === "long" ? entry - stop : stop - entry;
  if (r <= 0) return null; // stop on the wrong side of entry
  const target = direction === "long" ? entry + multiple * r : entry - multiple * r;
  return Number(target.toFixed(2));
}

/**
 * Trailing percent for the auto-fill runner. Computed as 1R as a fraction of
 * entry price, then floored at DEFAULT_TRAIL_PERCENT so a tight stop doesn't
 * produce a claustrophobic trail that whipsaws on normal noise. A wider stop
 * still yields a wider trail - the floor only bumps up tight ones. Returns
 * null when inputs are unusable (so the caller falls back to
 * DEFAULT_TRAIL_PERCENT directly).
 */
export function computeTrailPercent(params: {
  entry: number;
  stop: number;
}): number | null {
  const { entry, stop } = params;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0) {
    return null;
  }
  const distance = Math.abs(entry - stop);
  if (distance <= 0) return null;
  const pct = (distance / entry) * 100;
  return Math.max(DEFAULT_TRAIL_PERCENT, Number(pct.toFixed(2)));
}

/**
 * Entry-price basis for the one-click plan, direction-aware so the seeded entry
 * rests on the correct side of the book:
 *  - long → best bid, where a resting buy limit joins the book;
 *  - short → best ask, where a resting sell-short limit joins the book.
 * Pricing a short at the bid would make the sell-short limit marketable against
 * the current best bid (and skew the risk-sized qty/TP), so shorts use the ask.
 * Falls back to the last trade when the direction's quote side is missing, and
 * returns null when neither is usable. Used to seed the Entry/Limit fields from
 * the loaded symbol's quote so they never carry a prior symbol's price.
 */
export function entryBasisFromQuote(params: {
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  direction?: Direction;
}): number | null {
  const { bid, ask, last, direction = "long" } = params;
  const side = direction === "short" ? ask : bid;
  if (side != null && Number.isFinite(side) && side > 0) return Number(side.toFixed(2));
  if (last != null && Number.isFinite(last) && last > 0) return Number(last.toFixed(2));
  return null;
}

/**
 * Default stop price for a direction: Low of Day for a long, High of Day for a
 * short. Returns null when the relevant bar value is missing/non-positive.
 */
export function defaultStopForDirection(params: {
  direction: Direction;
  low?: number | null;
  high?: number | null;
}): number | null {
  const { direction, low, high } = params;
  const value = direction === "long" ? low : high;
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Number(value.toFixed(2));
}

/**
 * Split a total quantity into a fixed-TP leg and a trailing runner. The TP leg
 * floors its share; the runner takes the remainder so the whole position is
 * covered. With `tpFraction` of 0 the runner takes everything (trailing-only).
 *
 * When a TP is requested (tpFraction > 0) the TP leg never drops below one
 * share. Without this, a 1-share position split 50/50 became 0 TP shares plus
 * 1 runner share, which combined with the seeded fixed stop into the invalid
 * "trailing + fixed stop + no TP" plan that errored the ticket on open.
 */
export function splitQty(
  total: number,
  tpFraction: number
): { tpQty: number; trailQty: number } {
  const qty = Math.floor(total);
  if (qty <= 0) return { tpQty: 0, trailQty: 0 };
  if (tpFraction <= 0) return { tpQty: 0, trailQty: qty };
  const tpQty = Math.min(qty, Math.max(1, Math.floor(qty * tpFraction)));
  return { tpQty, trailQty: qty - tpQty };
}

/**
 * Risk-based position size: shares = Max $ Risk / per-share risk, where
 * per-share risk is the entry→stop distance. Returns 0 when unusable.
 */
export function sizeByRisk(params: {
  maxRisk: number;
  entry: number;
  stop: number;
  direction: Direction;
}): number {
  const { maxRisk, entry, stop, direction } = params;
  if (![maxRisk, entry, stop].every(Number.isFinite) || maxRisk <= 0 || entry <= 0 || stop <= 0) {
    return 0;
  }
  if (direction === "long" && entry <= stop) return 0;
  if (direction === "short" && entry >= stop) return 0;
  const perShare = Math.abs(entry - stop);
  if (perShare <= 0) return 0;
  return Math.round(maxRisk / perShare);
}

/**
 * Size a split TP + trailing-runner plan against its combined initial risk.
 * The fixed-stop slice risks entry→stop while the runner slice risks the
 * configured trail distance from entry. Returns the largest whole-share
 * quantity whose two slices together do not exceed the dollar budget.
 */
export function sizeByExitPlanRisk(params: {
  maxRisk: number;
  entry: number;
  stop: number;
  direction: Direction;
  tpFraction: number;
  trailingPercent: number;
}): number {
  const { maxRisk, entry, stop, direction, tpFraction, trailingPercent } = params;
  if (
    ![maxRisk, entry, stop, tpFraction, trailingPercent].every(Number.isFinite) ||
    maxRisk <= 0 ||
    entry <= 0 ||
    stop <= 0 ||
    trailingPercent <= 0
  ) {
    return 0;
  }
  if (direction === "long" && entry <= stop) return 0;
  if (direction === "short" && entry >= stop) return 0;

  const fixedRiskPerShare = Math.abs(entry - stop);
  const runnerRiskPerShare = entry * (trailingPercent / 100);
  const smallestRiskPerShare = Math.min(fixedRiskPerShare, runnerRiskPerShare);
  if (smallestRiskPerShare <= 0) return 0;

  const upperBound = Math.floor(maxRisk / smallestRiskPerShare) + 1;
  for (let qty = upperBound; qty >= 1; qty -= 1) {
    const { tpQty, trailQty } = splitQty(qty, tpFraction);
    const combinedRisk =
      tpQty * fixedRiskPerShare + trailQty * runnerRiskPerShare;
    if (combinedRisk <= maxRisk + Number.EPSILON) return qty;
  }
  return 0;
}

/**
 * The single price basis used for risk math in the trade form: the price you'll
 * actually be filled at. Limit entries can opt into the OCO `entryPriceRef` or
 * limit price because that anchor IS the intended fill price. Market entries
 * should set `preferEntryAnchor: false` so hidden seeded entry values do not
 * override the live quote.
 *
 * Using one basis everywhere is what keeps the suggested size, the live risk
 * readout, and the auto-resize effect consistent. Measuring size off the entry
 * while measuring the risk readout off a different live price is exactly the
 * bug that showed "19 shares" but "you risk $1,225" on a $247 budget.
 *
 * Returns 0 when no usable price is available.
 */
export function resolveSizingPrice(params: {
  entryAnchor?: number | null;
  limitPrice?: number | null;
  liveLast?: number | null;
  preferEntryAnchor?: boolean;
}): number {
  const { entryAnchor, limitPrice, liveLast, preferEntryAnchor = true } = params;
  const candidates = preferEntryAnchor
    ? [entryAnchor, limitPrice, liveLast]
    : [liveLast];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0;
}

export function shouldShowStopSizingFeedback(params: {
  orderType: string;
  embedded: boolean;
}): boolean {
  return params.orderType === "OCO" || !params.embedded;
}

/**
 * Dollar risk taken at a given quantity - the inverse of `sizeByRisk`. Equity
 * risk is `qty * |price - stop|`; an option contract multiplies by 100. Returns
 * null when the inputs can't produce a valid stop-out loss (so callers can hide
 * the readout rather than show a misleading 0). `price` MUST come from
 * `resolveSizingPrice` so the readout matches how the size was computed.
 */
export function riskAtQty(params: {
  qty: number;
  price: number;
  stop: number;
  direction: Direction;
  isOption?: boolean;
}): number | null {
  const { qty, price, stop, direction, isOption } = params;
  if (![qty, price, stop].every(Number.isFinite) || qty <= 0 || price <= 0 || stop <= 0) {
    return null;
  }
  if (direction === "long" && price <= stop) return null;
  if (direction === "short" && price >= stop) return null;
  const perUnit = Math.abs(price - stop);
  if (perUnit <= 0) return null;
  return isOption ? qty * perUnit * 100 : qty * perUnit;
}

/** Which price fields an explicit prefill supplies FOR the next symbol. A
 *  prefill is frequently PARTIAL (a chat draft's entry anchor silently fails
 *  for a symbol with no snapshot, so "long HYPE with a stop at 40" carries a
 *  stop and nothing else), so each field is tracked separately. */
export interface StalePriceResetPrefill {
  hasEntry?: boolean;
  hasStop?: boolean;
  hasTarget?: boolean;
}

export interface StalePriceResetInput {
  /** The symbol the ticket was previously priced against. Null/empty on the
   *  first mount, when there is no prior symbol to carry stale prices from. */
  previousSymbol?: string | null;
  /** The symbol the ticket is now priced against. */
  nextSymbol?: string | null;
  /** The fields an explicit prefill (Copy Signal / chat order draft) pins for
   *  the next symbol. Only those fields are preserved; every other stale price
   *  field is still cleared. Omit when there is no prefill. */
  prefill?: StalePriceResetPrefill;
}

/** Which stale price fields to clear on a symbol change. */
export interface StalePriceResetPlan {
  /** Whether the traded symbol actually changed away from a real prior symbol. */
  shouldReset: boolean;
  /** Clear `stopMarketPrice`. */
  clearStop: boolean;
  /** Clear `entryPriceRef` + `limitPrice`. */
  clearEntry: boolean;
  /** Clear the take-profit legs (a live broker OCO/bracket leg when submitted). */
  clearTakeProfits: boolean;
  /** Clear `priceTrigger`. Never supplied by a prefill. */
  clearTrigger: boolean;
  /** Clear `trailingQty`. Never supplied by a prefill. */
  clearTrailingQty: boolean;
}

const NO_RESET: StalePriceResetPlan = {
  shouldReset: false,
  clearStop: false,
  clearEntry: false,
  clearTakeProfits: false,
  clearTrigger: false,
  clearTrailingQty: false,
};

/**
 * Resolve WHICH stale price fields to clear when the traded symbol changes.
 *
 * A partial prefill must not suppress the whole reset. `resolveSignalPrefillPlan`
 * only writes the fields it actually carries: `stopMarketPrice` when a stop is
 * present, `entryPriceRef`/`limitPrice` when an entry is present, and
 * `takeProfits` only when a stop AND a target are both present. A stop-only
 * prefill (the common chat-draft case for a symbol with no equity snapshot)
 * therefore leaves the prior symbol's take-profit row and entry/limit on the
 * ticket. Take-profits become a real broker exit leg on submit, so carrying the
 * prior symbol's target into a new symbol's order is a real-money hazard.
 *
 * This clears the COMPLEMENT of the prefill's owned fields: intentional prefill
 * values survive, everything absolute to the prior symbol goes.
 */
export function resolveStalePriceReset(
  input: StalePriceResetInput,
): StalePriceResetPlan {
  if (!shouldResetStalePriceFields(input)) return NO_RESET;
  const prefill = input.prefill;
  const hasStop = prefill?.hasStop === true;
  const hasTarget = prefill?.hasTarget === true;
  return {
    shouldReset: true,
    clearStop: !hasStop,
    clearEntry: prefill?.hasEntry !== true,
    // The prefill only owns the TP legs when it carries a stop AND a target.
    clearTakeProfits: !(hasStop && hasTarget),
    clearTrigger: true,
    clearTrailingQty: true,
  };
}

/**
 * Decide whether the manually-entered price fields (stop, take-profit target,
 * limit, entry, stop trigger) and their derived exit legs should be cleared
 * because the traded symbol changed.
 *
 * These fields hold prices that are absolute to one symbol. Carrying, say,
 * SPY's 737.35 stop onto a HYPE ticket would review and submit a HYPE order
 * against a SPY price level, a real-money hazard. The one-click auto-fill
 * reseeds these from the new symbol's live quote, but only once a quote is
 * available; a symbol with no equity quote (a crypto/perp ticker, an illiquid
 * name, after hours) never reseeds, so without this the prior symbol's prices
 * survive indefinitely.
 *
 * Returns true only when the symbol actually changed away from a real prior
 * symbol. The initial mount (no prior symbol) and a same-symbol re-render both
 * return false, so live user input is never wiped. A prefill does NOT suppress
 * the reset: it only narrows WHICH fields are cleared, which
 * `resolveStalePriceReset` decides, because a partial prefill would otherwise
 * leave the prior symbol's other price fields in place.
 */
export function shouldResetStalePriceFields(input: StalePriceResetInput): boolean {
  const previous = (input.previousSymbol ?? "").trim().toUpperCase();
  const next = (input.nextSymbol ?? "").trim().toUpperCase();
  if (!next) return false; // no target symbol yet
  if (!previous) return false; // first commit / initial mount
  if (previous === next) return false; // same-symbol re-render
  return true;
}
