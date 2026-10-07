import { describe, it, expect } from "bun:test";
import { schema } from "@trade-bot/db";
import {
  advanceWatermark,
  buildExternalOrderRow,
  clampWatermarkToOpenOrders,
  classifyAlpacaOrder,
  closeReasonsByBrokerId,
  externalCloseReason,
  externalFillClientOrderId,
  flattenAlpacaLegs,
  hasOpenLeg,
  isTerminalAlpacaStatus,
  mapAlpacaAssetType,
  mapAlpacaOrderType,
  mapAlpacaSide,
  mapAlpacaStatusForExternalFill,
  ExternalFillPoller,
  type ExternalAlpacaOrder,
} from "../external-fill-sync";

/**
 * Pure-helper tests for the ExternalFillPoller. The wiring layer
 * (poll cycle, DB writes, backoff) is not yet covered by automated tests,
 * except for `ingestPage`, which is exercised directly against a minimal
 * fake db below because the nested-legs bug lives entirely in how that
 * method walks a page, not in any pure helper.
 */

const baseAlpaca = {
  id: "alp-1",
  client_order_id: "cli-1",
  symbol: "AAPL",
  asset_class: "us_equity",
  side: "buy",
  type: "limit",
  order_type: "limit",
  status: "filled",
  qty: "10",
  filled_qty: "10",
  filled_avg_price: "190.25",
  filled_at: "2026-07-25T15:30:00Z",
  submitted_at: "2026-07-25T15:29:55Z",
  limit_price: "190.5",
  stop_price: null,
  legs: null,
  order_class: "simple",
  position_intent: "buy_to_open",
} as ExternalAlpacaOrder;

describe("classifyAlpacaOrder", () => {
  it("skips known orders matched by brokerOrderId", () => {
    const result = classifyAlpacaOrder({
      alpaca: baseAlpaca,
      knownBrokerOrderIds: new Set(["alp-1"]),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("known");
  });

  it("skips known orders matched by clientOrderId", () => {
    const result = classifyAlpacaOrder({
      alpaca: baseAlpaca,
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(["cli-1"]),
    });
    expect(result.kind).toBe("known");
  });

  it("classifies unknown filled orders as external", () => {
    const result = classifyAlpacaOrder({
      alpaca: baseAlpaca,
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("external");
    if (result.kind === "external") expect(result.reason).toBe("filled");
  });

  it("skips a zero-filled FILLED order instead of treating requested qty as a fill", () => {
    const result = classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, status: "filled", qty: "7", filled_qty: "0" },
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    });
    expect(result).toEqual({ kind: "skip", reason: "status=filled", open: false });
  });

  it("defers partially-filled orders as still open (fill isn't final yet)", () => {
    const result = classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, status: "partially_filled" },
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.open).toBe(true);
  });

  it("ingests a terminal order that filled partially before it was canceled", () => {
    const result = classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, status: "canceled", qty: "500", filled_qty: "20" },
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("external");
    if (result.kind === "external") expect(result.reason).toBe("partial");
  });

  it("flags unknown live states as open so the cursor can be held back", () => {
    for (const status of ["new", "accepted", "pending_new", "pending_replace"] as const) {
      const result = classifyAlpacaOrder({
        alpaca: { ...baseAlpaca, status },
        knownBrokerOrderIds: new Set(),
        knownClientOrderIds: new Set(),
      });
      expect(result.kind).toBe("skip");
      if (result.kind === "skip") expect(result.open).toBe(true);
    }
  });

  it("skips terminal-without-fill states without holding the cursor", () => {
    for (const status of ["canceled", "expired", "rejected"] as const) {
      const result = classifyAlpacaOrder({
        alpaca: { ...baseAlpaca, status, filled_qty: "0" },
        knownBrokerOrderIds: new Set(),
        knownClientOrderIds: new Set(),
      });
      expect(result.kind).toBe("skip");
      if (result.kind === "skip") expect(result.open).toBe(false);
    }
  });

  it("treats a done_for_day partial fill as still open, not a final external partial: Alpaca resumes the order next trading day", () => {
    // Regression for the day-one-partial bug: 120 of 500 filled, day paused.
    // Must NOT classify as {external, "partial"} -- that would publish a
    // final 120-share mirror and make the broker id permanently "known",
    // losing the remaining 380 shares that fill on day two.
    const result = classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, status: "done_for_day", qty: "500", filled_qty: "120" },
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.open).toBe(true);
  });

  it("treats a done_for_day zero-fill order as open so the cursor is pinned back to it", () => {
    // Regression for the zero-fill bug: a resting GTC order that paused for
    // the day with no fill yet must pin the watermark like any other open
    // order, not fall through to {skip, open:false} and let the cursor
    // advance past it before it resumes next session.
    const result = classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, status: "done_for_day", filled_qty: "0" },
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.open).toBe(true);
  });

  it("treats a known order as known even while it is still open", () => {
    const result = classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, status: "partially_filled" },
      knownBrokerOrderIds: new Set(["alp-1"]),
      knownClientOrderIds: new Set(),
    });
    expect(result.kind).toBe("known");
  });
});

