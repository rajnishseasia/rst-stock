/**
 * User Settings Router
 *
 * tRPC router for user settings and broker credentials.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { router, protectedProcedure } from "../trpc.js";
import { millisecondTimestamp, millisecondTimestampValue, schema } from "@trade-bot/db";
import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { decrypt, encrypt, DecryptionAuthenticationError } from "@trade-bot/utils";
import { TRPCError } from "@trpc/server";
import { networkFromEnv } from "@trade-bot/hyperliquid";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";
import { checkAlpacaCredentials } from "../lib/alpaca-credential-check.js";
import {
  readStoredTerminalLayout,
  terminalLayoutSettingSchema,
} from "../lib/terminal-layout.js";
import { resolveTraderIdentity } from "../lib/trader-identity.js";
import { syncUserFromTwitterToken } from "../lib/twitter-profile.js";
import { invalidateUserLeaderboardCache } from "../lib/leaderboard-identity-cache.js";

// Broker credential schema
const brokerCredentialSchema = z.object({
  provider: z.enum(["alpaca"]).default("alpaca"),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  accountId: z.string().optional(),
  accountType: z.enum(["LIVE", "PAPER", "SIM"]).default("PAPER"),
  username: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

const copyPerpMaxLeverageSchema = z
  .number()
  .int()
  .min(COPY_PERP_MAX_LEVERAGE_MIN)
  .max(COPY_PERP_MAX_LEVERAGE_MAX);

const API_CREDENTIAL_STATUS_PAGE_SIZE = 50;
const INVALID_CREDENTIALS_CURSOR_MESSAGE = "Invalid credentials pagination cursor.";
const ALPACA_CREDENTIAL_STATUS_ERROR_MESSAGE = "Could not verify saved Alpaca credentials.";
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ApiCredentialsCursor = {
  createdAt: Date;
  id: string;
  scope: string;
};

function credentialsCursorScope(userId: string, provider?: string): string {
  return createHash("sha256")
    .update(`${userId}\0${provider ?? "all"}`)
    .digest("hex");
}

function encodeApiCredentialsCursor(cursor: ApiCredentialsCursor): string {
  return Buffer.from(
    JSON.stringify({ version: 1, createdAt: cursor.createdAt.toISOString(), id: cursor.id, scope: cursor.scope }),
    "utf8",
  ).toString("base64url");
}

function decodeApiCredentialsCursor(value: string, scope: string): ApiCredentialsCursor | null {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      !CANONICAL_UUID_PATTERN.test(parsed.id) ||
      typeof parsed.scope !== "string" ||
      parsed.scope !== scope
    ) return null;

    const createdAt = millisecondTimestampValue(parsed.createdAt);
    if (!createdAt || createdAt.toISOString() !== parsed.createdAt) return null;
    return { createdAt, id: parsed.id, scope: parsed.scope };
  } catch {
    return null;
  }
}

/** Lock the authenticated user's policy row before mutating credentials. */
async function lockUserPolicyRow(db: any, userId: string): Promise<void> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for("update");
  if (rows.length !== 1) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Credentials not found. Please add your API keys in the Settings page.",
    });
  }
}

export interface SaveApiCredentialsResponse { success: boolean; message: string; }

