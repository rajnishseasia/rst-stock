/**
 * The per-order dollar cap has to survive a PENDING equity/option BUY resume.
 *
 * `processCandidate` short-circuits a stored PENDING resume straight into
 * `placeMirrorOrder`, deliberately skipping the fresh account/quote reads so a
 * wedged delivery re-sends the exact intent it already sized (`ffc3e02` added
 * the daily-cap re-count to this branch for the same reason: the row's
 * approval is about the world THEN, not about the world NOW). The per-order
 * dollar cap never got that re-check: a resumed BUY re-sends the STORED
 * quantity as a MARKET order with no price read at all, so a symbol that
 * gapped while the delivery sat behind a transient failure resumes at a
 * notional the cap never actually cleared.
 *
 * `decidePerpResumeParity` draws the identical line on the perp side
 * ("the stored size is re-priced off a live mid so the per-order dollar cap
 * ... judge the order the venue would actually get"), and both caps come from
 * the same `resolveGuardrails()`. This file locks in the equity half of that
 * rule.
 *
 * Companion to `copy-mirror-resume-sell-clamp.test.ts`, which covers the
 * SELL-side clamp and the already-fixed daily-cap re-check on this same
 * branch.
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

const FOLLOWER = "follower-resume-dollar-cap";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const FOLLOW_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ITEM_ID = "user:source-open";
const CLIENT_ORDER_ID = `copymirror:${FOLLOWER}:${SOURCE_ITEM_ID}`;

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  /** The live price `fetchPrice` reads on the resume re-check. */
  price: 100,
  priceReads: 0,
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
      stub.priceReads += 1;
      return { Price: stub.price };
    }
    async getSnapshot() {
      stub.priceReads += 1;
      return { LatestTrade: { Price: stub.price } };
    }
    async getLatestOptionQuote() {
      stub.priceReads += 1;
      return { latestQuote: { bp: stub.price, ap: stub.price } };
    }
    async getAsset(symbol: string) {
      return { symbol, fractionable: false };
    }
    async getPosition() {
      throw Object.assign(new Error("position does not exist"), { status: 404 });
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
    id: "local-resume-buy",
    userId: FOLLOWER,
    symbol: "AAPL",
    assetType: "EQUITY",
    status: "PENDING",
    brokerOrderId: null,
    clientOrderId: CLIENT_ORDER_ID,
    quantity: 10,
    limitPrice: null,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    tradeAction: "Buy",
    brokerAccountId: "paper-acct-1",
    brokerCredentialId: "paper-credential",
    copySourceLabel: "Whale",
    ...overrides,
  };
}

function buyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: SOURCE_ITEM_ID,
    symbol: "AAPL",
    side: "buy" as const,
    sizingMode: "usd" as const,
    sizingValue: 900,
    assetType: "EQUITY" as const,
    tradeAction: "Buy" as const,
    ...overrides,
  };
}

interface DbSink {
  updates: Array<Record<string, unknown>>;
}

function freshSink(): DbSink {
  return { updates: [] };
}

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
      copyMirrorDeliveries: {
        findMany: async () => [],
      },
    },
    select: () => ({
      from: () => ({
        where: async (clause: unknown) => {
          // The real count EXCLUDES the row being resumed, so the stub has to as
          // well, exactly as in copy-mirror-resume-sell-clamp.test.ts.
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
        const rows = [{ id: row.id }];
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

function resetStub(price: number) {
  stub.price = price;
  stub.priceReads = 0;
  stub.accountCalls = 0;
  stub.placedOrders.length = 0;
}

describe("equity PENDING resume re-checks the per-order dollar cap", () => {
  it("refuses a resumed BUY whose stored quantity now breaches the dollar cap at the live price", async () => {
    // 10 shares stored, symbol reopens (halt/gap) at $260: $2,600 against a
    // $1,000 per-order cap. The original attempt priced this fine before the
    // submit failed transiently; nothing re-checks it on the resume today.
    resetStub(260);
    const sink = freshSink();
    const poller = makePoller(storedRow({ quantity: 10 }), sink);

    const outcome = await resume(poller, buyCandidate());

    expect(outcome).toBe("dollar-cap");
    expect(stub.placedOrders).toEqual([]);
    // The live price was actually read, not assumed.
    expect(stub.priceReads).toBeGreaterThan(0);
  });

  it("leaves the refused row PENDING for the reconciler", async () => {
    // The first attempt may have reached Alpaca with its response lost, so the
    // row is not ours to retire on a dollar-cap refusal either.
    resetStub(260);
    const sink = freshSink();
    const poller = makePoller(storedRow({ quantity: 10 }), sink);

    await resume(poller, buyCandidate());

    expect(sink.updates.some((values) => "status" in values)).toBe(false);
  });

  it("still places a resumed BUY when the re-priced notional clears the cap", async () => {
    // The other half: a check that refused everything would pass the test
    // above for the wrong reason. 10 shares at $90 is $900, under the $1,000
    // cap, so the resume must go through exactly as before this fix.
    resetStub(90);
    const sink = freshSink();
    const row = storedRow({ quantity: 10 });
    const poller = makePoller(row, sink);

    const outcome = await resume(poller, buyCandidate());

    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "buy", qty: 10 });
    // Still the durable intent: no fresh ACCOUNT sizing read happened, only the
    // price re-read the cap re-check needs.
    expect(stub.accountCalls).toBe(0);
  });

  it("applies the re-check to a resumed option BuyToOpen as well", async () => {
    // Options resume through the same branch, and the per-contract 100x
    // multiplier makes an unchecked resume even more dangerous: 2 contracts at
    // a $15 premium is $3,000, well past a $1,000 cap.
    resetStub(15);
    const sink = freshSink();
    const poller = makePoller(
      storedRow({
        assetType: "OPTION",
        tradeAction: "BuyToOpen",
        optionExpiration: "260918",
        optionStrike: "250",
        optionType: "CALL",
        quantity: 2,
        limitPrice: "15",
      }),
      sink,
    );

    const outcome = await resume(
      poller,
      buyCandidate({
        assetType: "OPTION",
        tradeAction: "BuyToOpen",
        optionExpiration: "260918",
        optionStrike: 250,
        optionType: "CALL",
      }),
    );

    expect(outcome).toBe("dollar-cap");
    expect(stub.placedOrders).toEqual([]);
  });

  it("never re-checks the dollar cap for a resumed SELL", async () => {
    // An exit is not new exposure: the dollar cap only ever bounded OPENS on
    // the fresh path, and the resume must not become the one place a SELL is
    // gated on it. No price read at all should happen for a sell resume.
    resetStub(1_000_000); // even an absurd price must not matter here
    const sink = freshSink();
    const poller = makePoller(
      storedRow({ tradeAction: "Sell", quantity: 10 }),
      sink,
    );

    const outcome = await resume(
      poller,
      buyCandidate({ side: "sell" as const, tradeAction: "Sell" as const }),
    );

    expect(outcome).toBe("no-long-position");
    expect(stub.priceReads).toBe(0);
  });
});
