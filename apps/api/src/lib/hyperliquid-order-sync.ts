/**
 * Pure reconciliation logic for the Hyperliquid perp order-sync poller.
 *
 * Extracted from the worker service so the mapping — HL `userFills` / `openOrders`
 * → the `orders` table's `order_status` enum + executed fields — can be unit
 * tested against the REAL wrapper (`toCloid`) with no DB, no network, and no
 * Privy (per the CLAUDE.md real-module test audit). The worker imports these and
 * only owns the DB read/write + polling loop.
 *
 * Data-model contract (see apps/api/src/lib/perp-orders.ts):
 *   - A perp order row is `venue="hyperliquid"`, `assetType="PERP"`, and stores
 *     the RAW idempotency seed in `clientOrderId`. The ON-CHAIN cloid is
 *     `toCloid(clientOrderId)`, so we hash the stored seed to match HL responses.
 *   - Fractional sizes/prices live in DECIMAL columns: executed size →
 *     `executedSizeDecimal` (NOT `quantityDecimal`, which holds the original
 *     REQUESTED size and is preserved as an audit trail), executed price →
 *     `executedPrice`, realized pnl → `realizedPnl`.
 *     The INTEGER `quantity`/`executedQuantity` columns are NEVER written for perps.
 *   - `brokerOrderId` is backfilled from the HL numeric `oid` on first match.
 *
 * This module is READ-ONLY reconciliation: it computes state transitions from HL
 * responses. It never places, cancels, closes, or transfers anything.
 */

import { toCloid } from "@trade-bot/hyperliquid";

/** DB order statuses this reconciler can transition an open perp order into. */
export type PerpSyncStatus = "FILLED" | "PARTIAL" | "CANCELLED";

/**
 * The subset of a HL `userFills` entry the reconciler consumes. Structurally a
 * subset of `@nktkas/hyperliquid`'s `UserFillsResponse[number]` so live responses
 * pass without adaptation.
 */
export interface HlFill {
  coin: string;
  /** Fill price (decimal string). */
  px: string;
  /** Fill size (decimal string, always positive). */
  sz: string;
  /** "B" = buy, "A" = sell. */
  side: "B" | "A";
  /** HL numeric order id. */
  oid: number;
  /** On-chain client order id (present when the order carried a cloid). */
  cloid?: `0x${string}`;
  /** Cumulative funding realized on this fill (signed decimal string). */
  closedPnl?: string;
  time?: number;
  /**
   * Unique identifier for one partial fill, per the venue's own type. Used with
   * `time` as the accumulation cursor; see `fillCursor`.
   */
  tid?: number;
}

/**
 * The subset of a HL `openOrders` entry the reconciler consumes. Structurally a
 * subset of `@nktkas/hyperliquid`'s `OpenOrdersResponse[number]`.
 */
export interface HlOpenOrder {
  coin: string;
  oid: number;
  cloid?: `0x${string}`;
  /** Remaining resting size (decimal string). */
  sz: string;
  /** Original size at placement (decimal string). */
  origSz: string;
  /**
   * When the VENUE says the order was placed (ms since epoch).
   *
   * Optional only because older call sites and fixtures predate it. It is the
   * one authoritative placement time available for an order that has not
   * filled, and the only honest thing to write into `placed_at` from a resting
   * order: observation time misdates anything placed before today.
   */
  timestamp?: number;
}

/**
 * The subset of an `orders` row the reconciler needs. Kept minimal so the pure
 * function is trivially testable without constructing a full Drizzle row.
 */
export interface OpenPerpOrder {
  id: string;
  /** Raw idempotency seed stored in `orders.client_order_id`. */
  clientOrderId: string | null;
  /** Original requested size (decimal string in `quantityDecimal`). Never mutated by sync. */
  quantityDecimal: string | null;
  /** Cumulative executed size already recorded (decimal string in `executedSizeDecimal`). */
  executedSizeDecimal: string | null;
  /** The newest fill `executedSizeDecimal` already counts, or null. See `fillCursor`. */
  lastCountedFillId?: string | null;
  /** Cumulative VWAP already recorded, needed to extend it rather than replace it. */
  executedPrice?: string | null;
  /** Cumulative funding already recorded, for the same reason. */
  realizedPnl?: string | null;
  /** Placement time (ms since epoch, from `orders.created_at`) — guards the CANCELLED transition. */
  createdAtMs: number;
  /** Current DB status — used to avoid no-op writes. */
  status: string;
  /** Already-recorded broker order id (HL oid), if any. */
  brokerOrderId: string | null;
}

