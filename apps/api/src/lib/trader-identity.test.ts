import { describe, expect, test } from "bun:test";
import { anonymizeTrader, resolveTraderIdentity } from "./trader-identity";

describe("resolveTraderIdentity", () => {
  test("keeps the deterministic anonymous identity without a linked X account", () => {
    expect(resolveTraderIdentity("user-1")).toEqual({
      ...anonymizeTrader("user-1"),
      twitterHandle: null,
      twitterLinked: false,
    });
  });

  test("uses the linked X profile and normalizes its handle", () => {
    expect(resolveTraderIdentity("user-1", {
      twitterLinked: true,
      name: "Ada Trader",
      username: "@adatrades",
      image: "https://images.example/ada.png",
    })).toEqual({
      traderName: "Ada Trader",
      traderImage: "https://images.example/ada.png",
      twitterHandle: "adatrades",
      twitterLinked: true,
    });
  });
});
