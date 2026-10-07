import { beforeEach, describe, expect, it, vi } from "bun:test";

const mockGetDecryptedCredentials = vi.fn();
const mockAlpacaClient = vi.fn().mockImplementation(() => ({}));

vi.mock("../lib/credentials.js", () => ({
  getDecryptedCredentials: mockGetDecryptedCredentials,
}));

vi.mock("@trade-bot/alpaca", () => ({
  AlpacaClient: mockAlpacaClient,
}));

describe("Alpaca credential client configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults Alpaca package configuration to live trading", async () => {
    const { AlpacaConfigSchema } = await import("@trade-bot/alpaca/config");

    const config = AlpacaConfigSchema.parse({
      keyId: "live-key-id",
      secretKey: "live-secret-key",
    });

    expect(config.paper).toBe(false);
  });

  it("uses live Alpaca when stored credentials do not include an account type", async () => {
    mockGetDecryptedCredentials.mockResolvedValue({
      credentialId: "live-credential",
      username: "live-key-id",
      accessToken: "live-secret-key",
      accountType: null,
      accountId: "live-account",
      baseUrl: null,
      provider: "alpaca",
      refreshToken: null,
    });

    const { getAlpacaClient } = await import("../lib/alpaca.js");

    await getAlpacaClient({} as any, "user-id");

    expect(mockAlpacaClient).toHaveBeenCalledWith({
      keyId: "live-key-id",
      secretKey: "live-secret-key",
      paper: false,
    });
  });

  it("uses paper Alpaca when stored credentials are marked as paper", async () => {
    mockGetDecryptedCredentials.mockResolvedValue({
      credentialId: "paper-credential",
      username: "paper-key-id",
      accessToken: "paper-secret-key",
      accountType: "PAPER",
      accountId: "paper-account",
      baseUrl: null,
      provider: "alpaca",
      refreshToken: null,
    });

    const { getAlpacaClient } = await import("../lib/alpaca.js");

    await getAlpacaClient({} as any, "user-id");

    expect(mockAlpacaClient).toHaveBeenCalledWith({
      keyId: "paper-key-id",
      secretKey: "paper-secret-key",
      paper: true,
    });
  });

  it("keeps legacy SIM credentials on paper Alpaca", async () => {
    mockGetDecryptedCredentials.mockResolvedValue({
      credentialId: "sim-credential",
      username: "sim-key-id",
      accessToken: "sim-secret-key",
      accountType: "SIM",
      accountId: "sim-account",
      baseUrl: null,
      provider: "alpaca",
      refreshToken: null,
    });

    const { getAlpacaClient } = await import("../lib/alpaca.js");

    await getAlpacaClient({} as any, "user-id");

    expect(mockAlpacaClient).toHaveBeenCalledWith({
      keyId: "sim-key-id",
      secretKey: "sim-secret-key",
      paper: true,
    });
  });
});
