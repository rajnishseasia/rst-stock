import { describe, expect, it, vi } from "bun:test";
import {
  resolveExecutedAt,
  computeExitLegs,
  describeSyncError,
  OrderSyncPoller,
} from "../order-sync";
import { schema, type OrderExitPlan } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

describe("resolveExecutedAt", () => {
  it("parses a valid Alpaca filled_at timestamp into a Date", () => {
    const date = resolveExecutedAt("2026-06-15T13:01:23.000Z");
    expect(date).toBeInstanceOf(Date);
    expect(date?.getTime()).toBe(Date.parse("2026-06-15T13:01:23.000Z"));
  });

  it("returns null when no fill time is present (unfilled / partial pending)", () => {
    expect(resolveExecutedAt(null)).toBeNull();
    expect(resolveExecutedAt(undefined)).toBeNull();
    expect(resolveExecutedAt("")).toBeNull();
  });

  it("returns null for an unparseable timestamp instead of persisting an Invalid Date", () => {
    expect(resolveExecutedAt("not-a-date")).toBeNull();
  });
});

describe("computeExitLegs", () => {
  const plan = (overrides: Partial<OrderExitPlan> = {}): OrderExitPlan => ({
    exitSide: "sell",
    takeProfits: [{ price: 104, qtyFraction: 0.5 }],
    trailingStop: { trailPercent: 10 },
    ...overrides,
  });

  it("re-derives TP + trailing quantities against the filled qty (even split)", () => {
    expect(computeExitLegs(plan(), 10)).toEqual({
      takeProfits: [{ price: 104, qty: 5 }],
      trailingStop: { qty: 5, trailPercent: 10 },
    });
  });

  it("gives the rounding remainder to the trailing runner (odd split)", () => {
    expect(computeExitLegs(plan(), 11)).toEqual({
      takeProfits: [{ price: 104, qty: 5 }],
      trailingStop: { qty: 6, trailPercent: 10 },
    });
  });

  it("uses the actual filled qty, not the originally requested qty", () => {
    // Only 4 of a requested 10 filled → 2 TP / 2 trail.
    expect(computeExitLegs(plan(), 4)).toEqual({
      takeProfits: [{ price: 104, qty: 2 }],
      trailingStop: { qty: 2, trailPercent: 10 },
    });
  });

  it("supports a trailing-only plan (no fixed TP)", () => {
    expect(computeExitLegs(plan({ takeProfits: [] }), 7)).toEqual({
      takeProfits: [],
      trailingStop: { qty: 7, trailPercent: 10 },
    });
  });

  it("gives the remainder to the last TP when there is no trailing runner (covers full position)", () => {
    expect(
      computeExitLegs(plan({ trailingStop: undefined, takeProfits: [{ price: 104, qtyFraction: 0.5 }] }), 11)
    ).toEqual({
      takeProfits: [{ price: 104, qty: 11 }],
      trailingStop: undefined,
    });
  });

  it("returns null when the fill is too small to split", () => {
    // 1 share, 50% TP floors to 0, no trailing runner → nothing to place.
    expect(
      computeExitLegs(plan({ trailingStop: undefined, takeProfits: [{ price: 104, qtyFraction: 0.5 }] }), 1)
    ).toBeNull();
    expect(computeExitLegs(plan(), 0)).toBeNull();
  });

  it("rejects an unbounded broker quantity before protection-leg arithmetic", () => {
    expect(computeExitLegs(plan(), Number.MAX_VALUE)).toBeNull();
  });

  it("preserves the buy exit side for short covers", () => {
    const result = computeExitLegs(plan({ exitSide: "buy" }), 10);
    // exitSide isn't part of the legs payload, but the plan drives createExitStrategy.
    expect(result).not.toBeNull();
  });
});

