/**
 * The size quick-fill chips on the perp ticket ("25% / 50% / 75% / Max").
 *
 * Hyperliquid lets you express an order as a share of something rather than as
 * a number you work out yourself. The ticket already accepts a direct USD
 * notional, so "buy $500" is covered; what was missing is the percentage, and
 * the percentage is the harder one to do in your head because what it is a
 * percentage OF changes with the order.
 *
 * There is exactly one rule, so the chips mean the same thing every time you
 * look at them:
 *
 *   Reduce Only ON  -> a percentage of the position you already hold.
 *   Reduce Only OFF -> a percentage of what you could open right now.
 *
 * The second is where this can lie, and lying here costs real money, so the
 * inputs are worth stating precisely. Per Hyperliquid's margining docs the
 * margin to open is `position_size * mark_price / leverage`, which this
 * inverts. What backs it is `crossMarginSummary.accountValue` minus
 * `crossMarginSummary.totalMarginUsed`:
 *
 *  - CROSS, not `marginSummary`. The latter's totals fold in isolated
 *    positions, whose equity is locked to the asset it was allocated to and
 *    cannot back a new order. Opening an isolated position draws from this
 *    same free cross collateral, so one number is right for both modes.
 *  - NOT `withdrawable`, though it looks like the obvious field. Its rule is
 *    `max(initial_margin_required, 0.1 * total_position_value)`, a transfer
 *    floor stricter than the constraint on opening, so it understates capacity
 *    for anyone running above 10x.
 *  - NOT the ticket's Balance cell, which is total USDC collateral including
 *    margin already committed (see the comment on that cell in
 *    perp-trade-form.tsx).
 *
 * KNOWN LIMIT: Hyperliquid's max leverage is tiered by notional (BTC 40x to
 * $150M then 20x, many altcoins 10x to $20M then 5x). The asset snapshot
 * reports the tier-1 figure, so a Max sized at that leverage could in principle
 * land in a lower tier. It binds only in the tens of millions of notional, and
 * is called out here rather than modelled.
 *
 * When any input is unknown the chips refuse to guess and say which one.
 *
 * PURE. No React, no IO.
 */

import { roundSizeToDecimals } from "./perp-form-math";

/** The offered percentages. 100 renders as "Max". */
export const PERP_SIZE_PRESET_PERCENTS = [25, 50, 75, 100] as const;

export type PerpSizePresetPercent = (typeof PERP_SIZE_PRESET_PERCENTS)[number];

/**
 * Share of free collateral a preset is allowed to commit when OPENING.
 *
 * A "Max" computed from the last cent of collateral is the one that gets
 * rejected: taker fees and the gap between mark and fill both come out of the
 * same margin, so an order sized to exactly 100% is short by the time it
 * reaches the book. The haircut applies to the capacity itself rather than
 * only to the Max chip, so every chip stays a true percentage of one number.
 *
 * Closing is exact and gets no haircut: a full close is a full close, and fees
 * on it are settled against the position being closed, not against new
 * exposure.
 */
export const PERP_CAPACITY_HEADROOM = 0.995;

export type PerpSizeBasis =
  | {
      kind: "reduce";
      /** Coin size the 100% chip fills in: the whole open position. */
      maxCoinSize: number;
      /** What the percentages are OF, for the caption under the chips. */
      caption: string;
    }
  | {
      kind: "open";
      maxCoinSize: number;
      maxNotionalUsd: number;
      caption: string;
    }
  | {
      kind: "unavailable";
      /** Short, user-facing, and specific about WHICH input we are missing. */
      reason: string;
    };

export interface PerpSizeBasisInput {
  reduceOnly: boolean;
  /** The open position in THIS coin, or null when there is none. */
  position: { size: string } | null;
  /**
   * Whether the positions read is KNOWLEDGE.
   *
   * Must come from `isSuccess`, never `isFetched`: with retry off a failed
   * request is fetched too, and a failure is not evidence that the account
   * holds nothing. Sizing off a failed read would offer a Max built on a
   * position list we never actually received.
   */
  positionsSettled: boolean;
  /**
   * `crossMarginSummary` from the positions read, or null while unknown (the
   * read has not landed, or the response carried no usable summary).
   */
  crossMargin: { accountValueUsd: string; totalMarginUsedUsd: string } | null;
  markPrice: number;
  leverage: number;
}

