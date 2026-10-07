import { describe, expect, test } from "bun:test";
import { copyDisabledReason } from "./copy-eligibility";
import { perpCopyFromTradeRow } from "./copy-perp-route";
import {
  computeCopyRowState,
  resolveCopyDispatch,
} from "./copy-trade-row-state";
import {
  copyTradeQuoteIdentity,
  selectCopyTradeQuoteInputs,
} from "./copy-trade-quotes";

const PARTIAL_PERP_MARKERS: Array<[string, Record<string, unknown>]> = [
  ["assetType", { assetType: "PERP" }],
  ["perpVenue", { perpVenue: "hyperliquid" }],
  ["perpCoin", { perpCoin: "SOL" }],
  ["perpDirection", { perpDirection: "long" }],
  ["perpReduceOnly", { perpReduceOnly: false }],
  ["perpLeverage", { perpLeverage: 10 }],
];

describe("copy-trade conservative venue classification", () => {
  test.each(PARTIAL_PERP_MARKERS)(
    "%s alone stays out of equity quote, eligibility, and dispatch paths",
    (_marker, meta) => {
      const identity = copyTradeQuoteIdentity({ symbol: "SOL", meta });
      expect(identity.venue).toBe("perps");

      const inputs = selectCopyTradeQuoteInputs([{ symbol: "SOL", meta }]);
      expect(inputs.stockSymbols).toEqual([]);

      const route = perpCopyFromTradeRow(meta, { perpsEnabled: true });
      expect(route?.kind).toBe("refused");

      const eligibility = copyDisabledReason(meta, "buy");
      expect(eligibility).toContain("perp");

      const row = computeCopyRowState({
        meta,
        side: "buy",
        rawQty: 10,
        copyEligibilityReason: eligibility,
        perpRoute: route,
        hasPerpHandler: true,
        quoteLast: "10",
        optionBid: undefined,
        optionAsk: undefined,
        sizingMode: "usd",
        sizingValue: 100,
        targetDollars: 100,
        pctNeedsBrokerage: false,
        pctEquityNeedsBrokerage: false,
      });
      expect(row.copyDisabled).toBe(true);
      expect(row.buttonLabel).not.toContain(" sh");

      const dispatch = resolveCopyDispatch({
        perpRoute: null,
        item: {
          id: "user:partial-perp",
          symbol: "SOL",
          side: "buy",
          source: "user",
          meta,
        },
        isOption: false,
        qty: 10,
      });
      expect(dispatch).toEqual({ kind: "noop" });
    },
  );

  test("keeps a SOL stock collision and SOL perp in separate quote inputs", () => {
    expect(
      selectCopyTradeQuoteInputs([
        { symbol: "SOL", meta: { assetType: "EQUITY" } },
        { symbol: "SOL", meta: { perpVenue: "hyperliquid", perpCoin: "SOL" } },
      ]),
    ).toEqual({ stockSymbols: ["SOL"], perpCoins: ["SOL"] });
  });

  test("keeps a partial HIP-3 coin on the perp side without inventing a stock quote", () => {
    const meta = { perpCoin: "xyz:GOOGL" };
    expect(copyTradeQuoteIdentity({ symbol: "GOOGL", meta })).toEqual({
      venue: "perps",
      coin: null,
    });
    expect(selectCopyTradeQuoteInputs([{ symbol: "GOOGL", meta }])).toEqual({
      stockSymbols: [],
      perpCoins: [],
    });
    expect(perpCopyFromTradeRow(meta, { perpsEnabled: true })?.kind).toBe("refused");
  });

  test("does not let an explicit unknown asset type become an equity order", () => {
    const meta = { assetType: "UNKNOWN" };
    expect(copyTradeQuoteIdentity({ symbol: "AAPL", meta }).venue).toBe("unknown");
    expect(selectCopyTradeQuoteInputs([{ symbol: "AAPL", meta }])).toEqual({
      stockSymbols: [],
      perpCoins: [],
    });
    expect(copyDisabledReason(meta, "buy")).toContain("could not be confirmed");
    expect(
      resolveCopyDispatch({
        perpRoute: null,
        item: {
          id: "user:unknown",
          symbol: "AAPL",
          side: "buy",
          source: "user",
          meta,
        },
        isOption: false,
        qty: 1,
      }),
    ).toEqual({ kind: "noop" });
  });
});
