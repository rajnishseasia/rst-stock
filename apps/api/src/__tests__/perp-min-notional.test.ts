import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import {
  HYPERLIQUID_MIN_NOTIONAL_MESSAGE,
  effectivePerpOrderPrice,
  formatPerpOrderSizeForVenue,
  isPerpOrderNotionalAtLeastMinimum,
  perpOrderSubmitSchema,
} from "../lib/perp-orders.js";

const createHyperliquidExchangeClient = vi.fn();
const getRedisClient = vi.fn();

vi.mock("../lib/hyperliquid.js", () => ({
  createHyperliquidExchangeClient,
  HL_AGENT_REGISTERED: "LIVE",
}));

vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const { ordersRouter } = await import("../routers/orders.js");

afterAll(() => mock.restore());

function logger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createDb() {
  const rows: Record<string, unknown>[] = [];
  const db: any = {
    query: {
      userApiCredentials: {
        findFirst: vi.fn().mockResolvedValue({ accountType: "LIVE" }),
      },
      orders: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
  };

  db.insert = vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation((row: Record<string, unknown>) => ({
      returning: vi.fn().mockImplementation(async () => {
        const stored = { id: `row-${rows.length + 1}`, ...row };
        rows.push(stored);
        return [stored];
      }),
    })),
  });
  db.update = vi.fn().mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(async () => {
          if (rows.length === 0) return [];
          Object.assign(rows[0], values);
          return [{ id: rows[0]?.id }];
        }),
      }),
    })),
  });

  return { db, rows };
}

function caller(db: any) {
  return ordersRouter.createCaller({
    db,
    session: { userId: "user-1" },
    userId: "user-1",
    logger: logger() as any,
  });
}

function orderInput(overrides: Record<string, unknown> = {}) {
  return perpOrderSubmitSchema.parse({
    coin: "BTC",
    isLong: true,
    marginMode: "cross",
    orderType: "Limit",
    sizeCoin: "0.1",
    limitPrice: "100",
    reduceOnly: true,
    postOnly: false,
    leverage: 5,
    cloid: "perp-min-notional-test",
    ...overrides,
  });
}

function hyperliquidClient(options: {
  szDecimals?: number;
  mid?: string;
  placeOrder?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    resolveAsset: vi.fn().mockResolvedValue({
      coin: "BTC",
      szDecimals: options.szDecimals ?? 2,
      maxLeverage: 40,
    }),
    allMids: vi.fn().mockResolvedValue({ BTC: options.mid ?? "100" }),
    updateLeverage: vi.fn().mockResolvedValue({ status: "ok" }),
    placeOrder: options.placeOrder ?? vi.fn().mockResolvedValue({ status: "ok" }),
  };
}

describe("Hyperliquid perp minimum-notional math", () => {
  it("rounds size with the venue precision before checking the floor", () => {
    const size = formatPerpOrderSizeForVenue("0.1009", 2);

    expect(size).toBe("0.1");
    expect(isPerpOrderNotionalAtLeastMinimum(size, "100")).toBe(true);
    expect(
      isPerpOrderNotionalAtLeastMinimum(formatPerpOrderSizeForVenue("0.09999", 2), "111.11"),
    ).toBe(false);
  });

  it("uses the effective market, limit, and trigger prices", () => {
    expect(effectivePerpOrderPrice(orderInput({ orderType: "Market" }), "100", 2)).toBe("105");
    expect(effectivePerpOrderPrice(orderInput({ orderType: "Limit" }), undefined, 2)).toBe("100");
    expect(
      effectivePerpOrderPrice(
        orderInput({
          isLong: false,
          orderType: "StopMarket",
          limitPrice: undefined,
          triggerPx: "100",
        }),
        undefined,
        2,
      ),
    ).toBe("95");
    expect(
      effectivePerpOrderPrice(
        orderInput({
          orderType: "StopLimit",
          triggerPx: "100",
          limitPrice: "99.5",
        }),
        undefined,
        2,
      ),
    ).toBe("99.5");
  });

  it("accepts an exact $10 notional inclusively", () => {
    expect(isPerpOrderNotionalAtLeastMinimum("0.1", "100")).toBe(true);
  });
});

describe("orders.submitPerp minimum-notional preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
  });

  it("rejects below $10 using a fresh market price before inserting or calling the venue", async () => {
    const { db, rows } = createDb();
    const client = hyperliquidClient({ mid: "100", szDecimals: 2 });
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xMaster" });

    await expect(
      caller(db).submitPerp({
        ...orderInput({
          orderType: "Market",
          limitPrice: undefined,
          markPrice: "1000",
          sizeCoin: "0.09",
          cloid: "below-market-floor",
        }),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: HYPERLIQUID_MIN_NOTIONAL_MESSAGE,
    });

    expect(client.resolveAsset).toHaveBeenCalledWith("BTC", expect.any(AbortSignal));
    expect(client.allMids).toHaveBeenCalledWith("BTC", expect.any(AbortSignal));
    expect(client.updateLeverage).not.toHaveBeenCalled();
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("uses the fresh market price for a passing market order instead of the stale mark", async () => {
    const { db, rows } = createDb();
    const client = hyperliquidClient({ mid: "100", szDecimals: 2 });
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xMaster" });

    const result = await caller(db).submitPerp({
      ...orderInput({
        orderType: "Market",
        limitPrice: undefined,
        markPrice: "1",
        sizeCoin: "0.1",
        cloid: "fresh-market-price",
      }),
    });

    expect(result.success).toBe(true);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(client.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ markPrice: "100", orderType: "Market" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SUBMITTED", quantityDecimal: "0.1" });
  });

  it("accepts a reduce-only order that rounds exactly to the $10 floor", async () => {
    const { db, rows } = createDb();
    const client = hyperliquidClient({ szDecimals: 2 });
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xMaster" });

    const result = await caller(db).submitPerp({
      ...orderInput({
        sizeCoin: "0.1009",
        limitPrice: "100",
        reduceOnly: true,
        cloid: "exact-rounded-floor",
      }),
    });

    expect(result.success).toBe(true);
    expect(client.allMids).not.toHaveBeenCalled();
    expect(client.updateLeverage).not.toHaveBeenCalled();
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it("returns a structured syncing result when the venue outcome is ambiguous", async () => {
    const { db, rows } = createDb();
    const placeOrder = vi.fn().mockRejectedValue(new Error("venue transport failed"));
    const client = hyperliquidClient({ placeOrder });
    createHyperliquidExchangeClient.mockResolvedValue({ client, walletAddress: "0xMaster" });

    const result = await caller(db).submitPerp({
      ...orderInput({ cloid: "unrelated-venue-failure" }),
    });

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SYNCING" });
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "row-1",
    });
  });
});
