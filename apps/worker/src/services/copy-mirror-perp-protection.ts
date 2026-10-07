/**
 * Take-profit and stop-loss protection resolved for one mirrored perp.
 *
 * PURE. No database, no venue, no env: everything is supplied by the caller so
 * the arithmetic that decides where a follower's money stops can be read and
 * tested on its own, the same way `copy-mirror-perp-decisions.ts` treats sizing.
 *
 * WHY THIS EXISTS. A mirror needs the leader's initial stop and target to carry
 * across with the entry. A follower can explicitly replace those prices with
 * their own ROE rule, and signal-only sources with no protection may still use
 * that follower rule.
 *
 * IT IS A SAFETY NET, NOT THE EXIT. When the source does close and that close is
 * mirrored, the source wins and these legs are retired with it (see
 * `perpProtectionCancelPlan`). They exist for the positions nothing else will
 * ever close.
 *
 * THE BASIS IS MARGIN, NOT PRICE. See PERP_PROTECTION_BOUNDS in
 * packages/types for the full argument. In short: the follower does not choose
 * the leverage, so the only reading of "stop me out at 25%" that means the same
 * risk at 1x and at 20x is 25% of the margin.
 */

import {
  buildTpSlLegs,
  isPerpDexCovered,
  toCloid,
  type HyperliquidClient,
  type PerpSide,
} from "@trade-bot/hyperliquid";
import { PERP_PROTECTION_BOUNDS } from "@trade-bot/types";
import type { PerpProtectionPlan } from "@trade-bot/db";
import { catchError } from "@trade-bot/utils";

import { minDecimal, parsePositiveDecimal } from "./copy-mirror-perp-decimal";

/**
 * Scale the leg size is compared and truncated at, matching the (24,8) the
 * orders table stores perp sizes at. A size that has been through a float is a
 * size the venue may round into a different order than the one that was
 * approved, so the comparison stays in fixed point.
 */
const PERP_PROTECTION_SIZE_SCALE = 8;

/**
 * A protection rule from either the follow or the source opening order.
 *
 * Follow rules use positive ROE magnitudes. Source rules use absolute trigger
 * prices with both ROE fields null. A rule never mixes the two representations.
 */
export interface PerpProtectionRule {
  takeProfitRoePct: number | null;
  stopLossRoePct: number | null;
  /** Absolute initial source triggers, used when the follower has no override. */
  takeProfitPx?: string;
  stopLossPx?: string;
}

/** The two `copy_trade_follows` columns this reads, as pg returns them. */
export interface PerpProtectionRuleRow {
  perpTakeProfitPct?: string | null;
  perpStopLossPct?: string | null;
}

/**
 * Read a follow row's configured exit, or null when there is nothing to attach.
 *
 * FAIL-QUIET ON A LEG, NEVER ON THE ORDER. A value that is missing, unparseable
 * or outside the bounds the API enforces drops that ONE leg and leaves the other
 * standing. The alternative (refusing the whole mirror) would turn a bad number
 * in a settings column into a reason the follower's copy trade never happens,
 * which is a far larger surprise than losing a stop they can see is missing.
 *
 * Out-of-bounds values are dropped rather than clamped. Clamping would place a
 * stop at a price the follower never chose and then report it as theirs; the
 * numbers here decide where real money exits, so an uninterpretable one is
 * refused rather than guessed at. The API validates on the way in, so this only
 * fires on a row written before those bounds existed or edited outside the app.
 */
export function parsePerpProtectionRule(
  row: PerpProtectionRuleRow | null | undefined,
): PerpProtectionRule | null {
  if (!row) return null;
  const takeProfitRoePct = boundedPct(row.perpTakeProfitPct, PERP_PROTECTION_BOUNDS.takeProfitPct);
  const stopLossRoePct = boundedPct(row.perpStopLossPct, PERP_PROTECTION_BOUNDS.stopLossPct);
  if (takeProfitRoePct === null && stopLossRoePct === null) return null;
  return { takeProfitRoePct, stopLossRoePct };
}

/** Read the immutable initial prices recorded on a source opening order. */
export function parseSourcePerpProtectionRule(input: {
  initialTakeProfitPx?: string | null;
  initialStopLossPx?: string | null;
}): PerpProtectionRule | null {
  const takeProfitPx = input.initialTakeProfitPx?.trim();
  const stopLossPx = input.initialStopLossPx?.trim();
  const usableTakeProfit = takeProfitPx && parsePositiveDecimal(takeProfitPx)
    ? takeProfitPx
    : undefined;
  const usableStopLoss = stopLossPx && parsePositiveDecimal(stopLossPx)
    ? stopLossPx
    : undefined;
  if (!usableTakeProfit && !usableStopLoss) return null;
  return {
    takeProfitRoePct: null,
    stopLossRoePct: null,
    ...(usableTakeProfit ? { takeProfitPx: usableTakeProfit } : {}),
    ...(usableStopLoss ? { stopLossPx: usableStopLoss } : {}),
  };
}

function boundedPct(
  raw: string | number | null | undefined,
  bounds: { min: number; max: number },
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < bounds.min || value > bounds.max) return null;
  return value;
}

/** Why no protection is going to be attached to this mirror. */
export type PerpProtectionSkipReason =
  /** The follow has neither leg configured. The overwhelmingly common case. */
  | "not-configured"
  /** The entry mark is missing or unusable, so no trigger can be derived. */
  | "unusable-entry"
  /** The applied leverage is missing or unusable, so ROE has no denominator. */
  | "unusable-leverage"
  /** The size is missing or unusable, so there is nothing to size the legs to. */
  | "unusable-size"
  /** Both configured legs priced out to something the venue cannot trigger on. */
  | "no-usable-leg";

export type PerpProtectionDecision =
  | { action: "none"; reason: PerpProtectionSkipReason }
  | {
      action: "attach";
      takeProfitPx?: string;
      stopLossPx?: string;
      /** Legs that were configured but priced out. Logged, never fatal. */
      droppedLegs: readonly ("tp" | "sl")[];
    };

export interface PerpProtectionInput {
  rule: PerpProtectionRule | null;
  /** Side of the position being protected, not of the exit legs. */
  side: PerpSide;
  /** The mark the entry was priced against, as HL's own decimal string. */
  entryPx: string;
  /** The leverage actually applied to this coin before the order went out. */
  leverage: number;
  /** Coin-denominated size of the mirrored open. */
  sizeCoin: string;
}

/**
 * Turn a percent-of-margin rule into the absolute trigger prices Hyperliquid
 * takes, for one position at one entry and one leverage.
 *
 * At leverage L, a fractional price move m produces an ROE of `m * L` on a long
 * and `-m * L` on a short, so the move that realises a given ROE is
 * `roePct / (100 * L)`. Everything below is that one line, applied in the right
 * direction for each leg and each side.
 *
 * FEES AND FUNDING ARE NOT MODELLED. The real ROE at the trigger is slightly
 * worse than the configured one by the round-trip taker fee and any funding
 * paid. Both are small next to the percentages this accepts (the floor is 1% of
 * margin, and a stop is a magnitude the follower picked to the nearest whole
 * percent), and modelling them would make the number on screen disagree with
 * the number the follower typed for no gain in safety. The error is in the
 * conservative direction for the stop, which exits a fraction early.
 */
export function decidePerpProtection(input: PerpProtectionInput): PerpProtectionDecision {
  if (!input.rule) return { action: "none", reason: "not-configured" };
  const entry = Number(input.entryPx);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { action: "none", reason: "unusable-entry" };
  }
  const needsLeverage =
    input.rule.takeProfitRoePct !== null || input.rule.stopLossRoePct !== null;
  if (needsLeverage && (!Number.isFinite(input.leverage) || input.leverage <= 0)) {
    return { action: "none", reason: "unusable-leverage" };
  }
  const size = Number(input.sizeCoin);
  if (!Number.isFinite(size) || size <= 0) {
    return { action: "none", reason: "unusable-size" };
  }

  const isLong = input.side === "long";
  const droppedLegs: ("tp" | "sl")[] = [];

  // A take-profit is above the entry for a long and below it for a short; a
  // stop is the other way round on each. Getting this backwards would place the
  // stop where the target belongs, so the direction is derived from the side
  // rather than passed in.
  const configuredTakeProfitPx = input.rule.takeProfitPx;
  const configuredStopLossPx = input.rule.stopLossPx;
  const takeProfitPx = configuredTakeProfitPx !== undefined
    ? validAbsoluteTrigger(configuredTakeProfitPx, entry, isLong)
    : triggerPx(entry, input.leverage, input.rule.takeProfitRoePct, isLong);
  const stopLossPx = configuredStopLossPx !== undefined
    ? validAbsoluteTrigger(configuredStopLossPx, entry, !isLong)
    : triggerPx(entry, input.leverage, input.rule.stopLossRoePct, !isLong);

  if (
    (input.rule.takeProfitRoePct !== null || configuredTakeProfitPx !== undefined) &&
    takeProfitPx === null
  ) droppedLegs.push("tp");
  if (
    (input.rule.stopLossRoePct !== null || configuredStopLossPx !== undefined) &&
    stopLossPx === null
  ) droppedLegs.push("sl");

  if (takeProfitPx === null && stopLossPx === null) {
    return { action: "none", reason: "no-usable-leg" };
  }

  return {
    action: "attach",
    ...(takeProfitPx !== null ? { takeProfitPx } : {}),
    ...(stopLossPx !== null ? { stopLossPx } : {}),
    droppedLegs,
  };
}

function validAbsoluteTrigger(
  value: string,
  entry: number,
  up: boolean,
): string | null {
  if (!parsePositiveDecimal(value)) return null;
  const price = Number(value);
  if (!Number.isFinite(price) || (up ? price <= entry : price >= entry)) return null;
  return value;
}

/**
 * One trigger price, or null when the configured percentage does not resolve to
 * a price the venue could ever trigger on.
 *
 * `up` is the direction the price has to travel for THIS leg to fire. A null
 * result is a leg that prices at or below zero, which happens for a downward
 * leg whose ROE move is 100% or more of the notional: a short taking profit at
 * 500% of margin at 1x would need the coin to be worth minus four times what it
 * is now. Dropping the leg is the only honest answer; submitting a
 * non-positive trigger would be rejected, and clamping it to some small price
 * would invent an exit the follower never chose.
 */
function triggerPx(
  entry: number,
  leverage: number,
  roePct: number | null,
  up: boolean,
): string | null {
  if (roePct === null) return null;
  const move = roePct / (100 * leverage);
  const price = up ? entry * (1 + move) : entry * (1 - move);
  if (!Number.isFinite(price) || price <= 0) return null;
  return formatTriggerPx(price);
}

