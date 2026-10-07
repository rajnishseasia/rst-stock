import { describe, expect, it } from "bun:test";
import {
  reconstructRealizedPnl,
  aggregateUserStats,
  forwardReturnPct,
  aggregateCallerStats,
  scoreXCallReturn,
  groupTradeEventsByUser,
  canonicalizeTradeRows,
  compareCanonicalCandidates,
  UserLeaderboardAccumulator,
  LeaderboardFifoCapacityError,
  resolveEventPriceQty,
  resolveTradeEventAt,
  compareLeaderboardEventRows,
  resolveLeaderboardEventCursor,
  isAfterLeaderboardEventCursor,
  OPTION_CONTRACT_MULTIPLIER,
  computeLeaderboardMeta,
  type TradeEvent,
  type RealizedPnlResult,
  type UserSymbolReconstruction,
  type SocialOrderRow,
} from "../lib/leaderboard.js";
import {
  callerAssetCoverage,
  collectBoundedCallSymbols,
  computeCallForwardReturn,
  computeXCallMeasurement,
  groupXLeaderboardCalls,
  resolveXCallerBucket,
  latestCallSourceUrl,
  resolveSelfMembership,
  normalizedLegacySignalAuthorCondition,
  canonicalSignalAuthorCondition,
  mergeSignalRowsByRecency,
  canonicalXCallerScanPopulation,
  normalizedSignalAuthorCondition,
  buildLeaderboardCursorCondition,
  buildLeaderboardCanonicalMaterializationQuery,
  USER_HISTORY_CANDIDATE_FETCH_LIMIT,
  resolveSelfStanding,
  USER_RANK_LOOKUP_CAP,
  xCallersCacheTtlSeconds,
  usersCacheTtlSeconds,
  resolveUsersLeaderboardCapacity,
  xCallsNeedMarketData,
  xCallerAssetClass,
  xCallerMarketRef,
  collectBoundedMarketRefs,
  countUnresolvedMarketCandidates,
  addUnresolvedMarketHealth,
  addOmittedMarketHealth,
  readBoundedDurableXCallerObservations,
  aggregateXCallMeasurements,
  sortXCallerRows,
  userLeaderboardHorizon,
  XCALLERS_DEGRADED_TTL_SECONDS,
  XCALLERS_HEALTHY_TTL_SECONDS,
  USER_LEADERBOARD_DEGRADED_TTL_SECONDS,
  USER_LEADERBOARD_HEALTHY_TTL_SECONDS,
  USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP,
  measureHyperliquidUnrealizedPnl,
  type UserLeaderboardRow,
} from "../routers/leaderboard.js";
import { canonicalAuthorKey } from "@trade-bot/utils";
import { PgDialect } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "@trade-bot/db";

/** Mirrors the router's tradeAction -> side mapping for the grouping tests. */
function tradeActionSide(action: string | null | undefined): "buy" | "sell" {
  const a = (action ?? "").toLowerCase();
  if (a.includes("buy") || a.includes("cover")) return "buy";
  return "sell";
}

// ---- Test helpers ---------------------------------------------------------

describe("collectBoundedCallSymbols", () => {
  it("deduplicates and caps only the requested caller's symbols", () => {
    expect(
      collectBoundedCallSymbols(
        [
          { symbol: "AAPL" },
          { symbol: "MSFT" },
          { symbol: "AAPL" },
          { symbol: "NVDA" },
        ],
        2,
      ),
    ).toEqual(["AAPL", "MSFT"]);
  });
});

describe("groupXLeaderboardCalls", () => {
  it("groups immutable-ID rows across handle and display-name changes", () => {
    const key = canonicalAuthorKey("discord", "42")!;
    const grouped = groupXLeaderboardCalls([
      {
        id: "new",
        symbol: "MSFT",
        content: "$MSFT",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-30T12:00:00.000Z"),
        metadata: {
          authorSource: "discord",
          sourceAuthorId: "42",
          canonicalAuthorKey: key,
          authorName: "New Name",
          authorHandle: "new_handle",
          authorAliases: ["new name", "new_handle", "old name", "old_handle"],
        },
      },
      {
        id: "old",
        symbol: "AAPL",
        content: "$AAPL",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-29T12:00:00.000Z"),
        metadata: {
          authorName: "Old Name",
          authorHandle: "old_handle",
          authorId: "42",
        },
      },
    ]);

    expect(grouped.size).toBe(1);
    expect(grouped.get(key)?.totalCallCount).toBe(2);
    expect(grouped.get(key)?.label).toBe("New Name");
    expect(resolveXCallerBucket(grouped, "old name")?.totalCallCount).toBe(2);
  });

  it("does not resolve an alias shared by two immutable identities", () => {
    const first = canonicalAuthorKey("x", "1")!;
    const second = canonicalAuthorKey("x", "2")!;
    const grouped = groupXLeaderboardCalls([
      {
        id: "one",
        symbol: "AAPL",
        content: "$AAPL",
        url: null,
        source: "x",
        timestamp: new Date("2026-07-30T12:00:00.000Z"),
        metadata: { canonicalAuthorKey: first, authorName: "Shared", authorAliases: ["shared"] },
      },
      {
        id: "two",
        symbol: "MSFT",
        content: "$MSFT",
        url: null,
        source: "x",
        timestamp: new Date("2026-07-29T12:00:00.000Z"),
        metadata: { canonicalAuthorKey: second, authorName: "Shared", authorAliases: ["shared"] },
      },
    ]);

    expect(grouped.size).toBe(2);
    expect(resolveXCallerBucket(grouped, "shared")).toBeUndefined();
  });

  it("does not merge an X author alias with a Discord legacy row", () => {
    const xKey = canonicalAuthorKey("x", "1")!;
    const grouped = groupXLeaderboardCalls([
      {
        id: "x-row",
        symbol: "AAPL",
        content: "$AAPL",
        url: null,
        source: "x",
        timestamp: new Date("2026-07-30T12:00:00.000Z"),
        metadata: {
          authorSource: "x",
          sourceAuthorId: "1",
          canonicalAuthorKey: xKey,
          authorName: "Shared",
          authorAliases: ["shared"],
        },
      },
      {
        id: "discord-row",
        symbol: "MSFT",
        content: "$MSFT",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-29T12:00:00.000Z"),
        metadata: { authorName: "Shared" },
      },
    ]);

    expect(grouped.size).toBe(2);
    expect(grouped.get(xKey)?.totalCallCount).toBe(1);
    expect(resolveXCallerBucket(grouped, "shared")).toBeUndefined();
  });

  it("does not resolve a capped legacy alias from a partial owner set", { timeout: 30_000 }, () => {
    const first = canonicalAuthorKey("x", "first")!;
    const second = canonicalAuthorKey("x", "second")!;
    const rows: Parameters<typeof groupXLeaderboardCalls>[0] = [
      {
        id: "legacy-shared",
        symbol: "AAPL",
        content: "$AAPL",
        url: null,
        source: "x",
        timestamp: new Date("2026-08-21T12:00:00.000Z"),
        metadata: { authorSource: "x", authorName: "Shared" },
      },
      {
        id: "first-owner",
        symbol: "MSFT",
        content: "$MSFT",
        url: null,
        source: "x",
        timestamp: new Date("2026-08-21T11:00:00.000Z"),
        metadata: {
          canonicalAuthorKey: first,
          authorName: "Owner One",
          authorAliases: ["shared", "owner one"],
        },
      },
      ...Array.from({ length: 4_998 }, (_, index) => ({
        id: `first-filler-${index}`,
        symbol: "NVDA",
        content: "$NVDA",
        url: null,
        source: "x",
        timestamp: new Date(Date.UTC(2026, 7, 21, 10, 0, 0) - index * 1_000),
        metadata: {
          canonicalAuthorKey: first,
          authorName: "Owner One",
          authorAliases: ["shared", "owner one"],
        },
      })),
      {
        id: "second-owner-beyond-cap",
        symbol: "TSLA",
        content: "$TSLA",
        url: null,
        source: "x",
        timestamp: new Date("2026-08-01T00:00:00.000Z"),
        metadata: {
          canonicalAuthorKey: second,
          authorName: "Owner Two",
          authorAliases: ["shared", "owner two"],
        },
      },
    ];
    const retained = [...rows]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 5_000);
    const groupWithDurableOwners = groupXLeaderboardCalls as unknown as (
      signalRows: Parameters<typeof groupXLeaderboardCalls>[0],
      options?: {
        durableOwnersComplete?: boolean;
        durableObservations?: readonly {
          source: string;
          canonicalKey: string;
          aliases: readonly string[];
        }[];
      },
    ) => ReturnType<typeof groupXLeaderboardCalls>;

    const grouped = groupWithDurableOwners(retained, {
      durableOwnersComplete: true,
      durableObservations: [
        { source: "x", canonicalKey: first, aliases: ["shared", "owner one"] },
        { source: "x", canonicalKey: second, aliases: ["shared", "owner two"] },
      ],
    });

    expect(grouped.get(first)?.totalCallCount).toBe(4_999);
    expect(grouped.get(first)?.totalCallCount).not.toBe(5_000);
  });

  it("bounds durable alias ownership to the signal population and degrades on overflow", async () => {
    const signalRows: Parameters<typeof groupXLeaderboardCalls>[0] = [{
      id: "legacy-shared",
      symbol: "AAPL",
      content: "$AAPL",
      url: null,
      source: "x",
      timestamp: new Date("2026-08-21T12:00:00.000Z"),
      metadata: { authorSource: "x", authorName: "Shared" },
    }];
    let requestedLimit = 0;
    let whereSeen = false;
    const query: any = {
      from: () => query,
      innerJoin: () => query,
      where: () => {
        whereSeen = true;
        return query;
      },
      limit: (limit: number) => {
        requestedLimit = limit;
        return Promise.resolve(Array.from({ length: limit }, (_, index) => ({
          source: "x",
          alias: "shared",
          canonicalKey: `source_author:x:${index}`,
        })));
      },
    };
    const result = await readBoundedDurableXCallerObservations(
      {
        select: () => query,
        query: { sourceAuthorIdentities: {}, sourceAuthorAliases: {} },
      } as never,
      signalRows,
    );

    expect(whereSeen).toBe(true);
    expect(requestedLimit).toBeGreaterThan(5_000);
    expect(result.available).toBe(true);
    expect(result.complete).toBe(false);
    expect(groupXLeaderboardCalls(signalRows, {
      durableOwnersComplete: result.complete,
      durableObservations: result.observations,
    }).size).toBe(0);
  }, { timeout: 30_000 });

  it("keeps complete volume counts while bounding directional measurements", () => {
    const rows = Array.from({ length: 70 }, (_, index) => ({
      id: `call-${index}`,
      symbol: index === 69 ? "XYZ:BRENT" : "AAPL",
      content: index < 10 ? "$AAPL update" : "$AAPL bullish buy",
      url: null,
      source: "discord",
      timestamp: new Date(Date.UTC(2026, 6, 30, 12, 0, 0) - index * 1000),
      metadata: {
        authorName: "Measured Caller",
        ...(index === 69
          ? { platform: "hyperliquid", instrument: "perp", direction: "bullish" }
          : {}),
      },
    }));

    const grouped = groupXLeaderboardCalls(rows);
    const bucket = resolveXCallerBucket(grouped, "measured caller");

    expect(bucket).toBeDefined();
    expect(bucket!.totalCallCount).toBe(70);
    expect(bucket!.directionalCallCount).toBe(60);
    expect(bucket!.recentCalls).toHaveLength(50);
    expect(bucket!.measurementCalls).toHaveLength(50);
    expect(bucket!.measurementCalls.every((call) => call.direction !== "unknown")).toBe(true);
    expect(bucket!.assetClasses).toEqual(new Set(["stocks", "perps"]));
    expect(bucket!.assetCallCounts).toEqual({ stocks: 69, perps: 1 });
    expect(bucket!.measurementCandidateCount).toBe(60);
    expect(bucket!.measurementCallsRetainedCount).toBe(50);
    expect(bucket!.measurementCandidateOmittedCount).toBe(10);
    expect(bucket!.measurementCallCap).toBe(50);
    expect(bucket!.measurementCapped).toBe(true);
    expect(bucket!.recentCallOmittedCount).toBe(20);
  });

  it("keeps PERP and unknown-direction calls in total profile volume", () => {
    const grouped = groupXLeaderboardCalls([
      {
        id: "perp-call",
        symbol: "BTC",
        content: "$BTC bullish buy",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-30T12:00:00.000Z"),
        metadata: {
          authorName: "Mixed Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "bullish",
        },
      },
      {
        id: "stock-call",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-29T12:00:00.000Z"),
        metadata: { authorName: "Mixed Caller" },
      },
      {
        id: "unknown-direction-call",
        symbol: "MSFT",
        content: "$MSFT update",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-28T12:00:00.000Z"),
        metadata: { authorName: "Mixed Caller" },
      },
    ]);
    const bucket = resolveXCallerBucket(grouped, "mixed caller")!;

    expect(bucket.totalCallCount).toBe(3);
    expect(bucket.directionalCallCount).toBe(2);
    expect(bucket.recentCalls.map((call) => call.id)).toEqual([
      "perp-call",
      "stock-call",
      "unknown-direction-call",
    ]);
    expect(bucket.measurementCalls.map((call) => call.id)).toEqual([
      "perp-call",
      "stock-call",
    ]);
  });

  it("keeps canonical Hyperliquid ticker metadata and deterministic recency ties", () => {
    const grouped = groupXLeaderboardCalls([
      {
        id: "older-id",
        symbol: "GOOGL",
        content: "$GOOGL bullish",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-30T12:00:00.000Z"),
        metadata: {
          authorName: "Canonical Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "xyz:GOOGL",
        },
      },
      {
        id: "newer-id",
        symbol: "PEPE",
        content: "$PEPE bullish",
        url: null,
        source: "discord",
        timestamp: new Date("2026-07-30T12:00:00.000Z"),
        metadata: {
          authorName: "Canonical Caller",
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "kPEPE",
        },
      },
    ]);
    const bucket = resolveXCallerBucket(grouped, "canonical caller")!;

    expect(bucket.recentCalls.map((call) => call.id)).toEqual(["older-id", "newer-id"]);
    expect(bucket.recentCalls.map((call) => call.symbol)).toEqual(["xyz:GOOGL", "kPEPE"]);
    expect(xCallerMarketRef({ hlTicker: "xyz:GOOGL" }, "GOOGL")).toEqual({
      provider: "hyperliquid",
      symbol: "xyz:GOOGL",
      key: "hyperliquid:xyz:GOOGL",
    });
  });

  it("groups persisted external Discord calls into mixed profiles and scores their exact markets", () => {
    const authorKey = canonicalAuthorKey("discord", "424242424242424242")!;
    const perpCallTime = new Date("2026-08-23T12:00:00.000Z");
    const stockCallTime = new Date("2026-08-22T12:00:00.000Z");
    const rows: Parameters<typeof groupXLeaderboardCalls>[0] = [
      {
        id: "external-perp",
        symbol: "xyz:GOOGL",
        content: "Market long GOOGL here at CMP. Close under 190 for stops.",
        url: "https://discord.com/channels/1/1087843967573438504/1390441633807601685",
        source: "discord",
        timestamp: perpCallTime,
        metadata: {
          authorId: "424242424242424242",
          authorName: "Neil Arora",
          authorHandle: "neilarora16",
          authorSource: "discord",
          sourceAuthorId: "424242424242424242",
          canonicalAuthorKey: authorKey,
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "xyz:GOOGL",
        },
      },
      {
        id: "external-stock",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: "https://discord.com/channels/1/1087843967573438504/1390441633807601684",
        source: "discord",
        timestamp: stockCallTime,
        metadata: {
          authorId: "424242424242424242",
          authorName: "Neil Arora",
          authorHandle: "neilarora16",
          authorSource: "discord",
          sourceAuthorId: "424242424242424242",
          canonicalAuthorKey: authorKey,
          direction: "long",
        },
      },
    ];

    const bucket = resolveXCallerBucket(groupXLeaderboardCalls(rows), authorKey)!;

    expect(bucket.totalCallCount).toBe(2);
    expect(bucket.directionalCallCount).toBe(2);
    expect(bucket.assetClasses).toEqual(new Set(["perps", "stocks"]));
    expect(bucket.assetCallCounts).toEqual({ stocks: 1, perps: 1 });
    expect(callerAssetCoverage(bucket.recentCalls)).toBe("both");
    expect(xCallerAssetClass(rows[0]!.metadata, rows[0]!.symbol)).toBe("perps");
    expect(xCallerMarketRef(rows[0]!.metadata, rows[0]!.symbol)).toEqual({
      provider: "hyperliquid",
      symbol: "xyz:GOOGL",
      key: "hyperliquid:xyz:GOOGL",
    });
    expect(latestCallSourceUrl(bucket.recentCalls)).toBe(rows[0]!.url);

    const stats = aggregateXCallMeasurements(
      bucket.measurementCalls,
      new Map([
        ["hyperliquid:xyz:GOOGL", [
          { time: perpCallTime.getTime() / 1000, close: 100 },
          { time: perpCallTime.getTime() / 1000 + 86_400, close: 110 },
        ]],
        ["alpaca:AAPL", [
          { time: stockCallTime.getTime() / 1000, close: 200 },
          { time: stockCallTime.getTime() / 1000 + 86_400, close: 220 },
        ]],
      ]),
      1,
    );

    expect(stats).toMatchObject({
      measuredCallCount: 2,
      hitRate: 1,
      avgForwardReturnPct: 10,
    });
  });

  it("deduplicates source events before the scan and caller measurement caps", () => {
    const duplicateRows = [
      {
        id: "duplicate-new",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "discord",
        sourceEventId: "discord:channel:message:AAPL",
        timestamp: new Date("2026-08-23T12:00:00.000Z"),
        metadata: { authorName: "Deduped Caller" },
      },
      {
        id: "duplicate-old",
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "discord",
        sourceEventId: "discord:channel:message:AAPL",
        timestamp: new Date("2026-08-23T11:59:00.000Z"),
        metadata: { authorName: "Deduped Caller" },
      },
      ...Array.from({ length: 49 }, (_, index) => ({
        id: `unique-${index}`,
        symbol: "AAPL",
        content: "$AAPL bullish buy",
        url: null,
        source: "discord",
        sourceEventId: `discord:channel:message:${index}`,
        timestamp: new Date(Date.UTC(2026, 7, 23, 11, 50, 0) - index * 1_000),
        metadata: { authorName: "Deduped Caller" },
      })),
    ];

    const population = canonicalXCallerScanPopulation(duplicateRows);
    expect(population.rows).toHaveLength(50);
    expect(population.rows.map((row) => row.id)).not.toContain("duplicate-old");

    const bucket = resolveXCallerBucket(
      groupXLeaderboardCalls(duplicateRows),
      "deduped caller",
    )!;
    expect(bucket.totalCallCount).toBe(50);
    expect(bucket.directionalCallCount).toBe(50);
    expect(bucket.measurementCandidateCount).toBe(50);
    expect(bucket.measurementCallsRetainedCount).toBe(50);
    expect(bucket.measurementCandidateOmittedCount).toBe(0);
    expect(bucket.measurementCapped).toBe(false);
  });
});

