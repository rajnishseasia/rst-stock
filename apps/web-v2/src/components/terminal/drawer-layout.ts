/**
 * Pure drawer-layout math for the desktop terminal (audit H7: extracted from
 * app/page.tsx so the width-balancing rules are unit-testable; behavior moved
 * verbatim).
 *
 * The terminal has a left drawer, a chart column, and a right drawer. Widths
 * persist to localStorage; on narrow viewports the flexible drawer space is
 * shrunk proportionally so the chart column never drops below its minimum.
 */

export const LEFT_DRAWER_MIN_WIDTH = 240;
export const LEFT_DRAWER_MAX_WIDTH = 520;
export const RIGHT_DRAWER_MIN_WIDTH = 300;
export const RIGHT_DRAWER_MAX_WIDTH = 560;
export const COLLAPSED_DRAWER_WIDTH = 48;
export const CHART_COLUMN_MIN_WIDTH = 640;

/**
 * What the Modules drawer OPENS at, which is not the same thing as how wide it
 * is allowed to get. The workspace spec asks for "approximately 340px"
 * (docs/superpowers/specs/2026-06-20-terminal-workspace-layout-design.md), and
 * the terminal instead initialised it at RIGHT_DRAWER_MAX_WIDTH.
 *
 * Those 220px were taken from the chart column, and the chart column spends
 * width on data: the instrument strip drops Oracle and Position below 880px and
 * 24h Vol and Position P&L below 1020px, and the perp positions table drops
 * RPNL and Margin below 880px and Funding below 1040px. The ticket that fills
 * the drawer is a fluid form with no container queries of its own and already
 * runs at RIGHT_DRAWER_MIN_WIDTH whenever a user drags the splitter in, so
 * nothing over there ever needed the maximum. Opening at the maximum only cost
 * the chart columns it could have shown.
 */
export const RIGHT_DRAWER_DEFAULT_WIDTH = 340;

/**
 * The width every workspace persisted before RIGHT_DRAWER_DEFAULT_WIDTH
 * existed, because the drawer used to open at its maximum and most users never
 * touch the splitter.
 *
 * It is a MIGRATION input, not a rule: see migrateLegacyRightDrawerWidth.
 */
export const LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH = RIGHT_DRAWER_MAX_WIDTH;

/**
 * Resolve a persisted right-drawer width, dropping the one value that is only
 * there because the drawer used to open at its maximum.
 *
 * `alreadyMigrated` is why this takes a flag instead of just comparing: the
 * legacy default IS the maximum, so it is also the easiest width to reach on
 * purpose (drag the splitter to the end and it clamps exactly there). Treating
 * 560 as "unset" forever would mean dragging the drawer fully open never
 * survived a reload. The caller records the migration once per browser, and
 * from then on a deliberate 560 is a width like any other.
 *
 * Returns null for "no stored preference", which is the caller's signal to keep
 * RIGHT_DRAWER_DEFAULT_WIDTH.
 */
export function migrateLegacyRightDrawerWidth(
  width: number | null | undefined,
  { alreadyMigrated }: { alreadyMigrated: boolean },
): number | null {
  if (width == null) return null;
  if (!alreadyMigrated && width === LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH) return null;
  return width;
}

/**
 * Whether a hydration is allowed to RECORD that this browser has migrated.
 *
 * Applying the migration and committing it are separate decisions, because a
 * signed-in user whose account read fails still gets a workspace: hydration
 * falls back to localStorage and the drawer is painted from that. Marking the
 * migration done on that paint would spend the one shot on a guess. The account
 * read can recover later (TanStack refetches on focus/reconnect), and it would
 * arrive at a browser already flagged as migrated, so the account's legacy width
 * would be restored as if the user had chosen it, mirrored back as saved, and
 * never corrected. That browser and account stay on the old width for good.
 *
 * So the marker is only committed when the width came from an authoritative
 * source: the account for a signed-in user, and localStorage for a signed-out
 * one, who has no account copy that could disagree.
 */
export function shouldCommitRightDrawerMigration({
  isSignedIn,
  accountReadSucceeded,
}: {
  isSignedIn: boolean;
  accountReadSucceeded: boolean;
}): boolean {
  return accountReadSucceeded || !isSignedIn;
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function parseStoredDrawerWidths(
  raw: string | null | undefined,
): { left?: number; right?: number } {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const result: { left?: number; right?: number } = {};
    if (typeof record.left === "number" && Number.isFinite(record.left)) {
      result.left = clampNumber(record.left, LEFT_DRAWER_MIN_WIDTH, LEFT_DRAWER_MAX_WIDTH);
    }
    if (typeof record.right === "number" && Number.isFinite(record.right)) {
      result.right = clampNumber(record.right, RIGHT_DRAWER_MIN_WIDTH, RIGHT_DRAWER_MAX_WIDTH);
    }
    return result;
  } catch {
    return {};
  }
}

export function balanceDrawerWidths({
  leftCollapsed,
  leftWidth,
  rightCollapsed,
  rightWidth,
  viewportWidth,
}: {
  leftCollapsed: boolean;
  leftWidth: number;
  rightCollapsed: boolean;
  rightWidth: number;
  viewportWidth: number;
}) {
  const leftMin = leftCollapsed ? COLLAPSED_DRAWER_WIDTH : LEFT_DRAWER_MIN_WIDTH;
  const leftMax = leftCollapsed ? COLLAPSED_DRAWER_WIDTH : LEFT_DRAWER_MAX_WIDTH;
  const rightMin = rightCollapsed ? COLLAPSED_DRAWER_WIDTH : RIGHT_DRAWER_MIN_WIDTH;
  const rightMax = rightCollapsed ? COLLAPSED_DRAWER_WIDTH : RIGHT_DRAWER_MAX_WIDTH;
  const maxDrawerTotal = Math.max(
    leftMin + rightMin,
    viewportWidth - CHART_COLUMN_MIN_WIDTH,
  );

  let nextLeft = clampNumber(
    leftCollapsed ? COLLAPSED_DRAWER_WIDTH : leftWidth,
    leftMin,
    leftMax,
  );
  let nextRight = clampNumber(
    rightCollapsed ? COLLAPSED_DRAWER_WIDTH : rightWidth,
    rightMin,
    rightMax,
  );
  const overflow = nextLeft + nextRight - maxDrawerTotal;

  if (overflow <= 0) {
    return { left: nextLeft, right: nextRight };
  }

  const leftFlex = leftCollapsed ? 0 : nextLeft - leftMin;
  const rightFlex = rightCollapsed ? 0 : nextRight - rightMin;
  const totalFlex = leftFlex + rightFlex;

  if (totalFlex <= 0) {
    return { left: nextLeft, right: nextRight };
  }

  const leftReduction = Math.min(leftFlex, overflow * (leftFlex / totalFlex));
  nextLeft -= leftReduction;
  nextRight -= Math.min(rightFlex, overflow - leftReduction);

  return {
    left: Math.round(nextLeft),
    right: Math.round(nextRight),
  };
}
