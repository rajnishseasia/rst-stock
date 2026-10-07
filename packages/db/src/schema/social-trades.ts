/**
 * Social Trades Schema
 *
 * Records eligible trades for the social feed and leaderboard. Live trades are
 * published automatically; Alpaca paper/SIM trades are excluded.
 */

import { pgTable, text, timestamp, uuid, integer, decimal, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { orders } from "./orders.js";
import { millisecondTimestamp } from "../pagination/timestamp-key.js";

export const socialTrades = pgTable("social_trades", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Who made the trade
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // Trade details
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // "buy" | "sell"
  qty: integer("qty").notNull(),
  orderType: text("order_type"), // "market", "limit", "stop", etc.
  assetType: text("asset_type"), // "EQUITY", "OPTION"
  limitPrice: decimal("limit_price", { precision: 12, scale: 4 }),

  // Link back to Alpaca order
  brokerOrderId: text("broker_order_id"),
  // Authoritative account-scoped linkage for newly published events. Legacy
  // rows remain null and are resolved conservatively by the leaderboard.
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  const normalizedCreatedAt = millisecondTimestamp(table.createdAt);
  return {
    userIdIdx: index("social_trades_user_id_idx").on(table.userId),
    createdAtIdx: index("social_trades_created_at_idx").on(table.createdAt),
    createdAtIdIdx: index("social_trades_created_at_id_idx").on(normalizedCreatedAt, table.id),
    symbolIdx: index("social_trades_symbol_idx").on(table.symbol),
    orderIdIdx: index("social_trades_order_id_idx").on(table.orderId),
  };
});

// Drizzle inferred types
export type SocialTrade = typeof socialTrades.$inferSelect;
export type NewSocialTrade = typeof socialTrades.$inferInsert;
