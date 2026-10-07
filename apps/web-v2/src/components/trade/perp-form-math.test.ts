import { describe, expect, test } from "bun:test";
import {
  clampLeverageForCap,
  clampPerpLeverage,
  coinSizeToUsd,
  isTriggerUiOrderType,
  leveragePresets,
  marginRequiredUsd,
  resolvePerpOrderType,
  roundSizeToDecimals,
  shouldReviewPerpOrder,
  uiOrderTypeUsesLimitPrice,
  usdInputToCoinSize,
  usdToCoinSize,
  DEFAULT_PERP_LEVERAGE,
  FALLBACK_MAX_LEVERAGE,
  PERP_REVIEW_LEVERAGE_THRESHOLD,
  PERP_REVIEW_NOTIONAL_CAP,
  TRIGGER_UI_ORDER_TYPES,
  type PerpUiOrderType,
} from "./perp-form-math";

describe("clampPerpLeverage", () => {
  test("clamps above the asset cap", () => {
    expect(clampPerpLeverage(50, 20)).toBe(20);
  });
  test("floors fractional leverage", () => {
    expect(clampPerpLeverage(3.9, 20)).toBe(3);
  });
  test("floors below 1 up to 1", () => {
    expect(clampPerpLeverage(0, 20)).toBe(1);
    expect(clampPerpLeverage(-5, 20)).toBe(1);
  });
  test("non-finite maxLeverage collapses to 1", () => {
    expect(clampPerpLeverage(10, Number.NaN)).toBe(1);
  });
  test("passes through a valid value", () => {
    expect(clampPerpLeverage(5, 20)).toBe(5);
  });
});

describe("clampLeverageForCap", () => {
  test("default leverage is a sane value greater than 1x", () => {
    // Guards the cold-mount default: a fresh form must never start pinned to 1x.
    expect(DEFAULT_PERP_LEVERAGE).toBeGreaterThan(1);
  });

  test("cold load (cap not yet loaded) never pins the default to 1x", () => {
    // maxLeverage is undefined/null while HL metadata is still in flight.
    expect(clampLeverageForCap(DEFAULT_PERP_LEVERAGE, undefined)).toBe(
      DEFAULT_PERP_LEVERAGE,
    );
    expect(clampLeverageForCap(DEFAULT_PERP_LEVERAGE, null)).toBe(
      DEFAULT_PERP_LEVERAGE,
    );
  });

  test("passes a requested value through untouched when no real cap is known", () => {
    expect(clampLeverageForCap(20, undefined)).toBe(20);
    expect(clampLeverageForCap(7, null)).toBe(7);
    // Non-finite / sub-1 caps count as "unknown" and must NOT clamp down.
    expect(clampLeverageForCap(15, Number.NaN)).toBe(15);
    expect(clampLeverageForCap(15, 0)).toBe(15);
  });

  test("clamps DOWN once a real finite cap has loaded", () => {
    expect(clampLeverageForCap(50, 20)).toBe(20);
    expect(clampLeverageForCap(2, 20)).toBe(2); // under the cap -> unchanged
  });

  test("never clamps UP toward the cap", () => {
    // A modest requested value stays put even when a large cap loads.
    expect(clampLeverageForCap(DEFAULT_PERP_LEVERAGE, 50)).toBe(
      DEFAULT_PERP_LEVERAGE,
    );
  });

  test("floors fractional input and lifts sub-1 input to 1", () => {
    expect(clampLeverageForCap(3.9, undefined)).toBe(3);
    expect(clampLeverageForCap(0, undefined)).toBe(1);
    expect(clampLeverageForCap(-5, 20)).toBe(1);
  });

  test("FALLBACK_MAX_LEVERAGE gives a usable range while the cap loads", () => {
    // The slider ceiling used before the real cap arrives must exceed 1x.
    expect(FALLBACK_MAX_LEVERAGE).toBeGreaterThan(1);
    expect(clampLeverageForCap(FALLBACK_MAX_LEVERAGE, FALLBACK_MAX_LEVERAGE)).toBe(
      FALLBACK_MAX_LEVERAGE,
    );
  });
});

