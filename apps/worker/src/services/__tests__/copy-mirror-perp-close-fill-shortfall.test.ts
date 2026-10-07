/**
 * Retiring the follower's stop follows what the close actually FILLED, never
 * what it asked for.
 *
 * Every mirrored perp order goes out `Market`, which Hyperliquid resolves to
 * TIF `Ioc`: it fills what it can immediately and cancels the rest. A
 * reduce-only close therefore has two independent ways of coming up short of
 * the size it requested, and only one of them was ever guarded.
 *
 *  1. THE SIZING DIMENSION, already covered by
 *     copy-mirror-perp-protection-partial-close.test.ts: the source scaled out,
 *     or the attribution ceiling clamped the close, so the REQUESTED size is
 *     smaller than the mirrored exposure and `perpProtectionRetiresOnClose`
 *     answers false.
 *
 *  2. THE FILL DIMENSION, which is what this file pins. The close requested the
 *     whole exposure, a thin book filled part of it, `sweepPerpCloseShortfall`
 *     re-submitted the remainder and that came up short too. The requested size
 *     still equals the exposure, so the retire gate answered true and cancelled
 *     the legs over a leveraged remainder the code had just measured. Nothing
 *     re-attaches afterwards, and a plan marked `cancelled` is invisible to
 *     `emitUnprotectedPerpBacklog`, which filters on `unprotected`.
 *
 * The rule: the size handed to the retire gate is the cumulative size the venue
 * POSITIVELY reported filling. An unreadable fill is unknown, not proof of a
 * full close, so protection stays attached until reconciliation confirms the
 * venue state.
 *
 * Nothing here may gate the exit itself: every case still resolves "placed".
 */
import { describe, expect, it } from "bun:test";

import { CopyMirrorPoller } from "../copy-mirror";
import {
  executePerpCloseMirror,
  resumePendingPerpMirror,
} from "../copy-mirror-perp-execution";

const WALLET = "0x5555555555555555555555555555555555555555" as const;

// ---------------------------------------------------------------------------
// The placement: what a reduce-only close reports back about its own fills
// ---------------------------------------------------------------------------

const PLACEMENT_PARAMS = {
  followerUserId: "follower-perp",
  brokerAccountId: "0x1111111111111111111111111111111111111111",
  brokerCredentialId: "11111111-1111-4111-8111-111111111111",
  coin: "BTC",
  side: "short" as const,
  sizeCoin: "1.0",
  leverage: 5,
  marginMode: "isolated" as const,
  clientOrderId: "copymirror:follower-perp:user:close-1",
  copySourceLabel: "Perp Author",
  markPrice: "100",
  sizeDecimals: 2,
  maxOrderDollars: 1_000,
  reduceOnly: true,
};
const OPEN_PLACEMENT_PARAMS = {
  ...PLACEMENT_PARAMS,
  side: "long" as const,
  reduceOnly: false,
};

type PlacePerpMirror = (
  client: unknown,
  value: typeof PLACEMENT_PARAMS | typeof OPEN_PLACEMENT_PARAMS,
) => Promise<{ outcome: string; reason?: string; filledSizeCoin?: string }>;

/** The venue's own report of one IoC leg filling `totalSz`. */
function fillResponse(totalSz: string) {
  return {
    status: "ok",
    response: {
      type: "order",
      data: { statuses: [{ filled: { totalSz, avgPx: "100", oid: 9001 } }] },
    },
  };
}

function placementPoller() {
  let nextId = 1;
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [{ id: `perp-fill-${nextId++}` }],
        }),
      }),
    }),
    // The acceptance write is a compare-and-set that must return exactly one
    // row; anything else reports the placement as an unresolved status write.
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{ id: "order-1" }] }) }),
    }),
  } as never;
  const poller = new CopyMirrorPoller(db);
  return (poller as unknown as { placePerpMirrorOrder: PlacePerpMirror })
    .placePerpMirrorOrder.bind(poller);
}

