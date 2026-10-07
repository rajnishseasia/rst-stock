import { describe, expect, mock, test } from "bun:test";

import {
  buildFullPositionPerpTpSlRequest,
  createPerpTpSlIntentStore,
  dispatchPerpTpSlActionIfFresh,
  isPerpTpSlActionable,
} from "./perp-tpsl-intent";

const MASTER_WALLET_ADDRESS = "0x0000000000000000000000000000000000000abc";
const INTENT_SIGNATURE = "BTC:long:0.25";
const OPEN_ORDERS_STALE_TIME_MS = 15_000;
const ACTIONABILITY_NOW = 100_000;

function freshOpenOrders(orders: unknown[] = [], dataUpdatedAt = ACTIONABILITY_NOW) {
  return {
    data: { orders },
    isFetching: false,
    fetchStatus: "idle" as const,
    dataUpdatedAt,
    isSuccess: true,
    error: null,
  };
}

describe("full-position TP/SL request", () => {
  test("adds the full-position mode without changing order fields", () => {
    const request = {
      coin: "BTC",
      positionSide: "long" as const,
      size: "0.250",
      cloid: "position-trigger",
      stopLossPx: "55000",
      takeProfitPx: "70000",
      isMarket: false,
    };

    expect(buildFullPositionPerpTpSlRequest(request)).toEqual({
      ...request,
      sizeMode: "full-position",
    });
  });
});

describe("perp TP/SL actionability", () => {
  test("requires both a valid bound wallet and a successful open-order snapshot", () => {
    expect(
      isPerpTpSlActionable(MASTER_WALLET_ADDRESS, {
        ...freshOpenOrders(),
      }, ACTIONABILITY_NOW),
    ).toBe(true);
    expect(
      isPerpTpSlActionable(MASTER_WALLET_ADDRESS, {
        isFetching: false,
        fetchStatus: "idle",
        dataUpdatedAt: ACTIONABILITY_NOW,
        isSuccess: true,
        error: null,
      }, ACTIONABILITY_NOW),
    ).toBe(false);
    expect(
      isPerpTpSlActionable(MASTER_WALLET_ADDRESS, {
        ...freshOpenOrders(),
        isSuccess: false,
        error: null,
      }, ACTIONABILITY_NOW),
    ).toBe(false);
    expect(
      isPerpTpSlActionable(MASTER_WALLET_ADDRESS, {
        ...freshOpenOrders(),
        isSuccess: false,
        error: new Error("venue unavailable"),
      }, ACTIONABILITY_NOW),
    ).toBe(false);
    expect(
      isPerpTpSlActionable(null, freshOpenOrders(), ACTIONABILITY_NOW),
    ).toBe(false);
    expect(
      isPerpTpSlActionable("0xabc", freshOpenOrders(), ACTIONABILITY_NOW),
    ).toBe(false);
  });

  test.each([
    [
      "cached success while fetching",
      { ...freshOpenOrders(), isFetching: true, fetchStatus: "fetching" as const },
      ACTIONABILITY_NOW,
    ],
    [
      "paused query",
      { ...freshOpenOrders(), fetchStatus: "paused" as const },
      ACTIONABILITY_NOW,
    ],
    [
      "snapshot beyond the stale-time boundary",
      freshOpenOrders([], ACTIONABILITY_NOW - OPEN_ORDERS_STALE_TIME_MS - 1),
      ACTIONABILITY_NOW,
    ],
    [
      "future snapshot timestamp",
      freshOpenOrders([], ACTIONABILITY_NOW + 1),
      ACTIONABILITY_NOW,
    ],
  ] as const)("fails closed for %s", (_label, query, now) => {
    expect(isPerpTpSlActionable(MASTER_WALLET_ADDRESS, query, now)).toBe(false);
  });

  test("treats the exact stale-time boundary as stale", () => {
    const snapshot = freshOpenOrders([], ACTIONABILITY_NOW - OPEN_ORDERS_STALE_TIME_MS);

    expect(
      isPerpTpSlActionable(MASTER_WALLET_ADDRESS, snapshot, ACTIONABILITY_NOW),
    ).toBe(false);
  });
});

