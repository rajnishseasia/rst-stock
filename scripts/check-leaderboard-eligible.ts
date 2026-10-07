/**
 * Debug: check how many social_trades rows pass ALL leaderboard conditions
 * including executedQuantity > 0 and executedSizeDecimal for PERPs.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-leaderboard-eligible");

const db = getDb();

const result = await db.execute(sql`
  SELECT
    u.twitter_name,
    u.username,
    o.asset_type,
    COUNT(st.id)::int as joined,
    COUNT(CASE WHEN o.executed_quantity > 0 THEN 1 END)::int as with_qty,
    COUNT(CASE WHEN o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0 THEN 1 END)::int as perp_with_size,
    COUNT(CASE
      WHEN o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0 THEN 1
      WHEN o.asset_type != 'PERP' AND o.executed_quantity > 0 THEN 1
    END)::int as leaderboard_eligible
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
        AND (c.id = o.broker_credential_id OR (o.broker_credential_id IS NULL AND c.user_id = o.user_id AND o.broker_account_id IS NOT NULL AND c.account_id = o.broker_account_id))
    )
  GROUP BY u.id, u.twitter_name, u.username, o.asset_type
  ORDER BY joined DESC
`);

console.table(result.rows.map((r: Record<string, unknown>) => ({
  name: r.twitter_name || r.username || "(anon)",
  assetType: r.asset_type,
  joined: r.joined,
  with_qty: r.with_qty,
  perp_size: r.perp_with_size,
  eligible: r.leaderboard_eligible,
})));

process.exit(0);
