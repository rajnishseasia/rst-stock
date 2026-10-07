/**
 * Attaching and retiring the follower's own perp exit.
 *
 * The arithmetic lives in copy-mirror-perp-protection.test.ts. This covers the
 * part that touches the venue: what is read before the legs go out, what happens
 * when they do not, and the rule that matters most, which is that a failed
 * attach NEVER closes the position.
 */

import { describe, expect, it } from "bun:test";
import { toCloid } from "@trade-bot/hyperliquid";
import type { PerpProtectionPlan } from "@trade-bot/db";

import {
  attachPerpProtection,
  cancelPerpProtection,
  recordPerpProtectionUnattached,
  readPerpProtectionOrderStatus,
  retryPerpProtectionCleanup,
  PERP_PROTECTION_ATTEMPTS,
  PerpProtectionRecordConflictError,
  type PerpProtectionAttachRequest,
  type PerpProtectionCleanupState,
  type PerpProtectionRule,
} from "../copy-mirror-perp-protection";

const WALLET = "0x4444444444444444444444444444444444444444" as const;

const REQUEST: PerpProtectionAttachRequest = {
  followerUserId: "f-1",
  sourceItemId: "x_signal:1",
  followId: "follow-1",
  walletAddress: WALLET,
  coin: "BTC",
  sizeCoin: "1",
  clientOrderId: "copymirror:f-1:x_signal:1",
};

const RULE: PerpProtectionRule = { takeProfitRoePct: 50, stopLossRoePct: 25 };

/** A live long, entered at 100 at 2x, so every trigger reads as a percentage. */
function longPosition(overrides: Record<string, unknown> = {}) {
  return {
    coin: "BTC",
    side: "long",
    size: "1",
    entryPx: "100",
    leverage: 2,
    marginMode: "cross",
    ...overrides,
  };
}

/** A venue reply Hyperliquid would send when it took every leg. */
function accepted(legs: number) {
  return {
    response: {
      data: {
        statuses: Array.from({ length: legs }, (_, index) => ({
          resting: { oid: 900 + index },
        })),
      },
    },
  };
}

/** A raw Hyperliquid cancel response with one explicitly accepted item. */
function acceptedCancel() {
  return {
    status: "ok",
    response: {
      type: "cancel",
      data: { statuses: ["success"] },
    },
  };
}

interface AttachHarness {
  positions?: () => Promise<unknown[]>;
  openOrders?: () => Promise<unknown[]>;
  orderStatusByClientOrderId?: (clientOrderId: string) => Promise<unknown>;
  setPositionTpSl?: (req: unknown) => Promise<unknown>;
  rule?: PerpProtectionRule | null;
  loadRule?: () => Promise<PerpProtectionRule | null>;
  recordAttached?: (plan: unknown) => Promise<void>;
  recordPlan?: (plan: PerpProtectionPlan) => Promise<void>;
  recordCleanup?: (state: unknown) => Promise<void>;
}

function attachHarness(options: AttachHarness = {}) {
  const calls = {
    listPositions: 0,
    setPositionTpSl: [] as unknown[],
    attached: [] as unknown[],
    checkpointed: [] as PerpProtectionPlan[],
    unprotected: [] as string[],
    /** The plan recorded alongside each `unprotected` note, or null for none. */
    unprotectedPlans: [] as (PerpProtectionPlan | null)[],
    delays: [] as number[],
    cleanup: [] as unknown[],
    // Anything that could reduce the position. Nothing here may ever touch it.
    cancelOrder: 0,
  };
  const client = {
    listPositions: async () => {
      calls.listPositions += 1;
      return (await (options.positions?.() ?? Promise.resolve([longPosition()]))) as never;
    },
    setPositionTpSl: async (req: unknown) => {
      calls.setPositionTpSl.push(req);
      return options.setPositionTpSl
        ? await options.setPositionTpSl(req)
        : accepted(2);
    },
    openOrders: async () =>
      (await (options.openOrders?.() ?? Promise.resolve([]))) as never,
    orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) =>
      (await (options.orderStatusByClientOrderId?.(clientOrderId) ??
        Promise.resolve({ status: "unknownOid" }))) as never,
    cancelOrder: async () => {
      calls.cancelOrder += 1;
      return acceptedCancel() as never;
    },
  };
  const deps = {
    loadRule:
      options.loadRule ??
      (async () => (options.rule === undefined ? RULE : options.rule)),
    recordAttached: async (plan: unknown) => {
      if (options.recordAttached) await options.recordAttached(plan);
      calls.attached.push(plan);
    },
    recordPlan: async (plan: PerpProtectionPlan) => {
      if (options.recordPlan) await options.recordPlan(plan);
      calls.checkpointed.push(plan);
    },
    recordUnprotected: async (reason: string, plan?: PerpProtectionPlan) => {
      calls.unprotected.push(reason);
      calls.unprotectedPlans.push(plan ?? null);
    },
    recordCleanup: async (state: unknown) => {
      if (options.recordCleanup) await options.recordCleanup(state);
      calls.cleanup.push(state);
    },
    delay: async (ms: number) => {
      calls.delays.push(ms);
    },
  };
  return { client, deps, calls };
}

