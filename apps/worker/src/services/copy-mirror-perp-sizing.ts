/**
 * PURE sizing/margin math for the Hyperliquid copy-mirror.
 *
 * Split out of `copy-mirror.ts` (2.7k lines, audit H7) so the arithmetic that
 * decides how much leverage a follower ends up carrying is unit-testable on its
 * own. No IO, no DB, no client.
 *
 * Three things are computed here, and each one exists because the naive version
 * of it loses money:
 *
 *  1. FREE COLLATERAL, not total account value. The mirror used to size and
 *     margin-gate against `accountBalanceUsd()`, which is the account's TOTAL
 *     value including collateral already committed to open positions. A
 *     follower with $10k of value and $9.5k of it posted as margin would pass a
 *     gate that believed $10k was available, and Hyperliquid would either
 *     reject the order or (worse, on cross) accept it and push the whole
 *     account closer to liquidation. Free cross collateral is
 *     `crossMarginSummary.accountValue - crossMarginSummary.totalMarginUsed`.
 *     CROSS specifically: `marginSummary` folds in isolated positions, whose
 *     equity is locked to the asset it was allocated to and cannot back a new
 *     order. This mirrors what the follower-facing ticket already does in
 *     `apps/web-v2/src/components/trade/perp-size-presets.ts`; that copy is the
 *     reference, this one is on the automated real-money path. Keep them in
 *     agreement.
 *
 *  2. NOTIONAL BOUNDS, not one mid. A mirrored perp open is submitted as an
 *     aggressive Limit+IoC at `mark * (1 +/- slippage)` (the close path remains
 *     Market/IoC). The order therefore does not fill at the mid the cap was
 *     checked against: a long can fill up to the slippage band ABOVE it, so an
 *     order sized to exactly the per-order dollar cap can breach the cap on the
 *     fill. The hard cap uses the exact formatted payload (`size * aggressive
 *     limit`) for both sides. That bounds the request we submit; it does not
 *     claim to bound every favorable future fill price for a sell IOC, which
 *     can execute at a better price than its aggressive limit.
 *
 *  3. A VENUE MINIMUM. Hyperliquid rejects an order worth less than $10. With
 *     no lower bound, a small ratio-sized copy became a broker rejection and a
 *     REJECTED row on the real-money orders table for every such signal. The
 *     venue measures this floor at the pinned mark/reference price, so below
 *     the minimum we skip instead of submitting.
 *
 * Every function returns null (or false) rather than a fallback when an input
 * is missing or unparseable. An unknown number must never become a number that
 * permits an order.
 */

import { aggressivePrice, type PerpCrossMargin, type PerpSide } from "@trade-bot/hyperliquid";
// The venue minimum is shared with the web app, which states it on the perps
// deposit step. One definition, so the funding advice and the gate that acts
// on it can never disagree.
import { MIRROR_MIN_ORDER_NOTIONAL_USD } from "@trade-bot/types";
import { MAX_SAFE_TRADING_PERP_NUMBER } from "@trade-bot/utils";
import { parsePositiveDecimal, truncateDecimal } from "./copy-mirror-perp-decimal";

/**
 * Slippage band the mirror pins on its Market (IoC) orders.
 *
 * Same value as the wrapper's default, but passed EXPLICITLY on every mirrored
 * order so the band the cap was computed against is the band the order is
 * actually submitted with. A default that drifts in the client would silently
 * widen every guardrail here.
 */
export const MIRROR_PERP_MARKET_SLIPPAGE = 0.05;

/**
 * Share of free collateral a mirrored open is allowed to commit as margin.
 *
 * An order sized to the last cent of collateral is the one that gets rejected:
 * taker fees and the gap between mark and fill come out of the same margin. The
 * follower-facing ticket applies the same 0.5% haircut for the same reason.
 */
export const MIRROR_PERP_MARGIN_HEADROOM = 0.995;

