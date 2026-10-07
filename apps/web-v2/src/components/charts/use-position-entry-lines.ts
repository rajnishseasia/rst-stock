"use client";

/**
 * Draws position entry lines on a TradingView chart and keeps them in sync.
 *
 * Uses brand green color tokens (#43d39a dark, #157a52 light) to draw a locked,
 * unselectable horizontal line at the user's entry price for active positions.
 */

import { useEffect, useRef } from "react";

import type { EntityId, IChartingLibraryWidget } from "@/vendor/charting_library";
import { CHART_LIGHT_UP_COLOR, CHART_UP_COLOR } from "./chart-brand-colors";
import type { PositionEntryLine } from "./position-entry-lines";

/** TradingView's linestyle enum: 0 solid, 1 dotted, 2 dashed. */
const LINE_STYLE_SOLID = 0;

interface EntryLineChartApi {
  createShape(
    point: { time: number; price: number },
    options: Record<string, unknown>,
  ): Promise<EntityId> | EntityId;
  removeEntity(entityId: EntityId): void;
}

export function entryLineShapeOptions(
  line: PositionEntryLine,
  theme: "light" | "dark",
): Record<string, unknown> {
  const color = theme === "dark" ? CHART_UP_COLOR : CHART_LIGHT_UP_COLOR;
  return {
    shape: "horizontal_line",
    lock: true,
    disableSelection: true,
    disableSave: true,
    disableUndo: true,
    text: line.label,
    overrides: {
      linecolor: color,
      linewidth: 1.5,
      linestyle: LINE_STYLE_SOLID,
      showLabel: true,
      showPrice: true,
      textcolor: color,
      horzLabelsAlign: "right",
      vertLabelsAlign: "top",
    },
  };
}

export type DrawnEntryLines = Map<
  string,
  { entity: EntityId | null; price: number; theme: "light" | "dark"; label: string }
>;

export async function reconcilePositionEntryLines({
  api,
  drawn,
  lines,
  theme,
  isAlive,
}: {
  api: EntryLineChartApi;
  drawn: DrawnEntryLines;
  lines: readonly PositionEntryLine[];
  theme: "light" | "dark";
  isAlive: () => boolean;
}): Promise<void> {
  const remove = (entity: EntityId | null) => {
    if (!entity) return;
    try {
      api.removeEntity(entity);
    } catch {
      // Already gone
    }
  };

  const wanted = new Map(lines.map((line) => [line.id, line]));

  for (const [id, drawing] of drawn) {
    const line = wanted.get(id);
    if (
      !line ||
      line.price !== drawing.price ||
      theme !== drawing.theme ||
      line.label !== drawing.label
    ) {
      remove(drawing.entity);
      drawn.delete(id);
    }
  }

  const pending: Array<Promise<void>> = [];
  for (const line of lines) {
    if (drawn.has(line.id)) continue;
    drawn.set(line.id, { entity: null, price: line.price, theme, label: line.label });
    let created: Promise<EntityId> | EntityId;
    try {
      created = api.createShape(
        { time: 0, price: line.price },
        entryLineShapeOptions(line, theme),
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
          const current = drawn.get(line.id);
          if (
            !isAlive() ||
            current?.price !== line.price ||
            current?.theme !== theme ||
            current?.label !== line.label
          ) {
            remove(entity);
            drawn.delete(line.id);
            return;
          }
          drawn.set(line.id, { entity, price: line.price, theme, label: line.label });
        })
        .catch(() => {
          drawn.delete(line.id);
        }),
    );
  }

  await Promise.all(pending);
}

export function usePositionEntryLines({
  widgetRef,
  readyRef,
  lines,
  theme,
  symbol,
  chartRevision = 0,
}: {
  widgetRef: { current: IChartingLibraryWidget | null };
  readyRef: { current: boolean };
  lines: readonly PositionEntryLine[];
  theme: "light" | "dark";
  symbol: string;
  chartRevision?: number;
}): void {
  const drawnRef = useRef<DrawnEntryLines>(new Map());
  const aliveRef = useRef(true);
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
    let api: EntryLineChartApi;
    try {
      api = widget.activeChart() as unknown as EntryLineChartApi;
    } catch {
      return;
    }

    if (revisionRef.current !== chartRevision) {
      drawnRef.current.clear();
      revisionRef.current = chartRevision;
    }
    void reconcilePositionEntryLines({
      api,
      drawn: drawnRef.current,
      lines,
      theme,
      isAlive: () => aliveRef.current,
    });
  }, [lines, theme, symbol, chartRevision, widgetRef, readyRef]);

  useEffect(() => {
    const drawn = drawnRef.current;
    return () => {
      const widget = widgetRef.current;
      for (const { entity } of drawn.values()) {
        if (!entity) continue;
        try {
          widget?.activeChart().removeEntity(entity);
        } catch {
          // Disposed
        }
      }
      drawn.clear();
    };
  }, [symbol, widgetRef]);
}
