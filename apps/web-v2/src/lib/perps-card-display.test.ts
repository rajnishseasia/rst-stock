import { describe, expect, test } from "bun:test";
import {
  PERPS_DISCONNECT_CONFIRM,
  brokerConnectedAccounts,
  canExportPerpsWallet,
  findHyperliquidAccount,
  formatUsdcAmount,
  isHyperliquidProvider,
  perpsWalletActionVariant,
  removeAccountConfirm,
  shouldShowMismatchedPerpsSessionReset,
  shouldShowPendingDeposit,
} from "./perps-card-display";

describe("canExportPerpsWallet", () => {
  const ready = {
    walletAuthenticated: true,
    hasEmbeddedWallet: true,
    subjectVerified: true,
    subjectMismatch: false,
    selectedAddress: "0x1111111111111111111111111111111111111111",
    storedMasterAddress: "0x1111111111111111111111111111111111111111",
  };

  test("allows export for an authenticated embedded wallet without export history", () => {
    expect(canExportPerpsWallet(ready)).toBe(true);
  });

  test("requires the wallet-management session and embedded wallet", () => {
    expect(
      canExportPerpsWallet({ ...ready, walletAuthenticated: false }),
    ).toBe(false);
    expect(canExportPerpsWallet({ ...ready, hasEmbeddedWallet: false })).toBe(
      false,
    );
  });

  test("blocks export for an unverified or mismatched subject", () => {
    expect(canExportPerpsWallet({ ...ready, subjectVerified: false })).toBe(
      false,
    );
    expect(canExportPerpsWallet({ ...ready, subjectMismatch: true })).toBe(
      false,
    );
  });

  test("blocks export when the selected wallet differs from the stored master", () => {
    expect(
      canExportPerpsWallet({
        ...ready,
        selectedAddress: "0x2222222222222222222222222222222222222222",
      }),
    ).toBe(false);
  });

  test("matches the selected wallet to the stored master case-insensitively", () => {
    expect(
      canExportPerpsWallet({
        ...ready,
        selectedAddress: "0xAbCd000000000000000000000000000000001234",
        storedMasterAddress: "0xabcd000000000000000000000000000000001234",
      }),
    ).toBe(true);
  });

  test("blocks export when the stored master is malformed even if strings match", () => {
    expect(
      canExportPerpsWallet({
        ...ready,
        selectedAddress: "not-an-address",
        storedMasterAddress: "not-an-address",
      }),
    ).toBe(false);
  });
});

describe("perpsWalletActionVariant", () => {
  test("disconnect is destructive (danger)", () => {
    expect(perpsWalletActionVariant("disconnect")).toBe("destructive");
  });

  test("export is secondary", () => {
    expect(perpsWalletActionVariant("export")).toBe("secondary");
  });

  test("refresh is a neutral outline", () => {
    expect(perpsWalletActionVariant("refresh")).toBe("outline");
  });

  test("the three actions map to three distinct variants", () => {
    const variants = new Set([
      perpsWalletActionVariant("refresh"),
      perpsWalletActionVariant("export"),
      perpsWalletActionVariant("disconnect"),
    ]);
    expect(variants.size).toBe(3);
  });
});

describe("shouldShowPendingDeposit", () => {
  test("shows for a positive wallet balance", () => {
    expect(shouldShowPendingDeposit(12.34)).toBe(true);
    expect(shouldShowPendingDeposit(0.01)).toBe(true);
  });

  test("collapses at zero so a $0 wallet does not read as 'no funds'", () => {
    expect(shouldShowPendingDeposit(0)).toBe(false);
  });

  test("collapses for unknown / not-yet-read balances", () => {
    expect(shouldShowPendingDeposit(null)).toBe(false);
    expect(shouldShowPendingDeposit(undefined)).toBe(false);
  });

  test("collapses for NaN and negative values", () => {
    expect(shouldShowPendingDeposit(Number.NaN)).toBe(false);
    expect(shouldShowPendingDeposit(-5)).toBe(false);
  });
});

describe("shouldShowMismatchedPerpsSessionReset", () => {
  test("offers a session reset for a mismatched account", () => {
    const input = {
      customAuthActive: true,
      subjectMismatch: true,
    };

    expect(shouldShowMismatchedPerpsSessionReset(input)).toBe(true);
  });

  test("offers a reset even when the stale session exposes an embedded wallet", () => {
    expect(
      shouldShowMismatchedPerpsSessionReset({
        customAuthActive: true,
        subjectMismatch: true,
      }),
    ).toBe(true);
  });

  test("offers a reset before server provisioning when the subject is mismatched", () => {
    expect(
      shouldShowMismatchedPerpsSessionReset({
        customAuthActive: true,
        subjectMismatch: true,
      }),
    ).toBe(true);
  });

  test("does not show for manual-auth or matching states", () => {
    const mismatched = {
      customAuthActive: true,
      subjectMismatch: true,
    };

    expect(
      shouldShowMismatchedPerpsSessionReset({
        ...mismatched,
        customAuthActive: false,
      }),
    ).toBe(false);
    expect(
      shouldShowMismatchedPerpsSessionReset({
        ...mismatched,
        subjectMismatch: false,
      }),
    ).toBe(false);
  });
});

