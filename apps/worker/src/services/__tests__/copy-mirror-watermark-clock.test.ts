import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CopyMirrorPoller } from "../copy-mirror";

/**
 * The discovery watermark and the rows it selects must be stamped by ONE clock.
 *
 * Discovery filters source rows on DATABASE-assigned timestamps
 * (`social_trades.created_at` is `defaultNow()`, i.e. Postgres `now()`), but the
 * poll cycle used to take `windowEnd = new Date()` from the WORKER process and
 * then advance the durable checkpoint to that value. On a host whose clock leads
 * the database by d, every cycle parks the checkpoint d past the newest row the
 * database could possibly have written, so a d-wide band of source events is
 * skipped. It is skipped permanently: `stageWindow` advances the checkpoint
 * either way and nothing recreates a source close, so the follower is left
 * holding a mirrored position whose only exit instruction was never staged.
 *
 * These tests drive the real `poll()` and stand in for Postgres with a clock the
 * test controls plus the exact window predicate discovery issues
 * (`created_at > windowStart AND created_at <= windowEnd`).
 */

type PollerHarness = {
  poll: () => Promise<void>;
  loadOrCreateCheckpoint: (now: Date) => Promise<Date>;
  forEachAutoMirrorFollowPage: (
    onPage: (follows: unknown[]) => Promise<void>,
  ) => Promise<void>;
  findMirrorCandidates: (
    follows: unknown[],
    start: Date,
    end: Date,
    onBatch?: (batch: unknown[]) => Promise<void>,
  ) => Promise<unknown[]>;
  stageDeliveryBatch: (end: Date, candidates: unknown[]) => Promise<void>;
  advanceCheckpoint: (start: Date, end: Date) => Promise<void>;
  loadDueDeliveries: (now: Date) => Promise<unknown[]>;
};

const FOLLOWER = "follower-1";
const CREDENTIAL = "00000000-0000-4000-8000-000000000001";

/** A source row as the database holds it: `createdAt` is the DB clock, not ours. */
type SourceRow = { id: string; createdAt: Date };

/**
 * Stands in for the worker pool db. `execute` answers the DB clock read the poll
 * cycle needs; `select().from().where()` answers the auto-mirror follow scan.
 */
function fakeDb(dbNow: () => Date) {
  return {
    execute: async () => ({ rows: [{ now: dbNow() }] }),
    select: () => ({
      from: () => ({
        where: async () => [{ followerUserId: FOLLOWER, autoMirror: true, credentialId: CREDENTIAL }],
      }),
    }),
    query: {
      copyMirrorDeliveries: { findMany: async () => [] },
    },
  } as never;
}

/**
 * Wires a poller whose discovery and staging behave the way production's do:
 * discovery selects on the DB-assigned `createdAt` inside (windowStart,
 * windowEnd], and staging advances the durable checkpoint to windowEnd.
 */
function harness(dbNow: () => Date, source: SourceRow[]) {
  const staged: string[] = [];
  const windowEnds: Date[] = [];
  let checkpoint: Date | undefined;

  const poller = new CopyMirrorPoller(fakeDb(dbNow)) as unknown as PollerHarness;

  poller.loadOrCreateCheckpoint = async (now) => {
    checkpoint ??= now;
    return checkpoint;
  };
  poller.forEachAutoMirrorFollowPage = async (onPage) => {
    await onPage([{ followerUserId: FOLLOWER, autoMirror: true, credentialId: CREDENTIAL }]);
  };
  poller.findMirrorCandidates = async (_follows, windowStart, windowEnd) =>
    source
      .filter((row) => row.createdAt > windowStart && row.createdAt <= windowEnd)
      .map((row) => ({ followerUserId: FOLLOWER, sourceItemId: `user:${row.id}` }));
  poller.stageDeliveryBatch = async (_windowEnd, candidates) => {
    for (const candidate of candidates as { sourceItemId: string }[]) {
      // Mirrors the delivery table's onConflictDoNothing on (follower, source).
      if (!staged.includes(candidate.sourceItemId)) staged.push(candidate.sourceItemId);
    }
  };
  // The checkpoint advance is where the cycle commits to a window end, so it is
  // the honest place to observe which clock stamped it.
  poller.advanceCheckpoint = async (_start, windowEnd) => {
    windowEnds.push(windowEnd);
    checkpoint = windowEnd;
  };
  poller.loadDueDeliveries = async () => [];

  return { poller, staged, windowEnds, checkpointAt: () => checkpoint };
}

describe("copy-mirror discovery watermark clock", () => {
  const originalEnabled = process.env.COPY_TRADE_AUTOMIRROR_ENABLED;

  beforeEach(() => {
    process.env.COPY_TRADE_AUTOMIRROR_ENABLED = "true";
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_ENABLED;
    else process.env.COPY_TRADE_AUTOMIRROR_ENABLED = originalEnabled;
  });

  it("stamps the discovery window end from the database clock, not the worker clock", async () => {
    // Deliberately far from the worker's own `new Date()` so a wall-clock stamp
    // cannot coincidentally pass.
    const dbClock = new Date("2026-08-09T10:00:00.000Z");
    const { poller, windowEnds } = harness(() => dbClock, []);

    await poller.poll();

    expect(windowEnds).toHaveLength(1);
    expect(windowEnds[0]!.toISOString()).toBe(dbClock.toISOString());
  });

  it("still stages a source row the database stamped inside the worker clock's lead", async () => {
    // The failure scenario: the worker host leads Postgres by 500ms. The source
    // close commits at DB time 09:59:59.700, a moment after this cycle's
    // discovery snapshot, so this cycle cannot see it. A worker-clock watermark
    // parks the checkpoint at 10:00:00.000 (worker time) and the next cycle's
    // `created_at > windowStart` excludes 09:59:59.700 forever.
    const workerNow = Date.now();
    let dbAdvanceMs = 0;
    const dbNow = () => new Date(workerNow - 500 + dbAdvanceMs);

    const source: SourceRow[] = [];
    const { poller, staged } = harness(dbNow, source);

    await poller.poll();
    expect(staged).toEqual([]);

    // Committed after the first cycle's discovery snapshot, but stamped by the
    // database at a moment the worker clock had already passed.
    source.push({ id: "close-1", createdAt: new Date(workerNow - 300) });

    // Next cycle, one poll interval later on the database clock.
    dbAdvanceMs = 30_000;
    await poller.poll();

    expect(staged).toEqual(["user:close-1"]);
  });
});
