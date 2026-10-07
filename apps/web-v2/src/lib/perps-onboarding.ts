import type { JwtAuthFlowState } from "@privy-io/react-auth";

/**
 * perps-onboarding: pure decision + persistence helpers for the shared perps
 * onboarding card (components/perps/perps-onboarding-card.tsx).
 *
 * Extracted so the auto-setup pipeline (Privy custom-auth mode) and the
 * one-time "Perps enabled" dialog gating are unit-testable against the real
 * module, per the repo test conventions.
 */

/** The next automatic step the onboarding card should run, if any. */
export type PerpsAutoAction = "enable" | "activate" | null;

/** Status values returned by Privy's JWT-based auth synchronization hook. */
export type PerpsCustomAuthSyncStatus = JwtAuthFlowState["status"];

export interface PerpsAutoActionInput {
  /** Privy custom-auth (zero-extra-login) mode is active. */
  customAuthActive: boolean;
  /** Privy client finished initializing (`wallet.ready`). */
  walletReady: boolean;
  /** A Privy session exists (custom-auth sync completed). */
  authenticated: boolean;
  /** The embedded wallet exists (explicitly created/imported or prior). */
  hasWallet: boolean;
  /** `hyperliquid.status` has loaded at least once. */
  statusKnown: boolean;
  /** Perps enabled server-side (credential row exists). */
  enabled: boolean;
  /** Agent approved on-chain (accountType LIVE). */
  agentReady: boolean;
  /** HL trading balance > 0 (activation requires a funded account). */
  funded: boolean;
  /** Connected embedded wallet differs from the stored master. */
  walletMismatch: boolean;
  /**
   * The Privy custom-auth SUBJECT (the JWT `sub` Privy keyed the wallet to)
   * equals the CURRENT Better Auth session user id. Privy's session persists
   * in its own storage and can lag a Better Auth logout/login on a shared
   * browser; when this is false the wallet may belong to a DIFFERENT platform
   * user, so no automatic action may run.
   */
  subjectVerified: boolean;
}

/**
 * Decide the next automatic onboarding step. ONLY meaningful in custom-auth
 * mode; the login-modal flow stays fully manual. Order of the pipeline:
 *
 *   explicit wallet create/import (handled by the onboarding card)
 *     -> "enable"   (provision the server agent; needs the wallet address)
 *     -> [user funds the wallet + deposits; nothing to automate]
 *     -> "activate" (client-signed approveAgent; needs a funded HL account)
 *
 * Never returns an action on a wallet mismatch: enabling/activating with a
 * different wallet than the stored master is the exact footgun the manual
 * flow guards against. Likewise, never returns an action unless the Privy
 * custom-auth subject is verified against the Better Auth session user
 * (`subjectVerified`): a stale Privy session on a shared browser could
 * otherwise bind user A's wallet to user B's account.
 */
export function derivePerpsAutoAction(input: PerpsAutoActionInput): PerpsAutoAction {
  if (!input.customAuthActive) return null;
  if (!input.subjectVerified) return null;
  if (!input.walletReady || !input.authenticated || !input.hasWallet) return null;
  if (!input.statusKnown || input.walletMismatch) return null;
  if (!input.enabled) return "enable";
  if (!input.agentReady && input.funded) return "activate";
  return null;
}

/**
 * Return whether a custom-auth wallet session may perform a mutation or sign.
 *
 * `subjectMismatch` is only true after both the Privy user and platform
 * session have loaded and disagree. During the earlier unresolved state it is
 * false, so every mutating path must also require `subjectVerified`.
 */
export function isPerpsWalletSessionVerified(input: {
  customAuthActive: boolean;
  subjectVerified: boolean;
  subjectMismatch: boolean;
}): boolean {
  if (!input.customAuthActive) return true;
  return input.subjectVerified && !input.subjectMismatch;
}

/** Inputs for the authenticated flag exposed by usePerpsWallet. */
export interface PerpsWalletAuthenticatedInput {
  /** Privy custom-auth (zero-extra-login) mode is active. */
  customAuthActive: boolean;
  /** The current Better Auth session still has a signed-in user. */
  platformAuthenticated: boolean;
  /** The raw authenticated flag reported by Privy's usePrivy hook. */
  privyAuthenticated: boolean;
  /** The returned state from Privy's JWT synchronization hook. */
  customAuthSyncStatus: PerpsCustomAuthSyncStatus;
}

/**
 * Resolve the wallet-session authentication signal used by the perps UI.
 *
 * In custom-auth mode, the returned JWT-sync state is authoritative: a stale
 * `usePrivy().authenticated` value must not make wallet-management controls or
 * onboarding look ready before Privy has finished syncing the current JWT.
 * Manual/modal auth keeps using Privy's own flag unchanged.
 */
export function isPerpsWalletAuthenticated(
  input: PerpsWalletAuthenticatedInput,
): boolean {
  if (!input.customAuthActive) return input.privyAuthenticated;
  return input.platformAuthenticated && input.customAuthSyncStatus === "done";
}

/**
 * Tiny stable string hash (FNV-1a, 32-bit, hex). NOT cryptographic; only
 * needs to be stable across sessions and distinct enough to namespace
 * localStorage keys per wallet without persisting the raw address.
 */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Storage key for the one-time "Perps enabled" dialog, namespaced per master
 * wallet address so a different account on the same browser still gets its
 * own one-time popup. The address is HASHED (lowercased first, so casing
 * doesn't split the namespace): localStorage entries live forever, and a raw
 * wallet address is linkable financial data that has no business persisting
 * in plaintext. v2 because v1 keys embedded the raw address.
 */
export function perpsEnabledDialogStorageKey(masterAddress: string): string {
  return `rst.perps.enabledDialogDismissed.v2:${stableHash(masterAddress.toLowerCase())}`;
}

/** Minimal storage surface so tests can pass a fake and SSR can pass null. */
export type DialogStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * True when the one-time "Perps enabled" dialog has NOT been dismissed yet
 * for this master address. A null/throwing storage (SSR, privacy mode)
 * reports false: never risk a popup loop when persistence is unavailable.
 */
export function shouldShowPerpsEnabledDialog(
  storage: DialogStorage | null,
  masterAddress: string | null | undefined,
): boolean {
  if (!storage || !masterAddress) return false;
  try {
    return storage.getItem(perpsEnabledDialogStorageKey(masterAddress)) === null;
  } catch {
    return false;
  }
}

/** Persist the dismissal so the dialog shows exactly once per wallet. */
export function markPerpsEnabledDialogDismissed(
  storage: DialogStorage | null,
  masterAddress: string | null | undefined,
): void {
  if (!storage || !masterAddress) return;
  try {
    storage.setItem(perpsEnabledDialogStorageKey(masterAddress), String(Date.now()));
  } catch {
    // Persistence unavailable (private mode/quota): the dialog may show again
    // next session, which is harmless.
  }
}
