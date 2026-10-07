/**
 * alpaca-15: `fetchLongQty` used to read Alpaca's `qty_available` rather than
 * `qty`. Per docs.alpaca.markets/us/reference/getopenposition-1, `qty_available`
 * is "Total number of shares available minus open orders / locked for options
 * covered call", distinct from `qty`, "The number of shares". A long that is
 * fully reserved by the follower's OWN resting order (a GTC stop-loss, a limit
 * sell, an OCO/bracket leg) therefore reads `qty_available=0` even though the
 * position is entirely real (alpaca.markets/learn/how-to-fix-common-trading-api-
 * errors-at-alpaca: reserved shares stay reserved "until the order is filled or
 * canceled").
 *
 * `decideSellMirrorQty` read that 0 as "no long position" and skipped.
 * `holdEquityCloseIfPairedOpenQueued` only defers a close while a PAIRED OPEN
 * is still queued; this open had already filled, so nothing was queued, and
 * the delivery was marked completed with nothing placed. The follower kept
 * the whole position and the mirror's one-shot exit was gone for good.
 *
 * These tests drive the REAL `processCandidate` with a stubbed Alpaca client
 * whose `getPosition` answers exactly that reserved shape, so they exercise
 * the production path rather than re-implementing it.
 */

import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";

/** The bounded broker-facing id the worker actually submits. */
const brokerIdForCopy = (ownerId: string, logicalId: string) =>
  `rst-copy-${createHash("sha256")
    .update(`copy\0${ownerId}\0${logicalId}`)
    .digest("base64url")
    .slice(0, 32)}`;

const credentialsModule = "../../../../api/src/lib/credentials";
const alpacaShimModule = "../../../../api/src/lib/alpaca";
const alpacaPkgModule = "@trade-bot/alpaca";
// Captured before the mock below replaces the module, so the un-stubbed
// exports keep their real behavior instead of disappearing.
const realAlpaca = await import("@trade-bot/alpaca");

