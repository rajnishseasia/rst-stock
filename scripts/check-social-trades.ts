/**
 * Debug: show social_trades counts per user and confirm orders join correctly.
 */
import { getDb, schema } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-social-trades");

const db = getDb();

const result = await db.execute(sql`
  SELECT
    u.twitter_name,
    u.username,
    COUNT(st.id)::int AS social_trade_count,
    COUNT(CASE WHEN o.executed_price::numeric > 0 THEN 1 END)::int AS with_price,
    COUNT(CASE WHEN o.id IS NULL THEN 1 END)::int AS missing_order
  FROM social_trades st
  JOIN users u ON st.user_id = u.id
  LEFT JOIN orders o ON st.order_id = o.id
  GROUP BY u.id, u.twitter_name, u.username
  ORDER BY social_trade_count DESC
  LIMIT 10
`);

console.table(result.rows.map((r: Record<string, unknown>) => ({
  name: r.twitter_name || r.username || "(anon)",
  social_trades: r.social_trade_count,
  with_price: r.with_price,
  missing_order: r.missing_order,
})));

process.exit(0);
