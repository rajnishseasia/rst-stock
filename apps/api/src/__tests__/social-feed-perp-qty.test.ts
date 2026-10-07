/**
 * social.feed perp quantity
 *
 * `hyperliquid-order-sync` writes a LEGACY INTEGER placeholder (`qty: 1`) into
 * `social_trades` for every perp fill and leaves the exact size on the joined
 * child order's `executedSizeDecimal`. Consumers are expected to honour that
 * contract: `copy-trade.mapUserTradeToItem` already does. `social.feed` did not,
 * so the Community Trades panel rendered a 0.004 BTC fill as "BUY BTC x 1
 * @ $95,000.00", i.e. a ~$95,000 position instead of a ~$380 one, next to a
 * per-coin fill price that IS read from the joined order. Users pick whom to
 * follow and auto-mirror from that panel, so the overstatement is acted on.
 */

import { describe, expect, it, vi } from "bun:test";
import { getTableName } from "drizzle-orm";
import { schema } from "@trade-bot/db";

// The rate limiter on `protectedProcedure` reaches for a Redis client. Stub the
// factory: the middleware already treats an unusable client as "allow", so the
// feed query runs without a live Redis and without weakening any assertion.
const getRedisClient = vi.fn();
vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const { socialRouter } = await import("../routers/social.js");

/**
 * "<table>.<column>" key for a drizzle column, e.g. "orders.executed_price".
 *
 * Read through the table's BASE name so an aliased table (the router aliases
 * both sides of this join) keys the same way the bare schema table does: what
 * is under test is which COLUMN the query reads, never what the alias is
 * called.
 */
function colKey(column: unknown): string {
  const c = column as { name: string; table: Record<symbol, string> };
  const base = c.table[Symbol.for("drizzle:BaseName")] ?? getTableName(c.table as never);
  return `${base}.${c.name}`;
}

/** A select spec entry that is a real column, rather than a SQL expression. */
function isColumn(value: unknown): boolean {
  const candidate = value as { name?: unknown; table?: unknown } | null;
  return Boolean(candidate && typeof candidate.name === "string" && candidate.table);
}

type DbRow = Record<string, unknown>;

/**
 * Minimal drizzle select stand-in, faithful to Postgres in the one respect this
 * test turns on: a returned row carries ONLY the columns the query asked for.
 * Fixture rows are therefore keyed by the underlying schema column rather than
 * by the router's chosen alias, so the test measures WHICH COLUMNS THE ROUTER
 * SELECTS, and cannot be satisfied by renaming an alias.
 */
