import { describe, expect, it } from "bun:test";
import {
  describeDeferredCloseStaging,
  createdAtIdAfter,
  createdAtIdAtOrBefore,
  externalMirrorFillCondition,
  findMirrorCandidateSources,
  mirrorSourceStagingCondition,
  mirroredPerpOrderSide,
  parseOptionStrike,
  resolveMirrorSourceQuantity,
  resolveUserTradeAction,
} from "../copy-mirror-candidate-sources";
import { isSupportedAlpacaMirrorAction } from "../../../../api/src/lib/trade-action";
import { traderKey } from "../../../../api/src/lib/trader-identity";
import { schema } from "@trade-bot/db";
import { createPagedMirrorDb } from "./helpers/paged-mirror-db";
import { PgDialect } from "drizzle-orm/pg-core";

function mirrorFollow(
  targetType: "user" | "x_author",
  targetKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `follow-${targetType}-${targetKey}`,
    followerUserId: "follower-1",
    targetType,
    targetKey,
    targetLabel: "Followed source",
    sizingMode: "usd",
    sizingValue: "100",
    autoMirror: true,
    credentialId: "00000000-0000-4000-8000-000000000001",
    destinationPolicyInitialized: true,
    stockAutoMirror: true,
    stockCredentialId: "00000000-0000-4000-8000-000000000001",
    stockSizingMode: "usd",
    stockSizingValue: "100",
    perpAutoMirror: true,
    perpCredentialId: "00000000-0000-4000-8000-000000000001",
    perpSizingMode: "usd",
    perpSizingValue: "100",
    ...overrides,
  } as never;
}

/**
 * Small policy-aware source DB used by the leverage snapshot tests below.
 * Unlike the shared paging fixture, this one exposes the joined follow/user
 * projection that candidate discovery must read before mapping either source
 * kind.
 */
function createPolicySnapshotDb(options: {
  socialRows?: readonly Record<string, unknown>[];
  signalRows?: readonly Record<string, unknown>[];
  policyRows: readonly Record<string, unknown>[];
  windowStart: Date;
  windowEnd: Date;
}) {
  let selected: "signals" | "social" | "policy" | "aliases" | "identities" = "signals";
  let selectedProjection: Record<string, unknown> | undefined;
  let policyProjectionKeys: string[] = [];
  const signalRows = [...(options.signalRows ?? [])];
  const socialRows = [...(options.socialRows ?? [])];
  const policyRows = [...options.policyRows];
  const aliasRows: readonly Record<string, unknown>[] = [];
  const bounded = (rows: readonly Record<string, unknown>[]) => rows
    .filter((row) => row.createdAt instanceof Date &&
      row.createdAt > options.windowStart && row.createdAt <= options.windowEnd)
    .sort((left, right) =>
      (left.createdAt as Date).getTime() - (right.createdAt as Date).getTime() ||
      String(left.id).localeCompare(String(right.id)));
  const newest = (rows: readonly Record<string, unknown>[]) => [...rows]
    .filter((row) => row.createdAt instanceof Date)
    .sort((left, right) =>
      (right.createdAt as Date).getTime() - (left.createdAt as Date).getTime() ||
      String(right.id).localeCompare(String(left.id)))
    .slice(0, 1);

  const query: any = {
    from(table: unknown) {
      if (table === schema.signals) selected = "signals";
      else if (table === schema.copyTradeFollows) {
        selected = "policy";
        policyProjectionKeys = Object.keys(selectedProjection ?? {});
      }
      else if (table === schema.sourceAuthorAliases) selected = "aliases";
      else if (table === schema.sourceAuthorIdentities) selected = "identities";
      else selected = "social";
      return query;
    },
    innerJoin() {
      return query;
    },
    where() {
      return query;
    },
    orderBy() {
      return query;
    },
    limit(limit: number) {
      if (selected === "policy") return Promise.resolve(policyRows.slice(0, limit));
      if (selected === "aliases") return Promise.resolve(aliasRows.slice(0, limit));
      if (selected === "identities") return Promise.resolve([]);
      const rows = selected === "signals" ? signalRows : socialRows;
      return Promise.resolve(limit === 1 ? newest(rows) : bounded(rows).slice(0, limit));
    },
  };

  return {
    db: {
      select: (projection?: Record<string, unknown>) => {
        selectedProjection = projection;
        selected = "signals";
        return query;
      },
      query: {
        sourceAuthorAliases: {},
        sourceAuthorIdentities: {},
      },
      get policyProjectionKeys() {
        return policyProjectionKeys;
      },
    } as any,
  };
}


