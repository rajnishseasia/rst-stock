/**
 * The reconciler must not invent a broker state for an order the broker never got.
 *
 * copy-mirror deliberately leaves its local row PENDING when `createOrder` dies
 * in transport, because PENDING is the marker its own retry reads to RESUME the
 * stored intent instead of re-deciding it. OrderSyncPoller scans exactly that
 * row (non-PERP, status PENDING), has no `brokerOrderId` to look it up by, and
 * so asks Alpaca by client order id. Alpaca answers 404, because the order was
 * never submitted, and the catch block rewrote the row to SYNCING.
 *
 * That single write is the whole bug. copy-mirror's dedupe reads anything other
 * than PENDING as "already mirrored", so the retry thirty seconds later logged
 * `skip: duplicate (already mirrored)`, returned "duplicate", and the poll loop
 * marked the delivery COMPLETED, which is terminal. No order was ever placed at
 * the broker, every log line said the delivery succeeded, and the follower kept
 * a position the source had exited.
 *
 * These tests drive the REAL `OrderSyncPoller.pollOnce` and the REAL
 * `CopyMirrorPoller.processCandidate` over ONE shared row object, so the second
 * test reproduces the production hand-off rather than asserting a status string
 * in isolation. The third test is the counterweight: an AMBIGUOUS lookup failure
 * (timeout, 5xx) still escalates to SYNCING, because there the broker may
 * genuinely be holding the order and the row is not ours to call absent.
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

const FOLLOWER = "follower-ordersync-race";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const FOLLOW_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ITEM_ID = "user:source-nvda-close";
const CLIENT_ORDER_ID = `copymirror:${FOLLOWER}:${SOURCE_ITEM_ID}`;
const BROKER_CLIENT_ORDER_ID = brokerIdForCopy(FOLLOWER, CLIENT_ORDER_ID);

/** Alpaca-side state the copy-mirror half of each test reads. */
const stub = {
  /** The follower's live long, still intact: they never sold it themselves. */
  position: { side: "long", qty: "100", qty_available: "100" } as Record<string, unknown> | null,
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
      // transport, which is exactly why the row is still awaiting a resume.
      return [];
    }
  }
  // `mock.module` REPLACES the module, so re-export the names the stub has no
  // reason to fake or copy-mirror.ts / order-sync.ts fail to link against them.
  return {
    AlpacaClient,
    createBrokerClientOrderId: brokerIdForCopy,
    deriveClientOrderId: realAlpaca.deriveClientOrderId,
    isAlpacaAmbiguousOrderError: realAlpaca.isAlpacaAmbiguousOrderError,
    resolveTimeInForce: realAlpaca.resolveTimeInForce,
  };
});

const { OrderSyncPoller } = await import("../order-sync");
const { CopyMirrorPoller } = await import("../copy-mirror");

const guards = {
  dailyCap: 20,
  maxOrderDollars: 1_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/**
 * The row a transient `createOrder` failure leaves behind: sized, clamped and
 * recorded locally, with nothing at the broker to point at.
 */
function neverSubmittedMirrorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-mirror-nvda",
    userId: FOLLOWER,
    symbol: "NVDA",
    assetType: "EQUITY",
    status: "PENDING" as string,
    brokerOrderId: null,
    clientOrderId: CLIENT_ORDER_ID,
    brokerClientOrderId: BROKER_CLIENT_ORDER_ID,
    quantity: 100,
    executedQuantity: null,
    limitPrice: null,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    tradeAction: "Sell",
    orderType: "Market",
    brokerAccountId: "paper-acct-1",
    brokerCredentialId: "paper-credential",
    copySourceLabel: "Whale",
    exitPlanStatus: null,
    exitPlan: null,
    syncAttempts: 0,
    // Widened deliberately: `syncReason` and `status` are what the reconciler
    // writes, and a fixture that narrowed them to their initial literals could
    // not be asserted against afterwards.
    syncReason: null as string | null,
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
    symbol: "NVDA",
    side: "sell" as const,
    sizingMode: "usd" as const,
    sizingValue: 500,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/**
 * An OrderSyncPoller whose every `set(...)` lands on the shared row, so the
 * copy-mirror half of the test reads the state the reconciler actually left.
 */
function runOrderSync(row: Record<string, unknown>, lookupError: unknown) {
  const poller = new OrderSyncPoller(
    {
      // A COPY, like a real read: the poller must not mutate the caller's row
      // except through the update it decides to issue.
      query: { orders: { findMany: async () => [{ ...row }] } },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            Object.assign(row, values);
          },
        }),
      }),
    } as never,
    {
      getCredentials: (async () => ({
        credentialId: row.brokerCredentialId,
        accountId: row.brokerAccountId,
        accountType: "PAPER",
        username: "paper-key",
        accessToken: "paper-secret",
      })) as never,
      createClient: () => ({
        getOrderByClientId: async () => {
          throw lookupError;
        },
      }) as never,
      notify: (async () => {}) as never,
    },
  );
  return poller.pollOnce();
}

