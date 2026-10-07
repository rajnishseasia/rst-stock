/**
 * Friendly Error Mapping for Order Operations
 *
 * Alpaca/axios surface low-level errors (raw axios strings like
 * "Request failed with status code 422", or socket errors like "ECONNRESET")
 * that are confusing for end users. This helper maps those into friendly,
 * actionable TRPCError messages while still logging the raw error server-side
 * for debugging.
 */

import { TRPCError } from "@trpc/server";
import { createProductionLogger } from "@trade-bot/logger";

const logger = createProductionLogger();

/**
 * Node/axios socket + connection error codes that mean "we couldn't reach the
 * broker" rather than "the broker rejected the request".
 */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
]);

const CONNECTION_MESSAGE_RE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|connection closed|network/i;

const UNPROCESSABLE_RE = /422|unprocessable/i;

interface ExtractedError {
  message: string;
  status?: number;
  code?: string;
}

/**
 * Pull a raw message, HTTP status, and node error code out of an unknown error.
 * Handles axios-shaped errors (error.response?.status, error.response?.data),
 * plain Error instances, and socket errors carrying error.code.
 */
function extractError(error: unknown): ExtractedError {
  const err = error as
    | {
        message?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        response?: {
          status?: unknown;
          data?: { message?: unknown } | string | unknown;
        };
      }
    | null
    | undefined;

  // Prefer the Alpaca/axios response body message when present.
  const responseData = err?.response?.data;
  let message: string;
  if (responseData && typeof responseData === "object" && "message" in responseData && typeof responseData.message === "string") {
    message = responseData.message;
  } else if (typeof responseData === "string" && responseData.length > 0) {
    message = responseData;
  } else if (typeof err?.message === "string") {
    message = err.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = "Unknown error";
  }

  const status =
    typeof err?.response?.status === "number"
      ? err.response.status
      : typeof err?.status === "number"
      ? err.status
      : typeof err?.statusCode === "number"
      ? err.statusCode
      : undefined;

  const code = typeof err?.code === "string" ? err.code : undefined;

  return { message, status, code };
}

/**
 * True for socket/connection-level failures (broker unreachable).
 *
 * Explicit socket codes always count. The message regex is only consulted when
 * there is NO HTTP status — a real HTTP response means the broker WAS reached,
 * so a 4xx whose body merely mentions "network" must not be treated as a
 * connection failure.
 */
export function isConnectionError(error: unknown): boolean {
  const { message, status, code } = extractError(error);
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
  if (status !== undefined) return false;
  return CONNECTION_MESSAGE_RE.test(message);
}

/**
 * Map an unknown error from an Alpaca order operation into a friendly
 * TRPCError. Always logs the raw error first so debugging info isn't lost.
 *
 * @param error  The raw error thrown by the Alpaca client / axios.
 * @param action A short phrase describing what failed, e.g. "modifying the order".
 */
export function friendlyOrderError(error: unknown, action: string): TRPCError {
  // Preserve intentional TRPCErrors that were already thrown upstream.
  if (error instanceof TRPCError) {
    return error;
  }

  const { message, status, code } = extractError(error);

  // Always keep the real error server-side for debugging.
  logger.error("api", `[Orders] Failed while ${action}`, {
    action,
    rawMessage: message,
    status,
    code,
  });

  const connectionFriendly = new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "We couldn't reach the broker just now. Please check your connection and try again in a moment - if it keeps happening, contact the team.",
  });
  const modifyFriendly = new TRPCError({
    code: "BAD_REQUEST",
    message:
      "This order can't be modified right now - it may have already filled, been canceled, or moved to a state that can't be changed. Refresh your orders and try again.",
  });

  // Explicit socket/connection error codes -> broker unreachable (no HTTP status).
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) {
    return connectionFriendly;
  }

  // A real HTTP status means the broker WAS reached: classify by status, NOT by
  // message keywords (so a 4xx whose body mentions "network" isn't mislabeled
  // as a connection failure).
  if (status !== undefined) {
    if (status === 422) return modifyFriendly;
    if (status >= 400 && status < 500) {
      return new TRPCError({
        code: "BAD_REQUEST",
        message: `The broker rejected this request: ${shortReason(message)}`,
      });
    }
    // 5xx / other -> generic friendly fallback below.
  } else {
    // No HTTP status: fall back to message heuristics.
    if (CONNECTION_MESSAGE_RE.test(message)) return connectionFriendly;
    if (UNPROCESSABLE_RE.test(message)) return modifyFriendly;
  }

  // Anything else -> generic friendly fallback.
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Something went wrong while ${action}. Please try again, or contact the team if it persists.`,
  });
}

/**
 * Trim a raw error message down to a short, user-presentable reason
 * (single line, no stack noise, capped length).
 */
function shortReason(message: string): string {
  const firstLine = message.split("\n")[0]?.trim() ?? message;
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}