describe("Smart Exit durability", () => {
  function smartExitOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      userId: "user-a",
      symbol: "AAPL",
      quantity: 10,
      clientOrderId: "entry-client-id",
      exitPlanStatus: "pending",
      exitPlan: {
        exitSide: "sell",
        takeProfits: [{ price: 104, qtyFraction: 0.5 }],
        trailingStop: { trailPercent: 10 },
      },
      ...overrides,
    };
  }

  function durableDb(order: Record<string, any>, options: {
    failCheckpointOnce?: boolean;
    parentCasRows?: ReadonlyArray<Record<string, unknown>>;
    authoritativeOrder?: Record<string, any> | null;
  } = {}) {
    const legs: Array<Record<string, any>> = [];
    const parentUpdates: Array<Record<string, unknown>> = [];
    const claimTokens: string[] = [];
    const checkpointPredicates: Array<{ sql: string; params: unknown[] }> = [];
    let failCheckpoint = options.failCheckpointOnce ?? false;
    const parentCasRows = options.parentCasRows ?? [{ id: order.id }];
    const authoritativeOrder = Object.prototype.hasOwnProperty.call(options, "authoritativeOrder")
      ? options.authoritativeOrder
      : order;
    const dialect = new PgDialect();

    const db = {
      query: {
        orders: {
          findFirst: vi.fn().mockResolvedValue(authoritativeOrder),
        },
        smartExitLegs: {
          findMany: vi.fn().mockImplementation(async () => legs.map((leg) => ({ ...leg }))),
          findFirst: vi.fn().mockImplementation(async () => legs[0]),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((value: Record<string, any>) => ({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(async () => {
              const existing = legs.find((leg) =>
                leg.entryOrderId === value.entryOrderId && leg.legKey === value.legKey
              );
              if (existing) return [];
              const row = {
                id: `leg-${legs.length + 1}`,
                status: "pending",
                attempts: 0,
                brokerOrderId: null,
                claimToken: null,
                claimExpiresAt: null,
                nextAttemptAt: null,
                error: null,
                ...value,
              };
              legs.push(row);
              return [{ ...row }];
            }),
          }),
        })),
      }),
      update: vi.fn().mockImplementation((table: unknown) => ({
        set: vi.fn().mockImplementation((value: Record<string, any>) => ({
          where: vi.fn().mockImplementation((predicate: any) => {
            let updated: Record<string, any> | undefined;
            if (table === schema.smartExitLegs) {
              const query = dialect.sqlToQuery(predicate);
              const row = legs.find((candidate) => query.params.includes(candidate.id));
              if (row && value.status === "submitting") {
                const leaseExpired = !row.claimExpiresAt || row.claimExpiresAt <= new Date();
                const retryDue = !row.nextAttemptAt || row.nextAttemptAt <= new Date();
                if (row.status === "pending" ||
                    (row.status === "retryable" && retryDue) ||
                    (row.status === "submitting" && leaseExpired)) {
                  Object.assign(row, value, { attempts: row.attempts + 1 });
                  claimTokens.push(value.claimToken);
                  updated = row;
                }
              } else if (row && ["attached", "retryable", "manual_intervention"].includes(value.status) &&
                  row.status === "submitting" && query.params.includes(row.claimToken)) {
                checkpointPredicates.push(query);
                if (failCheckpoint) {
                  failCheckpoint = false;
                  throw new Error("checkpoint unavailable");
                }
                Object.assign(row, value);
                updated = row;
              }
            } else {
              parentUpdates.push(value);
              Object.assign(order, value);
              return { returning: vi.fn().mockResolvedValue(parentCasRows) };
            }
            return { returning: vi.fn().mockResolvedValue(updated ? [{ ...updated }] : []) };
          }),
        })),
      })),
    };

    return { db, legs, parentUpdates, claimTokens, checkpointPredicates };
  }

  it("persists accepted legs and resumes only the unfinished leg after a restart", async () => {
    const order = smartExitOrder();
    const { db, legs, parentUpdates } = durableDb(order);
    const createOrder = vi.fn().mockResolvedValue({ id: "broker-tp" });
    const createTrailingStopOrder = vi.fn()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce({ id: "broker-trail" });
    const getOrderByClientId = vi.fn().mockRejectedValue({ status: 404 });
    const client = { createOrder, createTrailingStopOrder, getOrderByClientId };

    const firstPoller = new OrderSyncPoller(db as never);
    await (firstPoller as any).attachExitPlan(client, order, 10);

    expect(legs).toEqual([
      expect.objectContaining({ legKey: "tp0", status: "attached", brokerOrderId: "broker-tp", attempts: 1 }),
      expect.objectContaining({
        legKey: "trail",
        status: "retryable",
        brokerOrderId: null,
        attempts: 1,
        nextAttemptAt: expect.any(Date),
      }),
    ]);
    expect(createOrder.mock.calls[0][0].client_order_id).toBe(legs[0].clientOrderId);
    expect(createTrailingStopOrder.mock.calls[0][0].client_order_id).toBe(legs[1].clientOrderId);
    expect(parentUpdates.at(-1)).toMatchObject({
      exitPlanStatus: "pending",
      exitPlanError: "Trailing stop: broker unavailable",
    });

    legs[1].nextAttemptAt = new Date(0);
    const restartedPoller = new OrderSyncPoller(db as never);
    await (restartedPoller as any).attachExitPlan(client, order, 10);

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createTrailingStopOrder).toHaveBeenCalledTimes(2);
    expect(getOrderByClientId).toHaveBeenCalledTimes(3);
    expect(getOrderByClientId.mock.calls[2][0]).toBe(legs[1].clientOrderId);
    expect(legs).toEqual([
      expect.objectContaining({ legKey: "tp0", status: "attached", brokerOrderId: "broker-tp" }),
      expect.objectContaining({ legKey: "trail", status: "attached", brokerOrderId: "broker-trail", attempts: 2 }),
    ]);
    expect(parentUpdates.at(-1)).toMatchObject({ exitPlanStatus: "attached", exitPlanError: null });
  });

  it("logs a successful attachment only after an exact-one parent CAS", async () => {
    const order = smartExitOrder({
      exitPlan: {
        exitSide: "sell",
        takeProfits: [],
        trailingStop: { trailPercent: 10 },
      },
    });
    const { db } = durableDb(order, { parentCasRows: [{ id: order.id }] });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await (new OrderSyncPoller(db as never) as any).attachExitPlan(
        {
          getOrderByClientId: vi.fn().mockRejectedValue({ status: 404 }),
          createTrailingStopOrder: vi.fn().mockResolvedValue({ id: "broker-trail" }),
        },
        order,
        10,
      );

      expect(consoleLog.mock.calls.some(([message]) =>
        String(message).includes("Attached exit plan"),
      )).toBe(true);
    } finally {
      consoleLog.mockRestore();
    }
  });

  for (const [label, parentCasRows, authoritativeExitPlanStatus] of [
    ["zero", [], "failed"],
    ["multiple", [{ id: "winner-a" }, { id: "winner-b" }], "attached"],
  ] as const) {
    it(`rereads the authoritative parent after a ${label}-row attachment CAS without a false success log`, async () => {
      const order = smartExitOrder({
        exitPlan: {
          exitSide: "sell",
          takeProfits: [],
          trailingStop: { trailPercent: 10 },
        },
      });
      const authoritativeOrder = {
        ...order,
        exitPlanStatus: authoritativeExitPlanStatus,
      };
      const { db } = durableDb(order, {
        parentCasRows,
        authoritativeOrder,
      });
      const findFirst = db.query.orders.findFirst;
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await (new OrderSyncPoller(db as never) as any).attachExitPlan(
          {
            getOrderByClientId: vi.fn().mockRejectedValue({ status: 404 }),
            createTrailingStopOrder: vi.fn().mockResolvedValue({ id: "broker-trail" }),
          },
          order,
          10,
        );

        expect(findFirst).toHaveBeenCalledTimes(1);
        expect(consoleLog.mock.calls.some(([message]) =>
          String(message).includes("Attached exit plan"),
        )).toBe(false);
      } finally {
        consoleLog.mockRestore();
      }
    });
  }

  it("reconciles broker success after a checkpoint failure before issuing another POST", async () => {
    const order = smartExitOrder({
      exitPlan: {
        exitSide: "sell",
        takeProfits: [],
        trailingStop: { trailPercent: 10 },
      },
    });
    const { db, legs, claimTokens, checkpointPredicates } = durableDb(order, {
      failCheckpointOnce: true,
    });
    const createTrailingStopOrder = vi.fn().mockResolvedValue({ id: "broker-trail" });
    const getOrderByClientId = vi.fn()
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ id: "broker-trail" });
    const client = { createTrailingStopOrder, getOrderByClientId };

    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);
    expect(legs[0]).toMatchObject({ status: "submitting", attempts: 1, brokerOrderId: null });
    expect(legs[0].claimToken).toBe(claimTokens[0]);
    expect(legs[0].claimExpiresAt.getTime()).toBeGreaterThan(Date.now());

    legs[0].claimExpiresAt = new Date(0);
    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);

    expect(getOrderByClientId).toHaveBeenCalledTimes(2);
    expect(createTrailingStopOrder).toHaveBeenCalledTimes(1);
    expect(legs[0]).toMatchObject({
      status: "attached",
      attempts: 2,
      brokerOrderId: "broker-trail",
    });
    expect(claimTokens).toHaveLength(2);
    expect(claimTokens[1]).not.toBe(claimTokens[0]);
    expect(checkpointPredicates.at(-1)?.sql).toContain('"claim_token" =');
    expect(checkpointPredicates.at(-1)?.params).toContain(claimTokens[1]);
  });

  it("allows only one concurrent claimant to POST a pending leg", async () => {
    const order = smartExitOrder({
      exitPlan: {
        exitSide: "sell",
        takeProfits: [],
        trailingStop: { trailPercent: 10 },
      },
    });
    const { db, legs, claimTokens, checkpointPredicates } = durableDb(order);
    let releaseLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let notifyLookupStarted!: () => void;
    const didStartLookup = new Promise<void>((resolve) => { notifyLookupStarted = resolve; });
    const getOrderByClientId = vi.fn().mockImplementation(async () => {
      notifyLookupStarted();
      await lookupStarted;
      throw { status: 404 };
    });
    const createTrailingStopOrder = vi.fn().mockResolvedValue({ id: "broker-trail" });
    const client = { createTrailingStopOrder, getOrderByClientId };

    const first = (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);
    await didStartLookup;
    const second = (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);
    await second;
    releaseLookup();
    await first;

    expect(getOrderByClientId).toHaveBeenCalledTimes(1);
    expect(createTrailingStopOrder).toHaveBeenCalledTimes(1);
    expect(legs[0]).toMatchObject({ status: "attached", attempts: 1 });
    expect(claimTokens).toHaveLength(1);
    expect(checkpointPredicates[0].sql).toContain('"claim_token" =');
    expect(checkpointPredicates[0].params).toContain(claimTokens[0]);
  });

  it("persists a non-protective recovered broker order for manual intervention", async () => {
    for (const status of [
      "rejected",
      "canceled",
      "cancelled",
      "expired",
      "replaced",
      "done_for_day",
      "pending_cancel",
      "pending_replace",
      "stopped",
      "suspended",
      "calculated",
    ]) {
      const order = smartExitOrder({
        exitPlan: {
          exitSide: "sell",
          takeProfits: [],
          trailingStop: { trailPercent: 10 },
        },
      });
      const { db, legs, parentUpdates } = durableDb(order);
      const getOrderByClientId = vi.fn().mockResolvedValue({
        id: `broker-${status}`,
        status,
      });
      const createTrailingStopOrder = vi.fn();

      await (new OrderSyncPoller(db as never) as any).attachExitPlan(
        { getOrderByClientId, createTrailingStopOrder },
        order,
        10,
      );

      expect(createTrailingStopOrder).not.toHaveBeenCalled();
      expect(legs[0]).toMatchObject({
        status: "manual_intervention",
        brokerOrderId: `broker-${status}`,
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: null,
      });
      expect(legs[0].error).toContain(status);
      expect(parentUpdates.at(-1)).toMatchObject({ exitPlanStatus: "failed" });
    }
  });

  it("accepts a recovered filled exit because its quantity already closed", async () => {
    const order = smartExitOrder({
      exitPlan: {
        exitSide: "sell",
        takeProfits: [],
        trailingStop: { trailPercent: 10 },
      },
    });
    const { db, legs, parentUpdates } = durableDb(order);
    const getOrderByClientId = vi.fn().mockResolvedValue({
      id: "broker-filled",
      status: "filled",
    });
    const createTrailingStopOrder = vi.fn();

    await (new OrderSyncPoller(db as never) as any).attachExitPlan(
      { getOrderByClientId, createTrailingStopOrder },
      order,
      10,
    );

    expect(createTrailingStopOrder).not.toHaveBeenCalled();
    expect(legs[0]).toMatchObject({
      status: "attached",
      brokerOrderId: "broker-filled",
    });
    expect(parentUpdates.at(-1)).toMatchObject({ exitPlanStatus: "attached" });
  });

  it("does not retry a definite permanent broker submission rejection", async () => {
    const order = smartExitOrder({
      exitPlan: {
        exitSide: "sell",
        takeProfits: [],
        trailingStop: { trailPercent: 10 },
      },
    });
    const { db, legs } = durableDb(order);
    const getOrderByClientId = vi.fn().mockRejectedValue({ status: 404 });
    const rejection = Object.assign(new Error("invalid trail percent"), {
      response: { status: 422 },
    });
    const createTrailingStopOrder = vi.fn().mockRejectedValue(rejection);
    const client = { getOrderByClientId, createTrailingStopOrder };

    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);
    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);

    expect(getOrderByClientId).toHaveBeenCalledTimes(1);
    expect(createTrailingStopOrder).toHaveBeenCalledTimes(1);
    expect(legs[0]).toMatchObject({
      status: "manual_intervention",
      attempts: 1,
      nextAttemptAt: null,
    });
    expect(legs[0].error).toContain("invalid trail percent");
  });

  it("backs off a transient broker failure and retries only after nextAttemptAt", async () => {
    const order = smartExitOrder({
      exitPlan: {
        exitSide: "sell",
        takeProfits: [],
        trailingStop: { trailPercent: 10 },
      },
    });
    const { db, legs } = durableDb(order);
    const getOrderByClientId = vi.fn().mockRejectedValue({ status: 404 });
    const createTrailingStopOrder = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("broker overloaded"), {
        response: { status: 503 },
      }))
      .mockResolvedValueOnce({ id: "broker-trail" });
    const client = { getOrderByClientId, createTrailingStopOrder };

    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);
    const firstNextAttemptAt = legs[0].nextAttemptAt;
    expect(legs[0]).toMatchObject({ status: "retryable", attempts: 1 });
    expect(firstNextAttemptAt).toBeInstanceOf(Date);
    expect(firstNextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);
    expect(createTrailingStopOrder).toHaveBeenCalledTimes(1);

    legs[0].nextAttemptAt = new Date(0);
    await (new OrderSyncPoller(db as never) as any).attachExitPlan(client, order, 10);

    expect(createTrailingStopOrder).toHaveBeenCalledTimes(2);
    expect(legs[0]).toMatchObject({
      status: "attached",
      attempts: 2,
      brokerOrderId: "broker-trail",
      nextAttemptAt: null,
    });
  });

  it("marks the parent failed with every final manual-intervention leg error", async () => {
    const order = smartExitOrder();
    const { db, legs, parentUpdates } = durableDb(order);
    const getOrderByClientId = vi.fn()
      .mockResolvedValueOnce({ id: "broker-canceled", status: "canceled" })
      .mockRejectedValueOnce({ status: 404 });
    const createTrailingStopOrder = vi.fn().mockRejectedValue(
      Object.assign(new Error("account is not authorized"), { response: { status: 403 } }),
    );

    await (new OrderSyncPoller(db as never) as any).attachExitPlan(
      { getOrderByClientId, createTrailingStopOrder },
      order,
      10,
    );

    expect(legs.map((leg) => leg.status)).toEqual([
      "manual_intervention",
      "manual_intervention",
    ]);
    expect(parentUpdates.at(-1)).toMatchObject({ exitPlanStatus: "failed" });
    expect(parentUpdates.at(-1)?.exitPlanError).toContain("canceled");
    expect(parentUpdates.at(-1)?.exitPlanError).toContain("not authorized");
  });
});

