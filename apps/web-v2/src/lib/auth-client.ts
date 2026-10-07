/**
 * Better Auth Client
 *
 * Client-side authentication hooks and utilities.
 * Uses relative paths so Next.js rewrites can proxy to the API server.
 */

import { createAuthClient } from "better-auth/react";
import { clearBetterAuthJwtCache } from "@/lib/privy-custom-auth";

// Use relative path so Next.js rewrites can proxy /api/auth/* to API server
// This ensures OAuth callbacks go through the frontend domain
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? "" : process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001",
});

// Export individual hooks and methods
export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
} = authClient;

/**
 * Sign in with Google
 */
export async function signInWithGoogle() {
  // After sign-in land the user in the trading dashboard (now at /app, not the
  // public landing page at /).
  return signIn.social({
    provider: "google",
    callbackURL:
      typeof window !== "undefined" ? `${window.location.origin}/app` : "/app",
  });
}

/**
 * Sign out the current user
 */
export async function handleSignOut() {
  clearBetterAuthJwtCache();
  return signOut({
    fetchOptions: {
      onSuccess: () => {
        window.location.href = "/";
      },
    },
  });
}
