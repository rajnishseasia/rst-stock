/**
 * The three ways a perp mirror reaches Hyperliquid (audit H7: own module).
 *
 * `processPerpCandidate` had grown to hold all of them inline: resuming a stored
 * PENDING row, mirroring a reduce-only close, and opening fresh exposure. Each
 * is a self-contained unit with its own guards, and each was lifted VERBATIM out
 * of `copy-mirror.ts`. Nothing about their behavior changed in the move: same
 * checks, same order, same outcome strings, same log lines.
 *
 * The database and venue work they still need is injected as
 * `PerpMirrorExecutionDeps` rather than reached for, so the poller keeps owning
 * its own connection and client while this module stays readable.
 *
 * NOTE ON SCOPE: a mirrored open from x_signal / paste.trade still has no
 * reduce-only close of its own. Only a mirrored SOURCE close produces one, and a
 * signal has no source that ever closes, so nothing on these paths will exit
 * that position for the follower.
 *
 * What DOES now cover it, when and only when the follower has asked for it, is
 * the take-profit and stop-loss they configure on the follow. Both open paths
 * below hand off to `attachPerpProtection` after a placement lands, and the
 * close path retires those legs once the source's own close reaches the account.
 * A follow with nothing configured is untouched by all of it: no venue call, no
 * row write, no behaviour change. Do not read "close" below as meaning mirrored
 * perps are exited automatically; read the protection hand-off as meaning they
 * are exited automatically only for followers who set a level themselves.
 */

import type { schema } from "@trade-bot/db";
import { createProductionLogger } from "@trade-bot/logger";
import { catchError } from "@trade-bot/utils";
import {
  isCanonicalPerpCoin,
  networkFromEnv,
  isPerpDexCovered,
  isTradableOnHl,
  type HyperliquidClient,
  type MarginMode,
  type PerpSide,
} from "@trade-bot/hyperliquid";

import {
  mirrorIdempotencyKey,
  normalizePerpDailyCap,
} from "../../../api/src/lib/copy-mirror";
import type { PerpOrderSubmitInput } from "../../../api/src/lib/perp-orders";

import { decidePerpCloseConsumption, type QueuedDeliveryRow } from "./copy-mirror-close-pairing";
import type {
  PerpProtectionAttachRequest,
  PerpProtectionCancelRequest,
  PerpProtectionRule,
} from "./copy-mirror-perp-protection";
import { explicitPerpSide, parsePositiveDecimal } from "./copy-mirror-perp-decimal";
import {
  decidePerpMirror,
  decidePerpReduceOnlyMirror,
} from "./copy-mirror-perp-decisions";
import {
  resolveEffectivePerpLeverage,
} from "./copy-mirror-perp-leverage";
import type { PerpPlacementIntent } from "./copy-mirror-perp-observability";
import {
  decidePerpOpenAgainstPosition,
  findPerpPosition,
} from "./copy-mirror-perp-position-guard";
import { withinDailyCap } from "../../../api/src/lib/copy-mirror";
import { perpProtectionRetiresOnClose } from "./copy-mirror-perp-protection";
import { decidePerpResumeParity } from "./copy-mirror-perp-resume-parity";
import { resolveEffectiveMirrorCap } from "./copy-mirror-policy-caps";
import type {
  MirrorProcessOutcome,
  MirrorSourceCandidate,
  PerpMirrorGuards,
} from "./copy-mirror";

const logger = createProductionLogger();

const LOG_SERVICE = "copy-mirror";

/**
 * Keep explicit invalid raw configuration distinct from the generic equity
 * fallback. Polling supplies `perpDailyCap`; direct callers from older tests
 * may only supply `dailyCap`, so the latter remains a compatibility fallback.
 */
function effectivePerpDailyCap(guards: PerpMirrorGuards): number | null {
  return guards.perpDailyCap !== undefined
    ? guards.perpDailyCap
    : normalizePerpDailyCap(guards.dailyCap);
}

type PerpOrderRow = typeof schema.orders.$inferSelect;

export type CurrentPerpLeveragePolicy = {
  currentUserMaxLeverage: unknown;
  currentFollowMaxLeverage: unknown | null | undefined;
  currentMaxTradeSize?: unknown;
  currentMaxCoinSize?: unknown;
};

/**
 * Result of the execution-time policy re-read. A refusal is carried as an
 * outcome so the open path can distinguish withdrawn consent from an
 * unavailable policy without ever entering its venue-writing callback.
 */
export type PerpOpenPolicyResolution =
  | {
      policy: CurrentPerpLeveragePolicy;
      executionDeps?: PerpMirrorExecutionDeps;
      /** Client rebuilt from the credential reread while the policy lock is held. */
      client?: HyperliquidClient;
      walletAddress?: `0x${string}`;
    }
  | { refusal: MirrorProcessOutcome };

type PerpLeverageDecisionAudit = {
  sourceLeverage: unknown;
  stagedUserMaxLeverage: unknown;
  stagedFollowMaxLeverage: unknown | null | undefined;
  currentUserMaxLeverage: unknown;
  currentFollowMaxLeverage: unknown | null | undefined;
  venueMaxLeverage: unknown;
  storedOrderLeverage?: unknown;
  effectiveLeverage: number;
};

/**
 * What it takes to call a mirrored position ABSENT, so an empty snapshot may
 * retire a one-shot close. See the reduce-only branch of
 * `resumePendingPerpMirror`.
 *
 * The COUNT is the load-bearing half, and it is the third attempt at this
 * condition. Row age was the first and elapsed-since-first-read was the second,
 * and both were the same mistake: they measure TIME, which passes just as well
 * while nothing is looking. Switch mirroring off for an hour under either one
 * and it comes back already satisfied, with a single unverified read behind it.
 * A count cannot be run up by a quiet interval. It only moves when a read
 * happens.
 *
 * The elapsed floor stays as the second half, to stop the required reads from
 * all landing inside a few seconds of each other and re-reading one lagging
 * snapshot. Three reads spanning five minutes is the bar.
 *
 * Neither resets on revival, deliberately. The reconciler can cancel a resumed
 * row every cycle and the caller revives it every time, so a streak that reset
 * there would reset forever and the close would never retire at all.
 *
 * Erring long is nearly free here. The delivery is only retrying, no order is
 * placed and nothing is consumed, and closes are exempt from the attempt
 * ceiling. Erring short spends an exit that can never be reissued.
 */
const CLOSE_ABSENCE_CONFIRM_MS = 5 * 60_000;
const CLOSE_ABSENCE_MIN_OBSERVATIONS = 3;

/**
 * Why a placement came back "syncing".
 *
 * "syncing" is three materially different situations wearing one word, and while
 * the placement returned a bare `MirrorProcessOutcome` string no caller could
 * tell them apart:
 *
 *  - "recovered-at-venue": the placement found its OWN deterministic cloid
 *    already live at Hyperliquid, read the broker order id back, and stamped the
 *    row SUBMITTED with it. An order under this identity demonstrably EXISTS.
 *  - "status-write-failed": Hyperliquid accepted the submission and the local
 *    status write then threw. The order is live, but nothing was read back from
 *    the venue, so there is no order id and no independent confirmation.
 *  - "reconcile": a rejection classified as non-terminal and left PENDING for the
 *    Hyperliquid reconciler to settle. No exposure was established.
 *
 * A DISCRIMINATED SHAPE rather than three more bare literals, deliberately.
 * Adding "recovered-at-venue" to `MirrorProcessOutcome` would silently change the
 * meaning of every existing `=== "syncing"` in this pipeline, including the ones
 * that decide whether a mirrored CLOSE is consumed, and a close consumed without
 * being placed is the failure this branch has fixed nine times. Widening a shape
 * the compiler checks is the version that cannot be got wrong by omission.
 */
export type PerpPlacementSyncingReason =
  | "recovered-at-venue"
  | "status-write-failed"
  | "reconcile"
  /** Another durable owner currently holds the pending placement lease. */
  | "claim-held";

/**
 * What one Hyperliquid placement attempt reports back.
 *
 * `outcome` is the same vocabulary as before and is what still travels upward as
 * the delivery's `MirrorProcessOutcome`; the reason rides alongside it and is
 * read by exactly one gate (see `perpPlacementProvesExposure`).
 *
 * `filledSizeCoin` is set only on a REDUCE-ONLY placement, and only when the
 * venue's own report could be read: the cumulative size the close's IoC legs
 * positively filled, which for a thin book is less than the size that was asked
 * for. It is `undefined` for every open, and for a close whose response shape
 * this pipeline could not parse. That third state is not zero, and the one gate
 * that reads it (`perpCloseRetirementSizeCoin`) keeps them apart.
 */
export type PerpPlacementResult =
  // "no-qty" is a placement that never reached the venue: the stored or
  // resolved order input did not survive validation, so nothing was submitted
  // and nothing about the row changed. It travels with the others because
  // callers complete the delivery on `outcome` alone.
  | {
      outcome: "placed" | "duplicate" | "rejected" | "no-qty" | "daily-cap" | "zero-fill";
      filledSizeCoin?: string;
      reason?: "no-qty" | "below-min-notional" | "dollar-cap" | "identity-conflict";
    }
  | { outcome: "syncing"; reason: PerpPlacementSyncingReason };

/**
 * A durable order intent prepared before the users-row policy lock is taken.
 *
 * The intent is deliberately a separate value from a venue submission.  A
 * venue call can be accepted even when the transaction which held the policy
 * lock later rolls back, so the order row must already be committed and the
 * locked callback must not perform rollback-sensitive order writes.
 */
export type PerpPreparedMirrorOrder = {
  orderId: string;
  /** Unique durable owner token encoded in the order's lease marker. */
  claimToken: string;
  /** Exact timestamp paired with `claimToken` for the final ownership CAS. */
  claimAt: Date;
  /** Leverage currently persisted on the exact PENDING row prepared above. */
  durableLeverage?: number | null;
  /** Existing PENDING rows must be checked at the venue before a retry. */
  reconcileVenueBeforeSubmit: boolean;
  params: PerpMirrorPlacementParams;
  input: PerpOrderSubmitInput;
};

export type PerpOpenDurableLeverageResult =
  | { action: "unchanged" | "lowered"; leverage: number }
  | { action: "claim-lost" };

export type PerpPrepareMirrorOrderResult =
  | { prepared: PerpPreparedMirrorOrder }
  | { result: PerpPlacementResult };

/** A venue result which has not yet been persisted to the durable order row. */
export type PerpVenueSubmission =
  | { kind: "accepted"; brokerOrderId?: string; filledSizeCoin?: string }
  | { kind: "recovered"; brokerOrderId: string }
  | { kind: "rejected"; reason?: string; error: string }
  | { kind: "reconcile"; reason: PerpPlacementSyncingReason; error?: string }
  /** No venue request was made because the claim/read proof was unavailable. */
  | { kind: "not-submitted"; reason: "claim-held" | "reconcile"; error?: string }
  | { kind: "ambiguous"; error: unknown };

/**
 * Does Phase B leave enough uncertainty that an accepted venue order may be
 * carrying exposure without the requested exit? A definitive rejection never
 * reached the venue as an accepted order, so recording it as unprotected would
 * create a false backlog row. The policy-transaction catch uses this only after
 * the submission has actually returned; a transport throw before a submission
 * value exists is deliberately not evidence of an accepted order.
 */
function perpSubmissionMayLeaveUnprotected(
  submission: PerpVenueSubmission | null,
): submission is Extract<
  PerpVenueSubmission,
  { kind: "accepted" | "recovered" | "ambiguous" | "reconcile" }
> {
  return submission?.kind === "accepted" ||
    submission?.kind === "recovered" ||
    submission?.kind === "ambiguous" ||
    submission?.kind === "reconcile";
}

/**
 * May the follower's own take-profit / stop-loss be attached over this placement?
 *
 * "placed" has always qualified: this attempt reached the venue and did so now.
 *
 * "recovered-at-venue" qualifies for the SAME reason, learned one attempt later.
 * The cloid match is a read of Hyperliquid's own fills and open orders, the
 * broker order id came back with it, and the row is stamped SUBMITTED on the
 * strength of that. There is nothing weaker about the evidence than a fresh
 * accept, only about when it arrived. Leaving it out meant the likeliest
 * "syncing" of all, a mirror interrupted mid-placement, came back permanently
 * without the stop its follow asked for.
 *
 * "status-write-failed" and "reconcile" do NOT qualify, and the difference is not
 * cosmetic. Neither one has read anything back from the venue: the first knows
 * only that a submission was accepted (not that it filled, and with no order id
 * to check), and the second means the order was rejected and nobody yet knows
 * whether anything exists. A trigger submitted over exposure that may not exist
 * is the resting-order hazard the cancel path exists to prevent: it survives the
 * mirror entirely and fires against whatever the follower opens in that coin
 * next. Both keep recording `unprotected` through `notePerpProtectionUnattached`,
 * which is already wired.
 *
 * `attachPerpProtection` is a second, independent backstop rather than a reason
 * to relax this one. It reads `listPositions` first and returns
 * `no-position-to-protect` when the coin is absent, so a recovered order that
 * never actually filled attaches nothing and is recorded unprotected anyway.
 *
 * NOT USED ON THE CLOSE PATH, deliberately. A close asks the opposite question,
 * "may the follower's stop be TORN DOWN", and the answer there still requires
 * "placed": a recovered close proves an order exists, not that the position is
 * gone, and retiring the legs over an unconfirmed exit leaves a leveraged
 * position with neither.
 */
export function perpPlacementProvesExposure(result: PerpPlacementResult): boolean {
  return (
    result.outcome === "placed" ||
    (result.outcome === "syncing" && result.reason === "recovered-at-venue")
  );
}

