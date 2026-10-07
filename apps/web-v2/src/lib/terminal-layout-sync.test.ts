import { describe, expect, test } from "bun:test";
import {
  buildLayoutPayload,
  didUserEditSincePaint,
  resolveHydrationAction,
  resolveInitialLayout,
  shouldPersistLayout,
  type SavedTerminalLayout,
} from "./terminal-layout-sync";
import { DEFAULT_TERMINAL_LAYOUT } from "@/components/terminal/terminal-layout-state";

const LAYOUT = {
  version: 1 as const,
  left: {
    collapsed: false,
    split: null,
    panes: [{ id: "left-a", tab: "watchlist" as const }],
  },
  right: {
    collapsed: false,
    split: "bottom" as const,
    panes: [
      { id: "right-a", tab: "trade" as const },
      { id: "right-b", tab: "positions" as const },
    ],
  },
};

describe("resolveInitialLayout", () => {
  test("the saved account layout wins over this browser's copy", () => {
    // The point of the feature: a workspace arranged on one machine must show
    // up on the next one, whose localStorage still holds something else.
    const result = resolveInitialLayout({
      serverLayout: "from-server",
      localLayout: "from-local",
      defaultLayout: "fallback",
    });
    expect(result).toEqual({ layout: "from-server", source: "server" });
  });

  test("falls back to the local copy when nothing is saved to the account", () => {
    const result = resolveInitialLayout({
      serverLayout: null,
      localLayout: "from-local",
      defaultLayout: "fallback",
    });
    expect(result).toEqual({ layout: "from-local", source: "local" });
  });

  test("falls back to the default when there is neither", () => {
    const result = resolveInitialLayout({
      serverLayout: null,
      localLayout: null,
      defaultLayout: "fallback",
    });
    expect(result).toEqual({ layout: "fallback", source: "default" });
  });

  test("undefined is treated the same as null (signed out, or fetch failed)", () => {
    const result = resolveInitialLayout({
      serverLayout: undefined,
      localLayout: undefined,
      defaultLayout: DEFAULT_TERMINAL_LAYOUT,
    });
    expect(result.source).toBe("default");
  });
});

describe("buildLayoutPayload", () => {
  test("carries drawer state, pane tabs and widths", () => {
    const payload = buildLayoutPayload(LAYOUT, { left: 320, right: 400 });
    expect(payload.version).toBe(1);
    expect(payload.left.panes).toEqual([{ id: "left-a", tab: "watchlist" }]);
    expect(payload.right.split).toBe("bottom");
    expect(payload.widths).toEqual({ left: 320, right: 400 });
  });

  test("preserves null widths (no stored preference)", () => {
    const payload = buildLayoutPayload(LAYOUT, { left: null, right: null });
    expect(payload.widths).toEqual({ left: null, right: null });
  });
});

describe("shouldPersistLayout", () => {
  const payload = buildLayoutPayload(LAYOUT, { left: 320, right: 400 });

  test("saves when nothing has been saved yet", () => {
    expect(shouldPersistLayout(payload, null)).toBe(true);
  });

  test("does NOT save an identical payload", () => {
    // A re-render, or a splitter drag that returns to its starting width, must
    // not generate a network write.
    const same = buildLayoutPayload(LAYOUT, { left: 320, right: 400 });
    expect(shouldPersistLayout(payload, same)).toBe(false);
  });

  test("saves when a width changed", () => {
    const wider = buildLayoutPayload(LAYOUT, { left: 360, right: 400 });
    expect(shouldPersistLayout(wider, payload)).toBe(true);
  });

  test("saves when a pane's tab changed", () => {
    const retabbed = buildLayoutPayload(
      {
        ...LAYOUT,
        left: {
          ...LAYOUT.left,
          panes: [{ id: "left-a", tab: "social" as const }],
        },
      },
      { left: 320, right: 400 },
    );
    expect(shouldPersistLayout(retabbed, payload)).toBe(true);
  });

  test("saves when a drawer is collapsed", () => {
    const collapsed = buildLayoutPayload(
      { ...LAYOUT, left: { ...LAYOUT.left, collapsed: true } },
      { left: 320, right: 400 },
    );
    expect(shouldPersistLayout(collapsed, payload)).toBe(true);
  });
});

describe("shouldPersistLayout: a reset in flight suppresses the save", () => {
  const layout = (collapsed: boolean): SavedTerminalLayout => ({
    version: 1,
    left: { collapsed, split: null, panes: [{ id: "left-a", tab: "x_signals" }] },
    right: { collapsed: false, split: null, panes: [{ id: "right-a", tab: "trade" }] },
    widths: { left: null, right: null },
  });

  test("a genuine change still persists when no reset is running", () => {
    expect(shouldPersistLayout(layout(true), layout(false))).toBe(true);
  });

  test("no write while a reset is clearing the account", () => {
    // Reset sets the layout to the defaults, which reaches the persistence path
    // as an ordinary change. Left alone, the debounced write either landed after
    // the reset and put the default layout straight back, or reached the queue
    // first and displaced the pending reset, which then settled as a failure and
    // toasted an error for a reset that was about to succeed.
    expect(
      shouldPersistLayout(layout(true), layout(false), { resetInProgress: true }),
    ).toBe(false);
  });

  test("the reset guard outranks the never-saved case", () => {
    // A null mirror normally means "write it", which is exactly the state a
    // completed reset leaves behind. Checked first, or the guard would be a
    // no-op in the one situation it exists for.
    expect(
      shouldPersistLayout(layout(true), null, { resetInProgress: true }),
    ).toBe(false);
    expect(shouldPersistLayout(layout(true), null)).toBe(true);
  });
});

