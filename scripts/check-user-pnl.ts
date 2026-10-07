/**
 * Check a user's P&L data by email address.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-user-pnl");

const db = getDb();

// Find the user by email (masked in output)
const user = await db.execute(sql`
  SELECT id, name, twitter_name, username FROM users WHERE email = 'napindc@vt.edu' LIMIT 1
`);
const row = user.rows[0] as Record<string, unknown> | undefined;
if (!row) { console.log("User not found"); process.exit(1); }
const userId = row.id as string;
console.log("User found:", { name: row.name, twitter_name: row.twitter_name, username: row.username });

// Check filled orders by venue
const ordersByProvider = await db.execute(sql`
  SELECT
    venue,
    asset_type,
    COUNT(*) AS total_orders,
    COUNT(CASE WHEN status = 'FILLED' THEN 1 END) AS filled_orders,
    COUNT(CASE WHEN status = 'FILLED' AND executed_price IS NOT NULL AND executed_quantity IS NOT NULL THEN 1 END) AS has_price_qty
  FROM orders
  WHERE user_id = ${userId}
  GROUP BY venue, asset_type
`);
console.log("\nOrders by venue/asset_type:");
console.table(ordersByProvider.rows);

// Check HL credentials
const hlCred = await db.execute(sql`
  SELECT provider, account_id, username FROM user_api_credentials WHERE user_id = ${userId}
`);
console.log("\nCredentials:", JSON.stringify(hlCred.rows));

// Check social_trades
const stCount = await db.execute(sql`
  SELECT COUNT(*) as total FROM social_trades WHERE user_id = ${userId}
`);
console.log("\nSocial trades:", stCount.rows[0]);

// Check the leaderboard query for this user specifically
const leaderboardData = await db.execute(sql`
  SELECT
    o.venue,
    o.action,
    o.status,
    o.executed_price,
    o.executed_quantity,
    o.symbol,
    o.realized_pnl,
    o.filled_at
  FROM social_trades st
  INNER JOIN orders o ON (
    (st.order_id IS NOT NULL AND st.order_id = o.id)
    OR (st.broker_order_id IS NOT NULL AND st.broker_order_id = o.broker_order_id AND o.user_id = ${userId})
  )
  WHERE st.user_id = ${userId}
    AND o.status = 'FILLED'
    AND o.executed_price IS NOT NULL
    AND o.executed_quantity IS NOT NULL
    AND o.executed_quantity > 0
  ORDER BY o.filled_at DESC
  LIMIT 20
`);
console.log("\nRecent filled leaderboard-eligible orders:");
console.table(leaderboardData.rows.map((r: Record<string, unknown>) => ({
  venue: r.venue,
  action: r.action,
  symbol: r.symbol,
  price: r.executed_price,
  qty: r.executed_quantity,
  realized_pnl: r.realized_pnl,
  filled_at: String(r.filled_at).slice(0, 19),
})));

process.exit(0);
