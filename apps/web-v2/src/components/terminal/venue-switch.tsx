"use client";

/**
 * The Stocks | Perps venue switch.
 *
 * This was briefly a three-way All / Stocks / Perps *filter* with a dot
 * marking the traded venue. Two things were wrong with that: "All" is not a
 * venue you can trade on, so the control could sit in a state that answered
 * neither "what am I trading" nor "what am I looking at", and the venue it
 * actually selected was communicated by a 6px dot. The app is in exactly one
 * venue at a time, so the control now says which one, and picking the other
 * switches to it.
 *
 * Behavior:
 *  - The selected segment IS the traded venue (persisted via the venue context).
 *  - Picking a segment also scopes the unified search to that venue, which is
 *    what the old filter did; the search box still resolves a symbol from the
 *    other venue when the user types one.
 *  - Hidden entirely when perps aren't configured (nothing to switch between).
 *
 * Two presentations share the control. The desktop header renders
 * `<VenueSwitch />`. Below `xl` the mobile screens that are actually
 * venue-scoped render `<VenueSwitch showLabels fill />` inside a control row
 * they already paint (see `mobile-v2/mobile-venue-scope.ts`); the `fill`
 * presentation is the flat tab strip that reads as one cell of that row.
 *
 * There is no longer a pinned mobile venue bar. It sat between the app header
 * and `main` on every destination except Markets and cost 49px of permanent
 * chrome, including on Account and Search, where nothing on the screen reads
 * the venue at all.
 */

import { CandlestickChart, Coins } from "lucide-react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useVenue } from "@/lib/venue-context";
import type { Venue } from "@/lib/venue-storage";
import { PERPS_ENABLED } from "@/lib/perps-config";
import { cn } from "@/lib/utils";

export interface VenueSwitchProps {
  className?: string;
  /**
   * Always render the segment text labels. Default keeps the original header
   * behavior (labels appear at `sm` and up, icons only below) for the cramped
   * desktop header. The mobile bar sets this so labels show on narrow phones.
   */
  showLabels?: boolean;
  /** Stretch the segments to split the available width evenly (mobile bar). */
  fill?: boolean;
}

const VENUE_ITEMS: ReadonlyArray<{
  value: Venue;
  label: string;
  Icon: typeof CandlestickChart;
}> = [
  { value: "stocks", label: "Stocks", Icon: CandlestickChart },
  { value: "perps", label: "Perps", Icon: Coins },
];

export function VenueSwitch({ className, showLabels = false, fill = false }: VenueSwitchProps) {
  const { venue, setVenue, setSearchFilter } = useVenue();

  // NEW-3: when Privy isn't configured, perps can't work, so there is nothing to
  // filter between. Hide the control entirely.
  if (!PERPS_ENABLED) {
    return null;
  }

  const labelClass = showLabels ? "inline" : "hidden sm:inline";
  // The shared toggle-group marks selection with `bg-background`, which only
  // reads as selected when the control sits directly on the page background
  // (the desktop header), so the desktop segment states selection itself.
  //
  // It used to state it with a solid gold fill plus a glow. This control lives
  // in the persistent desktop header, so that fill was the brightest object on
  // screen at all times and it outshouted every real CTA (DESIGN.md: gold is a
  // seasoning, not a sauce). The selected segment now uses the same tint
  // recipe as the chart-overlay toggles (see `overlayToggleButtonClassName` in
  // terminal-chart-panel-layout.ts): a primary-tinted wash, a primary border,
  // and primary text. Still unmistakably the chosen venue, no longer a slab.
  //
  // The full-width presentation is the mobile shell. There the switch is a
  // flat tab strip like every other mobile strip: the traded venue is
  // brighter, heavier text over a gold hairline rule (the span rendered
  // below), never a gold-filled segment. The track's `bg-muted` and the item's
  // `bg-background` are cleared so nothing reads as a pill. Kept compact at xl
  // and up in case the prop is reused in a desktop shell.
  const itemClass = cn(
    "h-8 px-2 text-xs",
    fill
      ? "group/venue relative min-h-11 flex-1 rounded-none font-medium text-[#8da5ad] hover:bg-transparent hover:text-white focus-visible:ring-inset focus-visible:ring-[#e7c65d] data-[state=on]:bg-transparent data-[state=on]:font-semibold data-[state=on]:text-white xl:min-h-0"
      : "border border-transparent data-[state=on]:border-primary/45 data-[state=on]:bg-primary/15 data-[state=on]:font-semibold data-[state=on]:text-primary",
  );

  return (
    <ToggleGroup
      type="single"
      value={venue}
      onValueChange={(next) => {
        // Radix emits "" when the active item is re-clicked; ignore, because
        // the app is always in one venue and "no venue" is not a state.
        if (next !== "stocks" && next !== "perps") return;
        setVenue(next);
        // Keep the unified search scoped to the venue being traded.
        setSearchFilter(next);
      }}
      aria-label="Trading venue"
      className={cn(
        fill && "w-full rounded-none border-b border-[#1a3b46] bg-transparent p-0",
        className,
      )}
    >
      {VENUE_ITEMS.map(({ value, label, Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={`Trade ${label.toLowerCase()}`}
          className={itemClass}
        >
          <Icon />
          <span className={labelClass}>{label}</span>
          {fill ? (
            <span
              aria-hidden="true"
              data-mobile-venue-rule="true"
              className="absolute inset-x-2.5 bottom-0 hidden h-0.5 rounded-full bg-[#e7c65d] group-data-[state=on]/venue:block"
            />
          ) : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
