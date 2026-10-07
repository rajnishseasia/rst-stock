/**
 * Debug: run the exact leaderboard canonical event subquery and see what it returns.
 * This mimics buildLeaderboardCanonicalEventSubquery from leaderboard.ts.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-leaderboard-query");

const db = getDb();

// Measurement floor: 30 days ago
const measurementFloor = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

const result = await db.execute(sql`
  SELECT
    st.id as social_trade_id,
    st.user_id,
    st.order_id,
    st.broker_order_id as st_boid,
    o.id as order_id_joined,
    o.asset_type,
    o.trade_action,
    o.direction,
    o.executed_price,
    o.executed_quantity,
    o.executed_size_decimal,
    o.status,
    o.executed_at,
    st.created_at,
    COALESCE(o.executed_at, st.created_at) as venue_event_ts,
    u.twitter_name
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id
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
  WHERE
    -- leaderboardRealFillCondition
    o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'PARTIAL')
    AND o.executed_price IS NOT NULL
    AND o.executed_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
    AND o.executed_price::numeric > 0
    AND o.executed_price::numeric <= 1000000000
    AND (
      (
        o.asset_type = 'PERP'
        AND o.executed_size_decimal IS NOT NULL
        AND o.executed_size_decimal::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND o.executed_size_decimal::numeric > 0
      )
      OR (
        o.asset_type != 'PERP'
        AND o.executed_quantity IS NOT NULL
        AND o.executed_quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND o.executed_quantity > 0
        AND o.executed_quantity <= 1000000000
        -- validOptionContractCondition
        AND (
          o.asset_type != 'OPTION'
          OR (
            o.option_expiration ~ '^[0-9]{6}$'
            AND to_char(to_date(o.option_expiration, 'YYMMDD'), 'YYMMDD') = o.option_expiration
            AND o.option_strike::text NOT IN ('NaN', 'Infinity', '-Infinity')
            AND o.option_strike::numeric > 0
            AND o.option_type IN ('CALL', 'PUT')
          )
        )
      )
    )
    -- publiclyEligibleOrderCondition
    AND NOT EXISTS (
      SELECT 1 FROM user_api_credentials c
      WHERE c.provider = 'alpaca'
        AND c.account_type IN ('PAPER', 'SIM')
        AND (
          c.id = o.broker_credential_id
          OR (
            o.broker_credential_id IS NULL
            AND c.user_id = o.user_id
            AND o.broker_account_id IS NOT NULL
            AND c.account_id = o.broker_account_id
          )
        )
    )
    -- measurement floor (30d window)
    AND COALESCE(o.executed_at, st.created_at) >= ${measurementFloor.toISOString()}
  ORDER BY COALESCE(o.executed_at, st.created_at), st.id, o.id
  LIMIT 30001
`);

console.log(`=== Leaderboard canonical event query (30d window) ===`);
console.log(`Total rows returned: ${result.rows.length}`);

// Count by user (anonymized)
const byUser = new Map<string, number>();
for (const r of result.rows) {
  const uid = String((r as Record<string, unknown>).user_id);
  byUser.set(uid, (byUser.get(uid) ?? 0) + 1);
}
console.log(`Users with data: ${byUser.size}`);
console.table([...byUser.entries()].map(([uid, cnt]) => ({
  user_id: uid.slice(0, 8) + "…",
  row_count: cnt,
})));

// Show first 10 rows
if (result.rows.length > 0) {
  console.log("\nFirst 10 rows:");
  console.table(result.rows.slice(0, 10).map((r: Record<string, unknown>) => ({
    user: r.twitter_name ?? "(anon)",
    asset_type: r.asset_type,
    trade_action: r.trade_action,
    direction: r.direction,
    price: r.executed_price,
    qty: r.executed_quantity,
    size: r.executed_size_decimal,
    status: r.status,
    venue_ts: r.venue_event_ts,
  })));
}

process.exit(0);