describe("X caller market-data measurement", () => {
  const callTime = new Date("2026-07-01T00:00:00.000Z");
  const bars = [
    { time: callTime.getTime() / 1000, close: 100 },
    { time: callTime.getTime() / 1000 + 7 * 24 * 60 * 60, close: 110 },
  ];

  it("measures a PERP only from perp-market bars and never substitutes equity bars", () => {
    const perp = computeXCallMeasurement(
      { assetClass: "perps", direction: "bullish", callTime },
      bars,
      7,
    );
    const stock = computeXCallMeasurement(
      { assetClass: "stocks", direction: "bullish", callTime },
      bars,
      7,
    );

    expect(perp).toEqual({ forwardReturnPct: 10, measurementStatus: "measured" });
    expect(stock).toEqual({
      forwardReturnPct: 10,
      measurementStatus: "measured",
    });
    expect(
      aggregateCallerStats([perp.forwardReturnPct, stock.forwardReturnPct]),
    ).toMatchObject({ measuredCallCount: 2, avgForwardReturnPct: 10 });
  });

  it("applies short direction exactly once in the canonical aggregation", () => {
    const result = aggregateXCallMeasurements(
      [{
        symbol: "BTC",
        assetClass: "perps",
        direction: "bearish",
        callTime,
      }],
      new Map([["BTC", bars]]),
      7,
    );

    expect(result).toMatchObject({
      measuredCallCount: 1,
      hitRate: 0,
      avgForwardReturnPct: -10,
    });
  });

  it("uses the same completed 1D bars for 1D, 3D, and 7D horizons", () => {
    for (const horizonDays of [1, 3, 7]) {
      const result = computeXCallMeasurement(
        { assetClass: "perps", direction: "bullish", callTime },
        [
          { time: callTime.getTime() / 1000, close: 100 },
          {
            time: callTime.getTime() / 1000 + horizonDays * 24 * 60 * 60,
            close: 125,
          },
        ],
        horizonDays,
      );

      expect(result).toEqual({
        forwardReturnPct: 25,
        measurementStatus: "measured",
      });
    }
  });

  it("degrades and uses a short retry TTL when only one symbol is missing bars", () => {
    const calls = [{ symbol: "AAPL" }, { symbol: "MSFT" }];
    const partialBars = new Map([
      ["AAPL", bars],
      ["MSFT", []],
    ]);

    const needsMarketData = xCallsNeedMarketData(calls, partialBars);
    expect(needsMarketData).toBe(true);
    expect(xCallersCacheTtlSeconds(needsMarketData)).toBe(
      XCALLERS_DEGRADED_TTL_SECONDS,
    );
    expect(XCALLERS_DEGRADED_TTL_SECONDS).toBe(5 * 60);
  });

  it("does not satisfy a qualified PERP with an unqualified equity-bar key", () => {
    expect(
      xCallsNeedMarketData(
        [{
          symbol: "BTC",
          marketRef: {
            provider: "hyperliquid",
            symbol: "BTC",
            key: "hyperliquid:BTC",
          },
        }],
        new Map([["BTC", bars]]),
      ),
    ).toBe(true);
  });

  it("keeps the healthy TTL only when every requested symbol has bars", () => {
    const needsMarketData = xCallsNeedMarketData(
      [{ symbol: "AAPL" }, { symbol: "MSFT" }],
      new Map([
        ["AAPL", bars],
        ["MSFT", bars],
      ]),
    );

    expect(needsMarketData).toBe(false);
    expect(xCallersCacheTtlSeconds(needsMarketData)).toBe(
      XCALLERS_HEALTHY_TTL_SECONDS,
    );
  });

  it("uses a short cache TTL for degraded users results", () => {
    expect(usersCacheTtlSeconds(true)).toBe(USER_LEADERBOARD_DEGRADED_TTL_SECONDS);
    expect(usersCacheTtlSeconds(false)).toBe(USER_LEADERBOARD_HEALTHY_TTL_SECONDS);
    expect(USER_LEADERBOARD_DEGRADED_TTL_SECONDS).toBeLessThan(
      USER_LEADERBOARD_HEALTHY_TTL_SECONDS,
    );
  });
});

describe("users leaderboard capacity truth", () => {
  it("distinguishes timeout from an unavailable database", () => {
    expect(resolveUsersLeaderboardCapacity({ dbCode: "57014" })).toMatchObject({
      reason: "query_timeout",
      resource: "database_query",
    });
    expect(resolveUsersLeaderboardCapacity({ dbCode: "08006" })).toMatchObject({
      reason: "query_unavailable",
      resource: "database_query",
    });
  });

  it("reports candidate and retained-state caps as degraded capacity", () => {
    expect(resolveUsersLeaderboardCapacity({ candidateRows: 30_001 })).toMatchObject({
      reason: "candidate_cap",
      resource: "candidate_rows",
    });
    expect(resolveUsersLeaderboardCapacity({ eventRows: 20_001 })).toMatchObject({
      reason: "state_cap",
      resource: "events",
    });
    expect(resolveUsersLeaderboardCapacity({ candidateRows: 30_000, eventRows: 20_000 })).toBeNull();
  });

  // The wallet snapshot cap fails as a group, and the row loop omits every
  // HL-connected user it has no value for. Unclassified, that published a
  // confident board with all of its perp traders quietly missing and
  // `degraded` false. The 26th connected wallet is what trips it.
  it("classifies an over-cap Hyperliquid wallet population as a market data cap", () => {
    expect(
      resolveUsersLeaderboardCapacity({
        hlWalletRows: USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP + 1,
      }),
    ).toMatchObject({
      reason: "market_data_cap",
      limit: USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP,
      resource: "hyperliquid_wallets",
    });
  });

  it("leaves a wallet population at or under the cap unclassified", () => {
    expect(
      resolveUsersLeaderboardCapacity({
        hlWalletRows: USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP,
      }),
    ).toBeNull();
    expect(resolveUsersLeaderboardCapacity({ hlWalletRows: 0 })).toBeNull();
  });
});

describe("users leaderboard Hyperliquid unrealized P&L", () => {
  const address = "0x1111111111111111111111111111111111111111" as const;

  it("bounds concurrent wallet reads", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await measureHyperliquidUnrealizedPnl(
      Array.from({ length: 6 }, (_, index) => [`u${index}`, address] as const),
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(2);
        active--;
        return { positions: [{ unrealizedPnl: "1.25" }] };
      },
      { cap: 6, concurrency: 2, timeoutMs: 500 },
    );

    expect(result.complete).toBe(true);
    expect(maxActive).toBe(2);
    if (result.complete) expect(result.values.get("u0")).toBe(1.25);
  });

  it("fails closed without calling Hyperliquid when the wallet cap is exceeded", async () => {
    let calls = 0;
    const entries = Array.from(
      { length: USER_LEADERBOARD_HL_WALLET_SNAPSHOT_CAP + 1 },
      (_, index) => [`u${index}`, address] as const,
    );
    const result = await measureHyperliquidUnrealizedPnl(entries, async () => {
      calls++;
      return { positions: [] };
    });

    expect(result).toMatchObject({ complete: false, reason: "cap" });
    if (!result.complete) {
      expect(result.values.size).toBe(0);
      expect(result.failedUserIds).toHaveLength(entries.length);
    }
    expect(calls).toBe(0);
  });

  // A break-even position sums to exactly 0, the same figure a wallet holding
  // nothing reports. Anything deciding whether a user is ACTIVE has to read the
  // position count, or a real open trader sitting at break-even is dropped.
  it("reports an open position whose unrealized P&L is exactly zero", async () => {
    const result = await measureHyperliquidUnrealizedPnl(
      [["breakeven", address]],
      async () => ({ positions: [{ unrealizedPnl: "0" }] }),
      { timeoutMs: 100 },
    );

    expect(result.complete).toBe(true);
    expect(result.values.get("breakeven")).toBe(0);
    expect(result.openPositionUserIds.has("breakeven")).toBe(true);
  });

  it("separates a wallet holding nothing from one holding a break-even position", async () => {
    const result = await measureHyperliquidUnrealizedPnl(
      [["empty", address]],
      async () => ({ positions: [] }),
      { timeoutMs: 100 },
    );

    // Same number, different meaning.
    expect(result.values.get("empty")).toBe(0);
    expect(result.openPositionUserIds.has("empty")).toBe(false);
  });

  it("reports open positions that net to zero across several legs", async () => {
    const result = await measureHyperliquidUnrealizedPnl(
      [["netzero", address]],
      async () => ({ positions: [{ unrealizedPnl: "25.5" }, { unrealizedPnl: "-25.5" }] }),
      { timeoutMs: 100 },
    );

    expect(result.values.get("netzero")).toBe(0);
    expect(result.openPositionUserIds.has("netzero")).toBe(true);
  });

  it("does not convert a rejected or malformed snapshot into zero P&L", async () => {
    const rejected = await measureHyperliquidUnrealizedPnl(
      [["u1", address]],
      async () => { throw new Error("rate limited"); },
      { timeoutMs: 100 },
    );
    const malformed = await measureHyperliquidUnrealizedPnl(
      [["u1", address]],
      async () => ({ positions: [{ unrealizedPnl: "NaN" }] }),
      { timeoutMs: 100 },
    );

    expect(rejected).toMatchObject({ complete: false, reason: "unavailable" });
    expect(malformed).toMatchObject({ complete: false, reason: "unavailable" });
    if (!rejected.complete) expect(rejected.values.size).toBe(0);
    if (!malformed.complete) expect(malformed.values.size).toBe(0);
  });

  it("returns at the deadline even when an upstream promise never settles", async () => {
    const startedAt = Date.now();
    const result = await measureHyperliquidUnrealizedPnl(
      [["u1", address]],
      () => new Promise(() => {}),
      { timeoutMs: 10 },
    );

    expect(result).toMatchObject({ complete: false, reason: "unavailable" });
    if (!result.complete) expect(result.failedUserIds).toEqual(["u1"]);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("retains successful wallets when another wallet fails", async () => {
    let callsByWallet = 0;
    const result = await measureHyperliquidUnrealizedPnl(
      [["good", address], ["bad", address]],
      async (_address, _signal) => {
        // The worker order is deterministic at concurrency 1.
        if (!callsByWallet++) return { positions: [{ unrealizedPnl: "4.5" }] };
        throw new Error("provider unavailable");
      },
      { concurrency: 1, timeoutMs: 100 },
    );

    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.values.get("good")).toBe(4.5);
      expect(result.failedUserIds).toEqual(["bad"]);
    }
  });
});

describe("callerAssetCoverage", () => {
  it("distinguishes stock-only, perp-only, and mixed callers", () => {
    expect(callerAssetCoverage([{ assetClass: "stocks" }])).toBe("stocks");
    expect(callerAssetCoverage([{ assetClass: "perps" }])).toBe("perps");
    expect(
      callerAssetCoverage([
        { assetClass: "stocks" },
        { assetClass: "perps" },
      ]),
    ).toBe("both");
  });
});

