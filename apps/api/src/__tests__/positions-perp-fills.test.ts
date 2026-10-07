import { beforeEach, describe, expect, it, vi } from "bun:test";
import { createHyperliquidInfoClient } from "../lib/hyperliquid.js";
import { positionsRouter } from "../routers/positions.js";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const FILLS = [
  {
    time: 1_788_000_000_000,
    coin: "BTC",
    side: "A",
    px: "59000",
    sz: "0.01",
    closedPnl: "1",
    fee: "0.1",
    dir: "Close Long",
    oid: 501,
    hash: "0xstop-fill",
    tid: 1,
    cloid: null,
  },
  {
    time: 1_788_000_001_000,
    coin: "ETH",
    side: "A",
    px: "2500",
    sz: "0.2",
    closedPnl: "0",
    fee: "0.1",
    dir: "Close Long",
    oid: 502,
    hash: "0xmanual-fill",
    tid: 2,
    cloid: null,
  },
];

describe("positions.listPerpFills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches a matching string OID as a StopMarket fill in one lookup", async () => {
    const findOrders = vi.fn().mockResolvedValue([
      { brokerOrderId: "501", orderType: "StopMarket" },
    ]);
    const listFills = vi.fn().mockResolvedValue(FILLS);
    const findCredential = vi.fn().mockResolvedValue({
      accountId: WALLET_ADDRESS,
      username: null,
    });
    const info = createHyperliquidInfoClient();
    const originalListFills = info.listFills;
    info.listFills = listFills as typeof info.listFills;

    try {
      const caller = positionsRouter.createCaller({
        db: {
          query: {
            userApiCredentials: { findFirst: findCredential },
            orders: { findMany: findOrders },
          },
        },
        session: { userId: "user-a" },
        userId: "user-a",
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        } as never,
      } as never);
      const result = await caller.listPerpFills({});

      expect(findCredential).toHaveBeenCalledTimes(1);
      expect(findOrders).toHaveBeenCalledTimes(1);
      expect(listFills).toHaveBeenCalledWith(WALLET_ADDRESS, 50);
      expect(result.fills).toEqual([
        { ...FILLS[0], orderType: "StopMarket" },
        { ...FILLS[1], orderType: null },
      ]);
    } finally {
      info.listFills = originalListFills;
    }
  });
});
