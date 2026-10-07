import { describe, it, expect } from "bun:test";
import {
  buildOptionsSymbol,
  getAlpacaSide,
  getAlpacaType,
  orderSubmitSchema,
  resolveAlpacaReplaceTimeInForce,
  resolveAlpacaTimeInForce,
} from "../routers/orders.js";

describe("Orders Router Utilities", () => {
  describe("buildOptionsSymbol", () => {
    it("should build correct OSI symbol for call option", () => {
      const result = buildOptionsSymbol("AAPL", "250117", 150, "CALL");
      expect(result).toBe("AAPL250117C00150000");
    });

    it("should build correct OSI symbol for put option", () => {
      const result = buildOptionsSymbol("AAPL", "250117", 150, "PUT");
      expect(result).toBe("AAPL250117P00150000");
    });

    it("should handle short symbols with padding", () => {
      const result = buildOptionsSymbol("TSLA", "250120", 200, "CALL");
      expect(result).toBe("TSLA250120C00200000");
    });

    it("should handle decimal strikes correctly", () => {
      const result = buildOptionsSymbol("AAPL", "250117", 150.5, "CALL");
      expect(result).toBe("AAPL250117C00150500");
    });

    it("should handle small strikes", () => {
      const result = buildOptionsSymbol("AAPL", "250117", 5, "PUT");
      expect(result).toBe("AAPL250117P00005000");
    });

    it("should handle symbols shorter than 6 characters", () => {
      const result = buildOptionsSymbol("NVDA", "250130", 500, "CALL");
      expect(result).toBe("NVDA250130C00500000");
    });
  });

  describe("getAlpacaSide", () => {
    it("should return 'buy' for buy actions", () => {
      expect(getAlpacaSide("Buy")).toBe("buy");
      expect(getAlpacaSide("BuyToOpen")).toBe("buy");
      expect(getAlpacaSide("BuyToCover")).toBe("buy");
      expect(getAlpacaSide("BuyToClose")).toBe("buy");
    });

    it("should return 'sell' for sell actions", () => {
      expect(getAlpacaSide("Sell")).toBe("sell");
      expect(getAlpacaSide("SellShort")).toBe("sell");
      expect(getAlpacaSide("SellToOpen")).toBe("sell");
      expect(getAlpacaSide("SellToClose")).toBe("sell");
    });

    it("should throw for unknown actions", () => {
      expect(() => getAlpacaSide("Unknown")).toThrow();
    });
  });

  describe("getAlpacaType", () => {
    it("should map order types correctly", () => {
      expect(getAlpacaType("Market")).toBe("market");
      expect(getAlpacaType("Limit")).toBe("limit");
      expect(getAlpacaType("StopMarket")).toBe("stop");
      expect(getAlpacaType("StopLimit")).toBe("stop_limit");
    });

    it("should default to 'market' for unknown types", () => {
      expect(getAlpacaType("Unknown")).toBe("market");
    });
  });

  describe("resolveAlpacaTimeInForce", () => {
    it("uses GTC for option limit sells", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "OPTION",
          orderType: "Limit",
          tradeAction: "SellToClose",
          timeInForce: "day",
        })
      ).toBe("gtc");

      expect(
        resolveAlpacaTimeInForce({
          assetType: "OPTION",
          orderType: "Limit",
          tradeAction: "SellToOpen",
          timeInForce: "day",
        })
      ).toBe("gtc");
    });

    it("uses GTC for equity limit sells", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "EQUITY",
          orderType: "Limit",
          tradeAction: "Sell",
          timeInForce: "day",
        })
      ).toBe("gtc");
    });

    it("honors GTC on option limit buys (Alpaca allows GTC on option limit orders)", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "OPTION",
          orderType: "Limit",
          tradeAction: "BuyToOpen",
          timeInForce: "gtc",
        })
      ).toBe("gtc");
    });

    it("defaults an option limit buy without GTC to DAY", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "OPTION",
          orderType: "Limit",
          tradeAction: "BuyToOpen",
          timeInForce: "day",
        })
      ).toBe("day");
    });

    it("treats an OMITTED timeInForce as not-requested: option limit buy stays DAY", () => {
      // Regression (Codex review on PR #123): the submit schema previously
      // defaulted an omitted timeInForce to "gtc", which made every omission
      // look like an explicit GTC request and wrongly upgraded option limit
      // buys to GTC. The schema field is now optional, so omission must
      // resolve to DAY for option buys.
      expect(
        resolveAlpacaTimeInForce({
          assetType: "OPTION",
          orderType: "Limit",
          tradeAction: "BuyToOpen",
        })
      ).toBe("day");
    });

    it("keeps the equity default (GTC) when timeInForce is omitted", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "EQUITY",
          orderType: "Market",
          tradeAction: "Buy",
        })
      ).toBe("gtc");
    });

    it("forces DAY on non-limit option orders even when GTC is requested", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "OPTION",
          orderType: "Market",
          tradeAction: "SellToClose",
          timeInForce: "gtc",
        })
      ).toBe("day");
    });

    it("preserves equity time-in-force for non-limit-sell orders", () => {
      expect(
        resolveAlpacaTimeInForce({
          assetType: "EQUITY",
          orderType: "Limit",
          tradeAction: "Buy",
          timeInForce: "ioc",
        })
      ).toBe("ioc");
    });
  });

  describe("resolveAlpacaReplaceTimeInForce", () => {
    it("uses GTC when modifying an existing limit sell", () => {
      expect(
        resolveAlpacaReplaceTimeInForce({
          existingOrderType: "limit",
          existingSide: "sell",
          timeInForce: "day",
        })
      ).toBe("gtc");
    });

    it("preserves time-in-force when modifying non-limit-sell orders", () => {
      expect(
        resolveAlpacaReplaceTimeInForce({
          existingOrderType: "limit",
          existingSide: "buy",
          timeInForce: "ioc",
        })
      ).toBe("ioc");
    });
  });

  describe("orderSubmitSchema validation", () => {
    it("should validate a correct equity market order", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should validate a correct equity limit order", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Limit",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        limitPrice: 150.5,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should validate a correct options order", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "OPTION",
        orderType: "Market",
        tradeAction: "BuyToOpen",
        direction: "long",
        quantity: 1,
        optionExpiration: "250117",
        optionStrike: 150,
        optionType: "CALL",
        timeInForce: "day",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid symbol", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid quantity", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 0,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative quantity", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: -10,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid asset type", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "CRYPTO",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid order type", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "TrailingStop",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid trade action", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Hold",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should accept all valid timeInForce values", () => {
      const timeInForces = ["day", "gtc", "ioc", "fok"];
      for (const tif of timeInForces) {
        const result = orderSubmitSchema.safeParse({
          symbol: "AAPL",
          assetType: "EQUITY",
          orderType: "Market",
          tradeAction: "Buy",
          direction: "long",
          quantity: 100,
          timeInForce: tif,
        });
        expect(result.success).toBe(true);
      }
    });

    it("should reject invalid timeInForce value", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "ext",
      });
      expect(result.success).toBe(false);
    });

    it("should transform symbol to uppercase", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "aapl",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.symbol).toBe("AAPL");
      }
    });
  });
});
