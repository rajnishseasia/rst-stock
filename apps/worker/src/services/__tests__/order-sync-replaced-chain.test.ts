import { describe, expect, it, vi } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { OrderSyncPoller } from "../order-sync";

/**
 * The execution write is built from SQL expressions (monotonic status, a
 * coalesced broker order id) rather than literals, so a value is checked by
 * rendering the expression and reading its parameters.
 */
function renderedUpdate(value: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(value as never);
}

/**
 * alpaca-09: Alpaca documents `replaced` as a FINAL state for the order being
 * replaced, and hands back `replaced_by`, "The order ID that this order was
 * replaced by," precisely so a caller can follow the fill to the successor.
 * mapAlpacaStatus maps `replaced` to the non-terminal SUBMITTED and nothing
 * ever reads `replaced_by`, so a modified source order's local row freezes on
 * the retired broker order id forever: its status never leaves SUBMITTED and
 * its filled quantity never moves again, even after the successor fills.
 */

function submittedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-order-1",
    userId: "user-a",
    brokerCredentialId: "11111111-1111-4111-8111-111111111111",
    brokerAccountId: "paper-account",
    brokerOrderId: "orig-broker-order-id",
    clientOrderId: "tenant-client-order-1",
    brokerClientOrderId: "broker-client-order-1",
    status: "SUBMITTED",
    symbol: "MSFT",
    tradeAction: "Buy",
    quantity: 200,
    executedQuantity: 0,
    exitPlanStatus: null,
    exitPlan: null,
    assetType: "EQUITY",
    orderType: "Limit",
    limitPrice: "300",
    syncAttempts: 0,
    syncReason: null,
    ...overrides,
  };
}

function pollerWithOrder(order: Record<string, unknown>, getOrder: ReturnType<typeof vi.fn>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    query: { orders: { findMany: vi.fn().mockResolvedValue([order]) } },
    // Status writes are compare-and-set now: the poller reads back the rows the
    // update actually won, so `where()` has to answer a `returning()`.
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((value: Record<string, unknown>) => {
        updates.push(value);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "local-order-1" }]),
          }),
        };
      }),
    }),
  };
  const poller = new OrderSyncPoller(db as never, {
    getCredentials: vi.fn().mockResolvedValue({
      accountType: "PAPER",
      username: "paper-key",
      accessToken: "paper-secret",
    }),
    createClient: vi.fn().mockReturnValue({ getOrder }),
    notify: vi.fn(),
  });
  return { poller, updates };
}

describe("OrderSyncPoller follows Alpaca's replaced_by chain", () => {
  it("follows a single replace to the successor's real fill instead of freezing on SUBMITTED", async () => {
    const order = submittedOrder();
    const getOrder = vi.fn()
      .mockResolvedValueOnce({
        id: "orig-broker-order-id",
        status: "replaced",
        replaced_by: "successor-order-id",
        filled_qty: "0",
        filled_avg_price: null,
        filled_at: null,
      })
      .mockResolvedValueOnce({
        id: "successor-order-id",
        status: "filled",
        replaced_by: null,
        filled_qty: "200",
        filled_avg_price: "301.50",
        filled_at: "2026-08-19T14:00:00Z",
      });
    const { poller, updates } = pollerWithOrder(order, getOrder);

    await poller.pollOnce();

    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(getOrder).toHaveBeenNthCalledWith(1, "orig-broker-order-id");
    expect(getOrder).toHaveBeenNthCalledWith(2, "successor-order-id");
    const write = updates.at(-1)!;
    // The successor id has to REPLACE the retired one: coalescing here would
    // leave the row on an order that can never fill again.
    const brokerOrderId = renderedUpdate(write.brokerOrderId);
    expect(brokerOrderId.params).toContain("successor-order-id");
    expect(brokerOrderId.params).toContain("orig-broker-order-id");
    expect(renderedUpdate(write.status).params).toContain("FILLED");
    expect(renderedUpdate(write.executedQuantity).params).toContain(200);
    expect(renderedUpdate(write.executedPrice).params).toContain(301.5);
  });

  it("follows a chain of two replaces (price nudged twice) to the final successor", async () => {
    const order = submittedOrder();
    const getOrder = vi.fn()
      .mockResolvedValueOnce({
        id: "orig-broker-order-id",
        status: "replaced",
        replaced_by: "second-order-id",
        filled_qty: "0",
        filled_avg_price: null,
        filled_at: null,
      })
      .mockResolvedValueOnce({
        id: "second-order-id",
        status: "replaced",
        replaced_by: "third-order-id",
        filled_qty: "0",
        filled_avg_price: null,
        filled_at: null,
      })
      .mockResolvedValueOnce({
        id: "third-order-id",
        status: "partially_filled",
        replaced_by: null,
        filled_qty: "50",
        filled_avg_price: "302.00",
        filled_at: null,
      });
    const { poller, updates } = pollerWithOrder(order, getOrder);

    await poller.pollOnce();

    expect(getOrder).toHaveBeenCalledTimes(3);
    const write = updates.at(-1)!;
    const brokerOrderId = renderedUpdate(write.brokerOrderId);
    // The FINAL successor, not the intermediate one the chain passed through.
    expect(brokerOrderId.params).toContain("third-order-id");
    expect(brokerOrderId.params).not.toContain("second-order-id");
    expect(renderedUpdate(write.status).params).toContain("PARTIAL");
    expect(renderedUpdate(write.executedQuantity).params).toContain(50);
  });

  it("does not resurrect a still-SUBMITTED order that has not been replaced (no regression)", async () => {
    const order = submittedOrder();
    const getOrder = vi.fn().mockResolvedValueOnce({
      id: "orig-broker-order-id",
      status: "accepted",
      replaced_by: null,
      filled_qty: "0",
      filled_avg_price: null,
      filled_at: null,
    });
    const { poller, updates } = pollerWithOrder(order, getOrder);

    await poller.pollOnce();

    expect(getOrder).toHaveBeenCalledTimes(1);
    // status/qty unchanged and syncReason already null, so no update fires.
    expect(updates.length).toBe(0);
  });
});
