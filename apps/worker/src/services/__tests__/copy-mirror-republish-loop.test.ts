/**
 * The mirror feedback loop (equity path).
 *
 * A mirrored order is not a trading decision the follower made, it is an echo
 * of somebody else's. Publishing it to social_trades makes it indistinguishable
 * from a hand-placed trade, and discovery selects social_trades by nothing but
 * the poll window. So with two people mutually auto-mirroring each other, one
 * real buy becomes an unbounded chain of real market orders, each hop sized
 * from scratch off the receiving account, until the per-follower daily cap is
 * the only thing left stopping it.
 *
 * The Hyperliquid reconciler has refused to republish its own mirrors since it
 * was written (`isAutoMirroredOrder`, hyperliquid-order-sync.ts). These tests
 * hold the equity path to the same rule, in both places it has to hold:
 *
 *   1. at PUBLISH, so no new echo row is ever created, and
 *   2. at DISCOVERY, because every echo row published before this fix is still
 *      sitting in social_trades and cannot be unpublished.
 */

import { describe, expect, it } from "bun:test";

import { CopyMirrorPoller, type MirrorSourceCandidate } from "../copy-mirror";
import { createPagedMirrorDb } from "./helpers/paged-mirror-db";
import { traderKey } from "../../../../api/src/lib/trader-identity";
import { schema } from "@trade-bot/db";

const FOLLOWER = "follower-1";
const MIRROR_CLIENT_ORDER_ID = `copymirror:${FOLLOWER}:user:source-trade-1`;
// The echo row's own order: user A mirrored user B, so A's order carries A's
// follower id. It is A's social row that must not become a source for B.
const ECHO_CLIENT_ORDER_ID = "copymirror:source-user-1:user:source-trade-1";

/**
 * placeMirrorOrder harness: records which tables were inserted into so the
 * assertion can be about the social publish specifically, not about insert
 * counts.
 */
function publishHarness() {
  const insertedTables: unknown[] = [];
  const socialRows: Record<string, unknown>[] = [];
  const db = {
    insert: (table: unknown) => {
      insertedTables.push(table);
      return {
        values(value: Record<string, unknown>) {
          if (table === schema.socialTrades) socialRows.push(value);
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  return Promise.resolve([{ id: "local-order-1", userId: FOLLOWER }]);
                },
              };
            },
          };
        },
      };
    },
    // The acceptance write is a CAS that must return exactly one row, or the
    // placement reports "syncing" instead of "placed".
    update: () => ({
      set() {
        return {
          where() {
            return {
              returning: () => Promise.resolve([{ id: "local-order-1" }]),
            };
          },
        };
      },
    }),
  } as never;

  const client = {
    createOrder: async () => ({ id: "broker-order-1" }),
  } as never;

  const poller = new CopyMirrorPoller(db);
  const place = (
    poller as unknown as {
      placeMirrorOrder: (
        client: unknown,
        params: Record<string, unknown>,
      ) => Promise<string>;
    }
  ).placeMirrorOrder.bind(poller);

  return { client, place, socialRows, insertedTables };
}

describe("a mirrored equity order is not republished as a source trade", () => {
  it("places the order but writes no social_trades row for the follower", async () => {
    const harness = publishHarness();

    const outcome = await harness.place(harness.client, {
      followerUserId: FOLLOWER,
      symbol: "AAPL",
      tradingSymbol: "AAPL",
      side: "buy",
      qty: 100,
      clientOrderId: MIRROR_CLIENT_ORDER_ID,
      brokerAccountId: "paper-account",
      brokerCredentialId: "11111111-1111-4111-8111-111111111111",
      isPaper: true,
      assetType: "EQUITY",
    });

    // The order itself must still be placed. Suppressing the echo is about the
    // feed, never about withholding the follower's trade.
    expect(outcome).toBe("placed");
    expect(harness.socialRows).toHaveLength(0);
    expect(harness.insertedTables).not.toContain(schema.socialTrades);
  });
});

describe("discovery ignores social trades that a mirror published", () => {
  const SOURCE = "source-user-1";
  const now = new Date();
  const within = new Date(now.getTime() - 1_000);
  const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000201";

  function fakeDb(socialTradeRows: unknown[]) {
    return createPagedMirrorDb({
      socialRows: socialTradeRows as readonly Record<string, unknown>[],
      windowStart: new Date(now.getTime() - 60_000),
      windowEnd: now,
    }).db;
  }

  function callFind(socialTradeRows: unknown[]) {
    const follows = [
      {
        followerUserId: FOLLOWER,
        targetType: "user",
        targetKey: traderKey(SOURCE),
        sizingMode: "usd",
        sizingValue: "500",
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
      },
    ] as never[];
    return (
      new CopyMirrorPoller(fakeDb(socialTradeRows)) as unknown as {
        findMirrorCandidates: (
          follows: unknown[],
          windowStart: Date,
          windowEnd: Date,
        ) => Promise<MirrorSourceCandidate[]>;
      }
    ).findMirrorCandidates(follows, new Date(now.getTime() - 60_000), now);
  }

  it("stages a hand-placed equity trade", async () => {
    // Control: the same row without the mirror marker is still a candidate, so
    // the exclusion below is about provenance and not about the fixture.
    const out = await callFind([
      {
        id: "t-hand",
        userId: SOURCE,
        symbol: "AAPL",
        side: "buy",
        assetType: "EQUITY",
        createdAt: within,
        orderId: "order-hand",
        orderUserId: SOURCE,
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        tradeAction: "Buy",
        orderDirection: "long",
        orderCreatedAt: within,
        orderClientOrderId: "rst-manual-1",
      },
    ]);

    expect(out).toHaveLength(1);
  });

  it("does not stage an already-published mirror as a new source trade", async () => {
    // The joined order carries the copymirror client_order_id the worker writes
    // on every mirror it places. Rows like this exist in social_trades already
    // and cannot be unpublished, so discovery has to refuse them on sight.
    const out = await callFind([
      {
        id: "t-echo",
        userId: SOURCE,
        symbol: "AAPL",
        side: "buy",
        assetType: "EQUITY",
        createdAt: within,
        orderId: "order-echo",
        orderUserId: SOURCE,
        orderSymbol: "AAPL",
        orderAssetType: "EQUITY",
        tradeAction: "Buy",
        orderDirection: "long",
        orderCreatedAt: within,
        orderClientOrderId: ECHO_CLIENT_ORDER_ID,
      },
    ]);

    expect(out).toHaveLength(0);
  });
});
