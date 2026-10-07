import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";
import type { SizingMode } from "./mirror-sizing";

export type MirrorDestination = "stock" | "perp";
export type MirrorDestinationProvider = "alpaca" | "hyperliquid";

/** The shape accepted by the independent-destination follow contract. */
export interface MirrorDestinationConfig {
  enabled: boolean;
  credentialId: string | null;
  /** Exact, non-secret label returned by the server for the saved credential. */
  credentialAccountLabel?: string | null;
  sizingMode: SizingMode;
  sizingValue: number;
}

export const DESTINATION_PRESENTATION: Record<
  MirrorDestination,
  {
    label: string;
    orderNoun: string;
    provider: MirrorDestinationProvider;
    venue: string;
    description: string;
  }
> = {
  stock: {
    label: "Stocks",
    orderNoun: "stock",
    provider: "alpaca",
    venue: "Alpaca stocks and options",
    description: "Equities and options",
  },
  perp: {
    label: "Perps",
    orderNoun: "perp",
    provider: "hyperliquid",
    venue: "Hyperliquid perpetuals",
    description: "Leveraged perpetuals",
  },
};

export interface AlpacaAccountOption {
  id: string;
  provider: "alpaca" | "hyperliquid";
  accountId: string | null;
  accountType: "PAPER" | "LIVE";
  /** Exact, non-secret label returned by the server when available. */
  credentialAccountLabel?: string | null;
}

/**
 * Narrow `userSettings.hasApiCredentials` rows to the destinations a follow can
 * actually be pointed at. Shared so the panel and Manage follows resolve the
 * same destination venue for the same credential.
 */
export function toAccountOptions(
  rows: ReadonlyArray<{
    id: string;
    provider: string;
    accountId: string | null;
    accountType: string | null;
    credentialAccountLabel?: string | null;
    needsReentry?: boolean | null;
  }>,
): AlpacaAccountOption[] {
  return rows.flatMap((account) =>
    (account.provider === "alpaca" || account.provider === "hyperliquid") &&
    (account.accountType === "PAPER" || account.accountType === "LIVE") &&
    !(account.provider === "alpaca" && account.needsReentry === true)
      ? [
          {
            id: account.id,
            provider: account.provider,
            accountId: account.accountId,
            accountType: account.accountType,
            credentialAccountLabel: account.credentialAccountLabel ?? null,
          },
        ]
      : [],
  );
}

/** Return the client-safe display name for one saved Alpaca account. */
export function accountOptionLabel(account: AlpacaAccountOption): string {
  if (account.credentialAccountLabel) return account.credentialAccountLabel;
  if (account.provider === "hyperliquid") return "Hyperliquid perps";
  const kind = account.accountType === "LIVE" ? "Live" : "Paper";
  return account.accountId ? `${kind} account ${account.accountId}` : `${kind} account`;
}

/** Keep each destination's account picker limited to its own provider. */
export function accountsForDestination(
  destination: MirrorDestination,
  accounts: readonly AlpacaAccountOption[],
): AlpacaAccountOption[] {
  const provider = DESTINATION_PRESENTATION[destination].provider;
  return accounts.filter((account) => account.provider === provider);
}

/** Resolve only a credential that is both present and provider-compatible. */
export function accountForDestination(
  destination: MirrorDestination,
  credentialId: string | null,
  accounts: readonly AlpacaAccountOption[],
): AlpacaAccountOption | null {
  if (!credentialId) return null;
  return (
    accountsForDestination(destination, accounts).find((account) => account.id === credentialId) ??
    null
  );
}

/** Build the partial contract update for exactly one venue. */
export function buildDestinationPatch(
  destination: MirrorDestination,
  config: MirrorDestinationConfig,
) {
  return { destinations: { [destination]: config } } as const;
}

/** Target types the worker can mirror on each independent destination. */
export function destinationSupportsTarget(
  destination: MirrorDestination,
  targetType: "x_author" | "user" | "politician" | "hl_wallet",
): boolean {
  if (targetType === "politician") return false;
  if (targetType === "hl_wallet") return destination === "perp";
  return true;
}

/**
 * Which venue a follow's currently selected destination belongs to.
 *
 * Prefers the live accounts list so the answer changes the moment the user
 * picks a different account, before the follow row has round-tripped through
 * the API. `fallback` is the provider the server last recorded for this follow,
 * used while the accounts query is still loading. Returns null when the
 * destination is unknown, which callers must treat as "do not claim it is
 * Alpaca": an unknown destination gets no venue-specific reassurance.
 */
