import { describe, expect, test } from "bun:test";
import {
  lockDocumentScroll,
  shouldLockDocumentScroll,
  tradeSheetLabel,
  tradeSheetScrollLockEffect,
  type ScrollLockDocument,
} from "./trade-sheet";

function stubDocument(
  overflow = "",
  overscrollBehavior = "",
): ScrollLockDocument {
  return {
    body: { style: { overflow } },
    documentElement: { style: { overscrollBehavior } },
  };
}

describe("tradeSheetLabel", () => {
  test("names the venue so a perp is never mistaken for the equity", () => {
    // perpDisplayCoin turns "xyz:GOOGL" into "GOOGL", which is also a tradable
    // Alpaca ticker. The label is the only thing left that tells them apart.
    expect(tradeSheetLabel({ symbol: "GOOGL", isPerps: true })).toBe(
      "Trade GOOGL perpetual",
    );
    expect(tradeSheetLabel({ symbol: "GOOGL", isPerps: false })).toBe(
      "Trade GOOGL",
    );
  });

  test("stays a usable name when no market is resolved yet", () => {
    expect(tradeSheetLabel({ symbol: "", isPerps: false })).toBe("Trade ticket");
    expect(tradeSheetLabel({ symbol: "   ", isPerps: true })).toBe(
      "Trade perpetual",
    );
  });
});

describe("shouldLockDocumentScroll", () => {
  test("locks only while the sheet is actually mounted", () => {
    expect(
      shouldLockDocumentScroll({ sheetOpen: true, shellMode: "mobile" }),
    ).toBe(true);
    expect(
      shouldLockDocumentScroll({ sheetOpen: false, shellMode: "mobile" }),
    ).toBe(false);
  });

  test("never locks the desktop terminal, which has no sheet", () => {
    // The open flag can survive a resize past xl. Locking there would freeze a
    // terminal the user can see behind a sheet they cannot.
    expect(
      shouldLockDocumentScroll({ sheetOpen: true, shellMode: "desktop" }),
    ).toBe(false);
    expect(
      shouldLockDocumentScroll({ sheetOpen: true, shellMode: null }),
    ).toBe(false);
  });
});

describe("lockDocumentScroll", () => {
  test("hands scroll to the sheet and gives it back untouched", () => {
    const doc = stubDocument("auto", "auto");

    const restore = lockDocumentScroll(doc);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.documentElement.style.overscrollBehavior).toBe("none");

    restore();
    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.documentElement.style.overscrollBehavior).toBe("auto");
  });

  test("restoring twice does not clobber a later lock", () => {
    const doc = stubDocument();

    const restoreFirst = lockDocumentScroll(doc);
    restoreFirst();
    const restoreSecond = lockDocumentScroll(doc);
    restoreFirst();

    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.documentElement.style.overscrollBehavior).toBe("none");

    restoreSecond();
    expect(doc.body.style.overflow).toBe("");
    expect(doc.documentElement.style.overscrollBehavior).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The effect page.tsx actually runs, driven the way React drives it: call, then
// call the returned cleanup before the next call. This is the coverage that was
// dropped when the source-string assertions on `document.body.style.overflow`
// were deleted (audit H7), and it is a stronger check than those were: it
// exercises the guard, the lock and the restore together.
// ---------------------------------------------------------------------------
describe("tradeSheetScrollLockEffect", () => {
  test("opening the ticket on a phone hands scroll to the sheet", () => {
    const doc = stubDocument("auto", "auto");

    const cleanup = tradeSheetScrollLockEffect({
      sheetOpen: true,
      shellMode: "mobile",
      doc,
    });

    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.documentElement.style.overscrollBehavior).toBe("none");

    cleanup?.();
    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.documentElement.style.overscrollBehavior).toBe("auto");
  });

  test("a closed sheet touches nothing and asks for no cleanup", () => {
    const doc = stubDocument("auto", "auto");

    // `undefined` is React's "no cleanup". Returning a no-op function instead
    // would still be correct, but returning the LOCK would not: this branch
    // must never write to the document at all.
    expect(
      tradeSheetScrollLockEffect({ sheetOpen: false, shellMode: "mobile", doc }),
    ).toBeUndefined();
    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.documentElement.style.overscrollBehavior).toBe("auto");
  });

  test("the desktop terminal is never frozen by a sheet it does not render", () => {
    const doc = stubDocument("auto", "auto");

    expect(
      tradeSheetScrollLockEffect({ sheetOpen: true, shellMode: "desktop", doc }),
    ).toBeUndefined();
    expect(doc.body.style.overflow).toBe("auto");
  });

  test("resizing past xl with the sheet open gives the scroll back", () => {
    // `mobileTradeSheetOpen` survives the resize, but the sheet stops being
    // rendered. Without the cleanup the user would be looking at a scrollable
    // terminal that refuses to scroll, with nothing on screen to dismiss.
    const doc = stubDocument("auto", "auto");

    const cleanup = tradeSheetScrollLockEffect({
      sheetOpen: true,
      shellMode: "mobile",
      doc,
    });
    expect(doc.body.style.overflow).toBe("hidden");

    // React runs the previous cleanup before the next effect body.
    cleanup?.();
    const next = tradeSheetScrollLockEffect({
      sheetOpen: true,
      shellMode: "desktop",
      doc,
    });

    expect(next).toBeUndefined();
    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.documentElement.style.overscrollBehavior).toBe("auto");
  });

  test("an unknown shell mode does not lock before hydration", () => {
    const doc = stubDocument("auto", "auto");

    expect(
      tradeSheetScrollLockEffect({ sheetOpen: true, shellMode: null, doc }),
    ).toBeUndefined();
    expect(doc.body.style.overflow).toBe("auto");
  });

  test("close then reopen restores the ORIGINAL page scroll, not 'hidden'", () => {
    // The regression this guards: if a lock captured the previous value while
    // another lock was still applied, the restore would write "hidden" back and
    // the page would stay frozen after the sheet was dismissed.
    const doc = stubDocument("auto", "auto");

    tradeSheetScrollLockEffect({ sheetOpen: true, shellMode: "mobile", doc })?.();
    const second = tradeSheetScrollLockEffect({
      sheetOpen: true,
      shellMode: "mobile",
      doc,
    });
    second?.();

    expect(doc.body.style.overflow).toBe("auto");
    expect(doc.documentElement.style.overscrollBehavior).toBe("auto");
  });
});
