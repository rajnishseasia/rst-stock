/**
 * Users Schema
 *
 * User table with Better Auth fields and custom extensions.
 * Compatible with Better Auth's Drizzle adapter.
 */

import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, boolean, jsonb, integer } from "drizzle-orm/pg-core";

// =============================================================================
// BETTER AUTH REQUIRED TABLES
// These tables are required by Better Auth for authentication
// =============================================================================

// Better Auth users table
// Note: Better Auth generates custom string IDs (not UUIDs) for users
export const users = pgTable("users", {
  id: text("id").primaryKey(), // Better Auth provides its own ID format

  // Better Auth required fields
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  image: text("image"),

  // Custom fields
  username: text("username"),
  // Twitter display name stored separately from users.name (which can be overwritten
  // by any OAuth provider). username = @handle (for links), twitterName = display name.
  twitterName: text("twitter_name"),
  watchlistInitialized: boolean("watchlist_initialized").notNull().default(false),
  copyPerpMaxLeverage: integer("copy_perp_max_leverage").notNull().default(1),
  /**
   * Saved terminal UI layout (drawer collapse/split state, pane tab choices and
   * drawer widths) so the workspace is restored on any browser or device, not
   * just the one that wrote localStorage. Null means "never saved": the client
   * falls back to its local copy and then to the default layout. Stored as a
   * validated JSON blob (see terminalLayoutSettingSchema) rather than columns,
   * because the shape is nested and versioned.
   */
  terminalLayout: jsonb("terminal_layout"),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => ({
  copyPerpMaxLeverageRangeCheck: check(
    "users_copy_perp_max_leverage_range_check",
    sql`${table.copyPerpMaxLeverage} between 1 and 100`,
  ),
}));

// Better Auth sessions table
// Note: Better Auth generates custom string IDs (not UUIDs) for sessions
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // Better Auth provides its own ID format
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Better Auth accounts table (for OAuth providers)
// Note: Better Auth generates custom string IDs (not UUIDs) for accounts
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(), // Better Auth provides its own ID format
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Better Auth verifications table (for email verification, password reset, etc.)
// Note: Better Auth generates custom string IDs (not UUIDs) for verifications
export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(), // Better Auth provides its own ID format
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Drizzle inferred types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