describe("xCallerAssetClass", () => {
  it("recognizes perps from explicit metadata or any canonical namespaced coin", () => {
    expect(xCallerAssetClass({}, "AAPL")).toBe("stocks");
    expect(
      xCallerAssetClass(
        { platform: "hyperliquid", instrument: "perp" },
        "ZEC",
      ),
    ).toBe("perps");
    expect(xCallerAssetClass({}, "abc:brentoil")).toBe("perps");
    expect(xCallerAssetClass({}, "BRN", "$BRN 5x long perp")).toBe("stocks");
    expect(xCallerMarketRef({ hlTicker: "xyz:brentoil" }, "BRN")).toEqual({
      provider: "hyperliquid",
      symbol: "xyz:brentoil",
      key: "hyperliquid:xyz:brentoil",
    });
    expect(xCallerMarketRef({ hlTicker: "AbC:Foo" }, "FOO")).toEqual({
      provider: "hyperliquid",
      symbol: "AbC:Foo",
      key: "hyperliquid:AbC:Foo",
    });
  });

  it("fails closed for malformed namespaced symbols instead of constructing Alpaca refs", () => {
    for (const symbol of ["abc:FOO:BAR", "abc:averyveryverylong"]) {
      expect(xCallerAssetClass({}, symbol)).toBe("perps");
      expect(xCallerMarketRef({}, symbol)).toBeNull();
    }

    expect(xCallerMarketRef({}, "AAPL")).toEqual({
      provider: "alpaca",
      symbol: "AAPL",
      key: "alpaca:AAPL",
    });
    expect(xCallerMarketRef({}, "BRK.B")).toEqual({
      provider: "alpaca",
      symbol: "BRK.B",
      key: "alpaca:BRK.B",
    });
  });

  it("rejects missing, malformed, and non-string Hyperliquid tickers without stock fallback", () => {
    for (const metadata of [
      { platform: "hyperliquid", instrument: "perp" },
      { platform: "hyperliquid", instrument: "perp", hlTicker: "not a coin" },
      { platform: "hyperliquid", instrument: "perp", hlTicker: 123 },
    ]) {
      expect(xCallerMarketRef(metadata, "AAPL")).toBeNull();
    }
  });
});

describe("X-caller market health caps", () => {
  it("counts unresolved candidates separately from provider outages and caps", () => {
    const bucket = groupXLeaderboardCalls([
      {
        id: "invalid-market",
        symbol: "abc:FOO:BAR",
        content: "$BAR long",
        url: null,
        source: "discord",
        timestamp: new Date("2026-08-20T12:00:00.000Z"),
        metadata: { authorName: "Invalid Market Caller" },
      },
    ]);
    expect(countUnresolvedMarketCandidates(bucket)).toBe(1);

    const health = addUnresolvedMarketHealth(
      {
        totalMarketCount: 0,
        requestedMarketCount: 0,
        availableMarketCount: 0,
        unavailableMarketCount: 0,
        deadlineMarketCount: 0,
        skippedMarketCount: 0,
        unresolvedCandidateCount: 0,
        omittedMarketCount: 0,
        capped: false,
        marketCap: null,
        providerComplete: true,
        complete: true,
        byProvider: {
          alpaca: { requested: 0, available: 0, unavailable: 0, omitted: 0 },
          hyperliquid: { requested: 0, available: 0, unavailable: 0, omitted: 0 },
        },
      },
      1,
    );

    expect(health).toMatchObject({
      unavailableMarketCount: 0,
      deadlineMarketCount: 0,
      unresolvedCandidateCount: 1,
      omittedMarketCount: 0,
      complete: false,
    });
  });

  it("counts intentionally omitted markets separately from provider outages", () => {
    const health = addOmittedMarketHealth(
      {
        totalMarketCount: 1,
        requestedMarketCount: 1,
        availableMarketCount: 1,
        unavailableMarketCount: 0,
        deadlineMarketCount: 0,
        skippedMarketCount: 0,
        unresolvedCandidateCount: 0,
        omittedMarketCount: 0,
        capped: false,
        marketCap: null,
        providerComplete: true,
        complete: true,
        byProvider: {
          alpaca: { requested: 1, available: 1, unavailable: 0, omitted: 0 },
          hyperliquid: { requested: 0, available: 0, unavailable: 0, omitted: 0 },
        },
      },
      [{ provider: "hyperliquid", symbol: "abc:FOO", key: "hyperliquid:abc:FOO" }],
      1,
    );

    expect(health).toMatchObject({
      totalMarketCount: 2,
      requestedMarketCount: 1,
      unavailableMarketCount: 0,
      omittedMarketCount: 1,
      capped: true,
      providerComplete: true,
      complete: false,
      byProvider: {
        hyperliquid: { requested: 0, available: 0, unavailable: 0, omitted: 1 },
      },
    });
  });
});

// Plan S5. The leaderboard row links outward to the call as it was posted. The
// link is only worth rendering when it identifies ONE post: our reconstruction
// of a caller's record is the claim, and the source is the evidence for it.
describe("latestCallSourceUrl", () => {
  const at = (iso: string) => new Date(iso);

  it("picks the newest call by time, not by array position", () => {
    expect(
      latestCallSourceUrl([
        { url: "https://x.com/a/status/1", callTime: at("2026-01-01T00:00:00Z") },
        { url: "https://x.com/a/status/3", callTime: at("2026-03-01T00:00:00Z") },
        { url: "https://x.com/a/status/2", callTime: at("2026-02-01T00:00:00Z") },
      ]),
    ).toBe("https://x.com/a/status/3");
  });

  it("rejects every paste.trade URL", () => {
    expect(
      latestCallSourceUrl([
        { url: "https://paste.trade", callTime: at("2026-03-01T00:00:00Z") },
        { url: "https://paste.trade/", callTime: at("2026-03-02T00:00:00Z") },
        { url: "https://paste.trade./p/42", callTime: at("2026-03-03T00:00:00Z") },
      ]),
    ).toBeNull();
    expect(
      latestCallSourceUrl([
        { url: "https://paste.trade/p/42", callTime: at("2026-03-01T00:00:00Z") },
      ]),
    ).toBeNull();
    expect(
      latestCallSourceUrl([
        { url: "https://paste.trade?post=42", callTime: at("2026-03-01T00:00:00Z") },
      ]),
    ).toBeNull();
  });

  it("falls back to an older post-specific call when the newest has none", () => {
    expect(
      latestCallSourceUrl([
        { url: null, callTime: at("2026-03-05T00:00:00Z") },
        { url: "https://x.com/a/status/9", callTime: at("2026-03-01T00:00:00Z") },
      ]),
    ).toBe("https://x.com/a/status/9");
  });

  it("never returns a non-http scheme, which would become a rendered href", () => {
    expect(
      latestCallSourceUrl([
        { url: "javascript:alert(1)", callTime: at("2026-03-01T00:00:00Z") },
        { url: "data:text/html,<b>x</b>", callTime: at("2026-03-02T00:00:00Z") },
        { url: "not a url at all", callTime: at("2026-03-03T00:00:00Z") },
      ]),
    ).toBeNull();
  });

  it("rejects credential-bearing URLs before they reach the client", () => {
    expect(
      latestCallSourceUrl([
        {
          url: "https://user:password@example.com/a/status/1",
          callTime: at("2026-03-01T00:00:00Z"),
        },
      ]),
    ).toBeNull();
  });

  it("returns null for an empty bucket and skips unusable timestamps", () => {
    expect(latestCallSourceUrl([])).toBeNull();
    expect(
      latestCallSourceUrl([
        { url: "https://x.com/a/status/1", callTime: new Date("nonsense") },
      ]),
    ).toBeNull();
  });
});

describe("collectBoundedMarketRefs", () => {
  it("uses locale-independent ordering for deterministic market caps", () => {
    const byAuthor = new Map([
      [
        "caller",
        {
          measurementCalls: [
            {
              symbol: "Z",
              marketRef: { provider: "hyperliquid", symbol: "Z", key: "hyperliquid:Z" },
            },
            {
              symbol: "a",
              marketRef: { provider: "hyperliquid", symbol: "a", key: "hyperliquid:a" },
            },
          ],
        },
      ],
    ]) as never;

    expect(collectBoundedMarketRefs(byAuthor, 1).map((ref) => ref.key)).toEqual([
      "hyperliquid:Z",
    ]);
  });
});

describe("mergeSignalRowsByRecency", () => {
  it("keeps legacy calls when modern rows exist and deduplicates by id", () => {
    const modern = {
      id: "modern",
      timestamp: new Date("2026-07-29T12:00:00.000Z"),
    };
    const legacy = {
      id: "legacy",
      timestamp: new Date("2026-07-28T12:00:00.000Z"),
    };

    expect(mergeSignalRowsByRecency([modern], [legacy, modern])).toEqual([
      modern,
      legacy,
    ]);
  });
});

describe("normalizedSignalAuthorCondition", () => {
  it("matches the app's author normalization without interpolating the key", () => {
    const query = new PgDialect().sqlToQuery(
      normalizedSignalAuthorCondition("martin shkreli"),
    );

    expect(query.sql).toContain("metadata");
    expect(query.sql).toContain("authorHandle");
    expect(query.sql).toContain("regexp_replace");
    expect(query.params).toEqual(["martin shkreli"]);
  });

  it("queries legacy string metadata by the same normalized author key", () => {
    const query = new PgDialect().sqlToQuery(
      normalizedLegacySignalAuthorCondition("michael | hypermarkets"),
    );

    expect(query.sql).toContain("jsonb_typeof");
    expect(query.sql).toContain("substring");
    expect(query.sql).toContain("authorHandle");
    expect(query.params).toEqual(["michael | hypermarkets"]);
  });
});

describe("canonicalSignalAuthorCondition", () => {
  it("matches a projected source author id when metadata has no canonical key", () => {
    const key = canonicalAuthorKey("discord", "424242424242424242")!;
    const query = new PgDialect().sqlToQuery(canonicalSignalAuthorCondition(key));

    expect(query.sql).toContain("source_author_id");
    expect(query.params).toEqual(["discord", key, "424242424242424242"]);
  });
});

/**
 * Build a TradeEvent with sensible defaults. Defaults to a long equity (mult 1).
 * Pass `direction`, `multiplier`, and `at` to exercise shorts/options/windowing.
 */
function ev(partial: Partial<TradeEvent> & { side: "buy" | "sell" }): TradeEvent {
  return {
    direction: "long",
    qty: 10,
    price: 100,
    multiplier: 1,
    at: null,
    ...partial,
  };
}

describe("reconstructRealizedPnl — long equity round-trips", () => {
  it("computes a simple winning long round-trip", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 10, price: 100 }),
      ev({ side: "sell", qty: 10, price: 110 }),
    ];
    const out = reconstructRealizedPnl(events);
    // (110 - 100) * 10 * 1 = 100
    expect(out.realizedPnl).toBe(100);
    expect(out.closedTrades).toBe(1);
    expect(out.winRate).toBe(1);
    expect(out.closedLots).toHaveLength(1);
    expect(out.closedLots[0]!.win).toBe(true);
  });

  it("computes a simple losing long round-trip", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 5, price: 200 }),
      ev({ side: "sell", qty: 5, price: 180 }),
    ];
    const out = reconstructRealizedPnl(events);
    expect(out.realizedPnl).toBe(-100);
    expect(out.closedTrades).toBe(1);
    expect(out.winRate).toBe(0);
  });

  it("FIFO-pairs a sell across multiple prior buy lots", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 10, price: 100 }), // lot 1
      ev({ side: "buy", qty: 10, price: 120 }), // lot 2
      ev({ side: "sell", qty: 15, price: 130 }), // closes all of lot1 + half of lot2
    ];
    const out = reconstructRealizedPnl(events);
    // lot1: (130-100)*10 = 300 ; lot2 slice: (130-120)*5 = 50 -> 350
    expect(out.realizedPnl).toBe(350);
    expect(out.closedTrades).toBe(2);
    expect(out.winRate).toBe(1);
    // 5 shares of lot2 remain open and are correctly excluded
  });

  it("produces a mixed win rate across lots", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 10, price: 100 }), // lot 1
      ev({ side: "buy", qty: 10, price: 150 }), // lot 2 (bought higher)
      ev({ side: "sell", qty: 20, price: 120 }), // lot1 wins (+200), lot2 loses (-300)
    ];
    const out = reconstructRealizedPnl(events);
    expect(out.realizedPnl).toBe(-100);
    expect(out.closedTrades).toBe(2);
    expect(out.winRate).toBe(0.5);
  });

  it("excludes unfilled (null price) events", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 10, price: null }), // unfilled buy -> ignored
      ev({ side: "buy", qty: 10, price: 100 }), // the real lot
      ev({ side: "sell", qty: 10, price: null }), // unfilled sell -> ignored
      ev({ side: "sell", qty: 10, price: 110 }), // closes the real lot
    ];
    const out = reconstructRealizedPnl(events);
    expect(out.realizedPnl).toBe(100);
    expect(out.closedTrades).toBe(1);
  });

  it("skips a long sell with no prior buy (no phantom long lot)", () => {
    const events: TradeEvent[] = [
      ev({ side: "sell", qty: 10, price: 110 }), // long close, no open long -> skipped
      ev({ side: "buy", qty: 5, price: 100 }),
      ev({ side: "sell", qty: 5, price: 120 }), // closes the buy
    ];
    const out = reconstructRealizedPnl(events);
    expect(out.realizedPnl).toBe(100);
    expect(out.closedTrades).toBe(1);
  });

  it("leftover open long lots are not counted", () => {
    const out = reconstructRealizedPnl([ev({ side: "buy", qty: 10, price: 100 })]);
    expect(out.realizedPnl).toBe(0);
    expect(out.closedTrades).toBe(0);
    expect(out.winRate).toBe(0);
    expect(out.closedLots).toHaveLength(0);
  });

  it("no events => zeroed result", () => {
    expect(reconstructRealizedPnl([])).toEqual({
      realizedPnl: 0,
      winRate: 0,
      closedTrades: 0,
      closedLots: [],
    });
  });

  it("ignores non-positive quantities", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 0, price: 100 }),
      ev({ side: "buy", qty: -5, price: 100 }),
      ev({ side: "buy", qty: 10, price: 100 }),
      ev({ side: "sell", qty: 10, price: 105 }),
    ];
    const out = reconstructRealizedPnl(events);
    expect(out.realizedPnl).toBe(50);
    expect(out.closedTrades).toBe(1);
  });
});

