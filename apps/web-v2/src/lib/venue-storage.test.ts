import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VENUE,
  MARKET_FILTER_STORAGE_KEY,
  VENUE_STORAGE_KEY,
  isVenue,
  parseVenue,
  parseMarketFilter,
  serializeVenue,
} from "./venue-storage";

describe("venue storage", () => {
  test("default venue is stocks", () => {
    expect(DEFAULT_VENUE).toBe("stocks");
  });

  test("storage key is the pinned versioned key", () => {
    expect(VENUE_STORAGE_KEY).toBe("ready-set-trade.venue.v1");
    expect(MARKET_FILTER_STORAGE_KEY).toBe("ready-set-trade.market-filter.v1");
  });

  test("isVenue recognizes both known venues", () => {
    expect(isVenue("stocks")).toBe(true);
    expect(isVenue("perps")).toBe(true);
  });

  test("isVenue rejects unknown / non-string values", () => {
    expect(isVenue("options")).toBe(false);
    expect(isVenue("")).toBe(false);
    expect(isVenue(null)).toBe(false);
    expect(isVenue(undefined)).toBe(false);
    expect(isVenue(42)).toBe(false);
  });

  test("parseVenue round-trips a valid venue", () => {
    expect(parseVenue(serializeVenue("perps"))).toBe("perps");
    expect(parseVenue(serializeVenue("stocks"))).toBe("stocks");
  });

  test("parseVenue tolerates surrounding whitespace", () => {
    expect(parseVenue("  perps  ")).toBe("perps");
  });

  test("parseVenue falls back to default for null / empty / corrupt values", () => {
    expect(parseVenue(null)).toBe(DEFAULT_VENUE);
    expect(parseVenue(undefined)).toBe(DEFAULT_VENUE);
    expect(parseVenue("")).toBe(DEFAULT_VENUE);
    expect(parseVenue("garbage")).toBe(DEFAULT_VENUE);
    expect(parseVenue("{}")).toBe(DEFAULT_VENUE);
  });

  test("restores the top-level market filter and rejects corrupt values", () => {
    expect(parseMarketFilter("all")).toBe("all");
    expect(parseMarketFilter(" stocks ")).toBe("stocks");
    expect(parseMarketFilter("perps")).toBe("perps");
    expect(parseMarketFilter(null)).toBe("all");
    expect(parseMarketFilter("options")).toBe("all");
  });
});
