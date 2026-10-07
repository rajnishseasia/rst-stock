/**
 * LLM Credentials Router
 *
 * Stores direct-provider LLM API keys encrypted per user.
 */

import { TRPCError } from "@trpc/server";
import { schema } from "@trade-bot/db";
import { encrypt } from "@trade-bot/utils";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { validateLlmApiKey } from "../lib/llm/client.js";
import {
  getLlmProviderPreset,
  LLM_PROVIDER_PRESETS,
  LLM_PROVIDERS,
  type LlmProvider,
} from "../lib/llm/providers.js";
import { getDecryptedLlmCredential } from "../lib/llm/credentials.js";
import { env } from "../config/index.js";

const llmProviderSchema = z.enum(LLM_PROVIDERS as [LlmProvider, ...LlmProvider[]]);

const providerMetadata = Object.values(LLM_PROVIDER_PRESETS).map((preset) => ({
  provider: preset.provider,
  label: preset.label,
  defaultModel: preset.defaultModel,
  baseUrl: preset.baseUrl,
}));

function last4(value: string) {
  return value.slice(-4);
}

export const llmCredentialsRouter = router({
  /** Whether the platform OPENAI_API_KEY is configured server-side. */
  platformStatus: protectedProcedure.query(() => {
    return { configured: Boolean(env.OPENAI_API_KEY) };
  }),

  providers: protectedProcedure.query(async () => {
    return providerMetadata;
  }),

  // list/delete remain active so users with pre-rollout BYOK rows can still
  // remove them from the Settings page.
  list: protectedProcedure.query(async ({ ctx }) => {
    const credentials = await ctx.db.query.userLlmApiCredentials.findMany({
      where: (creds, { eq }) => eq(creds.userId, ctx.userId),
      columns: {
        id: true,
        provider: true,
        label: true,
        apiKeyLast4: true,
        baseUrl: true,
        defaultModel: true,
        lastUsedAt: true,
        lastValidatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: (creds, { asc }) => [asc(creds.provider)],
    });

    return credentials.map((credential) => ({
      id: credential.id,
      provider: credential.provider,
      label:
        credential.label ||
        (credential.provider in LLM_PROVIDER_PRESETS
          ? LLM_PROVIDER_PRESETS[credential.provider as LlmProvider].label
          : credential.provider),
      apiKeyLast4: credential.apiKeyLast4,
      baseUrl: credential.baseUrl,
      defaultModel: credential.defaultModel,
      lastUsedAt: credential.lastUsedAt,
      lastValidatedAt: credential.lastValidatedAt,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    }));
  }),

  upsert: protectedProcedure
    .input(
      z.object({
        provider: llmProviderSchema,
        apiKey: z.string().trim().min(12, "API key looks too short").max(4096),
        validate: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const preset = getLlmProviderPreset(input.provider);

      if (input.validate) {
        try {
          await validateLlmApiKey(input.apiKey, preset);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              error instanceof Error
                ? error.message
                : "The provider rejected this API key.",
          });
        }
      }

      const encryptedApiKey = encrypt(input.apiKey);
      const now = new Date();

      const existing = await ctx.db.query.userLlmApiCredentials.findFirst({
        where: (creds, { eq, and }) =>
          and(eq(creds.userId, ctx.userId), eq(creds.provider, input.provider)),
      });

      if (existing) {
        await ctx.db
          .update(schema.userLlmApiCredentials)
          .set({
            label: preset.label,
            encryptedApiKey,
            apiKeyLast4: last4(input.apiKey),
            baseUrl: preset.baseUrl,
            defaultModel: preset.defaultModel,
            lastValidatedAt: input.validate ? now : existing.lastValidatedAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.userLlmApiCredentials.id, existing.id),
              eq(schema.userLlmApiCredentials.userId, ctx.userId)
            )
          );

        return { success: true, message: `${preset.label} key updated` };
      }

      await ctx.db.insert(schema.userLlmApiCredentials).values({
        userId: ctx.userId,
        provider: input.provider,
        label: preset.label,
        encryptedApiKey,
        apiKeyLast4: last4(input.apiKey),
        baseUrl: preset.baseUrl,
        defaultModel: preset.defaultModel,
        lastValidatedAt: input.validate ? now : null,
      });

      return { success: true, message: `${preset.label} key saved` };
    }),

  test: protectedProcedure
    .input(
      z.object({
        credentialId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const credential = await getDecryptedLlmCredential(
        ctx.db,
        ctx.userId,
        input.credentialId
      );
      const preset = getLlmProviderPreset(credential.provider);

      try {
        await validateLlmApiKey(credential.apiKey, {
          ...preset,
          baseUrl: credential.baseUrl,
          defaultModel: credential.defaultModel,
        });
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error
              ? error.message
              : "The provider rejected this API key.",
        });
      }

      await ctx.db
        .update(schema.userLlmApiCredentials)
        .set({ lastValidatedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.userLlmApiCredentials.id, input.credentialId),
            eq(schema.userLlmApiCredentials.userId, ctx.userId)
          )
        );

      return { success: true, message: `${preset.label} key validated` };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        credentialId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(schema.userLlmApiCredentials)
        .where(
          and(
            eq(schema.userLlmApiCredentials.id, input.credentialId),
            eq(schema.userLlmApiCredentials.userId, ctx.userId)
          )
        );

      return { success: true };
    }),
});
