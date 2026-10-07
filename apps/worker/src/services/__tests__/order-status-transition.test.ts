import { describe, expect, it } from "bun:test";
import {
  canAdvanceOrderStatus,
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
} from "@trade-bot/db";
import { schema } from "@trade-bot/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

describe("order status transitions", () => {
  it("rejects stale live and terminal transitions while allowing forward races", () => {
    expect(canAdvanceOrderStatus("FILLED", "SUBMITTED")).toBe(false);
    expect(canAdvanceOrderStatus("CANCELLED", "SYNCING")).toBe(false);
    expect(canAdvanceOrderStatus("REJECTED", "CANCELLED")).toBe(false);
    expect(canAdvanceOrderStatus("PENDING", "SYNCING")).toBe(true);
    expect(canAdvanceOrderStatus("SYNCING", "SUBMITTED")).toBe(true);
    expect(canAdvanceOrderStatus("PARTIAL", "FILLED")).toBe(true);
    expect(canAdvanceOrderStatus("FILLED", "FILLED")).toBe(true);
  });

  it("compiles a compare-and-set that also preserves an existing broker id", () => {
    const queryDb = drizzle(
      { query: () => Promise.resolve({ rows: [], fields: [] }) } as never,
      { schema },
    );
    const compiled = queryDb
      .update(schema.orders)
      .set({ status: "SUBMITTED", brokerOrderId: "broker-new" })
      .where(and(
        eq(schema.orders.id, "11111111-1111-4111-8111-111111111111"),
        orderStatusTransitionCondition("SUBMITTED"),
        preserveBrokerOrderIdCondition("broker-new"),
      ))
      .toSQL();

    expect(compiled.sql).toContain('"status"');
    expect(compiled.sql).toContain('"broker_order_id"');
    expect(compiled.params).toContain("broker-new");
    expect(compiled.sql).toContain("FILLED");
    expect(compiled.params).toContain("SUBMITTED");
  });
});
