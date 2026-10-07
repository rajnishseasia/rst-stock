/**
 * PURE consent and staleness guards for the copy-mirror delivery queue.
 *
 * Split out of `copy-mirror.ts` (audit H7) so the checks that stand between a
 * queued intent and a real order on someone else's account are unit testable
 * without a client, a DB or a poller. No IO here.
 *
 * BOTH venues are covered: the Hyperliquid perp path and the Alpaca path that
 * mirrors stocks and options. The guards were written for perps first and for a
 * while applied ONLY there, which meant withdrawing consent stopped a staged
 * leveraged order but not a staged equity one. The queue is the same queue and
 * the failure is the same failure, so the rules are the same rules.
 *
 * The delivery queue is durable on purpose: a staged (follower, source trade)
 * row survives restarts and is retried until it succeeds. That durability was
 * unbounded in three separate ways, and each one is a way to place an order the
 * follower never agreed to:
 *
 *  1. NO AGE BOUND. A delivery that failed transiently for hours kept its
 *     original intent and eventually fired. An OPEN sized against a market that
 *     has since moved is not the trade the source made; it is a new trade
 *     nobody asked for, entered at a price nobody looked at. That is true of a
 *     leveraged perp entry and of a stock or option entry alike.
 *
 *  2. NO ATTEMPT CEILING. A permanently-shaped failure that classified as
 *     transient was requeued forever, so the same intent stayed armed
 *     indefinitely and the queue never drained.
 *
 *  3. THE FOLLOW ROW WAS READ ONCE, AT DISCOVERY. Everything after that ran off
 *     the frozen candidate payload. Turning auto-mirror off, switching the
 *     destination account, or unfollowing entirely changed nothing about an
 *     already-staged delivery: the order still went out, against consent that
 *     had already been withdrawn.
 *
 * Every ambiguous input here resolves to a skip. An age we cannot compute is
 * "we do not know how old this is", never "it is fresh"; a follow row we cannot
 * match is "we cannot show this was authorized", never "it was".
 */

/** Deliveries stop retrying after this many attempts and are failed terminally. */
export const MIRROR_MAX_DELIVERY_ATTEMPTS = 8;

/**
 * Default age bound for a perp OPEN intent, measured from the SOURCE event, not
 * from when we staged it. Fifteen minutes is thirty poll cycles: long enough to
 * ride out a broker or RPC outage, short enough that the mirror is still a copy
 * of the source trade rather than a fresh unreviewed entry.
 */
export const DEFAULT_PERP_INTENT_MAX_AGE_MS = 15 * 60_000;

/**
 * Default age bound for an Alpaca (stock or option) OPEN intent. Same fifteen
 * minutes, same reasoning, and if anything the equity case argues for it harder:
 * the market closes. A delivery wedged at 15:58 that finally drains the next
 * morning would enter on a gap the follower never saw, against a source trade
 * from the previous session.
 *
 * Deliberately a SEPARATE constant with its own env override rather than a
 * reuse of the perp one, so an operator widening the bound for Hyperliquid
 * outages does not silently widen it for equities too.
 */
export const DEFAULT_EQUITY_INTENT_MAX_AGE_MS = 15 * 60_000;

/** Hard ceiling on the operator override, so a typo cannot disable the bound. */
const INTENT_MAX_AGE_CEILING_MS = 6 * 60 * 60_000;

/**
 * Shared parser for the two age-bound overrides.
 *
 * Anything unparseable, non-positive, or above the ceiling falls back to the
 * default. There is no "0 means unlimited" escape hatch on purpose.
 */
function resolveIntentMaxAgeMs(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (parsed > INTENT_MAX_AGE_CEILING_MS) return fallback;
  return Math.floor(parsed);
}

/** Resolve the perp intent age bound from env. */
export function resolvePerpIntentMaxAgeMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveIntentMaxAgeMs(
    env.COPY_TRADE_AUTOMIRROR_PERP_MAX_INTENT_AGE_MS,
    DEFAULT_PERP_INTENT_MAX_AGE_MS,
  );
}

