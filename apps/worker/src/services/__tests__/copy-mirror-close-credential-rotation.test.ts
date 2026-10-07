/**
 * A mirrored equity CLOSE must outlive the Alpaca credential it was staged with.
 *
 * `copy_trade_follows.credential_id` and `orders.broker_credential_id` both
 * carry `onDelete: "set null"`. Disconnecting an Alpaca connection therefore
 * nulls BOTH of them while leaving `auto_mirror` on, and reconnecting (or
 * rotating keys) mints a NEW credential uuid. The id frozen into an already
 * staged delivery can never resolve again.
 *
 * That mattered because both credential refusals on the equity path returned a
 * terminal outcome, and `poll()` calls `markDeliveryCompleted` on ANY returned
 * outcome. A queued exit was therefore consumed by the rotation: nothing
 * regenerates a source close (`stageWindow` has long since advanced the
 * checkpoint), so the follower kept a position the mirror opened for them with
 * its one exit instruction spent, and reconnecting could not retry it.
 *
 * The perp path already treats this as liftable rather than terminal: it falls
 * back to "whatever Hyperliquid connection the follower has NOW" and otherwise
 * throws EAGAIN so the delivery is requeued. These tests hold the equity path to
 * the same rule, and to the two limits that make it safe: an OPEN is still
 * refused (withholding NEW exposure is the correct answer), and the fallback is
 * matched on the BROKER ACCOUNT that actually received the open rather than on
 * any Alpaca row the follower happens to own, because paper and live
 * connections coexist and a live exit sent to the paper account finds no long.
 *
 * They drive the REAL `processCandidate` with stubbed Alpaca and DB layers, so
 * they exercise the production path rather than a re-implementation of it.
 *
 * The reconnected credential is identified by a LIVE `GET /v2/account` call
 * per candidate row, not by the `accountId` column on `user_api_credentials`.
 * That column is optional input the shipped UI never sends and credential
 * save never backfills, so it is null on every real Alpaca row; these stubs
 * deliberately return `accountId: null` from `getDecryptedCredentials` (as
 * production does) and key each row's identity off a per-credential
 * `getAccount()` response instead, exactly as the live broker call would.
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

const FOLLOWER = "follower-rotation";
/** The uuid the delivery froze. Deleted with the old connection. */
const STALE_CREDENTIAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** The uuid the reconnection minted for the SAME Alpaca account. */
const RECONNECTED_CREDENTIAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** A SECOND, still-valid Alpaca connection the follow was re-pointed to. */
const REPOINTED_PAPER_CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** A second Alpaca connection on a DIFFERENT broker account (paper + live coexist). */
const OTHER_ACCOUNT_CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** What the follow now names after being re-pointed at Hyperliquid perps. */
const HYPERLIQUID_CREDENTIAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FOLLOW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** The Alpaca account that received the mirrored open. */
const OPEN_ACCOUNT_ID = "paper-acct-1";
const SOURCE_USER_ID = "source-credential-rotation";
const SOURCE_CLOSE_ORDER_ID = "source-rotation-close-order";
const SOURCE_CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");
const SOURCE_OPEN_AT = new Date("2026-08-01T13:00:00.000Z");

/** Alpaca-side state each test sets before driving the poller. */
const stub = {
  position: null as Record<string, unknown> | null,
  placedOrders: [] as Array<Record<string, unknown>>,
  /** Every order row `placeMirrorOrder` inserted locally, in order. */
  insertedOrders: [] as Array<Record<string, unknown>>,
  /** Every credentialId `getDecryptedCredentials` was asked for, in order. */
  credentialRequests: [] as Array<string | undefined>,
  /**
   * What a LIVE `GET /v2/account` call answers for a given credential id, as
   * production would: keyed by the actual broker identity behind that row's
   * keys, NOT by anything read from `user_api_credentials.accountId` (which
   * is always null for Alpaca, see the file header). Missing on purpose
   * defaults to a value that can never equal a real open account, so a test
   * must explicitly arm the identity it wants matched rather than one
   * accidentally lining up.
   */
  liveAccountByCredential: {} as Record<string, string>,
};

