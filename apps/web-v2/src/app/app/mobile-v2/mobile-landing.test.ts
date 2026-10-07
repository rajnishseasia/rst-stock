import { describe, expect, test } from "bun:test";

import { mobileLandingSlots } from "./mobile-landing";

describe("mobile Trade landing slots", () => {
  test("lands each venue on its most recent pick, most-recent-first", () => {
    expect(
      mobileLandingSlots(
        [
          { symbol: "NVDA", venue: "stocks" },
          { symbol: "kPEPE", venue: "perps" },
          { symbol: "AAPL", venue: "stocks" },
          { symbol: "BTC", venue: "perps" },
        ],
        null,
      ),
    ).toEqual({ stocks: "NVDA", perps: "kPEPE" });
  });

  test("leaves a slot alone when the URL already names a market on that venue", () => {
    // The history codec applies the URL market itself; seeding the same slot
    // from Recents would race it. The other venue still gets its recent pick.
    expect(
      mobileLandingSlots(
        [
          { symbol: "NVDA", venue: "stocks" },
          { symbol: "BTC", venue: "perps" },
        ],
        { symbol: "AAPL", venue: "stocks" },
      ),
    ).toEqual({ perps: "BTC" });
  });

  test("returns nothing for a first-run user, so the per-venue defaults stand", () => {
    expect(mobileLandingSlots([], null)).toEqual({});
    expect(mobileLandingSlots([{ symbol: "", venue: "stocks" }], null)).toEqual({});
  });
});
