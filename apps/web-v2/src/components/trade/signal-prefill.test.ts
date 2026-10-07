import { describe, expect, test } from "bun:test";
import { resolveSignalPrefillPlan } from "./signal-prefill";

describe("resolveSignalPrefillPlan", () => {
  test("a plain Market draft yields a Market ticket, not the default OCO", () => {
    // A market draft carries side + qty upstream but no entry/stop/target here.
    const plan = resolveSignalPrefillPlan({ orderType: "Market" });
    expect(plan.orderType).toBe("Market");
    // Nothing else is seeded, so a market ticket stays clean.
    expect(plan.stopMarketPrice).toBeUndefined();
    expect(plan.entryPriceRef).toBeUndefined();
    expect(plan.limitPrice).toBeUndefined();
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a Limit draft yields a Limit ticket with the limit price filled", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 148,
      orderType: "Limit",
      limitPrice: 150,
    });
    expect(plan.orderType).toBe("Limit");
    // Explicit limit price wins over the entry-derived default.
    expect(plan.limitPrice).toBe("150.00");
    expect(plan.entryPriceRef).toBe("148.00");
    expect(plan.stopMarketPrice).toBeUndefined();
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a Limit draft without an explicit limit price falls back to entry", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 150,
      orderType: "Limit",
    });
    expect(plan.orderType).toBe("Limit");
    expect(plan.limitPrice).toBe("150.00");
    expect(plan.entryPriceRef).toBe("150.00");
  });

  test("a StopLimit draft also fills the limit price from the explicit value", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 100,
      orderType: "StopLimit",
      limitPrice: 101,
    });
    expect(plan.orderType).toBe("StopLimit");
    expect(plan.limitPrice).toBe("101.00");
  });

  test("a bracket (stop + target) yields the OCO ticket with a single TP row", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 100,
      stopLoss: 95,
      takeProfit: 110,
      orderType: "OCO",
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.stopMarketPrice).toBe("95.00");
    expect(plan.entryPriceRef).toBe("100.00");
    // Entry seeds the limit price (a limit entry rests at the suggested price).
    expect(plan.limitPrice).toBe("100.00");
    expect(plan.takeProfits).toEqual([{ price: "110.00", quantity: "1" }]);
  });

  test("preserves the copy-signal default: a stop + target pair auto-switches to OCO with no explicit order type", () => {
    // This is the pre-existing Signa "Copy signal" path (new props absent).
    const plan = resolveSignalPrefillPlan({
      entry: 100,
      stopLoss: 95,
      takeProfit: 110,
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.stopMarketPrice).toBe("95.00");
    expect(plan.entryPriceRef).toBe("100.00");
    expect(plan.limitPrice).toBe("100.00");
    expect(plan.takeProfits).toEqual([{ price: "110.00", quantity: "1" }]);
  });

  test("an entry-only prefill (no stop/target, no order type) leaves the order type untouched", () => {
    const plan = resolveSignalPrefillPlan({ entry: 50 });
    expect(plan.orderType).toBeUndefined();
    expect(plan.entryPriceRef).toBe("50.00");
    expect(plan.limitPrice).toBe("50.00");
    expect(plan.stopMarketPrice).toBeUndefined();
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a stop without a target and no explicit order type leaves the order type untouched", () => {
    // Signa copy path: the form's default ticket is already OCO, so no
    // override is needed for the stop to attach.
    const plan = resolveSignalPrefillPlan({ stopLoss: 40 });
    expect(plan.orderType).toBeUndefined();
    expect(plan.stopMarketPrice).toBe("40.00");
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a stop-only Market draft routes to the OCO/exit-plan ticket with a Market entry", () => {
    // "buy 100 AAPL with a stop at 185": the plain Market ticket only stores
    // the stop locally and submits a naked entry, so the plan must upgrade to
    // the exit-plan (OCO) ticket where the stop is broker-attached.
    const plan = resolveSignalPrefillPlan({
      entry: 190,
      stopLoss: 185,
      orderType: "Market",
      entryOrderType: "Market",
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.entryOrderType).toBe("Market");
    expect(plan.stopMarketPrice).toBe("185.00");
    expect(plan.entryPriceRef).toBe("190.00");
    // No target: the exit plan is stop-only, no TP row is seeded.
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a stop-only Limit draft routes to OCO and keeps its Limit entry at the limit price", () => {
    const plan = resolveSignalPrefillPlan({
      stopLoss: 180,
      orderType: "Limit",
      limitPrice: 190,
    });
    expect(plan.orderType).toBe("OCO");
    // Entry type preserved from the plain draft even without an explicit
    // entryOrderType.
    expect(plan.entryOrderType).toBe("Limit");
    expect(plan.limitPrice).toBe("190.00");
    expect(plan.entryPriceRef).toBe("190.00");
    expect(plan.stopMarketPrice).toBe("180.00");
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a server-emitted stop-only OCO prefill produces the exit-plan ticket with no TP row", () => {
    // The draft builder now emits OCO + entryOrderType directly for stop-only
    // drafts; the plan must pass that through unchanged.
    const plan = resolveSignalPrefillPlan({
      entry: 190,
      stopLoss: 185,
      orderType: "OCO",
      entryOrderType: "Market",
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.entryOrderType).toBe("Market");
    expect(plan.stopMarketPrice).toBe("185.00");
    expect(plan.takeProfits).toBeUndefined();
  });

  test("a no-stop Market draft is NOT upgraded to OCO (plain ticket preserved)", () => {
    const plan = resolveSignalPrefillPlan({ entry: 190, orderType: "Market" });
    expect(plan.orderType).toBe("Market");
    expect(plan.entryOrderType).toBeUndefined();
  });

  test("an explicit order type wins over the stop+target OCO default", () => {
    // The server never emits this combo, but the precedence must be explicit:
    // an order type the user asked for is honored.
    const plan = resolveSignalPrefillPlan({
      stopLoss: 95,
      takeProfit: 110,
      orderType: "Market",
    });
    expect(plan.orderType).toBe("Market");
  });

  test("a limit bracket keeps its Limit entry on the OCO ticket with the limit price", () => {
    // "limit buy AAPL at 180 with stop 170 target 200": the ticket collapses
    // to OCO, but the entry leg must stay a Limit resting at 180, not the
    // form's Market entry default.
    const plan = resolveSignalPrefillPlan({
      entry: 180,
      stopLoss: 170,
      takeProfit: 200,
      orderType: "OCO",
      entryOrderType: "Limit",
      limitPrice: 180,
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.entryOrderType).toBe("Limit");
    expect(plan.limitPrice).toBe("180.00");
    expect(plan.entryPriceRef).toBe("180.00");
    expect(plan.stopMarketPrice).toBe("170.00");
    expect(plan.takeProfits).toEqual([{ price: "200.00", quantity: "1" }]);
  });

  test("a Limit-entry OCO with no entry price seeds entryPriceRef from the limit price", () => {
    const plan = resolveSignalPrefillPlan({
      stopLoss: 170,
      takeProfit: 200,
      orderType: "OCO",
      entryOrderType: "Limit",
      limitPrice: 180,
    });
    expect(plan.entryOrderType).toBe("Limit");
    expect(plan.limitPrice).toBe("180.00");
    expect(plan.entryPriceRef).toBe("180.00");
  });

  test("a market bracket pins the OCO entry leg to Market", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 100,
      stopLoss: 95,
      takeProfit: 110,
      orderType: "OCO",
      entryOrderType: "Market",
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.entryOrderType).toBe("Market");
  });

  test("entryOrderType is ignored when the resolved ticket is not OCO", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 150,
      orderType: "Limit",
      entryOrderType: "Limit",
      limitPrice: 150,
    });
    expect(plan.orderType).toBe("Limit");
    expect(plan.entryOrderType).toBeUndefined();
  });

  test("a short draft yields an opening-short ticket (SellShort + direction short)", () => {
    // "short AAPL": the ticket must open a short, not read as closing a long.
    const plan = resolveSignalPrefillPlan({
      orderType: "Market",
      direction: "short",
    });
    expect(plan.action).toBe("SellShort");
    expect(plan.direction).toBe("short");
  });

  test("a short bracket draft combines OCO with the short-opening action", () => {
    const plan = resolveSignalPrefillPlan({
      entry: 100,
      stopLoss: 105,
      takeProfit: 90,
      orderType: "OCO",
      direction: "short",
    });
    expect(plan.orderType).toBe("OCO");
    expect(plan.action).toBe("SellShort");
    expect(plan.direction).toBe("short");
    expect(plan.takeProfits).toEqual([{ price: "90.00", quantity: "1" }]);
  });

  test("an explicit long direction pins direction without overriding the action", () => {
    const plan = resolveSignalPrefillPlan({
      orderType: "Market",
      direction: "long",
    });
    expect(plan.direction).toBe("long");
    expect(plan.action).toBeUndefined();
  });

  test("no direction leaves action and direction untouched (plain buy/sell behavior)", () => {
    const plan = resolveSignalPrefillPlan({ orderType: "Market" });
    expect(plan.action).toBeUndefined();
    expect(plan.direction).toBeUndefined();
  });

  test("an explicit day time-in-force is applied to the plan", () => {
    // "buy 100 AAPL as a day order": the TIF must reach the form instead of
    // silently defaulting to GTC.
    const plan = resolveSignalPrefillPlan({
      orderType: "Market",
      timeInForce: "day",
    });
    expect(plan.timeInForce).toBe("day");
  });

  test("an explicit gtc time-in-force is applied to the plan", () => {
    const plan = resolveSignalPrefillPlan({
      orderType: "Limit",
      limitPrice: 150,
      timeInForce: "gtc",
    });
    expect(plan.timeInForce).toBe("gtc");
  });

  test("an absent time-in-force leaves the plan's TIF untouched (form default survives)", () => {
    const plan = resolveSignalPrefillPlan({ orderType: "Market" });
    expect(plan.timeInForce).toBeUndefined();
  });

  test("an empty prefill produces an empty plan (form defaults survive)", () => {
    expect(resolveSignalPrefillPlan({})).toEqual({});
  });

  test("non-finite numbers are ignored", () => {
    const plan = resolveSignalPrefillPlan({
      entry: Number.NaN,
      stopLoss: Number.POSITIVE_INFINITY,
      takeProfit: Number.NaN,
    });
    expect(plan).toEqual({});
  });
});
