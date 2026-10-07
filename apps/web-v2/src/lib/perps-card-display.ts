/**
 * Pure display/formatting helpers for the perps onboarding card.
 *
 * Extracted so the card's presentational decisions (button-variant hierarchy,
 * when to show the "pending deposit" block, USDC-amount formatting, and the
 * disconnect/remove confirmation copy) are unit-testable without mounting the
 * whole settings component or a Privy provider. No React, no I/O, no side
 * effects: everything here is a pure function of its inputs.
 */

import { matchesPerpsMasterAddress } from "./perps-wallet-selection";

/** The three wallet-management actions in the enabled-card action row. */
export type PerpsWalletAction = "refresh" | "export" | "disconnect";

/** Button variants used by the action row (a subset of the UI kit's variants). */
export type PerpsButtonVariant = "outline" | "secondary" | "destructive";

/**
 * Map each wallet action to a Button variant so the row reads as a hierarchy
 * instead of four identical outline buttons (doc #20a):
 *   - refresh    -> "outline"     (neutral utility)
 *   - export     -> "secondary"   (sensitive, but the wallet is the user's)
 *   - disconnect -> "destructive" (danger: detaches the perps wallet)
 */
export function perpsWalletActionVariant(
  action: PerpsWalletAction,
): PerpsButtonVariant {
  switch (action) {
    case "disconnect":
      return "destructive";
    case "export":
      return "secondary";
    case "refresh":
      return "outline";
  }
}

export interface PerpsExportAvailabilityInput {
  /** The current Privy session is authenticated. */
  walletAuthenticated: boolean;
  /** The current Privy session exposes the embedded wallet to export. */
  hasEmbeddedWallet: boolean;
  /** The wallet session belongs to the signed-in platform user. */
  subjectVerified: boolean;
  /** A stale Privy session belongs to a different platform user. */
  subjectMismatch: boolean;
  /** Address selected from the verified Privy wallet session. */
  selectedAddress: string | null | undefined;
  /** Persisted Hyperliquid master address for the enabled account. */
  storedMasterAddress: string | null | undefined;
}

/**
 * Privy export is available only for the authenticated wallet bound to the
 * stored master. It does not depend on whether the user exported the key
 * before. Keep both identity gates here so a stale session or another embedded
 * wallet can never expose export for this account.
 */
export function canExportPerpsWallet(
  input: PerpsExportAvailabilityInput,
): boolean {
  const selectedAddressMatchesMaster = matchesPerpsMasterAddress(
    input.selectedAddress,
    input.storedMasterAddress,
  );

  return (
    input.walletAuthenticated &&
    input.hasEmbeddedWallet &&
    input.subjectVerified &&
    !input.subjectMismatch &&
    selectedAddressMatchesMaster
  );
}

/**
 * Whether the "pending deposit" (on-chain, not yet on Hyperliquid) block should
 * render. We only show it when there is a positive USDC balance sitting in the
 * wallet: a $0 wallet reads as "you have no money" and confuses users (doc #18),
 * so it collapses to nothing until there is actually something to deposit.
 */
export function shouldShowPendingDeposit(
  walletUsdc: number | null | undefined,
): boolean {
  return (
    typeof walletUsdc === "number" &&
    Number.isFinite(walletUsdc) &&
    walletUsdc > 0
  );
}

export interface PerpsSessionIdentityInput {
  /** The app is using Better Auth -> Privy custom auth. */
  customAuthActive: boolean;
  /** The Privy custom-auth subject belongs to a different platform user. */
  subjectMismatch: boolean;
}

/**
 * A stale custom-auth subject must be cleared before the app can provision or
 * expose wallet-management controls. Offer a Privy-session reset for every
 * definite mismatch and never expose controls for the stale session's wallet.
 */
export function shouldShowMismatchedPerpsSessionReset(
  input: PerpsSessionIdentityInput,
): boolean {
  return input.customAuthActive && input.subjectMismatch;
}

/**
 * Format a USDC token amount for display, e.g. 12.5 -> "12.50". This is a TOKEN
 * quantity, not a USD price, so it is intentionally not routed through the
 * currency formatters (which would render "$12.50"). Invalid input renders "-".
 */
export function formatUsdcAmount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "-";
  }
  return value.toFixed(2);
}

/** Copy for an "Are you sure?" confirmation dialog. */
export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * Perps card "Disconnect Wallet" confirmation (doc #20c). This only ends the
 * Privy wallet SESSION in this browser; the deposited balance and trading agent
 * are untouched, and reconnecting the same wallet resumes trading. It points at
 * the Broker tab for a full removal so the two controls stay aligned (doc #17).
 */
export const PERPS_DISCONNECT_CONFIRM: ConfirmCopy = {
  title: "Disconnect perps wallet?",
  description:
    "This signs you out of your perps wallet in this browser. Your Hyperliquid " +
    "balance and trading agent stay put, and reconnecting the same wallet resumes " +
    "trading. To fully remove perps, use Remove perps below.",
  confirmLabel: "Disconnect",
};

/** True when a Connected-Accounts provider row is the Hyperliquid perps agent. */
export function isHyperliquidProvider(
  provider: string | null | undefined,
): boolean {
  return typeof provider === "string" && provider.toLowerCase() === "hyperliquid";
}

/**
 * The rows the Broker tab should list.
 *
 * Hyperliquid is stored in the same `user_api_credentials` table as Alpaca,
 * which is why it surfaced under "Connected Accounts / Your linked broker
 * accounts". It does not belong there: Hyperliquid is a venue the user trades
 * through a self-custody wallet, not a brokerage they linked API keys to, and
 * listing it under Broker while its whole setup lives under Perps split one
 * feature across two tabs. It also meant the only way to remove perps was from
 * a tab that never mentions them.
 */
export function brokerConnectedAccounts<T extends { provider: string }>(
  accounts: readonly T[] | undefined | null,
): T[] {
  return (accounts ?? []).filter(
    (account) => !isHyperliquidProvider(account.provider),
  );
}

/**
 * The Hyperliquid credential row, so the Perps tab can own its removal.
 *
 * Returns the FIRST match. There is one perps agent per user, and if a stale
 * duplicate ever existed, removing them one at a time is the honest behaviour;
 * silently picking a different one on each render is not.
 */
export function findHyperliquidAccount<T extends { provider: string }>(
  accounts: readonly T[] | undefined | null,
): T | null {
  return (accounts ?? []).find((account) => isHyperliquidProvider(account.provider)) ?? null;
}

/**
 * Confirmation copy for a "Remove" button, provider-aware (doc #17).
 *
 * Both tabs share this. Removing the Hyperliquid provider deletes the trading
 * agent (a full perps offboard), so it gets perps-specific wording consistent
 * with the perps card instead of the generic broker-key copy. That row is now
 * shown on the Perps tab rather than under Broker, but the copy is keyed on
 * the provider, not on which tab invoked it.
 */
export function removeAccountConfirm(
  provider: string | null | undefined,
): ConfirmCopy {
  if (isHyperliquidProvider(provider)) {
    return {
      title: "Remove Hyperliquid perps?",
      description:
        "This removes the Hyperliquid connection from your account and disconnects " +
        "perps. Your trading agent and any deposited balance remain under your master " +
        "wallet on-chain.",
      confirmLabel: "Remove",
    };
  }
  return {
    title: "Delete Credentials",
    description:
      "Are you sure you want to delete these credentials? This action cannot be undone.",
    confirmLabel: "Delete",
  };
}
