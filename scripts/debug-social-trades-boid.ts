/**
 * Debug: check if social_trades rows have broker_order_id populated.
 * If not, eventIdentity() returns null and ALL rows are silently skipped.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-social-trades-boid");

const db = getDb();

// Check broker_order_id population
const summary = await db.execute(sql`
  SELECT
    COUNT(*)::int as total,
    COUNT(broker_order_id)::int as with_broker_order_id,
    COUNT(order_id)::int as with_order_id,
    COUNT(CASE WHEN broker_order_id IS NULL AND order_id IS NOT NULL THEN 1 END)::int as order_id_only
  FROM social_trades
`);

console.log("=== social_trades broker_order_id coverage ===");
console.table(summary.rows);

// For SOL Decoder specifically
const solDecoder = await db.execute(sql`
  SELECT
    COUNT(*)::int as total,
    COUNT(st.broker_order_id)::int as with_broker_order_id,
    COUNT(st.order_id)::int as with_order_id,
    COUNT(CASE WHEN st.broker_order_id IS NULL THEN 1 END)::int as missing_boid
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
`);

console.log("\n=== SOL Decoder social_trades broker_order_id ===");
console.table(solDecoder.rows);

// Check if the orders have broker_order_id set
const orderBoid = await db.execute(sql`
  SELECT
    COUNT(*)::int as total_orders_in_social,
    COUNT(o.broker_order_id)::int as orders_with_boid,
    COUNT(CASE WHEN o.broker_order_id IS NULL THEN 1 END)::int as orders_missing_boid
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
`);

console.log("\n=== Joined orders broker_order_id coverage (SOL Decoder) ===");
console.table(orderBoid.rows);

// Sample some rows to see what's there
const sample = await db.execute(sql`
  SELECT
    st.id,
    st.broker_order_id as st_boid,
    o.broker_order_id as o_boid,
    o.asset_type,
    o.trade_action
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  LIMIT 10
`);

console.log("\n=== Sample rows (SOL Decoder) ===");
console.table(sample.rows.map((r: Record<string, unknown>) => ({
  st_id: String(r.id).slice(0, 8) + "…",
  st_boid: r.st_boid ? String(r.st_boid).slice(0, 8) + "…" : null,
  o_boid: r.o_boid ? String(r.o_boid).slice(0, 8) + "…" : null,
  asset_type: r.asset_type,
  trade_action: r.trade_action,
})));

process.exit(0);
