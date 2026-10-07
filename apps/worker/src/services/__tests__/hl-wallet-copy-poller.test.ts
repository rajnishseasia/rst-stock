import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { schema } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { mirrorIdempotencyKey } from "../../../../api/src/lib/copy-mirror";
import type { ExposureHistoryRow, WalletSourceFill } from "../hl-wallet-copy-poller";

const hyperliquidModule = "../../../../api/src/lib/hyperliquid";
const realHyperliquid = await import(hyperliquidModule);
let infoForTest: {
  listFills: (walletAddress: `0x${string}`) => Promise<unknown[]>;
  listPositions: (walletAddress: `0x${string}`) => Promise<unknown[]>;
} = {
  listFills: async () => [],
  listPositions: async () => [],
};

mock.module(hyperliquidModule, () => ({
  ...realHyperliquid,
  createHyperliquidInfoClient: () => infoForTest,
}));

const { CopyMirrorPoller } = await import("../copy-mirror");
const {
  buildWalletMirrorCandidate,
  computeExposureFromRows,
  HlWalletCopyPoller,
  MIRRORED_EXPOSURE_SCAN_LIMIT,
  walletCopyRuntimeEnabled,
} = await import("../hl-wallet-copy-poller");

const wallet = "0x1111111111111111111111111111111111111111";

const WALLET_ENV = [
  "HL_WALLET_COPY_ENABLED",
  "COPY_TRADE_AUTOMIRROR_ENABLED",
  "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED",
  "HYPERLIQUID_SYNC_ENABLED",
  "HYPERLIQUID_NETWORK",
  "HYPERLIQUID_ALLOW_TESTNET",
] as const;
let previousWalletEnv: Partial<Record<(typeof WALLET_ENV)[number], string>>;

beforeEach(() => {
  previousWalletEnv = Object.fromEntries(WALLET_ENV.map((name) => [name, process.env[name]]));
  process.env.HL_WALLET_COPY_ENABLED = "true";
  process.env.COPY_TRADE_AUTOMIRROR_ENABLED = "true";
  process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
  process.env.HYPERLIQUID_SYNC_ENABLED = "true";
  process.env.HYPERLIQUID_NETWORK = "testnet";
  process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
  infoForTest = {
    listFills: async () => [],
    listPositions: async () => [],
  };
});

