import { describe, expect, test } from "bun:test";
import {
  buildPerpTicketReset,
  buildStockTicketReset,
  consumeManualCopyPrefill,
  copyPrefillAccountMatches,
  createManualCopyPrefill,
  nextManualCopyNonce,
  resolveManualCopyLeverage,
  resolvePerpManualCopySourceId,
  resolveStockManualCopySourceId,
  type StockManualCopyPrefill,
} from "./manual-copy-prefill";

const stockCopy: StockManualCopyPrefill = {
  symbol: "aapl",
  side: "buy",
  qty: 1,
  copySourceItemId: "user:source-1",
  accountId: "paper-1",
  accountType: "PAPER",
  assetType: "EQUITY",
};

describe("manual copy prefill events", () => {
  test("same-value copies get distinct events and reset to the same clean ticket", () => {
    const first = createManualCopyPrefill(1, stockCopy);
    const second = createManualCopyPrefill(2, stockCopy);
    const resetInput = {
      currentMaxRisk: "250",
      trailingEnabled: true,
      trailingPercent: "5",
      skipPresetTp: false,
    };

    expect(first).toEqual({ nonce: 1, value: stockCopy, consumed: false });
    expect(second.nonce).not.toBe(first.nonce);
    expect(buildStockTicketReset({ copy: first.value, ...resetInput })).toEqual(
      buildStockTicketReset({ copy: second.value, ...resetInput }),
    );
    expect(
      buildStockTicketReset({ copy: second.value, ...resetInput }),
    ).toMatchObject({
      symbol: "AAPL",
      action: "Buy",
      quantity: "1",
      orderType: "OCO",
      entryOrderType: "Market",
      stopMarketPrice: "",
      limitPrice: "",
      takeProfits: [],
      trailingQty: "",
    });
  });

  test("a later copy replaces the edited ticket even when the symbol changes", () => {
    const firstReset = buildStockTicketReset({
      copy: { ...stockCopy, qty: 12 },
      currentMaxRisk: "250",
      trailingEnabled: true,
      trailingPercent: "5",
      skipPresetTp: false,
    });
    const editedTicket = {
      ...firstReset,
      action: "Sell",
      quantity: "99",
      orderType: "StopLimit",
      limitPrice: "999",
      stopMarketPrice: "900",
      trailingQty: "50",
    };
    expect(editedTicket.action).toBe("Sell");

    const nextReset = buildStockTicketReset({
      copy: { ...stockCopy, symbol: "msft", qty: 3 },
      currentMaxRisk: editedTicket.maxRisk,
      trailingEnabled: true,
      trailingPercent: "5",
      skipPresetTp: false,
    });
    expect(nextReset).toMatchObject({
      symbol: "MSFT",
      action: "Buy",
      quantity: "3",
      orderType: "OCO",
      limitPrice: "",
      stopMarketPrice: "",
      trailingQty: "",
    });
  });

  test("consumption survives a remount and cannot consume a newer event", () => {
    const event = createManualCopyPrefill(4, stockCopy);
    const consumed = consumeManualCopyPrefill(event, 4);
    expect(consumed?.consumed).toBe(true);
    expect(consumeManualCopyPrefill(consumed, 4)).toBe(consumed);

    const newer = createManualCopyPrefill(5, stockCopy);
    expect(consumeManualCopyPrefill(consumed, newer.nonce)).toBe(consumed);
    expect(nextManualCopyNonce(4)).toBe(5);
  });

  test("a paper copy is invalidated when the selected account changes to live", () => {
    const event = createManualCopyPrefill(1, stockCopy);
    expect(copyPrefillAccountMatches(event, "paper-1")).toBe(true);
    expect(copyPrefillAccountMatches(event, "paper-1", "LIVE")).toBe(false);
    expect(copyPrefillAccountMatches(event, "live-1", "LIVE")).toBe(false);
  });
});

