/**
 * Copy-Mirror Pure Helpers
 *
 * DB/broker-free, side-effect-free functions for the auto-mirror feature.
 * Kept pure + exported so the background mirror worker and unit tests share the
 * exact same sizing / idempotency / guardrail logic without a DB or broker.
 *
 * The worker that consumes these stays INERT unless COPY_TRADE_AUTOMIRROR_ENABLED
 * === "true" (and refuses LIVE accounts unless COPY_TRADE_AUTOMIRROR_ALLOW_LIVE
 * === "true"). None of these helpers place orders; they only compute values.
 */

/**
 * The four ways a follower can size a mirrored order.
 *
 *   pct        — percent of MARGIN buying power (1..100). Legacy default.
 *   pct_equity — percent of NET equity (1..100). Removes the margin-leverage
 *                surprise where "5% of buying power" on a 4x DTBP account is
 *                actually 20% of equity.
 *   usd        — fixed dollars per order (1..1_000_000).
 *   ratio      — multiplier of the SOURCE trader's share count (0.01..10).
 *                Closes the "copy means proportional" expectation gap.
 */
export type SizingMode = "pct" | "pct_equity" | "usd" | "ratio";

export interface ComputeMirrorQtyInput {
  sizingMode: SizingMode;
  /**
   * Mode-dependent magnitude:
   *   pct / pct_equity → percent (5 = 5%)
   *   usd              → dollars (500 = $500)
   *   ratio            → multiplier of sourceQty (1 = match, 0.5 = half)
   */
  sizingValue: number;
  /** Follower account margin buying power (used only in pct mode). */
  buyingPower: number;
  /** Follower account net equity (used only in pct_equity mode). */
  equity?: number;
  /** Source trader's share/contract count (used only in ratio mode). */
  sourceQty?: number;
  /** Current/last price of the symbol. */
  price: number;
  /** Dollar multiplier per unit. Equities are 1; options contracts are 100. */
  contractMultiplier?: number;
  /**
   * Whether the broker supports fractional shares for this symbol. EQUITY only;
   * options are always whole-contract. When true the qty is rounded to Alpaca's
   * fractional precision instead of floored to a whole share, so a "$99 of a
   * $100 stock" sizing yields ≈0.99 shares instead of 0 + a silent skip.
   */
  allowFractional?: boolean;
  /**
   * Optional dollar cap on a single mirrored order. When set, targetDollars is
   * clamped to this value after the ratio/pct/usd calculation.
   * null or undefined = no cap.
   */
  maxTradeSize?: number | null;
}

/** Alpaca's fractional precision (6 decimal places — qty * 1e6 must be integral). */
const FRACTIONAL_PRECISION = 1_000_000;

/**
 * Whole-share (or fractional, when allowed) quantity to mirror, given the
 * follower's sizing rule.
 *
 *   pct        → target $ = sizingValue/100 × buyingPower
 *   pct_equity → target $ = sizingValue/100 × equity
 *   usd        → target $ = sizingValue
 *   ratio      → qty      = sizingValue × sourceQty  (no $ calculation)
 *
 *   Then for pct/pct_equity/usd:  qty = floor(target / (price × multiplier))
 *   For ratio:                    qty = floor(sizingValue × sourceQty)
 *
 * Returns 0 (do not place an order) for any non-finite/negative input, a
 * price <= 0, a missing source qty in ratio mode, or a target that buys less
 * than one whole share when fractional is disallowed.
 *
 * For pct mode, `sizingValue` is CLAMPED to 100% as a belt-and-suspenders
 * defense in case the API zod boundary is bypassed or a legacy row pre-dates
 * the mode-aware validation.
 */
