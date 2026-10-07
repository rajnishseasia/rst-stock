/**
 * Pure perp sizing decisions for the copy mirror (audit H7: own module).
 *
 * These are the functions that decide HOW BIG a leveraged mirror may be, and
 * whether it may exist at all. They were lifted verbatim out of
 * `copy-mirror.ts`; nothing about their behavior changed in the move, and
 * `copy-mirror.ts` re-exports them so existing call sites and tests are
 * unaffected.
 *
 * Everything here is DB-free and broker-free on purpose: the same code the
 * worker runs against real money is the code the unit tests run.
 */

import { aggressivePrice, type PerpSide } from "@trade-bot/hyperliquid";
import { MIRROR_MIN_ORDER_NOTIONAL_USD } from "@trade-bot/types";
import { MAX_SAFE_TRADING_PERP_NUMBER } from "@trade-bot/utils";

import {
  meetsPerpMinimumNotionalExact,
  perpMarketNotionalBoundsUsd,
  validatePerpVenueNotional,
  withinPerpMarginCapacity,
  MIRROR_PERP_MARKET_SLIPPAGE,
} from "./copy-mirror-perp-sizing";
import {
  minDecimal,
  divideDecimalCeil,
  divideDecimalFloor,
  minPositiveDecimal,
  multiplyDecimal,
  parsePositiveDecimal,
  percentageDecimal,
  proportionalDecimal,
} from "./copy-mirror-perp-decimal";
import {
  mirrorIdempotencyKey,
  normalizePerpDailyCap,
  withinDailyCap,
  type SizingMode,
} from "../../../api/src/lib/copy-mirror";

export interface PerpMirrorCandidate {
  followerUserId: string;
  sourceItemId: string;
  sizingMode: SizingMode;
  sizingValue: number;
  sourceQtyDecimal?: string;
  /**
   * FREE cross collateral in USD, or null when it could not be read.
   *
   * Deliberately not the account's total value: that number includes collateral
   * already committed to open positions, and sizing a leveraged order against
   * it hands the follower exposure their remaining margin cannot carry. Null
   * means "unknown" and skips the mirror; it is never coerced to a default.
   */
  freeCollateralUsd: number | null;
  /**
   * NET EQUITY in USD, or null when it could not be read. Used ONLY as the base
   * for `pct_equity` sizing, which is defined as a percent of equity and must
   * not silently become a percent of whatever collateral happens to be free.
   * Every guard still runs against `freeCollateralUsd`.
   */
  accountValueUsd: number | null;
  price: number;
  /** The same raw mark pinned onto the Market/IoC order. */
  markPrice: string;
  side: PerpSide;
  leverage: number;
  sizeDecimals: number;
  mirrorsToday: number;
  alreadyMirrored: boolean;
  dailyCap: number;
  maxOrderDollars: number;
}

export type PerpMirrorDecision =
  | {
      action: "place";
      sizeCoin: string;
      orderDollars: number;
      clientOrderId: string;
    }
  | {
      action: "skip";
      reason:
        | "duplicate"
        | "no-qty"
        | "dollar-cap"
        | "daily-cap"
        | "insufficient-margin"
        | "margin-unavailable"
        | "below-min-notional";
      clientOrderId: string;
    };

export interface PerpReduceOnlyMirrorCandidate {
  sourceSizeDecimal: string;
  sourcePositionSizeDecimal?: string;
  mirroredExposureSizeDecimal?: string;
  sizingMode: SizingMode;
  sizingValue: number;
  orderSide: PerpSide;
  sizeDecimals: number;
  position: { side: PerpSide; size: string } | null;
  /**
   * Raw mark price to notional-check the close against, or null when it could
   * not be read. A string preserves the venue decimal exactly; number remains
   * accepted for older in-process callers. OMITTED (not just falsy) skips the
   * check entirely, for pre-existing callers/tests that never priced a close.
   *
   * Hyperliquid does not exempt reduce-only orders from its $10 minimum order
   * value (its "Error responses" page documents the rejection with no
   * reduce-only carve-out), so a copied close sized below that floor is not a
   * request the venue will ever accept. Null is treated the same as a size
   * that priced out under the floor: an unpriceable close cannot be proven
   * safe to submit, and guessing wrong here spends the follower's one-shot
   * exit on a rejection.
   */
  markPrice?: string | number | null;
}

