import { describe, it, expect } from "bun:test";
import { buildOrderDraft } from "../lib/chat/tools/lib/order-draft.js";

describe("buildOrderDraft (confirm-before-submit safety)", () => {
  it("ALWAYS produces status 'draft' and never a submitted/order-id field", () => {
    // Exercise a spread of inputs; every draft must stay a draft.
    const inputs = [
      { symbol: "AAPL", side: "buy" as const, quantity: 100, entryPrice: 190, stopLoss: 185 },
      { symbol: "TSLA", side: "sell" as const, quantity: 10 },
      { symbol: "TSLA", side: "sell" as const, direction: "short" as const, quantity: 10 },
      { symbol: "NVDA", side: "buy" as const, stopLoss: 100, maxRisk: 500, entryPrice: 105 },
      { symbol: "", side: "buy" as const }, // invalid
      { symbol: "SPY", side: "buy" as const, orderType: "limit" as const }, // missing limit
    ];
    for (const input of inputs) {
      const draft = buildOrderDraft(input);
      expect(draft.status).toBe("draft");
      // The shape must not carry anything that reads as a placed order.
      const keys = Object.keys(draft);
      expect(keys).not.toContain("submitted");
      expect(keys).not.toContain("orderId");
      expect(keys).not.toContain("brokerOrderId");
      expect(keys).not.toContain("clientOrderId");
      // The literal is a string, so no truthy "isSubmitted"-style leakage.
      expect(draft.status).not.toBe("submitted");
    }
  });

  it("builds a valid long draft with correct prefill and risk math", () => {
    const draft = buildOrderDraft({
      symbol: "aapl",
      side: "buy",
      quantity: 100,
      entryPrice: 190,
      stopLoss: 185,
      takeProfit: 200,
    });
    expect(draft.valid).toBe(true);
    expect(draft.symbol).toBe("AAPL");
    expect(draft.quantity).toBe(100);
    // Both stop + target => OCO ticket.
    expect(draft.prefill.orderType).toBe("OCO");
    expect(draft.prefill.symbol).toBe("AAPL");
    expect(draft.prefill.side).toBe("buy");
    expect(draft.prefill.entry).toBe(190);
    expect(draft.prefill.stopLoss).toBe(185);
    expect(draft.prefill.takeProfit).toBe(200);
    expect(draft.riskReward?.riskPerShare).toBe(5); // 190 - 185
    expect(draft.riskReward?.riskRewardRatio).toBe(2); // (200-190)/5
  });

  it("sizes quantity from a stop + max-risk budget when quantity is omitted", () => {
    const draft = buildOrderDraft({
      symbol: "NVDA",
      side: "buy",
      entryPrice: 100,
      stopLoss: 95,
      maxRisk: 500,
    });
    expect(draft.valid).toBe(true);
    expect(draft.quantity).toBe(100); // 500 / 5
    expect(draft.prefill.quantity).toBe(100);
  });

  it("marks a market order with no quantity and no sizing inputs invalid", () => {
    const draft = buildOrderDraft({ symbol: "AAPL", side: "buy" });
    expect(draft.valid).toBe(false);
    expect(draft.errors.join(" ")).toContain("Quantity is required");
    // An invalid draft still stays a draft.
    expect(draft.status).toBe("draft");
  });

  it("requires a limit price for a limit entry", () => {
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "limit",
    });
    expect(draft.valid).toBe(false);
    expect(draft.errors.join(" ")).toContain("limit price");
  });

  it("rejects a malformed ticker symbol", () => {
    const draft = buildOrderDraft({ symbol: "not a ticker", side: "buy", quantity: 1 });
    expect(draft.valid).toBe(false);
    expect(draft.errors.join(" ")).toContain("valid ticker");
  });

  it("chooses a Limit ticket (not OCO) when only an entry is set", () => {
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "limit",
      limitPrice: 190,
    });
    expect(draft.valid).toBe(true);
    expect(draft.prefill.orderType).toBe("Limit");
    expect(draft.prefill.limitPrice).toBe(190);
  });

  it("keeps a limit bracket's Limit entry on the OCO prefill with the limit price", () => {
    // "limit buy AAPL at 180 with stop 170 target 200": the ticket collapses
    // to OCO but must not degrade the entry to a market order.
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "limit",
      limitPrice: 180,
      stopLoss: 170,
      takeProfit: 200,
    });
    expect(draft.valid).toBe(true);
    expect(draft.prefill.orderType).toBe("OCO");
    expect(draft.prefill.entryOrderType).toBe("Limit");
    expect(draft.prefill.limitPrice).toBe(180);
    expect(draft.prefill.entry).toBe(180);
    // Still a draft: no submitted/order-id leakage on the new fields either.
    expect(draft.status).toBe("draft");
    expect(Object.keys(draft)).not.toContain("submitted");
    expect(Object.keys(draft)).not.toContain("orderId");
  });

  it("pins a market bracket's OCO entry leg to Market and leaves it null off OCO", () => {
    const bracket = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
    });
    expect(bracket.prefill.orderType).toBe("OCO");
    expect(bracket.prefill.entryOrderType).toBe("Market");

    const plainLimit = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "limit",
      limitPrice: 190,
    });
    expect(plainLimit.prefill.orderType).toBe("Limit");
    expect(plainLimit.prefill.entryOrderType).toBeNull();
  });

  it("routes a stop-only draft to the OCO/exit-plan ticket with the Market entry preserved", () => {
    // "buy 100 AAPL with a stop at 185": a plain Market ticket would submit a
    // naked entry (the stop is only stored locally there), so the prefill must
    // pick the exit-plan (OCO) ticket where the stop is broker-attached.
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 100,
      entryPrice: 190,
      stopLoss: 185,
    });
    expect(draft.valid).toBe(true);
    expect(draft.prefill.orderType).toBe("OCO");
    expect(draft.prefill.entryOrderType).toBe("Market");
    expect(draft.prefill.stopLoss).toBe(185);
    expect(draft.prefill.takeProfit).toBeNull();
    // Still a draft: routing to the exit-plan ticket never submits anything.
    expect(draft.status).toBe("draft");
  });

  it("routes a stop-only LIMIT draft to OCO while keeping its Limit entry and price", () => {
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      orderType: "limit",
      limitPrice: 190,
      stopLoss: 185,
    });
    expect(draft.valid).toBe(true);
    expect(draft.prefill.orderType).toBe("OCO");
    expect(draft.prefill.entryOrderType).toBe("Limit");
    expect(draft.prefill.limitPrice).toBe(190);
    expect(draft.prefill.stopLoss).toBe(185);
    expect(draft.prefill.takeProfit).toBeNull();
  });

  it("carries the time in force through the draft and prefill", () => {
    const day = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      timeInForce: "day",
    });
    expect(day.timeInForce).toBe("day");
    expect(day.prefill.timeInForce).toBe("day");

    const gtc = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      timeInForce: "gtc",
    });
    expect(gtc.prefill.timeInForce).toBe("gtc");

    // Absent TIF defaults to gtc, matching the tool's input coercion.
    const defaulted = buildOrderDraft({ symbol: "AAPL", side: "buy", quantity: 10 });
    expect(defaulted.prefill.timeInForce).toBe("gtc");
  });

  it("carries an explicit short intent through the draft and prefill", () => {
    // "short AAPL": the ticket must open a short, not read as closing a long.
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "sell",
      direction: "short",
      quantity: 10,
      entryPrice: 100,
      stopLoss: 105,
      takeProfit: 90,
    });
    expect(draft.valid).toBe(true);
    expect(draft.direction).toBe("short");
    expect(draft.prefill.direction).toBe("short");
    expect(draft.prefill.side).toBe("sell");
    // Short risk math: stop above entry is correct, no directional warning.
    expect(draft.riskReward?.riskPerShare).toBe(5); // 105 - 100
    expect(draft.status).toBe("draft");
    expect(Object.keys(draft)).not.toContain("submitted");
    expect(Object.keys(draft)).not.toContain("orderId");
  });

  it("leaves direction null for plain buy/sell drafts (existing behavior preserved)", () => {
    const buy = buildOrderDraft({ symbol: "AAPL", side: "buy", quantity: 10 });
    expect(buy.direction).toBeNull();
    expect(buy.prefill.direction).toBeNull();

    const sell = buildOrderDraft({ symbol: "AAPL", side: "sell", quantity: 10 });
    expect(sell.direction).toBeNull();
    expect(sell.prefill.direction).toBeNull();
  });

  it("drops a contradictory short-on-buy intent with a warning", () => {
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      direction: "short",
      quantity: 10,
    });
    expect(draft.direction).toBeNull();
    expect(draft.prefill.direction).toBeNull();
    expect(draft.warnings.join(" ")).toContain('Ignoring direction "short"');
    expect(draft.status).toBe("draft");
  });

  it("surfaces a directional stop mistake as a non-blocking warning", () => {
    // Long with a stop ABOVE entry: the draft still prefills so the user can
    // fix it in the ticket, but the mistake is flagged.
    const draft = buildOrderDraft({
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      entryPrice: 100,
      stopLoss: 105,
    });
    expect(draft.warnings.join(" ")).toContain("stop must be below");
    expect(draft.status).toBe("draft");
  });

  it("performs no I/O and is a pure function of its input", () => {
    const input = { symbol: "AAPL", side: "buy" as const, quantity: 10, entryPrice: 100, stopLoss: 95 };
    const a = buildOrderDraft(input);
    const b = buildOrderDraft(input);
    expect(a).toEqual(b);
  });
});
