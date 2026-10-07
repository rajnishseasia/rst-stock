import { describe, expect, it } from "bun:test";
import { isLimitSellOrder, resolveTradeFormTimeInForce } from "../trade-time-in-force";

describe("trade time-in-force rules", () => {
  it("uses GTC for equity limit sells", () => {
    expect(
      resolveTradeFormTimeInForce({
        assetType: "EQUITY",
        orderType: "Limit",
        action: "Sell",
        timeInForce: "day",
      })
    ).toBe("gtc");
  });

  it("uses GTC for option limit sells", () => {
    expect(
      resolveTradeFormTimeInForce({
        assetType: "OPTION",
        orderType: "Limit",
        action: "SellToClose",
        timeInForce: "day",
      })
    ).toBe("gtc");
  });

  it("honors GTC for option limit buys (Alpaca allows GTC on option limit orders)", () => {
    expect(
      resolveTradeFormTimeInForce({
        assetType: "OPTION",
        orderType: "Limit",
        action: "BuyToOpen",
        timeInForce: "gtc",
      })
    ).toBe("gtc");
  });

  it("clamps an option limit buy without GTC to DAY", () => {
    expect(
      resolveTradeFormTimeInForce({
        assetType: "OPTION",
        orderType: "Limit",
        action: "BuyToOpen",
        timeInForce: "day",
      })
    ).toBe("day");
  });

  it("forces DAY for option market orders (GTC not allowed on non-limit options)", () => {
    expect(
      resolveTradeFormTimeInForce({
        assetType: "OPTION",
        orderType: "Market",
        action: "SellToClose",
        timeInForce: "gtc",
      })
    ).toBe("day");
  });

  it("preserves equity non-limit-sell time-in-force", () => {
    expect(
      resolveTradeFormTimeInForce({
        assetType: "EQUITY",
        orderType: "Limit",
        action: "Buy",
        timeInForce: "ioc",
      })
    ).toBe("ioc");
  });

  it("identifies sell actions across equities and options", () => {
    expect(
      isLimitSellOrder({
        assetType: "EQUITY",
        orderType: "Limit",
        action: "SellShort",
      })
    ).toBe(true);
    expect(
      isLimitSellOrder({
        assetType: "OPTION",
        orderType: "Limit",
        action: "BuyToOpen",
      })
    ).toBe(false);
  });
});
