import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import * as hyperliquidActualModule from "../lib/hyperliquid.js";

const hyperliquidActual = { ...hyperliquidActualModule };

const createHyperliquidExchangeClient = vi.fn();
const getRedisClient = vi.fn();

vi.mock("../lib/hyperliquid.js", () => ({
  ...hyperliquidActual,
  createHyperliquidExchangeClient,
  HL_AGENT_REGISTERED: "LIVE",
}));

vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const { ordersRouter } = await import("../routers/orders.js");

afterAll(() => mock.restore());

function logger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createDb(options: {
  failInsertAt?: number;
  failFinalize?: boolean;
  zeroRowUpdate?: boolean;
  updateRows?: Array<Record<string, unknown>>;
  zeroRowAuthoritativeStatus?: string;
  signal?: Record<string, unknown> | null;
} = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  let insertCount = 0;
  const signalFindFirst = vi.fn().mockResolvedValue(options.signal ?? null);

  const db: any = {
    query: {
      userApiCredentials: {
        findFirst: vi.fn().mockResolvedValue({ accountType: "LIVE" }),
      },
      orders: {
        findFirst: vi.fn().mockImplementation(async () => rows.values().next().value),
      },
      signals: {
        findFirst: signalFindFirst,
      },
    },
  };

  db.insert = vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
      const insert = async () => {
        insertCount += 1;
        if (options.failInsertAt === insertCount) throw new Error("database unavailable");
        const key = String(row.clientOrderId);
        if (rows.has(key)) return [];
        const id = `row-${insertCount}`;
        rows.set(key, { id, ...row });
        events.push(`insert:${key}`);
        return [{ id }];
      };
      return {
        returning: vi.fn().mockImplementation(insert),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(insert),
        }),
      };
    }),
  });
  db.update = vi.fn().mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(async () => {
          if (options.failFinalize) throw new Error("finalize unavailable");
          const target = [...rows.values()].find((row) => row.status === "PENDING");
          if (options.zeroRowUpdate) {
            if (target && options.zeroRowAuthoritativeStatus) {
              target.status = options.zeroRowAuthoritativeStatus;
              target.brokerOrderId = "broker-race-filled";
            }
            return [];
          }
          if (options.updateRows) return options.updateRows;
          if (!target) return [];
          Object.assign(target, values);
          events.push(`update:${String(values.status)}`);
          return [{ id: target.id }];
        }),
      }),
    })),
  });
  db.transaction = vi.fn().mockImplementation(async (callback: (tx: any) => unknown) => {
    const snapshot = new Map([...rows].map(([key, value]) => [key, { ...value }]));
    const eventCount = events.length;
    try {
      return await callback(db);
    } catch (error) {
      rows.clear();
      for (const [key, value] of snapshot) rows.set(key, value);
      events.length = eventCount;
      throw error;
    }
  });

  return { db, rows, events, signalFindFirst };
}

function caller(db: any, userId: string) {
  return ordersRouter.createCaller({
    db,
    session: { userId },
    userId,
    logger: logger() as any,
  });
}

function hyperliquidClient(
  events: string[] = [],
  statuses: unknown[] = [{ resting: { oid: 501 } }],
  livePositionSize: string | null = "0.1",
) {
  return {
    resolveAsset: vi.fn().mockResolvedValue({
      coin: "BTC",
      szDecimals: 3,
      maxLeverage: 40,
    }),
    allMids: vi.fn().mockResolvedValue({ BTC: "60000" }),
    listPositions: vi.fn().mockResolvedValue([
      {
        coin: "BTC",
        side: "long",
        ...(livePositionSize === null ? {} : { size: livePositionSize }),
        leverage: 5,
        marginMode: "cross",
      },
    ]),
    listOpenOrders: vi.fn().mockResolvedValue([
      {
        coin: "BTC",
        oid: 501,
        tpsl: "sl",
        isPositionTpsl: true,
        reduceOnly: true,
        sz: "0.1",
        orderType: "Stop Market",
      },
    ]),
    modifyPositionTpSl: vi.fn().mockResolvedValue({
      status: "ok",
      response: { type: "default" },
    }),
    setPositionTpSl: vi.fn().mockImplementation(async () => {
      events.push("broker");
      return { status: "ok", response: { data: { statuses } } };
    }),
    updateLeverage: vi.fn().mockResolvedValue({ status: "ok" }),
    placeOrder: vi.fn().mockResolvedValue({ status: "ok" }),
  };
}

