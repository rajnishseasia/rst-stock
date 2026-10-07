"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

const DISMISSED_STORAGE_KEY = "ready-set-trade.alpaca-credential-reimport-dismissed";

export const ALPACA_CREDENTIAL_REIMPORT_NOTICE_EXPIRES_AT = new Date(
  "2026-08-13T23:59:59.999Z",
);

// The notice went live at the start of the reimport window. A credential that
// has been (re)saved at or after this instant no longer needs reimporting, so
// the notice must hide for it: the user already did exactly what it asks.
//
// Provenance: the notice shipped in commits 672c76e / 31830c0 on 2026-07-14 at
// roughly 08:21 UTC, so this instant is deliberately set AFTER that (later is
// the safe direction: a save before the change actually shipped must not count
// as a reimport). Move it later, never earlier, if the true deploy instant is
// confirmed to be later still.
export const ALPACA_CREDENTIAL_REIMPORT_NOTICE_GO_LIVE_AT = new Date(
  "2026-07-14T12:00:00.000Z",
);

export type AlpacaCredentialNoticeAccount = {
  id?: string;
  provider?: string | null;
  accountId?: string | null;
  accountType?: string | null;
  needsReentry?: boolean | null;
  /**
   * Last time the credential was saved. Accepts a Date or an ISO string because
   * tRPC may hand this back either way depending on the transformer. When
   * absent (unknown save time) the credential is treated as still needing a
   * reimport, preserving the original behavior.
   */
  updatedAt?: string | Date | null;
};

function normalizeAccountType(accountType: string | null | undefined) {
  return accountType?.trim().toUpperCase();
}

function isAlpacaPaperOrLiveAccount(account: AlpacaCredentialNoticeAccount) {
  const provider = account.provider?.trim().toLowerCase();
  const accountType = normalizeAccountType(account.accountType);

  return (
    provider === "alpaca" &&
    (accountType === "PAPER" || accountType === "SIM" || accountType === "LIVE")
  );
}

function isAlpacaAccountNeedingReentry(account: AlpacaCredentialNoticeAccount) {
  return account.provider?.trim().toLowerCase() === "alpaca" && account.needsReentry === true;
}

