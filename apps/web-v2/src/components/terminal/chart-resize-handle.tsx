"use client";

import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "@/lib/utils";

export interface ChartResizeHandleProps {
  canResize: boolean;
  isDragging: boolean;
  min: number;
  max: number;
  value: number;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * The draggable separator between the chart and the bottom drawer, extracted
 * from TerminalChartPanel so it is a leaf component with no hooks: every
 * state it displays (disabled, dragging, min/max/value) arrives as a prop, so
 * a test can call this function directly and invoke the handlers it wires to
 * the button's pointer/keyboard events without a DOM (see
 * terminal-chart-panel.test.ts).
 */
export function ChartResizeHandle({
  canResize,
  isDragging,
  min,
  max,
  value,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
}: ChartResizeHandleProps) {
  return (
    <button
      type="button"
      aria-label="Resize chart bottom drawer"
      role="separator"
      aria-orientation="horizontal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-disabled={!canResize || undefined}
      title={
        canResize
          ? "Drag to resize chart and bottom drawer"
          : "Chart and bottom drawer are already at their minimum sizes"
      }
      className={cn(
        "terminal-resize-handle group flex h-8 shrink-0 touch-none select-none items-center justify-center border-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:h-6",
        isDragging && "terminal-resize-handle-active",
        canResize ? "cursor-row-resize" : "cursor-not-allowed opacity-70",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      <span className="h-1 w-16 rounded-full bg-border transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary" />
    </button>
  );
}
