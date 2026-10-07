import { describe, expect, it } from "bun:test";

import { validatePerpVenueNotional } from "../copy-mirror-perp-sizing";
import {
  decidePerpMirror,
  type PerpMirrorCandidate,
} from "../copy-mirror-perp-decisions";

const ETH = {
  followerUserId: "follower-eth",
  sourceItemId: "eth-reference-minimum",
  sizingMode: "usd" as const,
  sizingValue: 10,
  freeCollateralUsd: 1_000,
  accountValueUsd: 1_000,
  price: 2477.85,
  markPrice: "2477.85",
  side: "long" as const,
  leverage: 2,
  sizeDecimals: 4,
  mirrorsToday: 0,
  alreadyMirrored: false,
  dailyCap: 1,
  maxOrderDollars: 10.55,
};

function decisionCandidate(overrides: Partial<PerpMirrorCandidate> = {}): PerpMirrorCandidate {
  return { ...ETH, ...overrides };
}

describe("perp reference-price minimum notional", () => {
  it("rejects the genuine ETH size whose aggressive long limit is over $10 but mark value is under $10", () => {
    expect(validatePerpVenueNotional({
      sizeCoin: "0.0039",
      markPrice: "2477.85",
      side: "long",
      sizeDecimals: 4,
      maxOrderDollars: 10.55,
    })).toEqual({ action: "skip", reason: "below-min-notional" });
  });

  it("skips the ETH USD decision when the next mark-clearing size breaches the submitted cap", () => {
    expect(decidePerpMirror(decisionCandidate())).toMatchObject({
      action: "skip",
      reason: "below-min-notional",
    });
  });

  it("skips the equivalent SOL USD decision when the next mark-clearing size breaches the submitted cap", () => {
    expect(decidePerpMirror(decisionCandidate({
      followerUserId: "follower-sol",
      sourceItemId: "sol-reference-minimum",
      price: 105.835,
      markPrice: "105.835",
      sizeDecimals: 2,
    }))).toMatchObject({
      action: "skip",
      reason: "below-min-notional",
    });
  });

  it("places the HYPE-like size when its mark minimum and aggressive cap both fit", () => {
    const result = decidePerpMirror(decisionCandidate({
      followerUserId: "follower-hype",
      sourceItemId: "hype-reference-minimum",
      sizingValue: 10,
      price: 83.34,
      markPrice: "83.34",
      sizeDecimals: 2,
    }));

    expect(result).toMatchObject({ action: "place", sizeCoin: "0.12" });
    if (result.action === "place") {
      expect(result.orderDollars).toBeGreaterThanOrEqual(10);
      expect(result.orderDollars).toBeLessThanOrEqual(10.55);
    }
  });

  it("uses the mark for the minimum on both sides and the side-specific IOC limit for the cap", () => {
    expect(validatePerpVenueNotional({
      sizeCoin: "0.1",
      markPrice: "100",
      side: "long",
      sizeDecimals: 3,
      maxOrderDollars: 10.55,
    })).toEqual({
      action: "place",
      sizeCoin: "0.1",
      price: "105",
      notionalUsd: 10.5,
    });

    expect(validatePerpVenueNotional({
      sizeCoin: "0.1",
      markPrice: "100",
      side: "short",
      sizeDecimals: 3,
      maxOrderDollars: 10.55,
    })).toEqual({
      action: "place",
      sizeCoin: "0.1",
      price: "95",
      notionalUsd: 9.5,
    });

    expect(validatePerpVenueNotional({
      sizeCoin: "0.101",
      markPrice: "100",
      side: "long",
      sizeDecimals: 3,
      maxOrderDollars: 10.55,
    })).toEqual({ action: "skip", reason: "dollar-cap" });
  });

  it("does not upsize ratio sizing to reach the reference-price minimum", () => {
    const result = decidePerpMirror(decisionCandidate({
      sizingMode: "ratio",
      sizingValue: 1,
      sourceQtyDecimal: "0.0039",
    }));
    expect(result).toMatchObject({ action: "skip", reason: "below-min-notional" });
  });

  it("fails closed when a mark or side input is invalid", () => {
    expect(validatePerpVenueNotional({
      sizeCoin: "0.1",
      markPrice: "not-a-price",
      side: "long",
      sizeDecimals: 3,
      maxOrderDollars: 10.55,
    })).toEqual({ action: "skip", reason: "no-qty" });

    expect(validatePerpVenueNotional({
      sizeCoin: "0.1",
      markPrice: "100",
      side: "sideways" as never,
      sizeDecimals: 3,
      maxOrderDollars: 10.55,
    })).toEqual({ action: "skip", reason: "no-qty" });

    expect(decidePerpMirror(decisionCandidate({
      markPrice: "2477.8500000001",
    })).action).toBe("skip");
  });
});
