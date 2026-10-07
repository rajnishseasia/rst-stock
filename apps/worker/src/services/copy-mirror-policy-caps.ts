/** Shared policy-cap arithmetic for both the Alpaca and Hyperliquid workers. */

export type MirrorCapResolution =
  | { ok: true; value: number | null }
  | { ok: false };

/** Resolve staged/current nullable caps without ever widening a persisted cap. */
export function resolveEffectiveMirrorCap(
  staged: unknown,
  current: unknown,
): MirrorCapResolution {
  const parse = (value: unknown): number | null | undefined => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  };
  const stagedCap = parse(staged);
  const currentCap = parse(current);
  if (stagedCap === undefined || currentCap === undefined) return { ok: false };
  if (stagedCap === null) return { ok: true, value: currentCap };
  if (currentCap === null) return { ok: true, value: stagedCap };
  return { ok: true, value: Math.min(stagedCap, currentCap) };
}

/** Return whether a requested quantity fits under a total coin/exposure cap. */
export function mirrorCoinCapAllows(input: {
  currentExposure: number;
  requestedExposure: number;
  maxCoinSize: number | null;
}): boolean {
  const { currentExposure, requestedExposure, maxCoinSize } = input;
  if (maxCoinSize === null) return true;
  return Number.isFinite(maxCoinSize) &&
    maxCoinSize > 0 &&
    Number.isFinite(currentExposure) &&
    currentExposure >= 0 &&
    Number.isFinite(requestedExposure) &&
    requestedExposure >= 0 &&
    currentExposure + requestedExposure <= maxCoinSize;
}
