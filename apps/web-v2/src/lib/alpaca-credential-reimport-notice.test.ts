import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as noticeModule from "./alpaca-credential-reimport-notice";
import * as providersModule from "../components/providers";
import {
  accountNeedsAlpacaCredentialReimport,
  ALPACA_CREDENTIAL_REIMPORT_NOTICE_GO_LIVE_AT,
  AlpacaCredentialReimportNotice,
  shouldShowAlpacaCredentialReimportNotice,
  type AlpacaCredentialNoticeAccount,
  alpacaAccountTypesNeedingReimport,
} from "./alpaca-credential-reimport-notice";

const alpacaPaper: AlpacaCredentialNoticeAccount = {
  provider: "alpaca",
  accountType: "PAPER",
};

const beforeGoLive = new Date(
  ALPACA_CREDENTIAL_REIMPORT_NOTICE_GO_LIVE_AT.getTime() - 60 * 60 * 1000,
);
const afterGoLive = new Date(
  ALPACA_CREDENTIAL_REIMPORT_NOTICE_GO_LIVE_AT.getTime() + 60 * 60 * 1000,
);

describe("Alpaca credential reimport notice", () => {
  test("shows during the 30-day window for Alpaca paper or live credentials", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [alpacaPaper],
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  test("hides after the 30-day window expires", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [alpacaPaper],
        now: new Date("2026-08-14T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test("keeps a recovery notice visible after expiry and dismissal", () => {
    const markup = renderToStaticMarkup(
      createElement(AlpacaCredentialReimportNotice, {
        accounts: [{ ...alpacaPaper, needsReentry: true }],
        dismissed: true,
        now: new Date("2026-09-13T00:00:00.000Z"),
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Re-enter your Alpaca key pair in Settings");
    expect(markup).toContain('href="/settings"');
    expect(markup).not.toContain('aria-label="Dismiss Alpaca credential notice"');
  });

  test("clears the persistent recovery notice when refreshed status reports a successful re-save", () => {
    const accountsBeforeSave = [
      { ...alpacaPaper, needsReentry: true, updatedAt: beforeGoLive },
    ];
    const accountsAfterSave = [
      { ...alpacaPaper, needsReentry: false, updatedAt: afterGoLive },
    ];
    const beforeSaveMarkup = renderToStaticMarkup(
      createElement(AlpacaCredentialReimportNotice, {
        accounts: accountsBeforeSave,
        dismissed: true,
        now: new Date("2026-09-13T00:00:00.000Z"),
      }),
    );
    const refreshedMarkup = renderToStaticMarkup(
      createElement(AlpacaCredentialReimportNotice, {
        accounts: accountsAfterSave,
        dismissed: true,
        now: new Date("2026-09-13T00:00:00.000Z"),
      }),
    );

    expect(beforeSaveMarkup).toContain("Re-enter your Alpaca key pair in Settings");
    expect(refreshedMarkup).toBe("");
  });

  test("shows matching key re-entry instructions beside the Settings form", () => {
    const SettingsRecoveryNotice = (
      noticeModule as unknown as {
        AlpacaCredentialSettingsRecoveryNotice?: (props: { needsReentry: boolean }) => ReactNode;
      }
    ).AlpacaCredentialSettingsRecoveryNotice;
    expect(typeof SettingsRecoveryNotice).toBe("function");
    if (!SettingsRecoveryNotice) return;

    const markup = renderToStaticMarkup(
      createElement(SettingsRecoveryNotice, { needsReentry: true }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Re-enter your Alpaca key pair to reconnect.");
    expect(markup).toContain("Choose the same account type below");

  });

  test("does not select a Paper account marked for key re-entry", () => {
    const findUsableAlpacaAccount = (
      noticeModule as unknown as {
        findUsableAlpacaAccount?: (accounts: readonly unknown[], accountType: string) => unknown;
      }
    ).findUsableAlpacaAccount;
    expect(typeof findUsableAlpacaAccount).toBe("function");
    if (!findUsableAlpacaAccount) return;

    const unreadable = {
      provider: "alpaca",
      accountType: "PAPER",
      accountId: "PAPER-401",
      id: "paper-401",
      needsReentry: true,
    };
    const healthy = {
      provider: "alpaca",
      accountType: "PAPER",
      accountId: "PAPER-402",
      id: "paper-402",
      needsReentry: false,
    };
    expect(findUsableAlpacaAccount([unreadable], "PAPER")).toBeUndefined();
    expect(findUsableAlpacaAccount([unreadable, healthy], "PAPER")).toBe(healthy);
  });

  test("does not show without an Alpaca paper or live credential", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [{ provider: "alpaca", accountType: "CRYPTO" }],
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test("hides permanently after the user dismisses it", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [alpacaPaper],
        dismissed: true,
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test("hides once the credential was re-saved after the notice went live", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [{ ...alpacaPaper, updatedAt: afterGoLive }],
        now: new Date("2026-07-20T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test("accepts an ISO string updatedAt when detecting a fresh re-save", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [{ ...alpacaPaper, updatedAt: afterGoLive.toISOString() }],
        now: new Date("2026-07-20T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test("still shows when the credential was last saved before the notice went live", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [{ ...alpacaPaper, updatedAt: beforeGoLive }],
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  test("still shows when any Alpaca key remains un-resaved", () => {
    expect(
      shouldShowAlpacaCredentialReimportNotice({
        accounts: [
          { ...alpacaPaper, updatedAt: afterGoLive },
          {
            provider: "alpaca",
            accountType: "LIVE",
            updatedAt: beforeGoLive,
          },
        ],
        now: new Date("2026-07-20T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  test("treats a missing updatedAt as still needing a reimport", () => {
    expect(accountNeedsAlpacaCredentialReimport(alpacaPaper)).toBe(true);
    expect(
      accountNeedsAlpacaCredentialReimport({
        ...alpacaPaper,
        updatedAt: afterGoLive,
      }),
    ).toBe(false);
    expect(
      accountNeedsAlpacaCredentialReimport({
        provider: "alpaca",
        accountType: "CRYPTO",
        updatedAt: beforeGoLive,
      }),
    ).toBe(false);
  });

  test("renders a danger reimport message while visible", () => {
    const markup = renderToStaticMarkup(
      createElement(AlpacaCredentialReimportNotice, {
        accounts: [alpacaPaper],
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Reimport your Alpaca credentials");
    expect(markup).toContain("/settings");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Dismiss Alpaca credential notice"');
  });
});

describe("query retries for Alpaca credential recovery", () => {
  test("does not retry only the recovery-coded query", () => {
    const shouldRetryTrpcQuery = (
      providersModule as unknown as {
        shouldRetryTrpcQuery?: (failureCount: number, error: unknown) => boolean;
      }
    ).shouldRetryTrpcQuery;
    expect(typeof shouldRetryTrpcQuery).toBe("function");
    if (!shouldRetryTrpcQuery) return;

    expect(
      shouldRetryTrpcQuery(0, {
        data: { code: "PRECONDITION_FAILED" },
        message: "Alpaca credentials need to be re-entered in Settings.",
      }),
    ).toBe(false);
    expect(
      shouldRetryTrpcQuery(0, {
        data: { code: "PRECONDITION_FAILED" },
        message: "Hyperliquid is not configured.",
      }),
    ).toBe(true);
    expect(
      shouldRetryTrpcQuery(0, {
        data: { code: "UNAUTHORIZED" },
        message: "Authentication required.",
      }),
    ).toBe(false);
  });
});

describe("alpacaAccountTypesNeedingReimport (multi-row accounts)", () => {
  const GO_LIVE = new Date("2026-07-14T00:00:00.000Z");
  const STALE = new Date("2026-07-01T00:00:00.000Z");
  const FRESH = new Date("2026-07-20T00:00:00.000Z");

  test("a re-saved account type clears even when an older sibling row remains", () => {
    // The settings form only writes the null-accountId row, so a user with
    // separate rows keeps a stale sibling forever. Judging per account type by
    // the newest row means one save is enough.
    const types = alpacaAccountTypesNeedingReimport(
      [
        { provider: "alpaca", accountType: "PAPER", updatedAt: STALE },
        { provider: "alpaca", accountType: "PAPER", updatedAt: FRESH },
      ],
      GO_LIVE,
    );
    expect(types).toEqual([]);
  });

  test("an account type whose newest row is still stale keeps the notice", () => {
    const types = alpacaAccountTypesNeedingReimport(
      [
        { provider: "alpaca", accountType: "PAPER", updatedAt: FRESH },
        { provider: "alpaca", accountType: "LIVE", updatedAt: STALE },
      ],
      GO_LIVE,
    );
    expect(types).toEqual(["LIVE"]);
  });

  test("an unknown save time never makes an account type look fresh", () => {
    const types = alpacaAccountTypesNeedingReimport(
      [
        { provider: "alpaca", accountType: "LIVE", updatedAt: null },
        { provider: "alpaca", accountType: "LIVE", updatedAt: STALE },
      ],
      GO_LIVE,
    );
    expect(types).toEqual(["LIVE"]);
  });

  test("non-Alpaca and crypto rows are ignored", () => {
    expect(
      alpacaAccountTypesNeedingReimport(
        [
          { provider: "hyperliquid", accountType: "LIVE", updatedAt: STALE },
          { provider: "alpaca", accountType: "CRYPTO", updatedAt: STALE },
        ],
        GO_LIVE,
      ),
    ).toEqual([]);
  });
});
