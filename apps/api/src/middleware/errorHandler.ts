/**
 * Global Error Handler
 *
 * Catches all unhandled errors in the Hono app.
 */

import * as Sentry from "@sentry/node";
import type { Context, ErrorHandler as HonoErrorHandler } from "hono";
import { SKIP_ERROR_REPORT, type createProductionLogger } from "@trade-bot/logger";
import { flushSentryIfCaptured, markSentryCapture } from "../lib/sentry-flush.js";

type Variables = {
  logger: ReturnType<typeof createProductionLogger>;
};

export const errorHandler: HonoErrorHandler<{ Variables: Variables }> = async (
  err,
  c: Context<{ Variables: Variables }>,
) => {
  const logger = c.get("logger");

  // Skips the logger's Sentry reporter: the raw error is captured below with
  // its real stack, and one failure should not file two Sentry issues.
  logger.error("api", "Unhandled error", {
    message: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    [SKIP_ERROR_REPORT]: true,
  });

  Sentry.captureException(err);
  markSentryCapture();

  // Flush here as well as in the outer middleware. Hono can invoke onError
  // from inside the router, and on a 500 the event is the whole point of the
  // request; flush is idempotent, so the second call costs nothing.
  await flushSentryIfCaptured();

  // Return generic error response
  return c.json(
    {
      error: "Internal Server Error",
      message:
        process.env.NODE_ENV === "development" ? err.message : "An unexpected error occurred",
    },
    500,
  );
};
