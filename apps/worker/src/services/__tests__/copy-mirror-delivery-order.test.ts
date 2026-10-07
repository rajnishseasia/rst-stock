/**
 * Unit tests for deterministic copy-mirror delivery ordering.
 *
 * The failure being prevented is specific: a source trader who opens and closes
 * inside one poll window used to have the CLOSE handed over first, where it
 * skipped on no-position and was marked completed, leaving the follower holding
 * the leveraged entry that arrived second.
 */

import { describe, expect, it } from "bun:test";
import {
  compareDeliveryOrder,
  HL_WALLET_OPEN_MAX_AGE_MS,
  isExpiredWalletOpenIntent,
  orderCandidatesBySourceEvent,
  orderDueDeliveries,
  runFollowerDeliveryLanes,
  sourceEventTimeMs,
  stagedAttemptAt,
  MAX_STAGE_SPREAD_MS,
} from "../copy-mirror-delivery-order";
import { DELIVERY_FOLLOWER_CONCURRENCY } from "../copy-mirror";

describe("runFollowerDeliveryLanes", () => {
  it("starts ready close heads first and runs only their same-follower prerequisites ahead of other opens", async () => {
    const started: string[] = [];
    const rows = [
      {
        followerUserId: "unrelated-follower",
        id: "unrelated-open",
        candidate: {
          sourceItemId: "user:unrelated-open",
          sourceEventAt: OPEN_AT,
          assetType: "PERP",
          perpReduceOnly: false,
        },
      },
      {
        followerUserId: "dependent-follower",
        id: "dependent-open",
        candidate: {
          sourceItemId: "user:dependent-open",
          sourceEventAt: OPEN_AT,
          assetType: "PERP",
          perpReduceOnly: false,
        },
      },
      {
        followerUserId: "close-follower",
        id: "ready-close",
        candidate: {
          sourceItemId: "user:ready-close",
          sourceEventAt: CLOSE_AT,
          assetType: "PERP",
          perpReduceOnly: true,
        },
      },
      {
        followerUserId: "dependent-follower",
        id: "dependent-close",
        candidate: {
          sourceItemId: "user:dependent-close",
          sourceEventAt: CLOSE_AT,
          assetType: "PERP",
          perpReduceOnly: true,
        },
      },
    ];

    await runFollowerDeliveryLanes(rows, 1, async (row) => {
      started.push(row.id);
    });

    expect(started).toEqual([
      "ready-close",
      "dependent-open",
      "dependent-close",
      "unrelated-open",
    ]);
  });

  it("starts a six-follower cohort without waiting for protection in earlier lanes", async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const rows = Array.from({ length: 6 }, (_, index) => ({
      followerUserId: `follower-${index}`,
      id: `delivery-${index}`,
    }));

    const running = runFollowerDeliveryLanes(
      rows,
      DELIVERY_FOLLOWER_CONCURRENCY,
      async (row) => {
        started.push(row.id);
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    );
    await Promise.resolve();

    expect(started).toHaveLength(6);
    releases.forEach((release) => release());
    await running;
  });

  it("runs followers concurrently but preserves order within each follower", async () => {
    const release: Array<() => void> = [];
    const started: string[] = [];
    const rows = [
      { followerUserId: "a", id: "a-open" },
      { followerUserId: "b", id: "b-open" },
      { followerUserId: "a", id: "a-close" },
      { followerUserId: "b", id: "b-close" },
    ];

    const running = runFollowerDeliveryLanes(rows, 4, async (row) => {
      started.push(row.id);
      if (row.id.endsWith("open")) {
        await new Promise<void>((resolve) => release.push(resolve));
      }
    });
    await Promise.resolve();

    expect(started).toEqual(["a-open", "b-open"]);
    release.splice(0).forEach((resolve) => resolve());
    await running;
    expect(started.indexOf("a-close")).toBeGreaterThan(started.indexOf("a-open"));
    expect(started.indexOf("b-close")).toBeGreaterThan(started.indexOf("b-open"));
  });

  it("stops only the lane whose claim was lost", async () => {
    const processed: string[] = [];
    await runFollowerDeliveryLanes([
      { followerUserId: "a", id: "a-open" },
      { followerUserId: "a", id: "a-close" },
      { followerUserId: "b", id: "b-open" },
    ], 2, async (row) => {
      processed.push(row.id);
      return row.id !== "a-open";
    });
    expect(processed).toEqual(["a-open", "b-open"]);
  });
});

const OPEN_AT = "2026-08-09T12:00:00.000Z";
const CLOSE_AT = "2026-08-09T12:00:20.000Z";

const open = {
  sourceItemId: "user:open",
  sourceEventAt: OPEN_AT,
  perpReduceOnly: false,
};
const close = {
  sourceItemId: "user:close",
  sourceEventAt: CLOSE_AT,
  perpReduceOnly: true,
};