describe("what a reduce-only perp placement reports about its fills", () => {
  it("reports the cumulative filled size when both IoC legs come up short", async () => {
    // 0.3 on the primary, 0.2 on the sweep, against a 1.0 close. The sweep
    // already detects and logs this remainder; the point of the return value is
    // that the CALLER can see it too, so it does not retire the stop over 0.5
    // of live leveraged exposure.
    const responses = [fillResponse("0.3"), fillResponse("0.2")];
    let call = 0;
    const result = await placementPoller()(
      { placeOrder: async () => responses[call++] },
      PLACEMENT_PARAMS,
    );

    expect(result).toEqual({ outcome: "placed", filledSizeCoin: "0.5" });
  });

  it("reports the full size when the sweep finishes the close", async () => {
    // "1", not "1.0": `formatDecimal` trims trailing zeros, and the retire gate
    // lifts both operands to a common scale before comparing, so 1 and 1.0 are
    // recognised as the same size rather than read as a partial close.
    const responses = [fillResponse("0.3"), fillResponse("0.7")];
    let call = 0;
    const result = await placementPoller()(
      { placeOrder: async () => responses[call++] },
      PLACEMENT_PARAMS,
    );

    expect(result).toEqual({ outcome: "placed", filledSizeCoin: "1" });
  });

  it("reports the primary's own fill when the sweep's report cannot be read", async () => {
    // A positively read 0.3 is a LOWER BOUND on what filled, and the retire gate
    // only ever compares with `>=`, so a lower bound can only keep legs resting
    // that could have gone. That is this module's stated tiebreak: an unretired
    // leg is an annoyance, an unprotected leveraged position is a loss.
    const responses: unknown[] = [fillResponse("0.3"), { status: "ok" }];
    let call = 0;
    const result = await placementPoller()(
      { placeOrder: async () => responses[call++] },
      PLACEMENT_PARAMS,
    );

    expect(result).toEqual({ outcome: "placed", filledSizeCoin: "0.3" });
  });

  it("reports no filled size at all when the venue's report is unreadable", async () => {
    // UNKNOWN, not zero. Nothing was parsed, so there is no lower bound, and the
    // caller falls back to the requested size exactly as it did before this fix.
    const result = await placementPoller()(
      { placeOrder: async () => ({ status: "ok" }) },
      PLACEMENT_PARAMS,
    );

    expect(result).toEqual({ outcome: "placed" });
  });

  it("reports no filled size for an OPEN, which never sweeps", async () => {
    // Off-by-default for the other direction: an open's unfilled remainder is an
    // acceptable outcome (the follower simply opened a little less), so nothing
    // about an open placement changes.
    const result = await placementPoller()(
      { placeOrder: async () => fillResponse("0.3") },
      OPEN_PLACEMENT_PARAMS,
    );

    expect(result).toEqual({ outcome: "placed" });
  });
});

// ---------------------------------------------------------------------------
// The wiring: which size the retire gate is actually asked about
// ---------------------------------------------------------------------------

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
  // A candidate carrying its own exposure figures has to carry the attribution
  // behind them, or the retire has no scope and declines for the wrong reason.
  mirroredExposureClientOrderIds: [MIRRORED_OPEN],
};

const GUARDS = {
  dailyCap: 20,
  maxOrderDollars: 50_000,
  perpsEnabled: true,
  mainnetAllowed: false,
  liveAllowed: true,
};

