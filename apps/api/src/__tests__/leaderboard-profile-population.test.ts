import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { canonicalAuthorKey } from "@trade-bot/utils";

const getRedisClient = vi.fn();
const createHyperliquidInfoClient = vi.fn();
const createMasterAlpacaClient = vi.fn();

vi.mock("@trade-bot/redis", () => ({ getRedisClient }));
const actualHyperliquid = await import("../lib/hyperliquid.js");
const actualAlpaca = await import("../lib/alpaca.js");
vi.mock("../lib/hyperliquid.js", () => ({
  ...actualHyperliquid,
  createHyperliquidInfoClient,
}));
vi.mock("../lib/alpaca.js", () => ({
  ...actualAlpaca,
  createMasterAlpacaClient,
}));

const { cachedOrLive, leaderboardRouter } = await import("../routers/leaderboard.js");

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockImplementation((limit: number) => Promise.resolve(rows.slice(0, limit)));
  return query;
}

function createScanAwareQuery(globalRows: unknown[], detailRows: unknown[]) {
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockImplementation((limit: number) =>
    Promise.resolve((limit > 5_000 ? globalRows : detailRows).slice(0, limit)),
  );
  return query;
}

/** A query double that applies the actual author predicate instead of ignoring `.where()`. */
function createAuthorPredicateQuery(rows: unknown[]) {
  let whereCondition: unknown;
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.where.mockImplementation((condition: unknown) => {
    whereCondition = condition;
    return query;
  });
  query.orderBy.mockReturnValue(query);
  query.limit.mockImplementation((limit: number) => {
    const compiled = whereCondition
      ? new PgDialect().sqlToQuery(whereCondition as never)
      : null;
    const isAuthorDetail = Boolean(
      compiled?.sql.includes("authorName") || compiled?.sql.includes("authorHandle"),
    );
    if (!isAuthorDetail) return Promise.resolve(rows.slice(0, limit));

    const expected = compiled?.params.find(
      (value): value is string => value === "handle-only caller",
    );
    const matching = rows.filter((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const record = candidate as { metadata?: unknown; source?: string };
      if (record.source !== "x") return false;
      const metadata = typeof record.metadata === "string"
        ? JSON.parse(record.metadata) as Record<string, unknown>
        : record.metadata as Record<string, unknown>;
      const display = typeof metadata?.authorName === "string"
        ? metadata.authorName.trim()
        : "";
      const handle = typeof metadata?.authorHandle === "string"
        ? metadata.authorHandle.trim()
        : "";
      return (display || handle).replace(/\s+/g, " ").toLowerCase() === expected;
    });
    return Promise.resolve(matching.slice(0, limit));
  });
  return query;
}

function createCaller(db: unknown) {
  return leaderboardRouter.createCaller({
    db: db as never,
    session: { userId: "user-1" },
    userId: "user-1",
    logger: createLogger() as never,
  });
}

const originalMasterKey = process.env.ALPACA_MASTER_KEY;
const originalMasterSecret = process.env.ALPACA_MASTER_SECRET;