/**
 * A trigger price as a plain decimal string.
 *
 * Eight decimal places then trimmed, matching the (24,8) scale the orders table
 * stores perp prices at, so what is recorded and what was computed are the same
 * number. The venue's own tick rounding happens later inside `setPositionTpSl`,
 * which knows the coin's szDecimals; doing it here would need an asset lookup
 * in a module that deliberately has none.
 *
 * The string is also folded into the leg's client order id, so it has to be
 * stable: the same inputs must produce the same characters on every retry, or a
 * resubmitted leg would look like a new order to Hyperliquid instead of a
 * duplicate it can dedupe.
 */
function formatTriggerPx(price: number): string {
  const fixed = price.toFixed(8);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
}

/**
 * The legs of an attached plan that a cancel should try to retire.
 *
 * Returns the pre-hash client order ids recorded when the plan was attached.
 * Matching on those is what lets a cancel retire the MIRROR's own stop without
 * touching one the follower placed by hand on the same coin: Hyperliquid
 * reports a resting order's cloid, and only the mirror's legs hash to these.
 *
 * An empty result means there is nothing to cancel, which is the answer for
 * every order that never had protection and every plan already retired.
 */
/**
 * Does this mirrored close take the WHOLE exposure the mirror opened?
 *
 * Only then may the follower's take-profit and stop-loss be retired. A mirrored
 * close is PARTIAL by design in two ordinary ways, and in both of them exposure
 * survives the close:
 *
 *  1. The source scales out. `decidePerpReduceOnlyMirror` sizes a close
 *     proportionally, so a trader selling half their position produces a close
 *     for half of the follower's mirrored exposure.
 *  2. The attribution ceiling clamps it. A copied close may only reduce what the
 *     mirror opened, so a follower holding 10 of a coin where the mirror opened
 *     4 gets a close for 4 even when the source closes in full.
 *
 * Cancelling the legs in either case strips the stop off a live leveraged
 * position, which is the precise risk the follower configured the stop to bound.
 * That would be worse than not having the feature: before it they knowingly had
 * no stop, after it they would have one until the moment part of their position
 * was quietly left uncovered.
 *
 * Unknown exposure answers false. "I cannot tell" is not "it is fully closed",
 * and the safe direction is to leave protection resting: a stale trigger over a
 * closed position is a cancellable annoyance, an unprotected leveraged position
 * is a loss.
 *
 * A close LARGER than the recorded exposure answers true. The recorded figure
 * has drifted below reality, the position is gone, and leaving triggers resting
 * over nothing is the hazard the cancel path exists for.
 *
 * NO `sizeDecimals`. This used to take the coin's size precision and never read
 * it, while claiming to compare at it. The two candidate readings are not
 * equivalent and the exact one is the safer: truncating both operands to the
 * coin's precision first would call a close that left a sub-tick residue a FULL
 * close, and retiring on that is the one direction this module refuses to guess
 * in. Comparing the recorded figures exactly can only ever keep legs resting
 * that could have gone, which is the annoyance rather than the loss. Dropping
 * the parameter also spares the caller an asset lookup it needed for nothing.
 */
export function perpProtectionRetiresOnClose(input: {
  closeSizeCoin: string;
  mirroredExposureSizeDecimal: string | null | undefined;
}): boolean {
  const exposureRaw = input.mirroredExposureSizeDecimal?.trim();
  if (!exposureRaw) return false;
  const closed = parsePositiveDecimal(input.closeSizeCoin.trim());
  const exposure = parsePositiveDecimal(exposureRaw);
  if (!closed || !exposure) return false;

  // Compared at a common scale rather than by string, so "4.0000" and "4" are
  // recognised as the same size instead of reading as a partial close.
  const scale = Math.max(closed.scale, exposure.scale);
  const lift = (value: { coefficient: bigint; scale: number }) =>
    value.coefficient * 10n ** BigInt(scale - value.scale);
  return lift(closed) >= lift(exposure);
}

export function perpProtectionCancelPlan(
  plan: { legClientOrderIds?: string[] } | null | undefined,
  status: string | null | undefined,
): readonly string[] {
  if (!plan?.legClientOrderIds?.length) return [];
  // "cancelled" has already been through this once. Re-running it is harmless
  // at the venue (the orders are gone) but it would spend a poll cycle's venue
  // reads on every subsequent close for the same coin.
  if (status === "cancelled") return [];
  return plan.legClientOrderIds;
}

// ---------------------------------------------------------------------------
// Reaching the venue
//
// Everything above is arithmetic. What follows is the orchestration: read the
// position, derive the legs, submit them, retry, and record the outcome. It
// lives here rather than in the poller so the retry ladder and the never-close
// rule can be tested with a fake client instead of a database.
// ---------------------------------------------------------------------------

/**
 * The four client methods this needs, and no more.
 *
 * A structural subset rather than the whole `HyperliquidClient`, so a test can
 * satisfy it with four functions and so it is obvious at a glance that nothing
 * here can place a non-reduce-only order.
 */
export type PerpProtectionClient = Pick<
  HyperliquidClient,
  "listPositions" | "setPositionTpSl" | "openOrders" | "cancelOrder"
> & {
  /** Authoritative positions plus the DEX namespaces actually read. */
  perpAccountSnapshot?: (
    address: `0x${string}`,
    signal?: AbortSignal,
    requestedDexes?: readonly string[],
  ) => Promise<Pick<Awaited<ReturnType<HyperliquidClient["perpAccountSnapshot"]>>, "positions" | "coveredDexes">>;
  /** Exact per-cloid status is required when recovering a persisted plan. */
  orderStatusByClientOrderId?: (
    address: `0x${string}`,
    clientOrderId: string,
  ) => Promise<unknown>;
  /** Compatibility alias for adapters that expose the venue method name. */
  orderStatus?: (
    address: `0x${string}`,
    orderId: string | number,
  ) => Promise<unknown>;
};

/**
 * A deterministic protection leg that still needs cleanup after its owner lost
 * the opening-row CAS. This state is intentionally independent of the opening
 * row's status: a close may mark that row `cancelled` while the venue request is
 * still waiting to become visible to an exact order-status read.
 */
export interface PerpProtectionCleanupState {
  followerUserId: string;
  sourceItemId: string;
  walletAddress: `0x${string}`;
  coin: string;
  /** Durable opening-row identity for a retry worker, when one is available. */
  openingClientOrderId?: string;
  openingOrderId?: string;
  /** Pre-hash cloids; exact status readers hash these before querying HL. */
  legClientOrderIds: string[];
  /** Present only while a cleanup worker owns this generation's lease. */
  cleanupClaimToken?: string;
}

export interface PerpProtectionCleanupResult {
  /** Legs for which the venue accepted a cancel, or proved no longer live. */
  retired: number;
  /** Exact pre-hash cloids retired during this pass, in probe order. */
  retiredLegClientOrderIds: string[];
  /** Legs still needing an exact probe/cancel retry. */
  pending: readonly string[];
  errors: string[];
}

export interface PerpProtectionCleanupDeps {
  /** Renew/assert the generation lease immediately before an exact probe. */
  beforeExactProbe?: (
    state: PerpProtectionCleanupState,
    legClientOrderId: string,
  ) => Promise<boolean>;
  /** Renew/assert the generation lease immediately before a cancel mutation. */
  beforeCancel?: (
    state: PerpProtectionCleanupState,
    legClientOrderId: string,
    orderId: number,
  ) => Promise<boolean>;
  /**
   * Persist pending state independently of the opening row status. A rejection
   * is surfaced as `PerpProtectionCleanupPersistenceError` with the exact
   * pending cloids attached, so the caller can retain authority across a
   * cancelled-row/restart boundary rather than treating persistence as done.
   */
  recordCleanup?(
    state: PerpProtectionCleanupState,
    retiredLegClientOrderIds?: readonly string[],
  ): Promise<unknown>;
  /**
   * Persist an ordinary pending result together with its exact retirement
   * subtraction and retry metadata in one caller-owned, token-fenced update.
   * This is separate from recordCleanup so backlog callers cannot first write
   * progress and then race a second scheduler update.
   */
  recordPendingCleanup?(
    state: PerpProtectionCleanupState,
    retiredLegClientOrderIds: readonly string[],
    errors: readonly string[],
  ): Promise<unknown>;
}

/**
 * The venue cleanup was still pending, but its durable marker could not be
 * written. This is deliberately not swallowed: the caller must retain the
 * exact submitted cloids and either persist them through another path or retry
 * cleanup with the attached state after the database recovers.
 */
export class PerpProtectionCleanupPersistenceError extends Error {
  readonly code = "PERP_PROTECTION_CLEANUP_PERSIST_FAILED" as const;
  readonly state: PerpProtectionCleanupState;
  /** Exact cloids retired before persistence failed; never collapse this to a count. */
  readonly retiredLegClientOrderIds: string[];
  readonly cause: Error;

  constructor(
    state: PerpProtectionCleanupState,
    cause: Error,
    retiredLegClientOrderIds: readonly string[] = [],
  ) {
    super(`protection cleanup persistence failed: ${cause.message}`);
    this.name = "PerpProtectionCleanupPersistenceError";
    this.state = {
      ...state,
      legClientOrderIds: [...state.legClientOrderIds],
    };
    this.retiredLegClientOrderIds = [...new Set(
      retiredLegClientOrderIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    )];
    this.cause = cause;
  }
}

/** Cross-realm/type-erased guard for callers that receive the surfaced error. */
export function isPerpProtectionCleanupPersistenceError(
  error: unknown,
): error is PerpProtectionCleanupPersistenceError {
  return (
    error instanceof PerpProtectionCleanupPersistenceError ||
    (typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "PERP_PROTECTION_CLEANUP_PERSIST_FAILED" &&
      Reflect.get(error, "state") !== undefined)
  );
}

/**
 * How many times an attach is tried before the position is recorded unprotected.
 *
 * Three, with a widening gap, because the failures worth surviving are the short
 * ones: the position read lagging a just-filled order, and a transport blip on
 * the trigger submission. Neither lasts long, and neither is worth holding a
 * poll cycle open for minutes.
 *
 * WHAT HAPPENS AFTER THE LAST ATTEMPT IS THE IMPORTANT PART, AND IT IS NOTHING.
 * The position stays open. Closing it because an API call failed would be a
 * money-losing action the follower never asked for, and an unprotected mirror is
 * exactly what every mirror was before this feature existed: this may only ever
 * improve on that baseline, never invent a new way to lose money. The failure is
 * recorded and shouted about instead, and a person decides.
 */
export const PERP_PROTECTION_ATTEMPTS = 3;
export const PERP_PROTECTION_BACKOFF_MS = [1_000, 3_000] as const;

