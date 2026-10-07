import { describe, expect, it } from "bun:test";
import type { AlpacaOrder } from "@trade-bot/alpaca";
import {
  buildAlpacaExecutionGroup,
  buildDbExecutionGroup,
  mergeExecutionGroups,
} from "../routers/charts.js";

function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: "alpaca-order-1",
    client_order_id: "client-1",
    created_at: "2026-06-15T13:00:00.000Z",
    updated_at: "2026-06-15T13:01:00.000Z",
    submitted_at: "2026-06-15T13:00:00.000Z",
    filled_at: "2026-06-15T13:01:23.000Z",
    expired_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    asset_id: "asset-1",
    symbol: "AAPL",
    asset_class: "us_equity",
    notional: null,
    qty: "3",
    filled_qty: "3",
    filled_avg_price: "201.25",
    order_class: "",
    order_type: "market",
    type: "market",
    side: "buy",
    time_in_force: "day",
    limit_price: null,
    stop_price: null,
    status: "filled",
    extended_hours: false,
    legs: null,
    trail_percent: null,
    trail_price: null,
    hwm: null,
    ...overrides,
  };
}

type DbOrderInput = Parameters<typeof buildDbExecutionGroup>[0];

function dbOrder(overrides: Partial<DbOrderInput> = {}): DbOrderInput {
  return {
    id: "local-order-1",
    symbol: "AAPL",
    tradeAction: "Buy",
    orderType: "Market",
    executedAt: new Date("2026-06-15T13:01:23.000Z"),
    statusUpdatedAt: null,
    executedPrice: "201.25",
    executedQuantity: 3,
    quantity: 3,
    assetType: "EQUITY",
    brokerOrderId: null,
    ...overrides,
  };
}

