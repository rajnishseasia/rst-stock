import { getRedisClient } from "@trade-bot/redis";
import { protectedProcedure, router } from "../trpc.js";
import { createMasterAlpacaClient } from "../lib/alpaca.js";
import { createHyperliquidInfoClient } from "../lib/hyperliquid.js";
import {
  buildMarketPulse,
  cachedOrLive,
  fetchAlpacaPulseSource,
  isMarketPulseOverview,
} from "../lib/markets/market-pulse.js";

const HEALTHY_TTL_SECONDS = 60;
const DEGRADED_TTL_SECONDS = 15;

export const marketPulseRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    const compute = async () => buildMarketPulse({
      stocks: async () => fetchAlpacaPulseSource(createMasterAlpacaClient()),
      perps: async () => {
        const result = await createHyperliquidInfoClient().getUniverseStatsWithStatus();
        return {
          markets: result.stats,
          warnings: result.unavailableDexes.length > 0
            ? [`Some Hyperliquid market partitions are temporarily unavailable: ${result.unavailableDexes.join(", ")}.`]
            : [],
        };
      },
    });

    const cached = await cachedOrLive(
      "overview:v1",
      (overview) => overview.meta.status === "ok"
        ? HEALTHY_TTL_SECONDS
        : DEGRADED_TTL_SECONDS,
      compute,
      async () => getRedisClient(ctx.logger),
      isMarketPulseOverview,
    );

    const result = {
      ...cached.data,
      meta: {
        ...cached.data.meta,
        cacheState: cached.cacheState,
      },
    };

    return result;
  }),
});
