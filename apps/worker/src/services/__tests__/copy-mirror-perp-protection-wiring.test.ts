/**
 * Where the perp exit hooks into the three execution paths, and where it must
 * NOT.
 *
 * The attach and cancel themselves are covered in
 * copy-mirror-perp-protection-attach.test.ts. What is asserted here is the
 * wiring: that protection only ever follows a placement that actually landed,
 * that it is never attached to a close, and above all that nothing it does can
 * change whether an exit goes out.
 */

import { describe, expect, it } from "bun:test";

import {
  executePerpCloseMirror,
  executePerpOpenMirror,
  resumePendingPerpMirror,
} from "../copy-mirror-perp-execution";

const WALLET = "0x5555555555555555555555555555555555555555" as const;

/**
 * The placement results this wiring reacts to, named rather than spelled inline.
 *
 * "syncing" is three different situations, and only RECOVERED_AT_VENUE proves the
 * follower is holding exposure: the placement read its own cloid back off the
 * venue and stamped the row with the broker order id. The other two know only
 * that a submission was accepted (STATUS_WRITE_FAILED) or that a rejection was
 * handed to the reconciler (LEFT_TO_RECONCILER), so neither may carry a trigger.
 */
const PLACED = { outcome: "placed" } as const;
/** A full close carries the venue's cumulative `filled.totalSz` through the adapter. */
const FULLY_FILLED_CLOSE = { outcome: "placed", filledSizeCoin: "1" } as const;
const RECOVERED_AT_VENUE = { outcome: "syncing", reason: "recovered-at-venue" } as const;
const STATUS_WRITE_FAILED = { outcome: "syncing", reason: "status-write-failed" } as const;
const LEFT_TO_RECONCILER = { outcome: "syncing", reason: "reconcile" } as const;

const OPEN_CAND = {
  followerUserId: "f-1",
  followId: "follow-1",
  sourceItemId: "x_signal:1",
  symbol: "BTC",
  side: "buy",
  sizingMode: "usd",
  sizingValue: 1_000,
  assetType: "PERP",
  perpSide: "long",
  perpLeverage: 1,
  perpMarginMode: "cross",
};

/** The mirrored open this close's attribution scan resolves back to. */
const MIRRORED_OPEN = "copymirror:f-1:user:open-1";

const CLOSE_CAND = {
  followerUserId: "f-1",
  followId: "follow-1",
  sourceItemId: "user:close-1",
  symbol: "BTC",
  side: "sell",
  sizingMode: "ratio",
  sizingValue: 1,
  assetType: "PERP",
  perpSide: "short",
  perpReduceOnly: true,
  sourceQtyDecimal: "1",
  sourcePositionSizeDecimal: "1",
  mirroredExposureSizeDecimal: "1",
};

const GUARDS = {
  dailyCap: 20,
  maxOrderDollars: 50_000,
  perpsEnabled: true,
  mainnetAllowed: false,
  liveAllowed: true,
};

function openClient() {
  return {
    resolveAsset: async () => ({
      szDecimals: 2,
      maxLeverage: 20,
      isDelisted: false,
      isolatedOnly: false,
      assetIndex: 0,
    }),
    allMids: async () => ({ BTC: "100" }),
    perpAccountSnapshot: async () => ({
      positions: [],
      coveredDexes: [""],
      crossMargin: { withdrawable: "100000", accountValue: "100000" },
    }),
    perpCollateral: async () => ({ freeUsd: "100000", accountValueUsd: "100000" }),
  };
}

function closeClient() {
  return {
    resolveAsset: async () => ({ szDecimals: 2, maxLeverage: 20, isDelisted: false }),
    perpAccountSnapshot: async () => ({
      positions: [{ coin: "BTC", side: "long", size: "1.00", leverage: 3, marginMode: "cross" }],
      coveredDexes: [""],
      crossMargin: { withdrawable: "100000", accountValue: "100000" },
    }),
    allMids: async () => ({ BTC: "100" }),
  };
}

