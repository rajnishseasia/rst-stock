import { describe, expect, it, vi } from "bun:test";
import { schema } from "@trade-bot/db";

import {
  ABANDONED_PERP_ORDER_REASON,
  ACTIVE_PERP_ORDER_STATUSES,
  HyperliquidOrderSyncPoller,
  isRetirablePerpOrder,
  readOpenOrdersWithCoverage,
} from "../hyperliquid-order-sync";

/**
 * Stand in for Drizzle's `where()`, which is awaitable AND exposes
 * `returning()`: the legacy sweep awaits it directly, the retirement sweep
 * calls `returning()`.
 *
 * Written as a real promise with `returning` hung off it rather than an object
 * literal carrying `then`/`catch`. A hand-rolled thenable behaves the same here
 * but is what `unicorn/no-thenable` forbids, because anything that grows a
 * `then` becomes silently awaitable everywhere it is passed.
 */
function whereResult<T>(result: Promise<T[]>) {
  return Object.assign(result, { returning: () => result });
}

it("keeps ambiguous SYNCING perp orders in the active reconciliation scan", () => {
  expect(ACTIVE_PERP_ORDER_STATUSES).toContain("SYNCING");
});

it("uses frontend open orders so live position triggers are reconciled", async () => {
  const rawReads = vi.fn().mockResolvedValue({
    orders: [], coveredDexes: [""], complete: true, failures: [],
  });
  const frontendReads = vi.fn().mockResolvedValue({
    orders: [{
      coin: "ETHFI",
      oid: 539566903229,
      cloid: "0x00000000000000000000000000000001",
      sz: "785.3",
      origSz: "785.3",
    }],
    coveredDexes: [""],
    complete: true,
    failures: [],
  });

  const result = await readOpenOrdersWithCoverage({
    openOrders: async () => [],
    openOrdersWithStatus: rawReads,
    listOpenOrdersWithStatus: frontendReads,
  }, "0x0000000000000000000000000000000000000001", [""]);

  expect(frontendReads).toHaveBeenCalledTimes(1);
  expect(rawReads).not.toHaveBeenCalled();
  expect(result.orders[0]?.oid).toBe(539566903229);
});

function perpOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    symbol: "BTC",
    assetType: "PERP",
    orderType: "StopMarket",
    tradeAction: "Sell",
    direction: "short",
    quantity: 0,
    quantityDecimal: "0.125",
    executedSizeDecimal: null,
    reduceOnly: true,
    venue: "hyperliquid",
    status: "SUBMITTED",
    clientOrderId: "close-btc-1",
    brokerOrderId: null,
    brokerAccountId: "0xMaster",
    executedPrice: null,
    realizedPnl: null,
    executedAt: null,
    createdAt: new Date("2026-07-31T12:00:00.000Z"),
    ...overrides,
  } as typeof schema.orders.$inferSelect;
}

function fillFor(order: ReturnType<typeof perpOrder>, size = "0.125") {
  return {
    coin: order.symbol,
    px: "117500.25",
    sz: size,
    side: "A" as const,
    oid: 98765,
    cloid: undefined,
    closedPnl: "42.50",
    time: Date.parse("2026-07-31T12:05:00.000Z"),
  };
}

function syncDb(
  order: ReturnType<typeof perpOrder>,
  options: {
    transitionRows?: Array<Record<string, unknown>>;
    authoritativeOrder?: ReturnType<typeof perpOrder> | null;
    execute?: (query: unknown) => Promise<unknown>;
  } = {},
) {
  const socialRows: Array<Record<string, unknown>> = [];
  const insertedOrders: Array<Record<string, unknown>> = [];
  const orderUpdates: Array<Record<string, unknown>> = [];
  const updateWheres: unknown[] = [];
  let transitionClaimed = false;

  const tx = {
    query: {
      orders: {
        findFirst: vi.fn().mockResolvedValue(options.authoritativeOrder ?? null),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        orderUpdates.push(values);
        return {
          // The WHERE is captured: it carries the compare-and-set, and a mock
          // that discards it cannot tell a guarded update from an unguarded one.
          where: vi.fn().mockImplementation((clause: unknown) => {
            updateWheres.push(clause);
            return {
              returning: vi.fn().mockImplementation(async () => {
                if (transitionClaimed) return [];
                transitionClaimed = true;
                return options.transitionRows ?? [{ ...order, ...values }];
              }),
            };
          }),
        };
      }),
    }),
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation(async (values: Record<string, unknown>) => {
        if (table === schema.socialTrades) socialRows.push(values);
        if (table === schema.orders) insertedOrders.push(values);
      }),
    })),
  };
  // Writes made OUTSIDE the transaction, which is where the placement backfill
  // lives: it has to run for a resting order that produces no state transition
  // at all, so it cannot sit inside the transition's compare-and-set.
  const directUpdates: Array<Record<string, unknown>> = [];
  const db = {
    query: tx.query,
    transaction: vi.fn().mockImplementation(async (fn: (transaction: typeof tx) => unknown) => fn(tx)),
    ...(options.execute ? { execute: options.execute } : {}),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        directUpdates.push(values);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: order.id }]),
          }),
        };
      }),
    }),
  };

  return { db, tx, socialRows, insertedOrders, orderUpdates, updateWheres, directUpdates };
}