/** Tuning knobs for the CANCELLED-transition safety guard (finding #9). */
export interface ReconcileOptions {
  /** Now, ms since epoch. Required for the min-age guard; when omitted the age guard is skipped. */
  nowMs?: number;
  /**
   * Minimum order age before a "no fills + not resting" order may be marked
   * CANCELLED. Protects against the just-placed race (order not yet visible in
   * `openOrders`). Default 45s.
   */
  minCancelAgeMs?: number;
  /**
   * Set when the order's venue network is UNKNOWN (a row written before
   * `venue_network` existed).
   *
   * Cancellation is the one transition inferred from ABSENCE of evidence, and
   * absence is exactly what an unproven network makes unreliable: an old testnet
   * order cannot appear in a mainnet snapshot, so "no fill, nothing resting"
   * says nothing about it. Fills are unaffected, because a fill matching our
   * cloid on this network IS ours whatever the row claims.
   *
   * Such a row therefore stays open rather than being settled on a guess. It
   * keeps the behaviour it had before this poller ran by default, which is the
   * safe direction: a row left open can still be reconciled later, a row settled
   * CANCELLED is never polled again.
   */
  networkUnproven?: boolean;
}

const DEFAULT_MIN_CANCEL_AGE_MS = 45_000;

/** The reconciled update to persist, or `null` when nothing changed. */
export interface PerpSyncUpdate {
  orderId: string;
  status: PerpSyncStatus;
  /** Cumulative executed size (decimal string) → `executedSizeDecimal` (NOT `quantityDecimal`). */
  executedSize: string;
  /** Volume-weighted average fill price (decimal string) → `executedPrice`. Null if unknown. */
  executedPrice: string | null;
  /** Cumulative realized pnl (decimal string) → `realizedPnl`. Null if none. */
  realizedPnl: string | null;
  /** HL numeric order id → `brokerOrderId`. Null when not yet known. */
  brokerOrderId: string | null;
  /** Fill timestamp (ms since epoch) of the most recent matched fill, or null. */
  executedAtMs: number | null;
  /**
   * The newest fill this update's `executedSize` counts, to be persisted as the
   * cursor for the next cycle. Null leaves the stored cursor untouched.
   */
  lastCountedFillId: string | null;
}

/**
 * The on-chain cloid for a stored order, or null when the row has no idempotency
 * seed (legacy / manual rows). Hashing here (not string-equality on the seed) is
 * REQUIRED: `orders.client_order_id` holds the raw seed while HL echoes the
 * 128-bit `toCloid(seed)`.
 */
/**
 * How a venue entry (fill or resting order) is recognised as this order's.
 *
 * By cloid when both carry one, and by the recorded broker order id otherwise.
 * Shared so every caller matches identically: a second implementation that
 * drifted would have one code path see an order at the venue and another not.
 */
export function venueEntryMatcher(
  order: OpenPerpOrder,
): (entryCloid: `0x${string}` | undefined, entryOid: number) => boolean {
  const cloid = orderCloid(order);
  const recordedOid = order.brokerOrderId ? Number(order.brokerOrderId) : null;
  return (entryCloid, entryOid) => {
    if (cloid && entryCloid && entryCloid.toLowerCase() === cloid.toLowerCase()) return true;
    if (recordedOid !== null && entryOid === recordedOid) return true;
    return false;
  };
}

/**
 * The resting order the venue is holding for this row, if any.
 *
 * A match is the venue CONFIRMING it accepted the order, which is worth knowing
 * on its own: `reconcilePerpOrder` returns null for a resting order with no
 * fills, since there is no state change to record, but acceptance is still a
 * fact the caller may need to persist.
 */
export function findRestingMatch(
  order: OpenPerpOrder,
  openOrders: HlOpenOrder[],
): HlOpenOrder | null {
  const matches = venueEntryMatcher(order);
  return openOrders.find((entry) => matches(entry.cloid, entry.oid)) ?? null;
}

export function orderCloid(order: OpenPerpOrder): `0x${string}` | null {
  if (!order.clientOrderId) return null;
  return toCloid(order.clientOrderId);
}