describe("leveragePresets", () => {
  // The rendered chip set is the numeric presets plus a single trailing "Max"
  // chip equal to maxLeverage. These helpers model that full chip set.
  const numericChips = (max: number) => leveragePresets(max);
  const fullChips = (max: number) => [...leveragePresets(max), max];

  test("maxLeverage 3 -> [2] (Max is 3)", () => {
    expect(leveragePresets(3)).toEqual([2]);
  });
  test("maxLeverage 5 -> [2] (Max is 5, 5 chip suppressed)", () => {
    expect(leveragePresets(5)).toEqual([2]);
  });
  test("maxLeverage 10 -> [2, 5] (Max is 10, 10 chip suppressed)", () => {
    expect(leveragePresets(10)).toEqual([2, 5]);
  });
  test("maxLeverage 20 -> [2, 5, 10] (Max is 20, 20 chip suppressed)", () => {
    expect(leveragePresets(20)).toEqual([2, 5, 10]);
  });
  test("maxLeverage 25 -> [2, 5, 10, 20] (Max is 25)", () => {
    expect(leveragePresets(25)).toEqual([2, 5, 10, 20]);
  });
  test("maxLeverage 40 -> [2, 5, 10, 20] (Max is 40)", () => {
    expect(leveragePresets(40)).toEqual([2, 5, 10, 20]);
  });

  test("no numeric chip ever equals or exceeds maxLeverage", () => {
    for (const max of [3, 5, 10, 20, 25, 40]) {
      for (const chip of numericChips(max)) {
        expect(chip).toBeLessThan(max);
      }
    }
  });

  test("full chip set (numeric + Max) has no duplicates", () => {
    for (const max of [3, 5, 10, 20, 25, 40]) {
      const chips = fullChips(max);
      expect(new Set(chips).size).toBe(chips.length);
    }
  });

  test("exactly one chip equals Max across the full set", () => {
    for (const max of [3, 5, 10, 20, 25, 40]) {
      const atMax = fullChips(max).filter((c) => c === max);
      expect(atMax).toHaveLength(1);
    }
  });

  test("no full chip exceeds maxLeverage", () => {
    for (const max of [3, 5, 10, 20, 25, 40]) {
      for (const chip of fullChips(max)) {
        expect(chip).toBeLessThanOrEqual(max);
      }
    }
  });

  test("non-finite or sub-1 cap yields no numeric chips", () => {
    expect(leveragePresets(Number.NaN)).toEqual([]);
    expect(leveragePresets(0)).toEqual([]);
    expect(leveragePresets(1)).toEqual([]);
  });
});

describe("roundSizeToDecimals", () => {
  test("truncates (not rounds) to szDecimals", () => {
    // 0.123456 at 3 decimals truncates to 0.123, never 0.124.
    expect(roundSizeToDecimals(0.123456, 3)).toBe("0.123");
    expect(roundSizeToDecimals(0.129, 2)).toBe("0.12");
  });
  test("strips trailing zeros and dangling dot", () => {
    expect(roundSizeToDecimals(0.5, 3)).toBe("0.5");
    expect(roundSizeToDecimals(1, 3)).toBe("1");
  });
  test("szDecimals 0 yields an integer string", () => {
    expect(roundSizeToDecimals(7.9, 0)).toBe("7");
  });
  test("non-positive / non-finite input yields 0", () => {
    expect(roundSizeToDecimals(0, 3)).toBe("0");
    expect(roundSizeToDecimals(-1, 3)).toBe("0");
    expect(roundSizeToDecimals(Number.NaN, 3)).toBe("0");
  });
  test("size below one tick yields 0", () => {
    expect(roundSizeToDecimals(0.0004, 3)).toBe("0");
  });
});

describe("usdToCoinSize", () => {
  test("divides by mark and rounds to szDecimals", () => {
    // $1000 at $50,000 mark = 0.02 BTC.
    expect(usdToCoinSize(1000, 50000, 5)).toBe("0.02");
  });
  test("truncates to szDecimals", () => {
    // $100 at $3333 mark = 0.030003... -> 3 decimals -> 0.03.
    expect(usdToCoinSize(100, 3333, 3)).toBe("0.03");
  });
  test("unusable inputs yield 0", () => {
    expect(usdToCoinSize(0, 50000, 5)).toBe("0");
    expect(usdToCoinSize(1000, 0, 5)).toBe("0");
  });
});

describe("usdInputToCoinSize", () => {
  test("keeps a USD amount pending until a HIP-3 mark arrives", () => {
    expect(usdInputToCoinSize("10", 0, 2)).toBe("");
    expect(usdInputToCoinSize("10", 163.87, 2)).toBe("0.06");
  });

  test("recalculates when the asset precision changes", () => {
    expect(usdInputToCoinSize("100", 333, 2)).toBe("0.3");
    expect(usdInputToCoinSize("100", 333, 4)).toBe("0.3003");
  });

  test("clears with an empty field and rejects unusable values", () => {
    expect(usdInputToCoinSize("", 100, 2)).toBe("");
    expect(usdInputToCoinSize("0", 100, 2)).toBe("0");
    expect(usdInputToCoinSize("not-a-number", 100, 2)).toBe("0");
  });
});

