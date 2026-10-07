/**
 * Copy-Mirror pipeline integration scenarios.
 *
 * These tests exercise the FULL worker pipeline for each sizing mode end-to-end
 * with stubbed Alpaca + DB layers — `processCandidate` (which decrypts creds,
 * reads account, reads price, reads asset, counts mirrors, resolves the cap,
 * decides, and places). The point is "audible proof" that the new modes
 * actually flow through the same path the production poller uses, not just
 * that the pure math works in isolation.
 *
 * Each scenario logs the would-have-placed order payload (qty, dollars,
 * clientOrderId) so the test output reads like a walkthrough of the pipeline.
 *
 * No real broker, no real DB — we don't have docker locally — but the
 * pipeline shape matches production exactly. Real-paper round-trip needs
 * actual Alpaca paper API keys, which is out of scope for this run.
 */

import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";

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

// Hold the stubbed Alpaca account/price/asset state per test. Tests mutate
// these before triggering the pipeline.
const stub = {
  buyingPower: "100000",
  equity: "50000",
  price: 100,
  fractionable: false,
  // Capture every order Alpaca would have created — this is the "audible proof".
  placedOrders: [] as Array<Record<string, unknown>>,
  // Capture every order row the worker inserted into the local DB.
  insertedOrders: [] as Array<Record<string, unknown>>,
  credentialSelectors: [] as Array<Record<string, unknown>>,
  accountCalls: 0,
  brokerOrders: [] as Array<Record<string, unknown>>,
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async (
    _db: unknown,
    _userId: string,
    selector: Record<string, unknown>,
  ) => {
    stub.credentialSelectors.push(selector);
    const isLive = selector.credentialId === "live-credential";
    return {
      username: isLive ? "live-key-id" : "paper-key-id",
      accessToken: isLive ? "live-secret-key" : "paper-secret-key",
      accountType: isLive ? "LIVE" : "PAPER",
      accountId: isLive ? "live-acct-1" : "paper-acct-1",
    };
  },
}));

mock.module(alpacaShimModule, () => ({
  isPaperAccount: (accountType: string | null | undefined) => accountType !== "LIVE",
}));

mock.module(alpacaPkgModule, () => {
  class AlpacaClient {
    async getAccount() {
      stub.accountCalls += 1;
      return { buying_power: stub.buyingPower, equity: stub.equity };
    }
    async getLatestTrade() {
      return { Price: stub.price };
    }
    async getSnapshot() {
      return { LatestTrade: { Price: stub.price } };
    }
    async getAsset(symbol: string) {
      return { symbol, fractionable: stub.fractionable };
    }
    async getPosition() {
      throw new Error("404");
    }
    async createOrder(req: Record<string, unknown>) {
      stub.placedOrders.push(req);
      return { id: `broker-${stub.placedOrders.length}` };
    }
    async getOrders() {
      return stub.brokerOrders;
    }
  }
  // `mock.module` REPLACES the module, so this object is the whole surface the
  // code under test can import. copy-mirror.ts imports four names; returning
  // only the two the stub overrides makes the other two fail to link, which is
  // what broke this suite when isAlpacaAmbiguousOrderError was added. Re-export
  // the real implementations for the names the stub has no reason to fake.
  return {
    AlpacaClient,
    createBrokerClientOrderId: brokerIdForCopy,
    isAlpacaAmbiguousOrderError: realAlpaca.isAlpacaAmbiguousOrderError,
    resolveTimeInForce: realAlpaca.resolveTimeInForce,
  };
});

const { CopyMirrorPoller } = await import("../copy-mirror");

/** Minimal DB stub: zero existing orders, capture inserts, count = 0. */
/** Mirrors already placed today, as countMirrorsToday() would report. Tests that
 *  exercise the daily cap can raise this; the default is a fresh account. */
let mirrorsTodayCount = 0;

