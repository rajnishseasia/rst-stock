import { describe, expect, it } from "bun:test";
import { classifySignalInstrument } from "@trade-bot/utils";
import { resolveMirrorAuthorMatchKeys } from "./copy-mirror-candidate-sources";
import {
  ExternalDiscordSignalPoller,
  buildExternalDiscordClientOrderId,
  buildSignalTradeWebhookContent,
  deriveExternalDiscordFallbackStop,
  isExternalDiscordExecutionAllowed,
  mapExternalDiscordSignal,
  parseExternalDiscordStreamEntry,
  parseExternalDiscordExitEntry,
  parseExternalDiscordFollowersConfig,
  resolveOpenRateLimits,
  resolveEntryFollowers,
  resolveExitFollowers,
  isExternalDiscordRestingPlacement,
  persistExternalDiscordSignal,
  resolveExternalDiscordPlacementOutcome,
  toExternalDiscordFilledOrderUpdate,
  toExternalDiscordSocialTrade,
} from "./external-discord-signal-poller";
import * as externalDiscordPoller from "./external-discord-signal-poller";
import type { ParsedSignal } from "./external-discord-signal-types";
import {
  evaluateOpenRateLimit,
  longestWindowSeconds,
  openRateLimitKey,
} from "./external-discord-open-rate-limit";
import shippedConfig from "../config/external-discord-followers.json";

describe("external Discord fill webhook", () => {
  it("shows the confirmed venue price instead of saying market", () => {
    expect(buildSignalTradeWebhookContent({
      coin: "ZEC",
      side: "long",
      sizeCoin: "3.45",
      sizeUsd: 3_998.21,
      entryPrice: 1_158.9,
      stopLoss: 1_133,
      takeProfit: undefined,
      riskUsd: 150,
      traderName: "SOL Decoder",
    })).toContain("Long $3998 of ZEC** @ $1158.90");
  });

  it("retains useful precision for low-priced coins", () => {
    expect(buildSignalTradeWebhookContent({
      coin: "INIT",
      side: "short",
      sizeCoin: "73457.0",
      sizeUsd: 4_620,
      entryPrice: 0.0629,
      stopLoss: 0.07,
      takeProfit: undefined,
      riskUsd: 150,
      traderName: "SOL Decoder",
    })).toContain("@ $0.062900");
  });
});

function parsedSignal(overrides: Partial<ParsedSignal> = {}): ParsedSignal {
  return {
    messageId: "1390441633807601685",
    channelId: "1087843967573438504",
    authorId: "424242424242424242",
    authorName: "Neil Arora",
    authorHandle: "neilarora16",
    authorAvatar: "https://cdn.discordapp.com/avatars/4242/avatar.png",
    rawMessage: "Market long GOOGL here at CMP. Close under 190 for stops.",
    sourceUrl: "https://discord.com/channels/1/1087843967573438504/1390441633807601685",
    coin: "GOOGL",
    side: "long",
    entryPrice: null,
    stopLoss: 190,
    slFallback: false,
    takeProfits: [],
    confidence: "high",
    parsedAt: new Date("2026-08-23T12:01:00.000Z"),
    messageTimestamp: new Date("2026-08-23T12:00:00.000Z"),
    ...overrides,
  };
}

function actionableFields(overrides: Record<string, string> = {}): Record<string, string> {
  const now = new Date().toISOString();
  return {
    v: "1",
    isNewEntry: "true",
    messageId: "1390441633807601685",
    channelId: "1087843967573438504",
    authorId: "424242424242424242",
    authorName: "Neil Arora",
    rawMessage: "Market long GOOGL with a defined stop.",
    coin: "GOOGL",
    side: "long",
    entryPrice: "200",
    stopLoss: "190",
    takeProfits: "[]",
    confidence: "high",
    parsedAt: now,
    messageTimestamp: now,
    ...overrides,
  };
}

function exitFields(overrides: Record<string, string> = {}): Record<string, string> {
  const now = new Date().toISOString();
  return {
    v: "2",
    action: "close",
    messageId: "1390441633807601685",
    channelId: "1087843967573438504",
    authorId: "424242424242424242",
    authorName: "Neil Arora",
    rawMessage: "Closing ENA early here before the 1H close",
    coin: "ENA",
    parsedAt: now,
    messageTimestamp: now,
    ...overrides,
  };
}

