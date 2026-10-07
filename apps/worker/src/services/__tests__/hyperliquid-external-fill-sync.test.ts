/**
 * Wiring cover for the Hyperliquid external-fill poller.
 *
 * The pure decisions live in apps/api/src/lib/hyperliquid-external-fill.ts and
 * are tested there. What is asserted here is the part that can only go wrong in
 * the wiring: the kill switch, first-run cursor seeding (the difference between
 * "you were stopped out" and an account's whole history sprayed as alerts),
 * exactly-one webhook per fill across re-reads, and a watermark that holds when
 * something fails.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { schema } from "@trade-bot/db";
import { toCloid } from "@trade-bot/hyperliquid";
import { clearErrorReporter, setErrorReporter } from "@trade-bot/logger";

import {
  DEFAULT_EXTERNAL_FILL_USERS_PER_CYCLE,
  HyperliquidExternalFillPoller,
  mirroredProtectionSourceLabel,
  resolveExternalFillUsersPerCycle,
  rotatingCredentialBatch,
} from "../hyperliquid-external-fill-sync";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-08-25T12:00:00Z");

function hlFill(overrides: Record<string, unknown> = {}) {
  return {
    time: NOW.getTime() + 1_000,
    coin: "BTC",
    side: "sell" as const,
    px: "60000",
    sz: "0.5",
    closedPnl: "-120.5",
    fee: "1.2",
    dir: "Close Long",
    oid: 900,
    hash: "0xdeadbeef",
    tid: 4242,
    cloid: null,
    ...overrides,
  };
}

/**
 * Minimal fake db covering exactly the drizzle calls this poller makes:
 * credential + cursor + known-order reads, a cursor upsert/update, and an
 * order insert whose unique index is modeled by clientOrderId.
 */
function fakeDb(
  options: {
    credentials?: Array<Record<string, unknown>>;
    cursor?: { watermark: Date } | null;
    knownOrders?: Array<{
      brokerOrderId: string | null;
      clientOrderId?: string | null;
    }>;
    mirroredProtectionOrders?: Array<{
      copySourceLabel: string | null;
      perpProtection: { legClientOrderIds?: unknown } | null;
    }>;
  } = {},
) {
  const insertedOrders: Array<Record<string, any>> = [];
  const insertedSocialTrades: Array<Record<string, any>> = [];
  const insertedCursors: Array<Record<string, any>> = [];
  const cursorUpdates: Array<Record<string, any>> = [];
  let cursor = options.cursor ?? null;
  let orderFindManyCalls = 0;

  const db = {
    query: {
      userApiCredentials: {
        findMany: async () =>
          options.credentials ?? [
            {
              id: "cred-1",
              userId: "user-1",
              accountId: ADDRESS,
              username: null,
            },
          ],
      },
      externalFillCursors: {
        findFirst: async () => cursor ?? undefined,
      },
      orders: {
        findMany: async () => {
          orderFindManyCalls++;
          return orderFindManyCalls === 1
            ? options.knownOrders ?? []
            : options.mirroredProtectionOrders ?? [];
        },
      },
    },
    insert: (table: unknown) => ({
      values: (value: Record<string, any>) => {
        if (table === schema.externalFillCursors) {
          return {
            onConflictDoNothing: async () => {
              insertedCursors.push(value);
              cursor = { watermark: value.watermark };
            },
          };
        }
        if (table === schema.socialTrades) {
          insertedSocialTrades.push(value);
          return Promise.resolve();
        }
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              // The unique index on client_order_id, modeled.
              if (
                insertedOrders.some(
                  (o) => o.clientOrderId === value.clientOrderId,
                )
              ) {
                return [];
              }
              const row = {
                id: `order-${insertedOrders.length + 1}`,
                ...value,
              };
              insertedOrders.push(row);
              return [{ id: row.id }];
            },
          }),
        };
      },
    }),
    transaction: async (callback: (tx: any) => Promise<unknown>) => callback(db),
    update: (_table: unknown) => ({
      set: (value: Record<string, any>) => ({
        where: async (_predicate: unknown) => {
          cursorUpdates.push(value);
          cursor = { watermark: value.watermark };
        },
      }),
    }),
  };

  return {
    db: db as never,
    insertedOrders,
    insertedSocialTrades,
    insertedCursors,
    cursorUpdates,
    currentCursor: () => cursor,
  };
}

