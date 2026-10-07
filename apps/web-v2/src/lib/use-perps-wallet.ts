"use client";

/**
 * use-perps-wallet — the single client surface for the Privy-backed perps wallet.
 *
 * ARCHITECTURE (see HYPERLIQUID-PERPS-PLAN.md): Privy is the wallet layer for
 * perps ONLY. Better Auth remains the platform login; the Privy login (Google,
 * with email as a fallback) is triggered explicitly here (via `login()`), never
 * forced app-wide. The configured login methods live in `providers.tsx`; this
 * hook just opens the modal and does not assume any single method. The wallet
 * this hook exposes is the user's Privy EMBEDDED wallet — the self-custody MASTER
 * wallet that holds USDC, can be funded/exported by the user, and CLIENT-SIDE
 * signs `approveAgent`, optional `approveBuilderFee`, and the one-time unified
 * account transition if the user later trades a namespaced XYZ market. Order
 * flow stays agent-signed server-side and is out of this hook's scope.
 *
 * This hook wraps Privy's `usePrivy`/`useLogin`/`useLogout`/`useWallets`/
 * `useFundWallet`/`useExportWallet` and hands back the embedded wallet address plus
 * a `getWalletClient()` that builds a viem `WalletClient` from the embedded wallet's
 * EIP-1193 provider. The wallet UI and the activate flow consume only this surface.
 */

import { useCallback, useMemo } from "react";
import {
  usePrivy,
  useLogin,
  useWallets,
  useCreateWallet,
  useImportWallet,
  useFundWallet,
  useExportWallet,
  type ConnectedWallet,
  type WalletWithMetadata,
} from "@privy-io/react-auth";
import {
  PRIVY_CUSTOM_AUTH,
  getPrivyCustomAuthSubject,
} from "@/lib/privy-custom-auth";
import {
  isPerpsWalletSessionVerified,
  isPerpsWalletAuthenticated,
} from "@/lib/perps-onboarding";
import { usePrivyJwtAuthState } from "@/lib/privy-jwt-auth-state";
import { useSession } from "@/lib/auth-client";
import { createWalletClient, custom, type WalletClient } from "viem";
import { arbitrum } from "viem/chains";
import {
  depositUsdcToHyperliquid,
  readPerpsWalletBalancesByAddress,
} from "@/lib/hyperliquid-deposit";
import { normalizeImportedPrivateKey } from "@/lib/perps-private-key";
import {
  isValidPerpsMasterAddress,
  matchesPerpsMasterAddress,
  selectPerpsEmbeddedWallet,
} from "@/lib/perps-wallet-selection";

/**
 * The client surface consumed by the perps wallet UI + activate flow.
 */
