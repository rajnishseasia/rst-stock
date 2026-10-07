/**
 * Hyperliquid Router
 *
 * tRPC router for Hyperliquid perpetual-futures account management and market
 * data. Order/position procedures live as siblings on the existing `orders` /
 * `positions` routers (matching the "key by provider" pattern); this router owns
 * account enablement (Privy wallet provisioning + withdrawal-DENY policy),
 * status, and keyless market data (meta / candles / mids).
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { perpCoinSchema } from "../lib/perp-orders.js";
import { schema } from "@trade-bot/db";
import type { PoolDb } from "@trade-bot/db";
import { TRPCError } from "@trpc/server";
import {
  networkFromEnv,
  builderCodeFromEnv,
  builderMaxFeeRate,
  DEFAULT_AGENT_NAME,
  isAgentApproved,
  PERP_L2_BOOK_DEFAULT_DEPTH,
  PERP_L2_BOOK_MAX_DEPTH,
} from "@trade-bot/hyperliquid";
import { createProductionLogger } from "@trade-bot/logger";
import { and, eq } from "drizzle-orm";
import {
  createHyperliquidInfoClient,
  findHyperliquidAgentWalletByExternalId,
  hyperliquidAgentRecoveryExternalId,
  provisionHyperliquidAgentWallet,
  verifyEmbeddedMasterOwnership,
  walletRefsToCredentialRow,
  HL_AGENT_PENDING,
  HL_AGENT_REGISTERED,
} from "../lib/hyperliquid.js";
import {
  getUnitSolDepositAddress,
  getUnitSolDepositFee,
} from "../lib/unit-client.js";

const logger = createProductionLogger();

/** Candle intervals supported by HL `candleSnapshot`. */
const candleIntervalSchema = z.enum([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "8h", "12h",
  "1d", "3d", "1w", "1M",
]);

/**
 * Look up the user's stored Hyperliquid credential row (provider="hyperliquid").
 * Returns undefined when the user has not enabled perps.
 */
async function findHyperliquidCredential(db: PoolDb, userId: string) {
  return db.query.userApiCredentials.findFirst({
    where: (creds, { eq, and }) =>
      and(eq(creds.userId, userId), eq(creds.provider, "hyperliquid")),
    // Deterministic pick (belt and braces alongside the partial unique index):
    // if duplicates ever exist, every reader sees the same (oldest) row.
    orderBy: (creds, { asc }) => [asc(creds.createdAt), asc(creds.id)],
  });
}

/** Fail closed when the stored and submitted master addresses do not match. */
function assertPerpsMasterMatches(
  storedMasterAddress: string | null | undefined,
  submittedMasterAddress: string,
): void {
  if (
    !storedMasterAddress ||
    storedMasterAddress.toLowerCase() !== submittedMasterAddress.toLowerCase()
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The Hyperliquid wallet binding does not match this request.",
    });
  }
}

/**
 * Serialize Hyperliquid credential identity changes with the worker's
 * user-first policy lock. The worker holds this row lock from its exact
 * credential reread through leverage application and venue submission, so an
 * in-place agent replacement cannot commit between validation and signing.
 */
async function lockHyperliquidPolicyUser(db: PoolDb, userId: string): Promise<void> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for("update");
  if (rows.length !== 1) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User account is unavailable.",
    });
  }
}

async function withLockedHyperliquidPolicy<T>(
  db: PoolDb,
  userId: string,
  callback: (tx: PoolDb) => Promise<T>,
): Promise<T> {
  const transaction = (db as PoolDb & {
    transaction?: <R>(callback: (tx: PoolDb) => Promise<R>) => Promise<R>;
  }).transaction;
  if (typeof transaction !== "function") return callback(db);
  return transaction.call(db, async (tx: PoolDb) => {
    await lockHyperliquidPolicyUser(tx, userId);
    return callback(tx);
  }) as Promise<T>;
}

