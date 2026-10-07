/**
 * Retry utility with exponential backoff and jitter.
 *
 * @module @trade-bot/utils/with-retry
 */

/**
 * Configuration options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in ms (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay between retries in ms (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Optional predicate to filter which errors should be retried */
  retryOn?: (error: Error) => boolean;
  /** Optional callback for retry attempts */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "retryOn" | "onRetry">> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

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
 * Wraps a promise-returning function with retry logic.
 *
 * Features:
 * - Exponential backoff with jitter
 * - Configurable max attempts
 * - Optional error filter (only retry specific errors)
 * - Composable with withTimeout
 *
 * @param fn - Function that returns a promise to retry
 * @param options - Retry configuration options
 * @returns Promise that resolves on success or rejects after all retries exhausted
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await withRetry(() => fetchData());
 *
 * // With options
 * const result = await withRetry(
 *   () => fetchData(),
 *   {
 *     maxAttempts: 3,
 *     initialDelayMs: 2000,
 *     onRetry: (error, attempt) => console.log(`Retry ${attempt}`)
 *   }
 * );
 *
 * // Composable with withTimeout
 * const result = await withRetry(
 *   () => withTimeout(fetchData(), 30000, "Timeout"),
 *   { maxAttempts: 3 }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const { retryOn, onRetry } = options ?? {};

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this error should be retried
      if (retryOn && !retryOn(lastError)) {
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