export function selectedAccountProvider(input: {
  credentialId: string | null;
  accounts: readonly AlpacaAccountOption[];
  fallback: "alpaca" | "hyperliquid" | null;
}): "alpaca" | "hyperliquid" | null {
  if (!input.credentialId) return null;
  const match = input.accounts.find((account) => account.id === input.credentialId);
  return match?.provider ?? input.fallback;
}

/** Build a fail-closed auto-mirror update bound to one selected credential. */
export function buildAutoMirrorPatch(autoMirror: boolean, credentialId: string | null) {
  if (!autoMirror) return { autoMirror: false } as const;
  if (!credentialId) return null;
  return { autoMirror: true, credentialId } as const;
}

export interface AutoMirrorSwitchState {
  interactive: boolean;
  /**
   * Why the switch cannot be used AND what to do about it, or null when it is
   * usable. A control that is greyed out with no explanation is the reason the
   * audit found users unable to tell "not supported" from "you forgot a step".
   */
  reason: string | null;
}

function validGlobalPerpMaxLeverage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COPY_PERP_MAX_LEVERAGE_MIN &&
    value <= COPY_PERP_MAX_LEVERAGE_MAX
  );
}

/**
 * Whether the auto-mirror switch is interactive, and if not, why.
 *
 * Ordering matters. A follow that is already armed must ALWAYS be switchable
 * off, so that case is resolved before any of the blocks that only apply to
 * arming: a deployment problem or a missing account must never trap a user in
 * live automation they are trying to stop.
 */
export function autoMirrorSwitchState(input: {
  supported: boolean;
  pending: boolean;
  autoMirror: boolean;
  credentialId: string | null;
  /** The resolved venue for this follow's selected destination. */
  destinationProvider?: "alpaca" | "hyperliquid" | null;
  /** The user-owned global cap; absent/invalid means it has not loaded safely. */
  globalPerpMaxLeverage?: number | null;
  /** Human name of the follow's source type, for the unsupported message. */
  targetLabel?: string;
  /** Deployment-level block, from `describeMirrorDeployment().blockReason`. */
  deploymentBlockReason?: string | null;
  /** True when the row's sizing value is outside the mode's accepted bounds. */
  sizingInvalid?: boolean;
  /** A destination-specific sizing rule that the worker cannot execute. */
  sizingBlockReason?: string;
  /** False when the selected credential is not present in the user-owned list. */
  credentialAvailable?: boolean;
  /** True when a saved destination-specific leverage ceiling is invalid. */
  leverageInvalid?: boolean;
}): AutoMirrorSwitchState {
  if (!input.supported) {
    const label = input.targetLabel ?? "this kind of";
    return {
      interactive: false,
      reason: `Auto-mirror is not available for ${label} follows yet. Nothing will be placed from this follow.`,
    };
  }
  if (input.pending) {
    return { interactive: false, reason: "Saving your last change." };
  }
  // Stopping is never blocked. See the ordering note above. An armed row can
  // still have lost its destination (deleting a saved credential sets
  // credentialId to null via onDelete: "set null" while autoMirror stays
  // true), and in that state the worker silently refuses every delivery, so
  // the switch must say so instead of showing the normal "on your
  // confirmation" caption. It must still stay interactive so the user is
  // never trapped: they can only turn it off, or pick a new account below to
  // resume, not turn it "more on".
  if (input.autoMirror) {
    return {
      interactive: true,
      reason: !input.credentialId
        ? "This follow's mirror account was removed. Nothing is being placed: pick an account below to resume."
        : input.credentialAvailable === false
          ? "This follow's mirror account is unavailable. Nothing is being placed: choose an account below to resume."
          : null,
    };
  }

  // A Hyperliquid follow is a leveraged real-money destination. Do not let an
  // unarmed row grant standing permission while the user-owned global ceiling
  // is still loading, errored, or malformed. This check deliberately comes
  // after the armed-row branch above: losing access to the settings query must
  // never trap an already armed row and prevent the user from stopping it.
  if (
    input.destinationProvider === "hyperliquid" &&
    !validGlobalPerpMaxLeverage(input.globalPerpMaxLeverage)
  ) {
    return {
      interactive: false,
      reason:
        "A valid global copy-trading leverage cap must load before arming a Hyperliquid follow.",
    };
  }
  if (input.destinationProvider === "hyperliquid" && input.leverageInvalid) {
    return {
      interactive: false,
      reason:
        "The saved per-follow leverage cap is invalid for the current global cap. Fix it before arming.",
    };
  }

  if (input.deploymentBlockReason) {
    return { interactive: false, reason: input.deploymentBlockReason };
  }
  if (!input.credentialId) {
    return {
      interactive: false,
      reason:
        "Choose a mirror account above first. Auto-mirror needs a destination before it can place an order.",
    };
  }
  if (input.credentialAvailable === false) {
    return {
      interactive: false,
      reason:
        "That mirror account is unavailable. Choose a user-owned account for this destination before arming.",
    };
  }
  if (input.sizingBlockReason) {
    return { interactive: false, reason: input.sizingBlockReason };
  }
  if (input.sizingInvalid) {
    return {
      interactive: false,
      reason: "Fix the sizing value above first: it is outside the accepted range.",
    };
  }
  return { interactive: true, reason: null };
}

