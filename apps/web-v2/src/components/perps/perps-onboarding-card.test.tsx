/**
 * The funding instruction has to be one a copy mirror can actually follow.
 *
 * The bug this covers: the deposit step told the user "Minimum 5 USDC" (the
 * Hyperliquid BRIDGE floor, `HL_MIN_DEPOSIT_USDC`) while the copy mirror
 * refuses to submit any perp order worth less than
 * `MIRROR_MIN_ORDER_NOTIONAL_USD` = 10 (`packages/types`, read by both the
 * worker gate and this step). Following the app's own instruction produced a
 * funded account that silently never placed a single mirrored order.
 *
 * These assertions are made against the RENDERED deposit step, not against the
 * component's source text, so a constant that is defined but never reaches the
 * screen fails here.
 */

// PERPS_ENABLED is read at module scope by `@/lib/perps-config`, and the card
// short-circuits to a "not configured" placeholder when it is false. Set the
// var before the card (and its config import) is loaded below.
process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-privy-app";

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The env var alone is not enough in a whole-suite run: `@/lib/perps-config`
// evaluates PERPS_ENABLED once at module scope, and another test file
// (components/feed/signal-ticker-chips.test.tsx) imports it first, before this
// file sets the var. The module cache then hands this file a false flag and the
// card renders its "not configured" placeholder. Replacing the module makes the
// deployment flag explicit here instead of load-order dependent.
mock.module("@/lib/perps-config", () => ({ PERPS_ENABLED: true }));

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

/** Server status for a user who is enabled but has not funded yet. */
const status = {
  enabled: true,
  agentReady: false,
  walletAddress: WALLET_ADDRESS as string | null,
  hlBalanceUsd: 0,
  network: "mainnet",
};

const walletState = {
  ready: true,
  authenticated: true,
  customAuthActive: false,
  subjectVerified: true,
  subjectMismatch: false,
  login: () => {},
  logout: async () => {},
  embeddedWallet: {},
  hasWallet: true,
  address: WALLET_ADDRESS as string | undefined,
  walletsReady: true,
  createWallet: async () => {},
  importWallet: async () => {},
  getWalletClient: async () => ({}),
  fundWallet: async () => {},
  exportWallet: async () => {},
  usdcBalance: null,
  ethBalance: null,
  depositToHyperliquid: async () => "0x",
};

let renderedStatus = status;

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => ({}),
  isPending: false,
  isError: false,
  error: null as { message: string } | null,
  reset: () => {},
};

mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      hyperliquid: {
        status: { invalidate: async () => {}, fetch: async () => status },
      },
    }),
    hyperliquid: {
      status: {
        useQuery: () => ({
          data: renderedStatus,
          isSuccess: true,
          isLoading: false,
          error: null,
          refetch: async () => ({ data: status }),
        }),
      },
      enable: { useMutation: () => noopMutation },
      rotatePendingAgent: { useMutation: () => noopMutation },
      markAgentRegistered: { useMutation: () => noopMutation },
      solFundingAddress: {
        useQuery: () => ({
          data: { enabled: true, depositAddress: "mock-sol-deposit-address", fee: "0.005" },
          isLoading: false,
          error: null,
          refetch: async () => ({}),
        }),
      },
    },
  },
}));

mock.module("@/lib/use-perps-wallet", () => ({
  usePerpsWallet: () => walletState,
}));

const {
  PerpsOnboardingCard,
  PERPS_MIN_USABLE_DEPOSIT_USDC,
  PERPS_SUGGESTED_DEPOSIT_USDC,
} = await import("./perps-onboarding-card");
const { MIRROR_MIN_ORDER_NOTIONAL_USD } = await import("@trade-bot/types");
const { HL_MIN_DEPOSIT_USDC } = await import("@/lib/hyperliquid-deposit");

/** The deposit step as the user sees it. */
function depositStepMarkup(): string {
  return renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);
}

test("custom-auth first-time setup offers import before creating a wallet", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = {
    ...status,
    enabled: false,
    walletAddress: null,
  };
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: undefined,
    hasWallet: false,
    address: undefined,
    customAuthActive: true,
    walletsReady: true,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);
    expect(markup).toContain("Import existing wallet");
    expect(markup).toContain("Create new wallet");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

