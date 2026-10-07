import { describe, expect, test } from "bun:test";
import {
  copyTradeQuoteIdentity,
  findCopyTradePerpQuote,
  selectCopyTradeQuoteInputs,
  type CopyTradeQuoteItem,
} from "./copy-trade-quotes";

/** Build the small feed-row shape needed by the quote helpers. */
function item(symbol: string, meta: Record<string, unknown>): CopyTradeQuoteItem {
  return { symbol, meta };
}

describe("copy-trade quote identity", () => {
  test("keeps BTC/PUMP perp rows out of the Alpaca batch when tickers collide", () => {
    const inputs = selectCopyTradeQuoteInputs([
      item("BTC", { assetType: "EQUITY" }),
      item("BTC", {
        assetType: "PERP",
        perpVenue: "hyperliquid",
        perpCoin: "BTC",
      }),
      item("PUMP", {
        assetType: "PERP",
        perpVenue: "hyperliquid",
        perpCoin: "PUMP",
      }),
    ]);

    expect(inputs.stockSymbols).toEqual(["BTC"]);
    expect(inputs.perpCoins).toEqual(["BTC", "PUMP"]);
  });

  test("preserves the HIP-3 xyz:SNDK route instead of stripping its prefix", () => {
    const identity = copyTradeQuoteIdentity(
      item("SNDK", {
        assetType: "PERP",
        perpVenue: "hyperliquid",
        perpCoin: "xyz:SNDK",
      }),
    );

    expect(identity).toEqual({ venue: "perps", coin: "xyz:SNDK" });
    expect(
      findCopyTradePerpQuote(identity, [
        { coin: "SNDK", markPx: "12", prevDayPx: "11" },
        { coin: "xyz:SNDK", markPx: "13", prevDayPx: "12" },
      ]),
    ).toEqual({ coin: "xyz:SNDK", markPx: "13", prevDayPx: "12" });
  });

  test("preserves Hyperliquid's mixed-case kPEPE identity", () => {
    const identity = copyTradeQuoteIdentity(
      item("kPEPE", {
        assetType: "PERP",
        perpVenue: "hyperliquid",
        perpCoin: "kPEPE",
      }),
    );

    expect(identity).toEqual({ venue: "perps", coin: "kPEPE" });
    expect(
      findCopyTradePerpQuote(identity, [
        { coin: "KPEPE", markPx: "1", prevDayPx: "1" },
        { coin: "kPEPE", markPx: "2", prevDayPx: "1" },
      ]),
    ).toEqual({ coin: "kPEPE", markPx: "2", prevDayPx: "1" });
  });

  test("returns no perp quote for an unknown or missing market, without stock fallback", () => {
    const unknownIdentity = copyTradeQuoteIdentity(
      item("BTC", {
        assetType: "PERP",
        perpVenue: "hyperliquid",
        perpCoin: "NOTAMARKET",
      }),
    );
    const missingIdentity = copyTradeQuoteIdentity(
      item("BTC", { assetType: "PERP", perpVenue: "hyperliquid" }),
    );

    expect(unknownIdentity).toEqual({ venue: "perps", coin: "NOTAMARKET" });
    expect(missingIdentity).toEqual({ venue: "perps", coin: null });
    expect(
      findCopyTradePerpQuote(unknownIdentity, [
        { coin: "BTC", markPx: "60000", prevDayPx: "59000" },
      ]),
    ).toBeUndefined();
    expect(findCopyTradePerpQuote(missingIdentity, [])).toBeUndefined();

    const inputs = selectCopyTradeQuoteInputs([
      item("BTC", { assetType: "PERP", perpVenue: "hyperliquid" }),
    ]);
    expect(inputs.stockSymbols).toEqual([]);
    expect(inputs.perpCoins).toEqual([]);
  });

  test("keeps ordinary equity rows on the existing stock quote path", () => {
    const identity = copyTradeQuoteIdentity(item("aapl", { assetType: "EQUITY" }));

    expect(identity).toEqual({ venue: "stocks", symbol: "AAPL" });
    expect(
      selectCopyTradeQuoteInputs([
        item("aapl", { assetType: "EQUITY" }),
        item("TSLA", { assetType: "OPTION" }),
      ]),
    ).toEqual({ stockSymbols: ["AAPL", "TSLA"], perpCoins: [] });
  });

  test("does not treat an unconfirmed venue as a stock quote", () => {
    const identity = copyTradeQuoteIdentity(
      item("BTC", { assetType: "PERP", perpVenue: "alpaca", perpCoin: "BTC" }),
    );

    expect(identity).toEqual({ venue: "perps", coin: null });
    expect(
      selectCopyTradeQuoteInputs([
        item("BTC", { assetType: "PERP", perpVenue: "alpaca", perpCoin: "BTC" }),
      ]),
    ).toEqual({
      stockSymbols: [],
      perpCoins: [],
    });
  });
});
