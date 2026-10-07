import { describe, expect, it, vi } from "bun:test";
import { schema } from "@trade-bot/db";

import { copyTradeFollowsRouter } from "../routers/copy-trade-follows";

const stockCredentialId = "00000000-0000-4000-8000-000000000201";
const perpCredentialId = "00000000-0000-4000-8000-000000000202";

const stockCredential = {
  id: stockCredentialId,
  userId: "user-1",
  provider: "alpaca",
  accountId: "PA-201",
  accountType: "PAPER",
};
const perpCredential = {
  id: perpCredentialId,
  userId: "user-1",
  provider: "hyperliquid",
  accountId: "0x201",
  accountType: "LIVE",
};

function row() {
  return {
    id: "00000000-0000-4000-8000-000000000211",
    followerUserId: "user-1",
    targetType: "x_author",
    targetKey: "trader",
    targetLabel: "Trader",
    sizingMode: "pct",
    sizingValue: "5.00",
    autoMirror: false,
    credentialId: null,
    stockAutoMirror: true,
    stockCredentialId,
    stockSizingMode: "usd",
    stockSizingValue: "125.00",
    perpAutoMirror: true,
    perpCredentialId,
    perpSizingMode: "ratio",
    perpSizingValue: "2.00",
    destinationPolicyInitialized: true,
    perpMaxLeverage: null,
    perpTakeProfitPct: null,
    perpStopLossPct: null,
    createdAt: new Date("2026-09-05T12:00:00.000Z"),
  };
}

function dbFor(returned = row(), credentials = [stockCredential, perpCredential]) {
  const where = vi.fn().mockResolvedValue([]);
  const insertReturning = vi.fn().mockResolvedValue([returned]);
  const values = vi.fn().mockReturnValue({
    onConflictDoUpdate: vi.fn().mockReturnValue({ returning: insertReturning }),
  });
  let credentialLookups = 0;
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where }),
    }),
    insert: vi.fn().mockReturnValue({ values }),
    query: {
      userApiCredentials: {
        findFirst: vi.fn(async (input?: { where?: unknown }) => {
          credentialLookups += 1;
          const query = JSON.stringify(input?.where ?? "") ?? "";
          if (query.includes(stockCredentialId)) return stockCredential;
          if (query.includes(perpCredentialId)) return perpCredential;
          return credentialLookups === 2 ? perpCredential : stockCredential;
        }),
        findMany: vi.fn().mockResolvedValue(credentials),
      },
    },
    spies: { values, insertReturning },
  };
}

function caller(db: any) {
  return copyTradeFollowsRouter.createCaller({
    db,
    userId: "user-1",
    session: { userId: "user-1" },
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as any,
  });
}

function transactionalDbFor(options: {
  current: ReturnType<typeof row>;
  returned?: ReturnType<typeof row>;
  credentials?: Array<typeof stockCredential | typeof perpCredential>;
  findCredential?: (input: { where?: unknown } | undefined, call: number) => unknown;
}) {
  const returned = options.returned ?? options.current;
  const credentials = options.credentials ?? [stockCredential, perpCredential];
  let credentialLookupCount = 0;
  const credentialFindFirst = vi.fn(async (input?: { where?: unknown }) => {
    credentialLookupCount += 1;
    if (options.findCredential) return options.findCredential(input, credentialLookupCount);
    const query = JSON.stringify(input?.where ?? "") ?? "";
    if (query.includes(stockCredentialId)) return stockCredential;
    if (query.includes(perpCredentialId)) return perpCredential;
    return undefined;
  });
  const credentialFindMany = vi.fn().mockResolvedValue(credentials);
  const insertReturning = vi.fn().mockResolvedValue([returned]);
  const values = vi.fn().mockReturnValue({
    onConflictDoUpdate: vi.fn().mockReturnValue({ returning: insertReturning }),
  });
  const insert = vi.fn().mockReturnValue({ values });
  const updateReturning = vi.fn().mockResolvedValue([returned]);
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: updateReturning }),
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  let selectCall = 0;
  const select = vi.fn((projection?: unknown) => {
    selectCall += 1;
    let table: unknown;
    const query: any = {
      from: vi.fn((selectedTable: unknown) => {
        table = selectedTable;
        return query;
      }),
      where: vi.fn(() => query),
      for: vi.fn(async () => [{ id: "user-1", copyPerpMaxLeverage: 10 }]),
      // eslint-disable-next-line unicorn/no-thenable
      then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
        const rows = table === schema.copyTradeFollows && projection !== undefined
          ? [{ count: "0" }]
          : table === schema.copyTradeFollows
            ? [options.current]
            : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx));
  const tx = {
    select,
    insert,
    update,
    query: {
      userApiCredentials: {
        findFirst: credentialFindFirst,
        findMany: credentialFindMany,
      },
    },
  };

  return {
    transaction,
    select,
    insert,
    update,
    query: tx.query,
    spies: { values, insertReturning, updateSet, updateReturning, credentialFindFirst },
  };
}

