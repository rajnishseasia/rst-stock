/**
 * Staleness guard for Discord order alerts.
 *
 * Regression cover for the 2026-08-31 incident: a BTC close that filled at the
 * venue on 2026-07-29 stayed unreconciled for a month, resolved to FILLED on a
 * worker redeploy, and posted "Close $10.95 of BTC @ $64391.00" to the channel
 * as though it had just happened, while BTC traded near $78,000.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_STALE_FILL_MAX_AGE_MS,
  STALE_FILL_MAX_AGE_MS_ENV,
  isStaleFill,
  sendDiscordNotification,
  staleFillMaxAgeMs,
  type OrderNotification,
} from "../discord-notify";

const NOW = Date.UTC(2026, 7, 31, 7, 20, 44); // 2026-08-31 16:20:44 JST

describe("isStaleFill", () => {
  it("passes a fill inside the window and drops one past it", () => {
    expect(isStaleFill(NOW - 60_000, NOW)).toBe(false);
    expect(isStaleFill(NOW - DEFAULT_STALE_FILL_MAX_AGE_MS + 1, NOW)).toBe(false);
    expect(isStaleFill(NOW - DEFAULT_STALE_FILL_MAX_AGE_MS - 1, NOW)).toBe(true);
  });

  it("drops the incident fill: filled 2026-07-29, announced 2026-08-31", () => {
    expect(isStaleFill(new Date("2026-07-29T09:00:43.849Z"), NOW)).toBe(true);
  });

  it("accepts both Date and epoch-ms inputs", () => {
    const old = NOW - 33 * 24 * 60 * 60_000;
    expect(isStaleFill(new Date(old), NOW)).toBe(true);
    expect(isStaleFill(old, NOW)).toBe(true);
  });

  it("fails open when the age is unknown", () => {
    // Alpaca terminal non-fills carry no filled_at, and swallowing a rejection
    // is worse than a late line.
    expect(isStaleFill(null, NOW)).toBe(false);
    expect(isStaleFill(undefined, NOW)).toBe(false);
    expect(isStaleFill(Number.NaN, NOW)).toBe(false);
    expect(isStaleFill(new Date("not a date"), NOW)).toBe(false);
  });

  it("fails open on a future-dated fill (clock skew, not staleness)", () => {
    expect(isStaleFill(NOW + 5 * 60_000, NOW)).toBe(false);
  });

  it("honours an explicit window", () => {
    expect(isStaleFill(NOW - 90_000, NOW, 60_000)).toBe(true);
    expect(isStaleFill(NOW - 90_000, NOW, 10 * 60_000)).toBe(false);
  });
});

describe("staleFillMaxAgeMs", () => {
  it("defaults to 15 minutes", () => {
    expect(staleFillMaxAgeMs({})).toBe(15 * 60_000);
    expect(staleFillMaxAgeMs({ [STALE_FILL_MAX_AGE_MS_ENV]: "" })).toBe(
      DEFAULT_STALE_FILL_MAX_AGE_MS,
    );
  });

  it("accepts a valid override", () => {
    expect(staleFillMaxAgeMs({ [STALE_FILL_MAX_AGE_MS_ENV]: "3600000" })).toBe(
      3_600_000,
    );
  });

  it("falls back on invalid, non-positive and above-ceiling values", () => {
    for (const raw of ["abc", "0", "-1", "1.5", String(48 * 60 * 60_000)]) {
      expect(staleFillMaxAgeMs({ [STALE_FILL_MAX_AGE_MS_ENV]: raw })).toBe(
        DEFAULT_STALE_FILL_MAX_AGE_MS,
      );
    }
  });
});

describe("sendDiscordNotification staleness", () => {
  let posted: string[] = [];
  let originalFetch: typeof globalThis.fetch;
  let originalWebhook: string | undefined;

  /** The real incident payload. */
  const ghostClose: OrderNotification = {
    symbol: "BTC",
    side: "Sell",
    quantity: 0,
    quantityDecimal: "0.00017",
    status: "FILLED",
    previousStatus: "SUBMITTED",
    executedPrice: 64391,
    orderId: "c1097bd5-0eb7-4952-ab04-2e8e7c1878d1",
    assetType: "PERP",
    orderType: "Market",
    limitPrice: null,
    userId: "user-1",
    reduceOnly: true,
    executedAt: new Date("2026-07-29T09:00:43.849Z"),
  };

  const deps = { loadTraderProfile: async () => null };
  const now = () => NOW;

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

  it("does not post the month-old close", async () => {
    await sendDiscordNotification(ghostClose, deps, undefined, now);
    expect(posted).toEqual([]);
  });

  it("still posts the same close when it is fresh", async () => {
    await sendDiscordNotification(
      { ...ghostClose, executedAt: NOW - 30_000 },
      deps,
      undefined,
      now,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("$10.95 of BTC");
  });

  it("drops a STALE venue close, which shouldSuppress would let through", async () => {
    // shouldSuppress opens with `if (order.closeReason) return false`, so this
    // is the case a guard placed inside it would miss.
    await sendDiscordNotification(
      { ...ghostClose, closeReason: "stop_loss" },
      deps,
      undefined,
      now,
    );
    expect(posted).toEqual([]);
  });

  it("still posts a fresh stop-out", async () => {
    await sendDiscordNotification(
      { ...ghostClose, closeReason: "stop_loss", executedAt: NOW - 5_000 },
      deps,
      undefined,
      now,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("STOP HIT");
  });

  it("posts when no fill time is known", async () => {
    await sendDiscordNotification(
      { ...ghostClose, executedAt: null },
      deps,
      undefined,
      now,
    );
    expect(posted).toHaveLength(1);
  });

  it("posts a terminal rejection with no fill time", async () => {
    await sendDiscordNotification(
      {
        ...ghostClose,
        status: "REJECTED",
        executedPrice: null,
        executedAt: null,
      },
      deps,
      undefined,
      now,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Rejected");
  });

  it("does not spend a database round trip on a dropped alert", async () => {
    let profileLookups = 0;
    await sendDiscordNotification(
      ghostClose,
      {
        loadTraderProfile: async () => {
          profileLookups++;
          return null;
        },
      },
      undefined,
      now,
    );
    expect(posted).toEqual([]);
    expect(profileLookups).toBe(0);
  });

  it("respects a widened window from the environment", async () => {
    const original = process.env[STALE_FILL_MAX_AGE_MS_ENV];
    process.env[STALE_FILL_MAX_AGE_MS_ENV] = String(60 * 60_000);
    try {
      await sendDiscordNotification(
        { ...ghostClose, executedAt: NOW - 45 * 60_000 },
        deps,
        undefined,
        now,
      );
      expect(posted).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env[STALE_FILL_MAX_AGE_MS_ENV];
      else process.env[STALE_FILL_MAX_AGE_MS_ENV] = original;
    }
  });
});
