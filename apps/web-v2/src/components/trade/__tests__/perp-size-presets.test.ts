import { describe, expect, test } from "bun:test";

import {
  PERP_CAPACITY_HEADROOM,
  PERP_SIZE_PRESET_PERCENTS,
  perpPresetCoinSize,
  freeCrossCollateralUsd,
  perpPresetLabel,
  resolvePerpSizeBasis,
  type PerpSizeBasisInput,
} from "../perp-size-presets";

/** An account that can open: $1,000 free cross collateral, 2x, $100 mark. */
function openable(overrides: Partial<PerpSizeBasisInput> = {}): PerpSizeBasisInput {
  return {
    reduceOnly: false,
    position: null,
    positionsSettled: true,
    crossMargin: { accountValueUsd: "1000", totalMarginUsedUsd: "0" },
    markPrice: 100,
    leverage: 2,
    ...overrides,
  };
}

describe("resolvePerpSizeBasis: opening", () => {
  test("scales buying power by leverage", () => {
    const basis = resolvePerpSizeBasis(openable());

    expect(basis.kind).toBe("open");
    if (basis.kind !== "open") throw new Error("expected an open basis");
    // $1,000 free x 0.995 headroom x 2x leverage = $1,990 notional.
    expect(basis.maxNotionalUsd).toBeCloseTo(1000 * PERP_CAPACITY_HEADROOM * 2, 6);
    expect(basis.maxCoinSize).toBeCloseTo(19.9, 6);
    expect(basis.caption).toBe("of buying power");
  });

  test("subtracts margin another position is already holding", () => {
    // The defect this exists for. The ticket's Balance cell is TOTAL collateral,
    // so sizing off it offers a Max that Hyperliquid rejects the moment any
    // other position is open.
    const basis = resolvePerpSizeBasis(
      openable({
        crossMargin: { accountValueUsd: "1000", totalMarginUsedUsd: "600" },
      }),
    );

    if (basis.kind !== "open") throw new Error("expected an open basis");
    expect(basis.maxNotionalUsd).toBeCloseTo(400 * PERP_CAPACITY_HEADROOM * 2, 6);
  });

  test("leaves headroom so Max is fillable rather than one tick over", () => {
    const basis = resolvePerpSizeBasis(openable());

    if (basis.kind !== "open") throw new Error("expected an open basis");
    // Strictly under the un-hairccut figure: fees and slippage come out of the
    // same margin, so an exact 100% is short by the time it reaches the book.
    expect(basis.maxNotionalUsd).toBeLessThan(1000 * 2);
  });

  test("refuses to guess rather than offering a Max built on an unknown", () => {
    // Each of these would otherwise be silently treated as zero or as some
    // default, and every one of those defaults OVERSTATES what can be opened.
    const cases: Array<[Partial<PerpSizeBasisInput>, string]> = [
      [{ crossMargin: null }, "Checking your margin"],
      [{ markPrice: 0 }, "Waiting for a mark price"],
      [{ leverage: 0 }, "Waiting for leverage"],
      [
        { crossMargin: { accountValueUsd: "1000", totalMarginUsedUsd: "1000" } },
        "No free collateral",
      ],
      [
        { crossMargin: { accountValueUsd: "1000", totalMarginUsedUsd: "1200" } },
        "No free collateral",
      ],
      [
        { crossMargin: { accountValueUsd: "", totalMarginUsedUsd: "0" } },
        "Checking your margin",
      ],
    ];

    for (const [overrides, reason] of cases) {
      const basis = resolvePerpSizeBasis(openable(overrides));
      expect(basis).toEqual({ kind: "unavailable", reason });
    }
  });

  test("an unsettled positions read does not block opening on its own", () => {
    // The cross summary is what gates opening, and it rides on the same read,
    // so a caller holding it is not made to wait on a second settle flag.
    const basis = resolvePerpSizeBasis(openable({ positionsSettled: false }));
    expect(basis.kind).toBe("open");
  });
});