/**
 * The follow row every scenario is staged against.
 *
 * `processCandidate` re-reads `copy_trade_follows` before placing and refuses an
 * intent it cannot tie back to a live, still-armed follow pointing at the same
 * destination account. That is the production contract, and every candidate the
 * builder stages carries `followId` (a PK) and `sourceEventAt` (a NOT NULL
 * timestamp), so a fixture without them is describing a delivery that cannot
 * exist. `armFollow` puts the row in place; `mirrorCandidate` stamps the two
 * fields on the payload.
 */
const FOLLOW_ID = "66666666-6666-4666-8666-666666666666";
let currentFollow: Record<string, unknown> | null = null;

function armFollow(
  followerUserId: string,
  credentialId: string | null,
  stockSizingMode = "usd",
  stockSizingValue: number | string = 500,
) {
  const hasCredential = credentialId !== null;
  currentFollow = {
    id: FOLLOW_ID,
    followerUserId,
    autoMirror: hasCredential,
    credentialId,
    destinationPolicyInitialized: true,
    stockAutoMirror: hasCredential,
    stockCredentialId: credentialId,
    stockSizingMode,
    stockSizingValue: String(stockSizingValue),
    perpAutoMirror: false,
    perpCredentialId: null,
    perpSizingMode: "pct",
    perpSizingValue: "5",
  };
}

function fakeDb(existingOrder?: Record<string, unknown>) {
  return {
    query: {
      orders: {
        findFirst: async () => existingOrder,
        findMany: async () => [],
      },
      userApiCredentials: {
        findFirst: async () => ({ id: "paper-credential", provider: "alpaca" }),
      },
      copyTradeFollows: {
        findFirst: async () => currentFollow,
      },
    },
    insert: () => ({
      values(value: Record<string, unknown>) {
        stub.insertedOrders.push(value);
        return {
            onConflictDoNothing: () => ({
              returning: async () => existingOrder
                ? []
                : [{ id: `local-${stub.insertedOrders.length}` }],
          }),
        };
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{ id: "updated" }] }) }),
    }),
    // countMirrorsToday() counts today's mirrors to enforce the daily cap. It
    // treats a THROWN query as "unavailable" and returns null, which makes the
    // poller refuse to mirror at all. Without a select() stub this fake db threw,
    // so every scenario aborted before placing an order. Report zero mirrors so
    // far, which is what a fresh test account has.
    select: () => ({
      from: () => ({
        where: async () => [{ value: mirrorsTodayCount }],
      }),
    }),
  } as never;
}

interface Scenario {
  name: string;
  expectedQty: number;
  expectedDollars: number;
  candidate: {
    followerUserId: string;
    sourceItemId: string;
    symbol: string;
    side: "buy" | "sell";
    sizingMode: "pct" | "pct_equity" | "usd" | "ratio";
    sizingValue: number;
    assetType: "EQUITY" | "OPTION";
    tradeAction?: "Buy" | "Sell";
    sourceQty?: number;
    credentialId?: string | null;
  };
  account?: { buyingPower?: string; equity?: string };
  maxOrderDollars?: number;
}

/**
 * The candidate as the builder would have staged it: the scenario's own fields,
 * plus the follow id and source timestamp every real delivery carries. Both are
 * placed BEFORE the spread so a scenario can still override either one.
 */
function mirrorCandidate<T extends Scenario["candidate"]>(candidate: T) {
  return {
    credentialId: "paper-credential" as string | null,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    ...candidate,
  };
}

async function runScenario(s: Scenario) {
  // Reset captured state for this scenario.
  stub.placedOrders.length = 0;
  stub.insertedOrders.length = 0;
  stub.credentialSelectors.length = 0;
  stub.accountCalls = 0;
  stub.brokerOrders.length = 0;
  if (s.account?.buyingPower !== undefined) stub.buyingPower = s.account.buyingPower;
  if (s.account?.equity !== undefined) stub.equity = s.account.equity;

  const candidate = mirrorCandidate(s.candidate);
  // The live follow must still point at the account the candidate was staged
  // against, or consent correctly refuses before anything is decrypted.
  armFollow(
    candidate.followerUserId,
    candidate.credentialId ?? null,
    candidate.sizingMode,
    candidate.sizingValue,
  );

  const poller = new CopyMirrorPoller(fakeDb());
  await (
    poller as unknown as {
      processCandidate: (
        cand: typeof candidate,
        guards: { dailyCap: number; maxOrderDollars: number; liveAllowed: boolean },
      ) => Promise<void>;
    }
  ).processCandidate(candidate, {
    dailyCap: 20,
    maxOrderDollars: s.maxOrderDollars ?? 1_000,
    liveAllowed: false,
  });

  return {
    placed: stub.placedOrders[0],
    inserted: stub.insertedOrders[0],
  };
}

