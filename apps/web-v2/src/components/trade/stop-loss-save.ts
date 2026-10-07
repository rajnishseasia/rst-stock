import {
  normalizeStopLossInput,
  validateStopLossDirection,
} from "./stop-loss-input";

export type StopLossSaveResult =
  | { success: true; value: number; echoValue?: string }
  | { success: false; error: string; echoValue?: string };

/**
 * Shared input props for every stop-loss price field (the "edit an existing
 * stop" input and the "add a new stop" input in positions-panel.tsx). Both
 * fields must stay `type="text"` with a decimal-friendly mobile keypad, NOT
 * `type="number"`: a native number input rejects the money formatting (`$`,
 * stray spaces, repeated `.`) that `normalizeStopLossInput` is specifically
 * built to tolerate, so switching either field to `type="number"` would make
 * that tolerance unreachable from the UI even though the validator still
 * accepts it.
 */
export const STOP_LOSS_PRICE_INPUT_PROPS = {
  type: "text",
  inputMode: "decimal",
} as const;

/**
 * Full validation pipeline for a stop-loss price the user just typed:
 * normalize the raw text (accepts money formatting, sanitizes repeated
 * decimals, rejects garbage - see `normalizeStopLossInput`), then check the
 * result sits on the correct side of the live price for the position's
 * direction (`validateStopLossDirection`). Both the "edit an existing
 * stop-loss" and "add a new stop-loss" forms in positions-panel.tsx run a
 * user's draft price through this exact pipeline before submitting it, so
 * this is the single place that decides whether a save goes through.
 *
 * `echoValue` carries a cleaned-up display string whenever normalization
 * sanitized or rounded the raw input, regardless of whether the direction
 * check that follows passes. Callers echo it back into the draft field so a
 * direction error is shown against the CLEAN number, not the raw text the
 * user typed.
 */
export function resolveStopLossSave(
  rawValue: string,
  position: { side: "long" | "short"; currentPrice: number }
): StopLossSaveResult {
  const normalized = normalizeStopLossInput(rawValue);
  if (!normalized.success) {
    return { success: false, error: normalized.error };
  }

  const echoValue =
    normalized.wasRoundedUp || normalized.wasSanitized
      ? normalized.displayValue
      : undefined;

  const directionError = validateStopLossDirection(
    normalized.value,
    position.side,
    position.currentPrice
  );
  if (directionError) {
    return { success: false, error: directionError, echoValue };
  }

  return { success: true, value: normalized.value, echoValue };
}
