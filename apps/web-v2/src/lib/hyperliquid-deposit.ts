"use client";

/**
 * hyperliquid-deposit — CLIENT-SIDE native-USDC deposit into the HL bridge.
 *
 * FUND-CRITICAL. This module moves REAL money on Arbitrum mainnet: it sends the
 * user's native USDC to Hyperliquid's Bridge2 contract, which credits the same
 * address's Hyperliquid perps balance. The constants below are load-bearing and
 * VERBATIM from the go-live spec — a silent drift (wrong bridge, USDC.e instead
 * of native USDC, wrong decimals) would lose funds. The colocated test asserts
 * the exact literals so they can never change unnoticed.
 *
 *   - HL_BRIDGE_ARBITRUM: Hyperliquid Bridge2 on Arbitrum mainnet. USDC sent here
 *     is credited to the SAME sending address on Hyperliquid. Do NOT send to any
 *     other address.
 *   - USDC_ARBITRUM: NATIVE USDC on Arbitrum (Circle), 6 decimals. This is NOT
 *     bridged USDC.e (0xff970a...). Hyperliquid only credits native USDC.
 *   - HL_MIN_DEPOSIT_USDC: Hyperliquid rejects/ignores bridge deposits under this
 *     floor. We validate before signing so the user never burns gas on a deposit
 *     that won't be credited.
 *
 * The deposit itself is a plain ERC-20 `transfer(bridge, amount)` — Hyperliquid's
 * bridge watches inbound transfers, there is no bridge method to call. We read the
 * embedded wallet's USDC balance first and revert early on insufficient funds, and
 * expose a balance reader so the UI can gate the button and warn when the wallet
 * has no ETH for gas.
 */

import {
  createPublicClient,
  http,
  erc20Abi,
  parseUnits,
  formatUnits,
  type WalletClient,
  type PublicClient,
  type Account,
} from "viem";
import { arbitrum } from "viem/chains";

/**
 * Hyperliquid Bridge2 on Arbitrum mainnet. USDC transferred here is credited to
 * the SAME sending address's Hyperliquid balance. VERBATIM — never change.
 */
export const HL_BRIDGE_ARBITRUM =
  "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" as const;

/**
 * Native USDC (Circle) on Arbitrum. 6 decimals. VERBATIM — never change. This is
 * native USDC, NOT bridged USDC.e (0xff970a...); Hyperliquid only credits native.
 */
export const USDC_ARBITRUM =
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const;

/** Hyperliquid's minimum bridge deposit, in whole USDC. Below this is ignored. */
export const HL_MIN_DEPOSIT_USDC = 5;

/** Native USDC on Arbitrum has 6 decimals. */
const USDC_DECIMALS = 6;

/** Balances the UI needs to gate the deposit button. */
export interface PerpsWalletBalances {
  /** Native USDC balance in whole USDC (human units), e.g. 12.5. */
  usdc: number;
  /** Native ETH (gas) balance in whole ETH, e.g. 0.0021. */
  eth: number;
  /** Raw USDC balance in base units (6-dp), for exact-amount checks. */
  usdcRaw: bigint;
  /** Raw ETH balance in wei. */
  ethWei: bigint;
}

/** Narrow the wallet client's bound account or throw a clear error. */
function requireAccount(walletClient: WalletClient): Account {
  const account = walletClient.account;
  if (!account) {
    throw new Error(
      "Embedded wallet client has no bound account; cannot read balances or deposit.",
    );
  }
  return account;
}

/**
 * Shared read-only Arbitrum client over a plain public HTTP RPC.
 *
 * Balance reads (USDC `balanceOf`, native ETH) only need the wallet's ADDRESS, not
 * its signer — so we deliberately do NOT route them through Privy's embedded
 * EIP-1193 provider. That provider is only reliably available for signing while an
 * active Privy session is mounted; using it for reads left the deposit button
 * dead-gated whenever the provider wasn't ready. A public RPC keyed by address is
 * robust regardless of Privy session state; the embedded provider is reserved for
 * the signed `transfer` only. Lazily created so it isn't built during SSR/import.
 */