function baseDeps(placement: unknown, overrides: Record<string, unknown> = {}) {
  const calls = {
    attach: [] as unknown[],
    cancel: [] as unknown[],
    unattached: [] as { params: unknown; reason: string }[],
  };
  const deps = {
    perpDexModeReady: async () => true,
    applyPerpLeverage: async () => true,
    countMirrorsToday: async () => 0,
    placePerpMirrorOrder: async () => placement,
    loadPerpCloseContext: async () => ({
      sourcePositionSizeDecimal: "1",
      mirroredExposureSizeDecimal: "1",
      attributedClientOrderIds: [MIRRORED_OPEN],
    }),
    loadQueuedSiblingDeliveries: async () => ({ rows: [], truncated: false }),
    pairedOpenOutcomeAmbiguous: async () => false,
    attachPerpProtection: async (_client: unknown, params: unknown) => {
      calls.attach.push(params);
    },
    cancelPerpProtection: async (_client: unknown, params: unknown) => {
      calls.cancel.push(params);
    },
    notePerpProtectionUnattached: async (params: unknown, reason: string) => {
      calls.unattached.push({ params, reason });
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("where the mirrored perp exit is attached", () => {
  it("fails closed before venue reads when raw perp cap configuration is invalid", async () => {
    let venueReads = 0;
    const client = {
      ...openClient(),
      resolveAsset: async () => {
        venueReads += 1;
        return { szDecimals: 2, maxLeverage: 20, isDelisted: false, isolatedOnly: false, assetIndex: 0 };
      },
      allMids: async () => {
        venueReads += 1;
        return { BTC: "100" };
      },
      perpAccountSnapshot: async () => {
        venueReads += 1;
        return {
          positions: [],
          coveredDexes: [""],
          crossMargin: { withdrawable: "100000", accountValue: "100000" },
        };
      },
      perpCollateral: async () => {
        venueReads += 1;
        return { freeUsd: "100000", accountValueUsd: "100000" };
      },
    };
    const { deps } = baseDeps(PLACED);

    await expect(
      executePerpOpenMirror({
        client: client as never,
        walletAddress: WALLET,
        cand: OPEN_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "long",
        guards: { ...GUARDS, perpDailyCap: null },
      }),
    ).resolves.toBe("daily-cap");
    expect(venueReads).toBe(0);
  });

  it("uses the scoped perp count when equity and reduce-only mirrors fill the generic count", async () => {
    let genericCountCalls = 0;
    let scopedCountCalls = 0;
    const { deps, calls } = baseDeps(PLACED, {
      // This count represents one generic mirror today, such as an equity
      // mirror or a reduce-only close. It must not consume the perp entry slot.
      countMirrorsToday: async () => {
        genericCountCalls += 1;
        return 1;
      },
      countPerpDailySlots: async () => {
        scopedCountCalls += 1;
        return 0;
      },
    });

    await expect(
      executePerpOpenMirror({
        client: openClient() as never,
        walletAddress: WALLET,
        cand: OPEN_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "long",
        guards: GUARDS,
      }),
    ).resolves.toBe("placed");

    expect(genericCountCalls).toBe(0);
    expect(scopedCountCalls).toBe(1);
    expect(calls.attach).toHaveLength(1);
  });

  it("hands a placed open to the protection attach, naming the follow that configured it", async () => {
    const { deps, calls } = baseDeps(PLACED);

    await expect(
      executePerpOpenMirror({
        client: openClient() as never,
        walletAddress: WALLET,
        cand: OPEN_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "long",
        guards: GUARDS,
      }),
    ).resolves.toBe("placed");

    expect(calls.attach).toHaveLength(1);
    expect(calls.attach[0]).toMatchObject({
      followerUserId: "f-1",
      followId: "follow-1",
      coin: "BTC",
      walletAddress: WALLET,
    });
  });

  it("attaches nothing when the placement did not land", async () => {
    // "syncing" is the reconciler's to settle. A trigger resting over exposure
    // that may not exist survives to fire against whatever the follower opens in
    // that coin next.
    const { deps, calls } = baseDeps(STATUS_WRITE_FAILED);

    await executePerpOpenMirror({
      client: openClient() as never,
      walletAddress: WALLET,
      cand: OPEN_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      perpSide: "long",
      guards: GUARDS,
    });

    expect(calls.attach).toEqual([]);
  });

  it("never attaches protection to a close, only retires what an open attached", async () => {
    const { deps, calls } = baseDeps(FULLY_FILLED_CLOSE);

    await expect(
      executePerpCloseMirror({
        client: closeClient() as never,
        walletAddress: WALLET,
        cand: CLOSE_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "short",
      }),
    ).resolves.toBe("placed");

    expect(calls.attach).toEqual([]);
    expect(calls.cancel).toHaveLength(1);
    expect(calls.cancel[0]).toMatchObject({ followerUserId: "f-1", coin: "BTC" });
  });

  it("leaves the legs where they are when the close itself did not land", async () => {
    // Pulling the follower's stop while their exit is unconfirmed would leave a
    // leveraged position with neither.
    const { deps, calls } = baseDeps(STATUS_WRITE_FAILED);

    await executePerpCloseMirror({
      client: closeClient() as never,
      walletAddress: WALLET,
      cand: CLOSE_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      perpSide: "short",
    });

    expect(calls.cancel).toEqual([]);
  });

  it("still reports a close as placed when retiring its legs blows up", async () => {
    // THE DOMINANT BUG CLASS ON THIS BRANCH: an exit consumed without being
    // placed, or a placed exit turned back into a queued one. The safety net
    // failing may cost the follower a stale resting trigger; it may never cost
    // them the close.
    const { deps } = baseDeps(FULLY_FILLED_CLOSE, {
      cancelPerpProtection: async () => {
        throw new Error("cancel path exploded");
      },
    });

    await expect(
      executePerpCloseMirror({
        client: closeClient() as never,
        walletAddress: WALLET,
        cand: CLOSE_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "short",
      }),
    ).resolves.toBe("placed");
  });

  it("still places a close when the protection hand-off is not wired at all", async () => {
    // The function form of `catchError` is what makes this true: evaluating the
    // call first would let a missing dep throw before any wrapper existed, and a
    // close that had already reached the venue would be requeued to go looking
    // for a position it just reduced.
    const { deps } = baseDeps(FULLY_FILLED_CLOSE);
    delete (deps as Record<string, unknown>).cancelPerpProtection;

    await expect(
      executePerpCloseMirror({
        client: closeClient() as never,
        walletAddress: WALLET,
        cand: CLOSE_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "short",
      }),
    ).resolves.toBe("placed");
  });

  it("still reports an open as placed when attaching its exit blows up", async () => {
    // The entry order is already live. Throwing would requeue a delivery whose
    // order exists and invite a second placement.
    const { deps } = baseDeps(PLACED, {
      attachPerpProtection: async () => {
        throw new Error("attach path exploded");
      },
    });

    await expect(
      executePerpOpenMirror({
        client: openClient() as never,
        walletAddress: WALLET,
        cand: OPEN_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "long",
        guards: GUARDS,
      }),
    ).resolves.toBe("placed");
  });
});

/**
 * A RESUMED close has to retire the legs a fresh close retires.
 *
 * `executePerpCloseMirror` computes `perpProtectionRetiresOnClose` and cancels.
 * A close interrupted mid-placement (row PENDING, reduce-only, no broker order
 * id) comes back through `resumePendingPerpMirror` instead, places at the venue,
 * and used to leave the legs resting: same position, same emptied exposure, but
 * a trigger left over it because of where the retry happened to re-enter. The
 * follower's next position in the coin would then meet a reduce-only stop they
 * never placed.
 */
describe("retiring the legs on a RESUMED close", () => {
  const RESUME_ROW = {
    id: "order-1",
    createdAt: new Date(Date.now() - 60 * 60_000),
    placedAt: null,
    closeAbsenceFirstSeenAt: null,
    closeAbsenceObservations: 0,
    symbol: "BTC",
    direction: "short",
    marginMode: "cross",
    quantityDecimal: "1",
    clientOrderId: "copymirror:f-1:user:close-1",
    reduceOnly: true,
    leverage: 3,
    status: "PENDING",
    brokerOrderId: null,
    brokerAccountId: WALLET,
    venueNetwork: null,
    copySourceLabel: null,
  };

  /** A live long of `size`, which is what the resume re-sizes itself against. */
  function resumeClient(size: string) {
    const positions = [
      { coin: "BTC", side: "long", size, leverage: 3, marginMode: "cross" },
    ];
    return {
      resolveAsset: async () => ({ szDecimals: 2, maxLeverage: 20, isDelisted: false }),
      perpAccountSnapshot: async () => ({
        positions,
        coveredDexes: [""],
        crossMargin: { withdrawable: "100000", accountValue: "100000" },
      }),
      listPositions: async () => positions,
      allMids: async () => ({ BTC: "100" }),
    };
  }

  function resumeDeps(exposure: string, overrides: Record<string, unknown> = {}) {
    const { deps, calls } = baseDeps(
      exposure === "1" ? FULLY_FILLED_CLOSE : { outcome: "placed", filledSizeCoin: "1" },
      {
        recordCloseAbsenceObservation: async () => {},
        recordResumeLeverageClamp: async () => {},
        loadPerpCloseContext: async () => ({
          sourcePositionSizeDecimal: "1",
          mirroredExposureSizeDecimal: exposure,
          attributedClientOrderIds: [MIRRORED_OPEN],
        }),
        ...overrides,
      },
    );
    return { deps, calls };
  }

  const resume = (deps: unknown, size: string) =>
    resumePendingPerpMirror({
      client: resumeClient(size) as never,
      walletAddress: WALLET,
      cand: CLOSE_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      existing: RESUME_ROW as never,
      guards: GUARDS as never,
    });

  it("retires the legs when the resumed close takes the whole mirrored exposure", async () => {
    const { deps, calls } = resumeDeps("1");

    await expect(resume(deps, "1.00")).resolves.toBe("placed");

    expect(calls.cancel).toHaveLength(1);
    expect(calls.cancel[0]).toMatchObject({
      followerUserId: "f-1",
      coin: "BTC",
      attributedClientOrderIds: [MIRRORED_OPEN],
    });
  });

  it("keeps the legs when the resumed close only takes part of it", async () => {
    // Same rule as the fresh path: exposure survives a partial close, and the
    // stop is the only thing bounding what survives.
    const { deps, calls } = resumeDeps("2");

    await expect(resume(deps, "2.00")).resolves.toBe("placed");

    expect(calls.cancel).toEqual([]);
  });

  it("never attaches protection to a resumed close", async () => {
    const { deps, calls } = resumeDeps("1");

    await resume(deps, "1.00");

    expect(calls.attach).toEqual([]);
  });

  it("still reports a resumed close as placed when retiring its legs blows up", async () => {
    // The dominant bug class: a placed exit turned back into a queued delivery.
    // The function form of `catchError` is what holds this, exactly as on the
    // fresh close path.
    const { deps } = resumeDeps("1", {
      cancelPerpProtection: async () => {
        throw new Error("cancel path exploded");
      },
    });

    await expect(resume(deps, "1.00")).resolves.toBe("placed");
  });

  it("still places a resumed close when the protection hand-off is not wired at all", async () => {
    const { deps } = resumeDeps("1");
    delete (deps as Record<string, unknown>).cancelPerpProtection;

    await expect(resume(deps, "1.00")).resolves.toBe("placed");
  });
});

/**
 * A "syncing" placement leaves no trigger, so it must leave a TRACE.
 *
 * `placePerpMirrorOrder` returns "syncing" from paths where the order is live or
 * plausibly live at the venue: recovered by cloid on a resume, a status write
 * that failed after Hyperliquid accepted, and the reconcile disposition on a
 * rejection. In every one of them the attach is skipped, which is the right call
 * (a trigger resting over exposure that may not exist is the resting-order hazard
 * the cancel path exists for), but nothing was recorded either: the row's
 * `perp_protection_status` stayed NULL, `emitUnprotectedPerpBacklog` filters on
 * 'unprotected', and so no operator ever saw it. The follower believes their stop
 * is live and nothing anywhere says otherwise.
 *
 * OFF BY DEFAULT still holds: the note is only written for a follow that actually
 * configured an exit, which is `recordPerpProtectionUnattached`'s job, not this
 * wiring's.
 */
describe("what a syncing placement records instead of attaching", () => {
  it("notes an unattached exit when a fresh open ends up syncing", async () => {
    const { deps, calls } = baseDeps(STATUS_WRITE_FAILED);

    await executePerpOpenMirror({
      client: openClient() as never,
      walletAddress: WALLET,
      cand: OPEN_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      perpSide: "long",
      guards: GUARDS,
    });

    expect(calls.attach).toEqual([]);
    expect(calls.unattached).toHaveLength(1);
    expect(calls.unattached[0]?.params).toMatchObject({
      followerUserId: "f-1",
      followId: "follow-1",
      coin: "BTC",
    });
    expect(calls.unattached[0]?.reason).toContain("placement-syncing");
  });

  it("records nothing extra when the open actually placed", async () => {
    // The ordinary path is untouched: the attach itself records whatever it
    // finds, and a second note would put a healthy row on an operator's list.
    const { deps, calls } = baseDeps(PLACED);

    await executePerpOpenMirror({
      client: openClient() as never,
      walletAddress: WALLET,
      cand: OPEN_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      perpSide: "long",
      guards: GUARDS,
    });

    expect(calls.unattached).toEqual([]);
  });

  it("notes nothing for a syncing CLOSE, which never had an exit to attach", async () => {
    // A close does not open exposure, so there is no unprotected position to
    // report and no row that ever expected a trigger.
    const { deps, calls } = baseDeps(STATUS_WRITE_FAILED);

    await executePerpCloseMirror({
      client: closeClient() as never,
      walletAddress: WALLET,
      cand: CLOSE_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      perpSide: "short",
    });

    expect(calls.unattached).toEqual([]);
  });

  it("notes an unattached exit when a RESUMED open ends up syncing", async () => {
    // Hyperliquid accepted the submission and the local status write then threw,
    // so nothing was read back from the venue: no order id, no confirmation of a
    // fill, and therefore nothing a trigger may be hung on. The recovered-by-cloid
    // case is the one "syncing" that DOES carry that evidence, and it is covered
    // on its own in the describe below.
    const { deps, calls } = baseDeps(STATUS_WRITE_FAILED, {
      recordResumeLeverageClamp: async () => {},
      recordCloseAbsenceObservation: async () => {},
    });

    await expect(
      resumePendingPerpMirror({
        client: {
          ...openClient(),
          listPositions: async () => [],
        } as never,
        walletAddress: WALLET,
        cand: OPEN_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        existing: {
          id: "order-2",
          createdAt: new Date(),
          placedAt: null,
          closeAbsenceFirstSeenAt: null,
          closeAbsenceObservations: 0,
          symbol: "BTC",
          direction: "long",
          marginMode: "cross",
          quantityDecimal: "1",
          clientOrderId: "copymirror:f-1:x_signal:1",
          reduceOnly: false,
          leverage: 1,
          status: "PENDING",
          brokerOrderId: null,
          brokerAccountId: WALLET,
          venueNetwork: null,
          copySourceLabel: null,
        } as never,
        guards: GUARDS as never,
      }),
    ).resolves.toBe("syncing");

    expect(calls.attach).toEqual([]);
    expect(calls.unattached).toHaveLength(1);
    expect(calls.unattached[0]?.params).toMatchObject({
      followerUserId: "f-1",
      clientOrderId: "copymirror:f-1:x_signal:1",
    });
  });

  it("still reports the open as syncing when the note itself blows up", async () => {
    // The order may be live at the venue. A failed bookkeeping write must never
    // requeue a delivery whose order already exists.
    const { deps } = baseDeps(STATUS_WRITE_FAILED, {
      notePerpProtectionUnattached: async () => {
        throw new Error("note path exploded");
      },
    });

    await expect(
      executePerpOpenMirror({
        client: openClient() as never,
        walletAddress: WALLET,
        cand: OPEN_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "long",
        guards: GUARDS,
      }),
    ).resolves.toBe("syncing");
  });
});

/**
 * "syncing" is three different situations wearing one word, and only one of them
 * proves the follower is holding exposure.
 *
 * RECOVERED AT VENUE is the proven one. The placement found its OWN cloid already
 * live at Hyperliquid, stamped the row SUBMITTED and wrote the broker order id
 * onto it, so an order under this identity demonstrably exists. That is the same
 * evidence a "placed" return carries, learned one attempt later, and the trigger
 * the follow asked for belongs on it.
 *
 * The other two prove nothing. A status write that failed AFTER the venue
 * accepted leaves the local row behind, but nothing was read back from the venue,
 * so there is no order id and no confirmation. The reconcile disposition on a
 * rejection is further still: no exposure was established at all, and the row is
 * handed to the reconciler precisely because nobody knows. A trigger over either
 * of those is the resting-order hazard the cancel path exists for, so they keep
 * recording `unprotected` instead.
 *
 * The delivery OUTCOME is unaffected in every case: all three still report
 * "syncing" upward, so what the poller marks and what it stores is unchanged.
 */
describe("attaching the exit when a placement was recovered at the venue", () => {
  /** A PENDING open row, the shape a resume re-sends. */
  const RESUMED_OPEN_ROW = {
    id: "order-recovered",
    createdAt: new Date(),
    placedAt: null,
    closeAbsenceFirstSeenAt: null,
    closeAbsenceObservations: 0,
    symbol: "BTC",
    direction: "long",
    marginMode: "cross",
    quantityDecimal: "1",
    clientOrderId: "copymirror:f-1:x_signal:1",
    reduceOnly: false,
    leverage: 1,
    status: "PENDING",
    brokerOrderId: null,
    brokerAccountId: WALLET,
    venueNetwork: null,
    copySourceLabel: null,
  };

  function resumedOpenDeps(placement: unknown) {
    return baseDeps(placement, {
      recordResumeLeverageClamp: async () => {},
      recordCloseAbsenceObservation: async () => {},
    });
  }

  const resumeOpen = (deps: unknown) =>
    resumePendingPerpMirror({
      client: { ...openClient(), listPositions: async () => [] } as never,
      walletAddress: WALLET,
      cand: OPEN_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      existing: RESUMED_OPEN_ROW as never,
      guards: GUARDS as never,
    });

  const openWith = (deps: unknown) =>
    executePerpOpenMirror({
      client: openClient() as never,
      walletAddress: WALLET,
      cand: OPEN_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      perpSide: "long",
      guards: GUARDS,
    });

  it("attaches the exit to a RESUMED open whose cloid was found live at the venue", async () => {
    const { deps, calls } = resumedOpenDeps(RECOVERED_AT_VENUE);

    await resumeOpen(deps);

    expect(calls.attach).toHaveLength(1);
    expect(calls.attach[0]).toMatchObject({
      followerUserId: "f-1",
      followId: "follow-1",
      coin: "BTC",
      clientOrderId: "copymirror:f-1:x_signal:1",
    });
    // The attach REPLACES the note here; recording a row unprotected while the
    // attach is deciding for itself would put a healthy position on the backlog.
    expect(calls.unattached).toEqual([]);
  });

  it("still reports a recovered RESUMED open as syncing, so the delivery is unchanged", async () => {
    // The one thing this whole change must not move. The poller completes the
    // delivery on whatever comes back and stores the string verbatim, so the
    // outcome has to stay exactly what it was before the reason existed.
    const { deps } = resumedOpenDeps(RECOVERED_AT_VENUE);

    await expect(resumeOpen(deps)).resolves.toBe("syncing");
  });

  it("attaches the exit to a FRESH open whose cloid was found live at the venue", async () => {
    // The same proof reaches the fresh-open path whenever the insert collides
    // with a PENDING row this cycle never saw. The evidence does not depend on
    // which call site asked.
    const { deps, calls } = baseDeps(RECOVERED_AT_VENUE);

    await expect(openWith(deps)).resolves.toBe("syncing");

    expect(calls.attach).toHaveLength(1);
    expect(calls.unattached).toEqual([]);
  });

  it("records unprotected, and attaches nothing, when only the status write failed", async () => {
    // Hyperliquid accepted, but nothing was read back: no order id, no
    // confirmation, and no evidence of a fill to hang a trigger on.
    const { deps, calls } = resumedOpenDeps(STATUS_WRITE_FAILED);

    await resumeOpen(deps);

    expect(calls.attach).toEqual([]);
    expect(calls.unattached).toHaveLength(1);
    expect(calls.unattached[0]?.reason).toBe("placement-syncing:resume");
  });

  it("records unprotected, and attaches nothing, when the rejection went to the reconciler", async () => {
    // No exposure was established at all here, so a trigger would rest over
    // nothing and survive to fire against whatever the follower opens next.
    const { deps, calls } = resumedOpenDeps(LEFT_TO_RECONCILER);

    await resumeOpen(deps);

    expect(calls.attach).toEqual([]);
    expect(calls.unattached).toHaveLength(1);
    expect(calls.unattached[0]?.reason).toBe("placement-syncing:resume");
  });

  it("records unprotected on a FRESH open whose rejection went to the reconciler", async () => {
    const { deps, calls } = baseDeps(LEFT_TO_RECONCILER);

    await openWith(deps);

    expect(calls.attach).toEqual([]);
    expect(calls.unattached).toHaveLength(1);
    expect(calls.unattached[0]?.reason).toBe("placement-syncing:open");
  });

  it("retires no legs on a recovered CLOSE, because the exit is still unconfirmed", async () => {
    // AN EXIT MUST NEVER BECOME HARDER TO PLACE THAN AN ENTRY, and the mirror
    // image of that is that nothing may be torn down on an exit that has not
    // landed. A recovered close proves an ORDER exists; it does not prove the
    // position is gone, and pulling the stop on it would leave a leveraged
    // position with neither. Only "placed" retires, exactly as before.
    const { deps, calls } = baseDeps(RECOVERED_AT_VENUE);

    await expect(
      executePerpCloseMirror({
        client: closeClient() as never,
        walletAddress: WALLET,
        cand: CLOSE_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        perpSide: "short",
      }),
    ).resolves.toBe("syncing");

    expect(calls.cancel).toEqual([]);
    expect(calls.attach).toEqual([]);
    expect(calls.unattached).toEqual([]);
  });

  it("attaches nothing to a recovered RESUMED close, which never had an exit of its own", async () => {
    // The reduce-only half of the gate is untouched: a close does not open
    // exposure, so there is nothing for a trigger to protect.
    const { deps, calls } = baseDeps(RECOVERED_AT_VENUE, {
      recordResumeLeverageClamp: async () => {},
      recordCloseAbsenceObservation: async () => {},
    });

    await expect(
      resumePendingPerpMirror({
        client: {
          resolveAsset: async () => ({ szDecimals: 2, maxLeverage: 20, isDelisted: false }),
          perpAccountSnapshot: async () => ({
            positions: [
              { coin: "BTC", side: "long", size: "1.00", leverage: 3, marginMode: "cross" },
            ],
            coveredDexes: [""],
            crossMargin: { withdrawable: "100000", accountValue: "100000" },
          }),
          listPositions: async () => [
            { coin: "BTC", side: "long", size: "1.00", leverage: 3, marginMode: "cross" },
          ],
          allMids: async () => ({ BTC: "100" }),
        } as never,
        walletAddress: WALLET,
        cand: CLOSE_CAND as never,
        brokerCredentialId: "cred-1",
        deps: deps as never,
        existing: {
          ...RESUMED_OPEN_ROW,
          id: "order-recovered-close",
          direction: "short",
          reduceOnly: true,
          leverage: 3,
          clientOrderId: "copymirror:f-1:user:close-1",
        } as never,
        guards: GUARDS as never,
      }),
    ).resolves.toBe("syncing");

    expect(calls.attach).toEqual([]);
    expect(calls.cancel).toEqual([]);
    expect(calls.unattached).toEqual([]);
  });
});
