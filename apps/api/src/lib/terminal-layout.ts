/**
 * Server-side validation for the saved terminal UI layout.
 *
 * The layout is persisted as a JSON blob on `users.terminal_layout` so a user's
 * workspace follows their account instead of a single browser's localStorage.
 * Because the blob comes straight from a client, it is validated here rather
 * than trusted: an unbounded or malformed object would otherwise be stored and
 * then handed back to every future session.
 *
 * The shape mirrors `TerminalLayoutState` in
 * `apps/web-v2/src/components/terminal/terminal-layout-state.ts`. It is
 * duplicated rather than imported because the web app is not a dependency of
 * the API. The `version` field is what makes that safe: a client running a
 * newer layout format writes a higher version, and readers that do not
 * recognize it fall back to their default instead of misreading the panes.
 */

import { z } from "zod";

/** Layout format version this server accepts. Bump when the shape changes. */
export const TERMINAL_LAYOUT_VERSION = 1;

/** Discovery (left) drawer tabs. */
export const LEFT_TERMINAL_TABS = [
  "x_signals",
  "signa",
  "watchlist",
  "copy_trade",
  "social",
  "hl_markets",
] as const;

/** Modules (right) drawer tabs. */
export const RIGHT_TERMINAL_TABS = [
  "trade",
  "ai",
  "positions",
  "orders",
  "portfolio",
] as const;

/**
 * A drawer renders at most two panes (single, or split into two). The cap is
 * enforced so a crafted payload cannot store an unbounded pane array that every
 * later page load would have to parse.
 */
const MAX_PANES_PER_DRAWER = 2;

/**
 * Pane slots, POSITIONAL and per side. Mirrors `PANE_IDS` in
 * `terminal-layout-state.ts`; see the file header on why the shape is duplicated.
 */
export const PANE_SLOTS = {
  left: ["left-a", "left-b"],
  right: ["right-a", "right-b"],
} as const;

function drawerSchema<T extends readonly [string, ...string[]]>(
  tabs: T,
  slots: readonly string[],
) {
  return z.object({
    collapsed: z.boolean(),
    split: z.enum(["bottom", "right"]).nullable(),
    panes: z
      .array(z.object({ id: z.string(), tab: z.enum(tabs) }))
      .min(1)
      .max(MAX_PANES_PER_DRAWER)
      // Pane ids are POSITIONAL slots, not free strings: the Nth pane must hold
      // the Nth slot for its own side. A saved layout is hydrated straight from
      // here without going through the browser's parser, so anything looser is
      // storable. Accepting a lone `left-b` is enough to break the drawer: the
      // client's `splitPane` appends the hard-coded "-b" slot, producing two
      // panes with the same id, hence duplicate React keys, a tab change that
      // hits both panes, and a close that removes both. Positional slots also
      // subsume the uniqueness rule this check replaces, since slots are
      // distinct by construction.
      .refine(
        (panes) => panes.every((pane, index) => pane.id === slots[index]),
        { message: "Pane ids must be this drawer's slots, in order" },
      ),
  })
    // `split` and the pane count are one fact expressed twice, and they must
    // agree: no split means exactly one pane, a split means exactly two. The
    // browser's parser enforces this (terminal-layout-state.ts), but a saved
    // layout is hydrated without it, so a crafted payload could restore a
    // two-pane drawer with `split: null`. TerminalDrawer then treats it as
    // split while neither split grid template applies, producing a broken
    // drawer the user cannot fix.
    .refine(
      (drawer) =>
        drawer.split === null
          ? drawer.panes.length === 1
          : drawer.panes.length === 2,
      {
        message:
          "A drawer with no split must have exactly one pane, and a split drawer exactly two",
      },
    );
}

/**
 * Drawer widths in pixels. Bounded so a stored value cannot render a drawer
 * offscreen or at zero width on a device with a different viewport than the one
 * that saved it; the client clamps to its own viewport as well.
 */
const drawerWidthSchema = z.number().int().min(160).max(1200).nullable();

export const terminalLayoutSettingSchema = z.object({
  version: z.literal(TERMINAL_LAYOUT_VERSION),
  left: drawerSchema(LEFT_TERMINAL_TABS, PANE_SLOTS.left),
  right: drawerSchema(RIGHT_TERMINAL_TABS, PANE_SLOTS.right),
  widths: z
    .object({ left: drawerWidthSchema, right: drawerWidthSchema })
    .optional(),
});

export type TerminalLayoutSetting = z.infer<typeof terminalLayoutSettingSchema>;

/**
 * The outcome of reading a stored layout, which is THREE cases, not two.
 *
 * "empty" and "unsupported" both yield no usable layout, but they must not be
 * reported the same way. A row written by a NEWER client (or corrupted) is not
 * an absent setting: told it was absent, the client hydrates its local default,
 * decides that is now the account's layout, and saves it, permanently
 * destroying the newer workspace it merely could not read. Falling back for
 * DISPLAY is the intent; overwriting is not.
 */
export type StoredLayoutStatus = "ok" | "empty" | "unsupported";

export interface StoredLayoutRead {
  status: StoredLayoutStatus;
  /** Non-null only for "ok". */
  layout: TerminalLayoutSetting | null;
}

/** Parse a layout blob read back out of the database, preserving WHY it failed. */
export function readStoredTerminalLayout(value: unknown): StoredLayoutRead {
  if (value == null) return { status: "empty", layout: null };
  const parsed = terminalLayoutSettingSchema.safeParse(value);
  if (parsed.success) return { status: "ok", layout: parsed.data };
  // Present, but this server cannot vouch for it: a newer version, or corrupt.
  return { status: "unsupported", layout: null };
}

/**
 * Layout-or-null convenience over `readStoredTerminalLayout`.
 *
 * Callers that write back MUST use the full read instead: this collapses
 * "unsupported" into null, which is exactly the distinction a writer needs.
 */
export function parseStoredTerminalLayout(
  value: unknown,
): TerminalLayoutSetting | null {
  return readStoredTerminalLayout(value).layout;
}
