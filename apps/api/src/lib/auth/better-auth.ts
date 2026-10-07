/**
 * Better Auth Configuration
 *
 * Server-side authentication with Google OAuth only.
 * Follows Better Auth best practices for clean, simple setup.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins/jwt";
import { getDb, schema } from "@trade-bot/db";
import { env } from "../../config/index.js";
import { buildPerpsJwtOptions } from "./jwt-options.js";
import { eq } from "drizzle-orm";
import { syncUserFromTwitterToken } from "../twitter-profile.js";
import { invalidateUserLeaderboardCache } from "../leaderboard-identity-cache.js";

// Get base URL - To properly support separated Vercel domains, this MUST be the Frontend App URL!
// OAuth callbacks redirect to the Frontend at ${baseURL}/api/auth/callback/google
// and Next.js rewrites proxy these requests seamlessly to this API server with cookies intact!
function getBaseURL(): string {
  // Always prefer the actual frontend URL so cookies are grouped to the frontend domain
  if (env.WEB_URL) {
    return env.WEB_URL;
  }

  if (env.API_PUBLIC_URL) return env.API_PUBLIC_URL;
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;

  return `http://localhost:5100`;
}

const baseURL = getBaseURL();

export const auth = betterAuth({
  baseURL,
  secret: env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(getDb(), {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      jwks: schema.jwks,
    },
  }),

  // JWT plugin (additive): GET /api/auth/token mints a short-lived JWT for the
  // current session (subject = Better Auth userId) and GET /api/auth/jwks
  // serves the public keys. Powers Privy custom auth for the perps wallet;
  // existing session/cookie behavior is untouched (see jwt-options.ts).
  plugins: [jwt(buildPerpsJwtOptions(baseURL))],

  // Google OAuth only in production. LOCAL-PREVIEW ONLY: email/password is
  // enabled in development so the app can be reached without a Google OAuth app.
  // DO NOT COMMIT this behavior change to production auth.
  emailAndPassword: {
    enabled: env.NODE_ENV === "development",
  },

  // Google OAuth configuration
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    ...(env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET
      ? {
          twitter: {
            clientId: env.TWITTER_CLIENT_ID,
            clientSecret: env.TWITTER_CLIENT_SECRET,
            // Better Auth 1.x requests "users.email" by default, which is not a
            // valid Twitter OAuth 2.0 scope. Requesting it causes the /users/me
            // call to fail and return null, producing "unable_to_get_user_info".
            // Use only the scopes that Twitter actually supports.
            disableDefaultScope: true,
            scope: ["users.read", "tweet.read", "offline.access"],
            // Custom getUserInfo so we can log the real Twitter API error instead
            // of silently returning null, and so we skip the broken email-field
            // call that the default implementation makes.
            getUserInfo: async (token: { accessToken?: string }) => {
              if (!token.accessToken) {
                console.error("[Twitter OAuth] getUserInfo called with no accessToken");
                return null;
              }
              const resp = await fetch(
                "https://api.x.com/2/users/me?user.fields=name,username,profile_image_url",
                { headers: { Authorization: `Bearer ${token.accessToken}` } },
              );
              if (!resp.ok) {
                const body = await resp.text().catch(() => "(unreadable)");
                console.error(
                  `[Twitter OAuth] GET /2/users/me returned ${resp.status}: ${body}`,
                );
                return null;
              }
              const json = (await resp.json()) as {
                data: {
                  id: string;
                  name: string;
                  username: string;
                  profile_image_url?: string;
                };
              };
              if (!json?.data?.id) {
                console.error(
                  "[Twitter OAuth] /users/me response missing data.id:",
                  JSON.stringify(json).slice(0, 200),
                );
                return null;
              }
              return {
                user: {
                  id: json.data.id,
                  name: json.data.name,
                  // Twitter does not expose email addresses. Use an immutable
                  // synthetic identifier keyed on the Twitter numeric user ID
                  // (which never changes even if the @handle is recycled) so
                  // Better Auth can uniquely identify the user. The @handle
                  // must NOT be used here: Twitter allows handle reuse after
                  // account deletion, which would collide a new owner of a
                  // recycled handle with the previous account row.
                  email: `${json.data.id}@twitter.oauth.local`,
                  image: json.data.profile_image_url ?? undefined,
                  emailVerified: false,
                  // additionalFields written directly to the users table
                  username: json.data.username,
                  twitterName: json.data.name,
                },
                data: json,
              };
            },
          },
        }
      : {}),
  },

  user: {
    additionalFields: {
      username: { type: "string", required: false, input: false },
      twitterName: { type: "string", required: false, input: false },
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      allowDifferentEmails: true,
      updateUserInfoOnLink: true,
      // Twitter does not return a verified email, so mark it as a trusted
      // provider to skip the emailVerified gating check in the linkSocial
      // callback. Without this, every Twitter link attempt returns
      // "unable_to_link_account" because emailVerified is always false.
      trustedProviders: ["twitter"],
    },
  },

  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },

  trustedOrigins: [
    ...(env.WEB_URL ? [env.WEB_URL] : []),
    ...(env.TRUSTED_ORIGINS ? env.TRUSTED_ORIGINS.split(",").map(s => s.trim()) : [])
  ],

  // Sync Twitter @handle and display name to the users table right after the
  // accounts row is created. The linkSocial callback path only writes the
  // accounts row, so without this hook the users table would never receive
  // username/twitterName when an existing user links their Twitter account.
  //
  // The update.after hook provides a self-healing path: if the initial
  // create.after sync failed transiently (network blip, brief DB error),
  // the next Twitter sign-in writes fresh tokens, fires update.after, and
  // retries the sync — but only when username/twitterName are still missing
  // so re-logins by fully-synced users are not taxed with an extra API call.
  databaseHooks: {
    account: {
      create: {
        after: async (account) => {
          if (account.providerId !== "twitter") return;
          const accessToken = account.accessToken as string | null | undefined;
          if (!accessToken || !account.userId) return;
          await syncUserFromTwitterToken(String(account.userId), accessToken);
          // Bust the leaderboard cache so other users see the newly linked
          // Twitter identity (avatar + display name) without waiting up to
          // 2 hours for the Redis TTL to expire.
          await invalidateUserLeaderboardCache();
        },
      },
      update: {
        after: async (account) => {
          if (account.providerId !== "twitter") return;
          const accessToken = account.accessToken as string | null | undefined;
          if (!accessToken || !account.userId) return;
          // Skip if all three identity fields are already populated — the
          // initial create.after sync succeeded and there is nothing to do.
          // Only retry if a field is still missing (create.after failed
          // transiently, or image was added after username/twitterName were set).
          const user = await getDb().query.users.findFirst({
            where: eq(schema.users.id, String(account.userId)),
            columns: { username: true, twitterName: true, image: true },
          });
          if (user?.username && user?.twitterName && user?.image) return;
          const result = await syncUserFromTwitterToken(String(account.userId), accessToken);
          if (result.ok) {
            // Profile was updated; bust the cache so the change is visible
            // to other users on the leaderboard immediately.
            await invalidateUserLeaderboardCache();
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
