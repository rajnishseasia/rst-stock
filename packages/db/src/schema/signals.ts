
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  pgEnum,
  index,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { millisecondTimestamp } from "../pagination/timestamp-key.js";

export const signalStatusEnum = pgEnum("signal_status", ["PENDING", "TRADED", "IGNORED"]);

export const signals = pgTable("signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  /** Source-qualified immutable event identity, nullable for legacy rows. */
  sourceEventId: text("source_event_id"),
  /** Immutable source author ID when the upstream provides one. */
  sourceAuthorId: text("source_author_id"),
  symbol: text("symbol").notNull(),
  content: text("content").notNull(),
  url: text("url"),
  // withTimezone (audit M10): every other table uses timestamptz. Naive
  // timestamps made the 30s copy-mirror window compare JS Dates against
  // timestamp-without-tz, which can drop or duplicate edge rows across the
  // UTC offset. The migration converts in-place; values were always written
  // as UTC by the worker, and the DB runs with TimeZone=UTC.
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  status: signalStatusEnum("status").notNull().default("PENDING"),
  metadata: jsonb("metadata"), // Use jsonb for better queryability and type safety
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  const normalizedCreatedAt = millisecondTimestamp(table.createdAt);
  const normalizedTimestamp = millisecondTimestamp(table.timestamp);
  return {
    symbolStatusIdx: index("signals_symbol_status_idx").on(table.symbol, table.status),
    timestampIdx: index("signals_timestamp_idx").on(table.timestamp),
    createdAtIdIdx: index("signals_created_at_id_idx").on(normalizedCreatedAt, table.id),
    timestampIdIdx: index("signals_timestamp_id_idx").on(normalizedTimestamp, table.id),
    sourceEventUniqueIdx: uniqueIndex("signals_source_event_unique_idx")
      .on(table.source, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    sourceAuthorIdx: index("signals_source_author_idx").on(
      table.source,
      table.sourceAuthorId,
    ),
    normalizedAuthorTimestampIdx: index(
      "signals_normalized_author_timestamp_idx",
    ).on(
      sql`lower(regexp_replace(regexp_replace(btrim(coalesce(${table.metadata}->>'authorName', '')), '\\s*[•·|–-]\\s*TweetShift\\s*$', '', 'i'), '\\s+', ' ', 'g'))`,
      table.timestamp.desc(),
    ),
    legacyNormalizedAuthorTimestampIdx: index(
      "signals_legacy_normalized_author_timestamp_idx",
    )
      .on(
        sql`lower(regexp_replace(regexp_replace(btrim(coalesce(substring(${table.metadata} #>> '{}' from '"authorName"\\s*:\\s*"([^"\\\\]+)"'), '')), '\\s*[•·|–-]\\s*TweetShift\\s*$', '', 'i'), '\\s+', ' ', 'g'))`,
        table.timestamp.desc(),
      )
      .where(sql`jsonb_typeof(${table.metadata}) = 'string'`),
  };
});

export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
