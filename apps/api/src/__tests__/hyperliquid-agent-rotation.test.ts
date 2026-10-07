import { beforeEach, describe, expect, it, vi } from "bun:test";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

const getRedisClient = vi.fn();
vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const actualHl = await import("../lib/hyperliquid.js");
const provisionMock = vi.fn();
const lookupMock = vi.fn();
const extraAgentsMock = vi.fn();
vi.mock("../lib/hyperliquid.js", () => ({
  ...actualHl,
  createHyperliquidInfoClient: () => ({ extraAgents: extraAgentsMock }),
  findHyperliquidAgentWalletByExternalId: lookupMock,
  provisionHyperliquidAgentWallet: provisionMock,
}));

const { hyperliquidRouter } = await import("../routers/hyperliquid.js");

const USER_ID = "user-1";
const MASTER = "0xAbCd000000000000000000000000000000001234";
const OLD_AGENT = "0x1111111111111111111111111111111111111111";
const NEW_AGENT = "0x2222222222222222222222222222222222222222";
const OTHER_AGENT = "0x3333333333333333333333333333333333333333";

const reusedAgentRecovery = (failedAgentAddress = OLD_AGENT) => ({
  reason: "EXTRA_AGENT_ALREADY_USED" as const,
  failedAgentAddress,
});

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: USER_ID,
    provider: "hyperliquid",
    encryptedAccessToken: "enc-access",
    encryptedRefreshToken: "enc-old-agent",
    accountId: MASTER,
    accountType: "PENDING",
    username: MASTER,
    baseUrl: OLD_AGENT,
    expiresAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createDb(
  initial = credentialRow(),
  options: {
    beforeReturning?: (state: {
      current: ReturnType<typeof credentialRow>;
      patch: Record<string, unknown>;
      replace: (next: ReturnType<typeof credentialRow>) => void;
    }) => void;
    applyUpdate?: (state: {
      current: ReturnType<typeof credentialRow>;
      patch: Record<string, unknown>;
    }) => boolean;
  } = {},
) {
  let current = initial;
  const events: string[] = [];
  let nextPatch: Record<string, unknown> = {};
  const findFirst = vi.fn(async () => current);
  const returning = vi.fn(async () => {
    options.beforeReturning?.({
      current,
      patch: nextPatch,
      replace: (next) => {
        current = next;
      },
    });
    const shouldApply = options.applyUpdate?.({ current, patch: nextPatch }) ?? true;
    if (!shouldApply) return [];
    current = { ...current, ...nextPatch };
    return [current];
  });
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn((patch: Record<string, unknown>) => {
    events.push("update");
    nextPatch = patch;
    return { where };
  });
  const update = vi.fn(() => ({ set }));
  const select = vi.fn(() => {
    const query: any = {
      from: () => query,
      where: () => query,
      for: vi.fn(async (mode: string) => {
        events.push(`lock:user:${mode}`);
        return [{ id: USER_ID }];
      }),
    };
    return query;
  });
  let db: any;
  const transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
    events.push("transaction:begin");
    const result = await callback(db);
    events.push("transaction:commit");
    return result;
  });
  db = {
    query: { userApiCredentials: { findFirst } },
    select,
    update,
    transaction,
    events,
    getCurrent: () => current,
    spies: { findFirst, update, set, where, returning },
  };
  return db;
}

function createCaller(db: unknown) {
  return hyperliquidRouter.createCaller({
    db,
    session: { userId: USER_ID },
    userId: USER_ID,
    logger: { debug() {}, error() {}, info() {}, warn() {} },
  } as never);
}

