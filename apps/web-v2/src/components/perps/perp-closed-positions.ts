/**
 * Round-trip reconstruction for the perps "Closed" tab.
 *
 * `positions.listPerpFills` returns FILLS, not positions: one row per
 * execution, newest first. A trader who scaled into BTC over four fills and
 * scaled out over three sees seven rows and no answer to the only question
 * that matters after the fact, which is "what did that trade do, and what
 * ended it".
 *
 * This module folds those fills back into closed positions. It is pure: no
 * React, no network, no clock. Everything it needs is in the fills.
 *
 * WHY THE FILLS AND NOT A TABLE. Hyperliquid is the book of record for perp
 * executions and already reports realized PnL per fill (`closedPnl`), so a
 * local table would be a second, staler copy of numbers the venue computes
 * authoritatively. The cost is that history is bounded by the fills window,
 * which is why a run whose opening fills fall outside it is reported with
 * `partial: true` rather than with an invented entry price.
 */

/**
 * How many fills every run reconstruction in the app asks for.
 *
 * The walk below replays fills into runs, so it can only see back as far as the
 * window it is given: too small a window and a run's opening fills fall outside
 * it. Every surface that reconstructs runs (the Closed tab, and the RPNL column
 * on the open-positions table) MUST pass this same value, both so they agree
 * about where a run began and so they share one query key and therefore one
 * Hyperliquid round trip.
 */
export const CLOSED_POSITION_FILL_SCAN = 200;

/** The subset of an enriched `listPerpFills` row this module reads. */
export interface ClosedPositionFill {
  time: number;
  coin: string;
  side: "buy" | "sell";
  px: string;
  sz: string;
  closedPnl: string;
  fee: string;
  dir: string;
  oid: number;
  /** DB `orders.orderType` when the fill's oid matched one of our rows. */
  orderType?: string | null;
}

/** What ended the position. Drives the badge in the Closed tab. */
export type ClosedPositionReason =
  | "manual"
  | "stop_loss"
  | "take_profit"
  | "liquidation"
  | "unknown";

export interface ClosedPerpPosition {
  /** Stable across polls: coin plus the closing fill that ended the run. */
  id: string;
  coin: string;
  /** The side that was HELD, not the side of the closing fill. */
  side: "long" | "short";
  /** Time of the last closing fill (ms). */
  closedAt: number;
  /** Time of the fill that opened the run (ms), null when truncated. */
  openedAt: number | null;
  /** Total coin-denominated size closed by this run. */
  sizeCoin: number;
  /** Size-weighted average price of the closing fills. */
  avgClosePx: number;
  /** Sum of HL's per-fill `closedPnl` over the run. */
  realizedPnl: number;
  /** Sum of fees over the run's closing fills (negative means rebate). */
  feeUsd: number;
  /** The run's opening fills fall outside the fills window. */
  partial: boolean;
  closedBy: ClosedPositionReason;
}

/**
 * The run left OPEN at the end of the walk: the position the account still
 * holds, plus the realized PnL already banked on it by partial closes.
 */
export interface OpenPerpRun {
  coin: string;
  side: "long" | "short";
  /** Signed size the replay ended on, for reconciling against the venue. */
  signedSize: number;
  /** Time of the fill that opened the run (ms), null when truncated. */
  openedAt: number | null;
  /** Sum of HL's per-fill `closedPnl` over the run's closes so far. */
  realizedPnl: number;
  /** Sum of fees over those closes (negative means rebate). */
  feeUsd: number;
}

type PositionSide = ClosedPerpPosition["side"];

interface FillsWalk {
  closed: ClosedPerpPosition[];
  /** Still-open run per coin. Absent for a coin that ended the walk flat. */
  open: Map<string, OpenPerpRun>;
}

/**
 * Does this fill reduce an existing position?
 *
 * HL's `dir` is the venue's own label and the only field that distinguishes a
 * scale-in from a scale-out without replaying the whole account. "Close Long",
 * "Close Short", the liquidation variants, and the flip labels ("Long > Short")
 * all reduce; "Open Long" / "Open Short" do not. A flip both closes and opens,
 * which the signed-size walk below handles on its own.
 */