describe("resolvePerpSizeBasis: reducing", () => {
  test("scales the position, not the balance", () => {
    const basis = resolvePerpSizeBasis(
      openable({ reduceOnly: true, position: { size: "3.5" } }),
    );

    expect(basis).toEqual({
      kind: "reduce",
      maxCoinSize: 3.5,
      caption: "of position",
    });
  });

  test("reads a short position by magnitude", () => {
    const basis = resolvePerpSizeBasis(
      openable({ reduceOnly: true, position: { size: "-2" } }),
    );

    if (basis.kind !== "reduce") throw new Error("expected a reduce basis");
    // Selling 50% of a short means covering half of it. A negative max would
    // round to "0" and silently offer nothing.
    expect(basis.maxCoinSize).toBe(2);
  });

  test("needs no mark price or balance, because reducing is stated in coin", () => {
    const basis = resolvePerpSizeBasis(
      openable({
        reduceOnly: true,
        position: { size: "1" },
        markPrice: 0,
        crossMargin: null,
      }),
    );

    expect(basis.kind).toBe("reduce");
  });

  test("says there is nothing to reduce rather than offering a zero", () => {
    expect(
      resolvePerpSizeBasis(openable({ reduceOnly: true, position: null })),
    ).toEqual({ kind: "unavailable", reason: "No open position to reduce" });
  });

  test("a failed positions read is not evidence of no position", () => {
    // isSuccess, not isFetched. With retry off a failure is fetched too, and
    // "we could not reach Hyperliquid" must not read as "you hold nothing".
    expect(
      resolvePerpSizeBasis(
        openable({ reduceOnly: true, position: null, positionsSettled: false }),
      ),
    ).toEqual({ kind: "unavailable", reason: "Checking your position" });
  });
});

describe("perpPresetCoinSize", () => {
  const open = resolvePerpSizeBasis(openable());
  const reduce = resolvePerpSizeBasis(
    openable({ reduceOnly: true, position: { size: "3.5" } }),
  );

  test("fills a proportional share of the basis", () => {
    expect(perpPresetCoinSize(open, 50, 4)).toBe("9.95");
    expect(perpPresetCoinSize(reduce, 50, 4)).toBe("1.75");
    expect(perpPresetCoinSize(reduce, 25, 4)).toBe("0.875");
  });

  test("Max on a reduce closes the whole position exactly", () => {
    // No headroom on the closing side: a full close is a full close.
    expect(perpPresetCoinSize(reduce, 100, 4)).toBe("3.5");
  });

  test("truncates DOWN, so a chip cannot round past what backs it", () => {
    // szDecimals 2 on 19.9 x 0.75 = 14.925 -> 14.92, never 14.93.
    expect(perpPresetCoinSize(open, 75, 2)).toBe("14.92");
    expect(perpPresetCoinSize(open, 100, 0)).toBe("19");
  });

  test("returns empty rather than a zero the user did not choose", () => {
    // Below one tick at this precision. Writing "0" into the field would render
    // a size nobody picked and then fail validation on submit.
    const tiny = resolvePerpSizeBasis(
      openable({ reduceOnly: true, position: { size: "0.0001" } }),
    );
    expect(perpPresetCoinSize(tiny, 25, 2)).toBe("");
  });

  test("fills nothing when the basis is unavailable", () => {
    const basis = resolvePerpSizeBasis(openable({ crossMargin: null }));
    for (const percent of PERP_SIZE_PRESET_PERCENTS) {
      expect(perpPresetCoinSize(basis, percent, 4)).toBe("");
    }
  });
});

describe("freeCrossCollateralUsd", () => {
  test("is account value minus margin already committed", () => {
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "1000", totalMarginUsedUsd: "250.5" }),
    ).toBe(749.5);
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "1000", totalMarginUsedUsd: "0" }),
    ).toBe(1000);
  });

  test("is unknown, not zero, when the summary never arrived", () => {
    // Hyperliquid's positions read degrades this to null rather than throwing,
    // because a sizing convenience must not break a real-money positions call.
    expect(freeCrossCollateralUsd(null)).toBeNull();
  });

  test("a blank field is unknown, not zero", () => {
    // `Number("")` is 0, not NaN. A blank totalMarginUsed sailing through a
    // finite check would report every committed dollar as free.
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "1000", totalMarginUsedUsd: "" }),
    ).toBeNull();
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "  ", totalMarginUsedUsd: "0" }),
    ).toBeNull();
    expect(
      freeCrossCollateralUsd({ accountValueUsd: "abc", totalMarginUsedUsd: "0" }),
    ).toBeNull();
  });
});

describe("perpPresetLabel", () => {
  test("names 100 Max, because the headroom makes it not exactly 100", () => {
    expect(perpPresetLabel(100)).toBe("Max");
    expect(perpPresetLabel(25)).toBe("25%");
    expect(perpPresetLabel(50)).toBe("50%");
    expect(perpPresetLabel(75)).toBe("75%");
  });
});
