/**
 * Turning an arbitrary throw into something safe to put in a log line.
 *
 * Every poller in this worker eventually catches something it did not
 * construct: an axios rejection, a Postgres driver error, an aborted fetch.
 * Two rules apply to all of them, and they were being restated per service:
 *
 *  1. NEVER pass the raw error to a log sink. An axios rejection serializes its
 *     whole config, request and response, roughly 150 lines per failure. One
 *     unsyncable order buried an hour of production logs under about 17,000
 *     lines of it, which is how a real failure hides in plain sight.
 *  2. Mask credentials. Broker and driver errors routinely quote the URL they
 *     were calling, and the logger's redaction is key-based, so it cannot help
 *     with a secret embedded in a message STRING.
 *
 * Extracted after the second copy appeared (order-sync and paste-trade-poller
 * had the same regex and the same cap, defined independently). Callers that
 * need more, such as an HTTP status, add it around this rather than forking it.
 */

/** Cap on an error message copied into a log line. */
export const ERROR_MESSAGE_MAX_CHARS = 200;

/**
 * Mask credentials embedded in a URL, then bound the length.
 *
 * Deliberately targets the `scheme://user:pass@host` form specifically, rather
 * than trying to detect secrets generally: a broad heuristic would redact parts
 * of ordinary messages and make the diagnostic useless, which is the failure
 * mode this whole module exists to avoid.
 */
export function scrubErrorMessage(message: string): string {
  return message
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[REDACTED]@")
    .slice(0, ERROR_MESSAGE_MAX_CHARS);
}

/**
 * Describe an error for a log context.
 *
 * The NAME is the most useful single field (AbortError / PostgresError /
 * TypeError), and the message is scrubbed and truncated rather than dropped:
 * "it failed" is not an answer to "why did nothing come in?".
 *
 * Handles the non-Error throw too. Broker SDKs reject with plain objects
 * carrying a `message`, and losing that to `String(error)` yields the
 * uniquely unhelpful "[object Object]".
 */
export function describeError(error: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name || "Error",
      errorMessage: scrubErrorMessage(error.message),
    };
  }
  const message = (error as { message?: unknown } | undefined)?.message;
  return {
    errorName: typeof error,
    errorMessage: scrubErrorMessage(
      typeof message === "string" ? message : String(error),
    ),
  };
}
