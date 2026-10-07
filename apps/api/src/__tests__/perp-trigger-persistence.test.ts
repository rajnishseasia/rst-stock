import { describe, expect, it, vi } from "bun:test";
import {
  TpSlPersistenceError,
  finalizeTpSlOrders,
  pendingTpSlOrderRows,
  persistPendingTpSlOrders,
  resolveTpSlClientOrderId,
} from "../routers/orders";

const request = {
  coin: "BTC",
  positionSide: "long" as const,
  size: "0.12345678",
  stopLossPx: "60000.125",
  takeProfitPx: "70000.875",
  isMarket: true,
  clientOrderId: "position-raw-seed",
};

function rows(userId = "user-1") {
  return pendingTpSlOrderRows({
    request,
    userId,
    brokerAccountId: "0xMaster",
    leverage: 7,
    marginMode: "cross",
  });
}

describe("TP/SL local persistence", () => {
  it("tenant-namespaces the same caller-supplied seed", () => {
    const tenantA = resolveTpSlClientOrderId("user-a", "shared-trigger-seed");
    const tenantB = resolveTpSlClientOrderId("user-b", "shared-trigger-seed");

    expect(tenantA).not.toBe(tenantB);
    expect(resolveTpSlClientOrderId("user-a", "shared-trigger-seed")).toBe(tenantA);
  });

  it("builds one exact PENDING reduce-only row per requested leg", () => {
    expect(rows()).toEqual([
      expect.objectContaining({
        clientOrderId: "position-raw-seed:sl:60000.125",
        quantityDecimal: "0.12345678",
        direction: "short",
        reduceOnly: true,
        orderType: "StopMarket",
        priceTrigger: "60000.125",
        status: "PENDING",
      }),
      expect.objectContaining({
        clientOrderId: "position-raw-seed:tp:70000.875",
        quantityDecimal: "0.12345678",
        direction: "short",
        reduceOnly: true,
        orderType: "TakeProfitMarket",
        priceTrigger: "70000.875",
        status: "PENDING",
      }),
    ]);
  });

  it("rejects a conflicting tenant before submission without updating it", async () => {
    const [row] = rows("user-a");
    const update = vi.fn(() => {
      throw new Error("conflicting rows must never be updated");
    });
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      update,
      query: {
        orders: { findFirst: async () => ({ ...row, id: "other", userId: "user-b" }) },
      },
    };
    const db = { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };

    await expect(persistPendingTpSlOrders(db as never, [row!])).rejects.toThrow(
      "does not match tenant and immutable order identity",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an exact replay because an earlier outcome may be ambiguous", async () => {
    const [row] = rows("user-a");
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      query: {
        orders: {
          findFirst: async () => ({
            ...row,
            id: "existing",
            quantityDecimal: "0.123456780000",
            priceTrigger: "60000.12500000",
          }),
        },
      },
    };
    const db = { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };

    await expect(persistPendingTpSlOrders(db as never, [row!])).rejects.toThrow(
      "will not be resubmitted",
    );
  });

  it("allocates a fresh cloid after every prior leg is definitively rejected", async () => {
    const [row] = rows("user-a");
    let transactionCount = 0;
    const db = {
      transaction: async (callback: (tx: unknown) => unknown) => {
        transactionCount += 1;
        const tx = {
          insert: () => ({
            values: () => ({
              onConflictDoNothing: () => ({
                returning: async () =>
                  transactionCount === 1 ? [] : [{ id: "fresh-row" }],
              }),
            }),
          }),
          query: {
            orders: {
              findFirst: async () => ({
                ...row,
                id: "rejected-row",
                status: "REJECTED",
              }),
            },
          },
        };
        return callback(tx);
      },
    };
    const result = await persistPendingTpSlOrders(db as never, [row!], {
      clientOrderId: row!.clientOrderId,
      rebuildRows: (clientOrderId) => [{ ...row!, clientOrderId }],
      nextClientOrderId: () => "fresh-cloid",
    });
    expect(transactionCount).toBe(2);
    expect(result.clientOrderId).toBe("fresh-cloid");
    expect(result.rows).toEqual([
      expect.objectContaining({ id: "fresh-row", clientOrderId: "fresh-cloid" }),
    ]);
  });

  it("leaves a reserved row PENDING when accepted-status persistence fails", async () => {
    const [row] = rows();
    const reserved = [{ ...row!, id: "row-1" }];
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => { throw new Error("db unavailable"); } }),
        }),
      }),
    };

    await expect(
      finalizeTpSlOrders(db as never, reserved, {
        response: { data: { statuses: [{ resting: { oid: 101 } }] } },
      }),
    ).rejects.toBeInstanceOf(TpSlPersistenceError);
    expect(reserved[0]?.status).toBe("PENDING");
  });

  it("rereads an already-submitted row but still reports a lost finalization CAS", async () => {
    const [row] = rows();
    const reserved = [{ ...row!, id: "row-reread" }];
    const db = {
      query: {
        orders: {
          findFirst: async () => ({ status: "SUBMITTED", brokerOrderId: "101" }),
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      }),
    };

    await expect(
      finalizeTpSlOrders(db as never, reserved, {
        response: { data: { statuses: [{ resting: { oid: 101 } }] } },
      }),
    ).rejects.toMatchObject({ acceptedCount: 1, failedCount: 1 });
  });

  it("does not treat a multi-row TP/SL finalization result as an accepted transition", async () => {
    const [row] = rows();
    const reserved = [{ ...row!, id: "row-ambiguous" }];
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "winner-a" }, { id: "winner-b" }],
          }),
        }),
      }),
    };

    await expect(
      finalizeTpSlOrders(db as never, reserved, {
        response: { data: { statuses: [{ resting: { oid: 101 } }] } },
      }),
    ).rejects.toMatchObject({ acceptedCount: 1, failedCount: 1 });
  });
});