function expectNoTpSlSideEffects(
  local: ReturnType<typeof createDb>,
  client: ReturnType<typeof hyperliquidClient>,
) {
  expect(local.db.insert).not.toHaveBeenCalled();
  expect(local.db.update).not.toHaveBeenCalled();
  expect(local.rows.size).toBe(0);
  expect(local.events).toEqual([]);
  expect(client.setPositionTpSl).not.toHaveBeenCalled();
}

describe("orders.modifyPerpTpSl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("modifies only the matching protective trigger with venue-derived details", async () => {
    const local = createDb();
    const client = hyperliquidClient();
    createHyperliquidExchangeClient.mockResolvedValue({
      client,
      walletAddress: "0xA",
    });

    await caller(local.db, "user-a").modifyPerpTpSl({
      coin: "BTC",
      orderId: 501,
      kind: "sl",
      triggerPx: "59000",
    });

    expect(client.modifyPositionTpSl).toHaveBeenCalledWith({
      coin: "BTC",
      orderId: 501,
      positionSide: "long",
      size: "0.1",
      triggerPx: "59000",
      kind: "sl",
      isMarket: true,
    });
  });

  it("refuses an oid that is not a matching protective trigger", async () => {
    const local = createDb();
    const client = hyperliquidClient();
    client.listOpenOrders.mockResolvedValue([]);
    createHyperliquidExchangeClient.mockResolvedValue({
      client,
      walletAddress: "0xA",
    });

    await expect(
      caller(local.db, "user-a").modifyPerpTpSl({
        coin: "BTC",
        orderId: 999,
        kind: "sl",
        triggerPx: "59000",
      }),
    ).rejects.toThrow("no longer open");
    expect(client.modifyPositionTpSl).not.toHaveBeenCalled();
  });
});