test("an enabled account with no wallet exposes no setup or wallet actions", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = status;
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: undefined,
    hasWallet: false,
    address: undefined,
    customAuthActive: true,
    walletsReady: true,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);
    expect(markup).toContain("Perps wallet unavailable");
    expect(markup).not.toContain("Import existing wallet");
    expect(markup).not.toContain("Create new wallet");
    expect(markup).not.toContain("Export Private Key");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

test("unresolved custom-auth subject makes an embedded wallet read-only", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = status;
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: {},
    hasWallet: true,
    address: WALLET_ADDRESS,
    customAuthActive: true,
    subjectVerified: false,
    subjectMismatch: false,
    walletsReady: true,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);
    expect(markup).toContain("Wallet session verification is still pending");
    expect(markup).not.toContain("Export Private Key");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

test("a mismatched enabled wallet blocks wrong-wallet actions", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = status;
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: {},
    hasWallet: true,
    address: "0x2222222222222222222222222222222222222222",
    customAuthActive: false,
    subjectVerified: true,
    subjectMismatch: false,
    walletsReady: true,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);

    expect(markup).toContain("Wrong wallet connected");
    expect(markup).toContain("Sign out and back in");
    expect(markup).not.toContain("Export Private Key");
    expect(markup).not.toContain("Deposit to Hyperliquid");
    expect(markup).not.toContain("Deposit USDC");
    expect(markup).not.toContain("How to fund your wallet");
    expect(markup).not.toContain("Copy address");
    expect(markup).not.toContain(">Copy<");
    expect(markup).not.toContain("Activate Trading");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

test("an enabled account with no stored master blocks wallet actions", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = {
    ...status,
    enabled: true,
    walletAddress: null,
  };
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: {},
    hasWallet: true,
    address: "0x2222222222222222222222222222222222222222",
    customAuthActive: false,
    subjectVerified: true,
    subjectMismatch: false,
    walletsReady: true,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);

    expect(markup).toContain("Perps wallet identity unavailable");
    expect(markup).toContain("No wallet has been selected for this account");
    expect(markup).not.toContain("Wallet address");
    expect(markup).not.toContain("Export Private Key");
    expect(markup).not.toContain("How to fund your wallet");
    expect(markup).not.toContain("Copy address");
    expect(markup).not.toContain(">Copy<");
    expect(markup).not.toContain("Deposit to Hyperliquid");
    expect(markup).not.toContain("Deposit USDC");
    expect(markup).not.toContain("Activate Trading");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

test("an enabled account with an invalid stored master exposes no wallet actions", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = {
    ...status,
    enabled: true,
    walletAddress: "not-an-address",
  };
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: {},
    hasWallet: true,
    address: "0x2222222222222222222222222222222222222222",
    customAuthActive: false,
    subjectVerified: true,
    subjectMismatch: false,
    walletsReady: true,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);

    expect(markup).toContain("Perps wallet identity unavailable");
    expect(markup).not.toContain("not-an-address");
    expect(markup).not.toContain("Wallet address");
    expect(markup).not.toContain("Export Private Key");
    expect(markup).not.toContain("How to fund your wallet");
    expect(markup).not.toContain("Copy address");
    expect(markup).not.toContain("Deposit to Hyperliquid");
    expect(markup).not.toContain("Deposit USDC");
    expect(markup).not.toContain("Activate Trading");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

test("an import-provider error cannot echo the submitted key into UI or logs", async () => {
  const syntheticKey = "a".repeat(64);
  const capturedLogs: string[] = [];
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  const captureLog = (...args: Parameters<typeof console.error>) => {
    capturedLogs.push(args.map((argument) => String(argument)).join(" "));
  };
  console.error = captureLog;
  console.warn = captureLog;
  console.log = captureLog;

  try {
    const { importPerpsWalletSafely } = await import("./perps-onboarding-card");
    const errorMessage = await importPerpsWalletSafely(
      async () => {
        throw new Error(`Privy provider rejected ${syntheticKey}`);
      },
      syntheticKey,
    );
    const markup = renderToStaticMarkup(<p>{errorMessage}</p>);
    const keyAppearedInOutput =
      markup.includes(syntheticKey) ||
      capturedLogs.some((entry) => entry.includes(syntheticKey));

    expect(markup.includes("Could not import wallet.")).toBe(true);
    expect(keyAppearedInOutput).toBe(false);
  } finally {
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.log = originalConsole.log;
  }
});

