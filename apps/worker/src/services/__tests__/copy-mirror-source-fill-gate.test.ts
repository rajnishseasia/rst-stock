/**
 * A mirrored OPEN copies a FILL, not a submission.
 *
 * `social_trades` is written the instant Alpaca ACCEPTS the source order (the
 * orders router publishes immediately after it persists the broker acceptance),
 * and nothing in this repo ever retracts one. So a resting limit the source
 * never expects to hit, an order the venue later rejects, and a real fill are
 * all the same row to equity/option discovery; perps remain fill-gated because
 * their execution path has no source-order re-read.
 *
 * That matters because a mirror is submitted as a MARKET order. A source who
 * posts a bid 8% below the market to see if anyone hits it hands every armed
 * follower a live market buy at the CURRENT price, i.e. a position at a price
 * the source deliberately refused to pay, from a trade the source never made.
 * The perp half of the same feed is fill-gated already (`shouldPublishFill` in
 * hyperliquid-order-sync only publishes an executed delta), so this was an
 * equity/option-only asymmetry.
 *
 * The gate lives at EXECUTION time rather than at discovery on purpose.
 * OrderSyncPoller runs on the same 30s cadence as this poller, so a market order
 * that has already filled at the venue can still read SUBMITTED when the
 * delivery is staged; refusing at discovery would drop most legitimate mirrors,
 * and discovery is one-shot (`stageWindow` advances the checkpoint either way).
 * A source order still working is therefore DEFERRED and re-read on the next
 * attempt, and the existing 15-minute intent-age bound is what eventually
 * retires an entry whose source never trades.
 *
 * A CLOSE is deliberately NOT gated, for the same reason it is already exempt
 * from the consent gate, the staleness bound and the delivery attempt ceiling.
 *
 * These drive the REAL `processCandidate` with stubbed Alpaca and DB layers, so
 * they exercise the production path rather than a re-implementation of it.
 */

import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPagedMirrorDb } from "./helpers/paged-mirror-db";

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

const FOLLOWER = "follower-fill-gate";
const CREDENTIAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const FOLLOW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
/** The SOURCE trader's order row behind the published social trade. */
const SOURCE_ORDER_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const SOURCE_USER_ID = "source-fill-gate-user";
const SOURCE_CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");
const SOURCE_OPEN_ORDER_ID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
/** The Alpaca account that received the mirrored open, for the close case. */
const OPEN_ACCOUNT_ID = "paper-acct-1";
const SOURCE_ACCOUNT_ID = "source-alpaca-account";

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  position: null as Record<string, unknown> | null,
  placedOrders: [] as Array<Record<string, unknown>>,
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async () => ({
    username: "paper-key-id",
    accessToken: "paper-secret-key",
    accountType: "PAPER",
    accountId: OPEN_ACCOUNT_ID,
    credentialId: CREDENTIAL_ID,
  }),
}));

mock.module(alpacaShimModule, () => ({
  isPaperAccount: (accountType: string | null | undefined) => accountType !== "LIVE",
}));

