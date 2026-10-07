/** The wallet metadata needed to choose the Hyperliquid master wallet. */
export interface PerpsWalletCandidate {
  address: string;
  chainType?: string;
  walletClientType?: string;
  imported?: boolean;
}

/** True when a value has the exact shape of an EVM address. */
export function isValidPerpsMasterAddress(
  address: string | null | undefined,
): address is `0x${string}` {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/u.test(address);
}

/** Compare only syntactically valid EVM addresses, without case sensitivity. */
export function matchesPerpsMasterAddress(
  selectedAddress: string | null | undefined,
  storedMasterAddress: string | null | undefined,
): boolean {
  return (
    isValidPerpsMasterAddress(selectedAddress) &&
    isValidPerpsMasterAddress(storedMasterAddress) &&
    selectedAddress.toLowerCase() === storedMasterAddress.toLowerCase()
  );
}

/**
 * Select the Privy EVM wallet used by the Hyperliquid perps flow.
 *
 * Hyperliquid L1 signing and the Arbitrum bridge both use the EVM wallet. A
 * Privy user can expose more than one embedded wallet (including wallets for
 * other chain types), so selecting by client type alone can bind the wrong
 * account. When a server-bound master is supplied, only that address is
 * eligible. Callers for an enabled account can require that a valid preferred
 * address exists; without that requirement, first-time setup prefers an
 * imported EVM wallet, then the first EVM wallet.
 */
export function selectPerpsEmbeddedWallet<T extends PerpsWalletCandidate>(
  wallets: readonly T[],
  preferredAddress?: string | null,
  options?: { requirePreferredAddress?: boolean },
): T | undefined {
  // Prefer wallets that exactly match the expected Privy EVM type. Fall back
  // to Privy wallets with missing/unknown chainType metadata (older SDK
  // versions) rather than returning undefined and showing the "Create new
  // wallet" button to a user who already has one. Wallets explicitly marked
  // with another chain type (e.g. Solana) are never eligible: they can't
  // produce an EVM signer for the Hyperliquid/Arbitrum flow.
  const evmWallets = wallets.filter(
    (wallet) =>
      wallet.walletClientType === "privy" && wallet.chainType === "ethereum",
  );
  const candidatePool =
    evmWallets.length > 0
      ? evmWallets
      : wallets.filter(
          (wallet) =>
            wallet.walletClientType === "privy" && !wallet.chainType,
        );

  if (
    options?.requirePreferredAddress &&
    !isValidPerpsMasterAddress(preferredAddress)
  ) {
    return undefined;
  }

  if (preferredAddress !== undefined && preferredAddress !== null) {
    if (!isValidPerpsMasterAddress(preferredAddress)) return undefined;
    const normalizedPreferredAddress = preferredAddress.toLowerCase();
    return candidatePool.find(
      (wallet) => wallet.address.toLowerCase() === normalizedPreferredAddress,
    );
  }

  return candidatePool.find((wallet) => wallet.imported) ?? candidatePool[0];
}
