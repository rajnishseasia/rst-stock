/**
 * A mirrored equity EXIT is sized to the POSITION, not to the follow's entry rule.
 *
 * `pct`, `pct_equity` and `usd` all answer one question: "how much would this
 * follow BUY right now". On the way out that question has no meaning. A
 * `usd:900` follow that opened 100 shares at $9 sized its exit at
 * floor(900 / 45) = 20 shares once the stock reached $45, sold 20, and the
 * delivery completed. Nothing regenerates a source close, so the follower kept
 * 80 shares of a position the source is completely out of, with its only exit
 * instruction already spent.
 *
 * The perp path has never had this: `decidePerpReduceOnlyMirror` sizes every
 * non-ratio close from `mirroredExposureSizeDecimal` rather than from the entry
 * rule, so one `sizing_mode` column meant "exit $N worth" on Alpaca and "exit
 * the position" on Hyperliquid. These tests hold the equity path to the perp
 * rule, and cover the other direction too: an exit must never grow past the
 * follower's live long or past what the mirror actually opened.
 *
 * They drive the REAL `processCandidate` with stubbed Alpaca and DB layers, so
 * they exercise the production path rather than a re-implementation of it.
 */

import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { schema } from "@trade-bot/db";
import { PgDialect } from "drizzle-orm/pg-core";

/** The bounded broker-facing id the worker actually submits. */
const brokerIdForCopy = (ownerId: string, logicalId: string) =>
  `rst-copy-${createHash("sha256")
    .update(`copy\0${ownerId}\0${logicalId}`)
    .digest("base64url")
    .slice(0, 32)}`;

const credentialsModule = "../../../../api/src/lib/credentials";
const alpacaShimModule = "../../../../api/src/lib/alpaca";
const alpacaPkgModule = "@trade-bot/alpaca";
// Captured before the mock below replaces the module, so the un-stubbed exports
// keep their real behavior instead of disappearing.
const realAlpaca = await import("@trade-bot/alpaca");

const FOLLOWER = "follower-exit-proportionality";
/** The account the follow points at right now. */
const FOLLOW_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
/** The account that actually received the mirrored open. */
const OPEN_CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const FOLLOW_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_USER_ID = "source-equity-trader";
const SOURCE_CLOSE_ORDER_ID = "source-close-order";
const SOURCE_CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  /** The follower's live position in the symbol, or null for "no position". */
  position: null as Record<string, unknown> | null,
  /** Last trade price the sizing math sees. */
  price: 45,
  placedOrders: [] as Array<Record<string, unknown>>,
  recoveredOrder: null as Record<string, unknown> | null,
  onCreate: undefined as (() => Promise<void>) | undefined,
  accountType: "PAPER",
  accountNumber: "paper-acct-1",
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async (
    _db: unknown,
    _userId: string,
    options: { credentialId?: string },
  ) => ({
    username: "paper-key-id",
    accessToken: "paper-secret-key",
    accountType: stub.accountType,
    accountId: "paper-acct-1",
    credentialId: options?.credentialId ?? "paper-credential",
  }),
}));

mock.module(alpacaShimModule, () => ({
  isPaperAccount: (accountType: string | null | undefined) => accountType !== "LIVE",
}));

mock.module(alpacaPkgModule, () => {
  class AlpacaClient {
    async getAccount() {
      return {
        buying_power: "200000",
        equity: "200000",
        account_number: stub.accountNumber,
      };
    }
    async getLatestTrade() {
      return { Price: stub.price };
    }
    async getLatestOptionQuote() {
      return { latestQuote: { bp: stub.price, ap: stub.price } };
    }
    async getSnapshot() {
      return { LatestTrade: { Price: stub.price } };
    }
    async getAsset(symbol: string) {
      return { symbol, fractionable: false };
    }
    async getPosition() {
      // What the broker actually answers for a symbol the account is flat in:
      // a 404, which fetchLongQty reads as "no long" rather than an outage.
      if (!stub.position) {
        throw Object.assign(new Error("position does not exist"), { status: 404 });
      }
      return stub.position;
    }
    async createOrder(request: Record<string, unknown>) {
      stub.placedOrders.push(request);
      await stub.onCreate?.();
      return { id: `broker-${stub.placedOrders.length}` };
    }
    async getOrders() {
      return [];
    }
    async getOrderByClientId() {
      if (stub.recoveredOrder) return stub.recoveredOrder;
      throw Object.assign(new Error("order not found"), { status: 404 });
    }
  }
  // `mock.module` REPLACES the module, so re-export the names the stub has no
  // reason to fake or copy-mirror.ts fails to link against them.
  return {
    AlpacaClient,
    createBrokerClientOrderId: brokerIdForCopy,
    isAlpacaAmbiguousOrderError: realAlpaca.isAlpacaAmbiguousOrderError,
    resolveTimeInForce: realAlpaca.resolveTimeInForce,
  };
});

const { CopyMirrorPoller } = await import("../copy-mirror");

const guards = {
  dailyCap: 20,
  // Deliberately far above the sizes here: the per-order dollar cap is a
  // separate guard and closes are already exempt from it, so it must never be
  // what decides these cases.
  maxOrderDollars: 1_000_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/** One of the follower's own mirror order rows, as the exposure read sees it. */
function mirrorOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: `order-${Math.random().toString(36).slice(2, 10)}`,
    userId: FOLLOWER,
    symbol: "XYZ",
    assetType: "EQUITY",
    tradeAction: "Buy",
    status: "FILLED",
    quantity: 100,
    executedQuantity: 100,
    clientOrderId: `copymirror:${FOLLOWER}:user:earlier-open`,
    brokerAccountId: "paper-acct-1",
    brokerCredentialId: OPEN_CREDENTIAL_ID,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: new Date("2026-08-01T14:00:00.000Z"),
    ...overrides,
  };
}

function sellCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: FOLLOW_CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:source-close",
    sourceUserId: SOURCE_USER_ID,
    sourceOrderId: SOURCE_CLOSE_ORDER_ID,
    sourceOrderCreatedAt: SOURCE_CLOSE_AT.toISOString(),
    symbol: "XYZ",
    side: "sell" as const,
    // The audit's follow row: $900 per order opened 100 shares at $9.
    sizingMode: "usd" as const,
    sizingValue: 900,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/**
 * A DB whose only mirror history is `history`, and whose insert behaves like a
 * first attempt (no conflict), so `placeMirrorOrder` submits the caller's
 * quantity rather than a stored one.
 *
 * `pending` defaults to empty: nothing is waiting on a paired open, so the
 * close-pairing guard never defers and the outcomes below are the sizing
 * decision alone. A test that needs to exercise the guard passes its own
 * queued rows.
 */
