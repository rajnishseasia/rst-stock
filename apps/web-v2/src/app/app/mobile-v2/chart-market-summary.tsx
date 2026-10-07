"use client";

import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  formatPerpFundingPct,
  type PerpHeaderQuote,
} from "@/components/perps/perp-format";
import { formatCompactUsd, formatPriceUsd, formatSignedNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getMobileQuoteTone } from "../mobile-market-header";

type MobileChartStockQuote = {
  last?: string | number | null;
  changePercent?: string | number | null;
  bid?: string | number | null;
  ask?: string | number | null;
  low?: string | number | null;
  high?: string | number | null;
  volume?: string | number | null;
};

type MobileChartPerpSnapshot = {
  markPx?: string | number | null;
  midPx?: string | number | null;
  bid?: string | number | null;
  ask?: string | number | null;
  prevDayPx?: string | number | null;
  funding?: string | number | null;
  dayNtlVlm?: string | number | null;
};

export interface MobileChartMarketSummaryProps {
  /** Display spelling already resolved for the active venue. */
  symbol: string;
  /** When true, the headline is the Hyperliquid mark/mid quote. */
  isPerps: boolean;
  /** The current Alpaca quote; absent while the quote is unresolved. */
  stockQuote: MobileChartStockQuote | null | undefined;
  /** The current Hyperliquid snapshot; absent while the snapshot is unresolved. */
  perpSnapshot: MobileChartPerpSnapshot | null | undefined;
  /** Existing venue formatter output, including honest '-' fallbacks. */
  perpQuote: Pick<
    PerpHeaderQuote,
    "price" | "dayChange" | "dayChangeTone" | "bidAsk" | "hasData"
  >;
  /** Keeps the chart affordance wired to the controller's existing focus path. */
  onExpand: () => void;
}

function pairedChartMetric(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): string {
  const formattedLeft = formatPriceUsd(left);
  const formattedRight = formatPriceUsd(right);
  if (formattedLeft === "-" && formattedRight === "-") return "-";
  return `${formattedLeft} / ${formattedRight}`;
}

/**
 * The mobile chart's quote block, in two columns: the large live price with
 * its 24h change on the left, and a compact right-aligned stat stack (label
 * left, value right) beside it, so the secondary numbers use the width the
 * phone has instead of a third row below.
 *
 * It deliberately consumes the shell's already-fetched quote/snapshot instead
 * of introducing a second read, and keeps every unresolved value as the
 * shared formatter's `-` fallback.
 */
