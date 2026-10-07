/**
 * Debug: check whether the leaderboard query returns buy+sell pairs
 * and investigate why FIFO shows $0 for all users.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-leaderboard-fifo");

const db = getDb();

// No measurement floor (all-time) to get maximum data
const result = await db.execute(sql`
  SELECT
    st.user_id,
    o.asset_type,
    o.trade_action,
    o.direction,
    CASE
      WHEN lower(o.trade_action::text) LIKE '%buy%' OR lower(o.trade_action::text) LIKE '%cover%' THEN 'buy_side'
      ELSE 'sell_side'
    END as computed_side,
    COUNT(*)::int as count,
    COUNT(CASE WHEN COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days' THEN 1 END)::int as within_30d
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
  GROUP BY st.user_id, o.asset_type, o.trade_action, o.direction, computed_side
  ORDER BY st.user_id, o.asset_type, computed_side
`);

console.log("=== Full leaderboard buy/sell breakdown by user (all time) ===");

// Anonymize
const userMap = new Map<string, string>();
let n = 0;
const rows = (result.rows as Record<string, unknown>[]).map(r => {
  const uid = String(r.user_id);
  if (!userMap.has(uid)) userMap.set(uid, `User${++n}`);
  return {
    user: userMap.get(uid),
    asset_type: r.asset_type,
    trade_action: r.trade_action,
    direction: r.direction,
    computed_side: r.computed_side,
    count: r.count,
    within_30d: r.within_30d,
  };
});
console.table(rows);

// Summary: which users have BOTH buy and sell events?
const buysByUser = new Map<string, number>();
const sellsByUser = new Map<string, number>();
for (const r of result.rows as Record<string, unknown>[]) {
  const uid = String(r.user_id);
  const side = String(r.computed_side);
  const cnt = Number(r.count);
  if (side === 'buy_side') buysByUser.set(uid, (buysByUser.get(uid) ?? 0) + cnt);
  else sellsByUser.set(uid, (sellsByUser.get(uid) ?? 0) + cnt);
}

console.log("\n=== Users with both buy and sell events (FIFO can close lots) ===");
let num2 = 0;
const summaryMap = new Map<string, string>();
const summary = [...new Set([...buysByUser.keys(), ...sellsByUser.keys()])].map(uid => {
  if (!summaryMap.has(uid)) summaryMap.set(uid, `User${++num2}`);
  return {
    user: summaryMap.get(uid),
    buys: buysByUser.get(uid) ?? 0,
    sells: sellsByUser.get(uid) ?? 0,
    can_close: (sellsByUser.get(uid) ?? 0) > 0 ? "YES" : "no",
  };
});
console.table(summary);

process.exit(0);
