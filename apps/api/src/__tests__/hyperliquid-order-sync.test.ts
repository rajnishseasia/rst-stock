import { describe, it, expect } from "bun:test";
import { toCloid } from "@trade-bot/hyperliquid";
import {
  reconcilePerpOrder,
  orderCloid,
  vwap,
  sumDecimals,
  isMeaningfulUpdate,
  type HlFill,
  type HlOpenOrder,
  type OpenPerpOrder,
} from "../lib/hyperliquid-order-sync";

/**
 * Real-module tests (per CLAUDE.md audit): import the ACTUAL reconciler and the
 * REAL `toCloid` from the wrapper — no readFileSync+regex, no mocking of the
 * hashing. Covers the userFills/openOrders → order_status mapping the worker's
 * HyperliquidOrderSyncPoller consumes, the DECIMAL executed fields, cloid-based
 * matching, and the CANCELLED (left-book-unfilled) transition.
 */

const SEED = "order-abc-123";
const CLOID = toCloid(SEED); // on-chain cloid the DB seed hashes to

// A placement time well in the past so the default `nowMs` in tests clears the
// min-cancel-age guard unless a test overrides it.
const CREATED_AT = 1_700_000_000_000;
// A "now" comfortably past CREATED_AT + the 45s guard.
const NOW = CREATED_AT + 300_000;
// A non-empty account snapshot (an UNRELATED resting order) so the empty-snapshot
// guard doesn't fire in cancellation tests.
const UNRELATED_OPEN: HlOpenOrder = {
  coin: "ETH",
  oid: 111,
  cloid: toCloid("unrelated"),
  sz: "1",
  origSz: "1",
};

function order(overrides: Partial<OpenPerpOrder> = {}): OpenPerpOrder {
  return {
    id: "row-1",
    clientOrderId: SEED,
    quantityDecimal: "1.5",
    executedSizeDecimal: null,
    createdAtMs: CREATED_AT,
    status: "SUBMITTED",
    brokerOrderId: null,
    ...overrides,
  };
}

function fill(overrides: Partial<HlFill> = {}): HlFill {
  return {
    coin: "BTC",
    px: "60000",
    sz: "1.5",
    side: "B",
    oid: 999,
    cloid: CLOID,
    closedPnl: "0",
    time: 1_700_000_000_000,
    ...overrides,
  };
}

function open(overrides: Partial<HlOpenOrder> = {}): HlOpenOrder {
  return {
    coin: "BTC",
    oid: 999,
    cloid: CLOID,
    sz: "0.5",
    origSz: "1.5",
    ...overrides,
  };
}

describe("orderCloid", () => {
  it("hashes the stored raw seed to the on-chain cloid (not string equality)", () => {
    expect(orderCloid(order())).toBe(CLOID);
    // The stored seed and the on-chain cloid are NOT equal strings.
    expect(SEED).not.toBe(CLOID);
  });

  it("returns null for a row with no idempotency seed", () => {
    expect(orderCloid(order({ clientOrderId: null }))).toBeNull();
  });
});

describe("vwap", () => {
  it("computes a volume-weighted average across fills", () => {
    const v = vwap([
      { px: "100", sz: "1" },
      { px: "200", sz: "3" },
    ]);
    // (100*1 + 200*3) / (1+3) = 700/4 = 175
    expect(v).toBe("175");
  });

  it("returns null when there is no executed size", () => {
    expect(vwap([])).toBeNull();
    expect(vwap([{ px: "100", sz: "0" }])).toBeNull();
  });
});

describe("sumDecimals", () => {
  it("sums decimal strings and skips undefined", () => {
    expect(sumDecimals(["1.5", undefined, "2.25"])).toBe("3.75");
  });
  it("returns null when nothing summable", () => {
    expect(sumDecimals([undefined])).toBeNull();
  });
});