/** A destination as an arming confirmation has to state it: id, name, mode. */
export interface MirrorArmingDestination {
  credentialId: string | null;
  /** How the account is named in the confirmation, or null when unresolved. */
  accountLabel: string | null;
  accountType: "PAPER" | "LIVE" | null;
}

/** The follow fields that decide where an arming request is aimed. */
export interface ArmingFollowRow {
  autoMirror: boolean;
  credentialId: string | null;
  credentialAccountLabel: string | null;
  credentialAccountType: "PAPER" | "LIVE" | null;
}

/**
 * The account a surface with only the plain "arm" confirmation may aim at.
 *
 * THE FOLLOW'S OWN DESTINATION WINS WHENEVER IT HAS ONE. Moving an armed or
 * armable follow to another account is a re-point, and a re-point has to be
 * disclosed as one: `buildArmingSummary`'s "repoint" variant adds a "Moving
 * from" fact, names the venue being moved to, and swaps in
 * REPOINT_STOP_CAVEAT, because the API keeps auto-mirror on for any non-null
 * credential and the WORKER reads a changed credential as consent withdrawn
 * for anything already staged. The feed panel's inline switch raises the plain
 * "arm" variant and has nowhere to put any of that, so it is not allowed to
 * move a follow at all: it arms where the user already pointed it in Manage
 * follows. copy-trade-info-dialog.tsx promises exactly this to the user, that
 * changing the terminal's Paper/Live mode does not retarget an existing
 * Mirror, and this is where that promise is kept. It used to be broken here:
 * an unarmed follow took the terminal header's selected credential, so a
 * follow deliberately left on Paper was armed, silently, against Live.
 *
 * The terminal's account is borrowed ONLY by a follow that points nowhere,
 * where there is no saved destination to move off and nothing to disclose.
 *
 * The label and the Paper/Live mode are resolved from the same credential the
 * id names, never from a different one, so the confirmation cannot describe an
 * account the order will not reach. The accounts list is preferred for the
 * borrowed case because the panel's own label is a bare account number
 * ("920123456"), which reads identically for a paper and a live account.
 */
export function armingDestination(input: {
  follow: ArmingFollowRow;
  accounts: readonly AlpacaAccountOption[];
  activeCredentialId: string | null;
  activeAccountLabel: string | null;
  activeAccountType: "PAPER" | "LIVE" | null;
}): MirrorArmingDestination {
  // An armed follow is described by its own row even when that row carries no
  // credential (a legacy invalid row), so the switch that stops it never
  // reports some other account as the one it is stopping.
  if (input.follow.autoMirror || input.follow.credentialId) {
    const saved = input.accounts.find(
      (account) => account.id === input.follow.credentialId,
    );
    return {
      credentialId: input.follow.credentialId,
      accountLabel:
        input.follow.credentialAccountLabel ??
        (saved ? accountOptionLabel(saved) : null),
      accountType: input.follow.credentialAccountType ?? saved?.accountType ?? null,
    };
  }

  const activeCredentialId = input.activeCredentialId ?? null;
  const active = activeCredentialId
    ? input.accounts.find((account) => account.id === activeCredentialId)
    : undefined;
  return {
    credentialId: activeCredentialId,
    accountLabel: active ? accountOptionLabel(active) : input.activeAccountLabel ?? null,
    accountType: active?.accountType ?? input.activeAccountType ?? null,
  };
}
