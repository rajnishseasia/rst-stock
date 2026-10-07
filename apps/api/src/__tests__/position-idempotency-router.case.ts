import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { AlpacaAmbiguousOrderError, createBrokerClientOrderId } from "@trade-bot/alpaca";

const getDecryptedCredentials = vi.fn();
const createAlpacaClientFromCredentials = vi.fn();
// Mirrors the real getAlpacaClient (audit M12 helper): resolves credentials
// then builds a client, so tests keep stubbing the same two mocks as before.
const getAlpacaClient = vi.fn(
  async (db: unknown, userId: string, selector?: Record<string, unknown>) => {
    const credentials = await getDecryptedCredentials(db, userId, {
      provider: "alpaca",
      ...selector,
    });
    return { client: createAlpacaClientFromCredentials(credentials), credentials };
  },
);

vi.mock("../lib/credentials.js", () => ({ getDecryptedCredentials }));
vi.mock("../lib/alpaca.js", () => ({
  createAlpacaClientFromCredentials,
  getAlpacaClient,
  isPaperAccount: (accountType: string) =>
    accountType === "PAPER" || accountType === "SIM",
}));

const { positionsRouter } = await import("../routers/positions.js");

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

function createDb(
  existing: Record<string, unknown> | null = null,
  options: {
    failUpdateCalls?: number[];
    zeroRowUpdateCalls?: number[];
    updateRowsByCall?: Record<number, Array<Record<string, unknown>>>;
    findFirstRows?: Array<Record<string, unknown> | null>;
  } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const values = vi.fn().mockImplementation((value: Record<string, unknown>) => {
    inserted.push(value);
    return {
      returning: vi.fn().mockResolvedValue([
        { id: "local-close-1", userId: "user-a", brokerOrderId: null, ...value },
      ]),
    };
  });
  let updateCall = 0;
  let findFirstCall = 0;
  const findFirst = vi.fn().mockImplementation(async () => {
    const rows = options.findFirstRows;
    if (!rows || rows.length === 0) return existing;
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
        options.zeroRowUpdateCalls?.includes(updateCall) ? [] : [{ id: "updated-close" }]
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
      },
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
    } as any,
    inserted,
    updates,
  };
}

function caller(db: any) {
  return positionsRouter.createCaller({
    db,
    session: { userId: "user-a" },
    userId: "user-a",
    logger: logger() as any,
  });
}

const position = {
  symbol: "AAPL",
  qty: "5",
  qty_available: "5",
  side: "long",
  asset_class: "us_equity",
};

