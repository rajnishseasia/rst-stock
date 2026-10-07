import { describe, expect, test } from "bun:test";
import { schema } from "@trade-bot/db";
import type { Logger } from "@trade-bot/logger";
import {
  PasteTradePoller,
  PASTE_TRADE_SOURCE,
  collectExistingSourceRowIds,
  describeEnabledFlag,
  describePasteTradeOutcome,
  isPasteTradePollerEnabled,
  mapPasteTradeRow,
  parsePasteTradeTicker,
  pasteTradeVersionKey,
  resolvePasteTradeBaseUrl,
  resolvePasteTradePollIntervalMs,
  selectNewPasteTradeRows,
  type PasteTradeBoardRow,
} from "../paste-trade-poller";
import boardRowFixture from "./fixtures/paste-trade-board-row.json";

// A real board row captured live from GET /api/board?window=today&lens=max.
const fixtureRow = boardRowFixture as unknown as PasteTradeBoardRow;

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

interface CapturedLog {
  level: "error" | "warn" | "notice" | "info" | "debug";
  message: string;
  context?: Record<string, unknown>;
}

function captureLogger(entries: CapturedLog[]): Logger {
  const logger: Logger = {
    error: (_service: string, message: string, context?: Record<string, unknown>) => {
      entries.push({ level: "error", message, context });
    },
    warn: (_service: string, message: string, context?: Record<string, unknown>) => {
      entries.push({ level: "warn", message, context });
    },
    notice: (_service: string, message: string, context?: Record<string, unknown>) => {
      entries.push({ level: "notice", message, context });
    },
    info: (_service: string, message: string, context?: Record<string, unknown>) => {
      entries.push({ level: "info", message, context });
    },
    debug: (_service: string, message: string, context?: Record<string, unknown>) => {
      entries.push({ level: "debug", message, context });
    },
    child: () => logger,
    withDefaultService: () => logger,
    raw: {} as Logger["raw"],
  } satisfies Logger;
  return logger;
}

/** mapPasteTradeRow returning null means "skip"; tests on valid rows unwrap it. */
function mustMap(row: PasteTradeBoardRow, baseUrl?: string) {
  const mapped =
    baseUrl === undefined ? mapPasteTradeRow(row) : mapPasteTradeRow(row, baseUrl);
  if (mapped === null) throw new Error("expected the row to map to an insert");
  return mapped;
}