export type PerpReduceOnlyMirrorDecision =
  | { action: "place"; sizeCoin: string }
  | { action: "skip"; reason: "no-position" | "wrong-side" | "no-qty" | "below-min-notional" };

/** Clamp a copied close to the follower's live position using fixed-point math. */
export function decidePerpReduceOnlyMirror(
  candidate: PerpReduceOnlyMirrorCandidate,
): PerpReduceOnlyMirrorDecision {
  const { position } = candidate;
  if (!position) return { action: "skip", reason: "no-position" };
  const reducingSide: PerpSide = position.side === "long" ? "short" : "long";
  if (candidate.orderSide !== reducingSide) {
    return { action: "skip", reason: "wrong-side" };
  }
  if (
    !Number.isInteger(candidate.sizeDecimals) ||
    candidate.sizeDecimals < 0 ||
    candidate.sizeDecimals > 8
  ) {
    return { action: "skip", reason: "no-qty" };
  }

  // ATTRIBUTION IS MANDATORY, in every sizing mode.
  //
  // `position.size` is what the follower holds in this coin, from every source:
  // mirrored, hand-placed in our UI, and opened directly on Hyperliquid. A
  // copied close may only ever reduce the part the mirror opened, so the
  // mirrored exposure is required before anything is placed and is a hard
  // ceiling on what is placed.
  //
  // Ratio mode used to skip this entirely and clamp only to the venue position,
  // which is the same mistake in a different place: if the paired mirrored open
  // was skipped (a leverage conflict, say) while the follower held a same-side
  // position of their own, `sourceSize * ratio` was submitted reduce-only
  // against THEIR exposure. reduceOnly stops a flip; it does not preserve
  // ownership.
  if (!candidate.mirroredExposureSizeDecimal) {
    return { action: "skip", reason: "no-qty" };
  }
  const requested = candidate.sizingMode === "ratio"
    ? multiplyDecimal(
        candidate.sourceSizeDecimal,
        Math.min(candidate.sizingValue, 10),
        candidate.sizeDecimals,
      )
    : candidate.sourcePositionSizeDecimal
      ? proportionalDecimal(
          candidate.sourceSizeDecimal,
          candidate.mirroredExposureSizeDecimal,
          candidate.sourcePositionSizeDecimal,
          candidate.sizeDecimals,
        )
      : null;
  if (!requested) return { action: "skip", reason: "no-qty" };
  // Never more than the mirror opened, and never more than actually exists.
  const ceiling = minDecimal(
    candidate.mirroredExposureSizeDecimal,
    position.size,
    candidate.sizeDecimals,
  );
  const sizeCoin = ceiling ? minDecimal(requested, ceiling, candidate.sizeDecimals) : null;
  if (!sizeCoin) return { action: "skip", reason: "no-qty" };

  // Below the venue minimum Hyperliquid rejects the order, exactly as it does
  // on the open path (see `decidePerpMirror`). The difference for a close is
  // what happens to the delivery when the order never places: the caller must
  // never let a "below-min-notional" skip retire the one-shot exit the way an
  // ordinary skip does, so this is reported as its own reason rather than
  // folded into "no-qty". `markPrice` omitted (not just falsy) means the
  // caller has not been updated to price a close yet, and the check is
  // skipped for it exactly as before.
  if (candidate.markPrice !== undefined) {
    const markPrice = candidate.markPrice === null
      ? null
      : typeof candidate.markPrice === "string"
        ? candidate.markPrice
        : String(candidate.markPrice);
    if (markPrice === null || !meetsPerpMinimumNotionalExact(sizeCoin, markPrice)) {
      return { action: "skip", reason: "below-min-notional" };
    }
  }

  return { action: "place", sizeCoin };
}

/**
 * Size a perp by the follow's configured NOTIONAL rule. Leverage controls margin
 * and liquidation risk; it never multiplies the requested exposure a second time.
 *
 * Every guard below is evaluated against what the order can actually cost, not
 * against the mid it was sized from. The mirror submits a Market order, which
 * Hyperliquid's wrapper turns into an aggressive IoC limit inside a slippage
 * band, so the fill lands somewhere in a range around the mark. The dollar cap
 * and the margin gate take the top of that range. The venue minimum is checked
 * independently against the pinned mark/reference notional, and the submitted
 * dollar cap against the exact aggressive IOC payload. See
 * `copy-mirror-perp-sizing.ts`.
 */
