/**
 * JWT plugin options for Better Auth (Privy custom auth for perps).
 *
 * The `jwt` plugin exposes two additive endpoints on the existing Better Auth
 * handler (mounted at /api/auth/* in index.ts):
 *
 *   - GET /api/auth/token  -> { token } : a short-lived JWT for the CURRENT
 *     cookie session. The web client hands this to Privy as the custom-auth
 *     access token, so the Privy embedded wallet binds to the Better Auth user
 *     with no second login.
 *   - GET /api/auth/jwks   -> JSON Web Key Set serving the public signing keys.
 *     This URL is configured in the Privy dashboard so Privy can verify our
 *     tokens.
 *
 * Key material is generated lazily by the plugin and persisted in the `jwks`
 * table (private key encrypted with BETTER_AUTH_SECRET). No new env vars.
 *
 * This module is a PURE options builder so the wiring is unit-testable against
 * the real better-auth plugin (see __tests__/perps-jwt-options.test.ts).
 */

import type { JwtOptions } from "better-auth/plugins/jwt";

/** Token lifetime. Privy re-fetches via getCustomAccessToken, so keep it short. */
export const PERPS_JWT_EXPIRATION = "15m";

/**
 * Build the options for better-auth's `jwt()` plugin.
 *
 * @param baseURL the Better Auth baseURL (the frontend origin); used as the
 *                JWT issuer and audience, which must match what is configured
 *                in the Privy dashboard for custom auth.
 */
export function buildPerpsJwtOptions(baseURL: string): JwtOptions {
  // WEB_URL (the usual source of baseURL) may be a comma-separated list of
  // allowed origins; the JWT iss/aud must be ONE origin matching what the
  // Privy dashboard is configured with, so take the FIRST entry.
  const origin = baseURL.split(",")[0]!.trim();
  return {
    jwks: {
      // ES256 instead of better-auth's EdDSA default: Privy custom auth
      // verifies RS256 / ES256 JWKS; Ed25519 keys would be rejected.
      keyPairConfig: { alg: "ES256" },
    },
    jwt: {
      issuer: origin,
      audience: origin,
      expirationTime: PERPS_JWT_EXPIRATION,
      // The JWT subject IS the Better Auth userId (matches the plugin default,
      // pinned explicitly because Privy keys wallet identity off `sub`).
      getSubject: (session) => session.user.id,
      // EMPTY payload: better-auth's default payload is the whole session
      // user (email, name, image, and any custom fields), which would embed
      // PII in every token handed to Privy. Privy only needs `sub`, and the
      // plugin sets sub/iss/aud/exp outside definePayload, so returning {}
      // strips the PII without affecting verification.
      definePayload: () => ({}),
    },
    // Additive only: do NOT piggyback a signed JWT onto every session response
    // via the set-auth-jwt header. Existing session/cookie behavior stays
    // byte-identical; clients that want a JWT call GET /api/auth/token.
    disableSettingJwtHeader: true,
  };
}