describe("isExpiredWalletOpenIntent", () => {
  const now = Date.parse("2026-08-09T12:10:00.000Z");

  it("keeps only timestamped wallet opens inside the five-minute window", () => {
    expect(HL_WALLET_OPEN_MAX_AGE_MS).toBe(5 * 60_000);
    expect(isExpiredWalletOpenIntent({
      sourceItemId: "hl_wallet:0xabc:1",
      sourceEventAt: new Date(now - HL_WALLET_OPEN_MAX_AGE_MS).toISOString(),
    }, now)).toBe(false);
    expect(isExpiredWalletOpenIntent({
      sourceItemId: "hl_wallet:0xabc:2",
      sourceEventAt: new Date(now - HL_WALLET_OPEN_MAX_AGE_MS - 1).toISOString(),
    }, now)).toBe(true);
  });

  it("fails closed for unknown or future wallet opens, but exempts closes and other sources", () => {
    expect(isExpiredWalletOpenIntent({ sourceItemId: "hl_wallet:0xabc:3" }, now)).toBe(true);
    expect(isExpiredWalletOpenIntent({
      sourceItemId: "hl_wallet:0xabc:4",
      sourceEventAt: new Date(now + 1).toISOString(),
    }, now)).toBe(true);
    expect(isExpiredWalletOpenIntent({
      sourceItemId: "hl_wallet:0xabc:5",
      sourceEventAt: new Date(now - 10 * 60_000).toISOString(),
      perpReduceOnly: true,
    }, now)).toBe(false);
    expect(isExpiredWalletOpenIntent({
      sourceItemId: "user:old-open",
      sourceEventAt: new Date(now - 10 * 60_000).toISOString(),
    }, now)).toBe(false);
  });
});

describe("sourceEventTimeMs", () => {
  it("reads a usable timestamp", () => {
    expect(sourceEventTimeMs(open)).toBe(Date.parse(OPEN_AT));
  });

  it("returns null rather than substituting a default", () => {
    expect(sourceEventTimeMs({ sourceItemId: "a" })).toBeNull();
    expect(sourceEventTimeMs({ sourceItemId: "a", sourceEventAt: "" })).toBeNull();
    expect(sourceEventTimeMs({ sourceItemId: "a", sourceEventAt: "nope" })).toBeNull();
  });
});

describe("orderCandidatesBySourceEvent", () => {
  it("puts an entry before its own close no matter how they were discovered", () => {
    expect(orderCandidatesBySourceEvent([close, open]).map((c) => c.sourceItemId)).toEqual([
      "user:open",
      "user:close",
    ]);
    expect(orderCandidatesBySourceEvent([open, close]).map((c) => c.sourceItemId)).toEqual([
      "user:open",
      "user:close",
    ]);
  });

  it("breaks a same-instant tie toward opening before closing", () => {
    const sameInstantClose = { ...close, sourceEventAt: OPEN_AT };
    expect(
      orderCandidatesBySourceEvent([sameInstantClose, open]).map((c) => c.sourceItemId),
    ).toEqual(["user:open", "user:close"]);
  });

  it("is a total order, so repeated runs agree", () => {
    const a = { sourceItemId: "user:a", sourceEventAt: OPEN_AT };
    const b = { sourceItemId: "user:b", sourceEventAt: OPEN_AT };
    expect(orderCandidatesBySourceEvent([b, a]).map((c) => c.sourceItemId)).toEqual([
      "user:a",
      "user:b",
    ]);
    expect(compareDeliveryOrder(a, a)).toBe(0);
  });

  it("places an unknown-time candidate ahead of the closes, not behind them", () => {
    const unknown = { sourceItemId: "user:unknown", perpReduceOnly: false };
    expect(orderCandidatesBySourceEvent([close, unknown]).map((c) => c.sourceItemId)).toEqual([
      "user:unknown",
      "user:close",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [close, open];
    orderCandidatesBySourceEvent(input);
    expect(input.map((c) => c.sourceItemId)).toEqual(["user:close", "user:open"]);
  });
});

describe("stagedAttemptAt", () => {
  const windowEnd = new Date("2026-08-09T12:00:30.000Z");

  it("keeps every staged row due now, spread backward in rank order", () => {
    const first = stagedAttemptAt(windowEnd, 0, 3);
    const second = stagedAttemptAt(windowEnd, 1, 3);
    const third = stagedAttemptAt(windowEnd, 2, 3);
    expect(first.getTime()).toBeLessThan(second.getTime());
    expect(second.getTime()).toBeLessThan(third.getTime());
    expect(third.getTime()).toBe(windowEnd.getTime());
    expect(first.getTime()).toBeLessThanOrEqual(windowEnd.getTime());
  });

  it("bounds how far back the spread may reach", () => {
    const first = stagedAttemptAt(windowEnd, 0, 10_000_000);
    expect(windowEnd.getTime() - first.getTime()).toBe(MAX_STAGE_SPREAD_MS);
  });

  it("clamps a nonsense rank instead of producing a wild timestamp", () => {
    expect(stagedAttemptAt(windowEnd, -5, 1).getTime()).toBe(windowEnd.getTime());
    expect(stagedAttemptAt(windowEnd, 99, 1).getTime()).toBe(windowEnd.getTime());
  });
});

describe("orderDueDeliveries", () => {
  it("re-imposes the source-event order on rows the DB returned tied", () => {
    const rows = [
      { id: "row-close", candidate: close },
      { id: "row-open", candidate: open },
    ];
    expect(orderDueDeliveries(rows).map((r) => r.id)).toEqual(["row-open", "row-close"]);
  });

  it("survives a delivery row whose candidate payload is unusable", () => {
    const rows = [
      { id: "row-close", candidate: close },
      { id: "row-broken", candidate: null },
    ];
    expect(orderDueDeliveries(rows).map((r) => r.id)).toEqual(["row-broken", "row-close"]);
  });
});
