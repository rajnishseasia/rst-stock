/**
 * Unit tests for the copy-mirror perp position guards.
 *
 * These decide whether an automated, leveraged order is allowed anywhere near a
 * position the follower opened themselves. The cases that matter are the ones
 * where the state is ambiguous: every one of those must resolve to a skip, never
 * to a placement.
 */

import { describe, expect, it } from "bun:test";
import { MAX_SAFE_TRADING_PERP_SIZE } from "@trade-bot/utils";
import {
  decidePerpOpenAgainstPosition,
  findPerpPosition,
  resumableStoredLeverage,
} from "../copy-mirror-perp-position-guard";

const LONG_5X_CROSS = {
  coin: "BTC",
  side: "long" as const,
  size: "2",
  leverage: 5,
  marginMode: "cross" as const,
};

describe("findPerpPosition", () => {
  it("matches the coin exactly so a HIP-3 market is never paired with the main dex", () => {
    const positions = [
      { coin: "GOOGL", side: "long" as const },
      { coin: "xyz:GOOGL", side: "short" as const },
    ];
    expect(findPerpPosition(positions, "xyz:GOOGL")?.side).toBe("short");
    expect(findPerpPosition(positions, "GOOGL")?.side).toBe("long");
  });

  it("returns null for an absent coin or an absent list", () => {
    expect(findPerpPosition([{ coin: "ETH" }], "BTC")).toBeNull();
    expect(findPerpPosition(null, "BTC")).toBeNull();
    expect(findPerpPosition(undefined, "BTC")).toBeNull();
  });
});

describe("decidePerpOpenAgainstPosition", () => {
  it("allows the open when the follower holds nothing in the coin", () => {
    expect(
      decidePerpOpenAgainstPosition({
        position: null,
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "place" });
  });

  it("refuses an open opposite a live position, which would reduce or flip it", () => {
    // Hyperliquid nets per coin: a mirrored SHORT against the follower's LONG
    // does not open a hedge, it sells their long and can invert what is left.
    expect(
      decidePerpOpenAgainstPosition({
        position: LONG_5X_CROSS,
        orderSide: "short",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "skip", reason: "opposing-position" });
  });

  it("refuses when the coin is already held at a different leverage", () => {
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, leverage: 20 },
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "skip", reason: "leverage-conflict" });
  });

  it("refuses when the coin is already held in a different margin mode", () => {
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, marginMode: "isolated" },
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "skip", reason: "leverage-conflict" });
  });

  it("allows scaling into a matching same-side position at the same leverage", () => {
    // The leverage write is a no-op here, so nothing the follower reviewed moves.
    expect(
      decidePerpOpenAgainstPosition({
        position: LONG_5X_CROSS,
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "place" });
  });

  it("treats a zero-size row as flat", () => {
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, size: "0", leverage: 20 },
        orderSide: "short",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "place" });
  });

  it("accepts the shared safe boundary and refuses the first over-boundary size", () => {
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, size: MAX_SAFE_TRADING_PERP_SIZE },
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "place" });
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, size: "90071992.54740992" },
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "skip", reason: "position-unreadable" });
  });

  it("refuses rather than assuming flat when the size cannot be read", () => {
    for (const size of ["", "   ", "n/a", "NaN"]) {
      expect(
        decidePerpOpenAgainstPosition({
          position: { ...LONG_5X_CROSS, size },
          orderSide: "long",
          leverage: 5,
          marginMode: "cross",
        }),
      ).toEqual({ action: "skip", reason: "position-unreadable" });
    }
  });

  it("refuses when a live position reports an unusable leverage or margin mode", () => {
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, leverage: Number.NaN },
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "skip", reason: "position-unreadable" });
    expect(
      decidePerpOpenAgainstPosition({
        position: { ...LONG_5X_CROSS, marginMode: "portfolio" as never },
        orderSide: "long",
        leverage: 5,
        marginMode: "cross",
      }),
    ).toEqual({ action: "skip", reason: "position-unreadable" });
  });
});

describe("resumableStoredLeverage", () => {
  it("returns the stored integer leverage", () => {
    expect(resumableStoredLeverage(3)).toBe(3);
    expect(resumableStoredLeverage(1)).toBe(1);
  });

  it("returns null rather than inventing 1x for a missing or invalid value", () => {
    // `existing.leverage ?? 1` let a retry proceed on a leverage the clamp never
    // produced, and leverage is not carried on the order itself.
    expect(resumableStoredLeverage(null)).toBeNull();
    expect(resumableStoredLeverage(undefined)).toBeNull();
    expect(resumableStoredLeverage(0)).toBeNull();
    expect(resumableStoredLeverage(-3)).toBeNull();
    expect(resumableStoredLeverage(2.5)).toBeNull();
    expect(resumableStoredLeverage(Number.NaN)).toBeNull();
  });
});