describe("hyperliquid.rotatePendingAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
    extraAgentsMock.mockResolvedValue([]);
    lookupMock.mockResolvedValue({ walletId: "fresh-agent-wallet-id", address: NEW_AGENT });
    provisionMock.mockResolvedValue({ walletId: "fresh-agent-wallet-id", address: NEW_AGENT });
  });

  it("rotates only the unusable server agent while preserving the funded master", async () => {
    const db = createDb();

    const before = db.getCurrent();
    const result = await createCaller(db).rotatePendingAgent(reusedAgentRecovery());

    expect(extraAgentsMock).toHaveBeenCalledWith(MASTER);
    expect(provisionMock).toHaveBeenCalledTimes(1);
    const [, options] = provisionMock.mock.calls[0] as [string, { agentExternalId?: string }];
    expect(options.agentExternalId).toMatch(/^rst-hl-recovery-[a-f0-9]{32}$/);
    expect(db.spies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: NEW_AGENT,
        accountType: "PENDING",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      walletAddress: MASTER,
      agentAddress: NEW_AGENT,
      agentReady: false,
    });
    expect(db.getCurrent()).toMatchObject({
      id: before.id,
      userId: before.userId,
      provider: before.provider,
      encryptedAccessToken: before.encryptedAccessToken,
      accountId: before.accountId,
      username: before.username,
      expiresAt: before.expiresAt,
      createdAt: before.createdAt,
    });
    expect(db.events).toEqual([
      "transaction:begin",
      "lock:user:update",
      "update",
      "transaction:commit",
    ]);
  });

  it("converges on the same replacement after a successful response is lost", async () => {
    const db = createDb();
    const caller = createCaller(db);

    const first = await caller.rotatePendingAgent(reusedAgentRecovery());
    const second = await caller.rotatePendingAgent(reusedAgentRecovery());

    expect(first.agentAddress).toBe(NEW_AGENT);
    expect(second.agentAddress).toBe(NEW_AGENT);
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(extraAgentsMock).toHaveBeenCalledTimes(1);
    expect(db.spies.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale failed-agent address without changing the credential", async () => {
    const db = createDb();
    const before = db.getCurrent();

    await expect(
      createCaller(db).rotatePendingAgent(reusedAgentRecovery(OTHER_AGENT)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.getCurrent()).toEqual(before);
    expect(provisionMock).not.toHaveBeenCalled();
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(db.spies.update).not.toHaveBeenCalled();
  });

  it("uses the stored agent casing for the first-attempt compare and database swap", async () => {
    const storedMixedCase = "0xAaAa00000000000000000000000000000000BbBb";
    const db = createDb(credentialRow({ baseUrl: storedMixedCase }));

    const result = await createCaller(db).rotatePendingAgent(
      reusedAgentRecovery(storedMixedCase.toLowerCase()),
    );

    expect(result.agentAddress).toBe(NEW_AGENT);
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(db.getCurrent().baseUrl).toBe(NEW_AGENT);
  });

  it("fails closed with a controlled error when Hyperliquid returns malformed agents", async () => {
    extraAgentsMock.mockResolvedValue(null);
    const db = createDb();

    await expect(
      createCaller(db).rotatePendingAgent(reusedAgentRecovery()),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not verify the current trading agent. Please try again.",
    });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(db.spies.update).not.toHaveBeenCalled();
  });

  it("requires the exact reused-agent recovery reason", async () => {
    const db = createDb();

    await expect(
      createCaller(db).rotatePendingAgent({
        reason: "REQUEST_TIMED_OUT",
        failedAgentAddress: OLD_AGENT,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(db.spies.update).not.toHaveBeenCalled();
  });

  it("fails closed when the stored agent is already approved for this master", async () => {
    extraAgentsMock.mockResolvedValue([{ address: OLD_AGENT, name: "readysettrade" }]);
    const db = createDb();

    await expect(createCaller(db).rotatePendingAgent(reusedAgentRecovery())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(db.spies.update).not.toHaveBeenCalled();
  });

  it("never rotates a LIVE credential", async () => {
    const db = createDb(credentialRow({ accountType: "LIVE" }));

    await expect(createCaller(db).rotatePendingAgent(reusedAgentRecovery())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(extraAgentsMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("validates builder configuration before provisioning or changing the database", async () => {
    const previous = process.env.HL_BUILDER_ADDRESS;
    process.env.HL_BUILDER_ADDRESS = "not-an-address";
    const db = createDb();
    try {
      await expect(
        createCaller(db).rotatePendingAgent(reusedAgentRecovery()),
      ).rejects.toThrow();
      expect(provisionMock).not.toHaveBeenCalled();
      expect(db.spies.update).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.HL_BUILDER_ADDRESS;
      else process.env.HL_BUILDER_ADDRESS = previous;
    }
  });
});

describe("hyperliquid.markAgentRegistered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
    extraAgentsMock.mockResolvedValue([{ address: OLD_AGENT, name: "readysettrade" }]);
  });

  it("does not mark a concurrently rotated replacement LIVE", async () => {
    let raced = false;
    const db = createDb(credentialRow(), {
      beforeReturning: ({ current, patch, replace }) => {
        if (patch.accountType === "LIVE") {
          raced = true;
          replace({ ...current, baseUrl: NEW_AGENT, encryptedRefreshToken: "enc-new", updatedAt: new Date() });
        }
      },
      applyUpdate: ({ patch }) => patch.accountType !== "LIVE",
    });

    await expect(createCaller(db).markAgentRegistered()).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(raced).toBe(true);
    expect(db.getCurrent()).toMatchObject({ baseUrl: NEW_AGENT, accountType: "PENDING" });
  });

  it("marks only the exact verified pending credential LIVE", async () => {
    const db = createDb();

    const result = await createCaller(db).markAgentRegistered();

    expect(result).toMatchObject({ success: true, agentReady: true });
    expect(db.getCurrent()).toMatchObject({ baseUrl: OLD_AGENT, accountType: "LIVE" });
    expect(db.spies.returning).toHaveBeenCalledTimes(1);
  });
});