export interface PerpsWallet {
  /** True once Privy has finished initializing on the client. */
  ready: boolean;
  /** True when a Privy session exists (login completed). */
  authenticated: boolean;
  /**
   * True once Privy's `useWallets()` has finished populating the wallet
   * list AND that list actually reflects the wallet Privy's user record
   * already knows about. `useWallets().ready` alone can flip true before a
   * just-created/just-linked embedded wallet's provider finishes
   * initializing, since `user.linkedAccounts` and the `useWallets()` wallet
   * list update through separate paths; this field also waits for that
   * catch-up so callers never see "no wallet" while one is still settling.
   * During custom-auth re-login, `ready`/`authenticated` can flip true
   * before this does, leaving `address` still empty; gate "wallet session
   * lost" copy on this instead of `ready`/`authenticated` alone so that
   * normal loading window isn't mistaken for a lost session.
   */
  walletsReady: boolean;
  /**
   * True when Privy CUSTOM AUTH is active (zero-extra-login mode): the Privy
   * session follows the Better Auth session and `login()` is a no-op (there is
   * no Privy modal). Wallet creation/import remains an explicit UI choice.
   * UI should hide connect/disconnect affordances when this is true.
   */
  customAuthActive: boolean;
  /**
   * WRONG-WALLET-BINDING GATE (custom-auth mode): true only when the Privy
   * session's custom-auth SUBJECT (the JWT `sub` the wallet identity is keyed
   * to) equals the CURRENT Better Auth session user id. Privy persists its
   * session independently, so on a shared browser it can lag a Better Auth
   * logout/login; every automatic onboarding step must require this to be
   * true. Always true outside custom-auth mode (the manual flow has its own
   * explicit-login guards).
   */
  subjectVerified: boolean;
  /**
   * DEFINITE mismatch (custom-auth mode): the Privy user is loaded, a Better
   * Auth session exists, and the subjects differ (or the Privy session has no
   * custom-auth account at all, i.e. a stale login-modal session). Drives the
   * blocking warning UI. False while either side is still loading, so the
   * warning never flashes during boot.
   */
  subjectMismatch: boolean;
  /** Trigger the Privy login modal (Google, email fallback; perps-scoped, not app-wide). */
  login: () => void;
  /** End the Privy session. Does NOT touch the Better Auth platform session. */
  logout: () => Promise<void>;
  /** The user's embedded (master) wallet, or undefined until provisioned. */
  embeddedWallet: ConnectedWallet | undefined;
  /** True once the user has an embedded wallet (created or imported). */
  hasWallet: boolean;
  /** Convenience accessor for the embedded wallet's 0x address. */
  address: string | undefined;
  /** Create a fresh Privy embedded wallet (self-custody, new key). */
  createWallet: () => Promise<void>;
  /**
   * Import an existing wallet by its hex private key into a Privy embedded
   * wallet (key sealed in Privy's enclave; keeps popup-free signing + export).
   * The key is passed straight to Privy and never sent to our server.
   */
  importWallet: (privateKey: string) => Promise<void>;
  /**
   * Build a viem `WalletClient` bound to the embedded wallet's EIP-1193 provider.
   * Used CLIENT-SIDE for master-signed account setup, `approveAgent`, and
   * `approveBuilderFee` in Stage 3. Throws if the embedded wallet is not ready.
   *
   * The chain is Arbitrum One — the chain Hyperliquid's L1-action EIP-712
   * signatures are domain-scoped to on mainnet; the `@nktkas/hyperliquid` SDK
   * constructs the typed-data payload and only needs a signer on this chain.
   */
  getWalletClient: () => Promise<WalletClient>;
  /** Open Privy's funding flow for the embedded wallet (USDC deposit). */
  fundWallet: () => Promise<void>;
  /** Open Privy's export-key modal for the embedded (self-custody) wallet. */
  exportWallet: () => Promise<void>;
  /**
   * Read the embedded wallet's native-USDC balance on Arbitrum, in whole USDC.
   * Used by the deposit UI to gate the button.
   */
  usdcBalance: () => Promise<number>;
  /**
   * Read the embedded wallet's native ETH (gas) balance on Arbitrum, in whole
   * ETH. Used by the deposit UI to warn when the wallet has no gas.
   */
  ethBalance: () => Promise<number>;
  /**
   * Transfer `amountUsdc` native USDC from the embedded wallet into Hyperliquid's
   * Arbitrum bridge (credits this address on HL). FUND-CRITICAL; validates the
   * minimum and on-chain balance before signing. Returns the tx hash.
   */
  depositToHyperliquid: (amountUsdc: number) => Promise<`0x${string}`>;
}

/** No-op login used in custom-auth mode: there is no Privy modal to open. */
const noopLogin = () => {};

