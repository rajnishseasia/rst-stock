import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getTableName } from "drizzle-orm";
import { schema } from "@trade-bot/db";
import { clearErrorReporter, setErrorReporter } from "@trade-bot/logger";
import { HyperliquidUnknownCoinError } from "@trade-bot/hyperliquid";
import {
  CopyMirrorPoller,
  COPY_MIRROR_LATE_SOURCE_REPLAY_MS,
  COPY_MIRROR_FOLLOW_PAGE_SIZE,
  DEFERRED_CLOSE_SCAN_CAP,
  DEFERRED_CLOSE_WARN_AFTER_MS,
  classifyMirrorFailure,
  describeDeferredCloseBacklog,
  mirrorRetryDelayMs,
  mirrorSourceReplayStart,
  statusFromMessage,
  type DeferredCloseBacklog,
  type DeferredCloseRow,
} from "../copy-mirror";
import { MIRROR_MAX_DELIVERY_ATTEMPTS } from "../copy-mirror-consent";
import { COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE } from "../copy-mirror-candidate-sources";
import type { DiscordMirrorSummary } from "../discord-notify";

const candidate = {
  followerUserId: "follower-1",
  credentialId: "00000000-0000-4000-8000-000000000001",
  sourceItemId: "user:source-1",
  symbol: "AAPL",
  side: "buy" as const,
  sizingMode: "usd" as const,
  sizingValue: 500,
  assetType: "EQUITY" as const,
  tradeAction: "Buy" as const,
};

const delivery = {
  id: "00000000-0000-4000-8000-000000000099",
  followerUserId: candidate.followerUserId,
  credentialId: candidate.credentialId,
  sourceItemId: candidate.sourceItemId,
  candidate,
  status: "pending",
  attempts: 0,
  nextAttemptAt: new Date(0),
  lastError: null,
  outcome: null,
  completedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

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
    onCandidateBatch?: (batch: unknown[]) => Promise<void>,
  ) => Promise<(typeof candidate)[]>;
  stageWindow: (start: Date, end: Date, candidates: (typeof candidate)[]) => Promise<void>;
  stageDeliveryBatch: (end: Date, candidates: (typeof candidate)[]) => Promise<void>;
  advanceCheckpoint: (start: Date, end: Date) => Promise<void>;
  loadDueDeliveries: (now: Date) => Promise<(typeof delivery)[]>;
  processCandidate: (value: typeof candidate, guards: unknown) => Promise<string>;
  markDeliveryCompleted: (id: string, outcome: string, now: Date) => Promise<void>;
  markDeliveryFailed: (
    row: typeof delivery,
    failure: ReturnType<typeof classifyMirrorFailure>,
    now: Date,
  ) => Promise<void>;
  readDeferredCloseBacklog: (now?: Date) => Promise<DeferredCloseBacklog>;
};

function fakeDb() {
  const rows = [{
    followerUserId: candidate.followerUserId,
    autoMirror: true,
    credentialId: candidate.credentialId,
    createdAt: new Date("2026-07-10T12:00:00.000Z"),
    id: "follow-1",
  }];
  const followQuery: any = {
    where: () => followQuery,
    orderBy: () => followQuery,
    limit: (limit: number) => Promise.resolve(limit === 1 ? rows.slice(0, 1) : rows),
  };
  return {
    // poll() stamps its window from the DATABASE clock, so the fixture has to
    // answer that read. This one stands in for a database whose clock agrees
    // with the worker's; the skew cases live in
    // copy-mirror-watermark-clock.test.ts.
    execute: async () => ({ rows: [{ now: new Date() }] }),
    select: () => ({ from: () => followQuery }),
    query: {
      copyMirrorDeliveries: {
        findMany: async () => [],
      },
      orders: {
        findMany: async () => [],
      },
    },
    // `poll()` claims every due row (compare-and-set on id/status/next_attempt_at)
    // before handing it to `processCandidate`. These tests are about the rest
    // of the orchestration loop, not the claim itself (see "delivery claiming"
    // below for that), so this always wins: one row back, as a real winning
    // CAS update would return.
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => [{ id: delivery.id }] }),
      }),
    }),
  } as never;
}

describe("auto-mirror durable state schema", () => {
  it("exports the durable source checkpoint and delivery inbox tables", () => {
    expect(getTableName(schema.copyMirrorCheckpoints)).toBe("copy_mirror_checkpoints");
    expect(getTableName(schema.copyMirrorDeliveries)).toBe("copy_mirror_deliveries");
    expect(schema.copyMirrorDeliveries.candidate.dataType).toBe("json");
  });
});

