/**
 * Live Signal Pipeline Test
 *
 * Runs every real Neil Arora entry message (15 total from the test suite)
 * through the actual Hyperliquid execution stack against napindc@vt.edu.
 *
 * For each signal:
 *   1. Validate coin against HL perps (skip if not listed)
 *   2. Fetch current mid price
 *   3. Adjust SL if the original test SL is no longer valid for current price
 *   4. Size the position ($5 max risk)
 *   5. Place market long + set stop loss
 *   6. Wait 2s then close position at market (reduce-only short)
 *   7. Report result before moving to the next
 *
 * Usage (from repo root):
 *   DATABASE_URL_DIRECT=... ENCRYPTION_KEY=... PRIVY_APP_ID=... \
 *   PRIVY_APP_SECRET=... PRIVY_AUTHORIZATION_KEY=... \
 *   bun run scripts/test-live-signals.ts
 */

import { createWorkerPoolDb } from "@trade-bot/db";
import { schema } from "@trade-bot/db";
import { parseCanonicalPerpCoin } from "@trade-bot/hyperliquid";
import { eq, and } from "drizzle-orm";
import { createHyperliquidExchangeClient, createHyperliquidInfoClient, HL_AGENT_REGISTERED } from "../../api/src/lib/hyperliquid";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FOLLOWER_EMAIL = "napindc@vt.edu";
const RISK_PER_TRADE_USD = 5;
const LEVERAGE = 3;
const POST_ORDER_DELAY_MS = 1200;
const POST_CLOSE_DELAY_MS = 2000;
// If original SL is invalid (>= entry for a long), use this % below mid as SL
const FALLBACK_SL_PCT = 0.05; // 5% below mid

// ---------------------------------------------------------------------------
// All 15 real Neil entry messages from the test suite (in order)
// ---------------------------------------------------------------------------

interface TestSignal {
  label: string;
  rawMessage: string;
  coin: string;
  originalSL: number;
  /** Only set when the message specifies a price instead of CMP */
  specificEntryPrice?: number;
}

