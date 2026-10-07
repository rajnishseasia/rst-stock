import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { AlpacaAmbiguousOrderError } from "@trade-bot/alpaca";

const getAlpacaClient = vi.fn();
const getRedisClient = vi.fn();

vi.mock("../lib/alpaca.js", () => ({
  getAlpacaClient,
  isPaperAccount: (accountType: string | null | undefined) =>
    accountType === "PAPER" || accountType === "SIM",
}));
vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const { ordersRouter } = await import("../routers/orders.js");

afterAll(() => {
  mock.restore();
});

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createDb(options: {
  existing?: Record<string, unknown> | null;
  userId?: string;
  failUpdateCalls?: number[];
  zeroRowUpdateCalls?: number[];
  updateRowsByCall?: Record<number, Array<Record<string, unknown>>>;
  findFirstRows?: Array<Record<string, unknown> | null>;
  signal?: Record<string, unknown> | null;
} = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const userId = options.userId ?? "user-a";
  const signalFindFirst = vi.fn().mockResolvedValue(options.signal ?? null);

  const values = vi.fn().mockImplementation((value: Record<string, unknown>) => {
    inserted.push(value);
    return {
      returning: vi.fn().mockResolvedValue([
        {
          id: "local-order-1",
          userId,
          brokerOrderId: null,
          ...value,
        },
      ]),
    };
  });
  const insert = vi.fn().mockReturnValue({ values });
  let updateCall = 0;
  let findFirstCall = 0;
  const findFirst = vi.fn().mockImplementation(async () => {
    const rows = options.findFirstRows;
    if (!rows || rows.length === 0) return options.existing ?? null;
    const row = rows[Math.min(findFirstCall, rows.length - 1)] ?? null;
    findFirstCall += 1;
    return row;
  });
  const updateWhere = vi.fn().mockImplementation(() => {
    updateCall += 1;
    if (options.failUpdateCalls?.includes(updateCall)) {
      throw new Error(`database update ${updateCall} failed`);
    }
    return {
      returning: vi.fn().mockResolvedValue(options.updateRowsByCall?.[updateCall] ?? (
        options.zeroRowUpdateCalls?.includes(updateCall) ? [] : [{ id: "updated-order" }]
      )),
    };
  });
  const updateSet = vi.fn().mockImplementation((value: Record<string, unknown>) => {
    updates.push(value);
    return { where: updateWhere };
  });

  return {
    db: {
      query: {
        orders: {
          findFirst,
          findMany: vi.fn().mockResolvedValue([]),
        },
        signals: { findFirst: signalFindFirst },
      },
      insert,
      update: vi.fn().mockReturnValue({ set: updateSet }),
    } as any,
    inserted,
    updates,
    signalFindFirst,
  };
}

function caller(db: any, userId = "user-a") {
  return ordersRouter.createCaller({
    db,
    session: { userId },
    userId,
    logger: logger() as any,
  });
}

const normalOrderInput = {
  symbol: "AAPL",
  assetType: "EQUITY" as const,
  orderType: "Market" as const,
  tradeAction: "Buy" as const,
  direction: "long" as const,
  quantity: 1,
  timeInForce: "day" as const,
  idempotencyKey: "browser-intent-same",
};

type AmbiguousHandler = "normal" | "bracket" | "smart-exit" | "oco" | "trailing-stop";

function ambiguousOrderError() {
  return new AlpacaAmbiguousOrderError(
    "create_order",
    new Error("lookup unavailable"),
    "broker-client-id",
  );
}

