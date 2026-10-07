/**
 * Orders Schema
 *
 * Tracks submitted trade orders and their execution status.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, decimal, doublePrecision, pgEnum, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { signals } from "./signals.js";
import { userApiCredentials } from "./user-credentials.js";

// Order status enum
export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "SYNCING",
  "SUBMITTED",
  "FILLED",
  "PARTIAL",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

// Asset type enum
export const assetTypeEnum = pgEnum("asset_type", ["EQUITY", "OPTION", "PERP"]);

// Order type enum
export const orderTypeEnum = pgEnum("order_type", [
  "Market",
  "Limit",
  "StopMarket",
  "StopLimit",
  // Take-profit trigger types (Hyperliquid perps). Added alongside the existing
  // StopMarket/StopLimit so a perp order row can record the full HL trigger set.
  // NOTE: this enum change must be applied to a live DB via `db:push` before a
  // TakeProfit* perp insert works (edit-only in this branch — do NOT run db:push here).
  "TakeProfitMarket",
  "TakeProfitLimit",
  "OCO",
]);

// Trade action enum
export const tradeActionEnum = pgEnum("trade_action", [
  "Buy",
  "Sell",
  "SellShort",
  "BuyToCover",
  "BuyToOpen",
  "SellToClose",
  "SellToOpen",
  "BuyToClose",
]);

// Direction enum
export const directionEnum = pgEnum("direction", ["long", "short"]);

// Exit-plan attachment status. A "pending" plan is attached to the position by
// the worker once the entry order fills (a trailing-stop sell can only be placed
// against held shares, so it can't ride along with the entry). Null = no plan.
export const exitPlanStatusEnum = pgEnum("exit_plan_status", [
  "pending",
  "attached",
  "failed",
]);

export const smartExitLegTypeEnum = pgEnum("smart_exit_leg_type", [
  "take_profit",
  "trailing_stop",
]);

export const smartExitLegStatusEnum = pgEnum("smart_exit_leg_status", [
  "pending",
  "submitting",
  "retryable",
  "attached",
  "manual_intervention",
]);

/**
 * Resolved exit plan persisted on an entry order. Concrete take-profit prices
 * are computed at submit time; the trailing-stop and TP share quantities are
 * re-derived against the actual filled quantity when the worker attaches them.
 */
export interface OrderExitPlan {
  /** Side of the exit orders: "sell" closes a long, "buy" covers a short. */
  exitSide: "buy" | "sell";
  /**
   * Fixed take-profit legs (e.g. 0.4R). `qtyFraction` is the share of the
   * filled position this leg should claim (0..1); the worker floors it and the
   * trailing runner takes the remainder.
   */
  takeProfits: Array<{ price: number; qtyFraction: number }>;
  /** Trailing runner for the remaining shares. */
  trailingStop?: { trailPercent: number };
  /**
   * Protective stop price. Two valid modes:
   *
   *  1. With take-profit legs: each fixed TP leg is placed as an OCO order
   *     (take-profit OR this stop, whichever fills first) so the TP shares
   *     are never left unprotected. The trailing runner carries its own
   *     moving stop and is not covered by this field.
   *  2. Stop-only (no `takeProfits`, no `trailingStop`): the entry is
   *     submitted as an Alpaca OTO order with this price as the `stop_loss`
   *     child. The broker attaches the stop atomically on fill, so the exit-
   *     plan worker has nothing to do — the order row is inserted with
   *     `exitPlanStatus: "attached"` from the start.
   *
   * CONSTRAINT: if `trailingStop` is set AND `takeProfits` is empty, setting
   * `stopPrice` is invalid — Alpaca will not accept two separate sell orders
   * against the same shares. The API enforces this at submission time.
   */
  stopPrice?: number;
}

/**
 * How the copy-mirror's automatic perp exit ended up, for the position this
 * order opened.
 *
 *  - "attached":    both requested legs are live at Hyperliquid.
 *  - "unprotected": the venue never confirmed them and the retries are spent.
 *                   The POSITION IS STILL OPEN and deliberately so: closing it
 *                   because an API call blipped is itself a loss the follower
 *                   did not ask for, and an unprotected mirror is no worse than
 *                   every mirror was before this feature existed. This value is
 *                   what puts the position in front of an operator.
 *  - "cancelled":   a mirrored SOURCE close was placed for this position, so
 *                   the legs were retired with it. The source's own close wins;
 *                   the attached exit is only ever a safety net.
 */
