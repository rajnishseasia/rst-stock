/**
 * Keeps the terminal workspace in sync between this browser and the user's
 * saved account setting.
 *
 * This is the STATEFUL half of that feature. The pure decision rules already
 * live in `@/lib/terminal-layout-sync` (what to hydrate, what is worth a write)
 * and the write ordering lives in `./layout-save-queue`; both are unit-tested.
 * What remained was the React wiring that binds them together, and it sat inline
 * in `page.tsx` next to three thousand lines of unrelated terminal UI. Audit H7
 * asks for that wiring to become a named hook once the pure parts are out, and
 * this area in particular earned it: every bug found here so far was a wiring
 * bug (a mirror updated by the wrong mount, a guard released without re-running
 * the effect it suppressed, a queue rebuilt per mount) and none of them were
 * reachable except by reading the page.
 *
 * The hook owns:
 *   - hydration, including reconciling an account read that only succeeds after
 *     a local fallback was already painted
 *   - the shared, cross-mount write queue and the dependencies it calls into
 *   - the debounced account write, and the flush on unmount
 *   - the ACCOUNT half of a workspace reset
 *
 * It deliberately does NOT own the local-state half of a reset, nor the
 * localStorage mirrors: those are plain writes the page already performs where
 * the state lives.
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { trpc } from "@/lib/trpc";
import {
  LEFT_DRAWER_MAX_WIDTH,
  RIGHT_DRAWER_DEFAULT_WIDTH,
  migrateLegacyRightDrawerWidth,
  parseStoredDrawerWidths,
  shouldCommitRightDrawerMigration,
} from "@/components/terminal/drawer-layout";
import {
  DEFAULT_TERMINAL_LAYOUT,
  parseTerminalLayout,
  type TerminalLayoutState,
} from "@/components/terminal/terminal-layout-state";
import {
  buildLayoutPayload,
  didUserEditSincePaint,
  resolveHydrationAction,
  resolveInitialLayout,
  shouldPersistLayout,
  type SavedTerminalLayout,
} from "@/lib/terminal-layout-sync";
import {
  createLayoutSaveQueue,
  type LayoutSaveQueue,
} from "./layout-save-queue";

/**
 * The localStorage keys for this browser's copy of the workspace.
 *
 * Exported because the page still writes both mirrors itself; hydration reads
 * them here, so one module states the key rather than two agreeing by accident.
 */
export const TERMINAL_LAYOUT_STORAGE_KEY = "ready-set-trade.terminal-layout.v1";
export const TERMINAL_DRAWER_WIDTHS_STORAGE_KEY =
  "ready-set-trade.terminal-drawer-widths.v1";
export const DISCOVERY_COLLAPSED_STORAGE_KEY =
  "ready-set-trade.discovery-collapsed.v1";