export function computeMirrorQty(input: ComputeMirrorQtyInput): number {
  const { sizingMode, price } = input;
  const contractMultiplier = input.contractMultiplier ?? 1;
  const allowFractional = input.allowFractional === true;

  if (!Number.isFinite(price) || price <= 0) return 0;
  if (!Number.isFinite(contractMultiplier) || contractMultiplier <= 0) return 0;
  if (!Number.isFinite(input.sizingValue) || input.sizingValue <= 0) return 0;

  // -------- ratio: qty derived directly from the source trader's qty. --------
  if (sizingMode === "ratio") {
    const sourceQty = input.sourceQty ?? 0;
    if (!Number.isFinite(sourceQty) || sourceQty <= 0) return 0;
    // Capped at 10x in the zod schema; clamp here too in case of stale rows.
    const clampedRatio = Math.min(input.sizingValue, 10);
    const rawQty = clampedRatio * sourceQty;
    // Fractional shares: ratio mode honors allowFractional for equities.
    if (allowFractional && contractMultiplier === 1) {
      const rounded = Math.round(rawQty * FRACTIONAL_PRECISION) / FRACTIONAL_PRECISION;
      return rounded > 0 ? rounded : 0;
    }
    const qty = Math.floor(rawQty);
    return qty > 0 ? qty : 0;
  }

  // -------- pct / pct_equity / usd: dollar-target → qty by price. --------
  let targetDollars: number;
  if (sizingMode === "pct") {
    const buyingPower = input.buyingPower;
    if (!Number.isFinite(buyingPower) || buyingPower <= 0) return 0;
    // Belt-and-suspenders cap: a legacy row pre-dating mode-aware validation
    // could carry sizingValue > 100. Treat anything beyond 100% as 100%.
    const clampedPct = Math.min(input.sizingValue, 100);
    targetDollars = (clampedPct / 100) * buyingPower;
  } else if (sizingMode === "pct_equity") {
    const equity = input.equity ?? 0;
    if (!Number.isFinite(equity) || equity <= 0) return 0;
    const clampedPct = Math.min(input.sizingValue, 100);
    targetDollars = (clampedPct / 100) * equity;
  } else {
    // usd
    targetDollars = input.sizingValue;
  }

  // Apply per-order dollar cap if configured.
  if (input.maxTradeSize && Number.isFinite(input.maxTradeSize) && input.maxTradeSize > 0) {
    targetDollars = Math.min(targetDollars, input.maxTradeSize);
  }

  if (!Number.isFinite(targetDollars) || targetDollars <= 0) return 0;

  const denominator = price * contractMultiplier;
  if (allowFractional && contractMultiplier === 1) {
    const rawQty = targetDollars / denominator;
    const rounded = Math.round(rawQty * FRACTIONAL_PRECISION) / FRACTIONAL_PRECISION;
    return rounded > 0 ? rounded : 0;
  }

  const qty = Math.floor(targetDollars / denominator);
  return qty > 0 ? qty : 0;
}

export interface MirrorIdempotencyInput {
  followerUserId: string;
  /** the SOURCE-PREFIXED CopyTradeItem id, e.g. "x_signal:<uuid>" / "user:<uuid>". */
  sourceItemId: string;
}

/**
 * Deterministic client_order_id / dedupe key for "this follower mirroring this
 * source trade". Stable across runs and unique per (follower, source item), so
 * the same source trade is never mirrored to the same follower twice.
 */
export function mirrorIdempotencyKey(input: MirrorIdempotencyInput): string {
  return `copymirror:${input.followerUserId}:${input.sourceItemId}`;
}

/**
 * True while the follower is still under their daily mirror cap. Fails closed
 * (returns false) for a non-finite/negative count or a cap <= 0.
 */
export function withinDailyCap(input: { mirrorsToday: number; dailyCap: number }): boolean {
  const { mirrorsToday, dailyCap } = input;
  if (!Number.isFinite(dailyCap) || dailyCap <= 0) return false;
  if (!Number.isFinite(mirrorsToday) || mirrorsToday < 0) return false;
  return mirrorsToday < dailyCap;
}

/**
 * True when a single order's dollar amount is within the per-order cap. Fails
 * closed (returns false) for a non-finite/negative amount or a cap <= 0.
 */
export function withinDollarCap(input: { orderDollars: number; maxOrderDollars: number }): boolean {
  const { orderDollars, maxOrderDollars } = input;
  if (!Number.isFinite(maxOrderDollars) || maxOrderDollars <= 0) return false;
  if (!Number.isFinite(orderDollars) || orderDollars < 0) return false;
  return orderDollars <= maxOrderDollars;
}

/** Sane default guardrails for the auto-mirror worker (overridable via env). */
export const DEFAULT_MIRROR_DAILY_CAP = 20;
export const DEFAULT_MIRROR_MAX_ORDER_DOLLARS = 1000;

