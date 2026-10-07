import { describe, expect, it } from "bun:test";
import { resolveCloseAllSocialEvent } from "../lib/close-all-social.js";

describe("close-all social publication", () => {
  it("emits an exact local option close with the authoritative action", () => {
    const event = resolveCloseAllSocialEvent(
      { id: "broker-close-1" },
      [{
        id: "local-close-1",
        brokerOrderId: "broker-close-1",
        symbol: "AAPL",
        assetType: "OPTION",
        tradeAction: "BuyToCover",
        direction: "short",
        quantity: 2,
        orderType: "Limit",
        limitPrice: "2.50",
      }],
    );

    expect(event).toEqual({
      orderId: "local-close-1",
      brokerOrderId: "broker-close-1",
      symbol: "AAPL",
      assetType: "OPTION",
      side: "buy",
      qty: 2,
      orderType: "Limit",
      limitPrice: "2.50",
      tradeAction: "BuyToCover",
      direction: "short",
    });
  });

  it("omits a broker close with no exact local identity", () => {
    expect(resolveCloseAllSocialEvent({ id: "broker-close-1" }, [])).toBeNull();
  });

  it("omits ambiguous duplicate local matches instead of last-write-wins", () => {
    const local = {
      id: "local-close-1",
      brokerOrderId: "broker-close-1",
      symbol: "AAPL",
      assetType: "EQUITY",
      tradeAction: "Sell",
      direction: "long",
      quantity: 5,
      orderType: "Market",
      limitPrice: null,
    } as const;
    expect(resolveCloseAllSocialEvent({ id: "broker-close-1" }, [local, { ...local, id: "local-close-2" }])).toBeNull();
  });
});