describe("Hyperliquid completed fills", () => {
  it("publishes each incremental partial reduce-only fill once", async () => {
    const submitted = perpOrder({
      brokerOrderId: "98765",
      initialTakeProfitPx: "125000",
      initialStopLossPx: "110000",
    });
    const firstPartial = syncDb(submitted);
    await (new HyperliquidOrderSyncPoller(firstPartial.db as never) as any).reconcileOne(
      submitted,
      [fillFor(submitted, "0.04")],
      [{ coin: "BTC", oid: 98765, sz: "0.085", origSz: "0.125" }],
    );

    const recordedFirstPartial = perpOrder({
      brokerOrderId: "98765",
      status: "PARTIAL",
      executedSizeDecimal: "0.04",
    });
    const replay = syncDb(recordedFirstPartial);
    await (new HyperliquidOrderSyncPoller(replay.db as never) as any).reconcileOne(
      recordedFirstPartial,
      [fillFor(recordedFirstPartial, "0.04")],
      [{ coin: "BTC", oid: 98765, sz: "0.085", origSz: "0.125" }],
    );

    const secondPartial = syncDb(recordedFirstPartial);
    await (new HyperliquidOrderSyncPoller(secondPartial.db as never) as any).reconcileOne(
      recordedFirstPartial,
      [
        fillFor(recordedFirstPartial, "0.04"),
        { ...fillFor(recordedFirstPartial, "0.035"), time: Date.parse("2026-07-31T12:06:00.000Z") },
      ],
      [{ coin: "BTC", oid: 98765, sz: "0.05", origSz: "0.125" }],
    );

    const recordedSecondPartial = perpOrder({
      brokerOrderId: "98765",
      status: "PARTIAL",
      executedSizeDecimal: "0.075",
    });
    const secondReplay = syncDb(recordedSecondPartial);
    await (new HyperliquidOrderSyncPoller(secondReplay.db as never) as any).reconcileOne(
      recordedSecondPartial,
      [
        fillFor(recordedSecondPartial, "0.04"),
        { ...fillFor(recordedSecondPartial, "0.035"), time: Date.parse("2026-07-31T12:06:00.000Z") },
      ],
      [{ coin: "BTC", oid: 98765, sz: "0.05", origSz: "0.125" }],
    );

    const completed = syncDb(recordedSecondPartial);
    await (new HyperliquidOrderSyncPoller(completed.db as never) as any).reconcileOne(
      recordedSecondPartial,
      [
        fillFor(recordedSecondPartial, "0.04"),
        { ...fillFor(recordedSecondPartial, "0.035"), time: Date.parse("2026-07-31T12:06:00.000Z") },
        { ...fillFor(recordedSecondPartial, "0.05"), time: Date.parse("2026-07-31T12:07:00.000Z") },
      ],
      [],
    );

    expect(firstPartial.socialRows).toHaveLength(1);
    expect(firstPartial.insertedOrders).toEqual([
      expect.objectContaining({
        status: "FILLED",
        quantityDecimal: "0.04",
        executedSizeDecimal: "0.04",
        syncReason: "hyperliquid-fill-delta-event",
        clientOrderId: "hyperliquid-fill-delta:11111111-1111-4111-8111-111111111111:4000000",
        brokerOrderId: "hyperliquid-fill-delta:11111111-1111-4111-8111-111111111111:4000000",
        initialTakeProfitPx: "125000",
        initialStopLossPx: "110000",
      }),
    ]);
    expect(firstPartial.socialRows[0]?.brokerOrderId)
      .toBe(firstPartial.insertedOrders[0]?.brokerOrderId);
    expect(replay.socialRows).toHaveLength(0);
    expect(replay.insertedOrders).toHaveLength(0);
    expect(secondPartial.socialRows).toHaveLength(1);
    expect(secondPartial.insertedOrders).toEqual([
      expect.objectContaining({
        status: "FILLED",
        quantityDecimal: "0.035",
        executedSizeDecimal: "0.035",
        clientOrderId: "hyperliquid-fill-delta:11111111-1111-4111-8111-111111111111:7500000",
        brokerOrderId: "hyperliquid-fill-delta:11111111-1111-4111-8111-111111111111:7500000",
      }),
    ]);
    expect(secondPartial.socialRows[0]?.brokerOrderId)
      .toBe(secondPartial.insertedOrders[0]?.brokerOrderId);
    expect(secondReplay.socialRows).toHaveLength(0);
    expect(secondReplay.insertedOrders).toHaveLength(0);
    expect(completed.socialRows).toHaveLength(1);
    expect(completed.insertedOrders[0]).toEqual(expect.objectContaining({
      quantityDecimal: "0.05",
      executedSizeDecimal: "0.05",
    }));
  });

  it("does not republish a completed close when its executed size did not grow", async () => {
    const order = perpOrder({
      brokerOrderId: "98765",
      status: "PARTIAL",
      executedSizeDecimal: "0.125",
    });
    const { db, socialRows } = syncDb(order);
    const notify = vi.fn().mockResolvedValue(undefined);

    await (new HyperliquidOrderSyncPoller(db as never, { notify }) as any)
      .reconcileOne(order, [fillFor(order)], []);

    expect(socialRows).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("atomically publishes a reduce-only fill and notifies with decimal size", async () => {
    const order = perpOrder({
      brokerOrderId: "98765",
      orderType: "TakeProfitMarket",
    });
    const { db, socialRows } = syncDb(order);
    const notify = vi.fn().mockResolvedValue(undefined);
    const poller = new HyperliquidOrderSyncPoller(db as never, { notify });

    await (poller as any).reconcileOne(order, [fillFor(order)], []);

    expect(socialRows).toEqual([
      expect.objectContaining({
        userId: "user-1",
        symbol: "BTC",
        side: "sell",
        qty: 1,
        orderType: "takeprofitmarket",
        assetType: "PERP",
        brokerOrderId: "hyperliquid-fill-delta:11111111-1111-4111-8111-111111111111:12500000",
      }),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "BTC",
      side: "Sell",
      quantity: 0.125,
      status: "FILLED",
      previousStatus: "SUBMITTED",
      executedPrice: 117500.25,
      orderId: order.id,
      assetType: "PERP",
      orderType: "TakeProfitMarket",
      reduceOnly: true,
      // The VENUE's fill time, not the reconcile time. Without this the
      // staleness guard has nothing to judge and a long-wedged row announces
      // its old fill as live.
      executedAt: Date.parse("2026-07-31T12:05:00.000Z"),
      closeReason: "take_profit",
    }));
  });

  it("labels a reduce-only stop fill with its close reason", async () => {
    const order = perpOrder({
      brokerOrderId: "98765",
      orderType: "StopMarket",
    });
    const { db } = syncDb(order);
    const notify = vi.fn().mockResolvedValue(undefined);
    const poller = new HyperliquidOrderSyncPoller(db as never, { notify });

    await (poller as any).reconcileOne(order, [fillFor(order)], []);

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      orderType: "StopMarket",
      closeReason: "stop_loss",
    }));
  });

  it("alerts once for the exact delta of a newly persisted partial stop close", async () => {
    const order = perpOrder({
      brokerOrderId: "98765",
      orderType: "StopMarket",
      status: "PARTIAL",
      executedSizeDecimal: "0.03",
    });
    const venueTime = Date.parse("2026-07-31T12:06:00.000Z");
    const fills = [
      fillFor(order, "0.03"),
      { ...fillFor(order, "0.04"), time: venueTime },
    ];
    const openOrders = [
      { coin: "BTC", oid: 98765, sz: "0.055", origSz: "0.125" },
    ];
    const persisted = syncDb(order);
    const notify = vi.fn().mockResolvedValue(undefined);

    await (new HyperliquidOrderSyncPoller(persisted.db as never, { notify }) as any)
      .reconcileOne(order, fills, openOrders);

    expect(persisted.orderUpdates[0]).toMatchObject({
      status: "PARTIAL",
      executedSizeDecimal: "0.07",
    });
    expect(persisted.insertedOrders).toEqual([
      expect.objectContaining({
        status: "FILLED",
        quantityDecimal: "0.04",
        executedSizeDecimal: "0.04",
        reduceOnly: true,
      }),
    ]);
    expect(persisted.socialRows).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "BTC",
      side: "Sell",
      direction: "short",
      quantity: 0.04,
      quantityDecimal: "0.04",
      status: "PARTIAL",
      previousStatus: "PARTIAL",
      orderType: "StopMarket",
      closeReason: "stop_loss",
      executedAt: venueTime,
    }));

    const recorded = perpOrder({
      brokerOrderId: "98765",
      orderType: "StopMarket",
      status: "PARTIAL",
      executedSizeDecimal: "0.07",
      lastCountedFillId: persisted.orderUpdates[0]?.lastCountedFillId as string | null,
    });
    const repeated = syncDb(recorded);

    await (new HyperliquidOrderSyncPoller(repeated.db as never, { notify }) as any)
      .reconcileOne(recorded, fills, openOrders);

    expect(repeated.socialRows).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("lets only the winning terminal transition emit across concurrent pollers", async () => {
    const order = perpOrder({ brokerOrderId: "98765" });
    const { db, socialRows, insertedOrders } = syncDb(order);
    const notify = vi.fn().mockResolvedValue(undefined);
    const first = new HyperliquidOrderSyncPoller(db as never, { notify });
    const second = new HyperliquidOrderSyncPoller(db as never, { notify });

    await Promise.all([
      (first as any).reconcileOne(order, [fillFor(order)], []),
      (second as any).reconcileOne(order, [fillFor(order)], []),
    ]);

    expect(socialRows).toHaveLength(1);
    expect(insertedOrders).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("publishes opening fills and preserves the exact decimal on the joined order", async () => {
    const openingOrder = perpOrder({
      reduceOnly: false,
      brokerOrderId: "98765",
      tradeAction: "Buy",
      direction: "long",
    });
    const opening = syncDb(openingOrder);
    const openingNotify = vi.fn().mockResolvedValue(undefined);
    await (new HyperliquidOrderSyncPoller(opening.db as never, { notify: openingNotify }) as any)
      .reconcileOne(openingOrder, [fillFor(openingOrder)], []);

    expect(opening.socialRows).toEqual([
      expect.objectContaining({
        assetType: "PERP",
        brokerOrderId: "hyperliquid-fill-delta:11111111-1111-4111-8111-111111111111:12500000",
        qty: 1,
      }),
    ]);
    expect(opening.orderUpdates[0]?.executedSizeDecimal).toBe("0.125");
    expect(opening.insertedOrders).toEqual([
      expect.objectContaining({
        status: "FILLED",
        quantityDecimal: "0.125",
        executedSizeDecimal: "0.125",
      }),
    ]);
    expect(openingNotify).toHaveBeenCalledTimes(1);
    expect(openingNotify).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "BTC",
      side: "Buy",
      quantityDecimal: "0.125",
      status: "FILLED",
      previousStatus: "SUBMITTED",
      assetType: "PERP",
    }));
  });

  it("publishes short action fills with the exact child order link and sell side", async () => {
    const shortOrder = perpOrder({
      reduceOnly: false,
      brokerOrderId: "98765",
      tradeAction: "SellShort",
      direction: "short",
    });
    const { db, socialRows, insertedOrders } = syncDb(shortOrder);

    await (new HyperliquidOrderSyncPoller(db as never) as any)
      .reconcileOne(shortOrder, [fillFor(shortOrder)], []);

    expect(insertedOrders).toHaveLength(1);
    expect(socialRows).toEqual([
      expect.objectContaining({
        side: "sell",
        brokerOrderId: insertedOrders[0]?.brokerOrderId,
        orderId: insertedOrders[0]?.id,
      }),
    ]);
  });

  it("publishes every exact delta across partial and completed opening fills", async () => {
    const submitted = perpOrder({ reduceOnly: false, brokerOrderId: "98765" });
    const firstPartial = syncDb(submitted);
    const firstNotify = vi.fn().mockResolvedValue(undefined);
    await (new HyperliquidOrderSyncPoller(firstPartial.db as never, { notify: firstNotify }) as any)
      .reconcileOne(
        submitted,
        [fillFor(submitted, "0.04")],
        [{ coin: "BTC", oid: 98765, sz: "0.085", origSz: "0.125" }],
      );

    const recordedFirstPartial = perpOrder({
      reduceOnly: false,
      brokerOrderId: "98765",
      status: "PARTIAL",
      executedSizeDecimal: "0.04",
    });
    const secondPartial = syncDb(recordedFirstPartial);
    const secondNotify = vi.fn().mockResolvedValue(undefined);
    await (new HyperliquidOrderSyncPoller(secondPartial.db as never, { notify: secondNotify }) as any)
      .reconcileOne(
        recordedFirstPartial,
        [
          fillFor(recordedFirstPartial, "0.04"),
          { ...fillFor(recordedFirstPartial, "0.035"), time: Date.parse("2026-07-31T12:06:00.000Z") },
        ],
        [{ coin: "BTC", oid: 98765, sz: "0.05", origSz: "0.125" }],
      );

    const recordedSecondPartial = perpOrder({
      reduceOnly: false,
      brokerOrderId: "98765",
      status: "PARTIAL",
      executedSizeDecimal: "0.075",
    });
    const completed = syncDb(recordedSecondPartial);
    const completedNotify = vi.fn().mockResolvedValue(undefined);
    await (new HyperliquidOrderSyncPoller(completed.db as never, { notify: completedNotify }) as any)
      .reconcileOne(
        recordedSecondPartial,
        [
          fillFor(recordedSecondPartial, "0.04"),
          { ...fillFor(recordedSecondPartial, "0.035"), time: Date.parse("2026-07-31T12:06:00.000Z") },
          { ...fillFor(recordedSecondPartial, "0.05"), time: Date.parse("2026-07-31T12:07:00.000Z") },
        ],
        [],
      );

    expect([
      firstPartial.insertedOrders[0]?.quantityDecimal,
      secondPartial.insertedOrders[0]?.quantityDecimal,
      completed.insertedOrders[0]?.quantityDecimal,
    ]).toEqual(["0.04", "0.035", "0.05"]);
    expect([
      firstPartial.socialRows[0]?.brokerOrderId,
      secondPartial.socialRows[0]?.brokerOrderId,
      completed.socialRows[0]?.brokerOrderId,
    ]).toEqual([
      firstPartial.insertedOrders[0]?.brokerOrderId,
      secondPartial.insertedOrders[0]?.brokerOrderId,
      completed.insertedOrders[0]?.brokerOrderId,
    ]);
    expect(firstNotify).toHaveBeenCalledTimes(0);
    expect(secondNotify).toHaveBeenCalledTimes(0);
    expect(completedNotify).toHaveBeenCalledTimes(1);
  });

  it("stores the incremental fill price instead of the new cumulative VWAP", async () => {
    const order = perpOrder({
      reduceOnly: false,
      brokerOrderId: "98765",
      status: "PARTIAL",
      executedSizeDecimal: "0.04",
      executedPrice: "100",
    });
    const synced = syncDb(order);

    await (new HyperliquidOrderSyncPoller(synced.db as never) as any).reconcileOne(
      order,
      [
        { ...fillFor(order, "0.04"), px: "100" },
        { ...fillFor(order, "0.06"), px: "200", time: Date.parse("2026-07-31T12:06:00.000Z") },
      ],
      [{ coin: "BTC", oid: 98765, sz: "0.025", origSz: "0.125" }],
    );

    expect(synced.orderUpdates[0]?.executedPrice).toBe("160");
    expect(synced.insertedOrders[0]).toEqual(expect.objectContaining({
      executedSizeDecimal: "0.06",
      executedPrice: "200",
    }));
  });

  it("does not republish an auto-mirrored fill as a new source trade", async () => {
    const mirroredOrder = perpOrder({
      reduceOnly: false,
      brokerOrderId: "98765",
      clientOrderId: "copymirror:user-1:user:source-trade-1",
    });
    const mirrored = syncDb(mirroredOrder);

    await (new HyperliquidOrderSyncPoller(mirrored.db as never) as any)
      .reconcileOne(mirroredOrder, [fillFor(mirroredOrder)], []);

    expect(mirrored.socialRows).toHaveLength(0);
    expect(mirrored.insertedOrders).toHaveLength(0);
    expect(mirrored.orderUpdates[0]?.executedSizeDecimal).toBe("0.125");
  });

  it("does not publish after a zero-row CAS rereads an authoritative FILLED row", async () => {
    const order = perpOrder({ brokerOrderId: "98765" });
    const synced = syncDb(order, {
      transitionRows: [],
      authoritativeOrder: perpOrder({
        status: "FILLED",
        brokerOrderId: "98765",
        executedSizeDecimal: "0.125",
      }),
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    await (new HyperliquidOrderSyncPoller(synced.db as never, { notify }) as any)
      .reconcileOne(order, [fillFor(order)], []);

    expect(synced.socialRows).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not publish after a multi-row reconciliation CAS", async () => {
    const order = perpOrder({ brokerOrderId: "98765" });
    const synced = syncDb(order, {
      transitionRows: [{ id: "winner-a" }, { id: "winner-b" }],
      authoritativeOrder: perpOrder({
        status: "FILLED",
        brokerOrderId: "98765",
        executedSizeDecimal: "0.125",
      }),
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    await (new HyperliquidOrderSyncPoller(synced.db as never, { notify }) as any)
      .reconcileOne(order, [fillFor(order)], []);

    expect(synced.socialRows).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

});

describe("network scoping", () => {
  it("puts the network predicate in the QUERY, not after the cap", async () => {
    // Filtering after a newest-first cap lets rows from another network hide
    // relevant ones permanently: 5,000 newer testnet rows fill the whole scan,
    // every poll selects and discards exactly those, and older mainnet orders
    // are never reconciled. NULL is included so pre-column rows are not
    // stranded.
    const previous = process.env.HYPERLIQUID_NETWORK;
    process.env.HYPERLIQUID_NETWORK = "mainnet";
    let where: unknown;
    try {
      const poller = new HyperliquidOrderSyncPoller({
        query: {
          orders: {
            findMany: async (args: any) => {
              where = args.where;
              return [];
            },
          },
        },
      } as never);
      await (poller as any).poll();
    } finally {
      if (previous === undefined) delete process.env.HYPERLIQUID_NETWORK;
      else process.env.HYPERLIQUID_NETWORK = previous;
    }

    const seen = new WeakSet<object>();
    const bound: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node.value === "string") bound.push(node.value);
      Object.values(node).forEach(walk);
    };
    walk(where);
    expect(bound).toContain("mainnet");
  });
});

describe("cancellation age", () => {
  it("does not cancel a freshly PLACED row that was staged long ago", async () => {
    // The min-cancel-age guard exists to give a just-placed order time to appear
    // at the venue. A resumed row can be hours old while its placement is
    // seconds old, so aging it from created_at makes it instantly eligible and
    // one empty snapshot settles it CANCELLED. Terminal rows are not polled
    // again, so a delayed fill stays hidden and its exposure cannot be
    // attributed for a copied close.
    const order = perpOrder({
      status: "PENDING",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      placedAt: new Date(),
      // Known network, so this exercises the AGE guard rather than the
      // unproven-network suppression below.
      venueNetwork: "mainnet",
    });
    const { db, orderUpdates } = syncDb(order);

    // Empty snapshot: no fills, nothing resting.
    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(order, [], []);

    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(false);
  });

  it("still cancels once the PLACEMENT itself is old enough", async () => {
    const order = perpOrder({
      status: "PENDING",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      placedAt: new Date(Date.now() - 60 * 60 * 1000),
      venueNetwork: "mainnet",
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(order, [], []);

    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(true);
  });

  it("does not cancel an old PENDING row while a resume placement lease is active", async () => {
    const order = perpOrder({
      status: "PENDING",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      placedAt: null,
      venueNetwork: "mainnet",
      syncReason: "copy-mirror:perp-placement",
      lastSyncAttemptAt: new Date(Date.now() - 1_000),
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(order, [], []);

    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(false);
  });

  it("treats a future placement lease timestamp as active under clock skew", async () => {
    const order = perpOrder({
      status: "PENDING",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      placedAt: null,
      venueNetwork: "mainnet",
      syncReason: "copy-mirror:perp-placement",
      // A worker clock may be behind the database/placement writer. A future
      // lease is still active; negative age must not turn it into proof of
      // absence and let this stale snapshot cancel the row.
      lastSyncAttemptAt: new Date(Date.now() + 60_000),
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(order, [], []);

    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(false);
  });

  it("does not cancel from a stale absence snapshot after Phase A stamps a placement lease", async () => {
    const order = perpOrder({
      status: "PENDING",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      placedAt: null,
      venueNetwork: "mainnet",
      syncReason: null,
      lastSyncAttemptAt: null,
    });
    const orderUpdates: Array<Record<string, unknown>> = [];
    const updateWheres: unknown[] = [];
    let cancellationApplied = false;
    const hasColumn = (node: unknown, name: string): boolean => {
      if (!node || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some((entry) => hasColumn(entry, name));
      const value = node as Record<string, unknown>;
      if (value.name === name) return true;
      return Object.entries(value).some(([key, child]) =>
        key !== "table" && key !== "_" && hasColumn(child, name),
      );
    };
    const db = {
      query: {
        orders: {
          findFirst: vi.fn().mockResolvedValue({ ...order, status: "PENDING" }),
        },
      },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          orderUpdates.push(values);
          return {
            where: vi.fn().mockImplementation((clause: unknown) => {
              updateWheres.push(clause);
              return {
                returning: vi.fn().mockImplementation(async () => {
                  if (values.status !== "CANCELLED") return [{ id: order.id }];
                  // Exact interleaving: the scan read the old row, then Phase A
                  // committed the active lease before this stale cancellation
                  // UPDATE reached the database.
                  const leaseWasCompared =
                    hasColumn(clause, "last_sync_attempt_at") && hasColumn(clause, "sync_reason");
                  if (!leaseWasCompared) {
                    cancellationApplied = true;
                    return [{ id: order.id }];
                  }
                  return [];
                }),
              };
            }),
          };
        }),
      }),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => unknown) =>
        callback(db),
      ),
    };

    await (new HyperliquidOrderSyncPoller(db as never) as any)
      .reconcileOne(order, [], []);

    expect(cancellationApplied).toBe(false);
    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(true);
    expect(updateWheres).toHaveLength(1);
    expect(hasColumn(updateWheres[0], "last_sync_attempt_at")).toBe(true);
    expect(hasColumn(updateWheres[0], "sync_reason")).toBe(true);
  });
});

describe("incomplete open-order coverage", () => {
  it("does not infer cancellation from an incomplete HIP-3 absence read", async () => {
    const order = perpOrder({
      symbol: "xyz:JPY",
      venueNetwork: "mainnet",
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [],
      [],
      { complete: false, coveredDexes: [""] },
    );

    expect(orderUpdates).toHaveLength(0);
  });

  it("keeps fill evidence while withholding absence-based cancellation for an unread HIP-3 dex", async () => {
    const order = perpOrder({
      symbol: "xyz:JPY",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order, "0.05")],
      [],
      { complete: false, coveredDexes: [""] },
    );

    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(false);
    expect(orderUpdates.some((update) => update.status === "PARTIAL")).toBe(true);
    expect(orderUpdates.find((update) => update.status === "PARTIAL")?.executedSizeDecimal).toBe("0.05");
  });
});

describe("legacy rows with an unproven network", () => {
  it("never settles a NULL-network row as CANCELLED", async () => {
    // Cancellation is the one transition inferred from ABSENCE, and absence is
    // exactly what an unproven network makes unreliable: an old testnet order
    // cannot appear in a mainnet snapshot, so "no fill, nothing resting" says
    // nothing about it. Settling it terminal is unrecoverable, since terminal
    // rows are never polled again.
    const order = perpOrder({
      status: "PENDING",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      placedAt: new Date(Date.now() - 60 * 60 * 1000),
      venueNetwork: null,
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(order, [], []);

    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(false);
  });

  it("still applies FILLS to a NULL-network row", async () => {
    // Fills are positive evidence: one matching our cloid on this network IS
    // ours, whatever the row claims, so those still reconcile.
    // brokerOrderId matches the fill's oid, which is how these fixtures pair.
    const order = perpOrder({ status: "SUBMITTED", venueNetwork: null, brokerOrderId: "98765" });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order, "1")],
      [],
    );

    expect(orderUpdates.some((update) => update.status === "FILLED")).toBe(true);
  });
});

describe("scan ordering and the reconciliation CAS", () => {
  it("orders proven rows ahead of unproven ones", async () => {
    // An unproven row can no longer be cancelled from absence, so it never
    // drains. Under a plain newest-first order, enough of them would fill the
    // cap on every poll and proven rows on the active network would never be
    // reached, leaving their fills unrecorded and close sizing with nothing.
    let ordering: unknown;
    const poller = new HyperliquidOrderSyncPoller({
      query: {
        orders: {
          findMany: async (args: any) => {
            ordering = args.orderBy;
            return [];
          },
        },
      },
    } as never);

    await (poller as any).poll();

    // Drizzle keeps raw SQL as StringChunks whose `value` is a string ARRAY.
    const seen = new WeakSet<object>();
    const literals: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (Array.isArray(node.value) && node.value.every((v: unknown) => typeof v === "string")) {
        literals.push(node.value.join(""));
      }
      Object.values(node).forEach(walk);
    };
    walk(ordering);
    expect(literals.join(" ")).toContain("is null");
  });

  it("includes the fill cursor in the compare-and-set", async () => {
    // Status plus size stopped being sufficient once a cursor advance became
    // meaningful on its own: a cursor-only update leaves both unchanged, so two
    // replicas both pass and the slower one can write its older cursor over the
    // newer, after which the next poll re-counts the fill in between and
    // inflates cumulative exposure.
    const order = perpOrder({ status: "SUBMITTED", brokerOrderId: "98765", venueNetwork: "mainnet" });
    const { db, updateWheres } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order, "1")],
      [],
    );

    // Does NOT follow `table`: a drizzle Column links back to the whole table
    // definition, so recursing into it reaches every column in `orders` and the
    // assertion below would pass whatever the predicate contains. The control
    // assertion is what proves the walk is reading the clause.
    const seen = new WeakSet<object>();
    const columns: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node.name === "string") columns.push(node.name);
      for (const [key, value] of Object.entries(node)) {
        if (key === "table" || key === "_") continue;
        walk(value);
      }
    };
    walk(updateWheres);
    expect(columns).toContain("last_counted_fill_id");
    // Control: a column NOT in the predicate. If this is present the walker is
    // reaching the table definition rather than the clause, and the assertion
    // above would pass no matter what the predicate contains.
    expect(columns).not.toContain("notes");
  });
});