describe("external Discord entry rate limits", () => {
  const WINDOWS = [
    { windowSeconds: 600, maxOpens: 1 },
    { windowSeconds: 86400, maxOpens: 5 },
  ];
  const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);
  const minutesAgo = (n: number) => NOW - n * 60_000;

  it("allows the first entry when nothing has been opened", () => {
    expect(evaluateOpenRateLimit([], NOW, WINDOWS).allowed).toBe(true);
  });

  it("blocks a second entry inside the 10 minute window", () => {
    const decision = evaluateOpenRateLimit([minutesAgo(3)], NOW, WINDOWS);
    expect(decision.allowed).toBe(false);
    expect(decision.exceeded?.windowSeconds).toBe(600);
    expect(decision.observed).toBe(1);
  });

  it("allows again once the 10 minute window has passed", () => {
    expect(evaluateOpenRateLimit([minutesAgo(11)], NOW, WINDOWS).allowed).toBe(true);
  });

  it("blocks the sixth entry in 24 hours even when spaced out", () => {
    const opens = [30, 120, 300, 600, 900].map(minutesAgo);
    const decision = evaluateOpenRateLimit(opens, NOW, WINDOWS);
    expect(decision.allowed).toBe(false);
    expect(decision.exceeded?.windowSeconds).toBe(86400);
    expect(decision.observed).toBe(5);
  });

  it("allows a sixth entry once the oldest ages out of 24 hours", () => {
    // 1500 minutes = 25 hours, so that open no longer counts; the remaining
    // four are inside 24h and all outside the 10 minute window.
    const opens = [1500, 120, 300, 600, 900].map(minutesAgo);
    expect(evaluateOpenRateLimit(opens, NOW, WINDOWS).allowed).toBe(true);
  });

  it("reports when the next entry becomes possible", () => {
    const decision = evaluateOpenRateLimit([minutesAgo(4)], NOW, WINDOWS);
    expect(decision.retryAtMs).toBe(minutesAgo(4) + 600_000);
  });

  it("treats maxOpens 0 as a hard pause for the channel", () => {
    const decision = evaluateOpenRateLimit([], NOW, [{ windowSeconds: 600, maxOpens: 0 }]);
    expect(decision.allowed).toBe(false);
    expect(decision.observed).toBe(0);
  });

  it("keys counters per channel and per follower", () => {
    expect(openRateLimitKey("111", "user-a")).not.toBe(openRateLimitKey("222", "user-a"));
    expect(openRateLimitKey("111", "user-a")).not.toBe(openRateLimitKey("111", "user-b"));
  });

  it("retains counters for the longest configured window", () => {
    expect(longestWindowSeconds(WINDOWS)).toBe(86400);
  });
});

describe("external Discord rate limit config", () => {
  const follower = {
    email: "napindc@vt.edu",
    riskPerTradeUsd: 150,
    leverage: 3,
    marginMode: "cross",
    enabled: true,
  };
  const base = {
    minConfidence: "medium",
    channels: {
      "1101943270076059819": { label: "neil", followers: [follower] },
    },
  };

  it("applies the 1-per-10min / 5-per-24h defaults when the key is absent", () => {
    const config = parseExternalDiscordFollowersConfig(base);
    expect(config?.defaultOpenRateLimits).toEqual([
      { windowSeconds: 600, maxOpens: 1 },
      { windowSeconds: 86400, maxOpens: 5 },
    ]);
  });

  it("lets a channel override the defaults", () => {
    const config = parseExternalDiscordFollowersConfig({
      ...base,
      channels: {
        "1101943270076059819": {
          label: "neil",
          followers: [follower],
          openRateLimits: [{ windowSeconds: 3600, maxOpens: 2 }],
        },
      },
    });
    expect(resolveOpenRateLimits(config!, "1101943270076059819")).toEqual([
      { windowSeconds: 3600, maxOpens: 2 },
    ]);
  });

  it("falls back to the defaults for an unconfigured channel", () => {
    const config = parseExternalDiscordFollowersConfig(base);
    expect(resolveOpenRateLimits(config!, "999999999999999999")).toEqual(
      config!.defaultOpenRateLimits,
    );
  });

  it("fails the whole config closed on a malformed window", () => {
    expect(
      parseExternalDiscordFollowersConfig({
        ...base,
        defaultOpenRateLimits: [{ windowSeconds: 0, maxOpens: 1 }],
      }),
    ).toBeNull();
    expect(
      parseExternalDiscordFollowersConfig({
        ...base,
        defaultOpenRateLimits: [{ windowSeconds: 600, maxOpens: -1 }],
      }),
    ).toBeNull();
  });

  it("rejects a channel key that is not a Discord snowflake", () => {
    expect(
      parseExternalDiscordFollowersConfig({
        ...base,
        channels: { "not-a-snowflake": { followers: [] } },
      }),
    ).toBeNull();
  });

  it("parses the real shipped config file", () => {
    const config = parseExternalDiscordFollowersConfig(shippedConfig);
    expect(config).not.toBeNull();
    expect(resolveOpenRateLimits(config!, "1101943270076059819")).toEqual([
      { windowSeconds: 600, maxOpens: 1 },
      { windowSeconds: 86400, maxOpens: 5 },
    ]);
  });
});

