/**
 * perps-11: a mirrored reduce-only close below Hyperliquid's $10 minimum order
 * value must never be submitted, and it must never be treated as a close that
 * found "nothing to reduce" either.
 *
 * `decidePerpReduceOnlyMirror` used to clamp a copied close to the mirrored
 * exposure and the live position with no notional check at all, unlike the
 * open path's `decidePerpMirror`. A partial source close that proportions
 * down to a few dollars would be submitted anyway, Hyperliquid would reject
 * it, and that rejection is classified terminal downstream: the delivery
 * completes and the follower's one-shot exit is gone.
 *
 * Hyperliquid documents no reduce-only exemption from the minimum (its
 * "Error responses" page lists "Order must have minimum value of $10." with
 * no reduce-only carve-out and the only reduce-only error it documents is
 * "Reduce only order would increase position."), so a below-minimum close can
 * never be placed as-is. The fix is therefore not a new terminal skip: it is
 * a defer, exactly like every other refusal on this path (dex mismatch,
 * position-absence streak, a queued sibling open). No order is placed, and
 * nothing is consumed.
 */

import { describe, expect, it } from "bun:test";

import { decidePerpReduceOnlyMirror } from "../copy-mirror-perp-decisions";
import { executePerpCloseMirror } from "../copy-mirror-perp-execution";

const WALLET = "0x2222222222222222222222222222222222222222" as const;

describe("decidePerpReduceOnlyMirror: venue minimum notional", () => {
  const base = {
    sizingMode: "ratio" as const,
    sizingValue: 1,
    orderSide: "short" as const,
    sizeDecimals: 8,
    position: { side: "long" as const, size: "0.00100000" },
  };

  it("skips below the venue minimum instead of placing a doomed order", () => {
    // 0.00005 BTC at the $100,000 mark is $5, below the venue's $10 floor.
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourceSizeDecimal: "0.00005",
        mirroredExposureSizeDecimal: "0.001",
        markPrice: 100_000,
      }),
    ).toEqual({ action: "skip", reason: "below-min-notional" });
  });

  it("places normally once the size clears the minimum", () => {
    // 0.001 BTC at the $100,000 mark is $100, comfortably above $10.
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourceSizeDecimal: "0.001",
        mirroredExposureSizeDecimal: "0.001",
        markPrice: 100_000,
      }),
    ).toEqual({ action: "place", sizeCoin: "0.001" });
  });

  it("fails closed when the exact mark is just below the venue minimum", () => {
    // JavaScript multiplication rounds this boundary upward to $10. Exact
    // decimal arithmetic must keep the $9.999999999999999 mark notional below
    // the venue floor, so the close is deferred rather than placed.
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourceSizeDecimal: "0.1",
        mirroredExposureSizeDecimal: "0.1",
        position: { side: "long", size: "0.1" },
        markPrice: "99.99999999999999",
      }),
    ).toEqual({ action: "skip", reason: "below-min-notional" });
  });

  it("fails closed when the mark price could not be read", () => {
    // null is a deliberate "unknown", not "no check": guessing the size is
    // safe here would risk the same lost exit the check exists to prevent.
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourceSizeDecimal: "0.001",
        mirroredExposureSizeDecimal: "0.001",
        markPrice: null,
      }),
    ).toEqual({ action: "skip", reason: "below-min-notional" });
  });

  it("skips the check entirely for callers that never priced the close (backward compatible)", () => {
    // `markPrice` omitted, not null: existing callers/tests that never priced
    // a close keep their pre-fix behavior rather than failing closed on a
    // field they never populated.
    expect(
      decidePerpReduceOnlyMirror({
        ...base,
        sourceSizeDecimal: "0.00005",
        mirroredExposureSizeDecimal: "0.001",
      }),
    ).toEqual({ action: "place", sizeCoin: "0.00005" });
  });
});

describe("executePerpCloseMirror: a below-minimum close is deferred, never consumed", () => {
  const CAND = {
    followerUserId: "f-1",
    sourceItemId: "user:close-1",
    symbol: "BTC",
    side: "sell",
    sizingMode: "ratio",
    sizingValue: 1,
    assetType: "PERP",
    perpSide: "short",
    perpReduceOnly: true,
    sourceQtyDecimal: "0.00005",
    sourcePositionSizeDecimal: "0.001",
    mirroredExposureSizeDecimal: "0.001",
  };

  const makeClient = (mids: Record<string, string>) => ({
    resolveAsset: async () => ({ szDecimals: 8, maxLeverage: 20, isDelisted: false }),
    perpAccountSnapshot: async () => ({
      positions: [{ coin: "BTC", side: "long", size: "0.00100000", leverage: 5, marginMode: "cross" }],
      coveredDexes: [""],
      crossMargin: { withdrawable: "100000", accountValue: "100000" },
    }),
    allMids: async () => mids,
  });

  let placedCount = 0;
  const makeDeps = () => ({
    perpDexModeReady: async () => true,
    loadPerpCloseContext: async () => ({
      sourcePositionSizeDecimal: "0.001",
      mirroredExposureSizeDecimal: "0.001",
    }),
    loadQueuedSiblingDeliveries: async () => ({ rows: [], truncated: false }),
    pairedOpenOutcomeAmbiguous: async () => false,
    placePerpMirrorOrder: async () => {
      placedCount += 1;
      return { outcome: "placed" };
    },
  });

  it("defers (EAGAIN) rather than completing the delivery, and places no order", async () => {
    placedCount = 0;
    await expect(
      executePerpCloseMirror({
        client: makeClient({ BTC: "100000" }) as never,
        walletAddress: WALLET,
        cand: CAND as never,
        brokerCredentialId: "cred-1",
        deps: makeDeps() as never,
        perpSide: "short",
      }),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    expect(placedCount).toBe(0);
  });

  it("still defers when the mark price cannot be read at all", async () => {
    placedCount = 0;
    await expect(
      executePerpCloseMirror({
        client: makeClient({}) as never, // no BTC entry in allMids
        walletAddress: WALLET,
        cand: CAND as never,
        brokerCredentialId: "cred-1",
        deps: makeDeps() as never,
        perpSide: "short",
      }),
    ).rejects.toMatchObject({ code: "EAGAIN" });
    expect(placedCount).toBe(0);
  });

  it("places normally once the mirrored exposure clears the minimum", async () => {
    placedCount = 0;
    const bigCand = {
      ...CAND,
      sourceQtyDecimal: "0.001",
      sourcePositionSizeDecimal: "0.001",
      mirroredExposureSizeDecimal: "0.001",
    };
    await expect(
      executePerpCloseMirror({
        client: makeClient({ BTC: "100000" }) as never,
        walletAddress: WALLET,
        cand: bigCand as never,
        brokerCredentialId: "cred-1",
        deps: makeDeps() as never,
        perpSide: "short",
      }),
    ).resolves.toBe("placed");
    expect(placedCount).toBe(1);
  });
});