describe("placement time backfill", () => {
  /**
   * The mirror stamps `placedAt` right after Hyperliquid accepts, and that write
   * can fail while the order is live: the delivery reports "syncing" and the row
   * is left PENDING with a null `placedAt`. The daily cap reads it through
   * `coalesce(placed_at, created_at)`, so a row created before midnight and
   * placed after it is counted against the wrong day, or none. This reconciler
   * is the only other code that ever learns the order reached the venue.
   */
  it("does NOT use the fill time as a placement time", async () => {
    // The fill time is not a proxy for placement. A limit order placed
    // yesterday and filled today would be stamped today and eat a slot in
    // today's cap, which is worse than the created_at fallback it replaced.
    // Nothing the venue reports about a filled order says when it was placed,
    // so this keeps that fallback.
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: null,
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    expect(orderUpdates[0]?.status).toBe("FILLED");
    expect(orderUpdates[0]?.placedAt).toBeNull();
  });

  it("leaves a recorded placement time alone", async () => {
    const placed = new Date("2026-07-31T11:59:00.000Z");
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: placed,
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    expect(orderUpdates[0]?.placedAt).toBe(placed);
  });

  it("does NOT invent a placement time for an order the venue never saw either", async () => {
    // A cancellation from absence is the venue reporting it never arrived.
    // Stamping that would manufacture a placement out of one that never
    // happened, and put a phantom order into the day's cap.
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: null,
      perpProtectionStatus: "unprotected",
      perpProtectionError: "placement-ambiguous:open",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(order, [], []);

    expect(orderUpdates[0]?.status).toBe("CANCELLED");
    expect(orderUpdates[0]?.placedAt).toBeNull();
    expect(orderUpdates[0]?.perpProtectionStatus).toBe("cancelled");
    expect(orderUpdates[0]?.perpProtectionError).toBeNull();
  });
});

