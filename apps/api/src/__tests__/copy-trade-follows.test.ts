import { beforeEach, describe, expect, it, vi } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { schema } from "@trade-bot/db";
import { millisecondTimestamp } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";

const getRedisClient = vi.fn();

vi.mock("@trade-bot/redis", () => ({
  getRedisClient,
}));

const {
  computeMirrorQty,
  mirrorIdempotencyKey,
  normalizePerpDailyCap,
  withinDailyCap,
  withinDollarCap,
} = await import("../lib/copy-mirror.js");
const { anonymizeTrader, traderKey } = await import("../routers/social.js");
const {
  mapSignalToItem,
  mapUserTradeToItem,
  normalizeAuthorKey,
  followSetKey,
  signalAuthorFollowKeys,
} = await import("../routers/copy-trade.js");
const {
  copyTradeFollowsRouter,
  decodeFollowListCursor,
  encodeFollowListCursor,
  MAX_COPY_TRADE_FOLLOWS_PER_USER,
} = await import("../routers/copy-trade-follows.js");

type FollowRow = {
  id: string;
  followerUserId: string;
  targetType: "x_author" | "user" | "politician" | "hl_wallet";
  targetKey: string;
  targetLabel: string | null;
  sizingMode: "pct" | "usd";
  sizingValue: string;
  autoMirror: boolean;
  perpMaxLeverage: number | null;
  credentialId: string | null;
  perpTakeProfitPct: string | null;
  perpStopLossPct: string | null;
  stockAutoMirror: boolean;
  stockCredentialId: string | null;
  stockSizingMode: "pct" | "usd" | "pct_equity" | "ratio";
  stockSizingValue: string;
  perpAutoMirror: boolean;
  perpCredentialId: string | null;
  perpSizingMode: "pct" | "usd" | "pct_equity" | "ratio";
  perpSizingValue: string;
  destinationPolicyInitialized: boolean;
  createdAt: Date;
};

type CredentialRow = {
  id: string;
  userId: string;
  provider: string;
  accountId: string | null;
  accountType: string | null;
  username: string | null;
};

const paperCredentialId = "00000000-0000-4000-8000-000000000101";
const liveCredentialId = "00000000-0000-4000-8000-000000000102";
const hyperliquidCredentialId = "00000000-0000-4000-8000-000000000103";
const paperCredential: CredentialRow = {
  id: paperCredentialId,
  userId: "user-1",
  provider: "alpaca",
  accountId: "PA-1234",
  accountType: "PAPER",
  username: null,
};

const hyperliquidCredential: CredentialRow = {
  id: hyperliquidCredentialId,
  userId: "user-1",
  provider: "hyperliquid",
  accountId: "0xabc",
  accountType: "LIVE",
  username: null,
};

const now = new Date("2026-06-09T12:00:00.000Z");
const canonicalAuthorKey = "source_author:x:42";
const sourceAliasKey = "source_alias:x:old%20name";

function followRow(overrides: Partial<FollowRow> = {}): FollowRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    followerUserId: "user-1",
    targetType: "x_author",
    targetKey: "cathie wood",
    targetLabel: "Cathie Wood",
    sizingMode: "pct",
    sizingValue: "5.00",
    autoMirror: false,
    perpMaxLeverage: null,
    credentialId: null,
    perpTakeProfitPct: null,
    perpStopLossPct: null,
    stockAutoMirror: false,
    stockCredentialId: null,
    stockSizingMode: "pct",
    stockSizingValue: "5.00",
    perpAutoMirror: false,
    perpCredentialId: null,
    perpSizingMode: "pct",
    perpSizingValue: "5.00",
    destinationPolicyInitialized: true,
    createdAt: now,
    ...overrides,
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createCaller(db: any, userId = "user-1") {
  return copyTradeFollowsRouter.createCaller({
    db,
    session: { userId },
    userId,
    logger: createLogger() as any,
  });
}

function createDb(overrides: Partial<{
  listRows: ReturnType<typeof vi.fn>;
  selectRows: ReturnType<typeof vi.fn>;
  insertReturning: ReturnType<typeof vi.fn>;
  deleteReturning: ReturnType<typeof vi.fn>;
  updateReturning: ReturnType<typeof vi.fn>;
  credentialRows: CredentialRow[];
  credentialRow: CredentialRow | undefined;
}> = {}) {
  const insertReturning = overrides.insertReturning || vi.fn().mockResolvedValue([]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: insertReturning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  const deleteReturning = overrides.deleteReturning || vi.fn().mockResolvedValue([]);
  const deleteWhere = vi.fn().mockReturnValue({ returning: deleteReturning });
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const updateReturning = overrides.updateReturning || vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const selectOrderBy = vi.fn().mockImplementation(async () => {
    if (overrides.listRows) return overrides.listRows();
    return [];
  });
  const selectWhere = vi.fn().mockImplementation(() => ({
    orderBy: selectOrderBy,
    for: vi.fn().mockReturnThis(),
    // Intentionally thenable: drizzle query builders are awaitable, so the
    // mock must be too for `await db.select()...where(...)` call sites.
    // eslint-disable-next-line unicorn/no-thenable
    then: (resolve: (rows: FollowRow[]) => void, reject: (error: unknown) => void) =>
      Promise.resolve(overrides.selectRows ? overrides.selectRows() : [followRow()]).then(resolve, reject),
  }));
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const credentialFindMany = vi.fn().mockResolvedValue(overrides.credentialRows ?? []);
  const credentialFindFirst = vi.fn().mockResolvedValue(overrides.credentialRow);

  return {
    insert,
    delete: deleteFn,
    update,
    select,
    query: {
      userApiCredentials: {
        findMany: credentialFindMany,
        findFirst: credentialFindFirst,
      },
    },
    spies: {
      values,
      onConflictDoUpdate,
      insertReturning,
      deleteWhere,
      deleteReturning,
      updateSet,
      updateWhere,
      updateReturning,
      selectWhere,
      selectOrderBy,
      credentialFindMany,
      credentialFindFirst,
    },
  };
}

function createAliasAdoptionDb(options: {
  current: FollowRow;
  returned: FollowRow;
  credentialRow?: CredentialRow;
}) {
  const db = createDb({
    selectRows: vi.fn().mockResolvedValue([options.current]),
    insertReturning: vi.fn().mockResolvedValue([options.returned]),
    credentialRow: options.credentialRow,
  });
  const membershipQuery: any = {};
  membershipQuery.from = vi.fn(() => membershipQuery);
  membershipQuery.innerJoin = vi.fn(() => membershipQuery);
  membershipQuery.where = vi.fn(() => membershipQuery);
  membershipQuery.limit = vi.fn().mockResolvedValue([{
    alias: "Old Name",
    source: "x",
    canonicalKey: canonicalAuthorKey,
  }]);
  const followSelect = db.select;
  const relationalDb = db as any;
  relationalDb.query.sourceAuthorIdentities = {};
  relationalDb.query.sourceAuthorAliases = {};
  relationalDb.select = vi.fn()
    .mockReturnValueOnce(membershipQuery)
    .mockReturnValueOnce(membershipQuery)
    .mockImplementation(() => followSelect());
  return relationalDb;
}

function createLeverageCapDb(options: {
  operation: "follow" | "update";
  globalPerpMaxLeverage?: number;
  currentRows?: FollowRow[];
  insertReturning?: ReturnType<typeof vi.fn>;
  updateReturning?: ReturnType<typeof vi.fn>;
} ) {
  const globalPerpMaxLeverage = options.globalPerpMaxLeverage ?? 1;
  const events: string[] = [];
  let selectCall = 0;
  const select = vi.fn(() => {
    selectCall += 1;
    const rows = selectCall === 1
      ? [{ id: "user-1", copyPerpMaxLeverage: globalPerpMaxLeverage }]
      : options.operation === "follow" && selectCall === 2
        ? [{ count: "0" }]
        : options.currentRows ?? [];
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      for: vi.fn((mode: string) => {
        events.push(`lock:${mode}`);
        return Promise.resolve(rows);
      }),
      // eslint-disable-next-line unicorn/no-thenable
      then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  });

  const insertReturning = options.insertReturning ?? vi.fn().mockResolvedValue([]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: insertReturning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  const updateReturning = options.updateReturning ?? vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockImplementation(() => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn((values: Record<string, unknown>) => ({
    where: vi.fn(() => {
      events.push(`update:${JSON.stringify(values)}`);
      return updateWhere();
    }),
  }));
  const update = vi.fn().mockReturnValue({ set: updateSet });
  const db: any = {
    select,
    insert,
    update,
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    query: {
      userApiCredentials: {
        findFirst: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    events,
    spies: { values, onConflictDoUpdate, updateSet, updateWhere, transaction: undefined },
  };
  db.spies.transaction = db.transaction;
  return db;
}

function readCopyTradeFollowsMigration() {
  const migrationsDir = join(import.meta.dir, "../../../..", "packages/db/migrations");
  for (const fileName of readdirSync(migrationsDir).sort()) {
    if (!/^\d+_.*\.sql$/.test(fileName)) continue;

    const contents = readFileSync(join(migrationsDir, fileName), "utf8");
    if (contents.includes('"copy_trade_follows"')) {
      return { fileName, contents };
    }
  }

  return null;
}

function readMigrationsContaining(pattern: string) {
  const migrationsDir = join(import.meta.dir, "../../../..", "packages/db/migrations");
  return readdirSync(migrationsDir)
    .sort()
    .filter((fileName) => fileName.endsWith(".sql"))
    .map((fileName) => ({
      fileName,
      contents: readFileSync(join(migrationsDir, fileName), "utf8"),
    }))
    .filter(({ contents }) => contents.includes(pattern));
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisClient.mockResolvedValue({
    incrWithTtl: vi.fn().mockResolvedValue(1),
  });
});

describe("computeMirrorQty", () => {
  it("sizes by percent of buying power (floored to whole shares)", () => {
    // 5% of $10,000 = $500 target; $500 / $50 = 10 shares
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: 5, buyingPower: 10_000, price: 50 })).toBe(10);
  });

  it("floors a fractional percent result down to whole shares", () => {
    // 5% of $10,000 = $500; $500 / $33 = 15.15 -> 15
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: 5, buyingPower: 10_000, price: 33 })).toBe(15);
  });

  it("sizes by absolute dollar target (buyingPower ignored in usd mode)", () => {
    // $250 target / $50 = 5 shares; buyingPower irrelevant
    expect(computeMirrorQty({ sizingMode: "usd", sizingValue: 250, buyingPower: 0, price: 50 })).toBe(5);
  });

  it("returns 0 when price <= 0", () => {
    expect(computeMirrorQty({ sizingMode: "usd", sizingValue: 250, buyingPower: 10_000, price: 0 })).toBe(0);
    expect(computeMirrorQty({ sizingMode: "usd", sizingValue: 250, buyingPower: 10_000, price: -5 })).toBe(0);
  });

  it("returns 0 when the target buys less than one whole share", () => {
    // $10 target, $50 price -> 0.2 shares -> 0
    expect(computeMirrorQty({ sizingMode: "usd", sizingValue: 10, buyingPower: 10_000, price: 50 })).toBe(0);
  });

  it("returns 0 for invalid sizing/buying-power inputs", () => {
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: 0, buyingPower: 10_000, price: 50 })).toBe(0);
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: -5, buyingPower: 10_000, price: 50 })).toBe(0);
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: 5, buyingPower: 0, price: 50 })).toBe(0);
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: 5, buyingPower: -1, price: 50 })).toBe(0);
    expect(computeMirrorQty({ sizingMode: "usd", sizingValue: NaN, buyingPower: 10_000, price: 50 })).toBe(0);
    expect(computeMirrorQty({ sizingMode: "pct", sizingValue: 5, buyingPower: 10_000, price: NaN })).toBe(0);
  });
});

