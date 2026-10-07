/**
 * One-time backfill: populate orders.broker_account_id and orders.broker_credential_id
 * so every order has both fields.
 *
 * Root cause: older code only set broker_account_id, newer code only set
 * broker_credential_id. The leaderboard's FIFO bucket key requires BOTH to
 * be non-null (hasExplicitPositionScope). When either is null, every order
 * gets a unique bucket and buy/sell pairs can never be FIFO-matched, causing
 * $0 P&L for all users.
 *
 * Two-pass fix:
 * 1. Fill broker_account_id from the credential (direct FK lookup, safe 1:1).
 * 2. Fill broker_credential_id from the credential using account_id match
 *    (only when exactly one credential matches, to avoid ambiguity).
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("backfill-order-scope");

const DRY_RUN = process.argv.includes("--dry-run");
if (DRY_RUN) {
  console.log("[backfill-order-scope] DRY RUN — no rows will be updated.");
}

const db = getDb();

// Check current state
const before = await db.execute(sql`
  SELECT
    COUNT(*)::int as total,
    COUNT(broker_account_id)::int as with_account_id,
    COUNT(broker_credential_id)::int as with_cred_id,
    COUNT(CASE WHEN broker_account_id IS NOT NULL AND broker_credential_id IS NOT NULL THEN 1 END)::int as with_both,
    COUNT(CASE WHEN broker_account_id IS NULL AND broker_credential_id IS NULL THEN 1 END)::int as with_neither
  FROM orders
`);
console.log("=== Before ===");
console.table(before.rows);

// Step 1: Fill broker_account_id from credential (direct FK, safe 1:1)
const step1Preview = await db.execute(sql`
  SELECT COUNT(*)::int as would_update
  FROM orders o
  JOIN user_api_credentials c ON o.broker_credential_id = c.id
  WHERE o.broker_account_id IS NULL
    AND c.account_id IS NOT NULL
`);
console.log(`\nStep 1: Fill broker_account_id from credential FK`);
console.log(`  Would update: ${(step1Preview.rows[0] as Record<string, unknown>).would_update} orders`);

if (!DRY_RUN) {
  const step1 = await db.execute(sql`
    UPDATE orders o
    SET broker_account_id = c.account_id
    FROM user_api_credentials c
    WHERE o.broker_credential_id = c.id
      AND o.broker_account_id IS NULL
      AND c.account_id IS NOT NULL
  `);
  console.log(`  Updated: ${(step1 as unknown as { rowCount: number }).rowCount ?? "?"} orders`);
}

// Step 2: Fill broker_credential_id from credential (account_id match, only when unambiguous)
const step2Preview = await db.execute(sql`
  SELECT COUNT(*)::int as would_update
  FROM orders o
  WHERE o.broker_account_id IS NOT NULL
    AND o.broker_credential_id IS NULL
    AND EXISTS (
      SELECT 1 FROM user_api_credentials c
      WHERE c.account_id = o.broker_account_id
        AND c.user_id = o.user_id
    )
    AND NOT EXISTS (
      -- Only update if exactly one credential matches (unambiguous)
      SELECT 1 FROM (
        SELECT id FROM user_api_credentials c
        WHERE c.account_id = o.broker_account_id
          AND c.user_id = o.user_id
        OFFSET 1
      ) extra
    )
`);
console.log(`\nStep 2: Fill broker_credential_id from credential (account_id match)`);
console.log(`  Would update: ${(step2Preview.rows[0] as Record<string, unknown>).would_update} orders`);

if (!DRY_RUN) {
  const step2 = await db.execute(sql`
    UPDATE orders o
    SET broker_credential_id = (
      SELECT c.id FROM user_api_credentials c
      WHERE c.account_id = o.broker_account_id
        AND c.user_id = o.user_id
      LIMIT 1
    )
    WHERE o.broker_account_id IS NOT NULL
      AND o.broker_credential_id IS NULL
      AND EXISTS (
        SELECT 1 FROM user_api_credentials c
        WHERE c.account_id = o.broker_account_id
          AND c.user_id = o.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT id FROM user_api_credentials c
          WHERE c.account_id = o.broker_account_id
            AND c.user_id = o.user_id
          OFFSET 1
        ) extra
      )
  `);
  console.log(`  Updated: ${(step2 as unknown as { rowCount: number }).rowCount ?? "?"} orders`);
}

// Check result
const after = await db.execute(sql`
  SELECT
    COUNT(*)::int as total,
    COUNT(broker_account_id)::int as with_account_id,
    COUNT(broker_credential_id)::int as with_cred_id,
    COUNT(CASE WHEN broker_account_id IS NOT NULL AND broker_credential_id IS NOT NULL THEN 1 END)::int as with_both,
    COUNT(CASE WHEN broker_account_id IS NULL AND broker_credential_id IS NULL THEN 1 END)::int as with_neither
  FROM orders
`);
console.log("\n=== After ===");
console.table(after.rows);

// Verify leaderboard scope coverage
const scopeCoverage = await db.execute(sql`
  SELECT
    o.venue,
    COUNT(*)::int as total,
    COUNT(CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL THEN 1 END)::int as has_explicit_scope,
    COUNT(CASE WHEN NOT (o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL) THEN 1 END)::int as missing_scope
  FROM social_trades st
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR
    (
      st.user_id = o.user_id AND st.order_id IS NULL
      AND st.broker_order_id IS NOT NULL
      AND st.broker_order_id = o.broker_order_id
    )
  )
  GROUP BY o.venue
`);
console.log("\n=== Leaderboard scope coverage after backfill ===");
console.table(scopeCoverage.rows);

process.exit(0);