/** Everything an attach needs about the mirror that just placed. */
export interface PerpProtectionAttachRequest {
  followerUserId: string;
  sourceItemId: string;
  /**
   * The follow this mirror came from, which is where the rule is stored.
   *
   * Absent means the candidate cannot be tied back to a live follow row, and
   * then there is no rule to read and nothing is attached. The perp OPEN path
   * already refuses such a candidate outright (`decidePerpMirrorConsent`
   * returns `consent-unverifiable`), so in practice it is always present here.
   */
  followId?: string;
  walletAddress: `0x${string}`;
  coin: string;
  /**
   * The size the MIRROR opened. The legs never cover more than this, even when
   * the live position is larger: `decidePerpOpenAgainstPosition` permits a
   * mirror to add to a same-side position the follower opened themselves, and
   * an exit sized to the whole position would be the mirror placing a stop over
   * exposure it did not open and was never given permission to close.
   */
  sizeCoin: string;
  /**
   * The opening order's client order id. Two jobs: it identifies the row the
   * outcome is recorded on, and it seeds the legs' own client order ids, so a
   * later cancel can tell the mirror's stop from one the follower placed by hand
   * on the same coin.
   */
  clientOrderId: string;
  /**
   * Phase-A's immutable follow rule. It is only a fallback when the durable
   * order row predates the snapshot column; a persisted snapshot wins.
   */
  protectionRuleSnapshot?: PerpProtectionRule | null;
  /**
   * A plan persisted by an earlier attach attempt. Its leg ids are carried
   * into recovery so a changed position read cannot cause an already-resting
   * leg to be submitted again under a newly-derived trigger id.
   */
  priorProtectionPlan?: PerpProtectionPlan | null;
  /**
   * A durable owner claim used only by crash recovery. Normal fresh/resume
   * attaches are serialized by their delivery; a FILLED row can be retried by
   * more than one recovery worker, so its protection write also carries the
   * exact claim marker and timestamp that must still own the row.
   */
  protectionClaim?: { orderId?: string; reason: string; claimedAt: Date };
}

/**
 * A protection result lost its row-level compare-and-set race.
 *
 * This is intentionally distinct from a transport/database failure.  A stale
 * attach may have just submitted reduce-only legs while a mirrored close won
 * the row, in which case those newly submitted legs must be retired.  A
 * transient write failure cannot make that cleanup safe: cancelling a healthy
 * position's only protection would be worse than retrying the write.
 */
export class PerpProtectionRecordConflictError extends Error {
  readonly code = "PERP_PROTECTION_RECORD_CONFLICT" as const;
  readonly currentStatus: string | null | undefined;

  constructor(message: string, currentStatus?: string | null) {
    super(message);
    this.name = "PerpProtectionRecordConflictError";
    this.currentStatus = currentStatus;
  }
}

function isPerpProtectionRecordConflict(
  error: unknown,
): error is PerpProtectionRecordConflictError {
  return (
    error instanceof PerpProtectionRecordConflictError ||
    (typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "PERP_PROTECTION_RECORD_CONFLICT")
  );
}

/** The persistence and pacing an attach needs, injected so this stays testable. */
export interface PerpProtectionAttachDeps {
  /** The follower's configured exit, or null when they have not set one. */
  loadRule(): Promise<PerpProtectionRule | null>;
  /**
   * Persist the deterministic plan before the first trigger request leaves the
   * process.  This is optional for older adapters/tests, but the production
   * copy-mirror path supplies it so a crash after the venue accepts a trigger
   * cannot lose the cloid needed to reconcile or cancel that trigger.
   */
  recordPlan?(plan: PerpProtectionPlan): Promise<void>;
  recordAttached(plan: PerpProtectionPlan): Promise<void>;
  /**
   * `plan` is the candidate whose legs were SENT to Hyperliquid, present only
   * when at least one submission actually went out. It is recorded alongside the
   * failure because a leg the venue took before refusing the group is live, and
   * its client order id is the only handle anything has on it: see the
   * accumulation in `attachPerpProtection`. The status still says `unprotected`,
   * because the attach really did fail.
   */
  recordUnprotected(reason: string, plan?: PerpProtectionPlan): Promise<void>;
  /**
   * Persist cleanup that remains after a stale attach loses its row CAS. This
   * must not be implemented by rewriting the opening row to `unprotected`:
   * that row may already be durably `cancelled`, and its status must not hide
   * an unfinished venue cleanup.
   */
  recordCleanup?(
    state: PerpProtectionCleanupState,
    retiredLegClientOrderIds?: readonly string[],
  ): Promise<unknown>;
  /** Injected so a test does not actually wait out the backoff. */
  delay(ms: number): Promise<void>;
}

export type PerpProtectionAttachResult =
  /** No rule on the follow. Nothing was read, submitted or written. */
  | { outcome: "not-configured" }
  | { outcome: "attached"; plan: PerpProtectionPlan; droppedLegs: readonly ("tp" | "sl")[] }
  /** The legs are NOT live and the position IS still open. Needs a person. */
  | {
      outcome: "unprotected";
      reason: string;
      attempts: number;
      /** Present when the row owner lost a CAS while legs may still be live. */
      cleanup?: PerpProtectionCleanupState;
    };

/**
 * Attach the follower's take-profit and stop-loss to the position a mirror just
 * opened.
 *
 * NEVER THROWS, and never places anything but reduce-only triggers. The entry
 * order is already live by the time this runs, so a thrown error here would
 * requeue a delivery whose order is at the venue and invite a second placement.
 * Every failure path ends in a recorded outcome instead.
 *
 * THE POSITION IS READ FROM THE VENUE rather than assumed from the order. Three
 * things come out of that read that the order cannot supply:
 *
 *  1. Proof the mirror actually holds something. A protective trigger resting
 *     over a position that never filled is precisely the hazard the cancel path
 *     exists for: it survives to fire against whatever the follower opens in
 *     that coin next.
 *  2. The real entry price. The order was priced off a mid and filled through a
 *     slippage band, and at 20x that difference is a meaningful share of a stop
 *     measured in percent of margin.
 *  3. The leverage the venue actually applied, which is the denominator of the
 *     whole ROE conversion.
 */
export async function attachPerpProtection(
  client: PerpProtectionClient,
  request: PerpProtectionAttachRequest,
  deps: PerpProtectionAttachDeps,
): Promise<PerpProtectionAttachResult> {
  const [ruleError, rule] = await catchError(deps.loadRule());
  if (ruleError) {
    // The rule could not be read, so we cannot tell whether one exists. This is
    // NOT recorded on the row: writing "unprotected" onto a follow that never
    // asked for protection would put a healthy position on an operator's list
    // and leave it there.
    return {
      outcome: "unprotected",
      reason: `rule-unreadable: ${ruleError.message}`,
      attempts: 0,
    };
  }
  // OFF BY DEFAULT, and off means untouched. No venue call, no row write: a
  // follow with no exit configured behaves exactly as it did before this
  // existed.
  if (!rule) return { outcome: "not-configured" };

  let lastReason = "no-attempt-made";
  let attemptsMade = 0;
  // EVERY leg id this attach has SENT to the venue, in submission order, not
  // just the ones the venue confirmed.
  //
  // A submission that is not fully accepted still leaves whatever Hyperliquid
  // DID take resting at the venue, and a retry does not necessarily re-send the
  // same ids: each leg's cloid folds in its own trigger price, and the trigger
  // price is derived from the position read back on that attempt, so a fill
  // landing between attempts moves the entry and moves the ids with it. Keeping
  // the union means the recorded plan names every leg that could be resting,
  // which is the only thing `cancelPerpProtection` can match a resting order
  // against. Ids that turned out not to be live cost nothing: the cancel only
  // ever acts on cloids it actually finds in `openOrders`.
  const submitted: string[] = [
    ...(request.priorProtectionPlan?.legClientOrderIds ?? []),
  ];
  // A cancelled row means the source close won ownership. Every deterministic
  // leg named by that row belongs to the stale attach and is therefore eligible
  // for exact cleanup. We still keep this set separate from `submitted`: the
  // latter is the durable plan union, while this one records what this attach
  // actually sent and is useful when a non-cancelled write fails.
  const submittedThisAttach = new Set<string>();
  let candidate: PerpProtectionPlan | null = request.priorProtectionPlan ?? null;
  let priorPlan = request.priorProtectionPlan ?? null;
  for (let attempt = 1; attempt <= PERP_PROTECTION_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    const step = await attachOnce(
      client,
      priorPlan
        ? { ...request, priorProtectionPlan: priorPlan }
        : request,
      rule,
      deps,
    );
    if (step.plan) {
      candidate = step.plan;
      // A successful recovery proves every plan leg is live even when the
      // aggregate read meant no POST was needed. On a failed step, only the
      // subset explicitly marked as submitted reached the venue; a plan built
      // before an exact-status/position revalidation failure must not create a
      // phantom cleanup obligation for ids that were never sent.
      const planLegs = step.ok
        ? step.plan.legClientOrderIds
        : (step.submittedLegClientOrderIds ?? []);
      for (const legId of planLegs) {
        if (!submitted.includes(legId)) submitted.push(legId);
      }
      if (step.ok || planLegs.length > 0) {
        priorPlan = {
          ...priorPlan,
          ...step.plan,
          legClientOrderIds: [...submitted],
        };
      }
    }
    for (const legId of step.submittedLegClientOrderIds ?? []) {
      submittedThisAttach.add(legId);
    }
    if (step.ok) {
      const plan: PerpProtectionPlan = { ...step.plan, legClientOrderIds: [...submitted] };
      const [recordError] = await catchError(deps.recordAttached(plan));
      if (recordError) {
        let cleanup: PerpProtectionCleanupState | undefined;
        if (
          isPerpProtectionRecordConflict(recordError) &&
          recordError.currentStatus === "cancelled"
        ) {
          cleanup = await settleStaleProtectionCleanup(
            client,
            request,
            submitted,
            deps,
          );
        }
        // The legs ARE live at Hyperliquid. Retrying the submission would place
        // a second pair, so the only thing left is to say the record is missing:
        // without its leg ids the plan cannot be cancelled later, which is the
        // same operator-visible state as a failed attach and is treated as one.
        return {
          outcome: "unprotected",
          reason: `legs-live-but-unrecorded: ${recordError.message}`,
          attempts: attempt,
          ...(cleanup ? { cleanup } : {}),
        };
      }
      return { outcome: "attached", plan, droppedLegs: step.droppedLegs };
    }
    lastReason = step.reason;
    // A rule that cannot resolve to a usable trigger at this entry and leverage
    // will not resolve to one on the next attempt either. Waiting three seconds
    // to fail the same way is a cost with no upside.
    if (step.permanent) break;
    const backoff = PERP_PROTECTION_BACKOFF_MS[attempt - 1];
    if (backoff !== undefined && attempt < PERP_PROTECTION_ATTEMPTS) {
      await catchError(deps.delay(backoff));
    }
  }

  // Deliberately no close, no reduce, no unwind. See PERP_PROTECTION_ATTEMPTS.
  //
  // The candidate plan goes down with the reason when anything was submitted.
  // Without it a leg Hyperliquid accepted before refusing the group is live with
  // its cloid recorded nowhere, and a reduce-only trigger resting over exposure
  // nothing can account for is precisely the hazard the cancel path exists for.
  // The status stays `unprotected`, so the backlog line still counts it.
  const planWithSubmittedLegs = candidate && submitted.length > 0
    ? { ...candidate, legClientOrderIds: [...submitted] }
    : undefined;
  const [recordError] = await catchError(() =>
    deps.recordUnprotected(
      lastReason,
      planWithSubmittedLegs,
    ),
  );
  let cleanup: PerpProtectionCleanupState | undefined;
  if (
    recordError &&
    isPerpProtectionRecordConflict(recordError) &&
    recordError.currentStatus === "cancelled"
  ) {
    cleanup = await settleStaleProtectionCleanup(
      client,
      request,
      submitted.length > 0 ? submitted : [...submittedThisAttach],
      deps,
    );
  }
  return {
    outcome: "unprotected",
    reason: lastReason,
    attempts: attemptsMade,
    ...(cleanup ? { cleanup } : {}),
  };
}

