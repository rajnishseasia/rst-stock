/**
 * A mirrored equity CLOSE must not be SPENT while its paired open is queued.
 *
 * `copy-mirror-close-pairing.ts` was written for exactly this failure and was
 * wired into the Hyperliquid close only. The Alpaca path runs on the same
 * delivery queue with the same one-shot instruction on it:
 *
 *   1. A followed trader buys 200 MSFT and sells them twenty seconds later, so
 *      both candidates stage inside one 30-second poll window.
 *   2. `orderCandidatesBySourceEvent` correctly ranks the buy first, and the
 *      buy's `createOrder` throws a transient 503. Its delivery is requeued.
 *   3. The sell is next in the SAME in-memory batch. The follower holds
 *      nothing yet, so the sell skips with "no-long-position", the returned
 *      outcome marks the delivery completed, and it is never retried.
 *   4. Thirty seconds later the buy's retry succeeds. The follower is long 200
 *      MSFT in a trade the source is already out of, with the only mirrored
 *      exit already spent, and every delivery in the sequence reported success.
 *
 * These tests drive the REAL `processCandidate` with stubbed Alpaca and DB
 * layers, so they exercise the production path rather than a re-implementation
 * of it. They cover both directions: a close whose open is still queued must be
 * held, and a close with nothing queued behind it must still be consumed
 * normally, because a guard that held every close would strand exits just as
 * permanently as spending them.
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
// Captured before the mock below replaces the module, so the un-stubbed exports
// keep their real behavior instead of disappearing.
const realAlpaca = await import("@trade-bot/alpaca");

const FOLLOWER = "follower-close-pairing";
const FOLLOW_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
/** The account that received the mirrored open. */
const OPEN_CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const FOLLOW_ID = "33333333-3333-4333-8333-333333333333";

const OPEN_AT = "2026-08-09T14:00:00.000Z";
const CLOSE_AT = "2026-08-09T14:00:20.000Z";
const SOURCE_USER_ID = "source-close-pairing";
const SOURCE_CLOSE_ORDER_ID = "source-pairing-close-order";

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
      // What the broker actually answers for a symbol the account is flat in:
      // a 404, which fetchLongQty reads as "no long" rather than an outage.
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

const { CopyMirrorPoller, classifyMirrorFailure } = await import("../copy-mirror");

const guards = {
  dailyCap: 20,
  // Far above the sizes here: the per-order dollar cap is a separate guard and
  // must not be what refuses these candidates.
  maxOrderDollars: 1_000_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/** The close being processed, exactly as discovery staged it. */
function sellCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: FOLLOW_CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceItemId: "user:source-close",
    sourceUserId: SOURCE_USER_ID,
    sourceOrderId: SOURCE_CLOSE_ORDER_ID,
    sourceOrderCreatedAt: CLOSE_AT,
    sourceEventAt: CLOSE_AT,
    symbol: "MSFT",
    side: "sell" as const,
    // $20,000 at $100 a share is 200 shares, the whole mirrored position.
    sizingMode: "usd" as const,
    sizingValue: 20_000,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/** A row still sitting in the durable delivery queue, waiting for its retry. */
function queuedDelivery(candidate: Record<string, unknown>) {
  return {
    sourceItemId: candidate.sourceItemId as string,
    followerUserId: (candidate.followerUserId as string) ?? FOLLOWER,
    candidate,
  };
}

function queuedOpen(overrides: Record<string, unknown> = {}) {
  return queuedDelivery({
    followerUserId: FOLLOWER,
    sourceItemId: "user:source-open",
    symbol: "MSFT",
    side: "buy",
    assetType: "EQUITY",
    sourceEventAt: OPEN_AT,
    ...overrides,
  });
}

/**
 * One of the follower's own mirror order rows, as the exposure read sees it.
 *
 * SETTLED (FILLED) by default: this fixture stands in for "the mirror's own
 * open is fully resolved, one way or another", so that whatever a test drives
 * through the QUEUED-DELIVERY sibling scan (`pending` below) is the only thing
 * that can hold the close. A test that wants to exercise the OTHER guard --
 * an open that is still unsettled AT THE BROKER even though its delivery row
 * already completed -- overrides `status` explicitly (see `unsettledMirrorOrder`).
 */
function mirrorOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-open-1",
    userId: FOLLOWER,
    symbol: "MSFT",
    assetType: "EQUITY",
    tradeAction: "Buy",
    status: "FILLED",
    quantity: 200,
    executedQuantity: 200,
    clientOrderId: `copymirror:${FOLLOWER}:user:source-open`,
    brokerAccountId: "paper-acct-1",
    brokerCredentialId: OPEN_CREDENTIAL_ID,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: new Date(OPEN_AT),
    ...overrides,
  };
}

