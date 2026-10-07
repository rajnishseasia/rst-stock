import { afterEach, describe, expect, it } from "bun:test";
import {
  DiscordPoller,
  parseDiscordHistoryPages,
  resolveDiscordRetryAfterMs,
  sortDiscordMessagesOldestFirst,
} from "./discord-poller";
import { schema } from "@trade-bot/db";

const originalToken = process.env.DISCORD_BOT_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalToken;
});

describe("Discord history recovery", () => {
  it("strictly bounds the operator-controlled history page count", () => {
    expect(parseDiscordHistoryPages(undefined)).toBe(10);
    expect(parseDiscordHistoryPages("10")).toBe(10);
    expect(parseDiscordHistoryPages("0")).toBe(1);
    expect(parseDiscordHistoryPages("101")).toBe(1);
    expect(parseDiscordHistoryPages("2.5")).toBe(1);
  });

  it("extracts safe dotted, dashed, digit-bearing, and canonical Hyperliquid tickers", () => {
    const poller = new DiscordPoller({} as never);
    const extractSymbols = (poller as unknown as { extractSymbols(text: string): string[] })
      .extractSymbols.bind(poller);

    expect(
      extractSymbols("$BRK.B $BRK-B $RIVN2 $xyz:GOOGL $kPEPE $not$"),
    ).toEqual(["BRK.B", "BRK-B", "RIVN2", "xyz:GOOGL", "kPEPE"]);
    expect(extractSymbols("$kpepe")).toEqual([]);
  });

  it("rejects malformed cashtags as a whole token", () => {
    const poller = new DiscordPoller({} as never);
    const extractSymbols = (poller as unknown as { extractSymbols(text: string): string[] })
      .extractSymbols.bind(poller);

    expect(extractSymbols("$A..B $A- $A/B")).toEqual([]);
  });

  it("sorts snowflake IDs chronologically without numeric precision loss", () => {
    expect(
      sortDiscordMessagesOldestFirst([
        { id: "1152921504606847000" },
        { id: "1152921504606846977" },
        { id: "1152921504606846999" },
      ]).map((message) => message.id),
    ).toEqual([
      "1152921504606846977",
      "1152921504606846999",
      "1152921504606847000",
    ]);
  });

  it("pages backward during startup and advances to the newest recovered message", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const requestedUrls: string[] = [];
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => ({
      id: String(start - index),
      content: "no ticker in this message",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-07-30T12:00:00.000Z",
      channel_id: "channel",
    }));
    const pages = [page(300), page(200), page(100)];
    const fetchImpl = async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
    };
    const poller = new DiscordPoller({} as never, {
      historyPages: 3,
      fetchImpl,
    });

    await (poller as unknown as { fetchHistory(): Promise<void> }).fetchHistory();

    expect(requestedUrls).toHaveLength(3);
    expect(new URL(requestedUrls[0]!).searchParams.get("before")).toBeNull();
    expect(new URL(requestedUrls[1]!).searchParams.get("before")).toBe("201");
    expect(new URL(requestedUrls[2]!).searchParams.get("before")).toBe("101");
    expect((poller as unknown as { lastMessageId: string }).lastMessageId).toBe("300");
  });

  it("retries history recovery after a transient startup failure", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
      return Response.json([{
        id: "400",
        content: "no ticker",
        author: { id: "author", username: "Caller" },
        timestamp: "2026-07-30T12:00:00.000Z",
        channel_id: "channel",
      }]);
    };
    const poller = new DiscordPoller({} as never, { fetchImpl });
    const privatePoller = poller as unknown as {
      fetchHistory(): Promise<void>;
      pollNewMessages(): Promise<void>;
      lastMessageId: string | null;
    };

    await privatePoller.fetchHistory();
    expect(privatePoller.lastMessageId).toBeNull();
    await privatePoller.pollNewMessages();
    expect(privatePoller.lastMessageId).toBe("400");
    expect(calls).toBe(2);
  });

  it("paginates forward beyond one Discord page", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const requestedUrls: string[] = [];
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => ({
      id: String(start + index + 1),
      content: "no ticker",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-07-30T12:00:00.000Z",
      channel_id: "channel",
    }));
    const pages = new Map([["100", page(100)], ["200", [{
      id: "201",
      content: "no ticker",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-07-30T12:00:00.000Z",
      channel_id: "channel",
    }]]]);
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedUrls.push(String(input));
      const after = url.searchParams.get("after");
      return Response.json(after ? pages.get(after) ?? [] : []);
    };
    const poller = new DiscordPoller({} as never, {
      fetchImpl,
      historyPages: 3,
    });
    const privatePoller = poller as unknown as {
      lastMessageId: string | null;
      pollNewMessages(): Promise<void>;
    };
    privatePoller.lastMessageId = "100";

    await privatePoller.pollNewMessages();

    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]!).searchParams.get("after")).toBe("100");
    expect(new URL(requestedUrls[1]!).searchParams.get("after")).toBe("200");
    expect(privatePoller.lastMessageId).toBe("201");
  });

  it("skips an invalid timestamp while advancing to later valid messages", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      query: { signals: { findFirst: async () => undefined } },
      insert: () => ({ values: async (row: Record<string, unknown>) => { inserted.push(row); } }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const poller = new DiscordPoller(db as never, {
      fetchImpl: async () => Response.json([
        {
          id: "301",
          content: "$AAPL invalid event",
          author: { id: "author", username: "Caller" },
          timestamp: "not-a-timestamp",
          channel_id: "channel",
        },
        {
          id: "302",
          content: "$MSFT valid event",
          author: { id: "author", username: "Caller" },
          timestamp: "2026-07-30T12:00:00.000Z",
          channel_id: "channel",
        },
      ]),
    });
    const privatePoller = poller as unknown as {
      lastMessageId: string | null;
      pollNewMessages(): Promise<void>;
    };
    privatePoller.lastMessageId = "300";

    await privatePoller.pollNewMessages();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.symbol).toBe("MSFT");
    expect(inserted[0]?.sourceEventId).toBe("discord:channel:302:MSFT");
    expect(privatePoller.lastMessageId).toBe("302");
  });

  it("rejects an implausibly future timestamp while advancing the source cursor", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const inserted: Array<Record<string, unknown>> = [];
    const poller = new DiscordPoller(
      {
        query: { signals: { findFirst: async () => undefined } },
        insert: () => ({ values: async (row: Record<string, unknown>) => { inserted.push(row); } }),
      } as never,
      {
        now: () => new Date("2026-08-21T12:00:00.000Z"),
        fetchImpl: async () => Response.json([]),
      },
    );
    const privatePoller = poller as unknown as {
      lastMessageId: string | null;
      processMessage(message: unknown): Promise<unknown>;
      advanceCursor(cursor: string): Promise<void>;
    };
    privatePoller.lastMessageId = "700";

    const result = await privatePoller.processMessage({
      id: "701",
      content: "$AAPL",
      author: { id: "author", username: "Caller" },
      timestamp: "2099-01-01T00:00:00.000Z",
      channel_id: "channel",
    });
    await privatePoller.advanceCursor("701");

    expect(result).toBe("skipped");
    expect(inserted).toHaveLength(0);
    expect(privatePoller.lastMessageId).toBe("701");
  });

  it("advances beyond an all-malformed numeric page instead of wedging", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const requestedAfter: string[] = [];
    const poller = new DiscordPoller({} as never, {
      fetchImpl: async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requestedAfter.push(url.searchParams.get("after") ?? "");
        return Response.json(url.searchParams.get("after") === "100"
          ? Array.from({ length: 100 }, (_, index) => ({ id: String(101 + index) }))
          : []);
      },
    });
    const privatePoller = poller as unknown as {
      lastMessageId: string | null;
      pollNewMessages(): Promise<void>;
    };
    privatePoller.lastMessageId = "100";

    await privatePoller.pollNewMessages();

    expect(privatePoller.lastMessageId).toBe("200");
    expect(requestedAfter).toEqual(["100", "200"]);
  });

  it("processes the oldest startup slice and persists a separate backfill boundary", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const insertedIds: string[] = [];
    const cursorRows: Record<string, unknown> = {};
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => ({
      id: String(start - index),
      content: "$AAPL",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-08-20T12:00:00.000Z",
      channel_id: "channel",
    }));
    const pages = [page(300), page(200), page(100)];
    const db = {
      query: {
        signalIngestionCursors: { findFirst: async () => cursorRows },
        signals: { findFirst: async () => undefined },
      },
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            if (table === schema.signals) insertedIds.push(String(row.sourceEventId));
          },
          onConflictDoUpdate: async () => {
            if (table === schema.signalIngestionCursors) Object.assign(cursorRows, row);
          },
        }),
      }),
    };
    const poller = new DiscordPoller(db as never, {
      historyPages: 3,
      recoveryMessageCap: 100,
      fetchImpl: async () => Response.json(pages.shift() ?? []),
    });

    await (poller as unknown as { fetchHistory(): Promise<void> }).fetchHistory();

    expect(insertedIds[0]).toContain(":1:AAPL");
    expect(insertedIds.at(-1)).toContain(":100:AAPL");
    expect(insertedIds).toHaveLength(100);
    expect((poller as unknown as { lastMessageId: string }).lastMessageId).toBe("100");
    expect(cursorRows.backfillCursor).toBe("1");
    expect(cursorRows.backfillComplete).toBe(false);
  });

  it("recovers older events after an initial mid-page insert failure", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const storedIds = new Set<string>();
    const cursorRow: Record<string, unknown> = {};
    const requestedUrls: string[] = [];
    let failedOnce = false;
    const pageDescending = (newest: number, count: number) => Array.from({ length: count }, (_, index) => ({
      id: String(newest - index),
      content: "$AAPL",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-08-20T12:00:00.000Z",
      channel_id: "channel",
    }));
    const pageAscending = (oldest: number, count: number) => pageDescending(oldest + count - 1, count);
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedUrls.push(String(input));
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      if (!before && !after) return Response.json(pageDescending(200, 100));
      if (before === "101") return Response.json(pageDescending(100, 100));
      if (before === "201") return Response.json(pageDescending(200, 100));
      if (before === "200") return Response.json(pageDescending(199, 100));
      if (before === "100") return Response.json(pageDescending(99, 99));
      if (after === "101") return Response.json(pageAscending(102, 99));
      return Response.json([]);
    };
    const db = {
      query: {
        signalIngestionCursors: { findFirst: async () => cursorRow },
        signals: { findFirst: async () => undefined },
      },
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            if (table !== schema.signals) return;
            const sourceEventId = String(row.sourceEventId ?? "");
            const messageId = sourceEventId.split(":").at(-2);
            if (messageId === "102" && !failedOnce) {
              failedOnce = true;
              throw new Error("mid-page insert failure");
            }
            if (!storedIds.has(messageId ?? "")) storedIds.add(messageId ?? "");
          },
          onConflictDoUpdate: async () => {
            if (table === schema.signalIngestionCursors) Object.assign(cursorRow, row);
          },
        }),
      }),
    };
    const poller = new DiscordPoller(db as never, {
      historyPages: 3,
      fetchImpl,
    });
    const privatePoller = poller as unknown as {
      fetchHistory(): Promise<void>;
      pollNewMessages(): Promise<void>;
    };

    await privatePoller.fetchHistory();
    expect(cursorRow.backfillCursor).toBe("201");
    expect(cursorRow.backfillComplete).toBe(false);
    expect(storedIds).toEqual(
      new Set(Array.from({ length: 101 }, (_, index) => String(index + 1))),
    );

    requestedUrls.length = 0;
    await privatePoller.pollNewMessages();

    expect(storedIds.size).toBe(200);
    expect([...storedIds].sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 200 }, (_, index) => String(index + 1)),
    );
    expect(cursorRow.backfillCursor).toBeNull();
    expect(cursorRow.backfillComplete).toBe(true);
    const beforeValues = requestedUrls
      .map((value) => new URL(value).searchParams.get("before"))
      .filter((value): value is string => value !== null);
    expect(beforeValues).toContain("201");
    expect(beforeValues).toContain("101");
    expect(beforeValues.indexOf("201")).toBeLessThan(beforeValues.indexOf("101"));
  });

  it("does not slice a backward page at a cap boundary", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const insertedIds: string[] = [];
    const cursorRows: Record<string, unknown> = {
      cursor: "1000",
      backfillCursor: "1000",
      backfillComplete: false,
    };
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => ({
      id: String(start - index),
      content: "$AAPL",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-08-20T12:00:00.000Z",
      channel_id: "channel",
    }));
    const db = {
      query: {
        signalIngestionCursors: { findFirst: async () => cursorRows },
        signals: { findFirst: async () => undefined },
      },
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            if (table === schema.signals) insertedIds.push(String(row.sourceEventId));
          },
          onConflictDoUpdate: async () => {
            if (table === schema.signalIngestionCursors) Object.assign(cursorRows, row);
          },
        }),
      }),
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const before = url.searchParams.get("before");
      if (before === "1000") return Response.json(page(900));
      if (before === "801") return Response.json(page(800));
      return Response.json([]);
    };
    const poller = new DiscordPoller(db as never, {
      historyPages: 3,
      recoveryMessageCap: 150,
      fetchImpl,
    });
    const privatePoller = poller as unknown as {
      fetchHistory(): Promise<void>;
    };

    await privatePoller.fetchHistory();
    expect(insertedIds).toHaveLength(100);
    expect(cursorRows.backfillCursor).toBe("801");
    expect(cursorRows.backfillComplete).toBe(false);

    await privatePoller.fetchHistory();
    expect(insertedIds).toHaveLength(200);
    expect(cursorRows.backfillCursor).toBeNull();
    expect(cursorRows.backfillComplete).toBe(true);
  });

  it("does not canonicalize a relay webhook or bot ID as the X caller", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      query: { signals: { findFirst: async () => undefined } },
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
        },
      }),
    };
    const poller = new DiscordPoller(db as never);
    await (poller as unknown as { processMessage(message: unknown): Promise<unknown> }).processMessage({
      id: "303",
      content: "$AAPL",
      author: { id: "relay-webhook", username: "TweetShift", bot: true },
      webhook_id: "relay-webhook",
      timestamp: "2026-07-30T12:00:00.000Z",
      channel_id: "channel",
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.sourceAuthorId).toBeNull();
    const metadata = inserted[0]?.metadata;
    expect(
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).canonicalAuthorKey
        : undefined,
    ).toBeUndefined();
  });

  it("advances past a malformed event with a usable source ID", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const poller = new DiscordPoller({} as never, {
      fetchImpl: async () => Response.json([
        { id: "601", content: "$AAPL", timestamp: "2026-07-30T12:00:00.000Z" },
        {
          id: "602",
          content: "no ticker",
          author: { id: "author", username: "Caller" },
          timestamp: "2026-07-30T12:00:00.000Z",
          channel_id: "channel",
        },
      ]),
    });
    const privatePoller = poller as unknown as {
      lastMessageId: string | null;
      pollNewMessages(): Promise<void>;
    };
    privatePoller.lastMessageId = "600";

    await privatePoller.pollNewMessages();

    expect(privatePoller.lastMessageId).toBe("602");
  });

  it("lets the database unique event key absorb a concurrent retry", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const inserted = new Set<string>();
    const insertAttempts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const db = {
      query: {
        signals: {
          findFirst: async () => {
            await gate;
            return undefined;
          },
        },
      },
      insert: (table: unknown) => ({
        values: (row: { sourceEventId?: string }) => ({
          onConflictDoNothing: async () => {
            if (table === schema.signals && row.sourceEventId) {
              insertAttempts.push(row.sourceEventId);
              inserted.add(row.sourceEventId);
            }
          },
        }),
      }),
    };
    const poller = new DiscordPoller(db as never);
    const processMessage = (poller as unknown as {
      processMessage(message: {
        id: string;
        content: string;
        author: { id: string; username: string };
        timestamp: string;
        channel_id: string;
      }): Promise<unknown>;
    }).processMessage.bind(poller);
    const message = {
      id: "701",
      content: "$AAPL",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-07-30T12:00:00.000Z",
      channel_id: "channel",
    };

    const first = processMessage(message);
    const second = processMessage(message);
    release();
    await Promise.all([first, second]);

    expect(insertAttempts).toHaveLength(2);
    expect(inserted.size).toBe(1);
    expect(inserted.has("discord:channel:701:AAPL")).toBe(true);
  });

  it("does not overlap poll calls while a fetch is in flight", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const poller = new DiscordPoller({} as never, {
      fetchImpl: async () => {
        calls += 1;
        await gate;
        return Response.json([]);
      },
    });
    const privatePoller = poller as unknown as {
      lastMessageId: string;
      pollNewMessages(): Promise<void>;
    };
    privatePoller.lastMessageId = "400";

    const first = privatePoller.pollNewMessages();
    await privatePoller.pollNewMessages();
    expect(calls).toBe(1);
    release();
    await first;
  });

  it("loads and advances a durable cursor across poller restarts", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    let storedCursor = "500";
    const requestedAfter: string[] = [];
    const db = {
      query: {
        signalIngestionCursors: {
          findFirst: async () => ({ cursor: storedCursor }),
        },
        signals: { findFirst: async () => undefined },
      },
      insert: (table: unknown) => ({
        values: (row: { cursor?: string }) => {
          if (table === schema.signalIngestionCursors) {
            return {
              onConflictDoUpdate: async () => {
                storedCursor = row.cursor ?? storedCursor;
              },
            };
          }
          return { onConflictDoNothing: async () => undefined };
        },
      }),
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const after = url.searchParams.get("after");
      if (after) requestedAfter.push(after);
      return Response.json(after === "500" ? [{
        id: "501",
        content: "no ticker",
        author: { id: "author", username: "Caller" },
        timestamp: "2026-07-30T12:00:00.000Z",
        channel_id: "channel",
      }] : []);
    };

    const first = new DiscordPoller(db as never, { fetchImpl });
    await (first as unknown as { pollNewMessages(): Promise<void> }).pollNewMessages();
    expect(storedCursor).toBe("501");

    const second = new DiscordPoller(db as never, { fetchImpl });
    await (second as unknown as { pollNewMessages(): Promise<void> }).pollNewMessages();
    expect(requestedAfter).toEqual(["500", "501"]);
  });

  it("has a CAS loser adopt the durable winner before the next request", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const requestedAfter: string[] = [];
    const cursorRow: Record<string, unknown> = {
      cursor: "100",
      backfillCursor: null,
      backfillComplete: true,
    };
    let firstCursorRead = true;
    const db = {
      query: {
        signalIngestionCursors: {
          findFirst: async () => {
            if (firstCursorRead) {
              firstCursorRead = false;
              return { ...cursorRow };
            }
            return { ...cursorRow };
          },
        },
        signals: { findFirst: async () => undefined },
      },
      insert: (table: unknown) => ({
        values: () => ({
          onConflictDoNothing: async () => undefined,
          onConflictDoUpdate: () => {
            if (table !== schema.signalIngestionCursors) return;
            Object.assign(cursorRow, { cursor: "300", cursorSequence: "300" });
            return {
              returning: async () => [],
            };
          },
        }),
      }),
    };
    const poller = new DiscordPoller(db as never, {
      fetchImpl: async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const after = url.searchParams.get("after");
        if (after) requestedAfter.push(after);
        return Response.json(after === "100" ? [{
          id: "201",
          content: "no ticker",
          author: { id: "author", username: "Caller" },
          timestamp: "2026-07-30T12:00:00.000Z",
          channel_id: "channel",
        }] : []);
      },
    });
    const privatePoller = poller as unknown as {
      pollNewMessages(): Promise<void>;
    };

    await privatePoller.pollNewMessages();
    await privatePoller.pollNewMessages();

    expect(requestedAfter).toEqual(["100", "300"]);
  });

  it("has a backfill CAS loser adopt the durable boundary before the next request", async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    const requested: string[] = [];
    const cursorRow: Record<string, unknown> = {
      cursor: "500",
      backfillCursor: "501",
      backfillComplete: false,
    };
    const db = {
      query: {
        signalIngestionCursors: { findFirst: async () => ({ ...cursorRow }) },
        signals: { findFirst: async () => undefined },
      },
      insert: (table: unknown) => ({
        values: () => ({
          onConflictDoUpdate: () => {
            if (table !== schema.signalIngestionCursors) return;
            Object.assign(cursorRow, {
              backfillCursor: "1",
              backfillComplete: true,
            });
            return { returning: async () => [] };
          },
        }),
      }),
    };
    const poller = new DiscordPoller(db as never, {
      fetchImpl: async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(url.search);
        return Response.json([]);
      },
    });
    const privatePoller = poller as unknown as {
      lastMessageId: string;
      backfillCursor: string;
      backfillComplete: boolean;
      cursorLoaded: boolean;
      persistBackfillState(cursor: string, complete: boolean): Promise<void>;
      fetchHistory(): Promise<void>;
    };
    privatePoller.lastMessageId = "500";
    privatePoller.backfillCursor = "501";
    privatePoller.backfillComplete = false;
    privatePoller.cursorLoaded = true;

    await privatePoller.persistBackfillState("400", false);
    expect(privatePoller.backfillCursor).toBe("1");
    expect(privatePoller.backfillComplete).toBe(true);

    await privatePoller.fetchHistory();
    expect(requested).toEqual(["?limit=100&after=500"]);
  });
});

