/**
 * Credentials Service
 *
 * Server-side-only service for retrieving and decrypting user API credentials.
 * This service should NEVER be exposed to the client. It is only used internally
 * by server-side tRPC procedures that need to access broker APIs.
 */

import { TRPCError } from "@trpc/server";
import { decrypt, DecryptionAuthenticationError } from "@trade-bot/utils";
import type { PoolDb } from "@trade-bot/db";

export type CredentialProvider = "alpaca" | "hyperliquid";

export interface DecryptedCredentials {
  credentialId: string;
  provider: CredentialProvider;
  /**
   * For Alpaca: the broker account id.
   * For Hyperliquid: the EMBEDDED master wallet address (`0x…`) — the on-chain HL
   * account. User-owned (client-signed); the server reads it read-only.
   */
  accountId: string | null;
  accountType: string | null;
  /**
   * For Alpaca: the Secret Key.
   * For Hyperliquid: UNUSED. The master is now the user's EMBEDDED wallet
   * (client-signed), so there is no server-side master walletId — this column
   * holds an encrypted empty placeholder (see walletRefsToCredentialRow).
   */
  accessToken: string;
  /**
   * For Alpaca: unused.
   * For Hyperliquid: the Privy AGENT wallet id (used to build the agent viem
   * account that signs orders / cancels / leverage — never withdrawals).
   */
  refreshToken: string | null;
  /**
   * For Alpaca: the API Key ID.
   * For Hyperliquid: the master wallet address (`0x…`), duplicated here as the
   * human-readable public identifier.
   */
  username: string | null;
  /**
   * For Alpaca: an optional custom base URL.
   * For Hyperliquid: the AGENT wallet address (`0x…`).
   */
  baseUrl: string | null;
}

export interface GetCredentialsOptions {
  provider: CredentialProvider;
  credentialId?: string;
  accountId?: string;
}

/**
 * Get and decrypt user API credentials (server-side only)
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param options - Provider and optional accountId
 * @returns Decrypted credentials
 * @throws TRPCError if credentials not found or invalid
 */
export async function getDecryptedCredentials(
  db: PoolDb,
  userId: string,
  options: GetCredentialsOptions
): Promise<DecryptedCredentials> {
  const { provider, credentialId, accountId } = options;

  const credential = await db.query.userApiCredentials.findFirst({
    where: (creds, { eq, and }) => {
      const conditions = [
        eq(creds.userId, userId),
        eq(creds.provider, provider),
      ];
      // Prefer the exact saved credential row when the UI selects one.
      if (credentialId) {
        conditions.push(eq(creds.id, credentialId));
      } else if (accountId) {
        conditions.push(eq(creds.accountId, accountId));
      }
      return and(...conditions);
    },
  });

  if (!credential) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Credentials not found. Please add your API keys in the Settings page.",
    });
  }

  let accessToken: string;
  let refreshToken: string | null;
  try {
    accessToken = decrypt(credential.encryptedAccessToken);
    refreshToken = credential.encryptedRefreshToken
      ? decrypt(credential.encryptedRefreshToken)
      : null;
  } catch (error) {
    if (
      credential.provider === "alpaca" &&
      error instanceof DecryptionAuthenticationError
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Alpaca credentials need to be re-entered in Settings.",
      });
    }
    throw error;
  }

  return {
    credentialId: credential.id,
    provider: credential.provider as CredentialProvider,
    accountId: credential.accountId,
    accountType: credential.accountType,
    accessToken,
    refreshToken,
    username: credential.username,
    baseUrl: credential.baseUrl,
  };
}
