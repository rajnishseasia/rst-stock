/**
 * Verify the scope backfill fixed FIFO bucket matching for social_trades.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("verify-scope-fix");

const db = getDb();

// Check SOL Decoder specifically
const solDecoder = await db.execute(sql`
  SELECT
    o.asset_type,
    lower(o.trade_action::text) LIKE '%buy%' OR lower(o.trade_action::text) LIKE '%cover%' as is_buy,
    COUNT(*)::int as count,
    COUNT(CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL THEN 1 END)::int as has_scope,
    COUNT(CASE WHEN COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days' THEN 1 END)::int as within_30d
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR (st.user_id = o.user_id AND st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id)
  )
  WHERE o.executed_price::numeric > 0
    AND (o.executed_quantity > 0 OR (o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0))
    AND o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'PARTIAL')
  GROUP BY o.asset_type, is_buy
  ORDER BY o.asset_type, is_buy
`);

console.log("=== SOL Decoder scope coverage by asset+side ===");
console.table(solDecoder.rows);

// Check if the FIFO buckets will now match for SOL Decoder equity
const bucketCheck = await db.execute(sql`
  SELECT
    o.symbol,
    o.broker_account_id as acct_id,
    o.broker_credential_id::text as cred_id,
    o.venue,
    COUNT(*)::int as total,
    COUNT(CASE WHEN lower(o.trade_action::text) LIKE '%buy%' OR lower(o.trade_action::text) LIKE '%cover%' THEN 1 END)::int as buys,
    COUNT(CASE WHEN NOT (lower(o.trade_action::text) LIKE '%buy%' OR lower(o.trade_action::text) LIKE '%cover%') THEN 1 END)::int as sells
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR (st.user_id = o.user_id AND st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id)
  )
  WHERE o.executed_price::numeric > 0
    AND o.executed_quantity > 0
    AND o.asset_type = 'EQUITY'
    AND o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'PARTIAL')
    AND COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days'
  GROUP BY o.symbol, o.broker_account_id, o.broker_credential_id, o.venue
  HAVING COUNT(CASE WHEN NOT (lower(o.trade_action::text) LIKE '%buy%' OR lower(o.trade_action::text) LIKE '%cover%') THEN 1 END) > 0
  ORDER BY sells DESC
  LIMIT 10
`);

console.log("\n=== SOL Decoder EQUITY symbols with sells in 30d (scope check) ===");
console.table((bucketCheck.rows as Record<string, unknown>[]).map(r => ({
  symbol: r.symbol,
  acct: r.acct_id ? String(r.acct_id).slice(0, 10) : null,
  cred: r.cred_id ? String(r.cred_id).slice(0, 8) + "…" : null,
  venue: r.venue,
  buys: r.buys,
  sells: r.sells,
})));

// Overall summary: all users
const allUsers = await db.execute(sql`
  SELECT
    u.twitter_name,
    COUNT(*)::int as total_in_scope,
    COUNT(CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL THEN 1 END)::int as has_explicit_scope,
    COUNT(CASE WHEN lower(o.trade_action::text) LIKE '%buy%' THEN 1 END)::int as buys,
    COUNT(CASE WHEN NOT (lower(o.trade_action::text) LIKE '%buy%') THEN 1 END)::int as sells
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR (st.user_id = o.user_id AND st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id)
  )
  WHERE o.executed_price::numeric > 0
    AND (o.executed_quantity > 0 OR (o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0))
    AND o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'PARTIAL')
  GROUP BY u.id, u.twitter_name
  ORDER BY total_in_scope DESC
`);

console.log("\n=== All users scope + buy/sell coverage ===");
console.table((allUsers.rows as Record<string, unknown>[]).map(r => ({
  user: r.twitter_name ?? "(anon)",
  in_scope: r.total_in_scope,
  has_explicit_scope: r.has_explicit_scope,
  buys: r.buys,
  sells: r.sells,
  can_fifo: Number(r.has_explicit_scope) > 0 && Number(r.sells) > 0 ? "YES" : "maybe",
})));

process.exit(0);
