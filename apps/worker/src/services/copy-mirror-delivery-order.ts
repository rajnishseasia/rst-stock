/**
 * PURE delivery ordering for the copy-mirror queue (audit H7: own module).
 *
 * `stageWindow` inserts every candidate discovered in one poll window with the
 * SAME `next_attempt_at`, and the due query orders by that column alone. Rows
 * that tie there come back in whatever order Postgres finds convenient, which
 * is not an order at all.
 *
 * That is fine until a source trader opens AND closes inside a single window,
 * which on a 30-second poll interval is an ordinary scalp:
 *
 *   1. The CLOSE is handed to the worker first. The follower has no position
 *      yet, so the reduce-only mirror skips with "no-position" and the delivery
 *      is marked completed. It will never be retried: it succeeded.
 *   2. The OPEN is handed to the worker second. It opens a leveraged position
 *      in a trade the source is already out of.
 *
 * The follower is now long alone, at leverage, with the only instruction that
 * would have closed it already consumed. Nothing downstream detects this: both
 * deliveries did exactly what they were told.
 *
 * The fix is to give the queue a real order: the SOURCE event time. Entries
 * precede their own closes because that is when they happened. Ties break
 * toward opening before closing, then on the source item id so two runs of the
 * same window always produce the same sequence.
 */

/** The candidate fields ordering depends on. Structural, so tests need no DB. */
export interface OrderableCandidate {
  sourceItemId: string;
  /** ISO source event time (the trade/signal timestamp), when known. */
  sourceEventAt?: string;
  /** Reduce-only perp mirrors are closes; everything else opens or adds. */
  perpReduceOnly?: boolean;
}

/** Wallet opens keep their stricter source-specific freshness window. */
export const HL_WALLET_OPEN_MAX_AGE_MS = 5 * 60_000;

/**
 * A stale or unorderable wallet open is terminal; closes and other sources are
 * deliberately outside this narrower eligibility rule.
 */
export function isExpiredWalletOpenIntent(
  candidate: OrderableCandidate,
  nowMs: number,
): boolean {
  if (!candidate.sourceItemId.startsWith("hl_wallet:") || candidate.perpReduceOnly === true) {
    return false;
  }
  const eventMs = sourceEventTimeMs(candidate);
  return eventMs === null || !Number.isFinite(nowMs) || eventMs > nowMs || nowMs - eventMs > HL_WALLET_OPEN_MAX_AGE_MS;
}

/**
 * Source event time in epoch millis, or null when it is missing or unusable.
 *
 * Never coerced to "now": a candidate with no readable timestamp has an unknown
 * position in the sequence, and the caller decides what to do with that.
 */
export function sourceEventTimeMs(candidate: OrderableCandidate): number | null {
  const raw = candidate.sourceEventAt?.trim() ?? "";
  if (raw === "") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compare two candidates for execution order.
 *
 * An unknown event time sorts FIRST, not last. The failure this ordering exists
 * to prevent is a close overtaking its own entry, so when we cannot place an
 * item precisely, the safe place for it is ahead of the closes rather than
 * behind them. (For perps such a candidate is separately refused by the intent
 * age bound, which cannot certify an unknown age as fresh.)
 */
export function compareDeliveryOrder(
  a: OrderableCandidate,
  b: OrderableCandidate,
): number {
  const aMs = sourceEventTimeMs(a);
  const bMs = sourceEventTimeMs(b);
  if (aMs !== bMs) {
    if (aMs === null) return -1;
    if (bMs === null) return 1;
    return aMs - bMs;
  }

  // Same instant: open before close, so a same-timestamp scalp still lands in
  // an order the follower can actually hold.
  const aClose = a.perpReduceOnly === true ? 1 : 0;
  const bClose = b.perpReduceOnly === true ? 1 : 0;
  if (aClose !== bClose) return aClose - bClose;

  // Total order, so the sequence is reproducible across runs and processes.
  return a.sourceItemId < b.sourceItemId ? -1 : a.sourceItemId > b.sourceItemId ? 1 : 0;
}

/** Deterministic execution order for one window's candidates. Non-mutating. */
export function orderCandidatesBySourceEvent<T extends OrderableCandidate>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort(compareDeliveryOrder);
}

/**
 * How far back the staged `next_attempt_at` values may be spread. Bounded so a
 * pathologically large window cannot backdate a delivery past a checkpoint.
 */
export const MAX_STAGE_SPREAD_MS = 60_000;

