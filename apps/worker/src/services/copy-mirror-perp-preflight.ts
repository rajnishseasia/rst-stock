/**
 * The gates every perp mirror passes BEFORE anything is read from Hyperliquid
 * (audit H7: own module).
 *
 * This is the config / network / coin / staleness half of `processPerpCandidate`,
 * lifted verbatim out of `copy-mirror.ts`. Nothing about its behavior changed in
 * the move: the same checks run in the same order and return the same outcome
 * strings, and the same log lines are emitted.
 *
 * It is deliberately given plain booleans rather than the env-reading helpers,
 * so the decision is inspectable and this module never becomes a second place
 * that interprets a real-money flag.
 */

import { createProductionLogger } from "@trade-bot/logger";
import { isCanonicalPerpCoin, networkFromEnv, type PerpSide } from "@trade-bot/hyperliquid";

import {
  assessPerpIntentFreshness,
  resolvePerpIntentMaxAgeMs,
} from "./copy-mirror-consent";
import { describePerpConfigFault } from "./copy-mirror-perp-observability";
import { isPerpReconcilerEnabled, takePerpSyncGateRefusal } from "./copy-mirror-perp-sync-gate";
import type { MirrorProcessOutcome, MirrorSourceCandidate } from "./copy-mirror";

const logger = createProductionLogger();

const LOG_SERVICE = "copy-mirror";

export type PerpMirrorPreflight =
  | { action: "skip"; outcome: MirrorProcessOutcome }
  /**
   * Hold the delivery rather than consuming it. Only ever returned for a
   * reduce-only close, and only for refusals that a config change can lift.
   */
  | { action: "defer"; outcome: MirrorProcessOutcome; reason: string }
  | { action: "proceed"; perpSide: PerpSide; isReduceOnlyIntent: boolean };

export interface PerpMirrorPreflightInput {
  cand: MirrorSourceCandidate;
  /** The stored order row when this delivery is resuming one, else undefined. */
  existing: { status: string; reduceOnly: boolean | null } | undefined;
  /** COPY_TRADE_AUTOMIRROR_PERPS_ENABLED, as resolved by the caller. */
  perpsEnabled: boolean;
  /** HYPERLIQUID_NETWORK is set to a network this worker accepts. */
  networkExplicit: boolean;
  /** The configured Hyperliquid network is mainnet. */
  isMainnet: boolean;
  /** Both mainnet opt-ins are on (the per-cycle guard AND the env flag). */
  mainnetAllowed: boolean;
  /** COPY_TRADE_AUTOMIRROR_ALLOW_LIVE. */
  liveAllowed: boolean;
  now: Date;
}

