/**
 * A mirrored equity SELL may only ever liquidate what the MIRROR opened.
 *
 * The sell path sizes an exit from the follower's own sizing rule and used to
 * clamp it to nothing but the destination account's total long. That long is
 * every share the account holds, mirror-opened and hand-bought alike, so a
 * follower who happened to own the symbol had their OWN shares sold whenever a
 * followed trader closed a position the mirror had never copied for them. The
 * destination was wrong for the same reason: the exit went to whatever account
 * the follow points at NOW, which is not necessarily the account that received
 * the open.
 *
 * The perp close path has treated attribution as mandatory from the start ("a
 * copied close may only ever reduce the part the mirror opened", and
 * `mirroredExposureCredentialId` routes the exit to the account that actually
 * holds it). These tests hold the equity path to the same rule.
 *
 * They drive the REAL `processCandidate` with stubbed Alpaca and DB layers, so
 * they exercise the production path rather than a re-implementation of it, and
 * they cover BOTH directions: an unattributed sell must be refused, and a sell
 * that the mirror did open must still go out in full. An exit is one-shot, so a
 * ceiling that refused too much would be as damaging as no ceiling at all.
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

const FOLLOWER = "follower-attribution";
/** The account the follow points at right now. */
const FOLLOW_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
/** The account that actually received the mirrored open. */
const OPEN_CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CREDENTIAL_ID = "55555555-5555-4555-8555-555555555555";
const FOLLOW_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_USER_ID = "source-attribution-trader";
const SOURCE_CLOSE_ORDER_ID = "source-close-order";
const SOURCE_CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  /** The follower's live position in the symbol, or null for "no position". */
  position: null as Record<string, unknown> | null,
  placedOrders: [] as Array<Record<string, unknown>>,
  /** Every credentialId `getDecryptedCredentials` was asked for, in order. */
  credentialRequests: [] as Array<string | undefined>,
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async (
    _db: unknown,
    _userId: string,
    options: { credentialId?: string },
  ) => {
    stub.credentialRequests.push(options?.credentialId);
    return {
      username: "paper-key-id",
      accessToken: "paper-secret-key",
      accountType: "PAPER",
      accountId: "paper-acct-1",
      credentialId: options?.credentialId ?? "paper-credential",
    };
  },
}));

mock.module(alpacaShimModule, () => ({
  isPaperAccount: (accountType: string | null | undefined) => accountType !== "LIVE",
}));