describe("reconstructRealizedPnl — short round-trips (direction-aware)", () => {
  it("a short round-trip profits when the price FALLS (open=sell, close=buy)", () => {
    const events: TradeEvent[] = [
      ev({ side: "sell", direction: "short", qty: 10, price: 100 }), // SellShort opens
      ev({ side: "buy", direction: "short", qty: 10, price: 80 }), // BuyToCover closes
    ];
    const out = reconstructRealizedPnl(events);
    // (open - close) * qty = (100 - 80) * 10 = 200
    expect(out.realizedPnl).toBe(200);
    expect(out.closedTrades).toBe(1);
    expect(out.winRate).toBe(1);
  });

  it("a short loses when the price RISES", () => {
    const events: TradeEvent[] = [
      ev({ side: "sell", direction: "short", qty: 10, price: 100 }),
      ev({ side: "buy", direction: "short", qty: 10, price: 130 }),
    ];
    const out = reconstructRealizedPnl(events);
    // (100 - 130) * 10 = -300
    expect(out.realizedPnl).toBe(-300);
    expect(out.closedTrades).toBe(1);
    expect(out.winRate).toBe(0);
  });

  it("a short COVER never opens a phantom long lot", () => {
    // A lone BuyToCover (short close) with no prior short open must be dropped,
    // NOT treated as a long open that a later long sell could close.
    const events: TradeEvent[] = [
      ev({ side: "buy", direction: "short", qty: 10, price: 80 }), // cover, no open short -> skipped
      ev({ side: "sell", direction: "long", qty: 10, price: 120 }), // long close, no open long -> skipped
    ];
    const out = reconstructRealizedPnl(events);
    expect(out.realizedPnl).toBe(0);
    expect(out.closedTrades).toBe(0);
  });

  it("long and short positions in the same bucket use separate FIFO queues", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", direction: "long", qty: 10, price: 100 }), // long open
      ev({ side: "sell", direction: "short", qty: 10, price: 100 }), // short open (NOT a long close)
      ev({ side: "buy", direction: "short", qty: 10, price: 90 }), // short close: +100
      ev({ side: "sell", direction: "long", qty: 10, price: 130 }), // long close: +300
    ];
    const out = reconstructRealizedPnl(events);
    // short: (100-90)*10 = 100 ; long: (130-100)*10 = 300 -> 400
    expect(out.realizedPnl).toBe(400);
    expect(out.closedTrades).toBe(2);
    expect(out.winRate).toBe(1);
  });
});

describe("reconstructRealizedPnl — options 100x contract multiplier", () => {
  it("an option round-trip applies the 100x multiplier", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 2, price: 3.5, multiplier: OPTION_CONTRACT_MULTIPLIER }),
      ev({ side: "sell", qty: 2, price: 5.0, multiplier: OPTION_CONTRACT_MULTIPLIER }),
    ];
    const out = reconstructRealizedPnl(events);
    // (5.0 - 3.5) * 2 contracts * 100 = 300
    expect(out.realizedPnl).toBeCloseTo(300, 10);
    expect(out.closedTrades).toBe(1);
  });

  it("a short option round-trip applies 100x on the (open-close) leg", () => {
    const events: TradeEvent[] = [
      ev({ side: "sell", direction: "short", qty: 1, price: 4, multiplier: OPTION_CONTRACT_MULTIPLIER }),
      ev({ side: "buy", direction: "short", qty: 1, price: 1, multiplier: OPTION_CONTRACT_MULTIPLIER }),
    ];
    const out = reconstructRealizedPnl(events);
    // (4 - 1) * 1 * 100 = 300
    expect(out.realizedPnl).toBeCloseTo(300, 10);
    expect(out.closedTrades).toBe(1);
  });
});

