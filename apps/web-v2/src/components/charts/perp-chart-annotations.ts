import type { ApiExecutionGroup } from "./tv-datafeed";

export interface PerpFillAnnotationInput {
  time: number;
  coin: string;
  side: "buy" | "sell";
  px: string;
  sz: string;
  dir: string;
  oid: number;
  tid: number;
  hash: string;
}

/** Map recent HL fills for one canonical coin into TradingView B/S bubbles. */
export function perpFillsForChart(
  fills: readonly PerpFillAnnotationInput[],
  chartCoin: string,
): ApiExecutionGroup[] {
  const canonical = chartCoin.trim().toUpperCase();
  return fills.flatMap((fill) => {
    if (fill.coin.trim().toUpperCase() !== canonical) return [];
    const anchorPrice = Number(fill.px);
    const quantity = Number(fill.sz);
    if (
      !Number.isFinite(fill.time) ||
      fill.time <= 0 ||
      !Number.isFinite(anchorPrice) ||
      anchorPrice <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return [];
    }
    return [
      {
        id: `perp:${fill.hash}:${fill.tid}`,
        anchorTime: Math.floor(fill.time / 1000),
        anchorPrice,
        side: fill.side === "buy" ? "BUY" : "SELL",
        quantity,
        orderType: "Perp",
        tradeAction: fill.dir,
      },
    ];
  });
}
