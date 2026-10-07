/**
 * One-time backfill: populate social_trades from historical filled orders.
 *
 * Before PR #213, shareTrades defaulted to false for all users, so
 * publishSocialTrade() was never called and social_trades is empty. The
 * 0037 migration removed the shareTrades gate entirely (all live-account
 * trades now auto-publish). This script creates the missing social_trades
 * rows from historical orders so the leaderboard has real data.
 *
 * Exclusions (matching the shared authoritative-order.ts conditions used by
 * the social/leaderboard routers, so this script can't drift from production
 * dedup/visibility rules):
 * - Paper/SIM Alpaca accounts, including the legacy account-id fallback for
 *   orders with a null brokerCredentialId (publiclyEligibleOrderCondition)
 * - Auto-mirrored orders (clientOrderId starts with "copymirror:")
 * - Orders with no fill price (executedPrice = 0 or null, unless PERP)
 * - Orders that already have an authoritative social_trades row, either via
 *   the orderId FK or the legacy scoped brokerOrderId fallback
 *   (buildAuthoritativeOrderJoin)
 *
 * Safety:
 * - Idempotent: the authoritative-match NOT EXISTS check and the insert's
 *   onConflictDoNothing() both guard against duplicate rows per order.
 * - Requires --yes-prod to run against a non-local database (audit M2).
 *
 * Usage:
 *   # Dry run first to preview what will be inserted:
 *   DATABASE_URL=<supabase-pooled> DATABASE_URL_DIRECT=<supabase-direct> \
 *   bun apps/api/scripts/backfill-social-trades.ts --yes-prod --dry-run
 *
 *   # Apply:
 *   DATABASE_URL=<supabase-pooled> DATABASE_URL_DIRECT=<supabase-direct> \
 *   bun apps/api/scripts/backfill-social-trades.ts --yes-prod
 */

import { getDb, schema } from "@trade-bot/db";
import { notExists, sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";
import { buildAuthoritativeOrderJoin, publiclyEligibleOrderCondition } from "../src/lib/authoritative-order.js";

requireLocalDbOrExplicitConsent("backfill-social-trades");

const DRY_RUN = process.argv.includes("--dry-run");
if (DRY_RUN) {
  console.log("[backfill-social-trades] DRY RUN — no rows will be inserted.");
}

const FILL_STATUSES = ["FILLED", "CANCELLED", "EXPIRED", "REJECTED", "PARTIAL"] as const;
const BATCH_SIZE = 500;

function tradeActionSide(action: string | null | undefined): "buy" | "sell" | null {
  if (action?.startsWith("Buy")) return "buy";
  if (action?.startsWith("Sell")) return "sell";
  return null;
}

function isAutoMirrored(clientOrderId: string | null | undefined): boolean {
  return clientOrderId?.startsWith("copymirror:") === true;
}

const db = getDb();

// Reuse the same authoritative-match and public-eligibility conditions the
// live social/leaderboard routers use, so the backfill can't diverge from
// production dedup/visibility rules (Codex PR #214 review).
const otherOrders = alias(schema.orders, "backfill_other_orders");
const authoritativeSocialMatch = buildAuthoritativeOrderJoin(
  db,
  schema.socialTrades,
  schema.orders,
  otherOrders,
);

// Select filled orders that:
//   1. Have no authoritative social_trades row yet, including legacy rows
//      resolved only through the scoped brokerOrderId fallback (no orderId FK)
//   2. Pass the shared public-eligibility check (excludes PAPER/SIM Alpaca
//      accounts, including the legacy null-brokerCredentialId account fallback)
//   3. Have a real fill price (or are PERP with executedSizeDecimal > 0)
const orders = await db
  .select({
    id: schema.orders.id,
    userId: schema.orders.userId,
    symbol: schema.orders.symbol,
    assetType: schema.orders.assetType,
    orderType: schema.orders.orderType,
    tradeAction: schema.orders.tradeAction,
    quantity: schema.orders.quantity,
    limitPrice: schema.orders.limitPrice,
    brokerOrderId: schema.orders.brokerOrderId,
    clientOrderId: schema.orders.clientOrderId,
    executedPrice: schema.orders.executedPrice,
    executedSizeDecimal: schema.orders.executedSizeDecimal,
    statusUpdatedAt: schema.orders.statusUpdatedAt,
    createdAt: schema.orders.createdAt,
  })
  .from(schema.orders)
  .where(
    and(
      inArray(schema.orders.status, [...FILL_STATUSES]),
      // Must have a real fill price or perp fill size
      sql`(
        (${schema.orders.executedPrice} is not null and ${schema.orders.executedPrice}::numeric > 0)
        or
        (${schema.orders.assetType} = 'PERP' and ${schema.orders.executedSizeDecimal} is not null and ${schema.orders.executedSizeDecimal}::numeric > 0)
      )`,
      // Not already published (FK match or legacy brokerOrderId match)
      notExists(
        db
          .select({ value: sql<number>`1` })
          .from(schema.socialTrades)
          .where(authoritativeSocialMatch),
      ),
      // Exclude PAPER/SIM accounts, including the legacy account-id fallback
      publiclyEligibleOrderCondition(db, schema.orders),
    ),
  );

console.log(`[backfill-social-trades] Found ${orders.length} orders without social_trades rows.`);

const toInsert = orders
  .filter((o) => !isAutoMirrored(o.clientOrderId))
  .flatMap((o) => {
    const side = tradeActionSide(o.tradeAction);
    if (!side) return [];

    // PERP: qty=1 (legacy compat, actual size is executedSizeDecimal on the order)
    const qty = o.assetType === "PERP" ? 1 : (o.quantity ?? 1);
    const orderType = o.orderType?.toLowerCase() ?? "market";
    // Preserve historical timeline: use fill time if available, else order creation time.
    const createdAt = o.statusUpdatedAt ?? o.createdAt ?? new Date();

    return [{
      userId: o.userId,
      symbol: o.symbol,
      side,
      qty,
      orderType,
      assetType: o.assetType,
      limitPrice: o.limitPrice != null ? String(o.limitPrice) : null,
      brokerOrderId: o.brokerOrderId ?? null,
      orderId: o.id,
      createdAt,
    }];
  });

const skipped = orders.length - toInsert.length;
console.log(`[backfill-social-trades] ${toInsert.length} rows to insert (${skipped} skipped: auto-mirror or unknown side).`);

if (!DRY_RUN && toInsert.length > 0) {
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    await db.insert(schema.socialTrades).values(batch).onConflictDoNothing();
    inserted += batch.length;
    console.log(`[backfill-social-trades] Inserted ${inserted}/${toInsert.length}…`);
  }
  console.log(`[backfill-social-trades] Done. ${toInsert.length} social_trades rows created.`);
} else if (DRY_RUN) {
  console.log("[backfill-social-trades] Dry run complete. Re-run without --dry-run to apply.");
  if (toInsert.length > 0) {
    console.log("Sample (first 5):");
    console.table(toInsert.slice(0, 5).map((r) => ({
      userId: r.userId.slice(0, 8) + "…",
      symbol: r.symbol,
      side: r.side,
      qty: r.qty,
      orderType: r.orderType,
      assetType: r.assetType,
      credAccount: "live",
    })));
  }
} else {
  console.log("[backfill-social-trades] Nothing to insert.");
}

process.exit(0);
