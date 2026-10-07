/**
 * Durable lease markers for one copy-mirror Hyperliquid placement attempt.
 *
 * The orders table has no dedicated claim-token column. `sync_reason` is an
 * existing durable text column, so the placement path stores a UUID in a
 * namespaced value there and compares that exact value while the user/order
 * row lock is held. The un-suffixed value is retained as a legacy marker: it
 * is treated as an active, owner-unknown lease while fresh and can only be
 * reclaimed after it expires.
 */

export const PERP_PLACEMENT_ATTEMPT_SYNC_REASON = "copy-mirror:perp-placement";
export const PERP_PLACEMENT_ATTEMPT_SYNC_REASON_PREFIX =
  `${PERP_PLACEMENT_ATTEMPT_SYNC_REASON}:`;
export const PERP_PLACEMENT_ATTEMPT_LEASE_MS = 5 * 60_000;
/** A bad future clock must not wedge a row forever. */
export const PERP_PLACEMENT_MAX_FUTURE_SKEW_MS = 2 * 60_000;

export function perpPlacementLeaseReason(claimToken: string): string {
  return `${PERP_PLACEMENT_ATTEMPT_SYNC_REASON_PREFIX}${claimToken}`;
}

/** True for the legacy marker and for a token-bearing placement marker. */
export function isPerpPlacementLeaseReason(value: unknown): value is string {
  return value === PERP_PLACEMENT_ATTEMPT_SYNC_REASON ||
    (typeof value === "string" && value.startsWith(PERP_PLACEMENT_ATTEMPT_SYNC_REASON_PREFIX) &&
      value.length > PERP_PLACEMENT_ATTEMPT_SYNC_REASON_PREFIX.length);
}

/** A fresh marker blocks absence-based reconciliation. */
export function isPerpPlacementLeaseActive(
  reason: unknown,
  attemptAt: Date | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!isPerpPlacementLeaseReason(reason) || !attemptAt) return false;
  const age = nowMs - attemptAt.getTime();
  // A clock-skewed future timestamp still belongs to the current owner. Treat
  // it as active for a bounded skew; a wildly bad timestamp is quarantined so
  // it cannot wedge the row forever, while never reclaiming a recent claim.
  return age < PERP_PLACEMENT_ATTEMPT_LEASE_MS &&
    age > -PERP_PLACEMENT_MAX_FUTURE_SKEW_MS;
}

export type PerpPlacementLeaseState = "inactive" | "active" | "future" | "quarantined";

export function perpPlacementLeaseState(
  reason: unknown,
  attemptAt: Date | null | undefined,
  nowMs = Date.now(),
): PerpPlacementLeaseState {
  if (!isPerpPlacementLeaseReason(reason) || !attemptAt) return "inactive";
  const age = nowMs - attemptAt.getTime();
  if (age < -PERP_PLACEMENT_MAX_FUTURE_SKEW_MS) return "quarantined";
  if (age < 0) return "future";
  if (age < PERP_PLACEMENT_ATTEMPT_LEASE_MS) return "active";
  return "inactive";
}
