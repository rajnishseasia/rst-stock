/**
 * Debug: simulate what the leaderboard query sees for each user.
 * Shows social_trades that successfully join to orders via the authoritative join.
 */
import { getDb, schema } from "@trade-bot/db";
import { sql, eq, and, isNull, isNotNull, inArray, or, notExists, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-leaderboard-data");

const db = getDb();

const socialTrades = alias(schema.socialTrades, "lst");
const orders = alias(schema.orders, "lo");

// Simulate the authoritative order join + public eligibility check
const result = await db.execute(sql`
  SELECT
    u.twitter_name,
    u.username,
    COUNT(st.id)::int as joined_rows,
    COUNT(CASE WHEN o.executed_price::numeric > 0 THEN 1 END)::int as priced_rows,
    MIN(o.executed_price::numeric) as min_price,
    MAX(o.executed_price::numeric) as max_price,
    COUNT(DISTINCT st.user_id) as users
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id
  INNER JOIN orders o ON (
    (st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id AND st.user_id = o.user_id)
  )
  WHERE
    o.executed_price IS NOT NULL
    AND o.executed_price::numeric > 0
    AND NOT EXISTS (
      SELECT 1 FROM user_api_credentials c
      WHERE c.provider = 'alpaca'
        AND c.account_type IN ('PAPER', 'SIM')
        AND (
          c.id = o.broker_credential_id
          OR (o.broker_credential_id IS NULL AND c.user_id = o.user_id AND o.broker_account_id IS NOT NULL AND c.account_id = o.broker_account_id)
        )
    )
  GROUP BY u.id, u.twitter_name, u.username
  ORDER BY joined_rows DESC
`);

console.table(result.rows.map((r: Record<string, unknown>) => ({
  name: r.twitter_name || r.username || "(anon)",
  joined: r.joined_rows,
  priced: r.priced_rows,
  min_px: r.min_price != null ? Number(r.min_price).toFixed(2) : null,
  max_px: r.max_price != null ? Number(r.max_price).toFixed(2) : null,
})));

process.exit(0);
