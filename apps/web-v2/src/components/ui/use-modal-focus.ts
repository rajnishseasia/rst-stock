"use client";

import { useEffect, useRef } from "react";

/**
 * Make an `aria-modal` surface actually behave like one.
 *
 * `role="dialog" aria-modal="true"` is a PROMISE to assistive technology that
 * nothing outside the surface is reachable. Nothing in the DOM enforces it, so
 * a hand-rolled sheet keeps focus on the control that opened it, sitting behind
 * an opaque scrim, and Tab walks straight into the shell controls underneath.
 * A keyboard or screen-reader user then operates a trading UI they cannot see.
 *
 * Extracted because this repo has two of these sheets and I fixed one of them
 * first, which is exactly how the second stayed broken. A shared hook means the
 * next sheet cannot be built without it.
 *
 * Not a replacement for the Radix dialog primitive: these sheets predate it and
 * carry layout constraints (a definite-height scroller with a sticky footer)
 * that a swap would have to reproduce. This closes the accessibility gap
 * without that risk.
 */
export function useModalFocus({
  onClose,
  isOpen = true,
}: {
  /** Called on Escape. Must be stable or memoized. */
  onClose: () => void;
  /**
   * The surface is on screen. For sheets rendered conditionally INSIDE a
   * long-lived component, where the hook cannot mount and unmount with them.
   * Defaults true for a sheet that is itself mounted only while open.
   */
  isOpen?: boolean;
}) {
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const root = containerRef.current;

      // A NESTED modal owns the keyboard. The order review is a Radix
      // AlertDialog, which portals to document.body, so its Cancel/Confirm
      // controls are not descendants of this root: without this check every Tab
      // inside it read as "focus escaped" and was yanked back to the sheet
      // underneath, and Escape closed the sheet instead of the confirmation.
      // A keyboard user could not confirm or cancel an order at all.
      if (root && isInsideHigherModal(root, document.activeElement)) return;

      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
        // `offsetParent` is null for anything display:none or in a hidden
        // ancestor, which is how a collapsed section's controls would otherwise
        // become invisible tab stops.
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const active = document.activeElement;
      const move = nextTrapFocus({
        atFirst: active === focusable[0],
        atLast: active === focusable[focusable.length - 1],
        activeInsideModal: root.contains(active),
        shiftKey: event.shiftKey,
      });
      if (move === null) return;
      event.preventDefault();
      (move === "first" ? focusable[0]! : focusable[focusable.length - 1]!).focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, isOpen]);

  // Move focus IN on open, and put it back where it was on close, so the user
  // is neither stranded on a control now behind the scrim nor dumped at the top
  // of the document when the sheet goes away.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target = containerRef.current?.querySelector<HTMLElement>(
      'button, a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    target?.focus();
    return () => previouslyFocused?.focus?.();
  }, [isOpen]);

  return containerRef;
}

/**
 * Where Tab should send focus, or null to let the browser handle it normally.
 *
 * The wrap decision, separated from the DOM so its edges are testable: this
 * repo's test setup has no document, and a focus trap that is only verified by
 * reading its source is the anti-pattern `source-contract-debt.test.ts` exists
 * to stop.
 */
export function nextTrapFocus({
  atFirst,
  atLast,
  activeInsideModal,
  shiftKey,
}: {
  atFirst: boolean;
  atLast: boolean;
  /** Focus is currently within the modal at all. */
  activeInsideModal: boolean;
  shiftKey: boolean;
}): "first" | "last" | null {
  // Escaped entirely (focus on the page behind, or nowhere): pull it back to
  // whichever end the user is travelling toward.
  if (!activeInsideModal) return shiftKey ? "last" : "first";
  if (shiftKey) return atFirst ? "last" : null;
  return atLast ? "first" : null;
}

/**
 * Is focus sitting inside a modal that is NOT this one?
 *
 * Portalled dialogs (Radix renders to `document.body`) are siblings of the
 * surface that opened them, not descendants, so containment alone cannot tell
 * "focus escaped to the page behind" from "focus moved into a dialog on top".
 * The first must be pulled back; the second must be left completely alone.
 */
export function focusIsInHigherModal({
  containedByThisModal,
  hasOtherDialogAncestor,
}: {
  containedByThisModal: boolean;
  /** Focus's nearest dialog ancestor exists and is not this modal. */
  hasOtherDialogAncestor: boolean;
}): boolean {
  if (containedByThisModal) return false;
  // Outside us AND outside any dialog: genuinely escaped to the page behind, so
  // the trap should reclaim it rather than stand down.
  return hasOtherDialogAncestor;
}

function isInsideHigherModal(root: HTMLElement, active: Element | null): boolean {
  if (!active) return false;
  const owner = active.closest('[role="dialog"], [role="alertdialog"]');
  return focusIsInHigherModal({
    containedByThisModal: root.contains(active),
    hasOtherDialogAncestor: owner != null && owner !== root,
  });
}
