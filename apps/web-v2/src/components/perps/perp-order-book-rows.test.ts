/**
 * Unit cover for the order-book ladder math.
 *
 * The component that renders this is a table with no arithmetic in it, so the
 * things that can actually be wrong live here: the running cumulative totals,
 * the shared depth normalization across both sides, the mid/spread derivation
 * and what happens when a side is empty or a level is unpriceable.
 */

import { describe, expect, it } from "bun:test";

import {
  buildPerpBookLadder,
  formatPerpBookSpread,
  type PerpBookInput,
} from "./perp-order-book-rows";

const book = (
  bids: Array<[string, string]>,
  asks: Array<[string, string]>,
): PerpBookInput => ({
  bids: bids.map(([px, sz], i) => ({ px, sz, n: i + 1 })),
  asks: asks.map(([px, sz], i) => ({ px, sz, n: i + 1 })),
});

describe("buildPerpBookLadder", () => {
  it("accumulates size and notional down each side, best price first", () => {
    const ladder = buildPerpBookLadder(
      book(
        [
          ["100", "2"],
          ["99", "3"],
        ],
        [
          ["101", "1"],
          ["102", "4"],
        ],
      ),
      12,
    );

    expect(ladder.bids.map((row) => row.px)).toEqual(["100", "99"]);
    expect(ladder.bids.map((row) => row.cumulativeSize)).toEqual([2, 5]);
    // 2*100 = 200, then + 3*99 = 497: each level is valued at its OWN price.
    expect(ladder.bids.map((row) => row.cumulativeNotional)).toEqual([200, 497]);

    expect(ladder.asks.map((row) => row.px)).toEqual(["101", "102"]);
    expect(ladder.asks.map((row) => row.cumulativeSize)).toEqual([1, 5]);
    expect(ladder.asks.map((row) => row.cumulativeNotional)).toEqual([101, 509]);
  });

  it("normalizes the depth bars against the deepest side, not each side", () => {
    const ladder = buildPerpBookLadder(
      book(
        [
          ["100", "2"],
          ["99", "8"],
        ],
        [["101", "1"]],
      ),
      12,
    );

    // Deepest cumulative across both sides is the bid side's 10.
    expect(ladder.bids.map((row) => row.depthRatio)).toEqual([0.2, 1]);
    // The single ask is 1/10, NOT 1/1: a thin side must look thin.
    expect(ladder.asks[0]?.depthRatio).toBe(0.1);
  });

  it("derives mid, spread and spread bps from the top of book", () => {
    const ladder = buildPerpBookLadder(book([["99", "1"]], [["101", "1"]]), 12);
    expect(ladder.bestBid).toBe(99);
    expect(ladder.bestAsk).toBe(101);
    expect(ladder.mid).toBe(100);
    expect(ladder.spread).toBe(2);
    expect(ladder.spreadBps).toBe(200);
  });

  it("leaves mid and spread null when only one side has depth", () => {
    const ladder = buildPerpBookLadder(book([["99", "1"]], []), 12);
    expect(ladder.bestBid).toBe(99);
    expect(ladder.bestAsk).toBeNull();
    expect(ladder.mid).toBeNull();
    expect(ladder.spread).toBeNull();
    expect(ladder.spreadBps).toBeNull();
    expect(ladder.isEmpty).toBe(false);
  });

  it("reports an empty book for a missing payload or two empty sides", () => {
    expect(buildPerpBookLadder(undefined, 12).isEmpty).toBe(true);
    expect(buildPerpBookLadder(null, 12).isEmpty).toBe(true);
    expect(buildPerpBookLadder(book([], []), 12).isEmpty).toBe(true);
    // A zero deepest total must not produce NaN depth ratios anywhere.
    expect(buildPerpBookLadder(book([], []), 12).bids).toEqual([]);
  });

  it("skips unpriceable levels instead of rendering them as zero rows", () => {
    const ladder = buildPerpBookLadder(
      book(
        [
          ["", "1"],
          ["0", "1"],
          ["98", "2"],
        ],
        [["not-a-number", "1"]],
      ),
      12,
    );
    expect(ladder.bids.map((row) => row.px)).toEqual(["98"]);
    expect(ladder.asks).toEqual([]);
    expect(ladder.bestBid).toBe(98);
  });

  it("keeps sub-cent precision by carrying HL's raw price string through", () => {
    const ladder = buildPerpBookLadder(book([["0.0027119", "1000"]], []), 12);
    // The click target is the raw string, not a re-rendered display value.
    expect(ladder.bids[0]?.px).toBe("0.0027119");
    expect(ladder.bids[0]?.cumulativeNotional).toBeCloseTo(2.7119, 6);
  });

  it("caps each side at maxRows after unusable levels are dropped", () => {
    const many = Array.from({ length: 20 }, (_unused, i): [string, string] => [
      String(100 - i),
      "1",
    ]);
    const ladder = buildPerpBookLadder(book(many, many), 4);
    expect(ladder.bids).toHaveLength(4);
    expect(ladder.asks).toHaveLength(4);
    expect(buildPerpBookLadder(book(many, many), 0).bids).toHaveLength(1);
  });
});

describe("formatPerpBookSpread", () => {
  it("states the absolute spread and the same figure in basis points", () => {
    expect(formatPerpBookSpread(2, 200)).toBe("2.00 (200.0 bps)");
  });

  it("widens bps precision for a tight spread", () => {
    expect(formatPerpBookSpread(0.01, 1.234)).toBe("0.01 (1.23 bps)");
  });

  it("renders a dash for a one-sided book", () => {
    expect(formatPerpBookSpread(null, null)).toBe("-");
  });

  it("falls back to the absolute spread when bps is not computable", () => {
    expect(formatPerpBookSpread(0.5, null)).toBe("0.50");
  });
});