describe("the poller only ever asks Alpaca about Alpaca orders", () => {
  /** Capture the predicate `pollOnce` builds for the active-order scan. */
  async function capturePollPredicate() {
    let predicate: unknown;
    const db = {
      query: {
        orders: {
          findMany: vi.fn().mockImplementation(async (args: { where: unknown }) => {
            predicate = args.where;
            return [];
          }),
        },
      },
    };
    await (new OrderSyncPoller(db as never)).pollOnce();
    return new PgDialect().sqlToQuery(predicate as never);
  }

  it("excludes PERP rows from the active-order scan", async () => {
    // A perp's broker id is a Hyperliquid oid, which is numeric rather than a
    // UUID. Handing one to Alpaca's GET /v2/orders/{id} returns 422, the order
    // stays active, and the next tick asks again. In production a single such
    // order produced ~115 failures an hour, forever. Perps are reconciled by
    // HyperliquidOrderSyncPoller; this poller must never see them.
    const query = await capturePollPredicate();

    expect(query.sql).toContain("asset_type");
    expect(query.sql).toMatch(/<>|!=/);
    expect(query.params).toContain("PERP");
  });

  it("still scans every active equity/option status", async () => {
    // The exclusion must not narrow what the poller was already reconciling.
    const query = await capturePollPredicate();

    for (const status of ["PENDING", "SYNCING", "SUBMITTED", "PARTIAL", "FILLED"]) {
      expect(query.params).toContain(status);
    }
  });
});

