import { ArrowUpRight, ChartNoAxesCombined } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatSignedNumber } from "@/lib/format";
import type { MarketPulseActions, MarketTile, MarketVenue } from "./market-pulse-types";
import { formatMarketPrice, getHeatmapSpan, type HeatmapTileSize } from "./market-pulse-utils";

type MarketPulseHeatmapProps = MarketPulseActions & {
  items: MarketTile[];
  venue: MarketVenue;
};

const spanClasses: Record<HeatmapTileSize, string> = {
  small: "col-span-3 row-span-1",
  medium: "col-span-3 row-span-2",
  large: "col-span-6 row-span-2",
};

/* Tile fills mix the brand direction color over the pane surface instead of
   using raw emerald/red palette steps, so the heatmap shares the app's one
   green/one red and resolves correctly in both themes via the vars. */
function movementClasses(changePercent: number) {
  const magnitude = Math.abs(changePercent);
  if (changePercent > 0) {
    return magnitude >= 5
      ? "border-green-500/40 bg-[color-mix(in_srgb,var(--color-green-500)_30%,var(--surface-pane))] hover:bg-[color-mix(in_srgb,var(--color-green-500)_38%,var(--surface-pane))]"
      : magnitude >= 2
        ? "border-green-500/30 bg-[color-mix(in_srgb,var(--color-green-500)_20%,var(--surface-pane))] hover:bg-[color-mix(in_srgb,var(--color-green-500)_28%,var(--surface-pane))]"
        : "border-green-500/20 bg-[color-mix(in_srgb,var(--color-green-500)_12%,var(--surface-pane))] hover:bg-[color-mix(in_srgb,var(--color-green-500)_20%,var(--surface-pane))]";
  }
  if (changePercent < 0) {
    return magnitude >= 5
      ? "border-red-500/40 bg-[color-mix(in_srgb,var(--color-red-500)_30%,var(--surface-pane))] hover:bg-[color-mix(in_srgb,var(--color-red-500)_38%,var(--surface-pane))]"
      : magnitude >= 2
        ? "border-red-500/30 bg-[color-mix(in_srgb,var(--color-red-500)_20%,var(--surface-pane))] hover:bg-[color-mix(in_srgb,var(--color-red-500)_28%,var(--surface-pane))]"
        : "border-red-500/20 bg-[color-mix(in_srgb,var(--color-red-500)_12%,var(--surface-pane))] hover:bg-[color-mix(in_srgb,var(--color-red-500)_20%,var(--surface-pane))]";
  }
  return "border-border bg-muted/20 hover:bg-muted/35";
}

export function MarketPulseHeatmap({ items, venue, onViewMarket, onTradeMarket }: MarketPulseHeatmapProps) {
  function view(item: MarketTile) {
    onViewMarket({ symbol: item.symbol, venue: item.venue });
  }

  function trade(item: MarketTile) {
    onTradeMarket({ symbol: item.symbol, venue: item.venue });
  }

  return (
    <section aria-labelledby="market-heatmap-heading" className="px-2 py-3 sm:px-3 sm:py-4">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h2 id="market-heatmap-heading" className="text-xs font-semibold text-foreground">
            Activity heatmap
          </h2>
          <p className="text-3xs text-muted-foreground">
            Tile area reflects relative reported volume / {venue === "stocks" ? "Stocks" : "Perpetuals"}
          </p>
        </div>
        <div className="flex items-center gap-3 font-data text-3xs uppercase text-muted-foreground">
          <span className="flex items-center gap-1"><span className="size-2 bg-[color-mix(in_srgb,var(--color-red-500)_30%,var(--surface-pane))]" />Decline</span>
          <span className="flex items-center gap-1"><span className="size-2 bg-[color-mix(in_srgb,var(--color-green-500)_30%,var(--surface-pane))]" />Advance</span>
        </div>
      </header>

      {items.length > 0 ? (
        <div className="grid auto-rows-[4.75rem] grid-flow-dense grid-cols-6 gap-1.5 md:grid-cols-12" aria-label={`${venue} activity heatmap`}>
          {items.map((item) => {
            const span = getHeatmapSpan(item.weight);
            return (
              <article
                key={item.id}
                className={cn(
                  "group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-md border p-2 text-left transition-colors",
                  spanClasses[span.size],
                  movementClasses(item.changePercent),
                )}
              >
                <button
                  type="button"
                  onClick={() => view(item)}
                  aria-label={`View ${item.symbol} chart, ${formatSignedNumber(item.changePercent, "%")}`}
                  className="absolute inset-0 z-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                />
                <div className="pointer-events-none relative z-10 flex min-w-0 items-start justify-between gap-1.5">
                  <div className="min-w-0">
                    <h3 className="truncate font-data text-xs font-semibold text-foreground sm:text-sm">
                      {item.symbol}
                    </h3>
                    <p className="mt-0.5 truncate font-data text-3xs tabular-nums text-foreground/70">
                      {formatMarketPrice(item.price)} / VOL {formatCompactNumber(item.volume)}
                    </p>
                  </div>
                  <strong
                    className={cn(
                      "shrink-0 font-data text-2xs font-semibold tabular-nums sm:text-xs",
                      item.changePercent > 0 && "text-green-500",
                      item.changePercent < 0 && "text-red-500",
                      item.changePercent === 0 && "text-muted-foreground",
                    )}
                  >
                    {formatSignedNumber(item.changePercent, "%")}
                  </strong>
                </div>

                <div className="pointer-events-none relative z-10 flex items-end justify-between gap-1">
                  <span className="flex items-center gap-1 text-3xs font-medium text-foreground/65 group-hover:text-foreground">
                    <ChartNoAxesCombined className="size-2.5" aria-hidden="true" />
                    View chart
                  </span>
                  <button
                    type="button"
                    onClick={() => trade(item)}
                    className="pointer-events-auto flex h-5 items-center gap-0.5 rounded-sm border border-primary/35 bg-background/45 px-1.5 text-3xs font-semibold text-primary outline-none hover:bg-primary/10 focus-visible:ring-1 focus-visible:ring-primary"
                    aria-label={`Trade ${item.symbol}`}
                  >
                    <ArrowUpRight className="size-2.5" aria-hidden="true" />
                    Trade
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
          No {venue === "stocks" ? "stock" : "perpetual"} heatmap data available.
        </div>
      )}
    </section>
  );
}
