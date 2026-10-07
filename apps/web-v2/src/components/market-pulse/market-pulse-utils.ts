import type { MarketPulseOverview, MarketTile, MarketVenue } from "./market-pulse-types";
import { formatCompactUsd } from "@/lib/format";

export type HeatmapTileSize = "small" | "medium" | "large";

export type HeatmapSpan = {
  size: HeatmapTileSize;
  columns: 3 | 6;
  rows: 1 | 2;
};

export type MarketRankings = {
  trending: MarketTile[];
  gainers: MarketTile[];
  mostActive: MarketTile[];
};

export function getHeatmapSpan(weight: number): HeatmapSpan {
  if (!Number.isFinite(weight) || weight < 0.48) {
    return { size: "small", columns: 3, rows: 1 };
  }
  if (weight < 0.78) {
    return { size: "medium", columns: 3, rows: 2 };
  }
  return { size: "large", columns: 6, rows: 2 };
}

export function getVenueRankings(
  overview: MarketPulseOverview,
  venue: MarketVenue,
): MarketRankings {
  if (venue === "stocks") {
    return {
      trending: overview.stocks.trending,
      gainers: overview.stocks.gainers,
      mostActive: overview.stocks.mostActive,
    };
  }

  return {
    trending: overview.perps.trending,
    gainers: overview.perps.gainers,
    mostActive: [...overview.perps.heatmap]
      .sort((left, right) => right.volume - left.volume)
      .slice(0, 8),
  };
}

export function getPulseFreshness(
  meta: Pick<MarketPulseOverview["meta"], "staleAfter">,
  now = new Date(),
): "fresh" | "stale" {
  const staleAt = Date.parse(meta.staleAfter);
  if (!Number.isFinite(staleAt)) return "stale";
  return now.getTime() >= staleAt ? "stale" : "fresh";
}

export function getExternalSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function formatMarketPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return formatCompactUsd(value);
}
