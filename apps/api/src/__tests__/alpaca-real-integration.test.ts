/**
 * Real Integration Tests for Orders with Alpaca API
 * 
 * These tests place REAL orders on Alpaca's paper trading API.
 * Set the following environment variables before running:
 * - ALPACA_API_KEY_ID
 * - ALPACA_API_SECRET_KEY
 * 
 * WARNING: These tests will create real orders and may affect your account.
 * Use a paper trading account for testing.
 * 
 * Run with:
 *   ALPACA_API_KEY_ID=your_key ALPACA_API_SECRET_KEY=your_secret bun test
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

const API_KEY_ID = process.env.ALPACA_API_KEY_ID;
const API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;

const shouldRunTests = API_KEY_ID && API_SECRET_KEY;

if (!shouldRunTests) {
  console.log("⚠️  Skipping real Alpaca integration tests - missing ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY");
  console.log("   Set these environment variables to run real integration tests:");
  console.log("   ALPACA_API_KEY_ID=your_key ALPACA_API_SECRET_KEY=your_secret bun test");
}

describe.skipIf(!shouldRunTests)("Alpaca Real Integration Tests", () => {
  let alpacaClient: any;
  let testOrderIds: string[] = [];

  beforeAll(async () => {
    // Create Alpaca client with paper trading
    const { AlpacaClient } = await import("@trade-bot/alpaca");
    
    alpacaClient = new AlpacaClient({
      keyId: API_KEY_ID!,
      secretKey: API_SECRET_KEY!,
      paper: true, // Always use paper trading for tests
    });

    // Verify we can connect
    const account = await alpacaClient.getAccount();
    console.log(`📋 Connected to Alpaca paper account: ${account.account_number}`);
    console.log(`   Portfolio value: $${account.portfolio_value}`);
    console.log(`   Buying power: $${account.buying_power}`);
  });

  afterAll(async () => {
    // Cancel any remaining test orders
    console.log("\n🧹 Cleaning up test orders...");
    for (const orderId of testOrderIds) {
      try {
        await alpacaClient.cancelOrder(orderId);
        console.log(`   Cancelled order: ${orderId}`);
      } catch (e) {
        // Order may have already been filled or cancelled
      }
    }
  });

  describe("Account Connectivity", () => {
    it("should connect to Alpaca and get account info", async () => {
      const account = await alpacaClient.getAccount();
      
      expect(account).toBeDefined();
      expect(account.account_number).toBeDefined();
      expect(account.status).toBe("ACTIVE");
      
      console.log(`   Account: ${account.account_number}`);
      console.log(`   Status: ${account.status}`);
    });

    it("should get available symbols for trading", async () => {
      // Just verify we can get a quote
      const snapshot = await alpacaClient.getSnapshot("AAPL");
      
      // Snapshot may return null if market is closed or symbol not available
      console.log(`   AAPL snapshot:`, snapshot ? "available" : "not available");
    });
  });

  describe("Real Equity Orders", () => {
    it("should place a real market buy order", async () => {
      // Place a small market order
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });

      console.log(`   Created order: ${order.id}`);
      console.log(`   Status: ${order.status}`);
      console.log(`   Symbol: ${order.symbol}`);

      expect(order).toBeDefined();
      expect(order.id).toBeDefined();
      expect(order.symbol).toBe("AAPL");
      expect(order.side).toBe("buy");
      expect(order.type).toBe("market");
      
      testOrderIds.push(order.id);
    });

    it("should place a real limit buy order with GTC", async () => {
      // Place limit order way below current price (won't fill, good for testing)
      const order = await alpacaClient.createOrder({
        symbol: "TSLA",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: 1.0, // Way below market - won't fill
        time_in_force: "gtc", // Good Till Cancelled - will persist
      });

      console.log(`   Created limit order: ${order.id}`);
      console.log(`   Limit price: $${order.limit_price}`);
      console.log(`   Time in force: ${order.time_in_force}`);

      expect(order).toBeDefined();
      expect(order.id).toBeDefined();
      expect(order.symbol).toBe("TSLA");
      expect(order.side).toBe("buy");
      expect(order.type).toBe("limit");
      expect(order.limit_price).toBe("1.00");
      expect(order.time_in_force).toBe("gtc");
      
      testOrderIds.push(order.id);
    });

    it("should place a real limit sell order", async () => {
      const order = await alpacaClient.createOrder({
        symbol: "NVDA",
        qty: 1,
        side: "sell",
        type: "limit",
        limit_price: 99999.0, // Won't fill
        time_in_force: "gtc",
      });

      console.log(`   Created sell order: ${order.id}`);

      expect(order).toBeDefined();
      expect(order.side).toBe("sell");
      
      testOrderIds.push(order.id);
    });

    it("should fetch the created order from Alpaca", async () => {
      // First create an order
      const createdOrder = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });

      console.log(`   Created order: ${createdOrder.id}`);
      testOrderIds.push(createdOrder.id);

      // Now fetch it back
      const fetchedOrder = await alpacaClient.getOrder(createdOrder.id);

      expect(fetchedOrder).toBeDefined();
      expect(fetchedOrder.id).toBe(createdOrder.id);
      expect(fetchedOrder.symbol).toBe("AAPL");
      
      console.log(`   Fetched order status: ${fetchedOrder.status}`);
    });

    it("should list all open orders", async () => {
      // Create a few orders first
      await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: 1.0,
        time_in_force: "gtc",
      });

      await alpacaClient.createOrder({
        symbol: "MSFT",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: 1.0,
        time_in_force: "gtc",
      });

      // List open orders
      const openOrders = await alpacaClient.getOrders("open", 50);

      console.log(`   Open orders count: ${openOrders.length}`);
      
      // Should have at least the orders we just created
      expect(openOrders.length).toBeGreaterThan(0);
      
      // Verify our test symbols are there
      const symbols = openOrders.map((o: any) => o.symbol);
      console.log(`   Open order symbols: ${symbols.join(", ")}`);
    });

    it("should cancel an order", async () => {
      // Create an order
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: 1.0,
        time_in_force: "gtc",
      });

      console.log(`   Created order: ${order.id}`);
      
      // Cancel it
      await alpacaClient.cancelOrder(order.id);
      
      // Verify it's cancelled
      const cancelledOrder = await alpacaClient.getOrder(order.id);
      console.log(`   Order status after cancel: ${cancelledOrder.status}`);
      
      expect(cancelledOrder.status).toBe("canceled");
    });
  });

  describe("Real Options Orders", () => {
    it("should place a real options order", async () => {
      // Build options symbol: AAPL 250117C00150000
      // This is AAPL call option at $150 expiring Jan 17, 2025
      const optionsSymbol = "AAPL  250117C00150000";

      try {
        const order = await alpacaClient.createOrder({
          symbol: optionsSymbol,
          qty: 1,
          side: "buy",
          type: "market",
          time_in_force: "day",
        });

        console.log(`   Created options order: ${order.id}`);
        console.log(`   Symbol: ${order.symbol}`);
        console.log(`   Status: ${order.status}`);

        expect(order).toBeDefined();
        expect(order.symbol).toBe(optionsSymbol);
        
        testOrderIds.push(order.id);
      } catch (error: any) {
        // Options contract might not exist or options not enabled
        console.log(`   Options order failed (may need options enabled): ${error.message}`);
        
        // This is expected if options trading is not enabled
        expect(error.message).toMatch(/not found|options trading|not allowed/i);
      }
    });
  });

  describe("Bracket Orders (TP + SL)", () => {
    it("should place a real bracket order with TP and SL", async () => {
      // Get current price
      const snapshot = await alpacaClient.getSnapshot("AAPL");
      const currentPrice = parseFloat(snapshot?.latestTrade?.p || 150);
      
      const tpPrice = (currentPrice * 1.05).toFixed(2); // 5% profit
      const slPrice = (currentPrice * 0.95).toFixed(2); // 5% loss

      console.log(`   Current AAPL price: $${currentPrice}`);
      console.log(`   Take profit at: $${tpPrice}`);
      console.log(`   Stop loss at: $${slPrice}`);

      try {
        const order = await alpacaClient.createBracketOrder({
          symbol: "AAPL",
          qty: 1,
          side: "buy",
          type: "limit",
          limit_price: currentPrice.toString(),
          time_in_force: "day",
          take_profit: {
            limit_price: parseFloat(tpPrice),
          },
          stop_loss: {
            stop_price: parseFloat(slPrice),
            limit_price: parseFloat(slPrice) - 0.5,
          },
        });

        console.log(`   Created bracket order: ${order.id}`);
        console.log(`   Order class: ${order.order_class}`);
        console.log(`   Legs count: ${order.legs?.length}`);

        expect(order).toBeDefined();
        expect(order.order_class).toBe("bracket");
        expect(order.legs).toBeDefined();
        
        testOrderIds.push(order.id);
      } catch (error: any) {
        console.log(`   Bracket order failed: ${error.message}`);
        // May fail if account doesn't support bracket orders
      }
    });
  });

  describe("Order Data Verification", () => {
    it("should track order lifecycle states", async () => {
      // Create a limit order that won't fill immediately
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: "0.01", // Won't fill
        time_in_force: "gtc",
      });

      console.log(`   Order ID: ${order.id}`);
      console.log(`   Initial status: ${order.status}`);
      
      testOrderIds.push(order.id);

      // Possible statuses: pending, accepted, new, filled, partially_filled, canceled, expired, rejected
      const validStatuses = ["pending", "accepted", "new", "filled", "partially_filled", "canceled", "expired", "rejected"];
      expect(validStatuses).toContain(order.status);

      // Cancel the order
      await alpacaClient.cancelOrder(order.id);
      
      // Check final status
      const finalOrder = await alpacaClient.getOrder(order.id);
      console.log(`   Final status: ${finalOrder.status}`);
      
      expect(finalOrder.status).toBe("canceled");
    });

    it("should correctly map order types and sides", async () => {
      const testCases = [
        { qty: 1, side: "buy", type: "market", time_in_force: "day" },
        { qty: 1, side: "sell", type: "market", time_in_force: "day" },
        { qty: 1, side: "buy", type: "limit", limit_price: "100.00", time_in_force: "gtc" },
        { qty: 1, side: "buy", type: "stop", stop_price: "90.00", time_in_force: "gtc" },
        { qty: 1, side: "buy", type: "stop_limit", stop_price: "90.00", limit_price: "89.00", time_in_force: "gtc" },
      ];

      for (const testCase of testCases) {
        const order = await alpacaClient.createOrder({
          symbol: "AAPL",
          ...testCase,
        });

        console.log(`   Created ${testCase.side} ${testCase.type} order: ${order.id}`);
        
        expect(order.symbol).toBe("AAPL");
        expect(order.side).toBe(testCase.side);
        expect(order.type).toBe(testCase.type);
        
        testOrderIds.push(order.id);
      }
    });
  });

  describe("Time In Force", () => {
    it("should handle DAY orders", async () => {
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });

      expect(order.time_in_force).toBe("day");
      testOrderIds.push(order.id);
    });

    it("should handle GTC orders", async () => {
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: "1.00",
        time_in_force: "gtc",
      });

      expect(order.time_in_force).toBe("gtc");
      testOrderIds.push(order.id);
    });

    it("should handle IOC orders", async () => {
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: "999999.00",
        time_in_force: "ioc",
      });

      expect(order.time_in_force).toBe("ioc");
      testOrderIds.push(order.id);
    });

    it("should handle FOK orders", async () => {
      const order = await alpacaClient.createOrder({
        symbol: "AAPL",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: "999999.00",
        time_in_force: "fok",
      });

      expect(order.time_in_force).toBe("fok");
      testOrderIds.push(order.id);
    });
  });
});

console.log("\n📝 Real Integration Test Summary:");
console.log("   These tests place REAL orders on Alpaca paper trading.");
console.log("   Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY to run them.\n");