const TEST_SIGNALS: TestSignal[] = [
  {
    label: "01 LIT #1",
    rawMessage: "Market long LIT (lighter coin) here at CMP. 4H close under 2.27 for stops, TPs above. SR flip trade",
    coin: "LIT",
    originalSL: 2.27,
  },
  {
    label: "02 PIXEL #1",
    rawMessage: "Going long PIXEL here at CMP. TPs above, DCA @ 0.004409, 4H close under 0.00425 for stops.",
    coin: "PIXEL",
    originalSL: 0.00425,
  },
  {
    label: "03 VVV #1",
    rawMessage: "Going long VVV here at CMP. 4H close under 11.64 for stops, TPs above in white.",
    coin: "VVV",
    originalSL: 11.64,
  },
  {
    label: "04 SAGA #1",
    rawMessage: "Market longing SAGA here at CMP. TPs 2/3 above (will manually take first TP) dca @ 0.0131, 4H close under 0.01296 for stops",
    coin: "SAGA",
    originalSL: 0.01296,
  },
  {
    label: "05 LIT #2",
    rawMessage: "Im longing LIT here at CMP after the hype news. TPs above, 4H close under 2.45 for stops",
    coin: "LIT",
    originalSL: 2.45,
  },
  {
    label: "06 ONDO",
    rawMessage: "Going long ONDO here at CMP. No dca, TPs in white, SL 1H close under 0.339.",
    coin: "ONDO",
    originalSL: 0.339,
  },
  {
    label: "07 WLD",
    rawMessage: "Im going long WLD (worldcoin) right now at CMP. TPs above, 4H close under 0.347 for stops.",
    coin: "WLD",
    originalSL: 0.347,
  },
  {
    label: "08 ZEC CMP",
    rawMessage: "Market long ZEC here at CMP. Dca @ 490.2, 4H close under 483 for stops.",
    coin: "ZEC",
    originalSL: 483,
  },
  {
    label: "09 CASHCAT",
    rawMessage: "Longing CASHCAT (can trade it on hyperliquid)\n\nTPs above, 4H close under 0.0623 for stops.\n\nThis is risky, it's a meme and super volatile. Go light",
    coin: "CASHCAT",
    originalSL: 0.0623,
  },
  {
    label: "10 VVV #2",
    rawMessage: "Im longing VVV here at CMP again. TPs in white, 1H close under 11.79 for stops",
    coin: "VVV",
    originalSL: 11.79,
  },
  {
    label: "11 SAGA #2",
    rawMessage: "Market longing SAGA here at CMP. TPs 2/3 above dca @ 0.0131, 4H close under 0.01296 for stops",
    coin: "SAGA",
    originalSL: 0.01296,
  },
  {
    label: "12 LIT #3",
    rawMessage: "Im longing LIT here at CMP after the hype news. TPs above, 4H close under 2.45 for stops",
    coin: "LIT",
    originalSL: 2.45,
  },
  {
    label: "13 SAGA #3",
    rawMessage: "Market longing SAGA here at CMP. TPs 2/3 above (will manually take first TP) dca @ 0.0131, 4H close under 0.01296 for stops",
    coin: "SAGA",
    originalSL: 0.01296,
  },
  {
    label: "14 PIXEL #2",
    rawMessage: "Going long PIXEL here at CMP. TPs above, DCA @ 0.004409, 4H close under 0.00425 for stops.",
    coin: "PIXEL",
    originalSL: 0.00425,
  },
  {
    label: "15 ZEC limit",
    rawMessage: "Market long ZEC here at 490. 4H close under 483 for stops.",
    coin: "ZEC",
    originalSL: 483,
    specificEntryPrice: 490,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatNum(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toFixed(8);
}

function computeSize(riskUsd: number, entryPrice: number, stopLoss: number): string | null {
  if (stopLoss >= entryPrice) return null;
  const distance = entryPrice - stopLoss;
  return (riskUsd / distance).toFixed(6);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(70));
  console.log("Live Signal Pipeline Test");
  console.log(`Follower: ${FOLLOWER_EMAIL} | Risk/trade: $${RISK_PER_TRADE_USD} | Leverage: ${LEVERAGE}x`);
  console.log("=".repeat(70));
  console.log();

  // -- DB setup
  const databaseUrl = process.env.DATABASE_URL_DIRECT;
  if (!databaseUrl) throw new Error("DATABASE_URL_DIRECT is required");
  const db = createWorkerPoolDb(databaseUrl);

  // -- Find the follower user
  const user = await db.query.users.findFirst({
    where: eq(schema.users.email, FOLLOWER_EMAIL),
    columns: { id: true, email: true },
  });
  if (!user) throw new Error(`User not found: ${FOLLOWER_EMAIL}`);

  // -- Find their HL credential
  const credential = await db.query.userApiCredentials.findFirst({
    where: and(
      eq(schema.userApiCredentials.userId, user.id),
      eq(schema.userApiCredentials.provider, "hyperliquid"),
      eq(schema.userApiCredentials.accountType, HL_AGENT_REGISTERED),
    ),
  });
  if (!credential) throw new Error(`No HL_AGENT_REGISTERED credential for ${FOLLOWER_EMAIL}`);

  // -- Build HL client (shared across all signals)
  const { client } = await createHyperliquidExchangeClient(db, user.id);
  const infoClient = createHyperliquidInfoClient();

  console.log(`HL client ready for ${FOLLOWER_EMAIL}`);
  console.log();

  // -- Results tracking
  const results: Array<{
    label: string;
    coin: string;
    status: "ok" | "skipped" | "error";
    note: string;
    sizeUsd?: number;
  }> = [];

  // -- Run each signal
  for (const sig of TEST_SIGNALS) {
    console.log(`${"─".repeat(70)}`);
    console.log(`Signal ${sig.label} | raw: "${sig.rawMessage.slice(0, 60).replace(/\n/g, " ")}..."`);

    // 1. Validate coin
    const canonCoin = parseCanonicalPerpCoin(sig.coin);
    if (!canonCoin) {
      console.log(`  SKIP: ${sig.coin} not recognised as an HL perp`);
      results.push({ label: sig.label, coin: sig.coin, status: "skipped", note: "not an HL perp" });
      continue;
    }

    // 2. Fetch current mid price
    let midPrice: number;
    try {
      const mids = await infoClient.allMids(canonCoin);
      const rawMid = mids[canonCoin];
      if (!rawMid) throw new Error(`No mid returned for ${canonCoin}`);
      midPrice = parseFloat(rawMid);
      if (!isFinite(midPrice) || midPrice <= 0) throw new Error(`Invalid mid: ${rawMid}`);
    } catch (err) {
      const msg = String(err);
      console.log(`  SKIP: cannot fetch mid price for ${canonCoin}: ${msg}`);
      results.push({ label: sig.label, coin: canonCoin, status: "skipped", note: `mid price error: ${msg}` });
      continue;
    }

    // 3. Resolve entry price (CMP = mid, or use the signal-specified price)
    const entryPrice = sig.specificEntryPrice ?? midPrice;

    // 4. Validate / adjust SL
    let stopLoss = sig.originalSL;
    let slNote = "";
    if (stopLoss >= entryPrice) {
      // Original SL is above current market - adjust for testing
      stopLoss = parseFloat((entryPrice * (1 - FALLBACK_SL_PCT)).toFixed(8));
      slNote = ` (original SL=${sig.originalSL} was >= entry, adjusted to ${formatNum(stopLoss)})`;
    }

    // 5. Compute size
    const sizeCoin = computeSize(RISK_PER_TRADE_USD, entryPrice, stopLoss);
    if (!sizeCoin) {
      console.log(`  SKIP: SL=${stopLoss} >= entry=${entryPrice}, cannot size`);
      results.push({ label: sig.label, coin: canonCoin, status: "skipped", note: "invalid SL/entry" });
      continue;
    }
    const sizeUsd = parseFloat(sizeCoin) * entryPrice;
    const clientOrderId = `test-signal-${sig.label.replace(/\s+/g, "-")}-${Date.now()}`;

    console.log(`  Coin: ${canonCoin} | mid: ${formatNum(midPrice)} | SL: ${formatNum(stopLoss)}${slNote}`);
    console.log(`  Size: ${sizeCoin} ${canonCoin} (~$${sizeUsd.toFixed(2)}) | risk: $${RISK_PER_TRADE_USD}`);

    // 6. Set leverage
    try {
      await client.updateLeverage({ coin: canonCoin, leverage: LEVERAGE, marginMode: "cross" });
    } catch {
      // Non-fatal
    }

    // 7. Place market long
    try {
      await client.placeOrder({
        coin: canonCoin,
        side: "long",
        size: sizeCoin,
        orderType: "Market",
        reduceOnly: false,
        clientOrderId,
        markPrice: String(entryPrice),
      });
      console.log(`  OPEN: market long placed`);
    } catch (err) {
      const msg = String(err);
      console.log(`  ERROR placing order: ${msg}`);
      results.push({ label: sig.label, coin: canonCoin, status: "error", note: `open failed: ${msg}` });
      continue;
    }

    await sleep(POST_ORDER_DELAY_MS);

    // 8. Set stop loss (best-effort - position is already open)
    try {
      await client.setPositionTpSl({
        coin: canonCoin,
        positionSide: "long",
        size: sizeCoin,
        stopLossPx: String(stopLoss),
        clientOrderId: `${clientOrderId}:sl`,
        isMarket: true,
      });
      console.log(`  SL set at ${formatNum(stopLoss)}`);
    } catch (err) {
      console.log(`  WARN: SL placement failed (${String(err)}) - position is open WITHOUT stop loss`);
    }

    await sleep(POST_CLOSE_DELAY_MS);

    // 9. Close position (market short, reduce-only)
    try {
      // Fetch a fresh mid before closing
      let closeMid = entryPrice;
      try {
        const freshMids = await infoClient.allMids(canonCoin);
        const rawClose = freshMids[canonCoin];
        if (rawClose) closeMid = parseFloat(rawClose);
      } catch {
        // Use entry price as fallback
      }

      await client.placeOrder({
        coin: canonCoin,
        side: "short",
        size: sizeCoin,
        orderType: "Market",
        reduceOnly: true,
        clientOrderId: `${clientOrderId}:close`,
        markPrice: String(closeMid),
      });
      console.log(`  CLOSED at ~${formatNum(closeMid)}`);
      results.push({ label: sig.label, coin: canonCoin, status: "ok", note: slNote || "nominal SL", sizeUsd });
    } catch (err) {
      const msg = String(err);
      console.log(`  ERROR closing position: ${msg}`);
      results.push({ label: sig.label, coin: canonCoin, status: "error", note: `close failed: ${msg}`, sizeUsd });
    }

    // Brief pause before next signal
    await sleep(1500);
    console.log();
  }

  // -- Summary
  console.log("=".repeat(70));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(70));
  const ok = results.filter((r) => r.status === "ok");
  const skipped = results.filter((r) => r.status === "skipped");
  const errored = results.filter((r) => r.status === "error");

  for (const r of results) {
    const icon = r.status === "ok" ? "✓" : r.status === "skipped" ? "−" : "✗";
    const sizeStr = r.sizeUsd != null ? ` | $${r.sizeUsd.toFixed(2)} notional` : "";
    console.log(`  ${icon} ${r.label.padEnd(14)} ${r.coin.padEnd(10)} ${r.note}${sizeStr}`);
  }

  console.log();
  console.log(`Executed: ${ok.length} | Skipped: ${skipped.length} | Errors: ${errored.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
