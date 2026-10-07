/**
 * Alpaca credential verification - used by userSettings.saveApiCredentials to
 * reject bad keys BEFORE they are encrypted and stored.
 *
 * Historically the router saved whatever the user typed; a typo'd key or a
 * Paper/Live mismatch only surfaced later as opaque downstream errors on
 * quotes/orders. This module makes one authenticated GET /v2/account call
 * with the submitted keys and turns the result into a clear verdict.
 *
 * Pure-ish by design: the fetch implementation is injectable so tests can
 * exercise every branch without touching the network (see the repo test
 * conventions in CLAUDE.md).
 */

import { catchError } from "@trade-bot/utils";
import { z } from "zod";

const accountResponseSchema = z.object({
  account_number: z.string().trim().min(1),
  status: z.string().nullish(),
});

export const ALPACA_PAPER_HOST = "https://paper-api.alpaca.markets";
export const ALPACA_LIVE_HOST = "https://api.alpaca.markets";

export interface AlpacaCredentialCheckInput {
  /** Alpaca API Key ID (stored in the credential row's `username` column). */
  keyId: string;
  /** Alpaca Secret Key (stored encrypted as `accessToken`). */
  secretKey: string;
  /** PAPER/SIM validate against the paper host; LIVE against the live host. */
  accountType: "LIVE" | "PAPER" | "SIM";
}

export type AlpacaCredentialCheckResult =
  | {
      ok: true;
      /** Verified broker identity used to distinguish saved accounts. */
      accountNumber: string;
      /** Account status reported by Alpaca, e.g. ACTIVE. */
      status: string | null;
    }
  | {
      ok: false;
      /** Human-readable reason, safe to show in the settings UI. */
      message: string;
    };

/**
 * Resolve which Alpaca host to validate against. Only the two known Alpaca
 * hosts are ever contacted: this check authenticates with user-supplied
 * secrets and echoes HTTP statuses back to the caller, so accepting an
 * arbitrary base URL here would be a server-side request primitive.
 */
export function resolveAlpacaHost(input: {
  accountType: "LIVE" | "PAPER" | "SIM";
}): string {
  return input.accountType === "LIVE" ? ALPACA_LIVE_HOST : ALPACA_PAPER_HOST;
}

/**
 * Verify a key pair against Alpaca's GET /v2/account.
 *
 * - 200 with an account number: keys identify an account on the chosen host.
 * - 401/403: keys rejected. The most common cause besides a typo is a
 *   Paper/Live mismatch, so the message calls that out explicitly.
 * - Anything else (including network failure): verification could not be
 *   completed; the caller decides whether to fail open or closed. We report
 *   it distinctly so the user is not told their keys are wrong when Alpaca
 *   was simply unreachable.
 */
export async function checkAlpacaCredentials(
  input: AlpacaCredentialCheckInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AlpacaCredentialCheckResult> {
  const keyId = input.keyId?.trim();
  const secretKey = input.secretKey?.trim();

  if (!keyId) {
    return {
      ok: false,
      message: "API Key ID is required. Paste the Key ID from your Alpaca dashboard (starts with PK for paper keys or AK for live keys).",
    };
  }
  if (!secretKey) {
    return { ok: false, message: "Secret Key is required." };
  }

  const host = resolveAlpacaHost(input);
  const label = input.accountType === "LIVE" ? "Live" : "Paper";

  const [networkError, response] = await catchError((async () =>
    fetchImpl(`${host}/v2/account`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secretKey,
      },
    }))());
  if (networkError) {
    return {
      ok: false,
      message:
        "Could not reach Alpaca to verify these keys (network error). Please try again in a moment; nothing was saved.",
    };
  }

  if (response.ok) {
    const [parseError, body] = await catchError(response.json());
    const account = accountResponseSchema.safeParse(body);
    if (parseError || !account.success) {
      return {
        ok: false,
        message: "Alpaca did not return a valid account identity. Please try again; nothing was saved.",
      };
    }
    return { ok: true, accountNumber: account.data.account_number, status: account.data.status ?? null };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message:
        `Alpaca rejected these API keys for the ${label} environment (HTTP ${response.status}). ` +
        "Check the API Key ID and Secret Key for typos, and make sure the Account Type matches where the keys were generated: " +
        "Paper keys only work with a Paper account, Live keys only with a Live account. Nothing was saved.",
    };
  }

  return {
    ok: false,
    message: `Alpaca returned an unexpected response (HTTP ${response.status}) while verifying these keys. Please try again; nothing was saved.`,
  };
}