describe("mirrorIdempotencyKey", () => {
  it("is deterministic for the same (follower, source item)", () => {
    const a = mirrorIdempotencyKey({ followerUserId: "u1", sourceItemId: "x_signal:abc" });
    const b = mirrorIdempotencyKey({ followerUserId: "u1", sourceItemId: "x_signal:abc" });
    expect(a).toBe(b);
  });

  it("differs across followers for the same source item", () => {
    const a = mirrorIdempotencyKey({ followerUserId: "u1", sourceItemId: "x_signal:abc" });
    const b = mirrorIdempotencyKey({ followerUserId: "u2", sourceItemId: "x_signal:abc" });
    expect(a).not.toBe(b);
  });

  it("differs across source items for the same follower", () => {
    const a = mirrorIdempotencyKey({ followerUserId: "u1", sourceItemId: "x_signal:abc" });
    const b = mirrorIdempotencyKey({ followerUserId: "u1", sourceItemId: "user:def" });
    expect(a).not.toBe(b);
  });
});

describe("withinDailyCap", () => {
  it("is true under the cap and false at/over it", () => {
    expect(withinDailyCap({ mirrorsToday: 0, dailyCap: 20 })).toBe(true);
    expect(withinDailyCap({ mirrorsToday: 19, dailyCap: 20 })).toBe(true);
    expect(withinDailyCap({ mirrorsToday: 20, dailyCap: 20 })).toBe(false);
    expect(withinDailyCap({ mirrorsToday: 21, dailyCap: 20 })).toBe(false);
  });

  it("fails closed for an invalid cap or count", () => {
    expect(withinDailyCap({ mirrorsToday: 0, dailyCap: 0 })).toBe(false);
    expect(withinDailyCap({ mirrorsToday: 0, dailyCap: -1 })).toBe(false);
    expect(withinDailyCap({ mirrorsToday: -1, dailyCap: 20 })).toBe(false);
    expect(withinDailyCap({ mirrorsToday: NaN, dailyCap: 20 })).toBe(false);
  });
});

describe("normalizePerpDailyCap", () => {
  it("keeps the configured cap instead of replacing it with the local proof value", () => {
    expect(normalizePerpDailyCap(20)).toBe(20);
    expect(normalizePerpDailyCap(7)).toBe(7);
  });

  it("rejects fractional caps instead of allowing Phase A to bypass reservation", () => {
    expect(normalizePerpDailyCap(1.5)).toBeNull();
  });
});

describe("withinDollarCap", () => {
  it("is true at/under the cap and false over it", () => {
    expect(withinDollarCap({ orderDollars: 0, maxOrderDollars: 1000 })).toBe(true);
    expect(withinDollarCap({ orderDollars: 1000, maxOrderDollars: 1000 })).toBe(true);
    expect(withinDollarCap({ orderDollars: 1000.01, maxOrderDollars: 1000 })).toBe(false);
  });

  it("fails closed for an invalid cap or amount", () => {
    expect(withinDollarCap({ orderDollars: 100, maxOrderDollars: 0 })).toBe(false);
    expect(withinDollarCap({ orderDollars: 100, maxOrderDollars: -1 })).toBe(false);
    expect(withinDollarCap({ orderDollars: -1, maxOrderDollars: 1000 })).toBe(false);
    expect(withinDollarCap({ orderDollars: NaN, maxOrderDollars: 1000 })).toBe(false);
  });
});

describe("traderKey", () => {
  it("is deterministic for the same user id", () => {
    expect(traderKey("user-abc")).toBe(traderKey("user-abc"));
  });

  it("differs across user ids", () => {
    expect(traderKey("user-abc")).not.toBe(traderKey("user-xyz"));
  });

  it("never equals the raw user id (it is a one-way hash)", () => {
    const id = "user-abc";
    expect(traderKey(id)).not.toBe(id);
  });

  it("is a wide hex digest, intentionally decoupled from the cosmetic avatar seed", () => {
    // The follow key must be collision-resistant (the auto-mirror worker matches
    // a follow to a source trade by THIS key), so it is a 128-bit SHA-256 prefix
    // — deliberately NOT the 32-bit FNV value used for the pseudonym/avatar seed.
    const id = "user-abc";
    const key = traderKey(id);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const { traderImage } = anonymizeTrader(id);
    expect(traderImage).not.toContain(`seed=${key}`);
  });
});

describe("normalizeAuthorKey", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeAuthorKey("  Cathie   Wood ")).toBe("cathie wood");
  });

  it("returns null for empty/unknown authors", () => {
    expect(normalizeAuthorKey(null)).toBeNull();
    expect(normalizeAuthorKey(undefined)).toBeNull();
    expect(normalizeAuthorKey("")).toBeNull();
    expect(normalizeAuthorKey("   ")).toBeNull();
    expect(normalizeAuthorKey("Unknown")).toBeNull();
    expect(normalizeAuthorKey("unknown")).toBeNull();
  });
});

describe("followSetKey", () => {
  it("composes type and key with a pipe", () => {
    expect(followSetKey("x_author", "cathie wood")).toBe("x_author|cathie wood");
    expect(followSetKey("user", "abc123")).toBe("user|abc123");
  });
});

