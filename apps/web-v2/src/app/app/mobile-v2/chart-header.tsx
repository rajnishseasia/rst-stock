"use client";

import { ArrowLeft, CandlestickChart } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type {
  QuoteFreshnessState,
  QuoteFreshnessTone,
} from "@/lib/quote-freshness";
import { cn } from "@/lib/utils";

/** Pill colours for the quote freshness state shown beside the symbol. */
export function quoteFreshnessClass(tone: QuoteFreshnessTone): string {
  if (tone === "live") return "border-green-500/30 bg-green-500/10 text-green-300";
  if (tone === "refreshing") return "border-blue-500/30 bg-blue-500/10 text-blue-300";
  if (tone === "stale") return "border-amber-500/35 bg-amber-500/10 text-amber-300";
  if (tone === "error") return "border-red-500/35 bg-red-500/10 text-red-300";
  return "border-border bg-muted/30 text-muted-foreground";
}

export interface MobileChartHeaderProps {
  /** Display spelling of the market on screen, perp namespace stripped. */
  symbol: string;
  freshness: Pick<QuoteFreshnessState, "label" | "tone">;
  /**
   * Accessible name of the in-flow Back action, or null when the chart is the
   * Trade home (a nav tap or a cold open) and has nowhere to go back to. Null
   * hides the button rather than rendering a dead one.
   */
  backLabel: string | null;
  onBack: () => void;
  /**
   * The already-wired venue switch (Stocks | Perps), when the deployment has
   * perps. Trade is the one screen the venue changes completely (the charted
   * market, the insight tabs, the ticket the pinned pair opens), so the
   * control ends this row instead of getting a pinned bar of its own above
   * the screen. Omitted, the row is exactly what it was.
   */
  venueSwitch?: ReactNode;
}

function hasRenderableContent(content: ReactNode): boolean {
  return (
    content !== null &&
    content !== undefined &&
    content !== false &&
    content !== true &&
    content !== ""
  );
}

/**
 * How wide the inline venue switch is allowed to be.
 *
 * The two segments (icon plus label at `text-xs`) measure about 141px
 * together, so 160px seats the wider of them with room to spare rather than
 * relying on font metrics landing inside a tight box. On a 375px phone that
 * still leaves about 155px for the symbol and its freshness pill beside a
 * 44px Back button, and the symbol block wraps rather than pushing the row
 * wide. The switch brings its own 44px segment height, so hosting it here
 * never shrinks a tap target.
 */
const INLINE_VENUE_SWITCH_CLASS = "w-40 shrink-0";

/**
 * The chart screen's one dense instrument row: back (contextual only),
 * symbol, freshness, venue. The "Live chart" eyebrow went; the app bar
 * subtitle names the venue. The two-letter initials tile that used to sit
 * before the symbol went too: it restated the symbol it was next to, and read
 * as a placeholder for a market logo the app does not have.
 *
 * There is no Trade button here. The header renders only when a market
 * resolved, which is exactly the condition that pins the Buy/Sell (or
 * Long/Short) pair above the nav, so a header CTA would duplicate a control
 * already on screen, and a weaker one: the pinned pair names both sides and
 * pre-selects the one tapped.
 *
 * Presentation only. The controller decides the Back label and target and
 * owns the ticket; nothing here constructs or submits an order.
 */
export function MobileChartHeader({
  symbol,
  freshness,
  backLabel,
  onBack,
  venueSwitch,
}: MobileChartHeaderProps) {
  return (
    <div
      data-mobile-chart-header="true"
      className="flex min-w-0 items-center gap-2"
    >
      {backLabel !== null && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={backLabel}
          onClick={onBack}
          className="h-11 w-11 shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <div className="whitespace-normal break-all font-data text-lg font-semibold leading-none">
            {symbol}
          </div>
          <div
            className={cn(
              "inline-flex max-w-full whitespace-normal break-all rounded-full border px-2 py-0.5 text-3xs font-semibold leading-tight",
              quoteFreshnessClass(freshness.tone),
            )}
          >
            {freshness.label}
          </div>
        </div>
      </div>
      {hasRenderableContent(venueSwitch) ? (
        <div
          data-mobile-chart-venue="true"
          className={INLINE_VENUE_SWITCH_CLASS}
        >
          {venueSwitch}
        </div>
      ) : null}
      <h1 id="mobile-chart-screen-title" className="sr-only">
        Chart {symbol}
      </h1>
    </div>
  );
}

export interface MobileChartEmptyStateProps {
  /** Opens contextual Search. The primary offer: the fastest way to a market. */
  onSearch: () => void;
  /** Opens the Markets browse destination. */
  onBrowse: () => void;
  /**
   * The same venue switch the resolved header carries. Kept here so the one
   * screen whose content the venue selects never loses the control in the
   * state where the venue is the most likely explanation for the emptiness.
   */
  venueSwitch?: ReactNode;
}

/**
 * What the Trade home shows when no market resolves for the active venue.
 *
 * Trade is the landing screen, so it must land on something. Every path that
 * writes a symbol slot rejects an empty one and the slots default to SPY and
 * BTC, so this is a guard rather than a state the app reaches today: with no
 * market to chart, name the next action instead of painting an empty chart.
 * The shell hides the pinned Buy/Sell pair in the same condition, so there is
 * never a ticket for nothing.
 */
export function MobileChartEmptyState({
  onSearch,
  onBrowse,
  venueSwitch,
}: MobileChartEmptyStateProps) {
  return (
    <section
      aria-labelledby="mobile-chart-screen-title"
      data-mobile-chart-empty="true"
    >
      <h1 id="mobile-chart-screen-title" className="sr-only">
        Trade
      </h1>
      {hasRenderableContent(venueSwitch) ? (
        <div
          data-mobile-chart-venue="true"
          className={`${INLINE_VENUE_SWITCH_CLASS} mb-2`}
        >
          {venueSwitch}
        </div>
      ) : null}
      <EmptyState
        icon={CandlestickChart}
        title="Pick a market to trade"
        body="Search any stock or perp to open its live chart here. The Buy and Sell pair stays pinned under it."
        actions={[
          { label: "Search markets", onClick: onSearch },
          { label: "Browse markets", onClick: onBrowse, emphasis: "secondary" },
        ]}
      />
    </section>
  );
}
