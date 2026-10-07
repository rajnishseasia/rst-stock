/**
 * PURE re-entry guards for RESUMING a PENDING Hyperliquid perp mirror.
 *
 * Split out of `copy-mirror.ts` (audit H7) so the checks that stand between a
 * retry and a real leveraged order are unit-testable without a client, a DB or a
 * poller. No IO here.
 *
 * A resume re-sends a stored intent. Everything about that intent was decided on
 * the FIRST attempt: the leverage was clamped against the ceilings in force then,
 * and the size passed the dollar cap and the free-collateral gate against a mark
 * observed then. A retry can happen hours or days later, and the resume path used
 * to trust all of it:
 *
 *  1. STORED LEVERAGE WAS RE-APPLIED WITHOUT RE-CLAMPING. The only question asked
 *     of it was "is this a positive integer", so a row written before a user
 *     lowered their copy-trading ceiling would still write its old leverage after
 *     the policy changed, and a row written before Hyperliquid cut a coin's own
 *     max leverage would write a value the venue no longer allows. A durable
 *     queue must not outlive a decision to tighten either ceiling.
 *
 *  2. NEITHER MONEY CAP WAS RE-CHECKED. The fresh open prices the order off an
 *     observed mid, brackets the fill inside the slippage band, and gates the
 *     WORST fill against the per-order dollar cap and against free collateral.
 *     The resume passed no mark at all, so the client fetched its own mid at
 *     submit time and synthesized an aggressive IoC around it. A coin that
 *     doubled while the delivery sat in the queue therefore resumed at twice the
 *     notional the cap ever approved, against collateral nobody re-measured.
 *
 * This module brings the resume to parity: re-clamp, re-price, re-check. It only
 * ever narrows. The clamp cannot raise leverage above what the row stored, and
 * every ambiguous input resolves to a skip rather than a placement. The caller
 * leaves the row PENDING on a skip, because the first attempt may already have
 * reached the venue and the reconciler is the only thing that can tell.
 *
 * Reduce-only resumes are NOT routed through here. A close can only shrink
 * exposure, so it is exempt from the open-order dollar cap and collateral
 * checks. It remains subject to the venue minimum, however, and the close path
 * defers it when its exact mark-based notional is below $10.
 */

import type { PerpSide } from "@trade-bot/hyperliquid";

import {
  perpMarketNotionalBoundsUsd,
  validatePerpVenueNotional,
  withinPerpMarginCapacity,
  MIRROR_PERP_MARKET_SLIPPAGE,
} from "./copy-mirror-perp-sizing";
import { resumableStoredLeverage } from "./copy-mirror-perp-position-guard";
import { parsePositiveDecimal, truncateDecimal } from "./copy-mirror-perp-decimal";
import {
  resolveEffectivePerpLeverage,
} from "./copy-mirror-perp-leverage";

type PerpLeveragePolicyInput = {
  sourceLeverage: unknown;
  stagedUserMaxLeverage: unknown;
  stagedFollowMaxLeverage: unknown | null | undefined;
  currentUserMaxLeverage: unknown;
  currentFollowMaxLeverage: unknown | null | undefined;
  venueMaxLeverage: unknown;
};

/**
 * Why a resume was refused. Each one is also a `MirrorProcessOutcome`, so the
 * caller returns it verbatim and the delivery records the real reason.
 */
export type PerpResumeParitySkipReason =
  | "leverage-unconfirmed"
  | "no-qty"
  | "dollar-cap"
  | "below-min-notional"
  | "margin-unavailable"
  | "insufficient-margin";

export type PerpResumeParityDecision =
  | {
      action: "resume";
      /** Leverage re-clamped against the ceilings in force NOW. Never above the stored value. */
      leverage: number;
      /** True when the ceilings have tightened since the row was written. */
      leverageWasClamped: boolean;
      /**
       * The mark the caps below were enforced against, as Hyperliquid's own
       * decimal string. Passing it to the order is the point: without it the
       * client fetches its own mid at submit time and prices the order off a
       * mark no cap has seen.
       */
      markPrice: string;
      /** Notional at that mark, for the audit trail. */
      orderDollars: number;
    }
  | { action: "skip"; reason: PerpResumeParitySkipReason };

/**
 * Re-clamp a stored leverage against the staged/current policy and venue
 * ceilings in force right now.
 *
 * Returns null rather than a fallback whenever an input cannot be trusted. The
 * The row already claims a specific leverage and a specific size, so malformed
 * persisted leverage is refused rather than invented. User policy values are
 * otherwise normalized by the shared resolver, which always chooses the least
 * leveraged safe value for an invalid required ceiling.
 *
 * The result is never above `stored`. A ceiling that has been RAISED since the
 * row was written does not entitle the retry to more leverage than the intent it
 * is resuming.
 */
export function clampResumeLeverage(
  stored: number | null | undefined,
  policy: PerpLeveragePolicyInput,
): number | null {
  const storedLeverage = resumableStoredLeverage(stored);
  if (storedLeverage === null) return null;
  return resolveEffectivePerpLeverage({ ...policy, storedOrderLeverage: storedLeverage });
}

/**
 * Hyperliquid quotes mids as plain decimal strings and the value is forwarded
 * verbatim as the order's mark price, so anything else is a shape we do not
 * understand. An unpriceable order is one we do not send.
 */
