import { afterAll, describe, expect, it, mock, vi } from "bun:test";

const createHyperliquidInfoClient = vi.fn();
const callWorker = vi.fn();

vi.mock("../lib/hyperliquid.js", () => ({ createHyperliquidInfoClient }));
vi.mock("../lib/call-worker.js", () => ({ callWorker }));

const { pnlImageRouter } = await import("../routers/pnl-image.js");

afterAll(() => mock.restore());

const CARD = { base64: "abc", mimeType: "image/jpeg", width: 1536, height: 1024 };

function createDb(walletAddress: string | null) {
  return {
    query: {
      userApiCredentials: {
        findFirst: vi.fn().mockResolvedValue(
          walletAddress ? { accountId: walletAddress, username: null } : undefined,
        ),
      },
    },
  } as any;
}

function caller(db: any) {
  return pnlImageRouter.createCaller({
    db,
    session: { userId: "user-1" },
    userId: "user-1",
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as any,
  } as any);
}

function position(overrides: Record<string, unknown> = {}) {
  return {
    coin: "BTC",
    side: "long",
    size: "0.5",
    entryPx: "60000",
    markPx: "62000",
    liquidationPx: "40000",
    unrealizedPnl: "1000",
    returnOnEquity: "0.25",
    leverage: 10,
    marginMode: "cross",
    marginUsed: "3000",
    funding: "-1.25",
    ...overrides,
  };
}

function infoClient(positions: unknown[]) {
  return {
    listPositions: vi.fn().mockResolvedValue(positions),
    listFills: vi.fn().mockResolvedValue([]),
  };
}

describe("pnlImage.generateOpenPerp", () => {
  it("values the card from the live Hyperliquid position, not the client", async () => {
    createHyperliquidInfoClient.mockReturnValue(infoClient([position()]));
    callWorker.mockResolvedValue(CARD);

    const result = await caller(createDb("0x" + "a".repeat(40))).generateOpenPerp({
      coin: "BTC",
    });

    expect(result).toEqual(CARD);
    const [path, payload] = callWorker.mock.calls.at(-1)!;
    expect(path).toBe("/pnl-image/generate");
    expect(payload).toMatchObject({
      symbol: "BTC",
      side: "long",
      qty: 0.5,
      entryPrice: 60000,
      exitPrice: 62000,
      pnlUsd: 1000,
      // Return on equity, not return on notional: the percent has to be against
      // the margin at risk on a leveraged position.
      pnlPercent: 25,
      totalValueUsd: 31000,
      result: "open",
      leverageLabel: "10x cross",
    });
  });

  it("falls back to P&L over margin used when HL reports no ROE", async () => {
    createHyperliquidInfoClient.mockReturnValue(
      infoClient([position({ returnOnEquity: null })]),
    );
    callWorker.mockResolvedValue(CARD);

    await caller(createDb("0x" + "a".repeat(40))).generateOpenPerp({ coin: "BTC" });

    expect(callWorker.mock.calls.at(-1)![1]).toMatchObject({ pnlPercent: (1000 / 3000) * 100 });
  });

  it("shares unrealized plus realized P&L banked on the current open run", async () => {
    const info = infoClient([
      position({ size: "0.25", unrealizedPnl: "250", returnOnEquity: String(250 / 3000) }),
    ]);
    info.listFills.mockResolvedValue([
      { time: 2, coin: "BTC", side: "sell", px: "62000", sz: "0.25", closedPnl: "500", fee: "1", dir: "Close Long", oid: 2 },
      { time: 1, coin: "BTC", side: "buy", px: "60000", sz: "0.5", closedPnl: "0", fee: "1", dir: "Open Long", oid: 1 },
    ]);
    createHyperliquidInfoClient.mockReturnValue(info);
    callWorker.mockResolvedValue(CARD);

    await caller(createDb("0x" + "a".repeat(40))).generateOpenPerp({ coin: "BTC" });

    expect(info.listFills).toHaveBeenCalledWith("0x" + "a".repeat(40), 200);
    expect(callWorker.mock.calls.at(-1)![1]).toMatchObject({
      pnlUsd: 750,
      pnlPercent: 25,
    });
  });

  it("strips the HIP-3 dex prefix from the shared symbol", async () => {
    createHyperliquidInfoClient.mockReturnValue(
      infoClient([position({ coin: "test:GOLD" })]),
    );
    callWorker.mockResolvedValue(CARD);

    await caller(createDb("0x" + "a".repeat(40))).generateOpenPerp({ coin: "test:GOLD" });

    expect(callWorker.mock.calls.at(-1)![1]).toMatchObject({
      symbol: "GOLD",
      unitLabel: "GOLD",
    });
  });

  it("rejects a position HL reported without a usable mark price", async () => {
    createHyperliquidInfoClient.mockReturnValue(infoClient([position({ markPx: null })]));
    callWorker.mockClear();

    await expect(
      caller(createDb("0x" + "a".repeat(40))).generateOpenPerp({ coin: "BTC" }),
    ).rejects.toThrow(/incomplete position/);
    expect(callWorker).not.toHaveBeenCalled();
  });

  it("404s when the coin is not an open position", async () => {
    createHyperliquidInfoClient.mockReturnValue(infoClient([position()]));

    await expect(
      caller(createDb("0x" + "a".repeat(40))).generateOpenPerp({ coin: "ETH" }),
    ).rejects.toThrow(/No open perp position for ETH/);
  });

  it("rejects when perps are not enabled for the account", async () => {
    createHyperliquidInfoClient.mockClear();

    await expect(caller(createDb(null)).generateOpenPerp({ coin: "BTC" })).rejects.toThrow(
      /Perps are not enabled/,
    );
    expect(createHyperliquidInfoClient).not.toHaveBeenCalled();
  });
});
