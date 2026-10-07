import { beforeEach, describe, expect, it, vi } from "bun:test";

const getRedisClient = vi.fn();

vi.mock("@trade-bot/redis", () => ({
  getRedisClient,
}));

const { watchlistRouter } = await import("../routers/watchlist.js");

type WatchlistRow = {
  id: string;
  userId: string;
  symbol: string;
  venue: "stocks" | "perps";
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

const now = new Date("2026-06-04T12:00:00.000Z");

function row(
  id: string,
  userId: string,
  symbol: string,
  sortOrder: number,
  venue: "stocks" | "perps" = "stocks",
): WatchlistRow {
  return {
    id,
    userId,
    symbol,
    venue,
    sortOrder,
    createdAt: now,
    updatedAt: now,
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
  return watchlistRouter.createCaller({
    db,
    session: { userId },
    userId,
    logger: createLogger() as any,
  });
}

function createDb(overrides: Partial<{
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  insertReturning: ReturnType<typeof vi.fn>;
  selectRows: ReturnType<typeof vi.fn>;
  userFindFirst: ReturnType<typeof vi.fn>;
}> = {}) {
  const returning = overrides.insertReturning || vi.fn().mockResolvedValue([]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ returning, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  const deleteWhere = vi.fn().mockResolvedValue({});
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const updateWhere = vi.fn().mockResolvedValue({});
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const selectWhere = vi.fn().mockImplementation(async () => {
    if (overrides.selectRows) return overrides.selectRows();
    return [];
  });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const db: any = {
    query: {
      users: {
        findFirst:
          overrides.userFindFirst ||
          vi.fn().mockResolvedValue({ watchlistInitialized: true }),
      },
      userWatchlistItems: {
        findMany: overrides.findMany || vi.fn().mockResolvedValue([]),
        findFirst: overrides.findFirst || vi.fn().mockResolvedValue(null),
      },
    },
    insert,
    delete: deleteFn,
    update,
    select,
    spies: {
      values,
      onConflictDoNothing,
      deleteWhere,
      updateSet,
      updateWhere,
      selectWhere,
    },
  };

  // reorder() runs inside ctx.db.transaction(); the tx exposes the same query
  // builders, so hand the callback the same mock db.
  db.transaction = vi.fn().mockImplementation(async (cb: any) => cb(db));

  return db;
}

describe("watchlistRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
    });
  });

  it("lists only the signed-in user's watchlist in display order", async () => {
    const rows = [
      row("00000000-0000-4000-8000-000000000003", "user-2", "TSLA", 0),
      row("00000000-0000-4000-8000-000000000002", "user-1", "MSFT", 1),
      row("00000000-0000-4000-8000-000000000001", "user-1", "AAPL", 0),
    ];
    const db = createDb({
      findMany: vi.fn().mockResolvedValue(
        rows
          .filter((item) => item.userId === "user-1")
          .sort((a, b) => a.sortOrder - b.sortOrder)
      ),
    });

    const result = await createCaller(db).list();

    expect(result.map((item) => item.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("seeds the seven mixed-venue defaults only before initialization", async () => {
    const defaults = [
      row("00000000-0000-4000-8000-000000000011", "user-1", "SPY", 0),
      row("00000000-0000-4000-8000-000000000012", "user-1", "QQQ", 1),
      row("00000000-0000-4000-8000-000000000013", "user-1", "IWM", 2),
      row("00000000-0000-4000-8000-000000000014", "user-1", "DIA", 3),
      row("00000000-0000-4000-8000-000000000015", "user-1", "BTC", 4, "perps"),
      row("00000000-0000-4000-8000-000000000016", "user-1", "ETH", 5, "perps"),
      row("00000000-0000-4000-8000-000000000017", "user-1", "SOL", 6, "perps"),
    ];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(defaults);
    const db = createDb({
      findMany,
      userFindFirst: vi
        .fn()
        .mockResolvedValue({ watchlistInitialized: false }),
    });

    const result = await createCaller(db).list();

    expect(result.map(({ symbol, venue }) => `${venue}:${symbol}`)).toEqual([
      "stocks:SPY",
      "stocks:QQQ",
      "stocks:IWM",
      "stocks:DIA",
      "perps:BTC",
      "perps:ETH",
      "perps:SOL",
    ]);
    expect(db.spies.values).toHaveBeenCalledWith([
      { userId: "user-1", symbol: "SPY", venue: "stocks", sortOrder: 0 },
      { userId: "user-1", symbol: "QQQ", venue: "stocks", sortOrder: 1 },
      { userId: "user-1", symbol: "IWM", venue: "stocks", sortOrder: 2 },
      { userId: "user-1", symbol: "DIA", venue: "stocks", sortOrder: 3 },
      { userId: "user-1", symbol: "BTC", venue: "perps", sortOrder: 4 },
      { userId: "user-1", symbol: "ETH", venue: "perps", sortOrder: 5 },
      { userId: "user-1", symbol: "SOL", venue: "perps", sortOrder: 6 },
    ]);
  });

  it("normalizes a new symbol to uppercase and appends it after the last item", async () => {
    const created = row("00000000-0000-4000-8000-000000000004", "user-1", "NVDA", 2);
    const db = createDb({
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row("00000000-0000-4000-8000-000000000002", "user-1", "MSFT", 1)),
      insertReturning: vi.fn().mockResolvedValue([created]),
    });

    const result = await createCaller(db).add({ symbol: "nvda" });

    expect(result).toMatchObject({ alreadyExists: false, item: { symbol: "NVDA", sortOrder: 2 } });
    expect(db.spies.values).toHaveBeenCalledWith({
      userId: "user-1",
      symbol: "NVDA",
      venue: "stocks",
      sortOrder: 2,
    });
  });

  it("keeps stock and perp symbols distinct and returns their venue", async () => {
    const created = row(
      "00000000-0000-4000-8000-000000000005",
      "user-1",
      "SOL",
      2,
      "perps",
    );
    const db = createDb({
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          row("00000000-0000-4000-8000-000000000002", "user-1", "SOL", 1),
        ),
      insertReturning: vi.fn().mockResolvedValue([created]),
    });

    const result = await createCaller(db).add({ symbol: "SOL", venue: "perps" });

    expect(result.item).toMatchObject({ symbol: "SOL", venue: "perps" });
    expect(db.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "SOL", venue: "perps" }),
    );
  });

  it("returns the existing row instead of duplicating a saved symbol", async () => {
    const existing = row("00000000-0000-4000-8000-000000000001", "user-1", "AAPL", 0);
    const db = createDb({
      findFirst: vi.fn().mockResolvedValueOnce(existing),
    });

    const result = await createCaller(db).add({ symbol: "aapl" });

    expect(result).toMatchObject({ alreadyExists: true, item: { symbol: "AAPL" } });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("removes a watchlist item through a user-scoped delete", async () => {
    const db = createDb();

    await expect(
      createCaller(db).remove({ itemId: "00000000-0000-4000-8000-000000000001" })
    ).resolves.toEqual({ success: true });

    expect(db.delete).toHaveBeenCalled();
    expect(db.spies.deleteWhere).toHaveBeenCalled();
  });

  it("reorders owned watchlist items", async () => {
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([
        { id: "00000000-0000-4000-8000-000000000001" },
        { id: "00000000-0000-4000-8000-000000000002" },
      ]),
    });

    await expect(
      createCaller(db).reorder({
        itemIds: [
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000001",
        ],
      })
    ).resolves.toEqual({ success: true });

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.spies.updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sortOrder: 0 })
    );
    expect(db.spies.updateSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sortOrder: 1 })
    );
  });

  it("rejects reorder when an item is not owned by the signed-in user", async () => {
    const db = createDb({
      selectRows: vi.fn().mockResolvedValue([
        { id: "00000000-0000-4000-8000-000000000001" },
      ]),
    });

    await expect(
      createCaller(db).reorder({
        itemIds: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ],
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects reorder when item IDs are not unique", async () => {
    const db = createDb();

    await expect(
      createCaller(db).reorder({
        itemIds: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000001",
        ],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid ticker symbol before touching the database", async () => {
    const db = createDb();

    await expect(createCaller(db).add({ symbol: "1AAPL" })).rejects.toThrow();
    await expect(createCaller(db).add({ symbol: "AAPL." })).rejects.toThrow();
    await expect(createCaller(db).add({ symbol: "AA--PL" })).rejects.toThrow();

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects remove when itemId is not a valid uuid", async () => {
    const db = createDb();

    await expect(createCaller(db).remove({ itemId: "not-a-uuid" })).rejects.toThrow();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("recovers from a unique-index race by returning the existing row", async () => {
    const existing = row("00000000-0000-4000-8000-000000000009", "user-1", "AAPL", 0);
    const db = createDb({
      // duplicate pre-check misses (concurrent add not yet visible), insert
      // hits the unique index and returns nothing, then the post-conflict
      // re-fetch finds the row the other request committed.
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing),
      insertReturning: vi.fn().mockResolvedValue([]),
    });

    const result = await createCaller(db).add({ symbol: "aapl" });

    expect(result).toMatchObject({ alreadyExists: true, item: { symbol: "AAPL" } });
    expect(db.spies.onConflictDoNothing).toHaveBeenCalled();
  });
});
