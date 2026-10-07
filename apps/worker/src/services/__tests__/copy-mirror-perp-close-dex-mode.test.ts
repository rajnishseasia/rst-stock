/**
 * perps-05: a mirrored reduce-only CLOSE must not be gated on the follower's
 * Hyperliquid account-abstraction mode.
 *
 * `executePerpCloseMirror` calls `deps.perpDexModeReady` before placing a
 * reduce-only order and, when it resolves false, calls `deferClose`, which
 * throws EAGAIN so the delivery requeues forever instead of completing.
 * Account-abstraction mode is a COLLATERAL question: it decides which pool
 * backs NEW margin. A reduce-only order takes no new margin (Hyperliquid's
 * exchange-endpoint docs define `r: true` as an order that "will be rejected
 * if it would increase position size in the same direction"), and Hyperliquid
 * does not condition HIP-3 order placement on abstraction mode at all: the
 * margining docs describe standard-abstraction accounts holding HIP-3
 * positions, just with per-dex cross margin ("For standard abstraction,
 * cross margin only applies to the assets within the same DEX.").
 *
 * So the gate blocks an exit the venue would accept. And because reduce-only
 * closes are exempt from the delivery attempt ceiling, the block is not a
 * bounded retry: it is permanent. A follower who opened a HIP-3 position
 * while in unifiedAccount/portfolioMargin/dexAbstraction and later moves to
 * standard mode (which Hyperliquid's own docs recommend for high-volume
 * users) can never have that position mirrored-closed again.
 *
 * This test demonstrates the live defect: it is written to the CORRECT
 * behavior (a reduce-only close places even when perpDexModeReady is false)
 * and is expected to FAIL against the current source, which defers (EAGAIN)
 * instead of placing. The fix belongs in copy-mirror-perp-execution.ts
 * (removing/bypassing the perpDexModeReady gate on the three reduce-only
 * close call sites), which is outside this task's owned-files boundary; see
 * the accompanying report for the concrete recommendation.
 */

import { describe, expect, it } from "bun:test";

import { executePerpCloseMirror } from "../copy-mirror-perp-execution";

const WALLET = "0x3333333333333333333333333333333333333333" as const;

describe("perps-05: a reduce-only close must not be gated on account-abstraction mode", () => {
  const CAND = {
    followerUserId: "f-1",
    sourceItemId: "user:close-1",
    // A HIP-3 (dex-prefixed) coin: the only coins `perpDexModeReady` ever
    // gates. A main-dex coin like BTC would return true unconditionally
    // (see `requiresDexAbstraction`), so the gate would not fire and this
    // scenario would not reproduce the bug.
    symbol: "xyz:GOOGL",
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

  const makeClient = () => ({
    resolveAsset: async () => ({ szDecimals: 2, maxLeverage: 20, isDelisted: false }),
    perpAccountSnapshot: async () => ({
      // The follower's position is live and fully covers the requested
      // close: `decidePerpReduceOnlyMirror` would return `{action: "place"}`
      // for this candidate on its own. Nothing about the position or the
      // sizing is in question here, only the mode gate.
      positions: [
        { coin: "xyz:GOOGL", side: "long", size: "1.00", leverage: 3, marginMode: "cross" },
      ],
      coveredDexes: ["", "xyz"],
      crossMargin: { withdrawable: "100000", accountValue: "100000" },
    }),
    allMids: async () => ({ "xyz:GOOGL": "150" }),
  });

  let placedCount = 0;
  const makeDeps = () => ({
    // The follower has moved OUT of the shared-collateral modes (e.g. back to
    // "standard" abstraction). This is exactly the false branch that a fresh
    // OPEN must legitimately refuse: opening new HIP-3 exposure needs the
    // shared collateral pool the account is not in. A reduce-only CLOSE needs
    // nothing from that pool, so it must not be refused by the same read.
    perpDexModeReady: async () => false,
    loadPerpCloseContext: async () => ({
      sourcePositionSizeDecimal: "1",
      mirroredExposureSizeDecimal: "1",
    }),
    loadQueuedSiblingDeliveries: async () => ({ rows: [], truncated: false }),
    pairedOpenOutcomeAmbiguous: async () => false,
    placePerpMirrorOrder: async () => {
      placedCount += 1;
      return { outcome: "placed" };
    },
  });

  it("places the reduce-only close even when the account is not in a shared-collateral mode", async () => {
    placedCount = 0;
    await expect(
      executePerpCloseMirror({
        client: makeClient() as never,
        walletAddress: WALLET,
        cand: CAND as never,
        brokerCredentialId: "cred-1",
        deps: makeDeps() as never,
        perpSide: "short",
      }),
    ).resolves.toBe("placed");
    expect(placedCount).toBe(1);
  });
});
