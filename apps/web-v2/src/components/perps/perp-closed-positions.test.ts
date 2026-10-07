import { describe, expect, test } from "bun:test";

import {
  closedPerpPositions,
  openPerpRealizedByCoin,
  type ClosedPositionFill,
} from "./perp-closed-positions";

function fill(overrides: Partial<ClosedPositionFill> & { time: number }): ClosedPositionFill {
  return {
    coin: "BTC",
    side: "buy",
    px: "100",
    sz: "1",
    closedPnl: "0.0",
    fee: "0.1",
    dir: "Open Long",
    oid: overrides.time,
    orderType: null,
    ...overrides,
  };
}

describe("closedPerpPositions", () => {
  test("folds a simple long round-trip into one closed position", () => {
    const closed = closedPerpPositions([
      fill({ time: 2, side: "sell", px: "110", dir: "Close Long", closedPnl: "10", oid: 9 }),
      fill({ time: 1, side: "buy", px: "100", dir: "Open Long", oid: 8 }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      coin: "BTC",
      side: "long",
      openedAt: 1,
      closedAt: 2,
      sizeCoin: 1,
      avgClosePx: 110,
      realizedPnl: 10,
      partial: false,
    });
  });

  test("does not infer a short from an over-closing Close Long sequence", () => {
    const reduced = [
      fill({
        time: 1788531196884,
        coin: "INIT",
        side: "buy",
        px: "0.06298",
        sz: "24435.0",
        dir: "Open Long",
        oid: 536127295457,
      }),
      fill({
        time: 1788658152485,
        coin: "INIT",
        side: "sell",
        px: "0.06758586767223808",
        sz: "24530.0",
        closedPnl: "153.775324",
        fee: "0.911827",
        dir: "Close Long",
        oid: 537236758712,
      }),
      ...[
        { px: "0.067653", closedPnl: "1.381248", fee: "0.00811" },
        { px: "0.067658", closedPnl: "1.382338", fee: "0.008111" },
        { px: "0.067663", closedPnl: "1.383428", fee: "0.008112" },
        { px: "0.067669", closedPnl: "1.384736", fee: "0.008113" },
        { px: "0.067674", closedPnl: "1.385826", fee: "0.008113" },
        { px: "0.067679", closedPnl: "1.386916", fee: "0.008114" },
        { px: "0.067687", closedPnl: "1.38866", fee: "0.008115" },
        { px: "0.067689", closedPnl: "1.389096", fee: "0.008115" },
        { px: "0.067697", closedPnl: "1.39084", fee: "0.008116" },
      ].map((close) =>
        fill({
          time: 1788658152485,
          coin: "INIT",
          side: "sell",
          sz: "218.0",
          dir: "Close Long",
          oid: 537236758712,
          ...close,
        }),
      ),
      ...[
        { sz: "3880.0", px: "0.068348", closedPnl: "27.28028", fee: "0.145854" },
        { sz: "1870.0", px: "0.068383", closedPnl: "13.21342", fee: "0.070331" },
        { sz: "5849.0", px: "0.068384", closedPnl: "41.334883", fee: "0.219987" },
        { sz: "2226.0", px: "0.068426", closedPnl: "15.824634", fee: "0.083773" },
        { sz: "5845.0", px: "0.068438", closedPnl: "41.622245", fee: "0.220011" },
        { sz: "199.0", px: "0.068439", closedPnl: "1.417278", fee: "0.007489" },
      ].map((close) =>
        fill({
          time: 1788669732938,
          coin: "INIT",
          side: "sell",
          dir: "Close Long",
          oid: 537337773359,
          ...close,
        }),
      ),
      fill({
        time: 1789054498748,
        coin: "INIT",
        side: "buy",
        px: "0.0669",
        sz: "21926.0",
        dir: "Open Long",
        oid: 541412230871,
      }),
    ];

    const target = closedPerpPositions(reduced).find(
      (row) => row.id === "INIT:537337773359:1788669732938",
    );

    expect(target?.side).not.toBe("short");
  });

  test("does not emit a run that is still open", () => {
    expect(closedPerpPositions([fill({ time: 1, dir: "Open Long" })])).toEqual([]);
  });

  test("scales in and out, averaging the close price by size", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" }),
      fill({ time: 2, side: "buy", sz: "1", px: "200", dir: "Open Long" }),
      fill({ time: 3, side: "sell", sz: "1", px: "300", dir: "Close Long", closedPnl: "200" }),
      fill({ time: 4, side: "sell", sz: "1", px: "100", dir: "Close Long", closedPnl: "-100" }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]?.sizeCoin).toBe(2);
    expect(closed[0]?.avgClosePx).toBe(200);
    expect(closed[0]?.realizedPnl).toBe(100);
    expect(closed[0]?.openedAt).toBe(1);
  });

  test("a short round-trip records the side that was held, not the closing side", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "sell", px: "100", dir: "Open Short" }),
      fill({ time: 2, side: "buy", px: "90", dir: "Close Short", closedPnl: "10" }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]?.side).toBe("short");
    expect(closed[0]?.realizedPnl).toBe(10);
  });

  test("does not let a Close Long fill consume an explicitly opened short", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "sell", dir: "Open Short" }),
      fill({ time: 2, side: "sell", dir: "Close Long", closedPnl: "99" }),
      fill({ time: 3, side: "buy", dir: "Close Short", closedPnl: "5" }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      side: "short",
      closedAt: 3,
      sizeCoin: 1,
      realizedPnl: 5,
    });
  });

  test("a flip closes the old run and opens a new one from the same fill", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" }),
      fill({ time: 2, side: "sell", sz: "2", px: "110", dir: "Long > Short", closedPnl: "10" }),
      fill({ time: 3, side: "buy", sz: "1", px: "105", dir: "Close Short", closedPnl: "5" }),
    ]);

    expect(closed).toHaveLength(2);
    const [newest, oldest] = closed;
    expect(oldest).toMatchObject({ side: "long", sizeCoin: 1, closedAt: 2, partial: false });
    expect(newest).toMatchObject({ side: "short", sizeCoin: 1, closedAt: 3, openedAt: 2 });
  });

  test("a Long > Short flip splits a known long into its short remainder", () => {
    const fills = [
      fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long", oid: 10 }),
      fill({
        time: 2,
        side: "sell",
        sz: "3",
        px: "110",
        dir: "Long > Short",
        closedPnl: "30",
        fee: "0.3",
        oid: 11,
      }),
      fill({
        time: 3,
        side: "buy",
        sz: "1",
        px: "100",
        dir: "Close Short",
        closedPnl: "10",
        fee: "0.1",
        oid: 12,
      }),
    ];

    expect(closedPerpPositions(fills)).toEqual([
      expect.objectContaining({
        side: "long",
        closedAt: 2,
        openedAt: 1,
        sizeCoin: 1,
        avgClosePx: 110,
        realizedPnl: 30,
        feeUsd: 0.3,
        partial: false,
      }),
    ]);
    expect(openPerpRealizedByCoin(fills, [{ coin: "BTC", side: "short", size: "1" }]).get(
      "BTC",
    )).toMatchObject({
      side: "short",
      signedSize: -1,
      openedAt: 2,
      realizedPnl: 10,
      feeUsd: 0.1,
    });
  });

  test("a Short > Long flip splits a known short into its long remainder", () => {
    const fills = [
      fill({ time: 1, side: "sell", sz: "1", px: "100", dir: "Open Short", oid: 20 }),
      fill({
        time: 2,
        side: "buy",
        sz: "4",
        px: "90",
        dir: "Short > Long",
        closedPnl: "24",
        fee: "0.4",
        oid: 21,
      }),
      fill({
        time: 3,
        side: "sell",
        sz: "1.5",
        px: "100",
        dir: "Close Long",
        closedPnl: "15",
        fee: "0.15",
        oid: 22,
      }),
    ];

    expect(closedPerpPositions(fills)).toEqual([
      expect.objectContaining({
        side: "short",
        closedAt: 2,
        openedAt: 1,
        sizeCoin: 1,
        avgClosePx: 90,
        realizedPnl: 24,
        feeUsd: 0.4,
        partial: false,
      }),
    ]);
    expect(openPerpRealizedByCoin(fills, [{ coin: "BTC", side: "long", size: "1.5" }]).get(
      "BTC",
    )).toMatchObject({
      side: "long",
      signedSize: 1.5,
      openedAt: 2,
      realizedPnl: 15,
      feeUsd: 0.15,
    });
  });

  test("a Long > Short prefix with an unknown split invents neither half", () => {
    const fills = [
      fill({
        time: 1,
        side: "sell",
        sz: "3",
        px: "110",
        dir: "Long > Short",
        closedPnl: "30",
        fee: "0.3",
      }),
    ];

    expect(closedPerpPositions(fills)).toEqual([]);
    expect(
      openPerpRealizedByCoin(fills, [{ coin: "BTC", side: "short", size: "3" }]).has("BTC"),
    ).toBe(false);
  });

  test("a Short > Long prefix with an unknown split invents neither half", () => {
    const fills = [
      fill({
        time: 1,
        side: "buy",
        sz: "4",
        px: "90",
        dir: "Short > Long",
        closedPnl: "24",
        fee: "0.4",
      }),
    ];

    expect(closedPerpPositions(fills)).toEqual([]);
    expect(
      openPerpRealizedByCoin(fills, [{ coin: "BTC", side: "long", size: "4" }]).has("BTC"),
    ).toBe(false);
  });

  test("a pending partial long survives an unknown Long > Short split", () => {
    const fills = [
      fill({
        time: 1,
        side: "sell",
        sz: "1",
        px: "105",
        dir: "Close Long",
        closedPnl: "10",
        fee: "0.1",
        oid: 31,
      }),
      fill({
        time: 2,
        side: "sell",
        sz: "3",
        px: "110",
        dir: "Long > Short",
        closedPnl: "30",
        fee: "0.3",
        oid: 32,
      }),
      fill({
        time: 3,
        side: "buy",
        sz: "1",
        px: "100",
        dir: "Close Short",
        closedPnl: "5",
        fee: "0.05",
        oid: 33,
      }),
    ];

    expect(closedPerpPositions(fills)).toEqual([
      expect.objectContaining({
        side: "short",
        closedAt: 3,
        sizeCoin: 1,
        avgClosePx: 100,
        realizedPnl: 5,
        feeUsd: 0.05,
        partial: true,
      }),
      expect.objectContaining({
        side: "long",
        closedAt: 2,
        sizeCoin: 1,
        avgClosePx: 105,
        realizedPnl: 40,
        feeUsd: 0.4,
        partial: true,
      }),
    ]);
    expect(
      openPerpRealizedByCoin(fills, [{ coin: "BTC", side: "short", size: "2" }]).has("BTC"),
    ).toBe(false);
  });

  test("a pending partial short survives an unknown Short > Long split", () => {
    const fills = [
      fill({
        time: 1,
        side: "buy",
        sz: "1",
        px: "95",
        dir: "Close Short",
        closedPnl: "10",
        fee: "0.1",
        oid: 41,
      }),
      fill({
        time: 2,
        side: "buy",
        sz: "4",
        px: "90",
        dir: "Short > Long",
        closedPnl: "30",
        fee: "0.3",
        oid: 42,
      }),
      fill({
        time: 3,
        side: "sell",
        sz: "1.5",
        px: "100",
        dir: "Close Long",
        closedPnl: "5",
        fee: "0.05",
        oid: 43,
      }),
    ];

    expect(closedPerpPositions(fills)).toEqual([
      expect.objectContaining({
        side: "long",
        closedAt: 3,
        sizeCoin: 1.5,
        avgClosePx: 100,
        realizedPnl: 5,
        feeUsd: 0.05,
        partial: true,
      }),
      expect.objectContaining({
        side: "short",
        closedAt: 2,
        sizeCoin: 1,
        avgClosePx: 95,
        realizedPnl: 40,
        feeUsd: 0.4,
        partial: true,
      }),
    ]);
    expect(
      openPerpRealizedByCoin(fills, [{ coin: "BTC", side: "long", size: "2.5" }]).has("BTC"),
    ).toBe(false);
  });

  test("a window that opens mid-position reports the run as partial", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "sell", sz: "2", px: "110", dir: "Close Long", closedPnl: "20" }),
      fill({ time: 2, side: "buy", sz: "1", px: "100", dir: "Open Long" }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      partial: true,
      openedAt: null,
      sizeCoin: 2,
      realizedPnl: 20,
      closedAt: 1,
    });
  });

  test("classifies the closing fill by the order type behind it", () => {
    const stopped = closedPerpPositions([
      fill({ time: 1, side: "buy", dir: "Open Long" }),
      fill({ time: 2, side: "sell", dir: "Close Long", orderType: "StopMarket" }),
    ]);
    expect(stopped[0]?.closedBy).toBe("stop_loss");

    const tookProfit = closedPerpPositions([
      fill({ time: 1, side: "buy", dir: "Open Long" }),
      fill({ time: 2, side: "sell", dir: "Close Long", orderType: "TakeProfitMarket" }),
    ]);
    expect(tookProfit[0]?.closedBy).toBe("take_profit");

    const manual = closedPerpPositions([
      fill({ time: 1, side: "buy", dir: "Open Long" }),
      fill({ time: 2, side: "sell", dir: "Close Long", orderType: "Market" }),
    ]);
    expect(manual[0]?.closedBy).toBe("manual");
  });

  test("a close we never placed reads as unknown, not manual", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "buy", dir: "Open Long" }),
      fill({ time: 2, side: "sell", dir: "Close Long", orderType: null }),
    ]);
    expect(closed[0]?.closedBy).toBe("unknown");
  });

  test("a liquidation outranks whatever order type is attached", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, side: "buy", dir: "Open Long" }),
      fill({ time: 2, side: "sell", dir: "Liquidated Cross Long", orderType: "Market" }),
    ]);
    expect(closed[0]?.closedBy).toBe("liquidation");
  });

  test("keeps coins independent and returns newest close first", () => {
    const closed = closedPerpPositions([
      fill({ time: 1, coin: "BTC", side: "buy", dir: "Open Long", oid: 1 }),
      fill({ time: 2, coin: "ETH", side: "buy", dir: "Open Long", oid: 2 }),
      fill({ time: 3, coin: "BTC", side: "sell", dir: "Close Long", oid: 3 }),
      fill({ time: 4, coin: "ETH", side: "sell", dir: "Close Long", oid: 4 }),
    ]);

    expect(closed.map((c) => c.coin)).toEqual(["ETH", "BTC"]);
  });

  test("ignores malformed rows rather than emitting a zero-size position", () => {
    const closed = closedPerpPositions([
      fill({ time: 0, side: "buy", dir: "Open Long" }),
      fill({ time: 1, side: "buy", sz: "0", dir: "Open Long" }),
      fill({ time: 2, side: "buy", sz: "not-a-number", dir: "Open Long" }),
    ]);
    expect(closed).toEqual([]);
  });

  test("ids are stable across repeated folds of the same fills", () => {
    const input = [
      fill({ time: 1, side: "buy", dir: "Open Long", oid: 11 }),
      fill({ time: 2, side: "sell", dir: "Close Long", oid: 12 }),
    ];
    expect(closedPerpPositions(input)[0]?.id).toBe(closedPerpPositions(input)[0]?.id ?? "");
    expect(closedPerpPositions(input)[0]?.id).toBe("BTC:12:2");
  });
});

