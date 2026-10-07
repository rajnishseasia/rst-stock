import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { userApiCredentials } from "./user-credentials.js";

/** Durable high-water marks for source consumers. */
export const copyMirrorCheckpoints = pgTable("copy_mirror_checkpoints", {
  consumer: text("consumer").primaryKey(),
  watermark: timestamp("watermark", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Durable inbox for each discovered (follower, source item) mirror candidate.
 *
 * The JSON payload freezes the exact sizing rule and selected credential that
 * were active at discovery time. A retry therefore cannot silently switch to a
 * different broker account or sizing rule after a worker restart.
 */
export const copyMirrorDeliveries = pgTable(
  "copy_mirror_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    followerUserId: text("follower_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").references(() => userApiCredentials.id, {
      onDelete: "set null",
    }),
    sourceItemId: text("source_item_id").notNull(),
    candidate: jsonb("candidate").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    outcome: text("outcome"),
    // Set on every delivery for a source in one atomic claim before the worker
    // emits that source's single aggregate Discord mirror confirmation.
    summaryNotifiedAt: timestamp("summary_notified_at", { withTimezone: true }),
    // Per-follower acknowledgement for durable in-app failure notifications.
    // This is separate from the public aggregate Discord summary state above.
    notificationReadAt: timestamp("notification_read_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    followerSourceUnique: unique("copy_mirror_deliveries_follower_source_unique").on(
      table.followerUserId,
      table.sourceItemId,
    ),
    dueIdx: index("copy_mirror_deliveries_due_idx").on(table.status, table.nextAttemptAt),
  }),
);

export type CopyMirrorCheckpoint = typeof copyMirrorCheckpoints.$inferSelect;
export type CopyMirrorDelivery = typeof copyMirrorDeliveries.$inferSelect;