function fakeInfo(
  options: {
    fills?: Array<Record<string, unknown>>;
    openOrders?: Array<Record<string, unknown>>;
    failFills?: boolean;
    failOpenOrders?: boolean;
    fillError?: unknown;
    openOrdersStatus?: {
      orders: Array<Record<string, unknown>>;
      complete: boolean;
      coveredDexes: string[];
      failures?: Array<{ source: string; transient: boolean; status?: number }>;
    };
  } = {},
) {
  const calls = {
    listFills: 0,
    listOpenOrders: 0,
    listOpenOrdersWithStatus: 0,
    trafficClasses: [] as Array<string | undefined>,
  };
  return {
    calls,
    createInfoClient: (clientOptions?: { trafficClass?: string }) => {
      calls.trafficClasses.push(clientOptions?.trafficClass);
      return ({
      listFills: async () => {
        calls.listFills++;
        if (options.fillError !== undefined) throw options.fillError;
        if (options.failFills) throw new Error("hyperliquid unreachable");
        return options.fills ?? [];
      },
      listOpenOrders: async () => {
        calls.listOpenOrders++;
        if (options.failOpenOrders) throw new Error("open orders unreachable");
        return options.openOrders ?? [];
      },
      ...(options.openOrdersStatus
        ? {
            listOpenOrdersWithStatus: async () => {
              calls.listOpenOrdersWithStatus++;
              return options.openOrdersStatus;
            },
          }
        : {}),
      });
    },
  } as never as {
    calls: {
      listFills: number;
      listOpenOrders: number;
      listOpenOrdersWithStatus: number;
      trafficClasses: Array<string | undefined>;
    };
    createInfoClient: never;
  };
}

function collectNotifications() {
  const sent: Array<Record<string, any>> = [];
  return {
    sent,
    notify: (async (payload: Record<string, any>) => {
      sent.push(payload);
    }) as never,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.HYPERLIQUID_EXTERNAL_FILL_ENABLED = "true";
  delete process.env.HYPERLIQUID_EXTERNAL_FILL_BACKFILL_MS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  clearErrorReporter();
});

function poller(
  db: never,
  info: ReturnType<typeof fakeInfo>,
  notify: ReturnType<typeof collectNotifications>,
) {
  return new HyperliquidExternalFillPoller(db, {
    createInfoClient: info.createInfoClient,
    notify: notify.notify,
    now: () => NOW,
  });
}

describe("HyperliquidExternalFillPoller workload shaping", () => {
  it("bounds configuration and rotates through every account without wrapping a burst", () => {
    expect(resolveExternalFillUsersPerCycle({})).toBe(
      DEFAULT_EXTERNAL_FILL_USERS_PER_CYCLE,
    );
    expect(resolveExternalFillUsersPerCycle({
      HYPERLIQUID_EXTERNAL_FILL_USERS_PER_CYCLE: "999",
    })).toBe(25);

    const rows = ["a", "b", "c", "d", "e", "f", "g"];
    const first = rotatingCredentialBatch(rows, 0, 3);
    const second = rotatingCredentialBatch(rows, first.nextOffset, 3);
    const third = rotatingCredentialBatch(rows, second.nextOffset, 3);

    expect(first).toEqual({ batch: ["a", "b", "c"], nextOffset: 3 });
    expect(second).toEqual({ batch: ["d", "e", "f"], nextOffset: 6 });
    expect(third).toEqual({ batch: ["g"], nextOffset: 0 });
  });
});

describe("mirrored protection attribution", () => {
  it("matches an exact protection leg cloid", () => {
    const legId = "copymirror:follower:source:tpsl:sl:81.50000000";
    expect(
      mirroredProtectionSourceLabel(toCloid(legId), [
        {
          copySourceLabel: "SOL Decoder",
          perpProtection: { legClientOrderIds: [legId] },
        },
      ]),
    ).toBe("SOL Decoder");
  });

  it("does not guess when the fill has no matching cloid", () => {
    expect(
      mirroredProtectionSourceLabel(null, [
        {
          copySourceLabel: "SOL Decoder",
          perpProtection: { legClientOrderIds: ["some-other-leg"] },
        },
      ]),
    ).toBeNull();
  });
});

