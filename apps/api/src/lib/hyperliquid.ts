/**
 * Hyperliquid client factory (mirrors `lib/alpaca.ts`).
 *
 * Bridges Privy server wallets → the `@trade-bot/hyperliquid` wrapper:
 *   - `createHyperliquidInfoClient` — keyless read client for market data /
 *     metadata / clearinghouse state (no wallet, no Privy).
 *   - `createHyperliquidExchangeClient` — fetches the user's Privy AGENT wallet
 *     ref from `user_api_credentials` (provider="hyperliquid"), builds a
 *     server-signed viem account via `createViemAccount`, and returns a
 *     `HyperliquidClient` that can place/cancel/close orders + set leverage.
 *   - `provisionHyperliquidAgentWallet` — one-time AGENT server-wallet provisioning +
 *     withdrawal-DENY policy, used by the `hyperliquid.enable` mutation. The
 *     MASTER is the user's Privy EMBEDDED wallet (client-side), NOT a server
 *     wallet — its address is passed in and stored read-only.
 *
 * NOTE: `approveAgent` (+ `approveBuilderFee`) are now signed CLIENT-SIDE by the
 * embedded master wallet (Stage 3), so there is no server-side agent-registration
 * helper here anymore.
 *
 * SECRETS: Privy credentials are read from env by NAME only
 * (PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_AUTHORIZATION_KEY). Never logged.
 */

import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import {
  PrivyClient,
  NotFoundError,
  isEmbeddedWalletLinkedAccount,
  type LinkedAccount,
} from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import {
  HyperliquidClient,
  authorizationContextFromKey,
  buildWithdrawalDenyPolicy,
  builderCodeFromEnv,
  networkFromEnv,
  type HyperliquidTrafficClass,
  type HyperliquidNetwork,
  type HyperliquidWalletRefs,
  type PrivyWalletRef,
} from "@trade-bot/hyperliquid";
import { encrypt } from "@trade-bot/utils";
import { getDecryptedCredentials } from "./credentials.js";
import type { PoolDb } from "@trade-bot/db";

interface HyperliquidClientOptions {
  /** Override the env-derived network (mainnet default; testnet for dev). */
  network?: HyperliquidNetwork;
  /**
   * Select the exact owned credential row when a caller has already validated
   * its identity under the user's policy lock. Omitting this preserves the
   * existing single-credential lookup behavior for read-only callers.
   */
  credentialId?: string;
  /**
   * Override the idempotency key used when provisioning a replacement agent.
   * Privy external IDs are unique, immutable, URL-safe, and capped at 64 chars.
   */
  agentExternalId?: string;
  /** Keep background reconciliation inside its reserved REST allowance. */
  trafficClass?: HyperliquidTrafficClass;
}

const sharedInfoClients = new Map<string, HyperliquidClient>();

/**
 * Read the Privy app credentials from env and construct a PrivyClient.
 * @throws TRPCError if the server is not configured for Hyperliquid.
 */
function createPrivyClient(): PrivyClient {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Hyperliquid is not configured on the server: PRIVY_APP_ID / PRIVY_APP_SECRET are missing.",
    });
  }
  return new PrivyClient({ appId, appSecret });
}

/** Read the Privy authorization key (server-signing) from env. */
function getAuthorizationKey(): string {
  const key = process.env.PRIVY_AUTHORIZATION_KEY;
  if (!key) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Hyperliquid is not configured on the server: PRIVY_AUTHORIZATION_KEY is missing.",
    });
  }
  return key;
}

/** Resolve the network from an explicit option, else the env default. */
function resolveNetwork(
  options?: HyperliquidClientOptions,
): HyperliquidNetwork {
  return options?.network ?? networkFromEnv();
}

/**
 * Keyless read-only Hyperliquid client for market data, metadata, and
 * clearinghouse state. No wallet, no Privy — trading methods throw if called.
 */
