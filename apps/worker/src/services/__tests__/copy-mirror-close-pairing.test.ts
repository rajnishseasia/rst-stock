/**
 * Unit tests for close preservation.
 *
 * The failure being prevented: a reduce-only CLOSE runs while the OPEN it
 * belongs to is still queued (typically because the open threw earlier in the
 * same batch and was requeued). The close finds no position, skips, and the
 * delivery is marked completed forever, so when the open's retry succeeds the
 * follower is left holding leveraged exposure whose only exit instruction has
 * already been spent.
 *
 * Every ambiguous input here must resolve to "defer", which places no order.
 */

import { describe, expect, it } from "bun:test";
import {
  closeFoundNoExposure,
  decidePerpCloseConsumption,
  isClosingCandidate,
  isUnresolvedSiblingOpen,
  readPairedDelivery,
  type PairedPerpDelivery,
  type QueuedDeliveryRow,
} from "../copy-mirror-close-pairing";

const OPEN_AT = "2026-08-09T12:00:00.000Z";
const CLOSE_AT = "2026-08-09T12:00:20.000Z";

const close: PairedPerpDelivery = {
  sourceItemId: "user:close-1",
  followerUserId: "follower-1",
  symbol: "BTC",
  assetType: "PERP",
  sourceEventAt: CLOSE_AT,
  perpReduceOnly: true,
};

function queuedOpen(overrides: Record<string, unknown> = {}): QueuedDeliveryRow {
  const candidate = {
    sourceItemId: "user:open-1",
    followerUserId: "follower-1",
    symbol: "BTC",
    assetType: "PERP",
    sourceEventAt: OPEN_AT,
    perpReduceOnly: false,
    ...overrides,
  };
  return {
    sourceItemId: candidate.sourceItemId as string,
    followerUserId: (overrides.rowFollowerUserId as string) ?? "follower-1",
    candidate,
  };
}

describe("closeFoundNoExposure", () => {
  it("covers every reduce-only skip that means the exposure is not there", () => {
    expect(closeFoundNoExposure("no-position")).toBe(true);
    expect(closeFoundNoExposure("wrong-side")).toBe(true);
    expect(closeFoundNoExposure("no-qty")).toBe(true);
  });

  it("does not claim unrelated skips are about a missing open", () => {
    expect(closeFoundNoExposure("dex-abstraction-required")).toBe(false);
    expect(closeFoundNoExposure("placed")).toBe(false);
    expect(closeFoundNoExposure("")).toBe(false);
  });
});

describe("readPairedDelivery", () => {
  it("reads the pairing fields off a frozen candidate payload", () => {
    expect(
      readPairedDelivery({
        sourceItemId: "user:open-1",
        followerUserId: "follower-1",
        symbol: " BTC ",
        assetType: "PERP",
        sourceEventAt: OPEN_AT,
        perpReduceOnly: false,
      }),
    ).toEqual({
      sourceItemId: "user:open-1",
      followerUserId: "follower-1",
      symbol: "BTC",
      assetType: "PERP",
      sourceEventAt: OPEN_AT,
      perpReduceOnly: false,
    });
  });

  it("returns null for a payload that is not an object at all", () => {
    expect(readPairedDelivery(null)).toBeNull();
    expect(readPairedDelivery("user:open-1")).toBeNull();
    expect(readPairedDelivery(undefined)).toBeNull();
  });

  it("never invents fields it cannot read", () => {
    const parsed = readPairedDelivery({ symbol: 7 });
    expect(parsed).toEqual({
      sourceItemId: "",
      followerUserId: "",
      symbol: "",
      perpReduceOnly: false,
    });
  });
});

