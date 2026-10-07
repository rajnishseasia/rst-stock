import { describe, it, expect } from "bun:test";
import { resolveTimeInForce } from "./time-in-force.js";

describe("resolveTimeInForce - options", () => {
  it("uses GTC for option limit sells (resting exit)", () => {
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "limit",
        side: "sell",
      }),
    ).toBe("gtc");
  });

  it("keeps GTC on option limit sells even when DAY is requested", () => {
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "limit",
        side: "sell",
        requested: "day",
      }),
    ).toBe("gtc");
  });

  it("honors an explicit GTC on option limit buys", () => {
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "limit",
        side: "buy",
        requested: "gtc",
      }),
    ).toBe("gtc");
  });

  it("defaults option limit buys to DAY when nothing is requested", () => {
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "limit",
        side: "buy",
      }),
    ).toBe("day");
  });

  it("forces DAY on option market orders even if GTC is requested", () => {
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "market",
        side: "sell",
        requested: "gtc",
      }),
    ).toBe("day");
  });

  it("forces DAY on option stop / stop_limit orders", () => {
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "stop",
        side: "sell",
        requested: "gtc",
      }),
    ).toBe("day");
    expect(
      resolveTimeInForce({
        assetType: "OPTION",
        orderType: "stop_limit",
        side: "buy",
        requested: "gtc",
      }),
    ).toBe("day");
  });
});

describe("resolveTimeInForce - equities", () => {
  it("uses GTC for equity limit sells", () => {
    expect(
      resolveTimeInForce({
        assetType: "EQUITY",
        orderType: "limit",
        side: "sell",
      }),
    ).toBe("gtc");
  });

  it("honors the requested TIF for equity non-limit-sell orders", () => {
    expect(
      resolveTimeInForce({
        assetType: "EQUITY",
        orderType: "limit",
        side: "buy",
        requested: "ioc",
      }),
    ).toBe("ioc");
  });

  it("defaults equities to GTC when nothing is requested", () => {
    expect(
      resolveTimeInForce({
        assetType: "EQUITY",
        orderType: "market",
        side: "buy",
      }),
    ).toBe("gtc");
  });
});
