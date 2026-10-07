/**
 * Debug: check social_trades rows for the SOL Decoder user specifically.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-sol-decoder");

const db = getDb();

// First: who is in social_trades?
const userCounts = await db.execute(sql`
  SELECT
    st.user_id,
    u.twitter_name,
    u.username,
    COUNT(st.id)::int as trade_count
  FROM social_trades st
  LEFT JOIN users u ON st.user_id = u.id
  GROUP BY st.user_id, u.twitter_name, u.username
  ORDER BY trade_count DESC
`);

console.log("=== Users in social_trades ===");
console.table(userCounts.rows.map((r: Record<string, unknown>) => ({
  userId: String(r.user_id).slice(0, 12) + "…",
  twitter_name: r.twitter_name,
  username: r.username,
  trades: r.trade_count,
})));

// Second: for SOL Decoder specifically, how many orders join?
const solDecoderRows = await db.execute(sql`
  SELECT
    st.id as social_id,
    st.order_id,
    st.broker_order_id,
    o.id as order_id_from_orders,
    o.executed_price,
    o.executed_quantity,
    o.asset_type,
    o.status
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  LEFT JOIN orders o ON (
    (st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id AND st.user_id = o.user_id)
  )
  LIMIT 10
`);

console.log("\n=== SOL Decoder social_trades sample (10 rows) ===");
console.table(solDecoderRows.rows.map((r: Record<string, unknown>) => ({
  order_joined: r.order_id_from_orders != null ? "YES" : "NO",
  exec_price: r.executed_price,
  exec_qty: r.executed_quantity,
  asset: r.asset_type,
  status: r.status,
})));

process.exit(0);
