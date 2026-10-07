/**
 * alpaca-02: Alpaca's wash-trade / insufficient-shares rejection arrives as
 * HTTP 403, and `classifyMirrorFailure` used to fall it through to
 * "permanent" (only 408/409/425/429/5xx were treated as transient). For a
 * mirrored equity CLOSE that meant one shot: `placeMirrorOrder` wrote the
 * local order row REJECTED and rethrew, `markDeliveryFailed` sent any
 * `kind: "permanent"` straight to `permanent_failure` on attempt 1 (the
 * close exemption only lifts the ATTEMPT CEILING for transient failures, it
 * does not touch the permanent branch), and nothing ever regenerates a
 * source close. The follower is left holding the mirrored position with its
 * one exit already spent.
 *
 * Per docs.alpaca.markets/docs/user-protection, a 403 wash-trade refusal is
 * defined by the follower's OTHER open order, not by anything wrong with
 * this request, so it clears on its own once that order fills or is
 * cancelled -- it is transient by construction, exactly like the 408/409/
 * 425/429/5xx statuses already in the classifier.
 *
 * These tests drive the REAL `processCandidate` with a stubbed Alpaca client
 * whose `createOrder` answers a closing SELL with the wash-trade 403, so
 * they exercise the production path rather than re-implementing it.
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

const FOLLOWER = "follower-wash-trade";
const FOLLOW_CREDENTIAL_ID = "55555555-5555-4555-8555-555555555555";
const OPEN_CREDENTIAL_ID = "66666666-6666-4666-8666-666666666666";
const FOLLOW_ID = "77777777-7777-4777-8777-777777777777";

/** Alpaca's wash-trade rejection, shaped the way the SDK actually surfaces it. */
const washTradeRejection = () =>
  Object.assign(
    new Error(
      "{\"code\":40310000,\"message\":\"potential wash trade detected. use complex orders...\"}",
    ),
    { response: { status: 403 } },
  );

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
      return { buying_power: "200000", equity: "200000" };
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
      // The follower holds the 100 shares the mirror opened for them, so this
      // is a genuine close (not a "no-long-position" skip) that only fails
      // because a resting order of the follower's own is open on the symbol.
      return { side: "long", qty: "100", qty_available: "100" };
    }
    async createOrder() {
      throw washTradeRejection();
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

const { CopyMirrorPoller, classifyMirrorFailure } = await import("../copy-mirror");

const baseGuards = {
  dailyCap: 20,
  maxOrderDollars: 1_000_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/** One of the follower's own mirror order rows, as the exposure read sees it. */
function mirrorOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-earlier-open",
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

function closeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    credentialId: FOLLOW_CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:source-close",
    symbol: "AAPL",
    side: "sell" as const,
    sizingMode: "usd" as const,
    sizingValue: 10_000,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/** Records every `orders` row update so a test can assert what was written. */
function makePoller(history: Array<Record<string, unknown>>) {
  const updateSets: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      orders: {
        findFirst: async () => undefined,
        findMany: async () => history,
      },
      userApiCredentials: {
        findFirst: async () => ({ id: FOLLOW_CREDENTIAL_ID, provider: "alpaca" }),
      },
      copyTradeFollows: {
        findFirst: async () => ({
          id: FOLLOW_ID,
          followerUserId: FOLLOWER,
          autoMirror: true,
          credentialId: FOLLOW_CREDENTIAL_ID,
        }),
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
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        const result = Object.assign(Promise.resolve([{ id: "local-fresh" }]), {
          returning: async () => [{ id: "local-fresh" }],
        });
        return { where: () => result };
      },
    }),
  } as never;
  return { poller: new CopyMirrorPoller(db), updateSets };
}

function run(
  poller: InstanceType<typeof CopyMirrorPoller>,
  candidate: Record<string, unknown>,
) {
  return (poller as any).processCandidate(candidate, baseGuards) as Promise<string>;
}

describe("a 403 wash-trade rejection on a mirrored equity CLOSE", () => {
  it("classifies the broker's 403 as transient, not permanent", () => {
    // This is the direct fix: Alpaca's wash-trade / insufficient-shares 403 is
    // a statement about the follower's OTHER open order, which clears on its
    // own, so it belongs with the already-transient 408/409/425/429/5xx set.
    expect(
      classifyMirrorFailure({
        response: { status: 403 },
        message: "potential wash trade detected",
      }).kind,
    ).toBe("transient");
  });

  it("rejects the delivery instead of silently completing it, and never writes REJECTED locally", async () => {
    const { poller, updateSets } = makePoller([mirrorOrder()]);

    let thrown: unknown;
    try {
      await run(poller, closeCandidate());
    } catch (error) {
      thrown = error;
    }

    // The submission must actually fail upward -- a returned outcome would be
    // handed straight to `markDeliveryCompleted`, which is terminal.
    expect(thrown).toBeDefined();

    // The classifier drives what `markDeliveryFailed` does with this error:
    // "transient" means requeue (and, for a close, exempt from the attempt
    // ceiling entirely); "permanent" means `permanent_failure` on attempt 1
    // with zero retries. This is the revert proof for the bug.
    expect(classifyMirrorFailure(thrown).kind).toBe("transient");

    // `placeMirrorOrder` only ever writes `status: "REJECTED"` locally when
    // `classifyMirrorFailure(err).kind === "permanent"`. A transient
    // classification must never mark the order rejected, because the broker
    // never accepted it and never permanently refused it either -- it may
    // still succeed once the interfering order clears.
    const rejectedWrites = updateSets.filter((set) => set.status === "REJECTED");
    expect(rejectedWrites).toEqual([]);
  });
});