describe("HyperliquidExternalFillPoller kill switch", () => {
  it("schedules nothing at all when the flag is not exactly 'true'", async () => {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined)
        delete process.env.HYPERLIQUID_EXTERNAL_FILL_ENABLED;
      else process.env.HYPERLIQUID_EXTERNAL_FILL_ENABLED = value;

      const store = fakeDb();
      const info = fakeInfo({ fills: [hlFill()] });
      const notifications = collectNotifications();
      const instance = poller(store.db, info, notifications);

      await instance.start();
      instance.stop();

      expect(info.calls.listFills).toBe(0);
      expect(store.insertedOrders).toHaveLength(0);
    }
  });
});

describe("HyperliquidExternalFillPoller first run", () => {
  it("seeds the cursor at now before reading, so history is never replayed", async () => {
    const store = fakeDb({ cursor: null });
    // Every one of these predates the seed, which is exactly the burst that
    // must never reach the user when the poller is switched on.
    const info = fakeInfo({
      fills: [
        hlFill({ time: NOW.getTime() - 86_400_000, tid: 1 }),
        hlFill({ time: NOW.getTime() - 3_600_000, tid: 2 }),
      ],
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedCursors[0]?.watermark).toEqual(NOW);
    expect(store.insertedOrders).toHaveLength(0);
    expect(notifications.sent).toHaveLength(0);
  });

  it("honors an explicit backfill window", async () => {
    process.env.HYPERLIQUID_EXTERNAL_FILL_BACKFILL_MS = "7200000";
    const store = fakeDb({ cursor: null });
    const info = fakeInfo({
      fills: [hlFill({ time: NOW.getTime() - 3_600_000, tid: 2 })],
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedOrders).toHaveLength(1);
  });
});

describe("HyperliquidExternalFillPoller ingest", () => {
  it("spreads a large credential set across consecutive cycles", async () => {
    process.env.HYPERLIQUID_EXTERNAL_FILL_USERS_PER_CYCLE = "2";
    const credentials = Array.from({ length: 5 }, (_, index) => ({
      id: `cred-${index}`,
      userId: `user-${index}`,
      accountId: ADDRESS,
      username: null,
    }));
    const store = fakeDb({ credentials, cursor: { watermark: NOW } });
    const info = fakeInfo({ fills: [] });
    const instance = poller(store.db, info, collectNotifications());

    await instance.pollOnce();
    expect(info.calls.listFills).toBe(2);
    expect(info.calls.trafficClasses).toEqual(["background", "background"]);
    await instance.pollOnce();
    expect(info.calls.listFills).toBe(4);
    await instance.pollOnce();
    expect(info.calls.listFills).toBe(5);
  });

  it("refreshes optional trigger wording at most once per fifteen minutes", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ fills: [] });
    const notifications = collectNotifications();
    const instance = poller(store.db, info, notifications);

    await instance.pollOnce();
    await instance.pollOnce();

    expect(info.calls.listFills).toBe(2);
    expect(info.calls.listOpenOrders).toBe(1);
  });

  it("ingests a fill with no order row and alerts on it exactly once", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ fills: [hlFill()] });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedOrders).toHaveLength(1);
    expect(store.insertedOrders[0]).toMatchObject({
      symbol: "BTC",
      assetType: "PERP",
      venue: "hyperliquid",
      externalOrigin: true,
      status: "FILLED",
      quantityDecimal: "0.5",
      brokerOrderId: "900",
      reduceOnly: true,
    });
    expect(notifications.sent).toHaveLength(1);
    expect(store.insertedSocialTrades).toHaveLength(1);
    expect(store.insertedSocialTrades[0]).toMatchObject({
      userId: "user-1",
      symbol: "BTC",
      side: "sell",
      assetType: "PERP",
      orderId: "order-1",
    });
    expect(notifications.sent[0]).toMatchObject({
      symbol: "BTC",
      status: "FILLED",
      externalOrigin: true,
      userId: "user-1",
      // The venue's own fill time, so the staleness guard can drop a fill
      // discovered long after it happened rather than announce it as live.
      executedAt: NOW.getTime() + 1_000,
    });
  });

  it("keeps an externally detected opening fill out of follower fan-out", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({
      fills: [hlFill({ dir: "Open Long", side: "buy" })],
    });

    await poller(store.db, info, collectNotifications()).pollOnce();

    expect(store.insertedOrders).toHaveLength(1);
    expect(store.insertedSocialTrades).toHaveLength(0);
  });

  it("keeps a mirrored protection fill out of Discord and follower fan-out", async () => {
    const legId = "copymirror:user-1:source:tpsl:sl:59000";
    const store = fakeDb({
      cursor: { watermark: NOW },
      mirroredProtectionOrders: [
        {
          copySourceLabel: "SOL Decoder",
          perpProtection: { legClientOrderIds: [legId] },
        },
      ],
    });
    const info = fakeInfo({ fills: [hlFill({ cloid: toCloid(legId) })] });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedOrders).toHaveLength(1);
    expect(store.insertedOrders[0]?.copySourceLabel).toBe("SOL Decoder");
    expect(store.insertedSocialTrades).toHaveLength(0);
    expect(notifications.sent).toHaveLength(0);
  });

  it("leaves a fill the app already tracks to the row-driven sync", async () => {
    const store = fakeDb({
      cursor: { watermark: NOW },
      knownOrders: [{ brokerOrderId: "900" }],
    });
    const info = fakeInfo({ fills: [hlFill()] });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedOrders).toHaveLength(0);
    expect(notifications.sent).toHaveLength(0);
  });

  it("does not duplicate an app fill while its broker oid is still null", async () => {
    const clientOrderId = "app-pump-order";
    const store = fakeDb({
      cursor: { watermark: NOW },
      knownOrders: [{ brokerOrderId: null, clientOrderId }],
    });
    const info = fakeInfo({
      fills: [hlFill({ cloid: toCloid(clientOrderId) })],
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedOrders).toHaveLength(0);
    expect(notifications.sent).toHaveLength(0);
  });

  it("names the stop when the order was seen resting on an earlier cycle", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({
      fills: [hlFill()],
      openOrders: [{ oid: 900, tpsl: "sl", isTrigger: true }],
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(notifications.sent[0]?.closeReason).toBe("stop_loss");
  });

  it("says nothing about the reason when it has no evidence of one", async () => {
    // Claiming a stop we cannot evidence is worse than the silence being fixed.
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ fills: [hlFill()], openOrders: [] });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(notifications.sent[0]?.closeReason).toBeNull();
  });

  it("reports a liquidation even with no trigger snapshot", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({
      fills: [hlFill({ dir: "Liquidated Cross Long" })],
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(notifications.sent[0]?.closeReason).toBe("liquidation");
  });

  it("a re-read of the same fill produces no second row and no second ping", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ fills: [hlFill()] });
    const notifications = collectNotifications();
    const instance = poller(store.db, info, notifications);

    await instance.pollOnce();
    // Rewind the cursor by hand to force the same window to be rescanned, the
    // way a crash between the insert and the cursor update would.
    store.cursorUpdates.length = 0;
    await instance.pollOnce();

    expect(store.insertedOrders).toHaveLength(1);
    expect(notifications.sent).toHaveLength(1);
  });
});