describe("reconstructRealizedPnl — window attribution by close time", () => {
  it("stamps each closed lot with the CLOSE event timestamp", () => {
    const events: TradeEvent[] = [
      ev({ side: "buy", qty: 10, price: 100, at: "2026-05-01T00:00:00.000Z" }),
      ev({ side: "sell", qty: 10, price: 110, at: "2026-06-01T00:00:00.000Z" }),
    ];
    const out = reconstructRealizedPnl(events);
    // The lot is attributed to the SELL (close) time, not the buy (open) time.
    expect(out.closedLots[0]!.closeAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("aggregateUserStats", () => {
  // A RealizedPnlResult built from explicit closed lots (matches the new shape).
  function res(pnls: number[]): RealizedPnlResult {
    const closedLots = pnls.map((pnl) => ({ pnl, win: pnl > 0, closeAt: null }));
    const realizedPnl = pnls.reduce((a, b) => a + b, 0);
    const wins = closedLots.filter((l) => l.win).length;
    return {
      realizedPnl,
      winRate: closedLots.length ? wins / closedLots.length : 0,
      closedTrades: closedLots.length,
      closedLots,
    };
  }

  it("sums P&L and aggregates win rate over all closed lots", () => {
    const rows: UserSymbolReconstruction[] = [
      { result: res([300, 50]), lastTradeAt: "2026-06-01T00:00:00.000Z" }, // 2 wins, +350
      { result: res([100, -200]), lastTradeAt: "2026-06-05T00:00:00.000Z" }, // 1 win 1 loss, -100
    ];
    const out = aggregateUserStats(rows);
    expect(out.realizedPnl).toBe(250);
    expect(out.tradeCount).toBe(4);
    expect(out.winRate).toBe(0.75); // 3 wins over 4 lots
    expect(out.lastTradeAt).toBe("2026-06-05T00:00:00.000Z");
  });

  it("weights win rate by closed-lot count, not by symbol", () => {
    const rows: UserSymbolReconstruction[] = [
      { result: res([10, 10, 10, 10, 10, 10, 10, 10, 10]), lastTradeAt: null }, // 9 wins
      { result: res([-10]), lastTradeAt: null }, // 1 loss
    ];
    const out = aggregateUserStats(rows);
    // 9 wins over 10 lots = 0.9 (NOT the naive mean of 1 and 0 = 0.5)
    expect(out.winRate).toBe(0.9);
    expect(out.tradeCount).toBe(10);
  });

  it("returns zeroed stats when there are no closed trades", () => {
    const out = aggregateUserStats([{ result: res([]), lastTradeAt: null }]);
    expect(out).toEqual({
      realizedPnl: 0,
      alpacaPnl: 0,
      hyperliquidPnl: 0,
      winRate: 0,
      tradeCount: 0,
      lastTradeAt: null,
    });
  });

  it("falls back to winRate-derived wins when closedLots is absent (synthetic input)", () => {
    const rows: UserSymbolReconstruction[] = [
      // No closedLots array — legacy/synthetic shape; wins derived from winRate.
      { result: { realizedPnl: 90, winRate: 1, closedTrades: 9 } as RealizedPnlResult, lastTradeAt: null },
      { result: { realizedPnl: -10, winRate: 0, closedTrades: 1 } as RealizedPnlResult, lastTradeAt: null },
    ];
    const out = aggregateUserStats(rows);
    expect(out.winRate).toBe(0.9);
    expect(out.tradeCount).toBe(10);
  });
});

describe("forwardReturnPct", () => {
  it("computes a positive forward return", () => {
    expect(forwardReturnPct(100, 110)).toBe(10);
  });

  it("computes a negative forward return", () => {
    expect(forwardReturnPct(200, 180)).toBe(-10);
  });

  it("returns null on null/undefined inputs", () => {
    expect(forwardReturnPct(null, 110)).toBeNull();
    expect(forwardReturnPct(100, null)).toBeNull();
    expect(forwardReturnPct(undefined, 110)).toBeNull();
    expect(forwardReturnPct(100, undefined)).toBeNull();
  });

  it("returns null on non-finite or non-positive entry and exit", () => {
    expect(forwardReturnPct(0, 110)).toBeNull();
    expect(forwardReturnPct(-5, 110)).toBeNull();
    expect(forwardReturnPct(NaN, 110)).toBeNull();
    expect(forwardReturnPct(100, Infinity)).toBeNull();
    expect(forwardReturnPct(100, 0)).toBeNull();
    expect(forwardReturnPct(100, -1)).toBeNull();
    expect(forwardReturnPct(Number.MIN_VALUE, 1)).toBeNull();
  });

  it("returns null when a finite price pair would produce an unbounded return", () => {
    expect(forwardReturnPct(1, Number.MAX_VALUE)).toBeNull();
  });
});

describe("aggregateCallerStats", () => {
  it("returns null metrics when ALL returns are null", () => {
    const out = aggregateCallerStats([null, null, null]);
    expect(out.hitRate).toBeNull();
    expect(out.avgForwardReturnPct).toBeNull();
    expect(out.callCount).toBe(3);
    expect(out.measuredCallCount).toBe(0);
  });

  it("computes hit rate + avg from mixed returns, counting nulls only in callCount", () => {
    const out = aggregateCallerStats([10, -5, null, 20]);
    expect(out.callCount).toBe(4);
    expect(out.measuredCallCount).toBe(3);
    expect(out.hitRate).toBeCloseTo(2 / 3, 10);
    expect(out.avgForwardReturnPct).toBeCloseTo(25 / 3, 10);
  });

  it("handles an all-measured set", () => {
    const out = aggregateCallerStats([5, -5]);
    expect(out.callCount).toBe(2);
    expect(out.measuredCallCount).toBe(2);
    expect(out.hitRate).toBe(0.5);
    expect(out.avgForwardReturnPct).toBe(0);
  });

  it("handles an empty call list", () => {
    const out = aggregateCallerStats([]);
    expect(out.hitRate).toBeNull();
    expect(out.avgForwardReturnPct).toBeNull();
    expect(out.callCount).toBe(0);
    expect(out.measuredCallCount).toBe(0);
  });

  it("returns degraded null metrics when a finite sum overflows", () => {
    const out = aggregateCallerStats([Number.MAX_VALUE, Number.MAX_VALUE]);
    expect(out.hitRate).toBeNull();
    expect(out.avgForwardReturnPct).toBeNull();
    expect(out.measuredCallCount).toBe(2);
  });
});

describe("X leaderboard measurement population", () => {
  it("aggregates only the supplied measurement calls, not recent detail calls", () => {
    const bars = new Map([
      [
        "AAPL",
        [
          { time: Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000), close: 100 },
          { time: Math.floor(new Date("2026-08-02T00:00:00Z").getTime() / 1000), close: 110 },
        ],
      ],
    ]);
    const stats = aggregateXCallMeasurements(
      [{
        symbol: "AAPL",
        assetClass: "stocks",
        direction: "bullish",
        callTime: new Date("2026-08-01T00:00:00Z"),
      }],
      bars,
      1,
    );

    expect(stats).toMatchObject({
      callCount: 1,
      measuredCallCount: 1,
      hitRate: 1,
      avgForwardReturnPct: 10,
    });
  });
});

describe("X leaderboard ordering", () => {
  const row = (key: string, over: Record<string, unknown> = {}) => ({
    followTarget: { type: "x_author", key, label: key },
    displayName: key,
    avatar: null,
    assetCoverage: "stocks",
    hitRate: 0.5,
    avgForwardReturnPct: 1,
    callCount: 2,
    directionalCallCount: 2,
    measuredCallCount: 2,
    needsMarketData: false,
    latestCallUrl: null,
    ...over,
  });

  it("uses the stable author key for equal metric and call-count ties", () => {
    const rows = [row("zeta"), row("alpha")];
    sortXCallerRows(rows as never[], "forwardReturn");
    expect(rows.map((value) => value.followTarget.key)).toEqual(["alpha", "zeta"]);
  });

  it("keeps null metric ties deterministic", () => {
    const rows = [row("zeta", { hitRate: null, avgForwardReturnPct: null }), row("alpha", { hitRate: null, avgForwardReturnPct: null })];
    sortXCallerRows(rows as never[], "hitRate");
    expect(rows.map((value) => value.followTarget.key)).toEqual(["alpha", "zeta"]);
  });
});

describe("users All measurement horizon", () => {
  it("uses true all-history retrieval until the named caps are reached", () => {
    const horizon = userLeaderboardHorizon("all", new Date("2026-08-21T00:00:00Z"));
    expect(horizon.floor).toBeNull();
    expect(horizon.label).toContain("all available history");
    expect(horizon.complete).toBe(true);
  });
});

describe("scoreXCallReturn", () => {
  it("keeps bullish returns and inverts bearish returns", () => {
    expect(scoreXCallReturn(8, "bullish")).toBe(8);
    expect(scoreXCallReturn(-8, "bearish")).toBe(8);
    expect(scoreXCallReturn(8, "bearish")).toBe(-8);
  });

  it("excludes unknown directions and unavailable horizons", () => {
    expect(scoreXCallReturn(8, "unknown")).toBeNull();
    expect(scoreXCallReturn(null, "bullish")).toBeNull();
  });
});

describe("computeCallForwardReturn", () => {
  const day = 24 * 60 * 60;
  const t0 = Math.floor(new Date("2026-05-01T00:00:00.000Z").getTime() / 1000);
  // 20 ascending daily bars; close rises by 1 each day starting at 100.
  const bars = Array.from({ length: 20 }, (_, i) => ({ time: t0 + i * day, close: 100 + i }));

  it("computes a forward return over the horizon using close-at-or-after anchors", () => {
    const callTime = new Date("2026-05-01T12:00:00.000Z"); // -> entry = day 1 close (101)
    const out = computeCallForwardReturn(bars, callTime, 7);
    // entry = bar index 1 (close 101); exit = bar index 8 (close 108)
    expect(out).toBeCloseTo(((108 - 101) / 101) * 100, 10);
  });

  it("measures a call whose entry bar is within the range tolerance", () => {
    // Call lands exactly on the first bar's day -> entry = bars[0], well in range.
    const callTime = new Date("2026-05-01T00:00:00.000Z");
    const out = computeCallForwardReturn(bars, callTime, 7);
    // entry = bar 0 (100); exit = bar 7 (107)
    expect(out).toBeCloseTo(((107 - 100) / 100) * 100, 10);
  });

  it("returns null when the call is OLDER than the oldest bar (entry would snap to bars[0])", () => {
    // Call 60 days before the first bar: the only bar at/after it is bars[0],
    // which is ~60d away -> far beyond the ~5 trading-day tolerance -> null.
    const callTime = new Date(new Date("2026-05-01T00:00:00.000Z").getTime() - 60 * day * 1000);
    const out = computeCallForwardReturn(bars, callTime, 7);
    expect(out).toBeNull();
  });

  it("returns null when the call is NEWER than the latest bar (no entry anchor)", () => {
    const callTime = new Date("2026-06-01T00:00:00.000Z"); // after the 20-bar series
    const out = computeCallForwardReturn(bars, callTime, 7);
    expect(out).toBeNull();
  });

  it("returns null when the exit anchor is beyond available bars", () => {
    const callTime = new Date("2026-05-19T00:00:00.000Z"); // near the end of the series
    const out = computeCallForwardReturn(bars, callTime, 30);
    expect(out).toBeNull();
  });

  it("does not fabricate a flat return when entry and exit resolve to the same bar", () => {
    const monday = Math.floor(new Date("2026-05-04T20:00:00.000Z").getTime() / 1000);
    const tuesday = Math.floor(new Date("2026-05-05T20:00:00.000Z").getTime() / 1000);
    const weekendBars = [
      { time: monday, close: 100 },
      { time: tuesday, close: 110 },
    ];
    const saturdayCall = new Date("2026-05-02T21:00:00.000Z");

    expect(computeCallForwardReturn(weekendBars, saturdayCall, 1)).toBeNull();
  });

  it("returns null for empty bars", () => {
    expect(computeCallForwardReturn([], new Date(), 7)).toBeNull();
  });
});

describe("groupTradeEventsByUser (M-6: no double-count of a shared fill)", () => {
  const testScope = JSON.stringify(["test-account", "test-credential", "alpaca"]);
  const equityBucketKey = `EQ|AAPL|scope:${testScope}`;
  const perpBucketKey = `PERP|BTC|perp-acct:${JSON.stringify(["test-account", "alpaca"])}`;
  const optionBucketKey = `OPT|AAPL|260717|150|CALL|scope:${testScope}`;

  function row(over: Partial<SocialOrderRow>): SocialOrderRow {
    return {
      userId: "u1",
      brokerOrderId: "bo-1",
      orderId: "ord-1",
      brokerAccountId: "test-account",
      brokerCredentialId: "test-credential",
      venue: "alpaca",
      symbol: "AAPL",
      assetType: "EQUITY",
      tradeAction: "Buy",
      direction: "long",
      reduceOnly: false,
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      executedPrice: "100",
      executedQuantity: 10,
      executedSizeDecimal: null,
      status: "FILLED",
      createdAt: "2026-06-01T00:00:00.000Z",
      ...over,
    };
  }

  it("collapses TWO social_trades that share one brokerOrderId into ONE event", () => {
    // Both rows are the SAME fill (same brokerOrderId + winning orderId) surfaced
    // via two distinct social_trades. Without the seenEvents guard the buy fill
    // would be pushed twice and a later sell would close a phantom second lot.
    const rows: SocialOrderRow[] = [
      row({ tradeAction: "Buy", executedQuantity: 10, executedPrice: "100", brokerOrderId: "bo-open", orderId: "ord-open" }),
      row({ tradeAction: "Buy", executedQuantity: 10, executedPrice: "100", brokerOrderId: "bo-open", orderId: "ord-open" }),
      row({ tradeAction: "Sell", direction: "long", executedQuantity: 10, executedPrice: "110", brokerOrderId: "bo-close", orderId: "ord-close", createdAt: "2026-06-02T00:00:00.000Z" }),
    ];
    const byUser = groupTradeEventsByUser(rows, tradeActionSide);
    const bucket = byUser.get("u1")!.get(equityBucketKey)!;
    // Exactly 2 events (1 buy + 1 sell), NOT 3 — the duplicated buy was dropped.
    expect(bucket.events).toHaveLength(2);

    const out = reconstructRealizedPnl(bucket.events);
    // One clean round-trip: (110-100)*10 = 100. (A double-counted buy would have
    // left an extra open lot and changed the closed-lot accounting.)
    expect(out.realizedPnl).toBe(100);
    expect(out.closedTrades).toBe(1);
  });

  it("collapses ORDER-side fan-out (many orders rows per brokerOrderId) to one event", () => {
    const rows: SocialOrderRow[] = [
      row({ brokerOrderId: "bo-1", orderId: "ord-2" }),
      row({ brokerOrderId: "bo-1", orderId: "ord-1" }), // lowest orderId wins
    ];
    const byUser = groupTradeEventsByUser(rows, tradeActionSide);
    expect(byUser.get("u1")!.get(equityBucketKey)!.events).toHaveLength(1);
  });

  it("chooses a filled fan-out row when a submitted row sorts first", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "bo-fanout",
          orderId: "ord-submitted",
          status: "SUBMITTED",
          executedPrice: null,
          executedQuantity: null,
        }),
        row({
          brokerOrderId: "bo-fanout",
          orderId: "ord-filled",
          status: "FILLED",
          executedPrice: "101",
          executedQuantity: 10,
        }),
      ],
      tradeActionSide,
    );

    expect(byUser.get("u1")!.get(equityBucketKey)!.events).toEqual([
      expect.objectContaining({ price: 101, qty: 10 }),
    ]);
  });

  it("prefers FILLED over a lower-ID PARTIAL and keeps the authoritative quantity", () => {
    const candidates = [
      row({
        brokerOrderId: "bo-precedence",
        orderId: "000-partial",
        status: "PARTIAL",
        executedQuantity: 2,
        executedPrice: "101",
        executedAt: "2026-06-01T09:00:00.000001Z",
      }),
      row({
        brokerOrderId: "bo-precedence",
        orderId: "999-filled",
        status: "FILLED",
        executedQuantity: 10,
        executedPrice: "101",
        executedAt: "2026-06-01T10:00:00.000001Z",
      }),
    ];

    expect(canonicalizeTradeRows(candidates)).toEqual([
      expect.objectContaining({
        orderId: "999-filled",
        status: "FILLED",
        executedQuantity: 10,
      }),
    ]);
    expect(compareCanonicalCandidates(candidates[1]!, candidates[0]!)).toBeLessThan(0);
  });

  it("prefers the larger cumulative PARTIAL quantity before execution time and IDs", () => {
    const candidates = [
      row({
        brokerOrderId: "bo-cumulative",
        orderId: "000-partial",
        status: "PARTIAL",
        executedQuantity: 2,
        executedAt: "2026-06-01T10:00:00.000001Z",
      }),
      row({
        brokerOrderId: "bo-cumulative",
        orderId: "999-partial",
        status: "PARTIAL",
        executedQuantity: 10,
        executedAt: "2026-06-01T09:00:00.000001Z",
      }),
    ];

    expect(canonicalizeTradeRows(candidates)[0]).toEqual(
      expect.objectContaining({ orderId: "999-partial", executedQuantity: 10 }),
    );
  });

  it("rejects perp quantities whose fixed-point units exceed the safe bound", () => {
    const candidates = [
      row({
        brokerOrderId: "bo-large-decimal",
        orderId: "000-small",
        assetType: "PERP",
        executedQuantity: null,
        executedSizeDecimal: "9007199254740992.1",
        status: "PARTIAL",
        executedPrice: "1",
      }),
      row({
        brokerOrderId: "bo-large-decimal",
        orderId: "999-large",
        assetType: "PERP",
        executedQuantity: null,
        executedSizeDecimal: "9007199254740992.2",
        status: "PARTIAL",
        executedPrice: "1",
      }),
    ];

    expect(canonicalizeTradeRows(candidates)).toEqual([]);
  });

  it("uses the later execution timestamp, then stable IDs, for equal-state candidates", () => {
    const later = row({
      brokerOrderId: "bo-timestamp",
      orderId: "order-later",
      socialTradeId: "social-later",
      status: "PARTIAL",
      executedQuantity: 10,
      executedAt: "2026-06-01T10:00:00.000001Z",
    });
    const earlier = row({
      brokerOrderId: "bo-timestamp",
      orderId: "order-earlier",
      socialTradeId: "social-earlier",
      status: "PARTIAL",
      executedQuantity: 10,
      executedAt: "2026-06-01T09:00:00.000001Z",
    });

    expect(compareCanonicalCandidates(later, earlier)).toBeLessThan(0);
    expect(
      canonicalizeTradeRows([
        row({
          brokerOrderId: "bo-tie",
          orderId: "order-b",
          socialTradeId: "social-b",
          status: "PARTIAL",
          executedQuantity: 10,
          executedAt: "2026-06-01T10:00:00.000001Z",
        }),
        row({
          brokerOrderId: "bo-tie",
          orderId: "order-a",
          socialTradeId: "social-a",
          status: "PARTIAL",
          executedQuantity: 10,
          executedAt: "2026-06-01T10:00:00.000001Z",
        }),
      ])[0],
    ).toEqual(expect.objectContaining({ orderId: "order-a" }));
  });

  it("counts a canceled-after-partial fill and prefers its terminal snapshot once", () => {
    const canonical = canonicalizeTradeRows([
      row({
        brokerOrderId: "terminal-partial",
        orderId: "partial-snapshot",
        status: "PARTIAL",
        executedQuantity: 4,
        executedPrice: "100",
        executedAt: "2026-06-01T10:00:00.000001Z",
      }),
      row({
        brokerOrderId: "terminal-partial",
        orderId: "cancelled-snapshot",
        status: "CANCELLED",
        executedQuantity: 4,
        executedPrice: "100",
        executedAt: "2026-06-01T10:01:00.000001Z",
      }),
    ]);

    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toEqual(expect.objectContaining({
      orderId: "cancelled-snapshot",
      status: "CANCELLED",
      executedQuantity: 4,
    }));
    expect(resolveEventPriceQty(canonical[0]!)).toEqual({ price: 100, qty: 4 });
  });

  it("rejects terminal zero fills and zero or negative executed prices", () => {
    expect(resolveEventPriceQty(row({ status: "CANCELLED", executedQuantity: 0 }))).toBeNull();
    expect(resolveEventPriceQty(row({ status: "CANCELLED", executedQuantity: 2 }))).toEqual({
      price: 100,
      qty: 2,
    });
    expect(resolveEventPriceQty(row({ executedPrice: "0" }))).toBeNull();
    expect(resolveEventPriceQty(row({ executedPrice: "-1" }))).toBeNull();
  });

  it("prefers the venue timestamp when multiple usable fan-out rows exist", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "bo-fanout",
          orderId: "ord-a",
          status: "PARTIAL",
          executedPrice: "101",
          executedQuantity: 10,
          createdAt: "2026-06-01T09:00:00.000Z",
          executedAt: null,
        }),
        row({
          brokerOrderId: "bo-fanout",
          orderId: "ord-b",
          status: "FILLED",
          executedPrice: "101",
          executedQuantity: 10,
          createdAt: "2026-06-01T09:00:00.000Z",
          executedAt: "2026-06-01T10:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    const bucket = byUser.get("u1")!.get(equityBucketKey)!;
    expect(bucket.events[0]!.at).toBe("2026-06-01T10:00:00.000Z");
    expect(bucket.lastTradeAt).toBe("2026-06-01T10:00:00.000Z");
  });

  it("keeps distinct brokerOrderIds as distinct events", () => {
    const rows: SocialOrderRow[] = [
      row({ brokerOrderId: "bo-a", orderId: "ord-a" }),
      row({ brokerOrderId: "bo-b", orderId: "ord-b" }),
    ];
    const byUser = groupTradeEventsByUser(rows, tradeActionSide);
    expect(byUser.get("u1")!.get(equityBucketKey)!.events).toHaveLength(2);
  });

  it("scopes equal broker order IDs by user", () => {
    const rows: SocialOrderRow[] = [
      row({ userId: "u1", brokerOrderId: "shared", tradeAction: "Buy" }),
      row({
        userId: "u1",
        brokerOrderId: "u1-close",
        tradeAction: "Sell",
        executedPrice: "110",
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
      row({ userId: "u2", brokerOrderId: "shared", tradeAction: "Buy", executedPrice: "200" }),
      row({
        userId: "u2",
        brokerOrderId: "u2-close",
        tradeAction: "Sell",
        executedPrice: "190",
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const byUser = groupTradeEventsByUser(rows, tradeActionSide);
    expect(byUser.get("u1")!.get(equityBucketKey)!.events).toHaveLength(2);
    expect(byUser.get("u2")!.get(equityBucketKey)!.events).toHaveLength(2);
    expect(
      reconstructRealizedPnl(byUser.get("u1")!.get(equityBucketKey)!.events).realizedPnl,
    ).toBe(100);
    expect(
      reconstructRealizedPnl(byUser.get("u2")!.get(equityBucketKey)!.events).realizedPnl,
    ).toBe(-100);
  });

  it("keeps Paper and Live positions in separate FIFO buckets", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "paper-open",
          brokerAccountId: "paper-account",
          brokerCredentialId: "paper-credential",
          venue: "alpaca",
          tradeAction: "Buy",
        }),
        row({
          brokerOrderId: "live-close",
          brokerAccountId: "live-account",
          brokerCredentialId: "live-credential",
          venue: "alpaca",
          tradeAction: "Sell",
          executedPrice: "110",
          createdAt: "2026-06-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    const buckets = byUser.get("u1")!;
    expect([...buckets.keys()]).toHaveLength(2);
    expect(
      [...buckets.values()].every((bucket) => reconstructRealizedPnl(bucket.events).closedTrades === 0),
    ).toBe(true);
  });

  it("pairs legacy and current PERP fills on the same wallet", () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const byUser = groupTradeEventsByUser(
      [
        row({
          orderId: "legacy-open",
          brokerOrderId: "hl-open",
          brokerAccountId: wallet,
          brokerCredentialId: null,
          venue: "hyperliquid",
          symbol: "PUMP",
          assetType: "PERP",
          tradeAction: "Buy",
          executedPrice: "1",
          executedQuantity: null,
          executedSizeDecimal: "10",
        }),
        row({
          orderId: "current-close",
          brokerOrderId: "hl-close",
          brokerAccountId: wallet,
          brokerCredentialId: "current-credential",
          venue: "hyperliquid",
          symbol: "PUMP",
          assetType: "PERP",
          tradeAction: "Sell",
          executedPrice: "2",
          executedQuantity: null,
          executedSizeDecimal: "10",
          createdAt: "2026-06-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    const buckets = [...(byUser.get("u1")?.values() ?? [])];
    expect(buckets).toHaveLength(1);
    expect(reconstructRealizedPnl(buckets[0]!.events)).toMatchObject({
      realizedPnl: 10,
      closedTrades: 1,
    });
  });

  it("orders FIFO events by executedAt, with stable IDs for equal timestamps", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "late-fill",
          orderId: "order-late",
          socialTradeId: "social-late",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Buy",
          executedPrice: "100",
          createdAt: "2026-06-01T10:00:00.000Z",
          executedAt: "2026-06-01T12:00:00.000Z",
        }),
        row({
          brokerOrderId: "early-fill",
          orderId: "order-early",
          socialTradeId: "social-early",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Buy",
          executedPrice: "200",
          createdAt: "2026-06-01T11:00:00.000Z",
          executedAt: "2026-06-01T11:00:00.000Z",
        }),
        row({
          brokerOrderId: "close",
          orderId: "order-close",
          socialTradeId: "social-close",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Sell",
          executedPrice: "150",
          createdAt: "2026-06-01T13:00:00.000Z",
          executedAt: "2026-06-01T13:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    const bucket = [...byUser.get("u1")!.values()][0]!;
    expect(bucket.events.map((event) => event.price)).toEqual([200, 100, 150]);
    expect(reconstructRealizedPnl(bucket.events).realizedPnl).toBe(-500);
    expect(bucket.lastTradeAt).toBe("2026-06-01T13:00:00.000Z");
  });

  it("preserves sub-millisecond fill ordering instead of truncating to Date precision", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "micro-first",
          orderId: "order-first",
          socialTradeId: "z-first",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Buy",
          executedPrice: "100",
          executedAt: "2026-06-01T12:00:00.000001Z",
        }),
        row({
          brokerOrderId: "micro-second",
          orderId: "order-second",
          socialTradeId: "a-second",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Buy",
          executedPrice: "200",
          executedAt: "2026-06-01T12:00:00.000002Z",
        }),
        row({
          brokerOrderId: "micro-close",
          orderId: "order-close",
          socialTradeId: "close",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Sell",
          executedPrice: "150",
          executedQuantity: 10,
          executedAt: "2026-06-01T12:00:01.000000Z",
        }),
      ],
      tradeActionSide,
    );

    const bucket = [...byUser.get("u1")!.values()][0]!;
    expect(bucket.events.map((event) => event.price)).toEqual([100, 200, 150]);
    expect(reconstructRealizedPnl(bucket.events).realizedPnl).toBe(500);
  });

  it("keeps unknown-scope legacy events from pairing across account modes", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "unknown-paper-open",
          socialTradeId: "social-paper-open",
          tradeAction: "Buy",
          executedPrice: "100",
          brokerAccountId: null,
          brokerCredentialId: null,
          venue: null,
        }),
        row({
          brokerOrderId: "unknown-live-close",
          socialTradeId: "social-live-close",
          tradeAction: "Sell",
          executedPrice: "110",
          brokerAccountId: null,
          brokerCredentialId: null,
          venue: null,
          createdAt: "2026-06-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(
      [...(byUser.get("u1")?.values() ?? [])].every(
        (bucket) => reconstructRealizedPnl(bucket.events).closedTrades === 0,
      ),
    ).toBe(true);
  });

  it("does not pair rows with only one missing scope component", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "partial-scope-open",
          socialTradeId: "social-open",
          tradeAction: "Buy",
          executedPrice: "100",
          brokerAccountId: "paper-account",
          brokerCredentialId: null,
          venue: "alpaca",
        }),
        row({
          brokerOrderId: "partial-scope-close",
          socialTradeId: "social-close",
          tradeAction: "Sell",
          executedPrice: "110",
          brokerAccountId: "live-account",
          brokerCredentialId: null,
          venue: "alpaca",
          createdAt: "2026-06-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(
      [...(byUser.get("u1")?.values() ?? [])].every(
        (bucket) => reconstructRealizedPnl(bucket.events).closedTrades === 0,
      ),
    ).toBe(true);
  });

  it("retains microsecond precision in the public event timestamp", () => {
    expect(
      resolveTradeEventAt({
        executedAt: "2026-06-01T12:00:00.123456Z",
        createdAt: "2026-06-01T11:00:00.999999Z",
      }),
    ).toBe("2026-06-01T12:00:00.123456Z");
  });

  it("continues a dense keyset page without repeating or skipping microsecond events", () => {
    const rows = [
      row({
        brokerOrderId: "page-a",
        orderId: "order-a",
        socialTradeId: "social-a",
        brokerAccountId: "test-account",
        brokerCredentialId: "test-credential",
        executedAt: "2026-06-01T12:00:00.000001Z",
      }),
      row({
        brokerOrderId: "page-b",
        orderId: "order-b",
        socialTradeId: "social-b",
        brokerAccountId: "test-account",
        brokerCredentialId: "test-credential",
        executedAt: "2026-06-01T12:00:00.000002Z",
      }),
      row({
        brokerOrderId: "page-c",
        orderId: "order-c",
        socialTradeId: "social-c",
        brokerAccountId: "test-account",
        brokerCredentialId: "test-credential",
        executedAt: "2026-06-01T12:00:00.000003Z",
      }),
      row({
        brokerOrderId: "page-d",
        orderId: "order-d",
        socialTradeId: "social-d",
        brokerAccountId: "test-account",
        brokerCredentialId: "test-credential",
        executedAt: "2026-06-01T12:00:00.000003Z",
      }),
    ];
    const ordered = [...rows].sort(compareLeaderboardEventRows);
    const pageOne = ordered.slice(0, 2);
    const cursor = resolveLeaderboardEventCursor(pageOne.at(-1)!)!;
    const pageTwo = ordered
      .filter((candidate) => isAfterLeaderboardEventCursor(candidate, cursor))
      .slice(0, 2);

    expect(pageOne.map((candidate) => candidate.brokerOrderId)).toEqual(["page-a", "page-b"]);
    expect(pageTwo.map((candidate) => candidate.brokerOrderId)).toEqual(["page-c", "page-d"]);
    expect(new Set([...pageOne, ...pageTwo].map((candidate) => candidate.brokerOrderId)).size).toBe(4);
  });

  it("keeps microsecond cursor text intact when Drizzle compiles the keyset condition", () => {
    const cursor = {
      eventAt: "2026-06-01T12:00:00.123456Z",
      socialTradeId: "social-b",
      orderId: "order-b",
    };
    const cursorSocialTrades = alias(schema.socialTrades, "cursor_social_trades");
    const cursorOrders = alias(schema.orders, "cursor_orders");
    const compiled = new PgDialect().sqlToQuery(
      buildLeaderboardCursorCondition(
        sql`event_at`,
        cursorSocialTrades.id,
        cursorOrders.id,
        cursor,
      ),
    );

    expect(compiled.params).toEqual([
      cursor.eventAt,
      cursor.eventAt,
      cursor.socialTradeId,
      cursor.eventAt,
      cursor.socialTradeId,
      cursor.orderId,
    ]);
  });

  it("compiles a bounded measurement query with authoritative order linkage", () => {
    const queryDb = drizzle(
      { query: () => Promise.resolve({ rows: [], fields: [] }) } as never,
      { schema },
    );
    const measurementFloor = new Date("2025-08-21T00:00:00.000Z");
    const materialization = new PgDialect().sqlToQuery(
      buildLeaderboardCanonicalMaterializationQuery(queryDb, measurementFloor),
    );
    const socialAlias = 'as "social_trade_id"';
    const orderAlias = 'as "order_id"';

    expect(materialization.sql.indexOf(socialAlias)).toBeGreaterThan(-1);
    expect(materialization.sql.indexOf(orderAlias)).toBeGreaterThan(-1);
    expect(materialization.sql.split(socialAlias)).toHaveLength(2);
    expect(materialization.sql.split(orderAlias)).toHaveLength(2);
    expect(materialization.sql.indexOf(socialAlias)).toBeLessThan(
      materialization.sql.indexOf(orderAlias),
    );
    expect(materialization.sql).toContain("executed_at");
    expect(materialization.sql).toContain("not in ('NaN', 'Infinity', '-Infinity')");
    expect(materialization.params).toContain("9007199254740991");
    expect(materialization.sql).toContain(
      '"leaderboard_social_trades"."order_id" = "leaderboard_orders"."id"',
    );
    expect(materialization.sql).toContain("not exists");
    expect(materialization.sql).toContain("is distinct from");
    expect(materialization.sql).toContain("limit");
    expect(materialization.sql).not.toContain("temporary table");
    expect(materialization.params).toContain(measurementFloor);
    expect(materialization.params).toContain(0);
    expect(materialization.params).toContain(USER_HISTORY_CANDIDATE_FETCH_LIMIT);
    for (const status of ["FILLED", "PARTIAL", "CANCELLED", "EXPIRED", "REJECTED"]) {
      expect(materialization.params).toContain(status);
    }
  });

  it("compiles a separately bounded pre-window FIFO state query", () => {
    const queryDb = drizzle(
      { query: () => Promise.resolve({ rows: [], fields: [] }) } as never,
      { schema },
    );
    const measurementFloor = new Date("2025-08-21T00:00:00.000Z");
    const prior = new PgDialect().sqlToQuery(
      buildLeaderboardCanonicalMaterializationQuery(queryDb, null, measurementFloor),
    );

    expect(prior.params).toContain(measurementFloor);
    expect(prior.sql).toContain("<");
    expect(prior.params).toContain(USER_HISTORY_CANDIDATE_FETCH_LIMIT);
  });

  it("canonicalizes fan-out before splitting the authoritative stream into pages", () => {
    const rows = [
      row({
        brokerOrderId: "cross-page-fanout",
        orderId: "000-submitted",
        status: "SUBMITTED",
        executedPrice: null,
        executedQuantity: null,
      }),
      row({
        brokerOrderId: "cross-page-fanout",
        orderId: "001-partial",
        status: "PARTIAL",
        executedPrice: "101",
        executedQuantity: 2,
        executedAt: "2026-06-01T09:00:00.000001Z",
      }),
      row({
        brokerOrderId: "cross-page-fanout",
        orderId: "002-filled",
        status: "FILLED",
        executedPrice: "101",
        executedQuantity: 10,
        executedAt: "2026-06-01T10:00:00.000001Z",
      }),
      row({
        brokerOrderId: "cross-page-close",
        orderId: "003-close",
        tradeAction: "Sell",
        executedPrice: "111",
        executedAt: "2026-06-01T11:00:00.000001Z",
      }),
    ];
    const canonical = canonicalizeTradeRows(rows);
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(canonical.slice(0, 1), tradeActionSide);
    accumulator.ingest(canonical.slice(1), tradeActionSide);

    expect(canonical.map((candidate) => candidate.orderId)).toEqual([
      "002-filled",
      "003-close",
    ]);
    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 100,
      tradeCount: 1,
    });
  });

  it("uses the stable social ID when equal fill timestamps tie", () => {
    const byUser = groupTradeEventsByUser(
      [
        row({
          brokerOrderId: "buy-b",
          orderId: "order-b",
          socialTradeId: "social-b",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Buy",
          executedPrice: "100",
          executedAt: "2026-06-01T12:00:00.000Z",
        }),
        row({
          brokerOrderId: "buy-a",
          orderId: "order-a",
          socialTradeId: "social-a",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Buy",
          executedPrice: "200",
          executedAt: "2026-06-01T12:00:00.000Z",
        }),
        row({
          brokerOrderId: "close",
          orderId: "order-close",
          socialTradeId: "social-close",
          brokerAccountId: "test-account",
          brokerCredentialId: "test-credential",
          tradeAction: "Sell",
          executedPrice: "150",
          executedAt: "2026-06-01T13:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    const bucket = [...byUser.get("u1")!.values()][0]!;
    expect(bucket.events.map((event) => event.price)).toEqual([200, 100, 150]);
    expect(reconstructRealizedPnl(bucket.events).realizedPnl).toBe(-500);
  });

  it("uses exact decimal PERP sizes and matches reduce-only closes to the position side", () => {
    const rows: SocialOrderRow[] = [
      row({
        assetType: "PERP",
        symbol: "BTC",
        executedQuantity: null,
        executedSizeDecimal: "0.12500001",
        executedPrice: "100",
        brokerOrderId: "perp-open",
        orderId: "perp-open",
      }),
      row({
        assetType: "PERP",
        symbol: "BTC",
        tradeAction: "Sell",
        direction: "short",
        reduceOnly: true,
        executedQuantity: null,
        executedSizeDecimal: "0.12500001",
        executedPrice: "110",
        brokerOrderId: "perp-close",
        orderId: "perp-close",
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const bucket = groupTradeEventsByUser(rows, tradeActionSide)
      .get("u1")!
      .get(perpBucketKey)!;
    expect(bucket.events.map((event) => event.direction)).toEqual(["long", "long"]);
    expect(bucket.events[0]!.qty).toBe(0.12500001);
    expect(reconstructRealizedPnl(bucket.events).realizedPnl).toBeCloseTo(1.2500001, 8);
  });

  it("buckets options separately from equities and applies the contract multiplier", () => {
    const rows: SocialOrderRow[] = [
      row({ brokerOrderId: "bo-eq", orderId: "ord-eq", assetType: "EQUITY" }),
      row({
        brokerOrderId: "bo-opt",
        orderId: "ord-opt",
        assetType: "OPTION",
        optionExpiration: "260717",
        optionStrike: "150",
        optionType: "CALL",
      }),
    ];
    const byUser = groupTradeEventsByUser(rows, tradeActionSide);
    const buckets = byUser.get("u1")!;
    expect(buckets.has(equityBucketKey)).toBe(true);
    expect(buckets.has(optionBucketKey)).toBe(true);
    expect(buckets.get(optionBucketKey)!.events[0]!.multiplier).toBe(
      OPTION_CONTRACT_MULTIPLIER,
    );
  });

  it("skips rows with no brokerOrderId, unfilled status, or missing fill price/qty", () => {
    const rows: SocialOrderRow[] = [
      row({ brokerOrderId: null, orderId: "ord-x" }),
      row({ brokerOrderId: "bo-pending", orderId: "ord-p", status: "PENDING" }),
      row({ brokerOrderId: "bo-noprice", orderId: "ord-n", executedPrice: null }),
      row({ brokerOrderId: "bo-noqty", orderId: "ord-q", executedQuantity: 0 }),
      row({ brokerOrderId: "bo-good", orderId: "ord-g" }),
    ];
    const byUser = groupTradeEventsByUser(rows, tradeActionSide);
    expect(byUser.get("u1")!.get(equityBucketKey)!.events).toHaveLength(1);
  });

  it("skips malformed option fills before applying the contract multiplier", () => {
    const rows: SocialOrderRow[] = [
      row({
        assetType: "OPTION",
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
        brokerOrderId: "bad-option-open",
        orderId: "bad-option-open",
        tradeAction: "BuyToOpen",
      }),
      row({
        assetType: "OPTION",
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
        brokerOrderId: "bad-option-close",
        orderId: "bad-option-close",
        tradeAction: "SellToClose",
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    expect(groupTradeEventsByUser(rows, tradeActionSide).get("u1")).toBeUndefined();
    expect(resolveEventPriceQty(rows[0]!)).toBeNull();
  });
});

describe("UserLeaderboardAccumulator", () => {
  function row(over: Partial<SocialOrderRow>): SocialOrderRow {
    return {
      userId: "u1",
      brokerOrderId: "bo-open",
      orderId: "ord-open",
      brokerAccountId: "test-account",
      brokerCredentialId: "test-credential",
      venue: "alpaca",
      symbol: "AAPL",
      assetType: "EQUITY",
      tradeAction: "Buy",
      direction: "long",
      reduceOnly: false,
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      executedPrice: "100",
      executedQuantity: 10,
      executedSizeDecimal: null,
      status: "FILLED",
      createdAt: "2026-05-01T00:00:00.000Z",
      ...over,
    };
  }

  it("preserves FIFO when an open and close land on different pages", () => {
    const accumulator = new UserLeaderboardAccumulator("2026-06-01T00:00:00.000Z");
    accumulator.ingest([row({})], tradeActionSide);
    accumulator.ingest(
      [
        row({ brokerOrderId: "bo-open", orderId: "ord-duplicate" }),
        row({
          brokerOrderId: "bo-close",
          orderId: "ord-close",
          tradeAction: "Sell",
          executedPrice: "112",
          createdAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toEqual({
      realizedPnl: 120,
      alpacaPnl: 120,
      hyperliquidPnl: 0,
      winRate: 1,
      tradeCount: 1,
      lastTradeAt: "2026-06-05T00:00:00.000Z",
    });
  });

  it("keeps a filled fan-out row when submitted and filled rows cross pages", () => {
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({
          brokerOrderId: "bo-fanout",
          orderId: "ord-submitted",
          status: "SUBMITTED",
          executedPrice: null,
          executedQuantity: null,
        }),
      ],
      tradeActionSide,
    );
    accumulator.ingest(
      [
        row({
          brokerOrderId: "bo-fanout",
          orderId: "ord-filled",
          status: "FILLED",
          executedPrice: "101",
          executedQuantity: 10,
        }),
      ],
      tradeActionSide,
    );

    accumulator.ingest(
      [
        row({
          brokerOrderId: "bo-close",
          orderId: "ord-close",
          tradeAction: "Sell",
          executedPrice: "111",
          createdAt: "2026-06-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 100,
      tradeCount: 1,
      lastTradeAt: "2026-06-02T00:00:00.000Z",
    });
  });

  it("replays a large paged history while retaining only live FIFO state", () => {
    const rows: SocialOrderRow[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      rows.push(
        row({
          brokerOrderId: `perf-open-${index}`,
          orderId: `perf-open-order-${index}`,
          tradeAction: "Buy",
          executedPrice: "100",
          executedQuantity: 1,
          createdAt: "2026-06-01T00:00:00.000Z",
        }),
        row({
          brokerOrderId: `perf-close-${index}`,
          orderId: `perf-close-order-${index}`,
          tradeAction: "Sell",
          executedPrice: "101",
          executedQuantity: 1,
          createdAt: "2026-06-01T00:00:00.000Z",
        }),
      );
    }

    const accumulator = new UserLeaderboardAccumulator(null);
    for (let offset = 0; offset < rows.length; offset += 250) {
      accumulator.ingest(rows.slice(offset, offset + 250), tradeActionSide);
    }

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 10_000,
      tradeCount: 10_000,
      winRate: 1,
    });
  });

  it("enforces a deliberate open-lot cap instead of silently losing future P&L", () => {
    const maxOpenLots = 128;
    const accumulator = new UserLeaderboardAccumulator(null, { maxOpenLots });
    const openLots = Array.from({ length: maxOpenLots }, (_, index) =>
      row({
        brokerOrderId: `permanent-open-${index}`,
        orderId: `permanent-open-order-${index}`,
        symbol: `SYM${index}`,
        executedQuantity: 1,
      }),
    );

    accumulator.ingest(openLots, tradeActionSide);
    expect(accumulator.retainedOpenLotCount).toBe(maxOpenLots);
    expect(() =>
      accumulator.ingest(
        [
          row({
            brokerOrderId: "permanent-open-over-cap",
            orderId: "permanent-open-order-over-cap",
            symbol: "OVER",
            executedQuantity: 1,
          }),
        ],
        tradeActionSide,
      ),
    ).toThrow(LeaderboardFifoCapacityError);
    expect(accumulator.retainedOpenLotCount).toBe(maxOpenLots);
  });

  it("bounds total ingested events and retained users, not only open lots", () => {
    const eventBounded = new UserLeaderboardAccumulator(null, {
      maxOpenLots: 10,
      maxEvents: 2,
      maxUsers: 10,
      maxBuckets: 10,
    });
    eventBounded.ingest([
      row({ brokerOrderId: "event-1", orderId: "event-order-1", userId: "u1" }),
      row({ brokerOrderId: "event-2", orderId: "event-order-2", userId: "u1" }),
    ], tradeActionSide);
    expect(() => eventBounded.ingest([
      row({ brokerOrderId: "event-3", orderId: "event-order-3", userId: "u1" }),
    ], tradeActionSide)).toThrow(LeaderboardFifoCapacityError);

    const userBounded = new UserLeaderboardAccumulator(null, {
      maxOpenLots: 10,
      maxEvents: 10,
      maxUsers: 1,
      maxBuckets: 10,
    });
    userBounded.ingest([
      row({ brokerOrderId: "user-1", orderId: "user-order-1", userId: "u1" }),
    ], tradeActionSide);
    expect(() => userBounded.ingest([
      row({ brokerOrderId: "user-2", orderId: "user-order-2", userId: "u2" }),
    ], tradeActionSide)).toThrow(LeaderboardFifoCapacityError);
  });

  it("matches perp decimal quantities exactly without a floating-point remainder", () => {
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest([
      row({
        brokerOrderId: "perp-open",
        orderId: "perp-open-order",
        assetType: "PERP",
        symbol: "BTC",
        executedQuantity: null,
        executedSizeDecimal: "0.3",
        executedPrice: "100",
        tradeAction: "Buy",
        direction: "long",
      }),
      row({
        brokerOrderId: "perp-close-1",
        orderId: "perp-close-order-1",
        assetType: "PERP",
        symbol: "BTC",
        executedQuantity: null,
        executedSizeDecimal: "0.2",
        executedPrice: "101",
        tradeAction: "Sell",
        direction: "short",
        reduceOnly: true,
      }),
      row({
        brokerOrderId: "perp-close-2",
        orderId: "perp-close-order-2",
        assetType: "PERP",
        symbol: "BTC",
        executedQuantity: null,
        executedSizeDecimal: "0.1",
        executedPrice: "100000000",
        tradeAction: "Sell",
        direction: "short",
        reduceOnly: true,
      }),
    ], tradeActionSide);

    expect(accumulator.retainedOpenLotCount).toBe(0);
    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 9_999_990.2,
      tradeCount: 2,
    });
  });

  it("scopes accumulator deduplication and FIFO buckets by account identity", () => {
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({
          userId: "u1",
          brokerOrderId: "shared",
          brokerAccountId: "paper-account",
          brokerCredentialId: "paper-credential",
          venue: "alpaca",
          tradeAction: "Buy",
          executedPrice: "100",
        }),
        row({
          userId: "u2",
          brokerOrderId: "shared",
          brokerAccountId: "live-account",
          brokerCredentialId: "live-credential",
          venue: "alpaca",
          tradeAction: "Buy",
          executedPrice: "200",
        }),
        row({
          userId: "u1",
          brokerOrderId: "paper-close",
          brokerAccountId: "paper-account",
          brokerCredentialId: "paper-credential",
          venue: "alpaca",
          tradeAction: "Sell",
          executedPrice: "110",
          createdAt: "2026-05-02T00:00:00.000Z",
        }),
        row({
          userId: "u2",
          brokerOrderId: "live-close",
          brokerAccountId: "live-account",
          brokerCredentialId: "live-credential",
          venue: "alpaca",
          tradeAction: "Sell",
          executedPrice: "190",
          createdAt: "2026-05-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize()).toEqual(
      new Map([
        ["u1", expect.objectContaining({ realizedPnl: 100, tradeCount: 1 })],
        ["u2", expect.objectContaining({ realizedPnl: -100, tradeCount: 1 })],
      ]),
    );
  });

  it("attributes a close to the window by executedAt, not submission time", () => {
    const accumulator = new UserLeaderboardAccumulator("2026-06-01T12:00:00.000Z");
    accumulator.ingest(
      [
        row({
          brokerOrderId: "open",
          tradeAction: "Buy",
          executedPrice: "100",
          createdAt: "2026-06-01T09:00:00.000Z",
          executedAt: "2026-06-01T10:00:00.000Z",
        }),
        row({
          brokerOrderId: "close",
          tradeAction: "Sell",
          executedPrice: "110",
          createdAt: "2026-06-01T11:00:00.000Z",
          executedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 100,
      tradeCount: 1,
      lastTradeAt: "2026-06-01T12:00:00.000Z",
    });
  });

  it("reports a later open-only fill in lastTradeAt even when it has no closed lot", () => {
    const accumulator = new UserLeaderboardAccumulator("2026-06-01T00:00:00.000Z");
    accumulator.ingest(
      [
        row({
          brokerOrderId: "window-open",
          orderId: "window-open-order",
          tradeAction: "Buy",
          executedPrice: "100",
          executedAt: "2026-06-01T10:00:00.000001Z",
        }),
        row({
          brokerOrderId: "window-close",
          orderId: "window-close-order",
          tradeAction: "Sell",
          executedPrice: "110",
          executedAt: "2026-06-01T11:00:00.000001Z",
        }),
        row({
          brokerOrderId: "later-open-only",
          orderId: "later-open-only-order",
          symbol: "MSFT",
          tradeAction: "Buy",
          executedPrice: "200",
          executedAt: "2026-06-01T12:00:00.000002Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      tradeCount: 1,
      lastTradeAt: "2026-06-01T12:00:00.000002Z",
    });
  });

  it("uses the latest fill from an open-only bucket for lastTradeAt", () => {
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({
          brokerOrderId: "closed-open",
          symbol: "AAPL",
          tradeAction: "Buy",
          executedPrice: "100",
          createdAt: "2026-06-01T09:00:00.000Z",
        }),
        row({
          brokerOrderId: "closed-close",
          symbol: "AAPL",
          tradeAction: "Sell",
          executedPrice: "110",
          createdAt: "2026-06-01T10:00:00.000Z",
        }),
        row({
          brokerOrderId: "open-only",
          symbol: "MSFT",
          tradeAction: "Buy",
          executedPrice: "200",
          createdAt: "2026-06-01T11:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 100,
      tradeCount: 1,
      lastTradeAt: "2026-06-01T11:00:00.000Z",
    });
  });

  it("keeps pre-window closes out while retaining their FIFO effect", () => {
    const accumulator = new UserLeaderboardAccumulator("2026-06-01T00:00:00.000Z");
    accumulator.ingest(
      [
        row({ executedQuantity: 20 }),
        row({
          brokerOrderId: "bo-close-old",
          orderId: "ord-close-old",
          tradeAction: "Sell",
          executedPrice: "90",
          executedQuantity: 10,
          createdAt: "2026-05-15T00:00:00.000Z",
        }),
        row({
          brokerOrderId: "bo-close-new",
          orderId: "ord-close-new",
          tradeAction: "Sell",
          executedPrice: "110",
          executedQuantity: 10,
          createdAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 100,
      winRate: 1,
      tradeCount: 1,
    });
  });

  it("scores an in-window partial close against a pre-window open lot", () => {
    const accumulator = new UserLeaderboardAccumulator("2026-08-01T00:00:00.000Z");
    accumulator.ingest(
      [
        row({
          brokerOrderId: "old-open",
          orderId: "old-open-order",
          tradeAction: "Buy",
          executedPrice: "100",
          executedQuantity: 10,
          createdAt: "2026-07-31T00:00:00.000Z",
        }),
        row({
          brokerOrderId: "new-close",
          orderId: "new-close-order",
          tradeAction: "Sell",
          executedPrice: "110",
          executedQuantity: 4,
          createdAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 40,
      winRate: 1,
      tradeCount: 1,
    });
    expect(accumulator.retainedOpenLotCount).toBe(1);
  });

  it("FIFO-pairs a new close across partial slices of pre-window lots", () => {
    const accumulator = new UserLeaderboardAccumulator("2026-08-01T00:00:00.000Z");
    accumulator.ingest(
      [
        row({
          brokerOrderId: "old-open-a",
          orderId: "old-open-a-order",
          tradeAction: "Buy",
          executedPrice: "100",
          executedQuantity: 3,
          createdAt: "2026-07-29T00:00:00.000Z",
        }),
        row({
          brokerOrderId: "old-open-b",
          orderId: "old-open-b-order",
          tradeAction: "Buy",
          executedPrice: "120",
          executedQuantity: 7,
          createdAt: "2026-07-30T00:00:00.000Z",
        }),
        row({
          brokerOrderId: "new-close-slice",
          orderId: "new-close-slice-order",
          tradeAction: "Sell",
          executedPrice: "130",
          executedQuantity: 5,
          createdAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toMatchObject({
      realizedPnl: 110,
      winRate: 1,
      tradeCount: 2,
    });
    expect(accumulator.retainedOpenLotCount).toBe(1);
  });

  it("matches the legacy full-batch reconstruction across page boundaries", () => {
    const rows = [
      row({ brokerOrderId: "bo-long-open", orderId: "01", executedQuantity: 15 }),
      row({
        brokerOrderId: "bo-long-close",
        orderId: "02",
        tradeAction: "Sell",
        executedPrice: "110",
        executedQuantity: 10,
        createdAt: "2026-05-02T00:00:00.000Z",
      }),
      row({
        brokerOrderId: "bo-short-open",
        orderId: "03",
        symbol: "MSFT",
        tradeAction: "SellShort",
        direction: "short",
        executedPrice: "200",
        executedQuantity: 4,
        createdAt: "2026-05-03T00:00:00.000Z",
      }),
      row({
        brokerOrderId: "bo-short-close",
        orderId: "04",
        symbol: "MSFT",
        tradeAction: "BuyToCover",
        direction: "short",
        executedPrice: "180",
        executedQuantity: 4,
        createdAt: "2026-05-04T00:00:00.000Z",
      }),
    ];

    const legacy = new Map<string, ReturnType<typeof aggregateUserStats>>();
    for (const [userId, buckets] of groupTradeEventsByUser(rows, tradeActionSide)) {
      const stats = aggregateUserStats(
        [...buckets.values()].map((bucket) => ({
          result: reconstructRealizedPnl(bucket.events),
          lastTradeAt: bucket.lastTradeAt,
        })),
      );
      // Every row in this regression is Alpaca. The legacy batch helper does
      // not retain venue metadata, so annotate the expected venue split here.
      legacy.set(userId, { ...stats, alpacaPnl: stats.realizedPnl });
    }

    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(rows.slice(0, 2), tradeActionSide);
    accumulator.ingest(rows.slice(2), tradeActionSide);

    expect(accumulator.finalize()).toEqual(legacy);
  });

  it("keeps PERPs separate from equities and flips reduce-only close direction", () => {
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({
          brokerOrderId: "equity-open",
          orderId: "01",
          symbol: "BTC",
          executedPrice: "10",
          executedQuantity: 1,
        }),
        row({
          brokerOrderId: "perp-open",
          orderId: "02",
          symbol: "BTC",
          assetType: "PERP",
          venue: "hyperliquid",
          executedPrice: "100",
          executedQuantity: null,
          executedSizeDecimal: "0.12500001",
          createdAt: "2026-05-02T00:00:00.000Z",
        }),
        row({
          brokerOrderId: "perp-close",
          orderId: "03",
          symbol: "BTC",
          assetType: "PERP",
          venue: "hyperliquid",
          tradeAction: "Sell",
          direction: "short",
          reduceOnly: true,
          executedPrice: "110",
          executedQuantity: null,
          executedSizeDecimal: "0.12500001",
          createdAt: "2026-05-03T00:00:00.000Z",
        }),
        row({
          brokerOrderId: "equity-close",
          orderId: "04",
          symbol: "BTC",
          tradeAction: "Sell",
          executedPrice: "20",
          executedQuantity: 1,
          createdAt: "2026-05-04T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    const stats = accumulator.finalize().get("u1");
    expect(stats).toMatchObject({
      realizedPnl: 11.2500001,
      alpacaPnl: 10,
      winRate: 1,
      tradeCount: 2,
      lastTradeAt: "2026-05-04T00:00:00.000Z",
    });
    expect(stats?.hyperliquidPnl).toBeCloseTo(1.2500001, 10);
  });
});

// ---------------------------------------------------------------------------
// Codex P2 (data integrity): realized closes require a REAL fill.
//
// A realized closed trade (with P&L) must depend on an ACTUAL fill, not on mere
// broker acceptance. A position CLOSE that the broker only ACCEPTED (status
// SUBMITTED, brokerOrderId set) carries NO executed_price/executed_quantity yet
// and may NEVER fill (e.g. a shared limit sell resting above the market).
// Counting it would fabricate a realized win/loss. Opens and closes are
// therefore symmetric: both need FILLED/PARTIAL + a non-null executed price +
// executed qty > 0. Closed-trade stats populate once the async OrderSyncPoller
// reconciles the fill (it backfills executed price/qty from
// filled_avg_price/filled_qty), at which point the row is counted.
// ---------------------------------------------------------------------------
describe("resolveEventPriceQty: realized events require a real fill", () => {
  function row(over: Partial<SocialOrderRow>): SocialOrderRow {
    return {
      userId: "u1",
      brokerOrderId: "bo-1",
      orderId: "ord-1",
      symbol: "AAPL",
      assetType: "EQUITY",
      tradeAction: "Sell",
      direction: "long",
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      executedPrice: null,
      executedQuantity: null,
      status: "SUBMITTED",
      createdAt: "2026-06-05T00:00:00.000Z",
      ...over,
    };
  }

  it("does NOT count a SUBMITTED (accepted-but-unfilled) close", () => {
    // A broker-accepted-but-unfilled close (e.g. a limit sell resting above the
    // market that may never fill) must never be counted as a realized close.
    const out = resolveEventPriceQty(
      row({ status: "SUBMITTED", executedPrice: null, executedQuantity: null }),
    );
    expect(out).toBeNull();
  });

  it("counts a FILLED close by its executed fill", () => {
    const out = resolveEventPriceQty(
      row({ status: "FILLED", executedPrice: "112", executedQuantity: 10 }),
    );
    expect(out).toEqual({ price: 112, qty: 10 });
  });

  it("counts a PARTIAL close by its executed fill", () => {
    const out = resolveEventPriceQty(
      row({ status: "PARTIAL", executedPrice: "111", executedQuantity: 6 }),
    );
    expect(out).toEqual({ price: 111, qty: 6 });
  });

  it("skips a FILLED row with a missing or zero executed value (honest exclusion)", () => {
    expect(
      resolveEventPriceQty(row({ status: "FILLED", executedPrice: null, executedQuantity: 10 })),
    ).toBeNull();
    expect(
      resolveEventPriceQty(row({ status: "FILLED", executedPrice: "112", executedQuantity: 0 })),
    ).toBeNull();
  });

  it("rejects PostgreSQL special numeric values before they can become FIFO events", () => {
    expect(
      resolveEventPriceQty(
        row({ status: "FILLED", executedPrice: "Infinity", executedQuantity: 10 }),
      ),
    ).toBeNull();
    expect(
      resolveEventPriceQty(
        row({ status: "FILLED", executedPrice: "NaN", executedQuantity: 10 }),
      ),
    ).toBeNull();
    expect(
      resolveEventPriceQty(
        row({ status: "PARTIAL", executedPrice: "112", executedQuantity: Number.POSITIVE_INFINITY }),
      ),
    ).toBeNull();
  });

  it("rejects coercive numeric prefixes before they can become FIFO events", () => {
    expect(
      resolveEventPriceQty(
        row({ status: "FILLED", executedPrice: "100junk", executedQuantity: 10 }),
      ),
    ).toBeNull();
    expect(
      resolveEventPriceQty(
        row({ status: "FILLED", executedPrice: "0x64", executedQuantity: 10 }),
      ),
    ).toBeNull();
  });

  it("bounds finite non-PERP values before Number.MAX_VALUE can enter P&L", () => {
    expect(
      resolveEventPriceQty(
        row({ status: "FILLED", executedPrice: Number.MAX_VALUE, executedQuantity: 1 }),
      ),
    ).toBeNull();
    expect(
      resolveEventPriceQty(
        row({ status: "FILLED", executedPrice: 100, executedQuantity: Number.MAX_VALUE }),
      ),
    ).toBeNull();

    expect(
      reconstructRealizedPnl([
        {
          side: "buy",
          direction: "long",
          qty: Number.MAX_VALUE,
          price: 100,
          multiplier: 1,
          at: "2026-06-01T00:00:00.000Z",
        },
        {
          side: "sell",
          direction: "long",
          qty: Number.MAX_VALUE,
          price: 101,
          multiplier: 1,
          at: "2026-06-02T00:00:00.000Z",
        },
      ]),
    ).toEqual(expect.objectContaining({ realizedPnl: 0, closedTrades: 0 }));
  });

  it("does NOT count a SUBMITTED open (opens require a real fill too)", () => {
    const out = resolveEventPriceQty(
      row({ tradeAction: "Buy", status: "SUBMITTED", executedPrice: null, executedQuantity: null }),
    );
    expect(out).toBeNull();
  });
});

describe("UserLeaderboardAccumulator: realized closes require a real fill (Codex P2)", () => {
  function row(over: Partial<SocialOrderRow>): SocialOrderRow {
    return {
      userId: "u1",
      brokerOrderId: "bo-open",
      orderId: "ord-open",
      brokerAccountId: "test-account",
      brokerCredentialId: "test-credential",
      venue: "alpaca",
      symbol: "AAPL",
      assetType: "EQUITY",
      tradeAction: "Buy",
      direction: "long",
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      executedPrice: "100",
      executedQuantity: 10,
      status: "FILLED",
      createdAt: "2026-05-01T00:00:00.000Z",
      ...over,
    };
  }

  it("does NOT count a SUBMITTED (accepted-but-unfilled) close as a closed lot", () => {
    // The close was only ACCEPTED by the broker (SUBMITTED, no executed
    // price/qty) and may never fill. Counting it would fabricate a realized
    // win/loss. The long lot stays open and the user drops out entirely
    // (finalize skips tradeCount 0). Contrast the FILLED case below.
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({}), // filled long open @100 x10
        row({
          brokerOrderId: "bo-close",
          orderId: "ord-close",
          tradeAction: "Sell",
          status: "SUBMITTED",
          executedPrice: null,
          executedQuantity: null,
          createdAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );
    expect(accumulator.finalize().get("u1")).toBeUndefined();
  });

  it("counts a FILLED close (real fill) and closes the FIFO lot", () => {
    // Once order-sync reconciles the fill the close carries executed price/qty
    // and is counted, closing the open long lot.
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({}), // filled long open @100 x10
        row({
          brokerOrderId: "bo-close",
          orderId: "ord-close",
          tradeAction: "Sell",
          status: "FILLED",
          executedPrice: "110",
          executedQuantity: 10,
          createdAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toEqual({
      realizedPnl: 100, // (110 - 100) * 10
      alpacaPnl: 100,
      hyperliquidPnl: 0,
      winRate: 1,
      tradeCount: 1,
      lastTradeAt: "2026-06-05T00:00:00.000Z",
    });
  });

  it("counts a PARTIAL close (real fill) and closes the matched quantity", () => {
    // A PARTIAL close carries a real (partial) fill: match 6 of the 10 open
    // shares into one closed lot; the remaining 4 stay open (not counted).
    const accumulator = new UserLeaderboardAccumulator(null);
    accumulator.ingest(
      [
        row({}), // filled long open @100 x10
        row({
          brokerOrderId: "bo-close",
          orderId: "ord-close",
          tradeAction: "Sell",
          status: "PARTIAL",
          executedPrice: "110",
          executedQuantity: 6,
          createdAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
      tradeActionSide,
    );

    expect(accumulator.finalize().get("u1")).toEqual({
      realizedPnl: 60, // (110 - 100) * 6
      alpacaPnl: 60,
      hyperliquidPnl: 0,
      winRate: 1,
      tradeCount: 1,
      lastTradeAt: "2026-06-05T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// computeLeaderboardMeta: ranking meta flag semantics (Codex P2 / reviewer #7)
//
// rankingFallback must be true only when no provider returned usable data for
// the response. It must NOT be set just because some rows are missing market
// data - that condition is partialMarketData.
// ---------------------------------------------------------------------------
describe("computeLeaderboardMeta", () => {
  it("degraded path (no master creds) sets rankingFallback=true, partialMarketData=false", () => {
    const meta = computeLeaderboardMeta({
      hasMaster: false,
      anyRowNeedsMarketData: true,
      signalsWithinCap: true,
    });
    expect(meta.rankingFallback).toBe(true);
    expect(meta.partialMarketData).toBe(false);
    expect(meta.dataComplete).toBe(false);
  });

  it("full path with all market data: rankingFallback=false, partialMarketData=false", () => {
    const meta = computeLeaderboardMeta({
      hasMaster: true,
      anyRowNeedsMarketData: false,
      signalsWithinCap: true,
    });
    expect(meta.rankingFallback).toBe(false);
    expect(meta.partialMarketData).toBe(false);
    expect(meta.dataComplete).toBe(true);
  });

  it("full path with SOME missing market data: rankingFallback=false, partialMarketData=true", () => {
    // When only some symbols are missing bars the response still uses return-based
    // ranking over the measured calls. rankingFallback must stay false; only
    // partialMarketData signals the incomplete coverage to the UI.
    const meta = computeLeaderboardMeta({
      hasMaster: true,
      anyRowNeedsMarketData: true,
      signalsWithinCap: true,
    });
    expect(meta.rankingFallback).toBe(false);
    expect(meta.partialMarketData).toBe(true);
    expect(meta.dataComplete).toBe(false);
  });

  it("keeps a perp-only response measurable without Alpaca credentials", () => {
    const meta = computeLeaderboardMeta({
      hasMaster: false,
      hasAnyMarketData: true,
      anyRowNeedsMarketData: false,
      signalsWithinCap: true,
    });

    expect(meta).toEqual({
      rankingFallback: false,
      partialMarketData: false,
      dataComplete: true,
    });
  });

  it("scan cap exceeded sets dataComplete=false regardless of ranking mode", () => {
    const degraded = computeLeaderboardMeta({
      hasMaster: false,
      anyRowNeedsMarketData: false,
      signalsWithinCap: false,
    });
    expect(degraded.dataComplete).toBe(false);

    const full = computeLeaderboardMeta({
      hasMaster: true,
      anyRowNeedsMarketData: false,
      signalsWithinCap: false,
    });
    expect(full.dataComplete).toBe(false);
  });

  it("scan cap exceeded on the full path preserves the other flags correctly", () => {
    const meta = computeLeaderboardMeta({
      hasMaster: true,
      anyRowNeedsMarketData: true,
      signalsWithinCap: false,
    });
    expect(meta.rankingFallback).toBe(false);
    expect(meta.partialMarketData).toBe(true);
    expect(meta.dataComplete).toBe(false);
  });

  it("distinguishes no market candidates from zero or mixed usable markets", () => {
    expect(
      computeLeaderboardMeta({
        hasMaster: true,
        hasAnyMarketData: false,
        hasMarketCandidates: false,
        marketDataComplete: true,
        anyRowNeedsMarketData: false,
        signalsWithinCap: true,
      }),
    ).toEqual({
      rankingFallback: false,
      partialMarketData: false,
      dataComplete: true,
    });

    expect(
      computeLeaderboardMeta({
        hasMaster: true,
        hasAnyMarketData: false,
        hasMarketCandidates: true,
        marketDataComplete: false,
        anyRowNeedsMarketData: true,
        unresolvedMarketCandidateCount: 1,
        signalsWithinCap: true,
      }),
    ).toEqual({
      rankingFallback: true,
      partialMarketData: false,
      dataComplete: false,
    });

    expect(
      computeLeaderboardMeta({
        hasMaster: true,
        hasAnyMarketData: true,
        hasMarketCandidates: true,
        marketDataComplete: false,
        anyRowNeedsMarketData: true,
        unresolvedMarketCandidateCount: 1,
        signalsWithinCap: true,
      }),
    ).toEqual({
      rankingFallback: false,
      partialMarketData: true,
      dataComplete: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Plan A11: the pinned "you" row.
//
// The users board is anonymized (`anonymizeTrader`), so a signed-in user cannot
// find themselves by name. `resolveSelfStanding` is the lookup that makes the
// pinned row possible, and the case that matters most is the honest one: a
// missing row means "no shared trades", NOT rank 0, and it must be
// distinguishable from "ranked below the retained cap".
// ---------------------------------------------------------------------------
describe("resolveSelfStanding", () => {
  function rankedRow(key: string): UserLeaderboardRow {
    return {
      followTarget: { type: "user", key, label: `Trader${key}` },
      displayName: `Trader${key}`,
      avatar: "",
      realizedPnl: 0,
      winRate: 0,
      tradeCount: 0,
      lastTradeAt: null,
    };
  }

  it("returns a 1-based rank for a caller on the board", () => {
    const ranked = [rankedRow("aaa"), rankedRow("bbb"), rankedRow("ccc")];
    const self = resolveSelfStanding(ranked, "bbb", ranked.length);
    expect(self.rank).toBe(2);
    expect(self.row?.followTarget.key).toBe("bbb");
    expect(self.belowRankCap).toBe(false);
  });

  it("ranks the leader 1, never 0", () => {
    const ranked = [rankedRow("aaa"), rankedRow("bbb")];
    expect(resolveSelfStanding(ranked, "aaa", 2).rank).toBe(1);
  });

  it("reports 'not ranked' (not 'below the cap') when the board was NOT truncated", () => {
    const ranked = [rankedRow("aaa"), rankedRow("bbb")];
    const self = resolveSelfStanding(ranked, "zzz", ranked.length);
    expect(self.row).toBeNull();
    expect(self.rank).toBeNull();
    // No shared trades in this window, which is a different sentence from
    // "you are ranked, just deep" - the UI renders each differently.
    expect(self.belowRankCap).toBe(false);
  });

  it("reports 'below the cap' only for a caller who is actually ranked", () => {
    const ranked = [rankedRow("aaa"), rankedRow("bbb")];
    const self = resolveSelfStanding(ranked, "zzz", 900, 500, true);
    expect(self.row).toBeNull();
    expect(self.rank).toBeNull();
    expect(self.belowRankCap).toBe(true);
  });

  it("does NOT claim 'below the cap' for a caller with no ranked trades", () => {
    // Truncation is a fact about the BOARD, not about this user. Inferring one
    // from the other told everyone with no shared trades that they were ranked
    // outside the top N, which is a different and wrong statement.
    const ranked = [rankedRow("aaa"), rankedRow("bbb")];
    const self = resolveSelfStanding(ranked, "zzz", 900, 500, false);
    expect(self.row).toBeNull();
    expect(self.rank).toBeNull();
    expect(self.belowRankCap).toBe(false);
  });

  it("never claims 'below the cap' when the board was not truncated", () => {
    const ranked = [rankedRow("aaa"), rankedRow("bbb")];
    const self = resolveSelfStanding(ranked, "zzz", 2, 500, true);
    expect(self.belowRankCap).toBe(false);
  });

  it("handles an empty board", () => {
    const self = resolveSelfStanding([], "zzz", 0);
    expect(self.row).toBeNull();
    expect(self.belowRankCap).toBe(false);
  });

  it("keeps the lookup cap at or above the max page size so one cached array serves both", () => {
    // limitSchema maxes out at 100; the cap has to cover a full page or the
    // page slice would read past the cached array.
    expect(USER_RANK_LOOKUP_CAP).toBeGreaterThanOrEqual(100);
  });
});

describe("resolveSelfMembership: truncation is not an answer", () => {
  it("a caller in the key prefix is ranked", () => {
    expect(resolveSelfMembership(["a", "b"], 2, "a", 5)).toBe(true);
  });

  it("absence is conclusive only when the prefix covered the whole board", () => {
    // rankedTotal <= cap, so the key set is complete and "not in it" is real.
    expect(resolveSelfMembership(["a", "b"], 2, "z", 5)).toBe(false);
  });

  it("absence past the cap is UNKNOWN, not 'no trades'", () => {
    // The bug. The key set is capped, so on a bigger board a caller who is not
    // in the prefix might be ranked deep or might not be ranked at all, and
    // answering "no" told users with real shared trades that they had none.
    expect(resolveSelfMembership(["a", "b"], 9_000, "z", 2)).toBeNull();
  });

  it("standingUnknown rides through to the caller's standing", () => {
    const self = resolveSelfStanding([], "zzz", 9_000, 500, null);
    expect(self.standingUnknown).toBe(true);
    // And it must NOT be reported as ranked-below-cap either, which would be a
    // different unsupported claim.
    expect(self.belowRankCap).toBe(false);
    expect(self.row).toBeNull();
  });

  it("a known-unranked caller is still reported as unranked", () => {
    const self = resolveSelfStanding([], "zzz", 2, 500, false);
    expect(self.standingUnknown).toBe(false);
    expect(self.belowRankCap).toBe(false);
  });
});
