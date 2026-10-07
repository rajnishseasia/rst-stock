import {
  INVALID_CURRENT_MARKET_PRICE_ERROR,
  isValidMarketPrice,
  type StockPositionSide,
} from "./stop-loss-input";
import { resolveStopLossSave, type StopLossSaveResult } from "./stop-loss-save";

export type StockExitPosition = {
  side: StockPositionSide;
  currentPrice: number | null | undefined;
};

export type TakeProfitSaveResult =
  | { success: true; value: number }
  | { success: false; error: string };

export type StopLossEditVariables = {
  credentialId?: string;
  stopOrderId: string;
  stopPrice: number;
};

export type TakeProfitEditVariables = {
  credentialId?: string;
  tpOrderId: string;
  limitPrice: number;
};

export function parseTakeProfitInput(rawValue: string): TakeProfitSaveResult {
  const trimmed = rawValue.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    return { success: false, error: "Enter a valid price" };
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { success: false, error: "Enter a valid price" };
  }

  return { success: true, value };
}

export function resolveTakeProfitSave(
  rawValue: string,
  position: StockExitPosition
): TakeProfitSaveResult {
  const parsed = parseTakeProfitInput(rawValue);
  if (!parsed.success) return parsed;

  if (!isValidMarketPrice(position.currentPrice)) {
    return { success: false, error: INVALID_CURRENT_MARKET_PRICE_ERROR };
  }
  if (position.side === "long" && parsed.value <= position.currentPrice) {
    return {
      success: false,
      error: "Take profit must be above current price for a long",
    };
  }
  if (position.side === "short" && parsed.value >= position.currentPrice) {
    return {
      success: false,
      error: "Take profit must be below current price for a short",
    };
  }

  return parsed;
}

export function dispatchStopLossSave(
  rawValue: string,
  position: StockExitPosition,
  dispatch: (stopPrice: number) => void
): StopLossSaveResult {
  const currentPrice = isValidMarketPrice(position.currentPrice)
    ? position.currentPrice
    : Number.NaN;
  const result = resolveStopLossSave(rawValue, {
    side: position.side,
    currentPrice,
  });
  if (result.success) dispatch(result.value);
  return result;
}

export function dispatchStopLossEdit(
  input: StockExitPosition & {
    rawValue: string;
    credentialId?: string;
    stopOrderId: string;
  },
  dispatch: (variables: StopLossEditVariables) => void
): StopLossSaveResult {
  return dispatchStopLossSave(input.rawValue, input, (stopPrice) => {
    dispatch({
      credentialId: input.credentialId,
      stopOrderId: input.stopOrderId,
      stopPrice,
    });
  });
}

export function dispatchTakeProfitSave(
  rawValue: string,
  position: StockExitPosition,
  dispatch: (limitPrice: number) => void
): TakeProfitSaveResult {
  const result = resolveTakeProfitSave(rawValue, position);
  if (result.success) dispatch(result.value);
  return result;
}

export function dispatchTakeProfitEdit(
  input: StockExitPosition & {
    rawValue: string;
    credentialId?: string;
    tpOrderId: string;
  },
  dispatch: (variables: TakeProfitEditVariables) => void
): TakeProfitSaveResult {
  return dispatchTakeProfitSave(input.rawValue, input, (limitPrice) => {
    dispatch({
      credentialId: input.credentialId,
      tpOrderId: input.tpOrderId,
      limitPrice,
    });
  });
}