describe("the daily cap actually stops a mirror", () => {
  // The `select()` stub exists precisely so this branch is reachable, and the
  // suite had no scenario that raised the count, so the guardrail that stands
  // between a runaway signal source and a follower's account went unexercised.
  // It is a REAL-MONEY guard: nothing else here bounds how many orders one
  // follow can place in a day.
  const candidate = {
    followerUserId: "user-1",
    sourceItemId: "item-cap",
    symbol: "AAPL",
    side: "buy" as const,
    sizingMode: "usd" as const,
    sizingValue: 500,
    assetType: "EQUITY" as const,
  };

  async function runWithMirrorsToday(count: number, dailyCap: number) {
    mirrorsTodayCount = count;
    stub.placedOrders.length = 0;
    stub.insertedOrders.length = 0;
    const staged = mirrorCandidate(candidate);
    armFollow(
      staged.followerUserId,
      staged.credentialId ?? null,
      staged.sizingMode,
      staged.sizingValue,
    );
    const poller = new CopyMirrorPoller(fakeDb());
    await (
      poller as unknown as {
        processCandidate: (
          cand: typeof staged,
          guards: {
            dailyCap: number;
            maxOrderDollars: number;
            liveAllowed: boolean;
          },
        ) => Promise<void>;
      }
    ).processCandidate(
      staged,
      { dailyCap, maxOrderDollars: 1_000, liveAllowed: false },
    );
    mirrorsTodayCount = 0;
    return { placed: stub.placedOrders[0], inserted: stub.insertedOrders[0] };
  }

  it("places nothing once the follow has hit its daily cap", async () => {
    const result = await runWithMirrorsToday(5, 5);
    expect(result.placed).toBeUndefined();
    expect(result.inserted).toBeUndefined();
  });

  it("still places while under the cap", async () => {
    // The other half: a cap that never lets anything through would pass the
    // test above for the wrong reason.
    const result = await runWithMirrorsToday(4, 5);
    expect(result.placed).toBeDefined();
  });

  it("treats the cap as inclusive, not off by one", async () => {
    await expect(
      runWithMirrorsToday(6, 5).then((r) => r.placed),
    ).resolves.toBeUndefined();
  });
});

