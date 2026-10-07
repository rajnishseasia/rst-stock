/**
 * Plan S1. The caller's THESIS: who said it, when, which way (if they said), and
 * the body of the call, carried from the feed card onto the chart screen and
 * into the pinned CTA.
 *
 * This is the part Bullpen structurally cannot build. Their pinned CTA can only
 * ever read "Long" or "Short" because a wallet never states a reason. Ours can
 * say whose call sent you here and what they actually wrote.
 *
 * PURE. No React, no IO, no formatting of money. Nothing in this file
 * constructs, validates or submits an order.
 *
 * ------------------------------------------------------------------
 * THE DIRECTION TRAP, which is why `signalDirectionFromMetadata` exists
 * ------------------------------------------------------------------
 * `classifySignalInstrument` resolves `side: short ? "sell" : "buy"`
 * (packages/utils/src/utils/signal-instrument.ts:170), and `perpCopyPayload`
 * mirrors that with `side: c.short ? "short" : "long"`. Both are correct for
 * their jobs, which are ORDER INTENT: a copy with no stated direction opens a
 * long, the legacy behavior every X / Discord signal relies on.
 *
 * They are wrong for DISPLAY. Most X-relayed signals carry no direction field at
 * all, so reading `side` here would print a confident "Alice's long call" under
 * a chart, one tap from an order ticket, on a post where nobody said long. That
 * is a fabricated claim attributed to a named person.
 *
 * So this module gates on PRESENCE: `classification.direction` is null when the
 * metadata carried no parseable direction, and a null direction renders nothing
 * rather than a default. Never swap this for `side`, `short`, or `perp.side`.
 */

import { classifySignalInstrument } from "@trade-bot/utils/utils/signal-instrument";

/** A direction the caller actually stated. There is no "unknown" member on
 *  purpose: absence is represented by `null`, so it cannot be rendered. */
export type SignalDirection = "long" | "short";

/**
 * The direction the caller STATED, or null when they stated none.
 *
 * Gated on `classification.direction !== null`, not on `classification.short`:
 * `short` is false both for an explicit long and for a signal with no direction
 * metadata whatsoever, and those two must not render the same.
 */
export function signalDirectionFromMetadata(
  metadata: unknown,
): SignalDirection | null {
  const classification = classifySignalInstrument(metadata);
  if (classification.direction === null) return null;
  return classification.short ? "short" : "long";
}

/** Title-case label for a stated direction. Only ever called with a non-null
 *  direction, so there is no "Unknown" case to leak into the UI. */
export function signalDirectionLabel(direction: SignalDirection): string {
  return direction === "short" ? "Short" : "Long";
}

/**
 * The caller context attached to a feed selection. Deliberately does NOT carry
 * the signal body: `SelectedSignal.content` already holds it, and duplicating it
 * gives two copies that can disagree after a re-normalization.
 */
export interface SignalThesis {
  authorName: string;
  authorAvatar: string | null;
  timestamp: string | number | Date;
  /** Link to the upstream post, when the row carried one. */
  url: string | null;
  imageUrl: string | null;
  /** Stated direction, or null when the caller did not state one. */
  direction: SignalDirection | null;
}

/** Milliseconds in the units the age formatter steps through. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact age for a call: "just now", "14m ago", "3h ago", "6d ago", then an
 * absolute "Mar 4" past a week.
 *
 * Deliberately shorter than date-fns' `formatDistanceToNow`, which renders
 * "about 2 hours ago". This shares a single line with a ticker and a direction
 * badge inside a 375px button, and `SignalTimestamp` uses it too so the feed
 * header line stays compact.
 *
 * `now` is injected so this stays pure and testable. A future timestamp (clock
 * skew between the poller and the reader) clamps to "just now" rather than
 * rendering a negative age.
 */
