/**
 * Check HL order data for SOL Decoder to diagnose leaderboard P&L = $0.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("check-hl-orders");

const db = getDb();

const user = await db.execute(sql`
  SELECT id FROM users WHERE email = 'napindc@vt.edu' LIMIT 1
`);
const userId = (user.rows[0] as Record<string, unknown>)?.id as string | undefined;
if (!userId) { console.log("User not found"); process.exit(1); }

// Check HL PERP orders with the fields the leaderboard needs
const hlOrders = await db.execute(sql`
  SELECT
    id,
    status,
    trade_action,
    symbol,
    executed_price,
    executed_quantity,
    executed_size_decimal,
    realized_pnl,
    executed_at,
    created_at
  FROM orders
  WHERE user_id = ${userId}
    AND venue = 'hyperliquid'
    AND asset_type = 'PERP'
  ORDER BY created_at DESC
  LIMIT 30
`);

console.log("\n=== SOL Decoder HL PERP orders ===");
console.table(hlOrders.rows.map((r: Record<string, unknown>) => ({
  status: r.status,
  action: r.trade_action,
  symbol: r.symbol,
  exec_price: r.executed_price,
  exec_qty: r.executed_quantity,
  exec_size_dec: r.executed_size_decimal,
  realized_pnl: r.realized_pnl,
  executed_at: r.executed_at ? String(r.executed_at).slice(0, 19) : null,
})));

// How many have both price and size for leaderboard eligibility?
const eligible = await db.execute(sql`
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN executed_price IS NOT NULL AND executed_price::numeric > 0 THEN 1 END) as has_price,
    COUNT(CASE WHEN executed_size_decimal IS NOT NULL AND executed_size_decimal::numeric > 0 THEN 1 END) as has_size_decimal,
    COUNT(CASE WHEN executed_price IS NOT NULL AND executed_price::numeric > 0 AND executed_size_decimal IS NOT NULL AND executed_size_decimal::numeric > 0 THEN 1 END) as leaderboard_eligible,
    SUM(realized_pnl::numeric) as total_realized_pnl
  FROM orders
  WHERE user_id = ${userId}
    AND venue = 'hyperliquid'
    AND asset_type = 'PERP'
    AND status = 'FILLED'
`);
console.log("\nEligibility summary:");
console.table(eligible.rows);

process.exit(0);