describe("follow list cursor pagination", () => {
  it("round-trips an explicit created-at/id cursor", () => {
    const cursor = {
      createdAt: "2026-06-09T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001",
    };
    expect(decodeFollowListCursor(encodeFollowListCursor(cursor))).toEqual(cursor);
    expect(decodeFollowListCursor("not-a-cursor")).toBeNull();
  });

  it("publishes a finite transactional quota for unique follows", () => {
    expect(MAX_COPY_TRADE_FOLLOWS_PER_USER).toBeGreaterThan(0);
    expect(MAX_COPY_TRADE_FOLLOWS_PER_USER).toBeLessThanOrEqual(1_000);
  });
});

describe("copyTradeFollowsRouter", () => {
  it("returns a stable page and cursor without changing the legacy list contract", async () => {
    const rows = [
      followRow({ id: "00000000-0000-4000-8000-000000000003", createdAt: new Date("2026-06-09T14:00:00.123Z") }),
      followRow({ id: "00000000-0000-4000-8000-000000000002", createdAt: new Date("2026-06-09T14:00:00.123Z") }),
      followRow({ id: "00000000-0000-4000-8000-000000000001", createdAt: new Date("2026-06-09T14:00:00.123Z") }),
    ];
    let page = rows;
    const query: any = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: (limit: number) => Promise.resolve(page.slice(0, limit)),
    };
    const db = {
      select: () => query,
      query: {
        userApiCredentials: { findMany: async () => [] },
      },
    };
    const caller = createCaller(db);

    const first = await caller.listPage({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(first.nextCursor).not.toBeNull();

    page = rows.slice(2);
    const second = await caller.listPage({
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual([rows[2]!.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("enforces the unique-follow quota under the same transaction as the insert", async () => {
    const existingRows = Array.from({ length: MAX_COPY_TRADE_FOLLOWS_PER_USER }, (_, index) =>
      followRow({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        targetKey: `existing-${index}`,
      }),
    );
    let selectCall = 0;
    let db: any;
    const transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db));
    const select = vi.fn(() => {
      selectCall += 1;
      const rows = selectCall === 1
        ? [{ id: "user-1" }]
        : selectCall === 2
          ? [{ count: String(MAX_COPY_TRADE_FOLLOWS_PER_USER) }]
          : existingRows;
      const query = Promise.resolve(rows) as any;
      query.where = () => query;
      query.for = () => query;
      return { from: () => query };
    });
    const insert = vi.fn();
    db = {
      select,
      insert,
      transaction,
      query: {
        userApiCredentials: { findMany: async () => [], findFirst: async () => undefined },
      },
    };

    await expect(createCaller(db).follow({
      targetType: "x_author",
      targetKey: "new-target",
    })).rejects.toThrow(/maximum|limit|follow/i);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("preserves the production transaction receiver while enforcing a follow", async () => {
    const base = createDb({
      insertReturning: vi.fn().mockResolvedValue([followRow({ targetType: "user", targetKey: "trader-key" })]),
    });
    const db = Object.assign(
      Object.create({
        transaction(this: { session: string }, callback: (tx: unknown) => Promise<unknown>) {
          if (this.session !== "production-session") throw new Error("transaction receiver lost");
          return callback(this);
        },
      }),
      base,
      { session: "production-session" },
    );

    await expect(createCaller(db).follow({
      targetType: "user",
      targetKey: "trader-key",
    })).resolves.toMatchObject({ targetKey: "trader-key" });
  });

  it("uses the shared millisecond timestamp SQL key for follow pagination", () => {
    const query = new PgDialect().sqlToQuery(
      millisecondTimestamp(schema.copyTradeFollows.createdAt),
    );
    expect(query.sql).toContain("date_trunc('milliseconds'");
    expect(query.sql).toContain('"copy_trade_follows"."created_at"');
  });

  it("lists the signed-in user's follows newest-first as client-safe values", async () => {
    const rows = [
      followRow({
        id: "00000000-0000-4000-8000-000000000002",
        targetType: "user",
        targetKey: "abc123",
        targetLabel: "Trader 12",
        sizingMode: "usd",
        sizingValue: "125.50",
        autoMirror: true,
        perpMaxLeverage: 3,
        credentialId: paperCredentialId,
        stockAutoMirror: true,
        stockCredentialId: paperCredentialId,
        stockSizingMode: "usd",
        stockSizingValue: "125.50",
        createdAt: new Date("2026-06-09T13:00:00.000Z"),
      }),
      followRow(),
      followRow({
        id: "00000000-0000-4000-8000-000000000003",
        targetKey: "malformed sizing",
        targetLabel: "Malformed Sizing",
        sizingValue: "5junk",
      }),
    ];
    const db = createDb({
      listRows: vi.fn().mockResolvedValue(rows),
      credentialRows: [
        {
          id: paperCredentialId,
          userId: "user-1",
          provider: "alpaca",
          accountId: "PA-1234",
          accountType: "PAPER",
          username: "not-returned",
        },
      ],
    });

    const result = await createCaller(db).list();

    expect(result).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        targetType: "user",
        targetKey: "abc123",
        targetLabel: "Trader 12",
        sizingMode: "usd",
        sizingValue: 125.5,
        autoMirror: true,
        credentialId: paperCredentialId,
        credentialAccountLabel: "Paper account PA-1234",
        credentialAccountType: "PAPER",
        credentialProvider: "alpaca",
        maxTradeSize: null,
        maxCoinSize: null,
        perpMaxLeverage: 3,
        perpTakeProfitPct: null,
        perpStopLossPct: null,
        createdAt: "2026-06-09T13:00:00.000Z",
        destinations: {
          stock: {
            enabled: true,
            credentialId: paperCredentialId,
            sizingMode: "usd",
            sizingValue: 125.5,
            credentialAccountLabel: "Paper account PA-1234",
            credentialAccountType: "PAPER",
            credentialProvider: "alpaca",
          },
          perp: {
            enabled: false,
            credentialId: null,
            sizingMode: "pct",
            sizingValue: 5,
            credentialAccountLabel: null,
            credentialAccountType: null,
            credentialProvider: null,
          },
        },
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        targetType: "x_author",
        targetKey: "cathie wood",
        targetLabel: "Cathie Wood",
        sizingMode: "pct",
        sizingValue: 5,
        autoMirror: false,
        credentialId: null,
        credentialAccountLabel: null,
        credentialAccountType: null,
        credentialProvider: null,
        maxTradeSize: null,
        maxCoinSize: null,
        perpMaxLeverage: null,
        perpTakeProfitPct: null,
        perpStopLossPct: null,
        createdAt: "2026-06-09T12:00:00.000Z",
        destinations: {
          stock: {
            enabled: false,
            credentialId: null,
            sizingMode: "pct",
            sizingValue: 5,
            credentialAccountLabel: null,
            credentialAccountType: null,
            credentialProvider: null,
          },
          perp: {
            enabled: false,
            credentialId: null,
            sizingMode: "pct",
            sizingValue: 5,
            credentialAccountLabel: null,
            credentialAccountType: null,
            credentialProvider: null,
          },
        },
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        targetType: "x_author",
        targetKey: "malformed sizing",
        targetLabel: "Malformed Sizing",
        sizingMode: "pct",
        sizingValue: 0,
        autoMirror: false,
        credentialId: null,
        credentialAccountLabel: null,
        credentialAccountType: null,
        credentialProvider: null,
        maxTradeSize: null,
        maxCoinSize: null,
        perpMaxLeverage: null,
        perpTakeProfitPct: null,
        perpStopLossPct: null,
        createdAt: "2026-06-09T12:00:00.000Z",
        destinations: {
          stock: {
            enabled: false,
            credentialId: null,
            sizingMode: "pct",
            sizingValue: 5,
            credentialAccountLabel: null,
            credentialAccountType: null,
            credentialProvider: null,
          },
          perp: {
            enabled: false,
            credentialId: null,
            sizingMode: "pct",
            sizingValue: 5,
            credentialAccountLabel: null,
            credentialAccountType: null,
            credentialProvider: null,
          },
        },
      },
    ]);
    expect(db.spies.selectOrderBy).toHaveBeenCalled();
  });

  it("does not re-arm a legacy-consented row before typed policy initialization", async () => {
    const db = createDb({
      listRows: vi.fn().mockResolvedValue([
        followRow({
          autoMirror: true,
          credentialId: paperCredentialId,
          destinationPolicyInitialized: false,
        }),
      ]),
      credentialRows: [paperCredential],
    });

    const [result] = await createCaller(db).list();

    expect(result).toMatchObject({
      autoMirror: false,
      destinations: {
        stock: { enabled: false, credentialId: null },
        perp: { enabled: false, credentialId: null },
      },
    });
  });

  it("persists and returns a lower per-follow cap when following", async () => {
    const created = followRow({
      perpMaxLeverage: 3,
      targetKey: "cathie wood",
    });
    const db = createLeverageCapDb({
      operation: "follow",
      globalPerpMaxLeverage: 5,
      insertReturning: vi.fn().mockResolvedValue([created]),
    });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: "cathie wood",
      perpMaxLeverage: 3,
    });

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ perpMaxLeverage: 3 }),
    );
    expect(result).toMatchObject({ perpMaxLeverage: 3 });
  });

  it("uses the global cap when a follow explicitly stores null", async () => {
    const created = followRow({ perpMaxLeverage: null });
    const db = createLeverageCapDb({
      operation: "follow",
      globalPerpMaxLeverage: 5,
      insertReturning: vi.fn().mockResolvedValue([created]),
    });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: "cathie wood",
      perpMaxLeverage: null,
    });

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ perpMaxLeverage: null }),
    );
    expect(result).toMatchObject({ perpMaxLeverage: null });
  });

  it("rejects a per-follow cap above the current global cap", async () => {
    const db = createLeverageCapDb({
      operation: "follow",
      globalPerpMaxLeverage: 2,
    });

    await expect(
      createCaller(db).follow({
        targetType: "x_author",
        targetKey: "cathie wood",
        perpMaxLeverage: 3,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.events[0]).toBe("lock:update");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("locks the authenticated user row before accepting a per-follow update", async () => {
    const current = followRow({ perpMaxLeverage: 4 });
    const updated = followRow({ perpMaxLeverage: 2 });
    const db = createLeverageCapDb({
      operation: "update",
      globalPerpMaxLeverage: 5,
      currentRows: [current],
      updateReturning: vi.fn().mockResolvedValue([updated]),
    });

    const result = await createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      perpMaxLeverage: 2,
    });

    expect(result).toMatchObject({ perpMaxLeverage: 2 });
    expect(db.events[0]).toBe("lock:update");
    expect(db.events[1]).toContain("perpMaxLeverage");
  });

  it("fails closed when a no-transaction adapter tries to create a capped follow", async () => {
    const db = createDb({
      insertReturning: vi.fn().mockResolvedValue([
        followRow({ perpMaxLeverage: 3 }),
      ]),
    });

    await expect(
      createCaller(db).follow({
        targetType: "x_author",
        targetKey: "cathie wood",
        perpMaxLeverage: 3,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("fails closed when a no-transaction adapter tries to update a capped follow", async () => {
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([followRow()]),
      updateReturning: vi.fn().mockResolvedValue([
        followRow({ perpMaxLeverage: 3 }),
      ]),
    });

    await expect(
      createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        perpMaxLeverage: 3,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("follows a target with DB defaults for sizing and auto-mirror", async () => {
    const created = followRow({
      targetLabel: null,
      sizingMode: "pct",
      sizingValue: "5.00",
      autoMirror: false,
    });
    const db = createDb({
      insertReturning: vi.fn().mockResolvedValue([created]),
    });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: "cathie wood",
    });

    expect(result).toMatchObject({
      targetType: "x_author",
      targetKey: "cathie wood",
      targetLabel: null,
      sizingMode: "pct",
      sizingValue: 5,
      autoMirror: false,
    });
    expect(db.spies.values).toHaveBeenCalledWith({
      followerUserId: "user-1",
      targetType: "x_author",
      targetKey: "cathie wood",
      targetLabel: null,
      destinationPolicyInitialized: true,
    });
    expect(db.spies.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: { targetKey: "cathie wood" },
      }),
    );
  });

  it("preserves existing sizing and auto-mirror when re-following without explicit changes", async () => {
    const existing = followRow({
      targetLabel: "Existing Label",
      sizingMode: "usd",
      sizingValue: "250.00",
      autoMirror: true,
      credentialId: paperCredentialId,
    });
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([existing]),
      credentialRow: paperCredential,
      insertReturning: vi.fn().mockResolvedValue([existing]),
    });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: "cathie wood",
    });

    expect(result).toMatchObject({
      targetLabel: "Existing Label",
      sizingMode: "usd",
      sizingValue: 250,
      autoMirror: true,
    });
    expect(db.spies.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: { targetKey: "cathie wood" },
      }),
    );
  });

  it("adopts a canonical alias without dropping a single typed destination", async () => {
    const current = followRow({
      targetKey: sourceAliasKey,
      targetLabel: "Old Name",
      autoMirror: false,
      credentialId: null,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "250.00",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5.00",
    });
    const returned = followRow({ ...current, targetKey: canonicalAuthorKey });
    const db = createAliasAdoptionDb({ current, returned });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: canonicalAuthorKey,
    });

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({
      targetKey: canonicalAuthorKey,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "250.00",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5.00",
    }));
    expect(result).toMatchObject({
      targetKey: canonicalAuthorKey,
      destinations: {
        stock: { enabled: true, credentialId: paperCredentialId, sizingValue: 250 },
        perp: { enabled: false, credentialId: null, sizingValue: 5 },
      },
    });
    expect(db.spies.deleteWhere).toHaveBeenCalled();
  });

  it("adopts a canonical alias without dropping dual typed destinations", async () => {
    const current = followRow({
      targetKey: sourceAliasKey,
      autoMirror: false,
      credentialId: null,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "125.00",
      perpAutoMirror: true,
      perpCredentialId: hyperliquidCredentialId,
      perpSizingMode: "ratio",
      perpSizingValue: "2.00",
    });
    const returned = followRow({ ...current, targetKey: canonicalAuthorKey });
    const db = createAliasAdoptionDb({ current, returned });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: canonicalAuthorKey,
    });

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({
      targetKey: canonicalAuthorKey,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "125.00",
      perpAutoMirror: true,
      perpCredentialId: hyperliquidCredentialId,
      perpSizingMode: "ratio",
      perpSizingValue: "2.00",
    }));
    expect(result).toMatchObject({
      targetKey: canonicalAuthorKey,
      destinations: {
        stock: { enabled: true, credentialId: paperCredentialId, sizingValue: 125 },
        perp: { enabled: true, credentialId: hyperliquidCredentialId, sizingValue: 2 },
      },
    });
  });

  it("preserves an uninitialized destination policy marker during alias adoption", async () => {
    const current = followRow({
      targetKey: sourceAliasKey,
      autoMirror: true,
      credentialId: paperCredentialId,
      destinationPolicyInitialized: false,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "250.00",
    });
    const returned = followRow({ ...current, targetKey: canonicalAuthorKey });
    const db = createAliasAdoptionDb({
      current,
      returned,
      credentialRow: paperCredential,
    });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: canonicalAuthorKey,
    });

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({
      targetKey: canonicalAuthorKey,
      destinationPolicyInitialized: false,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
    }));
    expect(result).toMatchObject({
      autoMirror: false,
      destinations: {
        stock: { enabled: false, credentialId: paperCredentialId, sizingValue: 250 },
      },
    });
  });

  it("preserves the unpatched destination during a partial nested update", async () => {
    const current = followRow({
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "125.00",
      perpAutoMirror: true,
      perpCredentialId: hyperliquidCredentialId,
      perpSizingMode: "ratio",
      perpSizingValue: "2.00",
    });
    const updated = followRow({
      ...current,
      stockAutoMirror: false,
      stockCredentialId: null,
      stockSizingMode: "pct",
      stockSizingValue: "8.00",
    });
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([current]),
      updateReturning: vi.fn().mockResolvedValue([updated]),
    });

    await createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      destinations: {
        stock: {
          enabled: false,
          credentialId: null,
          sizingMode: "pct",
          sizingValue: 8,
        },
      },
    });

    expect(db.spies.updateSet).toHaveBeenCalledWith({
      autoMirror: true,
      credentialId: hyperliquidCredentialId,
      sizingMode: "ratio",
      sizingValue: "2.00",
      destinationPolicyInitialized: true,
      stockAutoMirror: false,
      stockCredentialId: null,
      stockSizingMode: "pct",
      stockSizingValue: "8.00",
      perpAutoMirror: true,
      perpCredentialId: hyperliquidCredentialId,
      perpSizingMode: "ratio",
      perpSizingValue: "2.00",
    });
  });

  it("updates sizing and auto-mirror only when follow receives explicit values", async () => {
    const updated = followRow({
      targetLabel: "Updated Label",
      sizingMode: "usd",
      sizingValue: "500.00",
      autoMirror: true,
      credentialId: paperCredentialId,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "500.00",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5.00",
    });
    const db = createDb({
      credentialRow: paperCredential,
      insertReturning: vi.fn().mockResolvedValue([updated]),
    });

    const result = await createCaller(db).follow({
      targetType: "x_author",
      targetKey: "cathie wood",
      targetLabel: "Updated Label",
      sizingMode: "usd",
      sizingValue: 500,
      autoMirror: true,
      credentialId: paperCredentialId,
    });

    expect(result).toMatchObject({
      targetLabel: "Updated Label",
      sizingMode: "usd",
      sizingValue: 500,
      autoMirror: true,
    });
    expect(db.spies.values).toHaveBeenCalledWith({
      followerUserId: "user-1",
      targetType: "x_author",
      targetKey: "cathie wood",
      targetLabel: "Updated Label",
      sizingMode: "usd",
      sizingValue: "500.00",
      autoMirror: true,
      credentialId: paperCredentialId,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "500.00",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5.00",
    });
    expect(db.spies.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: {
          targetLabel: "Updated Label",
          sizingMode: "usd",
          sizingValue: "500.00",
          autoMirror: true,
          credentialId: paperCredentialId,
          destinationPolicyInitialized: true,
          stockAutoMirror: true,
          stockCredentialId: paperCredentialId,
          stockSizingMode: "usd",
          stockSizingValue: "500.00",
          perpAutoMirror: false,
          perpCredentialId: null,
          perpSizingMode: "pct",
          perpSizingValue: "5.00",
        },
      }),
    );
  });

  it("unfollows a target through a signed-in-user scoped delete", async () => {
    const db = createDb({
      deleteReturning: vi
        .fn()
        .mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001" }]),
    });

    await expect(
      createCaller(db).unfollow({
        targetType: "x_author",
        targetKey: "cathie wood",
      }),
    ).resolves.toEqual({ removed: true });

    expect(db.delete).toHaveBeenCalled();
    expect(db.spies.deleteWhere).toHaveBeenCalled();
  });

  it("locks the owned user before an unfollow can delete its follow", async () => {
    const events: string[] = [];
    const userLockQuery: any = {
      from: () => userLockQuery,
      where: () => userLockQuery,
      for: vi.fn(async (mode: string) => {
        events.push(`lock:user:${mode}`);
        return [{ id: "user-1" }];
      }),
    };
    const tx = {
      select: vi.fn(() => userLockQuery),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            events.push("delete:follow");
            return [{ id: followRow().id }];
          }),
        })),
      })),
    };
    const db: any = {
      query: {},
      select: vi.fn(),
      transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
        events.push("transaction:begin");
        const result = await callback(tx);
        events.push("transaction:commit");
        return result;
      }),
    };

    await expect(createCaller(db).unfollow({
      targetType: "x_author",
      targetKey: "cathie wood",
    })).resolves.toEqual({ removed: true });

    expect(events).toEqual([
      "transaction:begin",
      "lock:user:update",
      "delete:follow",
      "transaction:commit",
    ]);
  });

  it("partially updates an existing follow without requiring every sizing field", async () => {
    const updated = followRow({
      sizingMode: "pct",
      sizingValue: "5.00",
      autoMirror: true,
      credentialId: paperCredentialId,
    });
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([
        followRow({ credentialId: paperCredentialId }),
      ]),
      credentialRow: paperCredential,
      updateReturning: vi.fn().mockResolvedValue([updated]),
    });

    const result = await createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      autoMirror: true,
    });

    expect(result).toMatchObject({
      sizingMode: "pct",
      sizingValue: 5,
      autoMirror: true,
    });
    expect(db.spies.updateSet).toHaveBeenCalledWith({
      autoMirror: true,
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: paperCredentialId,
      stockSizingMode: "pct",
      stockSizingValue: "5.00",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5.00",
    });
  });

  it("rejects enabling auto-mirror without a selected credential", async () => {
    const db = createDb({ selectRows: vi.fn().mockResolvedValue([followRow()]) });

    await expect(
      createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        autoMirror: true,
      }),
    ).rejects.toThrow(/select a ready alpaca or hyperliquid account/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects enabling auto-mirror when the saved legacy sizing pair is malformed", async () => {
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([
        followRow({
          sizingMode: "bogus" as "pct",
          sizingValue: "90.00",
          credentialId: paperCredentialId,
        }),
      ]),
      credentialRow: paperCredential,
    });

    await expect(createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      autoMirror: true,
    })).rejects.toThrow(/saved mirror sizing is invalid/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a credential that is owned by another user", async () => {
    const db = createDb({ credentialRow: undefined });

    await expect(
      createCaller(db).follow({
        targetType: "user",
        targetKey: "trader-key",
        autoMirror: true,
        credentialId: paperCredentialId,
      }),
    ).rejects.toThrow(/mirror account is unavailable/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a deleted credential", async () => {
    const db = createDb({
      credentialRow: undefined,
      selectRows: vi.fn().mockResolvedValue([followRow()]),
    });

    await expect(
      createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        credentialId: paperCredentialId,
      }),
    ).rejects.toThrow(/mirror account is unavailable/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects an unsupported mirror credential provider", async () => {
    const db = createDb({
      credentialRow: {
        id: paperCredentialId,
        userId: "user-1",
        provider: "tradestation",
        accountId: "TS-1",
        accountType: "PAPER",
        username: null,
      },
    });

    await expect(
      createCaller(db).follow({
        targetType: "user",
        targetKey: "trader-key",
        credentialId: paperCredentialId,
      }),
    ).rejects.toThrow(/mirror account is unavailable/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("accepts and returns a user-owned Paper credential", async () => {
    const credential: CredentialRow = {
      id: paperCredentialId,
      userId: "user-1",
      provider: "alpaca",
      accountId: "PA-1234",
      accountType: "PAPER",
      username: "secret-key-id",
    };
    const created = followRow({
      targetType: "user",
      targetKey: "trader-key",
      autoMirror: true,
      credentialId: paperCredentialId,
    });
    const db = createDb({
      credentialRow: credential,
      insertReturning: vi.fn().mockResolvedValue([created]),
    });

    const result = await createCaller(db).follow({
      targetType: "user",
      targetKey: "trader-key",
      autoMirror: true,
      credentialId: paperCredentialId,
    });

    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: paperCredentialId, autoMirror: true }),
    );
    expect(result).toMatchObject({
      credentialId: paperCredentialId,
      credentialAccountType: "PAPER",
      credentialAccountLabel: "Paper account PA-1234",
    });
    expect(JSON.stringify(result)).not.toContain("secret-key-id");
  });

  it("accepts and returns a user-owned Live credential", async () => {
    const credential: CredentialRow = {
      id: liveCredentialId,
      userId: "user-1",
      provider: "alpaca",
      accountId: "LIVE-9876",
      accountType: "LIVE",
      username: null,
    };
    const updated = followRow({
      autoMirror: true,
      credentialId: liveCredentialId,
    });
    const db = createDb({
      credentialRow: credential,
      selectRows: vi.fn().mockResolvedValue([followRow()]),
      updateReturning: vi.fn().mockResolvedValue([updated]),
    });

    const result = await createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      autoMirror: true,
      credentialId: liveCredentialId,
    });

    expect(result).toMatchObject({
      credentialId: liveCredentialId,
      credentialAccountType: "LIVE",
      credentialAccountLabel: "Live account LIVE-9876",
    });
  });

  it("requires an explicitly selected ready Hyperliquid credential for perps mirroring", async () => {
    const credential: CredentialRow = {
      id: hyperliquidCredentialId,
      userId: "user-1",
      provider: "hyperliquid",
      accountId: "0x1234",
      accountType: "LIVE",
      username: null,
    };
    const updated = followRow({
      autoMirror: true,
      credentialId: hyperliquidCredentialId,
    });
    const db = createDb({
      credentialRow: credential,
      selectRows: vi.fn().mockResolvedValue([followRow()]),
      updateReturning: vi.fn().mockResolvedValue([updated]),
    });

    const result = await createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      autoMirror: true,
      credentialId: hyperliquidCredentialId,
    });

    expect(result).toMatchObject({
      credentialId: hyperliquidCredentialId,
      credentialProvider: "hyperliquid",
      credentialAccountType: "LIVE",
      credentialAccountLabel: "Hyperliquid mainnet perps",
    });
  });

  it("atomically disables auto-mirror when its credential is cleared", async () => {
    const updated = followRow({ autoMirror: false, credentialId: null });
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([
        followRow({ autoMirror: true, credentialId: paperCredentialId }),
      ]),
      updateReturning: vi.fn().mockResolvedValue([updated]),
    });

    const result = await createCaller(db).update({
      targetType: "x_author",
      targetKey: "cathie wood",
      credentialId: null,
    });

    expect(db.spies.updateSet).toHaveBeenCalledWith({
      credentialId: null,
      autoMirror: false,
      destinationPolicyInitialized: true,
      stockAutoMirror: false,
      stockCredentialId: null,
      stockSizingMode: "pct",
      stockSizingValue: "5.00",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5.00",
    });
    expect(result).toMatchObject({ autoMirror: false, credentialId: null });
  });

  // H-2: mode-aware sizingValue validation. A flat .max(1_000_000) used to
  // accept "500" with mode=pct (i.e. 500% of buying power); the worker's
  // runtime clamp catches it, but rejecting at the API boundary is clearer.
  describe("H-2 sizingValue bounds", () => {
    const cases: Array<{
      mode: "pct" | "pct_equity" | "usd" | "ratio";
      ok: number;
      bad: number;
    }> = [
      { mode: "pct", ok: 5, bad: 150 },
      { mode: "pct_equity", ok: 10, bad: 200 },
      { mode: "usd", ok: 500, bad: 5_000_000 },
      { mode: "ratio", ok: 1, bad: 50 },
    ];

    for (const c of cases) {
      it(`accepts in-range sizing for mode=${c.mode}`, async () => {
        const updated = followRow({ sizingMode: c.mode as never, sizingValue: String(c.ok) });
        const db = createDb({ updateReturning: vi.fn().mockResolvedValue([updated]) });
        await expect(
          createCaller(db).update({
            targetType: "x_author",
            targetKey: "cathie wood",
            sizingMode: c.mode,
            sizingValue: c.ok,
          }),
        ).resolves.toBeTruthy();
      });

      it(`rejects out-of-range sizing for mode=${c.mode}`, async () => {
        const db = createDb({});
        await expect(
          createCaller(db).update({
            targetType: "x_author",
            targetKey: "cathie wood",
            sizingMode: c.mode,
            sizingValue: c.bad,
          }),
        ).rejects.toThrow();
      });
    }

    it("ratio mode rejects sizingValue > 10 (qty multiplier ceiling)", async () => {
      const db = createDb({});
      await expect(
        createCaller(db).follow({
          targetType: "user",
          targetKey: "k",
          sizingMode: "ratio",
          sizingValue: 11,
        }),
      ).rejects.toThrow(/0\.01\.\.10/);
    });
  });

  describe("dollar cap bounds", () => {
    const endpoints = ["follow", "update", "followWallet"] as const;
    const capFields = ["maxTradeSize", "maxCoinSize"] as const;

    function endpointInput(endpoint: (typeof endpoints)[number], field: (typeof capFields)[number], value: number | null) {
      const cap = { [field]: value };
      if (endpoint === "followWallet") {
        return { walletAddress: "0x0000000000000000000000000000000000000001", ...cap };
      }
      return {
        targetType: "x_author" as const,
        targetKey: "cathie wood",
        ...cap,
      };
    }

    for (const endpoint of endpoints) {
      for (const field of capFields) {
        for (const value of [0.001, 0.009, 0.011]) {
          it(`${endpoint} rejects ${field}=${value} when the cap cannot be stored safely as numeric(12,2)`, async () => {
            const db = createDb({
              insertReturning: vi.fn().mockResolvedValue([followRow()]),
              updateReturning: vi.fn().mockResolvedValue([followRow()]),
            });
            const caller = createCaller(db) as any;

            await expect(caller[endpoint](endpointInput(endpoint, field, value)))
              .rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(db.insert).not.toHaveBeenCalled();
            expect(db.update).not.toHaveBeenCalled();
          });
        }
      }
    }

    for (const endpoint of endpoints) {
      for (const field of capFields) {
        it(`${endpoint} accepts ${field}=0.01 and preserves explicit null`, async () => {
          const db = createDb({
            insertReturning: vi.fn().mockResolvedValue([followRow()]),
            updateReturning: vi.fn().mockResolvedValue([followRow()]),
          });
          const caller = createCaller(db) as any;
          const otherField = field === "maxTradeSize" ? "maxCoinSize" : "maxTradeSize";
          const caps = { [field]: 0.01, [otherField]: null };
          const input = endpoint === "followWallet"
            ? {
                walletAddress: "0x0000000000000000000000000000000000000001",
                ...caps,
              }
            : {
                targetType: "x_author" as const,
                targetKey: "cathie wood",
                ...caps,
              };

          await caller[endpoint](input);

          const expected = field === "maxTradeSize"
            ? { maxTradeSize: "0.01", maxCoinSize: null }
            : { maxTradeSize: null, maxCoinSize: "0.01" };
          if (endpoint === "update") {
            expect(db.spies.updateSet).toHaveBeenCalledWith(expected);
          } else {
            expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining(expected));
          }
        });
      }
    }
  });

  /**
   * The sizing basis and its number share one stored value, so a patch that
   * moves the basis ALONE re-reads the saved number under a new unit: "usd 50"
   * ($50 an order) becomes "pct 50" (half the buying power). Per-mode bounds
   * cannot see it, because 50 is individually legal in both, so the only
   * checkable thing is the pair, against what is stored.
   */
  describe("a sizing-basis change must carry its own value", () => {
    function usdFifty() {
      return followRow({
        sizingMode: "usd",
        sizingValue: "50.00",
        autoMirror: true,
        credentialId: paperCredentialId,
      });
    }

    it("rejects a mode-only update that would reinterpret the saved number", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([usdFifty()]),
        credentialRow: paperCredential,
        updateReturning: vi.fn().mockResolvedValue([
          followRow({ sizingMode: "pct", sizingValue: "50.00" }),
        ]),
      });

      await expect(
        createCaller(db).update({
          targetType: "x_author",
          targetKey: "cathie wood",
          sizingMode: "pct",
        }),
      ).rejects.toThrow(/sizingValue/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects the silent-kill direction too: pct to usd, leaving 5 dollars an order", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([followRow({ sizingMode: "pct", sizingValue: "5.00" })]),
        updateReturning: vi.fn().mockResolvedValue([
          followRow({ sizingMode: "usd", sizingValue: "5.00" }),
        ]),
      });

      await expect(
        createCaller(db).update({
          targetType: "x_author",
          targetKey: "cathie wood",
          sizingMode: "usd",
        }),
      ).rejects.toThrow(/sizingValue/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("accepts the basis change when the caller states the number for it", async () => {
      const updated = followRow({ sizingMode: "pct", sizingValue: "5.00" });
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([usdFifty()]),
        credentialRow: paperCredential,
        updateReturning: vi.fn().mockResolvedValue([updated]),
      });

      const result = await createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        sizingMode: "pct",
        sizingValue: 5,
      });

      expect(db.spies.updateSet).toHaveBeenCalledWith({
        sizingMode: "pct",
        sizingValue: "5.00",
        destinationPolicyInitialized: true,
        stockAutoMirror: true,
        stockCredentialId: paperCredentialId,
        stockSizingMode: "pct",
        stockSizingValue: "5.00",
        perpAutoMirror: false,
        perpCredentialId: null,
        perpSizingMode: "pct",
        perpSizingValue: "5.00",
      });
      expect(result).toMatchObject({ sizingMode: "pct", sizingValue: 5 });
    });

    it("still allows a mode patch that restates the saved basis", async () => {
      // Not a reinterpretation: the unit is unchanged, so the saved number
      // still means exactly what the follower agreed to.
      const row = usdFifty();
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([row]),
        credentialRow: paperCredential,
        updateReturning: vi.fn().mockResolvedValue([row]),
      });

      await expect(
        createCaller(db).update({
          targetType: "x_author",
          targetKey: "cathie wood",
          sizingMode: "usd",
        }),
      ).resolves.toMatchObject({ sizingMode: "usd", sizingValue: 50 });
    });

    it("closes the same door on the follow upsert, which patches an existing row", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([usdFifty()]),
        credentialRow: paperCredential,
        insertReturning: vi.fn().mockResolvedValue([
          followRow({ sizingMode: "pct", sizingValue: "50.00" }),
        ]),
      });

      await expect(
        createCaller(db).follow({
          targetType: "x_author",
          targetKey: "cathie wood",
          sizingMode: "pct",
        }),
      ).rejects.toThrow(/sizingValue/i);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("leaves a brand-new follow free to name its basis: there is no saved number to reinterpret", async () => {
      const created = followRow({ sizingMode: "usd", sizingValue: "5.00" });
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([]),
        insertReturning: vi.fn().mockResolvedValue([created]),
      });

      await expect(
        createCaller(db).follow({
          targetType: "x_author",
          targetKey: "cathie wood",
          sizingMode: "usd",
        }),
      ).resolves.toMatchObject({ sizingMode: "usd" });
    });
  });

  /**
   * The perp exit is stored as PERCENT OF MARGIN, so unlike the sizing pair it
   * carries no basis that a partial patch could silently re-read: 25 means 25%
   * of margin under every other setting on the row, and nothing else on the row
   * changes what it means.
   *
   * What it DOES share with the sizing pair is the shape of the surprise. A
   * follower's stored stop is a standing instruction about their money, so
   * "field absent" and "field null" must not be the same request: a client that
   * omits the field when the user empties the box would leave a live stop in
   * place under a screen that shows none, and one that sends null on every save
   * would wipe a stop set from another device. The contract is stated here
   * because the router is what the worker reads back.
   */
  describe("the perp exit a follower attaches to mirrored positions", () => {
    function hyperliquidFollow(overrides: Partial<FollowRow> = {}) {
      return followRow({
        autoMirror: true,
        credentialId: hyperliquidCredentialId,
        ...overrides,
      });
    }

    it("stores a take-profit and a stop-loss as percent of margin", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([hyperliquidFollow()]),
        credentialRow: hyperliquidCredential,
        updateReturning: vi.fn().mockResolvedValue([
          hyperliquidFollow({ perpTakeProfitPct: "50.00", perpStopLossPct: "25.00" }),
        ]),
      });

      const result = await createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        perpTakeProfitPct: 50,
        perpStopLossPct: 25,
      });

      expect(db.spies.updateSet).toHaveBeenCalledWith({
        perpTakeProfitPct: "50.00",
        perpStopLossPct: "25.00",
      });
      expect(result).toMatchObject({ perpTakeProfitPct: 50, perpStopLossPct: 25 });
    });

    it("leaves a stored stop exactly where it is when the patch never mentions it", async () => {
      const stored = hyperliquidFollow({ perpStopLossPct: "25.00" });
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([stored]),
        credentialRow: hyperliquidCredential,
        updateReturning: vi.fn().mockResolvedValue([stored]),
      });

      await createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        sizingValue: 7,
      });

      expect(db.spies.updateSet).toHaveBeenCalledWith({
        sizingValue: "7.00",
        destinationPolicyInitialized: true,
        stockAutoMirror: false,
        stockCredentialId: null,
        stockSizingMode: "pct",
        stockSizingValue: "5.00",
        perpAutoMirror: true,
        perpCredentialId: hyperliquidCredentialId,
        perpSizingMode: "pct",
        perpSizingValue: "7.00",
      });
    });

    it("clears a stop only on an explicit null, never on an omitted field", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([hyperliquidFollow({ perpStopLossPct: "25.00" })]),
        credentialRow: hyperliquidCredential,
        updateReturning: vi.fn().mockResolvedValue([hyperliquidFollow()]),
      });

      const result = await createCaller(db).update({
        targetType: "x_author",
        targetKey: "cathie wood",
        perpStopLossPct: null,
      });

      expect(db.spies.updateSet).toHaveBeenCalledWith({ perpStopLossPct: null });
      expect(result).toMatchObject({ perpStopLossPct: null });
    });

    it("refuses a stop at the whole margin, which derives a trigger no venue can fire on", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([hyperliquidFollow()]),
        credentialRow: hyperliquidCredential,
      });

      await expect(
        createCaller(db).update({
          targetType: "x_author",
          targetKey: "cathie wood",
          perpStopLossPct: 100,
        }),
      ).rejects.toThrow(/perpStopLossPct/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("refuses a stop so tight the spread would take it out on placement", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([hyperliquidFollow()]),
        credentialRow: hyperliquidCredential,
      });

      await expect(
        createCaller(db).update({
          targetType: "x_author",
          targetKey: "cathie wood",
          perpStopLossPct: 0.1,
        }),
      ).rejects.toThrow(/perpStopLossPct/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("refuses a take-profit above the ceiling", async () => {
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([hyperliquidFollow()]),
        credentialRow: hyperliquidCredential,
      });

      await expect(
        createCaller(db).update({
          targetType: "x_author",
          targetKey: "cathie wood",
          perpTakeProfitPct: 5000,
        }),
      ).rejects.toThrow(/perpTakeProfitPct/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("lets a brand-new follow name its exit at creation time", async () => {
      const created = followRow({ perpStopLossPct: "25.00" });
      const db = createDb({
        selectRows: vi.fn().mockResolvedValue([]),
        insertReturning: vi.fn().mockResolvedValue([created]),
      });

      const result = await createCaller(db).follow({
        targetType: "x_author",
        targetKey: "cathie wood",
        perpStopLossPct: 25,
      });

      expect(db.spies.values).toHaveBeenCalledWith(
        expect.objectContaining({ perpStopLossPct: "25.00" }),
      );
      expect(result).toMatchObject({ perpStopLossPct: 25 });
    });
  });
});

