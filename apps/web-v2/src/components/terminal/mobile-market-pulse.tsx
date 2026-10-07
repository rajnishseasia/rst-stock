"use client";

/**
 * The Market pulse rankings block of the mobile Browse surface: the ranked
 * lists a signed-in user sees under Recents when the search box is empty.
 *
 * Extracted from `mobile-market-browse.tsx` (audit H7) so the block can own
 * every one of its states. Before this, `pulseQuery.data` being truthy was the
 * only gate, so an overview whose lists were all empty (quiet market, no
 * provider data yet) rendered the "Market pulse" heading over half a phone of
 * blank screen. A heading is a promise that a list follows; every branch here
 * keeps that promise or says plainly why it cannot.
 *
 * Prices only. Nothing here constructs or submits an order.
 */

import { Activity, Search } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  wrongVenueNotice,
  type MarketVenue,
  type VenueAvailability,
} from "@/lib/market-selection";
import {
  getVenueRankings,
  type MarketRankings,
} from "@/components/market-pulse/market-pulse-utils";
import type {
  MarketPulseOverview,
  MarketTile,
} from "@/components/market-pulse/market-pulse-types";

/**
 * Rows per ranking list. Six venue lists can be on screen at once in the "All"
 * browse state, so each stays short enough that scrolling reaches the next one.
 */
export const RANKING_ROWS = 5;

/** Rows in the loading skeleton: one list's worth, so it matches what lands. */
const SKELETON_ROWS = RANKING_ROWS;

/**
 * One titled group of browse rows (Recent, Stocks, Perps trending, ...).
 *
 * `note` is the venue-availability line, rendered once per section rather than
 * once per row: the trade sheet can show it under the highlighted row only,
 * but a browse list has no highlight, and repeating "Stock trading needs a
 * connected Alpaca account" under fifteen rows would bury the prices the
 * surface exists to show.
 */
export function BrowseSection({
  title,
  caption,
  note,
  trailing,
  children,
}: {
  title: string;
  caption?: string;
  note?: string | null;
  /** A node at the heading's right end (the quote-freshness status). */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} data-market-section={title} className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <h3 className="shrink-0 font-mono text-3xs font-semibold uppercase tracking-[0.16em] text-[#8aa4ad]">
          {title}
        </h3>
        <span
          aria-hidden="true"
          className="h-px flex-1 bg-gradient-to-r from-[#24434c] to-transparent"
        />
        {caption && (
          <span className="shrink-0 font-mono text-3xs tabular-nums text-[#6c8791]">
            {caption}
          </span>
        )}
        {trailing}
      </div>
      {note && (
        <p className="flex items-start gap-1.5 px-1 pb-0.5 text-2xs leading-tight text-[#d8c574]">
          <span
            aria-hidden="true"
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#d8c574]"
          />
          <span>{note}</span>
        </p>
      )}
      <ul className="divide-y divide-[#17313c]">
        {children}
      </ul>
    </section>
  );
}

function rankingLists(
  venue: MarketVenue,
  rankings: MarketRankings,
): ReadonlyArray<{ title: string; items: MarketTile[] }> {
  const label = venue === "stocks" ? "Stocks" : "Perps";
  return [
    { title: `${label} trending`, items: rankings.trending },
    { title: `${label} gainers`, items: rankings.gainers },
    { title: `${label} most active`, items: rankings.mostActive },
  ].filter((list) => list.items.length > 0);
}

/** Whether at least one visible venue has at least one ranked row to show. */
export function hasPulseRows(
  overview: MarketPulseOverview,
  { showStocks, showPerps }: { showStocks: boolean; showPerps: boolean },
): boolean {
  const venues: MarketVenue[] = [
    ...(showStocks ? (["stocks"] as const) : []),
    ...(showPerps ? (["perps"] as const) : []),
  ];
  return venues.some(
    (venue) => rankingLists(venue, getVenueRankings(overview, venue)).length > 0,
  );
}

export type MobileMarketPulseState =
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "idle";

/** Which of the block's states a query snapshot resolves to. Exported for tests. */
export function mobileMarketPulseState({
  overview,
  isLoading,
  isError,
  showStocks,
  showPerps,
}: {
  overview: MarketPulseOverview | undefined;
  isLoading: boolean;
  isError: boolean;
  showStocks: boolean;
  showPerps: boolean;
}): MobileMarketPulseState {
  if (isLoading) return "loading";
  if (overview) {
    return hasPulseRows(overview, { showStocks, showPerps }) ? "ready" : "empty";
  }
  // A failed refetch keeps stale data on screen (handled above); only a
  // failure with nothing to show becomes the error state.
  if (isError) return "error";
  return "idle";
}

/** The quote-freshness line the Browse surface computes for its rows. */
export interface MobileMarketPulseStatus {
  label: string;
  dotClassName: string;
}

/**
 * The quote-freshness status, rendered at the right end of the FIRST ranking
 * list's heading. The block used to open with a two-line "Market pulse /
 * Ranked by live activity" caption above the lists; the lists' own headings
 * ("Stocks trending", ...) already say what follows, so that row only pushed
 * the first price further down the phone. The block is still named "Market
 * pulse" for assistive technology, as a region.
 */
