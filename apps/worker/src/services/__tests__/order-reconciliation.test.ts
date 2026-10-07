import { describe, expect, it, vi } from "bun:test";
import { OrderSyncPoller } from "../order-sync";
import { PgDialect } from "drizzle-orm/pg-core";

function pendingOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-order-1",
    userId: "user-a",
    brokerCredentialId: "11111111-1111-4111-8111-111111111111",
    brokerAccountId: "paper-account",
    brokerOrderId: null as string | null,
    clientOrderId: "tenant-client-order-1",
    brokerClientOrderId: "broker-client-order-1",
    status: "PENDING",
    symbol: "AAPL",
    tradeAction: "Buy",
    quantity: 2,
    executedQuantity: null,
    exitPlanStatus: null,
    exitPlan: null,
    assetType: "EQUITY",
    orderType: "Market",
    limitPrice: null,
    syncAttempts: 0,
    syncReason: null,
    ...overrides,
  };
}

describe("broker/local order reconciliation", () => {
  it("recovers a pending order by tenant credential and broker client ID", async () => {
    const order = pendingOrder();
    const updates: Array<Record<string, unknown>> = [];
    const findMany = vi.fn().mockResolvedValue([order]);
    const updateReturning = vi.fn().mockResolvedValue([{
      ...order,
      status: "SUBMITTED",
      brokerOrderId: "broker-order-1",
    }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const db = {
      query: { orders: { findMany } },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((value: Record<string, unknown>) => {
          updates.push(value);
          return { where: updateWhere };
        }),
      }),
    };
    const getCredentials = vi.fn().mockResolvedValue({
      credentialId: order.brokerCredentialId,
      accountId: order.brokerAccountId,
      accountType: "PAPER",
      username: "paper-key",
      accessToken: "paper-secret",
    });
    const getOrderByClientId = vi.fn().mockResolvedValue({
      id: "broker-order-1",
      client_order_id: order.clientOrderId,
      status: "accepted",
      filled_qty: "0",
      filled_avg_price: null,
      filled_at: null,
    });
    const createClient = vi.fn().mockReturnValue({ getOrderByClientId });
    const poller = new OrderSyncPoller(db as never, {
      getCredentials,
      createClient,
      notify: vi.fn(),
    });

    await poller.pollOnce();

    expect(getCredentials).toHaveBeenCalledWith(db, "user-a", {
      provider: "alpaca",
      credentialId: order.brokerCredentialId,
      accountId: order.brokerAccountId,
    });
    expect(getOrderByClientId).toHaveBeenCalledWith(order.brokerClientOrderId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(expect.objectContaining({
      syncReason: null,
      statusUpdatedAt: expect.any(Date),
    }));
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it("persists an ambiguous lookup and safely resumes it on the next poll", async () => {
    let currentOrder = pendingOrder();
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      query: { orders: { findMany: vi.fn().mockImplementation(async () => [currentOrder]) } },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((value: Record<string, unknown>) => {
          updates.push(value);
          return {
            where() {
              if (value.status !== "SYNCING") {
                return {
                  returning: vi.fn().mockImplementation(async () => {
                    currentOrder = {
                      ...currentOrder,
                      status: "SUBMITTED",
                      brokerOrderId: "broker-order-recovered",
                      syncReason: null,
                      syncAttempts: 2,
                    };
                    return [currentOrder];
                  }),
                };
              }
              currentOrder = { ...currentOrder, ...value };
              return undefined;
            },
          };
        }),
      }),
    };
    const getOrderByClientId = vi.fn()
      .mockRejectedValueOnce(new Error("broker lookup timed out"))
      .mockResolvedValueOnce({
        id: "broker-order-recovered",
        client_order_id: currentOrder.brokerClientOrderId,
        status: "accepted",
        filled_qty: "0",
        filled_avg_price: null,
        filled_at: null,
      });
    const poller = new OrderSyncPoller(db as never, {
      getCredentials: vi.fn().mockResolvedValue({
        credentialId: currentOrder.brokerCredentialId,
        accountId: currentOrder.brokerAccountId,
        accountType: "PAPER",
        username: "paper-key",
        accessToken: "paper-secret",
      }),
      createClient: vi.fn().mockReturnValue({ getOrderByClientId }),
      notify: vi.fn(),
    });

    await poller.pollOnce();
    expect(updates.at(-1)).toMatchObject({
      status: "SYNCING",
      syncReason: "broker lookup timed out",
      syncAttempts: 1,
    });
    expect(updates.some((update) => update.status === "REJECTED")).toBe(false);

    await poller.pollOnce();
    expect(currentOrder).toMatchObject({
      status: "SUBMITTED",
      brokerOrderId: "broker-order-recovered",
      syncReason: null,
      syncAttempts: 2,
    });
    expect(getOrderByClientId).toHaveBeenCalledTimes(2);
  });

  it("attaches a FILLED pending plan discovered on a later poll", async () => {
    const order = pendingOrder({
      status: "FILLED",
      brokerOrderId: "broker-order-1",
      executedQuantity: 2,
      exitPlanStatus: "pending",
      exitPlan: {
        exitSide: "sell",
        takeProfits: [{ price: 210, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 5 },
      },
    });
    const db = {
      query: {
        orders: {
          findMany: vi.fn().mockResolvedValue([order]),
          findFirst: vi.fn().mockResolvedValue(order),
        },
      },
    };
    const getOrder = vi.fn().mockResolvedValue({
      id: order.brokerOrderId,
      status: "filled",
      filled_qty: "2",
      filled_avg_price: "200",
      filled_at: "2026-07-11T12:00:00Z",
    });
    const poller = new OrderSyncPoller(db as never, {
      getCredentials: vi.fn().mockResolvedValue({
        accountType: "PAPER",
        username: "paper-key",
        accessToken: "paper-secret",
      }),
      createClient: vi.fn().mockReturnValue({ getOrder }),
      notify: vi.fn(),
    });
    const attachExitPlan = vi.fn();
    (poller as any).attachExitPlan = attachExitPlan;

    await poller.pollOnce();

    expect(attachExitPlan).toHaveBeenCalledWith(expect.anything(), order, 2);
    const selection = new PgDialect().sqlToQuery(
      db.query.orders.findMany.mock.calls[0][0].where,
    );
    expect(selection.sql).toContain('"orders"."status" =');
    expect(selection.sql).toContain('"orders"."exit_plan_status" =');
    expect(selection.params).toContain("FILLED");
    expect(selection.params).toContain("pending");
  });

  it("still attaches the exit plan when Discord notification fails", async () => {
    const order = pendingOrder({
      status: "SUBMITTED",
      brokerOrderId: "broker-order-1",
      exitPlanStatus: "pending",
      exitPlan: {
        exitSide: "sell",
        takeProfits: [{ price: 210, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 5 },
      },
    });
    const db = {
      query: { orders: { findMany: vi.fn().mockResolvedValue([order]) } },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              ...order,
              status: "FILLED",
              executedQuantity: 2,
              executedPrice: "200",
            }]),
          }),
        }),
      }),
    };
    const getOrder = vi.fn().mockResolvedValue({
      id: order.brokerOrderId,
      status: "filled",
      filled_qty: "2",
      filled_avg_price: "200",
      filled_at: "2026-07-11T12:00:00Z",
    });
    const poller = new OrderSyncPoller(db as never, {
      getCredentials: vi.fn().mockResolvedValue({
        accountType: "LIVE",
        username: "live-key",
        accessToken: "live-secret",
      }),
      createClient: vi.fn().mockReturnValue({ getOrder }),
      notify: vi.fn().mockRejectedValue(new Error("Discord unavailable")),
    });
    const attachExitPlan = vi.fn();
    (poller as any).attachExitPlan = attachExitPlan;

    await poller.pollOnce();

    expect(attachExitPlan).toHaveBeenCalledTimes(1);
  });

  it("does not regress a persisted FILLED winner when exit-plan side effects fail", async () => {
    const scannedOrder = pendingOrder({
      status: "PENDING",
      brokerOrderId: "broker-order-1",
      exitPlanStatus: "pending",
      exitPlan: {
        exitSide: "sell",
        takeProfits: [{ price: 210, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 5 },
      },
    });
    const winningOrder = {
      ...scannedOrder,
      status: "FILLED",
      executedQuantity: 10,
      executedPrice: "205",
    };
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      query: { orders: { findMany: vi.fn().mockResolvedValue([scannedOrder]) } },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((value: Record<string, unknown>) => {
          updates.push(value);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([winningOrder]),
            }),
          };
        }),
      }),
    };
    const poller = new OrderSyncPoller(db as never, {
      getCredentials: vi.fn().mockResolvedValue({
        accountType: "PAPER",
        username: "paper-key",
        accessToken: "paper-secret",
      }),
      createClient: vi.fn().mockReturnValue({
        getOrder: vi.fn().mockResolvedValue({
          id: scannedOrder.brokerOrderId,
          status: "filled",
          filled_qty: "10",
          filled_avg_price: "205",
          filled_at: "2026-07-11T12:00:00Z",
        }),
      }),
      notify: vi.fn(),
    });
    (poller as any).attachExitPlan = vi.fn().mockRejectedValue(new Error("exit-plan unavailable"));

    await poller.pollOnce();

    expect(updates.some((update) => update.status === "SYNCING")).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      syncReason: "exit-plan unavailable",
      syncAttempts: 1,
    });
  });

  it("uses the persisted FILLED winner after a stale PARTIAL response loses the update race", async () => {
    const scannedOrder = pendingOrder({
      status: "SUBMITTED",
      brokerOrderId: "broker-order-1",
      executedQuantity: 2,
      exitPlanStatus: "pending",
      exitPlan: {
        exitSide: "sell",
        takeProfits: [{ price: 210, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 5 },
      },
    });
    const winningOrder = {
      ...scannedOrder,
      status: "FILLED",
      executedQuantity: 10,
      executedPrice: "205",
    };
    const findFirst = vi.fn().mockResolvedValue(winningOrder);
    const updateReturning = vi.fn().mockResolvedValue([]);
    const db = {
      query: {
        orders: {
          findMany: vi.fn().mockResolvedValue([scannedOrder]),
          findFirst,
        },
      },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: updateReturning }),
        }),
      }),
    };
    const notify = vi.fn();
    const poller = new OrderSyncPoller(db as never, {
      getCredentials: vi.fn().mockResolvedValue({
        accountType: "LIVE",
        credentialId: scannedOrder.brokerCredentialId,
        accountId: scannedOrder.brokerAccountId,
        username: "live-key",
        accessToken: "live-secret",
      }),
      createClient: vi.fn().mockReturnValue({
        getOrder: vi.fn().mockResolvedValue({
          id: scannedOrder.brokerOrderId,
          status: "partially_filled",
          filled_qty: "5",
          filled_avg_price: "200",
          filled_at: "2026-07-11T12:00:00Z",
        }),
      }),
      notify,
    });
    const attachExitPlan = vi.fn();
    (poller as any).attachExitPlan = attachExitPlan;

    await poller.pollOnce();

    expect(updateReturning).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(attachExitPlan).toHaveBeenCalledWith(expect.anything(), winningOrder, 10);
  });

  it("does not automatically retry legacy parent-level failed plans", async () => {
    const order = pendingOrder({
      status: "FILLED",
      brokerOrderId: "broker-order-1",
      executedQuantity: 2,
      exitPlanStatus: "failed",
      exitPlan: {
        exitSide: "sell",
        takeProfits: [{ price: 210, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 5 },
      },
    });
    const poller = new OrderSyncPoller({
      query: { orders: { findMany: vi.fn().mockResolvedValue([order]) } },
    } as never, {
      getCredentials: vi.fn().mockResolvedValue({
        accountType: "PAPER",
        username: "paper-key",
        accessToken: "paper-secret",
      }),
      createClient: vi.fn().mockReturnValue({
        getOrder: vi.fn().mockResolvedValue({
          id: order.brokerOrderId,
          status: "filled",
          filled_qty: "2",
          filled_avg_price: "200",
          filled_at: "2026-07-11T12:00:00Z",
        }),
      }),
      notify: vi.fn(),
    });
    const attachExitPlan = vi.fn();
    (poller as any).attachExitPlan = attachExitPlan;

    await poller.pollOnce();

    expect(attachExitPlan).not.toHaveBeenCalled();
  });
});