describe("copy_trade_follows migration", () => {
  it("commits the table with safe auto-mirror and sizing defaults", () => {
    const migration = readCopyTradeFollowsMigration();
    const contents = migration?.contents ?? "";

    expect(contents).toContain('CREATE TABLE IF NOT EXISTS "copy_trade_follows"');
    expect(contents).toContain('"auto_mirror" boolean DEFAULT false NOT NULL');
    expect(contents).toContain('"sizing_mode" text DEFAULT \'pct\' NOT NULL');
    expect(contents).toMatch(/"sizing_value" numeric\(12,\s*2\) DEFAULT '5' NOT NULL/);
    expect(contents).toContain(
      'CONSTRAINT "copy_trade_follows_follower_target_unique" UNIQUE("follower_user_id","target_type","target_key")',
    );
  });

  it("adds the perp exit columns as nullable, so every existing follow keeps behaving as it did", () => {
    // OFF BY DEFAULT is the whole safety story for this feature. A default, or a
    // NOT NULL, would arm an exit on rows whose owner never asked for one.
    const migrations = readMigrationsContaining('"perp_take_profit_pct"');
    const contents = migrations.map((migration) => migration.contents).join("\n");

    expect(contents).toMatch(
      /ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_take_profit_pct" numeric\(6,\s*2\);/,
    );
    expect(contents).toMatch(
      /ALTER TABLE "copy_trade_follows" ADD COLUMN "perp_stop_loss_pct" numeric\(6,\s*2\);/,
    );
    expect(contents).not.toContain("perp_take_profit_pct\" numeric(6, 2) DEFAULT");
    expect(contents).not.toContain("perp_stop_loss_pct\" numeric(6, 2) NOT NULL");

    const table = getTableConfig(schema.copyTradeFollows);
    for (const name of ["perp_take_profit_pct", "perp_stop_loss_pct"]) {
      expect(table.columns.find((column) => column.name === name)?.notNull).toBe(false);
    }
  });

  it("indexes the unprotected-position backlog partially and concurrently", () => {
    // PARTIAL: the worker runs this scan every cycle and, unlike every other
    // read on `orders`, it is not scoped to a user. Without the partial
    // predicate it is a sequential scan of the whole table on a thirty-second
    // timer.
    //
    // CONCURRENTLY: `orders` is one of the largest tables in production, and a
    // plain CREATE INDEX holds a write lock for the whole scan, which on this
    // table means blocking live order writes. Postgres forbids CONCURRENTLY
    // inside a transaction, so this statement lives in its own migration (0034)
    // rather than beside 0033's ALTER TABLEs, carrying the `-- @no-transaction`
    // directive the forward runner reads to apply it outside one.
    const migrations = readMigrationsContaining("orders_perp_protection_unprotected_idx");
    const contents = migrations.map((migration) => migration.contents).join("\n");

    expect(contents).toContain("-- @no-transaction");
    expect(contents).toContain(
      'CREATE INDEX CONCURRENTLY "orders_perp_protection_unprotected_idx"',
    );
    // Dropped before it is created: a canceled concurrent build leaves an
    // INVALID index behind, and skipping on name alone would accept it.
    expect(contents).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "orders_perp_protection_unprotected_idx"',
    );
    expect(contents).toContain(`WHERE "orders"."perp_protection_status" = 'unprotected'`);
    // The lock-free build is only real if nothing transactional shares the
    // file, since one DDL statement needing a transaction forces the whole
    // migration into one. Comment lines are stripped first: the file explains
    // the split in prose, and matching that prose is not the same as matching
    // a statement.
    for (const migration of migrations) {
      const statements = migration.contents
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      expect(statements).not.toContain("ALTER TABLE");
    }
  });

  it("targets one nullable credential and fails closed for existing mirrors", () => {
    const table = getTableConfig(schema.copyTradeFollows);
    const credentialColumn = table.columns.find((column) => column.name === "credential_id");
    const credentialForeignKey = table.foreignKeys.find((foreignKey) =>
      foreignKey.reference().columns.some((column) => column.name === "credential_id"),
    );
    const credentialReference = credentialForeignKey?.reference();
    const migrations = readMigrationsContaining('ADD COLUMN "credential_id"');
    const contents = migrations.map((migration) => migration.contents).join("\n");

    expect(credentialColumn?.notNull).toBe(false);
    expect(credentialReference?.foreignTable).toBe(schema.userApiCredentials);
    expect(credentialReference?.foreignColumns[0]?.name).toBe("id");
    expect(credentialForeignKey?.onDelete).toBe("set null");
    expect(contents).toContain(
      'UPDATE "copy_trade_follows" SET "auto_mirror" = false WHERE "auto_mirror" = true',
    );
    expect(contents).toContain(
      'FOREIGN KEY ("credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null',
    );
  });

  it("adds independent destination consent and provider-matched legacy backfill", () => {
    const migrations = readMigrationsContaining('ADD COLUMN "stock_credential_id"');
    const contents = migrations.map((migration) => migration.contents).join("\n");
    const table = getTableConfig(schema.copyTradeFollows);

    for (const name of [
      "stock_credential_id",
      "stock_auto_mirror",
      "stock_sizing_mode",
      "stock_sizing_value",
      "perp_credential_id",
      "perp_auto_mirror",
      "perp_sizing_mode",
      "perp_sizing_value",
      "destination_policy_initialized",
    ]) {
      expect(table.columns.find((column) => column.name === name)).toBeTruthy();
      expect(contents).toContain(`"${name}"`);
    }
    for (const name of [
      "copy_trade_follows_stock_auto_mirror_created_at_id_idx",
      "copy_trade_follows_perp_auto_mirror_created_at_id_idx",
    ]) {
      expect(table.indexes.some((index) => index.config.name === name)).toBe(true);
      expect(contents).toContain(name);
    }
    expect(contents).toContain("credentials.provider = 'alpaca'");
    expect(contents).toContain("credentials.provider = 'hyperliquid'");
    expect(contents).toContain("credentials.account_type IN ('PAPER', 'LIVE')");
    expect(contents).toContain("credentials.account_type = 'LIVE'");
    expect(contents).toContain('credentials."user_id" = follows."follower_user_id"');
    expect(contents).toContain("follows.\"sizing_mode\" = 'pct'");
    for (const name of [
      "copy_trade_follows_auto_mirror_valid_check",
      "copy_trade_follows_stock_auto_mirror_valid_check",
      "copy_trade_follows_perp_auto_mirror_valid_check",
    ]) expect(contents).toContain(name);
    expect(contents).toContain(
      'FOREIGN KEY ("stock_credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null',
    );
    expect(contents).toContain(
      'FOREIGN KEY ("perp_credential_id") REFERENCES "public"."user_api_credentials"("id") ON DELETE set null',
    );
  });
});

