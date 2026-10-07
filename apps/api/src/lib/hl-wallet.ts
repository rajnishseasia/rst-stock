/**
 * Hyperliquid master-wallet lookup shared by the read-only perp endpoints.
 *
 * Lives here rather than inside a router so any procedure that has to value a
 * perp position server-side (positions, PNL cards) reads the same credential
 * row through the same validation.
 */

import type { PoolDb } from "@trade-bot/db";

/**
 * Resolve the user's Hyperliquid master wallet address from their stored
 * credential row (provider="hyperliquid"). Returns null when perps are not
 * enabled OR the stored value is not a 0x-prefixed 20-byte address: the
 * accountId/username columns are generic, so validate the shape here instead of
 * casting, to avoid handing a stray non-address string to the InfoClient.
 */
export async function resolveHlWalletAddress(
  db: PoolDb,
  userId: string,
): Promise<`0x${string}` | null> {
  const credential = await db.query.userApiCredentials.findFirst({
    where: (creds, { eq, and }) =>
      and(eq(creds.userId, userId), eq(creds.provider, "hyperliquid")),
    columns: { accountId: true, username: true },
  });
  const raw = credential?.accountId ?? credential?.username ?? null;
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}
