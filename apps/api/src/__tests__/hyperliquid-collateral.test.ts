/**
 * `hyperliquid.collateral`: free perp collateral for the desktop Balances tab.
 *
 * The contract that matters here is the fail-soft one. Every unknown must come
 * back as null, never as 0: the UI prints "-" for null, and a zeroed free-margin
 * cell would read as "you have no collateral to trade with", which is a
 * different and much more expensive statement to get wrong. A venue outage, an
 * account whose abstraction mode cannot be read (perpCollateral returns null by
 * design in that case), and an account with no wallet address must all reach the
 * client as "unknown".
 *
 * Real-module test through the actual router procedure (createCaller) with a
 * mock db; only the venue-touching seam (the keyless info client) is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "bun:test";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

const getRedisClient = vi.fn();
vi.mock("@trade-bot/redis", () => ({ getRedisClient }));

const actualHl = await import("../lib/hyperliquid.js");
const perpCollateralMock = vi.fn();
vi.mock("../lib/hyperliquid.js", () => ({
  ...actualHl,
  createHyperliquidInfoClient: () => ({ perpCollateral: perpCollateralMock }),
}));

const { hyperliquidRouter } = await import("../routers/hyperliquid.js");

const USER_ID = "user-1";
const MASTER = "0xAbCd000000000000000000000000000000001234";

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: USER_ID,
    provider: "hyperliquid",
    encryptedAccessToken: "enc",
    encryptedRefreshToken: "enc",
    accountId: MASTER,
    accountType: "LIVE",
    username: MASTER,
    baseUrl: "0x1111111111111111111111111111111111111111",
    expiresAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createCaller(credential: unknown) {
  const db = {
    query: {
      userApiCredentials: {
        findFirst: vi.fn().mockResolvedValue(credential),
      },
    },
  };
  return hyperliquidRouter.createCaller({
    db,
    session: { userId: USER_ID },
    userId: USER_ID,
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  } as never);
}

describe("hyperliquid.collateral", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports both figures, and the ledger that answered, for a funded account", async () => {
    perpCollateralMock.mockResolvedValue({
      freeUsd: "2010430.12",
      accountValueUsd: "3157260.45",
      source: "spot-unified",
    });

    const result = await createCaller(credentialRow()).collateral();

    expect(result).toEqual({
      enabled: true,
      freeUsd: "2010430.12",
      accountValueUsd: "3157260.45",
      source: "spot-unified",
    });
    expect(perpCollateralMock).toHaveBeenCalledWith(MASTER);
  });

  it("says 'not set up' when the user has no Hyperliquid credential, without calling the venue", async () => {
    const result = await createCaller(undefined).collateral();

    expect(result).toEqual({
      enabled: false,
      freeUsd: null,
      accountValueUsd: null,
      source: null,
    });
    expect(perpCollateralMock).not.toHaveBeenCalled();
  });

  it("reports unknown (never zero) when the venue read throws", async () => {
    perpCollateralMock.mockRejectedValue(new Error("Hyperliquid unreachable"));

    const result = await createCaller(credentialRow()).collateral();

    // Enabled stays true: the account exists, we just could not read it. Zero
    // here would tell a funded user they have nothing to trade with.
    expect(result).toEqual({
      enabled: true,
      freeUsd: null,
      accountValueUsd: null,
      source: null,
    });
  });

  it("reports unknown when perpCollateral itself declines to answer", async () => {
    // perpCollateral returns null for an unreadable abstraction mode or an
    // unparseable balance. That null must survive to the client rather than
    // being flattened into a number.
    perpCollateralMock.mockResolvedValue(null);

    const result = await createCaller(credentialRow()).collateral();

    expect(result.freeUsd).toBeNull();
    expect(result.accountValueUsd).toBeNull();
    expect(result.source).toBeNull();
    expect(result.enabled).toBe(true);
  });

  it("does not call the venue when the credential carries no wallet address", async () => {
    const result = await createCaller(
      credentialRow({ accountId: null, username: null }),
    ).collateral();

    expect(result).toEqual({
      enabled: true,
      freeUsd: null,
      accountValueUsd: null,
      source: null,
    });
    expect(perpCollateralMock).not.toHaveBeenCalled();
  });
});