describe("orders smart-exit migration", () => {
  it("commits the exit plan columns read by the worker", () => {
    const migrations = readMigrationsContaining('"exit_plan"');
    const contents = migrations.map((migration) => migration.contents).join("\n");

    expect(contents).toContain('CREATE TYPE "public"."exit_plan_status"');
    expect(contents).toContain('ALTER TABLE "orders" ADD COLUMN "exit_plan" jsonb');
    expect(contents).toContain('ALTER TABLE "orders" ADD COLUMN "exit_plan_status"');
    expect(contents).toContain('ALTER TABLE "orders" ADD COLUMN "exit_plan_error" text');
  });

  it("adds immutable verified manual-copy provenance columns without a source FK", () => {
    const migrations = readMigrationsContaining('"manual_copy_source_item_id"');
    const contents = migrations.map((migration) => migration.contents).join("\n");
    const table = getTableConfig(schema.orders);

    expect(table.columns.find((column) => column.name === "manual_copy_source_item_id")?.notNull).toBe(false);
    expect(table.columns.find((column) => column.name === "manual_copy_source_order_id")?.notNull).toBe(false);
    expect(contents).toContain('ALTER TABLE "orders" ADD COLUMN "manual_copy_source_item_id" text');
    expect(contents).toContain('ALTER TABLE "orders" ADD COLUMN "manual_copy_source_order_id" uuid');
    expect(contents).not.toContain('FOREIGN KEY ("manual_copy_source_order_id")');
  });
});

