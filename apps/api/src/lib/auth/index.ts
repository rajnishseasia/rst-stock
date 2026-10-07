/**
 * Authentication Utilities
 *
 * Request adapter for Better Auth session retrieval.
 */

import type { Context } from "hono";
import type { createProductionLogger } from "@trade-bot/logger";

export interface RequestAdapter {
  getHeader(name: string): string | undefined;
  logger?: ReturnType<typeof createProductionLogger>;
}

/**
 * Create a request adapter from Hono context
 * Used to pass request headers to Better Auth for session verification
 */
export function createRequestContext(c: Context): RequestAdapter {
  return {
    getHeader: (name: string) => c.req.header(name),
  };
}
