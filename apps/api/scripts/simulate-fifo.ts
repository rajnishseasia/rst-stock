/**
 * Simulate FIFO P&L for SOL Decoder to confirm the scope fix worked.
 * Runs the exact same query as the leaderboard and checks if bucket keys
 * will be shared between buys and sells.
 */
import { getDb } from "@trade-bot/db";
import { sql } from "drizzle-orm";
import { requireLocalDbOrExplicitConsent } from "./lib/guard.js";

requireLocalDbOrExplicitConsent("simulate-fifo");

const db = getDb();

// Get rows exactly as the leaderboard would (30d window)
const measurementFloor = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

const rows = await db.execute(sql`
  SELECT
    st.id as social_trade_id,
    st.user_id,
    o.id as order_id,
    o.symbol,
    o.asset_type,
    o.trade_action::text as trade_action,
    o.direction,
    o.executed_price,
    o.executed_quantity,
    o.executed_size_decimal,
    o.status,
    o.broker_account_id,
    o.broker_credential_id::text as broker_credential_id,
    o.venue,
    COALESCE(o.executed_at, st.created_at) as venue_ts
  FROM social_trades st
  INNER JOIN users u ON st.user_id = u.id AND u.twitter_name = 'SOL Decoder'
  INNER JOIN orders o ON (
    (st.user_id = o.user_id AND st.order_id IS NOT NULL AND st.order_id = o.id)
    OR (
      st.user_id = o.user_id AND st.order_id IS NULL
      AND st.broker_order_id IS NOT NULL
      AND st.broker_order_id = o.broker_order_id
      AND NOT EXISTS (
        SELECT 1 FROM orders oo
        WHERE oo.user_id = st.user_id AND oo.broker_order_id = st.broker_order_id
          AND (oo.broker_account_id IS DISTINCT FROM o.broker_account_id
            OR oo.broker_credential_id IS DISTINCT FROM o.broker_credential_id
            OR lower(coalesce(oo.venue,'')) IS DISTINCT FROM lower(coalesce(o.venue,'')))
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders oo
        WHERE oo.user_id = o.user_id AND oo.broker_order_id = o.broker_order_id
          AND oo.broker_account_id IS NOT DISTINCT FROM o.broker_account_id
          AND oo.broker_credential_id IS NOT DISTINCT FROM o.broker_credential_id
          AND lower(coalesce(oo.venue,'')) IS NOT DISTINCT FROM lower(coalesce(o.venue,''))
          AND oo.id != o.id
      )
    )
  )
  WHERE
    o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'PARTIAL')
    AND o.executed_price IS NOT NULL AND o.executed_price::numeric > 0
    AND (
      (o.asset_type = 'PERP' AND o.executed_size_decimal IS NOT NULL AND o.executed_size_decimal::numeric > 0)
      OR (o.asset_type != 'PERP' AND o.executed_quantity > 0)
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_api_credentials c
      WHERE c.provider = 'alpaca' AND c.account_type IN ('PAPER', 'SIM')
        AND (c.id = o.broker_credential_id OR (o.broker_credential_id IS NULL AND c.user_id = o.user_id AND o.broker_account_id IS NOT NULL AND c.account_id = o.broker_account_id))
    )
    AND COALESCE(o.executed_at, st.created_at) >= ${measurementFloor.toISOString()}
  ORDER BY COALESCE(o.executed_at, st.created_at), st.id, o.id
`);

type Row = {
  social_trade_id: string;
  user_id: string;
  order_id: string;
  symbol: string;
  asset_type: string;
  trade_action: string;
  direction: string;
  executed_price: string;
  executed_quantity: number | null;
  executed_size_decimal: string | null;
  status: string;
  broker_account_id: string | null;
  broker_credential_id: string | null;
  venue: string | null;
  venue_ts: Date;
};

const typedRows = rows.rows as unknown as Row[];

console.log(`Rows returned: ${typedRows.length}`);

// Build bucket keys (mirrors positionBucketKey logic)
function bucketKey(row: Row): string {
  const symbol = (row.symbol ?? "").toUpperCase();
  const base = row.asset_type === "PERP" ? `PERP|${symbol}` : `EQ|${symbol}`;
  const hasExplicitScope = row.broker_account_id != null && row.broker_credential_id != null && row.venue != null;
  if (hasExplicitScope) {
    return `${base}|scope:${JSON.stringify([row.broker_account_id, row.broker_credential_id, (row.venue ?? "").toLowerCase()])}`;
  }
  // unknown scope - would use per-order key
  return `${base}|unknown:(acct=${row.broker_account_id},cred=${row.broker_credential_id?.slice(0,8)})`;
}

// Group by symbol + side for FIFO analysis
const bySymbol = new Map<string, { buys: Row[]; sells: Row[] }>();
for (const row of typedRows) {
  const bk = bucketKey(row);
  if (!bySymbol.has(bk)) bySymbol.set(bk, { buys: [], sells: [] });
  const group = bySymbol.get(bk)!;
  const ta = (row.trade_action ?? "").toLowerCase();
  const isBuy = ta.includes("buy") || ta.includes("cover");
  if (isBuy) group.buys.push(row);
  else group.sells.push(row);
}

// Find buckets that have BOTH buys and sells (FIFO can close lots)
console.log("\n=== Buckets with matched buy+sell pairs ===");
let totalPairableBuys = 0, totalPairableSells = 0;
for (const [key, group] of bySymbol.entries()) {
  if (group.buys.length > 0 && group.sells.length > 0) {
    console.log(`  ${key}: ${group.buys.length} buys, ${group.sells.length} sells`);
    totalPairableBuys += group.buys.length;
    totalPairableSells += group.sells.length;
  }
}
console.log(`\nTotal pairable: ${totalPairableBuys} buys + ${totalPairableSells} sells`);

// Quick FIFO P&L estimate for equity pairs
console.log("\n=== FIFO P&L estimate for paired buckets ===");
let totalPnl = 0, closedLots = 0;
for (const [key, group] of bySymbol.entries()) {
  if (group.buys.length === 0 || group.sells.length === 0) continue;
  if (key.includes("PERP")) continue; // skip perp for simplicity

  // Sort chronologically
  group.buys.sort((a, b) => a.venue_ts < b.venue_ts ? -1 : 1);
  group.sells.sort((a, b) => a.venue_ts < b.venue_ts ? -1 : 1);

  // Simple FIFO: open lots queue, close with sells
  const openLots: Array<{qty: number; price: number}> = [];
  for (const buy of group.buys) {
    openLots.push({ qty: Number(buy.executed_quantity ?? 0), price: Number(buy.executed_price) });
  }
  for (const sell of group.sells) {
    let sellQty = Number(sell.executed_quantity ?? 0);
    const sellPrice = Number(sell.executed_price);
    while (sellQty > 0 && openLots.length > 0) {
      const lot = openLots[0]!;
      const qty = Math.min(sellQty, lot.qty);
      const pnl = (sellPrice - lot.price) * qty;
      totalPnl += pnl;
      closedLots++;
      sellQty -= qty;
      lot.qty -= qty;
      if (lot.qty <= 0) openLots.shift();
    }
  }
}

console.log(`Estimated equity P&L: $${totalPnl.toFixed(2)}`);
console.log(`Closed lots: ${closedLots}`);

process.exit(0);
