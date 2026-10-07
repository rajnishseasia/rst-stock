import { formatUsd } from "@/lib/format";
import { PERP_PROTECTION_BOUNDS } from "@trade-bot/types";

/**
 * One description of the four sizing modes, shared by every surface that shows
 * them.
 *
 * Before this module the panel and the manage-follows row each carried their
 * own table. They had drifted: the same "pct" mode was captioned "of buying
 * power" in one and "of margin buying power" in the other, so the same follow
 * described its own sizing rule two different ways depending on where you
 * looked. They also rendered the mode as a bare glyph ("%", "% eq", "$", "x"),
 * which is a legend the user is expected to already know before arming
 * real-money automation.
 *
 * Mirrors SizingMode in apps/api/src/lib/copy-mirror.ts (same string values)
 * and the per-mode bounds in the API's zod superRefine.
 */
export type SizingMode = "pct" | "pct_equity" | "usd" | "ratio";

export interface SizingModePresentation {
  /** Segmented-control button text. A word, never a bare glyph. */
  label: string;
  /** What the number beside the control means, in full. */
  caption: string;
  /** Accessible name for the numeric input. */
  aria: string;
  min: number;
  max: number;
  step: number;
}

/**
 * The two modes shown in the UI selector.
 * "pct_equity" and "ratio" are hidden from new selections but the worker
 * continues to honour them for existing follows that were saved with those modes.
 */
export const SIZING_MODES: readonly SizingMode[] = [
  "pct",
  "usd",
];

export const SIZING_MODE_PRESENTATION: Record<SizingMode, SizingModePresentation> = {
  pct: {
    label: "Buying power",
    caption: "% of buying power",
    aria: "Percent of buying power per order",
    min: 0.01,
    max: 100,
    step: 1,
  },
  pct_equity: {
    label: "Net equity",
    caption: "% of net equity",
    aria: "Percent of net equity per order",
    min: 0.01,
    max: 100,
    step: 1,
  },
  usd: {
    label: "Dollars",
    caption: "dollars per order",
    aria: "Dollars per order",
    min: 0.01,
    max: 1_000_000,
    step: 50,
  },
  ratio: {
    label: "Multiple",
    caption: "x the source trader's quantity",
    aria: "Multiple of the source trader's quantity per order",
    min: 0.01,
    max: 10,
    step: 0.1,
  },
};

/**
 * One order's size as a whole phrase, for confirmation copy.
 *
 * Deliberately spells out the unit rather than pairing a number with a glyph:
 * this is the sentence a user reads immediately before agreeing to let the
 * worker place orders without asking again.
 *
 * VENUE-AWARE, because one `sizing_mode` column means two different bases.
 * `pct` is the only mode that differs, and it differs completely:
 *
 *  - Alpaca: `computeMirrorQty` (apps/api/src/lib/copy-mirror.ts) multiplies
 *    `account.buying_power`, which is margin-inflated to 2x-4x equity.
 *  - Hyperliquid: `decidePerpMirror`
 *    (apps/worker/src/services/copy-mirror-perp-decisions.ts) multiplies FREE
 *    CROSS COLLATERAL (`freeCrossCollateralUsd` = account value minus margin
 *    already committed) and takes the product as the order's target NOTIONAL.
 *    Nothing there is inflated, and the number is the size of the position
 *    rather than the margin posted behind it.
 *
 * This sentence used to be venue-blind, so a follower arming one follow on each
 * venue at `pct` = 10 read "10% of your buying power" twice for two rules that
 * place very different orders off the same $10,000. Reading it off their Alpaca
 * follow, the honest next move is to raise the perp percentage until the size
 * matches, which walks the perp order toward committing all of the free
 * collateral, sized by a phrase that on that venue names neither the base nor
 * the exposure.
 *
 * The other three modes are NOT reworded: `pct_equity` multiplies net equity on
 * both venues (`account.equity` / `accountValueUsd`), `usd` is the target
 * notional on both, and `ratio` scales the source trader's own quantity on
 * both. Inventing a venue difference there would be as wrong as hiding this one.
 *
 * `provider` is optional and an unknown destination keeps the Alpaca wording: a
 * follow can only be armed against a resolved credential (`buildAutoMirrorPatch`
 * refuses without one, and the switch blocks on it), so the default is read
 * against an Alpaca destination or against a dialog that can place nothing.
 */
