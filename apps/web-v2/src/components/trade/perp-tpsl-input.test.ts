import { describe, expect, test } from "bun:test";

import {
  derivePerpTriggerPrice,
  derivePerpTriggerValue,
  isPerpTriggerDirectionValid,
  normalizePerpDecimalInput,
  triggerPriceToInput,
} from "./perp-tpsl-input";

describe("derivePerpTriggerPrice", () => {
  test("keeps a positive exact trigger price", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "price",
        kind: "stopLoss",
        side: "long",
        value: 475.5,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(475.5);
  });

  test("derives long stop and target prices from a percent move", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "percent",
        kind: "stopLoss",
        side: "long",
        value: 10,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(450);
    expect(
      derivePerpTriggerPrice({
        mode: "percent",
        kind: "takeProfit",
        side: "long",
        value: 10,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(550);
  });

  test("reverses percent directions for a short position", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "percent",
        kind: "stopLoss",
        side: "short",
        value: 10,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(550);
    expect(
      derivePerpTriggerPrice({
        mode: "percent",
        kind: "takeProfit",
        side: "short",
        value: 10,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(450);
  });

  test("derives ROE targets from the position's current margin", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "roePercent",
        kind: "stopLoss",
        side: "long",
        value: 5,
        entryPrice: 500,
        size: 0.2,
        marginUsed: 10,
      }),
    ).toBe(497.5);
    expect(
      derivePerpTriggerPrice({
        mode: "roePercent",
        kind: "takeProfit",
        side: "short",
        value: 5,
        entryPrice: 500,
        size: 0.2,
        marginUsed: 10,
      }),
    ).toBe(497.5);
  });

  test("rejects an ROE target when current margin is unavailable", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "roePercent",
        kind: "stopLoss",
        side: "long",
        value: 5,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBeNull();
  });

  test("calculates the leveraged ONDO position stop from current margin", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "roePercent",
        kind: "stopLoss",
        side: "long",
        value: 5,
        entryPrice: 0.42313,
        size: 236,
        marginUsed: 9.84,
      }),
    ).toBeCloseTo(0.421045254237, 11);
  });

  test("converts a position-level dollar P&L amount into trigger prices", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "pnlUsd",
        kind: "stopLoss",
        side: "long",
        value: 40,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(300);
    expect(
      derivePerpTriggerPrice({
        mode: "pnlUsd",
        kind: "takeProfit",
        side: "short",
        value: 40,
        entryPrice: 500,
        size: 0.2,
      }),
    ).toBe(300);
  });

  test("rejects unusable values and non-positive derived prices", () => {
    expect(
      derivePerpTriggerPrice({
        mode: "percent",
        kind: "stopLoss",
        side: "long",
        value: 0,
        entryPrice: 500,
        size: 1,
      }),
    ).toBeNull();
    expect(
      derivePerpTriggerPrice({
        mode: "pnlUsd",
        kind: "stopLoss",
        side: "long",
        value: 600,
        entryPrice: 500,
        size: 1,
      }),
    ).toBeNull();
  });
});

describe("perp trigger input normalization", () => {
  test("adds the leading zero required by the API", () => {
    expect(normalizePerpDecimalInput(".0828")).toBe("0.0828");
    expect(normalizePerpDecimalInput("  .5 ")).toBe("0.5");
  });

  test("removes an unfinished trailing decimal point", () => {
    expect(normalizePerpDecimalInput("12.")).toBe("12");
  });
});

describe("derivePerpTriggerValue", () => {
  test("recalculates dollar loss when position size changes", () => {
    expect(
      derivePerpTriggerValue({
        mode: "pnlUsd",
        triggerPrice: 90,
        entryPrice: 100,
        size: 10,
      }),
    ).toBe(100);
    expect(
      derivePerpTriggerValue({
        mode: "pnlUsd",
        triggerPrice: 90,
        entryPrice: 100,
        size: 20,
      }),
    ).toBe(200);
  });

  test("converts the same price distance to percent", () => {
    expect(
      derivePerpTriggerValue({
        mode: "percent",
        triggerPrice: 90,
        entryPrice: 100,
        size: 20,
      }),
    ).toBe(10);
  });
});

describe("perp trigger direction", () => {
  test("requires protective triggers on the correct side of the current market", () => {
    expect(isPerpTriggerDirectionValid("stopLoss", "long", 110, 120)).toBe(true);
    expect(isPerpTriggerDirectionValid("takeProfit", "long", 125, 120)).toBe(true);
    expect(isPerpTriggerDirectionValid("stopLoss", "short", 130, 120)).toBe(true);
    expect(isPerpTriggerDirectionValid("takeProfit", "short", 115, 120)).toBe(true);
    expect(isPerpTriggerDirectionValid("stopLoss", "long", 125, 120)).toBe(false);
  });

  test("allows profit protection and partial-recovery targets across entry", () => {
    // Long entered at 100, now 120: a stop at 110 locks in profit.
    expect(isPerpTriggerDirectionValid("stopLoss", "long", 110, 120)).toBe(true);
    // Long entered at 100, now 80: a target at 90 exits on partial recovery.
    expect(isPerpTriggerDirectionValid("takeProfit", "long", 90, 80)).toBe(true);
    // Short entered at 100, now 80: a stop at 90 locks in profit.
    expect(isPerpTriggerDirectionValid("stopLoss", "short", 90, 80)).toBe(true);
    // Short entered at 100, now 120: a target at 110 exits on partial recovery.
    expect(isPerpTriggerDirectionValid("takeProfit", "short", 110, 120)).toBe(true);
  });

  test("formats computed prices without floating-point noise", () => {
    expect(triggerPriceToInput(0.12345678901234)).toBe("0.123456789012");
    expect(triggerPriceToInput(550)).toBe("550");
    expect(triggerPriceToInput(0.000000123)).toBe("0.000000123");
  });
});
