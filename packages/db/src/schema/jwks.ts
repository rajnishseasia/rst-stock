/**
 * JWKS Schema (Better Auth `jwt` plugin)
 *
 * Signing keys for the Better Auth JWT plugin, which powers Privy custom auth
 * for the perps wallet layer: the api signs short-lived JWTs for the logged-in
 * session (GET /api/auth/token) and serves the public keys at
 * GET /api/auth/jwks so Privy can verify them.
 *
 * The private key is encrypted at rest by better-auth (AES-GCM keyed off
 * BETTER_AUTH_SECRET) before it is stored here; the public key is a plain JWK.
 * Rows are created lazily by the plugin on first token request. Model name and
 * field set mirror better-auth's jwt plugin schema (publicKey, privateKey,
 * createdAt, expiresAt).
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(), // Better Auth provides its own ID format
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set when key rotation is enabled; null means the key does not expire.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type Jwks = typeof jwks.$inferSelect;
export type NewJwks = typeof jwks.$inferInsert;
