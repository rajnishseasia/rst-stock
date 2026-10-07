/**
 * Copy-mirror constants shared across app boundaries.
 *
 * These are values that MORE THAN ONE app has to agree on, where disagreement
 * is silent and expensive. They live here because `packages/types` is the only
 * package all three apps already depend on, and because the worker (which
 * enforces them) and the web app (which explains them to users) must never
 * drift apart.
 *
 * Keep this file free of imports. Everything here is a plain value so that a
 * client bundle can carry it without pulling server code along.
 */

/**
 * Smallest notional the copy-trade mirror will submit, in USD.
 *
 * Two independent reasons, both real:
 *
 *  1. VENUE REJECTION. Hyperliquid rejects an order worth less than $10. With
 *     no lower bound, a small ratio-sized copy became a broker rejection and a
 *     REJECTED row on the real-money orders table for every such signal. Below
 *     the minimum the mirror skips instead of submitting. This applies to
 *     orders that OPEN or increase exposure; reduce-only closes are exempt at
 *     the venue (a small position must always be closable) and are not routed
 *     through the check.
 *
 *  2. FUNDING GUIDANCE. The perps deposit step has to state a floor, and the
 *     bridge floor is the wrong one. `HL_MIN_DEPOSIT_USDC` (5) is the least
 *     Hyperliquid will credit, not the least a mirrored order can use. Telling
 *     a copy-trader to fund with the bridge floor hands them a funded account
 *     that never places a single copied order and never says why.
 *
 * This constant previously existed as two separate literals, one in the worker
 * and one in the web app, kept in agreement by comments naming each other. Both
 * had a test asserting the value was 10, which caught nothing: each pinned its
 * own copy. If you change this value, change it here only.
 */
export const MIRROR_MIN_ORDER_NOTIONAL_USD = 10;

/**
 * Bounds on the automatic take-profit and stop-loss a follower may attach to
 * the perp positions their mirror opens, as PERCENT OF MARGIN (return on
 * equity), not percent of price.
 *
 * ROE is the basis because the follower does not choose the leverage, the
 * source trader does. At 20x a 5% price move is a 100% move on the margin
 * behind the position, so a price-move percentage would mean a completely
 * different amount of the follower's money depending on a number they never
 * set. "Stop me out at a quarter of my margin" has to mean the same risk at 1x
 * and at 20x, and only the ROE reading does.
 *
 * THE STOP CEILING IS THE LOAD-BEARING ONE. It is deliberately below 100:
 *
 *  - At exactly 100 the derived trigger price is zero at 1x (the whole margin
 *    is the whole notional there), which is not a price any venue can trigger
 *    on and would be submitted as a stop that can never fire.
 *  - Above roughly 90% of margin lost, Hyperliquid's own maintenance margin has
 *    already taken the position: a stop placed past liquidation is a stop the
 *    follower believes in and never gets. Refusing the number is honest;
 *    accepting it and silently never firing is not.
 *
 * The take-profit ceiling is generous because a winning perp genuinely can run
 * to several times the margin, and being wrong in that direction only costs the
 * follower an exit that was never going to be hit.
 *
 * The floor of 1 exists because the spread swallows anything smaller. At 20x, a
 * 1% ROE stop is a 0.05% price move, which is already inside the bid/ask on
 * many coins; anything below that would be a stop that fires on noise the
 * instant it is placed.
 */
export const PERP_PROTECTION_BOUNDS = {
  takeProfitPct: { min: 1, max: 1000 },
  stopLossPct: { min: 1, max: 90 },
} as const;
