/**
 * Pure decision logic for syncing the terminal layout between this browser and
 * the user's saved account setting.
 *
 * The layout has always persisted to localStorage, which only restores the
 * workspace on the browser that wrote it. The account setting
 * (`userSettings.getTerminalLayout` / `saveTerminalLayout`) makes it follow the
 * user instead. Both are kept: localStorage stays the instant, offline-capable
 * cache that avoids a layout flash on load, and the server copy is the durable
 * source of truth across browsers and devices.
 *
 * The precedence and change-detection rules live here, framework-free, so they
 * are unit-testable without React or a tRPC client.
 */

import type {
  TerminalLayoutState,
} from "@/components/terminal/terminal-layout-state";

/** Drawer widths in pixels; null means "no stored preference". */
export interface DrawerWidths {
  left: number | null;
  right: number | null;
}

/** The full persisted workspace: pane/drawer state plus drawer widths. */
export interface SavedTerminalLayout {
  version: 1;
  left: TerminalLayoutState["left"];
  right: TerminalLayoutState["right"];
  widths?: DrawerWidths;
}

/**
 * Choose which layout to apply on page load.
 *
 * The SERVER copy wins when present. It is the explicit account setting, and a
 * user who arranges their workspace on one machine expects that arrangement on
 * the next one, even though the new browser has its own (default) localStorage.
 * Falls back to this browser's local copy, then to whatever the caller passes as
 * the default, so a signed-out user or a failed fetch keeps the old behavior.
 */
export function resolveInitialLayout<T>({
  serverLayout,
  localLayout,
  defaultLayout,
}: {
  serverLayout: T | null | undefined;
  localLayout: T | null | undefined;
  defaultLayout: T;
}): { layout: T; source: "server" | "local" | "default" } {
  if (serverLayout != null) return { layout: serverLayout, source: "server" };
  if (localLayout != null) return { layout: localLayout, source: "local" };
  return { layout: defaultLayout, source: "default" };
}

/**
 * Build the payload written to the account setting from the live UI state.
 * Widths are included so a restored workspace has the same proportions, not
 * just the same tabs.
 */
export function buildLayoutPayload(
  layout: TerminalLayoutState,
  widths: DrawerWidths,
): SavedTerminalLayout {
  return {
    version: 1,
    left: layout.left,
    right: layout.right,
    widths: { left: roundWidth(widths.left), right: roundWidth(widths.right) },
  };
}

/**
 * Widths are stored as integer pixels, so round here rather than at every
 * caller.
 *
 * A drag stores raw `PointerEvent.clientX`, which is FRACTIONAL under browser
 * zoom or on a high-DPI display. The server schema requires `.int()`, so the
 * whole save was rejected, retried, and finally abandoned: an otherwise valid
 * layout change silently never persisted, and only for the users whose
 * displays produce subpixel coordinates. Rounding only the payload keeps the
 * live drag smooth while storing something the server accepts.
 */
function roundWidth(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * Whether a layout change is worth a network write.
 *
 * Dragging a splitter emits a value on every pointer move, so callers debounce;
 * this additionally suppresses writes that would store an identical payload
 * (for example a re-render, or a drag that returns to its starting width). A
 * stable JSON comparison is sufficient because `buildLayoutPayload` always
 * emits keys in the same order.
 */
export function shouldPersistLayout(
  next: SavedTerminalLayout,
  lastSaved: SavedTerminalLayout | null,
  options?: {
    /**
     * A reset is clearing the account copy right now.
     *
     * Reset sets the layout to the defaults, which arrives here as an ordinary
     * change. Two ways that broke reset: the debounced write could land AFTER
     * the reset cleared the account and put the default layout straight back,
     * and if it reached the write queue first it displaced the pending reset,
     * which then settled as a failure and toasted an error for a reset that was
     * about to succeed. Nothing is lost by skipping: localStorage is written by
     * its own path, and a completed reset clears the saved mirror, so the user's
     * next change is persisted normally.
     *
     * Checked BEFORE the null-mirror case, which is exactly the state a
     * completed reset leaves behind.
     */
    resetInProgress?: boolean;
  },
): boolean {
  if (options?.resetInProgress) return false;
  if (lastSaved == null) return true;
  return JSON.stringify(next) !== JSON.stringify(lastSaved);
}

/** What hydration should do on this run. */
export type HydrationAction =
  /** The account read has not landed yet. Keep painting what is on screen. */
  | { kind: "wait" }
  /** Apply the resolved layout (account copy when present, else local). */
  | { kind: "apply" }
  /**
   * The user changed the layout while the read was in flight. Keep their
   * version and treat hydration as settled.
   */
  | { kind: "keep-user-edit" };

/**
 * Decide what the hydration effect should do.
 *
 * The window this exists for: the default workspace is painted and fully
 * INTERACTIVE while the account read is in flight, so on a slow connection a
 * user can collapse a drawer or switch a tab before the saved layout arrives.
 * Applying the account copy on top discarded that silently, which reads as the
 * app ignoring a deliberate action. A choice made a second ago outranks a layout
 * saved on another day.
 *
 * `layoutChangedSincePaint` is an identity comparison at the call site: the
 * layout state starts as a module-level constant and every mutation replaces the
 * object, so a different reference means a user action reached it.
 */
export function resolveHydrationAction({
  isSignedIn,
  accountReadSettled,
  alreadyHydrated,
  layoutChangedSincePaint,
}: {
  isSignedIn: boolean;
  /** The account query has finished, successfully or not. */
  accountReadSettled: boolean;
  alreadyHydrated: boolean;
  layoutChangedSincePaint: boolean;
}): HydrationAction {
  if (alreadyHydrated) return { kind: "wait" };
  // A signed-out user has no account copy to wait for, so there is no window in
  // which an edit could be overwritten.
  if (isSignedIn && !accountReadSettled) return { kind: "wait" };
  if (isSignedIn && layoutChangedSincePaint) return { kind: "keep-user-edit" };
  return { kind: "apply" };
}

/**
 * Has the user changed the workspace since we last painted one?
 *
 * Compared against a SNAPSHOT of what was painted, not against the module
 * defaults, because there are two distinct paints: the initial hydration, and
 * the later reconciliation when a failed account read recovers on focus or
 * reconnect. Both must be able to tell a user's edit from their own output, and
 * only the first one had a guard.
 *
 * Widths are part of it. The first version of this check compared the layout
 * object alone, so resizing a drawer during a slow read left `terminalLayout`
 * untouched, reported "no edit", and the freshly chosen width was overwritten.
 *
 * Layout identity is a reference check: the state starts as a module-level
 * constant and every mutation replaces the object.
 */
export function didUserEditSincePaint<TLayout>(
  current: { layout: TLayout; leftWidth: number; rightWidth: number },
  painted: { layout: TLayout; leftWidth: number; rightWidth: number },
): boolean {
  return (
    current.layout !== painted.layout ||
    current.leftWidth !== painted.leftWidth ||
    current.rightWidth !== painted.rightWidth
  );
}
