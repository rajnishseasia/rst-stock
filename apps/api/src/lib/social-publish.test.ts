import { describe, expect, it, vi } from "bun:test";
import { schema } from "@trade-bot/db";
import { publishSocialTrade } from "./social-publish.js";

function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn((table: unknown) => {
      expect(table).toBe(schema.socialTrades);
      return {
        values: vi.fn(async (row: Record<string, unknown>) => {
          rows.push(row);
        }),
      };
    }),
  };
  return { db, rows };
}

const payload = {
  symbol: "AAPL",
  side: "buy",
  qty: 2,
  orderType: "market",
  assetType: "EQUITY",
  brokerOrderId: "broker-1",
  orderId: "11111111-1111-4111-8111-111111111111",
};

describe("social trade publication policy", () => {
  it("publishes live Alpaca trades without a user preference lookup", async () => {
    const { db, rows } = fakeDb();

    await publishSocialTrade(db as never, "user-1", payload, "LIVE");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "user-1", symbol: "AAPL" });
  });

  it.each(["PAPER", "SIM"])("does not publish %s Alpaca trades", async (accountType) => {
    const { db, rows } = fakeDb();

    await publishSocialTrade(db as never, "user-1", payload, accountType);

    expect(rows).toHaveLength(0);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
