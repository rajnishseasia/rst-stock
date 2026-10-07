/**
 * A Hyperliquid stop can fill in pieces. Each piece is ingested as its own
 * order row and used to produce its own "STOP HIT" line, so one stop-out was
 * announced twice. These tests pin the throttle that collapses it, and pin the
 * cases it must NOT collapse.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  CLOSE_ALERT_WINDOW_MS,
  closeAlertKey,
  createCloseAlertThrottle,
} from "../discord-alert-throttle";
import { sendDiscordNotification } from "../discord-notify";

const ena = {
  symbol: "ENA",
  userId: "user-1",
  closeReason: "stop_loss" as const,
};

describe("closeAlertKey", () => {
  it("scopes the key to one person and ticker across close reasons", () => {
    expect(closeAlertKey(ena)).toBe(closeAlertKey({ ...ena, symbol: "ena" }));
    expect(closeAlertKey(ena)).not.toBe(closeAlertKey({ ...ena, userId: "user-2" }));
    expect(closeAlertKey(ena)).not.toBe(closeAlertKey({ ...ena, symbol: "BTC" }));
    expect(closeAlertKey(ena)).toBe(
      closeAlertKey({ ...ena, closeReason: "liquidation" }),
    );
  });

  it("exempts an ordinary fill: two orders on a ticker are two real actions", () => {
    expect(closeAlertKey({ symbol: "ENA", userId: "user-1" })).toBeNull();
    expect(closeAlertKey({ ...ena, closeReason: null })).toBeNull();
  });

  it("exempts an alert with no user, rather than sharing one key across people", () => {
    expect(closeAlertKey({ ...ena, userId: null })).toBeNull();
    expect(closeAlertKey({ ...ena, userId: "  " })).toBeNull();
  });
});

describe("createCloseAlertThrottle", () => {
  it("passes the first stop fill and drops the staggered second", () => {
    let clock = 1_000;
    const throttle = createCloseAlertThrottle({ now: () => clock });

    expect(throttle.allow(ena)).toBe(true);
    clock += 900; // the second fill of the same stop, moments later
    expect(throttle.allow(ena)).toBe(false);
    clock += 30_000;
    expect(throttle.allow(ena)).toBe(false);
  });

  it("alerts again once the minute is up", () => {
    let clock = 1_000;
    const throttle = createCloseAlertThrottle({ now: () => clock });

    expect(throttle.allow(ena)).toBe(true);
    clock += CLOSE_ALERT_WINDOW_MS;
    expect(throttle.allow(ena)).toBe(true);
  });

  it("never lets one person's close silence another's, or one ticker another", () => {
    const throttle = createCloseAlertThrottle({ now: () => 1_000 });

    expect(throttle.allow(ena)).toBe(true);
    expect(throttle.allow({ ...ena, userId: "user-2" })).toBe(true);
    expect(throttle.allow({ ...ena, symbol: "BTC" })).toBe(true);
    expect(throttle.allow({ ...ena, closeReason: "take_profit" })).toBe(false);
    expect(throttle.allow(ena)).toBe(false);
  });

  it("does not throttle ordinary fills at all", () => {
    const throttle = createCloseAlertThrottle({ now: () => 1_000 });
    const fill = { symbol: "ENA", userId: "user-1" };

    expect(throttle.allow(fill)).toBe(true);
    expect(throttle.allow(fill)).toBe(true);
    expect(throttle.allow(fill)).toBe(true);
  });

  it("throttles an external manual close split into several fills", () => {
    const throttle = createCloseAlertThrottle({ now: () => 1_000 });
    const close = {
      symbol: "INIT",
      userId: "user-1",
      side: "SellToClose",
      externalOrigin: true,
      closeReason: null,
    };

    expect(throttle.allow(close)).toBe(true);
    expect(throttle.allow(close)).toBe(false);
    expect(throttle.allow(close)).toBe(false);
  });

  it("does not throttle an in-app close merely because its side says close", () => {
    const throttle = createCloseAlertThrottle({ now: () => 1_000 });
    const close = {
      symbol: "INIT",
      userId: "user-1",
      side: "SellToClose",
      externalOrigin: false,
      closeReason: null,
    };

    expect(throttle.allow(close)).toBe(true);
    expect(throttle.allow(close)).toBe(true);
  });
});

describe("sendDiscordNotification honors the throttle", () => {
  let posted: string[];
  let originalFetch: typeof fetch;
  let originalWebhook: string | undefined;

  const stopFill = {
    symbol: "ENA",
    side: "Sell",
    quantity: 0,
    quantityDecimal: "5561.0",
    status: "FILLED",
    previousStatus: "PENDING",
    executedPrice: 0.15251,
    orderId: "order-1",
    assetType: "PERP",
    orderType: "Market",
    limitPrice: null,
    userId: "user-1",
    reduceOnly: true,
    externalOrigin: true,
    closeReason: "stop_loss" as const,
  };

  beforeEach(() => {
    posted = [];
    originalFetch = globalThis.fetch;
    originalWebhook = process.env.DISCORD_WEBHOOK_URL;
    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/hook";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted.push(String(JSON.parse(String(init.body)).content));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
  });

  it("sends one line for a stop that filled in two pieces", async () => {
    let clock = 1_000;
    const throttle = createCloseAlertThrottle({ now: () => clock });
    // The throttle runs BEFORE the identity lookup, so a suppressed alert costs
    // no database round trip. `profileLookups` pins that.
    let profileLookups = 0;
    const deps = {
      loadTraderProfile: async () => {
        profileLookups++;
        return null;
      },
    };

    await sendDiscordNotification({ ...stopFill }, deps, throttle);
    clock += 400;
    await sendDiscordNotification(
      { ...stopFill, orderId: "order-2", quantityDecimal: "15521.0", executedPrice: 0.15252 },
      deps,
      throttle,
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("STOP HIT");
    expect(posted[0]).toContain("$848.11 of ENA");
    expect(profileLookups).toBe(1);
  });
});