describe("openPerpRealizedByCoin", () => {
  test("banks the realized PnL of a partial close onto the still-open position", () => {
    const open = openPerpRealizedByCoin(
      [
        fill({ time: 1, side: "buy", sz: "2", px: "100", dir: "Open Long" }),
        fill({
          time: 2,
          side: "sell",
          sz: "1",
          px: "150",
          dir: "Close Long",
          closedPnl: "50",
          fee: "0.2",
        }),
      ],
      [{ coin: "BTC", side: "long", size: "1" }],
    );

    expect(open.get("BTC")).toMatchObject({
      side: "long",
      signedSize: 1,
      openedAt: 1,
      realizedPnl: 50,
      feeUsd: 0.2,
    });
  });

  test("reports zero for a position that has never been partially closed", () => {
    const open = openPerpRealizedByCoin(
      [fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" })],
      [{ coin: "BTC", side: "long", size: "1" }],
    );

    expect(open.get("BTC")?.realizedPnl).toBe(0);
  });

  test("omits a coin whose replayed size disagrees with the live position", () => {
    // The window only shows a 1-unit scale-in; the venue holds 3, so the
    // opening fills fell outside it and the replayed PnL would understate.
    const open = openPerpRealizedByCoin(
      [fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" })],
      [{ coin: "BTC", side: "long", size: "3" }],
    );

    expect(open.has("BTC")).toBe(false);
  });

  test("omits a coin whose replayed side disagrees with the live position", () => {
    const open = openPerpRealizedByCoin(
      [fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" })],
      [{ coin: "BTC", side: "short", size: "1" }],
    );

    expect(open.has("BTC")).toBe(false);
  });

  test("does not carry realized PnL from a previous round-trip into the new one", () => {
    const open = openPerpRealizedByCoin(
      [
        fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" }),
        fill({
          time: 2,
          side: "sell",
          sz: "1",
          px: "200",
          dir: "Close Long",
          closedPnl: "100",
        }),
        fill({ time: 3, side: "buy", sz: "1", px: "150", dir: "Open Long" }),
      ],
      [{ coin: "BTC", side: "long", size: "1" }],
    );

    expect(open.get("BTC")?.realizedPnl).toBe(0);
    expect(open.get("BTC")?.openedAt).toBe(3);
  });

  test("a flip starts the new run's realized PnL from zero", () => {
    const open = openPerpRealizedByCoin(
      [
        fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" }),
        fill({
          time: 2,
          side: "sell",
          sz: "2",
          px: "200",
          dir: "Long > Short",
          closedPnl: "100",
        }),
      ],
      [{ coin: "BTC", side: "short", size: "1" }],
    );

    expect(open.get("BTC")).toMatchObject({
      side: "short",
      signedSize: -1,
      openedAt: 2,
      realizedPnl: 0,
    });
  });

  test("ignores coins with no fills at all", () => {
    const open = openPerpRealizedByCoin([], [{ coin: "ETH", side: "long", size: "1" }]);
    expect(open.size).toBe(0);
  });

  test("still emits closed round-trips unchanged alongside the open run", () => {
    const fills = [
      fill({ time: 1, side: "buy", sz: "1", px: "100", dir: "Open Long" }),
      fill({ time: 2, side: "sell", sz: "1", px: "200", dir: "Close Long", closedPnl: "100" }),
      fill({ time: 3, side: "buy", sz: "1", px: "150", dir: "Open Long" }),
    ];

    expect(closedPerpPositions(fills)).toHaveLength(1);
    expect(closedPerpPositions(fills)[0]?.realizedPnl).toBe(100);
  });
});
