import { describe, expect, test } from "bun:test";

import {
  HL_BRIDGE_ARBITRUM,
  USDC_ARBITRUM,
  HL_MIN_DEPOSIT_USDC,
  depositUsdcToHyperliquid,
  readPerpsWalletBalancesByAddress,
} from "./hyperliquid-deposit";
import { erc20Abi, type PublicClient, type WalletClient } from "viem";

/**
 * Fake read-only client standing in for the public Arbitrum RPC. Returns fixed
 * USDC/ETH balances so the pre-flight gate and balance reader are tested with no
 * live network call. Uses REAL viem `erc20Abi` on the call shape it records.
 */
function makeFakePublicClient(opts: {
  usdcBalance: bigint;
  ethBalance?: bigint;
}) {
  const reads: Array<Record<string, unknown>> = [];
  const client = {
    async readContract(args: Record<string, unknown>) {
      reads.push(args);
      if (args.functionName === "balanceOf") return opts.usdcBalance;
      throw new Error(`unexpected read: ${String(args.functionName)}`);
    },
    async getBalance() {
      return opts.ethBalance ?? 0n;
    },
  } as unknown as PublicClient;
  return { client, reads };
}

/**
 * FUND-CRITICAL constant lock. These literals move real money; the exact-string
 * assertions here fail loudly if anyone edits the address or floor. Lowercase-
 * exact so a checksum-cased or USDC.e paste can never slip through.
 */
describe("fund-critical constants", () => {
  test("HL bridge address is the exact Arbitrum Bridge2 literal", () => {
    // Widen to string so this asserts the runtime value, not just the literal type.
    expect(HL_BRIDGE_ARBITRUM as string).toBe(
      "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
    );
    // Lowercase-exact: never a checksum variant.
    expect(HL_BRIDGE_ARBITRUM as string).toBe(
      (HL_BRIDGE_ARBITRUM as string).toLowerCase(),
    );
  });

  test("USDC address is NATIVE Arbitrum USDC, not USDC.e", () => {
    expect(USDC_ARBITRUM as string).toBe(
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    );
    // Guard specifically against the bridged USDC.e address.
    expect(USDC_ARBITRUM as string).not.toBe(
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    );
    expect(USDC_ARBITRUM as string).toBe(
      (USDC_ARBITRUM as string).toLowerCase(),
    );
  });

  test("minimum deposit is 5 USDC", () => {
    expect(HL_MIN_DEPOSIT_USDC).toBe(5);
  });
});

/**
 * Minimal fake WalletClient used only for the SIGNED transfer: it exposes the
 * bound account/chain and records `writeContract` calls so the transfer
 * target/amount are verified against REAL viem `erc20Abi` (imported, not stubbed).
 * Balance reads no longer route through the wallet client — they use an injected
 * public client (see makeFakePublicClient).
 */
function makeFakeWallet(opts?: { address?: `0x${string}` }) {
  const address =
    opts?.address ?? ("0x1111111111111111111111111111111111111111" as const);
  const calls: { write: Array<Record<string, unknown>> } = { write: [] };

  const account = { address, type: "json-rpc" as const };
  const chain = { id: 42161 };

  const client = {
    account,
    chain,
    async writeContract(args: Record<string, unknown>) {
      calls.write.push(args);
      return "0xdeadbeef" as const;
    },
  } as unknown as WalletClient;

  return { client, calls, address };
}

