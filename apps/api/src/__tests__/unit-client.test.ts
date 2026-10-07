import { describe, expect, test, mock, afterEach } from "bun:test";
import {
  getUnitSolDepositAddress,
  getUnitSolDepositFee,
  isValidEvmAddress,
  solToLamports,
} from "../lib/unit-client.js";

describe("unit-client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("isValidEvmAddress", () => {
    test("accepts valid EVM addresses", () => {
      expect(
        isValidEvmAddress("0x6318aF88065432e41802e7a2FfBf2336EB74704b"),
      ).toBe(true);
      expect(
        isValidEvmAddress("0x0000000000000000000000000000000000000000"),
      ).toBe(true);
    });

    test("rejects invalid addresses", () => {
      expect(isValidEvmAddress("")).toBe(false);
      expect(isValidEvmAddress("0x123")).toBe(false);
      expect(isValidEvmAddress("solana-address-here")).toBe(false);
      expect(
        isValidEvmAddress("0x6318aF88065432e41802e7a2FfBf2336EB74704Z"),
      ).toBe(false);
    });
  });

  describe("solToLamports", () => {
    test("converts integer SOL string", () => {
      expect(solToLamports("1")).toBe(1_000_000_000n);
      expect(solToLamports("5")).toBe(5_000_000_000n);
    });

    test("converts fractional SOL string", () => {
      expect(solToLamports("0.5")).toBe(500_000_000n);
      expect(solToLamports("0.000000001")).toBe(1n);
      expect(solToLamports("1.234567890")).toBe(1_234_567_890n);
    });

    test("throws on invalid SOL input", () => {
      expect(() => solToLamports("abc")).toThrow();
      expect(() => solToLamports("1.1234567891")).toThrow(); // > 9 decimals
      expect(() => solToLamports("-1")).toThrow();
    });
  });

  describe("getUnitSolDepositAddress", () => {
    test("throws on invalid EVM address", async () => {
      expect(getUnitSolDepositAddress("not-an-address")).rejects.toThrow(
        "Invalid Hyperliquid EVM address",
      );
    });

    test("returns address on successful Unit API response", async () => {
      const mockSolAddress = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ address: mockSolAddress }),
        } as Response),
      );

      const result = await getUnitSolDepositAddress(
        "0x6318aF88065432e41802e7a2FfBf2336EB74704b",
      );
      expect(result).toBe(mockSolAddress);
    });

    test("throws on API error response", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Rate limit exceeded" }),
        } as Response),
      );

      expect(
        getUnitSolDepositAddress("0x6318aF88065432e41802e7a2FfBf2336EB74704b"),
      ).rejects.toThrow("Rate limit exceeded");
    });
  });

  describe("getUnitSolDepositFee", () => {
    test("returns deposit fee from estimate-fees endpoint", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              solana: { depositFee: "0.005" },
            }),
        } as Response),
      );

      const fee = await getUnitSolDepositFee();
      expect(fee).toBe("0.005");
    });

    test("returns null gracefully on failure", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Unavailable" }),
        } as Response),
      );

      const fee = await getUnitSolDepositFee();
      expect(fee).toBeNull();
    });
  });
});
