"use client";

/**
 * PerpOrderBook: the live L2 depth ladder beside the desktop perps chart.
 *
 * We already paid for this data and threw it away. `hyperliquid.assetSnapshot`
 * has always read HL's `l2Book` and kept nothing but `bids[0].px` /
 * `asks[0].px`, so the terminal showed a top-of-book quote while the rest of
 * the ladder was discarded on the server. This renders it: both sides
 * best-first around a mid/spread row, with cumulative-depth bars, and a click
 * on any level prefills that price into the perp ticket.
 *
 * PERPS ONLY, and deliberately so. Alpaca exposes no L2 endpoint (its
 * `getLatestQuote` is NBBO top-of-book), so the stocks venue has no depth to
 * show and must not be given a fabricated one.
 *
 * DESKTOP ONLY. It is mounted from `VenueAwareChartPanel`, which lives in the
 * desktop terminal shell, and its query is additionally gated on the same
 * `xl` media query the shell switch uses so a hidden rail can never poll.
 */

import { useLayoutEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { perpDisplayCoin } from "@/components/feed/ticker-chart-action";
import {
  formatPerpPx,
  formatPerpUsd,
} from "@/components/perps/perp-format";
import {
  buildPerpBookLadder,
  formatPerpBookSpread,
  type PerpBookRow,
} from "@/components/perps/perp-order-book-rows";
import {
  DESKTOP_TERMINAL_MEDIA_QUERY,
  useMediaQuery,
} from "@/hooks/use-media-query";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export const ORDER_BOOK_COLLAPSED_KEY = "ready-set-trade.perp-order-book-collapsed.v1";

/** Levels requested per side, and the render-side row cap. */
export const PERP_ORDER_BOOK_DEPTH = 12;

/**
 * Poll cadence. HL's `l2Book` is a weight-2 read behind the shared rate
 * limiter, and one rail on screen at a time is well inside the budget. A
 * websocket subscription is the follow-up; polling is the shipped path.
 */
export const PERP_ORDER_BOOK_POLL_MS = 2_000;

export interface PerpOrderBookProps {
  /** Canonical HL coin, casing preserved (e.g. "kPEPE", "xyz:JPY"). */
  coin: string;
  /**
   * Prefill this price into the perp ticket's limit-price field. Omit to render
   * a read-only ladder (no row is focusable when nothing can consume a click).
   */
  onSelectPrice?: (px: string) => void;
  className?: string;
}

export function PerpOrderBook({
  coin,
  onSelectPrice,
  className,
}: PerpOrderBookProps) {
  // The desktop shell only mounts at `xl`, and this rail is `hidden xl:flex` on
  // top of that. Gating the query on the same breakpoint keeps the audit rule
  // literally true: nothing hidden on the current viewport polls.
  const isDesktopViewport = useMediaQuery(DESKTOP_TERMINAL_MEDIA_QUERY);

  // Collapsed state persisted in localStorage. useLayoutEffect reads it
  // synchronously before paint so the panel never flashes from expanded to
  // collapsed on every load (same pattern as the Discovery drawer).
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    setCollapsed(
      window.localStorage.getItem(ORDER_BOOK_COLLAPSED_KEY) === "true",
    );
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(ORDER_BOOK_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  const bookQuery = trpc.hyperliquid.l2Book.useQuery(
    { coin, depth: PERP_ORDER_BOOK_DEPTH },
    {
      // Also gate on !collapsed: no point polling while the rail is hidden.
      enabled: !!coin && isDesktopViewport === true && !collapsed,
      refetchInterval: PERP_ORDER_BOOK_POLL_MS,
      staleTime: PERP_ORDER_BOOK_POLL_MS,
      retry: false,
    },
  );

  const ladder = useMemo(
    () => buildPerpBookLadder(bookQuery.data, PERP_ORDER_BOOK_DEPTH),
    [bookQuery.data],
  );

  const errorMessage = bookQuery.error?.message;
  const isFirstLoad = bookQuery.isLoading && !bookQuery.data;

  // Collapsed: render a narrow strip with just a toggle to re-expand.
  if (collapsed) {
    return (
      <aside
        aria-label="Order book (collapsed)"
        className={cn(
          "hidden min-h-0 w-8 shrink-0 flex-col items-center overflow-hidden border-l bg-background xl:flex",
          className,
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Show order book"
          title="Show order book"
          onClick={toggleCollapsed}
          className="mt-1 h-7 w-7"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
        </Button>
        {/* Vertical "ORDER BOOK" label rotated so it reads top-to-bottom cleanly without clipping. */}
        <span
          aria-hidden
          className="mt-3 select-none rotate-180 whitespace-nowrap text-3xs font-semibold uppercase tracking-wide text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Order book
        </span>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Order book"
      className={cn(
        "hidden min-h-0 shrink-0 flex-col overflow-hidden border-l bg-background xl:flex xl:w-[228px] 2xl:w-[260px]",
        className,
      )}
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-2">
        <span className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
          Order book
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="truncate font-data text-3xs uppercase tabular-nums text-muted-foreground">
            {perpDisplayCoin(coin)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Hide order book"
            title="Hide order book"
            onClick={toggleCollapsed}
            className="h-5 w-5"
          >
            <ChevronRight className="size-3" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-1 border-b px-2 py-1 text-3xs uppercase tracking-wide text-muted-foreground">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      {errorMessage ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 text-2xs text-destructive">
          {errorMessage}
        </div>
      ) : isFirstLoad ? (
        <div className="min-h-0 flex-1 px-2 py-3 text-2xs text-muted-foreground">
          Loading depth…
        </div>
      ) : ladder.isEmpty ? (
        <div className="min-h-0 flex-1 px-2 py-3 text-2xs text-muted-foreground">
          No resting depth for this market yet.
        </div>
      ) : (
        <>
          {/* Asks render worst-first in the DOM and reverse visually, so the
              best ask sits against the spread row and the scroll region opens
              there rather than at the far end of the ladder. */}
          <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
            {ladder.asks.map((row) => (
              <BookLevelRow
                key={`ask-${row.px}`}
                row={row}
                side="ask"
                onSelect={onSelectPrice}
              />
            ))}
          </div>

          <div className="flex shrink-0 items-baseline justify-between gap-2 border-y bg-muted/40 px-2 py-1.5">
            <span
              className="font-data text-sm font-semibold tabular-nums"
              aria-label="Mid price"
            >
              {formatPerpUsd(ladder.mid)}
            </span>
            <span
              className="truncate font-data text-3xs tabular-nums text-muted-foreground"
              aria-label="Spread"
            >
              {formatPerpBookSpread(ladder.spread, ladder.spreadBps)}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {ladder.bids.map((row) => (
              <BookLevelRow
                key={`bid-${row.px}`}
                row={row}
                side="bid"
                onSelect={onSelectPrice}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * One ladder level. The depth bar is an absolutely positioned tint anchored to
 * the price column's outer edge, sized by the row's share of the deepest
 * cumulative size across both sides. Green and red tints only: DESIGN.md keeps
 * gold for accents, never a large fill, and a depth bar is a large fill.
 */
function BookLevelRow({
  row,
  side,
  onSelect,
}: {
  row: PerpBookRow;
  side: "bid" | "ask";
  onSelect?: (px: string) => void;
}) {
  const isBid = side === "bid";
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 right-0",
          isBid ? "bg-green-500/10" : "bg-red-500/10",
        )}
        style={{ width: `${Math.min(100, row.depthRatio * 100)}%` }}
      />
      <span
        className={cn(
          "relative truncate font-data text-2xs tabular-nums",
          isBid ? "text-green-400" : "text-red-400",
        )}
      >
        {formatPerpPx(row.px)}
      </span>
      <span className="relative truncate text-right font-data text-2xs tabular-nums text-foreground/80">
        {formatPerpPx(row.size)}
      </span>
      {/* Cumulative notional, one step down in size: it is context for the
          level, not the number the user is reading the ladder for. */}
      <span className="relative truncate text-right font-data text-3xs tabular-nums text-muted-foreground">
        {formatPerpUsd(row.cumulativeNotional)}
      </span>
    </>
  );

  const rowClassName =
    "relative grid grid-cols-3 items-center gap-1 px-2 py-[3px]";

  if (!onSelect) {
    return <div className={rowClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(row.px)}
      aria-label={`Use ${isBid ? "bid" : "ask"} price ${formatPerpPx(row.px)} as the limit price`}
      className={cn(
        rowClassName,
        "w-full text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  );
}
