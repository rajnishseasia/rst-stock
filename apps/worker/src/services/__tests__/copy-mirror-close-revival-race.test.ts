/**
 * Two replicas racing to revive the same cancelled close.
 *
 * The revival is a compare-and-set, so exactly one replica wins it. The loser
 * still holds a row object that says CANCELLED, and treating that stale copy as
 * settled completes the delivery: a one-shot exit marked done by the process
 * that did nothing, while the winner may still be retrying.
 */

import { describe, expect, it } from "bun:test";

import { CopyMirrorPoller } from "../copy-mirror";

const CANCELLED_ROW = {
  id: "order-1",
  status: "CANCELLED",
  brokerOrderId: null,
  assetType: "PERP",
  symbol: "BTC",
  reduceOnly: true,
  clientOrderId: "copymirror:f-1:user:close-1",
};

const CAND = {
  followerUserId: "f-1",
  sourceItemId: "user:close-1",
  symbol: "BTC",
  side: "buy",
  sizingMode: "ratio",
  sizingValue: 1,
  assetType: "PERP",
  perpSide: "long",
  perpReduceOnly: true,
  credentialId: "cred-1",
};

const GUARDS = {
  dailyCap: 20,
  maxOrderDollars: 1000,
  liveAllowed: false,
  // Off, so a close that gets PAST the duplicate branch lands on the preflight
  // deferral and throws. That throw is the signal the row was adopted; a
  // "duplicate" return is the signal it was not.
  perpsEnabled: false,
  mainnetAllowed: false,
};

/**
 * @param casWins whether this replica's revival update matches a row
 * @param rereadStatus what the row looks like when re-read after a lost CAS
 */
function harness(
  casWins: boolean,
  rereadStatus: string,
  persistedReduceOnly: boolean | null = true,
  casRows: Array<Record<string, unknown>> | undefined = undefined,
) {
  const reads: string[] = [];
  let updateCalls = 0;
  const db = {
    query: {
      orders: {
        findFirst: async () => {
          reads.push("findFirst");
          return reads.length === 1
            ? { ...CANCELLED_ROW, reduceOnly: persistedReduceOnly }
            : { ...CANCELLED_ROW, status: rereadStatus };
        },
      },
    },
    update: () => ({
      set: () => ({
        where: () => {
          updateCalls += 1;
          return {
          returning: async () =>
            casRows ?? (casWins ? [{ ...CANCELLED_ROW, status: "PENDING" }] : []),
          };
        },
      }),
    }),
  };
  const poller = new CopyMirrorPoller(db as never);
  return {
    reads,
    get updateCalls() {
      return updateCalls;
    },
    run: () =>
      (
        poller as unknown as {
          processCandidate: (c: unknown, g: unknown) => Promise<string>;
        }
      ).processCandidate(CAND, GUARDS),
  };
}

describe("copy-mirror: losing the close-revival race", () => {
  it("does NOT complete the delivery when another replica won the revival", async () => {
    // The stale local row says CANCELLED, but the row in the database is
    // PENDING because the winner revived it. Falling through on the stale copy
    // would mark this exit already-mirrored and lose it.
    const h = harness(false, "PENDING");
    await expect(h.run()).rejects.toMatchObject({ code: "EAGAIN" });
    // The re-read is the whole fix: without it there is nothing to notice.
    expect(h.reads.length).toBe(2);
  });

  it("still completes a close that really is settled", async () => {
    // A lost CAS is not on its own a reason to hold. If the row is still
    // cancelled on re-read, nobody revived it, and this is a genuine duplicate.
    const h = harness(false, "CANCELLED");
    await expect(h.run()).resolves.toBe("duplicate");
    expect(h.reads.length).toBe(2);
  });

  it("proceeds normally when this replica wins the revival", async () => {
    // The winner adopts its own returned row and never re-reads.
    const h = harness(true, "CANCELLED");
    await expect(h.run()).rejects.toMatchObject({ code: "EAGAIN" });
    expect(h.reads.length).toBe(1);
  });

  it("does not treat a multi-row revival result as a winning transition", async () => {
    const h = harness(
      true,
      "CANCELLED",
      true,
      [
        { ...CANCELLED_ROW, status: "PENDING" },
        { ...CANCELLED_ROW, status: "PENDING", id: "order-2" },
      ],
    );

    await expect(h.run()).resolves.toBe("duplicate");
    expect(h.reads.length).toBe(2);
  });

  it("does not revive a persisted non-reduce-only cancelled order", async () => {
    const h = harness(true, "CANCELLED", false);

    await expect(h.run()).resolves.toBe("duplicate");
    expect(h.updateCalls).toBe(0);
  });

  it("does not revive a cancelled order when persisted reduceOnly is null", async () => {
    const h = harness(true, "CANCELLED", null);

    await expect(h.run()).resolves.toBe("duplicate");
    expect(h.updateCalls).toBe(0);
  });
});