describe("external-fill order identity", () => {
  it("classifies only a terminal, positive, priced fill as external", () => {
    expect(classifyAlpacaOrder({
      alpaca: { ...baseAlpaca, filled_avg_price: "0" },
      knownBrokerOrderIds: new Set(),
      knownClientOrderIds: new Set(),
    })).toEqual({ kind: "skip", reason: "invalid execution price", open: false });
  });

  it("rejects malformed numeric strings before external classification", () => {
    for (const filled_avg_price of ["100junk", " ", "0x10", "Infinity", "NaN", "0", "-1", "10000000000000000"]) {
      expect(classifyAlpacaOrder({
        alpaca: { ...baseAlpaca, filled_avg_price },
        knownBrokerOrderIds: new Set(),
        knownClientOrderIds: new Set(),
      })).toEqual({ kind: "skip", reason: "invalid execution price", open: false });
    }

    for (const filled_qty of ["1junk", " ", "0x10", "Infinity", "NaN", "0", "-1", "10000000000000000"]) {
      expect(classifyAlpacaOrder({
        alpaca: { ...baseAlpaca, filled_qty },
        knownBrokerOrderIds: new Set(),
        knownClientOrderIds: new Set(),
      })).toEqual({ kind: "skip", reason: "status=filled", open: false });
    }
  });
});

describe("isTerminalAlpacaStatus", () => {
  it("recognizes the finished states", () => {
    for (const status of ["filled", "canceled", "expired", "replaced", "rejected"]) {
      expect(isTerminalAlpacaStatus(status)).toBe(true);
    }
  });

  it("treats live states (including partially_filled) as not terminal", () => {
    for (const status of ["new", "accepted", "partially_filled", "pending_cancel", null]) {
      expect(isTerminalAlpacaStatus(status)).toBe(false);
    }
  });

  it("treats done_for_day as not terminal: Alpaca resumes the order next trading day, filled_qty is not final", () => {
    expect(isTerminalAlpacaStatus("done_for_day")).toBe(false);
  });
});

describe("mapAlpacaStatusForExternalFill", () => {
  it("maps replaced to CANCELLED (not SUBMITTED) so OrderSyncPoller does not re-poll forever", () => {
    expect(mapAlpacaStatusForExternalFill("replaced")).toBe("CANCELLED");
  });

  it("maps done_for_day to SUBMITTED (delegating, not a terminal rewrite): the order is not done, it resumes next trading day", () => {
    expect(mapAlpacaStatusForExternalFill("done_for_day")).toBe("SUBMITTED");
  });

  it("delegates to mapAlpacaStatus for all other statuses", () => {
    expect(mapAlpacaStatusForExternalFill("filled")).toBe("FILLED");
    expect(mapAlpacaStatusForExternalFill("canceled")).toBe("CANCELLED");
    expect(mapAlpacaStatusForExternalFill("rejected")).toBe("REJECTED");
    expect(mapAlpacaStatusForExternalFill("expired")).toBe("EXPIRED");
  });
});

