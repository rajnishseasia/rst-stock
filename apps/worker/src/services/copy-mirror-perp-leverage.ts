/**
 * Resolve the leverage for one automatic perp mirror.
 *
 * Every value that can cap an open is normalized independently. An unusable
 * required value fails down to the least leveraged result, `1x`; an absent
 * follow override means that follow inherits its corresponding global cap.
 * Keeping this policy pure lets fresh and resumed orders share exactly the same
 * risk calculation without giving deployment configuration authority over a
 * user's exposure.
 */

import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";

/** Normalize source, venue, and persisted-order leverage independently. */
function normalizePositiveLeverage(value: unknown): number {
  let numeric: number;
  try {
    numeric = Number(value);
  } catch {
    return 1;
  }
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.max(1, Math.floor(numeric));
}

/**
 * Normalize a user-owned policy value against the product contract. Policy
 * rows are integer caps in the shared 1..100 range; an unusable row fails down
 * to the least-leveraged result rather than being treated as an unbounded cap.
 * Keep this separate from source/venue/stored normalization: those values are
 * independent ceilings and are not product-setting inputs.
 */
function normalizePolicyLeverage(value: unknown): number {
  let numeric: number;
  try {
    numeric = Number(value);
  } catch {
    return COPY_PERP_MAX_LEVERAGE_MIN;
  }
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return COPY_PERP_MAX_LEVERAGE_MIN;
  }

  const integer = Math.floor(numeric);
  if (
    integer < COPY_PERP_MAX_LEVERAGE_MIN ||
    integer > COPY_PERP_MAX_LEVERAGE_MAX
  ) {
    return COPY_PERP_MAX_LEVERAGE_MIN;
  }
  return integer;
}

function normalizeFollowCap(value: unknown | null | undefined): number | null {
  return value === null || value === undefined ? null : normalizePolicyLeverage(value);
}

export function resolveEffectivePerpLeverage(input: {
  sourceLeverage: unknown;
  stagedUserMaxLeverage: unknown;
  stagedFollowMaxLeverage: unknown | null | undefined;
  currentUserMaxLeverage: unknown;
  currentFollowMaxLeverage: unknown | null | undefined;
  venueMaxLeverage: unknown;
  storedOrderLeverage?: unknown;
}): number {
  const ceilings = [
    normalizePositiveLeverage(input.sourceLeverage),
    normalizePolicyLeverage(input.stagedUserMaxLeverage),
    normalizePolicyLeverage(input.currentUserMaxLeverage),
    normalizePositiveLeverage(input.venueMaxLeverage),
  ];

  const stagedFollow = normalizeFollowCap(input.stagedFollowMaxLeverage);
  if (stagedFollow !== null) ceilings.push(stagedFollow);

  const currentFollow = normalizeFollowCap(input.currentFollowMaxLeverage);
  if (currentFollow !== null) ceilings.push(currentFollow);

  // An omitted stored leverage means this is a fresh candidate. When present,
  // even an invalid value is a 1x ceiling so a malformed persisted intent can
  // never be raised by the current policy.
  if (input.storedOrderLeverage !== undefined) {
    ceilings.push(normalizePositiveLeverage(input.storedOrderLeverage));
  }

  return Math.min(...ceilings);
}