export function MobileChartMarketSummary({
  symbol,
  isPerps,
  stockQuote,
  perpSnapshot,
  perpQuote,
  onExpand,
}: MobileChartMarketSummaryProps) {
  const primaryLabel = isPerps
    ? perpSnapshot?.markPx != null && perpSnapshot.markPx !== ""
      ? "Mark"
      : perpSnapshot?.midPx != null && perpSnapshot.midPx !== ""
        ? "Mid"
        : "Mark"
    : "Price";
  const primaryValue = isPerps
    ? perpQuote.price
    : formatPriceUsd(stockQuote?.last);
  const changeValue = isPerps
    ? perpQuote.dayChange
    : formatSignedNumber(stockQuote?.changePercent, "%");
  const changeTone = isPerps
    ? perpQuote.dayChangeTone
    : getMobileQuoteTone(stockQuote?.changePercent);
  const isUnresolved = isPerps ? !perpQuote.hasData : primaryValue === "-";
  // One caption names the number ("Live price", "Live mark", "Live mid"). It
  // used to be two, "Live price" and then "Price" again beside it, which
  // restated itself in the same line. Unresolved, it is just the name of the
  // number that has not arrived: "Price" is honest, "Live price" is not.
  const captionLabel = isUnresolved
    ? primaryLabel
    : `Live ${primaryLabel.toLowerCase()}`;

  return (
    <section
      data-mobile-chart-market-summary="true"
      data-mobile-chart-unresolved={isUnresolved || undefined}
      aria-label={`${symbol} market snapshot`}
      aria-live="polite"
      className="rounded-2xl border border-[#1a3a46] bg-[radial-gradient(circle_at_100%_0%,rgba(231,198,93,0.08),transparent_34%),linear-gradient(135deg,#0a202a,#06151d)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <div className="flex min-w-0 items-start justify-between gap-3 px-3.5 py-3 sm:px-4">
        <div className="min-w-0 flex-1">
          <div
            data-mobile-chart-caption="true"
            className="flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-[0.16em] text-[#78939d]"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isUnresolved
                  ? "bg-[#78939d]"
                  : "bg-[#48d597] shadow-[0_0_0_3px_rgba(72,213,151,0.14)]",
              )}
            />
            <span>{captionLabel}</span>
          </div>
          <div
            data-mobile-chart-primary-value="true"
            data-mobile-chart-primary-kind={primaryLabel.toLowerCase()}
            // Scales down one step on a narrow phone so a perp price with
            // cents ("$102,320.00") sits beside the stat stack on one line.
            className="mt-1 whitespace-normal break-all font-data text-[2.25rem] max-[430px]:text-[1.875rem] font-semibold leading-none tracking-[-0.045em] tabular-nums text-[#f4f7f8]"
          >
            {primaryValue}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              data-mobile-chart-change="true"
              className={cn(
                "whitespace-normal break-all font-data text-base font-semibold leading-tight tabular-nums",
                changeTone === "positive" && "text-[#48d597]",
                changeTone === "negative" && "text-[#f17f7a]",
                changeTone === "neutral" && "text-[#a8bdc4]",
              )}
            >
              {changeValue}
            </span>
            <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-[#78939d]">
              24h change
            </span>
          </div>
        </div>

        <div className="flex w-[44%] max-w-[10.5rem] shrink-0 flex-col items-end gap-2">
          <dl
            data-mobile-chart-metrics="true"
            className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1"
          >
            {isPerps ? (
              <>
                <MobileMetric label="Bid / Ask" value={perpQuote.bidAsk} />
                <MobileMetric
                  label="Funding / hr"
                  value={formatPerpFundingPct(perpSnapshot?.funding)}
                />
                <MobileMetric
                  label="24h Volume"
                  value={formatCompactUsd(perpSnapshot?.dayNtlVlm)}
                />
              </>
            ) : (
              <>
                <MobileMetric
                  label="Bid / Ask"
                  value={pairedChartMetric(stockQuote?.bid, stockQuote?.ask)}
                />
                <MobileMetric
                  label="Day Range"
                  value={pairedChartMetric(stockQuote?.low, stockQuote?.high)}
                />
                <MobileMetric
                  label="Volume"
                  value={
                    stockQuote?.volume == null || stockQuote.volume === ""
                      ? "-"
                      : String(stockQuote.volume)
                  }
                />
              </>
            )}
          </dl>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-mobile-chart-action="expand"
            aria-label="Expand chart"
            title="Expand chart"
            className="h-11 min-h-11 w-11 min-w-11 shrink-0 touch-manipulation rounded-xl border border-[#294b57] bg-[#0b2530]/90 text-[#a8bdc4] transition-[background-color,border-color,color,transform] hover:border-[#786529] hover:bg-[#272414] hover:text-[#f0d56c] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d] focus-visible:ring-offset-2 focus-visible:ring-offset-[#06151d]"
            onClick={onExpand}
          >
            <Maximize2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Constrains the market-scoped News/AI read to the remaining viewport on short
 * phones while preserving the larger chart-side panel on normal screens.
 *
 * Scroll chaining is deliberately left on (overscroll-auto). The box is sized
 * to the viewport, so its content routinely overflows it by only a few pixels;
 * with overscroll-contain a drag inside it was swallowed at that boundary and
 * the page underneath never moved, which read as "the positions table does not
 * scroll" on mobile.
 */
export function MobileChartInsights({ children }: { children: ReactNode }) {
  return (
    <div
      data-mobile-chart-insights="true"
      className="min-h-[min(14rem,calc(100dvh-15rem))] h-[min(420px,calc(100dvh-15rem))] max-h-[calc(100dvh-15rem)] min-w-0 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-auto rounded-2xl border border-[#183844] bg-[#04141c] [-webkit-overflow-scrolling:touch]"
    >
      {children}
    </div>
  );
}

/**
 * One row of the stat stack: label on the left, value right-aligned. Values
 * wrap rather than truncate, so a wide bid/ask pair breaks at its slash
 * instead of hiding half of itself.
 */
function MobileMetric({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="whitespace-nowrap text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 whitespace-normal text-right font-data text-xs font-semibold leading-tight tabular-nums text-[#d9e5e8] [overflow-wrap:anywhere]">
        {value}
      </dd>
    </>
  );
}