export const userSettingsRouter = router({
  /** Public-facing identity preview used by the combined Profile settings tab. */
  socialIdentity: protectedProcedure.query(async ({ ctx }) => {
    const [user, twitterAccount] = await Promise.all([
      ctx.db.query.users.findFirst({
        where: eq(schema.users.id, ctx.userId),
        columns: { name: true, twitterName: true, username: true, image: true },
      }),
      ctx.db.query.accounts.findFirst({
        where: (account, { and, eq }) => and(
          eq(account.userId, ctx.userId),
          eq(account.providerId, "twitter"),
        ),
        columns: { id: true },
      }),
    ]);
    const identity = resolveTraderIdentity(ctx.userId, {
      twitterLinked: Boolean(twitterAccount),
      name: user?.name,
      twitterName: user?.twitterName,
      username: user?.username,
      image: user?.image,
    });
    return {
      ...identity,
      anonymousIdentity: resolveTraderIdentity(ctx.userId),
      twitterProfileComplete: Boolean(
        twitterAccount &&
          user?.username?.trim() &&
          user.twitterName?.trim() &&
          user.image?.trim(),
      ),
      twitterConfigured: Boolean(process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET),
    };
  }),

  /**
   * Disconnect the Twitter/X account for the current user. Removes the
   * accounts row for the twitter provider AND clears the Twitter-specific
   * profile fields (username, twitterName, image) from the users table so
   * the identity card reverts to the anonymous/Google identity immediately.
   */
  unlinkTwitter: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.transaction(async (tx) => {
      // Remove the OAuth account link so Better Auth no longer considers the
      // user to have a twitter provider.
      await tx
        .delete(schema.accounts)
        .where(
          and(
            eq(schema.accounts.userId, ctx.userId),
            eq(schema.accounts.providerId, "twitter"),
          ),
        );

      // Clear Twitter-sourced profile fields. The Google name/image remain
      // intact in the Better Auth session; only the twitter-specific columns
      // (handle, display name, and the twitter avatar URL) are wiped.
      await tx
        .update(schema.users)
        .set({ username: null, twitterName: null, image: null })
        .where(eq(schema.users.id, ctx.userId));
    });
    // Bust the leaderboard cache so other users immediately see the reverted
    // identity (anonymous pseudonym) rather than waiting up to 2 hours for the
    // Redis TTL to expire.
    await invalidateUserLeaderboardCache();
    return { ok: true };
  }),

  /**
   * Re-sync the user's Twitter display name, @handle, and avatar from the
   * Twitter API using the stored access token. Useful when the initial OAuth
   * sync failed (e.g. a transient Twitter API error) and the user's twitterName
   * is still null despite having linked their account.
   *
   * Returns { ok: true } on success, { ok: false, reason: "..." } on failure.
   */
  refreshTwitterProfile: protectedProcedure.mutation(async ({ ctx }) => {
    const account = await ctx.db.query.accounts.findFirst({
      where: (a, { and: andFn, eq: eqFn }) => andFn(
        eqFn(a.userId, ctx.userId),
        eqFn(a.providerId, "twitter"),
      ),
      columns: { accessToken: true },
    });
    if (!account) {
      return { ok: false, reason: "no_twitter_account" } as const;
    }
    const accessToken = account.accessToken as string | null | undefined;
    if (!accessToken) {
      return { ok: false, reason: "no_access_token" } as const;
    }
    const result = await syncUserFromTwitterToken(ctx.userId, accessToken);
    if (result.ok) {
      // Bust the leaderboard cache so other users see the refreshed
      // display name / avatar without waiting for the Redis TTL to expire.
      await invalidateUserLeaderboardCache();
    }
    return result.ok
      ? ({ ok: true } as const)
      : ({ ok: false, reason: "sync_failed" } as const);
  }),

  /**
   * Save encrypted broker credentials
   */
  saveApiCredentials: protectedProcedure
    .input(brokerCredentialSchema)
    .mutation(async ({ ctx, input }) => {
      const accountType = input.accountType === "SIM" ? "PAPER" : input.accountType;

      // Trim pasted whitespace up front so the values we verify are exactly
      // the values we persist — otherwise verification could pass on trimmed
      // keys while untrimmed ones get stored and fail every later auth.
      const accessToken = input.accessToken.trim();
      const username = input.username?.trim() || null;
      let accountId = input.accountId?.trim() || null;

      // Verify the keys against Alpaca BEFORE saving anything. Bad keys used
      // to be stored silently and only blow up later as confusing errors on
      // quotes/orders; now the save fails fast with an actionable message
      // (typo vs Paper/Live mismatch vs Alpaca unreachable).
      if (input.provider === "alpaca") {
        const verdict = await checkAlpacaCredentials({
          keyId: username ?? "",
          secretKey: accessToken,
          accountType: input.accountType,
        });
        if (!verdict.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: verdict.message });
        }
        if (accountId && accountId !== verdict.accountNumber) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The submitted account identity does not match the verified Alpaca account. Nothing was saved." });
        }
        accountId = verdict.accountNumber;
      }

      // Encrypt sensitive tokens
      const encryptedAccessToken = encrypt(accessToken);

      const save = async (db: any) => {
        // Check if credentials already exist for this provider/account. Alpaca
        // ships Paper and Live as two distinct accounts with distinct API keys
        // and the schema intentionally allows both per user. This read and the
        // replacement write stay under the same user-first lock, so a worker
        // cannot validate one credential row and submit with material another
        // request replaced concurrently.
        await lockUserPolicyRow(db, ctx.userId);
        const matchingCredentials = await db.query.userApiCredentials.findMany({
          where: (creds: any, { eq: queryEq, and, or, isNull }: any) =>
            and(
              queryEq(creds.userId, ctx.userId),
              queryEq(creds.provider, input.provider),
              accountId
                ? and(
                    queryEq(creds.accountId, accountId),
                    accountType === "PAPER"
                      ? or(queryEq(creds.accountType, "PAPER"), queryEq(creds.accountType, "SIM"))
                      : queryEq(creds.accountType, accountType),
                  )
                : and(isNull(creds.accountId), queryEq(creds.accountType, accountType)),
            ),
        });

        if (input.provider === "alpaca" && matchingCredentials.length > 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Multiple saved Alpaca credential rows match this verified account. No credentials were changed.",
          });
        }

        const existing = matchingCredentials[0];
        if (existing) {
          await db
            .update(schema.userApiCredentials)
            .set({
              encryptedAccessToken,
              encryptedRefreshToken: null,
              accountId,
              accountType,
              username,
              baseUrl: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.userApiCredentials.id, existing.id));
          return { success: true, message: "Credentials updated" };
        }

        await db.insert(schema.userApiCredentials).values({
          userId: ctx.userId,
          provider: input.provider,
          encryptedAccessToken,
          encryptedRefreshToken: null,
          accountId,
          accountType,
          username,
          baseUrl: null,
        });
        return { success: true, message: "Credentials saved" };
      };
      const transaction = (ctx.db as any).transaction;
      return transaction
        ? transaction.call(ctx.db, (tx: any) => save(tx))
        : save(ctx.db);
    }),

  /**
   * Check if user has API credentials configured
   */
  hasApiCredentials: protectedProcedure
    .input(
      z.object({
        provider: z.enum(["alpaca", "hyperliquid"]).optional(),
        cursor: z.string().max(512).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const checkAlpacaRecovery = input.provider !== "hyperliquid";
      const cursorScope = credentialsCursorScope(ctx.userId, input.provider);
      const cursor = input.cursor !== undefined
        ? decodeApiCredentialsCursor(input.cursor, cursorScope)
        : null;
      if (input.cursor !== undefined && !cursor) {
        throw new TRPCError({ code: "BAD_REQUEST", message: INVALID_CREDENTIALS_CURSOR_MESSAGE });
      }

      const credentials = await ctx.db.query.userApiCredentials.findMany({
        where: (creds, { eq, and, gt: queryGt, or }) => {
          const conditions = [eq(creds.userId, ctx.userId)];
          if (input.provider) {
            conditions.push(eq(creds.provider, input.provider));
          }
          if (cursor) {
            const createdAtKey = millisecondTimestamp(creds.createdAt);
            conditions.push(
              or(
                queryGt(createdAtKey, cursor.createdAt),
                and(
                  eq(createdAtKey, cursor.createdAt),
                  queryGt(creds.id, cursor.id),
                ),
              )!,
            );
          }
          return and(...conditions);
        },
        orderBy: (creds, { asc }) => [
          asc(millisecondTimestamp(creds.createdAt)),
          asc(creds.id),
        ],
        limit: API_CREDENTIAL_STATUS_PAGE_SIZE + 1,
        columns: {
          id: true,
          provider: true,
          accountId: true,
          accountType: true,
          username: true,
          baseUrl: true,
          createdAt: true,
          updatedAt: true,
          ...(checkAlpacaRecovery
            ? { encryptedAccessToken: true, encryptedRefreshToken: true }
            : {}),
        },
      });

      const pageCredentials = credentials.slice(0, API_CREDENTIAL_STATUS_PAGE_SIZE);
      const isComplete = credentials.length <= API_CREDENTIAL_STATUS_PAGE_SIZE;
      const needsReentryIds = new Set<string>();
      if (checkAlpacaRecovery) {
        const credentialsForRecovery = pageCredentials as Array<(typeof credentials)[number] & {
          encryptedAccessToken: string;
          encryptedRefreshToken: string | null;
        }>;
        for (const credential of credentialsForRecovery) {
          if (credential.provider !== "alpaca") continue;

          try {
            decrypt(credential.encryptedAccessToken);
            if (credential.encryptedRefreshToken) {
              decrypt(credential.encryptedRefreshToken);
            }
          } catch (error) {
            if (error instanceof DecryptionAuthenticationError) {
              needsReentryIds.add(credential.id);
              continue;
            }
            if (error instanceof Error && error.message.startsWith("ENCRYPTION_KEY")) {
              throw error;
            }
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: ALPACA_CREDENTIAL_STATUS_ERROR_MESSAGE,
            });
          }
        }
      }

      const lastPageCredential = pageCredentials.at(-1);
      return {
        hasCredentials: credentials.length > 0,
        isComplete,
        nextCursor: isComplete || !lastPageCredential
          ? null
          : encodeApiCredentialsCursor({
              createdAt: millisecondTimestampValue(lastPageCredential.createdAt)!,
              id: lastPageCredential.id,
              scope: cursorScope,
            }),
        accounts: pageCredentials.map((c) => ({
          id: c.id,
          provider: c.provider,
          accountId: c.accountId,
          accountType: c.accountType,
          credentialAccountLabel: c.provider === "hyperliquid"
            ? `Hyperliquid ${networkFromEnv()} perps`
            : null,
          username: c.username,
          baseUrl: c.baseUrl,
          ...(c.provider === "alpaca"
            ? { needsReentry: needsReentryIds.has(c.id) }
            : {}),
          // Surfaced so the client can hide the "reimport your credentials"
          // notice once a key has been re-saved after the notice went live.
          updatedAt: c.updatedAt,
        })),
      };
    }),

  /**
   * Delete broker credentials
   */
  deleteApiCredentials: protectedProcedure
    .input(
      z.object({
        credentialId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const credential = await ctx.db.query.userApiCredentials.findFirst({
        where: (creds, { eq, and }) =>
          and(
            eq(creds.id, input.credentialId),
            eq(creds.userId, ctx.userId)
          ),
      });

      if (!credential) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Credentials not found. Please add your API keys in the Settings page.",
        });
      }

      // The credential_id FK on copy_trade_follows is onDelete: set null, so a
      // follow armed against this credential survives the delete rather than
      // being removed. autoMirror is an independent boolean nothing else
      // clears, so without this the row is left autoMirror=true with
      // credentialId=null: armed, with no destination. Disarm every follow
      // pointing at this credential in the SAME transaction as the delete so
      // the two writes can never diverge (a crash between two top-level
      // statements would otherwise recreate the exact bug). The disarm must
      // run BEFORE the delete: once the delete lands, the FK has already
      // nulled credential_id, so an update keyed on the old id would match
      // nothing. The authenticated user's row is locked FIRST, matching the
      // worker's policy lock and preventing an unfollow/credential replacement
      // from committing between policy validation and venue placement.
      await ctx.db.transaction(async (tx) => {
        await lockUserPolicyRow(tx, ctx.userId);

        // Re-read ownership under the user lock. The initial read above is a
        // friendly fast-path error; this is the authoritative check used by
        // the atomic disarm/delete operation.
        const owned = await tx
          .select({ id: schema.userApiCredentials.id })
          .from(schema.userApiCredentials)
          .where(and(
            eq(schema.userApiCredentials.id, input.credentialId),
            eq(schema.userApiCredentials.userId, ctx.userId),
          ));
        if (owned.length !== 1) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Credentials not found. Please add your API keys in the Settings page.",
          });
        }

        // Recompute the legacy compatibility projection from the surviving
        // typed destination in the same row update. PostgreSQL evaluates all
        // SET expressions against the old row, so both venue policies are
        // preserved even when the deleted credential was selected twice.
        const stockSurvives = sql`(
          ${schema.copyTradeFollows.stockAutoMirror} = true and
          ${schema.copyTradeFollows.stockCredentialId} is not null and
          ${schema.copyTradeFollows.stockCredentialId} <> ${input.credentialId}
        )`;
        const perpSurvives = sql`(
          ${schema.copyTradeFollows.perpAutoMirror} = true and
          ${schema.copyTradeFollows.perpCredentialId} is not null and
          ${schema.copyTradeFollows.perpCredentialId} <> ${input.credentialId}
        )`;
        const exactlyOneSurvives = sql`(
          (${stockSurvives} and not ${perpSurvives}) or
          (${perpSurvives} and not ${stockSurvives})
        )`;

        await tx
          .update(schema.copyTradeFollows)
          .set({
            stockCredentialId: sql`case when ${schema.copyTradeFollows.stockCredentialId} = ${input.credentialId} then null else ${schema.copyTradeFollows.stockCredentialId} end`,
            stockAutoMirror: sql`case when ${schema.copyTradeFollows.stockCredentialId} = ${input.credentialId} then false else ${schema.copyTradeFollows.stockAutoMirror} end`,
            perpCredentialId: sql`case when ${schema.copyTradeFollows.perpCredentialId} = ${input.credentialId} then null else ${schema.copyTradeFollows.perpCredentialId} end`,
            perpAutoMirror: sql`case when ${schema.copyTradeFollows.perpCredentialId} = ${input.credentialId} then false else ${schema.copyTradeFollows.perpAutoMirror} end`,
            autoMirror: sql`case when ${exactlyOneSurvives} then true else false end`,
            credentialId: sql`case when ${stockSurvives} then ${schema.copyTradeFollows.stockCredentialId} when ${perpSurvives} then ${schema.copyTradeFollows.perpCredentialId} else null end`,
            sizingMode: sql`case when ${stockSurvives} then ${schema.copyTradeFollows.stockSizingMode} when ${perpSurvives} then ${schema.copyTradeFollows.perpSizingMode} else ${schema.copyTradeFollows.sizingMode} end`,
            sizingValue: sql`case when ${stockSurvives} then ${schema.copyTradeFollows.stockSizingValue} when ${perpSurvives} then ${schema.copyTradeFollows.perpSizingValue} else ${schema.copyTradeFollows.sizingValue} end`,
            destinationPolicyInitialized: true,
          })
          .where(and(
            eq(schema.copyTradeFollows.followerUserId, ctx.userId),
            or(
              eq(schema.copyTradeFollows.credentialId, input.credentialId),
              eq(schema.copyTradeFollows.stockCredentialId, input.credentialId),
              eq(schema.copyTradeFollows.perpCredentialId, input.credentialId),
            ),
          ));

        await tx
          .delete(schema.userApiCredentials)
          .where(and(
            eq(schema.userApiCredentials.id, input.credentialId),
            eq(schema.userApiCredentials.userId, ctx.userId),
          ));
      });

      return { success: true };
    }),

  /** Read the authenticated user's global automatic-perp leverage ceiling. */
  getCopyPerpLeverageSettings: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, ctx.userId),
      columns: { copyPerpMaxLeverage: true },
    });
    if (!user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User account is unavailable.",
      });
    }
    return { globalPerpMaxLeverage: user.copyPerpMaxLeverage };
  }),

  /**
   * Set the global automatic-perp leverage ceiling and clamp every higher
   * per-follow override atomically with the user-row lock.
   */
  setCopyPerpMaxLeverage: protectedProcedure
    .input(z.object({ globalPerpMaxLeverage: copyPerpMaxLeverageSchema }))
    .mutation(async ({ ctx, input }) => {
      // This mutation updates the user policy and dependent follow policies as
      // one unit.  Keep the fail-closed behavior explicit for lightweight DB
      // adapters and tests that do not expose transactions.
      if (typeof ctx.db.transaction !== "function") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "A transactional database is required to update copy-trade policy.",
        });
      }

      return ctx.db.transaction(async (tx) => {
        const lockedUsers = await tx
          .select({
            id: schema.users.id,
            copyPerpMaxLeverage: schema.users.copyPerpMaxLeverage,
          })
          .from(schema.users)
          .where(eq(schema.users.id, ctx.userId))
          .for("update");
        if (!lockedUsers[0]) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User account is unavailable.",
          });
        }

        await tx
          .update(schema.users)
          .set({ copyPerpMaxLeverage: input.globalPerpMaxLeverage })
          .where(eq(schema.users.id, ctx.userId));

        const clampedFollows = await tx
          .update(schema.copyTradeFollows)
          .set({ perpMaxLeverage: input.globalPerpMaxLeverage })
          .where(
            and(
              eq(schema.copyTradeFollows.followerUserId, ctx.userId),
              isNotNull(schema.copyTradeFollows.perpMaxLeverage),
              gt(schema.copyTradeFollows.perpMaxLeverage, input.globalPerpMaxLeverage),
            ),
          )
          .returning({ id: schema.copyTradeFollows.id });

        return {
          globalPerpMaxLeverage: input.globalPerpMaxLeverage,
          clampedFollowCount: clampedFollows.length,
        };
      });
    }),

  /**
   * The user's saved terminal layout, or null when they have never saved one
   * (or the stored blob is unreadable, e.g. written by a newer client). Null is
   * a normal result, not an error: the client falls back to its local copy and
   * then to the default layout.
   */
  getTerminalLayout: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, ctx.userId),
      columns: { terminalLayout: true },
    });
    const read = readStoredTerminalLayout(user?.terminalLayout);
    return {
      layout: read.layout,
      // Surfaced so the client can fall back for DISPLAY without concluding the
      // account has no layout and saving over one it simply could not parse.
      unsupported: read.status === "unsupported",
    };
  }),

  /**
   * Persist the terminal layout for this user, so the workspace is restored on
   * any browser or device. The payload is validated (bounded pane counts, known
   * tab names, sane drawer widths) rather than stored as an opaque blob, since
   * it is read back into every later session.
   */
  saveTerminalLayout: protectedProcedure
    .input(z.object({ layout: terminalLayoutSettingSchema }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.users)
        .set({ terminalLayout: input.layout })
        .where(eq(schema.users.id, ctx.userId));
      return { success: true };
    }),

  /** Clear the saved layout so the next load falls back to the default. */
  resetTerminalLayout: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(schema.users)
      .set({ terminalLayout: null })
      .where(eq(schema.users.id, ctx.userId));
    return { success: true };
  }),
});
