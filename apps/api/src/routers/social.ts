/**
 * Social Router
 *
 * tRPC router for the social trading feed.
 * Shows trades shared by other users on the platform.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { schema } from "@trade-bot/db";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  buildAuthoritativeOrderJoin,
  publiclyEligibleOrderCondition,
  validOptionContractCondition,
} from "../lib/authoritative-order.js";
import { tradeActionSide } from "../lib/trade-action.js";

// Trader-identity helpers (pseudonym + one-way follow key) now live in a LIB so
// the auto-mirror worker can import them WITHOUT executing this router module.
// Re-exported here to preserve the historical import surface
// (./social.js -> anonymizeTrader / traderKey) and keep hashes byte-identical.
import { anonymizeTrader, resolveTraderIdentity, traderKey } from "../lib/trader-identity.js";
export { anonymizeTrader, traderKey };

export const socialRouter = router({
  /**
   * Get recent social trades feed
   * Returns the latest shared trades from all users, joined with user info
   */
  feed: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        symbol: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const socialTrades = alias(schema.socialTrades, "social_feed_trades");
      const orders = alias(schema.orders, "social_feed_orders");
      const otherOrders = alias(schema.orders, "social_feed_other_orders");
      // Build where conditions against the same aliases used in the query.
      const conditions = [];
      if (input.symbol) {
        conditions.push(eq(socialTrades.symbol, input.symbol.toUpperCase()));
      }
      conditions.push(validOptionContractCondition(orders));
      conditions.push(publiclyEligibleOrderCondition(ctx.db, orders));
      const authoritativeOrderJoin = buildAuthoritativeOrderJoin(
        ctx.db,
        socialTrades,
        orders,
        otherOrders,
      );

      const trades = await ctx.db
        .select({
          id: socialTrades.id,
          // Legacy rows resolve through the scoped broker-id fallback; expose
          // the joined local order so downstream consumers gain an exact link.
          orderId: orders.id,
          symbol: orders.symbol,
          side: sql<string>`${orders.tradeAction}`,
          qty: socialTrades.qty,
          orderType: socialTrades.orderType,
          assetType: orders.assetType,
          limitPrice: socialTrades.limitPrice,
          // Actual fill price, reconciled from Alpaca into the orders table by
          // the OrderSyncPoller (~30s after submission). Null until filled.
          fillPrice: orders.executedPrice,
          tradeAction: orders.tradeAction,
          direction: orders.direction,
          // social_trades.qty is a legacy INTEGER column, so hyperliquid-order-sync
          // writes a `qty: 1` placeholder for perp fills and leaves the exact size
          // on the joined child order. Without this column a 0.004 BTC fill shows
          // as "x 1" beside its real per-coin fill price, overstating the position
          // ~250x to everyone deciding whom to follow. Same contract copy-trade.ts
          // honors in mapUserTradeToItem.
          executedSizeDecimal: orders.executedSizeDecimal,
          createdAt: socialTrades.createdAt,
          // Linked X accounts intentionally publish their X identity. Everyone
          // else keeps the deterministic pseudonym and avatar fallback.
          userId: socialTrades.userId,
          userName: schema.users.name,
          userTwitterName: schema.users.twitterName,
          userUsername: schema.users.username,
          userImage: schema.users.image,
          twitterLinked: sql<boolean>`exists (
            select 1 from ${schema.accounts}
            where ${schema.accounts.userId} = ${socialTrades.userId}
              and ${schema.accounts.providerId} = 'twitter'
          )`,
        })
        .from(socialTrades)
        .innerJoin(schema.users, eq(socialTrades.userId, schema.users.id))
        // Link back to the broker order to surface the executed fill price.
        .innerJoin(
          orders,
          authoritativeOrderJoin,
        )
        .where(conditions.length > 0 ? sql`${conditions.map(c => c).reduce((a, b) => sql`${a} AND ${b}`)}` : undefined)
        .orderBy(desc(socialTrades.createdAt), desc(socialTrades.id))
        .limit(input.limit);

      return trades.map((t) => {
        const { traderName, traderImage } = t.twitterLinked
          ? resolveTraderIdentity(t.userId, {
              twitterLinked: true,
              name: t.userName,
              twitterName: t.userTwitterName,
              username: t.userUsername,
              image: t.userImage,
            })
          : anonymizeTrader(t.userId);
        // Prefer the joined order's exact decimal size for perps. Guarded on
        // finite-and-positive so a legacy row, or an order not yet reconciled
        // (executedSizeDecimal NULL, or "0" before the first fill lands), keeps
        // the stored placeholder instead of rendering NaN or "x 0".
        const exactPerpQty =
          t.assetType === "PERP" && t.executedSizeDecimal
            ? Number.parseFloat(t.executedSizeDecimal)
            : Number.NaN;
        return {
          id: t.id,
          traderName,
          traderImage,
          symbol: t.symbol,
          side: tradeActionSide(t.tradeAction) ?? t.side,
          qty: Number.isFinite(exactPerpQty) && exactPerpQty > 0 ? exactPerpQty : t.qty,
          orderType: t.orderType,
          assetType: t.assetType,
          orderId: t.orderId,
          tradeAction: t.tradeAction,
          direction: t.direction,
          limitPrice: t.limitPrice ? parseFloat(t.limitPrice) : null,
          fillPrice: t.fillPrice ? parseFloat(t.fillPrice) : null,
          createdAt: t.createdAt?.toISOString() || new Date().toISOString(),
        };
      });
    }),

  /**
   * Get "hot symbols" — symbols where 2+ traders entered in the last 30 minutes
   * This powers the "3 people got in" momentum indicator
   */
  hotSymbols: protectedProcedure
    .input(
      z.object({
        minutes: z.number().min(5).max(1440).default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const cutoff = new Date(Date.now() - input.minutes * 60 * 1000);

      const socialTrades = alias(schema.socialTrades, "hot_social_trades");
      const orders = alias(schema.orders, "hot_orders");
      const otherOrders = alias(schema.orders, "hot_other_orders");
      const authoritativeOrderJoin = buildAuthoritativeOrderJoin(
        ctx.db,
        socialTrades,
        orders,
        otherOrders,
      );
      const results = await ctx.db
        .select({
          symbol: orders.symbol,
          traderCount: sql<number>`count(DISTINCT ${socialTrades.userId})`.as("trader_count"),
          tradeCount: sql<number>`count(*)`.as("trade_count"),
          latestAction: sql<string>`(array_agg(${orders.tradeAction} ORDER BY ${socialTrades.createdAt} DESC, ${socialTrades.id} DESC))[1]`.as("latest_action"),
        })
        .from(socialTrades)
        .innerJoin(orders, authoritativeOrderJoin)
        .where(and(
          gte(socialTrades.createdAt, cutoff),
          validOptionContractCondition(orders),
          publiclyEligibleOrderCondition(ctx.db, orders),
        ))
        .groupBy(orders.symbol)
        .having(sql`count(DISTINCT ${socialTrades.userId}) >= 2`)
        .orderBy(sql`count(DISTINCT ${socialTrades.userId}) DESC`, asc(orders.symbol));

      return results.map((r) => ({
        symbol: r.symbol,
        traderCount: Number(r.traderCount),
        tradeCount: Number(r.tradeCount),
        latestSide: tradeActionSide(r.latestAction) ?? "sell",
      }));
    }),
});