describe("mapping helpers", () => {
  it("maps Alpaca order types to the RST enum", () => {
    expect(mapAlpacaOrderType("market")).toBe("Market");
    expect(mapAlpacaOrderType("limit")).toBe("Limit");
    expect(mapAlpacaOrderType("stop")).toBe("StopMarket");
    expect(mapAlpacaOrderType("stop_limit")).toBe("StopLimit");
    expect(mapAlpacaOrderType("trailing_stop")).toBe("StopMarket");
    expect(mapAlpacaOrderType(null)).toBe("Market");
  });

  it("maps side to the equity trade action", () => {
    expect(mapAlpacaSide("buy")).toBe("Buy");
    expect(mapAlpacaSide("sell")).toBe("Sell");
    expect(mapAlpacaSide(null)).toBe("Buy");
  });

  it("maps asset_class to the RST enum", () => {
    expect(mapAlpacaAssetType("us_equity")).toBe("EQUITY");
    expect(mapAlpacaAssetType("us_option")).toBe("OPTION");
    expect(mapAlpacaAssetType("crypto")).toBe("EQUITY");
    expect(mapAlpacaAssetType(null)).toBe("EQUITY");
  });
});

describe("externalFillClientOrderId", () => {
  it("is deterministic for the same (credentialId, orderId)", () => {
    const a = externalFillClientOrderId(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "1111-2222-3333-4444",
    );
    const b = externalFillClientOrderId(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "1111-2222-3333-4444",
    );
    expect(a).toBe(b);
  });

  it("stays under Alpaca's 48-char client_order_id limit", () => {
    // Both UUIDs are 36 chars; joined naively they'd be well over 48.
    const id = externalFillClientOrderId(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "12345678-9abc-def0-1234-56789abcdef0",
    );
    expect(id.startsWith("extfill:")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(48);
  });

  it("differs for different orders under the same credential", () => {
    const cred = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(externalFillClientOrderId(cred, "order-1")).not.toBe(
      externalFillClientOrderId(cred, "order-2"),
    );
  });

  it("does not collide when credential and order identities share old prefixes", () => {
    const credentialPrefix = "a".repeat(12);
    const orderPrefix = "b".repeat(24);
    const first = externalFillClientOrderId(
      `${credentialPrefix}-credential-a`,
      `${orderPrefix}-order-a`,
    );
    const second = externalFillClientOrderId(
      `${credentialPrefix}-credential-b`,
      `${orderPrefix}-order-b`,
    );

    expect(first).not.toBe(second);
  });
});

describe("buildExternalOrderRow", () => {
  const now = new Date("2026-07-26T00:00:00Z");
  const row = buildExternalOrderRow({
    alpaca: baseAlpaca,
    userId: "user-1",
    credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    credentialAccountId: "acct-1",
    now,
  })!;

  it("populates the deterministic clientOrderId and broker ids", () => {
    expect(row.clientOrderId).toBe(
      externalFillClientOrderId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "alp-1"),
    );
    expect(row.brokerOrderId).toBe("alp-1");
    expect(row.brokerClientOrderId).toBe("cli-1");
    expect(row.brokerCredentialId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(row.brokerAccountId).toBe("acct-1");
  });

  it("marks externalOrigin true and stamps the venue", () => {
    expect(row.externalOrigin).toBe(true);
    expect(row.venue).toBe("alpaca");
  });

  it("maps status/type/side and preserves fill quantities/prices", () => {
    expect(row.status).toBe("FILLED");
    expect(row.orderType).toBe("Limit");
    expect(row.tradeAction).toBe("Buy");
    expect(row.quantity).toBe(10);
    expect(row.executedQuantity).toBe(10);
    expect(row.executedPrice).toBe("190.25");
    expect(row.executedAt).toEqual(new Date("2026-07-25T15:30:00Z"));
  });

  it("derives equity long and short actions from authoritative position intent", () => {
    const cases = [
      { side: "buy", position_intent: "buy_to_open", tradeAction: "Buy", direction: "long" },
      { side: "sell", position_intent: "sell_to_close", tradeAction: "Sell", direction: "long" },
      { side: "sell", position_intent: "sell_to_open", tradeAction: "SellShort", direction: "short" },
      { side: "buy", position_intent: "buy_to_close", tradeAction: "BuyToCover", direction: "short" },
    ] as const;

    for (const testCase of cases) {
      const mapped = buildExternalOrderRow({
        alpaca: {
          ...baseAlpaca,
          asset_class: "us_equity",
          side: testCase.side,
          position_intent: testCase.position_intent,
        },
        userId: "user-1",
        credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        credentialAccountId: "acct-1",
        now,
      });
      expect(mapped).toMatchObject({
        tradeAction: testCase.tradeAction,
        direction: testCase.direction,
      });
    }
  });

  it("derives option open and close actions from authoritative position intent", () => {
    const cases = [
      { side: "buy", position_intent: "buy_to_open", tradeAction: "BuyToOpen", direction: "long" },
      { side: "sell", position_intent: "sell_to_close", tradeAction: "SellToClose", direction: "long" },
      { side: "sell", position_intent: "sell_to_open", tradeAction: "SellToOpen", direction: "short" },
      { side: "buy", position_intent: "buy_to_close", tradeAction: "BuyToClose", direction: "short" },
    ] as const;

    for (const testCase of cases) {
      const mapped = buildExternalOrderRow({
        alpaca: {
          ...baseAlpaca,
          asset_class: "us_option",
          symbol: "AAPL260719C00250000",
          side: testCase.side,
          position_intent: testCase.position_intent,
        },
        userId: "user-1",
        credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        credentialAccountId: "acct-1",
        now,
      });
      expect(mapped).toMatchObject({
        tradeAction: testCase.tradeAction,
        direction: testCase.direction,
      });
    }
  });

  it("refuses an ambiguous simple fill without position intent", () => {
    const ambiguous = buildExternalOrderRow({
      alpaca: {
        ...baseAlpaca,
        side: "sell",
        order_class: "simple",
        position_intent: null,
      },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: "acct-1",
      now,
    });
    expect(ambiguous).toBeNull();
  });

  it("rounds a fractional fill up to a usable share count", () => {
    const fractional = buildExternalOrderRow({
      alpaca: { ...baseAlpaca, qty: null as unknown as string, filled_qty: "0.5" },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    })!;
    expect(fractional.quantity).toBe(1);
    expect(fractional.executedQuantity).toBe(0.5);
  });

  it("sizes quantity off the executed fill, not the requested qty", () => {
    // Canceled after 20 of 500 shares filled: mirroring 500 would be wrong.
    const partial = buildExternalOrderRow({
      alpaca: { ...baseAlpaca, status: "canceled", qty: "500", filled_qty: "20" },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    })!;
    expect(partial.quantity).toBe(20);
    expect(partial.executedQuantity).toBe(20);
  });

  it("rejects an unparseable fill quantity instead of falling back to requested qty", () => {
    const noFill = buildExternalOrderRow({
      alpaca: { ...baseAlpaca, qty: "7", filled_qty: null as unknown as string },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    });
    expect(noFill).toBeNull();
  });

  it("rejects a zero-filled FILLED row in the row builder too", () => {
    const noFill = buildExternalOrderRow({
      alpaca: { ...baseAlpaca, qty: "7", filled_qty: "0" },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    });
    expect(noFill).toBeNull();
  });

  it("rejects malformed numeric strings in the row builder", () => {
    for (const filled_avg_price of ["100junk", " ", "0x10", "Infinity", "NaN", "0", "-1"]) {
      expect(buildExternalOrderRow({
        alpaca: { ...baseAlpaca, filled_avg_price },
        userId: "user-1",
        credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        credentialAccountId: null,
        now,
      })).toBeNull();
    }

    for (const filled_qty of ["1junk", " ", "0x10", "Infinity", "NaN", "0", "-1"]) {
      expect(buildExternalOrderRow({
        alpaca: { ...baseAlpaca, filled_qty },
        userId: "user-1",
        credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        credentialAccountId: null,
        now,
      })).toBeNull();
    }
  });

  it("normalizes canonical Alpaca option metadata without guessing malformed contracts", () => {
    const canonical = buildExternalOrderRow({
      alpaca: {
        ...baseAlpaca,
        symbol: "AAPL260719C00250000",
        asset_class: "us_option",
        position_intent: "buy_to_open",
      },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: "acct-1",
      now,
    });
    expect(canonical).toMatchObject({
      symbol: "AAPL",
      optionExpiration: "260719",
      optionStrike: "250",
      optionType: "CALL",
    });

    const malformed = buildExternalOrderRow({
      alpaca: {
        ...baseAlpaca,
        symbol: "AAPL260732C00250000",
        asset_class: "us_option",
        position_intent: "buy_to_open",
      },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: "acct-1",
      now,
    });
    expect(malformed).toBeNull();
  });

  it("rejects missing, non-finite, and non-positive execution prices", () => {
    for (const filled_avg_price of [null, "NaN", "Infinity", "-1", "0", "10000000000000000"] as const) {
      expect(buildExternalOrderRow({
        alpaca: { ...baseAlpaca, filled_avg_price },
        userId: "user-1",
        credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        credentialAccountId: null,
        now,
      })).toBeNull();
    }

    expect(buildExternalOrderRow({
      alpaca: { ...baseAlpaca, filled_qty: "10000000000000000" },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    })).toBeNull();
  });

  it("maps replaced status to CANCELLED (not SUBMITTED) for inserted external-fill rows", () => {
    const replaced = buildExternalOrderRow({
      alpaca: { ...baseAlpaca, status: "replaced", filled_qty: "5" },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    })!;
    expect(replaced.status).toBe("CANCELLED");
  });

  it("maps done_for_day status to SUBMITTED, not EXPIRED: the order is not actually finished", () => {
    const doneForDay = buildExternalOrderRow({
      alpaca: { ...baseAlpaca, status: "done_for_day", filled_qty: "5" },
      userId: "user-1",
      credentialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      credentialAccountId: null,
      now,
    })!;
    expect(doneForDay.status).toBe("SUBMITTED");
  });
});

describe("advanceWatermark", () => {
  it("returns the max submitted_at across the page", () => {
    const page = [
      { submitted_at: "2026-07-25T15:00:00Z" },
      { submitted_at: "2026-07-25T15:30:00Z" },
      { submitted_at: "2026-07-25T15:15:00Z" },
    ];
    const next = advanceWatermark(null, page);
    expect(next).toEqual(new Date("2026-07-25T15:30:00Z"));
  });

  it("never rewinds a watermark", () => {
    const current = new Date("2026-07-26T00:00:00Z");
    const page = [{ submitted_at: "2026-07-25T15:00:00Z" }];
    const next = advanceWatermark(current, page);
    expect(next).toEqual(current);
  });

  it("keeps the current watermark when the page has no parseable timestamps", () => {
    const current = new Date("2026-07-26T00:00:00Z");
    const page = [
      { submitted_at: "" },
      { submitted_at: "not-a-date" },
    ] as Array<{ submitted_at: string }>;
    const next = advanceWatermark(current, page);
    expect(next).toEqual(current);
  });
});

describe("clampWatermarkToOpenOrders", () => {
  it("holds the watermark at an older still-open order", () => {
    const watermark = new Date("2026-07-26T12:00:00Z");
    const open = new Date("2026-07-20T09:00:00Z");
    expect(clampWatermarkToOpenOrders(watermark, open)).toEqual(open);
  });

  it("leaves the watermark alone when every open order is newer", () => {
    const watermark = new Date("2026-07-26T12:00:00Z");
    const open = new Date("2026-07-26T13:00:00Z");
    expect(clampWatermarkToOpenOrders(watermark, open)).toEqual(watermark);
  });

  it("is a no-op when no open orders were seen", () => {
    const watermark = new Date("2026-07-26T12:00:00Z");
    expect(clampWatermarkToOpenOrders(watermark, null)).toEqual(watermark);
  });

  it("uses the open order when there is no watermark yet", () => {
    const open = new Date("2026-07-20T09:00:00Z");
    expect(clampWatermarkToOpenOrders(null, open)).toEqual(open);
  });
});

/**
 * alpaca-10: GetOrders is called with `nested: true`, which
 * docs.alpaca.markets documents as rolling multi-leg (bracket/OCO/OTO) child
 * orders up under the parent's `legs` field instead of returning them as
 * their own list entries. A bracket's take-profit or stop-loss fill is a
 * leg, so a poller that only iterates the top-level page never sees it.
 */
const filledTakeProfitLeg: ExternalAlpacaOrder = {
  id: "leg-tp-1",
  client_order_id: "cli-tp-1",
  symbol: "MSFT",
  asset_class: "us_equity",
  side: "sell",
  type: "limit",
  order_type: "limit",
  status: "filled",
  qty: "100",
  filled_qty: "100",
  filled_avg_price: "410.00",
  filled_at: "2026-07-28T14:00:00Z",
  submitted_at: "2026-07-20T13:00:00Z",
  limit_price: "410.00",
  stop_price: null,
  legs: null,
  // A bracket's take-profit leg closes the long the entry opened. Alpaca
  // returns `position_intent` on every order, and `resolveExternalOrderIntent`
  // refuses a row without one, so the fixture carries it like the real reply.
  order_class: "bracket",
  position_intent: "sell_to_close",
};

const openTakeProfitLeg: ExternalAlpacaOrder = {
  ...filledTakeProfitLeg,
  status: "new",
  filled_qty: "0",
  filled_avg_price: null,
  filled_at: null,
};

function bracketEntry(leg: ExternalAlpacaOrder): ExternalAlpacaOrder {
  return {
    id: "entry-1",
    client_order_id: "cli-entry-1",
    symbol: "MSFT",
    asset_class: "us_equity",
    side: "buy",
    type: "market",
    order_type: "market",
    status: "filled",
    qty: "100",
    filled_qty: "100",
    filled_avg_price: "400.00",
    filled_at: "2026-07-20T13:00:05Z",
    submitted_at: "2026-07-20T13:00:00Z",
    limit_price: null,
    stop_price: null,
    legs: [leg],
    order_class: "bracket",
    position_intent: "buy_to_open",
  };
}

describe("flattenAlpacaLegs", () => {
  it("returns a lone simple order unchanged", () => {
    expect(flattenAlpacaLegs([baseAlpaca])).toEqual([baseAlpaca]);
  });

  it("pulls a nested leg out alongside its parent", () => {
    const entry = bracketEntry(filledTakeProfitLeg);
    const flat = flattenAlpacaLegs([entry]);
    expect(flat).toHaveLength(2);
    expect(flat.map((o) => o.id)).toEqual(["entry-1", "leg-tp-1"]);
  });

  it("is a no-op when legs is null", () => {
    expect(flattenAlpacaLegs([{ ...baseAlpaca, legs: null }])).toEqual([baseAlpaca]);
  });
});

describe("hasOpenLeg", () => {
  it("is false when every leg is terminal", () => {
    expect(hasOpenLeg(bracketEntry(filledTakeProfitLeg))).toBe(false);
  });

  it("is true when a leg is still live at the broker", () => {
    expect(hasOpenLeg(bracketEntry(openTakeProfitLeg))).toBe(true);
  });

  it("is false for an order with no legs", () => {
    expect(hasOpenLeg(baseAlpaca)).toBe(false);
  });
});

/**
 * Minimal fake db satisfying exactly the drizzle calls `ingestPage` makes:
 * a known-order lookup (`db.select().from().where()`) and a transactional
 * insert of an order row plus an optional social-trade row. Modeled on the
 * `durableDb` helper in order-sync.test.ts.
 */
function fakeDb(knownRows: Array<Record<string, unknown>> = []) {
  const insertedOrders: Array<Record<string, any>> = [];
  const insertedSocialTrades: Array<Record<string, any>> = [];
  const db = {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: async (_predicate: unknown) => knownRows,
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (table: unknown) => ({
          values: (value: Record<string, any>) => {
            if (table === schema.orders) {
              return {
                onConflictDoNothing: (_opts: unknown) => ({
                  returning: async () => {
                    const conflict = insertedOrders.some(
                      (o) => o.clientOrderId === value.clientOrderId,
                    );
                    if (conflict) return [];
                    const row = { id: `order-${insertedOrders.length + 1}`, ...value };
                    insertedOrders.push(row);
                    return [row];
                  },
                }),
              };
            }
            if (table === schema.socialTrades) {
              insertedSocialTrades.push(value);
              return Promise.resolve();
            }
            throw new Error("fakeDb: unexpected insert table");
          },
        }),
      };
      return fn(tx);
    },
  };
  return { db, insertedOrders, insertedSocialTrades };
}

