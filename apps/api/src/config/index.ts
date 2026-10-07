/**
 * API Configuration
 *
 * Environment variables and app configuration.
 */

import { z } from "zod";

const envSchema = z.object({
  // Database (optional in development, required in production)
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_POOLED: z.string().optional(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Encryption
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),

  // Better Auth
  API_PUBLIC_URL: z.string().optional(), // Public-facing URL of the API server (for OAuth callbacks)
  BETTER_AUTH_URL: z.string().optional(), // Legacy: same as API_PUBLIC_URL, kept for backwards compatibility
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  TWITTER_CLIENT_ID: z.string().optional(),
  TWITTER_CLIENT_SECRET: z.string().optional(),

  // Public research APIs.
  // SEC EDGAR rejects (HTTP 403) any request whose User-Agent lacks a
  // contact email. SEC_USER_AGENT is strongly recommended for the chat
  // research feature; SEC_CONTACT_EMAIL supplies the email token when only
  // a bare app string is configured (or when nothing is configured).
  SEC_USER_AGENT: z.string().optional(),
  SEC_CONTACT_EMAIL: z.string().optional(),

  // Signa external signal/analysis provider. Optional — when unset, the
  // Signa Signals dashboard tab reports the feature as unconfigured.
  SIGNA_API_KEY: z.string().optional(),

  // URLs
  WEB_URL: z.string().optional(),
  TRUSTED_ORIGINS: z.string().optional(),

  // Standard OpenAI API key used for the AI Chat feature.
  // Users do not supply their own keys (BYOK disabled). Set this in your
  // environment to power AI Chat for all users. Model is hardcoded to
  // gpt-4o-mini.
  OPENAI_API_KEY: z.string().optional(),

  // Worker HTTP service (PNL image generation). Optional — the pnlImage
  // router reports the feature as unavailable when unconfigured.
  WORKER_HTTP_URL: z.string().optional(),
  WORKER_API_SECRET: z.string().optional(),

  // Server
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.parse(process.env);

// WEB_URL falls back to the local dev web app outside production only.
// A defaulted localhost value in production would make CORS/CSRF and
// Better Auth trust credentialed requests from the victim's own localhost.
export const env = {
  ...parsed,
  WEB_URL:
    parsed.WEB_URL ??
    (parsed.NODE_ENV === "production" ? undefined : "http://localhost:5100"),
};