/**
 * Volume-weighted average price across fills. Returns a decimal string, or null
 * when there is no executed size (avoids a divide-by-zero / NaN write).
 */
export function vwap(fills: Array<{ px: string; sz: string }>): string | null {
  let notional = 0;
  let size = 0;
  for (const f of fills) {
    const px = parseFloat(f.px);
    const sz = parseFloat(f.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    notional += px * sz;
    size += sz;
  }
  if (size <= 0) return null;
  return (notional / size).toString();
}

/** Sum a list of decimal strings, returning a decimal string (or null if empty). */
export function sumDecimals(values: Array<string | undefined>): string | null {
  let total = 0;
  let seen = false;
  for (const v of values) {
    if (v === undefined) continue;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) continue;
    total += n;
    seen = true;
  }
  return seen ? total.toString() : null;
}

/**
 * Extend a recorded cumulative VWAP with newly counted fills.
 *
 * The parent row stores a cumulative average, and once a cursor makes the
 * matched fills a SUFFIX, averaging that suffix alone would overwrite the whole
 * with a part. Notional is additive where averages are not, so the two are
 * combined by notional and divided by the combined size.
 *
 * Returns null when there is nothing to extend from and nothing new, which the
 * worker reads as "no new information" and leaves the recorded value alone.
 */
export function extendVwap(
  recordedSize: string,
  recordedPrice: string | null,
  fills: Array<{ px: string; sz: string }>,
): string | null {
  const addedSize = sumDecimals(fills.map((f) => f.sz));
  if (addedSize === null) return recordedPrice;
  const addedNotional = fills.reduce(
    (total, f) => total + parseFloat(f.px) * parseFloat(f.sz),
    0,
  );
  const previousSize = parseFloat(recordedSize);
  const previousNotional =
    recordedPrice === null || !Number.isFinite(previousSize)
      ? 0
      : parseFloat(recordedPrice) * previousSize;
  const totalSize = (Number.isFinite(previousSize) ? previousSize : 0) + parseFloat(addedSize);
  if (!Number.isFinite(totalSize) || totalSize <= 0) return recordedPrice;
  return ((previousNotional + addedNotional) / totalSize).toString();
}

/**
 * Exact sum of decimal strings, for the CUMULATIVE size only.
 *
 * `sumDecimals` above goes through IEEE-754, which is fine for the values it was
 * written for and wrong here: 0.7 recorded plus a 0.1 fill comes to
 * 0.7999999999999999, that is persisted as the follower's cumulative exposure,
 * and the fixed-point close reconstruction then truncates it to market precision
 * (0.79999 at five decimals). A full mirrored close leaves one size increment of
 * leveraged exposure open, which is the exact failure this column exists to
 * prevent.
 *
 * Scales are aligned and the addition done on integers, so the result is the
 * decimal a person would write. Returns null when any input is unparseable,
 * which callers treat as "no usable sum" rather than zero.
 */