export type PerpProtectionUnattachedResult =
  /** No rule on the follow, so nothing was expected and nothing was written. */
  | { outcome: "not-configured" }
  /** The row now carries `unprotected`, so the backlog line will find it. */
  | { outcome: "recorded" }
  /** Neither the rule nor the note could be written down. Logged, never fatal. */
  | { outcome: "unrecorded"; reason: string };

/**
 * Record that a position which SHOULD have carried the follower's exit does not,
 * without having tried to attach one.
 *
 * WHY THERE IS A SEPARATE FUNCTION FOR THIS. `placePerpMirrorOrder` returns
 * "syncing" from three paths, and TWO of them are skipped by the attach: a local
 * status write that failed after Hyperliquid accepted, and the reconcile
 * disposition on a rejection. Neither read anything back from the venue, so the
 * position may not exist, and a trigger resting over exposure that may not exist
 * is the resting-order hazard the cancel path exists for. (The third, recovered
 * by cloid, DOES attach: it read the order back off the venue and stamped the row
 * with the broker order id. See `perpPlacementProvesExposure`.)
 *
 * Skipping it silently was the defect. `recordUnprotected` never ran, the row's
 * `perp_protection_status` stayed NULL, and `emitUnprotectedPerpBacklog` filters
 * on 'unprotected', so nothing anywhere said the stop was missing. The follower
 * had every reason to believe it was live.
 *
 * OFF BY DEFAULT SURVIVES THIS, which is why the rule is read first. Writing
 * `unprotected` onto a follow that never asked for protection would put a
 * perfectly healthy position on an operator's list and leave it there, and would
 * make a feature nobody enabled change what their rows look like.
 *
 * NEVER THROWS. It runs after a placement whose order may already be at the
 * venue, so an error escaping here would requeue a delivery whose order exists.
 */
export async function recordPerpProtectionUnattached(
  deps: Pick<PerpProtectionAttachDeps, "loadRule" | "recordUnprotected">,
  reason: string,
): Promise<PerpProtectionUnattachedResult> {
  const [ruleError, rule] = await catchError(deps.loadRule());
  if (ruleError) {
    // Same reasoning as the attach: an unreadable rule is not evidence that one
    // exists, and a row is not marked unprotected on a guess.
    return { outcome: "unrecorded", reason: `rule-unreadable: ${ruleError.message}` };
  }
  if (!rule) return { outcome: "not-configured" };
  const [writeError] = await catchError(deps.recordUnprotected(reason));
  if (writeError) {
    return { outcome: "unrecorded", reason: `note-unwritable: ${writeError.message}` };
  }
  return { outcome: "recorded" };
}

type AttachStep =
  | {
      ok: true;
      plan: PerpProtectionPlan;
      droppedLegs: readonly ("tp" | "sl")[];
      submittedLegClientOrderIds?: readonly string[];
    }
  /**
   * `plan` is present only on the failures that happen AFTER the legs were put
   * on the wire, and it is what the caller accumulates: a submission whose reply
   * never confirmed the group may still have left a leg resting at the venue.
   * The failures that happen before the submit carry none, because nothing was
   * sent and there is no cloid anywhere to go looking for.
   */
  | {
      ok: false;
      reason: string;
      permanent: boolean;
      plan?: PerpProtectionPlan;
      submittedLegClientOrderIds?: readonly string[];
    };