describe("isUnresolvedSiblingOpen", () => {
  it("counts a queued open for the same follower and coin", () => {
    expect(isUnresolvedSiblingOpen(close, queuedOpen())).toBe(true);
  });

  it("ignores the close's own row", () => {
    expect(
      isUnresolvedSiblingOpen(close, queuedOpen({ sourceItemId: "user:close-1" })),
    ).toBe(false);
  });

  it("ignores another follower's queued open", () => {
    expect(
      isUnresolvedSiblingOpen(
        close,
        queuedOpen({ followerUserId: "follower-2", rowFollowerUserId: "follower-2" }),
      ),
    ).toBe(false);
  });

  it("ignores a queued open in a different coin", () => {
    expect(isUnresolvedSiblingOpen(close, queuedOpen({ symbol: "ETH" }))).toBe(false);
  });

  it("ignores another close, which cannot create exposure", () => {
    expect(isUnresolvedSiblingOpen(close, queuedOpen({ perpReduceOnly: true }))).toBe(false);
  });

  it("ignores a non-perp mirror that happens to share the ticker", () => {
    expect(isUnresolvedSiblingOpen(close, queuedOpen({ assetType: "EQUITY" }))).toBe(false);
  });

  it("ignores a re-entry the source made after this close", () => {
    expect(
      isUnresolvedSiblingOpen(
        close,
        queuedOpen({
          sourceItemId: "user:open-later",
          sourceEventAt: "2026-08-09T12:05:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("holds the close back when the queued open's own timestamp is unreadable", () => {
    expect(isUnresolvedSiblingOpen(close, queuedOpen({ sourceEventAt: undefined }))).toBe(
      true,
    );
  });

  it("holds the close back when the close's own timestamp is unreadable", () => {
    const undated: PairedPerpDelivery = { ...close, sourceEventAt: undefined };
    expect(
      isUnresolvedSiblingOpen(
        undated,
        queuedOpen({ sourceEventAt: "2026-08-09T12:05:00.000Z" }),
      ),
    ).toBe(true);
  });

  it("holds the close back when the queued payload cannot be read at all", () => {
    expect(
      isUnresolvedSiblingOpen(close, {
        sourceItemId: "user:unreadable",
        followerUserId: "follower-1",
        candidate: "not-json-we-understand",
      }),
    ).toBe(true);
  });

  it("holds the close back when the queued open names no coin", () => {
    expect(isUnresolvedSiblingOpen(close, queuedOpen({ symbol: undefined }))).toBe(true);
  });
});

describe("decidePerpCloseConsumption", () => {
  it("defers a no-position close whose open is still queued", () => {
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [queuedOpen()],
      }),
    ).toEqual({
      action: "defer",
      reason: "sibling-open-unresolved",
      blockedBy: ["user:open-1"],
    });
  });

  it("defers a wrong-side and a no-qty close on the same evidence", () => {
    for (const reason of ["wrong-side", "no-qty"]) {
      expect(
        decidePerpCloseConsumption({
          close,
          closeSkipReason: reason,
          pendingDeliveries: [queuedOpen()],
        }).action,
      ).toBe("defer");
    }
  });

  it("completes when nothing queued can still open this exposure", () => {
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [
          queuedOpen({ symbol: "ETH" }),
          queuedOpen({ perpReduceOnly: true, sourceItemId: "user:close-2" }),
        ],
      }),
    ).toEqual({ action: "complete" });
  });

  it("completes when the queue is empty, which is the ordinary case", () => {
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [],
      }),
    ).toEqual({ action: "complete" });
  });

  it("does not hold back a skip that has nothing to do with a missing open", () => {
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "dex-abstraction-required",
        pendingDeliveries: [queuedOpen()],
      }),
    ).toEqual({ action: "complete" });
  });

  it("reports every queued open that is holding the close back", () => {
    const decision = decidePerpCloseConsumption({
      close,
      closeSkipReason: "no-position",
      pendingDeliveries: [
        queuedOpen(),
        queuedOpen({ sourceItemId: "user:open-2" }),
        queuedOpen({ symbol: "SOL", sourceItemId: "user:open-3" }),
      ],
    });
    expect(decision).toEqual({
      action: "defer",
      reason: "sibling-open-unresolved",
      blockedBy: ["user:open-1", "user:open-2"],
    });
  });
});

describe("a close is not consumed on evidence the scan could not gather", () => {
  const close = {
    sourceItemId: "x_signal:close-1",
    followerUserId: "follower-1",
    symbol: "BTC",
    assetType: "PERP" as const,
    perpReduceOnly: true,
  };

  it("defers when the pending scan hit its cap and found nothing", () => {
    // The scan is a PREFIX of the queue at the cap, so "no sibling in the rows
    // I read" is not "no sibling". Failing open here would silently switch the
    // whole guard off for exactly the follower whose queue is worst backed up.
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [],
        pendingScanTruncated: true,
      }),
    ).toEqual({
      action: "defer",
      reason: "sibling-scan-truncated",
      blockedBy: [],
    });
  });

  it("still completes on a truncated scan when the close DID find exposure", () => {
    // Truncation only matters for the consume-for-nothing case. A close that
    // reduced a real position has already done its job.
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "placed",
        pendingDeliveries: [],
        pendingScanTruncated: true,
      }),
    ).toEqual({ action: "complete" });
  });

  it("defers when the paired open ended ambiguously, even with an empty queue", () => {
    // A "syncing" open reached the venue but was never confirmed, and its
    // delivery row is COMPLETED so the pending scan cannot see it. The
    // position may exist while listPositions still reports nothing.
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [],
        openOutcomeAmbiguous: true,
      }),
    ).toEqual({
      action: "defer",
      reason: "sibling-open-unresolved",
      blockedBy: [],
    });
  });

  it("completes only when the scan was complete AND no open is ambiguous", () => {
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [],
        pendingScanTruncated: false,
        openOutcomeAmbiguous: false,
      }),
    ).toEqual({ action: "complete" });
  });

  it("keeps the old behavior when the new flags are absent", () => {
    // Both flags are optional so existing callers and tests are unaffected.
    expect(
      decidePerpCloseConsumption({
        close,
        closeSkipReason: "no-position",
        pendingDeliveries: [],
      }),
    ).toEqual({ action: "complete" });
  });
});

