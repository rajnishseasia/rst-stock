import { describe, expect, it } from "bun:test";

import {
  classifyExternalFill,
  closeReasonForFill,
  externalHlClientOrderId,
  isClosingFill,
  nextWatermarkMs,
  tradeActionForFill,
  type ExternalHlFill,
} from "../lib/hyperliquid-external-fill";

function fill(overrides: Partial<ExternalHlFill> = {}): ExternalHlFill {
  return {
    time: 2_000,
    coin: "BTC",
    side: "sell",
    px: "60000",
    sz: "0.5",
    closedPnl: "-120.5",
    fee: "1.2",
    dir: "Close Long",
    oid: 900,
    hash: "0xdeadbeef",
    tid: 4242,
    cloid: null,
    ...overrides,
  };
}

describe("classifyExternalFill", () => {
  const base = {
    knownOids: new Set<number>(),
    knownCloids: new Set<string>(),
    watermarkMs: 1_000,
  };

  it("ingests a fill we have no order row for", () => {
    expect(classifyExternalFill({ fill: fill(), ...base })).toEqual({ ingest: true });
  });

  it("leaves a fill on a known order to the row-driven sync", () => {
    // Ingesting it here would create a duplicate order row AND a second webhook
    // for a trade the app already tracks.
    expect(
      classifyExternalFill({ fill: fill(), ...base, knownOids: new Set([900]) }),
    ).toEqual({ ingest: false, reason: "known-order" });
  });

  it("recognizes an app order by cloid before its broker oid is persisted", () => {
    const cloid = "0x11111111111111111111111111111111";
    expect(
      classifyExternalFill({
        fill: fill({ cloid: cloid.toUpperCase() }),
        ...base,
        knownCloids: new Set([cloid]),
      }),
    ).toEqual({ ingest: false, reason: "known-order" });
  });

  it("skips anything at or before the watermark", () => {
    expect(classifyExternalFill({ fill: fill({ time: 1_000 }), ...base })).toEqual({
      ingest: false,
      reason: "at-or-before-watermark",
    });
    expect(classifyExternalFill({ fill: fill({ time: 999 }), ...base })).toEqual({
      ingest: false,
      reason: "at-or-before-watermark",
    });
  });

  it("rejects malformed rows rather than inserting a zero-size order", () => {
    for (const bad of [{ sz: "0" }, { sz: "x" }, { px: "0" }, { time: 0 }]) {
      expect(classifyExternalFill({ fill: fill(bad), ...base }).ingest).toBe(false);
    }
  });
});

describe("externalHlClientOrderId", () => {
  it("is deterministic, so a re-read hits the unique index instead of duplicating", () => {
    expect(externalHlClientOrderId(fill())).toBe(externalHlClientOrderId(fill()));
  });

  it("distinguishes two fills of the same order", () => {
    expect(externalHlClientOrderId(fill({ tid: 1 }))).not.toBe(
      externalHlClientOrderId(fill({ tid: 2 })),
    );
  });

  it("cannot collide with an Alpaca external fill", () => {
    expect(externalHlClientOrderId(fill()).startsWith("hlextfill:")).toBe(true);
  });

  it("fits the client-order-id column comfortably", () => {
    expect(externalHlClientOrderId(fill()).length).toBeLessThanOrEqual(64);
  });
});

describe("isClosingFill", () => {
  it("recognizes every shape of reduction Hyperliquid reports", () => {
    expect(isClosingFill("Close Long")).toBe(true);
    expect(isClosingFill("Close Short")).toBe(true);
    expect(isClosingFill("Long > Short")).toBe(true);
    expect(isClosingFill("Liquidated Cross Long")).toBe(true);
    expect(isClosingFill("Open Long")).toBe(false);
  });
});

describe("tradeActionForFill", () => {
  it("records a long close as a close, not a plain sale", () => {
    expect(tradeActionForFill({ dir: "Close Long", side: "sell" })).toEqual({
      tradeAction: "SellToClose",
      direction: "long",
    });
  });

  it("records a short close as a cover", () => {
    expect(tradeActionForFill({ dir: "Close Short", side: "buy" })).toEqual({
      tradeAction: "BuyToCover",
      direction: "short",
    });
  });

  it("reads a flip from the LEFT of the arrow, in both directions", () => {
    // Both strings contain the word "short", so a substring search cannot tell
    // them apart and records a short being covered as a long being sold. "X > Y"
    // closes X, so only X describes the position this fill ended.
    expect(tradeActionForFill({ dir: "Long > Short", side: "sell" })).toEqual({
      tradeAction: "SellToClose",
      direction: "long",
    });
    expect(tradeActionForFill({ dir: "Short > Long", side: "buy" })).toEqual({
      tradeAction: "BuyToCover",
      direction: "short",
    });
  });

  it("records a liquidated short as a cover, not a sale", () => {
    expect(tradeActionForFill({ dir: "Liquidated Cross Short", side: "buy" })).toEqual({
      tradeAction: "BuyToCover",
      direction: "short",
    });
  });

  it("records opens on the correct side", () => {
    expect(tradeActionForFill({ dir: "Open Long", side: "buy" })).toEqual({
      tradeAction: "Buy",
      direction: "long",
    });
    expect(tradeActionForFill({ dir: "Open Short", side: "sell" })).toEqual({
      tradeAction: "SellShort",
      direction: "short",
    });
  });

  it("falls back to the raw side for a dir it does not recognize", () => {
    expect(tradeActionForFill({ dir: "Auto-Deleveraging", side: "buy" }).tradeAction).toBe("Buy");
  });
});

describe("closeReasonForFill", () => {
  const triggerKinds = new Map<number, "tp" | "sl">([[900, "sl"], [901, "tp"]]);

  it("names a stop that was seen resting before it fired", () => {
    expect(closeReasonForFill({ fill: fill(), triggerKinds })).toBe("stop_loss");
  });

  it("names a take-profit", () => {
    expect(closeReasonForFill({ fill: fill({ oid: 901 }), triggerKinds })).toBe("take_profit");
  });

  it("a liquidation outranks any trigger mapping", () => {
    expect(
      closeReasonForFill({ fill: fill({ dir: "Liquidated Cross Long" }), triggerKinds }),
    ).toBe("liquidation");
  });

  it("returns null, not a guess, when the order was never seen resting", () => {
    // Null must stay distinguishable from "the user closed it deliberately":
    // the alert wording depends on not claiming a stop we cannot evidence.
    expect(closeReasonForFill({ fill: fill({ oid: 55 }), triggerKinds })).toBeNull();
  });
});

describe("nextWatermarkMs", () => {
  it("advances to the newest fill actually processed", () => {
    expect(nextWatermarkMs([{ time: 5 }, { time: 9 }, { time: 7 }], 1)).toBe(9);
  });

  it("never rewinds on an out-of-order page", () => {
    // Rewinding replays a burst of already-notified fills at the user.
    expect(nextWatermarkMs([{ time: 3 }], 10)).toBe(10);
  });

  it("holds still when nothing was processed", () => {
    expect(nextWatermarkMs([], 10)).toBe(10);
  });

  it("ignores a non-finite timestamp rather than poisoning the cursor", () => {
    expect(nextWatermarkMs([{ time: Number.NaN }, { time: 12 }], 4)).toBe(12);
  });
});