export function describeSizePerOrder(
  mode: SizingMode,
  value: number,
  provider?: "alpaca" | "hyperliquid" | null,
  maxTradeSize?: number | null,
): string {
  if (!Number.isFinite(value)) return "an unreadable size";
  let base: string;
  if (mode === "pct") {
    // "not of buying power" is stated out loud rather than left to inference:
    // the basis tab beside this sentence is still labelled "Buying power" from
    // the shared SIZING_MODE_PRESENTATION table, so a perp follower reads that
    // label on the same screen and has to be told it does not describe their
    // destination.
    base = provider === "hyperliquid"
      ? `${value}% of your free collateral (account value minus the margin already committed), not of buying power, taken as the position's notional size`
      : `${value}% of your buying power`;
  } else if (mode === "pct_equity") {
    base = `${value}% of your net equity`;
  } else if (mode === "usd") {
    base = `${formatUsd(value)} of notional`;
  } else {
    base = `${value}x the source trader's quantity`;
  }
  if (maxTradeSize && Number.isFinite(maxTradeSize) && maxTradeSize > 0) {
    return `${base}, capped at ${formatUsd(maxTradeSize)} per trade`;
  }
  return base;
}


// ============================================
// The automatic exit on a Hyperliquid follow
// ============================================

/** A follow's configured perp exit, as the follows list returns it. */
export interface PerpProtectionRuleView {
  takeProfitPct: number | null;
  stopLossPct: number | null;
}

/**
 * Input bounds for the two exit fields, re-exported from the shared constant the
 * API validates against rather than retyped here.
 *
 * The sizing table above keeps its own copy of its bounds and that has always
 * been a latent drift; this one does not repeat the mistake. A UI that allowed a
 * number the router rejects would let a follower believe they had set a stop
 * that was never stored.
 */
export const PERP_PROTECTION_PRESENTATION = {
  takeProfit: {
    label: "Take profit",
    caption: "% of margin gained",
    aria: "Take profit as a percent of the margin behind the position",
    ...PERP_PROTECTION_BOUNDS.takeProfitPct,
    step: 5,
  },
  stopLoss: {
    label: "Stop loss",
    caption: "% of margin lost",
    aria: "Stop loss as a percent of the margin behind the position",
    ...PERP_PROTECTION_BOUNDS.stopLossPct,
    step: 5,
  },
} as const;

/**
 * What a follower is told happens with no exit configured.
 *
 * True of the worker as it stands, and it is the state every follow is in until
 * someone sets a number: `parsePerpProtectionRule`
 * (apps/worker/src/services/copy-mirror-perp-protection.ts) returns null when
 * both columns are null, and the attach then makes no venue call at all.
 *
 * The second sentence is the part that matters and the part the product used to
 * leave unsaid. A mirror opened from an X or paste.trade signal has no source
 * that ever closes, so "unless the trader closes" is, for those, "never".
 */
export const NO_PERP_PROTECTION_SENTENCE =
  "None. Nothing is attached to close this position. It is reduced only if the trader you follow closes and that close is copied to your account, which for a position copied from a signal post never happens.";

/**
 * One sentence describing the exit a follow will attach, or null when it has
 * none.
 *
 * PERCENT OF MARGIN is named explicitly every time, and the price move it works
 * out to is not, because that number is not knowable here: it depends on the
 * leverage the SOURCE trader uses on the trade being copied, which nobody knows
 * until the mirror places. Saying "25%" without naming the base would be read as
 * a price move, which at 20x is twenty times the risk the follower agreed to.
 */
export function describePerpProtection(rule: PerpProtectionRuleView): string | null {
  const takeProfit =
    rule.takeProfitPct !== null && Number.isFinite(rule.takeProfitPct)
      ? `take profit at +${rule.takeProfitPct}% of the margin behind the position`
      : null;
  const stopLoss =
    rule.stopLossPct !== null && Number.isFinite(rule.stopLossPct)
      ? `stop out at -${rule.stopLossPct}% of the margin behind the position`
      : null;
  if (!takeProfit && !stopLoss) return null;
  const legs = [stopLoss, takeProfit].filter((leg): leg is string => leg !== null);
  return `${legs.join(", and ")}. Measured against your margin, not against the price, so the risk is the same whatever leverage the trade is copied at.`;
}
