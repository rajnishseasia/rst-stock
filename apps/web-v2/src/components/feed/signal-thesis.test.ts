import { describe, expect, test } from "bun:test";
import {
  describeSignalAttribution,
  describeSignalChartCta,
  formatSignalAge,
  signalDirectionFromMetadata,
  signalDirectionLabel,
  signalThesisForMarket,
  type SignalThesis,
} from "./signal-thesis";
import { perpCopyPayload } from "./signal-perp";
import { signalSideFromMetadata } from "@trade-bot/utils/utils/signal-instrument";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");

function thesis(overrides: Partial<SignalThesis> = {}): SignalThesis {
  return {
    authorName: "Alice",
    authorAvatar: null,
    timestamp: "2026-03-10T10:00:00.000Z",
    url: null,
    imageUrl: null,
    direction: null,
    ...overrides,
  };
}

describe("signalDirectionFromMetadata: absence is not a direction", () => {
  test("metadata with NO direction field resolves to null, not long", () => {
    // The whole point of S1's gate. Most X-relayed signals carry only author
    // metadata, and the shared classifier resolves those to side "buy" because
    // an order has to open SOME side. Rendering that as a claim would print
    // "Alice's long call" on a post where nobody said long.
    const metadata = { authorName: "Alice" };

    expect(signalSideFromMetadata(metadata)).toBe("buy");
    expect(signalDirectionFromMetadata(metadata)).toBeNull();
  });

  test("a perp call with no direction resolves to null even though the copy opens long", () => {
    // perpCopyPayload defaults side to "long" so a Copy has something to submit.
    // The display gate must not inherit that default.
    const metadata = {
      platform: "hyperliquid",
      instrument: "perp",
      hlTicker: "BTC",
    };

    expect(perpCopyPayload(metadata)?.side).toBe("long");
    expect(signalDirectionFromMetadata(metadata)).toBeNull();
  });

  test("an explicit long and an explicit short both render", () => {
    expect(signalDirectionFromMetadata({ direction: "long" })).toBe("long");
    expect(signalDirectionFromMetadata({ direction: "short" })).toBe("short");
    expect(signalDirectionFromMetadata({ direction: "sell" })).toBe("short");
    expect(signalDirectionFromMetadata({ direction: "BUY" })).toBe("long");
  });

  test("a present-but-unparseable direction stays null rather than defaulting", () => {
    // The classifier fails OPEN for order routing (treats it as a plain long).
    // Display must fail CLOSED: an unreadable field is not a stated direction.
    expect(signalDirectionFromMetadata({ direction: "   " })).toBeNull();
    expect(signalDirectionFromMetadata({ direction: 7 })).toBeNull();
    expect(signalDirectionFromMetadata({ direction: null })).toBeNull();
  });

  test("no metadata at all is null", () => {
    expect(signalDirectionFromMetadata(null)).toBeNull();
    expect(signalDirectionFromMetadata(undefined)).toBeNull();
    expect(signalDirectionFromMetadata("not json")).toBeNull();
  });

  test("stringified jsonb is parsed like the object form", () => {
    expect(signalDirectionFromMetadata('{"direction":"short"}')).toBe("short");
  });
});

describe("signalDirectionLabel", () => {
  test("title-cases the two stated directions", () => {
    expect(signalDirectionLabel("long")).toBe("Long");
    expect(signalDirectionLabel("short")).toBe("Short");
  });
});

describe("formatSignalAge", () => {
  test("steps from minutes to hours to days to an absolute date", () => {
    expect(formatSignalAge(NOW - 30_000, NOW)).toBe("just now");
    expect(formatSignalAge(NOW - 14 * 60_000, NOW)).toBe("14m ago");
    expect(formatSignalAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatSignalAge(NOW - 6 * 86_400_000, NOW)).toBe("6d ago");
    expect(formatSignalAge(NOW - 40 * 86_400_000, NOW)).not.toContain("ago");
  });

  test("a future timestamp clamps rather than rendering a negative age", () => {
    // Poller clock skew is real; "-3m ago" under a chart is worse than "just now".
    expect(formatSignalAge(NOW + 5 * 60_000, NOW)).toBe("just now");
  });

  test("an unparseable timestamp renders nothing at all", () => {
    expect(formatSignalAge("not a date", NOW)).toBe("");
  });
});

describe("describeSignalAttribution", () => {
  test("omits the direction entirely when none was stated", () => {
    expect(
      describeSignalAttribution(
        { authorName: "Alice", timestamp: NOW - 3_600_000, direction: null },
        NOW,
      ),
    ).toBe("Alice's call · 1h ago");
  });

  test("states the direction descriptively, not imperatively", () => {
    // "Alice's short call" reads as a report. "Short" alone, on a button that
    // opens an order ticket, reads as an instruction.
    expect(
      describeSignalAttribution(
        { authorName: "Alice", timestamp: NOW - 3_600_000, direction: "short" },
        NOW,
      ),
    ).toBe("Alice's short call · 1h ago");
  });

  test("falls back to Unknown rather than an empty possessive", () => {
    expect(
      describeSignalAttribution(
        { authorName: "  ", timestamp: NOW - 60_000, direction: null },
        NOW,
      ),
    ).toBe("Unknown's call · 1m ago");
  });

  test("drops the separator when the timestamp is unusable", () => {
    expect(
      describeSignalAttribution(
        { authorName: "Alice", timestamp: "nonsense", direction: "long" },
        NOW,
      ),
    ).toBe("Alice's long call");
  });
});

