"use client";

/**
 * hyperliquid-activate — CLIENT-SIDE, master-signed agent approval.
 *
 * Client-side master-signed setup for the perps flow. The embedded wallet sets
 * unified account mode when needed, signs `approveAgent`, and optionally signs
 * `approveBuilderFee`. That authorizes our server-controlled AGENT wallet to
 * place orders on the user's behalf. Orders themselves stay agent-signed
 * server-side (popup-free).
 *
 * We talk to `@nktkas/hyperliquid` DIRECTLY (ExchangeClient + HttpTransport) with
 * a viem WalletClient built from the embedded wallet's EIP-1193 provider — the
 * same construction the SDK's browser-wallet guide uses. This deliberately does
 * NOT reuse the server `@trade-bot/hyperliquid` wrapper (which is bound to a
 * Privy server account); it keeps the browser bundle off the server plumbing.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { AbstractViemJsonRpcAccount } from "@nktkas/hyperliquid/signing";
import type { TypedDataDefinition, WalletClient } from "viem";

/**
 * True only for Hyperliquid's definitive refusal that an agent address has
 * already been used. A timeout or ambiguous transport failure must never
 * trigger rotation because the first approval may actually have landed.
 */
export function isReusedHyperliquidAgentError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("message" in error)) return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /^extra agent already used\.?$/iu.test(message.trim())
  );
}

/**
 * Approve a prepared agent and recover exactly once when Hyperliquid
 * definitively says that address was used before. The replacement approval is
 * intentionally outside the catch, so a second refusal or an ambiguous error
 * is surfaced instead of rotating recursively.
 */
export async function activateAgentWithReuseRecovery<T>({
  initial,
  activate,
  rotate,
}: {
  initial: T;
  activate: (agent: T) => Promise<void>;
  rotate: (failedAgent: T) => Promise<T>;
}): Promise<T> {
  try {
    await activate(initial);
    return initial;
  } catch (error) {
    if (!isReusedHyperliquidAgentError(error)) throw error;
  }

  const replacement = await rotate(initial);
  await activate(replacement);
  return replacement;
}

/**
 * Adapt a viem `WalletClient` (from the embedded wallet's EIP-1193 provider) to
 * the SDK's `AbstractViemJsonRpcAccount` interface.
 *
 * Why an adapter and not the raw WalletClient: the SDK's JSON-RPC-account shape
 * has `signTypedData(params)` with NO `account` field, whereas viem's
 * `WalletClient.signTypedData` requires `account` because the client's account
 * is typed `Account | undefined`. This adapter binds the client's own account
 * into each call, so the SDK sees a conforming signer without us re-reading the
 * account or duplicating the WalletClient's account plumbing.
 */
function toJsonRpcSigner(
  walletClient: WalletClient,
): AbstractViemJsonRpcAccount {
  const account = walletClient.account;
  if (!account) {
    throw new Error(
      "Embedded wallet client has no bound account; cannot sign HL actions.",
    );
  }
  return {
    signTypedData: (params) =>
      walletClient.signTypedData({
        account,
        ...(params as TypedDataDefinition),
      }),
    getAddresses: () => walletClient.getAddresses(),
    getChainId: () => walletClient.getChainId(),
  };
}

export type AccountAbstractionMode =
  | "default"
  | "disabled"
  | "dexAbstraction"
  | "unifiedAccount"
  | "portfolioMargin";

export function isHip3ReadyMode(mode: AccountAbstractionMode): boolean {
  return (
    mode === "unifiedAccount" ||
    mode === "portfolioMargin" ||
    mode === "dexAbstraction"
  );
}

/**
 * Whether the order-review dialog should warn about the one-time Unified-mode
 * change.
 *
 * The warning used to be gated on the COIN alone, so every user reviewing a
 * HIP-3 order saw it, including the ones whose account was already in a
 * compatible mode and for whom nothing would happen. That is why the copy had
 * to hedge with "If this account is still in Standard mode" - the dialog was
 * telling everyone about a state it had not checked.
 *
 * `getAccountAbstractionModeOnChain` is a keyless read, and the submit path
 * already performs it, so the dialog can simply know.
 *
 * `modeReady === null` means the read has not landed or failed. That shows
 * NOTHING rather than warning: an unverified warning is what this replaces,
 * and the submit path re-reads the mode authoritatively and drives the change
 * itself, so nobody can be signed into a mode change without a prompt.
 */
export function shouldWarnHip3ModeChange(input: {
  isHip3Coin: boolean;
  modeReady: boolean | null;
}): boolean {
  return input.isHip3Coin && input.modeReady === false;
}

/**
 * The minimum wallet state the pre-flight guard needs. Kept narrow so the
 * extracted function is testable with plain objects, no mocks.
 */
export interface Hip3WalletState {
  address: string | null | undefined;
  subjectMismatch: boolean;
  subjectVerified: boolean;
}

/**
 * Pure result of the synchronous pre-flight checks for a HIP-3 submission.
 * The caller awaits the async abstraction-mode read separately; these guards
 * only touch plain data.
 */