describe("OrderSyncPoller broker execution parsing", () => {
  function activeOrder() {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      symbol: "AAPL",
      assetType: "EQUITY",
      orderType: "market",
      tradeAction: "Buy",
      direction: "long",
      quantity: 10,
      status: "SUBMITTED",
      clientOrderId: "client-1",
      brokerClientOrderId: null,
      brokerOrderId: "broker-1",
      brokerAccountId: "account-1",
      brokerCredentialId: "credential-1",
      executedQuantity: 0,
      executedPrice: null,
      executedAt: null,
      syncReason: null,
      syncAttempts: 0,
      exitPlanStatus: null,
      exitPlan: null,
    };
  }

  for (const [filled_qty, filled_avg_price] of [
    ["1junk", "100"],
    ["0x1", "100"],
    ["1", "100junk"],
    ["1", "0x64"],
    ["1", "10000000000000000"],
  ] as const) {
    it(`does not persist a broker snapshot with filled_qty=${filled_qty} and price=${filled_avg_price}`, async () => {
      const update = vi.fn();
      const order = activeOrder();
      const db = {
        query: {
          orders: {
            findMany: vi.fn().mockResolvedValue([order]),
          },
        },
        update: vi.fn().mockReturnValue({
          set: update,
        }),
      };
      update.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });
      const client = {
        getOrder: vi.fn().mockResolvedValue({
          id: "broker-1",
          status: "filled",
          filled_qty,
          filled_avg_price,
          filled_at: "2026-08-20T12:00:00.000Z",
        }),
      };

      const poller = new OrderSyncPoller(db as never, {
        getCredentials: vi.fn().mockResolvedValue({
          username: "key",
          accessToken: "secret",
          accountType: "paper",
        }),
        createClient: () => client as never,
        notify: vi.fn(),
      });

      await poller.pollOnce();

      expect(db.update).not.toHaveBeenCalled();
      expect(client.getOrder).toHaveBeenCalledWith("broker-1");
    });
  }
});