describe("aggregate mirror summary eligibility", () => {
  it("marks only newly staged deliveries for the durable summary sweep", async () => {
    let stagedValues: Array<{ candidate: Record<string, unknown> }> = [];
    const db = {
      execute: async () => ({ rows: [{ now: new Date("2026-09-08T06:40:00.000Z") }] }),
      transaction: async (callback: (tx: any) => Promise<void>) => callback({
        insert: () => ({
          values: (values: Array<{ candidate: Record<string, unknown> }>) => {
            stagedValues = values;
            return { onConflictDoNothing: async () => undefined };
          },
        }),
      }),
    };
    const poller = new CopyMirrorPoller(db as never);

    await poller.stageExternalCandidates([candidate]);

    expect(stagedValues).toHaveLength(1);
    expect(stagedValues[0]?.candidate.mirrorSummaryVersion).toBe(1);
  });

  it("passes the authoritative source user to identity-aware summary delivery", async () => {
    const sent: DiscordMirrorSummary[] = [];
    const db = {
      execute: async () => ({
        rows: [{
          mirrored_count: 6,
          source_label: "StoicHeron724",
          source_user_id: "source-user",
        }],
      }),
    };
    const poller = new CopyMirrorPoller(db as never, {
      sendMirrorSummary: async (input) => {
        sent.push(input);
      },
    });

    await (poller as any).notifyCompletedSourceMirrors(
      "user:source-trade",
      new Date("2026-09-10T06:44:00Z"),
    );

    expect(sent).toEqual([{
      sourceLabel: "StoicHeron724",
      sourceUserId: "source-user",
      mirroredCount: 6,
    }]);
  });

  it("reports while execution is busy without overlapping summary passes", async () => {
    const original = process.env.COPY_TRADE_AUTOMIRROR_ENABLED;
    process.env.COPY_TRADE_AUTOMIRROR_ENABLED = "true";
    try {
      const poller = new CopyMirrorPoller({} as never) as any;
      poller.polling = true;
      const now = new Date("2026-09-10T15:36:10Z");
      poller.readSourceClockNow = async () => now;
      poller.loadReadyMirrorSummarySourceItemIds = async () => ["user:filled-entry"];
      const sent: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      poller.notifyCompletedSourceMirrors = async (source: string) => {
        sent.push(source);
        await gate;
      };
      const first = poller.pollMirrorSummaries();
      await Promise.resolve();
      await Promise.resolve();
      await poller.pollMirrorSummaries();
      release();
      await first;
      expect(sent).toEqual(["user:filled-entry"]);
      expect(poller.polling).toBe(true);
      expect(poller.summaryPolling).toBe(false);
    } finally {
      if (original === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_ENABLED;
      else process.env.COPY_TRADE_AUTOMIRROR_ENABLED = original;
    }
  });
});

describe("mirror failure classification", () => {
  it("retries network, rate-limit, server, and transient Postgres failures", () => {
    expect(classifyMirrorFailure(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })).kind)
      .toBe("transient");
    expect(classifyMirrorFailure({ response: { status: 429 }, message: "rate limited" }).kind)
      .toBe("transient");
    expect(classifyMirrorFailure({ status: 503, message: "broker unavailable" }).kind)
      .toBe("transient");
    expect(classifyMirrorFailure({ code: "40001", message: "serialization failure" }).kind)
      .toBe("transient");
  });

  it("does not retry permanent broker validation or authentication failures", () => {
    expect(classifyMirrorFailure({ response: { status: 401 }, message: "bad key" }).kind)
      .toBe("permanent");
    expect(classifyMirrorFailure({ response: { status: 422 }, message: "invalid qty" }).kind)
      .toBe("permanent");
    expect(classifyMirrorFailure({ code: "NOT_FOUND", message: "credential deleted" }).kind)
      .toBe("permanent");
    expect(classifyMirrorFailure({ code: "23503", message: "foreign key violation" }).kind)
      .toBe("permanent");
  });

  it("does not retry forever when the SDK hides the status in the message text", () => {
    // The production loop this closes. `@alpacahq/alpaca-trade-api` formats
    // market-data rejections as "code: 404, message: ..." and sets neither a
    // `status` nor a `code` property, so the classifier's fail-safe (unknown
    // shape means assume transient) requeued an untradeable ticker off an X
    // signal 39 times an hour, indefinitely.
    expect(
      classifyMirrorFailure(new Error("code: 404, message: no snapshot found for KOSPI")).kind,
    ).toBe("permanent");
    expect(
      classifyMirrorFailure(new Error("code: 422, message: qty must be > 0")).kind,
    ).toBe("permanent");
    // A genuinely retryable status in the same format still retries.
    expect(
      classifyMirrorFailure(new Error("code: 503, message: service unavailable")).kind,
    ).toBe("transient");
  });

  it("keeps the fail-safe for errors that really carry no status", () => {
    // Only an anchored leading "code: NNN" counts. An unrecognized error, or a
    // three-digit number that happens to appear mid-message, must still be
    // treated as recoverable rather than silently dropped.
    expect(statusFromMessage("no snapshot found for code: 404")).toBeUndefined();
    expect(statusFromMessage("failed after 404 attempts")).toBeUndefined();
    expect(statusFromMessage("code: 42, message: nope")).toBeUndefined();
    expect(statusFromMessage("code: 404, message: gone")).toBe(404);

    expect(classifyMirrorFailure(new Error("socket hang up")).kind).toBe("transient");
    expect(classifyMirrorFailure(new Error("failed after 404 attempts")).kind).toBe("transient");
  });

  it("retries duplicate-client-id responses so broker reconciliation can complete", () => {
    expect(
      classifyMirrorFailure({
        response: { status: 422 },
        message: "client_order_id must be unique",
      }).kind,
    ).toBe("transient");
    // The venue says "cloid" where Postgres and Alpaca say "client order id".
    expect(
      classifyMirrorFailure(new Error("Order has duplicate cloid")).kind,
    ).toBe("transient");
  });

  it("never retries an unlisted Hyperliquid coin, which can never resolve", () => {
    // The Alpaca-side loop above, reintroduced on the perps path: `resolveAsset`
    // threw a bare Error with no status and no code, which lands in the
    // fail-safe below and requeues a symbol that will never exist, every 15
    // minutes, with no attempt ceiling, wedging the whole delivery queue.
    const unknownCoin = new HyperliquidUnknownCoinError("xyz:GOOGL");
    expect(unknownCoin.message).toBe("Unknown Hyperliquid coin: xyz:GOOGL");
    expect(classifyMirrorFailure(unknownCoin).kind).toBe("permanent");

    // The fail-safe itself is untouched: a coin-free error with no shape at all
    // is still treated as recoverable.
    expect(classifyMirrorFailure(new Error("socket hang up")).kind).toBe("transient");
  });

  it("uses bounded exponential retry delays", () => {
    expect(mirrorRetryDelayMs(1)).toBe(30_000);
    expect(mirrorRetryDelayMs(2)).toBe(60_000);
    expect(mirrorRetryDelayMs(10)).toBe(15 * 60_000);
  });
});