/**
 * Validate the deployment's daily mirror ceiling for the atomic perp-entry
 * reservation. The one-entry value used by the funded local proof is ordinary
 * configuration, not product policy; production uses the configured/default
 * ceiling while Phase A still serializes every reservation against it.
 */
export function normalizePerpDailyCap(dailyCap: number | undefined): number | null {
  if (typeof dailyCap !== "number" || !Number.isSafeInteger(dailyCap) || dailyCap <= 0) return null;
  return dailyCap;
}

/**
 * Resolve the Hyperliquid entry cap without losing whether the operator's raw
 * generic cap was valid. Equity keeps using `resolveGuardrails`, whose invalid
 * values intentionally fall back to its safe default; a perp must refuse an
 * explicitly invalid value rather than bypass its atomic reservation.
 */
export function resolvePerpDailyCap(env: MirrorEnv = process.env): number | null {
  const raw = env.COPY_TRADE_AUTOMIRROR_DAILY_CAP;
  if (raw === undefined) return normalizePerpDailyCap(DEFAULT_MIRROR_DAILY_CAP);
  const parsed = Number(raw);
  return normalizePerpDailyCap(parsed);
}

// ---------------------------------------------------------------------------
// Deployment gating readers
// ---------------------------------------------------------------------------

/**
 * WHY THESE LIVE HERE
 *
 * The auto-mirror worker decides whether it may place orders by reading a set
 * of env flags. Nothing outside the worker used to read them, so the API could
 * hand the UI a follow row with `auto_mirror = true` while the worker that is
 * supposed to act on it was completely inert.
 *
 * The readers therefore need one home both processes can reach. This module is
 * already that home: `apps/worker/src/services/copy-mirror.ts` and
 * `copy-mirror-perp-decisions.ts` both import the sizing/idempotency/cap helpers
 * above from here. The dependency only ever points worker to api, never the
 * other way, because the API is bundled for a serverless function and must not
 * pull the poller's DB, Alpaca and Hyperliquid clients in behind a status read.
 *
 * So the flag readers were added here rather than imported out of the worker.
 * `apps/api/src/__tests__/copy-trade-mirror-status.test.ts` runs the worker's
 * copies and these side by side over the full value matrix, so the two can not
 * drift apart while both exist.
 */

/** The subset of an environment these readers touch. `process.env` satisfies it. */
export type MirrorEnv = Record<string, string | undefined>;

/**
 * Every env var that configures auto-mirroring, by NAME. Used to decide, one
 * variable at a time, whether this process was told that particular setting.
 * Values are never exported or logged.
 */
export const AUTOMIRROR_ENV_VARS = [
  "COPY_TRADE_AUTOMIRROR_ENABLED",
  "COPY_TRADE_AUTOMIRROR_ALLOW_LIVE",
  "COPY_TRADE_AUTOMIRROR_PERPS_ENABLED",
  "COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET",
  "COPY_TRADE_AUTOMIRROR_DAILY_CAP",
  "COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS",
] as const;

/** One of the auto-mirror env var names above. */
export type AutoMirrorEnvVar = (typeof AUTOMIRROR_ENV_VARS)[number];

/** The master kill switch. Auto-mirror is inert unless this is exactly "true". */
export function isAutoMirrorEnabled(env: MirrorEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_ENABLED === "true";
}

/** Live-account opt-in. Mirroring onto a LIVE account is refused unless exactly "true". */
export function isAutoMirrorLiveAllowed(env: MirrorEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_ALLOW_LIVE === "true";
}

/** The RAW perps opt-in, WITHOUT the reconciler precondition applied. */
export function readPerpsAutoMirrorFlag(env: MirrorEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_PERPS_ENABLED === "true";
}

/** Whether the Hyperliquid reconciler is running. Defaults ON; only "false" stops it. */
export function isPerpReconcilerEnabled(env: MirrorEnv = process.env): boolean {
  return env.HYPERLIQUID_SYNC_ENABLED !== "false";
}

/**
 * The EFFECTIVE perps gate: the opt-in is necessary but not sufficient, because
 * the reconciler is the only writer of mirrored fill sizes and the only process
 * that resolves a PENDING perp order against the venue.
 */
export function isPerpsAutoMirrorEnabled(env: MirrorEnv = process.env): boolean {
  return readPerpsAutoMirrorFlag(env) && isPerpReconcilerEnabled(env);
}