export type Hip3GuardResult =
  | { action: "skip" }                           // non-HIP-3 coin, nothing to do
  | { action: "throw"; message: string }         // definitive pre-flight failure
  | { action: "proceed" };                       // all guards passed

/**
 * Check the synchronous pre-flight conditions required before requesting a
 * HIP-3 account-mode transition from the embedded Privy wallet.
 *
 * Extracted from `prepareHip3Account` in `perp-trade-form.tsx` so these
 * branches can be unit-tested without mounting the full component.
 */
export function checkHip3Guard(
  coin: string,
  accountContext: { venue: string; walletAddress?: string | null; network?: string | null },
  wallet: Hip3WalletState,
): Hip3GuardResult {
  if (!coin.includes(":")) return { action: "skip" };

  if (
    accountContext.venue !== "perps" ||
    !accountContext.walletAddress ||
    !accountContext.network
  ) {
    return {
      action: "throw",
      message: "Your perps account is still loading. Refresh and try this XYZ order again.",
    };
  }

  if (!wallet.address) {
    return {
      action: "throw",
      message:
        "Your perps wallet is not available for this market type. Contact support to restore access.",
    };
  }

  if (wallet.subjectMismatch || !wallet.subjectVerified) {
    return {
      action: "throw",
      message:
        "Your perps wallet session belongs to a different account. Sign out and back in before placing an XYZ order.",
    };
  }

  if (wallet.address.toLowerCase() !== accountContext.walletAddress.toLowerCase()) {
    return {
      action: "throw",
      message:
        "The connected Privy wallet does not match this perps account. Sign out and back in with the account used for perps.",
    };
  }

  return { action: "proceed" };
}

/**
 * Idempotently move a standard account into unified mode with a principal-
 * signed action. Hyperliquid reports standard/manual mode as `disabled`; it is
 * not an opt-out. Agent-signed transitions can be rejected with "Abstraction
 * transition not allowed", so this operation must use the embedded master.
 */
export async function ensureUnifiedAccount({
  user,
  readAbstraction,
  setAbstraction,
  waitForPropagation = () =>
    new Promise((resolve) => setTimeout(resolve, 250)),
  maxReadyChecks = 20,
}: {
  user: `0x${string}`;
  readAbstraction: () => Promise<AccountAbstractionMode>;
  setAbstraction: (params: {
    user: `0x${string}`;
    abstraction: "unifiedAccount";
  }) => Promise<unknown>;
  waitForPropagation?: () => Promise<void>;
  maxReadyChecks?: number;
}): Promise<void> {
  const current = await readAbstraction();
  if (isHip3ReadyMode(current)) return;

  let transitionError: unknown = null;
  try {
    await setAbstraction({ user, abstraction: "unifiedAccount" });
  } catch (error) {
    transitionError = error;
  }

  let lastReadError: unknown = null;
  for (let attempt = 0; attempt < maxReadyChecks; attempt += 1) {
    try {
      const after = await readAbstraction();
      if (isHip3ReadyMode(after)) return;
    } catch (error) {
      lastReadError = error;
    }

    if (attempt < maxReadyChecks - 1) {
      await waitForPropagation();
    }
  }

  if (transitionError) {
    // The request may have landed while its response was lost, so reads above
    // get a bounded chance to prove success before surfacing the original error.
    const detail =
      transitionError instanceof Error
        ? `: ${transitionError.message}`
        : `: ${String(transitionError)}`;
    throw new Error(
      `Hyperliquid did not enter unified account mode${detail}. Try again before placing this XYZ order.`,
    );
  }

  const readDetail =
    lastReadError instanceof Error ? ` (${lastReadError.message})` : "";
  throw new Error(
    `Hyperliquid accepted the account update, but unified mode is not yet visible${readDetail}. Try the order again in a moment.`,
  );
}

export interface AccountAbstractionOnChainParams {
  masterAddress: `0x${string}`;
  network: string;
}

/** Public readiness check; no connected wallet or signature is required. */
export async function getAccountAbstractionModeOnChain({
  masterAddress,
  network,
}: AccountAbstractionOnChainParams): Promise<AccountAbstractionMode> {
  const transport = new HttpTransport({ isTestnet: network === "testnet" });
  const info = new InfoClient({ transport });
  return info.userAbstraction({ user: masterAddress });
}

export interface EnsureUnifiedAccountOnChainParams {
  walletClient: WalletClient;
  masterAddress: `0x${string}`;
  network: string;
}

/** Run the principal-signed HIP-3 account setup with the embedded master. */
export async function ensureUnifiedAccountOnChain({
  walletClient,
  masterAddress,
  network,
}: EnsureUnifiedAccountOnChainParams): Promise<void> {
  const signerAddress = walletClient.account?.address;
  if (
    !signerAddress ||
    signerAddress.toLowerCase() !== masterAddress.toLowerCase()
  ) {
    throw new Error(
      "The connected perps wallet does not match this account. Refresh and reconnect the correct wallet.",
    );
  }

  const transport = new HttpTransport({ isTestnet: network === "testnet" });
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({
    transport,
    wallet: toJsonRpcSigner(walletClient),
  });

  await ensureUnifiedAccount({
    user: masterAddress,
    readAbstraction: () => info.userAbstraction({ user: masterAddress }),
    setAbstraction: (params) => exchange.userSetAbstraction(params),
  });
}