describe("CopyMirrorPoller durable orchestration", () => {
  const originalEnabled = process.env.COPY_TRADE_AUTOMIRROR_ENABLED;

  beforeEach(() => {
    process.env.COPY_TRADE_AUTOMIRROR_ENABLED = "true";
  });

  afterEach(() => {
    clearErrorReporter();
    if (originalEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_ENABLED;
    else process.env.COPY_TRADE_AUTOMIRROR_ENABLED = originalEnabled;
  });

  function failurePoller(row: typeof delivery, thrown: unknown): PollerHarness {
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-07-10T12:00:00.000Z");
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      await onPage([]);
    };
    poller.findMirrorCandidates = async () => [];
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [row];
    poller.processCandidate = async () => {
      throw thrown;
    };
    poller.markDeliveryCompleted = async () => {
      throw new Error("failed delivery must not complete");
    };
    poller.markDeliveryFailed = async () => undefined;
    return poller;
  }

  it("reopens a bounded source overlap while keeping the durable checkpoint monotonic", () => {
    const checkpoint = new Date("2026-08-21T12:00:00.000Z");
    const replayStart = mirrorSourceReplayStart(checkpoint);

    expect(replayStart).toEqual(
      new Date(checkpoint.getTime() - COPY_MIRROR_LATE_SOURCE_REPLAY_MS),
    );
    expect(replayStart.getTime()).toBeLessThan(checkpoint.getTime());
  });

  it("replays a late source row and a follow inserted during paging without duplicate durable delivery", async () => {
    const initialCheckpoint = new Date("2026-08-21T12:00:00.000Z");
    let checkpoint = initialCheckpoint;
    let cycle = 0;
    const durableKeys = new Set<string>();
    const initialFollow = { id: "follow-initial", followerUserId: "follower-1" };
    const lateFollow = { id: "follow-late", followerUserId: "follower-2" };
    const initial = { ...candidate, sourceItemId: "user:initial" };
    const lateSource = { ...candidate, sourceItemId: "user:late" };
    const followInsertedDuringPaging = {
      ...candidate,
      followerUserId: lateFollow.followerUserId,
      sourceItemId: "user:initial",
    };
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;

    poller.loadOrCreateCheckpoint = async () => checkpoint;
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      // The first cycle's fixed follow fence intentionally excludes this row.
      await onPage(cycle === 0 ? [initialFollow] : [initialFollow, lateFollow]);
    };
    poller.findMirrorCandidates = async (follows, start, _end, onBatch) => {
      expect(start).toEqual(mirrorSourceReplayStart(checkpoint));
      if (cycle === 0) {
        expect(follows).toEqual([initialFollow]);
        if (onBatch) await onBatch([initial]);
      } else {
        expect(follows).toEqual([initialFollow, lateFollow]);
        // The first row is replayed deliberately. The durable unique key must
        // absorb it while the late source and newly armed follow are admitted.
        if (onBatch) await onBatch([initial, lateSource, followInsertedDuringPaging]);
      }
      return [];
    };
    poller.stageDeliveryBatch = async (_end, batch) => {
      for (const item of batch) {
        durableKeys.add(`${item.followerUserId}|${item.sourceItemId}`);
      }
    };
    poller.advanceCheckpoint = async (_start, end) => {
      expect(end.getTime()).toBeGreaterThanOrEqual(checkpoint.getTime());
      checkpoint = end;
      cycle += 1;
    };
    poller.loadDueDeliveries = async () => [];

    await poller.poll();
    await poller.poll();

    expect(cycle).toBe(2);
    expect([...durableKeys].sort()).toEqual([
      "follower-1|user:initial",
      "follower-1|user:late",
      "follower-2|user:initial",
    ]);
  });

  it("drains auto-mirror follows across deterministic bounded pages", async () => {
    const rowCount = COPY_MIRROR_FOLLOW_PAGE_SIZE * 2 + 1;
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      id: `follow-${String(rowCount - index).padStart(4, "0")}`,
      followerUserId: `follower-${index}`,
      targetType: "user",
      targetKey: `trader-${index}`,
      targetLabel: null,
      sizingMode: "pct",
      sizingValue: "5.00",
      autoMirror: true,
      credentialId: null,
      createdAt: new Date("2026-07-10T12:00:00.123Z"),
    }));
    let pageCalls = 0;
    const followQuery: any = {
      from: () => followQuery,
      where: () => followQuery,
      orderBy: () => followQuery,
      limit: (limit: number) => {
        if (limit === 1) return Promise.resolve(rows.slice(0, 1));
        const start = pageCalls * limit;
        pageCalls += 1;
        return Promise.resolve(rows.slice(start, start + limit));
      },
    };
    const poller = new CopyMirrorPoller({ select: () => followQuery } as never);
    const loaded: typeof rows = [];
    await (poller as unknown as PollerHarness).forEachAutoMirrorFollowPage(async (page) => {
      loaded.push(...page as typeof rows);
    });

    expect(loaded.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(pageCalls).toBe(3);
  });

  it("loads the persisted watermark, durably stages the window, then completes due work", async () => {
    const persisted = new Date("2026-07-10T12:00:00.000Z");
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      calls.push("follow-pages");
      await onPage([
        { ...candidate, id: "follow-1" },
        { ...candidate, id: "follow-2", followerUserId: "follower-2" },
      ]);
    };

    poller.loadOrCreateCheckpoint = async () => persisted;
    poller.findMirrorCandidates = async (follows, start, end) => {
      expect(follows).toHaveLength(2);
      expect(start).toEqual(mirrorSourceReplayStart(persisted));
      expect(end.getTime()).toBeGreaterThan(persisted.getTime());
      calls.push("discover");
      return [candidate];
    };
    poller.stageDeliveryBatch = async (_end, candidates) => {
      expect(candidates).toEqual([candidate]);
      calls.push("stage");
    };
    poller.advanceCheckpoint = async (start) => {
      expect(start).toEqual(persisted);
      calls.push("checkpoint");
    };
    poller.loadDueDeliveries = async () => {
      calls.push("load-due");
      return [delivery];
    };
    poller.processCandidate = async (value) => {
      expect(value).toEqual(candidate);
      calls.push("process");
      return "placed";
    };
    poller.markDeliveryCompleted = async (_id, outcome) => {
      expect(outcome).toBe("placed");
      calls.push("complete");
    };
    poller.markDeliveryFailed = async () => {
      throw new Error("unexpected failure");
    };

    await poller.poll();

    expect(calls).toEqual(["follow-pages", "discover", "stage", "checkpoint", "load-due", "process", "complete"]);
  });

  it("requeues a syncing outcome instead of marking the mirror delivery complete", async () => {
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-07-10T12:00:00.000Z");
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      await onPage([]);
    };
    poller.findMirrorCandidates = async () => [];
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [delivery];
    poller.processCandidate = async () => "syncing";
    poller.markDeliveryCompleted = async () => {
      calls.push("complete");
    };
    poller.markDeliveryFailed = async (_row, failure) => {
      expect(failure).toMatchObject({ kind: "transient" });
      calls.push("retry");
    };

    await poller.poll();

    expect(calls).toEqual(["retry"]);
  });

  it("keeps transient failures pending after the source watermark advances", async () => {
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-07-10T12:00:00.000Z");
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      await onPage([candidate]);
    };
    poller.findMirrorCandidates = async () => [candidate];
    poller.stageDeliveryBatch = async () => {
      calls.push("watermark-advanced");
    };
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [delivery];
    poller.processCandidate = async () => {
      throw Object.assign(new Error("broker timeout"), { code: "ETIMEDOUT" });
    };
    poller.markDeliveryCompleted = async () => {
      throw new Error("transient failure must not complete");
    };
    poller.markDeliveryFailed = async (_row, failure) => {
      expect(failure.kind).toBe("transient");
      calls.push("retry-persisted");
    };

    await poller.poll();

    expect(calls).toEqual(["watermark-advanced", "retry-persisted"]);
  });

  it("records permanent failures without retrying the source on restart", async () => {
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;
    let recordedKind: string | undefined;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-07-10T12:00:00.000Z");
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      await onPage([candidate]);
    };
    poller.findMirrorCandidates = async () => [candidate];
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [delivery];
    poller.processCandidate = async () => {
      throw Object.assign(new Error("invalid order quantity"), { status: 422 });
    };
    poller.markDeliveryCompleted = async () => {
      throw new Error("permanent failure must not complete as success");
    };
    poller.markDeliveryFailed = async (_row, failure) => {
      recordedKind = failure.kind;
    };

    await poller.poll();

    expect(recordedKind).toBe("permanent");
  });

  it("does not send an error-level report when a transient candidate failure is requeued", async () => {
    const reports: string[] = [];
    setErrorReporter(({ message }) => reports.push(message));

    await failurePoller(
      delivery,
      Object.assign(new Error("broker timeout"), { code: "ETIMEDOUT" }),
    ).poll();

    expect(reports).toEqual([]);
  });

  it("keeps an error-level report for a permanent candidate failure", async () => {
    const reports: string[] = [];
    setErrorReporter(({ message }) => reports.push(message));

    await failurePoller(
      delivery,
      Object.assign(new Error("invalid order quantity"), { status: 422 }),
    ).poll();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("candidate failed");
  });

  it("keeps an error-level report when a transient candidate exhausts its attempts", async () => {
    const reports: string[] = [];
    setErrorReporter(({ message }) => reports.push(message));
    const exhaustedDelivery = {
      ...delivery,
      attempts: MIRROR_MAX_DELIVERY_ATTEMPTS - 1,
    };

    await failurePoller(
      exhaustedDelivery,
      Object.assign(new Error("broker timeout"), { code: "ETIMEDOUT" }),
    ).poll();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("candidate failed");
  });
});

