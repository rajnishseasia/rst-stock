import { describe, expect, test } from "bun:test";
import {
  dispatchStopLossEdit,
  dispatchStopLossSave,
  dispatchTakeProfitEdit,
  dispatchTakeProfitSave,
  parseTakeProfitInput,
} from "./stock-exit-save";

describe("take-profit decimal parsing", () => {
  test("accepts complete positive decimal strings", () => {
    for (const [rawValue, value] of [
      ["200", 200],
      ["200.25", 200.25],
      [".5", 0.5],
      [" 000.125 ", 0.125],
    ] as const) {
      expect(parseTakeProfitInput(rawValue)).toEqual({ success: true, value });
    }
  });

  test("rejects malformed, incomplete, non-finite, or non-positive values", () => {
    for (const rawValue of [
      "",
      ".",
      "200.",
      "200oops",
      "200.25oops",
      "1e2",
      "-1",
      "+1",
      "0",
      "Infinity",
    ]) {
      expect(parseTakeProfitInput(rawValue)).toEqual({
        success: false,
        error: "Enter a valid price",
      });
    }
  });
});

describe("stock exit edit dispatch", () => {
  test("dispatches an SL edit with the selected credential, order ID, and rounded price", () => {
    const calls: unknown[] = [];
    const result = dispatchStopLossEdit(
      {
        rawValue: "95.501",
        side: "long",
        currentPrice: 100,
        credentialId: "selected-credential",
        stopOrderId: "stop-order-7",
      },
      (variables) => calls.push(variables),
    );

    expect(result).toMatchObject({ success: true, value: 95.51 });
    expect(calls).toEqual([
      {
        credentialId: "selected-credential",
        stopOrderId: "stop-order-7",
        stopPrice: 95.51,
      },
    ]);
  });

  test("dispatches a TP edit with the selected credential, order ID, and unrounded limit price", () => {
    const calls: unknown[] = [];
    const result = dispatchTakeProfitEdit(
      {
        rawValue: "120.123",
        side: "long",
        currentPrice: 100,
        credentialId: "selected-credential",
        tpOrderId: "tp-order-9",
      },
      (variables) => calls.push(variables),
    );

    expect(result).toEqual({ success: true, value: 120.123 });
    expect(calls).toEqual([
      {
        credentialId: "selected-credential",
        tpOrderId: "tp-order-9",
        limitPrice: 120.123,
      },
    ]);
  });

  test("does not dispatch malformed TP input through edit or add paths", () => {
    const editCalls: unknown[] = [];
    const addCalls: unknown[] = [];
    const position = { side: "long" as const, currentPrice: 100 };

    const editResult = dispatchTakeProfitEdit(
      {
        rawValue: "200oops",
        ...position,
        credentialId: "selected-credential",
        tpOrderId: "tp-order-9",
      },
      (variables) => editCalls.push(variables),
    );
    const addResult = dispatchTakeProfitSave("200oops", position, (price) =>
      addCalls.push(price),
    );

    expect(editResult).toEqual({ success: false, error: "Enter a valid price" });
    expect(addResult).toEqual({ success: false, error: "Enter a valid price" });
    expect(editCalls).toEqual([]);
    expect(addCalls).toEqual([]);
  });

  test("keeps strict long and short TP direction boundaries", () => {
    const calls: number[] = [];

    expect(
      dispatchTakeProfitSave("100", { side: "long", currentPrice: 100 }, (price) =>
        calls.push(price),
      ),
    ).toEqual({
      success: false,
      error: "Take profit must be above current price for a long",
    });
    expect(
      dispatchTakeProfitSave("100", { side: "short", currentPrice: 100 }, (price) =>
        calls.push(price),
      ),
    ).toEqual({
      success: false,
      error: "Take profit must be below current price for a short",
    });
    expect(calls).toEqual([]);

    dispatchTakeProfitSave("101", { side: "long", currentPrice: 100 }, (price) =>
      calls.push(price),
    );
    dispatchTakeProfitSave("99", { side: "short", currentPrice: 100 }, (price) =>
      calls.push(price),
    );
    expect(calls).toEqual([101, 99]);
  });
});

const INVALID_MARKET_PRICES: { label: string; currentPrice: number | undefined }[] = [
  { label: "missing", currentPrice: undefined },
  { label: "zero", currentPrice: 0 },
  { label: "negative", currentPrice: -1 },
  { label: "NaN", currentPrice: Number.NaN },
  { label: "infinity", currentPrice: Number.POSITIVE_INFINITY },
];

for (const side of ["long", "short"] as const) {
  for (const { label, currentPrice } of INVALID_MARKET_PRICES) {
    test(`${side} SL and TP saves do not dispatch with a ${label} market price`, () => {
      const stopEditCalls: unknown[] = [];
      const stopAddCalls: unknown[] = [];
      const takeProfitEditCalls: unknown[] = [];
      const takeProfitAddCalls: unknown[] = [];
      const stopInput = side === "long" ? "95" : "105";
      const takeProfitInput = side === "long" ? "105" : "95";
      const position = { side, currentPrice };

      const stopEdit = dispatchStopLossEdit(
        {
          rawValue: stopInput,
          ...position,
          credentialId: "selected-credential",
          stopOrderId: "stop-order-7",
        },
        (variables) => stopEditCalls.push(variables),
      );
      const stopAdd = dispatchStopLossSave(stopInput, position, (price) =>
        stopAddCalls.push(price),
      );
      const takeProfitEdit = dispatchTakeProfitEdit(
        {
          rawValue: takeProfitInput,
          ...position,
          credentialId: "selected-credential",
          tpOrderId: "tp-order-9",
        },
        (variables) => takeProfitEditCalls.push(variables),
      );
      const takeProfitAdd = dispatchTakeProfitSave(
        takeProfitInput,
        position,
        (price) => takeProfitAddCalls.push(price),
      );

      for (const result of [stopEdit, stopAdd, takeProfitEdit, takeProfitAdd]) {
        expect(result).toEqual({
          success: false,
          error: "Cannot validate exit price without a valid current market price.",
        });
      }
      expect(stopEditCalls).toEqual([]);
      expect(stopAddCalls).toEqual([]);
      expect(takeProfitEditCalls).toEqual([]);
      expect(takeProfitAddCalls).toEqual([]);
    });
  }
}

test("invalid SL input does not dispatch", () => {
  const calls: number[] = [];
  const result = dispatchStopLossSave(
    "bad",
    { side: "long", currentPrice: 100 },
    (price) => calls.push(price),
  );

  expect(result).toEqual({
    success: false,
    error: "Use digits and a decimal point only.",
  });
  expect(calls).toEqual([]);
});
