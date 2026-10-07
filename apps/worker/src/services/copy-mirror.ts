/**
 * Copy-Mirror Poller (Phase 3 — auto-mirror)
 *
 * ============================================================================
 *  ⚠️  REAL MONEY.  THIS SERVICE PLACES LIVE BROKER ORDERS WHEN ENABLED.  ⚠️
 * ============================================================================
 *
 * When a user FOLLOWS a trader with `auto_mirror = true`, this background poller
 * watches for that trader's new trades and AUTOMATICALLY places a mirrored order
 * on the follower's own Alpaca or Hyperliquid account, sized by the follower's
 * stored rule.
 *
 * Because this can move real money, it ships **disabled and inert**:
 *
 *   1. KILL SWITCH — start() does nothing at all unless the env flag
 *      COPY_TRADE_AUTOMIRROR_ENABLED is exactly the string "true". When the flag
 *      is anything else (unset / "false" / "1" / "TRUE"), start() logs that it is
 *      disabled and returns immediately: NO interval is scheduled, NO DB rows are
 *      read, NO orders are placed. This is the default in every environment.
 *
 *   2. PAPER-FIRST — even when enabled, the poller refuses to mirror onto a LIVE
 *      Alpaca account OR onto Hyperliquid MAINNET unless a SECOND env flag,
 *      COPY_TRADE_AUTOMIRROR_ALLOW_LIVE, is exactly "true". Alpaca paper/sim and
 *      Hyperliquid testnet are always allowed; real-money destinations are
 *      skipped-and-logged by default. The flag is documented as THE real-money
 *      gate, so it covers both venues rather than only the equity one.
 *
 *   3. PERPS OPT-IN — Hyperliquid execution additionally requires
 *      COPY_TRADE_AUTOMIRROR_PERPS_ENABLED. Mainnet requires the separate
 *      COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET opt-in on top of the live gate;
 *      all three default off. The perps opt-in is also NOT sufficient on its
 *      own: HYPERLIQUID_SYNC_ENABLED must be "true" as well, because the
 *      Hyperliquid reconciler is the only thing that sizes mirrored fills and
 *      resolves PENDING perp orders. See `copy-mirror-perp-sync-gate.ts`.
 *
 *   4. GUARDRAILS — every candidate is run through pure, unit-tested predicates
 *      from apps/api/src/lib/copy-mirror.ts: a per-follow DAILY cap, a per-order
 *      DOLLAR cap, and a deterministic idempotency key so the same source trade is
 *      never mirrored to the same follower twice.
 *
 *   5. CONSENT IS RE-CHECKED AT EXECUTION. A staged delivery is only a snapshot
 *      of what the follower wanted when it was discovered, so BOTH execution
 *      paths re-read the follow row before placing, bound how old a source trade
 *      may be, and stop retrying after a fixed number of attempts. A withdrawn or
 *      stale intent can no longer become an order, leveraged or otherwise. A
 *      CLOSE is exempt from the first two on both paths, because a consent rule
 *      must never be the reason someone cannot exit a position.
 *
 * Real execution is isolated behind `placeMirrorOrder()` (Alpaca) and
 * `placePerpMirrorOrder()` (Hyperliquid). The pure `decideMirror()` and
 * `decidePerpMirror()` functions determine whether an order may be placed.
 */

import {
  millisecondTimestamp,
  millisecondTimestampValue,
  monotonicOrderStatusValue,
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
  schema,
  type WorkerPoolDb,
} from "@trade-bot/db";
import { randomUUID } from "node:crypto";
import { createProductionLogger } from "@trade-bot/logger";
import {
  AlpacaClient,
  createBrokerClientOrderId,
  isAlpacaAmbiguousOrderError,
  resolveTimeInForce,
} from "@trade-bot/alpaca";
import {
  HyperliquidOrderPreparationError,
  HyperliquidOrderRejectedError,
  networkFromEnv,
  type HyperliquidClient,
  type MarginMode,
  type PerpSide,
} from "@trade-bot/hyperliquid";
import {
  and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or, sql,
} from "drizzle-orm";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";
import { catchError, readCanonicalAuthorForSource } from "@trade-bot/utils";

// Reuse — do NOT reinvent — the per-user credential decryption + account helpers
// that the order-submission path and the OrderSyncPoller already use. Relative,
// extensionless imports match the worker's "bundler" moduleResolution (see
// order-sync.ts, which imports these exact modules the same way).
import { getDecryptedCredentials } from "../../../api/src/lib/credentials";
import { isPaperAccount } from "../../../api/src/lib/alpaca";
import {
  isSupportedAlpacaMirrorAction,
  normalizeTradeAction,
  tradeActionSide,
  tradeActionDirection,
  type TradeAction,
  type TradeDirection,
} from "../../../api/src/lib/trade-action";
import { buildOptionsSymbol } from "../../../api/src/lib/options";
import { parseOptionSignal } from "../../../api/src/lib/option-signal-parser";
import {
  createHyperliquidExchangeClient,
  HL_AGENT_REGISTERED,
} from "../../../api/src/lib/hyperliquid";
import {
  perpOrderSubmitSchema,
  toPerpOrderRow,
  toPlacePerpOrderRequest,
  type PerpOrderSubmitInput,
} from "../../../api/src/lib/perp-orders";

// Perp sizing/margin arithmetic lives in its own module (audit H7). It is the
// difference between sizing a leveraged order against collateral the follower
// actually has free and sizing it against money already posted as margin.
import {
  MIRROR_PERP_MARKET_SLIPPAGE,
  validatePerpVenueNotional,
} from "./copy-mirror-perp-sizing";

// Fixed-point decimal arithmetic (audit H7 again: pure, own module). Perp sizes
// are decimal strings, and a size that has been through a float is a size the
// venue may round into a different order than the one the guardrails approved.
import { parsePositiveDecimal, signedPerpExposure, formatDecimal } from "./copy-mirror-perp-decimal";
import {
  mirrorCoinCapAllows,
  resolveEffectiveMirrorCap,
} from "./copy-mirror-policy-caps";
export { mirrorCoinCapAllows, resolveEffectiveMirrorCap } from "./copy-mirror-policy-caps";

// The gates a perp mirror passes before any Hyperliquid call, and the three
// ways one reaches the venue (audit H7 again: own modules). This file was far
// over the size ceiling; `processPerpCandidate` is now wiring only.
import { assessPerpMirrorPreflight } from "./copy-mirror-perp-preflight";

// Candidate discovery (audit H7 again: own module). Resolving follow rows into
// concrete source trades is a large read-only unit with no business in the file
// that also executes orders.
import {
  COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE,
  createdAtIdAtOrBefore,
  createdAtIdFenceFromRow,
  findMirrorCandidateSources,
  resolveMirrorSourceQuantity,
  type CreatedAtIdFence,
} from "./copy-mirror-candidate-sources";
import {
  executePerpCloseMirror,
  executePerpOpenMirror,
  resumePendingPerpMirror,
  type PerpOpenPolicyResolution,
  type PerpOpenDurableLeverageResult,
  type PerpMirrorExecutionDeps,
  type PerpMirrorPlacementParams,
  type PerpPreparedMirrorOrder,
  type PerpPrepareMirrorOrderResult,
  type PerpVenueSubmission,
  type PerpPlacementResult,
} from "./copy-mirror-perp-execution";

// The follower's own take-profit and stop-loss for mirrored perps (the one exit
// a signal-sourced mirror can ever have). Pure decision plus an injectable
// orchestration, so the retry ladder and the never-auto-close rule are testable
// against a fake client; only the database halves are bound here.
import {
  attachPerpProtection,
  cancelPerpProtection,
  isPerpProtectionCleanupPersistenceError,
  parsePerpProtectionRule,
  parseSourcePerpProtectionRule,
  PerpProtectionRecordConflictError,
  recordPerpProtectionUnattached,
  retryPerpProtectionCleanup,
  type PerpProtectionAttachRequest,
  type PerpProtectionAttachResult,
  type PerpProtectionCancelRequest,
  type PerpProtectionCleanupState,
  type PerpProtectionRule,
} from "./copy-mirror-perp-protection";
import type { PerpProtectionPlan } from "@trade-bot/db";

// Placement-failure classification (audit H7 again: pure, own module). A venue
// rejection is not automatically terminal: the one that says this cloid already
// exists is evidence of a LIVE order, and writing REJECTED on it drops a real
// leveraged position out of reconciliation for good.
import {
  classifyPerpPreparationFailure,
  classifyPerpRejection,
  isDuplicateOrderIdentityMessage,
} from "./copy-mirror-perp-rejection";

// Consent and staleness (audit H7 again: pure, own module). A durable delivery
// queue with no age bound, no attempt ceiling and a follow row read exactly once
// at discovery will happily fire a leveraged order hours later against consent
// the follower has already taken back.
import {
  decideEquityMirrorConsent,
  decidePerpMirrorConsent,
  hasExhaustedDeliveryAttempts,
  isDexAbstractionReady,
  requiresDexAbstraction,
  resolveEquityIntentMaxAgeMs,
  MIRROR_MAX_DELIVERY_ATTEMPTS,
} from "./copy-mirror-consent";

// Operator-facing log vocabulary (audit H7 again: pure, own module). The perp
// placement path used to return placed/duplicate/syncing/rejected without a
// single log line, and two different config faults shared one outcome string,
// so an operator could neither see a leveraged order go out nor tell why one
// did not.
import {
  describePerpPlacementIntent,
  describePerpPlacementOutcome,
  type PerpPlacementIntent,
  type PerpPlacementOutcome,
} from "./copy-mirror-perp-observability";

// The reconciler precondition (audit H7 again: pure, own module). Perp mirroring
// is refused outright when the Hyperliquid reconciler is off, because that
// poller is the only writer of mirrored fill sizes and the only process that
// ever resolves a PENDING perp order against the venue.
import {
  isPerpsAutoMirrorEnabled,
  readPerpsAutoMirrorFlag,
  takePerpSyncGateRefusal,
} from "./copy-mirror-perp-sync-gate";

// Deterministic delivery ordering (audit H7 again: pure, own module). Without a
// real ordering key a source's close can be processed before its own entry.
import {
  HL_WALLET_OPEN_MAX_AGE_MS,
  isExpiredWalletOpenIntent,
  orderCandidatesBySourceEvent,
  orderDueDeliveries,
  runFollowerDeliveryLanes,
  stagedAttemptAt,
} from "./copy-mirror-delivery-order";
import { readMirrorDestination } from "./copy-mirror-destinations";

// Close preservation (audit H7 again: pure, own module). Ordering alone only
// fixes the tie case; an OPEN that FAILS still leaves its close free to run,
// skip on no-position and be marked completed forever, so the open's retry
// creates exposure whose only exit instruction has already been spent.
//
// The perp path passes these through `copy-mirror-perp-execution.ts`; the
// Alpaca path calls them from `holdEquityCloseIfPairedOpenQueued` below, since
// its close is queued, ordered, retried and consumed by the same machinery.
import {
  closeFoundNoExposure,
  decidePerpCloseConsumption,
  isClosingDelivery,
  isClosingCandidate,
  type QueuedDeliveryRow,
} from "./copy-mirror-close-pairing";
import {
  EQUITY_SOURCE_HISTORY_SCAN_CAP,
  equitySourceOrderFillAt,
  loadEquitySourceOrderIdentities,
  resolveEquitySourceCloseMetadata,
  readEquitySourceCloseContext as readEquitySourceHistoryContext,
  type EquitySourceCloseMetadata,
} from "./copy-mirror-equity-source-history";
import {
  isPerpPlacementLeaseActive,
  PERP_PLACEMENT_MAX_FUTURE_SKEW_MS,
  perpPlacementLeaseState,
  perpPlacementLeaseReason,
} from "./copy-mirror-perp-placement-lease";
import {
  createDiscordMirrorSummarySender,
  type DiscordMirrorSummary,
} from "./discord-notify";

// Reuse the SHARED pure helpers (sizing / idempotency / caps). The whole point of
// these living in apps/api/src/lib/copy-mirror.ts is that the worker and the unit
// tests run the exact same logic without a DB or a broker.
import {
  computeMirrorQty,
  mirrorIdempotencyKey,
  withinDailyCap,
  withinDollarCap,
  DEFAULT_MIRROR_DAILY_CAP,
  DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
  normalizePerpDailyCap,
  resolvePerpDailyCap,
  type SizingMode,
} from "../../../api/src/lib/copy-mirror";

const logger = createProductionLogger();

const LOG_SERVICE = "copy-mirror";

const PERP_PROTECTION_RECOVERY_REASON_PREFIX = "copy-mirror:perp-protection-recovery:";
const PERP_PROTECTION_CLEANUP_KEY = "copyMirrorProtectionCleanup";
const PERP_PROTECTION_CLEANUP_RETIRED_LEGS_KEY =
  "copyMirrorProtectionCleanupRetiredLegClientOrderIds";
const PERP_PROTECTION_CHECKPOINT_CLEANUP_SOURCE_PREFIX =
  "copy-mirror:perp-protection-cleanup-checkpoint:";

/**
 * Cleanup claims are deliberately short lived. A crashed worker therefore
 * cannot strand a marker forever, while the claim still serializes the exact
 * status/cancel sequence across recovery workers.
 */
const PERP_PROTECTION_CLEANUP_LEASE_MS = 3 * 60_000;
const PERP_PROTECTION_CLEANUP_RETRY_BASE_MS = 5 * 60_000;
const PERP_PROTECTION_CLEANUP_RETRY_MAX_MS = 60 * 60_000;
const PERP_PROTECTION_CLEANUP_QUARANTINE_MS = 24 * 60 * 60_000;
const PERP_PROTECTION_CLEANUP_QUARANTINE_AFTER = 3;

/**
 * Read the database clock used by durable lease and daily-cap decisions.
 * PostgreSQL is the authority for timestamps persisted in orders; falling
 * back to the process clock is retained only for the small legacy test doubles
 * that do not expose Drizzle's execute method. A production-shaped DB must
 * return a usable database timestamp or the clock-dependent operation aborts.
 */
async function readDatabaseNow(db: WorkerPoolDb): Promise<Date> {
  const execute = (db as any).execute;
  if (typeof execute !== "function") return new Date();
  try {
    const result = await execute.call(db, sql`SELECT CURRENT_TIMESTAMP AS now`);
    const row = Array.isArray(result)
      ? result[0]
      : Array.isArray(result?.rows)
        ? result.rows[0]
        : result;
    const raw = row && typeof row === "object" ? Reflect.get(row, "now") : undefined;
    const parsed = raw instanceof Date
      ? new Date(raw.getTime())
      : typeof raw === "string" && raw.trim() !== ""
        ? new Date(raw)
        : undefined;
    if (!parsed || !Number.isFinite(parsed.getTime())) {
      throw new Error("database clock result is malformed");
    }
    return parsed;
  } catch (error) {
    logger.error(LOG_SERVICE, "[copy-mirror] database clock read failed; refusing clock-dependent operation", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("copy-mirror could not read the database clock");
  }
}

function mergePerpProtectionPlanValues(
  stored: unknown,
  plan: PerpProtectionPlan,
): PerpProtectionPlan {
  const storedObject = stored && typeof stored === "object" ? stored : undefined;
  const storedLegIds = storedObject && Array.isArray(Reflect.get(storedObject, "legClientOrderIds"))
    ? (Reflect.get(storedObject, "legClientOrderIds") as unknown[])
      .filter((id): id is string => typeof id === "string")
    : [];
  const newLegIds = plan.legClientOrderIds.filter((id): id is string => typeof id === "string");
  return {
    ...storedObject,
    ...plan,
    copyMirrorProtectionIntent: true,
    legClientOrderIds: [...new Set([...storedLegIds, ...newLegIds])],
  } as PerpProtectionPlan;
}

type DurablePerpProtectionCleanupState = PerpProtectionCleanupState & {
  cleanupClaimedAt?: string;
  cleanupLeaseUntil?: string;
  cleanupAttemptCount?: number;
  cleanupNextAttemptAt?: string;
  cleanupQuarantineUntil?: string;
  cleanupLastFailureKind?: string;
  cleanupLastError?: string;
};

type DurablePerpProtectionRecord = PerpProtectionPlan & {
  /** Retryable venue cleanup independent of the opening row's status. */
  copyMirrorProtectionCleanup?: DurablePerpProtectionCleanupState;
  /** Exact cloids retired by an earlier cleanup generation. */
  copyMirrorProtectionCleanupRetiredLegClientOrderIds?: string[];
};

function isPerpWalletAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Read and validate the durable cleanup marker without guessing on malformed data. */
function readPerpProtectionCleanup(raw: unknown): DurablePerpProtectionCleanupState | null {
  if (!raw || typeof raw !== "object") return null;
  const marker = Reflect.get(raw, PERP_PROTECTION_CLEANUP_KEY);
  if (!marker || typeof marker !== "object") return null;
  const followerUserId = Reflect.get(marker, "followerUserId");
  const sourceItemId = Reflect.get(marker, "sourceItemId");
  const walletAddress = Reflect.get(marker, "walletAddress");
  const coin = Reflect.get(marker, "coin");
  const openingClientOrderId = Reflect.get(marker, "openingClientOrderId");
  const openingOrderId = Reflect.get(marker, "openingOrderId");
  const legClientOrderIds = Reflect.get(marker, "legClientOrderIds");
  const cleanupClaimToken = Reflect.get(marker, "cleanupClaimToken");
  const cleanupClaimedAt = Reflect.get(marker, "cleanupClaimedAt");
  const cleanupLeaseUntil = Reflect.get(marker, "cleanupLeaseUntil");
  const cleanupAttemptCount = Reflect.get(marker, "cleanupAttemptCount");
  const cleanupNextAttemptAt = Reflect.get(marker, "cleanupNextAttemptAt");
  const cleanupQuarantineUntil = Reflect.get(marker, "cleanupQuarantineUntil");
  const cleanupLastFailureKind = Reflect.get(marker, "cleanupLastFailureKind");
  const cleanupLastError = Reflect.get(marker, "cleanupLastError");
  if (
    typeof followerUserId !== "string" || followerUserId.trim() === "" ||
    typeof sourceItemId !== "string" || sourceItemId.trim() === "" ||
    !isPerpWalletAddress(walletAddress) ||
    typeof coin !== "string" || coin.trim() === "" ||
    !Array.isArray(legClientOrderIds) || legClientOrderIds.length === 0
  ) {
    return null;
  }
  if (
    (openingClientOrderId !== undefined &&
      (typeof openingClientOrderId !== "string" || openingClientOrderId.trim() === "")) ||
    (openingOrderId !== undefined &&
      (typeof openingOrderId !== "string" || openingOrderId.trim() === ""))
  ) {
    return null;
  }
  if (
    (cleanupClaimToken !== undefined &&
      (typeof cleanupClaimToken !== "string" || cleanupClaimToken.trim() === "")) ||
    (cleanupClaimedAt !== undefined && !validCleanupTimestamp(cleanupClaimedAt)) ||
    (cleanupLeaseUntil !== undefined && !validCleanupTimestamp(cleanupLeaseUntil)) ||
    (cleanupNextAttemptAt !== undefined && !validCleanupTimestamp(cleanupNextAttemptAt)) ||
    (cleanupQuarantineUntil !== undefined && !validCleanupTimestamp(cleanupQuarantineUntil)) ||
    (cleanupAttemptCount !== undefined &&
      (typeof cleanupAttemptCount !== "number" ||
        !Number.isSafeInteger(cleanupAttemptCount) || cleanupAttemptCount < 0)) ||
    (cleanupLastFailureKind !== undefined &&
      (typeof cleanupLastFailureKind !== "string" || cleanupLastFailureKind.trim() === "")) ||
    (cleanupLastError !== undefined && typeof cleanupLastError !== "string")
  ) {
    return null;
  }
  const normalizedLegs = legClientOrderIds.map((id) =>
    typeof id === "string" ? id.trim() : "",
  );
  if (normalizedLegs.some((id) => id === "")) return null;
  return {
    followerUserId,
    sourceItemId,
    walletAddress,
    coin,
    ...(openingClientOrderId !== undefined
      ? { openingClientOrderId: openingClientOrderId.trim() }
      : {}),
    ...(openingOrderId !== undefined ? { openingOrderId: openingOrderId.trim() } : {}),
    legClientOrderIds: [...new Set(normalizedLegs)],
    ...(cleanupClaimToken !== undefined ? { cleanupClaimToken: cleanupClaimToken.trim() } : {}),
    ...(cleanupClaimedAt !== undefined ? { cleanupClaimedAt } : {}),
    ...(cleanupLeaseUntil !== undefined ? { cleanupLeaseUntil } : {}),
    ...(cleanupAttemptCount !== undefined ? { cleanupAttemptCount } : {}),
    ...(cleanupNextAttemptAt !== undefined ? { cleanupNextAttemptAt } : {}),
    ...(cleanupQuarantineUntil !== undefined ? { cleanupQuarantineUntil } : {}),
    ...(cleanupLastFailureKind !== undefined
      ? { cleanupLastFailureKind: cleanupLastFailureKind.trim() }
      : {}),
    ...(cleanupLastError !== undefined ? { cleanupLastError: cleanupLastError.slice(0, 500) } : {}),
  };
}

function validCleanupTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime());
}

/** Read the exact leg identities already retired for this opening row. */
function readRetiredPerpProtectionLegs(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return [];
  const stored = Reflect.get(raw, PERP_PROTECTION_CLEANUP_RETIRED_LEGS_KEY);
  if (stored === undefined) return [];
  if (!Array.isArray(stored)) return null;
  const legs = stored.map((id) => typeof id === "string" ? id.trim() : "");
  if (legs.some((id) => id === "")) return null;
  return [...new Set(legs)];
}

/**
 * Reconstruct a cleanup candidate from the immutable pre-submit plan.
 *
 * The plan is written before Hyperliquid sees a protection request. If the
 * opening-row CAS is subsequently lost and the cleanup marker write is itself
 * unavailable, that checkpoint remains the only durable authority naming the
 * exact cloids that may be resting. A cancelled/unprotected row with a
 * non-empty plan is therefore eligible for exact status probes, but only for
 * legs not already retired by an earlier cleanup generation.
 */
function readPerpProtectionCleanupCandidate(row: {
  id?: unknown;
  userId?: unknown;
  clientOrderId?: unknown;
  symbol?: unknown;
  brokerAccountId?: unknown;
  perpProtection?: unknown;
}): PerpProtectionCleanupState | null {
  if (
    typeof row.id !== "string" || row.id.trim() === "" ||
    typeof row.userId !== "string" || row.userId.trim() === "" ||
    typeof row.clientOrderId !== "string" || row.clientOrderId.trim() === "" ||
    typeof row.symbol !== "string" || row.symbol.trim() === ""
  ) {
    return null;
  }

  const raw = row.perpProtection;
  if (!raw || typeof raw !== "object") return null;
  const retiredLegs = readRetiredPerpProtectionLegs(raw);
  if (retiredLegs === null) return null;
  const hasMarker = Reflect.has(raw, PERP_PROTECTION_CLEANUP_KEY);
  const marker = readPerpProtectionCleanup(raw);
  if (hasMarker && !marker) {
    // A present but malformed marker must not silently fall back to a broader
    // plan interpretation. Leave it for operator repair instead.
    return null;
  }

  if (marker) {
    const pendingLegs = marker.legClientOrderIds.filter((id) => !retiredLegs.includes(id));
    if (pendingLegs.length === 0) return null;
    return {
      ...marker,
      // Older markers may omit the row UUID/cloid. Enriching those two fields
      // from the exact scoped backlog row keeps recovery generation-specific.
      ...(marker.openingClientOrderId ? {} : { openingClientOrderId: row.clientOrderId.trim() }),
      ...(marker.openingOrderId ? {} : { openingOrderId: row.id.trim() }),
      legClientOrderIds: [...new Set(pendingLegs)],
    };
  }

  if (!isPerpWalletAddress(row.brokerAccountId)) return null;
  const state = (() => {
    if (Reflect.get(raw, "copyMirrorProtectionIntent") !== true) return null;
    const rawLegs = Reflect.get(raw, "legClientOrderIds");
    if (!Array.isArray(rawLegs) || rawLegs.length === 0) return null;
    const normalized = rawLegs.map((id) => typeof id === "string" ? id.trim() : "");
    if (normalized.some((id) => id === "")) return null;
    return {
      followerUserId: row.userId.trim(),
      // The plan predates the source metadata available to the cleanup marker;
      // the opening row and exact cloids remain the stable generation identity.
      sourceItemId: `${PERP_PROTECTION_CHECKPOINT_CLEANUP_SOURCE_PREFIX}${row.id.trim()}`,
      walletAddress: row.brokerAccountId,
      coin: row.symbol.trim(),
      openingClientOrderId: row.clientOrderId.trim(),
      openingOrderId: row.id.trim(),
      legClientOrderIds: [...new Set(normalized)],
    } satisfies PerpProtectionCleanupState;
  })();
  if (!state) return null;

  const pendingLegs = state.legClientOrderIds.filter((id) => !retiredLegs.includes(id));
  if (pendingLegs.length === 0) return null;
  return {
    ...state,
    // Older markers may omit the row UUID/cloid. Enriching those two fields
    // from the exact scoped backlog row keeps recovery generation-specific.
    ...(state.openingClientOrderId ? {} : { openingClientOrderId: row.clientOrderId.trim() }),
    ...(state.openingOrderId ? {} : { openingOrderId: row.id.trim() }),
    legClientOrderIds: [...new Set(pendingLegs)],
  };
}

function cleanupStatesNameSameOpening(
  left: PerpProtectionCleanupState,
  right: PerpProtectionCleanupState,
): boolean {
  return left.followerUserId === right.followerUserId &&
    left.sourceItemId === right.sourceItemId &&
    left.walletAddress.toLowerCase() === right.walletAddress.toLowerCase() &&
    left.coin === right.coin &&
    left.openingClientOrderId === right.openingClientOrderId &&
    left.openingOrderId === right.openingOrderId;
}

function mergePerpProtectionCleanupStates(
  current: PerpProtectionCleanupState | null,
  next: PerpProtectionCleanupState,
): PerpProtectionCleanupState {
  if (!current) return { ...next, legClientOrderIds: [...new Set(next.legClientOrderIds)] };
  if (!cleanupStatesNameSameOpening(current, next)) {
    throw new Error("protection cleanup marker belongs to a different opening");
  }
  return {
    ...current,
    ...next,
    legClientOrderIds: [...new Set([...current.legClientOrderIds, ...next.legClientOrderIds])],
  };
}

function cleanupClaimPredicate(
  claimToken: string | undefined,
): any {
  if (!claimToken) return undefined;
  return sql`
    ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
      ->> 'cleanupClaimToken' = ${claimToken}
  `;
}

/**
 * A cleanup token is meaningful only while its PostgreSQL-clock lease is
 * active. Progress/clear writes use this alongside the token so a worker that
 * woke after expiry cannot release or rewrite a generation another worker may
 * already reclaim. Legacy marker writes without a token intentionally omit the
 * predicate; those are pre-claim checkpoint writes, not lease progress.
 */
function cleanupLeaseActivePredicate(): any {
  return sql`(
    ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
      ->> 'cleanupLeaseUntil' IS NOT NULL
    AND pg_input_is_valid(
      ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
        ->> 'cleanupLeaseUntil',
      'timestamptz'
    )
    AND CASE WHEN pg_input_is_valid(
      ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
        ->> 'cleanupLeaseUntil',
      'timestamptz'
    ) THEN (
      ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
        ->> 'cleanupLeaseUntil'
    )::timestamptz END > CURRENT_TIMESTAMP
  )`;
}

/** Statuses that may carry an explicit, independently recoverable marker. */
function perpProtectionCleanupStatusPredicate(): any {
  return inArray(schema.orders.perpProtectionStatus, [
    "attached",
    "cancelled",
    "unprotected",
  ]);
}

function withoutCleanupLease(
  marker: DurablePerpProtectionCleanupState,
): DurablePerpProtectionCleanupState {
  const next = { ...marker };
  delete next.cleanupClaimToken;
  delete next.cleanupClaimedAt;
  delete next.cleanupLeaseUntil;
  return next;
}

function cleanupErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Small compatibility reader for test doubles that only expose findMany. The
 * production Drizzle query always takes the exact findFirst branch.
 */
async function readPerpProtectionOrderRow(
  db: WorkerPoolDb,
  identity: { id?: string; userId: string; clientOrderId: string },
): Promise<{ perpProtection?: unknown; perpProtectionStatus?: string | null } | undefined> {
  const orders = (db as any)?.query?.orders;
  if (typeof orders?.findFirst === "function") {
    return orders.findFirst({
      where: and(
        ...(identity.id ? [eq(schema.orders.id, identity.id)] : []),
        eq(schema.orders.userId, identity.userId),
        eq(schema.orders.clientOrderId, identity.clientOrderId),
      ),
      columns: { perpProtection: true, perpProtectionStatus: true },
    });
  }
  if (typeof orders?.findMany === "function") {
    const rows = await orders.findMany({
      columns: { perpProtection: true, perpProtectionStatus: true },
    });
    return rows.find((row: any) =>
      (!identity.id || row?.id === identity.id) &&
      (row?.userId === undefined || row.userId === identity.userId) &&
      (row?.clientOrderId === undefined || row.clientOrderId === identity.clientOrderId),
    );
  }
  return undefined;
}

function isPerpProtectionRecoveryClaimActive(
  reason: unknown,
  claimedAt: Date | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (
    typeof reason !== "string" ||
    !reason.startsWith(PERP_PROTECTION_RECOVERY_REASON_PREFIX) ||
    !claimedAt
  ) {
    return false;
  }
  const age = nowMs - claimedAt.getTime();
  return age < DELIVERY_CLAIM_LEASE_MS && age > -PERP_PLACEMENT_MAX_FUTURE_SKEW_MS;
}

function leverageAuditValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  let numeric: number;
  try {
    numeric = Number(value);
  } catch {
    return null;
  }
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(1, Math.floor(numeric));
}

function leverageAuditFields(
  policy: NonNullable<PerpMirrorPlacementParams["leveragePolicy"]>,
): Record<string, unknown> {
  return {
    sourceLeverage: leverageAuditValue(policy.sourceLeverage),
    stagedUserMaxLeverage: leverageAuditValue(policy.stagedUserMaxLeverage),
    stagedFollowMaxLeverage: leverageAuditValue(policy.stagedFollowMaxLeverage),
    currentUserMaxLeverage: leverageAuditValue(policy.currentUserMaxLeverage),
    currentFollowMaxLeverage: leverageAuditValue(policy.currentFollowMaxLeverage),
    venueMaxLeverage: leverageAuditValue(policy.venueMaxLeverage),
    storedOrderLeverage: leverageAuditValue(policy.storedOrderLeverage),
    effectiveLeverage: leverageAuditValue(policy.effectiveLeverage),
  };
}

/** Keep discovery latency below the venue work that follows it. */
const POLL_INTERVAL_MS = 10_000;
const OPTION_CONTRACT_MULTIPLIER = 100;
const CHECKPOINT_CONSUMER = "copy-mirror-v1";
const DELIVERY_BATCH_SIZE = 100;
/** Allow all follower lanes for one source event to settle before one summary. */
export const MIRROR_SUMMARY_SETTLE_MS = 60_000;
/** Independent follower accounts may progress in parallel; venue calls remain rate-limited. */
export const DELIVERY_FOLLOWER_CONCURRENCY = 8;
/**
 * How long a claimed delivery's lease lasts before it becomes due again.
 *
 * `loadDueDeliveries` selects on `status = 'pending' AND next_attempt_at <=
 * now` with no row lock, so with more than one worker replica polling at
 * once (an overlapping deploy; Railway does not guarantee only one instance
 * is ever running), both can load the same due row and both would place a
 * real order for it, each unaware of the other. Claiming a row moves
 * `next_attempt_at` into the future by this much BEFORE the candidate is
 * processed, as a compare-and-set on the row's previously-observed
 * `next_attempt_at`: whichever process's CAS wins proceeds, and the loser's
 * update matches zero rows. A crashed process needs no cleanup: the row is
 * simply due again once the lease expires, exactly like an ordinary retry
 * backoff. Set well above the worst-case per-candidate broker round trip
 * (credential decrypt + getAccount + quote + fractionable + createOrder),
 * which is a handful of seconds, not minutes.
 */
const DELIVERY_CLAIM_LEASE_MS = 3 * 60_000;
/** Keep failure retries conservative even though fresh discovery now runs faster. */
const MIRROR_RETRY_BASE_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const MIRROR_HISTORY_SCAN_CAP = 5_000;
/**
 * Late-arrival policy: replay this fixed source overlap on every cycle. The
 * overlap is deliberately finite, and the durable (follower, source) unique
 * key makes replay safe. Rows backfilled older than this policy window are not
 * promised by the poller and require an explicit operational backfill.
 */
export const COPY_MIRROR_LATE_SOURCE_REPLAY_MS = 5 * 60_000;
export const COPY_MIRROR_FOLLOW_PAGE_SIZE = 250;
/**
 * Cap on the still-queued-deliveries read a skipped perp close consults before
 * it may be consumed. One follower's pending queue is small; the cap only stops
 * a wedged backlog from turning one close into an unbounded scan.
 */
const SIBLING_DELIVERY_SCAN_CAP = 500;
/**
 * Cap on the deferred-close backlog scan (audit H6: no unbounded scans on the
 * delivery table). Exported because `truncated` cannot be interpreted without
 * it. The query reads one row PAST this cap, so a saturated queue reports its
 * count as a floor instead of as an exact total.
 */
export const DEFERRED_CLOSE_SCAN_CAP = 500;
/**
 * Caps and window for the unprotected-perp backlog line.
 *
 * Age bounded, unlike the deferred-close backlog, because these rows never
 * drain. See `emitUnprotectedPerpBacklog` for the argument.
 */
const UNPROTECTED_PERP_WINDOW_MS = 24 * 60 * 60_000;
const UNPROTECTED_PERP_SCAN_CAP = 200;
const UNPROTECTED_PERP_ALERT_INTERVAL_MS = 15 * 60_000;
/**
 * Cap the independent cleanup sweep separately from the operator backlog.
 * Cleanup state is all-age: an accepted trigger must not become uncancellable
 * merely because the opening row is older than the warning window.
 */
const PERP_PROTECTION_CLEANUP_SCAN_CAP = 200;
/**
 * Cap on the scan a close makes for protection legs to retire. One follower's
 * mirrored opens attributed to a single source close are few; the cap only stops
 * a long history from turning one close into an unbounded scan (audit H6).
 *
 * A second bound rather than the only one now: the query names the exact client
 * order ids the close's attribution resolved, so the row count is already
 * bounded by that list. See `loadAttachedPlans`.
 */
const PERP_PROTECTION_PLAN_SCAN_CAP = 50;
/**
 * How long the oldest deferred perp close may wait before the backlog line is a
 * warning rather than a fact.
 *
 * A deferred close is requeued with a backoff capped at MAX_RETRY_DELAY_MS (15
 * minutes), so one riding out a restart, a short outage or a few deliberate
 * minutes of maintenance clears well inside an hour. Four hours is roughly
 * sixteen of those retries: long enough that ordinary operations never trip it,
 * short enough that a gate left shut is noticed the same trading day. Past that
 * point the deployment state doing the deferring (perps switched off, the
 * reconciler stopped, the network unset, a mainnet or live opt-in withdrawn)
 * has been left in place, and every queued row is a follower still holding a
 * mirrored leveraged position with its one exit unspent.
 */
export const DEFERRED_CLOSE_WARN_AFTER_MS = 4 * 60 * 60_000;

export function mirrorSourceReplayStart(checkpoint: Date): Date {
  return new Date(checkpoint.getTime() - COPY_MIRROR_LATE_SOURCE_REPLAY_MS);
}

export type MirrorAssetType = "EQUITY" | "OPTION" | "PERP";
type AlpacaMirrorAssetType = Exclude<MirrorAssetType, "PERP">;
export type MirrorOptionType = "CALL" | "PUT";
export type MirrorTradeAction = TradeAction;

export interface MirrorSourceCandidate {
  followerUserId: string;
  /**
   * The follow row this candidate came from. Re-read at execution time so a
   * withdrawn follow stops the order; a candidate without it cannot prove
   * consent and is refused on the perp path.
   */
  followId?: string;
  /** Exact destination account selected on the follow; null candidates fail closed. */
  credentialId: string | null;
  sourceItemId: string;
  /** Present only on deliveries created after durable summary batching shipped. */
  mirrorSummaryVersion?: number;
  /**
   * ISO timestamp of the SOURCE event (the trade or signal being copied). Drives
   * both the delivery ordering and the perp intent age bound, so it is recorded
   * at discovery and never recomputed downstream.
   */
  sourceEventAt?: string;
  symbol: string;
  side: "buy" | "sell";
  sizingMode: SizingMode;
  sizingValue: number;
  /** Optional dollar cap per single mirrored order. null = no cap. */
  maxTradeSize?: number | null;
  /** Optional total mirrored exposure cap per destination/asset/symbol. */
  maxCoinSize?: number | null;
  assetType: MirrorAssetType;
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: MirrorOptionType;
  tradeAction?: MirrorTradeAction;
  direction?: TradeDirection;
  /** Hyperliquid-only fields. Perps never enter the Alpaca execution path. */
  perpSide?: PerpSide;
  perpLeverage?: number;
  /** User-owned global ceiling frozen when this candidate was discovered. */
  perpUserMaxLeverage?: number;
  /** Optional follow-specific ceiling frozen when this candidate was discovered. */
  perpFollowMaxLeverage?: number | null;
  perpMarginMode?: MarginMode;
  perpReduceOnly?: boolean;
  /** Initial absolute source protection, frozen with the opening candidate. */
  sourceInitialTakeProfitPx?: string;
  sourceInitialStopLossPx?: string;
  /**
   * The Hyperliquid network the SOURCE order was placed on, frozen at staging.
   *
   * A delivery is durable: it can be staged or requeued on one network and
   * executed after the deployment has moved to another, and the execution path
   * would otherwise build its client and its order row from whatever is
   * configured then. Absent on candidates staged before this existed, and on
   * sources whose own row predates the column.
   */
  sourceVenueNetwork?: string;
  /** Display name of the followed trader, stored on the order for UI attribution. */
  copySourceLabel?: string;
  /**
   * Source trader's share/contract count. Required for ratio sizing mode;
   * unused by pct / pct_equity / usd modes. Null when the source row has no
   * quantity (e.g. raw x_signal text where qty is implicit).
   */
  sourceQty?: number;
  /** Exact perp fill/request size. Never pass this through Number. */
  sourceQtyDecimal?: string;
  /** Non-ratio close context, resolved from source and prior mirrored exposure. */
  sourcePositionSizeDecimal?: string;
  mirroredExposureSizeDecimal?: string;
  /**
   * The follower orders `mirroredExposureSizeDecimal` was summed from.
   *
   * Carried alongside the figure rather than re-derived, because it is the scope
   * the protection retire runs under: a close may only pull the stop off the
   * mirrors it is actually closing.
   */
  mirroredExposureClientOrderIds?: readonly string[];
  sourceUserId?: string;
  sourceOrderId?: string;
  sourceOrderCreatedAt?: string;
  /** Stable source-author identity frozen for X-signal lifecycle attribution. */
  sourceAuthorKey?: string;
}

export type MirrorProcessOutcome =
  | "placed"
  | "syncing"
  | "zero-fill"
  | "duplicate"
  | "missing-credential"
  | "unusable-credential"
  | "incompatible-destination"
  | "missing-option-contract"
  | "unsupported-trade-action"
  | "live-not-allowed"
  | "no-qty"
  | "dollar-cap"
  | "coin-cap"
  | "daily-cap"
  | "no-long-position"
  /**
   * The follower holds a long, but none of it was opened by the mirror, so
   * there is nothing here for a copied close to reduce. Selling anyway would
   * liquidate shares the follower bought themselves.
   */
  | "no-mirrored-exposure"
  /** The perps opt-in flag is off. A deliberate operator choice. */
  | "perps-disabled"
  /**
   * Perps are opted in, but HYPERLIQUID_SYNC_ENABLED is not "true", so the
   * Hyperliquid reconciler is off. It is the only writer of mirrored fill sizes
   * and the only process that resolves a PENDING perp order against the venue,
   * so mirroring a perp without it would place exposure nothing can size or
   * reconcile. Refused rather than degraded.
   */
  | "perps-sync-disabled"
  /**
   * Perps are opted in, but HYPERLIQUID_NETWORK is not explicitly set to a
   * network this worker accepts. The venue package defaults an unset network to
   * MAINNET, so this is a real-money misconfiguration and is deliberately NOT
   * reported as "perps-disabled".
   */
  | "perps-network-unset"
  /** The stored row was placed on a different Hyperliquid network than this worker uses. */
  | "perp-network-mismatch"
  | "perps-mainnet-not-allowed"
  | "missing-hyperliquid-account"
  /** The coin is not a canonical Hyperliquid market name, so no order is sent. */
  | "unsupported-perp-coin"
  /** The market is delisted (or absent from the universe), so no new exposure is opened. */
  | "coin-not-tradable"
  | "insufficient-margin"
  /** Free collateral could not be read, so no order may be sized against a guess. */
  | "margin-unavailable"
  /** Below Hyperliquid's minimum order value; the venue would reject it. */
  | "below-min-notional"
  | "no-position"
  | "wrong-side"
  /** The follower holds the opposite side; opening would reduce or flip it. */
  | "opposing-position"
  /** The follower holds this coin at a leverage/margin mode we refuse to rewrite. */
  | "leverage-conflict"
  /** A live position row could not be read, so its netting effect is unknown. */
  | "position-unreadable"
  /** The leverage write failed, so the liquidation profile could not be confirmed. */
  | "leverage-unconfirmed"
  /** The current user-owned leverage policy could not be read safely. */
  | "leverage-policy-unavailable"
  /** The source event is older than the intent age bound, so it is not copied. */
  | "stale-intent"
  /** The follow was turned off, re-pointed, or deleted after the delivery was staged. */
  | "consent-withdrawn"
  /** The delivery cannot be tied back to a live follow row, so consent is unproven. */
  | "consent-unverifiable"
  /**
   * The SOURCE order behind this social trade ended without trading a share, so
   * there is no trade to copy. `social_trades` is written at broker ACCEPTANCE,
   * not at fill, and nothing retracts the row when the order is later cancelled,
   * rejected or expired. Only an OPEN is ever refused for this.
   */
  | "source-unfilled"
  /**
   * The market needs the follower's Hyperliquid account migrated to unified /
   * shared-collateral mode. That is an account-level change with no user
   * present, so the worker refuses it and the follower does it themselves.
   */
  | "dex-abstraction-required"
  | "rejected";

/**
 * What the SOURCE order behind a published social trade has actually done.
 *
 *  - "executed": shares changed hands, so there is a real trade to copy.
 *  - "working":  the broker still holds it and it may yet trade.
 *  - "unfilled": it reached a terminal state having traded nothing.
 */
export type SourceOrderExecution = "executed" | "working" | "unfilled";

/**
 * Did the source order trade, or is the social row only a submission?
 *
 * `social_trades` is written the moment Alpaca ACCEPTS an order, so the row on
 * its own proves nothing about a fill; `orders.status` and
 * `orders.executedQuantity` are what the reconciler moves afterwards and they
 * are the only record of whether anything traded.
 *
 * A PARTIAL fill counts as executed, and so does a terminal status with an
 * executed quantity behind it (an order cancelled after filling 120 of 500 is
 * still a trade the source made). Only a terminal status with nothing filled is
 * a non-event.
 *
 * An order row we cannot read answers "executed" on purpose. This exists to stop
 * a phantom trade, not to become a second way for a real one to be dropped, and
 * discovery's join is a LEFT join: legacy social rows with no order behind them
 * have always mirrored and must keep doing so.
 */
export function classifySourceOrderExecution(
  order: { status?: string | null; executedQuantity?: number | null } | null | undefined,
): SourceOrderExecution {
  if (!order) return "executed";
  const executedQty =
    typeof order.executedQuantity === "number" && Number.isFinite(order.executedQuantity)
      ? order.executedQuantity
      : 0;
  if (executedQty > 0) return "executed";
  if (order.status === "FILLED" || order.status === "PARTIAL") return "executed";
  if (order.status === "CANCELLED" || order.status === "REJECTED" || order.status === "EXPIRED") {
    return "unfilled";
  }
  return "working";
}

export interface PerpMirrorGuards {
  dailyCap: number;
  /**
   * Raw-config-aware Hyperliquid entry cap. `null` means the explicitly
   * configured generic cap was invalid; `undefined` keeps compatibility with
   * direct callers that only supply the generic equity guardrail.
   */
  perpDailyCap?: number | null;
  maxOrderDollars: number;
  /**
   * The RAW COPY_TRADE_AUTOMIRROR_PERPS_ENABLED flag as of the start of the
   * cycle. It is not a permission on its own: `processPerpCandidate` still
   * consults the reconciler gate, and carries this only so a refusal can say
   * WHICH variable is missing.
   */
  perpsEnabled: boolean;
  mainnetAllowed: boolean;
  /**
   * COPY_TRADE_AUTOMIRROR_ALLOW_LIVE. Documented as THE paper-first real-money
   * gate, so it gates Hyperliquid mainnet too, not just live Alpaca accounts.
   */
  liveAllowed: boolean;
}

type PerpOpenFollowPolicyRow = {
  id: string;
  followerUserId: string;
  autoMirror: boolean;
  credentialId: string | null;
  currentUserMaxLeverage: unknown;
  currentFollowMaxLeverage: unknown | null | undefined;
  currentMaxTradeSize: unknown;
  currentMaxCoinSize: unknown;
  protectionRule: PerpProtectionRule | null;
};

type PerpProtectionIntentSnapshot = PerpProtectionPlan & {
  copyMirrorProtectionIntent: true;
  takeProfitRoePct?: number;
  stopLossRoePct?: number;
};

function perpProtectionIntentSnapshot(
  rule: PerpProtectionRule | null | undefined,
): PerpProtectionIntentSnapshot | undefined {
  if (!rule) return undefined;
  return {
    copyMirrorProtectionIntent: true,
    ...(rule.takeProfitRoePct !== null ? { takeProfitRoePct: rule.takeProfitRoePct } : {}),
    ...(rule.stopLossRoePct !== null ? { stopLossRoePct: rule.stopLossRoePct } : {}),
    ...(rule.takeProfitPx ? { takeProfitPx: rule.takeProfitPx } : {}),
    ...(rule.stopLossPx ? { stopLossPx: rule.stopLossPx } : {}),
    // The remaining PerpProtectionPlan fields are populated after a position is
    // read. Phase A only needs the immutable rule snapshot; these placeholders
    // are deliberately absent from the JSON until attach succeeds.
    entryPx: "",
    leverage: 0,
    sizeCoin: "",
    legClientOrderIds: [],
  };
}

type PerpOpenAuthorization = {
  credential: Pick<
    typeof schema.userApiCredentials.$inferSelect,
    "id" | "provider" | "accountType"
  > | undefined;
  follow: PerpOpenFollowPolicyRow | null;
  policyUnavailable: boolean;
};

export type MirrorFailure = {
  kind: "transient" | "permanent";
  message: string;
};

function errorStatus(error: unknown): number | undefined {
  const value = error as
    | {
        status?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown; statusCode?: unknown };
      }
    | undefined;
  const raw = value?.response?.status ?? value?.response?.statusCode ?? value?.status ?? value?.statusCode;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Recover an HTTP status that the broker SDK put in the message TEXT instead of
 * on the error object.
 *
 * `@alpacahq/alpaca-trade-api` formats market-data rejections as
 * "code: 404, message: no snapshot found for KOSPI" and exposes neither a
 * `status` nor a `code` property. That lands in the classifier's deliberate
 * fail-safe (unknown shape means assume transient), so a permanently
 * unresolvable symbol was requeued forever: in production a single untradeable
 * ticker off an X signal produced 39 identical failures an hour, indefinitely.
 *
 * Deliberately anchored and narrow. It reads only a leading "code: NNN" so an
 * arbitrary three-digit number inside a message can never be mistaken for a
 * status, and errors that genuinely carry no status keep the fail-safe.
 */
export function statusFromMessage(message: string): number | undefined {
  const match = /^\s*code:\s*(\d{3})\b/.exec(message);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/** Classify failures so only recoverable work remains in the retry queue. */
export function classifyMirrorFailure(error: unknown): MirrorFailure {
  const value = error as { code?: unknown; message?: unknown } | undefined;
  const message = error instanceof Error
    ? error.message
    : typeof value?.message === "string"
      ? value.message
      : String(error);
  const status = errorStatus(error) ?? statusFromMessage(message);
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : undefined;
  // One definition of "duplicate-shaped", shared with the Hyperliquid rejection
  // classifier, so the Postgres unique-violation text and the venue's own cloid
  // wording can never drift apart between the two call sites.
  const duplicateClientId = isDuplicateOrderIdentityMessage(message);
  /**
   * Codes that are a permanent property of the REQUEST, not a blip.
   *
   * `HL_UNKNOWN_COIN` is here because an unlisted Hyperliquid coin used to
   * arrive as a bare `Error`: no status, no code, straight into the
   * "unknown shape, assume transient" fail-safe below, requeued every 15
   * minutes forever with no attempt ceiling, wedging the delivery queue behind
   * a symbol that will never resolve. That is the same failure the
   * `statusFromMessage` note above records from the Alpaca side.
   */
  const permanentCodes = new Set(["HL_UNKNOWN_COIN"]);
  const transientCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EAGAIN",
    "EAI_AGAIN",
    "ENETUNREACH",
    "40001",
    "40P01",
    "53300",
    "57P01",
    "57P02",
    "57P03",
  ]);

  // 403 is Alpaca's wash-trade / insufficient-shares-or-buying-power refusal
  // (docs.alpaca.markets/docs/user-protection: "we reject the order and send
  // back an error message with the HTTP status code 403 (Forbidden)"). That
  // refusal is a property of the follower's OTHER open order or unsettled
  // shares, not of anything wrong with this request, so it clears on its own
  // once that order fills or cancels or the shares settle -- transient by
  // construction, the same as the 408/409/425/429/5xx below. Treating it as
  // permanent used to write the local order REJECTED and, for a mirrored
  // CLOSE, retire the one-shot exit on attempt 1 with zero retries (the close
  // exemption in `markDeliveryFailed` only lifts the ATTEMPT CEILING for
  // transient failures; it never rescues a "permanent" one).
  const transient =
    (code === undefined || !permanentCodes.has(code)) &&
    (duplicateClientId ||
      (code !== undefined && (transientCodes.has(code) || code.startsWith("08"))) ||
      (status === undefined && code === undefined) ||
      (status !== undefined &&
        (status === 403 ||
          status === 408 ||
          status === 409 ||
          status === 425 ||
          status === 429 ||
          status >= 500)));

  return { kind: transient ? "transient" : "permanent", message };
}

export function mirrorRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(MIRROR_RETRY_BASE_MS * 2 ** (safeAttempt - 1), MAX_RETRY_DELAY_MS);
}

/** The delivery-row fields the deferred-close backlog is derived from. */
export interface DeferredCloseRow {
  sourceItemId: string;
  followerUserId: string;
  createdAt: Date;
  attempts: number;
  lastError: string | null;
}

/**
 * What the deferred perp-close queue looks like right now.
 *
 * This decides NOTHING. A close that preflight defers is deliberately never
 * dropped and never expires, and `markDeliveryFailed` deliberately exempts it
 * from the attempt ceiling; both of those are correct and neither is affected
 * by anything here. The gap this fills is that nothing ever LOOKED at the queue
 * those rules produce: switching perps off left closes retrying every fifteen
 * minutes indefinitely, with no count, no age and no signal anywhere.
 *
 * A value rather than only a log line, so a status endpoint can report the two
 * numbers an operator needs without rebuilding the query and drifting from it.
 */
export interface DeferredCloseBacklog {
  /** Queued closes the scan saw. A floor, not a total, when `truncated`. */
  count: number;
  /** How long the oldest queued close has waited, or null when none is queued. */
  oldestAgeMs: number | null;
  oldestSourceItemId: string | null;
  oldestFollowerUserId: string | null;
  /** Why the oldest one last failed, verbatim from the delivery row. */
  oldestLastError: string | null;
  /** The oldest wait has reached DEFERRED_CLOSE_WARN_AFTER_MS. */
  overdue: boolean;
  /** The scan hit its cap, so `count` is a floor. `oldestAgeMs` stays exact. */
  truncated: boolean;
}

/**
 * Summarize the queued closes. PURE, so the numbers an operator reads during an
 * incident are unit-testable without a poller, a DB or a venue client.
 *
 * `rows` is expected OLDEST FIRST, which is what makes truncation safe: the cap
 * then discards the newest end, so `count` degrades to a floor while
 * `oldestAgeMs` (the number the threshold is judged on) stays exact. The oldest
 * row is still selected by comparison rather than by position, so a caller that
 * orders differently gets a correct age instead of a plausible wrong one.
 */
export function describeDeferredCloseBacklog(
  rows: readonly DeferredCloseRow[],
  now: Date,
  scanCap: number = DEFERRED_CLOSE_SCAN_CAP,
): DeferredCloseBacklog {
  const cap = Math.max(0, Math.floor(scanCap));
  const truncated = rows.length > cap;
  const scanned = truncated ? rows.slice(0, cap) : rows;

  let oldest: DeferredCloseRow | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const row of scanned) {
    const at = row.createdAt instanceof Date ? row.createdAt.getTime() : Number.NaN;
    // A row whose timestamp is unreadable still COUNTS. Dropping it would make
    // the queue look shorter than it is, which is the exact blindness this
    // snapshot exists to end; it just cannot be nominated as the oldest.
    if (!Number.isFinite(at) || at >= oldestMs) continue;
    oldestMs = at;
    oldest = row;
  }

  // Clamped at zero so a clock that moved backwards reports "just queued"
  // rather than a negative wait that would read as comfortably under bound.
  const oldestAgeMs = oldest ? Math.max(0, now.getTime() - oldestMs) : null;

  return {
    count: scanned.length,
    oldestAgeMs,
    oldestSourceItemId: oldest?.sourceItemId ?? null,
    oldestFollowerUserId: oldest?.followerUserId ?? null,
    oldestLastError: oldest?.lastError ?? null,
    overdue: oldestAgeMs !== null && oldestAgeMs >= DEFERRED_CLOSE_WARN_AFTER_MS,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Env-flag readers (centralized so the gating is unambiguous and testable).
// ---------------------------------------------------------------------------

/** The master kill switch. Auto-mirror is inert unless this is exactly "true". */
export function isAutoMirrorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_ENABLED === "true";
}

/** Live-account opt-in. Mirroring onto a LIVE account is refused unless exactly "true". */
export function isAutoMirrorLiveAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true";
}

/** Hyperliquid defaults to mainnet, so production money needs a second explicit opt-in. */
export function isPerpsMainnetAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET === "true";
}

export function isHyperliquidMainnet(env: NodeJS.ProcessEnv = process.env): boolean {
  return networkFromEnv(env) === "mainnet";
}

/** Perp automation never relies on Hyperliquid's implicit mainnet default. */
export function isHyperliquidNetworkExplicit(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HYPERLIQUID_NETWORK === "mainnet") return true;
  return env.HYPERLIQUID_NETWORK === "testnet" && env.HYPERLIQUID_ALLOW_TESTNET === "true";
}

// ---------------------------------------------------------------------------
// Pure decision logic (DB-free, broker-free, exported for unit tests)
// ---------------------------------------------------------------------------

function optionPositionIntent(action: "BuyToOpen" | "SellToClose"):
  | "buy_to_open"
  | "sell_to_close" {
  return action === "BuyToOpen" ? "buy_to_open" : "sell_to_close";
}

function contractMultiplier(assetType: AlpacaMirrorAssetType): number {
  return assetType === "OPTION" ? OPTION_CONTRACT_MULTIPLIER : 1;
}

export interface MirrorCandidate {
  /** The follower (this user's own account places the mirrored order). */
  followerUserId: string;
  /** SOURCE-PREFIXED CopyTradeItem id of the trade being mirrored, e.g. "user:<uuid>". */
  sourceItemId: string;
  /** Symbol to trade. */
  symbol: string;
  /** Direction copied from the source trade. */
  side: "buy" | "sell";
  /** Follower's sizing rule. */
  sizingMode: SizingMode;
  sizingValue: number;
  /** Optional dollar cap per single mirrored order. null = no cap. */
  maxTradeSize?: number | null;
  /** Follower account context. */
  buyingPower: number;
  /** Follower net equity (for pct_equity mode). 0/missing → pct_equity skips. */
  equity?: number;
  /** Whether the follower's resolved account is a paper/sim account. */
  isPaper: boolean;
  /** Current price used to size the order. */
  price: number;
  /** Dollar multiplier per unit. Equities are 1; option contracts are 100. */
  contractMultiplier?: number;
  /**
   * Whether the broker treats the symbol as fractionable (Alpaca: asset.fractionable).
   * Equity-only; options are always whole-contract regardless of this flag.
   */
  allowFractional?: boolean;
  /**
   * Source trader's share/contract count. Required for ratio sizing mode;
   * undefined for other modes. Ratio mode with missing sourceQty → skip.
   */
  sourceQty?: number;
  /** How many mirrors this follower has already placed today (for the daily cap). */
  mirrorsToday: number;
  /** Whether a prior mirror with this idempotency key already exists. */
  alreadyMirrored: boolean;
  /** Resolved per-follow guardrails. */
  dailyCap: number;
  maxOrderDollars: number;
}

export type MirrorDecision =
  | {
      action: "place";
      qty: number;
      orderDollars: number;
      clientOrderId: string;
    }
  | {
      action: "skip";
      reason: "dollar-cap";
      clientOrderId: string;
      orderDollars: number;
      maxOrderDollars: number;
    }
  | {
      action: "skip";
      reason: "duplicate" | "live-not-allowed" | "no-qty" | "daily-cap";
      clientOrderId: string;
    };

/**
 * Decide whether a single (follower, source-trade) candidate should be mirrored.
 *
 * PURE: no DB, no broker, no env reads — every input is supplied by the caller so
 * this is trivially unit-testable. Order of guards (cheapest / most important
 * first):
 *   1. dedupe   — never mirror the same source trade to the same follower twice.
 *   2. live gate — refuse LIVE accounts unless explicitly allowed.
 *   3. sizing   — compute whole-share qty; 0 shares => skip.
 *   4. dollar cap — per-order notional ceiling.
 *   5. daily cap  — per-follow mirrors-per-day ceiling.
 *
 * Guards 4 and 5 bound how much NEW exposure the mirror may create, so a
 * CLOSING intent is exempt from both. See the block above them for the full
 * argument.
 *
 * @param liveAllowed result of isAutoMirrorLiveAllowed() — passed in so the
 *        decision stays pure and the live-gate can be tested both ways.
 */
export function decideMirror(c: MirrorCandidate, liveAllowed: boolean): MirrorDecision {
  const clientOrderId = mirrorIdempotencyKey({
    followerUserId: c.followerUserId,
    sourceItemId: c.sourceItemId,
  });

  // (1) Idempotency: this exact source trade was already mirrored to this follower.
  if (c.alreadyMirrored) {
    return { action: "skip", reason: "duplicate", clientOrderId };
  }

  // (2) Paper-first: a LIVE account is only mirrored when the operator has set
  //     COPY_TRADE_AUTOMIRROR_ALLOW_LIVE="true". Paper/sim always allowed.
  if (!c.isPaper && !liveAllowed) {
    return { action: "skip", reason: "live-not-allowed", clientOrderId };
  }

  // (3) Sizing: whole-share (or fractional, when allowed) qty from the
  //     follower's rule. 0 => nothing to place.
  const qty = computeMirrorQty({
    sizingMode: c.sizingMode,
    sizingValue: c.sizingValue,
    maxTradeSize: c.maxTradeSize ?? null,
    buyingPower: c.buyingPower,
    equity: c.equity,
    sourceQty: c.sourceQty,
    price: c.price,
    contractMultiplier: c.contractMultiplier ?? 1,
    allowFractional: c.allowFractional === true,
  });
  if (qty <= 0) {
    return { action: "skip", reason: "no-qty", clientOrderId };
  }

  const orderDollars = qty * c.price * (c.contractMultiplier ?? 1);

  // ---- Both caps bound NEW EXPOSURE, so an EXIT is exempt from both. ----
  //
  // A mirrored SELL on this path can only ever reduce a holding:
  // `decideSellMirrorQty` refuses to open a short and
  // `clampSellToMirroredExposure` refuses anything the mirror did not open, so
  // `side === "sell"` is the equity equivalent of a reduce-only perp order (the
  // wording is `copy-mirror-consent.ts`'s, which exempts the same intent from
  // the consent and staleness gates for the same reason).
  //
  // Applying a cap to an exit is worse than pointless. The skip is returned out
  // of `processCandidate`, and the poll loop turns any returned outcome into
  // `markDeliveryCompleted`, which is terminal. Nothing regenerates a source
  // close, so a follower whose morning entries used up the daily cap had the
  // afternoon's exit refused AND spent, and was left holding a position the
  // source is already out of with its one exit instruction consumed. The dollar
  // ceiling does the same to any position large enough to matter: the bigger
  // the exposure, the more certain the exit is refused.
  //
  // `decidePerpReduceOnlyMirror` carries no cap checks at all, and the perp
  // resume states the rule directly: "an exit is not new exposure, and a daily
  // cap must never be the reason a follower cannot get out of a leveraged
  // position". Nothing above is weakened by this: dedupe, the live gate and the
  // sizing floor all still apply to a sell, and the two clamps in
  // `processCandidate` still bound the quantity to what the mirror actually
  // opened.
  const isClosingIntent = c.side === "sell";

  // (4) Per-order dollar guardrail (fails closed for bad caps). OPENS only.
  if (
    !isClosingIntent &&
    !withinDollarCap({ orderDollars, maxOrderDollars: c.maxOrderDollars })
  ) {
    return {
      action: "skip",
      reason: "dollar-cap",
      clientOrderId,
      orderDollars,
      maxOrderDollars: c.maxOrderDollars,
    };
  }

  // (5) Per-follow daily guardrail (fails closed for bad caps / counts). OPENS only.
  if (
    !isClosingIntent &&
    !withinDailyCap({ mirrorsToday: c.mirrorsToday, dailyCap: c.dailyCap })
  ) {
    return { action: "skip", reason: "daily-cap", clientOrderId };
  }

  return { action: "place", qty, orderDollars, clientOrderId };
}

// Discovery-side helpers that moved out with `findMirrorCandidates` (audit H7),
// re-exported so existing call sites and unit tests keep importing them from
// this file.
export { isMirrorableAsset } from "./copy-mirror-candidate-sources";
export { isPerpsAutoMirrorEnabled } from "./copy-mirror-perp-sync-gate";

// Perp sizing decisions now live in their own module (audit H7), re-exported
// here for the same reason.
export {
  decidePerpMirror,
  decidePerpReduceOnlyMirror,
  type PerpMirrorCandidate,
  type PerpMirrorDecision,
  type PerpReduceOnlyMirrorCandidate,
  type PerpReduceOnlyMirrorDecision,
} from "./copy-mirror-perp-decisions";

/**
 * SELL-side safety decision (PURE).
 *
 * A mirrored SELL is sized like a buy by decideMirror, but a follower who holds
 * NO long position in the symbol would have that "sell" placed as a naked SHORT
 * — opening risk the follower never asked for. This clamps a mirror SELL to the
 * follower's actual long holding:
 *
 *   - no LONG position (none, or a short) => skip (`no-long-position`); we never
 *     OPEN a short by mirroring.
 *   - otherwise => SELL at most the held long qty (min(computedQty, heldLongQty)),
 *     so the worst case is fully closing the existing long, never flipping short.
 *
 * `heldLongQty` is the follower's current long share count for the symbol (0 if
 * the follower has no position, or a short position). BUYS never call this.
 */
export function decideSellMirrorQty(
  computedQty: number,
  heldLongQty: number,
): { action: "place"; qty: number } | { action: "skip"; reason: "no-long-position" } {
  if (!Number.isFinite(heldLongQty) || heldLongQty <= 0) {
    return { action: "skip", reason: "no-long-position" };
  }
  return { action: "place", qty: Math.min(computedQty, Math.floor(heldLongQty)) };
}

/** The columns one of the follower's own mirror order rows contributes. */
export interface MirroredEquityOrderRow {
  /** The logical mirror key, whose source suffix is the attribution boundary. */
  clientOrderId?: string | null;
  tradeAction: string | null;
  status: string | null;
  /** The REQUESTED share count. */
  quantity: number | null;
  /** The FILLED share count, once the reconciler has written one. */
  executedQuantity: number | null;
  /** Local row timestamps, retained for legacy diagnostics and deterministic ties. */
  createdAt?: Date | null;
  executedAt?: Date | null;
}

type MirrorSignalIdentityRow = {
  id: string;
  source: string;
  sourceAuthorId?: string | null;
  symbol: string;
  content: string;
  metadata: unknown;
  timestamp: Date;
  createdAt?: Date | null;
};

/** Normalize persisted JSON without accepting arrays or malformed payloads. */
function signalMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === "string") {
    try {
      return signalMetadataRecord(JSON.parse(metadata));
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

/** Resolve immutable ownership through the shared canonical-author reader. */
function mirrorSignalAuthorKey(signal: Pick<MirrorSignalIdentityRow, "source" | "sourceAuthorId" | "metadata">): string | null {
  const metadata = signalMetadataRecord(signal.metadata);
  if (signal.sourceAuthorId && !metadata.sourceAuthorId) {
    metadata.sourceAuthorId = signal.sourceAuthorId;
  }
  return readCanonicalAuthorForSource(metadata, signal.source).canonicalAuthorKey;
}

/** Only the source timestamp can bound a signal lifecycle. */
function mirrorSignalEventAt(signal: Pick<MirrorSignalIdentityRow, "timestamp">): Date | null {
  return signal.timestamp instanceof Date && Number.isFinite(signal.timestamp.getTime())
    ? signal.timestamp
    : null;
}

/** Only explicit, consistent contract counts can define a source position. */
function mirrorSignalOptionUnits(signal: Pick<MirrorSignalIdentityRow, "metadata" | "content">): number | null {
  const metadata = signalMetadataRecord(signal.metadata);
  const counts: number[] = [];
  for (const key of ["quantity", "qty", "contracts", "contractCount"]) {
    const raw = metadata[key];
    if (raw === undefined || raw === null) continue;
    if ((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "") return null;
    if (typeof raw === "string" && !/^\d+$/.test(raw.trim())) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    counts.push(value);
  }
  for (const match of signal.content.matchAll(/(?<![\w.])([+-]?\d+(?:\.\d+)?)\s+contracts?\b/gi)) {
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    counts.push(value);
  }
  return counts.length > 0 && counts.every(value => value === counts[0]) ? counts[0]! : null;
}

/**
 * Is this mirrored row an exit rather than an entry?
 *
 * The mirror writes exactly four trade actions on this path ("Buy" / "Sell" for
 * equities, "BuyToOpen" / "SellToClose" for options) and every row read here is
 * one of its own, selected by the client-order-id prefix, so the leading verb
 * decides the direction with no ambiguity.
 */
function isMirroredEquityDisposal(tradeAction: string | null): boolean {
  return typeof tradeAction === "string" && tradeAction.startsWith("Sell");
}

/**
 * How many shares one mirror order has ACTUALLY put in the account.
 *
 * Only `executedQuantity` counts, filled or still-working alike: a rejected
 * or cancelled order put nothing in the account whatever it asked for, and an
 * order that is still working (PENDING/SYNCING/SUBMITTED/PARTIAL) has moved
 * only what it has filled SO FAR. `quantity` is a REQUEST, not a holding —
 * Alpaca's own `filled_qty` is the only field describing what the mirror
 * actually put there (docs.alpaca.markets/docs/orders-at-alpaca).
 *
 * This used to credit an unsettled row at its full REQUESTED size, on the
 * theory that under-reading a still-settling open would refuse an exit for a
 * position that genuinely exists, and that over-reading was harmless because
 * "the live-position clamp still applies on top". That clamp
 * (`decideSellMirrorQty`/`fetchLongQty`) bounds a mirrored SELL to the
 * follower's WHOLE long, hand-bought shares included, so an inflated read
 * here was not caught by anything: it was spent straight out of the
 * follower's own holding the moment the paired open failed to fill (or simply
 * had not filled yet). alpaca-13.
 *
 * Reading a still-settling open as under its request is HELD, not silently
 * accepted: `mirroredEquityExposure` returns `unanswerable: "settling"`
 * whenever any of the follower's mirrored opens for this symbol is still
 * working, precisely so a fill that has already happened at the broker but
 * has not been reconciled into this row yet cannot be misread as "no
 * exposure" and spend the one-shot exit for nothing.
 */
function mirroredEquityRowQty(row: MirroredEquityOrderRow): number {
  const executed = Number(row.executedQuantity);
  return Number.isFinite(executed) && executed > 0 ? executed : 0;
}

/**
 * Is this mirror row proven FINISHED at the broker?
 *
 * FILLED / CANCELLED / REJECTED / EXPIRED are the only terminal values of
 * `orderStatusEnum` (`packages/db/src/schema/orders.ts`); PENDING, SYNCING,
 * SUBMITTED and PARTIAL are all still working, and a null status (should not
 * occur; the column is NOT NULL) is treated the same conservative way.
 */
function isMirroredEquityRowSettled(row: MirroredEquityOrderRow): boolean {
  return (
    row.status === "FILLED" ||
    row.status === "CANCELLED" ||
    row.status === "REJECTED" ||
    row.status === "EXPIRED"
  );
}

/**
 * Net share exposure the MIRROR still holds, from the mirror's own orders (PURE).
 *
 * Opens add and mirrored exits subtract, so an account the mirror opened and
 * has since closed reads as flat rather than staying attributable forever.
 *
 * FIXED-POINT, not floats. `executed_quantity` is a float8 and fractional fills
 * are possible, so netting through IEEE-754 can leave residue: 0.1 and 0.2 of
 * opens against a 0.3 exit sum to 2.8e-17, which is greater than zero and would
 * read as a live position that a close could be sized against. Whole
 * micro-shares are finer than any fill Alpaca reports and cancel exactly.
 */
export function netMirroredEquityQty(rows: readonly MirroredEquityOrderRow[]): number {
  const MICRO = 1_000_000;
  let micro = 0;
  for (const row of rows) {
    const qty = Math.round(mirroredEquityRowQty(row) * MICRO);
    micro += isMirroredEquityDisposal(row.tradeAction) ? -qty : qty;
  }
  return micro > 0 ? micro / MICRO : 0;
}

/**
 * Net mirror exposure for an entry cap, including durable open reservations.
 *
 * Filled/terminal rows contribute their filled quantity. An unsettled BUY is a
 * reservation and contributes its requested quantity, because that is the
 * amount the venue may still fill after this read. An unsettled SELL cannot
 * safely be credited before it fills, so only its filled quantity reduces the
 * current exposure. This is intentionally separate from `netMirroredEquityQty`
 * which answers the close-attribution question using filled quantities only.
 */
export function netReservedMirroredEquityQty(
  rows: readonly MirroredEquityOrderRow[],
): number {
  const MICRO = 1_000_000;
  let micro = 0;
  for (const row of rows) {
    const filled = Math.round(mirroredEquityRowQty(row) * MICRO);
    const requestedRaw = Number(row.quantity);
    const requested = Number.isFinite(requestedRaw) && requestedRaw > 0
      ? Math.round(requestedRaw * MICRO)
      : filled;
    const unsettled = !isMirroredEquityRowSettled(row);
    const disposal = isMirroredEquityDisposal(row.tradeAction);
    const contribution = disposal
      ? -filled
      : unsettled
        ? requested
        : filled;
    micro += contribution;
  }
  return micro > 0 ? micro / MICRO : 0;
}

/**
 * SELL-side ATTRIBUTION decision (PURE).
 *
 * `decideSellMirrorQty` stops a mirrored SELL from opening a short by clamping
 * it to the destination account's long. That long is the follower's ENTIRE
 * holding though, hand-bought shares included, so it is not on its own an
 * answer to "how much of this is the mirror's to sell". A follower holding 500
 * shares they bought themselves had 50 of them sold the first time a followed
 * trader closed a position the mirror never copied for them.
 *
 * This is the second ceiling: a copied close may only ever reduce the part the
 * mirror opened, which is the same rule `decidePerpReduceOnlyMirror` enforces
 * for perps by requiring `mirroredExposureSizeDecimal`. With no mirrored
 * exposure on file there is nothing to exit and the close is refused outright.
 *
 * `mirroredLongQty` is NOT floored. It comes from the mirror's own fills, so a
 * fractional value can only exist because a mirrored BUY was itself fractional,
 * which in turn means the symbol is fractionable and the exit can be too.
 */
export function clampSellToMirroredExposure(
  sellQty: number,
  mirroredLongQty: number,
): { action: "place"; qty: number } | { action: "skip"; reason: "no-mirrored-exposure" } {
  if (!Number.isFinite(mirroredLongQty) || mirroredLongQty <= 0) {
    return { action: "skip", reason: "no-mirrored-exposure" };
  }
  return { action: "place", qty: Math.min(sellQty, mirroredLongQty) };
}

/**
 * Proportionally apply a source-side close to the follower's attributed fill.
 *
 * A source SELL of 25 from a 100-share source position closes 25% of the
 * source's position. The follower may have copied 40 shares of that position,
 * so the close owed to the follower is 10, not the full 40. Quantities are
 * rounded down to the precision this path can safely attribute; a positive
 * source close that rounds to zero is held by the caller rather than consumed.
 */
export function proportionalEquityCloseQty(
  mirroredQty: number,
  sourceCloseQty: number,
  sourcePositionQty: number,
  assetType: "EQUITY" | "OPTION" = "EQUITY",
): number | null {
  if (
    !Number.isFinite(mirroredQty) || mirroredQty <= 0 ||
    !Number.isFinite(sourceCloseQty) || sourceCloseQty <= 0 ||
    !Number.isFinite(sourcePositionQty) || sourcePositionQty <= 0 ||
    sourceCloseQty > sourcePositionQty
  ) {
    return null;
  }
  const raw = mirroredQty * (sourceCloseQty / sourcePositionQty);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const precision = assetType === "OPTION" ? 1 : 1_000_000;
  const rounded = Math.floor((raw + Number.EPSILON) * precision) / precision;
  return rounded > 0 ? rounded : null;
}

/**
 * Resolve the generic equity per-follow guardrails from env, falling back to
 * the shared defaults. Hyperliquid perps normalize this daily cap before using
 * it for either a decision or a Phase-A reservation.
 */
export function resolveGuardrails(env: NodeJS.ProcessEnv = process.env): {
  dailyCap: number;
  maxOrderDollars: number;
} {
  const parsePositive = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    dailyCap: parsePositive(env.COPY_TRADE_AUTOMIRROR_DAILY_CAP, DEFAULT_MIRROR_DAILY_CAP),
    maxOrderDollars: parsePositive(
      env.COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS,
      DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
    ),
  };
}

/**
 * Parse a Hyperliquid decimal size string that may legitimately be "0" (an
 * IoC attempt that matched no liquidity at all). Unlike the exposure math in
 * `copy-mirror-perp-decimal.ts` (which treats "0" as absent, since a fill of
 * nothing is not a fill), zero is a real, expected value here: it is the
 * total-shortfall case `perpCloseShortfall` exists to detect.
 */
function parsePerpSizeAllowingZero(value: string): { coefficient: bigint; scale: number } | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole}${fraction}`;
  return { coefficient: BigInt(digits === "" ? "0" : digits), scale: fraction.length };
}

/**
 * The size Hyperliquid actually filled for the single order a `placeOrder`
 * call just submitted, read from the venue's own response at
 * `response.data.statuses[0].filled.totalSz` (exchange-endpoint docs: an
 * `Ioc` order "fills immediately or cancels any unfilled portion", and
 * reports the filled amount at exactly this path).
 *
 * Null whenever that shape is not found: a rejection (which throws before
 * this is ever consulted), a shape this parser does not recognize, or a test
 * fixture that never bothered to simulate one. Null is deliberately NOT
 * treated as "filled nothing": this function has no way to tell "the venue
 * filled zero" apart from "this response does not say", and guessing the
 * former would invent a shortfall (and a sweep order) out of a response this
 * code simply could not read. Only a POSITIVELY parsed `totalSz` counts as
 * evidence either way.
 */
function perpOrderFilledSize(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const response = Reflect.get(result, "response");
  if (typeof response !== "object" || response === null) return null;
  const data = Reflect.get(response, "data");
  if (typeof data !== "object" || data === null) return null;
  const statuses = Reflect.get(data, "statuses");
  if (!Array.isArray(statuses) || statuses.length === 0) return null;
  const status = statuses[0];
  if (typeof status !== "object" || status === null) return null;
  const filled = Reflect.get(status, "filled");
  if (typeof filled !== "object" || filled === null) return null;
  const totalSz = Reflect.get(filled, "totalSz");
  return typeof totalSz === "string" ? totalSz : null;
}

/**
 * The unfilled remainder of a reduce-only IoC close (`requested - filled`),
 * as a positive decimal string, or null when nothing remains to sweep: the
 * order filled in full, `filledSizeCoin` is unknown (see `perpOrderFilledSize`),
 * or either size could not be read as a decimal.
 */
function perpCloseShortfall(
  requestedSizeCoin: string,
  filledSizeCoin: string | null,
): string | null {
  if (filledSizeCoin === null) return null;
  const requested = parsePerpSizeAllowingZero(requestedSizeCoin);
  const filled = parsePerpSizeAllowingZero(filledSizeCoin);
  if (!requested || !filled) return null;
  const scale = Math.max(requested.scale, filled.scale);
  const atScale = (value: { coefficient: bigint; scale: number }) =>
    value.coefficient * 10n ** BigInt(scale - value.scale);
  const remainder = atScale(requested) - atScale(filled);
  return remainder > 0n ? formatDecimal(remainder, scale) : null;
}

/**
 * The cumulative size two IoC legs of one close POSITIVELY reported filling.
 *
 * A LOWER BOUND, deliberately, not a best guess. A leg whose report could not
 * be read (`perpOrderFilledSize` returned null) contributes nothing rather than
 * invalidating the whole total: the retire gate downstream compares with `>=`,
 * so understating the fill can only ever keep the follower's stop resting over
 * exposure that may already be gone, which is this module's stated tiebreak (an
 * unretired leg is an annoyance, an unprotected leveraged position is a loss).
 *
 * Null only when the FIRST leg's report was unreadable, i.e. when there is no
 * bound at all. That is the "unknown" of a tri-state, and the caller must not
 * read it as zero: reading an unparseable venue response as "filled nothing"
 * would keep triggers resting over every fully closed position whose response
 * shape this code does not recognize.
 */
function perpFilledSizeTotal(first: string | null, second: string | null): string | null {
  if (first === null) return null;
  const a = parsePerpSizeAllowingZero(first);
  if (!a) return null;
  if (second === null) return first;
  const b = parsePerpSizeAllowingZero(second);
  if (!b) return first;
  const scale = Math.max(a.scale, b.scale);
  const atScale = (value: { coefficient: bigint; scale: number }) =>
    value.coefficient * 10n ** BigInt(scale - value.scale);
  return formatDecimal(atScale(a) + atScale(b), scale);
}

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

export class CopyMirrorPoller {
  private db: WorkerPoolDb;
  private readonly createPerpClient: typeof createHyperliquidExchangeClient;
  private readonly sendMirrorSummary: (input: DiscordMirrorSummary) => Promise<void>;
  private isRunning = false;
  /** Single-flight guard: true while a poll cycle is in flight. */
  private polling = false;
  private intervalId?: ReturnType<typeof setInterval>;
  private summaryIntervalId?: ReturnType<typeof setInterval>;
  private summaryPolling = false;
  private pollIntervalMs = POLL_INTERVAL_MS;
  private lastUnprotectedPerpAlertAt = 0;
  private lastUnprotectedPerpAlertKey = "";

  constructor(
    db: WorkerPoolDb,
    dependencies: {
      createPerpClient?: typeof createHyperliquidExchangeClient;
      sendMirrorSummary?: (input: DiscordMirrorSummary) => Promise<void>;
    } = {},
  ) {
    this.db = db;
    this.createPerpClient = dependencies.createPerpClient ?? createHyperliquidExchangeClient;
    this.sendMirrorSummary =
      dependencies.sendMirrorSummary ?? createDiscordMirrorSummarySender(db);
  }

  /**
   * Start the poller.
   *
   * KILL SWITCH: if COPY_TRADE_AUTOMIRROR_ENABLED is not exactly "true", we log a
   * disabled message and return WITHOUT scheduling anything — no interval, no DB
   * reads, no orders. This is the default and the single guarantee that the
   * feature is inert until an operator deliberately turns it on.
   */
  public async start(): Promise<void> {
    if (!isAutoMirrorEnabled()) {
      logger.info(LOG_SERVICE, "[copy-mirror] disabled (COPY_TRADE_AUTOMIRROR_ENABLED!=true)");
      return; // <-- inert: nothing scheduled, nothing read, nothing placed.
    }

    if (this.isRunning) return;
    this.isRunning = true;

    const { dailyCap, maxOrderDollars } = resolveGuardrails();
    logger.warn(
      LOG_SERVICE,
      "[copy-mirror] ENABLED — auto-mirror will place REAL orders for follows with auto_mirror=true",
      {
        liveAllowed: isAutoMirrorLiveAllowed(),
        // The EFFECTIVE answer, reconciler precondition included, not the raw flag.
        perpsEnabled: isPerpsAutoMirrorEnabled(),
        perpsMainnetAllowed: isPerpsMainnetAllowed(),
        dailyCap,
        maxOrderDollars,
        pollIntervalMs: this.pollIntervalMs,
      },
    );

    // An operator who turned perps on WITHOUT the Hyperliquid reconciler gets
    // one loud line naming both variables, and no perp mirroring at all. Stock
    // mirroring below is unaffected: the gate is consulted only on perp paths.
    const syncGateRefusal = takePerpSyncGateRefusal();
    if (syncGateRefusal) {
      logger.error(LOG_SERVICE, syncGateRefusal.message, {
        // Names only. A config VALUE never reaches a log line from here.
        envVars: syncGateRefusal.envVars,
        perpMirroringAllowed: false,
      });
    }

    // Kick once, then on an interval.
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.summaryIntervalId = setInterval(() => void this.pollMirrorSummaries(), this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.summaryIntervalId) clearInterval(this.summaryIntervalId);
    this.summaryIntervalId = undefined;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    logger.info(LOG_SERVICE, "[copy-mirror] stopped");
  }

  /**
   * One polling cycle: find new source trades for auto-mirror follows since the
   * last checkpoint and process each (follower, source-trade) candidate.
   *
   * Wrapped end-to-end in try/catch so a transient DB/broker error never crashes
   * the worker process. Defensive at every step.
   */
  private async poll(): Promise<void> {
    // Re-check the kill switch on every cycle so disabling the flag (and a
    // restart) is sufficient to stop all activity, belt-and-suspenders.
    if (!isAutoMirrorEnabled()) return;
    // Single-flight guard: a slow cycle (cred decrypt + broker round-trips per
    // candidate) can exceed the poll interval. Never run two cycles at once — an
    // overlap reuses the same window and could double-place before the first
    // cycle's order rows (and their client_order_id dedupe) exist.
    if (this.polling) {
      logger.warn(LOG_SERVICE, "[copy-mirror] previous cycle still running; skipping tick");
      return;
    }
    this.polling = true;

    try {
      // The watermark and the rows it selects have to be stamped by ONE clock.
      // Discovery filters source rows on DATABASE-assigned timestamps
      // (`social_trades.created_at` is `defaultNow()`, i.e. Postgres `now()`),
      // so a `new Date()` taken here would compare two unrelated clocks. On a
      // worker host whose clock leads the database by d, every cycle parks the
      // checkpoint d past the newest row the database could have written, and
      // that d-wide band of source events is skipped. It is skipped PERMANENTLY:
      // `stageWindow` advances the checkpoint either way and nothing recreates a
      // source close, so the band is followers left holding mirrored positions
      // whose only exit instruction was never staged. Reading the window end
      // from the database puts both sides of the comparison on its clock.
      const windowEnd = await this.readSourceClockNow();
      const windowStart = await this.loadOrCreateCheckpoint(windowEnd);
      const sourceWindowStart = mirrorSourceReplayStart(windowStart);
      const { dailyCap, maxOrderDollars } = resolveGuardrails();
      const perpDailyCap = resolvePerpDailyCap();
      const liveAllowed = isAutoMirrorLiveAllowed();
      // RAW flag on purpose: the reconciler gate is applied in
      // processPerpCandidate, which needs to tell "the operator left perps off"
      // apart from "the operator turned perps on without the reconciler".
      const perpsEnabled = readPerpsAutoMirrorFlag();
      const mainnetAllowed = isPerpsMainnetAllowed();

      // 1) Page the global armed-follow set and source backlog independently.
      // Each scan captures a fixed normalized-key/id fence before its first
      // page. Source discovery replays a bounded overlap so a row inserted
      // after an earlier page, or a follow armed during paging, is reconsidered
      // on the next cycle. Durable delivery uniqueness absorbs that replay.
      // The checkpoint itself remains monotonic and advances only after every
      // page and batch succeeds.
      await this.forEachAutoMirrorFollowPage(async (follows) => {
        const stageBatch = async (batch: MirrorSourceCandidate[]) => {
          await this.stageDeliveryBatch(windowEnd, batch);
        };
        const collected = await this.findMirrorCandidates(
          follows,
          sourceWindowStart,
          windowEnd,
          stageBatch,
        );
        // Preserve the method seam used by focused tests and older integrations
        // that override discovery without the streaming callback.
        for (let offset = 0; offset < collected.length; offset += COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE) {
          await stageBatch(collected.slice(offset, offset + COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE));
        }
      });
      await this.advanceCheckpoint(windowStart, windowEnd);

      // 2) Process both newly staged and previously failed due deliveries. Their
      // frozen payload retains the exact selected credential across restarts.
      const due = await this.loadDueDeliveries(windowEnd);
      await runFollowerDeliveryLanes(due, DELIVERY_FOLLOWER_CONCURRENCY, async (row) => {
        // Claim the row BEFORE executing it. `this.polling` only stops two
        // cycles overlapping WITHIN this process; a second worker replica
        // polling concurrently would load the same due row and place a
        // second real order under the same cloid, unaware of this one. A lost
        // claim means another process (or another cycle) already has this
        // row. Stop this follower's lane so its later close cannot overtake an
        // in-flight open; unrelated follower lanes may safely keep progressing.
        const claimed = await this.claimDelivery(row.id, row.nextAttemptAt, windowEnd);
        if (!claimed) {
          logger.warn(
            LOG_SERVICE,
            "[copy-mirror] delivery claim lost to another process; stopping follower lane",
            { followerUserId: row.followerUserId, sourceItemId: row.sourceItemId },
          );
          return false;
        }
        try {
          const outcome = await this.processCandidate(
            row.candidate as unknown as MirrorSourceCandidate,
            {
              dailyCap,
              perpDailyCap,
              maxOrderDollars,
              liveAllowed,
              perpsEnabled,
              mainnetAllowed,
            },
          );
          const awaitingPerpOpenFill =
            outcome === "placed" &&
            row.candidate?.assetType === "PERP" &&
            row.candidate.perpReduceOnly !== true;
          if (outcome === "syncing" || awaitingPerpOpenFill) {
            await this.markDeliveryFailed(
              row,
              {
                kind: "transient",
                message: awaitingPerpOpenFill
                  ? "Hyperliquid mirror accepted; awaiting a positive fill confirmation"
                  : "local broker acceptance is still syncing",
              },
              windowEnd,
              {
                // An unresolved Hyperliquid open is a durable venue hand-off,
                // not an ordinary bounded retry. The row may already be live
                // while its broker id/protection write is still catching up;
                // terminalizing its inbox delivery after eight polls would
                // strand the durable protection intent before recovery can run.
                retryWithoutCeiling:
                  row.candidate?.assetType === "PERP" && row.candidate.perpReduceOnly !== true,
              },
            );
          } else {
            await this.markDeliveryCompleted(row.id, outcome, windowEnd);
          }
        } catch (err) {
          const failure = classifyMirrorFailure(err);
          await this.markDeliveryFailed(
            row,
            failure,
            windowEnd,
            {
              // Protection recovery is deliberately fail-closed. A missing
              // credential/wallet or a currently active owner must keep the
              // inbox pending so a later poll can self-heal; it must not spend
              // the one durable recovery opportunity at the ordinary ceiling.
              retryWithoutCeiling:
                row.candidate?.assetType === "PERP" &&
                row.candidate.perpReduceOnly !== true &&
                failure.kind === "transient" &&
                failure.message.toLowerCase().includes("protection recovery"),
            },
          );
          const closingDelivery = isClosingCandidate(row.candidate);
          const exhausted = hasExhaustedDeliveryAttempts(row.attempts + 1) && !closingDelivery;
          logger[exhausted || failure.kind === "permanent" ? "error" : "warn"](
            LOG_SERVICE,
            "[copy-mirror] candidate failed",
            {
              followerUserId: row.followerUserId,
              sourceItemId: row.sourceItemId,
              failureKind: failure.kind,
              deliveryStatus:
                exhausted || failure.kind === "permanent" ? "permanent_failure" : "pending",
              error: failure.message,
            },
          );
        }
        return true;
      });
      await this.pollMirrorSummaries();

      // 3) Report the perp closes this cycle could not deliver. Observability
      //    only: it places nothing, consumes nothing and cannot fail the cycle.
      //    A deferred close is held on purpose, but a held close nobody counts
      //    is a follower stuck in a leveraged position that nobody counts.
      await this.reportDeferredCloseBacklog(windowEnd);
      // 4) And the mirrored perp positions whose configured exit never got
      //    attached. Same contract: observability only, places nothing, cannot
      //    fail the cycle.
      await this.emitUnprotectedPerpBacklog(windowEnd);
    } catch (err) {
      logger.error(LOG_SERVICE, "[copy-mirror] poll cycle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * The database's own clock, which is the clock every source row is stamped
   * with. Read once per cycle and used for the whole window so the checkpoint
   * can never advance past a timestamp the database is still capable of
   * assigning.
   *
   * A failed or unusable read throws rather than falling back to `new Date()`:
   * the fallback is the defect this replaces, and the caller's catch turns a
   * throw into a skipped cycle with the checkpoint untouched, so the next cycle
   * re-scans the same window instead of stepping over it.
   */
  private async readSourceClockNow(): Promise<Date> {
    return readDatabaseNow(this.db);
  }

  private async loadOrCreateCheckpoint(now: Date): Promise<Date> {
    const [inserted] = await this.db
      .insert(schema.copyMirrorCheckpoints)
      .values({ consumer: CHECKPOINT_CONSUMER, watermark: now })
      .onConflictDoNothing({ target: schema.copyMirrorCheckpoints.consumer })
      .returning({ watermark: schema.copyMirrorCheckpoints.watermark });
    if (inserted) return inserted.watermark;

    const existing = await this.db.query.copyMirrorCheckpoints.findFirst({
      where: eq(schema.copyMirrorCheckpoints.consumer, CHECKPOINT_CONSUMER),
      columns: { watermark: true },
    });
    if (!existing) throw new Error("copy-mirror checkpoint disappeared after initialization");
    return existing.watermark;
  }

  async stageWindow(
    windowStart: Date,
    windowEnd: Date,
    candidates: MirrorSourceCandidate[],
  ): Promise<void> {
    // Deterministic execution order by SOURCE event time. A trader who opens
    // and closes inside one window must have the open processed first: the
    // close would otherwise skip on no-position, be marked completed, and leave
    // the follower holding a leveraged entry the source is already out of.
    const ordered = orderCandidatesBySourceEvent(candidates);
    for (let offset = 0; offset < ordered.length; offset += COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE) {
      await this.stageDeliveryBatch(
        windowEnd,
        ordered.slice(offset, offset + COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE),
      );
    }
    await this.advanceCheckpoint(windowStart, windowEnd);
  }

  /**
   * Stage candidates discovered by an independent source watcher without
   * touching the canonical social-signal checkpoint. The database clock and
   * bounded delivery batches are shared with the normal poller so these rows
   * receive identical durable ordering, uniqueness and retry semantics.
   */
  async stageExternalCandidates(candidates: MirrorSourceCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    const stagedAt = await this.readSourceClockNow();
    const ordered = orderCandidatesBySourceEvent(candidates);
    const terminalWalletOpens: MirrorSourceCandidate[] = [];
    const pending: MirrorSourceCandidate[] = [];
    for (const candidate of ordered) {
      if (isExpiredWalletOpenIntent(candidate, stagedAt.getTime())) {
        terminalWalletOpens.push(candidate);
      } else {
        pending.push(candidate);
      }
    }

    for (let offset = 0; offset < terminalWalletOpens.length; offset += COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE) {
      await this.stageExpiredWalletOpens(
        stagedAt,
        terminalWalletOpens.slice(offset, offset + COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE),
      );
    }
    for (let offset = 0; offset < pending.length; offset += COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE) {
      await this.stageDeliveryBatch(
        stagedAt,
        pending.slice(offset, offset + COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE),
      );
    }
  }

  /** Persist the existing stale-intent outcome before a wallet source cursor advances. */
  private async stageExpiredWalletOpens(
    now: Date,
    candidates: MirrorSourceCandidate[],
  ): Promise<void> {
    if (candidates.length === 0) return;
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.copyMirrorDeliveries)
        .values(candidates.map((candidate) => ({
          followerUserId: candidate.followerUserId,
          credentialId: candidate.credentialId,
          sourceItemId: candidate.sourceItemId,
          candidate: { ...candidate, mirrorSummaryVersion: 1 },
          status: "completed",
          outcome: "stale-intent",
          nextAttemptAt: now,
          completedAt: now,
          updatedAt: now,
          lastError: null,
        })))
        .onConflictDoUpdate({
          target: [
            schema.copyMirrorDeliveries.followerUserId,
            schema.copyMirrorDeliveries.sourceItemId,
          ],
          set: {
            candidate: sql`excluded."candidate"`,
            status: "completed",
            outcome: "stale-intent",
            nextAttemptAt: now,
            completedAt: now,
            updatedAt: now,
            lastError: null,
          },
          // An unexpired claim owns the row until its lease ends. A due pending
          // row can be terminalized atomically before another worker claims it.
          setWhere: and(
            eq(schema.copyMirrorDeliveries.status, "pending"),
            lte(schema.copyMirrorDeliveries.nextAttemptAt, now),
          ),
        })
        .returning({
          followerUserId: schema.copyMirrorDeliveries.followerUserId,
          sourceItemId: schema.copyMirrorDeliveries.sourceItemId,
        });
      const resolved = new Set(rows.map((row) => `${row.followerUserId}\0${row.sourceItemId}`));
      for (const candidate of candidates) {
        if (resolved.has(`${candidate.followerUserId}\0${candidate.sourceItemId}`)) continue;
        const existing = await tx.query.copyMirrorDeliveries.findFirst({
          where: and(
            eq(schema.copyMirrorDeliveries.followerUserId, candidate.followerUserId),
            eq(schema.copyMirrorDeliveries.sourceItemId, candidate.sourceItemId),
          ),
          columns: { status: true },
        });
        if (existing?.status !== "completed" && existing?.status !== "permanent_failure") {
          throw Object.assign(
            new Error("stale wallet open is blocked by an active or unresolved delivery"),
            { code: "EAGAIN" },
          );
        }
      }
    });
  }

  private async stageDeliveryBatch(
    windowEnd: Date,
    candidates: MirrorSourceCandidate[],
  ): Promise<void> {
    if (candidates.length === 0) return;
    if (candidates.length > COPY_MIRROR_CANDIDATE_STAGE_BATCH_SIZE) {
      throw new Error("copy-mirror delivery batch exceeds the configured stage bound");
    }

    await this.db.transaction(async (tx) => {
      const ordered = orderCandidatesBySourceEvent(candidates);
      await tx
        .insert(schema.copyMirrorDeliveries)
        .values(
          ordered.map((candidate, rank) => ({
            followerUserId: candidate.followerUserId,
            credentialId: candidate.credentialId,
            sourceItemId: candidate.sourceItemId,
            candidate: { ...candidate, mirrorSummaryVersion: 1 },
            // Ranked backward from the window end so the due query's own
            // ordering carries the sequence, and every row is still due now.
            nextAttemptAt: stagedAttemptAt(windowEnd, rank, ordered.length),
          })),
        )
        .onConflictDoNothing({
          target: [
            schema.copyMirrorDeliveries.followerUserId,
            schema.copyMirrorDeliveries.sourceItemId,
          ],
        });
    });
  }

  private async advanceCheckpoint(windowStart: Date, windowEnd: Date): Promise<void> {
    if (windowEnd.getTime() < windowStart.getTime()) {
      throw new Error("copy-mirror checkpoint cannot move backwards");
    }
    await this.db.transaction(async (tx) => {
      const advanced = await tx
        .update(schema.copyMirrorCheckpoints)
        .set({ watermark: windowEnd, updatedAt: windowEnd })
        .where(
          and(
            eq(schema.copyMirrorCheckpoints.consumer, CHECKPOINT_CONSUMER),
            eq(schema.copyMirrorCheckpoints.watermark, windowStart),
          ),
        )
        .returning({ consumer: schema.copyMirrorCheckpoints.consumer });
      if (advanced.length !== 1) {
        throw Object.assign(new Error("copy-mirror checkpoint contention"), { code: "40001" });
      }
    });
  }

  private async loadDueDeliveries(now: Date) {
    const rows = await this.db.query.copyMirrorDeliveries.findMany({
      where: and(
        eq(schema.copyMirrorDeliveries.status, "pending"),
        lte(schema.copyMirrorDeliveries.nextAttemptAt, now),
      ),
      orderBy: [asc(schema.copyMirrorDeliveries.nextAttemptAt)],
      limit: DELIVERY_BATCH_SIZE,
    });
    // `next_attempt_at` ties (retry backoffs, a saturated stage spread) come
    // back from Postgres in no defined order. Re-impose the source-event
    // sequence in memory so an entry is never handed over after its own close.
    return orderDueDeliveries(rows);
  }

  /** Reporting runs independently while execution lanes finish protection. */
  private async pollMirrorSummaries(): Promise<void> {
    if (this.summaryPolling || !isAutoMirrorEnabled()) return;
    this.summaryPolling = true;
    try {
      const now = await this.readSourceClockNow();
      for (const source of await this.loadReadyMirrorSummarySourceItemIds(now)) {
        await this.notifyCompletedSourceMirrors(source, now);
      }
    } catch (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] summary polling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.summaryPolling = false;
    }
  }

  /** A confirmed fill counts even while its protection workflow is pending. */
  private summaryExecutionConfirmed() {
    return sql`exists (
      select 1 from ${schema.orders} o
      where o.user_id = ${schema.copyMirrorDeliveries.followerUserId}
        and o.client_order_id = 'copymirror:' || ${schema.copyMirrorDeliveries.followerUserId}
          || ':' || ${schema.copyMirrorDeliveries.sourceItemId}
        and o.status = 'FILLED'
        and o.executed_at is not null
        and coalesce(o.executed_size_decimal, o.quantity) > 0
    )`;
  }

  /** Claim and emit once all deliveries have an execution result. */
  private async notifyCompletedSourceMirrors(sourceItemId: string, now: Date): Promise<void> {
    const readyBefore = new Date(now.getTime() - MIRROR_SUMMARY_SETTLE_MS);
    const claimed = await this.db.execute(sql`
      with source_state as (
        select
          count(*) filter (where ${this.summaryExecutionConfirmed()})::int as mirrored_count,
          max(nullif(candidate->>'copySourceLabel', '')) as source_label,
          max(nullif(candidate->>'sourceUserId', '')) as source_user_id,
          bool_and(status in ('completed', 'permanent_failure') or ${this.summaryExecutionConfirmed()}) as settled,
          bool_and(coalesce(candidate->>'mirrorSummaryVersion' = '1', false)) as summary_eligible,
          max(created_at) <= ${readyBefore} as collection_window_elapsed
        from ${schema.copyMirrorDeliveries}
        where ${schema.copyMirrorDeliveries.sourceItemId} = ${sourceItemId}
      )
      update ${schema.copyMirrorDeliveries} d
      set summary_notified_at = ${now}, updated_at = ${now}
      from source_state s
      where d.source_item_id = ${sourceItemId}
        and d.summary_notified_at is null
        and s.settled is true
        and s.summary_eligible is true
        and s.collection_window_elapsed is true
        and s.mirrored_count > 0
      returning s.mirrored_count, s.source_label, s.source_user_id
    `) as unknown as {
      rows?: Array<{
        mirrored_count: number;
        source_label: string | null;
        source_user_id: string | null;
      }>;
    };
    const first = claimed.rows?.[0];
    if (!first) return;
    try {
      await this.sendMirrorSummary({
        sourceLabel: first.source_label ?? "a followed trader",
        sourceUserId: first.source_user_id,
        mirroredCount: Number(first.mirrored_count),
      });
    } catch (error) {
      // Release the claim so the next poll retries instead of losing the notice.
      await this.db.update(schema.copyMirrorDeliveries).set({
        summaryNotifiedAt: null,
        updatedAt: now,
      }).where(and(
        eq(schema.copyMirrorDeliveries.sourceItemId, sourceItemId),
        eq(schema.copyMirrorDeliveries.summaryNotifiedAt, now),
      ));
      logger.warn(LOG_SERVICE, "[copy-mirror] aggregate Discord summary failed", {
        sourceItemId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Find durable summaries whose one-minute follower collection window elapsed. */
  private async loadReadyMirrorSummarySourceItemIds(now: Date): Promise<string[]> {
    const readyBefore = new Date(now.getTime() - MIRROR_SUMMARY_SETTLE_MS);
    const result = await this.db.execute(sql`
      select ${schema.copyMirrorDeliveries.sourceItemId} as source_item_id
      from ${schema.copyMirrorDeliveries}
      group by ${schema.copyMirrorDeliveries.sourceItemId}
      having bool_and(status in ('completed', 'permanent_failure') or ${this.summaryExecutionConfirmed()})
        and bool_and(coalesce(candidate->>'mirrorSummaryVersion' = '1', false))
        and count(*) filter (where ${this.summaryExecutionConfirmed()}) > 0
        and bool_or(summary_notified_at is null)
        and max(created_at) <= ${readyBefore}
      order by min(created_at)
      limit 100
    `) as unknown as { rows?: Array<{ source_item_id: string }> };
    return (result.rows ?? []).map((row) => row.source_item_id);
  }

  /**
   * Claim a due delivery row before executing it, so a second worker replica
   * that loaded the same due batch cannot place a second real order for it.
   *
   * A compare-and-set on `status = 'pending' AND next_attempt_at =
   * observedNextAttemptAt`: only a row that still looks exactly as it did
   * when `loadDueDeliveries` read it can be claimed, and the WHERE clause and
   * the SET happen in one round trip, so two processes racing this update
   * can never both win. The loser's `returning` comes back empty, which is
   * how it learns it lost without needing a lock.
   *
   * Moves `next_attempt_at` into the future by the lease rather than changing
   * `status`, so no new delivery status is needed and a crashed claimant's row
   * simply becomes due again once the lease elapses, self-healing exactly
   * like an ordinary retry backoff. `markDeliveryCompleted` and
   * `markDeliveryFailed` overwrite this on the way out regardless of outcome.
   */
  private async claimDelivery(
    id: string,
    observedNextAttemptAt: Date,
    now: Date,
  ): Promise<boolean> {
    const claimed = await this.db
      .update(schema.copyMirrorDeliveries)
      .set({
        nextAttemptAt: new Date(now.getTime() + DELIVERY_CLAIM_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.copyMirrorDeliveries.id, id),
          eq(schema.copyMirrorDeliveries.status, "pending"),
          eq(schema.copyMirrorDeliveries.nextAttemptAt, observedNextAttemptAt),
        ),
      )
      .returning({ id: schema.copyMirrorDeliveries.id });
    return claimed.length === 1;
  }

  private async readDelivery(id: string) {
    const findFirst = this.db.query?.copyMirrorDeliveries?.findFirst;
    return typeof findFirst === "function"
      ? await findFirst.call(this.db.query.copyMirrorDeliveries, {
          where: eq(schema.copyMirrorDeliveries.id, id),
        })
      : undefined;
  }

  private async readAuthoritativeOrder(
    id: string,
    userId: string,
    clientOrderId: string,
    db: WorkerPoolDb = this.db,
  ) {
    const findFirst = db.query?.orders?.findFirst;
    return typeof findFirst === "function"
      ? await findFirst.call(db.query.orders, {
          where: and(
            eq(schema.orders.id, id),
            eq(schema.orders.userId, userId),
            eq(schema.orders.clientOrderId, clientOrderId),
          ),
        })
      : undefined;
  }

  private async markDeliveryCompleted(
    id: string,
    outcome: MirrorProcessOutcome,
    now: Date,
  ): Promise<void> {
    const updatedRows = await this.db
      .update(schema.copyMirrorDeliveries)
      .set({
        status: "completed",
        outcome,
        completedAt: now,
        // Keep a durable, user-safe explanation for mirror refusals that create
        // no venue order. The app polls these completed deliveries to tell the
        // affected follower what happened. Raw broker errors remain in logs;
        // they may contain implementation details that should not reach UI.
        lastError:
          outcome === "leverage-unconfirmed"
            ? "We couldn't confirm the requested Hyperliquid leverage, so no order was placed."
            : null,
        updatedAt: now,
      })
      .where(and(
        eq(schema.copyMirrorDeliveries.id, id),
        eq(schema.copyMirrorDeliveries.status, "pending"),
      ))
      .returning({ id: schema.copyMirrorDeliveries.id });
    if (updatedRows.length === 1) return;

    // A zero-row result can mean another worker already completed the same
    // delivery. Adopt that authoritative terminal state, but never claim this
    // invocation completed it. Multiple rows are always ambiguous.
    const authoritative = await this.readDelivery(id);
    if (
      updatedRows.length === 0 &&
      (authoritative?.status === "completed" || authoritative?.status === "permanent_failure")
    ) {
      return;
    }
    throw new Error(
      updatedRows.length === 0
        ? "mirror delivery completion CAS matched no row (returned 0 rows; exactly one is required)"
        : `mirror delivery completion CAS returned ${updatedRows.length} rows; exactly one is required`,
    );
  }

  private async markDeliveryFailed(
    row: typeof schema.copyMirrorDeliveries.$inferSelect,
    failure: MirrorFailure,
    now: Date,
    options: { retryWithoutCeiling?: boolean } = {},
  ): Promise<void> {
    const attempts = row.attempts + 1;
    // Give up terminally rather than retrying forever. An intent that has failed
    // this many times is either wedged on something that will never resolve or
    // is by now far too old to be a copy of the source trade, and an armed
    // delivery is an order waiting to happen. The last error is preserved so an
    // operator can reconcile whatever the broker actually has.
    // A CLOSE is EXEMPT from the ceiling, for the same reason it is already
    // exempt from the consent gate and the staleness bound: it is the single
    // instruction that exits a position the mirror opened, nothing regenerates
    // it, and the source event that produced it is long past. The ceiling's
    // argument ("too old to be a copy of the source trade, and an armed
    // delivery is an order waiting to happen") is an argument about ENTRIES. An
    // armed exit is not an order waiting to happen, it is an order waiting to
    // STOP happening, and abandoning it strands the follower in a position with
    // their one exit already spent.
    //
    // Read VENUE-NEUTRALLY. This used to be `candidate?.perpReduceOnly === true`,
    // a flag only the Hyperliquid candidate builder ever sets, so an Alpaca
    // exit was retired as a permanent failure after eight transient broker
    // errors while the identical perp exit retried forever. `isClosingCandidate`
    // is the same reading `processCandidate` and `decideEquityMirrorConsent`
    // already take (an equity SELL is the equity equivalent of a reduce-only
    // perp order), and it deliberately does NOT call a perp SHORT ENTRY a close
    // just because that is also staged as `side: "sell"`.
    //
    // The backoff is capped at 15 minutes, so a wedged close costs one retry per
    // quarter hour and nothing else. Permanent failures still terminate here
    // whatever the intent is; only transient ones are retried past the ceiling.
    const closingDelivery = isClosingCandidate(row.candidate);
    const retryWithoutCeiling = options.retryWithoutCeiling === true;
    const exhausted = hasExhaustedDeliveryAttempts(attempts) &&
      !closingDelivery &&
      !retryWithoutCeiling;
    if (hasExhaustedDeliveryAttempts(attempts) && failure.kind === "transient") {
      logger[closingDelivery || retryWithoutCeiling ? "warn" : "error"](
        LOG_SERVICE,
        retryWithoutCeiling
          ? "[copy-mirror] perp placement recovery still pending past the ordinary attempt ceiling; retrying"
          : closingDelivery
          ? "[copy-mirror] close still failing past the attempt ceiling; retrying anyway rather than stranding the position"
          : "[copy-mirror] delivery abandoned after attempt ceiling",
        {
          followerUserId: row.followerUserId,
          sourceItemId: row.sourceItemId,
          attempts,
          maxAttempts: MIRROR_MAX_DELIVERY_ATTEMPTS,
          closingDelivery,
          assetType: row.candidate?.assetType,
          error: failure.message,
        },
      );
    }

    const updatedRows = await this.db
      .update(schema.copyMirrorDeliveries)
      .set(
        failure.kind === "transient" && !exhausted
          ? {
              status: "pending",
              attempts,
              nextAttemptAt: new Date(now.getTime() + mirrorRetryDelayMs(attempts)),
              lastError: failure.message,
              updatedAt: now,
            }
          : {
              status: "permanent_failure",
              attempts,
              lastError:
                exhausted && failure.kind === "transient"
                  ? `abandoned after ${attempts} attempts: ${failure.message}`
                  : failure.message,
              completedAt: now,
              updatedAt: now,
            },
      )
      .where(and(
        eq(schema.copyMirrorDeliveries.id, row.id),
        eq(schema.copyMirrorDeliveries.status, "pending"),
      ))
      .returning({ id: schema.copyMirrorDeliveries.id });
    if (updatedRows.length === 1) return;

    const authoritative = await this.readDelivery(row.id);
    if (authoritative?.status === "completed" || authoritative?.status === "permanent_failure") {
      logger.warn(LOG_SERVICE, "Mirror delivery failure CAS lost to a terminal row", {
        deliveryId: row.id,
        returnedRows: updatedRows.length,
        authoritativeStatus: authoritative.status,
      });
      return;
    }
    logger.warn(LOG_SERVICE, "Mirror delivery failure CAS was not singular", {
      deliveryId: row.id,
      returnedRows: updatedRows.length,
    });
  }

  /**
   * The reduce-only perp closes still queued, and how long the oldest has waited.
   *
   * Nothing here refuses, expires or reorders anything: it only reads. A close
   * is held by `assessPerpMirrorPreflight` while the perps gate, the reconciler,
   * the network or the mainnet / live opt-ins withhold it, and `markDeliveryFailed`
   * exempts it from the attempt ceiling so it survives until the configuration
   * lets it through. Both rules are correct and unchanged. What was missing is
   * that nobody could see the queue they produce: switching perps off left
   * closes retrying every fifteen minutes indefinitely with no signal at all.
   *
   * PUBLIC because the count and the oldest age are exactly what a status
   * endpoint needs, and it should read them from here rather than re-deriving
   * this query somewhere else and drifting from it.
   *
   * Bounded per audit H6. Ordered oldest-first and read one row past the cap, so
   * a saturated queue makes `count` a floor while `oldestAgeMs` stays exact.
   */
  public async readDeferredCloseBacklog(now: Date = new Date()): Promise<DeferredCloseBacklog> {
    const rows = await this.db.query.copyMirrorDeliveries.findMany({
      where: and(
        eq(schema.copyMirrorDeliveries.status, "pending"),
        // At least one attempt already made, which is what separates a close
        // being HELD from one staged moments ago and still due in this cycle.
        gt(schema.copyMirrorDeliveries.attempts, 0),
      ),
      columns: {
        sourceItemId: true,
        followerUserId: true,
        createdAt: true,
        attempts: true,
        lastError: true,
        candidate: true,
      },
      orderBy: [asc(schema.copyMirrorDeliveries.createdAt), asc(schema.copyMirrorDeliveries.id)],
      limit: DEFERRED_CLOSE_SCAN_CAP + 1,
    });
    // VENUE-NEUTRAL, and read the SAME way `markDeliveryFailed` reads it: a
    // reduce-only perp mirror is a close, and so is an equity/option mirror
    // staged as a sell. This used to be a SQL-level
    // `candidate->>'perpReduceOnly' = 'true'` filter, a second definition of
    // "close" that only the Hyperliquid candidate builder ever satisfies. An
    // Alpaca close retried past the attempt ceiling (correctly exempted by
    // `isClosingCandidate` there) never matched it, so the operator backlog
    // this function feeds stayed empty while the follower's exit sat wedged.
    // Filtering here with the very predicate the ceiling exemption uses keeps
    // the two from drifting apart again.
    return describeDeferredCloseBacklog(
      rows.filter((row) => isClosingCandidate(row.candidate)),
      now,
    );
  }

  /**
   * Emit the deferred-close queue once per cycle.
   *
   * Runs after the drain, so the numbers describe what is STILL stuck rather
   * than what was about to be retried. Silent when the queue is empty: that is
   * the normal case, and repeating it every thirty seconds would bury the
   * cycles where something really is waiting.
   */
  private async reportDeferredCloseBacklog(now: Date): Promise<void> {
    try {
      const backlog = await this.readDeferredCloseBacklog(now);
      if (backlog.count === 0) return;
      logger[backlog.overdue ? "warn" : "info"](
        LOG_SERVICE,
        backlog.overdue
          ? "[copy-mirror] perp closes have been queued past the backlog threshold: whatever defers them is still in place, and each one is a follower holding a mirrored position with its exit unspent"
          : "[copy-mirror] perp closes are queued, waiting for the configuration to let them through",
        {
          deferredCloseCount: backlog.count,
          oldestAgeMs: backlog.oldestAgeMs,
          warnAfterMs: DEFERRED_CLOSE_WARN_AFTER_MS,
          oldestSourceItemId: backlog.oldestSourceItemId,
          oldestFollowerUserId: backlog.oldestFollowerUserId,
          oldestLastError: backlog.oldestLastError,
          scanTruncated: backlog.truncated,
          scanCap: DEFERRED_CLOSE_SCAN_CAP,
        },
      );
    } catch (err) {
      // Observability must never decide the cycle's outcome, so a failed read is
      // reported and swallowed instead of aborting the cycle it was describing.
      logger.warn(LOG_SERVICE, "[copy-mirror] deferred perp close backlog unreadable", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve auto-mirror follow rows into concrete source trades to mirror.
   *
   * The discovery queries and the readers they run on live in
   * `copy-mirror-candidate-sources.ts` (audit H7). This method stays so the
   * poller keeps one place that owns its database handle.
   */
  private async findMirrorCandidates(
    follows: (typeof schema.copyTradeFollows.$inferSelect)[],
    windowStart: Date,
    windowEnd: Date,
    onCandidateBatch?: (batch: MirrorSourceCandidate[]) => Promise<void>,
  ): Promise<MirrorSourceCandidate[]> {
    return findMirrorCandidateSources(this.db, follows, windowStart, windowEnd, onCandidateBatch);
  }

  private async captureAutoMirrorFollowFence(): Promise<CreatedAtIdFence | null> {
    const createdAtKey = millisecondTimestamp(schema.copyTradeFollows.createdAt);
    const rows = await this.db
      .select({
        createdAt: schema.copyTradeFollows.createdAt,
        id: schema.copyTradeFollows.id,
      })
      .from(schema.copyTradeFollows)
      .where(
        or(
          eq(schema.copyTradeFollows.stockAutoMirror, true),
          eq(schema.copyTradeFollows.perpAutoMirror, true),
          eq(schema.copyTradeFollows.autoMirror, true),
        ),
      )
      .orderBy(desc(createdAtKey), desc(schema.copyTradeFollows.id))
      .limit(1);
    return createdAtIdFenceFromRow(rows[0]);
  }

  /** Visit every armed follow with a deterministic fenced keyset scan. */
  private async forEachAutoMirrorFollowPage(
    onPage: (
      page: (typeof schema.copyTradeFollows.$inferSelect)[],
    ) => Promise<void>,
    highWaterFence?: CreatedAtIdFence | null,
  ): Promise<void> {
    // Capture the population boundary before the first page. A follow inserted
    // during this scan belongs to the next cycle; the source replay overlap
    // ensures its eligible recent source events are still considered then.
    const fence = highWaterFence === undefined
      ? await this.captureAutoMirrorFollowFence()
      : highWaterFence;
    let cursor: { createdAt: Date; id: string } | null = null;
    while (true) {
      const conditions = [
        or(
          eq(schema.copyTradeFollows.stockAutoMirror, true),
          eq(schema.copyTradeFollows.perpAutoMirror, true),
          eq(schema.copyTradeFollows.autoMirror, true),
        )!,
      ];
      conditions.push(
        createdAtIdAtOrBefore(
          fence,
          schema.copyTradeFollows.createdAt,
          schema.copyTradeFollows.id,
        ),
      );
      if (cursor) {
        const createdAtKey = millisecondTimestamp(schema.copyTradeFollows.createdAt);
        conditions.push(
          or(
            lt(createdAtKey, cursor.createdAt),
            and(
              eq(createdAtKey, cursor.createdAt),
              lt(schema.copyTradeFollows.id, cursor.id),
            ),
          )!,
        );
      }
      const page = await this.db
        .select()
        .from(schema.copyTradeFollows)
        .where(and(...conditions)!)
        .orderBy(
          desc(millisecondTimestamp(schema.copyTradeFollows.createdAt)),
          desc(schema.copyTradeFollows.id),
        )
        .limit(COPY_MIRROR_FOLLOW_PAGE_SIZE);
      if (page.length === 0) return;
      await onPage(page);
      if (page.length < COPY_MIRROR_FOLLOW_PAGE_SIZE) return;

      const last = page.at(-1);
      if (!last?.createdAt || !last.id) {
        throw new Error("copy-mirror follow page ended without a created_at/id cursor");
      }
      const createdAt = millisecondTimestampValue(last.createdAt);
      if (!createdAt) {
        throw new Error("copy-mirror follow page ended with an invalid created_at cursor");
      }
      const next = { createdAt, id: last.id };
      if (
        cursor &&
        (next.createdAt > cursor.createdAt ||
          (next.createdAt.getTime() === cursor.createdAt.getTime() && next.id >= cursor.id))
      ) {
        throw new Error("copy-mirror follow page did not advance");
      }
      cursor = next;
    }
  }

  /**
   * Fill in account context for a candidate, run the pure decision, and — only on
   * a "place" decision — call the isolated order-placement method.
   *
   * This is where the side effects live (cred decryption, broker reads, the
   * mirrors-today count, the dedupe lookup). The actual order submission is one
   * more hop away in placeMirrorOrder().
   */
  private async processCandidate(
    cand: MirrorSourceCandidate,
    guards: PerpMirrorGuards,
  ): Promise<MirrorProcessOutcome> {
    const clientOrderId = mirrorIdempotencyKey({
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
    });

    // Dedupe FIRST and cheaply: if an order with this deterministic
    // client_order_id already exists, this source trade was already mirrored to
    // this follower — skip without decrypting creds or hitting the broker.
    let existing = await this.db.query.orders.findFirst({
      where: and(
        eq(schema.orders.userId, cand.followerUserId),
        eq(schema.orders.clientOrderId, clientOrderId),
      ),
    });
    let revivedFromCancelledClose = false;

    // Submission is not execution. Keep a delivery pending while its opening
    // IOC has no positive fill, so a later reconciler cancellation can trigger
    // a fresh attempt instead of being finalized as a successful copy.
    if (
      existing?.assetType === "PERP" &&
      existing.reduceOnly !== true &&
      ["SUBMITTED", "PARTIAL"].includes(existing.status) &&
      !(typeof existing.executedSizeDecimal === "string" && Number(existing.executedSizeDecimal) > 0)
    ) {
      return "syncing";
    }

    // A reconciled CANCELLED IOC with an explicit zero execution opened no
    // exposure. Archive that attempt under a non-canonical identity; the still-
    // pending delivery can then prepare another capped, freshly quoted IOC.
    if (
      existing?.assetType === "PERP" &&
      existing.reduceOnly !== true &&
      cand.perpReduceOnly !== true &&
      existing.status === "CANCELLED" &&
      typeof existing.executedSizeDecimal === "string" &&
      Number(existing.executedSizeDecimal) === 0
    ) {
      const archived = await this.db
        .update(schema.orders)
        .set({
          clientOrderId: `${clientOrderId}:zero-fill:${existing.id}`,
          notes: "[copy-mirror] reconciled IOC filled zero; archived for bounded retry",
        })
        .where(and(
          eq(schema.orders.id, existing.id),
          eq(schema.orders.userId, cand.followerUserId),
          eq(schema.orders.clientOrderId, clientOrderId),
          eq(schema.orders.status, "CANCELLED"),
          eq(schema.orders.executedSizeDecimal, existing.executedSizeDecimal),
        ))
        .returning({ id: schema.orders.id });
      if (archived.length === 1) {
        existing = undefined;
      } else {
        return "syncing";
      }
    }

    // A delivery can be acknowledged after Phase B but before Phase C writes
    // protection. On the next poll the deterministic row is already FILLED,
    // so ordinary dedupe would complete the delivery forever with a NULL
    // protection status. Drain that durable intent before returning duplicate.
    if (
      existing &&
      existing.assetType === "PERP" &&
      existing.reduceOnly !== true &&
      ["SUBMITTED", "PARTIAL", "FILLED"].includes(existing.status) &&
      (existing.perpProtectionStatus === null || existing.perpProtectionStatus === "unprotected") &&
      existing.perpProtection &&
      typeof existing.perpProtection === "object" &&
      Reflect.get(existing.perpProtection, "copyMirrorProtectionIntent") === true
    ) {
      const recovery = await this.recoverPerpProtectionIntent(existing, cand);
      if (recovery === "defer") {
        throw Object.assign(new Error("perp protection recovery is not yet safe"), { code: "EAGAIN" });
      }
    }

    // A cancelled close that never reached the venue is REVIVED, not retired.
    //
    // A close whose preparation keeps failing is deliberately left PENDING and
    // retried (see classifyPerpPreparationFailure). The reconciler scans PENDING
    // rows, and once one is older than its minimum age with no fill and no
    // resting order it settles it as CANCELLED, which is the correct reading of
    // the venue. But then this dedupe would call the next attempt a duplicate
    // and complete the delivery, spending a one-shot exit on an order that was
    // never placed at all.
    //
    // Reviving is safe precisely because the venue never saw this cloid: no
    // broker order id was ever recorded, so there is nothing to collide with and
    // nothing to double up. Restricted to reduce-only perps, since an OPEN that
    // failed to submit is genuinely finished and must not be resurrected.
    if (
      existing &&
      existing.status === "CANCELLED" &&
      !existing.brokerOrderId &&
      existing.assetType === "PERP" &&
      existing.reduceOnly === true &&
      cand.perpReduceOnly === true
    ) {
      // The revival itself is a durable state transition. Resolve its
      // timestamp before issuing the CAS so a production-shaped DB clock
      // failure cannot mutate a cancelled close and only fail later in Phase A.
      const revivedAt = await readDatabaseNow(this.db);
      const revivedRows = await this.db
        .update(schema.orders)
        .set({
          status: "PENDING",
          statusUpdatedAt: revivedAt,
          notes: "[copy-mirror] close revived: cancelled without ever reaching the venue",
        })
        .where(
          and(
            eq(schema.orders.id, existing.id),
            eq(schema.orders.status, "CANCELLED"),
            isNull(schema.orders.brokerOrderId),
          ),
        )
        .returning();
      if (revivedRows.length === 1) {
        const revived = revivedRows[0];
        logger.warn(LOG_SERVICE, "[copy-mirror] revived a cancelled perp close for retry", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          clientOrderId,
        });
        existing = revived;
        // The revival is also PROOF, and the resume path needs it.
        //
        // Getting here means the reconciler settled this cloid as cancelled with
        // no broker order id, which is it reporting that the venue never saw the
        // order. That turns an otherwise ambiguous reading into a definite one:
        // a resume that now finds no position knows the position is gone because
        // someone else closed it, not because its own submission is still in
        // flight. See the reduce-only skip branch in resumePendingPerpMirror.
        revivedFromCancelledClose = true;
      } else {
        // LOSING this CAS does not mean the close is finished.
        //
        // With more than one worker replica, both can read the same cancelled
        // row and both attempt this update; only one wins. The loser still holds
        // a row object that says CANCELLED, and falling through with it lands on
        // the duplicate branch below, which COMPLETES the delivery. If the
        // winner's attempt then fails transiently and requeues, the exit has
        // already been marked done by the replica that did nothing.
        //
        // So re-read instead of trusting the stale copy. A row that is PENDING
        // now is the winner's revival and this cycle can resume it; anything
        // else really is settled and the duplicate branch is correct.
        //
        // The proof flag is deliberately NOT set here. Another replica did the
        // revival, so this process never saw the reconciler's verdict itself,
        // and the resume must fall back to holding an empty position read
        // rather than acting on a conclusion it did not reach.
        const reread = await this.db.query.orders.findFirst({
          where: and(
            eq(schema.orders.userId, cand.followerUserId),
            eq(schema.orders.clientOrderId, clientOrderId),
          ),
        });
        logger.warn(LOG_SERVICE, "[copy-mirror] close revival CAS was not singular", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          clientOrderId,
          returnedRows: revivedRows.length,
        });
        if (reread) {
          if (reread.status === "PENDING") {
            logger.warn(LOG_SERVICE, "[copy-mirror] adopted a close revived by another replica", {
              followerUserId: cand.followerUserId,
              sourceItemId: cand.sourceItemId,
              clientOrderId,
            });
          }
          existing = reread;
        }
      }
    }

    // Alpaca's ambiguous-create path deliberately leaves an EQUITY/OPTION row
    // SYNCING with no broker id.  That row is unresolved, not a completed
    // duplicate: placeMirrorOrder reconciles the deterministic broker client id
    // before it ever posts again.  Treating it as terminal here spends the
    // delivery while the broker outcome is still unknown.  Perp recovery has a
    // separate state machine and must keep its existing dedupe semantics.
    const unresolvedAlpacaPlacement =
      (existing?.assetType === "EQUITY" || existing?.assetType === "OPTION") &&
      existing?.status === "SYNCING" &&
      !existing.brokerOrderId;
    if (
      existing &&
      !unresolvedAlpacaPlacement &&
      (existing.status !== "PENDING" || existing.brokerOrderId)
    ) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip: duplicate (already mirrored)", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        clientOrderId,
      });
      return "duplicate";
    }

    if (cand.assetType === "PERP") {
      return this.processPerpCandidate(cand, existing, guards, revivedFromCancelledClose);
    }

    const normalizedAction = normalizeTradeAction(cand.tradeAction);
    const hasExplicitAction = cand.tradeAction !== null && cand.tradeAction !== undefined;
    const ordinaryAction = cand.side === "buy" ? "Buy" : "Sell";
    const mirrorAction = normalizedAction
      ? normalizedAction === "Buy" || normalizedAction === "Sell"
        ? cand.direction === "short" && cand.assetType === "EQUITY"
          ? normalizedAction === "Buy" ? "BuyToCover" : "SellShort"
          : normalizedAction
        : normalizedAction
      : cand.direction === "short" && cand.assetType === "EQUITY"
        ? cand.side === "buy" ? "BuyToCover" : "SellShort"
        : ordinaryAction;
    const mirrorSide = tradeActionSide(mirrorAction);
    const hasKnownDirection = cand.direction === "long" || cand.direction === "short";
    const actionUnsupported =
      !isSupportedAlpacaMirrorAction(cand.assetType, mirrorAction) ||
      mirrorSide === null ||
      mirrorSide !== cand.side ||
      (hasKnownDirection && tradeActionDirection(mirrorAction) !== cand.direction);
    // A legacy option delivery may have been staged before tradeAction became
    // part of the durable candidate. Let destination compatibility run first
    // for that row, but never allow it to reach broker placement: it is rejected
    // below after the selected provider is known. Explicit unsupported actions
    // still fail before credential lookup, preserving the no-side-effect guard.
    const deferLegacyOptionAction =
      cand.assetType === "OPTION" && !hasExplicitAction && actionUnsupported;
    const logUnsupportedAction = (): MirrorProcessOutcome => {
      logger.info(LOG_SERVICE, "[copy-mirror] skip: unsupported-trade-action", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        assetType: cand.assetType,
        tradeAction: cand.tradeAction ?? null,
        direction: cand.direction ?? null,
        side: cand.side,
      });
      return "unsupported-trade-action";
    };
    if (actionUnsupported && !deferLegacyOptionAction) {
      return logUnsupportedAction();
    }


    // ---- A CLOSE follows the POSITION, not the follow. ----
    //
    // A follow row is mutable: it can be re-pointed at another Alpaca account or
    // at a different venue at any time, and the candidate carries whatever it
    // said when the delivery was staged. The order that opened the position is
    // not mutable, and it records the account that received it. Routing an exit
    // by the follow therefore sends it wherever the follower happens to be
    // pointing now, where it either sells an unrelated holding or finds nothing
    // and is consumed as `no-long-position`, in both cases leaving the mirrored
    // position open with its one exit spent.
    //
    // Read once here and reused for the sizing ceiling further down, so a close
    // costs one extra query rather than two. `processPerpCandidate` resolves its
    // destination the same way and for the same reason.
    const isClosingIntent = isClosingDelivery({
      sourceItemId: cand.sourceItemId,
      followerUserId: cand.followerUserId,
      symbol: cand.symbol,
      assetType: cand.assetType,
      side: cand.side,
      tradeAction: cand.tradeAction,
      direction: cand.direction,
    });
    const exposure = isClosingIntent ? await this.mirroredEquityExposure(cand) : null;
    if (exposure?.unanswerable) {
      // Thrown rather than returned: a returned outcome completes the delivery,
      // and a close is the only instruction that ever exits this position.
      // EAGAIN classifies as transient, so the delivery is requeued.
      logger.warn(LOG_SERVICE, "[copy-mirror] equity close held back: exposure unreadable", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        assetType: cand.assetType,
        reason: exposure.unanswerable,
        accounts: exposure.accounts.length,
      });
      throw Object.assign(
        new Error(
          exposure.unanswerable === "spans-accounts"
            ? "equity close held back: mirrored exposure spans more than one account"
            : exposure.unanswerable === "scan-saturated"
              ? "equity close held back: mirrored exposure history scan saturated"
              : `equity close held back: ${exposure.unanswerable}`,
        ),
        { code: "EAGAIN" },
      );
    }
    // Falls back to the follow's account when no open on file names one, which
    // is the pre-existing behaviour: legacy rows can carry no credential, and a
    // close with no attributable exposure at all is refused on quantity below
    // rather than misrouted here.
    let destinationCredentialId = exposure?.credentialId ?? cand.credentialId;

    let selectedCredential = destinationCredentialId
      ? await this.db.query.userApiCredentials.findFirst({
          where: and(
            eq(schema.userApiCredentials.id, destinationCredentialId),
            eq(schema.userApiCredentials.userId, cand.followerUserId),
          ),
          columns: { id: true, provider: true, accountType: true },
        })
      : undefined;

    // ---- A CLOSE OUTLIVES THE CREDENTIAL IT WAS STAGED WITH. ----
    //
    // `copy_trade_follows.credential_id` and `orders.broker_credential_id` both
    // carry `onDelete: "set null"`. Disconnecting an Alpaca connection therefore
    // nulls BOTH while leaving `auto_mirror` on, and reconnecting (or rotating
    // keys) mints a NEW uuid, so the id frozen into an already staged delivery
    // can never resolve again. Returning `missing-credential` here completes the
    // delivery, and a close is one-shot: nothing regenerates a source close
    // (`stageWindow` advanced the checkpoint long ago), so the follower kept the
    // position the mirror opened with its only exit spent, and reconnecting
    // could not retry it. Same failure the perp path documents at
    // `refuseOrDefer`, and the same treatment: fall back, then defer.
    //
    // Matched on the BROKER ACCOUNT that received the open, not on any Alpaca
    // row the follower owns. Paper and live connections coexist per user (the
    // unique index on `user_api_credentials` is partial, hyperliquid-only, for
    // exactly that reason), and sending a live exit to the paper account finds
    // no long and consumes the close just as surely as the refusal did.
    // `broker_account_id` is plain text with no foreign key, so it survives the
    // disconnect that nulled the credential and is what makes the rotated
    // connection identifiable at all.
    //
    // The gate is on WHETHER THE RESOLVED CREDENTIAL CAN ACTUALLY RECEIVE THIS
    // ORDER, not on whether one resolved at all. `selectedCredential` resolves
    // fine when the follow (or the open's own `credentialId` fallback) now
    // names a Hyperliquid connection: nothing about repointing a follow at a
    // different venue requires the old Alpaca connection to still exist, and
    // `orders.broker_credential_id` being nulled by a deleted connection is
    // exactly what routes a close there in the first place (`destinationCredentialId`
    // falls back to `cand.credentialId` above). A resolvable non-Alpaca
    // credential used to skip this whole block and fall straight through to
    // the terminal `incompatible-destination` return below, which is just as
    // final as `missing-credential` for the position it leaves stranded:
    // reconnecting Alpaca afterwards could not retry it either, since
    // `stageWindow` already advanced the checkpoint. Checking the PROVIDER
    // here, not just presence, means a close with real mirrored exposure
    // always gets the same chance the "no credential at all" case already had
    // to find the live Alpaca account before giving up.
    const closeNeedsReconnectedCredential =
      isClosingIntent &&
      (exposure?.qty ?? 0) > 0 &&
      (!selectedCredential ||
        selectedCredential.provider !== "alpaca" ||
        // THE OPEN'S OWN CREDENTIAL IS GONE, so `destinationCredentialId` above
        // fell back to whatever the FOLLOW points at today, and that is not
        // necessarily the account holding the position.
        //
        // A follower may hold Alpaca paper AND live at once: the unique index on
        // `user_api_credentials` is partial to hyperliquid precisely so alpaca
        // paper and live rows keep their many-rows-per-user shape. Re-point a
        // follow to paper, disconnect live, and `orders.broker_credential_id`
        // (onDelete: "set null") nulls out under a position that is still live at
        // the broker. The fallback then resolves to a perfectly valid alpaca row
        // for the WRONG account: the SELL goes to paper, paper is flat, the close
        // returns "no-long-position", and the delivery is completed with a real
        // live position stranded and its only exit spent. If the follower happens
        // to hold that symbol on paper by hand it is worse, because then nothing
        // refuses it and it sells their own shares on the wrong account.
        //
        // Only when an account is actually recorded: with no account to match
        // against, the reroute could never succeed and would hold the exit
        // forever, so a legacy row with no account keeps the old fallback as the
        // only information available.
        (exposure?.credentialId == null && (exposure?.accounts[0] ?? "") !== ""));
    if (closeNeedsReconnectedCredential) {
      const openAccount = exposure?.accounts[0] ?? "";
      // Read the follower's own connections, then identify each one with a
      // LIVE GET /v2/account call rather than the `accountId` column on
      // `user_api_credentials`. That column is optional input the shipped UI
      // never sends (`broker-credentials-form.ts`) and `saveApiCredentials`
      // never backfills from Alpaca's own verification call
      // (`alpaca-credential-check.ts` already hits `GET /v2/account` and
      // discards the response), so it is null on every Alpaca row this
      // product has ever written. Matching against it can therefore never
      // succeed no matter which connection was actually reconnected, which is
      // exactly why this reroute could never fire. `account_number`
      // (docs.alpaca.markets/reference/getaccount-1) is the value that
      // survives a key rotation on the SAME account, so it is fetched fresh
      // for each candidate instead of trusted from storage.
      const alpacaCredentials = openAccount
        ? await this.db.query.userApiCredentials.findMany({
            where: and(
              eq(schema.userApiCredentials.userId, cand.followerUserId),
              eq(schema.userApiCredentials.provider, "alpaca"),
            ),
            columns: { id: true, provider: true, accountType: true },
          })
        : [];
      let reconnected: { id: string; provider: string; accountType: string | null } | undefined;
      for (const row of alpacaCredentials) {
        const [credError, rowCredentials] = await catchError(
          getDecryptedCredentials(this.db as never, cand.followerUserId, {
            provider: "alpaca",
            credentialId: row.id,
          }),
        );
        if (credError || !rowCredentials.username || !rowCredentials.accessToken) continue;
        const [accountError, rowAccount] = await catchError(
          new AlpacaClient({
            keyId: rowCredentials.username,
            secretKey: rowCredentials.accessToken,
            paper: isPaperAccount(rowCredentials.accountType),
          }).getAccount(),
        );
        if (accountError) continue;
        if ((rowAccount.account_number?.trim().toLowerCase() ?? "") === openAccount) {
          reconnected = row;
          break;
        }
      }
      if (reconnected) {
        destinationCredentialId = reconnected.id;
        selectedCredential = {
          id: reconnected.id,
          provider: reconnected.provider,
          accountType: reconnected.accountType,
        };
        logger.warn(LOG_SERVICE, "[copy-mirror] equity close routed to the reconnected credential", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          symbol: cand.symbol,
          assetType: cand.assetType,
          stagedCredentialId: cand.credentialId ?? null,
        });
      } else {
        // Nothing to route to yet, and nothing was placed. Thrown rather than
        // returned so the delivery is REQUEUED instead of completed: this is
        // liftable, because reconnecting the same Alpaca account restores a row
        // whose `account_id` matches and a later attempt then places the exit.
        // EAGAIN classifies as transient, exactly as the other equity close
        // hold-backs in this file do, and a close is exempt from the delivery
        // attempt ceiling so the hold is not silently abandoned.
        logger.warn(LOG_SERVICE, "[copy-mirror] equity close held back: no usable Alpaca account", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          symbol: cand.symbol,
          assetType: cand.assetType,
          openAccounts: exposure?.accounts.length ?? 0,
          candidates: alpacaCredentials.length,
        });
        throw Object.assign(
          new Error("equity close held back, Alpaca account not usable: credential rotated or disconnected"),
          { code: "EAGAIN" },
        );
      }
    }

    // The two are always set or unset together (the lookup above needs an id,
    // and the fallback assigns both), so this is one guard rather than two. It
    // is written as one so the id is narrowed to non-null for the decryption
    // call below.
    if (!selectedCredential || !destinationCredentialId) {
      // An OPEN, or a close with nothing attributable behind it. Both are
      // terminal on purpose: withholding NEW exposure is the correct answer when
      // the follower's chosen destination is gone, and a close with no mirrored
      // exposure strands nothing, so deferring either would requeue a delivery
      // that can never place an order.
      logger.warn(LOG_SERVICE, "[copy-mirror] skip: follow has no selected credential", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
      });
      return "missing-credential";
    }
    // A close with real mirrored exposure and a non-Alpaca destination never
    // reaches this line: `closeNeedsReconnectedCredential` above already
    // caught it and either rerouted to the reconnected Alpaca account or
    // threw EAGAIN. What is left here is an OPEN (withholding new exposure at
    // an incompatible destination is correct) or a close with no attributable
    // exposure at all (nothing is stranded, so terminal is correct there too).
    if (
      selectedCredential.provider !== "alpaca" ||
      ("accountType" in selectedCredential &&
        selectedCredential.accountType !== undefined &&
        selectedCredential.accountType !== "PAPER" &&
        selectedCredential.accountType !== "LIVE")
    ) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip: incompatible destination account", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        assetType: cand.assetType,
        destinationProvider: selectedCredential.provider,
      });
      return "incompatible-destination";
    }
    if (actionUnsupported) return logUnsupportedAction();

    // ---- CONSENT + STALENESS: re-read the follow row, never trust the payload. ----
    //
    // Everything above this line came out of a candidate snapshot taken when the
    // delivery was staged, and a delivery is durable: it survives restarts and
    // is retried on a backoff capped at 15 minutes for up to
    // MIRROR_MAX_DELIVERY_ATTEMPTS attempts. Between staging and here the
    // follower may have turned auto-mirror off, re-pointed the follow at a
    // different destination account, or unfollowed outright, and none of that
    // used to stop an already-queued stock or option order: this branch never
    // re-read `copy_trade_follows` at all, and had no age bound either, so a
    // wedged delivery could still fire about an hour after the unfollow. The
    // perp path has had both checks; this is the same rule applied here.
    //
    // Deliberately placed AFTER the destination checks (they refuse without ever
    // touching an account) and BEFORE credential decryption, so a refusal
    // decrypts nothing, builds no broker client and reads no quote. Every path
    // that can reach Alpaca, including the recovery of a stored PENDING order
    // below, is downstream of this gate.
    //
    // A closing SELL is EXEMPT from both checks and the follow row is not even
    // read for one, exactly as a reduce-only perp close is. Consent withdrawal
    // must stop NEW exposure; it must never be the reason a follower cannot get
    // out of a position the mirror opened for them. The sell path independently
    // reads the follower's real long and either skips on `no-long-position` or
    // clamps to it, so an exempted sell still cannot open a short. See
    // `decideEquityMirrorConsent` for the full argument.
    const liveEquityFollow = isClosingIntent ? null : await this.loadFollowRow(cand);
    const consent = decideEquityMirrorConsent({
      closing: isClosingIntent,
      followerUserId: cand.followerUserId,
      followId: cand.followId,
      credentialId: cand.credentialId,
      follow: liveEquityFollow,
      sourceEventAt: cand.sourceEventAt,
      now: new Date(),
      maxAgeMs: resolveEquityIntentMaxAgeMs(),
    });
    if (consent.action === "skip") {
      logger.warn(LOG_SERVICE, `[copy-mirror] skip: ${consent.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        assetType: cand.assetType,
        side: cand.side,
        followId: cand.followId ?? null,
      });
      return consent.reason;
    }

    // The candidate's cap is only a snapshot. A follow edit can lower either
    // ceiling after staging, so execution uses the tighter staged/current
    // value and refuses malformed persisted values rather than treating them
    // as an uncapped policy.
    const effectiveMaxTradeSize = resolveEffectiveMirrorCap(
      cand.maxTradeSize,
      liveEquityFollow?.maxTradeSize,
    );
    const effectiveMaxCoinSize = resolveEffectiveMirrorCap(
      cand.maxCoinSize,
      liveEquityFollow?.maxCoinSize,
    );
    if (!effectiveMaxTradeSize.ok || !effectiveMaxCoinSize.ok) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip: current follow cap is invalid", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        assetType: cand.assetType,
        followId: cand.followId ?? null,
      });
      return "consent-unverifiable";
    }
    const maxTradeSize = effectiveMaxTradeSize.value;
    const maxCoinSize = effectiveMaxCoinSize.value;

    // ---- AN OPEN COPIES A FILL, NOT A SUBMISSION. ----
    //
    // `social_trades` is written the instant Alpaca ACCEPTS the source order, and
    // nothing in this repo ever retracts the row. So a resting limit the source
    // parked well away from the market as a bid they never expect to be hit is
    // the same row here as a trade they made, and a mirror goes out as a MARKET
    // order: the follower would buy at the current price, from a trade the source
    // never made, at a price the source deliberately refused to pay. The same
    // holds for a source order that is later cancelled, rejected or expired.
    // The perp half of this feed has been fill-gated all along (only an executed
    // delta is published at all); this is the equity/option half of that rule.
    //
    // Re-read HERE rather than frozen at discovery, and DEFERRED rather than
    // refused while the order is still working. OrderSyncPoller runs on the same
    // 30s cadence as this poller, so an order that has already filled at the
    // venue can still read SUBMITTED when the delivery is staged; refusing on
    // that reading would drop most legitimate mirrors, and discovery is one-shot
    // because `stageWindow` advances the checkpoint either way. EAGAIN classifies
    // as transient, so the delivery is requeued and asks again, and an entry
    // whose source never trades is retired by the intent-age bound the consent
    // gate above already applies (15 minutes by default) or by the delivery
    // attempt ceiling, whichever comes first.
    //
    // Scoped to an OPEN. A closing SELL is exempt, exactly as it is exempt from
    // the consent gate, the staleness bound and the attempt ceiling: an exit must
    // never be harder to place than an entry, nothing regenerates a source close,
    // and the sell path is independently bounded by the follower's real long and
    // by mirrored-exposure attribution, so an exempted sell can only ever shrink
    // a holding the mirror itself opened.
    //
    // Skipped once a stored mirror row exists. That row is a durable intent a
    // previous attempt already sized and approved, and it may have reached Alpaca
    // with the response lost; the resume path below owns it from there, and
    // nothing here may retire an order the broker might hold.
    // Ratio sizing must use the fill that exists when this durable delivery is
    // actually executed, not the order quantity captured when Alpaca accepted
    // the source order. Discovery intentionally stages accepted-but-working
    // equity orders so a fill that lands after the scan window is not lost.
    // Keep the candidate snapshot as a compatibility fallback for legacy rows,
    // but replace it with a bounded executed quantity whenever the source read
    // has one.
    let sourceQty = cand.sourceQty;
    if (!isClosingIntent && !existing && cand.sourceOrderId) {
      const sourceOrder = await this.db.query.orders.findFirst({
        where: eq(schema.orders.id, cand.sourceOrderId),
        columns: { status: true, executedQuantity: true },
      });
      const execution = classifySourceOrderExecution(sourceOrder);
      if (execution === "unfilled") {
        logger.info(LOG_SERVICE, "[copy-mirror] skip: source-unfilled", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          symbol: cand.symbol,
          assetType: cand.assetType,
          sourceOrderStatus: sourceOrder?.status ?? null,
        });
        return "source-unfilled";
      }
      if (execution === "working") {
        logger.info(LOG_SERVICE, "[copy-mirror] equity open held back: source order has not traded yet", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          symbol: cand.symbol,
          assetType: cand.assetType,
          sourceOrderStatus: sourceOrder?.status ?? null,
        });
        throw Object.assign(
          new Error("mirror open held back: the source order has not traded yet"),
          { code: "EAGAIN" },
        );
      }
      const executedSourceQty = resolveMirrorSourceQuantity({
        executedQuantity: sourceOrder?.executedQuantity,
      });
      if (executedSourceQty !== undefined) sourceQty = executedSourceQty;
    }

    // Decrypt only the exact user-owned Alpaca credential this delivery resolved
    // to: the follow's for an opening order, and the account that received the
    // mirrored open for a close.
    const credentials = await getDecryptedCredentials(this.db as never, cand.followerUserId, {
      provider: "alpaca",
      credentialId: destinationCredentialId,
    });
    if (!credentials.username || !credentials.accessToken) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip: follower has no usable Alpaca creds", {
        followerUserId: cand.followerUserId,
      });
      return "unusable-credential";
    }

    const isPaper = isPaperAccount(credentials.accountType);

    const client = new AlpacaClient({
      keyId: credentials.username,
      secretKey: credentials.accessToken,
      paper: isPaper,
    });

    // A credential UUID is not an account identity. The API deliberately keeps
    // the UUID stable during same-row key rotation, so a replacement can make
    // that UUID authenticate a different Alpaca account. A close must verify
    // the live account before it reads position state or submits, otherwise a
    // same-symbol holding on the replacement account can be sold as if it were
    // the mirrored exposure.
    let verifiedCloseAccount: Awaited<ReturnType<AlpacaClient["getAccount"]>> | null = null;
    if (isClosingIntent && (exposure?.qty ?? 0) > 0 && exposure?.accounts[0]) {
      const [accountError, account] = await catchError(client.getAccount());
      const actualAccount = account?.account_number?.trim().toLowerCase() ?? "";
      const expectedAccount = exposure.accounts[0].trim().toLowerCase();
      if (accountError || !actualAccount || actualAccount !== expectedAccount) {
        logger.warn(LOG_SERVICE, "[copy-mirror] equity close held back: credential account mismatch", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          symbol: cand.symbol,
          expectedAccount,
          accountReadable: !accountError,
        });
        throw Object.assign(
          new Error("equity close held back: credential does not authenticate the exposure account"),
          { code: "EAGAIN" },
        );
      }
      verifiedCloseAccount = account;
    }

    const tradingSymbol = this.resolveTradingSymbol(cand);
    if (!tradingSymbol) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip: missing-option-contract", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        assetType: cand.assetType,
      });
      return "missing-option-contract";
    }

    // A prior transient attempt already passed sizing and all guardrails before
    // it wrote this PENDING order. Recover that exact durable intent before any
    // fresh account/quote reads can change its quantity or consume it as a skip.
    //
    // TWO things are still re-read here, and both are re-read because they are
    // about the world NOW rather than about sizing: what the follower actually
    // holds (a stored SELL may no longer have a long behind it) and how many
    // mirrors today has already seen (a row stranded overnight is invisible to
    // every count taken after midnight). Neither re-derives the order from the
    // follow's rule. See each block below for why it cannot be skipped.
    if (existing?.status === "PENDING" && !existing.brokerOrderId) {
      if (!isPaper && !guards.liveAllowed) {
        throw Object.assign(new Error("live mirror recovery paused by live opt-in gate"), {
          code: "EAGAIN",
        });
      }

      const resumeAudit = {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        assetType: cand.assetType,
        tradingSymbol,
        clientOrderId,
        storedQty: existing.quantity,
      };
      // The quantity actually re-sent. Still the stored one by default: a resume
      // is a durable intent finishing, not a fresh decision.
      let resumeQty = existing.quantity;
      let resumeOrderDollars: number | undefined;

      if (cand.side === "sell") {
        // ---- SELL safety travels WITH the resume, it is not part of sizing. ----
        //
        // Skipping the fresh reads above is the point of this branch, but the
        // clamp that stops a mirrored SELL from becoming a naked SHORT was on
        // the fresh path only, so it was skipped as collateral damage. A resume
        // can sit behind an arbitrary number of transient failures, and in that
        // window the follower may have exited the position by hand or had a stop
        // fill. Re-sending the stored quantity then sells shares that are no
        // longer there: equities carry no reduce-only flag and this order sets no
        // position_intent, so on a margin account Alpaca opens the difference as
        // a SHORT, which is unbounded risk in the opposite direction to every
        // other guardrail in this file.
        //
        // `resumePendingPerpMirror` re-reads and re-clamps a reduce-only resume
        // for exactly this reason ("reduceOnly prevents a flip; it does not
        // preserve ownership"). Here the venue offers no such backstop at all,
        // so this read is the only thing between a lost socket and a short.
        //
        // The STORED quantity is what gets clamped, not a re-derived one: it is
        // already the sized and approved result of the first attempt, the same
        // way the perp resume re-clamps its stored size rather than re-running
        // the follow's rule. `fetchLongQty` reports 0 for a 404 (the account is
        // flat) and rethrows anything else, so an unreadable position requeues
        // the delivery instead of placing against a position nobody read.
        //
        // The ATTRIBUTION ceiling is deliberately not re-derived here, unlike
        // the live-long clamp. The stored quantity was already bounded by the
        // mirrored exposure when the fresh path sized it, and this row is
        // itself a PENDING mirrored SELL, so a re-read would net it out of the
        // exposure it is trying to spend and refuse an exit that was already
        // approved. The destination account is still resolved from the exposure
        // above, so a resume cannot be sent to the wrong account either.
        const heldLongQty = await this.fetchLongQty(client, tradingSymbol);
        const sellDecision = decideSellMirrorQty(existing.quantity, heldLongQty);
        if (sellDecision.action === "skip") {
          // A resume reaches this line under exactly the conditions the pairing
          // guard exists for: an outage that requeued this sell can equally have
          // requeued the buy it exits, and then the empty position read is the
          // missing open rather than a position that is genuinely gone.
          await this.holdEquityCloseIfPairedOpenQueued(
            cand,
            "no-long-position",
            { ...resumeAudit, heldLongQty },
            exposure?.hasUnsettledOpen === true,
          );
          // Status untouched: the first attempt may have reached Alpaca with its
          // response lost, and only the reconciler can settle that. Nothing here
          // marks the row failed or rejected.
          logger.info(LOG_SERVICE, "[copy-mirror] skip: no-long-position (pending resume)", {
            ...resumeAudit,
            heldLongQty,
          });
          return "no-long-position";
        }
        if (sellDecision.qty <= 0) {
          await this.holdEquityCloseIfPairedOpenQueued(
            cand,
            "no-qty",
            { ...resumeAudit, heldLongQty },
            exposure?.hasUnsettledOpen === true,
          );
          logger.info(LOG_SERVICE, "[copy-mirror] skip: no-qty (clamped resume sell)", {
            ...resumeAudit,
            heldLongQty,
          });
          return "no-qty";
        }
        if (sellDecision.qty < existing.quantity) {
          // PERSIST the clamp, do not merely pass it down. On a resume the
          // insert in placeMirrorOrder conflicts on client_order_id, and that
          // path deliberately submits the ROW's quantity rather than the
          // caller's argument (the stored intent is the durable one). So a clamp
          // that is not written to the row is a clamp Alpaca never sees, and the
          // original quantity goes out short shares and all.
          //
          // Scoped to a row that is still PENDING with no broker order id, so
          // this cannot rewrite one the reconciler has since learned is live at
          // the venue. The `returning` is load-bearing: an UPDATE that matches
          // zero rows RESOLVES rather than throwing, and treating that as
          // success would resend the stored quantity, which is the exact naked
          // short this clamp exists to prevent. Thrown rather than returned so
          // the delivery is requeued instead of completed: a close is one-shot,
          // and nothing was placed.
          const clamped = await this.db
            .update(schema.orders)
            .set({ quantity: sellDecision.qty })
            .where(
              and(
                eq(schema.orders.id, existing.id),
                eq(schema.orders.userId, cand.followerUserId),
                eq(schema.orders.status, "PENDING"),
                isNull(schema.orders.brokerOrderId),
              ),
            )
            .returning({ id: schema.orders.id });
          if (clamped.length === 0) {
            logger.warn(LOG_SERVICE, "[copy-mirror] resume sell clamp matched no PENDING row", {
              ...resumeAudit,
              heldLongQty,
              clampedQty: sellDecision.qty,
            });
            throw Object.assign(
              new Error("resume sell clamp was not recorded; stored quantity not resent"),
              { code: "EAGAIN" },
            );
          }
          logger.warn(LOG_SERVICE, "[copy-mirror] resume sell clamped to the live long", {
            ...resumeAudit,
            heldLongQty,
            qty: sellDecision.qty,
          });
          resumeQty = sellDecision.qty;
        }
      } else {
        // ---- A resumed BUY counts against TODAY's cap, not the day it was staged. ----
        //
        // countMirrorsToday counts by placement time, so a row stranded PENDING
        // before midnight is invisible to every count taken after it. Without
        // this the row places on top of a full day of fresh mirrors, putting the
        // follower one order over a cap that exists to bound how much the mirror
        // can do to their account in a day. The fresh path counts; this branch
        // returned before ever reaching that count.
        //
        // The row being resumed is EXCLUDED from its own count. The count
        // ignores status, so a row stranded earlier TODAY is already inside it,
        // and counting it here would let it block itself: the order holding the
        // last slot would read the cap as full and be refused, leaving that slot
        // occupied by an order that never went out. A resume is the same mirror
        // finishing, not another one.
        //
        // A SELL is exempt and is handled above instead: an exit is not new
        // exposure, and a cap must never be the reason a follower cannot get out
        // of a position the mirror opened for them. `resumePendingPerpMirror`
        // draws the same line at reduce-only.
        const resumeMirrorsToday = await this.countMirrorsToday(
          cand.followerUserId,
          existing.id,
        );
        if (resumeMirrorsToday === null) {
          // Unknown is not zero. Same treatment as the fresh path: retry rather
          // than place against a count we could not take.
          throw Object.assign(new Error("daily mirror cap count unavailable"), { code: "08006" });
        }
        if (!withinDailyCap({ mirrorsToday: resumeMirrorsToday, dailyCap: guards.dailyCap })) {
          // PENDING is kept, as everywhere on this branch: the first attempt may
          // have reached Alpaca and only the reconciler can settle that.
          logger.info(LOG_SERVICE, "[copy-mirror] skip: daily-cap (pending resume)", {
            ...resumeAudit,
            mirrorsToday: resumeMirrorsToday,
            dailyCap: guards.dailyCap,
          });
          return "daily-cap";
        }

        // ---- A resumed BUY re-checks the per-order dollar cap off a LIVE price. ----
        //
        // The stored quantity was priced and approved against a quote read on the
        // first attempt, but that attempt can be followed by an arbitrary wait (an
        // LULD halt/reopen gap is the realistic case): a resume that just re-sends
        // `existing.quantity` at whatever the venue is asked to fill re-sends a
        // notional the cap never actually cleared. Equity mirrors go out as MARKET
        // orders, so nothing downstream bounds it either -- Alpaca enforces buying
        // power, not this platform's per-order ceiling.
        //
        // `decidePerpResumeParity` draws the identical line on the perp resume
        // ("the stored size is re-priced off a live mid so the per-order dollar cap
        // ... judge the order the venue would actually get"), and both caps come
        // from the same resolveGuardrails(). This is the equity half of that rule.
        // A SELL never reaches this branch (see the `if` above): an exit is not
        // new exposure and must never be harder to place than the entry that
        // opened it, exactly as the dollar cap is exempt on the fresh path.
        //
        // A price of 0 is UNUSABLE, not free. `fetchPrice` returns 0 rather than
        // throwing when the quote itself cannot be read, and trusting that as "no
        // notional" would let an order the cap never actually cleared go out
        // unchecked. EAGAIN requeues instead, the same fail-closed answer the
        // count read above gives when it cannot trust its own result.
        const resumePrice = await this.fetchPrice(client, cand, tradingSymbol);
        if (!(resumePrice > 0)) {
          throw Object.assign(
            new Error("resume dollar-cap check: no usable price to re-price the order from"),
            { code: "EAGAIN" },
          );
        }
        resumeOrderDollars =
          resumeQty * resumePrice * contractMultiplier(cand.assetType);
        if (
          !withinDollarCap({
            orderDollars: resumeOrderDollars,
            maxOrderDollars: guards.maxOrderDollars,
          })
        ) {
          // PENDING is kept, as everywhere on this branch: the first attempt may
          // have reached Alpaca and only the reconciler can settle that.
          logger.info(LOG_SERVICE, "[copy-mirror] skip: dollar-cap (pending resume)", {
            ...resumeAudit,
            price: resumePrice,
            orderDollars: resumeOrderDollars,
            maxOrderDollars: guards.maxOrderDollars,
          });
          return "dollar-cap";
        }
        if (maxTradeSize !== null && resumeOrderDollars > maxTradeSize) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: current follow dollar cap (pending resume)", {
            ...resumeAudit,
            price: resumePrice,
            orderDollars: resumeOrderDollars,
            maxTradeSize,
          });
          return "dollar-cap";
        }
      }

      return this.placeEquityMirrorOpenWithCap(client, {
        followerUserId: cand.followerUserId,
        symbol: cand.symbol,
        tradingSymbol,
        side: cand.side,
        qty: resumeQty,
        clientOrderId,
        brokerAccountId: existing.brokerAccountId ?? credentials.accountId,
        brokerCredentialId: existing.brokerCredentialId ?? credentials.credentialId,
        isPaper,
        assetType: cand.assetType,
        optionExpiration: existing.optionExpiration ?? cand.optionExpiration,
        optionStrike:
          existing.optionStrike !== null
            ? Number(existing.optionStrike)
            : cand.optionStrike,
        optionType: (existing.optionType as MirrorOptionType | null) ?? cand.optionType,
        tradeAction: normalizeTradeAction(existing.tradeAction) ?? mirrorAction,
        direction:
          (existing.direction as TradeDirection | null) ??
          cand.direction ??
          tradeActionDirection(mirrorAction) ??
          "long",
        limitPrice:
          existing.limitPrice !== null ? Number(existing.limitPrice) : undefined,
        copySourceLabel: existing.copySourceLabel ?? cand.copySourceLabel,
        maxCoinSize,
        maxTradeSize,
        stagedMaxCoinSize: cand.maxCoinSize,
        stagedMaxTradeSize: cand.maxTradeSize,
        followId: cand.followId,
        orderDollars: resumeOrderDollars,
        reservedOrderId: existing.id,
      });
    }

    // Account buying power + equity (sizing math) + current price (qty + cap)
    // + fractional eligibility (equity-only — options stay whole-contract).
    const [fetchedAccount, price, allowFractional] = await Promise.all([
      verifiedCloseAccount ?? client.getAccount(),
      this.fetchPrice(client, cand, tradingSymbol),
      this.isSymbolFractionable(client, cand, tradingSymbol),
    ]);
    const account = fetchedAccount;
    const buyingPower = parseFloat(account.buying_power);
    const equity = parseFloat(account.equity);

    // Count today's mirrors for this follower (deterministic client_order_id
    // prefix => count by prefix + created today).
    const mirrorsToday = await this.countMirrorsToday(cand.followerUserId);
    if (mirrorsToday === null) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip: daily-cap-unavailable", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
      });
      throw Object.assign(new Error("daily mirror cap count unavailable"), { code: "08006" });
    }

    const decision = decideMirror(
      {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        symbol: cand.symbol,
        side: cand.side,
        sizingMode: cand.sizingMode,
        sizingValue: cand.sizingValue,
        maxTradeSize,
        buyingPower: Number.isFinite(buyingPower) ? buyingPower : 0,
        equity: Number.isFinite(equity) ? equity : 0,
        sourceQty,
        isPaper,
        price,
        contractMultiplier: contractMultiplier(cand.assetType),
        allowFractional,
        mirrorsToday,
        alreadyMirrored: false, // already checked above
        dailyCap: guards.dailyCap,
        maxOrderDollars: guards.maxOrderDollars,
      },
      guards.liveAllowed,
    );

    /** What the follow's ENTRY rule asked for. Only an OPEN is sized by it. */
    const entryRuleQty = decision.action === "place" ? decision.qty : 0;

    // ---- An EXIT is sized to the POSITION, never to the entry rule. ----
    //
    // `pct`, `pct_equity` and `usd` all answer one question: how much would this
    // follow BUY right now, at today's price, out of today's balance. That
    // question has no meaning on the way out. A `usd:900` follow that opened 100
    // shares at $9 sized its exit at floor(900 / 45) = 20 once the stock reached
    // $45; the two clamps below could only reduce that further, so 20 shares
    // were sold and the delivery completed. Nothing regenerates a source close,
    // so the follower kept 80 shares of a position the source is completely out
    // of with its one exit instruction already spent, and the leftover is
    // permanent. The bigger the winner, the smaller the exit.
    //
    // The perp path has never had this: `decidePerpReduceOnlyMirror` sizes every
    // non-ratio close from `mirroredExposureSizeDecimal` rather than from the
    // entry rule, so one `sizing_mode` column meant "exit $N worth" on Alpaca and
    // "exit the position" on Hyperliquid. The mirrored exposure read at the top
    // of this method is the equity counterpart of that field, so the exit asks
    // for all of it and the two clamps below still bound what actually goes out:
    // `decideSellMirrorQty` to the follower's live long (never a short) and
    // `clampSellToMirroredExposure` to what the mirror opened (never the
    // follower's own shares). Neither is widened by this; both now bound a
    // request that starts at the right number instead of an unrelated one.
    //
    // RATIO mode is excluded, exactly as it is on the perp path. `ratio x
    // sourceQty` is already an answer about the SOURCE's action rather than
    // about the follower's account, so it is the one rule that reads the same on
    // the way in and on the way out.
    //
    // A non-ratio close now applies the source fill proportionally to the
    // attributed follower exposure. The source-side position and close fill are
    // reconstructed from authoritative order history before this method gets
    // here; an incomplete reconstruction is an EAGAIN hold, never a guessed
    // full exit. Ratio mode remains source-quantity based by design.
    const sizeExitFromMirroredPosition = isClosingIntent && cand.sizingMode !== "ratio";
    const mirroredExposureQty = isClosingIntent ? exposure?.qty ?? 0 : 0;
    const proportionalCloseQty = sizeExitFromMirroredPosition &&
      exposure?.sourceCloseQty !== null &&
      exposure?.sourceCloseQty !== undefined &&
      exposure?.sourcePositionQty !== null &&
      exposure?.sourcePositionQty !== undefined
      ? proportionalEquityCloseQty(
          mirroredExposureQty,
          exposure.sourceCloseQty,
          exposure.sourcePositionQty,
          cand.assetType === "OPTION" ? "OPTION" : "EQUITY",
        )
      : null;
    // A non-ratio close has already been held above when the source context was
    // unavailable. Keep the fallback zero-only for an unattributed/flat close;
    // it can never reach the broker and therefore cannot widen an exit.
    const mirroredLongQty = sizeExitFromMirroredPosition
      ? proportionalCloseQty ?? 0
      : mirroredExposureQty;

    // AUDIT: log every decision with full context.
    const auditBase = {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      symbol: cand.symbol,
      side: cand.side,
      isPaper,
      assetType: cand.assetType,
      tradingSymbol,
      price,
      buyingPower,
      mirrorsToday,
      clientOrderId: decision.clientOrderId,
      maxOrderDollars: guards.maxOrderDollars,
    };

    // A close sized from the exposure needs nothing from `decideMirror` but its
    // non-sizing verdicts, so a `no-qty` that only means "the entry rule buys no
    // whole share at today's price" must not withhold it either: leaving that
    // gate in place would keep the exit sized by the entry rule in the one case
    // where the rule refuses outright. It is reachable in the ordinary course of
    // business, most easily on options, where a $900 rule buys no whole contract
    // once the premium passes $9 at the 100x multiplier, and the ending is worse
    // than a short sale: the hold below is thrown, so the exit is retried until
    // the delivery exhausts its attempts and is abandoned.
    //
    // A PRICE of zero is still a hold. `fetchPrice` returns 0 for an unusable
    // quote, and an OPTION close is submitted as a limit order at that price, so
    // placing on it would send a limit of $0. An exposure of zero is still a hold
    // for the same reason it always was: there is nothing attributable to exit.
    const entryRuleSizedTheExitToZero =
      decision.action === "skip" &&
      decision.reason === "no-qty" &&
      sizeExitFromMirroredPosition &&
      mirroredLongQty > 0 &&
      price > 0;

    if (decision.action === "skip" && !entryRuleSizedTheExitToZero) {
      logger.info(LOG_SERVICE, `[copy-mirror] skip: ${decision.reason}`, {
        ...auditBase,
        ...(decision.reason === "dollar-cap"
          ? { orderDollars: decision.orderDollars }
          : {}),
      });
      // ---- A close refused over an unreadable PRICE is held, not spent. ----
      //
      // `no-qty` is the only skip a close can still reach here now that the two
      // caps are exempt, and it is reached in two ways that look identical to
      // this branch. One of them is a market-data answer rather than an answer
      // about the exit: `fetchPrice` returns 0 when the quote is unusable (an
      // option contract with no resting bid is the common case, since
      // `fetchOptionPrice` reads the bid for a sell), and sizing against 0 can
      // only yield 0 shares.
      //
      // Returning that completes the delivery, and a close is one-shot: nothing
      // regenerates a source close, so a single unreadable quote left the
      // follower holding a position the mirror opened with its only exit
      // instruction already consumed. Thrown instead, with EAGAIN so
      // `classifyMirrorFailure` calls it transient and `markDeliveryFailed`
      // requeues it, which is exactly how the exposure-unreadable case above is
      // handled and why it is thrown there too.
      //
      // Scoped to closes on purpose. An OPEN nobody could price is genuinely
      // finished: no position depends on it and the source event ages out of
      // the staleness bound, so retrying it would only put a stale entry back
      // in the queue.
      //
      // The OTHER way this branch is reached is not a price problem at all:
      // the mirrored exposure this close would reduce is already zero
      // (`mirroredLongQty <= 0`), so a ratio close, or a proportional close
      // whose entry rule never bought a whole share, lands on the identical
      // `no-qty` skip. Throwing EAGAIN unconditionally used to diagnose that
      // as an unusable price even when the price was fine, and since a CLOSE
      // is exempt from the attempt ceiling the delivery then retried every 15
      // minutes forever re-deriving the same zero. There is genuinely nothing
      // to exit here, so this is the terminal `no-mirrored-exposure` reading
      // the attribution branch above already reaches for the identical
      // question, through the same paired-open hold: a sibling open still
      // queued, or one whose delivery completed but whose broker order has
      // not settled yet (`exposure?.hasUnsettledOpen`), can still turn this
      // zero into real exposure, so those cases defer instead of completing.
      if (isClosingIntent && decision.reason === "no-qty") {
        if (mirroredLongQty <= 0) {
          await this.holdEquityCloseIfPairedOpenQueued(
            cand,
            "no-mirrored-exposure",
            { ...auditBase, mirroredLongQty },
            exposure?.hasUnsettledOpen === true,
          );
          logger.info(LOG_SERVICE, "[copy-mirror] skip: no-mirrored-exposure (unsized close)", {
            ...auditBase,
            mirroredLongQty,
          });
          return "no-mirrored-exposure";
        }
        throw Object.assign(
          new Error("equity close held back: no usable price to size the exit from"),
          { code: "EAGAIN" },
        );
      }
      return decision.reason;
    }

    if (entryRuleSizedTheExitToZero) {
      // Logged on purpose, and at warn: the entry rule refused this exit
      // outright, so the quantity below bears no relationship at all to the
      // follow's `sizingValue` and an operator reading only the PLACING line
      // would have no way to tell where it came from.
      logger.warn(
        LOG_SERVICE,
        "[copy-mirror] close sized from the mirrored position; the entry rule sized it to zero",
        { ...auditBase, mirroredLongQty },
      );
    }

    // The qty actually placed. For a BUY it's the sized entry-rule qty; a SELL
    // asks for the mirrored position (see above) and is clamped below to the
    // follower's held long so a mirror never OPENS a short.
    let placeQty = sizeExitFromMirroredPosition ? mirroredLongQty : entryRuleQty;

    // ---- SELL safety: never open a naked short by mirroring. ----
    // A mirror SELL is sized like a buy, but a follower with no LONG position
    // would have that sell placed as a naked SHORT. Read the follower's actual
    // long holding and either skip (no long) or clamp to it (close, not flip).
    if (cand.side === "sell") {
      const heldLongQty = await this.fetchLongQty(client, tradingSymbol);
      const sellDecision = decideSellMirrorQty(placeQty, heldLongQty);
      if (sellDecision.action === "skip") {
        // "The follower holds nothing" and "the open that would have bought it
        // is still queued" look identical from here, and only one of them means
        // this exit is finished. Held rather than spent while a paired open is
        // still in the queue; see `holdEquityCloseIfPairedOpenQueued`.
        await this.holdEquityCloseIfPairedOpenQueued(
          cand,
          "no-long-position",
          { ...auditBase, computedQty: entryRuleQty, heldLongQty },
          exposure?.hasUnsettledOpen === true,
        );
        logger.info(LOG_SERVICE, "[copy-mirror] skip: no-long-position", {
          ...auditBase,
          computedQty: entryRuleQty,
          heldLongQty,
        });
        return "no-long-position";
      }
      // ---- ATTRIBUTION: only the part the MIRROR opened may be sold. ----
      //
      // The clamp above proves the shares exist; it does not prove they are
      // ours to sell. It reads the account's whole long, so a follower who
      // holds the symbol themselves had their own shares liquidated by any
      // close the source published, sized by their own buying-power rule and
      // bounded only by the per-order dollar cap. The mirrored exposure read at
      // the top of this method is the second ceiling, and it is the same rule
      // the perp close path applies through `mirroredExposureSizeDecimal`.
      //
      // It can only ever REDUCE the quantity, never refuse an exit the mirror
      // does owe: `mirroredLongQty` only counts what has actually FILLED (a
      // still-settling open contributes nothing until it does, alpaca-13), and
      // an exposure reading that cannot be trusted held the delivery back long
      // before this line rather than resolving to zero here.
      //
      // `mirroredLongQty` is the same figure the exit was SIZED from above, so
      // on a non-ratio close this clamp is normally a no-op and only bites when
      // the live long came back larger than the exposure. Ratio mode still
      // arrives here with a source-derived quantity that has never been bounded
      // by attribution, which is exactly what this catches.
      const attributed = clampSellToMirroredExposure(sellDecision.qty, mirroredExposureQty);
      if (attributed.action === "skip") {
        // A mirrored open for this symbol is still working, so `mirroredLongQty`
        // read only what has filled SO FAR and may UNDER-read a fill that
        // already happened at the broker and simply has not been reconciled
        // into that row yet. Reading that as "the mirror owes nothing" would
        // complete a close that is still real, so it is held instead, the same
        // way an unreadable exposure or a queued sibling open holds it below:
        // EAGAIN classifies as transient, and a close is exempt from the
        // attempt ceiling on a transient failure, so it retries until the open
        // settles one way or the other and resolves itself. alpaca-13.
        if (exposure?.hasUnsettledOpen) {
          logger.warn(
            LOG_SERVICE,
            "[copy-mirror] equity close held back: a mirrored open is still settling",
            { ...auditBase, computedQty: entryRuleQty, heldLongQty, mirroredLongQty },
          );
          throw Object.assign(
            new Error("equity close held back: a mirrored open for this symbol is still settling"),
            { code: "EAGAIN" },
          );
        }
        // Same reasoning as the clamp above: a paired open that has not managed
        // to write its order row yet attributes nothing to the mirror, which
        // reads here as an exit that is owed nothing at all.
        //
        // openOutcomeAmbiguous is always false by the time control reaches
        // here: the `exposure?.hasUnsettledOpen` branch just above already
        // threw EAGAIN for that case, so this call is only ever reached once
        // that possibility is ruled out.
        await this.holdEquityCloseIfPairedOpenQueued(
          cand,
          "no-mirrored-exposure",
          { ...auditBase, computedQty: entryRuleQty, heldLongQty, mirroredLongQty },
          false,
        );
        logger.info(LOG_SERVICE, "[copy-mirror] skip: no-mirrored-exposure", {
          ...auditBase,
          computedQty: entryRuleQty,
          heldLongQty,
          mirroredLongQty,
        });
        return "no-mirrored-exposure";
      }
      if (attributed.qty <= 0) {
        // Reached only when `attributed.action` was NOT "skip" above, so the
        // same "already ruled out by the throw above" reasoning applies.
        await this.holdEquityCloseIfPairedOpenQueued(
          cand,
          "no-qty",
          { ...auditBase, computedQty: entryRuleQty, heldLongQty, mirroredLongQty },
          false,
        );
        logger.info(LOG_SERVICE, "[copy-mirror] skip: no-qty (clamped sell)", {
          ...auditBase,
          computedQty: entryRuleQty,
          heldLongQty,
          mirroredLongQty,
        });
        return "no-qty";
      }
      if (attributed.qty < sellDecision.qty) {
        logger.warn(LOG_SERVICE, "[copy-mirror] sell clamped to mirrored exposure", {
          ...auditBase,
          computedQty: entryRuleQty,
          heldLongQty,
          mirroredLongQty,
          qty: attributed.qty,
        });
      }
      placeQty = attributed.qty;
    }

    // ---- PLACE: this is the only path that moves money. ----
    logger.warn(LOG_SERVICE, "[copy-mirror] PLACING mirror order", {
      ...auditBase,
      qty: placeQty,
      orderDollars: placeQty * price * contractMultiplier(cand.assetType),
    });

    return this.placeEquityMirrorOpenWithCap(client, {
      followerUserId: cand.followerUserId,
      symbol: cand.symbol,
      tradingSymbol,
      side: cand.side,
      qty: placeQty,
      clientOrderId: decision.clientOrderId,
      // NOT `credentials.accountId`: that column is optional input the
      // shipped UI never collects and credential save never backfills, so it
      // is null on every Alpaca row (see the reroute above). `account` was
      // already fetched live from Alpaca above for the buying-power math, so
      // its `account_number` is used here instead: it is the value that
      // later survives a key rotation on the same account and lets a
      // stranded close find its way back to this exact broker account.
      brokerAccountId: account.account_number,
      brokerCredentialId: credentials.credentialId,
      isPaper,
      assetType: cand.assetType,
      optionExpiration: cand.optionExpiration,
      optionStrike: cand.optionStrike,
      optionType: cand.optionType,
      tradeAction: mirrorAction,
      direction: cand.direction ?? tradeActionDirection(mirrorAction) ?? "long",
      limitPrice: cand.assetType === "OPTION" ? price : undefined,
      copySourceLabel: cand.copySourceLabel,
      maxCoinSize,
      maxTradeSize,
      stagedMaxCoinSize: cand.maxCoinSize,
      stagedMaxTradeSize: cand.maxTradeSize,
      followId: cand.followId,
      orderDollars: placeQty * price * contractMultiplier(cand.assetType),
    });
  }

  /**
   * Decide and execute one Hyperliquid perp mirror.
   *
   * This method is now the WIRING only. The gates that decide whether a perp may
   * be mirrored at all live in `copy-mirror-perp-preflight.ts`, and the three
   * ways one reaches the venue (resume a stored PENDING row, mirror a
   * reduce-only close, open fresh exposure) live in
   * `copy-mirror-perp-execution.ts`. Audit H7: this file was far over the
   * ceiling, and none of the extracted logic changed in the move.
   *
   * What stays here is what needs this poller's own database handle: the
   * destination credential, the consent re-read, and the venue client.
   */
  private async processPerpCandidate(
    cand: MirrorSourceCandidate,
    existing: typeof schema.orders.$inferSelect | undefined,
    guards: PerpMirrorGuards,
    // True only when THIS call revived the row from a reconciler cancellation,
    // which is the only moment we know the first submission never reached the
    // venue. Not persisted, and does not need to be: a cycle that lacks the
    // proof defers, the reconciler cancels the row again, and whichever cycle
    // performs the next revival has it.
    revivedFromCancelledClose = false,
  ): Promise<MirrorProcessOutcome> {
    if (cand.sourceItemId.startsWith("hl_wallet:") && cand.perpReduceOnly !== true) {
      const sourceNow = await readDatabaseNow(this.db);
      if (isExpiredWalletOpenIntent(cand, sourceNow.getTime())) {
        logger.warn(LOG_SERVICE, "[copy-mirror] skip wallet perp open: stale intent", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: cand.symbol,
          maxAgeMs: HL_WALLET_OPEN_MAX_AGE_MS,
        });
        return "stale-intent";
      }
    }

    // Polling normally resolves this alongside the generic equity guardrail.
    // Keep the same raw-config-aware result for direct/recovery callers that
    // only provide the legacy guard shape, while preserving an explicit null
    // as the fail-closed perp decision.
    const executionGuards = guards.perpDailyCap === undefined
      ? { ...guards, perpDailyCap: resolvePerpDailyCap() }
      : guards;
    // Env is read HERE and handed over as plain booleans, so this file stays
    // the single place that interprets a real-money flag.
    const preflight = assessPerpMirrorPreflight({
      cand,
      existing,
      perpsEnabled: guards.perpsEnabled && readPerpsAutoMirrorFlag(),
      networkExplicit: isHyperliquidNetworkExplicit(),
      isMainnet: isHyperliquidMainnet(),
      mainnetAllowed: guards.mainnetAllowed && isPerpsMainnetAllowed(),
      liveAllowed: guards.liveAllowed,
      now: new Date(),
    });
    if (preflight.action === "skip") return preflight.outcome;
    if (preflight.action === "defer") {
      // Thrown rather than returned, because returning completes the delivery
      // and a close is a one-shot instruction. EAGAIN classifies as transient,
      // and reduce-only closes are exempt from the attempt ceiling, so the exit
      // survives until the configuration lets it through.
      logger.warn(LOG_SERVICE, "[copy-mirror] perp close held back by configuration", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol.slice(0, 24),
        reason: preflight.reason,
      });
      throw Object.assign(
        new Error(`perp close held back by configuration: ${preflight.reason}`),
        { code: "EAGAIN" },
      );
    }
    // Resolve the timestamp before creating a venue client or taking any
    // placement/recovery path. A production-shaped DB clock failure must stop
    // the whole perp attempt before even its venue reads; legacy test doubles
    // without execute retain the compatibility process clock in the helper.
    await readDatabaseNow(this.db);
    const { perpSide, isReduceOnlyIntent } = preflight;

    // A CLOSE goes to the account that received the OPEN, not to wherever the
    // follow points now.
    //
    // The candidate carries the follow row's CURRENT credential, and a follow is
    // mutable: repointed to a different Hyperliquid account, switched to Alpaca,
    // or reprovisioned. The open is not. Routing the exit by the follow would
    // send it to an account holding no such position (or, worse, a different
    // one), and `missing-hyperliquid-account` is a skip, so the exit would be
    // consumed while the original leveraged position stayed open.
    //
    // The mirrored open records the credential that actually received it, so for
    // a reduce-only intent that is the authority. It falls back to the follow's
    // credential when no open is on file, which is the pre-existing behaviour.
    let credentialId = cand.credentialId;
    let exposureAccounts: string[] = [];
    if (isReduceOnlyIntent) {
      const exposure = await this.mirroredExposureCredentialId(cand);
      exposureAccounts = exposure.accounts;
      if (exposure.ambiguous) {
        logger.warn(LOG_SERVICE, "[copy-mirror] perp close held back: exposure spans accounts", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: cand.symbol.slice(0, 24),
        });
        throw Object.assign(
          new Error("perp close held back: mirrored exposure spans more than one account"),
          { code: "EAGAIN" },
        );
      }
      // Close events are discovered even after a follower disables the perp
      // destination so exposure opened earlier can still be exited. That
      // exception must not manufacture close work for a follower who never had
      // a mirrored perp order at all (for example, a stock-only follow with a
      // PENDING Hyperliquid credential). With no mirror history there is
      // conclusively nothing attributable for this worker to close, and no
      // credential should be required merely to prove that again at the venue.
      if (exposure.hasMirrorHistory === false) {
        const candidateCredentialId = cand.credentialId?.trim() ?? "";
        const readyCredential = candidateCredentialId
          ? await this.db.query.userApiCredentials.findFirst({
              where: and(
                eq(schema.userApiCredentials.id, candidateCredentialId),
                eq(schema.userApiCredentials.userId, cand.followerUserId),
                eq(schema.userApiCredentials.provider, "hyperliquid"),
                eq(schema.userApiCredentials.accountType, HL_AGENT_REGISTERED),
              ),
              columns: { id: true },
            })
          : undefined;
        if (!readyCredential) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip perp close: inactive account has no mirrored exposure history", {
            followerUserId: cand.followerUserId,
            sourceItemId: cand.sourceItemId,
            coin: cand.symbol.slice(0, 24),
          });
          return "no-position";
        }
      }
      credentialId = exposure.credentialId ?? cand.credentialId;
    }
    /**
     * Account readiness is LIFTABLE, so it must not consume a close.
     *
     * Disconnecting a Hyperliquid connection nulls both the follow's
     * credentialId and the opening order's brokerCredentialId through the
     * foreign keys, so a follower who still holds a mirrored position can leave
     * this path with nothing to route to. Returning the outcome completes the
     * delivery, and a close is one-shot: reconnecting afterwards cannot retry
     * the exit and the leveraged position stays open.
     *
     * Same treatment as every other liftable refusal on this path: an OPEN is
     * skipped, because withholding new exposure is the correct answer, and a
     * CLOSE is requeued until the account is usable again.
     */
    const refuseOrDefer = (reason: string): MirrorProcessOutcome => {
      if (!isReduceOnlyIntent) return "missing-hyperliquid-account";
      logger.warn(LOG_SERVICE, "[copy-mirror] perp close held back: account not usable", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol.slice(0, 24),
        reason,
      });
      throw Object.assign(
        new Error(`perp close held back, Hyperliquid account not usable: ${reason}`),
        { code: "EAGAIN" },
      );
    };

    // NOTE the ordering: a close with NO recorded credential at all still has to
    // reach the reconnection fallback below. If the source closes while the
    // follower is disconnected, both foreign keys are already null and the
    // candidate is staged with a null credential, so returning here would
    // requeue the delivery on a value that never changes: reconnecting could
    // never unblock the exit. The refusal is deferred until after the fallback.
    let credential: PerpOpenAuthorization["credential"];
    let liveFollowPolicy: PerpOpenFollowPolicyRow | null = null;
    let leveragePolicyUnavailable = false;
    if (isReduceOnlyIntent) {
      credential = credentialId
        ? await this.db.query.userApiCredentials.findFirst({
            where: and(
              eq(schema.userApiCredentials.id, credentialId),
              eq(schema.userApiCredentials.userId, cand.followerUserId),
              eq(schema.userApiCredentials.provider, "hyperliquid"),
            ),
            columns: { id: true, provider: true, accountType: true },
          })
        : undefined;
    } else {
      const authorization = await this.loadPerpOpenAuthorization(cand);
      credential = authorization.credential;
      liveFollowPolicy = authorization.follow;
      leveragePolicyUnavailable = authorization.policyUnavailable;
    }

    // A CLOSE falls back to whatever Hyperliquid connection the follower has NOW
    // when the recorded one no longer exists.
    //
    // Deleting a connection nulls the opening order's brokerCredentialId through
    // the foreign key, and reconnecting mints a NEW uuid. So the recorded id is
    // gone, the frozen candidate still names the deleted one, and an exact-id
    // lookup can never succeed again. Before this branch that requeued the close
    // forever: reconnecting could not make the account usable to the delivery,
    // which is a worse failure than the consumption it replaced.
    //
    // Scoped to reduce-only, and still constrained to a registered Hyperliquid
    // agent owned by this follower. An OPEN keeps requiring the exact credential
    // the follow selected, because routing new exposure somewhere the follower
    // did not choose is not a decision this worker gets to make. A close is
    // different: the position is already theirs, and the account holding it is
    // whichever one their wallet is connected through.
    if (!credential && isReduceOnlyIntent) {
      credential = await this.db.query.userApiCredentials.findFirst({
        where: and(
          eq(schema.userApiCredentials.userId, cand.followerUserId),
          eq(schema.userApiCredentials.provider, "hyperliquid"),
          eq(schema.userApiCredentials.accountType, HL_AGENT_REGISTERED),
        ),
        columns: { id: true, provider: true, accountType: true },
      });
      if (credential) {
        logger.warn(LOG_SERVICE, "[copy-mirror] perp close routed to the follower's current connection", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          coin: cand.symbol.slice(0, 24),
        });
      }
    }

    if (!credential && !credentialId) return refuseOrDefer("no-credential-on-file");
    if (
      !credential ||
      credential.provider !== "hyperliquid" ||
      credential.accountType !== HL_AGENT_REGISTERED
    ) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip: Hyperliquid agent is not ready", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
      });
      return refuseOrDefer("agent-not-registered");
    }

    // ---- CONSENT: re-read the follow row, never trust the frozen payload. ----
    // Everything above this line came out of a candidate snapshot taken when the
    // delivery was staged. Between then and now the follower may have turned
    // auto-mirror off, re-pointed the follow at a different account, or
    // unfollowed outright. None of that used to stop an already-staged order.
    //
    // Reduce-only closes are EXEMPT, and the follow row is not even read for
    // them. Withdrawing consent must stop new exposure; it must never abandon
    // exposure the mirror already created. Gating a close on consent leaves a
    // follower who switched auto-mirror off holding the leveraged position the
    // mirror opened, with its one exit instruction skipped and consumed. See
    // `decidePerpMirrorConsent` for the full argument.
    const consent = decidePerpMirrorConsent({
      reduceOnly: isReduceOnlyIntent,
      followerUserId: cand.followerUserId,
      followId: cand.followId,
      credentialId: cand.credentialId,
      follow: isReduceOnlyIntent ? null : liveFollowPolicy,
    });
    if (consent.action === "skip") {
      logger.warn(LOG_SERVICE, `[copy-mirror] skip perp: ${consent.reason}`, {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
        followId: cand.followId ?? null,
      });
      return consent.reason;
    }
    if (!isReduceOnlyIntent && leveragePolicyUnavailable) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: leverage policy unavailable", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
        followId: cand.followId ?? null,
      });
      return "leverage-policy-unavailable";
    }

    const { client, walletAddress } = await this.createPerpClient(
      this.db as never,
      cand.followerUserId,
      { credentialId: credential.id },
    );

    // The wallet we ended up on must be the one holding the exposure.
    //
    // brokerAccountId survives a credential delete, so this catches the case the
    // credential check cannot: wallet A opened the position, A's credential row
    // is gone, the follower reconnected as B, and the fallback routed here. A
    // reduce-only order sent to B would find no matching position (consuming the
    // exit while A stays open) or, worse, find same-side exposure of the
    // follower's own and reduce that instead.
    if (
      isReduceOnlyIntent &&
      exposureAccounts.length > 0 &&
      // exposureAccounts are already lowercased by the resolver.
      !exposureAccounts.includes(walletAddress.toLowerCase())
    ) {
      logger.warn(LOG_SERVICE, "[copy-mirror] perp close held back: exposure is on another wallet", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol.slice(0, 24),
      });
      throw Object.assign(
        new Error("perp close held back: mirrored exposure is on a different wallet"),
        { code: "EAGAIN" },
      );
    }

    // A follower's explicit ROE protection overrides the copied source levels.
    // With no override, carry the source opening order's immutable initial
    // prices into the follower's durable intent.
    const protectionRuleSnapshot = liveFollowPolicy?.protectionRule ??
      parseSourcePerpProtectionRule({
        initialTakeProfitPx: cand.sourceInitialTakeProfitPx,
        initialStopLossPx: cand.sourceInitialStopLossPx,
      });

    const execution = {
      client,
      walletAddress,
      cand,
      brokerCredentialId: credential.id,
      deps: this.perpExecutionDeps(),
      ...(!isReduceOnlyIntent
        ? {
            withLockedPerpOpenPolicy: <T>(
              callback: (resolution: PerpOpenPolicyResolution) => Promise<T>,
              preparedOrder?: {
                orderId: string;
                clientOrderId: string;
                claimToken: string;
                claimAt: Date;
              },
            ) => this.withLockedPerpOpenPolicy(
              cand,
              credential.id,
              callback,
              liveFollowPolicy,
              preparedOrder,
            ),
          }
        : {}),
      ...(!isReduceOnlyIntent && liveFollowPolicy
        ? {
            leveragePolicy: {
              currentUserMaxLeverage: liveFollowPolicy.currentUserMaxLeverage,
              currentFollowMaxLeverage: liveFollowPolicy.currentFollowMaxLeverage,
              currentMaxTradeSize: liveFollowPolicy.currentMaxTradeSize,
              currentMaxCoinSize: liveFollowPolicy.currentMaxCoinSize,
            },
          }
        : {}),
      ...(!isReduceOnlyIntent
        ? { protectionRuleSnapshot }
        : {}),
    };

    if (existing?.status === "PENDING") {
      return resumePendingPerpMirror({
        ...execution,
        existing,
        guards: executionGuards,
        revivedFromCancelledClose,
      });
    }

    if (cand.perpReduceOnly) {
      return executePerpCloseMirror({ ...execution, perpSide });
    }

    return executePerpOpenMirror({ ...execution, perpSide, guards: executionGuards });
  }

  /**
   * Recover protection for an entry that filled during the Phase-B/Phase-C
   * crash window. This uses only the durable opening intent and executed size;
   * it never creates triggers until `attachPerpProtection` confirms a live
   * position, and it verifies the credential still resolves to the opening
   * wallet before any venue write.
   */
  private async recoverPerpProtectionIntent(
    order: typeof schema.orders.$inferSelect,
    cand: MirrorSourceCandidate,
  ): Promise<"recovered" | "defer" | "not-needed"> {
    const intent = order.perpProtection;
    if (!intent || typeof intent !== "object" || Reflect.get(intent, "copyMirrorProtectionIntent") !== true) {
      return "not-needed";
    }
    const executedSize = order.executedSizeDecimal?.trim() ?? "";
    if (!executedSize || !parsePositiveDecimal(executedSize)) return "defer";
    const credentialId = order.brokerCredentialId?.trim() ?? "";
    const storedWallet = order.brokerAccountId?.trim() ?? "";
    if (!credentialId || !/^0x[0-9a-fA-F]{40}$/.test(storedWallet)) return "defer";
    const rule = parsePerpProtectionRule({
      perpTakeProfitPct: (() => {
        const value = Reflect.get(intent, "takeProfitRoePct");
        return typeof value === "number" ? String(value) : value as string | null | undefined;
      })(),
      perpStopLossPct: (() => {
        const value = Reflect.get(intent, "stopLossRoePct");
        return typeof value === "number" ? String(value) : value as string | null | undefined;
      })(),
    }) ?? parseSourcePerpProtectionRule({
      initialTakeProfitPx: Reflect.get(intent, "takeProfitPx") as string | null | undefined,
      initialStopLossPx: Reflect.get(intent, "stopLossPx") as string | null | undefined,
    });
    if (!rule) return "not-needed";

    // Read the authoritative timestamp before credential/client resolution or
    // any durable claim. A production-shaped DB clock failure must leave the
    // recovery row untouched and must not reach a venue-facing client.
    const recoveryNow = await readDatabaseNow(this.db);
    const credential = await this.db.query.userApiCredentials.findFirst({
      where: and(
        eq(schema.userApiCredentials.id, credentialId),
        eq(schema.userApiCredentials.userId, order.userId),
        eq(schema.userApiCredentials.provider, "hyperliquid"),
        eq(schema.userApiCredentials.accountType, HL_AGENT_REGISTERED),
      ),
      columns: { id: true, provider: true, accountType: true },
    });
    if (!credential) return "defer";
    let created: { client: HyperliquidClient; walletAddress: `0x${string}` };
    try {
      created = await this.createPerpClient(this.db as never, order.userId, { credentialId });
    } catch (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection recovery client unavailable", {
        orderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return "defer";
    }
    if (created.walletAddress.toLowerCase() !== storedWallet.toLowerCase()) return "defer";

    // A FILLED row can be revisited by more than one delivery/recovery worker.
    // Claim the protection hand-off with the same durable row before reading
    // the position or sending trigger legs. The claim is deliberately stored
    // in the existing sync marker columns: no migration is needed, and the
    // exact marker is included in the status CAS below. A recent placement
    // claim still belongs to the Phase-B owner; wait for it rather than
    // stealing the row while that owner may be attaching protection normally.
    if (
      isPerpPlacementLeaseActive(
        order.syncReason,
        order.lastSyncAttemptAt,
        recoveryNow.getTime(),
      ) ||
      isPerpProtectionRecoveryClaimActive(
        order.syncReason,
        order.lastSyncAttemptAt,
        recoveryNow.getTime(),
      )
    ) {
      return "defer";
    }
    const protectionClaimedAt = recoveryNow;
    const protectionClaimReason =
      `${PERP_PROTECTION_RECOVERY_REASON_PREFIX}${randomUUID()}`;
    const exactPriorLease = order.lastSyncAttemptAt == null
      ? isNull(schema.orders.lastSyncAttemptAt)
      : eq(schema.orders.lastSyncAttemptAt, order.lastSyncAttemptAt);
    const exactPriorReason = order.syncReason == null
      ? isNull(schema.orders.syncReason)
      : eq(schema.orders.syncReason, order.syncReason);
    const claimRows = await this.db
      .update(schema.orders)
      .set({
        syncReason: protectionClaimReason,
        lastSyncAttemptAt: protectionClaimedAt,
      })
      .where(
        and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.userId, order.userId),
          eq(schema.orders.clientOrderId, order.clientOrderId!),
          inArray(schema.orders.status, ["SUBMITTED", "PARTIAL", "FILLED"]),
          or(
            isNull(schema.orders.perpProtectionStatus),
            eq(schema.orders.perpProtectionStatus, "unprotected"),
          ),
          exactPriorLease,
          exactPriorReason,
        ),
      )
      .returning({ id: schema.orders.id });
    if (claimRows.length !== 1) {
      // Another worker may have completed the attach or may currently own the
      // recovery marker. Let the caller re-read rather than placing anything
      // from this stale row snapshot.
      return "defer";
    }
    const result = await this.attachPerpProtection(created.client, {
      followerUserId: order.userId,
      sourceItemId: cand.sourceItemId,
      ...(cand.followId ? { followId: cand.followId } : {}),
      walletAddress: created.walletAddress,
      coin: order.symbol,
      sizeCoin: executedSize,
      clientOrderId: order.clientOrderId!,
      protectionRuleSnapshot: rule,
      priorProtectionPlan: intent as PerpProtectionPlan,
      protectionClaim: {
        orderId: order.id,
        reason: protectionClaimReason,
        claimedAt: protectionClaimedAt,
      },
    });
    if (!result || result.outcome === "unprotected") return "defer";
    return "recovered";
  }


  /**
   * Attach the follower's own take-profit and stop-loss to a position an open
   * just created. NEVER THROWS: see the dep's doc comment.
   *
   * The database halves live here because the poller owns the connection; the
   * decision, the retry ladder and the venue calls live in
   * copy-mirror-perp-protection.ts where they can be tested with a fake client.
   */
  private async attachPerpProtection(
    client: HyperliquidClient,
    params: PerpProtectionAttachRequest,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpProtectionAttachResult | null> {
    const [error, result] = await catchError(
      attachPerpProtection(client, params, {
        loadRule: () => this.loadPerpProtectionRule(params, db),
        // Checkpoint the deterministic leg ids before the first trigger POST.
        // Lightweight legacy fakes do not expose the query/update surface used
        // by the production row CAS; they are intentionally left on the old
        // adapter path, while PostgreSQL always takes this durable branch.
        ...(typeof (db as any).update === "function" &&
        typeof (db as any).query?.orders?.findFirst === "function"
          ? {
              recordPlan: (plan: PerpProtectionPlan) =>
                this.recordPerpProtectionPlan(params, plan, db),
            }
          : {}),
        recordAttached: async (plan) => {
          await this.recordPerpProtection(params, {
            perpProtection: plan,
            perpProtectionStatus: "attached",
            perpProtectionError: null,
          }, db);
        },
        recordUnprotected: async (reason, plan) => {
          await this.recordPerpProtection(params, {
            // The plan is recorded even though the attach FAILED, whenever legs
            // actually went out. A leg Hyperliquid took before refusing the
            // group is live and reduce-only, and its client order id is the only
            // handle the cancel path has on it. The status still reads
            // `unprotected`, so nothing about the backlog line changes.
            ...(plan ? { perpProtection: plan } : {}),
            perpProtectionStatus: "unprotected",
            perpProtectionError: reason.slice(0, 500),
          }, db);
        },
        recordCleanup: (state, retiredLegClientOrderIds) =>
          this.recordPerpProtectionCleanup(state, db, retiredLegClientOrderIds),
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    );
    if (error) {
      if (isPerpProtectionCleanupPersistenceError(error)) {
        // The protection module surfaces the exact pending cloids when its
        // cleanup callback cannot persist. Retry the generation-specific marker
        // here so a transient callback failure is not silently discarded. If
        // the database is still unavailable, the pre-submit plan checkpoint is
        // left untouched for the independent cancelled-row recovery sweep.
        const retiredLegClientOrderIds = Array.isArray(error.retiredLegClientOrderIds)
          ? error.retiredLegClientOrderIds
          : [];
        const [persistError] = await catchError(
          this.recordPerpProtectionCleanup(error.state, db, retiredLegClientOrderIds),
        );
        if (persistError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] typed perp protection cleanup state could not be retained", {
            followerUserId: params.followerUserId,
            sourceItemId: params.sourceItemId,
            clientOrderId: params.clientOrderId,
            error: persistError.message,
          });
        }
        logger.error(LOG_SERVICE, "[copy-mirror] perp protection cleanup persistence failed; position left open", {
          followerUserId: params.followerUserId,
          sourceItemId: params.sourceItemId,
          coin: params.coin.slice(0, 24),
          clientOrderId: params.clientOrderId,
          pendingLegs: error.state.legClientOrderIds.length,
          error: error.message,
        });
        return null;
      }
      // `attachPerpProtection` is written not to throw, so reaching here means a
      // bug rather than a venue failure. Swallowed all the same: the entry order
      // is LIVE, and letting this escape would requeue a delivery whose order
      // already exists at Hyperliquid.
      logger.error(LOG_SERVICE, "[copy-mirror] perp protection attach threw, position left open", {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin.slice(0, 24),
        error: error.message,
      });
      return null;
    }
    if (result.outcome === "not-configured") return result;
    if (result.outcome === "attached") {
      logger.info(LOG_SERVICE, "[copy-mirror] perp protection attached", {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin.slice(0, 24),
        takeProfitPx: result.plan.takeProfitPx ?? null,
        stopLossPx: result.plan.stopLossPx ?? null,
        entryPx: result.plan.entryPx,
        leverage: result.plan.leverage,
        droppedLegs: result.droppedLegs,
      });
      return result;
    }
    // LOUD, and the position is deliberately still open. Closing it because an
    // API call failed would be a loss the follower never asked for, and an
    // unprotected mirror is what every mirror was before this feature existed.
    // The row carries `perp_protection_status = 'unprotected'`, which is what
    // the per-cycle backlog line below counts.
    logger.error(
      LOG_SERVICE,
      "[copy-mirror] perp protection NOT attached: the follower is holding a leveraged mirrored position with no stop and no take profit, and nothing here will close it",
      {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin.slice(0, 24),
        clientOrderId: params.clientOrderId,
        attempts: result.attempts,
        reason: result.reason,
      },
    );
    return result;
  }

  /**
   * The follow's configured exit, or null when there is nothing to attach.
   *
   * Shared by the attach and by the "syncing" note below, because both have to
   * answer the same question first: did this follow ask for an exit at all? OFF
   * BY DEFAULT depends on that answer being read before anything is written.
   *
   * No follow id means the rule cannot be read, which is not the same as an
   * empty rule but has the same answer: attach nothing, record nothing. The perp
   * OPEN path refuses such a candidate before it ever places, so this is
   * defensive rather than a case that occurs.
   */
  private async loadPerpProtectionRule(
    params: PerpProtectionAttachRequest,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpProtectionRule | null> {
    // Phase A stores the immutable rule with the opening intent. Prefer that
    // snapshot over a later follow edit: protection is part of the order's
    // durable identity, and a policy/transport failure must not silently attach
    // today's settings to yesterday's placement. Legacy rows fall through to
    // the live follow read below.
    const findOrder = (db as any).query?.orders?.findFirst;
    if (typeof findOrder === "function") {
      const order = await findOrder.call((db as any).query.orders, {
        where: and(
          eq(schema.orders.userId, params.followerUserId),
          eq(schema.orders.clientOrderId, params.clientOrderId),
        ),
        columns: { perpProtection: true },
      }) as { perpProtection?: unknown } | undefined;
      const stored = order?.perpProtection;
      if (
        stored &&
        typeof stored === "object" &&
        Reflect.get(stored, "copyMirrorProtectionIntent") === true
      ) {
        return parsePerpProtectionRule({
          perpTakeProfitPct: Reflect.get(stored, "takeProfitRoePct") as string | null | undefined,
          perpStopLossPct: Reflect.get(stored, "stopLossRoePct") as string | null | undefined,
        }) ?? parseSourcePerpProtectionRule({
          initialTakeProfitPx: Reflect.get(stored, "takeProfitPx") as string | null | undefined,
          initialStopLossPx: Reflect.get(stored, "stopLossPx") as string | null | undefined,
        });
      }
      // The request snapshot exists on all new phased placements. An explicit
      // null means protection was not part of the intent, and must not be
      // replaced by a follow rule added after placement. Legacy callers omit
      // the property and continue using the follow row below.
      if (Object.prototype.hasOwnProperty.call(params, "protectionRuleSnapshot")) {
        return params.protectionRuleSnapshot ?? null;
      }
    } else if (Object.prototype.hasOwnProperty.call(params, "protectionRuleSnapshot")) {
      return params.protectionRuleSnapshot ?? null;
    }
    const followId = params.followId?.trim() ?? "";
    if (followId === "") return null;
    const row = await db.query.copyTradeFollows.findFirst({
      where: and(
        eq(schema.copyTradeFollows.id, followId),
        eq(schema.copyTradeFollows.followerUserId, params.followerUserId),
      ),
      columns: { perpTakeProfitPct: true, perpStopLossPct: true },
    });
    return parsePerpProtectionRule(row ?? null);
  }

  /**
   * Say out loud that a placement which may be live at the venue carries no
   * attached exit. NEVER THROWS: the order may already exist at Hyperliquid.
   *
   * The attach is correctly skipped on a "syncing" outcome, but until this
   * existed the skip left no trace at all: `perp_protection_status` stayed NULL,
   * and `emitUnprotectedPerpBacklog` counts 'unprotected'. A follower's stop went
   * missing and nothing in the system said so.
   *
   * Only for a follow that configured one. See `recordPerpProtectionUnattached`.
   */
  private async notePerpProtectionUnattached(
    params: PerpProtectionAttachRequest,
    reason: string,
    db: WorkerPoolDb = this.db,
  ): Promise<void> {
    const [error, result] = await catchError(
      recordPerpProtectionUnattached(
        {
          loadRule: () => this.loadPerpProtectionRule(params, db),
          recordUnprotected: async (recorded) => {
            const protectionIntent = perpProtectionIntentSnapshot(params.protectionRuleSnapshot);
            await this.recordPerpProtection(params, {
              ...(protectionIntent ? { perpProtection: protectionIntent } : {}),
              perpProtectionStatus: "unprotected",
              perpProtectionError: recorded.slice(0, 500),
            }, db);
          },
        },
        reason,
      ),
    );
    if (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp protection syncing note threw; the order stands", {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin.slice(0, 24),
        error: error.message,
      });
      return;
    }
    if (result.outcome === "not-configured") return;
    if (result.outcome === "unrecorded") {
      logger.error(
        LOG_SERVICE,
        "[copy-mirror] perp protection is missing on an unresolved placement AND could not be recorded, so nothing will surface it",
        {
          followerUserId: params.followerUserId,
          sourceItemId: params.sourceItemId,
          coin: params.coin.slice(0, 24),
          clientOrderId: params.clientOrderId,
          reason: result.reason,
        },
      );
      return;
    }
    logger.error(
      LOG_SERVICE,
      "[copy-mirror] perp protection NOT attached: the placement outcome is unresolved, so no trigger was submitted and the follower may be holding a leveraged mirrored position with no stop",
      {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin.slice(0, 24),
        clientOrderId: params.clientOrderId,
        reason,
      },
    );
  }

  /**
   * Persist the deterministic protection plan before touching Hyperliquid.
   * This is a monotonic compare-and-set: a resumed attach may enrich the
   * marker, but it can never replace an already attached/cancelled protection
   * record or lose leg ids learned by an earlier attempt.
   */
  private async recordPerpProtectionPlan(
    params: PerpProtectionAttachRequest,
    plan: PerpProtectionPlan,
    db: WorkerPoolDb = this.db,
  ): Promise<void> {
    const persist = async (
      writeDb: WorkerPoolDb,
      locked?: { perpProtection?: unknown },
    ): Promise<void> => {
      const values = locked
        ? mergePerpProtectionPlanValues(locked.perpProtection, plan)
        : await this.mergePerpProtectionPlan(params, plan, writeDb);
      const claimPredicate = params.protectionClaim
        ? and(
            eq(schema.orders.syncReason, params.protectionClaim.reason),
            eq(schema.orders.lastSyncAttemptAt, params.protectionClaim.claimedAt),
          )
        : undefined;
      const update = writeDb
        .update(schema.orders)
        .set({ perpProtection: values })
        .where(
          and(
            ...(params.protectionClaim?.orderId
              ? [eq(schema.orders.id, params.protectionClaim.orderId)]
              : []),
            eq(schema.orders.userId, params.followerUserId),
            eq(schema.orders.clientOrderId, params.clientOrderId),
            or(isNull(schema.orders.perpProtectionStatus), eq(schema.orders.perpProtectionStatus, "unprotected")),
            claimPredicate,
          ),
        );
      await this.assertPerpProtectionCas(update, writeDb, params, "plan checkpoint");
    };
    await this.withLockedPerpProtectionRow(params, db, persist);
  }

  /** Merge a newly derived plan with the durable intent/leg-id union. */
  private async mergePerpProtectionPlan(
    params: PerpProtectionAttachRequest,
    plan: PerpProtectionPlan,
    db: WorkerPoolDb,
  ): Promise<PerpProtectionPlan> {
    const current = await db.query.orders.findFirst({
      where: and(
        eq(schema.orders.userId, params.followerUserId),
        eq(schema.orders.clientOrderId, params.clientOrderId),
      ),
      columns: { perpProtection: true },
    });
    return mergePerpProtectionPlanValues(current?.perpProtection, plan);
  }

  /**
   * Serialize protection-plan unioning against the exact opening order row.
   * PostgreSQL takes a row lock for production transactions; lightweight test
   * doubles that lack a fluent lock retain the bounded compatibility write path.
   */
  private async withLockedPerpProtectionRow(
    params: PerpProtectionAttachRequest,
    db: WorkerPoolDb,
    persist: (
      writeDb: WorkerPoolDb,
      locked?: { perpProtection?: unknown; perpProtectionStatus?: string | null },
    ) => Promise<void>,
  ): Promise<void> {
    const transaction = (db as WorkerPoolDb & {
      transaction?: <R>(callback: (tx: WorkerPoolDb) => Promise<R>) => Promise<R>;
    }).transaction;
    if (typeof transaction !== "function") {
      await persist(db);
      return;
    }
    await transaction.call(db, async (tx) => {
      const selected = (tx as any).select({
        id: schema.orders.id,
        perpProtection: schema.orders.perpProtection,
        perpProtectionStatus: schema.orders.perpProtectionStatus,
      });
      const from = selected && typeof selected.from === "function"
        ? selected.from(schema.orders)
        : null;
      const where = from && typeof from.where === "function"
        ? from.where(and(
            ...(params.protectionClaim?.orderId
              ? [eq(schema.orders.id, params.protectionClaim.orderId)]
              : []),
            eq(schema.orders.userId, params.followerUserId),
            eq(schema.orders.clientOrderId, params.clientOrderId),
          ))
        : null;
      if (!where || typeof where.for !== "function") {
        await persist(tx);
        return;
      }
      const rows = await where.for("update") as Array<{
        id?: string;
        perpProtection?: unknown;
        perpProtectionStatus?: string | null;
      }>;
      const locked = rows[0];
      if (rows.length !== 1 || !locked) {
        throw new PerpProtectionRecordConflictError(
          "protection row disappeared before locked write",
          undefined,
        );
      }
      await persist(tx, locked);
    });
  }

  /**
   * Enforce an UPDATE ... RETURNING CAS and reread the row on a lost race.
   * The fallback exists only for old unit-test doubles; the real Drizzle
   * builder always exposes returning().
   */
  private async assertPerpProtectionCas(
    update: any,
    db: WorkerPoolDb,
    params: PerpProtectionAttachRequest,
    operation: string,
  ): Promise<void> {
    if (typeof update?.returning === "function") {
      const rows = await update.returning({ id: schema.orders.id });
      if (rows.length === 1) return;
    } else {
      await update;
      return;
    }
    let currentStatus: string | null | undefined;
    try {
      const current = await db.query.orders.findFirst({
        where: and(
          ...(params.protectionClaim?.orderId
            ? [eq(schema.orders.id, params.protectionClaim.orderId)]
            : []),
          eq(schema.orders.userId, params.followerUserId),
          eq(schema.orders.clientOrderId, params.clientOrderId),
        ),
        columns: { perpProtectionStatus: true },
      });
      currentStatus = current?.perpProtectionStatus;
    } catch {
      // Preserve the CAS failure even if the diagnostic reread is unavailable.
    }
    throw new PerpProtectionRecordConflictError(
      `protection ${operation} CAS lost; current status=${currentStatus ?? "unknown"}`,
      currentStatus,
    );
  }

  /** Write one protection outcome onto the OPENING order row. */
  private async recordPerpProtection(
    params: PerpProtectionAttachRequest,
    set: {
      perpProtection?: PerpProtectionPlan;
      perpProtectionStatus: "attached" | "unprotected";
      perpProtectionError: string | null;
    },
    db: WorkerPoolDb = this.db,
  ): Promise<void> {
    // Scoped by user as well as cloid. The client order id is already unique,
    // but every other write on this path carries the owner too and a protection
    // record naming the wrong account would be worse than none.
    const persist = async (
      writeDb: WorkerPoolDb,
      locked?: { perpProtection?: unknown },
    ): Promise<void> => {
      let values: typeof set = set;
      // Keep the immutable rule captured in Phase A when the post-fill plan is
      // written. The actual attach plan contains leg ids and prices; replacing
      // the intent wholesale would make a later recovery unable to reconstruct
      // the requested protection.
      if (set.perpProtection) {
        values = {
          ...set,
          perpProtection: locked
            ? mergePerpProtectionPlanValues(locked.perpProtection, set.perpProtection)
            : await this.mergePerpProtectionPlan(params, set.perpProtection, writeDb),
        };
      }
      const statusPredicate = or(
        isNull(schema.orders.perpProtectionStatus),
        eq(schema.orders.perpProtectionStatus, "unprotected"),
      );
      const claimPredicate = params.protectionClaim
        ? and(
            eq(schema.orders.syncReason, params.protectionClaim.reason),
            eq(schema.orders.lastSyncAttemptAt, params.protectionClaim.claimedAt),
          )
        : undefined;
      const persistedValues = params.protectionClaim
        ? {
            ...values,
            // The claim is a one-shot hand-off marker, not a permanent placement
            // reason. Clear it only in the same update that wins the protection
            // status CAS; a lost/stale writer therefore cannot erase a newer
            // recovery owner.
            syncReason: null,
            lastSyncAttemptAt: null,
          }
        : values;
      const update = writeDb
        .update(schema.orders)
        .set(persistedValues)
        .where(
          and(
            ...(params.protectionClaim?.orderId
              ? [eq(schema.orders.id, params.protectionClaim.orderId)]
              : []),
            eq(schema.orders.userId, params.followerUserId),
            eq(schema.orders.clientOrderId, params.clientOrderId),
            statusPredicate,
            claimPredicate,
          ),
        );
      await this.assertPerpProtectionCas(update, writeDb, params, `${values.perpProtectionStatus} write`);
    };
    await this.withLockedPerpProtectionRow(params, db, persist);
  }

  /**
   * Atomically claim one cleanup generation before any exact venue probe.
   * PostgreSQL evaluates both the lease expiry and the write in one UPDATE, so
   * two workers can observe the same marker but only one receives a token.
   * The token is embedded in the marker and is required on subsequent progress
   * and clear writes.
   */
  private async claimPerpProtectionCleanup(
    row: {
      id?: unknown;
      userId?: unknown;
      clientOrderId?: unknown;
      perpProtection?: unknown;
      perpProtectionStatus?: string | null;
    },
    state: PerpProtectionCleanupState,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpProtectionCleanupState | null> {
    if (
      typeof row.id !== "string" ||
      typeof row.userId !== "string" ||
      typeof row.clientOrderId !== "string"
    ) return null;
    const token = randomUUID();
    // Keep the SET expression self-contained while retaining parameterized
    // JSON/token values. Fixed raw fragments use the known schema column and
    // JSON paths; sql.param prevents user-controlled marker text from becoming
    // SQL and also keeps the expression easy for test doubles to inspect.
    const claimed = sql.fromList([
      sql.raw(`jsonb_set(
        jsonb_set(
          jsonb_set(
            CASE
              WHEN perp_protection -> 'copyMirrorProtectionCleanup' IS NULL
              THEN jsonb_set(
                COALESCE(perp_protection, '{}'::jsonb),
                '{copyMirrorProtectionCleanup}',`),
      sql.param(JSON.stringify(state)),
      sql.raw(`::jsonb, true
              )
              ELSE perp_protection
            END,
            '{copyMirrorProtectionCleanup,cleanupClaimToken}',
            to_jsonb(`),
      sql.param(token),
      sql.raw(`::text), true
          ),
          '{copyMirrorProtectionCleanup,cleanupClaimedAt}',
          to_jsonb(CURRENT_TIMESTAMP),
          true
        ),
        '{copyMirrorProtectionCleanup,cleanupLeaseUntil}',
        to_jsonb(CURRENT_TIMESTAMP + (${PERP_PROTECTION_CLEANUP_LEASE_MS} * interval '1 millisecond')),
        true
      )`),
    ]);
    const claimable = sql`(
      ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' IS NULL
      OR (
        (
          ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
            ->> 'cleanupClaimToken' IS NULL
          OR ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
            ->> 'cleanupLeaseUntil' IS NULL
          OR (
            pg_input_is_valid(
              ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
                ->> 'cleanupLeaseUntil',
              'timestamptz'
            )
            AND CASE WHEN pg_input_is_valid(
              ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
                ->> 'cleanupLeaseUntil',
              'timestamptz'
            ) THEN (${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupLeaseUntil')::timestamptz END <= CURRENT_TIMESTAMP
          )
        )
        AND (
          ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
            ->> 'cleanupNextAttemptAt' IS NULL
          OR (
            pg_input_is_valid(
              ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
                ->> 'cleanupNextAttemptAt',
              'timestamptz'
            )
            AND CASE WHEN pg_input_is_valid(
              ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
                ->> 'cleanupNextAttemptAt',
              'timestamptz'
            ) THEN (${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupNextAttemptAt')::timestamptz END <= CURRENT_TIMESTAMP
          )
        )
        AND (
          ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
            ->> 'cleanupQuarantineUntil' IS NULL
          OR (
            pg_input_is_valid(
              ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
                ->> 'cleanupQuarantineUntil',
              'timestamptz'
            )
            AND CASE WHEN pg_input_is_valid(
              ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
                ->> 'cleanupQuarantineUntil',
              'timestamptz'
            ) THEN (${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupQuarantineUntil')::timestamptz END <= CURRENT_TIMESTAMP
          )
        )
      )
    )`;
    const update = db
      .update(schema.orders)
      .set({ perpProtection: claimed })
      .where(
        and(
          eq(schema.orders.id, row.id),
          eq(schema.orders.userId, row.userId),
          eq(schema.orders.clientOrderId, row.clientOrderId),
          perpProtectionCleanupStatusPredicate(),
          claimable,
        ),
      );
    if (typeof (update as any).returning === "function") {
      const rows = await (update as any).returning({ id: schema.orders.id });
      if (rows.length !== 1) return null;
    } else {
      // A production-shaped adapter must expose RETURNING: without it this
      // worker cannot prove that it owns the lease before touching the venue.
      // Keep the no-execute branch only for legacy in-memory test doubles.
      if (typeof (db as any).execute === "function") return null;
      await update;
    }
    return { ...state, cleanupClaimToken: token };
  }

  /**
   * Fence every exact venue operation with a fresh PostgreSQL-clock lease.
   * A worker may have spent most of its lease constructing a client or waiting
   * on a venue read; extending it only from the original claim would let an
   * expired worker mutate the venue after another worker reclaimed the marker.
   * UPDATE ... RETURNING is the authority: no returned row means this worker
   * must not issue the probe/cancel.
   */
  private async renewPerpProtectionCleanupLease(
    state: PerpProtectionCleanupState,
    db: WorkerPoolDb = this.db,
  ): Promise<boolean> {
    if (
      !state.cleanupClaimToken ||
      !state.openingOrderId ||
      typeof (db as any).update !== "function"
    ) return typeof (db as any).execute !== "function";
    // Validate that the same PostgreSQL clock used by the lease expression is
    // reachable before attempting any venue operation. Legacy in-memory test
    // doubles have no execute seam and are intentionally handled above.
    try {
      await readDatabaseNow(db);
    } catch {
      return false;
    }
    const renewed = sql`jsonb_set(
      ${schema.orders.perpProtection},
      '{copyMirrorProtectionCleanup,cleanupLeaseUntil}',
      to_jsonb(CURRENT_TIMESTAMP + (${PERP_PROTECTION_CLEANUP_LEASE_MS} * interval '1 millisecond')),
      true
    )`;
    try {
      const update = db
        .update(schema.orders)
        .set({ perpProtection: renewed })
        .where(and(
          eq(schema.orders.id, state.openingOrderId),
          eq(schema.orders.userId, state.followerUserId),
          eq(schema.orders.clientOrderId, state.openingClientOrderId!),
          perpProtectionCleanupStatusPredicate(),
          cleanupClaimPredicate(state.cleanupClaimToken),
          cleanupLeaseActivePredicate(),
        ));
      if (typeof (update as any).returning !== "function") return false;
      const rows = await (update as any).returning({ id: schema.orders.id });
      return rows.length === 1;
    } catch (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] cleanup lease renewal failed before venue operation", {
        orderId: state.openingOrderId,
        error: cleanupErrorText(error),
      });
      return false;
    }
  }

  /**
   * Record a durable retry/quarantine decision without changing the opening
   * order status. Every failure is evidence: the bounded scanner can move on
   * immediately, and an operator can see why a marker was deferred.
   */
  private async markPerpProtectionCleanupFailure(
    row: {
      id?: unknown;
      userId?: unknown;
      clientOrderId?: unknown;
      symbol?: unknown;
      brokerAccountId?: unknown;
      perpProtection?: unknown;
      perpProtectionStatus?: string | null;
    },
    state: PerpProtectionCleanupState,
    kind: string,
    error: unknown,
    now: Date,
    db: WorkerPoolDb = this.db,
    retiredLegClientOrderIds: readonly string[] = [],
  ): Promise<void> {
    if (
      typeof row.id !== "string" ||
      typeof row.userId !== "string" ||
      typeof row.clientOrderId !== "string"
    ) return;
    const rowId = row.id;
    const rowUserId = row.userId;
    const rowClientOrderId = row.clientOrderId;
    const params: PerpProtectionAttachRequest = {
      followerUserId: rowUserId,
      sourceItemId: state.sourceItemId,
      walletAddress: state.walletAddress,
      coin: state.coin,
      sizeCoin: "0",
      clientOrderId: rowClientOrderId,
    };
    const persist = async (
      writeDb: WorkerPoolDb,
      locked?: { perpProtection?: unknown; perpProtectionStatus?: string | null },
    ): Promise<void> => {
      // Re-read after the claim. The backlog row is only a scan snapshot; using
      // it here could overwrite a distinct late cloid appended while this
      // worker held the lease. A locked read in production plus the exact
      // scoped token predicate keeps failure metadata monotonic under that
      // race.
      const raw = locked
        ? locked.perpProtection
        : (await readPerpProtectionOrderRow(writeDb, {
            id: rowId,
            userId: rowUserId,
            clientOrderId: rowClientOrderId,
          }))?.perpProtection ?? row.perpProtection;
      const retiredLegs = readRetiredPerpProtectionLegs(raw);
      if (retiredLegs === null) return;
      const current = readPerpProtectionCleanup(raw);
      if (
        raw && typeof raw === "object" &&
        Reflect.has(raw, PERP_PROTECTION_CLEANUP_KEY) && !current
      ) {
        // A malformed marker cannot be safely merged with a claimed state;
        // leave it visible for operator repair instead of overwriting it.
        return;
      }
      const currentState: DurablePerpProtectionCleanupState = current ?? state;
      const currentAttempt =
        typeof currentState.cleanupAttemptCount === "number" &&
        Number.isSafeInteger(currentState.cleanupAttemptCount) &&
        currentState.cleanupAttemptCount >= 0
          ? currentState.cleanupAttemptCount
          : 0;
      const cleanupAttemptCount = currentAttempt + 1;
      const backoff = Math.min(
        PERP_PROTECTION_CLEANUP_RETRY_MAX_MS,
        PERP_PROTECTION_CLEANUP_RETRY_BASE_MS * 2 ** Math.min(cleanupAttemptCount - 1, 10),
      );
      const nextAttempt = new Date(now.getTime() + backoff).toISOString();
      const newlyRetired = [...new Set(
        retiredLegClientOrderIds
          .filter((id): id is string => typeof id === "string" && id.trim() !== "")
          .map((id) => id.trim()),
      )];
      const nextRetiredLegs = [...new Set([...retiredLegs, ...newlyRetired])];
      const marker: DurablePerpProtectionCleanupState = {
        ...currentState,
        ...state,
        legClientOrderIds: [...new Set(
          [...currentState.legClientOrderIds, ...state.legClientOrderIds],
        )].filter((id) => !nextRetiredLegs.includes(id)),
        cleanupAttemptCount,
        cleanupNextAttemptAt: nextAttempt,
        cleanupLastFailureKind: kind.slice(0, 120),
        cleanupLastError: cleanupErrorText(error),
      };
      if (cleanupAttemptCount >= PERP_PROTECTION_CLEANUP_QUARANTINE_AFTER) {
        marker.cleanupQuarantineUntil = new Date(
          now.getTime() + PERP_PROTECTION_CLEANUP_QUARANTINE_MS,
        ).toISOString();
      }
      const released = withoutCleanupLease(marker);
      const record = raw && typeof raw === "object"
        ? { ...(raw as Record<string, unknown>) } as unknown as DurablePerpProtectionRecord
        : {} as DurablePerpProtectionRecord;
      record[PERP_PROTECTION_CLEANUP_KEY] = released;
      if (nextRetiredLegs.length > 0) {
        record[PERP_PROTECTION_CLEANUP_RETIRED_LEGS_KEY] = nextRetiredLegs;
      }
      const update = writeDb
        .update(schema.orders)
        .set({ perpProtection: record })
        .where(
          and(
            eq(schema.orders.id, rowId),
            eq(schema.orders.userId, rowUserId),
            eq(schema.orders.clientOrderId, rowClientOrderId),
            perpProtectionCleanupStatusPredicate(),
            cleanupClaimPredicate(state.cleanupClaimToken),
            state.cleanupClaimToken ? cleanupLeaseActivePredicate() : undefined,
          ),
        );
      if (typeof (update as any).returning === "function") {
        const rows = await (update as any).returning({ id: schema.orders.id });
        if (rows.length !== 1) {
          throw new PerpProtectionRecordConflictError(
            "protection cleanup failure metadata CAS lost",
            locked?.perpProtectionStatus ?? row.perpProtectionStatus,
          );
        }
      } else {
        if (typeof (writeDb as any).execute === "function") {
          throw new Error("protection cleanup failure metadata requires UPDATE RETURNING");
        }
        await update;
      }
    };
    await this.withLockedPerpProtectionRow(params, db, persist);
  }

  /** Persist stale-leg cleanup without changing the opening row's status. */
  private async recordPerpProtectionCleanup(
    state: PerpProtectionCleanupState,
    db: WorkerPoolDb = this.db,
    retiredLegClientOrderIds: readonly string[] = [],
  ): Promise<void> {
    const openingClientOrderId = state.openingClientOrderId?.trim();
    if (
      !openingClientOrderId ||
      !state.followerUserId.trim() ||
      !state.sourceItemId.trim() ||
      !state.coin.trim() ||
      !isPerpWalletAddress(state.walletAddress) ||
      state.legClientOrderIds.length === 0
    ) {
      throw new Error("protection cleanup marker is incomplete");
    }

    // Fresh attaches do not carry an order UUID in their request. Resolve it
    // once from the exact (user, cloid) identity so recovery can keep using the
    // same row even after the status moves to cancelled.
    let durableState = state;
    if (!state.openingOrderId) {
      const row = await db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, state.followerUserId),
          eq(schema.orders.clientOrderId, openingClientOrderId),
        ),
        columns: { id: true },
      });
      if (!row?.id) throw new Error("protection cleanup opening row disappeared");
      durableState = { ...state, openingClientOrderId, openingOrderId: row.id };
    } else {
      durableState = { ...state, openingClientOrderId };
    }

    const params: PerpProtectionAttachRequest = {
      followerUserId: durableState.followerUserId,
      sourceItemId: durableState.sourceItemId,
      walletAddress: durableState.walletAddress,
      coin: durableState.coin,
      sizeCoin: "0",
      clientOrderId: openingClientOrderId,
    };
    const persist = async (
      writeDb: WorkerPoolDb,
      locked?: { perpProtection?: unknown; perpProtectionStatus?: string | null },
    ): Promise<void> => {
      const raw = locked
        ? locked.perpProtection
        : (await readPerpProtectionOrderRow(writeDb, {
            id: durableState.openingOrderId,
            userId: durableState.followerUserId,
            clientOrderId: openingClientOrderId,
          }))?.perpProtection;
      const retiredLegs = readRetiredPerpProtectionLegs(raw);
      if (retiredLegs === null) {
        throw new Error("protection cleanup retired-leg marker is malformed");
      }
      const current = readPerpProtectionCleanup(raw);
      if (
        raw && typeof raw === "object" &&
        Reflect.has(raw, PERP_PROTECTION_CLEANUP_KEY) && !current
      ) {
        throw new Error("protection cleanup marker is malformed");
      }
      const currentClaimToken = current?.cleanupClaimToken;
      if (
        currentClaimToken && durableState.cleanupClaimToken &&
        currentClaimToken !== durableState.cleanupClaimToken
      ) {
        throw new PerpProtectionRecordConflictError(
          "protection cleanup lease belongs to another worker",
          locked?.perpProtectionStatus,
        );
      }
      const newlyRetired = [...new Set(retiredLegClientOrderIds)]
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim());
      const nextRetiredLegs = [...new Set([...retiredLegs, ...newlyRetired])];
      const incomingLegs = [...new Set(durableState.legClientOrderIds)]
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim());
      const pendingLegs = [...new Set([
        ...(current?.legClientOrderIds ?? []),
        ...incomingLegs,
      ])].filter((legId) => !nextRetiredLegs.includes(legId));

      // A late callback for a cloid already proven retired is harmless and must
      // not reopen a marker. A distinct deterministic cloid remains eligible.
      if (pendingLegs.length === 0 && newlyRetired.length === 0) return;
      const merged = mergePerpProtectionCleanupStates(current, {
        ...durableState,
        legClientOrderIds: pendingLegs,
      });
      const effectiveClaimToken = durableState.cleanupClaimToken ?? currentClaimToken;
      const durableMerged = {
        ...merged,
        legClientOrderIds: pendingLegs,
        ...(effectiveClaimToken ? { cleanupClaimToken: effectiveClaimToken } : {}),
      } as DurablePerpProtectionCleanupState;
      // A backlog retry schedules ordinary pending progress in a second,
      // token-fenced write immediately after this callback. Keep the claim
      // token/lease in place until that write releases it; dropping the token
      // here would make the scheduler race a newly reclaimed worker and would
      // lose the exact retired subtraction's fencing.
      const storedMarker = durableMerged;
      const record = raw && typeof raw === "object"
        ? { ...(raw as Record<string, unknown>) } as unknown as DurablePerpProtectionRecord
        : {} as DurablePerpProtectionRecord;
      if (pendingLegs.length > 0) {
        record[PERP_PROTECTION_CLEANUP_KEY] = storedMarker;
      } else {
        delete record[PERP_PROTECTION_CLEANUP_KEY];
      }
      if (nextRetiredLegs.length > 0) {
        record[PERP_PROTECTION_CLEANUP_RETIRED_LEGS_KEY] = nextRetiredLegs;
      }
      const update = writeDb
        .update(schema.orders)
        .set({ perpProtection: record })
        .where(
          and(
            eq(schema.orders.id, durableState.openingOrderId!),
            eq(schema.orders.userId, durableState.followerUserId),
            eq(schema.orders.clientOrderId, openingClientOrderId),
            perpProtectionCleanupStatusPredicate(),
            cleanupClaimPredicate(effectiveClaimToken),
            effectiveClaimToken ? cleanupLeaseActivePredicate() : undefined,
          ),
        );
      if (typeof (update as any).returning === "function") {
        const rows = await (update as any).returning({ id: schema.orders.id });
        if (rows.length !== 1) {
          throw new PerpProtectionRecordConflictError(
            "protection cleanup marker CAS lost",
            locked?.perpProtectionStatus,
          );
        }
      } else {
        if (typeof (writeDb as any).execute === "function") {
          throw new Error("protection cleanup marker requires UPDATE RETURNING");
        }
        await update;
      }
    };
    await this.withLockedPerpProtectionRow(params, db, persist);
  }

  /** Retire a completed cleanup marker while preserving the cancelled status. */
  private async clearPerpProtectionCleanup(
    state: PerpProtectionCleanupState,
    db: WorkerPoolDb = this.db,
  ): Promise<void> {
    const openingClientOrderId = state.openingClientOrderId?.trim();
    const openingOrderId = state.openingOrderId;
    if (!openingClientOrderId || !openingOrderId) return;
    const params: PerpProtectionAttachRequest = {
      followerUserId: state.followerUserId,
      sourceItemId: state.sourceItemId,
      walletAddress: state.walletAddress,
      coin: state.coin,
      sizeCoin: "0",
      clientOrderId: openingClientOrderId,
    };
    const persist = async (
      writeDb: WorkerPoolDb,
      locked?: { perpProtection?: unknown; perpProtectionStatus?: string | null },
    ): Promise<void> => {
      const raw = locked
        ? locked.perpProtection
        : (await readPerpProtectionOrderRow(writeDb, {
            id: state.openingOrderId,
            userId: state.followerUserId,
            clientOrderId: openingClientOrderId,
          }))?.perpProtection;
      const retiredLegs = readRetiredPerpProtectionLegs(raw);
      if (retiredLegs === null) return;
      const current = readPerpProtectionCleanup(raw);
      const currentClaimToken = current?.cleanupClaimToken;
      if (
        currentClaimToken &&
        (!state.cleanupClaimToken || state.cleanupClaimToken !== currentClaimToken)
      ) {
        // Never let an expired/stale worker retire a generation claimed by a
        // different worker. The next lease holder will perform the exact reads.
        return;
      }
      // A marker-less recovery came from the pre-submit plan checkpoint. Treat
      // that plan as the current generation so successful exact probes can
      // retire its cloids durably without changing the opening status.
      const candidate = current ?? readPerpProtectionCleanupCandidate({
        id: openingOrderId,
        userId: state.followerUserId,
        clientOrderId: openingClientOrderId,
        symbol: state.coin,
        brokerAccountId: state.walletAddress,
        perpProtection: raw,
      });
      if (!candidate || !cleanupStatesNameSameOpening(candidate, state)) return;
      const retiredIds = new Set(state.legClientOrderIds);
      if (candidate.legClientOrderIds.some((id) => !retiredIds.has(id))) return;
      const record = { ...(raw as Record<string, unknown>) } as unknown as DurablePerpProtectionRecord;
      delete record[PERP_PROTECTION_CLEANUP_KEY];
      record[PERP_PROTECTION_CLEANUP_RETIRED_LEGS_KEY] = [
        ...new Set([...retiredLegs, ...candidate.legClientOrderIds]),
      ];
      const claimToken = state.cleanupClaimToken ?? currentClaimToken;
      const values = locked?.perpProtectionStatus === "attached"
        ? { perpProtection: record, perpProtectionStatus: "cancelled" as const }
        : { perpProtection: record };
      const update = writeDb
        .update(schema.orders)
        .set(values)
        .where(
          and(
            eq(schema.orders.id, openingOrderId),
            eq(schema.orders.userId, state.followerUserId),
            eq(schema.orders.clientOrderId, openingClientOrderId),
            perpProtectionCleanupStatusPredicate(),
            cleanupClaimPredicate(claimToken),
            claimToken ? cleanupLeaseActivePredicate() : undefined,
          ),
        );
      if (typeof (update as any).returning === "function") {
        const rows = await (update as any).returning({ id: schema.orders.id });
        if (rows.length !== 1) {
          throw new PerpProtectionRecordConflictError(
            "protection cleanup marker clear CAS lost",
            locked?.perpProtectionStatus,
          );
        }
      } else {
        if (typeof (writeDb as any).execute === "function") {
          throw new Error("protection cleanup clear requires UPDATE RETURNING");
        }
        await update;
      }
    };
    await this.withLockedPerpProtectionRow(params, db, persist);
  }

  /**
   * Retire the legs a previous open attached, after a mirrored source close has
   * been placed. NEVER THROWS: this runs on the close path.
   */
  private async cancelPerpProtection(
    client: HyperliquidClient,
    params: PerpProtectionCancelRequest,
    db: WorkerPoolDb = this.db,
  ): Promise<void> {
    const [error, result] = await catchError(
      cancelPerpProtection(client, params, {
        loadAttachedPlans: async () => {
          // NAMED ORDERS ONLY, never a prefix scan.
          //
          // This used to match `copymirror:<follower>:%`, which names the
          // FOLLOWER and not the SOURCE. A follower following two traders in one
          // coin had both plans loaded by either trader's close, so a full close
          // by one retired the other's stop over a position that was still open,
          // and marked the row `cancelled` rather than `unprotected` so the
          // backlog line never surfaced it. The signal case was worse: a
          // `copymirror:<follower>:x_signal:...` mirror matched the same prefix
          // and has no source that ever closes, so any user close in the coin
          // silently stripped the only exit it would ever have.
          //
          // `attributedClientOrderIds` is the close's own attribution set, so
          // this is exactly as wide as the sizing already is. The module refuses
          // an empty set before reaching here, which also keeps `inArray` off an
          // empty list.
          const rows = await db.query.orders.findMany({
            where: and(
              eq(schema.orders.userId, params.followerUserId),
              eq(schema.orders.venue, "hyperliquid"),
              eq(schema.orders.assetType, "PERP"),
              eq(schema.orders.symbol, params.coin),
              inArray(schema.orders.clientOrderId, [...params.attributedClientOrderIds]),
              // `unprotected` as well as `attached`. An attach that gave up may
              // still have left a leg resting at the venue, and it now records
              // the ids it submitted on the row for exactly this lookup. Such a
              // row carries a plan only when something was actually sent, and
              // `perpProtectionCancelPlan` returns nothing for the rest, so the
              // widened filter adds no venue read where there is nothing to
              // retire. `cancelPerpProtection` leaves these rows `unprotected`
              // rather than marking them `cancelled`, so the backlog line that
              // counts missing stops is unaffected.
              or(
                isNull(schema.orders.perpProtectionStatus),
                inArray(schema.orders.perpProtectionStatus, ["attached", "unprotected"]),
              ),
            ),
            columns: {
              id: true,
              clientOrderId: true,
              perpProtection: true,
              perpProtectionStatus: true,
            },
            orderBy: [desc(schema.orders.createdAt)],
            limit: PERP_PROTECTION_PLAN_SCAN_CAP,
          });
          return rows.map((row) => ({
            orderId: row.id,
            clientOrderId: row.clientOrderId ?? null,
            perpProtection: row.perpProtection ?? null,
            perpProtectionStatus: row.perpProtectionStatus ?? null,
            cleanupState: row.clientOrderId
              ? readPerpProtectionCleanupCandidate({
                  id: row.id,
                  userId: params.followerUserId,
                  clientOrderId: row.clientOrderId,
                  symbol: params.coin,
                  brokerAccountId: params.walletAddress,
                  perpProtection: row.perpProtection,
                })
              : null,
          }));
        },
        recordCleanup: (state, retiredLegClientOrderIds) =>
          this.recordPerpProtectionCleanup(state, db, retiredLegClientOrderIds),
        markCancelled: async (orderId, expectedStatus) => {
          const expected = expectedStatus === "attached"
            ? eq(schema.orders.perpProtectionStatus, "attached")
            : expectedStatus === "unprotected"
              ? eq(schema.orders.perpProtectionStatus, "unprotected")
              : isNull(schema.orders.perpProtectionStatus);
          const update = db
            .update(schema.orders)
            .set({ perpProtectionStatus: "cancelled" })
            .where(and(eq(schema.orders.id, orderId), expected));
          if (typeof (update as any).returning !== "function") {
            await update;
            return;
          }
          const rows = await (update as any).returning({ id: schema.orders.id });
          if (rows.length === 1) return;
          // A source close and a protection recovery can race. A zero-row CAS
          // is only benign when the row is already cancelled; otherwise reread
          // and surface the lost owner rather than claiming success.
          const current = await db.query.orders.findFirst({
            where: eq(schema.orders.id, orderId),
            columns: { perpProtectionStatus: true },
          });
          if (current?.perpProtectionStatus === "cancelled") return;
          throw new PerpProtectionRecordConflictError(
            `protection cancellation CAS lost; current status=${current?.perpProtectionStatus ?? "unknown"}`,
            current?.perpProtectionStatus,
          );
        },
      }),
    );
    if (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp protection cancel threw after a placed close", {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin.slice(0, 24),
        error: error.message,
      });
      return;
    }
    if (result.skippedUnattributed) {
      // The close could not name a single mirrored open of its own, so nothing
      // was read and nothing was cancelled. Said out loud because the cost of
      // this refusal is real (a plan that may still be resting over a position
      // this close just emptied) and it is the deliberate side to err on: the
      // alternative, cancelling on an unresolved scope, is the defect that
      // stripped other follows' stops.
      logger.warn(
        LOG_SERVICE,
        "[copy-mirror] perp protection left alone: the close resolved no mirrored orders of its own, so nothing could be attributed to it",
        {
          followerUserId: params.followerUserId,
          sourceItemId: params.sourceItemId,
          coin: params.coin.slice(0, 24),
        },
      );
      return;
    }
    if (result.retired === 0 && result.stranded === 0) return;
    if (result.stranded > 0) {
      // A leg the mirror could not cancel is still resting over a position the
      // close just reduced. It is reduce-only, so it cannot open anything, but
      // it can still take a later position in the same coin down with it.
      logger.error(
        LOG_SERVICE,
        "[copy-mirror] mirrored perp protection legs are still resting after a close; they can fire against a later position in this coin",
        {
          followerUserId: params.followerUserId,
          sourceItemId: params.sourceItemId,
          coin: params.coin.slice(0, 24),
          retired: result.retired,
          stranded: result.stranded,
          errors: result.errors.slice(0, 5),
        },
      );
      return;
    }
    logger.info(LOG_SERVICE, "[copy-mirror] perp protection retired with the mirrored close", {
      followerUserId: params.followerUserId,
      sourceItemId: params.sourceItemId,
      coin: params.coin.slice(0, 24),
      retired: result.retired,
    });
  }

  /** Retry durable stale-leg cleanup independently of the opening status. */
  private async retryPerpProtectionCleanupBacklog(): Promise<void> {
    const [clockError, databaseNow] = await catchError(readDatabaseNow(this.db));
    if (clockError) {
      logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup skipped without database clock", {
        error: clockError.message,
      });
      return;
    }
    // Validate marker shape in PostgreSQL before ORDER/LIMIT. A malformed
    // operator row is durable evidence for repair, but it is not an actionable
    // cleanup candidate and must not consume the bounded scan cap. Timestamp
    // values use pg_input_is_valid plus CASE so a bad value such as
    // 2026-99-99T00:00:00Z cannot abort the whole queue query during a cast.
    const cleanupMarkerIsValid = sql`(
      jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup') = 'object'
      AND jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'followerUserId') = 'string'
      AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'followerUserId') <> ''
      AND jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'sourceItemId') = 'string'
      AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'sourceItemId') <> ''
      AND jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'walletAddress') = 'string'
      AND ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'walletAddress' ~ '^0x[0-9a-fA-F]{40}$'
      AND jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'coin') = 'string'
      AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'coin') <> ''
      AND jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'legClientOrderIds') = 'array'
      AND CASE WHEN jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'legClientOrderIds') = 'array'
        THEN jsonb_array_length(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'legClientOrderIds') > 0
        ELSE false
      END
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'legClientOrderIds') = 'array'
            THEN ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'legClientOrderIds'
            ELSE '[]'::jsonb
          END
        ) AS cleanup_leg(value)
        WHERE jsonb_typeof(cleanup_leg.value) <> 'string'
          OR btrim(cleanup_leg.value #>> '{}') = ''
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'openingClientOrderId' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'openingClientOrderId') = 'string'
          AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'openingClientOrderId') <> ''
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'openingOrderId' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'openingOrderId') = 'string'
          AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'openingOrderId') <> ''
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupClaimToken' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupClaimToken') = 'string'
          AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupClaimToken') <> ''
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupClaimedAt' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupClaimedAt') = 'string'
          AND pg_input_is_valid(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupClaimedAt', 'timestamptz')
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupLeaseUntil' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupLeaseUntil') = 'string'
          AND pg_input_is_valid(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupLeaseUntil', 'timestamptz')
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupNextAttemptAt' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupNextAttemptAt') = 'string'
          AND pg_input_is_valid(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupNextAttemptAt', 'timestamptz')
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupQuarantineUntil' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupQuarantineUntil') = 'string'
          AND pg_input_is_valid(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupQuarantineUntil', 'timestamptz')
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupAttemptCount' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupAttemptCount') = 'number'
          AND ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupAttemptCount' ~ '^[0-9]+$'
          AND (${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupAttemptCount')::numeric <= 9007199254740991
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupLastFailureKind' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupLastFailureKind') = 'string'
          AND btrim(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' ->> 'cleanupLastFailureKind') <> ''
        )
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupLastError' IS NULL
        OR jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'cleanupLastError') = 'string'
      )
      AND (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanupRetiredLegClientOrderIds' IS NULL
        OR (
          jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanupRetiredLegClientOrderIds') = 'array'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanupRetiredLegClientOrderIds') = 'array'
                THEN ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanupRetiredLegClientOrderIds'
                ELSE '[]'::jsonb
              END
            ) AS retired_leg(value)
            WHERE jsonb_typeof(retired_leg.value) <> 'string'
              OR btrim(retired_leg.value #>> '{}') = ''
          )
        )
      )
    )`;
    // A cleanup marker is the normal queue entry. The plan predicate is the
    // bounded restart fallback for a marker write lost after checkpointing;
    // fallback is explicitly marker-less so malformed markers cannot bypass
    // shape validation. Retired plan rows are excluded before the cap.
    const cleanupMarkerOrPendingCheckpoint = sql`(
      (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' IS NOT NULL
        AND ${cleanupMarkerIsValid}
        AND NOT (
          COALESCE(
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' -> 'legClientOrderIds',
            '[]'::jsonb
          )
          <@ COALESCE(
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanupRetiredLegClientOrderIds',
            '[]'::jsonb
          )
        )
      )
      OR (
        ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' IS NULL
        AND ${schema.orders.perpProtectionStatus} = 'cancelled'
        AND ${schema.orders.perpProtection} ->> 'copyMirrorProtectionIntent' = 'true'
        AND jsonb_array_length(
          CASE WHEN jsonb_typeof(${schema.orders.perpProtection} -> 'legClientOrderIds') = 'array'
            THEN ${schema.orders.perpProtection} -> 'legClientOrderIds'
            ELSE '[]'::jsonb
          END
        ) > 0
        AND NOT (
          COALESCE(${schema.orders.perpProtection} -> 'legClientOrderIds', '[]'::jsonb)
          <@ COALESCE(
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanupRetiredLegClientOrderIds',
            '[]'::jsonb
          )
        )
      )
    )`;
    // Scheduling is part of the bounded fairness contract. A row that has
    // already failed gets a durable next-attempt time, so it is filtered out
    // by PostgreSQL before ORDER/LIMIT and cannot consume the whole scan cap.
    const cleanupDue = sql`(
      ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' IS NULL
      OR (
        ${cleanupMarkerIsValid}
        AND (
          ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
            ->> 'cleanupNextAttemptAt' IS NULL
          OR CASE WHEN pg_input_is_valid(
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupNextAttemptAt', 'timestamptz'
          ) THEN (
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupNextAttemptAt'
          )::timestamptz END <= CURRENT_TIMESTAMP
        )
        AND (
          ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
            ->> 'cleanupQuarantineUntil' IS NULL
          OR CASE WHEN pg_input_is_valid(
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupQuarantineUntil', 'timestamptz'
          ) THEN (
            ${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup'
              ->> 'cleanupQuarantineUntil'
          )::timestamptz END <= CURRENT_TIMESTAMP
        )
      )
    )`;
    const cleanupStatus = or(
      inArray(schema.orders.perpProtectionStatus, ["cancelled", "unprotected"]),
      and(
        eq(schema.orders.perpProtectionStatus, "attached"),
        sql`${schema.orders.perpProtection} -> 'copyMirrorProtectionCleanup' IS NOT NULL`,
      ),
    );
    const [error, rows] = await catchError(
      this.db.query.orders.findMany({
        where: and(
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          cleanupStatus,
          cleanupMarkerOrPendingCheckpoint,
          cleanupDue,
        ),
        columns: {
          id: true,
          userId: true,
          clientOrderId: true,
          symbol: true,
          perpProtection: true,
          perpProtectionStatus: true,
          brokerCredentialId: true,
          brokerAccountId: true,
        },
        orderBy: [asc(schema.orders.createdAt)],
        limit: PERP_PROTECTION_CLEANUP_SCAN_CAP + 1,
      }),
    );
    if (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup unreadable", {
        error: error.message,
      });
      return;
    }
    let malformedMarkerCount = 0;
    const scanned = rows.length > PERP_PROTECTION_CLEANUP_SCAN_CAP
      ? rows.slice(0, PERP_PROTECTION_CLEANUP_SCAN_CAP)
      : rows;
    for (const row of scanned) {
      const state = readPerpProtectionCleanupCandidate(row);
      if (!state) {
        if (
          row.perpProtection &&
          typeof row.perpProtection === "object" &&
          Reflect.has(row.perpProtection, PERP_PROTECTION_CLEANUP_KEY)
        ) {
          malformedMarkerCount += 1;
          if (malformedMarkerCount <= 5) {
            logger.error(LOG_SERVICE, "[copy-mirror] malformed durable perp protection cleanup marker excluded", {
              orderId: row.id,
              userId: row.userId,
            });
          }
        }
        continue;
      }
      const [claimError, claimedState] = await catchError(
        this.claimPerpProtectionCleanup(row, state),
      );
      if (claimError) {
        logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup claim failed", {
          orderId: row.id,
          error: claimError.message,
        });
        continue;
      }
      // A zero-row UPDATE ... RETURNING means another worker owns this
      // generation (or the row changed underneath this snapshot). No venue
      // read is permitted until a token is returned.
      if (!claimedState) continue;
      if (
        claimedState.followerUserId !== row.userId ||
        claimedState.coin !== row.symbol ||
        claimedState.openingOrderId !== row.id ||
        claimedState.openingClientOrderId !== row.clientOrderId ||
        !isPerpWalletAddress(claimedState.walletAddress) ||
        row.brokerAccountId &&
          row.brokerAccountId.toLowerCase() !== claimedState.walletAddress.toLowerCase()
      ) {
        // The marker is durable evidence, but an identity mismatch is not
        // permission to probe or cancel somebody else's order. Leave it for
        // operator repair rather than guessing across accounts or openings.
        logger.error(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup identity mismatch", {
          orderId: row.id,
          followerUserId: row.userId,
        });
        const [failureError] = await catchError(
          this.markPerpProtectionCleanupFailure(
            row,
            claimedState,
            "identity-mismatch",
            new Error("cleanup marker identity does not match opening row"),
            databaseNow,
          ),
        );
        if (failureError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] cleanup identity failure could not be scheduled", {
            orderId: row.id,
            error: failureError.message,
          });
        }
        continue;
      }
      const credentialId = row.brokerCredentialId?.trim();
      if (!credentialId) {
        const [failureError] = await catchError(
          this.markPerpProtectionCleanupFailure(
            row,
            claimedState,
            "credential-missing",
            new Error("Hyperliquid cleanup credential is missing"),
            databaseNow,
          ),
        );
        if (failureError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] cleanup credential failure could not be scheduled", {
            orderId: row.id,
            error: failureError.message,
          });
        }
        continue;
      }
      const [credentialError, credential] = await catchError(
        this.db.query.userApiCredentials.findFirst({
          where: and(
            eq(schema.userApiCredentials.id, credentialId),
            eq(schema.userApiCredentials.userId, row.userId),
            eq(schema.userApiCredentials.provider, "hyperliquid"),
            eq(schema.userApiCredentials.accountType, HL_AGENT_REGISTERED),
          ),
          columns: { id: true, provider: true, accountType: true },
        }),
      );
      if (credentialError || !credential) {
        const [failureError] = await catchError(
          this.markPerpProtectionCleanupFailure(
            row,
            claimedState,
            "credential-unavailable",
            credentialError ?? new Error("Hyperliquid cleanup credential is unavailable"),
            databaseNow,
          ),
        );
        if (failureError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] cleanup credential failure could not be scheduled", {
            orderId: row.id,
            error: failureError.message,
          });
        }
        continue;
      }
      const [clientError, created] = await catchError(
        this.createPerpClient(this.db as never, row.userId, { credentialId }),
      );
      if (clientError || !created) {
        logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup client unavailable", {
          orderId: row.id,
          error: clientError?.message ?? "client unavailable",
        });
        const [failureError] = await catchError(
          this.markPerpProtectionCleanupFailure(
            row,
            claimedState,
            "client-unavailable",
            clientError ?? new Error("cleanup client unavailable"),
            databaseNow,
          ),
        );
        if (failureError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] cleanup client failure could not be scheduled", {
            orderId: row.id,
            error: failureError.message,
          });
        }
        continue;
      }
      if (created.walletAddress.toLowerCase() !== claimedState.walletAddress.toLowerCase()) {
        logger.error(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup wallet mismatch", {
          orderId: row.id,
          followerUserId: row.userId,
        });
        const [failureError] = await catchError(
          this.markPerpProtectionCleanupFailure(
            row,
            claimedState,
            "wallet-mismatch",
            new Error("cleanup client wallet does not match marker"),
            databaseNow,
          ),
        );
        if (failureError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] cleanup wallet failure could not be scheduled", {
            orderId: row.id,
            error: failureError.message,
          });
        }
        continue;
      }
      const [retryError, result] = await catchError(
        retryPerpProtectionCleanup(created.client, claimedState, {
          beforeExactProbe: (cleanupState, _legClientOrderId) =>
            this.renewPerpProtectionCleanupLease(cleanupState),
          beforeCancel: (cleanupState, _legClientOrderId, _orderId) =>
            this.renewPerpProtectionCleanupLease(cleanupState),
          // Ordinary pending progress must be one token-fenced write: merge
          // exact retired IDs, retain only exact pending IDs, increment the
          // retry/quarantine metadata, and release this lease together. The
          // protection helper invokes this callback instead of doing a first
          // marker write followed by a second scheduler update.
          recordPendingCleanup: (pending, retired, errors) =>
            this.markPerpProtectionCleanupFailure(
              row,
              pending,
              "venue-pending",
              new Error(errors[0] ?? "cleanup remains pending"),
              databaseNow,
              this.db,
              retired,
            ),
        }),
      );
      if (retryError || !result) {
        if (retryError && isPerpProtectionCleanupPersistenceError(retryError)) {
          const retiredLegClientOrderIds = Array.isArray(retryError.retiredLegClientOrderIds)
            ? retryError.retiredLegClientOrderIds
            : [];
          const [persistError] = await catchError(
            this.recordPerpProtectionCleanup(
              retryError.state,
              this.db,
              retiredLegClientOrderIds,
            ),
          );
          if (persistError) {
            // The pre-submit plan is already durable and remains eligible for
            // the next bounded restart sweep; do not reopen the row or invent
            // a status transition while the marker database is unavailable.
            logger.warn(LOG_SERVICE, "[copy-mirror] typed perp protection cleanup state could not be retained", {
              orderId: row.id,
              error: persistError.message,
            });
          }
          if (!persistError) continue;
        }
        const [failureError] = await catchError(
          this.markPerpProtectionCleanupFailure(
            row,
            retryError && isPerpProtectionCleanupPersistenceError(retryError)
              ? retryError.state
              : claimedState,
            "venue-retry",
            retryError ?? new Error("cleanup result unavailable"),
            databaseNow,
            this.db,
            retryError && isPerpProtectionCleanupPersistenceError(retryError)
              ? retryError.retiredLegClientOrderIds
              : [],
          ),
        );
        if (failureError) {
          logger.warn(LOG_SERVICE, "[copy-mirror] cleanup retry failure could not be scheduled", {
            orderId: row.id,
            error: failureError.message,
          });
        }
        logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup retry failed", {
          orderId: row.id,
          error: retryError?.message ?? "cleanup result unavailable",
        });
        continue;
      }
      if (result.pending.length > 0) {
        // `recordPendingCleanup` above already persisted this exact pending
        // subset and released the claim in one write. Keep this branch purely
        // observational so a second write cannot resurrect a retired cloid or
        // race a newly claimed generation.
        logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup remains pending", {
          orderId: row.id,
          pending: result.pending.length,
          retired: result.retired,
        });
        continue;
      }
      const [clearError] = await catchError(this.clearPerpProtectionCleanup(claimedState));
      if (clearError) {
        logger.warn(LOG_SERVICE, "[copy-mirror] durable perp protection cleanup could not retire marker", {
          orderId: row.id,
          error: clearError.message,
        });
      }
    }
    if (malformedMarkerCount > 5) {
      logger.error(LOG_SERVICE, "[copy-mirror] additional malformed durable perp protection cleanup markers excluded", {
        count: malformedMarkerCount - 5,
      });
    }
  }

  /**
   * Say, once a cycle, how many mirrored perp positions were opened without the
   * exit their follow asked for.
   *
   * The same job the deferred-close backlog line does, for the same reason: the
   * failure is deliberately non-fatal (the position stays open rather than being
   * closed over an API blip), so without something counting it there is nothing
   * anywhere that says a follower is carrying leverage with no stop.
   *
   * BOUNDED BY AGE, unlike the close backlog. A deferred close drains: it either
   * places or expires. An unprotected open never does, because nothing retries
   * it and a signal-sourced position has no close coming, so an all-time count
   * would climb forever and the line would become noise nobody reads. A day is
   * the window in which an operator can still act on it.
   */
  private async emitUnprotectedPerpBacklog(now: Date): Promise<void> {
    // This sweep intentionally runs before the age-bounded operator line and
    // includes `cancelled`: a source close may win the opening-row CAS while
    // exact venue status is still catching up.
    await this.retryPerpProtectionCleanupBacklog();
    const [retireError] = await catchError(
      this.db
        .update(schema.orders)
        .set({ perpProtectionStatus: "cancelled", perpProtectionError: null })
        .where(
          and(
            eq(schema.orders.venue, "hyperliquid"),
            eq(schema.orders.assetType, "PERP"),
            eq(schema.orders.reduceOnly, false),
            eq(schema.orders.status, "CANCELLED"),
            eq(schema.orders.executedSizeDecimal, "0"),
            eq(schema.orders.perpProtectionStatus, "unprotected"),
          ),
        ),
    );
    if (retireError) {
      logger.warn(LOG_SERVICE, "[copy-mirror] stale zero-fill protection cleanup failed", {
        error: retireError.message,
      });
    }
    const [error, rows] = await catchError(
      this.db.query.orders.findMany({
        where: and(
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.perpProtectionStatus, "unprotected"),
          inArray(schema.orders.status, ["FILLED", "PARTIAL"]),
          gt(schema.orders.executedSizeDecimal, "0"),
          gt(schema.orders.createdAt, new Date(now.getTime() - UNPROTECTED_PERP_WINDOW_MS)),
        ),
        columns: { id: true, userId: true, symbol: true, createdAt: true, perpProtectionError: true },
        orderBy: [schema.orders.createdAt],
        limit: UNPROTECTED_PERP_SCAN_CAP + 1,
      }),
    );
    if (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] unprotected perp backlog unreadable", {
        error: error.message,
      });
      return;
    }
    if (rows.length === 0) return;
    const truncated = rows.length > UNPROTECTED_PERP_SCAN_CAP;
    const scanned = truncated ? rows.slice(0, UNPROTECTED_PERP_SCAN_CAP) : rows;
    const oldest = scanned[0];
    const alertKey = `${scanned.length}:${truncated}:${oldest?.id ?? ""}:${oldest?.perpProtectionError ?? ""}`;
    if (
      alertKey === this.lastUnprotectedPerpAlertKey &&
      now.getTime() - this.lastUnprotectedPerpAlertAt < UNPROTECTED_PERP_ALERT_INTERVAL_MS
    ) return;
    this.lastUnprotectedPerpAlertKey = alertKey;
    this.lastUnprotectedPerpAlertAt = now.getTime();
    logger.error(
      LOG_SERVICE,
      "[copy-mirror] mirrored perp positions opened in the last day carry no attached exit: each one is a follower holding leverage with the stop their follow asked for never placed",
      {
        unprotectedCount: scanned.length,
        scanTruncated: truncated,
        oldestOrderId: oldest?.id ?? null,
        oldestFollowerUserId: oldest?.userId ?? null,
        oldestCoin: oldest?.symbol?.slice(0, 24) ?? null,
        oldestAgeMs: oldest?.createdAt ? now.getTime() - oldest.createdAt.getTime() : null,
        oldestReason: oldest?.perpProtectionError ?? null,
      },
    );
  }

  /**
   * The database and venue work the extracted perp execution paths still need.
   *
   * Handed over as bound closures rather than reached for, so this poller keeps
   * owning its connection, its logger and its client while the execution paths
   * stay readable on their own.
   */
  private perpExecutionDeps(db: WorkerPoolDb = this.db): PerpMirrorExecutionDeps {
    return {
      perpDexModeReady: (client, walletAddress, ctx) =>
        this.perpDexModeReady(client, walletAddress, ctx),
      applyPerpLeverage: (client, params) => this.applyPerpLeverage(client, params),
      placePerpMirrorOrder: (client, params) => this.placePerpMirrorOrder(client, params, db),
      preparePerpMirrorOrder: (params) => this.preparePerpMirrorOrder(params, db),
      submitPerpMirrorOrder: (client, prepared) => this.submitPerpMirrorOrder(client, prepared, db),
      ensurePerpOpenLeverage: (prepared, maxLeverage) =>
        this.ensurePerpOpenLeverage(prepared, maxLeverage, db),
      // Finalization is deliberately bound to the root pool. It is called only
      // after the users-row policy transaction commits; binding it to the tx
      // handle would put the accepted venue order back in the rollback domain.
      finalizePerpMirrorOrder: (prepared, submission) =>
        this.finalizePerpMirrorOrder(prepared, submission, this.db),
      attachPerpProtection: async (client, params) => {
        await this.attachPerpProtection(client, params, db);
      },
      cancelPerpProtection: (client, params) => this.cancelPerpProtection(client, params, db),
      notePerpProtectionUnattached: (params, reason) =>
        this.notePerpProtectionUnattached(params, reason, db),
      recordResumeLeverageClamp: async (orderId, leverage, claimToken) => {
        // Guarded on status PENDING. The resume path re-clamps before the
        // position guard runs and before any placement, and in between the
        // reconciler may have learned this row is actually live at the venue
        // and moved it to SUBMITTED/PARTIAL/FILLED. Writing the clamped value
        // onto a live row would make the record disagree with the position the
        // follower is really carrying, and hyperliquid-order-sync then
        // propagates that number onward.
        //
        // The `returning` is load-bearing, not decoration. An UPDATE that
        // matches zero rows RESOLVES, it does not throw, so without checking
        // what came back this guard would report success on the exact case it
        // exists to catch and the caller would resume against a live position.
        // Zero rows means the row is no longer PENDING, which is not something
        // to write over and not something to resume: throwing routes it into
        // the caller's existing "unrecorded clamp is unprovable" refusal.
        const updated = await db
          .update(schema.orders)
          .set({ leverage })
          .where(
            and(
              eq(schema.orders.id, orderId),
              eq(schema.orders.assetType, "PERP"),
              eq(schema.orders.status, "PENDING"),
              isNull(schema.orders.brokerOrderId),
              ...(claimToken
                ? [eq(schema.orders.syncReason, perpPlacementLeaseReason(claimToken))]
                : []),
            ),
          )
          .returning({ id: schema.orders.id });
        if (updated.length !== 1) {
          throw new Error(
            `resume leverage clamp returned ${updated.length} rows; exactly one PENDING order is required`,
          );
        }
      },
      recordCloseAbsenceObservation: async (orderId, at) => {
        // Guarded on PENDING for the same reason the leverage clamp is: by the
        // time this writes, the reconciler may have learned the row is live at
        // the venue and moved it on, and a settled row has no absence streak to
        // keep. `returning` is what makes the guard real, since an UPDATE that
        // matches nothing resolves rather than throwing.
        const updated = await db
          .update(schema.orders)
          .set(
            at
              ? {
                  // COALESCE keeps the streak's start where it is, so a hold
                  // does not push the confirmation point forward on every poll.
                  // Both are computed in SQL rather than read-then-written, so
                  // two replicas observing the same row cannot lose a count
                  // between them.
                  closeAbsenceFirstSeenAt: sql`coalesce(${schema.orders.closeAbsenceFirstSeenAt}, ${at})`,
                  closeAbsenceObservations: sql`${schema.orders.closeAbsenceObservations} + 1`,
                }
              : { closeAbsenceFirstSeenAt: null, closeAbsenceObservations: 0 },
          )
          .where(
            and(
              eq(schema.orders.id, orderId),
              eq(schema.orders.status, "PENDING"),
            ),
          )
          .returning({ id: schema.orders.id });
        if (updated.length !== 1) {
          throw new Error(
            `close absence observation returned ${updated.length} rows; exactly one PENDING order is required`,
          );
        }
      },
      loadPerpCloseContext: (cand, position) => this.loadPerpCloseContext(cand, position, db),
      loadQueuedSiblingDeliveries: (cand) => this.loadQueuedSiblingDeliveries(cand, db),
      pairedOpenOutcomeAmbiguous: (cand) => this.pairedOpenOutcomeAmbiguous(cand, db),
      countMirrorsToday: (followerUserId, excludeOrderId) =>
        this.countMirrorsToday(followerUserId, excludeOrderId, db),
      countPerpDailySlots: (followerUserId, excludeOrderId) =>
        this.countPerpDailySlots(followerUserId, excludeOrderId, db),
      checkPerpCoinCap: (params) => this.checkPerpCoinCap(params, db),
    };
  }

  /**
   * Check a perp coin cap using the user-row lock held by the open policy
   * transaction. Unsettled open rows reserve their requested size; settled rows
   * contribute only their executed size. The prepared/resumed row is excluded
   * because its requested size is supplied separately by the caller.
   */
  private async checkPerpCoinCap(
    params: {
      followerUserId: string;
      symbol: string;
      brokerAccountId: string;
      brokerCredentialId: string;
      requestedSizeCoin: string;
      maxCoinSize: number;
      excludeOrderId?: string;
    },
    db: WorkerPoolDb,
  ): Promise<"allowed" | "coin-cap" | "unavailable"> {
    const cap = parsePositiveDecimal(String(params.maxCoinSize));
    const requested = parsePositiveDecimal(params.requestedSizeCoin);
    if (!cap || !requested) return "unavailable";
    try {
      const rows = await db.query.orders.findMany({
        where: and(
          eq(schema.orders.userId, params.followerUserId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.symbol, params.symbol),
          like(schema.orders.clientOrderId, `copymirror:${params.followerUserId}:%`),
          or(
            eq(schema.orders.venueNetwork, networkFromEnv()),
            isNull(schema.orders.venueNetwork),
          ),
        ),
        columns: {
          id: true,
          brokerAccountId: true,
          brokerCredentialId: true,
          reduceOnly: true,
          direction: true,
          status: true,
          quantityDecimal: true,
          executedSizeDecimal: true,
        },
      });
      const targetAccount = params.brokerAccountId.trim().toLowerCase();
      const targetCredential = params.brokerCredentialId.trim();
      const relevant = rows.filter((row) => {
        if (params.excludeOrderId && row.id === params.excludeOrderId) return false;
        const account = row.brokerAccountId?.trim().toLowerCase() ?? "";
        const credential = row.brokerCredentialId?.trim() ?? "";
        if (account !== "") return account === targetAccount;
        return credential === targetCredential;
      });
      const settled = new Set(["FILLED", "CANCELLED", "REJECTED", "EXPIRED"]);
      const exposureRows: Array<{ direction: string; executedSizeDecimal: string | null }> = [];
      for (const row of relevant) {
        const open = row.reduceOnly !== true;
        const size = open && !settled.has(row.status ?? "")
          ? row.quantityDecimal ?? row.executedSizeDecimal
          : row.executedSizeDecimal;
        if (!size) {
          if (open && !settled.has(row.status ?? "")) return "unavailable";
          continue;
        }
        const parsed = parsePositiveDecimal(size);
        if (!parsed) return "unavailable";
        // `direction` is the signed position effect recorded by the venue
        // payload. For reduce-only closes it is already the opposite side of
        // the position being reduced (a long close is `short`, a short close
        // is `long`); forcing every close to one side would over-count short
        // reductions and could reject a safe open forever.
        if (row.direction !== "long" && row.direction !== "short") return "unavailable";
        exposureRows.push({
          direction: row.direction,
          executedSizeDecimal: size,
        });
      }
      const current = signedPerpExposure(exposureRows);
      const currentSize = current ? parsePositiveDecimal(current.size) : null;
      if (current && !currentSize) return "unavailable";
      const scale = Math.max(cap.scale, requested.scale, currentSize?.scale ?? 0);
      const atScale = (value: { coefficient: bigint; scale: number }) =>
        value.coefficient * 10n ** BigInt(scale - value.scale);
      const total = atScale(requested) + (currentSize ? atScale(currentSize) : 0n);
      const capAtScale = atScale(cap);
      return total <= capAtScale ? "allowed" : "coin-cap";
    } catch (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] perp coin-cap exposure read failed", {
        followerUserId: params.followerUserId,
        symbol: params.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unavailable";
    }
  }


  /**
   * Read the follow row this delivery was staged from, fresh from the database.
   *
   * Returns null when the candidate carries no follow id (staged before the id
   * was recorded) so the caller's consent decision resolves to "unverifiable"
   * without a pointless query. A row that no longer exists also reads as null,
   * which is exactly what an unfollow looks like.
   */
  private async loadFollowRow(cand: MirrorSourceCandidate) {
    const followId = cand.followId?.trim() ?? "";
    if (followId === "") return null;
    const row = await this.db.query.copyTradeFollows.findFirst({
      where: and(
        eq(schema.copyTradeFollows.id, followId),
        eq(schema.copyTradeFollows.followerUserId, cand.followerUserId),
      ),
      columns: {
        id: true,
        followerUserId: true,
        autoMirror: true,
        credentialId: true,
        stockAutoMirror: true,
        stockCredentialId: true,
        stockSizingMode: true,
        stockSizingValue: true,
        maxTradeSize: true,
        maxCoinSize: true,
      },
    });
    if (!row) return null;
    const destination = readMirrorDestination(row, "stock", { legacyProvider: "alpaca" });
    return {
      id: row.id,
      followerUserId: row.followerUserId,
      autoMirror: destination.enabled,
      credentialId: destination.credentialId,
      maxTradeSize: row.maxTradeSize,
      maxCoinSize: row.maxCoinSize,
    };
  }

  private async loadPerpOpenAuthorization(
    cand: MirrorSourceCandidate,
    db: WorkerPoolDb = this.db,
    locked = false,
    preparedOrder?: {
      orderId: string;
      clientOrderId: string;
      claimToken: string;
      claimAt: Date;
    },
  ): Promise<PerpOpenAuthorization> {
    const read = async (readDb: WorkerPoolDb): Promise<PerpOpenAuthorization> => {
      if (locked) return this.loadLockedPerpOpenAuthorization(readDb, cand, preparedOrder);
      const credentialId = cand.credentialId?.trim() ?? "";
      const credential = credentialId
        ? await readDb.query.userApiCredentials.findFirst({
            where: and(
              eq(schema.userApiCredentials.id, credentialId),
              eq(schema.userApiCredentials.userId, cand.followerUserId),
              eq(schema.userApiCredentials.provider, "hyperliquid"),
            ),
            columns: { id: true, provider: true, accountType: true },
          })
        : undefined;
      const policy = await this.loadPerpFollowPolicyRow(readDb, cand);
      return { credential, ...policy };
    };
    try {
      return await read(db);
    } catch (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp leverage policy read failed", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        followId: cand.followId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        credential: undefined,
        follow: null,
        policyUnavailable: true,
      };
    }
  }

  /** A locked user policy row must contain an ordinary positive leverage cap. */
  private validPerpPolicyCap(value: unknown, nullable = false): boolean {
    if (nullable && (value === null || value === undefined)) return true;
    return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= COPY_PERP_MAX_LEVERAGE_MIN && value <= COPY_PERP_MAX_LEVERAGE_MAX;
  }

  /**
   * Read the exact owned perp policy after locking the user row.
   *
   * The separate selects are intentional: the user row is locked FIRST, then
   * the owned follow and credential rows. API policy mutations use the same
   * order, so a lowering cannot commit between this read and placement.
   */
  private async loadLockedPerpOpenAuthorization(
    db: WorkerPoolDb,
    cand: MirrorSourceCandidate,
    preparedOrder?: {
      orderId: string;
      clientOrderId: string;
      claimToken: string;
      claimAt: Date;
    },
  ): Promise<PerpOpenAuthorization> {
    const dbAny = db as any;
    const lockedRows = async <T>(
      projection: Record<string, unknown>,
      table: unknown,
      predicate: unknown,
      forUpdate = false,
    ): Promise<T[]> => {
      if (typeof dbAny.select !== "function") {
        throw new Error("transactional policy read is unavailable");
      }
      const selected = dbAny.select(projection);
      const from = selected && typeof selected.from === "function"
        ? selected.from(table)
        : null;
      const where = from && typeof from.where === "function"
        ? from.where(predicate)
        : null;
      if (!where) {
        throw new Error("transactional policy row lock is unavailable");
      }
      if (forUpdate) {
        if (typeof where.for !== "function") {
          throw new Error("transactional policy row lock is unavailable");
        }
        return await where.for("update") as T[];
      }
      return await where as T[];
    };

    const userRows = await lockedRows<{ id: string; copyPerpMaxLeverage: unknown }>(
      {
        id: schema.users.id,
        copyPerpMaxLeverage: schema.users.copyPerpMaxLeverage,
      },
      schema.users,
      eq(schema.users.id, cand.followerUserId),
      true,
    );
    const user = userRows[0];
    if (
      !user ||
      user.id !== cand.followerUserId ||
      !this.validPerpPolicyCap(user.copyPerpMaxLeverage)
    ) {
      return { credential: undefined, follow: null, policyUnavailable: true };
    }

    // Phase-A committed the exact idempotent intent before entering this
    // transaction. Lock that row after the users row and hold it through final
    // leverage application and venue submission. The reconciler's status CAS
    // (and its age/cancellation write) then waits for this critical section,
    // preventing an active resume from being canceled or resubmitted twice.
    if (preparedOrder) {
      const orderRows = await lockedRows<{
        id: string;
        clientOrderId: string | null;
        status: string;
        leverage: number | null;
      }>(
        {
          id: schema.orders.id,
          clientOrderId: schema.orders.clientOrderId,
          status: schema.orders.status,
          leverage: schema.orders.leverage,
        },
        schema.orders,
        and(
          eq(schema.orders.id, preparedOrder.orderId),
          eq(schema.orders.userId, cand.followerUserId),
          eq(schema.orders.clientOrderId, preparedOrder.clientOrderId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.status, "PENDING"),
          isNull(schema.orders.brokerOrderId),
          eq(schema.orders.syncReason, perpPlacementLeaseReason(preparedOrder.claimToken)),
          eq(schema.orders.lastSyncAttemptAt, preparedOrder.claimAt),
        ),
        true,
      );
      if (orderRows.length !== 1) {
        return { credential: undefined, follow: null, policyUnavailable: true };
      }
    }

    const followId = cand.followId?.trim() ?? "";
    if (followId === "") {
      return { credential: undefined, follow: null, policyUnavailable: true };
    }
    const followRows = await lockedRows<{
      id: string;
      followerUserId: string;
      autoMirror: boolean;
      credentialId: string | null;
      perpAutoMirror?: boolean;
      perpCredentialId?: string | null;
      perpSizingMode?: string;
      perpSizingValue?: string;
      perpMaxLeverage: unknown;
      maxTradeSize: unknown;
      maxCoinSize: unknown;
      perpTakeProfitPct?: string | null;
      perpStopLossPct?: string | null;
    }>(
      {
        id: schema.copyTradeFollows.id,
        followerUserId: schema.copyTradeFollows.followerUserId,
        autoMirror: schema.copyTradeFollows.autoMirror,
        credentialId: schema.copyTradeFollows.credentialId,
        perpAutoMirror: schema.copyTradeFollows.perpAutoMirror,
        perpCredentialId: schema.copyTradeFollows.perpCredentialId,
        perpSizingMode: schema.copyTradeFollows.perpSizingMode,
        perpSizingValue: schema.copyTradeFollows.perpSizingValue,
        perpMaxLeverage: schema.copyTradeFollows.perpMaxLeverage,
        maxTradeSize: schema.copyTradeFollows.maxTradeSize,
        maxCoinSize: schema.copyTradeFollows.maxCoinSize,
        perpTakeProfitPct: schema.copyTradeFollows.perpTakeProfitPct,
        perpStopLossPct: schema.copyTradeFollows.perpStopLossPct,
      },
      schema.copyTradeFollows,
      and(
        eq(schema.copyTradeFollows.id, followId),
        eq(schema.copyTradeFollows.followerUserId, cand.followerUserId),
      ),
    );
    const rawFollow = followRows[0];
    if (!rawFollow) {
      return { credential: undefined, follow: null, policyUnavailable: false };
    }
    const destination = readMirrorDestination(rawFollow, "perp", { legacyProvider: "hyperliquid" });
    const follow = this.mapPerpOpenFollowPolicyRow({
      ...rawFollow,
      autoMirror: destination.enabled,
      credentialId: destination.credentialId,
      currentUserMaxLeverage: user.copyPerpMaxLeverage,
      currentFollowMaxLeverage: rawFollow.perpMaxLeverage ?? null,
      currentMaxTradeSize: rawFollow.maxTradeSize ?? null,
      currentMaxCoinSize: rawFollow.maxCoinSize ?? null,
    });
    if (
      !follow ||
      follow.id !== followId ||
      follow.followerUserId !== cand.followerUserId ||
      !this.validPerpPolicyCap(follow.currentUserMaxLeverage) ||
      !this.validPerpPolicyCap(follow.currentFollowMaxLeverage, true)
    ) {
      return { credential: undefined, follow: null, policyUnavailable: true };
    }

    const credentialId = cand.credentialId?.trim() ?? "";
    if (credentialId === "") {
      return { credential: undefined, follow, policyUnavailable: true };
    }
    const credentialRows = await lockedRows<{
      id: string;
      provider: string;
      accountType: string | null;
    }>(
      {
        id: schema.userApiCredentials.id,
        provider: schema.userApiCredentials.provider,
        accountType: schema.userApiCredentials.accountType,
      },
      schema.userApiCredentials,
      and(
        eq(schema.userApiCredentials.id, credentialId),
        eq(schema.userApiCredentials.userId, cand.followerUserId),
        eq(schema.userApiCredentials.provider, "hyperliquid"),
        eq(schema.userApiCredentials.accountType, "LIVE"),
      ),
    );
    const credential = credentialRows[0];
    if (
      !credential ||
      credential.id !== credentialId ||
      credential.provider !== "hyperliquid" ||
      credential.accountType !== "LIVE"
    ) {
      return { credential: undefined, follow, policyUnavailable: true };
    }
    return { credential, follow, policyUnavailable: false };
  }

  /**
   * Run final open leverage resolution and venue writes under the policy lock.
   * If lightweight tests provide no transaction, the same exact policy is read
   * without a lock for compatibility; production WorkerPoolDb always supports
   * transactions.
   */
  private async withLockedPerpOpenPolicy<T>(
    cand: MirrorSourceCandidate,
    expectedCredentialId: string,
    callback: (resolution: PerpOpenPolicyResolution) => Promise<T>,
    fallbackFollow: PerpOpenFollowPolicyRow | null,
    preparedOrder?: {
      orderId: string;
      clientOrderId: string;
      claimToken: string;
      claimAt: Date;
    },
  ): Promise<T> {
    const resolve = async (db: WorkerPoolDb, locked: boolean): Promise<T> => {
      const authorization = await this.loadPerpOpenAuthorization(cand, db, locked, preparedOrder);
      if (
        authorization.policyUnavailable ||
        !authorization.follow ||
        !authorization.credential ||
        authorization.credential.id !== expectedCredentialId ||
        authorization.follow.id !== (cand.followId?.trim() ?? "") ||
        authorization.follow.followerUserId !== cand.followerUserId ||
        authorization.follow.credentialId !== expectedCredentialId
      ) {
        return callback({ refusal: "leverage-policy-unavailable" });
      }
      const consent = decidePerpMirrorConsent({
        reduceOnly: false,
        followerUserId: cand.followerUserId,
        followId: cand.followId,
        credentialId: expectedCredentialId,
        follow: authorization.follow,
      });
      if (consent.action === "skip") return callback({ refusal: consent.reason });
      // Build the signing client only after the exact credential row has been
      // reread under the users-row lock. Credential replacement mutates the
      // agent wallet material in place; constructing the client before this
      // point would let a worker validate one row and submit with a stale
      // wallet after the replacement commits.
      let lockedClient: HyperliquidClient;
      let lockedWalletAddress: `0x${string}`;
      try {
        const created = await this.createPerpClient(
          db as never,
          cand.followerUserId,
          { credentialId: expectedCredentialId },
        );
        lockedClient = created.client;
        lockedWalletAddress = created.walletAddress;
      } catch (error) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp client rebuild under policy lock failed", {
          followerUserId: cand.followerUserId,
          sourceItemId: cand.sourceItemId,
          error: error instanceof Error ? error.message : String(error),
        });
        return callback({ refusal: "leverage-policy-unavailable" });
      }
      return callback({
        policy: {
          currentUserMaxLeverage: authorization.follow.currentUserMaxLeverage,
          currentFollowMaxLeverage: authorization.follow.currentFollowMaxLeverage,
          currentMaxTradeSize: authorization.follow.currentMaxTradeSize,
          currentMaxCoinSize: authorization.follow.currentMaxCoinSize,
        },
        executionDeps: this.perpExecutionDeps(db),
        client: lockedClient,
        walletAddress: lockedWalletAddress,
      });
    };

    const dbWithTransaction = this.db as WorkerPoolDb & {
      transaction?: <R>(callback: (tx: WorkerPoolDb) => Promise<R>) => Promise<R>;
    };
    if (typeof dbWithTransaction.transaction === "function") {
      return dbWithTransaction.transaction((tx) => resolve(tx, true));
    }

    // Existing unit-test DBs predate the transaction interface. Reuse the
    // already-read policy when no fluent lock is available, while production
    // remains fail-closed inside the strict transactional branch above.
    if (!fallbackFollow) return callback({ refusal: "leverage-policy-unavailable" });
    const direct = await resolve(this.db, false);
    return direct;
  }

  private async loadPerpFollowPolicyRow(
    db: WorkerPoolDb,
    cand: MirrorSourceCandidate,
  ): Promise<{
    follow: PerpOpenFollowPolicyRow | null;
    policyUnavailable: boolean;
  }> {
    const followId = cand.followId?.trim() ?? "";
    if (followId === "") {
      return { follow: null, policyUnavailable: true };
    }

    const projection = {
      id: schema.copyTradeFollows.id,
      followerUserId: schema.copyTradeFollows.followerUserId,
      autoMirror: schema.copyTradeFollows.autoMirror,
      credentialId: schema.copyTradeFollows.credentialId,
      perpAutoMirror: schema.copyTradeFollows.perpAutoMirror,
      perpCredentialId: schema.copyTradeFollows.perpCredentialId,
      perpSizingMode: schema.copyTradeFollows.perpSizingMode,
      perpSizingValue: schema.copyTradeFollows.perpSizingValue,
      currentUserMaxLeverage: schema.users.copyPerpMaxLeverage,
      currentFollowMaxLeverage: schema.copyTradeFollows.perpMaxLeverage,
      currentMaxTradeSize: schema.copyTradeFollows.maxTradeSize,
      currentMaxCoinSize: schema.copyTradeFollows.maxCoinSize,
      perpTakeProfitPct: schema.copyTradeFollows.perpTakeProfitPct,
      perpStopLossPct: schema.copyTradeFollows.perpStopLossPct,
    };
    const selected = typeof (db as any).select === "function"
      ? (db as any).select(projection)
      : null;
    const from = selected && typeof selected.from === "function"
      ? selected.from(schema.copyTradeFollows)
      : null;

    // Lightweight worker unit-test DBs expose relational query readers but not
    // Drizzle's fluent join builder. Keep the production read above the
    // fallback while retaining the same ownership and policy validation.
    if (!from || typeof from.innerJoin !== "function") {
      return this.loadPerpFollowPolicyRowFallback(db, cand, followId);
    }

    const rows = await from
      .innerJoin(
        schema.users,
        eq(schema.users.id, schema.copyTradeFollows.followerUserId),
      )
      .where(
        and(
          eq(schema.copyTradeFollows.id, followId),
          eq(schema.copyTradeFollows.followerUserId, cand.followerUserId),
        ),
      )
      .limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return { follow: null, policyUnavailable: false };

    const destination = readMirrorDestination(row, "perp", { legacyProvider: "hyperliquid" });
    const follow = this.mapPerpOpenFollowPolicyRow({
      ...row,
      autoMirror: destination.enabled,
      credentialId: destination.credentialId,
    });
    if (
      !follow ||
      follow.id !== followId ||
      follow.followerUserId !== cand.followerUserId
    ) {
      return { follow: null, policyUnavailable: true };
    }
    if (!Object.prototype.hasOwnProperty.call(row, "currentUserMaxLeverage")) {
      return { follow, policyUnavailable: true };
    }
    return { follow, policyUnavailable: false };
  }

  private async loadPerpFollowPolicyRowFallback(
    db: WorkerPoolDb,
    cand: MirrorSourceCandidate,
    followId: string,
  ): Promise<{
    follow: PerpOpenFollowPolicyRow | null;
    policyUnavailable: boolean;
  }> {
    const queryDb = db as any;
    const findFollow = queryDb.query?.copyTradeFollows?.findFirst;
    if (typeof findFollow !== "function") {
      return { follow: null, policyUnavailable: true };
    }
    const rawFollow = await findFollow.call(queryDb.query.copyTradeFollows, {
      where: and(
        eq(schema.copyTradeFollows.id, followId),
        eq(schema.copyTradeFollows.followerUserId, cand.followerUserId),
      ),
      columns: {
        id: true,
        followerUserId: true,
        autoMirror: true,
        credentialId: true,
        perpAutoMirror: true,
        perpCredentialId: true,
        perpSizingMode: true,
        perpSizingValue: true,
        perpMaxLeverage: true,
        maxTradeSize: true,
        maxCoinSize: true,
        perpTakeProfitPct: true,
        perpStopLossPct: true,
        copyPerpMaxLeverage: true,
      },
    });
    if (!rawFollow) return { follow: null, policyUnavailable: false };

    const destination = readMirrorDestination(rawFollow, "perp", { legacyProvider: "hyperliquid" });
    const follow = this.mapPerpOpenFollowPolicyRow({
      ...rawFollow,
      autoMirror: destination.enabled,
      credentialId: destination.credentialId,
      currentFollowMaxLeverage: rawFollow.perpMaxLeverage ?? null,
      currentMaxTradeSize: rawFollow.maxTradeSize ?? null,
      currentMaxCoinSize: rawFollow.maxCoinSize ?? null,
      currentUserMaxLeverage: rawFollow.copyPerpMaxLeverage,
    });
    if (
      !follow ||
      follow.id !== followId ||
      follow.followerUserId !== cand.followerUserId
    ) {
      return { follow: null, policyUnavailable: true };
    }
    if (Object.prototype.hasOwnProperty.call(rawFollow, "copyPerpMaxLeverage")) {
      return { follow, policyUnavailable: false };
    }

    const findUser = queryDb.query?.users?.findFirst;
    if (typeof findUser !== "function") {
      return { follow, policyUnavailable: true };
    }
    const user = await findUser.call(queryDb.query.users, {
      where: eq(schema.users.id, cand.followerUserId),
      columns: { copyPerpMaxLeverage: true },
    });
    if (!user || !Object.prototype.hasOwnProperty.call(user, "copyPerpMaxLeverage")) {
      return { follow, policyUnavailable: true };
    }
    return {
      follow: { ...follow, currentUserMaxLeverage: user.copyPerpMaxLeverage },
      policyUnavailable: false,
    };
  }

  private mapPerpOpenFollowPolicyRow(
    row: Record<string, unknown>,
  ): PerpOpenFollowPolicyRow | null {
    if (
      typeof row.id !== "string" ||
      typeof row.followerUserId !== "string" ||
      typeof row.autoMirror !== "boolean" ||
      (row.credentialId !== null && typeof row.credentialId !== "string")
    ) {
      return null;
    }
    return {
      id: row.id,
      followerUserId: row.followerUserId,
      autoMirror: row.autoMirror,
      credentialId: row.credentialId as string | null,
      currentUserMaxLeverage: row.currentUserMaxLeverage,
      currentFollowMaxLeverage: row.currentFollowMaxLeverage ?? null,
      currentMaxTradeSize: row.currentMaxTradeSize ?? row.maxTradeSize ?? null,
      currentMaxCoinSize: row.currentMaxCoinSize ?? row.maxCoinSize ?? null,
      protectionRule: parsePerpProtectionRule({
        perpTakeProfitPct: row.perpTakeProfitPct as string | null | undefined,
        perpStopLossPct: row.perpStopLossPct as string | null | undefined,
      }),
    };
  }

  /**
   * This follower's deliveries that are still queued, read at close time.
   *
   * Only "pending" rows are returned, which is exactly the set that can still
   * place an order: a delivery that failed earlier in this same drain is back in
   * it, and one that already completed (placed OR skipped) is not. Bounded by a
   * named cap, per audit H6.
   */
  /**
   * Does this follower have a mirrored OPEN in this coin that has not settled?
   *
   * An unsettled open may already hold a position the venue has not reported
   * yet, so a close arriving in that window must not be consumed against a stale
   * "no position": nothing would ever exit that exposure afterwards.
   *
   * ASKED OF THE ORDERS, not of the deliveries. This used to scan completed
   * deliveries whose outcome was "placed" or "syncing" and then check the orders
   * they produced. That scan was follower-wide and all-time, and those rows never
   * drain, so past its cap it saturated permanently and every later close for
   * that follower held forever: a wedge dressed as a safety guard.
   *
   * Unresolved orders are the thing actually being asked about, they are a small
   * and naturally draining set, and the query is narrowed to one coin. A delivery
   * outcome is a permanent property of a row and was never the right place to
   * read a current state from.
   *
   * A re-entry the source made AFTER this close is no longer excluded, so an
   * unsettled one holds the close too. That is over-holding rather than a wrong
   * answer, and it clears by itself once the order settles, unlike the saturation
   * it replaces.
   */
  private async pairedOpenOutcomeAmbiguous(
    cand: MirrorSourceCandidate,
    db: WorkerPoolDb = this.db,
  ): Promise<boolean> {
    const unsettled = await db.query.orders.findFirst({
      where: and(
        eq(schema.orders.userId, cand.followerUserId),
        eq(schema.orders.venue, "hyperliquid"),
        eq(schema.orders.assetType, "PERP"),
        eq(schema.orders.symbol, cand.symbol),
        like(schema.orders.clientOrderId, `copymirror:${cand.followerUserId}:%`),
        ne(schema.orders.reduceOnly, true),
        inArray(schema.orders.status, ["PENDING", "SUBMITTED", "PARTIAL"]),
        // Proven network only, like the close-attribution queries and unlike the
        // reconciler.
        //
        // A row on another network is not reconciled while this one is
        // configured, so it can never settle and would hold every close here
        // forever. An UNPROVEN row is worse: since a null network can no longer
        // be cancelled from absence, such a row can stay PENDING permanently and
        // block every future close for this follower and coin on BOTH networks.
        //
        // Excluding them costs the guard its ability to notice a genuinely
        // unsettled legacy open, so a close could be consumed against a stale
        // "no position". Both outcomes leave exposure open, but that one spends
        // a single exit while the wedge blocks every exit from now on, so it is
        // the smaller failure. Nothing is affected in practice: perps
        // auto-mirror has never run in production, so no legacy mirrored perp
        // opens exist.
        eq(schema.orders.venueNetwork, networkFromEnv()),
      ),
      columns: { id: true },
    });
    return unsettled !== undefined;
  }

  private async loadQueuedSiblingDeliveries(
    cand: MirrorSourceCandidate,
    db: WorkerPoolDb = this.db,
  ): Promise<{ rows: QueuedDeliveryRow[]; truncated: boolean }> {
    // Ordered so the cap truncates the OLDEST-irrelevant end deterministically
    // rather than an arbitrary one, and read one row past the cap so a
    // saturated queue is detectable instead of silently looking empty.
    const rows = await db.query.copyMirrorDeliveries.findMany({
      where: and(
        eq(schema.copyMirrorDeliveries.status, "pending"),
        eq(schema.copyMirrorDeliveries.followerUserId, cand.followerUserId),
      ),
      columns: { sourceItemId: true, followerUserId: true, candidate: true },
      orderBy: [desc(schema.copyMirrorDeliveries.createdAt), desc(schema.copyMirrorDeliveries.id)],
      limit: SIBLING_DELIVERY_SCAN_CAP + 1,
    });
    return {
      // A saturated queue means the scan cannot prove a sibling open is
      // absent. The guard exists to stop a close being consumed for nothing,
      // so an incomplete scan must hold the close back, not release it.
      truncated: rows.length > SIBLING_DELIVERY_SCAN_CAP,
      rows: rows.slice(0, SIBLING_DELIVERY_SCAN_CAP).map((row) => ({
        sourceItemId: row.sourceItemId,
        followerUserId: row.followerUserId,
        candidate: row.candidate,
      })),
    };
  }

  /**
   * Refuse to SPEND an equity or option close that found nothing to reduce
   * while the open it belongs to is still queued.
   *
   * `executePerpCloseMirror` has asked this since `copy-mirror-close-pairing.ts`
   * was written; the Alpaca path never did, and it is the same queue with the
   * same one-shot instruction on it. A source that buys 200 MSFT and sells them
   * twenty seconds later stages both in one window,
   * `orderCandidatesBySourceEvent` correctly ranks the buy first, and then the
   * buy's `createOrder` throws a transient 503. That delivery is requeued, but
   * the sell is next in the SAME in-memory batch: the follower holds nothing
   * yet, so `decideSellMirrorQty` skips with "no-long-position", the returned
   * outcome marks the delivery completed and it is never retried. Thirty
   * seconds later the buy's retry succeeds and the follower is long 200 MSFT in
   * a trade the source is already out of, with the only mirrored exit spent.
   * Every delivery in that sequence reports success.
   *
   * Deferring places NO order. It costs the delivery one attempt and a retry,
   * and it clears by itself: once the queued open settles (placed, skipped or
   * failed permanently) it leaves the pending set, the close finds no sibling on
   * a later pass and completes normally. Unlike a reduce-only perp close an
   * equity close is not exempt from the attempt ceiling, so an open that never
   * settles ends this delivery in `permanent_failure` with the error below on
   * it, which an operator can reconcile, rather than in a "success" that never
   * placed anything.
   *
   * Silent for every other skip: a close refused for a reason that is not "the
   * exposure is not there" has nothing to wait for.
   */
  private async holdEquityCloseIfPairedOpenQueued(
    cand: MirrorSourceCandidate,
    skipReason: MirrorProcessOutcome,
    audit: Record<string, unknown>,
    /**
     * Is there a mirrored OPEN for this symbol whose delivery already
     * COMPLETED (so it is gone from the pending-deliveries scan below) but
     * whose broker order has not settled yet? Callers pass
     * `exposure?.hasUnsettledOpen`, read fresh from the orders table
     * (`mirroredEquityExposure`), which is exactly the equity counterpart of
     * the perp guard's `pairedOpenOutcomeAmbiguous`: a mirrored BUY that was
     * accepted by the broker moves its DELIVERY to "completed" the moment
     * `processCandidate` returns "placed", long before the reconciler turns
     * it into a filled position, so the sibling-deliveries scan below cannot
     * see it. Without this a same-window buy-then-sell spends the exit: the
     * buy is accepted and its delivery completes, the sell runs a few hundred
     * milliseconds later in the same in-memory batch, finds no live long and
     * no queued sibling, and is consumed as if the position never existed.
     */
    openOutcomeAmbiguous: boolean,
  ): Promise<void> {
    if (!closeFoundNoExposure(skipReason)) return;

    const sibling = await this.loadQueuedSiblingDeliveries(cand);
    const consumption = decidePerpCloseConsumption({
      close: {
        sourceItemId: cand.sourceItemId,
        followerUserId: cand.followerUserId,
        symbol: cand.symbol,
        assetType: cand.assetType,
        ...(cand.sourceEventAt ? { sourceEventAt: cand.sourceEventAt } : {}),
        side: cand.side,
      },
      closeSkipReason: skipReason,
      pendingDeliveries: sibling.rows,
      pendingScanTruncated: sibling.truncated,
      openOutcomeAmbiguous,
    });
    if (consumption.action !== "defer") return;

    logger.warn(LOG_SERVICE, "[copy-mirror] equity close deferred rather than consumed", {
      ...audit,
      deferReason: consumption.reason,
      closeReason: skipReason,
      blockedBy: consumption.blockedBy.slice(0, 5),
    });
    // Thrown rather than returned so the delivery is requeued instead of
    // completed. Nothing was placed, and the close survives to a cycle where
    // the position it exits may actually exist. EAGAIN classifies as transient,
    // exactly as the other equity close hold-backs in this file do.
    throw Object.assign(
      new Error("equity close held back: a paired open is still queued"),
      { code: "EAGAIN" },
    );
  }

  /**
   * Is the follower's Hyperliquid account already in a mode that can trade this
   * market? Reads the mode; never changes it.
   *
   * Main-DEX coins need nothing. A HIP-3 market needs unified / shared
   * collateral, and switching an account into it is a permanent, account-wide
   * change to the follower's collateral and to the balance every later mirror is
   * sized against. That is not a decision a background worker gets to make on
   * someone's behalf, so an unmigrated account is skipped and told to migrate.
   */
  private async perpDexModeReady(
    client: HyperliquidClient,
    walletAddress: `0x${string}`,
    ctx: { followerUserId: string; sourceItemId: string; coin: string },
  ): Promise<boolean> {
    if (!requiresDexAbstraction(ctx.coin)) return true;

    const mode = await client.userAbstraction(walletAddress);
    if (isDexAbstractionReady(mode)) return true;

    logger.warn(
      LOG_SERVICE,
      "[copy-mirror] skip perp: follower must enable unified account themselves; the mirror will not migrate it",
      {
        followerUserId: ctx.followerUserId,
        sourceItemId: ctx.sourceItemId,
        coin: ctx.coin,
        accountAbstraction: mode,
      },
    );
    return false;
  }

  /**
   * What the mirror still holds for this follower in this stock or contract,
   * and which of their Alpaca accounts is holding it.
   *
   * A mirrored SELL used to be bounded by nothing but the destination account's
   * total long, which is every share the account holds however it was acquired.
   * The follower's own hand-bought position was therefore fair game for any
   * close the source published, and the exit was sent to whatever account the
   * follow points at NOW rather than to the one that received the open. This
   * read is what answers both questions, and it is the equity counterpart of
   * `mirroredExposureCredentialId` plus `mirroredExposureSizeDecimal` on the
   * perp path.
   *
   * ONLY the mirror's own orders are read (the deterministic client-order-id
   * prefix), so the follower's own trading in the symbol never enters the
   * ceiling, and exits are netted against opens so a position the mirror opened
   * and has already closed does not stay attributable forever.
   *
   * `venue` is deliberately NOT filtered on. It defaults to "alpaca" but is null
   * on rows written before the column existed, and dropping those would
   * under-read a real mirrored open and refuse the exit that belongs to it. The
   * asset-type filter already excludes perps, which are the only other venue.
   */
  private async mirroredEquityExposure(cand: MirrorSourceCandidate): Promise<{
    /** Shares attributable to the mirror on the single account holding them. */
    qty: number;
    /** Where to send the exit, or null when no open on file names an account. */
    credentialId: string | null;
    accounts: string[];
    /** Set when the reading cannot be trusted; the caller holds the close. */
    unanswerable:
      | null
      | "spans-accounts"
      | "scan-saturated"
      | "missing-source-metadata"
      | "source-attribution-unavailable"
      | "source-attribution-saturated"
      | "source-history-unavailable"
      | "source-quantity-unavailable"
      | "source-history-saturated"
      | "proportional-size-unavailable";
    /** Filled source close and source position before it, for non-ratio exits. */
    sourceCloseQty: number | null;
    sourcePositionQty: number | null;
    /**
     * A mirrored OPEN for this symbol is still working (PENDING/SYNCING/
     * SUBMITTED/PARTIAL). `qty` only counts what has actually filled, so this
     * flags that `qty` may UNDER-read a fill that already happened at the
     * broker and simply has not been reconciled into that row yet. The
     * caller consults this only where an under-read could wrongly complete a
     * close as unattributed (alpaca-13); it is not itself a reason to hold.
     */
    hasUnsettledOpen: boolean;
  }> {
    const rows = await this.db.query.orders.findMany({
      where: and(
        eq(schema.orders.userId, cand.followerUserId),
        eq(schema.orders.assetType, cand.assetType),
        eq(schema.orders.symbol, cand.symbol),
        like(schema.orders.clientOrderId, `copymirror:${cand.followerUserId}:%`),
      ),
      columns: {
        tradeAction: true,
        status: true,
        quantity: true,
        executedQuantity: true,
        clientOrderId: true,
        brokerAccountId: true,
        brokerCredentialId: true,
        optionExpiration: true,
        optionStrike: true,
        optionType: true,
        createdAt: true,
        executedAt: true,
      },
      orderBy: [desc(schema.orders.createdAt)],
      limit: MIRROR_HISTORY_SCAN_CAP + 1,
    });

    // A truncated history nets to a number that is wrong in an unknown
    // direction, and the caller would spend a one-shot exit on it. Hold instead.
    if (rows.length > MIRROR_HISTORY_SCAN_CAP) {
      return {
        qty: 0,
        credentialId: null,
        accounts: [],
        unanswerable: "scan-saturated",
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen: false,
      };
    }

    // OPTION rows carry the UNDERLYING in `symbol`, so the contract has to be
    // matched too or a mirrored $300 call would license selling the follower's
    // own $250 calls. Filtered in memory rather than in SQL because the strike
    // is a decimal string there and a numeric string comparison ("250" against
    // "250.0000") is exactly the kind of silent mismatch that would read a live
    // position as absent.
    const relevant = cand.assetType !== "OPTION"
      ? rows
      : rows.filter(
          (row) =>
            (row.optionExpiration ?? null) === (cand.optionExpiration ?? null) &&
            (row.optionType ?? null) === (cand.optionType ?? null) &&
            Number(row.optionStrike) === Number(cand.optionStrike),
        );

    // The label on a follow is presentation data and can change independently
    // of the source. A mirror row's logical key is the durable attribution
    // boundary: `user:<social-trade-id>` can be joined back to its source user,
    // while `x_signal:<id>` can only be attributed to that exact signal. Any
    // other suffix is legacy/ambiguous and cannot safely fund this close.
    const userSourceIds = new Set<string>();
    const candidateSourceId = cand.sourceItemId.startsWith("user:")
      ? cand.sourceItemId.slice("user:".length)
      : null;
    // With no mirrored rows there is no exposure to sell, so a legacy close can
    // still resolve to the terminal no-exposure outcome without an attribution
    // lookup. Once any mirror row exists, the candidate source itself is part of
    // the identity proof below.
    if (candidateSourceId && relevant.length > 0) userSourceIds.add(candidateSourceId);
    const mirrorPrefix = `copymirror:${cand.followerUserId}:`;
    for (const row of relevant) {
      const clientOrderId = row.clientOrderId;
      if (!clientOrderId?.startsWith(mirrorPrefix)) {
        return {
          qty: 0,
          credentialId: null,
          accounts: [],
          unanswerable: "source-attribution-unavailable",
          sourceCloseQty: null,
          sourcePositionQty: null,
          hasUnsettledOpen: false,
        };
      }
      const sourceItemId = clientOrderId.slice(mirrorPrefix.length);
      if (sourceItemId.startsWith("user:")) {
        userSourceIds.add(sourceItemId.slice("user:".length));
      }
    }

    const sourceSocialTrades = userSourceIds.size === 0
      ? []
      : await this.db.query.socialTrades.findMany({
          where: inArray(schema.socialTrades.id, [...userSourceIds]),
          columns: { id: true, userId: true, symbol: true, assetType: true, orderId: true },
          limit: EQUITY_SOURCE_HISTORY_SCAN_CAP + 1,
        });
    if (sourceSocialTrades.length > EQUITY_SOURCE_HISTORY_SCAN_CAP) {
      return {
        qty: 0,
        credentialId: null,
        accounts: [],
        unanswerable: "source-attribution-saturated",
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen: false,
      };
    }
    const sourceSocialById = new Map(
      sourceSocialTrades.flatMap((row) =>
        typeof row?.id === "string" ? [[row.id, row] as const] : []
      ),
    );
    const sourceOrderIdentities = await loadEquitySourceOrderIdentities(
      this.db,
      [cand.sourceOrderId, ...sourceSocialTrades.map((trade) => trade.orderId)],
    );
    if (sourceOrderIdentities.saturated) {
      return {
        qty: 0,
        credentialId: null,
        accounts: [],
        unanswerable: "source-attribution-saturated",
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen: false,
      };
    }
    const sourceOrderById = new Map(
      sourceOrderIdentities.rows.map((order) => [order.id, order] as const),
    );
    const candidateSourceSocial = candidateSourceId
      ? sourceSocialById.get(candidateSourceId)
      : undefined;
    const candidateSourceUserId = cand.sourceUserId ?? candidateSourceSocial?.userId;
    const sourceOrderMatchesCandidate = (
      order: typeof sourceOrderIdentities.rows[number],
      sourceUserId: string | null | undefined,
    ) =>
      order.userId === sourceUserId &&
      order.symbol.toUpperCase() === cand.symbol.toUpperCase() &&
      order.assetType === cand.assetType &&
      (!order.venue || order.venue.toLowerCase() === "alpaca") &&
      (cand.assetType !== "OPTION" || (
        (order.optionExpiration ?? null) === (cand.optionExpiration ?? null) &&
        (order.optionType ?? null) === (cand.optionType ?? null) &&
        Number(order.optionStrike) === Number(cand.optionStrike)
      ));
    const sourceOrderMatchesSocial = (
      trade: (typeof sourceSocialTrades)[number],
      order: typeof sourceOrderIdentities.rows[number] | undefined,
    ) => Boolean(
      order &&
      order.userId === trade.userId &&
      order.symbol.toUpperCase() === String(trade.symbol ?? "").toUpperCase() &&
      (!trade.assetType || order.assetType === trade.assetType) &&
      sourceOrderMatchesCandidate(order, candidateSourceUserId),
    );
    const candidateSourceOrder = candidateSourceSocial?.orderId
      ? sourceOrderById.get(candidateSourceSocial.orderId)
      : undefined;
    const candidateSourceAccount = candidateSourceOrder?.brokerAccountId?.trim().toLowerCase() || null;
    const candidateSourceMetadata = candidateSourceId && relevant.length > 0
      ? resolveEquitySourceCloseMetadata(
          {
            sourceUserId: cand.sourceUserId,
            sourceOrderId: cand.sourceOrderId,
            sourceOrderCreatedAt: cand.sourceOrderCreatedAt,
          },
          candidateSourceSocial,
          candidateSourceOrder,
        )
      : null;
    if (
      candidateSourceId &&
      relevant.length > 0 &&
      (
        !candidateSourceMetadata ||
        !candidateSourceSocial ||
        !candidateSourceOrder ||
        !candidateSourceAccount ||
        !sourceOrderMatchesSocial(candidateSourceSocial, candidateSourceOrder)
      )
    ) {
      return {
        qty: 0,
        credentialId: null,
        accounts: [],
        unanswerable: "source-attribution-unavailable",
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen: false,
      };
    }

    const attributedSourceUserId = candidateSourceMetadata?.sourceUserId ?? candidateSourceUserId;

    const isXSignalCandidate = cand.sourceItemId.startsWith("x_signal:");
    const xSourceItemIds = relevant
      .map((row) => row.clientOrderId!.slice(mirrorPrefix.length))
      .filter((sourceItemId) => sourceItemId.startsWith("x_signal:"));
    const xIdentityReadAvailable =
      typeof this.db.query?.signals?.findMany === "function" &&
      typeof this.db.query?.copyMirrorDeliveries?.findMany === "function";
    const xAttribution =
      isXSignalCandidate && xSourceItemIds.length > 0 && xIdentityReadAvailable
        ? await this.readXOptionAttribution(cand, [cand.sourceItemId, ...xSourceItemIds])
        : null;
    if (xAttribution?.reason) {
      return {
        qty: 0,
        credentialId: null,
        accounts: [],
        unanswerable: xAttribution.reason,
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen: false,
      };
    }
    const sourceCloseCutoff = candidateSourceOrder
      ? equitySourceOrderFillAt(candidateSourceOrder)
      : null;

    const attributed = relevant.filter((row) => {
      const clientOrderId = row.clientOrderId!;
      const sourceItemId = clientOrderId.slice(mirrorPrefix.length);
      if (sourceItemId.startsWith("x_signal:")) {
        if (!isXSignalCandidate) return false;
        return xAttribution
          ? xAttribution.attributedSourceItemIds.has(sourceItemId)
          : sourceItemId === cand.sourceItemId;
      }
      if (isXSignalCandidate || !sourceItemId.startsWith("user:") || !attributedSourceUserId) return false;
      const sourceSocial = sourceSocialById.get(sourceItemId.slice("user:".length));
      if (!sourceSocial) return false;
      if (sourceSocial.userId !== attributedSourceUserId) return false;
      if (String(sourceSocial.symbol ?? "").toUpperCase() !== cand.symbol.toUpperCase()) return false;
      if (sourceSocial.assetType && sourceSocial.assetType !== cand.assetType) return false;
      const sourceOrder = sourceSocial.orderId
        ? sourceOrderById.get(sourceSocial.orderId)
        : undefined;
      const sourceAccount = sourceOrder?.brokerAccountId?.trim().toLowerCase() || null;
      const sourceEventAt = sourceOrder ? equitySourceOrderFillAt(sourceOrder) : null;
      return (
        sourceOrderMatchesSocial(sourceSocial, sourceOrder) &&
        sourceAccount !== null &&
        sourceAccount === candidateSourceAccount &&
        sourceEventAt !== null &&
        sourceCloseCutoff !== null &&
        sourceEventAt.getTime() <= sourceCloseCutoff.getTime()
      );
    });
    const hasUnresolvedUserAttribution = relevant.some((row) => {
      const sourceItemId = row.clientOrderId!.slice(mirrorPrefix.length);
      if (isXSignalCandidate || !sourceItemId.startsWith("user:")) return false;
      const sourceSocial = sourceSocialById.get(sourceItemId.slice("user:".length));
      if (!sourceSocial || sourceSocial.userId !== attributedSourceUserId) return !sourceSocial;
      const sourceOrder = sourceSocial.orderId
        ? sourceOrderById.get(sourceSocial.orderId)
        : undefined;
      const sourceEventAt = sourceOrder ? equitySourceOrderFillAt(sourceOrder) : null;
      if (
        sourceEventAt &&
        sourceCloseCutoff &&
        sourceEventAt.getTime() > sourceCloseCutoff.getTime()
      ) return false;
      return !sourceCloseCutoff || !sourceOrderMatchesSocial(sourceSocial, sourceOrder) ||
        !sourceOrder?.brokerAccountId?.trim() ||
        !sourceEventAt;
    });
    if (hasUnresolvedUserAttribution || (relevant.length > 0 && !attributedSourceUserId && attributed.length === 0)) {
      return {
        qty: 0,
        credentialId: null,
        accounts: [],
        unanswerable: attributedSourceUserId ? "source-attribution-unavailable" : "missing-source-metadata",
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen: false,
      };
    }

    // ---- A mirrored OPEN still settling makes `qty` an UNDER-read, not proof of absence. ----
    //
    // `mirroredEquityRowQty` counts only what has actually filled, so a BUY
    // that is still working (PENDING/SYNCING/SUBMITTED/PARTIAL) contributes
    // whatever it has filled SO FAR, which can understate a fill that already
    // happened at the broker and simply has not been reconciled into this row
    // yet (alpaca-13). Flagged rather than resolved here: whether that
    // matters depends on what the caller was going to do with `qty`, and a
    // caller sizing a BUY, or a close that already has enough attributed
    // exposure to cover it, has no reason to wait on a row it does not need.
    //
    // Scoped to OPENS on purpose. The candidate this call is sizing an exit
    // for is itself a close, so its own in-flight resume row (if one exists)
    // is a disposal, not an open, and never sets this flag on account of
    // itself.
    const hasUnsettledOpen = attributed.some(
      (row) => !isMirroredEquityDisposal(row.tradeAction) && !isMirroredEquityRowSettled(row),
    );

    // Netted PER ACCOUNT, because routing is decided at the same time as the
    // ceiling. Summing across accounts would let a flat account's negative net
    // cancel part of the live position on another one, which is the number the
    // exit is about to be sized against.
    const byAccount = new Map<
      string,
      { rows: MirroredEquityOrderRow[]; credentialId: string | null }
    >();
    for (const row of attributed) {
      // Nulls share one bucket rather than being dropped: an open with no
      // recorded account is still exposure, and ignoring it would refuse the
      // exit it is owed.
      const account = row.brokerAccountId?.trim().toLowerCase() ?? "";
      const entry = byAccount.get(account) ?? { rows: [], credentialId: null };
      entry.rows.push(row);
      // The newest OPEN on the account names the destination (rows arrive
      // newest first). An exit names no account of its own to route by, and a
      // deleted connection nulls the foreign key, so both are skipped over.
      if (
        entry.credentialId === null &&
        !isMirroredEquityDisposal(row.tradeAction) &&
        row.brokerCredentialId
      ) {
        entry.credentialId = row.brokerCredentialId;
      }
      byAccount.set(account, entry);
    }

    const active = [...byAccount.entries()].flatMap(([account, entry]) => {
      const qty = netMirroredEquityQty(entry.rows);
      return qty > 0 ? [{ account, qty, credentialId: entry.credentialId }] : [];
    });

    // Two live mirrored positions in one symbol cannot say which of them this
    // close exits, and picking one reduces an unrelated holding while leaving
    // the other open: the worst outcome available here. Unanswerable rather
    // than resolved by a heuristic, exactly as the perp path treats it.
    if (active.length > 1) {
      return {
        qty: 0,
        credentialId: null,
        accounts: active.map((entry) => entry.account),
        unanswerable: "spans-accounts",
        sourceCloseQty: null,
        sourcePositionQty: null,
        hasUnsettledOpen,
      };
    }

    const only = active[0];
    if (only && cand.sizingMode !== "ratio") {
      const sourceContext = xAttribution &&
        xAttribution.sourceCloseQty !== null &&
        xAttribution.sourcePositionQty !== null
        ? {
            sourceCloseQty: xAttribution.sourceCloseQty,
            sourcePositionQty: xAttribution.sourcePositionQty,
            reason: null,
          }
        : candidateSourceMetadata
          ? await this.readEquitySourceCloseContext(cand, candidateSourceMetadata)
          : null;
      if (!sourceContext) {
        return {
          qty: 0,
          credentialId: null,
          accounts: [only.account],
          unanswerable: "missing-source-metadata",
          sourceCloseQty: null,
          sourcePositionQty: null,
          hasUnsettledOpen,
        };
      }
      if (sourceContext.reason) {
        return {
          qty: 0,
          credentialId: null,
          accounts: [only.account],
          unanswerable: sourceContext.reason,
          sourceCloseQty: null,
          sourcePositionQty: null,
          hasUnsettledOpen,
        };
      }
      const proportionalQty = proportionalEquityCloseQty(
        only.qty,
        sourceContext.sourceCloseQty,
        sourceContext.sourcePositionQty,
        cand.assetType === "OPTION" ? "OPTION" : "EQUITY",
      );
      if (proportionalQty === null) {
        return {
          qty: 0,
          credentialId: null,
          accounts: [only.account],
          unanswerable: "proportional-size-unavailable",
          sourceCloseQty: sourceContext.sourceCloseQty,
          sourcePositionQty: sourceContext.sourcePositionQty,
          hasUnsettledOpen,
        };
      }
      return {
        qty: only.qty,
        credentialId: only.credentialId ?? null,
        accounts: [only.account],
        unanswerable: null,
        sourceCloseQty: sourceContext.sourceCloseQty,
        sourcePositionQty: sourceContext.sourcePositionQty,
        hasUnsettledOpen,
      };
    }
    return {
      qty: only?.qty ?? 0,
      credentialId: only?.credentialId ?? null,
      accounts: only ? [only.account] : [],
      unanswerable: null,
      sourceCloseQty: null,
      sourcePositionQty: null,
      hasUnsettledOpen,
    };
  }

  /** Source-side sizing is kept in a bounded, lifecycle-owned history helper. */
  private async readEquitySourceCloseContext(
    cand: MirrorSourceCandidate,
    sourceMetadata: EquitySourceCloseMetadata,
  ) {
    if (cand.assetType !== "EQUITY" && cand.assetType !== "OPTION") {
      return {
        sourceAccountId: null,
        sourceCloseQty: 0,
        sourcePositionQty: 0,
        reason: "source-history-unavailable" as const,
      };
    }
    return readEquitySourceHistoryContext(this.db, {
      sourceUserId: sourceMetadata.sourceUserId,
      sourceOrderId: sourceMetadata.sourceOrderId,
      sourceOrderCreatedAt: sourceMetadata.sourceOrderCreatedAt,
      symbol: cand.symbol,
      assetType: cand.assetType,
      optionExpiration: cand.optionExpiration,
      optionStrike: cand.optionStrike,
      optionType: cand.optionType,
    });
  }

  /**
   * Resolve X option exposure from the source lifecycle rather than one signal id.
   * BTO and STC are separate immutable signals, so the source author, follow
   * lifecycle, contract, action and event time are all part of the join.
   */
  private async readXOptionAttribution(
    cand: MirrorSourceCandidate,
    sourceItemIds: readonly string[],
  ): Promise<{
    attributedSourceItemIds: Set<string>;
    sourceCloseQty: number | null;
    sourcePositionQty: number | null;
    reason: "source-attribution-unavailable" | "source-attribution-saturated" | "source-history-unavailable" | "source-quantity-unavailable" | null;
  }> {
    const noAnswer = (
      reason:
        | "source-attribution-unavailable"
        | "source-attribution-saturated"
        | "source-quantity-unavailable"
        | "source-history-unavailable",
    ) => ({
      attributedSourceItemIds: new Set<string>(),
      sourceCloseQty: null,
      sourcePositionQty: null,
      reason,
    });
    type FindMany = (config: Record<string, unknown>) => Promise<unknown[]>;
    const signalFindMany = typeof this.db.query?.signals?.findMany === "function"
      ? (this.db.query.signals.findMany as unknown as FindMany).bind(this.db.query.signals)
      : undefined;
    const deliveryFindMany = typeof this.db.query?.copyMirrorDeliveries?.findMany === "function"
      ? (this.db.query.copyMirrorDeliveries.findMany as unknown as FindMany).bind(
          this.db.query.copyMirrorDeliveries,
        )
      : undefined;
    // A missing identity relation cannot establish lifecycle ownership.
    if (typeof signalFindMany !== "function" || typeof deliveryFindMany !== "function") {
      return noAnswer("source-attribution-unavailable");
    }

    const currentSourceItemId = cand.sourceItemId;
    const currentSignalId = currentSourceItemId.slice("x_signal:".length);
    const ids = [...new Set(sourceItemIds)];
    const signalColumns = {
      id: true,
      source: true,
      sourceAuthorId: true,
      symbol: true,
      content: true,
      metadata: true,
      timestamp: true,
      createdAt: true,
    };
    const referencedSignals = await signalFindMany({
      where: inArray(schema.signals.id, ids.map((id) => id.slice("x_signal:".length))),
      columns: signalColumns,
      limit: EQUITY_SOURCE_HISTORY_SCAN_CAP + 1,
    }) as MirrorSignalIdentityRow[];
    if (referencedSignals.length > EQUITY_SOURCE_HISTORY_SCAN_CAP) {
      return noAnswer("source-attribution-saturated");
    }
    const referencedById = new Map(referencedSignals.map((signal) => [signal.id, signal] as const));
    const currentSignal = referencedById.get(currentSignalId);
    if (!currentSignal) return noAnswer("source-attribution-unavailable");
    const currentEventAt = mirrorSignalEventAt(currentSignal);
    const currentAuthorKey = cand.sourceAuthorKey ?? mirrorSignalAuthorKey(currentSignal);
    if (!currentEventAt || !currentAuthorKey || currentAuthorKey !== mirrorSignalAuthorKey(currentSignal)) {
      return noAnswer("source-attribution-unavailable");
    }
    const currentParsed = parseOptionSignal(currentSignal.content, {
      symbolHint: currentSignal.symbol,
      referenceDate: currentEventAt,
    });
    if (
      currentParsed.kind !== "option" ||
      currentParsed.option.tradeAction !== "SellToClose" ||
      currentParsed.option.symbol.toUpperCase() !== cand.symbol.toUpperCase() ||
      currentParsed.option.optionExpiration !== (cand.optionExpiration ?? null) ||
      currentParsed.option.optionType !== (cand.optionType ?? null) ||
      Number(currentParsed.option.optionStrike) !== Number(cand.optionStrike)
    ) {
      return noAnswer("source-history-unavailable");
    }
    const followId = cand.followId?.trim() ?? "";
    if (!followId) return noAnswer("source-attribution-unavailable");

    const deliveryRows = await deliveryFindMany({
      where: and(
        eq(schema.copyMirrorDeliveries.followerUserId, cand.followerUserId),
        inArray(schema.copyMirrorDeliveries.sourceItemId, ids),
      ),
      columns: { sourceItemId: true, candidate: true },
      limit: EQUITY_SOURCE_HISTORY_SCAN_CAP + 1,
    }) as Array<{ sourceItemId: string; candidate: unknown }>;
    if (deliveryRows.length > EQUITY_SOURCE_HISTORY_SCAN_CAP) {
      return noAnswer("source-attribution-saturated");
    }
    const deliveryBySourceId = new Map<string, MirrorSourceCandidate | null>();
    for (const row of deliveryRows) {
      if (deliveryBySourceId.has(row.sourceItemId)) {
        deliveryBySourceId.set(row.sourceItemId, null);
        continue;
      }
      deliveryBySourceId.set(
        row.sourceItemId,
        row.candidate && typeof row.candidate === "object"
          ? row.candidate as MirrorSourceCandidate
          : null,
      );
    }
    const currentDelivery = deliveryBySourceId.get(currentSourceItemId);
    if (currentDelivery?.followId?.trim() !== followId || currentDelivery.tradeAction !== cand.tradeAction) {
      return noAnswer("source-attribution-unavailable");
    }

    // Read the bounded source timeline as well as the rows already mirrored.
    // A source entry skipped by a cap still changes the denominator for a later
    // partial STC, while a source re-entry after this close must not.
    const authorMetadata = signalMetadataRecord(currentSignal.metadata);
    if (currentSignal.sourceAuthorId && !authorMetadata.sourceAuthorId) {
      authorMetadata.sourceAuthorId = currentSignal.sourceAuthorId;
    }
    const sourceAuthorId = readCanonicalAuthorForSource(authorMetadata, currentSignal.source).sourceAuthorId;
    const historicalSignals = await signalFindMany({
      where: and(
        eq(schema.signals.source, currentSignal.source),
        sql`upper(${schema.signals.symbol}) = ${cand.symbol.toUpperCase()}`,
        or(
          sql`${schema.signals.metadata}->>'canonicalAuthorKey' = ${currentAuthorKey}`,
          sourceAuthorId ? eq(schema.signals.sourceAuthorId, sourceAuthorId) : undefined,
          sourceAuthorId ? sql`${schema.signals.metadata}->>'sourceAuthorId' = ${sourceAuthorId}` : undefined,
        ),
        lte(schema.signals.timestamp, currentEventAt),
      ),
      columns: signalColumns,
      orderBy: [asc(schema.signals.timestamp), asc(schema.signals.id)],
      limit: EQUITY_SOURCE_HISTORY_SCAN_CAP + 1,
    }) as MirrorSignalIdentityRow[];
    if (historicalSignals.length > EQUITY_SOURCE_HISTORY_SCAN_CAP) {
      return noAnswer("source-history-unavailable");
    }
    const timeline = new Map<string, MirrorSignalIdentityRow>();
    for (const signal of [...historicalSignals, ...referencedSignals]) timeline.set(signal.id, signal);
    const orderedTimeline = [...timeline.values()]
      .filter((signal) => {
        const eventAt = mirrorSignalEventAt(signal);
        if (!eventAt || eventAt > currentEventAt) return false;
        if (eventAt.getTime() === currentEventAt.getTime() && signal.id >= currentSignalId) return false;
        if (signal.symbol.toUpperCase() !== cand.symbol.toUpperCase()) return false;
        return mirrorSignalAuthorKey(signal) === currentAuthorKey;
      })
      .sort((left, right) => {
        const eventDelta = left.timestamp.getTime() - right.timestamp.getTime();
        return eventDelta !== 0 ? eventDelta : left.id.localeCompare(right.id);
      });

    let sourcePositionQty = 0;
    for (const signal of orderedTimeline) {
      const parsed = parseOptionSignal(signal.content, {
        symbolHint: signal.symbol,
        referenceDate: signal.timestamp,
      });
      if (
        parsed.kind !== "option" ||
        parsed.option.symbol.toUpperCase() !== cand.symbol.toUpperCase() ||
        parsed.option.optionExpiration !== (cand.optionExpiration ?? null) ||
        parsed.option.optionType !== (cand.optionType ?? null) ||
        Number(parsed.option.optionStrike) !== Number(cand.optionStrike)
      ) {
        continue;
      }
      const units = mirrorSignalOptionUnits(signal);
      if (units === null) return noAnswer("source-quantity-unavailable");
      sourcePositionQty += parsed.option.tradeAction === "BuyToOpen" ? units : -units;
      if (sourcePositionQty < 0) return noAnswer("source-history-unavailable");
    }
    const sourceCloseQty = mirrorSignalOptionUnits(currentSignal);
    // Owner policy: hold ambiguous exits. Do not derive a contract count from
    // a post count, "partial", or "full". EAGAIN keeps this out of completion.
    if (sourceCloseQty === null) return noAnswer("source-quantity-unavailable");
    if (
      sourcePositionQty <= 0 ||
      sourceCloseQty > sourcePositionQty
    ) {
      return noAnswer("source-history-unavailable");
    }

    const attributedSourceItemIds = new Set<string>();
    for (const sourceItemId of sourceItemIds) {
      const signalId = sourceItemId.slice("x_signal:".length);
      const signal = referencedById.get(signalId);
      const delivery = deliveryBySourceId.get(sourceItemId);
      const eventAt = signal ? mirrorSignalEventAt(signal) : null;
      if (!signal || !eventAt) return noAnswer("source-attribution-unavailable");
      if (eventAt > currentEventAt) continue;
      if (eventAt.getTime() === currentEventAt.getTime() && signal.id > currentSignalId) continue;
      // A follower's symbol history can contain another followed X author (or
      // another follow row for this same author). Those rows are real exposure,
      // but they are not evidence that this close belongs to this lifecycle.
      // Exclude them before requiring a delivery/action join for the selected
      // author; otherwise an unrelated author makes an otherwise answerable
      // close retry forever as "attribution unavailable".
      if (
        mirrorSignalAuthorKey(signal) !== currentAuthorKey ||
        signal.symbol.toUpperCase() !== cand.symbol.toUpperCase()
      ) {
        continue;
      }
      // Once the immutable author/symbol boundary matches, a missing or
      // unidentified delivery is an integrity failure. A proven different
      // lifecycle is excluded without borrowing any of its follower exposure.
      if (!delivery || !delivery.followId?.trim()) {
        return noAnswer("source-attribution-unavailable");
      }
      if (delivery.followId.trim() !== followId) continue;
      const parsed = parseOptionSignal(signal.content, {
        symbolHint: signal.symbol,
        referenceDate: eventAt,
      });
      if (
        parsed.kind !== "option" ||
        parsed.option.optionExpiration !== (cand.optionExpiration ?? null) ||
        parsed.option.optionType !== (cand.optionType ?? null) ||
        Number(parsed.option.optionStrike) !== Number(cand.optionStrike) ||
        parsed.option.tradeAction !== delivery.tradeAction
      ) {
        return noAnswer("source-attribution-unavailable");
      }
      attributedSourceItemIds.add(sourceItemId);
    }
    return {
      attributedSourceItemIds,
      sourceCloseQty,
      sourcePositionQty,
      reason: null,
    };
  }

  /**
   * The credential that actually received this follower's mirrored exposure in
   * this coin, or null when no mirrored open is on file.
   *
   * A follow row is mutable: it can be repointed at another Hyperliquid account,
   * switched to a different venue, or reprovisioned. The order that opened the
   * position is not, and it records the credential it was placed with. A close
   * has to follow the position, not the follow.
   *
   * Only the mirror's own orders count (the client-order-id prefix), and only
   * opens: a reduce-only row is an exit, not the exposure being exited.
   */
  private async mirroredExposureCredentialId(
    cand: MirrorSourceCandidate,
  ): Promise<{
    credentialId: string | null;
    ambiguous: boolean;
    accounts: string[];
    hasMirrorHistory?: false;
  }> {
    const opens = await this.db.query.orders.findMany({
      where: and(
        eq(schema.orders.userId, cand.followerUserId),
        eq(schema.orders.venue, "hyperliquid"),
        eq(schema.orders.assetType, "PERP"),
        eq(schema.orders.symbol, cand.symbol),
        like(schema.orders.clientOrderId, `copymirror:${cand.followerUserId}:%`),
        // Proven network only, same as the other exposure queries.
        //
        // Without any scope, exposure on testnet wallet A and mainnet wallet B
        // both stay active after netting, so every close on the configured
        // network reads as a two-account conflict and retries forever even
        // though routing within that network is unambiguous. An UNPROVEN row
        // does the same thing and cannot resolve, since a null network can no
        // longer be cancelled from absence.
        eq(schema.orders.venueNetwork, networkFromEnv()),
        // CLOSES are read too, because exposure has to be NETTED per account.
        // An opening row keeps its executed size forever, so an account the
        // follower opened and then fully closed would otherwise look active for
        // the rest of time.
        //
        // Rows that never held anything are still excluded: an attempt
        // definitively refused put nothing on any wallet, and counting it made a
        // rejected wallet-A open disagree with a filled wallet-B one. Refusing to
        // route is the safe answer to a conflict between live positions, not to a
        // failed attempt.
        or(
          gt(schema.orders.executedSizeDecimal, "0"),
          inArray(schema.orders.status, ["PENDING", "SUBMITTED", "PARTIAL"]),
        ),
      ),
      columns: {
        brokerCredentialId: true,
        brokerAccountId: true,
        reduceOnly: true,
        executedSizeDecimal: true,
        status: true,
      },
      orderBy: [desc(schema.orders.createdAt)],
      limit: MIRROR_HISTORY_SCAN_CAP + 1,
    });

    // The NEWEST open is not necessarily the one this close exits.
    //
    // A follower can open BTC on wallet A, disconnect, reconnect as wallet B and
    // have another BTC mirror land there. Picking the newest row then routes the
    // close for A's exposure at B, where it reduces an unrelated position and
    // leaves A's still open. That is the worst outcome available on this path,
    // so disagreement is treated as unanswerable rather than resolved by a
    // heuristic: correlating a close to its specific opening exposure needs the
    // durable record tracked as its own work item.
    //
    // In the ordinary case every mirrored open for a coin sits on one account
    // and this is unambiguous. A saturated scan proves nothing about agreement.
    // brokerAccountId, not just the credential, decides agreement.
    //
    // Deleting a connection nulls brokerCredentialId through the foreign key, so
    // credentials alone cannot see a deleted wallet: with wallet A deleted and a
    // later wallet-B open on the same coin, that set holds one value and the
    // close would route confidently at B. brokerAccountId is the wallet address
    // rather than a foreign key, so it survives the delete and the disagreement
    // is visible. Disagreement in EITHER means the coin's mirrored exposure is
    // not all in one place.
    //
    // Nulls are still dropped from the credential set on purpose. When the
    // accounts agree there is no routing question left to answer, and treating a
    // deleted credential as its own value there would hold closes that are
    // perfectly well determined. The single-open case is covered by the wallet
    // check at the call site instead.
    // Net each account's opens against its closes. An account still counts when
    // its mirrored opens exceed its mirrored closes, or when it holds a row that
    // has not settled and may therefore be holding a position we have not
    // recorded. Everything else has been flattened and is history.
    //
    // FIXED-POINT, not floats. Perp sizes are decimal strings and netting them
    // through IEEE-754 leaves residue: opens of 0.1 and 0.2 against a 0.3 close
    // sum to 2.8e-17, which is greater than zero, so a flat account would read as
    // active forever and wedge every later close on another wallet.
    // `signedPerpExposure` is the fixed-point helper the rest of the perp path
    // already nets with; opens are the long side and closes the short side, and
    // it returns null exactly when they cancel out.
    const rowsByAccount = new Map<
      string,
      { rows: Array<{ direction: string; executedSizeDecimal: string | null }>; unsettled: boolean }
    >();
    // Keys are LOWERCASED. The same wallet can be persisted checksummed on one
    // row and lowercase on another, since enablement validates addresses
    // case-insensitively, and exact-string keys would then split one Hyperliquid
    // account into two and read as a conflict. The call site already compares
    // case-insensitively; grouping has to agree with it or the two disagree
    // about how many accounts exist.
    for (const row of opens) {
      const account = row.brokerAccountId?.toLowerCase();
      if (!account) continue;
      const entry = rowsByAccount.get(account) ?? { rows: [], unsettled: false };
      entry.rows.push({
        direction: row.reduceOnly === true ? "short" : "long",
        executedSizeDecimal: row.executedSizeDecimal,
      });
      if (row.status === "PENDING" || row.status === "SUBMITTED" || row.status === "PARTIAL") {
        entry.unsettled = true;
      }
      rowsByAccount.set(account, entry);
    }
    const activeAccounts = [...rowsByAccount.entries()].flatMap(([account, entry]) => {
      if (entry.unsettled) return [account];
      const net = signedPerpExposure(entry.rows);
      // null is exactly flat; a short net means more closed than opened, which is
      // not exposure either.
      return net?.side === "long" ? [account] : [];
    });
    const activeAccountSet = new Set(activeAccounts);

    const credentials = new Set(
      opens.flatMap((open) =>
        open.reduceOnly !== true &&
        open.brokerCredentialId &&
        (!open.brokerAccountId || activeAccountSet.has(open.brokerAccountId.toLowerCase()))
          ? [open.brokerCredentialId]
          : []
      ),
    );
    const accounts = new Set(activeAccounts);
    if (
      opens.length > MIRROR_HISTORY_SCAN_CAP ||
      credentials.size > 1 ||
      accounts.size > 1
    ) {
      return { credentialId: null, ambiguous: true, accounts: [...accounts] };
    }
    const only = [...credentials][0];
    return {
      credentialId: only && only !== "<deleted>" ? only : null,
      ambiguous: false,
      accounts: [...accounts],
      ...(opens.length === 0 ? { hasMirrorHistory: false as const } : {}),
    };
  }

  private async loadPerpCloseContext(
    cand: MirrorSourceCandidate,
    position: { side: PerpSide; size: string } | null,
    db: WorkerPoolDb = this.db,
  ): Promise<{
    sourcePositionSizeDecimal: string;
    mirroredExposureSizeDecimal: string;
    /**
     * The follower client order ids that make up `mirroredExposureSizeDecimal`.
     *
     * The same attribution, reported per row instead of summed, so the
     * protection cancel can be scoped to the source that closed rather than to
     * the coin. See the filter that builds it.
     */
    attributedClientOrderIds: string[];
  } | null> {
    if (!cand.sourceUserId || !cand.sourceOrderId || !cand.sourceOrderCreatedAt || !position) {
      return null;
    }
    const sourceOrderCreatedAt = new Date(cand.sourceOrderCreatedAt);
    if (!Number.isFinite(sourceOrderCreatedAt.getTime())) return null;

    /**
     * When an order actually happened, on the venue's clock.
     *
     * The cutoff above now comes from `executedAt` (see `perpSourceEventAt`), so
     * comparing it against `createdAt` would mix two clocks that diverge by
     * exactly the length of an outage. A synthetic open child back-filled during
     * reconciliation carries a createdAt LATER than the venue timestamp of the
     * close it precedes, so the open would be excluded from the exposure it
     * opened, a non-ratio close would resolve to no-qty, and the close would be
     * consumed while the follower still holds the position.
     */
    const orderEventAt = (order: { executedAt?: Date | null; createdAt: Date }): Date =>
      order.executedAt ?? order.createdAt;

    /**
     * The same "at or before the close" test, in SQL.
     *
     * SOURCE ORDERS ONLY. Without it the scan cap is spent on rows that cannot
     * matter: the read is ordered newest-first over a coin's ALL-TIME history,
     * so a source who kept trading after this close could fill the entire cap
     * with orders that post-date it, leaving nothing to reconstruct from and
     * saturating the guard below on rows the reconstruction would have discarded
     * anyway.
     *
     * It must NOT be applied to the follower's copies. Their timestamps say when
     * the mirror placed and filled them, never which source event they copy, so
     * cutting on them drops the position being closed. See that query.
     *
     * Note this does not make saturation impossible, only far less reachable:
     * enough pre-close history in one coin still trips it. See the guard below.
     */
    const happenedAtOrBefore = or(
      lte(schema.orders.executedAt, sourceOrderCreatedAt),
      and(
        isNull(schema.orders.executedAt),
        lte(schema.orders.createdAt, sourceOrderCreatedAt),
      ),
    );

    /**
     * THE RULE, since these queries kept being fixed one at a time:
     *
     *   The RECONCILER, which settles rows, includes unproven (null-network)
     *   rows so pre-migration orders are not stranded, and separately refuses to
     *   cancel them, because cancellation argues from absence and absence proves
     *   nothing about a chain we cannot identify.
     *
     *   Every query that decides WHETHER OR HOW MUCH TO PLACE requires a proven
     *   network. Attribution and routing decide how much of someone else's
     *   position may be reduced, and a row that cannot be placed on a chain
     *   cannot speak for exposure there. Including them also wedges: an unproven
     *   row can never settle, so anything waiting on it waits forever.
     *
     * Both histories below are scoped to ONE network.
     *
     * A deployment that has traded the same coin on testnet and mainnet has
     * orders for both in this table, and they belong to separate clearinghouses:
     * netting them together produces exposure that exists on neither. A partial
     * close sized from that ratio is wrong even though the live-position clamp
     * bounds its maximum, because the clamp limits the size and not the
     * proportion.
     *
     * NULL is EXCLUDED here, unlike everywhere else, and the difference is the
     * point. Elsewhere the null arm avoids stranding a pre-migration row; here
     * it would let one supply the attribution for a close on a chain it may not
     * belong to, and attribution is the number that decides how much of someone
     * else's position may be reduced. The reconciler already treats a null
     * network as unproven rather than as "the current one", and this is the same
     * rule applied where it matters most.
     *
     * The cost is that a legacy mirrored open contributes nothing, so the
     * reconstruction understates and the close sizes small, leaving a residue.
     * That is the safe direction, and it is the same trade this path makes
     * everywhere: a missed reduction beats reducing a position that is not ours.
     */
    const onActiveNetwork = eq(schema.orders.venueNetwork, networkFromEnv());

    const [sourceOrders, followerOrders] = await Promise.all([
      db.query.orders.findMany({
        where: and(
          eq(schema.orders.userId, cand.sourceUserId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.symbol, cand.symbol),
          happenedAtOrBefore,
          onActiveNetwork,
        ),
        columns: {
          id: true,
          brokerOrderId: true,
          brokerAccountId: true,
          brokerCredentialId: true,
          venue: true,
          direction: true,
          executedSizeDecimal: true,
          createdAt: true,
          // The cutoff below is the venue's clock, so the history has to be
          // read on the same one. See `orderEventAt`.
          executedAt: true,
        },
        orderBy: [desc(schema.orders.createdAt)],
        limit: MIRROR_HISTORY_SCAN_CAP + 1,
      }),
      db.query.orders.findMany({
        // NOT time-filtered, deliberately. A mirrored open is created when the
        // mirror places it and stamped when the venue fills it, and a source
        // that closes quickly produces a copy whose timestamps land AFTER the
        // source close. Cutting on them removes the very position being closed
        // before the client-order-id correlation can tie it to the earlier
        // source event, and once that open reconciles as FILLED the ambiguity
        // guard stops deferring, so the close resolves to no-qty and is
        // consumed. Ordering belongs entirely on the source side.
        //
        // The prefix filter is what bounds this read instead, and it bounds it
        // harder than the cutoff did: only the mirror's own orders are used
        // below, so the follower's own trading in this coin never enters.
        where: and(
          eq(schema.orders.userId, cand.followerUserId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.symbol, cand.symbol),
          like(schema.orders.clientOrderId, `copymirror:${cand.followerUserId}:%`),
          onActiveNetwork,
        ),
        columns: {
          clientOrderId: true,
          direction: true,
          executedSizeDecimal: true,
          createdAt: true,
        },
        orderBy: [desc(schema.orders.createdAt)],
        limit: MIRROR_HISTORY_SCAN_CAP + 1,
      }),
    ]);

    // A saturated scan cannot reconstruct the exposure, and the failure is
    // silent in the worst direction: a missing published fill drops out of
    // `sourceBefore`, the close resolves to no-qty, and a one-shot exit is
    // consumed while the follower still holds the position. Hold it instead.
    //
    // KNOWN LIMIT, and holding is NOT always temporary here.
    //
    // Both scans are narrowed to one coin and to events at or before this close,
    // so tripping the cap needs 5,000 pre-close perp order rows in a single
    // market. That is reachable: the rows are all-time and never drain, and a
    // source fill produces both a parent order and a synthetic fill child, so
    // the count grows at roughly twice the fill rate. Once a source passes it,
    // every later close for that coin holds indefinitely.
    //
    // Holding is still the right answer over the alternative, which is
    // reconstructing from a silently truncated history and consuming the exit on
    // a wrong or zero size. Wedged is recoverable; consumed is not. But the fix
    // is to page the history back to the last flat point rather than to cap it,
    // and that needs the durable exposure record tracked as its own work item.
    //
    // The social-trade read below is deliberately not in this set: it is bounded
    // by construction rather than capped.
    if (
      sourceOrders.length > MIRROR_HISTORY_SCAN_CAP ||
      followerOrders.length > MIRROR_HISTORY_SCAN_CAP
    ) {
      logger.warn(LOG_SERVICE, "[copy-mirror] close-history scan saturated; holding the close", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol.slice(0, 24),
        sourceOrders: sourceOrders.length,
        followerOrders: followerOrders.length,
      });
      throw Object.assign(
        new Error("perp close history scan saturated; cannot size the exit"),
        { code: "EAGAIN" },
      );
    }

    // Published fills for THIS coin's source orders, not the source's entire
    // trading history.
    //
    // This used to read the newest 5,000 social trades across every symbol. An
    // active source passes that in the ordinary course of business, at which
    // point the read saturates on every call and never drains, so the guard
    // above turned into a permanent wedge: with closes retrying indefinitely,
    // every future exit for that source hung forever. That is strictly worse
    // than the truncation it was meant to catch.
    //
    // Keyed off the source orders instead, it cannot exceed the number of
    // orders already loaded, so there is no cap to saturate.
    const sourceBrokerOrderIds = sourceOrders.flatMap((order) =>
      order.brokerOrderId ? [order.brokerOrderId] : []
    );
    const sourceOrderIds = sourceOrders.map((order) => order.id);
    const sourceTradeConditions = [
      inArray(schema.socialTrades.orderId, sourceOrderIds),
      ...(sourceBrokerOrderIds.length > 0
        ? [and(
            isNull(schema.socialTrades.orderId),
            inArray(schema.socialTrades.brokerOrderId, sourceBrokerOrderIds),
          )]
        : []),
    ];
    const sourceTrades = sourceOrderIds.length === 0
      ? []
      : await db.query.socialTrades.findMany({
          where: and(
            eq(schema.socialTrades.userId, cand.sourceUserId),
            or(...sourceTradeConditions),
          ),
          columns: { id: true, orderId: true, brokerOrderId: true },
        });

    // A legacy social row has no order_id, so its broker ID is usable only if
    // every order with that ID belongs to one account/credential/venue scope.
    // This prevents an old row from attaching to another account that reused a
    // broker ID while keeping unambiguous legacy history readable.
    const scopeRows = sourceBrokerOrderIds.length === 0
      ? []
      : await db.query.orders.findMany({
          where: and(
            eq(schema.orders.userId, cand.sourceUserId),
            inArray(schema.orders.brokerOrderId, sourceBrokerOrderIds),
          ),
          columns: {
            id: true,
            brokerOrderId: true,
            brokerAccountId: true,
            brokerCredentialId: true,
            venue: true,
          },
        });
    const scopeKey = (row: {
      brokerAccountId: string | null;
      brokerCredentialId: string | null;
      venue: string | null;
    }) => JSON.stringify([
      row.brokerAccountId ?? null,
      row.brokerCredentialId ?? null,
      row.venue?.toLowerCase() ?? null,
    ]);
    const scopesByBroker = new Map<string, Set<string>>();
    for (const row of scopeRows) {
      if (!row.brokerOrderId) continue;
      const scopes = scopesByBroker.get(row.brokerOrderId) ?? new Set<string>();
      scopes.add(scopeKey(row));
      scopesByBroker.set(row.brokerOrderId, scopes);
    }
    const sourceScopeByBroker = new Map<string, Set<string>>();
    for (const row of sourceOrders) {
      if (!row.brokerOrderId) continue;
      const scopes = sourceScopeByBroker.get(row.brokerOrderId) ?? new Set<string>();
      scopes.add(scopeKey(row));
      sourceScopeByBroker.set(row.brokerOrderId, scopes);
    }
    const exactSourceOrderIds = new Set(sourceOrderIds);
    const legacySourceBrokerIds = new Set(
      sourceBrokerOrderIds.filter((brokerOrderId) => {
        const allScopes = scopesByBroker.get(brokerOrderId);
        const sourceScopes = sourceScopeByBroker.get(brokerOrderId);
        return allScopes?.size === 1 && sourceScopes?.size === 1 &&
          [...allScopes][0] === [...sourceScopes][0];
      }),
    );
    const publishedSourceOrderIds = new Set(
      sourceTrades.flatMap((trade) =>
        trade.orderId && exactSourceOrderIds.has(trade.orderId) ? [trade.orderId] : []
      ),
    );

    // Social fills are the canonical source stream: cumulative parent orders are
    // not published, while each synthetic child identifies one exact fill delta.
    const publishedSourceBrokerIds = new Set(
      sourceTrades.flatMap((trade) =>
        (trade.orderId === null || trade.orderId === undefined) &&
        trade.brokerOrderId && legacySourceBrokerIds.has(trade.brokerOrderId)
          ? [trade.brokerOrderId]
          : []
      ),
    );
    const sourceOrdersBefore = sourceOrders.filter((order) =>
      order.id !== cand.sourceOrderId &&
      orderEventAt(order) <= sourceOrderCreatedAt &&
      order.brokerOrderId !== null &&
      (
        publishedSourceOrderIds.has(order.id) ||
        publishedSourceBrokerIds.has(order.brokerOrderId)
      )
    );
    const sourceBefore = signedPerpExposure(sourceOrdersBefore);

    // Correlate the follower's copies through the SOURCE event each one mirrors,
    // never through its own timestamps.
    //
    // A mirrored open is written when the mirror places it and stamped when the
    // venue fills it, and neither says anything about which source event it
    // copies. A source that closes quickly produces a follower open whose times
    // land AFTER the source close, so a time comparison drops the very position
    // being closed: the reconstruction sums to nothing, and if the follower has
    // any manual history in the coin (so the venue fallback below does not
    // apply) the close resolves to no-qty and is consumed.
    //
    // The client order id already encodes the source item, so the ordering
    // question belongs entirely on the source side, where the cutoff lives.
    const sourceTradeIdByOrderId = new Map(
      sourceTrades.flatMap((trade) =>
        trade.orderId && exactSourceOrderIds.has(trade.orderId)
          ? [[trade.orderId, trade.id] as const]
          : []
      ),
    );
    const sourceTradeIdByBrokerId = new Map(
      sourceTrades.flatMap((trade) =>
        (trade.orderId === null || trade.orderId === undefined) &&
        trade.brokerOrderId && legacySourceBrokerIds.has(trade.brokerOrderId)
          ? [[trade.brokerOrderId, trade.id] as const]
          : []
      ),
    );
    const sourceIdsBefore = new Set(
      sourceOrdersBefore.flatMap((order) => {
        const tradeId = sourceTradeIdByOrderId.get(order.id) ??
          (order.brokerOrderId
            ? sourceTradeIdByBrokerId.get(order.brokerOrderId)
            : undefined);
        return tradeId ? [tradeId] : [];
      }),
    );
    const prefix = `copymirror:${cand.followerUserId}:user:`;
    // Kept as rows rather than folded straight into the exposure figure, because
    // WHICH rows these are is itself an answer the caller needs. This filter is
    // the only place that knows precisely which of the follower's orders belong
    // to the source being closed, and the protection cancel has to be scoped to
    // exactly that set: anything broader retires the stop on a mirror opened
    // from a different follow, or from a signal that has no source to close it.
    const attributedFollowerOrders = followerOrders.filter((order) =>
      order.clientOrderId?.startsWith(prefix) === true &&
      sourceIdsBefore.has(order.clientOrderId.slice(prefix.length))
    );
    const mirroredBefore = signedPerpExposure(attributedFollowerOrders);
    // NO VENUE FALLBACK HERE, deliberately.
    //
    // An earlier revision of this branch used the live position size whenever
    // every Hyperliquid perp order on file for this follower carried the mirror's
    // prefix, reasoning that the position was then mirror-owned by construction.
    // That reasoning was wrong: it treats the absence of non-mirror ROWS as proof
    // of the absence of non-mirror EXPOSURE. A position the follower opened
    // directly on Hyperliquid has no row here at all, and the open guard
    // deliberately permits the mirror to scale into a matching same-side
    // position, so "our prefix on every row" is perfectly consistent with the
    // venue holding their money alongside ours. Sizing a full close off the
    // combined figure would have closed their own position with it.
    //
    // The venue genuinely is the authority on how MUCH the follower holds. What
    // it cannot tell us is attribution: it reports "long 0.5 BTC", never "0.3 of
    // that came from the mirror". A copied close may only reduce what the mirror
    // opened, so attribution has to come from our own rows, and until a fill is
    // recorded the honest answer is that we do not know yet.
    //
    // Not knowing is safe here, because it is no longer the same as consuming
    // the close. An unreconciled open leaves its delivery matched by
    // `pairedOpenOutcomeAmbiguous` (which covers "placed" orders still sitting at
    // SUBMITTED), so the close DEFERS and is sized correctly on a later cycle
    // once the fill lands. If the open turns out never to have reached the venue,
    // the reconciler settles it, the ambiguity clears, and the close is consumed
    // against a position that genuinely does not exist. Both endings are right.

    const reducingSourceSide: PerpSide = cand.perpSide === "short" ? "long" : "short";
    if (
      !sourceBefore ||
      sourceBefore.side !== reducingSourceSide ||
      !mirroredBefore ||
      mirroredBefore.side !== position.side
    ) {
      return null;
    }
    return {
      sourcePositionSizeDecimal: sourceBefore.size,
      mirroredExposureSizeDecimal: mirroredBefore.size,
      attributedClientOrderIds: attributedFollowerOrders.flatMap((order) =>
        order.clientOrderId ? [order.clientOrderId] : []
      ),
    };
  }

  /**
   * Align on-chain leverage + margin mode before a mirrored OPEN, and report
   * whether it is confirmed.
   *
   * The manual ticket wraps this same call and aborts the order when it throws
   * (`apps/api/src/routers/orders.ts`); the mirror used to await it bare. A bare
   * await sends a cross-vs-isolated conflict, which is a permanent property of
   * the account's open margin and not a blip, into the generic transient handler,
   * so the delivery re-arms and the account keeps receiving leverage writes on a
   * 15 minute loop forever.
   *
   * `updateLeverage` returns ok when the coin is already at the requested value,
   * so a throw here is always a real failure. False means the liquidation profile
   * could not be confirmed, and the caller must return a terminal outcome rather
   * than place at an unknown leverage. No order row exists yet on the fresh-open
   * path, and on the resume path the existing row is left untouched at PENDING
   * for the sync poller, so nothing is marked rejected by this refusal.
   */
  private async applyPerpLeverage(
    client: HyperliquidClient,
    params: {
      followerUserId: string;
      sourceItemId: string;
      coin: string;
      leverage: number;
      marginMode: MarginMode;
    },
  ): Promise<boolean> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await client.updateLeverage({
          coin: params.coin,
          leverage: params.leverage,
          marginMode: params.marginMode,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        // These are durable venue/policy conflicts. Retrying them only delays
        // the refusal and repeatedly writes the same impossible setting.
        const permanent = [
          "cannot switch margin mode",
          "invalid leverage",
          "max leverage",
          "unsupported leverage",
          "asset not found",
          "coin not found",
        ].some((fragment) => normalized.includes(fragment));
        const willRetry = !permanent && attempt < maxAttempts;

        logger[willRetry ? "warn" : "error"](
          LOG_SERVICE,
          willRetry
            ? "[copy-mirror] perp leverage update failed transiently; retrying"
            : "[copy-mirror] perp leverage not confirmed, order not placed",
          {
            followerUserId: params.followerUserId,
            sourceItemId: params.sourceItemId,
            coin: params.coin,
            leverage: params.leverage,
            marginMode: params.marginMode,
            attempt,
            maxAttempts,
            error: message,
          },
        );
        if (!willRetry) return false;

        // updateLeverage is idempotent for the same coin/value and places no
        // exposure, so a bounded retry is safe even if the prior response was
        // lost after Hyperliquid accepted the update.
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
    }
    return false;
  }

  /**
   * Structured audit trail for one perp placement. Emitted once before the
   * venue is touched and once on every return path, so a leveraged order is
   * never invisible in the log the way it used to be. Values are the same
   * fields the equity "PLACED mirror order" line carries; no credential, no
   * wallet key, no config value.
   */
  private logPerpPlacement(
    stage: { intent: PerpPlacementIntent } | { outcome: PerpPlacementOutcome },
    params: {
      followerUserId: string;
      sourceItemId?: string;
      brokerAccountId: string;
      coin: string;
      side: PerpSide;
      sizeCoin: string;
      leverage: number;
      marginMode: MarginMode;
      reduceOnly?: boolean;
      clientOrderId: string;
      markPrice?: string;
      leveragePolicy?: PerpMirrorPlacementParams["leveragePolicy"];
    },
    extra: Record<string, unknown> = {},
  ): void {
    const line = "intent" in stage
      ? describePerpPlacementIntent(stage.intent)
      : describePerpPlacementOutcome(stage.outcome);
    logger[line.level](LOG_SERVICE, line.message, {
      followerUserId: params.followerUserId,
      sourceItemId: params.sourceItemId ?? null,
      coin: params.coin,
      side: params.side,
      sizeCoin: params.sizeCoin,
      leverage: params.leverage,
      marginMode: params.marginMode,
      reduceOnly: params.reduceOnly ?? false,
      clientOrderId: params.clientOrderId,
      markPrice: params.markPrice ?? null,
      ...(params.leveragePolicy ? leverageAuditFields(params.leveragePolicy) : {}),
      ...("intent" in stage ? { intent: stage.intent } : { outcome: stage.outcome }),
      ...extra,
    });
  }

  /** Build the exact Limit/IOC (or reduce-only Market/IOC) payload once. */
  private buildPerpMirrorOrderInput(
    params: PerpMirrorPlacementParams,
  ): { input: PerpOrderSubmitInput } | { result: PerpPlacementResult } {
    let submittedSizeCoin = params.sizeCoin;
    let submittedLimitPrice: string | undefined;
    if (params.reduceOnly !== true) {
      const venueNotional = validatePerpVenueNotional({
        sizeCoin: params.sizeCoin,
        markPrice: params.markPrice ?? "",
        side: params.side,
        sizeDecimals: params.sizeDecimals ?? -1,
        maxOrderDollars: params.maxOrderDollars ?? Number.NaN,
        slippage: MIRROR_PERP_MARKET_SLIPPAGE,
      });
      if (venueNotional.action === "skip") {
        logger.warn(LOG_SERVICE, `[copy-mirror] skip perp placement: ${venueNotional.reason}`, {
          followerUserId: params.followerUserId,
          sourceItemId: params.sourceItemId,
          coin: params.coin,
          side: params.side,
          reason: venueNotional.reason,
        });
        return { result: { outcome: "no-qty", reason: venueNotional.reason } };
      }
      // Keep the local row and wrapper request on the exact venue size/price
      // that the submitted-payload cap just measured. A short IOC may fill at
      // a more favorable price later; this check is intentionally about the
      // exact request, not an unbounded future fill price.
      submittedSizeCoin = venueNotional.sizeCoin;
      submittedLimitPrice = venueNotional.price;
    }
    const inputResult = perpOrderSubmitSchema.safeParse({
      coin: params.coin,
      isLong: params.side === "long",
      marginMode: params.marginMode,
      orderType: submittedLimitPrice !== undefined ? "Limit" : "Market",
      sizeCoin: submittedSizeCoin,
      ...(submittedLimitPrice !== undefined ? { limitPrice: submittedLimitPrice } : {}),
      reduceOnly: params.reduceOnly ?? false,
      postOnly: false,
      leverage: params.leverage,
      cloid: params.clientOrderId,
      ...(params.markPrice !== undefined ? { markPrice: params.markPrice } : {}),
    });
    if (!inputResult.success) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp placement: unsafe decimal input", {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin,
      });
      return { result: { outcome: "no-qty" } };
    }
    return { input: inputResult.data };
  }

  /**
   * Phase A: persist the idempotent PENDING intent before taking the policy
   * lock. This method performs no venue call, so an accepted venue request can
   * always be reconciled even if the later policy transaction rolls back.
   */
  private async preparePerpMirrorOrder(
    params: PerpMirrorPlacementParams,
    rootDb: WorkerPoolDb = this.db,
  ): Promise<PerpPrepareMirrorOrderResult> {
    const perpDailyCap = params.reduceOnly === true
      ? undefined
      : normalizePerpDailyCap(params.dailyCap);
    if (params.reduceOnly !== true && perpDailyCap === null) {
      this.logPerpPlacement({ outcome: "syncing" }, params, {
        reason: "invalid-daily-cap",
      });
      return { result: { outcome: "daily-cap" } };
    }
    const preparedParams = params.reduceOnly === true
      ? params
      : { ...params, dailyCap: perpDailyCap! };

    const run = async (db: WorkerPoolDb): Promise<PerpPrepareMirrorOrderResult> => {
    const built = this.buildPerpMirrorOrderInput(preparedParams);
    if ("result" in built) return built;
    const resumeOpen = preparedParams.intent === "resume" && built.input.reduceOnly !== true;
    const protectionIntent = perpProtectionIntentSnapshot(preparedParams.protectionRuleSnapshot);
    const placementAttemptAt = await readDatabaseNow(db);
    const claimToken = randomUUID();
    const claimReason = perpPlacementLeaseReason(claimToken);
    const [inserted] = await db
      .insert(schema.orders)
      .values({
        ...toPerpOrderRow(built.input, preparedParams.followerUserId, preparedParams.brokerAccountId),
        brokerCredentialId: preparedParams.brokerCredentialId,
        notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
        copySourceLabel: preparedParams.copySourceLabel ?? null,
        // `sync_reason` is the durable owner token. The reconciler recognizes
        // the namespace, while the exact suffix is what the policy transaction
        // compares under its user -> order lock.
        syncReason: claimReason,
        lastSyncAttemptAt: placementAttemptAt,
        ...(protectionIntent ? { perpProtection: protectionIntent } : {}),
      })
      .onConflictDoNothing({ target: schema.orders.clientOrderId })
      .returning();

    let order: typeof schema.orders.$inferSelect | undefined = inserted;
    if (!order) {
      order = await db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, preparedParams.followerUserId),
          eq(schema.orders.clientOrderId, preparedParams.clientOrderId),
        ),
      });
      if (!order || (order.status !== undefined && order.status !== "PENDING")) {
        this.logPerpPlacement({ outcome: "duplicate" }, preparedParams, {
          storedStatus: order?.status ?? null,
        });
        return { result: { outcome: "duplicate" } };
      }
      if (!this.perpPreparedIdentityMatches(order, preparedParams, built.input, true)) {
        this.logPerpPlacement({ outcome: "duplicate" }, preparedParams, {
          reason: "identity-conflict",
          storedStatus: order.status ?? null,
        });
        return { result: { outcome: "duplicate", reason: "identity-conflict" } };
      }
      // A fresh lease belongs to the caller that already prepared it. A second
      // retry must not overwrite that owner while its policy transaction is in
      // the Phase-A -> Phase-B gap; it waits for reconciliation instead.
      const leaseNowMs = placementAttemptAt.getTime();
      const leaseState = perpPlacementLeaseState(
        order.syncReason,
        order.lastSyncAttemptAt,
        leaseNowMs,
      );
      if (leaseState === "active" || leaseState === "future") {
        this.logPerpPlacement({ outcome: "syncing" }, preparedParams, {
          reason: "claim-held",
          storedStatus: order.status ?? null,
        });
        return { result: { outcome: "syncing", reason: "claim-held" } };
      }
      // A timestamp far in the future must not permanently wedge the PENDING
      // row. Clear exactly the marker observed above before attempting to claim
      // it; if another writer changed either value, its CAS wins and this
      // attempt waits for reconciliation instead of stealing ownership.
      let expectedSyncReason = order.syncReason;
      let expectedAttemptAt = order.lastSyncAttemptAt;
      if (leaseState === "quarantined") {
        const healed = await db
          .update(schema.orders)
          .set({ syncReason: null, lastSyncAttemptAt: null })
          .where(and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.userId, preparedParams.followerUserId),
            eq(schema.orders.clientOrderId, preparedParams.clientOrderId),
            eq(schema.orders.status, "PENDING"),
            expectedAttemptAt == null
              ? isNull(schema.orders.lastSyncAttemptAt)
              : eq(schema.orders.lastSyncAttemptAt, expectedAttemptAt),
            expectedSyncReason == null
              ? isNull(schema.orders.syncReason)
              : eq(schema.orders.syncReason, expectedSyncReason),
          ))
          .returning({ id: schema.orders.id });
        if (healed.length !== 1) {
          return { result: { outcome: "syncing", reason: "claim-held" } };
        }
        expectedSyncReason = null;
        expectedAttemptAt = null;
      }
      // Claim the exact durable intent for this attempt. A reconciler that won
      // the PENDING CAS between the conflict read and this update means the row
      // is no longer safe to submit; return syncing and never duplicate the
      // venue request. The Phase-B row lock repeats this precondition while it
      // holds the users lock.
      const claimed = await db
        .update(schema.orders)
        .set({
          syncReason: claimReason,
          lastSyncAttemptAt: placementAttemptAt,
          // A resumed open is rebuilt from the current mark so its protective
          // IOC band can move while the lease is waiting. Refresh the durable
          // payload in the same fenced claim that authorizes the retry; leaving
          // the old limit here made a normal price move look like a foreign
          // cloid and terminally completed the delivery as a "duplicate".
          ...(resumeOpen ? {
            orderType: built.input.orderType,
            quantityDecimal: built.input.sizeCoin,
            limitPrice: built.input.limitPrice ?? null,
            priceTrigger: built.input.triggerPx ?? null,
          } : {}),
        })
        .where(
          and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.userId, preparedParams.followerUserId),
            eq(schema.orders.clientOrderId, preparedParams.clientOrderId),
            eq(schema.orders.venue, "hyperliquid"),
            eq(schema.orders.status, "PENDING"),
            expectedAttemptAt == null
              ? isNull(schema.orders.lastSyncAttemptAt)
              : eq(schema.orders.lastSyncAttemptAt, expectedAttemptAt),
            expectedSyncReason == null
              ? isNull(schema.orders.syncReason)
              : eq(schema.orders.syncReason, expectedSyncReason),
          ),
        )
        .returning({ id: schema.orders.id });
      if (claimed.length !== 1) {
        return { result: { outcome: "syncing", reason: "claim-held" } };
      }
    }
    return {
      prepared: {
        orderId: order.id,
        claimToken,
        claimAt: placementAttemptAt,
        durableLeverage: order.leverage,
        // A conflict can represent an earlier accepted/ambiguous request. The
        // Phase-B owner must ask the venue by cloid before it submits again.
        reconcileVenueBeforeSubmit: !inserted,
        params: preparedParams,
        input: built.input,
      },
    };
    };

    // Fresh/resumed opens reserve the per-user daily slot in the same commit as
    // their PENDING intent. Reduce-only closes deliberately bypass this policy
    // so an exit can never be stranded by an entry cap.
    const dailyCap = preparedParams.dailyCap;
    const dbWithTransaction = rootDb as WorkerPoolDb & {
      transaction?: <R>(callback: (tx: WorkerPoolDb) => Promise<R>) => Promise<R>;
    };
    const dbAny = rootDb as any;
    if (
      preparedParams.reduceOnly !== true &&
      Number.isSafeInteger(dailyCap) &&
      dailyCap! >= 0 &&
      typeof dbWithTransaction.transaction === "function" &&
      typeof dbAny.select === "function"
    ) {
      return dbWithTransaction.transaction(async (tx) => {
        const txAny = tx as any;
        const selected = txAny.select({ id: schema.users.id });
        const from = selected?.from?.(schema.users);
        const where = from?.where?.(eq(schema.users.id, preparedParams.followerUserId));
        if (!where || typeof where.for !== "function") {
          // Lightweight unit-test handles may expose transactions without a
          // fluent row-lock builder. Production PostgreSQL handles always take
          // this branch; retain their old compatibility path for those fakes.
          return run(tx);
        }
        const users = await where.for("update") as Array<{ id?: string }>;
        if (users.length !== 1 || users[0]?.id !== preparedParams.followerUserId) {
          throw new Error("perp daily slot user row unavailable");
        }

        // Find the cloid row under the same user lock. Excluding that row lets
        // its resume finish the slot it already owns; a fresh cloid cannot
        // hide behind a stale advisory count.
        const existing = await tx.query.orders.findFirst({
          where: and(
            eq(schema.orders.userId, preparedParams.followerUserId),
            eq(schema.orders.clientOrderId, preparedParams.clientOrderId),
          ),
          columns: { id: true, status: true, reduceOnly: true },
        });
        const existingOrderId = existing?.id;
        const slots = await this.countPerpDailySlots(
          preparedParams.followerUserId,
          existingOrderId,
          tx,
        );
        if (slots === null) throw Object.assign(new Error("daily mirror cap count unavailable"), { code: "08006" });
        let dailyCapReached = slots >= dailyCap!;
        if (dailyCapReached && existing?.status === "PENDING") {
          // A historical backlog may contain more than one unresolved intent.
          // Counting every unresolved row except the one being resumed would
          // deadlock all of them at cap=1. Under the user lock, give those
          // intents a stable FIFO rank and let only the oldest intent within
          // the remaining slots proceed. Newer rows cannot leapfrog it.
          const unresolved = await this.listPerpUnresolvedSlots(
            preparedParams.followerUserId,
            tx,
          );
          if (unresolved) {
            const rank = unresolved.findIndex((row) => row.id === existingOrderId);
            if (rank >= 0) {
              const otherUnresolved = unresolved.length - 1;
              const confirmedSlots = Math.max(0, slots - otherUnresolved);
              dailyCapReached = confirmedSlots + rank + 1 > dailyCap!;
            }
          }
        }
        // A definitive terminal row is not an open reservation. A pending
        // non-reduce row is already counted only when it is another cloid;
        // this request's own row was excluded above. An unresolved resume is
        // admitted only by its stable rank calculation above.
        if (dailyCapReached) {
          this.logPerpPlacement({ outcome: "syncing" }, preparedParams, {
            reason: "daily-cap",
            mirrorsToday: slots,
            dailyCap,
          });
          return { result: { outcome: "daily-cap" } };
        }
        return run(tx);
      });
    }
    return run(rootDb);
  }

  /**
   * A cloid conflict is only adoptable when every durable identity field still
   * names this exact mirror payload. The cloid is a dedupe key, not proof that a
   * row belongs to this request: a foreign/malformed row with the same text must
   * fail closed rather than be submitted or silently adopted.
   */
  private perpPreparedIdentityMatches(
    order: Partial<typeof schema.orders.$inferSelect>,
    params: PerpMirrorPlacementParams,
    input: PerpOrderSubmitInput,
    allowOpenResumeReprice = false,
  ): boolean {
    const sameDecimal = (actual: unknown, expected: string | undefined): boolean => {
      if (expected === undefined) return actual === null || actual === undefined;
      if (typeof actual !== "string") return false;
      const left = parsePositiveDecimal(actual);
      const right = parsePositiveDecimal(expected);
      if (!left || !right) return false;
      const scale = Math.max(left.scale, right.scale);
      return (
        left.coefficient * 10n ** BigInt(scale - left.scale) ===
        right.coefficient * 10n ** BigInt(scale - right.scale)
      );
    };
    const expectedDirection = input.isLong ? "long" : "short";
    const expectedTradeAction = input.isLong ? "Buy" : "Sell";
    const expectedLimitPrice = input.limitPrice;
    const expectedTrigger = input.triggerPx;
    const expectedNetwork = networkFromEnv();
    const reduceOnlyResume = params.intent === "resume" && input.reduceOnly === true;
    const resumeOpen = params.intent === "resume" && !reduceOnlyResume;
    const mutableResumePayload = reduceOnlyResume || (resumeOpen && allowOpenResumeReprice);
    return (
      order.userId === params.followerUserId &&
      order.clientOrderId === params.clientOrderId &&
      order.status === "PENDING" &&
      order.brokerOrderId == null &&
      order.symbol === input.coin &&
      order.assetType === "PERP" &&
      // A reduce-only resume is intentionally re-sized against the live
      // attributed exposure. Its old row can therefore retain the original
      // Limit/price/size fields even though the retry payload is Market with a
      // different size. An open resume may also lower leverage against the
      // current policy; its immutable identity below still has to match, while
      // fresh placement/adoption retains the strict full-payload comparison.
      (mutableResumePayload || order.orderType === input.orderType) &&
      order.tradeAction === expectedTradeAction &&
      order.direction === expectedDirection &&
      // `quantity` is the schema-required integer placeholder for perps. A
      // cloid collision with a legacy/manual row that populated this field is
      // not the exact durable payload we prepared and must not be adopted.
      order.quantity === 0 &&
      (mutableResumePayload || (
        order.quantityDecimal !== null &&
        sameDecimal(order.quantityDecimal, input.sizeCoin)
      )) &&
      (mutableResumePayload || sameDecimal(order.limitPrice, expectedLimitPrice)) &&
      (mutableResumePayload || sameDecimal(order.priceTrigger, expectedTrigger)) &&
      (reduceOnlyResume || resumeOpen || order.leverage === input.leverage) &&
      order.marginMode === input.marginMode &&
      order.reduceOnly === input.reduceOnly &&
      order.venue === "hyperliquid" &&
      order.venueNetwork === expectedNetwork &&
      order.brokerCredentialId === params.brokerCredentialId &&
      typeof order.brokerAccountId === "string" &&
      order.brokerAccountId.toLowerCase() === params.brokerAccountId.toLowerCase() &&
      (order.copySourceLabel ?? null) === (params.copySourceLabel ?? null)
    );
  }

  /**
   * Verify the durable owner immediately before touching Hyperliquid.
   *
   * The policy transaction already locked the users row and this exact order
   * row. This final predicate check is intentionally read-only: it proves the
   * transaction still owns the token after all policy/venue reads and before
   * the irreversible request. Production WorkerPoolDb has the fluent select;
   * the compatibility fallback is only for old unit-test fakes, whose caller
   * has already passed the locked-order predicate above.
   */
  private async perpPlacementClaimStillOwned(
    db: WorkerPoolDb,
    prepared: PerpPreparedMirrorOrder,
  ): Promise<boolean> {
    const dbAny = db as any;
    if (typeof dbAny.select !== "function") return true;
    const selected = dbAny.select({
      id: schema.orders.id,
      clientOrderId: schema.orders.clientOrderId,
      status: schema.orders.status,
      leverage: schema.orders.leverage,
    });
    const from = selected && typeof selected.from === "function"
      ? selected.from(schema.orders)
      : null;
    const query = from && typeof from.where === "function"
      ? from.where(and(
          eq(schema.orders.id, prepared.orderId),
          eq(schema.orders.userId, prepared.params.followerUserId),
          eq(schema.orders.clientOrderId, prepared.params.clientOrderId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.status, "PENDING"),
          isNull(schema.orders.brokerOrderId),
          eq(schema.orders.syncReason, perpPlacementLeaseReason(prepared.claimToken)),
          eq(schema.orders.lastSyncAttemptAt, prepared.claimAt),
        ))
      : null;
    if (!query) return false;
    const rows = await query as Array<{ id?: string }>;
    return rows.length === 1;
  }

  /**
   * Read the leverage on the exact claimed PENDING row. The Phase-A snapshot
   * is normally current, but a reconciler may have changed the row before the
   * policy transaction acquired its order lock. The row read here is the
   * authority used to decide whether a lowering is needed.
   */
  private async readPerpOpenDurableLeverage(
    db: WorkerPoolDb,
    prepared: PerpPreparedMirrorOrder,
  ): Promise<number | null> {
    const dbAny = db as any;
    if (typeof dbAny.select !== "function") {
      const fallback = prepared.durableLeverage;
      return typeof fallback === "number" && Number.isSafeInteger(fallback) && fallback >= 1
        ? fallback
        : null;
    }
    const selected = dbAny.select({
      id: schema.orders.id,
      leverage: schema.orders.leverage,
    });
    const from = selected && typeof selected.from === "function"
      ? selected.from(schema.orders)
      : null;
    const query = from && typeof from.where === "function"
      ? from.where(and(
          eq(schema.orders.id, prepared.orderId),
          eq(schema.orders.userId, prepared.params.followerUserId),
          eq(schema.orders.clientOrderId, prepared.params.clientOrderId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.status, "PENDING"),
          isNull(schema.orders.brokerOrderId),
          eq(schema.orders.syncReason, perpPlacementLeaseReason(prepared.claimToken)),
          eq(schema.orders.lastSyncAttemptAt, prepared.claimAt),
        ))
      : null;
    if (!query) return null;
    const rows = await query as Array<{ id?: string; leverage?: unknown }>;
    if (rows.length !== 1) return null;
    const row = rows[0];
    const liveLeverage = row?.leverage;
    if (
      typeof liveLeverage === "number" &&
      Number.isSafeInteger(liveLeverage) &&
      liveLeverage >= 1
    ) return liveLeverage;
    // Compatibility fakes from before the leverage projection existed do not
    // return the field. Production rows always do; retain the prepared value
    // only for those narrowly shaped test handles.
    if (row && !Object.prototype.hasOwnProperty.call(row, "leverage")) {
      const fallback = prepared.durableLeverage;
      return typeof fallback === "number" && Number.isSafeInteger(fallback) && fallback >= 1
        ? fallback
        : null;
    }
    return null;
  }

  /**
   * Keep the durable PENDING leverage at or below the final locked policy.
   *
   * Phase A can only know the policy snapshot taken before the users-row lock,
   * so its row may carry a higher leverage than the callback eventually allows.
   * The exact claim is checked again here and the lowering is a token/time-fenced
   * CAS. A caller must commit this transaction and retry before it can touch the
   * venue; an accepted or ambiguous venue request must never be paired with a
   * durable row that still advertises the higher leverage.
   */
  private async ensurePerpOpenLeverage(
    prepared: PerpPreparedMirrorOrder,
    maxLeverage: number,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpOpenDurableLeverageResult> {
    if (!Number.isSafeInteger(maxLeverage) || maxLeverage < 1) {
      return { action: "claim-lost" };
    }
    const durableLeverage = await this.readPerpOpenDurableLeverage(db, prepared);
    if (durableLeverage === null) return { action: "claim-lost" };
    if (durableLeverage <= maxLeverage) {
      return { action: "unchanged", leverage: durableLeverage };
    }

    const lowered = await db
      .update(schema.orders)
      .set({ leverage: maxLeverage })
      .where(
        and(
          eq(schema.orders.id, prepared.orderId),
          eq(schema.orders.userId, prepared.params.followerUserId),
          eq(schema.orders.clientOrderId, prepared.params.clientOrderId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          eq(schema.orders.status, "PENDING"),
          isNull(schema.orders.brokerOrderId),
          eq(schema.orders.syncReason, perpPlacementLeaseReason(prepared.claimToken)),
          eq(schema.orders.lastSyncAttemptAt, prepared.claimAt),
          gt(schema.orders.leverage, maxLeverage),
        ),
      )
      .returning({ id: schema.orders.id });
    if (lowered.length !== 1) return { action: "claim-lost" };
    return { action: "lowered", leverage: maxLeverage };
  }

  /**
   * Query one deterministic cloid without treating a lagging aggregate
   * snapshot as proof that it was never posted. The exact order-status endpoint
   * is authoritative; when the client cannot provide it, the safe answer is
   * malformed/unknown rather than permission to post a duplicate.
   */
  private async readPerpOrderStatusByCloid(
    client: HyperliquidClient,
    address: `0x${string}`,
    clientOrderId: string,
  ): Promise<
    | { kind: "unknown" }
    | { kind: "found"; brokerOrderId: string; status: string }
    | { kind: "invalid"; error: string }
  > {
    const readClient = client as HyperliquidClient & {
      orderStatusByClientOrderId?: (address: `0x${string}`, clientOrderId: string) => Promise<unknown>;
      orderStatus?: (address: `0x${string}`, orderId: string | number) => Promise<unknown>;
    };
    const statusReader = readClient.orderStatusByClientOrderId ?? readClient.orderStatus;
    if (statusReader) {
      const raw = await statusReader.call(readClient, address, clientOrderId);
      if (!raw || typeof raw !== "object" || !("status" in raw) || typeof raw.status !== "string") {
        return { kind: "invalid", error: "Hyperliquid orderStatus response was malformed" };
      }
      if (raw.status === "unknownOid") return { kind: "unknown" };
      if (raw.status !== "order" || !("order" in raw) || !raw.order || typeof raw.order !== "object") {
        return { kind: "invalid", error: "Hyperliquid orderStatus response was incomplete" };
      }
      const detail = raw.order as Record<string, unknown>;
      const order = detail.order;
      if (!order || typeof order !== "object") {
        return { kind: "invalid", error: "Hyperliquid orderStatus had no order detail" };
      }
      const record = order as Record<string, unknown>;
      const brokerOrderId = record.oid;
      const processingStatus = detail.status;
      if (
        (typeof brokerOrderId !== "string" &&
          (typeof brokerOrderId !== "number" ||
            !Number.isSafeInteger(brokerOrderId) ||
            brokerOrderId < 0)) ||
        (typeof brokerOrderId === "string" && brokerOrderId.trim() === "") ||
        typeof processingStatus !== "string" ||
        processingStatus.trim() === ""
      ) {
        return { kind: "invalid", error: "Hyperliquid orderStatus had no id/status" };
      }
      return { kind: "found", brokerOrderId: String(brokerOrderId), status: processingStatus };
    }
    return { kind: "invalid", error: "Hyperliquid exact orderStatus reader unavailable" };
  }

  /**
   * A retry after an expired lease may submit only after two well-formed
   * unknown responses. Any found status (including terminal rejection) proves
   * the previous request reached the venue and therefore forbids a repost.
   */
  private async reconcilePerpPlacementByCloid(
    client: HyperliquidClient,
    params: PerpMirrorPlacementParams,
  ): Promise<PerpVenueSubmission | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let probe: Awaited<ReturnType<CopyMirrorPoller["readPerpOrderStatusByCloid"]>>;
      try {
        probe = await this.readPerpOrderStatusByCloid(
          client,
          params.brokerAccountId as `0x${string}`,
          params.clientOrderId,
        );
      } catch (error) {
        return {
          kind: "not-submitted",
          reason: "reconcile",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (probe.kind === "invalid") {
        return { kind: "not-submitted", reason: "reconcile", error: probe.error };
      }
      if (probe.kind === "found") {
        const status = probe.status.toLowerCase();
        if (status.includes("reject") || status.includes("cancel") || status.includes("expire")) {
          return {
            kind: "rejected",
            reason: probe.status,
            error: `Hyperliquid orderStatus found terminal ${probe.status} order`,
          };
        }
        return { kind: "recovered", brokerOrderId: probe.brokerOrderId };
      }
      // Yield between authoritative probes so an in-flight old owner can
      // publish its result before the second read, without using a test sleep.
      await Promise.resolve();
    }
    return null;
  }

  /** Phase B: submit only; no order/protection DB writes are permitted here. */
  private async submitPerpMirrorOrder(
    client: HyperliquidClient,
    prepared: PerpPreparedMirrorOrder,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpVenueSubmission> {
    if (prepared.reconcileVenueBeforeSubmit) {
      // An expired lease does not prove the previous POST was absent. Require
      // two authoritative unknown responses before permitting a new POST; a
      // found live or terminal order always wins and is never reposted.
      const reconciliation = await this.reconcilePerpPlacementByCloid(
        client,
        prepared.params,
      );
      if (reconciliation) return reconciliation;
    }

    // Keep this check after the venue lookup: it is the last operation before
    // the irreversible request. The order lock held by the policy transaction
    // makes the predicate stable for the entire call.
    try {
      if (!(await this.perpPlacementClaimStillOwned(db, prepared))) {
        return {
          kind: "not-submitted",
          reason: "claim-held",
          error: "perp placement claim is no longer owned",
        };
      }
    } catch (error) {
      return {
        kind: "not-submitted",
        reason: "claim-held",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const result = await client.placeOrder({
        ...toPlacePerpOrderRequest(prepared.input),
        timeInForce: "Ioc",
        slippage: MIRROR_PERP_MARKET_SLIPPAGE,
      });
      // Hyperliquid's response nests order ids in status entries. The durable
      // reconciler can discover those by cloid, so Phase C need not trust an
      // optional response shape here.
      const filledSizeCoin = perpOrderFilledSize(result);
      return {
        kind: "accepted",
        ...(filledSizeCoin === null ? {} : { filledSizeCoin }),
      };
    } catch (error) {
      if (
        error instanceof HyperliquidOrderRejectedError ||
        error instanceof HyperliquidOrderPreparationError
      ) {
        const verdict =
          error instanceof HyperliquidOrderPreparationError
            ? classifyPerpPreparationFailure(error.message, { reduceOnly: prepared.params.reduceOnly === true })
            : classifyPerpRejection(error.message, { reduceOnly: prepared.params.reduceOnly === true });
        if (verdict.disposition === "reconcile" || verdict.disposition === "retry") {
          return {
            kind: "reconcile",
            reason: "reconcile",
            error: error.message,
          };
        }
        return {
          kind: "rejected",
          reason: verdict.reason,
          error: error.message,
        };
      }
      // Do not throw while the policy transaction is active. The caller first
      // commits the policy transaction, then leaves the durable row PENDING and
      // rethrows this original ambiguous transport error for normal retry.
      return { kind: "ambiguous", error };
    }
  }

  private async runIndependentOrderWrite<T>(
    db: WorkerPoolDb,
    callback: (tx: WorkerPoolDb) => Promise<T>,
  ): Promise<T> {
    const transaction = (db as WorkerPoolDb & {
      transaction?: <R>(callback: (tx: WorkerPoolDb) => Promise<R>) => Promise<R>;
    }).transaction;
    return transaction
      ? transaction.call(db, callback) as Promise<T>
      : callback(db);
  }

  /**
   * Phase C: persist venue outcome after the policy transaction has committed.
   * A failed status write intentionally leaves a durable PENDING row for the
   * reconciler, with a best-effort placedAt stamp for accepted/ambiguous calls.
   */
  private async finalizePerpMirrorOrder(
    prepared: PerpPreparedMirrorOrder,
    submission: PerpVenueSubmission,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpPlacementResult> {
    const { params, orderId } = prepared;
    // Keep placement metadata on the same PostgreSQL clock as Phase A's lease
    // and the daily-slot window. A skewed worker must not move a placement into
    // a different UTC day while finalizing it.
    const now = await readDatabaseNow(db);
    const claimReason = perpPlacementLeaseReason(prepared.claimToken);
    const identity = and(
      eq(schema.orders.id, orderId),
      eq(schema.orders.userId, params.followerUserId),
      eq(schema.orders.clientOrderId, params.clientOrderId),
      eq(schema.orders.venue, "hyperliquid"),
      eq(schema.orders.assetType, "PERP"),
    );
    // Phase C may only finalize the exact attempt which passed the policy lock.
    // A durable cloid alone is not ownership: after lease expiry a later retry
    // may have claimed the same PENDING row. Keeping the token in every status
    // and metadata CAS means an older caller can neither finalize nor annotate
    // the newer attempt.
    const ownerIdentity = and(
      identity,
      eq(schema.orders.syncReason, claimReason),
      isNull(schema.orders.brokerOrderId),
    );
    // Metadata written after an ambiguous/failed finalization is still a
    // concurrent order-row write.  Keep it on the same PENDING CAS as the
    // status transition so a reconciler that already advanced the row cannot
    // be overwritten by a stale placed-at/lease stamp.
    const pendingIdentity = and(ownerIdentity, eq(schema.orders.status, "PENDING"));
    const update = async (
      tx: WorkerPoolDb,
      values: Record<string, unknown>,
      incomingStatus?: "SUBMITTED" | "REJECTED" | "CANCELLED",
    ): Promise<number> => {
      const predicates = incomingStatus
        ? and(
            ownerIdentity,
            eq(schema.orders.status, "PENDING"),
            orderStatusTransitionCondition(incomingStatus),
            preserveBrokerOrderIdCondition(
              typeof values.brokerOrderId === "string" ? values.brokerOrderId : undefined,
            ),
          )
        : ownerIdentity;
      const rows = await tx
        .update(schema.orders)
        .set(values)
        .where(predicates)
        .returning({ id: schema.orders.id });
      return rows.length;
    };
    const updatePendingMetadata = async (
      tx: WorkerPoolDb,
      values: Record<string, unknown>,
    ): Promise<number> => {
      const rows = await tx
        .update(schema.orders)
        .set(values)
        .where(pendingIdentity)
        .returning({ id: schema.orders.id });
      return rows.length;
    };
    const readAuthoritative = async (): Promise<typeof schema.orders.$inferSelect | undefined> =>
      db.query.orders.findFirst({
        where: identity,
      });
    const resultForAuthoritativeStatus = (status: unknown): PerpPlacementResult | undefined => {
      if (status === "SUBMITTED" || status === "PARTIAL" || status === "FILLED") {
        return { outcome: "placed" };
      }
      if (status === "CANCELLED" || status === "REJECTED" || status === "EXPIRED") {
        return { outcome: "rejected" };
      }
      return undefined;
    };
    const lostCasResult = async (
      incomingStatus: "SUBMITTED" | "REJECTED" | "CANCELLED",
      pendingMetadata?: Record<string, unknown>,
    ): Promise<PerpPlacementResult> => {
      let authoritative: typeof schema.orders.$inferSelect | undefined;
      try {
        authoritative = await readAuthoritative();
      } catch (error) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp finalizer could not reread lost CAS", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const status = authoritative?.status;
      const currentResult = resultForAuthoritativeStatus(status);
      if (currentResult) return currentResult;
      if (pendingMetadata) {
        let metadataCasLost = false;
        try {
          const stamped = await this.runIndependentOrderWrite(db, (tx) =>
            updatePendingMetadata(tx, pendingMetadata),
          );
          if (stamped !== 1) {
            metadataCasLost = true;
            logger.warn(LOG_SERVICE, "[copy-mirror] perp finalizer pending metadata CAS was not singular", {
              followerUserId: params.followerUserId,
              coin: params.coin,
              clientOrderId: params.clientOrderId,
              returnedRows: stamped,
              incomingStatus,
            });
          }
        } catch (error) {
          metadataCasLost = true;
          logger.error(LOG_SERVICE, "[copy-mirror] perp finalizer pending metadata stamp failed", {
            followerUserId: params.followerUserId,
            coin: params.coin,
            clientOrderId: params.clientOrderId,
            incomingStatus,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // A PENDING read can go stale while the fallback metadata CAS waits on
        // the row. If that guarded write loses, reread before returning so a
        // concurrent reconciler's terminal outcome is reflected to the caller.
        if (metadataCasLost) {
          try {
            const afterMetadata = await readAuthoritative();
            const afterResult = resultForAuthoritativeStatus(afterMetadata?.status);
            if (afterResult) return afterResult;
          } catch (error) {
            logger.error(LOG_SERVICE, "[copy-mirror] perp finalizer could not reread after metadata CAS loss", {
              followerUserId: params.followerUserId,
              coin: params.coin,
              clientOrderId: params.clientOrderId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      // The status is still PENDING (or the row could not be reread). Keep the
      // durable intent for reconciliation. The metadata fallback above is also
      // PENDING-guarded: a reconciler may have advanced the row between the
      // authoritative read and this write, in which case it matches zero rows
      // and leaves the newer state untouched.
      logger.warn(LOG_SERVICE, "[copy-mirror] perp finalizer lost status CAS; leaving intent for reconciliation", {
        followerUserId: params.followerUserId,
        coin: params.coin,
        clientOrderId: params.clientOrderId,
        incomingStatus,
        authoritativeStatus: status ?? null,
      });
      return { outcome: "syncing", reason: "status-write-failed" };
    };
    // Resume reconciliation records any policy clamp explicitly before (or
    // immediately after) the venue call. Never let Phase C overwrite that
    // conservative value with a stale intent snapshot; in particular, a
    // venue-reported leverage from a failed resume application is capped by
    // the execution path and must remain capped after finalization.
    const leverageUpdate = params.intent === "resume"
      ? {}
      : { leverage: params.leverage };

    if (submission.kind === "accepted" || submission.kind === "recovered") {
      if (
        submission.kind === "accepted" &&
        params.reduceOnly !== true &&
        submission.filledSizeCoin === "0"
      ) {
        // Hyperliquid's IOC response is authoritative: totalSz=0 means the
        // attempt matched no liquidity and the venue cancelled all of it. Keep
        // the empty attempt as an audit row, but move it off the canonical cloid
        // so the durable delivery can safely make a bounded retry with a fresh
        // mark/limit. No broker reconciliation is needed for a positively known
        // zero fill.
        const archivedClientOrderId = `${params.clientOrderId}:zero-fill:${orderId}`;
        try {
          const matched = await this.runIndependentOrderWrite(db, (tx) =>
            update(tx, {
              status: monotonicOrderStatusValue("CANCELLED"),
              statusUpdatedAt: now,
              placedAt: now,
              executedSizeDecimal: "0",
              clientOrderId: archivedClientOrderId,
              syncReason: null,
              ...leverageUpdate,
              notes: "[copy-mirror] Hyperliquid IOC filled zero; archived for bounded retry",
            }, "CANCELLED"),
          );
          if (matched !== 1) return lostCasResult("CANCELLED");
          this.logPerpPlacement({ outcome: "rejected" }, params, {
            reason: "zero-fill-retry",
          });
          return { outcome: "zero-fill" };
        } catch (error) {
          logger.error(LOG_SERVICE, "[copy-mirror] zero-fill archive failed", {
            followerUserId: params.followerUserId,
            coin: params.coin,
            clientOrderId: params.clientOrderId,
            error: error instanceof Error ? error.message : String(error),
          });
          return lostCasResult("CANCELLED");
        }
      }
      try {
        const matched = await this.runIndependentOrderWrite(db, (tx) =>
          update(tx, {
            status: monotonicOrderStatusValue("SUBMITTED"),
            statusUpdatedAt: now,
            placedAt: now,
            // The lease has served its purpose. A terminal/submitted row must
            // no longer look like an active placement attempt to the sync poller.
            syncReason: null,
            ...leverageUpdate,
            ...(submission.brokerOrderId ? { brokerOrderId: submission.brokerOrderId } : {}),
          }, "SUBMITTED"),
        );
        if (matched !== 1) return lostCasResult("SUBMITTED");
        if (submission.kind === "recovered") {
          this.logPerpPlacement({ outcome: "syncing" }, params, {
            reason: "recovered-at-venue",
            brokerOrderId: submission.brokerOrderId,
          });
          return { outcome: "syncing", reason: "recovered-at-venue" };
        }
        this.logPerpPlacement({ outcome: "placed" }, params);
        return { outcome: "placed" };
      } catch (error) {
        logger.error(LOG_SERVICE, "[copy-mirror] accepted perp order status write failed", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Re-read first. A reconciler may have won the row between the failed
        // status write and this handler; in that case return the authoritative
        // outcome and do not stamp the newer row. If it is still PENDING, the
        // fallback lease/placed-at write is itself guarded by that status.
        return lostCasResult("SUBMITTED", {
          placedAt: now,
          syncReason: claimReason,
          lastSyncAttemptAt: now,
        });
      }
    }

    if (submission.kind === "ambiguous") {
      const pendingMetadata = {
        placedAt: now,
        syncReason: claimReason,
        lastSyncAttemptAt: now,
      };
      try {
        const matched = await this.runIndependentOrderWrite(db, (tx) =>
          updatePendingMetadata(tx, pendingMetadata),
        );
        if (matched !== 1) return lostCasResult("SUBMITTED", pendingMetadata);
      } catch (error) {
        logger.error(LOG_SERVICE, "[copy-mirror] ambiguous perp placed_at stamp failed", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
        // The metadata write can fail after reconciliation has already
        // advanced the row.  Use the same authoritative reread as status-CAS
        // failures so an already settled order is not surfaced as a retryable
        // ambiguous placement.
        return lostCasResult("SUBMITTED", pendingMetadata);
      }
      return { outcome: "syncing", reason: "status-write-failed" };
    }

    if (submission.kind === "rejected") {
      try {
        const matched = await this.runIndependentOrderWrite(db, (tx) =>
          update(tx, {
            status: monotonicOrderStatusValue("REJECTED"),
            statusUpdatedAt: now,
            syncReason: null,
            ...leverageUpdate,
            notes: `[copy-mirror] Hyperliquid rejected perp: ${submission.error}`,
          }, "REJECTED"),
        );
        if (matched !== 1) return lostCasResult("REJECTED");
        return { outcome: "rejected" };
      } catch (error) {
        logger.error(LOG_SERVICE, "[copy-mirror] rejected perp status write failed", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
        return lostCasResult("REJECTED");
      }
    }

    // No venue request was made: either the expired-lease reconciliation read
    // was incomplete or a newer owner won the final claim check. Do not annotate
    // or report this as unprotected exposure; the exact owner is no longer
    // entitled to mutate the row, and nothing could have landed at the venue from
    // this attempt. The durable PENDING row remains for a later reconciler/retry.
    if (submission.kind === "not-submitted") {
      return { outcome: "syncing", reason: submission.reason };
    }

    // Reconciliation owns this still-PENDING row. A note is useful but never
    // allowed to turn a known durable intent into a retrying duplicate. The
    // annotation itself is PENDING- and owner-guarded: an earlier implementation
    // used the broad identity predicate here, so a reconciler could advance the
    // row to FILLED/REJECTED and this stale Phase-C callback would then overwrite
    // terminal notes or leverage.
    const reconcileMetadata = {
      ...leverageUpdate,
      notes: `[copy-mirror] Hyperliquid rejection kept for reconciliation (${submission.reason})${submission.error ? `: ${submission.error}` : ""}`,
    };
    try {
      const matched = await this.runIndependentOrderWrite(db, (tx) =>
        updatePendingMetadata(tx, reconcileMetadata),
      );
      if (matched !== 1) {
        const authoritative = await readAuthoritative();
        return resultForAuthoritativeStatus(authoritative?.status) ?? {
          outcome: "syncing",
          reason: "reconcile",
        };
      }
    } catch (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] perp reconciliation note write failed", {
        followerUserId: params.followerUserId,
        coin: params.coin,
        clientOrderId: params.clientOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        const authoritative = await readAuthoritative();
        return resultForAuthoritativeStatus(authoritative?.status) ?? {
          outcome: "syncing",
          reason: "reconcile",
        };
      } catch (rereadError) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp reconciliation result reread failed", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          error: rereadError instanceof Error ? rereadError.message : String(rereadError),
        });
      }
    }
    return { outcome: "syncing", reason: "reconcile" };
  }

  /**
   * `PerpPlacementResult`, not a bare outcome string.
   *
   * Three of the returns below are "syncing" and they mean different things: an
   * order read back off the venue by cloid, a local write that failed after the
   * venue accepted, and a rejection handed to the reconciler. Only the first
   * proves the follower is holding exposure, and the caller's protection gate
   * needs to know which one it got. The `outcome` half is the same vocabulary
   * this returned before and is what still travels upward as the delivery's
   * outcome; see `perpPlacementProvesExposure` for what reads the other half.
   */
  private async placePerpMirrorOrder(
    client: HyperliquidClient,
    params: PerpMirrorPlacementParams,
    db: WorkerPoolDb = this.db,
  ): Promise<PerpPlacementResult> {
    this.logPerpPlacement(
      { intent: params.intent },
      params,
      params.orderDollars !== undefined ? { orderDollars: params.orderDollars } : {},
    );
    const placementNow = await readDatabaseNow(db);
    let submittedSizeCoin = params.sizeCoin;
    let submittedLimitPrice: string | undefined;
    if (params.reduceOnly !== true) {
      const venueNotional = validatePerpVenueNotional({
        sizeCoin: params.sizeCoin,
        markPrice: params.markPrice ?? "",
        side: params.side,
        sizeDecimals: params.sizeDecimals ?? -1,
        maxOrderDollars: params.maxOrderDollars ?? Number.NaN,
        slippage: MIRROR_PERP_MARKET_SLIPPAGE,
      });
      if (venueNotional.action === "skip") {
        logger.warn(LOG_SERVICE, `[copy-mirror] skip perp placement: ${venueNotional.reason}`, {
          followerUserId: params.followerUserId,
          sourceItemId: params.sourceItemId,
          coin: params.coin,
          side: params.side,
          reason: venueNotional.reason,
        });
        return { outcome: "no-qty", reason: venueNotional.reason };
      }
      // Keep the local row and the wrapper request on the exact venue size the
      // guard just measured. The long-side IOC limit is also pinned below so
      // the wrapper cannot recompute it from a moved mark or a different band.
      submittedSizeCoin = venueNotional.sizeCoin;
      submittedLimitPrice = venueNotional.price;
    }
    const inputResult = perpOrderSubmitSchema.safeParse({
      coin: params.coin,
      isLong: params.side === "long",
      marginMode: params.marginMode,
      // Open orders use a preformatted Limit+IOC. This makes the validated
      // long price the payload price; reduce-only closes stay Market/IOC.
      orderType: submittedLimitPrice !== undefined ? "Limit" : "Market",
      sizeCoin: submittedSizeCoin,
      ...(submittedLimitPrice !== undefined ? { limitPrice: submittedLimitPrice } : {}),
      reduceOnly: params.reduceOnly ?? false,
      postOnly: false,
      leverage: params.leverage,
      cloid: params.clientOrderId,
      ...(params.markPrice !== undefined ? { markPrice: params.markPrice } : {}),
    });
    if (!inputResult.success) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: unsafe decimal input", {
        followerUserId: params.followerUserId,
        sourceItemId: params.sourceItemId,
        coin: params.coin,
      });
      return { outcome: "no-qty" };
    }
    const input: PerpOrderSubmitInput = inputResult.data;
    // Every legacy write below is still a compare-and-set. The strict matcher
    // validates a conflict snapshot; this predicate protects the gap between
    // that read and the venue/recovery call from a reconciler or another
    // finalizer changing the row underneath us.
    const reduceOnlyResume = params.intent === "resume" && input.reduceOnly === true;
    const legacyPendingIdentity = (orderId: string) => and(
      eq(schema.orders.id, orderId),
      eq(schema.orders.userId, params.followerUserId),
      eq(schema.orders.clientOrderId, params.clientOrderId),
      eq(schema.orders.venue, "hyperliquid"),
      eq(schema.orders.assetType, "PERP"),
      eq(schema.orders.status, "PENDING"),
      isNull(schema.orders.brokerOrderId),
      eq(schema.orders.symbol, input.coin),
      // A reduce-only retry is deliberately re-sized from the live attributed
      // exposure. Its durable row can retain the original open's order type,
      // leverage, and size while the close attempt uses Market/IOC. Those
      // mutable fields are already checked by perpPreparedIdentityMatches;
      // keep the CAS anchored to the immutable close identity instead of
      // making the safe close-resume path impossible in production. A fresh
      // reduce-only collision has no such exception and keeps the complete
      // durable venue payload stable through the final CAS.
      ...(reduceOnlyResume ? [] : [
        eq(schema.orders.orderType, input.orderType),
        eq(schema.orders.quantityDecimal, input.sizeCoin),
        input.limitPrice === undefined
          ? isNull(schema.orders.limitPrice)
          : eq(schema.orders.limitPrice, input.limitPrice),
        input.triggerPx === undefined
          ? isNull(schema.orders.priceTrigger)
          : eq(schema.orders.priceTrigger, input.triggerPx),
        eq(schema.orders.leverage, input.leverage),
      ]),
      eq(schema.orders.tradeAction, input.isLong ? "Buy" : "Sell"),
      eq(schema.orders.direction, input.isLong ? "long" : "short"),
      eq(schema.orders.quantity, 0),
      eq(schema.orders.marginMode, input.marginMode),
      eq(schema.orders.reduceOnly, input.reduceOnly),
      eq(schema.orders.brokerAccountId, params.brokerAccountId),
      eq(schema.orders.brokerCredentialId, params.brokerCredentialId),
      eq(schema.orders.venueNetwork, networkFromEnv()),
      params.copySourceLabel == null
        ? isNull(schema.orders.copySourceLabel)
        : eq(schema.orders.copySourceLabel, params.copySourceLabel),
    );
    const [inserted] = await db
      .insert(schema.orders)
      .values({
        ...toPerpOrderRow(input, params.followerUserId, params.brokerAccountId),
        brokerCredentialId: params.brokerCredentialId,
        notes: "[copy-mirror] auto-mirrored Hyperliquid perp",
        copySourceLabel: params.copySourceLabel ?? null,
      })
      .onConflictDoNothing({ target: schema.orders.clientOrderId })
      .returning();

    let order: typeof schema.orders.$inferSelect | undefined = inserted;
    if (!order) {
      order = await db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, params.followerUserId),
          eq(schema.orders.clientOrderId, params.clientOrderId),
        ),
      });
      if (!order || order.status !== "PENDING") {
        this.logPerpPlacement({ outcome: "duplicate" }, params, {
          storedStatus: order?.status ?? null,
        });
        return { outcome: "duplicate" };
      }
      // Legacy callers still race on the same deterministic cloid. A PENDING
      // row is adoptable only when it is the exact payload this caller built;
      // otherwise a foreign/manual row could be silently recovered or submitted
      // under the caller's identity. Reduce-only closes use the same matcher,
      // preserving their safe recovery path while failing closed on mismatch.
      if (!this.perpPreparedIdentityMatches(order, params, input)) {
        this.logPerpPlacement({ outcome: "duplicate" }, params, {
          reason: "identity-conflict",
          storedStatus: order.status,
        });
        return { outcome: "duplicate", reason: "identity-conflict" };
      }

      const reconciliation = await this.reconcilePerpPlacementByCloid(client, params);
      if (reconciliation?.kind === "not-submitted") {
        this.logPerpPlacement({ outcome: "syncing" }, params, {
          reason: reconciliation.reason,
          error: reconciliation.error,
        });
        return { outcome: "syncing", reason: "reconcile" };
      }
      if (reconciliation?.kind === "rejected") {
        // A terminal venue status proves the prior request reached HL, but it
        // is not permission to place a second order under the same cloid. Keep
        // the durable row pending for the normal reconciler/revive ladder.
        this.logPerpPlacement({ outcome: "syncing" }, params, {
          reason: "reconcile-terminal",
          venueReason: reconciliation.reason,
        });
        return { outcome: "syncing", reason: "reconcile" };
      }
      if (reconciliation?.kind === "recovered") {
        const recovered = { oid: reconciliation.brokerOrderId };
        const updatedRows = await db
          .update(schema.orders)
          .set({
            status: "SUBMITTED",
            brokerOrderId: String(recovered.oid),
            statusUpdatedAt: placementNow,
            // Recovered by cloid, so it reached the venue on an earlier attempt.
            // Stamped now because that is when we learned it, and the daily cap
            // measures placements it can actually see.
            placedAt: placementNow,
          })
          .where(and(
            legacyPendingIdentity(order.id),
            orderStatusTransitionCondition("SUBMITTED"),
            preserveBrokerOrderIdCondition(String(recovered.oid)),
          ))
          .returning({ id: schema.orders.id });
        if (updatedRows.length !== 1) {
          const authoritative = await this.readAuthoritativeOrder(
            order.id,
            params.followerUserId,
            params.clientOrderId,
            db,
          );
          logger.warn(LOG_SERVICE, "[copy-mirror] recovered Hyperliquid acceptance CAS lost", {
            followerUserId: params.followerUserId,
            sourceItemId: params.sourceItemId,
            clientOrderId: params.clientOrderId,
            returnedRows: updatedRows.length,
            authoritativeStatus: authoritative?.status ?? null,
          });
          return { outcome: "syncing", reason: "recovered-at-venue" };
        }
        this.logPerpPlacement({ outcome: "syncing" }, params, {
          reason: "recovered-at-venue",
          brokerOrderId: String(recovered.oid),
        });
        // PROVEN exposure: the cloid was matched against the venue's own fills
        // and open orders and the broker order id came back with it.
        return { outcome: "syncing", reason: "recovered-at-venue" };
      }
    }

    let result: unknown;
    try {
      result = await client.placeOrder({
        ...toPlacePerpOrderRequest(input),
        ...(submittedLimitPrice !== undefined ? { timeInForce: "Ioc" as const } : {}),
        // Pin the band explicitly. The wrapper's default is the same today, but
        // close orders still use the explicit band; open orders use their
        // already-pinned limit price and therefore cannot be widened here.
        slippage: MIRROR_PERP_MARKET_SLIPPAGE,
      });
    } catch (error) {
      if (
        error instanceof HyperliquidOrderRejectedError ||
        error instanceof HyperliquidOrderPreparationError
      ) {
        // A rejection is not automatically terminal. `placeOrder` funnels every
        // ApiRequestError into one class, and one family of those messages says
        // the cloid ALREADY EXISTS, which is a claim that an order is live, not
        // that it never happened. See copy-mirror-perp-rejection.ts for why this
        // is correct whether or not Hyperliquid rejects a re-used cloid.
        const verdict =
          error instanceof HyperliquidOrderPreparationError
            ? classifyPerpPreparationFailure(error.message, {
                reduceOnly: params.reduceOnly === true,
              })
            : classifyPerpRejection(error.message, {
                reduceOnly: params.reduceOnly === true,
              });

        if (verdict.disposition === "retry") {
          // Nothing was sent, but this is a close, so retiring the order would
          // also complete the delivery and spend the follower's only exit. The
          // row stays PENDING so the retry RESUMES it: client_order_id is unique
          // and deterministic, so a second insert would collide.
          logger.warn(
            LOG_SERVICE,
            "[copy-mirror] perp close could not be prepared; retrying rather than consuming the exit",
            {
              followerUserId: params.followerUserId,
              coin: params.coin,
              clientOrderId: params.clientOrderId,
              reason: verdict.reason,
              error: error.message,
            },
          );
          throw Object.assign(
            new Error(`perp close preparation failed, retrying: ${error.message}`),
            { code: "EAGAIN" },
          );
        }

        if (verdict.disposition === "reconcile") {
          logger.warn(
            LOG_SERVICE,
            "[copy-mirror] perp rejection left PENDING for the Hyperliquid reconciler",
            {
              followerUserId: params.followerUserId,
              coin: params.coin,
              clientOrderId: params.clientOrderId,
              reason: verdict.reason,
              error: error.message,
            },
          );
          // Status is deliberately untouched: PENDING is what the sync poller
          // scans, and it owns the outcome from here. The note is the only write,
          // and a failed note must never turn into a thrown error, because the
          // delivery would then be requeued and attempt a second placement.
          try {
            await db
              .update(schema.orders)
              .set({
                notes: `[copy-mirror] Hyperliquid rejection kept for reconciliation (${verdict.reason}): ${error.message}`,
              })
              .where(legacyPendingIdentity(order.id));
          } catch (noteError) {
            logger.error(LOG_SERVICE, "[copy-mirror] perp reconciliation note write failed", {
              followerUserId: params.followerUserId,
              clientOrderId: params.clientOrderId,
              error: noteError instanceof Error ? noteError.message : String(noteError),
            });
          }
          this.logPerpPlacement({ outcome: "syncing" }, params, {
            reason: verdict.reason,
          });
          // A CLOSE is requeued rather than handed to the reconciler alone.
          //
          // Returning here completes the delivery, which is right for an open:
          // the row stays PENDING, the reconciler owns it, and if it did reach
          // the venue nothing more is needed. For a close it loses the exit. The
          // reconciler settles the ORDER, it does not re-place anything, so when
          // it finds no fill and no resting order and cancels the row, there is
          // no delivery left to try again.
          //
          // Requeueing is safe because the client order id is deterministic: a
          // retry resumes this same row under the same cloid, re-sized against
          // the live position. If the first attempt actually filled, the dedupe
          // check sees a non-PENDING row and completes the delivery; if it never
          // reached the venue, the revive path brings the cancelled row back.
          if (params.reduceOnly === true) {
            throw Object.assign(
              new Error(`perp close left for reconciliation, retrying: ${verdict.reason}`),
              { code: "EAGAIN" },
            );
          }
          return { outcome: "syncing", reason: "reconcile" };
        }

        logger.warn(LOG_SERVICE, "[copy-mirror] Hyperliquid rejected perp mirror", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          reason: verdict.reason,
          error: error.message,
        });
        const updatedRows = await db
          .update(schema.orders)
          .set({
            status: "REJECTED",
            notes: `[copy-mirror] Hyperliquid rejected perp: ${error.message}`,
          })
          .where(and(
            legacyPendingIdentity(order.id),
            orderStatusTransitionCondition("REJECTED"),
          ))
          .returning({ id: schema.orders.id });
        if (updatedRows.length !== 1) {
          const authoritative = await this.readAuthoritativeOrder(
            order.id,
            params.followerUserId,
            params.clientOrderId,
            db,
          );
          logger.warn(LOG_SERVICE, "[copy-mirror] rejected Hyperliquid status CAS lost", {
            followerUserId: params.followerUserId,
            sourceItemId: params.sourceItemId,
            clientOrderId: params.clientOrderId,
            returnedRows: updatedRows.length,
            authoritativeStatus: authoritative?.status ?? null,
          });
          this.logPerpPlacement({ outcome: "syncing" }, params, {
            reason: "rejected-status-cas-lost",
          });
          return { outcome: "syncing", reason: "status-write-failed" };
        }
        this.logPerpPlacement({ outcome: "rejected" }, params, {
          reason: verdict.reason,
        });
        return { outcome: "rejected" };
      }
      // Unknown transport outcome (HttpRequestError: timeout, abort, non-2xx):
      // preserve PENDING for cloid reconciliation. The venue MAY have accepted
      // this submission, so stamp `placed_at` now rather than leaving it null.
      // The reconciler ages a row from `placed_at ?? created_at` (worker
      // hyperliquid-order-sync.ts) precisely so a just-attempted row gets its
      // grace period from the attempt, not from a resumed row's stale
      // `created_at`; leaving this write out means that guard is defeated on
      // exactly the path it exists for, and a live fill can be cancelled from
      // under the follower before the venue evidence ever surfaces. A failed
      // write here must not shadow the original error: the caller still needs
      // to see the ambiguous outcome and retry/requeue as before.
      const [placedAtError] = await catchError(
      db
          .update(schema.orders)
          .set({ placedAt: placementNow })
          .where(legacyPendingIdentity(order.id)),
      );
      if (placedAtError) {
        logger.error(LOG_SERVICE, "[copy-mirror] perp placed_at stamp failed after ambiguous transport outcome", {
          followerUserId: params.followerUserId,
          coin: params.coin,
          clientOrderId: params.clientOrderId,
          error: placedAtError.message,
        });
      }
      throw error;
    }

    // Fresh/resumed opens are submitted as preformatted `Limit` + `Ioc`, while
    // REDUCE-ONLY closes use `Market`, which `resolveTif` (packages/hyperliquid/
    // src/client.ts) turns into TIF `Ioc`. Hyperliquid fills what it can
    // immediately and CANCELS any unfilled remainder rather than leaving it
    // resting. That is an acceptable outcome for a fresh open (the follower
    // simply opened a little less), but a REDUCE-ONLY close is the follower's
    // one-shot exit: an unfilled remainder here is leveraged exposure the
    // mirror silently leaves open while reporting success below. `result`
    // carries the venue's own report of what actually filled, so a real
    // shortfall is swept with one immediate follow-up IoC order before this
    // delivery is allowed to complete.
    //
    // What the sweep hands back is the cumulative size the venue POSITIVELY
    // reported filling across both legs, and it travels out with the result.
    // The close path's retire gate used to key on the size this placement was
    // ASKED for, which on a full source close always equals the mirrored
    // exposure, so a close that filled short retired the follower's stop over
    // the remainder the sweep had just measured. Null means "no fill could be
    // read", which is not zero: see `perpFilledSizeTotal`.
    let closeFilledSizeCoin: string | null = null;
    if (params.reduceOnly === true) {
      closeFilledSizeCoin = await this.sweepPerpCloseShortfall(
        client,
        params,
        input,
        perpOrderFilledSize(result),
        db,
      );
    }

    try {
      const updatedRows = await db
        .update(schema.orders)
        .set({ status: "SUBMITTED", statusUpdatedAt: placementNow, placedAt: placementNow })
        .where(and(
          eq(schema.orders.id, order.id),
          orderStatusTransitionCondition("SUBMITTED"),
        ))
        .returning({ id: schema.orders.id });
      if (updatedRows.length !== 1) {
        const authoritative = await this.readAuthoritativeOrder(
          order.id,
          params.followerUserId,
          params.clientOrderId,
          db,
        );
        throw new Error(
          `Hyperliquid acceptance CAS returned ${updatedRows.length} rows; ` +
            `authoritative status is ${authoritative?.status ?? "unknown"}`,
        );
      }
      this.logPerpPlacement({ outcome: "placed" }, params);
      return {
        outcome: "placed",
        ...(closeFilledSizeCoin === null ? {} : { filledSizeCoin: closeFilledSizeCoin }),
      };
    } catch (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] Hyperliquid accepted but status write failed", {
        followerUserId: params.followerUserId,
        coin: params.coin,
        clientOrderId: params.clientOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
      // The order IS live at Hyperliquid; only the local status write failed.
      this.logPerpPlacement({ outcome: "syncing" }, params, {
        reason: "status-write-failed-after-venue-accept",
      });
      return { outcome: "syncing", reason: "status-write-failed" };
    }
  }

  /**
   * Immediately re-submit the unfilled remainder of a reduce-only IoC close.
   *
   * Returns the cumulative size BOTH legs positively reported filling, or null
   * when nothing could be read at all. The caller needs this because a close
   * that fills short is otherwise indistinguishable from one that filled in
   * full: the placement reports "placed" either way, and the retire gate would
   * then tear the follower's stop down over the very remainder measured here.
   * Every early return below therefore yields the primary leg's own fill rather
   * than falling through to "unknown", so a remainder this function could not
   * clear still keeps the stop that covers it.
   *
   * `firstFilledSizeCoin` is null whenever `perpOrderFilledSize` could not
   * positively read the venue's report (see its docstring): nothing to
   * compare against, so this is a deliberate no-op, no worse than before this
   * fix existed.
   *
   * ONE follow-up attempt only. A thin book can swallow a second IoC just as
   * easily as the first, and this call cannot loop indefinitely without
   * turning a single poll into an unbounded synchronous chain of venue calls.
   * A remainder that survives the follow-up is still recorded on its own
   * order row (status SUBMITTED, `copymirror:`-prefixed like every other
   * mirror order), so the Hyperliquid reconciler finds and settles it from
   * the venue on its own schedule; nothing here waits on that.
   *
   * The sweep order cannot reuse `params.clientOrderId`: it is a second,
   * differently-sized order, and every other retry path in this function
   * depends on one cloid meaning one order (see the "recovered" resume check
   * above). Never throws: the PRIMARY leg already succeeded at the venue
   * and must still be reported placed regardless of how the sweep goes.
   */
  private async sweepPerpCloseShortfall(
    client: HyperliquidClient,
    params: PerpMirrorPlacementParams,
    input: PerpOrderSubmitInput,
    firstFilledSizeCoin: string | null,
    db: WorkerPoolDb = this.db,
  ): Promise<string | null> {
    const remaining = perpCloseShortfall(params.sizeCoin, firstFilledSizeCoin);
    // Either the primary filled in full, or its report was unreadable. Both
    // answers are already carried by `firstFilledSizeCoin` itself.
    if (!remaining) return firstFilledSizeCoin;

    const sweepClientOrderId = `${params.clientOrderId}:sweep`;
    const sweepInput: PerpOrderSubmitInput = {
      ...input,
      sizeCoin: remaining,
      cloid: sweepClientOrderId,
    };
    const [insertedSweep] = await this.db
      .insert(schema.orders)
      .values({
        ...toPerpOrderRow(sweepInput, params.followerUserId, params.brokerAccountId),
        brokerCredentialId: params.brokerCredentialId,
        notes: `[copy-mirror] IoC sweep for a stranded perp close remainder (primary ${params.clientOrderId})`,
        copySourceLabel: params.copySourceLabel ?? null,
      })
      .onConflictDoNothing({ target: schema.orders.clientOrderId })
      .returning();
    if (!insertedSweep) {
      // A sweep row already exists under this identity. A genuine re-entry of
      // this exact call is extraordinary, but the unique client_order_id is
      // the backstop either way: never place a second order under one identity.
      // The primary's fill is all this call knows, and it is short, so the stop
      // covering the remainder stays where it is.
      return firstFilledSizeCoin;
    }

    const [placeError, sweepResult] = await catchError(
      client.placeOrder({
        ...toPlacePerpOrderRequest(sweepInput),
        slippage: MIRROR_PERP_MARKET_SLIPPAGE,
      }),
    );
    if (placeError) {
      // Ambiguous transport or a definitive rejection. Leave this sweep row
      // exactly where any other perp order sits when its placement outcome is
      // unknown (PENDING, `copymirror:`-prefixed) for the reconciler to
      // resolve from the venue; do not throw, the primary leg already placed.
      logger.error(LOG_SERVICE, "[copy-mirror] perp close sweep attempt failed", {
        followerUserId: params.followerUserId,
        coin: params.coin,
        clientOrderId: sweepClientOrderId,
        remaining,
        error: placeError.message,
      });
      // Nothing filled that this call can vouch for beyond the primary leg.
      return firstFilledSizeCoin;
    }

    const sweepPlacedAt = await readDatabaseNow(db);
    await db
      .update(schema.orders)
      .set({ status: "SUBMITTED", statusUpdatedAt: sweepPlacedAt, placedAt: sweepPlacedAt })
      .where(eq(schema.orders.id, insertedSweep.id));

    const sweepFilledSizeCoin = perpOrderFilledSize(sweepResult);
    const stillShort = perpCloseShortfall(remaining, sweepFilledSizeCoin);
    if (stillShort) {
      // Exhausted the one bounded follow-up with a remainder still open. Not
      // silent: the sweep row itself is SUBMITTED with its real fill and will
      // be found and settled by the Hyperliquid reconciler like any other
      // perp order, but this is logged loudly because a leveraged position
      // is still open past both attempts this delivery made for it.
      //
      // Logging is no longer the ONLY thing that happens to it. The cumulative
      // fill returned below is what stops the caller retiring the follower's
      // take-profit and stop-loss over this remainder, which was the one place
      // the mirror could leave leveraged exposure open AND uncovered.
      logger.error(LOG_SERVICE, "[copy-mirror] perp close still short after one sweep attempt", {
        followerUserId: params.followerUserId,
        coin: params.coin,
        clientOrderId: sweepClientOrderId,
        remaining: stillShort,
      });
    }
    return perpFilledSizeTotal(firstFilledSizeCoin, sweepFilledSizeCoin);
  }

  private resolveTradingSymbol(cand: MirrorSourceCandidate): string | null {
    if (cand.assetType !== "OPTION") return cand.symbol;
    if (!cand.optionExpiration || !cand.optionStrike || !cand.optionType) return null;
    return buildOptionsSymbol(
      cand.symbol,
      cand.optionExpiration,
      cand.optionStrike,
      cand.optionType,
    );
  }

  /**
   * Best-effort fractional eligibility for an EQUITY symbol.
   *
   * The pure sizing math (`computeMirrorQty`) is already wired to honor an
   * `allowFractional` flag — but the local `orders.quantity` column is an
   * `integer`, so persisting a true fractional qty would either round-trip
   * through Postgres lossily or require a schema migration that touches every
   * order consumer. Until that migration lands this helper returns `false`
   * unconditionally and the worker floors qty to whole shares (preserving
   * today's behavior).
   *
   * The Alpaca SDK exposes per-asset `fractionable` on `client.getAsset()` and
   * we cache the result per poll cycle so the lookup is one HTTP per new symbol
   * once we wire it on.
   *
   * TODO(fractional): widen `orders.quantity` to numeric(20,6) and flip this to
   * actually call `client.getAsset(tradingSymbol).fractionable`. The
   * `computeMirrorQty` path + unit tests for the fractional branch are already
   * in place, so the flip is a one-line change here once the DB is ready.
   */
  private async isSymbolFractionable(
    client: AlpacaClient,
    cand: MirrorSourceCandidate,
    tradingSymbol: string,
  ): Promise<boolean> {
    if (cand.assetType !== "EQUITY") return false;
    // Intentionally inert until orders.quantity widens. See TODO above.
    void client;
    void tradingSymbol;
    return false;
  }

  /**
   * Best-effort current LONG share count for the follower's position in a
   * symbol. Returns 0 when there is no position (Alpaca returns a 404, which the
   * SDK surfaces as a throw), when the position is a SHORT, or on any read
   * failure — so a SELL mirror safely skips/declines rather than opening a short
   * on bad data. Never throws.
   */
  private async fetchLongQty(client: AlpacaClient, symbol: string): Promise<number> {
    try {
      const pos = await client.getPosition(symbol);
      if (!pos || pos.side !== "long") return 0;
      // `qty`, not `qty_available`. Per docs.alpaca.markets/us/reference/
      // getopenposition-1, `qty_available` is "Total number of shares
      // available minus open orders / locked for options covered call", so a
      // long that is fully reserved by the follower's OWN resting order (a
      // GTC stop-loss, a limit sell, an OCO/bracket leg) reads
      // qty_available=0 even though the position is entirely real. Reading
      // that here made a fully reserved long indistinguishable from no
      // position at all: `decideSellMirrorQty` skipped with
      // "no-long-position", and since the paired open had already filled
      // (nothing left in the delivery queue for `holdEquityCloseIfPairedOpen
      // Queued` to find), the close was marked completed with nothing placed
      // (alpaca-15). `qty` is the actual share count regardless of
      // reservation, which is what this function is documented to answer
      // ("current LONG share count"), and what `decideSellMirrorQty` clamps
      // to so a mirror never sells more than the account owns. Whether the
      // reserved portion can transact RIGHT NOW is Alpaca's own order
      // validation to enforce: a submission it refuses for that reason comes
      // back 403, which `classifyMirrorFailure` already treats as transient
      // (it is a property of the follower's other open order, and clears on
      // its own once that order fills or is cancelled), so the delivery
      // requeues instead of the exit being spent here.
      const qty = Math.floor(Number(pos.qty));
      return Number.isFinite(qty) && qty > 0 ? qty : 0;
    } catch (error) {
      if (errorStatus(error) === 404) return 0;
      throw error;
    }
  }

  /**
   * Best-effort current price for a symbol. Tries the latest trade, then the
   * snapshot. Returns 0 on failure so computeMirrorQty() yields 0 shares and the
   * candidate is safely skipped (no order on an unknown price).
   */
  private async fetchPrice(
    client: AlpacaClient,
    cand: MirrorSourceCandidate,
    tradingSymbol: string,
  ): Promise<number> {
    if (cand.assetType === "OPTION") {
      return this.fetchOptionPrice(client, tradingSymbol, cand.side);
    }

    let latestTradeError: unknown;
    try {
      const trade = await client.getLatestTrade(tradingSymbol);
      const p = Number(trade?.Price ?? trade?.price ?? trade?.p);
      if (Number.isFinite(p) && p > 0) return p;
    } catch (error) {
      latestTradeError = error;
    }
    try {
      const snap = await client.getSnapshot(tradingSymbol);
      const p = Number(
        snap?.LatestTrade?.Price ?? snap?.latestTrade?.p ?? snap?.MinuteBar?.Close,
      );
      if (Number.isFinite(p) && p > 0) return p;
    } catch (snapshotError) {
      if (classifyMirrorFailure(snapshotError).kind === "transient") throw snapshotError;
      if (latestTradeError && classifyMirrorFailure(latestTradeError).kind === "transient") {
        throw latestTradeError;
      }
    }
    if (latestTradeError && classifyMirrorFailure(latestTradeError).kind === "transient") {
      throw latestTradeError;
    }
    return 0;
  }

  private async fetchOptionPrice(
    client: AlpacaClient,
    occSymbol: string,
    side: "buy" | "sell",
  ): Promise<number> {
    try {
      const snap = await client.getLatestOptionQuote(occSymbol);
      const q = snap?.latestQuote;
      const bid = Number(q?.bp);
      const ask = Number(q?.ap);
      if (side === "buy" && Number.isFinite(ask) && ask > 0) return ask;
      if (side === "sell" && Number.isFinite(bid) && bid > 0) return bid;
      return 0;
    } catch (error) {
      if (classifyMirrorFailure(error).kind === "transient") throw error;
      return 0;
    }
  }

  /**
   * Count how many mirror orders this follower has placed today, identified by
   * the deterministic "copymirror:<followerUserId>:" client_order_id prefix. Used
   * to enforce the per-follow daily cap. Returns null on read failure so the
   * caller fails closed instead of placing without a trustworthy count.
   */
  /**
   * How many mirrors this follower has already had PLACED today.
   *
   * Counts by placement time, falling back to row creation for rows written
   * before `placed_at` existed. Counting by creation alone meant an order
   * stranded PENDING before midnight and resumed after it was counted against
   * neither day: not today, because it was created yesterday, and not
   * yesterday's total, which is already spent. The follower could then receive
   * the resumed order on top of a full day of fresh mirrors.
   *
   * `excludeOrderId` exists for RESUMES. The count is by `created_at` and
   * ignores status, so a row left PENDING earlier today is already inside it.
   * Counting it while deciding whether to re-place that same row lets it block
   * itself: the order holding the last slot reads as the cap being full and is
   * refused, so the slot is occupied by an order that never went out. A resume
   * is not an additional mirror, it is the same one finishing, so its own row is
   * excluded while every other row today still counts.
   */
  /**
   * Count authoritative daily slots for Hyperliquid non-reduce opens. Pending
   * and syncing intents reserve a slot regardless of age: a pre-midnight
   * Phase-A row can still reach the venue after midnight and must not be
   * leapfrogged by a second fresh signal.
   */
  private async countPerpDailySlots(
    followerUserId: string,
    excludeOrderId: string | undefined,
    db: WorkerPoolDb,
  ): Promise<number | null> {
    // Evaluate both boundaries in PostgreSQL. A worker clock skew or a session
    // timezone setting must not move a persisted reservation between days.
    const startOfDay = sql`date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const endOfDay = sql`(
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 day'
    ) AT TIME ZONE 'UTC'`;
    const attemptTimestamp = sql`/* coalesce(placed_at,created_at) legacy fallback */ (
      CASE
        WHEN ${schema.orders.status} = 'PENDING'
          AND ${schema.orders.syncReason} LIKE 'copy-mirror:perp-placement:%'
          AND ${schema.orders.lastSyncAttemptAt} IS NOT NULL
        THEN ${schema.orders.lastSyncAttemptAt}
        WHEN ${schema.orders.placedAt} IS NOT NULL
        THEN ${schema.orders.placedAt}
        ELSE ${schema.orders.createdAt}
      END
    )`;
    try {
      const [result] = await db
        .select({ value: count() })
        .from(schema.orders)
        .where(and(
          eq(schema.orders.userId, followerUserId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          like(schema.orders.clientOrderId, `copymirror:${followerUserId}:%`),
          // A positively known zero-fill IOC is an audit attempt, not a mirror
          // and not a daily-slot reservation. Phase C archives those attempts
          // under this suffix before requeueing the delivery.
          sql`${schema.orders.clientOrderId} NOT LIKE '%:zero-fill:%'`,
          sql`${schema.orders.reduceOnly} IS NOT TRUE`,
          excludeOrderId ? ne(schema.orders.id, excludeOrderId) : undefined,
          or(
            inArray(schema.orders.status, ["PENDING", "SYNCING"]),
            and(
              sql`${attemptTimestamp} >= ${startOfDay}`,
              sql`${attemptTimestamp} < ${endOfDay}`,
              or(
                isNotNull(schema.orders.placedAt),
                notInArray(schema.orders.status, ["REJECTED", "CANCELLED"]),
              ),
            ),
          ),
        ));
      return result?.value ?? 0;
    } catch (error) {
      logger.error(LOG_SERVICE, "[copy-mirror] countPerpDailySlots failed", {
        followerUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Return unresolved non-reduce open intents in deterministic creation order.
   * This is only used while the follower user row is locked, so the rank is a
   * reservation decision rather than an advisory snapshot. A missing query
   * surface is reported as null for lightweight test doubles; PostgreSQL's
   * WorkerPoolDb always exposes it.
   */
  private async listPerpUnresolvedSlots(
    followerUserId: string,
    db: WorkerPoolDb,
  ): Promise<Array<{ id: string; createdAt: Date }> | null> {
    try {
      const rows = await db.query.orders.findMany({
        where: and(
          eq(schema.orders.userId, followerUserId),
          eq(schema.orders.venue, "hyperliquid"),
          eq(schema.orders.assetType, "PERP"),
          like(schema.orders.clientOrderId, `copymirror:${followerUserId}:%`),
          sql`${schema.orders.reduceOnly} IS NOT TRUE`,
          inArray(schema.orders.status, ["PENDING", "SYNCING"]),
        ),
        columns: { id: true, createdAt: true },
        orderBy: [asc(schema.orders.createdAt), asc(schema.orders.id)],
      });
      return rows
        .filter((row): row is { id: string; createdAt: Date } =>
          typeof row.id === "string" && row.createdAt instanceof Date,
        )
        .sort((left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
        );
    } catch (error) {
      logger.warn(LOG_SERVICE, "[copy-mirror] unresolved perp slot rank unavailable", {
        followerUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async countMirrorsToday(
    followerUserId: string,
    excludeOrderId?: string,
    db: WorkerPoolDb = this.db,
  ): Promise<number | null> {
    // The database clock and an explicit UTC conversion are authoritative for
    // the day window. Never derive these bounds from the worker process clock
    // or from the PostgreSQL session timezone.
    const startOfDay = sql`date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const endOfDay = sql`(
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 day'
    ) AT TIME ZONE 'UTC'`;
    const attemptTimestamp = sql`/* coalesce(placed_at,created_at) legacy fallback */ (
      CASE
        WHEN ${schema.orders.status} = 'PENDING'
          AND ${schema.orders.syncReason} LIKE 'copy-mirror:perp-placement:%'
          AND ${schema.orders.lastSyncAttemptAt} IS NOT NULL
        THEN ${schema.orders.lastSyncAttemptAt}
        WHEN ${schema.orders.placedAt} IS NOT NULL
        THEN ${schema.orders.placedAt}
        ELSE ${schema.orders.createdAt}
      END
    )`;

    try {
      const [result] = await db
        .select({ value: count() })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.userId, followerUserId),
            sql`${attemptTimestamp} >= ${startOfDay}`,
            sql`${attemptTimestamp} < ${endOfDay}`,
            // The creation-time fallback is for LEGACY rows, not for orders that
            // never reached the venue. A definitive rejection leaves placed_at
            // null and the row REJECTED, and counting it spent a slot on an
            // order the follower never received: a run of invalid-market or
            // insufficient-margin failures could exhaust the cap and then refuse
            // the valid mirrors that followed.
            //
            // A row with placed_at set counts whatever its final status, because
            // it did reach the venue. Only the fallback is narrowed.
            or(
              isNotNull(schema.orders.placedAt),
              notInArray(schema.orders.status, ["REJECTED", "CANCELLED"]),
            ),
            like(schema.orders.clientOrderId, `copymirror:${followerUserId}:%`),
            sql`${schema.orders.clientOrderId} NOT LIKE '%:zero-fill:%'`,
            excludeOrderId ? ne(schema.orders.id, excludeOrderId) : undefined,
          ),
        );
      return result?.value ?? 0;
    } catch (err) {
      logger.error(LOG_SERVICE, "[copy-mirror] countMirrorsToday failed", {
        followerUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Serialize a new Alpaca mirror against the follower's current coin cap.
   *
   * The user row is the same per-follower serialization point used by the
   * Hyperliquid Phase-A reservation. Holding it through the PENDING insert and
   * broker submission means two follows cannot both observe the same remaining
   * exposure. The transaction callback catches broker errors so the durable
   * PENDING/SYNCING/REJECTED state can commit before the original error is
   * rethrown to the delivery queue.
   */
  private async placeEquityMirrorOpenWithCap(
    client: AlpacaClient,
    params: {
      followerUserId: string;
      followId?: string;
      symbol: string;
      tradingSymbol: string;
      side: "buy" | "sell";
      qty: number;
      clientOrderId: string;
      brokerAccountId: string | null;
      brokerCredentialId: string | null;
      isPaper: boolean;
      assetType: AlpacaMirrorAssetType;
      optionExpiration?: string;
      optionStrike?: number;
      optionType?: MirrorOptionType;
      tradeAction?: MirrorTradeAction;
      direction?: TradeDirection;
      limitPrice?: number;
      copySourceLabel?: string;
      maxCoinSize: number | null;
      maxTradeSize: number | null;
      stagedMaxCoinSize?: number | null;
      stagedMaxTradeSize?: number | null;
      orderDollars?: number;
      reservedOrderId?: string;
    },
  ): Promise<MirrorProcessOutcome> {
    const normalizedAction = normalizeTradeAction(params.tradeAction);
    const ordinaryAction = params.side === "buy" ? "Buy" : "Sell";
    const preparedTradeAction = normalizedAction === "Buy" || normalizedAction === "Sell"
      ? params.direction === "short" && params.assetType === "EQUITY"
        ? normalizedAction === "Buy" ? "BuyToCover" : "SellShort"
        : normalizedAction
      : normalizedAction ?? (
          params.direction === "short" && params.assetType === "EQUITY"
            ? params.side === "buy" ? "BuyToCover" : "SellShort"
            : ordinaryAction
        );
    if (!params.reservedOrderId && !isClosingDelivery({
      sourceItemId: params.clientOrderId,
      followerUserId: params.followerUserId,
      symbol: params.symbol,
      assetType: params.assetType,
      side: params.side,
      tradeAction: params.tradeAction,
      direction: params.direction,
    })) {
      await this.db
        .insert(schema.orders)
        .values({
          userId: params.followerUserId,
          symbol: params.symbol,
          assetType: params.assetType,
          orderType: params.assetType === "OPTION" ? "Limit" : "Market",
          tradeAction: preparedTradeAction,
          direction: tradeActionDirection(preparedTradeAction) ?? params.direction ?? "long",
          quantity: params.qty,
          limitPrice: params.assetType === "OPTION" ? String(params.limitPrice) : undefined,
          optionExpiration: params.optionExpiration,
          optionStrike: params.optionStrike !== undefined ? String(params.optionStrike) : undefined,
          optionType: params.optionType,
          brokerAccountId: params.brokerAccountId,
          brokerCredentialId: params.brokerCredentialId,
          status: "PENDING",
          clientOrderId: params.clientOrderId,
          brokerClientOrderId: createBrokerClientOrderId(
            params.followerUserId,
            params.clientOrderId,
            "copy",
          ),
          notes: "[copy-mirror] auto-mirrored trade",
          copySourceLabel: params.copySourceLabel ?? null,
        })
        .onConflictDoNothing({ target: schema.orders.clientOrderId })
        .returning({ id: schema.orders.id });
    }
    const place = (db?: WorkerPoolDb, placementClient = client) => this.placeMirrorOrder(placementClient, {
      ...params,
      ...(db ? { db } : {}),
    });
    // A close never creates exposure and must remain exempt from every cap. The
    // helper is also used for legacy test/direct callers without a follow id;
    // the ordinary placement path remains available when no cap is configured.
    if (isClosingDelivery({
      sourceItemId: params.clientOrderId,
      followerUserId: params.followerUserId,
      symbol: params.symbol,
      assetType: params.assetType,
      side: params.side,
      tradeAction: params.tradeAction,
      direction: params.direction,
    }) ||
      (params.maxCoinSize === null && params.maxTradeSize === null && !params.followId)) {
      return place();
    }

    const dbWithTransaction = this.db as WorkerPoolDb & {
      transaction?: <R>(callback: (tx: WorkerPoolDb) => Promise<R>) => Promise<R>;
    };
    const dbAny = this.db as any;
    if (typeof dbWithTransaction.transaction !== "function" || typeof dbAny.select !== "function") {
      // A configured total-exposure cap without a transaction boundary is not
      // safe to enforce: a read followed by a broker call can race another
      // follow. Refuse rather than silently downgrade to an advisory check.
      return params.maxCoinSize !== null ? "consent-unverifiable" : place();
    }

    let thrown: unknown;
    const result = await dbWithTransaction.transaction(async (tx) => {
      const txAny = tx as any;
      const lockBuilder = txAny.select({ id: schema.users.id })
        ?.from?.(schema.users)
        ?.where?.(eq(schema.users.id, params.followerUserId));
      if (!lockBuilder || typeof lockBuilder.for !== "function") {
        return params.maxCoinSize !== null
          ? "consent-unverifiable" as MirrorProcessOutcome
          : await place(tx);
      }
      const users = await lockBuilder.for("update") as Array<{ id?: string }>;
      if (users.length !== 1 || users[0]?.id !== params.followerUserId) {
        return "consent-unverifiable" as MirrorProcessOutcome;
      }

      // Re-read and lock the follow itself. This closes the gap between the
      // earlier consent check and the final venue call when a user lowers a cap
      // while the worker is sizing the account.
      let lockedClient = client;
      if (params.followId) {
        const followBuilder = txAny.select({
          id: schema.copyTradeFollows.id,
          followerUserId: schema.copyTradeFollows.followerUserId,
          autoMirror: schema.copyTradeFollows.autoMirror,
          credentialId: schema.copyTradeFollows.credentialId,
          maxTradeSize: schema.copyTradeFollows.maxTradeSize,
          maxCoinSize: schema.copyTradeFollows.maxCoinSize,
        })
          ?.from?.(schema.copyTradeFollows)
          ?.where?.(and(
            eq(schema.copyTradeFollows.id, params.followId),
            eq(schema.copyTradeFollows.followerUserId, params.followerUserId),
          ));
        if (!followBuilder || typeof followBuilder.for !== "function") {
          return "consent-unverifiable" as MirrorProcessOutcome;
        }
        const followRows = await followBuilder.for("update") as Array<Record<string, unknown>>;
        const follow = followRows[0];
        if (
          !follow ||
          follow.id !== params.followId ||
          follow.followerUserId !== params.followerUserId ||
          follow.autoMirror !== true ||
          follow.credentialId !== params.brokerCredentialId
        ) {
          return "consent-withdrawn" as MirrorProcessOutcome;
        }
        const currentTradeCap = resolveEffectiveMirrorCap(
          params.stagedMaxTradeSize,
          follow.maxTradeSize,
        );
        const currentCoinCap = resolveEffectiveMirrorCap(
          params.stagedMaxCoinSize,
          follow.maxCoinSize,
        );
        if (!currentTradeCap.ok || !currentCoinCap.ok) {
          return "consent-unverifiable" as MirrorProcessOutcome;
        }
        params.maxTradeSize = currentTradeCap.value;
        params.maxCoinSize = currentCoinCap.value;

        const lockedCredentials = await getDecryptedCredentials(
          tx as never,
          params.followerUserId,
          { provider: "alpaca", credentialId: params.brokerCredentialId ?? "" },
        );
        if (!lockedCredentials.username || !lockedCredentials.accessToken) {
          return "unusable-credential" as MirrorProcessOutcome;
        }
        const lockedIsPaper = isPaperAccount(lockedCredentials.accountType);
        if (lockedIsPaper !== params.isPaper) {
          throw Object.assign(
            new Error("equity open held back: credential environment changed"),
            { code: "EAGAIN" },
          );
        }
        lockedClient = new AlpacaClient({
          keyId: lockedCredentials.username,
          secretKey: lockedCredentials.accessToken,
          paper: lockedIsPaper,
        });
        const [accountError, account] = await catchError(lockedClient.getAccount());
        if (accountError || !account?.account_number?.trim()) {
          throw Object.assign(
            new Error("equity open held back: live Alpaca account is unreadable"),
            { code: "EAGAIN" },
          );
        }
        if (
          account.account_number.trim().toLowerCase() !==
          params.brokerAccountId?.trim().toLowerCase()
        ) {
          throw Object.assign(
            new Error("equity open held back: credential account changed"),
            { code: "EAGAIN" },
          );
        }
      }

      if (
        params.maxTradeSize !== null &&
        params.orderDollars !== undefined &&
        params.orderDollars > params.maxTradeSize
      ) {
        return "dollar-cap" as MirrorProcessOutcome;
      }

      if (params.maxCoinSize !== null) {
        let rows: Array<MirroredEquityOrderRow & {
          id?: string;
          brokerAccountId?: string | null;
          brokerCredentialId?: string | null;
        }>;
        try {
          rows = await tx.query.orders.findMany({
            where: and(
              eq(schema.orders.userId, params.followerUserId),
              eq(schema.orders.assetType, params.assetType),
              eq(schema.orders.symbol, params.symbol),
              like(schema.orders.clientOrderId, `copymirror:${params.followerUserId}:%`),
            ),
            columns: {
              id: true,
              tradeAction: true,
              status: true,
              quantity: true,
              executedQuantity: true,
              brokerAccountId: true,
              brokerCredentialId: true,
            },
          });
        } catch (error) {
          logger.warn(LOG_SERVICE, "[copy-mirror] coin-cap exposure read failed", {
            followerUserId: params.followerUserId,
            sourceItemId: params.clientOrderId,
            symbol: params.symbol,
            error: error instanceof Error ? error.message : String(error),
          });
          return "consent-unverifiable" as MirrorProcessOutcome;
        }
        const targetAccount = params.brokerAccountId?.trim().toLowerCase() ?? "";
        const targetCredential = params.brokerCredentialId?.trim() ?? "";
        const relevant = rows.filter((row) => {
          if (params.reservedOrderId && row.id === params.reservedOrderId) return false;
          const account = row.brokerAccountId?.trim().toLowerCase() ?? "";
          const credential = row.brokerCredentialId?.trim() ?? "";
          // Account id is the primary destination key. Legacy rows without an
          // account id remain attributable when their credential is the same;
          // unknown rows are included conservatively rather than under-reading.
          if (targetAccount !== "" && account !== "") return account === targetAccount;
          return targetCredential !== "" && credential === targetCredential;
        });
        const currentExposure = netReservedMirroredEquityQty(relevant);
        if (!mirrorCoinCapAllows({
          currentExposure,
          requestedExposure: params.qty,
          maxCoinSize: params.maxCoinSize,
        })) {
          logger.info(LOG_SERVICE, "[copy-mirror] skip: max-coin-size", {
            followerUserId: params.followerUserId,
            sourceItemId: params.clientOrderId,
            symbol: params.symbol,
            assetType: params.assetType,
            currentExposure,
            requestedExposure: params.qty,
            maxCoinSize: params.maxCoinSize,
          });
          return "coin-cap" as MirrorProcessOutcome;
        }
      }

      try {
        return await place(tx, lockedClient);
      } catch (error) {
        // Commit the row state written by placeMirrorOrder, then rethrow so the
        // delivery remains retryable. Rolling back here would erase the
        // PENDING/SYNCING marker and lose the reservation after an ambiguous
        // broker response.
        thrown = error;
        return "syncing" as MirrorProcessOutcome;
      }
    });
    if (thrown !== undefined) throw thrown;
    return result;
  }

  /**
   * ========================================================================
   *  ⚠️  REAL ORDER EXECUTION HAPPENS HERE — AND NOWHERE ELSE.  ⚠️
   * ========================================================================
   *
   * Mirrors the order-submission flow from apps/api/src/routers/orders.ts: insert
   * a local order row carrying the legacy deterministic logical key, then submit
   * a market order to Alpaca with a bounded tenant-derived broker ID. Both remain
   * deterministic for the same follower and source trade.
   *
   * Single isolated method so a reviewer can see exactly where money moves. On
   * LIVE accounts (only reachable when COPY_TRADE_AUTOMIRROR_ALLOW_LIVE="true")
   * this is real money. The whole service is flag-gated off by default, so this
   * method is unreachable until an operator deliberately enables it.
   */
  private async placeMirrorOrder(
    client: AlpacaClient,
    params: {
      followerUserId: string;
      symbol: string;
      tradingSymbol: string;
      side: "buy" | "sell";
      qty: number;
      clientOrderId: string;
      brokerAccountId: string | null;
      brokerCredentialId: string | null;
      isPaper: boolean;
      assetType: AlpacaMirrorAssetType;
      optionExpiration?: string;
      optionStrike?: number;
      optionType?: MirrorOptionType;
      tradeAction?: MirrorTradeAction;
      direction?: TradeDirection;
      limitPrice?: number;
      /** Display name of the followed trader, stored for UI attribution. */
      copySourceLabel?: string;
      /** Transaction handle used by the equity exposure reservation. */
      db?: WorkerPoolDb;
    },
  ): Promise<MirrorProcessOutcome> {
    const orderDb = params.db ?? this.db;
    const normalizedAction = normalizeTradeAction(params.tradeAction);
    const ordinaryAction = params.side === "buy" ? "Buy" : "Sell";
    const tradeAction = normalizedAction === "Buy" || normalizedAction === "Sell"
      ? params.direction === "short" && params.assetType === "EQUITY"
        ? normalizedAction === "Buy" ? "BuyToCover" : "SellShort"
        : normalizedAction
      : normalizedAction ?? (
          params.direction === "short" && params.assetType === "EQUITY"
            ? params.side === "buy" ? "BuyToCover" : "SellShort"
            : ordinaryAction
        );
    const side = tradeActionSide(tradeAction);
    if (
      side === null ||
      side !== params.side ||
      !isSupportedAlpacaMirrorAction(params.assetType, tradeAction) ||
      (params.direction !== undefined && tradeActionDirection(tradeAction) !== params.direction)
    ) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip — unsupported trade action", {
        followerUserId: params.followerUserId,
        clientOrderId: params.clientOrderId,
        assetType: params.assetType,
        tradeAction,
        direction: params.direction ?? null,
      });
      return "unsupported-trade-action";
    }
    if (
      params.assetType === "OPTION" &&
      (!Number.isFinite(params.limitPrice) || (params.limitPrice ?? 0) <= 0)
    ) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip — missing option limit price", {
        followerUserId: params.followerUserId,
        clientOrderId: params.clientOrderId,
      });
      return "missing-option-contract";
    }

    const brokerClientOrderId = createBrokerClientOrderId(
      params.followerUserId,
      params.clientOrderId,
      "copy",
    );

    // 1) Record the order locally FIRST (PENDING) with both the logical dedupe
    //    key and the exact broker client ID used for reconciliation.
    //    is the durable dedupe marker even if the broker call fails after.
    const [insertedOrder] = await orderDb
      .insert(schema.orders)
      .values({
        userId: params.followerUserId,
        symbol: params.symbol,
        assetType: params.assetType,
        orderType: params.assetType === "OPTION" ? "Limit" : "Market",
        tradeAction,
        direction: tradeActionDirection(tradeAction) ?? params.direction ?? "long",
        quantity: params.qty,
        limitPrice:
          params.assetType === "OPTION" ? String(params.limitPrice) : undefined,
        optionExpiration: params.optionExpiration,
        optionStrike: params.optionStrike !== undefined ? String(params.optionStrike) : undefined,
        optionType: params.optionType,
        brokerAccountId: params.brokerAccountId,
        brokerCredentialId: params.brokerCredentialId,
        status: "PENDING",
        clientOrderId: params.clientOrderId,
        brokerClientOrderId,
        notes: "[copy-mirror] auto-mirrored trade",
        copySourceLabel: params.copySourceLabel ?? null,
      })
      // Atomic cross-cycle dedupe: the unique index on client_order_id makes a
      // duplicate insert a no-op, so an overlapping cycle that already recorded
      // this (follower, source trade) yields no row -> we skip instead of placing
      // a second real order. This is the durable guarantee; the broker-side
      // client_order_id idempotency is only defense-in-depth.
      .onConflictDoNothing({ target: schema.orders.clientOrderId })
      .returning();

    const order = insertedOrder ?? await orderDb.query.orders.findFirst({
      where: eq(schema.orders.clientOrderId, params.clientOrderId),
    });
    // A reused row is a genuine duplicate only once its outcome is settled.
    // PENDING is the pre-existing "never got an answer" marker the recovery
    // block below already resumes from. SYNCING with no brokerOrderId is the
    // marker the isAlpacaAmbiguousOrderError catch further down leaves when
    // an earlier attempt's own outcome was itself unknown (alpaca-01):
    // bailing out here as "duplicate" would retire the delivery while
    // nothing may exist at the broker, spending a one-shot exit on an order
    // that was never placed. SYNCING WITH a brokerOrderId (the
    // accepted-but-local-persistence-failed branch below) is excluded on
    // purpose: that row is a confirmed broker order and must never be
    // resubmitted.
    const unresolvedLocally =
      order?.status === "PENDING" ||
      (order?.status === "SYNCING" && !order?.brokerOrderId);
    if (!order || (!insertedOrder && !unresolvedLocally)) {
      logger.info(LOG_SERVICE, "[copy-mirror] skip — already mirrored (client_order_id exists)", {
        followerUserId: params.followerUserId,
        clientOrderId: params.clientOrderId,
      });
      return "duplicate";
    }
    const submissionQty = insertedOrder ? params.qty : order.quantity;
    const storedLimitPrice = order.limitPrice === null ? undefined : Number(order.limitPrice);
    const submissionLimitPrice = insertedOrder ? params.limitPrice : storedLimitPrice;

    // 2) Submit to Alpaca with a bounded tenant-derived form of the logical key.
    //    Market / day order; options use the compact OCC symbol and explicit
    //    position_intent.
    try {
      // A previous attempt may have reached Alpaca while its HTTP response or
      // our subsequent DB update was lost. Reconcile by the SAME deterministic
      // client id before another POST so restart retries cannot duplicate money.
      //
      // Match what is actually submitted: brokerClientOrderId, the bounded
      // "rst-copy-<hash>" form. The logical key ("copymirror:<follower>:<source>")
      // is about 89 chars and createOrder rejects anything over
      // ALPACA_CLIENT_ORDER_ID_MAX_LENGTH (48), so comparing against it alone
      // could never match and this branch never fired. The raw form is still
      // accepted because mirrors placed before the bounded id existed do carry
      // it at the broker, the same legacy-plus-derived pairing the order and
      // position routers use when attributing copy trades.
      if (!insertedOrder) {
        let recovered: Awaited<ReturnType<AlpacaClient["getOrderByClientId"]>> | undefined;
        if (typeof client.getOrderByClientId === "function") {
          try {
            recovered = await client.getOrderByClientId(brokerClientOrderId);
          } catch (lookupError) {
            // A clean 404 is the only evidence that this exact broker cloid is
            // absent. Any timeout/rate-limit/unknown response keeps the row
            // unresolved and prevents a second POST.
            if (errorStatus(lookupError) !== 404) throw lookupError;
          }
        }
        if (!recovered) {
          // Rows created before the bounded broker cloid was introduced may
          // still carry the logical id. Match both forms in the bounded scan:
          // an eventually-consistent list can also reveal the exact cloid after
          // its point lookup returned a clean 404.
          const brokerOrders = await client.getOrders("all", 500, true);
          recovered = brokerOrders.find(
            (brokerOrder) =>
              brokerOrder.client_order_id === brokerClientOrderId ||
              brokerOrder.client_order_id === params.clientOrderId,
          );
        }
        if (recovered) {
          const updatedRows = await orderDb
            .update(schema.orders)
            .set({ status: "SUBMITTED", brokerOrderId: recovered.id, placedAt: new Date() })
            .where(and(
              eq(schema.orders.id, order.id),
              orderStatusTransitionCondition("SUBMITTED"),
              preserveBrokerOrderIdCondition(recovered.id),
            ))
            .returning({ id: schema.orders.id });
          if (updatedRows.length !== 1) {
            const authoritative = await this.readAuthoritativeOrder(
              order.id,
              params.followerUserId,
              params.clientOrderId,
              orderDb,
            );
            logger.warn(LOG_SERVICE, "[copy-mirror] recovered Alpaca acceptance CAS lost", {
              followerUserId: params.followerUserId,
              clientOrderId: params.clientOrderId,
              brokerOrderId: recovered.id,
              returnedRows: updatedRows.length,
              authoritativeStatus: authoritative?.status ?? null,
            });
            return "syncing";
          }
          return "placed";
        }
      }

      const mirrorOrderType = params.assetType === "OPTION" ? "limit" : "market";
      const orderRequest = {
        symbol: params.tradingSymbol,
        qty: submissionQty,
        side,
        type: mirrorOrderType,
        // Equity mirrors are market/DAY; option mirrors are limit, so a mirrored
        // limit SELL rests as GTC while limit BUYs stay DAY. resolveTimeInForce
        // keeps this consistent with the manual trade path.
        time_in_force: resolveTimeInForce({
          assetType: params.assetType,
          orderType: mirrorOrderType,
          side,
          requested: "day",
        }),
        client_order_id: brokerClientOrderId,
      } as Parameters<AlpacaClient["createOrder"]>[0];

      if (params.assetType === "OPTION") {
        orderRequest.extended_hours = false;
        orderRequest.limit_price = submissionLimitPrice!;
        if (tradeAction === "BuyToOpen" || tradeAction === "SellToClose") {
          orderRequest.position_intent = optionPositionIntent(tradeAction);
        }
      } else {
        // Equity mirrors carry no order_class/reduce-only flag, so without an
        // explicit position_intent Alpaca infers open-vs-close from account
        // state alone: a BUY on a follower who happens to be short the same
        // symbol from their own trading executes as a cover instead of opening
        // the mirrored long this row records (alpaca-14). A mirrored BUY only
        // ever opens/adds to a mirrored long — copy-mirror never intentionally
        // opens a short (see the "never open a naked short by mirroring"
        // guards on the SELL path above) — and a mirrored SELL is only ever
        // reached after fetchLongQty/decideSellMirrorQty confirm it is closing
        // an existing mirrored long, so the mapping is unconditional on side.
        orderRequest.position_intent = params.side === "buy" ? "buy_to_open" : "sell_to_close";
      }

      const result = await client.createOrder(orderRequest);

      try {
        const updatedRows = await orderDb
          .update(schema.orders)
          .set({
            status: "SUBMITTED",
            brokerOrderId: result.id,
            syncReason: null,
            statusUpdatedAt: new Date(),
            placedAt: new Date(),
          })
          .where(and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.userId, params.followerUserId),
            eq(schema.orders.clientOrderId, params.clientOrderId),
            orderStatusTransitionCondition("SUBMITTED"),
            preserveBrokerOrderIdCondition(result.id),
          ))
          .returning({ id: schema.orders.id });
        if (updatedRows.length !== 1) {
          const authoritative = await this.readAuthoritativeOrder(
            order.id,
            params.followerUserId,
            params.clientOrderId,
            orderDb,
          );
          throw new Error(
            `Alpaca acceptance CAS returned ${updatedRows.length} rows; ` +
              `authoritative status is ${authoritative?.status ?? "unknown"}`,
          );
        }
      } catch (persistError) {
        logger.error(LOG_SERVICE, "[copy-mirror] broker accepted but local persistence failed", {
          followerUserId: params.followerUserId,
          brokerOrderId: result.id,
          clientOrderId: params.clientOrderId,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
        const authoritative = await this.readAuthoritativeOrder(
          order.id,
          params.followerUserId,
          params.clientOrderId,
          orderDb,
        );
        if (authoritative && !["PENDING", "SYNCING"].includes(authoritative.status)) {
          logger.warn(LOG_SERVICE, "[copy-mirror] accepted order already advanced during persistence", {
            followerUserId: params.followerUserId,
            clientOrderId: params.clientOrderId,
            brokerOrderId: result.id,
            authoritativeStatus: authoritative.status,
          });
          return "syncing";
        }

        try {
          const syncingRows = await orderDb
            .update(schema.orders)
            .set({
              status: "SYNCING",
              brokerOrderId: result.id,
              syncReason: `Broker accepted ${result.id}; local acceptance persistence failed`,
              syncAttempts: 1,
              lastSyncAttemptAt: new Date(),
              statusUpdatedAt: new Date(),
            })
            .where(and(
              eq(schema.orders.id, order.id),
              eq(schema.orders.userId, params.followerUserId),
              eq(schema.orders.clientOrderId, params.clientOrderId),
              orderStatusTransitionCondition("SYNCING"),
              preserveBrokerOrderIdCondition(result.id),
            ))
            .returning({ id: schema.orders.id });
          if (syncingRows.length !== 1) {
            const afterFallback = await this.readAuthoritativeOrder(
              order.id,
              params.followerUserId,
              params.clientOrderId,
              orderDb,
            );
            logger.warn(LOG_SERVICE, "[copy-mirror] accepted-order syncing CAS was not singular", {
              followerUserId: params.followerUserId,
              clientOrderId: params.clientOrderId,
              brokerOrderId: result.id,
              returnedRows: syncingRows.length,
              authoritativeStatus: afterFallback?.status ?? null,
            });
          }
        } catch (syncError) {
          logger.error(LOG_SERVICE, "[copy-mirror] failed to mark accepted order for reconciliation", {
            followerUserId: params.followerUserId,
            brokerOrderId: result.id,
            clientOrderId: params.clientOrderId,
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
        }
        return "syncing";
      }

      // NOT PUBLISHED TO social_trades, deliberately.
      //
      // A mirror is an echo of somebody else's decision, and social_trades is
      // the exact table discovery reads back as a SOURCE. A published mirror is
      // indistinguishable from a hand-placed trade there (the only filter is the
      // poll window), so it becomes a candidate for anyone following the
      // follower. Two people who auto-mirror each other, which is an ordinary
      // thing for two people who copy each other, then turn one real buy into a
      // chain of real market orders, one hop every poll, each hop resized from
      // scratch against the receiving account. Nothing ends that chain except
      // the per-follower daily cap, and a cap is a bound, not consent.
      //
      // Automatic publication does not make a mirrored order a new source: the
      // follower did not originate that decision. The Hyperliquid reconciler
      // refuses the same publish for the same
      // reason (`isAutoMirroredOrder`, hyperliquid-order-sync.ts); every order
      // this method places carries the `copymirror:` client_order_id that
      // predicate tests, so the equity path refuses it outright here rather than
      // re-deriving provenance it already knows.
      //
      // Discovery carries the same refusal (`isAutoMirroredClientOrderId` in
      // copy-mirror-candidate-sources.ts) because rows published before this
      // cannot be unpublished.

      logger.warn(LOG_SERVICE, "[copy-mirror] PLACED mirror order", {
        followerUserId: params.followerUserId,
        symbol: params.symbol,
        tradingSymbol: params.tradingSymbol,
        assetType: params.assetType,
        side,
        qty: submissionQty,
        isPaper: params.isPaper,
        brokerOrderId: result.id,
        clientOrderId: params.clientOrderId,
      });
      return "placed";
    } catch (err) {
      const failure = classifyMirrorFailure(err);
      if (isAlpacaAmbiguousOrderError(err)) {
        try {
          const syncingRows = await orderDb
            .update(schema.orders)
            .set({
              status: "SYNCING",
              syncReason: "Alpaca copy-mirror submission outcome is ambiguous",
              syncAttempts: 1,
              lastSyncAttemptAt: new Date(),
              statusUpdatedAt: new Date(),
            })
            .where(and(
              eq(schema.orders.id, order.id),
              eq(schema.orders.userId, params.followerUserId),
              eq(schema.orders.clientOrderId, params.clientOrderId),
              orderStatusTransitionCondition("SYNCING"),
            ))
            .returning({ id: schema.orders.id });
          if (syncingRows.length !== 1) {
            const authoritative = await this.readAuthoritativeOrder(
              order.id,
              params.followerUserId,
              params.clientOrderId,
              orderDb,
            );
            logger.warn(LOG_SERVICE, "[copy-mirror] ambiguous Alpaca status CAS was not singular", {
              followerUserId: params.followerUserId,
              clientOrderId: params.clientOrderId,
              returnedRows: syncingRows.length,
              authoritativeStatus: authoritative?.status ?? null,
            });
          }
        } catch (syncError) {
          logger.error(LOG_SERVICE, "[copy-mirror] failed to persist ambiguous order state", {
            followerUserId: params.followerUserId,
            clientOrderId: params.clientOrderId,
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
        }
        // Thrown rather than returned: a returned outcome completes the
        // DELIVERY (poll() -> markDeliveryCompleted), which is terminal, and
        // an ambiguous create means we do not yet know whether the mirror
        // exists at the broker (alpaca-01). EAGAIN classifies as transient,
        // so markDeliveryFailed requeues instead of retiring the intent --
        // for a close, the one-shot exit, this is exempt from the attempt
        // ceiling entirely, the same treatment every other "cannot tell yet"
        // branch in this file gets. The retry re-enters this same method:
        // the row is still SYNCING with no brokerOrderId, and the duplicate
        // guard above lets exactly that shape fall through to the recovery
        // scan and a safe re-POST under the same deterministic
        // client_order_id, instead of bailing out as already-mirrored.
        throw Object.assign(
          new Error("Alpaca copy-mirror submission outcome is ambiguous, deferring for retry"),
          { code: "EAGAIN" },
        );
      }
      if (failure.kind === "permanent") {
        const updatedRows = await orderDb
          .update(schema.orders)
          .set({
            status: "REJECTED",
            notes: `[copy-mirror] submit failed permanently: ${failure.message}`,
          })
          .where(and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.userId, params.followerUserId),
            eq(schema.orders.clientOrderId, params.clientOrderId),
            orderStatusTransitionCondition("REJECTED"),
          ))
          .returning({ id: schema.orders.id });
        if (updatedRows.length !== 1) {
          const authoritative = await this.readAuthoritativeOrder(
            order.id,
            params.followerUserId,
            params.clientOrderId,
            orderDb,
          );
          logger.warn(LOG_SERVICE, "[copy-mirror] Alpaca rejection status CAS lost", {
            followerUserId: params.followerUserId,
            clientOrderId: params.clientOrderId,
            returnedRows: updatedRows.length,
            authoritativeStatus: authoritative?.status ?? null,
          });
          return "syncing";
        }
      }

      logger[failure.kind === "transient" ? "warn" : "error"](
        LOG_SERVICE,
        "[copy-mirror] order submission failed",
        {
          followerUserId: params.followerUserId,
          symbol: params.symbol,
          tradingSymbol: params.tradingSymbol,
          assetType: params.assetType,
          clientOrderId: params.clientOrderId,
          failureKind: failure.kind,
          error: failure.message,
        },
      );
      throw err;
    }
  }
}

// Re-export the shared cap defaults + sizing type so the worker entrypoint / ops
// can reference a single source of truth without reaching into the api package.
export { DEFAULT_MIRROR_DAILY_CAP, DEFAULT_MIRROR_MAX_ORDER_DOLLARS };
export type { SizingMode };
