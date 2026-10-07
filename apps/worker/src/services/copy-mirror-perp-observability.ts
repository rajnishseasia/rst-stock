/**
 * PURE observability vocabulary for the Hyperliquid copy-mirror path.
 *
 * Split out of `copy-mirror.ts` (audit H7) so the log shape an operator reads
 * during an incident is unit-testable without a poller, a DB or a venue client.
 * No IO here: every function maps inputs to a message, a level and a stable
 * reason string that the caller hands to the logger.
 *
 * Three blind spots motivated this module.
 *
 *  1. THE PERP PLACEMENT PATH WAS SILENT. `placePerpMirrorOrder` could return
 *     placed / duplicate / syncing / rejected without a single log line on the
 *     success paths, while the equity path logged "PLACED mirror order" for
 *     every fill. Two of the three perp call sites also had no intent line, so
 *     a leveraged order could reach Hyperliquid with nothing in the log before
 *     or after it. Reconstructing what the worker did then meant diffing the
 *     orders table against the venue.
 *
 *  2. TWO DIFFERENT CONFIG FAULTS LOOKED IDENTICAL. "the perps flag is off"
 *     and "HYPERLIQUID_NETWORK was never set, so the venue package would have
 *     defaulted to MAINNET" both returned the outcome string "perps-disabled"
 *     with no log at all. The first is a deliberate operator choice; the second
 *     is a misconfiguration on a real-money deployment, and an operator staring
 *     at a stalled mirror could not tell which one they had.
 *
 *  3. PERP MIRRORING DEPENDS ON A SECOND POLLER. Mirrored fill sizes and the
 *     fate of any PENDING perp order are written only by the
 *     HyperliquidOrderSyncPoller, which runs by DEFAULT and stops only when
 *     HYPERLIQUID_SYNC_ENABLED is exactly "false". Perps opted in with the
 *     reconciler deliberately switched off is a refusal, decided by
 *     `copy-mirror-perp-sync-gate.ts`.
 *     This module only supplies the per-candidate line for it, so the refusal
 *     does not masquerade as "the perps opt-in flag is off".
 *
 * Nothing here changes whether an order is placed. It changes only what an
 * operator can see.
 */

export type PerpPlacementIntent = "open" | "resume" | "close";

/** The outcomes `placePerpMirrorOrder` can return. */
export type PerpPlacementOutcome = "placed" | "duplicate" | "syncing" | "rejected";

export type LogLevel = "info" | "warn" | "error";

export interface PerpLogLine {
  level: LogLevel;
  message: string;
}

const INTENT_MESSAGE: Record<PerpPlacementIntent, string> = {
  // Deliberately loud and uniform: these three lines are the only warning that
  // a leveraged order is about to be sent on someone's behalf.
  open: "[copy-mirror] PLACING Hyperliquid perp mirror (open)",
  resume: "[copy-mirror] PLACING Hyperliquid perp mirror (resume of a PENDING row)",
  close: "[copy-mirror] PLACING Hyperliquid perp mirror (reduce-only close)",
};

/** The single line emitted immediately before any Hyperliquid order submission. */
export function describePerpPlacementIntent(intent: PerpPlacementIntent): PerpLogLine {
  return { level: "warn", message: INTENT_MESSAGE[intent] };
}

const OUTCOME_LINE: Record<PerpPlacementOutcome, PerpLogLine> = {
  // Mirrors the equity path's "PLACED mirror order" so both venues can be read
  // with one query.
  placed: { level: "warn", message: "[copy-mirror] PLACED Hyperliquid perp mirror" },
  duplicate: {
    level: "info",
    message: "[copy-mirror] perp mirror not sent: this source trade is already recorded",
  },
  // Not an error in itself, but it means the local row's fate is now owned by
  // the Hyperliquid reconciler rather than by this worker.
  syncing: {
    level: "warn",
    message: "[copy-mirror] perp mirror left for the Hyperliquid reconciler",
  },
  rejected: {
    level: "warn",
    message: "[copy-mirror] perp mirror rejected by Hyperliquid, no exposure opened",
  },
};

/** The single line emitted on every `placePerpMirrorOrder` return path. */
export function describePerpPlacementOutcome(outcome: PerpPlacementOutcome): PerpLogLine {
  return OUTCOME_LINE[outcome];
}

export type PerpConfigFaultOutcome =
  | "perps-disabled"
  | "perps-sync-disabled"
  | "perps-network-unset";

export interface PerpConfigFault extends PerpLogLine {
  outcome: PerpConfigFaultOutcome;
  /**
   * The env var an operator has to look at. NAME only: this module never
   * carries a config value into a log line.
   */
  envVar: string;
}

/**
 * Tell the three perp config faults apart.
 *
 * `perpsEnabled` is the RAW opt-in flag (the operator meant to keep perps off).
 * `reconcilerEnabled` is whether the reconciler is running (it runs unless
 * HYPERLIQUID_SYNC_ENABLED is exactly "false"), the precondition enforced by
 * `copy-mirror-perp-sync-gate.ts`: perps asked for with the reconciler
 * deliberately switched off is a refusal, and it must not be reported as "the
 * opt-in flag is off" because the operator did set that flag and would go
 * looking at the wrong variable.
 * `networkExplicit` is whether HYPERLIQUID_NETWORK was actually set to a value
 * this worker accepts. The venue package defaults an unset network to MAINNET,
 * so an unset one is not a milder version of "disabled": it is the case where
 * the deployment cannot prove which chain it would have traded on, and the safe
 * assumption is the real-money one. Returns null when no fault applies.
 */
export function describePerpConfigFault(input: {
  perpsEnabled: boolean;
  reconcilerEnabled: boolean;
  networkExplicit: boolean;
}): PerpConfigFault | null {
  if (!input.perpsEnabled) {
    return {
      outcome: "perps-disabled",
      level: "info",
      message: "[copy-mirror] skip perp: the perps opt-in flag is off",
      envVar: "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED",
    };
  }
  if (!input.reconcilerEnabled) {
    return {
      outcome: "perps-sync-disabled",
      level: "warn",
      message:
        "[copy-mirror] skip perp: perps are opted in but HYPERLIQUID_SYNC_ENABLED=false, so the Hyperliquid reconciler that sizes and resolves mirrored perp orders has been switched off",
      envVar: "HYPERLIQUID_SYNC_ENABLED",
    };
  }
  if (!input.networkExplicit) {
    return {
      outcome: "perps-network-unset",
      level: "warn",
      message:
        "[copy-mirror] skip perp: perps are enabled but the Hyperliquid network is not explicitly configured, which would default to mainnet",
      envVar: "HYPERLIQUID_NETWORK",
    };
  }
  return null;
}

// The former `assessPerpAutoMirrorReadiness` lived here and only produced a
// startup warning for "perps on, reconciler off". A warning was the wrong
// instrument: that combination can open leveraged positions the worker can
// neither size a close for nor ever reconcile. It is now a hard precondition
// owned by `copy-mirror-perp-sync-gate.ts`, which refuses perp mirroring
// outright instead of describing it.
