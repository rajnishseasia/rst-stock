/**
 * Retry utility with per-attempt timeout using AbortController.
 *
 * Unlike combining withRetry + withTimeout (which uses Promise.race),
 * this utility properly cancels HTTP connections when timeout occurs.
 *
 * @module @trade-bot/utils/with-retry-and-timeout
 */

/**
 * Configuration options for retry with timeout behavior.
 */
export interface RetryWithTimeoutOptions {
  /** Timeout per attempt in ms (required) */
  timeoutMs: number;
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in ms (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay between retries in ms (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Optional callback for retry attempts */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
  /** Optional callback when timeout occurs (before potential retry) */
  onTimeout?: (attempt: number) => void;
}

const DEFAULT_OPTIONS = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
} as const;

/**
 * Adds jitter to delay to prevent thundering herd.
 * Returns a value between 0.5 * delay and 1.5 * delay.
 */
function addJitter(delay: number): number {
  const jitter = 0.5 + Math.random();
  return Math.floor(delay * jitter);
}

/**
 * Calculates delay for a given attempt with exponential backoff.
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
): number {
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  return addJitter(cappedDelay);
}

/**
 * Delays execution for specified milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if an error is an abort error (timeout).
 */
function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.name === "CanceledError";
}

/**
 * Wraps a promise-returning function with retry logic and per-attempt timeout.
 *
 * Key behaviors:
 * - Creates fresh AbortController for each attempt
 * - Timeout aborts the request (actually cancels HTTP connection)
 * - Does NOT retry on timeout (it means the operation is taking too long)
 * - Retries on other errors with exponential backoff + jitter
 *
 * Why this exists:
 * - Promise.race with setTimeout does NOT cancel HTTP requests
 * - AbortController + signal is the only way to properly cancel fetch/axios
 * - Each retry needs a fresh AbortController (aborted ones can't be reused)
 *
 * @param fn - Function that accepts AbortSignal and returns a Promise
 * @param options - Retry and timeout configuration options
 * @returns Promise that resolves on success or rejects after all retries exhausted
 *
 * @example
 * ```typescript
 * // Basic usage with API call
 * const result = await withRetryAndTimeout(
 *   (signal) => fetchData({ signal }),
 *   { timeoutMs: 30_000, maxAttempts: 3 }
 * );
 *
 * // With logging
 * const result = await withRetryAndTimeout(
 *   (signal) => getGammaMarket(conditionId, { signal }),
 *   {
 *     timeoutMs: 30_000,
 *     maxAttempts: 3,
 *     onRetry: (err, attempt, delayMs) => {
 *       logger.warn("Retrying", { attempt, delayMs, error: err.message });
 *     },
 *     onTimeout: (attempt) => {
 *       logger.warn("Request timed out", { attempt });
 *     },
 *   }
 * );
 * ```
 */
export async function withRetryAndTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryWithTimeoutOptions,
): Promise<T> {
  const { timeoutMs, onTimeout } = options;
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const { onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Create fresh AbortController for each attempt
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on timeout - it means operation is taking too long
      if (isAbortError(lastError)) {
        onTimeout?.(attempt);
        throw lastError;
      }

      // If this was the last attempt, throw
      if (attempt === maxAttempts) {
        throw lastError;
      }

      // Calculate delay and wait
      const delayMs = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);

      // Notify about retry
      onRetry?.(lastError, attempt, delayMs);

      await delay(delayMs);
    }
  }

  // Should never reach here, but TypeScript requires it
  throw lastError ?? new Error("Retry failed");
}