describe("OrderSyncPoller concurrency", () => {
  it("only notifies for an exact-one execution CAS and rereads a lost race", async () => {
    const baseOrder = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      symbol: "AAPL",
      assetType: "EQUITY",
      orderType: "market",
      tradeAction: "Buy",
      direction: "long",
      quantity: 10,
      status: "SUBMITTED",
      clientOrderId: "client-1",
      brokerClientOrderId: null,
      brokerOrderId: "broker-1",
      brokerAccountId: "account-1",
      brokerCredentialId: "credential-1",
      executedQuantity: 0,
      executedPrice: null,
      executedAt: null,
      syncReason: null,
      syncAttempts: 0,
      exitPlanStatus: null,
      exitPlan: null,
    };

    for (const [label, returnedRows] of [
      ["zero", []],
      ["one", [{ id: "winner" }]],
      ["multiple", [{ id: "winner-a" }, { id: "winner-b" }]],
    ] as const) {
      const authoritative = { ...baseOrder, status: "FILLED", executedQuantity: 10 };
      const findFirst = vi.fn().mockResolvedValue(authoritative);
      const notify = vi.fn().mockResolvedValue(undefined);
      const db = {
        query: {
          orders: {
            findMany: vi.fn().mockResolvedValue([baseOrder]),
            findFirst,
          },
        },
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue(returnedRows),
            }),
          }),
        }),
      };
      const poller = new OrderSyncPoller(db as never, {
        getCredentials: vi.fn().mockResolvedValue({
          username: "key",
          accessToken: "secret",
          accountType: "LIVE",
        }),
        createClient: () => ({
          getOrder: vi.fn().mockResolvedValue({
            id: "broker-1",
            status: "filled",
            filled_qty: "10",
            filled_avg_price: "101",
            filled_at: "2026-08-20T12:00:00.000Z",
          }),
        }) as never,
        notify,
      });

      await poller.pollOnce();

      if (label === "one") {
        expect(notify).toHaveBeenCalledTimes(1);
        // Alpaca's filled_at reaches the notifier, so a fill reconciled long
        // after the fact can be recognised as stale rather than announced.
        expect(notify).toHaveBeenCalledWith(
          expect.objectContaining({
            executedAt: new Date("2026-08-20T12:00:00.000Z"),
          }),
        );
      }
      else {
        expect(notify).not.toHaveBeenCalled();
        expect(findFirst).toHaveBeenCalled();
      }
    }
  });

  it("coalesces overlapping pollOnce calls into one in-flight reconciliation", async () => {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let scanStarted!: () => void;
    const didStartScan = new Promise<void>((resolve) => { scanStarted = resolve; });
    const findMany = vi.fn().mockImplementation(async () => {
      scanStarted();
      await scanGate;
      return [];
    });
    const poller = new OrderSyncPoller({ query: { orders: { findMany } } } as never);

    const first = poller.pollOnce();
    await didStartScan;
    const second = poller.pollOnce();
    expect(findMany).toHaveBeenCalledTimes(1);
    releaseScan();
    await Promise.all([first, second]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps execution snapshots monotonic when a stale poll finishes last", async () => {
    const module = await import("../order-sync") as Record<string, unknown>;
    const merge = module.mergeOrderExecutionSnapshot as ((
      current: Record<string, unknown>,
      incoming: Record<string, unknown>,
    ) => Record<string, unknown>) | undefined;
    expect(typeof merge).toBe("function");
    if (!merge) return;

    const current = {
      status: "FILLED",
      executedQuantity: 10,
      executedPrice: 101,
      executedAt: new Date("2026-08-20T12:00:00.000Z"),
    };
    expect(merge(current, {
      status: "PARTIAL",
      executedQuantity: 5,
      executedPrice: 99,
      executedAt: new Date("2026-08-20T11:00:00.000Z"),
    })).toEqual(current);

    expect(merge({
      status: "PARTIAL",
      executedQuantity: 4,
      executedPrice: 100,
      executedAt: null,
    }, {
      status: "CANCELLED",
      executedQuantity: 4,
      executedPrice: 100,
      executedAt: new Date("2026-08-20T12:30:00.000Z"),
    })).toEqual({
      status: "CANCELLED",
      executedQuantity: 4,
      executedPrice: 100,
      executedAt: new Date("2026-08-20T12:30:00.000Z"),
    });

    expect(merge({
      status: "FILLED",
      executedQuantity: 10,
      executedPrice: 101,
      executedAt: null,
    }, {
      status: "PARTIAL",
      executedQuantity: 10,
      executedPrice: 98,
      executedAt: null,
    })).toEqual({
      status: "FILLED",
      executedQuantity: 10,
      executedPrice: 101,
      executedAt: null,
    });
  });

  it("compiles an atomic update that compares against the persisted row", async () => {
    const module = await import("../order-sync") as Record<string, unknown>;
    const buildUpdate = module.buildMonotonicOrderExecutionUpdate as ((
      incoming: Record<string, unknown>,
    ) => Record<string, unknown>) | undefined;
    expect(typeof buildUpdate).toBe("function");
    if (!buildUpdate) return;

    const queryDb = drizzle(
      { query: () => Promise.resolve({ rows: [], fields: [] }) } as never,
      { schema },
    );
    const compiled = queryDb
      .update(schema.orders)
      .set(buildUpdate({
        status: "PARTIAL",
        executedQuantity: 5,
        executedPrice: 101,
        executedAt: new Date("2026-08-20T12:00:00.000Z"),
        brokerOrderId: "broker-1",
        statusUpdatedAt: new Date("2026-08-20T12:00:01.000Z"),
      }) as never)
      .where(eq(schema.orders.id, "11111111-1111-4111-8111-111111111111"))
      .toSQL();

    expect(compiled.sql).toContain("greatest");
    expect(compiled.sql).toContain("case");
    expect(compiled.sql).toContain("executed_quantity");
    expect(compiled.sql).toContain("executed_at");
    expect(compiled.params).toContain(5);
    expect(compiled.params).toContain("PARTIAL");
  });

  it("types every null parameter so an unfilled order still compiles on the server", async () => {
    // Production regression: an order with no broker fill binds executedAt as a
    // null parameter, and its only use was `$n is not null`. Postgres cannot
    // infer a type there and rejected the whole UPDATE with "could not
    // determine data type of parameter $n". Since this UPDATE is the only thing
    // that advances the order, the row kept an active status and rebuilt the
    // same failing statement on every 30s poll: the same seven orders never
    // synced again.
    const module = await import("../order-sync") as Record<string, unknown>;
    const buildUpdate = module.buildMonotonicOrderExecutionUpdate as ((
      incoming: Record<string, unknown>,
    ) => Record<string, unknown>);

    const queryDb = drizzle(
      { query: () => Promise.resolve({ rows: [], fields: [] }) } as never,
      { schema },
    );
    const compiled = queryDb
      .update(schema.orders)
      .set(buildUpdate({
        status: "SUBMITTED",
        executedQuantity: 0,
        executedPrice: null,
        executedAt: null,
        brokerOrderId: "broker-1",
        statusUpdatedAt: new Date("2026-08-20T12:00:01.000Z"),
      }) as never)
      .where(eq(schema.orders.id, "11111111-1111-4111-8111-111111111111"))
      .toSQL();

    // A null parameter is only safe where Postgres can type it: as the value of
    // a column assignment, or with an explicit cast. Anywhere else the server
    // rejects the statement before it runs.
    const untypedNullParams = compiled.params
      .map((value, index) => ({ value, placeholder: `$${index + 1}` }))
      .filter(({ value }) => value === null)
      .filter(({ placeholder }) =>
        !compiled.sql.includes(`${placeholder}::`) &&
        !compiled.sql.includes(`= ${placeholder},`) &&
        !compiled.sql.endsWith(`= ${placeholder}`)
      )
      .map(({ placeholder }) => placeholder);

    expect(untypedNullParams).toEqual([]);
  });
});

