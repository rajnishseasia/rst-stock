import { describe, expect, test } from "bun:test";
import {
  perpChartSelection,
  perpSignalSelection,
  signalTickerChartSelection,
  stockChartSelection,
  stockFromPerpSelection,
  stockSignalSelection,
} from "./signal-selection";
import { equityOrderSignalId } from "./signal-perp";

const SOURCE = {
  symbol: "SOL",
  signalId: "row-1",
  content: "long SOL 20x",
};

describe("copy payloads", () => {
  test("an equity chip copy carries no venue and no perp fields", () => {
    const selection = stockSignalSelection(SOURCE);

    expect(selection).toEqual({
      symbol: "SOL",
      signalId: "row-1",
      content: "long SOL 20x",
      copySourceItemId: "x_signal:row-1",
      // Plan S1: a source with no caller context normalizes to an explicit
      // null, never a partially-populated thesis.
      thesis: null,
    });
    expect("venue" in selection).toBe(false);
    expect("leverage" in selection).toBe(false);
    expect("side" in selection).toBe(false);
  });

  test("a copy carries the caller's thesis through unchanged", () => {
    const thesis = {
      authorName: "Alice",
      authorAvatar: null,
      timestamp: "2026-01-02T03:04:05.000Z",
      url: "https://x.com/alice/status/1",
      imageUrl: null,
      direction: "short" as const,
    };

    expect(stockSignalSelection({ ...SOURCE, thesis }).thesis).toEqual(thesis);
    expect(stockFromPerpSelection({ ...SOURCE, thesis }).thesis).toEqual(thesis);
    expect(stockChartSelection({ ...SOURCE, thesis }).thesis).toEqual(thesis);
    expect(
      perpChartSelection(
        { coin: "SOL", side: "short" },
        { signalId: "row-1", content: "short SOL", thesis },
      ).thesis,
    ).toEqual(thesis);
  });

  test("a PERP COPY payload never carries a thesis", () => {
    // The one selection shape whose fields become an order. Display context has
    // no business travelling on it.
    const selection = perpSignalSelection(
      { coin: "kPEPE", side: "short", leverage: 20 },
      {
        signalId: "row-2",
        content: "short kPEPE",
        thesis: {
          authorName: "Alice",
          authorAvatar: null,
          timestamp: "2026-01-02T03:04:05.000Z",
          url: null,
          imageUrl: null,
          direction: "short",
        },
      },
    );

    expect("thesis" in selection).toBe(false);
  });

  test("the stock escape hatch on a perp row stamps the stocks venue", () => {
    // SOL is Solana on Hyperliquid and ReneSola on Nasdaq: without the venue
    // stamp, an equity order could be linked to the perp call's signal id.
    expect(stockFromPerpSelection(SOURCE).venue).toBe("stocks");
    expect(stockFromPerpSelection(SOURCE).symbol).toBe("SOL");
    expect(stockFromPerpSelection(SOURCE).copySourceItemId).toBeUndefined();
  });

  test("a perp copy carries the coin, side and leverage plus its source row", () => {
    expect(
      perpSignalSelection(
        { coin: "kPEPE", side: "short", leverage: 20 },
        { signalId: "row-2", content: "short kPEPE" },
      ),
    ).toEqual({
      coin: "kPEPE",
      side: "short",
      leverage: 20,
      signalId: "row-2",
      content: "short kPEPE",
      copySourceItemId: "x_signal:row-2",
    });
  });

  test("a perp copy without leverage omits it rather than defaulting", () => {
    const selection = perpSignalSelection(
      { coin: "BTC", side: "long" },
      { signalId: "row-3", content: "long BTC" },
    );

    expect(selection.leverage).toBeUndefined();
    expect("symbol" in selection).toBe(false);
  });
});

describe("chart payloads", () => {
  test("the active header venue controls a perp-tagged ticker click", () => {
    const perp = { coin: "SOL", side: "long" as const, leverage: 5 };

    expect(
      signalTickerChartSelection({ activeVenue: "stocks", source: SOURCE, perp }),
    ).toMatchObject({ symbol: "SOL", venue: "stocks" });
    expect(
      signalTickerChartSelection({ activeVenue: "perps", source: SOURCE, perp }),
    ).toMatchObject({ symbol: "SOL", venue: "perps" });
  });

  test("charting an equity keeps the signal, so the order can still be credited", () => {
    // Charting is the primary route to the ticket on mobile. Dropping the
    // signal id here would silently unlink every order placed after a tap.
    const selection = stockChartSelection(SOURCE);

    expect(selection.signalId).toBe("row-1");
    expect(selection.venue).toBe("stocks");
    expect(equityOrderSignalId(selection, "SOL")).toBe("row-1");
  });

  test("charting a perp keeps the signal but can never link an equity order", () => {
    const selection = perpChartSelection(
      { coin: "SOL", side: "short", leverage: 20 },
      { signalId: "row-2", content: "short SOL 20x" },
    );

    expect(selection.signalId).toBe("row-2");
    expect(selection.venue).toBe("perps");
    // SOL is Solana on Hyperliquid and ReneSola on Nasdaq. The venue tag is what
    // stops the perp call's id from riding an equity order on the same ticker.
    expect(equityOrderSignalId(selection, "SOL")).toBeUndefined();
  });

  test("charting a perp does not carry the direction or leverage", () => {
    // Looking at a chart is not an order intent: only Copy may seed a 20x short.
    const selection = perpChartSelection(
      { coin: "kPEPE", side: "short", leverage: 20 },
      { signalId: "row-4", content: "short kPEPE" },
    );

    expect("side" in selection).toBe(false);
    expect("leverage" in selection).toBe(false);
    expect(selection.symbol).toBe("kPEPE");
  });

  test("a stale chart selection does not follow the user to another ticket", () => {
    expect(equityOrderSignalId(stockChartSelection(SOURCE), "NVDA")).toBeUndefined();
  });
});