function makePoller(
  history: Array<Record<string, unknown>>,
  pending: Array<Record<string, unknown>> = [],
  options: {
    existing?: Record<string, unknown>;
    sourceOrder?: Record<string, unknown>;
    sourceHistory?: Array<Record<string, unknown>>;
    sourceAttributionOrders?: Array<Record<string, unknown>>;
    socialRows?: Array<Record<string, unknown>>;
    xSignals?: Array<Record<string, unknown>>;
    xDeliveries?: Array<Record<string, unknown>>;
    readSignals?: (query: any) => Promise<unknown[]>;
    insertedRows?: Array<Record<string, unknown>>;
  } = {},
) {
  const sourceOrder = options.sourceOrder ?? {
    id: SOURCE_CLOSE_ORDER_ID,
    userId: SOURCE_USER_ID,
    symbol: "XYZ",
    assetType: "EQUITY",
    tradeAction: "Sell",
    direction: "long",
    status: "FILLED",
    executedQuantity: 100,
    brokerAccountId: "source-account",
    brokerCredentialId: "source-credential",
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: SOURCE_CLOSE_AT,
    executedAt: SOURCE_CLOSE_AT,
  };
  const sourceHistory = options.sourceHistory ?? [{
    id: "source-open-order",
    userId: SOURCE_USER_ID,
    symbol: "XYZ",
    assetType: "EQUITY",
    tradeAction: "Buy",
    direction: "long",
    status: "FILLED",
    executedQuantity: 100,
    brokerAccountId: "source-account",
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: new Date("2026-08-01T13:00:00.000Z"),
    executedAt: new Date("2026-08-01T13:00:00.000Z"),
  }];
  const sourceIds = new Set<string>(["source-close"]);
  for (const row of history) {
    const clientOrderId = typeof row.clientOrderId === "string" ? row.clientOrderId : "";
    const marker = `copymirror:${FOLLOWER}:`;
    if (clientOrderId.startsWith(`${marker}user:`)) {
      sourceIds.add(clientOrderId.slice(`${marker}user:`.length));
    }
  }
  const socialRows = options.socialRows ?? [...sourceIds].map((id) => ({
    id,
    userId: SOURCE_USER_ID,
    symbol: "XYZ",
    assetType: "EQUITY",
    orderId: id === "source-close" ? SOURCE_CLOSE_ORDER_ID : "source-open-order",
  }));
  const sourceOrderRows = [
    sourceOrder,
    ...(options.sourceAttributionOrders ?? sourceHistory).filter((row) => row.id !== sourceOrder.id),
  ];
  const xSignals = options.xSignals ?? [];
  const xDeliveries = options.xDeliveries ?? [];
  let orderFindFirstCalls = 0;
  let orderFindManyCalls = 0;
  const db = {
    query: {
      orders: {
        findFirst: async () => {
          orderFindFirstCalls += 1;
          if (options.existing && orderFindFirstCalls <= 2) return options.existing;
          return orderFindFirstCalls === 1 ? undefined : sourceOrder;
        },
        findMany: async () => {
          orderFindManyCalls += 1;
          if (orderFindManyCalls === 1) return history;
          if (orderFindManyCalls === 2) return sourceOrderRows;
          return sourceHistory;
        },
      },
      socialTrades: { findMany: async () => socialRows },
      userApiCredentials: {
        findFirst: async () => ({ id: FOLLOW_CREDENTIAL_ID, provider: "alpaca" }),
      },
      copyTradeFollows: {
        findFirst: async () => ({
          id: FOLLOW_ID,
          followerUserId: FOLLOWER,
          autoMirror: true,
          credentialId: FOLLOW_CREDENTIAL_ID,
          destinationPolicyInitialized: true,
          stockAutoMirror: true,
          stockCredentialId: FOLLOW_CREDENTIAL_ID,
          stockSizingMode: "usd",
          stockSizingValue: 900,
        }),
      },
      copyMirrorDeliveries: {
        findMany: async (query: { columns?: Record<string, unknown> } = {}) =>
          options.xDeliveries &&
          query.columns &&
          "candidate" in query.columns &&
          !("followerUserId" in query.columns)
            ? xDeliveries
            : pending,
      },
      ...(options.xSignals
        ? { signals: { findMany: options.readSignals ?? (async () => xSignals) } }
        : {}),
    },
    select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (options.existing) return [];
            const row = {
                id: "local-fresh",
                ...values,
                limitPrice: values.limitPrice ?? null,
                status: "PENDING",
                brokerOrderId: null,
              };
            options.insertedRows?.push(row);
            return [row];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => {
        const result = Object.assign(Promise.resolve([{ id: "local-fresh" }]), {
          returning: async () => [{ id: "local-fresh" }],
        });
        return { where: () => result };
      },
    }),
  } as never;
  return new CopyMirrorPoller(db);
}

function run(
  poller: InstanceType<typeof CopyMirrorPoller>,
  candidate: Record<string, unknown>,
) {
  return (poller as any).processCandidate(candidate, guards) as Promise<string>;
}

function resetStub(position: Record<string, unknown> | null, price = 45) {
  stub.position = position;
  stub.price = price;
  stub.placedOrders.length = 0;
  stub.recoveredOrder = null;
  stub.onCreate = undefined;
  stub.accountType = "PAPER";
  stub.accountNumber = "paper-acct-1";
}

