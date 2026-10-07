/**
 * Debug: check Alpaca credentials and order eligibility for SOL Decoder.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-credentials");

const db = getDb();

// Check credentials for SOL Decoder
const creds = await db.execute(sql`
  SELECT
    c.id,
    c.provider,
    c.account_type,
    c.account_id
  FROM user_api_credentials c
  INNER JOIN users u ON c.user_id = u.id AND u.twitter_name = 'SOL Decoder'
`);

console.log("=== SOL Decoder credentials ===");
console.table(creds.rows.map((r: Record<string, unknown>) => ({
  id: String(r.id).slice(0, 8) + "…",
  provider: r.provider,
  account_type: r.account_type,
  account_id: r.account_id,
})));

// Check how many orders are excluded by publiclyEligibleOrderCondition
const excluded = await db.execute(sql`
  SELECT COUNT(*)::int as excluded_count
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  WHERE EXISTS (
    SELECT 1 FROM user_api_credentials c
    WHERE c.provider = 'alpaca'
      AND c.account_type IN ('PAPER', 'SIM')
      AND (
        c.id = o.broker_credential_id
        OR (o.broker_credential_id IS NULL AND c.user_id = o.user_id AND o.broker_account_id IS NOT NULL AND c.account_id = o.broker_account_id)
      )
  )
`);

const notExcluded = await db.execute(sql`
  SELECT COUNT(*)::int as eligible_count
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  WHERE
    o.executed_price IS NOT NULL AND o.executed_price::numeric > 0
    AND o.executed_quantity > 0
    AND NOT EXISTS (
      SELECT 1 FROM user_api_credentials c
      WHERE c.provider = 'alpaca'
        AND c.account_type IN ('PAPER', 'SIM')
        AND (
          c.id = o.broker_credential_id
          OR (o.broker_credential_id IS NULL AND c.user_id = o.user_id AND o.broker_account_id IS NOT NULL AND c.account_id = o.broker_account_id)
        )
    )
`);

console.log("\n=== Eligibility check ===");
console.log("Excluded by paper/SIM check:", excluded.rows[0]);
console.log("Eligible (price+qty+live):", notExcluded.rows[0]);

process.exit(0);
