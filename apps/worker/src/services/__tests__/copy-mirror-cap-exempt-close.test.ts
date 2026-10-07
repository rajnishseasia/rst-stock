/**
 * The mirror's caps bound NEW EXPOSURE, so they must never refuse an EXIT.
 *
 * `decideMirror` runs for buys and sells alike and used to apply
 * `withinDollarCap` and `withinDailyCap` to both. Its skip is returned straight
 * out of `processCandidate`, and the poll loop turns any returned outcome into
 * `markDeliveryCompleted`, which is terminal. So a follower whose morning
 * entries spent all 20 of their daily mirrors had the afternoon's mirrored
 * close refused AND spent: nothing regenerates a source close, so the position
 * the mirror opened for them was left with its one exit already consumed.
 *
 * The rest of the codebase draws the opposite line everywhere it matters. A
 * mirrored SELL "is the equity equivalent of a reduce-only perp order"
 * (`copy-mirror-consent.ts`), `decidePerpReduceOnlyMirror` carries no cap checks
 * at all, and the perp resume says it outright: "an exit is not new exposure,
 * and a daily cap must never be the reason a follower cannot get out of a
 * leveraged position". These tests hold the equity path to the same rule, and
 * to its second half: a close refused for a reason a later attempt could
 * resolve must be HELD, not spent.
 *
 * They drive the REAL `processCandidate` with stubbed Alpaca and DB layers, so
 * they exercise the production path rather than a re-implementation of it, and
 * they cover both directions. An opening BUY must still be capped, or a fix
 * that exempts too much would remove the guardrail the caps exist to be.
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

const FOLLOWER = "follower-cap-exempt";
const FOLLOW_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
/** The account that received the mirrored open, and so the exit's destination. */
const OPEN_CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const FOLLOW_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_USER_ID = "source-cap-exempt";
const SOURCE_CLOSE_ORDER_ID = "source-cap-close-order";
const SOURCE_CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");
const SOURCE_OPEN_AT = new Date("2026-08-01T13:00:00.000Z");

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  /** The follower's live position in the symbol, or null for "no position". */
  position: null as Record<string, unknown> | null,
  /** Option bid. 0 is what Alpaca answers for a contract with no resting bid. */
  optionBid: 3.25,
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
    async getLatestOptionQuote() {
      return { latestQuote: { bp: stub.optionBid, ap: 3.35 } };
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

const { CopyMirrorPoller, classifyMirrorFailure, decideMirror } = await import("../copy-mirror");

const DAILY_CAP = 20;
const MAX_ORDER_DOLLARS = 1_000;

const baseGuards = {
  dailyCap: DAILY_CAP,
  maxOrderDollars: MAX_ORDER_DOLLARS,
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
    symbol: "AAPL",
    side: "sell" as const,
    // $5,000 at $100 a share is 50 shares, which is $5,000 of notional against
    // a $1,000 per-order ceiling. That is deliberate: it is the cap, and only
    // the cap, that decides this candidate.
    sizingMode: "usd" as const,
    sizingValue: 5_000,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/**
 * A DB whose only mirror history is `history` and whose mirrors-today count is
 * `mirrorsToday`. The insert behaves like a first attempt (no conflict), so
 * `placeMirrorOrder` submits the caller's quantity rather than a stored one.
 */
function makePoller(history: Array<Record<string, unknown>>, mirrorsToday: number) {
  const mirror = history[0];
  const sourceAssetType = mirror?.assetType === "OPTION" ? "OPTION" : "EQUITY";
  const sourceSymbol = typeof mirror?.symbol === "string" ? mirror.symbol : "AAPL";
  const sourceQuantity = typeof mirror?.executedQuantity === "number"
    ? mirror.executedQuantity
    : 100;
  const sourceOptionExpiration = sourceAssetType === "OPTION"
    ? (typeof mirror?.optionExpiration === "string" ? mirror.optionExpiration : "260918")
    : null;
  const sourceOptionStrike = sourceAssetType === "OPTION"
    ? (typeof mirror?.optionStrike === "string" ? mirror.optionStrike : "250.0000")
    : null;
  const sourceOptionType = sourceAssetType === "OPTION"
    ? (typeof mirror?.optionType === "string" ? mirror.optionType : "CALL")
    : null;
  const sourceOrder = {
    id: SOURCE_CLOSE_ORDER_ID,
    userId: SOURCE_USER_ID,
    symbol: sourceSymbol,
    assetType: sourceAssetType,
    tradeAction: sourceAssetType === "OPTION" ? "SellToClose" : "Sell",
    direction: "long",
    status: "FILLED",
    executedQuantity: sourceQuantity,
    brokerAccountId: "source-account",
    brokerCredentialId: "source-credential",
    venue: "alpaca",
    optionExpiration: sourceOptionExpiration,
    optionStrike: sourceOptionStrike,
    optionType: sourceOptionType,
    createdAt: SOURCE_CLOSE_AT,
    executedAt: SOURCE_CLOSE_AT,
  };
  const sourceHistory = [{
    id: "source-cap-open-order",
    userId: SOURCE_USER_ID,
    symbol: sourceSymbol,
    assetType: sourceAssetType,
    tradeAction: sourceAssetType === "OPTION" ? "BuyToOpen" : "Buy",
    direction: "long",
    status: "FILLED",
    executedQuantity: sourceQuantity,
    brokerAccountId: "source-account",
    venue: "alpaca",
    optionExpiration: sourceOptionExpiration,
    optionStrike: sourceOptionStrike,
    optionType: sourceOptionType,
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
    symbol: sourceSymbol,
    assetType: sourceAssetType,
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
    },
    select: () => ({ from: () => ({ where: async () => [{ value: mirrorsToday }] }) }),
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
  guardOverrides: Partial<typeof baseGuards> = {},
) {
  return (poller as any).processCandidate(candidate, {
    ...baseGuards,
    ...guardOverrides,
  }) as Promise<string>;
}

function resetStub(position: Record<string, unknown> | null, optionBid = 3.25) {
  stub.position = position;
  stub.optionBid = optionBid;
  stub.placedOrders.length = 0;
}

/** The mirrored long the close is entitled to exit. */
const MIRRORED_LONG_100 = { side: "long", qty: "100", qty_available: "100" };

describe("a mirrored equity CLOSE is exempt from the mirror's caps", () => {
  it("exits after the follower's daily cap is fully spent", async () => {
    // The audit's scenario. A followed trader was active in the morning and the
    // mirror placed a full day of buys, so countMirrorsToday reads at the cap.
    // In the afternoon the source closes one of those positions. The cap exists
    // to bound how much NEW exposure the mirror can create in a day, and it has
    // nothing to say about taking exposure away.
    resetStub(MIRRORED_LONG_100);
    const poller = makePoller([mirrorOrder()], DAILY_CAP);

    const outcome = await run(poller, sellCandidate(), { maxOrderDollars: 1_000_000 });

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "sell" });
  });

  it("exits even when the exit's own notional is above the per-order dollar cap", async () => {
    // A $1,000 per-order ceiling against a $10,000 exit at $100. Refusing here
    // is strictly worse than placing: the follower keeps every dollar of the
    // position the mirror opened, and the ceiling was never about how much a
    // follower may be allowed to SELL.
    //
    // The quantity is the MIRRORED position (100), not the 50 shares the
    // `usd:5000` entry rule would buy at today's price. An exit is sized to the
    // position it exits, exactly as a non-ratio perp close is, so this exceeds
    // the $1,000 ceiling by ten times rather than five and the exemption still
    // has to hold. See copy-mirror-equity-exit-proportionality.test.ts.
    resetStub(MIRRORED_LONG_100);
    const poller = makePoller([mirrorOrder()], 0);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ side: "sell", qty: 100 });
  });

  it("exits when both caps are exhausted at once", async () => {
    // Neither cap may be the reason a follower cannot get out, so the two of
    // them together must not be either.
    resetStub(MIRRORED_LONG_100);
    const poller = makePoller([mirrorOrder()], DAILY_CAP);

    const outcome = await run(poller, sellCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
  });
});

