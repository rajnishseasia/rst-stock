import type { AppRouter } from "@trade-bot/api";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type MarketPulseOverview = RouterOutputs["marketPulse"]["overview"];
export type MarketTile = MarketPulseOverview["stocks"]["heatmap"][number];
export type MarketVenue = MarketTile["venue"];

export type MarketPulseTarget = {
  symbol: string;
  venue: MarketVenue;
};

export type MarketPulseActions = {
  onViewMarket: (target: MarketPulseTarget) => void;
  onTradeMarket: (target: MarketPulseTarget) => void;
};