export function usePerpsWallet({
  preferredAddress,
  requirePreferredAddress = false,
}: {
  /** The server-bound master address, when an existing perps account is known. */
  preferredAddress?: string | null;
  /** Enabled accounts cannot fall back to an arbitrary linked EVM wallet. */
  requirePreferredAddress?: boolean;
} = {}): PerpsWallet {
  const {
    ready,
    authenticated: privyAuthenticated,
    logout,
    user,
  } = usePrivy();
  const { login: privyLogin } = useLogin();
  const { wallets, ready: rawWalletsReady } = useWallets();
  const { createWallet: privyCreateWallet } = useCreateWallet();
  const { importWallet: privyImportWallet } = useImportWallet();
  const { fundWallet: privyFundWallet } = useFundWallet();
  const { exportWallet: privyExportWallet } = useExportWallet();
  const { data: sessionData } = useSession();
  const jwtAuthState = usePrivyJwtAuthState();

  // Privy's raw authenticated flag can lag the JWT synchronization hook (or
  // still represent a persisted session from before the current Better Auth
  // user was restored). In custom-auth mode, the hook's returned `done` state
  // is authoritative; manual/modal auth keeps the raw Privy flag unchanged.
  const authenticated = isPerpsWalletAuthenticated({
    customAuthActive: PRIVY_CUSTOM_AUTH,
    platformAuthenticated: Boolean(sessionData?.user),
    privyAuthenticated,
    customAuthSyncStatus: jwtAuthState.status,
  });

  const selectionOptions = { requirePreferredAddress };
  const embeddedWallet = selectPerpsEmbeddedWallet(
    wallets,
    preferredAddress,
    selectionOptions,
  );
  const address = embeddedWallet?.address;

  // Cross-check against Privy's user record: if it already lists an
  // embedded wallet, but useWallets() hasn't produced a matching entry yet,
  // the wallet list is still catching up even though its own `ready` flag
  // is already true (see the walletsReady doc comment above).
  const linkedWalletAccounts = useMemo(
    () =>
      (user?.linkedAccounts ?? []).filter(
        (account): account is WalletWithMetadata => account.type === "wallet",
      ),
    [user],
  );
  const expectedEmbeddedWallet = selectPerpsEmbeddedWallet(
    linkedWalletAccounts,
    preferredAddress,
    selectionOptions,
  );
  const walletsReady =
    rawWalletsReady && (!expectedEmbeddedWallet || Boolean(embeddedWallet));

  // WRONG-WALLET-BINDING GATE: compare the Privy custom-auth subject (the
  // `customUserId` of the `custom_auth` linked account = the `sub` of the JWT
  // we minted) against the current Better Auth session user id. See the
  // PerpsWallet doc comments for the shared-browser stale-session scenario.
  const privySubject = getPrivyCustomAuthSubject(user);
  const sessionUserId = sessionData?.user?.id;
  const subjectVerified = !PRIVY_CUSTOM_AUTH
    ? true
    : Boolean(privySubject && sessionUserId && privySubject === sessionUserId);
  const subjectMismatch =
    PRIVY_CUSTOM_AUTH &&
    authenticated &&
    user != null &&
    Boolean(sessionUserId) &&
    privySubject !== sessionUserId;
  const walletSessionVerified = isPerpsWalletSessionVerified({
    customAuthActive: PRIVY_CUSTOM_AUTH,
    subjectVerified,
    subjectMismatch,
  });

  const assertWalletSessionVerified = useCallback(() => {
    if (PRIVY_CUSTOM_AUTH && (!authenticated || !walletSessionVerified)) {
      throw new Error(
        "Perps wallet session is not verified for this account. Restore the wallet session before continuing.",
      );
    }
  }, [authenticated, walletSessionVerified]);

  const assertStoredMasterAvailable = useCallback(() => {
    if (requirePreferredAddress && !isValidPerpsMasterAddress(preferredAddress)) {
      throw new Error(
        "The stored perps wallet identity is unavailable.",
      );
    }
  }, [preferredAddress, requirePreferredAddress]);

  const assertWalletMasterMatches = useCallback(() => {
    if (
      requirePreferredAddress &&
      !matchesPerpsMasterAddress(address, preferredAddress)
    ) {
      throw new Error(
        "The connected wallet does not match this perps account.",
      );
    }
  }, [address, preferredAddress, requirePreferredAddress]);

  // In custom-auth mode `login()` must never open a Privy modal: the session
  // comes from Better Auth. Hand back a no-op so existing callers stay safe.
  const login = PRIVY_CUSTOM_AUTH ? noopLogin : privyLogin;

  const createWallet = useCallback(async (): Promise<void> => {
    if (requirePreferredAddress) {
      throw new Error(
        "A replacement wallet cannot be created for an enabled perps account.",
      );
    }
    assertWalletSessionVerified();
    await privyCreateWallet();
  }, [assertWalletSessionVerified, privyCreateWallet, requirePreferredAddress]);

  const importWallet = useCallback(
    async (privateKey: string): Promise<void> => {
      assertStoredMasterAvailable();
      assertWalletSessionVerified();
      // Validate + normalize via the pure helper (unit-tested in
      // perps-private-key.test.ts). The key is passed straight to Privy and
      // never sent to our server or logged.
      const key = normalizeImportedPrivateKey(privateKey);
      await privyImportWallet({ privateKey: key });
    },
    [assertStoredMasterAvailable, assertWalletSessionVerified, privyImportWallet],
  );

  const getWalletClient = useCallback(async (): Promise<WalletClient> => {
    assertWalletSessionVerified();
    assertWalletMasterMatches();
    if (!embeddedWallet) {
      throw new Error(
        "Perps embedded wallet is not ready. Complete Privy login/funding first.",
      );
    }
    const provider = await embeddedWallet.getEthereumProvider();
    return createWalletClient({
      account: embeddedWallet.address as `0x${string}`,
      chain: arbitrum,
      transport: custom(provider),
    });
  }, [assertWalletMasterMatches, assertWalletSessionVerified, embeddedWallet]);

  const fundWallet = useCallback(async (): Promise<void> => {
    assertWalletSessionVerified();
    assertWalletMasterMatches();
    if (!address) {
      throw new Error("Perps embedded wallet is not ready to fund.");
    }
    await privyFundWallet({ address });
  }, [address, assertWalletMasterMatches, assertWalletSessionVerified, privyFundWallet]);

  const exportWallet = useCallback(async (): Promise<void> => {
    if (!authenticated) {
      throw new Error(
        "Perps wallet session is not authenticated. Restore the wallet session before exporting.",
      );
    }
    if (PRIVY_CUSTOM_AUTH && !walletSessionVerified) {
      throw new Error(
        "Perps wallet session is not verified for this account. Restore the wallet session before exporting.",
      );
    }
    if (!address) {
      throw new Error("Perps embedded wallet is not ready to export.");
    }
    if (!matchesPerpsMasterAddress(address, preferredAddress)) {
      throw new Error(
        "The connected wallet does not match this perps account.",
      );
    }
    await privyExportWallet({ address });
  }, [
    address,
    authenticated,
    preferredAddress,
    privyExportWallet,
    walletSessionVerified,
  ]);

  // Balances are read over a PUBLIC Arbitrum RPC keyed by the wallet address, not
  // through the embedded provider — so the deposit button's gate populates even
  // before/without a signer-ready Privy session.
  const usdcBalance = useCallback(async (): Promise<number> => {
    assertWalletMasterMatches();
    if (!address) throw new Error("Perps wallet address is not ready.");
    const balances = await readPerpsWalletBalancesByAddress(
      address as `0x${string}`,
    );
    return balances.usdc;
  }, [address, assertWalletMasterMatches]);

  const ethBalance = useCallback(async (): Promise<number> => {
    assertWalletMasterMatches();
    if (!address) throw new Error("Perps wallet address is not ready.");
    const balances = await readPerpsWalletBalancesByAddress(
      address as `0x${string}`,
    );
    return balances.eth;
  }, [address, assertWalletMasterMatches]);

  const depositToHyperliquid = useCallback(
    async (amountUsdc: number): Promise<`0x${string}`> => {
      assertWalletSessionVerified();
      const walletClient = await getWalletClient();
      return depositUsdcToHyperliquid({ walletClient, amountUsdc });
    },
    [assertWalletSessionVerified, getWalletClient],
  );

  return {
    ready,
    authenticated,
    walletsReady,
    customAuthActive: PRIVY_CUSTOM_AUTH,
    subjectVerified,
    subjectMismatch,
    login,
    logout,
    embeddedWallet,
    hasWallet: Boolean(embeddedWallet),
    address,
    createWallet,
    importWallet,
    getWalletClient,
    fundWallet,
    exportWallet,
    usdcBalance,
    ethBalance,
    depositToHyperliquid,
  };
}
