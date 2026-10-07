import { describe, expect, it } from "bun:test";
import { copyDisabledReason } from "./copy-eligibility";

describe("copyDisabledReason", () => {
  it("disables Copy for a perp signal and names the venue, instrument, and direction", () => {
    const reason = copyDisabledReason({
      signalId: "sig-1",
      mirrorableEquity: false,
      platform: "hyperliquid",
      instrument: "perp",
      direction: "short",
    });
    expect(reason).toBe(
      "This call is a hyperliquid perp (short); it cannot be copied as a stock order.",
    );
  });

  it("disables Copy for a short signal without venue/instrument fields", () => {
    const reason = copyDisabledReason({
      signalId: "sig-2",
      mirrorableEquity: false,
      platform: null,
      instrument: null,
      direction: "short",
    });
    expect(reason).toBe(
      "This call is a short; it cannot be copied as a stock order.",
    );
  });

  it("falls back to generic wording when the flag is set but no fields survive", () => {
    const reason = copyDisabledReason({ mirrorableEquity: false });
    expect(reason).toBe(
      "This call is not a plain stock trade; it cannot be copied as a stock order.",
    );
  });

  it("keeps Copy enabled for plain equity signal meta (no flag)", () => {
    expect(copyDisabledReason({ signalId: "sig-3" })).toBeNull();
  });

  it("keeps Copy enabled for option and user-trade meta shapes", () => {
    expect(
      copyDisabledReason({
        signalId: "sig-4",
        assetType: "OPTION",
        optionExpiration: "2026-08-21",
        optionStrike: 200,
        optionType: "CALL",
        tradeAction: "BuyToOpen",
      }),
    ).toBeNull();
    expect(copyDisabledReason({ copiedFrom: "someone" })).toBeNull();
  });

  it("keeps manual Copy buy-only while explaining guarded auto-mirror exits", () => {
    expect(copyDisabledReason({ copiedFrom: "someone" }, "buy")).toBeNull();
    expect(copyDisabledReason({ copiedFrom: "someone" }, "sell")).toBe(
      "Sell transactions are shown for context. Manual Copy is buy-only; auto-mirror can only sell to reduce an existing long position.",
    );
    expect(copyDisabledReason(undefined, "sell")).toContain("Manual Copy is buy-only");
  });

  it("disables Copy for a Hyperliquid PERP row read off the venue alone", () => {
    // The exact meta shape mapUserTradeToItem emits for a 10x SOL long open.
    // The gate must read assetType, not only mirrorableEquity: that flag is set
    // by the mappers, and a row that reached the feed before the server-side
    // veto (or from any future mapper that forgets it) is otherwise identical to
    // an equity buy. SOL is also ReneSola on Nasdaq, so an enabled Copy here
    // prefills an Alpaca ticket for a different company entirely.
    const reason = copyDisabledReason(
      {
        qty: 12.5,
        orderType: "Market",
        fillPrice: 180.25,
        limitPrice: null,
        assetType: "PERP",
        copiedFrom: null,
      },
      "buy",
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("perp");
  });

  it("still disables Copy for a PERP row that also carries the veto flag", () => {
    const reason = copyDisabledReason(
      { assetType: "PERP", mirrorableEquity: false },
      "buy",
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("perp");
  });

  it("still vetoes the equity route for the richer perp meta shape the server now emits", () => {
    // mapUserTradeToItem now also emits perpCoin/perpDirection/perpLeverage/
    // perpReduceOnly/perpVenue so copy-perp-route.ts has something to work
    // with. This is the load-bearing regression pin: the equity veto must
    // keep refusing on `assetType === "PERP"` alone and must NOT be fooled
    // into treating the new fields as permission to loosen anything here.
    const reason = copyDisabledReason(
      {
        qty: 12.5,
        assetType: "PERP",
        perpVenue: "hyperliquid",
        perpCoin: "kPEPE",
        perpDirection: "long",
        perpLeverage: 10,
        perpReduceOnly: false,
      },
      "buy",
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("perp");
  });

  it("leaves Copy enabled for EQUITY and OPTION asset types", () => {
    expect(copyDisabledReason({ assetType: "EQUITY" }, "buy")).toBeNull();
    expect(
      copyDisabledReason(
        {
          assetType: "OPTION",
          optionExpiration: "2026-08-21",
          optionStrike: 200,
          optionType: "CALL",
          tradeAction: "BuyToOpen",
        },
        "buy",
      ),
    ).toBeNull();
  });

  it("keeps Copy enabled when meta is missing entirely", () => {
    expect(copyDisabledReason(undefined)).toBeNull();
    expect(copyDisabledReason(null)).toBeNull();
  });

  it("only trips on the literal false flag, not truthy/other values", () => {
    expect(copyDisabledReason({ mirrorableEquity: true })).toBeNull();
    expect(copyDisabledReason({ mirrorableEquity: "false" })).toBeNull();
  });
});