describe("mapPasteTradeRow", () => {
  const signal = mustMap(fixtureRow);

  test("sets the source and uppercases the symbol", () => {
    expect(signal.source).toBe(PASTE_TRADE_SOURCE);
    expect(signal.source).toBe("paste.trade");
    expect(signal.symbol).toBe("GOOGL");
  });

  test("stores the thesis content verbatim (external data, em dash kept)", () => {
    expect(signal.content).toBe(fixtureRow.thesis ?? "");
    // The real thesis contains a U+2014 em dash; we must never rewrite it.
    expect(signal.content).toContain("—");
  });

  test("parses author_date into a Date timestamp", () => {
    expect(signal.timestamp).toBeInstanceOf(Date);
    expect((signal.timestamp as Date).getTime()).toBe(
      Date.parse("2026-07-22T04:06:28.000Z"),
    );
  });

  test("falls back to created_at and skips rows with no usable timestamp", () => {
    const mapped = mustMap({
      id: "created-at-row",
      ticker: "AAPL",
      created_at: "2026-07-22T05:00:00.000Z",
    });
    expect((mapped.timestamp as Date).toISOString()).toBe("2026-07-22T05:00:00.000Z");
    expect(
      mapPasteTradeRow({ id: "missing-time", ticker: "AAPL" }),
    ).toBeNull();
  });

  test("links the paste.trade site root by default", () => {
    expect(signal.url).toBe("https://paste.trade");
  });

  test("carries platform, instrument, and direction through on metadata", () => {
    const meta = signal.metadata as Record<string, unknown>;
    expect(meta.platform).toBe("hyperliquid");
    expect(meta.instrument).toBe("perps");
    expect(meta.direction).toBe("short");
    expect(meta.hlTicker).toBe("xyz:GOOGL");
  });

  test("maps author, pricing, and dedup metadata fields", () => {
    const meta = signal.metadata as Record<string, unknown>;
    expect(meta.authorId).toBe("af2d96d5-4");
    expect(meta.authorName).toBe("Tae Kim");
    expect(meta.authorHandle).toBe("firstadopter");
    expect(meta.leverage).toBe(20);
    expect(meta.entryPrice).toBe(349.25);
    expect(meta.peopleCount).toBe(5);
    expect(meta.pnlDisplay).toBe("+135.3%");
    // The row id is the dedup key, stored as both sourceRowId and messageId.
    expect(meta.sourceRowId).toBe(fixtureRow.id);
    expect(meta.messageId).toBe(fixtureRow.id);
    expect(meta.authorSource).toBe(PASTE_TRADE_SOURCE);
    expect(meta.sourceAuthorId).toBe(fixtureRow.author_id);
    expect(meta.canonicalAuthorKey).toBe(`source_author:paste.trade:${fixtureRow.author_id}`);
    expect(signal.sourceEventId).toBe(`paste.trade:${fixtureRow.id}:GOOGL`);
  });

  test("resolves a site-relative avatar path to an absolute URL", () => {
    const meta = signal.metadata as Record<string, unknown>;
    expect(meta.authorAvatar).toBe("https://paste.trade/api/avatars/af2d96d5-4");
  });

  test("honours a custom base URL for both the link and the avatar", () => {
    const custom = mustMap(fixtureRow, "https://staging.paste.trade");
    const meta = custom.metadata as Record<string, unknown>;
    expect(custom.url).toBe("https://staging.paste.trade");
    expect(meta.authorAvatar).toBe(
      "https://staging.paste.trade/api/avatars/af2d96d5-4",
    );
  });

  test("returns null for an oversized or invalid-charset ticker (audit M7)", () => {
    const base: PasteTradeBoardRow = {
      id: "bad-1",
      ticker: "A".repeat(22), // over the shared 21-char cap
      author_date: "2026-07-22T10:00:00.000Z",
    };
    expect(mapPasteTradeRow(base)).toBeNull();
    expect(mapPasteTradeRow({ ...base, ticker: "AAPL; DROP TABLE" })).toBeNull();
    expect(mapPasteTradeRow({ ...base, ticker: "<script>" })).toBeNull();
    expect(mapPasteTradeRow({ ...base, ticker: "" })).toBeNull();
    // A valid ticker at the boundary still maps.
    expect(mapPasteTradeRow({ ...base, ticker: "A".repeat(21) })).not.toBeNull();
  });

  test("stores hl_ticker only when it is a canonical Hyperliquid coin", () => {
    // hl_ticker is the one field on a board row that names a LEVERAGED market
    // for the copy-trade auto-mirror, so it is validated at the trust boundary
    // exactly like the ticker. A value HL cannot resolve becomes null, and the
    // mirror then fails closed on a missing coin instead of guessing one.
    const base: PasteTradeBoardRow = {
      id: "hl-1",
      ticker: "GOOGL",
      platform: "hyperliquid",
      instrument: "perp",
      direction: "short",
      author_date: "2026-07-22T10:00:00.000Z",
    };
    const hlTickerOf = (hl_ticker: unknown) =>
      (mustMap({ ...base, hl_ticker } as PasteTradeBoardRow).metadata as Record<
        string,
        unknown
      >).hlTicker;

    // Canonical values survive with their case and dex prefix intact.
    expect(hlTickerOf("xyz:GOOGL")).toBe("xyz:GOOGL");
    expect(hlTickerOf("kPEPE")).toBe("kPEPE");
    expect(hlTickerOf(" BTC ")).toBe("BTC");

    for (const bad of ["GOOGL/USD", "xyz:", "GOOG L", "", "A".repeat(21), 42, null, undefined]) {
      expect(hlTickerOf(bad)).toBeNull();
    }
  });

  test("does NOT assume perps: an equity row keeps its own platform/instrument", () => {
    const equityRow: PasteTradeBoardRow = {
      id: "equity-1",
      ticker: "aapl",
      direction: "long",
      platform: "robinhood",
      instrument: "stock",
      author_name: "Someone",
      author_date: "2026-07-22T10:00:00.000Z",
      author_avatar_url: "https://cdn.example.com/a.png",
      thesis: "Equities call",
    };
    const mapped = mustMap(equityRow);
    const meta = mapped.metadata as Record<string, unknown>;
    expect(mapped.symbol).toBe("AAPL");
    expect(meta.platform).toBe("robinhood");
    expect(meta.instrument).toBe("stock");
    // Absolute avatar URLs pass through unchanged.
    expect(meta.authorAvatar).toBe("https://cdn.example.com/a.png");
  });
});

describe("parsePasteTradeTicker (audit M7 constraints)", () => {
  test("accepts the shared symbol charset and uppercases", () => {
    expect(parsePasteTradeTicker("googl")).toBe("GOOGL");
    expect(parsePasteTradeTicker("BRK.B")).toBe("BRK.B");
    expect(parsePasteTradeTicker("brk-b")).toBe("BRK-B");
    expect(parsePasteTradeTicker("A".repeat(21))).toBe("A".repeat(21));
    expect(parsePasteTradeTicker("xyz:GOOGL")).toBe("xyz:GOOGL");
    expect(parsePasteTradeTicker("kPEPE2")).toBe("kPEPE2");
    expect(parsePasteTradeTicker("kpepe2")).toBeNull();
  });

  test("rejects malformed separator tokens instead of accepting a prefix", () => {
    for (const ticker of ["A..B", "A-", "A/"]) {
      expect(parsePasteTradeTicker(ticker)).toBeNull();
    }
  });

  test("rejects an implausibly future timestamp", () => {
    expect(mapPasteTradeRow(
      {
        id: "future",
        ticker: "AAPL",
        author_date: "2099-01-01T00:00:00.000Z",
      },
      undefined,
      new Date("2026-08-21T12:00:00.000Z"),
    )).toBeNull();
  });

  test("rejects a row whose source timestamp is malformed", () => {
    expect(
      mapPasteTradeRow({
        id: "bad-time",
        ticker: "AAPL",
        author_date: "not-a-timestamp",
      }),
    ).toBeNull();
  });

  test("rejects oversized, out-of-charset, empty, and non-string tickers", () => {
    expect(parsePasteTradeTicker("A".repeat(22))).toBeNull();
    expect(parsePasteTradeTicker("AAPL$")).toBeNull();
    expect(parsePasteTradeTicker("AA PL")).toBeNull();
    expect(parsePasteTradeTicker("")).toBeNull();
    expect(parsePasteTradeTicker(null)).toBeNull();
    expect(parsePasteTradeTicker(undefined)).toBeNull();
    expect(parsePasteTradeTicker(42)).toBeNull();
  });
});

