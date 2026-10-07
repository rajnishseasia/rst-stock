/**
 * Check bucket scope fields for SOL Decoder's HL PERP orders.
 * This tells us why FIFO isn't matching buy/sell pairs.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-hl-scope");

const db = getDb();
const user = await db.execute(sql`SELECT id FROM users WHERE email = 'napindc@vt.edu' LIMIT 1`);
const userId = (user.rows[0] as Record<string, unknown>)?.id as string | undefined;
if (!userId) { console.log("not found"); process.exit(1); }

const rows = await db.execute(sql`
  SELECT
    symbol,
    trade_action,
    status,
    (broker_account_id IS NOT NULL)::boolean as has_account,
    (broker_credential_id IS NOT NULL)::boolean as has_cred,
    (venue IS NOT NULL)::boolean as has_venue,
    LEFT(broker_account_id, 8) as acct_prefix,
    LEFT(broker_credential_id::text, 8) as cred_prefix,
    executed_size_decimal,
    executed_price,
    realized_pnl
  FROM orders
  WHERE user_id = ${userId}
    AND venue = 'hyperliquid'
    AND asset_type = 'PERP'
    AND status = 'FILLED'
  ORDER BY executed_at DESC
  LIMIT 30
`);

console.log("HL filled orders - bucket scope:");
console.table(rows.rows);

// Count how many have full scope vs not
const counts = await db.execute(sql`
  SELECT
    (broker_account_id IS NOT NULL AND broker_credential_id IS NOT NULL AND venue IS NOT NULL)::boolean as full_scope,
    COUNT(*) as count
  FROM orders
  WHERE user_id = ${userId}
    AND venue = 'hyperliquid'
    AND asset_type = 'PERP'
    AND status = 'FILLED'
  GROUP BY full_scope
`);
console.log("\nScope coverage:");
console.table(counts.rows);

process.exit(0);
