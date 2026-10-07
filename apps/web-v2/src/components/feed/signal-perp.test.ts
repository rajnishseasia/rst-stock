import { describe, expect, test } from "bun:test";
import {
  isPerpSignal,
  perpBadgeLabel,
  perpCopyPayload,
  equityOrderSignalId,
} from "./signal-perp";

describe("isPerpSignal", () => {
  test("treats a hyperliquid venue as a perp", () => {
    expect(isPerpSignal({ platform: "hyperliquid", direction: "short" })).toBe(true);
  });

  test("treats a perp instrument as a perp regardless of venue", () => {
    expect(isPerpSignal({ instrument: "perps", direction: "long" })).toBe(true);
    expect(isPerpSignal({ instrument: "perp" })).toBe(true);
  });

  test("a plain short equity is NOT a perp", () => {
    expect(isPerpSignal({ direction: "short" })).toBe(false);
  });

  test("an equity paste.trade row (robinhood / stock) is NOT a perp", () => {
    expect(isPerpSignal({ platform: "robinhood", instrument: "stock" })).toBe(false);
  });

  test("legacy metadata with no instrument fields is NOT a perp", () => {
    expect(isPerpSignal({ authorName: "Trader" })).toBe(false);
    expect(isPerpSignal(null)).toBe(false);
  });
});

describe("perpCopyPayload", () => {
  test("maps a hyperliquid short with leverage + hlTicker", () => {
    expect(
      perpCopyPayload({
        platform: "hyperliquid",
        instrument: "perp",
        direction: "short",
        leverage: 20,
        hlTicker: "GOOGL",
      }),
    ).toEqual({ coin: "GOOGL", side: "short", leverage: 20 });
  });

  test("defaults direction to long and omits leverage when absent", () => {
    expect(
      perpCopyPayload({ instrument: "perp", direction: "long", hlTicker: "BTC" }),
    ).toEqual({ coin: "BTC", side: "long" });
  });

  test("keeps the canonical hlTicker casing verbatim", () => {
    // HL coins are case-sensitive (kPEPE, not KPEPE), so the stored spelling is
    // copied through untouched.
    expect(
      perpCopyPayload({
        platform: "hyperliquid",
        instrument: "perp",
        hlTicker: "kPEPE",
      }),
    ).toEqual({ coin: "kPEPE", side: "long" });
  });

  test("offers no copy when hlTicker is absent", () => {
    // This case used to fall back to the signal's (uppercased, equity) ticker
    // and copy "ETH". See the "never guesses the Hyperliquid coin" block below
    // for why a guessed coin is a leveraged order on an unrequested market.
    expect(
      perpCopyPayload({ platform: "hyperliquid", instrument: "perps" }),
    ).toBeNull();
  });

  test("parses a stringified-number leverage and a stringified metadata blob", () => {
    expect(
      perpCopyPayload(
        JSON.stringify({
          platform: "hyperliquid",
          instrument: "perp",
          direction: "short",
          leverage: "10",
          hlTicker: "SOL",
        }),
      ),
    ).toEqual({ coin: "SOL", side: "short", leverage: 10 });
  });

  test("ignores a non-positive / unparseable leverage", () => {
    expect(
      perpCopyPayload({ instrument: "perp", leverage: 0, hlTicker: "BTC" }),
    ).toEqual({ coin: "BTC", side: "long" });
    expect(
      perpCopyPayload({ instrument: "perp", leverage: "abc", hlTicker: "BTC" }),
    ).toEqual({ coin: "BTC", side: "long" });
  });

  test("returns null for non-perp (equity) signals so the equity path is kept", () => {
    expect(perpCopyPayload({ direction: "short" })).toBeNull();
    expect(perpCopyPayload({ platform: "robinhood", instrument: "stock" })).toBeNull();
    expect(perpCopyPayload({ authorName: "Trader" })).toBeNull();
    expect(perpCopyPayload(null)).toBeNull();
  });

  test("returns null when a perp row's hlTicker is present but empty", () => {
    expect(perpCopyPayload({ instrument: "perp", hlTicker: "   " })).toBeNull();
    expect(perpCopyPayload({ instrument: "perp", hlTicker: "" })).toBeNull();
  });
});

describe("perpBadgeLabel", () => {
  test("formats direction with leverage", () => {
    expect(perpBadgeLabel("short", 20)).toBe("20x Short");
    expect(perpBadgeLabel("long", 3)).toBe("3x Long");
  });

  test("omits leverage when absent or non-positive", () => {
    expect(perpBadgeLabel("long")).toBe("Long");
    expect(perpBadgeLabel("short", 0)).toBe("Short");
  });
});

