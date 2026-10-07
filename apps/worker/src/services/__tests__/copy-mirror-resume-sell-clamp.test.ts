/**
 * The SELL clamp has to survive a PENDING resume.
 *
 * `processCandidate` short-circuits a stored PENDING equity/option row straight
 * into `placeMirrorOrder`, deliberately skipping every fresh account and quote
 * read so a wedged delivery re-sends the exact intent it already sized. The
 * clamp that stops a mirrored SELL from becoming a naked SHORT lived only on the
 * fresh path, so the short-circuit skipped that too: a stored 100-share SELL was
 * re-sent as a 100-share market SELL whatever the follower held by then, and on
 * a margin account Alpaca opens the difference as a short. Equities have no
 * reduce-only flag and the equity order carries no `position_intent`, so nothing
 * downstream of us would have caught it.
 *
 * These tests drive the REAL `processCandidate` with stubbed Alpaca and DB
 * layers, so they exercise the same path the production poller takes, and they
 * cover both halves: the resume must refuse or shrink against the live long, and
 * it must still re-send in full when the long is intact.
 *
 * Companion to the perp resume tests in copy-mirror.test.ts, which lock in the
 * same rule for `resumePendingPerpMirror` ("reduceOnly prevents a flip; it does
 * not preserve ownership").
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

const FOLLOWER = "follower-resume";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const FOLLOW_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ITEM_ID = "user:source-close";
const CLIENT_ORDER_ID = `copymirror:${FOLLOWER}:${SOURCE_ITEM_ID}`;

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  /** The follower's live position in the symbol, or null for "no position". */
  position: null as Record<string, unknown> | null,
  positionReads: 0,
  accountCalls: 0,
  placedOrders: [] as Array<Record<string, unknown>>,
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async () => ({
    username: "paper-key-id",
    accessToken: "paper-secret-key",
    accountType: "PAPER",
    accountId: "paper-acct-1",
    credentialId: "paper-credential",
  }),
}));

mock.module(alpacaShimModule, () => ({
  isPaperAccount: (accountType: string | null | undefined) => accountType !== "LIVE",
}));

mock.module(alpacaPkgModule, () => {
  class AlpacaClient {
    async getAccount() {
      stub.accountCalls += 1;
      return { buying_power: "100000", equity: "50000" };
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
      stub.positionReads += 1;
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
      // Nothing of this mirror at the broker: the first attempt died in
      // transport, which is exactly why the row is still PENDING.
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

const guards = {
  dailyCap: 20,
  maxOrderDollars: 1_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/** The stored PENDING row a transient first attempt left behind. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-resume",
    userId: FOLLOWER,
    symbol: "AAPL",
    assetType: "EQUITY",
    status: "PENDING",
    brokerOrderId: null,
    clientOrderId: CLIENT_ORDER_ID,
    quantity: 100,
    limitPrice: null,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    tradeAction: "Sell",
    brokerAccountId: "paper-acct-1",
    brokerCredentialId: "paper-credential",
    copySourceLabel: "Whale",
    ...overrides,
  };
}

function sellCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: SOURCE_ITEM_ID,
    symbol: "AAPL",
    side: "sell" as const,
    sizingMode: "usd" as const,
    sizingValue: 500,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

interface DbSink {
  /** Every `set(...)` payload written to `orders`, in order. */
  updates: Array<Record<string, unknown>>;
  /** Rows the quantity UPDATE matches. Zero models the row leaving PENDING. */
  quantityUpdateMatches?: number;
}

function freshSink(): DbSink {
  return { updates: [] };
}

/**
 * A DB whose stored order row behaves like a real one: the quantity UPDATE lands
 * on it, and `placeMirrorOrder` re-reads it afterwards. That re-read is the
 * point. On a resume the insert conflicts, so the submitted quantity comes from
 * the ROW rather than from the caller's argument, and a clamp that is not
 * persisted is a clamp the broker never sees.
 */
function makePoller(row: Record<string, unknown>, sink: DbSink, mirrorsToday = 0) {
  const db = {
    query: {
      orders: {
        findFirst: async () => row,
        findMany: async () => [],
      },
      userApiCredentials: {
        findFirst: async () => ({ id: CREDENTIAL_ID, provider: "alpaca" }),
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
          stockSizingValue: "500",
          perpAutoMirror: false,
          perpCredentialId: null,
          perpSizingMode: "pct",
          perpSizingValue: "5",
        }),
      },
      // An EMPTY delivery queue, which is what these cases describe: the
      // follower's long is gone because they sold it themselves, not because a
      // paired open is still waiting for its retry. The close-pairing guard
      // reads this queue before consuming a skipped close, and with nothing in
      // it the outcomes below are exactly the ones this file has always
      // asserted. See copy-mirror-equity-close-pairing.test.ts for the case
      // where the queue is not empty.
      copyMirrorDeliveries: {
        findMany: async () => [],
      },
    },
    select: () => ({
      from: () => ({
        where: async (clause: unknown) => {
          // The real count EXCLUDES the row being resumed, so the stub has to as
          // well: with a blanket count a resumed order blocks itself on the cap
          // and a test could not tell the two apart.
          const bound: string[] = [];
          const walk = (node: any, depth = 0) => {
            if (depth > 10 || !node) return;
            if (Array.isArray(node)) return node.forEach((child) => walk(child, depth + 1));
            if (typeof node === "object") {
              if (typeof node.value === "string") bound.push(node.value);
              Object.values(node).forEach((child) => walk(child, depth + 1));
            }
          };
          walk(clause);
          const excludesResumedRow = bound.includes(row.id as string);
          return [{
            value: excludesResumedRow ? Math.max(0, mirrorsToday - 1) : mirrorsToday,
          }];
        },
      }),
    }),
    // The row already exists, so the resume's insert conflicts and returns
    // nothing, which is what puts placeMirrorOrder on its recovery path.
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sink.updates.push(values);
        const matched =
          sink.quantityUpdateMatches === undefined || !("quantity" in values)
            ? 1
            : sink.quantityUpdateMatches;
        if ("quantity" in values && matched > 0) row.quantity = values.quantity;
        const rows = Array.from({ length: matched }, () => ({ id: row.id }));
        // A real Promise carrying an extra `returning`, so both shapes the
        // production code uses work: `await ...where(...)` for the plain updates
        // and `await ...where(...).returning(...)` for the clamp.
        const result = Object.assign(Promise.resolve(rows), {
          returning: async () => rows,
        });
        return { where: () => result };
      },
    }),
  } as never;
  return new CopyMirrorPoller(db);
}

