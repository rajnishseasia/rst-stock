/**
 * Rules of the mobile trade sheet, kept out of page.tsx so they can be tested
 * directly instead of by reading the page as a string (audit H7).
 *
 * Container and presentation only. Nothing here touches order construction,
 * validation or submission: it names the sheet and decides who owns the
 * document scroll while the sheet is up.
 */
import type { ResponsiveShellMode } from "@/components/layout/responsive-shell";

/**
 * Accessible name for the sheet.
 *
 * Venue-aware on purpose. `perpDisplayCoin` collapses Hyperliquid's namespaced
 * stock-backed perps ("xyz:GOOGL") to a bare "GOOGL", which is exactly the
 * ticker an Alpaca equity ticket would carry, so the label has to say which one
 * the user is about to trade. The canonical coin is still what the form submits.
 */
export function tradeSheetLabel({
  symbol,
  isPerps,
}: {
  symbol: string;
  isPerps: boolean;
}): string {
  const market = symbol.trim();
  if (!market) return isPerps ? "Trade perpetual" : "Trade ticket";
  return isPerps ? `Trade ${market} perpetual` : `Trade ${market}`;
}

/**
 * Whether the sheet owns the document scroll.
 *
 * One owner, not two. The sheet is only in the tree on the mobile shell
 * (`TradingResponsiveShell` mounts one shell at a time), so the document lock is
 * scoped the same way. `mobileTradeSheetOpen` can survive a resize past xl, and
 * locking the page there would freeze the desktop terminal behind a sheet that
 * is not rendered.
 */
export function shouldLockDocumentScroll({
  sheetOpen,
  shellMode,
}: {
  sheetOpen: boolean;
  shellMode: ResponsiveShellMode;
}): boolean {
  return sheetOpen && shellMode === "mobile";
}

/** The only surface `lockDocumentScroll` touches, so it can be unit-tested. */
export type ScrollLockDocument = {
  body: { style: { overflow: string } };
  documentElement: { style: { overscrollBehavior: string } };
};

/**
 * Freeze the page behind the sheet and restore exactly what was there before.
 * Returns the restore function so a `useEffect` can hand it straight back.
 * Restoring twice is a no-op: a second call must not re-apply a value that a
 * later lock has already replaced.
 */
export function lockDocumentScroll(doc: ScrollLockDocument): () => void {
  const previousBodyOverflow = doc.body.style.overflow;
  const previousRootOverscroll = doc.documentElement.style.overscrollBehavior;
  doc.body.style.overflow = "hidden";
  doc.documentElement.style.overscrollBehavior = "none";

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    doc.body.style.overflow = previousBodyOverflow;
    doc.documentElement.style.overscrollBehavior = previousRootOverscroll;
  };
}

/**
 * The whole body of page.tsx's scroll-lock effect, in one testable call.
 *
 * The effect is a guard plus a lock plus a cleanup, and the interesting behavior
 * is how the three compose across a re-render: opening the sheet on a phone
 * locks; the same open flag on the desktop terminal must not; and a resize past
 * xl while the sheet is open has to give the scroll back, because the sheet
 * stops being rendered while `mobileTradeSheetOpen` stays true. Returning
 * `undefined` (React's "no cleanup") from the guarded branch is what makes that
 * work, so it is asserted rather than assumed.
 */
export function tradeSheetScrollLockEffect({
  sheetOpen,
  shellMode,
  doc,
}: {
  sheetOpen: boolean;
  shellMode: ResponsiveShellMode;
  doc: ScrollLockDocument;
}): (() => void) | undefined {
  if (!shouldLockDocumentScroll({ sheetOpen, shellMode })) return undefined;
  return lockDocumentScroll(doc);
}
