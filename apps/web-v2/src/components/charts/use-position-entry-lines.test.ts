/**
 * Entity-lifecycle cover for the position-entry line reconciler.
 *
 * Verifies shape creation, line updates, removal on closed position,
 * brand-green color shape options, and teardown safety.
 */

import { describe, expect, test } from "bun:test";

import {
  entryLineShapeOptions,
  reconcilePositionEntryLines,
  type DrawnEntryLines,
} from "./use-position-entry-lines";
import type { PositionEntryLine } from "./position-entry-lines";
import { CHART_LIGHT_UP_COLOR, CHART_UP_COLOR } from "./chart-brand-colors";

function line(overrides: Partial<PositionEntryLine> = {}): PositionEntryLine {
  return {
    id: "eq:entry:AAPL:185",
    price: 185,
    label: "Avg Entry: $185.00",
    side: "long",
    ...overrides,
  };
}

/** A fake chart api that records every create/remove call. */
function fakeChart(options: { failCreate?: boolean } = {}) {
  const created: Array<{ price: number; options: Record<string, unknown> }> = [];
  const removed: string[] = [];
  let next = 0;
  return {
    created,
    removed,
    live: () => created.length - removed.length,
    api: {
      createShape(point: { time: number; price: number }, shapeOptions: Record<string, unknown>) {
        if (options.failCreate) throw new Error("chart disposed");
        created.push({ price: point.price, options: shapeOptions });
        return Promise.resolve(`entity-${next++}` as never);
      },
      removeEntity(entity: never) {
        removed.push(entity as unknown as string);
      },
    },
  };
}

async function reconcile(
  chart: ReturnType<typeof fakeChart>,
  drawn: DrawnEntryLines,
  lines: PositionEntryLine[],
  isAlive = () => true,
) {
  await reconcilePositionEntryLines({ api: chart.api, drawn, lines, theme: "dark", isAlive });
}

describe("reconcilePositionEntryLines", () => {
  test("draws a position entry line once", async () => {
    const chart = fakeChart();
    const drawn: DrawnEntryLines = new Map();
    await reconcile(chart, drawn, [line()]);
    expect(chart.created).toHaveLength(1);
    expect(chart.created[0]?.price).toBe(185);
    expect(drawn.size).toBe(1);
  });

  test("a repeated poll with unchanged entry level redraws nothing", async () => {
    const chart = fakeChart();
    const drawn: DrawnEntryLines = new Map();
    for (let i = 0; i < 5; i++) await reconcile(chart, drawn, [line()]);
    expect(chart.created).toHaveLength(1);
    expect(chart.removed).toHaveLength(0);
  });

  test("a position whose entry price changed is redrawn at its new price", async () => {
    const chart = fakeChart();
    const drawn: DrawnEntryLines = new Map();
    await reconcile(chart, drawn, [line({ price: 185 })]);
    await reconcile(chart, drawn, [line({ price: 190 })]);
    expect(chart.created.map((c) => c.price)).toEqual([185, 190]);
    expect(chart.removed).toHaveLength(1);
    expect(chart.live()).toBe(1);
  });

  test("a closed position removes the entry line from the chart", async () => {
    const chart = fakeChart();
    const drawn: DrawnEntryLines = new Map();
    await reconcile(chart, drawn, [line()]);
    await reconcile(chart, drawn, []);
    expect(chart.live()).toBe(0);
    expect(drawn.size).toBe(0);
  });

  test("a position whose theme or label changed at identical price is redrawn", async () => {
    const chart = fakeChart();
    const drawn: DrawnEntryLines = new Map();
    await reconcilePositionEntryLines({ api: chart.api, drawn, lines: [line({ price: 185, label: "Avg Entry: $185.00" })], theme: "dark", isAlive: () => true });
    expect(chart.created).toHaveLength(1);

    // Theme changes to light
    await reconcilePositionEntryLines({ api: chart.api, drawn, lines: [line({ price: 185, label: "Avg Entry: $185.00" })], theme: "light", isAlive: () => true });
    expect(chart.created).toHaveLength(2);
    expect(chart.removed).toHaveLength(1);
    expect(chart.live()).toBe(1);

    // Label changes (e.g. side flip)
    await reconcilePositionEntryLines({ api: chart.api, drawn, lines: [line({ price: 185, label: "SHORT Entry: $185.00" })], theme: "light", isAlive: () => true });
    expect(chart.created).toHaveLength(3);
    expect(chart.removed).toHaveLength(2);
    expect(chart.live()).toBe(1);
  });

  test("a shape landing after teardown is cleaned up", async () => {
    const chart = fakeChart();
    const drawn: DrawnEntryLines = new Map();
    await reconcile(chart, drawn, [line()], () => false);
    expect(chart.created).toHaveLength(1);
    expect(chart.removed).toHaveLength(1);
    expect(drawn.size).toBe(0);
  });
});

describe("entryLineShapeOptions", () => {
  test("uses brand green in both dark and light themes and locks shape", () => {
    const dark = entryLineShapeOptions(line(), "dark");
    const light = entryLineShapeOptions(line(), "light");
    expect((dark.overrides as Record<string, unknown>).linecolor).toBe(CHART_UP_COLOR);
    expect((light.overrides as Record<string, unknown>).linecolor).toBe(CHART_LIGHT_UP_COLOR);
    expect(dark.lock).toBe(true);
    expect(dark.disableSelection).toBe(true);
  });

  test("carries entry line label onto the chart", () => {
    expect(entryLineShapeOptions(line({ label: "LONG Entry: $77,662.50" }), "dark").text).toBe(
      "LONG Entry: $77,662.50",
    );
  });
});