export function createHyperliquidInfoClient(
  options?: HyperliquidClientOptions,
): HyperliquidClient {
  const network = resolveNetwork(options);
  const trafficClass = options?.trafficClass ?? "standard";
  const cacheKey = `${network}:${trafficClass}`;
  const existing = sharedInfoClients.get(cacheKey);
  if (existing) return existing;
  const client = new HyperliquidClient({ network, trafficClass });
  sharedInfoClients.set(cacheKey, client);
  return client;
}

/**
 * Build a signing `HyperliquidClient` for a user, backed by their Privy AGENT
 * wallet. The agent signs orders/cancels/leverage; withdrawals are blocked by
 * the enclave policy.
 *
 * Builder code is OPTIONAL: it is attached to orders ONLY when
 * `HL_BUILDER_ADDRESS` is configured. With no builder configured the client is
 * still fully functional — placeOrder, cancelPerp, and setLeverage all work
 * (the wrapper never sends `builder: undefined`). Builder codes ship OFF for v1.
 *
 * @throws TRPCError if the user has not enabled Hyperliquid (no stored refs).
 */
export async function createHyperliquidExchangeClient(
  db: PoolDb,
  userId: string,
  options?: HyperliquidClientOptions,
): Promise<{ client: HyperliquidClient; walletAddress: `0x${string}` }> {
  const network = resolveNetwork(options);
  const credentials = await getDecryptedCredentials(db, userId, {
    provider: "hyperliquid",
    ...(options?.credentialId ? { credentialId: options.credentialId } : {}),
  });

  // Layout (see credentials.ts): refreshToken=agent walletId,
  // accountId/username=EMBEDDED master address (read-only), baseUrl=agent address.
  // (accessToken is unused for hyperliquid now — the master is client-signed.)
  const agentWalletId = credentials.refreshToken;
  const agentAddress = credentials.baseUrl;
  const masterAddress = credentials.accountId ?? credentials.username;
  if (!agentWalletId || !agentAddress || !masterAddress) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Hyperliquid wallet is not fully provisioned. Re-run 'Enable Perps' in Settings.",
    });
  }

  const privy = createPrivyClient();
  const authorizationContext = authorizationContextFromKey(
    getAuthorizationKey(),
  );

  const agentAccount = createViemAccount(privy, {
    walletId: agentWalletId,
    address: agentAddress as `0x${string}`,
    authorizationContext,
  });

  // Builder is OPTIONAL. When HL_BUILDER_ADDRESS is unset, builder is undefined
  // and the wrapper places orders (and cancels / sets leverage) with no builder
  // attached — never `builder: undefined`. Builder codes ship OFF for v1.
  const builder = builderCodeFromEnv();

  const client = new HyperliquidClient({
    network,
    trafficClass: "order-critical",
    wallet: agentAccount,
    ...(builder ? { builder } : {}),
  });

  return { client, walletAddress: masterAddress as `0x${string}` };
}

/**
 * Provision the AGENT Privy SERVER wallet for a user, keyed to their Better Auth
 * userId (via Privy `external_id`), carrying the withdrawal-DENY policy. Returns
 * the agent ref to persist alongside the embedded master address.
 *
 * ONLY the agent is a server wallet. The MASTER is the user's Privy EMBEDDED
 * wallet (client-owned, self-custody) — its address is supplied by the client to
 * `hyperliquid.enable`, never created here.
 *
 * This only creates the agent wallet + policy. The MASTER-signed HL setup that
 * makes the agent usable — `approveAgent` (and `approveBuilderFee` when a builder
 * is configured) — is now signed CLIENT-SIDE by the embedded wallet (Stage 3),
 * after funding, then confirmed to the server via `markAgentRegistered`.
 */
const toWalletRef = (w: { id: string; address: string }): PrivyWalletRef => ({
  walletId: w.id,
  address: w.address as `0x${string}`,
});