/** One attempt: read the position, derive the legs, submit them, check the reply. */
async function attachOnce(
  client: PerpProtectionClient,
  request: PerpProtectionAttachRequest,
  rule: PerpProtectionRule,
  deps: PerpProtectionAttachDeps,
): Promise<AttachStep> {
  const [readError, positions] = await catchError(
    client.listPositions(request.walletAddress, request.coin),
  );
  if (readError) {
    return {
      ok: false,
      reason: `position-read-failed: ${readError.message}`,
      permanent: false,
    };
  }
  const position = positions.find((item) => item.coin === request.coin) ?? null;
  if (!position) {
    // The venue reports nothing to protect. Usually the position read simply
    // lags the fill; occasionally the order never filled at all. Either way,
    // submitting a trigger now would leave one resting over exposure that does
    // not exist.
    return { ok: false, reason: "no-position-to-protect", permanent: false };
  }

  // Never more than the mirror opened. See PerpProtectionAttachRequest.sizeCoin.
  const sizeCoin = minDecimal(position.size, request.sizeCoin, PERP_PROTECTION_SIZE_SCALE);
  if (!sizeCoin) {
    return { ok: false, reason: "position-size-unreadable", permanent: false };
  }

  const decision = decidePerpProtection({
    rule,
    side: position.side,
    entryPx: position.entryPx ?? "",
    leverage: position.leverage,
    sizeCoin,
  });
  if (decision.action === "none") {
    // "no-usable-leg" is arithmetic, not weather: the same rule at the same
    // entry and leverage prices out the same way every time.
    return {
      ok: false,
      reason: `no-triggers-derived: ${decision.reason}`,
      permanent: decision.reason === "no-usable-leg",
    };
  }

  const legRequest = {
    coin: request.coin,
    positionSide: position.side,
    size: sizeCoin,
    ...(decision.takeProfitPx !== undefined ? { takeProfitPx: decision.takeProfitPx } : {}),
    ...(decision.stopLossPx !== undefined ? { stopLossPx: decision.stopLossPx } : {}),
    clientOrderId: `${request.clientOrderId}:tpsl`,
  } as const;
  // The per-leg ids come from the venue package's own leg builder rather than
  // being spelled out again here. They have to match the cloids Hyperliquid ends
  // up holding to the character, because that is what a later cancel looks them
  // up by; a second copy of the format would drift and the cancel would silently
  // match nothing.
  const expectedLegs = buildTpSlLegs(legRequest);
  const legClientOrderIds = expectedLegs
    .map((leg) => leg.clientOrderId)
    .filter((id): id is string => typeof id === "string");

  // Built BEFORE the submit rather than on the success path, so the ids that
  // reach the venue survive a reply that never confirms them. Everything in it
  // is already known at this point; nothing below it can change the plan, only
  // whether it is the record of an attach or the record of an orphan.
  const plan: PerpProtectionPlan = {
    ...(rule.takeProfitRoePct !== null ? { takeProfitRoePct: rule.takeProfitRoePct } : {}),
    ...(rule.stopLossRoePct !== null ? { stopLossRoePct: rule.stopLossRoePct } : {}),
    ...(decision.takeProfitPx !== undefined ? { takeProfitPx: decision.takeProfitPx } : {}),
    ...(decision.stopLossPx !== undefined ? { stopLossPx: decision.stopLossPx } : {}),
    entryPx: position.entryPx ?? "",
    leverage: position.leverage,
    sizeCoin,
    legClientOrderIds,
  };

  // Checkpoint the exact leg ids and trigger prices before any state-changing
  // venue request. If this write cannot be made, fail closed: submitting now
  // would create an orphan protection leg that a later recovery cannot name.
  if (request && typeof request === "object" && deps.recordPlan) {
    const [checkpointError] = await catchError(deps.recordPlan(plan));
    if (checkpointError) {
      return {
        ok: false,
        reason: `protection-plan-checkpoint-failed: ${checkpointError.message}`,
        permanent: false,
      };
    }
  }

  // A protection attach can be interrupted after the venue accepted one or
  // both legs but before the durable row was marked `attached` (for example,
  // the worker can die between Phase B and Phase C).  Re-submitting the whole
  // group on recovery is not safe: a reused cloid is not a contract this
  // repository can assume, and a lagging database row would then leave a
  // duplicate trigger resting over the same position.  Read the authoritative
  // open-order set by the deterministic per-leg cloids first and submit only
  // legs that are definitely absent.
  const [openOrdersError, openOrders] = await catchError(
    client.openOrders(request.walletAddress, [
      request.coin.includes(":") ? request.coin.split(":")[0]! : "",
    ]),
  );
  if (openOrdersError) {
    return {
      ok: false,
      reason: `protection-order-read-failed: ${openOrdersError.message}`,
      permanent: false,
    };
  }
  if (!Array.isArray(openOrders)) {
    return {
      ok: false,
      reason: "protection-order-read-invalid",
      permanent: false,
    };
  }

  const restingCloids = new Set<string>();
  for (const order of openOrders) {
    if (!order || typeof order !== "object") continue;
    const cloid = (order as { cloid?: unknown }).cloid;
    if (typeof cloid !== "string" || cloid.trim() === "") continue;
    // The normalized client returns the venue's hashed cloid while the plan
    // stores the stable readable seed.  Accepting either representation keeps
    // the check correct for the raw `openOrders` client and for lightweight
    // test/adapter clients alike.
    restingCloids.add(cloid.toLowerCase());
    try {
      restingCloids.add(toCloid(cloid).toLowerCase());
    } catch {
      // A malformed venue cloid is simply not a match for an expected leg.
    }
  }

  // A persisted plan may have been derived from an earlier venue position
  // read. Rebuild its deterministic ids for the current position side and
  // trigger prices, then use the venue's resting set to identify an already
  // live leg even when the current entry read would produce a different id.
  // This is deliberately a leg-type match, not a blanket "any known id" skip:
  // a resting stop must not suppress a missing take-profit (or vice versa).
  const priorLegByType = new Map<"sl" | "tp", string>();
  const prior = request.priorProtectionPlan;
  if (prior) {
    const priorLegs = buildTpSlLegs({
      ...legRequest,
      ...(prior.stopLossPx !== undefined ? { stopLossPx: prior.stopLossPx } : {}),
      ...(prior.takeProfitPx !== undefined ? { takeProfitPx: prior.takeProfitPx } : {}),
    });
    for (const leg of priorLegs) {
      if (typeof leg.clientOrderId !== "string") continue;
      const type = leg.orderType === "StopMarket" || leg.orderType === "StopLimit"
        ? "sl"
        : leg.orderType === "TakeProfitMarket" || leg.orderType === "TakeProfitLimit"
          ? "tp"
          : null;
      if (type) priorLegByType.set(type, leg.clientOrderId);
    }
    // Keep any ids the marker carried even if its price fields were absent or
    // malformed. They remain useful to the eventual cancel path, but without a
    // leg type they cannot by themselves suppress a new submission.
  }

  // A persisted plan is a durable claim that a previous request may already
  // have reached the venue. Aggregate open-orders data is eventually
  // consistent and cannot prove absence, so every persisted leg is checked by
  // its exact cloid before the aggregate snapshot is allowed to influence the
  // decision. Missing or malformed exact status is fail-closed: submitting in
  // that state could duplicate a live protection leg.
  let filledProtectionLeg = false;
  let terminalProtectionStatus: string | undefined;
  if (prior && prior.legClientOrderIds.length > 0) {
    const statusReader = client.orderStatusByClientOrderId ?? client.orderStatus;
    if (!statusReader) {
      return {
        ok: false,
        reason: "protection-order-status-unavailable",
        permanent: true,
        plan,
      };
    }
    for (const legId of prior.legClientOrderIds) {
      const [statusError, rawStatus] = await catchError(
        statusReader.call(client, request.walletAddress, legId),
      );
      if (statusError) {
        return {
          ok: false,
          reason: `protection-order-status-failed: ${statusError.message}`,
          permanent: false,
          plan,
        };
      }
      const exact = readPerpProtectionOrderStatus(rawStatus);
      if (exact.kind === "invalid") {
        return {
          ok: false,
          reason: `protection-order-status-invalid: ${exact.error}`,
          permanent: true,
          plan,
        };
      }
      if (exact.kind === "live") {
        // Keep both representations in the set. The normalized client exposes
        // the hashed cloid, while small adapters/tests commonly return the
        // readable seed unchanged.
        restingCloids.add(legId.toLowerCase());
        restingCloids.add(toCloid(legId).toLowerCase());
      } else if (exact.kind === "unknown") {
        // An exact unknownOid is not proof that a checkpointed submission was
        // never accepted. Do not let a lagging exact index plus an empty
        // aggregate snapshot authorize a replacement trigger.
        return {
          ok: false,
          reason: "protection-order-status-unknownOid",
          permanent: false,
          plan,
        };
      } else if (exact.kind === "filled") {
        // A trigger that filled is terminal, not a live leg. Revalidate the
        // position below before deciding whether this opening row is now flat;
        // in particular, never replace a filled trigger from an empty aggregate
        // read because that would create a second exit after the first fired.
        filledProtectionLeg = true;
      } else if (exact.kind === "terminal") {
        // Rejected/cancelled/expired and any other terminal status prove the
        // request was not a live protection leg. They also forbid a replacement
        // based solely on an eventually-consistent aggregate snapshot.
        terminalProtectionStatus = exact.status;
      } else if (exact.kind === "indeterminate") {
        // A status added by the venue after this worker was deployed is not
        // evidence that the old leg is absent. Defer rather than submitting a
        // replacement that could duplicate a still-live protection order.
        return {
          ok: false,
          reason: `protection-order-status-indeterminate: ${exact.status}`,
          permanent: false,
          plan,
        };
      }
    }
  }

  if (filledProtectionLeg || terminalProtectionStatus !== undefined) {
    if (filledProtectionLeg) {
      const revalidation = await readAuthoritativePerpPositions(
        client,
        request.walletAddress,
        request.coin,
      );
      if ("error" in revalidation) {
        return {
          ok: false,
          reason: `filled-protection-revalidation-failed: ${revalidation.error}`,
          // Missing HIP-3 coverage is ambiguous, not a terminal flat result.
          // Defer until an authoritative snapshot covers this coin's DEX.
          permanent: false,
          plan,
        };
      }
      const revalidatedPosition = revalidation.positions.find(
        (item) => item.coin === request.coin,
      );
      if (!revalidatedPosition) {
        return {
          ok: false,
          reason: "filled-protection-position-closed",
          permanent: true,
          plan,
        };
      }
      if (!hasKnownPositionSize(revalidatedPosition.size)) {
        return {
          ok: false,
          reason: "filled-protection-position-size-unreadable",
          permanent: false,
          plan,
        };
      }
      if (!hasPositivePositionSize(revalidatedPosition.size)) {
        return {
          ok: false,
          reason: "filled-protection-position-closed",
          permanent: true,
          plan,
        };
      }
      return {
        ok: false,
        reason: "filled-protection-position-still-open",
        permanent: true,
        plan,
      };
    }
    return {
      ok: false,
      reason: `protection-order-terminal: ${terminalProtectionStatus}`,
      permanent: true,
      plan,
    };
  }

  const missingLegs = [] as typeof legClientOrderIds;
  for (const leg of expectedLegs) {
    const legId = leg.clientOrderId;
    if (typeof legId !== "string") continue;
    const hashed = toCloid(legId).toLowerCase();
    const hasCurrent = restingCloids.has(legId.toLowerCase()) || restingCloids.has(hashed);
    const legType = leg.orderType === "StopMarket" || leg.orderType === "StopLimit"
      ? "sl"
      : leg.orderType === "TakeProfitMarket" || leg.orderType === "TakeProfitLimit"
        ? "tp"
        : null;
    const priorLegId = legType ? priorLegByType.get(legType) : undefined;
    const hasPrior = priorLegId !== undefined && (
      restingCloids.has(priorLegId.toLowerCase()) ||
      restingCloids.has(toCloid(priorLegId).toLowerCase())
    );
    if (!hasCurrent && !hasPrior) {
      missingLegs.push(legId);
    }
  }

  if (missingLegs.length === 0) {
    // The venue already has every deterministic leg.  Treat recovery as a
    // successful attach without sending a second state-changing request.
    return { ok: true, plan, droppedLegs: decision.droppedLegs };
  }

  const missingLegSet = new Set(missingLegs);
  const missingHasStop = expectedLegs.some(
    (leg) =>
      typeof leg.clientOrderId === "string" &&
      missingLegSet.has(leg.clientOrderId) &&
      (leg.orderType === "StopMarket" || leg.orderType === "StopLimit"),
  );
  const missingHasTakeProfit = expectedLegs.some(
    (leg) =>
      typeof leg.clientOrderId === "string" &&
      missingLegSet.has(leg.clientOrderId) &&
      (leg.orderType === "TakeProfitMarket" ||
        leg.orderType === "TakeProfitLimit"),
  );

  // The durable plan names every leg that is expected to be ours, while this
  // request contains only the subset that the venue read did not find.
  const submitRequest = {
    ...legRequest,
    ...(missingHasStop ? {} : { stopLossPx: undefined }),
    ...(missingHasTakeProfit ? {} : { takeProfitPx: undefined }),
  };

  const [placeError, result] = await catchError(client.setPositionTpSl(submitRequest));
  if (placeError) {
    // The reply was lost, not the submission: these legs may well be resting at
    // Hyperliquid right now, so their ids go back with the failure.
    return {
      ok: false,
      reason: `tpsl-submit-failed: ${placeError.message}`,
      permanent: false,
      plan,
      submittedLegClientOrderIds: missingLegs,
    };
  }
  // A trigger can execute immediately while the placement response is still
  // successful. It is not equivalent to a resting protection leg: re-read the
  // position before allowing the opening row to be marked attached. Check this
  // before ordinary acceptance handling too: a mixed filled+rejected response
  // still contains a filled trigger and must not be retried as if no leg fired.
  if (tpSlHasFilledStatus(result)) {
    const revalidation = await readAuthoritativePerpPositions(
      client,
      request.walletAddress,
      request.coin,
    );
    if ("error" in revalidation) {
      return {
        ok: false,
        reason: `filled-protection-revalidation-failed: ${revalidation.error}`,
        // The placement already reported a filled trigger. A failed or
        // uncovered position read is not permission to send another trigger.
        permanent: false,
        plan,
        submittedLegClientOrderIds: missingLegs,
      };
    }
    const revalidatedPosition = revalidation.positions.find(
      (item) => item.coin === request.coin,
    );
    if (!revalidatedPosition) {
      return {
        ok: false,
        reason: "filled-protection-position-closed",
        permanent: true,
        plan,
        submittedLegClientOrderIds: missingLegs,
      };
    }
    if (!hasKnownPositionSize(revalidatedPosition.size)) {
      return {
        ok: false,
        reason: "filled-protection-position-size-unreadable",
        permanent: false,
        plan,
        // The placement response already proves these exact legs reached the
        // venue. Preserve their ids while the malformed position read retries.
        submittedLegClientOrderIds: missingLegs,
      };
    }
    if (!hasPositivePositionSize(revalidatedPosition.size)) {
      return {
        ok: false,
        reason: "filled-protection-position-closed",
        permanent: true,
        plan,
        submittedLegClientOrderIds: missingLegs,
      };
    }
    return {
      ok: false,
      reason: "filled-protection-position-still-open",
      permanent: true,
      plan,
      submittedLegClientOrderIds: missingLegs,
    };
  }

  // `setPositionTpSl` goes straight to `exchange.order`, which does NOT throw on
  // a per-leg rejection the way `placeOrder` does, so the reply has to be read.
  const acceptance = readTpSlAcceptance(result, missingLegs.length);
  if (!acceptance.accepted) {
    // A PARTIAL acceptance is treated as a failure on purpose. The legs are
    // idempotent per cloid (each one folds in its own trigger price), so a retry
    // re-sends the same pair and Hyperliquid is expected to dedupe the one it
    // already holds instead of doubling it.
    //
    // EXPECTED, not known. Whether the venue dedupes a re-used cloid or rejects
    // it is undetermined from this repository (docs/audits/2026-08-auto-mirror.md),
    // and the sibling rejection path deliberately assumes neither. So the ids go
    // back with the failure either way: if the retry is deduped the accepted leg
    // is already named in the plan, and if every retry is rejected the plan is
    // what the unprotected row records, which keeps whichever leg the venue kept
    // cancellable instead of orphaning it.
    return {
      ok: false,
      reason: `tpsl-not-accepted: ${acceptance.reason}`,
      permanent: false,
      plan,
      submittedLegClientOrderIds: missingLegs,
    };
  }

  return {
    ok: true,
    plan,
    droppedLegs: decision.droppedLegs,
    submittedLegClientOrderIds: missingLegs,
  };
}