describe("orders.setPerpTpSl persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
  });

  it("persists tenant-scoped PENDING legs before broker submission", async () => {
    const tenantA = createDb();
    const clientA = hyperliquidClient(tenantA.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client: clientA, walletAddress: "0xA" });

    await caller(tenantA.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1",
      stopLossPx: "60000",
      cloid: "shared-trigger",
    });

    const request = clientA.setPositionTpSl.mock.calls[0]?.[0];
    const [stored] = tenantA.rows.values();
    expect(request.clientOrderId).toStartWith("rst-perptpsl-");
    expect(stored).toMatchObject({ userId: "user-a", status: "SUBMITTED", brokerOrderId: "501" });
    expect(tenantA.events[0]).toStartWith("insert:");
    expect(tenantA.events[1]).toBe("broker");
  });

  it("does not call the broker and rolls back earlier legs when reservation fails", async () => {
    const local = createDb({ failInsertAt: 2 });
    const client = hyperliquidClient(local.events, [
      { resting: { oid: 501 } },
      { resting: { oid: 502 } },
    ]);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await expect(caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1",
      stopLossPx: "60000",
      takeProfitPx: "70000",
      cloid: "two-leg-trigger",
    })).rejects.toThrow("database unavailable");

    expect(client.setPositionTpSl).not.toHaveBeenCalled();
    expect(local.rows.size).toBe(0);
  });

  it("keeps the durable PENDING row when broker acceptance cannot be finalized", async () => {
    const local = createDb({ failFinalize: true });
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    const result = await caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1",
      stopLossPx: "60000",
      cloid: "accepted-trigger",
    });

    expect(client.setPositionTpSl).toHaveBeenCalledTimes(1);
    expect([...local.rows.values()][0]).toMatchObject({ status: "PENDING" });
    expect(result).toMatchObject({
      success: false,
      reconciliationNeeded: true,
      status: "RECONCILIATION_NEEDED",
      acceptedLegs: 1,
      requestedLegs: 1,
    });
  });

  it("does not claim TP/SL attached when a zero-row CAS rereads an advanced row", async () => {
    const local = createDb({
      zeroRowUpdate: true,
      zeroRowAuthoritativeStatus: "SUBMITTED",
    });
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    const result = await caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1",
      stopLossPx: "60000",
      cloid: "advanced-trigger",
    });

    expect(result).toMatchObject({
      success: false,
      reconciliationNeeded: true,
      status: "RECONCILIATION_NEEDED",
      acceptedLegs: 1,
      requestedLegs: 1,
    });
    expect([...local.rows.values()][0]).toMatchObject({ status: "SUBMITTED" });
    expect(local.events).not.toContain("update:SUBMITTED");
  });

  it("marks an explicitly rejected sibling instead of leaving it PENDING", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events, [
      { resting: { oid: 501 } },
      { error: "invalid trigger" },
    ]);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await expect(caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1",
      stopLossPx: "60000",
      takeProfitPx: "70000",
      cloid: "partial-trigger",
    })).rejects.toThrow("already LIVE on Hyperliquid");

    expect([...local.rows.values()].map((row) => row.status)).toEqual(["SUBMITTED", "REJECTED"]);
  });

  it("rejects an unsafe size before Hyperliquid TP/SL ingestion", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await expect(caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "90071992.54740992",
      stopLossPx: "60000",
      cloid: "unsafe-trigger",
    })).rejects.toThrow();

    expect(client.setPositionTpSl).not.toHaveBeenCalled();
  });

  it.each([
    ["smaller", "0.05"],
    ["larger", "0.2"],
  ])("rejects a %s stale full-position size before reserving", async (_label, size) => {
    const local = createDb();
    const client = hyperliquidClient(local.events, undefined, "0.1");
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await expect(caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size,
      sizeMode: "full-position",
      stopLossPx: "60000",
      cloid: `stale-full-${size}`,
    })).rejects.toThrow();

    expectNoTpSlSideEffects(local, client);
  });

  it.each([
    ["missing", null],
    ["zero", "0"],
    ["malformed", "0.1x"],
  ] as const)("rejects an unusable fresh position size (%s) before reserving", async (_label, liveSize) => {
    const local = createDb();
    const client = hyperliquidClient(local.events, undefined, liveSize);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await expect(caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1",
      sizeMode: "full-position",
      stopLossPx: "60000",
      cloid: `unusable-live-${_label}`,
    })).rejects.toThrow();

    expectNoTpSlSideEffects(local, client);
  });

  it("accepts exact decimal equality and preserves the requested size string", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events, undefined, "0.25");
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.250",
      sizeMode: "full-position",
      stopLossPx: "60000",
      cloid: "exact-full-position",
    });

    expect(client.setPositionTpSl).toHaveBeenCalledTimes(1);
    expect(client.setPositionTpSl.mock.calls[0]?.[0].size).toBe("0.250");
  });

  it("accepts an explicit partial size no greater than the fresh position", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events, undefined, "0.1");
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.05",
      sizeMode: "partial",
      stopLossPx: "60000",
      cloid: "valid-partial-position",
    });

    expect(client.setPositionTpSl.mock.calls[0]?.[0].size).toBe("0.05");
  });

  it("rejects an oversized explicit partial size before reserving", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events, undefined, "0.1");
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await expect(caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.1001",
      sizeMode: "partial",
      stopLossPx: "60000",
      cloid: "oversized-partial-position",
    })).rejects.toThrow();

    expectNoTpSlSideEffects(local, client);
  });

  it("keeps omitted sizeMode compatible with legacy partial requests", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events, undefined, "0.1");
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await caller(local.db, "user-a").setPerpTpSl({
      coin: "BTC",
      positionSide: "long",
      size: "0.05",
      stopLossPx: "60000",
      cloid: "legacy-partial-position",
    });

    expect(client.setPositionTpSl.mock.calls[0]?.[0].size).toBe("0.05");
  });
});