function makeLockedOpenPoller(
  lockedFollow: Record<string, unknown> | null | "enabled",
  events: string[],
  existing?: Record<string, unknown>,
  hooks: {
    beforeLock?: () => Promise<void>;
    acquireLock?: () => Promise<() => void>;
    failCommit?: boolean;
  } = {},
) {
  const liveFollow = {
    id: FOLLOW_ID,
    followerUserId: FOLLOWER,
    autoMirror: true,
    credentialId: FOLLOW_CREDENTIAL_ID,
    destinationPolicyInitialized: true,
    stockAutoMirror: true,
    stockCredentialId: FOLLOW_CREDENTIAL_ID,
    stockSizingMode: "usd",
    stockSizingValue: 900,
  };
  let transactionActive = false;
  let followReads = 0;
  let pendingRow: Record<string, unknown> | undefined = existing;
  let releaseLock: (() => void) | undefined;
  const db = {
    query: {
      orders: {
        findFirst: async () => pendingRow,
        findMany: async () => [],
      },
      socialTrades: { findMany: async () => [] },
      userApiCredentials: {
        findFirst: async () => ({
          id: FOLLOW_CREDENTIAL_ID,
          provider: "alpaca",
          accountType: "PAPER",
        }),
      },
      copyTradeFollows: {
        findFirst: async ({ columns }: { columns: Record<string, boolean> }) => {
          followReads += 1;
          const row = transactionActive && lockedFollow !== "enabled" ? lockedFollow : liveFollow;
          return row && Object.fromEntries(Object.keys(columns).map((key) => [key, row[key as keyof typeof row]]));
        },
      },
    },
    select: (projection?: Record<string, unknown>) => {
      let table: unknown;
      const query: any = {
        from: (nextTable: unknown) => {
          table = nextTable;
          return query;
        },
        where: () => query,
        for: async (mode: string) => {
          if (table === schema.users) {
            await hooks.beforeLock?.();
            releaseLock = await hooks.acquireLock?.();
            events.push(`lock:user:${mode}`);
            return [{ id: FOLLOWER }];
          }
          if (table === schema.copyTradeFollows) {
            followReads += 1;
            const row = transactionActive && lockedFollow !== "enabled" ? lockedFollow : liveFollow;
            return row ? [row] : [];
          }
          return [];
        },
        // eslint-disable-next-line unicorn/no-thenable
        then: (resolve: (value: unknown[]) => void, reject: (error: unknown) => void) =>
          Promise.resolve(table === schema.orders ? [{ value: 0 }] : []).then(resolve, reject),
      };
      void projection;
      return query;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (pendingRow) return [];
            pendingRow = {
              id: "pending-open",
              ...values,
              status: "PENDING",
              brokerOrderId: null,
              limitPrice: values.limitPrice ?? null,
            };
            events.push("phase-a:pending");
            return [pendingRow];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const apply = async () => {
            if (pendingRow) Object.assign(pendingRow, values);
            return [{ id: "pending-open" }];
          };
          return { returning: apply,
            // eslint-disable-next-line unicorn/no-thenable
            then: (resolve: any, reject: any) => apply().then(resolve, reject),
          };
        },
      }),
    }),
    transaction: async (callback: (tx: any) => Promise<unknown>) => {
      events.push("transaction:begin");
      const snapshot = pendingRow ? { ...pendingRow } : undefined;
      transactionActive = true;
      try {
        const result = await callback(db);
        if (hooks.failCommit) throw new Error("simulated commit failure");
        events.push("transaction:commit");
        return result;
      } catch (error) {
        pendingRow = snapshot;
        events.push("transaction:rollback");
        throw error;
      } finally {
        transactionActive = false;
        releaseLock?.();
        releaseLock = undefined;
      }
    },
  } as never;
  return { poller: new CopyMirrorPoller(db), getFollowReads: () => followReads,
    getPending: () => pendingRow,
    withdraw: (remove: boolean) => {
      lockedFollow = remove ? null : { ...liveFollow, autoMirror: false, stockAutoMirror: false };
    },
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function policyMutex() {
  let tail = Promise.resolve();
  return async () => {
    const prior = tail;
    const gate = barrier();
    tail = gate.promise;
    await prior;
    return gate.release;
  };
}

/** The mirror opened 100 shares and the follower still holds all of them. */
const MIRRORED_LONG_100 = { side: "long", qty: "100", qty_available: "100" };

function xOptionSignal(
  id: string,
  authorId: string,
  content: string,
  timestamp: string,
  quantity: number,
) {
  return {
    id,
    source: "x",
    sourceAuthorId: authorId,
    symbol: "AAPL",
    content,
    metadata: {
      authorSource: "x",
      sourceAuthorId: authorId,
      canonicalAuthorKey: `source_author:x:${authorId}`,
      authorName: authorId,
      quantity,
    },
    timestamp: new Date(timestamp),
    createdAt: new Date(timestamp),
  };
}

describe("X reconstruction boundaries", () => {
  const candidate = { followerUserId: FOLLOWER, followId: FOLLOW_ID,
    sourceItemId: "x_signal:current", sourceAuthorKey: "source_author:x:author-a",
    symbol: "AAPL", assetType: "OPTION", optionExpiration: "260719",
    optionStrike: 250, optionType: "CALL", tradeAction: "SellToClose" };
  it.each([false, true])("scopes ownership before the bounded history read, saturated=%s", async (saturated) => {
    resetStub({ side: "long", qty: "4", qty_available: "4" }, 2);
    const signals = [
      xOptionSignal("open", "author-a", "BTO $AAPL 250C 7/19/2026", "2026-06-01T14:00:00Z", 4),
      xOptionSignal("current", "author-a", "STC $AAPL 250C 7/19/2026 partial", "2026-06-02T14:00:00Z", 1),
    ];
    const allSignals = [...Array.from({ length: 5001 }, (_, index) =>
      xOptionSignal(`historical-${index}`, saturated ? "author-a" : "unrelated-author",
        "BTO $AAPL 250C 7/19/2026", "2026-05-01T14:00:00Z", 1)), ...signals];
    let reads = 0;
    const poller = makePoller([mirrorOrder({ symbol: "AAPL", assetType: "OPTION",
      tradeAction: "BuyToOpen", quantity: 4, executedQuantity: 4,
      clientOrderId: `copymirror:${FOLLOWER}:x_signal:open`, optionExpiration: "260719",
      optionStrike: "250", optionType: "CALL" })], [], { xSignals: signals, xDeliveries: signals.map(s => ({
      sourceItemId: `x_signal:${s.id}`, candidate: { followId: FOLLOW_ID,
        tradeAction: s.id === "open" ? "BuyToOpen" : "SellToClose" },
    })), readSignals: async (query) => {
      if (++reads === 1) return signals;
      const compiled = new PgDialect().sqlToQuery(query.where);
      expect(compiled.sql).toContain("canonicalAuthorKey");
      expect(compiled.params).toContain("source_author:x:author-a");
      expect(compiled.params).toContain("AAPL");
      expect(query.limit).toBe(5001);
      // Execute the asserted ownership predicate before LIMIT in this DB fake.
      // 5,001 unrelated rows cannot consume the selected author's scan budget.
      return allSignals.filter(signal => compiled.params.includes(signal.metadata.canonicalAuthorKey))
        .slice(0, query.limit);
    } });
    const attempt = run(poller, { ...candidate, credentialId: FOLLOW_CREDENTIAL_ID,
      sourceEventAt: signals[1]!.timestamp.toISOString(), side: "sell", sizingMode: "usd", sizingValue: 900 });
    if (saturated) {
      await expect(attempt).rejects.toMatchObject({ code: "EAGAIN" });
      expect(stub.placedOrders).toHaveLength(0);
    } else {
      expect(await attempt).toBe("placed");
      expect(stub.placedOrders).toHaveLength(1);
      expect(stub.placedOrders[0]?.qty).toBe(1);
    }
  });
  it.each([undefined, true, "", "bogus", "0x10", 0, -1, 1.5])("holds unknown/malformed source units %s without a broker POST", async (quantity) => {
    resetStub({ side: "long", qty: "4", qty_available: "4" }, 2);
    const signals = [
      xOptionSignal("open", "author-a", "BTO $AAPL 250C 7/19/2026", "2026-06-01T14:00:00Z", 4),
      xOptionSignal("current", "author-a", "STC $AAPL 250C 7/19/2026 partial", "2026-06-02T14:00:00Z", 1),
    ];
    Object.assign(signals[1]!.metadata, { quantity });
    const poller = makePoller([mirrorOrder({ symbol: "AAPL", assetType: "OPTION",
      tradeAction: "BuyToOpen", quantity: 4, executedQuantity: 4,
      clientOrderId: `copymirror:${FOLLOWER}:x_signal:open`, optionExpiration: "260719",
      optionStrike: "250", optionType: "CALL" })], [], { xSignals: signals, xDeliveries: signals.map(s => ({
      sourceItemId: `x_signal:${s.id}`, candidate: { followId: FOLLOW_ID,
        tradeAction: s.id === "open" ? "BuyToOpen" : "SellToClose" },
    })) });
    await expect(run(poller, { ...candidate, credentialId: FOLLOW_CREDENTIAL_ID,
      sourceEventAt: signals[1]!.timestamp.toISOString(), side: "sell", sizingMode: "usd", sizingValue: 900,
    })).rejects.toMatchObject({ code: "EAGAIN", message: "equity close held back: source-quantity-unavailable" });
    expect(stub.placedOrders).toHaveLength(0);
  });

  it.each([true, false])("partitions a previous follow lifecycle, old flat=%s", async (flat) => {
    resetStub({ side: "long", qty: flat ? "4" : "10", qty_available: flat ? "4" : "10" }, 2);
    const signals = [
      xOptionSignal("old-open", "author-a", "BTO $AAPL 250C 7/19/2026", "2026-06-01T14:00:00Z", 1),
      ...(flat ? [xOptionSignal("old-close", "author-a", "STC $AAPL 250C 7/19/2026", "2026-06-02T14:00:00Z", 1)] : []),
      xOptionSignal("new-open", "author-a", "BTO $AAPL 250C 7/19/2026", "2026-06-03T14:00:00Z", 1),
      xOptionSignal("current", "author-a", "STC $AAPL 250C 7/19/2026", "2026-06-04T14:00:00Z", 1),
    ];
    const history = signals.filter(s => s.id !== "current").map(signal => mirrorOrder({
      symbol: "AAPL", assetType: "OPTION", tradeAction: signal.content.startsWith("BTO") ? "BuyToOpen" : "SellToClose",
      quantity: signal.id.startsWith("old") ? 6 : 4, executedQuantity: signal.id.startsWith("old") ? 6 : 4,
      clientOrderId: `copymirror:${FOLLOWER}:x_signal:${signal.id}`, optionExpiration: "260719", optionStrike: "250", optionType: "CALL",
    }));
    const poller = makePoller(history, [], { xSignals: signals, xDeliveries: signals.map(s => ({
      sourceItemId: `x_signal:${s.id}`, candidate: { followId: s.id.startsWith("old") ? "old-follow" : FOLLOW_ID,
        tradeAction: s.content.startsWith("BTO") ? "BuyToOpen" : "SellToClose" },
    })) });
    const result = await (poller as any).readXOptionAttribution(candidate, signals.map(s => `x_signal:${s.id}`));
    expect(result.reason).toBeNull();
    expect([...result.attributedSourceItemIds].sort()).toEqual(["x_signal:current", "x_signal:new-open"]);
    expect(result.sourcePositionQty).toBe(flat ? 1 : 2);
    expect(await run(poller, { ...candidate, credentialId: FOLLOW_CREDENTIAL_ID,
      sourceEventAt: signals.at(-1)!.timestamp.toISOString(), side: "sell", sizingMode: "usd", sizingValue: 900,
    })).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]?.qty).toBe(flat ? 4 : 2);
  });

  it.each(["missing-signal", "missing-follow", "conflicting-current-follow"])
    ("holds unresolved lifecycle ownership: %s", async (problem) => {
      resetStub({ side: "long", qty: "4", qty_available: "4" }, 2);
      const signals = [
        xOptionSignal("open", "author-a", "BTO $AAPL 250C 7/19/2026", "2026-06-01T14:00:00Z", 4),
        xOptionSignal("current", "author-a", "STC $AAPL 250C 7/19/2026", "2026-06-02T14:00:00Z", 1),
      ];
      const poller = makePoller([mirrorOrder({ symbol: "AAPL", assetType: "OPTION",
        tradeAction: "BuyToOpen", quantity: 4, executedQuantity: 4,
        clientOrderId: `copymirror:${FOLLOWER}:x_signal:open`, optionExpiration: "260719",
        optionStrike: "250", optionType: "CALL" })], [], {
        xSignals: problem === "missing-signal" ? signals.slice(1) : signals,
        xDeliveries: signals.map(signal => ({ sourceItemId: `x_signal:${signal.id}`, candidate: {
          followId: problem === "missing-follow" && signal.id === "open" ? undefined
            : problem === "conflicting-current-follow" && signal.id === "current" ? "old-follow" : FOLLOW_ID,
          tradeAction: signal.id === "open" ? "BuyToOpen" : "SellToClose",
        } })),
      });
      await expect(run(poller, { ...candidate, credentialId: FOLLOW_CREDENTIAL_ID,
        sourceEventAt: signals[1]!.timestamp.toISOString(), side: "sell", sizingMode: "usd", sizingValue: 900,
      })).rejects.toMatchObject({ code: "EAGAIN" });
      expect(stub.placedOrders).toHaveLength(0);
    });
});