async function submitAmbiguousHandler(handler: AmbiguousHandler, db: any) {
  const credentials = { accountId: "account-1" };
  switch (handler) {
    case "normal": {
      getAlpacaClient.mockResolvedValue({
        client: { createOrder: vi.fn().mockRejectedValue(ambiguousOrderError()) },
        credentials,
      });
      return caller(db).submit(normalOrderInput);
    }
    case "bracket": {
      getAlpacaClient.mockResolvedValue({
        client: { createBracketOrder: vi.fn().mockRejectedValue(ambiguousOrderError()) },
        credentials,
      });
      return caller(db).submitBracket({
        symbol: "AAPL",
        assetType: "EQUITY",
        side: "buy",
        quantity: 1,
        orderType: "market",
        takeProfitPrice: 210,
        stopLossPrice: 190,
        timeInForce: "gtc",
        idempotencyKey: "bracket-ambiguous",
      });
    }
    case "smart-exit": {
      getAlpacaClient.mockResolvedValue({
        client: { createOrder: vi.fn().mockRejectedValue(ambiguousOrderError()) },
        credentials,
      });
      return caller(db).submitWithExitPlan({
        symbol: "AAPL",
        side: "buy",
        direction: "long",
        quantity: 2,
        orderType: "market",
        timeInForce: "gtc",
        takeProfits: [{ price: 210, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 5 },
        idempotencyKey: "smart-ambiguous",
      });
    }
    case "oco": {
      getAlpacaClient.mockResolvedValue({
        client: { createOrder: vi.fn().mockRejectedValue(ambiguousOrderError()) },
        credentials,
      });
      return caller(db).submitOCO({
        symbol: "AAPL",
        quantity: 1,
        takeProfits: [{ price: 210, quantity: 1 }],
        stopLossPrice: 190,
        timeInForce: "gtc",
        idempotencyKey: "oco-ambiguous",
      });
    }
    case "trailing-stop": {
      getAlpacaClient.mockResolvedValue({
        client: { createTrailingStopOrder: vi.fn().mockRejectedValue(ambiguousOrderError()) },
        credentials,
      });
      return caller(db).submitTrailingStop({
        symbol: "AAPL",
        side: "sell",
        quantity: 1,
        trailPercent: 5,
        timeInForce: "gtc",
        idempotencyKey: "trailing-ambiguous",
      });
    }
  }
}

describe("orders router idempotency boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({
      incrWithTtl: vi.fn().mockResolvedValue(1),
      // Per-leg charging returns the amount just added (fresh window).
      incrByWithTtl: vi
        .fn()
        .mockImplementation((_key: string, amount: number) =>
          Promise.resolve(amount),
        ),
    });
  });

  it("derives a tenant-owned broker ID instead of sending the caller key", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-1" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted } = createDb();

    await caller(db).submit(normalOrderInput);

    const brokerId = createOrder.mock.calls[0][0].client_order_id as string;
    expect(brokerId).not.toBe(normalOrderInput.idempotencyKey);
    expect(brokerId.length).toBeLessThanOrEqual(48);
    expect(inserted[0].clientOrderId).toBe(brokerId);
  });

  it("resolves an x_signal source before Alpaca and persists manual-copy linkage", async () => {
    const signalId = "11111111-1111-4111-8111-111111111111";
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-1" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1", accountType: "LIVE" },
    });
    const { db, inserted } = createDb({
      signal: {
        id: signalId,
        symbol: "AAPL",
        metadata: null,
        content: "AAPL buy",
      },
    });

    const result = await caller(db).submit({
      ...normalOrderInput,
      signalId,
      copySourceItemId: `x_signal:${signalId}`,
      notes: "from the feed",
      copySourceLabel: "forged client label",
    } as any);

    expect(result).toMatchObject({ success: true, brokerOrderId: "broker-1" });
    expect(createOrder).toHaveBeenCalledTimes(1);
    const localOrder = inserted.find((row) => row.status === "PENDING");
    expect(localOrder).toMatchObject({
      signalId,
      notes: "from the feed",
      manualCopySourceItemId: `x_signal:${signalId}`,
      manualCopySourceOrderId: null,
      copySourceLabel: null,
    });
    expect(String(localOrder?.clientOrderId)).not.toStartWith("copymirror:");
    expect(inserted.find((row) => row.orderId === "local-order-1")).toMatchObject({
      orderId: "local-order-1",
      symbol: "AAPL",
    });
  });

  it("resolves and persists an x_signal source on the bracket entry row", async () => {
    const signalId = "88888888-8888-4888-8888-888888888888";
    const createBracketOrder = vi.fn().mockResolvedValue({ id: "broker-bracket-source" });
    getAlpacaClient.mockResolvedValue({
      client: { createBracketOrder },
      credentials: { accountId: "account-1", accountType: "PAPER" },
    });
    const { db, inserted } = createDb({
      signal: {
        id: signalId,
        symbol: "AAPL",
        metadata: null,
        content: "AAPL buy",
      },
    });

    const result = await caller(db).submitBracket({
      symbol: "AAPL",
      assetType: "EQUITY",
      side: "buy",
      quantity: 1,
      orderType: "market",
      takeProfitPrice: 210,
      stopLossPrice: 190,
      timeInForce: "gtc",
      idempotencyKey: "bracket-source-entry",
      copySourceItemId: `x_signal:${signalId}`,
    });

    expect(result).toMatchObject({ success: true });
    expect(createBracketOrder).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      signalId,
      manualCopySourceItemId: `x_signal:${signalId}`,
      manualCopySourceOrderId: null,
      copySourceLabel: null,
    });
  });

  it("resolves and persists an x_signal source on the Smart Exit entry row", async () => {
    const signalId = "99999999-9999-4999-8999-999999999999";
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-exit-source" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1", accountType: "PAPER" },
    });
    const { db, inserted } = createDb({
      signal: {
        id: signalId,
        symbol: "AAPL",
        metadata: null,
        content: "AAPL buy",
      },
    });

    const result = await caller(db).submitWithExitPlan({
      symbol: "AAPL",
      side: "buy",
      direction: "long",
      quantity: 2,
      orderType: "market",
      timeInForce: "gtc",
      takeProfits: [{ price: 210, qtyFraction: 0.5 }],
      trailingStop: { trailPercent: 5 },
      notes: "from the feed",
      signalId,
      idempotencyKey: "smart-source-entry",
      copySourceItemId: `x_signal:${signalId}`,
    });

    expect(result).toMatchObject({ success: true });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      signalId,
      notes: "from the feed",
      manualCopySourceItemId: `x_signal:${signalId}`,
      manualCopySourceOrderId: null,
      copySourceLabel: null,
    });
  });

  it("rejects forged protected-entry sources before broker setup or reservation", async () => {
    const cases: Array<{
      name: string;
      submit: (db: any) => Promise<unknown>;
    }> = [
      {
        name: "bracket",
        submit: (db) => caller(db).submitBracket({
          symbol: "AAPL",
          assetType: "EQUITY",
          side: "buy",
          quantity: 1,
          orderType: "market",
          takeProfitPrice: 210,
          stopLossPrice: 190,
          timeInForce: "gtc",
          idempotencyKey: "bracket-forged-source",
          copySourceItemId: "x_signal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      },
      {
        name: "smart-exit",
        submit: (db) => caller(db).submitWithExitPlan({
          symbol: "AAPL",
          side: "buy",
          direction: "long",
          quantity: 2,
          orderType: "market",
          timeInForce: "gtc",
          takeProfits: [{ price: 210, qtyFraction: 0.5 }],
          trailingStop: { trailPercent: 5 },
          idempotencyKey: "smart-forged-source",
          copySourceItemId: "x_signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      },
    ];

    for (const testCase of cases) {
      const signalId = testCase.name === "bracket"
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const { db, inserted, signalFindFirst } = createDb({
        signal: {
          id: signalId,
          symbol: "AAPL",
          metadata: { platform: 42 },
          content: "AAPL buy",
        },
      });

      await expect(testCase.submit(db)).rejects.toThrow("copySourceItemId");
      expect(signalFindFirst).toHaveBeenCalledTimes(1);
      expect(getAlpacaClient).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    }
  });

  it("binds protected-entry replays before source lookup or broker activity", async () => {
    const sourceA = "x_signal:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sourceB = "x_signal:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const cases = [
      { name: "same", persisted: sourceA, incoming: sourceA, accepted: true },
      { name: "changed", persisted: sourceA, incoming: sourceB, accepted: false },
      { name: "added", persisted: null, incoming: sourceA, accepted: false },
      { name: "omitted", persisted: sourceA, incoming: undefined, accepted: false },
    ] as const;

    for (const handler of ["bracket", "smart-exit"] as const) {
      for (const testCase of cases) {
        const { db, signalFindFirst } = createDb({
          existing: {
            id: `${handler}-replay-${testCase.name}`,
            userId: "user-a",
            status: "FILLED",
            brokerOrderId: "broker-existing",
            manualCopySourceItemId: testCase.persisted,
          },
        });
        const input = handler === "bracket"
          ? {
              symbol: "AAPL" as const,
              assetType: "EQUITY" as const,
              side: "buy" as const,
              quantity: 1,
              orderType: "market" as const,
              takeProfitPrice: 210,
              stopLossPrice: 190,
              timeInForce: "gtc" as const,
              idempotencyKey: `protected-bracket-replay-${testCase.name}`,
              copySourceItemId: testCase.incoming,
            }
          : {
              symbol: "AAPL" as const,
              side: "buy" as const,
              direction: "long" as const,
              quantity: 2,
              orderType: "market" as const,
              timeInForce: "gtc" as const,
              takeProfits: [{ price: 210, qtyFraction: 0.5 }],
              trailingStop: { trailPercent: 5 },
              idempotencyKey: `protected-smart-replay-${testCase.name}`,
              copySourceItemId: testCase.incoming,
            };
        const request = handler === "bracket"
          ? caller(db).submitBracket(input)
          : caller(db).submitWithExitPlan(input);

        if (testCase.accepted) {
          await expect(request).resolves.toMatchObject({ success: true });
        } else {
          await expect(request).rejects.toMatchObject({ code: "CONFLICT" });
        }
        expect(signalFindFirst).not.toHaveBeenCalled();
        expect(getAlpacaClient).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects an unrecognized x_signal before loading the broker or reserving an order", async () => {
    const signalId = "22222222-2222-4222-8222-222222222222";
    const { db, inserted } = createDb({
      signal: {
        id: signalId,
        symbol: "GOOGL",
        metadata: { platform: 42 },
        content: "GOOGL buy",
      },
    });

    await expect(
      caller(db).submit({
        ...normalOrderInput,
        symbol: "GOOGL",
        signalId,
        copySourceItemId: `x_signal:${signalId}`,
      }),
    ).rejects.toThrow("copySourceItemId");

    expect(getAlpacaClient).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("keeps a verified manual-copy retry on the existing idempotency path", async () => {
    const signalId = "33333333-3333-4333-8333-333333333333";
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-1" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1", accountType: "LIVE" },
    });
    const { db, inserted } = createDb({
      signal: {
        id: signalId,
        symbol: "AAPL",
        metadata: null,
        content: "AAPL buy",
      },
      findFirstRows: [
        null,
        {
          id: "local-order-1",
          userId: "user-a",
          brokerOrderId: "broker-1",
          manualCopySourceItemId: `x_signal:${signalId}`,
        },
      ],
    });
    const input = {
      ...normalOrderInput,
      signalId,
      copySourceItemId: `x_signal:${signalId}`,
    };

    await caller(db).submit(input);
    const retry = await caller(db).submit(input);

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({
      success: true,
      orderId: "local-order-1",
      message: "Order already submitted (idempotency hit)",
    });
    expect(inserted.filter((row) => row.status === "PENDING")).toHaveLength(1);
  });

  it("does not treat a forged notes marker as manual-copy provenance", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-forged-note" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, signalFindFirst } = createDb();
    const forgedNotes = `[manual-copy-source] x_signal:${"11111111-1111-4111-8111-111111111111"}`;

    await caller(db).submit({
      ...normalOrderInput,
      idempotencyKey: "forged-note-order",
      notes: forgedNotes,
    });

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(signalFindFirst).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ notes: forgedNotes });
    expect(inserted[0]?.manualCopySourceItemId).toBeUndefined();
    expect(inserted[0]?.manualCopySourceOrderId).toBeUndefined();
  });

  it("rejects an option source before Alpaca or local reservation", async () => {
    const signalId = "44444444-4444-4444-8444-444444444444";
    const { db, inserted } = createDb({
      signal: {
        id: signalId,
        symbol: "AAPL",
        metadata: null,
        content: "BTO $AAPL 250C 7/19",
      },
    });

    await expect(
      caller(db).submit({
        ...normalOrderInput,
        idempotencyKey: "option-source-equity-route",
        signalId,
        copySourceItemId: `x_signal:${signalId}`,
      }),
    ).rejects.toThrow("option contract");

    expect(getAlpacaClient).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("retains dedicated manual attribution through an ambiguous Alpaca result", async () => {
    const signalId = "55555555-5555-4555-8555-555555555555";
    getAlpacaClient.mockResolvedValue({
      client: { createOrder: vi.fn().mockRejectedValue(ambiguousOrderError()) },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, updates } = createDb({
      signal: {
        id: signalId,
        symbol: "AAPL",
        metadata: null,
        content: "Buying AAPL here",
      },
    });

    const result = await caller(db).submit({
      ...normalOrderInput,
      idempotencyKey: "ambiguous-manual-source",
      signalId,
      copySourceItemId: `x_signal:${signalId}`,
      notes: "keep this note",
    });

    expect(result).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
    expect(inserted[0]).toMatchObject({
      notes: "keep this note",
      manualCopySourceItemId: `x_signal:${signalId}`,
      manualCopySourceOrderId: null,
    });
    expect(updates.every((update) => !("manualCopySourceItemId" in update))).toBe(true);
  });

  it("binds every stock replay source shape before any source lookup or broker call", async () => {
    const sourceA = "x_signal:66666666-6666-4666-8666-666666666666";
    const sourceB = "x_signal:77777777-7777-4777-8777-777777777777";
    const cases = [
      { name: "same", persisted: sourceA, incoming: sourceA, accepted: true },
      { name: "changed", persisted: sourceA, incoming: sourceB, accepted: false },
      { name: "added", persisted: null, incoming: sourceA, accepted: false },
      { name: "omitted", persisted: sourceA, incoming: undefined, accepted: false },
    ] as const;

    for (const testCase of cases) {
      const { db, signalFindFirst } = createDb({
        existing: {
          id: `replay-${testCase.name}`,
          userId: "user-a",
          status: "FILLED",
          brokerOrderId: "broker-existing",
          manualCopySourceItemId: testCase.persisted,
        },
      });

      const input = {
        ...normalOrderInput,
        idempotencyKey: `stock-replay-${testCase.name}`,
        copySourceItemId: testCase.incoming,
      };
      if (testCase.accepted) {
        await expect(caller(db).submit(input)).resolves.toMatchObject({
          success: true,
          orderId: `replay-${testCase.name}`,
        });
      } else {
        await expect(caller(db).submit(input)).rejects.toMatchObject({ code: "CONFLICT" });
      }
      expect(signalFindFirst).not.toHaveBeenCalled();
      expect(getAlpacaClient).not.toHaveBeenCalled();
    }
  });

  it("submits a normal option order without a copy source", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-option-normal" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, signalFindFirst } = createDb();

    const result = await caller(db).submit({
      symbol: "AAPL",
      assetType: "OPTION",
      orderType: "Limit",
      tradeAction: "BuyToOpen",
      direction: "long",
      quantity: 1,
      limitPrice: 1.5,
      optionExpiration: "270719",
      optionStrike: 250,
      optionType: "CALL",
      timeInForce: "day",
      idempotencyKey: "normal-option-without-source",
    });

    expect(result).toMatchObject({ success: true, brokerOrderId: "broker-option-normal" });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(signalFindFirst).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ assetType: "OPTION", optionType: "CALL" });
    expect(inserted[0]?.manualCopySourceItemId).toBeUndefined();
    expect(inserted[0]?.manualCopySourceOrderId).toBeUndefined();
  });

  it("does not disclose or return another tenant's matching row", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-user-a" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db } = createDb({
      existing: {
        id: "other-tenant-order",
        userId: "user-b",
        brokerOrderId: "other-tenant-broker",
      },
    });

    const result = await caller(db, "user-a").submit(normalOrderInput);

    expect(result.orderId).toBe("local-order-1");
    expect(result.brokerOrderId).toBe("broker-user-a");
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("marks an ambiguous normal order SYNCING and returns an explicit syncing response", async () => {
    const ambiguous = new AlpacaAmbiguousOrderError(
      "create_order",
      new Error("lookup unavailable"),
      "broker-id",
    );
    const createOrder = vi.fn().mockRejectedValue(ambiguous);
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, updates } = createDb();

    const result = await caller(db).submit(normalOrderInput);

    expect(inserted[0].status).toBe("PENDING");
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(updates).toContainEqual(expect.objectContaining({ status: "SYNCING" }));
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "local-order-1",
    });
    expect(result.brokerOrderId).toBeNull();
  });

  it("never rejects a broker-accepted order when the local acceptance update fails", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-accepted-1" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: {
        credentialId: "11111111-1111-4111-8111-111111111111",
        accountId: "account-1",
      },
    });
    const { db, updates } = createDb({ failUpdateCalls: [1] });

    const result = await caller(db).submit(normalOrderInput);

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: "SYNCING",
        brokerOrderId: "broker-accepted-1",
      }),
    );
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      brokerOrderId: "broker-accepted-1",
    });
  });

  it("treats a zero-row broker acceptance CAS as syncing and skips social publication", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-cas-lost" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, updates } = createDb({ zeroRowUpdateCalls: [1] });

    const result = await caller(db).submit(normalOrderInput);

    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      brokerOrderId: "broker-cas-lost",
    });
    expect(updates).toContainEqual(expect.objectContaining({ status: "SYNCING" }));
    expect(inserted).toHaveLength(1);
  });

  it("requires exactly one broker acceptance row and skips social on an ambiguous multi-row CAS", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-cas-ambiguous" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, updates } = createDb({
      updateRowsByCall: { 1: [{ id: "winner-a" }, { id: "winner-b" }] },
    });

    const result = await caller(db).submit(normalOrderInput);

    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      brokerOrderId: "broker-cas-ambiguous",
    });
    expect(updates.map((update) => update.status)).toEqual(["SUBMITTED", "SYNCING"]);
  });

  it("returns the reread FILLED state after a zero-row acceptance race without fallback overwrite or social publication", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-race-filled" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, updates } = createDb({
      zeroRowUpdateCalls: [1],
      findFirstRows: [null, {
        id: "local-order-1",
        userId: "user-a",
        clientOrderId: "stored-broker-id",
        brokerOrderId: "broker-race-filled",
        status: "FILLED",
      }],
    });

    const result = await caller(db).submit(normalOrderInput);

    expect(result).toMatchObject({
      success: false,
      status: "FILLED",
      brokerOrderId: "broker-race-filled",
    });
    expect(result.syncing).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it("marks an ambiguous Smart Exit entry SYNCING", async () => {
    const ambiguous = new AlpacaAmbiguousOrderError(
      "create_order",
      new Error("lookup unavailable"),
      "broker-id",
    );
    const createOrder = vi.fn().mockRejectedValue(ambiguous);
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, updates } = createDb();

    const result = await caller(db).submitWithExitPlan({
      symbol: "AAPL",
      side: "buy",
      direction: "long",
      quantity: 2,
      orderType: "market",
      timeInForce: "gtc",
      takeProfits: [{ price: 210, qtyFraction: 0.5 }],
      trailingStop: { trailPercent: 5 },
      idempotencyKey: "smart-intent",
    });

    expect(inserted[0].status).toBe("PENDING");
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(result).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
  });

  it("rejects Smart Exit take-profit allocations above the filled quantity", async () => {
    const { db } = createDb();

    await expect(caller(db).submitWithExitPlan({
      symbol: "AAPL",
      side: "buy",
      direction: "long",
      quantity: 10,
      orderType: "market",
      timeInForce: "gtc",
      takeProfits: [
        { price: 210, qtyFraction: 0.6 },
        { price: 220, qtyFraction: 0.5 },
      ],
      idempotencyKey: "smart-overallocated",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("rejects a trailing runner when take profits consume the full quantity", async () => {
    const { db } = createDb();

    await expect(caller(db).submitWithExitPlan({
      symbol: "AAPL",
      side: "buy",
      direction: "long",
      quantity: 10,
      orderType: "market",
      timeInForce: "gtc",
      takeProfits: [{ price: 210, qtyFraction: 1 }],
      trailingStop: { trailPercent: 5 },
      idempotencyKey: "smart-no-runner",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("rejects an exit plan that has no stop, no TP, and no trailing", async () => {
    const { db } = createDb();

    await expect(
      caller(db).submitWithExitPlan({
        symbol: "AAPL",
        side: "buy",
        direction: "long",
        quantity: 2,
        orderType: "market",
        timeInForce: "gtc",
        takeProfits: [],
        idempotencyKey: "smart-empty",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("stop"),
    });
    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("submits a stop-only Smart Exit as an Alpaca OTO with a stop_loss child", async () => {
    // Stop-only Smart Exit path: the entry is wrapped in order_class="oto"
    // with a stop_loss child so the broker attaches the stop atomically.
    // No post-fill worker attach is needed, so the local row is inserted
    // with exitPlanStatus="attached" from the start.
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-stop-only-1" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted } = createDb();

    const result = await caller(db).submitWithExitPlan({
      symbol: "AAPL",
      side: "buy",
      direction: "long",
      quantity: 3,
      orderType: "market",
      timeInForce: "gtc",
      takeProfits: [],
      stopMarketPrice: 190,
      // trailingStop intentionally omitted
      idempotencyKey: "smart-stop-only",
    });

    expect(createOrder).toHaveBeenCalledTimes(1);
    const payload = createOrder.mock.calls[0][0];
    expect(payload).toMatchObject({
      symbol: "AAPL",
      qty: 3,
      side: "buy",
      type: "market",
      order_class: "oto",
      stop_loss: { stop_price: 190 },
    });
    // client_order_id must still be present (real-money idempotency rule).
    expect(typeof payload.client_order_id).toBe("string");
    expect(payload.client_order_id.length).toBeGreaterThan(0);

    // Local row is inserted with the exit plan already marked attached so
    // OrderSyncPoller.attachExitPlan (which gates on "pending") skips it.
    expect(inserted[0]).toMatchObject({
      status: "PENDING",
      exitPlanStatus: "attached",
      stopMarketPrice: "190",
    });
    // Success message reflects the OTO stop-attached semantics rather than
    // the worker-attach wording used for TP/trailing plans.
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain("Broker stop attached");
  });

  it("does not switch to OTO when the exit plan has take-profit legs", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-mixed-1" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted } = createDb();

    await caller(db).submitWithExitPlan({
      symbol: "AAPL",
      side: "buy",
      direction: "long",
      quantity: 2,
      orderType: "market",
      timeInForce: "gtc",
      takeProfits: [{ price: 210, qtyFraction: 0.5 }],
      stopMarketPrice: 190,
      idempotencyKey: "smart-tp-plus-stop",
    });

    const payload = createOrder.mock.calls[0][0];
    expect(payload.order_class).toBeUndefined();
    expect(payload.stop_loss).toBeUndefined();
    // Worker still owns leg attach for the TP-carrying case.
    expect(inserted[0].exitPlanStatus).toBe("pending");
  });

  it("replays a successful bracket intent from the tenant's local row without another POST", async () => {
    const createBracketOrder = vi.fn();
    getAlpacaClient.mockResolvedValue({
      client: { createBracketOrder },
      credentials: { accountId: "account-1" },
    });
    const { db } = createDb({
      existing: {
        id: "local-bracket",
        userId: "user-a",
        brokerOrderId: "broker-bracket",
        clientOrderId: "stored-broker-id",
      },
    });

    const result = await caller(db).submitBracket({
      symbol: "AAPL",
      assetType: "EQUITY",
      side: "buy",
      quantity: 1,
      orderType: "market",
      takeProfitPrice: 210,
      stopLossPrice: 190,
      timeInForce: "gtc",
      idempotencyKey: "bracket-logical-key",
    });

    expect(createBracketOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, replayed: true });
  });

  it("replays an existing OCO leg without another POST", async () => {
    const createOrder = vi.fn();
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const { db } = createDb({
      existing: {
        id: "local-oco",
        userId: "user-a",
        brokerOrderId: "broker-oco",
        clientOrderId: "stored-oco-id",
      },
    });

    const result = await caller(db).submitOCO({
      symbol: "AAPL",
      quantity: 1,
      takeProfits: [{ price: 210, quantity: 1 }],
      stopLossPrice: 190,
      timeInForce: "gtc",
      idempotencyKey: "oco-logical-key",
    });

    expect(createOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, replayed: true });
    expect(result.orders).toEqual(["broker-oco"]);
  });

  it("rejects more than ten OCO take-profit legs before broker setup", async () => {
    const { db } = createDb();

    await expect(
      caller(db).submitOCO({
        symbol: "AAPL",
        quantity: 11,
        takeProfits: Array.from({ length: 11 }, (_, index) => ({
          price: 210 + index,
          quantity: 1,
        })),
        stopLossPrice: 190,
        timeInForce: "gtc",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("charges the order rate limiter once per OCO take-profit leg", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-oco-leg" });
    getAlpacaClient.mockResolvedValue({
      client: { createOrder },
      credentials: { accountId: "account-1" },
    });
    const incrByWithTtl = vi
      .fn()
      .mockImplementation((_key: string, amount: number) =>
        Promise.resolve(amount),
      );
    getRedisClient.mockResolvedValue({ incrByWithTtl });
    const { db } = createDb();

    await caller(db).submitOCO({
      symbol: "AAPL",
      quantity: 3,
      takeProfits: [
        { price: 210, quantity: 1 },
        { price: 220, quantity: 1 },
        { price: 230, quantity: 1 },
      ],
      stopLossPrice: 190,
      timeInForce: "gtc",
      idempotencyKey: "oco-three-legs",
    });

    expect(incrByWithTtl).toHaveBeenCalledTimes(1);
    expect(incrByWithTtl).toHaveBeenCalledWith("rate_limit:orders:user-a", 3, 1);
    expect(createOrder).toHaveBeenCalledTimes(3);
  });

  it("rejects an OCO submission whose leg charge exceeds the budget before any broker call", async () => {
    getAlpacaClient.mockResolvedValue({
      client: { createOrder: vi.fn() },
      credentials: { accountId: "account-1" },
    });
    getRedisClient.mockResolvedValue({
      // 3 legs land the counter at 7, past the 5-orders-per-second budget.
      incrByWithTtl: vi.fn().mockResolvedValue(7),
    });
    const { db } = createDb();

    await expect(
      caller(db).submitOCO({
        symbol: "AAPL",
        quantity: 3,
        takeProfits: [
          { price: 210, quantity: 1 },
          { price: 220, quantity: 1 },
          { price: 230, quantity: 1 },
        ],
        stopLossPrice: 190,
        timeInForce: "gtc",
        idempotencyKey: "oco-over-budget",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("fails the OCO submission closed when the rate limiter is unavailable", async () => {
    getAlpacaClient.mockResolvedValue({
      client: { createOrder: vi.fn() },
      credentials: { accountId: "account-1" },
    });
    getRedisClient.mockRejectedValue(new Error("write ECONNRESET"));
    const { db } = createDb();

    await expect(
      caller(db).submitOCO({
        symbol: "AAPL",
        quantity: 1,
        takeProfits: [{ price: 210, quantity: 1 }],
        stopLossPrice: 190,
        timeInForce: "gtc",
        idempotencyKey: "oco-redis-down",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringContaining("rate limiter"),
    });

    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("fails the OCO submission closed when the limiter returns its zero error sentinel", async () => {
    getAlpacaClient.mockResolvedValue({
      client: { createOrder: vi.fn() },
      credentials: { accountId: "account-1" },
    });
    getRedisClient.mockResolvedValue({
      // incrByWithTtl converts command errors to 0 instead of throwing.
      incrByWithTtl: vi.fn().mockResolvedValue(0),
    });
    const { db } = createDb();

    await expect(
      caller(db).submitOCO({
        symbol: "AAPL",
        quantity: 1,
        takeProfits: [{ price: 210, quantity: 1 }],
        stopLossPrice: 190,
        timeInForce: "gtc",
        idempotencyKey: "oco-zero-sentinel",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringContaining("rate limiter"),
    });

    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("rejects more than ten Smart Exit take-profit legs before broker setup", async () => {
    const { db } = createDb();

    await expect(
      caller(db).submitWithExitPlan({
        symbol: "AAPL",
        side: "buy",
        direction: "long",
        quantity: 22,
        orderType: "market",
        timeInForce: "gtc",
        takeProfits: Array.from({ length: 11 }, (_, index) => ({
          price: 210 + index,
          qtyFraction: 0.05,
        })),
        idempotencyKey: "smart-too-many-legs",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("rejects OCO legs whose aggregate quantity exceeds the requested quantity", async () => {
    const { db } = createDb();

    await expect(
      caller(db).submitOCO({
        symbol: "AAPL",
        quantity: 2,
        takeProfits: [
          { price: 210, quantity: 2 },
          { price: 220, quantity: 1 },
        ],
        stopLossPrice: 190,
        timeInForce: "gtc",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(getAlpacaClient).not.toHaveBeenCalled();
  });

  it("marks an ambiguous trailing-stop row SYNCING", async () => {
    const ambiguous = new AlpacaAmbiguousOrderError(
      "create_order",
      new Error("lookup unavailable"),
      "broker-id",
    );
    const createTrailingStopOrder = vi.fn().mockRejectedValue(ambiguous);
    getAlpacaClient.mockResolvedValue({
      client: { createTrailingStopOrder },
      credentials: { accountId: "account-1" },
    });
    const { db, inserted, updates } = createDb();

    const result = await caller(db).submitTrailingStop({
      symbol: "AAPL",
      side: "sell",
      quantity: 1,
      trailPercent: 5,
      timeInForce: "gtc",
      idempotencyKey: "trail-logical-key",
    });

    expect(inserted[0]).toMatchObject({ status: "PENDING", userId: "user-a" });
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(result).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
  });

  describe("ambiguous submission CAS cardinality", () => {
    for (const [handler, status, brokerOrderId] of [
      ["normal", "FILLED", "broker-race-filled"],
      ["bracket", "REJECTED", "broker-race-rejected"],
      ["smart-exit", "SUBMITTED", "broker-race-submitted"],
      ["oco", "FILLED", "broker-oco-filled"],
      ["trailing-stop", "REJECTED", "broker-trailing-rejected"],
    ] as const) {
      it(`returns the authoritative ${status} state for a zero-row ${handler} CAS`, async () => {
        const { db, updates } = createDb({
          zeroRowUpdateCalls: [1],
          findFirstRows: [null, {
            id: "local-order-1",
            userId: "user-a",
            clientOrderId: "stored-client-id",
            brokerOrderId,
            status,
          }],
        });

        const result = await submitAmbiguousHandler(handler, db);

        expect(result).toMatchObject({
          success: false,
          status,
          brokerOrderId,
        });
        expect(result.syncing).toBe(false);
        expect(updates).toHaveLength(1);
      });
    }

    for (const handler of [
      "normal",
      "bracket",
      "smart-exit",
      "oco",
      "trailing-stop",
    ] as const) {
      it(`rereads the authoritative state after a multiple-row ${handler} CAS`, async () => {
        const { db, updates } = createDb({
          updateRowsByCall: { 1: [{ id: "winner-a" }, { id: "winner-b" }] },
          findFirstRows: [null, {
            id: "local-order-1",
            userId: "user-a",
            clientOrderId: "stored-client-id",
            brokerOrderId: `broker-${handler}-authoritative`,
            status: "SUBMITTED",
          }],
        });

        const result = await submitAmbiguousHandler(handler, db);

        expect(result).toMatchObject({
          success: false,
          status: "SUBMITTED",
          brokerOrderId: `broker-${handler}-authoritative`,
        });
        expect(result.syncing).toBe(false);
        expect(updates).toHaveLength(1);
      });
    }
  });

  it("does not invent a persisted status when an ambiguous CAS loses and reread fails", async () => {
    const { db } = createDb({ zeroRowUpdateCalls: [1] });
    const findFirst = db.query.orders.findFirst;
    findFirst
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => {
        throw new Error("authoritative reread unavailable");
      });

    const result = await submitAmbiguousHandler("normal", db);

    expect(result).toMatchObject({
      success: false,
      syncing: true,
      orderId: "local-order-1",
      brokerOrderId: null,
      message: expect.stringContaining("reconciliation"),
    });
    expect(result.status).toBeUndefined();
  });

  it("refuses to cancel a submitted row until its broker ID has reconciled", async () => {
    const { db, updates } = createDb({
      existing: {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "user-a",
        status: "SUBMITTED",
        brokerOrderId: null,
        brokerAccountId: "paper-account",
        brokerCredentialId: "22222222-2222-4222-8222-222222222222",
      },
    });

    await expect(
      caller(db).cancel({ orderId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(updates).toHaveLength(0);
  });

  it("cancels through the exact credential before changing local status", async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    getAlpacaClient.mockResolvedValue({
      client: { cancelOrder },
      credentials: { accountId: "paper-account" },
    });
    const { db, updates } = createDb({
      existing: {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "user-a",
        status: "SUBMITTED",
        brokerOrderId: "broker-order-1",
        brokerAccountId: "paper-account",
        brokerCredentialId: "22222222-2222-4222-8222-222222222222",
      },
    });

    await caller(db).cancel({ orderId: "11111111-1111-4111-8111-111111111111" });

    expect(getAlpacaClient).toHaveBeenCalledWith(db, "user-a", {
      accountId: "paper-account",
      credentialId: "22222222-2222-4222-8222-222222222222",
    });
    expect(cancelOrder).toHaveBeenCalledWith("broker-order-1");
    expect(updates).toContainEqual(expect.objectContaining({ status: "CANCELLED" }));
  });

  it("refuses to route a Hyperliquid perp order through the Alpaca cancel path", async () => {
    // A copy-mirror perp row: brokerCredentialId points at a
    // provider='hyperliquid' credential, brokerOrderId is the numeric HL
    // oid as a string. Nothing here should ever build an Alpaca client or
    // call its cancelOrder. Mock getAlpacaClient to resolve successfully so
    // a pre-fix run demonstrates it actually gets invoked and "succeeds"
    // against the wrong venue, instead of merely erroring out downstream.
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    getAlpacaClient.mockResolvedValue({
      client: { cancelOrder },
      credentials: { accountId: "paper-account" },
    });
    const { db, updates } = createDb({
      existing: {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "user-a",
        status: "SUBMITTED",
        assetType: "PERP",
        venue: "hyperliquid",
        brokerOrderId: "35471234567",
        brokerAccountId: null,
        brokerCredentialId: "33333333-3333-4333-8333-333333333333",
      },
    });

    await expect(
      caller(db).cancel({ orderId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(getAlpacaClient).not.toHaveBeenCalled();
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("refuses an API-placed perp row (null broker columns) via the Alpaca cancel path", async () => {
    // submitPerp inserts via toPerpOrderRow with no brokerAccountId/
    // brokerCredentialId set. Without a venue guard this would silently
    // resolve the user's Alpaca keys and issue a cancel for a Hyperliquid
    // oid against Alpaca.
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    getAlpacaClient.mockResolvedValue({
      client: { cancelOrder },
      credentials: { accountId: "paper-account" },
    });
    const { db, updates } = createDb({
      existing: {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "user-a",
        status: "SUBMITTED",
        assetType: "PERP",
        venue: "hyperliquid",
        brokerOrderId: "35471234568",
        brokerAccountId: null,
        brokerCredentialId: null,
      },
    });

    await expect(
      caller(db).cancel({ orderId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(getAlpacaClient).not.toHaveBeenCalled();
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