describe("the same rules answer for an Alpaca equity close", () => {
  // The Alpaca path has no reduce-only flag, so a `sell` is the exit there.
  const equityClose: PairedPerpDelivery = {
    sourceItemId: "user:close-2",
    followerUserId: "follower-1",
    symbol: "MSFT",
    assetType: "EQUITY",
    sourceEventAt: CLOSE_AT,
    side: "sell",
  };

  function queuedEquity(overrides: Record<string, unknown> = {}): QueuedDeliveryRow {
    const candidate = {
      sourceItemId: "user:open-2",
      followerUserId: "follower-1",
      symbol: "MSFT",
      assetType: "EQUITY",
      sourceEventAt: OPEN_AT,
      side: "buy",
      ...overrides,
    };
    return {
      sourceItemId: candidate.sourceItemId as string,
      followerUserId: "follower-1",
      candidate,
    };
  }

  it("counts the queued BUY that would create the exposure", () => {
    expect(isUnresolvedSiblingOpen(equityClose, queuedEquity())).toBe(true);
  });

  it("ignores another queued SELL, which can open nothing", () => {
    // Without this, two exits in one batch would hold each other until both
    // were abandoned, which is worse than the failure being prevented.
    expect(isUnresolvedSiblingOpen(equityClose, queuedEquity({ side: "sell" }))).toBe(
      false,
    );
  });

  it("ignores a perp open that happens to share the ticker", () => {
    expect(
      isUnresolvedSiblingOpen(equityClose, queuedEquity({ assetType: "PERP" })),
    ).toBe(false);
  });

  it("holds the close back when the queued row's asset type is unreadable", () => {
    // A `sell` with no asset type could be a perp SHORT ENTRY, which really
    // could create exposure. Unknown resolves to "sibling", which places no
    // order.
    expect(
      isUnresolvedSiblingOpen(equityClose, queuedEquity({ assetType: undefined, side: "sell" })),
    ).toBe(true);
  });

  it("defers the equity skips that mean the exposure is not there", () => {
    for (const reason of ["no-long-position", "no-mirrored-exposure", "no-qty"]) {
      expect(
        decidePerpCloseConsumption({
          close: equityClose,
          closeSkipReason: reason,
          pendingDeliveries: [queuedEquity()],
        }).action,
      ).toBe("defer");
    }
  });

  it("consumes an equity close with nothing queued behind it", () => {
    expect(
      decidePerpCloseConsumption({
        close: equityClose,
        closeSkipReason: "no-long-position",
        pendingDeliveries: [queuedEquity({ symbol: "AAPL" })],
      }),
    ).toEqual({ action: "complete" });
  });
});

/**
 * The same "is this a close" question the delivery queue asks before it lets a
 * row outlive the attempt ceiling. Keyed on `perpReduceOnly` alone it answered
 * "no" for every Alpaca exit, which retired mirrored equity closes as permanent
 * failures after eight transient broker errors.
 */
describe("isClosingCandidate", () => {
  it("reads a reduce-only perp close as a close", () => {
    expect(
      isClosingCandidate({ assetType: "PERP", side: "sell", perpReduceOnly: true }),
    ).toBe(true);
  });

  it("reads an equity SELL and an option SellToClose as closes", () => {
    expect(isClosingCandidate({ assetType: "EQUITY", side: "sell" })).toBe(true);
    expect(isClosingCandidate({ assetType: "OPTION", side: "sell" })).toBe(true);
  });

  it("does not read a perp SHORT ENTRY as a close", () => {
    // Staged as `side: "sell"` with `perpReduceOnly: false`. Calling this an
    // exit would exempt an ENTRY from the ceiling and keep it armed forever.
    expect(
      isClosingCandidate({ assetType: "PERP", side: "sell", perpReduceOnly: false }),
    ).toBe(false);
  });

  it("does not exempt sell-side short or option-open intents", () => {
    expect(isClosingCandidate({
      assetType: "EQUITY",
      side: "sell",
      tradeAction: "SellShort",
      direction: "short",
    })).toBe(false);
    expect(isClosingCandidate({
      assetType: "OPTION",
      side: "sell",
      tradeAction: "SellToOpen",
      direction: "short",
    })).toBe(false);
    expect(isClosingCandidate({
      assetType: "OPTION",
      side: "sell",
      tradeAction: "SellToClose",
      direction: "long",
    })).toBe(true);
  });

  it("does not read an equity BUY, an unknown asset type, or an unreadable payload as a close", () => {
    expect(isClosingCandidate({ assetType: "EQUITY", side: "buy" })).toBe(false);
    expect(isClosingCandidate({ side: "sell" })).toBe(false);
    expect(isClosingCandidate(null)).toBe(false);
    expect(isClosingCandidate("sell")).toBe(false);
  });
});