describe("a mirrored equity exit is sized to the mirrored position", () => {
  it.each(["account", "environment"])("does not redirect a prepared OPEN after locked credential %s drift", async (changed) => {
    resetStub(null);
    const events: string[] = [];
    const harness = makeLockedOpenPoller("enabled", events, undefined, { beforeLock: async () => {
      if (changed === "account") stub.accountNumber = "replacement-account";
      else stub.accountType = "LIVE";
    } });
    await expect(run(harness.poller, { followerUserId: FOLLOWER, credentialId: FOLLOW_CREDENTIAL_ID,
      followId: FOLLOW_ID, sourceEventAt: new Date().toISOString(), sourceItemId: "user:destination-drift",
      symbol: "XYZ", side: "buy", sizingMode: "usd", sizingValue: 900, assetType: "EQUITY", tradeAction: "Buy",
    })).rejects.toMatchObject({ code: "EAGAIN" });
    expect(stub.placedOrders).toHaveLength(0);
    expect(harness.getPending()).toMatchObject({ status: "PENDING", brokerAccountId: "paper-acct-1" });
  });

  it("executes BTO, partial STC and full STC with persisted fills and isolated later exposure", async () => {
    resetStub(null, 2);
    const eventAt = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    const signals = [
      xOptionSignal("bto", "author-a", "BTO $AAPL 250C 7/19/2027 4 contracts", eventAt(50), 4),
      xOptionSignal("partial", "author-a", "STC $AAPL 250C 7/19/2027 partial 2 contracts", eventAt(30), 2),
      xOptionSignal("full", "author-a", "STC $AAPL 250C 7/19/2027 full close 2 contracts", eventAt(20), 2),
      xOptionSignal("reentry", "author-a", "BTO $AAPL 250C 7/19/2027 5 contracts", eventAt(10), 5),
      xOptionSignal("other", "author-b", "BTO $AAPL 250C 7/19/2027 3 contracts", eventAt(40), 3),
    ];
    // Exercise explicit counts in the actual source text, without synthetic
    // metadata quantities or any implicit one-post/one-contract conversion.
    for (const signal of signals) delete (signal.metadata as Partial<typeof signal.metadata>).quantity;
    const deliveries = signals.map(signal => ({ sourceItemId: `x_signal:${signal.id}`,
      candidate: { followId: FOLLOW_ID, tradeAction: signal.content.startsWith("BTO") ? "BuyToOpen" : "SellToClose" } }));
    const history: Array<Record<string, unknown>> = [];
    let liveQty = 0;
    for (const [index, signal] of signals.slice(0, 3).entries()) {
      const insertedRows: Array<Record<string, unknown>> = [];
      const closing = index > 0;
      const poller = makePoller(history, [], { xSignals: signals, xDeliveries: deliveries, insertedRows });
      expect(await run(poller, {
        followerUserId: FOLLOWER, credentialId: FOLLOW_CREDENTIAL_ID, followId: FOLLOW_ID,
        sourceEventAt: signal.timestamp.toISOString(),
        sourceItemId: `x_signal:${signal.id}`, sourceAuthorKey: "source_author:x:author-a",
        symbol: "AAPL", side: closing ? "sell" : "buy", sizingMode: "usd", sizingValue: 900,
        assetType: "OPTION", optionExpiration: "270719", optionStrike: 250, optionType: "CALL",
        tradeAction: closing ? "SellToClose" : "BuyToOpen",
      })).toBe("placed");
      expect(stub.placedOrders.at(-1)?.qty).toBe(closing ? 2 : 4);
      // The lightweight insert fake does not enforce the production unique
      // client-order-id constraint, so a fresh OPEN records both the durable
      // pre-transaction reservation and the in-transaction conflict attempt.
      expect(insertedRows).toHaveLength(closing ? 1 : 2);
      // Reconciliation persists the broker's fill before the next delivery.
      const filled = insertedRows[0]!;
      Object.assign(filled, { status: "FILLED", executedQuantity: filled.quantity,
        createdAt: signal.timestamp, brokerOrderId: `filled-${signal.id}` });
      history.push(filled);
      liveQty += (closing ? -1 : 1) * Number(filled.quantity);
      if (index === 0) {
        for (const [id, qty] of [["reentry", 5], ["other", 3]] as const) {
          history.push(mirrorOrder({ symbol: "AAPL", assetType: "OPTION", tradeAction: "BuyToOpen",
            quantity: qty, executedQuantity: qty, clientOrderId: `copymirror:${FOLLOWER}:x_signal:${id}`,
            brokerCredentialId: FOLLOW_CREDENTIAL_ID, optionExpiration: "270719", optionStrike: "250", optionType: "CALL" }));
          liveQty += qty;
        }
      }
      expect(liveQty).toBe([12, 10, 8][index]!);
      stub.position = { side: "long", qty: String(liveQty), qty_available: String(liveQty) };
    }
    expect(history.filter(row => row.tradeAction === "SellToClose").map(row => row.executedQuantity)).toEqual([2, 2]);
    expect(stub.placedOrders.map(order => order.side)).toEqual(["buy", "sell", "sell"]);
  });

  it.each([false, true].flatMap(resume => [false, true].flatMap(remove => [false, true].map(withdrawalFirst => ({ resume, remove, withdrawalFirst })))))
    ("serializes policy withdrawal and submission %j", async ({ resume, remove, withdrawalFirst }) => {
      resetStub(null);
      const candidate = { followerUserId: FOLLOWER, credentialId: FOLLOW_CREDENTIAL_ID,
        followId: FOLLOW_ID, sourceEventAt: new Date().toISOString(), sourceItemId: "user:barrier-open",
        symbol: "XYZ", side: "buy", sizingMode: "usd", sizingValue: 900,
        assetType: "EQUITY", tradeAction: "Buy" };
      const existing = resume ? { id: "pending-open", userId: FOLLOWER, assetType: "EQUITY",
        status: "PENDING", brokerOrderId: null, quantity: 20, limitPrice: null,
        brokerCredentialId: FOLLOW_CREDENTIAL_ID, brokerAccountId: "paper-acct-1",
        clientOrderId: `copymirror:${FOLLOWER}:${candidate.sourceItemId}` } : undefined;
      const events: string[] = [];
      const acquireLock = policyMutex();
      const workerAtLock = barrier();
      const workerMayLock = barrier();
      const brokerEntered = barrier();
      const brokerMayReturn = barrier();
      const harness = makeLockedOpenPoller("enabled", events, existing, {
        acquireLock, beforeLock: async () => {
          workerAtLock.release();
          await workerMayLock.promise;
        },
      });
      stub.onCreate = async () => {
        events.push("broker:entered");
        brokerEntered.release();
        await brokerMayReturn.promise;
        events.push("broker:return");
      };
      const attempt = run(harness.poller, candidate);
      await workerAtLock.promise;
      if (withdrawalFirst) {
        const release = await acquireLock();
        harness.withdraw(remove);
        events.push("withdrawal:commit");
        workerMayLock.release();
        release();
        expect(await attempt).toBe("consent-withdrawn");
        expect(stub.placedOrders).toHaveLength(0);
      } else {
        workerMayLock.release();
        await brokerEntered.promise;
        const writerStarted = barrier();
        const writer = (async () => {
          const pendingLock = acquireLock();
          writerStarted.release();
          const release = await pendingLock;
          harness.withdraw(remove);
          events.push("withdrawal:commit");
          release();
        })();
        await writerStarted.promise;
        expect(events).not.toContain("withdrawal:commit");
        expect(events).not.toContain("transaction:commit");
        brokerMayReturn.release();
        expect(await attempt).toBe("placed");
        await writer;
        expect(events.indexOf("withdrawal:commit")).toBeGreaterThan(events.indexOf("transaction:commit"));
        expect(events.indexOf("transaction:commit")).toBeGreaterThan(events.indexOf("broker:return"));
        expect(stub.placedOrders).toHaveLength(1);
      }
    });

  it.each([false, true])("recovers accepted broker intent without a second POST, ambiguous=%s", async (ambiguous) => {
    resetStub(null);
    const candidate = { followerUserId: FOLLOWER, credentialId: FOLLOW_CREDENTIAL_ID,
      followId: FOLLOW_ID, sourceEventAt: new Date().toISOString(), sourceItemId: "user:rollback-open",
      symbol: "XYZ", side: "buy", sizingMode: "usd", sizingValue: 900,
      assetType: "EQUITY", tradeAction: "Buy" };
    const events: string[] = [];
    const hooks = { failCommit: !ambiguous };
    const harness = makeLockedOpenPoller("enabled", events, undefined, hooks);
    stub.onCreate = async () => {
      expect(harness.getPending()?.status).toBe("PENDING");
      stub.recoveredOrder = { id: "broker-accepted", status: "new", qty: "20", filled_qty: "0" };
      if (ambiguous) throw Object.assign(new Error("response lost"), { code: "ALPACA_AMBIGUOUS_ORDER" });
    };
    if (ambiguous) {
      await expect(run(harness.poller, candidate)).rejects.toMatchObject({ code: "EAGAIN" });
      expect(harness.getPending()?.status).toBe("SYNCING");
    } else {
      await expect(run(harness.poller, candidate)).rejects.toThrow("simulated commit failure");
      expect(harness.getPending()?.status).toBe("PENDING");
      expect(harness.getPending()?.brokerOrderId).toBeNull();
    }
    const logicalId = `copymirror:${FOLLOWER}:${candidate.sourceItemId}`;
    expect(harness.getPending()?.clientOrderId).toBe(logicalId);
    expect(stub.placedOrders[0]?.client_order_id).toBe(brokerIdForCopy(FOLLOWER, logicalId));
    hooks.failCommit = false;
    stub.onCreate = undefined;
    await run(harness.poller, candidate);
    expect(stub.placedOrders).toHaveLength(1);
    expect(harness.getPending()?.brokerOrderId).toBe("broker-accepted");
  });

  it.each([false, true].flatMap(resume => ["EQUITY", "OPTION"].map(assetType => ({ resume, assetType }))))
    ("places a valid projection-aware OPEN %j", async ({ resume, assetType }) => {
    resetStub(null, 2);
    const option = assetType === "OPTION";
    const qty = option ? 4 : 450;
    const candidate = { followerUserId: FOLLOWER, credentialId: FOLLOW_CREDENTIAL_ID,
      followId: FOLLOW_ID, sourceEventAt: new Date().toISOString(), sourceItemId: "user:valid-locked",
      symbol: "XYZ", side: "buy", sizingMode: "usd", sizingValue: 900,
      assetType, tradeAction: option ? "BuyToOpen" : "Buy",
      ...(option ? { optionExpiration: "270719", optionStrike: 250, optionType: "CALL" } : {}) };
    const existing = resume ? { id: "pending-open", userId: FOLLOWER, assetType,
      status: "PENDING", brokerOrderId: null, quantity: qty, limitPrice: option ? "2" : null,
      ...(option ? { optionExpiration: "270719", optionStrike: "250", optionType: "CALL" } : {}),
      brokerCredentialId: FOLLOW_CREDENTIAL_ID, brokerAccountId: "paper-acct-1",
      clientOrderId: `copymirror:${FOLLOWER}:${candidate.sourceItemId}` } : undefined;
    const events: string[] = [];
    const { poller } = makeLockedOpenPoller("enabled", events, existing);
    stub.onCreate = async () => {
      expect(events).toContain("lock:user:update");
      expect(events).not.toContain("transaction:commit");
    };
    expect(await run(poller, candidate)).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]?.qty).toBe(qty);
    expect(events.at(-1)).toBe("transaction:commit");
  });
  it.each([
    {
      label: "Stop",
      lockedFollow: {
        id: FOLLOW_ID,
        followerUserId: FOLLOWER,
        autoMirror: false,
        credentialId: FOLLOW_CREDENTIAL_ID,
        stockAutoMirror: false,
        stockCredentialId: FOLLOW_CREDENTIAL_ID,
      },
    },
    { label: "unfollow", lockedFollow: null },
  ])("holds the user policy lock through a fresh OPEN $label", async ({ lockedFollow }) => {
    resetStub(null, 45);
    const events: string[] = [];
    const { poller, getFollowReads } = makeLockedOpenPoller(
      lockedFollow,
      events,
    );
    const outcome = await run(poller, {
      followerUserId: FOLLOWER,
      credentialId: FOLLOW_CREDENTIAL_ID,
      followId: FOLLOW_ID,
      sourceEventAt: new Date().toISOString(),
      sourceItemId: "user:locked-open",
      symbol: "XYZ",
      side: "buy",
      sizingMode: "usd",
      sizingValue: 900,
      assetType: "EQUITY",
      tradeAction: "Buy",
    });

    expect(outcome).toBe("consent-withdrawn");
    expect(getFollowReads()).toBe(2);
    expect(events).toEqual([
      "phase-a:pending",
      "transaction:begin",
      "lock:user:update",
      "transaction:commit",
    ]);
    expect(stub.placedOrders).toHaveLength(0);
  });

  it.each([
    {
      label: "Stop",
      lockedFollow: {
        id: FOLLOW_ID,
        followerUserId: FOLLOWER,
        autoMirror: false,
        credentialId: FOLLOW_CREDENTIAL_ID,
        stockAutoMirror: false,
        stockCredentialId: FOLLOW_CREDENTIAL_ID,
      },
    },
    { label: "unfollow", lockedFollow: null },
  ])("holds the user policy lock through a resumed OPEN $label", async ({ lockedFollow }) => {
    resetStub(null, 45);
    const events: string[] = [];
    const sourceItemId = `user:locked-resume-${lockedFollow ? "stop" : "unfollow"}`;
    const existing = {
      id: "pending-open",
      status: "PENDING",
      brokerOrderId: null,
      clientOrderId: `copymirror:${FOLLOWER}:${sourceItemId}`,
      quantity: 20,
      limitPrice: null,
      brokerAccountId: "paper-acct-1",
      brokerCredentialId: FOLLOW_CREDENTIAL_ID,
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      copySourceLabel: null,
    };
    const { poller, getFollowReads } = makeLockedOpenPoller(
      lockedFollow,
      events,
      existing,
    );
    const outcome = await run(poller, {
      followerUserId: FOLLOWER,
      credentialId: FOLLOW_CREDENTIAL_ID,
      followId: FOLLOW_ID,
      sourceEventAt: new Date().toISOString(),
      sourceItemId,
      symbol: "XYZ",
      side: "buy",
      sizingMode: "usd",
      sizingValue: 900,
      assetType: "EQUITY",
      tradeAction: "Buy",
    });

    expect(outcome).toBe("consent-withdrawn");
    expect(getFollowReads()).toBe(2);
    expect(events).toEqual([
      "transaction:begin",
      "lock:user:update",
      "transaction:commit",
    ]);
    expect(stub.placedOrders).toHaveLength(0);
  });

  it("attributes one source and applies its partial close proportionally", async () => {
    // A and B both mirrored XYZ into this follower, but A is the source that
    // just closed. A owns 40 copied shares and B owns 60 on another account;
    // A's 25-share close against a 100-share source position is 25%, so only
    // 10 of A's 40 shares may be sold. The old follower+symbol aggregate would
    // have consumed B's exposure too and sent an oversized exit.
    resetStub({ side: "long", qty: "100", qty_available: "100" }, 45);
    const poller = makePoller(
      [
        mirrorOrder({
          quantity: 40,
          executedQuantity: 40,
          clientOrderId: `copymirror:${FOLLOWER}:user:source-a-open`,
          brokerAccountId: "paper-acct-1",
          brokerCredentialId: OPEN_CREDENTIAL_ID,
        }),
        mirrorOrder({
          quantity: 60,
          executedQuantity: 60,
          clientOrderId: `copymirror:${FOLLOWER}:user:source-b-open`,
          brokerAccountId: "paper-acct-1",
          brokerCredentialId: OPEN_CREDENTIAL_ID,
        }),
      ],
      [],
      {
          sourceOrder: {
          id: SOURCE_CLOSE_ORDER_ID,
          userId: SOURCE_USER_ID,
          symbol: "XYZ",
          assetType: "EQUITY",
          tradeAction: "Sell",
          direction: "long",
          status: "FILLED",
          executedQuantity: 25,
          brokerAccountId: "source-account-a",
          brokerCredentialId: "source-credential",
          venue: "alpaca",
          optionExpiration: null,
          optionStrike: null,
          optionType: null,
          createdAt: SOURCE_CLOSE_AT,
          executedAt: SOURCE_CLOSE_AT,
        },
        sourceHistory: [
          {
            id: "source-a-open-order",
            userId: SOURCE_USER_ID,
            symbol: "XYZ",
            assetType: "EQUITY",
            tradeAction: "Buy",
            direction: "long",
            status: "FILLED",
            executedQuantity: 100,
            brokerAccountId: "source-account-a",
            venue: "alpaca",
            optionExpiration: null,
            optionStrike: null,
            optionType: null,
            createdAt: new Date("2026-08-01T13:00:00.000Z"),
            executedAt: new Date("2026-08-01T13:00:00.000Z"),
          },
          {
            id: "source-b-open-order",
            userId: SOURCE_USER_ID,
            symbol: "XYZ",
            assetType: "EQUITY",
            tradeAction: "Buy",
            direction: "long",
            status: "FILLED",
            executedQuantity: 100,
            brokerAccountId: "source-account-b",
            venue: "alpaca",
            optionExpiration: null,
            optionStrike: null,
            optionType: null,
            createdAt: new Date("2026-08-01T13:01:00.000Z"),
            executedAt: new Date("2026-08-01T13:01:00.000Z"),
          },
        ],
        socialRows: [
          { id: "source-close", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: SOURCE_CLOSE_ORDER_ID },
          { id: "source-a-open", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: "source-a-open-order" },
          { id: "source-b-open", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: "source-b-open-order" },
        ],
      },
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 10 });
  });

  it.each([
    { closeQty: 25, resting: false, expected: 10 },
    { closeQty: 100, resting: false, expected: 40 },
    { closeQty: 50, resting: true, expected: 20 },
    { closeQty: 200, resting: true, expected: 80 },
  ])("uses filled exposure for delayed closes %j", async ({ closeQty, resting, expected }) => {
    resetStub({ side: "long", qty: "80", qty_available: "80" }, 45);
    const sourceOpen = {
      id: "source-a-open-order",
      userId: SOURCE_USER_ID,
      symbol: "XYZ",
      assetType: "EQUITY",
      tradeAction: "Buy",
      direction: "long",
      status: "FILLED",
      executedQuantity: 100,
      brokerAccountId: "source-account-a",
      venue: "alpaca",
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      createdAt: new Date("2026-08-01T11:00:00.000Z"),
      executedAt: new Date("2026-08-01T11:00:00.000Z"),
    };
    const sourceReentry = {
      ...sourceOpen,
      id: "source-a-reentry-order",
      executedQuantity: resting ? 100 : 40,
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
      executedAt: new Date(resting ? "2026-08-01T13:00:00.000Z" : "2026-08-01T15:00:00.000Z"),
    };
    const poller = makePoller(
      [
        mirrorOrder({
          quantity: 40,
          executedQuantity: 40,
          clientOrderId: `copymirror:${FOLLOWER}:user:source-a-open`,
          createdAt: new Date("2026-08-01T14:01:00.000Z"),
        }),
        mirrorOrder({
          quantity: 40,
          executedQuantity: 40,
          clientOrderId: `copymirror:${FOLLOWER}:user:source-a-reentry`,
          createdAt: new Date("2026-08-01T15:01:00.000Z"),
        }),
      ],
      [],
      {
        sourceOrder: {
          id: SOURCE_CLOSE_ORDER_ID,
          userId: SOURCE_USER_ID,
          symbol: "XYZ",
          assetType: "EQUITY",
          tradeAction: "Sell",
          direction: "long",
          status: "FILLED",
          executedQuantity: closeQty,
          brokerAccountId: "source-account-a",
          brokerCredentialId: "source-credential",
          venue: "alpaca",
          optionExpiration: null,
          optionStrike: null,
          optionType: null,
          createdAt: resting ? new Date("2026-08-01T12:00:00.000Z") : SOURCE_CLOSE_AT,
          executedAt: SOURCE_CLOSE_AT,
        },
        sourceHistory: resting ? [sourceOpen, sourceReentry] : [sourceOpen],
        sourceAttributionOrders: [sourceOpen, sourceReentry],
        socialRows: [
          { id: "source-close", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: SOURCE_CLOSE_ORDER_ID },
          { id: "source-a-open", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: sourceOpen.id },
          { id: "source-a-reentry", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: sourceReentry.id },
        ],
      },
    );

    const outcome = await run(
      poller,
      sellCandidate({ sourceEventAt: SOURCE_CLOSE_AT.toISOString(),
        sourceOrderCreatedAt: resting ? "2026-08-01T12:00:00.000Z" : SOURCE_CLOSE_AT.toISOString() }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: expected });
  });

  it("attributes an X option close by author and lifecycle, excluding re-entry and other authors", async () => {
    resetStub({ side: "long", qty: "10", qty_available: "10" }, 10);
    const authorA = "author-a";
    const currentEventAt = "2026-06-19T14:00:00.000Z";
    const xSignals = [
      xOptionSignal(
        "a-bto",
        authorA,
        "BTO $AAPL 250C 7/19/2026",
        "2026-06-01T14:00:00.000Z",
        4,
      ),
      xOptionSignal(
        "a-stc-prior",
        authorA,
        "STC $AAPL 250C 7/19/2026 partial",
        "2026-06-10T14:00:00.000Z",
        1,
      ),
      xOptionSignal(
        "a-stc-current",
        authorA,
        "STC $AAPL 250C 7/19/2026 close",
        currentEventAt,
        2,
      ),
      xOptionSignal(
        "a-reentry",
        authorA,
        "BTO $AAPL 250C 7/19/2026 re-entry",
        "2026-06-20T14:00:00.000Z",
        5,
      ),
      xOptionSignal(
        "b-bto",
        "author-b",
        "BTO $AAPL 250C 7/19/2026",
        "2026-06-05T14:00:00.000Z",
        9,
      ),
    ];
    const xDelivery = (sourceId: string, tradeAction: string) => ({
      sourceItemId: `x_signal:${sourceId}`,
      candidate: { followId: FOLLOW_ID, tradeAction },
    });
    const poller = makePoller(
      [
        mirrorOrder({
          symbol: "AAPL",
          assetType: "OPTION",
          tradeAction: "BuyToOpen",
          quantity: 3,
          executedQuantity: 3,
          clientOrderId: `copymirror:${FOLLOWER}:x_signal:a-bto`,
          optionExpiration: "260719",
          optionStrike: "250",
          optionType: "CALL",
        }),
        // This order is after the source close. It must not become part of the
        // delayed close's attributable exposure.
        mirrorOrder({
          symbol: "AAPL",
          assetType: "OPTION",
          tradeAction: "BuyToOpen",
          quantity: 5,
          executedQuantity: 5,
          clientOrderId: `copymirror:${FOLLOWER}:x_signal:a-reentry`,
          optionExpiration: "260719",
          optionStrike: "250",
          optionType: "CALL",
        }),
        // Same contract, but a different immutable source author. It is not A's
        // position and must not make A's close unanswerable.
        mirrorOrder({
          symbol: "AAPL",
          assetType: "OPTION",
          tradeAction: "BuyToOpen",
          quantity: 9,
          executedQuantity: 9,
          clientOrderId: `copymirror:${FOLLOWER}:x_signal:b-bto`,
          optionExpiration: "260719",
          optionStrike: "250",
          optionType: "CALL",
        }),
      ],
      [],
      {
        xSignals,
        xDeliveries: [
          xDelivery("a-bto", "BuyToOpen"),
          xDelivery("a-stc-prior", "SellToClose"),
          xDelivery("a-stc-current", "SellToClose"),
          xDelivery("a-reentry", "BuyToOpen"),
          xDelivery("b-bto", "BuyToOpen"),
        ],
      },
    );

    const outcome = await run(poller, {
      followerUserId: FOLLOWER,
      credentialId: FOLLOW_CREDENTIAL_ID,
      followId: FOLLOW_ID,
      sourceEventAt: currentEventAt,
      sourceItemId: "x_signal:a-stc-current",
      sourceAuthorKey: "source_author:x:author-a",
      symbol: "AAPL",
      side: "sell",
      sizingMode: "usd",
      sizingValue: 900,
      assetType: "OPTION",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
      tradeAction: "SellToClose",
    });

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({
      symbol: "AAPL260719C00250000",
      side: "sell",
      qty: 2,
    });
  });

  it("reconstructs a second partial close chronologically through processCandidate", async () => {
    resetStub({ side: "long", qty: "40", qty_available: "40" }, 45);
    const poller = makePoller(
      [
        mirrorOrder({
          quantity: 40,
          executedQuantity: 40,
          clientOrderId: `copymirror:${FOLLOWER}:user:source-a-open`,
          brokerAccountId: "paper-acct-1",
        }),
      ],
      [],
      {
        sourceOrder: {
          id: SOURCE_CLOSE_ORDER_ID,
          userId: SOURCE_USER_ID,
          symbol: "XYZ",
          assetType: "EQUITY",
          tradeAction: "Sell",
          direction: "long",
          status: "FILLED",
          executedQuantity: 25,
          brokerAccountId: "source-account",
          brokerCredentialId: "source-credential",
          venue: "alpaca",
          optionExpiration: null,
          optionStrike: null,
          optionType: null,
          createdAt: SOURCE_CLOSE_AT,
          executedAt: SOURCE_CLOSE_AT,
        },
        // Deliberately newest-first, matching the old failure mode. The
        // source was long 100, sold 25, and now sells another 25: the follower
        // owes 40 * (25 / 75) = 13.333333 shares.
        sourceHistory: [
          {
            id: "source-prior-close-order",
            userId: SOURCE_USER_ID,
            symbol: "XYZ",
            assetType: "EQUITY",
            tradeAction: "Sell",
            direction: "long",
            status: "FILLED",
            executedQuantity: 25,
            brokerAccountId: "source-account",
            venue: "alpaca",
            optionExpiration: null,
            optionStrike: null,
            optionType: null,
            createdAt: new Date("2026-08-01T13:30:00.000Z"),
            executedAt: new Date("2026-08-01T13:30:00.000Z"),
          },
          {
            id: "source-open-order",
            userId: SOURCE_USER_ID,
            symbol: "XYZ",
            assetType: "EQUITY",
            tradeAction: "Buy",
            direction: "long",
            status: "FILLED",
            executedQuantity: 100,
            brokerAccountId: "source-account",
            venue: "alpaca",
            optionExpiration: null,
            optionStrike: null,
            optionType: null,
            createdAt: new Date("2026-08-01T13:00:00.000Z"),
            executedAt: new Date("2026-08-01T13:00:00.000Z"),
          },
        ],
        socialRows: [
          { id: "source-close", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: SOURCE_CLOSE_ORDER_ID },
          { id: "source-a-open", userId: SOURCE_USER_ID, symbol: "XYZ", assetType: "EQUITY", orderId: "source-open-order" },
        ],
      },
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 13.333333 });
  });

  it("recovers legacy close metadata from canonical source history", async () => {
    resetStub({ side: "long", qty: "100", qty_available: "100" }, 45);
    const candidate = sellCandidate({
      sourceUserId: undefined,
      sourceOrderCreatedAt: undefined,
    });
    const poller = makePoller([mirrorOrder()]);

    await expect(run(poller, candidate)).resolves.toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({
      symbol: "XYZ",
      side: "sell",
      qty: 100,
    });
    expect(candidate).toMatchObject({
      sourceItemId: "user:source-close",
      sourceOrderId: SOURCE_CLOSE_ORDER_ID,
      credentialId: FOLLOW_CREDENTIAL_ID,
    });
    expect(candidate.sourceUserId).toBeUndefined();
    expect(candidate.sourceOrderCreatedAt).toBeUndefined();
  });

  it("holds a close when supplied source timing conflicts with the source order", async () => {
    resetStub({ side: "long", qty: "100", qty_available: "100" }, 45);
    const poller = makePoller([mirrorOrder()]);
    const candidate = sellCandidate({
      sourceOrderCreatedAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
    });

    await expect(run(poller, candidate)).rejects.toThrow(/source-attribution-unavailable/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("holds an attributed close when the source identity cannot be joined", async () => {
    resetStub({ side: "long", qty: "40", qty_available: "40" }, 45);
    const poller = makePoller([mirrorOrder({ quantity: 40, executedQuantity: 40 })], [], {
      socialRows: [],
    });

    await expect(run(poller, sellCandidate())).rejects.toThrow(/source-attribution-unavailable/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("exits the whole mirrored position when a usd rule would sell only part of it", async () => {
    // The audit's scenario, exactly. usd:900 opened 100 shares at $9; XYZ is now
    // $45, so the entry rule sizes the exit at floor(900 / 45) = 20 shares. The
    // source is completely out, and the delivery completes on whatever this
    // returns, so anything short of 100 strands the follower in 80 shares with
    // no exit instruction left.
    resetStub(MIRRORED_LONG_100, 45);
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "XYZ", side: "sell", qty: 100 });
  });

  it("exits the whole mirrored position under a pct-of-buying-power rule", async () => {
    // 0.5% of $200,000 buying power is $1,000, i.e. 22 shares at $45. Percent of
    // an account balance is an entry rule for the same reason a dollar amount
    // is: it describes new exposure, not the size of the one being closed.
    resetStub(MIRRORED_LONG_100, 45);
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(
      poller,
      sellCandidate({ sizingMode: "pct", sizingValue: 0.5 }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 100 });
  });

  it("places an exit the entry rule sizes to zero whole shares", async () => {
    // Same defect, harsher ending: at $950 a share the $900 rule buys nothing,
    // `decideMirror` skips with no-qty and the close is held back on every
    // attempt until the delivery is abandoned. The mirrored exposure says
    // exactly how many shares to sell, and it does not depend on the price at
    // all.
    resetStub(MIRRORED_LONG_100, 950);
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 100 });
  });

  it("keeps ratio mode sized from the source's own quantity", async () => {
    // Ratio is the one entry rule that is already an answer about the SOURCE's
    // action rather than about the follower's account, and the perp path
    // exempts it for that reason. 0.5 x 40 source shares is 20, and it must
    // stay 20 even though the mirror holds 100.
    resetStub(MIRRORED_LONG_100, 45);
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(
      poller,
      sellCandidate({ sizingMode: "ratio", sizingValue: 0.5, sourceQty: 40 }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 20 });
  });

  it("reconciles an ambiguous Alpaca SYNCING row through processCandidate", async () => {
    resetStub(null, 45);
    const sourceItemId = "user:sync-open";
    const clientOrderId = `copymirror:${FOLLOWER}:${sourceItemId}`;
    const existing = {
      id: "syncing-local-order",
      userId: FOLLOWER,
      clientOrderId,
      assetType: "EQUITY",
      status: "SYNCING",
      brokerOrderId: null,
      quantity: 20,
      executedQuantity: null,
      brokerAccountId: "paper-acct-1",
      brokerCredentialId: FOLLOW_CREDENTIAL_ID,
      tradeAction: "Buy",
      direction: "long",
      limitPrice: null,
      optionExpiration: null,
      optionStrike: null,
      optionType: null,
      copySourceLabel: null,
    };
    const poller = makePoller([], [], { existing });

    const outcome = await run(
      poller,
      sellCandidate({
        sourceItemId,
        side: "buy" as const,
        tradeAction: "Buy" as const,
        sizingMode: "usd" as const,
        sizingValue: 900,
      }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
  });

  it("recovers a broker-accepted SYNCING row through processCandidate without reposting", async () => {
    resetStub(null, 45);
    const sourceItemId = "user:sync-open-recovered";
    const clientOrderId = `copymirror:${FOLLOWER}:${sourceItemId}`;
    stub.recoveredOrder = {
      id: "broker-recovered",
      client_order_id: "rst-copy-recovered",
    };
    const poller = makePoller([], [], {
      existing: {
        id: "syncing-local-order-recovered",
        userId: FOLLOWER,
        clientOrderId,
        assetType: "EQUITY",
        status: "SYNCING",
        brokerOrderId: null,
        quantity: 20,
        executedQuantity: null,
        brokerAccountId: "paper-acct-1",
        brokerCredentialId: FOLLOW_CREDENTIAL_ID,
        tradeAction: "Buy",
        direction: "long",
        limitPrice: null,
        optionExpiration: null,
        optionStrike: null,
        optionType: null,
        copySourceLabel: null,
      },
    });

    const outcome = await run(
      poller,
      sellCandidate({
        sourceItemId,
        side: "buy" as const,
        tradeAction: "Buy" as const,
      }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toEqual([]);
  });
});

describe("sizing an exit to the position does not widen either clamp", () => {
  it("never sells more than the follower actually holds", async () => {
    // The mirror opened 100 but the follower has since sold 40 by hand. Selling
    // the attributable 100 into a 60-share long would open a 40-share naked
    // short, which is the risk `decideSellMirrorQty` exists to refuse.
    resetStub({ side: "long", qty: "60", qty_available: "60" }, 45);
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 60 });
  });

  it("still refuses a symbol the mirror never opened for this follower", async () => {
    // 500 hand-bought shares and no mirrored open: there is no position of ours
    // to size an exit to, and the follower's own shares are not ours to sell.
    resetStub({ side: "long", qty: "500", qty_available: "500" }, 45);
    const poller = makePoller([]);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("no-mirrored-exposure");
    expect(stub.placedOrders).toEqual([]);
  });
});

describe("a close whose entry rule sizes to zero is terminal when nothing is mirrored", () => {
  it("treats a no-qty skip as no-mirrored-exposure, not an unusable-price retry, when nothing was ever mirrored", async () => {
    // At $10,000 a share the $900 rule buys zero whole shares, so `decideMirror`
    // returns skip/no-qty before the exposure-sized exit logic below it even
    // runs. With NO mirror history at all (`makePoller([])`) there is
    // genuinely nothing to exit, so the correct terminal reading is the same
    // `no-mirrored-exposure` the attribution branch reaches for the identical
    // question elsewhere in this file. The defect this pins threw EAGAIN
    // ("no usable price to size the exit from") unconditionally instead, which
    // is factually wrong here (the price was perfectly readable) and, because
    // a close is exempt from the delivery attempt ceiling, retried every 15
    // minutes forever re-deriving the identical zero.
    resetStub(null, 10_000);
    const poller = makePoller([]);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("no-mirrored-exposure");
    expect(stub.placedOrders).toEqual([]);
  });

  it("still holds (does not consume) when a paired open for the same symbol is still queued", async () => {
    // Same zero-qty close, but this time the mirror's own BUY is still sitting
    // in the delivery queue (a transient failure requeued it in an earlier
    // cycle). Consuming this close now would be exactly the failure
    // `copy-mirror-close-pairing.ts` exists to prevent: the buy could still
    // create the very exposure this close is meant to reduce.
    resetStub(null, 10_000);
    const poller = makePoller([], [
      {
        sourceItemId: "user:paired-open",
        followerUserId: FOLLOWER,
        candidate: {
          sourceItemId: "user:paired-open",
          followerUserId: FOLLOWER,
          symbol: "XYZ",
          side: "buy",
          assetType: "EQUITY",
          sourceEventAt: "2026-08-01T13:59:00.000Z",
        },
      },
    ]);

    await expect(run(poller, sellCandidate())).rejects.toThrow(/equity close held back/i);
    expect(stub.placedOrders).toEqual([]);
  });
});