let _arbitrumPublicClient: PublicClient | null = null;
function getArbitrumPublicClient(): PublicClient {
  if (!_arbitrumPublicClient) {
    _arbitrumPublicClient = createPublicClient({
      chain: arbitrum,
      transport: http(),
    });
  }
  return _arbitrumPublicClient;
}

/**
 * Read an address's native-USDC balance and native ETH (gas) balance on Arbitrum
 * over a public RPC. The UI uses this to enable/disable the deposit button and to
 * warn when the wallet has no ETH for gas (the transfer would fail to broadcast).
 * `client` is injectable so tests can supply a fake without a live network call.
 */
export async function readPerpsWalletBalancesByAddress(
  address: `0x${string}`,
  client: PublicClient = getArbitrumPublicClient(),
): Promise<PerpsWalletBalances> {
  const [usdcRaw, ethWei] = await Promise.all([
    client.readContract({
      address: USDC_ARBITRUM,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    client.getBalance({ address }),
  ]);

  return {
    usdc: Number(formatUnits(usdcRaw, USDC_DECIMALS)),
    eth: Number(formatUnits(ethWei, 18)),
    usdcRaw,
    ethWei,
  };
}

/** Inputs for a native-USDC deposit into the Hyperliquid bridge. */
export interface DepositUsdcParams {
  /** viem WalletClient bound to the embedded master wallet (from usePerpsWallet). */
  walletClient: WalletClient;
  /** Amount to deposit, in whole USDC (human units). Must be >= HL_MIN_DEPOSIT_USDC. */
  amountUsdc: number;
  /**
   * Read-only client for the pre-flight balance check. Defaults to the public
   * Arbitrum RPC (NOT the embedded provider) so the insufficient-funds guard is
   * robust even when Privy's provider can't serve reads. Injectable for tests.
   */
  publicClient?: PublicClient;
}

/**
 * Deposit native USDC from the embedded wallet into Hyperliquid's Arbitrum bridge.
 *
 * Steps:
 *   1. Validate amount >= HL_MIN_DEPOSIT_USDC (finite, positive) — else throw.
 *   2. Read the wallet's native-USDC balance; revert early if it can't cover the
 *      amount (so the user never burns gas on a doomed transfer).
 *   3. `USDC.transfer(HL_BRIDGE_ARBITRUM, amount * 1e6)` on Arbitrum.
 *
 * Returns the transaction hash. NO retry: a blind resubmit after an ambiguous
 * failure could double-deposit. The caller polls the HL balance to confirm credit.
 */
export async function depositUsdcToHyperliquid(
  params: DepositUsdcParams,
): Promise<`0x${string}`> {
  const { walletClient, amountUsdc, publicClient } = params;

  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error("Deposit amount must be a positive number.");
  }
  if (amountUsdc < HL_MIN_DEPOSIT_USDC) {
    throw new Error(
      `Minimum Hyperliquid deposit is ${HL_MIN_DEPOSIT_USDC} USDC. ` +
        `Enter at least ${HL_MIN_DEPOSIT_USDC}.`,
    );
  }

  const account = requireAccount(walletClient);

  // Base-unit amount. parseUnits avoids float drift on the 6-dp conversion.
  const amountRaw = parseUnits(amountUsdc.toString(), USDC_DECIMALS);

  // Early insufficient-funds check against on-chain balance, read over the public
  // RPC (not the embedded provider) so it can't be dead-gated by a provider that
  // signs but won't serve reads.
  const { usdcRaw } = await readPerpsWalletBalancesByAddress(
    account.address,
    publicClient,
  );
  if (usdcRaw < amountRaw) {
    throw new Error(
      `Insufficient USDC. Wallet holds ${formatUnits(usdcRaw, USDC_DECIMALS)} USDC, ` +
        `deposit needs ${amountUsdc}.`,
    );
  }

  // ERC-20 transfer to the bridge, SIGNED by the embedded wallet. HL credits the
  // sending address on deposit.
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: USDC_ARBITRUM,
    abi: erc20Abi,
    functionName: "transfer",
    args: [HL_BRIDGE_ARBITRUM, amountRaw],
  });

  return hash;
}
