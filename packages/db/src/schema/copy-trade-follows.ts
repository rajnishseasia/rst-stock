/**
 * Copy-Trade Follows Schema
 *
 * One row per (follower, target) follow relationship for the copy-trade
 * "Following" feature (Phase 3).
 *
 * A single follow row drives two behaviors:
 *   - auto_mirror = false -> a curated "Following" view (the feed filtered to
 *     followed targets); the user still clicks Copy themselves.
 *   - auto_mirror = true  -> a background worker auto-places the trade on the
 *     follower's account using the stored sizing rule (REAL auto-execution).
 *
 * Privacy: target_key is always a NON-PII key. For user targets it is a stable
 * one-way hash of the source user id (see social.ts traderKey), never the raw
 * user id. For x_author targets it is a normalized author key.
 */

import { sql } from "drizzle-orm";
import { check, pgTable, text, boolean, timestamp, uuid, decimal, integer, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { userApiCredentials } from "./user-credentials.js";
import { millisecondTimestamp } from "../pagination/timestamp-key.js";

export const copyTradeFollows = pgTable("copy_trade_follows", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Who is doing the following
  followerUserId: text("follower_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // What is being followed (NON-PII). Mirrors the CopyTradeItem.followTarget contract.
  targetType: text("target_type").notNull(), // "x_author" | "user" | "politician"
  targetKey: text("target_key").notNull(),
  targetLabel: text("target_label"),

  // Sizing rule applied when copying/mirroring this target's trades
  sizingMode: text("sizing_mode").notNull().default("pct"), // "pct" | "usd"
  sizingValue: decimal("sizing_value", { precision: 12, scale: 2 }).notNull().default("5"),

  // Dollar cap applied to a single mirrored order, regardless of sizing basis.
  // Null means no cap. When set, the order is sized as min(ratio% x buying_power, max_trade_size).
  maxTradeSize: decimal("max_trade_size", { precision: 12, scale: 2 }),

  // Total copied exposure cap per ticker across ALL follows. Null means no cap.
  // The worker checks current position in the ticker and skips/clips if already at cap.
  maxCoinSize: decimal("max_coin_size", { precision: 12, scale: 2 }),

  // Auto-mirror is OFF by default — placing real orders requires an explicit opt-in.
  autoMirror: boolean("auto_mirror").notNull().default(false),

  // Optional per-follow ceiling; null inherits the follower's global cap.
  perpMaxLeverage: integer("perp_max_leverage"),

  /**
   * Automatic exits attached to every HYPERLIQUID PERP position this follow's
   * mirror opens. Both null (the default, and the value on every row that
   * existed before these columns) means no exit is attached and the follow
   * behaves exactly as it did before.
   *
   * PERCENT OF MARGIN (return on equity), not percent of price. The follower
   * does not choose the leverage, the source does, so a price-move percentage
   * would mean a completely different amount of money at 1x and at 20x: a 5%
   * move is 5% of the margin at 1x and 100% of it at 20x. Storing the ROE
   * figure keeps "stop me out at a quarter of my margin" meaning that whatever
   * leverage the source used. The absolute trigger price is derived at mirror
   * time, when the entry price and the applied leverage are both known.
   *
   * Both are stored as positive magnitudes. `perp_stop_loss_pct` = 25 means
   * "exit when this position is down 25% of the margin behind it"; the
   * direction is implied by the leg, not by the sign.
   *
   * Deliberately NOT applied to the Alpaca equity path. That path has the same
   * gap and its own unused `orders.exit_plan` mechanism for it; conflating the
   * two would have one stored number mean two different things.
   */
  perpTakeProfitPct: decimal("perp_take_profit_pct", { precision: 6, scale: 2 }),
  perpStopLossPct: decimal("perp_stop_loss_pct", { precision: 6, scale: 2 }),

  // Exact user-owned Alpaca destination selected for auto-mirror execution.
  credentialId: uuid("credential_id").references(() => userApiCredentials.id, {
    onDelete: "set null",
  }),

  /**
   * Independent destination policies. The legacy columns above remain so old
   * readers and already-created rows have a safe compatibility path; workers
   * use these typed venue-specific columns whenever they are present.
   */
  stockCredentialId: uuid("stock_credential_id").references(() => userApiCredentials.id, {
    onDelete: "set null",
  }),
  stockAutoMirror: boolean("stock_auto_mirror").notNull().default(false),
  stockSizingMode: text("stock_sizing_mode").notNull().default("pct"),
  stockSizingValue: decimal("stock_sizing_value", { precision: 12, scale: 2 })
    .notNull()
    .default("5"),
  perpCredentialId: uuid("perp_credential_id").references(() => userApiCredentials.id, {
    onDelete: "set null",
  }),
  perpAutoMirror: boolean("perp_auto_mirror").notNull().default(false),
  perpSizingMode: text("perp_sizing_mode").notNull().default("pct"),
  perpSizingValue: decimal("perp_sizing_value", { precision: 12, scale: 2 })
    .notNull()
    .default("5"),

  /** True once the typed stock/perp policy has been explicitly initialized. */
  destinationPolicyInitialized: boolean("destination_policy_initialized")
    .notNull()
    .default(false),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  // Drizzle's index overload cannot express a SQL expression between two
  // columns, but the runtime index builder accepts it and preserves the
  // intended (filter, normalized timestamp, id) order.
  const normalizedCreatedAt = millisecondTimestamp(table.createdAt) as unknown as typeof table.createdAt;
  return {
    followerUserIdIdx: index("copy_trade_follows_follower_user_id_idx").on(table.followerUserId),
    followerCreatedAtIdIdx: index("copy_trade_follows_follower_created_at_id_idx").on(
      table.followerUserId,
      normalizedCreatedAt,
      table.id,
    ),
    autoMirrorCreatedAtIdIdx: index("copy_trade_follows_auto_mirror_created_at_id_idx").on(
      table.autoMirror,
      normalizedCreatedAt,
      table.id,
    ),
    stockAutoMirrorCreatedAtIdIdx: index("copy_trade_follows_stock_auto_mirror_created_at_id_idx").on(
      table.stockAutoMirror,
      normalizedCreatedAt,
      table.id,
    ),
    perpAutoMirrorCreatedAtIdIdx: index("copy_trade_follows_perp_auto_mirror_created_at_id_idx").on(
      table.perpAutoMirror,
      normalizedCreatedAt,
      table.id,
    ),
    targetIdx: index("copy_trade_follows_target_idx").on(table.targetType, table.targetKey),
    // One follow row per (follower, target) — upsert target.
    followerTargetUnique: unique("copy_trade_follows_follower_target_unique").on(
      table.followerUserId,
      table.targetType,
      table.targetKey,
    ),
    // A null cap means "no user-configured ceiling". Persisted values must
    // stay within the same positive dollar range accepted by the API so a
    // direct DB writer cannot turn a malformed value into an uncapped mirror.
    maxTradeSizeRangeCheck: check(
      "copy_trade_follows_max_trade_size_range_check",
      sql`${table.maxTradeSize} is null or (${table.maxTradeSize} > 0 and ${table.maxTradeSize} <= 1000000)`,
    ),
    maxCoinSizeRangeCheck: check(
      "copy_trade_follows_max_coin_size_range_check",
      sql`${table.maxCoinSize} is null or (${table.maxCoinSize} > 0 and ${table.maxCoinSize} <= 1000000)`,
    ),
    perpMaxLeverageRangeCheck: check(
      "copy_trade_follows_perp_max_leverage_range_check",
      sql`${table.perpMaxLeverage} is null or ${table.perpMaxLeverage} between 1 and 100`,
    ),
    legacyAutoMirrorValidityCheck: check(
      "copy_trade_follows_auto_mirror_valid_check",
      sql`${table.autoMirror} = false or (
        ${table.credentialId} is not null and (
          (${table.sizingMode} = 'pct' and ${table.sizingValue} between 0.01 and 100) or
          (${table.sizingMode} = 'pct_equity' and ${table.sizingValue} between 0.01 and 100) or
          (${table.sizingMode} = 'usd' and ${table.sizingValue} between 0.01 and 1000000) or
          (${table.sizingMode} = 'ratio' and ${table.sizingValue} between 0.01 and 10)
        )
      )`,
    ),
    stockAutoMirrorValidityCheck: check(
      "copy_trade_follows_stock_auto_mirror_valid_check",
      sql`${table.stockAutoMirror} = false or (
        ${table.stockCredentialId} is not null and (
          (${table.stockSizingMode} = 'pct' and ${table.stockSizingValue} between 0.01 and 100) or
          (${table.stockSizingMode} = 'pct_equity' and ${table.stockSizingValue} between 0.01 and 100) or
          (${table.stockSizingMode} = 'usd' and ${table.stockSizingValue} between 0.01 and 1000000) or
          (${table.stockSizingMode} = 'ratio' and ${table.stockSizingValue} between 0.01 and 10)
        )
      )`,
    ),
    perpAutoMirrorValidityCheck: check(
      "copy_trade_follows_perp_auto_mirror_valid_check",
      sql`${table.perpAutoMirror} = false or (
        ${table.perpCredentialId} is not null and (
          (${table.perpSizingMode} = 'pct' and ${table.perpSizingValue} between 0.01 and 100) or
          (${table.perpSizingMode} = 'pct_equity' and ${table.perpSizingValue} between 0.01 and 100) or
          (${table.perpSizingMode} = 'usd' and ${table.perpSizingValue} between 0.01 and 1000000) or
          (${table.perpSizingMode} = 'ratio' and ${table.perpSizingValue} between 0.01 and 10)
        )
      )`,
    ),
  };
});

// Drizzle inferred types
export type CopyTradeFollow = typeof copyTradeFollows.$inferSelect;
export type NewCopyTradeFollow = typeof copyTradeFollows.$inferInsert;
