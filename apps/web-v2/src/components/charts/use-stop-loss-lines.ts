"use client";

/**
 * Draws stop-loss levels on a TradingView chart and keeps them in sync.
 *
 * WHY DRAWINGS AND NOT POSITION LINES. `createPositionLine()` / `createOrderLine()`
 * are Trading Terminal features; they are absent from the Advanced Charts
 * bundle this app vendors (verified against
 * `public/charting_library/charting_library.standalone.js`). A locked,
 * un-selectable `horizontal_line` drawing is the equivalent that the shipped
 * library actually supports.
 *
 * The reconciler is deliberately id-keyed rather than teardown-and-redraw:
 * these levels are re-read on a poll, and recreating every shape each time
 * makes the lines flicker on a chart the user is reading.
 *
 * Exported separately from `advanced-chart.tsx` because that file is already at
 * the god-component threshold in CLAUDE.md, and because a reconciler that owns
 * entity lifecycle is worth testing against a fake widget rather than only in
 * a browser.
 */

import { useEffect, useRef } from "react";

import type { EntityId, IChartingLibraryWidget } from "@/vendor/charting_library";
import type { StopLossLine } from "./stop-loss-lines";

/**
 * Stop red, matching the dark theme's --color-red-400/500 the way
 * `chart-brand-colors.ts` does. Literal hex on purpose: shape overrides are
 * serialized into the chart iframe and cannot read the app's CSS variables.
 */
export const STOP_LINE_COLOR_DARK = "#ed6a64";
export const STOP_LINE_COLOR_LIGHT = "#c0432f";

/** TradingView's linestyle enum: 0 solid, 1 dotted, 2 dashed. */
const LINE_STYLE_SOLID = 0;
const LINE_STYLE_DASHED = 2;

/** The minimal slice of the chart API this reconciler drives. */
interface StopLineChartApi {
  createShape(
    point: { time: number; price: number },
    options: Record<string, unknown>,
  ): Promise<EntityId> | EntityId;
  removeEntity(entityId: EntityId): void;
}

export function stopLineShapeOptions(
  line: StopLossLine,
  theme: "light" | "dark",
): Record<string, unknown> {
  return {
    shape: "horizontal_line",
    // Locked and unselectable: these are a read of broker state, not a drawing
    // the user made. A draggable one would imply moving it moves the stop.
    lock: true,
    disableSelection: true,
    disableSave: true,
    disableUndo: true,
    text: line.label,
    overrides: {
      linecolor: theme === "dark" ? STOP_LINE_COLOR_DARK : STOP_LINE_COLOR_LIGHT,
      linewidth: 1,
      // A trailing stop moves on its own, so the level drawn is a snapshot
      // rather than a standing price. Dashed says that without a legend.
      linestyle: line.trailing ? LINE_STYLE_DASHED : LINE_STYLE_SOLID,
      showLabel: true,
      showPrice: true,
      textcolor: theme === "dark" ? STOP_LINE_COLOR_DARK : STOP_LINE_COLOR_LIGHT,
      horzLabelsAlign: "right",
      vertLabelsAlign: "top",
    },
  };
}

/** What the reconciler has on the chart right now, keyed by line id. */
export type DrawnStopLines = Map<string, { entity: EntityId | null; price: number }>;

/**
 * Reconcile `lines` onto a chart: create what is new, remove what is gone, and
 * redraw a level whose price moved.
 *
 * A price change is handled as remove-then-create rather than by mutating the
 * shape's points, because the drawings API has no stable in-place price setter
 * for a locked shape across library versions, and a stop that has moved is
 * genuinely a different level.
 *
 * Pure of React so the entity lifecycle (the part that leaks) is testable
 * against a fake chart api. `drawn` is mutated in place: it is the caller's
 * record of what is on screen and must survive across calls.
 */
