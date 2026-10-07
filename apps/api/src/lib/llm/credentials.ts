import type { PoolDb } from "@trade-bot/db";
import { decrypt } from "@trade-bot/utils";
import { TRPCError } from "@trpc/server";
import { isLlmProvider, type LlmProvider } from "./providers.js";

export type DecryptedLlmCredential = {
  id: string;
  provider: LlmProvider;
  label: string | null;
  apiKey: string;
  apiKeyLast4: string;
  baseUrl: string;
  defaultModel: string;
};

export async function getDecryptedLlmCredential(
  db: PoolDb,
  userId: string,
  credentialId: string
): Promise<DecryptedLlmCredential> {
  const credential = await db.query.userLlmApiCredentials.findFirst({
    where: (creds, { eq, and }) =>
      and(eq(creds.id, credentialId), eq(creds.userId, userId)),
  });

  if (!credential) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "LLM credentials not found. Add an API key in Settings first.",
    });
  }

  if (!isLlmProvider(credential.provider)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Unsupported LLM provider saved on this account.",
    });
  }

  return {
    id: credential.id,
    provider: credential.provider,
    label: credential.label,
    apiKey: decrypt(credential.encryptedApiKey),
    apiKeyLast4: credential.apiKeyLast4,
    baseUrl: credential.baseUrl,
    defaultModel: credential.defaultModel,
  };
}