/** Resolve the Alpaca (stock / option) intent age bound from env. */
export function resolveEquityIntentMaxAgeMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveIntentMaxAgeMs(
    env.COPY_TRADE_AUTOMIRROR_EQUITY_MAX_INTENT_AGE_MS,
    DEFAULT_EQUITY_INTENT_MAX_AGE_MS,
  );
}

/** Has this delivery burned its retry budget? */
export function hasExhaustedDeliveryAttempts(
  attempts: number,
  ceiling: number = MIRROR_MAX_DELIVERY_ATTEMPTS,
): boolean {
  if (!Number.isFinite(attempts)) return true;
  return attempts >= ceiling;
}

export type MirrorIntentFreshness =
  | { fresh: true; ageMs: number }
  /** No usable source timestamp, so the intent's age cannot be established. */
  | { fresh: false; reason: "unknown-age"; ageMs: null }
  /** The source event is older than the bound. */
  | { fresh: false; reason: "too-old"; ageMs: number };

/**
 * How old is this intent, and is that still inside the bound?
 *
 * A source event stamped in the FUTURE is treated as unknown rather than fresh:
 * a clock we do not trust cannot be used to prove freshness.
 *
 * Venue-independent: this is date arithmetic over the source timestamp, and it
 * answers the same question for a perp entry and a stock entry.
 */
export function assessMirrorIntentFreshness(input: {
  sourceEventAt: string | null | undefined;
  now: Date;
  maxAgeMs: number;
}): MirrorIntentFreshness {
  const raw = input.sourceEventAt?.trim() ?? "";
  if (raw === "") return { fresh: false, reason: "unknown-age", ageMs: null };

  const eventMs = Date.parse(raw);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) {
    return { fresh: false, reason: "unknown-age", ageMs: null };
  }

  const ageMs = nowMs - eventMs;
  // Tolerate a small negative age (clock skew between the writer and this
  // worker) but never a large one, which means the timestamp is not a clock we
  // can reason about.
  if (ageMs < -60_000) return { fresh: false, reason: "unknown-age", ageMs: null };
  const bounded = Math.max(0, ageMs);
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    return { fresh: false, reason: "unknown-age", ageMs: null };
  }
  if (bounded > input.maxAgeMs) return { fresh: false, reason: "too-old", ageMs: bounded };
  return { fresh: true, ageMs: bounded };
}

/**
 * The name the perp preflight (and its own unit tests) already import.
 *
 * Kept as an alias rather than renamed in place because those files are outside
 * this change's scope. It is the SAME function object, so the perp path is
 * byte-for-byte unaffected; new callers should use `assessMirrorIntentFreshness`.
 */
export const assessPerpIntentFreshness = assessMirrorIntentFreshness;

/**
 * Account-abstraction modes that can already trade a HIP-3 (builder-deployed)
 * market, so no migration is needed.
 *
 * The worker used to call `ensureDexAbstraction()` here, which MIGRATES a
 * follower's Hyperliquid account to unified / shared-collateral mode when it is
 * not already there. In the interactive order path that migration is fine: the
 * user submitted the order, and submitting it is the consent. In a background
 * mirror there is nobody to consent, and the change is not scoped to one order:
 *
 *  - It is permanent and account wide, not per trade.
 *  - It merges spot and perp collateral, so every position the follower already
 *    holds is re-based onto shared collateral.
 *  - `accountBalanceUsd()` reads a DIFFERENT balance under unified mode (spot
 *    USDC rather than perp withdrawable), which silently changes the sizing
 *    basis of every later mirror on that account.
 *
 * So the worker READS the mode and refuses to change it. Already-migrated
 * accounts mirror normally; everyone else is skipped with an operator log, and
 * the follower performs the one-time migration themselves from the ticket.
 *
 * `dexAbstraction` is deliberately NOT in the accepted set even though it is a
 * legacy migrated state. Hyperliquid's account-abstraction-modes docs list it
 * as discontinued and carry an explicit warning for exactly this case:
 * "Cross margin on HIP-3 DEXs does not behave intuitively for DEX abstraction
 * users." Admitting it here would treat the venue's own counter-example as
 * proof the account's cross-collateral pooling is safe to size against. The
 * signing SDK no longer even offers this mode when setting abstraction
 * (`agentSetAbstraction`'s picklist is "i"/"u"/"p" only), so it is reachable
 * only as a stale state on an old account, never a state the follower can
 * newly choose. Such an account is treated the same as `default`: skipped
 * with an operator log until the follower migrates off it themselves.
 */