describe("placement time from a resting order", () => {
  /**
   * A resting order is the venue confirming acceptance, and it is the ONLY
   * confirmation an accepted-but-unfilled order ever produces. `reconcilePerpOrder`
   * returns null for it, since there is no state change, so the backfill on the
   * transition never runs. Until the first fill the daily cap keeps reading
   * `coalesce(placed_at, created_at)` and counting the order against the day the
   * row was created rather than the day it was placed.
   */
  const PLACED_MS = Date.parse("2026-07-31T12:01:00.000Z");
  const resting = (order: ReturnType<typeof perpOrder>, timestamp: number = PLACED_MS) => ({
    coin: order.symbol,
    oid: 98765,
    cloid: undefined,
    sz: "0.125",
    origSz: "0.125",
    timestamp,
  });

  it("stamps placement for an accepted order that has not filled", async () => {
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: null,
    });
    const { db, directUpdates, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [],
      [resting(order)],
    );

    // No transition at all: the order is exactly where it was.
    expect(orderUpdates).toEqual([]);
    expect(directUpdates.length).toBe(1);
    // The VENUE's placement time, never the moment this poll looked. Stamping
    // observation time would put an order placed days ago into today's cap.
    expect((directUpdates[0]!.placedAt as Date).toISOString()).toBe(
      "2026-07-31T12:01:00.000Z",
    );
  });

  it("keeps the venue timestamp when the same cycle also records a fill", async () => {
    // A partially filled order that is still resting reaches BOTH writes in one
    // cycle. The transition runs from the in-memory row, where placedAt is still
    // null, so without the resting value it would overwrite the venue's
    // placement time with the fill time. Straddling midnight, that is the wrong
    // day in the cap.
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: null,
      quantityDecimal: "0.25",
    });
    const { db, directUpdates, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order, "0.125")],
      [resting(order)],
    );

    // Placement time from the venue in both writes; the fill time (12:05) is
    // later and must not win.
    expect((directUpdates[0]!.placedAt as Date).toISOString()).toBe(
      "2026-07-31T12:01:00.000Z",
    );
    expect((orderUpdates[0]!.placedAt as Date).toISOString()).toBe(
      "2026-07-31T12:01:00.000Z",
    );
  });

  it("leaves an entry with no venue timestamp alone", async () => {
    // Without the venue's own record there is nothing honest to write, and
    // countMirrorsToday's created_at fallback already handles the legacy rows
    // this would otherwise misdate.
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: null,
    });
    const { db, directUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [],
      // Built inline WITHOUT the field: passing undefined to the helper would
      // trigger its default parameter and silently restore the timestamp.
      [{ coin: order.symbol, oid: 98765, cloid: undefined, sz: "0.125", origSz: "0.125" }],
    );

    expect(directUpdates).toEqual([]);
  });

  it("does not restamp an order that already has a placement time", async () => {
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: new Date("2026-07-31T11:59:00.000Z"),
    });
    const { db, directUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [],
      [resting(order)],
    );

    expect(directUpdates).toEqual([]);
  });

  it("does not stamp an order the venue is not holding", async () => {
    // No resting match means no proof of acceptance. An absent order is the
    // cancellation case, and inventing a placement there would put an order
    // that never existed into the day's cap.
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      placedAt: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { db, directUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [],
      [{ coin: "ETH", oid: 11111, cloid: undefined, sz: "1", origSz: "1" }],
    );

    expect(directUpdates).toEqual([]);
  });
});