describe("describeSyncError", () => {
  it("lifts the HTTP status out of an axios rejection instead of dumping the object", () => {
    // The raw error serializes its config, request and response: ~150 log lines
    // per failure, which buried an hour of worker logs under ~17,000 lines.
    const axiosLike = Object.assign(new Error("Request failed with status code 422"), {
      isAxiosError: true,
      config: { url: "https://api.alpaca.markets/v2/orders/505085728820" },
      response: { status: 422, statusText: "Unprocessable Entity", data: {} },
    });

    expect(describeSyncError(axiosLike)).toEqual({
      status: 422,
      errorName: "Error",
      errorMessage: "Request failed with status code 422",
    });
  });

  it("describes a non-HTTP throw rather than losing it", () => {
    expect(describeSyncError(new TypeError("boom"))).toEqual({
      errorName: "TypeError",
      errorMessage: "boom",
    });
    expect(describeSyncError("plain string")).toEqual({
      errorName: "string",
      errorMessage: "plain string",
    });
  });

  it("masks credentials a driver quoted back at us", () => {
    const described = describeSyncError(
      new Error("connect failed: postgresql://postgres:hunter2@db.example.com:5432/tradebot"),
    );
    expect(described.errorMessage).not.toContain("hunter2");
    expect(described.errorMessage).toContain("[REDACTED]@db.example.com");
  });

  it("bounds a pathological message", () => {
    expect(describeSyncError(new Error("x".repeat(5_000))).errorMessage.length).toBe(200);
  });
});