describe("perp TP/SL mutation dispatch freshness", () => {
  test.each([
    [
      "cached success during a background refetch",
      { ...freshOpenOrders(), isFetching: true, fetchStatus: "fetching" as const },
      ACTIONABILITY_NOW,
    ],
    [
      "an over-age cached success",
      freshOpenOrders([], ACTIONABILITY_NOW - OPEN_ORDERS_STALE_TIME_MS - 1),
      ACTIONABILITY_NOW,
    ],
  ] as const)("blocks Set/Edit/Cancel dispatches for %s until fresh success", (_label, staleQuery, now) => {
    const setDispatch = mock(() => {});
    const editDispatch = mock(() => {});
    const cancelDispatch = mock(() => {});

    for (const dispatch of [setDispatch, editDispatch, cancelDispatch]) {
      expect(
        dispatchPerpTpSlActionIfFresh(
          MASTER_WALLET_ADDRESS,
          staleQuery,
          dispatch,
          now,
        ),
      ).toBe(false);
    }
    expect(setDispatch).not.toHaveBeenCalled();
    expect(editDispatch).not.toHaveBeenCalled();
    expect(cancelDispatch).not.toHaveBeenCalled();

    const freshQuery = freshOpenOrders([], now);
    for (const dispatch of [setDispatch, editDispatch, cancelDispatch]) {
      expect(
        dispatchPerpTpSlActionIfFresh(
          MASTER_WALLET_ADDRESS,
          freshQuery,
          dispatch,
          now,
        ),
      ).toBe(true);
    }
    expect(setDispatch).toHaveBeenCalledTimes(1);
    expect(editDispatch).toHaveBeenCalledTimes(1);
    expect(cancelDispatch).toHaveBeenCalledTimes(1);
  });

  test("rechecks age at handler invocation without relying on a render", () => {
    const snapshot = freshOpenOrders([], ACTIONABILITY_NOW);
    const dispatch = mock(() => {});

    expect(
      dispatchPerpTpSlActionIfFresh(
        MASTER_WALLET_ADDRESS,
        snapshot,
        dispatch,
        ACTIONABILITY_NOW,
      ),
    ).toBe(true);
    expect(
      dispatchPerpTpSlActionIfFresh(
        MASTER_WALLET_ADDRESS,
        snapshot,
        dispatch,
        ACTIONABILITY_NOW + OPEN_ORDERS_STALE_TIME_MS,
      ),
    ).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("perp TP/SL intent-key lifecycle", () => {
  test("reconciliation-needed retains the same intent key without generating another", () => {
    let generated = 0;
    const intents = createPerpTpSlIntentStore(() => `cloid-${++generated}`);
    const initial = intents.getOrCreate(INTENT_SIGNATURE);

    intents.resolve(initial, "reconciliation-needed");

    expect(intents.getOrCreate(INTENT_SIGNATURE)).toBe(initial);
    expect(generated).toBe(1);
  });

  test("definitive success clears the completed intent key", () => {
    let generated = 0;
    const intents = createPerpTpSlIntentStore(() => `cloid-${++generated}`);
    const initial = intents.getOrCreate(INTENT_SIGNATURE);

    intents.resolve(initial, "definitive-success");

    expect(intents.getOrCreate(INTENT_SIGNATURE)).toBe("cloid-2");
    expect(generated).toBe(2);
  });

  test.each([
    "query-timeout",
    "query-error",
    "empty-open-orders",
  ] as const)("does not clear an intent after %s", (outcome) => {
    let generated = 0;
    const intents = createPerpTpSlIntentStore(() => `cloid-${++generated}`);
    const initial = intents.getOrCreate(INTENT_SIGNATURE);

    intents.resolve(initial, outcome);

    expect(intents.getOrCreate(INTENT_SIGNATURE)).toBe(initial);
    expect(generated).toBe(1);
  });
});
