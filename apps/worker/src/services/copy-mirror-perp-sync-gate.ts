/**
 * PRECONDITION GATE: perp auto-mirroring requires the Hyperliquid reconciler.
 *
 * Split out of `copy-mirror.ts` (audit H7) so the gate is pure and unit-testable
 * without a poller, a DB or a venue client. No IO here: every function maps an
 * env snapshot to a decision and, when the decision is a refusal, to the exact
 * line an operator needs.
 *
 * WHY THIS IS A GATE AND NOT A WARNING
 *
 * The Hyperliquid reconciler (HyperliquidOrderSyncPoller) runs by DEFAULT and
 * stops only when an operator sets HYPERLIQUID_SYNC_ENABLED=false. So in normal
 * operation this gate is open and invisible; it is not a second switch anyone
 * has to find and set. It exists for exactly one situation: somebody killed the
 * reconciler on purpose, and perp mirroring must not keep running without it.
 *
 * Perp auto-mirroring is not merely degraded without the reconciler, it is
 * unsafe in two separate ways:
 *
 *  1. CLOSES CANNOT BE SIZED. Percent and dollar sized perp closes derive their
 *     size from `orders.executed_size_decimal`, and the reconciler is the ONLY
 *     writer of that column. With it off, an exit instruction resolves to a
 *     terminal no-qty: the instruction is consumed and the follower stays in a
 *     leveraged position.
 *
 *  2. POSSIBLY-LIVE ORDERS ARE NEVER RESOLVED. The perp rejection rules
 *     deliberately never write REJECTED over an order that may have reached the
 *     venue; every uncertain branch instead leaves the row PENDING and defers to
 *     the reconciler. That argument only holds while the reconciler exists. With
 *     it off, those rows are parked at PENDING forever and no process ever
 *     compares them against Hyperliquid.
 *
 * So while the reconciler is switched off, perp mirroring MUST NOT RUN. Fail
 * closed: a missed mirror is safe, an unreconcilable leveraged order is not.
 * Stock/option mirroring is untouched by this gate.
 *
 * This module never enables anything. It can only refuse.
 */

/** The perps opt-in an operator sets. Named in every refusal line. */
export const PERPS_AUTOMIRROR_ENV_VAR = "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED";

/**
 * The reconciler kill switch this gate depends on. Named in every refusal line.
 *
 * The predicate below is intentionally the same opt-OUT rule as
 * `isHyperliquidSyncEnabled` in `hyperliquid-order-sync.ts`: enabled unless the
 * value is exactly "false". It is duplicated rather than imported so this module
 * stays free of DB and venue imports; a test asserts the two agree across the
 * whole value matrix, which is what stops this gate from ever refusing while the
 * reconciler is in fact running (or vice versa).
 */
export const HYPERLIQUID_SYNC_ENV_VAR = "HYPERLIQUID_SYNC_ENABLED";

export interface PerpSyncGateRefusal {
  level: "error";
  message: string;
  /** Both names, so an operator knows exactly what to set. Names only, never values. */
  envVars: readonly [string, string];
}

export interface PerpSyncGateDecision {
  /** COPY_TRADE_AUTOMIRROR_PERPS_ENABLED === "true". */
  perpsFlagSet: boolean;
  /** HYPERLIQUID_SYNC_ENABLED !== "false", i.e. the reconciler was not killed. */
  reconcilerEnabled: boolean;
  /** The only thing callers should branch on: may this worker mirror perps at all? */
  perpMirroringAllowed: boolean;
  /** Present only when the operator asked for perps and the precondition is missing. */
  refusal: PerpSyncGateRefusal | null;
}

/** The raw perps opt-in, WITHOUT the reconciler precondition applied. */
export function readPerpsAutoMirrorFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PERPS_AUTOMIRROR_ENV_VAR] === "true";
}

/** Whether the Hyperliquid reconciler is running. Defaults ON; only "false" stops it. */
export function isPerpReconcilerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HYPERLIQUID_SYNC_ENV_VAR] !== "false";
}

const REFUSAL_MESSAGE =
  `[copy-mirror] REFUSING to mirror perps: ${PERPS_AUTOMIRROR_ENV_VAR} is "true" but the ` +
  `Hyperliquid reconciler has been switched off with ${HYPERLIQUID_SYNC_ENV_VAR}=false. ` +
  "That reconciler is the only writer of mirrored fill sizes and the only process that ever " +
  "resolves a PENDING perp order against the venue, so without it a mirrored perp could be " +
  "opened and then never reconciled or sized. Either remove that override so reconciliation " +
  `resumes, or turn ${PERPS_AUTOMIRROR_ENV_VAR} off too. Stock and option mirroring are ` +
  "unaffected.";

/**
 * Evaluate the gate against an env snapshot.
 *
 * `perpMirroringAllowed` is true only when the operator opted into perps AND the
 * reconciler is on. Every other combination refuses, and the refusal line is
 * populated only for the case an operator actually needs to act on (perps asked
 * for, reconciler missing). Perps simply being off is not a fault.
 */
export function evaluatePerpSyncGate(
  env: NodeJS.ProcessEnv = process.env,
): PerpSyncGateDecision {
  const perpsFlagSet = readPerpsAutoMirrorFlag(env);
  const reconcilerEnabled = isPerpReconcilerEnabled(env);
  const perpMirroringAllowed = perpsFlagSet && reconcilerEnabled;
  const refusal: PerpSyncGateRefusal | null =
    perpsFlagSet && !reconcilerEnabled
      ? {
          level: "error",
          message: REFUSAL_MESSAGE,
          envVars: [PERPS_AUTOMIRROR_ENV_VAR, HYPERLIQUID_SYNC_ENV_VAR] as const,
        }
      : null;
  return { perpsFlagSet, reconcilerEnabled, perpMirroringAllowed, refusal };
}

let refusalAnnounced = false;

/**
 * Return the refusal line the FIRST time the gate is closed, then null.
 *
 * The refusal is a deployment-level fact, not a per-candidate one, so it is
 * announced once and loudly instead of once per mirror attempt. Per-candidate
 * skips are logged separately by the caller at their own level.
 */
/**
 * Separate opt-in: the master switch alone can never enable leveraged perps.
 *
 * The opt-in flag is necessary but NOT sufficient. Perp mirroring also requires
 * the Hyperliquid reconciler, which is on by default and is the only writer of
 * mirrored fill sizes and the only process that ever resolves a PENDING perp
 * order against the venue. In a normal deployment this second condition is
 * already satisfied and costs the operator nothing; it bites only if somebody
 * set HYPERLIQUID_SYNC_ENABLED=false. Both conditions live in
 * `evaluatePerpSyncGate`, so every perp call site is gated by consulting this
 * one function. Use `readPerpsAutoMirrorFlag` when you need the raw flag (for
 * telling the two refusals apart in a log line), never to decide whether to
 * place an order.
 */
export function isPerpsAutoMirrorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return evaluatePerpSyncGate(env).perpMirroringAllowed;
}

export function takePerpSyncGateRefusal(
  env: NodeJS.ProcessEnv = process.env,
): PerpSyncGateRefusal | null {
  const { refusal } = evaluatePerpSyncGate(env);
  if (!refusal || refusalAnnounced) return null;
  refusalAnnounced = true;
  return refusal;
}

/** Test-only: clear the announce-once latch. */
export function resetPerpSyncGateAnnouncement(): void {
  refusalAnnounced = false;
}
