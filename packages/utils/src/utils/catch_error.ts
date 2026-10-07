/**
 * Success tuple: [undefined, data]
 */
type Success<T> = [undefined, T];

/**
 * Failure tuple: [error]
 */
type Failure = [Error];

/**
 * Result type: either Success or Failure tuple
 */
type Result<T> = Success<T> | Failure;

/**
 * Checks if a value is a Promise-like object (thenable).
 * Supports non-native promises like Prisma/Drizzle queries.
 *
 * @param value - The value to check
 * @returns True if the value is a thenable, false otherwise
 */
function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as any).then === "function"
  );
}

/**
 * Error-first wrapper for both sync and async operations.
 *
 * Converts promise rejections and thrown errors to tuple format for cleaner error handling.
 *
 * @example
 * ```ts
 * // Async usage with Promise
 * const [error, data] = await catchError(fetchUser());
 * if (error) {
 *   console.error('Failed:', error);
 *   return;
 * }
 * console.log('Success:', data);
 *
 * // Async usage with function
 * const [error2, user] = await catchError(async () => {
 *   const response = await fetch('/api/user');
 *   return response.json();
 * });
 *
 * // Sync usage with function
 * const [error3, result] = catchError(() => JSON.parse(jsonString));
 * if (error3) {
 *   console.error('Parse failed:', error3);
 *   return;
 * }
 * console.log('Parsed:', result);
 * ```
 */

/**
 * Overload: Handle Promise<T> directly
 */
export function catchError<T>(promise: Promise<T>): Promise<Result<T>>;

/**
 * Overload: Handle async function that returns Promise<T>
 */
export function catchError<T>(fn: () => Promise<T>): Promise<Result<T>>;

/**
 * Overload: Handle sync function that returns T
 */
export function catchError<T>(fn: () => T): Result<T>;

/**
 * Implementation
 */
export function catchError<T>(
  operation: Promise<T> | (() => T) | (() => Promise<T>),
): Promise<Result<T>> | Result<T> {
  // Handle promise or thenable
  if (isPromise(operation)) {
    return operation
      .then((data) => [undefined, data] as Success<T>)
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        return [err] as Failure;
      });
  }

  // Handle function (could be sync or async)
  try {
    const result = operation();

    // If function returns a promise, handle it
    if (isPromise(result)) {
      return result
        .then((data) => [undefined, data] as Success<T>)
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          return [err] as Failure;
        });
    }

    // Synchronous result
    return [undefined, result] as Success<T>;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return [err] as Failure;
  }
}
