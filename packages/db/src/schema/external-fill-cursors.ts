/**
 * External Fill Cursors
 *
 * Per-credential watermarks for the ExternalFillPoller. Each row tracks the
 * high-water `submitted_at` timestamp of the last Alpaca order we successfully
 * ingested for that broker credential, so the next poll cycle can page forward
 * without re-scanning the entire order history.
 *
 * Kept in its own table (rather than reusing `copy_mirror_checkpoints`, which
 * is a single-consumer key-value store) because the watermark is per-credential
 * and the two consumers have unrelated lifecycles.
 */

import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { userApiCredentials } from "./user-credentials.js";

export const externalFillCursors = pgTable("external_fill_cursors", {
  credentialId: uuid("credential_id")
    .primaryKey()
    .references(() => userApiCredentials.id, { onDelete: "cascade" }),
  // High-water mark: the `submitted_at` of the most recent Alpaca order we've
  // durably processed for this credential. Queries use `after = watermark -
  // safetyOverlap` so a small clock skew or boundary event cannot skip a fill;
  // the `extfill:` clientOrderId unique index absorbs any re-reads.
  watermark: timestamp("watermark", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ExternalFillCursor = typeof externalFillCursors.$inferSelect;
export type NewExternalFillCursor = typeof externalFillCursors.$inferInsert;
