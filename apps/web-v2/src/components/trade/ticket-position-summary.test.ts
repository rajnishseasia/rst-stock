import { describe, expect, test } from "bun:test";

import {
  NO_POSITION_LABEL,
  UNKNOWN_POSITION_LABEL,
  equityPositionSummary,
  perpPositionSummary,
} from "./ticket-position-summary";

describe("equityPositionSummary", () => {
  test("renders whole shares with the average entry", () => {
    expect(equityPositionSummary({ qty: 12, avgEntryPrice: 145.2 })).toBe(
      "12 sh @ $145.20",
    );
  });

  test("keeps fractional share counts", () => {
    expect(equityPositionSummary({ qty: 0.5321, avgEntryPrice: 200 })).toBe(
      "0.5321 sh @ $200.00",
    );
  });

  test("says None rather than 0 for an absent or flat position", () => {
    expect(equityPositionSummary(null)).toBe(NO_POSITION_LABEL);
    expect(equityPositionSummary(undefined)).toBe(NO_POSITION_LABEL);
    expect(equityPositionSummary({ qty: 0, avgEntryPrice: 100 })).toBe(
      NO_POSITION_LABEL,
    );
  });

  test("a SHORT is named as one, not rendered as a negative share count", () => {
    // The display used to run off `activeEquityPosition`, a sell-availability
    // predicate gated on `side === "long"`, so a held short read as "None" on
    // the very ticket the user was about to trade from. Alpaca reports a short's
    // qty as negative; "-12 sh" next to a Buy button is ambiguous in a way
    // "Short 12 sh" is not.
    expect(
      equityPositionSummary({ qty: -12, avgEntryPrice: 145.2, side: "short" }),
    ).toBe("Short 12 sh @ $145.20");
  });

  test("a negative qty is treated as a short even without an explicit side", () => {
    expect(equityPositionSummary({ qty: -3, avgEntryPrice: 50 })).toBe(
      "Short 3 sh @ $50.00",
    );
  });

  test("an explicit long side does not add a prefix", () => {
    expect(
      equityPositionSummary({ qty: 12, avgEntryPrice: 145.2, side: "long" }),
    ).toBe("12 sh @ $145.20");
  });

  test("a fractional short keeps its precision", () => {
    expect(
      equityPositionSummary({ qty: -0.5321, avgEntryPrice: 200, side: "short" }),
    ).toBe("Short 0.5321 sh @ $200.00");
  });

  test("still reports the size when the entry price is unusable", () => {
    expect(equityPositionSummary({ qty: 3, avgEntryPrice: Number.NaN })).toBe(
      "3 sh",
    );
  });
});

describe("perpPositionSummary", () => {
  test("names the side, so Reduce Only has something to point at", () => {
    expect(
      perpPositionSummary({ side: "long", size: "0.5", entryPx: "3120.4" }),
    ).toBe("Long 0.5 @ 3,120.40");
    expect(
      perpPositionSummary({ side: "short", size: "2", entryPx: "3120.4" }),
    ).toBe("Short 2 @ 3,120.40");
  });

  test("keeps sub-cent precision on a low-priced coin", () => {
    // The fixed 2-decimal helpers would collapse this to "$0.00" (CLAUDE.md
    // M16 exception 2), so the perp helper has to be the one doing this.
    expect(
      perpPositionSummary({ side: "long", size: "1000", entryPx: "0.0000123" }),
    ).toBe("Long 1000 @ 0.0000123");
  });

  test("says None for an absent or zero-size position", () => {
    expect(perpPositionSummary(null)).toBe(NO_POSITION_LABEL);
    expect(perpPositionSummary({ side: "long", size: "0", entryPx: "1" })).toBe(
      NO_POSITION_LABEL,
    );
  });

  test("omits the entry when Hyperliquid did not report one", () => {
    expect(
      perpPositionSummary({ side: "long", size: "0.25", entryPx: null }),
    ).toBe("Long 0.25");
  });
});

describe("an unanswered positions request is not 'None'", () => {
  test("equities: loading or failed reads as Unknown, not None", () => {
    // The bug, and it was in BOTH tickets: optional chaining turns a missing
    // response and a successful empty one into the same null, so a cold open or
    // an outage told a user with an open position that they held nothing, right
    // next to the controls they were about to trade with.
    expect(
      equityPositionSummary(undefined, { settled: false }),
    ).toBe(UNKNOWN_POSITION_LABEL);
    // Even a real position is reported as unknown while unsettled: the lookup
    // could be a stale match from a previous symbol.
    expect(
      equityPositionSummary({ qty: 12, avgEntryPrice: 145.2 }, { settled: false }),
    ).toBe(UNKNOWN_POSITION_LABEL);
  });

  test("perps: loading or failed reads as Unknown, not None", () => {
    expect(perpPositionSummary(null, { settled: false })).toBe(
      UNKNOWN_POSITION_LABEL,
    );
  });

  test("a settled empty response still reads as None", () => {
    expect(equityPositionSummary(null, { settled: true })).toBe(NO_POSITION_LABEL);
    expect(perpPositionSummary(null, { settled: true })).toBe(NO_POSITION_LABEL);
    // Default keeps every existing caller unchanged.
    expect(equityPositionSummary(null)).toBe(NO_POSITION_LABEL);
    expect(perpPositionSummary(null)).toBe(NO_POSITION_LABEL);
  });

  test("Unknown and None are different strings", () => {
    // Guards the whole point: collapsing them re-creates the bug silently.
    expect(UNKNOWN_POSITION_LABEL).not.toBe(NO_POSITION_LABEL);
  });
});
