import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatePnlCard } from "./index";
import { formatPriceUsd } from "./pnl-card";
import type { PnlCardInput } from "./types";

const baseInput: PnlCardInput = {
  symbol: "AMD",
  side: "long",
  qty: 100,
  entryPrice: 132.5,
  exitPrice: 148.02,
  pnlUsd: 1552.0,
  pnlPercent: 11.71,
  totalValueUsd: 14802.0,
  result: "open",
};

function expectJpeg(buffer: Buffer): void {
  // JPEG magic bytes: FF D8 ... FF D9
  expect(buffer[0]).toBe(0xff);
  expect(buffer[1]).toBe(0xd8);
  expect(buffer[buffer.length - 2]).toBe(0xff);
  expect(buffer[buffer.length - 1]).toBe(0xd9);
}

/**
 * `loadBackground` (backgrounds.ts) picks a random `profit-N.jpg` / `loss-N.jpg`
 * art file per call, so two otherwise-identical renders can land on different
 * background art and differ in bytes for a reason that has nothing to do with
 * what was drawn on top. Pin `Math.random` for the duration of a callback so
 * buffer-equality assertions isolate the thing actually under test.
 */
async function withFixedRandom<T>(fn: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => 0;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

describe("generatePnlCard", () => {
  test("does not label the headline as realized or unrealized", () => {
    const source = readFileSync(join(import.meta.dir, "pnl-card.ts"), "utf8");
    expect(source).not.toContain('"UNREALIZED P&L"');
    expect(source).not.toContain('"REALIZED P&L"');
  });

  test("renders a profit card as a 1536x1024 JPEG", async () => {
    const card = await generatePnlCard(baseInput);
    expect(card.width).toBe(1536);
    expect(card.height).toBe(1024);
    expect(card.mimeType).toBe("image/jpeg");
    expect(card.base64).toBe(card.buffer.toString("base64"));
    expectJpeg(card.buffer);
  });

  test("renders a closed loss card", async () => {
    const card = await generatePnlCard({
      ...baseInput,
      side: "short",
      result: "closed",
      pnlUsd: -421.37,
      pnlPercent: -3.12,
    });
    expectJpeg(card.buffer);
  });

  test("renders with dollar amounts hidden", async () => {
    const card = await generatePnlCard({ ...baseInput, hideAmount: true });
    expectJpeg(card.buffer);
  });

  test("hideAmount conceals position size, not just the headline dollar figure", async () => {
    // Two renders that differ ONLY in qty, with hideAmount on (background art
    // pinned so it can't be the source of any byte difference). If the "N
    // shares/contracts" label were still being drawn (the bug), the qty
    // digits would land as different pixels and the encoded JPEGs would
    // differ. "Hide $ size" must mean the size is actually absent from the
    // image, not merely that the headline dollar total is swapped for a
    // percent while a viewer can still read off the share count.
    const smallPosition = await withFixedRandom(() =>
      generatePnlCard({ ...baseInput, hideAmount: true, qty: 1 }),
    );
    const largePosition = await withFixedRandom(() =>
      generatePnlCard({ ...baseInput, hideAmount: true, qty: 987654 }),
    );
    expect(smallPosition.buffer.equals(largePosition.buffer)).toBe(true);
  });

  test("shows position size when hideAmount is off (control for the above)", async () => {
    // Sanity control proving the buffer-equality technique above actually
    // detects qty text: with hideAmount off, differing qty MUST change the
    // rendered bytes, since the qty label draws unconditionally there.
    const smallPosition = await withFixedRandom(() =>
      generatePnlCard({ ...baseInput, hideAmount: false, qty: 1 }),
    );
    const largePosition = await withFixedRandom(() =>
      generatePnlCard({ ...baseInput, hideAmount: false, qty: 987654 }),
    );
    expect(smallPosition.buffer.equals(largePosition.buffer)).toBe(false);
  });

  test("handles long option symbols without throwing", async () => {
    const card = await generatePnlCard({
      ...baseInput,
      symbol: "AAPL260618C00190000",
      qty: 2,
    });
    expectJpeg(card.buffer);
  });

  test("rejects non-finite numbers", async () => {
    await expect(
      generatePnlCard({ ...baseInput, pnlUsd: Number.NaN }),
    ).rejects.toThrow("pnlUsd");
    await expect(
      generatePnlCard({ ...baseInput, totalValueUsd: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("totalValueUsd");
  });

  test("rejects an empty symbol", async () => {
    await expect(
      generatePnlCard({ ...baseInput, symbol: "  " }),
    ).rejects.toThrow("symbol");
  });
});

describe("background loading", () => {
  test("does not use @napi-rs/canvas loadImage for bundled JPEGs", () => {
    const source = readFileSync(join(import.meta.dir, "backgrounds.ts"), "utf8");

    expect(source).not.toContain("loadImage");
    expect(source).toContain("new Image()");
  });
});

describe("formatPriceUsd", () => {
  test("keeps ordinary prices at two decimals", () => {
    expect(formatPriceUsd(132.5)).toBe("$132.50");
    expect(formatPriceUsd(64210.4)).toBe("$64,210.40");
  });

  test("widens precision for sub-dollar perp prices instead of showing $0.00", () => {
    expect(formatPriceUsd(0.007412)).toBe("$0.007412");
    expect(formatPriceUsd(0.00001234)).toBe("$0.00001234");
  });

  test("formats negative values without losing precision", () => {
    expect(formatPriceUsd(-0.0052)).toBe("-$0.0052");
  });
});

describe("perp cards", () => {
  test("renders a leveraged sub-dollar perp position", async () => {
    const card = await generatePnlCard({
      symbol: "kPEPE",
      side: "short",
      qty: 120000,
      unitLabel: "kPEPE",
      entryPrice: 0.007412,
      exitPrice: 0.006901,
      pnlUsd: 61.32,
      pnlPercent: 41.2,
      totalValueUsd: 828.12,
      result: "open",
      leverageLabel: "10x cross",
    });
    expect(card.width).toBe(1536);
    expectJpeg(card.buffer);
  });
});
