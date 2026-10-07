/**
 * The draggable grip on the outer edge of a terminal drawer. Pure over props
 * (no hooks), extracted out of the two near-identical inline `<button>`s
 * page.tsx built for the left ("Discovery") and right ("Modules") drawers
 * (audit H7: self-contained UI section into its own component), so the
 * aria wiring and pointer-event plumbing are directly renderable in a test
 * instead of only checkable by reading page.tsx as a string.
 *
 * page.tsx keeps ownership of what dragging actually does (`startDrawerResize`
 * / `resizeDrawer`); this component only reports the raw pointer events.
 */

import type { PointerEvent } from "react";

export function DrawerResizeHandle({
  ariaLabel,
  min,
  max,
  now,
  drawerSide,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  ariaLabel: string;
  min: number;
  max: number;
  now: number;
  /**
   * Which drawer this grip belongs to. The left drawer's grip sits on the
   * drawer's own right edge (the boundary with the chart column) and floats
   * above it (z-20); the right drawer's sits on its left edge, below (z-10).
   */
  drawerSide: "left" | "right";
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(now)}
      className={
        drawerSide === "left"
          ? "absolute right-0 top-0 z-20 hidden h-full w-2 touch-none cursor-col-resize select-none items-center justify-center xl:flex"
          : "absolute left-0 top-0 z-10 hidden h-full w-2 touch-none cursor-col-resize select-none items-center justify-center xl:flex"
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className="terminal-drawer-grip h-16 w-1 rounded-full bg-border/80 transition-colors hover:bg-primary/70" />
    </button>
  );
}
