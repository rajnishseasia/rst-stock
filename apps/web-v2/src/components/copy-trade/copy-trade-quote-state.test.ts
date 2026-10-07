import { describe, expect, test } from "bun:test";
import { getCopyTradeQuoteReadiness } from "./copy-trade-quote-state";

const NOW = Date.UTC(2026, 8, 5, 14, 0, 0);

describe("copy-trade quote readiness", () => {
  test.each([
    ["stock", "AAPL"],
    ["perp", "BTC"],
    ["option", "AAPL 2026-09-18 200 CALL"],
  ])("allows a fresh %s quote while a background refresh is healthy", (_kind, _contract) => {
    const state = getCopyTradeQuoteReadiness({
      hasQuote: true,
      updatedAt: NOW - 30_000,
      isFetching: true,
      now: NOW,
    });

    expect(state.copyBlocked).toBe(false);
    expect(state.freshness.tone).toBe("refreshing");
  });

  test("treats the established 90-second freshness boundary as fresh", () => {
    const state = getCopyTradeQuoteReadiness({
      hasQuote: true,
      updatedAt: NOW - 90_000,
      now: NOW,
    });

    expect(state.copyBlocked).toBe(false);
    expect(state.freshness.isStale).toBe(false);
  });

  test("blocks every quote kind when the timestamp is missing", () => {
    const state = getCopyTradeQuoteReadiness({
      hasQuote: true,
      updatedAt: undefined,
      now: NOW,
    });

    expect(state.copyBlocked).toBe(true);
    expect(state.copyBlockedReason).toContain("quote");
  });

  test("blocks a stale quote even while a refresh is still in flight", () => {
    const state = getCopyTradeQuoteReadiness({
      hasQuote: true,
      updatedAt: NOW - 90_001,
      isFetching: true,
      now: NOW,
    });

    expect(state.copyBlocked).toBe(true);
    expect(state.freshness.isStale).toBe(true);
    expect(state.copyBlockedReason).toContain("stale");
  });

  test("blocks retained data after the current quote refresh errors", () => {
    const state = getCopyTradeQuoteReadiness({
      hasQuote: true,
      updatedAt: NOW - 1_000,
      hasError: true,
      now: NOW,
    });

    expect(state.copyBlocked).toBe(true);
    expect(state.freshness.tone).toBe("error");
    expect(state.copyBlockedReason).toContain("failed");
  });

  test("recovers as soon as a successful fresh quote arrives", () => {
    const state = getCopyTradeQuoteReadiness({
      hasQuote: true,
      updatedAt: NOW,
      hasError: false,
      now: NOW,
    });

    expect(state.copyBlocked).toBe(false);
    expect(state.copyBlockedReason).toBeNull();
  });
});
