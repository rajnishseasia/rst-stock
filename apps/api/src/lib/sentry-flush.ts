/**
 * Making sure a captured error actually leaves the process.
 *
 * The API deploys as Vercel serverless functions (see `apps/api/vercel.json`).
 * `@sentry/node` sends events on a background queue, and Vercel freezes the
 * instance the moment the response is returned, so anything still queued is
 * dropped and resumes only if that instance happens to be reused. Nothing in
 * this app flushed, which means even the two capture points that existed were
 * losing events, most reliably on a cold instance handling a single failing
 * request: exactly the case someone is looking for in Sentry.
 *
 * Flushing on every request would put the wait on the 99% of requests that
 * captured nothing, so the flush is conditional: something has to have been
 * captured first.
 *
 * The flag is process-wide rather than per-request. Concurrent requests share
 * an instance, so one request's error can trigger another's flush. That is the
 * intended trade: `flush` is idempotent and returns immediately with an empty
 * queue, and an occasional extra flush is much cheaper than the plumbing to
 * track this per request, and than a dropped event.
 */

import * as Sentry from "@sentry/node";

/** Bound on the wait, so a slow Sentry cannot hold a response open. */
export const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

let captured = false;

/** Record that something was handed to Sentry and still needs to be sent. */
export function markSentryCapture(): void {
  captured = true;
}

export function hasPendingSentryCapture(): boolean {
  return captured;
}

/**
 * Flush if anything was captured since the last flush, otherwise do nothing.
 *
 * NEVER throws: this runs on the way out of a request that has already
 * produced its response, and a failure to report must not become a failure to
 * respond.
 */
export async function flushSentryIfCaptured(
  timeoutMs: number = SENTRY_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!captured) return;
  // Cleared before the await, not after: a capture that lands while this flush
  // is in flight must not be erased by it, or that event waits for an
  // unrelated future error to carry it out.
  captured = false;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Nothing useful to do here, and the caller is mid-response.
  }
}

/** Reset for tests. */
export function resetSentryFlushState(): void {
  captured = false;
}