describe("Discord rate limiting", () => {
  it("reads the retry delay from the body, then the header, and sanitizes it", () => {
    expect(resolveDiscordRetryAfterMs('{"retry_after":0.417}', null)).toBe(417);
    // A Cloudflare-level 429 answers with HTML, so the header is the only source.
    expect(resolveDiscordRetryAfterMs("<html>too many requests</html>", "2")).toBe(2_000);
    expect(resolveDiscordRetryAfterMs("{}", null)).toBe(1_000);
    expect(resolveDiscordRetryAfterMs('{"retry_after":-1}', null)).toBe(1_000);
    expect(resolveDiscordRetryAfterMs('{"retry_after":"soon"}', null)).toBe(1_000);
    // Reported as asked, not clamped: the caller decides a long wait is not
    // worth retrying at all.
    expect(resolveDiscordRetryAfterMs('{"retry_after":900}', null)).toBe(900_000);
  });

  it("surfaces a global rate limit instead of retrying through it", async () => {
    // Discord escalates to a Cloudflare ban for clients that keep hitting a
    // global limit, so a long retry_after must end the read, not shorten it.
    let requests = 0;
    const slept: number[] = [];
    const poller = new DiscordPoller({} as never, {
      fetchImpl: async () => {
        requests += 1;
        return new Response('{"retry_after": 900, "global": true}', { status: 429 });
      },
      sleepImpl: async (ms: number) => {
        slept.push(ms);
      },
    });

    await expect(
      (poller as unknown as { fetchMessages(): Promise<unknown> }).fetchMessages(),
    ).rejects.toThrow("Discord API error 429");
    expect(requests).toBe(1);
    expect(slept).toEqual([]);
  });

  it("waits out a 429 and re-reads the page instead of failing the poll cycle", async () => {
    const message = {
      id: "100",
      content: "no ticker in this message",
      author: { id: "author", username: "Caller" },
      timestamp: "2026-07-30T12:00:00.000Z",
      channel_id: "channel",
    };
    const responses = [
      new Response('{"message": "You are being rate limited.", "retry_after": 0.417}', {
        status: 429,
      }),
      new Response(JSON.stringify([message]), { status: 200 }),
    ];
    const slept: number[] = [];
    const poller = new DiscordPoller({} as never, {
      fetchImpl: async () => responses.shift()!,
      sleepImpl: async (ms: number) => {
        slept.push(ms);
      },
    });

    const messages = await (poller as unknown as {
      fetchMessages(): Promise<{ id: string }[]>;
    }).fetchMessages();

    expect(messages.map((entry) => entry.id)).toEqual(["100"]);
    expect(slept).toEqual([417]);
    expect(responses).toHaveLength(0);
  });

  it("gives up after a bounded number of retries rather than blocking the poller", async () => {
    let requests = 0;
    const slept: number[] = [];
    const poller = new DiscordPoller({} as never, {
      fetchImpl: async () => {
        requests += 1;
        return new Response('{"retry_after": 0.3}', { status: 429 });
      },
      sleepImpl: async (ms: number) => {
        slept.push(ms);
      },
    });

    await expect(
      (poller as unknown as { fetchMessages(): Promise<unknown> }).fetchMessages(),
    ).rejects.toThrow("Discord API error 429");
    expect(requests).toBe(4);
    expect(slept).toEqual([300, 300, 300]);
  });
});
