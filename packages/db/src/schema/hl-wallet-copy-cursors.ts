/**
 * Hyperliquid Wallet Copy Cursors
 *
 * Per-(follower, wallet) watermarks for the HlWalletCopyPoller.
 * Each row tracks the HL fill timestamp (Unix ms) of the most recent fill
 * we successfully processed for that (follower, wallet) pair.
 *
 * Two users following the same wallet advance their own cursors independently,
 * so a failure for one follower does not block the other.
 *
 * Watermark = 0 on first setup means "start from now" — the poller seeds it
 * to Date.now() on the very first poll, ensuring forward-only behaviour.
 */

import { pgTable, text, bigint, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const hlWalletCopyCursors = pgTable("hl_wallet_copy_cursors", {
  /** The RST user who is following the target wallet. */
  followerUserId: text("follower_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  /** The 0x-prefixed Hyperliquid wallet address being followed. */
  walletAddress: text("wallet_address").notNull(),

  /**
   * High-water mark: HL fill `time` (Unix milliseconds) of the most recent
   * fill we processed. Starts at 0; the poller seeds it to Date.now() on the
   * first run.
   */
  watermarkMs: bigint("watermark_ms", { mode: "number" }).notNull().default(0),

  /**
   * Tie-breaker for `watermarkMs`: the HL `tid` of the most recent fill we
   * processed at that timestamp. Multiple fills can share `time`, so the
   * cursor is the pair `(watermarkMs, watermarkTid)` compared lexicographically;
   * a fill is skipped only when it is not newer than that pair. Without this,
   * a fill at the same ms as one that already advanced the watermark would be
   * discarded forever instead of retried after a failure.
   */
  watermarkTid: bigint("watermark_tid", { mode: "number" }).notNull().default(0),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.followerUserId, table.walletAddress] }),
  followerIdx: index("hl_wallet_copy_cursors_follower_idx").on(table.followerUserId),
}));

export type HlWalletCopyCursor = typeof hlWalletCopyCursors.$inferSelect;
export type NewHlWalletCopyCursor = typeof hlWalletCopyCursors.$inferInsert;
