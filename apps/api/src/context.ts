/**
 * tRPC Context...
 *
 * Create context for each tRPC request with authenticated user.
 */

import type { PoolDb } from "@trade-bot/db";
import { getDb } from "@trade-bot/db";
import { auth } from "./lib/auth/better-auth.js";
import type { RequestAdapter } from "./lib/auth/index.js";

/**
 * Session type for authenticated users
 */
export interface Session {
  userId: string;
  email?: string;
}

/**
 * Create tRPC context with authenticated session
 *
 * Uses Better Auth to verify session from cookies.
 */
export async function createContext(opts: RequestAdapter) {
  // Initialize with no session
  let session: Session | null = null;
  let userId: string | null = null;

  // Try to get session from Better Auth
  try {
    // Build headers object from request adapter
    const cookieHeader = opts.getHeader("Cookie");
    const headers: Record<string, string> = {};
    
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    // Get session from Better Auth
    const authSession = await auth.api.getSession({
      headers,
    });

    if (authSession?.user) {
      session = {
        userId: authSession.user.id,
        email: authSession.user.email,
      };
      userId = authSession.user.id;
    }

  } catch (error) {
    // Session verification failed, fallback to no session
    if (opts.logger) {
      opts.logger.warn("api", "Session verification error during createContext", {
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      console.warn("Session verification error during createContext:", error);
    }
    session = null;
    userId = null;
  }

  return {
    db: getDb(),
    session,
    userId,
    logger: opts.logger, // Passed down from hono index
  };
}

/**
 * tRPC context type
 */
export type Context = {
  db: PoolDb;
  session: Session | null;
  userId: string | null;
  logger?: ReturnType<typeof import("@trade-bot/logger").createProductionLogger>;
};
