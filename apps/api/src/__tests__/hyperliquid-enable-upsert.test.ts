/**
 * H2 duplicate-credential race: hyperliquid.enable upsert-or-refetch.
 *
 * `enable` is find-then-insert; two tabs auto-firing concurrently could both
 * pass the find. The fix is a partial unique index on (user_id, provider)
 * WHERE provider='hyperliquid' (migration 0018) plus insert
 * .onConflictDoNothing() and a re-read, so the losing tab RETURNS THE
 * WINNER'S ROW instead of erroring or minting a second agent.
 *
 * Real-module test through the actual router procedure (createCaller) with a
 * mock db; only the Privy-touching seams (agent provisioning + the H1
 * ownership check) are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "bun:test";

// encrypt() (used by the real walletRefsToCredentialRow) needs a key; any
// 64-hex-char value works for tests.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

const getRedisClient = vi.fn();
vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const actualHl = await import("../lib/hyperliquid.js");
const provisionMock = vi.fn();
const verifyOwnershipMock = vi.fn();
vi.mock("../lib/hyperliquid.js", () => ({
  ...actualHl,
  provisionHyperliquidAgentWallet: provisionMock,
  verifyEmbeddedMasterOwnership: verifyOwnershipMock,
}));

const { hyperliquidRouter } = await import("../routers/hyperliquid.js");

const USER_ID = "user-1";
const MASTER = "0xAbCd000000000000000000000000000000001234";
const OTHER_MASTER = "0x3333333333333333333333333333333333333333";
const OUR_AGENT = "0x1111111111111111111111111111111111111111";
const WINNER_AGENT = "0x2222222222222222222222222222222222222222";

function credentialRow(agentAddress: string) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: USER_ID,
    provider: "hyperliquid",
    encryptedAccessToken: "enc",
    encryptedRefreshToken: "enc",
    accountId: MASTER,
    accountType: "PENDING",
    username: MASTER,
    baseUrl: agentAddress,
    expiresAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

/**
 * Mock db: findFirst results are consumed in call order (pre-check, locked
 * re-read, then post-insert read); inserts record the conflict-tolerant path.
 */
function createDb(findFirstResults: Array<unknown>) {
  const findFirst = vi.fn().mockImplementation(async () => findFirstResults.shift());
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  const lockRow = vi.fn().mockResolvedValue([{ id: USER_ID }]);
  const whereLockRow = vi.fn().mockReturnValue({ for: lockRow });
  const fromUsers = vi.fn().mockReturnValue({ where: whereLockRow });
  const select = vi.fn().mockReturnValue({ from: fromUsers });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(db),
  );
  const db: any = {
    query: { userApiCredentials: { findFirst } },
    insert,
    select,
    transaction,
  };
  return {
    ...db,
    spies: { findFirst, insert, values, onConflictDoNothing, transaction },
  };
}

function createCompetingEnableDb() {
  let releaseInitialReads!: () => void;
  let releaseWinnerInsert!: () => void;
  const initialReadsReady = new Promise<void>((resolve) => {
    releaseInitialReads = resolve;
  });
  const winnerInsertReady = new Promise<void>((resolve) => {
    releaseWinnerInsert = resolve;
  });
  let initialReadCount = 0;
  let transactionTail = Promise.resolve();
  let pendingValues: Record<string, unknown> | undefined;
  let storedCredential: Record<string, unknown> | undefined;

  const initialFindFirst = vi.fn(async () => {
    initialReadCount += 1;
    if (initialReadCount === 2) releaseInitialReads();
    await initialReadsReady;
    return undefined;
  });
  const lockedFindFirst = vi.fn(async () => storedCredential);
  const onConflictDoNothing = vi.fn(async () => {
    if (storedCredential || !pendingValues) return;
    storedCredential = {
      ...pendingValues,
      id: "00000000-0000-4000-8000-000000000001",
      expiresAt: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    releaseWinnerInsert();
  });
  const values = vi.fn((nextValues: Record<string, unknown>) => {
    pendingValues = nextValues;
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values }));
  const lockRow = vi.fn().mockResolvedValue([{ id: USER_ID }]);
  const whereLockRow = vi.fn().mockReturnValue({ for: lockRow });
  const fromUsers = vi.fn().mockReturnValue({ where: whereLockRow });
  const select = vi.fn().mockReturnValue({ from: fromUsers });
  const tx = {
    query: { userApiCredentials: { findFirst: lockedFindFirst } },
    insert,
    select,
  };
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const previous = transactionTail;
    let releaseCurrent!: () => void;
    transactionTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous;
    try {
      return await callback(tx);
    } finally {
      releaseCurrent();
    }
  });
  const db = {
    query: { userApiCredentials: { findFirst: initialFindFirst } },
    transaction,
  };

  return {
    db,
    winnerInsertReady,
    spies: {
      initialFindFirst,
      lockedFindFirst,
      insert,
      values,
      onConflictDoNothing,
      transaction,
    },
  };
}

