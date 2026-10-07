/**
 * Rules of the mobile (sub-xl) portfolio surface, kept out of page.tsx so they
 * can be tested directly instead of by reading the page as a string (audit H7).
 *
 * We trade two venues: Alpaca (stocks and options) and Hyperliquid (perps). On
 * the desktop terminal the venue is a workspace MODE, so each rail can filter
 * itself to the active one. A phone has no second rail and no bottom drawer, so
 * a filtered portfolio would make the other venue's money invisible. Here the
 * portfolio SPANS both venues: one total, then a row per venue that drills into
 * that venue's own surface.
 *
 * Display only. Nothing in this module reaches an order payload, and stock rows
 * are never merged with perp rows: leverage, funding and liquidation are
 * perps-only and must not leak into an equity surface.
 */

import { formatCompactUsd, formatUsd } from "@/lib/format";

/** The venues a mobile portfolio row can describe. */
export type MobilePortfolioVenue = "stocks" | "perps";

/** Which mobile portfolio surface is showing: the overview, or one venue. */
export type MobilePortfolioView = "overview" | MobilePortfolioVenue;

/** Display labels for each venue, shared by the rows and the section headers. */
export const MOBILE_PORTFOLIO_VENUE_LABELS: Record<MobilePortfolioVenue, string> = {
  stocks: "Stocks & options",
  perps: "Perps",
};

export interface MobilePortfolioRow {
  venue: MobilePortfolioVenue;
  label: string;
  /** Venue value in USD, or null when the venue has not reported one yet. */
  value: number | null;
  /** Alpaca buying power. Perps buying capacity belongs on the trade ticket. */
  buyingPower: number | null;
}

export interface MobilePortfolioSummary {
  /** One row per CONNECTED venue, stocks first. Empty when nothing is wired. */
  rows: MobilePortfolioRow[];
  /** Sum over the connected venues that reported a value; null when none did. */
  total: number | null;
  /**
   * False when a connected venue has not reported a value yet, so `total` is a
   * partial sum. The UI has to say so rather than present a short total as the
   * user's net worth.
   */
  totalComplete: boolean;
  /**
   * At least one venue's connection state has not been established.
   *
   * The rows alone cannot express this: an unknown venue is deliberately given
   * no row, so "no rows" covers both "you trade nowhere" and "we have not heard
   * back about either venue". Read as the first, the overview told a user with
   * an existing broker account to go connect one.
   */
  hasUnresolvedVenue: boolean;
  /**
   * A venue's connection check has FAILED, as opposed to still running.
   *
   * Both land on `hasUnresolvedVenue`, and describing both as "checking" left
   * every surface that reads it claiming a request was in progress long after
   * it had given up. A request that is over does not get to describe itself as
   * still working.
   */
  venueCheckFailed: boolean;
}

/**
 * Parse a USD amount that may arrive as a string. `hyperliquid.status` types
 * `hlEquityUsd` as `string | null`, so summing it against Alpaca's numeric
 * `portfolioValue` needs an explicit parse; a bare `+` would concatenate.
 * Blank, null and non-numeric input all mean "not reported", never zero.
 */
