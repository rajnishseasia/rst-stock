/**
 * Chat Conversations + Messages
 *
 * Persists the AI Chat panel's history so a refresh or a return visit doesn't
 * vaporize the conversation. A conversation is per-user (cascade-deleted with
 * the user) and groups an ordered list of messages.
 *
 * `accountMode` is captured on the conversation so we can later show "this
 * chat was run against your PAPER account" — useful since the AI's context
 * (positions/orders/buying power) differs between paper and live.
 *
 * `title` is initially null; the API auto-titles it from the first user
 * message after the assistant turn completes (cheap heuristic, no LLM
 * round-trip). The user can rename later.
 *
 * `metadata` on messages stores the per-turn sources/warnings that the chat
 * panel renders below the assistant message; we keep them attached to the
 * message so loading an old conversation restores the same source list.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    title: text("title"),
    /** "PAPER" | "LIVE" — the account mode the chat was opened against. */
    accountMode: text("account_mode"),

    /**
     * Set server-side (and never lowered) the moment tenant-private broker
     * data enters this conversation: either Alpaca account context was loaded
     * into the system prompt, or a tenant_private-domain tool call succeeded.
     * Once true, external (Signa) tools stay blocked for every later turn of
     * the conversation, regardless of what the client sends on the request.
     */
    tenantPrivateDataSeen: boolean("tenant_private_data_seen")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("chat_conversations_user_id_idx").on(table.userId),
    // Newest-first list queries are by (userId, updatedAt desc); add a covering
    // index so the sidebar stays cheap once a user has many conversations.
    userUpdatedAtIdx: index("chat_conversations_user_updated_at_idx").on(
      table.userId,
      table.updatedAt
    ),
  })
);

export type ChatConversation = typeof chatConversations.$inferSelect;
export type NewChatConversation = typeof chatConversations.$inferInsert;

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),

    /** "user" | "assistant". We deliberately don't persist the system prompt;
     *  it's regenerated server-side from the skill + live context per turn. */
    role: text("role").notNull(),

    content: text("content").notNull(),

    /** Per-turn extras: { sources?: ResearchSource[], warnings?: string[],
     *  model?: string, provider?: string }. Optional. */
    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index("chat_messages_conversation_id_idx").on(
      table.conversationId
    ),
    // (conversationId, createdAt) for ordered transcript loads.
    conversationCreatedAtIdx: index(
      "chat_messages_conversation_created_at_idx"
    ).on(table.conversationId, table.createdAt),
  })
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