function resume(
  poller: InstanceType<typeof CopyMirrorPoller>,
  candidate: Record<string, unknown>,
) {
  return (poller as any).processCandidate(candidate, guards) as Promise<string>;
}

function resetStub(position: Record<string, unknown> | null) {
  stub.position = position;
  stub.positionReads = 0;
  stub.accountCalls = 0;
  stub.placedOrders.length = 0;
}

describe("equity PENDING resume keeps the SELL clamp", () => {
  it("refuses a resumed SELL once the follower no longer holds the long", async () => {
    // The audit's scenario. The mirror sized 100 shares against a long the
    // follower held at the time, the submission died in transport, and the
    // follower exited by hand (or a stop filled) before the retry. Re-sending
    // the stored 100 opens a 100-share SHORT nobody asked for.
    resetStub(null);
    const sink = freshSink();
    const poller = makePoller(storedRow(), sink);

    const outcome = await resume(poller, sellCandidate());

    expect(outcome).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
    // The read is the whole point: a resume that never asks the broker what the
    // follower holds cannot know it is about to open a short.
    expect(stub.positionReads).toBe(1);
  });

  it("leaves the refused row PENDING for the reconciler", async () => {
    // The first attempt may have reached Alpaca with its response lost, so the
    // row is not ours to retire. Broker state is the source of truth.
    resetStub(null);
    const sink = freshSink();
    const poller = makePoller(storedRow(), sink);

    await resume(poller, sellCandidate());

    expect(sink.updates.some((values) => "status" in values)).toBe(false);
  });

  it("clamps a resumed SELL down to the long the follower still holds", async () => {
    // A partial exit is the same defect in miniature: 100 stored against 40 held
    // is 60 shares of naked short.
    resetStub({ side: "long", qty: "40", qty_available: "40" });
    const sink = freshSink();
    const row = storedRow();
    const poller = makePoller(row, sink);

    const outcome = await resume(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "sell", qty: 40 });
    // Persisted, not just passed: a resume's submission quantity is read back
    // off the row, so a clamp that is not written down never reaches Alpaca.
    expect(row.quantity).toBe(40);
  });

  it("still re-sends the whole stored SELL while the long is intact", async () => {
    // The other half. A clamp that refused everything would pass the tests above
    // for the wrong reason, and a mirrored exit that never goes out leaves the
    // follower holding a position the source has left.
    resetStub({ side: "long", qty: "100", qty_available: "100" });
    const sink = freshSink();
    const row = storedRow();
    const poller = makePoller(row, sink);

    const outcome = await resume(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 100 });
    // Nothing to clamp, so nothing is rewritten.
    expect(sink.updates.some((values) => "quantity" in values)).toBe(false);
    // Still the durable intent: no fresh sizing read happened.
    expect(stub.accountCalls).toBe(0);
  });

  it("holds the delivery when the clamp cannot be recorded", async () => {
    // An UPDATE that matches zero rows RESOLVES, it does not throw. Without the
    // check the resume would go on to submit the row's ORIGINAL quantity, which
    // is the naked short this whole clamp exists to prevent, so it throws and
    // the delivery is requeued instead of consumed.
    resetStub({ side: "long", qty: "40", qty_available: "40" });
    const sink = freshSink();
    sink.quantityUpdateMatches = 0;
    const poller = makePoller(storedRow(), sink);

    await expect(resume(poller, sellCandidate())).rejects.toThrow(/clamp/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("applies the clamp to a resumed option SellToClose as well", async () => {
    // Options reach the same branch, and a SellToClose against contracts the
    // follower no longer holds is a short option position: unbounded risk on a
    // naked call.
    resetStub(null);
    const sink = freshSink();
    const poller = makePoller(
      storedRow({
        assetType: "OPTION",
        tradeAction: "SellToClose",
        optionExpiration: "260918",
        optionStrike: "250",
        optionType: "CALL",
        limitPrice: "3.25",
        quantity: 2,
      }),
      sink,
    );

    const outcome = await resume(
      poller,
      sellCandidate({
        assetType: "OPTION",
        tradeAction: "SellToClose",
        optionExpiration: "260918",
        optionStrike: 250,
        optionType: "CALL",
      }),
    );

    expect(outcome).toBe("no-long-position");
    expect(stub.placedOrders).toEqual([]);
  });

  it("does not read a position for a resumed BUY", async () => {
    // A BUY cannot open a short, so the clamp must not touch it: the stored
    // intent is re-sent exactly as it was sized. Quantity is dropped to 5 (the
    // mock quote is $100/share) so this stays under guards.maxOrderDollars:
    // the dollar-cap resume re-check added alongside this test is not what is
    // under test here, and it must not fire and mask the assertion below.
    resetStub(null);
    const sink = freshSink();
    const poller = makePoller(storedRow({ tradeAction: "Buy", quantity: 5 }), sink);

    const outcome = await resume(
      poller,
      sellCandidate({ side: "buy" as const, tradeAction: "Buy" as const }),
    );

    expect(outcome).toBe("placed");
    expect(stub.positionReads).toBe(0);
    expect(stub.placedOrders[0]).toMatchObject({ side: "buy", qty: 5 });
  });
});

describe("equity PENDING resume counts against today's cap", () => {
  it("refuses a resumed BUY once today's cap is full", async () => {
    // countMirrorsToday counts by placement time, so a row stranded PENDING
    // before midnight is invisible to every count taken after it. Without this
    // check that row places on top of a full day of fresh mirrors, putting the
    // follower one order over a cap that exists to bound what the mirror can do
    // to their account in a day. dailyCap + 1 so the cap is genuinely reached by
    // orders that are NOT this one.
    resetStub(null);
    const sink = freshSink();
    const poller = makePoller(
      storedRow({ tradeAction: "Buy" }),
      sink,
      guards.dailyCap + 1,
    );

    const outcome = await resume(
      poller,
      sellCandidate({ side: "buy" as const, tradeAction: "Buy" as const }),
    );

    expect(outcome).toBe("daily-cap");
    expect(stub.placedOrders).toEqual([]);
  });

  it("does not let a same-day resumed BUY block itself on the cap", async () => {
    // The count ignores status, so a row stranded earlier TODAY is already
    // inside it. Counting it here would let it block itself: the order holding
    // the last slot reads the cap as full and is refused, leaving that slot
    // occupied by an order that never went out. Quantity is dropped to 5 (the
    // mock quote is $100/share) so this stays under guards.maxOrderDollars:
    // the daily cap is what is under test here, not the dollar-cap resume
    // re-check added alongside this test.
    resetStub(null);
    const sink = freshSink();
    const poller = makePoller(
      storedRow({ tradeAction: "Buy", quantity: 5 }),
      sink,
      guards.dailyCap,
    );

    const outcome = await resume(
      poller,
      sellCandidate({ side: "buy" as const, tradeAction: "Buy" as const }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
  });

  it("never lets the cap stop a resumed SELL", async () => {
    // An exit is not new exposure, and a cap must never be the reason a follower
    // cannot get out of a position the mirror opened for them. Same exemption
    // the perp resume makes for a reduce-only close.
    resetStub({ side: "long", qty: "100", qty_available: "100" });
    const sink = freshSink();
    const poller = makePoller(storedRow(), sink, guards.dailyCap + 1);

    const outcome = await resume(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 100 });
  });
});