describe("Hyperliquid open intent age fences", () => {
  const names = [
    "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED",
    "HYPERLIQUID_SYNC_ENABLED",
    "HYPERLIQUID_NETWORK",
    "HYPERLIQUID_ALLOW_TESTNET",
    "COPY_TRADE_AUTOMIRROR_ALLOW_LIVE",
  ] as const;
  let original: Partial<Record<(typeof names)[number], string>>;

  beforeEach(() => {
    original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED = "true";
    process.env.HYPERLIQUID_SYNC_ENABLED = "true";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_ALLOW_TESTNET = "true";
    process.env.COPY_TRADE_AUTOMIRROR_ALLOW_LIVE = "true";
  });

  afterEach(() => {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("terminalizes wallet opens past five minutes without shrinking the shared fifteen-minute fence", async () => {
    const now = Date.now();
    let venueClientCalls = 0;
    const db = {
      execute: async () => ({ rows: [{ now: new Date(now) }] }),
      query: {
        userApiCredentials: { findFirst: async () => undefined },
        copyTradeFollows: { findFirst: async () => undefined },
      },
    };
    const poller = new CopyMirrorPoller(db as never, {
      createPerpClient: async () => {
        venueClientCalls++;
        throw new Error("expired open must not create a venue client");
      },
    }) as any;
    const openCandidate = (sourceItemId: string, ageMs: number) => ({
      followerUserId: "follower-1",
      followId: "follow-1",
      credentialId: "00000000-0000-4000-8000-000000000001",
      sourceItemId,
      sourceEventAt: new Date(now - ageMs).toISOString(),
      symbol: "BTC",
      side: "buy",
      sizingMode: "usd",
      sizingValue: 20,
      assetType: "PERP",
      perpSide: "long",
      perpLeverage: 1,
      perpUserMaxLeverage: 2,
      perpFollowMaxLeverage: null,
      perpMarginMode: "cross",
      perpReduceOnly: false,
      sourceVenueNetwork: "testnet",
    });
    const guards = {
      dailyCap: null,
      perpDailyCap: null,
      maxOrderDollars: null,
      liveAllowed: true,
      perpsEnabled: true,
      mainnetAllowed: true,
    };

    const walletResult = await poller.processPerpCandidate(
      openCandidate(`hl_wallet:${"0x1111111111111111111111111111111111111111"}:42`, 6 * 60_000),
      undefined,
      guards,
    );
    const pendingWalletResult = await poller.processPerpCandidate(
      openCandidate(`hl_wallet:${"0x1111111111111111111111111111111111111111"}:43`, 6 * 60_000),
      { status: "PENDING", reduceOnly: false },
      guards,
    );
    const sharedResult = await poller.processPerpCandidate(
      openCandidate("user:older-than-shared-bound", 16 * 60_000),
      undefined,
      guards,
    );

    expect([walletResult, pendingWalletResult, sharedResult]).toEqual([
      "stale-intent",
      "stale-intent",
      "stale-intent",
    ]);
    expect(venueClientCalls).toBe(0);
  });
});

/**
 * `loadDueDeliveries` selects on status/next_attempt_at with no row lock, so a
 * second worker replica polling the same due batch loads the identical rows.
 * Without a claim, both processes call `processCandidate` for the same
 * delivery and can each place a real order for it under the same cloid.
 * `claimDelivery` closes that gap with a compare-and-set lease: whichever
 * process's UPDATE matches the row first wins, and the loser's `returning`
 * comes back empty.
 */
describe("delivery claiming", () => {
  const originalEnabled = process.env.COPY_TRADE_AUTOMIRROR_ENABLED;

  beforeEach(() => {
    process.env.COPY_TRADE_AUTOMIRROR_ENABLED = "true";
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_ENABLED;
    else process.env.COPY_TRADE_AUTOMIRROR_ENABLED = originalEnabled;
  });

  function capturingClaimPoller(claimReturns: Array<Array<{ id: string }>>) {
    const sets: Array<Record<string, unknown>> = [];
    const wheres: unknown[] = [];
    let call = 0;
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return {
            where: (whereClause: unknown) => {
              wheres.push(whereClause);
              const result = claimReturns[call] ?? [];
              call += 1;
              return { returning: async () => result };
            },
          };
        },
      }),
    } as never;
    return { poller: new CopyMirrorPoller(db), sets, wheres };
  }

  type ClaimHarness = {
    claimDelivery: (id: string, observedNextAttemptAt: Date, now: Date) => Promise<boolean>;
  };

  it("wins the claim and leases next_attempt_at strictly past now", async () => {
    const { poller, sets, wheres } = capturingClaimPoller([[{ id: delivery.id }]]);
    const observed = new Date("2026-08-09T12:00:00.000Z");
    const now = new Date("2026-08-09T12:00:05.000Z");

    const claimed = await (poller as unknown as ClaimHarness).claimDelivery(
      delivery.id,
      observed,
      now,
    );

    expect(claimed).toBe(true);
    expect(sets).toHaveLength(1);
    const leased = sets[0]!.nextAttemptAt as Date;
    // The lease moves the row well past `now`, not merely past the value it
    // observed, so a crashed claimant's row is not immediately due again.
    expect(leased.getTime()).toBeGreaterThan(now.getTime());
    expect(wheres).toHaveLength(1);
  });

  it("loses the claim when another process already moved next_attempt_at", async () => {
    // Zero rows back is exactly what a losing compare-and-set looks like: the
    // WHERE clause (id + status='pending' + next_attempt_at=observed) matched
    // nothing because the winner already changed the row out from under it.
    const { poller } = capturingClaimPoller([[]]);

    const claimed = await (poller as unknown as ClaimHarness).claimDelivery(
      delivery.id,
      new Date("2026-08-09T12:00:00.000Z"),
      new Date(),
    );

    expect(claimed).toBe(false);
  });

  it("stops the batch rather than skipping ahead when a claim is lost", async () => {
    // Two due rows, ordered exactly as `orderDueDeliveries` would hand them
    // over. The FIRST row's claim is lost to another process (or cycle); the
    // second row's claim would WIN if it were ever attempted, but running it
    // anyway would let this replica execute a later delivery while another
    // process is still (for all this one knows) mid-flight on an earlier one
    // in the same source-event sequence -- precisely the reordering hazard
    // `orderDueDeliveries`/`orderCandidatesBySourceEvent` exist to prevent.
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness & ClaimHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-07-10T12:00:00.000Z");
    poller.findMirrorCandidates = async () => [];
    poller.stageWindow = async () => undefined;
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    const openRow = { ...delivery, id: "open-row", sourceItemId: "user:open" };
    const closeRow = { ...delivery, id: "close-row", sourceItemId: "user:close" };
    poller.loadDueDeliveries = async () => [openRow, closeRow];
    poller.claimDelivery = async (id) => {
      calls.push(`claim:${id}`);
      return id === "close-row";
    };
    poller.processCandidate = async (value) => {
      calls.push(`process:${value.sourceItemId}`);
      return "placed";
    };
    poller.markDeliveryCompleted = async () => {
      calls.push("complete");
    };
    poller.markDeliveryFailed = async () => {
      calls.push("failed");
    };

    await poller.poll();

    // Only the lost claim on the FIRST row was ever attempted. Neither row was
    // processed, and the second row's own claim (which would have won) was
    // never even tried.
    expect(calls).toEqual(["claim:open-row"]);
  });

  it("processes normally when the claim is won", async () => {
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness & ClaimHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-07-10T12:00:00.000Z");
    poller.findMirrorCandidates = async () => [];
    poller.stageWindow = async () => undefined;
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [delivery];
    poller.claimDelivery = async (id) => {
      calls.push(`claim:${id}`);
      return true;
    };
    poller.processCandidate = async () => {
      calls.push("process");
      return "placed";
    };
    poller.markDeliveryCompleted = async () => {
      calls.push("complete");
    };
    poller.markDeliveryFailed = async () => {
      calls.push("failed");
    };

    await poller.poll();

    expect(calls).toEqual([`claim:${delivery.id}`, "process", "complete"]);
  });
});

