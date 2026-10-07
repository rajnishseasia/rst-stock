import { describe, expect, it } from "bun:test";
import { isValidOptionContractIdentity, parseAlpacaOptionSymbol } from "../lib/options";

describe("parseAlpacaOptionSymbol", () => {
  it("parses canonical compact Alpaca option symbols", () => {
    expect(parseAlpacaOptionSymbol("AAPL260719C00250000")).toEqual({
      symbol: "AAPL",
      optionExpiration: "260719",
      optionStrike: 250,
      optionType: "CALL",
    });
    expect(parseAlpacaOptionSymbol("msft270115p00105000")).toEqual({
      symbol: "MSFT",
      optionExpiration: "270115",
      optionStrike: 105,
      optionType: "PUT",
    });
  });

  it("returns null for malformed or impossible contracts", () => {
    expect(parseAlpacaOptionSymbol("AAPL260732C00250000")).toBeNull();
    expect(parseAlpacaOptionSymbol("AAPL260719X00250000")).toBeNull();
    expect(parseAlpacaOptionSymbol("AAPL260719C00000000")).toBeNull();
    expect(parseAlpacaOptionSymbol("AAPL")).toBeNull();
  });
});

describe("isValidOptionContractIdentity", () => {
  const validContract = {
    optionStrike: 250,
    optionType: "CALL",
  } as const;

  it("requires exactly six ASCII digits and a real calendar date", () => {
    expect(isValidOptionContractIdentity({ ...validContract, optionExpiration: "260719" })).toBe(true);

    for (const malformed of [
      "2607170",
      "260717x",
      "26071",
      " 260719",
      "260719 ",
      "２６０７１９",
      "260732",
      "260700",
    ]) {
      expect(
        isValidOptionContractIdentity({
          ...validContract,
          optionExpiration: malformed,
        }),
      ).toBe(false);
    }
  });

  it("rejects coercive option strikes", () => {
    for (const optionStrike of ["250junk", "0xFA", "", "Infinity"]) {
      expect(
        isValidOptionContractIdentity({
          ...validContract,
          optionExpiration: "260719",
          optionStrike,
        }),
      ).toBe(false);
    }
  });
});