describe("attaching a follower's perp exit", () => {
  it.each([
    ["open", "live"],
    ["resting", "live"],
    ["pending", "live"],
    ["waitingForTrigger", "live"],
    ["triggered", "filled"],
    ["filled", "filled"],
    ["rejected", "terminal"],
    ["canceled", "terminal"],
    ["expired", "terminal"],
  ] as const)("preserves and classifies the venue status %s", (status, kind) => {
    expect(readPerpProtectionOrderStatus({
      status: "order",
      order: {
        order: { oid: 901, coin: "BTC" },
        status,
        statusTimestamp: 1,
      },
    })).toMatchObject({ kind, status, oid: 901 });
  });

  it("defers an undocumented future exact status instead of retiring the leg", () => {
    expect(readPerpProtectionOrderStatus({
      status: "order",
      order: {
        order: { oid: 901, coin: "BTC" },
        status: "pausedByVenue",
      },
    })).toMatchObject({ kind: "indeterminate", status: "pausedByVenue", oid: 901 });
  });

  it.each([
    "vaultWithdrawalCanceled",
    "openInterestCapCanceled",
    "selfTradeCanceled",
    "siblingFilledCanceled",
    "delistedCanceled",
    "liquidatedCanceled",
    "tickRejected",
    "minTradeNtlRejected",
    "perpMarginRejected",
    "reduceOnlyRejected",
    "badAloPxRejected",
    "iocCancelRejected",
    "badTriggerPxRejected",
    "marketOrderNoLiquidityRejected",
    "positionIncreaseAtOpenInterestCapRejected",
    "positionFlipAtOpenInterestCapRejected",
    "tooAggressiveAtOpenInterestCapRejected",
    "openInterestIncreaseRejected",
    "insufficientSpotBalanceRejected",
    "oracleRejected",
    "perpMaxPositionRejected",
  ])("treats documented terminal status %s as safe terminal", (status) => {
    expect(readPerpProtectionOrderStatus({
      status: "order",
      order: {
        order: { oid: 901, coin: "BTC" },
        status,
      },
    })).toMatchObject({ kind: "terminal", status, oid: 901 });
  });

  it("makes no venue call at all when the follow has no exit configured", async () => {
    // OFF BY DEFAULT has to mean untouched, not "attached with nothing in it".
    // Every follow that existed before this feature is in this state.
    const harness = attachHarness({ rule: null });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toEqual({ outcome: "not-configured" });
    expect(harness.calls.listPositions).toBe(0);
    expect(harness.calls.setPositionTpSl).toEqual([]);
    expect(harness.calls.attached).toEqual([]);
    expect(harness.calls.unprotected).toEqual([]);
  });

  it("prices the legs off the position the venue reports, not off the order", async () => {
    // The order was priced off a mid and filled through a slippage band, so the
    // entry that matters is the venue's. At 2x, a 25% margin stop on a long
    // entered at 100 is a 12.5% price move.
    const harness = attachHarness();

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "attached" });
    expect(harness.calls.setPositionTpSl[0]).toMatchObject({
      coin: "BTC",
      positionSide: "long",
      size: "1",
      takeProfitPx: "125",
      stopLossPx: "87.5",
    });
    expect(harness.calls.attached[0]).toMatchObject({
      entryPx: "100",
      leverage: 2,
      stopLossRoePct: 25,
      takeProfitRoePct: 50,
    });
  });

  it("never covers more than the mirror itself opened", async () => {
    // The open guard lets a mirror ADD to a same-side position the follower
    // opened by hand. Sizing the exit to the whole position would have the
    // mirror place a stop over exposure it did not open.
    const harness = attachHarness({
      positions: async () => [longPosition({ size: "9" })],
    });

    await attachPerpProtection(harness.client as never, REQUEST, harness.deps as never);

    expect(harness.calls.setPositionTpSl[0]).toMatchObject({ size: "1" });
  });

  it("retries a position read that has not caught up with the fill yet", async () => {
    let read = 0;
    const harness = attachHarness({
      positions: async () => {
        read += 1;
        return read === 1 ? [] : [longPosition()];
      },
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "attached" });
    expect(harness.calls.delays.length).toBe(1);
    expect(harness.calls.unprotected).toEqual([]);
  });

  it("defers a failed attach when exact recovery remains unknown", async () => {
    // The whole point of the feature's failure mode. Closing a position because
    // an API call blipped is a loss the follower did not ask for, and an
    // unprotected mirror is exactly what every mirror was before this shipped.
    // Once a plan has been checkpointed, an unknown exact result is also not
    // permission to submit a replacement pair.
    const harness = attachHarness({
      setPositionTpSl: async () => {
        throw new Error("hyperliquid unreachable");
      },
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected", attempts: PERP_PROTECTION_ATTEMPTS });
    expect(harness.calls.setPositionTpSl.length).toBe(1);
    expect(harness.calls.unprotected[0]).toContain("unknownOid");
    // Nothing reduced, nothing closed, nothing unwound.
    expect(harness.calls.cancelOrder).toBe(0);
  });

  it("treats a partly accepted trigger group as a failure and defers unknown legs", async () => {
    // `setPositionTpSl` does not throw on a per-leg rejection, so a reply
    // carrying one resting leg out of two would otherwise be read as success and
    // the follower would believe they had a stop they do not have.
    const harness = attachHarness({ setPositionTpSl: async () => accepted(1) });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(harness.calls.unprotected[0]).toContain("unknownOid");
    // The first partial response is checkpointed, but an exact unknown on the
    // next pass is not permission to place a replacement pair.
    expect(harness.calls.setPositionTpSl).toHaveLength(1);
  });

  it("records the leg ids it submitted even when it gives up, so an orphan stays reachable", async () => {
    // Hyperliquid took ONE of the two legs. That leg is live, reduce-only, and
    // its cloid is the only handle anything has on it: the cancel path matches
    // resting orders against the ids recorded on the row. Discarding them
    // because the group as a whole was not accepted leaves a trigger at the
    // venue that nothing in this system can ever retire.
    const harness = attachHarness({ setPositionTpSl: async () => accepted(1) });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(harness.calls.unprotectedPlans[0]).toMatchObject({
      legClientOrderIds: [
        `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
        `${REQUEST.clientOrderId}:tpsl:tp:125`,
      ],
    });
  });

  it("records nothing to cancel when no leg ever reached the venue", async () => {
    // The mirror image of the test above. A submission that never happened has
    // no cloid resting anywhere, and writing ids the venue never saw onto the
    // row would invite a later cancel to go looking for orders that do not
    // exist. Only legs that were actually sent are worth recording.
    const harness = attachHarness({ positions: async () => [] });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(harness.calls.setPositionTpSl).toEqual([]);
    expect(harness.calls.unprotectedPlans[0]).toBeNull();
  });

  it("keeps a leg submitted at an earlier entry in the plan it finally records", async () => {
    // Each leg's cloid folds in ITS OWN trigger price, and the trigger price is
    // derived from the position this attempt read back. A fill landing between
    // attempts moves the entry, so the retry submits a different pair under
    // different ids: the leg the first attempt got taken is left resting under
    // an id the successful plan would never mention.
    let read = 0;
    let submitted = 0;
    const harness = attachHarness({
      positions: async () => [longPosition(read++ === 0 ? {} : { entryPx: "110" })],
      setPositionTpSl: async () => (submitted++ === 0 ? accepted(1) : accepted(2)),
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(harness.calls.setPositionTpSl).toHaveLength(1);
    expect(harness.calls.unprotected[0]).toContain("unknownOid");
  });

  it("stops retrying a rule that can never price a leg at this entry", async () => {
    // A short taking profit at 500% of margin at 1x needs a negative price, and
    // it will need one on every attempt. Waiting out the backoff to fail the
    // same way is a cost with no upside.
    const harness = attachHarness({
      rule: { takeProfitRoePct: 500, stopLossRoePct: null },
      positions: async () => [
        longPosition({ side: "short", leverage: 1 }),
      ],
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected", attempts: 1 });
    expect(harness.calls.listPositions).toBe(1);
    expect(harness.calls.delays).toEqual([]);
  });

  it("reports live-but-unrecorded legs rather than submitting a second pair", async () => {
    // The legs reached the venue. Retrying would rest a duplicate pair; the only
    // honest answer is that the plan cannot be cancelled later, which is the same
    // operator-visible state as a failed attach.
    const harness = attachHarness({
      recordAttached: async () => {
        throw new Error("database write failed");
      },
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected", attempts: 1 });
    expect(harness.calls.setPositionTpSl.length).toBe(1);
  });

  it.each(["rejected", "canceled", "cancelled", "expired"])(
    "does not treat a terminal protection status (%s) as a live leg",
    async (status) => {
      const prior: PerpProtectionPlan = {
        entryPx: "100",
        leverage: 2,
        sizeCoin: "1",
        stopLossPx: "87.5",
        takeProfitPx: "125",
        legClientOrderIds: [
          `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
          `${REQUEST.clientOrderId}:tpsl:tp:125`,
        ],
      };
      const harness = attachHarness({
        openOrders: async () => [],
        orderStatusByClientOrderId: async () => ({
          status: "order",
          order: {
            order: { oid: 901, coin: "BTC" },
            status,
            statusTimestamp: 1,
          },
        }),
      });

      const result = await attachPerpProtection(
        harness.client as never,
        { ...REQUEST, priorProtectionPlan: prior },
        harness.deps as never,
      );

      expect(result).toMatchObject({ outcome: "unprotected" });
      expect(harness.calls.setPositionTpSl).toEqual([]);
      expect(harness.calls.attached).toEqual([]);
    },
  );

  it("revalidates the position after a filled protection leg instead of attaching it",
    async () => {
      const prior: PerpProtectionPlan = {
        entryPx: "100",
        leverage: 2,
        sizeCoin: "1",
        stopLossPx: "87.5",
        takeProfitPx: "125",
        legClientOrderIds: [
          `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
          `${REQUEST.clientOrderId}:tpsl:tp:125`,
        ],
      };
      let reads = 0;
      const harness = attachHarness({
        positions: async () => {
          reads += 1;
          return reads === 1 ? [longPosition()] : [];
        },
        openOrders: async () => [],
        orderStatusByClientOrderId: async (_clientOrderId) => ({
          status: "order",
          order: {
            order: { oid: 901, coin: "BTC" },
            status: "filled",
            statusTimestamp: 1,
          },
        }),
      });

      const result = await attachPerpProtection(
        harness.client as never,
        { ...REQUEST, priorProtectionPlan: prior },
        harness.deps as never,
      );

      expect(result).toMatchObject({ outcome: "unprotected" });
      expect(reads).toBe(2);
      expect(harness.calls.setPositionTpSl).toEqual([]);
      expect(harness.calls.attached).toEqual([]);
    },
  );

  it("revalidates the position after an exact triggered protection leg instead of attaching it",
    async () => {
      const prior: PerpProtectionPlan = {
        entryPx: "100",
        leverage: 2,
        sizeCoin: "1",
        stopLossPx: "87.5",
        takeProfitPx: "125",
        legClientOrderIds: [
          `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
          `${REQUEST.clientOrderId}:tpsl:tp:125`,
        ],
      };
      let reads = 0;
      const harness = attachHarness({
        positions: async () => {
          reads += 1;
          return [longPosition()];
        },
        openOrders: async () => [],
        orderStatusByClientOrderId: async (_clientOrderId) => ({
          status: "order",
          order: {
            order: { oid: 901, coin: "BTC" },
            status: "triggered",
            statusTimestamp: 1,
          },
        }),
      });

      const result = await attachPerpProtection(
        harness.client as never,
        { ...REQUEST, priorProtectionPlan: prior },
        harness.deps as never,
      );

      expect(result).toMatchObject({
        outcome: "unprotected",
        reason: "filled-protection-position-still-open",
      });
      expect(reads).toBe(2);
      expect(harness.calls.setPositionTpSl).toEqual([]);
      expect(harness.calls.attached).toEqual([]);
    },
  );

  it("revalidates after the venue reports a trigger filled in the attach response",
    async () => {
      let reads = 0;
      const harness = attachHarness({
        positions: async () => {
          reads += 1;
          return reads === 1 ? [longPosition()] : [];
        },
        setPositionTpSl: async () => ({
          response: {
            data: {
              statuses: [
                { filled: { oid: 901, totalSz: "1", avgPx: "87.5" } },
                { filled: { oid: 902, totalSz: "1", avgPx: "125" } },
              ],
            },
          },
        }),
      });

      const result = await attachPerpProtection(
        harness.client as never,
        REQUEST,
        harness.deps as never,
      );

      expect(result).toMatchObject({ outcome: "unprotected" });
      expect(reads).toBe(2);
      expect(harness.calls.attached).toEqual([]);
    },
  );

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["non-numeric", "not-a-number"],
  ] as const)(
    "does not treat a present %s size as flat after prior exact-filled recovery",
    async (_label, malformedSize) => {
      const priorLegs = [
        `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
        `${REQUEST.clientOrderId}:tpsl:tp:125`,
      ];
      const prior: PerpProtectionPlan = {
        entryPx: "100",
        leverage: 2,
        sizeCoin: "1",
        stopLossPx: "87.5",
        takeProfitPx: "125",
        legClientOrderIds: priorLegs,
      };
      let reads = 0;
      const harness = attachHarness({
        positions: async () => {
          reads += 1;
          return reads % 2 === 1
            ? [longPosition()]
            : [longPosition({ size: malformedSize })];
        },
        openOrders: async () => [],
        orderStatusByClientOrderId: async () => ({
          status: "order",
          order: {
            order: { oid: 901, coin: "BTC" },
            status: "filled",
            statusTimestamp: 1,
          },
        }),
      });

      const result = await attachPerpProtection(
        harness.client as never,
        { ...REQUEST, priorProtectionPlan: prior },
        harness.deps as never,
      );

      expect(result).toMatchObject({
        outcome: "unprotected",
        reason: "filled-protection-position-size-unreadable",
        attempts: PERP_PROTECTION_ATTEMPTS,
      });
      expect(reads).toBe(PERP_PROTECTION_ATTEMPTS * 2);
      expect(harness.calls.delays).toHaveLength(PERP_PROTECTION_ATTEMPTS - 1);
      expect(harness.calls.setPositionTpSl).toEqual([]);
      expect(harness.calls.unprotectedPlans[0]?.legClientOrderIds).toEqual(priorLegs);
    },
  );

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["non-numeric", "not-a-number"],
  ] as const)(
    "does not treat a present %s size as flat after an immediate filled placement response",
    async (_label, malformedSize) => {
      const submittedLegs = [
        `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
        `${REQUEST.clientOrderId}:tpsl:tp:125`,
      ];
      let reads = 0;
      const harness = attachHarness({
        positions: async () => {
          reads += 1;
          return reads % 2 === 1
            ? [longPosition()]
            : [longPosition({ size: malformedSize })];
        },
        setPositionTpSl: async () => ({
          response: {
            data: {
              statuses: [
                { filled: { oid: 901, totalSz: "1", avgPx: "87.5" } },
                { filled: { oid: 902, totalSz: "1", avgPx: "125" } },
              ],
            },
          },
        }),
        orderStatusByClientOrderId: async () => ({
          status: "order",
          order: {
            order: { oid: 901, coin: "BTC" },
            status: "filled",
            statusTimestamp: 1,
          },
        }),
      });

      const result = await attachPerpProtection(
        harness.client as never,
        REQUEST,
        harness.deps as never,
      );

      expect(result).toMatchObject({
        outcome: "unprotected",
        reason: "filled-protection-position-size-unreadable",
        attempts: PERP_PROTECTION_ATTEMPTS,
      });
      expect(reads).toBe(PERP_PROTECTION_ATTEMPTS * 2);
      expect(harness.calls.delays).toHaveLength(PERP_PROTECTION_ATTEMPTS - 1);
      expect(harness.calls.setPositionTpSl).toHaveLength(1);
      expect(harness.calls.unprotectedPlans[0]?.legClientOrderIds).toEqual(submittedLegs);
    },
  );

  it("defers a prior-plan unknownOid before submitting any replacement leg", async () => {
    const priorLegs = [
      `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
      `${REQUEST.clientOrderId}:tpsl:tp:125`,
    ];
    const harness = attachHarness({
      openOrders: async () => [],
      orderStatusByClientOrderId: async () => ({ status: "unknownOid" }),
    });

    const result = await attachPerpProtection(
      harness.client as never,
      {
        ...REQUEST,
        priorProtectionPlan: plan(priorLegs),
      },
      harness.deps as never,
    );

    expect(result).toMatchObject({
      outcome: "unprotected",
      reason: expect.stringContaining("unknown"),
    });
    expect(harness.calls.setPositionTpSl).toEqual([]);
    expect(harness.calls.attached).toEqual([]);
  });

  it("defers filled prior-plan recovery when the HIP-3 dex was not covered", async () => {
    const hip3Request = { ...REQUEST, coin: "xyz:JPY" };
    const priorLegs = [
      `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
      `${REQUEST.clientOrderId}:tpsl:tp:125`,
    ];
    let snapshotReads = 0;
    const harness = attachHarness({
      positions: async () => [longPosition({ coin: "xyz:JPY" })],
      openOrders: async () => [],
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 901, coin: "xyz:JPY" }, status: "filled" },
      }),
    });
    (harness.client as any).perpAccountSnapshot = async () => {
      snapshotReads += 1;
      return { positions: [], crossMargin: null, coveredDexes: [] };
    };

    const result = await attachPerpProtection(
      harness.client as never,
      { ...hip3Request, priorProtectionPlan: plan(priorLegs) },
      harness.deps as never,
    );

    expect(result).toMatchObject({
      outcome: "unprotected",
      reason: expect.stringContaining("coverage"),
    });
    expect(snapshotReads).toBeGreaterThan(0);
    expect(harness.calls.setPositionTpSl).toEqual([]);
  });

  it("defers filled prior-plan recovery for a namespaced HIP-3 coin without an account snapshot", async () => {
    const hip3Request = { ...REQUEST, coin: "xyz:JPY" };
    const priorLegs = [
      `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
      `${REQUEST.clientOrderId}:tpsl:tp:125`,
    ];
    const harness = attachHarness({
      positions: async () => [longPosition({ coin: "xyz:JPY" })],
      openOrders: async () => [],
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 901, coin: "xyz:JPY" }, status: "filled" },
      }),
    });

    const result = await attachPerpProtection(
      harness.client as never,
      { ...hip3Request, priorProtectionPlan: plan(priorLegs) },
      harness.deps as never,
    );

    expect(result).toMatchObject({
      outcome: "unprotected",
      reason: expect.stringContaining("snapshot"),
      attempts: PERP_PROTECTION_ATTEMPTS,
    });
    expect(harness.calls.setPositionTpSl).toEqual([]);
  });

  it("checkpoints the deterministic plan before a trigger submit", async () => {
    let checkpointSeenBySubmit = false;
    const harness = attachHarness({
      recordPlan: async (plan) => {
        expect(plan.legClientOrderIds).toEqual([
          `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
          `${REQUEST.clientOrderId}:tpsl:tp:125`,
        ]);
      },
      setPositionTpSl: async () => {
        checkpointSeenBySubmit = harness.calls.checkpointed.length > 0;
        throw new Error("reply lost after trigger submit");
      },
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(checkpointSeenBySubmit).toBe(true);
    expect(harness.calls.checkpointed[0]?.legClientOrderIds).toHaveLength(2);
  });

  it("recovers a partially persisted protection plan by submitting only the missing leg", async () => {
    const stopLossLeg = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    const harness = attachHarness({
      openOrders: async () => [
        { coin: "BTC", oid: 901, cloid: toCloid(stopLossLeg) },
      ],
      setPositionTpSl: async (req) => {
        expect(req).toMatchObject({
          coin: "BTC",
          positionSide: "long",
          size: "1",
          takeProfitPx: "125",
        });
        expect((req as { stopLossPx?: unknown }).stopLossPx).toBeUndefined();
        return accepted(1);
      },
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "attached" });
    expect(harness.calls.setPositionTpSl).toHaveLength(1);
    expect((result as { plan: PerpProtectionPlan }).plan.legClientOrderIds).toEqual([
      `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
      `${REQUEST.clientOrderId}:tpsl:tp:125`,
    ]);
  });

  it("does not re-submit protection when both deterministic legs are already resting", async () => {
    const stopLossLeg = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    const takeProfitLeg = `${REQUEST.clientOrderId}:tpsl:tp:125`;
    const harness = attachHarness({
      openOrders: async () => [
        { coin: "BTC", oid: 901, cloid: toCloid(stopLossLeg) },
        { coin: "BTC", oid: 902, cloid: toCloid(takeProfitLeg) },
      ],
    });

    const result = await attachPerpProtection(
      harness.client as never,
      REQUEST,
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "attached" });
    expect(harness.calls.setPositionTpSl).toEqual([]);
  });

  it("uses a persisted leg id when a later position read derives a new trigger", async () => {
    const priorStop = `${REQUEST.clientOrderId}:tpsl:sl:96.25`;
    const priorTakeProfit = `${REQUEST.clientOrderId}:tpsl:tp:137.5`;
    const prior: PerpProtectionPlan = {
      entryPx: "110",
      leverage: 2,
      sizeCoin: "1",
      stopLossPx: "96.25",
      takeProfitPx: "137.5",
      legClientOrderIds: [priorStop, priorTakeProfit],
    };
    const harness = attachHarness({
      positions: async () => [longPosition({ entryPx: "120" })],
      openOrders: async () => [
        { coin: "BTC", oid: 903, cloid: toCloid(priorStop) },
      ],
      setPositionTpSl: async (req) => {
        expect((req as { stopLossPx?: unknown }).stopLossPx).toBeUndefined();
        expect((req as { takeProfitPx?: unknown }).takeProfitPx).toBe("150");
        return accepted(1);
      },
    });

    const result = await attachPerpProtection(
      harness.client as never,
      { ...REQUEST, priorProtectionPlan: prior },
      harness.deps as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(harness.calls.setPositionTpSl).toHaveLength(0);
    expect(harness.calls.unprotected[0]).toContain("unknownOid");
  });

  it("cancels every leg submitted by a stale attach whose record lost to cancellation", async () => {
    const submittedLegs = [
      `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
      `${REQUEST.clientOrderId}:tpsl:tp:125`,
    ];
    let openOrderRead = 0;
    const cancelled: number[] = [];
    const client = {
      listPositions: async () => [longPosition()] as never,
      openOrders: async () => {
        openOrderRead += 1;
        return openOrderRead === 1
          ? []
          : submittedLegs.map((leg, index) => ({
              coin: "BTC",
              oid: 901 + index,
              cloid: toCloid(leg),
            })) as never;
      },
      setPositionTpSl: async () => accepted(2) as never,
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => ({
        status: "order",
        order: {
          order: { oid: clientOrderId.endsWith(":sl:87.5") ? 901 : 902, coin: "BTC" },
          status: "open",
          statusTimestamp: 1,
        },
      }) as never,
      cancelOrder: async ({ orderId }: { orderId: number }) => {
        cancelled.push(orderId);
        return acceptedCancel() as never;
      },
    };
    const harness = attachHarness();
    const result = await attachPerpProtection(
      client as never,
      REQUEST,
      {
        ...harness.deps,
        recordAttached: async () => {
          throw new PerpProtectionRecordConflictError(
            "close won protection record",
            "cancelled",
          );
        },
      } as never,
    );

    expect(result).toMatchObject({ outcome: "unprotected" });
    expect(cancelled).toEqual([901, 902]);
  });

  it("retains exact cleanup state when aggregate open-orders data is empty and exact probes fail",
    async () => {
      const submittedLegs = [
        `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
        `${REQUEST.clientOrderId}:tpsl:tp:125`,
      ];
      const cleanup: unknown[] = [];
      const client = {
        listPositions: async () => [longPosition()] as never,
        // This stale aggregate must not be treated as proof that cleanup is done.
        openOrders: async () => [] as never,
        setPositionTpSl: async () => accepted(2) as never,
        orderStatusByClientOrderId: async () => {
          throw new Error("exact status temporarily unavailable");
        },
        cancelOrder: async () => acceptedCancel() as never,
      };
      const harness = attachHarness();
      const result = await attachPerpProtection(
        client as never,
        REQUEST,
        {
          ...harness.deps,
          recordAttached: async () => {
            throw new PerpProtectionRecordConflictError(
              "close won protection record",
              "cancelled",
            );
          },
          recordCleanup: async (state: unknown) => cleanup.push(state),
        } as never,
      );

      expect(result).toMatchObject({ outcome: "unprotected" });
      expect(cleanup).toHaveLength(1);
      expect(cleanup[0]).toMatchObject({
        coin: "BTC",
        walletAddress: WALLET,
        legClientOrderIds: submittedLegs,
      });
    },
  );

  it("surfaces cleanup persistence failure with state for later exact recovery",
    async () => {
      const submittedLegs = [
        `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
        `${REQUEST.clientOrderId}:tpsl:tp:125`,
      ];
      const cancelled: number[] = [];
      let exactVisible = false;
      let cleanupWrites = 0;
      const client = {
        listPositions: async () => [longPosition()] as never,
        openOrders: async () => [] as never,
        setPositionTpSl: async () => accepted(2) as never,
        orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => {
          if (!exactVisible) return { status: "unknownOid" } as never;
          return {
            status: "order",
            order: {
              order: {
                oid: clientOrderId.endsWith(":sl:87.5") ? 901 : 902,
                coin: "BTC",
              },
              status: "open",
            },
          } as never;
        },
        cancelOrder: async ({ orderId }: { coin: string; orderId: number }) => {
          cancelled.push(orderId);
          return acceptedCancel() as never;
        },
      };
      const harness = attachHarness();
      let failure: unknown;
      try {
        await attachPerpProtection(
          client as never,
          REQUEST,
          {
            ...harness.deps,
            recordAttached: async () => {
              throw new PerpProtectionRecordConflictError(
                "close won protection record",
                "cancelled",
              );
            },
            recordCleanup: async () => {
              cleanupWrites += 1;
              throw new Error("cleanup db unavailable");
            },
          } as never,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "PERP_PROTECTION_CLEANUP_PERSIST_FAILED",
        state: {
          coin: "BTC",
          walletAddress: WALLET,
          legClientOrderIds: submittedLegs,
        },
      });
      expect(cleanupWrites).toBe(1);
      expect(cancelled).toEqual([]);

      // The caller retains the exact submitted-cloid authority from the error;
      // a later worker can use it even though the cancelled row had no marker
      // when the first persistence attempt failed.
      const recoveredState = (failure as { state: PerpProtectionCleanupState }).state;
      exactVisible = true;
      const retry = await retryPerpProtectionCleanup(client as never, recoveredState);

      expect(retry).toMatchObject({ retired: 2, pending: [] });
      expect(cancelled).toEqual([901, 902]);
    },
  );

  it("returns exact retired cloids and persists only the still-pending subset", async () => {
    const legA = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    const legB = `${REQUEST.clientOrderId}:tpsl:tp:125`;
    const state: PerpProtectionCleanupState = {
      followerUserId: REQUEST.followerUserId,
      sourceItemId: REQUEST.sourceItemId,
      walletAddress: REQUEST.walletAddress,
      coin: REQUEST.coin,
      openingClientOrderId: REQUEST.clientOrderId,
      legClientOrderIds: [legA, legB],
    };
    const persisted: Array<{
      state: PerpProtectionCleanupState;
      retired: readonly string[];
    }> = [];
    const client = {
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => {
        if (clientOrderId === legA) {
          return {
            status: "order",
            order: { order: { oid: 901, coin: "BTC" }, status: "open" },
          } as never;
        }
        return { status: "unknownOid" } as never;
      },
      cancelOrder: async () => acceptedCancel() as never,
    };

    const result = await retryPerpProtectionCleanup(client as never, state, {
      recordCleanup: async (
        pending: PerpProtectionCleanupState,
        retired: readonly string[] = [],
      ) => persisted.push({ state: pending, retired }),
    });

    expect(result).toMatchObject({ retired: 1, pending: [legB] });
    expect(result.retiredLegClientOrderIds).toEqual([legA]);
    expect(persisted).toEqual([{
      state: { ...state, legClientOrderIds: [legB] },
      retired: [legA],
    }]);
  });

  it("does not retire a leg when Hyperliquid returns a per-item cancel error", async () => {
    const leg = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    let exactReads = 0;
    let cancelCalls = 0;
    const client = {
      orderStatusByClientOrderId: async () => {
        exactReads += 1;
        return {
          status: "order",
          order: { order: { oid: 901, coin: "BTC" }, status: "open" },
        } as never;
      },
      cancelOrder: async () => {
        cancelCalls += 1;
        return {
          status: "ok",
          response: {
            type: "cancel",
            data: { statuses: [{ error: "order already gone" }] },
          },
        } as never;
      },
    };

    const result = await retryPerpProtectionCleanup(client as never, {
      followerUserId: REQUEST.followerUserId,
      sourceItemId: REQUEST.sourceItemId,
      walletAddress: REQUEST.walletAddress,
      coin: REQUEST.coin,
      legClientOrderIds: [leg],
    });

    expect(result.retired).toBe(0);
    expect(result.pending).toEqual([leg]);
    expect(result.retiredLegClientOrderIds).toEqual([]);
    expect(exactReads).toBe(2);
    expect(cancelCalls).toBe(1);
    expect(result.errors.join(" ")).toContain("cancel");
  });

  it("stops before exact status or cancel when the cleanup lease is stale", async () => {
    const leg = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    let exactReads = 0;
    let cancelCalls = 0;
    const client = {
      orderStatusByClientOrderId: async () => {
        exactReads += 1;
        return {
          status: "order",
          order: { order: { oid: 901, coin: "BTC" }, status: "open" },
        } as never;
      },
      cancelOrder: async () => {
        cancelCalls += 1;
        return acceptedCancel() as never;
      },
    };
    const renewals: string[] = [];

    const result = await retryPerpProtectionCleanup(client as never, {
      followerUserId: REQUEST.followerUserId,
      sourceItemId: REQUEST.sourceItemId,
      walletAddress: REQUEST.walletAddress,
      coin: REQUEST.coin,
      legClientOrderIds: [leg],
    }, {
      beforeExactProbe: async () => {
        renewals.push("probe");
        return true;
      },
      beforeCancel: async () => {
        renewals.push("cancel");
        return false;
      },
    });

    expect(result.retired).toBe(0);
    expect(result.pending).toEqual([leg]);
    expect(exactReads).toBe(1);
    expect(cancelCalls).toBe(0);
    expect(renewals).toEqual(["probe", "cancel"]);
  });

  it("defers filled cleanup when the HIP-3 dex is not covered by the account snapshot", async () => {
    const leg = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    let snapshotReads = 0;
    let persisted: PerpProtectionCleanupState | undefined;
    const client = {
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 901, coin: "xyz:JPY" }, status: "filled" },
      }) as never,
      listPositions: async () => [] as never,
      perpAccountSnapshot: async () => {
        snapshotReads += 1;
        return { positions: [], crossMargin: null, coveredDexes: [] };
      },
      cancelOrder: async () => acceptedCancel() as never,
    };

    const result = await retryPerpProtectionCleanup(client as never, {
      followerUserId: REQUEST.followerUserId,
      sourceItemId: REQUEST.sourceItemId,
      walletAddress: REQUEST.walletAddress,
      coin: "xyz:JPY",
      legClientOrderIds: [leg],
    }, {
      recordCleanup: async (state) => {
        persisted = state;
      },
    });

    expect(result.retired).toBe(0);
    expect(result.pending).toEqual([leg]);
    expect(snapshotReads).toBe(1);
    expect(persisted?.legClientOrderIds).toEqual([leg]);
  });

  it("defers filled cleanup for a namespaced HIP-3 coin when no account snapshot is available", async () => {
    const leg = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    let persisted: PerpProtectionCleanupState | undefined;
    const client = {
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 901, coin: "xyz:JPY" }, status: "filled" },
      }) as never,
      listPositions: async () => [] as never,
      cancelOrder: async () => acceptedCancel() as never,
    };

    const result = await retryPerpProtectionCleanup(client as never, {
      followerUserId: REQUEST.followerUserId,
      sourceItemId: REQUEST.sourceItemId,
      walletAddress: REQUEST.walletAddress,
      coin: "xyz:JPY",
      legClientOrderIds: [leg],
    }, {
      recordCleanup: async (state) => {
        persisted = state;
      },
    });

    expect(result.retired).toBe(0);
    expect(result.pending).toEqual([leg]);
    expect(result.errors.join(" ")).toContain("snapshot");
    expect(persisted?.legClientOrderIds).toEqual([leg]);
  });

  it("preserves exact retired cloids when cleanup persistence fails after partial progress", async () => {
    const legA = `${REQUEST.clientOrderId}:tpsl:sl:87.5`;
    const legB = `${REQUEST.clientOrderId}:tpsl:tp:125`;
    const client = {
      listPositions: async () => [longPosition()] as never,
      openOrders: async () => [] as never,
      setPositionTpSl: async () => accepted(2) as never,
      orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) =>
        clientOrderId === legA
          ? {
              status: "order",
              order: { order: { oid: 901, coin: "BTC" }, status: "canceled" },
            } as never
          : { status: "unknownOid" } as never,
      cancelOrder: async () => acceptedCancel() as never,
    };
    const harness = attachHarness();
    let failure: unknown;
    try {
      await attachPerpProtection(
        client as never,
        REQUEST,
        {
          ...harness.deps,
          recordAttached: async () => {
            throw new PerpProtectionRecordConflictError(
              "close won protection record",
              "cancelled",
            );
          },
          recordCleanup: async () => {
            throw new Error("cleanup db unavailable");
          },
        } as never,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PERP_PROTECTION_CLEANUP_PERSIST_FAILED",
      state: { legClientOrderIds: [legB] },
      retiredLegClientOrderIds: [legA],
    });
  });

  it("retries lagging exact probes and cancels every later-found stale leg by OID",
    async () => {
      const submittedLegs = [
        `${REQUEST.clientOrderId}:tpsl:sl:87.5`,
        `${REQUEST.clientOrderId}:tpsl:tp:125`,
      ];
      const cleanup: PerpProtectionCleanupState[] = [];
      const cancelled: number[] = [];
      let exactPhase: "lagging" | "visible" = "lagging";
      let aggregateReads = 0;
      const client = {
        listPositions: async () => [longPosition()] as never,
        // The aggregate read is empty while the exact cloid index catches up.
        openOrders: async () => {
          aggregateReads += 1;
          return [] as never;
        },
        setPositionTpSl: async () => accepted(2) as never,
        orderStatusByClientOrderId: async (_address: `0x${string}`, clientOrderId: string) => {
          if (exactPhase === "lagging") return { status: "unknownOid" } as never;
          return {
            status: "order",
            order: {
              order: {
                oid: clientOrderId.endsWith(":sl:87.5") ? 901 : 902,
                coin: "BTC",
              },
              status: "open",
              statusTimestamp: 1,
            },
          } as never;
        },
        cancelOrder: async ({ orderId }: { coin: string; orderId: number }) => {
          cancelled.push(orderId);
          return acceptedCancel() as never;
        },
      };
      const result = await attachPerpProtection(
        client as never,
        REQUEST,
        {
          ...attachHarness().deps,
          recordAttached: async () => {
            throw new PerpProtectionRecordConflictError(
              "close won protection record",
              "cancelled",
            );
          },
          recordCleanup: async (state: PerpProtectionCleanupState) => cleanup.push(state),
        } as never,
      );

      expect(result).toMatchObject({ outcome: "unprotected" });
      expect(cleanup).toHaveLength(1);
      expect(cleanup[0]?.legClientOrderIds).toEqual(submittedLegs);
      expect(aggregateReads).toBe(1);

      exactPhase = "visible";
      const retry = await retryPerpProtectionCleanup(
        client as never,
        cleanup[0]!,
      );

      expect(retry).toMatchObject({ retired: 2, pending: [] });
      expect(cancelled).toEqual([901, 902]);
      // Recovery is exact-cloid-only; a stale empty aggregate can never hide
      // a later-found accepted leg from this retry.
      expect(aggregateReads).toBe(1);
    },
  );

});