function PulseStatus({ status }: { status: MobileMarketPulseStatus }) {
  return (
    <span
      data-market-pulse-status="true"
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-3xs uppercase tracking-[0.08em] text-[#8ca7b1]"
      aria-live="polite"
      title={status.label}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", status.dotClassName)}
      />
      {status.label}
    </span>
  );
}

/**
 * The shape of one ranking section while it loads: a title line and five
 * two-line rows, so the screen does not jump when real rows replace them.
 */
export function MobileMarketPulseSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading market rankings"
      data-market-pulse-skeleton="true"
      className="space-y-2"
    >
      <div className="flex items-center gap-2 px-1 pt-1">
        <Skeleton className="h-3 w-24 bg-[#0b222b]" />
        <span
          aria-hidden="true"
          className="h-px flex-1 bg-gradient-to-r from-[#24434c] to-transparent"
        />
      </div>
      <ul className="divide-y divide-[#17313c]" aria-hidden="true">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <li
            key={index}
            className="flex min-h-14 items-center justify-between gap-3 px-1 py-2.5"
          >
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-3.5 w-16 bg-[#0b222b]" />
              <Skeleton className="h-2.5 w-24 bg-[#0b222b]/80" />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton className="h-3.5 w-20 bg-[#0b222b]" />
              <Skeleton className="h-2.5 w-12 bg-[#0b222b]/80" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface MobileMarketPulseProps {
  overview: MarketPulseOverview | undefined;
  isLoading: boolean;
  isError: boolean;
  showStocks: boolean;
  showPerps: boolean;
  availability: VenueAvailability;
  /** The parent's row renderer, so a pulse row routes exactly like a result row. */
  renderTile: (tile: MarketTile) => ReactNode;
  /** Re-run the rankings request. The query does not poll on its own. */
  onRetry: () => void;
  /** Quote freshness for the rows, shown on the heading line when lists render. */
  status?: MobileMarketPulseStatus | null;
}

export function MobileMarketPulse({
  overview,
  isLoading,
  isError,
  showStocks,
  showPerps,
  availability,
  renderTile,
  onRetry,
  status,
}: MobileMarketPulseProps) {
  const state = mobileMarketPulseState({
    overview,
    isLoading,
    isError,
    showStocks,
    showPerps,
  });

  let body: ReactNode;
  if (state === "loading") {
    body = <MobileMarketPulseSkeleton />;
  } else if (state === "ready" && overview) {
    const venues: MarketVenue[] = [
      ...(showStocks ? (["stocks"] as const) : []),
      ...(showPerps ? (["perps"] as const) : []),
    ];
    // The status rides on the very first heading, whichever venue leads.
    let statusPlaced = false;
    body = (
      <>
        {venues.map((venue) =>
          rankingLists(venue, getVenueRankings(overview, venue)).map(
            (list, index) => {
              const trailing =
                status && !statusPlaced ? <PulseStatus status={status} /> : null;
              if (trailing) statusPlaced = true;
              return (
                <BrowseSection
                  key={list.title}
                  title={list.title}
                  // Once per venue, on the first list only, so three consecutive
                  // rankings groups do not repeat the same connect prompt.
                  note={index === 0 ? wrongVenueNotice(venue, availability) : null}
                  trailing={trailing}
                >
                  {list.items.slice(0, RANKING_ROWS).map(renderTile)}
                </BrowseSection>
              );
            },
          ),
        )}
      </>
    );
  } else if (state === "empty") {
    body = (
      <EmptyState
        fill
        icon={Activity}
        title="No rankings yet"
        body="Rankings fill in as live trading activity comes through. Search a ticker to go straight to a market, or refresh in a moment."
        actions={[{ label: "Refresh rankings", onClick: onRetry }]}
        className="py-12"
      />
    );
  } else if (state === "error") {
    // A failed request is not the intended browse state. With retry off, a
    // rankings failure leaves no data and no loading flag, so it once rendered
    // as the ordinary "type something" prompt and the user had no idea a list
    // was supposed to be there.
    body = (
      <EmptyState
        fill
        icon={Activity}
        title="Market rankings could not be loaded"
        body="We could not reach live market data just now. Search a ticker to go straight to a market, or try again."
        actions={[{ label: "Try again", onClick: onRetry }]}
        className="py-12"
      />
    );
  } else {
    body = (
      <p className="flex items-center justify-center gap-2 border-y border-[#17313c] px-3 py-6 text-center text-xs text-[#8ba1a9]">
        <Search className="size-3.5" aria-hidden />
        Search a ticker to browse markets.
      </p>
    );
  }

  // Grows into whatever the Browse surface has left (min-height auto, so a
  // full set of rankings still scrolls the page); the empty and error states
  // are `fill`, so they center in that space instead of stacking it below.
  return (
    <div
      data-market-pulse={state}
      // Named only while it holds rankings: a region called "Market pulse"
      // over a skeleton, an empty state or an error would promise a list.
      role={state === "ready" ? "region" : undefined}
      aria-label={state === "ready" ? "Market pulse" : undefined}
      className="flex flex-1 flex-col gap-3"
    >
      {body}
    </div>
  );
}
