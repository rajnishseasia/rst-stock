/**
 * privy-custom-auth: flag gating + token plumbing for Privy CUSTOM AUTH.
 *
 * When custom auth is active, the Privy embedded wallet binds to the Better
 * Auth session (Google login) with NO second Privy login: `providers.tsx`
 * passes `customAuth.getCustomAccessToken` = `fetchBetterAuthJwt`, which
 * fetches a short-lived JWT for the current cookie session from the Better
 * Auth jwt plugin (GET /api/auth/token, proxied by Next rewrites to the api).
 * Privy verifies it against our JWKS (GET /api/auth/jwks, configured in the
 * Privy dashboard) and keys the wallet identity off the JWT `sub` = the
 * Better Auth userId.
 *
 * Production defaults to custom auth whenever the Privy app id is configured,
 * so the platform login is the only login a user sees. Set
 * `NEXT_PUBLIC_PRIVY_CUSTOM_AUTH=false` for an emergency rollback to the legacy
 * Privy login modal. Development stays opt-in because a local Better Auth JWT
 * may not be trusted by the production Privy app.
 *
 * The gating + parsing helpers are pure and unit-tested
 * (privy-custom-auth.test.ts).
 */

/**
 * Pure gate: custom auth requires a configured Privy app. Production defaults
 * on when the flag is omitted; non-production environments default off. Exact
 * "true"/"false" values override the environment default, while malformed
 * values fail closed.
 */
export function isPrivyCustomAuthEnabled(
  appId: string | undefined,
  flag: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (!appId) return false;
  if (flag === "true") return true;
  if (flag === "false") return false;
  if (flag !== undefined) return false;
  return nodeEnv === "production";
}

/**
 * Pure parser for the Better Auth `GET /token` response body. Returns the JWT
 * string, or undefined for any malformed/empty payload (Privy treats
 * undefined as "not authenticated"; getCustomAccessToken must not throw).
 */
export function parseBetterAuthTokenResponse(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const token = (json as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * Minimal structural view of a Privy linked account (react-auth
 * `User.linkedAccounts` entries). Only the fields the subject gate reads.
 */
export interface PrivyLinkedAccountLike {
  type: string;
  customUserId?: unknown;
}

/**
 * Extract the CUSTOM-AUTH SUBJECT from a Privy user: the `customUserId` of the
 * `custom_auth` linked account, which Privy sets to the `sub` claim of the JWT
 * we minted (= the Better Auth userId). Undefined when the user has no
 * custom-auth account (legacy login-modal session, or user not loaded yet).
 *
 * SAFETY (wrong-wallet binding): in custom-auth mode every automatic
 * onboarding action must verify this subject equals the CURRENT Better Auth
 * session user id. Privy's session lives in its own storage and can lag a
 * Better Auth logout/login on a shared browser; without this check, user B's
 * platform session could silently enable perps against user A's stale wallet.
 */
export function getPrivyCustomAuthSubject(
  user: { linkedAccounts?: PrivyLinkedAccountLike[] } | null | undefined,
): string | undefined {
  const account = user?.linkedAccounts?.find((a) => a.type === "custom_auth");
  const subject = account?.customUserId;
  return typeof subject === "string" && subject.length > 0 ? subject : undefined;
}

/**
 * Build-time constant (NEXT_PUBLIC_* vars are inlined by Next): true when this
 * deployment runs the zero-extra-login Privy custom-auth flow.
 */
export const PRIVY_CUSTOM_AUTH = isPrivyCustomAuthEnabled(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  process.env.NEXT_PUBLIC_PRIVY_CUSTOM_AUTH,
);

const BETTER_AUTH_TOKEN_PATH = "/api/auth/token";
const MAX_TOKEN_FETCH_ATTEMPTS = 3;
const TOKEN_RETRY_DELAY_MS = 100;

/**
 * How many seconds before the JWT expiry we treat the cached token as stale
 * and proactively fetch a fresh one. The server issues 15-minute tokens, so
 * a 2-minute early-refresh window leaves plenty of margin without hammering
 * the endpoint on every Privy hook invocation.
 */
const TOKEN_CACHE_EARLY_REFRESH_SECS = 120;

/**
 * Module-level in-memory cache for the Better Auth JWT. Privy's
 * useSubscribeToJwtAuthWithFlag can invoke getExternalJwt on every render
 * cycle; without caching that produces one /api/auth/token round-trip per
 * call. The cache returns the cached token until it is within
 * TOKEN_CACHE_EARLY_REFRESH_SECS of its exp claim, then fetches once and
 * updates. Cleared on sign-out or any 401/403 from the endpoint.
 */
interface TokenCache {
  token: string;
  /** Unix epoch seconds when this token expires (from the JWT exp claim). */
  expiresAt: number;
  /**
   * The JWT `sub` claim (= Better Auth user ID). Used to detect cross-tab
   * session switches: if the active session's user ID no longer matches this
   * value the cache is stale and must be cleared before Privy can bind to the
   * correct user.
   */
  sub: string | undefined;
}

let _tokenCache: TokenCache | null = null;
/** Monotonic invalidation counter for requests racing a logout/user switch. */
let _cacheEpoch = 0;

/**
 * The Better Auth user ID that the current browser session is bound to.
 * Set synchronously during render (before any effect fires) by
 * `bindBetterAuthUserId` so `fetchBetterAuthJwt` can evict a stale
 * cross-user cache entry in the same render cycle rather than waiting for
 * the next effect flush.
 */
let _boundUserId: string | undefined;

/**
 * Bind the token cache to a specific Better Auth user. Call this
 * synchronously during render (not inside a `useEffect`) whenever the active
 * session user ID changes. If the bound ID differs from the cached token's
 * `sub`, the cache is evicted immediately so the very next
 * `fetchBetterAuthJwt` call fetches a fresh token for the correct user
 * rather than returning the stale one from a previous session.
 */
export function bindBetterAuthUserId(userId: string | undefined): void {
  // A signed-out session is a meaningful state transition even when the
  // cache was already unbound. Always clear here so a still-fresh token from
  // the previous session cannot survive a logout before Privy resyncs.
  if (_boundUserId === userId && userId !== undefined) return;
  _boundUserId = userId;
  _cacheEpoch += 1;
  if (!userId || (_tokenCache?.sub && _tokenCache.sub !== userId)) {
    _tokenCache = null;
  }
}

/**
 * Parse claims from a JWT's payload (no signature verification; we only need
 * them for cache scheduling and session binding).
 */
function parseJwtClaims(token: string): { exp?: number; sub?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: unknown;
      sub?: unknown;
    };
    return {
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
    };
  } catch {
    return {};
  }
}