describe("dedup helpers", () => {
  test("collectExistingSourceRowIds reads object and JSON-string metadata", () => {
    const ids = collectExistingSourceRowIds([
      { metadata: { sourceRowId: "a1" } },
      { metadata: JSON.stringify({ sourceRowId: "b2" }) },
      // Falls back to messageId when sourceRowId is absent.
      { metadata: { messageId: "c3" } },
      { metadata: null },
      { metadata: "not json" },
    ]);
    expect(ids.has("a1")).toBe(true);
    expect(ids.has("b2")).toBe(true);
    expect(ids.has("c3")).toBe(true);
    expect(ids.size).toBe(3);
  });

  test("selectNewPasteTradeRows skips stored ids, intra-batch dupes, and junk rows", () => {
    const rows: PasteTradeBoardRow[] = [
      { id: "keep-1", ticker: "AAA" },
      { id: "stored-1", ticker: "BBB" },
      { id: "keep-1", ticker: "AAA" }, // duplicate within the batch
      { id: "keep-2", ticker: "CCC" },
      { id: "", ticker: "DDD" }, // no id
      { id: "no-ticker", ticker: "" }, // no ticker
    ];
    const existing = new Set<string>(["stored-1"]);
    const result = selectNewPasteTradeRows(rows, existing);
    expect(result.map((r) => r.id)).toEqual(["keep-1", "keep-2"]);
  });
});

describe("environment helpers", () => {
  test("isPasteTradePollerEnabled requires the exact string 'true'", () => {
    expect(isPasteTradePollerEnabled(env({ PASTE_TRADE_POLLER_ENABLED: "true" }))).toBe(true);
    expect(isPasteTradePollerEnabled(env({ PASTE_TRADE_POLLER_ENABLED: "TRUE" }))).toBe(false);
    expect(isPasteTradePollerEnabled(env({ PASTE_TRADE_POLLER_ENABLED: "1" }))).toBe(false);
    expect(isPasteTradePollerEnabled(env({}))).toBe(false);
  });

  test("resolvePasteTradeBaseUrl defaults and trims trailing slashes", () => {
    expect(resolvePasteTradeBaseUrl(env({}))).toBe("https://paste.trade");
    expect(
      resolvePasteTradeBaseUrl(env({ PASTE_TRADE_BASE_URL: "https://staging.paste.trade/" })),
    ).toBe("https://staging.paste.trade");
  });

  test("resolvePasteTradePollIntervalMs defaults and rejects invalid values", () => {
    expect(resolvePasteTradePollIntervalMs(env({}))).toBe(60_000);
    expect(resolvePasteTradePollIntervalMs(env({ PASTE_TRADE_POLL_INTERVAL_MS: "30000" }))).toBe(
      30_000,
    );
    expect(resolvePasteTradePollIntervalMs(env({ PASTE_TRADE_POLL_INTERVAL_MS: "-5" }))).toBe(
      60_000,
    );
    expect(resolvePasteTradePollIntervalMs(env({ PASTE_TRADE_POLL_INTERVAL_MS: "abc" }))).toBe(
      60_000,
    );
  });

  test("pasteTradeVersionKey changes when count or computed_at changes", () => {
    const base = { count: 182, computed_at: "2026-07-23T00:16:32.476Z" };
    expect(pasteTradeVersionKey(base)).toBe("182:2026-07-23T00:16:32.476Z");
    expect(pasteTradeVersionKey({ ...base, count: 183 })).not.toBe(
      pasteTradeVersionKey(base),
    );
    expect(pasteTradeVersionKey({ ...base, computed_at: "later" })).not.toBe(
      pasteTradeVersionKey(base),
    );
  });
});