describe("coinSizeToUsd", () => {
  test("multiplies coin size by mark", () => {
    expect(coinSizeToUsd(0.02, 50000)).toBe(1000);
  });
  test("round-trips with usdToCoinSize on aligned values", () => {
    const coin = usdToCoinSize(1000, 50000, 5); // "0.02"
    expect(coinSizeToUsd(Number(coin), 50000)).toBe(1000);
  });
  test("unusable inputs yield 0", () => {
    expect(coinSizeToUsd(0, 50000)).toBe(0);
    expect(coinSizeToUsd(0.02, 0)).toBe(0);
  });
});

describe("marginRequiredUsd", () => {
  test("notional divided by leverage", () => {
    expect(marginRequiredUsd(1000, 10)).toBe(100);
  });
  test("unusable inputs yield 0", () => {
    expect(marginRequiredUsd(0, 10)).toBe(0);
    expect(marginRequiredUsd(1000, 0)).toBe(0);
  });
});

describe("shouldReviewPerpOrder", () => {
  test("triggers at the leverage threshold", () => {
    expect(
      shouldReviewPerpOrder({ leverage: PERP_REVIEW_LEVERAGE_THRESHOLD, notionalUsd: 1 }),
    ).toBe(true);
  });
  test("triggers at the notional cap", () => {
    expect(
      shouldReviewPerpOrder({ leverage: 2, notionalUsd: PERP_REVIEW_NOTIONAL_CAP }),
    ).toBe(true);
  });
  test("does not trigger for a small, low-leverage order", () => {
    expect(shouldReviewPerpOrder({ leverage: 2, notionalUsd: 500 })).toBe(false);
  });

  test("always reviews an order that requires an account-transition disclosure", () => {
    expect(
      shouldReviewPerpOrder({
        leverage: 2,
        notionalUsd: 50,
        requiresAccountTransitionDisclosure: true,
      }),
    ).toBe(true);
  });
});

describe("isTriggerUiOrderType", () => {
  test("stop and take-profit types are triggers", () => {
    expect(isTriggerUiOrderType("StopMarket")).toBe(true);
    expect(isTriggerUiOrderType("StopLimit")).toBe(true);
    expect(isTriggerUiOrderType("TakeProfit")).toBe(true);
  });
  test("market and limit are NOT triggers", () => {
    expect(isTriggerUiOrderType("Market")).toBe(false);
    expect(isTriggerUiOrderType("Limit")).toBe(false);
  });
  test("TRIGGER_UI_ORDER_TYPES lists exactly the trigger types", () => {
    expect([...TRIGGER_UI_ORDER_TYPES].sort()).toEqual(
      (["StopLimit", "StopMarket", "TakeProfit"] as PerpUiOrderType[]).sort(),
    );
  });
});

describe("uiOrderTypeUsesLimitPrice", () => {
  test("Limit and Stop Limit always carry a limit price", () => {
    expect(uiOrderTypeUsesLimitPrice("Limit", false)).toBe(true);
    expect(uiOrderTypeUsesLimitPrice("StopLimit", false)).toBe(true);
  });
  test("Market and Stop Market never carry a limit price", () => {
    expect(uiOrderTypeUsesLimitPrice("Market", true)).toBe(false);
    expect(uiOrderTypeUsesLimitPrice("StopMarket", true)).toBe(false);
  });
  test("Take Profit uses a limit price only when one is entered", () => {
    expect(uiOrderTypeUsesLimitPrice("TakeProfit", false)).toBe(false);
    expect(uiOrderTypeUsesLimitPrice("TakeProfit", true)).toBe(true);
  });
});

describe("resolvePerpOrderType", () => {
  test("maps the direct one-to-one UI types", () => {
    expect(resolvePerpOrderType("Market", false)).toBe("Market");
    expect(resolvePerpOrderType("Limit", true)).toBe("Limit");
    expect(resolvePerpOrderType("StopMarket", false)).toBe("StopMarket");
    expect(resolvePerpOrderType("StopLimit", true)).toBe("StopLimit");
  });
  test("Take Profit → TakeProfitMarket without a limit price", () => {
    expect(resolvePerpOrderType("TakeProfit", false)).toBe("TakeProfitMarket");
  });
  test("Take Profit → TakeProfitLimit with a limit price", () => {
    expect(resolvePerpOrderType("TakeProfit", true)).toBe("TakeProfitLimit");
  });
  test("every UI type resolves to a defined server type", () => {
    const all: PerpUiOrderType[] = [
      "Market",
      "Limit",
      "StopMarket",
      "StopLimit",
      "TakeProfit",
    ];
    for (const ui of all) {
      const hasLimit = uiOrderTypeUsesLimitPrice(ui, true);
      const resolved = resolvePerpOrderType(ui, hasLimit);
      expect(resolved).toBeTruthy();
      // Trigger UI types must resolve to a server trigger type.
      if (isTriggerUiOrderType(ui)) {
        expect(
          ["StopMarket", "StopLimit", "TakeProfitMarket", "TakeProfitLimit"],
        ).toContain(resolved);
      }
    }
  });
});
