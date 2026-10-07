import { describe, expect, it, vi } from "bun:test";

const { userSettingsRouter } = await import("../routers/user-settings.js");

const USER_ID = "user-1";

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

type UserRow = { id: string; copyPerpMaxLeverage: number };

function createDb(options: {
  user?: UserRow;
  selectRows?: UserRow[];
  transaction?: boolean;
  clampedFollowRows?: Array<{ id: string }>;
} = {}) {
  const user = options.user ?? { id: USER_ID, copyPerpMaxLeverage: 1 };
  const events: string[] = [];
  const clampedFollowRows = options.clampedFollowRows ?? [];
  const clampReturning = vi.fn(async () => clampedFollowRows);
  const updateSet = vi.fn((values: Record<string, unknown>) => ({
    where: vi.fn(() => {
      events.push(`update:${JSON.stringify(values)}`);
      const result = Promise.resolve();
      (result as Promise<void> & { returning?: typeof clampReturning }).returning =
        clampReturning;
      return result;
    }),
  }));
  const update = vi.fn(() => ({ set: updateSet }));

  const select = vi.fn(() => {
    const rows = options.selectRows ?? [user];
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      for: vi.fn((mode: string) => {
        events.push(`lock:${mode}`);
        return Promise.resolve(rows);
      }),
    };
    return query;
  });

  const findFirst = vi.fn().mockResolvedValue(user);
  const db: any = {
    select,
    update,
    query: { users: { findFirst } },
    events,
  };
  if (options.transaction ?? true) {
    db.transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db));
  }
  return {
    db,
    spies: {
      findFirst,
      select,
      update,
      updateSet,
      clampReturning,
      transaction: db.transaction,
    },
  };
}

function createCaller(db: unknown, userId = USER_ID) {
  return userSettingsRouter.createCaller({
    db,
    session: { userId },
    userId,
    logger: createLogger(),
  } as never);
}

describe("copy-trading global perp leverage settings", () => {
  it("returns the safe default global cap for a newly initialized user", async () => {
    const { db } = createDb({ user: { id: USER_ID, copyPerpMaxLeverage: 1 } });

    await expect(createCaller(db).getCopyPerpLeverageSettings()).resolves.toEqual({
      globalPerpMaxLeverage: 1,
    });
  });

  it("sets a valid global cap for only the authenticated user", async () => {
    const { db, spies } = createDb();

    await expect(
      createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: 7 }),
    ).resolves.toEqual({ globalPerpMaxLeverage: 7, clampedFollowCount: 0 });

    expect(spies.updateSet).toHaveBeenCalledWith({ copyPerpMaxLeverage: 7 });
    expect(spies.transaction).toHaveBeenCalledTimes(1);
  });

  it("returns zero when the actual clamp update affects no follow rows", async () => {
    const { db, spies } = createDb({ clampedFollowRows: [] });

    await expect(
      createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: 3 }),
    ).resolves.toEqual({ globalPerpMaxLeverage: 3, clampedFollowCount: 0 });

    expect(spies.clampReturning).toHaveBeenCalledTimes(1);
  });

  it("returns the exact number of follow rows returned by the clamp update", async () => {
    const { db, spies } = createDb({
      clampedFollowRows: [{ id: "follow-1" }, { id: "follow-2" }, { id: "follow-3" }],
    });

    await expect(
      createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: 2 }),
    ).resolves.toEqual({ globalPerpMaxLeverage: 2, clampedFollowCount: 3 });

    expect(spies.clampReturning).toHaveBeenCalledTimes(1);
  });

  it.each([0, 101])("rejects a global cap outside 1..100: %s", async (value) => {
    const { db, spies } = createDb();

    await expect(
      createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: value }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spies.transaction).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
  });

  it("locks the owned user row before changing global policy and clamps follows in one transaction", async () => {
    const { db } = createDb({ user: { id: USER_ID, copyPerpMaxLeverage: 9 } });

    await createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: 3 });

    expect(db.events).toEqual([
      "lock:update",
      'update:{"copyPerpMaxLeverage":3}',
      'update:{"perpMaxLeverage":3}',
    ]);
    expect(db.events[0]).toBe("lock:update");
    expect(db.events[1]).toContain("copyPerpMaxLeverage");
    expect(db.events[2]).toContain("perpMaxLeverage");
  });

  it("rejects a missing authenticated user instead of inventing a default", async () => {
    const { db } = createDb({ selectRows: [] });

    await expect(
      createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: 2 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("fails closed when the global policy write has no transaction", async () => {
    const { db, spies } = createDb({ transaction: false });

    await expect(
      createCaller(db).setCopyPerpMaxLeverage({ globalPerpMaxLeverage: 2 }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(spies.update).not.toHaveBeenCalled();
  });
});