describe("chart execution annotations", () => {
  it("builds Alpaca buy/sell annotations from filled executions", () => {
    const buy = buildAlpacaExecutionGroup(alpacaOrder(), "AAPL");
    const sell = buildAlpacaExecutionGroup(
      alpacaOrder({ id: "alpaca-order-2", side: "sell" }),
      "AAPL"
    );

    expect(buy).toMatchObject({
      id: "broker:alpaca-order-1",
      side: "BUY",
      quantity: 3,
      anchorPrice: 201.25,
      anchorTime: 1781528483,
      source: "alpaca",
    });
    expect(sell?.side).toBe("SELL");
  });

  it("skips Alpaca orders that have no filled quantity or price", () => {
    expect(
      buildAlpacaExecutionGroup(
        alpacaOrder({ filled_qty: "0", filled_avg_price: null, status: "canceled" }),
        "AAPL"
      )
    ).toBeNull();
  });

  it("skips Alpaca fills that have no fill time rather than pinning to submission", () => {
    // A (partial) fill that never reported filled_at must not be anchored to
    // submitted_at/created_at — that would place the bubble on the wrong candle.
    expect(buildAlpacaExecutionGroup(alpacaOrder({ filled_at: null }), "AAPL")).toBeNull();
  });

  it("anchors DB fills to executedAt when present", () => {
    const group = buildDbExecutionGroup(
      dbOrder({
        executedAt: new Date("2026-06-15T13:01:23.000Z"),
        // A later status touch must NOT override the real fill time.
        statusUpdatedAt: new Date("2026-06-15T20:00:00.000Z"),
      })
    );
    expect(group?.anchorTime).toBe(1781528483);
  });

  it("uses statusUpdatedAt as a DB fallback when executedAt was not persisted", () => {
    const group = buildDbExecutionGroup(
      dbOrder({
        tradeAction: "Sell",
        orderType: "Limit",
        executedAt: null,
        statusUpdatedAt: new Date("2026-06-15T13:05:00.000Z"),
        executedPrice: "202.50",
        executedQuantity: 2,
        quantity: 2,
        brokerOrderId: "alpaca-order-1",
      })
    );

    expect(group).toMatchObject({
      id: "broker:alpaca-order-1",
      side: "SELL",
      anchorTime: 1781528700,
      anchorPrice: 202.5,
      source: "db",
    });
  });

  it("skips DB fills with no usable fill timestamp instead of using submission time", () => {
    // Neither executedAt nor statusUpdatedAt → we have no real fill time, so
    // the row is dropped rather than anchored to createdAt/updatedAt.
    expect(
      buildDbExecutionGroup(dbOrder({ executedAt: null, statusUpdatedAt: null }))
    ).toBeNull();
  });

  it("prefers Alpaca execution timing over a matching local DB row (by broker id)", () => {
    const db = buildDbExecutionGroup(
      dbOrder({
        executedAt: null,
        statusUpdatedAt: new Date("2026-06-15T13:05:00.000Z"),
        executedPrice: "202.50",
        executedQuantity: 2,
        quantity: 2,
        brokerOrderId: "alpaca-order-1",
      })
    );
    const alpaca = buildAlpacaExecutionGroup(alpacaOrder(), "AAPL");

    const merged = mergeExecutionGroups(db ? [db] : [], alpaca ? [alpaca] : []);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("alpaca");
    expect(merged[0]?.anchorTime).toBe(1781528483);
  });

  it("dedupes a DB fill that has no brokerOrderId against its matching Alpaca row", () => {
    // The DB row hasn't had its broker order id linked yet, but it represents
    // the same fill (same symbol/side/time/qty/price). The content signature
    // must collapse the pair into one Alpaca-sourced marker.
    const alpaca = buildAlpacaExecutionGroup(alpacaOrder(), "AAPL")!;
    const dbNoBroker = buildDbExecutionGroup(
      dbOrder({
        brokerOrderId: null,
        executedAt: new Date("2026-06-15T13:01:23.000Z"),
        executedPrice: "201.25",
        executedQuantity: 3,
        quantity: 3,
        tradeAction: "Buy",
      })
    )!;

    const merged = mergeExecutionGroups([dbNoBroker], [alpaca]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("alpaca");
  });

  it("keeps genuinely distinct fills as separate markers", () => {
    const first = buildAlpacaExecutionGroup(alpacaOrder(), "AAPL")!;
    const second = buildAlpacaExecutionGroup(
      alpacaOrder({
        id: "alpaca-order-9",
        filled_at: "2026-06-15T14:00:00.000Z",
        filled_avg_price: "205.00",
      }),
      "AAPL"
    )!;

    const merged = mergeExecutionGroups([], [first, second]);

    expect(merged).toHaveLength(2);
    // Sorted ascending by fill time.
    expect(merged[0]?.anchorTime).toBeLessThan(merged[1]!.anchorTime);
  });

  it("keeps a broker-confirmed DB fill whose content collides with a different Alpaca order", () => {
    // The DB row carries a real, distinct brokerOrderId that Alpaca's closed
    // orders do not include. Even if it happens to share a content signature
    // with an Alpaca fill, it must NOT be dropped — it is its own execution.
    const alpaca = buildAlpacaExecutionGroup(alpacaOrder({ id: "alpaca-order-A" }), "AAPL")!;
    const dbBrokered = buildDbExecutionGroup(
      dbOrder({
        brokerOrderId: "db-only-broker-id",
        executedAt: new Date("2026-06-15T13:01:23.000Z"), // same content signature
        executedPrice: "201.25",
        executedQuantity: 3,
        quantity: 3,
        tradeAction: "Buy",
      })
    )!;

    const merged = mergeExecutionGroups([dbBrokered], [alpaca]);

    expect(merged).toHaveLength(2);
    expect(merged.some((g) => g.brokerOrderId === "db-only-broker-id")).toBe(true);
  });

  it("keeps a DB-only fill that has no matching Alpaca row", () => {
    const dbOnly = buildDbExecutionGroup(
      dbOrder({ id: "local-only", brokerOrderId: null, executedPrice: "150.00" })
    )!;

    const merged = mergeExecutionGroups([dbOnly], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("db");
  });
});