export function formatSignalAge(
  timestamp: string | number | Date,
  now: number = Date.now(),
): string {
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return "";
  const elapsed = now - then;
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The attribution line under the chart header and inside the CTA:
 * "Alice's long call · 2h ago", or "Alice's call · 2h ago" when no direction was
 * stated. The possessive keeps the direction descriptive ("their long call")
 * rather than imperative ("Long"), which matters because this string sits on a
 * button that opens an order ticket.
 */
export function describeSignalAttribution(
  thesis: Pick<SignalThesis, "authorName" | "timestamp" | "direction">,
  now: number = Date.now(),
): string {
  const author = thesis.authorName.trim() || "Unknown";
  const call =
    thesis.direction === null
      ? "call"
      : `${signalDirectionLabel(thesis.direction).toLowerCase()} call`;
  const age = formatSignalAge(thesis.timestamp, now);
  const head = `${author}'s ${call}`;
  return age ? `${head} · ${age}` : head;
}

/** The two lines of the mobile chart screen's pinned CTA. */
export interface SignalChartCta {
  /** What the button does. Unchanged from before S1 when no signal is in hand. */
  primary: string;
  /** Why you are here, or null when the chart was not reached from a signal. */
  context: string | null;
}

/**
 * Label the pinned Trade button on the mobile chart screen.
 *
 * The context line is rendered as a SEPARATE line inside the button rather than
 * folded into `primary`, so the caller's full name stays in the DOM (and in the
 * accessible name) while CSS handles the overflow. Truncating in this function
 * would truncate the accessible name too.
 */
export function describeSignalChartCta({
  symbol,
  canTrade,
  venue = "stocks",
  thesis,
  now = Date.now(),
}: {
  /** Display spelling of the market. Perps must be passed through
   *  `perpDisplayCoin` by the caller; this module does not know the venue. */
  symbol: string;
  /**
   * The venue is set up for this user. `null` means not yet established.
   *
   * Perps used to be hardcoded true here, so a user who had never provisioned
   * Hyperliquid was offered "Trade BTC" and got the onboarding flow instead of
   * a ticket. Unknown deliberately keeps the trade label rather than prompting
   * setup: telling someone to enable a venue they may already have is the
   * worse of the two wrong answers, and the ticket handles it either way.
   */
  canTrade: boolean | null;
  /** Which venue the setup prompt should name when `canTrade` is false. */
  venue?: "stocks" | "perps";
  thesis: Pick<SignalThesis, "authorName" | "timestamp" | "direction"> | null;
  now?: number;
}): SignalChartCta {
  return {
    primary:
      canTrade === false
        ? venue === "perps"
          ? "Enable Perps to Trade"
          : "Connect Broker to Trade"
        : `Trade ${symbol}`,
    context: thesis ? describeSignalAttribution(thesis, now) : null,
  };
}

/** The subset of a selection this module needs to decide market membership. */
export interface ThesisSelection {
  symbol?: string | null;
  venue?: "stocks" | "perps";
  thesis?: SignalThesis | null;
}

/**
 * The thesis to show on a chart, or null when the current selection does not
 * belong to the market on screen.
 *
 * Same discipline as `equityOrderSignalId` (signal-perp.ts), and for the same
 * reason: tickers collide across venues (SOL is Solana on Hyperliquid and
 * ReneSola on Nasdaq, APT is Aptos and Alpha Pro Tech), so a symbol match alone
 * would attribute a perp caller's thesis to an unrelated equity chart. The venue
 * check is the load-bearing half.
 *
 * A selection with no venue is the legacy equity path and matches a stock chart,
 * matching `equityOrderSignalId`'s treatment of the same shape.
 */
export function signalThesisForMarket(
  selected: ThesisSelection | null | undefined,
  marketSymbol: string | null | undefined,
  isPerps: boolean,
): SignalThesis | null {
  const thesis = selected?.thesis;
  if (!thesis) return null;
  const selectedVenue = selected?.venue ?? "stocks";
  if (selectedVenue !== (isPerps ? "perps" : "stocks")) return null;
  const selectedSymbol = selected?.symbol?.trim().toUpperCase();
  const chartSymbol = marketSymbol?.trim().toUpperCase();
  if (!selectedSymbol || !chartSymbol) return null;
  if (selectedSymbol !== chartSymbol) return null;
  return thesis;
}
