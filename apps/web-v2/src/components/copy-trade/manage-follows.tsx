"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertCircle, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DESTINATION_PRESENTATION,
  accountForDestination,
  accountOptionLabel,
  accountsForDestination,
  autoMirrorSwitchState,
  buildDestinationPatch,
  buildAutoMirrorPatch,
  destinationSupportsTarget,
  selectedAccountProvider,
  type MirrorDestination,
  type MirrorDestinationConfig,
  type AlpacaAccountOption,
} from "./account-targeting";
import { PerpMirrorDisclosure } from "./perp-mirror-disclosure";
import { AutoMirrorSwitch } from "./auto-mirror-switch";
import { DEFAULT_MIRROR_MAX_ORDER_DOLLARS } from "@trade-bot/api/lib/copy-mirror";
import { ArmMirrorDialog, StopMirrorDialog } from "./mirror-consent-dialogs";
import {
  buildArmingSummary,
  buildDestinationArmingSummary,
  buildDestinationStopSummary,
  buildStopSummary,
  describeMirrorDeployment,
  markDestinationStop,
  markDestinationClear,
  followTargetTypeLabel,
  resolveMirrorLimits,
  type MirrorLimits,
} from "./mirror-consent";
import {
  describePerpProtection,
  describeSizePerOrder,
  PERP_PROTECTION_PRESENTATION,
  SIZING_MODE_PRESENTATION,
  type PerpProtectionRuleView,
  type SizingMode,
} from "./mirror-sizing";
import { SizingModeTabs } from "./sizing-mode-tabs";
import { useManageFollows, type FollowItem } from "./use-manage-follows";
import {
  useManageFollowsState,
  resolveFollowDestination,
  type DestinationDraftChange,
  type DestinationDrafts,
  type DestinationFollowDraft,
} from "./use-manage-follows-state";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";
import type { ArmingSummary } from "./mirror-consent";

/**
 * Fallback per-order ceiling used only for the row's projection when the
 * deployment reports no ceiling of its own.
 *
 * Imported rather than re-typed: this is the worker's compiled-in default, and a
 * local copy of the literal would go stale silently the day that default moves,
 * showing every follower a ceiling their orders are not actually held to. The
 * module is dependency-free and holds only pure sizing constants and decisions,
 * so it is safe to pull into a client component.
 */
const DEFAULT_PER_ORDER_CEILING = DEFAULT_MIRROR_MAX_ORDER_DOLLARS;

function validPerpLeverage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COPY_PERP_MAX_LEVERAGE_MIN &&
    value <= COPY_PERP_MAX_LEVERAGE_MAX
  );
}

/**
 * Add the user-owned ceiling to the exact arming summary for one follow.
 * Keeping this at the manage-follows boundary lets the shared arming dialog
 * stay venue-agnostic while the follow row supplies the two policy values it
 * actually controls.
 */
export function buildFollowArmingSummary(
  summary: ArmingSummary,
  globalPerpMaxLeverage: number | null,
  followPerpMaxLeverage: number | null,
): ArmingSummary {
  const global = validPerpLeverage(globalPerpMaxLeverage)
    ? globalPerpMaxLeverage
    : null;
  const follow =
    followPerpMaxLeverage == null
      ? null
      : validPerpLeverage(followPerpMaxLeverage)
        ? followPerpMaxLeverage
        : COPY_PERP_MAX_LEVERAGE_MIN;
  const effective = global === null ? null : Math.min(global, follow ?? global);
  const value =
    effective === null
      ? "Unavailable until the global copy-trading cap loads."
      : `${effective}x maximum for automatic perp copies. Leaders and markets may use less.`;
  const facts = [...summary.facts];
  const sizeIndex = facts.findIndex((fact) => fact.label === "Size per order");
  const leverageFact = { label: "Perp leverage ceiling", value };
  facts.splice(sizeIndex < 0 ? facts.length : sizeIndex + 1, 0, leverageFact);
  return { ...summary, facts };
}

function estimateProjectedDollars(
  mode: SizingMode,
  value: number,
  buyingPower: number,
  equity: number,
): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (mode === "pct") {
    if (!Number.isFinite(buyingPower) || buyingPower <= 0) return null;
    return (Math.min(value, 100) / 100) * buyingPower;
  }
  if (mode === "pct_equity") {
    if (!Number.isFinite(equity) || equity <= 0) return null;
    return (Math.min(value, 100) / 100) * equity;
  }
  if (mode === "usd") return value;
  // ratio: dollars depend on per-source price, not knowable here.
  return null;
}

/** The two exit legs, in the order the row shows them. */
const PERP_PROTECTION_LEGS = ["stopLoss", "takeProfit"] as const;
type PerpProtectionLeg = (typeof PERP_PROTECTION_LEGS)[number];

/** One row's uncommitted exit inputs, as typed. */
export type PerpProtectionDraft = Record<PerpProtectionLeg, string>;

/**
 * Is what is typed in one exit box something the router would reject?
 *
 * An EMPTY box is not invalid, it is the way a follower removes a leg, and this
 * is the whole reason the two are distinguished all the way down to the column:
 * the router treats an absent field as "leave it alone" and an explicit null as
 * "remove it", so the row has to be able to say the second.
 */
function protectionDraftInvalid(
  draft: string,
  bounds: { min: number; max: number },
): boolean {
  if (draft.trim() === "") return false;
  const value = Number(draft);
  return !Number.isFinite(value) || value < bounds.min || value > bounds.max;
}

/** The exit a follow has SAVED, or null when it has none. */
function savedPerpProtection(follow: FollowItem): PerpProtectionRuleView | null {
  if (follow.perpTakeProfitPct === null && follow.perpStopLossPct === null) return null;
  return {
    takeProfitPct: follow.perpTakeProfitPct,
    stopLossPct: follow.perpStopLossPct,
  };
}

/** The saved exit rendered back into the inputs, empty meaning "not set". */
export function perpProtectionDraftFor(follow: FollowItem): PerpProtectionDraft {
  return {
    stopLoss: follow.perpStopLossPct === null ? "" : String(follow.perpStopLossPct),
    takeProfit: follow.perpTakeProfitPct === null ? "" : String(follow.perpTakeProfitPct),
  };
}

/**
 * What a row is asking to have confirmed, before the follow is attached.
 *
 * `repoint` carries the credential the user just picked. It has to: the follow
 * row still holds the OLD one, so re-reading the destination off the follow at
 * confirm time would summarise, and then mutate to, the wrong account.
 */
export type ConsentAsk =
  | { kind: "arm" }
  | { kind: "disarm" }
  | { kind: "unfollow" }
  | { kind: "clear-account" }
  | { kind: "repoint"; credentialId: string }
  | { kind: "destination-arm"; destination: MirrorDestination }
  | { kind: "destination-disarm"; destination: MirrorDestination }
  | { kind: "destination-clear"; destination: MirrorDestination }
  | { kind: "destination-repoint"; destination: MirrorDestination; credentialId: string };

/** Which confirmation a row has asked for, and about which follow. */
type ConsentRequest = { ask: ConsentAsk; follow: FollowItem };

/**
 * "Manage follows" surface - a dropdown listing the user's follows from
 * copyTradeFollows.list. Each row exposes:
 *   - an auto-mirror toggle (calls .update { autoMirror }) behind a
 *     confirmation that states the trader, account, size, caps, that orders are
 *     placed without asking again, and what stopping later does not do,
 *   - a sizing override (mode + value -> .update),
 *   - a destination picker (.update { credentialId }), which on an ARMED follow
 *     is behind a confirmation either way: picking another account re-points
 *     live automation (the API keeps auto-mirror on for any non-null credential,
 *     and the worker counts the destination as part of the consent), and picking
 *     "No account" stops it (the API force-disarms on an explicit null),
 *   - an unfollow control (.unfollow), also behind a confirmation.
 * Every mutation invalidates the follows list so the panel's Follow buttons
 * and the Following view stay in sync.
 *
 * The confirmations are mounted HERE, not inside the row, and deliberately
 * outside DropdownMenuContent: opening a modal moves focus out of the menu,
 * the menu dismisses on focus-outside, and a dialog rendered inside it would
 * be unmounted by its own opening.
 */