function createCaller(db: unknown) {
  return hyperliquidRouter.createCaller({
    db,
    session: { userId: USER_ID },
    userId: USER_ID,
    logger: createLogger(),
  } as never);
}

describe("hyperliquid.enable upsert-or-refetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
    provisionMock.mockResolvedValue({ walletId: "agent-wallet-id", address: OUR_AGENT });
    verifyOwnershipMock.mockResolvedValue("verified");
  });

  it("creates the row and returns our agent when there is no race", async () => {
    const db = createDb([undefined, undefined, credentialRow(OUR_AGENT)]);
    const result = await createCaller(db).enable({ masterAddress: MASTER });

    expect(db.spies.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.alreadyEnabled).toBe(false);
    expect(result.agentAddress).toBe(OUR_AGENT);
    expect(result.walletAddress).toBe(MASTER);
  });

  it("losing tab never errors: on conflict it re-reads and returns the winner's row", async () => {
    // The pre-check and locked re-read see no row, but the post-insert read
    // returns the same-master row another tab persisted first.
    const db = createDb([undefined, credentialRow(WINNER_AGENT)]);
    const result = await createCaller(db).enable({ masterAddress: MASTER });

    expect(result.success).toBe(true);
    expect(result.alreadyEnabled).toBe(true);
    // The caller gets the SAME agent the winner got, never our orphaned one.
    expect(result.agentAddress).toBe(WINNER_AGENT);
  });

  it("returns the existing row idempotently without provisioning again", async () => {
    const db = createDb([credentialRow(OUR_AGENT)]);
    const result = await createCaller(db).enable({
      masterAddress: MASTER.toLowerCase(),
    });

    expect(result.alreadyEnabled).toBe(true);
    expect(result.agentAddress).toBe(OUR_AGENT);
    expect(provisionMock).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
  });

  it("rejects a different existing master before provisioning or writing", async () => {
    const db = createDb([credentialRow(OUR_AGENT)]);

    await expect(
      createCaller(db).enable({ masterAddress: OTHER_MASTER }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(provisionMock).not.toHaveBeenCalled();
    expect(verifyOwnershipMock).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
    expect(db.spies.findFirst).toHaveBeenCalledTimes(1);
  });

  it("rejects a competing different master before provisioning or writing", async () => {
    const race = createCompetingEnableDb();
    verifyOwnershipMock.mockImplementation(async (_userId, address) => {
      if (address === OTHER_MASTER) await race.winnerInsertReady;
      return "verified";
    });

    const [winner, conflict] = await Promise.allSettled([
      createCaller(race.db).enable({ masterAddress: MASTER }),
      createCaller(race.db).enable({ masterAddress: OTHER_MASTER }),
    ]);

    expect(winner.status).toBe("fulfilled");
    const conflictError =
      conflict.status === "rejected"
        ? (conflict.reason as { code?: string; message?: string })
        : null;
    expect(conflictError?.code).toBe("CONFLICT");
    const errorContainsAddress = Boolean(
      conflictError?.message?.includes(MASTER) ||
        conflictError?.message?.includes(OTHER_MASTER),
    );
    expect(errorContainsAddress).toBe(false);
    expect(race.spies.initialFindFirst).toHaveBeenCalledTimes(2);
    expect(race.spies.lockedFindFirst).toHaveBeenCalledTimes(3);
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(race.spies.insert).toHaveBeenCalledTimes(1);
    expect(race.spies.values).toHaveBeenCalledTimes(1);
  });

  it("H1: rejects a masterAddress the user's Privy account does not own", async () => {
    verifyOwnershipMock.mockResolvedValue("mismatch");
    const db = createDb([undefined]);

    await expect(createCaller(db).enable({ masterAddress: MASTER })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
  });

  it("H1: rejects enable when the Privy user is unresolvable", async () => {
    verifyOwnershipMock.mockResolvedValue("unresolvable");
    const db = createDb([undefined]);

    await expect(createCaller(db).enable({ masterAddress: MASTER })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(db.spies.insert).not.toHaveBeenCalled();
  });
});
