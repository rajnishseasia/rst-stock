/**
 * Debug: check tradeAction distribution in social_trades for SOL Decoder
 * to see if FIFO buy/sell pairs can be formed.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("debug-trade-actions");

const db = getDb();

// Check tradeAction distribution
const actions = await db.execute(sql`
  SELECT
    o.asset_type,
    o.trade_action,
    o.direction,
    COUNT(*)::int as count,
    COUNT(CASE WHEN COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days' THEN 1 END)::int as within_30d
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  WHERE o.executed_price::numeric > 0
    AND (o.executed_quantity > 0 OR (o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0))
  GROUP BY o.asset_type, o.trade_action, o.direction
  ORDER BY o.asset_type, o.trade_action
`);

console.log("=== SOL Decoder trade actions (eligible rows) ===");
console.table(actions.rows);

// Check all users (anonymized)
const allActions = await db.execute(sql`
  SELECT
    u.id,
    o.asset_type,
    o.trade_action,
    o.direction,
    COUNT(*)::int as count
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id
  INNER JOIN orders o ON st.order_id = o.id
  WHERE o.executed_price::numeric > 0
    AND (o.executed_quantity > 0 OR (o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0))
  GROUP BY u.id, o.asset_type, o.trade_action, o.direction
  ORDER BY u.id, o.asset_type, o.trade_action
`);

console.log("\n=== All users trade actions distribution (anonymized) ===");
// Anonymize user IDs
const userIdMap = new Map<string, string>();
let userNum = 0;
const rows = allActions.rows.map((r: Record<string, unknown>) => {
  const uid = String(r.id);
  if (!userIdMap.has(uid)) {
    userIdMap.set(uid, `User${++userNum}`);
  }
  return {
    user: userIdMap.get(uid),
    asset_type: r.asset_type,
    trade_action: r.trade_action,
    direction: r.direction,
    count: r.count,
  };
});
console.table(rows);

// Quick sanity: does SOL Decoder have both buy and sell type events?
const buySell = await db.execute(sql`
  SELECT
    CASE
      WHEN o.trade_action IN ('BUY', 'BUY_TO_COVER') THEN 'buy_side'
      WHEN o.trade_action IN ('SELL', 'SELL_SHORT') THEN 'sell_side'
      ELSE 'other'
    END as side,
    COUNT(*)::int as count
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  WHERE o.executed_price::numeric > 0
    AND o.executed_quantity > 0
    AND COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days'
  GROUP BY side
`);

console.log("\n=== SOL Decoder buy/sell sides (within 30d, equity) ===");
console.table(buySell.rows);

process.exit(0);