/** Hyperliquid defaults to mainnet, so production money needs a second explicit opt-in. */
export function isPerpsMainnetAllowed(env: MirrorEnv = process.env): boolean {
  return env.COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET === "true";
}

/**
 * The Hyperliquid network THIS process was explicitly told to use, or null.
 *
 * Null is not "no network": the venue package hard-defaults to mainnet. Null
 * means HYPERLIQUID_NETWORK was never set to a value this deployment accepts,
 * so reporting a network would be inventing one. Testnet additionally requires
 * the HYPERLIQUID_ALLOW_TESTNET opt-in, matching `networkFromEnv` in
 * packages/hyperliquid, which otherwise falls back to mainnet.
 */
export function resolveExplicitHyperliquidNetwork(
  env: MirrorEnv = process.env,
): "mainnet" | "testnet" | null {
  if (env.HYPERLIQUID_NETWORK === "mainnet") return "mainnet";
  if (env.HYPERLIQUID_NETWORK === "testnet" && env.HYPERLIQUID_ALLOW_TESTNET === "true") {
    return "testnet";
  }
  return null;
}

/** Perp automation never relies on Hyperliquid's implicit mainnet default. */
export function isHyperliquidNetworkExplicit(env: MirrorEnv = process.env): boolean {
  return resolveExplicitHyperliquidNetwork(env) !== null;
}

/**
 * Resolve the generic equity per-follow guardrails from env, falling back to
 * the shared defaults. Hyperliquid perps must normalize this daily cap through
 * `normalizePerpDailyCap` before using it.
 */