export function ManageFollows({
  isSignedIn,
  buyingPower = 0,
  equity = 0,
  balancesCredentialId = null,
}: {
  isSignedIn: boolean;
  buyingPower?: number;
  equity?: number;
  /**
   * Which credential `buyingPower` / `equity` were actually read from.
   *
   * The panel binds that account snapshot to the terminal header's Paper/Live
   * selection, and every row here carries its own destination, so the snapshot
   * describes at most ONE of them. Passing the id along is what lets a row tell
   * "these numbers are my account's" from "these numbers are some other
   * account's", instead of projecting dollars off whichever account happens to
   * be open. Null means no account snapshot at all.
   */
  balancesCredentialId?: string | null;
}) {
  const {
    follows,
    globalPerpMaxLeverage,
    globalLeverageLoading,
    globalLeverageError,
    accounts,
    accountsLoading,
    followsLoading,
    followsError,
    mirrorStatus,
    mutationPending,
    onUpdate,
    onUnfollow,
  } = useManageFollows(isSignedIn);
  const destinationState = useManageFollowsState();

  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  // Uncommitted sizing values, keyed by follow id. Held here rather than in the
  // row so the row stays hook-free and directly testable; a follow with no
  // entry simply shows its saved value.
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});
  // Uncommitted per-trade dollar cap and per-coin position cap, same ownership.
  const [maxTradeSizeDrafts, setMaxTradeSizeDrafts] = useState<Record<string, string>>({});
  const [maxCoinSizeDrafts, setMaxCoinSizeDrafts] = useState<Record<string, string>>({});
  // Uncommitted exit levels, same ownership and the same reason as the two
  // above: the row stays hook-free and directly testable. A follow with no entry
  // here simply shows what is saved, and an EMPTY box is a real value (no leg),
  // not a missing one.
  const [protectionDrafts, setProtectionDrafts] = useState<
    Record<string, PerpProtectionDraft>
  >({});

  const count = follows.length;
  const deployment = describeMirrorDeployment(mirrorStatus);
  const limits = resolveMirrorLimits(mirrorStatus);
  const closeConsent = () => setConsent(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 gap-1.5 text-xs sm:h-7"
          >
            <Users className="h-3.5 w-3.5" />
            Manage follows
            {count > 0 && (
              <Badge variant="secondary" className="h-4 px-1 text-3xs tabular-nums">
                {count}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(42rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] p-0"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="text-sm font-semibold">Following</p>
            <p className="text-2xs text-muted-foreground">
              Configure Stocks and Perps independently. Each destination needs its own account.
            </p>
          </div>

          {/*
            Deployment state, from copyTrade.mirrorStatus. There is deliberately
            no "mirroring is on" banner: the flags live on the worker and the API
            is a separate deployment, so the only answers this can honestly give
            are "off" and "unknown".
          */}
          {deployment && (
            <div
              role="status"
              className={cn(
                "border-b px-3 py-2 text-2xs",
                deployment.kind === "off"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
              )}
            >
              <p className="flex items-center gap-1.5 font-semibold">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {deployment.headline}
              </p>
              <p className="mt-1 text-foreground/80">{deployment.detail}</p>
            </div>
          )}

          <div className="max-h-[min(70vh,36rem)] overflow-y-auto p-3 sm:p-4">
            <ManageFollowsBody
              followsLoading={followsLoading}
              followsError={followsError}
              follows={follows}
              globalPerpMaxLeverage={globalPerpMaxLeverage}
              globalLeverageLoading={globalLeverageLoading}
              globalLeverageError={globalLeverageError}
              renderRow={(follow) => (
                <FollowRow
                  key={follow.id}
                  follow={follow}
                  accounts={accounts}
                  accountsLoading={accountsLoading}
                  buyingPower={buyingPower}
                  equity={equity}
                  balancesCredentialId={balancesCredentialId}
                  limits={limits}
                  globalPerpMaxLeverage={globalPerpMaxLeverage}
                  deploymentBlockReason={deployment?.blockReason ?? null}
                  valueDraft={valueDrafts[follow.id] ?? String(follow.sizingValue)}
                  onValueDraftChange={(next) =>
                    setValueDrafts((current) => ({ ...current, [follow.id]: next }))
                  }
                  maxTradeSizeDraft={
                    maxTradeSizeDrafts[follow.id] ??
                    (follow.maxTradeSize !== null ? String(follow.maxTradeSize) : "")
                  }
                  onMaxTradeSizeDraftChange={(next) =>
                    setMaxTradeSizeDrafts((current) => ({ ...current, [follow.id]: next }))
                  }
                  maxCoinSizeDraft={
                    maxCoinSizeDrafts[follow.id] ??
                    (follow.maxCoinSize !== null ? String(follow.maxCoinSize) : "")
                  }
                  onMaxCoinSizeDraftChange={(next) =>
                    setMaxCoinSizeDrafts((current) => ({ ...current, [follow.id]: next }))
                  }
                  protectionDraft={
                    protectionDrafts[follow.id] ?? perpProtectionDraftFor(follow)
                  }
                  onProtectionDraftChange={(leg, next) =>
                    setProtectionDrafts((current) => ({
                      ...current,
                      [follow.id]: {
                        ...(current[follow.id] ?? perpProtectionDraftFor(follow)),
                        [leg]: next,
                      },
                    }))
                  }
                  onUpdate={(patch) => onUpdate(follow, patch)}
                  onDestinationUpdate={(destination, config) =>
                    onUpdate(follow, buildDestinationPatch(destination, config))
                  }
                  destinationDrafts={
                    follow.destinations !== undefined
                      ? {
                          stock: destinationState.getDraft(follow, "stock"),
                          perp: destinationState.getDraft(follow, "perp"),
                        }
                      : undefined
                  }
                  onDestinationDraftChange={(destination, change) =>
                    destinationState.updateDraft(follow.id, destination, change, follow)
                  }
                  onRequestConsent={(ask) => setConsent({ ask, follow })}
                  disabled={mutationPending}
                />
              )}
            />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Arming and re-pointing are the same gate: both hand a worker permission
        to place orders into a named account, so both go through
        ArmMirrorDialog, and the summary's "repoint" variant is what differs.
        The destination being consented to is `consentCredentialId(consent)`,
        which is the NEWLY picked credential on a re-point and the follow's own
        on an arm; nothing here reads `follow.credentialId` directly, because on
        a re-point that is the account being moved off.
      */}
      {consent && (consent.ask.kind === "arm" || consent.ask.kind === "repoint") && (
        <ArmMirrorDialog
          open
          onOpenChange={(open) => {
            if (!open) closeConsent();
          }}
          summary={buildFollowArmingSummary(
            buildArmingSummary({
              trader: followDisplayName(consent.follow),
              account: consentAccountLabel(consent, accounts),
              destinationProvider: selectedAccountProvider({
                credentialId: consentCredentialId(consent),
                accounts,
                fallback: consent.follow.credentialProvider,
              }),
              sizingMode: consent.follow.sizingMode,
              sizingValue: consent.follow.sizingValue,
              perpProtection: savedPerpProtection(consent.follow),
              limits,
              variant: consent.ask.kind === "repoint" ? "repoint" : "arm",
              previousAccount: followAccountLabel(consent.follow, accounts),
            }),
            globalPerpMaxLeverage,
            consent.follow.perpMaxLeverage,
          )}
          pending={mutationPending}
          onConfirm={() => {
            // Explicit `autoMirror: true` rather than leaning on the API's
            // "a non-null credential keeps it armed" behaviour: the follow is
            // being armed against THIS destination, and the request should say
            // so rather than depend on the server inferring it.
            const patch = buildAutoMirrorPatch(true, consentCredentialId(consent));
            const follow = consent.follow;
            closeConsent();
            if (patch) onUpdate(follow, patch);
          }}
        />
      )}

      {consent &&
        (consent.ask.kind === "destination-arm" ||
          consent.ask.kind === "destination-repoint") && (
          <DestinationArmConsentDialog
            consent={consent}
            accounts={accounts}
            limits={limits}
            globalPerpMaxLeverage={globalPerpMaxLeverage}
            mutationPending={mutationPending}
            onClose={closeConsent}
            onUpdate={onUpdate}
          />
        )}

      {/*
        The three stops, behind one dialog: switching auto-mirror off, clearing
        the destination (which the API turns into a disarm), and unfollowing.
        They differ in what else they take with them, which is what
        `buildStopSummary` spells out per kind; they do not differ in the belief
        they have to correct, which is that stopping unwinds the positions.
      */}
      {consent &&
        (consent.ask.kind === "disarm" ||
          consent.ask.kind === "unfollow" ||
          consent.ask.kind === "clear-account") && (
        <StopMirrorDialog
          open
          onOpenChange={(open) => {
            if (!open) closeConsent();
          }}
          summary={buildStopSummary({
            kind: consent.ask.kind,
            trader: followDisplayName(consent.follow),
          })}
          pending={mutationPending}
          onConfirm={() => {
            const { ask, follow } = consent;
            closeConsent();
            if (ask.kind === "unfollow") onUnfollow(follow);
            // Send the null the user actually chose. Patching `autoMirror:
            // false` instead would stop the orders but leave the follow pointed
            // at the account, which is not what the picker said it would do.
            else if (ask.kind === "clear-account") onUpdate(follow, { credentialId: null });
            else onUpdate(follow, { autoMirror: false });
          }}
        />
      )}

      {consent &&
        (consent.ask.kind === "destination-disarm" ||
          consent.ask.kind === "destination-clear") && (
          <DestinationStopConsentDialog
            consent={consent}
            accounts={accounts}
            mutationPending={mutationPending}
            onClose={closeConsent}
            onUpdate={onUpdate}
          />
        )}
    </>
  );
}

