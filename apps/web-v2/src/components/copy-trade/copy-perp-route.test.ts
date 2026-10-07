import { describe, expect, it } from "bun:test";
import { perpCopyFromTradeRow } from "./copy-perp-route";

const ENABLED = { perpsEnabled: true };
const DISABLED = { perpsEnabled: false };

/** The exact meta shape mapUserTradeToItem emits for a fully-joined 10x
 * kPEPE long open. Tests below mutate one field at a time off this base. */
const VALID_LONG_META = {
  assetType: "PERP",
  perpVenue: "hyperliquid",
  perpCoin: "kPEPE",
  perpDirection: "long",
  perpLeverage: 10,
  perpReduceOnly: false,
};

describe("perpCopyFromTradeRow", () => {
  it("routes a valid perp open to the perp ticket with the coin's case preserved", () => {
    const route = perpCopyFromTradeRow(VALID_LONG_META, ENABLED);
    expect(route).toEqual({ kind: "perp", coin: "kPEPE", side: "long", leverage: 10 });
  });

  it("omits the leverage key entirely rather than defaulting to 1", () => {
    const { perpLeverage: _drop, ...meta } = VALID_LONG_META;
    const route = perpCopyFromTradeRow(meta, ENABLED);
    expect(route).toEqual({ kind: "perp", coin: "kPEPE", side: "long" });
    expect(route && "leverage" in route).toBe(false);
  });

  it("routes a short open just as readily as a long one", () => {
    const route = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpDirection: "short" },
      ENABLED,
    );
    expect(route).toEqual({ kind: "perp", coin: "kPEPE", side: "short", leverage: 10 });
  });

  it("preserves a HIP-3 builder coin's exact spelling", () => {
    const route = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpCoin: "xyz:GOOGL" },
      ENABLED,
    );
    expect(route).toEqual({
      kind: "perp",
      coin: "xyz:GOOGL",
      side: "long",
      leverage: 10,
    });
  });

  it("refuses a reduce-only row in EITHER direction rather than copying a close as an open", () => {
    const longClose = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpReduceOnly: true },
      ENABLED,
    );
    expect(longClose).toMatchObject({ kind: "refused", coin: "kPEPE" });
    expect((longClose as { reason: string }).reason).toContain("closes a position");

    const shortClose = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpDirection: "short", perpReduceOnly: true },
      ENABLED,
    );
    expect(shortClose).toMatchObject({ kind: "refused", coin: "kPEPE" });
  });

  it("fails closed when reduceOnly is missing entirely (unjoined row), not just when it is true", () => {
    const { perpReduceOnly: _drop, ...meta } = VALID_LONG_META;
    const route = perpCopyFromTradeRow(meta, ENABLED);
    expect(route?.kind).toBe("refused");
  });

  it("refuses a missing or non-canonical coin and never falls back to any other field", () => {
    const { perpCoin: _drop, ...meta } = VALID_LONG_META;
    const missing = perpCopyFromTradeRow(meta, ENABLED);
    expect(missing?.kind).toBe("refused");
    expect((missing as { reason: string }).reason).toContain("couldn't be identified");

    const nonCanonical = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpCoin: "kPEPE-USD" },
      ENABLED,
    );
    expect(nonCanonical?.kind).toBe("refused");

    const tooLong = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpCoin: "A".repeat(21) },
      ENABLED,
    );
    expect(tooLong?.kind).toBe("refused");
  });

  it("refuses a missing direction rather than guessing from side", () => {
    const { perpDirection: _drop, ...meta } = VALID_LONG_META;
    const route = perpCopyFromTradeRow(meta, ENABLED);
    expect(route?.kind).toBe("refused");
    expect((route as { reason: string }).reason).toContain("direction");
  });

  it("refuses a venue other than hyperliquid, including a missing one", () => {
    const wrongVenue = perpCopyFromTradeRow(
      { ...VALID_LONG_META, perpVenue: "alpaca" },
      ENABLED,
    );
    expect(wrongVenue?.kind).toBe("refused");

    const { perpVenue: _drop, ...meta } = VALID_LONG_META;
    const missingVenue = perpCopyFromTradeRow(meta, ENABLED);
    expect(missingVenue?.kind).toBe("refused");

    const nullVenue = perpCopyFromTradeRow({ ...VALID_LONG_META, perpVenue: null }, ENABLED);
    expect(nullVenue?.kind).toBe("refused");
  });

  it("refuses when perps aren't enabled on this deployment, even for an otherwise-valid row", () => {
    const route = perpCopyFromTradeRow(VALID_LONG_META, DISABLED);
    expect(route?.kind).toBe("refused");
    expect((route as { reason: string }).reason).toContain("enabled");
  });

  it("is not a refusal for an EQUITY or OPTION row - it is simply not a perp route", () => {
    expect(perpCopyFromTradeRow({ assetType: "EQUITY" }, ENABLED)).toBeNull();
    expect(
      perpCopyFromTradeRow(
        { assetType: "OPTION", optionExpiration: "260719", optionStrike: 250, optionType: "CALL" },
        ENABLED,
      ),
    ).toBeNull();
    expect(perpCopyFromTradeRow(undefined, ENABLED)).toBeNull();
    expect(perpCopyFromTradeRow(null, ENABLED)).toBeNull();
    expect(perpCopyFromTradeRow({}, ENABLED)).toBeNull();
  });

  it("never derives the coin from anything but meta.perpCoin - no symbol parameter exists to tempt a fallback", () => {
    // The function's arity is the guard: there is no ticker/symbol argument
    // for a future edit to reach for. Mirrors signal-perp.test.ts's identical
    // check on perpCopyPayload.
    expect(perpCopyFromTradeRow.length).toBe(2);
  });
});