describe("resolveHydrationAction: an edit made while the read is in flight", () => {
  const base = {
    isSignedIn: true,
    accountReadSettled: false,
    alreadyHydrated: false,
    layoutChangedSincePaint: false,
  };

  test("waits for the account read before painting", () => {
    expect(resolveHydrationAction(base)).toEqual({ kind: "wait" });
  });

  test("applies the resolved layout once the read settles", () => {
    expect(
      resolveHydrationAction({ ...base, accountReadSettled: true }),
    ).toEqual({ kind: "apply" });
  });

  test("keeps an edit the user made while the read was in flight", () => {
    // The bug. The default workspace is painted AND interactive during the
    // read, so a user on a slow connection can collapse a drawer before the
    // saved layout lands. Applying the account copy on top discarded that with
    // no sign it had registered.
    expect(
      resolveHydrationAction({
        ...base,
        accountReadSettled: true,
        layoutChangedSincePaint: true,
      }),
    ).toEqual({ kind: "keep-user-edit" });
  });

  test("a signed-out user has no window to lose an edit in", () => {
    // Nothing is going to arrive and overwrite them, so their edit is simply
    // the layout, and hydration proceeds normally from localStorage.
    expect(
      resolveHydrationAction({
        ...base,
        isSignedIn: false,
        layoutChangedSincePaint: true,
      }),
    ).toEqual({ kind: "apply" });
  });

  test("a failed read still releases hydration", () => {
    // `accountReadSettled` is isFetched, not isSuccess: a user whose account is
    // unreachable must still get a workspace rather than an indefinite wait.
    expect(
      resolveHydrationAction({ ...base, accountReadSettled: true }),
    ).toEqual({ kind: "apply" });
  });

  test("never re-hydrates once hydrated, whatever else is true", () => {
    expect(
      resolveHydrationAction({
        ...base,
        accountReadSettled: true,
        alreadyHydrated: true,
        layoutChangedSincePaint: true,
      }),
    ).toEqual({ kind: "wait" });
  });
});

describe("didUserEditSincePaint", () => {
  const layoutA = { id: "a" };
  const layoutB = { id: "b" };
  const painted = { layout: layoutA, leftWidth: 320, rightWidth: 420 };

  test("no edit when nothing moved", () => {
    expect(didUserEditSincePaint({ ...painted }, painted)).toBe(false);
  });

  test("a WIDTH change counts as an edit", () => {
    // The gap in the first version: resizing a drawer during a slow read leaves
    // the layout object untouched, so a layout-only check reported "no edit"
    // and hydration overwrote the width the user had just chosen.
    expect(
      didUserEditSincePaint({ ...painted, leftWidth: 500 }, painted),
    ).toBe(true);
    expect(
      didUserEditSincePaint({ ...painted, rightWidth: 500 }, painted),
    ).toBe(true);
  });

  test("a layout change counts as an edit", () => {
    expect(didUserEditSincePaint({ ...painted, layout: layoutB }, painted)).toBe(
      true,
    );
  });

  test("compares against the PAINT, not a fixed default", () => {
    // The recovery path paints its own layout, so it must be able to tell a
    // user's later edit from its own output. Measuring against a constant
    // default would report every recovered workspace as a user edit.
    const recovered = { layout: layoutB, leftWidth: 300, rightWidth: 300 };
    expect(didUserEditSincePaint({ ...recovered }, recovered)).toBe(false);
    expect(
      didUserEditSincePaint({ ...recovered, leftWidth: 301 }, recovered),
    ).toBe(true);
  });
});

describe("a reset must survive on a browser that never saw it", () => {
  const localLayout = { id: "stale-local" };
  const defaultLayout = { id: "defaults" };

  test("an account holding the DEFAULTS beats a stale local copy", () => {
    // Why reset writes a default tombstone instead of clearing the row. With
    // null on the account, another browser still holding the pre-reset layout
    // imports it, finds the mirror null, treats it as never saved, and writes
    // it back: the reset is undone globally by the next device to open the app.
    const { layout, source } = resolveInitialLayout({
      serverLayout: defaultLayout,
      localLayout,
      defaultLayout,
    });
    expect(source).toBe("server");
    expect(layout).toBe(defaultLayout);
  });

  test("a NULL account still imports the local copy", () => {
    // The case the tombstone must not break: a user who has been working
    // locally and signs in for the first time keeps their workspace.
    const { layout, source } = resolveInitialLayout({
      serverLayout: null,
      localLayout,
      defaultLayout,
    });
    expect(source).toBe("local");
    expect(layout).toBe(localLayout);
  });

  test("the tombstone is a no-op write for the browser that already has it", () => {
    // Seeded as the mirror, so hydration itself queues nothing.
    const tombstone = { version: 1 as const, left: {}, right: {} } as never;
    expect(shouldPersistLayout(tombstone, tombstone)).toBe(false);
  });
});