/** A plan as it comes back off the opening order row. */
function plan(legClientOrderIds: string[]): PerpProtectionPlan {
  return {
    entryPx: "100",
    leverage: 2,
    sizeCoin: "1",
    legClientOrderIds,
  };
}

function cancelHarness(options: {
  rows?: {
    orderId: string;
    clientOrderId: string | null;
    perpProtection: PerpProtectionPlan | null;
    perpProtectionStatus: string | null;
  }[];
  openOrders?: () => Promise<unknown[]>;
  cancelOrder?: () => Promise<unknown>;
} = {}) {
  const calls = { cancelled: [] as number[], marked: [] as string[] };
  const client = {
    listPositions: async () => [] as never,
    setPositionTpSl: async () => ({}) as never,
    openOrders: async () =>
      (await (options.openOrders?.() ?? Promise.resolve([]))) as never,
    cancelOrder: async (req: { orderId: number }) => {
      if (options.cancelOrder) await options.cancelOrder();
      calls.cancelled.push(req.orderId);
      return acceptedCancel() as never;
    },
  };
  const deps = {
    loadAttachedPlans: async () => options.rows ?? [],
    markCancelled: async (orderId: string) => {
      calls.marked.push(orderId);
    },
  };
  return { client, deps, calls };
}

describe("retiring the legs when the source's own close is mirrored", () => {
  // The cloid Hyperliquid reports for a leg is the keccak of its pre-hash id.
  // Deriving it here rather than hardcoding keeps the test honest about the
  // thing the cancel actually matches on.
  //
  // A USER-sourced open, because only those can ever be retired: the cancel is
  // scoped to the client order ids the close's own attribution resolved, and a
  // signal-sourced mirror has no source that ever closes. The describe block
  // below pins that separately.
  const MIRROR_ORDER = "copymirror:f-1:user:trade-1";
  const MIRROR_LEG = `${MIRROR_ORDER}:tpsl:sl:87.5`;

  /** The close of the very source `MIRROR_ORDER` was mirrored from. */
  const CLOSE_OF_THIS_SOURCE = {
    followerUserId: "f-1",
    sourceItemId: "user:close-1",
    walletAddress: WALLET,
    coin: "BTC",
    attributedClientOrderIds: [MIRROR_ORDER],
  } as const;

  it("cancels the mirror's own legs and marks the plan retired", async () => {
    const harness = cancelHarness({
      rows: [{
        orderId: "order-1",
        clientOrderId: MIRROR_ORDER,
        perpProtection: plan([MIRROR_LEG]),
        perpProtectionStatus: "attached",
      }],
      openOrders: async () => [
        { coin: "BTC", oid: 501, cloid: toCloid(MIRROR_LEG) },
      ],
    });

    const result = await cancelPerpProtection(
      harness.client as never,
      CLOSE_OF_THIS_SOURCE,
      harness.deps as never,
    );

    expect(result).toMatchObject({ retired: 1, stranded: 0 });
    expect(harness.calls.cancelled).toEqual([501]);
    expect(harness.calls.marked).toEqual(["order-1"]);
  });

  it("retires the orphaned leg of a row the attach gave up on, and leaves it unprotected", async () => {
    // The attach failed, so the row says `unprotected`, but a leg the venue took
    // before the group was refused is still resting. It has to be cancellable:
    // it is reduce-only and would otherwise fire against whatever the follower
    // opens in this coin next.
    //
    // The row is NOT marked `cancelled`. `unprotected` is the one line in the
    // system that says this follower's stop never went on, and `cancelled` is
    // what hides a row from the backlog that counts them.
    const harness = cancelHarness({
      rows: [{
        orderId: "order-1",
        clientOrderId: MIRROR_ORDER,
        perpProtection: plan([MIRROR_LEG]),
        perpProtectionStatus: "unprotected",
      }],
      openOrders: async () => [
        { coin: "BTC", oid: 501, cloid: toCloid(MIRROR_LEG) },
      ],
    });

    const result = await cancelPerpProtection(
      harness.client as never,
      CLOSE_OF_THIS_SOURCE,
      harness.deps as never,
    );

    expect(result).toMatchObject({ retired: 1, stranded: 0 });
    expect(harness.calls.cancelled).toEqual([501]);
    expect(harness.calls.marked).toEqual([]);
  });

  it("leaves a stop the follower placed by hand completely alone", async () => {
    // The simple implementation (cancel every reduce-only trigger on the coin)
    // would take the follower's own stop with it. Matching by client order id is
    // what keeps this to the mirror's own orders.
    const harness = cancelHarness({
      rows: [{
        orderId: "order-1",
        clientOrderId: MIRROR_ORDER,
        perpProtection: plan([MIRROR_LEG]),
        perpProtectionStatus: "attached",
      }],
      openOrders: async () => [
        { coin: "BTC", oid: 777, cloid: toCloid("the-follower-placed-this-themselves") },
        { coin: "BTC", oid: 778, cloid: null },
      ],
    });

    const result = await cancelPerpProtection(
      harness.client as never,
      CLOSE_OF_THIS_SOURCE,
      harness.deps as never,
    );

    expect(harness.calls.cancelled).toEqual([]);
    expect(result.retired).toBe(0);
  });

  it("keeps the row attached when the cancel itself fails, so the next close tries again", async () => {
    const harness = cancelHarness({
      rows: [{
        orderId: "order-1",
        clientOrderId: MIRROR_ORDER,
        perpProtection: plan([MIRROR_LEG]),
        perpProtectionStatus: "attached",
      }],
      openOrders: async () => [{ coin: "BTC", oid: 501, cloid: toCloid(MIRROR_LEG) }],
      cancelOrder: async () => {
        throw new Error("cancel rejected");
      },
    });

    const result = await cancelPerpProtection(
      harness.client as never,
      CLOSE_OF_THIS_SOURCE,
      harness.deps as never,
    );

    expect(result.stranded).toBe(1);
    expect(harness.calls.marked).toEqual([]);
  });

  it("keeps a resolved per-item cancel error pending and lets exact cleanup recover it", async () => {
    const cleanup: PerpProtectionCleanupState[] = [];
    const marked: string[] = [];
    let cancelCalls = 0;
    const client = {
      listPositions: async () => [] as never,
      setPositionTpSl: async () => ({}) as never,
      openOrders: async () => [
        { coin: "BTC", oid: 501, cloid: toCloid(MIRROR_LEG) },
      ] as never,
      orderStatusByClientOrderId: async () => ({
        status: "order",
        order: { order: { oid: 501, coin: "BTC" }, status: "open" },
      }) as never,
      cancelOrder: async () => {
        cancelCalls += 1;
        if (cancelCalls === 1) {
          return {
            status: "ok",
            response: {
              type: "cancel",
              data: { statuses: [{ error: "order already gone" }] },
            },
          } as never;
        }
        return acceptedCancel() as never;
      },
    };
    const result = await cancelPerpProtection(
      client as never,
      CLOSE_OF_THIS_SOURCE,
      {
        loadAttachedPlans: async () => [{
          orderId: "order-1",
          clientOrderId: MIRROR_ORDER,
          perpProtection: plan([MIRROR_LEG]),
          perpProtectionStatus: "attached",
        }],
        markCancelled: async (orderId: string) => marked.push(orderId),
        recordCleanup: async (state: PerpProtectionCleanupState) => cleanup.push(state),
      } as never,
    );

    expect(result.retired).toBe(0);
    expect(result.stranded).toBe(1);
    expect(marked).toEqual([]);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]?.legClientOrderIds).toEqual([MIRROR_LEG]);

    const recovered = await retryPerpProtectionCleanup(client as never, cleanup[0]!);
    expect(recovered).toMatchObject({ retired: 1, pending: [] });
    expect(cancelCalls).toBe(2);
  });

  it("cancels a NULL protection intent before a concurrent recovery can attach it", async () => {
    const harness = cancelHarness({
      rows: [{
        orderId: "order-recovery",
        clientOrderId: "copymirror:f-1:user:trade-1",
        perpProtection: {
          copyMirrorProtectionIntent: true,
          entryPx: "",
          leverage: 0,
          sizeCoin: "",
          legClientOrderIds: [],
        } as PerpProtectionPlan,
        perpProtectionStatus: null,
      }],
      openOrders: async () => {
        throw new Error("must not read orders without deterministic legs");
      },
    });

    await cancelPerpProtection(
      harness.client as never,
      {
        followerUserId: "f-1",
        sourceItemId: "f-1-close",
        walletAddress: WALLET,
        coin: "BTC",
        attributedClientOrderIds: ["copymirror:f-1:user:trade-1"],
      },
      harness.deps as never,
    );

    expect(harness.calls.marked).toEqual(["order-recovery"]);
    expect(harness.calls.cancelled).toEqual([]);
  });

  it("never throws, whatever the venue or the database does", async () => {
    // This runs on the CLOSE path. Nothing here may become a reason an exit does
    // not go out, and the close has already been placed by the time it runs.
    const harness = cancelHarness({
      rows: [{
        orderId: "order-1",
        clientOrderId: MIRROR_ORDER,
        perpProtection: plan([MIRROR_LEG]),
        perpProtectionStatus: "attached",
      }],
      openOrders: async () => {
        throw new Error("open orders unreadable");
      },
    });

    await expect(
      cancelPerpProtection(
        harness.client as never,
        CLOSE_OF_THIS_SOURCE,
        harness.deps as never,
      ),
    ).resolves.toMatchObject({ retired: 0, stranded: 1 });
  });
});

