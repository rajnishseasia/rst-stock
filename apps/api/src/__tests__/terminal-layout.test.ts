/**
 * Validation for the saved terminal-layout setting.
 *
 * The blob is supplied by a client and read back into every later session, so
 * these tests pin the rejection cases (unknown tabs, unbounded pane arrays,
 * absurd widths) rather than only the happy path.
 */

import { describe, expect, test } from "bun:test";
import {
  readStoredTerminalLayout,
  parseStoredTerminalLayout,
  terminalLayoutSettingSchema,
} from "../lib/terminal-layout.js";

const VALID = {
  version: 1,
  left: {
    collapsed: false,
    split: null,
    panes: [{ id: "left-a", tab: "watchlist" }],
  },
  right: {
    collapsed: false,
    split: "bottom",
    panes: [
      { id: "right-a", tab: "trade" },
      { id: "right-b", tab: "positions" },
    ],
  },
  widths: { left: 320, right: 400 },
};

describe("terminalLayoutSettingSchema", () => {
  test("accepts a well-formed layout", () => {
    expect(terminalLayoutSettingSchema.safeParse(VALID).success).toBe(true);
  });

  test("accepts a layout with no widths (never resized)", () => {
    const { widths: _widths, ...noWidths } = VALID;
    expect(terminalLayoutSettingSchema.safeParse(noWidths).success).toBe(true);
  });

  test("accepts null widths", () => {
    const nulled = { ...VALID, widths: { left: null, right: null } };
    expect(terminalLayoutSettingSchema.safeParse(nulled).success).toBe(true);
  });

  test("rejects an unknown tab name", () => {
    const bad = {
      ...VALID,
      left: { ...VALID.left, panes: [{ id: "left-a", tab: "not_a_tab" }] },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a right-drawer tab in the left drawer", () => {
    // The two drawers have different tab sets; a left pane cannot host "trade".
    const bad = {
      ...VALID,
      left: { ...VALID.left, panes: [{ id: "left-a", tab: "trade" }] },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an unbounded pane array", () => {
    // A drawer renders at most two panes; storing more would be parsed on every
    // future page load.
    const bad = {
      ...VALID,
      left: {
        ...VALID.left,
        panes: Array.from({ length: 50 }, (_, i) => ({
          id: `left-${i}`,
          tab: "watchlist",
        })),
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an empty pane array", () => {
    const bad = { ...VALID, left: { ...VALID.left, panes: [] } };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects widths that would render a drawer unusable", () => {
    for (const width of [0, 12, 99999]) {
      const bad = { ...VALID, widths: { left: width, right: 400 } };
      expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("rejects a pane id with unexpected characters", () => {
    const bad = {
      ...VALID,
      left: {
        ...VALID.left,
        panes: [{ id: "<script>", tab: "watchlist" }],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a future layout version", () => {
    const bad = { ...VALID, version: 2 };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });
});

describe("parseStoredTerminalLayout", () => {
  test("returns the layout when the stored row is valid", () => {
    expect(parseStoredTerminalLayout(VALID)?.left.panes[0]?.tab).toBe(
      "watchlist",
    );
  });

  test("returns null when nothing was ever saved", () => {
    expect(parseStoredTerminalLayout(null)).toBeNull();
    expect(parseStoredTerminalLayout(undefined)).toBeNull();
  });

  test("returns null instead of throwing on a corrupted or newer row", () => {
    // Null means "no saved setting", so the client falls back to its local copy
    // and then the default. A bad row must degrade, never break the page.
    expect(parseStoredTerminalLayout({ version: 99 })).toBeNull();
    expect(parseStoredTerminalLayout("not-an-object")).toBeNull();
    expect(parseStoredTerminalLayout({ left: {}, right: {} })).toBeNull();
  });
});

describe("pane ids are positional slots", () => {
  test("rejects two panes sharing an id in the same drawer", () => {
    // The browser parser rejects these, but a saved layout is hydrated without
    // it, so the server has to be the one that refuses.
    const bad = {
      ...VALID,
      right: {
        ...VALID.right,
        split: "bottom",
        panes: [
          { id: "right-a", tab: "trade" },
          { id: "right-a", tab: "positions" },
        ],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
    expect(parseStoredTerminalLayout(bad)).toBeNull();
  });

  test("rejects a lone second-slot pane", () => {
    // The one that made mere uniqueness insufficient. A single pane holding
    // "left-b" is internally consistent, so a uniqueness check waves it through
    // -- and then the client's splitPane appends its hard-coded "left-b",
    // producing the duplicate the uniqueness check existed to prevent.
    const bad = {
      ...VALID,
      left: { collapsed: false, split: null, panes: [{ id: "left-b", tab: "watchlist" }] },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
    expect(parseStoredTerminalLayout(bad)).toBeNull();
  });

  test("rejects the right slots in the wrong order", () => {
    const bad = {
      ...VALID,
      right: {
        collapsed: false,
        split: "bottom",
        panes: [
          { id: "right-b", tab: "trade" },
          { id: "right-a", tab: "positions" },
        ],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects the OTHER drawer's slots", () => {
    // Slots are per side. "right-a" in the left drawer is not a namespace
    // curiosity: the left drawer's splitPane appends "left-b", so the pair would
    // not be a valid slot sequence either.
    const bad = {
      ...VALID,
      left: { collapsed: false, split: null, panes: [{ id: "right-a", tab: "watchlist" }] },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("accepts each drawer's own slots, in order", () => {
    const ok = {
      ...VALID,
      left: { collapsed: false, split: null, panes: [{ id: "left-a", tab: "watchlist" }] },
      right: {
        collapsed: false,
        split: "bottom",
        panes: [
          { id: "right-a", tab: "trade" },
          { id: "right-b", tab: "positions" },
        ],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(ok).success).toBe(true);
  });
});

describe("split and pane count must agree", () => {
  test("rejects two panes with no split", () => {
    // TerminalDrawer would treat this as split while no split grid template
    // applies, leaving a drawer the user cannot repair.
    const bad = {
      ...VALID,
      right: {
        collapsed: false,
        split: null,
        panes: [
          { id: "right-a", tab: "trade" },
          { id: "right-b", tab: "positions" },
        ],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a split with only one pane", () => {
    const bad = {
      ...VALID,
      right: {
        collapsed: false,
        split: "bottom",
        panes: [{ id: "right-a", tab: "trade" }],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(bad).success).toBe(false);
  });

  test("accepts the two consistent shapes", () => {
    expect(terminalLayoutSettingSchema.safeParse(VALID).success).toBe(true);
    const single = {
      ...VALID,
      right: {
        collapsed: false,
        split: null,
        panes: [{ id: "right-a", tab: "trade" }],
      },
    };
    expect(terminalLayoutSettingSchema.safeParse(single).success).toBe(true);
  });
});

describe("an unreadable layout is not an absent one", () => {
  test("reports a NEWER version as unsupported, not empty", () => {
    // The distinction is load-bearing on rollback. Told the setting was absent,
    // the client hydrates its local default, concludes that IS the account
    // layout, and saves it, destroying the newer workspace it merely could not
    // parse. Falling back for display is the intent; overwriting is not.
    const read = readStoredTerminalLayout({ ...VALID, version: 99 });
    expect(read.status).toBe("unsupported");
    expect(read.layout).toBeNull();
  });

  test("reports a corrupt blob as unsupported", () => {
    expect(readStoredTerminalLayout({ left: {}, right: {} }).status).toBe(
      "unsupported",
    );
    expect(readStoredTerminalLayout("not-an-object").status).toBe("unsupported");
  });

  test("reports a genuinely absent setting as empty", () => {
    // This one DOES license a write: there is nothing there to destroy.
    expect(readStoredTerminalLayout(null).status).toBe("empty");
    expect(readStoredTerminalLayout(undefined).status).toBe("empty");
  });

  test("reports a valid layout as ok", () => {
    const read = readStoredTerminalLayout(VALID);
    expect(read.status).toBe("ok");
    expect(read.layout).not.toBeNull();
  });
});

describe("drawer widths", () => {
  test("still rejects a fractional width, since the client rounds before sending", () => {
    // The server stays strict; buildLayoutPayload rounds. A drag stores raw
    // fractional clientX under browser zoom / high-DPI, and an unrounded
    // payload was rejected outright, so the save retried and was abandoned.
    const fractional = {
      ...VALID,
      widths: { left: 320.5, right: 420 },
    };
    expect(terminalLayoutSettingSchema.safeParse(fractional).success).toBe(false);

    const rounded = { ...VALID, widths: { left: 321, right: 420 } };
    expect(terminalLayoutSettingSchema.safeParse(rounded).success).toBe(true);
  });
});

describe("a saved collapsed drawer survives the round trip", () => {
  test("the schema accepts an explicitly collapsed right drawer", () => {
    // The client used to force `right.collapsed = false` on every hydration, so
    // a user who deliberately saved a collapsed rail never got it back on
    // another browser, and because the mirror was seeded from the overridden
    // value no corrective write ever followed. The server must at least be able
    // to store the state the client is now required to honor.
    const collapsed = {
      ...VALID,
      right: { ...VALID.right, collapsed: true },
    };
    const parsed = terminalLayoutSettingSchema.safeParse(collapsed);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.right.collapsed).toBe(true);

    // And it round-trips through the reader rather than being normalized away.
    expect(readStoredTerminalLayout(collapsed).layout?.right.collapsed).toBe(true);
  });
});