describe("followTarget mapping", () => {
  it("uses an immutable source key while retaining old aliases for follows", () => {
    const out = mapSignalToItem({
      id: "signal-canonical",
      symbol: "AAPL",
      content: "$AAPL",
      url: null,
      timestamp: now,
      metadata: {
        authorSource: "x",
        sourceAuthorId: "42",
        canonicalAuthorKey: "source_author:x:42",
        authorName: "New Name",
        authorAliases: ["new name", "old name"],
      },
    });

    expect(out.followTarget).toEqual({
      type: "x_author",
      key: "source_author:x:42",
      label: "New Name",
    });
    expect(signalAuthorFollowKeys(out.meta)).not.toContain("source_author:x:42");
    expect(signalAuthorFollowKeys({
      authorSource: "x",
      sourceAuthorId: "42",
      canonicalAuthorKey: "source_author:x:42",
      authorName: "New Name",
      authorAliases: ["new name", "old name"],
    })).toEqual(expect.arrayContaining(["source_author:x:42", "source_alias:x:old%20name"]));
    expect(signalAuthorFollowKeys({
      authorSource: "x",
      canonicalAuthorKey: "source_author:x:1",
      authorName: "Shared",
      authorAliases: ["shared"],
    }, [
      { source: "x", metadata: { canonicalAuthorKey: "source_author:x:1", authorName: "Shared", authorAliases: ["shared"] } },
      { source: "x", metadata: { canonicalAuthorKey: "source_author:x:2", authorName: "Shared", authorAliases: ["shared"] } },
    ])).not.toContain("source_alias:x:shared");
  });

  it("mapSignalToItem sets an x_author followTarget from the normalized author", () => {
    const out = mapSignalToItem({
      id: "sig-1",
      symbol: "AAPL",
      content: "buying",
      url: null,
      timestamp: new Date("2026-06-09T10:00:00.000Z"),
      metadata: { authorName: "Cathie Wood • TweetShift" },
    });
    expect(out.followTarget).toEqual({
      type: "x_author",
      key: "cathie wood", // TweetShift suffix stripped, then normalized
      label: "Cathie Wood",
    });
  });

  it("mapSignalToItem yields a null followTarget for an Unknown author", () => {
    const out = mapSignalToItem({
      id: "sig-2",
      symbol: "TSLA",
      content: null,
      url: null,
      timestamp: "2026-06-09T10:00:00.000Z",
      metadata: "{}",
    });
    expect(out.displayName).toBe("Unknown");
    expect(out.followTarget).toBeNull();
  });

  it("does not create a follow target or compatibility key for a relay row", () => {
    const out = mapSignalToItem({
      id: "relay-signal",
      source: "discord",
      symbol: "AAPL",
      content: "$AAPL",
      url: null,
      timestamp: new Date("2026-07-31T12:00:00.000Z"),
      metadata: {
        authorId: "relay-webhook",
        authorName: "TweetShift",
        authorIdentityKind: "relay",
        authorSource: "discord",
      },
    });

    expect(out.followTarget).toBeNull();
    expect(signalAuthorFollowKeys(out.meta, [out.meta], "discord")).toEqual([]);
  });

  it("mapUserTradeToItem sets a user followTarget keyed by traderKey (never the raw user id)", () => {
    const out = mapUserTradeToItem(
      {
        id: "trade-1",
        userId: "real-user-9",
        symbol: "NVDA",
        orderId: "order-follow-target",
        orderSymbol: "NVDA",
        orderAssetType: "EQUITY",
        tradeAction: "Buy",
        direction: "long",
        side: "buy",
        qty: 10,
        orderType: "market",
        assetType: "EQUITY",
        limitPrice: null,
        fillPrice: null,
        createdAt: new Date("2026-06-09T09:00:00.000Z"),
      },
      anonymizeTrader,
    );
    const expected = anonymizeTrader("real-user-9").traderName;
    expect(out.followTarget).toEqual({
      type: "user",
      key: traderKey("real-user-9"),
      label: expected,
    });
    // The raw user id must NEVER appear anywhere in the serialized item.
    expect(JSON.stringify(out)).not.toContain("real-user-9");
  });
});