test("an enabled account never falls back to first-time wallet setup", () => {
  const originalStatus = renderedStatus;
  const originalWallet = { ...walletState };
  renderedStatus = status;
  Object.assign(walletState, {
    authenticated: true,
    embeddedWallet: undefined,
    hasWallet: false,
    address: undefined,
    customAuthActive: true,
    subjectVerified: true,
    subjectMismatch: false,
    walletsReady: false,
  });

  try {
    const markup = renderToStaticMarkup(<PerpsOnboardingCard enabledSession />);

    expect(markup).toContain("Perps wallet unavailable");
    expect(markup).not.toContain("Import existing wallet");
    expect(markup).not.toContain("Create new wallet");
  } finally {
    renderedStatus = originalStatus;
    Object.assign(walletState, originalWallet);
  }
});

describe("perps funding instruction", () => {
  test("states a minimum the copy mirror can actually place an order with", () => {
    const markup = depositStepMarkup();

    // The number that used to be here. 5 USDC is creditable at the bridge and
    // useless to the mirror, which is the whole defect.
    expect(markup).not.toContain(`Minimum ${HL_MIN_DEPOSIT_USDC} USDC`);
    expect(markup).toContain(`Minimum ${PERPS_MIN_USABLE_DEPOSIT_USDC} USDC`);
    expect(PERPS_MIN_USABLE_DEPOSIT_USDC).toBeGreaterThanOrEqual(
      MIRROR_MIN_ORDER_NOTIONAL_USD,
    );
    // The bridge floor still binds: the UI minimum may never drop below what
    // Hyperliquid will credit.
    expect(PERPS_MIN_USABLE_DEPOSIT_USDC).toBeGreaterThanOrEqual(
      HL_MIN_DEPOSIT_USDC,
    );
  });

  test("says why, so the number does not read as arbitrary", () => {
    const markup = depositStepMarkup();

    expect(markup).toContain("copy trading skips any mirrored order worth less");
    // The reason carries the mirror's actual per-order floor, not a vague
    // "small orders may fail".
    expect(markup).toContain("$10.00");
  });

  test("suggests more than one order's worth rather than exactly one", () => {
    // Funding to exactly the floor buys one mirrored order and drops the
    // account back under it, so the next signal is skipped.
    expect(PERPS_SUGGESTED_DEPOSIT_USDC).toBeGreaterThanOrEqual(
      PERPS_MIN_USABLE_DEPOSIT_USDC * 2,
    );
    expect(depositStepMarkup()).toContain(
      `placeholder="${PERPS_SUGGESTED_DEPOSIT_USDC}"`,
    );
  });

  test("enforces the minimum it states on the amount input", () => {
    // A stated minimum the control does not enforce is the same defect in the
    // other direction: the copy would say 10 while the field accepted 5.
    const markup = depositStepMarkup();

    expect(markup).toContain(`min="${PERPS_MIN_USABLE_DEPOSIT_USDC}"`);
    expect(markup).not.toContain(`min="${HL_MIN_DEPOSIT_USDC}"`);
  });

  test("states the shared mirror floor, not a copy of it", () => {
    // There used to be two literals here, one in the worker and one in this
    // component, and a test on each asserting its own copy was 10. Neither
    // could fail when only the other moved, which is what made the pair
    // pointless. Both now read `@trade-bot/types`.
    //
    // What is worth pinning after the merge is that the funding copy is DRIVEN
    // by the shared value: raise the floor and this step must state the new
    // one, or users fund to a number the mirror refuses to trade with.
    expect(MIRROR_MIN_ORDER_NOTIONAL_USD).toBe(10);
    expect(PERPS_MIN_USABLE_DEPOSIT_USDC).toBe(
      Math.max(HL_MIN_DEPOSIT_USDC, MIRROR_MIN_ORDER_NOTIONAL_USD),
    );
    expect(depositStepMarkup()).toContain(
      `Minimum ${Math.max(HL_MIN_DEPOSIT_USDC, MIRROR_MIN_ORDER_NOTIONAL_USD)} USDC`,
    );
  });

  test("labels the Solana funding option as Spot to avoid misrepresenting it as direct perps funding", () => {
    const markup = depositStepMarkup();
    expect(markup).toContain("Solana (SOL - Spot)");
  });
});