/**
 * Free cross collateral in USD, or null when it cannot be known.
 *
 * Null rather than zero, and null rather than "just the account value": both
 * fabricate an answer, and one of them fabricates it in the direction that
 * permits an order the follower cannot actually back.
 *
 * Blank strings are checked explicitly because `Number("")` is 0, not NaN, so
 * an empty `totalMarginUsed` would sail through a finite check and report every
 * committed dollar as free.
 */
/**
 * NOT THE MIRROR'S COLLATERAL SOURCE ANY MORE. Use
 * `HyperliquidClient.perpCollateral()`, which resolves the account's
 * abstraction mode first and reads whichever ledger actually holds the money.
 *
 * This arithmetic is only correct for default/standard abstraction, where perp
 * collateral genuinely lives in the perp clearinghouse state. Under unified
 * account and portfolio margin the collateral is in spot while the perp summary
 * still reports the full margin used, so the subtraction below mixes ledgers.
 * Measured live on mainnet it produced about -1,146,830 on an account holding
 * about +2,010,430 of real free collateral.
 *
 * Kept because `perpCollateral`'s default-mode branch computes free collateral
 * the same way and these tests pin that arithmetic, and because the perp ticket
 * UI has its own analogous helper. Do not reintroduce it into a mirror sizing
 * path.
 *
 * Its former sibling `crossAccountValueUsd` was deleted rather than kept: after
 * the pct_equity base moved to `marginSummary.accountValue`, the two no longer
 * computed the same thing, so keeping a dead helper that looked like the live
 * one was an invitation to wire the wrong figure back in.
 */
export function freeCrossCollateralUsd(
  crossMargin: PerpCrossMargin | null | undefined,
): number | null {
  if (!crossMargin) return null;
  const rawValue = crossMargin.accountValueUsd?.trim() ?? "";
  const rawUsed = crossMargin.totalMarginUsedUsd?.trim() ?? "";
  if (rawValue === "" || rawUsed === "") return null;
  const accountValue = Number(rawValue);
  const marginUsed = Number(rawUsed);
  if (!Number.isFinite(accountValue) || !Number.isFinite(marginUsed)) return null;
  return accountValue - marginUsed;
}

/** The notional a mirrored Market order can actually be worth, in USD. */
export interface PerpNotionalBoundsUsd {
  /** Cheapest modeled fill of the synthesized IoC, retained for fill-risk diagnostics. */
  lowUsd: number;
  /** Most expensive fill it can produce. Gate the dollar cap and margin on this. */
  highUsd: number;
  /** Notional at the observed mark, for logging and the stored order row. */
  markUsd: number;
}

/**
 * Bracket the notional of a Market mirror around the observed mark.
 *
 * The submitted order is an IoC limit at `mark * (1 + slippage)` for a long and
 * `mark * (1 - slippage)` for a short, and it fills anywhere between that limit
 * and the touch. Rather than model each side separately (and get the sign wrong
 * once), the band is applied symmetrically: the high and low bounds describe
 * the modeled fill range for margin and fill-risk checks. The venue minimum is
 * measured independently at `markUsd`.
 *
 * Null when any input is not a usable positive finite number.
 */
export function perpMarketNotionalBoundsUsd(
  sizeCoin: number,
  markPrice: number,
  slippage: number = MIRROR_PERP_MARKET_SLIPPAGE,
): PerpNotionalBoundsUsd | null {
  if (!Number.isFinite(sizeCoin) || sizeCoin <= 0) return null;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
  if (sizeCoin > MAX_SAFE_TRADING_PERP_NUMBER || markPrice > MAX_SAFE_TRADING_PERP_NUMBER) {
    return null;
  }
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) return null;
  const markUsd = sizeCoin * markPrice;
  return {
    lowUsd: markUsd * (1 - slippage),
    highUsd: markUsd * (1 + slippage),
    markUsd,
  };
}

/** The exact size, price, and notional that the venue wrapper will submit. */
export type PerpVenueOrderNotional = {
  sizeCoin: string;
  price: string;
  notionalUsd: number;
};

export type PerpVenueNotionalValidation =
  | ({ action: "place" } & PerpVenueOrderNotional)
  | { action: "skip"; reason: "no-qty" | "below-min-notional" | "dollar-cap" };

