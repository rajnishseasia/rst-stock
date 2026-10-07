/**
 * Debug: check if orders have the scope fields needed for FIFO bucket matching.
 * If brokerAccountId, brokerCredentialId, or venue is null, each order gets
 * a unique bucket key and FIFO can never close a lot.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-bucket-scope");

const db = getDb();

// Check scope field coverage for all orders in social_trades (full authoritative join)
const scope = await db.execute(sql`
  SELECT
    o.venue,
    COUNT(*)::int as total,
    COUNT(o.broker_account_id)::int as with_broker_account_id,
    COUNT(o.broker_credential_id)::int as with_broker_credential_id,
    COUNT(o.venue)::int as with_venue,
    COUNT(CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL THEN 1 END)::int as has_explicit_scope
  FROM social_trades st
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (
      st.user_id = o.user_id
      AND st.order_id IS NULL
      AND st.broker_order_id IS NOT NULL
      AND st.broker_order_id = o.broker_order_id
      AND NOT EXISTS (
        SELECT 1 FROM orders oo
        WHERE oo.user_id = st.user_id
          AND oo.broker_order_id = st.broker_order_id
          AND (
            oo.broker_account_id IS DISTINCT FROM o.broker_account_id
            OR oo.broker_credential_id IS DISTINCT FROM o.broker_credential_id
            OR lower(coalesce(oo.venue, '')) IS DISTINCT FROM lower(coalesce(o.venue, ''))
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders oo
        WHERE oo.user_id = o.user_id
          AND oo.broker_order_id = o.broker_order_id
          AND oo.broker_account_id IS NOT DISTINCT FROM o.broker_account_id
          AND oo.broker_credential_id IS NOT DISTINCT FROM o.broker_credential_id
          AND lower(coalesce(oo.venue, '')) IS NOT DISTINCT FROM lower(coalesce(o.venue, ''))
          AND oo.id != o.id
      )
    )
  )
  GROUP BY o.venue
  ORDER BY total DESC
`);

console.log("=== Order scope field coverage by venue (all social_trades) ===");
console.table(scope.rows);

// For SOL Decoder specifically (User5 in our anon mapping = PyZ3HFT7...)
const solScope = await db.execute(sql`
  SELECT
    o.venue,
    o.asset_type,
    COUNT(*)::int as total,
    COUNT(o.broker_account_id)::int as with_broker_account_id,
    COUNT(o.broker_credential_id)::int as with_broker_credential_id,
    COUNT(o.venue)::int as with_venue,
    COUNT(CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL THEN 1 END)::int as has_explicit_scope
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (
      st.user_id = o.user_id
      AND st.order_id IS NULL
      AND st.broker_order_id IS NOT NULL
      AND st.broker_order_id = o.broker_order_id
      AND NOT EXISTS (
        SELECT 1 FROM orders oo
        WHERE oo.user_id = st.user_id
          AND oo.broker_order_id = st.broker_order_id
          AND (
            oo.broker_account_id IS DISTINCT FROM o.broker_account_id
            OR oo.broker_credential_id IS DISTINCT FROM o.broker_credential_id
            OR lower(coalesce(oo.venue, '')) IS DISTINCT FROM lower(coalesce(o.venue, ''))
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders oo
        WHERE oo.user_id = o.user_id
          AND oo.broker_order_id = o.broker_order_id
          AND oo.broker_account_id IS NOT DISTINCT FROM o.broker_account_id
          AND oo.broker_credential_id IS NOT DISTINCT FROM o.broker_credential_id
          AND lower(coalesce(oo.venue, '')) IS NOT DISTINCT FROM lower(coalesce(o.venue, ''))
          AND oo.id != o.id
      )
    )
  )
  GROUP BY o.venue, o.asset_type
  ORDER BY o.venue, o.asset_type
`);

console.log("\n=== SOL Decoder scope field coverage by venue + asset_type ===");
console.table(solScope.rows);

// Show the actual bucket key computation for a few SOL Decoder rows
const sample = await db.execute(sql`
  SELECT
    st.id as social_trade_id,
    o.asset_type,
    o.trade_action::text,
    o.symbol,
    o.broker_account_id,
    o.broker_credential_id,
    o.venue,
    o.broker_order_id,
    CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL
      THEN 'explicit_scope'
      ELSE 'unknown_scope'
    END as scope_type
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  WHERE o.executed_price::numeric > 0
    AND o.asset_type = 'EQUITY'
  ORDER BY COALESCE(o.executed_at, st.created_at)
  LIMIT 15
`);

console.log("\n=== SOL Decoder EQUITY sample rows (scope check) ===");
console.table((sample.rows as Record<string, unknown>[]).map(r => ({
  st_id: String(r.social_trade_id).slice(0, 8) + "…",
  asset: r.asset_type,
  action: r.trade_action,
  symbol: r.symbol,
  has_acct: r.broker_account_id !== null ? String(r.broker_account_id).slice(0, 8) + "…" : null,
  has_cred: r.broker_credential_id !== null ? String(r.broker_credential_id).slice(0, 8) + "…" : null,
  venue: r.venue,
  scope_type: r.scope_type,
})));

process.exit(0);
