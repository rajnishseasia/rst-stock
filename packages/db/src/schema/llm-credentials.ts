/**
 * User LLM Credentials Schema
 *
 * Stores encrypted API keys for direct LLM provider integrations.
 * Chat history is intentionally not persisted in v1.
 */

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userLlmApiCredentials = pgTable(
  "user_llm_api_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    provider: text("provider").notNull(),
    label: text("label"),

    encryptedApiKey: text("encrypted_api_key").notNull(),
    apiKeyLast4: text("api_key_last4").notNull(),

    baseUrl: text("base_url").notNull(),
    defaultModel: text("default_model").notNull(),

    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userProviderIdx: uniqueIndex("user_llm_api_credentials_user_provider_idx").on(
      table.userId,
      table.provider
    ),
    userIdIdx: index("user_llm_api_credentials_user_id_idx").on(table.userId),
  })
);

export type UserLlmApiCredential = typeof userLlmApiCredentials.$inferSelect;
export type NewUserLlmApiCredential = typeof userLlmApiCredentials.$inferInsert;