afterEach(() => {
  for (const name of WALLET_ENV) {
    const value = previousWalletEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function walletDeliveryFixture(input: {
  now: number;
  fills: WalletSourceFill[];
  exposureRows?: ExposureHistoryRow[];
  existingDelivery?: {
    sourceItemId: string;
    status: string;
    nextAttemptAt: number;
  };
}) {
  const events: string[] = [];
  const deliveries: Array<Record<string, any>> = [];
  if (input.existingDelivery) {
    deliveries.push({
      id: "delivery-existing",
      followerUserId: "follower-1",
      sourceItemId: input.existingDelivery.sourceItemId,
      status: input.existingDelivery.status,
      nextAttemptAt: new Date(input.existingDelivery.nextAttemptAt),
      candidate: { sourceItemId: input.existingDelivery.sourceItemId },
    });
  }
  let cursor = {
    followerUserId: "follower-1",
    walletAddress: wallet,
    watermarkMs: input.now - 10 * 60_000,
    watermarkTid: 0,
  };
  const follow = {
    id: "follow-1",
    followerUserId: "follower-1",
    targetType: "hl_wallet",
    targetKey: wallet,
    targetLabel: "Wallet source",
    autoMirror: true,
    credentialId: "00000000-0000-4000-8000-000000000001",
    perpCredentialId: "00000000-0000-4000-8000-000000000001",
    perpAutoMirror: true,
    perpSizingMode: "usd",
    perpSizingValue: "25",
    perpMaxLeverage: 2,
    destinationPolicyInitialized: true,
  };

  const db: any = {
    execute: async () => ({ rows: [{ now: new Date(input.now) }] }),
    select: (selection?: unknown) => {
      let table: unknown;
      const query: any = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where() {
          if (table === schema.copyTradeFollows && selection !== undefined) {
            return Promise.resolve([{ value: 1 }]);
          }
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          if (table === schema.orders) {
            return Promise.resolve(input.exposureRows ?? []);
          }
          return query;
        },
        offset() {
          return Promise.resolve([follow]);
        },
      };
      return query;
    },
    query: {
      users: { findFirst: async () => ({ copyPerpMaxLeverage: 2 }) },
      hlWalletCopyCursors: { findFirst: async () => cursor },
      copyMirrorDeliveries: {
        findFirst: async () => {
          const sourceIds = new Set(input.fills.map((fill) => `hl_wallet:${wallet}:${fill.tid}`));
          return deliveries.find((row) => sourceIds.has(row.sourceItemId));
        },
        findMany: async ({ limit }: { limit: number }) => deliveries
          .filter((row) => row.status === "pending" && row.nextAttemptAt.getTime() <= input.now)
          .slice(0, limit),
      },
    },
    insert: (table: unknown) => ({
      values: (value: Record<string, any> | Array<Record<string, any>>) => {
        const values = Array.isArray(value) ? value : [value];
        const insertRows = async () => {
          if (table === schema.copyMirrorDeliveries) {
            const inserted: Array<Record<string, any>> = [];
            for (const item of values) {
              const exists = deliveries.some((row) =>
                row.followerUserId === item.followerUserId &&
                row.sourceItemId === item.sourceItemId,
              );
              if (exists) continue;
              const row = {
                id: `delivery-${deliveries.length + 1}`,
                status: "pending",
                nextAttemptAt: new Date(input.now),
                ...item,
              };
              deliveries.push(row);
              inserted.push(row);
              events.push(`delivery:${row.status}:${row.sourceItemId}`);
            }
            return inserted;
          }
          return [];
        };
        return {
          onConflictDoNothing: () => Object.assign(insertRows(), {
            returning: async () => (await insertRows()).map(({ id }) => ({ id })),
          }),
          onConflictDoUpdate: ({ set }: { set: Record<string, any> }) => {
            if (table === schema.hlWalletCopyCursors) {
              return (async () => {
                cursor = { ...cursor, ...value as Record<string, any>, ...set };
                events.push("cursor");
              })();
            }
            return {
              returning: async () => {
                const persisted: Array<Record<string, unknown>> = [];
                for (const item of values) {
                  let row = deliveries.find((existing) =>
                    existing.followerUserId === item.followerUserId &&
                    existing.sourceItemId === item.sourceItemId,
                  );
                  if (!row) {
                    const inserted = {
                      id: `delivery-${deliveries.length + 1}`,
                      nextAttemptAt: new Date(input.now),
                      ...item,
                    };
                    deliveries.push(inserted);
                    events.push(`delivery:${inserted.status}:${inserted.sourceItemId}`);
                    persisted.push({
                      followerUserId: inserted.followerUserId,
                      sourceItemId: inserted.sourceItemId,
                    });
                    continue;
                  }
                  if (row.status === "pending" && row.nextAttemptAt.getTime() <= input.now) {
                    Object.assign(row, set, { candidate: item.candidate });
                    events.push(`delivery:${row.status}:${row.sourceItemId}`);
                    persisted.push({
                      followerUserId: row.followerUserId,
                      sourceItemId: row.sourceItemId,
                    });
                  }
                }
                return persisted;
              },
            };
          },
        };
      },
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };

  infoForTest = {
    listFills: async () => input.fills,
    listPositions: async () => [],
  };
  let venueClientCalls = 0;
  const deliveryPoller = new CopyMirrorPoller(db, {
    createPerpClient: async () => {
      venueClientCalls++;
      throw new Error("test fixture never submits a venue order");
    },
  });
  const walletPoller = new HlWalletCopyPoller(
    db,
    (candidates) => deliveryPoller.stageExternalCandidates(candidates),
  );

  return {
    db,
    deliveries,
    events,
    deliveryPoller,
    walletPoller,
    venueClientCalls: () => venueClientCalls,
  };
}

function persistentWalletReplayFixture(now: number) {
  const follow = {
    id: "follow-1",
    followerUserId: "follower-1",
    targetType: "hl_wallet",
    targetKey: wallet,
    targetLabel: "Wallet source",
    autoMirror: true,
    credentialId: "00000000-0000-4000-8000-000000000001",
    perpCredentialId: "00000000-0000-4000-8000-000000000001",
    perpAutoMirror: true,
    perpSizingMode: "usd",
    perpSizingValue: "25",
    perpMaxLeverage: 2,
    destinationPolicyInitialized: true,
  };
  const inbox = {
    cursor: {
      followerUserId: follow.followerUserId,
      walletAddress: wallet,
      watermarkMs: now - 10 * 60_000,
      watermarkTid: 0,
    },
    cursorWriteFailures: 1,
    deliveries: [] as Array<Record<string, any>>,
    deliveryInsertAttempts: 0,
    orders: [] as Array<Record<string, any>>,
    orderLookups: [] as string[],
    lastOrderLookupClientOrderId: "",
    dueReadCalls: 0,
    claimAttempts: 0,
    claimWins: 0,
    venueSubmissions: 0,
  };
  let releaseDueReadBarrier!: () => void;
  const dueReadBarrier = new Promise<void>((resolve) => {
    releaseDueReadBarrier = resolve;
  });
  const dialect = new PgDialect();

  const db: any = {
    execute: async () => ({ rows: [{ now: new Date(now) }] }),
    select: (selection?: unknown) => {
      let table: unknown;
      const query: any = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where() {
          if (table === schema.copyTradeFollows && selection !== undefined) {
            return Promise.resolve([{ value: 1 }]);
          }
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        offset() {
          return Promise.resolve([follow]);
        },
      };
      return query;
    },
    query: {
      users: { findFirst: async () => ({ copyPerpMaxLeverage: 2 }) },
      hlWalletCopyCursors: { findFirst: async () => inbox.cursor },
      copyMirrorDeliveries: {
        findMany: async ({ limit }: { limit: number }) => {
          const snapshot = inbox.deliveries
            .filter((row) => row.status === "pending" && row.nextAttemptAt.getTime() <= now)
            .slice(0, limit)
            .map((row) => ({ ...row, nextAttemptAt: new Date(row.nextAttemptAt) }));
          inbox.dueReadCalls++;
          if (inbox.dueReadCalls <= 2) {
            if (inbox.dueReadCalls === 2) releaseDueReadBarrier();
            await dueReadBarrier;
          }
          return snapshot;
        },
      },
      orders: {
        findFirst: async ({ where }: { where: unknown }) => {
          const params = dialect.sqlToQuery(where as never).params;
          const userId = params[0];
          const clientOrderId = params.find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("copymirror:"),
          );
          if (clientOrderId) inbox.orderLookups.push(clientOrderId);
          inbox.lastOrderLookupClientOrderId = clientOrderId ?? "";
          return inbox.orders.find(
            (row) => row.userId === userId && row.clientOrderId === clientOrderId,
          );
        },
      },
    },
    insert: (table: unknown) => ({
      values: (value: Record<string, any> | Array<Record<string, any>>) => {
        const values = Array.isArray(value) ? value : [value];
        return {
          onConflictDoNothing: async ({ target }: { target?: unknown[] } = {}) => {
            if (table !== schema.copyMirrorDeliveries) return;
            const columns = target ?? [];
            if (
              !columns.includes(schema.copyMirrorDeliveries.followerUserId) ||
              !columns.includes(schema.copyMirrorDeliveries.sourceItemId)
            ) {
              throw new Error("fake inbox requires the production follower/source unique key");
            }
            for (const item of values) {
              inbox.deliveryInsertAttempts++;
              // Model the database's unique index, not application-side replay filtering.
              const existing = inbox.deliveries.find((row) =>
                row.followerUserId === item.followerUserId &&
                row.sourceItemId === item.sourceItemId,
              );
              if (existing) continue;
              inbox.deliveries.push({
                id: `delivery-${inbox.deliveries.length + 1}`,
                status: "pending",
                attempts: 0,
                createdAt: new Date(now),
                updatedAt: new Date(now),
                ...item,
              });
            }
          },
          onConflictDoUpdate: async ({ set }: { set: Record<string, any> }) => {
            if (table !== schema.hlWalletCopyCursors) return;
            if (inbox.cursorWriteFailures > 0) {
              inbox.cursorWriteFailures--;
              throw new Error("simulated cursor write interruption after inbox commit");
            }
            inbox.cursor = { ...inbox.cursor, ...values[0], ...set };
          },
        };
      },
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
    update: (table: unknown) => ({
      set: (set: Record<string, any>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            const params = dialect.sqlToQuery(condition as never).params;
            if (table !== schema.copyMirrorDeliveries) return [];
            const [id, status, observedAt] = params;
            const observedAtMs = observedAt === undefined
              ? undefined
              : observedAt instanceof Date
                ? observedAt.getTime()
                : new Date(String(observedAt)).getTime();
            const row = inbox.deliveries.find((item) =>
              item.id === id && item.status === status &&
              (observedAtMs === undefined || item.nextAttemptAt.getTime() === observedAtMs),
            );
            if (!row) {
              if (set.nextAttemptAt instanceof Date && set.status === undefined) inbox.claimAttempts++;
              return [];
            }
            if (set.nextAttemptAt instanceof Date && set.status === undefined) {
              inbox.claimAttempts++;
              inbox.claimWins++;
            }
            Object.assign(row, set);
            return [{ id: row.id }];
          },
        }),
      }),
    }),
  };

  const fill: WalletSourceFill = {
    coin: "BTC",
    side: "buy",
    dir: "Open Long",
    sz: "0.001",
    time: now - 60_000,
    tid: 501,
  };
  infoForTest = {
    listFills: async () => [fill],
    listPositions: async () => [],
  };
  const makeWalletPoller = (stageExternalCandidates: (rows: any[]) => Promise<void>) =>
    new HlWalletCopyPoller(db, stageExternalCandidates);
  const makeDeliveryPoller = () => {
    const poller = new CopyMirrorPoller(db as never) as any;
    poller.forEachAutoMirrorFollowPage = async () => undefined;
    poller.loadOrCreateCheckpoint = async () => new Date(now - 1_000);
    poller.advanceCheckpoint = async () => undefined;
    poller.pollMirrorSummaries = async () => undefined;
    poller.reportDeferredCloseBacklog = async () => undefined;
    poller.emitUnprotectedPerpBacklog = async () => undefined;
    poller.processPerpCandidate = async (candidate: { followerUserId: string; sourceItemId: string }) => {
      inbox.venueSubmissions++;
      inbox.orders.push({
        userId: candidate.followerUserId,
        clientOrderId: inbox.lastOrderLookupClientOrderId,
        assetType: "PERP",
        reduceOnly: false,
        status: "FILLED",
        perpProtectionStatus: null,
        perpProtection: null,
      });
      return "placed";
    };
    return poller;
  };

  return { db, inbox, fill, makeWalletPoller, makeDeliveryPoller };
}

describe("Hyperliquid wallet-copy source staging", () => {
  test("freezes the source fill and both user-owned leverage caps into a normal delivery", () => {
    expect(
      buildWalletMirrorCandidate({
        followerUserId: "follower-1",
        followId: "follow-1",
        credentialId: "credential-1",
        walletAddress: wallet,
        sizingMode: "usd",
        sizingValue: 10,
        userMaxLeverage: 2,
        followMaxLeverage: 1,
        sourceLeverage: 7,
        sourceVenueNetwork: "mainnet",
        fill: {
          coin: "BTC",
          side: "buy",
          dir: "Open Long",
          sz: "0.001",
          time: Date.parse("2026-08-30T12:00:00.000Z"),
          tid: 42,
        },
      }),
    ).toEqual({
      followerUserId: "follower-1",
      followId: "follow-1",
      credentialId: "credential-1",
      sourceItemId: `hl_wallet:${wallet}:42`,
      sourceEventAt: "2026-08-30T12:00:00.000Z",
      symbol: "BTC",
      side: "buy",
      sizingMode: "usd",
      sizingValue: 10,
      assetType: "PERP",
      sourceQtyDecimal: "0.001",
      perpSide: "long",
      perpLeverage: 7,
      perpUserMaxLeverage: 2,
      perpFollowMaxLeverage: 1,
      perpMarginMode: "cross",
      perpReduceOnly: false,
      sourceVenueNetwork: "mainnet",
      // The durable attribution key is the wallet address, not a mutable UI
      // label, so later source closes can find only this wallet's exposure.
      copySourceLabel: wallet,
    });
  });

  test("a wallet close carries only its attributed mirrored exposure into the shared close path", () => {
    expect(
      buildWalletMirrorCandidate({
        followerUserId: "follower-1",
        followId: "follow-1",
        credentialId: "credential-1",
        walletAddress: wallet,
        sizingMode: "usd",
        sizingValue: 10,
        userMaxLeverage: 2,
        followMaxLeverage: null,
        sourceLeverage: 1,
        sourceVenueNetwork: "mainnet",
        closeContext: {
          mirroredExposureSizeDecimal: "0.0002",
          mirroredExposureClientOrderIds: ["copymirror:follower-1:open"],
        },
        fill: {
          coin: "BTC",
          side: "sell",
          dir: "Close Long",
          sz: "1.5",
          time: Date.parse("2026-08-30T12:01:00.000Z"),
          tid: 43,
        },
      }),
    ).toMatchObject({
      sourceItemId: `hl_wallet:${wallet}:43`,
      side: "sell",
      perpSide: "short",
      perpReduceOnly: true,
      sourceQtyDecimal: "1.5",
      // A source close is conservatively allowed to flatten, but never exceed,
      // only the exposure attributed to this exact followed wallet.
      sourcePositionSizeDecimal: "1.5",
      mirroredExposureSizeDecimal: "0.0002",
      mirroredExposureClientOrderIds: ["copymirror:follower-1:open"],
      copySourceLabel: wallet,
    });
  });

  test("mainnet source staging is inert unless the shared sync and mainnet gates are explicit", () => {
    const base = {
      HL_WALLET_COPY_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_ENABLED: "true",
      COPY_TRADE_AUTOMIRROR_PERPS_ENABLED: "true",
      HYPERLIQUID_SYNC_ENABLED: "true",
      HYPERLIQUID_NETWORK: "mainnet",
    };

    expect(walletCopyRuntimeEnabled(base)).toBe(false);
    expect(
      walletCopyRuntimeEnabled({
        ...base,
        COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true",
      }),
    ).toBe(false);
    expect(
      walletCopyRuntimeEnabled({
        ...base,
        COPY_TRADE_AUTOMIRROR_ALLOW_LIVE: "true",
        COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true",
      }),
    ).toBe(true);
    expect(
      walletCopyRuntimeEnabled({
        ...base,
        HYPERLIQUID_SYNC_ENABLED: "false",
        COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET: "true",
      }),
    ).toBe(false);
  });

  test("remains a read-only source watcher: constructor takes no exchange client", () => {
    // HlWalletCopyPoller only accepts a db handle and a stageCandidates callback.
    // An exchange-client parameter would mean it could sign or submit orders,
    // which is explicitly out of scope for this service.
    const ctor = HlWalletCopyPoller.length;
    expect(ctor).toBe(2);
  });

  test("returns null and skips the close when attributed exposure history exceeds the scan limit", () => {
    // Build MIRRORED_EXPOSURE_SCAN_LIMIT + 1 open-long rows so the guard fires.
    const openRow: ExposureHistoryRow = {
      clientOrderId: "copymirror:test:open",
      direction: "long",
      reduceOnly: false,
      executedSizeDecimal: "0.001",
    };
    const overLimitRows = Array.from({ length: MIRRORED_EXPOSURE_SCAN_LIMIT + 1 }, () => openRow);
    expect(computeExposureFromRows(overLimitRows, "long")).toBeNull();
  });

  test("returns attributed exposure when the scan is within the limit", () => {
    const openRow: ExposureHistoryRow = {
      clientOrderId: "copymirror:test:open",
      direction: "long",
      reduceOnly: false,
      executedSizeDecimal: "0.001",
    };
    const atLimitRows = Array.from({ length: MIRRORED_EXPOSURE_SCAN_LIMIT }, () => openRow);
    const result = computeExposureFromRows(atLimitRows, "long");
    expect(result).not.toBeNull();
    expect(result?.mirroredExposureClientOrderIds).toContain("copymirror:test:open");
  });

  test("durably stages an attributed late close before a newer fill can advance the cursor", async () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const fixture = walletDeliveryFixture({
      now,
      fills: [
        {
          coin: "BTC",
          side: "sell",
          dir: "Close Long",
          sz: "0.001",
          time: now - 6 * 60_000,
          tid: 101,
        },
        {
          coin: "ETH",
          side: "buy",
          dir: "Open Long",
          sz: "0.01",
          time: now - 4 * 60_000,
          tid: 102,
        },
      ],
      exposureRows: [{
        clientOrderId: "copymirror:follower-1:prior-wallet-open",
        direction: "long",
        reduceOnly: false,
        executedSizeDecimal: "0.001",
      }],
    });

    try {
      await fixture.walletPoller.pollOnce();
      const due = await (fixture.deliveryPoller as any).loadDueDeliveries(new Date(now));

      expect(due.map((row: { sourceItemId: string }) => row.sourceItemId)).toEqual([
        `hl_wallet:${wallet}:101`,
        `hl_wallet:${wallet}:102`,
      ]);
      expect(fixture.events.indexOf(`delivery:pending:hl_wallet:${wallet}:101`)).toBeLessThan(
        fixture.events.indexOf("cursor"),
      );
      expect(due[0]?.candidate).toMatchObject({
        perpReduceOnly: true,
        mirroredExposureSizeDecimal: "0.001",
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("records an old wallet open as terminal before cursor advance and keeps it out of due work", async () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const fixture = walletDeliveryFixture({
      now,
      fills: [
        {
          coin: "BTC",
          side: "buy",
          dir: "Open Long",
          sz: "0.001",
          time: now - 6 * 60_000,
          tid: 201,
        },
        {
          coin: "ETH",
          side: "buy",
          dir: "Open Long",
          sz: "0.01",
          time: now - 4 * 60_000,
          tid: 202,
        },
      ],
    });

    try {
      await fixture.walletPoller.pollOnce();
      const terminal = fixture.deliveries.find((row) => row.sourceItemId === `hl_wallet:${wallet}:201`);
      const due = await (fixture.deliveryPoller as any).loadDueDeliveries(new Date(now));

      expect(terminal).toMatchObject({
        status: "completed",
        outcome: "stale-intent",
        candidate: {
          sourceItemId: `hl_wallet:${wallet}:201`,
          sourceEventAt: new Date(now - 6 * 60_000).toISOString(),
          perpReduceOnly: false,
        },
      });
      expect(fixture.events.indexOf(`delivery:completed:hl_wallet:${wallet}:201`)).toBeLessThan(
        fixture.events.indexOf("cursor"),
      );
      expect(due.map((row: { sourceItemId: string }) => row.sourceItemId)).toEqual([
        `hl_wallet:${wallet}:202`,
      ]);
      expect(fixture.venueClientCalls()).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("terminalizes a future wallet open but holds the cursor until venue time catches up", async () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const fixture = walletDeliveryFixture({
      now,
      fills: [{
        coin: "BTC",
        side: "buy",
        dir: "Open Long",
        sz: "0.001",
        time: now + 60_000,
        tid: 301,
      }],
    });

    try {
      await fixture.walletPoller.pollOnce();
      const terminal = fixture.deliveries.find((row) => row.sourceItemId === `hl_wallet:${wallet}:301`);

      expect(terminal).toMatchObject({ status: "completed", outcome: "stale-intent" });
      expect(fixture.events).not.toContain("cursor");
      expect(await (fixture.deliveryPoller as any).loadDueDeliveries(new Date(now))).toEqual([]);
      expect(fixture.venueClientCalls()).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("does not terminalize an old wallet open while another worker holds its delivery claim", async () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const sourceItemId = `hl_wallet:${wallet}:401`;
    const fixture = walletDeliveryFixture({
      now,
      fills: [{
        coin: "BTC",
        side: "buy",
        dir: "Open Long",
        sz: "0.001",
        time: now - 6 * 60_000,
        tid: 401,
      }],
      existingDelivery: {
        sourceItemId,
        status: "pending",
        nextAttemptAt: now + 3 * 60_000,
      },
    });

    try {
      await fixture.walletPoller.pollOnce();

      expect(fixture.deliveries[0]).toMatchObject({ status: "pending", sourceItemId });
      expect(fixture.events).not.toContain("cursor");
      expect(fixture.venueClientCalls()).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("advances the cursor past a liquidation or position-flip fill and still stages the next open", async () => {
    // Regression: before the fix, a fill with dir "Liquidated Long" or
    // "Long > Short" caused buildWalletMirrorCandidate to return null.
    // The loop then broke and held the cursor permanently at that fill,
    // silently stopping all mirroring for every later fill in the wallet.
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const fixture = walletDeliveryFixture({
      now,
      fills: [
        {
          coin: "BTC",
          side: "sell",
          dir: "Liquidated Long",
          sz: "0.001",
          time: now - 8 * 60_000,
          tid: 501,
        },
        {
          coin: "ETH",
          side: "buy",
          dir: "Open Long",
          sz: "0.01",
          time: now - 4 * 60_000,
          tid: 502,
        },
      ],
    });

    try {
      await fixture.walletPoller.pollOnce();
      const due = await (fixture.deliveryPoller as any).loadDueDeliveries(new Date(now));

      // The liquidation fill must not create a delivery (no mirror candidate).
      const liquidationDelivery = fixture.deliveries.find(
        (row) => row.sourceItemId === `hl_wallet:${wallet}:501`,
      );
      expect(liquidationDelivery).toBeUndefined();

      // The cursor must have advanced past both fills (not stalled at the liquidation).
      expect(fixture.events).toContain("cursor");

      // The open that follows the liquidation must be staged and due.
      expect(due.map((row: { sourceItemId: string }) => row.sourceItemId)).toContain(
        `hl_wallet:${wallet}:502`,
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("replays a persisted wallet page through production staging and delivery exactly once", async () => {
    const now = Date.parse("2026-09-12T12:00:00.000Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const fixture = persistentWalletReplayFixture(now);
    const firstStager = new CopyMirrorPoller(fixture.db as never);
    const firstWalletPoller = fixture.makeWalletPoller(
      (candidates) => firstStager.stageExternalCandidates(candidates as never[]),
    );
    const initialWatermarkMs = fixture.inbox.cursor.watermarkMs;

    try {
      await firstWalletPoller.pollOnce();
      expect(fixture.inbox.deliveries).toHaveLength(1);
      expect(fixture.inbox.cursor.watermarkMs).toBe(initialWatermarkMs);

      const replayStager = new CopyMirrorPoller(fixture.db as never);
      const replayWalletPoller = fixture.makeWalletPoller(
        (candidates) => replayStager.stageExternalCandidates(candidates as never[]),
      );
      await replayWalletPoller.pollOnce();

      const sourceItemId = `hl_wallet:${wallet}:${fixture.fill.tid}`;
      expect(fixture.inbox.deliveryInsertAttempts).toBe(2);
      expect(fixture.inbox.deliveries).toHaveLength(1);
      expect(fixture.inbox.deliveries[0]).toMatchObject({
        followerUserId: "follower-1",
        sourceItemId,
        status: "pending",
        candidate: { sourceItemId },
      });
      expect(fixture.inbox.cursor.watermarkMs).toBe(fixture.fill.time);

      const firstWorker = fixture.makeDeliveryPoller();
      const competingWorker = fixture.makeDeliveryPoller();
      await Promise.all([
        (firstWorker as any).poll(),
        (competingWorker as any).poll(),
      ]);

      const expectedClientOrderId = mirrorIdempotencyKey({
        followerUserId: "follower-1",
        sourceItemId,
      });
      expect(fixture.inbox.claimAttempts).toBe(2);
      expect(fixture.inbox.claimWins).toBe(1);
      expect(fixture.inbox.venueSubmissions).toBe(1);
      expect(fixture.inbox.orders).toEqual([{
        userId: "follower-1",
        clientOrderId: expectedClientOrderId,
        assetType: "PERP",
        reduceOnly: false,
        status: "FILLED",
        perpProtectionStatus: null,
        perpProtection: null,
      }]);
      expect(fixture.inbox.deliveries[0]).toMatchObject({
        status: "pending",
        lastError: "Hyperliquid mirror accepted; awaiting a positive fill confirmation",
      });

      const replayOutcome = await (firstWorker as any).processCandidate(
        fixture.inbox.deliveries[0]!.candidate,
        {
          dailyCap: null,
          perpDailyCap: null,
          maxOrderDollars: null,
          liveAllowed: true,
          perpsEnabled: true,
          mainnetAllowed: true,
        },
      );
      expect(replayOutcome).toBe("duplicate");
      expect(fixture.inbox.orderLookups).toEqual([
        expectedClientOrderId,
        expectedClientOrderId,
      ]);
      expect(fixture.inbox.venueSubmissions).toBe(1);
      expect(fixture.inbox.deliveries).toHaveLength(1);
    } finally {
      Date.now = originalNow;
    }
  });
});