describe("describeSignalChartCta", () => {
  test("with no signal in hand the label is exactly what it was before S1", () => {
    expect(
      describeSignalChartCta({ symbol: "NVDA", canTrade: true, thesis: null }),
    ).toEqual({ primary: "Trade NVDA", context: null });
  });

  test("an unconnected broker still says so, and still names the caller", () => {
    expect(
      describeSignalChartCta({
        symbol: "NVDA",
        canTrade: false,
        thesis: { authorName: "Alice", timestamp: NOW - 7_200_000, direction: "long" },
        now: NOW,
      }),
    ).toEqual({
      primary: "Connect Broker to Trade",
      context: "Alice's long call · 2h ago",
    });
  });

  test("the context is a separate field so the caller name is never truncated in logic", () => {
    const cta = describeSignalChartCta({
      symbol: "NVDA",
      canTrade: true,
      thesis: {
        authorName: "A Caller With A Very Long Display Name Indeed",
        timestamp: NOW - 60_000,
        direction: null,
      },
      now: NOW,
    });

    expect(cta.primary).toBe("Trade NVDA");
    expect(cta.context).toContain("A Caller With A Very Long Display Name Indeed");
  });
});

describe("signalThesisForMarket: the venue guard", () => {
  const perpSelection = {
    symbol: "SOL",
    venue: "perps" as const,
    thesis: thesis({ direction: "short" }),
  };

  test("a perp caller's words never appear on the equity chart for the same ticker", () => {
    // SOL is Solana on Hyperliquid and ReneSola on Nasdaq. A symbol-only match
    // would attribute a leveraged crypto short to a solar-panel stock chart.
    expect(signalThesisForMarket(perpSelection, "SOL", false)).toBeNull();
    expect(signalThesisForMarket(perpSelection, "SOL", true)).toEqual(
      perpSelection.thesis,
    );
  });

  test("a selection with no venue is the legacy equity path", () => {
    const legacy = { symbol: "NVDA", thesis: thesis() };

    expect(signalThesisForMarket(legacy, "NVDA", false)).toEqual(legacy.thesis);
    expect(signalThesisForMarket(legacy, "NVDA", true)).toBeNull();
  });

  test("a stale selection does not follow the user to another market", () => {
    expect(
      signalThesisForMarket(
        { symbol: "NVDA", venue: "stocks", thesis: thesis() },
        "AMD",
        false,
      ),
    ).toBeNull();
  });

  test("symbol comparison is case and whitespace insensitive", () => {
    expect(
      signalThesisForMarket(
        { symbol: " nvda ", venue: "stocks", thesis: thesis() },
        "NVDA",
        false,
      ),
    ).not.toBeNull();
  });

  test("no selection, no thesis, or no market renders nothing", () => {
    expect(signalThesisForMarket(null, "NVDA", false)).toBeNull();
    expect(signalThesisForMarket(undefined, "NVDA", false)).toBeNull();
    expect(
      signalThesisForMarket({ symbol: "NVDA", venue: "stocks" }, "NVDA", false),
    ).toBeNull();
    expect(
      signalThesisForMarket(
        { symbol: "NVDA", venue: "stocks", thesis: thesis() },
        "",
        false,
      ),
    ).toBeNull();
  });
});

describe("the chart CTA names the venue that is not set up", () => {
  const base = { symbol: "BTC", thesis: null };

  test("an unprovisioned perps user is not offered a trade", () => {
    // Perps used to be hardcoded `canTrade: true`, so this said "Trade BTC" and
    // then showed onboarding instead of a ticket.
    expect(
      describeSignalChartCta({ ...base, canTrade: false, venue: "perps" }).primary,
    ).toBe("Enable Perps to Trade");
  });

  test("a stocks user without a broker gets the broker prompt", () => {
    expect(
      describeSignalChartCta({ ...base, canTrade: false, venue: "stocks" }).primary,
    ).toBe("Connect Broker to Trade");
  });

  test("UNKNOWN keeps the trade label rather than prompting setup", () => {
    // Telling someone to enable a venue they may already have is the worse of
    // the two wrong answers, and the ticket resolves it either way.
    expect(
      describeSignalChartCta({ ...base, canTrade: null, venue: "perps" }).primary,
    ).toBe("Trade BTC");
  });

  test("a set-up venue trades", () => {
    expect(
      describeSignalChartCta({ ...base, canTrade: true, venue: "perps" }).primary,
    ).toBe("Trade BTC");
  });
});

describe("the CTA treats BOTH venues the same way", () => {
  const base = { symbol: "AAPL", thesis: null };

  test("an unresolved STOCKS check keeps the trade label", () => {
    // The asymmetry, third time in this PR: perps was made tri-state and stocks
    // left binary, so a connected user saw "Connect Broker to Trade" while the
    // credentials read was still in flight.
    expect(
      describeSignalChartCta({ ...base, canTrade: null, venue: "stocks" }).primary,
    ).toBe("Trade AAPL");
  });

  test("a CONFIRMED missing broker still gets the prompt", () => {
    expect(
      describeSignalChartCta({ ...base, canTrade: false, venue: "stocks" }).primary,
    ).toBe("Connect Broker to Trade");
  });

  test("stocks and perps behave identically on unknown", () => {
    const stocks = describeSignalChartCta({ ...base, canTrade: null, venue: "stocks" });
    const perps = describeSignalChartCta({
      ...base,
      symbol: "BTC",
      canTrade: null,
      venue: "perps",
    });
    expect(stocks.primary).toBe("Trade AAPL");
    expect(perps.primary).toBe("Trade BTC");
  });
});