export function isDexAbstractionReady(mode: string | null | undefined): boolean {
  return mode === "unifiedAccount" || mode === "portfolioMargin";
}

/** Does this coin name address a builder-deployed (HIP-3) market? */
export function requiresDexAbstraction(coin: string): boolean {
  return coin.includes(":");
}

/** The follow-row fields consent depends on. Structural, so tests need no DB. */
export interface FollowConsentRow {
  id: string;
  followerUserId: string;
  autoMirror: boolean;
  credentialId: string | null;
}

export type FollowConsentDecision =
  | { action: "proceed" }
  /**
   * The follow row could not be tied to this delivery at all: the delivery was
   * staged before follow ids were recorded, or the row we read belongs to
   * someone else. Not evidence of withdrawal, but not evidence of consent.
   */
  | { action: "skip"; reason: "consent-unverifiable" }
  /**
   * The follower took the consent back: unfollowed, turned auto-mirror off, or
   * pointed the follow at a different destination account.
   */
  | { action: "skip"; reason: "consent-withdrawn" };

/**
 * Re-check, at execution time, that the follower still wants this order.
 *
 * `follow` is the row read fresh from the database, NOT the frozen candidate
 * payload. Passing the payload back in here would prove nothing.
 */
export function decideFollowConsent(input: {
  followerUserId: string;
  /** Follow id captured on the candidate at discovery. */
  followId: string | null | undefined;
  /** Destination credential the candidate was staged against. */
  credentialId: string | null | undefined;
  /** The live row, or null when it no longer exists. */
  follow: FollowConsentRow | null | undefined;
}): FollowConsentDecision {
  const followId = input.followId?.trim() ?? "";
  if (followId === "") return { action: "skip", reason: "consent-unverifiable" };

  if (!input.follow) return { action: "skip", reason: "consent-withdrawn" };
  if (input.follow.id !== followId) return { action: "skip", reason: "consent-unverifiable" };
  if (input.follow.followerUserId !== input.followerUserId) {
    return { action: "skip", reason: "consent-unverifiable" };
  }
  if (input.follow.autoMirror !== true) return { action: "skip", reason: "consent-withdrawn" };

  // The destination is part of the consent. A follow re-pointed at another
  // account did not authorize this order against the old one, and a follow with
  // no destination authorizes nothing.
  const liveCredentialId = input.follow.credentialId?.trim() ?? "";
  const stagedCredentialId = input.credentialId?.trim() ?? "";
  if (liveCredentialId === "" || stagedCredentialId === "") {
    return { action: "skip", reason: "consent-withdrawn" };
  }
  if (liveCredentialId !== stagedCredentialId) {
    return { action: "skip", reason: "consent-withdrawn" };
  }

  return { action: "proceed" };
}

export type PerpConsentDecision =
  | {
      action: "proceed";
      /** True when the consent check was skipped because this is a close. */
      reduceOnlyExempt: boolean;
    }
  | { action: "skip"; reason: "consent-unverifiable" | "consent-withdrawn" };

/**
 * The consent gate as the PERP path applies it, with one deliberate exemption:
 * a reduce-only close is never blocked by it.
 *
 * Withdrawing consent has to stop NEW exposure. It must never abandon exposure
 * the mirror already created. Applying `decideFollowConsent` to a close does
 * exactly that: a follower who turns auto-mirror off (or unfollows, or points
 * the follow at another account) keeps the leveraged position the mirror opened
 * for them, while the reduce-only delivery that would have exited it is skipped
 * and marked completed. "Stop copying this trader" would silently mean "and
 * keep this position open forever", which is the opposite of what turning the
 * feature off means, and the worse outcome by a wide margin.
 *
 * The exemption is safe in the only sense that matters: a reduce-only order can
 * only SHRINK a position, on the account the delivery was already staged
 * against, and it cannot open anything the follower does not already hold. If
 * the position is gone, the venue-side decision skips on no-position and no
 * order is sent.
 *
 * Everything else about a close still applies: the coin is still validated, the
 * Hyperliquid agent must still be registered and owned by this follower, and
 * the size is still clamped to the live position.
 */