const mirrorWindowStart = new Date("2026-08-21T00:00:00.000Z");
const mirrorWindowEnd = new Date("2026-08-21T02:00:00.000Z");

/**
 * Discovery stages a reduce-only perp close whether or not the perps gate is
 * open, and that is deliberate: nothing recreates a source close, so dropping
 * one at discovery leaves the follower holding a mirrored position with no exit.
 * Preflight then defers it until the configuration lets it through.
 *
 * The problem was that the staging half said NOTHING. The "unsupported-user-perp"
 * skip line never fires for a close, so switching perps off silently began a
 * queue: no line at the moment it started, and nothing counting it afterwards.
 */
describe("staging a perp close while the perps gate is shut", () => {
  it("names the moment a close is queued behind a shut gate", () => {
    const line = describeDeferredCloseStaging({ perpsGateOpen: false, reduceOnly: true });

    expect(line).not.toBeNull();
    // Loud enough to be found during an incident: this is the entry point of a
    // queue that will otherwise retry every fifteen minutes indefinitely.
    expect(line!.level).toBe("warn");
    // The line has to answer the question an operator will actually ask, which
    // is whether the exit was thrown away.
    expect(line!.message).toContain("deferred, not dropped");
  });

  it("says nothing while the gate is open", () => {
    // The normal case. A close mirrors straight through, so there is no queue
    // and nothing to announce.
    expect(describeDeferredCloseStaging({ perpsGateOpen: true, reduceOnly: true })).toBeNull();
  });

  it("says nothing about an OPEN, which the shut gate legitimately drops", () => {
    // Withholding new exposure is the whole point of the gate. Only the close,
    // which is staged anyway and then held, produces a queue worth reporting.
    expect(describeDeferredCloseStaging({ perpsGateOpen: false, reduceOnly: false })).toBeNull();
    expect(describeDeferredCloseStaging({ perpsGateOpen: true, reduceOnly: false })).toBeNull();
  });
});

describe("user trade action resolution", () => {
  it("uses the action side across native and external reduce-only closes", () => {
    // Native rows already store execution direction.
    expect(mirroredPerpOrderSide("short", true, "Sell")).toBe("short");
    expect(mirroredPerpOrderSide("long", true, "Buy")).toBe("long");
    // External rows store the position direction, but their action still says
    // whether the fill bought or sold.
    expect(mirroredPerpOrderSide("long", true, "SellToClose", true)).toBe("short");
    expect(mirroredPerpOrderSide("short", true, "BuyToCover", true)).toBe("long");
    expect(mirroredPerpOrderSide("long", false)).toBe("long");
    expect(mirroredPerpOrderSide("short", false)).toBe("short");
  });

  it("preserves equity and option position intent instead of deriving it from lossy side", () => {
    const cases = [
      { assetType: "EQUITY", tradeAction: "Buy", direction: "long", side: "sell", expected: ["Buy", "buy", "long"] },
      { assetType: "EQUITY", tradeAction: "Sell", direction: "long", side: "buy", expected: ["Sell", "sell", "long"] },
      { assetType: "EQUITY", tradeAction: "SellShort", direction: "short", side: "buy", expected: ["SellShort", "sell", "short"] },
      { assetType: "EQUITY", tradeAction: "BuyToCover", direction: "short", side: "sell", expected: ["BuyToCover", "buy", "short"] },
      { assetType: "OPTION", tradeAction: "BuyToOpen", direction: "long", side: "sell", expected: ["BuyToOpen", "buy", "long"] },
      { assetType: "OPTION", tradeAction: "SellToClose", direction: "long", side: "buy", expected: ["SellToClose", "sell", "long"] },
      { assetType: "OPTION", tradeAction: "SellToOpen", direction: "short", side: "buy", expected: ["SellToOpen", "sell", "short"] },
      { assetType: "OPTION", tradeAction: "BuyToClose", direction: "short", side: "sell", expected: ["BuyToClose", "buy", "short"] },
    ] as const;

    for (const testCase of cases) {
      expect(resolveUserTradeAction(testCase)).toEqual({
        tradeAction: testCase.expected[0],
        side: testCase.expected[1],
        direction: testCase.expected[2],
      });
    }
  });

  it("converts ordinary short actions using the authoritative order direction", () => {
    expect(resolveUserTradeAction({
      assetType: "EQUITY",
      tradeAction: "Sell",
      direction: "short",
      side: "sell",
    })).toEqual({ tradeAction: "SellShort", side: "sell", direction: "short" });
    expect(resolveUserTradeAction({
      assetType: "EQUITY",
      tradeAction: "Buy",
      direction: "short",
      side: "buy",
    })).toEqual({ tradeAction: "BuyToCover", side: "buy", direction: "short" });
  });

  it("rejects coercive option strike prefixes at the worker boundary", () => {
    expect(parseOptionStrike("250.00")).toBe(250);
    expect(parseOptionStrike("250junk")).toBeNull();
    expect(parseOptionStrike("0xFA")).toBeNull();
    expect(parseOptionStrike("Infinity")).toBeNull();
  });

  it("fails closed when an explicit action conflicts with the authoritative direction", () => {
    expect(resolveUserTradeAction({
      assetType: "EQUITY",
      tradeAction: "SellShort",
      direction: "long",
      side: "sell",
    })).toBeNull();
  });

  it("supports only intent-preserving Alpaca mirrors and skips unsupported actions", () => {
    expect(isSupportedAlpacaMirrorAction("EQUITY", "Buy")).toBe(true);
    expect(isSupportedAlpacaMirrorAction("EQUITY", "Sell")).toBe(true);
    expect(isSupportedAlpacaMirrorAction("EQUITY", "SellShort")).toBe(false);
    expect(isSupportedAlpacaMirrorAction("EQUITY", "BuyToCover")).toBe(false);
    expect(isSupportedAlpacaMirrorAction("OPTION", "BuyToOpen")).toBe(true);
    expect(isSupportedAlpacaMirrorAction("OPTION", "SellToClose")).toBe(true);
    expect(isSupportedAlpacaMirrorAction("OPTION", "SellToOpen")).toBe(false);
    expect(isSupportedAlpacaMirrorAction("OPTION", "BuyToClose")).toBe(false);
  });
});

