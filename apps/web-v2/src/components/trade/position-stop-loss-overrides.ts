type StopLossOrderLike = {
  id: string;
  stopPrice: number;
};

type PositionWithStopLossOrders = {
  stopLossOrders: StopLossOrderLike[];
};

export function applyStopPriceOverrides<TPosition extends PositionWithStopLossOrders>(
  positions: TPosition[],
  overrides: Record<string, number>
) {
  if (Object.keys(overrides).length === 0) return positions;

  return positions.map((position) => ({
    ...position,
    stopLossOrders: position.stopLossOrders.map((order) => {
      const optimisticStopPrice = overrides[order.id];
      return optimisticStopPrice === undefined
        ? order
        : { ...order, stopPrice: optimisticStopPrice };
    }),
  }));
}

export function updateStopPriceInPositions<TPosition extends PositionWithStopLossOrders>(
  positions: TPosition[] | undefined,
  stopOrderId: string,
  stopPrice: number
) {
  if (!positions) return positions;
  return applyStopPriceOverrides(positions, { [stopOrderId]: stopPrice });
}