describe("formatUsdcAmount", () => {
  test("renders two decimals", () => {
    expect(formatUsdcAmount(12.5)).toBe("12.50");
    expect(formatUsdcAmount(0)).toBe("0.00");
    expect(formatUsdcAmount(1000)).toBe("1000.00");
  });

  test("does not add a currency symbol (this is a token amount, not USD)", () => {
    expect(formatUsdcAmount(12.5)).not.toContain("$");
  });

  test("renders '-' for invalid input", () => {
    expect(formatUsdcAmount(null)).toBe("-");
    expect(formatUsdcAmount(undefined)).toBe("-");
    expect(formatUsdcAmount(Number.NaN)).toBe("-");
    expect(formatUsdcAmount(-1)).toBe("-");
  });
});

describe("isHyperliquidProvider", () => {
  test("matches case-insensitively", () => {
    expect(isHyperliquidProvider("hyperliquid")).toBe(true);
    expect(isHyperliquidProvider("Hyperliquid")).toBe(true);
    expect(isHyperliquidProvider("HYPERLIQUID")).toBe(true);
  });

  test("does not match other providers or empty input", () => {
    expect(isHyperliquidProvider("alpaca")).toBe(false);
    expect(isHyperliquidProvider("")).toBe(false);
    expect(isHyperliquidProvider(null)).toBe(false);
    expect(isHyperliquidProvider(undefined)).toBe(false);
  });
});

describe("removeAccountConfirm", () => {
  test("hyperliquid gets perps-specific confirmation copy", () => {
    const copy = removeAccountConfirm("hyperliquid");
    expect(copy.title).toContain("Hyperliquid");
    expect(copy.description.toLowerCase()).toContain("perps");
    expect(copy.confirmLabel).toBe("Remove");
  });

  test("is provider case-insensitive", () => {
    expect(removeAccountConfirm("Hyperliquid").confirmLabel).toBe("Remove");
  });

  test("does not claim Remove deletes the agent or moves the balance", () => {
    // `deleteApiCredentials` only drops the credentials row: the Privy agent
    // wallet is keyed to the user and reused on re-enable, the on-chain agent
    // approval is never revoked, and deposited funds stay on Hyperliquid under
    // the master address. The copy must not promise otherwise.
    const description = removeAccountConfirm("hyperliquid").description.toLowerCase();
    expect(description).not.toContain("deletes your hyperliquid trading agent");
    expect(description).not.toContain("self-custody wallet");
    expect(description).toContain("remain");
  });

  test("other providers get the generic broker-key copy", () => {
    const copy = removeAccountConfirm("alpaca");
    expect(copy.title).toBe("Delete Credentials");
    expect(copy.confirmLabel).toBe("Delete");
  });
});

describe("confirmation copy hygiene", () => {
  test("no em dashes in any confirmation copy", () => {
    const strings = [
      PERPS_DISCONNECT_CONFIRM.title,
      PERPS_DISCONNECT_CONFIRM.description,
      PERPS_DISCONNECT_CONFIRM.confirmLabel,
      ...["hyperliquid", "alpaca"].flatMap((p) => {
        const c = removeAccountConfirm(p);
        return [c.title, c.description, c.confirmLabel];
      }),
    ];
    for (const s of strings) {
      expect(s).not.toContain("\u2014");
    }
  });
});

describe("splitting the credentials list across the Broker and Perps tabs", () => {
  const accounts = [
    { id: "a1", provider: "alpaca", accountId: "AKTX" },
    { id: "h1", provider: "hyperliquid", accountId: "0xbE6F" },
    { id: "a2", provider: "Alpaca", accountId: "AKTY" },
  ];

  test("Broker lists brokerages only, never the perps venue", () => {
    // Hyperliquid lives in the same credentials table as Alpaca, which is why
    // it surfaced under "Your linked broker accounts". It is a venue traded
    // through a self-custody wallet, not a brokerage the user linked keys to,
    // and every other thing about it lives under Perps.
    expect(brokerConnectedAccounts(accounts).map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  test("Perps finds the row whose Remove it now owns", () => {
    expect(findHyperliquidAccount(accounts)?.id).toBe("h1");
  });

  test("the two slices are disjoint and together cover the list", () => {
    const broker = brokerConnectedAccounts(accounts);
    const perps = findHyperliquidAccount(accounts);
    expect(broker).not.toContain(perps);
    expect(broker.length + 1).toBe(accounts.length);
  });

  test("provider casing does not decide which tab a row lands on", () => {
    const mixed = [{ id: "h1", provider: "HyperLiquid" }];
    expect(brokerConnectedAccounts(mixed)).toEqual([]);
    expect(findHyperliquidAccount(mixed)?.id).toBe("h1");
  });

  test("an absent or empty list yields no rows and no perps account", () => {
    // The Broker card is gated on the FILTERED length, so a user whose only
    // credential is Hyperliquid must not be shown an empty Connected Accounts
    // card claiming they have linked broker accounts.
    for (const input of [undefined, null, []]) {
      expect(brokerConnectedAccounts(input)).toEqual([]);
      expect(findHyperliquidAccount(input)).toBeNull();
    }
    expect(
      brokerConnectedAccounts([{ id: "h1", provider: "hyperliquid" }]),
    ).toEqual([]);
  });

  test("the disconnect copy no longer sends users to a tab that hides perps", () => {
    // It used to read "use Remove on the Hyperliquid account under Broker",
    // which is now a place that row does not appear.
    expect(PERPS_DISCONNECT_CONFIRM.description).not.toContain("under Broker");
    expect(PERPS_DISCONNECT_CONFIRM.description).toContain("Remove perps below");
  });
});
