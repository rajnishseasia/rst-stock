/**
 * `positions.list` must annotate positions with RPNL, and must survive without
 * it.
 *
 * The realized-P&L column is reconstructed from a third Alpaca call (the closed
 * order history), because the position payload carries unrealized P&L only.
 * That makes the positions table, the most load-bearing view in the app,
 * depend on a read it does not otherwise need. The regression guarded here is
 * the obvious one: a future change that drops the fetch into the same
 * `Promise.all` without its own catch turns a history hiccup into an empty
 * positions table.
 *
 * The FIFO replay itself is unit-tested in `realized-pnl.test.ts`; what this
 * asserts is the wiring through the real procedure.
 *
 * Real module test through the actual router procedure (createCaller). Run in
 * an isolated Bun process by order-idempotency-router.test.ts because Bun's
 * module mocks are process-wide.
 */

import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";

const getDecryptedCredentials = vi.fn();
const createAlpacaClientFromCredentials = vi.fn();
const getAlpacaClient = vi.fn(
  async (db: unknown, userId: string, selector?: Record<string, unknown>) => {
    const credentials = await getDecryptedCredentials(db, userId, {
      provider: "alpaca",
      ...selector,
    });
    return { client: createAlpacaClientFromCredentials(credentials), credentials };
  },
);

vi.mock("../lib/credentials.js", () => ({ getDecryptedCredentials }));
vi.mock("../lib/alpaca.js", () => ({
  createAlpacaClientFromCredentials,
  getAlpacaClient,
  isPaperAccount: (accountType: string) =>
    accountType === "PAPER" || accountType === "SIM",
}));

const { positionsRouter } = await import("../routers/positions.js");

afterAll(() => {
  mock.restore();
});

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Drizzle's builder chain for the copy-attribution lookup, resolving to none.
 *
 * Built on a real promise with the chain methods hung off it, rather than an
 * object literal carrying `then`. A hand-rolled thenable behaves the same here
 * but is what `unicorn/no-thenable` forbids, because anything that grows a
 * `then` becomes silently awaitable everywhere it is passed.
 */
function db() {
  const chain = Promise.resolve([] as unknown[]) as Record<string, unknown>;
  for (const method of ["select", "from", "where", "orderBy"]) {
    chain[method] = () => chain;
  }
  return chain;
}

function caller() {
  return positionsRouter.createCaller({
    db: db() as never,
    session: { userId: "user-a" },
    userId: "user-a",
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
  } as never);
}

/** An Alpaca position payload with only the fields the mapping reads. */
function position(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL",
    asset_class: "us_equity",
    exchange: "NASDAQ",
    qty: "6",
    qty_available: "6",
    side: "long",
    avg_entry_price: "100",
    current_price: "130",
    lastday_price: "128",
    market_value: "780",
    cost_basis: "600",
    unrealized_pl: "180",
    unrealized_plpc: "0.3",
    unrealized_intraday_pl: "12",
    unrealized_intraday_plpc: "0.015",
    change_today: "0.0156",
    ...overrides,
  };
}

/** A closed order, in the shape the FIFO replay reads. */
function closedOrder(
  id: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  second: number,
) {
  const at = `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
  return {
    id,
    symbol: "AAPL",
    side,
    filled_qty: String(qty),
    filled_avg_price: String(price),
    filled_at: at,
    submitted_at: at,
    status: "filled",
    asset_class: "us_equity",
    order_type: "market",
    client_order_id: id,
    qty: String(qty),
  };
}

/** 10 shares bought at 100, 4 sold at 120: 6 still held, $80 banked. */
const SCALE_OUT_HISTORY = [
  closedOrder("close-1", "sell", 4, 120, 2),
  closedOrder("open-1", "buy", 10, 100, 1),
];

function client(closedOrders: unknown) {
  return {
    getPositions: vi.fn().mockResolvedValue([position()]),
    getOrders: vi.fn(async (status: string) =>
      status === "closed"
        ? typeof closedOrders === "function"
          ? (closedOrders as () => never)()
          : closedOrders
        : [],
    ),
  };
}

describe("positions.list realized P&L", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDecryptedCredentials.mockResolvedValue({
      username: "key",
      accessToken: "secret",
      accountType: "PAPER",
      accountId: "account-1",
      credentialId: CREDENTIAL_ID,
    });
  });

  it("reports the P&L banked on the still-open position", async () => {
    createAlpacaClientFromCredentials.mockReturnValue(client(SCALE_OUT_HISTORY));

    const [row] = await caller().list({ credentialId: CREDENTIAL_ID });

    expect(row?.realizedPnl).toBe(80);
    // The unrealized half is untouched by the annotation.
    expect(row?.unrealizedPL).toBe(180);
  });

  it("reports null rather than a partial total when the window misses the entry", async () => {
    // Only the scale-out is inside the window, so the replay reconstructs a
    // short 4 against a live long 6.
    createAlpacaClientFromCredentials.mockReturnValue(client([SCALE_OUT_HISTORY[0]]));

    const [row] = await caller().list({ credentialId: CREDENTIAL_ID });

    expect(row?.realizedPnl).toBeNull();
  });

  it("still returns positions when the history read fails", async () => {
    createAlpacaClientFromCredentials.mockReturnValue(
      client(() => {
        throw new Error("alpaca 500");
      }),
    );

    const [row] = await caller().list({ credentialId: CREDENTIAL_ID });

    expect(row?.symbol).toBe("AAPL");
    expect(row?.unrealizedPL).toBe(180);
    expect(row?.realizedPnl).toBeNull();
  });
});