export function addDecimalsExact(values: Array<string | undefined | null>): string | null {
  let scale = 0;
  const parsed: Array<{ digits: string; negative: boolean; scale: number }> = [];
  for (const value of values) {
    if (value === undefined || value === null || value.trim() === "") continue;
    const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
    if (!match) return null;
    const fraction = match[3] ?? "";
    parsed.push({
      digits: `${match[2] || "0"}${fraction}`,
      negative: match[1] === "-",
      scale: fraction.length,
    });
    if (fraction.length > scale) scale = fraction.length;
  }
  if (parsed.length === 0) return null;

  let total = 0n;
  for (const entry of parsed) {
    const scaled = BigInt(entry.digits) * 10n ** BigInt(scale - entry.scale);
    total += entry.negative ? -scaled : scaled;
  }

  const negative = total < 0n;
  const absolute = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = absolute.slice(0, absolute.length - scale) || "0";
  const fraction = scale === 0 ? "" : absolute.slice(absolute.length - scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A stable, comparable identity for one venue fill: its time and its tid.
 *
 * `userFills` is a RECENT-fill window, not the account's history, so a
 * cumulative size cannot be recomputed from whatever it happens to return: an
 * earlier fill that has aged out makes the remainder look like the whole. The
 * cursor makes accumulation incremental instead. Fills at or before it are
 * already counted; only newer ones are added.
 *
 * `tid` is documented by the venue as unique per partial fill, so pairing it
 * with `time` gives a total order that is consistent between calls, whether or
 * not tids are globally monotonic: the same tuples are compared each time rather
 * than re-derived.
 *
 * KNOWN LIMIT: a fill that arrives later but shares a millisecond with a counted
 * fill AND carries a lower tid sorts below the cursor and is skipped. That
 * undercounts executed size, which understates exposure rather than overstating
 * it, so a close sizes small and leaves a residue instead of reducing more than
 * the mirror opened.
 */
export function fillCursor(fill: { time?: number; tid?: number }): string | null {
  if (fill.time === undefined) return null;
  return `${fill.time}:${fill.tid ?? 0}`;
}

/** True when `cursor` is strictly newer than `previous`. Nulls sort oldest. */
export function isNewerFill(cursor: string | null, previous: string | null): boolean {
  if (cursor === null) return false;
  if (previous === null) return true;
  const cursorParts = cursor.split(":").map(Number);
  const previousParts = previous.split(":").map(Number);
  const cursorTime = cursorParts[0] ?? Number.NaN;
  const previousTime = previousParts[0] ?? Number.NaN;
  if (!Number.isFinite(cursorTime) || !Number.isFinite(previousTime)) return false;
  if (cursorTime !== previousTime) return cursorTime > previousTime;
  return (cursorParts[1] ?? 0) > (previousParts[1] ?? 0);
}

/**
 * Cumulative executed size only ever moves UP.
 *
 * `userFills` is a recent-fill window. When an earlier fill for an order has
 * aged out of it but a later one has not, summing what remains produces a
 * SUFFIX of the true cumulative size, not the whole of it. Writing that back
 * silently reduces the recorded execution, and `executedSizeDecimal` is the
 * only record of how much exposure a perp order opened: shrinking it corrupts
 * close attribution and undersizes the exit.
 *
 * Fills do not un-happen, so a recorded size is never replaced by a smaller
 * one. Float comparison matches `sumDecimals` above, which already produces
 * these strings via float arithmetic.
 */
export function neverDecreasingSize(recorded: string | null, computed: string): string {
  if (!recorded) return computed;
  const previous = parseFloat(recorded);
  const next = parseFloat(computed);
  if (!Number.isFinite(previous)) return computed;
  if (!Number.isFinite(next)) return recorded;
  return next >= previous ? computed : recorded;
}

/**
 * Reconcile ONE open perp order against the HL fills + open-orders snapshot for
 * its account. Pure: returns the update to persist, or `null` when the order is
 * unchanged (still resting with no new fills).
 *
 * Rules:
 *   - Match fills/open-orders by the on-chain cloid (`toCloid(clientOrderId)`);
 *     fall back to `brokerOrderId === oid` when a cloid-less order already has an
 *     oid recorded.
 *   - Fills present + order NOT resting  → FILLED.
 *   - Fills present + order STILL resting → PARTIAL.
 *   - No fills + not resting              → CANCELLED — but ONLY once it clears the
 *     safety guard (finding #9):
 *       (a) A just-placed order may not yet appear in `openOrders`; require the
 *           order to be older than `minCancelAgeMs`.
 *       (b) An entirely empty account snapshot is almost certainly a transient HL
 *           hiccup — treated as such while the order is young. Once the order is
 *           older than `minCancelAgeMs`, trust the empty snapshot (the request was
 *           never accepted) and declare CANCELLED so it does not stay PENDING forever.
 *     Otherwise → null.
 *   - No fills + still resting            → no change (returns null).
 */
export function reconcilePerpOrder(
  order: OpenPerpOrder,
  fills: HlFill[],
  openOrders: HlOpenOrder[],
  opts: ReconcileOptions = {},
): PerpSyncUpdate | null {
  const matches = venueEntryMatcher(order);
  const recordedOid = order.brokerOrderId ? Number(order.brokerOrderId) : null;

  const matchedFills = fills.filter((f) => matches(f.cloid, f.oid));
  const restingMatch = findRestingMatch(order, openOrders);

  // Determine the HL oid for this order from whichever source carries it.
  const oid =
    matchedFills[0]?.oid ??
    restingMatch?.oid ??
    (recordedOid !== null ? recordedOid : null);

  if (matchedFills.length === 0) {
    // Never filled. If it is still resting, nothing to do.
    if (restingMatch) return null;

    // SAFETY GUARD (finding #9):
    //  (a) A just-placed order may not yet appear in `openOrders`; require the
    //      order to be older than `minCancelAgeMs` before declaring it cancelled.
    //  (b) An entirely empty account snapshot (no fills AND no open orders) is
    //      almost certainly a transient HL response while the order is young.
    //      Once the order passes `minCancelAgeMs`, trust the empty snapshot:
    //      the request was never accepted and the row would stay PENDING forever
    //      without this escape hatch.
    // An unproven network cannot support an absence argument. See
    // `networkUnproven`.
    if (opts.networkUnproven) return null;

    // KNOWN LIMIT, not fixed here: `userFills` is a bounded RECENT-fill window,
    // so an order that filled and then went unreconciled long enough for its
    // fills to age out arrives here indistinguishable from one that never
    // filled. Cancelling it writes executed size 0 over a live position and
    // retires the row from the scan set.
    //
    // Blocking cancellation for anything we saw reach the venue was tried and
    // backed out: it leaves every genuinely unfilled order open forever, and
    // those accumulate in a capped newest-first scan until older rows are hidden
    // permanently, which is the wedge failure this file has fixed twice already.
    // Trading a narrow data loss for an unbounded one is not an improvement.
    //
    // The real fix is to stop inferring a final state from the fill window and
    // ask the venue for it (historicalOrders / orderStatus by oid), which is a
    // new call and belongs with the durable-exposure work rather than here.
    const minAge = opts.minCancelAgeMs ?? DEFAULT_MIN_CANCEL_AGE_MS;
    const orderIsYoung = opts.nowMs !== undefined && opts.nowMs - order.createdAtMs < minAge;
    if (fills.length === 0 && openOrders.length === 0 && (opts.nowMs === undefined || orderIsYoung)) return null;
    if (orderIsYoung) return null;

    return {
      orderId: order.id,
      // The REMAINDER is cancelled. Anything already executed is not.
      //
      // `userFills` is a recent-fill window, not the account's history, so an
      // order whose fills have aged out of it arrives here looking exactly like
      // one that never filled. Writing "0" in that case does not record a
      // cancellation, it erases a fill that already happened, and
      // `executedSizeDecimal` is the only record of how much exposure a perp
      // order opened: destroying it leaves a live position that no mirrored
      // close can attribute or size against.
      //
      // A fill that aged out did not un-happen, so a recorded size is carried
      // through. `quantityDecimal` (the requested size) is left untouched by the
      // worker either way.
      status: "CANCELLED",
      executedSize: neverDecreasingSize(order.executedSizeDecimal, "0"),
      executedPrice: null,
      realizedPnl: null,
      brokerOrderId: oid !== null ? String(oid) : order.brokerOrderId,
      executedAtMs: null,
      // No fills were counted, so the cursor stays where it was.
      lastCountedFillId: null,
    };
  }

  // Only fills NEWER than the cursor are added to what is already recorded.
  //
  // Summing the whole window and calling it cumulative is what made a rolled
  // window shrink the record: with an earlier fill aged out, the remainder read
  // as the whole. Accumulating forward from the cursor is immune to that,
  // because what has already been counted is never revisited.
  //
  // WITHOUT a cursor the old reading is kept, and that is the migration path
  // rather than an oversight. A row written before the column existed has a
  // recorded size that already includes the fills still in the window, so adding
  // the window to it would double count. Such a row keeps recomputing from the
  // window (and keeps the aged-out risk) until its first fill under the new
  // scheme sets a cursor.
  const previousCursor = order.lastCountedFillId ?? null;
  const hasCursor = previousCursor !== null;
  const contributingFills = hasCursor
    ? matchedFills.filter((fill) => isNewerFill(fillCursor(fill), previousCursor))
    : matchedFills;
  const newestCountedCursor = contributingFills.reduce<string | null>((newest, fill) => {
    const cursor = fillCursor(fill);
    return isNewerFill(cursor, newest) ? cursor : newest;
  }, previousCursor);

  const baseSize = hasCursor ? (order.executedSizeDecimal ?? "0") : "0";
  // Exact, not sumDecimals: this is the cumulative exposure figure, and a float
  // residue here is truncated away by the close reconstruction and leaves real
  // exposure open. See addDecimalsExact.
  const fillsSize =
    addDecimalsExact([baseSize, ...contributingFills.map((f) => f.sz)]) ?? "0";
  // The monotonic guard stays as a backstop. It is no longer the mechanism, but
  // a cursor that is ever wrong should still never shrink the record.
  const executedSize = neverDecreasingSize(order.executedSizeDecimal, fillsSize);
  // When the recorded size wins, these fills are an incomplete SUFFIX of the
  // order's execution, so anything derived from them describes part of it only.
  // A vwap over a suffix is not the order's average price and a realized-pnl sum
  // over one is an undercount, so both are withheld and the worker keeps what it
  // has.
  const partialSnapshot = executedSize !== fillsSize;
  // The parent row's price and realized pnl are CUMULATIVE, so when the cursor makes
  // `contributingFills` a suffix they have to EXTEND what is recorded rather
  // than replace it. Replacing them stored the suffix's own average: 1 unit at
  // 100 then 1 at 200 recorded 200 instead of 150, and the synthetic delta price
  // derived from that cumulative figure came out at 300 instead of 200.
  const suffixPrice = contributingFills.length === 0 ? null : vwap(contributingFills);
  const suffixRealized = contributingFills.length === 0
    ? null
    : sumDecimals(contributingFills.map((f) => f.closedPnl));
  const executedPrice = partialSnapshot
    ? null
    : hasCursor
      ? extendVwap(baseSize, order.executedPrice ?? null, contributingFills)
      : suffixPrice;
  const realizedPnl = partialSnapshot
    ? null
    : hasCursor
      ? sumDecimals([order.realizedPnl ?? undefined, suffixRealized ?? undefined])
      : suffixRealized;
  const executedAtMs = contributingFills.reduce<number | null>((latest, f) => {
    if (f.time === undefined) return latest;
    return latest === null || f.time > latest ? f.time : latest;
  }, null);

  // Still resting → partially filled; otherwise fully filled.
  //
  // EXCEPT on an incomplete snapshot. When the monotonic guard overrode the
  // computed size, these fills are a suffix and the recorded total is not known
  // to be final, so calling the order FILLED retires it from the scan set with
  // an understated size and the rest of the exposure is never counted. Holding
  // it at PARTIAL keeps it in the scan set until a snapshot it can trust.
  const status: PerpSyncStatus = restingMatch || partialSnapshot ? "PARTIAL" : "FILLED";

  return {
    orderId: order.id,
    status,
    executedSize,
    // The cursor may only claim fills that were actually INCORPORATED.
    //
    // When the monotonic guard wins, the computed size was discarded and the
    // recorded one kept, so none of these fills went into the total. Advancing
    // the cursor anyway marked them counted and they could never be added:
    // a migrated row recording 0.6 whose fill has aged out, seeing only a later
    // 0.4, kept 0.6, cursored past the 0.4, and stayed at 0.6 forever instead of
    // reaching 1.0. Leaving the cursor null keeps the row recomputing from the
    // window, which is where it already was, until a window it can trust.
    lastCountedFillId: partialSnapshot ? null : newestCountedCursor,
    executedPrice,
    realizedPnl,
    brokerOrderId: oid !== null ? String(oid) : order.brokerOrderId,
    executedAtMs,
  };
}

/**
 * Whether a reconciled update is a real change vs. the current row (avoids
 * no-op writes / notification spam). An update is meaningful when the status
 * differs or the executed size grew.
 */
export function isMeaningfulUpdate(
  order: OpenPerpOrder,
  update: PerpSyncUpdate,
): boolean {
  if (update.status !== order.status) return true;
  // A cursor that moved is meaningful on its own.
  //
  // A migrated PARTIAL whose recorded size already equals the visible fills
  // produces no status or size change, so suppressing the write left it without
  // a cursor. It then keeps recomputing from the window forever, and once those
  // fills age out the monotonic guard holds the old figure and the later ones
  // are never counted: recorded exposure stays understated and a mirrored close
  // leaves a residue. Persisting the cursor is what ends that.
  if (
    update.lastCountedFillId !== null &&
    update.lastCountedFillId !== (order.lastCountedFillId ?? null)
  ) {
    return true;
  }
  // Compare executed-vs-executed (both the recorded and the new value are
  // cumulative EXECUTED size), not executed-vs-requested.
  const prev = order.executedSizeDecimal ? parseFloat(order.executedSizeDecimal) : 0;
  const next = parseFloat(update.executedSize);
  return Number.isFinite(next) && next !== prev;
}