describe("xCallerProfile measurement population", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALPACA_MASTER_KEY;
    delete process.env.ALPACA_MASTER_SECRET;
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    });
    createHyperliquidInfoClient.mockReturnValue({
      candleHistory: vi.fn().mockResolvedValue([]),
    });
  });

  afterEach(() => {
    if (originalMasterKey === undefined) delete process.env.ALPACA_MASTER_KEY;
    else process.env.ALPACA_MASTER_KEY = originalMasterKey;
    if (originalMasterSecret === undefined) delete process.env.ALPACA_MASTER_SECRET;
    else process.env.ALPACA_MASTER_SECRET = originalMasterSecret;
  });

  it("retains an older eligible stock call after newer PERP detail calls", async () => {
    const newestPerpCalls = Array.from({ length: 50 }, (_, index) => ({
      id: `perp-${index}`,
      symbol: "BTC",
      content: "$BTC bullish buy",
      url: null,
      source: "discord",
      timestamp: new Date(Date.UTC(2026, 7, 21, 12, 0, 0) - index * 1_000),
      metadata: {
        authorName: "Mixed Caller",
        platform: "hyperliquid",
        instrument: "perp",
        direction: "bullish",
      },
    }));
    const olderEligibleStockCall = {
      id: "stock-old",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      url: null,
      source: "discord",
      timestamp: new Date(Date.UTC(2026, 7, 20, 12, 0, 0)),
      metadata: { authorName: "Mixed Caller" },
    };
    const modernRows = [...newestPerpCalls, olderEligibleStockCall];
    const select = vi
      .fn()
      .mockImplementationOnce(() => createQuery(modernRows))
      .mockImplementationOnce(() => createQuery(modernRows));

    const result = await createCaller({ select }).xCallerProfile({
      authorKey: "mixed caller",
      window: "all",
      horizonDays: 1,
    });

    expect(result.callCount).toBe(51);
    expect(result.directionalCallCount).toBe(51);
    expect(result.needsMarketData).toBe(true);
    expect(result.measurementCandidateCount).toBe(51);
    expect(result.measurementCallsRetainedCount).toBe(50);
    expect(result.measurementCandidateOmittedCount).toBe(1);
    expect(result.measurementCallCap).toBe(50);
    expect(result.measurementCapped).toBe(true);
    expect(result.measuredCallCount).toBe(0);
    expect(result.calls).toHaveLength(50);
    expect(result.calls.every((call) => call.id !== "stock-old")).toBe(true);
  });

  it("returns the retained score calls instead of newer non-directional detail calls", async () => {
    const recentUnknownCalls = Array.from({ length: 50 }, (_, index) => ({
      id: `unknown-${index}`,
      symbol: "AAPL",
      content: "$AAPL update",
      url: null,
      source: "discord",
      timestamp: new Date(Date.UTC(2026, 7, 21, 12, 0, 0) - index * 1_000),
      metadata: { authorName: "Score Caller" },
    }));
    const olderEligibleCall = {
      id: "score-call",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      url: null,
      source: "discord",
      timestamp: new Date("2026-08-20T12:00:00.000Z"),
      metadata: { authorName: "Score Caller" },
    };
    const select = vi.fn(() => createQuery([...recentUnknownCalls, olderEligibleCall]));

    const result = await createCaller({ select }).xCallerProfile({
      authorKey: "score caller",
      window: "all",
      horizonDays: 1,
    });

    expect(result.measurementCandidateCount).toBe(1);
    expect(result.measurementCallsRetainedCount).toBe(1);
    expect(result.calls.map((call) => call.id)).toEqual(["score-call"]);
  });

  it("sanitizes unsafe profile source links before returning them", async () => {
    const rows = [{
      id: "unsafe-source",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      url: "javascript:alert(1)",
      source: "discord",
      timestamp: new Date("2026-08-20T12:00:00.000Z"),
      metadata: { authorName: "Unsafe Source Caller" },
    }];

    const result = await createCaller({ select: vi.fn(() => createQuery(rows)) })
      .xCallerProfile({
        authorKey: "unsafe source caller",
        window: "all",
        horizonDays: 1,
      });

    expect(result.calls[0]?.url).toBeNull();
  });

  it("uses handle-only fallback in structured and legacy profile predicates", async () => {
    const rows = [
      {
        id: "structured-handle",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "x",
        timestamp: new Date("2026-08-20T12:00:00.000Z"),
        metadata: { authorName: "", authorHandle: "Handle-Only Caller" },
      },
      {
        id: "legacy-handle",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "x",
        timestamp: new Date("2026-08-20T11:00:00.000Z"),
        metadata: JSON.stringify({ authorHandle: "Handle-Only Caller" }),
      },
      {
        id: "wrong-author",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "x",
        timestamp: new Date("2026-08-20T10:00:00.000Z"),
        metadata: { authorName: "Other Caller" },
      },
    ];
    const caller = createCaller({
      select: vi.fn(() => createAuthorPredicateQuery(rows)),
    });

    const profile = await caller.xCallerProfile({
      authorKey: "handle-only caller",
      window: "all",
      horizonDays: 1,
    });

    expect(profile.callCount).toBe(2);
    expect(profile.calls.map((call) => call.id)).toEqual([
      "structured-handle",
      "legacy-handle",
    ]);
  });

  it("coalesces concurrent cache misses and removes rejected in-flight work", async () => {
    const compute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { value: 7 };
    });
    const first = cachedOrLive("coalesced-test", 0, compute);
    const second = cachedOrLive("coalesced-test", 0, compute);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: 7 },
      { value: 7 },
    ]);
    expect(compute).toHaveBeenCalledTimes(1);

    let rejectionCalls = 0;
    await expect(
      cachedOrLive("rejected-test", 0, async () => {
        rejectionCalls += 1;
        throw new Error("compute failed");
      }),
    ).rejects.toThrow("compute failed");
    await expect(
      cachedOrLive("rejected-test", 0, async () => {
        rejectionCalls += 1;
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(rejectionCalls).toBe(2);
  });

  it("serves stale leaderboard data immediately while refreshing in the background", async () => {
    let finishRefresh!: (value: { value: number }) => void;
    const set = vi.fn().mockResolvedValue(undefined);
    getRedisClient.mockResolvedValue({
      get: vi.fn().mockResolvedValue(JSON.stringify({
        version: 1,
        cachedAt: Date.now() - 61_000,
        freshUntil: Date.now() - 1,
        data: { value: 7 },
      })),
      set,
    });
    const compute = vi.fn(() => new Promise<{ value: number }>((resolve) => {
      finishRefresh = resolve;
    }));

    await expect(cachedOrLive("stale-test", 60, compute)).resolves.toEqual({ value: 7 });
    expect(compute).toHaveBeenCalledTimes(1);

    finishRefresh({ value: 8 });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(set).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(set.mock.calls[0]![1] as string) as { data: unknown };
    expect(stored.data).toEqual({ value: 8 });
  });

  it("does not score an author outside the shared 5,000-row global population", async () => {
    const globalRows = Array.from({ length: 5_000 }, (_, index) => ({
      id: `global-${index}`,
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      url: null,
      source: "discord",
      timestamp: new Date(Date.UTC(2026, 7, 21, 12, 0, 0) - index * 1_000),
      metadata: { authorName: "Other Caller" },
    }));
    const targetRow = {
      id: "target-old",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      url: null,
      source: "discord",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      metadata: { authorName: "Target Caller" },
    };
    const select = vi.fn(() => createScanAwareQuery(
      [...globalRows, targetRow],
      [targetRow],
    ));

    const caller = createCaller({ select });
    const global = await caller.xCallers({
      window: "all",
      horizonDays: 1,
      sortBy: "forwardReturn",
      limit: 100,
    });
    expect(global.dataComplete).toBe(false);
    expect(global.rows.some((row) => row.followTarget.key === "target caller")).toBe(false);

    const profile = await caller.xCallerProfile({
      authorKey: "target caller",
      window: "all",
      horizonDays: 1,
    });
    expect(profile.callCount).toBe(1);
    expect(profile.calls.map((call) => call.id)).toEqual(["target-old"]);
    expect(profile.measurementStatus).toBe("not_comparable");
    expect(profile.hitRate).toBeNull();
    expect(profile.avgForwardReturnPct).toBeNull();
    expect(profile.measuredCallCount).toBe(0);
  });

  it("keeps global and profile mixed-asset measurements in parity", async () => {
    const stockCallTime = new Date("2026-08-01T12:00:00.000Z");
    const perpCallTime = new Date("2026-08-01T12:00:01.000Z");
    const rows = [
      {
        id: "stock-call",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "discord",
        timestamp: stockCallTime,
        metadata: { authorName: "Parity Caller" },
      },
      {
        id: "perp-call",
        symbol: "BTC",
        content: "$BTC short",
        url: null,
        source: "discord",
        timestamp: perpCallTime,
        metadata: {
          authorName: "Parity Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "short",
          hlTicker: "BTC",
        },
      },
    ];

    createMasterAlpacaClient.mockReturnValue({
      getBars: vi.fn().mockResolvedValue([
        { t: "2026-08-01T23:59:59.000Z", c: "100" },
        { t: "2026-08-02T23:59:59.000Z", c: "110" },
      ]),
    });
    createHyperliquidInfoClient.mockReturnValue({
      candleHistory: vi.fn().mockResolvedValue([
        {
          t: Date.parse("2026-08-01T00:00:00.000Z"),
          T: Date.parse("2026-08-01T23:59:59.000Z"),
          c: "200",
        },
        {
          t: Date.parse("2026-08-02T00:00:00.000Z"),
          T: Date.parse("2026-08-02T23:59:59.000Z"),
          c: "180",
        },
      ]),
    });

    const select = vi.fn(() => createQuery(rows));
    const caller = createCaller({ select });
    const global = await caller.xCallers({
      window: "all",
      horizonDays: 1,
      sortBy: "forwardReturn",
      limit: 100,
    });
    const profile = await caller.xCallerProfile({
      authorKey: "parity caller",
      window: "all",
      horizonDays: 1,
    });

    expect(global.rankingFallback).toBe(false);
    expect(global.marketDataHealth).toMatchObject({
      requestedMarketCount: 2,
      availableMarketCount: 2,
      unavailableMarketCount: 0,
      complete: true,
    });
    expect(global.rows[0]).toMatchObject({
      callCount: 2,
      directionalCallCount: 2,
      measurementCandidateCount: 2,
      measuredCallCount: 2,
      assetCoverage: "both",
      assetCallCounts: { stocks: 1, perps: 1 },
      hitRate: 1,
      avgForwardReturnPct: 10,
    });
    expect(profile).toMatchObject({
      callCount: 2,
      directionalCallCount: 2,
      measurementCandidateCount: 2,
      measuredCallCount: 2,
      assetCoverage: "both",
      assetCallCounts: { stocks: 1, perps: 1 },
      hitRate: 1,
      avgForwardReturnPct: 10,
      measurementStatus: "measured",
    });
    expect(profile.avgForwardReturnPct).toBe(global.rows[0]!.avgForwardReturnPct);
    expect(profile.measuredCallCount).toBe(global.rows[0]!.measuredCallCount);
  });

  it("returns the canonical profile key and matching display/count truth", async () => {
    const rows = [
      {
        id: "punctuated-caller",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: "https://x.com/a/status/42",
        source: "x",
        timestamp: new Date("2026-08-20T12:00:00.000Z"),
        metadata: {
          authorName: "Jane Q. O'Neil / Macro",
          authorSource: "x",
          sourceAuthorId: "author/42?display=macro",
          canonicalAuthorKey: "source_author:x:author%2F42%3Fdisplay%3Dmacro",
          platform: "alpaca",
        },
      },
    ];
    createMasterAlpacaClient.mockReturnValue({
      getBars: vi.fn().mockResolvedValue([
        { t: "2026-08-20T23:59:59.000Z", c: "100" },
        { t: "2026-08-21T23:59:59.000Z", c: "110" },
      ]),
    });

    const caller = createCaller({ select: vi.fn(() => createQuery(rows)) });
    const global = await caller.xCallers({
      window: "all",
      horizonDays: 1,
      sortBy: "forwardReturn",
      limit: 100,
    });
    const profile = await caller.xCallerProfile({
      authorKey: "jane q. o'neil / macro",
      window: "all",
      horizonDays: 1,
    });

    expect(global.rows[0]).toMatchObject({
      displayName: "Jane Q. O'Neil / Macro",
      assetCoverage: "stocks",
      assetCallCounts: { stocks: 1, perps: 0 },
      callCount: 1,
    });
    expect(profile).toMatchObject({
      displayName: "Jane Q. O'Neil / Macro",
      assetCoverage: "stocks",
      assetCallCounts: { stocks: 1, perps: 0 },
      callCount: 1,
      followTarget: {
        type: "x_author",
        key: "source_author:x:author%2F42%3Fdisplay%3Dmacro",
      },
    });
    expect(profile.calls[0]).toMatchObject({
      assetClass: "stocks",
      url: "https://x.com/a/status/42",
    });
  });

  it("uses the persisted Discord author id for ranking and profile identity", async () => {
    const authorKey = canonicalAuthorKey("discord", "424242424242424242")!;
    const rows = [{
      id: "discord-only-signal",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      url: "https://discord.com/channels/1/2/3",
      source: "discord",
      sourceEventId: "discord:2:3:AAPL",
      sourceAuthorId: "424242424242424242",
      timestamp: new Date("2026-08-20T12:00:00.000Z"),
      metadata: { authorName: "Discord Only Caller" },
    }];

    const caller = createCaller({ select: vi.fn(() => createQuery(rows)) });
    const ranking = await caller.xCallers({
      window: "all",
      horizonDays: 1,
      sortBy: "calls",
      limit: 100,
    });
    const profile = await caller.xCallerProfile({
      authorKey,
      window: "all",
      horizonDays: 1,
    });

    expect(ranking.rows[0]).toMatchObject({
      displayName: "Discord Only Caller",
      callCount: 1,
      followTarget: { key: authorKey },
    });
    expect(profile).toMatchObject({
      displayName: "Discord Only Caller",
      callCount: 1,
      followTarget: { key: authorKey },
    });
  });

  it("reports a market cap as intentional omission without turning it into provider outage", async () => {
    createHyperliquidInfoClient.mockReturnValue({
      candleHistory: vi.fn().mockResolvedValue([
        {
          t: Date.parse("2026-08-20T00:00:00.000Z"),
          T: Date.parse("2026-08-20T23:59:59.000Z"),
          c: "100",
        },
      ]),
    });
    const rows = Array.from({ length: 61 }, (_, index) => ({
      id: `market-${index}`,
      symbol: `C${index}`,
      content: `$C${index} bullish buy`,
      url: null,
      source: "discord",
      timestamp: new Date("2026-08-20T12:00:00.000Z"),
      metadata: {
        authorName: `Market Caller ${index}`,
        platform: "hyperliquid",
        instrument: "perp",
        direction: "long",
        hlTicker: `abc:C${index}`,
      },
    }));
    const caller = createCaller({ select: vi.fn(() => createQuery(rows)) });
    const result = await caller.xCallers({
      window: "all",
      horizonDays: 1,
      sortBy: "calls",
      limit: 100,
    });

    expect(result.marketDataHealth).toMatchObject({
      totalMarketCount: 61,
      requestedMarketCount: 60,
      availableMarketCount: 60,
      unavailableMarketCount: 0,
      omittedMarketCount: 1,
      capped: true,
      providerComplete: true,
      complete: false,
    });
    expect(result.partialMarketData).toBe(true);
    expect(result.dataComplete).toBe(false);
    const profile = await caller.xCallerProfile({
      authorKey: "Market Caller 0",
      window: "all",
      horizonDays: 1,
    });
    expect(profile).toMatchObject({
      rankingFallback: false,
      partialMarketData: true,
      dataComplete: false,
      marketDataHealth: {
        omittedMarketCount: 1,
        capped: true,
        complete: false,
      },
    });
    expect(result.signalScan).toEqual({
      cap: 5_000,
      retainedCount: 61,
      observedCount: 61,
      truncated: false,
    });
  });
});