function createFeedDb(rows: DbRow[], joinConditions: unknown[] = []) {
  const project = (spec: Record<string, unknown>) =>
    rows.map((row) => {
      const projected: DbRow = {};
      for (const [alias, column] of Object.entries(spec)) {
        if (!isColumn(column)) {
          // A SQL expression rather than a column (the router derives `side`
          // from the joined trade action). Nothing to project it from.
          projected[alias] = null;
          continue;
        }
        const key = colKey(column);
        projected[alias] = key in row ? row[key] : null;
      }
      return projected;
    });

  return {
    select(spec: Record<string, unknown>) {
      const chain = {
        from: () => chain,
        innerJoin: (_table: unknown, condition: unknown) => {
          // The orders join is an INNER join now (a feed row without an
          // authoritative order is not shown at all), so the predicate under
          // test arrives here rather than on leftJoin. The users join carries
          // no orders column and is filtered out by the assertion itself.
          joinConditions.push(condition);
          return chain;
        },
        // The join PREDICATE is recorded, not just the fact that a join
        // happened. Which columns it constrains is the behaviour under test
        // below, and a stand-in that swallows the condition cannot see it.
        leftJoin: (_table: unknown, condition: unknown) => {
          joinConditions.push(condition);
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: async () => project(spec),
      };
      return chain;
    },
  };
}

/**
 * Every column a drizzle condition tree constrains, as "<table>.<column>".
 *
 * Walks the SQL object rather than matching source text, so the assertion holds
 * on the real expression the router hands drizzle. `and(eq(a, b), eq(c, d))`
 * nests its operands in `queryChunks`, and a column is the node carrying both a
 * `name` and a `table`.
 */
function conditionColumns(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  if (typeof record.name === "string" && record.table) {
    out.add(colKey(node));
    return out;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach((entry) => conditionColumns(entry, out));
    else conditionColumns(value, out);
  }
  return out;
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function callFeed(rows: DbRow[], joinConditions: unknown[] = []) {
  const caller = socialRouter.createCaller({
    db: createFeedDb(rows, joinConditions) as never,
    session: { userId: "viewer-1" } as never,
    userId: "viewer-1",
    logger: createLogger() as never,
  } as never);
  return caller.feed({ limit: 50 });
}

const baseRow: DbRow = {
  [colKey(schema.socialTrades.id)]: "trade-1",
  [colKey(schema.socialTrades.userId)]: "source-user-1",
  [colKey(schema.socialTrades.symbol)]: "BTC",
  [colKey(schema.socialTrades.side)]: "buy",
  [colKey(schema.socialTrades.orderType)]: "market",
  [colKey(schema.socialTrades.limitPrice)]: null,
  [colKey(schema.socialTrades.createdAt)]: new Date("2026-08-19T12:00:00.000Z"),
};

describe("social.feed perp quantity", () => {
  it("reports the exact joined decimal size for a shared perp fill", async () => {
    const feed = await callFeed([
      {
        ...baseRow,
        // Placeholder written by hyperliquid-order-sync, NOT the real size.
        [colKey(schema.socialTrades.qty)]: 1,
        [colKey(schema.socialTrades.assetType)]: "PERP",
        [colKey(schema.orders.assetType)]: "PERP",
        [colKey(schema.orders.executedPrice)]: "95000",
        [colKey(schema.orders.executedSizeDecimal)]: "0.004",
      },
    ]);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.qty).toBe(0.004);
    // The fill price was always read from the joined order; it is asserted here
    // so a regression cannot "fix" the size by dropping the orders join.
    expect(feed[0]?.fillPrice).toBe(95000);
  });

  it("keeps the stored integer size for an equity fill", async () => {
    const feed = await callFeed([
      {
        ...baseRow,
        [colKey(schema.socialTrades.symbol)]: "NVDA",
        [colKey(schema.socialTrades.qty)]: 4,
        [colKey(schema.socialTrades.assetType)]: "EQUITY",
        [colKey(schema.orders.assetType)]: "EQUITY",
        [colKey(schema.orders.executedPrice)]: "170.00",
        // An equity order also carries an executed size. It must NOT override the
        // share count, so the perp handling cannot leak into ordinary buys.
        [colKey(schema.orders.executedSizeDecimal)]: "0.5",
      },
    ]);

    expect(feed[0]?.qty).toBe(4);
  });

  it("falls back to the stored size when a perp row has no joined executed size", async () => {
    const feed = await callFeed([
      {
        ...baseRow,
        [colKey(schema.socialTrades.qty)]: 1,
        [colKey(schema.socialTrades.assetType)]: "PERP",
        [colKey(schema.orders.assetType)]: "PERP",
        // Legacy row, or an order that has not been reconciled yet: the left
        // join yields NULL. Better the placeholder than NaN or 0 in the feed.
        [colKey(schema.orders.executedPrice)]: null,
        [colKey(schema.orders.executedSizeDecimal)]: null,
      },
    ]);

    expect(feed[0]?.qty).toBe(1);
  });
});

/**
 * The orders join must be scoped to the trade's OWNER, not to the broker order
 * id alone.
 *
 * `brokerOrderId` is only unique per ACCOUNT, not globally: Hyperliquid order
 * ids are account-scoped integers, so two users can genuinely hold the same
 * value. Joined on that column alone, another user's order can attach to this
 * social trade, and the columns this feed reads FROM the joined order are
 * exactly the ones that would then be wrong: `executedSizeDecimal` sets the
 * displayed perp size and `executedPrice` sets the fill price. A single trade
 * row can also fan out into several conflicting rows.
 *
 * The three sibling consumers of this same join already scope by owner
 * (`copy-trade.ts`, `leaderboard.ts`, `copy-mirror-candidate-sources.ts`).
 * `social.feed` was the one that did not, which is the same one-path-fixed,
 * sibling-missed shape this branch has corrected several times.
 */
describe("social.feed orders join scope", () => {
  it("constrains the orders join by owner as well as broker order id", async () => {
    const joins: unknown[] = [];
    await callFeed([{ ...baseRow, [colKey(schema.socialTrades.qty)]: 1 }], joins);

    // Two joins are issued (users for the pseudonym, orders for the fill); the
    // one under test is whichever constrains an orders column.
    const ordersJoin = joins.find((join) =>
      [...conditionColumns(join)].some((column) => column.startsWith("orders.")),
    );
    expect(ordersJoin).toBeDefined();
    const columns = conditionColumns(ordersJoin);

    // The broker-order-id pairing, which was always there.
    expect(columns).toContain(colKey(schema.socialTrades.brokerOrderId));
    expect(columns).toContain(colKey(schema.orders.brokerOrderId));
    // The owner pairing, which is what stops a foreign order attaching.
    expect(columns).toContain(colKey(schema.socialTrades.userId));
    expect(columns).toContain(colKey(schema.orders.userId));
  });
});
