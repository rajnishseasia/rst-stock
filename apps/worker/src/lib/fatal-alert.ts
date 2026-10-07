/**
 * One awaited webhook post for a worker that is about to die on startup.
 *
 * Why this exists separately from the error-burst alerter in
 * `@trade-bot/logger`: that alerter fires when a LIVE process accumulates more
 * than 20 errors in a rolling hour, and it holds that count in process memory.
 * A worker that fails its schema gate logs exactly one error and exits, so the
 * counter resets to 1 on every restart and can never reach the threshold. It
 * also posts without awaiting, which `process.exit(1)` cancels.
 *
 * A crash loop is therefore the one failure the existing alerting is
 * structurally incapable of reporting, and it is the failure that went
 * unnoticed for 20 hours in production on 2026-08-25. This module covers
 * exactly that gap: it is awaited, it has no threshold, and it is bounded by a
 * timeout so a hanging webhook cannot keep a doomed process alive.
 *
 * Railway's own "Deployment Crashed" webhook covers the same incident from
 * outside. Keep both: this one carries the error text that says WHY, which the
 * platform event cannot know.
 */

import { ALERT_PREFIX, ALERT_USERNAME } from "@trade-bot/logger";

import { describeError } from "./log-safe-error";

/** Bound on the delivery attempt, so a hung webhook cannot delay the exit. */
export const FATAL_ALERT_TIMEOUT_MS = 3_000;

export interface FatalAlertOptions {
  /** Injected for tests. Defaults to the ambient global. */
  fetch?: typeof fetch;
  /** Injected for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Post a single fatal-startup notification and resolve once it is delivered.
 *
 * Returns whether an alert was actually sent, so the caller can log the
 * difference between "nobody was told" and "the webhook is not configured".
 * NEVER throws: the caller is already on its way to exit(1), and an alerting
 * failure must not replace the real diagnostic in the logs.
 */
export async function sendFatalStartupAlert(
  error: unknown,
  options: FatalAlertOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const webhookUrl = env.WORKER_ERROR_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return false;

  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? FATAL_ALERT_TIMEOUT_MS;

  // `describeError` scrubs `user:pass@host` credentials out of the message and
  // caps its length. The startup failure most likely to land here is a database
  // connection error, which routinely quotes the connection URL.
  const { errorName, errorMessage } = describeError(error);
  // `?? "unknown"` alone is not enough: an unset Railway variable arrives as an
  // empty string, not undefined, and "".slice() is falsy-but-not-nullish, so the
  // alert would read "commit ." at exactly the moment someone needs to know
  // which build is crash-looping.
  const commit = env.RAILWAY_GIT_COMMIT_SHA?.trim().slice(0, 7) || "unknown";
  const service = env.RAILWAY_SERVICE_NAME?.trim() || "worker";
  const environment = env.NODE_ENV?.trim() || "unknown";

  const content = [
    `${ALERT_PREFIX} 🔴 Worker failed to start and is exiting (${service}, ${environment}, commit ${commit}).`,
    `${errorName}: ${errorMessage}`,
    "The process will restart and most likely fail the same way. Check Railway deploy logs.",
  ].join("\n");

  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALERT_USERNAME, content }),
      signal: timeout,
    });
    return response.ok;
  } catch {
    return false;
  }
}