describe("absorbing the legacy funding_paid column", () => {
  /**
   * Migration 0027 runs in the API build (apps/api/vercel.json) while the worker
   * deploys separately on Railway, so the column exists for a window in which
   * the OLD worker is still reconciling into `funding_paid` and advancing the
   * shared fill cursor. Anything it records there would be invisible to code
   * that reads only `realized_pnl`, and unrecoverable, because the cursor has
   * already moved past those fills.
   */
  it("extends the cumulative pnl from funding_paid when the legacy column is populated", async () => {
    const order = perpOrder({
      status: "PARTIAL",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      executedSizeDecimal: "0.0625",
      lastCountedFillId: "0",
      // What an old worker left behind: more complete than realized_pnl, since
      // it kept extending while realized_pnl sat at the migration's snapshot.
      fundingPaid: "100",
      realizedPnl: "60",
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    // 100 + 42.50 from the fill, not 60 + 42.50.
    expect(Number(orderUpdates[0]?.realizedPnl)).toBeCloseTo(142.5, 6);
    // DUAL-WRITTEN, not cleared. Nulling it would hand an old worker still in
    // the rolling window an empty accumulation base, and its next fill would
    // come back as a bare suffix rather than a running total.
    expect(Number(orderUpdates[0]?.fundingPaid)).toBeCloseTo(142.5, 6);
  });

  it("uses realized_pnl once the legacy column is empty", async () => {
    const order = perpOrder({
      status: "PARTIAL",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      executedSizeDecimal: "0.0625",
      lastCountedFillId: "0",
      fundingPaid: null,
      realizedPnl: "60",
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    expect(Number(orderUpdates[0]?.realizedPnl)).toBeCloseTo(102.5, 6);
  });
});

describe("sweeping the legacy pnl column", () => {
  /**
   * reconcileOne absorbs `funding_paid` per row, but only for rows the ACTIVE
   * scan returns (PENDING/SYNCING/SUBMITTED/PARTIAL). Migration 0027 runs in the API
   * build while the worker deploys separately, so an old worker can take an
   * order all the way to FILLED inside the window: it writes the final
   * cumulative to `funding_paid` and the row is terminal before this process
   * ever sees it.
   */
  it("runs a sweep before every scan, so terminal rows are not stranded", async () => {
    const sets: Array<Record<string, unknown>> = [];
    const poller = new HyperliquidOrderSyncPoller({
      query: { orders: { findMany: async () => [] } },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          sets.push(values);
          return {
            where: vi.fn().mockReturnValue(whereResult(Promise.resolve([]))),
          };
        }),
      }),
    } as never);

    await (poller as any).poll();

    // Copies into realized_pnl and leaves the legacy column alone: clearing it
    // is what would break an old worker still accumulating into it.
    expect(sets.length).toBe(1);
    expect(Object.keys(sets[0] ?? {})).toEqual(["realizedPnl"]);
    // Nothing was reconciled this cycle, so nothing may be retired: the
    // retirement sweep only claims rows whose venue outcome was just asked for.
    expect(
      sets.some((values) => values.status === "EXPIRED"),
    ).toBe(false);
  });

  it("does not abandon the cycle when the sweep fails", async () => {
    // A failed absorption is not a reason to stop reconciling; the next cycle
    // retries it.
    let scanned = false;
    const poller = new HyperliquidOrderSyncPoller({
      query: {
        orders: {
          findMany: async () => {
            scanned = true;
            return [];
          },
        },
      },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          // Both sweep shapes read from the same failure: the legacy one awaits
          // where() directly, the retirement one calls returning().
          where: vi
            .fn()
            .mockImplementation(() => whereResult(Promise.reject(new Error("db down")))),
        }),
      }),
    } as never);

    await (poller as any).poll();

    expect(scanned).toBe(true);
  });
});

