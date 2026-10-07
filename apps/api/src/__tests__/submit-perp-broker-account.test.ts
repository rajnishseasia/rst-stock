/**
 * orders.submitPerp brokerAccountId
 *
 * The reconciler groups a perp order by `orders.brokerAccountId` and only
 * falls back to the user's CURRENT hyperliquid credential address when that
 * column is null (apps/worker/src/services/hyperliquid-order-sync.ts). The
 * copy-mirror path already stamps `walletAddress` into that column
 * (copy-mirror-perp-execution.ts, copy-mirror.ts). The UI-facing
 * `orders.submitPerp` mutation must do the same, or a wallet
 * reconnect/rotation between submission and reconciliation makes the
 * reconciler check a snapshot for the WRONG address and settle a still-live
 * order CANCELLED.
 */

import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";

const createHyperliquidExchangeClient = vi.fn();

vi.mock("../lib/hyperliquid.js", () => ({
  createHyperliquidExchangeClient,
  HL_AGENT_REGISTERED: "LIVE",
}));

const getRedisClient = vi.fn();
vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const { ordersRouter } = await import("../routers/orders.js");

afterAll(() => mock.restore());

function logger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createDb() {
  const insertedRows: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const db: any = {
    query: {
      userApiCredentials: {
        findFirst: vi.fn().mockResolvedValue({ accountType: "LIVE" }),
      },
      orders: {
        // No prior order with this cloid — every submit is a first attempt.
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
  };

  db.insert = vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation((row: Record<string, unknown>) => ({
      returning: vi.fn().mockImplementation(async () => {
        const id = `row-${insertedRows.length + 1}`;
        const stored = { id, ...row };
        insertedRows.push(stored);
        return [stored];
      }),
    })),
  });

  // The post-acceptance status write is a compare-and-set that has to come back
  // with exactly one row, or the router reports the submission as unresolved.
  db.update = vi.fn().mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
      where: vi.fn().mockImplementation(() => {
        updates.push(values);
        return { returning: vi.fn().mockResolvedValue([{ id: "row-1" }]) };
      }),
    })),
  });

  return { db, insertedRows, updates };
}

function caller(db: any, userId: string) {
  return ordersRouter.createCaller({
    db,
    session: { userId },
    userId,
    logger: logger() as any,
  });
}

describe("orders.submitPerp brokerAccountId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisClient.mockResolvedValue({ incrWithTtl: vi.fn().mockResolvedValue(1) });
  });

  it("stamps the placing wallet address into brokerAccountId, matching the copy-mirror path", async () => {
    const { db, insertedRows } = createDb();
    const client = {
      resolveAsset: vi.fn().mockResolvedValue({
        coin: "BTC",
        szDecimals: 3,
        maxLeverage: 40,
      }),
      allMids: vi.fn().mockResolvedValue({ BTC: "60000" }),
      placeOrder: vi.fn().mockResolvedValue({ status: "ok" }),
    };
    createHyperliquidExchangeClient.mockResolvedValue({
      client,
      walletAddress: "0xFollowerWallet",
    });

    const result = await caller(db, "user-1").submitPerp({
      coin: "BTC",
      isLong: true,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "0.1",
      reduceOnly: true,
      postOnly: false,
      leverage: 5,
      cloid: "perp-broker-account-test",
    });

    expect(result.success).toBe(true);
    expect(insertedRows).toHaveLength(1);
    // This is the guard: a null brokerAccountId here is exactly the defect —
    // the reconciler's `user:${userId}` fallback then resolves whatever
    // wallet is CURRENTLY on the credential row, not the one this order was
    // actually placed against.
    expect(insertedRows[0]?.brokerAccountId).toBe("0xFollowerWallet");
  });
});