export function parseUsdAmount(
  value: number | string | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether the perps half of the mobile account surfaces (the Positions/Orders
 * stack, the portfolio's Perps row) is shown at all.
 *
 * Both conditions are load-bearing. `wired` is the deployment switch
 * (PERPS_ENABLED); with it off the mobile venue bar hides itself, so a perps
 * section would be unreachable dead weight. `provisioned` is the per-user half;
 * without it the section would be a permanent "set up perpetual futures" strip
 * taking half a phone screen from someone who only trades equities.
 */
export function showMobilePerpsSection(input: {
  wired: boolean;
  provisioned: boolean;
}): boolean {
  return input.wired && input.provisioned;
}

export interface MobilePortfolioInput {
  /**
   * Either venue's connection read has failed outright. Only meaningful while
   * that venue is unresolved; a venue that answered is not "failed".
   */
  venueCheckFailed?: boolean;
  /**
   * An Alpaca credential is selected for the active PAPER/LIVE mode, or `null`
   * while the credentials read has not answered. See `perpsConnected`.
   */
  stocksConnected: boolean | null;
  /** Alpaca `portfolioValue`. */
  stocksValue: number | string | null | undefined;
  /** Alpaca non-marginable buying power, matching the desktop header. */
  stocksBuyingPower?: number | string | null;
  /**
   * Perps are wired for this deployment AND provisioned for this user, or
   * `null` while the status read has not answered.
   *
   * `null` is a third state, distinct from the two a boolean covers. Both venue
   * flags are derived from queries that yield "not connected" while loading and
   * after a failure, which is indistinguishable from a confirmed single-venue
   * account. Read as the latter, the other venue's row was dropped AND the
   * remaining sum was marked COMPLETE, so the nav and the portfolio screen
   * presented an understated number as final rather than as still loading.
   */
  perpsConnected: boolean | null;
  /**
   * Hyperliquid `hlEquityUsd` (a string on the wire): the account's TOTAL
   * value, not `hlBalanceUsd`. Collateral omits spot holdings, which on a real
   * unified account was the difference between $3.9k and $35.1k.
   */
  perpsValue: number | string | null | undefined;
}

/**
 * Build the venue breakdown. A venue that is not connected gets no row at all,
 * which is different from a connected venue that has not reported a value: the
 * first is "you do not trade there", the second is "we do not know yet".
 */
export function buildMobilePortfolio(
  input: MobilePortfolioInput,
): MobilePortfolioSummary {
  const rows: MobilePortfolioRow[] = [];
  // Strict `=== true`: an UNKNOWN venue gets no row, because we have no
  // evidence the user trades there and inventing the line would be its own
  // false claim. It blocks completeness instead, below.
  if (input.stocksConnected === true) {
    rows.push({
      venue: "stocks",
      label: MOBILE_PORTFOLIO_VENUE_LABELS.stocks,
      value: parseUsdAmount(input.stocksValue),
      buyingPower: parseUsdAmount(input.stocksBuyingPower),
    });
  }
  if (input.perpsConnected === true) {
    rows.push({
      venue: "perps",
      label: MOBILE_PORTFOLIO_VENUE_LABELS.perps,
      value: parseUsdAmount(input.perpsValue),
      buyingPower: null,
    });
  }

  const reported = rows.filter((row) => row.value != null);
  // An unresolved venue cannot produce a COMPLETE total: the sum may be missing
  // a whole venue we have not heard about yet.
  const bothVenuesSettled =
    input.stocksConnected !== null && input.perpsConnected !== null;
  return {
    hasUnresolvedVenue: !bothVenuesSettled,
    // Only reportable while something is actually unresolved.
    venueCheckFailed: !bothVenuesSettled && (input.venueCheckFailed ?? false),
    rows,
    total:
      reported.length === 0
        ? null
        : reported.reduce((sum, row) => sum + (row.value ?? 0), 0),
    totalComplete: bothVenuesSettled && reported.length === rows.length,
  };
}

/** The live balance the mobile nav shows in place of a static label (plan A9). */
export interface MobileBalanceLabel {
  /** Compact text for the ~68px nav cell, e.g. "$12.4K". */
  short: string;
  /** Exact amount, for the accessible name and the wider hamburger menu. */
  long: string;
  /** A connected venue has not reported yet, so the total is a partial sum. */
  partial: boolean;
}

/**
 * Turn the venue breakdown into the balance shown ON the mobile nav.
 *
 * Why the nav and not a header strip: below xl the terminal header's metric
 * cluster is unstyled and crowded against the hamburger, and it is the only
 * money on the screen. Moving the number to the nav makes funding state ambient
 * on every screen instead of a strip nobody reads.
 *
 * Returns null when there is nothing honest to show (no venue connected, or no
 * venue has reported), so the caller keeps its static label rather than
 * rendering "-" where a balance should be.
 *
 * A partial total is marked with a leading "~" rather than silently shown as a
 * complete one: "your money" is exactly the number that must not overstate
 * itself. Amounts go through the shared formatters (audit M16).
 */
export function describeMobileBalanceLabel(
  summary: MobilePortfolioSummary,
): MobileBalanceLabel | null {
  if (summary.total == null) return null;
  const compact = formatCompactUsd(summary.total);
  const exact = formatUsd(summary.total);
  return {
    short: summary.totalComplete ? compact : `~${compact}`,
    long: summary.totalComplete
      ? `portfolio ${exact}`
      : summary.venueCheckFailed
        ? `portfolio ${exact} so far, a venue could not be checked`
        : summary.hasUnresolvedVenue
        // Do not say "a connected venue": whether it is connected is the very
        // thing we have not established.
        ? `portfolio ${exact} so far, still checking your venues`
        : `portfolio ${exact} so far, a connected venue has not reported yet`,
    partial: !summary.totalComplete,
  };
}

/** The three honest states the mobile header and Account hero can show. */
export type MobileAccountValueState = "available" | "loading" | "unavailable";

/**
 * WHY an account value is unavailable, so a surface can offer the next step
 * instead of a dead "unavailable" string. Null while the value is loading or
 * available.
 *
 *  - `not-connected`: no venue is connected and that is settled, so the honest
 *    next step is to connect one.
 *  - `venue-check-failed`: a connection check failed outright. Not a connect
 *    prompt: the user may well have a broker we could not reach.
 *  - `unknown`: nothing more specific can be said.
 */
export type MobileAccountValueReason =
  | "not-connected"
  | "venue-check-failed"
  | "unknown";

/**
 * Choose the mobile header's account-value state from the complete portfolio
 * summary, failing closed when a venue read failed or remains incomplete.
 */
export function resolveMobileAccountValueState(
  summary: MobilePortfolioSummary,
): MobileAccountValueState {
  if (summary.venueCheckFailed) return "unavailable";
  if (!summary.totalComplete) return "loading";
  return summary.total != null ? "available" : "unavailable";
}

export function resolveMobileAccountValueReason(
  summary: MobilePortfolioSummary,
): MobileAccountValueReason | null {
  if (resolveMobileAccountValueState(summary) !== "unavailable") return null;
  if (summary.venueCheckFailed) return "venue-check-failed";
  // No row means no CONNECTED venue; nothing unresolved means that is settled
  // rather than still being checked, so "connect one" is a fair prompt.
  if (summary.rows.length === 0 && !summary.hasUnresolvedVenue) {
    return "not-connected";
  }
  return "unknown";
}

/**
 * Keep the header chip and the Account hero on the same controller-owned
 * value, completeness and reason contract. The value may contain an honest
 * "so-far" explanation while loading or unavailable; the state travels with it
 * so presentational surfaces never display that partial number as a current
 * total, and the reason lets the header offer Connect only when connecting is
 * the actual next step.
 */
export function resolveMobileAccountValueProps(summary: MobilePortfolioSummary): {
  accountValue: string | undefined;
  accountValueState: MobileAccountValueState;
  accountValueReason: MobileAccountValueReason | null;
} {
  const balance = describeMobileBalanceLabel(summary);
  return {
    accountValue: balance?.long,
    accountValueState: resolveMobileAccountValueState(summary),
    accountValueReason: resolveMobileAccountValueReason(summary),
  };
}

export interface MobilePortfolioNavigation {
  /** The view actually rendered, after collapsing stale or impossible requests. */
  view: MobilePortfolioView;
  /**
   * Whether a drill-down has an overview to go back to. False when a single
   * venue is connected, because then the venue surface IS the portfolio and a
   * back button would lead to a total that restates the one row below it.
   */
  canReturnToOverview: boolean;
}

/**
 * Resolve the requested view against what is actually connected.
 *
 * - No venue connected: the overview, which carries the connect prompt.
 * - Exactly one venue: that venue's surface directly. An overview would be a
 *   total plus a single row plus an extra tap, all restating one number.
 * - Two venues: the overview by default, and a drill-down only for a venue that
 *   is still connected, so a disconnected broker cannot strand the user on an
 *   empty screen whose only control is Back.
 */
export function resolveMobilePortfolioNavigation(
  requested: MobilePortfolioView,
  summary: MobilePortfolioSummary,
): MobilePortfolioNavigation {
  // "One venue" has to mean one venue EXISTS, not one has answered so far. An
  // unknown venue gets no row, so while a status read was in flight this
  // collapsed to the venue that had replied and pinned the user there with
  // `canReturnToOverview: false`, then moved the ground under them when the
  // other venue arrived. Stay on the overview until the question is settled.
  if (summary.rows.length === 1 && !summary.hasUnresolvedVenue) {
    return { view: summary.rows[0]!.venue, canReturnToOverview: false };
  }
  if (
    requested === "overview" ||
    !summary.rows.some((row) => row.venue === requested)
  ) {
    return { view: "overview", canReturnToOverview: false };
  }
  return { view: requested, canReturnToOverview: true };
}

/**
 * Whether the perps-status question is SETTLED.
 *
 * Named and tested because the distinction is easy to get wrong, and was:
 * `isFetched` is not settlement. TanStack Query sets it after recording an
 * ERROR too, so a failed `hyperliquid.status` looked answered while its data
 * stayed absent and `enabled` defaulted to false, and a provisioned user's
 * stock-only sum was marked a complete portfolio total.
 *
 * Note this is the OPPOSITE choice from the layout hydration read, which
 * deliberately proceeds on `isFetched`: there, a failed read must still release
 * hydration or a user whose account is unreachable never gets a workspace.
 * Proceeding on failure is right when the fallback is harmless and wrong when
 * the output is a number presented as final.
 */
export function perpsStatusSettled(input: {
  /** Perps are wired for this deployment at all. */
  wired: boolean;
  isSignedIn: boolean;
  /** The status query resolved SUCCESSFULLY. Not `isFetched`. */
  statusSucceeded: boolean;
}): boolean {
  // Nothing to wait for: there is no perps venue in this build, or nobody to
  // have an account.
  if (!input.wired || !input.isSignedIn) return true;
  return input.statusSucceeded;
}

/**
 * A venue's connection state as the portfolio and the browse notices want it:
 * `null` until the read that answers the question has SUCCEEDED.
 *
 * Both venues need this and only perps had it, which is exactly how the stocks
 * half kept the bug after the perps half was fixed: a user with a connected
 * Alpaca account was told to add one, and a perps-only subtotal could be marked
 * a complete portfolio total while the credentials read was still in flight.
 */
export function venueConnectionState(input: {
  /** The read that answers this question has succeeded. Not `isFetched`. */
  settled: boolean;
  connected: boolean;
}): boolean | null {
  return input.settled ? input.connected : null;
}