/**
 * A mirrored BUY whose DELIVERY already completed ("placed") but whose broker
 * order has not settled into a reconciled fill yet: SUBMITTED, with nothing
 * executed. `markDeliveryCompleted` fires the instant `processCandidate`
 * returns "placed", well before the reconciler turns this into FILLED, so the
 * row is gone from `loadQueuedSiblingDeliveries` (only "pending" deliveries)
 * while still very much unsettled here. This is the exact gap
 * `pairedOpenOutcomeAmbiguous` covers on the perp path and
 * `exposure.hasUnsettledOpen` covers on this one.
 */
function unsettledMirrorOrder(overrides: Record<string, unknown> = {}) {
  return mirrorOrder({ status: "SUBMITTED", executedQuantity: null, ...overrides });
}

/**
 * A poller whose mirror history is `history` and whose delivery queue still
 * holds `pending`, so the sibling scan reads the queue the poll loop is
 * actually draining.
 */
function makePoller(
  history: Array<Record<string, unknown>>,
  pending: Array<Record<string, unknown>>,
) {
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
    createdAt: new Date(CLOSE_AT),
    executedAt: new Date(CLOSE_AT),
  };
  const sourceHistory = [{
    id: "source-pairing-open-order",
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
    createdAt: new Date(OPEN_AT),
    executedAt: new Date(OPEN_AT),
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
          stockSizingValue: 20_000,
        }),
      },
      copyMirrorDeliveries: {
        findMany: async () => pending,
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

/** Drive a candidate that is expected to be HELD, and hand back the refusal. */
async function runExpectingHold(
  poller: InstanceType<typeof CopyMirrorPoller>,
  candidate: Record<string, unknown>,
): Promise<Error> {
  return run(poller, candidate).then(
    (outcome) => {
      throw new Error(`expected the close to be held, but it returned "${outcome}"`);
    },
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );
}

function resetStub(position: Record<string, unknown> | null) {
  stub.position = position;
  stub.placedOrders.length = 0;
}

/** The close's OWN queued row, which every scan sees and must ignore. */
const ownRow = queuedDelivery({
  followerUserId: FOLLOWER,
  sourceItemId: "user:source-close",
  symbol: "MSFT",
  side: "sell",
  assetType: "EQUITY",
  sourceEventAt: CLOSE_AT,
});

describe("an equity close is not consumed while its paired open is queued", () => {
  it("holds a no-long-position close whose paired BUY is still queued", async () => {
    // The audit's scenario end to end: the buy threw and was requeued, the sell
    // runs next in the same batch and the follower is still flat.
    resetStub(null);
    const poller = makePoller([mirrorOrder()], [ownRow, queuedOpen()]);

    const error = await runExpectingHold(poller, sellCandidate());

    expect(error.message).toContain("equity close held back");
    // Requeued rather than abandoned: the exit survives to a cycle where the
    // position it reduces actually exists.
    expect(classifyMirrorFailure(error).kind).toBe("transient");
    expect(stub.placedOrders).toEqual([]);
  });

  it("holds a no-mirrored-exposure close whose paired BUY never wrote a row", async () => {
    // The open failed before it could insert its order row, so nothing on file
    // attributes any of the follower's holding to the mirror. That is the same
    // missing open, one step earlier.
    resetStub({ side: "long", qty: "500", qty_available: "500" });
    const poller = makePoller([], [ownRow, queuedOpen()]);

    const error = await runExpectingHold(poller, sellCandidate());

    expect(error.message).toContain("equity close held back");
    expect(stub.placedOrders).toEqual([]);
  });

  it("consumes the close normally when nothing is queued behind it", async () => {
    // The ordinary case, and the one the guard must not break: the source
    // closed a position the follower no longer holds, with no open pending.
    // Holding here would retry a finished exit until the attempt ceiling.
    resetStub(null);
    const poller = makePoller([mirrorOrder()], [ownRow]);

    expect(await run(poller, sellCandidate())).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
  });

  it("holds a no-long-position close whose paired BUY's delivery already completed but whose broker order has not settled", async () => {
    // The failure mode the sibling-deliveries scan alone cannot see: the buy's
    // market order was ACCEPTED (order row SUBMITTED) and `processCandidate`
    // already returned "placed", so `markDeliveryCompleted` removed it from
    // the pending queue before the sell in the same batch even runs. Nothing
    // is queued behind this close, but the open it pairs with is still
    // unsettled at the broker, and `fetchLongQty` reading 0 in that instant
    // does not mean the position never existed. Holding here is what turns an
    // exit silently spent on a phantom "no position" into one that survives to
    // retry once the reconciler catches the fill up.
    resetStub(null);
    const poller = makePoller([unsettledMirrorOrder()], [ownRow]);

    const error = await runExpectingHold(poller, sellCandidate());

    expect(error.message).toContain("equity close held back");
    expect(classifyMirrorFailure(error).kind).toBe("transient");
    expect(stub.placedOrders).toEqual([]);
  });

  it("is not held by another queued CLOSE, which can open nothing", async () => {
    // A sell cannot create the exposure a sell is waiting for. If closes held
    // each other, a batch of two exits would deadlock until both were
    // abandoned, which is the failure this guard exists to prevent.
    resetStub(null);
    const poller = makePoller(
      [mirrorOrder()],
      [
        ownRow,
        queuedDelivery({
          followerUserId: FOLLOWER,
          sourceItemId: "user:other-close",
          symbol: "MSFT",
          side: "sell",
          assetType: "EQUITY",
          sourceEventAt: OPEN_AT,
        }),
      ],
    );

    expect(await run(poller, sellCandidate())).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
  });

  it("is not held by a queued open in a different symbol or asset class", async () => {
    resetStub(null);
    const poller = makePoller(
      [mirrorOrder()],
      [
        ownRow,
        queuedOpen({ sourceItemId: "user:other-symbol", symbol: "AAPL" }),
        queuedOpen({ sourceItemId: "user:other-class", assetType: "PERP" }),
      ],
    );

    expect(await run(poller, sellCandidate())).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
  });

  it("is not held by a re-entry the source made after this close", async () => {
    // An entry stamped after the close is a position the close never
    // addressed, so it says nothing about whether this exit is finished.
    resetStub(null);
    const poller = makePoller(
      [mirrorOrder()],
      [
        ownRow,
        queuedOpen({
          sourceItemId: "user:re-entry",
          sourceEventAt: "2026-08-09T14:05:00.000Z",
        }),
      ],
    );

    expect(await run(poller, sellCandidate())).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
  });

  it("still places the exit when the follower does hold the mirrored position", async () => {
    // The guard only ever runs on a skip. A close that has something to reduce
    // must go out in full even with the paired open still queued.
    //
    // The mirror history row here is FILLED (settled, attributable exposure of
    // 200), not the default still-working PENDING fixture: alpaca-13 made
    // attribution count only what has actually filled, so an unsettled row
    // would read as zero exposure and this case would (correctly) hold rather
    // than place. This test is about the OTHER guard, so the mirror's own
    // exposure is unambiguous on purpose and the paired-open queue is what is
    // exercised.
    resetStub({ side: "long", qty: "200", qty_available: "200" });
    const poller = makePoller(
      [mirrorOrder({ status: "FILLED", executedQuantity: 200 })],
      [ownRow, queuedOpen()],
    );

    expect(await run(poller, sellCandidate())).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "MSFT", side: "sell", qty: 200 });
  });
});
