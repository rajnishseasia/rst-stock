/**
 * The selection payloads a feed "Copy" produces, plus the pure builders that
 * shape them. Extracted from signal-feed.tsx (audit H7) so the equity-vs-perp
 * routing can be asserted against the real module instead of a source-string
 * test.
 *
 * The split matters for money: several tickers exist on both venues (SOL is
 * Solana on Hyperliquid and ReneSola on Nasdaq), so a leveraged perp call must
 * never shape an equity ticket, and an equity payload must never carry
 * leverage.
 */

import type { PerpCopyPayload } from "./signal-perp";
import type { SignalThesis } from "./signal-thesis";

export interface SelectedSignal {
  symbol: string;
  signalId: string;
  content: string;
  /** Canonical x-signal feed id, present only when the action was Copy. */
  copySourceItemId?: string;
  /**
   * Plan S1. Who made the call, when, and which way if they said. Optional
   * because selections also originate outside the feed (a chat draft, a
   * copy-trade row), where there is no caller to attribute anything to.
   *
   * `copySourceItemId` is the opaque provenance value for the Copy action. The
   * ticket still uses `signalId` / `venue` for the existing signal credit path.
   */
  thesis?: SignalThesis | null;
  /**
   * Which venue the signal was copied from. A PERP copy also populates this
   * state (it drives the feed's selection ring), so consumers that link a
   * signal to an EQUITY order must check this rather than comparing symbols:
   * several tickers exist on both venues (SOL is Solana on Hyperliquid and
   * ReneSola on Nasdaq, APT is Aptos and Alpha Pro Tech), so a symbol match
   * alone would attach a perp signal's id to an unrelated equity order.
   * Absent means the legacy equity path.
   */
  venue?: "stocks" | "perps";
}

/**
 * The payload a PERP "Copy" produces: the perp-form prefill ({coin, side,
 * leverage}) plus the source signal id / content so the caller can highlight the
 * copied row. Distinct from `SelectedSignal` (which keys the EQUITY ticket): a
 * leveraged perp short must never prefill the equity trade form.
 */
export interface PerpCopySelection extends PerpCopyPayload {
  signalId: string;
  content: string;
  /** Canonical x-signal feed id for the perp copy. */
  copySourceItemId: string;
}

/** Source row a copy action was taken from. */
export interface SignalCopySource {
  symbol: string;
  signalId: string;
  content: string;
  /** Plan S1. The caller context for this row, when it came from the feed. */
  thesis?: SignalThesis | null;
}

/**
 * Equity chip copy. Leaves `venue` absent, which is the legacy equity path the
 * order router already understands.
 */
export function stockSignalSelection(source: SignalCopySource): SelectedSignal {
  return {
    symbol: source.symbol,
    signalId: source.signalId,
    content: source.content,
    copySourceItemId: `x_signal:${source.signalId}`,
    thesis: source.thesis ?? null,
  };
}

/**
 * "Trade stock" on a PERP row: the same coin also has a tradable equity listing.
 * Stamped `venue: "stocks"` so an equity order can be linked to it safely even
 * though the row itself is a perp call.
 */
export function stockFromPerpSelection(
  source: SignalCopySource,
): SelectedSignal {
  return {
    symbol: source.symbol,
    signalId: source.signalId,
    content: source.content,
    thesis: source.thesis ?? null,
    venue: "stocks",
  };
}

/**
 * Perp chip copy: the perp prefill plus the source row. Never returns a shape
 * the equity ticket accepts.
 */
export function perpSignalSelection(
  perp: PerpCopyPayload,
  source: Omit<SignalCopySource, "symbol">,
): PerpCopySelection {
  return {
    ...perp,
    signalId: source.signalId,
    content: source.content,
    copySourceItemId: `x_signal:${source.signalId}`,
  };
}

/**
 * What a tap on a ticker's IDENTITY half produces: chart this market, and keep
 * the signal that sent the user there attached.
 *
 * The venue is always explicit. Charting is the primary route to the ticket on
 * mobile, so dropping the signal here would silently strip provenance from every
 * order placed after a chart tap (no "mark signal TRADED", no social or
 * leaderboard credit), and dropping the VENUE would let a perp call's id attach
 * to an equity order on a colliding ticker.
 */
export interface SignalChartSelection extends SelectedSignal {
  venue: "stocks" | "perps";
}

/** Chart an EQUITY ticker from the feed, keeping the signal link. */
export function stockChartSelection(
  source: SignalCopySource,
): SignalChartSelection {
  return {
    symbol: source.symbol,
    signalId: source.signalId,
    content: source.content,
    thesis: source.thesis ?? null,
    venue: "stocks",
  };
}

/**
 * Chart a PERP coin from the feed, keeping the signal link. Deliberately drops
 * `side` and `leverage`: looking at a chart is not an order intent, so a 20x
 * short call must not seed a leveraged ticket until the user taps Copy.
 */
export function perpChartSelection(
  perp: PerpCopyPayload,
  source: Omit<SignalCopySource, "symbol">,
): SignalChartSelection {
  return {
    symbol: perp.coin,
    signalId: source.signalId,
    content: source.content,
    thesis: source.thesis ?? null,
    venue: "perps",
  };
}

/** Resolve a ticker click against the venue selected in the terminal header. */
export function signalTickerChartSelection({
  activeVenue,
  source,
  perp,
}: {
  activeVenue: "stocks" | "perps";
  source: SignalCopySource;
  perp?: PerpCopyPayload | null;
}): SignalChartSelection {
  if (activeVenue === "perps" && perp) {
    return perpChartSelection(perp, {
      signalId: source.signalId,
      content: source.content,
      thesis: source.thesis,
    });
  }

  return stockChartSelection(source);
}