mock.module(alpacaPkgModule, () => {
  class AlpacaClient {
    async getAccount() {
      return { buying_power: "200000", equity: "200000", account_number: "paper-acct-1" };
    }
    async getLatestTrade() {
      return { Price: 100 };
    }
    async getSnapshot() {
      return { LatestTrade: { Price: 100 } };
    }
    async getLatestOptionQuote() {
      return { latestQuote: { bp: 3.25, ap: 3.35 } };
    }
    async getAsset(symbol: string) {
      return { symbol, fractionable: false };
    }
    async getPosition() {
      if (!stub.position) {
        throw Object.assign(new Error("position does not exist"), { status: 404 });
      }
      return stub.position;
    }
    async createOrder(request: Record<string, unknown>) {
      stub.placedOrders.push(request);
      return { id: `broker-${stub.placedOrders.length}` };
    }
    async getOrders() {
      return [];
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
const { findMirrorCandidateSources } = await import("../copy-mirror-candidate-sources");
const { traderKey } = await import("../../../../api/src/lib/trader-identity");

const guards = {
  dailyCap: 20,
  maxOrderDollars: 1_000_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/** The SOURCE trader's order, in whichever state this test is about. */
function sourceOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ORDER_ID,
    status: "FILLED",
    executedQuantity: 500,
    ...overrides,
  };
}

/** Source identities used by the close attribution proof. */
function sourceIdentityOrder(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    userId: SOURCE_USER_ID,
    symbol: "TSLA",
    assetType: "EQUITY",
    brokerAccountId: SOURCE_ACCOUNT_ID,
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: id === SOURCE_ORDER_ID
      ? SOURCE_CLOSE_AT
      : new Date("2026-08-01T13:00:00.000Z"),
    executedAt: id === SOURCE_ORDER_ID
      ? null
      : new Date("2026-08-01T13:00:00.000Z"),
    ...overrides,
  };
}

/** A mirrored open on the follower's account, for the CLOSE case only. */
function mirrorOpen() {
  return {
    id: "order-open-1",
    userId: FOLLOWER,
    symbol: "TSLA",
    assetType: "EQUITY",
    tradeAction: "Buy",
    status: "FILLED",
    quantity: 40,
    executedQuantity: 40,
    clientOrderId: `copymirror:${FOLLOWER}:user:earlier-open`,
    brokerAccountId: OPEN_ACCOUNT_ID,
    brokerCredentialId: CREDENTIAL_ID,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: new Date("2026-08-01T14:00:00.000Z"),
  };
}

function buyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:source-open",
    sourceOrderId: SOURCE_ORDER_ID,
    symbol: "TSLA",
    side: "buy" as const,
    sizingMode: "usd" as const,
    sizingValue: 5_000,
    assetType: "EQUITY" as const,
    tradeAction: "Buy" as const,
    ...overrides,
  };
}

/**
 * A db that answers the SOURCE order lookup and nothing else.
 *
 * The dedupe lookup and the source lookup both go through
 * `db.query.orders.findFirst`, so they are told apart by rendering the real
 * predicate through drizzle: the source read is by primary key and carries the
 * source order's uuid as its only parameter, while the dedupe read is by
 * (user_id, client_order_id) and must keep answering "nothing mirrored yet".
 */