describe("HyperliquidExternalFillPoller cursor", () => {
  it("replays a capped timestamp boundary until every close is ingested", async () => {
    const sharedTimestamp = NOW.getTime() + 1_000;
    const fills = Array.from({ length: 51 }, (_, index) =>
      hlFill({
        time: sharedTimestamp,
        oid: 1_000 + index,
        hash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        tid: 5_000 + index,
      }),
    );
    const store = fakeDb({
      cursor: { watermark: new Date(sharedTimestamp - 1) },
    });
    const info = fakeInfo({ fills });
    const notifications = collectNotifications();
    const instance = poller(store.db, info, notifications);

    await instance.pollOnce();

    expect(store.insertedOrders).toHaveLength(50);
    expect(store.insertedSocialTrades).toHaveLength(50);
    expect(notifications.sent).toHaveLength(50);

    await instance.pollOnce();

    expect(store.insertedOrders).toHaveLength(51);
    expect(store.insertedOrders.slice(50).map((order) => order.brokerOrderId))
      .toEqual(["1050"]);
    expect(store.insertedSocialTrades).toHaveLength(51);
    expect(notifications.sent).toHaveLength(51);
    expect(new Set(store.insertedOrders.map((order) => order.clientOrderId)).size)
      .toBe(51);
    expect(store.insertedSocialTrades.map((trade) => trade.orderId))
      .toEqual(store.insertedOrders.map((order) => order.id));
    expect(notifications.sent.map((notification) => notification.orderId))
      .toEqual(store.insertedOrders.map((order) => order.id));

    await instance.pollOnce();

    expect(store.insertedOrders).toHaveLength(51);
    expect(store.insertedSocialTrades).toHaveLength(51);
    expect(notifications.sent).toHaveLength(51);
  });

  it("advances only to the newest fill it actually processed", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const newest = NOW.getTime() + 5_000;
    const info = fakeInfo({
      fills: [
        hlFill({ time: newest, tid: 2, oid: 901 }),
        hlFill({ time: NOW.getTime() + 1_000 }),
      ],
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.cursorUpdates.at(-1)?.watermark).toEqual(new Date(newest));
  });

  it("holds the cursor when the venue read fails, so nothing is skipped", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ failFills: true });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.cursorUpdates).toHaveLength(0);
    expect(store.insertedOrders).toHaveLength(0);
  });

  it("still ingests when only the trigger snapshot fails", async () => {
    // A failed snapshot costs the WORDING of an alert, never the alert itself.
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ fills: [hlFill()], failOpenOrders: true });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(notifications.sent).toHaveLength(1);
    expect(notifications.sent[0]?.closeReason).toBeNull();
  });

  it("still ingests fills when a structured trigger snapshot has incomplete coverage", async () => {
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({
      fills: [hlFill()],
      openOrdersStatus: {
        orders: [],
        complete: false,
        coveredDexes: [""],
        failures: [{ source: "xyz", transient: true }],
      },
    });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(store.insertedOrders).toHaveLength(1);
    expect(store.cursorUpdates.at(-1)?.watermark).toEqual(
      new Date(NOW.getTime() + 1_000),
    );
    expect(notifications.sent).toHaveLength(1);
    expect(notifications.sent[0]?.closeReason).toBeNull();
  });

  it("logs an exhausted transient fill read without reporting it to Sentry", async () => {
    const reports: string[] = [];
    setErrorReporter(({ message }) => reports.push(message));
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({
      fillError: Object.assign(new Error("rate limited"), {
        name: "HttpRequestError",
        response: new Response(null, {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      }),
    });

    await poller(store.db, info, collectNotifications()).pollOnce();

    expect(reports).toHaveLength(0);
    expect(store.cursorUpdates).toHaveLength(0);
  });

  it("keeps non-transient fill failures at error level", async () => {
    const reports: string[] = [];
    setErrorReporter(({ message }) => reports.push(message));
    const store = fakeDb({ cursor: { watermark: NOW } });
    const info = fakeInfo({ fillError: new Error("bad request") });

    await poller(store.db, info, collectNotifications()).pollOnce();

    expect(reports).toHaveLength(1);
  });

  it("one account's failure does not block another's", async () => {
    const store = fakeDb({
      cursor: { watermark: NOW },
      credentials: [
        {
          id: "cred-bad",
          userId: "user-bad",
          accountId: "not-an-address",
          username: null,
        },
        { id: "cred-1", userId: "user-1", accountId: ADDRESS, username: null },
      ],
    });
    const info = fakeInfo({ fills: [hlFill()] });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(notifications.sent).toHaveLength(1);
    expect(notifications.sent[0]?.userId).toBe("user-1");
  });

  it("skips a credential whose stored address is not one", async () => {
    const store = fakeDb({
      cursor: { watermark: NOW },
      credentials: [
        { id: "c", userId: "u", accountId: "0xnope", username: null },
      ],
    });
    const info = fakeInfo({ fills: [hlFill()] });
    const notifications = collectNotifications();

    await poller(store.db, info, notifications).pollOnce();

    expect(info.calls.listFills).toBe(0);
  });
});