describe("positions router close ambiguity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDecryptedCredentials.mockResolvedValue({
      username: "key",
      accessToken: "secret",
      accountType: "LIVE",
      accountId: "account-1",
      credentialId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("marks a full close SYNCING and never falls back when DELETE recovery is ambiguous", async () => {
    const lookup403 = Object.assign(new Error("lookup forbidden"), { response: { status: 403 } });
    const ambiguous = new AlpacaAmbiguousOrderError(
      "close_position",
      lookup403,
      undefined,
      { position: "fulfilled", orders: "rejected" },
    );
    const client = {
      getPosition: vi.fn().mockResolvedValue(position),
      closePosition: vi.fn().mockRejectedValue(ambiguous),
      createOrder: vi.fn(),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted, updates } = createDb();

    const result = await caller(db).close({
      symbol: "AAPL",
      idempotencyKey: "close-browser-intent",
    });

    expect(client.closePosition).toHaveBeenCalledTimes(1);
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ status: "PENDING", userId: "user-a" });
    expect(inserted[0].clientOrderId).not.toBe("close-browser-intent");
    // DELETE /v2/positions/{symbol} (the standard full-close path) takes no
    // client_order_id (alpaca-05): Alpaca never saw the locally generated
    // rst-close-<hash> id, so brokerClientOrderId must not be back-filled
    // with it here. OrderSyncPoller (order-sync.ts) looks up
    // `brokerClientOrderId || clientOrderId` and reads a 404 on that id as
    // proof the order was never submitted; stamping a value Alpaca was never
    // given turns a real, ambiguous liquidation into a false "proven absent"
    // forever. Leaving it unset keeps that row honestly unlookupable instead
    // of asserting a false negative.
    expect(inserted[0].brokerClientOrderId).not.toBe(inserted[0].clientOrderId);
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "local-close-1",
    });
  });

  it("returns a prior ambiguous close intent without another DELETE", async () => {
    const client = {
      getPosition: vi.fn(),
      closePosition: vi.fn(),
      createOrder: vi.fn(),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db } = createDb({
      id: "pending-close",
      userId: "user-a",
      status: "SYNCING",
      brokerOrderId: null,
      clientOrderId: "tenant-broker-id",
    });

    const result = await caller(db).close({
      symbol: "AAPL",
      idempotencyKey: "close-browser-intent",
    });

    expect(client.closePosition).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "pending-close",
    });
  });

  it("does not reject a broker-accepted close when its local update fails", async () => {
    const client = {
      getPosition: vi.fn().mockResolvedValue(position),
      createOrder: vi.fn().mockResolvedValue({
        id: "broker-close-accepted",
        client_order_id: "broker-close-client",
      }),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, updates } = createDb(null, { failUpdateCalls: [1] });

    const result = await caller(db).close({
      symbol: "AAPL",
      qty: 2,
      idempotencyKey: "accepted-close-intent",
    });

    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(updates).toContainEqual(expect.objectContaining({
      status: "SYNCING",
      brokerOrderId: "broker-close-accepted",
      brokerClientOrderId: "broker-close-client",
    }));
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "local-close-1",
      brokerOrderId: "broker-close-accepted",
    });
  });

  it("treats a zero-row close acceptance CAS as syncing without reporting success", async () => {
    const client = {
      getPosition: vi.fn().mockResolvedValue(position),
      createOrder: vi.fn().mockResolvedValue({
        id: "broker-close-cas-lost",
        client_order_id: "broker-close-cas-client",
      }),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted, updates } = createDb(null, { zeroRowUpdateCalls: [1] });

    const result = await caller(db).close({
      symbol: "AAPL",
      qty: 2,
      idempotencyKey: "close-cas-lost",
    });

    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      brokerOrderId: "broker-close-cas-lost",
    });
    expect(updates).toContainEqual(expect.objectContaining({ status: "SYNCING" }));
    expect(inserted).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it("requires exactly one close acceptance row and skips close side effects on a multi-row CAS", async () => {
    const client = {
      getPosition: vi.fn().mockResolvedValue(position),
      createOrder: vi.fn().mockResolvedValue({
        id: "broker-close-ambiguous",
        client_order_id: "broker-close-ambiguous-client",
      }),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, updates } = createDb(null, {
      updateRowsByCall: { 1: [{ id: "winner-a" }, { id: "winner-b" }] },
    });

    const result = await caller(db).close({
      symbol: "AAPL",
      qty: 2,
      idempotencyKey: "close-cas-ambiguous",
    });

    expect(result).toMatchObject({ success: false, syncing: true, status: "SYNCING" });
    expect(updates.map((update) => update.status)).toEqual(["SUBMITTED", "SYNCING"]);
  });

  it("returns the reread FILLED close state after a zero-row race without overwriting it", async () => {
    const client = {
      getPosition: vi.fn().mockResolvedValue(position),
      createOrder: vi.fn().mockResolvedValue({
        id: "broker-close-filled",
        client_order_id: "broker-close-filled-client",
      }),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, updates } = createDb(null, {
      zeroRowUpdateCalls: [1],
      findFirstRows: [null, {
        id: "local-close-1",
        userId: "user-a",
        clientOrderId: "stored-close-id",
        brokerOrderId: "broker-close-filled",
        status: "FILLED",
      }],
    });

    const result = await caller(db).close({
      symbol: "AAPL",
      qty: 2,
      idempotencyKey: "close-cas-filled",
    });

    expect(result).toMatchObject({ success: false, status: "FILLED", brokerOrderId: "broker-close-filled" });
    expect(result.syncing).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it("preserves full-position DELETE behavior for fractional positions", async () => {
    const client = {
      getPosition: vi.fn().mockResolvedValue({
        ...position,
        qty: "0.5",
        qty_available: "0.5",
      }),
      closePosition: vi.fn().mockResolvedValue({ id: "broker-fractional" }),
      createOrder: vi.fn(),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted } = createDb();

    const result = await caller(db).close({
      symbol: "AAPL",
      idempotencyKey: "fractional-close-intent",
    });

    expect(client.closePosition).toHaveBeenCalledWith("AAPL");
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(inserted[0].quantity).toBe(1);
    expect(result).toMatchObject({ success: true, orderId: "broker-fractional" });
  });

  it("returns an explicit syncing response for ambiguous close-all without replaying", async () => {
    const ambiguous = new AlpacaAmbiguousOrderError(
      "close_all_positions",
      new Error("socket reset"),
      undefined,
    );
    const client = {
      closeAllPositions: vi.fn().mockRejectedValue(ambiguous),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db } = createDb();

    const result = await caller(db).closeAll({
      cancelOrders: true,
      idempotencyKey: "close-all-intent",
    });

    expect(client.closeAllPositions).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, syncing: true, status: "PENDING" });
  });

  it("publishes a closeAll OPTION as its underlying, not as an equity trade for the OCC string", async () => {
    // Found by review. The single-position close path was taught to parse the
    // OCC contract symbol; closeAll was not, and hardcoded assetType EQUITY
    // while publishing whatever symbol the 207 envelope carried.
    //
    // For an option that envelope carries the CONTRACT string
    // ("AAPL260821C00255000"), not a ticker. Published as EQUITY it breaks
    // copy-mirror discovery twice: social_trades is documented to hold only the
    // UNDERLYING, and a follower's mirror would try to place an equity SELL for
    // a string that is not a ticker. The follower's mirrored contract is then
    // stranded with its one exit already spent.
    const client = {
      closeAllPositions: vi.fn().mockResolvedValue([
        {
          symbol: "AAPL260821C00255000",
          status: 200,
          body: {
            id: "order-aapl-call",
            symbol: "AAPL260821C00255000",
            side: "sell",
            qty: "2",
          },
        },
      ]),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted } = createDb();
    // The local order that received this close carries the contract identity:
    // the UNDERLYING symbol, the asset type and the closing action. The social
    // row is built from it rather than from the 207 envelope, whose `symbol` is
    // the OCC contract string and whose asset class is not reported at all.
    db.query.orders.findMany = vi.fn().mockResolvedValue([
      {
        id: "local-order-aapl-call",
        brokerOrderId: "order-aapl-call",
        symbol: "AAPL",
        assetType: "OPTION",
        tradeAction: "SellToClose",
        direction: "long",
        quantity: 2,
        orderType: "Market",
        limitPrice: null,
      },
    ]);

    await caller(db).closeAll({ cancelOrders: true, idempotencyKey: "close-all-option" });

    const social = inserted.find((row) => row.orderType === "market");
    expect(social).toMatchObject({
      symbol: "AAPL",
      assetType: "OPTION",
      side: "sell",
      qty: 2,
      orderId: "local-order-aapl-call",
      brokerOrderId: "order-aapl-call",
    });
    // Never the raw contract string: that is the value a follower's mirror
    // would have tried to trade as a ticker.
    expect(social?.symbol).not.toBe("AAPL260821C00255000");
  });

  it("only publishes closeAll social rows for positions Alpaca actually closed (alpaca-06)", async () => {
    // DELETE /v2/positions returns HTTP 207 Multi-Status: an array of
    // {symbol, status, body} envelopes, one per position, where `status` is
    // the per-position HTTP result and the real Order lives under `.body`.
    // AAPL closed (200); MSFT was refused (403, e.g. a wash-trade rejection)
    // and never actually closed at the broker.
    const client = {
      closeAllPositions: vi.fn().mockResolvedValue([
        {
          symbol: "AAPL",
          status: 200,
          body: { id: "order-aapl", symbol: "AAPL", side: "sell", qty: "10" },
        },
        {
          symbol: "MSFT",
          status: 403,
          body: { message: "forbidden, wash trade" },
        },
      ]),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted } = createDb();
    // Only the ACCEPTED close has a local order to publish from. The refused
    // one is never looked up, and must not reach social_trades by any route.
    db.query.orders.findMany = vi.fn().mockResolvedValue([
      {
        id: "local-order-aapl",
        brokerOrderId: "order-aapl",
        symbol: "AAPL",
        assetType: "EQUITY",
        tradeAction: "Sell",
        direction: "long",
        quantity: 10,
        orderType: "Market",
        limitPrice: null,
      },
    ]);

    const result = await caller(db).closeAll({
      cancelOrders: true,
      idempotencyKey: "close-all-intent",
    });

    expect(result).toMatchObject({ success: true });
    // Exactly one social row: the position Alpaca actually closed.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      symbol: "AAPL",
      side: "sell",
      qty: 10,
      brokerOrderId: "order-aapl",
    });
    // The refused MSFT close must never be published as a completed trade;
    // publishing it would stage a real mirrored SELL on every follower for a
    // position the source never actually closed.
    expect(inserted.some((row) => row.symbol === "MSFT")).toBe(false);
  });

  it("does not publish Alpaca paper closeAll orders", async () => {
    getDecryptedCredentials.mockResolvedValue({
      username: "paper-key",
      accessToken: "paper-secret",
      accountType: "PAPER",
      accountId: "paper-account",
      credentialId: "11111111-1111-4111-8111-111111111111",
    });
    createAlpacaClientFromCredentials.mockReturnValue({
      closeAllPositions: vi.fn().mockResolvedValue([
        {
          symbol: "AAPL",
          status: 200,
          body: { id: "paper-close", symbol: "AAPL", side: "sell", qty: "1" },
        },
      ]),
    });
    const { db, inserted } = createDb();

    const result = await caller(db).closeAll({
      cancelOrders: true,
      idempotencyKey: "paper-close-all",
    });

    expect(result).toMatchObject({ success: true });
    expect(inserted).toHaveLength(0);
    expect(db.query.orders.findMany).not.toHaveBeenCalled();
  });

  it("marks an explicit close SYNCING when create-order recovery is ambiguous", async () => {
    const ambiguous = new AlpacaAmbiguousOrderError(
      "create_order",
      new Error("lookup unavailable"),
      "broker-close-id",
    );
    const client = {
      getPosition: vi.fn().mockResolvedValue(position),
      createOrder: vi.fn().mockRejectedValue(ambiguous),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted, updates } = createDb();

    const result = await caller(db).close({
      symbol: "AAPL",
      qty: 2,
      idempotencyKey: "partial-close-intent",
    });

    expect(inserted[0]).toMatchObject({ status: "PENDING", quantity: 2 });
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);
    expect(result).toMatchObject({
      success: false,
      syncing: true,
      status: "SYNCING",
      orderId: "local-close-1",
    });
  });

  it("returns syncing when exit-strategy order recovery is ambiguous", async () => {
    const ambiguous = new AlpacaAmbiguousOrderError(
      "create_order",
      new Error("lookup unavailable"),
      "broker-exit-id",
    );
    const client = {
      createExitStrategy: vi.fn().mockRejectedValue(ambiguous),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db } = createDb();

    const result = await caller(db).createExitStrategy({
      symbol: "AAPL",
      takeProfits: [{ price: 210, qty: 2 }],
      idempotencyKey: "exit-intent",
    });

    expect(result).toMatchObject({ success: false, syncing: true, status: "PENDING" });
  });

  it("records an OPTION close with the underlying symbol, SellToClose and the contract fields so copy-mirror discovery can see it (alpaca-04)", async () => {
    // Closing 2 contracts of a long AAPL 260821 C255 call from the Positions
    // panel. Alpaca's position `symbol` for an option is the OCC contract
    // (AAPL260821C00255000, no underlying/expiration/strike/type fields on
    // the position object), and this is a default full close so it goes
    // through client.closePosition(occSymbol), never client.createOrder.
    const optionPosition = {
      symbol: "AAPL260821C00255000",
      qty: "2",
      qty_available: "2",
      side: "long",
      asset_class: "us_option",
    };
    const client = {
      getPosition: vi.fn().mockResolvedValue(optionPosition),
      closePosition: vi.fn().mockResolvedValue({
        id: "broker-option-close",
        client_order_id: "broker-option-close-client",
      }),
      createOrder: vi.fn(),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db, inserted } = createDb();

    const result = await caller(db).close({
      symbol: "AAPL260821C00255000",
      idempotencyKey: "option-close-intent",
    });

    expect(client.closePosition).toHaveBeenCalledWith("AAPL260821C00255000");
    expect(result).toMatchObject({ success: true, orderId: "broker-option-close" });

    // The local `orders` row (what copy-mirror discovery joins social_trades
    // against) must carry the underlying symbol, a close-specific trade
    // action Alpaca actually supports (sell_to_close), and the full contract
    // identity, not the OCC string in `symbol` with `tradeAction: "Sell"`
    // and null option_* columns.
    const orderRow = inserted.find((row) => row.assetType === "OPTION");
    expect(orderRow).toMatchObject({
      symbol: "AAPL",
      tradeAction: "SellToClose",
      optionExpiration: "260821",
      optionType: "CALL",
    });
    expect(Number(orderRow?.optionStrike)).toBeCloseTo(255);

    // social_trades must carry the same underlying symbol (its own comment
    // in copy-mirror-candidate-sources.ts: "social_trades only stores the
    // underlying symbol").
    const socialRow = inserted.find((row) => row.orderType === "market" && row.side);
    expect(socialRow).toMatchObject({ symbol: "AAPL", assetType: "OPTION" });
  });

  it("preserves copy attribution for bounded broker mirror IDs within the tenant", async () => {
    const logicalId = "copymirror:user-a:source-trade-with-a-long-identifier";
    const brokerClientId = createBrokerClientOrderId("user-a", logicalId, "copy");
    const client = {
      getOrders: vi.fn().mockResolvedValue([{
        id: "broker-copy",
        symbol: "AAPL",
        side: "buy",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "100",
        filled_at: "2026-07-10T12:00:00.000Z",
        submitted_at: "2026-07-10T11:59:00.000Z",
        status: "filled",
        type: "market",
        asset_class: "us_equity",
        client_order_id: brokerClientId,
      }]),
    };
    createAlpacaClientFromCredentials.mockReturnValue(client);
    const { db } = createDb();
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          clientOrderId: logicalId,
          copySourceLabel: "Original Trader",
        }]),
      }),
    });

    const result = await caller(db).closedOrders({ limit: 10 });

    expect(result[0]?.copySourceLabel).toBe("Original Trader");
  });
});