/**
 * Find an existing Privy wallet by its `external_id`, or null. Used to make
 * provisioning idempotent so a retried `enable` REUSES the user's agent wallet
 * instead of minting duplicates (external_id is write-once per Privy).
 */
async function findWalletByExternalId(
  privy: PrivyClient,
  externalId: string,
): Promise<PrivyWalletRef | null> {
  for await (const w of privy.wallets().list({ external_id: externalId })) {
    return toWalletRef(w);
  }
  return null;
}

/**
 * Read-only lookup used to recognize a completed agent rotation after its HTTP
 * response was lost. Unlike provisioning, this never creates a wallet or a
 * policy for a stale caller-supplied recovery address.
 */
export async function findHyperliquidAgentWalletByExternalId(
  externalId: string,
): Promise<PrivyWalletRef | null> {
  return findWalletByExternalId(createPrivyClient(), externalId);
}

/**
 * Provision (or reuse) the AGENT server wallet for a user. Idempotent: a retried
 * `enable` returns the existing agent rather than minting a duplicate.
 */
export async function provisionHyperliquidAgentWallet(
  userId: string,
  options?: HyperliquidClientOptions,
): Promise<PrivyWalletRef> {
  const network = resolveNetwork(options);
  const privy = createPrivyClient();

  const agentExternalId = options?.agentExternalId ?? `rst-hl-agent-${userId}`;

  // IDEMPOTENT: reuse an existing agent if a prior attempt already created it.
  const existingAgent = await findWalletByExternalId(privy, agentExternalId);
  if (existingAgent) {
    return existingAgent;
  }

  // Creating the agent → attach the withdrawal-DENY policy to it (agent-only).
  const policy = await privy
    .policies()
    .create(buildWithdrawalDenyPolicy(network));

  // NOTE on a lost race: the policy created just above is orphaned in Privy (a
  // small, harmless leak). Left as-is rather than deleting it on a path where
  // the API may already be failing; the next attempt creates a fresh policy.
  return createWalletWithRaceRecovery(
    async () =>
      toWalletRef(
        await privy.wallets().create({
          chain_type: "ethereum",
          external_id: agentExternalId,
          policy_ids: [policy.id],
        }),
      ),
    () => findWalletByExternalId(privy, agentExternalId).catch(() => null),
  );
}

/**
 * Stable Privy external ID for replacing one unusable Hyperliquid agent.
 *
 * Hyperliquid explicitly recommends never reusing an agent address after it
 * has been deregistered. Hashing both the platform user and the old address
 * gives one fresh wallet per failed agent while making retries converge on the
 * same replacement after an ambiguous API response. The result is URL-safe and
 * comfortably below Privy's 64-character external-ID limit.
 */
