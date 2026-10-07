/**
 * tRPC Configuration and Procedure Definitions
 *
 * Single source of truth for all tRPC initialization, middleware, and procedures.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";
import { getRedisClient } from "@trade-bot/redis";

/**
 * Initialize tRPC with context type and configuration.
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const isDev = process.env.NODE_ENV === "development";
    return {
      ...shape,
      message: isDev ? error.message : shape.message,
      data: {
        ...shape.data,
        stack: isDev ? error.stack : undefined,
      },
    };
  },
});

// ============================================
// Router & Procedure Base Exports
// ============================================

export const router = t.router;
export const publicProcedure = t.procedure;
export const mergeRouters = t.mergeRouters;

// ============================================
// Middleware Definitions
// ============================================

/**
 * Middleware: Requires authenticated session
 *
 * @throws UNAUTHORIZED - No valid session
 */
const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.session || !ctx.userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required. Please log in to access this resource.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      userId: ctx.userId,
    },
  });
});

// ============================================
// Procedure Exports (with middleware chains)
// ============================================

/** Requires authenticated user */
export const authenticatedProcedure = publicProcedure.use(isAuthenticated);

/**
 * Global API Rate Limiter
 *
 * Limits requests per user within a rolling 10s window. The limit is counted
 * per-procedure: a single trade-page load fans out ~10-15 procedures, and
 * 30s/60s polling refetches plus user actions stack on top. The web client
 * deliberately sends one operation per HTTP request so a slow venue call
 * cannot head-of-line block the other panels.
 * The limit must comfortably exceed that legitimate burst while still capping
 * runaway loops/abuse, so it sits well above a single page load's fan-out.
 */
const RATE_LIMIT_WINDOW_SECONDS = 10;
const RATE_LIMIT_MAX_REQUESTS = 60;

const rateLimiter = t.middleware(async ({ ctx, next }) => {
  if (ctx.userId) {
    const key = `ratelimit:trpc:${ctx.userId}`;
    const limit = RATE_LIMIT_MAX_REQUESTS;
    let count: number | null = null;

    try {
      const redis = await getRedisClient(ctx.logger);
      count = await redis.incrWithTtl(key, RATE_LIMIT_WINDOW_SECONDS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.logger) {
        ctx.logger.warn("api", "[RateLimit] Redis unavailable; allowing request", {
          error: message,
          userId: ctx.userId,
        });
      } else {
        console.warn(`[RateLimit] Redis unavailable for user ${ctx.userId}: ${message}`);
      }
    }

    if (count !== null) {
      if (ctx.logger) {
        ctx.logger.debug("api", `[RateLimit] user ${ctx.userId} count: ${count}/${limit}`);
      } else {
        console.log(`[RateLimit] user ${ctx.userId} count: ${count}/${limit}`);
      }

      if (count > limit) {
        if (ctx.logger) {
          ctx.logger.warn("api", `[RateLimit] user ${ctx.userId} exceeded limit`);
        }
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "You are doing that too much. Please wait 10 seconds before trying again.",
        });
      }
    }
  }
  return next();
});

/** Alias for authenticatedProcedure for consistency */
export const protectedProcedure = authenticatedProcedure.use(rateLimiter);