function makePoller(
  source: Record<string, unknown> | undefined,
  history: Array<Record<string, unknown>> = [],
  options: {
    sourceOrderIdentities?: Array<Record<string, unknown>>;
    socialRows?: Array<Record<string, unknown>>;
  } = {},
) {
  const dialect = new PgDialect();
  let orderFindManyCalls = 0;
  const db = {
    query: {
      orders: {
        findFirst: async (args: { where: SQL }) => {
          const rendered = dialect.sqlToQuery(args.where);
          if (rendered.params.includes(SOURCE_ORDER_ID)) return source;
          return undefined;
        },
        findMany: async () => {
          orderFindManyCalls += 1;
          return orderFindManyCalls === 1
            ? history
            : options.sourceOrderIdentities ?? [];
        },
      },
      socialTrades: {
        findMany: async () => options.socialRows ?? [],
      },
      userApiCredentials: {
        findFirst: async () => ({ id: CREDENTIAL_ID, provider: "alpaca" }),
        findMany: async () => [{ id: CREDENTIAL_ID, provider: "alpaca", accountId: OPEN_ACCOUNT_ID }],
      },
      copyTradeFollows: {
        findFirst: async () => ({
          id: FOLLOW_ID,
          followerUserId: FOLLOWER,
          autoMirror: true,
          credentialId: CREDENTIAL_ID,
          destinationPolicyInitialized: true,
          stockAutoMirror: true,
          stockCredentialId: CREDENTIAL_ID,
          stockSizingMode: "usd",
          stockSizingValue: "5000",
          perpAutoMirror: false,
          perpCredentialId: null,
          perpSizingMode: "pct",
          perpSizingValue: "5",
        }),
      },
      // Empty: no paired open is still queued, so the close-pairing guard has
      // nothing to defer on and the outcome under test is the only one.
      copyMirrorDeliveries: {
        findMany: async () => [],
      },
    },
    select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => [
            {
              id: "local-fresh",
              ...values,
              limitPrice: values.limitPrice ?? null,
              status: "PENDING",
              brokerOrderId: null,
            },
          ],
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

function resetStub(position: Record<string, unknown> | null) {
  stub.position = position;
  stub.placedOrders.length = 0;
}

describe("a mirrored equity OPEN requires the source order to have traded", () => {
  it("defers the open while the source order is still resting unfilled", async () => {
    // The audit's scenario: a BUY limit for 500 TSLA parked 8% below the market
    // as a bid the source does not expect to hit. Alpaca accepted it, so the
    // social row exists, but nothing has traded. Deferred rather than refused,
    // because a market order that HAS filled can still read SUBMITTED here.
    resetStub(null);
    const poller = makePoller(sourceOrder({ status: "SUBMITTED", executedQuantity: 0 }));

    await expect(run(poller, buyCandidate())).rejects.toThrow(/has not traded/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("refuses the open once the source order is cancelled with nothing filled", async () => {
    // An hour later the source cancels the unfilled bid. Nothing corrects the
    // feed row, so the only thing that can stop the mirror is this read.
    resetStub(null);
    const poller = makePoller(sourceOrder({ status: "CANCELLED", executedQuantity: 0 }));

    expect(await run(poller, buyCandidate())).toBe("source-unfilled");
    expect(stub.placedOrders).toEqual([]);
  });

  it("refuses the open when the source order was rejected outright", async () => {
    resetStub(null);
    const poller = makePoller(sourceOrder({ status: "REJECTED", executedQuantity: null }));

    expect(await run(poller, buyCandidate())).toBe("source-unfilled");
    expect(stub.placedOrders).toEqual([]);
  });

  it("places the open once the source order has filled", async () => {
    // The ordinary case, and the one that must not regress: a real source fill
    // still mirrors on the very next attempt.
    resetStub(null);
    const poller = makePoller(sourceOrder());

    expect(await run(poller, buyCandidate())).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "TSLA", side: "buy" });
  });

  it("places the open when the source order filled only partially", async () => {
    // A partial fill is a trade the source really made, so it is copied. Note
    // the cancelled-after-partial shape too: a terminal status with an executed
    // quantity behind it is an execution, not a non-event.
    resetStub(null);
    const poller = makePoller(sourceOrder({ status: "CANCELLED", executedQuantity: 120 }));

    expect(await run(poller, buyCandidate())).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "TSLA", side: "buy" });
  });

  it("sizes ratio mode from the current executed fill, not the accepted order quantity", async () => {
    resetStub(null);
    const poller = makePoller(sourceOrder({ status: "PARTIAL", executedQuantity: 120 }));

    expect(
      await run(
        poller,
        buyCandidate({
          sizingMode: "ratio" as const,
          sizingValue: 1,
          sourceQty: 500,
        }),
      ),
    ).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "TSLA", side: "buy", qty: 120 });
  });

  it("mirrors a legacy social row that has no joined source order", async () => {
    // Discovery's join is a leftJoin and legacy rows predate it, so a candidate
    // with no source order id has always mirrored. This gate exists to stop a
    // phantom trade, not to become a second way for a real one to be dropped.
    resetStub(null);
    const poller = makePoller(undefined);

    expect(await run(poller, buyCandidate({ sourceOrderId: undefined }))).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "TSLA", side: "buy" });
  });

  it("holds even a ratio CLOSE when its source execution cutoff is unknown", async () => {
    // A submitted close cannot prove which source fills belong to this exit.
    // Live long and ratio sizing do not replace that authoritative boundary.
    resetStub({ side: "long", qty: "40", qty_available: "40" });
    const poller = makePoller(
      sourceOrder({ status: "SUBMITTED", executedQuantity: 0 }),
      [mirrorOpen()],
      {
        sourceOrderIdentities: [
          sourceIdentityOrder(SOURCE_ORDER_ID),
          sourceIdentityOrder(SOURCE_OPEN_ORDER_ID),
        ],
        socialRows: [
          {
            id: "source-close",
            userId: SOURCE_USER_ID,
            symbol: "TSLA",
            assetType: "EQUITY",
            orderId: SOURCE_ORDER_ID,
          },
          {
            id: "earlier-open",
            userId: SOURCE_USER_ID,
            symbol: "TSLA",
            assetType: "EQUITY",
            orderId: SOURCE_OPEN_ORDER_ID,
          },
        ],
      },
    );

    await expect(run(
      poller,
      buyCandidate({
        sourceItemId: "user:source-close",
        sourceUserId: SOURCE_USER_ID,
        sourceOrderCreatedAt: SOURCE_CLOSE_AT.toISOString(),
        sourceQty: 40,
        side: "sell" as const,
        sizingMode: "ratio" as const,
        sizingValue: 1,
        tradeAction: "Sell" as const,
      }),
    )).rejects.toMatchObject({ code: "EAGAIN" });
    expect(stub.placedOrders).toHaveLength(0);
  });
});