/**
 * Free cross collateral, or null when the summary is missing or unreadable.
 *
 * Null rather than zero, and null rather than "just the account value": both
 * of those fabricate an answer, and one of them fabricates it in the direction
 * that produces an order Hyperliquid rejects.
 */
export function freeCrossCollateralUsd(
  crossMargin: { accountValueUsd: string; totalMarginUsedUsd: string } | null,
): number | null {
  if (crossMargin === null) return null;
  // Blank is checked explicitly: `Number("")` is 0, not NaN, so an empty
  // totalMarginUsed would sail through a finite check and report every
  // committed dollar as free.
  const rawValue = crossMargin.accountValueUsd?.trim() ?? "";
  const rawUsed = crossMargin.totalMarginUsedUsd?.trim() ?? "";
  if (rawValue === "" || rawUsed === "") return null;
  const accountValue = Number(rawValue);
  const marginUsed = Number(rawUsed);
  if (!Number.isFinite(accountValue) || !Number.isFinite(marginUsed)) return null;
  return accountValue - marginUsed;
}

/** What the chips scale, and whether they can be offered at all. */
export function resolvePerpSizeBasis(input: PerpSizeBasisInput): PerpSizeBasis {
  const {
    reduceOnly,
    position,
    positionsSettled,
    crossMargin,
    markPrice,
    leverage,
  } = input;

  if (reduceOnly) {
    // No mark price needed: reducing is expressed purely in coin size.
    if (!positionsSettled) {
      return { kind: "unavailable", reason: "Checking your position" };
    }
    const size = position === null ? 0 : Math.abs(Number(position.size));
    if (!Number.isFinite(size) || size <= 0) {
      return { kind: "unavailable", reason: "No open position to reduce" };
    }
    return { kind: "reduce", maxCoinSize: size, caption: "of position" };
  }

  const free = freeCrossCollateralUsd(crossMargin);
  if (free === null) {
    return { kind: "unavailable", reason: "Checking your margin" };
  }
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    return { kind: "unavailable", reason: "Waiting for a mark price" };
  }
  if (!Number.isFinite(leverage) || leverage <= 0) {
    return { kind: "unavailable", reason: "Waiting for leverage" };
  }
  if (free <= 0) {
    return { kind: "unavailable", reason: "No free collateral" };
  }

  const maxNotionalUsd = free * PERP_CAPACITY_HEADROOM * leverage;
  return {
    kind: "open",
    maxCoinSize: maxNotionalUsd / markPrice,
    maxNotionalUsd,
    caption: "of buying power",
  };
}

/**
 * The coin size a chip fills in, as the string the size field holds.
 *
 * Truncated to `szDecimals` by `roundSizeToDecimals`, which rounds DOWN. That
 * direction is the safe one for both modes: an opening order cannot round its
 * way past available margin, and a closing order cannot round its way into
 * reducing more than is held.
 */
export function perpPresetCoinSize(
  basis: PerpSizeBasis,
  percent: PerpSizePresetPercent,
  szDecimals: number,
): string {
  if (basis.kind === "unavailable") return "";
  const size = (basis.maxCoinSize * percent) / 100;
  const rounded = roundSizeToDecimals(size, szDecimals);
  // "0" is what roundSizeToDecimals returns for a size below one tick. Handing
  // that to the field would render a zero the user did not choose and fail
  // validation on submit; an empty string leaves the field as it was.
  return rounded === "0" ? "" : rounded;
}

/** Chip text. 100 is "Max" rather than "100%": the headroom makes it not exactly 100. */
export function perpPresetLabel(percent: PerpSizePresetPercent): string {
  return percent === 100 ? "Max" : `${percent}%`;
}