describe("the rolling-deploy window between worker revisions", () => {
  /**
   * The trap this is here to prevent: the old worker uses `funding_paid` as its
   * accumulation BASE. If the new worker empties that column, the old worker's
   * next fill writes back only that fill's suffix, and anything that prefers
   * the legacy column then adopts the suffix as the whole and permanently
   * reduces the total.
   */
  it("never hands the old worker an empty accumulation base", async () => {
    const order = perpOrder({
      status: "PARTIAL",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
      executedSizeDecimal: "0.0625",
      lastCountedFillId: "0",
      fundingPaid: "100",
      realizedPnl: "100",
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    // Both columns carry the same running total afterwards, so whichever
    // revision touches the row next reads a correct base.
    expect(orderUpdates[0]?.fundingPaid).toBe(orderUpdates[0]?.realizedPnl);
    expect(orderUpdates[0]?.fundingPaid).not.toBeNull();
  });
});

describe("exact cloid authority for deterministic pending mirrors", () => {
  const expiredMirror = () => perpOrder({
    status: "PENDING",
    clientOrderId: "copymirror:user-1:user:source-trade-exact",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    placedAt: new Date(Date.now() - 60 * 60 * 1000),
    venueNetwork: "mainnet",
    brokerAccountId: "0xMaster",
  });

  it("does not cancel aggregate absence when exact status is filled", async () => {
    const order = expiredMirror();
    const exactStatus = vi.fn().mockResolvedValue({
      status: "order",
      order: {
        status: "filled",
        statusTimestamp: Date.now(),
        order: { oid: 98765 },
      },
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never, {
      readOrderStatus: exactStatus,
    }) as any).reconcileOne(order, [], []);

    expect(exactStatus).toHaveBeenCalledTimes(1);
    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(false);
  });

  it("does not cancel aggregate absence when exact status is still open", async () => {
    const order = expiredMirror();
    const exactStatus = vi.fn().mockResolvedValue({
      status: "order",
      order: {
        status: "open",
        statusTimestamp: Date.now(),
        order: { oid: 98765 },
      },
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never, {
      readOrderStatus: exactStatus,
    }) as any).reconcileOne(order, [], []);

    expect(exactStatus).toHaveBeenCalledTimes(1);
    expect(orderUpdates).toHaveLength(0);
  });

  it("defers when exact status is unavailable or malformed", async () => {
    const unavailable = expiredMirror();
    const unavailableDb = syncDb(unavailable);
    await (new HyperliquidOrderSyncPoller(unavailableDb.db as never, {
      readOrderStatus: undefined,
    }) as any).reconcileOne(unavailable, [], []);
    expect(unavailableDb.orderUpdates).toHaveLength(0);

    const malformed = expiredMirror();
    const malformedStatus = vi.fn().mockResolvedValue({ status: "order" });
    const malformedDb = syncDb(malformed);
    await (new HyperliquidOrderSyncPoller(malformedDb.db as never, {
      readOrderStatus: malformedStatus,
    }) as any).reconcileOne(malformed, [], []);

    expect(malformedStatus).toHaveBeenCalledTimes(1);
    expect(malformedDb.orderUpdates).toHaveLength(0);
  });

  it("requires two valid unknownOid observations before absence cancellation", async () => {
    const order = expiredMirror();
    const exactStatus = vi.fn().mockResolvedValue({ status: "unknownOid" });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never, {
      readOrderStatus: exactStatus,
    }) as any).reconcileOne(order, [], []);

    expect(exactStatus).toHaveBeenCalledTimes(2);
    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(true);
  });

  it("lets an exact terminal cancellation drive reconciliation", async () => {
    const order = expiredMirror();
    const exactStatus = vi.fn().mockResolvedValue({
      status: "order",
      order: {
        status: "canceled",
        statusTimestamp: Date.now(),
        order: { oid: 98765 },
      },
    });
    const { db, orderUpdates } = syncDb(order);

    await (new HyperliquidOrderSyncPoller(db as never, {
      readOrderStatus: exactStatus,
    }) as any).reconcileOne(order, [], []);

    expect(exactStatus).toHaveBeenCalledTimes(1);
    expect(orderUpdates.some((update) => update.status === "CANCELLED")).toBe(true);
  });

});