describe("mirror source quantity", () => {
  it("keeps a fractional executed fill for ratio sizing", () => {
    expect(resolveMirrorSourceQuantity({
      executedQuantity: 0.5,
      orderQuantity: 1,
      socialQuantity: 1,
    })).toBe(0.5);
  });

  it("falls back to the compatibility quantity only when no executed fill exists", () => {
    expect(resolveMirrorSourceQuantity({
      executedQuantity: null,
      orderQuantity: 3,
      socialQuantity: 1,
    })).toBe(3);
  });
});

describe("external mirror fill status policy", () => {
  it("mirrors a positively filled REJECTED row while retaining fill safety guards", () => {
    const query = new PgDialect().sqlToQuery(externalMirrorFillCondition(schema.orders));

    expect(query.params).toContain("REJECTED");
    expect(query.params).toContain("0");
    expect(query.sql).toContain("executed_price");
  });

  it("applies the leaderboard safe bound to prices and quantities", () => {
    const query = new PgDialect().sqlToQuery(externalMirrorFillCondition(schema.orders));

    expect(query.params).toContain("9007199254740991");
  });
});

describe("bounded copy-mirror source discovery", () => {
  it("uses independent stock and perp credentials and sizing for one followed source", async () => {
    const previousPerpsFlag = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      const sourceAt = new Date("2026-08-21T01:00:00.000Z");
      const fake = createPagedMirrorDb({
        signalRows: [
          {
            id: "independent-stock",
            source: "x",
            symbol: "AAPL",
            content: "$AAPL bullish buy",
            metadata: {
              authorSource: "x",
              sourceAuthorId: "leader",
              canonicalAuthorKey: "source_author:x:leader",
              authorName: "Leader",
            },
            timestamp: sourceAt,
            createdAt: sourceAt,
          },
          {
            id: "independent-perp",
            source: "x",
            symbol: "BTC",
            content: "BTC long perp",
            metadata: {
              authorSource: "x",
              sourceAuthorId: "leader",
              canonicalAuthorKey: "source_author:x:leader",
              authorName: "Leader",
              platform: "hyperliquid",
              instrument: "perp",
              direction: "long",
              hlTicker: "BTC",
              leverage: 3,
            },
            timestamp: sourceAt,
            createdAt: new Date(sourceAt.getTime() + 1),
          },
        ],
        windowStart: mirrorWindowStart,
        windowEnd: mirrorWindowEnd,
      });
      const candidates = await findMirrorCandidateSources(
        fake.db,
        [mirrorFollow("x_author", "source_author:x:leader", {
          autoMirror: false,
          credentialId: null,
          stockAutoMirror: true,
          stockCredentialId: "stock-account",
          stockSizingMode: "usd",
          stockSizingValue: "125.00",
          perpAutoMirror: true,
          perpCredentialId: "perp-account",
          perpSizingMode: "ratio",
          perpSizingValue: "2.00",
        })],
        mirrorWindowStart,
        mirrorWindowEnd,
      );

      expect(candidates.map((candidate) => [
        candidate.assetType,
        candidate.credentialId,
        candidate.sizingMode,
        candidate.sizingValue,
      ])).toEqual([
        ["EQUITY", "stock-account", "usd", 125],
        ["PERP", "perp-account", "ratio", 2],
      ]);
    } finally {
      if (previousPerpsFlag === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previousPerpsFlag;
    }
  });

  it("does not stage a direct-execution-managed Discord signal for generic mirroring", async () => {
    const canonicalKey = "source_author:discord:caller-1";
    const fake = createPagedMirrorDb({
      signalRows: [{
        id: "discord-direct-signal",
        source: "discord",
        symbol: "GOOGL",
        content: "Market long GOOGL here at CMP. Close under 190 for stops.",
        metadata: {
          authorSource: "discord",
          sourceAuthorId: "caller-1",
          canonicalAuthorKey: canonicalKey,
          authorName: "Caller",
          directExecutionManaged: true,
        },
        timestamp: new Date("2026-08-21T01:00:00.000Z"),
        createdAt: new Date("2026-08-21T01:00:00.000Z"),
      }],
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("x_author", canonicalKey)],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    expect(candidates).toEqual([]);
  });

  it("uses the same millisecond-normalized timestamp and id key in worker SQL", () => {
    const predicate = createdAtIdAfter(
      { createdAt: new Date("2026-08-21T01:00:00.123Z"), id: "source-100" },
      schema.signals.createdAt,
      schema.signals.id,
    );
    const query = new PgDialect().sqlToQuery(predicate as never);

    expect(query.sql).toContain("date_trunc('milliseconds'");
    expect(query.sql).toContain('"signals"."created_at"');
    expect(query.sql).toContain('"signals"."id"');
  });

  it("bounds every source page by the complete normalized timestamp and id fence", () => {
    const predicate = createdAtIdAtOrBefore(
      { createdAt: new Date("2026-08-21T01:00:00.123Z"), id: "source-100" },
      schema.signals.createdAt,
      schema.signals.id,
    );
    const query = new PgDialect().sqlToQuery(predicate as never);

    expect(query.sql).toContain("date_trunc('milliseconds'");
    expect(query.sql).toContain('"signals"."created_at"');
    expect(query.sql).toContain('"signals"."id"');
    expect(query.sql).toContain("<=");
  });

  it("exhausts a multi-page X window before returning candidates and excludes future rows", async () => {
    const canonicalKey = "source_author:x:leader";
    const sameMillisecond = new Date(mirrorWindowStart.getTime() + 123);
    const signalRows = Array.from({ length: 5_001 }, (_, index) => ({
      id: `signal-${String(index + 1).padStart(5, "0")}`,
      source: "x",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      metadata: {
        authorSource: "x",
        sourceAuthorId: "leader",
        canonicalAuthorKey: canonicalKey,
        authorName: "Leader",
      },
      timestamp: sameMillisecond,
      createdAt: sameMillisecond,
    }));
    signalRows.push({
      id: "future-signal",
      source: "x",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      metadata: {
        authorSource: "x",
        sourceAuthorId: "leader",
        canonicalAuthorKey: canonicalKey,
        authorName: "Leader",
      },
      timestamp: mirrorWindowEnd,
      createdAt: new Date(mirrorWindowEnd.getTime() + 1),
    });
    const fake = createPagedMirrorDb({
      signalRows,
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("x_author", canonicalKey)],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    expect(candidates).toHaveLength(5_001);
    expect(candidates.some((candidate) => candidate.sourceItemId === "x_signal:future-signal")).toBe(false);
    expect(candidates.some((candidate) => candidate.sourceItemId === "x_signal:signal-05001")).toBe(true);
    expect(fake.signalLimitCalls.length).toBeGreaterThan(1);
    expect(fake.signalLimitCalls.every((limit) => limit <= 5_000)).toBe(true);
    expect(fake.orderByCalls).toBeGreaterThan(0);
  }, { timeout: 30_000 });

  it("resolves a source-qualified alias by its parsed (source, alias) pair and fails closed for two owners", async () => {
    const signal = {
      id: "signal-shared",
      source: "x",
      symbol: "AAPL",
      content: "$AAPL bullish buy",
      metadata: { authorSource: "x", authorName: "Shared" },
      timestamp: new Date("2026-08-21T01:00:00.000Z"),
      createdAt: new Date("2026-08-21T01:00:00.000Z"),
    };
    const fake = createPagedMirrorDb({
      signalRows: [signal],
      aliasRows: [
        { source: "x", alias: "shared", canonicalKey: "source_author:x:one" },
        { source: "x", alias: "shared", canonicalKey: "source_author:x:two" },
      ],
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("x_author", "source_alias:x:shared")],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    expect(candidates).toEqual([]);
  });

  it("accepts the same source-qualified alias when exactly one owner exists", async () => {
    const signal = {
      id: "signal-owned",
      source: "x",
      symbol: "MSFT",
      content: "$MSFT bullish buy",
      metadata: { authorSource: "x", authorName: "Shared" },
      timestamp: new Date("2026-08-21T01:00:00.000Z"),
      createdAt: new Date("2026-08-21T01:00:00.000Z"),
    };
    const fake = createPagedMirrorDb({
      signalRows: [signal],
      aliasRows: [
        { source: "x", alias: "shared", canonicalKey: "source_author:x:one" },
      ],
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("x_author", "source_alias:x:shared")],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceItemId).toBe("x_signal:signal-owned");
  });

  it("resolves an alias-only signal for a canonical follow through durable ownership", async () => {
    const canonicalKey = "source_author:x:leader";
    const signal = {
      id: "signal-historical-alias",
      source: "x",
      symbol: "NVDA",
      content: "$NVDA bullish buy",
      metadata: { authorSource: "x", authorName: "Former Handle" },
      timestamp: new Date("2026-08-21T01:00:00.000Z"),
      createdAt: new Date("2026-08-21T01:00:00.000Z"),
    };
    const fake = createPagedMirrorDb({
      signalRows: [signal],
      aliasRows: [
        { source: "x", alias: "former handle", canonicalKey },
      ],
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("x_author", canonicalKey)],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceItemId).toBe("x_signal:signal-historical-alias");
  });

  it("keeps the perp fill gate while allowing accepted equity rows to reach execution-time gating", () => {
    const query = new PgDialect().sqlToQuery(mirrorSourceStagingCondition(schema.orders));

    // The condition is a branch: only PERP rows carry the terminal-status and
    // positive-fill predicates. Equity/option rows are admitted by asset type
    // plus option-contract validation, then processCandidate re-reads status.
    expect(query.params).toContain("PERP");
    expect(query.params).toContain("FILLED");
    expect(query.sql).toContain('"orders"."asset_type"');
  });

  it("keeps X option lifecycle candidates bound to the immutable author", async () => {
    const authorA = "source_author:x:author-a";
    const authorB = "source_author:x:author-b";
    const base = new Date("2026-08-21T01:00:00.000Z");
    const signal = (id: string, sourceAuthorId: string, content: string, offset: number) => ({
      id,
      source: "x",
      sourceAuthorId,
      symbol: "AAPL",
      content,
      metadata: {
        authorSource: "x",
        sourceAuthorId,
        canonicalAuthorKey: `source_author:x:${sourceAuthorId}`,
        authorName: sourceAuthorId,
      },
      timestamp: new Date(base.getTime() + offset),
      createdAt: new Date(base.getTime() + offset),
    });
    const fake = createPagedMirrorDb({
      signalRows: [
        signal("a-bto", "author-a", "BTO $AAPL 250C 9/18/2026", 1),
        signal("a-stc-partial", "author-a", "STC $AAPL 250C 9/18/2026 partial", 2),
        signal("a-stc-full", "author-a", "STC $AAPL 250C 9/18/2026 final", 3),
        signal("a-reentry", "author-a", "BTO $AAPL 250C 9/18/2026 re-entry", 4),
        signal("b-bto", "author-b", "BTO $AAPL 250C 9/18/2026", 5),
      ],
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("x_author", authorA), mirrorFollow("x_author", authorB)],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    const lifecycle = candidates
      .filter((candidate) => candidate.followerUserId === "follower-1")
      .sort((left, right) => left.sourceEventAt!.localeCompare(right.sourceEventAt!));
    expect(lifecycle).toHaveLength(5);
    expect(lifecycle.filter((candidate) => candidate.sourceAuthorKey === authorA)
      .map((candidate) => [candidate.sourceItemId, candidate.tradeAction]))
      .toEqual([
        ["x_signal:a-bto", "BuyToOpen"],
        ["x_signal:a-stc-partial", "SellToClose"],
        ["x_signal:a-stc-full", "SellToClose"],
        ["x_signal:a-reentry", "BuyToOpen"],
      ]);
    expect(lifecycle.filter((candidate) => candidate.sourceAuthorKey === authorB)
      .map((candidate) => candidate.sourceItemId))
      .toEqual(["x_signal:b-bto"]);
  });

  it("pages a large social-trade backlog with a SQL-bounded future cutoff", async () => {
    const sourceUserId = "social-source";
    const socialRows = Array.from({ length: 1_001 }, (_, index) => ({
      id: `trade-${String(index + 1).padStart(4, "0")}`,
      userId: sourceUserId,
      symbol: "AAPL",
      side: "buy",
      assetType: "EQUITY",
      orderId: `order-${index + 1}`,
      orderUserId: sourceUserId,
      orderSymbol: "AAPL",
      orderAssetType: "EQUITY",
      tradeAction: "Buy",
      orderDirection: "long",
      createdAt: new Date(mirrorWindowStart.getTime() + (index + 1) * 10),
    }));
    socialRows.push({
      id: "future-trade",
      userId: sourceUserId,
      symbol: "MSFT",
      side: "buy",
      assetType: "EQUITY",
      orderId: "future-order",
      orderUserId: sourceUserId,
      orderSymbol: "MSFT",
      orderAssetType: "EQUITY",
      tradeAction: "Buy",
      orderDirection: "long",
      createdAt: new Date(mirrorWindowEnd.getTime() + 1),
    });
    const fake = createPagedMirrorDb({
      socialRows,
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });

    const candidates = await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("user", traderKey(sourceUserId))],
      mirrorWindowStart,
      mirrorWindowEnd,
    );

    expect(candidates).toHaveLength(1_001);
    expect(candidates.some((candidate) => candidate.sourceItemId === "user:future-trade")).toBe(false);
    expect(candidates.some((candidate) => candidate.sourceItemId === "user:trade-1001")).toBe(true);
    expect(fake.socialLimitCalls.length).toBeGreaterThan(1);
    expect(fake.socialLimitCalls.every((limit) => limit <= 5_000)).toBe(true);
    expect(fake.orderByCalls).toBeGreaterThan(0);
  }, { timeout: 30_000 });

  it("streams more than one social page when every row shares one millisecond key", async () => {
    const sourceUserId = "social-source-same-ms";
    const sameMillisecond = new Date(mirrorWindowStart.getTime() + 123);
    const socialRows = Array.from({ length: 1_001 }, (_, index) => ({
      id: `same-ms-trade-${String(index + 1).padStart(4, "0")}`,
      userId: sourceUserId,
      symbol: "AAPL",
      side: "buy",
      assetType: "EQUITY",
      orderId: `same-ms-order-${index + 1}`,
      orderUserId: sourceUserId,
      orderSymbol: "AAPL",
      orderAssetType: "EQUITY",
      tradeAction: "Buy",
      orderDirection: "long",
      createdAt: sameMillisecond,
    }));
    const fake = createPagedMirrorDb({
      socialRows,
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });
    const staged: unknown[] = [];

    await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("user", traderKey(sourceUserId))],
      mirrorWindowStart,
      mirrorWindowEnd,
      async (batch) => {
        expect(batch.length).toBeLessThanOrEqual(100);
        staged.push(...batch);
      },
    );

    expect(staged).toHaveLength(1_001);
    expect(fake.socialLimitCalls.length).toBeGreaterThan(1);
  }, { timeout: 30_000 });
});

