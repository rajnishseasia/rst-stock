export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

function getHttpStatus(error: unknown): number | undefined {
  const value = error as
    | {
        message?: unknown;
        status?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown; statusCode?: unknown };
      }
    | null
    | undefined;

  if (typeof value?.response?.status === "number") return value.response.status;
  if (typeof value?.response?.statusCode === "number") return value.response.statusCode;
  if (typeof value?.status === "number") return value.status;
  if (typeof value?.statusCode === "number") return value.statusCode;

  if (typeof value?.message === "string") {
    const match = value.message.match(/\b([45]\d{2})\b/);
    if (match?.[1]) return Number(match[1]);
  }

  return undefined;
}

export function isTransientHttpError(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status === undefined) return true;

  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function retryAsync<T>(
  operation: () => Promise<T>,
  {
    attempts = 3,
    baseDelayMs = 200,
    shouldRetry = () => true,
  }: RetryOptions = {},
): Promise<T> {
  const totalAttempts = Math.max(1, attempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === totalAttempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