mock.module(credentialsModule, () => ({
  getDecryptedCredentials: async (
    _db: unknown,
    _userId: string,
    options: { credentialId?: string },
  ) => {
    stub.credentialRequests.push(options?.credentialId);
    // The keyId doubles as the row's identity for these stubs, so the fake
    // AlpacaClient below can answer a distinct `account_number` per
    // credential id, the same way distinct real API keys would.
    const keyId = options?.credentialId ?? "paper-key-id";
    return {
      username: keyId,
      accessToken: `secret-for-${keyId}`,
      accountType: "PAPER",
      // Production reality: the UI never collects this and credential save
      // never backfills it from Alpaca's own verification call, so this
      // column is null on every Alpaca row. The reroute must not depend on it.
      accountId: null,
      credentialId: options?.credentialId ?? "paper-credential",
    };
  },
}));

mock.module(alpacaShimModule, () => ({
  isPaperAccount: (accountType: string | null | undefined) => accountType !== "LIVE",
}));

mock.module(alpacaPkgModule, () => {
  class AlpacaClient {
    private keyId: string;
    constructor(config: { keyId: string }) {
      this.keyId = config.keyId;
    }
    async getAccount() {
      return {
        buying_power: "200000",
        equity: "200000",
        account_number: stub.liveAccountByCredential[this.keyId] ?? `unset-${this.keyId}`,
      };
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

const guards = {
  dailyCap: 20,
  maxOrderDollars: 1_000_000,
  liveAllowed: false,
  perpsEnabled: false,
  mainnetAllowed: false,
};

/**
 * The mirrored open, as the exposure read sees it AFTER the disconnect: the
 * foreign key nulled `brokerCredentialId`, but `brokerAccountId` is a plain text
 * column and survives, which is what makes the reconnection resolvable at all.
 */
function mirrorOpen(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-open-1",
    userId: FOLLOWER,
    symbol: "AAPL",
    assetType: "EQUITY",
    tradeAction: "Buy",
    status: "FILLED",
    quantity: 40,
    executedQuantity: 40,
    clientOrderId: `copymirror:${FOLLOWER}:user:earlier-open`,
    brokerAccountId: OPEN_ACCOUNT_ID,
    brokerCredentialId: null,
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: new Date("2026-08-01T14:00:00.000Z"),
    ...overrides,
  };
}

/**
 * An Alpaca connection row as `userApiCredentials` holds it, plus the
 * account number a LIVE `getAccount()` call answers for it. Production never
 * persists `accountId` on this row for Alpaca (see the file header), so the
 * row itself carries no identity of its own here: `liveAccountNumber` is
 * wired into `stub.liveAccountByCredential` instead, exactly what the reroute
 * now reads.
 */
function alpacaCredential(id: string, liveAccountNumber: string) {
  stub.liveAccountByCredential[id] = liveAccountNumber;
  return { id, provider: "alpaca" };
}

function closeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    followerUserId: FOLLOWER,
    // The uuid frozen when the delivery was staged. The row behind it is gone.
    credentialId: STALE_CREDENTIAL_ID,
    followId: FOLLOW_ID,
    sourceEventAt: new Date().toISOString(),
    sourceItemId: "user:source-close",
    sourceUserId: SOURCE_USER_ID,
    sourceOrderId: SOURCE_CLOSE_ORDER_ID,
    sourceOrderCreatedAt: SOURCE_CLOSE_AT.toISOString(),
    symbol: "AAPL",
    side: "sell" as const,
    sizingMode: "usd" as const,
    sizingValue: 5_000,
    assetType: "EQUITY" as const,
    tradeAction: "Sell" as const,
    ...overrides,
  };
}

/**
 * A DB whose `user_api_credentials` table holds exactly `credentials`, so an
 * id lookup for the deleted uuid answers undefined exactly as Postgres would.
 *
 * `openCredentialRow`, when given, is what the exact-id lookup answers instead
 * (and what the armed follow is pointed at). Only the fresh-OPEN write-path
 * test below needs to resolve a destination and actually reach placement.
 */
function makePoller(
  history: Array<Record<string, unknown>>,
  credentials: Array<ReturnType<typeof alpacaCredential>>,
  openCredentialRow?: { id: string; provider: string },
) {
  const sourceOrder = {
    id: SOURCE_CLOSE_ORDER_ID,
    userId: SOURCE_USER_ID,
    symbol: "AAPL",
    assetType: "EQUITY",
    tradeAction: "Sell",
    direction: "long",
    status: "FILLED",
    executedQuantity: 40,
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
    id: "source-rotation-open-order",
    userId: SOURCE_USER_ID,
    symbol: "AAPL",
    assetType: "EQUITY",
    tradeAction: "Buy",
    direction: "long",
    status: "FILLED",
    executedQuantity: 40,
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
    symbol: "AAPL",
    assetType: "EQUITY",
    orderId: id === "source-close" ? SOURCE_CLOSE_ORDER_ID : sourceHistory[0].id,
  }));
  const sourceOrderRows = [sourceOrder, ...sourceHistory];
  const consentCredentialId = openCredentialRow?.id ?? STALE_CREDENTIAL_ID;
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
        // The production lookup is by exact id; these tests only ever ask for
        // one that was deleted with the old connection, so it answers undefined
        // unless a test explicitly arms a live destination.
        findFirst: async () => openCredentialRow,
        findMany: async () => credentials,
      },
      copyTradeFollows: {
        findFirst: async () => ({
          id: FOLLOW_ID,
          followerUserId: FOLLOWER,
          autoMirror: true,
          credentialId: openCredentialRow?.id ?? null,
          destinationPolicyInitialized: true,
          stockAutoMirror: true,
          stockCredentialId: consentCredentialId,
          stockSizingMode: "usd",
          stockSizingValue: 5_000,
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
      values: (values: Record<string, unknown>) => {
        stub.insertedOrders.push(values);
        return {
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
        };
      },
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
  stub.insertedOrders.length = 0;
  stub.credentialRequests.length = 0;
  for (const key of Object.keys(stub.liveAccountByCredential)) {
    delete stub.liveAccountByCredential[key];
  }
}

/** The 40 shares the mirror opened, still held. */
const HELD_40 = { side: "long", qty: "40", qty_available: "40" };

describe("a queued equity CLOSE survives an Alpaca credential rotation", () => {
  it("routes the exit to the reconnected credential for the account that received the open", async () => {
    // The audit's scenario. The follower disconnected and reconnected the same
    // Alpaca account before the delivery drained: both foreign keys were nulled
    // and a NEW uuid was minted, so the frozen id resolves to nothing.
    resetStub(HELD_40);
    const poller = makePoller(
      [mirrorOpen()],
      [alpacaCredential(RECONNECTED_CREDENTIAL_ID, OPEN_ACCOUNT_ID)],
    );

    const outcome = await run(poller, closeCandidate());

    expect(outcome).toBe("placed");
    // Decrypted twice for the same id: once to probe this row's LIVE
    // account_number while searching for the reconnection, and once more to
    // actually build the client that places the order. Both name the
    // reconnected credential; neither ever falls back to the stale one.
    expect(stub.credentialRequests).toEqual([RECONNECTED_CREDENTIAL_ID, RECONNECTED_CREDENTIAL_ID]);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "sell", qty: 40 });
  });

  it("holds a close when the resolved credential UUID now authenticates a different Alpaca account", async () => {
    resetStub(HELD_40);
    const replacedInPlace = alpacaCredential(RECONNECTED_CREDENTIAL_ID, "different-account");
    const poller = makePoller(
      [mirrorOpen({ brokerCredentialId: RECONNECTED_CREDENTIAL_ID })],
      [replacedInPlace],
      replacedInPlace,
    );

    await expect(
      run(poller, closeCandidate({ credentialId: RECONNECTED_CREDENTIAL_ID })),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    expect(stub.placedOrders).toHaveLength(0);
  });

  it("reroutes by account even when the follow has since been re-pointed at a DIFFERENT live Alpaca account", async () => {
    // Found by review. The reroute was gated on the follow's own credential
    // failing to resolve, which is only the SAME-account rotation case.
    //
    // A follower may hold Alpaca paper AND live at once: the unique index on
    // user_api_credentials is PARTIAL to hyperliquid precisely so "alpaca paper
    // + live rows keep their existing many-rows-per-user shape". So:
    //
    //  1. The mirror opens 40 shares on the LIVE account.
    //  2. The follower re-points the follow at their PAPER account. autoMirror
    //     stays on, because only an explicit null credential disarms it.
    //  3. The follower disconnects LIVE. `orders.broker_credential_id` is
    //     `onDelete: "set null"`, so every mirrored open's credential is nulled
    //     while the position itself is still live at the broker.
    //
    // The exposure then reads {qty: 40, credentialId: null, accounts: [LIVE]},
    // the destination falls back to the FOLLOW's paper credential, and that
    // resolves to a perfectly valid alpaca row. Gated on resolution alone, the
    // account-matching reroute never runs and the SELL goes to paper: paper is
    // flat, the close returns "no-long-position", the delivery is COMPLETED,
    // and a real live position is stranded with its only exit spent.
    //
    // Worse if the follower happens to hold the same symbol on paper by hand,
    // because then it is not refused at all: it sells THEIR shares on the wrong
    // account while the mirrored live position stays open.
    //
    // What must happen instead: live exposure whose own credential was nulled
    // is routed by the ACCOUNT that received the open, never by whatever the
    // follow points at today.
    resetStub(HELD_40);
    const paper = alpacaCredential(REPOINTED_PAPER_CREDENTIAL_ID, "paper-account-9999");
    const poller = makePoller(
      [mirrorOpen()],
      [paper, alpacaCredential(RECONNECTED_CREDENTIAL_ID, OPEN_ACCOUNT_ID)],
      paper,
    );

    const outcome = await run(poller, closeCandidate({ credentialId: REPOINTED_PAPER_CREDENTIAL_ID }));

    expect(outcome).toBe("placed");
    // The order must be built with the credential whose LIVE account number
    // matches the account the open landed in, not the re-pointed paper one.
    // The paper credential IS decrypted once, on purpose: the reroute probes each
    // connection's live `account_number` to work out which one holds the open,
    // and paper is a candidate until its number fails to match. What matters is
    // that it is never the credential the ORDER is built with.
    expect(stub.credentialRequests.at(-1)).toBe(RECONNECTED_CREDENTIAL_ID);
    expect(stub.credentialRequests.filter((id) => id === RECONNECTED_CREDENTIAL_ID).length)
      .toBeGreaterThanOrEqual(1);
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "sell", qty: 40 });
  });

  it("defers the exit rather than consuming it while the follower is still disconnected", async () => {
    // No Alpaca connection at all right now. The exit must be REQUEUED, not
    // completed: reconnecting has to be able to retry it.
    resetStub(HELD_40);
    const poller = makePoller([mirrorOpen()], []);

    await expect(run(poller, closeCandidate())).rejects.toThrow(/Alpaca account not usable/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("defers rather than guessing when no reconnected credential names the open's account", async () => {
    // Paper and live Alpaca rows coexist per user. Sending a close to the wrong
    // broker account finds no long and consumes the exit just as surely as the
    // terminal refusal did, so an unmatched account is held, never guessed.
    resetStub(HELD_40);
    const poller = makePoller(
      [mirrorOpen()],
      [alpacaCredential(OTHER_ACCOUNT_CREDENTIAL_ID, "live-acct-9")],
    );

    await expect(run(poller, closeCandidate())).rejects.toThrow(/Alpaca account not usable/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("still refuses an OPEN whose selected credential is gone", async () => {
    // The other half of the rule: withholding NEW exposure is the correct answer
    // when the follower's chosen destination no longer exists, and a buy strands
    // nothing. It must stay terminal rather than retrying for an hour.
    resetStub(null);
    const poller = makePoller(
      [],
      [alpacaCredential(RECONNECTED_CREDENTIAL_ID, OPEN_ACCOUNT_ID)],
    );

    const outcome = await run(
      poller,
      closeCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        tradeAction: "Buy" as const,
      }),
    );

    expect(outcome).toBe("missing-credential");
    expect(stub.placedOrders).toEqual([]);
  });

  it("still refuses a CLOSE with no mirrored exposure behind it", async () => {
    // Nothing was opened, so nothing is stranded and there is no exit to
    // preserve. Deferring here would requeue a delivery that can never place an
    // order, so this stays terminal.
    resetStub(HELD_40);
    const poller = makePoller(
      [],
      [alpacaCredential(RECONNECTED_CREDENTIAL_ID, OPEN_ACCOUNT_ID)],
    );

    const outcome = await run(poller, closeCandidate());

    expect(outcome).toBe("missing-credential");
    expect(stub.placedOrders).toEqual([]);
  });

  it("reroutes to the reconnected Alpaca account when the follow now names a Hyperliquid credential", async () => {
    // The follower disconnected Alpaca (nulling `brokerCredentialId` on the
    // open and `credential_id` on the follow) and then re-pointed the SAME
    // follow at a Hyperliquid connection instead of reconnecting Alpaca.
    // `destinationCredentialId` falls back to `cand.credentialId`, which now
    // NAMES A ROW THAT RESOLVES (the Hyperliquid uuid is not gone, just the
    // wrong venue), so the old code skipped the reconnection search entirely
    // (it was gated on "no credential resolved at all") and fell straight to
    // the terminal `incompatible-destination` return, spending the exit. The
    // gate must key on whether the resolved credential can actually take an
    // Alpaca order, not on whether one resolved.
    resetStub(HELD_40);
    const poller = makePoller(
      [mirrorOpen()],
      [alpacaCredential(RECONNECTED_CREDENTIAL_ID, OPEN_ACCOUNT_ID)],
      { id: HYPERLIQUID_CREDENTIAL_ID, provider: "hyperliquid" },
    );

    const outcome = await run(
      poller,
      closeCandidate({ credentialId: HYPERLIQUID_CREDENTIAL_ID }),
    );

    expect(outcome).toBe("placed");
    expect(stub.placedOrders[0]).toMatchObject({ symbol: "AAPL", side: "sell", qty: 40 });
  });

  it("defers rather than terminally refusing when the follow points at Hyperliquid and no Alpaca account can be found", async () => {
    // Same repointed follow, but this time no Alpaca connection the follower
    // owns matches the account that actually holds the shares. The position is
    // real and mirrored (HELD_40, exposure qty 40), so this must be REQUEUED,
    // not completed: reconnecting the right Alpaca account later has to be
    // able to retry it, exactly as the "no credential at all" case already
    // gets to.
    resetStub(HELD_40);
    const poller = makePoller(
      [mirrorOpen()],
      [],
      { id: HYPERLIQUID_CREDENTIAL_ID, provider: "hyperliquid" },
    );

    await expect(
      run(poller, closeCandidate({ credentialId: HYPERLIQUID_CREDENTIAL_ID })),
    ).rejects.toThrow(/Alpaca account not usable/i);
    expect(stub.placedOrders).toEqual([]);
  });

  it("still refuses an OPEN whose destination is a Hyperliquid credential", async () => {
    // The other half of the rule: withholding NEW exposure at an incompatible
    // destination is still correct, and a buy strands nothing. Only a CLOSE
    // with real exposure behind it earns the reconnection search.
    resetStub(null);
    const poller = makePoller(
      [],
      [alpacaCredential(RECONNECTED_CREDENTIAL_ID, OPEN_ACCOUNT_ID)],
      { id: HYPERLIQUID_CREDENTIAL_ID, provider: "hyperliquid" },
    );

    const outcome = await run(
      poller,
      closeCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        tradeAction: "Buy" as const,
        credentialId: HYPERLIQUID_CREDENTIAL_ID,
      }),
    );

    expect(outcome).toBe("incompatible-destination");
    expect(stub.placedOrders).toEqual([]);
  });
});

describe("a mirrored OPEN records the account a live Alpaca call names, not the stored credential column", () => {
  it("stores GET /v2/account's account_number as brokerAccountId, never `credentials.accountId`", async () => {
    // `credentials.accountId` (the `user_api_credentials.accountId` column,
    // read through `getDecryptedCredentials`) is null for every Alpaca row in
    // production: the reroute above exists precisely because of that. If the
    // OPEN write path ever fell back to it, `brokerAccountId` would be null
    // forever and no later rotation could ever be routed back to this
    // account, exactly the failure the reroute is meant to recover from.
    resetStub(null);
    stub.liveAccountByCredential[RECONNECTED_CREDENTIAL_ID] = "live-fetched-acct-7";
    const poller = makePoller([], [], { id: RECONNECTED_CREDENTIAL_ID, provider: "alpaca" });

    const outcome = await run(
      poller,
      closeCandidate({
        sourceItemId: "user:source-open",
        side: "buy" as const,
        tradeAction: "Buy" as const,
        credentialId: RECONNECTED_CREDENTIAL_ID,
      }),
    );

    expect(outcome).toBe("placed");
    expect(stub.insertedOrders[0]).toMatchObject({ brokerAccountId: "live-fetched-acct-7" });
  });
});