export function decidePerpMirror(c: PerpMirrorCandidate): PerpMirrorDecision {
  const clientOrderId = mirrorIdempotencyKey({
    followerUserId: c.followerUserId,
    sourceItemId: c.sourceItemId,
  });
  if (c.alreadyMirrored) return { action: "skip", reason: "duplicate", clientOrderId };
  if (
    !Number.isFinite(c.price) || c.price <= 0 ||
    c.price > MAX_SAFE_TRADING_PERP_NUMBER ||
    !parsePositiveDecimal(c.markPrice) ||
    Number(c.markPrice) !== c.price ||
    !Number.isFinite(c.sizingValue) || c.sizingValue <= 0 ||
    !Number.isInteger(c.leverage) || c.leverage <= 0 ||
    !Number.isInteger(c.sizeDecimals) || c.sizeDecimals < 0 || c.sizeDecimals > 8
  ) {
    return { action: "skip", reason: "no-qty", clientOrderId };
  }
  // Unknown collateral is not zero and it is not the account total. Without it
  // neither percent sizing nor the margin gate has a base it may trust.
  if (c.freeCollateralUsd === null || !Number.isFinite(c.freeCollateralUsd)) {
    return { action: "skip", reason: "margin-unavailable", clientOrderId };
  }
  if (c.freeCollateralUsd <= 0) {
    return { action: "skip", reason: "insufficient-margin", clientOrderId };
  }
  const dailyCap = normalizePerpDailyCap(c.dailyCap);
  if (dailyCap === null) {
    return { action: "skip", reason: "daily-cap", clientOrderId };
  }
  // The follower's sizing rule chooses the requested exposure. This deployment
  // guardrail is only an operator emergency ceiling; it must not be replaced by
  // the $10.55 value used for the funded local proof.
  const configuredMaxOrderDollars = String(c.maxOrderDollars);
  const effectiveMaxOrderDollars = parsePositiveDecimal(configuredMaxOrderDollars)
    ? configuredMaxOrderDollars
    : null;
  if (!effectiveMaxOrderDollars) {
    return { action: "skip", reason: "dollar-cap", clientOrderId };
  }

  let requestedSize: string | null = null;
  let limitPrice: string;
  try {
    // The requested size budget is measured at the exact, formatted IOC limit;
    // the venue minimum is checked later against the pinned mark/reference.
    limitPrice = aggressivePrice(c.markPrice, c.side, c.sizeDecimals, MIRROR_PERP_MARKET_SLIPPAGE);
  } catch {
    return { action: "skip", reason: "no-qty", clientOrderId };
  }
  if (c.sizingMode === "ratio") {
    if (!c.sourceQtyDecimal) {
      return { action: "skip", reason: "no-qty", clientOrderId };
    }
    requestedSize = multiplyDecimal(
      c.sourceQtyDecimal,
      Math.min(c.sizingValue, 10),
      c.sizeDecimals,
    );
    if (!requestedSize) return { action: "skip", reason: "no-qty", clientOrderId };
    // Ratio follows the source quantity and may only be clamped down to the
    // operator cap; it must never be upsized to reach that cap.
    const capSize = divideDecimalFloor(effectiveMaxOrderDollars, limitPrice, c.sizeDecimals);
    if (!capSize) return { action: "skip", reason: "dollar-cap", clientOrderId };
    requestedSize = minDecimal(requestedSize, capSize, c.sizeDecimals);
  } else {
    // `pct` and `pct_equity` are DIFFERENT rules and the perp path used to
    // collapse them. `pct` scales free collateral, so a follower whose margin is
    // already committed copies a proportionally smaller order rather than one
    // sized off money that is no longer available. `pct_equity` is documented
    // (and shown in Manage Follows) as a percent of NET equity, chosen exactly so
    // it does not move with the margin picture; scaling it from free collateral
    // turns "10% of equity" into a fraction of that on a working account.
    //
    // Equity only ever sets the REQUESTED size. The margin gate and the dollar
    // cap below still measure against free collateral, so a larger request is
    // refused rather than placed beyond what the account can carry.
    const percentBase = c.sizingMode === "pct_equity" ? c.accountValueUsd : c.freeCollateralUsd;
    if (c.sizingMode === "pct_equity" && (percentBase === null || !Number.isFinite(percentBase))) {
      // Unknown equity is not zero and it is not the free figure. Fail closed
      // rather than quietly sizing by a different rule than the follower chose.
      return { action: "skip", reason: "margin-unavailable", clientOrderId };
    }
    const percent = c.sizingMode === "usd"
      ? null
      : minPositiveDecimal(String(c.sizingValue), "100");
    const targetNotional = c.sizingMode === "usd"
      ? String(c.sizingValue)
      : percent
        ? percentageDecimal(String(percentBase ?? c.freeCollateralUsd), percent)
        : null;
    if (!targetNotional) {
      return { action: "skip", reason: "no-qty", clientOrderId };
    }
    const budget = minPositiveDecimal(targetNotional, effectiveMaxOrderDollars);
    if (!budget) {
      return { action: "skip", reason: "dollar-cap", clientOrderId };
    }
    requestedSize = divideDecimalFloor(budget, limitPrice, c.sizeDecimals);
  }
  if (!requestedSize) {
    return { action: "skip", reason: "no-qty", clientOrderId };
  }
  let sizeCoin = requestedSize;
  let venueNotional = validatePerpVenueNotional({
    sizeCoin,
    markPrice: c.markPrice,
    side: c.side,
    sizeDecimals: c.sizeDecimals,
    maxOrderDollars: Number(effectiveMaxOrderDollars),
    slippage: MIRROR_PERP_MARKET_SLIPPAGE,
  });

  // A non-ratio target may floor just below Hyperliquid's minimum because the
  // venue only accepts whole size increments. Compute the exact smallest
  // minimum-clearing quantity, then let the same validator enforce the cap.
  // Ratio sizing follows the source quantity and must never be upsized.
  if (
    c.sizingMode !== "ratio" &&
    venueNotional.action === "skip" &&
    venueNotional.reason === "below-min-notional"
  ) {
    const minimumSize = divideDecimalCeil(
      String(MIRROR_MIN_ORDER_NOTIONAL_USD),
      c.markPrice,
      c.sizeDecimals,
    );
    const minimumNotional = minimumSize
      ? validatePerpVenueNotional({
          sizeCoin: minimumSize,
          markPrice: c.markPrice,
          side: c.side,
          sizeDecimals: c.sizeDecimals,
          maxOrderDollars: Number(effectiveMaxOrderDollars),
          slippage: MIRROR_PERP_MARKET_SLIPPAGE,
        })
      : null;
    if (minimumNotional?.action === "place") {
      sizeCoin = minimumNotional.sizeCoin;
      venueNotional = minimumNotional;
    }
  }

  if (venueNotional.action === "skip") {
    return { action: "skip", reason: venueNotional.reason, clientOrderId };
  }

  const size = Number(sizeCoin);
  if (!Number.isFinite(size) || size <= 0) return { action: "skip", reason: "no-qty", clientOrderId };
  if (size > MAX_SAFE_TRADING_PERP_NUMBER) {
    return { action: "skip", reason: "no-qty", clientOrderId };
  }

  const bounds = perpMarketNotionalBoundsUsd(size, c.price, MIRROR_PERP_MARKET_SLIPPAGE);
  if (!bounds) return { action: "skip", reason: "no-qty", clientOrderId };
  // Fail closed when the worst-case initial margin exceeds free collateral.
  if (
    !withinPerpMarginCapacity({
      bounds,
      freeCollateralUsd: c.freeCollateralUsd,
      leverage: c.leverage,
    })
  ) {
    return { action: "skip", reason: "insufficient-margin", clientOrderId };
  }
  if (!withinDailyCap({ mirrorsToday: c.mirrorsToday, dailyCap })) {
    return { action: "skip", reason: "daily-cap", clientOrderId };
  }

  return {
    action: "place",
    sizeCoin: venueNotional.sizeCoin,
    orderDollars: venueNotional.notionalUsd,
    clientOrderId,
  };
}
