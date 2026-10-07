/**
 * User API Credentials Schema
 *
 * Stores encrypted API credentials for broker integrations.
 * All tokens are encrypted using AES-256-GCM before storage.
 */

import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userApiCredentials = pgTable(
  "user_api_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // User reference (users.id is now text, not uuid)
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Provider identifier (e.g., "tradestation", "alpaca")
    provider: text("provider").notNull(),

    // Encrypted credentials (encrypted with ENCRYPTION_KEY from Vercel)
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),

    // Account info (not encrypted since it's not sensitive)
    accountId: text("account_id"),
    accountType: text("account_type"), // "PAPER", "LIVE", or legacy "SIM"
    username: text("username"),
    baseUrl: text("base_url"),

    // Token expiration
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userProviderIdx: index("user_api_credentials_user_provider_idx").on(
      table.userId,
      table.provider,
      table.accountId,
    ),
    // At most ONE hyperliquid credential row per user: hyperliquid.enable is
    // find-then-insert, and two tabs auto-firing concurrently could otherwise
    // create two rows with two different agent wallets (nondeterministic
    // findFirst afterwards). PARTIAL so multi-account providers (e.g. alpaca
    // paper + live rows) keep their existing many-rows-per-user shape.
    hyperliquidUserUniqueIdx: uniqueIndex("user_api_credentials_hl_user_unique")
      .on(table.userId, table.provider)
      .where(sql`${table.provider} = 'hyperliquid'`),
  }),
);

// Drizzle inferred types
export type UserApiCredential = typeof userApiCredentials.$inferSelect;
export type NewUserApiCredential = typeof userApiCredentials.$inferInsert;
