/**
 * Entity-lifecycle cover for the stop-line reconciler.
 *
 * This is the part that leaks: a chart polled every few seconds either
 * accumulates a shape per poll, or flickers because every poll tears down and
 * redraws. Both are invisible to a type checker and obvious here.
 */

import { describe, expect, test } from "bun:test";

import {
  STOP_LINE_COLOR_DARK,
  STOP_LINE_COLOR_LIGHT,
  reconcileStopLines,
  stopLineShapeOptions,
  type DrawnStopLines,
} from "./use-stop-loss-lines";
import type { StopLossLine } from "./stop-loss-lines";

function line(overrides: Partial<StopLossLine> = {}): StopLossLine {
  return { id: "eq:AAPL:185", price: 185, label: "SL", trailing: false, ...overrides };
}

/** A fake chart api that records every create/remove it is asked for. */
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
  drawn: DrawnStopLines,
  lines: StopLossLine[],
  isAlive = () => true,
) {
  await reconcileStopLines({ api: chart.api, drawn, lines, theme: "dark", isAlive });
}

describe("reconcileStopLines", () => {
  test("draws a level once", async () => {
    const chart = fakeChart();
    const drawn: DrawnStopLines = new Map();
    await reconcile(chart, drawn, [line()]);
    expect(chart.created).toHaveLength(1);
    expect(chart.created[0]?.price).toBe(185);
    expect(drawn.size).toBe(1);
  });

  test("a repeated poll with unchanged levels redraws nothing", async () => {
    const chart = fakeChart();
    const drawn: DrawnStopLines = new Map();
    for (let i = 0; i < 5; i++) await reconcile(chart, drawn, [line()]);
    expect(chart.created).toHaveLength(1);
    expect(chart.removed).toHaveLength(0);
  });

  test("a moved stop is redrawn at its new price, leaving nothing behind", async () => {
    const chart = fakeChart();
    const drawn: DrawnStopLines = new Map();
    await reconcile(chart, drawn, [line({ price: 185 })]);
    await reconcile(chart, drawn, [line({ price: 190 })]);
    expect(chart.created.map((c) => c.price)).toEqual([185, 190]);
    expect(chart.removed).toHaveLength(1);
    expect(chart.live()).toBe(1);
  });

  test("a cancelled stop is removed from the chart", async () => {
    const chart = fakeChart();
    const drawn: DrawnStopLines = new Map();
    await reconcile(chart, drawn, [line()]);
    await reconcile(chart, drawn, []);
    expect(chart.live()).toBe(0);
    expect(drawn.size).toBe(0);
  });

  test("several levels are tracked independently", async () => {
    const chart = fakeChart();
    const drawn: DrawnStopLines = new Map();
    const a = line({ id: "a", price: 100 });
    const b = line({ id: "b", price: 110 });
    await reconcile(chart, drawn, [a, b]);
    await reconcile(chart, drawn, [b]);
    expect(chart.live()).toBe(1);
    expect([...drawn.keys()]).toEqual(["b"]);
  });

  test("a shape that lands after teardown is removed, not leaked", async () => {
    const chart = fakeChart();
    const drawn: DrawnStopLines = new Map();
    await reconcile(chart, drawn, [line()], () => false);
    expect(chart.created).toHaveLength(1);
    expect(chart.removed).toHaveLength(1);
    expect(drawn.size).toBe(0);
  });

  test("a chart that refuses the draw does not record a phantom line", async () => {
    const chart = fakeChart({ failCreate: true });
    const drawn: DrawnStopLines = new Map();
    await reconcile(chart, drawn, [line()]);
    expect(drawn.size).toBe(0);
    // The next poll must be free to try again rather than believe it drew.
    const working = fakeChart();
    await reconcile(working, drawn, [line()]);
    expect(working.created).toHaveLength(1);
  });
});

describe("stopLineShapeOptions", () => {
  test("is red in both themes and locked against editing", () => {
    const dark = stopLineShapeOptions(line(), "dark");
    const light = stopLineShapeOptions(line(), "light");
    expect((dark.overrides as Record<string, unknown>).linecolor).toBe(STOP_LINE_COLOR_DARK);
    expect((light.overrides as Record<string, unknown>).linecolor).toBe(STOP_LINE_COLOR_LIGHT);
    // Draggable would imply that moving the line moves the stop at the broker.
    expect(dark.lock).toBe(true);
    expect(dark.disableSelection).toBe(true);
  });

  test("a trailing stop is dashed, a fixed stop solid", () => {
    const fixed = stopLineShapeOptions(line({ trailing: false }), "dark");
    const trailing = stopLineShapeOptions(line({ trailing: true }), "dark");
    expect((fixed.overrides as Record<string, unknown>).linestyle).toBe(0);
    expect((trailing.overrides as Record<string, unknown>).linestyle).toBe(2);
  });

  test("carries the line's label onto the chart", () => {
    expect(stopLineShapeOptions(line({ label: "Trailing SL" }), "dark").text).toBe("Trailing SL");
  });
});
