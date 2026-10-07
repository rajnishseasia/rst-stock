import { describe, expect, test } from "bun:test";
import {
  DISCOVERY_COLLAPSED_STORAGE_KEY,
  TERMINAL_DRAWER_WIDTHS_STORAGE_KEY,
  TERMINAL_LAYOUT_STORAGE_KEY,
  acquireSharedLayoutQueue,
  layoutQueueDeps,
  parseDiscoveryCollapsed,
  resolveDiscoveryCollapsed,
  type LayoutQueueDeps,
} from "./use-terminal-layout-sync";
import type { SavedTerminalLayout } from "@/lib/terminal-layout-sync";

/**
 * Covers the part of the layout-sync hook that does NOT need a renderer: who
 * owns the write queue, and where its callbacks land.
 *
 * That ownership is the bug class this area kept producing. A queue rebuilt per
 * mount breaks the single-in-flight guarantee; a queue whose callbacks are
 * captured by the FIRST mount reports a completed save into an unmounted
 * instance's mirror, leaving the live one stale; a queue carried across a
 * sign-in writes one user's workspace to another's account. Each of those was
 * previously verified by reading page.tsx.
 *
 * The effects themselves (hydration precedence, the debounce, the unmount
 * flush) still need a DOM this app has no test environment for. Their decision
 * rules are covered against the real modules in lib/terminal-layout-sync.test.ts
 * and layout-save-queue.test.ts.
 */

function layout(id: string): SavedTerminalLayout {
  return {
    version: 1,
    left: { collapsed: false, split: null, panes: [{ id, tab: "watchlist" }] },
    right: { collapsed: false, split: null, panes: [{ id, tab: "trade" }] },
    widths: { left: 320, right: 320 },
  };
}

/** A dependency binding that records what the queue asked it to do. */
function binding() {
  const saved: SavedTerminalLayout[] = [];
  const state = { cleared: 0, failed: 0, resets: 0 };
  const deps: LayoutQueueDeps = {
    save: async () => {},
    reset: async () => {
      state.resets += 1;
    },
    onSaved: (payload) => {
      saved.push(payload);
    },
    onCleared: () => {
      state.cleared += 1;
    },
    onFailed: () => {
      state.failed += 1;
    },
  };
  return { deps, saved, state };
}

/** Let the queue's in-flight promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shared layout write queue ownership", () => {
  test("hands every mount of the same user the SAME queue", () => {
    // Two mounts with two queues each believe they are the only writer, so a
    // newer layout can go out concurrently with the older one and, if the old
    // request finishes last, the account keeps the OLDER workspace.
    const first = acquireSharedLayoutQueue("user-same");
    const second = acquireSharedLayoutQueue("user-same");

    expect(second).toBe(first);
  });

  test("routes callbacks to the LIVE binding, not the one that built it", async () => {
    const live = binding();
    layoutQueueDeps.current = live.deps;
    const queue = acquireSharedLayoutQueue("user-rebind");

    queue.enqueueSave(layout("first-mount"));
    await settle();
    expect(live.saved).toEqual([layout("first-mount")]);

    // Remount: the queue is the same instance, but its dependencies now belong
    // to the mount the user is actually looking at. A save completing after
    // this must update THAT mount's mirror. When it updated the previous one
    // instead, the live mirror stayed stale, and returning the layout to that
    // stale value was then suppressed as a no-op while the account still held
    // the intermediate workspace.
    const remounted = binding();
    layoutQueueDeps.current = remounted.deps;

    queue.enqueueSave(layout("second-mount"));
    await settle();

    expect(remounted.saved).toEqual([layout("second-mount")]);
    expect(live.saved).toEqual([layout("first-mount")]);
  });

  test("disposes the previous user's queue when the identity changes", async () => {
    layoutQueueDeps.current = binding().deps;
    const previous = acquireSharedLayoutQueue("user-a");
    const next = acquireSharedLayoutQueue("user-b");

    expect(next).not.toBe(previous);
    // Disposed, not merely dropped: the old queue is still referenced by any
    // in-flight request and any scheduled retry, and its callbacks reach the
    // shared dependency object that now belongs to the NEW user.
    await expect(previous.requestReset()).resolves.toBe(false);
  });

  test("keeps a signed-out session on its own queue", () => {
    layoutQueueDeps.current = binding().deps;
    const signedIn = acquireSharedLayoutQueue("user-signed-in");
    const signedOut = acquireSharedLayoutQueue(null);

    expect(signedOut).not.toBe(signedIn);
    expect(acquireSharedLayoutQueue(null)).toBe(signedOut);
  });
});

describe("terminal layout storage keys", () => {
  test("pins the durable localStorage keys", () => {
    // Renaming either one orphans every existing user's cached workspace: the
    // old value is never read again, so the terminal opens at the defaults on
    // the browser they arranged it in.
    expect(TERMINAL_LAYOUT_STORAGE_KEY).toBe("ready-set-trade.terminal-layout.v1");
    expect(TERMINAL_DRAWER_WIDTHS_STORAGE_KEY).toBe(
      "ready-set-trade.terminal-drawer-widths.v1",
    );
    expect(DISCOVERY_COLLAPSED_STORAGE_KEY).toBe(
      "ready-set-trade.discovery-collapsed.v1",
    );
  });

  test("parses only explicit persisted Discovery states", () => {
    expect(parseDiscoveryCollapsed("true")).toBe(true);
    expect(parseDiscoveryCollapsed("false")).toBe(false);
    expect(parseDiscoveryCollapsed(null)).toBeNull();
    expect(parseDiscoveryCollapsed("broken")).toBeNull();
  });

  test("a local Discovery choice overrides either account state", () => {
    expect(resolveDiscoveryCollapsed("false", true)).toBe(false);
    expect(resolveDiscoveryCollapsed("true", false)).toBe(true);
    expect(resolveDiscoveryCollapsed(null, true)).toBe(true);
  });
});