describe("processBoard (dedup + insert against a mocked db)", () => {
  function makeDb(existing: Array<{ metadata: unknown }>, inserted: unknown[]) {
    return {
      query: {
        signals: {
          findMany: async () => existing,
        },
      },
      insert: () => ({
        values: async (row: unknown) => {
          inserted.push(row);
        },
      }),
    } as never;
  }

  test("inserts only rows whose id is not already stored", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const existing = [{ metadata: { sourceRowId: "already-there" } }];
    const poller = new PasteTradePoller(makeDb(existing, inserted));

    const rows: PasteTradeBoardRow[] = [
      { id: "already-there", ticker: "OLD", author_date: "2026-07-22T00:00:00.000Z" },
      { id: "brand-new", ticker: "new", author_date: "2026-07-22T01:00:00.000Z" },
    ];

    await (
      poller as unknown as { processBoard: (rows: PasteTradeBoardRow[]) => Promise<void> }
    ).processBoard(rows);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.symbol).toBe("NEW");
    expect(inserted[0]?.source).toBe("paste.trade");
    const meta = inserted[0]?.metadata as Record<string, unknown>;
    expect(meta.sourceRowId).toBe("brand-new");
  });

  test("inserts nothing when the board is empty", async () => {
    const inserted: unknown[] = [];
    const poller = new PasteTradePoller(makeDb([], inserted));
    await (
      poller as unknown as { processBoard: (rows: PasteTradeBoardRow[]) => Promise<void> }
    ).processBoard([]);
    expect(inserted).toHaveLength(0);
  });

  test("skips a row with an invalid ticker but still inserts the valid ones", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const poller = new PasteTradePoller(makeDb([], inserted));

    const rows: PasteTradeBoardRow[] = [
      { id: "bad-ticker", ticker: "AAPL; DROP TABLE", author_date: "2026-07-22T00:00:00.000Z" },
      { id: "oversized", ticker: "X".repeat(40), author_date: "2026-07-22T00:30:00.000Z" },
      { id: "good", ticker: "msft", author_date: "2026-07-22T01:00:00.000Z" },
    ];

    await (
      poller as unknown as { processBoard: (rows: PasteTradeBoardRow[]) => Promise<void> }
    ).processBoard(rows);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.symbol).toBe("MSFT");
    const meta = inserted[0]?.metadata as Record<string, unknown>;
    expect(meta.sourceRowId).toBe("good");
  });

  test("skips malformed timestamps without blocking later valid rows", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const poller = new PasteTradePoller(makeDb([], inserted));

    await (
      poller as unknown as { processBoard: (rows: PasteTradeBoardRow[]) => Promise<unknown> }
    ).processBoard([
      { id: "bad-time", ticker: "AAPL", author_date: "not-a-timestamp" },
      { id: "missing-time", ticker: "MSFT" },
      { id: "good-after-bad", ticker: "NVDA", created_at: "2026-07-22T02:00:00.000Z" },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.symbol).toBe("NVDA");
  });
});

describe("poll reentrancy guard", () => {
  test("an overlapping tick is skipped while the previous poll is in flight", async () => {
    const poller = new PasteTradePoller({} as never);
    let fetchVersionCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Seam: stall the first poll inside fetchVersion (no network involved).
    (poller as unknown as { fetchVersion: () => Promise<unknown> }).fetchVersion =
      async () => {
        fetchVersionCalls += 1;
        await gate;
        throw new Error("stop after gate");
      };

    const asPollable = poller as unknown as { poll: () => Promise<void> };
    const first = asPollable.poll();
    // Second tick while the first is still awaiting: must return without
    // touching fetchVersion again.
    await asPollable.poll();
    expect(fetchVersionCalls).toBe(1);

    release();
    await first;

    // After the first cycle settles, the guard resets and polling resumes.
    await asPollable.poll();
    expect(fetchVersionCalls).toBe(2);
  });
});