export function resolveGuardrails(env: MirrorEnv = process.env): {
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

// ---------------------------------------------------------------------------
// Deployment status (what the API may honestly say about auto-mirroring)
// ---------------------------------------------------------------------------

/**
 * Whether THE MASTER SWITCH's own value reached this process.
 *
 *   "visible": COPY_TRADE_AUTOMIRROR_ENABLED is set here, so `enabled` below is
 *              a real configuration this process was handed.
 *   "unknown": it is not set here. That is indistinguishable from
 *              "auto-mirroring is switched off", so nothing is claimed.
 *
 * It deliberately says nothing about the other variables. They are reported
 * one at a time (see `MirrorStatus`), so a deployment that carries some of the
 * configuration reports exactly the part it carries and no more.
 */
export type MirrorStatusVisibility = "visible" | "unknown";

/**
 * The deployment's auto-mirror gating state as THIS process can see it.
 *
 * EVERY flag-derived field is reported INDEPENDENTLY, from its own env var:
 * a boolean or number when that variable is set on this process, and null when
 * it is not. A null therefore means "this process was never told", never "off"
 * and never "unlimited". The fields do not travel together: an operator who
 * mirrors one variable onto the API gets that one value and nulls for the rest,
 * because the presence of one variable says nothing about the others.
 *
 * `visibility` is a shorthand for `enabled === null`, kept as a named field so
 * clients can branch on the master switch without re-deriving that rule. It is
 * NOT a claim about the other fields: they can be non-null while it is
 * "unknown". Callers must treat null and false as different everywhere, not
 * only on the field `visibility` summarises.
 */
export interface MirrorStatus {
  visibility: MirrorStatusVisibility;
  /** Master kill switch, or null when COPY_TRADE_AUTOMIRROR_ENABLED is unset here. */
  enabled: boolean | null;
  /** Real-money opt-in (LIVE Alpaca accounts and Hyperliquid mainnet), or null when unset here. */
  allowLive: boolean | null;
  /**
   * EFFECTIVE perps gate: the opt-in AND the reconciler precondition. Null when
   * the opt-in itself is unset here, since the reconciler alone decides nothing.
   */
  perpsEnabled: boolean | null;
  /** The extra opt-in perps need on top of `allowLive` for mainnet, or null when unset here. */
  perpsMainnetAllowed: boolean | null;
  /** Explicitly configured Hyperliquid network, or null when never set. */
  network: "mainnet" | "testnet" | null;
  /** Per-follow daily mirror cap configured here, or null when this process carries no override. */
  dailyCap: number | null;
  /** Per-order dollar cap configured here, or null when this process carries no override. */
  maxOrderDollars: number | null;
  /**
   * The caps this code falls back to with no override. Always populated, even
   * when every other field is null, because they are compiled in rather than
   * configured, so a client can still render honest "defaults to" copy.
   */
  defaults: {
    dailyCap: number;
    maxOrderDollars: number;
  };
}

/**
 * True when THIS ONE variable was given to this process.
 *
 * Presence is decided per variable, never across the set. Asking "is any of
 * them set?" and then reading all of them is the bug this replaced: one
 * mirrored variable would make every other absent one read as a confident
 * false, so mirroring only COPY_TRADE_AUTOMIRROR_DAILY_CAP onto the API made it
 * announce `enabled: false` for a worker that was busily placing orders.
 *
 * An empty string counts as absent: platforms hand a declared-but-unset var
 * through as "", and treating that as a configuration would turn "unknown" into
 * a confident "disabled".
 */
export function hasAutoMirrorEnvVar(name: AutoMirrorEnvVar, env: MirrorEnv = process.env): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolve what this process may honestly say about auto-mirroring.
 *
 * IMPORTANT, AND THE REASON `visibility` EXISTS: the auto-mirror flags are set
 * on the WORKER process. The API is a separate deployment with a separate env,
 * so unless an operator mirrors the flags onto the API too, the API simply does
 * not have them. Reading an absent var and reporting `enabled: false` would be
 * a guess dressed up as a fact, and it is the wrong guess exactly when it
 * matters (auto-mirror is on and a user is told it is off, or vice versa).
 *
 * So this returns null for a flag whose variable is absent, and only reports a
 * value when that variable is actually present. When it IS present, the value
 * describes THIS process's configuration; keeping the two deployments in
 * agreement is an operator responsibility this code cannot check from inside.
 *
 * THE ANSWER IS ASSEMBLED PER VARIABLE, NOT PER PROCESS. Operators mirror
 * subsets: a partial copy of the configuration is the normal case, not a
 * corrupt one. So each field is read only from its own variable, and one
 * present variable never promotes an absent neighbour to false. A deployment
 * carrying only COPY_TRADE_AUTOMIRROR_DAILY_CAP reports that cap and nothing
 * else, and still says the master switch is unknown.
 */
export function resolveMirrorStatus(env: MirrorEnv = process.env): MirrorStatus {
  const defaults = {
    dailyCap: DEFAULT_MIRROR_DAILY_CAP,
    maxOrderDollars: DEFAULT_MIRROR_MAX_ORDER_DOLLARS,
  };

  const given = (name: AutoMirrorEnvVar): boolean => hasAutoMirrorEnvVar(name, env);

  // Resolved once, read only for the variables that are actually present. The
  // resolver falls back to the compiled-in defaults for anything unset, which
  // is the right answer for the process APPLYING the caps and the wrong one to
  // report as configuration, so an absent override stays null here.
  const guardrails = resolveGuardrails(env);

  const enabled = given("COPY_TRADE_AUTOMIRROR_ENABLED") ? isAutoMirrorEnabled(env) : null;

  return {
    visibility: enabled === null ? "unknown" : "visible",
    enabled,
    allowLive: given("COPY_TRADE_AUTOMIRROR_ALLOW_LIVE") ? isAutoMirrorLiveAllowed(env) : null,
    // The reconciler precondition only qualifies an opt-in that exists. With no
    // opt-in here there is nothing to qualify, so this stays unknown rather
    // than becoming a false sourced from HYPERLIQUID_SYNC_ENABLED's default.
    perpsEnabled: given("COPY_TRADE_AUTOMIRROR_PERPS_ENABLED")
      ? isPerpsAutoMirrorEnabled(env)
      : null,
    perpsMainnetAllowed: given("COPY_TRADE_AUTOMIRROR_PERPS_ALLOW_MAINNET")
      ? isPerpsMainnetAllowed(env)
      : null,
    network: resolveExplicitHyperliquidNetwork(env),
    dailyCap: given("COPY_TRADE_AUTOMIRROR_DAILY_CAP") ? guardrails.dailyCap : null,
    maxOrderDollars: given("COPY_TRADE_AUTOMIRROR_MAX_ORDER_DOLLARS")
      ? guardrails.maxOrderDollars
      : null,
    defaults,
  };
}
