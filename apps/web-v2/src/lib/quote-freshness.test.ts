import { describe, expect, test } from "bun:test";
import { getQuoteFreshness } from "./quote-freshness";

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);

describe("quote freshness", () => {
  test("a quote that just arrived reads as live", () => {
    const state = getQuoteFreshness({ updatedAt: NOW - 2_000, now: NOW });

    expect(state.tone).toBe("live");
    expect(state.isStale).toBe(false);
    expect(state.label).toContain("Updated");
  });

  test("an old quote reads as stale rather than live", () => {
    const state = getQuoteFreshness({ updatedAt: NOW - 120_000, now: NOW });

    expect(state.tone).toBe("stale");
    expect(state.isStale).toBe(true);
    expect(state.label).toContain("Stale");
  });

  test("with no quote yet the surface never claims a fresh price", () => {
    // The shell must pass `undefined` when it holds no quote: a query's
    // dataUpdatedAt keeps ticking, so reporting it would paint "Updated just
    // now" over an empty price.
    const waiting = getQuoteFreshness({ updatedAt: undefined, now: NOW });
    expect(waiting.tone).toBe("idle");
    expect(waiting.label).toBe("Waiting for quote");

    const fetching = getQuoteFreshness({
      updatedAt: undefined,
      isFetching: true,
      now: NOW,
    });
    expect(fetching.tone).toBe("refreshing");
    expect(fetching.isStale).toBe(false);
  });

  test("a refresh in flight keeps the age of the last quote visible", () => {
    const state = getQuoteFreshness({
      updatedAt: NOW - 30_000,
      isFetching: true,
      now: NOW,
    });

    expect(state.tone).toBe("refreshing");
    expect(state.label).toContain("30s ago");
  });

  test("a failing feed reads as an error, not as a price", () => {
    const state = getQuoteFreshness({
      updatedAt: NOW - 1_000,
      hasError: true,
      now: NOW,
    });

    expect(state.tone).toBe("error");
    expect(state.isStale).toBe(true);
  });

  test("a venue with no live feed reads as paused", () => {
    // Perps venue with no coin selected, or stocks with no symbol.
    const state = getQuoteFreshness({ enabled: false, now: NOW });

    expect(state.tone).toBe("idle");
    expect(state.label).toBe("Quotes paused");
  });
});