describe("per-channel follower routing", () => {
  const neil = "1101943270076059819";
  const testing = "1541001317902983198";

  it("sizes the same person differently per caller in the shipped config", () => {
    const config = parseExternalDiscordFollowersConfig(shippedConfig);
    expect(config).not.toBeNull();
    const forNeil = resolveEntryFollowers(config!, neil);
    const forTesting = resolveEntryFollowers(config!, testing);
    expect(forNeil.map((f) => [f.email, f.riskPerTradeUsd])).toEqual([
      ["napindc@vt.edu", 150],
    ]);
    expect(forTesting.map((f) => [f.email, f.riskPerTradeUsd])).toEqual([
      ["napindc@vt.edu", 10],
    ]);
  });

  it("executes nothing for a channel that is not configured", () => {
    const config = parseExternalDiscordFollowersConfig(shippedConfig);
    expect(resolveEntryFollowers(config!, "999999999999999999")).toEqual([]);
    expect(resolveExitFollowers(config!, "999999999999999999")).toEqual([]);
  });

  it("a disabled channel blocks entries but still routes exits", () => {
    const follower = {
      email: "napindc@vt.edu",
      riskPerTradeUsd: 10,
      leverage: 3,
      marginMode: "cross" as const,
      enabled: true,
    };
    const config = parseExternalDiscordFollowersConfig({
      minConfidence: "medium",
      channels: { [testing]: { label: "testing", enabled: false, followers: [follower] } },
    });
    expect(resolveEntryFollowers(config!, testing)).toEqual([]);
    expect(resolveExitFollowers(config!, testing)).toEqual([follower]);
  });

  it("a disabled follower blocks their entries but still routes their exits", () => {
    const paused = {
      email: "napindc@vt.edu",
      riskPerTradeUsd: 10,
      leverage: 3,
      marginMode: "cross" as const,
      enabled: false,
    };
    const config = parseExternalDiscordFollowersConfig({
      minConfidence: "medium",
      channels: { [testing]: { followers: [paused] } },
    });
    expect(resolveEntryFollowers(config!, testing)).toEqual([]);
    expect(resolveExitFollowers(config!, testing)).toEqual([paused]);
  });

  it("fails closed on a channel with no followers key or a duplicate email", () => {
    expect(
      parseExternalDiscordFollowersConfig({
        minConfidence: "medium",
        channels: { [testing]: { label: "testing" } },
      }),
    ).toBeNull();
    const dupe = {
      email: "napindc@vt.edu",
      riskPerTradeUsd: 10,
      leverage: 3,
      marginMode: "cross",
      enabled: true,
    };
    expect(
      parseExternalDiscordFollowersConfig({
        minConfidence: "medium",
        channels: { [testing]: { followers: [dupe, { ...dupe, riskPerTradeUsd: 150 }] } },
      }),
    ).toBeNull();
  });

  it("requires a channels object at all", () => {
    expect(parseExternalDiscordFollowersConfig({ minConfidence: "medium" })).toBeNull();
  });
});

describe("external Discord social feed publication", () => {
  // The copy-mirror discovers a user's trades ONLY through social_trades. A
  // confirmed fill that never publishes one is invisible to every follower,
  // which is exactly what happened to the leader's signal-executed opens on
  // 2026-09-04: the order was marked FILLED here, so the Hyperliquid reconciler
  // (the only other perp publisher) never touched it either.
  const order = {
    id: "4a317841-6527-49ff-be09-92fbb4a5dc82",
    userId: "PyZ3HFT7tbIdFKdtjLMqyDvy5oOUoWG5",
    symbol: "INIT",
    tradeAction: "Buy",
    orderType: "Market",
  };
  const fill = { sizeCoin: "73457.0", entryPrice: 0.0629, brokerOrderId: "536127295457" };

  it("links the feed row to the filled parent order so the mirror can join it", () => {
    expect(toExternalDiscordSocialTrade(order, fill)).toEqual({
      userId: "PyZ3HFT7tbIdFKdtjLMqyDvy5oOUoWG5",
      symbol: "INIT",
      side: "buy",
      // social_trades keeps a legacy integer qty; the joined order's
      // executedSizeDecimal is the authoritative perp size, as in the reconciler.
      qty: 1,
      orderType: "market",
      assetType: "PERP",
      limitPrice: null,
      brokerOrderId: "536127295457",
      orderId: "4a317841-6527-49ff-be09-92fbb4a5dc82",
    });
  });

  it("maps a short entry to the sell side", () => {
    expect(toExternalDiscordSocialTrade({ ...order, tradeAction: "Sell" }, fill)?.side).toBe("sell");
  });

  it("refuses to publish a row whose side cannot be resolved", () => {
    expect(toExternalDiscordSocialTrade({ ...order, tradeAction: "Hold" }, fill)).toBeNull();
  });
});

