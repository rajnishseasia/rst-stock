import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** One durable identity per source-qualified immutable author ID. */
export const sourceAuthorIdentities = pgTable(
  "source_author_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    sourceAuthorId: text("source_author_id").notNull(),
    /** Stable follow/profile key derived from source + sourceAuthorId. */
    canonicalKey: text("canonical_key").notNull().unique(),
    currentHandle: text("current_handle"),
    currentDisplayName: text("current_display_name"),
    avatarUrl: text("avatar_url"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sourceAuthorUnique: unique("source_author_identities_source_author_unique").on(
      table.source,
      table.sourceAuthorId,
    ),
    sourceLookupIdx: index("source_author_identities_source_lookup_idx").on(
      table.source,
      table.sourceAuthorId,
    ),
  }),
);

/** Historical handles and display names observed for one durable identity. */
export const sourceAuthorAliases = pgTable(
  "source_author_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => sourceAuthorIdentities.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    alias: text("alias").notNull(),
    aliasType: text("alias_type").notNull().default("observed"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    identityAliasUnique: unique("source_author_aliases_identity_alias_unique").on(
      table.identityId,
      table.alias,
    ),
    sourceAliasLookupIdx: index("source_author_aliases_source_alias_lookup_idx").on(
      table.source,
      table.alias,
    ),
    identityLookupIdx: index("source_author_aliases_identity_lookup_idx").on(
      table.identityId,
    ),
  }),
);

export type SourceAuthorIdentity = typeof sourceAuthorIdentities.$inferSelect;
export type NewSourceAuthorIdentity = typeof sourceAuthorIdentities.$inferInsert;
export type SourceAuthorAlias = typeof sourceAuthorAliases.$inferSelect;
export type NewSourceAuthorAlias = typeof sourceAuthorAliases.$inferInsert;