describe("reconcilePerpOrder", () => {
  it("marks an order FILLED when fully filled and no longer resting", () => {
    const update = reconcilePerpOrder(order(), [fill()], []);
    expect(update).not.toBeNull();
    expect(update!.status).toBe("FILLED");
    expect(update!.executedSize).toBe("1.5");
    expect(update!.executedPrice).toBe("60000");
    expect(update!.brokerOrderId).toBe("999"); // oid backfilled
    expect(update!.executedAtMs).toBe(1_700_000_000_000);
  });

  it("marks an order PARTIAL when filled but still resting on the book", () => {
    const fills = [fill({ sz: "1.0" })];
    const update = reconcilePerpOrder(order(), fills, [open({ sz: "0.5" })]);
    expect(update!.status).toBe("PARTIAL");
    expect(update!.executedSize).toBe("1");
  });

  it("aggregates multiple partial fills into VWAP price and summed size", () => {
    const fills = [
      fill({ sz: "1", px: "100", closedPnl: "0.1" }),
      fill({ sz: "3", px: "200", closedPnl: "0.3", time: 1_700_000_050_000 }),
    ];
    const update = reconcilePerpOrder(order({ quantityDecimal: "4" }), fills, []);
    expect(update!.status).toBe("FILLED");
    expect(update!.executedSize).toBe("4");
    expect(update!.executedPrice).toBe("175");
    expect(update!.realizedPnl).toBe("0.4");
    expect(update!.executedAtMs).toBe(1_700_000_050_000); // latest fill time
  });

  it("marks CANCELLED when never filled and no longer resting (guard cleared)", () => {
    // Non-empty snapshot + order older than the min-cancel-age → real cancel.
    const update = reconcilePerpOrder(order(), [], [UNRELATED_OPEN], { nowMs: NOW });
    expect(update!.status).toBe("CANCELLED");
    // Cancel-before-fill: executed size is 0 (quantityDecimal is left untouched
    // by the worker, preserving the requested size).
    expect(update!.executedSize).toBe("0");
    expect(update!.executedPrice).toBeNull();
  });

  it("preserves an already-recorded fill when cancelling the remainder", () => {
    // userFills is a RECENT-fill window, not history, so a partially filled
    // order whose fills have aged out arrives here looking exactly like one that
    // never filled. Writing "0" would not record a cancellation, it would erase
    // a fill that already happened, and executedSizeDecimal is the only record
    // of how much exposure a perp order opened: destroying it leaves a live
    // position no mirrored close can attribute or size against.
    const partiallyFilled = order({ executedSizeDecimal: "0.4", status: "PARTIAL" });
    const update = reconcilePerpOrder(partiallyFilled, [], [UNRELATED_OPEN], { nowMs: NOW });

    // The remainder is cancelled; the executed part stands.
    expect(update!.status).toBe("CANCELLED");
    expect(update!.executedSize).toBe("0.4");
  });

  it("accumulates forward from the cursor instead of resumming the window", () => {
    // The real fix for a rolled window. With a cursor, an earlier fill ageing
    // out cannot shrink the record, because what was already counted is never
    // revisited: only fills newer than the cursor are added.
    const counted = order({
      executedSizeDecimal: "1",
      status: "PARTIAL",
      lastCountedFillId: "1000:5",
    });
    // The 1000:5 fill has aged out; a newer one arrived.
    const later = { ...fill(), sz: "0.25", time: 2000, tid: 9 };
    const update = reconcilePerpOrder(counted, [later], [], { nowMs: NOW });

    expect(update!.executedSize).toBe("1.25");
    expect(update!.lastCountedFillId).toBe("2000:9");
  });

  it("EXTENDS the cumulative price rather than replacing it with the suffix's own", () => {
    // The parent row's price is cumulative. Once the cursor makes the matched
    // fills a suffix, averaging that suffix alone overwrites the whole with a
    // part: 1 unit at 100 then 1 at 200 recorded 200 instead of 150, and the
    // synthetic delta price derived from that came out at 300 instead of 200.
    const counted = order({
      executedSizeDecimal: "1",
      executedPrice: "100",
      status: "PARTIAL",
      lastCountedFillId: "1000:5",
    });
    const later = { ...fill(), sz: "1", px: "200", time: 2000, tid: 9 };
    const update = reconcilePerpOrder(counted, [later], [], { nowMs: NOW });

    expect(update!.executedSize).toBe("2");
    expect(Number(update!.executedPrice)).toBeCloseTo(150, 6);
  });

  it("adds new realized pnl to what is recorded rather than replacing it", () => {
    const counted = order({
      executedSizeDecimal: "1",
      realizedPnl: "5",
      status: "PARTIAL",
      lastCountedFillId: "1000:5",
    });
    const later = { ...fill(), sz: "1", closedPnl: "3", time: 2000, tid: 9 };
    const update = reconcilePerpOrder(counted, [later], [], { nowMs: NOW });

    expect(Number(update!.realizedPnl)).toBeCloseTo(8, 6);
  });

  it("does not re-count a fill the cursor already covers", () => {
    // The window still holds the counted fill. Re-adding it would inflate the
    // record, which is the dangerous direction: attributed exposure is the
    // ceiling on how much a copied close may reduce.
    const counted = order({
      executedSizeDecimal: "1",
      status: "PARTIAL",
      lastCountedFillId: "2000:9",
    });
    const alreadyCounted = { ...fill(), sz: "1", time: 2000, tid: 9 };
    const update = reconcilePerpOrder(counted, [alreadyCounted], [], { nowMs: NOW });

    // Nothing new, so the size is unchanged and the update is not meaningful.
    expect(update === null || update.executedSize === "1").toBe(true);
  });

  it("accumulates cursorized sizes EXACTLY, without float residue", () => {
    // 0.7 + 0.1 is 0.7999999999999999 in IEEE-754. Persisted as cumulative
    // exposure, the fixed-point close reconstruction truncates it to market
    // precision (0.79999 at five decimals), so a full mirrored close leaves one
    // size increment of leveraged exposure open.
    const counted = order({
      executedSizeDecimal: "0.7",
      status: "PARTIAL",
      lastCountedFillId: "1000:5",
    });
    const later = { ...fill(), sz: "0.1", time: 2000, tid: 9 };
    const update = reconcilePerpOrder(counted, [later], [], { nowMs: NOW });

    expect(update!.executedSize).toBe("0.8");
  });

  it("does not go terminal on an incomplete snapshot", () => {
    // Withholding the cursor is not enough on its own: a row that is no longer
    // resting was still marked FILLED, which retires it from the scan set with
    // an understated size, and the poller only scans PENDING/SYNCING/SUBMITTED/PARTIAL
    // so the missing exposure is never counted. Held at PARTIAL it stays in the
    // scan set until a snapshot it can trust.
    const migrated = order({ executedSizeDecimal: "0.6", status: "PARTIAL" });
    const update = reconcilePerpOrder(
      migrated,
      [{ ...fill(), sz: "0.4", time: 2000, tid: 9 }],
      [],
      { nowMs: NOW },
    );

    expect(update!.executedSize).toBe("0.6");
    expect(update!.lastCountedFillId).toBeNull();
    expect(update!.status).toBe("PARTIAL");
  });

  it("does not cursor past fills the monotonic guard refused to count", () => {
    // A cursorless migrated row recording 0.6 whose fill has aged out, with only
    // a later 0.4 visible. The guard keeps 0.6 because the suffix is smaller,
    // so that 0.4 was never incorporated. Advancing the cursor past it would
    // mark it counted and it could never be added: the row would sit at 0.6
    // forever instead of reaching 1.0, and a close sized from it leaves 0.4 of
    // the leveraged exposure open.
    const migrated = order({ executedSizeDecimal: "0.6", status: "PARTIAL" });
    const update = reconcilePerpOrder(
      migrated,
      [{ ...fill(), sz: "0.4", time: 2000, tid: 9 }],
      [open()],
      { nowMs: NOW },
    );

    expect(update!.executedSize).toBe("0.6");
    expect(update!.lastCountedFillId).toBeNull();
  });

  it("keeps recomputing from the window for rows with no cursor yet", () => {
    // Migration path, not an oversight: a row written before the column existed
    // has a recorded size that already includes the fills still in the window,
    // so adding the window to it would double count.
    const legacy = order({ executedSizeDecimal: "0.4", status: "PARTIAL" });
    const update = reconcilePerpOrder(legacy, [{ ...fill(), sz: "1", time: 2000, tid: 9 }], [], {
      nowMs: NOW,
    });

    expect(update!.executedSize).toBe("1");
    // And it now HAS a cursor, so the next cycle accumulates instead.
    expect(update!.lastCountedFillId).toBe("2000:9");
  });

  it("does not shrink the recorded size when only a LATER fill is still in the window", () => {
    // The harder half of the same problem: an earlier fill has aged out of the
    // recent-fill window while a later one has not, so summing what remains
    // yields a SUFFIX of the true cumulative size. isMeaningfulUpdate treats the
    // decrease as a change and the worker would write the smaller value.
    const partiallyFilled = order({ executedSizeDecimal: "1", status: "PARTIAL" });
    const laterFillOnly = { ...fill(), sz: "0.25" };
    const update = reconcilePerpOrder(partiallyFilled, [laterFillOnly], [], { nowMs: NOW });

    expect(update!.executedSize).toBe("1");
    // A vwap over a suffix is not the order's average price, and a realized-pnl
    // sum over one is an undercount, so neither is written from an incomplete
    // view.
    expect(update!.executedPrice).toBeNull();
    expect(update!.realizedPnl).toBeNull();
  });

  it("still accepts a GROWING cumulative size from the window", () => {
    const partiallyFilled = order({ executedSizeDecimal: "0.25", status: "PARTIAL" });
    const update = reconcilePerpOrder(partiallyFilled, [fill()], [], { nowMs: NOW });
    expect(parseFloat(update!.executedSize)).toBeGreaterThan(0.25);
    expect(update!.executedPrice).not.toBeNull();
  });

  it("preserves a recorded fill through the empty-snapshot cancellation too", () => {
    const partiallyFilled = order({ executedSizeDecimal: "0.4", status: "PARTIAL" });
    const update = reconcilePerpOrder(partiallyFilled, [], [], { nowMs: NOW });
    expect(update!.status).toBe("CANCELLED");
    expect(update!.executedSize).toBe("0.4");
  });

  it("does NOT cancel on an empty account snapshot when the order is young (transient HL response)", () => {
    // Young order + no fills + no open orders → probably a transient HL hiccup,
    // not a confirmed-absent order. Return null and wait for the next cycle.
    const justPlaced = order({ createdAtMs: NOW - 5_000 });
    const update = reconcilePerpOrder(justPlaced, [], [], { nowMs: NOW });
    expect(update).toBeNull();
  });

  it("does NOT cancel on an empty account snapshot when nowMs is absent", () => {
    // Without nowMs we cannot verify order age; never trust an empty snapshot.
    const update = reconcilePerpOrder(order(), [], []);
    expect(update).toBeNull();
  });

  it("marks CANCELLED on an empty account snapshot once the order is old enough", () => {
    // Transport-timeout orders (never placed) produce an account with zero fills
    // and zero open orders. Once the order passes minCancelAgeMs, trust the empty
    // snapshot: the request was never accepted and the row would stay PENDING forever.
    const update = reconcilePerpOrder(order(), [], [], { nowMs: NOW });
    expect(update!.status).toBe("CANCELLED");
    expect(update!.executedSize).toBe("0");
    expect(update!.executedPrice).toBeNull();
  });

  it("does NOT cancel a just-placed order not yet visible (age guard)", () => {
    // Order younger than the 45s guard, even with a non-empty snapshot.
    const justPlaced = order({ createdAtMs: NOW - 5_000 });
    const update = reconcilePerpOrder(justPlaced, [], [UNRELATED_OPEN], { nowMs: NOW });
    expect(update).toBeNull();
  });

  it("returns null (no change) when unfilled and still resting", () => {
    const update = reconcilePerpOrder(order(), [], [open({ sz: "1.5" })]);
    expect(update).toBeNull();
  });

  it("ignores fills belonging to a different order (cloid mismatch)", () => {
    const otherCloid = toCloid("some-other-order");
    // Unrelated fill makes the snapshot non-empty; order is old enough → cancel.
    const update = reconcilePerpOrder(order(), [fill({ cloid: otherCloid })], [], { nowMs: NOW });
    expect(update!.status).toBe("CANCELLED");
    expect(update!.executedSize).toBe("0");
  });

  it("matches by recorded brokerOrderId (oid) when the row has no cloid", () => {
    const noCloid = order({ clientOrderId: null, brokerOrderId: "777" });
    const update = reconcilePerpOrder(noCloid, [fill({ cloid: undefined, oid: 777 })], []);
    expect(update!.status).toBe("FILLED");
    expect(update!.executedSize).toBe("1.5");
  });
});