/** Clear the in-memory cache (e.g., after sign-out or an auth error). */
export function clearBetterAuthJwtCache(): void {
  _tokenCache = null;
  _cacheEpoch += 1;
}

/**
 * Return the Better Auth user ID (`sub`) embedded in the currently cached JWT,
 * or undefined when the cache is empty. Used by providers.tsx to detect a
 * cross-tab session switch (cached sub ≠ current session user id) and clear the
 * cache before Privy can bind to the wrong user.
 */
export function getCachedJwtSub(): string | undefined {
  return _tokenCache?.sub;
}

/**
 * Resolve the token endpoint against the application origin when one is
 * available. Privy invokes this callback from the browser, so making the
 * origin explicit avoids a relative URL being resolved against an embedded
 * Privy context instead of the Ready Set Trade deployment.
 */
export function getBetterAuthTokenUrl(origin?: string): string {
  if (!origin) return BETTER_AUTH_TOKEN_PATH;
  try {
    return new URL(BETTER_AUTH_TOKEN_PATH, origin).toString();
  } catch {
    return BETTER_AUTH_TOKEN_PATH;
  }
}

function shouldRetryTokenRequest(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function waitBeforeTokenRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TOKEN_RETRY_DELAY_MS));
}

/**
 * Fetch a short-lived Better Auth JWT for the current session, for Privy's
 * `customAuth.getCustomAccessToken`. Results are cached in memory until the
 * token is within TOKEN_CACHE_EARLY_REFRESH_SECS of its expiry, so repeated
 * Privy hook invocations do not produce a server round-trip on every render.
 *
 * The request is same-origin, includes the Better Auth cookie, bypasses
 * browser/proxy caches, and retries only transient failures. NEVER throws:
 * any failure (signed out, network, malformed body) resolves to undefined,
 * which Privy treats as "no custom session".
 */
export async function fetchBetterAuthJwt(): Promise<string | undefined> {
  // Return the cached token if it is still fresh enough AND belongs to the
  // currently bound user. The _boundUserId check is a last-resort guard: if
  // providers.tsx called bindBetterAuthUserId synchronously before this
  // function was invoked, the cache was already evicted there. But Privy can
  // also call getExternalJwt from its own effect queue before the React
  // effect that sets _boundUserId runs, so re-checking here is the safety net.
  if (_tokenCache) {
    if (!_boundUserId || !_tokenCache.sub || _tokenCache.sub !== _boundUserId) {
      // Cross-user stale entry. Evict and re-fetch for the correct user.
      _tokenCache = null;
    } else {
      const nowSecs = Math.floor(Date.now() / 1000);
      if (_tokenCache.expiresAt - nowSecs > TOKEN_CACHE_EARLY_REFRESH_SECS) {
        return _tokenCache.token;
      }
      // Token is stale or near expiry; clear and re-fetch below.
      _tokenCache = null;
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : undefined;
  const url = getBetterAuthTokenUrl(origin);
  const requestEpoch = _cacheEpoch;
  const requestUserId = _boundUserId;

  for (let attempt = 1; attempt <= MAX_TOKEN_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (res.ok) {
        const token = parseBetterAuthTokenResponse(await res.json());
        if (token) {
          const { exp, sub } = parseJwtClaims(token);
          // Only return a token while the caller is still bound to the same
          // authenticated subject. This prevents an in-flight request from
          // handing a stale token to Privy after logout or a user switch;
          // cache invalidation alone is not enough because Privy consumes the
          // promise result directly.
          if (
            requestEpoch !== _cacheEpoch ||
            !requestUserId ||
            !sub ||
            sub !== requestUserId ||
            _boundUserId !== requestUserId
          ) {
            return undefined;
          }
          if (exp !== undefined) {
            _tokenCache = { token, expiresAt: exp, sub };
          }
        }
        return token;
      }

      // Clear cache on hard auth failures so the next call re-fetches.
      if (res.status === 401 || res.status === 403) {
        _tokenCache = null;
        return undefined;
      }

      if (attempt === MAX_TOKEN_FETCH_ATTEMPTS || !shouldRetryTokenRequest(res.status)) {
        return undefined;
      }
    } catch {
      if (attempt === MAX_TOKEN_FETCH_ATTEMPTS) return undefined;
    }

    await waitBeforeTokenRetry();
  }

  return undefined;
}
