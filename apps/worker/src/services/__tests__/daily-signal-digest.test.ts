import { describe, expect, mock, test } from "bun:test";

// Capture redis.del calls so we can assert lock-release behavior without
// readFileSync+string-matching (CLAUDE.md: source-string allowlist must shrink,
// never grow). The mock is hoisted before the service import so the real
// DailySignalDigest.tick() uses this stub instead of a live Redis connection.
const redisSpy = { deletedKeys: [] as string[] };

mock.module("@trade-bot/redis", () => ({
  getRedisClient: async () => ({
    incrWithTtl: async (_key: string, _ttl: number) => 1, // always acquire the lock
    del: async (key: string) => {
      redisSpy.deletedKeys.push(key);
    },
  }),
}));

import {
  buildDigestPrompt,
  buildDigestMessages,
  buildDigestSystemMessage,
  DailySignalDigest,
  digestDateKey,
  isDailySignalDigestEnabled,
  shouldRunDigest,
} from "../daily-signal-digest";

describe("daily signal digest", () => {
  test("is inert unless explicitly enabled", () => {
    expect(isDailySignalDigestEnabled({ DAILY_SIGNAL_DIGEST_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isDailySignalDigestEnabled({ DAILY_SIGNAL_DIGEST_ENABLED: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("uses a stable UTC date lock and configured hour", () => {
    const now = new Date("2026-07-31T13:15:00.000Z");
    expect(digestDateKey(now)).toBe("2026-07-31");
    expect(shouldRunDigest(now, { DAILY_SIGNAL_DIGEST_UTC_HOUR: "13" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldRunDigest(now, { DAILY_SIGNAL_DIGEST_UTC_HOUR: "14" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("builds a bounded, author-attributed prompt", () => {
    const prompt = buildDigestPrompt([{
      symbol: "XYZ",
      content: "Long   breakout",
      timestamp: new Date("2026-07-31T12:00:00.000Z"),
      metadata: { authorName: "Viktor" },
    }]);
    expect(prompt).toContain("Viktor | XYZ | Long breakout");
    expect(prompt).toContain("<signals>");
    expect(prompt).toContain("</signals>");
  });

  test("keeps instructions in the system message, not the signal data payload", () => {
    const sys = buildDigestSystemMessage();
    expect(sys).toContain("under 1,150 characters");
    expect(sys).toContain("Do not add a risk note");
    expect(sys).toContain("untrusted external data");
  });

  test("splits a long digest into two Discord-safe messages at a natural boundary", () => {
    const summary = `${"First section. ".repeat(100)}\n${"Second section. ".repeat(100)}`;
    const messages = buildDigestMessages(summary, 110, 110);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toStartWith("📊 Daily signal summary (110 signals)\n");
    expect(messages[1]).toStartWith("📊 Daily signal summary (continued)\n");
    expect(messages.every((message) => message.length <= 2_000)).toBe(true);
    expect(messages.join("\n")).toContain("Second section.");
  });

  test("releases the daily lock when no signals are available", async () => {
    redisSpy.deletedKeys = [];

    // DB returns no signals for the last 24h.
    const db = {
      query: { signals: { findMany: async () => [] } },
      select: () => ({
        from: () => ({ where: async () => [{ value: 0 }] }),
      }),
    };
    const digest = new DailySignalDigest(db as any);

    // Drive tick() at the default configured hour (13 UTC) so shouldRunDigest passes.
    const now = new Date("2026-07-31T13:05:00.000Z");
    await (digest as unknown as { tick: (now: Date) => Promise<void> }).tick(now);

    // The lock must have been released so remaining ticks within the same UTC
    // hour can retry if signals arrive later.
    expect(redisSpy.deletedKeys).toContain("daily-signal-digest:2026-07-31");
  });
});
