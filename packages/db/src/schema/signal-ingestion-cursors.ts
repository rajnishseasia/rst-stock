import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Durable cursor and health state for source signal consumers. */
export const signalIngestionCursors = pgTable("signal_ingestion_cursors", {
  /** Namespaced source key, for example discord:channel:<id>. */
  source: text("source").primaryKey(),
  /** Opaque source cursor, such as a Discord snowflake or board version key. */
  cursor: text("cursor"),
  /** Monotonic source sequence, stored as text so Discord snowflakes stay exact. */
  cursorSequence: text("cursor_sequence"),
  /** Separate raw boundary for bounded backward recovery. */
  backfillCursor: text("backfill_cursor"),
  backfillComplete: boolean("backfill_complete").notNull().default(false),
  watermark: timestamp("watermark", { withTimezone: true }),
  status: text("status").notNull().default("healthy"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SignalIngestionCursor = typeof signalIngestionCursors.$inferSelect;
export type NewSignalIngestionCursor = typeof signalIngestionCursors.$inferInsert;