mock.module(alpacaPkgModule, () => {
  class AlpacaClient {
    async getAccount() {
      // `account_number` matters now that a close whose own credential was
      // nulled is routed by the ACCOUNT that received the open rather than by
      // whatever the follow points at. Every connection in this file belongs to
      // the same account as the mirrored opens ("paper-acct-1"), so the reroute
      // CONFIRMS the follow's credential is the right destination instead of
      // assuming it, and the outcome is unchanged.
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
  // Deliberately far above the sizes here: the per-order dollar cap is a
  // separate guard with its own defects, and it must not be what refuses these
  // candidates or the attribution ceiling would never be reached.
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
    symbol: "AAPL",
    assetType: "EQUITY",
    tradeAction: "Buy",
    status: "FILLED",
    quantity: 20,
    executedQuantity: 20,
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
    symbol: "AAPL",
    side: "sell" as const,
    // $5,000 at $100 a share is 50 shares, which is well inside both the live
    // holding and the dollar cap, so only attribution can change it.
    sizingMode: "usd" as const,
    sizingValue: 5_000,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

interface DbSink {
  /** How many times the mirrored-exposure history was read. */
  historyReads: number;
}

/**
 * A DB whose only mirror history is `history`, and whose insert behaves like a
 * first attempt (no conflict), so `placeMirrorOrder` submits the caller's
 * quantity rather than a stored one.
 */
function makePoller(
  history: Array<Record<string, unknown>>,
  sink: DbSink,
  options: {
    sourceOrder?: Record<string, unknown>;
    sourceHistory?: Array<Record<string, unknown>>;
    socialRows?: Array<Record<string, unknown>>;
  } = {},
) {
  const sourceOrder = options.sourceOrder ?? {
    id: SOURCE_CLOSE_ORDER_ID,
    userId: SOURCE_USER_ID,
    symbol: "AAPL",
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
    symbol: "AAPL",
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
    const marker = `copymirror:${FOLLOWER}:user:`;
    if (clientOrderId.startsWith(marker)) sourceIds.add(clientOrderId.slice(marker.length));
  }
  const socialRows = options.socialRows ?? [...sourceIds].map((id) => ({
    id,
    userId: SOURCE_USER_ID,
    symbol: "AAPL",
    assetType: "EQUITY",
    orderId: id === "source-close" ? SOURCE_CLOSE_ORDER_ID : "source-open-order",
  }));
  const sourceOrderRows = [
    sourceOrder,
    ...sourceHistory.filter((row) => row.id !== sourceOrder.id),
  ];
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
          sink.historyReads += 1;
          orderFindManyCalls += 1;
          return orderFindManyCalls === 1 ? history : sourceOrderRows;
        },
      },
      socialTrades: { findMany: async () => socialRows },
      userApiCredentials: {
        findFirst: async () => ({ id: FOLLOW_CREDENTIAL_ID, provider: "alpaca" }),
        // Read by the close reroute when the open's own credential was nulled:
        // it identifies each connection by a live account_number call rather
        // than trusting the follow. Only this one connection exists here, and
        // it belongs to the account the opens landed in, so the reroute lands
        // exactly where the follow already pointed.
        findMany: async () => [{ id: FOLLOW_CREDENTIAL_ID, provider: "alpaca" }],
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
      // An EMPTY delivery queue, which is what these cases describe: the shares
      // are unattributable because the mirror never bought them, not because a
      // paired open is still waiting for its retry. The close-pairing guard
      // reads this queue before consuming a skipped close, and with nothing in
      // it the outcomes below are exactly the ones this file has always
      // asserted. See copy-mirror-equity-close-pairing.test.ts for the case
      // where the queue is not empty.
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
  stub.credentialRequests.length = 0;
}

/** The follower's own 500 hand-bought shares. */
const HAND_BOUGHT_500 = { side: "long", qty: "500", qty_available: "500" };

describe("mirrored equity SELL is bounded by what the mirror opened", () => {
  it("refuses a SELL in a symbol the mirror never bought for this follower", async () => {
    // The audit's scenario. F holds 500 AAPL they bought themselves and the
    // mirror has never opened AAPL for them (the source's entry predates the
    // follow, or was skipped by the dollar cap). Nothing about the source's
    // exit entitles the mirror to sell F's own shares.
    resetStub(HAND_BOUGHT_500);
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller([], sink);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("no-mirrored-exposure");
    expect(stub.placedOrders).toEqual([]);
  });

  it("clamps the SELL to the shares the mirror actually opened", async () => {
    // The mirror bought 20 of the 500 the account holds. The sizing rule asks
    // for 50 and the live long allows 500, so attribution is the only thing
    // that can hold this to the 20 shares that are the mirror's to sell.
    resetStub(HAND_BOUGHT_500);
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller([mirrorOrder({ quantity: 20, executedQuantity: 20 })], sink);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "sell", qty: 20 });
  });

  it("nets earlier mirrored exits out of the ceiling", async () => {
    // 100 opened and 60 already mirrored back out leaves 40 of the follower's
    // holding attributable to the mirror. Counting the opens alone would let a
    // second close sell the same shares twice.
    resetStub(HAND_BOUGHT_500);
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [
        mirrorOrder({ quantity: 100, executedQuantity: 100 }),
        mirrorOrder({
          tradeAction: "Sell",
          quantity: 60,
          executedQuantity: 60,
          clientOrderId: `copymirror:${FOLLOWER}:user:earlier-close`,
        }),
      ],
      sink,
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 40 });
  });

  it("does not count a mirrored open that never reached the broker", async () => {
    // A REJECTED open with no fill put nothing in the account, so it is not
    // exposure and must not license a sell of the follower's own shares.
    resetStub(HAND_BOUGHT_500);
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [mirrorOrder({ status: "REJECTED", quantity: 20, executedQuantity: null })],
      sink,
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("no-mirrored-exposure");
    expect(stub.placedOrders).toEqual([]);
  });

  it("attributes an OPTION close to its own contract, not the underlying", async () => {
    // Option rows carry the underlying in `symbol`, so matching on that alone
    // would let a mirrored $300 call license the sale of the follower's own
    // $250 calls. The contract is part of the identity of the exposure.
    resetStub({ side: "long", qty: "10", qty_available: "10" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [
        mirrorOrder({
          assetType: "OPTION",
          tradeAction: "BuyToOpen",
          quantity: 5,
          executedQuantity: 5,
          optionExpiration: "260918",
          optionStrike: "300.0000",
          optionType: "CALL",
        }),
      ],
      sink,
    );

    const outcome = await run(
      poller,
      sellCandidate({
        assetType: "OPTION",
        tradeAction: "SellToClose",
        optionExpiration: "260918",
        optionStrike: 250,
        optionType: "CALL",
      }),
    );

    expect(outcome).toBe("no-mirrored-exposure");
    expect(stub.placedOrders).toEqual([]);
  });
});

