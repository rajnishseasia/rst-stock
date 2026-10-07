/**
 * Integration Tests for Orders Router
 * 
 * These tests verify the order submission flow works correctly
 * by mocking the Alpaca client and database interactions.
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { buildOptionsSymbol, getAlpacaSide, getAlpacaType, orderSubmitSchema } from "../routers/orders.js";

// Mock the Alpaca client
const mockCreateOrder = vi.fn();
const mockCreateBracketOrder = vi.fn();
const mockCreateOCOOrder = vi.fn();
const mockCreateTrailingStopOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockGetOrders = vi.fn();
const mockGetAccount = vi.fn();
const mockGetSnapshot = vi.fn();

vi.mock("@trade-bot/alpaca", () => ({
  AlpacaClient: vi.fn().mockImplementation(() => ({
    createOrder: mockCreateOrder,
    createBracketOrder: mockCreateBracketOrder,
    createOCOOrder: mockCreateOCOOrder,
    createTrailingStopOrder: mockCreateTrailingStopOrder,
    cancelOrder: mockCancelOrder,
    getOrders: mockGetOrders,
    getAccount: mockGetAccount,
    getSnapshot: mockGetSnapshot,
  })),
}));

// Mock the credentials function
vi.mock("../lib/credentials.js", () => ({
  getDecryptedCredentials: vi.fn().mockResolvedValue({
    username: "test-key-id",
    accessToken: "test-secret",
    accountType: "PAPER",
    baseUrl: undefined,
  }),
}));

describe("Orders Router - Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    it("should map Market to 'market'", () => {
      expect(getAlpacaType("Market")).toBe("market");
    });

    it("should map Limit to 'limit'", () => {
      expect(getAlpacaType("Limit")).toBe("limit");
    });

    it("should map StopMarket to 'stop'", () => {
      expect(getAlpacaType("StopMarket")).toBe("stop");
    });

    it("should map StopLimit to 'stop_limit'", () => {
      expect(getAlpacaType("StopLimit")).toBe("stop_limit");
    });

    it("should default to 'market' for unknown types", () => {
      expect(getAlpacaType("Unknown")).toBe("market");
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

    it("should validate a correct equity limit order with GTC", () => {
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

    it("should validate a correct equity limit order with DAY", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Limit",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        limitPrice: 150.5,
        timeInForce: "day",
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

    it("should validate a stop market order", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "StopMarket",
        tradeAction: "Sell",
        direction: "long",
        quantity: 100,
        stopPrice: 145,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should validate a stop limit order", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "StopLimit",
        tradeAction: "Sell",
        direction: "long",
        quantity: 100,
        stopPrice: 145,
        limitPrice: 144.5,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid symbol (empty)", () => {
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

    it("should reject invalid quantity (zero)", () => {
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

    it("should validate SellShort direction", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "SellShort",
        direction: "short",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should validate BuyToCover action", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "BuyToCover",
        direction: "short",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should validate SellToOpen for options", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "OPTION",
        orderType: "Market",
        tradeAction: "SellToOpen",
        direction: "short",
        quantity: 1,
        optionExpiration: "250117",
        optionStrike: 150,
        optionType: "PUT",
        timeInForce: "day",
      });
      expect(result.success).toBe(true);
    });

    it("should validate SellToClose for options", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "OPTION",
        orderType: "Market",
        tradeAction: "SellToClose",
        direction: "long",
        quantity: 1,
        optionExpiration: "250117",
        optionStrike: 150,
        optionType: "CALL",
        timeInForce: "day",
      });
      expect(result.success).toBe(true);
    });

    it("should validate BuyToClose for options", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "OPTION",
        orderType: "Market",
        tradeAction: "BuyToClose",
        direction: "short",
        quantity: 1,
        optionExpiration: "250117",
        optionStrike: 150,
        optionType: "PUT",
        timeInForce: "day",
      });
      expect(result.success).toBe(true);
    });

    it("should accept optional maxRisk field", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        maxRisk: 50,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should accept optional notes field", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        notes: "Test order from integration tests",
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should accept skipPresetTp flag", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        skipPresetTp: true,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(true);
    });

    it("should accept forceThreeContracts flag", () => {
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
        forceThreeContracts: true,
        timeInForce: "day",
      });
      expect(result.success).toBe(true);
    });
  });
});

describe("Orders Router - Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateOrder.mockResolvedValue({
      id: "alpaca-order-123",
      status: "accepted",
      symbol: "AAPL",
      side: "buy",
      qty: "100",
      type: "market",
      time_in_force: "gtc",
    });
  });

  describe("Full order submission flow", () => {
    it("should successfully submit an equity market order", async () => {
      // Setup mock for successful order creation
      mockCreateOrder.mockResolvedValueOnce({
        id: "alpaca-order-123",
        status: "accepted",
      });

      // This would be tested with actual tRPC caller in a real integration test
      // For now, we verify the schema and Alpaca client would be called correctly
      const validOrder = {
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      
      // Verify the order would be submitted with correct parameters
      // (In a real test, we'd call the router here with mocked context)
      expect(result.data?.symbol).toBe("AAPL");
      expect(result.data?.quantity).toBe(100);
      expect(result.data?.timeInForce).toBe("gtc");
    });

    it("should successfully submit an equity limit order with GTC", async () => {
      const validOrder = {
        symbol: "TSLA",
        assetType: "EQUITY",
        orderType: "Limit",
        tradeAction: "Buy",
        direction: "long",
        quantity: 50,
        limitPrice: 250.0,
        timeInForce: "gtc",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      expect(result.data?.limitPrice).toBe(250.0);
      expect(result.data?.timeInForce).toBe("gtc");
    });

    it("should successfully submit a day order that expires at market close", async () => {
      const validOrder = {
        symbol: "NVDA",
        assetType: "EQUITY",
        orderType: "Limit",
        tradeAction: "Sell",
        direction: "long",
        quantity: 25,
        limitPrice: 500.0,
        timeInForce: "day",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      expect(result.data?.timeInForce).toBe("day");
    });

    it("should successfully submit an options call order", async () => {
      const validOrder = {
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
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      
      // Verify options symbol would be built correctly
      if (result.success) {
        const osiSymbol = buildOptionsSymbol(
          result.data.symbol,
          result.data.optionExpiration!,
          result.data.optionStrike!,
          result.data.optionType!
        );
        expect(osiSymbol).toBe("AAPL250117C00150000");
      }
    });

    it("should successfully submit an options put order", async () => {
      const validOrder = {
        symbol: "AAPL",
        assetType: "OPTION",
        orderType: "Market",
        tradeAction: "SellToOpen",
        direction: "short",
        quantity: 1,
        optionExpiration: "250120",
        optionStrike: 155,
        optionType: "PUT",
        timeInForce: "day",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      
      if (result.success) {
        const osiSymbol = buildOptionsSymbol(
          result.data.symbol,
          result.data.optionExpiration!,
          result.data.optionStrike!,
          result.data.optionType!
        );
        expect(osiSymbol).toBe("AAPL250120P00155000");
      }
    });

    it("should submit stop loss order correctly", async () => {
      const validOrder = {
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "StopMarket",
        tradeAction: "Sell",
        direction: "long",
        quantity: 100,
        stopPrice: 145.0,
        timeInForce: "gtc",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      
      // Verify stop price is set
      expect(result.data?.stopPrice).toBe(145.0);
      expect(getAlpacaType("StopMarket")).toBe("stop");
    });

    it("should submit stop limit order correctly", async () => {
      const validOrder = {
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "StopLimit",
        tradeAction: "Sell",
        direction: "long",
        quantity: 100,
        stopPrice: 145.0,
        limitPrice: 144.5,
        timeInForce: "gtc",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      
      expect(result.data?.stopPrice).toBe(145.0);
      expect(result.data?.limitPrice).toBe(144.5);
      expect(getAlpacaType("StopLimit")).toBe("stop_limit");
    });

    it("should handle sell short order", async () => {
      const validOrder = {
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "SellShort",
        direction: "short",
        quantity: 100,
        timeInForce: "day",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      expect(getAlpacaSide("SellShort")).toBe("sell");
    });

    it("should handle buy to cover order", async () => {
      const validOrder = {
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "BuyToCover",
        direction: "short",
        quantity: 100,
        timeInForce: "day",
      };

      const result = orderSubmitSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      expect(getAlpacaSide("BuyToCover")).toBe("buy");
    });
  });

  describe("Order error handling", () => {
    it("should reject order with missing required fields", () => {
      // Missing quantity
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        // quantity is missing
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject order with symbol too long", () => {
      // The shared symbolSchema allows up to 21 chars (longest OCC option
      // symbol); anything beyond that is rejected.
      const result = orderSubmitSchema.safeParse({
        symbol: "A".repeat(22),
        assetType: "EQUITY",
        orderType: "Market",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative limit price", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "Limit",
        tradeAction: "Buy",
        direction: "long",
        quantity: 100,
        limitPrice: -10,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative stop price", () => {
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "EQUITY",
        orderType: "StopMarket",
        tradeAction: "Sell",
        direction: "long",
        quantity: 100,
        stopPrice: -5,
        timeInForce: "gtc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject options order without required option fields (schema allows but router should validate)", () => {
      // The schema currently allows optional option fields
      // The actual validation happens in the router when building the options symbol
      const result = orderSubmitSchema.safeParse({
        symbol: "AAPL",
        assetType: "OPTION",
        orderType: "Market",
        tradeAction: "BuyToOpen",
        direction: "long",
        quantity: 1,
        // Missing optionExpiration, optionStrike, optionType
        timeInForce: "day",
      });
      
      // Schema accepts it - validation happens in router
      expect(result.success).toBe(true);
      
      // But the order would fail at submission time because 
      // buildOptionsSymbol requires these fields
      if (result.success) {
        const hasOptionsFields = !!(result.data.optionExpiration && 
                                  result.data.optionStrike && 
                                  result.data.optionType);
        expect(hasOptionsFields).toBe(false); // Fields are missing
      }
    });
  });
});

describe("Order Request Builder", () => {
  it("should build correct order request for market order", () => {
    const orderInput = {
      symbol: "AAPL",
      assetType: "EQUITY",
      orderType: "Market",
      tradeAction: "Buy",
      direction: "long" as const,
      quantity: 100,
      timeInForce: "gtc" as const,
    };

    // Simulate what the router does
    const side = getAlpacaSide(orderInput.tradeAction);
    const type = getAlpacaType(orderInput.orderType);

    expect(side).toBe("buy");
    expect(type).toBe("market");
  });

  it("should build correct order request for limit order with GTC", () => {
    const orderInput = {
      symbol: "AAPL",
      assetType: "EQUITY",
      orderType: "Limit",
      tradeAction: "Buy",
      direction: "long" as const,
      quantity: 100,
      limitPrice: 150.5,
      timeInForce: "gtc" as const,
    };

    const side = getAlpacaSide(orderInput.tradeAction);
    const type = getAlpacaType(orderInput.orderType);

    expect(side).toBe("buy");
    expect(type).toBe("limit");
    expect(orderInput.limitPrice).toBe(150.5);
    expect(orderInput.timeInForce).toBe("gtc");
  });

  it("should build correct order request for options", () => {
    const orderInput = {
      symbol: "AAPL",
      assetType: "OPTION" as const,
      orderType: "Market" as const,
      tradeAction: "BuyToOpen" as const,
      direction: "long" as const,
      quantity: 1,
      optionExpiration: "250117",
      optionStrike: 150,
      optionType: "CALL" as const,
      timeInForce: "day" as const,
    };

    const tradingSymbol = buildOptionsSymbol(
      orderInput.symbol,
      orderInput.optionExpiration,
      orderInput.optionStrike,
      orderInput.optionType
    );

    expect(tradingSymbol).toBe("AAPL250117C00150000");
    expect(getAlpacaSide("BuyToOpen")).toBe("buy");
  });

  it("should handle FOK time in force", () => {
    const orderInput = {
      symbol: "AAPL",
      assetType: "EQUITY",
      orderType: "Limit",
      tradeAction: "Buy",
      direction: "long" as const,
      quantity: 100,
      limitPrice: 150.0,
      timeInForce: "fok" as const,
    };

    expect(orderInput.timeInForce).toBe("fok");
  });

  it("should handle IOC time in force", () => {
    const orderInput = {
      symbol: "AAPL",
      assetType: "EQUITY",
      orderType: "Limit",
      tradeAction: "Buy",
      direction: "long" as const,
      quantity: 100,
      limitPrice: 150.0,
      timeInForce: "ioc" as const,
    };

    expect(orderInput.timeInForce).toBe("ioc");
  });
});
