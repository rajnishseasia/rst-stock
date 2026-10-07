import { describe, expect, test } from "bun:test";
import { focusIsInHigherModal, nextTrapFocus } from "./use-modal-focus";

/**
 * The wrap decision only. Actual focus movement needs a document this test
 * setup does not have, and asserting the hook's source text would be the
 * anti-pattern `source-contract-debt.test.ts` blocks.
 */
describe("nextTrapFocus", () => {
  const inside = { activeInsideModal: true, atFirst: false, atLast: false };

  test("Tab in the middle is left to the browser", () => {
    expect(nextTrapFocus({ ...inside, shiftKey: false })).toBeNull();
    expect(nextTrapFocus({ ...inside, shiftKey: true })).toBeNull();
  });

  test("Tab off the last control wraps to the first", () => {
    expect(nextTrapFocus({ ...inside, atLast: true, shiftKey: false })).toBe(
      "first",
    );
  });

  test("Shift+Tab off the first control wraps to the last", () => {
    expect(nextTrapFocus({ ...inside, atFirst: true, shiftKey: true })).toBe(
      "last",
    );
  });

  test("the two ends do not interfere with each other", () => {
    // Shift+Tab AT the last control should just move backwards normally.
    expect(nextTrapFocus({ ...inside, atLast: true, shiftKey: true })).toBeNull();
    expect(nextTrapFocus({ ...inside, atFirst: true, shiftKey: false })).toBeNull();
  });

  test("focus that has ESCAPED the modal is pulled back", () => {
    // The state this trap exists for: aria-modal promises nothing outside is
    // reachable, and focus sitting on the trigger behind the scrim breaks that.
    expect(
      nextTrapFocus({ ...inside, activeInsideModal: false, shiftKey: false }),
    ).toBe("first");
    expect(
      nextTrapFocus({ ...inside, activeInsideModal: false, shiftKey: true }),
    ).toBe("last");
  });

  test("a single focusable control is both ends at once", () => {
    // atFirst and atLast are both true; each direction still wraps to itself
    // rather than escaping.
    expect(
      nextTrapFocus({ activeInsideModal: true, atFirst: true, atLast: true, shiftKey: false }),
    ).toBe("first");
    expect(
      nextTrapFocus({ activeInsideModal: true, atFirst: true, atLast: true, shiftKey: true }),
    ).toBe("last");
  });
});

describe("focusIsInHigherModal: a dialog on top owns the keyboard", () => {
  test("stands down when focus is in a NESTED modal", () => {
    // The order review is a Radix AlertDialog, portalled to document.body, so
    // its Cancel/Confirm controls are siblings of the sheet rather than
    // descendants. Treated as escaped focus, every Tab was yanked back to the
    // sheet and Escape closed the sheet instead of the confirmation: a keyboard
    // user could not confirm or cancel an order at all.
    expect(
      focusIsInHigherModal({
        containedByThisModal: false,
        hasOtherDialogAncestor: true,
      }),
    ).toBe(true);
  });

  test("does NOT stand down for focus escaped to the page behind", () => {
    // The case the trap exists for; it must survive the fix for the case above.
    expect(
      focusIsInHigherModal({
        containedByThisModal: false,
        hasOtherDialogAncestor: false,
      }),
    ).toBe(false);
  });

  test("our own controls are never a higher modal", () => {
    // Containment wins even though this modal is itself role="dialog", which
    // would otherwise make every control inside it look like a nested one.
    expect(
      focusIsInHigherModal({
        containedByThisModal: true,
        hasOtherDialogAncestor: true,
      }),
    ).toBe(false);
    expect(
      focusIsInHigherModal({
        containedByThisModal: true,
        hasOtherDialogAncestor: false,
      }),
    ).toBe(false);
  });
});
