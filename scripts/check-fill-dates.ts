import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-fill-dates");

const db = getDb();

const result = await db.execute(sql`
  SELECT
    MIN(COALESCE(o.executed_at, st.created_at)) as earliest_fill,
    MAX(COALESCE(o.executed_at, st.created_at)) as latest_fill,
    COUNT(*) FILTER (WHERE COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days')::int as within_30d,
    COUNT(*) FILTER (WHERE COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '7 days')::int as within_7d,
    COUNT(*)::int as total_joined
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON st.order_id = o.id
  WHERE o.executed_price::numeric > 0
    AND (o.executed_quantity > 0 OR (o.asset_type = 'PERP' AND o.executed_size_decimal::numeric > 0))
`);

console.log("SOL Decoder fill date range:");
const row = result.rows[0] as Record<string, unknown>;
console.log("  Earliest fill:", row.earliest_fill);
console.log("  Latest fill:  ", row.latest_fill);
console.log("  Total joined: ", row.total_joined);
console.log("  Within 30d:  ", row.within_30d);
console.log("  Within 7d:   ", row.within_7d);

// Also check all users
const allUsers = await db.execute(sql`
  SELECT
    u.twitter_name,
    COUNT(*) FILTER (WHERE COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '30 days')::int as within_30d,
    COUNT(*) FILTER (WHERE COALESCE(o.executed_at, st.created_at) > NOW() - INTERVAL '7 days')::int as within_7d,
    COUNT(*)::int as total
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id
  INNER JOIN orders o ON st.order_id = o.id
  WHERE o.executed_price::numeric > 0
  GROUP BY u.id, u.twitter_name
  ORDER BY total DESC
`);

console.log("\nAll users fill date coverage:");
console.table(allUsers.rows.map((r: Record<string, unknown>) => ({
  name: r.twitter_name || "(anon)",
  total: r.total,
  within_30d: r.within_30d,
  within_7d: r.within_7d,
})));

process.exit(0);