function usableMarkPrice(rawMid: unknown): number | null {
  if (typeof rawMid !== "string") return null;
  if (!parsePositiveDecimal(rawMid)) return null;
  const price = Number(rawMid);
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

/** The stored size is a venue decimal string; anything else cannot be re-priced. */
function usableSize(sizeCoin: unknown): number | null {
  if (typeof sizeCoin !== "string") return null;
  const raw = sizeCoin.trim();
  if (!parsePositiveDecimal(raw)) return null;
  const size = Number(raw);
  if (!Number.isFinite(size) || size <= 0) return null;
  return size;
}

/** Whether two positive decimal strings represent the same fixed-point value. */
function sameDecimalValue(left: string, right: string): boolean {
  const a = parsePositiveDecimal(left);
  const b = parsePositiveDecimal(right);
  if (!a || !b) return false;
  const scale = Math.max(a.scale, b.scale);
  return (
    a.coefficient * 10n ** BigInt(scale - a.scale) ===
    b.coefficient * 10n ** BigInt(scale - b.scale)
  );
}

/**
 * May a stored PENDING perp OPEN be re-placed right now, and at what leverage?
 *
 * Every policy input is read fresh by the caller: staged values from the durable
 * candidate, current user/follow values from one owned follow observation, the
 * venue maximum from the current asset, the mark from a live `allMids`, and the
 * collateral from a live clearinghouse read. Nothing here trusts the row except
 * the coin, the side, the size and the leverage it is asking to resume.
 */
export function decidePerpResumeParity(input: {
  /** `orders.leverage` as stored on the PENDING row. */
  storedLeverage: number | null | undefined;
  /** `orders.quantityDecimal` as stored on the PENDING row. */
  storedSizeCoin: string | null | undefined;
  /** The stored side, which determines the aggressive Market/IoC price. */
  side: PerpSide;
  /** Source trader leverage frozen when the candidate was staged. */
  sourceLeverage: unknown;
  /** User global cap frozen when the candidate was staged. */
  stagedUserMaxLeverage: unknown;
  /** Optional follow cap frozen when the candidate was staged. */
  stagedFollowMaxLeverage: unknown | null | undefined;
  /** User global cap read from the owned follow immediately before resume. */
  currentUserMaxLeverage: unknown;
  /** Optional follow cap read immediately before resume. */
  currentFollowMaxLeverage: unknown | null | undefined;
  /** The coin's max leverage as the venue reports it NOW. */
  venueMaxLeverage: unknown;
  /** The coin's current venue size precision. */
  sizeDecimals: number;
  /** The coin's mid from a fresh `allMids`, as Hyperliquid's own decimal string. */
  rawMid: unknown;
  /** Free CROSS collateral, or null when it could not be read. */
  freeCollateralUsd: number | null;
  /** COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS as it reads NOW. */
  maxOrderDollars: number;
  /** Slippage band pinned on the submitted order. Defaults to the mirror's own. */
  slippage?: number;
}): PerpResumeParityDecision {
  const leverage = clampResumeLeverage(input.storedLeverage, {
    sourceLeverage: input.sourceLeverage,
    stagedUserMaxLeverage: input.stagedUserMaxLeverage,
    stagedFollowMaxLeverage: input.stagedFollowMaxLeverage,
    currentUserMaxLeverage: input.currentUserMaxLeverage,
    currentFollowMaxLeverage: input.currentFollowMaxLeverage,
    venueMaxLeverage: input.venueMaxLeverage,
  });
  if (leverage === null) return { action: "skip", reason: "leverage-unconfirmed" };

  const size = usableSize(input.storedSizeCoin);
  if (size === null) return { action: "skip", reason: "no-qty" };
  // The stored quantity is immutable intent. If the venue now accepts fewer
  // decimal places, truncating it would silently change the requested value
  // (for example 0.125 -> 0.12), so refuse the resume before any venue read or
  // write. Trailing-zero-only normalization (0.120 -> 0.12) remains equivalent.
  if (!Number.isSafeInteger(input.sizeDecimals) || input.sizeDecimals < 0) {
    return { action: "skip", reason: "no-qty" };
  }
  const storedRaw = input.storedSizeCoin!.trim();
  const canonicalStored = truncateDecimal(storedRaw, input.sizeDecimals);
  if (!canonicalStored || !sameDecimalValue(storedRaw, canonicalStored)) {
    return { action: "skip", reason: "no-qty" };
  }

  const price = usableMarkPrice(input.rawMid);
  if (price === null) return { action: "skip", reason: "no-qty" };

  const bounds = perpMarketNotionalBoundsUsd(
    size,
    price,
    input.slippage ?? MIRROR_PERP_MARKET_SLIPPAGE,
  );
  if (!bounds) return { action: "skip", reason: "no-qty" };

  const venueNotional = validatePerpVenueNotional({
    sizeCoin: input.storedSizeCoin!.trim(),
    markPrice: input.rawMid as string,
    side: input.side,
    sizeDecimals: input.sizeDecimals,
    maxOrderDollars: input.maxOrderDollars,
    slippage: input.slippage ?? MIRROR_PERP_MARKET_SLIPPAGE,
  });
  if (venueNotional.action === "skip") {
    return { action: "skip", reason: venueNotional.reason };
  }
  // Unknown collateral is reported separately from insufficient collateral: one
  // is a read we could not make, the other is an answer we do not like, and an
  // operator needs to be able to tell them apart.
  if (input.freeCollateralUsd === null || !Number.isFinite(input.freeCollateralUsd)) {
    return { action: "skip", reason: "margin-unavailable" };
  }
  if (
    !withinPerpMarginCapacity({
      bounds,
      freeCollateralUsd: input.freeCollateralUsd,
      leverage,
    })
  ) {
    return { action: "skip", reason: "insufficient-margin" };
  }

  return {
    action: "resume",
    leverage,
    leverageWasClamped: leverage !== input.storedLeverage,
    markPrice: input.rawMid as string,
    orderDollars: venueNotional.notionalUsd,
  };
}