describe("the caps still bound every OPENING order", () => {
  it("refuses a BUY once the follower's daily cap is spent", async () => {
    // The other direction, and the reason the exemption is scoped to closes: a
    // buy is new exposure and the cap is the only thing bounding how much of it
    // a day can bring.
    resetStub(null);
    const poller = makePoller([], DAILY_CAP);

    const outcome = await run(
      poller,
      sellCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        tradeAction: "Buy" as const,
        sizingValue: 500,
      }),
      { maxOrderDollars: 1_000_000 },
    );

    expect(outcome).toBe("daily-cap");
    expect(stub.placedOrders).toEqual([]);
  });

  it("refuses a BUY whose notional is above the per-order dollar cap", async () => {
    resetStub(null);
    const poller = makePoller([], 0);

    const outcome = await run(
      poller,
      sellCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        tradeAction: "Buy" as const,
      }),
    );

    expect(outcome).toBe("dollar-cap");
    expect(stub.placedOrders).toEqual([]);
  });
});

describe("a CLOSE that cannot be sized is held, not spent", () => {
  it("requeues an option close whose contract has no readable bid", async () => {
    // `fetchOptionPrice` returns 0 when the sell side has no bid, sizing then
    // yields no shares, and the resulting `no-qty` skip used to be RETURNED,
    // which completes the delivery. An unreadable quote is a statement about
    // the market data feed, not about whether the follower is owed an exit, so
    // the exit is held for the next attempt instead of being consumed.
    resetStub({ side: "long", qty: "5", qty_available: "5" }, /* optionBid */ 0);
    const poller = makePoller(
      [
        mirrorOrder({
          assetType: "OPTION",
          tradeAction: "BuyToOpen",
          quantity: 5,
          executedQuantity: 5,
          optionExpiration: "260918",
          optionStrike: "250.0000",
          optionType: "CALL",
        }),
      ],
      0,
    );

    const promise = run(
      poller,
      sellCandidate({
        assetType: "OPTION",
        tradeAction: "SellToClose",
        optionExpiration: "260918",
        optionStrike: 250,
        optionType: "CALL",
      }),
    );

    await expect(promise).rejects.toThrow(/held back/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("classifies that hold as transient so the delivery is retried", async () => {
    // A returned outcome completes the delivery; a thrown one only requeues it
    // when the classifier calls it transient. Asserting the classification is
    // what makes "held" mean held rather than permanently failed on the first
    // unreadable quote.
    resetStub({ side: "long", qty: "5", qty_available: "5" }, /* optionBid */ 0);
    const poller = makePoller(
      [
        mirrorOrder({
          assetType: "OPTION",
          tradeAction: "BuyToOpen",
          quantity: 5,
          executedQuantity: 5,
          optionExpiration: "260918",
          optionStrike: "250.0000",
          optionType: "CALL",
        }),
      ],
      0,
    );

    let thrown: unknown;
    try {
      await run(
        poller,
        sellCandidate({
          assetType: "OPTION",
          tradeAction: "SellToClose",
          optionExpiration: "260918",
          optionStrike: 250,
          optionType: "CALL",
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(classifyMirrorFailure(thrown).kind).toBe("transient");
  });

  it("still consumes an opening BUY it cannot size", async () => {
    // An entry nobody could price is genuinely finished: the source event ages
    // out, and there is no position depending on it. Only exits are held.
    resetStub(null, /* optionBid */ 0);
    const poller = makePoller([], 0);

    const outcome = await run(
      poller,
      sellCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        assetType: "OPTION",
        tradeAction: "BuyToOpen",
        optionExpiration: "260918",
        optionStrike: 250,
        optionType: "CALL",
        // The buy side reads the ASK, so drive no-qty from the sizing rule
        // instead: $1 buys no whole $3.35 contract at a 100x multiplier.
        sizingValue: 1,
      }),
    );

    expect(outcome).toBe("no-qty");
    expect(stub.placedOrders).toEqual([]);
  });
});

describe("decideMirror caps by intent (pure)", () => {
  /** The pure candidate the caps are evaluated against. */
  const pureCandidate = (overrides: Record<string, unknown> = {}) => ({
    followerUserId: FOLLOWER,
    sourceItemId: "user:trade-1",
    symbol: "AAPL",
    side: "buy" as const,
    sizingMode: "usd" as const,
    sizingValue: 5_000,
    buyingPower: 200_000,
    isPaper: true,
    price: 100,
    mirrorsToday: 0,
    alreadyMirrored: false,
    dailyCap: DAILY_CAP,
    maxOrderDollars: MAX_ORDER_DOLLARS,
    ...overrides,
  });

  it("places a SELL over both caps and refuses the identical BUY", () => {
    const sell = decideMirror(
      pureCandidate({ side: "sell", mirrorsToday: DAILY_CAP }) as never,
      false,
    );
    const buy = decideMirror(pureCandidate({ mirrorsToday: DAILY_CAP }) as never, false);

    expect(sell.action).toBe("place");
    expect(buy.action).toBe("skip");
  });

  it("keeps every guard that is not a cap on the SELL side", () => {
    // The exemption is for the two exposure ceilings only. Dedupe, the live
    // gate and an unsizeable quantity all still refuse a sell, which is what
    // keeps a one-shot exit from being re-sent or placed on an account the
    // operator has not opted in.
    expect(
      decideMirror(pureCandidate({ side: "sell", alreadyMirrored: true }) as never, false),
    ).toMatchObject({ action: "skip", reason: "duplicate" });
    expect(
      decideMirror(pureCandidate({ side: "sell", isPaper: false }) as never, false),
    ).toMatchObject({ action: "skip", reason: "live-not-allowed" });
    expect(
      decideMirror(pureCandidate({ side: "sell", price: 0 }) as never, false),
    ).toMatchObject({ action: "skip", reason: "no-qty" });
  });
});