export function DestinationArmConsentDialog({
  consent,
  accounts,
  limits,
  globalPerpMaxLeverage,
  mutationPending,
  onClose,
  onUpdate,
}: {
  consent: ConsentRequest;
  accounts: readonly AlpacaAccountOption[];
  limits: MirrorLimits;
  globalPerpMaxLeverage: number | null;
  mutationPending: boolean;
  onClose: () => void;
  onUpdate: (
    follow: FollowItem,
    patch: {
      destinations: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
    },
  ) => void;
}) {
  if (
    consent.ask.kind !== "destination-arm" &&
    consent.ask.kind !== "destination-repoint"
  ) {
    return null;
  }

  const { follow } = consent;
  const { destination } = consent.ask;
  const current = resolveFollowDestination(follow, destination);
  const credentialId =
    consent.ask.kind === "destination-repoint"
      ? consent.ask.credentialId
      : current.credentialId;
  const account = accountForDestination(destination, credentialId, accounts);
  const perpLeverageReady =
    destination !== "perp" ||
    (validPerpLeverage(globalPerpMaxLeverage) &&
      (follow.perpMaxLeverage === null ||
        (validPerpLeverage(follow.perpMaxLeverage) &&
          follow.perpMaxLeverage <= globalPerpMaxLeverage)));
  const canArm =
    Boolean(account) &&
    destinationSupportsTarget(destination, follow.targetType) &&
    perpLeverageReady;
  const previousAccount = accountForDestination(
    destination,
    current.credentialId,
    accounts,
  );
  const accountLabel = account
    ? current.credentialId === account.id && current.credentialAccountLabel
      ? current.credentialAccountLabel
      : accountOptionLabel(account)
    : null;
  const previousAccountLabel = previousAccount
    ? current.credentialAccountLabel ?? accountOptionLabel(previousAccount)
    : current.credentialAccountLabel ?? null;
  const summary = buildDestinationArmingSummary({
    trader: followDisplayName(follow),
    destination,
    account: accountLabel,
    sizingMode: current.sizingMode,
    sizingValue: current.sizingValue,
    perpProtection: destination === "perp" ? savedPerpProtection(follow) : null,
    globalPerpMaxLeverage,
    followPerpMaxLeverage: follow.perpMaxLeverage,
    limits,
    variant: consent.ask.kind === "destination-repoint" ? "repoint" : "arm",
    previousAccount: previousAccountLabel,
  });

  return (
    <ArmMirrorDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      summary={summary}
      pending={mutationPending}
      onConfirm={() => {
        // A credential can disappear after the switch opened the dialog. Never
        // turn that race into a guessed destination or an armed request.
        // The leverage query can fail in the same interval, so re-check the
        // perp ceiling at the final consent boundary too.
        if (!canArm || !account) {
          onClose();
          return;
        }
        onClose();
        onUpdate(
          follow,
          buildDestinationPatch(destination, {
            ...current,
            enabled: true,
            credentialId: account.id,
            credentialAccountLabel: accountOptionLabel(account),
          }),
        );
      }}
    />
  );
}

export function DestinationStopConsentDialog({
  consent,
  accounts,
  mutationPending,
  onClose,
  onUpdate,
}: {
  consent: ConsentRequest;
  accounts: readonly AlpacaAccountOption[];
  mutationPending: boolean;
  onClose: () => void;
  onUpdate: (
    follow: FollowItem,
    patch: {
      destinations: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
    },
  ) => void;
}) {
  if (
    consent.ask.kind !== "destination-disarm" &&
    consent.ask.kind !== "destination-clear"
  ) {
    return null;
  }

  const { follow } = consent;
  const { destination } = consent.ask;
  const current = resolveFollowDestination(follow, destination);
  const account = accountForDestination(destination, current.credentialId, accounts);
  const summary = buildDestinationStopSummary({
    kind: consent.ask.kind === "destination-clear" ? "clear-account" : "disarm",
    destination,
    trader: followDisplayName(follow),
    account: current.credentialAccountLabel ?? (account ? accountOptionLabel(account) : null),
    sizingMode: current.sizingMode,
    sizingValue: current.sizingValue,
    perpProtection: destination === "perp" ? savedPerpProtection(follow) : null,
  });

  return (
    <StopMirrorDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      summary={summary}
      pending={mutationPending}
      onConfirm={() => {
        onClose();
        // A missing credential cannot pass server readiness checks on disarm.
        const clearAccount = consent.ask.kind === "destination-clear" || !account;
        const next = markDestinationStop({
          ...current,
          enabled: false,
          credentialId: clearAccount ? null : current.credentialId,
          credentialAccountLabel: clearAccount
            ? null
            : current.credentialAccountLabel ?? accountOptionLabel(account),
        }, current.enabled);
        if (consent.ask.kind === "destination-clear") {
          markDestinationClear(next, current.credentialId);
        }
        onUpdate(follow, buildDestinationPatch(destination, next));
      }}
    />
  );
}

/**
 * The dropdown's list body: loading skeleton, load error, empty state, or the
 * follows themselves.
 *
 * Hook-free like `FollowRow`, on purpose: `ManageFollows` mounts this inside
 * `DropdownMenuContent`, which Radix portals and does not render at all in
 * this suite's `renderToStaticMarkup`-only tests (there is no DOM
 * environment, so the menu can never actually be opened). Pulling this body
 * out is what lets `copy-trade-follow.test.ts` call it directly with each
 * hook state (loading, errored, empty, populated) and read what it painted,
 * instead of reading the source back and hoping the JSX still matched.
 */
export function ManageFollowsBody({
  followsLoading,
  followsError,
  follows,
  globalPerpMaxLeverage,
  globalLeverageLoading = false,
  globalLeverageError = null,
  renderRow,
}: {
  followsLoading: boolean;
  followsError: { message: string } | null;
  follows: FollowItem[];
  globalPerpMaxLeverage?: number | null;
  globalLeverageLoading?: boolean;
  globalLeverageError?: { message: string } | null;
  renderRow: (follow: FollowItem) => ReactNode;
}): ReactNode {
  const showGlobalSummary = globalPerpMaxLeverage !== undefined;

  return (
    <>
      {showGlobalSummary && (
        <div className="mb-2 rounded-md border border-border/70 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-2xs font-medium">Copy-trading maximum leverage</span>
            <span className="shrink-0 text-2xs font-semibold tabular-nums">
              {globalLeverageLoading
                ? "Loading…"
                : globalPerpMaxLeverage === null
                  ? "Unavailable"
                  : `${globalPerpMaxLeverage}x`}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <p className="min-w-0 text-2xs text-muted-foreground">
              Applies to every automatic perp copy. Leaders and markets can use less; no follow can use more.
            </p>
            <Link
              href="/settings?t=copy-trading"
              aria-label="Change copy-trading leverage setting"
              className="shrink-0 text-2xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Change
            </Link>
          </div>
          {globalLeverageError && (
            <p className="mt-1 text-2xs text-destructive" role="alert">
              Could not load copy-trading leverage: {globalLeverageError.message}
            </p>
          )}
        </div>
      )}
      {followsLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {!followsLoading && followsError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-2 text-xs text-destructive"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <AlertCircle className="h-3.5 w-3.5" />
            Could not load follows
          </div>
          <p className="mt-1 text-2xs text-destructive/80">{followsError.message}</p>
        </div>
      )}

      {!followsLoading && !followsError && follows.length === 0 && (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
          You aren&apos;t following anyone yet. Use the Follow button on a feed row.
        </p>
      )}

      <div className="flex flex-col gap-2">{follows.map((follow) => renderRow(follow))}</div>
    </>
  );
}