describe("production database clock failures", () => {
  it("defers all reconciliation writes when the database clock rejects", async () => {
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
    });
    const execute = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const synced = syncDb(order, { execute });

    await (new HyperliquidOrderSyncPoller(synced.db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(synced.orderUpdates).toHaveLength(0);
    expect(synced.directUpdates).toHaveLength(0);
  });

  it("defers all reconciliation writes when the database clock is malformed", async () => {
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
    });
    const execute = vi.fn().mockResolvedValue([{ now: "not-a-timestamp" }]);
    const synced = syncDb(order, { execute });

    await (new HyperliquidOrderSyncPoller(synced.db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(synced.orderUpdates).toHaveLength(0);
    expect(synced.directUpdates).toHaveLength(0);
  });

  it("rejects a numeric clock payload instead of coercing it into a date", async () => {
    const order = perpOrder({
      status: "SUBMITTED",
      brokerOrderId: "98765",
      venueNetwork: "mainnet",
    });
    const execute = vi.fn().mockResolvedValue([{ now: 12345 }]);
    const synced = syncDb(order, { execute });

    await (new HyperliquidOrderSyncPoller(synced.db as never) as any).reconcileOne(
      order,
      [fillFor(order)],
      [],
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(synced.orderUpdates).toHaveLength(0);
    expect(synced.directUpdates).toHaveLength(0);
  });

  it("does not read the venue when the production database clock is unavailable", async () => {
    const order = perpOrder({
      status: "PENDING",
      clientOrderId: "copymirror:user-1:user:source-trade-clock",
      venueNetwork: "mainnet",
    });
    const execute = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const venueCalls = {
      fills: 0,
      openOrders: 0,
    };
    const poller = new HyperliquidOrderSyncPoller({
      query: {
        orders: {
          findMany: vi.fn().mockResolvedValue([order]),
        },
      },
      execute,
      createInfoClient: () => ({
        userFills: async () => {
          venueCalls.fills += 1;
          return [];
        },
        openOrders: async () => {
          venueCalls.openOrders += 1;
          return [];
        },
      }),
    } as never);

    await (poller as any).poll();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(venueCalls).toEqual({ fills: 0, openOrders: 0 });
  });
});

describe("isRetirablePerpOrder", () => {
  const now = Date.parse("2026-08-31T07:20:44.000Z");
  const days = (n: number) => new Date(now - n * 24 * 60 * 60_000);

  it("retires an old Market order the venue acknowledged", () => {
    // The 2026-07-29 BTC ghost: filled long ago, polled every 30s ever since.
    expect(
      isRetirablePerpOrder(
        { orderType: "Market", brokerOrderId: "505085728820", createdAt: days(33) } as never,
        now,
      ),
    ).toBe(true);
  });

  it("NEVER retires a resting leg, at any age, with or without a broker id", () => {
    // A reduce-only stop protecting an open position is supposed to sit for
    // weeks. Expiring it locally would tell the app a live stop is gone.
    //
    // A NULL brokerOrderId does not make it safe either: the manual perp submit
    // persists status "SUBMITTED" without one, and the broker-succeeded /
    // DB-write-failed path leaves an accepted row PENDING. Both leave a live
    // resting order with no locally recorded venue id.
    for (const orderType of [
      "StopMarket",
      "StopLimit",
      "TakeProfitMarket",
      "TakeProfitLimit",
      "Limit",
    ]) {
      for (const brokerOrderId of ["98765", null]) {
        expect(
          isRetirablePerpOrder(
            { orderType, brokerOrderId, createdAt: days(400) } as never,
            now,
          ),
        ).toBe(false);
      }
    }
  });

  it("keeps anything inside the window", () => {
    expect(
      isRetirablePerpOrder(
        { orderType: "Market", brokerOrderId: null, createdAt: days(6) } as never,
        now,
      ),
    ).toBe(false);
  });

  it("keeps a row with no usable creation time", () => {
    expect(
      isRetirablePerpOrder(
        { orderType: "Market", brokerOrderId: null, createdAt: null } as never,
        now,
      ),
    ).toBe(false);
  });
});

describe("retiring abandoned perp rows", () => {
  const aged = () =>
    perpOrder({
      id: "22222222-2222-4222-8222-222222222222",
      orderType: "Market",
      status: "SUBMITTED",
      brokerOrderId: "505085728820",
      venueNetwork: "mainnet",
      createdAt: new Date("2026-07-29T09:00:43.000Z"),
    });

  function retirementDb(order: ReturnType<typeof perpOrder>) {
    const events: string[] = [];
    const sets: Array<Record<string, unknown>> = [];
    const db = {
      query: { orders: { findMany: async () => [order] } },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          sets.push(values);
          if (values.status === "EXPIRED") events.push("retire");
          return {
            where: vi.fn().mockReturnValue(whereResult(Promise.resolve([]))),
          };
        }),
      }),
    };
    return { db, events, sets };
  }

  it("reconciles an aged row BEFORE retiring it", async () => {
    // The 2026-07-29 ghost had genuinely filled; a late reconciliation is what
    // finally recorded its size, price and pnl. Terminalizing first would drop
    // that outcome permanently, because a terminal row is never scanned again.
    const order = aged();
    const { db, events, sets } = retirementDb(order);
    const poller = new HyperliquidOrderSyncPoller(db as never, {
      createInfoClient: () => ({
        userFills: async () => [],
        openOrders: async () => [],
      }) as never,
    });
    // True means the row's venue outcome was conclusively settled, which is
    // what authorizes the sweep to claim it.
    (poller as any).reconcileOne = async () => {
      events.push("reconcile");
      return true;
    };

    await (poller as any).poll();

    expect(events).toEqual(["reconcile", "retire"]);
    expect(sets.at(-1)).toEqual({
      status: "EXPIRED",
      syncReason: ABANDONED_PERP_ORDER_REASON,
    });
  });

  it("retires nothing when the venue read failed", async () => {
    // An unreadable account is not evidence the order is dead. Waiting costs
    // one more cycle; terminalizing a live row costs the position.
    const order = aged();
    const { db, events } = retirementDb(order);
    const poller = new HyperliquidOrderSyncPoller(db as never, {
      createInfoClient: () => ({
        userFills: async () => {
          throw new Error("hyperliquid unreachable");
        },
        openOrders: async () => [],
      }) as never,
    });
    (poller as any).reconcileOne = async () => {
      events.push("reconcile");
      return true;
    };

    await (poller as any).poll();

    expect(events).toEqual([]);
  });

  it("retires nothing when reconciliation reached no conclusion", async () => {
    // `reconcileOne` returns without deciding in several safety cases: a
    // placement lease still in flight, an unreadable exact status, a venue that
    // reports the order live. Those returns are not exceptions, so a sweep
    // keyed on "did not throw" would treat a live order as abandoned and
    // terminalize it out from under the position it belongs to.
    const order = aged();
    const { db, events, sets } = retirementDb(order);
    const poller = new HyperliquidOrderSyncPoller(db as never, {
      createInfoClient: () => ({
        userFills: async () => [],
        openOrders: async () => [],
      }) as never,
    });
    (poller as any).reconcileOne = async () => {
      events.push("reconcile");
      return false;
    };

    await (poller as any).poll();

    expect(events).toEqual(["reconcile"]);
    // The unrelated funding-column backfill still writes on every poll, so the
    // claim here is specific: nothing was terminalized.
    expect(sets.some((values) => values.status === "EXPIRED")).toBe(false);
  });
});