function isClosingDir(dir: string): boolean {
  return /close|liquidat|>/i.test(dir);
}

function isLiquidationDir(dir: string): boolean {
  return /liquidat/i.test(dir);
}

function flipSidesFromDir(
  dir: string,
): { closed: PositionSide; opened: PositionSide } | null {
  const match = dir.match(/\b(long|short)\s*>\s*(long|short)\b/i);
  if (!match) return null;
  const closed = match[1]?.toLowerCase();
  const opened = match[2]?.toLowerCase();
  if ((closed !== "long" && closed !== "short") || (opened !== "long" && opened !== "short")) {
    return null;
  }
  return { closed, opened };
}

function closingSideFromDir(dir: string): PositionSide | null {
  const flip = flipSidesFromDir(dir);
  const label =
    flip?.closed ??
    (/\bshort\b/i.test(dir) ? "short" : /\blong\b/i.test(dir) ? "long" : null);
  if (label?.toLowerCase() === "long") return "long";
  if (label?.toLowerCase() === "short") return "short";
  return null;
}

/**
 * Map the DB order type behind the closing fill to a reason.
 *
 * A fill whose oid never matched one of our order rows was placed somewhere
 * other than this app, so "unknown" is the honest answer rather than "manual".
 * That distinction is the whole point of the badge: it is how a stop that fired
 * at the venue stops looking like a close the user made deliberately.
 */
function reasonFromOrderType(orderType: string | null | undefined): ClosedPositionReason {
  if (orderType === "StopMarket" || orderType === "StopLimit") return "stop_loss";
  if (orderType === "TakeProfitMarket" || orderType === "TakeProfitLimit") {
    return "take_profit";
  }
  if (orderType == null || orderType === "") return "unknown";
  return "manual";
}