describe("durable version cursor", () => {
  test("a restarted poller treats the stored board version as already consumed", async () => {
    let storedCursor = "2:2026-07-31T12:00:00.000Z";
    let boardFetches = 0;
    const db = {
      query: {
        signalIngestionCursors: {
          findFirst: async () => ({ cursor: storedCursor }),
        },
        signals: { findMany: async () => [] },
      },
      insert: () => ({
        values: (row: { cursor?: string }) => ({
          onConflictDoUpdate: () => {
            storedCursor = row.cursor ?? storedCursor;
          },
        }),
      }),
    };
    const fetch = async (url: string) => {
      if (url.includes("/api/board/version")) {
        return Response.json({ count: 2, computed_at: "2026-07-31T12:00:00.000Z" });
      }
      boardFetches += 1;
      return Response.json({ rows: [] });
    };

    const poller = new PasteTradePoller(db as never, {
      env: env({ PASTE_TRADE_POLLER_ENABLED: "true" }),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(storedCursor).toBe("2:2026-07-31T12:00:00.000Z");
    expect(boardFetches).toBe(0);
  });

  test("a CAS loser adopts the durable winner before the next version request", async () => {
    const oldKey = "1:2026-07-31T11:00:00.000Z";
    const winnerKey = "2:2026-07-31T12:00:00.000Z";
    const cursorRow: Record<string, unknown> = { cursor: oldKey };
    let firstCursorRead = true;
    const versionRequests: string[] = [];
    let boardFetches = 0;
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
        signals: { findMany: async () => [] },
      },
      insert: (table: unknown) => ({
        values: () => ({
          onConflictDoNothing: async () => undefined,
          onConflictDoUpdate: () => {
            if (table !== schema.signalIngestionCursors) return;
            Object.assign(cursorRow, { cursor: winnerKey, cursorSequence: "2" });
            return {
              returning: async () => [],
            };
          },
        }),
      }),
    };
    const fetch = async (url: string) => {
      if (url.includes("/api/board/version")) {
        versionRequests.push(url);
        return Response.json(versionRequests.length === 1
          ? { count: 0, computed_at: "2026-07-31T12:00:00.000Z" }
          : { count: 2, computed_at: "2026-07-31T12:00:00.000Z" });
      }
      boardFetches += 1;
      return Response.json({ rows: [] });
    };
    const poller = new PasteTradePoller(db as never, {
      env: env({ PASTE_TRADE_POLLER_ENABLED: "true" }),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const asPollable = poller as unknown as { poll(): Promise<void> };

    await asPollable.poll();
    await asPollable.poll();

    expect((poller as unknown as { lastVersionKey: string }).lastVersionKey).toBe(winnerKey);
    expect(versionRequests).toHaveLength(2);
    expect(boardFetches).toBe(1);
  });
});

describe("production diagnostics", () => {
  const enabledEnv = env({ PASTE_TRADE_POLLER_ENABLED: "true" });

  test("logs the disabled state without exposing configuration values", async () => {
    const entries: CapturedLog[] = [];
    const poller = new PasteTradePoller({} as never, {
      env: env({ PASTE_TRADE_POLLER_ENABLED: "false" }),
      logger: captureLogger(entries),
      fetch: (async () => {
        throw new Error("fetch must not run");
      }) as unknown as typeof fetch,
    });

    await poller.start();

    expect(entries).toContainEqual({
      level: "info",
      message: "paste.trade poller disabled (PASTE_TRADE_POLLER_ENABLED!=true)",
      context: { state: "disabled", observedFlag: '"false"' },
    });
  });

  test("a disabled start() names the value that failed the exact match", async () => {
    // The complaint this exists for: "PASTE_TRADE_POLLER_ENABLED is set to true
    // and nothing comes in". The kill switch is an exact "true" match, so a
    // capitalized or padded value keeps the poller inert while looking correct
    // in a dashboard. The log has to show which one it actually saw.
    for (const [raw, rendered] of [
      ["True", '"True"'],
      ["TRUE", '"TRUE"'],
      ["true ", '"true "'],
      ["1", '"1"'],
      [undefined, "unset"],
    ] as const) {
      const entries: CapturedLog[] = [];
      const poller = new PasteTradePoller({} as never, {
        env: env({ PASTE_TRADE_POLLER_ENABLED: raw }),
        logger: captureLogger(entries),
        fetch: (async () => {
          throw new Error("fetch must not run");
        }) as unknown as typeof fetch,
      });

      await poller.start();

      expect(entries.at(-1)?.context).toEqual({
        state: "disabled",
        observedFlag: rendered,
      });
    }
  });

  test("describeEnabledFlag bounds a pathological value", () => {
    expect(describeEnabledFlag(undefined)).toBe("unset");
    expect(describeEnabledFlag("true")).toBe('"true"');
    expect(describeEnabledFlag("x".repeat(500)).length).toBeLessThanOrEqual(24);
  });

  test("classifies auth failures using status only", async () => {
    const entries: CapturedLog[] = [];
    const poller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(entries),
      fetch: (async () =>
        new Response("secret response body", { status: 401 })) as unknown as typeof fetch,
    });

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries).toContainEqual({
      level: "error",
      message: "Poll failed",
      context: {
        state: "auth_failure",
        stage: "version",
        endpoint: "version",
        status: 401,
      },
    });
    expect(JSON.stringify(entries)).not.toContain("secret response body");
  });

  test("distinguishes malformed JSON from upstream HTTP failures", async () => {
    const parseEntries: CapturedLog[] = [];
    const parsePoller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(parseEntries),
      fetch: (async () =>
        new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    });
    await (parsePoller as unknown as { poll: () => Promise<void> }).poll();
    expect(parseEntries.at(-1)?.context).toEqual({
      state: "parse_failure",
      stage: "version",
      endpoint: "version",
      status: undefined,
    });

    const upstreamEntries: CapturedLog[] = [];
    const upstreamPoller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(upstreamEntries),
      fetch: (async () =>
        new Response(null, { status: 503 })) as unknown as typeof fetch,
    });
    await (upstreamPoller as unknown as { poll: () => Promise<void> }).poll();
    expect(upstreamEntries.at(-1)?.context).toEqual({
      state: "upstream_failure",
      stage: "version",
      endpoint: "version",
      status: 503,
    });
  });

  test("a rejected fetch is attributed to its endpoint and named", async () => {
    // Previously any throw out of fetch() surfaced as a bare
    // { state: "upstream_failure" } with no endpoint, no name and no message,
    // so a DNS failure, a TLS error and our own 10s abort were one log line.
    const entries: CapturedLog[] = [];
    const poller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(entries),
      fetch: (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND paste.trade");
      }) as unknown as typeof fetch,
    });

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries.at(-1)?.context).toEqual({
      state: "upstream_failure",
      stage: "version",
      endpoint: "version",
      status: undefined,
      reason: "network",
      errorName: "TypeError",
      errorMessage: "getaddrinfo ENOTFOUND paste.trade",
    });
  });

  test("a fetch that outruns the timeout reports reason 'timeout'", async () => {
    const entries: CapturedLog[] = [];
    const poller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(entries),
      fetchTimeoutMs: 10,
      // Reject the way fetch does when its AbortSignal fires. The poller
      // distinguishes this from a network refusal by its own timer, not by
      // sniffing the error, so the classification cannot drift with runtimes.
      fetch: ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })) as unknown as typeof fetch,
    });

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    const context = entries.at(-1)?.context;
    expect(context?.state).toBe("upstream_failure");
    expect(context?.endpoint).toBe("version");
    expect(context?.reason).toBe("timeout");
  });

  test("a database failure is db_failure, not upstream_failure", async () => {
    // The two states demand opposite responses: upstream means wait for
    // paste.trade, db means this worker's own connection is down and no
    // poller in the process is writing anything.
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 1, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({ rows: [{ id: "row-1", ticker: "AAPL", author_date: "2026-07-31T12:00:00.000Z" }] }),
    ];
    const poller = new PasteTradePoller(
      {
        query: {
          signals: {
            findMany: async () => {
              throw new Error("connection terminated unexpectedly");
            },
          },
        },
      } as never,
      {
        env: enabledEnv,
        logger: captureLogger(entries),
        fetch: (async () =>
          responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    );

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries.at(-1)).toEqual({
      level: "error",
      message: "Poll failed",
      context: {
        state: "db_failure",
        stage: "dedup_read",
        errorName: "Error",
        errorMessage: "connection terminated unexpectedly",
      },
    });
    // A failed cycle must not bank the version, or the next poll skips the
    // board it never actually ingested.
    expect(
      (poller as unknown as { lastVersionKey: string | null }).lastVersionKey,
    ).toBeNull();
  });

  test("a failing insert is reported at the insert stage", async () => {
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 1, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({ rows: [{ id: "row-1", ticker: "AAPL", author_date: "2026-07-31T12:00:00.000Z" }] }),
    ];
    const poller = new PasteTradePoller(
      {
        query: { signals: { findMany: async () => [] } },
        insert: () => ({
          values: async () => {
            throw new Error("null value in column violates not-null constraint");
          },
        }),
      } as never,
      {
        env: enabledEnv,
        logger: captureLogger(entries),
        fetch: (async () =>
          responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    );

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries.at(-1)?.context).toMatchObject({
      state: "db_failure",
      stage: "insert",
      errorName: "Error",
    });
  });

  test("connection credentials in a driver error never reach the log", async () => {
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 1, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({ rows: [{ id: "row-1", ticker: "AAPL" }] }),
    ];
    const poller = new PasteTradePoller(
      {
        query: {
          signals: {
            findMany: async () => {
              throw new Error(
                "could not connect to postgresql://postgres:hunter2@db.example.com:5432/tradebot",
              );
            },
          },
        },
      } as never,
      {
        env: enabledEnv,
        logger: captureLogger(entries),
        fetch: (async () =>
          responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    );

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[REDACTED]@db.example.com");
  });

  test("a cycle that inserts nothing still says why", async () => {
    // The gap that made this whole class of question unanswerable: the old
    // poller logged an insert line only when insertedCount > 0, so the normal
    // steady state (the board still holds calls we already stored) produced NO
    // record at all and read exactly like a poller that never ran.
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 2, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({
        rows: [
          { id: "row-1", ticker: "AAPL" },
          { id: "row-2", ticker: "MSFT" },
        ],
      }),
    ];
    const poller = new PasteTradePoller(
      {
        query: {
          signals: {
            findMany: async () => [
              { metadata: { sourceRowId: "row-1" } },
              { metadata: { sourceRowId: "row-2" } },
            ],
          },
        },
        insert: () => ({
          values: async () => {
            throw new Error("must not insert a duplicate");
          },
        }),
      } as never,
      {
        env: enabledEnv,
        logger: captureLogger(entries),
        fetch: (async () =>
          responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    );

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries.at(-1)).toEqual({
      level: "info",
      message: "Poll completed",
      context: {
        state: "healthy",
        outcome: "all_duplicates",
        rowCount: 2,
        versionCount: 2,
        crowdRowCount: 0,
        boardRowCount: 2,
        knownRowIdCount: 2,
        newRowCount: 0,
        insertedCount: 0,
        duplicateCount: 2,
        invalidTickerCount: 0,
        invalidTimestampCount: 0,
      },
    });
  });

  test("consecutive unchanged versions are counted, not just repeated", async () => {
    // A streak that climbs forever means paste.trade stopped recomputing the
    // board. Without the count that is indistinguishable from a dead poller.
    const entries: CapturedLog[] = [];
    const poller = new PasteTradePoller(
      { query: { signals: { findMany: async () => [] } } } as never,
      {
        env: enabledEnv,
        logger: captureLogger(entries),
        fetch: (async (url: string) =>
          url.includes("/api/board/version")
            ? Response.json({ count: 0, computed_at: "2026-07-31T12:00:00.000Z" })
            : Response.json({ rows: [] })) as unknown as typeof fetch,
      },
    );

    const asPollable = poller as unknown as { poll: () => Promise<void> };
    await asPollable.poll(); // establishes the key (count 0 => genuinely empty)
    await asPollable.poll();
    await asPollable.poll();

    const unchanged = entries.filter((e) => e.message === "Board version unchanged");
    expect(unchanged.map((e) => e.context?.unchangedStreak)).toEqual([1, 2]);
  });

  test("describePasteTradeOutcome separates a quiet board from a broken one", () => {
    const base = {
      boardRowCount: 3,
      knownRowIdCount: 3,
      newRowCount: 0,
      insertedCount: 0,
      duplicateCount: 3,
      invalidTickerCount: 0,
      invalidTimestampCount: 0,
    };
    expect(describePasteTradeOutcome(base)).toBe("all_duplicates");
    expect(describePasteTradeOutcome({ ...base, insertedCount: 1 })).toBe("inserted");
    expect(
      describePasteTradeOutcome({
        ...base,
        boardRowCount: 0,
        duplicateCount: 0,
        knownRowIdCount: 0,
      }),
    ).toBe("no_rows");
    expect(
      describePasteTradeOutcome({
        ...base,
        newRowCount: 2,
        duplicateCount: 1,
        invalidTickerCount: 2,
      }),
    ).toBe("all_invalid");
  });

  test("advances the version key for a genuinely empty board", async () => {
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 0, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({ rows: [] }),
    ];
    const poller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(entries),
      fetch: (async () =>
        responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
    });

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    // A board reporting count 0 and returning no rows is genuinely empty, not
    // anomalous, so it must NOT warn. The warning is reserved for the
    // inconsistent case asserted in the next test: a non-zero count with no
    // usable rows. This test previously expected a warn here, which asserted a
    // behavior the poller deliberately does not have.
    expect(entries.filter((e) => e.level === "warn")).toEqual([]);
    expect((poller as unknown as { lastVersionKey: string | null }).lastVersionKey).not.toBeNull();
  });

  test("tolerates a null prices_as_of / window_end on the version endpoint", async () => {
    // Production payload observed 2026-08-10: paste.trade serves
    // `"prices_as_of": null` (and sometimes `window_end` the same way) instead
    // of omitting the field. z.string().optional() accepts a MISSING key but
    // rejects an explicit null, so every poll cycle failed parse_failure and
    // the poller never advanced past the version check.
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({
        count: 0,
        computed_at: "2026-08-10T04:52:45.799Z",
        prices_as_of: null,
        window_end: null,
      }),
      Response.json({ rows: [] }),
    ];
    const poller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(entries),
      fetch: (async () =>
        responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
    });

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries.filter((e) => e.level === "error")).toEqual([]);
    expect((poller as unknown as { lastVersionKey: string | null }).lastVersionKey).not.toBeNull();
  });

  test("warns and does NOT advance the version when a non-empty board returns no rows", async () => {
    // The inconsistent case the warning exists for: the board claims rows but
    // serves none. The version key must stay put so the next poll retries it,
    // otherwise a transient upstream glitch silently drops a whole version.
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 7, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({ rows: [] }),
    ];
    const poller = new PasteTradePoller({} as never, {
      env: enabledEnv,
      logger: captureLogger(entries),
      fetch: (async () =>
        responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
    });

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries).toContainEqual({
      level: "warn",
      message: "Board returned no usable rows despite non-zero count",
      context: { state: "empty", endpoint: "board", versionCount: 7 },
    });
    expect(
      (poller as unknown as { lastVersionKey: string | null }).lastVersionKey,
    ).toBeNull();
  });

  test("keeps valid rows when a board snapshot contains malformed rows", async () => {
    const entries: CapturedLog[] = [];
    const responses = [
      Response.json({ count: 2, computed_at: "2026-07-31T12:00:00.000Z" }),
      Response.json({
        rows: [
          { id: "valid", ticker: "AAPL", author_date: "2026-07-31T12:00:00.000Z" },
          { id: "invalid", ticker: 123, credential: "must-not-leak" },
        ],
      }),
    ];
    const poller = new PasteTradePoller(
      {
        query: { signals: { findMany: async () => [] } },
        insert: () => ({ values: async () => {} }),
      } as never,
      {
        env: enabledEnv,
        logger: captureLogger(entries),
        fetch: (async () =>
          responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    );

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(entries).toContainEqual({
      level: "warn",
      message: "Board contained malformed rows",
      context: {
        state: "parse_failure",
        endpoint: "board",
        rejectedRowCount: 1,
        acceptedRowCount: 1,
      },
    });
    expect((poller as unknown as { lastVersionKey: string | null }).lastVersionKey).not.toBeNull();
    expect(JSON.stringify(entries)).not.toContain("must-not-leak");
  });
});

