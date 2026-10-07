"use client";

/**
 * PerpsOnboardingCard - THE perps onboarding + funding surface, mounted in two
 * places (one component, zero copy-paste):
 *
 *   - Settings -> "Perpetual Futures (Hyperliquid)" card (variant="card"),
 *     behavior-identical to the card that used to live inline in
 *     settings/page.tsx.
 *   - The perps venue trade rail (variant="rail", compact, no Card chrome),
 *     replacing the old "Enable perpetual futures in Settings to trade."
 *     dead-end so a not-yet-enabled user can set up + fund right in the
 *     terminal. Deposit address, balances, and Refresh stay visible there
 *     until the agent is live (then the trade form takes over).
 *
 * FLOW (see HYPERLIQUID-PERPS-PLAN.md): perps run on the user's Privy
 * EMBEDDED wallet (self-custody MASTER) + a server-controlled AGENT wallet:
 *   1. Connect wallet  -> Privy login -> user creates or imports the wallet.
 *   2. Enable          -> `hyperliquid.enable({ masterAddress })` provisions
 *                         the agent (accountType = PENDING).
 *   3. Fund / Deposit  -> user sends USDC (Arbitrum) + deposits to HL.
 *   4. Activate        -> client-signed `approveAgent` (+ builder fee), then
 *                         `markAgentRegistered` flips PENDING -> LIVE.
 *
 * ZERO-EXTRA-LOGIN (Privy custom auth, `wallet.customAuthActive`): the Privy
 * session follows the Better Auth login, while the user explicitly chooses
 * create or import before a wallet is provisioned. `enable` auto-runs after
 * that choice and activation auto-runs once funded (signing is popup-free with
 * showWalletUIs: false). A ONE-TIME "Perps enabled" dialog shows the deposit
 * address; dismissal is persisted per wallet in localStorage. The decision
 * helpers are pure and unit-tested (lib/perps-onboarding.ts).
 *
 * GATE: `usePerpsWallet` mounts Privy hooks that THROW without a
 * `PrivyProvider`, so the wrapper short-circuits on `PERPS_ENABLED` before
 * the inner component ever mounts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { usePerpsWallet } from "@/lib/use-perps-wallet";
import {
  activateAgentOnChain,
  activateAgentWithReuseRecovery,
} from "@/lib/hyperliquid-activate";
import {
  depositUsdcToHyperliquid,
  readPerpsWalletBalancesByAddress,
  HL_MIN_DEPOSIT_USDC,
} from "@/lib/hyperliquid-deposit";
import { PERPS_ENABLED } from "@/lib/perps-config";
import {
  derivePerpsAutoAction,
  isPerpsWalletSessionVerified,
  markPerpsEnabledDialogDismissed,
  shouldShowPerpsEnabledDialog,
} from "@/lib/perps-onboarding";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
// Shared currency helper (CLAUDE.md M16). The Hyperliquid balance is a plain USD
// amount, so it uses formatUsd; the perps-specific adaptive formatters are only
// for HL prices and funding rates, which span sub-cent magnitudes.
import { formatUsd } from "@/lib/format";
// The mirror floor is ENFORCED by the worker and merely STATED here. Shared so
// the number this step tells a user to fund with is the number the gate uses.
import { MIRROR_MIN_ORDER_NOTIONAL_USD } from "@trade-bot/types";
import {
  PERPS_DISCONNECT_CONFIRM,
  canExportPerpsWallet,
  perpsWalletActionVariant,
  shouldShowMismatchedPerpsSessionReset,
  shouldShowPendingDeposit,
} from "@/lib/perps-card-display";
import {
  isValidPerpsMasterAddress,
  matchesPerpsMasterAddress,
} from "@/lib/perps-wallet-selection";

export type PerpsOnboardingVariant = "card" | "rail";

/**
 * The floor the deposit step states and enforces: whichever of the bridge
 * minimum and the mirror minimum binds harder. Derived rather than typed so a
 * change to either input moves the stated number with it.
 */
export const PERPS_MIN_USABLE_DEPOSIT_USDC = Math.max(
  HL_MIN_DEPOSIT_USDC,
  MIRROR_MIN_ORDER_NOTIONAL_USD,
);

/**
 * The prefilled deposit suggestion.
 *
 * Deliberately a multiple of the floor, not the floor itself. Funding to
 * exactly the minimum buys one order and leaves the account back under the
 * floor, so the very next signal is skipped; the suggestion leaves room for
 * several.
 */
export const PERPS_SUGGESTED_DEPOSIT_USDC = PERPS_MIN_USABLE_DEPOSIT_USDC * 3;

/** Convert provider import failures to a fixed message that cannot echo a key. */
export async function importPerpsWalletSafely(
  importWallet: (privateKey: string) => Promise<void>,
  privateKey: string,
): Promise<string | null> {
  try {
    await importWallet(privateKey);
    return null;
  } catch {
    return "Could not import wallet. Check the key and try again.";
  }
}

/**
 * M5: how long the custom-auth waiting states ("Preparing your perps
 * wallet...", "Creating your self-custody perps wallet...") may spin before
 * the card surfaces an error with a Retry. Without this, a flag-on deployment
 * whose Privy dashboard lacks the custom-auth (JWKS) configuration shows an
 * infinite spinner with no signal for users or operators.
 */
const CUSTOM_AUTH_WAIT_TIMEOUT_MS = 20_000;

export interface PerpsOnboardingCardProps {
  /** True when a Better Auth session exists (gates the status query). */
  enabledSession: boolean;
  /**
   * "card" (default): full Settings card with Card chrome + title.
   * "rail": compact, chrome-less variant for the perps trade rail.
   */
  variant?: PerpsOnboardingVariant;
}