describe("perp leverage policy snapshots", () => {
  const sourceUserId = "snapshot-source";
  const followerUserId = "snapshot-follower";
  const userFollowId = "00000000-0000-4000-8000-000000000401";
  const xFollowId = "00000000-0000-4000-8000-000000000402";
  const sourceAt = new Date("2026-08-21T01:00:00.000Z");

  function userFollow() {
    return {
      id: userFollowId,
      followerUserId,
      targetType: "user",
      targetKey: traderKey(sourceUserId),
      targetLabel: "Snapshot source",
      sizingMode: "usd",
      sizingValue: "100",
      autoMirror: true,
      credentialId: "00000000-0000-4000-8000-000000000411",
      perpMaxLeverage: 3,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: "00000000-0000-4000-8000-000000000411",
      stockSizingMode: "usd",
      stockSizingValue: "100",
      perpAutoMirror: true,
      perpCredentialId: "00000000-0000-4000-8000-000000000411",
      perpSizingMode: "usd",
      perpSizingValue: "100",
    } as never;
  }

  function xFollow() {
    return {
      id: xFollowId,
      followerUserId,
      targetType: "x_author",
      targetKey: "source_author:x:snapshot-leader",
      targetLabel: "Snapshot X source",
      sizingMode: "usd",
      sizingValue: "100",
      autoMirror: true,
      credentialId: "00000000-0000-4000-8000-000000000412",
      perpMaxLeverage: null,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: "00000000-0000-4000-8000-000000000412",
      stockSizingMode: "usd",
      stockSizingValue: "100",
      perpAutoMirror: true,
      perpCredentialId: "00000000-0000-4000-8000-000000000412",
      perpSizingMode: "usd",
      perpSizingValue: "100",
    } as never;
  }

  function policyRows(followId: string, followMaxLeverage: number | null) {
    return [{
      followId,
      followerUserId,
      perpUserMaxLeverage: 7,
      perpFollowMaxLeverage: followMaxLeverage,
    }];
  }

  async function withPerpsEnabled<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = previous;
    }
  }

  it("snapshots the follower global and exact follow cap on a user-trade perp", async () => {
    await withPerpsEnabled(async () => {
      const follow = userFollow();
      const fake = createPolicySnapshotDb({
        windowStart: mirrorWindowStart,
        windowEnd: mirrorWindowEnd,
        policyRows: policyRows(userFollowId, 3),
        socialRows: [{
          id: "snapshot-user-perp",
          userId: sourceUserId,
          symbol: "BTC",
          side: "buy",
          assetType: "PERP",
          orderId: "snapshot-user-order",
          orderUserId: sourceUserId,
          orderSymbol: "BTC",
          orderAssetType: "PERP",
          orderQuantityDecimal: "0.1",
          orderExecutedSizeDecimal: "0.1",
          orderDirection: "long",
          orderLeverage: 11,
          orderMarginMode: "cross",
          orderVenue: "hyperliquid",
          orderReduceOnly: false,
          orderInitialTakeProfitPx: "120",
          orderInitialStopLossPx: "90",
          createdAt: sourceAt,
        }],
      });

      const [candidate] = await findMirrorCandidateSources(
        fake.db,
        [follow],
        mirrorWindowStart,
        mirrorWindowEnd,
      );

      expect(JSON.parse(JSON.stringify(candidate))).toMatchObject({
        perpLeverage: 11,
        perpUserMaxLeverage: 7,
        perpFollowMaxLeverage: 3,
        sourceInitialTakeProfitPx: "120",
        sourceInitialStopLossPx: "90",
      });
      expect(fake.db.policyProjectionKeys).toEqual(expect.arrayContaining([
        "perpUserMaxLeverage",
        "perpFollowMaxLeverage",
      ]));
    });
  });

  it("stages a long-position perp close as a sell/short order", async () => {
    await withPerpsEnabled(async () => {
      const fake = createPolicySnapshotDb({
        windowStart: mirrorWindowStart,
        windowEnd: mirrorWindowEnd,
        policyRows: policyRows(userFollowId, 3),
        socialRows: [{
          id: "snapshot-user-perp-long-close",
          userId: sourceUserId,
          symbol: "XRP",
          side: "sell",
          assetType: "PERP",
          orderId: "snapshot-user-order-long-close",
          orderUserId: sourceUserId,
          orderSymbol: "XRP",
          orderAssetType: "PERP",
          orderQuantityDecimal: "699",
          orderExecutedSizeDecimal: "699",
          // Order rows retain the position direction being reduced.
          orderDirection: "long",
          tradeAction: "SellToClose",
          orderLeverage: 7,
          orderMarginMode: "cross",
          orderVenue: "hyperliquid",
          orderReduceOnly: true,
          orderExternalOrigin: true,
          createdAt: sourceAt,
        }],
      });

      const [candidate] = await findMirrorCandidateSources(
        fake.db,
        [userFollow()],
        mirrorWindowStart,
        mirrorWindowEnd,
      );

      expect(candidate).toMatchObject({
        symbol: "XRP",
        side: "sell",
        perpSide: "short",
        perpReduceOnly: true,
        sourceQtyDecimal: "699",
      });
    });
  });

  it("snapshots the follower global and inherited follow cap on an X-perp signal", async () => {
    await withPerpsEnabled(async () => {
      const follow = xFollow();
      const fake = createPolicySnapshotDb({
        windowStart: mirrorWindowStart,
        windowEnd: mirrorWindowEnd,
        policyRows: policyRows(xFollowId, null),
        signalRows: [{
          id: "snapshot-x-perp",
          source: "x",
          symbol: "BTC",
          content: "BTC long perp",
          metadata: {
            authorSource: "x",
            sourceAuthorId: "snapshot-leader",
            canonicalAuthorKey: "source_author:x:snapshot-leader",
            authorName: "Snapshot Leader",
            platform: "hyperliquid",
            instrument: "perp",
            direction: "long",
            hlTicker: "BTC",
            leverage: 13,
          },
          timestamp: sourceAt,
          createdAt: sourceAt,
        }],
      });

      const [candidate] = await findMirrorCandidateSources(
        fake.db,
        [follow],
        mirrorWindowStart,
        mirrorWindowEnd,
      );

      expect(JSON.parse(JSON.stringify(candidate))).toMatchObject({
        perpLeverage: 13,
        perpUserMaxLeverage: 7,
        perpFollowMaxLeverage: null,
      });
      expect(fake.db.policyProjectionKeys).toEqual(expect.arrayContaining([
        "perpUserMaxLeverage",
        "perpFollowMaxLeverage",
      ]));
    });
  });
});

