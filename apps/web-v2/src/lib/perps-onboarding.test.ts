import { describe, expect, test } from "bun:test";

import {
  derivePerpsAutoAction,
  isPerpsWalletSessionVerified,
  isPerpsWalletAuthenticated,
  markPerpsEnabledDialogDismissed,
  perpsEnabledDialogStorageKey,
  shouldShowPerpsEnabledDialog,
  type PerpsAutoActionInput,
} from "./perps-onboarding";

/** A fully-ready baseline that would yield "enable"; tests flip one field. */
const READY: PerpsAutoActionInput = {
  customAuthActive: true,
  walletReady: true,
  authenticated: true,
  hasWallet: true,
  statusKnown: true,
  enabled: false,
  agentReady: false,
  funded: false,
  walletMismatch: false,
  subjectVerified: true,
};

describe("derivePerpsAutoAction", () => {
  test("never auto-runs outside custom-auth mode (manual flow untouched)", () => {
    expect(derivePerpsAutoAction({ ...READY, customAuthActive: false })).toBeNull();
  });

  test("waits for wallet readiness, auth, wallet, and status", () => {
    expect(derivePerpsAutoAction({ ...READY, walletReady: false })).toBeNull();
    expect(derivePerpsAutoAction({ ...READY, authenticated: false })).toBeNull();
    expect(derivePerpsAutoAction({ ...READY, hasWallet: false })).toBeNull();
    expect(derivePerpsAutoAction({ ...READY, statusKnown: false })).toBeNull();
  });

  test("enables first: wallet present but perps not yet enabled", () => {
    expect(derivePerpsAutoAction(READY)).toBe("enable");
  });

  test("activates only once enabled AND funded (HL rejects unfunded approveAgent)", () => {
    expect(
      derivePerpsAutoAction({ ...READY, enabled: true, funded: false }),
    ).toBeNull();
    expect(
      derivePerpsAutoAction({ ...READY, enabled: true, funded: true }),
    ).toBe("activate");
  });

  test("goes quiet once the agent is live", () => {
    expect(
      derivePerpsAutoAction({
        ...READY,
        enabled: true,
        funded: true,
        agentReady: true,
      }),
    ).toBeNull();
  });

  test("never acts on a wallet mismatch (wrong-master footgun)", () => {
    expect(derivePerpsAutoAction({ ...READY, walletMismatch: true })).toBeNull();
    expect(
      derivePerpsAutoAction({
        ...READY,
        enabled: true,
        funded: true,
        walletMismatch: true,
      }),
    ).toBeNull();
  });

  test("H1: an unverified Privy subject blocks EVERY auto action", () => {
    // auto-enable blocked
    expect(derivePerpsAutoAction({ ...READY, subjectVerified: false })).toBeNull();
    // auto-activate blocked (enabled + funded would otherwise activate)
    expect(
      derivePerpsAutoAction({
        ...READY,
        enabled: true,
        funded: true,
        subjectVerified: false,
      }),
    ).toBeNull();
  });
});

describe("isPerpsWalletAuthenticated", () => {
  test("uses completed JWT sync as the custom-auth session signal", () => {
    expect(
      isPerpsWalletAuthenticated({
        customAuthActive: true,
        platformAuthenticated: true,
        privyAuthenticated: false,
        customAuthSyncStatus: "done",
      }),
    ).toBe(true);
    expect(
      isPerpsWalletAuthenticated({
        customAuthActive: true,
        platformAuthenticated: true,
        privyAuthenticated: true,
        customAuthSyncStatus: "loading",
      }),
    ).toBe(false);
  });

  test("keeps the manual Privy auth signal unchanged", () => {
    expect(
      isPerpsWalletAuthenticated({
        customAuthActive: false,
        platformAuthenticated: false,
        privyAuthenticated: true,
        customAuthSyncStatus: "loading",
      }),
    ).toBe(true);
    expect(
      isPerpsWalletAuthenticated({
        customAuthActive: false,
        platformAuthenticated: true,
        privyAuthenticated: false,
        customAuthSyncStatus: "done",
      }),
    ).toBe(false);
  });
});

describe("isPerpsWalletSessionVerified", () => {
  test("fails closed while custom-auth subject resolution is pending", () => {
    expect(
      isPerpsWalletSessionVerified({
        customAuthActive: true,
        subjectVerified: false,
        subjectMismatch: false,
      }),
    ).toBe(false);
  });

  test("fails closed for a definite mismatch", () => {
    expect(
      isPerpsWalletSessionVerified({
        customAuthActive: true,
        subjectVerified: false,
        subjectMismatch: true,
      }),
    ).toBe(false);
  });

  test("allows verified custom-auth and all manual-auth sessions", () => {
    expect(
      isPerpsWalletSessionVerified({
        customAuthActive: true,
        subjectVerified: true,
        subjectMismatch: false,
      }),
    ).toBe(true);
    expect(
      isPerpsWalletSessionVerified({
        customAuthActive: false,
        subjectVerified: false,
        subjectMismatch: true,
      }),
    ).toBe(true);
  });
});

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

const ADDR = "0xAbCd000000000000000000000000000000001234";

describe("one-time Perps enabled dialog persistence", () => {
  test("keys hash the address (L4: no raw wallet address persisted forever)", () => {
    const key = perpsEnabledDialogStorageKey(ADDR);
    expect(key.startsWith("rst.perps.enabledDialogDismissed.v2:")).toBe(true);
    // The raw address (any casing) must not appear in the key.
    expect(key.toLowerCase()).not.toContain(ADDR.slice(2).toLowerCase());
    // Stable and case-insensitive: same wallet, same key.
    expect(perpsEnabledDialogStorageKey(ADDR.toLowerCase())).toBe(key);
    // Different wallets namespace to different keys.
    expect(
      perpsEnabledDialogStorageKey("0x9999999999999999999999999999999999999999"),
    ).not.toBe(key);
  });

  test("shows once, then never again after dismissal", () => {
    const storage = fakeStorage();
    expect(shouldShowPerpsEnabledDialog(storage, ADDR)).toBe(true);
    markPerpsEnabledDialogDismissed(storage, ADDR);
    expect(shouldShowPerpsEnabledDialog(storage, ADDR)).toBe(false);
    // Case-insensitive: the same wallet in different casing stays dismissed.
    expect(shouldShowPerpsEnabledDialog(storage, ADDR.toUpperCase().replace("0X", "0x"))).toBe(false);
  });

  test("a different wallet on the same browser gets its own one-time dialog", () => {
    const storage = fakeStorage();
    markPerpsEnabledDialogDismissed(storage, ADDR);
    expect(
      shouldShowPerpsEnabledDialog(storage, "0x9999999999999999999999999999999999999999"),
    ).toBe(true);
  });

  test("no storage or no address means no dialog (never a popup loop)", () => {
    expect(shouldShowPerpsEnabledDialog(null, ADDR)).toBe(false);
    expect(shouldShowPerpsEnabledDialog(fakeStorage(), null)).toBe(false);
    expect(shouldShowPerpsEnabledDialog(fakeStorage(), undefined)).toBe(false);
    // A throwing storage (privacy mode) is treated as unavailable.
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(shouldShowPerpsEnabledDialog(throwing, ADDR)).toBe(false);
    expect(() => markPerpsEnabledDialogDismissed(throwing, ADDR)).not.toThrow();
  });
});
