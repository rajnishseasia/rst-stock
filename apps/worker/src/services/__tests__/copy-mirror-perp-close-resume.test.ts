/**
 * Resuming a reduce-only close whose first submission is unresolved.
 *
 * The row is PENDING with no broker order id, so the first attempt either
 * filled or never left the process, and nothing on the row distinguishes them.
 * An empty position read means different things in those two worlds: in the
 * first there is genuinely nothing left to exit, in the second the position is
 * still open and the read is simply wrong. Consuming the close on the second
 * strands the follower in a leveraged position with their only exit spent.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { resumePendingPerpMirror } from "../copy-mirror-perp-execution";

const copyMirrorSource = readFileSync(
  new URL("../copy-mirror.ts", import.meta.url),
  "utf8",
);

const WALLET = "0x1111111111111111111111111111111111111111" as const;

type Position = { coin: string; side: "long" | "short"; size: string; leverage?: number };

const makeClient = (positions: Position[]) => ({
  resolveAsset: async () => ({ szDecimals: 3, maxLeverage: 20, isDelisted: false }),
  // "" is the dex name for a non-namespaced coin, so this snapshot COVERS BTC.
  // An uncovered read is a different refusal with its own tests.
  perpAccountSnapshot: async () => ({
    positions,
    coveredDexes: [""],
    crossMargin: { withdrawable: "100000", accountValue: "100000" },
  }),
  listPositions: async () => positions,
  allMids: async () => ({ BTC: "50000" }),
});

/** Longer ago than CLOSE_ABSENCE_CONFIRM_MS. */
const LONG_AGO = new Date(Date.now() - 60 * 60_000);

const EXISTING = {
  id: "order-1",
  createdAt: LONG_AGO,
  placedAt: null,
  // A streak already long enough and deep enough to confirm, so tests that are
  // not about the streak do not have to build one. Two prior reads plus the one
  // the resume itself takes meets the three-observation bar.
  closeAbsenceFirstSeenAt: LONG_AGO,
  closeAbsenceObservations: 2,
  symbol: "BTC",
  direction: "short",
  marginMode: "cross",
  quantityDecimal: "0.5",
  clientOrderId: "copymirror:f-1:user:close-1",
  reduceOnly: true,
  leverage: 5,
  status: "PENDING",
  brokerOrderId: null,
  brokerAccountId: WALLET,
  venueNetwork: null,
  copySourceLabel: null,
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
};

/** Every recordCloseAbsenceObservation call, so the streak writes are visible. */
const absenceWrites: Array<Date | null> = [];

const makeDeps = (overrides: Record<string, unknown> = {}) => ({
  perpDexModeReady: async () => true,
  recordCloseAbsenceObservation: async (_id: string, at: Date | null) => {
    absenceWrites.push(at);
  },
  applyPerpLeverage: async () => true,
  placePerpMirrorOrder: async () => ({ outcome: "placed" }),
  recordResumeLeverageClamp: async () => {},
  loadPerpCloseContext: async () => ({
    sourcePositionSizeDecimal: "1",
    mirroredExposureSizeDecimal: "0.5",
  }),
  loadQueuedSiblingDeliveries: async () => ({ rows: [], truncated: false }),
  pairedOpenOutcomeAmbiguous: async () => false,
  countMirrorsToday: async () => 0,
  ...overrides,
});

const resume = (
  positions: Position[],
  extra: Record<string, unknown> = {},
  existing: Record<string, unknown> = {},
) =>
  resumePendingPerpMirror({
    client: makeClient(positions) as never,
    walletAddress: WALLET,
    cand: CAND as never,
    brokerCredentialId: "cred-1",
    deps: makeDeps() as never,
    existing: { ...EXISTING, ...existing } as never,
    guards: {
      perpsEnabled: true,
      mainnetAllowed: true,
      liveAllowed: true,
      maxOrderDollars: 100000,
      dailyCap: 100,
    } as never,
    ...extra,
  });