function toTimestamp(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function hasAlpacaPaperOrLiveCredential(
  accounts: readonly AlpacaCredentialNoticeAccount[] | null | undefined,
) {
  return (accounts ?? []).some(isAlpacaPaperOrLiveAccount);
}

export function findUsableAlpacaAccount<T extends AlpacaCredentialNoticeAccount>(
  accounts: readonly T[] | null | undefined,
  requestedAccountType: "PAPER" | "LIVE",
): T | undefined {
  return (accounts ?? []).find((account) => {
    const provider = account.provider?.trim().toLowerCase();
    if (
      (provider && provider !== "alpaca") ||
      account.needsReentry === true ||
      !account.accountId?.trim()
    ) {
      return false;
    }

    const type = normalizeAccountType(account.accountType);
    return requestedAccountType === "PAPER"
      ? type === "PAPER" || type === "SIM"
      : type === "LIVE";
  });
}

/**
 * True when an Alpaca Paper/Live credential still needs to be reimported: it is
 * a Paper/Live key that has NOT been re-saved since the notice went live. Once
 * the user saves the key again (updatedAt >= go-live), the notice no longer
 * applies to that credential.
 */
export function accountNeedsAlpacaCredentialReimport(
  account: AlpacaCredentialNoticeAccount,
  goLive: Date = ALPACA_CREDENTIAL_REIMPORT_NOTICE_GO_LIVE_AT,
) {
  if (!isAlpacaPaperOrLiveAccount(account)) return false;

  const updatedAt = toTimestamp(account.updatedAt);
  if (updatedAt == null) return true;

  return updatedAt < goLive.getTime();
}

/**
 * Which Alpaca account types (PAPER/SIM/LIVE) still need a reimport, judged by
 * the NEWEST credential row per account type.
 *
 * Per-row `.some()` was wrong: a re-save through the settings form writes a
 * single row (the one with a null `accountId`), so any older sibling row for the
 * same account type keeps its pre-go-live timestamp forever. That left the
 * notice up permanently for exactly the oldest credentials it targets, no matter
 * how many times the user re-imported. Judging by the freshest row per account
 * type means one successful save clears that account type.
 */
export function alpacaAccountTypesNeedingReimport(
  accounts: readonly AlpacaCredentialNoticeAccount[] | null | undefined,
  goLive: Date = ALPACA_CREDENTIAL_REIMPORT_NOTICE_GO_LIVE_AT,
): string[] {
  const newestByType = new Map<string, number | null>();
  for (const account of accounts ?? []) {
    if (!isAlpacaPaperOrLiveAccount(account)) continue;
    const type = normalizeAccountType(account.accountType) ?? "";
    const updatedAt = toTimestamp(account.updatedAt);
    if (!newestByType.has(type)) {
      newestByType.set(type, updatedAt);
      continue;
    }
    const current = newestByType.get(type) ?? null;
    // An unknown save time cannot make a group look fresher.
    if (current != null && updatedAt != null && updatedAt > current) {
      newestByType.set(type, updatedAt);
    } else if (current == null && updatedAt != null) {
      newestByType.set(type, updatedAt);
    }
  }

  const stale: string[] = [];
  for (const [type, updatedAt] of newestByType) {
    if (updatedAt == null || updatedAt < goLive.getTime()) stale.push(type);
  }
  return stale;
}

export function shouldShowAlpacaCredentialReimportNotice({
  accounts,
  dismissed = false,
  now = new Date(),
}: {
  accounts: readonly AlpacaCredentialNoticeAccount[] | null | undefined;
  dismissed?: boolean;
  now?: Date;
}) {
  return (
    (accounts ?? []).some(isAlpacaAccountNeedingReentry) ||
    (!dismissed &&
      now.getTime() <= ALPACA_CREDENTIAL_REIMPORT_NOTICE_EXPIRES_AT.getTime() &&
      alpacaAccountTypesNeedingReimport(accounts).length > 0)
  );
}

export function AlpacaCredentialReimportNotice({
  accounts,
  now,
  dismissed,
  className,
}: {
  accounts: readonly AlpacaCredentialNoticeAccount[] | null | undefined;
  now?: Date;
  dismissed?: boolean;
  className?: string;
}) {
  const [isDismissed, setIsDismissed] = useState(dismissed ?? false);
  const needsKeyReentry = (accounts ?? []).some(isAlpacaAccountNeedingReentry);

  useEffect(() => {
    if (dismissed != null) {
      setIsDismissed(dismissed);
      return;
    }

    setIsDismissed(window.localStorage.getItem(DISMISSED_STORAGE_KEY) === "1");
  }, [dismissed]);

  if (
    !shouldShowAlpacaCredentialReimportNotice({
      accounts,
      dismissed: isDismissed,
      now,
    })
  ) {
    return null;
  }

  const handleDismiss = () => {
    setIsDismissed(true);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, "1");
  };

  return (
    <div
      role="alert"
      className={cn(
        "border-y border-red-500/50 bg-red-950 px-3 py-2 text-sm text-red-50 shadow-lg shadow-red-950/20",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-400 items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-200" aria-hidden />
        <p className="min-w-0 flex-1 leading-5">
          {needsKeyReentry ? (
            <>
              <span className="font-semibold">Your saved Alpaca key pair needs to be entered again.</span>{" "}
              <a className="font-semibold underline underline-offset-2" href="/settings">
                Re-enter your Alpaca key pair in Settings
              </a>{" "}
              using the verified API Key ID and Secret Key.
            </>
          ) : (
            <>
              <span className="font-semibold">Reimport your Alpaca credentials.</span>{" "}
              Existing Alpaca Paper or Live keys must be reimported.{" "}
              <a className="font-semibold underline underline-offset-2" href="/settings">
                Go to Settings
              </a>{" "}
              and save them again.
            </>
          )}
        </p>
        {!needsKeyReentry && (
          <button
            type="button"
            aria-label="Dismiss Alpaca credential notice"
            onClick={handleDismiss}
            className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-red-100 transition-colors hover:bg-red-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

export function AlpacaCredentialSettingsRecoveryNotice({
  needsReentry,
}: {
  needsReentry: boolean;
}) {
  if (!needsReentry) return null;

  return (
    <div role="alert" className="rounded-lg border border-red-500/50 bg-red-950/70 p-4 text-sm text-red-50">
      <p className="font-semibold">Re-enter your Alpaca key pair to reconnect.</p>
      <p className="mt-1">
        Choose the same account type below, enter the verified API Key ID and Secret Key, then save.
        When Alpaca confirms the same account, your existing account link is kept.
      </p>
    </div>
  );
}
