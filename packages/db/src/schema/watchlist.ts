/**
 * User Watchlist Schema
 *
 * Stores a signed-in user's saved instruments across supported venues.
 */

import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userWatchlistItems = pgTable(
  "user_watchlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    symbol: text("symbol").notNull(),
    venue: text("venue", { enum: ["stocks", "perps"] })
      .notNull()
      .default("stocks"),
    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("user_watchlist_items_user_id_idx").on(table.userId),
    userSortIdx: index("user_watchlist_items_user_sort_idx").on(table.userId, table.sortOrder),
    userVenueSymbolIdx: uniqueIndex(
      "user_watchlist_items_user_venue_symbol_idx",
    ).on(
      table.userId,
      table.venue,
      table.symbol
    ),
  })
);

export type UserWatchlistItem = typeof userWatchlistItems.$inferSelect;
export type NewUserWatchlistItem = typeof userWatchlistItems.$inferInsert;