describe("perp close resume: an empty position read is not an answer on its own", () => {
  it("prefers exact source order links and scopes legacy broker-id fallbacks", () => {
    expect(copyMirrorSource).toContain("inArray(schema.socialTrades.orderId, sourceOrderIds)");
    expect(copyMirrorSource).toContain("trade.orderId && exactSourceOrderIds.has(trade.orderId)");
    expect(copyMirrorSource).toContain("legacySourceBrokerIds");
    expect(copyMirrorSource).toContain("brokerCredentialId");
    expect(copyMirrorSource).toContain("venue");
  });

  it("HOLDS the close when the first submission is still unresolved", async () => {
    // The row is PENDING with no broker order id, so this read cannot tell a
    // filled close from one that never reached the venue. Retiring here would
    // complete the one-shot delivery, and if the reconciler then cancels the
    // row (never placed), nothing would ever exit the position again.
    await expect(resume([])).rejects.toMatchObject({ code: "EAGAIN" });
  });

  it("CONSUMES the close once the order is proven absent AND the position has stayed gone", async () => {
    // Both conditions together. The revival is the reconciler confirming the
    // venue never saw the close, and the row's age means the empty position
    // read has been taken repeatedly across separate reconciler cycles rather
    // than once. That combination is what stops the hold from wedging: without
    // a way out, the reconciler would cancel, the caller would revive, this
    // would hold, and round again every poll forever.
    await expect(resume([], { revivedFromCancelledClose: true })).resolves.toBe(
      "no-position",
    );
  });

  it("still HOLDS a revived row on its FIRST empty read, and starts the streak", async () => {
    // The revival proves only that the CLOSE never reached the venue. The
    // OPENING position is the thing at stake, and a snapshot that transiently
    // omits it passes the revival test while the exposure is still live. One
    // read is one read, whatever else is true about the row.
    absenceWrites.length = 0;
    await expect(
      resume(
        [],
        { revivedFromCancelledClose: true },
        { closeAbsenceFirstSeenAt: null, closeAbsenceObservations: 0 },
      ),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    expect(absenceWrites).toEqual([expect.any(Date)]);
  });

  it("does not let a QUIET INTERVAL stand in for looking", async () => {
    // The case both time-based versions got wrong. Mirroring is switched off
    // after the ambiguous close, the reconciler cancels the row, and it comes
    // back an hour later: the row is old, the first-seen stamp is old, and
    // exactly one read stands behind either. Only a count notices.
    absenceWrites.length = 0;
    await expect(
      resume(
        [],
        { revivedFromCancelledClose: true },
        {
          createdAt: LONG_AGO,
          placedAt: LONG_AGO,
          closeAbsenceFirstSeenAt: LONG_AGO,
          closeAbsenceObservations: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    // Still recorded: the streak has to keep advancing across the holds, or it
    // never reaches the bar.
    expect(absenceWrites).toEqual([expect.any(Date)]);
  });

  it("holds when there are enough reads but they span no time", async () => {
    // The other half of the bar. Three reads inside a few seconds are three
    // looks at one lagging snapshot.
    await expect(
      resume(
        [],
        { revivedFromCancelledClose: true },
        {
          closeAbsenceFirstSeenAt: new Date(Date.now() - 30_000),
          closeAbsenceObservations: 5,
        },
      ),
    ).rejects.toMatchObject({ code: "EAGAIN" });
  });

  it("HOLDS rather than placing when the streak cannot be cleared", async () => {
    // Proceeding here was the earlier reading, on the grounds that a failed
    // clear "only leaves the row confirming sooner than it should have". That
    // followed the path where the placement succeeds. If it fails transiently
    // the delivery comes back carrying observations taken BEFORE the position
    // was confirmed live, and a later lagging snapshot adds the third and
    // retires the close over exposure that never went anywhere.
    let placed = 0;
    await expect(
      resumePendingPerpMirror({
        client: makeClient([{ coin: "BTC", side: "long", size: "0.5", leverage: 5 }]) as never,
        walletAddress: WALLET,
        cand: CAND as never,
        brokerCredentialId: "cred-1",
        deps: {
          ...makeDeps(),
          recordCloseAbsenceObservation: async () => {
            throw new Error("db down");
          },
          placePerpMirrorOrder: async () => {
            placed += 1;
            return { outcome: "placed" };
          },
        } as never,
        existing: EXISTING as never,
        guards: {
          perpsEnabled: true,
          mainnetAllowed: true,
          liveAllowed: true,
          maxOrderDollars: 100000,
          dailyCap: 100,
        } as never,
      }),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    expect(placed).toBe(0);
  });

  it("CLEARS the streak when a position is seen again", async () => {
    // Otherwise empty reads either side of a live one would accumulate into one
    // streak and retire on it.
    absenceWrites.length = 0;
    await expect(
      resume([{ coin: "BTC", side: "long", size: "0.5", leverage: 5 }]),
    ).resolves.toBe("placed");
    expect(absenceWrites).toEqual([null]);
  });

  it("still consumes on wrong-side without any revival", async () => {
    // A position IS present in this reading, just the other way, so the
    // snapshot is not the blank one the hold is about. Holding here would
    // requeue a close that can never apply.
    await expect(
      resume([{ coin: "BTC", side: "short", size: "0.5", leverage: 5 }]),
    ).resolves.toBe("wrong-side");
  });

  it("still places when the position is actually there", async () => {
    // The hold must not touch the ordinary path: a resume that finds its
    // position still open places the close as before.
    await expect(
      resume([{ coin: "BTC", side: "long", size: "0.5", leverage: 5 }]),
    ).resolves.toBe("placed");
  });

  it("places a reduce-only resume even when the account is not dex-mode ready", async () => {
    // perpDexModeReady exists to gate NEW exposure: it decides which pooled
    // ledger a HIP-3 open would draw its collateral from. A reduce-only
    // resume commits no collateral (it releases it), and Hyperliquid itself
    // refuses a reduce-only order that would increase position size in the
    // same direction, so the venue is the backstop, not this gate. Deferring
    // here strands the follower's exit forever the moment their account is
    // out of the abstraction mode this check demands, exactly the bug the
    // fresh close path (executePerpCloseMirror) was already fixed to avoid.
    await expect(
      resumePendingPerpMirror({
        client: makeClient([{ coin: "BTC", side: "long", size: "0.5", leverage: 5 }]) as never,
        walletAddress: WALLET,
        cand: CAND as never,
        brokerCredentialId: "cred-1",
        deps: {
          ...makeDeps(),
          perpDexModeReady: async () => false,
        } as never,
        existing: EXISTING as never,
        guards: {
          perpsEnabled: true,
          mainnetAllowed: true,
          liveAllowed: true,
          maxOrderDollars: 100000,
          dailyCap: 100,
        } as never,
      }),
    ).resolves.toBe("placed");
  });
});