describe("equityOrderSignalId (venue collision guard)", () => {
  test("does NOT link a perp signal to an equity order on a colliding ticker", () => {
    // The real hazard: SOL is Solana on Hyperliquid and ReneSola on Nasdaq. The
    // user is on the SOL equity ticket and copies a perp SOL signal. A
    // symbol-only comparison passes here, which is exactly the bug.
    expect(
      equityOrderSignalId(
        { symbol: "SOL", signalId: "perp-signal-1", venue: "perps" },
        "SOL",
      ),
    ).toBeUndefined();
  });

  test("also blocks the APT collision (Aptos vs Alpha Pro Tech)", () => {
    expect(
      equityOrderSignalId(
        { symbol: "APT", signalId: "perp-signal-2", venue: "perps" },
        "apt",
      ),
    ).toBeUndefined();
  });

  test("links an equity signal to the matching equity ticket", () => {
    expect(
      equityOrderSignalId(
        { symbol: "AAPL", signalId: "sig-3", venue: "stocks" },
        "AAPL",
      ),
    ).toBe("sig-3");
  });

  test("treats a missing venue as the legacy equity path", () => {
    expect(equityOrderSignalId({ symbol: "AAPL", signalId: "sig-4" }, "AAPL")).toBe(
      "sig-4",
    );
  });

  test("does not let a stale selection follow the user to another equity", () => {
    expect(
      equityOrderSignalId(
        { symbol: "AAPL", signalId: "sig-5", venue: "stocks" },
        "MSFT",
      ),
    ).toBeUndefined();
  });

  test("normalizes case and whitespace on the symbol match", () => {
    expect(
      equityOrderSignalId({ symbol: " aapl ", signalId: "sig-6" }, "AAPL"),
    ).toBe("sig-6");
  });

  test("returns undefined for empty / missing input", () => {
    expect(equityOrderSignalId(null, "AAPL")).toBeUndefined();
    expect(equityOrderSignalId(undefined, "AAPL")).toBeUndefined();
    expect(equityOrderSignalId({ symbol: "AAPL" }, "AAPL")).toBeUndefined();
    expect(equityOrderSignalId({ symbol: "AAPL", signalId: "s" }, "")).toBeUndefined();
    expect(equityOrderSignalId({ signalId: "s" }, "AAPL")).toBeUndefined();
  });
});

describe("perpCopyPayload never guesses the Hyperliquid coin", () => {
  // A perp Copy seeds a LEVERAGED order ticket, so the coin decides which
  // market the user is one click from. `signals.symbol` is the equity ticker
  // the pollers uppercase at ingest, and its charset cannot even express the
  // two forms HL actually trades: a "<dex>:" HIP-3 route and a lowercase-k
  // coin. See packages/hyperliquid/src/coin.ts.

  test("a HIP-3 perp row with no hlTicker offers no copy instead of the bare underlying", () => {
    // paste.trade served ticker "GOOGL" with hl_ticker missing or malformed, so
    // mapPasteTradeRow stored hlTicker: null. "GOOGL" and "xyz:GOOGL" are
    // DIFFERENT markets, so seeding the ticket with "GOOGL" is a 20x short on a
    // market the author never traded.
    expect(
      perpCopyPayload({
        platform: "hyperliquid",
        instrument: "perp",
        direction: "short",
        leverage: 20,
        hlTicker: null,
      }),
    ).toBeNull();
  });

  test("cannot see the equity ticker at all, so no fallback can come back", () => {
    // The signature is the guard. A row whose equity ticker is "KPEPE" must not
    // become a copy of "KPEPE" (not an alias of "kPEPE", an unknown coin), and
    // the mapper is not given the ticker to reach for in the first place.
    expect(perpCopyPayload.length).toBe(1);
  });

  test("a non-canonical hlTicker is refused rather than repaired", () => {
    // Same rule the mirror worker applies to this exact field: accept or skip,
    // never clean up. "xyz-GOOGL" is not a route to anything.
    expect(
      perpCopyPayload({
        platform: "hyperliquid",
        instrument: "perp",
        hlTicker: "xyz-GOOGL",
      }),
    ).toBeNull();
    expect(
      perpCopyPayload({
        platform: "hyperliquid",
        instrument: "perp",
        hlTicker: "BTC/USD",
      }),
    ).toBeNull();
  });

  test("a canonical HIP-3 hlTicker still copies, prefix and all", () => {
    expect(
      perpCopyPayload({
        platform: "hyperliquid",
        instrument: "perp",
        direction: "short",
        leverage: 20,
        hlTicker: "xyz:GOOGL",
      }),
    ).toEqual({ coin: "xyz:GOOGL", side: "short", leverage: 20 });
  });
});
