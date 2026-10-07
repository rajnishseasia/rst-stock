import { describe, expect, test } from "bun:test";
import {
  getCopyTradeQuoteReadiness,
  COPY_TRADE_QUOTE_STALE_AFTER_MS,
} from "./copy-trade-quote-state";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function assessCopyQuoteFreshness(args: Parameters<typeof getCopyTradeQuoteReadiness>[0]) {
  const state = getCopyTradeQuoteReadiness(args);
  return { usable: !state.copyBlocked, reason: state.copyBlockedReason };
}

describe("copy-trade quote freshness", () => {
  test("reuses the comparable 90-second quote freshness window", () => {
    expect(COPY_TRADE_QUOTE_STALE_AFTER_MS).toBe(90_000);
  });

  test.each([
    ["stock", true],
    ["perp", true],
    ["option", true],
  ])("keeps a %s quote usable during a healthy background refetch", (_venue, expected) => {
    expect(
      assessCopyQuoteFreshness({
        hasQuote: true,
        updatedAt: NOW - 30_000,
        now: NOW,
        isFetching: true,
        hasError: false,
      }).usable,
    ).toBe(expected);
  });

  test("treats the exact age boundary as fresh, matching the shared policy", () => {
    expect(
      assessCopyQuoteFreshness({
        hasQuote: true,
        updatedAt: NOW - COPY_TRADE_QUOTE_STALE_AFTER_MS,
        now: NOW,
      }),
    ).toEqual({ usable: true, reason: null });
  });

  test("disables a quote past the age boundary with an actionable reason", () => {
    expect(
      assessCopyQuoteFreshness({
        hasQuote: true,
        updatedAt: NOW - COPY_TRADE_QUOTE_STALE_AFTER_MS - 1,
        now: NOW,
      }),
    ).toEqual({
      usable: false,
      reason: "Current quote is stale. Refresh before copying.",
    });
  });

  test("fails closed when the timestamp is missing, even when cached data exists", () => {
    expect(assessCopyQuoteFreshness({ hasQuote: true, now: NOW })).toEqual({
      usable: false,
      reason: "Current quote timestamp is unavailable. Refresh before copying.",
    });
  });

  test("fails closed when the current refresh errors over retained data", () => {
    expect(
      assessCopyQuoteFreshness({
        hasQuote: true,
        updatedAt: NOW - 1_000,
        now: NOW,
        hasError: true,
      }),
    ).toEqual({
      usable: false,
      reason: "Current quote refresh failed. Refresh before copying.",
    });
  });

  test("reports a missing row quote separately from a failed query", () => {
    expect(
      assessCopyQuoteFreshness({
        hasQuote: false,
        updatedAt: NOW,
        now: NOW,
      }),
    ).toEqual({ usable: false, reason: "Current quote is unavailable. Refresh before copying." });
  });

  test("recovers as soon as a fresh successful quote replaces the failed state", () => {
    const failed = assessCopyQuoteFreshness({
      hasQuote: true,
      updatedAt: NOW - 1_000,
      now: NOW,
      hasError: true,
    });
    const recovered = assessCopyQuoteFreshness({
      hasQuote: true,
      updatedAt: NOW,
      now: NOW,
      hasError: false,
    });

    expect(failed.usable).toBe(false);
    expect(recovered).toEqual({ usable: true, reason: null });
  });
});