function notionalAtLeast(
  coefficient: bigint,
  scale: number,
  minimumUsd: number,
): boolean {
  const minimum = parsePositiveDecimal(String(minimumUsd));
  if (!minimum) return false;
  const commonScale = Math.max(scale, minimum.scale);
  return (
    coefficient * 10n ** BigInt(commonScale - scale) >=
    minimum.coefficient * 10n ** BigInt(commonScale - minimum.scale)
  );
}

/**
 * Parse a configured USD cap without applying the perp size ceiling.
 *
 * `parsePositiveDecimal` deliberately rejects values above the largest safe
 * perp size (`90071992.54740991`). A USD cap is a different domain: a cap of
 * $100m is valid even though that number cannot be a single safe coin size.
 * Keep the exact comparison, but only accept ordinary safe JS decimal values
 * so scientific notation and an unsafe integer cannot become a permissive
 * fallback.
 */
function parsePositiveUsd(value: number): { coefficient: bigint; scale: number } | null {
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.trunc(value))) {
    return null;
  }
  const raw = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
}

function notionalAtMost(
  coefficient: bigint,
  scale: number,
  maximumUsd: number,
): boolean {
  const maximum = parsePositiveUsd(maximumUsd);
  if (!maximum) return false;
  return coefficient * 10n ** BigInt(maximum.scale) <=
    maximum.coefficient * 10n ** BigInt(scale);
}

/**
 * Validate the exact payload generated by the Hyperliquid Market/IoC path.
 *
 * `aggressivePrice` and venue size truncation are intentionally reused here so
 * both sides judge the same `s` and `p` that `HyperliquidClient.placeOrder`
 * sends. The mark is a required, pinned decimal: an unknown mark or an invalid
 * cap never degrades into a permissive fallback. Hyperliquid's venue minimum is
 * measured against the exact pinned mark/reference notional, while the
 * submitted-payload cap is measured independently against the exact aggressive
 * IOC limit. The cap is distinct from an unbounded favorable future fill price
 * on a sell IOC.
 */
export function validatePerpVenueNotional(input: {
  sizeCoin: string;
  markPrice: string;
  side: PerpSide;
  sizeDecimals: number;
  maxOrderDollars: number;
  slippage?: number;
}): PerpVenueNotionalValidation {
  if (
    typeof input.sizeCoin !== "string" ||
    typeof input.markPrice !== "string" ||
    (input.side !== "long" && input.side !== "short") ||
    !Number.isInteger(input.sizeDecimals) ||
    input.sizeDecimals < 0 ||
    input.sizeDecimals > 8
  ) {
    return { action: "skip", reason: "no-qty" };
  }
  if (!Number.isFinite(input.maxOrderDollars) || input.maxOrderDollars <= 0) {
    return { action: "skip", reason: "dollar-cap" };
  }
  const parsedMarkPrice = parsePositiveDecimal(input.markPrice);
  if (!parsedMarkPrice) {
    return { action: "skip", reason: "no-qty" };
  }
  const sizeCoin = truncateDecimal(input.sizeCoin, input.sizeDecimals);
  if (!sizeCoin) return { action: "skip", reason: "no-qty" };

  const slippage = input.slippage ?? MIRROR_PERP_MARKET_SLIPPAGE;
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
    return { action: "skip", reason: "no-qty" };
  }

  let price: string;
  try {
    price = aggressivePrice(input.markPrice, input.side, input.sizeDecimals, slippage);
  } catch {
    return { action: "skip", reason: "no-qty" };
  }
  const parsedSize = parsePositiveDecimal(sizeCoin);
  const parsedPrice = parsePositiveDecimal(price);
  if (!parsedSize || !parsedPrice) return { action: "skip", reason: "no-qty" };

  const coefficient = parsedSize.coefficient * parsedPrice.coefficient;
  const scale = parsedSize.scale + parsedPrice.scale;
  const notionalUsd = Number(coefficient) / 10 ** scale;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { action: "skip", reason: "no-qty" };
  }
  const markCoefficient = parsedSize.coefficient * parsedMarkPrice.coefficient;
  const markScale = parsedSize.scale + parsedMarkPrice.scale;
  if (!notionalAtLeast(markCoefficient, markScale, MIRROR_MIN_ORDER_NOTIONAL_USD)) {
    return { action: "skip", reason: "below-min-notional" };
  }

  // Validate the exact venue payload for both long and short opens. A sell IOC
  // may fill later at a more favorable price, but that does not change the
  // request cap enforced here. Reduce-only closes bypass this open-only
  // validator and remain available to unwind exposure.
  const capPrice = price;
  const parsedCapPrice = parsePositiveDecimal(capPrice);
  if (!parsedCapPrice) return { action: "skip", reason: "no-qty" };
  const capCoefficient = parsedSize.coefficient * parsedCapPrice.coefficient;
  const capScale = parsedSize.scale + parsedCapPrice.scale;
  if (!notionalAtMost(capCoefficient, capScale, input.maxOrderDollars)) {
    return { action: "skip", reason: "dollar-cap" };
  }
  return { action: "place", sizeCoin, price, notionalUsd };
}

