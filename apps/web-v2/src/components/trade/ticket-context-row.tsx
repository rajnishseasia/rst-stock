"use client";

import { cn } from "@/lib/utils";

/**
 * The "what do I have to work with" strip at the top of a trade ticket
 * (plan A2): account balance on the left, existing position in this market on
 * the right.
 *
 * Shared by both tickets so the two venues read the same way, but the VALUES
 * are the caller's problem, because they are not the same concept:
 *
 * - Equities: Alpaca's `nonMarginableBuyingPower`, never `buyingPower` (which
 *   is margin-inflated, see `apps/api/src/routers/positions.ts`).
 * - Perps: Hyperliquid's total USDC collateral, labelled "Balance" and not
 *   "Available", because it is not withdrawable or free margin.
 *
 * Purely presentational. It never fetches, and nothing here reaches order
 * construction.
 */
export interface TicketContextCell {
  label: string;
  value: string;
  /** Optional hover/long-press explanation of what the number actually is. */
  title?: string;
}

export function TicketContextRow({
  cells,
  className,
}: {
  cells: TicketContextCell[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid divide-x divide-border/60 rounded-md border border-border/60 bg-card/25",
        // Static class names: Tailwind cannot see an interpolated column count.
        cells.length === 1
          ? "grid-cols-1"
          : cells.length === 3
            ? "grid-cols-3"
            : "grid-cols-2",
        className,
      )}
    >
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0 px-3 py-2" title={cell.title}>
          <div className="text-3xs uppercase tracking-wide text-muted-foreground">
            {cell.label}
          </div>
          <div className="truncate font-data text-xs font-semibold tabular-nums text-foreground">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}
