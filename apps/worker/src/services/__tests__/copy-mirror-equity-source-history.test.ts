import { describe, expect, it } from "bun:test";

import { readEquitySourceCloseContext } from "../copy-mirror-equity-source-history";

const SOURCE_USER_ID = "source-history-user";
const SOURCE_ACCOUNT_ID = "source-account";
const CLOSE_ID = "source-close";
const CLOSE_AT = new Date("2026-08-01T14:00:00.000Z");

function sourceOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: CLOSE_ID,
    userId: SOURCE_USER_ID,
    symbol: "XYZ",
    assetType: "EQUITY",
    tradeAction: "Sell",
    direction: "long",
    status: "FILLED",
    executedQuantity: 25,
    brokerAccountId: SOURCE_ACCOUNT_ID,
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: CLOSE_AT,
    executedAt: CLOSE_AT,
    ...overrides,
  };
}

function historyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-open",
    symbol: "XYZ",
    assetType: "EQUITY",
    tradeAction: "Buy",
    direction: "long",
    status: "FILLED",
    executedQuantity: 100,
    brokerAccountId: SOURCE_ACCOUNT_ID,
    venue: "alpaca",
    optionExpiration: null,
    optionStrike: null,
    optionType: null,
    createdAt: new Date("2026-08-01T13:00:00.000Z"),
    executedAt: new Date("2026-08-01T13:00:00.000Z"),
    ...overrides,
  };
}

function findDateInQuery(
  value: unknown,
  seen = new Set<object>(),
): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    const date = findDateInQuery(child, seen);
    if (date) return date;
  }
  return undefined;
}

function fakeDb(
  close: Record<string, unknown>,
  history: Array<Record<string, unknown>>,
) {
  return {
    query: {
      orders: {
        findFirst: async () => close,
        findMany: async (query: { where?: unknown }) => {
          const cutoff = findDateInQuery(query.where);
          if (!cutoff) return history;
          return history.filter((order) => {
            const eventAt = order.executedAt ?? order.createdAt;
            return (
              eventAt instanceof Date && eventAt.getTime() <= cutoff.getTime()
            );
          });
        },
      },
    },
  } as never;
}

const input = {
  sourceUserId: SOURCE_USER_ID,
  sourceOrderId: CLOSE_ID,
  sourceOrderCreatedAt: CLOSE_AT.toISOString(),
  symbol: "XYZ",
  assetType: "EQUITY" as const,
};

describe("equity source close history", () => {
  it("orders venue events before reconstructing a partial close", async () => {
    const result = await readEquitySourceCloseContext(
      fakeDb(sourceOrder(), [
        // The database can return a later close first; event time is the
        // position history, not the query's row order.
        historyOrder({
          id: "source-prior-close",
          tradeAction: "Sell",
          executedQuantity: 25,
          createdAt: new Date("2026-08-01T13:30:00.000Z"),
          executedAt: new Date("2026-08-01T13:30:00.000Z"),
        }),
        historyOrder(),
      ]),
      input,
    );

    expect(result).toEqual({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      sourceCloseQty: 25,
      sourcePositionQty: 75,
    });
  });

  it("uses close execution time for a resting close with intervening history", async () => {
    const createdAt = new Date("2026-08-01T10:00:00.000Z");
    const executedAt = new Date("2026-08-01T10:10:00.000Z");
    const result = await readEquitySourceCloseContext(
      fakeDb(
        sourceOrder({
          createdAt,
          executedAt,
        }),
        [
          historyOrder({
            id: "source-original-open",
            createdAt: new Date("2026-08-01T09:00:00.000Z"),
            executedAt: new Date("2026-08-01T09:00:00.000Z"),
            executedQuantity: 100,
          }),
          historyOrder({
            id: "source-prior-partial-close",
            tradeAction: "Sell",
            createdAt: new Date("2026-08-01T09:30:00.000Z"),
            executedAt: new Date("2026-08-01T09:30:00.000Z"),
            executedQuantity: 25,
          }),
          historyOrder({
            id: "source-intervening-entry",
            createdAt: new Date("2026-08-01T10:05:00.000Z"),
            executedAt: new Date("2026-08-01T10:05:00.000Z"),
            executedQuantity: 50,
          }),
        ],
      ),
      {
        ...input,
        sourceOrderCreatedAt: createdAt.toISOString(),
      },
    );

    expect(result.sourceCloseQty).toBe(25);
    expect(result.sourcePositionQty).toBe(125);
  });

  it("fails closed when the source close has no authoritative account", async () => {
    const result = await readEquitySourceCloseContext(
      fakeDb(sourceOrder({ brokerAccountId: null }), [historyOrder()]),
      input,
    );

    expect(result).toMatchObject({
      sourceAccountId: null,
      sourceCloseQty: 0,
      sourcePositionQty: 0,
      reason: "source-history-unavailable",
    });
  });
});
