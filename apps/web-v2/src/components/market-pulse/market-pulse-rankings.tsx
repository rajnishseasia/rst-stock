import { ArrowUpRight, ChartNoAxesCombined } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatChangePct } from "@/lib/format";
import { ChangeBadge } from "@/components/ui/change-badge";
import type {
  MarketPulseActions,
  MarketPulseOverview,
  MarketTile,
  MarketVenue,
} from "./market-pulse-types";
import { formatMarketPrice, getVenueRankings } from "./market-pulse-utils";

type MarketPulseRankingsProps = MarketPulseActions & {
  overview: MarketPulseOverview;
  venue: MarketVenue;
  perpsEnabled: boolean;
  onVenueChange: (venue: MarketVenue) => void;
};

type RankingListProps = MarketPulseActions & {
  title: string;
  eyebrow: string;
  items: MarketTile[];
};

function RankingList({ title, eyebrow, items, onViewMarket, onTradeMarket }: RankingListProps) {
  return (
    <section aria-label={`${title} ranking`} className="min-w-0 border-b border-border/70 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <header className="flex h-11 items-center justify-between border-b border-border/70 px-3">
        <div>
          <p className="text-3xs font-medium uppercase text-muted-foreground">{eyebrow}</p>
          <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        </div>
        <span className="font-data text-3xs tabular-nums text-muted-foreground">TOP {Math.min(items.length, 6)}</span>
      </header>

      {items.length > 0 ? (
        <ol className="divide-y divide-border/50">
          {items.slice(0, 6).map((item, index) => {
            const target = { symbol: item.symbol, venue: item.venue };
            return (
              <li key={item.id} className="grid min-h-12 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-1 px-2.5 py-1.5 transition-colors hover:bg-muted/30">
                <span className="font-data text-3xs tabular-nums text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <button
                  type="button"
                  onClick={() => onViewMarket(target)}
                  className="min-w-0 text-left outline-none focus-visible:text-primary"
                  aria-label={`View ${item.symbol} chart`}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate font-data text-xs font-semibold text-foreground">
                      {item.symbol}
                    </span>
                    <span className="font-data text-3xs tabular-nums text-muted-foreground">
                      {formatMarketPrice(item.price)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex">
                    <ChangeBadge
                      size="sm"
                      className="font-data"
                      {...formatChangePct(item.changePercent)}
                    />
                  </span>
                </button>
                <div className="flex items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="px-1.5 text-3xs text-muted-foreground"
                    onClick={() => onViewMarket(target)}
                    aria-label={`View ${item.symbol} chart`}
                  >
                    <ChartNoAxesCombined className="size-2.5" aria-hidden="true" />
                    View chart
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="border-primary/35 px-1.5 text-3xs text-primary hover:bg-primary/10 hover:text-primary"
                    onClick={() => onTradeMarket(target)}
                    aria-label={`Trade ${item.symbol}`}
                  >
                    <ArrowUpRight className="size-2.5" aria-hidden="true" />
                    Trade
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="flex min-h-28 items-center justify-center px-3 text-xs text-muted-foreground">
          No {title.toLowerCase()} markets available.
        </div>
      )}
    </section>
  );
}

export function MarketPulseRankings({
  overview,
  venue,
  perpsEnabled,
  onVenueChange,
  onViewMarket,
  onTradeMarket,
}: MarketPulseRankingsProps) {
  const rankings = getVenueRankings(overview, venue);

  return (
    <section aria-labelledby="market-rankings-heading" className="border-b border-border/70">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2 sm:px-4">
        <div>
          <h2 id="market-rankings-heading" className="text-xs font-semibold text-foreground">
            Market rankings
          </h2>
          <p className="text-3xs text-muted-foreground">Price movement and normalized market activity</p>
        </div>
        <div className="grid grid-cols-2 rounded-md border border-border bg-muted/20 p-0.5" role="group" aria-label="Market venue">
          {(["stocks", ...(perpsEnabled ? ["perps" as const] : [])] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onVenueChange(option)}
              aria-pressed={venue === option}
              // The selected venue used to be a solid gold chip. In a two-up
              // group that is half the control flooded with the accent
              // (DESIGN.md: gold is a seasoning, not a sauce), so it now uses
              // the chart-overlay toggles' tint: a primary wash, a primary
              // border and primary text. Both states carry `border` so the
              // segments keep the same width as selection moves.
              className={cn(
                "h-6 min-w-16 rounded-sm border px-2 text-3xs font-semibold capitalize outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary",
                venue === option
                  ? "border-primary/45 bg-primary/15 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <div className="grid lg:grid-cols-3">
        <RankingList title="Trending" eyebrow="Composite score" items={rankings.trending} onViewMarket={onViewMarket} onTradeMarket={onTradeMarket} />
        <RankingList title="Gainers" eyebrow="Session change" items={rankings.gainers} onViewMarket={onViewMarket} onTradeMarket={onTradeMarket} />
        <RankingList title="Most Active" eyebrow="Reported volume" items={rankings.mostActive} onViewMarket={onViewMarket} onTradeMarket={onTradeMarket} />
      </div>
    </section>
  );
}
