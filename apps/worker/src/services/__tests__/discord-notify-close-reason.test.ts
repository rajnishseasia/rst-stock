/**
 * A stop-out and a close the user made deliberately used to render as the same
 * webhook line. That is precisely how a stop-out goes unnoticed until someone
 * opens the broker, which is the failure these tests exist to prevent.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  closeReasonForOrderType,
  formatOrderLine,
  sendDiscordNotification,
} from "../discord-notify";

const base = {
  symbol: "BTC",
  side: "SellToClose",
  quantity: 0,
  quantityDecimal: "0.5",
  status: "FILLED",
  previousStatus: "SUBMITTED",
  executedPrice: 60000,
  orderId: "order-1",
  assetType: "PERP",
  orderType: "Market",
  limitPrice: null,
};

describe("formatOrderLine close reasons", () => {
  it("leads with STOP HIT so it does not read as a routine fill", () => {
    const line = formatOrderLine({ ...base, closeReason: "stop_loss" });
    expect(line.startsWith("🛑 STOP HIT -")).toBe(true);
    expect(line).toContain("BTC");
    // The dollar size, not the coin count: 0.5 BTC at $60,000.
    expect(line).toContain("$30,000.00 of BTC");
  });

  it("distinguishes a target from a stop", () => {
    expect(formatOrderLine({ ...base, closeReason: "take_profit" })).toContain("TARGET HIT");
    expect(formatOrderLine({ ...base, closeReason: "liquidation" })).toContain("LIQUIDATED");
  });

  it("says nothing extra when there is no evidenced reason", () => {
    const line = formatOrderLine({ ...base, closeReason: null });
    expect(line).not.toContain("STOP HIT");
    expect(line).not.toContain("TARGET HIT");
  });

  it("marks a fill the app never placed, so it is not read as one of ours", () => {
    expect(formatOrderLine({ ...base, externalOrigin: true })).toContain("[at venue]");
    expect(formatOrderLine(base)).not.toContain("[at venue]");
  });

  it("keeps the trader suffix after the origin marker", () => {
    const line = formatOrderLine({ ...base, externalOrigin: true, userId: "user-1" });
    expect(line).toContain("[at venue]");
    expect(line.indexOf("[at venue]")).toBeLessThan(line.indexOf("from "));
  });
});

describe("closeReasonForOrderType", () => {
  it("names a reduce-only stop leg", () => {
    expect(closeReasonForOrderType("StopMarket", true)).toBe("stop_loss");
    expect(closeReasonForOrderType("StopLimit", true)).toBe("stop_loss");
  });

  it("names a reduce-only take-profit leg", () => {
    expect(closeReasonForOrderType("TakeProfitMarket", true)).toBe("take_profit");
  });

  it("never calls an OPENING stop-market entry a stop-out", () => {
    // Same order type, opposite meaning. Announcing it as a stop-out would
    // report a position being opened as one being closed.
    expect(closeReasonForOrderType("StopMarket", false)).toBeNull();
    expect(closeReasonForOrderType("StopMarket", null)).toBeNull();
  });

  it("is null for ordinary order types", () => {
    expect(closeReasonForOrderType("Market", true)).toBeNull();
    expect(closeReasonForOrderType(null, true)).toBeNull();
  });
});

describe("a venue-ended position always reaches the webhook", () => {
  let fetchCalls: number;
  let originalFetch: typeof fetch;
  let originalWebhook: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    originalFetch = globalThis.fetch;
    originalWebhook = process.env.DISCORD_WEBHOOK_URL;
    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/hook";
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
  });

  it("fires even on a status the order-type table would otherwise suppress", async () => {
    // A PARTIAL market fill is normally dropped to wait for the consolidating
    // FILLED ping. A stop-out is not something to consolidate and wait on.
    await sendDiscordNotification({
      ...base,
      status: "PARTIAL",
      closeReason: "stop_loss",
    });
    expect(fetchCalls).toBe(1);
  });

  it("still suppresses an ordinary PARTIAL with no reason attached", async () => {
    await sendDiscordNotification({ ...base, status: "PARTIAL" });
    expect(fetchCalls).toBe(0);
  });
});