describe("integration: pipeline places the right order for each sizing mode", () => {
  it("reconciles a pending transient attempt before recalculating account sizing", async () => {
    stub.placedOrders.length = 0;
    stub.insertedOrders.length = 0;
    stub.credentialSelectors.length = 0;
    stub.accountCalls = 0;
    // The broker holds the bounded "rst-copy-<hash>" id the worker actually
    // submits, not the ~89 char logical key, which the client rejects for
    // length before it can ever reach Alpaca. Seeding the logical key here
    // would fake a value the venue can never return.
    stub.brokerOrders = [
      {
        id: "broker-recovered",
        client_order_id: brokerIdForCopy("f-recover", "copymirror:f-recover:user:t-recover"),
      },
    ];
    const poller = new CopyMirrorPoller(
      fakeDb({
        id: "local-recover",
        status: "PENDING",
        brokerOrderId: null,
        clientOrderId: "copymirror:f-recover:user:t-recover",
        quantity: 4,
        limitPrice: null,
      }),
    );

    const staged = mirrorCandidate({
      followerUserId: "f-recover",
      credentialId: "paper-credential",
      sourceItemId: "user:t-recover",
      symbol: "AAPL",
      side: "buy" as const,
      sizingMode: "usd" as const,
      sizingValue: 900,
      assetType: "EQUITY" as const,
      tradeAction: "Buy" as const,
    });
    armFollow(
      staged.followerUserId,
      staged.credentialId ?? null,
      staged.sizingMode,
      staged.sizingValue,
    );

    const outcome = await (
      poller as unknown as {
        processCandidate: (
          candidate: typeof staged,
          guards: { dailyCap: number; maxOrderDollars: number; liveAllowed: boolean },
        ) => Promise<string>;
      }
    ).processCandidate(
      staged,
      { dailyCap: 20, maxOrderDollars: 1_000, liveAllowed: false },
    );

    expect(outcome).toBe("placed");
    expect(stub.accountCalls).toBe(0);
    expect(stub.placedOrders).toEqual([]);
  });

  it("fails closed before decryption when a candidate has no selected credential", async () => {
    const { placed } = await runScenario({
      name: "missing selected account",
      expectedQty: 0,
      expectedDollars: 0,
      candidate: {
        followerUserId: "f-missing",
        sourceItemId: "user:t-missing-account",
        symbol: "AAPL",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "EQUITY",
        tradeAction: "Buy",
        credentialId: null,
      },
    });

    expect(stub.credentialSelectors).toEqual([]);
    expect(placed).toBeUndefined();
  });

  it("decrypts only the Live credential selected by a follow when both account types exist", async () => {
    const { placed } = await runScenario({
      name: "selected live account",
      expectedQty: 5,
      expectedDollars: 500,
      candidate: {
        followerUserId: "f-selected",
        sourceItemId: "user:t-selected-live",
        symbol: "AAPL",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "EQUITY",
        tradeAction: "Buy",
        credentialId: "live-credential",
      },
    });

    expect(stub.credentialSelectors).toEqual([
      { provider: "alpaca", credentialId: "live-credential" },
    ]);
    expect(placed).toBeUndefined();
  });

  it("usd: $500 sizing, $100 price → 5 shares, $500 order", async () => {
    const { placed, inserted } = await runScenario({
      name: "usd",
      expectedQty: 5,
      expectedDollars: 500,
      candidate: {
        followerUserId: "f-1",
        sourceItemId: "user:t-usd",
        symbol: "AAPL",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 500,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toMatchObject({
      symbol: "AAPL",
      qty: 5,
      side: "buy",
      type: "market",
      client_order_id: brokerIdForCopy("f-1", "copymirror:f-1:user:t-usd"),
    });
    expect(inserted).toMatchObject({ userId: "f-1", quantity: 5 });
  });

  it("pct: 5% of $100k buying power places 50 shares at an explicit $5k ceiling", async () => {
    const { placed } = await runScenario({
      name: "pct",
      expectedQty: 50,
      expectedDollars: 5000,
      maxOrderDollars: 5_000,
      account: { buyingPower: "100000", equity: "50000" },
      candidate: {
        followerUserId: "f-2",
        sourceItemId: "user:t-pct",
        symbol: "TSLA",
        side: "buy",
        sizingMode: "pct",
        sizingValue: 5,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toMatchObject({
      symbol: "TSLA",
      qty: 50,
      side: "buy",
      type: "market",
    });
  });

  it("pct_equity: 10% of $50k equity, $100 price → 50 shares (M-1 new mode)", async () => {
    const { placed } = await runScenario({
      name: "pct_equity",
      expectedQty: 50,
      expectedDollars: 5000,
      maxOrderDollars: 5_000,
      account: { buyingPower: "100000", equity: "50000" },
      candidate: {
        followerUserId: "f-3",
        sourceItemId: "user:t-pcteq",
        symbol: "NVDA",
        side: "buy",
        sizingMode: "pct_equity",
        sizingValue: 10,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toMatchObject({ symbol: "NVDA", qty: 50 });
  });

  it("pct_equity vs pct on a margin account give DIFFERENT qty (M-1: the whole point)", async () => {
    // buying_power = 4× equity (DTBP). 5% on each.
    const pctResult = await runScenario({
      name: "pct (margin)",
      expectedQty: 200,
      expectedDollars: 20000,
      maxOrderDollars: 20_000,
      account: { buyingPower: "400000", equity: "100000" },
      candidate: {
        followerUserId: "f-pct",
        sourceItemId: "user:t-margin-pct",
        symbol: "SPY",
        side: "buy",
        sizingMode: "pct",
        sizingValue: 5,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    const pctEqResult = await runScenario({
      name: "pct_equity (margin)",
      expectedQty: 50,
      expectedDollars: 5000,
      maxOrderDollars: 5_000,
      account: { buyingPower: "400000", equity: "100000" },
      candidate: {
        followerUserId: "f-pcteq",
        sourceItemId: "user:t-margin-pcteq",
        symbol: "SPY",
        side: "buy",
        sizingMode: "pct_equity",
        sizingValue: 5,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    // Same "5%", same account, but pct sizes off the 4× leveraged base (200
    // shares = $20k order) while pct_equity sizes off the unleveraged equity
    // (50 shares = $5k). The new mode delivers what users with margin
    // accounts probably actually wanted to express.
    expect(pctResult.placed?.qty).toBe(200);
    expect(pctEqResult.placed?.qty).toBe(50);
  });

  it("ratio: 0.5 × source 10 → 5 shares (M-3 new mode)", async () => {
    const { placed } = await runScenario({
      name: "ratio",
      expectedQty: 5,
      expectedDollars: 500,
      candidate: {
        followerUserId: "f-4",
        sourceItemId: "user:t-ratio",
        symbol: "MSFT",
        side: "buy",
        sizingMode: "ratio",
        sizingValue: 0.5,
        sourceQty: 10,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toMatchObject({ symbol: "MSFT", qty: 5 });
  });

  it("ratio without sourceQty skips with no-qty (signals path)", async () => {
    const { placed } = await runScenario({
      name: "ratio (no sourceQty)",
      expectedQty: 0,
      expectedDollars: 0,
      candidate: {
        followerUserId: "f-5",
        sourceItemId: "x_signal:sig-1",
        symbol: "META",
        side: "buy",
        sizingMode: "ratio",
        sizingValue: 1,
        // sourceQty: undefined — content-only signal
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toBeUndefined();
  });

  it("H-2: a typed follow with pct=500 fails closed at the worker", async () => {
    const { placed } = await runScenario({
      name: "pct=500 (typed fail-closed)",
      expectedQty: 0,
      expectedDollars: 0,
      maxOrderDollars: 100_000,
      account: { buyingPower: "100000", equity: "100000" },
      candidate: {
        followerUserId: "f-6",
        sourceItemId: "user:t-legacy-pct",
        symbol: "QQQ",
        side: "buy",
        sizingMode: "pct",
        sizingValue: 500, // deliberately invalid persisted policy
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toBeUndefined();
    expect(stub.credentialSelectors).toEqual([]);
  });

  it("keeps the configured $1k ceiling absolute for a $5k percent-sized order", async () => {
    const { placed } = await runScenario({
      name: "H-1 scaled cap",
      expectedQty: 50,
      expectedDollars: 5000,
      account: { buyingPower: "100000", equity: "50000" },
      candidate: {
        followerUserId: "f-7",
        sourceItemId: "user:t-cap",
        symbol: "GOOG",
        side: "buy",
        sizingMode: "pct",
        sizingValue: 5,
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toBeUndefined();
  });

  it("M-2 (math wired, integration inert): equity falls back to whole shares until orders.quantity widens", async () => {
    // The fractional path is wired through computeMirrorQty but
    // isSymbolFractionable() returns false unconditionally pending the DB
    // migration. So $99 on a $100 stock still skips with no-qty.
    stub.fractionable = true; // would matter once isSymbolFractionable flips on
    const { placed } = await runScenario({
      name: "fractional inert",
      expectedQty: 0,
      expectedDollars: 0,
      candidate: {
        followerUserId: "f-8",
        sourceItemId: "user:t-frac",
        symbol: "AMZN",
        side: "buy",
        sizingMode: "usd",
        sizingValue: 99, // < 1 share at $100
        assetType: "EQUITY",
        tradeAction: "Buy",
      },
    });
    expect(placed).toBeUndefined();
    stub.fractionable = false;
  });
});
