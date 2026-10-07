/**
 * Backfill broker_account_id and broker_credential_id on orders so FIFO
 * bucket matching in the leaderboard works correctly.
 *
 * Root cause: some orders have broker_account_id only (older code path),
 * others have broker_credential_id only (newer code path). The leaderboard
 * positionBucketKey requires hasExplicitPositionScope = true (all three:
 * broker_account_id, broker_credential_id, venue non-null). When either
 * field is missing, every order gets a unique per-order bucket and FIFO
 * can never pair buys with sells, causing $0 P&L for all users.
 *
 * Three-step fix:
 *
 * Step 1: Fill broker_credential_id into orders that have broker_account_id
 *   but no broker_credential_id, using user + venue + LIVE credential match.
 *   Only when exactly one LIVE credential exists for that user+venue.
 *   Skips PAPER-looking account IDs (Alpaca "PA..." prefix) for safety.
 *
 * Step 2: Populate user_api_credentials.account_id from orders that now
 *   have both fields (after Step 1 links them).
 *
 * Step 3: Fill broker_account_id into orders that have broker_credential_id
 *   but no broker_account_id, using the now-populated credential account_id.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("backfill-order-scope-v2");

const DRY_RUN = process.argv.includes("--dry-run");
if (DRY_RUN) {
  console.log("[backfill-order-scope-v2] DRY RUN — no rows will be changed.");
}

const db = getDb();

// ---- Before state ----
const before = await db.execute(sql`
  SELECT
    COUNT(*)::int as total_orders,
    COUNT(broker_account_id)::int as with_acct,
    COUNT(broker_credential_id)::int as with_cred,
    COUNT(CASE WHEN broker_account_id IS NOT NULL AND broker_credential_id IS NOT NULL THEN 1 END)::int as with_both
  FROM orders
`);
console.log("=== Before ===");
console.table(before.rows);

// ---- Step 1: link old orders (account_id only) to their credential ----
// Match by user_id + venue + exactly one LIVE credential
// Safety: skip orders whose broker_account_id looks like an Alpaca PAPER ID ("PA...").

const step1Preview = await db.execute(sql`
  SELECT COUNT(*)::int as would_update
  FROM orders o
  WHERE o.broker_credential_id IS NULL
    AND o.broker_account_id IS NOT NULL
    AND o.venue IS NOT NULL
    -- Skip obvious Alpaca PAPER account IDs
    AND o.broker_account_id NOT LIKE 'PA%'
    -- Exactly one LIVE credential exists for this user+venue
    AND (
      SELECT COUNT(*) FROM user_api_credentials c2
      WHERE c2.user_id = o.user_id
        AND lower(c2.provider) = lower(o.venue)
        AND c2.account_type NOT IN ('PAPER', 'SIM')
    ) = 1
`);
console.log(`\nStep 1: Fill broker_credential_id from user+venue+LIVE match`);
console.log(`  Would update: ${(step1Preview.rows[0] as Record<string, unknown>).would_update} orders`);

if (!DRY_RUN) {
  await db.execute(sql`
    UPDATE orders o
    SET broker_credential_id = (
      SELECT c2.id FROM user_api_credentials c2
      WHERE c2.user_id = o.user_id
        AND lower(c2.provider) = lower(o.venue)
        AND c2.account_type NOT IN ('PAPER', 'SIM')
      LIMIT 1
    )
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
  const after1 = await db.execute(sql`
    SELECT COUNT(CASE WHEN broker_account_id IS NOT NULL AND broker_credential_id IS NOT NULL THEN 1 END)::int as with_both
    FROM orders
  `);
  console.log(`  Orders with both now: ${(after1.rows[0] as Record<string, unknown>).with_both}`);
}

// ---- Step 2: Populate credentials.account_id from linked orders ----
const step2Preview = await db.execute(sql`
  SELECT COUNT(*)::int as would_update
  FROM user_api_credentials c
  WHERE c.account_id IS NULL
    AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.broker_credential_id = c.id
        AND o.broker_account_id IS NOT NULL
    )
`);
console.log(`\nStep 2: Populate credentials.account_id from linked orders`);
console.log(`  Would update: ${(step2Preview.rows[0] as Record<string, unknown>).would_update} credentials`);

if (!DRY_RUN) {
  await db.execute(sql`
    UPDATE user_api_credentials c
    SET account_id = (
      SELECT MIN(o.broker_account_id)
      FROM orders o
      WHERE o.broker_credential_id = c.id
        AND o.broker_account_id IS NOT NULL
    )
    WHERE c.account_id IS NULL
      AND EXISTS (
        SELECT 1 FROM orders o
        WHERE o.broker_credential_id = c.id
          AND o.broker_account_id IS NOT NULL
      )
  `);
  console.log(`  Done.`);
}

// ---- Step 3: Fill broker_account_id from credential (now populated) ----
const step3Preview = await db.execute(sql`
  SELECT COUNT(*)::int as would_update
  FROM orders o
  JOIN user_api_credentials c ON o.broker_credential_id = c.id
  WHERE o.broker_account_id IS NULL
    AND c.account_id IS NOT NULL
`);
console.log(`\nStep 3: Fill broker_account_id from credential.account_id`);
console.log(`  Would update: ${(step3Preview.rows[0] as Record<string, unknown>).would_update} orders`);

if (!DRY_RUN) {
  await db.execute(sql`
    UPDATE orders o
    SET broker_account_id = c.account_id
    FROM user_api_credentials c
    WHERE o.broker_credential_id = c.id
      AND o.broker_account_id IS NULL
      AND c.account_id IS NOT NULL
  `);
  console.log(`  Done.`);
}

// ---- After state ----
const after = await db.execute(sql`
  SELECT
    COUNT(*)::int as total_orders,
    COUNT(broker_account_id)::int as with_acct,
    COUNT(broker_credential_id)::int as with_cred,
    COUNT(CASE WHEN broker_account_id IS NOT NULL AND broker_credential_id IS NOT NULL THEN 1 END)::int as with_both
  FROM orders
`);
console.log("\n=== After ===");
console.table(after.rows);

// ---- Verify leaderboard scope coverage ----
const scope = await db.execute(sql`
  SELECT
    o.venue,
    COUNT(*)::int as total,
    COUNT(CASE WHEN o.broker_account_id IS NOT NULL AND o.broker_credential_id IS NOT NULL AND o.venue IS NOT NULL THEN 1 END)::int as has_explicit_scope
  FROM social_trades st
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR (st.user_id = o.user_id AND st.order_id IS NULL AND st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id)
  )
  WHERE o.venue IS NOT NULL
  GROUP BY o.venue
`);
console.log("\n=== Leaderboard scope coverage ===");
console.table(scope.rows);

process.exit(0);