export function parseDiscoveryCollapsed(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function resolveDiscoveryCollapsed(
  persisted: string | null,
  fallback: boolean,
): boolean {
  return parseDiscoveryCollapsed(persisted) ?? fallback;
}
/** Settle time before writing a layout change to the account setting. Long
 *  enough that a splitter drag produces one write, not one per pointer move. */
const LAYOUT_SAVE_DEBOUNCE_MS = 800;
/** Backoff before retrying a layout save that failed while a newer payload was
 *  already queued. Long enough that a sustained outage does not spin the queue. */
const LAYOUT_SAVE_RETRY_MS = 5_000;
/**
 * The one-time marker that closed the left drawer for users who predate it.
 * Its ABSENCE is the migration signal, which is why the account-layout guard
 * below matters: every new browser is missing it.
 */
const LEFT_DRAWER_MIGRATION_KEY = "ready-set-trade.bullpen-layout.v2";
/**
 * The one-time marker for the right drawer's new default width. Same shape as
 * the left-drawer marker above: its ABSENCE is the migration signal.
 *
 * A version bump on TERMINAL_DRAWER_WIDTHS_STORAGE_KEY was the other option and
 * is worse twice over: it would also orphan the LEFT width the user chose, and
 * it would do nothing at all for the account-saved copy, which is where a
 * signed-in user's 560 actually lives.
 */
const RIGHT_DRAWER_DEFAULT_MIGRATION_KEY =
  "ready-set-trade.right-drawer-default.v1";

/**
 * Apply the right-drawer default-width migration to a persisted width, from
 * either store, and record that this browser has now done it.
 *
 * Marking on the way through is what keeps it one-shot: after this, a width of
 * exactly RIGHT_DRAWER_MAX_WIDTH means the user dragged the splitter to the end
 * and is restored like any other choice.
 *
 * `commit` is what keeps the one shot from being spent on a fallback paint: see
 * shouldCommitRightDrawerMigration, which decides it. When it is false the
 * width is still migrated for THIS paint, but the browser stays unmarked, so the
 * account read that recovers a moment later migrates again rather than
 * restoring the legacy width as a deliberate choice.
 */
function resolveMigratedRightWidth(
  width: number | null | undefined,
  { commit }: { commit: boolean },
): number | null {
  const alreadyMigrated = Boolean(
    window.localStorage.getItem(RIGHT_DRAWER_DEFAULT_MIGRATION_KEY),
  );
  const resolved = migrateLegacyRightDrawerWidth(width, { alreadyMigrated });
  if (commit) {
    window.localStorage.setItem(RIGHT_DRAWER_DEFAULT_MIGRATION_KEY, "1");
  }
  return resolved;
}

/**
 * The layout write queue, and the user it belongs to.
 *
 * Module scope on purpose: see `acquireSharedLayoutQueue`. A queue that is
 * recreated per mount cannot honor "one write in flight", because the work from
 * the previous mount is still running.
 */
let sharedLayoutQueue: LayoutSaveQueue<SavedTerminalLayout> | null = null;
let sharedLayoutQueueUserId: string | null = null;

/** What the shared queue needs from whichever mount is currently live. */
export interface LayoutQueueDeps {
  save: (payload: SavedTerminalLayout) => Promise<void>;
  reset: () => Promise<void>;
  onSaved: (payload: SavedTerminalLayout) => void;
  onCleared: () => void;
  onFailed: () => void;
}

/**
 * The dependencies the shared queue calls into, REBOUND by whichever mount is
 * currently live.
 *
 * Module scope for the same reason the queue is, and it has to be: the queue is
 * built once and its callbacks capture this object forever. Left as a per-mount
 * `useRef`, a remount created a new ref the queue never saw, so a completed
 * save updated the UNMOUNTED instance's mirror. The live mirror then stayed
 * stale, and if the user returned the layout to that stale value
 * `shouldPersistLayout` suppressed the write as a no-op while the account still
 * held the intermediate layout, so a reload restored the wrong workspace.
 *
 * Exported alongside `acquireSharedLayoutQueue` so the ownership rules the two
 * enforce together can be driven by a test rather than read.
 */
export const layoutQueueDeps: { current: LayoutQueueDeps | null } = {
  current: null,
};

/**
 * The single owner of the cross-mount write queue.
 *
 * MODULE-scoped, not per-mount. A save in flight (or waiting on its retry
 * timer) keeps running after navigation unmounts the page, and a fresh mount
 * used to build a second, independent queue: two queues each believing they
 * were the only writer, so a newer layout could be sent concurrently with the
 * old queue's payload and, if the old request finished last, the account kept
 * the OLDER one. The single-in-flight guarantee only means anything if there is
 * a single queue. Keyed by user so signing in as someone else does not inherit
 * the previous account's pending work.
 */
export function acquireSharedLayoutQueue(
  userId: string | null,
): LayoutSaveQueue<SavedTerminalLayout> {
  if (sharedLayoutQueueUserId !== userId) {
    // DISPOSE, do not merely drop. The previous user's queue is still
    // referenced by any in-flight request and any scheduled retry, and its
    // callbacks reach the shared dependency object that is about to be rebound
    // to the new user: a retry would send the old user's layout through the new
    // user's mutation, and a late completion would report the old payload as
    // the new account's saved state.
    sharedLayoutQueue?.dispose();
    sharedLayoutQueue = null;
    sharedLayoutQueueUserId = userId;
  }
  if (!sharedLayoutQueue) {
    sharedLayoutQueue = createLayoutSaveQueue<SavedTerminalLayout>({
      // Every call goes through the shared deps rather than a captured closure:
      // these are captured ONCE, and a direct closure would keep serving the
      // first mount for the life of the page.
      save: (payload) => layoutQueueDeps.current!.save(payload),
      reset: () => layoutQueueDeps.current!.reset(),
      onSaved: (payload) => layoutQueueDeps.current!.onSaved(payload),
      onCleared: () => layoutQueueDeps.current!.onCleared(),
      onFailed: () => layoutQueueDeps.current!.onFailed(),
      scheduleRetry: (run) => {
        window.setTimeout(run, LAYOUT_SAVE_RETRY_MS);
      },
    });
  }
  return sharedLayoutQueue;
}

export interface TerminalLayoutSyncOptions {
  isSignedIn: boolean;
  /** The signed-in user, or null. Owns queue and hydration identity. */
  userId: string | null;
  terminalLayout: TerminalLayoutState;
  setTerminalLayout: Dispatch<SetStateAction<TerminalLayoutState>>;
  terminalLayoutHydrated: boolean;
  setTerminalLayoutHydrated: Dispatch<SetStateAction<boolean>>;
  leftDrawerWidth: number;
  setLeftDrawerWidth: Dispatch<SetStateAction<number>>;
  rightDrawerWidth: number;
  setRightDrawerWidth: Dispatch<SetStateAction<number>>;
}

export interface TerminalLayoutSync {
  /**
   * Arm the reset guard. Must be called BEFORE the caller's own reset
   * `setState`s, so the persistence effect they schedule already sees the flag
   * on its very first run and never arms a debounced save that races the reset.
   */
  beginReset: () => void;
  /**
   * Clear the ACCOUNT copy and release the guard. Resolves true when the
   * account no longer holds the old workspace (including for a signed-out user,
   * who has no account copy to clear), false when the write failed.
   */
  commitReset: () => Promise<boolean>;
}

export function useTerminalLayoutSync({
  isSignedIn,
  userId,
  terminalLayout,
  setTerminalLayout,
  terminalLayoutHydrated,
  setTerminalLayoutHydrated,
  leftDrawerWidth,
  setLeftDrawerWidth,
  rightDrawerWidth,
  setRightDrawerWidth,
}: TerminalLayoutSyncOptions): TerminalLayoutSync {
  // The saved account layout. `enabled` on sign-in only; signed-out users keep
  // the localStorage-only behavior. `isFetched` (not `data`) gates hydration so
  // a user with NO saved layout still hydrates from localStorage promptly.
  const savedLayoutQuery = trpc.userSettings.getTerminalLayout.useQuery(
    undefined,
    { enabled: isSignedIn, staleTime: Infinity, retry: false },
  );
  const layoutUtils = trpc.useUtils();

  // Mirrors what is already persisted server-side, so an unchanged layout (a
  // re-render, or a drag that lands back where it started) writes nothing.
  const lastSavedLayoutRef = useRef<SavedTerminalLayout | null>(null);
  // The payload whose debounce timer is still running, or null when nothing is
  // waiting. Read only by the unmount flush.
  const pendingUnsavedLayoutRef = useRef<SavedTerminalLayout | null>(null);
  // The most recent payload this page has computed, whether or not it was
  // written. Read when the reset guard is released, to requeue anything the
  // guard suppressed while the reset was in flight.
  const latestLayoutPayloadRef = useRef<SavedTerminalLayout | null>(null);
  // True from the moment reset changes local state until its account write has
  // settled.
  const layoutResetInProgressRef = useRef(false);
  // Whether the layout currently on screen came from the ACCOUNT. A failed read
  // hydrates from localStorage instead, and TanStack Query can recover later on
  // focus/reconnect; without this the recovered layout would never be applied
  // and the local fallback would be written over it.
  const hydratedFromAccountRef = useRef(false);
  // What we last PAINTED, so a later reconciliation can tell the user's edits
  // from its own output. Seeded with the initial render's values.
  const paintedWorkspaceRef = useRef({
    layout: DEFAULT_TERMINAL_LAYOUT as TerminalLayoutState,
    leftWidth: LEFT_DRAWER_MAX_WIDTH,
    rightWidth: RIGHT_DRAWER_DEFAULT_WIDTH,
  });
  const hydratedForUserRef = useRef<string | null>(null);

  // Writing to the account is only safe once we have actually READ it. A failed
  // read also flips `isFetched`, and hydration then falls back to localStorage;
  // persisting that fallback would overwrite a perfectly good saved layout with
  // whatever this browser happened to have. `isSuccess` distinguishes "the user
  // has no saved layout" (null data) from "we could not find out".
  // "We read it and there is nothing" licenses a write. "We read it and could
  // not parse it" does not: a row written by a newer client, or corrupted, still
  // holds a workspace, and writing our local default over it destroys the very
  // thing we could not read. Both arrive as `layout: null`, so the server flags
  // the difference and it lands on the SAME guard that already blocks writes
  // after a failed read.
  const layoutReadSucceeded =
    !isSignedIn ||
    (savedLayoutQuery.isSuccess && !savedLayoutQuery.data?.unsupported);

  // Same guard, applied to the OTHER thing a hydration can persist. Widths are
  // migrated on whichever store hydration used, but the one-shot marker may only
  // be written when that store was authoritative, or a fallback paint burns the
  // migration for an account it never read.
  const commitRightDrawerMigration = shouldCommitRightDrawerMigration({
    isSignedIn,
    accountReadSucceeded: layoutReadSucceeded,
  });

  // The query is cached with `staleTime: Infinity`, so a mutation must update
  // the cache itself. Otherwise navigating away and back replays the ORIGINAL
  // response, which would restore a layout the user already changed or reset.
  const setCachedLayout = (layout: SavedTerminalLayout | null) => {
    // `unsupported: false` is correct here, not a placeholder: this cache write
    // only ever follows OUR OWN completed save or reset, so whatever the server
    // could not parse before has just been replaced by something it can.
    layoutUtils.userSettings.getTerminalLayout.setData(undefined, {
      layout,
      unsupported: false,
    });
  };
  // No per-call ordering logic here: the layout queue below serializes writes,
  // so at most one is ever in flight and the mirror/cache are updated by the
  // queue once a write actually completes.
  const saveLayoutMutation = trpc.userSettings.saveTerminalLayout.useMutation();
  // No onSuccess on the mutation: the queue owns the mirror and cache updates
  // for every write, so there is exactly one place that decides what "saved"
  // means. `userSettings.resetTerminalLayout` is deliberately NOT used here:
  // reset writes a default tombstone instead of clearing the row, so a reset is
  // distinguishable from an account that never saved anything. The procedure
  // stays available for a genuine "forget my layout".
  //
  // What "reset" means on the account: the default workspace, stated
  // explicitly. Built from the same parser the reset handler uses so the two
  // can never drift.
  const resetTombstonePayload = buildLayoutPayload(parseTerminalLayout(null), {
    left: LEFT_DRAWER_MAX_WIDTH,
    right: RIGHT_DRAWER_DEFAULT_WIDTH,
  });

  // Rebound on EVERY render of the live mount, so the shared queue always calls
  // into the instance the user is actually looking at.
  layoutQueueDeps.current = {
    save: async (payload) => {
      await saveLayoutMutation.mutateAsync({ layout: payload });
    },
    reset: async () => {
      // A TOMBSTONE, not a clear. Nulling the column made a reset
      // indistinguishable from an account that never saved a layout, so another
      // browser still holding the pre-reset copy in localStorage imported it,
      // found the mirror null, treated it as never saved, and wrote it back:
      // the reset was undone globally by the next device to open the app.
      // Storing the defaults explicitly means the account has an answer, the
      // server copy wins over any stale local one, and nothing is written back.
      await saveLayoutMutation.mutateAsync({ layout: resetTombstonePayload });
    },
    onSaved: (payload) => {
      // Only a completed write counts as saved.
      lastSavedLayoutRef.current = payload;
      setCachedLayout(payload);
    },
    onCleared: () => {
      // The account now HOLDS the defaults, so the mirror says so. Recording
      // null here would leave this browser believing nothing was saved, which
      // is what invites the very write-back the tombstone prevents.
      lastSavedLayoutRef.current = resetTombstonePayload;
      setCachedLayout(resetTombstonePayload);
    },
    // Leave nothing recorded as saved so a retry of the same payload is not
    // suppressed as a no-op. The layout is still in localStorage meanwhile.
    onFailed: () => {
      lastSavedLayoutRef.current = null;
    },
  };

  // Acquired during render, not in an effect: the persistence effect below can
  // enqueue on its very first run, so the queue has to exist by then.
  const layoutQueue = acquireSharedLayoutQueue(userId);

  // An identity change WITHOUT a page reload (another tab replaces the session
  // cookie) leaves this page holding the previous user's workspace: the layout
  // query takes no input, so its cache key is identity-free, and
  // `staleTime: Infinity` means the new account never fetches its own. The page
  // would keep showing the old workspace and write it to the new account on the
  // next edit. Reset the cache and re-run hydration from scratch.
  useEffect(() => {
    const previous = hydratedForUserRef.current;
    hydratedForUserRef.current = userId;
    if (previous === null || previous === userId) return;
    layoutUtils.userSettings.getTerminalLayout.reset();
    lastSavedLayoutRef.current = null;
    hydratedFromAccountRef.current = false;
    paintedWorkspaceRef.current = {
      layout: DEFAULT_TERMINAL_LAYOUT,
      leftWidth: LEFT_DRAWER_MAX_WIDTH,
      rightWidth: RIGHT_DRAWER_DEFAULT_WIDTH,
    };
    setTerminalLayout(DEFAULT_TERMINAL_LAYOUT);
    setTerminalLayoutHydrated(false);
    // `layoutUtils` is a stable tRPC utils object; the setters are stable
    // `useState` dispatchers; the rest are refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    const saved = savedLayoutQuery.data?.layout ?? null;
    // Reconcile a read that succeeded only AFTER we already hydrated from a
    // local fallback. Without this the early return below keeps the fallback,
    // while layoutReadSucceeded flips true and the persistence effect happily
    // overwrites the account with it, which is the exact clobber this feature
    // was supposed to make impossible.
    const userEdited = didUserEditSincePaint(
      {
        layout: terminalLayout,
        leftWidth: leftDrawerWidth,
        rightWidth: rightDrawerWidth,
      },
      paintedWorkspaceRef.current,
    );

    if (
      terminalLayoutHydrated &&
      isSignedIn &&
      savedLayoutQuery.isSuccess &&
      saved &&
      !hydratedFromAccountRef.current
    ) {
      if (userEdited) {
        // The read failed, we painted the local fallback, and the user has since
        // rearranged their workspace. Replacing it with the older account copy
        // now would discard work they did while we were unreachable. Settle the
        // account question and leave the mirror describing what the account
        // actually holds, so the persistence effect writes THEIR version over it.
        hydratedFromAccountRef.current = true;
        lastSavedLayoutRef.current = buildLayoutPayload(
          {
            version: 1 as const,
            left: { ...saved.left },
            right: { ...saved.right },
          },
          {
            left: saved.widths?.left ?? null,
            right: saved.widths?.right ?? null,
          },
        );
        return;
      }
      const recovered = {
        version: 1 as const,
        left: { ...saved.left },
        right: { ...saved.right },
      };
      recovered.left.collapsed = resolveDiscoveryCollapsed(
        window.localStorage.getItem(DISCOVERY_COLLAPSED_STORAGE_KEY),
        recovered.left.collapsed,
      );
      hydratedFromAccountRef.current = true;
      setTerminalLayout(recovered);
      // This branch only runs on a SUCCESSFUL account read, so the width is
      // authoritative and the marker is committed here even when the earlier
      // fallback paint deliberately left it unset.
      const recoveredRightWidth = resolveMigratedRightWidth(saved.widths?.right, {
        commit: commitRightDrawerMigration,
      });
      if (saved.widths?.left != null) setLeftDrawerWidth(saved.widths.left);
      if (recoveredRightWidth != null) setRightDrawerWidth(recoveredRightWidth);
      // The mirror describes the ACCOUNT, so it keeps the RAW width even when
      // the migration dropped it. That divergence is what makes the persistence
      // effect write the new default up, instead of leaving the account holding
      // 560 for every other browser to restore.
      lastSavedLayoutRef.current = buildLayoutPayload(recovered, {
        left: saved.widths?.left ?? null,
        right: saved.widths?.right ?? null,
      });
      paintedWorkspaceRef.current = {
        layout: recovered,
        leftWidth: saved.widths?.left ?? leftDrawerWidth,
        rightWidth: recoveredRightWidth ?? rightDrawerWidth,
      };
      return;
    }
    const action = resolveHydrationAction({
      isSignedIn,
      // `isFetched` (not `isSuccess`): a FAILED read still has to release
      // hydration, or a user whose account is unreachable never gets a layout.
      accountReadSettled: savedLayoutQuery.isFetched,
      alreadyHydrated: terminalLayoutHydrated,
      // Includes WIDTHS: resizing a drawer during a slow read leaves the layout
      // object untouched, so a layout-only check reported "no edit" and the
      // freshly chosen width was overwritten a moment later.
      layoutChangedSincePaint: userEdited,
    });
    // Waiting keeps the local paint on screen rather than flashing a saved
    // workspace in a moment after load.
    if (action.kind === "wait") return;

    if (action.kind === "keep-user-edit") {
      // Marked as settled so the recovery branch above does not re-apply the
      // account layout on the next run and undo this.
      hydratedFromAccountRef.current = true;
      // The mirror describes what the ACCOUNT holds, which is still the saved
      // layout. Leaving it accurate is what makes the persistence effect notice
      // the divergence and write the user's version.
      if (saved) {
        lastSavedLayoutRef.current = buildLayoutPayload(
          {
            version: 1 as const,
            left: { ...saved.left },
            right: { ...saved.right },
          },
          {
            left: saved.widths?.left ?? null,
            right: saved.widths?.right ?? null,
          },
        );
      }
      setTerminalLayoutHydrated(true);
      return;
    }

    const localLayout = parseTerminalLayout(
      window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY),
    );
    const localWidths = parseStoredDrawerWidths(
      window.localStorage.getItem(TERMINAL_DRAWER_WIDTHS_STORAGE_KEY),
    );
    // The account setting wins when present: a workspace arranged on one
    // machine should appear on the next, whose localStorage is still empty.
    const { layout: resolved } = resolveInitialLayout({
      serverLayout: saved
        ? { version: 1 as const, left: saved.left, right: saved.right }
        : null,
      localLayout,
      defaultLayout: localLayout,
    });

    const nextLayout = {
      version: 1 as const,
      left: { ...resolved.left },
      right: { ...resolved.right },
    };
    const localDiscoveryCollapsed = parseDiscoveryCollapsed(
      window.localStorage.getItem(DISCOVERY_COLLAPSED_STORAGE_KEY),
    );
    nextLayout.left.collapsed = resolveDiscoveryCollapsed(
      window.localStorage.getItem(DISCOVERY_COLLAPSED_STORAGE_KEY),
      nextLayout.left.collapsed,
    );
    // Legacy migration, and a MIGRATION, not a rule: the right rail took over
    // trade execution, so a layout from before that must not strand the user in
    // the old collapsed Tools state. An account layout is versioned and was
    // saved deliberately, so forcing it open there overrode an explicit
    // `right.collapsed: true`, and because the mirror is then seeded from the
    // overridden value no corrective write follows: the collapsed drawer the
    // user saved never came back on another browser. Same reasoning, and same
    // `!saved` guard, as the left-drawer migration below.
    if (!saved) nextLayout.right.collapsed = false;
    // One-time migration that closes the left drawer for users who predate it.
    // The marker lives in localStorage, so it is ABSENT on every new browser,
    // which is precisely where a restored account layout matters most. Applying
    // it there would slam the drawer shut against an explicit saved
    // `left.collapsed: false`, seed that overridden value as "already saved",
    // and so suppress the corrective write: the workspace would never come back
    // until the user reopened the drawer by hand. Only migrate when there is no
    // account layout to honor.
    if (
      localDiscoveryCollapsed == null &&
      !window.localStorage.getItem(LEFT_DRAWER_MIGRATION_KEY)
    ) {
      if (!saved) nextLayout.left.collapsed = true;
      window.localStorage.setItem(LEFT_DRAWER_MIGRATION_KEY, "1");
    }
    // The default workspace is painted and fully INTERACTIVE while the account
    // read is in flight, so on a slow connection a user can collapse a drawer or
    // switch a tab before the saved layout arrives. Applying it on top threw
    // that away with no indication their action had registered, which reads as
    // the app ignoring them. A deliberate action taken a second ago outranks a
    // layout saved on another day, so theirs wins and becomes what gets saved.
    //
    // Identity is the whole test: `terminalLayout` starts as the module-level
    // DEFAULT_TERMINAL_LAYOUT and every mutation replaces the object, so a
    // different reference here means a user action reached it.

    hydratedFromAccountRef.current = !!saved;
    setTerminalLayout(nextLayout);

    // Widths follow the same precedence. They are clamped by
    // parseStoredDrawerWidths locally and by the server schema remotely, so a
    // restored width can never render a drawer at zero or offscreen.
    const widths = saved?.widths ?? localWidths;
    // One-time: a right width of exactly the old maximum is what EVERY
    // workspace stored back when the drawer opened at its maximum, so restoring
    // it would keep existing users on 560 forever and the new default would
    // only ever be seen by new browsers. Runs against whichever store won
    // above, because the account copy holds the same 560.
    //
    // A failed account read reaches here too, with `widths` from localStorage.
    // The migration is applied to that paint, but NOT recorded: the recovery
    // branch above is what finishes it once the account is actually readable.
    const migratedRightWidth = resolveMigratedRightWidth(widths.right, {
      commit: commitRightDrawerMigration,
    });
    if (widths.left != null) setLeftDrawerWidth(widths.left);
    if (migratedRightWidth != null) setRightDrawerWidth(migratedRightWidth);

    // Seed the "already saved" mirror so hydration itself never triggers a
    // write back to the server. Deliberately the RAW width: the mirror states
    // what the ACCOUNT holds, and after a migration that is exactly what we
    // want the persistence effect to notice and correct.
    if (saved) {
      lastSavedLayoutRef.current = buildLayoutPayload(nextLayout, {
        left: widths.left ?? null,
        right: widths.right ?? null,
      });
    }
    // Record what we painted, so a later recovery can tell a user's edits from
    // this output rather than comparing against the module defaults.
    paintedWorkspaceRef.current = {
      layout: nextLayout,
      leftWidth: widths.left ?? leftDrawerWidth,
      rightWidth: migratedRightWidth ?? rightDrawerWidth,
    };
    setTerminalLayoutHydrated(true);
    // `terminalLayout` is read for the pre-hydration user-edit check above. It
    // is deliberately NOT a dependency: this effect calls setTerminalLayout, so
    // adding it would re-run the effect on its own write. The check only needs
    // to be correct on the run where the account read lands, and that run is
    // triggered by savedLayoutQuery, which re-reads current state anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isSignedIn,
    savedLayoutQuery.isFetched,
    savedLayoutQuery.data,
    terminalLayoutHydrated,
  ]);

  // Persist the workspace to the user's account so it is restored on any
  // browser, not just the one that wrote localStorage. Debounced because
  // dragging a splitter updates width on every pointer move; only the settled
  // value is worth a write, and `shouldPersistLayout` drops no-op payloads.
  useEffect(() => {
    // Cleared FIRST, on every run. This ref exists only to hand a still-pending
    // payload to the unmount flush, so it must never outlive the timer it
    // describes. Clicking Reset inside the debounce window cancelled the timer
    // but left the pre-reset payload here, and because a completed reset clears
    // the saved mirror, navigating away then flushed that payload and rebuilt
    // the account layout the user had just cleared.
    pendingUnsavedLayoutRef.current = null;

    if (!terminalLayoutHydrated || !isSignedIn) return;
    // Never write back a layout we derived from a fallback because the read
    // failed: that is how a good saved layout gets clobbered.
    if (!layoutReadSucceeded) return;
    const payload = buildLayoutPayload(terminalLayout, {
      left: leftDrawerWidth,
      right: rightDrawerWidth,
    });
    // Recorded BEFORE the reset guard can drop this run. Suppressing the write
    // during a reset is right, but the suppression has to be temporary: the
    // guard is released by clearing a ref, which schedules no render and so
    // never re-runs this effect, and the change was therefore dropped for good.
    // After a FAILED reset the account still holds the older layout, so the next
    // load overwrote the edit the user made while waiting.
    latestLayoutPayloadRef.current = payload;
    // The reset guard lives in shouldPersistLayout with the other write rules,
    // so it cannot be forgotten at a call site and is covered by its tests.
    if (
      !shouldPersistLayout(payload, lastSavedLayoutRef.current, {
        resetInProgress: layoutResetInProgressRef.current,
      })
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      // The "already saved" mirror is updated on success, not here. Marking it
      // saved optimistically meant a failed write left this browser believing
      // the account was up to date, so the layout silently stayed stale until
      // the user happened to make another distinct change.
      //
      // Writes are SERIALIZED, not merely sequence-checked. Ignoring a late
      // response only protects the local cache; it cannot undo a write the
      // server already applied, so two overlapping saves could still land in the
      // wrong order and leave the OLDER layout in the database, which the next
      // browser would faithfully restore. One request is in flight at a time and
      // the newest pending payload always goes last.
      layoutQueue.enqueueSave(payload);
      pendingUnsavedLayoutRef.current = null;
    }, LAYOUT_SAVE_DEBOUNCE_MS);
    // Held for the unmount flush below. The debounce is the whole exposure: a
    // user who changes the layout and navigates away inside the window lost the
    // account write entirely, and because localStorage HAD recorded the change,
    // the next mount gave the older account copy precedence and wrote it back
    // over the local one, so the change visibly reverted.
    pendingUnsavedLayoutRef.current = payload;
    return () => window.clearTimeout(timer);
    // `saveLayoutMutation` is intentionally omitted: its identity changes every
    // render, which would reset the debounce timer continuously. `layoutQueue`
    // is the module-scoped instance, stable for the life of the signed-in user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    terminalLayout,
    leftDrawerWidth,
    rightDrawerWidth,
    terminalLayoutHydrated,
    isSignedIn,
    layoutReadSucceeded,
  ]);

  // Flush on unmount. `[]` so the cleanup runs on unmount ONLY, never on a
  // dependency change: the persistence effect above already re-arms its own
  // timer in that case, and flushing there would defeat the debounce entirely
  // and write on every pointer move of a splitter drag.
  //
  // This covers client-side navigation, which is the reported case. A hard tab
  // close can still kill the request in flight; localStorage remains the
  // backstop there, and the account reconciles on the next deliberate change.
  useEffect(() => {
    return () => {
      const payload = pendingUnsavedLayoutRef.current;
      if (!payload) return;
      pendingUnsavedLayoutRef.current = null;
      if (
        !shouldPersistLayout(payload, lastSavedLayoutRef.current, {
          resetInProgress: layoutResetInProgressRef.current,
        })
      ) {
        return;
      }
      layoutQueue.enqueueSave(payload);
    };
    // Every value read here is a ref or the module-scoped queue instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginReset = () => {
    // Before the caller's setState calls, so the persistence effect they
    // schedule sees the flag on its very first run and never arms a debounced
    // save that would race the reset.
    layoutResetInProgressRef.current = true;
    // A reset supersedes any save still waiting on its debounce. Said here as
    // well as in the effect, because the effect only runs on the re-render the
    // caller triggers, and an unmount racing that render would flush the stale
    // payload.
    pendingUnsavedLayoutRef.current = null;
  };

  const commitReset = async (): Promise<boolean> => {
    // Clear the ACCOUNT copy too. Without this, reset would only clear this
    // browser and the next load would restore the old workspace from the saved
    // setting, making the button look broken.
    if (!isSignedIn) {
      // There is no account write to wait for, so release the guard here too.
      // The persistence effect already returns on `!isSignedIn`, but this page
      // survives a sign-in, and a flag left set would suppress every save after.
      layoutResetInProgressRef.current = false;
      return true;
    }
    // What a completed reset LOOKS like. Anything the user changes while the
    // request is in flight is requeued against this, not against the saved
    // mirror: a successful reset leaves that mirror null, so comparing to it
    // would treat the reset's own defaults as a change and write them straight
    // back onto the account we had just cleared.
    const resetBaseline = resetTombstonePayload;
    try {
      // Enqueued, not issued directly: this replaces any pending save AND waits
      // behind one already in flight, so a save can never land after the reset
      // and resurrect the old layout.
      //
      // The outcome comes from the queue itself rather than from re-reading the
      // queue afterwards. The queue swallows the request error to keep the
      // retry loop alive, and it empties the slot before awaiting, so there is
      // nothing left for this handler to observe: every reset looked successful,
      // including the ones that left the old layout sitting on the account.
      return await layoutQueue.requestReset();
    } finally {
      // Cleared in `finally`: leaving it set would suppress every future save
      // for the life of the page.
      layoutResetInProgressRef.current = false;
      // Anything the user changed WHILE the reset was in flight was suppressed
      // by that guard, and clearing a ref re-runs no effect, so it has to be
      // requeued explicitly or it is lost for good: after a FAILED reset the
      // account still holds the older layout, and the next load would overwrite
      // the edit they made while waiting.
      //
      // Compared to the reset BASELINE, never to the saved mirror. A successful
      // reset nulls that mirror, and `shouldPersistLayout` treats a null mirror
      // as "write it", so comparing there would push the reset's own defaults
      // back onto the account this reset had just cleared.
      const suppressed = latestLayoutPayloadRef.current;
      if (suppressed && shouldPersistLayout(suppressed, resetBaseline)) {
        layoutQueue.enqueueSave(suppressed);
      }
    }
  };

  return { beginReset, commitReset };
}
