/**
 * "What do I already hold in this market?" strings for both trade tickets
 * (plan A2).
 *
 * Both tickets fetched this data and threw it away: `activeEquityPosition` was
 * computed in `use-trade-quotes.ts`, destructured in `trade-form.tsx` and never
 * rendered, and the perp ticket had no position awareness at all, so Reduce
 * Only gave no indication of what was being reduced.
 *
 * Pure string builders, kept out of the components so the venue-specific
 * semantics are asserted directly. The two venues are NOT interchangeable:
 * equities are whole shares with a dollar average entry, perps are fractional
 * coin sizes with a signed side and an adaptive-precision entry price.
 */

import { formatUsd } from "@/lib/format";
import { formatPerpPx } from "@/components/perps/perp-format";

/** Shown when the account holds nothing in this market. */
export const NO_POSITION_LABEL = "None";

/**
 * Shown when the positions request has not answered: still loading, or failed.
 *
 * Distinct from NO_POSITION_LABEL on purpose. A missing response and a
 * successful empty one are the same shape once optional chaining turns both
 * into null, so a cold ticket open (or a whole outage) told a user with an open
 * position that they held nothing, right beside the Reduce Only control.
 */
export const UNKNOWN_POSITION_LABEL = "Unknown";

/** The subset of `positions.list` rows this summary reads. */
export interface EquityPositionSummaryInput {
  qty: number;
  avgEntryPrice: number;
  /**
   * Alpaca's position side. Optional so an older caller still compiles, but a
   * SHORT that omits it renders without the "Short" prefix, so pass it.
   */
  side?: "long" | "short";
}

/**
 * "12 sh @ $145.20", or "Short 12 sh @ $145.20".
 *
 * `qty` comes back from Alpaca as a parsed float; fractional share positions are
 * real, so the count is only rendered as an integer when it genuinely is one.
 * Alpaca reports a short's `qty` as NEGATIVE, so the magnitude is what gets
 * rendered and the side carries the direction: "-12 sh" next to a Buy button is
 * ambiguous in a way "Short 12 sh" is not.
 */
export function equityPositionSummary(
  position: EquityPositionSummaryInput | null | undefined,
  options?: {
    /**
     * The positions request has answered. False while loading or after a
     * failure. Defaults true so a caller that genuinely knows stays unchanged.
     */
    settled?: boolean;
  },
): string {
  if (options?.settled === false) return UNKNOWN_POSITION_LABEL;
  if (!position || !Number.isFinite(position.qty) || position.qty === 0) {
    return NO_POSITION_LABEL;
  }
  const magnitude = Math.abs(position.qty);
  const qty = Number.isInteger(magnitude)
    ? String(magnitude)
    : String(Number(magnitude.toFixed(4)));
  const entry = Number.isFinite(position.avgEntryPrice)
    ? ` @ ${formatUsd(position.avgEntryPrice)}`
    : "";
  // Trust the sign when no side is given: a negative qty is a short either way.
  const isShort = position.side === "short" || position.qty < 0;
  return `${isShort ? "Short " : ""}${qty} sh${entry}`;
}

/** The subset of `positions.listPerps` rows this summary reads. */
export interface PerpPositionSummaryInput {
  side: "long" | "short";
  /** Absolute size in coin units, as HL's decimal string. */
  size: string;
  entryPx: string | null;
}

/**
 * "Long 0.5 @ 3,120.40". The coin is deliberately omitted: this renders inside
 * a ticket that already names the coin in its header, and repeating it costs
 * width the mobile ticket does not have.
 */
export function perpPositionSummary(
  position: PerpPositionSummaryInput | null | undefined,
  options?: {
    /** See `equityPositionSummary`. Defaults true. */
    settled?: boolean;
  },
): string {
  if (options?.settled === false) return UNKNOWN_POSITION_LABEL;
  if (!position) return NO_POSITION_LABEL;
  const size = Number(position.size);
  if (!Number.isFinite(size) || size === 0) return NO_POSITION_LABEL;
  const side = position.side === "short" ? "Short" : "Long";
  const entry =
    position.entryPx == null ? "" : ` @ ${formatPerpPx(position.entryPx)}`;
  return `${side} ${Math.abs(size)}${entry}`;
}
