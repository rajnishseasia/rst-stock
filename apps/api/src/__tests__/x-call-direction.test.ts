import { describe, expect, it } from "bun:test";
import { deriveXCallDirection } from "../lib/x-call-direction.js";

const referenceDate = "2026-06-20T12:00:00.000Z";

function direction(content: string, symbol: string) {
  return deriveXCallDirection({ content, symbol, referenceDate });
}

describe("deriveXCallDirection", () => {
  it("classifies explicit bullish and bearish equity language", () => {
    expect(direction("Buying $AAPL for a breakout", "AAPL")).toBe("bullish");
    expect(direction("$NVDA long above 150", "NVDA")).toBe("bullish");
    expect(direction("Short $TSLA below support", "TSLA")).toBe("bearish");
    expect(direction("$AMD looks bearish here", "AMD")).toBe("bearish");
  });

  it("scores each ticker independently in a mixed-direction post", () => {
    const content = "$AAPL long above 220, $TSLA short below 300";
    expect(direction(content, "AAPL")).toBe("bullish");
    expect(direction(content, "TSLA")).toBe("bearish");
  });

  it("classifies BTO calls as bullish and BTO puts as bearish", () => {
    expect(direction("BTO $AAPL 250C 7/19", "AAPL")).toBe("bullish");
    expect(direction("BTO $TSLA 200P 7/19", "TSLA")).toBe("bearish");
  });

  it("scores separate option contracts independently in one post", () => {
    const content = "BTO $AAPL 250C 7/19, BTO $TSLA 200P 7/19";
    expect(direction(content, "AAPL")).toBe("bullish");
    expect(direction(content, "TSLA")).toBe("bearish");
  });

  it("does not treat an option exit as a fresh directional call", () => {
    expect(direction("STC $AAPL 250C 7/19 for profit", "AAPL")).toBe("unknown");
  });

  it("fails closed for unsupported option prose and bare sell exits", () => {
    for (const content of [
      "STO $AAPL put 250 9/19",
      "$AAPL put for next month",
      "I sold $AAPL for profit",
      "Selling $AAPL",
    ]) {
      expect(direction(content, "AAPL")).toBe("unknown");
    }
  });

  it("keeps explicit bearish entry semantics while rejecting exit language", () => {
    expect(direction("Sell short $AAPL below support", "AAPL")).toBe("bearish");
    expect(direction("I sold short $AAPL", "AAPL")).toBe("bearish");
    expect(direction("Selling short $AAPL here", "AAPL")).toBe("bearish");
  });

  it("fails closed for standard short-cover exits without masking new entries", () => {
    for (const content of [
      "Buy to cover $AAPL",
      "Buying to cover $AAPL",
      "Buy-to-cover $AAPL",
      "Buy_to_cover $AAPL",
      "Covering $AAPL short",
      "Covering short $AAPL",
      "Covering my $AAPL short",
      "Covering my $AAPL's short position",
      "Covering my short in $AAPL",
      "Buy back $AAPL",
      "Buying back $AAPL",
    ]) {
      expect(direction(content, "AAPL")).toBe("unknown");
    }

    expect(direction("Buy to open $AAPL", "AAPL")).toBe("bullish");
    expect(direction("Buy-to-open $AAPL", "AAPL")).toBe("bullish");
    expect(direction("Sell short $AAPL", "AAPL")).toBe("bearish");
    expect(direction("Sell-to-open $AAPL", "AAPL")).toBe("bearish");
  });

  it("returns unknown for a plain mention or conflicting direction", () => {
    expect(direction("Watching $NVDA at support", "NVDA")).toBe("unknown");
    expect(direction("$AAPL long setup but still bearish", "AAPL")).toBe("unknown");
  });

  it("does not mistake short-market commentary for bearish intent", () => {
    expect(direction("$TSLA short squeeze setup", "TSLA")).toBe("bullish");
    expect(direction("$TSLA short interest is elevated", "TSLA")).toBe("unknown");
    expect(direction("$TSLA short term setup", "TSLA")).toBe("unknown");
    expect(direction("$TSLA sell-off is over", "TSLA")).toBe("unknown");
  });

  it("recognizes broad bull/bear language and lets explicit intent beat soft context", () => {
    expect(direction("$TSLA is a bull here", "TSLA")).toBe("bullish");
    expect(direction("$TSLA is a bear here", "TSLA")).toBe("bearish");
    expect(direction("$TSLA bullish despite short interest", "TSLA")).toBe("bullish");
    expect(direction("$TSLA bearish despite a short squeeze", "TSLA")).toBe("bearish");
    expect(direction("$TSLA short squeeze, but I am short", "TSLA")).toBe("bearish");
  });

  it("does not borrow direction from another ticker's clause", () => {
    const content = "$AAPL long above 220, watching $TSLA at support";
    expect(direction(content, "TSLA")).toBe("unknown");
  });

  it("prefers a structured source direction over ambiguous prose", () => {
    expect(
      deriveXCallDirection({
        content: "$QQQ is testing its 100 day again",
        symbol: "QQQ",
        referenceDate,
        metadata: { direction: "long" },
      }),
    ).toBe("bullish");
    expect(
      deriveXCallDirection({
        content: "$GOOGL AI spending is pressuring cash flow",
        symbol: "GOOGL",
        referenceDate,
        metadata: JSON.stringify({ direction: "short" }),
      }),
    ).toBe("bearish");
  });

  it("falls back to prose when a structured direction is absent or unsupported", () => {
    expect(
      deriveXCallDirection({
        content: "Buying $AAPL for a breakout",
        symbol: "AAPL",
        referenceDate,
        metadata: { direction: "sideways" },
      }),
    ).toBe("bullish");
  });
});