/**
 * Is the pinned mark/reference notional still worth at least the venue minimum?
 *
 * The venue minimum is distinct from the aggressive IOC payload cap. This
 * helper remains for the close path, where the caller only has a mark-based
 * notional bound; open orders use `validatePerpVenueNotional` so their exact
 * mark and payload price are checked independently.
 */
export function meetsPerpMinimumNotional(
  bounds: PerpNotionalBoundsUsd | null,
  minimumUsd: number = MIRROR_MIN_ORDER_NOTIONAL_USD,
): boolean {
  if (!bounds) return false;
  if (!Number.isFinite(minimumUsd) || minimumUsd < 0) return false;
  return bounds.markUsd >= minimumUsd;
}

/**
 * Check a close's exact size and raw mark against the venue minimum.
 *
 * The close path receives a venue decimal string from `allMids`. Converting it
 * to a number before multiplying can round a value just below $10 upward to
 * the boundary, so keep both operands in coefficient space and fail closed on
 * malformed or unsafe input.
 */
export function meetsPerpMinimumNotionalExact(
  sizeCoin: string,
  markPrice: string,
  minimumUsd: number = MIRROR_MIN_ORDER_NOTIONAL_USD,
): boolean {
  if (typeof sizeCoin !== "string" || typeof markPrice !== "string") return false;
  if (!Number.isFinite(minimumUsd) || minimumUsd < 0) return false;
  const parsedSize = parsePositiveDecimal(sizeCoin);
  const parsedMarkPrice = parsePositiveDecimal(markPrice);
  if (!parsedSize || !parsedMarkPrice) return false;
  if (minimumUsd === 0) return true;
  return notionalAtLeast(
    parsedSize.coefficient * parsedMarkPrice.coefficient,
    parsedSize.scale + parsedMarkPrice.scale,
    minimumUsd,
  );
}

/**
 * Can the follower's FREE collateral back the worst-case fill at this leverage?
 *
 * Fails closed on every unusable input: unknown collateral (null), a
 * non-positive or non-integer leverage, or missing bounds all return false. The
 * caller skips the mirror on false; it must never treat "cannot tell" as room.
 */
export function withinPerpMarginCapacity(input: {
  bounds: PerpNotionalBoundsUsd | null;
  freeCollateralUsd: number | null;
  leverage: number;
  headroom?: number;
}): boolean {
  const { bounds, freeCollateralUsd, leverage } = input;
  const headroom = input.headroom ?? MIRROR_PERP_MARGIN_HEADROOM;
  if (!bounds) return false;
  if (freeCollateralUsd === null || !Number.isFinite(freeCollateralUsd)) return false;
  if (freeCollateralUsd <= 0) return false;
  if (!Number.isInteger(leverage) || leverage <= 0) return false;
  if (!Number.isFinite(headroom) || headroom <= 0 || headroom > 1) return false;
  const requiredMarginUsd = bounds.highUsd / leverage;
  return requiredMarginUsd <= freeCollateralUsd * headroom;
}
