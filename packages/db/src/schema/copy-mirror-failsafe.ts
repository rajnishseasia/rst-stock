import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** Durable source-flat observations for the mirrored-position failsafe. */
export const copyMirrorFailsafeChecks = pgTable(
  "copy_mirror_failsafe_checks",
  {
    /** Hash of the exact opening client-order IDs that still fund the exposure. */
    exposureKey: text("exposure_key").primaryKey(),
    followerUserId: text("follower_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceWallet: text("source_wallet").notNull(),
    followerWallet: text("follower_wallet").notNull(),
    venueNetwork: text("venue_network").notNull(),
    coin: text("coin").notNull(),
    side: text("side").notNull(),
    exposureSizeDecimal: text("exposure_size_decimal").notNull(),
    openingClientOrderIds: jsonb("opening_client_order_ids")
      .$type<string[]>()
      .notNull(),
    flatObservations: integer("flat_observations").notNull().default(0),
    firstFlatObservedAt: timestamp("first_flat_observed_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    closeSourceItemId: text("close_source_item_id"),
    status: text("status").notNull().default("watching"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    dueIdx: index("copy_mirror_failsafe_checks_due_idx").on(
      table.status,
      table.lastCheckedAt,
    ),
    followerIdx: index("copy_mirror_failsafe_checks_follower_idx").on(
      table.followerUserId,
    ),
  }),
);
