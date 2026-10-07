/**
 * buildStockChatContext must never hand the AI chat model day-trade / PDT
 * data. The product removed day-trade tracking entirely
 * (docs/superpowers/plans/2026-06-09-remove-day-trades.md); this function
 * used to include a `Day trade count: N` line pulled straight from Alpaca's
 * account payload.
 *
 * Alpaca's real `/v2/account` response still reports `daytrade_count` today,
 * so the regression this guards against is real: a future change that spreads
 * more of the raw account object into the prompt would silently reintroduce
 * it. This test hands the function a mocked Alpaca payload that DOES include
 * the field and asserts the built context string never mentions it, while
 * still confirming the account summary lines that ARE meant to reach the
 * model are present.
 *
 * Real module test: only the two I/O boundaries (Alpaca client construction,
 * public-company research) are mocked; buildStockChatContext itself runs for
 * real.
 */

import { afterAll, describe, expect, it, mock, vi } from "bun:test";

const getAlpacaClient = vi.fn();

// Same relative specifiers stock-context.ts itself imports, so both resolve
// to the identical module Bun mocks here.
vi.mock("../alpaca.js", () => ({ getAlpacaClient }));
vi.mock("../research/market-research.js", () => ({
  getMarketResearchForSymbol: vi.fn().mockResolvedValue({
    company: null,
    filings: [],
    news: [],
    warnings: [],
  }),
}));

const { buildStockChatContext } = await import("./stock-context.js");

afterAll(() => {
  mock.restore();
});

const DAY_TRADE_PATTERN = /day[ _-]?trades?|daytrade|pattern[ _-]?day[ _-]?trader|\bPDT\b/i;

/** A real Alpaca `/v2/account` response shape, day-trade fields included. */
const ALPACA_ACCOUNT = {
  status: "ACTIVE",
  portfolio_value: "20000",
  cash: "5000",
  buying_power: "10000",
  trading_blocked: false,
  // Alpaca still reports this; the product just refuses to surface it.
  daytrade_count: 4,
  pattern_day_trader: true,
};

describe("buildStockChatContext", () => {
  it("never mentions day trades even though Alpaca's payload includes daytrade_count", async () => {
    getAlpacaClient.mockResolvedValue({
      client: {
        getAccount: vi.fn().mockResolvedValue(ALPACA_ACCOUNT),
        getPositions: vi.fn().mockResolvedValue([]),
        getOrders: vi.fn().mockResolvedValue([]),
      },
      credentials: { accountType: "PAPER" },
    });

    const { context } = await buildStockChatContext({
      db: {} as never,
      userId: "user-1",
      alpacaCredentialId: "cred-1",
      activeAccountType: "PAPER",
    });

    expect(context).not.toMatch(DAY_TRADE_PATTERN);
    // Sanity check the render actually reached the account summary section -
    // an empty/failed fetch would vacuously pass the assertion above.
    expect(context).toContain("Portfolio value: $20,000");
    expect(context).toContain("Cash: $5,000");
    expect(context).toContain("Buying power: $10,000");
  });
});
