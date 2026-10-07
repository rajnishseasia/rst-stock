
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { createProductionLogger } from "@trade-bot/logger";
import { schema } from "@trade-bot/db";
import { desc, and, eq, gte, inArray, lt, not, or } from "drizzle-orm";
import {
  chartSignalLookupSymbols,
  collectChartSignalsForVenue,
  signalMatchesChartVenue,
} from "../lib/signal-chart-match.js";
import { isProfessorUser, shardiSignalCondition } from "../lib/signal-visibility.js";

const logger = createProductionLogger();

type ChartSignalRow = Pick<
  typeof schema.signals.$inferSelect,
  | "id"
  | "symbol"
  | "content"
  | "url"
  | "timestamp"
  | "source"
  | "status"
  | "metadata"
>;

export const signalsRouter = router({
  // Signals are ingested by the worker's Discord (TweetShift) poller and read
  // from the DB only — newest first, paged by timestamp cursor for infinite
  // scroll.
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(30),
        // ISO timestamp of the last item from the previous page. When present we
        // page strictly older signals (infinite scroll / history).
        cursor: z.string().datetime().nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const viewer = await ctx.db.query.users.findFirst({
        where: eq(schema.users.id, ctx.userId),
        columns: { name: true, username: true, email: true },
      });
      const maySeeShardi = viewer ? isProfessorUser(viewer) : false;
      let items: typeof schema.signals.$inferSelect[] = [];
      // Audit M13: distinguishes "no signals" from "the query failed" so the
      // client can render a degraded state instead of an empty feed.
      let degraded = false;
      try {
        items = await ctx.db.query.signals.findMany({
          where: and(
            input.cursor
              ? lt(schema.signals.timestamp, new Date(input.cursor))
              : undefined,
            maySeeShardi ? undefined : not(shardiSignalCondition()),
          ),
          orderBy: [desc(schema.signals.timestamp)],
          limit: input.limit,
        });
      } catch (err) {
        degraded = true;
        logger.error("signals", "Failed to fetch signals from DB", { error: err });
      }
      // Hand back a cursor only when the page was full, so the client knows
      // there may be more history to load.
      const nextCursor =
        items.length === input.limit
          ? items[items.length - 1]?.timestamp?.toISOString() ?? null
          : null;
      return { items, nextCursor, degraded };
    }),

  /**
   * Returns signals for a specific symbol, shaped for the chart annotation overlay.
   * Only reads from DB (not Twitter API) since chart bubbles need stable timestamps.
   * Looks back up to 30 days so there's enough history to match chart bars.
   */
  getForChart: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(20).transform((v) => v.toUpperCase()),
        venue: z.enum(["stocks", "perps"]).default("stocks"),
        limit: z.number().int().min(1).max(200).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const viewer = await ctx.db.query.users.findFirst({
        where: eq(schema.users.id, ctx.userId),
        columns: { name: true, username: true, email: true },
      });
      const maySeeShardi = viewer ? isProfessorUser(viewer) : false;
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const lookupSymbols = chartSignalLookupSymbols(input.symbol, input.venue);
      const signals = await collectChartSignalsForVenue<ChartSignalRow>({
        limit: input.limit,
        matches: (signal) =>
          signalMatchesChartVenue(signal, input.symbol, input.venue),
        fetchPage: ({ cursor, limit }) =>
          ctx.db.query.signals.findMany({
            where: and(
              inArray(schema.signals.symbol, lookupSymbols),
              gte(schema.signals.timestamp, since),
              maySeeShardi ? undefined : not(shardiSignalCondition()),
              cursor
                ? or(
                    lt(schema.signals.timestamp, cursor.timestamp),
                    and(
                      eq(schema.signals.timestamp, cursor.timestamp),
                      lt(schema.signals.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
            orderBy: [desc(schema.signals.timestamp), desc(schema.signals.id)],
            limit,
            columns: {
              id: true,
              symbol: true,
              content: true,
              url: true,
              timestamp: true,
              source: true,
              status: true,
              metadata: true,
            },
          }),
      });

      return signals.map((s) => {
        let authorName = "Unknown";
        let authorAvatar: string | null = null;
        let tweetId: string | null = null;
        try {
          const raw = s.metadata;
          const meta: Record<string, unknown> | null =
            typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown> | null);
          if (meta?.authorName) authorName = String(meta.authorName);
          if (meta?.authorAvatar) authorAvatar = String(meta.authorAvatar);
          if (meta?.tweetId) tweetId = String(meta.tweetId);
        } catch {
          // ignore
        }

        return {
          id: s.id,
          symbol: s.symbol ?? input.symbol,
          content: s.content ?? "",
          url: s.url ?? null,
          anchorTime: Math.floor(new Date(s.timestamp ?? Date.now()).getTime() / 1000),
          source: s.source ?? "twitter",
          status: s.status ?? "PENDING",
          authorName,
          authorAvatar,
          tweetId,
        };
      });
    }),
});