describe("crowd flattening", () => {
  const enabledEnv = env({ PASTE_TRADE_POLLER_ENABLED: "true" });

  function addFixtureTimestamps(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = { ...(value as Record<string, unknown>) };
    if (record.author_date === undefined && record.created_at === undefined) {
      record.author_date = "2026-07-31T12:00:00.000Z";
    }
    if (Array.isArray(record.crowd)) {
      record.crowd = record.crowd.map(addFixtureTimestamps);
    }
    return record;
  }

  /** Run one poll over a board payload and return the rows the poller inserted. */
  async function ingest(
    boardRows: unknown[],
    options: { existing?: Array<{ metadata: unknown }>; entries?: CapturedLog[] } = {},
  ) {
    const inserted: Array<Record<string, unknown>> = [];
    const responses = [
      Response.json({
        count: boardRows.length,
        computed_at: "2026-07-31T12:00:00.000Z",
      }),
      Response.json({ rows: boardRows.map(addFixtureTimestamps) }),
    ];
    const poller = new PasteTradePoller(
      {
        query: { signals: { findMany: async () => options.existing ?? [] } },
        insert: () => ({
          values: async (row: Record<string, unknown>) => {
            inserted.push(row);
          },
        }),
      } as never,
      {
        env: enabledEnv,
        logger: captureLogger(options.entries ?? []),
        fetch: (async () =>
          responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    );
    await (poller as unknown as { poll: () => Promise<void> }).poll();
    return inserted;
  }

  test("co-signers nested under a lead row are ingested as their own signals", async () => {
    // The gap this closes: the board serves only the LEAD call for a ticker at
    // the top level and buries every other caller in `crowd`. Reading the top
    // level alone dropped roughly 40% of the board, and those callers never
    // reached the feed or the leaderboard at all.
    const inserted = await ingest([
      {
        id: "lead-1",
        ticker: "NVDA",
        author_name: "lead caller",
        author_price: 100,
        crowd: [
          { id: "crowd-1", ticker: "NVDA", author_name: "second caller", author_price: 101 },
          { id: "crowd-2", ticker: "NVDA", author_name: "third caller", author_price: 102 },
        ],
      },
    ]);

    expect(inserted).toHaveLength(3);
    expect(inserted.map((row) => (row.metadata as { sourceRowId: string }).sourceRowId)).toEqual([
      "lead-1",
      "crowd-1",
      "crowd-2",
    ]);
    // Each nested entry keeps its OWN author and entry price. Collapsing them
    // onto the lead would attribute one caller's call to another.
    expect(inserted.map((row) => (row.metadata as { authorName: string }).authorName)).toEqual([
      "lead caller",
      "second caller",
      "third caller",
    ]);
    expect(inserted.map((row) => (row.metadata as { entryPrice: number }).entryPrice)).toEqual([
      100, 101, 102,
    ]);
  });

  test("a crowd entry already stored is not inserted again", async () => {
    const inserted = await ingest(
      [
        {
          id: "lead-1",
          ticker: "NVDA",
          crowd: [
            { id: "crowd-1", ticker: "NVDA" },
            { id: "crowd-2", ticker: "NVDA" },
          ],
        },
      ],
      { existing: [{ metadata: { sourceRowId: "crowd-1" } }] },
    );

    expect(inserted.map((row) => (row.metadata as { sourceRowId: string }).sourceRowId)).toEqual([
      "lead-1",
      "crowd-2",
    ]);
  });

  test("a crowd entry repeating a top-level id is inserted once", async () => {
    // Defensive: if paste.trade ever serves the same call in both places, the
    // id-keyed batch dedup must catch it before it becomes two feed cards.
    const inserted = await ingest([
      { id: "shared", ticker: "NVDA", crowd: [{ id: "shared", ticker: "NVDA" }] },
    ]);

    expect(inserted).toHaveLength(1);
  });

  test("one malformed co-signer does not cost us the rest of the board", async () => {
    const entries: CapturedLog[] = [];
    const inserted = await ingest(
      [
        {
          id: "lead-1",
          ticker: "NVDA",
          crowd: [{ id: "crowd-1", ticker: 404, credential: "must-not-leak" }, { id: "crowd-2", ticker: "NVDA" }],
        },
      ],
      { entries },
    );

    expect(inserted.map((row) => (row.metadata as { sourceRowId: string }).sourceRowId)).toEqual([
      "lead-1",
      "crowd-2",
    ]);
    expect(entries).toContainEqual({
      level: "warn",
      message: "Board contained malformed rows",
      context: {
        state: "parse_failure",
        endpoint: "board",
        rejectedRowCount: 1,
        acceptedRowCount: 2,
      },
    });
    expect(JSON.stringify(entries)).not.toContain("must-not-leak");
  });

  test("flattening stops after one level", async () => {
    // Nested entries carry no `crowd` of their own. Recursing on a passthrough
    // schema would let a malformed upstream payload drive unbounded work
    // inside a single poll cycle.
    const inserted = await ingest([
      {
        id: "lead-1",
        ticker: "NVDA",
        crowd: [
          { id: "crowd-1", ticker: "NVDA", crowd: [{ id: "deep-1", ticker: "NVDA" }] },
        ],
      },
    ]);

    expect(inserted.map((row) => (row.metadata as { sourceRowId: string }).sourceRowId)).toEqual([
      "lead-1",
      "crowd-1",
    ]);
  });

  test("the cycle summary reports how many rows came from crowd arrays", async () => {
    const entries: CapturedLog[] = [];
    await ingest(
      [
        { id: "lead-1", ticker: "NVDA", crowd: [{ id: "crowd-1", ticker: "NVDA" }] },
        { id: "lead-2", ticker: "AAPL" },
      ],
      { entries },
    );

    expect(entries.at(-1)?.context).toMatchObject({
      outcome: "inserted",
      boardRowCount: 3,
      crowdRowCount: 1,
      insertedCount: 3,
    });
  });
});