describe("external Discord exit instructions", () => {
  it("parses a close", () => {
    const exit = parseExternalDiscordExitEntry(exitFields());
    expect(exit?.action).toBe("close");
    expect(exit?.coin).toBe("ENA");
    expect(exit?.reducePct).toBeNull();
  });

  it("parses a reduce with its percentage", () => {
    const exit = parseExternalDiscordExitEntry(
      exitFields({ action: "reduce", reducePct: "25" }),
    );
    expect(exit?.action).toBe("reduce");
    expect(exit?.reducePct).toBe(25);
  });

  it("parses a stop-to-breakeven", () => {
    const exit = parseExternalDiscordExitEntry(exitFields({ action: "stop_be" }));
    expect(exit?.action).toBe("stop_be");
  });

  it("rejects a reduce with no percentage rather than guessing a size", () => {
    expect(parseExternalDiscordExitEntry(exitFields({ action: "reduce" }))).toBeNull();
  });

  it("rejects a reduce above 100 percent", () => {
    expect(
      parseExternalDiscordExitEntry(exitFields({ action: "reduce", reducePct: "150" })),
    ).toBeNull();
  });

  it("rejects an unknown action", () => {
    expect(parseExternalDiscordExitEntry(exitFields({ action: "yolo" }))).toBeNull();
  });

  it("ignores entries, leaving them to the entry parser", () => {
    expect(parseExternalDiscordExitEntry(actionableFields())).toBeNull();
  });

  it("requires an author snowflake like the entry path does", () => {
    expect(parseExternalDiscordExitEntry(exitFields({ authorId: "nope" }))).toBeNull();
  });

  it("rejects an exit with no source timestamp", () => {
    expect(parseExternalDiscordExitEntry(exitFields({ messageTimestamp: "" }))).toBeNull();
  });
});

