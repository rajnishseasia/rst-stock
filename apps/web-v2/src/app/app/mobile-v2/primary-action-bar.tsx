"use client";

/** The side a pinned primary action commits to. Venue-neutral spelling. */
export type MobilePrimaryActionSide = "long" | "short";

export interface MobilePrimaryActionBarProps {
  /** Display spelling of the market on screen, for the accessible names. */
  symbol: string;
  /** Long/Short wording on perps, Buy/Sell on stocks. */
  isPerps: boolean;
  /** Opens the existing trade sheet with the chosen side pre-selected. */
  onTrade: (side: MobilePrimaryActionSide) => void;
}

/** The two labels the bar shows for a venue. Exported so tests can assert both. */
export function mobilePrimaryActionLabels(isPerps: boolean): {
  long: string;
  short: string;
} {
  return isPerps
    ? { long: "Long", short: "Short" }
    : { long: "Buy", short: "Sell" };
}

/**
 * The chart screen's persistent primary action: a full-width Long/Short (or
 * Buy/Sell) pair pinned just above the bottom nav, reachable without
 * scrolling back to the header or opening the ticket first.
 *
 * Presentation only. Each button hands the side to the controller, which
 * pre-selects it on the same venue-aware trade sheet the header CTA opens;
 * nothing here constructs or submits an order. The bar is an in-flow sibling
 * of the shell's `main`, so it adds no scroller of its own.
 */
export function MobilePrimaryActionBar({
  symbol,
  isPerps,
  onTrade,
}: MobilePrimaryActionBarProps) {
  const labels = mobilePrimaryActionLabels(isPerps);
  // Sized to the 44px tap-target floor from DESIGN.md, not below it: the pair
  // is the loudest thing on the chart screen, so it takes the smallest height
  // that stays comfortable to hit rather than the largest that fits.
  const base =
    "min-h-11 min-w-0 touch-manipulation rounded-xl text-[15px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] transition-[background-color,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#04141b] motion-reduce:transition-none motion-reduce:active:scale-100";

  return (
    <div
      data-mobile-v2-action-bar="true"
      data-mobile-v2-action-venue={isPerps ? "perps" : "stocks"}
      role="group"
      aria-label={`Trade ${symbol}`}
      className="grid w-full min-w-0 grid-cols-2 gap-2 border-t border-[#142b34] bg-[#04141b]/97 px-3 py-1.5 backdrop-blur-xl"
    >
      <button
        type="button"
        data-mobile-primary-action="long"
        aria-label={`${labels.long} ${symbol}`}
        onClick={() => onTrade("long")}
        className={`${base} bg-[#1f9a68] hover:bg-[#23ab74] active:bg-[#1b8a5d]`}
      >
        {labels.long}
      </button>
      <button
        type="button"
        data-mobile-primary-action="short"
        aria-label={`${labels.short} ${symbol}`}
        onClick={() => onTrade("short")}
        className={`${base} bg-[#d1484f] hover:bg-[#de555c] active:bg-[#bd3f46]`}
      >
        {labels.short}
      </button>
    </div>
  );
}