export type PerpProtectionExactStatus =
  | { kind: "unknown"; status: "unknownOid" }
  | { kind: "live"; status: string; oid: string | number }
  | { kind: "filled"; status: string; oid: string | number }
  | { kind: "terminal"; status: string; oid: string | number }
  | { kind: "indeterminate"; status: string; oid: string | number }
  | { kind: "invalid"; error: string; status?: string };

/**
 * Parse the exact Info endpoint without treating malformed data as absence.
 *
 * The venue's outer `status: "order"` only says that an order record exists;
 * `order.status` is the processing status that tells us whether it is still a
 * live trigger. Preserve that value for logs/cleanup and classify it here so a
 * rejected, cancelled, expired, or otherwise terminal order cannot masquerade
 * as attached protection.
 */
export function readPerpProtectionOrderStatus(raw: unknown): PerpProtectionExactStatus {
  if (!raw || typeof raw !== "object") {
    return { kind: "invalid", error: "response is not an object" };
  }
  const status = readField(raw, "status");
  if (status === "unknownOid") return { kind: "unknown", status: "unknownOid" };
  if (status !== "order") {
    return { kind: "invalid", error: "status is neither order nor unknownOid" };
  }
  const orderEnvelope = readField(raw, "order");
  const order = readField(orderEnvelope, "order");
  const oid = readField(order, "oid");
  const orderStatus = readField(orderEnvelope, "status");
  if (
    (typeof oid !== "string" &&
      (typeof oid !== "number" || !Number.isSafeInteger(oid) || oid < 0)) ||
      (typeof oid === "string" && oid.trim() === "") ||
      (typeof orderStatus !== "string" || orderStatus.trim() === "")
  ) {
    return { kind: "invalid", error: "order response is missing oid/status" };
  }
  const preservedStatus = orderStatus.trim();
  switch (preservedStatus.toLowerCase()) {
    case "open":
    case "resting":
    case "pending":
    case "waitingfortrigger":
      return { kind: "live", status: preservedStatus, oid };
    case "triggered":
    case "filled":
      return { kind: "filled", status: preservedStatus, oid };
    case "rejected":
    case "canceled":
    case "cancelled":
    case "expired":
    case "margincanceled":
    case "margincancelled":
    case "reduceonlycanceled":
    case "reduceonlycancelled":
    case "scheduledcancel":
    case "vaultwithdrawalcanceled":
    case "openinterestcapcanceled":
    case "selftradecanceled":
    case "siblingfilledcanceled":
    case "delistedcanceled":
    case "liquidatedcanceled":
    case "tickrejected":
    case "mintradentlrejected":
    case "perpmarginrejected":
    case "reduceonlyrejected":
    case "badalopxrejected":
    case "ioccancelrejected":
    case "badtriggerpxrejected":
    case "marketordernoliquidityrejected":
    case "positionincreaseatopeninterestcaprejected":
    case "positionflipatopeninterestcaprejected":
    case "tooaggressiveatopeninterestcaprejected":
    case "openinterestincreaserejected":
    case "insufficientspotbalancerejected":
    case "oraclerejected":
    case "perpmaxpositionrejected":
      return { kind: "terminal", status: preservedStatus, oid };
    default:
      // A future venue status is not proof that the order is gone. Keep it in
      // the retryable set until the status vocabulary is deliberately updated.
      return { kind: "indeterminate", status: preservedStatus, oid };
  }
}

function hasPositivePositionSize(raw: unknown): boolean {
  if (typeof raw !== "string" && typeof raw !== "number") return false;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0;
}

function hasKnownPositionSize(raw: unknown): boolean {
  if (typeof raw === "string" && raw.trim() === "") return false;
  if (typeof raw !== "string" && typeof raw !== "number") return false;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 0;
}

type AuthoritativePerpPosition = {
  coin?: unknown;
  size?: unknown;
};

type AuthoritativePerpPositionRead =
  | { positions: readonly AuthoritativePerpPosition[] }
  | { error: string };

/**
 * Read a position only when the account snapshot proves it covered the coin's
 * DEX. `listPositions` remains a compatibility fallback for old test/adapters;
 * the production Hyperliquid client exposes `perpAccountSnapshot`, whose
 * coverage list is the difference between "flat" and "not read" for HIP-3.
 */
async function readAuthoritativePerpPositions(
  client: PerpProtectionClient,
  walletAddress: `0x${string}`,
  coin: string,
): Promise<AuthoritativePerpPositionRead> {
  if (client.perpAccountSnapshot) {
    const [snapshotError, snapshot] = await catchError(
      client.perpAccountSnapshot(walletAddress, undefined, [
        coin.includes(":") ? coin.split(":")[0]! : "",
      ]),
    );
    if (snapshotError) {
      return { error: `account snapshot failed: ${snapshotError.message}` };
    }
    if (!snapshot || typeof snapshot !== "object" ||
      !Array.isArray(snapshot.positions) || !Array.isArray(snapshot.coveredDexes) ||
      snapshot.coveredDexes.some((dex) => typeof dex !== "string") ||
      snapshot.positions.some((position) => !position || typeof position !== "object")) {
      return { error: "account snapshot was malformed" };
    }
    if (!isPerpDexCovered(snapshot.coveredDexes, coin)) {
      return { error: `account snapshot coverage did not include coin DEX ${coin}` };
    }
    return { positions: snapshot.positions as readonly AuthoritativePerpPosition[] };
  }

  // `listPositions` is a compatibility view with no way to say which HIP-3
  // namespaces it actually queried. An empty result for a namespaced coin is
  // therefore ambiguous: the account may be flat, or that DEX may simply have
  // been omitted. Treat it as indeterminate rather than retiring a fired
  // protection leg or authorizing a replacement attach.
  if (coin.includes(":")) {
    return { error: `authoritative account snapshot unavailable for HIP-3 coin ${coin}` };
  }

  const [positionsError, positions] = await catchError(
    client.listPositions(walletAddress),
  );
  if (positionsError) return { error: `position read failed: ${positionsError.message}` };
  if (!Array.isArray(positions) ||
    positions.some((position) => !position || typeof position !== "object")) {
    return { error: "position read was malformed" };
  }
  return { positions: positions as readonly AuthoritativePerpPosition[] };
}

function tpSlHasFilledStatus(result: unknown): boolean {
  return tpSlStatuses(result).some((status) => {
    const filled = readField(status, "filled");
    return filled !== null &&
      typeof filled === "object" &&
      readField(filled, "oid") !== undefined;
  });
}

/**
 * Probe every submitted cloid through the exact order-status endpoint and
 * cancel live legs by the OID returned by that same response.
 *
 * The aggregate `openOrders` endpoint is deliberately absent here. Its empty
 * response is eventually consistent and cannot prove that a trigger accepted
 * by the venue is gone. An exact `unknownOid` is retained for one more retry as
 * well: a just-accepted order can briefly be invisible to both reads, and the
 * durable cleanup record is the safe place to wait for the authoritative
 * answer. Non-fired terminal statuses (including rejected, cancelled and
 * expired) are proof that no cancel is needed; filled/triggered statuses
 * require position revalidation.
 */
async function retireSubmittedProtectionLegs(
  client: PerpProtectionClient,
  state: PerpProtectionCleanupState,
  deps: PerpProtectionCleanupDeps = {},
): Promise<PerpProtectionCleanupResult> {
  const pending: string[] = [];
  const errors: string[] = [];
  const retiredLegClientOrderIds: string[] = [];
  let retired = 0;
  const statusReader = client.orderStatusByClientOrderId ?? client.orderStatus;

  if (!statusReader) {
    return {
      retired: 0,
      retiredLegClientOrderIds: [],
      pending: [...state.legClientOrderIds],
      errors: ["exact protection order-status reader unavailable"],
    };
  }

  const checkLease = async (
    kind: "probe" | "cancel",
    legClientOrderId: string,
    orderId?: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (kind === "probe" && !deps.beforeExactProbe) return { ok: true };
    if (kind === "cancel" && !deps.beforeCancel) return { ok: true };
    const [leaseError, active] = kind === "probe"
      ? await catchError(deps.beforeExactProbe!(state, legClientOrderId))
      : await catchError(deps.beforeCancel!(state, legClientOrderId, orderId!));
    if (leaseError) return { ok: false, error: `cleanup lease ${kind} failed: ${leaseError.message}` };
    if (active !== true) return { ok: false, error: `cleanup lease lost before ${kind}` };
    return { ok: true };
  };

  const probeExact = async (
    legClientOrderId: string,
  ): Promise<{ exact: PerpProtectionExactStatus } | { error: string }> => {
    const lease = await checkLease("probe", legClientOrderId);
    if (!lease.ok) return lease;
    const [readError, rawStatus] = await catchError(
      statusReader.call(client, state.walletAddress, legClientOrderId),
    );
    if (readError) return { error: `exact status failed ${legClientOrderId}: ${readError.message}` };
    return { exact: readPerpProtectionOrderStatus(rawStatus) };
  };

  const classifySafeRetirement = async (
    legClientOrderId: string,
    exact: PerpProtectionExactStatus,
  ): Promise<{ retired: true } | { retired: false; error: string }> => {
    if (exact.kind === "terminal") return { retired: true };
    if (exact.kind !== "filled") {
      return {
        retired: false,
        error: exact.kind === "live"
          ? `cancel response did not retire live leg ${legClientOrderId}`
          : exact.kind === "unknown"
            ? `exact status remained unknown ${legClientOrderId}`
            : exact.kind === "indeterminate"
              ? `exact status remained indeterminate ${legClientOrderId}: ${exact.status}`
              : `exact status remained invalid ${legClientOrderId}: ${exact.error}`,
      };
    }
    const revalidation = await readAuthoritativePerpPositions(
      client,
      state.walletAddress,
      state.coin,
    );
    if ("error" in revalidation) {
      return {
        retired: false,
        error: `filled status position revalidation failed ${legClientOrderId}: ${revalidation.error}`,
      };
    }
    const position = revalidation.positions.find((item) => item.coin === state.coin);
    if (
      (position && !hasKnownPositionSize(position.size)) ||
      (position && hasPositivePositionSize(position.size))
    ) {
      return {
        retired: false,
        error: position && !hasKnownPositionSize(position.size)
          ? `filled status position size was malformed ${legClientOrderId}`
          : `filled status position remains open ${legClientOrderId}`,
      };
    }
    return { retired: true };
  };

  for (const legId of state.legClientOrderIds) {
    if (typeof legId !== "string" || legId.trim() === "") {
      pending.push(legId);
      errors.push("malformed protection leg cloid");
      continue;
    }
    const probe = await probeExact(legId);
    if ("error" in probe) {
      pending.push(legId);
      errors.push(probe.error);
      continue;
    }
    const exact = probe.exact;
    if (exact.kind === "invalid") {
      pending.push(legId);
      errors.push(`exact status invalid ${legId}: ${exact.error}`);
      continue;
    }
    if (exact.kind === "unknown") {
      // Keep the leg retryable. This path is commonly reached immediately
      // after a successful POST, while the exact index catches up.
      pending.push(legId);
      continue;
    }
    if (exact.kind === "terminal") {
      retired += 1;
      retiredLegClientOrderIds.push(legId);
      continue;
    }
    if (exact.kind === "filled") {
      // A fired protection trigger is not, by itself, proof that this
      // position is flat. Revalidate the position before retiring its cloid;
      // otherwise a partial fill could make the cleanup marker disappear while
      // the remaining exposure has no exit.
      const retirement = await classifySafeRetirement(legId, exact);
      if (!retirement.retired) {
        pending.push(legId);
        errors.push(retirement.error);
        continue;
      }
      retired += 1;
      retiredLegClientOrderIds.push(legId);
      continue;
    }
    if (exact.kind === "indeterminate") {
      pending.push(legId);
      errors.push(`exact status indeterminate ${legId}: ${exact.status}`);
      continue;
    }

    const oid = exactOrderIdNumber(exact.oid);
    if (oid === null) {
      pending.push(legId);
      errors.push(`exact status has unusable OID ${legId}`);
      continue;
    }
    const cancelLease = await checkLease("cancel", legId, oid);
    if (!cancelLease.ok) {
      pending.push(legId);
      errors.push(cancelLease.error);
      continue;
    }
    const [cancelError, cancelResult] = await catchError(
      client.cancelOrder({ coin: state.coin, orderId: oid }),
    );
    if (!cancelError) {
      const acceptance = readPerpProtectionCancelAcceptance(cancelResult);
      if (acceptance.accepted) {
        retired += 1;
        retiredLegClientOrderIds.push(legId);
        continue;
      }
      errors.push(`cancel response did not confirm ${legId} (${oid}): ${acceptance.reason}`);
    } else {
      errors.push(`cancel failed ${legId} (${oid}): ${cancelError.message}`);
    }

    // A resolved per-item error (or an ambiguous transport failure) is not
    // retirement proof. Re-probe exactly once, with a fresh lease assertion;
    // only an explicit terminal status or a filled trigger plus covered flat
    // position may retire the cloid.
    const reconciliationProbe = await probeExact(legId);
    if ("error" in reconciliationProbe) {
      pending.push(legId);
      errors.push(reconciliationProbe.error);
      continue;
    }
    const reconciliation = await classifySafeRetirement(legId, reconciliationProbe.exact);
    if (!reconciliation.retired) {
      pending.push(legId);
      errors.push(reconciliation.error);
      continue;
    }
    retired += 1;
    retiredLegClientOrderIds.push(legId);
  }

  return { retired, retiredLegClientOrderIds, pending, errors };
}