/**
 * Encode a candidate's rank into its `next_attempt_at` so the DB's own ordering
 * carries it, even when the batch limit splits the window across poll cycles.
 *
 * The spread goes BACKWARD from the window end (rank 0 is the earliest) so that
 * every staged row is still due immediately. Stamping forward would push all
 * but the first candidate into the next cycle.
 *
 * Once the spread saturates, earlier ranks share a timestamp and ordering falls
 * back to the in-memory comparison, which is applied to every loaded batch.
 */
export function stagedAttemptAt(windowEnd: Date, rank: number, total: number): Date {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeRank = Math.min(Math.max(0, Math.floor(rank)), safeTotal - 1);
  const offsetMs = Math.min(safeTotal - 1 - safeRank, MAX_STAGE_SPREAD_MS);
  return new Date(windowEnd.getTime() - offsetMs);
}

/**
 * Re-impose the source-event order on a loaded batch.
 *
 * Belt and suspenders with `stagedAttemptAt`: retries and saturated spreads can
 * both produce ties in the column the query sorts on.
 */
export function orderDueDeliveries<T extends { candidate: unknown }>(
  rows: readonly T[],
): T[] {
  const readable = (row: T): OrderableCandidate => {
    const candidate = row.candidate as Partial<OrderableCandidate> | null | undefined;
    return {
      sourceItemId: typeof candidate?.sourceItemId === "string" ? candidate.sourceItemId : "",
      sourceEventAt:
        typeof candidate?.sourceEventAt === "string" ? candidate.sourceEventAt : undefined,
      perpReduceOnly: candidate?.perpReduceOnly === true,
    };
  };
  return [...rows].sort((a, b) => compareDeliveryOrder(readable(a), readable(b)));
}

/**
 * Runs different followers concurrently while preserving each follower's exact
 * source-event sequence. This removes cross-account head-of-line blocking
 * without allowing an account's close to overtake its own open.
 */
export async function runFollowerDeliveryLanes<
  T extends { followerUserId: string; candidate?: unknown },
>(
  rows: readonly T[],
  concurrency: number,
  processRow: (row: T) => Promise<boolean | void>,
): Promise<void> {
  const candidateFor = (row: T): OrderableCandidate => {
    const outer = row as T & Partial<OrderableCandidate>;
    const nested = outer.candidate;
    const candidate = nested && typeof nested === "object"
      ? nested as Partial<OrderableCandidate>
      : outer;
    return {
      sourceItemId: typeof candidate.sourceItemId === "string" ? candidate.sourceItemId : "",
      sourceEventAt: typeof candidate.sourceEventAt === "string" ? candidate.sourceEventAt : undefined,
      perpReduceOnly: candidate.perpReduceOnly === true,
    };
  };

  const lanes = new Map<string, T[]>();
  for (const row of rows) {
    const lane = lanes.get(row.followerUserId);
    if (lane) lane.push(row);
    else lanes.set(row.followerUserId, [row]);
  }

  const pending = [...lanes.values()];
  for (const lane of pending) {
    lane.sort((a, b) => compareDeliveryOrder(candidateFor(a), candidateFor(b)));
  }
  const firstClose = (lane: T[]): OrderableCandidate | null => {
    for (const row of lane) {
      const candidate = candidateFor(row);
      if (candidate.perpReduceOnly === true) return candidate;
    }
    return null;
  };
  const laneRank = (lane: T[]): number => {
    if (candidateFor(lane[0]!).perpReduceOnly === true) return 0;
    return firstClose(lane) ? 1 : 2;
  };
  const compareLanes = (a: T[], b: T[]): number => {
    const rankDifference = laneRank(a) - laneRank(b);
    if (rankDifference !== 0) return rankDifference;
    const aKey = laneRank(a) === 1 ? firstClose(a)! : candidateFor(a[0]!);
    const bKey = laneRank(b) === 1 ? firstClose(b)! : candidateFor(b[0]!);
    const eventOrder = compareDeliveryOrder(aKey, bKey);
    if (eventOrder !== 0) return eventOrder;
    const aFollower = a[0]!.followerUserId;
    const bFollower = b[0]!.followerUserId;
    return aFollower < bFollower ? -1 : aFollower > bFollower ? 1 : 0;
  };

  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), pending.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (pending.length > 0) {
      pending.sort(compareLanes);
      const lane = pending.shift();
      if (!lane) return;
      for (const row of lane) {
        if ((await processRow(row)) === false) break;
      }
    }
  }));
}