export const hyperliquidRouter = router({
  /**
   * Account status: whether perps are enabled, the master wallet address, the
   * on-chain USD figures, and the active network. Drives the Settings card and
   * the venue context.
   *
   * Two DIFFERENT money numbers, because two sets of consumers want different
   * things and conflating them is how a portfolio total goes wrong:
   *   - `hlBalanceUsd` is COLLATERAL, the capital that can back a new order.
   *     The trade ticket's Balance cell, onboarding's "has the deposit landed"
   *     check and copy-mirror sizing all want this one.
   *   - `hlEquityUsd` is the account's TOTAL value, including spot holdings and
   *     unrealized perp PnL. Portfolio totals and account-value headers want
   *     this one.
   * They are far apart in practice: a unified account holding non-USDC spot
   * measured $3.9k collateral against $35.1k equity.
   */
  status: protectedProcedure.query(async ({ ctx }) => {
    const network = networkFromEnv();
    const credential = await findHyperliquidCredential(ctx.db, ctx.userId);

    if (!credential) {
      return {
        enabled: false as const,
        walletAddress: null,
        hlBalanceUsd: null,
        hlEquityUsd: null,
        agentReady: false,
        network,
      };
    }

    const walletAddress = (credential.accountId ?? credential.username) as
      | `0x${string}`
      | null;

    let hlBalanceUsd: string | null = null;
    let hlEquityUsd: string | null = null;
    if (walletAddress) {
      const info = createHyperliquidInfoClient({ network });
      // Settled, not all-or-nothing: these are independent reads, and losing
      // the portfolio call must not also blank the trade ticket's balance.
      const [balance, equity] = await Promise.allSettled([
        info.accountBalanceUsd(walletAddress),
        info.accountEquityUsd(walletAddress),
      ]);
      if (balance.status === "fulfilled") {
        hlBalanceUsd = balance.value;
      } else {
        logger.warn("api", "[Hyperliquid] Failed to fetch clearinghouse state", {
          error:
            balance.reason instanceof Error
              ? balance.reason.message
              : String(balance.reason),
        });
      }
      if (equity.status === "fulfilled") {
        hlEquityUsd = equity.value;
      } else {
        logger.warn("api", "[Hyperliquid] Failed to fetch account equity", {
          error:
            equity.reason instanceof Error
              ? equity.reason.message
              : String(equity.reason),
        });
      }
    }

    return {
      enabled: true as const,
      walletAddress,
      hlBalanceUsd,
      hlEquityUsd,
      // Agent registered on HL yet? False until the first order after funding.
      agentReady: credential.accountType === HL_AGENT_REGISTERED,
      network,
    };
  }),

  /**
   * FREE COLLATERAL that can back a NEW perp order, plus the account value it
   * is measured against.
   *
   * `status` answers "what is this account worth" (`hlEquityUsd`) and "what is
   * in the perp ledger" (`hlBalanceUsd`). Neither answers "how much of that is
   * still uncommitted", which is the number the desktop Balances tab shows
   * beside them and the one copy-mirror sizing has always used server-side.
   * `perpCollateral` reads whichever ledger this account's abstraction mode
   * actually keeps collateral in, so it stays correct under unified account and
   * portfolio margin, where subtracting the perp summary's margin from its own
   * accountValue is off by the whole spot balance.
   *
   * Read-only and fail-soft. Every unknown is reported as null, NEVER as zero:
   * a zeroed free-margin cell reads as "you have no collateral to trade with",
   * which is a different and wrong statement. Callers must render null as
   * "unknown" and must not size an order against it.
   */
  collateral: protectedProcedure.query(async ({ ctx }) => {
    const network = networkFromEnv();
    const empty = {
      freeUsd: null,
      accountValueUsd: null,
      source: null,
    } as const;

    const credential = await findHyperliquidCredential(ctx.db, ctx.userId);
    if (!credential) {
      return { enabled: false as const, ...empty };
    }

    const walletAddress = (credential.accountId ?? credential.username) as
      | `0x${string}`
      | null;
    if (!walletAddress) {
      return { enabled: true as const, ...empty };
    }

    try {
      const info = createHyperliquidInfoClient({ network });
      const collateral = await info.perpCollateral(walletAddress);
      return {
        enabled: true as const,
        freeUsd: collateral?.freeUsd ?? null,
        accountValueUsd: collateral?.accountValueUsd ?? null,
        source: collateral?.source ?? null,
      };
    } catch (error) {
      logger.warn("api", "[Hyperliquid] Failed to fetch perp collateral", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { enabled: true as const, ...empty };
    }
  }),

  /**
   * Enable perps for the user (PHASE 1 of a two-phase flow): provision (or reuse)
   * the AGENT Privy SERVER wallet (withdrawal-DENY policy) keyed to the Better
   * Auth userId, then persist the credential row = the user's EMBEDDED master
   * ADDRESS + the agent refs, with `accountType = "PENDING"` (agent not yet
   * approved). Idempotent — returns the existing account if already enabled.
   *
   * The MASTER is the user's Privy EMBEDDED wallet, created + owned client-side;
   * its address is passed in here. We NEVER create a master server wallet.
   *
   * DELIBERATELY does NOT run `approveAgent` here — that is now signed CLIENT-SIDE
   * by the embedded master wallet (Stage 3), after funding, and confirmed back to
   * the server via `markAgentRegistered` which flips `accountType` to "LIVE".
   */
  enable: protectedProcedure
    .input(
      z.object({
        // The user's Privy EMBEDDED wallet address (the on-chain HL master).
        masterAddress: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/u, "Invalid EVM address"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const masterAddress = input.masterAddress as `0x${string}`;
      const existing = await findHyperliquidCredential(ctx.db, ctx.userId);
      if (existing) {
        assertPerpsMasterMatches(
          existing.accountId ?? existing.username,
          masterAddress,
        );
      }

      const network = networkFromEnv();

      // Builder details (public: the builder address is attached to every order)
      // are surfaced to the CLIENT so the embedded master can sign
      // `approveBuilderFee` client-side with the exact same max fee rate the
      // server enforces. `null` when no builder is configured (v1 default OFF).
      const builder = builderCodeFromEnv();
      const builderConfigured = Boolean(builder);
      const builderAddress = builder ? builder.address : null;
      const builderMaxFeeRateStr = builder ? builderMaxFeeRate(builder) : null;

      if (existing) {
        return {
          success: true,
          alreadyEnabled: true,
          walletAddress: (existing.accountId ?? existing.username) as string | null,
          agentAddress: existing.baseUrl as string | null,
          agentName: DEFAULT_AGENT_NAME,
          agentReady: existing.accountType === HL_AGENT_REGISTERED,
          builderConfigured,
          builderAddress,
          builderMaxFeeRate: builderMaxFeeRateStr,
          network,
        };
      }

      const hasPolicyTransaction =
        typeof (ctx.db as PoolDb & { transaction?: unknown }).transaction ===
        "function";
      if (!hasPolicyTransaction) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not safely verify the existing wallet binding. Please try again.",
        });
      }

      // H1 WRONG-WALLET BINDING: this request would CREATE the credential row,
      // so prove the caller's Better Auth user actually owns the submitted
      // masterAddress before persisting it. The address arrives from the
      // client and is only regex-shaped; without this check, a stale Privy
      // session on a shared browser (user A's wallet, user B's platform
      // login) or a hostile client could bind someone else's wallet.
      // Recheck identity while holding the same per-user lock used for writes.
      // Keep the lock through provisioning so a competing master cannot win
      // after the recheck but before this request's external side effect.
      const result = await withLockedHyperliquidPolicy(
        ctx.db,
        ctx.userId,
        async (tx) => {
          const current = await findHyperliquidCredential(tx, ctx.userId);
          if (current) {
            assertPerpsMasterMatches(
              current.accountId ?? current.username,
              masterAddress,
            );
            return { credential: current, agent: undefined };
          }

          let ownership;
          try {
            ownership = await verifyEmbeddedMasterOwnership(
              ctx.userId,
              masterAddress,
            );
          } catch (error) {
            logger.error("api", "[Hyperliquid] Master ownership check failed", {
              userId: ctx.userId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Could not verify wallet ownership. Please try again.",
            });
          }
          if (ownership !== "verified") {
            logger.warn(
              "api",
              "[Hyperliquid] Rejected enable: master address not owned by user",
              { userId: ctx.userId },
            );
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "That wallet does not belong to your account. Reload the page and try again.",
            });
          }
          let agent;
          try {
            agent = await provisionHyperliquidAgentWallet(ctx.userId, {
              network,
            });
          } catch (error) {
            logger.error("api", "[Hyperliquid] Agent wallet provisioning failed", {
              userId: ctx.userId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message:
                "Failed to provision your Hyperliquid trading agent. Please try again.",
            });
          }

          const row = walletRefsToCredentialRow({
            master: { address: masterAddress },
            agent,
          });
          await tx
            .insert(schema.userApiCredentials)
            .values({
              userId: ctx.userId,
              provider: row.provider,
              encryptedAccessToken: row.encryptedAccessToken,
              encryptedRefreshToken: row.encryptedRefreshToken,
              accountId: row.accountId,
              // Agent not yet approved: flipped to LIVE by markAgentRegistered once the
              // embedded master signs approveAgent client-side. (Network is env-driven;
              // this column tracks agent state.)
              accountType: HL_AGENT_PENDING,
              username: row.username,
              baseUrl: row.baseUrl,
            })
            .onConflictDoNothing();
          const persisted = await findHyperliquidCredential(tx, ctx.userId);
          if (!persisted) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message:
                "Failed to persist your Hyperliquid account. Please try again.",
            });
          }
          assertPerpsMasterMatches(
            persisted.accountId ?? persisted.username,
            masterAddress,
          );
          return { credential: persisted, agent };
        },
      );
      const persisted = result.credential;
      const agent = result.agent;
      const wonInsert = agent
        ? (persisted.baseUrl ?? "").toLowerCase() === agent.address.toLowerCase()
        : false;

      logger.info("api", "[Hyperliquid] Perps enabled (agent pending approval)", {
        userId: ctx.userId,
        walletAddress: persisted.accountId,
        raceLostToConcurrentEnable: !wonInsert,
        network,
      });

      return {
        success: true,
        alreadyEnabled: !wonInsert,
        walletAddress: (persisted.accountId ?? persisted.username) as string | null,
        agentAddress: persisted.baseUrl as string | null,
        agentName: DEFAULT_AGENT_NAME,
        agentReady: persisted.accountType === HL_AGENT_REGISTERED,
        builderConfigured,
        builderAddress,
        builderMaxFeeRate: builderMaxFeeRateStr,
        network,
      };
    }),

  /**
   * Replace a PENDING server-side agent that Hyperliquid refuses because its
   * address was used before. The user's embedded master wallet and all funds
   * stay untouched; only the Privy server-wallet reference on the credential is
   * swapped. This is deliberately unavailable once the credential is LIVE.
   *
   * The replacement's Privy external ID is deterministic from the user + old
   * agent address, so a retry after an ambiguous response converges on the same
   * fresh wallet instead of minting an unbounded chain of agents.
   */
  rotatePendingAgent: protectedProcedure
    .input(
      z.object({
        reason: z.literal("EXTRA_AGENT_ALREADY_USED"),
        failedAgentAddress: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/u, "Invalid failed agent address"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const network = networkFromEnv();
      // Resolve all deployment configuration before provisioning or committing a
      // replacement. A bad builder setting must not turn a successful database
      // swap into an apparent failure that the browser then retries.
      const builder = builderCodeFromEnv();
      const credential = await findHyperliquidCredential(ctx.db, ctx.userId);
      if (!credential) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Hyperliquid is not enabled. Enable Perps first.",
        });
      }
      if (credential.accountType !== HL_AGENT_PENDING) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A registered Hyperliquid trading agent cannot be rotated here.",
        });
      }

      const masterAddress = credential.accountId ?? credential.username;
      const currentAgentAddress = credential.baseUrl;
      if (
        !masterAddress ||
        !/^0x[0-9a-fA-F]{40}$/u.test(masterAddress) ||
        !currentAgentAddress ||
        !/^0x[0-9a-fA-F]{40}$/u.test(currentAgentAddress)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The existing Hyperliquid wallet record is incomplete.",
        });
      }

      const failedAgentAddress = input.failedAgentAddress;
      const agentExternalId = hyperliquidAgentRecoveryExternalId(
        ctx.userId,
        failedAgentAddress,
      );

      // A first attempt may have committed A -> B while its HTTP response was
      // lost. The caller retries with failed address A, so the stable external ID
      // resolves the same B. If the row is neither A nor that deterministic B,
      // this is a stale or conflicting request and must not change anything.
      const isFirstAttempt =
        currentAgentAddress.toLowerCase() === failedAgentAddress.toLowerCase();

      if (isFirstAttempt) {
      let approved: boolean;
      try {
        const agents = await createHyperliquidInfoClient({ network }).extraAgents(
          masterAddress as `0x${string}`,
        );
        approved = isAgentApproved(agents, failedAgentAddress);
      } catch (error) {
          logger.error("api", "[Hyperliquid] Could not verify agent before rotation", {
            userId: ctx.userId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not verify the current trading agent. Please try again.",
          });
        }
      if (approved) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The current trading agent is already approved. Refresh and finish confirming it instead of replacing it.",
          });
        }
      }

      let replacement;
      if (isFirstAttempt) {
        try {
          replacement = await provisionHyperliquidAgentWallet(ctx.userId, {
            network,
            agentExternalId,
          });
        } catch (error) {
          logger.error("api", "[Hyperliquid] Replacement agent provisioning failed", {
            userId: ctx.userId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not create a fresh trading agent. Please try again.",
          });
        }
      } else {
        try {
          replacement = await findHyperliquidAgentWalletByExternalId(agentExternalId);
        } catch (error) {
          logger.error("api", "[Hyperliquid] Replacement agent lookup failed", {
            userId: ctx.userId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not verify the replacement trading agent. Please try again.",
          });
        }
        if (!replacement) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The trading agent changed concurrently. Refresh and try again.",
          });
        }
      }
      if (replacement.address.toLowerCase() === failedAgentAddress.toLowerCase()) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The wallet provider returned the same unusable trading agent.",
        });
      }

      if (!isFirstAttempt) {
        if (currentAgentAddress.toLowerCase() !== replacement.address.toLowerCase()) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The trading agent changed concurrently. Refresh and try again.",
          });
        }
        return {
          success: true as const,
          walletAddress: masterAddress,
          agentAddress: replacement.address,
          agentName: DEFAULT_AGENT_NAME,
          agentReady: false,
          builderConfigured: Boolean(builder),
          builderAddress: builder?.address ?? null,
          builderMaxFeeRate: builder ? builderMaxFeeRate(builder) : null,
          network,
        };
      }

      const replacementRow = walletRefsToCredentialRow({
        master: { address: masterAddress as `0x${string}` },
        agent: replacement,
      });
      // A credential replacement is a policy mutation. Re-read ownership and
      // atomically swap the agent material under the same user-first lock the
      // worker holds through signing. A worker that already acquired the lock
      // therefore finishes with the old material before this swap commits;
      // subsequent workers rebuild from the replacement row.
      const persisted = await withLockedHyperliquidPolicy(
        ctx.db,
        ctx.userId,
        async (tx) => {
          const lockedCredential = await findHyperliquidCredential(tx, ctx.userId);
          if (
            !lockedCredential ||
            lockedCredential.id !== credential.id ||
            lockedCredential.provider !== "hyperliquid" ||
            lockedCredential.accountType !== HL_AGENT_PENDING ||
            (lockedCredential.baseUrl ?? "").toLowerCase() !== currentAgentAddress.toLowerCase()
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "The trading agent changed concurrently. Refresh and try again.",
            });
          }
          const updated = await tx
            .update(schema.userApiCredentials)
            .set({
              encryptedRefreshToken: replacementRow.encryptedRefreshToken,
              baseUrl: replacement.address,
              accountType: HL_AGENT_PENDING,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.userApiCredentials.id, credential.id),
                eq(schema.userApiCredentials.userId, ctx.userId),
                eq(schema.userApiCredentials.provider, "hyperliquid"),
                eq(schema.userApiCredentials.accountType, HL_AGENT_PENDING),
                eq(schema.userApiCredentials.baseUrl, currentAgentAddress),
              ),
            )
            .returning({ id: schema.userApiCredentials.id });
          if (updated.length !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "The trading agent changed concurrently. Refresh and try again.",
            });
          }
          return findHyperliquidCredential(tx, ctx.userId);
        },
      );

      // A concurrent retry uses the same deterministic Privy wallet. Re-read the
      // authoritative row and accept only convergence on that exact address.
      if (
        !persisted ||
        (persisted.baseUrl ?? "").toLowerCase() !== replacement.address.toLowerCase() ||
        persisted.accountType !== HL_AGENT_PENDING
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "The trading agent changed concurrently. Refresh and try again.",
        });
      }

      logger.warn("api", "[Hyperliquid] Rotated unusable pending trading agent", {
        userId: ctx.userId,
        walletAddress: masterAddress,
        network,
      });
      return {
        success: true as const,
        walletAddress: masterAddress,
        agentAddress: replacement.address,
        agentName: DEFAULT_AGENT_NAME,
        agentReady: false,
        builderConfigured: Boolean(builder),
        builderAddress: builder?.address ?? null,
        builderMaxFeeRate: builder ? builderMaxFeeRate(builder) : null,
        network,
      };
    }),

  /**
   * Confirm agent approval (PHASE 2). Called by the CLIENT after the embedded
   * master wallet has signed `approveAgent` (+ `approveBuilderFee` when a builder
   * is configured) against Hyperliquid. Flips `accountType` PENDING → LIVE so
   * orders (agent-signed, server-side) are accepted.
   *
   * REAL on-chain verification (fund-critical): we read HL `extraAgents(master)`
   * and only flip LIVE when the STORED agent address is actually among the
   * approved agents for the STORED master. This closes two failure modes:
   *   - a blind flip when the approveAgent signature never landed; and
   *   - the enable-with-A / activate-with-B mismatch — if the user signed
   *     approveAgent with a DIFFERENT wallet (B) than the master we enabled with
   *     (A), then extraAgents(A) will NOT contain our agent, so LIVE never flips.
   */
  markAgentRegistered: protectedProcedure.mutation(async ({ ctx }) => {
    const network = networkFromEnv();

    const credential = await findHyperliquidCredential(ctx.db, ctx.userId);
    if (!credential) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Hyperliquid is not enabled. Enable Perps first.",
      });
    }

    if (credential.accountType === HL_AGENT_REGISTERED) {
      return { success: true, alreadyRegistered: true, agentReady: true, network };
    }

    // Stored layout: accountId/username = EMBEDDED master address (the account
    // that signs approveAgent), baseUrl = the AGENT address we provisioned.
    const masterAddress = (credential.accountId ?? credential.username) as
      | `0x${string}`
      | null;
    const agentAddress = credential.baseUrl as `0x${string}` | null;
    if (!masterAddress || !agentAddress) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Hyperliquid wallet is not fully provisioned. Re-run 'Enable Perps' in Settings.",
      });
    }

    // Read the on-chain list of agents approved for the master, and require our
    // stored agent to be among them (case-insensitive) before flipping LIVE.
    let approved: boolean;
    try {
      const info = createHyperliquidInfoClient({ network });
      const agents = await info.extraAgents(masterAddress);
      approved = isAgentApproved(agents, agentAddress);
    } catch (error) {
      logger.error("api", "[Hyperliquid] extraAgents verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Could not verify agent approval with Hyperliquid. Please try again in a moment.",
      });
    }

    if (!approved) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `Agent approval not found for this wallet — make sure you activated with the same wallet you enabled with (${masterAddress}), and that the approveAgent signature went through.`,
      });
    }

    const updated = await withLockedHyperliquidPolicy(
      ctx.db,
      ctx.userId,
      async (tx) => {
        const lockedCredential = await findHyperliquidCredential(tx, ctx.userId);
        if (
          !lockedCredential ||
          lockedCredential.id !== credential.id ||
          lockedCredential.provider !== "hyperliquid" ||
          (lockedCredential.baseUrl ?? "").toLowerCase() !== agentAddress.toLowerCase()
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The trading agent changed while approval was being confirmed. Refresh before trying again.",
          });
        }
        if (lockedCredential.accountType === HL_AGENT_REGISTERED) {
          return [{
            id: lockedCredential.id,
            accountType: lockedCredential.accountType,
            baseUrl: lockedCredential.baseUrl,
          }];
        }
        if (lockedCredential.accountType !== HL_AGENT_PENDING) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The trading agent changed while approval was being confirmed. Refresh before trying again.",
          });
        }
        return tx
          .update(schema.userApiCredentials)
          .set({ accountType: HL_AGENT_REGISTERED })
          .where(
            and(
              eq(schema.userApiCredentials.id, credential.id),
              eq(schema.userApiCredentials.userId, ctx.userId),
              eq(schema.userApiCredentials.provider, "hyperliquid"),
              eq(schema.userApiCredentials.accountType, HL_AGENT_PENDING),
              eq(schema.userApiCredentials.baseUrl, agentAddress),
            ),
          )
          .returning({
            id: schema.userApiCredentials.id,
            accountType: schema.userApiCredentials.accountType,
            baseUrl: schema.userApiCredentials.baseUrl,
          });
      },
    );

    if (updated.length === 0) {
      const persisted = await findHyperliquidCredential(ctx.db, ctx.userId);
      const sameAgent =
        persisted?.id === credential.id &&
        (persisted.baseUrl ?? "").toLowerCase() === agentAddress.toLowerCase();
      if (sameAgent && persisted?.accountType === HL_AGENT_REGISTERED) {
        return { success: true, alreadyRegistered: true, agentReady: true, network };
      }
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "The trading agent changed while approval was being confirmed. Refresh before trying again.",
      });
    }

    logger.info("api", "[Hyperliquid] Agent registered (extraAgents-verified)", {
      userId: ctx.userId,
      network,
    });

    return { success: true, alreadyRegistered: false, agentReady: true, network };
  }),

  /**
   * Perp universe with per-asset szDecimals + maxLeverage (keyless). Drives the
   * symbol picker, size rounding, and the leverage-slider clamp.
   */
  meta: protectedProcedure.query(async () => {
    const info = createHyperliquidInfoClient();
    const universe = await info.getUniverse();
    return {
      network: networkFromEnv(),
      universe: universe
        .filter((a) => !a.isDelisted)
        .map((a) => ({
          coin: a.coin,
          assetIndex: a.assetIndex,
          szDecimals: a.szDecimals,
          maxLeverage: a.maxLeverage,
        })),
    };
  }),

  /**
   * Candle snapshot for the perp chart datafeed (keyless).
   */
  candleSnapshot: protectedProcedure
    .input(
      z.object({
        coin: perpCoinSchema,
        interval: candleIntervalSchema,
        startTime: z.number().int().nonnegative(),
        endTime: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      const info = createHyperliquidInfoClient();
      return info.candleSnapshot(
        {
          coin: input.coin,
          interval: input.interval,
          startTime: input.startTime,
          ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
        },
        // A chart can retry or render an empty state. It must never keep the
        // rest of the terminal loading for the transport's full retry window.
        AbortSignal.timeout(5_000),
      );
    }),

  /**
   * All mids keyed by coin (keyless). Drives USD↔coin size sync + mark prices.
   */
  allMids: protectedProcedure
    .input(z.object({ coin: perpCoinSchema }).optional())
    .query(async ({ input }) => {
      const info = createHyperliquidInfoClient();
      return info.allMids(input?.coin);
    }),

  /**
   * Live market snapshot for one coin (keyless): mark / mid / oracle / prevDay
   * prices, funding, 24h volume, and top-of-book bid/ask. Drives the perps
   * header strip (price / 24h change / bid-ask). Read-only market data, so no
   * wallet or credential is required. The coin must pass through untouched
   * (trim only): `symbolSchema` would reject prefixed HL coins like
   * `xyz:GOOGL` because its charset has no `:`. The client resolves the coin
   * case-insensitively and returns HL's canonical spelling.
   */
  assetSnapshot: protectedProcedure
    .input(z.object({ coin: perpCoinSchema }))
    .query(async ({ input }) => {
      const info = createHyperliquidInfoClient();
      return info.assetSnapshot(input.coin);
    }),

  /**
   * Depth-limited L2 order book for one coin (keyless). Drives the desktop
   * perps order-book rail beside the chart: `assetSnapshot` already reads this
   * endpoint but keeps only the top of each side, so the ladder needed its own
   * procedure rather than a widened snapshot payload every other caller pays
   * for.
   *
   * The coin uses the shared `perpCoinSchema` (trim only) for the same reason
   * `assetSnapshot` does: `symbolSchema` would reject prefixed HIP-3 coins like
   * `xyz:GOOGL` because its charset has no `:`. Depth is clamped in the client;
   * the bound here just refuses an absurd request before it reaches HL.
   *
   * Read-only market data, so no wallet or credential is required. The ladder
   * is aggregated, public depth: it exposes nothing about who is resting where.
   */
  l2Book: protectedProcedure
    .input(
      z.object({
        coin: perpCoinSchema,
        depth: z
          .number()
          .int()
          .min(1)
          .max(PERP_L2_BOOK_MAX_DEPTH)
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const info = createHyperliquidInfoClient();
      return info.l2Book(
        input.coin,
        input.depth ?? PERP_L2_BOOK_DEFAULT_DEPTH,
      );
    }),

  /**
   * Per-coin market stats (mark / prev-day price, 24h volume, open interest,
   * funding rate, max leverage) for the whole tradable universe in one keyless
   * call. Drives the HL Markets list. Read-only market data, so no wallet or
   * credential is required, and no user input is accepted.
   */
  marketStats: protectedProcedure.query(async () => {
    const info = createHyperliquidInfoClient();
    return info.getUniverseStats();
  }),

  /**
   * Preview a Hyperliquid wallet address before the user commits to following it.
   * Returns the wallet's current open positions and its most recent 20 fills.
   *
   * Uses the keyless HL info client — no credential or signing key required.
   * All data is public on-chain. Requires the caller to be authenticated on RST
   * (consistent with the other keyless market-data endpoints above).
   */
  walletPreview: protectedProcedure
    .input(
      z.object({
        address: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid 0x Ethereum address"),
      }),
    )
    .query(async ({ input }) => {
      const info = createHyperliquidInfoClient();
      const address = input.address as `0x${string}`;
      const [positions, recentFills] = await Promise.all([
        info.listPositions(address),
        info.listFills(address, 20),
      ]);
      return { positions, recentFills };
    }),

  /**
   * Solana funding address via Unit.
   * Derives the user's bound Hyperliquid master address and calls Unit to generate
   * or retrieve the unique Solana deposit address for this account.
   */
  solFundingAddress: protectedProcedure.query(async ({ ctx }) => {
    const credential = await findHyperliquidCredential(ctx.db, ctx.userId);
    if (!credential) {
      return { enabled: false as const, walletAddress: null, depositAddress: null, fee: null };
    }
    const walletAddress = (credential.accountId ?? credential.username) as string | null;
    if (!walletAddress) {
      return { enabled: false as const, walletAddress: null, depositAddress: null, fee: null };
    }

    try {
      const [depositAddress, fee] = await Promise.all([
        getUnitSolDepositAddress(walletAddress),
        getUnitSolDepositFee(),
      ]);
      return {
        enabled: true as const,
        walletAddress,
        depositAddress,
        fee,
      };
    } catch (error) {
      logger.warn("api", "[Hyperliquid] Failed to get Unit Solana deposit address", {
        userId: ctx.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        enabled: true as const,
        walletAddress,
        depositAddress: null,
        fee: null,
        error: error instanceof Error ? error.message : "Failed to load deposit address",
      };
    }
  }),
});
