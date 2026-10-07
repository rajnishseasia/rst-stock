import { describe, it, expect } from "bun:test";
import {
  builderCodeFromEnv,
  builderMaxFeeRate,
  networkFromEnv,
  hyperliquidChain,
  isTestnet,
  DEFAULT_BUILDER_FEE_TENTHS_BPS,
} from "./config.js";

describe("networkFromEnv", () => {
  it("defaults to mainnet when unset", () => {
    expect(networkFromEnv({})).toBe("mainnet");
  });

  it("ignores HYPERLIQUID_NETWORK=testnet without the explicit opt-in (mainnet-only v1)", () => {
    // v1 is mainnet-only: a stray testnet env var must not point real order flow
    // at testnet. Falls back to mainnet unless HYPERLIQUID_ALLOW_TESTNET=true.
    expect(networkFromEnv({ HYPERLIQUID_NETWORK: "testnet" })).toBe("mainnet");
  });

  it("honors testnet only when HYPERLIQUID_ALLOW_TESTNET=true is also set", () => {
    expect(
      networkFromEnv({ HYPERLIQUID_NETWORK: "testnet", HYPERLIQUID_ALLOW_TESTNET: "true" }),
    ).toBe("testnet");
  });

  it("stays on mainnet when the opt-in is set but the network is not testnet", () => {
    expect(
      networkFromEnv({ HYPERLIQUID_NETWORK: "mainnet", HYPERLIQUID_ALLOW_TESTNET: "true" }),
    ).toBe("mainnet");
  });
});

describe("isTestnet / hyperliquidChain", () => {
  it("maps networks to the SDK testnet flag and signed-chain string", () => {
    expect(isTestnet("testnet")).toBe(true);
    expect(isTestnet("mainnet")).toBe(false);
    expect(hyperliquidChain("testnet")).toBe("Testnet");
    expect(hyperliquidChain("mainnet")).toBe("Mainnet");
  });
});

describe("builderMaxFeeRate", () => {
  it("formats tenths-of-a-bp as an HL percent string", () => {
    // 50 tenths-of-bp = 5 bps = 0.05%
    expect(builderMaxFeeRate({ address: "0x0", feeTenthsBps: 50 })).toBe("0.05%");
  });

  it("maps the HL cap of 1000 to 1%", () => {
    expect(builderMaxFeeRate({ address: "0x0", feeTenthsBps: 1000 })).toBe("1%");
  });

  it("maps a zero fee to 0%", () => {
    expect(builderMaxFeeRate({ address: "0x0", feeTenthsBps: 0 })).toBe("0%");
  });

  it("trims trailing zeros (100 tenths-of-bp = 0.1%)", () => {
    expect(builderMaxFeeRate({ address: "0x0", feeTenthsBps: 100 })).toBe("0.1%");
  });
});

describe("builderCodeFromEnv", () => {
  it("returns undefined when HL_BUILDER_ADDRESS is not set (builder fully OFF)", () => {
    // No address => no builder object ever attached, regardless of any stray fee.
    expect(builderCodeFromEnv({})).toBeUndefined();
    expect(builderCodeFromEnv({ HL_BUILDER_FEE_BPS: "100" })).toBeUndefined();
  });

  it("parses address + explicit fee from env (explicit fee is respected)", () => {
    const code = builderCodeFromEnv({
      HL_BUILDER_ADDRESS: "0x1234567890123456789012345678901234567890",
      HL_BUILDER_FEE_BPS: "50",
    });
    expect(code).toEqual({
      address: "0x1234567890123456789012345678901234567890",
      feeTenthsBps: 50,
    });
  });

  it("defaults the fee to 10 bps (100 tenths-of-bp) when only the address is set", () => {
    // Default fee = 10 bps = 0.10% = 100 tenths-of-a-basis-point.
    const code = builderCodeFromEnv({
      HL_BUILDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    });
    expect(code?.feeTenthsBps).toBe(100);
    expect(code?.feeTenthsBps).toBe(DEFAULT_BUILDER_FEE_TENTHS_BPS);
    // Sanity: the exported default renders as the 0.10% max-fee string.
    expect(builderMaxFeeRate({ address: code!.address, feeTenthsBps: code!.feeTenthsBps })).toBe(
      "0.1%",
    );
  });

  it("applies the default when HL_BUILDER_FEE_BPS is present but empty", () => {
    const code = builderCodeFromEnv({
      HL_BUILDER_ADDRESS: "0x1234567890123456789012345678901234567890",
      HL_BUILDER_FEE_BPS: "",
    });
    expect(code?.feeTenthsBps).toBe(100);
  });

  it("respects an explicit fee of 0 (does NOT fall back to the default)", () => {
    const code = builderCodeFromEnv({
      HL_BUILDER_ADDRESS: "0x1234567890123456789012345678901234567890",
      HL_BUILDER_FEE_BPS: "0",
    });
    expect(code?.feeTenthsBps).toBe(0);
  });

  it("rejects a malformed builder address", () => {
    expect(() => builderCodeFromEnv({ HL_BUILDER_ADDRESS: "not-an-address" })).toThrow();
  });

  it("rejects a fee above the HL cap of 1000 tenths-of-a-bp", () => {
    expect(() =>
      builderCodeFromEnv({
        HL_BUILDER_ADDRESS: "0x1234567890123456789012345678901234567890",
        HL_BUILDER_FEE_BPS: "2000",
      }),
    ).toThrow();
  });
});
