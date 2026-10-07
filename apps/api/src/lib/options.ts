/**
 * Shared Options Utilities
 *
 * Helpers for building Alpaca-compatible OCC/OSI option symbols and for
 * normalizing expiration dates between the compact (YYMMDD) and ISO
 * (YYYY-MM-DD) representations that the various Alpaca endpoints expect.
 *
 * Both orders.ts and quotes.ts import buildOptionsSymbol from here so there is
 * a single source of truth (previously each file kept its own copy).
 */

import { parseStrictFiniteNumber } from "./strict-number.js";

/**
 * Build the COMPACT OCC/OSI symbol Alpaca accepts.
 *
 * Format: Root + YYMMDD + Type(1) + Strike(8, *1000, zero-padded)
 *
 * Alpaca does NOT use the standard OCC 6-char space padding for the root
 * symbol. Example: AAPL240621C00255000 (compact) instead of
 * "AAPL  240621C00255000" (space-padded). The compact form is what Alpaca
 * accepts and is CORRECT.
 *
 * @param symbol     Underlying ticker (e.g. "AAPL").
 * @param expiration Expiration in compact YYMMDD form (e.g. "240621").
 * @param strike     Strike price as a number (e.g. 255 or 150.5).
 * @param optionType "CALL" or "PUT".
 */
export function buildOptionsSymbol(
  symbol: string,
  expiration: string,
  strike: number,
  optionType: "CALL" | "PUT"
): string {
  const root = symbol.toUpperCase().trim();
  const type = optionType === "CALL" ? "C" : "P";

  // Strike: multiplied by 1000, padded to 8 digits
  // e.g. 150.00 -> 150000 -> 00150000
  const strikeVal = Math.round(strike * 1000);
  const strikeStr = strikeVal.toString().padStart(8, "0");

  return `${root}${expiration}${type}${strikeStr}`;
}

export interface ParsedAlpacaOptionSymbol {
  /** The underlying ticker, suitable for the orders.symbol column. */
  symbol: string;
  /** Compact YYMMDD expiration used by the order and mirror paths. */
  optionExpiration: string;
  optionStrike: number;
  optionType: "CALL" | "PUT";
}

export function isValidOptionContractIdentity(input: {
  optionExpiration: string | null | undefined;
  optionStrike: string | number | null | undefined;
  optionType: string | null | undefined;
}): boolean {
  const expiration = input.optionExpiration;
  if (typeof expiration !== "string" || !/^[0-9]{6}$/.test(expiration)) return false;
  const year = 2000 + Number(expiration.slice(0, 2));
  const month = Number(expiration.slice(2, 4));
  const day = Number(expiration.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return false;

  const strike = parseStrictFiniteNumber(input.optionStrike);
  return strike !== null && strike > 0 &&
    (input.optionType?.toUpperCase() === "CALL" || input.optionType?.toUpperCase() === "PUT");
}

/**
 * Parse Alpaca's canonical compact OSI symbol without guessing contract data.
 * Only the strict compact form is accepted; malformed symbols stay opaque.
 */
export function parseAlpacaOptionSymbol(
  raw: string | null | undefined,
): ParsedAlpacaOptionSymbol | null {
  const value = raw?.trim().toUpperCase() ?? "";
  const match = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(value);
  if (!match) return null;

  const expiration = match[2]!;
  const year = 2000 + Number(expiration.slice(0, 2));
  const month = Number(expiration.slice(2, 4));
  const day = Number(expiration.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const optionStrike = Number(match[4]) / 1000;
  if (!Number.isFinite(optionStrike) || optionStrike <= 0) return null;

  return {
    symbol: match[1]!,
    optionExpiration: expiration,
    optionStrike,
    optionType: match[3] === "C" ? "CALL" : "PUT",
  };
}

/**
 * Normalize an expiration string to compact YYMMDD (6 chars).
 *
 * Accepts either:
 *  - YYYY-MM-DD (ISO)  -> e.g. "2025-01-30" -> "250130"
 *  - YYYYMMDD          -> e.g. "20250130"   -> "250130"
 *  - YYMMDD            -> e.g. "250130"      -> "250130" (passthrough)
 */
export function normalizeExpirationToYYMMDD(expiration: string): string {
  const cleaned = expiration.trim();
  // Strip any dashes/slashes: 2025-01-30 -> 20250130
  const digits = cleaned.replace(/[^0-9]/g, "");

  if (digits.length === 8) {
    // YYYYMMDD -> YYMMDD
    return digits.substring(2);
  }
  if (digits.length === 6) {
    // Already YYMMDD
    return digits;
  }
  // Fallback: return cleaned digits as-is (caller passed something unexpected)
  return digits;
}

/**
 * Normalize an expiration string to ISO YYYY-MM-DD.
 *
 * Accepts either:
 *  - YYYY-MM-DD (ISO)  -> passthrough
 *  - YYYYMMDD          -> e.g. "20250130" -> "2025-01-30"
 *  - YYMMDD            -> e.g. "250130"    -> "2025-01-30" (assumes 20xx)
 */
export function normalizeExpirationToYYYYMMDD(expiration: string): string {
  const cleaned = expiration.trim();

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  const digits = cleaned.replace(/[^0-9]/g, "");

  if (digits.length === 8) {
    // YYYYMMDD -> YYYY-MM-DD
    return `${digits.substring(0, 4)}-${digits.substring(4, 6)}-${digits.substring(6, 8)}`;
  }
  if (digits.length === 6) {
    // YYMMDD -> assume 20YY century
    const yy = digits.substring(0, 2);
    const mm = digits.substring(2, 4);
    const dd = digits.substring(4, 6);
    return `20${yy}-${mm}-${dd}`;
  }

  // Fallback: return the original cleaned string
  return cleaned;
}