export function PerpsOnboardingCard({
  enabledSession,
  variant = "card",
}: PerpsOnboardingCardProps) {
  if (!PERPS_ENABLED) {
    if (variant === "rail") {
      return (
        <div className="text-sm text-muted-foreground">
          Perps unavailable - not configured.
        </div>
      );
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle>Perpetual Futures (Hyperliquid)</CardTitle>
          <CardDescription>Perps unavailable - not configured.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <PerpsOnboardingCardInner enabledSession={enabledSession} variant={variant} />
  );
}

/** Variant-aware chrome: Settings keeps the Card; the rail is border-less. */
function OnboardingShell({
  variant,
  children,
}: {
  variant: PerpsOnboardingVariant;
  children: React.ReactNode;
}) {
  if (variant === "rail") {
    return (
      <div className="space-y-4">
        <div>
          <div className="text-sm font-medium">Set up perpetual futures</div>
          <p className="text-xs text-muted-foreground">
            Self-custody wallet; a policy-locked agent signs orders server-side
            so trading stays popup-free.
          </p>
        </div>
        {children}
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Perpetual Futures (Hyperliquid)</CardTitle>
        <CardDescription>
          Trade perps in the same terminal with a self-custody wallet. You own
          the wallet (fund it, export the key); a policy-locked agent signs
          orders server-side so trading stays popup-free.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function PerpsOnboardingCardInner({
  enabledSession,
  variant,
}: {
  enabledSession: boolean;
  variant: PerpsOnboardingVariant;
}) {
  const trpcUtils = trpc.useUtils();
  const statusQuery = trpc.hyperliquid.status.useQuery(undefined, {
    enabled: enabledSession,
    // Poll while a wallet exists but is not yet funded, so the UI reflects an
    // async on-chain deposit landing without a manual refresh.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.enabled && !data.agentReady && Number(data.hlBalanceUsd ?? 0) <= 0) {
        return 10_000;
      }
      return false;
    },
  });
  const wallet = usePerpsWallet({
    // Keep an enabled account bound to its stored master address so another
    // linked wallet can never sign or receive funds for it.
    preferredAddress: statusQuery.data?.walletAddress,
    requirePreferredAddress: statusQuery.data?.enabled === true,
  });
  const customAuth = wallet.customAuthActive;
  const [copied, setCopied] = useState(false);
  const [fundingChain, setFundingChain] = useState<"arbitrum" | "solana" | "ethereum">("arbitrum");
  const [copiedSol, setCopiedSol] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  // Deposit step (between fund + activate). We read the embedded wallet's on-chain
  // USDC + ETH balances to gate the button, hold the amount input, and surface a
  // deposit error / in-flight state. `depositError` is separate from
  // `activateError` so a failed deposit doesn't clobber activation messaging.
  const [depositAmount, setDepositAmount] = useState("");
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [walletUsdc, setWalletUsdc] = useState<number | null>(null);
  const [walletEth, setWalletEth] = useState<number | null>(null);
  // ONE-TIME "Perps enabled" dialog (custom-auth flow): shown after the
  // enable pipeline first succeeds; dismissal persisted per wallet.
  const [showEnabledDialog, setShowEnabledDialog] = useState(false);
  // Builder details returned by `enable` - needed for the client-side
  // approveBuilderFee. Cached here from the enable response so Activate can use
  // them without a second round-trip.
  const [enableResult, setEnableResult] = useState<{
    agentAddress: string | null;
    agentName: string;
    builderConfigured: boolean;
    builderAddress: string | null;
    builderMaxFeeRate: string | null;
  } | null>(null);

  const enableMutation = trpc.hyperliquid.enable.useMutation({
    onSuccess: (result) => {
      setEnableResult({
        agentAddress: result.agentAddress,
        agentName: result.agentName,
        builderConfigured: result.builderConfigured,
        builderAddress: result.builderAddress,
        builderMaxFeeRate: result.builderMaxFeeRate,
      });
      // Zero-login flow: first-ever enable -> one-time success popup with the
      // deposit address. `alreadyEnabled` re-runs (idempotent enables) and
      // previously-dismissed wallets stay quiet.
      if (
        customAuth &&
        !result.alreadyEnabled &&
        shouldShowPerpsEnabledDialog(
          typeof window !== "undefined" ? window.localStorage : null,
          result.walletAddress,
        )
      ) {
        setShowEnabledDialog(true);
      }
      void trpcUtils.hyperliquid.status.invalidate();
    },
  });

  const markRegisteredMutation = trpc.hyperliquid.markAgentRegistered.useMutation({
    onSuccess: () => {
      void trpcUtils.hyperliquid.status.invalidate();
    },
  });
  const rotatePendingAgentMutation = trpc.hyperliquid.rotatePendingAgent.useMutation();

  const status = statusQuery.data;
  const enabled = status?.enabled ?? false;
  const agentReady = status?.agentReady ?? false;
  const walletAddress = status?.walletAddress ?? null;
  const balanceUsd = Number(status?.hlBalanceUsd ?? 0);
  const isFunded = balanceUsd > 0;
  const network = status?.network ?? null;

  const solFundingQuery = trpc.hyperliquid.solFundingAddress.useQuery(
    undefined,
    {
      enabled: fundingChain === "solana" && enabled,
      staleTime: 60_000,
    },
  );

  const handleCopySol = async () => {
    const addr = solFundingQuery.data?.depositAddress;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopiedSol(true);
      setTimeout(() => setCopiedSol(false), 2000);
    } catch {
      // Fallback
    }
  };

  // Once Privy is authenticated + the embedded wallet exists but perps aren't
  // yet enabled server-side, provision the agent with the embedded address.
  const embeddedAddress = wallet.address;
  const showMismatchedSessionReset = shouldShowMismatchedPerpsSessionReset({
    customAuthActive: customAuth,
    subjectMismatch: wallet.subjectMismatch,
  });
  const canExportWallet = canExportPerpsWallet({
    walletAuthenticated: wallet.authenticated,
    hasEmbeddedWallet: Boolean(embeddedAddress),
    subjectVerified: wallet.subjectVerified,
    subjectMismatch: wallet.subjectMismatch,
    selectedAddress: embeddedAddress,
    storedMasterAddress: walletAddress,
  });
  const walletSessionVerified = isPerpsWalletSessionVerified({
    customAuthActive: customAuth,
    subjectVerified: wallet.subjectVerified,
    subjectMismatch: wallet.subjectMismatch,
  });

  const storedMasterAddressValid = isValidPerpsMasterAddress(walletAddress);
  const walletIdentityUnavailable = enabled && !storedMasterAddressValid;
  const walletIdentityBound =
    !enabled || matchesPerpsMasterAddress(embeddedAddress, walletAddress);
  const walletIdentityBlocked = enabled && !walletIdentityBound;

  // NEW-1: the CONNECTED embedded wallet must match the stored master. When they
  // differ (user reconnected with a different Privy wallet/email), surface a
  // persistent warning - signing/depositing with the wrong wallet is a footgun.
  const walletMismatch =
    enabled &&
    storedMasterAddressValid &&
    Boolean(embeddedAddress) &&
    !walletIdentityBound;

  const handleConnect = () => {
    setActivateError(null);
    wallet.login();
  };

  // Post-login wallet setup: create a fresh embedded wallet, or import an
  // existing private key into a Privy-secured embedded wallet. The key is passed
  // straight to Privy (enclave) and never sent to our server.
  const [walletMode, setWalletMode] = useState<"choose" | "import">("choose");
  const [importKey, setImportKey] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [isResettingWalletSession, setIsResettingWalletSession] = useState(false);
  const [sessionResetError, setSessionResetError] = useState<string | null>(null);

  const handleCreateWallet = async () => {
    setWalletError(null);
    if (enabled) {
      setWalletError(
        "A replacement wallet cannot be created for an enabled perps account.",
      );
      return;
    }
    if (!walletSessionVerified) {
      setWalletError(
        "Your perps wallet session could not be verified for this account. " +
          "Sign out and back in before creating a wallet.",
      );
      return;
    }
    setWalletBusy(true);
    try {
      await wallet.createWallet();
    } catch (error) {
      setWalletError(
        error instanceof Error ? error.message : "Could not create wallet.",
      );
    } finally {
      setWalletBusy(false);
    }
  };

  const handleImportWallet = async () => {
    setWalletError(null);
    if (walletIdentityUnavailable) {
      setWalletError(
        "The stored perps wallet identity is unavailable. Contact support.",
      );
      return;
    }
    if (!walletSessionVerified) {
      setWalletError(
        "Your perps wallet session could not be verified for this account. " +
          "Sign out and back in before importing a wallet.",
      );
      return;
    }
    setWalletBusy(true);
    try {
      const importError = await importPerpsWalletSafely(
        wallet.importWallet,
        importKey,
      );
      if (importError) {
        setWalletError(importError);
        return;
      }
      setImportKey("");
      setWalletMode("choose");
    } finally {
      setWalletBusy(false);
    }
  };

  const handleEnable = () => {
    if (!embeddedAddress || (enabled && !walletIdentityBound)) return;
    // H1: never enable against a Privy wallet whose custom-auth subject does
    // not match the signed-in Better Auth user (stale session, shared browser).
    if (!walletSessionVerified) {
      setActivateError(
        "Your perps wallet session is not verified for this account. " +
          "Restore the wallet session before enabling perps.",
      );
      return;
    }
    setActivateError(null);
    enableMutation.mutate({ masterAddress: embeddedAddress });
  };

  const handleCopy = async () => {
    if (!embeddedAddress || !walletIdentityBound || !walletSessionVerified) return;
    try {
      await navigator.clipboard.writeText(embeddedAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); ignore silently.
    }
  };

  const handleActivate = async () => {
    setActivateError(null);
    if (enabled && !walletIdentityBound) {
      setActivateError(
        "The connected wallet does not match this perps account.",
      );
      return;
    }
    if (!walletSessionVerified) {
      setActivateError(
        "Your perps wallet session is not verified for this account. " +
          "Restore the wallet session before activating.",
      );
      return;
    }
    // H1: the Privy session (which signs approveAgent) must belong to the
    // signed-in Better Auth user. Block before any signing on a mismatch.
    if (wallet.subjectMismatch) {
      setActivateError(
        "Your perps wallet session belongs to a different account. " +
          "Sign out and back in, then try again.",
      );
      return;
    }
    // NEW-1 guard: the on-chain `approveAgent` MUST be signed by the SAME master
    // wallet that perps were enabled with (the stored `walletAddress`). If the
    // user reconnected/logged into Privy with a different embedded wallet, signing
    // here would approve the agent under the WRONG master - `markAgentRegistered`
    // then reads extraAgents(storedMaster) and finds nothing, so activation would
    // fail confusingly (or, worse, approve under an account we don't track). Block
    // up front with an actionable message.
    if (
      walletAddress &&
      embeddedAddress &&
      walletAddress.toLowerCase() !== embeddedAddress.toLowerCase()
    ) {
      setActivateError(
        `You enabled perps with ${walletAddress}. Reconnect that wallet ` +
          `(or log into Privy with the original email) to activate.`,
      );
      return;
    }
    // Prefer the cached enable result; fall back to a fresh enable() call (it's
    // idempotent and returns the same agent + builder details).
    let details = enableResult;
    if (!details || !details.agentAddress) {
      if (!embeddedAddress) {
        setActivateError("Wallet not ready. Reconnect and try again.");
        return;
      }
      try {
        const result = await enableMutation.mutateAsync({
          masterAddress: embeddedAddress,
        });
        details = {
          agentAddress: result.agentAddress,
          agentName: result.agentName,
          builderConfigured: result.builderConfigured,
          builderAddress: result.builderAddress,
          builderMaxFeeRate: result.builderMaxFeeRate,
        };
      } catch (error) {
        setActivateError(
          error instanceof Error ? error.message : "Failed to prepare activation.",
        );
        return;
      }
    }
    if (!details.agentAddress) {
      setActivateError("Agent wallet is not provisioned. Re-enable perps.");
      return;
    }
    if (!network) {
      setActivateError("Network is not known yet. Refresh and try again.");
      return;
    }
    // Guaranteed by the enclosing render branch (this button only mounts when
    // embeddedAddress is set), but re-check so TS narrows and so a bug that
    // slipped past the render gate surfaces as a clean error instead of an
    // `undefined` reaching HL as the master.
    if (!embeddedAddress) {
      setActivateError("Wallet not ready. Reconnect and try again.");
      return;
    }

    setIsActivating(true);
    try {
      const walletClient = await wallet.getWalletClient();
      // Hyperliquid agent addresses must never be reused after deregistration.
      // Older RST accounts could retain one such Privy agent while their funded
      // master wallet remained perfectly healthy. Recover only from HL's exact,
      // definitive reuse refusal: the API creates a fresh policy-locked server
      // agent and atomically swaps that reference while preserving the master.
      // Ambiguous transport/signing errors never rotate, and a replacement is
      // attempted only once (activateAgentWithReuseRecovery is unit-tested).
      const approvedDetails = await activateAgentWithReuseRecovery({
        initial: details,
        activate: async (candidate) => {
          // embeddedAddress is guarded above: the wallet-mismatch check returned
          // early when this doesn't match the stored master, so this signer IS
          // the master that owns the funded Hyperliquid account.
          await activateAgentOnChain({
            walletClient,
            masterAddress: embeddedAddress as `0x${string}`,
            agentAddress: candidate.agentAddress as `0x${string}`,
            agentName: candidate.agentName,
            builderConfigured: candidate.builderConfigured,
            builderAddress: (candidate.builderAddress ?? null) as `0x${string}` | null,
            builderMaxFeeRate: (candidate.builderMaxFeeRate ?? null) as
              | `${string}%`
              | null,
            network,
          });
        },
        rotate: async (failedCandidate) => {
          if (!failedCandidate.agentAddress) {
            throw new Error("The failed trading agent address is missing. Refresh and try again.");
          }
          const replacement = await rotatePendingAgentMutation.mutateAsync({
            reason: "EXTRA_AGENT_ALREADY_USED",
            failedAgentAddress: failedCandidate.agentAddress,
          });
          const next = {
            agentAddress: replacement.agentAddress,
            agentName: replacement.agentName,
            builderConfigured: replacement.builderConfigured,
            builderAddress: replacement.builderAddress,
            builderMaxFeeRate: replacement.builderMaxFeeRate,
          };
          setEnableResult(next);
          return next;
        },
      });
      setEnableResult(approvedDetails);
      // On-chain approval succeeded → confirm to the server (flips PENDING → LIVE).
      await markRegisteredMutation.mutateAsync();
    } catch (error) {
      setActivateError(
        error instanceof Error
          ? error.message
          : "Activation failed. Please try again.",
      );
    } finally {
      setIsActivating(false);
    }
  };

  // ZERO-EXTRA-LOGIN pipeline: in custom-auth mode, auto-run the next setup
  // step (pure decision in lib/perps-onboarding.ts). Each step fires at most
  // once per mount; a failure surfaces through the same error states as the
  // manual buttons, which remain as the retry path.
  const autoEnableAttempted = useRef(false);
  const autoActivateAttempted = useRef(false);
  const statusKnown = status !== undefined;
  const hasWallet = Boolean(embeddedAddress);
  useEffect(() => {
    const action = derivePerpsAutoAction({
      customAuthActive: customAuth,
      walletReady: wallet.ready,
      authenticated: wallet.authenticated,
      hasWallet,
      statusKnown,
      enabled,
      agentReady,
      funded: isFunded,
      walletMismatch: walletMismatch || walletIdentityBlocked,
      // H1 wrong-wallet-binding gate: the Privy custom-auth subject must equal
      // the current Better Auth user id, or no auto step may run (a stale
      // Privy session on a shared browser could belong to a different user).
      subjectVerified: wallet.subjectVerified,
    });
    if (action === "enable" && !autoEnableAttempted.current) {
      autoEnableAttempted.current = true;
      handleEnable();
    } else if (action === "activate" && !autoActivateAttempted.current) {
      autoActivateAttempted.current = true;
      void handleActivate();
    }
    // handleEnable/handleActivate are stable-enough closures over current
    // state; the attempted-refs make re-runs no-ops regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    customAuth,
    wallet.ready,
    wallet.authenticated,
    wallet.subjectVerified,
    hasWallet,
    statusKnown,
    enabled,
    agentReady,
    isFunded,
    walletMismatch,
    walletIdentityBlocked,
  ]);

  // M5: bound custom-auth readiness, authentication, subject-verification,
  // and unfinished wallet-list waits. Once the wallet list has settled, a
  // missing embedded wallet stays on the existing recovery path.
  const waitingForCustomAuth =
    customAuth &&
    (!wallet.ready ||
      !wallet.authenticated ||
      (!wallet.subjectMismatch &&
        (!wallet.subjectVerified || (!embeddedAddress && !wallet.walletsReady))));
  const [customAuthTimedOut, setCustomAuthTimedOut] = useState(false);
  useEffect(() => {
    if (!waitingForCustomAuth) {
      setCustomAuthTimedOut(false);
      return;
    }
    if (customAuthTimedOut) return;
    const timer = setTimeout(() => {
      console.warn(
        "[perps] Privy custom-auth session did not become ready within " +
          `${CUSTOM_AUTH_WAIT_TIMEOUT_MS / 1000}s. The Privy dashboard may be ` +
          "missing the custom-auth (JWKS verification) configuration for this app.",
      );
      setCustomAuthTimedOut(true);
    }, CUSTOM_AUTH_WAIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waitingForCustomAuth, customAuthTimedOut]);

  const handleExport = async () => {
    setActivateError(null);
    if (enabled && !walletIdentityBound) {
      setActivateError(
        "The connected wallet does not match this perps account.",
      );
      return;
    }
    if (!walletSessionVerified) {
      setActivateError(
        "Your perps wallet session is not verified for this account. " +
          "Restore the wallet session before exporting.",
      );
      return;
    }
    if (walletMismatch) {
      setActivateError(
        "The connected wallet does not match this perps account.",
      );
      return;
    }
    try {
      await wallet.exportWallet();
    } catch (error) {
      setActivateError(
        error instanceof Error ? error.message : "Could not open the export flow.",
      );
    }
  };

  // Disconnect the Privy session (e.g. to switch to a different wallet/email).
  // Does NOT touch the Better Auth platform session.
  const handleDisconnect = async () => {
    setActivateError(null);
    try {
      await wallet.logout();
      // The JWT state-sync hook is mounted for the app lifetime. Reloading
      // after clearing Privy state gives it a clean mount and lets the current
      // Better Auth cookie authenticate the same user again without another
      // Google/email prompt.
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (error) {
      setActivateError(
        error instanceof Error ? error.message : "Could not disconnect.",
      );
    }
  };

  // Clear only Privy's stale browser session. In custom-auth mode the provider
  // then re-authenticates from the current Better Auth session; the server-side
  // perps account, master binding, balance, and agent are left untouched.
  const handleResetWalletSession = async () => {
    setSessionResetError(null);
    setIsResettingWalletSession(true);
    setCustomAuthTimedOut(false);
    try {
      await wallet.logout();
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (error) {
      setCustomAuthTimedOut(true);
      setSessionResetError(
        error instanceof Error
          ? error.message
          : "Could not reset the wallet session.",
      );
    } finally {
      setIsResettingWalletSession(false);
    }
  };

  // A local timer reset is useful for a transient delay, but it cannot repair
  // a stale Privy browser session. Expose both choices so an already-funded
  // account can recover wallet-management controls without touching its agent
  // or Hyperliquid balance.
  const customAuthTimeoutNotice = (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-destructive">
          Wallet-management session unavailable
        </p>
        <p className="text-xs text-muted-foreground">
          Your trading agent and Hyperliquid balance are still intact. Privy
          export does not require a previous export, but it does require the
          authenticated embedded-wallet session to be restored. A transient
          failure can be retried; a stale session can be reset without changing
          the wallet or account.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.reload();
            }
          }}
        >
          Try again
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleResetWalletSession()}
          disabled={isResettingWalletSession}
        >
          {isResettingWalletSession
            ? "Resetting wallet session..."
            : "Reset wallet session"}
        </Button>
      </div>
      {sessionResetError && (
        <p className="text-xs text-destructive">{sessionResetError}</p>
      )}
    </div>
  );

  // Read the embedded wallet's on-chain USDC + ETH balances so the deposit step
  // can gate its button (USDC >= min, ETH > 0 for gas). Refresh when the wallet
  // becomes ready and after a successful deposit lands (via `refreshWalletBalances`).
  // L2: depend on the ADDRESS only, not the whole `wallet` object (a fresh
  // object every render): with the rail's 10s status poll re-rendering the
  // card, a `wallet` dependency re-created this callback and re-fired the
  // balance effect below on every render, spamming the public RPC. Reads go
  // straight through readPerpsWalletBalancesByAddress (one call for both
  // balances), which only needs the address.
  const refreshWalletBalances = useCallback(async () => {
    if (!embeddedAddress || !walletIdentityBound) return;
    try {
      const balances = await readPerpsWalletBalancesByAddress(
        embeddedAddress as `0x${string}`,
      );
      setWalletUsdc(balances.usdc);
      setWalletEth(balances.eth);
    } catch {
      // Best-effort: a transient RPC read failure just leaves the button gated.
    }
  }, [embeddedAddress, walletIdentityBound]);

  useEffect(() => {
    // Only meaningful once perps are enabled and the wallet is connected.
    if (!enabled || !embeddedAddress || !walletIdentityBound) return;
    void refreshWalletBalances();
  }, [enabled, embeddedAddress, refreshWalletBalances, walletIdentityBound]);

  // Manual refresh: re-read hyperliquid.status (trading balance + agent state)
  // and the on-chain wallet balances WITHOUT a full page reload.
  const [isRefreshing, setIsRefreshing] = useState(false);
  // "Disconnect Wallet" detaches the perps wallet session, so it sits behind an
  // "Are you sure?" confirmation (doc #20c) before `handleDisconnect` runs.
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([statusQuery.refetch(), refreshWalletBalances()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [statusQuery, refreshWalletBalances]);

  const handleDeposit = async () => {
    setDepositError(null);
    if (enabled && !walletIdentityBound) {
      setDepositError(
        "The connected wallet does not match this perps account.",
      );
      return;
    }
    if (!walletSessionVerified) {
      setDepositError(
        "Your perps wallet session is not verified for this account. " +
          "Restore the wallet session before depositing.",
      );
      return;
    }
    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount < PERPS_MIN_USABLE_DEPOSIT_USDC) {
      setDepositError(`Enter at least ${PERPS_MIN_USABLE_DEPOSIT_USDC} USDC.`);
      return;
    }
    // Re-assert the wallet-match guard: never deposit from the wrong wallet.
    if (walletMismatch) {
      setDepositError(
        `You enabled perps with ${walletAddress}. Reconnect that wallet before depositing.`,
      );
      return;
    }
    // H1: same posture for a Privy-session/platform-user mismatch.
    if (wallet.subjectMismatch) {
      setDepositError(
        "Your perps wallet session belongs to a different account. " +
          "Sign out and back in before depositing.",
      );
      return;
    }
    setIsDepositing(true);
    const balanceBefore = balanceUsd;
    try {
      const walletClient = await wallet.getWalletClient();
      await depositUsdcToHyperliquid({ walletClient, amountUsdc: amount });
      setDepositAmount("");
      void refreshWalletBalances();
      // Poll HL status until the credited balance rises (bridge is async). Cap the
      // poll so a never-landing deposit doesn't spin forever; the 10s status poll
      // also keeps refreshing independently.
      const started = Date.now();
      const poll = async () => {
        const next = await trpcUtils.hyperliquid.status.fetch();
        const nextBalance = Number(next?.hlBalanceUsd ?? 0);
        if (nextBalance > balanceBefore) return;
        if (Date.now() - started > 120_000) return;
        setTimeout(() => void poll(), 5_000);
      };
      void poll();
    } catch (error) {
      setDepositError(
        error instanceof Error ? error.message : "Deposit failed. Please try again.",
      );
    } finally {
      setIsDepositing(false);
    }
  };

  const handleDismissEnabledDialog = () => {
    markPerpsEnabledDialogDismissed(
      typeof window !== "undefined" ? window.localStorage : null,
      walletAddress ?? embeddedAddress ?? null,
    );
    setShowEnabledDialog(false);
  };

  const dialogAddress = walletAddress ?? embeddedAddress ?? "";

  // H1: blocking warning for a Privy-session/platform-user mismatch (stale
  // custom-auth session on a shared browser). Mirrors the wallet-mismatch
  // warning; while shown, every auto action is blocked (subjectVerified is
  // false) and the manual handlers refuse to run.
  const subjectMismatchBanner = wallet.subjectMismatch ? (
    <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="font-medium">Wallet session mismatch</div>
      <p>
        Your perps wallet session belongs to a different account than the one
        you&apos;re signed in with, so automatic setup is paused. Sign out and
        back in to refresh the wallet session before continuing.
      </p>
    </div>
  ) : null;
  const subjectVerificationPendingBanner =
    !walletSessionVerified && !wallet.subjectMismatch ? (
      <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
        <div className="font-medium">
          Wallet session verification is still pending
        </div>
        <p>
          Funding, exporting, and signing are paused until Privy confirms this
          wallet belongs to the account you&apos;re signed in with.
        </p>
      </div>
    ) : null;
  const mismatchedSessionResetNotice = showMismatchedSessionReset ? (
    <div className="space-y-3">
      {subjectMismatchBanner}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Reset only the wallet session in this browser, then reconnect it to the
          account you&apos;re currently signed in with. Your Hyperliquid balance and
          trading agent stay unchanged.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleResetWalletSession()}
          disabled={isResettingWalletSession}
        >
          {isResettingWalletSession
            ? "Resetting wallet session..."
            : "Reset wallet session"}
        </Button>
        {sessionResetError && (
          <p className="text-xs text-destructive">{sessionResetError}</p>
        )}
      </div>
    </div>
  ) : null;

  return (
    <OnboardingShell variant={variant}>
      {/* STEP 1 - connect the Privy embedded wallet. In custom-auth mode there
          is nothing to connect, but a first-time user must explicitly choose
          whether to create a wallet or import an existing one. */}
      {statusQuery.isPending ? (
        <div className="text-sm text-muted-foreground">
          Checking your perps account...
        </div>
      ) : statusQuery.isError ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive">
            Could not load your perps account: {statusQuery.error.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void statusQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !wallet.ready ? (
        customAuth && customAuthTimedOut ? (
          customAuthTimeoutNotice
        ) : (
          <div className="text-sm text-muted-foreground">Loading wallet...</div>
        )
      ) : showMismatchedSessionReset ? (
        mismatchedSessionResetNotice
      ) : walletIdentityUnavailable ? (
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">
              Perps wallet identity unavailable
            </p>
            <p className="text-xs text-muted-foreground">
              This account is enabled, but its stored master address is missing
              or invalid. No wallet has been selected for this account. Funding,
              export, deposit, and signing are disabled. Contact support if the
              issue persists.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void statusQuery.refetch()}
          >
            Refresh account status
          </Button>
        </div>
      ) : !wallet.authenticated ? (
        customAuth ? (
          customAuthTimedOut ? (
            customAuthTimeoutNotice
          ) : (
            <div className="text-sm text-muted-foreground">
              Preparing your perps wallet…
            </div>
          )
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect to set up your self-custody perps wallet. Sign in with
              Google (or email) via Privy, then create a fresh wallet or import
              an existing private key.
            </p>
            <Button onClick={handleConnect}>Connect Perps Wallet</Button>
          </div>
        )
      ) : enabled && !embeddedAddress ? (
        customAuth && customAuthTimedOut ? (
          customAuthTimeoutNotice
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">Perps wallet unavailable</p>
            <p className="text-xs text-muted-foreground">
              The wallet session for this account is unavailable. Sign out and
              back in, then try again.
            </p>
          </div>
        )
      ) : !embeddedAddress ? (
        // Block create/import while the wallet list is still populating.
        // walletsReady can flip true before the embedded wallet entry appears
        // (race in Privy's useWallets hook), so showing the buttons too early
        // lets users hit "Create new wallet" when Privy already has one --
        // Privy then throws "User already has an embedded wallet." Previously
        // this guard was only applied in custom-auth mode, but the same race
        // exists in the manual-login path.
        !wallet.walletsReady ? (
          // In custom-auth mode the M5 timeout notice still needs to fire if
          // the wallet list is genuinely stuck (not just the brief catch-up
          // race). Without this check, customAuthTimedOut flips to true
          // internally but nothing in this branch reads it, so the user is
          // left on "Preparing your wallet choices…" forever instead of seeing
          // the Retry / Reset session escape hatch.
          customAuth && customAuthTimedOut ? (
            customAuthTimeoutNotice
          ) : (
            <div className="text-sm text-muted-foreground">
              Preparing your wallet choices…
            </div>
          )
        ) : customAuth &&
        (wallet.subjectMismatch || !wallet.subjectVerified) ? (
          // A stale Privy session for a different user blocks create/import
          // until the current user's wallet-management session is verified.
          subjectMismatchBanner ??
          (customAuthTimedOut ? (
            customAuthTimeoutNotice
          ) : (
            <div className="text-sm text-muted-foreground">
              Preparing your wallet choices…
            </div>
          ))
        ) : (
          <div className="space-y-3">
            {walletMode === "choose" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Set up your self-custody perps wallet: create a fresh one (new
                  key, nothing to manage) or bring an existing wallet by importing
                  its private key into Privy&apos;s secure enclave.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleCreateWallet} disabled={walletBusy}>
                    {walletBusy ? "Creating…" : "Create new wallet"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setWalletError(null);
                      setWalletMode("import");
                    }}
                    disabled={walletBusy}
                  >
                    Import existing wallet
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Private key
                </Label>
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="0x… (32-byte hex)"
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Your key goes directly to Privy and is sealed in its enclave -
                  never sent to our servers. Import an EOA you control (e.g.
                  exported from MetaMask).
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={handleImportWallet}
                    disabled={walletBusy || importKey.trim().replace(/^0x/, "").length !== 64}
                  >
                    {walletBusy ? "Importing…" : "Import wallet"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setImportKey("");
                      setWalletError(null);
                      setWalletMode("choose");
                    }}
                    disabled={walletBusy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {walletError && (
              <p className="text-sm text-destructive">{walletError}</p>
            )}
          </div>
        )
      ) : (
        <div className="space-y-4">
          {/* H1: Privy-session/platform-user mismatch warning (blocks all
              auto and manual actions until the sessions agree). */}
          {subjectMismatchBanner}
          {subjectVerificationPendingBanner}
          {customAuth &&
            customAuthTimedOut &&
            !wallet.subjectMismatch &&
            !wallet.subjectVerified &&
            customAuthTimeoutNotice}

          {/* NEW-1: persistent mismatch warning. The connected embedded wallet
              is NOT the master perps were enabled with - deposits/activation
              here would target the wrong account. */}
          {walletMismatch && (
            <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <div className="font-medium">Wrong wallet connected</div>
              <p>
                Perps were enabled with{" "}
                <code className="font-mono text-xs">{walletAddress}</code>, but
                you&apos;re connected as{" "}
                <code className="font-mono text-xs">{embeddedAddress}</code>.
                Sign out and back in before depositing or activating.
              </p>
            </div>
          )}

          {/* Wallet address (the CONNECTED embedded wallet - no papered-over
              fallback: we always show the live wallet, and flag a mismatch via
              the banner above). */}
          {!walletMismatch && (
            <div className="space-y-1">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Wallet address
              </Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">
                  {embeddedAddress}
                </code>
                {walletSessionVerified && (
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* STEP 2 - enable perps (provision the agent) once, when not yet enabled.
              Custom-auth mode auto-runs this; the button doubles as the retry. */}
          {!enabled ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {customAuth && enableMutation.isPending
                  ? "Setting up perps: provisioning your trading agent…"
                  : "Enable perpetual futures to provision your trading agent."}
              </p>
              {enableMutation.isError && (
                <p className="text-sm text-destructive">
                  {enableMutation.error.message}
                </p>
              )}
              {(!customAuth || enableMutation.isError) && (
                <Button
                  onClick={handleEnable}
                  disabled={enableMutation.isPending || !walletSessionVerified}
                >
                  {enableMutation.isPending
                    ? "Provisioning..."
                    : customAuth
                      ? "Retry setup"
                      : "Enable Perps"}
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Balance + funding state. Two DISTINCT balances, spelled out so
                  it's never ambiguous which money is where:
                    1. On Hyperliquid = the perps TRADING balance (deposited).
                    2. In your wallet = on-chain Arbitrum USDC that is NOT yet on
                       Hyperliquid (plus a little ETH for gas). */}
              <div className="space-y-2.5 rounded-md border bg-muted/30 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      On Hyperliquid · trading balance
                    </div>
                    <div className="font-data text-lg font-semibold tabular-nums">
                      {formatUsd(status?.hlBalanceUsd ?? null)}
                    </div>
                    <div className="text-2xs text-muted-foreground">
                      Your buying power for perps.
                    </div>
                  </div>
                  <Badge
                    variant={
                      agentReady ? "default" : isFunded ? "default" : "secondary"
                    }
                  >
                    {agentReady
                      ? "Active"
                      : isFunded
                        ? "Funded"
                        : "Funding pending"}
                  </Badge>
                </div>
                {!walletMismatch && shouldShowPendingDeposit(walletUsdc) && (
                  <div className="border-t pt-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      In your wallet · Arbitrum
                    </div>
                    <div className="font-data text-sm tabular-nums">
                      {walletUsdc != null ? walletUsdc.toFixed(2) : "-"} USDC
                    </div>
                    <div className="text-2xs text-muted-foreground">
                      Not trading yet - deposit below to move it onto Hyperliquid.
                    </div>
                  </div>
                )}
              </div>

              {/* Wallet-management actions with a clear variant hierarchy (doc
                  #20a): Refresh (neutral) / Export (secondary) / Disconnect
                  (danger). "Fund Wallet" was dropped as redundant with the
                  "Copy address" affordance in the fund section below.
                  No Disconnect in custom-auth mode: the Privy session follows
                  the platform login, so a logout would immediately re-sync. */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={perpsWalletActionVariant("refresh")}
                  size="sm"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing…" : "Refresh"}
                </Button>
                {!walletMismatch &&
                  (canExportWallet ? (
                    <Button
                      variant={perpsWalletActionVariant("export")}
                      size="sm"
                      onClick={handleExport}
                    >
                      Export Private Key
                    </Button>
                  ) : (
                    <p className="self-center text-xs text-muted-foreground">
                      Restore the verified wallet session to export this key.
                    </p>
                  ))}
                {!customAuth && (
                  <Button
                    variant={perpsWalletActionVariant("disconnect")}
                    size="sm"
                    onClick={() => setDisconnectOpen(true)}
                  >
                    Disconnect Wallet
                  </Button>
                )}
              </div>

              {/* How to fund: multi-chain funding options (Arbitrum, Solana via Unit, Ethereum). */}
              {!walletMismatch && walletSessionVerified && (
                <div className="space-y-3 rounded-md border bg-muted/20 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">How to fund your account</div>
                    <div className="flex rounded-md border bg-muted/50 p-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setFundingChain("arbitrum")}
                        className={`rounded px-2.5 py-1 font-medium transition-colors ${
                          fundingChain === "arbitrum"
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Arbitrum (USDC)
                      </button>
                      <button
                        type="button"
                        onClick={() => setFundingChain("solana")}
                        className={`rounded px-2.5 py-1 font-medium transition-colors ${
                          fundingChain === "solana"
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Solana (SOL - Spot)
                      </button>
                      <button
                        type="button"
                        onClick={() => setFundingChain("ethereum")}
                        className={`rounded px-2.5 py-1 font-medium transition-colors ${
                          fundingChain === "ethereum"
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Ethereum (ETH)
                      </button>
                    </div>
                  </div>

                  {fundingChain === "arbitrum" && (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        Send <span className="font-medium text-foreground">native USDC on Arbitrum</span>{" "}
                        (native Circle USDC, not bridged USDC.e, and not USDC on any other
                        chain) directly to your wallet address below from any exchange or
                        wallet. Once it lands, deposit it onto Hyperliquid below.
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">
                          {embeddedAddress}
                        </code>
                        <Button variant="outline" size="sm" onClick={handleCopy}>
                          {copied ? "Copied" : "Copy address"}
                        </Button>
                      </div>
                    </div>
                  )}

                  {fundingChain === "solana" && (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Send <span className="font-medium text-foreground">native SOL</span> from Phantom, Solflare, or any exchange to your dedicated Unit deposit address below. Unit credits your deposit as <span className="font-medium text-foreground">native SOL in your Hyperliquid Spot account</span>.
                      </p>

                      <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
                        <div className="font-semibold flex items-center gap-1.5 text-amber-900 dark:text-amber-100">
                          <span>⚠️</span> Spot Deposit Notice (Does not fund Perps directly)
                        </div>
                        <p>
                          Perpetual trading on Ready Set Trade requires <strong>USDC margin</strong>. Unit deposits arrive as <strong>Spot SOL</strong> on Hyperliquid, so your perps balance will remain zero and automatic activation will not run until the funds are converted.
                        </p>
                        <p>
                          To trade perps with these funds, you must manually log in to{" "}
                          <a
                            href="https://app.hyperliquid.xyz"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline font-medium hover:text-foreground"
                          >
                            app.hyperliquid.xyz
                          </a>
                          , sell your Spot SOL for USDC on the spot market, and transfer that USDC to your perps account.
                        </p>
                        <p className="font-medium text-amber-950 dark:text-amber-100 pt-0.5">
                          💡 Direct perps route: Select <strong>Arbitrum (USDC)</strong> above to deposit USDC margin directly without manual conversions.
                        </p>
                      </div>

                      {solFundingQuery.isLoading ? (
                        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                          Generating your dedicated Solana deposit address…
                        </div>
                      ) : solFundingQuery.data?.depositAddress ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">
                              {solFundingQuery.data.depositAddress}
                            </code>
                            <Button variant="outline" size="sm" onClick={handleCopySol}>
                              {copiedSol ? "Copied" : "Copy SOL address"}
                            </Button>
                          </div>
                          <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground">
                            <span>Route: Unit (Solana → Hyperliquid Spot balance)</span>
                            {solFundingQuery.data.fee && (
                              <span>Estimated deposit fee: ~{solFundingQuery.data.fee} SOL</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1 text-xs text-destructive">
                          <p>{solFundingQuery.data?.error || "Could not load Solana deposit address. Please try again."}</p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void solFundingQuery.refetch()}
                          >
                            Retry
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {fundingChain === "ethereum" && (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        To fund with <span className="font-medium text-foreground">native ETH on Ethereum</span>, swap or bridge your ETH to native USDC on Arbitrum, or use a cross-chain route provider (e.g. <a href="https://trade.xyz" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">trade.xyz</a> or the Hyperliquid bridge).
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Native ETH cannot be sent directly to the Arbitrum USDC contract. Once bridged to your address on Arbitrum or Hyperliquid, funds become available in your trading balance.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* STEP 3 - deposit native USDC (Arbitrum) into the HL bridge.
                  Sits between funding the wallet (direct USDC transfer above)
                  and activation below. Gated on a wallet USDC balance >= the min
                  and on having some ETH for gas. */}
              {!walletMismatch && (
                <div className="space-y-2 rounded-md border bg-muted/20 px-3 py-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      Deposit to Hyperliquid
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      Wallet:{" "}
                      {walletUsdc != null
                        ? `${walletUsdc.toFixed(2)} USDC`
                        : "-"}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Move native USDC from your wallet into Hyperliquid. Minimum{" "}
                    {PERPS_MIN_USABLE_DEPOSIT_USDC} USDC, because copy trading
                    skips any mirrored order worth less than{" "}
                    {formatUsd(MIRROR_MIN_ORDER_NOTIONAL_USD)}.{" "}
                    {PERPS_SUGGESTED_DEPOSIT_USDC} USDC is suggested so you have
                    room for more than one.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={PERPS_MIN_USABLE_DEPOSIT_USDC}
                      step="0.01"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder={`${PERPS_SUGGESTED_DEPOSIT_USDC}`}
                      className="w-32"
                      disabled={isDepositing}
                    />
                    <Button
                      onClick={handleDeposit}
                      disabled={
                        isDepositing ||
                        !walletSessionVerified ||
                        walletMismatch ||
                        Number(depositAmount) < PERPS_MIN_USABLE_DEPOSIT_USDC ||
                        !Number.isFinite(Number(depositAmount)) ||
                        (walletUsdc != null &&
                          walletUsdc < Number(depositAmount)) ||
                        walletEth === 0
                      }
                    >
                      {isDepositing ? "Depositing..." : "Deposit USDC"}
                    </Button>
                  </div>
                  {walletEth === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      You need a little ETH on Arbitrum for gas before you can
                      deposit.
                    </p>
                  )}
                  {walletSessionVerified &&
                    walletUsdc != null &&
                    walletUsdc < PERPS_MIN_USABLE_DEPOSIT_USDC && (
                      <p className="text-xs text-muted-foreground">
                        Fund your wallet with at least{" "}
                        {PERPS_MIN_USABLE_DEPOSIT_USDC} USDC (see How to fund your
                        wallet above), then deposit.
                      </p>
                    )}
                  {depositError && (
                    <p className="text-sm text-destructive">{depositError}</p>
                  )}
                </div>
              )}

              {/* STEP 4 - activate trading (client-signed approveAgent). In
                  custom-auth mode this auto-runs once funded (the signature is
                  popup-free); the button stays as a manual fallback/retry. */}
              {!walletMismatch && (!agentReady ? (
                <div className="space-y-2 rounded-md border bg-muted/20 px-3 py-3">
                  <div className="text-sm font-medium">Activate trading</div>
                  <p className="text-sm text-muted-foreground">
                    {customAuth
                      ? isFunded
                        ? "Activating your trading agent automatically…"
                        : "Trading activates automatically once your deposit lands on Hyperliquid."
                      : isFunded
                        ? "Approve your trading agent to start placing orders. This is a one-time signature."
                        : "Fund your wallet with USDC (Arbitrum), then approve your trading agent. Activation needs a funded wallet."}
                  </p>
                  {(!customAuth || activateError) && (
                    <Button
                      onClick={handleActivate}
                      disabled={!walletSessionVerified || !isFunded || isActivating}
                    >
                      {isActivating ? "Activating..." : "Activate Trading"}
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Your trading agent is active. Open the perps terminal to trade.
                </p>
              ))}
            </>
          )}

          {activateError && (
            <p className="text-sm text-destructive">{activateError}</p>
          )}
        </div>
      )}

      {/* ONE-TIME success popup (custom-auth flow): deposit address + funding
          instructions, persisted per wallet so it shows exactly once. */}
      <AlertDialog
        open={showEnabledDialog && walletIdentityBound}
        onOpenChange={(open) => {
          if (!open) handleDismissEnabledDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Perps enabled</AlertDialogTitle>
            <AlertDialogDescription>
              Your self-custody perps wallet is ready. Send USDC on Arbitrum to
              this address. Funds appear after confirmation. After funding,
              your wallet automatically authorizes a server-side trading agent
              (it can only trade, never withdraw) and a platform builder fee of
              up to{" "}
              <span className="font-medium">
                {enableResult?.builderMaxFeeRate ?? "0.1%"}
              </span>{" "}
              per order. No further signature prompts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">
              {dialogAddress}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(dialogAddress).catch(() => {});
              }}
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send native Circle USDC on Arbitrum only (not USDC.e, not another
            chain).
          </p>
          <AlertDialogFooter>
            <AlertDialogAction onClick={handleDismissEnabledDialog}>
              Got it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect confirmation (doc #20c). The Disconnect button only OPENS
          this; `handleDisconnect` runs solely from the confirm action, so a
          stray click cannot detach the wallet session. */}
      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{PERPS_DISCONNECT_CONFIRM.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {PERPS_DISCONNECT_CONFIRM.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDisconnectOpen(false);
                void handleDisconnect();
              }}
            >
              {PERPS_DISCONNECT_CONFIRM.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </OnboardingShell>
  );
}