describe("manual copy ticket resets", () => {
  test("clears old stock order and exit fields while preserving the copied quantity", () => {
    const reset = buildStockTicketReset({
      copy: { ...stockCopy, qty: 7 },
      currentMaxRisk: "100",
      trailingEnabled: true,
      trailingPercent: "5",
      skipPresetTp: false,
    });

    expect(reset.quantity).toBe("7");
    expect(reset.orderType).toBe("OCO");
    expect(reset.entryOrderType).toBe("Market");
    expect(reset.stopMarketPrice).toBe("");
    expect(reset.priceTrigger).toBe("");
    expect(reset.limitPrice).toBe("");
    expect(reset.entryPriceRef).toBe("");
    expect(reset.takeProfits).toEqual([]);
    expect(reset.trailingQty).toBe("");
  });

  test("resets an option copy to its contract and supported action", () => {
    const reset = buildStockTicketReset({
      copy: {
        ...stockCopy,
        assetType: "OPTION",
        optionExpiration: "260918",
        optionStrike: 150,
        optionType: "PUT",
        tradeAction: "SellToClose",
        qty: 20,
      },
      currentMaxRisk: "100",
      trailingEnabled: true,
      trailingPercent: "5",
      skipPresetTp: false,
    });

    expect(reset).toMatchObject({
      assetType: "OPTION",
      orderType: "Market",
      timeInForce: "day",
      action: "SellToClose",
      direction: "long",
      quantity: "10",
      optionsDateYear: "26",
      optionsDateMonth: "09",
      optionsDateDay: "18",
      optionsStrike: "150",
      optionType: "put",
    });
  });

  test("clears perp size and incompatible order flags and defaults absent leverage conservatively", () => {
    expect(
      buildPerpTicketReset({
        isLong: false,
        marginMode: "cross",
        leverage: undefined,
        maxLeverage: 20,
      }),
    ).toEqual({
      isLong: false,
      marginMode: "cross",
      orderType: "Market",
      sizeCoin: "",
      limitPrice: "",
      triggerPx: "",
      reduceOnly: false,
      postOnly: false,
      leverage: 2,
    });
    expect(resolveManualCopyLeverage(50)).toBe(50);
    expect(resolveManualCopyLeverage(0)).toBe(2);
  });
});

describe("manual copy source clearing", () => {
  test("keeps an equity source on the unchanged opening long", () => {
    expect(
      resolveStockManualCopySourceId({
        copySourceItemId: "x_signal:source-1",
        sourceSymbol: "aapl",
        sourceSide: "buy",
        orderSymbol: "AAPL",
        assetType: "EQUITY",
        action: "Buy",
        direction: "long",
      }),
    ).toBe("x_signal:source-1");
  });

  test("clears an equity source when symbol, side, direction, or asset changes", () => {
    const base = {
      copySourceItemId: "x_signal:source-1",
      sourceSymbol: "AAPL",
      sourceSide: "buy" as const,
      orderSymbol: "AAPL",
      assetType: "EQUITY" as const,
      action: "Buy",
      direction: "long" as const,
    };

    expect(resolveStockManualCopySourceId({ ...base, orderSymbol: "MSFT" })).toBeUndefined();
    expect(resolveStockManualCopySourceId({ ...base, action: "Sell" })).toBeUndefined();
    expect(resolveStockManualCopySourceId({ ...base, direction: "short" })).toBeUndefined();
    expect(resolveStockManualCopySourceId({ ...base, assetType: "OPTION" })).toBeUndefined();
    expect(
      resolveStockManualCopySourceId({ ...base, sourceSide: "sell" }),
    ).toBeUndefined();
  });

  test("keeps a perp source only for the same opening coin and direction", () => {
    const base = {
      copySourceItemId: "user:source-2",
      sourceCoin: "xyz:GOOGL",
      sourceSide: "short" as const,
      orderCoin: "xyz:GOOGL",
      isLong: false,
      reduceOnly: false,
    };

    expect(resolvePerpManualCopySourceId(base)).toBe("user:source-2");
    expect(resolvePerpManualCopySourceId({ ...base, orderCoin: "GOOGL" })).toBeUndefined();
    expect(resolvePerpManualCopySourceId({ ...base, isLong: true })).toBeUndefined();
    expect(resolvePerpManualCopySourceId({ ...base, reduceOnly: true })).toBeUndefined();
  });
});