/**
 * ONE SOURCE'S CLOSE MAY ONLY RETIRE THAT SOURCE'S LEGS.
 *
 * A follower can follow two traders in the same coin, and can hold a
 * signal-sourced mirror in it as well. Every one of those opens is a separate
 * row with its own attached plan, and only the rows attributed to the source
 * that actually closed may be retired: the rest are still live leveraged
 * positions whose stop is the only thing bounding them.
 *
 * The scope is the set of follower client order ids the close's own attribution
 * scan resolved (`loadPerpCloseContext`), not "every mirror row for this
 * follower and coin". A signal-sourced mirror can never appear in that set,
 * which is the point: it has no source that ever closes, so nothing may ever
 * pull its stop.
 */
describe("scoping a cancel to the source that actually closed", () => {
  const A_ORDER = "copymirror:f-1:user:trade-a";
  const A_LEG = `${A_ORDER}:tpsl:sl:87.5`;
  const B_ORDER = "copymirror:f-1:user:trade-b";
  const B_LEG = `${B_ORDER}:tpsl:sl:42.5`;
  const SIGNAL_ORDER = "copymirror:f-1:x_signal:1";
  const SIGNAL_LEG = `${SIGNAL_ORDER}:tpsl:sl:12.5`;

  /** Both follows and the signal mirror, all attached, all on BTC. */
  const everyRow = [
    {
      orderId: "order-a",
      clientOrderId: A_ORDER,
      perpProtection: plan([A_LEG]),
      perpProtectionStatus: "attached",
    },
    {
      orderId: "order-b",
      clientOrderId: B_ORDER,
      perpProtection: plan([B_LEG]),
      perpProtectionStatus: "attached",
    },
    {
      orderId: "order-signal",
      clientOrderId: SIGNAL_ORDER,
      perpProtection: plan([SIGNAL_LEG]),
      perpProtectionStatus: "attached",
    },
  ];

  const everyLegResting = async () => [
    { coin: "BTC", oid: 501, cloid: toCloid(A_LEG) },
    { coin: "BTC", oid: 502, cloid: toCloid(B_LEG) },
    { coin: "BTC", oid: 503, cloid: toCloid(SIGNAL_LEG) },
  ];

  it("retires only the legs of the follow whose source closed", async () => {
    // traderA closed in full. traderB's mirrored BTC position is untouched and
    // still leveraged, and the signal mirror has no exit but its own stop.
    const harness = cancelHarness({ rows: everyRow, openOrders: everyLegResting });

    const result = await cancelPerpProtection(
      harness.client as never,
      {
        followerUserId: "f-1",
        sourceItemId: "user:trade-a-close",
        walletAddress: WALLET,
        coin: "BTC",
        attributedClientOrderIds: [A_ORDER],
      },
      harness.deps as never,
    );

    expect(harness.calls.cancelled).toEqual([501]);
    expect(harness.calls.marked).toEqual(["order-a"]);
    expect(result).toMatchObject({ retired: 1, stranded: 0 });
  });

  it("never retires a signal-sourced mirror's stop on someone else's close", async () => {
    // The inversion this whole finding is about. A signal mirror has no source
    // that ever closes, so its stop is the ONLY thing that will ever exit it;
    // pulling it on an unrelated close leaves exactly the unprotected leveraged
    // position the feature exists to prevent.
    const harness = cancelHarness({ rows: everyRow, openOrders: everyLegResting });

    await cancelPerpProtection(
      harness.client as never,
      {
        followerUserId: "f-1",
        sourceItemId: "user:trade-a-close",
        walletAddress: WALLET,
        coin: "BTC",
        attributedClientOrderIds: [A_ORDER],
      },
      harness.deps as never,
    );

    expect(harness.calls.cancelled).not.toContain(503);
    expect(harness.calls.marked).not.toContain("order-signal");
  });

  it("cancels nothing when the close resolved no attributed orders", async () => {
    // Cancelling broadly is what caused the bug. Cancelling nothing leaves a
    // stale trigger over a closed position, which is a cancellable annoyance
    // rather than an unprotected leveraged position.
    const harness = cancelHarness({ rows: everyRow, openOrders: everyLegResting });

    const result = await cancelPerpProtection(
      harness.client as never,
      {
        followerUserId: "f-1",
        sourceItemId: "user:trade-a-close",
        walletAddress: WALLET,
        coin: "BTC",
        attributedClientOrderIds: [],
      },
      harness.deps as never,
    );

    expect(harness.calls.cancelled).toEqual([]);
    expect(harness.calls.marked).toEqual([]);
    expect(result).toMatchObject({ retired: 0, stranded: 0, skippedUnattributed: true });
  });

  it("cancels nothing when a row cannot say which source it came from", async () => {
    // A row with no client order id cannot be attributed, and an unattributable
    // row is not evidence it belongs to this close.
    const harness = cancelHarness({
      rows: [
        {
          orderId: "order-unknown",
          clientOrderId: null,
          perpProtection: plan([A_LEG]),
          perpProtectionStatus: "attached",
        },
      ],
      openOrders: everyLegResting,
    });

    await cancelPerpProtection(
      harness.client as never,
      {
        followerUserId: "f-1",
        sourceItemId: "user:trade-a-close",
        walletAddress: WALLET,
        coin: "BTC",
        attributedClientOrderIds: [A_ORDER],
      },
      harness.deps as never,
    );

    expect(harness.calls.cancelled).toEqual([]);
    expect(harness.calls.marked).toEqual([]);
  });
});