/** Inputs for the one-time client-side activation, sourced from `enable`'s return. */
export interface ActivateAgentParams {
  /** viem WalletClient bound to the embedded master wallet (from usePerpsWallet). */
  walletClient: WalletClient;
  /**
   * Master (embedded wallet) address. Used to read HL `extraAgents(master)` and
   * `maxBuilderFee(master, builder)` so we can SKIP steps that already succeeded
   * on a prior attempt — otherwise HL rejects a repeat `approveAgent` with
   * "Extra agent already used" and bricks retries.
   */
  masterAddress: `0x${string}`;
  /** Server-controlled agent wallet address to authorize. */
  agentAddress: `0x${string}`;
  /** Agent name to register under — must match the server's expected name. */
  agentName: string;
  /** True when a builder is configured; drives the extra approveBuilderFee sig. */
  builderConfigured: boolean;
  /** Builder address (present iff builderConfigured). */
  builderAddress: `0x${string}` | null;
  /** Max builder fee rate in HL percent form, e.g. "0.05%" (iff builderConfigured). */
  builderMaxFeeRate: `${string}%` | null;
  /** Active HL network — selects the SDK transport's mainnet/testnet endpoint. */
  network: string;
}

/**
 * Parse HL's `"0.05%"` maxFeeRate string into tenths-of-basis-points, matching
 * the units `info.maxBuilderFee` returns. Mirrors `builderMaxFeeRate` in
 * `@trade-bot/hyperliquid` config: `feeTenthsBps = percent * 1000`.
 */
function feeRateToTenthsBps(rate: `${string}%`): number {
  const pct = parseFloat(rate.replace("%", ""));
  if (!Number.isFinite(pct)) {
    throw new Error(`Invalid HL maxFeeRate "${rate}": not a percent string.`);
  }
  return Math.round(pct * 1000);
}

/**
 * Sign `approveAgent` (and `approveBuilderFee` when a builder is configured)
 * with the embedded master wallet. Throws if any signature/broadcast fails; the
 * caller only advances to `markAgentRegistered` on success. HIP-3 account mode
 * is prepared lazily on the first namespaced market order so a declined mode
 * signature cannot prevent ordinary BTC/ETH activation.
 *
 * IDEMPOTENT: each step is preceded by a read that short-circuits when the state
 * is already what we want. Concretely:
 *   - `approveAgent` is SKIPPED when `extraAgents(master)` already lists our
 *     agentAddress. HL rejects a repeat with "Extra agent already used", which
 *     otherwise bricks any retry after a mid-flow failure (e.g. builder-fee
 *     rejection on the first click).
 *   - `approveBuilderFee` is SKIPPED when the master's current maxBuilderFee for
 *     this builder is already >= what we want. HL returns tenths-of-bps; we
 *     compare against `builderMaxFeeRate * 1000`.
 *
 * NO retry on the state-changing calls themselves — a blind resubmit after an
 * ambiguous network failure would redundantly re-register. Idempotency is by
 * pre-check, not blind retry.
 */
export async function activateAgentOnChain(params: ActivateAgentParams): Promise<void> {
  const {
    walletClient,
    masterAddress,
    agentAddress,
    agentName,
    builderConfigured,
    builderAddress,
    builderMaxFeeRate,
    network,
  } = params;

  const transport = new HttpTransport({ isTestnet: network === "testnet" });
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({
    transport,
    wallet: toJsonRpcSigner(walletClient),
  });

  // 1. Authorize the agent (one popup). Master-signed EIP-712 ApproveAgent.
  //    Skip if the agent is already in extraAgents(master): HL rejects a repeat
  //    approveAgent with the same name ("Extra agent already used"), which would
  //    otherwise make retry after a builder-fee failure impossible.
  const agents = await info.extraAgents({ user: masterAddress });
  const target = agentAddress.toLowerCase();
  const agentAlreadyApproved = agents.some(
    (a) => a.address.toLowerCase() === target,
  );
  if (!agentAlreadyApproved) {
    await exchange.approveAgent({ agentAddress, agentName });
  }

  // 2. Approve the builder fee (second signature) only when a builder is wired.
  //    Skip when the master's current maxBuilderFee for this builder is already
  //    at least our target — avoids re-signing a no-op change.
  if (builderConfigured) {
    if (!builderAddress || !builderMaxFeeRate) {
      throw new Error(
        "Builder is configured but its address/fee rate is missing from the server. " +
          "Cannot approve builder fee.",
      );
    }
    const wantTenthsBps = feeRateToTenthsBps(builderMaxFeeRate);
    const currentTenthsBps = await info.maxBuilderFee({
      user: masterAddress,
      builder: builderAddress,
    });
    if (currentTenthsBps < wantTenthsBps) {
      await exchange.approveBuilderFee({
        builder: builderAddress,
        maxFeeRate: builderMaxFeeRate,
      });
    }
  }
}