const credential = {
  id: "cred-1",
  userId: "user-1",
  accountId: "acct-1",
} as unknown as typeof schema.userApiCredentials.$inferSelect;

describe("ingestPage descends into nested legs", () => {
  it("ingests a filled take-profit leg even though the bracket's entry order is already known", async () => {
    const { db, insertedOrders } = fakeDb([
      { brokerOrderId: "entry-1", clientOrderId: null, brokerClientOrderId: "cli-entry-1" },
    ]);
    const poller = new ExternalFillPoller(db as never);
    const result = await (poller as any).ingestPage({
      page: [bracketEntry(filledTakeProfitLeg)],
      credential,
      decrypted: {},
      publishSocialTrades: true,
    });

    // The entry is already known, so only the leg should be a new row.
    expect(insertedOrders).toHaveLength(1);
    expect(insertedOrders[0].brokerOrderId).toBe("leg-tp-1");
    expect(insertedOrders[0].quantity).toBe(100);
    expect(result.inserted).toHaveLength(1);
    expect(result.inserted[0].brokerOrderId).toBe("leg-tp-1");
  });

  it("pins the cursor to the entry's submitted_at when a leg is still open, even though the entry itself is known", async () => {
    const { db, insertedOrders } = fakeDb([
      { brokerOrderId: "entry-1", clientOrderId: null, brokerClientOrderId: "cli-entry-1" },
    ]);
    const poller = new ExternalFillPoller(db as never);
    const result = await (poller as any).ingestPage({
      page: [bracketEntry(openTakeProfitLeg)],
      credential,
      decrypted: {},
      publishSocialTrades: true,
    });

    expect(insertedOrders).toHaveLength(0);
    expect(result.inserted).toHaveLength(0);
    expect(result.oldestOpen).toEqual(new Date("2026-07-20T13:00:00Z"));
    expect(result.unknownOpenIds).toContain("entry-1");
  });

  it("still ingests a simple (non-bracket) unknown filled order as before", async () => {
    const { db, insertedOrders } = fakeDb([]);
    const poller = new ExternalFillPoller(db as never);
    const result = await (poller as any).ingestPage({
      page: [baseAlpaca],
      credential,
      decrypted: {},
      publishSocialTrades: true,
    });

    expect(insertedOrders).toHaveLength(1);
    expect(insertedOrders[0].brokerOrderId).toBe("alp-1");
    expect(result.inserted).toHaveLength(1);
  });
});

