import { TRPCError } from "@trpc/server";
import { AlpacaClient } from "@trade-bot/alpaca";
import { getDecryptedCredentials, type DecryptedCredentials } from "./credentials.js";
import type { PoolDb } from "@trade-bot/db";

type AlpacaCredentialSelector = string | {
  accountId?: string;
  credentialId?: string;
};

export function isPaperAccount(accountType: string | null | undefined): boolean {
  return accountType === "PAPER" || accountType === "SIM";
}

export function createAlpacaClientFromCredentials(credentials: DecryptedCredentials) {
  if (!credentials.username || !credentials.accessToken) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Alpaca credentials incomplete (Key ID or Secret missing)",
    });
  }

  return new AlpacaClient({
    keyId: credentials.username,
    secretKey: credentials.accessToken,
    paper: isPaperAccount(credentials.accountType),
  });
}

/**
 * Returns an AlpacaClient backed by server-side master credentials.
 * Used for read-only market data (chart bars, live quotes) so individual
 * users don't need to supply their own Alpaca API keys to view charts.
 *
 * Required env vars:
 *   ALPACA_MASTER_KEY    — Alpaca API key ID
 *   ALPACA_MASTER_SECRET — Alpaca secret key
 *
 * Optional:
 *   ALPACA_MASTER_PAPER  — "true" (default) → IEX feed (free, real-time)
 *                          "false"           → SIP feed (requires Algo Trader Plus $99/mo)
 */
export function createMasterAlpacaClient(): AlpacaClient {
  const keyId = process.env.ALPACA_MASTER_KEY;
  const secretKey = process.env.ALPACA_MASTER_SECRET;
  // Default paper=true → IEX feed (free). Set ALPACA_MASTER_PAPER=false for SIP.
  const paper = process.env.ALPACA_MASTER_PAPER !== "false";

  if (!keyId || !secretKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Chart data unavailable: ALPACA_MASTER_KEY / ALPACA_MASTER_SECRET are not configured on the server.",
    });
  }

  return new AlpacaClient({ keyId, secretKey, paper });
}

/**
 * Shared helper to dynamically instantiate an encrypted AlpacaClient
 * for an authorized user.
 *
 * @throws {TRPCError} if the user's credentials are not securely present
 */
export async function getAlpacaClient(
  db: PoolDb,
  userId: string,
  selector?: AlpacaCredentialSelector
) {
  const credentialSelector = typeof selector === "string"
    ? { accountId: selector }
    : selector;

  const credentials = await getDecryptedCredentials(db, userId, {
    provider: "alpaca",
    accountId: credentialSelector?.accountId,
    credentialId: credentialSelector?.credentialId,
  });

  const client = createAlpacaClientFromCredentials(credentials);

  return { client, credentials };
}
