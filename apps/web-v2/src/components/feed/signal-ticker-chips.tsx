"use client";

import type { ReactNode } from "react";
import { Zap } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PERPS_ENABLED } from "@/lib/perps-config";
import { ChangeBadge } from "@/components/ui/change-badge";
import {
  formatPerpChangePct,
  formatPerpPx,
} from "@/components/perps/perp-format";
import { perpBadgeLabel, type PerpCopyPayload } from "./signal-perp";
import {
  COPY_ACTION_LABEL,
  feedChartViewLabel,
  perpChartViewLabel,
  perpPrefillLabel,
  perpPrefillTitle,
  stockFromPerpPrefillTitle,
  stockPrefillLabel,
  stockPrefillTitle,
  tickerChipLabel,
} from "./ticker-chart-action";
import {
  formatSignalChipChange,
  formatSignalChipPrice,
  signalChangeTone,
} from "./signal-quote-format";

/** The quote fields a ticker chip reads. */
export interface SignalChipQuote {
  last?: string | null;
  change?: string | null;
  changePercent?: string | null;
}

/** Tooltip shown when perps are not configured for this deployment. */
export const PERPS_DISABLED_COPY_HINT = "Enable perps to copy";

/** Label on the equity escape hatch of a perp chip. */
export const TRADE_STOCK_LABEL = "Trade stock";

/** The venue mark on a perp chip. It replaced the wide "Hyperliquid Perp" badge
 *  that used to force the chip cluster off-screen (F2); the full venue name
 *  survives as its hover text, and the short tag keeps a perp row unmistakable
 *  next to an equity row for the same ticker. */
export const PERP_VENUE_LABEL = "Perp";
export const PERP_VENUE_HINT = "Hyperliquid perp";

/**
 * Outer pill of a segmented ticker chip. Holds an identity half (chart) and an
 * intent half (prefilled ticket) behind one border so they read as one object.
 *
 * `max-w-full` + a wrapping parent is what keeps a long chip (coin, direction,
 * leverage, mark, change) from side-scrolling the whole feed.
 */
function ChipShell({
  active,
  embedded,
  children,
}: {
  active: boolean;
  embedded: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-stretch overflow-hidden rounded-full border font-semibold transition-colors duration-150 motion-reduce:transition-none",
        embedded
          ? "border-border/60 bg-transparent text-muted-foreground"
          : "border-border bg-input/20 font-bold dark:bg-input/30",
        active &&
          (embedded
            ? "border-primary/50 bg-primary/10 text-foreground"
            : "border-primary bg-primary text-primary-foreground"),
      )}
    >
      {children}
    </span>
  );
}

/**
 * One half of a segmented chip. Both halves carry the mobile 44px touch target
 * (`min-h-11`) and shrink back to the terminal's dense sizing at xl.
 *
 * The contents WRAP. A perp chip carries coin, direction, leverage, mark and 24h
 * change, which does not fit on one line on a phone; wrapping to a second line
 * inside the pill is what stops it from either truncating the ticker or pushing
 * the feed sideways (F2). Each part stays `whitespace-nowrap` so a price never
 * breaks mid-number.
 */
function chipHalfClass(embedded: boolean, interactive: boolean): string {
  return cn(
    "inline-flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-2.5 py-1",
    embedded
      ? "min-h-11 text-xs xl:min-h-7 xl:px-2 xl:text-2xs"
      : "min-h-5 text-3xs",
    interactive && "cursor-pointer hover:bg-muted/40 hover:text-foreground",
  );
}

/** Hairline between the two halves, so the split is visible, not just tappable. */
function ChipDivider({ embedded }: { embedded: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "w-px self-stretch",
        embedded ? "bg-border/60" : "bg-border",
      )}
    />
  );
}

/**
 * Ticker chip for an EQUITY signal.
 *
 * Left half is the symbol (plus its live price when pills are on) and charts it.
 * Right half is Copy and prefills the stock ticket. Splitting them is F1: a tap
 * on a ticker is identity, order entry stays one deliberate tap further.
 */
export function StockCopyChip({
  symbol,
  quote,
  showPrice,
  active,
  embedded = false,
  onViewChart,
  onCopy,
}: {
  symbol: string;
  quote?: SignalChipQuote;
  showPrice: boolean;
  active: boolean;
  embedded?: boolean;
  onViewChart: () => void;
  onCopy: () => void;
}) {
  const price = formatSignalChipPrice(quote?.last);
  const tone = signalChangeTone(quote?.change);
  const changeText = formatSignalChipChange(quote?.changePercent);

  return (
    <ChipShell active={active} embedded={embedded}>
      <button
        type="button"
        onClick={onViewChart}
        aria-label={feedChartViewLabel(symbol)}
        title={feedChartViewLabel(symbol)}
        className={chipHalfClass(embedded, true)}
      >
        <span className="whitespace-nowrap">{tickerChipLabel(symbol)}</span>
        {showPrice && price && (
          <>
            <span className="font-data whitespace-nowrap tabular-nums font-semibold">
              {price}
            </span>
            {changeText && (
              <ChangeBadge
                className="whitespace-nowrap"
                text={changeText}
                tone={tone}
              />
            )}
          </>
        )}
      </button>
      <ChipDivider embedded={embedded} />
      <button
        type="button"
        onClick={onCopy}
        aria-label={stockPrefillLabel(symbol)}
        title={stockPrefillTitle(symbol)}
        className={chipHalfClass(embedded, true)}
      >
        {COPY_ACTION_LABEL}
      </button>
    </ChipShell>
  );
}

