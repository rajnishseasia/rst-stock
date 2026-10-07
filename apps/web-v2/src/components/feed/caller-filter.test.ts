import { describe, expect, test } from "bun:test";
import {
  NO_CALLER_FILTER,
  applyCallerFilter,
  clearCallerFilter,
  describeCallerFilter,
  isAuthorVisible,
  isCallerFilterEmpty,
  isOnlyAuthor,
  muteActionLabel,
  onlyActionLabel,
  parseCallerFilter,
  serializeCallerFilter,
  toggleHiddenAuthor,
  toggleOnlyAuthor,
  type CallerFilter,
} from "./caller-filter";

const ROWS = [
  { authorName: "Alice", id: "1" },
  { authorName: "Bob", id: "2" },
  { authorName: "Alice", id: "3" },
  { authorName: "Cara", id: "4" },
];

const hide = (...names: string[]): CallerFilter => ({
  mode: "hide",
  hidden: new Set(names),
});

describe("applyCallerFilter", () => {
  test("the open state shows everyone", () => {
    expect(applyCallerFilter(ROWS, NO_CALLER_FILTER)).toHaveLength(4);
    expect(isCallerFilterEmpty(NO_CALLER_FILTER)).toBe(true);
  });

  test("hide mode is OPEN by default: a caller who appears later still shows", () => {
    const filter = hide("Bob");
    const later = [...ROWS, { authorName: "Dee", id: "5" }];

    expect(applyCallerFilter(later, filter).map((row) => row.id)).toEqual([
      "1",
      "3",
      "4",
      "5",
    ]);
  });

  test("only mode is CLOSED: a caller who appears later does NOT leak in", () => {
    // This is the whole reason "only" is its own mode rather than "hide
    // everyone else". A hidden-set implementation would silently start showing
    // Dee the moment she posted.
    const filter: CallerFilter = { mode: "only", author: "Alice" };
    const later = [...ROWS, { authorName: "Dee", id: "5" }];

    expect(applyCallerFilter(later, filter).map((row) => row.id)).toEqual([
      "1",
      "3",
    ]);
  });
});

describe("toggleHiddenAuthor", () => {
  test("adds then removes a caller from the hidden set", () => {
    const once = toggleHiddenAuthor(NO_CALLER_FILTER, "Bob");
    expect(isAuthorVisible(once, "Bob")).toBe(false);
    expect(isAuthorVisible(toggleHiddenAuthor(once, "Bob"), "Bob")).toBe(true);
  });

  test("muting the caller you are narrowed to does not produce an empty feed", () => {
    // "Only Alice" + "mute Alice" is a contradiction. Resolving it as
    // hide-Alice leaves a feed with visible content and a visible cause; keeping
    // only-mode would leave a blank feed with no explanation.
    const narrowed: CallerFilter = { mode: "only", author: "Alice" };
    const next = toggleHiddenAuthor(narrowed, "Alice");

    expect(next.mode).toBe("hide");
    expect(applyCallerFilter(ROWS, next).map((row) => row.id)).toEqual(["2", "4"]);
  });

  test("muting someone else while narrowed releases the narrowing", () => {
    const narrowed: CallerFilter = { mode: "only", author: "Alice" };
    const next = toggleHiddenAuthor(narrowed, "Bob");

    // Bob was already invisible under only-Alice, so "mute Bob" can only mean
    // "leave the narrowed view". Applying both at once would hide Bob from a
    // feed the user cannot see, which is indistinguishable from nothing.
    expect(next).toEqual(NO_CALLER_FILTER);
  });
});

describe("toggleOnlyAuthor", () => {
  test("narrows to one caller, and the same control releases it", () => {
    const narrowed = toggleOnlyAuthor(NO_CALLER_FILTER, "Alice");
    expect(isOnlyAuthor(narrowed, "Alice")).toBe(true);
    expect(toggleOnlyAuthor(narrowed, "Alice")).toEqual(NO_CALLER_FILTER);
  });

  test("narrowing from a hidden set drops the mutes rather than compounding them", () => {
    const narrowed = toggleOnlyAuthor(hide("Bob"), "Alice");
    expect(narrowed).toEqual({ mode: "only", author: "Alice" });
  });

  test("switching the narrowed caller replaces rather than stacks", () => {
    const narrowed = toggleOnlyAuthor(
      { mode: "only", author: "Alice" },
      "Bob",
    );
    expect(narrowed).toEqual({ mode: "only", author: "Bob" });
  });
});

describe("copy", () => {
  test("the status line names the cause, and stays silent when there is none", () => {
    expect(describeCallerFilter(NO_CALLER_FILTER)).toBeNull();
    expect(describeCallerFilter(hide("Bob"))).toBe("1 caller muted");
    expect(describeCallerFilter(hide("Bob", "Cara"))).toBe("2 callers muted");
    expect(describeCallerFilter({ mode: "only", author: "Alice" })).toBe(
      "Showing only Alice",
    );
  });

  test("action labels name what the tap will do, not the current state", () => {
    expect(muteActionLabel(NO_CALLER_FILTER, "Bob")).toBe("Mute Bob");
    expect(muteActionLabel(hide("Bob"), "Bob")).toBe("Unmute Bob");
    expect(onlyActionLabel(NO_CALLER_FILTER, "Alice")).toBe("Only show Alice");
    expect(onlyActionLabel({ mode: "only", author: "Alice" }, "Alice")).toBe(
      "Show all callers",
    );
  });
});

describe("persistence", () => {
  test("round-trips both modes", () => {
    for (const filter of [
      NO_CALLER_FILTER,
      hide("Bob", "Cara"),
      { mode: "only", author: "Alice" } as CallerFilter,
    ]) {
      expect(parseCallerFilter(serializeCallerFilter(filter))).toEqual(filter);
    }
  });

  test("reads the LEGACY bare array, so existing mutes survive the upgrade", () => {
    // The previous release wrote `["Bob","Cara"]` under the same key. Dropping
    // that on the floor would silently un-mute every caller a user had muted.
    expect(parseCallerFilter('["Bob","Cara"]')).toEqual(hide("Bob", "Cara"));
  });

  test("falls back to the open state rather than throwing on junk", () => {
    expect(parseCallerFilter(null)).toEqual(NO_CALLER_FILTER);
    expect(parseCallerFilter("")).toEqual(NO_CALLER_FILTER);
    expect(parseCallerFilter("{not json")).toEqual(NO_CALLER_FILTER);
    expect(parseCallerFilter('"a string"')).toEqual(NO_CALLER_FILTER);
    expect(parseCallerFilter('{"mode":"only"}')).toEqual(NO_CALLER_FILTER);
  });

  test("drops non-string and blank entries from a stored hidden list", () => {
    expect(parseCallerFilter('{"mode":"hide","hidden":["Bob",3,"","  ",null]}')).toEqual(
      hide("Bob"),
    );
  });

  test("clearing returns the open state", () => {
    expect(clearCallerFilter()).toEqual(NO_CALLER_FILTER);
  });
});
