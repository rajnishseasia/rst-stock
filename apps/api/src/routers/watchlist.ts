/**
 * Watchlist Router
 *
 * Stores and orders a signed-in user's saved stock and Hyperliquid perp markets.
 */

import { TRPCError } from "@trpc/server";
import { schema } from "@trade-bot/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

const venueSchema = z.enum(["stocks", "perps"]);
const stockSymbolSchema = z
  .string()
  .trim()
  .min(1, "Symbol is required")
  .max(15, "Symbol is too long")
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z][A-Z0-9]*([.-][A-Z0-9]+)*$/.test(value), {
    message: "Use a valid ticker symbol, like AAPL or BRK.B",
  });
const perpSymbolSchema = z
  .string()
  .trim()
  .min(1, "Symbol is required")
  .max(32, "Symbol is too long")
  .refine((value) => /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/.test(value), {
    message: "Use a valid Hyperliquid market symbol, like BTC or xyz:GOOGL",
  });

const addInputSchema = z
  .object({
    symbol: z.string(),
    venue: venueSchema.default("stocks"),
  })
  .transform((input) => ({
    venue: input.venue,
    symbol:
      input.venue === "stocks"
        ? stockSymbolSchema.parse(input.symbol)
        : perpSymbolSchema.parse(input.symbol),
  }));

const MAX_WATCHLIST_ITEMS = 100;
const DEFAULT_WATCHLIST = [
  { symbol: "SPY", venue: "stocks" as const },
  { symbol: "QQQ", venue: "stocks" as const },
  { symbol: "IWM", venue: "stocks" as const },
  { symbol: "DIA", venue: "stocks" as const },
  { symbol: "BTC", venue: "perps" as const },
  { symbol: "ETH", venue: "perps" as const },
  { symbol: "SOL", venue: "perps" as const },
];

function toWatchlistItem(item: typeof schema.userWatchlistItems.$inferSelect) {
  return {
    id: item.id,
    symbol: item.symbol,
    venue: item.venue,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export const watchlistRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: (user, { eq }) => eq(user.id, ctx.userId),
      columns: { watchlistInitialized: true },
    });

    if (user && !user.watchlistInitialized) {
      await ctx.db.transaction(async (tx) => {
        const existing = await tx.query.userWatchlistItems.findMany({
          where: (item, { eq }) => eq(item.userId, ctx.userId),
          columns: { id: true },
          limit: 1,
        });

        if (existing.length === 0) {
          await tx
            .insert(schema.userWatchlistItems)
            .values(
              DEFAULT_WATCHLIST.map((item, sortOrder) => ({
                userId: ctx.userId,
                ...item,
                sortOrder,
              })),
            )
            .onConflictDoNothing();
        }

        await tx
          .update(schema.users)
          .set({ watchlistInitialized: true, updatedAt: new Date() })
          .where(eq(schema.users.id, ctx.userId));
      });
    }

    const items = await ctx.db.query.userWatchlistItems.findMany({
      where: (item, { eq }) => eq(item.userId, ctx.userId),
      orderBy: (item, { asc }) => [asc(item.sortOrder), asc(item.symbol)],
    });

    return items.map(toWatchlistItem);
  }),

  add: protectedProcedure
    .input(
      addInputSchema
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.query.userWatchlistItems.findFirst({
        where: (item, { and, eq }) =>
          and(
            eq(item.userId, ctx.userId),
            eq(item.venue, input.venue),
            eq(item.symbol, input.symbol),
          ),
      });

      if (existing) {
        return {
          item: toWatchlistItem(existing),
          alreadyExists: true,
        };
      }

      const current = await ctx.db.query.userWatchlistItems.findMany({
        where: (item, { eq }) => eq(item.userId, ctx.userId),
        columns: { id: true },
      });

      if (current.length >= MAX_WATCHLIST_ITEMS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Watchlist is full (max ${MAX_WATCHLIST_ITEMS} symbols). Remove one before adding more.`,
        });
      }

      const lastItem = await ctx.db.query.userWatchlistItems.findFirst({
        where: (item, { eq }) => eq(item.userId, ctx.userId),
        orderBy: (item, { desc }) => [desc(item.sortOrder)],
      });

      // onConflictDoNothing makes this race-safe against the (user_id, symbol)
      // unique index: a concurrent add returns no row instead of throwing 23505.
      const [created] = await ctx.db
        .insert(schema.userWatchlistItems)
        .values({
          userId: ctx.userId,
          symbol: input.symbol,
          venue: input.venue,
          sortOrder: (lastItem?.sortOrder ?? -1) + 1,
        })
        .onConflictDoNothing({
          target: [
            schema.userWatchlistItems.userId,
            schema.userWatchlistItems.venue,
            schema.userWatchlistItems.symbol,
          ],
        })
        .returning();

      if (created) {
        return {
          item: toWatchlistItem(created),
          alreadyExists: false,
        };
      }

      // No row inserted → a concurrent request already added this symbol; fetch it.
      const raced = await ctx.db.query.userWatchlistItems.findFirst({
        where: (item, { and, eq }) =>
          and(
            eq(item.userId, ctx.userId),
            eq(item.venue, input.venue),
            eq(item.symbol, input.symbol),
          ),
      });

      if (!raced) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to add symbol to watchlist.",
        });
      }

      return {
        item: toWatchlistItem(raced),
        alreadyExists: true,
      };
    }),

  remove: protectedProcedure
    .input(
      z.object({
        itemId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(schema.userWatchlistItems)
        .where(
          and(
            eq(schema.userWatchlistItems.id, input.itemId),
            eq(schema.userWatchlistItems.userId, ctx.userId)
          )
        );

      return { success: true };
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        itemIds: z.array(z.string().uuid()).min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const uniqueIds = Array.from(new Set(input.itemIds));

      if (uniqueIds.length !== input.itemIds.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Watchlist item IDs must be unique.",
        });
      }

      // Ownership check + all writes run in a single transaction so a partial
      // failure or a concurrent reorder can't leave a half-applied sort order.
      await ctx.db.transaction(async (tx) => {
        const ownedItems = await tx
          .select({ id: schema.userWatchlistItems.id })
          .from(schema.userWatchlistItems)
          .where(
            and(
              eq(schema.userWatchlistItems.userId, ctx.userId),
              inArray(schema.userWatchlistItems.id, uniqueIds)
            )
          );

        if (ownedItems.length !== uniqueIds.length) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "One or more watchlist items could not be found.",
          });
        }

        for (let index = 0; index < uniqueIds.length; index++) {
          await tx
            .update(schema.userWatchlistItems)
            .set({ sortOrder: index, updatedAt: new Date() })
            .where(
              and(
                eq(schema.userWatchlistItems.id, uniqueIds[index]!),
                eq(schema.userWatchlistItems.userId, ctx.userId)
              )
            );
        }
      });

      return { success: true };
    }),
});
