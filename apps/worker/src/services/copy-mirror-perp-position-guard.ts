/**
 * PURE position-state guards for the Hyperliquid copy-mirror OPEN path.
 *
 * Split out of `copy-mirror.ts` (audit H7) so the checks that stand between an
 * automated mirror and a follower's own open position are unit-testable without
 * a client, a DB or a poller. No IO here.
 *
 * The close path has always read `listPositions` and refused a wrong-side order
 * while clamping the size to the live position. The OPEN path did neither: it
 * fetched only the asset, the mid and the balance, then issued a bare
 * `updateLeverage` followed by a non-reduce-only market order. On Hyperliquid
 * that is two distinct ways to lose the follower's money without their consent:
 *
 *  1. LEVERAGE AND MARGIN MODE ARE PER COIN AND ACCOUNT WIDE. Writing them while
 *     the follower already holds that coin re-bases the margin on the position
 *     they opened by hand and moves its liquidation price. Nobody reviewed the
 *     new profile, and nothing tells them it changed.
 *
 *  2. A NON-REDUCE-ONLY ORDER OPPOSITE AN OPEN POSITION REDUCES OR FLIPS IT.
 *     Hyperliquid nets exposure per coin, so mirroring an unrelated source SHORT
 *     while the follower is long does not open a hedge, it sells their long, and
 *     anything left over opens the other way at whatever leverage the mirror
 *     just wrote.
 *
 * Both are refusals, not corrections. The mirror has no mandate to decide what a
 * position the follower opened themselves should become, and a missed mirror
 * costs nothing while a rewritten liquidation price can cost everything. Every
 * ambiguous input therefore resolves to a skip: an unreadable size or leverage
 * is "we cannot tell", never "there is nothing there".
 */

import type { MarginMode, PerpSide } from "@trade-bot/hyperliquid";
import { isSafeTradingPerpDecimal } from "@trade-bot/utils";

/** The position fields the guard needs. Structural, so tests need no client. */
export interface PerpPositionState {
  coin: string;
  side: PerpSide;
  /** Absolute size in coin units, as the venue's decimal string. */
  size: string;
  leverage: number;
  marginMode: MarginMode;
}

export type PerpOpenGuardDecision =
  | { action: "place" }
  /**
   * The follower holds the opposite side. Placing would reduce or flip a
   * position this mirror did not open.
   */
  | { action: "skip"; reason: "opposing-position" }
  /**
   * The follower holds this coin at a different leverage or margin mode.
   * Aligning it would rewrite their liquidation price.
   */
  | { action: "skip"; reason: "leverage-conflict" }
  /** The position row exists but cannot be read, so nothing may be assumed. */
  | { action: "skip"; reason: "position-unreadable" };

/**
 * Find the follower's live position in one coin.
 *
 * Exact match on purpose: the coin string has already been through
 * `isCanonicalPerpCoin`, and a loose match could pair a HIP-3 market
 * (`xyz:GOOGL`) with the main-DEX market of the same underlying.
 */
export function findPerpPosition<T extends { coin: string }>(
  positions: readonly T[] | null | undefined,
  coin: string,
): T | null {
  if (!positions) return null;
  return positions.find((item) => item.coin === coin) ?? null;
}

/** Absolute position size, or null when the venue string is not usable. */
function readPositionSize(size: string | null | undefined): number | null {
  const raw = size?.trim() ?? "";
  if (!isSafeTradingPerpDecimal(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * May a fresh (non reduce-only) mirror open be placed against the follower's
 * live position in this coin?
 *
 * `place` means two independent things are true: the order cannot shrink or
 * invert an existing position, and the leverage/margin mode the mirror is about
 * to write is the one the coin already carries (or the coin carries no position
 * at all, so writing it re-bases nothing).
 */
export function decidePerpOpenAgainstPosition(input: {
  position: PerpPositionState | null;
  orderSide: PerpSide;
  leverage: number;
  marginMode: MarginMode;
}): PerpOpenGuardDecision {
  const { position, orderSide } = input;
  if (!position) return { action: "place" };

  const size = readPositionSize(position.size);
  // A row we cannot measure is not a flat account. Refuse rather than place an
  // order whose netting effect is unknown.
  if (size === null) return { action: "skip", reason: "position-unreadable" };
  // A zero row is genuinely flat: no exposure to reduce and no margin basis to
  // rewrite, so the open proceeds exactly as it would with no row at all.
  if (size === 0) return { action: "place" };

  if (position.side !== orderSide) {
    return { action: "skip", reason: "opposing-position" };
  }

  // Same side, so the order only adds exposure. What is left is whether the
  // leverage write that precedes it would move an existing liquidation price.
  if (!Number.isFinite(position.leverage) || position.leverage <= 0) {
    return { action: "skip", reason: "position-unreadable" };
  }
  if (position.marginMode !== "cross" && position.marginMode !== "isolated") {
    return { action: "skip", reason: "position-unreadable" };
  }
  if (
    position.leverage !== input.leverage ||
    position.marginMode !== input.marginMode
  ) {
    return { action: "skip", reason: "leverage-conflict" };
  }
  return { action: "place" };
}

/**
 * Is a stored order row's leverage safe to re-apply on a retry?
 *
 * Leverage is NOT an order field: `placeOrder` carries coin, side, size, type,
 * reduce-only, post-only, cloid and prices, and nothing else. A resumed PENDING
 * mirror therefore fills at whatever leverage the coin happens to carry at that
 * moment, which is not necessarily the clamped value the row claims. Re-applying
 * it needs an exact integer, and `?? 1` is not one: it invents a leverage the
 * clamp never produced and lets the retry proceed on it.
 */
export function resumableStoredLeverage(leverage: number | null | undefined): number | null {
  if (typeof leverage !== "number") return null;
  if (!Number.isInteger(leverage) || leverage <= 0) return null;
  return leverage;
}