/**
 * A durable queue with no attempt ceiling never stops. The intent stays armed,
 * so a leveraged order can still fire long after the source trade, and the
 * queue itself never drains past whatever is wedged at the front of it.
 */
describe("delivery attempt ceiling", () => {
  function capturingPoller() {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: () => ({
              returning: async () => [{ id: delivery.id }],
            }),
          };
        },
      }),
    } as never;
    return { poller: new CopyMirrorPoller(db), writes };
  }

  it("treats a zero-row completion update as a lost CAS", async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db) as unknown as PollerHarness;

    await expect(
      poller.markDeliveryCompleted(delivery.id, "placed", new Date("2026-08-09T12:00:00.000Z")),
    ).rejects.toThrow("completion CAS matched no row");
  });

  it("completes a delivery only after an exact-one completion update", async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: delivery.id }] }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db) as unknown as PollerHarness;

    await expect(
      poller.markDeliveryCompleted(delivery.id, "placed", new Date("2026-08-09T12:00:00.000Z")),
    ).resolves.toBeUndefined();
  });

  it("treats a multi-row completion update as an ambiguous CAS", async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "delivery-a" }, { id: "delivery-b" }],
          }),
        }),
      }),
    } as never;
    const poller = new CopyMirrorPoller(db) as unknown as PollerHarness;

    await expect(
      poller.markDeliveryCompleted(delivery.id, "placed", new Date("2026-08-09T12:00:00.000Z")),
    ).rejects.toThrow("completion CAS");
  });

  it("keeps retrying a transient failure below the ceiling", async () => {
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      { ...delivery, attempts: 1 },
      { kind: "transient", message: "broker timeout" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("gives up terminally once the ceiling is reached, preserving the last error", async () => {
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      { ...delivery, attempts: MIRROR_MAX_DELIVERY_ATTEMPTS - 1 },
      { kind: "transient", message: "broker timeout" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      status: "permanent_failure",
      attempts: MIRROR_MAX_DELIVERY_ATTEMPTS,
    });
    // The operator still needs to know what the broker was doing, because a
    // failed local write does not prove the order never reached it.
    expect(String(writes[0]!.lastError)).toContain("broker timeout");
    expect(writes[0]!.nextAttemptAt).toBeUndefined();
  });

  it("never abandons a reduce-only close at the ceiling", async () => {
    // A close is the ONE instruction that exits a position the mirror opened,
    // and nothing regenerates it. It is already exempt from the consent gate and
    // the staleness bound for that reason; the attempt ceiling is a third door to
    // the same outcome. An outage longer than the ~62 minutes of backoff would
    // otherwise strand the follower in a leveraged position with their exit spent.
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      {
        ...delivery,
        attempts: MIRROR_MAX_DELIVERY_ATTEMPTS * 10,
        candidate: { ...delivery.candidate, perpReduceOnly: true },
      } as typeof delivery,
      { kind: "transient", message: "hyperliquid unreachable" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: "pending" });
    expect(writes[0]!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("never abandons an equity SELL close at the ceiling", async () => {
    // The exemption used to read `perpReduceOnly`, which only the Hyperliquid
    // candidate builder ever sets, so an Alpaca exit fell through to
    // permanent_failure after MIRROR_MAX_DELIVERY_ATTEMPTS transient errors.
    // An equity SELL is the same one-shot instruction as a reduce-only perp
    // close (the reading `processCandidate` and `decideEquityMirrorConsent`
    // already take), and nothing regenerates it once the checkpoint moves on.
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      {
        ...delivery,
        attempts: MIRROR_MAX_DELIVERY_ATTEMPTS * 10,
        candidate: {
          ...delivery.candidate,
          side: "sell",
          assetType: "EQUITY",
          tradeAction: "Sell",
        },
      } as unknown as typeof delivery,
      { kind: "transient", message: "alpaca 503" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: "pending" });
    expect(writes[0]!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("never abandons an option SellToClose at the ceiling", async () => {
    // Options ride the same Alpaca queue and mark their exit the same way:
    // `optionAction === "SellToClose"` is staged as `side: "sell"`.
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      {
        ...delivery,
        attempts: MIRROR_MAX_DELIVERY_ATTEMPTS,
        candidate: {
          ...delivery.candidate,
          side: "sell",
          assetType: "OPTION",
          tradeAction: "SellToClose",
        },
      } as unknown as typeof delivery,
      { kind: "transient", message: "alpaca 429" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: "pending" });
    expect(writes[0]!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("still abandons a perp SHORT ENTRY at the ceiling", async () => {
    // The venue-neutral reading must not swallow this one: a perp short entry
    // is also staged as `side: "sell"` (candidate sources: `perpSide === "long"
    // ? "buy" : "sell"`) with `perpReduceOnly: false`. It is an ENTRY, so the
    // ceiling's original argument applies and it must still terminate.
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      {
        ...delivery,
        attempts: MIRROR_MAX_DELIVERY_ATTEMPTS - 1,
        candidate: {
          ...delivery.candidate,
          side: "sell",
          assetType: "PERP",
          perpSide: "short",
          perpReduceOnly: false,
        },
      } as unknown as typeof delivery,
      { kind: "transient", message: "hyperliquid unreachable" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      status: "permanent_failure",
      attempts: MIRROR_MAX_DELIVERY_ATTEMPTS,
    });
  });

  it("still abandons a reduce-only close on a PERMANENT failure", async () => {
    // The exemption is about outages, not about retrying something that can
    // never work. A permanent failure terminates whatever the intent is.
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      {
        ...delivery,
        attempts: 0,
        candidate: { ...delivery.candidate, perpReduceOnly: true },
      } as typeof delivery,
      { kind: "permanent", message: "invalid qty" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes[0]).toMatchObject({ status: "permanent_failure" });
  });

  it("still fails a permanent error terminally on the first attempt", async () => {
    const { poller, writes } = capturingPoller();
    await (poller as unknown as PollerHarness).markDeliveryFailed(
      { ...delivery, attempts: 0 },
      { kind: "permanent", message: "invalid qty" },
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(writes[0]).toMatchObject({
      status: "permanent_failure",
      attempts: 1,
      lastError: "invalid qty",
    });
  });
});

/**
 * A source who opens and closes inside one 30-second poll window used to have
 * both deliveries stamped with the SAME next_attempt_at and no secondary key, so
 * the close could be handed over first: it skipped on no-position, was marked
 * completed, and the entry that arrived second opened a leveraged position the
 * source had already exited.
 */
describe("stageWindow ordering", () => {
  function capturingPoller() {
    const staged: Array<Record<string, unknown>> = [];
    const tx = {
      insert: () => ({
        values: (rows: Array<Record<string, unknown>>) => {
          staged.push(...rows);
          return { onConflictDoNothing: async () => undefined };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ consumer: "copy-mirror-v1" }] }),
        }),
      }),
    };
    const db = {
      transaction: async (run: (t: typeof tx) => Promise<void>) => run(tx),
    } as never;
    return { poller: new CopyMirrorPoller(db), staged };
  }

  it("stages an entry ahead of its own close, and leaves both due immediately", async () => {
    const windowEnd = new Date("2026-08-09T12:00:30.000Z");
    const { poller, staged } = capturingPoller();

    await (
      poller as unknown as {
        stageWindow: (
          start: Date,
          end: Date,
          candidates: Array<Record<string, unknown>>,
        ) => Promise<void>;
      }
    ).stageWindow(new Date("2026-08-09T12:00:00.000Z"), windowEnd, [
      {
        ...candidate,
        sourceItemId: "user:close",
        sourceEventAt: "2026-08-09T12:00:20.000Z",
        perpReduceOnly: true,
      },
      {
        ...candidate,
        sourceItemId: "user:open",
        sourceEventAt: "2026-08-09T12:00:05.000Z",
        perpReduceOnly: false,
      },
    ]);

    expect(staged.map((row) => row.sourceItemId)).toEqual(["user:open", "user:close"]);
    const first = staged[0]!.nextAttemptAt as Date;
    const second = staged[1]!.nextAttemptAt as Date;
    expect(first.getTime()).toBeLessThan(second.getTime());
    // Both are still due in this same cycle: stamping the rank FORWARD would
    // have pushed the close into the next poll.
    expect(second.getTime()).toBeLessThanOrEqual(windowEnd.getTime());
  });

  it("bounds durable delivery inserts for populations larger than one stage batch", async () => {
    const stagedBatchSizes: number[] = [];
    let checkpointUpdates = 0;
    const tx = {
      insert: () => ({
        values: (rows: Array<Record<string, unknown>>) => ({
          onConflictDoNothing: async () => {
            stagedBatchSizes.push(rows.length);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              checkpointUpdates += 1;
              return [{ consumer: "copy-mirror-v1" }];
            },
          }),
        }),
      }),
    };
    const db = {
      transaction: async (run: (t: typeof tx) => Promise<void>) => run(tx),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const candidates = Array.from({
      length: COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE * 2 + 1,
    }, (_, index) => ({
      ...candidate,
      sourceItemId: `user:batch-${String(index).padStart(4, "0")}`,
    }));

    await (poller as unknown as PollerHarness).stageWindow(
      new Date("2026-08-09T12:00:00.000Z"),
      new Date("2026-08-09T12:00:30.000Z"),
      candidates,
    );

    expect(stagedBatchSizes).toEqual([
      COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE,
      COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE,
      1,
    ]);
    expect(Math.max(...stagedBatchSizes)).toBeLessThanOrEqual(COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE);
    expect(checkpointUpdates).toBe(1);
  });

  it("retries a failed later batch from the unchanged checkpoint without duplicates", async () => {
    const durableIds = new Set<string>();
    let insertBatch = 0;
    let failNextBatch = true;
    let checkpointUpdates = 0;
    const tx = {
      insert: () => ({
        values: (rows: Array<{ sourceItemId: string }>) => ({
          onConflictDoNothing: async () => {
            insertBatch += 1;
            if (insertBatch === 2 && failNextBatch) {
              failNextBatch = false;
              throw new Error("later stage batch failed");
            }
            for (const row of rows) durableIds.add(row.sourceItemId);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              checkpointUpdates += 1;
              return [{ consumer: "copy-mirror-v1" }];
            },
          }),
        }),
      }),
    };
    const db = {
      transaction: async (run: (t: typeof tx) => Promise<void>) => run(tx),
    } as never;
    const poller = new CopyMirrorPoller(db);
    const candidates = Array.from({
      length: COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE * 2 + 1,
    }, (_, index) => ({
      ...candidate,
      sourceItemId: `user:retry-${String(index).padStart(4, "0")}`,
    }));
    const start = new Date("2026-08-09T12:00:00.000Z");
    const end = new Date("2026-08-09T12:00:30.000Z");
    const stage = (poller as unknown as PollerHarness).stageWindow;

    await expect(stage.call(poller, start, end, candidates)).rejects.toThrow("later stage batch failed");
    expect(durableIds.size).toBe(COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE);
    expect(checkpointUpdates).toBe(0);

    await stage.call(poller, start, end, candidates);
    expect(durableIds.size).toBe(candidates.length);
    expect(checkpointUpdates).toBe(1);
    expect(new Set(durableIds)).toEqual(new Set(candidates.map(({ sourceItemId }) => sourceItemId)));
  });
});