describe("orders.submitPerp acceptance CAS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
  });

  it("resolves an x_signal perp source before Hyperliquid and persists linkage", async () => {
    const signalId = "44444444-4444-4444-8444-444444444444";
    const local = createDb({
      signal: {
        id: signalId,
        symbol: "BTC",
        metadata: {
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "BTC",
        },
        content: "BTC long",
      },
    });
    const client = hyperliquidClient(local.events, [
      { resting: { oid: 501 } },
      { resting: { oid: 502 } },
    ]);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    await caller(local.db, "user-a").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: false,
      postOnly: false,
      leverage: 5,
      cloid: "manual-copy-perp",
      stopLossPx: "59000",
      takeProfitPx: "70000",
      copySourceItemId: `x_signal:${signalId}`,
    });

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect([...local.rows.values()][0]).toMatchObject({
      signalId,
      notes: null,
      manualCopySourceItemId: `x_signal:${signalId}`,
      manualCopySourceOrderId: null,
      copySourceLabel: null,
      clientOrderId: "manual-copy-perp",
      initialStopLossPx: "59000",
      initialTakeProfitPx: "70000",
    });
  });

  it("retains dedicated manual attribution through an ambiguous Hyperliquid result", async () => {
    const signalId = "88888888-8888-4888-8888-888888888888";
    const local = createDb({
      signal: {
        id: signalId,
        symbol: "BTC",
        metadata: {
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "BTC",
        },
        content: "BTC long",
      },
    });
    const client = hyperliquidClient(local.events);
    client.placeOrder.mockRejectedValueOnce(new Error("venue transport failed"));
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    const result = await caller(local.db, "user-a").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: false,
      postOnly: false,
      leverage: 5,
      cloid: "ambiguous-manual-perp",
      copySourceItemId: `x_signal:${signalId}`,
    });

    expect(result).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
    expect([...local.rows.values()][0]).toMatchObject({
      status: "SYNCING",
      manualCopySourceItemId: `x_signal:${signalId}`,
      manualCopySourceOrderId: null,
    });
  });

  it("does not re-resolve a same-source perp replay after the source disappears", async () => {
    const signalId = "99999999-9999-4999-8999-999999999999";
    const local = createDb({
      signal: {
        id: signalId,
        symbol: "BTC",
        metadata: {
          platform: "hyperliquid",
          instrument: "perp",
          direction: "long",
          hlTicker: "BTC",
        },
        content: "BTC long",
      },
    });
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });
    const input = {
      coin: "BTC",
      isLong: true,
      marginMode: "cross" as const,
      orderType: "Market" as const,
      sizeCoin: "0.1",
      reduceOnly: false,
      postOnly: false,
      leverage: 5,
      cloid: "same-source-perp-replay",
      copySourceItemId: `x_signal:${signalId}`,
    };

    await caller(local.db, "user-a").submitPerp(input);
    local.signalFindFirst.mockResolvedValue(null);
    const replay = await caller(local.db, "user-a").submitPerp(input);

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({ success: true, message: "Order already submitted (idempotency hit)" });
    expect(local.signalFindFirst).toHaveBeenCalledTimes(1);
  });

  it("binds every perp replay source shape before any source lookup or broker call", async () => {
    const sourceA = "x_signal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sourceB = "x_signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cases = [
      { name: "same", persisted: sourceA, incoming: sourceA, accepted: true },
      { name: "changed", persisted: sourceA, incoming: sourceB, accepted: false },
      { name: "added", persisted: null, incoming: sourceA, accepted: false },
      { name: "omitted", persisted: sourceA, incoming: undefined, accepted: false },
    ] as const;

    for (const testCase of cases) {
      const local = createDb();
      local.rows.set(`perp-${testCase.name}`, {
        id: `perp-${testCase.name}`,
        userId: "user-a",
        clientOrderId: `perp-${testCase.name}`,
        brokerOrderId: "501",
        status: "SUBMITTED",
        manualCopySourceItemId: testCase.persisted,
      });

      const input = {
        coin: "BTC",
        isLong: true,
        marginMode: "cross" as const,
        orderType: "Market" as const,
        sizeCoin: "0.1",
        reduceOnly: false,
        postOnly: false,
        leverage: 5,
        cloid: `perp-${testCase.name}`,
        copySourceItemId: testCase.incoming,
      };
      if (testCase.accepted) {
        await expect(caller(local.db, "user-a").submitPerp(input)).resolves.toMatchObject({
          success: true,
          orderId: `perp-${testCase.name}`,
        });
      } else {
        await expect(caller(local.db, "user-a").submitPerp(input)).rejects.toMatchObject({
          code: "CONFLICT",
        });
      }
      expect(local.signalFindFirst).not.toHaveBeenCalled();
      expect(createHyperliquidExchangeClient).not.toHaveBeenCalled();
    }
  });

  it("rejects an unrecognized x_signal perp before Hyperliquid or a local row", async () => {
    const signalId = "55555555-5555-4555-8555-555555555555";
    const local = createDb({
      signal: {
        id: signalId,
        symbol: "BTC",
        metadata: { platform: 42, instrument: "perp", direction: "long", hlTicker: "BTC" },
        content: "BTC long",
      },
    });

    await expect(
      caller(local.db, "user-a").submitPerp({
        coin: "BTC",
        isLong: true,
        marginMode: "cross",
        orderType: "Market",
        sizeCoin: "0.1",
        reduceOnly: false,
        postOnly: false,
        leverage: 5,
        cloid: "invalid-copy-perp",
        copySourceItemId: `x_signal:${signalId}`,
      }),
    ).rejects.toThrow("copySourceItemId");

    expect(createHyperliquidExchangeClient).not.toHaveBeenCalled();
    expect(local.rows.size).toBe(0);
  });

  it("does not claim success when the broker acceptance update matches zero rows", async () => {
    const local = createDb({ zeroRowUpdate: true });
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({
      client,
      walletAddress: "0xA",
    });

    const result = await caller(local.db, "user-a").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: false,
      postOnly: false,
      leverage: 5,
      cloid: "submit-cas-lost",
    });

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect([...local.rows.values()][0]).toMatchObject({ status: "PENDING" });
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "row-1",
    });
  });

  it("requires exactly one Hyperliquid acceptance row when the CAS result is ambiguous", async () => {
    const local = createDb({ updateRows: [{ id: "winner-a" }, { id: "winner-b" }] });
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    const result = await caller(local.db, "user-a").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: false,
      postOnly: false,
      leverage: 5,
      cloid: "submit-cas-ambiguous",
    });

    expect(result).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
    expect([...local.rows.values()][0]).toMatchObject({ status: "PENDING" });
  });

  it("returns the reread FILLED state after a zero-row Hyperliquid acceptance race", async () => {
    const local = createDb({ zeroRowUpdate: true, zeroRowAuthoritativeStatus: "FILLED" });
    const client = hyperliquidClient(local.events);
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    const result = await caller(local.db, "user-a").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: false,
      postOnly: false,
      leverage: 5,
      cloid: "submit-cas-filled",
    });

    expect(result).toMatchObject({ success: false, status: "FILLED" });
    expect(result.syncing).toBe(false);
  });

  it("does not claim an idempotency hit succeeded while the order is still syncing", async () => {
    const local = createDb();
    const client = hyperliquidClient(local.events);
    client.placeOrder.mockRejectedValueOnce(new Error("transport timed out"));
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xA" });

    const input = {
      coin: "BTC",
      isLong: true,
      marginMode: "cross" as const,
      orderType: "Market" as const,
      sizeCoin: "0.1",
      reduceOnly: true,
      postOnly: false,
      leverage: 5,
      cloid: "syncing-close",
    };

    const first = await caller(local.db, "user-a").submitPerp(input);
    const replay = await caller(local.db, "user-a").submitPerp(input);

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
    expect(replay).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
  });

  it("returns a definitive terminal idempotency result so the client can mint a new cloid", async () => {
    const local = createDb();
    local.rows.set("terminal-close", {
      id: "row-terminal",
      userId: "user-a",
      clientOrderId: "terminal-close",
      brokerOrderId: "501",
      status: "CANCELLED",
    });

    const result = await caller(local.db, "user-a").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: true,
      postOnly: false,
      leverage: 5,
      cloid: "terminal-close",
    });

    expect(result).toMatchObject({
      success: false,
      syncing: false,
      status: "CANCELLED",
      orderId: "row-terminal",
    });
    expect(createHyperliquidExchangeClient).not.toHaveBeenCalled();
  });
});

describe("orders.getByClientOrderId", () => {
  it("returns null before a local reservation exists and the status after it does", async () => {
    const local = createDb();

    expect(
      await caller(local.db, "user-a").getByClientOrderId({
        clientOrderId: "close-lookup",
      }),
    ).toBeNull();

    local.rows.set("close-lookup", {
      id: "row-lookup",
      userId: "user-a",
      clientOrderId: "close-lookup",
      brokerOrderId: null,
      status: "SYNCING",
      statusUpdatedAt: new Date("2026-08-31T00:00:00Z"),
    });

    expect(
      await caller(local.db, "user-a").getByClientOrderId({
        clientOrderId: "close-lookup",
      }),
    ).toMatchObject({ id: "row-lookup", status: "SYNCING" });
  });
});