/** A live long of 1.00 BTC: exactly the exposure the mirror opened. */
function closeClient() {
  const positions = [
    { coin: "BTC", side: "long", size: "1.00", leverage: 3, marginMode: "cross" },
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

function closeDeps(placement: unknown, overrides: Record<string, unknown> = {}) {
  const calls = { cancel: [] as unknown[] };
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
    attachPerpProtection: async () => {},
    cancelPerpProtection: async (_client: unknown, params: unknown) => {
      calls.cancel.push(params);
    },
    notePerpProtectionUnattached: async () => {},
    recordCloseAbsenceObservation: async () => {},
    recordResumeLeverageClamp: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

const freshClose = (deps: unknown) =>
  executePerpCloseMirror({
    client: closeClient() as never,
    walletAddress: WALLET,
    cand: CLOSE_CAND as never,
    brokerCredentialId: "cred-1",
    deps: deps as never,
    perpSide: "short",
  });

describe("retiring the legs after a close that filled short", () => {
  it("keeps the legs when the close filled less than the mirrored exposure", async () => {
    // THE BUG. Requested 1, exposure 1, so the requested-size gate answered
    // "fully closed" and cancelled the stop. 0.6 of leveraged exposure is still
    // open, nothing re-attaches, and the cancelled plan never reaches the
    // unprotected backlog an operator watches.
    const { deps, calls } = closeDeps({ outcome: "placed", filledSizeCoin: "0.4" });

    await expect(freshClose(deps)).resolves.toBe("placed");

    expect(calls.cancel).toEqual([]);
  });

  it("keeps the legs when the close filled nothing at all", async () => {
    // The worst variant: an IoC that matched no liquidity leaves the ENTIRE
    // position live, and the requested-size gate stripped its stop.
    const { deps, calls } = closeDeps({ outcome: "placed", filledSizeCoin: "0" });

    await expect(freshClose(deps)).resolves.toBe("placed");

    expect(calls.cancel).toEqual([]);
  });

  it("retires the legs when the close filled the whole mirrored exposure", async () => {
    const { deps, calls } = closeDeps({ outcome: "placed", filledSizeCoin: "1" });

    await expect(freshClose(deps)).resolves.toBe("placed");

    expect(calls.cancel).toHaveLength(1);
    expect(calls.cancel[0]).toMatchObject({
      followerUserId: "f-1",
      coin: "BTC",
      attributedClientOrderIds: [MIRRORED_OPEN],
    });
  });

  it("keeps the legs when no fill could be read", async () => {
    // UNKNOWN is not proof that the requested size filled. The close remains
    // placed, while reconciliation must confirm the venue fill or remaining
    // position before protection can be retired.
    const { deps, calls } = closeDeps({ outcome: "placed" });

    await expect(freshClose(deps)).resolves.toBe("placed");

    expect(calls.cancel).toEqual([]);
  });

  it("still places the close when the fill is short and the cancel is unwired", async () => {
    // Nothing on a close path may gate, delay or fail the order.
    const { deps } = closeDeps({ outcome: "placed", filledSizeCoin: "0.4" });
    delete (deps as Record<string, unknown>).cancelPerpProtection;

    await expect(freshClose(deps)).resolves.toBe("placed");
  });
});

/**
 * The sibling. A close interrupted mid-placement comes back through
 * `resumePendingPerpMirror`, which re-places through the SAME
 * `placePerpMirrorOrder` (and therefore the same sweep) and then runs its own
 * copy of the retire gate against its own requested size. Fixing only the fresh
 * path would reproduce this branch's other recurring pattern.
 */
describe("retiring the legs after a RESUMED close that filled short", () => {
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

  const resume = (deps: unknown) =>
    resumePendingPerpMirror({
      client: closeClient() as never,
      walletAddress: WALLET,
      cand: CLOSE_CAND as never,
      brokerCredentialId: "cred-1",
      deps: deps as never,
      existing: RESUME_ROW as never,
      guards: GUARDS as never,
    });

  it("keeps the legs when the resumed close filled less than the exposure", async () => {
    const { deps, calls } = closeDeps({ outcome: "placed", filledSizeCoin: "0.4" });

    await expect(resume(deps)).resolves.toBe("placed");

    expect(calls.cancel).toEqual([]);
  });

  it("retires the legs when the resumed close filled the whole exposure", async () => {
    const { deps, calls } = closeDeps({ outcome: "placed", filledSizeCoin: "1" });

    await expect(resume(deps)).resolves.toBe("placed");

    expect(calls.cancel).toHaveLength(1);
  });

  it("keeps the legs when the resumed close reports no fill", async () => {
    const { deps, calls } = closeDeps({ outcome: "placed" });

    await expect(resume(deps)).resolves.toBe("placed");

    expect(calls.cancel).toEqual([]);
  });
});