/**
 * The size `perpProtectionRetiresOnClose` is actually asked about.
 *
 * A mirrored close goes out `Market`, which Hyperliquid resolves to TIF `Ioc`:
 * it fills what it can immediately and cancels the rest. So a close has a second
 * way of coming up short that the sizing math cannot see. The REQUESTED size on
 * a full source close equals the mirrored exposure by construction, which meant
 * a close that filled a fraction of it still answered "the position is gone" and
 * cancelled the follower's take-profit and stop-loss over whatever was left. The
 * placement's own sweep measures that remainder and logs it; this is what makes
 * the retire gate see it. Nothing re-attaches protection afterwards, and a plan
 * marked `cancelled` is filtered out of `emitUnprotectedPerpBacklog`, so an
 * operator never saw it either.
 *
 * A TRI-STATE, and the third state is the reason this is not simply "trust the
 * fill". `perpOrderFilledSize` returns null for any venue response shape it
 * cannot positively parse. Unknown is not proof that the requested size filled,
 * so protection stays attached until reconciliation confirms the venue fill or
 * the remaining position. The close itself remains unblocked.
 *
 * The comparison itself is untouched: `perpProtectionRetiresOnClose` stays a
 * pure `closed >= exposure` and keeps every case its tests pin. A positively
 * read fill can only ever be smaller than what was requested, so this can only
 * make the gate MORE reluctant to retire, never less.
 */
export function perpCloseRetirementSizeCoin(
  result: PerpPlacementResult,
): string | null {
  return result.outcome === "placed" && typeof result.filledSizeCoin === "string"
    ? result.filledSizeCoin
    : null;
}

/** Everything `placePerpMirrorOrder` needs. Named so both call sites share it. */
export interface PerpMirrorPlacementParams {
  followerUserId: string;
  /** Follow identity used to bind durable protection metadata. */
  followId?: string;
  /** The source trade this mirror came from, for the audit trail. */
  sourceItemId?: string;
  brokerAccountId: string;
  brokerCredentialId: string;
  coin: string;
  side: PerpSide;
  sizeCoin: string;
  leverage: number;
  marginMode: MarginMode;
  reduceOnly?: boolean;
  clientOrderId: string;
  copySourceLabel?: string;
  /** The mid the guardrails were computed against, as HL's own decimal string. */
  markPrice?: string;
  /** Current venue size precision used to validate the exact open payload. */
  sizeDecimals?: number;
  /** Current per-order cap used to validate the exact open payload. */
  maxOrderDollars?: number;
  /** Authoritative per-user UTC-day open cap, claimed in Phase A. */
  dailyCap?: number;
  /**
   * Which call site this is. Logged so a fresh open, a resumed PENDING row
   * and a reduce-only close are distinguishable in the audit trail; it has
   * no effect on what is sent to the venue.
   */
  intent: PerpPlacementIntent;
  /** Dollar notional the caps were enforced against, when the caller computed one. */
  orderDollars?: number;
  /** Non-secret staged/current/venue policy values used for this open. */
  leveragePolicy?: PerpLeverageDecisionAudit;
  /**
   * The follow's exit rule captured with the Phase-A intent. It is carried into
   * post-commit protection work so a policy transaction failure cannot lose the
   * follower's requested protection while the order remains reconcilable.
   */
  protectionRuleSnapshot?: PerpProtectionRule | null;
}

/**
 * The poller-owned work these paths still need: the database reads, the venue
 * writes, and the single order-row update a re-clamped resume performs.
 */
export interface PerpMirrorExecutionDeps {
  perpDexModeReady(
    client: HyperliquidClient,
    walletAddress: `0x${string}`,
    ctx: { followerUserId: string; sourceItemId: string; coin: string },
  ): Promise<boolean>;
  applyPerpLeverage(
    client: HyperliquidClient,
    params: {
      followerUserId: string;
      sourceItemId: string;
      coin: string;
      leverage: number;
      marginMode: MarginMode;
    },
  ): Promise<boolean>;
  placePerpMirrorOrder(
    client: HyperliquidClient,
    params: PerpMirrorPlacementParams,
  ): Promise<PerpPlacementResult>;
  /**
   * Phase A: commit a PENDING intent before the policy transaction starts.
   * Optional so the extracted execution module remains usable by small unit
   * fakes and by reduce-only paths, which intentionally keep the old flow.
   */
  preparePerpMirrorOrder?(
    params: PerpMirrorPlacementParams,
  ): Promise<PerpPrepareMirrorOrderResult>;
  /** Phase B: submit an already durable intent while the policy lock is held. */
  submitPerpMirrorOrder?(
    client: HyperliquidClient,
    prepared: PerpPreparedMirrorOrder,
  ): Promise<PerpVenueSubmission>;
  /**
   * Prove the exact PENDING claim and, when needed, lower its stored leverage.
   * This runs through the policy transaction's user/order locks. A lowering is
   * deliberately reported to the caller so it can commit and retry without any
   * venue call in the transaction that changed the durable ceiling.
   */
  ensurePerpOpenLeverage?(
    prepared: PerpPreparedMirrorOrder,
    maxLeverage: number,
  ): Promise<PerpOpenDurableLeverageResult>;
  /**
   * Phase C: finalize an accepted/rejected/ambiguous result in an independent
   * short transaction after the policy lock commits.
   */
  finalizePerpMirrorOrder?(
    prepared: PerpPreparedMirrorOrder,
    submission: PerpVenueSubmission,
  ): Promise<PerpPlacementResult>;
  /**
   * Persist a resume's re-clamped leverage. Throwing is the caller's signal to
   * refuse. A phased open supplies its durable claim token so this metadata CAS
   * cannot overwrite a later retry which reclaimed the PENDING row.
   */
  recordResumeLeverageClamp(
    orderId: string,
    leverage: number,
    claimToken?: string,
  ): Promise<void>;
  /**
   * Record one empty position read, or clear the streak.
   *
   * `at` is the moment the venue read as empty: the first-seen stamp is kept if
   * one is already there and the observation count goes up by one. Null clears
   * both, because a position was seen and the streak is over.
   *
   * Throwing is the caller's signal to hold: an unrecorded observation is one
   * that cannot be counted toward confirming absence, and a close may not be
   * retired on a streak we failed to write down.
   */
  recordCloseAbsenceObservation(orderId: string, at: Date | null): Promise<void>;
  loadPerpCloseContext(
    cand: MirrorSourceCandidate,
    position: { side: PerpSide; size: string } | null,
  ): Promise<{
    sourcePositionSizeDecimal: string;
    mirroredExposureSizeDecimal: string;
    /**
     * The follower client order ids behind `mirroredExposureSizeDecimal`, which
     * is the only honest scope for retiring protection: everything else the
     * follower holds in this coin belongs to another follow, or to a signal with
     * no source that ever closes.
     */
    attributedClientOrderIds: string[];
  } | null>;
  loadQueuedSiblingDeliveries(
    cand: MirrorSourceCandidate,
  ): Promise<{ rows: QueuedDeliveryRow[]; truncated: boolean }>;
  /**
   * Did this follower's paired OPEN for this coin finish in a state where the
   * venue may hold exposure the position read has not surfaced yet (a
   * "syncing" outcome)? Completed deliveries are not in the pending queue, so
   * the sibling scan cannot see them.
   */
  pairedOpenOutcomeAmbiguous(cand: MirrorSourceCandidate): Promise<boolean>;
  /** `excludeOrderId` omits one row, so a resume does not count against itself. */
  countMirrorsToday(followerUserId: string, excludeOrderId?: string): Promise<number | null>;
  /**
   * Count only accepted, non-reduce Hyperliquid PERP copymirror entries for
   * the follower's current UTC day. The generic count includes equity mirrors
   * and reduce-only closes, so it must never gate a perp entry.
   */
  countPerpDailySlots?(followerUserId: string, excludeOrderId?: string): Promise<number | null>;
  /** Check total current/reserved exposure while the caller holds its user lock. */
  checkPerpCoinCap?(params: {
    followerUserId: string;
    symbol: string;
    brokerAccountId: string;
    brokerCredentialId: string;
    requestedSizeCoin: string;
    maxCoinSize: number;
    excludeOrderId?: string;
  }): Promise<"allowed" | "coin-cap" | "unavailable">;
  /**
   * Attach the follower's own take-profit and stop-loss to a position an open
   * just created, when they have configured one.
   *
   * NEVER THROWS and never returns anything the caller acts on. The entry order
   * is already live at the venue by the time this runs, so an error escaping
   * here would requeue a delivery whose order exists and invite a second
   * placement. A follow with no exit configured makes no venue call at all.
   */
  attachPerpProtection(
    client: HyperliquidClient,
    params: PerpProtectionAttachRequest,
  ): Promise<void>;
  /**
   * Retire the legs a previous open attached, once a mirrored SOURCE close has
   * been placed for that position.
   *
   * NEVER THROWS, for the same reason and one more: it runs on the CLOSE path,
   * and nothing on a close path may become a reason an exit does not go out.
   */
  cancelPerpProtection(
    client: HyperliquidClient,
    params: PerpProtectionCancelRequest,
  ): Promise<void>;
  /**
   * Record that an open which may be live at the venue carries no attached exit,
   * because its placement outcome is unresolved ("syncing") and no trigger was
   * submitted.
   *
   * NEVER THROWS, and writes nothing at all for a follow with no exit
   * configured. Without it the skip leaves `perp_protection_status` NULL, and
   * the operator backlog counts 'unprotected', so a missing stop surfaces
   * nowhere.
   */
  notePerpProtectionUnattached(
    params: PerpProtectionAttachRequest,
    reason: string,
  ): Promise<void>;
}

interface PerpMirrorExecutionContext {
  client: HyperliquidClient;
  walletAddress: `0x${string}`;
  cand: MirrorSourceCandidate;
  brokerCredentialId: string;
  deps: PerpMirrorExecutionDeps;
  /** Current policy read from the exact owned follow and user row. */
  leveragePolicy?: CurrentPerpLeveragePolicy;
  /** Phase-A protection snapshot for this follow, when configured. */
  protectionRuleSnapshot?: PerpProtectionRule | null;
  /**
   * Re-read consent and leverage policy while holding the follower users-row
   * lock. The callback is invoked only after market/collateral reads and stays
   * inside that transaction through final leverage, apply, and placement.
   */
  withLockedPerpOpenPolicy?: <T>(
    callback: (resolution: PerpOpenPolicyResolution) => Promise<T>,
    preparedOrder?: {
      orderId: string;
      clientOrderId: string;
      claimToken: string;
      claimAt: Date;
    },
  ) => Promise<T>;
}

/**
 * Re-send a stored PENDING perp order.
 *
 * A resume is not a replay: the row it re-sends may be hours old, so the coin,
 * the market, the ceilings, the money and the follower's live position are all
 * re-read and re-judged against what is true NOW. Every refusal below leaves the
 * row PENDING with its client order id intact, because the first attempt may
 * already have reached the venue and only the reconciler can tell.
 */