export async function reconcileStopLines({
  api,
  drawn,
  lines,
  theme,
  isAlive,
}: {
  api: StopLineChartApi;
  drawn: DrawnStopLines;
  lines: readonly StopLossLine[];
  theme: "light" | "dark";
  /** False once the chart is gone, so a late createShape is cleaned up. */
  isAlive: () => boolean;
}): Promise<void> {
  const remove = (entity: EntityId | null) => {
    if (!entity) return;
    try {
      api.removeEntity(entity);
    } catch {
      // Already gone (symbol change, disposal). Nothing to undo.
    }
  };

  const wanted = new Map(lines.map((line) => [line.id, line]));

  // Deleting the current entry during a Map iteration is well defined, so this
  // walks `drawn` directly rather than snapshotting it.
  for (const [id, drawing] of drawn) {
    const line = wanted.get(id);
    if (!line || line.price !== drawing.price) {
      remove(drawing.entity);
      drawn.delete(id);
    }
  }

  const pending: Array<Promise<void>> = [];
  for (const line of lines) {
    if (drawn.has(line.id)) continue;
    // Claim the slot before awaiting, so a second pass in the same tick cannot
    // draw the same level twice.
    drawn.set(line.id, { entity: null, price: line.price });
    let created: Promise<EntityId> | EntityId;
    try {
      created = api.createShape(
        // A horizontal line ignores its time anchor; 0 keeps it out of the
        // visible-range calculation.
        { time: 0, price: line.price },
        stopLineShapeOptions(line, theme),
      );
    } catch {
      drawn.delete(line.id);
      continue;
    }
    pending.push(
      Promise.resolve(created)
        .then((entity) => {
          if (!entity) {
            drawn.delete(line.id);
            return;
          }
          // Torn down, or the level moved again, while the shape was drawing.
          if (!isAlive() || drawn.get(line.id)?.price !== line.price) {
            remove(entity);
            drawn.delete(line.id);
            return;
          }
          drawn.set(line.id, { entity, price: line.price });
        })
        .catch(() => {
          drawn.delete(line.id);
        }),
    );
  }

  await Promise.all(pending);
}

/**
 * React binding for `reconcileStopLines`: owns the drawn-entity map across
 * renders, waits for the widget to be ready, and clears the chart when the
 * instrument changes or the component unmounts.
 */
export function useStopLossLines({
  widgetRef,
  readyRef,
  lines,
  theme,
  symbol,
  chartRevision = 0,
}: {
  widgetRef: { current: IChartingLibraryWidget | null };
  /** The widget has fired onChartReady; drawing before that throws. */
  readyRef: { current: boolean };
  lines: readonly StopLossLine[];
  theme: "light" | "dark";
  /** Redraw from scratch when the chart changes instrument. */
  symbol: string;
  /** Increments after TradingView is ready or finishes an internal symbol change. */
  chartRevision?: number;
}): void {
  /** id -> {entity, price}. Entities outlive renders, so they live in a ref. */
  const drawnRef = useRef<DrawnStopLines>(new Map());
  /** Guards against a resolved createShape landing after unmount. */
  const aliveRef = useRef(true);
  /** Last completed TradingView lifecycle revision reconciled onto the pane. */
  const revisionRef = useRef(chartRevision);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current) return;
    let api: StopLineChartApi;
    try {
      api = widget.activeChart() as unknown as StopLineChartApi;
    } catch {
      // The widget can be disposed between the ref read and this call.
      return;
    }
    // TradingView clears drawings while completing setSymbol. Its old entity
    // handles are stale after a readiness revision, so redraw live stops once.
    if (revisionRef.current !== chartRevision) {
      drawnRef.current.clear();
      revisionRef.current = chartRevision;
    }
    void reconcileStopLines({
      api,
      drawn: drawnRef.current,
      lines,
      theme,
      isAlive: () => aliveRef.current,
    });
  }, [lines, theme, symbol, chartRevision, widgetRef, readyRef]);

  // A symbol change invalidates every level: they were priced against the
  // instrument that just left the pane.
  useEffect(() => {
    const drawn = drawnRef.current;
    return () => {
      const widget = widgetRef.current;
      for (const { entity } of drawn.values()) {
        if (!entity) continue;
        try {
          widget?.activeChart().removeEntity(entity);
        } catch {
          // Disposed with the widget; the entities went with it.
        }
      }
      drawn.clear();
    };
  }, [symbol, widgetRef]);
}