describe("attribution never blocks an exit the mirror does owe the follower", () => {
  it("sells the whole mirrored position when the sizing rule asks for more", async () => {
    // The other half, and the more important one: a ceiling that refused too
    // much would strand followers in positions the mirror opened. 100 opened,
    // 100 held, a rule that would buy 500: the exit goes out in full.
    resetStub({ side: "long", qty: "100", qty_available: "100" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [mirrorOrder({ quantity: 100, executedQuantity: 100 })],
      sink,
    );

    const outcome = await run(poller, sellCandidate({ sizingValue: 50_000 }));

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 100 });
  });

  it("holds (does not spend) a close while a mirrored open has not settled yet", async () => {
    // A SUBMITTED open may already be holding shares the reconciler has not
    // written down yet, OR it may genuinely still be resting, unfilled, at
    // the broker (alpaca-13: crediting it at its REQUESTED size either way
    // used to inflate the ceiling past what the mirror actually put in the
    // account, and that inflated ceiling was not caught by anything — it was
    // spent straight out of the follower's own 500 hand-bought shares the
    // moment this open failed to fill). Only `executedQuantity` counts now,
    // so this open contributes 0 until it settles, and the close is HELD
    // (not completed as "no-mirrored-exposure") until it does.
    resetStub({ side: "long", qty: "500", qty_available: "500" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [mirrorOrder({ status: "SUBMITTED", quantity: 30, executedQuantity: null })],
      sink,
    );

    const failure = await run(poller, sellCandidate()).then(
      (outcome) => {
        throw new Error(`expected the close to be held, but it returned "${outcome}"`);
      },
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );

    expect(failure.message).toContain("equity close held back");
    // Requeued rather than abandoned: the exit survives to a cycle where the
    // open has either filled (and is now real exposure) or definitively has
    // not (REJECTED/CANCELLED/EXPIRED, contributing 0 for good).
    expect(classifyMirrorFailure(failure).kind).toBe("transient");
    expect(stub.placedOrders).toEqual([]);
  });

  it("still clamps to the live long when the follower has already exited part of it", async () => {
    // Attribution is a ceiling ON TOP of the existing live-position clamp, not
    // a replacement for it: the mirror opened 100, the follower sold 70 by
    // hand, and only the 30 still there can be sold.
    resetStub({ side: "long", qty: "30", qty_available: "30" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [mirrorOrder({ quantity: 100, executedQuantity: 100 })],
      sink,
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 30 });
  });
});

describe("mirrored equity SELL is routed to the account holding the exposure", () => {
  it("exits at the account that received the open, not the one the follow now points at", async () => {
    // The re-point variant. The follow was moved to another account after the
    // open, so the candidate carries the NEW credential. Following it sells an
    // unrelated holding there (or finds nothing and spends the one-shot exit)
    // while the mirrored position stays open where it really is.
    resetStub({ side: "long", qty: "100", qty_available: "100" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [mirrorOrder({ quantity: 40, executedQuantity: 40 })],
      sink,
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.credentialRequests).toEqual([OPEN_CREDENTIAL_ID]);
  });

  it("holds the exit rather than guessing when the exposure spans two accounts", async () => {
    // Which account this close exits cannot be answered from two live mirrored
    // positions, and guessing reduces an unrelated one while leaving the other
    // open. Thrown, not returned: a returned outcome completes the delivery and
    // a close is the only instruction that ever exits this position.
    resetStub({ side: "long", qty: "100", qty_available: "100" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [
        mirrorOrder({ quantity: 40, executedQuantity: 40 }),
        mirrorOrder({
          quantity: 25,
          executedQuantity: 25,
          brokerAccountId: "paper-acct-2",
          brokerCredentialId: OTHER_CREDENTIAL_ID,
          clientOrderId: `copymirror:${FOLLOWER}:user:other-open`,
        }),
      ],
      sink,
    );

    await expect(run(poller, sellCandidate())).rejects.toThrow(/more than one account/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("still exits through the follow's account when no open is on file to route by", async () => {
    // Legacy rows can carry no credential at all (deleting a connection nulls
    // the foreign key). The exposure is still attributable, so the exit is
    // still owed, and the follow's account is the only destination left.
    resetStub({ side: "long", qty: "100", qty_available: "100" });
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller(
      [mirrorOrder({ quantity: 40, executedQuantity: 40, brokerCredentialId: null })],
      sink,
    );

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    // Decrypted twice for the same id, and that is the fix rather than a
    // regression: once to read this connection's live account_number while
    // confirming it is the account the open landed in, once to build the client
    // that places the exit. Every entry names the follow's credential, so the
    // destination is unchanged; it is now VERIFIED against the open's account
    // instead of assumed from the follow, which is what stops a re-pointed
    // follow sending the exit to an account that never held the position.
    expect(new Set(stub.credentialRequests)).toEqual(new Set([FOLLOW_CREDENTIAL_ID]));
  });
});

describe("attribution is a SELL-side rule only", () => {
  it("leaves a mirrored BUY untouched and reads no exposure history for it", async () => {
    // A BUY creates exposure rather than spending it, so nothing here applies.
    // Asserting the read count keeps this from turning into an extra query on
    // the opening path by accident.
    resetStub(null);
    const sink: DbSink = { historyReads: 0 };
    const poller = makePoller([], sink);

    const outcome = await run(
      poller,
      sellCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        tradeAction: "Buy" as const,
      }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "buy", qty: 50 });
    expect(sink.historyReads).toBe(0);
  });
});