function readPerpProtectionCancelAcceptance(
  raw: unknown,
): { accepted: true } | { accepted: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { accepted: false, reason: "cancel response is not an object" };
  }
  if (readField(raw, "status") !== "ok") {
    return { accepted: false, reason: "cancel response status is not ok" };
  }
  const response = readField(raw, "response");
  if (readField(response, "type") !== "cancel") {
    return { accepted: false, reason: "cancel response type is not cancel" };
  }
  const statuses = readField(readField(response, "data"), "statuses");
  if (!Array.isArray(statuses) || statuses.length !== 1) {
    return { accepted: false, reason: "cancel response must contain exactly one item" };
  }
  const [status] = statuses;
  if (status === "success") return { accepted: true };
  if (status && typeof status === "object") {
    const error = readField(status, "error");
    if (typeof error === "string" && error.trim() !== "") {
      return { accepted: false, reason: error.trim() };
    }
  }
  return { accepted: false, reason: "cancel response item is not success" };
}

function exactOrderIdNumber(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function persistPendingProtectionCleanup(
  state: PerpProtectionCleanupState,
  retiredLegClientOrderIds: readonly string[],
  errors: readonly string[],
  deps: PerpProtectionCleanupDeps,
): Promise<void> {
  const record = deps.recordPendingCleanup ?? deps.recordCleanup;
  if (!record || state.legClientOrderIds.length === 0) return;
  const [error] = await catchError(
    deps.recordPendingCleanup
      ? deps.recordPendingCleanup(state, retiredLegClientOrderIds, errors)
      : deps.recordCleanup!(state, retiredLegClientOrderIds),
  );
  if (error) {
    throw new PerpProtectionCleanupPersistenceError(
      state,
      error,
      retiredLegClientOrderIds,
    );
  }
}

/**
 * Retry a cleanup record independently of the opening row. In particular, a
 * row already marked `cancelled` must not make a pending venue leg disappear
 * from the retry queue. If its pending marker cannot be persisted, the
 * returned promise rejects with `PerpProtectionCleanupPersistenceError`; its
 * `state` carries the still-pending cloids and `retiredLegClientOrderIds`
 * carries the exact cloids already retired before persistence failed.
 */
export async function retryPerpProtectionCleanup(
  client: PerpProtectionClient,
  state: PerpProtectionCleanupState,
  deps: PerpProtectionCleanupDeps = {},
): Promise<PerpProtectionCleanupResult> {
  const result = await retireSubmittedProtectionLegs(client, state, deps);
  if (result.pending.length > 0) {
    await persistPendingProtectionCleanup(
      { ...state, legClientOrderIds: [...result.pending] },
      result.retiredLegClientOrderIds,
      result.errors,
      deps,
    );
  }
  return result;
}

async function settleStaleProtectionCleanup(
  client: PerpProtectionClient,
  request: PerpProtectionAttachRequest,
  legClientOrderIds: readonly string[],
  deps: PerpProtectionCleanupDeps,
): Promise<PerpProtectionCleanupState | undefined> {
  const state: PerpProtectionCleanupState = {
    followerUserId: request.followerUserId,
    sourceItemId: request.sourceItemId,
    walletAddress: request.walletAddress,
    coin: request.coin,
    openingClientOrderId: request.clientOrderId,
    ...(request.protectionClaim?.orderId
      ? { openingOrderId: request.protectionClaim.orderId }
      : {}),
    legClientOrderIds: [...new Set(legClientOrderIds)],
  };
  if (state.legClientOrderIds.length === 0) return undefined;
  const result = await retireSubmittedProtectionLegs(client, state, deps);
  if (result.pending.length === 0) return undefined;
  const pending = { ...state, legClientOrderIds: [...result.pending] };
  await persistPendingProtectionCleanup(
    pending,
    result.retiredLegClientOrderIds,
    result.errors,
    deps,
  );
  return pending;
}

/**
 * Did Hyperliquid take every leg?
 *
 * PURE, and deliberately strict: anything other than the exact number of legs
 * coming back with a resting or filled order id is treated as not accepted. An
 * unreadable reply is not evidence of success, and the retry that follows is
 * safe because each leg's cloid is derived from its own trigger price.
 */
export function readTpSlAcceptance(
  result: unknown,
  legCount: number,
): { accepted: true } | { accepted: false; reason: string } {
  const statuses = tpSlStatuses(result);
  if (statuses.length === 0) {
    return { accepted: false, reason: "no statuses in the venue reply" };
  }
  const rejection = statuses
    .map((status) => readField(status, "error"))
    .find((error): error is string => typeof error === "string" && error.trim() !== "");
  if (rejection) return { accepted: false, reason: rejection };

  const accepted = statuses.filter((status) => {
    for (const key of ["resting", "filled"] as const) {
      const detail = readField(status, key);
      if (detail && typeof detail === "object" && readField(detail, "oid") !== undefined) {
        return true;
      }
    }
    return false;
  }).length;
  if (accepted !== legCount) {
    return { accepted: false, reason: `accepted ${accepted} of ${legCount} trigger legs` };
  }
  return { accepted: true };
}

function tpSlStatuses(result: unknown): unknown[] {
  const statuses = readField(readField(readField(result, "response"), "data"), "statuses");
  return Array.isArray(statuses) ? statuses : [];
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Reflect.get(value, key);
}

/** One opening order that may still carry live legs, as the cancel path reads it. */
export interface AttachedPerpProtectionRow {
  orderId: string;
  /**
   * The opening order's own client order id, which is what says WHICH source
   * this row was mirrored from. Null means the row cannot be attributed, and an
   * unattributable row is never retired: see `cancelPerpProtection`.
   */
  clientOrderId: string | null;
  perpProtection: PerpProtectionPlan | null;
  perpProtectionStatus: string | null;
  /** Existing generation identity, when the database row already has one. */
  cleanupState?: PerpProtectionCleanupState | null;
}

export interface PerpProtectionCancelRequest {
  followerUserId: string;
  /** The close that triggered this, carried for the audit trail only. */
  sourceItemId: string;
  walletAddress: `0x${string}`;
  coin: string;
  /**
   * The follower client order ids this close's attribution scan resolved: the
   * mirrored opens that belong to the SOURCE that just closed, and nothing else.
   *
   * This is the whole scope of the cancel. `loadPerpCloseContext` already
   * computes it (it is the same set the close is sized against), so nothing new
   * is derived here; it is threaded through so the retire can be as narrow as
   * the sizing already is.
   *
   * EMPTY MEANS CANCEL NOTHING, never "cancel everything for this coin". See
   * `cancelPerpProtection`.
   */
  attributedClientOrderIds: readonly string[];
}

export interface PerpProtectionCancelDeps {
  loadAttachedPlans(): Promise<AttachedPerpProtectionRow[]>;
  /** Mark only the status observed by the scoped load; stale recovery must lose. */
  markCancelled(orderId: string, expectedStatus?: string | null): Promise<void>;
  /** Preserve every leg that was not proven retired by the foreground cancel. */
  recordCleanup?(
    state: PerpProtectionCleanupState,
    retiredLegClientOrderIds?: readonly string[],
  ): Promise<unknown>;
}

export interface PerpProtectionCancelResult {
  /** Legs the venue confirmed cancelled. */
  retired: number;
  /** Legs that may still be resting because the cancel itself did not land. */
  stranded: number;
  /** Why, for the operator log line. */
  errors: string[];
  /**
   * The close named no attributed orders, so nothing was read and nothing was
   * cancelled. Distinguished from an ordinary empty result because it means a
   * possibly-live plan was deliberately left alone, which an operator should be
   * able to see rather than infer.
   */
  skippedUnattributed: boolean;
}

/**
 * Retire the legs the mirror attached, after a mirrored SOURCE close is placed.
 *
 * THE SOURCE'S CLOSE WINS. The attached exit is a safety net for positions
 * nothing else will ever close; once the trade being copied has closed and that
 * close has reached the follower's account, a resting trigger is no longer
 * protection. It is an order waiting to fire against whatever the follower opens
 * in that coin next, which they never asked for and would not see coming.
 *
 * ONLY THE MIRROR'S OWN LEGS. Every cancel is matched by client order id against
 * the plan recorded when the legs were SUBMITTED, so a stop the follower set by
 * hand on the same coin is never touched. Matching on "reduce-only trigger for
 * this coin" would have been simpler and would have cancelled theirs too.
 *
 * SUBMITTED, NOT CONFIRMED, WHICH IS WHY AN `unprotected` ROW IS READ TOO. A
 * group Hyperliquid only partly accepted leaves whatever it DID take resting,
 * and those are exactly the legs no one else is coming for. They are cancelled
 * here; the row keeps saying `unprotected`, because the follower's stop still
 * never went on and that is the only line in the system that says so. Ids that
 * were never taken cost nothing, since only cloids found resting are acted on.
 *
 * ONLY THE CLOSING SOURCE'S LEGS, which is a strictly narrower rule than the one
 * above and was the harder half to get right. A follower can follow two traders
 * in one coin and hold a signal-sourced mirror in it besides, and each of those
 * opens carries its own attached plan. Scoping the retire to "this follower, this
 * coin" reads as ownership but is not: it retires plans belonging to positions
 * that are still open, leaving live leverage with no stop, and it does so
 * silently because the rows end up `cancelled` rather than `unprotected`. The
 * signal case is the worst of it, since a signal has no source that ever closes
 * and its stop is the only exit it will ever have.
 *
 * So the scope is `request.attributedClientOrderIds`, the exact set the close was
 * SIZED against, and a row is retired only when it names itself as one of them.
 * An EMPTY set retires nothing at all. Broad cancelling is what caused the
 * defect; cancelling nothing leaves a stale trigger over a closed position, which
 * is a cancellable annoyance rather than an unprotected leveraged position.
 *
 * NEVER THROWS, and only ever runs AFTER the close has been placed. An exit must
 * never be harder to place than an entry, so nothing in here is allowed to become
 * a reason a close does not go out.
 */
export async function cancelPerpProtection(
  client: PerpProtectionClient,
  request: PerpProtectionCancelRequest,
  deps: PerpProtectionCancelDeps,
): Promise<PerpProtectionCancelResult> {
  const result: PerpProtectionCancelResult = {
    retired: 0,
    stranded: 0,
    errors: [],
    skippedUnattributed: false,
  };

  // Checked BEFORE the load, so an unattributed close makes no database read and
  // no venue read either. There is nothing it could legitimately act on.
  const attributed = new Set(request.attributedClientOrderIds);
  if (attributed.size === 0) {
    result.skippedUnattributed = true;
    return result;
  }

  const [loadError, rows] = await catchError(deps.loadAttachedPlans());
  if (loadError) {
    result.errors.push(`plans-unreadable: ${loadError.message}`);
    return result;
  }
  // The query behind `loadAttachedPlans` is scoped to the same set, so this
  // repeats it. Deliberately: the query is the efficient scope and this is the
  // guarantee. The whole defect was a scope that lived only in a WHERE clause,
  // where nothing could hold it, and one that a test can hold is worth the four
  // lines. A row that cannot name its source is not attributable and is left
  // alone rather than assumed to belong here.
  const scoped = rows.filter(
    (row) => row.clientOrderId !== null && attributed.has(row.clientOrderId),
  );
  /** A cloid may be referenced by more than one scoped row in legacy data. */
  type WantedLeg = { orderId: string; legClientOrderId: string };
  const wanted = new Map<string, WantedLeg[]>();
  const cleanupStateByOrderId = new Map<string, PerpProtectionCleanupState>();
  const pendingByOrderId = new Map<string, Set<string>>();
  const retiredByOrderId = new Map<string, Set<string>>();

  for (const row of scoped) {
    const fallbackLegs = perpProtectionCancelPlan(row.perpProtection, row.perpProtectionStatus);
    const legClientOrderIds = [...new Set(
      (row.cleanupState?.legClientOrderIds ?? fallbackLegs)
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim()),
    )];
    // A Phase-B/Phase-C crash with no deterministic legs has nothing that can
    // be live at the venue. The status CAS below prevents a stale recovery
    // callback from attaching triggers after this close wins the row.
    if (legClientOrderIds.length === 0) continue;

    const cleanupState: PerpProtectionCleanupState = row.cleanupState
      ? { ...row.cleanupState, legClientOrderIds }
      : {
          followerUserId: request.followerUserId,
          // Legacy attached plans predate the source metadata in the marker;
          // the opening row id is the stable generation identity available here.
          sourceItemId: `copy-mirror:perp-protection-cleanup:${row.orderId}`,
          walletAddress: request.walletAddress,
          coin: request.coin,
          openingClientOrderId: row.clientOrderId!,
          openingOrderId: row.orderId,
          legClientOrderIds,
        };
    cleanupStateByOrderId.set(row.orderId, cleanupState);
    pendingByOrderId.set(row.orderId, new Set(legClientOrderIds));
    retiredByOrderId.set(row.orderId, new Set());

    for (const legClientOrderId of legClientOrderIds) {
      let cloid: string;
      try {
        cloid = toCloid(legClientOrderId);
      } catch {
        result.errors.push(`malformed protection leg cloid ${legClientOrderId}`);
        continue;
      }
      wanted.set(cloid, [
        ...(wanted.get(cloid) ?? []),
        { orderId: row.orderId, legClientOrderId },
      ]);
    }
  }

  const persistPending = async (
    orderId: string,
  ): Promise<void> => {
    const cleanupState = cleanupStateByOrderId.get(orderId);
    const pending = pendingByOrderId.get(orderId);
    if (!cleanupState || !pending || pending.size === 0) return;
    const retired = [...(retiredByOrderId.get(orderId) ?? [])];
    if (!deps.recordCleanup) {
      result.errors.push(`cleanup-persistence-unavailable ${orderId}`);
      return;
    }
    const [recordError] = await catchError(
      deps.recordCleanup(
        { ...cleanupState, legClientOrderIds: [...pending] },
        retired,
      ),
    );
    if (recordError) {
      result.errors.push(`cleanup-persistence-failed ${orderId}: ${recordError.message}`);
    }
  };

  // Rows with an intent marker but no submitted legs can be marked cancelled
  // before the venue read. Rows with any deterministic leg stay unresolved
  // until every one is either accepted by cancel or exact-reconciled later.
  for (const row of scoped) {
    if (
      row.perpProtectionStatus === null &&
      row.perpProtection !== null &&
      typeof row.perpProtection === "object" &&
      Reflect.get(row.perpProtection, "copyMirrorProtectionIntent") === true &&
      !cleanupStateByOrderId.has(row.orderId)
    ) {
      const [markError] = await catchError(() =>
        deps.markCancelled(row.orderId, row.perpProtectionStatus),
      );
      if (markError) result.errors.push(`mark-cancelled-failed: ${markError.message}`);
    }
  }
  if (wanted.size === 0) {
    // A malformed/non-hashable leg still names an obligation even though it
    // cannot be matched in the aggregate response. Keep it durable instead of
    // silently dropping the only handle the operator has for repair.
    for (const orderId of cleanupStateByOrderId.keys()) {
      result.stranded += pendingByOrderId.get(orderId)?.size ?? 0;
      await persistPending(orderId);
    }
    return result;
  }

  const [readError, open] = await catchError(client.openOrders(request.walletAddress));
  if (readError) {
    // Unknown, so nothing is marked cancelled. Preserve every exact cloid in a
    // durable generation marker; the independent backlog can then probe each
    // one after the aggregate read recovers.
    for (const orderId of cleanupStateByOrderId.keys()) {
      result.stranded += pendingByOrderId.get(orderId)?.size ?? 0;
      await persistPending(orderId);
    }
    result.errors.push(`open-orders-unreadable: ${readError.message}`);
    return result;
  }
  if (!Array.isArray(open)) {
    for (const orderId of cleanupStateByOrderId.keys()) {
      result.stranded += pendingByOrderId.get(orderId)?.size ?? 0;
      await persistPending(orderId);
    }
    result.errors.push("open-orders-invalid");
    return result;
  }

  const seenOpenOrders = new Set<string>();
  for (const order of open) {
    if (!order || typeof order !== "object") continue;
    const coin = readField(order, "coin");
    const cloid = readField(order, "cloid");
    const oid = readField(order, "oid");
    if (coin !== request.coin || typeof cloid !== "string" || !wanted.has(cloid)) continue;
    const openOrderKey = `${cloid}:${typeof oid === "string" || typeof oid === "number" ? oid : ""}`;
    if (seenOpenOrders.has(openOrderKey)) continue;
    seenOpenOrders.add(openOrderKey);
    if (typeof oid !== "number" || !Number.isSafeInteger(oid) || oid < 0) {
      result.errors.push(`cancel-unusable-oid ${cloid}`);
      continue;
    }
    const [cancelError, cancelResult] = await catchError(
      client.cancelOrder({ coin: request.coin, orderId: oid }),
    );
    const targets = wanted.get(cloid) ?? [];
    if (!cancelError) {
      const acceptance = readPerpProtectionCancelAcceptance(cancelResult);
      if (acceptance.accepted) {
        for (const target of targets) {
          pendingByOrderId.get(target.orderId)?.delete(target.legClientOrderId);
          retiredByOrderId.get(target.orderId)?.add(target.legClientOrderId);
          result.retired += 1;
        }
        continue;
      }
      result.errors.push(`cancel-unconfirmed ${cloid}: ${acceptance.reason}`);
    } else {
      result.errors.push(`cancel-failed ${cloid}: ${cancelError.message}`);
    }
  }

  // Only an exact cancel acceptance proves a leg is no longer live. Aggregate
  // absence is not proof, so every unmatched/unconfirmed cloid stays in the
  // generation marker for exact reconciliation by the restart backlog.
  for (const [orderId, pending] of pendingByOrderId) {
    if (pending.size > 0) {
      result.stranded += pending.size;
      await persistPending(orderId);
      continue;
    }
    const row = scoped.find((candidate) => candidate.orderId === orderId);
    if (!row) continue;
    // ONLY A ROW THAT WAS ATTACHED BECOMES `cancelled`. A row the attach gave up
    // on says `unprotected`, which is the one line in the system saying this
    // follower's stop never went on, and `cancelled` is exactly what hides a row
    // from the backlog that counts them. Its orphaned legs are still retired
    // above, which is the part that matters at the venue; the record of the
    // failed attach is not overwritten to tidy up after it. Leaving the status
    // alone costs a repeated lookup on a later close for the same order, which
    // is the cheaper side of that trade.
    if (row.perpProtectionStatus !== "attached") continue;
    const [markError] = await catchError(() =>
      deps.markCancelled(row.orderId, row.perpProtectionStatus),
    );
    if (markError) result.errors.push(`mark-cancelled-failed: ${markError.message}`);
  }
  return result;
}
