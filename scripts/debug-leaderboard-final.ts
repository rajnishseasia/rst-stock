/**
 * Final debug: exact eligible row count for SOL Decoder using the real leaderboard conditions.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-leaderboard-final");

const db = getDb();

const result = await db.execute(sql`
  SELECT
    o.asset_type,
    o.status,
    COUNT(*)::int as total,
    COUNT(CASE WHEN o.executed_price::numeric > 0 THEN 1 END)::int as with_price,
    COUNT(CASE WHEN o.executed_quantity > 0 THEN 1 END)::int as with_equity_qty,
    COUNT(CASE WHEN o.executed_size_decimal::numeric > 0 THEN 1 END)::int as with_perp_size,
    COUNT(CASE
      WHEN o.asset_type = 'PERP' AND o.executed_price::numeric > 0 AND o.executed_size_decimal::numeric > 0 THEN 1
      WHEN o.asset_type != 'PERP' AND o.executed_price::numeric > 0 AND o.executed_quantity > 0 THEN 1
    END)::int as leaderboard_eligible
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON (
    (st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id AND st.user_id = o.user_id)
  )
  GROUP BY o.asset_type, o.status
  ORDER BY o.asset_type, o.status
`);

console.log("=== SOL Decoder joined rows by asset type + status ===");
console.table(result.rows);

const totals = await db.execute(sql`
  SELECT
    COUNT(*)::int as total_joined,
    COUNT(CASE
      WHEN o.asset_type = 'PERP' AND o.executed_price::numeric > 0 AND o.executed_size_decimal::numeric > 0 THEN 1
      WHEN o.asset_type != 'PERP' AND o.executed_price::numeric > 0 AND o.executed_quantity > 0 THEN 1
    END)::int as leaderboard_eligible
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON (
    (st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id AND st.user_id = o.user_id)
  )
  WHERE NOT EXISTS (
    SELECT 1 FROM user_api_credentials c
    WHERE c.provider = 'alpaca'
      AND c.account_type IN ('PAPER', 'SIM')
      AND (c.id = o.broker_credential_id OR (o.broker_credential_id IS NULL AND c.user_id = o.user_id AND o.broker_account_id IS NOT NULL AND c.account_id = o.broker_account_id))
  )
`);

console.log("\n=== SOL Decoder leaderboard-eligible total ===");
console.table(totals.rows);

process.exit(0);
