/**
 * Debug: check why the broker_credential_id JOIN returns 0 matches.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-cred-join");

const db = getDb();

// Sample orders with cred_id but no account_id - do they join to credentials?
const sample = await db.execute(sql`
  SELECT
    o.id::text as order_id,
    o.broker_credential_id::text as o_cred_id,
    o.broker_account_id as o_acct_id,
    c.id::text as c_id,
    c.account_id as c_acct_id,
    c.provider
  FROM orders o
  LEFT JOIN user_api_credentials c ON o.broker_credential_id = c.id
  WHERE o.broker_account_id IS NULL
    AND o.broker_credential_id IS NOT NULL
  LIMIT 5
`);

console.log("=== Orders with cred_id but no account_id (LEFT JOIN to creds) ===");
console.table((sample.rows as Record<string, unknown>[]).map(r => ({
  order_id: String(r.order_id).slice(0, 8) + "…",
  o_cred_id: String(r.o_cred_id).slice(0, 8) + "…",
  o_acct_id: r.o_acct_id,
  c_id: r.c_id ? String(r.c_id).slice(0, 8) + "…" : null,
  c_acct_id: r.c_acct_id,
  provider: r.provider,
})));

// Check if there are actually cred rows with matching IDs
const credCount = await db.execute(sql`
  SELECT COUNT(*)::int as cred_count,
         MIN(id::text) as sample_id
  FROM user_api_credentials
`);
console.log("\n=== user_api_credentials count ===");
console.table(credCount.rows);

// Check type compatibility
const typeCheck = await db.execute(sql`
  SELECT
    pg_typeof(o.broker_credential_id) as o_cred_type,
    pg_typeof(c.id) as c_id_type
  FROM orders o, user_api_credentials c
  WHERE o.broker_credential_id IS NOT NULL
  LIMIT 1
`);
console.log("\n=== Type compatibility ===");
console.table(typeCheck.rows);

// Check if JOIN actually works with explicit cast
const castJoin = await db.execute(sql`
  SELECT COUNT(*)::int as matches
  FROM orders o
  JOIN user_api_credentials c ON o.broker_credential_id::text = c.id::text
  WHERE o.broker_account_id IS NULL
    AND o.broker_credential_id IS NOT NULL
    AND c.account_id IS NOT NULL
`);
console.log("\n=== JOIN with explicit ::text cast ===");
console.table(castJoin.rows);

process.exit(0);