/**
 * A deferred perp close is held on purpose and never expires: preflight defers
 * it while the perps gate (or the reconciler, the network, the mainnet / live
 * opt-ins) withholds it, and the attempt ceiling exempts it so it survives until
 * the configuration lets it through. That is correct.
 *
 * What was missing is that NOTHING LOOKED AT THE RESULTING QUEUE. Turning perps
 * off left closes retrying every fifteen minutes indefinitely, with no count, no
 * age and no line anywhere, so an operator could not tell an empty queue from a
 * backlog of followers stuck in leveraged positions with their exits unspent.
 */
describe("deferred perp close backlog", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const originalEnabled = process.env.COPY_TRADE_AUTOMIRROR_ENABLED;

  beforeEach(() => {
    process.env.COPY_TRADE_AUTOMIRROR_ENABLED = "true";
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.COPY_TRADE_AUTOMIRROR_ENABLED;
    else process.env.COPY_TRADE_AUTOMIRROR_ENABLED = originalEnabled;
  });

  function queued(overrides: Partial<DeferredCloseRow> = {}): DeferredCloseRow {
    return {
      sourceItemId: "user:close-1",
      followerUserId: "follower-1",
      createdAt: new Date(now.getTime() - 60_000),
      attempts: 3,
      lastError: "perp close held back by configuration: perps-disabled",
      ...overrides,
    };
  }

  it("reports nothing to see when no close is queued", () => {
    const backlog = describeDeferredCloseBacklog([], now);
    expect(backlog).toMatchObject({
      count: 0,
      oldestAgeMs: null,
      oldestSourceItemId: null,
      overdue: false,
      truncated: false,
    });
  });

  it("counts the queue and ages it from its OLDEST row", () => {
    const backlog = describeDeferredCloseBacklog(
      [
        queued({
          sourceItemId: "user:close-old",
          createdAt: new Date(now.getTime() - 90 * 60_000),
        }),
        queued({ sourceItemId: "user:close-new" }),
      ],
      now,
    );

    expect(backlog.count).toBe(2);
    expect(backlog.oldestAgeMs).toBe(90 * 60_000);
    expect(backlog.oldestSourceItemId).toBe("user:close-old");
    expect(backlog.oldestFollowerUserId).toBe("follower-1");
    // Why it is stuck, not just that it is stuck.
    expect(backlog.oldestLastError).toContain("perps-disabled");
    // Comfortably under the threshold: an hour and a half of retries is an
    // outage riding itself out, not an abandoned queue.
    expect(backlog.overdue).toBe(false);
  });

  it("warns once the oldest wait reaches the threshold, and not a moment before", () => {
    const justUnder = describeDeferredCloseBacklog(
      [queued({ createdAt: new Date(now.getTime() - (DEFERRED_CLOSE_WARN_AFTER_MS - 1)) })],
      now,
    );
    expect(justUnder.overdue).toBe(false);

    const atThreshold = describeDeferredCloseBacklog(
      [queued({ createdAt: new Date(now.getTime() - DEFERRED_CLOSE_WARN_AFTER_MS) })],
      now,
    );
    expect(atThreshold.overdue).toBe(true);
    expect(atThreshold.oldestAgeMs).toBe(DEFERRED_CLOSE_WARN_AFTER_MS);
  });

  it("keeps the age exact when the scan is truncated, and says the count is a floor", () => {
    // The cap discards the NEWEST end, so a saturated queue still reports the
    // real oldest wait. Under-reporting the count is survivable; under-reporting
    // the age would hide exactly the backlog that has to be noticed.
    const backlog = describeDeferredCloseBacklog(
      [
        queued({
          sourceItemId: "user:close-old",
          createdAt: new Date(now.getTime() - 5 * 60 * 60_000),
        }),
        queued({ sourceItemId: "user:close-mid" }),
        queued({ sourceItemId: "user:close-new" }),
      ],
      now,
      2,
    );

    expect(backlog.truncated).toBe(true);
    expect(backlog.count).toBe(2);
    expect(backlog.oldestAgeMs).toBe(5 * 60 * 60_000);
    expect(backlog.overdue).toBe(true);
  });

  it("still counts a row whose timestamp is unreadable", () => {
    // Dropping it would make the queue look shorter than it is, which is the
    // blindness this snapshot exists to end.
    const backlog = describeDeferredCloseBacklog(
      [
        queued({ sourceItemId: "user:close-broken", createdAt: new Date(Number.NaN) }),
        queued({ sourceItemId: "user:close-good" }),
      ],
      now,
    );

    expect(backlog.count).toBe(2);
    expect(backlog.oldestSourceItemId).toBe("user:close-good");
    expect(backlog.oldestAgeMs).toBe(60_000);
  });

  it("never reports a negative wait when the clock moves backwards", () => {
    const backlog = describeDeferredCloseBacklog(
      [queued({ createdAt: new Date(now.getTime() + 5 * 60_000) })],
      now,
    );
    expect(backlog.oldestAgeMs).toBe(0);
    expect(backlog.overdue).toBe(false);
  });

  it("reads the queue with a bounded, oldest-first scan", async () => {
    // Audit H6: no unbounded scans on the delivery table. One row past the cap
    // is read so a saturated queue is detectable instead of looking exact.
    let args: Record<string, unknown> | undefined;
    const db = {
      query: {
        copyMirrorDeliveries: {
          findMany: async (received: Record<string, unknown>) => {
            args = received;
            // The reduce-only flag makes this row a close; the read filters
            // venue-neutrally on the candidate payload itself now, not on a
            // SQL predicate the mock can't see.
            return [{ ...queued(), candidate: { perpReduceOnly: true } }];
          },
        },
      },
    } as never;

    const poller = new CopyMirrorPoller(db) as unknown as PollerHarness;
    const backlog = await poller.readDeferredCloseBacklog(now);

    expect(args?.limit).toBe(DEFERRED_CLOSE_SCAN_CAP + 1);
    expect(args?.where).toBeDefined();
    expect(args?.orderBy).toBeDefined();
    expect(backlog.count).toBe(1);
    expect(backlog.oldestAgeMs).toBe(60_000);
  });

  it("counts an Alpaca equity/option close, not only a Hyperliquid perpReduceOnly one", async () => {
    // Commit ef4bda2 made the attempt-ceiling exemption in `markDeliveryFailed`
    // read venue-neutrally via `isClosingCandidate` (a reduce-only perp mirror,
    // or any non-perp mirror staged as a sell). This query still matched only
    // `candidate->>'perpReduceOnly' = 'true'`, a narrower, second definition of
    // "close" that no Alpaca payload ever satisfies. A follower's mirrored
    // equity close, correctly kept pending and retried past the ceiling, was
    // therefore invisible to this backlog even though it was genuinely wedged.
    //
    // The equity OPEN (a `buy`) is included to prove this is a closing filter
    // and not just "count everything the query returns": it is the oldest row
    // here, so it would wrongly become `oldestSourceItemId` if it leaked in.
    const rows = [
      {
        sourceItemId: "user:equity-open",
        followerUserId: "follower-3",
        createdAt: new Date(now.getTime() - 10 * 60_000),
        attempts: 2,
        lastError: "alpaca 503",
        candidate: { assetType: "EQUITY", side: "buy" },
      },
      {
        sourceItemId: "user:perp-close",
        followerUserId: "follower-1",
        createdAt: new Date(now.getTime() - 5 * 60_000),
        attempts: 4,
        lastError: "perp close held back by configuration: perps-disabled",
        candidate: { perpReduceOnly: true },
      },
      {
        sourceItemId: "user:equity-close",
        followerUserId: "follower-2",
        createdAt: new Date(now.getTime() - 2 * 60_000),
        attempts: 9,
        lastError: "alpaca 503",
        candidate: { assetType: "EQUITY", side: "sell" },
      },
    ];
    const db = {
      query: {
        copyMirrorDeliveries: {
          findMany: async () => rows,
        },
      },
    } as never;

    const poller = new CopyMirrorPoller(db) as unknown as PollerHarness;
    const backlog = await poller.readDeferredCloseBacklog(now);

    // Both closes counted, the equity OPEN excluded from both the count and
    // the "oldest" reading.
    expect(backlog.count).toBe(2);
    expect(backlog.oldestSourceItemId).toBe("user:perp-close");
    expect(backlog.oldestFollowerUserId).toBe("follower-1");
    expect(backlog.oldestAgeMs).toBe(5 * 60_000);
  });

  it("reports the queue on the poll cycle, AFTER the due batch has been drained", async () => {
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-08-09T11:59:30.000Z");
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      await onPage([candidate]);
    };
    poller.findMirrorCandidates = async () => [candidate];
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [delivery];
    poller.processCandidate = async () => {
      calls.push("process");
      return "placed";
    };
    poller.markDeliveryCompleted = async () => {
      calls.push("complete");
    };
    poller.markDeliveryFailed = async () => {
      throw new Error("unexpected failure");
    };
    poller.readDeferredCloseBacklog = async () => {
      calls.push("backlog");
      return describeDeferredCloseBacklog([queued()], now);
    };

    await poller.poll();

    // Last, so the numbers describe what is STILL stuck rather than what was
    // about to be retried.
    expect(calls).toEqual(["process", "complete", "backlog"]);
  });

  it("never lets an unreadable backlog fail the cycle it was describing", async () => {
    const calls: string[] = [];
    const poller = new CopyMirrorPoller(fakeDb()) as unknown as PollerHarness;

    poller.loadOrCreateCheckpoint = async () => new Date("2026-08-09T11:59:30.000Z");
    poller.forEachAutoMirrorFollowPage = async (onPage) => {
      await onPage([candidate]);
    };
    poller.findMirrorCandidates = async () => [candidate];
    poller.stageDeliveryBatch = async () => undefined;
    poller.advanceCheckpoint = async () => undefined;
    poller.loadDueDeliveries = async () => [delivery];
    poller.processCandidate = async () => "placed";
    poller.markDeliveryCompleted = async () => {
      calls.push("complete");
    };
    poller.markDeliveryFailed = async () => {
      throw new Error("unexpected failure");
    };
    poller.readDeferredCloseBacklog = async () => {
      calls.push("backlog");
      throw new Error("delivery table unreadable");
    };

    // Observability must never decide the cycle's outcome: the drain above
    // already completed, and poll() must not surface as a failed cycle.
    await poller.poll();

    expect(calls).toEqual(["complete", "backlog"]);
  });
});