function followDisplayName(follow: FollowItem): string {
  if (follow.targetLabel) return follow.targetLabel;
  // For HL wallet follows, show a truncated address instead of the raw 0x string.
  if (
    follow.targetType === "hl_wallet" &&
    follow.targetKey.startsWith("0x") &&
    follow.targetKey.length >= 10
  ) {
    return `${follow.targetKey.slice(0, 6)}...${follow.targetKey.slice(-4)}`;
  }
  return follow.targetKey;
}

/** The destination account as the user would recognise it, or null when none. */
function followAccountLabel(
  follow: FollowItem,
  accounts: readonly AlpacaAccountOption[],
): string | null {
  if (follow.credentialAccountLabel) return follow.credentialAccountLabel;
  const selected = accounts.find((account) => account.id === follow.credentialId);
  return selected ? accountOptionLabel(selected) : null;
}

/** The credential this confirmation is actually about. */
function consentCredentialId(consent: ConsentRequest): string | null {
  const { ask } = consent;
  return ask.kind === "repoint" ? ask.credentialId : consent.follow.credentialId;
}

/**
 * How to name that credential in the summary.
 *
 * `follow.credentialAccountLabel` describes the account the follow is on TODAY,
 * so it must never be used to name a newly picked one; a re-point resolves its
 * label from the live accounts list only.
 */
function consentAccountLabel(
  consent: ConsentRequest,
  accounts: readonly AlpacaAccountOption[],
): string | null {
  const { ask } = consent;
  if (ask.kind !== "repoint") return followAccountLabel(consent.follow, accounts);
  const picked = accounts.find((account) => account.id === ask.credentialId);
  return picked ? accountOptionLabel(picked) : null;
}

/**
 * A single editable follow row: sizing override, auto-mirror toggle, unfollow.
 *
 * Deliberately hook-free, with the sizing draft owned by ManageFollows. That is
 * what lets `mirror-consent.test.tsx` call this directly and invoke the handler
 * the row actually wired to each control, instead of reading the source back and
 * hoping. The property under test is that NONE of the switch, the Unfollow
 * button, or the account picker on an armed follow (in either direction, a
 * different account or "No account") can reach `onUpdate` / the unfollow
 * mutation: each can only raise a consent request.
 */