/**
 * The wiring the gate above rests on. The status the gate reads lives on the
 * joined order and keeps moving after the delivery is staged, so the candidate
 * carries the order's ID rather than a frozen copy of its state; without that id
 * the gate has nothing to re-read and every open mirrors as before.
 */
describe("equity discovery carries the source order id", () => {
  const SOURCE_USER = "source-trader-1";

  const WINDOW_START = new Date("2026-08-19T14:00:00.000Z");
  const WINDOW_END = new Date("2026-08-19T14:00:30.000Z");

  /** Stands in for the worker pool db across discovery's paged social scan. */
  function fakeSocialTradesDb(rows: Array<Record<string, unknown>>) {
    return createPagedMirrorDb({
      socialRows: rows,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    }).db;
  }

  function userFollow() {
    return {
      id: FOLLOW_ID,
      followerUserId: FOLLOWER,
      credentialId: CREDENTIAL_ID,
      targetType: "user",
      targetKey: traderKey(SOURCE_USER),
      targetLabel: "A trader",
      autoMirror: true,
      sizingMode: "usd",
      sizingValue: "5000",
      destinationPolicyInitialized: true,
      stockAutoMirror: true,
      stockCredentialId: CREDENTIAL_ID,
      stockSizingMode: "usd",
      stockSizingValue: "5000",
      perpAutoMirror: false,
      perpCredentialId: null,
      perpSizingMode: "pct",
      perpSizingValue: "5",
    } as never;
  }

  it("stages the joined order id so execution can re-read whether it traded", async () => {
    const windowStart = WINDOW_START;
    const windowEnd = WINDOW_END;
    const candidates = await findMirrorCandidateSources(
      fakeSocialTradesDb([
        {
          id: "social-1",
          userId: SOURCE_USER,
          symbol: "TSLA",
          side: "buy",
          assetType: "EQUITY",
          socialQty: 500,
          orderQuantity: 500,
          orderId: SOURCE_ORDER_ID,
          orderUserId: SOURCE_USER,
          orderSymbol: "TSLA",
          orderAssetType: "EQUITY",
          tradeAction: "Buy",
          orderDirection: "long",
          // The social row is published at broker acceptance, before this
          // source order has traded. Discovery must retain it so the execution
          // gate can defer and re-read it on the next delivery attempt.
          orderStatus: "SUBMITTED",
          orderExecutedPrice: null,
          orderExecutedQuantity: null,
          orderCreatedAt: new Date("2026-08-19T14:00:10.000Z"),
          createdAt: new Date("2026-08-19T14:00:10.000Z"),
        },
      ]),
      [userFollow()],
      windowStart,
      windowEnd,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceOrderId).toBe(SOURCE_ORDER_ID);
  });
});
