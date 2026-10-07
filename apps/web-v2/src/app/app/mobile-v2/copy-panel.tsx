"use client";

import { isValidElement, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import {
  MOBILE_COPY_TABS,
  MOBILE_LEADERBOARD_LABEL,
  isLeaderboardCopyTab,
  type MobileCopyTab,
} from "../mobile-shell";
import { isMobileVenueScopedTradersTab } from "./mobile-venue-scope";

export { MOBILE_COPY_TABS, type MobileCopyTab } from "../mobile-shell";

type DeploymentKind =
  | "unknown"
  | "off"
  | "on"
  | "disabled"
  | "enabled"
  | "ready"
  | "loading";

/**
 * A controller may pass already-written deployment copy, or the raw status
 * returned by the copy-trade status query. Keeping this input presentation
 * only means the wrapper never makes an API query or invents an arming state.
 */
export interface MobileCopyDeploymentDescriptor {
  kind?: DeploymentKind;
  status?: DeploymentKind;
  state?: DeploymentKind;
  visibility?: "visible" | "unknown";
  enabled?: boolean | null;
  headline?: string;
  detail?: string;
  message?: string;
}

export type MobileCopyDeploymentState =
  | ReactNode
  | MobileCopyDeploymentDescriptor;

export interface MobileCopyPanelProps {
  /** Which of the three Copy surfaces is mounted. Selected by the Traders strip. */
  activeTab: MobileCopyTab;
  /** The production CopyTradePanel, including its real Follow controls. */
  copyFeed: ReactNode;
  /** The production X-callers leaderboard body. */
  xCallers: ReactNode;
  /** The production users leaderboard body. */
  users: ReactNode;
  /** A controller-supplied link/button to the real copy risk settings flow. */
  riskSettingsAction?: ReactNode | (() => void);
  /** Deployment status/copy supplied by the controller, when available. */
  deploymentState?: MobileCopyDeploymentState;
  /**
   * The already-wired venue switch (Stocks | Perps), when the deployment has
   * perps. Rendered only above Following, because Following is the only Copy
   * surface the venue scopes: its feed is queried with the venue-derived
   * asset class. Top X and Top Users rank people, not markets, so painting a
   * venue control over them would be the pinned bar's problem again, one row
   * further down.
   */
  venueSwitch?: ReactNode;
  /**
   * Opens the leaderboard from inside the Copy surfaces, in the shell.
   *
   * Supplied by the Traders screen, which owns the tab setter, so the jump
   * lands on the board's own tab rather than routing out to `/lb` and
   * discarding the screen, the selected signal and the bottom nav. Omit it and
   * the leaderboard row is a label only, never a dead control.
   */
  onOpenLeaderboard?: () => void;
}

function hasRenderableContent(content: ReactNode): boolean {
  return (
    content !== null &&
    content !== undefined &&
    content !== false &&
    content !== true &&
    content !== ""
  );
}

function selectedTab(tab: MobileCopyTab): MobileCopyTab {
  return MOBILE_COPY_TABS.some((candidate) => candidate.value === tab)
    ? tab
    : MOBILE_COPY_TABS[0].value;
}

type MobileCopyContentState = "content" | "alert" | "status";

/**
 * Keep a small amount of state metadata on the shell-owned surface. The
 * authenticated panel remains the source of truth for its message; this only
 * lets the mobile frame give a directly supplied alert/status node enough
 * contrast and spacing to be readable.
 */
function contentStateFor(value: ReactNode): MobileCopyContentState {
  if (!isValidElement(value)) return "content";
  const role = (value.props as { role?: unknown }).role;
  return role === "alert" || role === "status" ? role : "content";
}

function contentStateClass(state: MobileCopyContentState): string {
  // A left rule, the same notice treatment the Markets and Traders screens
  // give a supplied alert/status node; never a box around a box.
  if (state === "alert") {
    return "border-l-2 border-[#8d4f4d] bg-[#301d20] px-3 py-3 text-[#ffd8d3]";
  }
  if (state === "status") {
    return "border-l-2 border-[#3d4d51] bg-[#0d2730] px-3 py-3 text-[#c8d8da]";
  }
  return "";
}

function deploymentKindFromString(value: string): DeploymentKind | null {
  switch (value.toLowerCase()) {
    case "unknown":
    case "off":
    case "on":
    case "disabled":
    case "enabled":
    case "ready":
    case "loading":
      return value.toLowerCase() as DeploymentKind;
    default:
      return null;
  }
}

function deploymentCopyForKind(kind: DeploymentKind): ReactNode {
  if (kind === "loading") {
    return (
      <>
        <p className="font-medium">Checking auto-mirroring status…</p>
        <p className="mt-1 text-xs text-[#b6c4c5]">
          Waiting for this deployment to report its auto-mirroring configuration.
        </p>
      </>
    );
  }

  if (kind === "unknown") {
    return (
      <>
        <p className="font-medium">Auto-mirroring status is unknown</p>
        <p className="mt-1 text-xs text-[#b6c4c5]">
          This deployment does not report whether the auto-mirror worker is
          running. Ask an operator before relying on an armed follow.
        </p>
      </>
    );
  }

  if (kind === "off" || kind === "disabled") {
    return (
      <>
        <p className="font-medium">Auto-mirroring is turned off</p>
        <p className="mt-1 text-xs text-[#b6c4c5]">
          Arming a follow saves the setting but places no orders until an
          operator turns auto-mirroring back on.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="font-medium">Auto-mirroring is configured</p>
      <p className="mt-1 text-xs text-[#b6c4c5]">
        This deployment reports its configuration; worker runtime status is not
        independently confirmed.
      </p>
    </>
  );
}

function isDeploymentDescriptor(
  value: object,
): value is MobileCopyDeploymentDescriptor {
  return (
    "kind" in value ||
    "status" in value ||
    "state" in value ||
    "visibility" in value ||
    "enabled" in value ||
    "headline" in value ||
    "detail" in value ||
    "message" in value
  );
}

function deploymentKindFromState(
  state: MobileCopyDeploymentState | undefined,
): DeploymentKind | null {
  if (state == null || typeof state === "boolean") return null;
  if (typeof state === "string") return deploymentKindFromString(state);
  if (isValidElement(state) || Array.isArray(state)) return null;
  if (typeof state !== "object" || !isDeploymentDescriptor(state)) return null;

  return (
    state.kind ??
    state.status ??
    state.state ??
    (state.visibility === "unknown"
      ? "unknown"
      : state.enabled === false
        ? "off"
        : state.enabled === true
          ? "on"
          : null)
  );
}

function deploymentIndicatorClass(kind: DeploymentKind | null): string {
  if (kind === "on" || kind === "enabled" || kind === "ready") {
    return "bg-[#d8b35a]";
  }
  if (kind === "off" || kind === "disabled") return "bg-[#e7c65d]";
  if (kind === "unknown" || kind === "loading") return "bg-[#8fb4c0]";
  return "bg-[#9bb0b8]";
}

/** Render a supplied status node, with a safe textual fallback for raw status objects. */
function deploymentCopy(state: MobileCopyDeploymentState | undefined): ReactNode {
  if (state == null || typeof state === "boolean") return null;

  if (typeof state === "string") {
    const kind = deploymentKindFromString(state);
    return kind ? deploymentCopyForKind(kind) : state;
  }

  // A React element/fragment is already the controller's honest copy. Keep it
  // intact so tests and callers can supply their own details and links.
  if (isValidElement(state) || Array.isArray(state)) return state;

  if (typeof state !== "object") return state;

  if (!isDeploymentDescriptor(state)) return null;

  const kind = state.kind ?? state.status ?? state.state;
  const resolvedKind =
    kind ??
    (state.visibility === "unknown"
      ? "unknown"
      : state.enabled === false
        ? "off"
        : state.enabled === true
          ? "on"
          : null);

  if (resolvedKind) {
    const fallback = deploymentCopyForKind(resolvedKind);
    // Preserve controller-provided headline/detail when a raw API status has
    // already been translated into a notice object.
    if (state.headline || state.detail || state.message) {
      return (
        <>
          {state.headline && <p className="font-medium">{state.headline}</p>}
          {(state.detail || state.message) && (
            <p className="mt-1 text-xs text-[#b6c4c5]">
              {state.detail ?? state.message}
            </p>
          )}
        </>
      );
    }
    return fallback;
  }

  return null;
}

function renderRiskSettingsAction(
  action: MobileCopyPanelProps["riskSettingsAction"],
): ReactNode {
  if (typeof action !== "function") return action;

  return (
    <button
      type="button"
      onClick={action}
      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#665b28] bg-[#272414] px-3 text-sm font-semibold text-[#e7c65d] transition-colors hover:border-[#a08b37] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e7c65d]"
      aria-label="Manage copy risk settings"
    >
      Manage risk settings
    </button>
  );
}

/** The strip's own name for a board, so this row can never rename one. */
function boardLabel(tab: MobileCopyTab): string {
  return MOBILE_COPY_TABS.find((candidate) => candidate.value === tab)?.label ?? "";
}

const LEADERBOARD_EYEBROW_CLASS =
  "shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#d1b95e]";

/**
 * The leaderboard's name, on the surface where the leaderboard actually lives.
 *
 * Both ranked boards have been mounted inside Traders since the destinations
 * were merged, but nothing on a phone said so: the word "Leaderboard" was
 * painted only in the hamburger, on a row that routes out to `/lb`, so a
 * genuine differentiator read as a menu item. This row is the fix, and it does
 * two jobs from one place in the layout:
 *
 * - standing ON a board it is a label (`Leaderboard | Top X`), naming the
 *   group the strip's board names belong to;
 * - standing on Following it is the entry (`Leaderboard | Rank callers and
 *   users, then follow >`), and the tap switches tabs INSIDE the shell rather
 *   than opening the standalone page.
 *
 * Typography and a hairline only. The eyebrow is the same gold caps the
 * automation row already uses, and gold stays a seasoning: no filled pill, no
 * card, no second tab row (the boards are selected by the Traders strip and
 * nowhere else).
 */
function renderLeaderboardRow(
  activeTab: MobileCopyTab,
  onOpenLeaderboard?: () => void,
): ReactNode {
  const divider = (
    <span aria-hidden="true" className="h-3 w-px shrink-0 bg-[#365762]" />
  );

  if (isLeaderboardCopyTab(activeTab)) {
    return (
      <div
        data-testid="mobile-copy-leaderboard-row"
        data-mobile-copy-leaderboard="heading"
        data-mobile-copy-leaderboard-board={activeTab}
        className="flex min-h-9 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-[#1a3b46] pb-2"
      >
        <span className={LEADERBOARD_EYEBROW_CLASS}>
          {MOBILE_LEADERBOARD_LABEL}
        </span>
        {divider}
        <span className="min-w-0 truncate text-[11px] leading-4 text-[#c4d4d8]">
          {boardLabel(activeTab)}
        </span>
      </div>
    );
  }

  if (!onOpenLeaderboard) return null;

  return (
    <button
      type="button"
      data-testid="mobile-copy-leaderboard-row"
      data-mobile-copy-leaderboard="entry"
      aria-label="Open the leaderboard"
      onClick={onOpenLeaderboard}
      className="flex min-h-11 w-full min-w-0 touch-manipulation items-center gap-2 overflow-hidden whitespace-nowrap border-b border-[#1a3b46] text-left transition-colors duration-150 hover:bg-white/[0.04] active:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d] motion-reduce:transition-none"
    >
      <span className={LEADERBOARD_EYEBROW_CLASS}>
        {MOBILE_LEADERBOARD_LABEL}
      </span>
      {divider}
      <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-[#c4d4d8]">
        Rank callers and users, then follow
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-[#8da5ad]"
      />
    </button>
  );
}

/**
 * The Copy surfaces of the mobile Traders destination: the selected body
 * (Following, Top X or Top Users) flat on the screen, then the automation
 * posture and the risk-settings action every Copy surface shares, as a
 * section under a hairline.
 *
 * Nothing here is a card. The body used to sit in a bordered, shadowed
 * surface, so the Following feed's own header, its sizing box and its input
 * ended up three borders deep; now the body, the automation note, the
 * deployment status and the risk action are separated by spacing and
 * hairlines only (DESIGN.md: borders and warm tints over shadows, and never
 * a card inside a card).
 *
 * This is deliberately a thin composition boundary. `copyFeed`, `xCallers`,
 * and `users` are supplied by the authenticated controller, and the inactive
 * bodies are absent from the tree so their polling queries cannot continue
 * off-screen. The tab strip that selects between them belongs to the Traders
 * screen; this panel owns no tab state and no tablist.
 */
export function MobileCopyPanel({
  activeTab,
  copyFeed,
  xCallers,
  users,
  riskSettingsAction,
  deploymentState,
  venueSwitch,
  onOpenLeaderboard,
}: MobileCopyPanelProps) {
  const active = selectedTab(activeTab);
  const deployment = deploymentCopy(deploymentState);
  const deploymentKind = deploymentKindFromState(deploymentState);
  const activeContent =
    active === "following" ? copyFeed : active === "x-callers" ? xCallers : users;
  const activeContentState = contentStateFor(activeContent);
  const activeContentStateClass = contentStateClass(activeContentState);
  // One source of truth for which surface the venue scopes: the same module
  // the shell asks before handing the control to a destination at all.
  const showsVenueSwitch =
    isMobileVenueScopedTradersTab(active) && hasRenderableContent(venueSwitch);

  return (
    <div
      data-testid="mobile-copy-panel"
      data-mobile-copy-workspace="true"
      data-mobile-copy-active-tab={active}
      className="flex min-w-0 flex-col gap-3"
    >
      {renderLeaderboardRow(active, onOpenLeaderboard)}

      {showsVenueSwitch ? (
        // One control row, the same shape Markets uses: a flat full-width
        // strip whose selected segment is brighter text over a gold hairline.
        // It scopes the feed below it, and it is the only place on Traders
        // that paints a venue control.
        <div
          data-mobile-copy-venue="true"
          className="min-w-0 shrink-0"
        >
          {venueSwitch}
        </div>
      ) : null}

      <div
        data-mobile-copy-panel={active}
        data-mobile-copy-panel-state={activeContentState}
        data-mobile-copy-panel-surface="true"
        data-mobile-copy-content={active}
        data-mobile-copy-state={activeContentState}
        className={`min-w-0 overflow-x-clip ${activeContentStateClass}`.trim()}
      >
        {activeContent}
      </div>

      <details
        data-testid="mobile-copy-automation-disclosure"
        data-mobile-copy-disclosure="true"
        open
        className="min-w-0 border-t border-[#1a3b46]"
      >
        <summary
          data-mobile-copy-disclosure-summary="true"
          className="flex min-h-11 cursor-pointer items-center gap-3 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#e7c65d]"
        >
          Automation and copy risk
        </summary>

        <div className="flex min-w-0 flex-col gap-2.5 pb-2">
          <div
            data-testid="mobile-copy-automation-context"
            data-mobile-copy-automation-context="true"
            data-mobile-copy-automation-row="true"
            role="note"
            aria-label="Manual copies stay one-off. Auto-mirroring only acts when the deployment is enabled and uses saved risk limits."
            title="Manual copies stay one-off. Auto-mirroring only acts when the deployment is enabled and uses saved risk limits."
            className="flex min-h-9 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap py-1.5"
          >
            <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#d1b95e]">
              Automation
            </span>
            <span aria-hidden="true" className="h-3 w-px shrink-0 bg-[#365762]" />
            <span className="min-w-0 truncate text-[11px] leading-4 text-[#c4d4d8]">
              Manual one-off copies · auto-mirroring uses saved risk limits
            </span>
          </div>

          {deployment != null && (
            <div
              className="flex min-w-0 items-start gap-2 text-sm text-[#dfe8eb]"
              data-testid="mobile-copy-deployment-state"
              data-mobile-copy-deployment-kind={deploymentKind ?? "provided"}
              role="status"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${deploymentIndicatorClass(deploymentKind)}`}
              />
              <div className="min-w-0 flex-1">{deployment}</div>
            </div>
          )}

          {riskSettingsAction != null && (
            <div
              className="flex min-w-0 flex-wrap gap-2 [&>a]:inline-flex [&>a]:min-h-11 [&>a]:items-center [&>a]:justify-center [&>a]:rounded-xl [&>a]:border-[#665b28] [&>a]:bg-[#272414] [&>a]:px-3 [&>a]:text-sm [&>a]:font-semibold [&>a]:text-[#e7c65d] [&>a]:transition-colors [&>a]:hover:border-[#a08b37] [&>a]:focus-visible:outline-none [&>a]:focus-visible:ring-2 [&>a]:focus-visible:ring-[#e7c65d] [&>button]:inline-flex [&>button]:min-h-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-xl [&>button]:border-[#665b28] [&>button]:bg-[#272414] [&>button]:px-3 [&>button]:text-sm [&>button]:font-semibold [&>button]:text-[#e7c65d] [&>button]:transition-colors [&>button]:hover:border-[#a08b37] [&>button]:focus-visible:outline-none [&>button]:focus-visible:ring-2 [&>button]:focus-visible:ring-[#e7c65d]"
              data-testid="mobile-copy-risk-settings"
            >
              {renderRiskSettingsAction(riskSettingsAction)}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