export function FollowRow({
  follow,
  accounts,
  accountsLoading,
  buyingPower,
  equity,
  balancesCredentialId,
  limits,
  globalPerpMaxLeverage,
  deploymentBlockReason,
  valueDraft,
  onValueDraftChange,
  maxTradeSizeDraft,
  onMaxTradeSizeDraftChange,
  maxCoinSizeDraft,
  onMaxCoinSizeDraftChange,
  protectionDraft,
  onProtectionDraftChange,
  onUpdate,
  onDestinationUpdate,
  destinationDrafts,
  onDestinationDraftChange,
  onRequestConsent,
  disabled,
}: {
  follow: FollowItem;
  accounts: AlpacaAccountOption[];
  accountsLoading: boolean;
  /** From the panel's account snapshot - used for the H-1 preflight projection. */
  buyingPower: number;
  equity: number;
  /** Which credential that snapshot belongs to, or null when there is none. */
  balancesCredentialId: string | null;
  limits: MirrorLimits;
  /** Current user-owned automatic-perp ceiling, or null while unavailable. */
  globalPerpMaxLeverage: number | null;
  deploymentBlockReason: string | null;
  /** Uncommitted sizing value (always saved as pct), owned by the parent so this stays hook-free. */
  valueDraft: string;
  onValueDraftChange: (next: string) => void;
  /** Uncommitted per-trade dollar cap, owned by the parent. */
  maxTradeSizeDraft: string;
  onMaxTradeSizeDraftChange: (next: string) => void;
  /** Uncommitted per-coin position cap, owned by the parent. */
  maxCoinSizeDraft: string;
  onMaxCoinSizeDraftChange: (next: string) => void;
  /** Uncommitted exit levels, owned by the parent for the same reason. */
  protectionDraft: PerpProtectionDraft;
  onProtectionDraftChange: (leg: PerpProtectionLeg, next: string) => void;
  onUpdate: (patch: {
    autoMirror?: boolean;
    sizingMode?: SizingMode;
    sizingValue?: number;
    maxTradeSize?: number | null;
    maxCoinSize?: number | null;
    credentialId?: string | null;
    perpTakeProfitPct?: number | null;
    perpStopLossPct?: number | null;
    perpMaxLeverage?: number | null;
    destinations?: Partial<Record<MirrorDestination, MirrorDestinationConfig>>;
  }) => void;
  onDestinationUpdate?: (
    destination: MirrorDestination,
    config: MirrorDestinationConfig,
  ) => void;
  destinationDrafts?: DestinationDrafts;
  onDestinationDraftChange?: (
    destination: MirrorDestination,
    change: DestinationDraftChange,
  ) => void;
  onRequestConsent: (ask: ConsentAsk) => void;
  disabled: boolean;
}) {
  if (follow.destinations !== undefined) {
    return IndependentFollowRow({
      follow,
      accounts,
      accountsLoading,
      buyingPower,
      equity,
      balancesCredentialId,
      limits,
      globalPerpMaxLeverage,
      deploymentBlockReason,
      destinationDrafts,
      onDestinationDraftChange,
      onDestinationUpdate:
        onDestinationUpdate ??
        ((destination, config) => onUpdate(buildDestinationPatch(destination, config))),
      onPerpUpdate: (patch) => onUpdate(patch),
      onRequestConsent,
      disabled,
    });
  }

  // Auto-mirror is wired for app users, callers, and HL wallet follows.
  // Politician follows remain disabled so the switch never implies unsupported order mirroring.
  const autoMirrorSupported =
    follow.targetType === "user" ||
    follow.targetType === "x_author" ||
    follow.targetType === "hl_wallet";

  // The row's one notion of "this follow is live". The switch's state and the
  // account picker's re-point gate both read it, so the row cannot paint a
  // follow as off while treating a destination change on it as harmless.
  const armed = autoMirrorSupported && follow.autoMirror;

  // Always ratio (pct of buying power): the mode is fixed, only the value is editable.
  const bounds = SIZING_MODE_PRESENTATION["pct"];

  // Read from the live accounts list first so the perp disclosure appears as
  // soon as the user selects a Hyperliquid account, not one refetch later.
  const destinationProvider = selectedAccountProvider({
    credentialId: follow.credentialId,
    accounts,
    fallback: follow.credentialProvider,
  });

  // Belt-and-suspenders: value outside bounds is rejected by the API.
  const draftNumber = Number(valueDraft);
  const draftOutOfRange =
    valueDraft !== "" &&
    Number.isFinite(draftNumber) &&
    (draftNumber < bounds.min || draftNumber > bounds.max);

  const switchState = autoMirrorSwitchState({
    supported: autoMirrorSupported,
    pending: disabled,
    autoMirror: follow.autoMirror,
    credentialId: follow.credentialId,
    destinationProvider,
    globalPerpMaxLeverage,
    targetLabel: followTargetTypeLabel(follow.targetType),
    deploymentBlockReason,
    sizingInvalid: draftOutOfRange,
  });

  /**
   * Save the ratio value as pct of buying power. Mode is always "pct";
   * legacy follows saved under a different mode are migrated on the next save.
   */
  const commitValue = () => {
    const next = Number(valueDraft);
    const stated =
      valueDraft.trim() !== "" &&
      Number.isFinite(next) &&
      next >= bounds.min &&
      next <= bounds.max;

    if (stated && (next !== follow.sizingValue || follow.sizingMode !== "pct")) {
      onUpdate({ sizingMode: "pct", sizingValue: next });
      return;
    }
    if (stated) return;
    // Nothing committable. Put the saved number back.
    onValueDraftChange(String(follow.sizingValue));
  };

  /** Save the per-trade dollar cap, or remove it when the field is cleared. */
  const commitMaxTradeSize = () => {
    const raw = maxTradeSizeDraft.trim();
    if (raw === "") {
      if (follow.maxTradeSize !== null) onUpdate({ maxTradeSize: null });
      return;
    }
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onMaxTradeSizeDraftChange(
        follow.maxTradeSize !== null ? String(follow.maxTradeSize) : "",
      );
      return;
    }
    if (parsed !== follow.maxTradeSize) onUpdate({ maxTradeSize: parsed });
  };

  /** Save the per-coin position cap, or remove it when the field is cleared. */
  const commitMaxCoinSize = () => {
    const raw = maxCoinSizeDraft.trim();
    if (raw === "") {
      if (follow.maxCoinSize !== null) onUpdate({ maxCoinSize: null });
      return;
    }
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onMaxCoinSizeDraftChange(
        follow.maxCoinSize !== null ? String(follow.maxCoinSize) : "",
      );
      return;
    }
    if (parsed !== follow.maxCoinSize) onUpdate({ maxCoinSize: parsed });
  };

  const savedProtection = savedPerpProtection(follow);
  const protectionOutOfRange = PERP_PROTECTION_LEGS.some((leg) =>
    protectionDraftInvalid(protectionDraft[leg], PERP_PROTECTION_PRESENTATION[leg]),
  );

  const followPerpMaxLeverage =
    follow.perpMaxLeverage == null
      ? null
      : validPerpLeverage(follow.perpMaxLeverage)
        ? follow.perpMaxLeverage
        : COPY_PERP_MAX_LEVERAGE_MIN;
  const effectivePerpMaxLeverage = validPerpLeverage(globalPerpMaxLeverage)
    ? Math.min(globalPerpMaxLeverage, followPerpMaxLeverage ?? globalPerpMaxLeverage)
    : null;

  /**
   * Save one exit level, or remove it.
   *
   * An EMPTY box sends an explicit `null`, which is what the router reads as
   * "remove this leg". Sending nothing would leave the stored level in place
   * behind a screen showing none, which is the exact surprise the router's
   * absent-versus-null contract exists to prevent, and it would be a live stop
   * the follower believes they deleted.
   *
   * A number outside the bounds is not sent at all and the saved value is put
   * back. The router would refuse it anyway; restoring makes the row agree with
   * what is actually stored instead of showing a level nobody holds.
   */
  const commitProtection = (leg: PerpProtectionLeg) => {
    const bounds = PERP_PROTECTION_PRESENTATION[leg];
    const raw = protectionDraft[leg].trim();
    const saved = leg === "stopLoss" ? follow.perpStopLossPct : follow.perpTakeProfitPct;
    const field = leg === "stopLoss" ? "perpStopLossPct" : "perpTakeProfitPct";

    if (raw === "") {
      if (saved !== null) onUpdate({ [field]: null });
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next) || next < bounds.min || next > bounds.max) {
      onProtectionDraftChange(leg, saved === null ? "" : String(saved));
      return;
    }
    if (next !== saved) onUpdate({ [field]: next });
  };

  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-3xs uppercase">
            {followTargetTypeLabel(follow.targetType)}
          </Badge>
          <span className="truncate text-xs font-medium">
            {followDisplayName(follow)}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onRequestConsent({ kind: "unfollow" })}
          aria-label={`Unfollow ${followDisplayName(follow)}`}
          className="h-6 shrink-0 px-1.5 text-2xs text-muted-foreground hover:text-destructive"
        >
          <X className="h-3 w-3" />
          Unfollow
        </Button>
      </div>

      {/* Sizing: ratio %, max trade size, max coin size */}
      <div className="mt-2 space-y-1.5">
        {/* Ratio %: percentage of buying power per copied order */}
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-2xs text-muted-foreground">Ratio %</span>
          <Input
            type="number"
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            value={valueDraft}
            disabled={disabled}
            onChange={(e) => onValueDraftChange(e.target.value)}
            onBlur={commitValue}
            onKeyDown={(e) => { if (e.key === "Enter") commitValue(); }}
            aria-label={bounds.aria}
            aria-invalid={draftOutOfRange ? "true" : "false"}
            className={cn(
              "h-6 w-16 tabular-nums",
              draftOutOfRange && "border-destructive ring-destructive/30",
            )}
          />
          <span className="text-2xs text-muted-foreground">{bounds.caption}</span>
        </div>
        {draftOutOfRange && (
          <p className="text-2xs text-destructive">
            Value must be between {bounds.min} and {bounds.max}.
          </p>
        )}
        {/* Per-trade cap and per-coin cap */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-2xs text-muted-foreground">Max trade size</span>
            <Input
              type="number"
              min={1}
              max={1_000_000}
              step={50}
              placeholder="none"
              value={maxTradeSizeDraft}
              disabled={disabled}
              onChange={(e) => onMaxTradeSizeDraftChange(e.target.value)}
              onBlur={commitMaxTradeSize}
              onKeyDown={(e) => { if (e.key === "Enter") commitMaxTradeSize(); }}
              aria-label="Max dollars per trade"
              className="h-6 w-20 tabular-nums"
            />
            <span className="text-2xs text-muted-foreground">$</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-2xs text-muted-foreground">Max in a single coin</span>
            <Input
              type="number"
              min={1}
              max={1_000_000}
              step={50}
              placeholder="none"
              value={maxCoinSizeDraft}
              disabled={disabled}
              onChange={(e) => onMaxCoinSizeDraftChange(e.target.value)}
              onBlur={commitMaxCoinSize}
              onKeyDown={(e) => { if (e.key === "Enter") commitMaxCoinSize(); }}
              aria-label="Max total position size in a single coin across all copies"
              className="h-6 w-20 tabular-nums"
            />
            <span className="text-2xs text-muted-foreground">$, across all copies</span>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-2xs font-medium text-muted-foreground">Mirror account</span>
        <Select
          value={follow.credentialId ?? "none"}
          disabled={disabled || accountsLoading}
          onValueChange={(value) => {
            const next = value === "none" ? null : value;
            if (next === follow.credentialId) return;
            // On an ARMED follow this picker is a consent decision in BOTH
            // directions, never a setting:
            //  - another account: the API keeps auto-mirror on for any non-null
            //    credential, so one click would move live automation from Paper
            //    to Live, or from Alpaca to leveraged Hyperliquid perps, under a
            //    "Follow settings updated" toast.
            //  - "No account": the API force-disarms on an explicit null, so the
            //    same one click stops the automation. Stopping is exactly what
            //    users misread as also closing what the mirror opened, which is
            //    the belief the stop confirmation exists to correct, so it is
            //    not something to report only afterwards in a toast.
            if (armed) {
              onRequestConsent(
                next === null
                  ? { kind: "clear-account" }
                  : { kind: "repoint", credentialId: next },
              );
              return;
            }
            // Nothing is armed, so this can neither grant a standing order nor
            // withdraw one. What the server did with it is said out loud by
            // followUpdateToast (MIRROR_ACCOUNT_CLEARED_TOAST for a null).
            onUpdate({ credentialId: next });
          }}
        >
          <SelectTrigger size="sm" className="min-w-44 max-w-52" aria-label="Mirror account">
            <SelectValue placeholder={accountsLoading ? "Loading accounts" : "Select account"} />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="none">No account</SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {accountOptionLabel(account)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {follow.credentialAccountLabel && (
        <p className="mt-1 text-right text-2xs text-muted-foreground">
          Selected: {follow.credentialAccountLabel}
        </p>
      )}

      {/*
        This control is intentionally independent of the destination picker:
        the cap is a policy for automatic Hyperliquid copies, so a user can set
        it before selecting a Hyperliquid credential (or while the follow is on
        Alpaca) without implying that Alpaca orders use leverage.
      */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium text-muted-foreground">Perp leverage cap</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {effectivePerpMaxLeverage === null
              ? "Effective ceiling unavailable until your global copy-trading cap loads."
              : `Effective ceiling: ${effectivePerpMaxLeverage}x. Leaders and markets may use less.`}
          </p>
        </div>
        <Select
          value={follow.perpMaxLeverage == null ? "global" : String(follow.perpMaxLeverage)}
          disabled={disabled || globalPerpMaxLeverage === null}
          onValueChange={(value) => {
            if (value === "global") {
              if (follow.perpMaxLeverage != null) onUpdate({ perpMaxLeverage: null });
              return;
            }
            const next = Number(value);
            if (
              !validPerpLeverage(next) ||
              globalPerpMaxLeverage === null ||
              next > globalPerpMaxLeverage ||
              next === follow.perpMaxLeverage
            ) {
              return;
            }
            onUpdate({ perpMaxLeverage: next });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-36 max-w-full"
            aria-label="Perp leverage cap"
          >
            <SelectValue placeholder="Use global" />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="global">
              {globalPerpMaxLeverage === null
                ? "Use global"
                : `Use global (${globalPerpMaxLeverage}x)`}
            </SelectItem>
            {globalPerpMaxLeverage !== null &&
              Array.from(
                { length: globalPerpMaxLeverage - COPY_PERP_MAX_LEVERAGE_MIN + 1 },
                (_, index) => index + COPY_PERP_MAX_LEVERAGE_MIN,
              ).map((leverage) => (
                <SelectItem key={leverage} value={String(leverage)}>
                  {leverage}x maximum
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      {/*
        Shown only for a Hyperliquid destination, because that is the only venue
        the worker attaches an exit on. Rendering either of these beside an Alpaca
        account would advertise a feature that does nothing there.
      */}
      {destinationProvider === "hyperliquid" && (
        <>
          {/*
            A Hyperliquid destination means leveraged orders on a live exchange, and
            by default nothing attached to close them. This is where the follower
            both sets that exit and is told what it does, because this is where the
            destination is chosen; the "How it works" dialog states the general case
            and cannot speak for one follow.
          */}
          <div className="mt-2 rounded-md border border-border/70 p-2">
            <p className="text-2xs font-medium text-muted-foreground">
              Automatic exit on perp positions
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {PERP_PROTECTION_LEGS.map((leg) => {
                const bounds = PERP_PROTECTION_PRESENTATION[leg];
                const draft = protectionDraft[leg];
                const invalid = protectionDraftInvalid(draft, bounds);
                return (
                  <label key={leg} className="flex items-center gap-1.5">
                    <span className="text-2xs text-muted-foreground">{bounds.label}</span>
                    <Input
                      type="number"
                      min={bounds.min}
                      max={bounds.max}
                      step={bounds.step}
                      value={draft}
                      disabled={disabled}
                      placeholder="Off"
                      onChange={(e) => onProtectionDraftChange(leg, e.target.value)}
                      onBlur={() => commitProtection(leg)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitProtection(leg);
                      }}
                      aria-label={bounds.aria}
                      aria-invalid={invalid ? "true" : "false"}
                      className={cn(
                        "h-6 w-16 tabular-nums",
                        invalid && "border-destructive ring-destructive/30",
                      )}
                    />
                    <span className="text-2xs text-muted-foreground">{bounds.caption}</span>
                  </label>
                );
              })}
            </div>
            {/*
              The base is spelled out rather than left to the "% of margin" caption
              alone. A follower reading "25" next to a leveraged position will
              reach for a price move, and at 20x that reading is twenty times the
              risk they think they are taking.
            */}
            <p className="mt-1 text-2xs text-muted-foreground">
              {savedProtection
                ? describePerpProtection(savedProtection)
                : "Leave both empty for no automatic exit. A position copied from a signal post is then never closed for you."}
            </p>
            {protectionOutOfRange && (
              <p className="mt-1 text-2xs text-destructive">
                {`Take profit must be between ${PERP_PROTECTION_PRESENTATION.takeProfit.min} and ${PERP_PROTECTION_PRESENTATION.takeProfit.max}, and stop loss between ${PERP_PROTECTION_PRESENTATION.stopLoss.min} and ${PERP_PROTECTION_PRESENTATION.stopLoss.max}. A stop at or past the whole margin is past liquidation and would never fire.`}
              </p>
            )}
          </div>
          <PerpMirrorDisclosure className="mt-2" protection={savedProtection} />
        </>
      )}

      {/*
        Project one mirror against the worker's absolute per-order ceiling.

        The projection may only be drawn from the account that will place the
        order. `buyingPower` / `equity` are the TERMINAL's active account (the
        panel binds them to the header's Paper/Live credential), while the
        worker sizes every mirror off this follow's own destination: it decrypts
        `follow.credentialId` and reads THAT account's buying power and equity.
        Those are routinely different accounts, and a percentage of the wrong
        one is not an approximation, it is a different account's number: a
        follow armed on a $200,000 Live account read "About $8.00 per order"
        while the terminal sat on a $2,000 Paper one, and the worker then placed
        $800 of real money. It runs the other way too, announcing a $100,000
        order and a skip that never happens.

        So a percent projection is shown only while the snapshot IS this
        follow's account. Otherwise the row states the rule and names the
        account it is measured against, which is true regardless of what is open
        in the terminal. That also keeps Hyperliquid destinations out of it: the
        snapshot is Alpaca-only, and perp sizing scales free cross collateral
        with leverage, so there is no honest dollar figure to print here at all.

        `usd` is the exception and always shows: it states its dollars outright
        and every venue uses that same figure as the target notional.
      */}
      {(() => {
        const sizesOffAccountBalance =
          follow.sizingMode === "pct" || follow.sizingMode === "pct_equity";
        const snapshotIsThisFollows =
          follow.credentialId !== null && follow.credentialId === balancesCredentialId;
        if (sizesOffAccountBalance && !snapshotIsThisFollows) {
          const destination = followAccountLabel(follow, accounts);
          // No destination yet means nothing to measure against and nothing to
          // place; the switch already says to choose an account first.
          if (!destination) return null;
          return (
            <p className="mt-1 text-2xs text-muted-foreground">
              {`Sized ${describeSizePerOrder(follow.sizingMode, follow.sizingValue, destinationProvider, follow.maxTradeSize)} on `}
              {destination}
              {". The dollar amount follows that account's balance, not the one open here."}
            </p>
          );
        }
        const projected = estimateProjectedDollars(
          follow.sizingMode,
          follow.sizingValue,
          buyingPower,
          equity,
        );
        if (projected === null) return null;
        const dollars = formatUsd(projected);
        const ceiling = limits.maxOrderDollars ?? DEFAULT_PER_ORDER_CEILING;
        const exceedsCeiling = projected > ceiling;
        return (
          <p
            className={cn(
              "mt-1 text-2xs",
              exceedsCeiling
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {exceedsCeiling ? (
              <>
                {`About ${dollars} per order. Above the ${formatUsd(ceiling)} absolute`}
                {" per-order ceiling; the worker will skip it unless that ceiling is configured higher."}
              </>
            ) : (
              <>{`About ${dollars} per order at current balance.`}</>
            )}
          </p>
        );
      })()}

      {/*
        Arming is a confirmed action. The switch can only raise a request; the
        confirmation dialog mounted by ManageFollows is the only caller of the
        update mutation.
      */}
      <AutoMirrorSwitch
        armed={armed}
        interactive={switchState.interactive}
        reason={switchState.reason}
        onRequestArm={() => onRequestConsent({ kind: "arm" })}
        onRequestDisarm={() => onRequestConsent({ kind: "disarm" })}
      />
    </div>
  );
}

export function IndependentFollowRow({
  follow,
  accounts,
  accountsLoading,
  buyingPower,
  equity,
  balancesCredentialId,
  limits,
  globalPerpMaxLeverage,
  deploymentBlockReason,
  destinationDrafts,
  onDestinationDraftChange,
  onDestinationUpdate,
  onPerpUpdate,
  onRequestConsent,
  disabled,
}: {
  follow: FollowItem;
  accounts: AlpacaAccountOption[];
  accountsLoading: boolean;
  buyingPower: number;
  equity: number;
  balancesCredentialId: string | null;
  limits: MirrorLimits;
  globalPerpMaxLeverage: number | null;
  deploymentBlockReason: string | null;
  destinationDrafts?: DestinationDrafts;
  onDestinationDraftChange?: (
    destination: MirrorDestination,
    change: DestinationDraftChange,
  ) => void;
  onDestinationUpdate: (
    destination: MirrorDestination,
    config: MirrorDestinationConfig,
  ) => void;
  onPerpUpdate: (patch: {
    perpTakeProfitPct?: number | null;
    perpStopLossPct?: number | null;
    perpMaxLeverage?: number | null;
  }) => void;
  onRequestConsent: (ask: ConsentAsk) => void;
  disabled: boolean;
}) {
  const destinations: MirrorDestination[] = ["stock", "perp"];

  return (
    <div
      data-independent-mirror="true"
      className="min-w-0 rounded-md border border-border p-3"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge variant="outline" className="h-4 shrink-0 px-1 text-3xs uppercase">
              {followTargetTypeLabel(follow.targetType)}
            </Badge>
            <span className="truncate text-sm font-semibold">{followDisplayName(follow)}</span>
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            Configure each destination independently. Off means no new orders there.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onRequestConsent({ kind: "unfollow" })}
          aria-label={`Unfollow ${followDisplayName(follow)}`}
          className="h-7 shrink-0 px-1.5 text-2xs text-muted-foreground hover:text-destructive"
        >
          <X className="h-3 w-3" />
          Unfollow
        </Button>
      </div>

      <div className="mt-4 min-w-0 space-y-4">
        {destinations.map((destination) => {
          const config = resolveFollowDestination(follow, destination);
          const defaultDraft: DestinationFollowDraft = {
            mode: null,
            value: String(config.sizingValue),
            protection:
              destination === "perp"
                ? {
                    stopLoss:
                      follow.perpStopLossPct === null ? "" : String(follow.perpStopLossPct),
                    takeProfit:
                      follow.perpTakeProfitPct === null ? "" : String(follow.perpTakeProfitPct),
                  }
                : { stopLoss: "", takeProfit: "" },
          };
          return (
            <Fragment key={destination}>
              {DestinationConfigurationSection({
                follow,
                destination,
                config,
                draft: destinationDrafts?.[destination] ?? defaultDraft,
                accounts,
                accountsLoading,
                buyingPower,
                equity,
                balancesCredentialId,
                limits,
                globalPerpMaxLeverage,
                deploymentBlockReason,
                disabled,
                onDraftChange: (change) => onDestinationDraftChange?.(destination, change),
                onDestinationUpdate,
                onPerpUpdate,
                onRequestConsent,
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function DestinationConfigurationSection({
  follow,
  destination,
  config,
  draft,
  accounts,
  accountsLoading,
  buyingPower,
  equity,
  balancesCredentialId,
  limits,
  globalPerpMaxLeverage,
  deploymentBlockReason,
  disabled,
  onDraftChange,
  onDestinationUpdate,
  onPerpUpdate,
  onRequestConsent,
}: {
  follow: FollowItem;
  destination: MirrorDestination;
  config: MirrorDestinationConfig;
  draft: DestinationFollowDraft;
  accounts: AlpacaAccountOption[];
  accountsLoading: boolean;
  buyingPower: number;
  equity: number;
  balancesCredentialId: string | null;
  limits: MirrorLimits;
  globalPerpMaxLeverage: number | null;
  deploymentBlockReason: string | null;
  disabled: boolean;
  onDraftChange: (change: DestinationDraftChange) => void;
  onDestinationUpdate: (
    destination: MirrorDestination,
    config: MirrorDestinationConfig,
  ) => void;
  onPerpUpdate: (patch: {
    perpTakeProfitPct?: number | null;
    perpStopLossPct?: number | null;
    perpMaxLeverage?: number | null;
  }) => void;
  onRequestConsent: (ask: ConsentAsk) => void;
}) {
  const presentation = DESTINATION_PRESENTATION[destination];
  const idNamespace = `${follow.id}-${destination}`;
  const headingId = `${idNamespace}-mirror-heading`;
  const accountDescriptionId = `${idNamespace}-account-description`;
  const accountControlId = `${idNamespace}-account`;
  const sizingControlId = `${idNamespace}-sizing`;
  const leverageControlId = `${idNamespace}-leverage`;
  const destinationAccounts = accountsForDestination(destination, accounts);
  const selectedAccount = accountForDestination(
    destination,
    config.credentialId,
    accounts,
  );
  const pendingMode =
    draft.mode !== null && draft.mode !== config.sizingMode ? draft.mode : null;
  const effectiveMode = pendingMode ?? config.sizingMode;
  const sizingBounds = SIZING_MODE_PRESENTATION[effectiveMode];
  const rawSizing = draft.value.trim();
  const sizingNumber = rawSizing === "" ? Number.NaN : Number(rawSizing);
  const sizingInvalid =
    rawSizing !== "" &&
    (!Number.isFinite(sizingNumber) ||
      sizingNumber < sizingBounds.min ||
      sizingNumber > sizingBounds.max);
  const sizingIncomplete = pendingMode !== null && rawSizing === "";
  const ratioUnsupported = effectiveMode === "ratio" && follow.targetType === "x_author";
  const savedProtection = savedPerpProtection(follow);
  const protectionInvalid =
    destination === "perp" &&
    PERP_PROTECTION_LEGS.some((leg) =>
      protectionDraftInvalid(draft.protection[leg], PERP_PROTECTION_PRESENTATION[leg]),
    );
  const leverageInvalid =
    destination === "perp" &&
    follow.perpMaxLeverage !== null &&
    (!validPerpLeverage(follow.perpMaxLeverage) ||
      (validPerpLeverage(globalPerpMaxLeverage) &&
        follow.perpMaxLeverage > globalPerpMaxLeverage));
  const switchState = autoMirrorSwitchState({
    supported: destinationSupportsTarget(destination, follow.targetType),
    pending: disabled,
    autoMirror: config.enabled,
    credentialId: config.credentialId,
    destinationProvider: presentation.provider,
    globalPerpMaxLeverage: destination === "perp" ? globalPerpMaxLeverage : undefined,
    targetLabel: followTargetTypeLabel(follow.targetType),
    deploymentBlockReason,
    sizingInvalid: sizingInvalid || sizingIncomplete || protectionInvalid,
    sizingBlockReason: ratioUnsupported
      ? "Multiple sizing needs the source trader's quantity, which caller signals do not provide."
      : undefined,
    leverageInvalid,
    credentialAvailable: accountsLoading ? false : selectedAccount !== null,
  });

  const commitSizing = () => {
    const next = Number(draft.value);
    const valid =
      draft.value.trim() !== "" &&
      Number.isFinite(next) &&
      next >= sizingBounds.min &&
      next <= sizingBounds.max;
    if (valid && pendingMode) {
      onDestinationUpdate(destination, {
        ...config,
        sizingMode: pendingMode,
        sizingValue: next,
      });
      onDraftChange({ mode: null, value: String(next) });
      return;
    }
    if (valid && next !== config.sizingValue) {
      onDestinationUpdate(destination, { ...config, sizingValue: next });
      return;
    }
    if (!pendingMode) onDraftChange({ value: String(config.sizingValue) });
  };

  const commitProtection = (leg: PerpProtectionLeg) => {
    const raw = draft.protection[leg].trim();
    const bounds = PERP_PROTECTION_PRESENTATION[leg];
    const saved = leg === "stopLoss" ? follow.perpStopLossPct : follow.perpTakeProfitPct;
    if (raw === "") {
      if (saved === null) return;
      if (leg === "stopLoss") onPerpUpdate({ perpStopLossPct: null });
      else onPerpUpdate({ perpTakeProfitPct: null });
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next) || next < bounds.min || next > bounds.max) {
      const restored = saved === null ? "" : String(saved);
      onDraftChange(
        leg === "stopLoss"
          ? { protection: { stopLoss: restored } }
          : { protection: { takeProfit: restored } },
      );
      return;
    }
    if (next === saved) return;
    if (leg === "stopLoss") onPerpUpdate({ perpStopLossPct: next });
    else onPerpUpdate({ perpTakeProfitPct: next });
  };

  return (
    <section
      data-destination={destination}
      aria-labelledby={headingId}
      className="min-w-0 border-t border-border/70 pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold">
            {presentation.label}
          </h3>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {presentation.venue} · {presentation.description}
          </p>
        </div>
        <AutoMirrorSwitch
          armed={config.enabled}
          interactive={switchState.interactive}
          reason={switchState.reason}
          label={`Auto-mirror ${presentation.label}`}
          ariaLabel={`Toggle ${presentation.label} auto-mirror (auto-places real orders)`}
          onRequestArm={() =>
            onRequestConsent({ kind: "destination-arm", destination })
          }
          onRequestDisarm={() =>
            onRequestConsent({ kind: "destination-disarm", destination })
          }
        />
      </div>

      <div className="mt-3 grid min-w-0 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center">
        <div className="min-w-0">
          <p className="text-2xs font-medium">Destination account</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            <span id={accountDescriptionId}>
            Only your {presentation.provider === "alpaca" ? "Alpaca" : "Hyperliquid"} accounts are shown.
            </span>
          </p>
        </div>
        <Select
          value={config.credentialId ?? "none"}
          disabled={disabled || accountsLoading}
          onValueChange={(value) => {
            const next = value === "none" ? null : value;
            if (next === config.credentialId) return;
            if (config.enabled) {
              onRequestConsent(
                next === null
                  ? { kind: "destination-clear", destination }
                  : { kind: "destination-repoint", destination, credentialId: next },
              );
              return;
            }
            const nextAccount = accountForDestination(destination, next, accounts);
            onDestinationUpdate(destination, markDestinationClear({
              ...config,
              credentialId: next,
              credentialAccountLabel: nextAccount ? accountOptionLabel(nextAccount) : null,
            }, config.credentialId));
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full min-w-0"
            id={accountControlId}
            aria-describedby={accountDescriptionId}
            aria-label={`${presentation.label} mirror account`}
          >
            <SelectValue placeholder={accountsLoading ? "Loading accounts" : "No account"} />
          </SelectTrigger>
          <SelectContent align="end" className="max-w-[calc(100vw-2rem)]">
            <SelectItem value="none">No account</SelectItem>
            {config.credentialId && !selectedAccount && (
              <SelectItem value={config.credentialId} disabled>
                Saved account unavailable
              </SelectItem>
            )}
            {destinationAccounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {accountOptionLabel(account)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p
        className={cn(
          "mt-1 text-2xs",
          config.credentialId && !selectedAccount
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
        )}
        role={config.credentialId && !selectedAccount ? "alert" : undefined}
      >
        {selectedAccount
          ? `Selected: ${config.credentialAccountLabel ?? accountOptionLabel(selectedAccount)}${selectedAccount.provider === "alpaca" ? ` · ${selectedAccount.accountType === "LIVE" ? "Live" : "Paper"}` : ""}`
          : "No user-owned account selected. This destination cannot be armed."}
      </p>

      <div className="mt-3 min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="shrink-0 text-2xs font-medium">Order sizing</span>
          <SizingModeTabs
            value={effectiveMode}
            disabled={disabled}
            compact
            stackOnNarrow
            onChange={(mode) => {
              if (mode === config.sizingMode) {
                onDraftChange({ mode: null, value: String(config.sizingValue) });
                return;
              }
              onDraftChange({ mode, value: "" });
            }}
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            type="number"
            id={sizingControlId}
            min={sizingBounds.min}
            max={sizingBounds.max}
            step={sizingBounds.step}
            value={draft.value}
            disabled={disabled}
            onChange={(event) => onDraftChange({ value: event.target.value })}
            onBlur={commitSizing}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSizing();
            }}
            aria-label={`${presentation.label}: ${sizingBounds.aria}`}
            aria-invalid={sizingInvalid ? "true" : "false"}
            className={cn("h-8 w-24 shrink-0 tabular-nums", sizingInvalid && "border-destructive")}
          />
          <span className="min-w-0 text-2xs text-muted-foreground">{sizingBounds.caption}</span>
        </div>
        {sizingInvalid && (
          <p className="text-2xs text-destructive" role="alert">
            Value must be between {sizingBounds.min} and {sizingBounds.max} for {sizingBounds.label} sizing.
          </p>
        )}
        {ratioUnsupported && (
          <p className="text-2xs text-amber-600 dark:text-amber-400" role="alert">
            Multiple sizing needs the source trader&apos;s quantity. Caller signals are content-only, so this destination will be skipped.
          </p>
        )}
        {pendingMode && (
          <p className="text-2xs text-amber-600 dark:text-amber-400" role="note">
            Not saved. Enter a size for {sizingBounds.label} before this destination changes basis.
          </p>
        )}
      </div>

      {destination === "perp" && (
        <div className="mt-3 min-w-0 space-y-3">
          <div className="grid min-w-0 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)] sm:items-center">
            <div className="min-w-0">
              <p className="text-2xs font-medium">Leverage cap</p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                {validPerpLeverage(globalPerpMaxLeverage)
                  ? `Up to ${globalPerpMaxLeverage}x globally. This follow can be lower.`
                  : "Unavailable until a valid global cap loads."}
              </p>
            </div>
            <Select
              value={follow.perpMaxLeverage == null ? "global" : String(follow.perpMaxLeverage)}
              disabled={disabled || globalPerpMaxLeverage === null}
              onValueChange={(value) => {
                if (value === "global") {
                  if (follow.perpMaxLeverage !== null) onPerpUpdate({ perpMaxLeverage: null });
                  return;
                }
                const next = Number(value);
                if (
                  !validPerpLeverage(next) ||
                  !validPerpLeverage(globalPerpMaxLeverage) ||
                  next > globalPerpMaxLeverage ||
                  next === follow.perpMaxLeverage
                ) {
                  return;
                }
                onPerpUpdate({ perpMaxLeverage: next });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full min-w-0"
                id={leverageControlId}
                aria-label="Perp leverage cap"
              >
                <SelectValue placeholder="Use global" />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="global">
                  {validPerpLeverage(globalPerpMaxLeverage)
                    ? `Use global (${globalPerpMaxLeverage}x)`
                    : "Use global"}
                </SelectItem>
                {validPerpLeverage(globalPerpMaxLeverage) &&
                  Array.from(
                    { length: globalPerpMaxLeverage - COPY_PERP_MAX_LEVERAGE_MIN + 1 },
                    (_, index) => index + COPY_PERP_MAX_LEVERAGE_MIN,
                  ).map((leverage) => (
                    <SelectItem key={leverage} value={String(leverage)}>
                      {leverage}x maximum
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {leverageInvalid && (
            <p className="text-2xs text-destructive" role="alert">
              The saved per-follow leverage cap is invalid for the current global cap. Fix it before arming.
            </p>
          )}

          <div className="min-w-0">
            <p className="text-2xs font-medium">ROE protection</p>
            <div className="mt-1.5 grid min-w-0 gap-2 sm:grid-cols-2">
              {PERP_PROTECTION_LEGS.map((leg) => {
                const bounds = PERP_PROTECTION_PRESENTATION[leg];
                const invalid = protectionDraftInvalid(draft.protection[leg], bounds);
                return (
                  <label key={leg} className="min-w-0">
                    <span className="block text-2xs text-muted-foreground">{bounds.label}</span>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5">
                      <Input
                        type="number"
                        id={`${idNamespace}-${leg}`}
                        min={bounds.min}
                        max={bounds.max}
                        step={bounds.step}
                        value={draft.protection[leg]}
                        disabled={disabled}
                        placeholder="Off"
                        onChange={(event) =>
                          onDraftChange(
                            leg === "stopLoss"
                              ? { protection: { stopLoss: event.target.value } }
                              : { protection: { takeProfit: event.target.value } },
                          )
                        }
                        onBlur={() => commitProtection(leg)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitProtection(leg);
                        }}
                        aria-label={`${presentation.label}: ${bounds.aria}`}
                        aria-invalid={invalid ? "true" : "false"}
                        className={cn("h-8 w-20 shrink-0 tabular-nums", invalid && "border-destructive")}
                      />
                      <span className="min-w-0 text-2xs text-muted-foreground">{bounds.caption}</span>
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="mt-1.5 text-2xs text-muted-foreground">
              {savedProtection
                ? describePerpProtection(savedProtection)
                : "Leave both empty for no automatic exit. Signal-post positions are not closed for you."}
            </p>
            {protectionInvalid && (
              <p className="mt-1 text-2xs text-destructive" role="alert">
                Use the allowed range for each ROE protection level before saving.
              </p>
            )}
          </div>

          <p className="flex min-w-0 items-start gap-1.5 text-2xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>Hyperliquid is a live leveraged exchange. A perp position can be liquidated.</span>
          </p>
        </div>
      )}

      {destination === "stock" &&
        config.credentialId === balancesCredentialId &&
        (() => {
          const projected = estimateProjectedDollars(
            config.sizingMode,
            config.sizingValue,
            buyingPower,
            equity,
          );
          if (projected === null) return null;
          const ceiling = limits.maxOrderDollars ?? DEFAULT_PER_ORDER_CEILING;
          return (
            <p className="mt-3 text-2xs text-muted-foreground">
              About {formatUsd(projected)} per order at the selected account&apos;s current balance. The worker still enforces the {formatUsd(ceiling)} ceiling.
            </p>
          );
        })()}
    </section>
  );
}