export function decidePerpMirrorConsent(input: {
  /** Is the intent being executed a reduce-only close? */
  reduceOnly: boolean;
  followerUserId: string;
  followId: string | null | undefined;
  credentialId: string | null | undefined;
  follow: FollowConsentRow | null | undefined;
}): PerpConsentDecision {
  if (input.reduceOnly) return { action: "proceed", reduceOnlyExempt: true };
  const decision = decideFollowConsent(input);
  return decision.action === "proceed"
    ? { action: "proceed", reduceOnlyExempt: false }
    : decision;
}

export type EquityConsentDecision =
  | {
      action: "proceed";
      /** True when both checks were skipped because this is a closing sell. */
      closeExempt: boolean;
    }
  | {
      action: "skip";
      reason: "consent-unverifiable" | "consent-withdrawn" | "stale-intent";
    };

/**
 * The consent AND staleness gate as the ALPACA path applies it, with the same
 * deliberate exemption the perp path makes: a closing order is never blocked.
 *
 * The Alpaca path had neither check. Everything downstream of staging ran off
 * the frozen candidate payload, so turning auto-mirror off, switching the
 * destination account, or unfollowing entirely did not stop a stock or option
 * order that was already queued, and with the attempt ceiling and the capped
 * 15-minute backoff a wedged delivery could still fire about an hour after the
 * follower unfollowed. Both rules now match the perp path.
 *
 * WHAT COUNTS AS A CLOSE HERE. A mirrored SELL is the equity equivalent of a
 * reduce-only perp order, for stocks (`side: "sell"`) and for options
 * (`tradeAction: "SellToClose"`, which the candidate builder also stages as
 * `side: "sell"`). The caller passes that as `closing`.
 *
 * The exemption rests on the same property the perp one does: a mirrored sell
 * can only ever SHRINK a holding. `decideSellMirrorQty` reads the follower's
 * actual long, skips outright on `no-long-position`, and otherwise clamps the
 * quantity to it, so a sell cannot open a short and cannot create exposure the
 * follower does not already hold. Withdrawing consent must stop NEW exposure; it
 * must never be the reason a follower cannot get out of a position the mirror
 * opened for them. Gating the sell would turn "stop copying this trader" into
 * "and keep holding this forever", which is both the opposite of what the
 * setting means and the worse outcome.
 *
 * The staleness bound is exempted for the same reason and only for closes: a
 * late entry is a trade nobody asked for, but a late exit is still the exit.
 *
 * Staleness is evaluated BEFORE consent so that an intent which is both stale
 * and unauthorized reports `stale-intent` on this path exactly as it does on the
 * perp path, where the preflight age check runs ahead of the consent re-read.
 * Both are skips that place nothing; matching the order only keeps the operator
 * logs from disagreeing across venues for the same fault.
 */
export function decideEquityMirrorConsent(input: {
  /** Is the intent being executed a closing sell? */
  closing: boolean;
  followerUserId: string;
  followId: string | null | undefined;
  credentialId: string | null | undefined;
  /** The live row, or null when it no longer exists (and unread for a close). */
  follow: FollowConsentRow | null | undefined;
  /** ISO timestamp of the SOURCE event, frozen on the candidate at discovery. */
  sourceEventAt: string | null | undefined;
  now: Date;
  maxAgeMs: number;
}): EquityConsentDecision {
  if (input.closing) return { action: "proceed", closeExempt: true };

  const freshness = assessMirrorIntentFreshness({
    sourceEventAt: input.sourceEventAt,
    now: input.now,
    maxAgeMs: input.maxAgeMs,
  });
  if (!freshness.fresh) return { action: "skip", reason: "stale-intent" };

  const decision = decideFollowConsent(input);
  return decision.action === "proceed"
    ? { action: "proceed", closeExempt: false }
    : decision;
}
