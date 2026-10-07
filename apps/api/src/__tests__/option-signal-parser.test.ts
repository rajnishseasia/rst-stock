import { describe, expect, it } from "bun:test";
import { parseOptionSignal } from "../lib/option-signal-parser.js";

const referenceDate = new Date("2026-06-19T12:00:00.000Z");

describe("parseOptionSignal", () => {
  it("classifies an explicit BTO call signal as an option contract", () => {
    const result = parseOptionSignal("BTO $AAPL 250C 7/19", {
      symbolHint: "AAPL",
      referenceDate,
    });

    expect(result.kind).toBe("option");
    if (result.kind !== "option") throw new Error("expected option parse");
    expect(result.option).toEqual({
      assetType: "OPTION",
      symbol: "AAPL",
      side: "buy",
      tradeAction: "BuyToOpen",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
    });
  });

  it("classifies an explicit STC put signal as a sell-to-close option contract", () => {
    const result = parseOptionSignal("STC TSLA 06/26/2026 300P", {
      referenceDate,
    });

    expect(result.kind).toBe("option");
    if (result.kind !== "option") throw new Error("expected option parse");
    expect(result.option.symbol).toBe("TSLA");
    expect(result.option.side).toBe("sell");
    expect(result.option.tradeAction).toBe("SellToClose");
    expect(result.option.optionExpiration).toBe("260626");
    expect(result.option.optionStrike).toBe(300);
    expect(result.option.optionType).toBe("PUT");
  });

  it("rejects option-looking X text without a safe action intent", () => {
    const result = parseOptionSignal("AAPL 250C 7/19", {
      symbolHint: "AAPL",
      referenceDate,
    });

    expect(result).toEqual({
      kind: "unsupported",
      reason: "missing-safe-action",
    });
  });

  it("rejects sell-to-open and buy-to-close option signals for auto-mirror safety", () => {
    expect(
      parseOptionSignal("STO AAPL 250C 7/19", { symbolHint: "AAPL", referenceDate }),
    ).toEqual({ kind: "unsupported", reason: "unsupported-action" });

    expect(
      parseOptionSignal("BTC AAPL 250C 7/19", { symbolHint: "AAPL", referenceDate }),
    ).toEqual({ kind: "unsupported", reason: "unsupported-action" });
  });

  it("rejects an explicit ticker that conflicts with the signal row symbol", () => {
    expect(
      parseOptionSignal("BTO $AAPL 250C 7/19", {
        symbolHint: "TSLA",
        referenceDate,
      }),
    ).toEqual({ kind: "unsupported", reason: "underlying-mismatch" });
  });

  it("does not treat ordinary uppercase commentary as an explicit ticker", () => {
    const result = parseOptionSignal("BTO 250C 7/19 near ASK", {
      symbolHint: "AAPL",
      referenceDate,
    });

    expect(result.kind).toBe("option");
    if (result.kind !== "option") throw new Error("expected option parse");
    expect(result.option.symbol).toBe("AAPL");
  });

  it("rejects ticker-first contracts when the explicit ticker conflicts with the row", () => {
    expect(
      parseOptionSignal("AAPL 250C 7/19 BTO", {
        symbolHint: "TSLA",
        referenceDate,
      }),
    ).toEqual({ kind: "unsupported", reason: "underlying-mismatch" });
  });

  it("accepts a ticker-first contract when it agrees with the row", () => {
    const result = parseOptionSignal("AAPL 250C 7/19 BTO", {
      symbolHint: "AAPL",
      referenceDate,
    });

    expect(result.kind).toBe("option");
    if (result.kind !== "option") throw new Error("expected option parse");
    expect(result.option.symbol).toBe("AAPL");
  });

  it("does not parse a decimal premium as an expiration date", () => {
    expect(
      parseOptionSignal("BTO $AAPL 250C @ 7.19", {
        symbolHint: "AAPL",
        referenceDate,
      }),
    ).toEqual({ kind: "unsupported", reason: "missing-contract" });
  });

  it("rejects conflicting safe action intents", () => {
    expect(
      parseOptionSignal("BTO $AAPL 250C 7/19 then STC", {
        symbolHint: "AAPL",
        referenceDate,
      }),
    ).toEqual({ kind: "unsupported", reason: "unsupported-action" });
  });

  it("does not turn negated general buy language into BuyToOpen", () => {
    expect(
      parseOptionSignal("Do not buy $AAPL 250C 7/19", {
        symbolHint: "AAPL",
        referenceDate,
      }),
    ).toEqual({ kind: "unsupported", reason: "missing-safe-action" });
  });

  it("leaves ordinary equity text alone", () => {
    expect(
      parseOptionSignal("Buying AAPL here for a swing", {
        symbolHint: "AAPL",
        referenceDate,
      }),
    ).toEqual({ kind: "none" });
  });
});
