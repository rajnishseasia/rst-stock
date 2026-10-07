/**
 * Pure position-sizing and risk/reward math for the chat "what-if" calculator
 * tool. No I/O, no broker access, no side effects. Extracted into its own
 * module (per the repo audit rule) so it can be unit-tested against the real
 * implementation rather than a re-declared copy.
 *
 * Conventions:
 *  - `side` is the trade direction. "long" profits when price rises, "short"
 *    when it falls.
 *  - Prices are per-share (or per-contract underlying). `contractMultiplier`
 *    scales dollar figures: 1 for equities, 100 for options.
 *  - All dollar outputs are rounded to cents; ratios to two decimals.
 */

export type TradeSide = "long" | "short";

export interface RiskRewardInput {
  side: TradeSide;
  /** Entry price basis. */
  entry: number;
  /** Protective stop price. */
  stop: number;
  /** Optional profit target. Enables reward and R:R output. */
  target?: number | null;
  /** Explicit share/contract count. When omitted we size by `maxRisk`. */
  quantity?: number | null;
  /** Risk budget in dollars, used to size quantity when `quantity` is absent. */
  maxRisk?: number | null;
  /** 1 for equities, 100 for options. Defaults to 1. */
  contractMultiplier?: number;
}

export interface RiskRewardResult {
  side: TradeSide;
  entry: number;
  stop: number;
  target: number | null;
  contractMultiplier: number;
  /** Dollar risk per share/contract (includes the multiplier). */
  riskPerShare: number;
  /** Dollar reward per share/contract to the target (includes multiplier). */
  rewardPerShare: number | null;
  /** Resolved quantity: the explicit input, else the risk-sized suggestion. */
  quantity: number | null;
  /** Quantity implied by the risk budget and stop distance, if computable. */
  suggestedQuantityByRisk: number | null;
  /** riskPerShare * quantity. */
  totalRisk: number | null;
  /** rewardPerShare * quantity. */
  totalReward: number | null;
  /** Reward-to-risk ratio to the target (rewardPerShare / riskPerShare). */
  riskRewardRatio: number | null;
  /** Break-even price before fees/slippage (equals entry). */
  breakEven: number;
  /** True when the inputs describe a coherent trade (no directional errors). */
  valid: boolean;
  /** Human-readable problems ("stop must be below entry for a long"). */
  errors: string[];
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Compute risk, reward, R:R, and a risk-budget position size for a hypothetical
 * trade. Returns a fully-populated result even when some inputs are invalid so
 * the caller can surface partial numbers plus the specific problem.
 */
export function computeRiskReward(input: RiskRewardInput): RiskRewardResult {
  const errors: string[] = [];
  const rawMultiplier = input.contractMultiplier ?? 1;
  const multiplier = isPositiveFinite(rawMultiplier) ? rawMultiplier : 1;
  const { side } = input;
  const entry = Number(input.entry);
  const stop = Number(input.stop);
  const target =
    input.target == null || !Number.isFinite(Number(input.target))
      ? null
      : Number(input.target);

  if (!isPositiveFinite(entry)) errors.push("Entry price must be a positive number.");
  if (!isPositiveFinite(stop)) errors.push("Stop price must be a positive number.");

  // Directional sanity: a long's stop sits below entry; a short's above.
  if (isPositiveFinite(entry) && isPositiveFinite(stop)) {
    if (side === "long" && stop >= entry) {
      errors.push("For a long, the stop must be below the entry.");
    }
    if (side === "short" && stop <= entry) {
      errors.push("For a short, the stop must be above the entry.");
    }
  }

  if (target != null) {
    if (side === "long" && target <= entry) {
      errors.push("For a long, the target must be above the entry.");
    }
    if (side === "short" && target >= entry) {
      errors.push("For a short, the target must be below the entry.");
    }
  }

  const riskPerShare =
    isPositiveFinite(entry) && isPositiveFinite(stop)
      ? roundMoney(Math.abs(entry - stop) * multiplier)
      : 0;

  const rewardPerShare =
    target != null && isPositiveFinite(entry)
      ? roundMoney(Math.abs(target - entry) * multiplier)
      : null;

  const suggestedQuantityByRisk =
    isPositiveFinite(input.maxRisk ?? 0) && riskPerShare > 0
      ? Math.floor((input.maxRisk as number) / riskPerShare)
      : null;

  const explicitQty =
    isPositiveFinite(input.quantity ?? 0) ? Math.floor(input.quantity as number) : null;

  const quantity = explicitQty ?? suggestedQuantityByRisk;

  const totalRisk =
    quantity != null && riskPerShare > 0 ? roundMoney(riskPerShare * quantity) : null;

  const totalReward =
    quantity != null && rewardPerShare != null
      ? roundMoney(rewardPerShare * quantity)
      : null;

  const riskRewardRatio =
    rewardPerShare != null && riskPerShare > 0
      ? roundRatio(rewardPerShare / riskPerShare)
      : null;

  return {
    side,
    entry: isPositiveFinite(entry) ? entry : 0,
    stop: isPositiveFinite(stop) ? stop : 0,
    target,
    contractMultiplier: multiplier,
    riskPerShare,
    rewardPerShare,
    quantity,
    suggestedQuantityByRisk,
    totalRisk,
    totalReward,
    riskRewardRatio,
    breakEven: isPositiveFinite(entry) ? entry : 0,
    valid: errors.length === 0,
    errors,
  };
}
