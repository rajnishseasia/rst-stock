import { describe, expect, it } from "bun:test";
import { schema } from "@trade-bot/db";
import { networkFromEnv } from "@trade-bot/hyperliquid";

import {
  CopyMirrorPoller,
  decidePerpMirror,
  resolveGuardrails,
} from "../copy-mirror";
import { resolvePerpDailyCap } from "../../../../api/src/lib/copy-mirror";
import { divideDecimalFloor } from "../copy-mirror-perp-decimal";
import {
  isPerpPlacementLeaseActive,
  perpPlacementLeaseState,
} from "../copy-mirror-perp-placement-lease";

function acceptedCancel() {
  return {
    status: "ok",
    response: {
      type: "cancel",
      data: { statuses: ["success"] },
    },
  };
}

describe("round five perp release guards", () => {
  it.each(["abc", "0", "-1", "Infinity", "1.5"] as const)(
    "rejects an invalid configured daily cap for perps while retaining the equity fallback (%s)",
    (rawCap) => {
      const env = { COPY_TRADE_AUTOMIRROR_DAILY_CAP: rawCap };

      // The generic guardrail remains the equity-compatible fallback. Perps
      // must receive the raw validity result instead of silently replacing an
      // invalid operator value with a permissive default.
      expect(resolveGuardrails(env).dailyCap).toBe(rawCap === "1.5" ? 1.5 : 20);
      expect(resolvePerpDailyCap(env)).toBeNull();
    },
  );

  it("uses the configured/default daily cap instead of the local one-entry proof value", () => {
    expect(resolvePerpDailyCap({})).toBe(20);
    expect(resolvePerpDailyCap({ COPY_TRADE_AUTOMIRROR_DAILY_CAP: "7" })).toBe(7);
  });

  it.each([
    ["default", undefined, 20],
    ["generic env override", "3", 3],
  ] as const)(
    "serializes entries against the %s configured daily cap",
    (_label, rawCap, genericCap) => {
      const env = rawCap === undefined
        ? {}
        : { COPY_TRADE_AUTOMIRROR_DAILY_CAP: rawCap };
      const resolvedGenericCap = resolveGuardrails(env).dailyCap;
      expect(resolvedGenericCap).toBe(genericCap);
      const base = {
        followerUserId: "follower",
        sizingMode: "usd" as const,
        sizingValue: 50,
        freeCollateralUsd: 1000,
        accountValueUsd: 1000,
        price: 100,
        markPrice: "100",
        side: "long" as const,
        leverage: 2,
        sizeDecimals: 3,
        alreadyMirrored: false,
        dailyCap: resolvedGenericCap,
        maxOrderDollars: 1000,
      };
      const beforeCap = decidePerpMirror({
        ...base,
        sourceItemId: `generic-cap-before-${_label}`,
        mirrorsToday: genericCap - 1,
      });
      const atCap = decidePerpMirror({
        ...base,
        sourceItemId: `generic-cap-at-${_label}`,
        mirrorsToday: genericCap,
      });

      expect(beforeCap).toMatchObject({ action: "place" });
      expect(atCap).toMatchObject({ action: "skip", reason: "daily-cap" });
    },
  );

  it("sizes USD orders from the exact side-specific IOC limit", () => {
    const base = {
      followerUserId: "follower",
      sourceItemId: "signal",
      sizingMode: "usd" as const,
      sizingValue: 50,
      sourceQtyDecimal: undefined,
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 100,
      markPrice: "100",
      leverage: 2,
      sizeDecimals: 3,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.55,
    };

    const long = decidePerpMirror({ ...base, side: "long" });
    const short = decidePerpMirror({ ...base, side: "short" });
    expect(long).toMatchObject({ action: "place", sizeCoin: "0.1" });
    expect(short).toMatchObject({ action: "place", sizeCoin: "0.111" });
    if (long.action === "place") expect(long.orderDollars).toBe(10.5);
    if (short.action === "place") expect(short.orderDollars).toBe(10.545);
  });

  it("skips a non-ratio USD order when the mark-clearing quantity exceeds the cap", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "cashcat-minimum-round-up",
      sizingMode: "usd",
      sizingValue: 10,
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 0.21408,
      markPrice: "0.21408",
      side: "long",
      leverage: 2,
      sizeDecimals: 0,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.55,
    });

    // $10 at the pinned mark requires 47 whole coins. The exact aggressive
    // long payload for that quantity exceeds this test's configured $10.55
    // safeguard, so
    // there is no discrete quantity that satisfies both invariants.
    expect(result).toMatchObject({ action: "skip", reason: "below-min-notional" });
  });

  it("refuses minimum-notional round-up when the next venue quantity exceeds the cap", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "cashcat-minimum-round-up-cap",
      sizingMode: "usd",
      sizingValue: 10,
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 0.21408,
      markPrice: "0.21408",
      side: "long",
      leverage: 2,
      sizeDecimals: 0,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.1,
    });

    expect(result).toMatchObject({ action: "skip", reason: "below-min-notional" });
  });

  it("uses the follower's requested notional when the configured safeguard permits it", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "user-sized-perp-order",
      sizingMode: "usd",
      sizingValue: 50,
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 100,
      markPrice: "100",
      side: "long",
      leverage: 2,
      sizeDecimals: 3,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 1000,
    });

    expect(result).toMatchObject({
      action: "place",
      sizeCoin: "0.476",
      orderDollars: 49.98,
    });
  });

  it("refuses a coarse minimum round-up above the configured safeguard", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "coarse-configured-perp-cap",
      sizingMode: "usd",
      sizingValue: 10,
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 5.7,
      markPrice: "5.7",
      side: "long",
      leverage: 2,
      sizeDecimals: 0,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.55,
    });

    expect(result).toMatchObject({ action: "skip", reason: "below-min-notional" });
  });

  it("applies the configured safeguard to ratio sizing without upsizing the source quantity", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "ratio-configured-perp-cap",
      sizingMode: "ratio",
      sizingValue: 1,
      sourceQtyDecimal: "1",
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 100,
      markPrice: "100",
      side: "long",
      leverage: 2,
      sizeDecimals: 3,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.55,
    });

    expect(result).toMatchObject({
      action: "place",
      sizeCoin: "0.1",
      orderDollars: 10.5,
    });
  });

  it("does not upsize a ratio source below the venue floor", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "ratio-under-floor",
      sizingMode: "ratio",
      sizingValue: 1,
      sourceQtyDecimal: "0.05",
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 100,
      markPrice: "100",
      side: "long",
      leverage: 2,
      sizeDecimals: 3,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.55,
    });
    expect(result).toMatchObject({ action: "skip", reason: "below-min-notional" });
  });

  it("clamps an oversized ratio down to the exact dollar cap", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "ratio-over-cap",
      sizingMode: "ratio",
      sizingValue: 1,
      sourceQtyDecimal: "1",
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 100,
      markPrice: "100",
      side: "long",
      leverage: 2,
      sizeDecimals: 3,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 1,
      maxOrderDollars: 10.55,
    });
    expect(result).toMatchObject({ action: "place", sizeCoin: "0.1", orderDollars: 10.5 });
  });

  it("floors a decimal quotient without floating point drift", () => {
    expect(divideDecimalFloor("10.55", "95", 3)).toBe("0.111");
    expect(divideDecimalFloor("10.55", "105", 3)).toBe("0.1");
  });

  it("quarantines a future lease instead of allowing an immediate reclaim", () => {
    const now = 1_000_000;
    const future = new Date(now + 60_000);
    expect(isPerpPlacementLeaseActive("copy-mirror:perp-placement:claim", future, now)).toBe(true);
    expect(perpPlacementLeaseState("copy-mirror:perp-placement:claim", future, now)).toBe("future");
    const wildlyFuture = new Date(now + 10 * 60_000);
    expect(isPerpPlacementLeaseActive("copy-mirror:perp-placement:claim", wildlyFuture, now)).toBe(false);
    expect(perpPlacementLeaseState("copy-mirror:perp-placement:claim", wildlyFuture, now)).toBe("quarantined");
  });

  it("rejects a zero daily open cap while keeping the exact cap ordering", () => {
    const result = decidePerpMirror({
      followerUserId: "follower",
      sourceItemId: "signal-zero-cap",
      sizingMode: "usd",
      sizingValue: 50,
      freeCollateralUsd: 1000,
      accountValueUsd: 1000,
      price: 100,
      markPrice: "100",
      side: "long",
      leverage: 2,
      sizeDecimals: 3,
      mirrorsToday: 0,
      alreadyMirrored: false,
      dailyCap: 0,
      maxOrderDollars: 10.55,
    });
    expect(result).toMatchObject({ action: "skip", reason: "daily-cap" });
  });

  it("serializes concurrent Phase-A reservations on one follower lock using the database UTC day", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const dailyClauses: unknown[] = [];
    const databaseNow = new Date("2026-08-30T03:30:00.000Z");
    let lockActive = 0;
    let maxLockActive = 0;
    let transactionTail = Promise.resolve();
    const db: any = {
      query: {
        orders: {
          findFirst: async () => undefined,
        },
      },
      select: (projection: Record<string, unknown>) => {
        const query: any = {
          from: (table: unknown) => {
            query.table = table;
            return query;
          },
          where: (clause: unknown) => {
            if (Object.keys(projection).includes("value")) dailyClauses.push(clause);
            return query;
          },
          for: async (mode: string) => {
            if (query.table !== schema.users || mode !== "update") return [];
            lockActive += 1;
            maxLockActive = Math.max(maxLockActive, lockActive);
            events.push("lock:begin");
            // Keep the lock held across the actual insert in this transaction.
            await Promise.resolve();
            return [{ id: "follower" }];
          },
          // eslint-disable-next-line unicorn/no-thenable
          then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
            const value = Object.keys(projection).includes("value")
              ? [{ value: rows.length }]
              : [];
            return Promise.resolve(value).then(resolve, reject);
          },
        };
        return query;
      },
      execute: async () => [{ now: databaseNow }],
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const row = { ...value, id: `order-${rows.length + 1}`, status: "PENDING" };
              rows.push(row);
              events.push(`reserved:${row.id}`);
              return [row];
            },
          }),
        }),
      }),
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        let release!: () => void;
        const prior = transactionTail;
        transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await prior;
        events.push("transaction:begin");
        try {
          return await callback(db);
        } finally {
          lockActive -= 1;
          events.push("transaction:commit");
          release();
        }
      },
    };
    const poller = new CopyMirrorPoller(db);
    const makeParams = (sourceItemId: string) => ({
      followerUserId: "follower",
      sourceItemId,
      brokerAccountId: "0x1111111111111111111111111111111111111111",
      brokerCredentialId: "credential",
      coin: "BTC",
      side: "long",
      sizeCoin: "0.1",
      leverage: 1,
      marginMode: "cross",
      clientOrderId: `copymirror:follower:${sourceItemId}`,
      markPrice: "100",
      sizeDecimals: 3,
      maxOrderDollars: 1000,
      // The local proof chose one entry per day through ordinary configuration.
      // Phase A must serialize against that exact value, not hardcode it.
      dailyCap: 1,
      intent: "open",
      orderDollars: 10,
    });

    // The worker is deliberately on the previous local day while PostgreSQL's
    // UTC clock is already Aug 30. A session timezone cannot change the SQL
    // boundary either: both reservations must share the one database day.
    const processNow = Date.now;
    Date.now = () => Date.parse("2026-08-29T23:59:59.000Z");
    let results: any[];
    try {
      results = await Promise.all([
        (poller as any).preparePerpMirrorOrder(makeParams("signal-a")),
        (poller as any).preparePerpMirrorOrder(makeParams("signal-b")),
      ]);
    } finally {
      Date.now = processNow;
    }

    expect(results.filter((result) => "prepared" in result)).toHaveLength(1);
    expect(results.filter((result) => result.result?.outcome === "daily-cap")).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.lastSyncAttemptAt as Date).toISOString()).toBe(databaseNow.toISOString());
    expect(maxLockActive).toBe(1);
    expect(events).toEqual([
      "transaction:begin",
      "lock:begin",
      "reserved:order-1",
      "transaction:commit",
      "transaction:begin",
      "lock:begin",
      "transaction:commit",
    ]);

    // The day boundary is evaluated by PostgreSQL in UTC, not by a worker's
    // local clock or by the session timezone. This is the same predicate the
    // reservation count used above while the user row was locked.
    const seenSql = new WeakSet<object>();
    const sqlLiterals: string[] = [];
    const walkSql = (node: any) => {
      if (!node || typeof node !== "object" || seenSql.has(node)) return;
      seenSql.add(node);
      if (typeof node.value === "string") sqlLiterals.push(node.value);
      if (Array.isArray(node.value)) {
        sqlLiterals.push(...node.value.filter((value: unknown): value is string => typeof value === "string"));
      }
      Object.values(node).forEach(walkSql);
    };
    dailyClauses.forEach(walkSql);
    const serialized = sqlLiterals.join(" ");
    expect(serialized).toContain("CURRENT_TIMESTAMP");
    expect(serialized).toContain("AT TIME ZONE");
    expect(serialized).toContain("UTC");
  });

  it("fails closed on a fractional Phase-A cap instead of inserting outside the reservation", async () => {
    let insertCalls = 0;
    const db: any = {
      execute: async () => [{ now: new Date("2026-08-30T03:30:00.000Z") }],
      insert: () => {
        insertCalls += 1;
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "should-not-exist" }],
            }),
          }),
        };
      },
    };
    const poller = new CopyMirrorPoller(db);
    const result = await (poller as any).preparePerpMirrorOrder({
      followerUserId: "follower",
      sourceItemId: "fractional-cap",
      brokerAccountId: "0x1111111111111111111111111111111111111111",
      brokerCredentialId: "credential",
      coin: "BTC",
      side: "long",
      sizeCoin: "0.1",
      leverage: 1,
      marginMode: "cross",
      clientOrderId: "copymirror:follower:fractional-cap",
      markPrice: "100",
      sizeDecimals: 3,
      maxOrderDollars: 1000,
      dailyCap: 1.5,
      intent: "open",
      orderDollars: 10,
    });

    expect(result).toMatchObject({ result: { outcome: "daily-cap" } });
    expect(insertCalls).toBe(0);
  });

  it("ranks all-age PENDING and SYNCING reservations with a stable created_at tie-break", async () => {
    let queryArgs: any;
    const sameCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const db: any = {
      query: {
        orders: {
          findMany: async (args: any) => {
            queryArgs = args;
            return [
              { id: "z-syncing", createdAt: sameCreatedAt, status: "SYNCING" },
              { id: "a-pending", createdAt: sameCreatedAt, status: "PENDING" },
              { id: "old-pending", createdAt: new Date("2025-12-31T23:00:00.000Z"), status: "PENDING" },
            ];
          },
        },
      },
    };
    const poller = new CopyMirrorPoller(db);
    const ranked = await (poller as any).listPerpUnresolvedSlots("follower", db);
    expect(ranked.map((row: { id: string }) => row.id)).toEqual([
      "old-pending",
      "a-pending",
      "z-syncing",
    ]);

    const seen = new WeakSet<object>();
    const literals: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node.value === "string") literals.push(node.value);
      if (Array.isArray(node.value)) literals.push(...node.value.filter((value: unknown): value is string => typeof value === "string"));
      Object.values(node).forEach(walk);
    };
    walk(queryArgs.where);
    expect(literals).toContain("PENDING");
    expect(literals).toContain("SYNCING");
  });

  it("self-heals a wildly future lease with PostgreSQL time before reclaiming it", async () => {
    const databaseNow = new Date("2026-08-30T03:30:00.000Z");
    const updates: Array<Record<string, unknown>> = [];
    const clientOrderId = "copymirror:follower:future-skew";
    const existing = {
      id: "future-skew-row",
      userId: "follower",
      clientOrderId,
      status: "PENDING",
      brokerOrderId: null,
      symbol: "BTC",
      assetType: "PERP",
      orderType: "Limit",
      tradeAction: "Buy",
      direction: "long",
      quantity: 0,
      quantityDecimal: "0.1",
      limitPrice: "105",
      priceTrigger: null,
      leverage: 1,
      marginMode: "cross",
      reduceOnly: false,
      venue: "hyperliquid",
      venueNetwork: networkFromEnv(),
      brokerAccountId: "0x1111111111111111111111111111111111111111",
      brokerCredentialId: "credential",
      copySourceLabel: null,
      syncReason: "copy-mirror:perp-placement:future-owner",
      lastSyncAttemptAt: new Date(databaseNow.getTime() + 10 * 60_000),
    };
    const db: any = {
      execute: async () => [{ now: databaseNow }],
      query: { orders: { findFirst: async () => existing } },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => ({ returning: async () => [{ id: existing.id }] }),
          };
        },
      }),
    };
    const poller = new CopyMirrorPoller(db);
    const result = await (poller as any).preparePerpMirrorOrder({
      followerUserId: "follower",
      sourceItemId: "future-skew",
      brokerAccountId: existing.brokerAccountId,
      brokerCredentialId: "credential",
      coin: "BTC",
      side: "long",
      sizeCoin: "0.1",
      leverage: 1,
      marginMode: "cross",
      clientOrderId,
      markPrice: "100",
      sizeDecimals: 3,
      maxOrderDollars: 1000,
      dailyCap: 1,
      intent: "open",
      orderDollars: 10,
    });

    expect(result).toHaveProperty("prepared");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ syncReason: null, lastSyncAttemptAt: null });
    expect(updates[1]?.syncReason).toMatch(/^copy-mirror:perp-placement:/);
    const claimedUpdate = updates[1];
    expect(claimedUpdate).toBeDefined();
    expect((claimedUpdate as { lastSyncAttemptAt: Date }).lastSyncAttemptAt.toISOString()).toBe(
      databaseNow.toISOString(),
    );
  });

  it("fails closed when only aggregate absence is available for an expired lease", async () => {
    let placeCalls = 0;
    let aggregateCalls = 0;
    const poller = new CopyMirrorPoller({} as never);
    const submission = await (poller as any).submitPerpMirrorOrder(
      {
        userFills: async () => {
          aggregateCalls += 1;
          return [];
        },
        openOrders: async () => {
          aggregateCalls += 1;
          return [];
        },
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      {
        orderId: "expired-aggregate-only",
        claimToken: "expired-aggregate-only-token",
        reconcileVenueBeforeSubmit: true,
        params: {
          brokerAccountId: "0x1111111111111111111111111111111111111111",
          clientOrderId: "copymirror:follower:signal:expired-aggregate-only",
        },
        input: {} as never,
      },
    );

    expect(submission).toMatchObject({ kind: "not-submitted", reason: "reconcile" });
    expect(placeCalls).toBe(0);
    expect(aggregateCalls).toBe(0);
  });

  it("fails closed when the exact order-status reader is unavailable", async () => {
    let placeCalls = 0;
    const poller = new CopyMirrorPoller({} as never);
    const submission = await (poller as any).submitPerpMirrorOrder(
      {
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      {
        orderId: "expired-no-exact-reader",
        claimToken: "expired-no-exact-reader-token",
        reconcileVenueBeforeSubmit: true,
        params: {
          brokerAccountId: "0x1111111111111111111111111111111111111111",
          clientOrderId: "copymirror:follower:signal:expired-no-exact-reader",
        },
        input: {} as never,
      },
    );
    expect(submission).toMatchObject({ kind: "not-submitted", reason: "reconcile" });
    expect(placeCalls).toBe(0);
  });

  it("fails closed when the exact order-status response is malformed", async () => {
    let placeCalls = 0;
    const poller = new CopyMirrorPoller({} as never);
    const submission = await (poller as any).submitPerpMirrorOrder(
      {
        orderStatusByClientOrderId: async () => ({ status: "order", order: null }),
        placeOrder: async () => {
          placeCalls += 1;
          return {};
        },
      },
      {
        orderId: "expired-malformed-exact-status",
        claimToken: "expired-malformed-exact-status-token",
        reconcileVenueBeforeSubmit: true,
        params: {
          brokerAccountId: "0x1111111111111111111111111111111111111111",
          clientOrderId: "copymirror:follower:signal:expired-malformed-exact-status",
        },
        input: {} as never,
      },
    );
    expect(submission).toMatchObject({ kind: "not-submitted", reason: "reconcile" });
    expect(placeCalls).toBe(0);
  });

  it("fails closed when exact status finds a filled protection leg despite a lagging aggregate", async () => {
    const submitted: unknown[] = [];
    const priorStop = "copymirror:follower:signal:prior:tpsl:sl:87.5";
    const priorTakeProfit = "copymirror:follower:signal:prior:tpsl:tp:125";
    const client = {
      listPositions: async () => [{
        coin: "BTC",
        side: "long",
        size: "1",
        entryPx: "100",
        leverage: 2,
        marginMode: "cross",
      }],
      openOrders: async () => [],
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) =>
        clientOrderId === priorStop || clientOrderId === priorTakeProfit
          ? { status: "order", order: { order: { oid: 900 }, status: "filled" } }
          : { status: "unknownOid" },
      setPositionTpSl: async (request: unknown) => {
        submitted.push(request);
        return {};
      },
      cancelOrder: async () => ({}),
    };
    const prior = {
      entryPx: "100",
      leverage: 2,
      sizeCoin: "1",
      stopLossPx: "87.5",
      takeProfitPx: "125",
      legClientOrderIds: [priorStop, priorTakeProfit],
    };
    const result = await import("../copy-mirror-perp-protection").then(({ attachPerpProtection }) =>
      attachPerpProtection(
        client as never,
        {
          followerUserId: "follower",
          sourceItemId: "signal",
          walletAddress: "0x1111111111111111111111111111111111111111",
          coin: "BTC",
          sizeCoin: "1",
          clientOrderId: "copymirror:follower:signal:prior",
          priorProtectionPlan: prior,
        },
        {
          loadRule: async () => ({ takeProfitRoePct: 50, stopLossRoePct: 25 }),
          recordAttached: async () => {},
          recordUnprotected: async () => {},
          delay: async () => {},
        },
      ),
    );
    // A filled trigger is not live protection. Even though the aggregate is
    // empty, the position revalidation above remains live, so claiming
    // `attached` would falsely represent the opening row as protected. The
    // safe result is an operator-visible unprotected row with no replacement
    // submission that could duplicate the already-fired trigger.
    expect(result).toMatchObject({
      outcome: "unprotected",
      reason: "filled-protection-position-still-open",
    });
    expect(submitted).toEqual([]);
  });

  it.each([
    {
      name: "database clock query rejects",
      execute: async () => {
        throw new Error("database unavailable");
      },
    },
    {
      name: "database clock result is malformed",
      execute: async () => ({ rows: [{ now: "not-a-timestamp" }] }),
    },
  ])("fails closed before Phase-A writes when $name", async ({ execute }) => {
    let insertCalls = 0;
    let updateCalls = 0;
    const db: any = {
      execute,
      query: { orders: { findFirst: async () => undefined } },
      insert: () => {
        insertCalls += 1;
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "clock-prep", status: "PENDING" }],
            }),
          }),
        };
      },
      update: () => {
        updateCalls += 1;
        return {
          set: () => ({ where: () => ({ returning: async () => [] }) }),
        };
      },
    };
    const poller = new CopyMirrorPoller(db);

    await expect((poller as any).preparePerpMirrorOrder({
      followerUserId: "follower",
      sourceItemId: "clock-prep",
      brokerAccountId: "0x1111111111111111111111111111111111111111",
      brokerCredentialId: "credential",
      coin: "BTC",
      side: "long",
      sizeCoin: "0.1",
      leverage: 1,
      marginMode: "cross",
      clientOrderId: "copymirror:follower:clock-prep",
      markPrice: "100",
      sizeDecimals: 3,
      maxOrderDollars: 1000,
      dailyCap: 1,
      intent: "open",
      orderDollars: 10,
    })).rejects.toThrow("database clock");
    expect(insertCalls).toBe(0);
    expect(updateCalls).toBe(0);
  });

  it("archives a positively known zero-fill IOC so the delivery can retry safely", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db: any = {
      execute: async () => ({ rows: [{ now: new Date("2026-09-15T11:04:13.000Z") }] }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: () => ({ returning: async () => [{ id: "zero-fill-order" }] }) };
        },
      }),
      query: { orders: { findFirst: async () => undefined } },
    };
    const poller = new CopyMirrorPoller(db);
    const prepared = {
      orderId: "zero-fill-order",
      claimToken: "zero-fill-token",
      claimAt: new Date("2026-09-15T11:04:12.000Z"),
      reconcileVenueBeforeSubmit: false,
      params: {
        followerUserId: "follower",
        sourceItemId: "user:source-order",
        brokerAccountId: "0x1111111111111111111111111111111111111111",
        brokerCredentialId: "credential",
        coin: "UNI",
        side: "long",
        sizeCoin: "13.1",
        leverage: 3,
        marginMode: "cross",
        clientOrderId: "copymirror:follower:user:source-order",
        intent: "open",
      },
      input: {} as never,
    };

    const result = await (poller as any).finalizePerpMirrorOrder(
      prepared,
      { kind: "accepted", filledSizeCoin: "0" },
      db,
    );

    expect(result).toEqual({ outcome: "zero-fill" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      executedSizeDecimal: "0",
      syncReason: null,
      clientOrderId: "copymirror:follower:user:source-order:zero-fill:zero-fill-order",
    });
  });

  it.each([
    {
      name: "database clock query rejects",
      execute: async () => {
        throw new Error("database unavailable");
      },
    },
    {
      name: "database clock result is malformed",
      execute: async () => ({ rows: [{ now: "not-a-timestamp" }] }),
    },
  ])("fails closed before finalization writes when $name", async ({ execute }) => {
    let updateCalls = 0;
    const db: any = {
      execute,
      update: () => {
        updateCalls += 1;
        return {
          set: () => ({
            where: () => ({ returning: async () => [{ id: "clock-finalize" }] }),
          }),
        };
      },
      query: { orders: { findFirst: async () => undefined } },
    };
    const poller = new CopyMirrorPoller(db);
    const prepared = {
      orderId: "clock-finalize",
      claimToken: "clock-finalize-token",
      reconcileVenueBeforeSubmit: false,
      params: {
        brokerAccountId: "0x1111111111111111111111111111111111111111",
        clientOrderId: "copymirror:follower:clock-finalize",
      },
      input: {} as never,
    };

    await expect((poller as any).finalizePerpMirrorOrder(
      prepared,
      { kind: "accepted", brokerOrderId: "venue-1", executedSizeDecimal: "0.1" },
    )).rejects.toThrow("database clock");
    expect(updateCalls).toBe(0);
  });

  it.each([
    {
      name: "database clock query rejects",
      execute: async () => {
        throw new Error("database unavailable");
      },
    },
    {
      name: "database clock result is malformed",
      execute: async () => ({ rows: [{ now: "not-a-timestamp" }] }),
    },
  ])("fails closed before client creation during protection recovery when $name", async ({ execute }) => {
    let updateCalls = 0;
    let clientCalls = 0;
    let attachCalls = 0;
    const db: any = {
      execute,
      query: {
        userApiCredentials: {
          findFirst: async () => ({ id: "credential", provider: "hyperliquid", accountType: "LIVE" }),
        },
      },
      update: () => {
        updateCalls += 1;
        return {
          set: () => ({
            where: () => ({ returning: async () => [{ id: "clock-recovery" }] }),
          }),
        };
      },
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: async () => {
        clientCalls += 1;
        return {
          walletAddress: "0x1111111111111111111111111111111111111111",
          client: {} as never,
        };
      },
    });
    (poller as any).attachPerpProtection = async () => {
      attachCalls += 1;
      return { outcome: "attached" };
    };

    await expect((poller as any).recoverPerpProtectionIntent(
      {
        id: "clock-recovery",
        userId: "follower",
        clientOrderId: "copymirror:follower:clock-recovery",
        status: "FILLED",
        brokerOrderId: "venue-1",
        symbol: "BTC",
        executedSizeDecimal: "0.1",
        brokerAccountId: "0x1111111111111111111111111111111111111111",
        brokerCredentialId: "credential",
        syncReason: null,
        lastSyncAttemptAt: null,
        perpProtection: {
          copyMirrorProtectionIntent: true,
          takeProfitRoePct: 25,
          stopLossRoePct: 10,
        },
      },
      { sourceItemId: "clock-recovery", followId: "follow" },
    )).rejects.toThrow("database clock");
    expect(clientCalls).toBe(0);
    expect(updateCalls).toBe(0);
    expect(attachCalls).toBe(0);
  });

  it("keeps stale protection cleanup durable and retries it after the opening row is cancelled", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const openingClientOrderId = "copymirror:follower:stale-cleanup";
    const submittedLegs = [
      `${openingClientOrderId}:tpsl:sl:87.5`,
      `${openingClientOrderId}:tpsl:tp:125`,
    ];
    const row: any = {
      id: "stale-cleanup-opening",
      userId: "follower",
      clientOrderId: openingClientOrderId,
      symbol: "BTC",
      venue: "hyperliquid",
      assetType: "PERP",
      status: "SUBMITTED",
      perpProtectionStatus: null,
      perpProtectionError: null,
      perpProtection: null,
      brokerAccountId: wallet,
      brokerCredentialId: "credential",
      createdAt: new Date("2026-08-29T12:00:00.000Z"),
    };
    const updates: Array<Record<string, unknown>> = [];
    let exactVisible = false;
    const client = {
      listPositions: async () => [{
        coin: "BTC",
        side: "long",
        size: "1",
        entryPx: "100",
        leverage: 2,
        marginMode: "cross",
      }],
      openOrders: async () => [],
      setPositionTpSl: async () => {
        // The source close wins the opening-row CAS after both legs are sent.
        row.perpProtectionStatus = "cancelled";
        return {
          response: {
            data: {
              statuses: [
                { resting: { oid: 901 } },
                { resting: { oid: 902 } },
              ],
            },
          },
        };
      },
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => {
        if (!exactVisible) return { status: "unknownOid" };
        return {
          status: "order",
          order: {
            order: { oid: clientOrderId.endsWith(":sl:87.5") ? 901 : 902 },
            status: "open",
          },
        };
      },
      cancelOrder: async ({ orderId }: { coin: string; orderId: number }) => {
        cancelled.push(orderId);
        return acceptedCancel();
      },
    };
    const cancelled: number[] = [];
    const db: any = {
      query: {
        orders: {
          findFirst: async () => row,
          findMany: async () => [row],
        },
        userApiCredentials: {
          findFirst: async () => ({
            id: "credential",
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => ({
              returning: async () => {
                const isOutcomeWrite = "perpProtectionStatus" in values;
                const canWrite = isOutcomeWrite
                  ? row.perpProtectionStatus === null || row.perpProtectionStatus === "unprotected"
                  : true;
                if (canWrite) Object.assign(row, values);
                return canWrite ? [{ id: row.id }] : [];
              },
            }),
          };
        },
      }),
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({ client, walletAddress: wallet })) as never,
    });

    const attached = await (poller as any).attachPerpProtection(
      client,
      {
        followerUserId: row.userId,
        sourceItemId: "source-stale-cleanup",
        walletAddress: wallet,
        coin: row.symbol,
        sizeCoin: "1",
        clientOrderId: openingClientOrderId,
        protectionRuleSnapshot: { takeProfitRoePct: 50, stopLossRoePct: 25 },
      },
      db,
    );

    expect(attached).toMatchObject({ outcome: "unprotected" });
    expect(row.perpProtection).toMatchObject({
      copyMirrorProtectionIntent: true,
      copyMirrorProtectionCleanup: {
        followerUserId: row.userId,
        sourceItemId: "source-stale-cleanup",
        walletAddress: wallet,
        coin: "BTC",
        openingClientOrderId,
        openingOrderId: row.id,
        legClientOrderIds: submittedLegs,
      },
    });
    expect(row.perpProtectionStatus).toBe("cancelled");
    expect(cancelled).toEqual([]);

    exactVisible = true;
    await (poller as any).emitUnprotectedPerpBacklog(new Date("2026-08-29T12:01:00.000Z"));

    expect(cancelled).toEqual([901, 902]);
    expect(row.perpProtectionStatus).toBe("cancelled");
    expect(row.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
    expect(updates.some((values) => "perpProtection" in values)).toBe(true);
  });

  it("recovers checkpointed protection legs after cleanup persistence fails", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const openingClientOrderId = "copymirror:follower:cleanup-restart";
    const submittedLegs = [
      `${openingClientOrderId}:tpsl:sl:87.5`,
      `${openingClientOrderId}:tpsl:tp:125`,
    ];
    const row: any = {
      id: "cleanup-restart-opening",
      userId: "follower",
      clientOrderId: openingClientOrderId,
      symbol: "BTC",
      venue: "hyperliquid",
      assetType: "PERP",
      status: "SUBMITTED",
      perpProtectionStatus: null,
      perpProtectionError: null,
      perpProtection: null,
      brokerAccountId: wallet,
      brokerCredentialId: "credential",
      createdAt: new Date("2026-08-29T12:00:00.000Z"),
    };
    const cancelled: number[] = [];
    let exactVisible = false;
    let cleanupUnavailable = true;
    let cleanupWriteAttempts = 0;
    let protectionPosts = 0;
    const containsCheckpointPlanFilter = (node: unknown, seen = new WeakSet<object>()): boolean => {
      if (!node || typeof node !== "object") return false;
      if (seen.has(node)) return false;
      seen.add(node);
      const value = (node as { value?: unknown }).value;
      if (
        (typeof value === "string" && (
          value.includes("copyMirrorProtectionIntent") ||
          value.includes("legClientOrderIds")
        )) ||
        (Array.isArray(value) && value.some((item) =>
          typeof item === "string" && (
            item.includes("copyMirrorProtectionIntent") ||
            item.includes("legClientOrderIds")
          )))
      ) return true;
      return Object.values(node).some((value) => containsCheckpointPlanFilter(value, seen));
    };
    const client = {
      listPositions: async () => [{
        coin: "BTC",
        side: "long",
        size: "1",
        entryPx: "100",
        leverage: 2,
        marginMode: "cross",
      }],
      openOrders: async () => [],
      setPositionTpSl: async () => {
        protectionPosts += 1;
        row.perpProtectionStatus = "cancelled";
        return {
          response: {
            data: {
              statuses: [
                { resting: { oid: 901 } },
                { resting: { oid: 902 } },
              ],
            },
          },
        };
      },
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => {
        if (!exactVisible) return { status: "unknownOid" };
        return {
          status: "order",
          order: {
            order: { oid: clientOrderId.endsWith(":sl:87.5") ? 901 : 902 },
            status: "open",
          },
        };
      },
      cancelOrder: async ({ orderId }: { coin: string; orderId: number }) => {
        cancelled.push(orderId);
        return acceptedCancel();
      },
    };
    const db: any = {
      query: {
        orders: {
          findFirst: async () => row,
          findMany: async (args: any) => {
            if (args?.columns?.perpProtection && !args?.columns?.perpProtectionError) {
              // A restart can reconstruct the marker from the checkpointed
              // plan only when the query includes that bounded fallback.
              return containsCheckpointPlanFilter(args.where) ? [row] : [];
            }
            return [];
          },
        },
        userApiCredentials: {
          findFirst: async () => ({
            id: "credential",
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const protection = values.perpProtection as Record<string, unknown> | undefined;
              // The production claim is an UPDATE expression. This adapter
              // models its RETURNING result without replacing the in-memory
              // JSON plan with Drizzle's SQL builder object.
              if (protection && Object.prototype.hasOwnProperty.call(protection, "queryChunks")) {
                return [{ id: row.id }];
              }
              if (protection && Object.prototype.hasOwnProperty.call(
                protection,
                "copyMirrorProtectionCleanup",
              )) {
                cleanupWriteAttempts += 1;
                if (cleanupUnavailable) throw new Error("cleanup database unavailable");
              }
              if (
                (values.perpProtectionStatus === "attached" ||
                  values.perpProtectionStatus === "unprotected") &&
                row.perpProtectionStatus === "cancelled"
              ) {
                return [];
              }
              Object.assign(row, values);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({ client, walletAddress: wallet })) as never,
    });

    // The venue accepts both legs, then the source close wins the opening-row
    // CAS. Cleanup persistence is unavailable at that instant; the durable
    // plan checkpoint must be enough authority for an independent restart.
    await (poller as any).attachPerpProtection(
      client,
      {
        followerUserId: row.userId,
        sourceItemId: "source-cleanup-restart",
        walletAddress: wallet,
        coin: row.symbol,
        sizeCoin: "1",
        clientOrderId: openingClientOrderId,
        protectionRuleSnapshot: { takeProfitRoePct: 50, stopLossRoePct: 25 },
      },
      db,
    );

    // One failed callback plus the caller's typed-error retention attempt.
    expect(cleanupWriteAttempts).toBeGreaterThan(1);
    expect(protectionPosts).toBe(1);
    expect(row.perpProtectionStatus).toBe("cancelled");
    expect(row.perpProtection).toMatchObject({
      copyMirrorProtectionIntent: true,
      legClientOrderIds: submittedLegs,
    });
    expect(row.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");

    // The next worker cycle has a healthy DB and exact venue visibility. It
    // must find the cancelled row from the checkpointed plan and retire every
    // named cloid without reopening the row or submitting a duplicate pair.
    cleanupUnavailable = false;
    exactVisible = true;
    await (poller as any).emitUnprotectedPerpBacklog(new Date("2026-08-29T12:01:00.000Z"));

    expect(cancelled).toEqual([901, 902]);
    expect(protectionPosts).toBe(1);
    expect(row.perpProtectionStatus).toBe("cancelled");
    expect(row.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
    expect(row.perpProtection.copyMirrorProtectionCleanupRetiredLegClientOrderIds).toEqual(
      submittedLegs,
    );
  });

  it("claims a cleanup generation before exact reads so concurrent workers cancel once", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const openingClientOrderId = "copymirror:follower:cleanup-lease";
    const legA = `${openingClientOrderId}:tpsl:sl:87.5`;
    const stateA = {
      followerUserId: "follower",
      sourceItemId: "source-cleanup-lease",
      walletAddress: wallet,
      coin: "BTC",
      openingClientOrderId,
      openingOrderId: "cleanup-lease-opening",
      legClientOrderIds: [legA],
    };
    const row: any = {
      id: stateA.openingOrderId,
      userId: stateA.followerUserId,
      clientOrderId: openingClientOrderId,
      symbol: stateA.coin,
      venue: "hyperliquid",
      assetType: "PERP",
      perpProtectionStatus: "cancelled",
      brokerCredentialId: "credential",
      brokerAccountId: wallet,
      perpProtection: {
        copyMirrorProtectionIntent: true,
        legClientOrderIds: [legA],
        copyMirrorProtectionCleanup: stateA,
      },
    };
    const cancelled: number[] = [];
    let exactReads = 0;
    let claimAttempts = 0;
    let claimWon = false;
    const containsText = (
      value: unknown,
      text: string,
      seen = new WeakSet<object>(),
    ): boolean => {
      if (typeof value === "string") return value.includes(text);
      if (!value || typeof value !== "object") return false;
      if (seen.has(value)) return false;
      seen.add(value);
      return Object.values(value).some((child) => containsText(child, text, seen));
    };
    const hasClaimExpression = (value: unknown, seen = new WeakSet<object>()): boolean => {
      if (!value || typeof value !== "object") return false;
      if (seen.has(value)) return false;
      seen.add(value);
      if (Object.prototype.hasOwnProperty.call(value, "queryChunks")) {
        // Lease renewal also mentions the token, but it is not a claim. Count
        // only the UPDATE expression that stamps the generation's claimed-at
        // timestamp so concurrent workers still model one winner.
        const chunks = (value as { queryChunks?: unknown }).queryChunks;
        return containsText(chunks, "cleanupClaimToken") && containsText(chunks, "cleanupClaimedAt");
      }
      return Object.values(value).some((child) => hasClaimExpression(child, seen));
    };
    const client = {
      orderStatusByClientOrderId: async () => {
        exactReads += 1;
        return {
          status: "order",
          order: { order: { oid: 901, coin: "BTC" }, status: "open" },
        };
      },
      cancelOrder: async ({ orderId }: { orderId: number }) => {
        cancelled.push(orderId);
        return acceptedCancel();
      },
    };
    const db: any = {
      execute: async () => [{ now: new Date("2026-08-29T12:00:00.000Z") }],
      query: {
        orders: {
          findMany: async (args: any) =>
            args?.columns?.perpProtection && !args?.columns?.perpProtectionError
              ? [{ ...row, perpProtection: structuredClone(row.perpProtection) }]
              : [],
        },
        userApiCredentials: {
          findFirst: async () => ({
            id: "credential",
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (hasClaimExpression(values.perpProtection)) {
                claimAttempts += 1;
                if (claimWon) return [];
                claimWon = true;
                return [{ id: row.id }];
              }
              if (values.perpProtection && typeof values.perpProtection === "object" &&
                Object.prototype.hasOwnProperty.call(values.perpProtection, "queryChunks")) {
                // The lease-renewal SET expression is also a SQL builder; it
                // must not be installed as JSON in this in-memory adapter.
                return [{ id: row.id }];
              }
              if (values.perpProtection && typeof values.perpProtection === "object") {
                row.perpProtection = values.perpProtection;
              }
              return [{ id: row.id }];
            },
          }),
        }),
      }),
    };
    const options = { createPerpClient: (async () => ({ client, walletAddress: wallet })) as never };
    const first = new CopyMirrorPoller(db, options);
    const second = new CopyMirrorPoller(db, options);

    await Promise.all([
      (first as any).retryPerpProtectionCleanupBacklog(),
      (second as any).retryPerpProtectionCleanupBacklog(),
    ]);

    expect(claimAttempts).toBe(2);
    expect(exactReads).toBe(1);
    expect(cancelled).toEqual([901]);
    expect(row.perpProtectionStatus).toBe("cancelled");

    // A later distinct generation on the same opening is still eligible after
    // A was retired; the lease/tombstone must not suppress B.
    const legB = `${openingClientOrderId}:tpsl:sl:86.5`;
    await (first as any).recordPerpProtectionCleanup({ ...stateA, legClientOrderIds: [legB] }, db);
    expect(row.perpProtection.copyMirrorProtectionCleanup.legClientOrderIds).toEqual([legB]);
  });

  it("records partial cleanup progress as retired ids plus only the exact pending marker", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const openingClientOrderId = "copymirror:follower:cleanup-progress";
    const legA = `${openingClientOrderId}:tpsl:sl:87.5`;
    const legB = `${openingClientOrderId}:tpsl:tp:125`;
    const state = {
      followerUserId: "follower",
      sourceItemId: "source-cleanup-progress",
      walletAddress: wallet,
      coin: "BTC",
      openingClientOrderId,
      openingOrderId: "cleanup-progress-opening",
      legClientOrderIds: [legA, legB],
    };
    const row: any = {
      id: state.openingOrderId,
      userId: state.followerUserId,
      clientOrderId: openingClientOrderId,
      symbol: state.coin,
      perpProtectionStatus: "cancelled",
      perpProtection: { copyMirrorProtectionCleanup: state },
    };
    const db: any = {
      query: { orders: { findFirst: async () => row } },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              Object.assign(row, values);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
    };
    const poller = new CopyMirrorPoller(db);

    await (poller as any).recordPerpProtectionCleanup(
      { ...state, legClientOrderIds: [legB] },
      db,
      [legA],
    );

    expect(row.perpProtection.copyMirrorProtectionCleanup.legClientOrderIds).toEqual([legB]);
    expect(row.perpProtection.copyMirrorProtectionCleanupRetiredLegClientOrderIds).toEqual([legA]);
  });

  it("quarantines permanently blocked cleanup rows so a later valid marker is not starved by the cap", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const makeRow = (index: number, credential: string | null) => {
      const openingClientOrderId = `copymirror:follower:blocked-${index}`;
      const state = {
        followerUserId: "follower",
        sourceItemId: `source-blocked-${index}`,
        walletAddress: wallet,
        coin: "BTC",
        openingClientOrderId,
        openingOrderId: `blocked-opening-${index}`,
        legClientOrderIds: [`${openingClientOrderId}:tpsl:sl:87.5`],
      };
      return {
        id: state.openingOrderId,
        userId: state.followerUserId,
        clientOrderId: openingClientOrderId,
        symbol: state.coin,
        venue: "hyperliquid",
        assetType: "PERP",
        perpProtectionStatus: "cancelled",
        brokerCredentialId: credential,
        brokerAccountId: wallet,
        createdAt: new Date(1_000 + index),
        perpProtection: { copyMirrorProtectionCleanup: state },
      } as any;
    };
    const rows = Array.from({ length: 201 }, (_, index) => makeRow(index, null));
    const valid = makeRow(999, "credential");
    rows.push(valid);
    const cancelled: number[] = [];
    const databaseNow = new Date("2026-08-29T12:00:00.000Z");
    const hasDueMarker = (candidate: any) => {
      const marker = candidate.perpProtection?.copyMirrorProtectionCleanup;
      const next = marker?.cleanupNextAttemptAt;
      return typeof next !== "string" || new Date(next).getTime() <= databaseNow.getTime();
    };
    const db: any = {
      execute: async () => [{ now: databaseNow }],
      query: {
        orders: {
          findMany: async (args: any) => {
            if (args?.columns?.perpProtection && !args?.columns?.perpProtectionError) {
              return rows.filter(hasDueMarker).slice(0, 201).map((candidate) => ({
                ...candidate,
                perpProtection: structuredClone(candidate.perpProtection),
              }));
            }
            return [];
          },
        },
        userApiCredentials: {
          findFirst: async ({ where }: any) => {
            const target = rows.find((candidate) => where && candidate.brokerCredentialId === "credential");
            return target ? { id: "credential", provider: "hyperliquid", accountType: "REGISTERED" } : null;
          },
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (values.perpProtection && typeof values.perpProtection === "object" &&
                !Object.prototype.hasOwnProperty.call(values.perpProtection, "queryChunks")) {
                const marker = (values.perpProtection as any).copyMirrorProtectionCleanup;
                const retired = (values.perpProtection as any)
                  .copyMirrorProtectionCleanupRetiredLegClientOrderIds;
                const target = marker
                  ? rows.find((candidate) =>
                    candidate.perpProtection?.copyMirrorProtectionCleanup?.sourceItemId === marker?.sourceItemId)
                  : rows.find((candidate) =>
                    Array.isArray(retired) && retired.some((id: string) =>
                      candidate.perpProtection?.copyMirrorProtectionCleanup?.legClientOrderIds?.includes(id)));
                if (target) target.perpProtection = values.perpProtection;
              }
              return [{ id: valid.id }];
            },
          }),
        }),
      }),
    };
    const client = {
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 1999, coin: "BTC" }, status: "open" },
      }),
      cancelOrder: async ({ orderId }: { orderId: number }) => {
        cancelled.push(orderId);
        return acceptedCancel();
      },
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({ client, walletAddress: wallet })) as never,
    });

    await (poller as any).retryPerpProtectionCleanupBacklog();
    expect(cancelled).toEqual([]);
    expect(rows[0].perpProtection.copyMirrorProtectionCleanup.cleanupAttemptCount).toBe(1);
    expect(rows[0].perpProtection.copyMirrorProtectionCleanup.cleanupNextAttemptAt).toBeDefined();

    await (poller as any).retryPerpProtectionCleanupBacklog();
    expect(cancelled).toEqual([1999]);
    expect(valid.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
  });

  it("filters cleanup markers before the bounded cancelled-row scan", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const openingClientOrderId = "copymirror:follower:cleanup-cap";
    const legClientOrderIds = [
      `${openingClientOrderId}:tpsl:sl:87.5`,
      `${openingClientOrderId}:tpsl:tp:125`,
    ];
    const cleanupState = {
      followerUserId: "follower",
      sourceItemId: "source-cleanup-cap",
      walletAddress: wallet,
      coin: "BTC",
      openingClientOrderId,
      openingOrderId: "cleanup-cap-opening",
      legClientOrderIds,
    };
    const markerRow: any = {
      id: cleanupState.openingOrderId,
      userId: cleanupState.followerUserId,
      clientOrderId: openingClientOrderId,
      symbol: cleanupState.coin,
      venue: "hyperliquid",
      assetType: "PERP",
      perpProtectionStatus: "cancelled",
      brokerCredentialId: "credential",
      brokerAccountId: wallet,
      perpProtection: {
        entryPx: "100",
        leverage: 2,
        sizeCoin: "1",
        legClientOrderIds,
        copyMirrorProtectionCleanup: cleanupState,
      },
    };
    const irrelevantRows = Array.from({ length: 200 }, (_, index) => ({
      ...markerRow,
      id: `irrelevant-${index}`,
      clientOrderId: `copymirror:follower:irrelevant-${index}`,
      perpProtection: null,
    }));
    const cancelled: number[] = [];
    let cleanupFilterSeen = false;
    const containsCleanupFilter = (node: unknown, seen = new WeakSet<object>()): boolean => {
      if (!node || typeof node !== "object") return false;
      if (seen.has(node)) return false;
      seen.add(node);
      const value = (node as { value?: unknown }).value;
      if (
        (typeof value === "string" && value.includes("copyMirrorProtectionCleanup")) ||
        (Array.isArray(value) && value.some((item) =>
          typeof item === "string" && item.includes("copyMirrorProtectionCleanup")))
      ) return true;
      return Object.values(node).some((value) => containsCleanupFilter(value, seen));
    };
    const db: any = {
      query: {
        orders: {
          findMany: async (args: any) => {
            if (args?.columns?.perpProtection && !args?.columns?.perpProtectionError) {
              cleanupFilterSeen = containsCleanupFilter(args.where);
              return cleanupFilterSeen ? [markerRow] : [...irrelevantRows, markerRow];
            }
            return [];
          },
          findFirst: async () => markerRow,
        },
        userApiCredentials: {
          findFirst: async () => ({
            id: "credential",
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              Object.assign(markerRow, values);
              return [{ id: markerRow.id }];
            },
          }),
        }),
      }),
    };
    const client = {
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => ({
        status: "order",
        order: {
          order: { oid: clientOrderId.endsWith(":sl:87.5") ? 901 : 902 },
          status: "open",
        },
      }),
      cancelOrder: async ({ orderId }: { orderId: number }) => {
        cancelled.push(orderId);
        return acceptedCancel();
      },
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({ client, walletAddress: wallet })) as never,
    });

    await (poller as any).emitUnprotectedPerpBacklog(new Date("2026-08-29T12:01:00.000Z"));

    expect(cleanupFilterSeen).toBe(true);
    expect(cancelled).toEqual([901, 902]);
    expect(markerRow.perpProtectionStatus).toBe("cancelled");
    expect(markerRow.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
  });

  it("retires exact leg A without suppressing a late distinct leg B", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const openingClientOrderId = "copymirror:follower:cleanup-generation";
    const stateA = {
      followerUserId: "follower",
      sourceItemId: "source-cleanup-generation",
      walletAddress: wallet,
      coin: "BTC",
      openingClientOrderId,
      openingOrderId: "cleanup-generation-opening",
      legClientOrderIds: [`${openingClientOrderId}:tpsl:sl:87.5`],
    };
    const stateB = {
      ...stateA,
      legClientOrderIds: [`${openingClientOrderId}:tpsl:sl:86.5`],
    };
    const row: any = {
      id: stateA.openingOrderId,
      userId: stateA.followerUserId,
      clientOrderId: openingClientOrderId,
      perpProtectionStatus: "cancelled",
      perpProtection: {
        entryPx: "100",
        leverage: 2,
        sizeCoin: "1",
        legClientOrderIds: [],
      },
    };
    const db: any = {
      query: {
        orders: {
          findFirst: async () => row,
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              Object.assign(row, values);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
    };
    const poller = new CopyMirrorPoller(db);

    await (poller as any).recordPerpProtectionCleanup(stateA, db);
    await (poller as any).clearPerpProtectionCleanup(stateA, db);
    expect(row.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
    expect(row.perpProtection.copyMirrorProtectionCleanupRetiredLegClientOrderIds).toEqual([
      stateA.legClientOrderIds[0],
    ]);

    // A late callback for the already-retired exact cloid stays suppressed.
    await (poller as any).recordPerpProtectionCleanup(stateA, db);
    expect(row.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");

    // A distinct deterministic generation remains retryable on the same row.
    await (poller as any).recordPerpProtectionCleanup(stateB, db);
    expect(row.perpProtection.copyMirrorProtectionCleanup.legClientOrderIds).toEqual(
      stateB.legClientOrderIds,
    );
    expect(row.perpProtection.copyMirrorProtectionCleanupRetiredLegClientOrderIds).toEqual([
      stateA.legClientOrderIds[0],
    ]);
    expect(row.perpProtectionStatus).toBe("cancelled");
  });

  it("schedules ordinary pending markers so a later valid row is not starved by the cap", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const databaseNow = new Date("2026-08-29T12:00:00.000Z");
    const makeRow = (index: number, valid = false) => {
      const openingClientOrderId = valid
        ? "copymirror:follower:pending-valid"
        : `copymirror:follower:pending-blocked-${index}`;
      const state = {
        followerUserId: "follower",
        sourceItemId: valid ? "source-pending-valid" : `source-pending-blocked-${index}`,
        walletAddress: wallet,
        coin: "BTC",
        openingClientOrderId,
        openingOrderId: valid ? "pending-valid-opening" : `pending-blocked-opening-${index}`,
        legClientOrderIds: [`${openingClientOrderId}:tpsl:sl:87.5`],
      };
      return {
        id: state.openingOrderId,
        userId: state.followerUserId,
        clientOrderId: openingClientOrderId,
        symbol: state.coin,
        venue: "hyperliquid",
        assetType: "PERP",
        perpProtectionStatus: "cancelled",
        brokerCredentialId: "credential",
        brokerAccountId: wallet,
        createdAt: new Date(1_000 + index),
        perpProtection: { copyMirrorProtectionCleanup: state },
      } as any;
    };
    const rows = Array.from({ length: 201 }, (_, index) => makeRow(index));
    const valid = makeRow(999, true);
    rows.push(valid);
    const cancelled: number[] = [];
    let activeRow: any = null;
    const hasDueMarker = (candidate: any) => {
      const marker = candidate.perpProtection?.copyMirrorProtectionCleanup;
      const next = marker?.cleanupNextAttemptAt;
      return typeof next !== "string" || new Date(next).getTime() <= databaseNow.getTime();
    };
    const db: any = {
      execute: async () => [{ now: databaseNow }],
      query: {
        orders: {
          findMany: async (args: any) => {
            if (args?.columns?.perpProtection && !args?.columns?.perpProtectionError) {
              return rows.filter(hasDueMarker).slice(0, 201).map((candidate) => ({
                ...candidate,
                perpProtection: structuredClone(candidate.perpProtection),
              }));
            }
            return [];
          },
          findFirst: async () => activeRow,
        },
        userApiCredentials: {
          findFirst: async () => ({
            id: "credential",
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const protection = values.perpProtection as Record<string, unknown> | undefined;
              if (protection && typeof protection === "object" &&
                !Object.prototype.hasOwnProperty.call(protection, "queryChunks")) {
                if (activeRow) activeRow.perpProtection = protection;
              }
              return [{ id: activeRow?.id ?? valid.id }];
            },
          }),
        }),
      }),
    };
    const client = {
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => {
        activeRow = rows.find((candidate) =>
          candidate.perpProtection?.copyMirrorProtectionCleanup?.legClientOrderIds?.includes(clientOrderId),
        ) ?? valid;
        if (activeRow === valid) {
          return {
            status: "order",
            order: { order: { oid: 1999, coin: "BTC" }, status: "open" },
          };
        }
        return { status: "unknownOid" };
      },
      cancelOrder: async ({ orderId }: { orderId: number }) => {
        cancelled.push(orderId);
        return {
          status: "ok",
          response: { type: "cancel", data: { statuses: ["success"] } },
        };
      },
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({ client, walletAddress: wallet })) as never,
    });

    await (poller as any).retryPerpProtectionCleanupBacklog();
    expect(cancelled).toEqual([]);
    expect(rows.slice(0, 200).every((candidate) =>
      candidate.perpProtection.copyMirrorProtectionCleanup.cleanupAttemptCount === 1,
    )).toBe(true);

    await (poller as any).retryPerpProtectionCleanupBacklog();
    expect(cancelled).toEqual([1999]);
    expect(valid.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
  });

  it("excludes malformed cleanup markers before ORDER/LIMIT, including bad timestamps", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const validOpeningClientOrderId = "copymirror:follower:malformed-valid";
    const validState = {
      followerUserId: "follower",
      sourceItemId: "source-malformed-valid",
      walletAddress: wallet,
      coin: "BTC",
      openingClientOrderId: validOpeningClientOrderId,
      openingOrderId: "malformed-valid-opening",
      legClientOrderIds: [`${validOpeningClientOrderId}:tpsl:sl:87.5`],
    };
    const valid: any = {
      id: validState.openingOrderId,
      userId: validState.followerUserId,
      clientOrderId: validOpeningClientOrderId,
      symbol: validState.coin,
      venue: "hyperliquid",
      assetType: "PERP",
      perpProtectionStatus: "cancelled",
      brokerCredentialId: "credential",
      brokerAccountId: wallet,
      createdAt: new Date("2026-08-30T00:00:00.000Z"),
      perpProtection: { copyMirrorProtectionCleanup: validState },
    };
    const malformed = Array.from({ length: 200 }, (_, index) => ({
      ...valid,
      id: `malformed-${index}`,
      clientOrderId: `copymirror:follower:malformed-${index}`,
      createdAt: new Date(index),
      perpProtection: {
        copyMirrorProtectionCleanup: {
          // The marker is present but cannot authorize an exact action.
          cleanupNextAttemptAt: "2026-99-99T99:99:99.000Z",
        },
      },
    }));
    let cleanupFilterSeen = false;
    let activeRow: any = null;
    const serialized = (node: unknown, seen = new WeakSet<object>()): string => {
      if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
      if (seen.has(node)) return "";
      seen.add(node);
      return [
        typeof (node as { value?: unknown }).value === "string"
          ? (node as { value: string }).value
          : "",
        ...Object.values(node).map((child) => serialized(child, seen)),
      ].join(" ");
    };
    const db: any = {
      execute: async () => [{ now: new Date("2026-08-30T12:00:00.000Z") }],
      query: {
        orders: {
          findMany: async (args: any) => {
            if (args?.columns?.perpProtection && !args?.columns?.perpProtectionError) {
              const text = serialized(args.where);
              cleanupFilterSeen = text.includes("followerUserId") && text.includes("jsonb_typeof");
              return cleanupFilterSeen
                ? [valid]
                : [...malformed, valid];
            }
            return [];
          },
          findFirst: async () => activeRow ?? valid,
        },
        userApiCredentials: {
          findFirst: async () => ({
            id: "credential",
            provider: "hyperliquid",
            accountType: "REGISTERED",
          }),
        },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (values.perpProtection && typeof values.perpProtection === "object" &&
                !Object.prototype.hasOwnProperty.call(values.perpProtection, "queryChunks")) {
                valid.perpProtection = values.perpProtection;
              }
              return [{ id: valid.id }];
            },
          }),
        }),
      }),
    };
    const client = {
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 2999, coin: "BTC" }, status: "open" },
      }),
      cancelOrder: async () => ({
        status: "ok",
        response: { type: "cancel", data: { statuses: ["success"] } },
      }),
    };
    const poller = new CopyMirrorPoller(db, {
      createPerpClient: (async () => ({ client, walletAddress: wallet })) as never,
    });

    await (poller as any).retryPerpProtectionCleanupBacklog();

    expect(cleanupFilterSeen).toBe(true);
    expect(valid.perpProtection).not.toHaveProperty("copyMirrorProtectionCleanup");
  });
});