const FOLLOWER = "follower-reserved-long";
const FOLLOW_CREDENTIAL_ID = "88888888-8888-4888-8888-888888888888";
const OPEN_CREDENTIAL_ID = "99999999-9999-4999-8999-999999999999";
const FOLLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_USER_ID = "source-reserved-long";
const SOURCE_CLOSE_ORDER_ID = "source-reserved-close-order";
const SOURCE_CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");
const SOURCE_OPEN_AT = new Date("2026-08-01T13:00:00.000Z");

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  /** The follower's live position in the symbol, or null for "no position". */
  position: null as Record<string, unknown> | null,
  placedOrders: [] as Array<Record<string, unknown>>,
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async (
    _db: unknown,
    _userId: string,
    options: { credentialId?: string },
  ) => ({
    username: "paper-key-id",
    accessToken: "paper-secret-key",
    accountType: "PAPER",
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
      return { buying_power: "200000", equity: "200000", account_number: "paper-acct-1" };
    }
    async getLatestTrade() {
      return { Price: 100 };
    }
    async getSnapshot() {
      return { LatestTrade: { Price: 100 } };
    }
    async getAsset(symbol: string) {
      return { symbol, fractionable: false };
    }
    async getPosition() {
      // What the broker actually answers for a symbol the account is flat
      // in: a 404, which `fetchLongQty` reads as "no long" rather than an
      // outage.
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
  // `mock.module` REPLACES the module, so re-export the names copy-mirror.ts
  // links against that the stub has no reason to fake.
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
    symbol: "MSFT",
    assetType: "EQUITY",
    tradeAction: "Buy",
    status: "FILLED",
    quantity: 200,
    executedQuantity: 200,
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

function closeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: FOLLOW_CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:source-close",
    sourceUserId: SOURCE_USER_ID,
    sourceOrderId: SOURCE_CLOSE_ORDER_ID,
    sourceOrderCreatedAt: SOURCE_CLOSE_AT.toISOString(),
    symbol: "MSFT",
    side: "sell" as const,
    sizingMode: "usd" as const,
    sizingValue: 5_000,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/**
 * A DB whose only mirror history is `history`, and whose delivery queue is
 * empty, matching the failure scenario: the paired open already filled, so
 * there is nothing left in the queue for `holdEquityCloseIfPairedOpenQueued`
 * to find.
 */
function makePoller(history: Array<Record<string, unknown>>) {
  const sourceOrder = {
    id: SOURCE_CLOSE_ORDER_ID,
    userId: SOURCE_USER_ID,
    symbol: "MSFT",
    assetType: "EQUITY",
    tradeAction: "Sell",
    direction: "long",
    status: "FILLED",
    executedQuantity: 200,
    brokerAccountId: "source-account",
    brokerCredentialId: "source-credential",
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: SOURCE_CLOSE_AT,
    executedAt: SOURCE_CLOSE_AT,
  };
  const sourceHistory = [{
    id: "source-reserved-open-order",
    userId: SOURCE_USER_ID,
    symbol: "MSFT",
    assetType: "EQUITY",
    tradeAction: "Buy",
    direction: "long",
    status: "FILLED",
    executedQuantity: 200,
    brokerAccountId: "source-account",
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: SOURCE_OPEN_AT,
    executedAt: SOURCE_OPEN_AT,
  }];
  const sourceIds = new Set(["source-close"]);
  for (const row of history) {
    const clientOrderId = typeof row.clientOrderId === "string" ? row.clientOrderId : "";
    const marker = `copymirror:${FOLLOWER}:user:`;
    if (clientOrderId.startsWith(marker)) sourceIds.add(clientOrderId.slice(marker.length));
  }
  const socialRows = [...sourceIds].map((id) => ({
    id,
    userId: SOURCE_USER_ID,
    symbol: "MSFT",
    assetType: "EQUITY",
    orderId: id === "source-close" ? SOURCE_CLOSE_ORDER_ID : sourceHistory[0].id,
  }));
  const sourceOrderRows = [sourceOrder, ...sourceHistory];
  let orderFindFirstCalls = 0;
  let orderFindManyCalls = 0;
  const db = {
    query: {
      orders: {
        findFirst: async () => {
          orderFindFirstCalls += 1;
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
          stockSizingValue: 5_000,
        }),
      },
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

describe("a long fully reserved by the follower's own open orders is not read as no position", () => {
  it("places the mirrored close for the full held quantity when qty_available is 0 but qty is not", async () => {
    // The mirror opened 200 MSFT. The follower then rested a GTC stop-loss
    // for all 200, so Alpaca reserves them: GET /v2/positions/MSFT answers
    // qty=200, qty_available=0. The source closes. Before the fix,
    // `fetchLongQty` read `qty_available` and reported 0, `decideSellMirrorQty`
    // skipped with "no-long-position", and the delivery completed with
    // nothing placed even though the follower held all 200 shares.
    resetStub({ side: "long", qty: "200", qty_available: "0" });
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(poller, closeCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "MSFT", side: "sell", qty: 200 });
  });

  it("still refuses a SELL when the account is genuinely flat in the symbol", async () => {
    // No regression: reading `qty` instead of `qty_available` must not make a
    // mirror sell shares that were never there. Alpaca answers a true 404 for
    // a flat account, which `fetchLongQty` still reads as 0.
    resetStub(null);
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(poller, closeCandidate());

    expect(outcome).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
  });

  it("still clamps a partially reserved long to what is actually held", async () => {
    // 200 opened, the follower rested an order for only 120 of them, so 80
    // remain unreserved. `qty` (200) is what decides a position EXISTS; the
    // amount actually placed is still bounded by the live long and by
    // attribution exactly as before. Alpaca's own order validation is what
    // enforces the reservation on the 120 that are locked, not this read.
    resetStub({ side: "long", qty: "200", qty_available: "80" });
    const poller = makePoller([mirrorOrder()]);

    const outcome = await run(poller, closeCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "MSFT", side: "sell", qty: 200 });
  });
});