export type PerpProtectionStatus = "attached" | "unprotected" | "cancelled";

/**
 * The automatic exit the copy-mirror derived for one opened perp position.
 *
 * The ROE percentages are the rule the follower actually agreed to; the trigger
 * prices are that rule resolved against the entry and leverage this particular
 * mirror got. Both are kept because the second cannot be recomputed later: the
 * mark moves and the position's leverage can be changed by hand afterwards.
 *
 * `legClientOrderIds` is the handle a later cancel matches on. Hyperliquid
 * reports a resting order's cloid, and these are hashed into exactly those
 * cloids, so a cancel can retire the mirror's OWN legs without touching a stop
 * the follower placed themselves on the same coin.
 *
 * A PLAN IS NOT A PROMISE THAT THE LEGS ARE LIVE. The status column says that.
 * An `unprotected` row carries a plan too whenever legs were actually submitted,
 * because a leg the venue took before refusing the group is resting with its
 * cloid recorded nowhere else, and unrecorded is uncancellable. The ids there
 * are candidates: the cancel only ever acts on the ones it finds in `openOrders`.
 */
export interface PerpProtectionPlan {
  /** Percent of MARGIN, positive magnitude, as configured on the follow. */
  takeProfitRoePct?: number;
  stopLossRoePct?: number;
  /** Absolute Hyperliquid trigger prices, as decimal strings. */
  takeProfitPx?: string;
  stopLossPx?: string;
  /** The entry mark and applied leverage the conversion above used. */
  entryPx: string;
  leverage: number;
  /** Coin-denominated size the legs were placed against. */
  sizeCoin: string;
  /** Pre-hash client order ids of the legs, in the order they were submitted. */
  legClientOrderIds: string[];
}

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),

  // User reference (users.id is now text, not uuid)
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  // Signal reference (optional - if trade originated from a signal)
  signalId: uuid("signal_id").references(() => signals.id, { onDelete: "set null" }),

  // Basic order info
  symbol: text("symbol").notNull(),
  assetType: assetTypeEnum("asset_type").notNull(),
  orderType: orderTypeEnum("order_type").notNull(),
  tradeAction: tradeActionEnum("trade_action").notNull(),
  direction: directionEnum("direction").notNull().default("long"),

  // Quantities and prices.
  //
  // limit_price / price_trigger / executed_price are widened to (24,8) — the same
  // scale as quantityDecimal — because Hyperliquid perp prices can carry up to
  // (6 - szDecimals) decimal places. A low-priced perp trigger like 0.00001234
  // would silently round to 0.0000 in the old decimal(12,4), so the persisted row
  // diverged from the full-precision price actually sent on-chain (order-sync / UI
  // / audit all read the wrong value). Equity/option prices (<=4 dp) fit unchanged.
  quantity: integer("quantity").notNull(),
  limitPrice: decimal("limit_price", { precision: 24, scale: 8 }),
  stopPrice: decimal("stop_price", { precision: 12, scale: 4 }),
  priceTrigger: decimal("price_trigger", { precision: 24, scale: 8 }),

  // Risk management
  maxRisk: decimal("max_risk", { precision: 12, scale: 2 }), // Max $ to risk
  stopMarketPrice: decimal("stop_market_price", { precision: 12, scale: 4 }),

  // Options-specific fields
  optionExpiration: text("option_expiration"), // YYMMDD format
  optionStrike: decimal("option_strike", { precision: 12, scale: 4 }),
  optionType: text("option_type"), // "CALL" | "PUT"

  // Order execution
  status: orderStatusEnum("status").notNull().default("PENDING"),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
  clientOrderId: text("client_order_id"),
  brokerClientOrderId: text("broker_client_order_id"),
  brokerOrderId: text("broker_order_id"),
  brokerAccountId: text("broker_account_id"),
  brokerCredentialId: uuid("broker_credential_id").references(
    () => userApiCredentials.id,
    { onDelete: "set null" },
  ),
  syncReason: text("sync_reason"),
  syncAttempts: integer("sync_attempts").notNull().default(0),
  lastSyncAttemptAt: timestamp("last_sync_attempt_at", { withTimezone: true }),
  executedPrice: decimal("executed_price", { precision: 24, scale: 8 }),
  // double precision, not integer (audit M6): order-sync writes
  // parseFloat(filled_qty), and Alpaca can report fractional fills. Float8
  // keeps the inferred TS type as number (numeric would flip every consumer
  // to string) and share quantities fit comfortably in float64 precision.
  executedQuantity: doublePrecision("executed_quantity"),

  // Perpetual-futures fields (Hyperliquid). All nullable so existing equity/
  // option inserts are unaffected. Perp sizes are fractional — they MUST write
  // `quantityDecimal`, never the INTEGER `quantity` column (which would truncate).
  // Idempotency (the HL cloid) reuses the existing `clientOrderId` unique index.
  quantityDecimal: decimal("quantity_decimal", { precision: 24, scale: 8 }),
  // Cumulative EXECUTED perp size, written by the order-sync reconciler. Kept
  // separate from `quantityDecimal` (the original REQUESTED size) so the request
  // is preserved as an audit trail and never overwritten by fills.
  executedSizeDecimal: decimal("executed_size_decimal", { precision: 24, scale: 8 }),
  leverage: integer("leverage"),
  marginMode: text("margin_mode"), // "cross" | "isolated"
  reduceOnly: boolean("reduce_only").default(false),
  // Initial protection requested alongside an opening perp order. These are
  // immutable source intent, separate from `perpProtection`, which records the
  // protection actually attached to a mirrored follower order. Copy-mirror
  // snapshots these prices when it discovers the source fill so a later follow
  // edit or delayed worker cannot change the copied exit.
  initialTakeProfitPx: decimal("initial_take_profit_px", { precision: 24, scale: 8 }),
  initialStopLossPx: decimal("initial_stop_loss_px", { precision: 24, scale: 8 }),
  // RETIRED, and kept in step with `realizedPnl` until the rollout completes.
  //
  // Named for funding, it only ever received Hyperliquid's `closedPnl`, which is
  // realized trading profit and loss on a closing fill, so a profitable close
  // recorded its whole gain under a column named for a cost. `realizedPnl` below
  // is where that belongs now.
  //
  // It is still WRITTEN, with the same value, for as long as a worker running
  // the previous revision might be reconciling: that worker uses this column as
  // its accumulation base, and emptying it mid-rollout would make its next fill
  // record only that fill instead of the running total. The follow-up that
  // removes the dual-write nulls it for good; see
  // docs/deployment/perp-pnl-column-split.md.
  //
  // Real funding has never been recorded anywhere. It would need the
  // `userFunding` stream, which fills do not carry.
  fundingPaid: decimal("funding_paid"),
  // Realized profit and loss on the fills that closed a position, summed.
  //
  // Hyperliquid reports it per closing fill as `closedPnl`; opening fills report
  // zero. Cumulative over the order, like `executedPrice`, so a partial snapshot
  // extends it rather than replacing it.
  realizedPnl: decimal("realized_pnl"),
  venue: text("venue").default("alpaca"), // "alpaca" | "hyperliquid"
  // WHICH Hyperliquid network this order was placed on ("mainnet" | "testnet").
  //
  // The reconciler reads open perp orders and queries the venue for their fate.
  // Without this it queries whichever network is configured NOW, so an operator
  // moving a deployment between networks makes every older order look like one
  // that never reached the venue, and the reconciler settles it CANCELLED while
  // the exposure is still live on the other chain. Null on rows written before
  // this column existed, and on every non-perp order.
  venueNetwork: text("venue_network"),
  // The venue fill this order's cumulative `executedSizeDecimal` already counts.
  //
  // Hyperliquid's `userFills` is a RECENT-fill window, not the account's
  // history, so recomputing a cumulative size from whatever it currently returns
  // reads a suffix as the whole. This is the cursor that makes the accumulation
  // incremental instead: fills at or before it are already counted.
  lastCountedFillId: text("last_counted_fill_id"),
  // When the order was actually SUBMITTED to the venue, as opposed to when the
  // row was created.
  //
  // The daily mirror cap counts by `created_at`, so an order stranded PENDING
  // before midnight and resumed after it is counted against neither day and the
  // cap can be exceeded. Null until the order is submitted, and on rows written
  // before this column existed.
  placedAt: timestamp("placed_at", { withTimezone: true }),
  // When a resumed reduce-only CLOSE first read the venue as holding no
  // position to reduce, and how many such reads have happened since.
  //
  // A close is one-shot, so retiring one on an empty position read has to be
  // sure the position is really gone and not merely unread. Neither the row's
  // age nor elapsed time since the first empty read establishes that on its own,
  // because a deployment can sit switched off across either one and come back
  // with a single read behind it. The COUNT is what a quiet interval cannot
  // manufacture: it only advances when a read actually happens. The timestamp
  // then keeps those reads from all landing inside a few seconds.
  //
  // Both are cleared whenever a position is seen again, since that ends the
  // streak. Null and zero on every order that has never read as absent.
  closeAbsenceFirstSeenAt: timestamp("close_absence_first_seen_at", { withTimezone: true }),
  closeAbsenceObservations: integer("close_absence_observations").default(0).notNull(),

  // Notes
  notes: text("notes"),

  // Copy-trade attribution: populated by the auto-mirror worker when this order
  // was placed by mirroring a followed trader. Null for all manual orders.
  copySourceLabel: text("copy_source_label"),

  // Verified manual-copy provenance. These are deliberately nullable and the
  // source order id has no FK: deleting the source must not erase the audit
  // trail on the copied order.
  manualCopySourceItemId: text("manual_copy_source_item_id"),
  manualCopySourceOrderId: uuid("manual_copy_source_order_id"),

  // Set to true when the row was created by the external-fill detection worker
  // (`ExternalFillPoller`), meaning the fill was observed at the broker but the
  // app did NOT originate the placement. Used to keep exit-plan attachment and
  // any other "we placed this" logic from misfiring on reconciled rows, and to
  // let downstream feeds (Discord, copy-mirror) distinguish origin.
  externalOrigin: boolean("external_origin").notNull().default(false),

  // Order configuration
  skipPresetTp: boolean("skip_preset_tp").notNull().default(false), // Skip preset take profit
  forceThreeContracts: boolean("force_three_contracts").notNull().default(false),

  // One-click exit plan ("Smart Exit"): a take-profit + trailing-stop plan that
  // the worker attaches to the position once this entry order fills. Null when
  // the order has no attached exit plan.
  exitPlan: jsonb("exit_plan").$type<OrderExitPlan>(),
  exitPlanStatus: exitPlanStatusEnum("exit_plan_status"),
  exitPlanError: text("exit_plan_error"),

  /**
   * The copy-mirror's automatic perp exit, recorded on the OPENING order.
   *
   * Three columns rather than one, following the `exit_plan` trio directly
   * above: what was asked for, what happened to it, and why it failed. Null on
   * every order that never requested protection, which is every order written
   * before this existed and every mirror whose follow has no TP/SL configured.
   *
   * The legs are deliberately NOT given order rows of their own, unlike the
   * hand-placed TP/SL in apps/api/src/routers/orders.ts. A `copymirror:`-
   * prefixed row is counted by `countMirrorsToday`, which filters on the cloid
   * prefix and nothing else, so two resting triggers would spend two of the
   * follower's daily mirror slots and start refusing opens the follow was
   * entitled to. The same prefix is what the mirrored-exposure attribution
   * queries read to decide how much of a live position a copied close may
   * reduce. Both are inputs to the close path, and nothing here may make an
   * exit harder to place, so the legs stay off that table and are recorded
   * here instead.
   */
  perpProtection: jsonb("perp_protection").$type<PerpProtectionPlan>(),
  perpProtectionStatus: text("perp_protection_status").$type<PerpProtectionStatus>(),
  perpProtectionError: text("perp_protection_error"),

  // Timestamps
  executedAt: timestamp("executed_at", { withTimezone: true }),
  // Per-user acknowledgement for the in-app fill notification. The order row
  // is already the durable source of truth for a fill, so keeping read state
  // here avoids a second notification table that could drift from execution.
  notificationReadAt: timestamp("notification_read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => {
  return {
    userIdStatusIdx: index("orders_user_id_status_idx").on(table.userId, table.status),
    userIdCreatedAtIdx: index("orders_user_id_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    brokerOrderIdIdx: index("orders_broker_order_id_idx").on(table.brokerOrderId),
    userClientOrderIdIdx: index("orders_user_client_order_id_idx").on(
      table.userId,
      table.clientOrderId,
    ),
    userBrokerOrderIdIdx: index("orders_user_broker_order_id_idx").on(
      table.userId,
      table.brokerOrderId,
    ),
    userBrokerClientOrderIdIdx: index("orders_user_broker_client_order_id_idx").on(
      table.userId,
      table.brokerClientOrderId,
    ),
    // Atomic dedupe for any client-supplied idempotency key (esp. the auto-mirror
    // worker): a duplicate client_order_id insert fails at the DB, so overlapping
    // poll cycles can't double-place. Postgres treats NULLs as distinct, so the
    // many legacy rows with a null client_order_id are unaffected.
    clientOrderIdUnique: uniqueIndex("orders_client_order_id_unique").on(table.clientOrderId),
    // Signal-attribution lookups join orders by signal_id (audit M9); without
    // this index those reads scan the whole table.
    signalIdIdx: index("orders_signal_id_idx").on(table.signalId),
    // The Hyperliquid reconciler's active-order scan, which runs every 30s and
    // is now on by default. Nothing else on this table starts with `venue`, so
    // without this the poll sequentially scans and sorts all of `orders` even on
    // deployments that have never placed a perp order.
    //
    // PARTIAL on the three filters that never vary, which is what keeps it
    // cheap: the index contains only unsettled Hyperliquid perp orders, so it is
    // empty where perps are unused and the scan ends immediately. It also stays
    // small on deployments that do use perps, since rows leave the index as they
    // reach a terminal status rather than accumulating.
    //
    // Keyed to match the scan's ORDER BY exactly, unproven network first and
    // then newest-first, so the 5,000-row cap is served by walking the index and
    // stopping rather than by sorting the matches.
    // Rows where the retired `funding_paid` and `realized_pnl` still disagree,
    // for the worker's absorption sweep. Partial, so it empties as they
    // converge and the sweep costs one empty index scan afterwards. Drop it
    // with the sweep and the dual-write in hyperliquid-order-sync.ts.
    // The copy-mirror poller's once-a-cycle "which mirrored perp positions were
    // opened without the exit their follow asked for" line, which runs every 30s
    // and, unlike every other read on this table, is not scoped to a user.
    //
    // PARTIAL, on the one status that is the whole point of the scan. The index
    // is EMPTY on any deployment where every attach has succeeded, which is the
    // expected steady state, so the line costs one empty index probe rather than
    // a sequential scan of `orders`. Keyed on created_at because the query is
    // bounded to the last day and reports the oldest first.
    perpProtectionUnprotectedIdx: index("orders_perp_protection_unprotected_idx")
      .on(table.createdAt)
      .where(sql`${table.perpProtectionStatus} = 'unprotected'`),
    hyperliquidLegacyPnlIdx: index("orders_hl_legacy_pnl_idx")
      .on(table.id)
      .where(
        sql`${table.venue} = 'hyperliquid' and ${table.fundingPaid} is not null and ${table.realizedPnl} is distinct from ${table.fundingPaid}`,
      ),
    hyperliquidPerpActiveIdx: index("orders_hl_perp_active_idx")
      .on(sql`(${table.venueNetwork} is null)`, table.createdAt.desc())
      .where(
        sql`${table.venue} = 'hyperliquid' and ${table.assetType} = 'PERP' and ${table.status} in ('PENDING', 'SUBMITTED', 'PARTIAL')`,
      ),
  };
});

