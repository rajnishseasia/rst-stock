/**
 * Preview which users/venues would be fixed by the scope backfill step 1.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-scope-preview");

const db = getDb();

// Which users/venues would step 1 cover?
const coverage = await db.execute(sql`
  SELECT
    u.twitter_name,
    o.venue,
    COUNT(*)::int as orders_to_fix,
    COUNT(CASE WHEN st.id IS NOT NULL THEN 1 END)::int as in_social_trades
  FROM orders o
  LEFT JOIN users u ON o.user_id = u.id
  LEFT JOIN social_trades st ON st.order_id = o.id
  WHERE o.broker_credential_id IS NULL
    AND o.broker_account_id IS NOT NULL
    AND o.venue IS NOT NULL
    AND o.broker_account_id NOT LIKE 'PA%'
    AND (
      SELECT COUNT(*) FROM user_api_credentials c2
      WHERE c2.user_id = o.user_id
        AND lower(c2.provider) = lower(o.venue)
        AND c2.account_type NOT IN ('PAPER', 'SIM')
    ) = 1
  GROUP BY u.id, u.twitter_name, o.venue
  ORDER BY orders_to_fix DESC
`);

console.log("=== Step 1 preview: users covered ===");
console.table((coverage.rows as Record<string, unknown>[]).map(r => ({
  user: r.twitter_name ?? "(anon)",
  venue: r.venue,
  orders_to_fix: r.orders_to_fix,
  in_social_trades: r.in_social_trades,
})));

// Also check: after steps 1+2+3, what would be the explicit scope coverage?
// Simulate: how many unique (user, cred) pairs exist among step-1 candidates?
const simulated = await db.execute(sql`
  SELECT COUNT(DISTINCT o.user_id || ':' || o.broker_account_id || ':' || lower(o.venue))::int as unique_account_positions
  FROM orders o
  WHERE o.broker_credential_id IS NULL
    AND o.broker_account_id IS NOT NULL
    AND o.venue IS NOT NULL
    AND o.broker_account_id NOT LIKE 'PA%'
    AND (
      SELECT COUNT(*) FROM user_api_credentials c2
      WHERE c2.user_id = o.user_id
        AND lower(c2.provider) = lower(o.venue)
        AND c2.account_type NOT IN ('PAPER', 'SIM')
    ) = 1
`);
console.log("\n=== Unique account positions to be linked ===");
console.table(simulated.rows);

process.exit(0);
