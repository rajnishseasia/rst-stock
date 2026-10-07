import { describe, expect, it } from "bun:test";
import { resolveCloseAllSocialEvent } from "../lib/close-all-social.js";
import { resolveUniqueAuthoritativeOrder } from "../lib/authoritative-order.js";

describe("social feed order identity", () => {
  it("excludes an ambiguous legacy social row from reader results", () => {
    expect(resolveUniqueAuthoritativeOrder(
      { userId: "user-1", orderId: null, brokerOrderId: "broker-1" },
      [
        {
          id: "order-1",
          userId: "user-1",
          brokerOrderId: "broker-1",
          brokerAccountId: "account-1",
          brokerCredentialId: "credential-1",
          venue: "alpaca",
        },
        {
          id: "order-2",
          userId: "user-1",
          brokerOrderId: "broker-1",
          brokerAccountId: "account-2",
          brokerCredentialId: "credential-2",
          venue: "alpaca",
        },
      ],
    )).toBeNull();
  });

  it("keeps close-all action and asset metadata from the exact local order", () => {
    const event = resolveCloseAllSocialEvent(
      { id: "broker-close" },
      [{
        id: "local-close",
        brokerOrderId: "broker-close",
        symbol: "AAPL",
        assetType: "OPTION",
        tradeAction: "SellToClose",
        direction: "long",
        quantity: 1,
        orderType: "Market",
        limitPrice: null,
      }],
    );
    expect(event).toMatchObject({
      orderId: "local-close",
      assetType: "OPTION",
      side: "sell",
      tradeAction: "SellToClose",
    });
  });
});