export const smartExitLegs = pgTable("smart_exit_legs", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryOrderId: uuid("entry_order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  legKey: text("leg_key").notNull(),
  legType: smartExitLegTypeEnum("leg_type").notNull(),
  status: smartExitLegStatusEnum("status").notNull().default("pending"),
  clientOrderId: text("client_order_id").notNull(),
  brokerOrderId: text("broker_order_id"),
  attempts: integer("attempts").notNull().default(0),
  claimToken: uuid("claim_token"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  quantity: integer("quantity").notNull(),
  limitPrice: decimal("limit_price", { precision: 12, scale: 4 }),
  stopPrice: decimal("stop_price", { precision: 12, scale: 4 }),
  trailPercent: decimal("trail_percent", { precision: 8, scale: 4 }),
  error: text("error"),
  attachedAt: timestamp("attached_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => ({
  entryOrderLegKeyUnique: uniqueIndex("smart_exit_legs_entry_order_leg_key_unique").on(
    table.entryOrderId,
    table.legKey,
  ),
  clientOrderIdUnique: uniqueIndex("smart_exit_legs_client_order_id_unique").on(
    table.clientOrderId,
  ),
}));

// Drizzle inferred types
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type SmartExitLeg = typeof smartExitLegs.$inferSelect;
export type NewSmartExitLeg = typeof smartExitLegs.$inferInsert;