/**
 * Two behaviours that came in with the copy-trade hardening branch and have to
 * survive discovery's paged rewrite: a mirror is never re-copied as a source,
 * and an equity candidate is stamped with the time the SOURCE traded rather
 * than the time its row happened to be written.
 */
describe("equity discovery provenance and source-event stamping", () => {
  const sourceUserId = "provenance-source";

  function socialRow(overrides: Record<string, unknown>) {
    return {
      id: "trade-1",
      userId: sourceUserId,
      symbol: "AAPL",
      side: "buy",
      assetType: "EQUITY",
      socialQty: 10,
      orderQuantity: 10,
      orderExecutedQuantity: 10,
      orderId: "order-1",
      orderUserId: sourceUserId,
      orderSymbol: "AAPL",
      orderAssetType: "EQUITY",
      tradeAction: "Buy",
      orderDirection: "long",
      createdAt: new Date(mirrorWindowStart.getTime() + 1_000),
      orderCreatedAt: new Date(mirrorWindowStart.getTime() + 1_000),
      orderExecutedAt: null,
      ...overrides,
    };
  }

  async function discover(rows: Array<Record<string, unknown>>) {
    const fake = createPagedMirrorDb({
      socialRows: rows,
      windowStart: mirrorWindowStart,
      windowEnd: mirrorWindowEnd,
    });
    return await findMirrorCandidateSources(
      fake.db,
      [mirrorFollow("user", traderKey(sourceUserId))],
      mirrorWindowStart,
      mirrorWindowEnd,
    );
  }

  it("refuses a row whose joined order was placed by the mirror itself", async () => {
    expect(await discover([socialRow({
      orderClientOrderId: "copymirror:follower-1:user:trade-0",
    })])).toHaveLength(0);
  });

  it("still copies a hand-placed order", async () => {
    const [candidate] = await discover([socialRow({ orderClientOrderId: "web-abc" })]);
    expect(candidate).toMatchObject({
      sourceUserId,
      sourceOrderId: "order-1",
      sourceOrderCreatedAt: candidate?.sourceEventAt,
    });
  });

  it("stamps a back-filled external fill from the venue fill time, not the ingest time", async () => {
    const filledAt = new Date(mirrorWindowStart.getTime() + 200);
    const ingestedAt = new Date(mirrorWindowStart.getTime() + 5_000);
    const [candidate] = await discover([socialRow({
      orderExecutedAt: filledAt,
      orderCreatedAt: ingestedAt,
      createdAt: ingestedAt,
    })]);

    expect(candidate!.sourceEventAt).toBe(filledAt.toISOString());
  });

  it("keeps an ordinary in-app order on its submission time", async () => {
    const submittedAt = new Date(mirrorWindowStart.getTime() + 1_000);
    const [candidate] = await discover([socialRow({
      orderCreatedAt: submittedAt,
      orderExecutedAt: new Date(submittedAt.getTime() + 2_000),
    })]);

    expect(candidate!.sourceEventAt).toBe(submittedAt.toISOString());
  });
});