/**
 * Recording that a position which SHOULD carry an exit does not.
 *
 * `placePerpMirrorOrder` returns "syncing" from paths where the order is live or
 * plausibly live at the venue, and the attach is deliberately skipped on the two
 * that read nothing back from it. Skipping it SILENTLY was the defect:
 * `perp_protection_status` stayed NULL, the operator backlog counts
 * 'unprotected', and so a missing stop surfaced nowhere at all.
 */
describe("recording an exit that was never attached", () => {
  function noteHarness(loadRule: () => Promise<PerpProtectionRule | null>) {
    const calls = { unprotected: [] as string[] };
    return {
      calls,
      deps: {
        loadRule,
        recordUnprotected: async (reason: string) => {
          calls.unprotected.push(reason);
        },
      },
    };
  }

  it("writes nothing for a follow that never configured an exit", async () => {
    // OFF BY DEFAULT. Marking a row unprotected because a placement was
    // unresolved would put a perfectly healthy position on an operator's list
    // and leave it there, for a feature its owner never switched on.
    const harness = noteHarness(async () => null);

    const result = await recordPerpProtectionUnattached(
      harness.deps as never,
      "placement-syncing:open",
    );

    expect(result).toEqual({ outcome: "not-configured" });
    expect(harness.calls.unprotected).toEqual([]);
  });

  it("records the reason when the follow DID configure one", async () => {
    const harness = noteHarness(async () => RULE);

    const result = await recordPerpProtectionUnattached(
      harness.deps as never,
      "placement-syncing:resume",
    );

    expect(result).toEqual({ outcome: "recorded" });
    expect(harness.calls.unprotected).toEqual(["placement-syncing:resume"]);
  });

  it("writes nothing when the rule cannot be read, rather than guessing", async () => {
    // An unreadable rule is not evidence that one exists. Same reasoning as the
    // attach: a row is not marked unprotected on a guess.
    const harness = noteHarness(async () => {
      throw new Error("follows table unavailable");
    });

    const result = await recordPerpProtectionUnattached(
      harness.deps as never,
      "placement-syncing:open",
    );

    expect(result).toMatchObject({ outcome: "unrecorded" });
    expect(harness.calls.unprotected).toEqual([]);
  });

  it("never throws when the note itself cannot be written", async () => {
    // This runs after a placement whose order may already exist at the venue.
    await expect(
      recordPerpProtectionUnattached(
        {
          loadRule: async () => RULE,
          recordUnprotected: async () => {
            throw new Error("db down");
          },
        } as never,
        "placement-syncing:open",
      ),
    ).resolves.toMatchObject({ outcome: "unrecorded" });
  });
});
