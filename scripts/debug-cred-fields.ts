/**
 * Debug: inspect user_api_credentials fields to understand the mismatch.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-cred-fields");

const db = getDb();

// Get all column names from user_api_credentials
const cols = await db.execute(sql`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'user_api_credentials'
  ORDER BY ordinal_position
`);
console.log("=== user_api_credentials columns ===");
console.table(cols.rows);

// Sample the actual credential data (anonymized)
const sample = await db.execute(sql`
  SELECT
    id::text as id,
    provider,
    account_type,
    CASE WHEN account_id IS NOT NULL THEN 'SET' ELSE 'null' END as account_id_status
  FROM user_api_credentials
  WHERE provider IN ('alpaca', 'hyperliquid')
  ORDER BY provider, created_at
  LIMIT 15
`);
console.log("\n=== Credential sample (anonymized) ===");
console.table((sample.rows as Record<string, unknown>[]).map(r => ({
  id: String(r.id).slice(0, 8) + "…",
  provider: r.provider,
  account_type: r.account_type,
  account_id_status: r.account_id_status,
})));

// Now check if the order's broker_account_id might match a different field in credentials
const brokerAcctSample = await db.execute(sql`
  SELECT DISTINCT
    o.broker_account_id,
    o.venue
  FROM orders o
  WHERE o.broker_account_id IS NOT NULL
    AND o.broker_credential_id IS NULL
  LIMIT 5
`);
console.log("\n=== Sample broker_account_id values from orders (no cred_id) ===");
console.table(brokerAcctSample.rows.map((r: Record<string, unknown>) => ({
  broker_account_id: r.broker_account_id,
  venue: r.venue,
})));

// Check if credentials have any field that matches broker_account_id
const match = await db.execute(sql`
  SELECT
    o.broker_account_id,
    c.id::text as cred_id,
    c.provider,
    c.account_type
  FROM orders o
  LEFT JOIN user_api_credentials c ON (
    c.user_id = o.user_id
    AND c.provider = lower(o.venue)
  )
  WHERE o.broker_account_id IS NOT NULL
    AND o.broker_credential_id IS NULL
  LIMIT 10
`);
console.log("\n=== Orders matched to credentials by user_id + venue ===");
console.table((match.rows as Record<string, unknown>[]).map(r => ({
  acct_id: r.broker_account_id,
  cred_id: r.cred_id ? String(r.cred_id).slice(0, 8) + "…" : null,
  provider: r.provider,
  account_type: r.account_type,
})));

// Check: how many orders have account_id, no cred_id, and exactly one live credential for that venue?
const unambiguous = await db.execute(sql`
  SELECT COUNT(*)::int as orders_with_unambiguous_cred_match
  FROM orders o
  WHERE o.broker_account_id IS NOT NULL
    AND o.broker_credential_id IS NULL
    AND o.venue IS NOT NULL
    AND (
      SELECT COUNT(*) FROM user_api_credentials c
      WHERE c.user_id = o.user_id
        AND lower(c.provider) = lower(o.venue)
        AND c.account_type NOT IN ('PAPER', 'SIM')
    ) = 1
`);
console.log("\n=== Orders with unambiguous credential match (user + venue) ===");
console.table(unambiguous.rows);

process.exit(0);