/**
 * A CopyMirrorPoller over the same row, shaped like the resume harness in
 * copy-mirror-resume-sell-clamp.test.ts: the insert conflicts (the row exists),
 * so `placeMirrorOrder` takes its recovery path and the submitted quantity is
 * read back off the row.
 */
function makeMirrorPoller(row: Record<string, unknown>, updates: Array<Record<string, unknown>>) {
  const db = {
    query: {
      orders: {
        findFirst: async () => row,
        // No mirrored history on file for this symbol, so the exposure read is
        // answerable and empty. The resume clamps against the live long instead.
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
        }),
      },
      // Nothing else queued: no paired open is waiting for a retry, so the
      // close-pairing guard has no reason to hold this exit.
      copyMirrorDeliveries: {
        findMany: async () => [],
      },
    },
    select: () => ({
      from: () => ({
        // The real count excludes the row being resumed, so the stub does too:
        // a blanket count would let a resumed order block itself on the cap.
        where: async () => [{ value: 0 }],
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        if ("quantity" in values) row.quantity = values.quantity;
        const rows = [{ id: row.id }];
        // A real Promise carrying an extra `returning`, so both shapes the
        // production code uses work.
        const result = Object.assign(Promise.resolve(rows), {
          returning: async () => rows,
        });
        return { where: () => result };
      },
    }),
  } as never;
  return new CopyMirrorPoller(db);
}

function notFoundAtBroker() {
  // What Alpaca answers for a client order id it has never seen. The 404 is the
  // proof: this order was never submitted.
  return Object.assign(new Error("order not found"), { status: 404 });
}

describe("order-sync must not consume a never-submitted copy-mirror order", () => {
  it("leaves a never-submitted PENDING mirror row PENDING when the broker 404s its client order id", async () => {
    const row = neverSubmittedMirrorRow();

    await runOrderSync(row, notFoundAtBroker());

    // SYNCING claims the broker has this order and we cannot read it. A 404 on a
    // row that never carried a brokerOrderId says the opposite, and PENDING is
    // the only status copy-mirror will resume from.
    expect(row.status).toBe("PENDING");
    expect(row.brokerOrderId).toBeNull();
    // The attempt is still recorded: the reconciler keeps its bookkeeping, it
    // just stops rewriting a status it has proof it does not own.
    expect(row.syncAttempts).toBe(1);
    expect(row.syncReason).toBe("order not found");
  });

  it("lets the copy-mirror retry resume the mirror instead of retiring the delivery as a duplicate", async () => {
    // The audit's scenario end to end. The mirror SELL was sized, clamped to the
    // follower's held long and inserted PENDING; createOrder threw ECONNRESET,
    // so the delivery was requeued for +30s. At +12s the reconciler ticks.
    const row = neverSubmittedMirrorRow();
    stub.position = { side: "long", qty: "100", qty_available: "100" };
    stub.placedOrders.length = 0;
    const updates: Array<Record<string, unknown>> = [];

    await runOrderSync(row, notFoundAtBroker());
    const outcome = await (makeMirrorPoller(row, updates) as never as {
      processCandidate: (cand: unknown, guards: unknown) => Promise<string>;
    }).processCandidate(sellCandidate(), guards);

    // "duplicate" here would retire the delivery permanently while no order
    // exists anywhere, leaving the follower long a position the source exited.
    expect(outcome).toBe("placed");
    expect(stub.placedOrders).toHaveLength(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "NVDA", side: "sell", qty: 100 });
  });

  it("still escalates an ambiguous lookup failure to SYNCING", async () => {
    // The counterweight. A timeout is not proof of absence: the broker may be
    // holding the order, so the row is not ours to call never-submitted and the
    // existing reconciliation behavior has to survive the fix above.
    const row = neverSubmittedMirrorRow();

    await runOrderSync(row, new Error("broker lookup timed out"));

    expect(row.status).toBe("SYNCING");
    expect(row.syncReason).toBe("broker lookup timed out");
    expect(row.syncAttempts).toBe(1);
  });
});