describe("isMeaningfulUpdate", () => {
  it("is true when status changes", () => {
    const o = order({ status: "SUBMITTED", quantityDecimal: "0" });
    const update = reconcilePerpOrder(o, [fill()], []);
    expect(isMeaningfulUpdate(o, update!)).toBe(true);
  });

  it("is false when status, executed size AND the cursor are unchanged", () => {
    // Already PARTIAL with 1.0 EXECUTED recorded, the fills still total 1.0
    // while resting, and the cursor already covers them → nothing to write.
    const o = order({
      status: "PARTIAL",
      executedSizeDecimal: "1",
      lastCountedFillId: `${1_700_000_000_000}:0`,
    });
    const update = reconcilePerpOrder(o, [fill({ sz: "1" })], [open({ sz: "0.5" })]);
    expect(update!.status).toBe("PARTIAL");
    expect(isMeaningfulUpdate(o, update!)).toBe(false);
  });

  it("is TRUE when only the cursor moved", () => {
    // This case used to be suppressed, which is what left a migrated row without
    // a cursor forever: no status change, no size change, so nothing was
    // written, so it never stopped recomputing from the window.
    const o = order({ status: "PARTIAL", executedSizeDecimal: "1" });
    const update = reconcilePerpOrder(o, [fill({ sz: "1" })], [open({ sz: "0.5" })]);
    expect(update!.executedSize).toBe("1");
    expect(isMeaningfulUpdate(o, update!)).toBe(true);
  });
});
