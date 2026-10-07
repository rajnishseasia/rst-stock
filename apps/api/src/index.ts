/**
 * API Server Entry Point
 *
 * Hono + tRPC API server with authentication.
 */

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "production",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
});

import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { handle } from "hono/vercel";
import { trpcServer } from "@hono/trpc-server";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { appRouter } from "./routers/index.js";
import { createContext } from "./context.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createProductionLogger, SKIP_ERROR_REPORT, setErrorReporter } from "@trade-bot/logger";
import { getDb } from "@trade-bot/db";
import { createRequestContext } from "./lib/auth/index.js";
import { env } from "./config/index.js";
import { auth } from "./lib/auth/better-auth.js";
import { createStockChatStream, streamChatInputSchema } from "./lib/chat/stream.js";
import { buildCorsOrigins } from "./lib/cors-origins.js";
import { flushSentryIfCaptured, markSentryCapture } from "./lib/sentry-flush.js";
import { checkChatRateLimit } from "./lib/chat/rate-limit.js";

type Variables = {
  logger: ReturnType<typeof createProductionLogger>;
};

const app = new Hono<{ Variables: Variables }>();

// Production logger instance
const logger = createProductionLogger();

/**
 * Send every `logger.error` in this process to Sentry.
 *
 * The two explicit `captureException` calls in this file and in the error
 * handler only fire for errors that were THROWN. The order and Hyperliquid
 * routers deliberately catch, log and continue on their reconciliation paths,
 * because a broker call that already succeeded must never be marked failed
 * locally. Those are the highest-value errors the API produces ("Broker
 * accepted order but local persistence failed", "Accepted Hyperliquid TP/SL
 * needs reconciliation") and none of them reached Sentry: they logged one line
 * to stdout and the request returned 200.
 *
 * Installing the reporter here covers all of them, and any added later,
 * without touching the call sites.
 */
setErrorReporter(({ error, service, message, context }) => {
  Sentry.captureException(error, {
    tags: { service },
    extra: { logMessage: message, ...context },
  });
  markSentryCapture();
});

// Store logger in Hono context for error handler
app.use("*", async (c, next) => {
  c.set("logger", logger);
  await next();
});

/**
 * Outermost middleware, so its work runs after every handler and after the
 * error handler. Sends anything Sentry has queued before Vercel can freeze the
 * instance; a no-op on requests that captured nothing.
 */
app.use("*", async (_c, next) => {
  await next();
  await flushSentryIfCaptured();
});

/**
 * Trusted origins for CORS + CSRF. localhost is included in development only;
 * production trusts exactly the WEB_URL list (see buildCorsOrigins).
 */
function getCorsOrigins(): string[] {
  return buildCorsOrigins({ webUrl: env.WEB_URL, nodeEnv: env.NODE_ENV });
}

// CORS configuration
app.use(
  "/*",
  cors({
    origin: getCorsOrigins(),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Set-Cookie"],
  }),
);

// Request logging
app.use("*", honoLogger());

// Body Size Limit to prevent memory exhaustion (maximum 5MB)
app.use(
  "*",
  bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) => {
      return c.json({ error: "Payload Too Large" }, 413);
    },
  })
);

// Global CSRF Protection (Allow exact origins)
app.use(
  "*",
  csrf({
    origin: getCorsOrigins(),
  })
);

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});
// Better Auth handler for authentication routes
// Let Better Auth handle all cookie management - it knows how to do this correctly
// CORS is handled by the global middleware configured above
app.on(["POST", "GET", "OPTIONS"], "/api/auth/*", async (c) => {
  const response = await auth.handler(c.req.raw);

  const pathname = new URL(c.req.url).pathname;

  // The short-lived token is scoped to the caller's Better Auth cookie. Make
  // that explicit for Vercel/proxies so one user's token can never be reused
  // from a shared cache.
  if (pathname.endsWith("/api/auth/token")) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    const vary = headers.get("Vary");
    headers.set("Vary", vary ? `${vary}, Cookie` : "Cookie");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // JWKS is a stable public key set that changes only on key rotation (rare).
  // A 1-hour max-age would let caches serve a pre-rotation key set for up to
  // an hour after /api/auth/token starts issuing JWTs signed by the new key,
  // breaking Privy verification for that whole window. Keep the freshness
  // window short (5 minutes) so a rotation is visible quickly, with a brief
  // stale-while-revalidate to still avoid a thundering herd on every check.
  if (pathname.endsWith("/api/auth/jwks") && response.status === 200) {
    const headers = new Headers(response.headers);
    headers.set(
      "Cache-Control",
      "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
});

app.post("/api/chat/stream", async (c) => {
  const cookieHeader = c.req.header("Cookie");
  const headers: Record<string, string> = {};
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const session = await auth.api.getSession({ headers });
  if (!session?.user?.id) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const rateLimit = await checkChatRateLimit(session.user.id, logger);
  if (rateLimit.status === "limited") {
    return c.json({ error: "Too many chat requests. Please wait a moment." }, 429);
  }
  if (rateLimit.status === "unavailable") {
    return c.json(
      { error: "Chat is temporarily unavailable. Please try again shortly." },
      503,
    );
  }

  let parsedInput: unknown;
  try {
    parsedInput = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const input = streamChatInputSchema.safeParse(parsedInput);
  if (!input.success) {
    logger.warn("api", "[Chat] Invalid chat request", {
      userId: session.user.id,
      issues: input.error.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message: i.message,
      })),
    });
    return c.json(
      {
        error: "Invalid chat request",
        issues: input.error.issues,
      },
      400
    );
  }

  const stream = createStockChatStream({
    db: getDb(),
    userId: session.user.id,
    input: input.data,
    signal: c.req.raw.signal,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// tRPC server endpoint
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: async (_opts, c) => {
      const adapter = createRequestContext(c);
      adapter.logger = c.get("logger");
      return await createContext(adapter);
    },
    onError: ({ error, path }) => {
      // Skips the logger's reporter: the raw error is captured below with its
      // real stack, and one failure should not file two Sentry issues.
      logger.error("api", `tRPC error on ${path}: ${error.message}`, {
        path,
        code: error.code,
        cause: String(error.cause),
        [SKIP_ERROR_REPORT]: true,
      });
      Sentry.captureException(error.cause ?? error);
      markSentryCapture();
    },
  }),
);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: `Route ${c.req.path} not found`,
    },
    404,
  );
});

// Global error handler
app.onError(errorHandler);

// Server configuration
const port = env.PORT;

if (!process.env.VERCEL) {
  console.log(`Server running on http://localhost:${port}`);
}

// Bun.serve configuration
export default {
  port,
  fetch: app.fetch,
  idleTimeout: 0, // Disable timeout for SSE connections
};

// Vercel serverless function handlers
export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