function toFinite(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Mutable accumulator for one in-progress run. */
interface RunAccumulator {
  coin: string;
  side: "long" | "short";
  openedAt: number | null;
  partial: boolean;
  closedSize: number;
  closeNotional: number;
  realizedPnl: number;
  feeUsd: number;
  lastCloseTime: number;
  lastCloseOid: number;
  lastCloseOrderType: string | null | undefined;
  liquidated: boolean;
}

function newRun(
  coin: string,
  side: "long" | "short",
  openedAt: number | null,
  partial: boolean,
): RunAccumulator {
  return {
    coin,
    side,
    openedAt,
    partial,
    closedSize: 0,
    closeNotional: 0,
    realizedPnl: 0,
    feeUsd: 0,
    lastCloseTime: 0,
    lastCloseOid: 0,
    lastCloseOrderType: null,
    liquidated: false,
  };
}

function addCloseFill(
  run: RunAccumulator,
  fill: ClosedPositionFill,
  size: number,
  price: number,
): void {
  run.closedSize += size;
  run.closeNotional += size * price;
  addCloseAccounting(run, fill);
}

function addCloseAccounting(run: RunAccumulator, fill: ClosedPositionFill): void {
  run.realizedPnl += toFinite(fill.closedPnl);
  run.feeUsd += toFinite(fill.fee);
  run.lastCloseTime = fill.time;
  run.lastCloseOid = fill.oid;
  run.lastCloseOrderType = fill.orderType;
  if (isLiquidationDir(fill.dir)) run.liquidated = true;
}

function finishRun(run: RunAccumulator): ClosedPerpPosition {
  return {
    id: `${run.coin}:${run.lastCloseOid}:${run.lastCloseTime}`,
    coin: run.coin,
    side: run.side,
    closedAt: run.lastCloseTime,
    openedAt: run.openedAt,
    sizeCoin: run.closedSize,
    avgClosePx: run.closedSize > 0 ? run.closeNotional / run.closedSize : 0,
    realizedPnl: run.realizedPnl,
    feeUsd: run.feeUsd,
    partial: run.partial,
    closedBy: run.liquidated ? "liquidation" : reasonFromOrderType(run.lastCloseOrderType),
  };
}

/**
 * Replay the fills per coin, emitting both halves of the account's history:
 * the closed round-trips and the run each coin is still sitting in.
 *
 * Input order does not matter: fills are sorted oldest-first internally,
 * because a signed-size walk only reconstructs a position when it replays in
 * the order the venue executed it, and `listPerpFills` hands them back newest
 * first.
 */
function walkFills(fills: readonly ClosedPositionFill[]): FillsWalk {
  const byCoin = new Map<string, ClosedPositionFill[]>();
  for (const fill of fills) {
    const size = toFinite(fill.sz);
    if (!Number.isFinite(fill.time) || fill.time <= 0 || size <= 0) continue;
    const bucket = byCoin.get(fill.coin);
    if (bucket) bucket.push(fill);
    else byCoin.set(fill.coin, [fill]);
  }

  const closed: ClosedPerpPosition[] = [];
  const open = new Map<string, OpenPerpRun>();

  for (const [coin, coinFills] of byCoin) {
    // Ascending by time, then by oid so two fills sharing a millisecond still
    // replay deterministically rather than depending on the venue's paging.
    const ordered = [...coinFills].sort((a, b) => a.time - b.time || a.oid - b.oid);

    let runningSize = 0;
    let run: RunAccumulator | null = null;
    let sawOpen = false;
    let unknownSide: PositionSide | null = null;

    for (const fill of ordered) {
      const size = toFinite(fill.sz);
      const price = toFinite(fill.px);
      const delta = fill.side === "buy" ? size : -size;
      const closing = isClosingDir(fill.dir);
      const closingSide = closing
        ? (closingSideFromDir(fill.dir) ?? (fill.side === "sell" ? "long" : "short"))
        : null;
      const flip = flipSidesFromDir(fill.dir);

      if (runningSize === 0 && flip) {
        const expectedFillSide = flip.opened === "long" ? "buy" : "sell";
        if (fill.side !== expectedFillSide) continue;

        if (run?.partial) {
          if (run.side === flip.closed) addCloseAccounting(run, fill);
          closed.push(finishRun(run));
        }

        // Without a replayed origin size, neither half of the fill's size is
        // known. Remember only the destination side so later closes can retain
        // their authoritative accounting without inventing a live magnitude.
        run = null;
        unknownSide = flip.opened;
        continue;
      }

      if (unknownSide && closing) {
        const expectedFillSide = unknownSide === "long" ? "sell" : "buy";
        if (closingSide !== unknownSide || fill.side !== expectedFillSide) continue;
        run ??= newRun(coin, unknownSide, null, true);
        addCloseFill(run, fill, size, price);
        continue;
      }

      if (unknownSide && !closing) unknownSide = null;

      // Prefix case: the window opens mid-position, so the first fills we see
      // reduce a position whose entry we cannot observe. Seed the run from the
      // fill itself and flag it, rather than reporting an entry we never saw.
      if (runningSize === 0 && closing && closingSide) {
        if (run?.partial && run.side === closingSide) {
          addCloseFill(run, fill, size, price);
          continue;
        }
        if (!sawOpen && !run) {
          run = newRun(coin, closingSide, null, true);
          addCloseFill(run, fill, size, price);
          continue;
        }
        // A close at flat after a visible open cannot establish a new position.
        continue;
      }

      // A real open ends any prefix run: everything before this point belonged
      // to the position that was already running when the window started.
      if (!closing && run?.partial) {
        closed.push(finishRun(run));
        run = null;
      }
      if (!closing) sawOpen = true;

      const before = runningSize;

      if (closing && closingSide) {
        const runningSide = before > 0 ? "long" : "short";
        const expectedFillSide = closingSide === "long" ? "sell" : "buy";
        if (runningSide !== closingSide || fill.side !== expectedFillSide) continue;

        if (!flip && size > Math.abs(before)) {
          if (!run || run.side !== closingSide) continue;

          // The visible opening fills do not cover this close. Keep the side
          // stated by the venue, but do not turn the excess into the opposite
          // position; the missing prefix makes the run partial.
          run.partial = true;
          run.openedAt = null;
          addCloseFill(run, fill, size, price);
          runningSize = 0;
          continue;
        }
      }

      const after = before + delta;

      if (before === 0) {
        // Opening a fresh run. A closing-labelled fill cannot open one.
        if (!closing) {
          run = newRun(coin, after > 0 ? "long" : "short", fill.time, false);
        }
        runningSize = after;
        continue;
      }

      // The portion of this fill that actually reduced the position. A flip
      // ("Long > Short") closes |before| and opens the remainder, so only
      // |before| is attributed to the run that is ending.
      const reducing = Math.min(size, Math.abs(before));
      if (closing && run && reducing > 0) {
        addCloseFill(run, fill, reducing, price);
      }

      const flat = Math.abs(after) < 1e-12;
      const flipped = !flat && Math.sign(after) !== Math.sign(before);

      if ((flat || flipped) && run) {
        closed.push(finishRun(run));
        run = flipped ? newRun(coin, after > 0 ? "long" : "short", fill.time, false) : null;
      } else if (!closing && !run) {
        // Scale-in with no run open (only reachable when the window began
        // mid-position and the prefix run was already emitted).
        run = newRun(coin, after > 0 ? "long" : "short", fill.time, false);
      }

      runningSize = flat ? 0 : after;
    }

    // A prefix run that never met an opening fill still closed a real position.
    if (run?.partial && runningSize === 0) closed.push(finishRun(run));
    // Whatever is left running at the end of the walk is the CURRENT position:
    // never a closed round-trip, but the carrier of the realized PnL banked on
    // it so far (partial take-profits, scale-outs) that the open-positions
    // table shows as RPNL.
    else if (run && runningSize !== 0) {
      open.set(coin, {
        coin,
        side: run.side,
        signedSize: runningSize,
        openedAt: run.openedAt,
        realizedPnl: run.realizedPnl,
        feeUsd: run.feeUsd,
      });
    }
  }

  return { closed: closed.sort((a, b) => b.closedAt - a.closedAt), open };
}

/**
 * Fold fills into closed round-trips, newest close first.
 *
 * See `walkFills` for the replay itself. A run still open at the end of the
 * walk is deliberately NOT emitted here: that is a current position, and it
 * already has a panel of its own that reads live mark and unrealized PnL from
 * the clearinghouse. Use `openPerpRealizedByCoin` for its realized half.
 */
export function closedPerpPositions(
  fills: readonly ClosedPositionFill[],
): ClosedPerpPosition[] {
  return walkFills(fills).closed;
}

/** The subset of a `positions.listPerps` row the reconciliation below reads. */
export interface OpenPositionSizeRow {
  coin: string;
  side: "long" | "short";
  /** Absolute size, as HL reports it (`Math.abs(szi)` stringified). */
  size: string;
}

/**
 * Realized PnL banked on each CURRENTLY OPEN position, keyed by coin.
 *
 * WHY THIS IS RECONCILED AGAINST THE LIVE POSITION. The walk starts from flat,
 * so a position whose opening fills predate the fills window replays as a
 * smaller (or differently-signed) run than the one the clearinghouse actually
 * holds. Reporting that run's realized PnL would silently understate a number
 * users trade against. A coin is therefore only included when the replayed
 * signed size matches the live one; otherwise it is absent, and the table shows
 * a dash rather than a wrong number.
 */
export function openPerpRealizedByCoin(
  fills: readonly ClosedPositionFill[],
  positions: readonly OpenPositionSizeRow[],
): Map<string, OpenPerpRun> {
  const { open } = walkFills(fills);
  const reconciled = new Map<string, OpenPerpRun>();

  for (const position of positions) {
    const run = open.get(position.coin);
    if (!run) continue;
    const magnitude = Math.abs(toFinite(position.size));
    if (!Number.isFinite(magnitude) || magnitude === 0) continue;
    const liveSigned = position.side === "long" ? magnitude : -magnitude;
    // Relative tolerance: HL sizes carry up to 8 decimals, and the walk sums
    // them, so exact equality would drop legitimate matches to float drift.
    const tolerance = Math.max(1e-8, Math.abs(liveSigned) * 1e-8);
    if (Math.abs(run.signedSize - liveSigned) > tolerance) continue;
    reconciled.set(position.coin, run);
  }

  return reconciled;
}