/**
 * A bracket stop is a CHILD order at the broker: it never gets an `orders` row,
 * so the row-driven OrderSyncPoller cannot see it fire. This poller is the only
 * thing that does, which makes the reason on its webhook the difference between
 * "you were stopped out" and a line that reads like a manual sale.
 */
describe("externalCloseReason", () => {
  const stopChild = {
    ...baseAlpaca,
    id: "leg-1",
    type: "stop",
    order_type: "stop",
    side: "sell",
    position_intent: "sell_to_close",
  } as ExternalAlpacaOrder;

  it("names a stop that closed a long", () => {
    expect(externalCloseReason(stopChild)).toBe("stop_loss");
  });

  it("names a stop that covered a short", () => {
    expect(
      externalCloseReason({
        ...stopChild,
        side: "buy",
        position_intent: "buy_to_close",
      } as ExternalAlpacaOrder),
    ).toBe("stop_loss");
  });

  it("covers stop-limit and trailing stops", () => {
    expect(externalCloseReason({ ...stopChild, type: "stop_limit" })).toBe("stop_loss");
    expect(externalCloseReason({ ...stopChild, type: "trailing_stop" })).toBe("stop_loss");
  });

  it("never calls a stop ENTRY a stop-out", () => {
    // Same order type, opposite meaning: a stop-buy on a breakout OPENS a
    // position. Announcing that as a stop-out is worse than saying nothing.
    expect(
      externalCloseReason({
        ...stopChild,
        side: "buy",
        position_intent: "buy_to_open",
      } as ExternalAlpacaOrder),
    ).toBeNull();
  });

  it("says nothing when the broker omits position intent", () => {
    expect(externalCloseReason({ ...stopChild, position_intent: null })).toBeNull();
  });

  it("is null for ordinary limit and market fills", () => {
    expect(externalCloseReason(baseAlpaca)).toBeNull();
    expect(externalCloseReason({ ...baseAlpaca, type: "market" })).toBeNull();
  });
});

describe("closeReasonsByBrokerId", () => {
  it("finds the stop nested inside a bracket parent", () => {
    // The stop lives in `legs`; a page walked without flattening finds nothing
    // to label, which is how the reason silently goes missing.
    const parent = {
      ...baseAlpaca,
      id: "parent-1",
      order_class: "bracket",
      legs: [
        {
          ...baseAlpaca,
          id: "leg-stop",
          type: "stop",
          order_type: "stop",
          side: "sell",
          position_intent: "sell_to_close",
          legs: null,
        },
      ],
    } as unknown as ExternalAlpacaOrder;

    const reasons = closeReasonsByBrokerId([parent]);
    expect(reasons.get("leg-stop")).toBe("stop_loss");
    expect(reasons.has("parent-1")).toBe(false);
  });

  it("is empty for a page with no stops", () => {
    expect(closeReasonsByBrokerId([baseAlpaca]).size).toBe(0);
  });
});