describe("depositUsdcToHyperliquid — validation", () => {
  test("rejects amounts below the 5 USDC minimum before any on-chain call", async () => {
    const { client, calls } = makeFakeWallet();
    const { client: pub, reads } = makeFakePublicClient({
      usdcBalance: 100_000_000n,
    });
    await expect(
      depositUsdcToHyperliquid({
        walletClient: client,
        amountUsdc: 4.99,
        publicClient: pub,
      }),
    ).rejects.toThrow(/Minimum Hyperliquid deposit is 5 USDC/);
    expect(reads.length).toBe(0);
    expect(calls.write.length).toBe(0);
  });

  test("rejects non-positive / non-finite amounts", async () => {
    const { client } = makeFakeWallet();
    const { client: pub } = makeFakePublicClient({ usdcBalance: 100_000_000n });
    await expect(
      depositUsdcToHyperliquid({
        walletClient: client,
        amountUsdc: 0,
        publicClient: pub,
      }),
    ).rejects.toThrow(/positive number/);
    await expect(
      depositUsdcToHyperliquid({
        walletClient: client,
        amountUsdc: Number.NaN,
        publicClient: pub,
      }),
    ).rejects.toThrow(/positive number/);
  });

  test("accepts an amount exactly at the 5 USDC minimum", async () => {
    // Boundary: amountUsdc === HL_MIN_DEPOSIT_USDC must NOT be rejected.
    const { client, calls } = makeFakeWallet();
    const { client: pub } = makeFakePublicClient({ usdcBalance: 100_000_000n });
    const hash = await depositUsdcToHyperliquid({
      walletClient: client,
      amountUsdc: HL_MIN_DEPOSIT_USDC,
      publicClient: pub,
    });
    expect(hash).toBe("0xdeadbeef");
    expect(calls.write.length).toBe(1);
    expect((calls.write[0] as { args: unknown[] }).args).toEqual([
      HL_BRIDGE_ARBITRUM,
      5_000_000n,
    ]);
  });

  test("accepts a deposit when the balance exactly equals the amount (>= boundary)", async () => {
    // The guard is `usdcRaw < amountRaw`: an exact-balance deposit must pass.
    const { client, calls } = makeFakeWallet();
    const { client: pub } = makeFakePublicClient({ usdcBalance: 10_000_000n });
    const hash = await depositUsdcToHyperliquid({
      walletClient: client,
      amountUsdc: 10,
      publicClient: pub,
    });
    expect(hash).toBe("0xdeadbeef");
    expect(calls.write.length).toBe(1);
  });

  test("reverts early when USDC balance can't cover the deposit (no transfer)", async () => {
    // 4 USDC on hand (4_000_000 base units), asking to deposit 10.
    const { client, calls } = makeFakeWallet();
    const { client: pub, reads } = makeFakePublicClient({
      usdcBalance: 4_000_000n,
    });
    await expect(
      depositUsdcToHyperliquid({
        walletClient: client,
        amountUsdc: 10,
        publicClient: pub,
      }),
    ).rejects.toThrow(/Insufficient USDC/);
    // The balance was read (once, via the public client), but no transfer was sent.
    expect(reads.length).toBe(1);
    expect(calls.write.length).toBe(0);
  });
});

describe("depositUsdcToHyperliquid — transfer shaping", () => {
  test("transfers native USDC to the bridge with 6-decimal base units", async () => {
    // 50 USDC balance; deposit 12.5 -> 12_500_000 base units.
    const { client, calls } = makeFakeWallet();
    const { client: pub } = makeFakePublicClient({ usdcBalance: 50_000_000n });
    const hash = await depositUsdcToHyperliquid({
      walletClient: client,
      amountUsdc: 12.5,
      publicClient: pub,
    });
    expect(hash).toBe("0xdeadbeef");
    expect(calls.write.length).toBe(1);
    const w = calls.write[0];
    expect(w.address).toBe(USDC_ARBITRUM);
    expect(w.abi).toBe(erc20Abi);
    expect(w.functionName).toBe("transfer");
    expect(w.args).toEqual([HL_BRIDGE_ARBITRUM, 12_500_000n]);
  });
});

describe("readPerpsWalletBalancesByAddress", () => {
  test("returns human + raw USDC and ETH balances", async () => {
    const { client } = makeFakePublicClient({
      usdcBalance: 12_500_000n, // 12.5 USDC
      ethBalance: 2_100_000_000_000_000n, // 0.0021 ETH
    });
    const balances = await readPerpsWalletBalancesByAddress(
      "0x1111111111111111111111111111111111111111",
      client,
    );
    expect(balances.usdc).toBe(12.5);
    expect(balances.usdcRaw).toBe(12_500_000n);
    expect(balances.eth).toBeCloseTo(0.0021, 6);
    expect(balances.ethWei).toBe(2_100_000_000_000_000n);
  });
});
