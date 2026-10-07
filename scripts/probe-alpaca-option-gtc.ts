/**
 * Probe: does Alpaca PAPER accept GTC time-in-force on an options order?
 *
 * One-shot script that:
 *   1. Lists SPY option contracts via /v2/options/contracts.
 *   2. Picks a cheap, deep-OTM, near-term contract.
 *   3. Submits a BUY_TO_OPEN limit order for 1 contract with TIF=gtc at
 *      $0.01 — way below the bid, so it cannot fill.
 *   4. Logs the full Alpaca response (success body OR error body).
 *   5. If accepted, cancels it.
 *
 * Run:
 *   ALPACA_KEY_ID=... ALPACA_SECRET_KEY=... bun run scripts/probe-alpaca-option-gtc.ts
 *
 * Use PAPER keys. The script hits paper-api.alpaca.markets only.
 *
 * What we're trying to learn: if Alpaca rejects with a TIF-specific error,
 * the server-side rule that rewrites options to DAY is justified. If it
 * accepts, we can safely lift that rule and let GTC flow through.
 */

const TRADING_HOST = "https://paper-api.alpaca.markets";

const keyId = process.env.ALPACA_KEY_ID;
const secret = process.env.ALPACA_SECRET_KEY;

if (!keyId || !secret) {
  console.error(
    "Missing ALPACA_KEY_ID / ALPACA_SECRET_KEY. Export your PAPER keys and re-run.",
  );
  process.exit(1);
}

const authHeaders: Record<string, string> = {
  "APCA-API-KEY-ID": keyId,
  "APCA-API-SECRET-KEY": secret,
  Accept: "application/json",
};

type Contract = {
  symbol: string; // OCC symbol — what we trade with
  expiration_date: string;
  strike_price: string;
  type: "call" | "put";
  underlying_symbol: string;
  close_price?: string | null;
};

async function listContracts(): Promise<Contract[]> {
  // Pull a chunk of SPY puts with a near expiration. Default page size on
  // Alpaca is 100, plenty for finding a cheap deep-OTM put.
  const today = new Date();
  const future = new Date(today.getTime() + 45 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const qs = new URLSearchParams({
    underlying_symbols: "SPY",
    status: "active",
    expiration_date_gte: fmt(today),
    expiration_date_lte: fmt(future),
    type: "put",
    limit: "1000",
  });
  const url = `${TRADING_HOST}/v2/options/contracts?${qs.toString()}`;
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`listContracts ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { option_contracts: Contract[] };
  return body.option_contracts;
}

function pickCheapContract(contracts: Contract[]): Contract {
  // Filter for "low strike" deep-OTM puts (cheap premium) and the nearest
  // expiry among them. We pick a put because SPY puts at very low strikes
  // are usually < $0.05.
  const candidates = contracts
    .filter((c) => parseFloat(c.strike_price) < 200)
    .sort((a, b) => {
      const expCmp = a.expiration_date.localeCompare(b.expiration_date);
      if (expCmp !== 0) return expCmp;
      return parseFloat(a.strike_price) - parseFloat(b.strike_price);
    });
  if (candidates.length === 0) {
    throw new Error("No cheap SPY put contracts found in window");
  }
  return candidates[0];
}

type SubmitBody = {
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  type: "limit";
  time_in_force: "gtc" | "day";
  limit_price: string;
  order_class?: "simple";
};

async function submitOrder(body: SubmitBody) {
  const res = await fetch(`${TRADING_HOST}/v2/orders`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, ok: res.ok, body: json ?? text };
}

async function cancelOrder(orderId: string) {
  const res = await fetch(`${TRADING_HOST}/v2/orders/${orderId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  return { status: res.status, ok: res.ok };
}

async function main() {
  console.log("Listing SPY put contracts (≤45d)…");
  const contracts = await listContracts();
  console.log(`  fetched ${contracts.length} contracts`);

  const pick = pickCheapContract(contracts);
  console.log("Picked contract:", {
    symbol: pick.symbol,
    expiration: pick.expiration_date,
    strike: pick.strike_price,
    type: pick.type,
  });

  const body: SubmitBody = {
    symbol: pick.symbol,
    qty: "1",
    side: "buy",
    type: "limit",
    time_in_force: "gtc",
    limit_price: "0.01", // intentionally below market; should not fill
  };

  console.log("\nSubmitting GTC option order →", body);
  const result = await submitOrder(body);
  console.log("\nResponse status:", result.status, result.ok ? "OK" : "ERROR");
  console.log(JSON.stringify(result.body, null, 2));

  // If Alpaca accepted it, cancel so it doesn't sit in the paper book.
  if (
    result.ok &&
    typeof result.body === "object" &&
    result.body !== null &&
    "id" in (result.body as Record<string, unknown>)
  ) {
    const id = String((result.body as { id: string }).id);
    console.log(`\nCancelling order ${id}…`);
    const cancel = await cancelOrder(id);
    console.log("Cancel status:", cancel.status, cancel.ok ? "OK" : "ERROR");
  }

  console.log("\nVERDICT");
  if (result.ok) {
    console.log("  ✓ Alpaca accepted TIF=gtc for an options order.");
    console.log("  → The server-side option→day rewrite can be lifted.");
  } else {
    console.log("  ✗ Alpaca rejected the order. See response body above.");
    console.log("  → If the error is TIF-specific, keep the server rewrite.");
  }
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
