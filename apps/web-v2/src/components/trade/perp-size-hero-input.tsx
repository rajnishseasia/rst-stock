"use client";

/**
 * The perp ticket's size entry as one large hero input instead of two equal
 * h-10 fields. Extracted to its own file because perp-trade-form.tsx is past
 * the H7 ceiling; the form keeps ownership of the react-hook-form field, the
 * USD<->coin sync effects and the preset chips, and this component is layout
 * only.
 *
 * Both units remain directly editable: the hero shows one at a time and the
 * caption underneath is a real button that swaps which unit is the hero. The
 * non-hero value keeps flowing through the form's existing sync handlers, so
 * flipping never converts or rounds anything itself.
 */

import { useState } from "react";
import { ArrowUpDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatUsd } from "@/lib/format";

/**
 * The equity ticket's Amount hero classes (trade-form.tsx), verbatim, so the
 * two tickets read as one system. text-3xl clears the iOS 16px no-zoom floor
 * on its own, so no TICKET_INPUT_TEXT_* stack is needed here (see
 * ticket-input-text.ts for why the smaller fields need one).
 */
const HERO_INPUT_CLASS =
  "h-14 rounded-lg border-border/80 bg-background/70 px-3 font-data text-3xl font-semibold tabular-nums";

export type PerpSizeHeroUnit = "usd" | "coin";

export interface PerpSizeHeroInputProps {
  /** Display spelling of the coin (kPEPE, not KPEPE). */
  displayCoin: string;
  /** The USD notional input string, owned by the form's local state. */
  usdValue: string;
  /** The coin size input string, owned by the form's sizeCoin field. */
  coinValue: string;
  /** Current notional in USD, for the caption when the coin is the hero. */
  notionalUsd: number;
  invalid: boolean;
  onUsdChange: (raw: string) => void;
  onCoinChange: (raw: string) => void;
  onCoinBlur: () => void;
}

export function PerpSizeHeroInput({
  displayCoin,
  usdValue,
  coinValue,
  notionalUsd,
  invalid,
  onUsdChange,
  onCoinChange,
  onCoinBlur,
}: PerpSizeHeroInputProps) {
  // USD-first: sizing a leveraged position in dollars is the common intent;
  // the exact coin size is the derived detail.
  const [heroUnit, setHeroUnit] = useState<PerpSizeHeroUnit>("usd");
  const usdIsHero = heroUnit === "usd";

  // The caption mirrors the NON-hero unit from the same synced values the two
  // old inputs showed, so nothing is re-derived here. Coin size is the form's
  // own input string (already rounded by the blur handler); the USD side is a
  // display amount and stays on formatUsd (M16).
  const caption = usdIsHero
    ? `≈ ${coinValue.trim() || "0"} ${displayCoin}`
    : `≈ ${formatUsd(notionalUsd > 0 ? notionalUsd : 0)}`;

  return (
    <div className="space-y-1">
      <div className="relative min-w-0">
        {usdIsHero ? (
          <Input
            inputMode="decimal"
            placeholder="0.00"
            aria-label="Size in USD notional"
            aria-invalid={invalid}
            value={usdValue}
            onChange={(e) => onUsdChange(e.target.value)}
            className={`${HERO_INPUT_CLASS} pr-14`}
          />
        ) : (
          <Input
            inputMode="decimal"
            placeholder="0.0"
            aria-label={`Size in ${displayCoin}`}
            aria-invalid={invalid}
            value={coinValue}
            onChange={(e) => onCoinChange(e.target.value)}
            onBlur={onCoinBlur}
            className={`${HERO_INPUT_CLASS} pr-16`}
          />
        )}
        <span className="pointer-events-none absolute inset-y-0 right-3 flex max-w-14 items-center truncate text-2xs font-semibold text-muted-foreground">
          {usdIsHero ? "USD" : displayCoin}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setHeroUnit(usdIsHero ? "coin" : "usd")}
        aria-label={`Switch size entry to ${usdIsHero ? displayCoin : "USD"}`}
        className="inline-flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ArrowUpDown className="size-3" aria-hidden />
        <span className="font-data tabular-nums">{caption}</span>
      </button>
    </div>
  );
}