export async function resumePendingPerpMirror(
  ctx: PerpMirrorExecutionContext & {
    existing: PerpOrderRow;
    guards: PerpMirrorGuards;
    /**
     * Set when the caller revived this row from a reconciler cancellation in
     * this same cycle, which is the reconciler reporting that the venue never
     * saw the first submission. See the reduce-only skip branch below: it is
     * the only thing that makes an empty position read a definite answer.
     */
    revivedFromCancelledClose?: boolean;
  },
): Promise<MirrorProcessOutcome> {
  const { cand, client, walletAddress, existing, guards, deps } = ctx;
  const stagedTradeCap = existing.reduceOnly === true
    ? { ok: true as const, value: null }
    : resolveEffectiveMirrorCap(cand.maxTradeSize, null);
  if (!stagedTradeCap.ok) return "consent-unverifiable";
  let maxOrderDollars = stagedTradeCap.value === null
    ? guards.maxOrderDollars
    : Math.min(guards.maxOrderDollars, stagedTradeCap.value);
  const resumePerpDailyCap = existing.reduceOnly === true
    ? undefined
    : effectivePerpDailyCap(guards);
  if (existing.reduceOnly !== true && resumePerpDailyCap === null) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp resume: invalid daily cap", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: existing.symbol,
    });
    return "daily-cap";
  }
  // The initial client is needed for venue snapshots taken before the policy
  // lock. A credential replacement can happen during those reads, so the
  // locked callback may supply a freshly built client for apply/submit and the
  // post-commit protection hand-off.
  let resumeClient = client;
  // The order row is bound to the master wallet that received the original
  // intent. A credential replacement that also changes that account must fail
  // closed rather than applying leverage or submitting on a different wallet.
  let resumeWalletAddress = walletAddress;

  // Never resume a row onto a different chain than it was placed on.
  //
  // The client is built for whatever network is configured NOW. Resuming a
  // testnet-staged row while configured for mainnet finds no matching cloid
  // there (of course, it was never sent there), submits the old intent on
  // mainnet, and leaves the row still labelled testnet, at which point the
  // network-filtered reconciler skips it and nothing ever settles it.
  //
  // A close DEFERS, since switching the network back or draining the order is a
  // thing a person can do. An open is simply withheld: refusing new exposure
  // costs nothing. A null network is a row from before the column existed and is
  // allowed through, exactly as it was before.
  const activeNetwork = networkFromEnv();
  // Nullish, not strictly null: the column is nullable and a row read without it
  // is undefined, and both mean "not recorded" rather than "another network".
  if (existing.venueNetwork != null && existing.venueNetwork !== activeNetwork) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp resume: order belongs to another network", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: existing.symbol.slice(0, 24),
      orderNetwork: existing.venueNetwork,
      activeNetwork,
    });
    if (existing.reduceOnly === true) {
      deferClose("perp-network-mismatch", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
      });
    }
    return "perp-network-mismatch";
  }

  const storedSide = explicitPerpSide(existing.direction);
  const storedMarginMode = existing.marginMode === "cross" || existing.marginMode === "isolated"
    ? existing.marginMode
    : null;
  if (
    !storedSide ||
    !storedMarginMode ||
    !existing.quantityDecimal ||
    !parsePositiveDecimal(existing.quantityDecimal) ||
    !existing.clientOrderId
  ) {
    return "no-qty";
  }
  // The retry re-sends the STORED coin, so it gets the same gate as a fresh
  // candidate. Refusing to resubmit is safe: the row keeps its status and
  // its client order id, and nothing is marked rejected here.
  if (!isCanonicalPerpCoin(existing.symbol)) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip: non-canonical stored perp coin", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      symbol: existing.symbol.slice(0, 24),
    });
    return "unsupported-perp-coin";
  }
  const resumeReduceOnly = existing.reduceOnly === true;
  // Leverage is not an order field, so a resumed OPEN fills at whatever
  // leverage the coin carries at retry time, not the value this row claims.
  // It is re-clamped against the ceilings in force NOW (not the ones the row
  // was written under), re-applied under the same position guard as a fresh
  // open, or refused. Reduce-only resumes are exempt on every count: they
  // can only shrink a position, and a follower must never be blocked from
  // exiting because a leverage write conflicted with their open margin.
  let resumeLeverage: number | null = resumeReduceOnly ? existing.leverage ?? 1 : null;
  // The stored quantity is the fallback for an open. Reduce-only resumes
  // replace it later with the live attributed exposure, but the variable must
  // exist before Phase A so the durable claim is taken before any metadata CAS.
  let resumeSizeCoin = existing.quantityDecimal;
  const resumeClientOrderId = existing.clientOrderId;
  // The mark the money caps below were enforced against. Passed to the order
  // so the client does not go and fetch a different one at submit time.
  // A re-clamped leverage that still has to be persisted after a locked policy
  // reread, or null. The initial parity clamp is persisted before the policy
  // transaction so a failed venue leverage call still leaves the durable row
  // at a conservative value; the locked value may be lower and is written once
  // the lock has been released.
  let resumeClampToRecord: number | null = null;
  let resumeClampPersistedBeforePolicy: number | null = null;
  let resumeMarkPrice: string | undefined;
  let resumeOrderDollars: number | undefined;
  let resumeSizeDecimals: number | undefined;
  let resumeLeveragePolicy: PerpLeverageDecisionAudit | undefined;
  // The market/collateral snapshot is deliberately captured before the policy
  // lock. Final parity is recomputed from these immutable reads once the exact
  // current policy is locked, so no venue read is performed while holding the
  // users-row lock.
  let resumeOpenParityInput: Parameters<typeof decidePerpResumeParity>[0] | null = null;
  let resumeOpenPosition: Parameters<typeof decidePerpOpenAgainstPosition>[0]["position"] = null;

  if (!resumeReduceOnly) {
    // A resume re-sends a stored intent that may be hours old, so the market,
    // the ceilings and the money are all re-read rather than assumed. A
    // reduce-only resume is exempt on purpose: a follower must never be
    // blocked from EXITING a position because the market they are stuck in
    // has since been delisted, repriced, or run their collateral down.
    const [resumeAsset, resumeMids, resumeSnapshot, resumeCollateral] = await Promise.all([
      client.resolveAsset(existing.symbol),
      client.allMids(existing.symbol),
      client.perpAccountSnapshot(walletAddress),
      // Same mode-aware read as the fresh open path. A resume re-checks the
      // money before replaying a stored intent, so it has to consult the same
      // ledger the open would have.
      client.perpCollateral(walletAddress),
    ]);
    // An unread dex is not an empty one. The position guard below decides
    // whether this open would net against or rewrite something the follower
    // already holds, and it cannot answer that from a snapshot that never read
    // the market. Refusing is safe: withholding new exposure costs nothing.
    const resumeUncovered = uncoveredDexRefusal(resumeSnapshot.coveredDexes, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: existing.symbol,
    });
    if (resumeUncovered) return resumeUncovered;
    if (
      !isTradableOnHl(
        [{ coin: existing.symbol, isDelisted: resumeAsset.isDelisted }],
        existing.symbol,
      )
    ) {
      // Status stays PENDING: the first attempt may already have reached the
      // venue, and the reconciler is the only thing that can tell.
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp resume: market is not tradable", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
      });
      return "coin-not-tradable";
    }

    // PARITY WITH THE FRESH OPEN. The stored leverage is re-clamped against
    // the ceilings in force now (the user may have lowered a current cap, or the
    // venue may have cut the coin's own max), and the stored size is
    // re-priced off a live mid so the per-order dollar cap and the
    // free-collateral gate judge the order the venue would actually get.
    resumeOpenParityInput = {
      storedLeverage: existing.leverage,
      storedSizeCoin: existing.quantityDecimal,
      sourceLeverage: cand.perpLeverage,
      stagedUserMaxLeverage: cand.perpUserMaxLeverage,
      stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
      currentUserMaxLeverage: ctx.leveragePolicy?.currentUserMaxLeverage,
      currentFollowMaxLeverage: ctx.leveragePolicy?.currentFollowMaxLeverage,
      venueMaxLeverage: resumeAsset.maxLeverage,
      sizeDecimals: resumeAsset.szDecimals,
      side: storedSide,
      rawMid: resumeMids[existing.symbol],
      freeCollateralUsd: resumeCollateral ? Number(resumeCollateral.freeUsd) : null,
      maxOrderDollars,
    };
    const parity = decidePerpResumeParity(resumeOpenParityInput);
    if (parity.action === "skip") {
      // Nothing is marked rejected: the row keeps its PENDING status and its
      // client order id, so the Hyperliquid sync poller still reconciles it
      // if the first attempt did reach the venue.
      logger.warn(LOG_SERVICE, `[copy-mirror] skip perp resume: ${parity.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        side: storedSide,
        storedLeverage: existing.leverage,
        marginMode: storedMarginMode,
      });
      return parity.reason;
    }
    resumeLeverage = parity.leverage;
    resumeMarkPrice = parity.markPrice;
    resumeOrderDollars = parity.orderDollars;
    resumeSizeDecimals = resumeAsset.szDecimals;

    resumeLeveragePolicy = {
      sourceLeverage: cand.perpLeverage,
      stagedUserMaxLeverage: cand.perpUserMaxLeverage,
      stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
      currentUserMaxLeverage: ctx.leveragePolicy?.currentUserMaxLeverage,
      currentFollowMaxLeverage: ctx.leveragePolicy?.currentFollowMaxLeverage,
      venueMaxLeverage: resumeAsset.maxLeverage,
      storedOrderLeverage: existing.leverage,
      effectiveLeverage: parity.leverage,
    };

    // The row is still PENDING at this point, but the live-position guard below
    // must run before changing its audit value: a PENDING row can represent a
    // delayed fill at the stored leverage, and a same-side position with a
    // conflicting leverage is deliberately not adopted as mirror exposure.
    // Once that guard passes, remember the conservative parity clamp. Phase A
    // below persists the claim before this metadata write, so a later retry
    // cannot reclaim the row and then be overwritten by this stale clamp.
    if (parity.leverageWasClamped) {
      logger.warn(LOG_SERVICE, "[copy-mirror] perp resume re-clamped to the current ceiling", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        storedLeverage: existing.leverage,
        leverage: parity.leverage,
      });
      resumeClampToRecord = parity.leverage;
    }

    const livePosition = findPerpPosition(resumeSnapshot.positions, existing.symbol);
    resumeOpenPosition = livePosition;
    const resumeGuard = decidePerpOpenAgainstPosition({
      position: livePosition,
      orderSide: storedSide,
      leverage: parity.leverage,
      marginMode: storedMarginMode,
    });
    if (resumeGuard.action === "skip") {
      // NOT repaired from the live position, and this is deliberate.
      //
      // The row can be left claiming a leverage the venue never applied: an
      // update can be rejected outright while the position it applies to is
      // missing from the snapshot. The durable claim is held before the
      // conservative clamp metadata write, so this guard cannot be bypassed
      // by a stale pre-claim callback.
      // This guard is where that surfaces, so it looks like the place to correct
      // it, and correcting it here was tried and backed out.
      //
      // A live position CANNOT be attributed to this order. Perp positions are
      // fungible and net per coin per account, and a PENDING row has no broker
      // order id, so there is no evidence the position is this order's delayed
      // fill rather than something the follower opened by hand. Adopting its
      // leverage makes the conflict disappear on the next resume, and the mirror
      // then places onto that manual position at a leverage nobody chose. That
      // trades a reporting error for a money one.
      //
      // So the refusal stands and the row stays wrong. The cost is that the
      // reconciler's synthetic fills can carry a leverage the follower is not
      // holding, which is bad reporting rather than bad exposure. Fixing it
      // properly needs the row to be able to say "unknown", which is the
      // exposure-ledger work in docs/research/perp-mirror-exposure-state.md.
      // The row keeps its PENDING status and its client order id, so the
      // Hyperliquid sync poller still reconciles it if the first attempt did
      // reach the venue. Nothing is marked rejected here.
      logger.warn(LOG_SERVICE, `[copy-mirror] skip perp resume: ${resumeGuard.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        side: storedSide,
        leverage: parity.leverage,
        marginMode: storedMarginMode,
      });
      return resumeGuard.reason;
    }

  }

  // Defensive, and deliberately fail-closed: an open that reached here
  // without a re-clamped leverage is one nobody priced, and it does not get
  // to fall back to the value on the row.
  if (resumeLeverage === null) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp resume: leverage not re-clamped", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: existing.symbol,
    });
    return "leverage-unconfirmed";
  }

  // NO ACCOUNT-MODE GATE ON A REDUCE-ONLY RESUME, DELIBERATELY.
  //
  // `perpDexModeReady` exists because SIZING AN OPEN has to know which ledger
  // funds it: a HIP-3 order on a standard-abstraction account is
  // collateralised per dex, so opening exposure there against a pooled
  // figure would be wrong. None of that reasoning applies to a reduce-only
  // resume. It commits no collateral, it releases it, and Hyperliquid
  // independently refuses any reduce-only order that would increase position
  // in the same direction, so the venue itself is the backstop.
  //
  // This used to gate the resume on the same check and `deferClose` when it
  // failed, which throws EAGAIN so the delivery requeues instead of
  // completing. A follower whose account left the abstraction mode this
  // check demands (or never had it) therefore had every exit for an
  // already-open mirrored position requeued forever, while the venue would
  // have accepted the close on any attempt. See `executePerpCloseMirror`
  // above, fixed the same way for the fresh close path: a rule must never be
  // the reason someone cannot get out of a position the mirror opened for
  // them.
  if (
    !resumeReduceOnly &&
    !(await deps.perpDexModeReady(client, walletAddress, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: existing.symbol,
    }))
  ) {
    return "dex-abstraction-required";
  }
  // A resumed OPEN counts against TODAY's cap, not the day it was staged.
  //
  // countMirrorsToday counts orders by their created_at, so a row stranded
  // PENDING before midnight is invisible to every count taken after it. Without
  // this check that row could place on top of a full day's worth of fresh
  // mirrors, putting the follower one order over a cap that exists to bound how
  // much the mirror can do to their account in a day.
  //
  // The row being resumed is EXCLUDED from its own count. The count ignores
  // status, so a row stranded earlier TODAY is already inside it, and counting
  // it here would let it block itself: the order holding the last slot would
  // read the cap as full and be refused, leaving that slot occupied by an order
  // that never went out. A resume is the same mirror finishing, not another one.
  //
  // Closes are exempt, as everywhere else on this path: an exit is not new
  // exposure, and a daily cap must never be the reason a follower cannot get out
  // of a leveraged position.
  // The production path has an atomic Phase-A slot reservation below. Its
  // user-row lock and durable PENDING intent are the authority; an earlier
  // advisory count here can race another follower delivery and must not be
  // allowed to short-circuit that reservation. Keep this fallback only for
  // legacy dependency sets that do not expose the phased flow.
  const canReserveDailySlot =
    !resumeReduceOnly &&
    deps.preparePerpMirrorOrder &&
    deps.submitPerpMirrorOrder &&
    deps.finalizePerpMirrorOrder;
  if (!resumeReduceOnly && !canReserveDailySlot) {
    const resumeMirrorsToday = await (deps.countPerpDailySlots ?? deps.countMirrorsToday)(
      cand.followerUserId,
      existing.id,
    );
    if (resumeMirrorsToday === null) {
      // Unknown is not zero. Same treatment as the fresh path: retry rather than
      // place against a count we could not take.
      throw Object.assign(new Error("daily mirror cap count unavailable"), { code: "08006" });
    }
    if (!withinDailyCap({ mirrorsToday: resumeMirrorsToday, dailyCap: resumePerpDailyCap! })) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp resume: daily cap reached today", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        mirrorsToday: resumeMirrorsToday,
        dailyCap: resumePerpDailyCap!,
      });
      // PENDING is kept: the first attempt may have reached the venue, and only
      // the reconciler can settle that.
      return "daily-cap";
    }
  }

  // A reduce-only resume RE-SIZES rather than re-sending the stored quantity.
  //
  // Closes are retried indefinitely on transient failures, so an arbitrary
  // amount of time can pass between attempts. In that window the follower may
  // have reduced or fully exited the mirrored position and later opened an
  // unrelated one in the same coin and direction, and resending the stored size
  // would reduce THAT. `reduceOnly` prevents a flip; it does not preserve
  // ownership, so the live position and the attribution behind it are re-read
  // and the same ceilings a fresh close passes are re-applied.
  /**
   * What the tail needs to decide whether this resumed CLOSE retires the
   * follower's own exit, captured where it is already known.
   *
   * The re-sizing block below owns the only attribution read this path makes,
   * and it is block-scoped. Re-reading it after the placement would be a second
   * database call on a close path for something already in hand, and null means
   * this resume was not a close at all, which is how the tail tells the two
   * apart without re-deriving `reduceOnly`.
   */
  let resumeCloseRetirement: {
    mirroredExposureSizeDecimal: string | null;
    attributedClientOrderIds: readonly string[];
  } | null = null;
  if (resumeReduceOnly) {
    const [closeAsset, closeSnapshot, closeMids] = await Promise.all([
      client.resolveAsset(existing.symbol),
      client.perpAccountSnapshot(walletAddress),
      client.allMids(existing.symbol),
    ]);
    if (uncoveredDexRefusal(closeSnapshot.coveredDexes, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: existing.symbol,
    })) {
      throw Object.assign(
        new Error("perp close resume held back: position read did not cover this dex"),
        { code: "EAGAIN" },
      );
    }
    const closePosition =
      closeSnapshot.positions.find((item) => item.coin === existing.symbol) ?? null;
    const closeContext = await deps.loadPerpCloseContext(cand, closePosition);
    const resized = decidePerpReduceOnlyMirror({
      sourceSizeDecimal: existing.quantityDecimal,
      ...(closeContext?.sourcePositionSizeDecimal
        ? { sourcePositionSizeDecimal: closeContext.sourcePositionSizeDecimal }
        : {}),
      ...(closeContext?.mirroredExposureSizeDecimal
        ? { mirroredExposureSizeDecimal: closeContext.mirroredExposureSizeDecimal }
        : {}),
      // The stored size is already the sized result of the first attempt, so it
      // is re-clamped rather than re-derived from the follow's rule.
      sizingMode: "ratio",
      sizingValue: 1,
      orderSide: storedSide,
      sizeDecimals: closeAsset.szDecimals,
      position: closePosition,
      markPrice: parsePerpCloseMarkPrice(closeMids[existing.symbol]),
    });
    // Seeing a position ENDS any absence streak on this row.
    //
    // Without this, a row that read empty, then saw its position again, then
    // read empty a second time would measure the gap between the two empty
    // reads as continuous absence and retire on it. Only runs when a streak is
    // actually recorded, so the ordinary path takes no extra write.
    //
    // A FAILED clear stops this resume rather than being logged and stepped
    // over. The earlier version reasoned that it "only leaves the row confirming
    // sooner than it should have", which was wrong because it only followed the
    // path where the placement below succeeds. If that placement fails
    // transiently the delivery comes back, the row still carries observations
    // taken BEFORE a position was confirmed live, and a later lagging snapshot
    // can add the third one and retire the close over exposure that never went
    // anywhere.
    //
    // Holding costs a retry of a close that was ready. Proceeding risks
    // retiring one that was not. Only the first is recoverable.
    const readAsAbsent = resized.action === "skip" && resized.reason === "no-position";
    const hasStreak =
      existing.closeAbsenceFirstSeenAt != null || (existing.closeAbsenceObservations ?? 0) > 0;
    if (hasStreak && !readAsAbsent) {
      try {
        await deps.recordCloseAbsenceObservation(existing.id, null);
      } catch (error) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp close absence streak not cleared", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: existing.symbol,
          error: error instanceof Error ? error.message : String(error),
        });
        throw Object.assign(
          new Error("perp close resume held back: absence streak could not be cleared"),
          { code: "EAGAIN" },
        );
      }
    }
    if (resized.action === "skip") {
      // PENDING is kept either way: the first attempt may have reached the
      // venue and only the reconciler can settle that.
      logger.warn(LOG_SERVICE, `[copy-mirror] skip perp close resume: ${resized.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        storedSizeCoin: existing.quantityDecimal,
      });
      // "wrong-side" is the VENUE saying there is nothing here to reduce, which
      // is a real answer and lets the close retire. A position IS present in
      // that reading, just the other way, so the snapshot is not the blank one
      // the case below is about.
      //
      // "no-qty" is us being unable to attribute what is there, which is not
      // an answer at all: consuming on it would spend the exit over a read we
      // could not make, so it is requeued instead.
      if (resized.reason === "no-qty") {
        throw Object.assign(
          new Error("perp close resume could not be sized against attributed exposure"),
          { code: "EAGAIN" },
        );
      }
      // "below-min-notional" is the venue refusing the size we would submit,
      // not evidence the position is gone. Hyperliquid does not exempt
      // reduce-only orders from its $10 minimum, so consuming here would spend
      // the exit on a rejection the follower never gets to see coming. Requeue
      // instead: no order is placed, and the resume tries again once the
      // position or the mark has moved enough to clear the floor.
      if (resized.reason === "below-min-notional") {
        throw Object.assign(
          new Error("perp close resume held back: size does not clear the venue minimum"),
          { code: "EAGAIN" },
        );
      }
      // "no-position" is TWO different situations on a resume, and only one of
      // them may consume the close.
      //
      // This row is PENDING with no broker order id, so the first submission's
      // outcome is unknown: it may have filled (which empties the position, and
      // retiring is right), or it may never have reached the venue at all. In
      // the second case an empty read is the snapshot being wrong or stale,
      // the position is still open, and the reconciler will presently cancel
      // this row. Retiring on that spends the follower's only exit and leaves
      // them in a leveraged position with nothing left to close it.
      //
      // So an unproven read holds the delivery instead. The wait is bounded by
      // the reconciler, which settles every PENDING row: a fill completes the
      // delivery as a duplicate on the next cycle, and a cancellation is revived
      // (see the revival in copy-mirror.ts) and arrives back here with the proof.
      //
      // Deferring UNCONDITIONALLY was the obvious version and it wedges: the
      // reconciler would cancel, the caller would revive, this would defer, and
      // around again every poll forever, because nothing in that loop ever
      // learns anything new.
      //
      // TWO conditions retire it, because the revival alone is not enough. The
      // revival says the venue never saw the CLOSE. It says nothing about the
      // OPENING position, which is the thing actually at stake, so a snapshot
      // that omits a still-live position passes that test and spends the exit
      // anyway.
      //
      // What covers the difference is COUNTED observation: how many times this
      // row has actually read the venue as empty, plus a floor on how long those
      // reads span. Two earlier versions measured time instead, first the row's
      // age and then the elapsed span since the first empty read, and both broke
      // the same way. Time passes while nothing is looking, so switching
      // mirroring off for an hour satisfied either one and the first read back
      // retired the close: the single stale snapshot this exists to exclude. A
      // count cannot be run up by a quiet interval.
      //
      // Known limits, both in the holding direction. This waits indefinitely if
      // the reconciler is not running, since nothing else settles a PENDING row.
      // And a follower who closes by hand within the window keeps a close
      // retrying until it expires. Both hold a one-shot exit rather than
      // spending it, both are refusals a person can lift, and reconciliation is
      // on by default now.
      if (resized.reason === "no-position") {
        const now = new Date();
        const firstSeen = existing.closeAbsenceFirstSeenAt ?? null;
        // THIS read counts, which is why the totals include it. Requiring the
        // row to already show three would need a fourth read to act on them.
        const observations = (existing.closeAbsenceObservations ?? 0) + 1;
        const observedMs = firstSeen ? now.getTime() - firstSeen.getTime() : 0;
        const confirmed =
          ctx.revivedFromCancelledClose === true &&
          observations >= CLOSE_ABSENCE_MIN_OBSERVATIONS &&
          observedMs >= CLOSE_ABSENCE_CONFIRM_MS;
        // Recorded whether or not it confirms, so the streak keeps advancing
        // across the cycles that hold. A failed write means this observation is
        // not on record and cannot count later; holding is the answer either
        // way, so the error only needs reporting.
        try {
          await deps.recordCloseAbsenceObservation(existing.id, now);
        } catch (error) {
          logger.error(LOG_SERVICE, "[copy-mirror] perp close absence observation not recorded", {
            followerUserId: cand.followerUserId,
            sourceItemId: cand.sourceItemId,
            coin: existing.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!confirmed) {
          logger.warn(LOG_SERVICE, "[copy-mirror] perp close resume held: position absence unconfirmed", {
            followerUserId: cand.followerUserId,
            sourceItemId: cand.sourceItemId,
            coin: existing.symbol,
            revived: ctx.revivedFromCancelledClose === true,
            observations,
            observedMs,
          });
          throw Object.assign(
            new Error("perp close resume held back: position absence not yet confirmed"),
            { code: "EAGAIN" },
          );
        }
      }
      return resized.reason;
    }
    resumeSizeCoin = resized.sizeCoin;
    resumeCloseRetirement = {
      mirroredExposureSizeDecimal: closeContext?.mirroredExposureSizeDecimal ?? null,
      attributedClientOrderIds: closeContext?.attributedClientOrderIds ?? [],
    };
  }

  // Captured above rather than read again below. The guard near the top of this
  // function already refuses a row without a client order id, but `existing` is
  // a mutable object, so TypeScript discards that narrowing inside the callback
  // the protection hand-off passes to `catchError`.
  const resumeParams = (): PerpMirrorPlacementParams => ({
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      ...(cand.followId ? { followId: cand.followId } : {}),
      brokerAccountId: resumeWalletAddress,
      brokerCredentialId: ctx.brokerCredentialId,
      coin: existing.symbol,
      side: storedSide,
      sizeCoin: resumeSizeCoin,
      leverage: resumeLeverage!,
      marginMode: storedMarginMode,
      reduceOnly: resumeReduceOnly,
      clientOrderId: resumeClientOrderId,
      copySourceLabel: existing.copySourceLabel ?? cand.copySourceLabel,
      ...(resumeMarkPrice !== undefined ? { markPrice: resumeMarkPrice } : {}),
      ...(resumeSizeDecimals !== undefined
        ? { sizeDecimals: resumeSizeDecimals, maxOrderDollars }
        : {}),
      ...(!resumeReduceOnly ? { dailyCap: resumePerpDailyCap! } : {}),
      ...(resumeLeveragePolicy ? { leveragePolicy: resumeLeveragePolicy } : {}),
      intent: "resume",
      ...(resumeOrderDollars !== undefined ? { orderDollars: resumeOrderDollars } : {}),
      protectionRuleSnapshot: ctx.protectionRuleSnapshot ?? null,
    });
  const placeResume = async (
    executionDeps: PerpMirrorExecutionDeps = deps,
  ): Promise<PerpPlacementResult> =>
    executionDeps.placePerpMirrorOrder(resumeClient, resumeParams());

  const phasedResume = Boolean(canReserveDailySlot);
  let preparedResume: PerpPreparedMirrorOrder | null = null;
  let preparedResumeResult: PerpPlacementResult | null = null;
  let resumeVenueAttempted = false;
  let resumeSubmission: PerpVenueSubmission | null = null;
  let resumeSubmissionWasNotSubmitted = false;
  if (phasedResume) {
    // Phase A is committed before the users-row policy lock. If the policy
    // transaction later rolls back after venue acceptance, this row remains
    // the durable reconciliation anchor and a retry reuses its cloid.
    const prepared = await deps.preparePerpMirrorOrder!(resumeParams());
    if ("result" in prepared) preparedResumeResult = prepared.result;
    else preparedResume = prepared.prepared;
  }

  // Persist the conservative parity clamp only after Phase A has established
  // an owner token. This write is outside the policy transaction, so without
  // the token predicate a later retry could reclaim the row between attempts
  // and have its leverage overwritten by this stale callback.
  if (resumeClampToRecord !== null && (!phasedResume || preparedResume)) {
    try {
      await deps.recordResumeLeverageClamp(
        existing.id,
        resumeClampToRecord,
        preparedResume?.claimToken,
      );
      resumeClampPersistedBeforePolicy = resumeClampToRecord;
      if (preparedResume) preparedResume.durableLeverage = resumeClampToRecord;
    } catch (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp resume clamp not recorded, order not placed", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return "leverage-unconfirmed";
    }
  }

  type ResumeOpenAttempt =
    | { result: PerpPlacementResult; leverage?: number }
    | { refusal: MirrorProcessOutcome; leverage?: number }
    | { submission: PerpVenueSubmission; leverage: number };
  let resumeResult: PerpPlacementResult;
  if (phasedResume && preparedResumeResult) {
    resumeResult = preparedResumeResult;
  } else if (!resumeReduceOnly) {
    const runResumeOpen = async (
      resolution: PerpOpenPolicyResolution,
    ): Promise<ResumeOpenAttempt> => {
      if ("refusal" in resolution) return { refusal: resolution.refusal };
      const currentTradeCap = resolveEffectiveMirrorCap(
        cand.maxTradeSize,
        resolution.policy.currentMaxTradeSize,
      );
      if (!currentTradeCap.ok) return { refusal: "consent-unverifiable" };
      maxOrderDollars = currentTradeCap.value === null
        ? guards.maxOrderDollars
        : Math.min(guards.maxOrderDollars, currentTradeCap.value);
      if (!resumeOpenParityInput) return { refusal: "leverage-unconfirmed" };
      const executionDeps = resolution.executionDeps ?? deps;
      resumeClient = resolution.client ?? client;
      const lockedWalletAddress = resolution.walletAddress ?? walletAddress;
      if (
        // The venue snapshots and the Phase-A intent were read/prepared for
        // the original master wallet. Even legacy rows without a stored
        // brokerAccountId must not switch accounts between that read and the
        // locked leverage/submit phase: the collateral and position guard
        // would then describe one account while the order hits another.
        lockedWalletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
        (existing.brokerAccountId &&
          existing.brokerAccountId.toLowerCase() !== lockedWalletAddress.toLowerCase())
      ) {
        logger.warn(LOG_SERVICE, "[copy-mirror] skip perp resume: credential account changed", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: existing.symbol,
        });
        return { refusal: "leverage-policy-unavailable" };
      }
      resumeWalletAddress = lockedWalletAddress;

      // Re-run the complete parity decision under the users-row lock. The
      // market, mid, collateral, and position data were all read before the
      // lock; only current owned policy values are allowed to change here.
      const finalParity = decidePerpResumeParity({
        ...resumeOpenParityInput,
        maxOrderDollars,
        currentUserMaxLeverage: resolution.policy.currentUserMaxLeverage,
        currentFollowMaxLeverage: resolution.policy.currentFollowMaxLeverage,
      });
      if (finalParity.action === "skip") return { refusal: finalParity.reason };
      if (
        preparedResume &&
        preparedResume.params.orderDollars !== undefined &&
        preparedResume.params.orderDollars > maxOrderDollars
      ) {
        return { refusal: "dollar-cap" };
      }
      resumeLeverage = finalParity.leverage;
      resumeMarkPrice = finalParity.markPrice;
      resumeOrderDollars = finalParity.orderDollars;
      resumeClampToRecord = finalParity.leverageWasClamped ? finalParity.leverage : null;
      resumeLeveragePolicy = {
        sourceLeverage: cand.perpLeverage,
        stagedUserMaxLeverage: cand.perpUserMaxLeverage,
        stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
        currentUserMaxLeverage: resolution.policy.currentUserMaxLeverage,
        currentFollowMaxLeverage: resolution.policy.currentFollowMaxLeverage,
        venueMaxLeverage: resumeOpenParityInput.venueMaxLeverage,
        storedOrderLeverage: existing.leverage,
        effectiveLeverage: finalParity.leverage,
      };

      const finalGuard = decidePerpOpenAgainstPosition({
        position: resumeOpenPosition,
        orderSide: storedSide,
        leverage: finalParity.leverage,
        marginMode: storedMarginMode,
      });
      if (finalGuard.action === "skip") {
        logger.warn(LOG_SERVICE, `[copy-mirror] skip perp resume: ${finalGuard.reason}`, {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: existing.symbol,
          side: storedSide,
          leverage: finalParity.leverage,
          marginMode: storedMarginMode,
        });
        return { refusal: finalGuard.reason };
      }

      const currentCoinCap = resolveEffectiveMirrorCap(
        cand.maxCoinSize,
        resolution.policy.currentMaxCoinSize,
      );
      if (!currentCoinCap.ok) return { refusal: "consent-unverifiable" };
      if (currentCoinCap.value !== null) {
        if (!executionDeps.checkPerpCoinCap) return { refusal: "consent-unverifiable" };
        const capResult = await executionDeps.checkPerpCoinCap({
          followerUserId: cand.followerUserId,
          symbol: existing.symbol,
          brokerAccountId: lockedWalletAddress,
          brokerCredentialId: ctx.brokerCredentialId,
          requestedSizeCoin: resumeSizeCoin,
          maxCoinSize: currentCoinCap.value,
          ...(preparedResume ? { excludeOrderId: preparedResume.orderId } : {}),
        });
        if (capResult === "coin-cap") return { refusal: "coin-cap" };
        if (capResult === "unavailable") return { refusal: "consent-unverifiable" };
      }

      if (phasedResume && preparedResume) {
        // The Phase-A row may still advertise more leverage than this locked
        // policy allows. Lower that exact claim inside this transaction before
        // touching the venue; a lowering commits as a retryable result and the
        // next attempt is the first one allowed to apply/submit at the safe
        // durable ceiling.
        if (!executionDeps.ensurePerpOpenLeverage) {
          return { refusal: "syncing" };
        }
        const durable = await executionDeps.ensurePerpOpenLeverage(
          preparedResume,
          finalParity.leverage,
        );
        if (durable.action === "claim-lost") {
          return { refusal: "syncing" };
        }
        if (durable.action === "lowered" || durable.leverage !== finalParity.leverage) {
          return { refusal: "syncing" };
        }
      }

      const leverageApplied = await executionDeps.applyPerpLeverage(resumeClient, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol,
        leverage: finalParity.leverage,
        marginMode: storedMarginMode,
      });
      if (!leverageApplied) {
        // The venue may have accepted an update whose response was lost. Any
        // report is reconciled after the policy transaction commits; writing it
        // here could abort the transaction which holds the users-row lock.
        return { refusal: "leverage-unconfirmed", leverage: finalParity.leverage };
      }

      if (phasedResume && preparedResume) {
        preparedResume.params = resumeParams();
        preparedResume.input = {
          ...preparedResume.input,
          leverage: finalParity.leverage,
        };
        resumeVenueAttempted = true;
        // Use the dependency set rebuilt by the locked callback. Its database
        // handle is the same transaction that holds the follower users row and
        // exact PENDING order lock, so the owner-token check is performed while
        // that serialization is still held immediately before the venue call.
        resumeSubmission = await executionDeps.submitPerpMirrorOrder!(resumeClient, preparedResume);
        resumeSubmissionWasNotSubmitted = resumeSubmission.kind === "not-submitted";
        return { submission: resumeSubmission, leverage: finalParity.leverage };
      }
      return { result: await placeResume(executionDeps), leverage: finalParity.leverage };
    };
    let attempt: ResumeOpenAttempt;
    try {
      attempt = ctx.withLockedPerpOpenPolicy
        ? await ctx.withLockedPerpOpenPolicy(
            runResumeOpen,
            preparedResume
              ? {
                  orderId: preparedResume.orderId,
                  clientOrderId: preparedResume.params.clientOrderId,
                  claimToken: preparedResume.claimToken,
                  claimAt: preparedResume.claimAt,
                }
              : undefined,
          )
        : await runResumeOpen({
            policy: ctx.leveragePolicy ?? {
              currentUserMaxLeverage: undefined,
              currentFollowMaxLeverage: undefined,
            },
          });
    } catch (error) {
      // Phase A is already committed. Keep its protection rule visible even if
      // the policy transaction rolls back (including a commit failure), then
      // rethrow the original error so the delivery remains retryable. The note
      // uses root deps, never the failed transaction handle.
      if (
        phasedResume &&
        preparedResume &&
        !resumeReduceOnly &&
        resumeVenueAttempted &&
        perpSubmissionMayLeaveUnprotected(resumeSubmission)
      ) {
        await noteProtectionUnattached(deps, {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          ...(cand.followId ? { followId: cand.followId } : {}),
          walletAddress: resumeWalletAddress,
          coin: existing.symbol,
          sizeCoin: resumeSizeCoin,
          clientOrderId: resumeClientOrderId,
          protectionRuleSnapshot: preparedResume.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
        }, "policy-transaction-failed:resume");
      }
      throw error;
    }
    if ("refusal" in attempt) {
      // A failed leverage application never reached the venue. Reconcile any
      // report only after the users-row transaction has released its lock, and
      // cap the persisted value at the effective policy value. When the
      // locked policy is lower than the pre-lock snapshot, the pre-lock clamp
      // can be absent or too high; even an empty position read must then leave
      // the row at the lower effective value rather than retaining stale
      // leverage above the current policy.
      if (attempt.leverage !== undefined && resumeClampToRecord !== null) {
        let livePosition: { coin: string; leverage?: unknown } | null = null;
        try {
          const settled = await resumeClient.listPositions(resumeWalletAddress);
          livePosition = settled.find((item) => item.coin === existing.symbol) ?? null;
          const truth: unknown = livePosition?.leverage ?? null;
          const reported = typeof truth === "number"
            ? truth
            : typeof truth === "string" && truth.trim() !== ""
              ? Number(truth)
              : Number.NaN;
          // A missing position gives us no authoritative venue leverage. The
          // pre-policy clamp already left the row conservative, so do not
          // write a second value in that case. If the venue did report one,
          // retain only the lower of its value and the effective policy clamp.
          const safeLeverage = Number.isSafeInteger(reported) && reported > 0
            ? Math.min(reported, attempt.leverage)
            : attempt.leverage;
          // A live position gives us a venue report to reconcile even when the
          // same clamp was already persisted before the policy lock. With no
          // position, write only when the locked value differs: this avoids a
          // redundant write for the ordinary pre-clamped case while still
          // repairing a value that was above a newly lowered current policy.
          if (livePosition || resumeClampPersistedBeforePolicy !== attempt.leverage) {
            await deps.recordResumeLeverageClamp(
              existing.id,
              safeLeverage,
              preparedResume?.claimToken,
            );
          }
        } catch (error) {
          logger.error(LOG_SERVICE, "[copy-mirror] perp resume leverage left unreconciled", {
            followerUserId: cand.followerUserId,
            sourceItemId: cand.sourceItemId,
            coin: existing.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
          // A failed position read is not permission to retain a stale value
          // above the locked policy. The conservative effective clamp is still
          // known, so make one best-effort guarded write when it differs from
          // the pre-lock value. If that write also fails, the row remains
          // pending for reconciliation and the failure is logged below.
          if (resumeClampPersistedBeforePolicy !== attempt.leverage) {
            try {
              await deps.recordResumeLeverageClamp(
                existing.id,
                attempt.leverage,
                preparedResume?.claimToken,
              );
            } catch (recordError) {
              logger.error(LOG_SERVICE, "[copy-mirror] perp resume leverage clamp write failed", {
                followerUserId: cand.followerUserId,
                sourceItemId: cand.sourceItemId,
                coin: existing.symbol,
                error: recordError instanceof Error ? recordError.message : String(recordError),
              });
            }
          }
        }
      }
      return attempt.refusal;
    }
    if ("submission" in attempt && preparedResume) {
      if (
        resumeClampToRecord !== null &&
        resumeClampPersistedBeforePolicy !== resumeClampToRecord
      ) {
        try {
          await deps.recordResumeLeverageClamp(
            existing.id,
            resumeClampToRecord,
            preparedResume.claimToken,
          );
        } catch (error) {
          logger.error(LOG_SERVICE, "[copy-mirror] perp resume clamp not recorded after policy commit", {
            followerUserId: cand.followerUserId,
            sourceItemId: cand.sourceItemId,
            coin: existing.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      resumeResult = await deps.finalizePerpMirrorOrder!(preparedResume, attempt.submission);
      if (attempt.submission.kind === "ambiguous" && resumeResult.outcome === "syncing") {
        await noteProtectionUnattached(deps, {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          ...(cand.followId ? { followId: cand.followId } : {}),
          walletAddress: resumeWalletAddress,
          coin: existing.symbol,
          sizeCoin: resumeSizeCoin,
          clientOrderId: resumeClientOrderId,
          protectionRuleSnapshot: preparedResume.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
        }, "placement-ambiguous:resume");
        throw attempt.submission.error;
      }
    } else if ("result" in attempt) {
      resumeResult = attempt.result;
      if (
        attempt.leverage !== undefined &&
        resumeClampToRecord !== null &&
        resumeClampPersistedBeforePolicy !== resumeClampToRecord
      ) {
        try {
          await deps.recordResumeLeverageClamp(
            existing.id,
            attempt.leverage,
            preparedResume?.claimToken,
          );
        } catch (error) {
          logger.error(LOG_SERVICE, "[copy-mirror] perp resume clamp not recorded after placement", {
            followerUserId: cand.followerUserId,
            sourceItemId: cand.sourceItemId,
            coin: existing.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      return "leverage-unconfirmed";
    }
  } else {
    resumeResult = await placeResume();
  }
  // The outcome the delivery is completed on, unchanged by the reason riding
  // alongside it. Everything below that used to compare a bare string still
  // compares this one; only the attach gate consults the fuller result.
  const resumeOutcome = resumeResult.outcome;

  // A RESUMED open is an open, so it gets the same protection a fresh one does.
  // Leaving it out would mean a mirror that happened to be interrupted mid
  // placement came back permanently without the stop its follow asked for, and
  // nothing in the row would say why.
  //
  // On a placement that PROVES exposure, which is "placed" plus the one
  // "syncing" that read the order back off the venue by cloid. This is the
  // likeliest recovery of all: a resume that finds its own cloid live stamps the
  // row SUBMITTED with the broker order id, so the evidence is the same as a
  // fresh accept and only arrived a cycle later. The other two "syncing" reasons
  // and "duplicate" still describe an order whose fate the reconciler owns, and a
  // trigger placed over exposure that may not exist is the resting-order hazard
  // the cancel path exists to prevent. See `perpPlacementProvesExposure`.
  if (perpPlacementProvesExposure(resumeResult) && !resumeReduceOnly) {
    const [protectionError] = await catchError(() =>
      deps.attachPerpProtection(resumeClient, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        ...(cand.followId ? { followId: cand.followId } : {}),
        walletAddress: resumeWalletAddress,
        coin: existing.symbol,
        sizeCoin: resumeSizeCoin,
        clientOrderId: resumeClientOrderId,
        protectionRuleSnapshot: preparedResume?.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
      }),
    );
    if (protectionError) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp protection attach threw on a resumed open; the order stands and the position is unprotected", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol.slice(0, 24),
        error: protectionError.message,
      });
    }
  } else if (
    resumeOutcome === "syncing" &&
    !resumeReduceOnly &&
    resumeResult.reason !== "claim-held" &&
    !resumeSubmissionWasNotSubmitted
  ) {
    // What is left after the branch above: a status write that failed after
    // Hyperliquid accepted, and a rejection handed to the reconciler. Neither
    // read anything back from the venue, so neither may carry a trigger, and
    // recording it is the difference between a follower whose stop is missing
    // and a follower whose stop is missing and nobody knows.
    await noteProtectionUnattached(deps, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      ...(cand.followId ? { followId: cand.followId } : {}),
      walletAddress: resumeWalletAddress,
      coin: existing.symbol,
      sizeCoin: resumeSizeCoin,
      clientOrderId: resumeClientOrderId,
      protectionRuleSnapshot: preparedResume?.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
    }, "placement-syncing:resume");
  }

  // A RESUMED close is a close, so it retires the legs a fresh one retires.
  //
  // `executePerpCloseMirror` has always done this; a close interrupted
  // mid-placement (row PENDING, reduce-only, no broker order id) comes back
  // through here instead and used to leave the legs resting over an exposure it
  // had just emptied. Nothing about the position differs between the two paths,
  // only where the retry happened to re-enter, and the follower's next position
  // in that coin would meet a reduce-only trigger they never placed.
  //
  // The same two conditions as the fresh path, for the same reasons: only on
  // "placed" (a "syncing" close is the reconciler's, and pulling the stop while
  // the exit is unconfirmed leaves a leveraged position with neither), and only
  // when the close takes the WHOLE attributed exposure (a partial close leaves
  // live leverage that still wants its stop).
  //
  // AFTER the placement, never as a condition of it.
  //
  // Sized off the FILL, for the same reason and through the same helper as the
  // fresh path. A resumed close re-places through `placePerpMirrorOrder`, so it
  // runs the identical IoC sweep and can come up identically short; leaving this
  // one on the requested size would be the "fixed one path, not its sibling"
  // pattern this branch keeps producing.
  const retirement = resumeCloseRetirement;
  if (resumeOutcome === "placed" && retirement) {
    const closedSizeCoin = perpCloseRetirementSizeCoin(resumeResult);
    const retires = closedSizeCoin !== null && perpProtectionRetiresOnClose({
      closeSizeCoin: closedSizeCoin,
      mirroredExposureSizeDecimal: retirement.mirroredExposureSizeDecimal,
    });
    if (retires) {
      // The FUNCTION form of catchError, not the promise form. The promise form
      // evaluates the call before the wrapper exists, so an unwired dep or an
      // argument that blows up escapes it, and a close that has ALREADY reached
      // the venue gets requeued to go looking for the position it just reduced.
      // That exact mistake broke two close tests earlier on this branch.
      const [cancelError] = await catchError(() =>
        deps.cancelPerpProtection(client, {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          walletAddress,
          coin: existing.symbol,
          attributedClientOrderIds: retirement.attributedClientOrderIds,
        }),
      );
      if (cancelError) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp protection cancel threw on a resumed close; the close stands and the legs may still rest", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: existing.symbol.slice(0, 24),
          error: cancelError.message,
        });
      }
    } else {
      logger.info(LOG_SERVICE, "[copy-mirror] perp protection kept: the resumed close did not retire the whole mirrored position", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: existing.symbol.slice(0, 24),
        closedSizeCoin,
        requestedSizeCoin: resumeSizeCoin,
        mirroredExposureSizeCoin: retirement.mirroredExposureSizeDecimal,
      });
    }
  }
  return resumeOutcome;
}

/**
 * A raw `allMids` entry, retained as an exact decimal string for
 * `decidePerpReduceOnlyMirror`'s notional check, or null when it is missing or
 * unusable.
 *
 * Null is what an unpriced close gets, and the decision treats null the same
 * as a size that priced out below the venue minimum: it is not evidence the
 * order is safe, so it must not be read that way.
 */
function parsePerpCloseMarkPrice(raw: string | undefined): string | null {
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw)) return null;
  return parsePositiveDecimal(raw) ? raw : null;
}

/**
 * Refuse to act on a position read that never covered this coin's dex.
 *
 * HIP-3 discovery and the per-dex clearinghouse reads inside
 * `perpAccountSnapshot` are additive and deliberately swallowed so slow metadata
 * cannot hold up ordinary positions. An absent HIP-3 position is therefore
 * ambiguous: flat, or unread. Treating unread as flat lets a close decide
 * "no-position" and spend itself on a position that is still open, and lets an
 * open net against or rewrite the leverage of one that already exists.
 *
 * `null` means covered and safe to proceed. Anything else is the outcome the
 * caller should return.
 */
function uncoveredDexRefusal(
  coveredDexes: readonly string[],
  ctx: { followerUserId: string; sourceItemId: string; coin: string },
): "position-unreadable" | null {
  if (isPerpDexCovered(coveredDexes, ctx.coin)) return null;
  logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: position read did not cover this dex", {
    followerUserId: ctx.followerUserId,
    sourceItemId: ctx.sourceItemId,
    coin: ctx.coin.slice(0, 24),
    coveredDexes,
  });
  return "position-unreadable";
}

/**
 * A CLOSE may not be consumed by a refusal an operator or follower can lift.
 *
 * Account mode is one of those: the follower can be out of a shared-collateral
 * mode because the position predates the guard, or because they switched modes
 * afterwards. Returning the outcome completes the one-shot delivery, so enabling
 * the mode later could never retry the exit and the leveraged position would
 * stay open. Throwing requeues instead, and reduce-only closes are exempt from
 * the attempt ceiling, so the exit survives until the account can carry it.
 */
function deferClose(reason: string, ctx: { followerUserId: string; sourceItemId: string; coin: string }): never {
  logger.warn(LOG_SERVICE, "[copy-mirror] perp close held back", {
    followerUserId: ctx.followerUserId,
    sourceItemId: ctx.sourceItemId,
    coin: ctx.coin.slice(0, 24),
    reason,
  });
  throw Object.assign(new Error(`perp close held back: ${reason}`), { code: "EAGAIN" });
}

/**
 * Mirror a reduce-only close of the SOURCE trader's position.
 *
 * This is the only path that produces an exit, and it exists only because the
 * source closed. It is clamped to the follower's own live position so a copied
 * close can never flip them short, and it refuses to be spent while the open it
 * would exit is still queued.
 */
export async function executePerpCloseMirror(
  ctx: PerpMirrorExecutionContext & { perpSide: PerpSide },
): Promise<MirrorProcessOutcome> {
  const { cand, client, walletAddress, perpSide, deps } = ctx;
  if (!cand.sourceQtyDecimal) return "no-qty";
  const [asset, snapshot, mids] = await Promise.all([
    client.resolveAsset(cand.symbol),
    client.perpAccountSnapshot(walletAddress),
    client.allMids(cand.symbol),
  ]);
  // A close must never read "we did not look" as "there is nothing there": that
  // decides no-position and spends the follower's only exit.
  if (uncoveredDexRefusal(snapshot.coveredDexes, {
    followerUserId: cand.followerUserId,
    sourceItemId: cand.sourceItemId,
    coin: cand.symbol,
  })) {
    throw Object.assign(
      new Error("perp close held back: position read did not cover this dex"),
      { code: "EAGAIN" },
    );
  }
  const position = snapshot.positions.find((item) => item.coin === cand.symbol) ?? null;
  // Loaded for EVERY sizing mode, including ratio. The mirrored exposure is what
  // attributes the venue position, and a close may only reduce the mirror's own
  // share of it, so ratio needs it as a ceiling even though it does not size
  // proportionally from it.
  const closeContext = cand.sourcePositionSizeDecimal && cand.mirroredExposureSizeDecimal
    ? {
        sourcePositionSizeDecimal: cand.sourcePositionSizeDecimal,
        mirroredExposureSizeDecimal: cand.mirroredExposureSizeDecimal,
        // A candidate that already carries its own exposure figures has to carry
        // the attribution behind them too, or the protection retire below has no
        // scope and correctly declines to cancel anything.
        attributedClientOrderIds: cand.mirroredExposureClientOrderIds ?? [],
      }
    : await deps.loadPerpCloseContext(cand, position);
  const closeDecision = decidePerpReduceOnlyMirror({
    sourceSizeDecimal: cand.sourceQtyDecimal,
    sourcePositionSizeDecimal: closeContext?.sourcePositionSizeDecimal,
    mirroredExposureSizeDecimal: closeContext?.mirroredExposureSizeDecimal,
    sizingMode: cand.sizingMode,
    sizingValue: cand.sizingValue,
    orderSide: perpSide,
    sizeDecimals: asset.szDecimals,
    position,
    markPrice: parsePerpCloseMarkPrice(mids[cand.symbol]),
  });
  if (closeDecision.action === "skip") {
    // "below-min-notional" is not "nothing to reduce": a real position is
    // there, it is just smaller than the venue will accept on its own.
    // Hyperliquid does not exempt reduce-only orders from its $10 minimum
    // (its "Error responses" page documents the rejection with no
    // reduce-only carve-out), so submitting anyway would only trade a lost
    // exit for a REJECTED order row instead of a completed delivery.
    // `decidePerpCloseConsumption` below only knows how to defer a close that
    // found no exposure, so this is intercepted first and always deferred:
    // no order is placed, and the delivery survives to a cycle where the
    // position or the mark has moved enough to clear the floor.
    if (closeDecision.reason === "below-min-notional") {
      deferClose("below-min-notional", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
      });
    }
    // Returning here marks this delivery completed, and a close is a
    // one-shot instruction: once consumed, nothing will ever exit this
    // position again. Refuse to spend it while an open that could still
    // create the exposure is queued (typically the sibling open that threw
    // earlier in this same batch and was requeued).
    const consumption = decidePerpCloseConsumption({
      close: {
        sourceItemId: cand.sourceItemId,
        followerUserId: cand.followerUserId,
        symbol: cand.symbol,
        assetType: "PERP",
        ...(cand.sourceEventAt ? { sourceEventAt: cand.sourceEventAt } : {}),
        perpReduceOnly: true,
      },
      closeSkipReason: closeDecision.reason,
      ...(await (async () => {
        const [sibling, openAmbiguous] = await Promise.all([
          deps.loadQueuedSiblingDeliveries(cand),
          deps.pairedOpenOutcomeAmbiguous(cand),
        ]);
        return {
          pendingDeliveries: sibling.rows,
          pendingScanTruncated: sibling.truncated,
          openOutcomeAmbiguous: openAmbiguous,
        };
      })()),
    });
    if (consumption.action === "defer") {
      logger.warn(LOG_SERVICE, "[copy-mirror] perp close deferred rather than consumed", {
        deferReason: consumption.reason,
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
        side: perpSide,
        closeReason: closeDecision.reason,
        blockedBy: consumption.blockedBy.slice(0, 5),
      });
      // Thrown rather than returned so the delivery is requeued instead of
      // completed. No order was placed, and the close survives to a cycle
      // where the position it reduces may actually exist.
      throw Object.assign(
        new Error("perp close held back: a sibling open is still queued"),
        { code: "EAGAIN" },
      );
    }
    logger.info(LOG_SERVICE, `[copy-mirror] skip perp close: ${closeDecision.reason}`, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
      side: perpSide,
    });
    return closeDecision.reason;
  }

  // NO ACCOUNT-MODE GATE ON THE CLOSE PATH, DELIBERATELY.
  //
  // `perpDexModeReady` exists because SIZING AN OPEN has to know which ledger
  // funds it: a HIP-3 order on a standard-abstraction account is collateralised
  // per dex, so opening exposure there against a pooled figure would be wrong.
  // None of that reasoning applies to a reduce-only close. A close commits no
  // collateral, it releases it, and Hyperliquid independently refuses any
  // reduce-only order that would increase position in the same direction, so
  // the venue itself is the backstop.
  //
  // This used to `deferClose("dex-abstraction-required")`, which throws EAGAIN.
  // A follower whose account was never migrated therefore had every exit for an
  // already-open mirrored position requeued forever, while the venue would have
  // accepted the close on any attempt. That is the exact failure this codebase
  // refuses elsewhere: a rule must never be the reason someone cannot get out of
  // a position the mirror opened for them.
  const clientOrderId = mirrorIdempotencyKey({
    followerUserId: cand.followerUserId,
    sourceItemId: cand.sourceItemId,
  });
  const closeResult = await deps.placePerpMirrorOrder(client, {
    followerUserId: cand.followerUserId,
    sourceItemId: cand.sourceItemId,
    brokerAccountId: walletAddress,
    brokerCredentialId: ctx.brokerCredentialId,
    coin: cand.symbol,
    side: perpSide,
    sizeCoin: closeDecision.sizeCoin,
    leverage: position!.leverage,
    marginMode: position!.marginMode,
    reduceOnly: true,
    clientOrderId,
    copySourceLabel: cand.copySourceLabel,
    intent: "close",
  });
  // Nothing on this path reads the placement's reason, and that is the point.
  // Tearing the follower's stop down asks for proof the POSITION is gone, which
  // no "syncing" reason supplies, so the close gate stays exactly where it was.
  const closeOutcome = closeResult.outcome;

  // THE SOURCE'S CLOSE WINS, but only when it actually takes the whole position
  // the mirror opened.
  //
  // A mirrored close is PARTIAL in two ordinary cases, not exotic ones: the
  // source scaled out (the close is sized proportionally), or the attribution
  // ceiling clamped it because the follower holds more of the coin than the
  // mirror opened. In both, exposure survives the close, and retiring the stop
  // there would strip protection from a live leveraged position, which is the
  // exact risk the follower configured it to bound.
  //
  // That would be worse than not shipping this at all: without the feature a
  // follower knowingly has no stop, with it they would have one right up until
  // the moment part of their position was quietly left uncovered.
  //
  // AFTER the placement, never before, and never as a condition of it. This is a
  // close path: nothing here may become a reason an exit does not go out, so the
  // cancel cannot gate, delay or fail the order above. `cancelPerpProtection`
  // does not throw, and its result is not consulted.
  //
  // Only on "placed". "syncing" means the reconciler owns the close's outcome,
  // and pulling the follower's stop while their exit is unconfirmed would leave
  // a leveraged position with neither.
  //
  // And on what the close actually FILLED, not what it asked for. A `Market`
  // mirror is TIF `Ioc`, so a thin book can leave part of the requested size
  // unfilled and cancelled; the requested size on a full source close equals the
  // exposure by construction, so trusting it retired the stop over a remainder
  // that was still leveraged and now uncovered. See `perpCloseRetirementSizeCoin`
  // for why an UNREADABLE fill leaves protection attached.
  const closedSizeCoin = perpCloseRetirementSizeCoin(closeResult);
  const closeRetiresProtection = closedSizeCoin !== null && perpProtectionRetiresOnClose({
    closeSizeCoin: closedSizeCoin,
    mirroredExposureSizeDecimal: closeContext?.mirroredExposureSizeDecimal,
  });
  if (closeOutcome === "placed" && closeRetiresProtection) {
    // Wrapped, not awaited bare. `cancelPerpProtection` is written not to throw,
    // but this is the CLOSE path: a bug in the safety net must never turn a
    // placed exit into a requeued delivery that goes looking for the position
    // again.
    //
    // The FUNCTION form of catchError, not the promise form, and that difference
    // is the whole guarantee. `catchError(deps.cancel(...))` evaluates the call
    // first, so anything that throws before a promise exists (a dep that is not
    // wired, an argument that blows up) escapes the very wrapper meant to
    // contain it, and the close it already placed gets requeued.
    const [cancelError] = await catchError(() =>
      deps.cancelPerpProtection(client, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        walletAddress,
        coin: cand.symbol,
        // The same attribution the close was sized against, and nothing wider.
        // Scoping the retire to the follower and the coin would take down the
        // stop on a mirror from a DIFFERENT follow, or on a signal-sourced one
        // that has no source close coming to replace it.
        attributedClientOrderIds: closeContext?.attributedClientOrderIds ?? [],
      }),
    );
    if (cancelError) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp protection cancel threw; the close stands and the legs may still rest", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol.slice(0, 24),
        error: cancelError.message,
      });
    }
  } else if (closeOutcome === "placed") {
    // Deliberately left resting. Logged because "the stop is still there" is a
    // decision an operator reading a partial close should be able to see, not
    // infer from the absence of a cancel line.
    logger.info(LOG_SERVICE, "[copy-mirror] perp protection kept: the close did not retire the whole mirrored position", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol.slice(0, 24),
      // The size that decided it, which is the FILL when one could be read.
      // Logging the requested size here would leave an operator unable to tell a
      // partial close from a full one that filled short.
      closedSizeCoin,
      requestedSizeCoin: closeDecision.sizeCoin,
      mirroredExposureSizeCoin: closeContext?.mirroredExposureSizeDecimal ?? null,
    });
  }
  return closeOutcome;
}

/**
 * Open fresh leveraged exposure for the follower.
 *
 * Sized from FREE collateral, priced off a live mid that is then pinned onto the
 * order, refused outright when the market is delisted, when the collateral read
 * is unusable, or when the follower already holds this coin in a way the mirror
 * would rewrite.
 */
export async function executePerpOpenMirror(
  ctx: PerpMirrorExecutionContext & {
    perpSide: PerpSide;
    guards: PerpMirrorGuards;
  },
): Promise<MirrorProcessOutcome> {
  const { cand, client, walletAddress, perpSide, guards, deps } = ctx;
  const stagedTradeCap = resolveEffectiveMirrorCap(cand.maxTradeSize, null);
  if (!stagedTradeCap.ok) return "consent-unverifiable";
  const stagedMaxOrderDollars = stagedTradeCap.value === null
    ? guards.maxOrderDollars
    : Math.min(guards.maxOrderDollars, stagedTradeCap.value);
  const perpDailyCap = effectivePerpDailyCap(guards);
  if (perpDailyCap === null) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp open: invalid daily cap", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
    });
    return "daily-cap";
  }
  // Market/collateral reads use the initial client. The policy-locked callback
  // may rebuild it from the exact credential reread; all leverage/order calls
  // and post-commit protection must then continue on that same account.
  let openClient = client;
  // A credential replacement that changes the master account must not cause a
  // prepared intent to be submitted on one account while its durable row names
  // another. The locked callback therefore keeps this address tied to the
  // initial account and fails closed on a mismatch.
  let openWalletAddress = walletAddress;
  // `perpAccountSnapshot` rather than `accountBalanceUsd`: the latter is the
  // account's TOTAL value, margin already posted against open positions
  // included, and sizing a leveraged order against it commits collateral the
  // follower no longer has.
  //
  // UNVERIFIED ASSUMPTION for HIP-3 (dex-prefixed) markets: the snapshot's
  // cross summary is the MAIN dex's. We rely on it backing a HIP-3 order too,
  // which holds only because `perpDexModeReady` refuses any HIP-3 coin unless
  // the account is already in a shared-collateral mode. Nobody has confirmed
  // against the live venue that the main-dex summary is in fact the pooled
  // figure in those modes. It is on the testnet checklist in
  // docs/deployment/perps-auto-mirror-testnet-checklist.md and must be settled
  // before this feature is enabled on mainnet.
  const [asset, mids, snapshot, collateral] = await Promise.all([
    client.resolveAsset(cand.symbol),
    client.allMids(cand.symbol),
    client.perpAccountSnapshot(walletAddress),
    client.perpCollateral(walletAddress),
  ]);

  // An unread dex is not an empty one. The position guard further down decides
  // whether this open would net against or rewrite a position the follower
  // already holds, and it cannot answer that from a snapshot that never read the
  // market. Refusing is safe: withholding new exposure costs nothing.
  const openUncovered = uncoveredDexRefusal(snapshot.coveredDexes, {
    followerUserId: cand.followerUserId,
    sourceItemId: cand.sourceItemId,
    coin: cand.symbol,
  });
  if (openUncovered) return openUncovered;

  // Delisted markets keep their universe entry so asset indexes stay stable,
  // so resolveAsset succeeds on one and the mirror would go on to write
  // leverage and submit a market order into a book that is winding down.
  // `isTradableOnHl` is the venue package's own delisted-aware predicate; the
  // single-entry universe below is the same row it would find in the full
  // list, since resolveAsset looked this coin up by exact key.
  if (!isTradableOnHl([{ coin: cand.symbol, isDelisted: asset.isDelisted }], cand.symbol)) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp open: market is not tradable", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
      side: perpSide,
    });
    return "coin-not-tradable";
  }

  const rawMid = mids[cand.symbol];
  // The mid is forwarded verbatim as the order's markPrice, so it has to be a
  // plain decimal string. Anything else is a shape we do not understand, and
  // an unpriceable order is one we do not send.
  if (typeof rawMid !== "string" || !parsePositiveDecimal(rawMid)) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: unusable mark price", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
    });
    return "no-qty";
  }
  const price = Number(rawMid);
  // Collateral comes from `perpCollateral`, which reads whichever ledger this
  // account's abstraction mode actually keeps it in, NOT from the snapshot's
  // main-dex cross summary.
  //
  // The old read was `snapshot.crossMargin.accountValue - totalMarginUsed`.
  // Under unified account and portfolio margin those two terms live in
  // different ledgers: the collateral moved to spot while the perp summary kept
  // reporting the full margin used. Measured on a live mainnet unified account
  // it returned about -1,146,830 where the true free figure was about
  // +2,010,430, so every mirror on such an account skipped `insufficient-margin`
  // forever, silently, including the accounts the HIP-3 gate declares eligible.
  // This is also not HIP-3 specific: a follower migrated to unified mode (which
  // one hand-placed `xyz:` order does, via ensureDexAbstraction) had every
  // plain-coin mirror sized off the same wrong number.
  //
  // Fail closed on null. There is no safe substitute: the total account value
  // would overstate capacity by exactly the margin already committed, and
  // overstating opens leveraged exposure the account cannot support. The bug
  // this replaces at least failed closed; a wrong fix here would not.
  const freeCollateralUsd = collateral ? Number(collateral.freeUsd) : null;
  // Net equity, the base for `pct_equity` only. Every guard still measures
  // against freeCollateralUsd above.
  const accountValueUsd = collateral ? Number(collateral.accountValueUsd) : null;
  if (freeCollateralUsd === null || !Number.isFinite(freeCollateralUsd)) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: free collateral unavailable", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
      side: perpSide,
    });
    return "margin-unavailable";
  }
  // The generic mirror count also includes equity mirrors and reduce-only
  // closes. Only accepted, non-reduce Hyperliquid PERP entries consume this
  // entry budget; Phase A remains the atomic authority after this advisory
  // preflight.
  const mirrorsToday = await (deps.countPerpDailySlots ?? deps.countMirrorsToday)(
    cand.followerUserId,
  );
  if (mirrorsToday === null) {
    throw Object.assign(new Error("daily mirror cap count unavailable"), { code: "08006" });
  }
  const marginMode: MarginMode = asset.isolatedOnly
    ? "isolated"
    : cand.perpMarginMode ?? "isolated";
  if (
    !(await deps.perpDexModeReady(client, walletAddress, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
    }))
  ) {
    return "dex-abstraction-required";
  }

  const phasedOpen =
    deps.preparePerpMirrorOrder &&
    deps.submitPerpMirrorOrder &&
    deps.finalizePerpMirrorOrder;
  let preparedOpen: PerpPreparedMirrorOrder | null = null;
  let preparedOpenResult: PerpPlacementResult | null = null;
  let phaseSubmission: PerpVenueSubmission | null = null;
  let phaseVenueAttempted = false;

  if (phasedOpen) {
    // Phase A uses the policy snapshot captured before the lock. The locked
    // callback recomputes the leverage and margin guard, but keeps this exact
    // size/price intent and cloid so a later policy refusal cannot create a
    // second durable identity.
    const initialPolicy = ctx.leveragePolicy ?? {
      currentUserMaxLeverage: undefined,
      currentFollowMaxLeverage: undefined,
    };
    const initialLeveragePolicy: PerpLeverageDecisionAudit = {
      sourceLeverage: cand.perpLeverage,
      stagedUserMaxLeverage: cand.perpUserMaxLeverage,
      stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
      currentUserMaxLeverage: initialPolicy.currentUserMaxLeverage,
      currentFollowMaxLeverage: initialPolicy.currentFollowMaxLeverage,
      venueMaxLeverage: asset.maxLeverage,
      effectiveLeverage: resolveEffectivePerpLeverage({
        sourceLeverage: cand.perpLeverage,
        stagedUserMaxLeverage: cand.perpUserMaxLeverage,
        stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
        currentUserMaxLeverage: initialPolicy.currentUserMaxLeverage,
        currentFollowMaxLeverage: initialPolicy.currentFollowMaxLeverage,
        venueMaxLeverage: asset.maxLeverage,
      }),
    };
    const initialDecision = decidePerpMirror({
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      accountValueUsd,
      sizingMode: cand.sizingMode,
      sizingValue: cand.sizingValue,
      sourceQtyDecimal: cand.sourceQtyDecimal,
      freeCollateralUsd,
      price,
      markPrice: rawMid,
      side: perpSide,
      leverage: initialLeveragePolicy.effectiveLeverage,
      sizeDecimals: asset.szDecimals,
      mirrorsToday,
      alreadyMirrored: false,
      dailyCap: perpDailyCap,
      maxOrderDollars: stagedMaxOrderDollars,
    });
    if (initialDecision.action === "skip") return initialDecision.reason;
    const initialGuard = decidePerpOpenAgainstPosition({
      position: findPerpPosition(snapshot.positions, cand.symbol),
      orderSide: perpSide,
      leverage: initialLeveragePolicy.effectiveLeverage,
      marginMode,
    });
    if (initialGuard.action === "skip") return initialGuard.reason;
    const initialParams: PerpMirrorPlacementParams = {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      ...(cand.followId ? { followId: cand.followId } : {}),
      brokerAccountId: walletAddress,
      brokerCredentialId: ctx.brokerCredentialId,
      coin: cand.symbol,
      side: perpSide,
      sizeCoin: initialDecision.sizeCoin,
      sizeDecimals: asset.szDecimals,
      maxOrderDollars: stagedMaxOrderDollars,
      dailyCap: perpDailyCap,
      leverage: initialLeveragePolicy.effectiveLeverage,
      marginMode,
      clientOrderId: initialDecision.clientOrderId,
      copySourceLabel: cand.copySourceLabel,
      markPrice: rawMid,
      leveragePolicy: initialLeveragePolicy,
      intent: "open",
      orderDollars: initialDecision.orderDollars,
      protectionRuleSnapshot: ctx.protectionRuleSnapshot ?? null,
    };
    const prepared = await deps.preparePerpMirrorOrder!(initialParams);
    if ("result" in prepared) preparedOpenResult = prepared.result;
    else preparedOpen = prepared.prepared;
  }

  /**
   * Everything after the venue reads above is run with one exact policy
   * snapshot. The transaction callback is deliberately the boundary around
   * leverage resolution, application, and placement: a concurrent policy
   * lowering cannot commit between those operations.
   */
  const runWithPolicy = async (
    resolution: PerpOpenPolicyResolution,
  ): Promise<MirrorProcessOutcome> => {
    if ("refusal" in resolution) return resolution.refusal;
    const currentTradeCap = resolveEffectiveMirrorCap(
      cand.maxTradeSize,
      resolution.policy.currentMaxTradeSize,
    );
    if (!currentTradeCap.ok) return "consent-unverifiable";
    const maxOrderDollars = currentTradeCap.value === null
      ? guards.maxOrderDollars
      : Math.min(guards.maxOrderDollars, currentTradeCap.value);
    if (
      preparedOpen &&
      preparedOpen.params.orderDollars !== undefined &&
      preparedOpen.params.orderDollars > maxOrderDollars
    ) {
      // Phase A already persisted the larger staged intent. A lowered current
      // follow cap cannot be bypassed by submitting that durable row.
      return "dollar-cap";
    }
    const executionDeps = resolution.executionDeps ?? deps;
    openClient = resolution.client ?? client;
    const lockedWalletAddress = resolution.walletAddress ?? walletAddress;
    if (lockedWalletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp open: credential account changed", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
      });
      return "leverage-policy-unavailable";
    }
    openWalletAddress = lockedWalletAddress;
    const currentCoinCap = resolveEffectiveMirrorCap(
      cand.maxCoinSize,
      resolution.policy.currentMaxCoinSize,
    );
    if (!currentCoinCap.ok) return "consent-unverifiable";
    const leveragePolicy: PerpLeverageDecisionAudit = {
      sourceLeverage: cand.perpLeverage,
      stagedUserMaxLeverage: cand.perpUserMaxLeverage,
      stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
      currentUserMaxLeverage: resolution.policy.currentUserMaxLeverage,
      currentFollowMaxLeverage: resolution.policy.currentFollowMaxLeverage,
      venueMaxLeverage: asset.maxLeverage,
      effectiveLeverage: resolveEffectivePerpLeverage({
        sourceLeverage: cand.perpLeverage,
        stagedUserMaxLeverage: cand.perpUserMaxLeverage,
        stagedFollowMaxLeverage: cand.perpFollowMaxLeverage,
        currentUserMaxLeverage: resolution.policy.currentUserMaxLeverage,
        currentFollowMaxLeverage: resolution.policy.currentFollowMaxLeverage,
        venueMaxLeverage: asset.maxLeverage,
      }),
    };
    // Phase A durably captured the leverage used to size this exact cloid.
    // A later policy increase may not raise that stored ceiling, and a missing
    // durable value is not safe to bridge into a venue request.
    const durableLeverage = preparedOpen?.durableLeverage;
    const leverage = phasedOpen && preparedOpen
      ? typeof durableLeverage === "number" &&
        Number.isSafeInteger(durableLeverage) &&
        durableLeverage >= 1
        ? Math.min(leveragePolicy.effectiveLeverage, durableLeverage)
        : null
      : leveragePolicy.effectiveLeverage;
    if (leverage === null) return "syncing";
    // The audit travels with the final durable payload. If the policy was
    // raised after Phase A, report the non-escalating persisted ceiling rather
    // than claiming that this cloid used a leverage it was never allowed to
    // submit.
    leveragePolicy.effectiveLeverage = leverage;
    const decision = decidePerpMirror({
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      accountValueUsd,
      sizingMode: cand.sizingMode,
      sizingValue: cand.sizingValue,
      sourceQtyDecimal: cand.sourceQtyDecimal,
      freeCollateralUsd,
      price,
      markPrice: rawMid,
      side: perpSide,
      leverage,
      sizeDecimals: asset.szDecimals,
      mirrorsToday,
      alreadyMirrored: false,
      dailyCap: perpDailyCap,
      maxOrderDollars,
    });
    if (decision.action === "skip") {
      logger.info(LOG_SERVICE, `[copy-mirror] skip perp: ${decision.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
        side: perpSide,
        leverage,
        price,
      });
      return decision.reason;
    }

    if (currentCoinCap.value !== null) {
      if (!executionDeps.checkPerpCoinCap) return "consent-unverifiable";
      const capResult = await executionDeps.checkPerpCoinCap({
        followerUserId: cand.followerUserId,
        symbol: cand.symbol,
        brokerAccountId: openWalletAddress,
        brokerCredentialId: ctx.brokerCredentialId,
        requestedSizeCoin: decision.sizeCoin,
        maxCoinSize: currentCoinCap.value,
        ...(preparedOpen ? { excludeOrderId: preparedOpen.orderId } : {}),
      });
      if (capResult === "coin-cap") return "coin-cap";
      if (capResult === "unavailable") return "consent-unverifiable";
    }

    // The follower's own exposure in this coin came from the same clearinghouse
    // read as the collateral above. Re-run this leverage-dependent guard inside
    // the locked callback so the final applied leverage is the one checked.
    const openGuard = decidePerpOpenAgainstPosition({
      position: findPerpPosition(snapshot.positions, cand.symbol),
      orderSide: perpSide,
      leverage,
      marginMode,
    });
    if (openGuard.action === "skip") {
      logger.warn(LOG_SERVICE, `[copy-mirror] skip perp open: ${openGuard.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
        side: perpSide,
        leverage,
        marginMode,
      });
      return openGuard.reason;
    }

    if (phasedOpen && preparedOpen) {
      // The final locked policy may be lower than Phase A's durable leverage.
      // Lower the exact claim in this transaction and commit before retrying;
      // no leverage application or venue submission is permitted in that same
      // transaction. A changed/missing claim is equally fail-closed.
      if (!executionDeps.ensurePerpOpenLeverage) return "syncing";
      const durable = await executionDeps.ensurePerpOpenLeverage(preparedOpen, leverage);
      if (
        durable.action === "claim-lost" ||
        durable.action === "lowered" ||
        durable.leverage !== leverage
      ) {
        return "syncing";
      }
    }

    const leverageApplied = await executionDeps.applyPerpLeverage(openClient, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol,
      leverage,
      marginMode,
    });
    if (!leverageApplied) return "leverage-unconfirmed";

    if (phasedOpen && preparedOpen) {
      preparedOpen.params = {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        ...(cand.followId ? { followId: cand.followId } : {}),
        brokerAccountId: openWalletAddress,
        brokerCredentialId: ctx.brokerCredentialId,
        coin: cand.symbol,
        side: perpSide,
        sizeCoin: decision.sizeCoin,
        sizeDecimals: asset.szDecimals,
        maxOrderDollars,
        dailyCap: perpDailyCap,
        leverage,
        marginMode,
        clientOrderId: decision.clientOrderId,
        copySourceLabel: cand.copySourceLabel,
        markPrice: rawMid,
        leveragePolicy,
        intent: "open",
        orderDollars: decision.orderDollars,
        protectionRuleSnapshot: ctx.protectionRuleSnapshot ?? null,
      };
      // The payload size/price is prepared and persisted before the policy
      // lock. Only the final leverage is changed in the in-memory input here;
      // no order status/protection write is allowed while the lock is held.
      preparedOpen.input = { ...preparedOpen.input, leverage };
      phaseVenueAttempted = true;
      // The locked dependency carries the transaction handle whose user/order
      // locks guard this exact claim. Do the final owner-token check through it
      // immediately before the irreversible venue request.
      phaseSubmission = await executionDeps.submitPerpMirrorOrder!(openClient, preparedOpen);
      return "placed";
    }

    const openResult = await executionDeps.placePerpMirrorOrder(openClient, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      ...(cand.followId ? { followId: cand.followId } : {}),
      brokerAccountId: openWalletAddress,
      brokerCredentialId: ctx.brokerCredentialId,
      coin: cand.symbol,
      side: perpSide,
      sizeCoin: decision.sizeCoin,
      sizeDecimals: asset.szDecimals,
      maxOrderDollars,
      dailyCap: perpDailyCap,
      leverage,
      marginMode,
      clientOrderId: decision.clientOrderId,
      copySourceLabel: cand.copySourceLabel,
      // The mark the caps were computed against. Without it the client fetches
      // its own mid at submit time, and the order could be priced off a mark
      // the dollar cap never saw.
      markPrice: rawMid,
      leveragePolicy,
      intent: "open",
      orderDollars: decision.orderDollars,
      protectionRuleSnapshot: ctx.protectionRuleSnapshot ?? null,
    });
    const openOutcome = openResult.outcome;

    // The one place a signal-sourced perp mirror can ever acquire an exit.
    if (perpPlacementProvesExposure(openResult)) {
      const [protectionError] = await catchError(() =>
        executionDeps.attachPerpProtection(openClient, {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          ...(cand.followId ? { followId: cand.followId } : {}),
          walletAddress: openWalletAddress,
          coin: cand.symbol,
          sizeCoin: decision.sizeCoin,
          clientOrderId: decision.clientOrderId,
          protectionRuleSnapshot: ctx.protectionRuleSnapshot ?? null,
        }),
      );
      if (protectionError) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp protection attach threw; the open stands and the position is unprotected", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: cand.symbol.slice(0, 24),
          error: protectionError.message,
        });
      }
    } else if (openOutcome === "syncing") {
      await noteProtectionUnattached(executionDeps, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        ...(cand.followId ? { followId: cand.followId } : {}),
        walletAddress: openWalletAddress,
        coin: cand.symbol,
        sizeCoin: decision.sizeCoin,
        clientOrderId: decision.clientOrderId,
        protectionRuleSnapshot: ctx.protectionRuleSnapshot ?? null,
      }, "placement-syncing:open");
    }
    return openOutcome;
  };

  if (phasedOpen && preparedOpenResult) return preparedOpenResult.outcome;
  let openOutcome: MirrorProcessOutcome;
  try {
    openOutcome = ctx.withLockedPerpOpenPolicy
      ? await ctx.withLockedPerpOpenPolicy(
          runWithPolicy,
          preparedOpen
            ? {
                orderId: preparedOpen.orderId,
                clientOrderId: preparedOpen.params.clientOrderId,
                claimToken: preparedOpen.claimToken,
                claimAt: preparedOpen.claimAt,
              }
            : undefined,
        )
      : await runWithPolicy({
          policy: ctx.leveragePolicy ?? {
            currentUserMaxLeverage: undefined,
            currentFollowMaxLeverage: undefined,
          },
        });
  } catch (error) {
    // Phase A is a committed reconciliation anchor. A policy transaction
    // rollback/commit failure must not erase its protection intent or invite a
    // second cloid, so record the unprotected backlog independently and retain
    // the original retryable error.
    if (
      phasedOpen &&
      preparedOpen &&
      phaseVenueAttempted &&
      perpSubmissionMayLeaveUnprotected(phaseSubmission)
    ) {
      await noteProtectionUnattached(deps, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        ...(cand.followId ? { followId: cand.followId } : {}),
        walletAddress: openWalletAddress,
        coin: cand.symbol,
        sizeCoin: preparedOpen.params.sizeCoin,
        clientOrderId: preparedOpen.params.clientOrderId,
        protectionRuleSnapshot: preparedOpen.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
      }, "policy-transaction-failed:open");
    }
    throw error;
  }

  if (phasedOpen && preparedOpen && phaseSubmission !== null) {
    const submission = phaseSubmission as PerpVenueSubmission;
    const finalResult = await deps.finalizePerpMirrorOrder!(preparedOpen, submission);
    if (finalResult.outcome === "zero-fill") {
      // An IOC which positively reports totalSz=0 created no exposure. Phase C
      // archived that attempt under a non-canonical cloid, so requeueing is
      // safe: the next delivery pass prepares a fresh row and a fresh venue
      // request under the canonical mirror identity. The ordinary delivery
      // ceiling and backoff keep this bounded.
      throw Object.assign(
        new Error("Hyperliquid mirror IOC filled zero; retrying with a fresh quote"),
        { code: "EAGAIN" },
      );
    }
    if (submission.kind === "ambiguous" && finalResult.outcome === "syncing") {
      await noteProtectionUnattached(deps, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        ...(cand.followId ? { followId: cand.followId } : {}),
        walletAddress: openWalletAddress,
        coin: cand.symbol,
        sizeCoin: preparedOpen.params.sizeCoin,
        clientOrderId: preparedOpen.params.clientOrderId,
        protectionRuleSnapshot: preparedOpen.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
      }, "placement-ambiguous:open");
      throw submission.error;
    }
    if (perpPlacementProvesExposure(finalResult)) {
      const [protectionError] = await catchError(() =>
        deps.attachPerpProtection(openClient, {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          ...(cand.followId ? { followId: cand.followId } : {}),
          walletAddress: openWalletAddress,
          coin: cand.symbol,
          sizeCoin: preparedOpen.params.sizeCoin,
          clientOrderId: preparedOpen.params.clientOrderId,
          protectionRuleSnapshot: preparedOpen.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
        }),
      );
      if (protectionError) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp protection attach threw after durable placement", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: cand.symbol.slice(0, 24),
          error: protectionError.message,
        });
      }
    } else if (
      finalResult.outcome === "syncing" &&
      // A claim/read failure made no venue request. Recording that attempt as
      // unprotected exposure would create a false backlog entry and can trigger
      // operator action for a position this caller never established.
      perpSubmissionMayLeaveUnprotected(submission)
    ) {
      await noteProtectionUnattached(deps, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        ...(cand.followId ? { followId: cand.followId } : {}),
        walletAddress: openWalletAddress,
        coin: cand.symbol,
        sizeCoin: preparedOpen.params.sizeCoin,
        clientOrderId: preparedOpen.params.clientOrderId,
        protectionRuleSnapshot: preparedOpen.params.protectionRuleSnapshot ?? ctx.protectionRuleSnapshot ?? null,
      }, "placement-syncing:open");
    }
    return finalResult.outcome;
  }
  return openOutcome;
}

/**
 * Record an unattached exit without letting the record become a reason the
 * placement is retried.
 *
 * The FUNCTION form of `catchError`, and belt and braces on top of the dep's own
 * no-throw contract: the order this follows may already be at the venue, so an
 * unwired dep or an argument that blows up must not escape and requeue a
 * delivery whose order exists.
 */
async function noteProtectionUnattached(
  deps: PerpMirrorExecutionDeps,
  params: PerpProtectionAttachRequest,
  reason: string,
): Promise<void> {
  const [noteError] = await catchError(() => deps.notePerpProtectionUnattached(params, reason));
  if (noteError) {
    logger.error(LOG_SERVICE, "[copy-mirror] perp protection syncing note threw; the order stands and nothing records that it has no stop", {
      followerUserId: params.followerUserId,
      sourceItemId: params.sourceItemId,
      coin: params.coin.slice(0, 24),
      error: noteError.message,
    });
  }
}