describe("independent copy mirror destinations API", () => {
  for (const accountId of [null, "", "  "]) {
    for (const method of ["follow", "update"] as const) {
      for (const enabled of [false, true]) {
        it(`${method} rejects unidentified Alpaca selection (identity ${JSON.stringify(accountId)}, enabled ${enabled})`, async () => {
          const db = transactionalDbFor({
            current: { ...row(), stockCredentialId: null, stockAutoMirror: false },
            findCredential: () => ({ ...stockCredential, accountId }),
          });
          await expect(caller(db)[method]({
            targetType: "x_author", targetKey: "trader",
            destinations: { stock: { enabled, credentialId: stockCredentialId, sizingMode: "pct", sizingValue: 5 } },
          })).rejects.toThrow(/selected mirror account is unavailable or not ready/i);
          expect(db.insert).not.toHaveBeenCalled();
          expect(db.update).not.toHaveBeenCalled();
        });
      }
    }
  }

  it("rejects explicit re-arming of a saved unidentified Alpaca destination", async () => {
    const db = transactionalDbFor({ current: { ...row(), stockAutoMirror: false }, findCredential: () => ({ ...stockCredential, accountId: null }) });
    await expect(caller(db).update({ targetType: "x_author", targetKey: "trader", destinations: { stock: { enabled: true, credentialId: stockCredentialId, sizingMode: "pct", sizingValue: 5 } } })).rejects.toThrow(/not ready/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("permits Stop while retaining the saved unidentified Alpaca UUID and perp policy", async () => {
    const db = transactionalDbFor({ current: row(), findCredential: () => ({ ...stockCredential, accountId: null }) });
    await caller(db).update({ targetType: "x_author", targetKey: "trader", destinations: { stock: { enabled: false, credentialId: stockCredentialId, sizingMode: "pct", sizingValue: 5 } } });
    expect(db.spies.updateSet).toHaveBeenCalledWith(expect.objectContaining({ stockAutoMirror: false, stockCredentialId }));
    const written = db.spies.updateSet.mock.calls[0][0];
    expect(written.perpAutoMirror).toBe(true);
    expect(written.perpCredentialId).toBe(perpCredentialId);
    expect(written.perpSizingMode).toBe("ratio");
    expect(written.perpSizingValue).toBe("2.00");
  });

  it.each([false, true])("legacy Alpaca arming %s preserves Stop but refuses enabling", async (autoMirror) => {
    const db = transactionalDbFor({ current: { ...row(), destinationPolicyInitialized: false, autoMirror: true, credentialId: stockCredentialId }, findCredential: () => ({ ...stockCredential, accountId: null }) });
    const action = caller(db).update({ targetType: "x_author", targetKey: "trader", autoMirror });
    if (autoMirror) {
      await expect(action).rejects.toThrow(/not ready/i);
      expect(db.update).not.toHaveBeenCalled();
    } else {
      await action;
      expect(db.spies.updateSet).toHaveBeenCalledWith(expect.objectContaining({ autoMirror: false, stockCredentialId }));
      expect(db.spies.updateSet.mock.calls[0][0].credentialId).toBeUndefined();
    }
  });

  it("does not impose Alpaca identity requirements on Hyperliquid", async () => {
    const db = transactionalDbFor({ current: row(), findCredential: () => ({ ...perpCredential, accountId: null }) });
    await caller(db).update({ targetType: "x_author", targetKey: "trader", destinations: { perp: { enabled: true, credentialId: perpCredentialId, sizingMode: "ratio", sizingValue: 2 } } });
    expect(db.spies.updateSet).toHaveBeenCalledWith(expect.objectContaining({ perpAutoMirror: true, perpCredentialId }));
  });

  it.each(["follow", "update"] as const)("%s permits unrelated edits to a saved unidentified legacy link", async (method) => {
    const db = transactionalDbFor({ current: { ...row(), destinationPolicyInitialized: false, autoMirror: true, credentialId: stockCredentialId }, findCredential: () => ({ ...stockCredential, accountId: null }) });
    await expect(caller(db)[method]({ targetType: "x_author", targetKey: "trader", sizingValue: 8 })).resolves.toBeTruthy();
    const written = method === "follow" ? db.spies.values.mock.calls[0][0] : db.spies.updateSet.mock.calls[0][0];
    expect(written.stockCredentialId).toBe(stockCredentialId);
    expect(written.stockAutoMirror).toBe(true);
  });

  it("persists independent stock/perp consent and sizing", async () => {
    const db = dbFor();
    const result = await caller(db).follow({
      targetType: "x_author",
      targetKey: "trader",
      destinations: {
        stock: {
          enabled: true,
          credentialId: stockCredentialId,
          sizingMode: "usd",
          sizingValue: 125,
        },
        perp: {
          enabled: true,
          credentialId: perpCredentialId,
          sizingMode: "ratio",
          sizingValue: 2,
        },
      },
    });

    expect(db.spies.values).toHaveBeenCalledWith(expect.objectContaining({
      stockAutoMirror: true,
      stockCredentialId,
      stockSizingMode: "usd",
      stockSizingValue: "125.00",
      perpAutoMirror: true,
      perpCredentialId,
      perpSizingMode: "ratio",
      perpSizingValue: "2.00",
      autoMirror: false,
      destinationPolicyInitialized: true,
    }));
    expect(result).toMatchObject({
      destinations: {
        stock: { enabled: true, credentialId: stockCredentialId, sizingValue: 125 },
        perp: { enabled: true, credentialId: perpCredentialId, sizingValue: 2 },
      },
    });
  });

  it("rejects a credential from the wrong provider for its destination", async () => {
    const db = dbFor();
    await expect(caller(db).follow({
      targetType: "x_author",
      targetKey: "trader",
      destinations: {
        perp: {
          enabled: true,
          credentialId: stockCredentialId,
          sizingMode: "pct",
          sizingValue: 5,
        },
      },
    })).rejects.toThrow(/selected mirror account is unavailable or not ready/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("does not revalidate an unrelated stale legacy credential for a nested update", async () => {
    const current = {
      ...row(),
      autoMirror: true,
      credentialId: "00000000-0000-4000-8000-000000000299",
      perpAutoMirror: false,
      perpCredentialId: null,
    };
    const db = transactionalDbFor({
      current,
      findCredential: (_input, call) => call === 1 ? perpCredential : undefined,
    });

    await expect(caller(db).update({
      targetType: "x_author",
      targetKey: "trader",
      destinations: {
        perp: {
          enabled: true,
          credentialId: perpCredentialId,
          sizingMode: "ratio",
          sizingValue: 2,
        },
      },
    })).resolves.toBeTruthy();

    expect(db.spies.credentialFindFirst).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("can disarm a stale saved destination and clears its unavailable credential", async () => {
    const staleCredentialId = "00000000-0000-4000-8000-000000000298";
    const current = {
      ...row(),
      stockAutoMirror: true,
      stockCredentialId: staleCredentialId,
    };
    const db = transactionalDbFor({ current, credentials: [] });

    await expect(caller(db).update({
      targetType: "x_author",
      targetKey: "trader",
      destinations: {
        stock: {
          enabled: false,
          credentialId: staleCredentialId,
          sizingMode: "pct",
          sizingValue: 5,
        },
      },
    })).resolves.toBeTruthy();

    expect(db.spies.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      stockAutoMirror: false,
      stockCredentialId: null,
    }));
  });

  it("still rejects a foreign or newly supplied credential on a disabled destination", async () => {
    const foreignCredentialId = "00000000-0000-4000-8000-000000000297";
    const db = transactionalDbFor({ current: row(), credentials: [] });

    await expect(caller(db).update({
      targetType: "x_author",
      targetKey: "trader",
      destinations: {
        stock: {
          enabled: false,
          credentialId: foreignCredentialId,
          sizingMode: "pct",
          sizingValue: 5,
        },
      },
    })).rejects.toThrow(/selected mirror account is unavailable or not ready/i);
    expect(db.update).not.toHaveBeenCalled();
  });
});