export function assessPerpMirrorPreflight(input: PerpMirrorPreflightInput): PerpMirrorPreflight {
  const { cand, existing } = input;

  // Established BEFORE the config gates, because those gates must not consume a
  // close. A skip outcome completes the delivery, and a close is a one-shot
  // instruction: once consumed, nothing ever exits that position again.
  //
  // Every config refusal below is deployment state that a person can change
  // back: perps switched off, the reconciler stopped, the network left unset,
  // a mainnet or live opt-in withdrawn. Withdrawing any of them must stop NEW
  // exposure. None of them is a reason to abandon exposure the mirror already
  // created, which is the same principle the consent gate and the staleness
  // bound already follow. So for a reduce-only close these defer, and the exit
  // survives until the configuration allows it through or the position is gone.
  //
  // Data faults below (no side, non-canonical coin) still skip. Those do not
  // become true later, and holding them would wedge the queue forever.
  const isReduceOnlyIntent =
    existing?.status === "PENDING"
      ? existing.reduceOnly === true
      : cand.perpReduceOnly === true;
  const refuse = (outcome: MirrorProcessOutcome): PerpMirrorPreflight =>
    isReduceOnlyIntent
      ? { action: "defer", outcome, reason: outcome }
      : { action: "skip", outcome };
  // Three distinct config faults used to share one silent outcome string. An
  // operator who saw "perps-disabled" could not tell "I left the opt-in off"
  // (deliberate) from "HYPERLIQUID_NETWORK was never set, so this deployment
  // cannot prove it would not have traded mainnet" (a real-money
  // misconfiguration) from "perps are on but the Hyperliquid reconciler that
  // sizes and resolves every mirrored perp is off" (the precondition refusal).
  // They now carry different outcomes and different lines.
  //
  // This check is re-evaluated per candidate, not inherited from the cycle:
  // a delivery staged while the reconciler was running must still be refused
  // once it is off, because nothing would ever reconcile the order it places.
  // A candidate staged on one network must not execute on another.
  //
  // The resume path already refuses this for rows that reached the venue, but a
  // delivery that has not inserted its order row yet has nothing to compare: the
  // client and the row would both be built from whatever is configured NOW. A
  // reduce-only delivery could then be consumed against mainnet while the
  // testnet exposure it was meant to exit stays open.
  //
  // Refused rather than deferred even for a close, because this is the same
  // liftable-config shape as the rest of this block and `refuse` already routes
  // closes to a deferral.
  // KNOWN mismatch only, and unlike the exposure queries that is the right trade
  // here.
  //
  // Those queries feed a NUMBER that sizes a real order, so an unproven row
  // corrupts the result and must be excluded. This one only asks whether the
  // source traded on the chain we are on, and in a single-network deployment
  // they always match. Requiring proof would refuse every candidate whose source
  // order predates `venue_network` (its synthetic fill child preserves the NULL
  // deliberately), costing legitimate mirrors and deferring their closes
  // indefinitely, to defend against a mismatch that only arises after an
  // operator switches networks.
  //
  // The residual: a legacy source order's chain is unknown, so a testnet source
  // could be mirrored on mainnet after a switch. That is the same window the
  // deployment checklist covers by requiring open perp orders to be drained
  // before changing HYPERLIQUID_NETWORK, and it closes on its own as
  // pre-migration rows settle.
  if (cand.sourceVenueNetwork && cand.sourceVenueNetwork !== networkFromEnv()) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: candidate belongs to another network", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol.slice(0, 24),
      candidateNetwork: cand.sourceVenueNetwork ?? null,
      activeNetwork: networkFromEnv(),
    });
    return refuse("perp-network-mismatch");
  }

  const configFault = describePerpConfigFault({
    perpsEnabled: input.perpsEnabled,
    reconcilerEnabled: isPerpReconcilerEnabled(),
    networkExplicit: input.networkExplicit,
  });
  if (configFault) {
    // The deployment-level refusal is announced once, loudly, naming both
    // variables. The per-candidate line below stays at its own level.
    const loudRefusal =
      configFault.outcome === "perps-sync-disabled" ? takePerpSyncGateRefusal() : null;
    if (loudRefusal) {
      logger.error(LOG_SERVICE, loudRefusal.message, {
        envVars: loudRefusal.envVars,
        perpMirroringAllowed: false,
      });
    }
    logger[configFault.level](LOG_SERVICE, configFault.message, {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol.slice(0, 24),
      // Name only. A config VALUE never reaches a log line from here.
      envVar: configFault.envVar,
      outcome: configFault.outcome,
    });
    return refuse(configFault.outcome);
  }
  if (input.isMainnet && !input.mainnetAllowed) {
    return refuse("perps-mainnet-not-allowed");
  }
  // COPY_TRADE_AUTOMIRROR_ALLOW_LIVE is documented as THE paper-first
  // real-money gate, so it has to mean that here too. It previously governed
  // only live Alpaca accounts, which let an operator who had deliberately left
  // it off (believing they were paper-only) place real mainnet leveraged
  // orders through the perp path. Hyperliquid testnet stays exempt: it is the
  // paper equivalent, and it moves no real funds.
  if (input.isMainnet && !input.liveAllowed) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip perp: live opt-in is off", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      coin: cand.symbol.slice(0, 24),
    });
    return refuse("live-not-allowed");
  }
  if (!cand.perpSide) return { action: "skip", outcome: "no-qty" };
  // Last gate before any Hyperliquid call. The candidate builders already
  // validate the coin, but this is the single line every perp order passes
  // through, and the coin string is what selects the market to lever up.
  if (!isCanonicalPerpCoin(cand.symbol)) {
    logger.warn(LOG_SERVICE, "[copy-mirror] skip: non-canonical perp coin", {
      followerUserId: cand.followerUserId,
      sourceItemId: cand.sourceItemId,
      symbol: cand.symbol.slice(0, 24),
    });
    return { action: "skip", outcome: "unsupported-perp-coin" };
  }

  // ---- STALENESS: do not act on intent the market has left behind. ----
  // Deliveries are durable and retried, so an OPEN staged before an outage can
  // otherwise fire hours later: same coin, same leverage, a price nobody
  // looked at, and a source who may already be flat. Closes are deliberately
  // exempt. A reduce-only order can only shrink exposure, and refusing a late
  // one would strand the follower in a leveraged position with the single
  // instruction that would have exited it already spent.
  if (!isReduceOnlyIntent) {
    const freshness = assessPerpIntentFreshness({
      sourceEventAt: cand.sourceEventAt,
      now: input.now,
      maxAgeMs: resolvePerpIntentMaxAgeMs(),
    });
    if (!freshness.fresh) {
      logger.warn(LOG_SERVICE, "[copy-mirror] skip perp open: stale intent", {
        followerUserId: cand.followerUserId,
        sourceItemId: cand.sourceItemId,
        coin: cand.symbol,
        reason: freshness.reason,
        ageMs: freshness.ageMs,
        maxAgeMs: resolvePerpIntentMaxAgeMs(),
      });
      return { action: "skip", outcome: "stale-intent" };
    }
  }

  return { action: "proceed", perpSide: cand.perpSide, isReduceOnlyIntent };
}
