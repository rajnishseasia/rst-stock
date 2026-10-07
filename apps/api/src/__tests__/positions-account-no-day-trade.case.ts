/**
 * positions.account must never surface day-trade / PDT data.
 *
 * The product removed day-trade tracking entirely
 * (docs/superpowers/plans/2026-06-09-remove-day-trades.md): the `account`
 * procedure used to forward `daytradeCount` / `patternDayTrader` straight
 * from Alpaca's account payload, and the UI showed a "Day Trades" figure
 * with a PDT badge next to it. Both were deleted from the procedure and the
 * component.
 *
 * Alpaca's real `/v2/account` response still reports `daytrade_count` and
 * `pattern_day_trader` today - the broker didn't remove the feature, this
 * product did. So the regression this guards against is real: a future
 * change re-spreading the raw account object (`...account`) instead of
 * naming each field would silently bring the two fields straight back. This
 * test proves that by handing the procedure a mocked Alpaca payload that
 * DOES include both fields and asserting neither survives into the response.
 *
 * Real module test through the actual router procedure (createCaller),
 * This file is run in an isolated Bun process by
 * order-idempotency-router.test.ts because Bun's module mocks are process-wide.
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

function logger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function caller() {
  return positionsRouter.createCaller({
    db: {} as never,
    session: { userId: "user-a" },
    userId: "user-a",
    logger: logger() as never,
  } as never);
}

/** A real Alpaca `/v2/account` response shape, day-trade fields included. */
const ALPACA_ACCOUNT = {
  account_number: "PA3ABC123456",
  status: "ACTIVE",
  currency: "USD",
  buying_power: "10000",
  non_marginable_buying_power: "8000",
  regt_buying_power: "16000",
  cash: "5000",
  portfolio_value: "20000",
  equity: "20000",
  last_equity: "19000",
  long_market_value: "15000",
  short_market_value: "0",
  initial_margin: "0",
  maintenance_margin: "0",
  trading_blocked: false,
  shorting_enabled: true,
  // Alpaca still reports these; the product just refuses to forward them.
  daytrade_count: 4,
  pattern_day_trader: true,
};

describe("positions.account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDecryptedCredentials.mockResolvedValue({
      username: "key",
      accessToken: "secret",
      accountType: "PAPER",
      accountId: "account-1",
      credentialId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("omits daytradeCount and patternDayTrader even though Alpaca returns them", async () => {
    createAlpacaClientFromCredentials.mockReturnValue({
      getAccount: vi.fn().mockResolvedValue(ALPACA_ACCOUNT),
    });

    const result = await caller().account({
      credentialId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).not.toHaveProperty("daytradeCount");
    expect(result).not.toHaveProperty("patternDayTrader");
    expect(JSON.stringify(result)).not.toMatch(/daytrade|pattern.?day.?trader/i);
  });

  it("still returns the account fields the UI actually uses", async () => {
    createAlpacaClientFromCredentials.mockReturnValue({
      getAccount: vi.fn().mockResolvedValue(ALPACA_ACCOUNT),
    });

    const result = await caller().account({
      credentialId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toMatchObject({
      cash: 5000,
      portfolioValue: 20000,
      nonMarginableBuyingPower: 8000,
      buyingPower: 10000,
      tradingBlocked: false,
      shortingEnabled: true,
    });
  });
});