/**
 * Ticker chip for a PERP signal.
 *
 * Same identity/intent split as the equity chip, but the identity half also
 * carries everything that used to be a separate badge in a non-wrapping row: the
 * venue glyph, the direction/leverage label, and the Hyperliquid mark with its
 * 24h change (F2). Copy routes into the perps venue + perp trade form, never the
 * equity ticket; when perps are not configured (or no handler is wired) that half
 * is disabled with an "Enable perps to copy" tooltip while the chart half stays
 * usable.
 */
export function PerpCopyChip({
  coin,
  payload,
  markPx,
  prevDayPx,
  onTradeStock,
  active,
  onViewChart,
  onCopy,
  embedded = false,
}: {
  coin: string;
  payload: PerpCopyPayload;
  markPx?: string;
  prevDayPx?: string;
  onTradeStock?: () => void;
  active: boolean;
  onViewChart: () => void;
  onCopy?: () => void;
  embedded?: boolean;
}) {
  const disabled = !PERPS_ENABLED || !onCopy;
  const isShort = payload.side === "short";
  const label = perpBadgeLabel(payload.side, payload.leverage);
  const dailyChange = formatPerpChangePct(markPx, prevDayPx);

  const copyHalf = (
    <button
      type="button"
      onClick={disabled ? undefined : onCopy}
      disabled={disabled}
      aria-label={perpPrefillLabel(coin)}
      // No native title in the disabled branch: the Radix Tooltip below wraps
      // it with the same text, and both would render at once.
      title={disabled ? undefined : perpPrefillTitle(coin, label)}
      className={cn(
        chipHalfClass(embedded, !disabled),
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {COPY_ACTION_LABEL}
    </button>
  );

  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5",
        embedded && "gap-1",
      )}
    >
      <ChipShell active={active} embedded={embedded}>
        <button
          type="button"
          onClick={onViewChart}
          aria-label={perpChartViewLabel(coin)}
          title={perpChartViewLabel(coin)}
          className={chipHalfClass(embedded, true)}
        >
          <span
            title={PERP_VENUE_HINT}
            className="inline-flex shrink-0 items-center gap-0.5 text-gold"
          >
            <Zap aria-hidden="true" className="size-3" />
            <span className="text-3xs uppercase tracking-wide">
              {PERP_VENUE_LABEL}
            </span>
          </span>
          <span className="whitespace-nowrap">{tickerChipLabel(coin)}</span>
          <ChangeBadge
            className="whitespace-nowrap"
            text={label}
            tone={isShort ? "negative" : "positive"}
          />
          {markPx ? (
            <>
              <span className="font-data whitespace-nowrap tabular-nums">
                {formatPerpPx(markPx)}
              </span>
              {dailyChange.text !== "-" && (
                <ChangeBadge
                  className="whitespace-nowrap"
                  text={dailyChange.text}
                  tone={dailyChange.tone}
                />
              )}
            </>
          ) : null}
        </button>
        <ChipDivider embedded={embedded} />
        {disabled ? (
          <Tooltip>
            {/* The trigger is the wrapper, not the button: a disabled button
                fires no pointer events, so hovering it would never open the
                tooltip that explains why it is disabled. */}
            <TooltipTrigger asChild>
              <span className="inline-flex items-stretch">{copyHalf}</span>
            </TooltipTrigger>
            <TooltipContent>{PERPS_DISABLED_COPY_HINT}</TooltipContent>
          </Tooltip>
        ) : (
          copyHalf
        )}
      </ChipShell>
      {onTradeStock ? (
        <button
          type="button"
          onClick={onTradeStock}
          // The visible text alone ("Trade stock") repeats across every perp
          // chip in a card, so name the coin for screen readers.
          aria-label={stockFromPerpPrefillTitle(coin)}
          title={stockFromPerpPrefillTitle(coin)}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 px-2.5 font-semibold text-muted-foreground transition-colors hover:border-border hover:text-foreground",
            embedded
              ? "min-h-11 text-xs xl:min-h-7 xl:px-2 xl:text-2xs"
              : "min-h-5 text-3xs",
          )}
        >
          {TRADE_STOCK_LABEL}
        </button>
      ) : null}
    </span>
  );
}
