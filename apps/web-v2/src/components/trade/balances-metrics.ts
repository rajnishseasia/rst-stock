/**
 * The Balances tab's metric grid, as pure data.
 *
 * The terminal already fetched every one of these numbers and then showed the
 * user two of them (portfolio value and buying power, in the app header). Cash,
 * long/short exposure and the margin requirements were fetched on every
 * `positions.account` poll and thrown away; free perp collateral was computed
 * for copy-mirror sizing and never surfaced at all. This module turns those
 * responses into labeled cells so the drawer can render them without owning any
 * of the arithmetic (audit H7: pure math first, component second).
 *
 * Every money value goes through `formatUsd` (audit M16). A value that is
 * missing renders as "-", never as $0.00: "we did not get a number" and "you
 * have no money" are different statements, and a zeroed margin or collateral
 * cell is the more dangerous of the two to fake.
 */

import { formatUsd } from "@/lib/format";

export interface BalanceMetric {
  label: string;
  value: string;
  /** Plain-language explanation, rendered as the cell's tooltip. */
  hint: string;
}

/** The `positions.account` fields this grid reads. */
export interface StockAccountSnapshot {
  equity?: number | null;
  cash?: number | null;
  nonMarginableBuyingPower?: number | null;
  buyingPower?: number | null;
  longMarketValue?: number | null;
  shortMarketValue?: number | null;
  initialMargin?: number | null;
  maintenanceMargin?: number | null;
}

/** The `hyperliquid.status` fields this grid reads. */
export interface PerpStatusSnapshot {
  hlEquityUsd?: string | number | null;
  hlBalanceUsd?: string | number | null;
  network?: string | null;
}

/** The `hyperliquid.collateral` fields this grid reads. */
export interface PerpCollateralSnapshot {
  freeUsd?: string | number | null;
  accountValueUsd?: string | number | null;
}

function finite(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

export function stockBalanceMetrics(
  account: StockAccountSnapshot | null | undefined,
): BalanceMetric[] {
  return [
    {
      label: "Equity",
      value: formatUsd(account?.equity),
      hint: "Total account value: cash plus the market value of everything you hold.",
    },
    {
      label: "Cash",
      value: formatUsd(account?.cash),
      hint: "Settled cash in the account.",
    },
    {
      label: "Buying power",
      // The non-marginable figure is the guaranteed floor, and it is what
      // Alpaca actually checks for non-marginable securities. The headline
      // `buyingPower` is margin-inflated, so leading with it is how a user ends
      // up rejected for insufficient buying power while the screen shows
      // plenty. It is still shown, one cell over and labeled as margin.
      value: formatUsd(account?.nonMarginableBuyingPower),
      hint: "Cash Alpaca will use for any security, including non-marginable ones. The safe figure to size against.",
    },
    {
      label: "Margin BP",
      value: formatUsd(account?.buyingPower),
      hint: "Margin-inflated buying power. Only available on marginable securities, so it can exceed what an order is actually allowed to use.",
    },
    {
      label: "Long value",
      value: formatUsd(account?.longMarketValue),
      hint: "Market value of your long positions.",
    },
    {
      label: "Short value",
      value: formatUsd(account?.shortMarketValue),
      hint: "Market value of your short positions.",
    },
    {
      label: "Initial margin",
      value: formatUsd(account?.initialMargin),
      hint: "Margin required to have opened the positions you currently hold.",
    },
    {
      label: "Maint. margin",
      value: formatUsd(account?.maintenanceMargin),
      hint: "Margin you must keep. Falling below it is what triggers a margin call.",
    },
  ];
}

/** Capitalized network name ("Mainnet"), or "-" when it is not known yet. */
export function perpNetworkLabel(network: string | null | undefined): string {
  if (!network) return "-";
  return network.replace(/^./, (char) => char.toUpperCase());
}

export function perpBalanceMetrics({
  status,
  collateral,
}: {
  status: PerpStatusSnapshot | null | undefined;
  collateral: PerpCollateralSnapshot | null | undefined;
}): BalanceMetric[] {
  const freeUsd = finite(collateral?.freeUsd);
  const collateralTotal = finite(collateral?.accountValueUsd);
  // `accountValueUsd` and `freeUsd` come out of ONE snapshot of ONE ledger
  // (see HyperliquidClient.perpCollateral), where free = total - hold and
  // `hold` is the margin committed across every dex. So total - free is that
  // committed margin exactly, not the cross-ledger subtraction the client's
  // own doc warns against. Unknown unless both halves are known.
  const usedUsd =
    freeUsd != null && collateralTotal != null ? collateralTotal - freeUsd : null;

  return [
    {
      label: "Account value",
      value: formatUsd(status?.hlEquityUsd),
      hint: "Total value of the Hyperliquid account, including spot holdings and unrealized PnL.",
    },
    {
      label: "Collateral",
      value: formatUsd(status?.hlBalanceUsd),
      hint: "Capital in the perp ledger. Not the same as the account's total value.",
    },
    {
      label: "Free margin",
      value: formatUsd(freeUsd),
      hint: "Collateral that can still back a new order, after margin already committed.",
    },
    {
      label: "Used margin",
      value: formatUsd(usedUsd),
      hint: "Collateral currently committed as margin across your open perp positions.",
    },
    {
      label: "Network",
      value: perpNetworkLabel(status?.network),
      hint: "The Hyperliquid network this account trades on.",
    },
  ];
}
