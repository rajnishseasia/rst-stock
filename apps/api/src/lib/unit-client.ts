/**
 * Unit Client for Solana -> Hyperliquid Funding
 *
 * Interacts with Unit (https://api.hyperunit.xyz) to generate Solana deposit addresses
 * linked to a user's Hyperliquid account and estimate deposit fees.
 * Follows specification in docs/tasks/trade-xyz-integration-request.md.
 */

export const UNIT_API_URL = "https://api.hyperunit.xyz";

export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;

/**
 * Validates a Hyperliquid EVM address format.
 */
export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Requests a unique Solana deposit address from Unit for the given Hyperliquid EVM address.
 * Native SOL sent to this address is automatically credited by Unit to the Hyperliquid account.
 */
export async function getUnitSolDepositAddress(
  hyperliquidAddress: string,
): Promise<string> {
  if (!isValidEvmAddress(hyperliquidAddress)) {
    throw new Error("Invalid Hyperliquid EVM address");
  }

  const url = `${UNIT_API_URL}/gen/solana/hyperliquid/sol/${encodeURIComponent(hyperliquidAddress)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  const body = (await response.json()) as { address?: string; error?: string };

  if (!response.ok || !body.address) {
    throw new Error(body.error || "Unit did not return a deposit address");
  }

  return body.address;
}

/**
 * Fetches estimated fees for Unit deposits.
 */
export async function getUnitSolDepositFee(): Promise<string | null> {
  try {
    const response = await fetch(`${UNIT_API_URL}/v2/estimate-fees`, {
      headers: {
        Accept: "application/json",
      },
    });
    const body = (await response.json()) as {
      solana?: { depositFee?: string | number };
      error?: string;
    };

    if (!response.ok) {
      return null;
    }

    return body.solana?.depositFee?.toString() ?? null;
  } catch {
    return null;
  }
}

/**
 * Safely converts decimal SOL string to lamports (BigInt).
 */
export function solToLamports(amount: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(amount)) {
    throw new Error("SOL amount must have at most 9 decimal places");
  }

  const [whole = "0", fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(9, "0");

  return BigInt(whole) * LAMPORTS_PER_SOL_BIGINT + BigInt(paddedFraction);
}