export function hyperliquidAgentRecoveryExternalId(
  userId: string,
  oldAgentAddress: string,
): string {
  const digest = createHash("sha256")
    .update(`${userId}:${oldAgentAddress.toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return `rst-hl-recovery-${digest}`;
}

/**
 * Run a wallet `create` that may lose a race, and converge instead of erroring.
 *
 * Two concurrent `enable` calls (two tabs) can both miss the existence check and
 * both reach `create`. This deliberately does NOT depend on how Privy handles a
 * duplicate `external_id`, because the two plausible behaviors fail differently:
 * if Privy dedupes, `create` simply returns the shared wallet and we pass it
 * through; if Privy rejects the duplicate, the loser would otherwise surface a
 * generic 500 even though the winner just provisioned the exact wallet it wants.
 * On any create failure we re-read by external id and adopt the winner's wallet,
 * so the losing tab converges silently. A failure with nothing to adopt is a
 * genuine provisioning error and is rethrown unchanged.
 *
 * Pure in its dependencies (both operations are injected) so the race is
 * unit-testable without a live Privy client.
 */
export async function createWalletWithRaceRecovery<T>(
  create: () => Promise<T>,
  findExisting: () => Promise<T | null>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    const raced = await findExisting();
    if (raced) return raced;
    throw error;
  }
}

/**
 * Pure check: does this Privy user own `address` as an ETHEREUM EMBEDDED
 * wallet? Exported for real-module tests. Case-insensitive on the address;
 * only embedded wallets count (an externally linked EOA is not the
 * self-custody master the client claims to have auto-created).
 */
export function privyUserOwnsEmbeddedAddress(
  linkedAccounts: readonly LinkedAccount[],
  address: string,
): boolean {
  const target = address.toLowerCase();
  return linkedAccounts.some(
    (account) =>
      isEmbeddedWalletLinkedAccount(account) &&
      account.chain_type === "ethereum" &&
      account.address.toLowerCase() === target,
  );
}

/** Result of the master-address ownership check for `hyperliquid.enable`. */
export type PrivyOwnershipCheck =
  /** The Privy user for this Better Auth userId owns the address. */
  | "verified"
  /** The Privy user exists but does NOT own the address: reject. */
  | "mismatch"
  /** No Privy user is linked to this Better Auth userId: reject. */
  | "unresolvable";

/**
 * SERVER-SIDE wrong-wallet-binding guard for `hyperliquid.enable` (H1): before
 * persisting a NEW credential row, prove the submitted masterAddress is an
 * embedded wallet of the Privy user whose custom-auth id equals the Better
 * Auth userId. Without this, a stale Privy session on a shared browser (or a
 * hostile client) could bind user A's wallet address to user B's account.
 *
 * Throws on transport/API errors other than not-found: enable cannot proceed
 * without Privy anyway (agent provisioning is next), so failing closed loses
 * no availability and never lets an unverified address through on a flake.
 */
export async function verifyEmbeddedMasterOwnership(
  userId: string,
  masterAddress: string,
): Promise<PrivyOwnershipCheck> {
  const privy = createPrivyClient();
  let linkedAccounts: LinkedAccount[];
  try {
    const user = await privy
      .users()
      .getByCustomAuthID({ custom_user_id: userId });
    linkedAccounts = user.linked_accounts ?? [];
  } catch (error) {
    if (error instanceof NotFoundError) return "unresolvable";
    throw error;
  }
  return privyUserOwnsEmbeddedAddress(linkedAccounts, masterAddress)
    ? "verified"
    : "mismatch";
}

/**
 * Agent-registration state, stored in the hyperliquid credential row's
 * `accountType` column (the env drives the network, so this field is free to
 * repurpose): "PENDING" = wallets provisioned but the embedded master has not yet
 * signed `approveAgent`; "LIVE" = agent registered (client-confirmed) and usable.
 */
export const HL_AGENT_PENDING = "PENDING";
export const HL_AGENT_REGISTERED = "LIVE";

/**
 * Serialize the embedded master address + agent server-wallet ref into the
 * `user_api_credentials` column layout consumed by `getDecryptedCredentials` /
 * the exchange factory.
 *
 *   - accountId / username = the EMBEDDED master ADDRESS (read-only public id).
 *   - baseUrl             = the AGENT server-wallet address.
 *   - encryptedRefreshToken = the AGENT server-wallet id (drives the server signer).
 *   - encryptedAccessToken  = UNUSED for hyperliquid now (the master is
 *     client-signed, so there is no master walletId). Encrypt an empty string to
 *     satisfy the NOT NULL column while storing no secret.
 */
export function walletRefsToCredentialRow(refs: HyperliquidWalletRefs): {
  provider: "hyperliquid";
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  accountId: string;
  username: string;
  baseUrl: string;
} {
  return {
    provider: "hyperliquid",
    // No master walletId anymore (embedded/client-signed). Empty placeholder.
    encryptedAccessToken: encrypt(""),
    encryptedRefreshToken: encrypt(refs.agent.walletId),
    accountId: refs.master.address,
    username: refs.master.address,
    baseUrl: refs.agent.address,
  };
}
