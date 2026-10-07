import { describe, expect, it } from "bun:test";
import {
  getLinkedExitLabel,
  getVisibleOpenOrderCount,
  isStopLossOrderType,
  getClosedOrdersPaging,
  isNoiseOrderStatus,
} from "../open-orders-display";

describe("open orders display helpers", () => {
  it("counts nested broker exit legs as visible open orders", () => {
    expect(
      getVisibleOpenOrderCount([
        {
          legs: [
            { type: "limit", limitPrice: 12, stopPrice: null },
            { type: "stop", limitPrice: null, stopPrice: 9 },
          ],
        },
      ])
    ).toBe(3);
  });

  it("labels stop legs as stop loss exits", () => {
    expect(getLinkedExitLabel({ type: "stop", limitPrice: null, stopPrice: 9 })).toBe(
      "Stop Loss"
    );
    expect(getLinkedExitLabel({ type: "stop_limit", limitPrice: 8.9, stopPrice: 9 })).toBe(
      "Stop Loss"
    );
  });

  it("identifies top-level stop orders as stop loss order types", () => {
    expect(isStopLossOrderType("stop")).toBe(true);
    expect(isStopLossOrderType("stop_limit")).toBe(true);
    expect(isStopLossOrderType("limit")).toBe(false);
  });

  it("labels limit legs as take-profit exits", () => {
    expect(getLinkedExitLabel({ type: "limit", limitPrice: 12, stopPrice: null })).toBe(
      "Take Profit"
    );
  });
});

describe("getClosedOrdersPaging", () => {
  const base = { limit: 50, max: 200, isLoadingMore: false };

  it("offers more when a full page came back under the cap", () => {
    expect(getClosedOrdersPaging({ ...base, loadedCount: 50 }).canLoadMore).toBe(true);
  });

  it("hides the control on a partial page (no more history)", () => {
    expect(getClosedOrdersPaging({ ...base, loadedCount: 37 }).canLoadMore).toBe(false);
  });

  it("keeps the control MOUNTED while a larger page is in flight", () => {
    // The regression: on click the limit grows to 100 while the placeholder rows
    // are still the old 50, so loadedCount < limit. Without the in-flight term
    // the button unmounts mid-load and its "Loading..." state is dead code.
    const paging = getClosedOrdersPaging({
      loadedCount: 50,
      limit: 100,
      max: 200,
      isLoadingMore: true,
    });
    expect(paging.canLoadMore).toBe(true);
    expect(paging.isLoadingMore).toBe(true);
  });

  it("stops at the cap even mid-load", () => {
    expect(
      getClosedOrdersPaging({
        loadedCount: 200,
        limit: 200,
        max: 200,
        isLoadingMore: true,
      }).canLoadMore,
    ).toBe(false);
  });
});

describe("isNoiseOrderStatus", () => {
  it("treats every fresh-submission status as noise on an open-orders list", () => {
    // Hiding only "new" left the pre-market panel as noisy as before, since
    // Alpaca reports accepted / pending_new outside market hours.
    expect(isNoiseOrderStatus("new")).toBe(true);
    expect(isNoiseOrderStatus("accepted")).toBe(true);
    expect(isNoiseOrderStatus("pending_new")).toBe(true);
  });

  it("keeps statuses that carry real signal", () => {
    for (const status of [
      "filled",
      "partially_filled",
      "canceled",
      "rejected",
      "expired",
      "pending_cancel",
    ]) {
      expect(isNoiseOrderStatus(status)).toBe(false);
    }
  });

  it("is case / whitespace tolerant and safe on missing values", () => {
    expect(isNoiseOrderStatus(" NEW ")).toBe(true);
    expect(isNoiseOrderStatus(null)).toBe(false);
    expect(isNoiseOrderStatus(undefined)).toBe(false);
    expect(isNoiseOrderStatus("")).toBe(false);
  });
});