describe("external Discord fallback stop loss", () => {
  it("places the fallback 20% adverse to entry", () => {
    expect(deriveExternalDiscordFallbackStop(100, "long")).toBe(80);
    expect(deriveExternalDiscordFallbackStop(100, "short")).toBe(120);
  });

  it("accepts an entry with no stop when the producer flagged the fallback", () => {
    const signal = parseExternalDiscordStreamEntry(
      actionableFields({ v: "2", stopLoss: "", slFallback: "true" }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.stopLoss).toBeNull();
    expect(signal?.slFallback).toBe(true);
  });

  it("still rejects an entry with no stop and no fallback flag", () => {
    expect(parseExternalDiscordStreamEntry(actionableFields({ stopLoss: "" }))).toBeNull();
  });

  it("rejects a malformed stop even when the fallback flag is set", () => {
    expect(
      parseExternalDiscordStreamEntry(
        actionableFields({ v: "2", stopLoss: "not-a-number", slFallback: "true" }),
      ),
    ).toBeNull();
  });

  it("keeps a real stop when one is present", () => {
    const signal = parseExternalDiscordStreamEntry(actionableFields({ v: "2" }));
    expect(signal?.stopLoss).toBe(190);
    expect(signal?.slFallback).toBe(false);
  });
});

describe("external Discord leaderboard signal mapping", () => {
  it("rejects a stream performance update even when the producer calls it a new long", () => {
    expect(parseExternalDiscordStreamEntry(actionableFields({
      rawMessage: "BTC short from stream up 1.4R",
      coin: "BTC",
      side: "long",
    }))).toBeNull();
  });

  it("rejects structured direction that contradicts explicit raw direction", () => {
    expect(parseExternalDiscordStreamEntry(actionableFields({
      rawMessage: "Going short BTC here at CMP",
      coin: "BTC",
      side: "long",
    }))).toBeNull();
  });

  it("does not mistake Neil's explicitly labelled final TP for the entry", () => {
    const signal = parseExternalDiscordStreamEntry(actionableFields({
      rawMessage: "Going long ZEC guys. DCA @ 1137.37, 1H close under 1094 for stops.\n\nFinal TP at 1301 I’ll tell you guys if I TP before",
      coin: "ZEC",
      entryPrice: "1301",
      stopLoss: "1094",
      takeProfits: '["1301"]',
    }));

    expect(signal).not.toBeNull();
    expect(signal?.entryPrice).toBeNull();
    expect(signal?.stopLoss).toBe(1094);
    expect(signal?.takeProfits).toEqual([1301]);
  });

  it("keeps canonical Hyperliquid case and source time when parsing Redis fields", () => {
    const signal = parseExternalDiscordStreamEntry({
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      authorId: "424242424242424242",
      authorName: "Caller",
      rawMessage: "Market long kPEPE with a defined stop.",
      coin: "kPEPE",
      side: "long",
      entryPrice: "",
      stopLoss: "0.01",
      takeProfits: "[]",
      confidence: "high",
      parsedAt: "2026-08-23T12:01:00.000Z",
      messageTimestamp: "2026-08-23T12:00:00.000Z",
      sourceUrl: "javascript:alert(1)",
    });

    expect(signal?.coin).toBe("kPEPE");
    expect(signal?.messageTimestamp).toEqual(new Date("2026-08-23T12:00:00.000Z"));
    expect(signal?.sourceUrl).toBeNull();
  });

  it("fails closed for missing author identity, invalid enums, and non-strict numbers", () => {
    const fields = {
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      authorId: "424242424242424242",
      authorName: "Caller",
      coin: "kPEPE",
      side: "long",
      entryPrice: "",
      stopLoss: "0.01",
      takeProfits: "[]",
      confidence: "high",
      parsedAt: "2026-08-23T12:01:00.000Z",
      messageTimestamp: "2026-08-23T12:00:00.000Z",
    };

    expect(parseExternalDiscordStreamEntry({ ...fields, authorId: " " })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, side: "LONG" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, confidence: "unknown" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, stopLoss: "0.01junk" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, takeProfits: '["1.2junk"]' })).toBeNull();
  });

  it("rejects malformed Discord snowflakes and blank source content", () => {
    const fields = {
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      authorId: "424242424242424242",
      authorName: "Caller",
      rawMessage: "Long kPEPE with a defined stop.",
      coin: "kPEPE",
      side: "long",
      entryPrice: "0.02",
      stopLoss: "0.01",
      takeProfits: "[]",
      confidence: "high",
      parsedAt: "2026-08-23T12:01:00.000Z",
      messageTimestamp: "2026-08-23T12:00:00.000Z",
    };

    expect(parseExternalDiscordStreamEntry({ ...fields, messageId: "123" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, channelId: "not-a-snowflake" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, authorId: "-424242424242424242" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, authorName: "   " })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, rawMessage: "   " })).toBeNull();
  });

  it("rejects take-profit prices on the wrong side of a known entry", () => {
    const fields = {
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      authorId: "424242424242424242",
      authorName: "Caller",
      rawMessage: "Directional trade setup.",
      coin: "kPEPE",
      entryPrice: "10",
      stopLoss: "9",
      confidence: "high",
      parsedAt: "2026-08-23T12:01:00.000Z",
      messageTimestamp: "2026-08-23T12:00:00.000Z",
    };

    expect(parseExternalDiscordStreamEntry({
      ...fields,
      side: "long",
      takeProfits: '["9.5"]',
    })).toBeNull();
    expect(parseExternalDiscordStreamEntry({
      ...fields,
      side: "short",
      stopLoss: "11",
      takeProfits: '["10.5"]',
    })).toBeNull();
  });

  it("validates follower configuration instead of trusting imported JSON", () => {
    const parseConfig = (externalDiscordPoller as Record<string, unknown>)
      .parseExternalDiscordFollowersConfig as ((value: unknown) => unknown) | undefined;
    expect(typeof parseConfig).toBe("function");
    expect(parseConfig?.({
      minConfidence: "medium",
      channels: {
        "1101943270076059819": {
          label: "neil",
          followers: [{
            email: " Trader@Example.com ",
            riskPerTradeUsd: 150,
            leverage: 3,
            marginMode: "cross",
            enabled: true,
          }],
        },
      },
    })).toEqual({
      minConfidence: "medium",
      // A config that specifies no limits still gets the safe defaults rather
      // than unlimited entries.
      defaultOpenRateLimits: [
        { windowSeconds: 600, maxOpens: 1 },
        { windowSeconds: 86400, maxOpens: 5 },
      ],
      channels: {
        "1101943270076059819": {
          label: "neil",
          // Absent "enabled" on a channel means the channel is live.
          enabled: true,
          openRateLimits: [
            { windowSeconds: 600, maxOpens: 1 },
            { windowSeconds: 86400, maxOpens: 5 },
          ],
          followers: [{
            email: "trader@example.com",
            riskPerTradeUsd: 150,
            leverage: 3,
            marginMode: "cross",
            enabled: true,
          }],
        },
      },
    });
    expect(parseConfig?.({
      minConfidence: "certain",
      channels: {
        "1101943270076059819": {
          followers: [{
            email: "not-an-email",
            riskPerTradeUsd: -1,
            leverage: 0,
            marginMode: "portfolio",
            enabled: "yes",
          }],
        },
      },
    })).toBeNull();
  });

  it("executes only fresh source events", () => {
    const isFresh = (externalDiscordPoller as Record<string, unknown>)
      .isFreshExternalDiscordSignal as
      | ((timestamp: Date, now: Date, maxAgeMs: number) => boolean)
      | undefined;
    expect(typeof isFresh).toBe("function");
    const now = new Date("2026-08-23T12:10:00.000Z");
    expect(isFresh?.(new Date("2026-08-23T12:06:00.000Z"), now, 5 * 60_000)).toBe(true);
    expect(isFresh?.(new Date("2026-08-23T12:04:59.999Z"), now, 5 * 60_000)).toBe(false);
    expect(isFresh?.(new Date("2026-08-23T12:10:01.000Z"), now, 5 * 60_000)).toBe(false);
  });

  it("recognizes only a confirmed Hyperliquid fill response", () => {
    const parseFill = (externalDiscordPoller as Record<string, unknown>)
      .parseExternalDiscordOrderFill as ((value: unknown) => unknown) | undefined;
    expect(typeof parseFill).toBe("function");
    expect(parseFill?.({
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ filled: { totalSz: "2.5", avgPx: "101.25", oid: 987 } }],
        },
      },
    })).toEqual({ sizeCoin: "2.5", entryPrice: 101.25, brokerOrderId: "987" });
    expect(parseFill?.({
      status: "ok",
      response: { type: "order", data: { statuses: [{ resting: { oid: 987 } }] } },
    })).toBeNull();
    expect(parseFill?.({
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { totalSz: "2.5junk", avgPx: "101.25", oid: 987 } }] },
      },
    })).toBeNull();
  });

  it("protects an accepted order whose fill cannot be parsed", () => {
    const now = new Date("2026-08-23T12:10:00.000Z");
    const outcome = resolveExternalDiscordPlacementOutcome(
      { status: "ok", response: { type: "order", data: { statuses: [{ waitingForFill: {} }] } } },
      "2.5",
      now,
    );

    expect(outcome.fill).toBeNull();
    // Hyperliquid accepted the order, so a position may be live: it must still
    // get a stop loss, sized off the requested size.
    expect(outcome.protectionSize).toBe("2.5");
    expect(outcome.orderUpdate).toMatchObject({ status: "SUBMITTED", placedAt: now });
    expect(String(outcome.orderUpdate.syncReason)).toContain("requested size");
  });

  it("does not protect a resting order that cannot have a position behind it", () => {
    const now = new Date("2026-08-23T12:10:00.000Z");
    const outcome = resolveExternalDiscordPlacementOutcome(
      { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 987 } }] } } },
      "2.5",
      now,
    );

    expect(outcome.fill).toBeNull();
    expect(outcome.protectionSize).toBeNull();
    expect(outcome.orderUpdate).toMatchObject({ status: "SUBMITTED" });
  });

  it("protects a confirmed fill off the filled size", () => {
    const now = new Date("2026-08-23T12:10:00.000Z");
    const outcome = resolveExternalDiscordPlacementOutcome(
      {
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ filled: { totalSz: "1.5", avgPx: "101.25", oid: 987 } }] },
        },
      },
      "2.5",
      now,
    );

    expect(outcome.fill).toEqual({ sizeCoin: "1.5", entryPrice: 101.25, brokerOrderId: "987" });
    expect(outcome.protectionSize).toBe("1.5");
    expect(outcome.orderUpdate).toMatchObject({ status: "FILLED", executedSizeDecimal: "1.5" });
  });

  it("recognizes only an explicit resting placement", () => {
    expect(isExternalDiscordRestingPlacement({
      status: "ok",
      response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } },
    })).toBe(true);
    expect(isExternalDiscordRestingPlacement({
      status: "ok",
      response: { type: "order", data: { statuses: [] } },
    })).toBe(false);
    expect(isExternalDiscordRestingPlacement({ status: "ok" })).toBe(false);
    expect(isExternalDiscordRestingPlacement(null)).toBe(false);
  });

  it("stores confirmed perp fills in decimal fields without touching equity quantity", () => {
    const filledAt = new Date("2026-08-23T12:10:00.000Z");
    const update = toExternalDiscordFilledOrderUpdate({
      sizeCoin: "0.125",
      entryPrice: 101.25,
      brokerOrderId: "987",
    }, filledAt);

    expect(update).toEqual({
      status: "FILLED",
      brokerOrderId: "987",
      executedPrice: "101.25",
      executedSizeDecimal: "0.125",
      placedAt: filledAt,
      executedAt: filledAt,
      syncReason: null,
    });
    expect("executedQuantity" in update).toBe(false);
  });

  it("requires a valid, plausibly timed original message timestamp", () => {
    const fields = {
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      authorId: "424242424242424242",
      authorName: "Caller",
      coin: "kPEPE",
      side: "long",
      entryPrice: "",
      stopLoss: "0.01",
      takeProfits: "[]",
      confidence: "high",
      parsedAt: "2026-08-23T12:01:00.000Z",
    };

    expect(parseExternalDiscordStreamEntry(fields)).toBeNull();
    expect(parseExternalDiscordStreamEntry({
      ...fields,
      messageTimestamp: "not-a-date",
    })).toBeNull();
    expect(parseExternalDiscordStreamEntry({
      ...fields,
      messageTimestamp: "2099-01-01T00:00:00.000Z",
    })).toBeNull();
  });

  it("rejects entries without both Discord identity fields", () => {
    const fields = {
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      coin: "kPEPE",
      side: "long",
      stopLoss: "0.01",
      takeProfits: "[]",
      confidence: "high",
    };

    expect(parseExternalDiscordStreamEntry({ ...fields, messageId: "" })).toBeNull();
    expect(parseExternalDiscordStreamEntry({ ...fields, channelId: "   " })).toBeNull();
  });

  it("preserves the source event and emits canonical perp metadata", () => {
    const insert = mapExternalDiscordSignal(parsedSignal(), "xyz:GOOGL");

    expect(insert).toMatchObject({
      source: "discord",
      sourceEventId: "discord:1087843967573438504:1390441633807601685:xyz:GOOGL",
      sourceAuthorId: "424242424242424242",
      symbol: "xyz:GOOGL",
      content: "Market long GOOGL here at CMP. Close under 190 for stops.",
      url: "https://discord.com/channels/1/1087843967573438504/1390441633807601685",
      timestamp: new Date("2026-08-23T12:00:00.000Z"),
    });
    expect(insert.metadata).toMatchObject({
      authorId: "424242424242424242",
      authorName: "Neil Arora",
      authorHandle: "neilarora16",
      authorSource: "discord",
      sourceAuthorId: "424242424242424242",
      canonicalAuthorKey: "source_author:discord:424242424242424242",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      platform: "hyperliquid",
      instrument: "perp",
      direction: "long",
      hlTicker: "xyz:GOOGL",
      directExecutionManaged: true,
    });
  });

  it("builds a bounded direct-execution order identity from every execution dimension", () => {
    const base = buildExternalDiscordClientOrderId({
      channelId: "1087843967573438504",
      messageId: "1390441633807601685",
      canonicalCoin: "xyz:GOOGL",
      followerUserId: "follower-1",
    });

    expect(base.length).toBeLessThanOrEqual(128);
    expect(base).toContain("xyz:GOOGL");
    expect(buildExternalDiscordClientOrderId({
      channelId: "different-channel",
      messageId: "1390441633807601685",
      canonicalCoin: "xyz:GOOGL",
      followerUserId: "follower-1",
    })).not.toBe(base);
    expect(buildExternalDiscordClientOrderId({
      channelId: "1087843967573438504",
      messageId: "different-message",
      canonicalCoin: "xyz:GOOGL",
      followerUserId: "follower-1",
    })).not.toBe(base);
    expect(buildExternalDiscordClientOrderId({
      channelId: "1087843967573438504",
      messageId: "1390441633807601685",
      canonicalCoin: "BTC",
      followerUserId: "follower-1",
    })).not.toBe(base);
    expect(buildExternalDiscordClientOrderId({
      channelId: "1087843967573438504",
      messageId: "1390441633807601685",
      canonicalCoin: "xyz:GOOGL",
      followerUserId: "follower-2",
    })).not.toBe(base);
  });

  it("keeps short direction intact and never classifies the call as an equity long", () => {
    const insert = mapExternalDiscordSignal(
      parsedSignal({ side: "short", stopLoss: 210 }),
      "xyz:GOOGL",
    );
    const classification = classifySignalInstrument(insert.metadata, insert.content);

    expect(insert.metadata).toMatchObject({ direction: "short", hlTicker: "xyz:GOOGL" });
    expect(classification.perpVenue).toBe(true);
    expect(classification.perpInstrument).toBe(true);
    expect(classification.short).toBe(true);
    expect(classification.mirrorableEquityLong).toBe(false);
  });

  it("emits source-scoped identity metadata usable by copy/mirror matching", () => {
    const insert = mapExternalDiscordSignal(parsedSignal(), "xyz:GOOGL");
    const keys = resolveMirrorAuthorMatchKeys(
      insert.metadata,
      [],
      { durableLookupAvailable: false },
      "discord",
    );

    expect(keys).toContain("source_author:discord:424242424242424242");
    expect(keys).toContain("source_alias:discord:neilarora16");
    expect(keys).toContain("source_alias:discord:neil%20arora");
  });

  it("persists one source event and treats a replay as a duplicate", async () => {
    const inserted: Record<string, unknown>[] = [];
    let duplicate = false;
    const db = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            onConflictDoNothing: () => ({
              returning: async () => duplicate ? [] : [{ id: "signal-1" }],
            }),
          };
        },
      }),
    };

    const signal = parsedSignal();
    expect(await persistExternalDiscordSignal(db as never, signal, "xyz:GOOGL")).toEqual({
      status: "inserted",
      signalId: "signal-1",
    });
    duplicate = true;
    expect(await persistExternalDiscordSignal(db as never, signal, "xyz:GOOGL")).toEqual({
      status: "duplicate",
      signalId: null,
    });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.sourceEventId).toBe(inserted[1]?.sourceEventId);
  });

  it("does not execute a replayed source event", async () => {
    const db = {
      query: {
        users: {
          findFirst: async () => {
            throw new Error("a duplicate must not reach follower execution");
          },
        },
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
    };
    const poller = new ExternalDiscordSignalPoller(db as never, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never);

    await (poller as unknown as {
      processEntry(fields: Record<string, string>, entryId: string): Promise<void>;
    }).processEntry(actionableFields(), "redis-entry-replay");
  });

  it("persists but does not execute stale source events", async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      query: {
        users: {
          findFirst: async () => {
            throw new Error("a stale signal must not reach follower execution");
          },
        },
      },
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            onConflictDoNothing: () => ({ returning: async () => [{ id: "signal-stale" }] }),
          };
        },
      }),
    };
    const poller = new ExternalDiscordSignalPoller(db as never, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never);

    await (poller as unknown as {
      processEntry(fields: Record<string, string>, entryId: string): Promise<void>;
    }).processEntry(actionableFields({
      parsedAt: "2026-08-23T12:01:00.000Z",
      messageTimestamp: "2026-08-23T12:00:00.000Z",
    }), "redis-entry-stale");

    expect(inserted).toHaveLength(1);
  });

  it("requires explicit opt-in for mainnet follower execution", () => {
    expect(isExternalDiscordExecutionAllowed("testnet", undefined)).toBe(true);
    expect(isExternalDiscordExecutionAllowed("mainnet", undefined)).toBe(false);
    expect(isExternalDiscordExecutionAllowed("mainnet", "false")).toBe(false);
    expect(isExternalDiscordExecutionAllowed("mainnet", "true")).toBe(true);
  });

  it("fails persistence closed when a source event identity is missing", async () => {
    const db = {
      insert: () => {
        throw new Error("signal insert must not run");
      },
    };

    await expect(
      persistExternalDiscordSignal(
        db as never,
        parsedSignal({ messageId: "" }),
        "xyz:GOOGL",
      ),
    ).rejects.toThrow("messageId and channelId");
  });

  it("persists a low-confidence signal before applying the follower gate", async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      query: {
        users: {
          findFirst: async () => {
            throw new Error("follower execution should be gated");
          },
        },
      },
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "signal-1" }],
            }),
          };
        },
      }),
    };
    const poller = new ExternalDiscordSignalPoller(db as never, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never);

    await (poller as unknown as {
      processEntry(fields: Record<string, string>, entryId: string): Promise<void>;
    }).processEntry({
      v: "1",
      isNewEntry: "true",
      messageId: "1390441633807601685",
      channelId: "1087843967573438504",
      authorId: "424242424242424242",
      authorName: "Neil Arora",
      rawMessage: "Market long GOOGL with a defined stop.",
      coin: "GOOGL",
      side: "long",
      entryPrice: "",
      stopLoss: "190",
      takeProfits: "[]",
      confidence: "low",
      parsedAt: "2026-08-23T12:01:00.000Z",
      messageTimestamp: "2026-08-23T12:00:00.000Z",
    }, "redis-entry-1");

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      sourceEventId: "discord:1087843967573438504:1390441633807601685:GOOGL",
      metadata: { confidence: "low" },
    });
  });

  it("is inert when the external Discord poller gate is not exactly true", async () => {
    const previous = process.env.EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED;
    delete process.env.EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED;
    let polls = 0;
    const logs: string[] = [];
    const poller = new ExternalDiscordSignalPoller({} as never, {
      info: (_service: string, message: string) => logs.push(message),
      warn: () => undefined,
      error: () => undefined,
    } as never);
    (poller as unknown as { poll: () => Promise<void> }).poll = async () => {
      polls += 1;
    };

    try {
      await poller.start();
      expect(polls).toBe(0);
      expect((poller as unknown as { timer: unknown }).timer).toBeNull();
      expect(logs.some((message) => message.includes("disabled"))).toBe(true);
    } finally {
      poller.stop();
      if (previous === undefined) delete process.env.EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED;
      else process.env.EXTERNAL_DISCORD_SIGNAL_POLLER_ENABLED = previous;
    }
  });
});
