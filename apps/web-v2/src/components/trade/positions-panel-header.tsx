"use client";

/**
 * The positions-panel header, shared by BOTH venues.
 *
 * Stocks and perps used to draw their own chrome: the equity panel had a
 * titled card header with an Open | Closed segmented control and a
 * Date | P&L | Value sort, and the perps table had no header at all (its
 * closed round-trips lived on a separate drawer sub-tab, and there was no way
 * to reach them from the positions view). The two read as different products.
 *
 * This is the single header both panels render, so the controls, the spacing
 * and the states are identical by construction rather than by convention.
 * Anything venue-specific (the count/P&L line, the collapse button the
 * standalone equity card still owns) arrives as a prop.
 */

import type { ReactNode } from "react";

import { CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Sort order shared by the open list and the closed history of both venues. */
export type PositionsSortKey = "date" | "pnl" | "value";

export const POSITIONS_SORT_KEYS: readonly PositionsSortKey[] = [
  "date",
  "pnl",
  "value",
] as const;

export function positionsSortLabel(key: PositionsSortKey): string {
  return key === "pnl" ? "P&L" : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Narrow a persisted value back to a sort key ("date" is the default). */
export function parsePositionsSort(value: string | null): PositionsSortKey {
  return value === "pnl" || value === "value" ? value : "date";
}

export function PositionsPanelHeader({
  embedded = false,
  showClosed,
  onShowClosedChange,
  sortBy,
  onSortByChange,
  description,
  collapseAction,
}: {
  /** Terminal/drawer presentation (borderless, tighter, taller touch targets). */
  embedded?: boolean;
  showClosed: boolean;
  onShowClosedChange: (showClosed: boolean) => void;
  sortBy: PositionsSortKey;
  onSortByChange: (sortBy: PositionsSortKey) => void;
  /** The venue's own summary line (count, total P&L, or a loading/empty state). */
  description: ReactNode;
  /** The standalone (non-embedded) equity card's collapse toggle. */
  collapseAction?: ReactNode;
}) {
  const buttonSize = embedded
    ? "h-11 px-3 @[560px]/card-header:h-7 @[560px]/card-header:px-2.5 @[560px]/card-header:py-1"
    : "px-2.5 py-1 text-xs";

  return (
    <CardHeader className={cn("pb-2", embedded && "@container/card-header shrink-0 border-b !px-3 !py-2")}>
      <div
        className={cn(
          "flex items-center justify-between gap-3",
          embedded &&
            "min-w-0 flex-col items-stretch gap-1.5 @[560px]/card-header:flex-row @[560px]/card-header:items-center",
        )}
      >
        <div
          className={cn(
            embedded &&
              "min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 @[560px]/card-header:flex-nowrap @[560px]/card-header:items-baseline",
          )}
        >
          <CardTitle
            className={cn(
              "text-lg",
              embedded && "whitespace-nowrap text-sm font-semibold",
            )}
          >
            {showClosed ? "Closed (history)" : "Open positions"}
          </CardTitle>
          <CardDescription
            className={cn(
              embedded && "min-w-0 @[560px]/card-header:whitespace-nowrap text-xs",
            )}
          >
            {description}
          </CardDescription>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            embedded
              ? "w-full flex-nowrap items-center justify-between gap-1 @[560px]/card-header:w-auto @[560px]/card-header:flex-nowrap @[560px]/card-header:flex-row"
              : "flex-col items-end",
          )}
        >
          <div className="flex items-center gap-1.5">
            {/* Open | Closed segmented control */}
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => onShowClosedChange(false)}
                className={`inline-flex items-center justify-center rounded-sm transition-colors ${buttonSize} ${
                  !showClosed
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-pressed={!showClosed}
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => onShowClosedChange(true)}
                className={`inline-flex items-center justify-center rounded-sm transition-colors ${buttonSize} ${
                  showClosed
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-pressed={showClosed}
              >
                Closed
              </button>
            </div>
            {collapseAction}
          </div>
          {/* Sort control - right-aligned or flex-row */}
          <div
            className="inline-flex rounded-md border p-0.5 text-xs"
            role="group"
            aria-label="Sort positions"
          >
            {POSITIONS_SORT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onSortByChange(key)}
                className={`inline-flex items-center justify-center rounded-sm transition-colors capitalize ${buttonSize} ${
                  sortBy === key
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-pressed={sortBy === key}
              >
                {positionsSortLabel(key)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </CardHeader>
  );
}
