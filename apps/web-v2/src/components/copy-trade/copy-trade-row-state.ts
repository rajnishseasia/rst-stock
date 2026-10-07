/**
 * Pure per-row Copy state for the copy-trade feed: field parsing, the
 * enabled/disabled qty math, the disabled-tooltip text, the button label, and
 * the dispatch decision an onClick makes with all of that (no React, no IO).
 *
 * WHY THIS EXISTS: before this extraction, every one of these decisions lived
 * only inside copy-trade-panel.tsx's per-row render and its inline onClick
 * closure, and the test file pinned them by matching literal strings
 * ("onCopy(", "Math.floor", "isOption && !sizingPrice") against the
 * component's raw source text. That kind of check cannot tell WHERE in the
 * component a matched string lives, or whether it still runs for the row it
 * is supposed to protect. When perp-copy routing was added, two of those
 * literals kept matching - "onCopy(" and "Math.floor" both still exist,
 * verbatim, inside the equity branch - even though a PERP row no longer
 * reaches that branch at all. The strings were never wrong; the test asking
 * "does this text exist anywhere in the file" was never actually asking
 * whether a PERP row's Copy click can produce an equity order.
 *
 * `resolveCopyDispatch` is the function that answers that question for real:
 * given a row's perp-route decision, it returns which of onCopy/onCopyPerp
 * would fire and with what payload - so a test can assert directly that a
 * perp row (any perp row, refused or routable) NEVER produces a
 * `{ kind: "equity", ... }` result, independent of qty, sizing mode, option
 * completeness, or any of the other equity-only gates below.
 */

import { perpBadgeLabel } from "@/components/feed/signal-perp";
import { classifyCopyTradeInstrument } from "./copy-trade-instrument";
import type { CopyTradeQuoteReadiness } from "./copy-trade-quote-state";
import type { PerpTradeRowRoute } from "./copy-perp-route";
import type { SizingMode } from "./mirror-sizing";
import type {
  CopyOptionType,
  CopyPerpTradePayload,
  CopyTradeAction,
  CopyTradePayload,
} from "./copy-trade-panel";

/** Read a trimmed non-empty string meta field, or undefined. */
export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read a finite, positive number (or numeric string), or undefined. */
export function readNumber(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function readOptionType(value: unknown): CopyOptionType | undefined {
  return value === "CALL" || value === "PUT" ? value : undefined;
}

export function readTradeAction(value: unknown): CopyTradeAction | undefined {
  return value === "BuyToOpen" || value === "SellToClose" ? value : undefined;
}

/** Stable key for an option contract, shared by the feed rows and the batched option-quotes query. */
export function optionContractKey(
  symbol: string,
  expiration: string,
  strike: number,
  optionType: CopyOptionType,
): string {
  return `${symbol.toUpperCase()}|${expiration}|${strike}|${optionType}`;
}

/**
 * The panel-level dollar size target: pct needs buying power, pct_equity
 * needs equity, usd is independent, and ratio has no dollar target at all
 * (qty is sized per-item from the source trader's own qty instead).
 */
export function computeTargetDollars(args: {
  sizingMode: SizingMode;
  sizingValue: number;
  buyingPower: number;
  equity: number;
}): number {
  const { sizingMode, sizingValue, buyingPower, equity } = args;
  if (sizingMode === "pct") return (Math.min(sizingValue, 100) / 100) * buyingPower;
  if (sizingMode === "pct_equity") return (Math.min(sizingValue, 100) / 100) * equity;
  if (sizingMode === "usd") return sizingValue;
  return 0; // ratio: no dollar target - qty is sized per-item.
}

/** Everything the Copy button needs to render and to decide qty/disabled/title for one feed row. */
export interface CopyRowState {
  isOption: boolean;
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: CopyOptionType;
  tradeAction?: CopyTradeAction;
  unsupportedOptionSignal: boolean;
  hasCompleteOptionContract: boolean;
  hasSupportedOptionAction: boolean;
  /** Reference price used to size the copy: bid/ask for options, last for equities. */
  optionReferencePrice?: number;
  qty: number;
  ratioNeedsSourceQty: boolean;
  copyDisabled: boolean;
  copyTitle?: string;
  buttonLabel: string;
}

export function computeCopyRowState(args: {
  meta: Record<string, unknown> | null | undefined;
  side: "buy" | "sell";
  /** The feed item's own source qty (social trades carry it; x_signal rows don't). */
  rawQty: unknown;
  /** copyDisabledReason(meta, side) - decided by copy-eligibility.ts, passed in unchanged. */
  copyEligibilityReason: string | null;
  /** perpCopyFromTradeRow(meta, { perpsEnabled }) - decided by copy-perp-route.ts, passed in unchanged. */
  perpRoute: PerpTradeRowRoute;
  /** Whether the caller wired an onCopyPerp handler at all. */
  hasPerpHandler: boolean;
  /** Query-level and row-level quote freshness/error decision. */
  quoteReadiness?: Pick<CopyTradeQuoteReadiness, "copyBlocked" | "copyBlockedReason">;
  /** The live quote's last price (quote?.last), unparsed. */
  quoteLast: unknown;
  /** The batched option quote's bid, unparsed. */
  optionBid: unknown;
  /** The batched option quote's ask, unparsed. */
  optionAsk: unknown;
  sizingMode: SizingMode;
  sizingValue: number;
  /** Dollar size target for pct/pct_equity/usd modes (0 for ratio - qty is per-item there). */
  targetDollars: number;
  pctNeedsBrokerage: boolean;
  pctEquityNeedsBrokerage: boolean;
}): CopyRowState {
  const {
    meta,
    side,
    rawQty,
    copyEligibilityReason,
    perpRoute,
    hasPerpHandler,
    quoteReadiness = { copyBlocked: false, copyBlockedReason: null },
    quoteLast,
    optionBid,
    optionAsk,
    sizingMode,
    sizingValue,
    targetDollars,
    pctNeedsBrokerage,
    pctEquityNeedsBrokerage,
  } = args;

  const instrument = classifyCopyTradeInstrument(meta);
  const isOption = instrument === "option";
  const optionExpiration = readString(meta?.optionExpiration);
  const optionStrike = readNumber(meta?.optionStrike);
  const optionType = readOptionType(meta?.optionType);
  const tradeAction = readTradeAction(meta?.tradeAction);
  const unsupportedOptionSignal = meta?.instrumentParseStatus === "unsupported";

  const hasCompleteOptionContract = Boolean(
    !isOption || (optionExpiration && optionStrike && optionType),
  );
  const hasSupportedOptionAction = !isOption || Boolean(tradeAction);
  const optionContractMultiplier = isOption ? 100 : 1;

  const optionReferencePrice = side === "sell" ? readNumber(optionBid) : readNumber(optionAsk);
  const lastPrice = Number(quoteLast);
  const sizingPrice = isOption ? optionReferencePrice : lastPrice;

  const sourceQty = readNumber(rawQty);
  const ratioNeedsSourceQty = sizingMode === "ratio" && !sourceQty;
  const qty =
    sizingMode === "ratio"
      ? sourceQty
        ? Math.max(0, Math.floor(Math.min(sizingValue, 10) * sourceQty))
        : 0
      : sizingPrice && sizingPrice > 0
        ? Math.max(0, Math.floor(targetDollars / (sizingPrice * optionContractMultiplier)))
        : 0;

  const copyDisabled = perpRoute
    ? perpRoute.kind !== "perp" || !hasPerpHandler || quoteReadiness.copyBlocked
    : copyEligibilityReason !== null ||
      quoteReadiness.copyBlocked ||
      unsupportedOptionSignal ||
      (isOption && (!hasCompleteOptionContract || !hasSupportedOptionAction)) ||
      (isOption && !optionReferencePrice) ||
      qty <= 0 ||
      pctNeedsBrokerage ||
      pctEquityNeedsBrokerage ||
      ratioNeedsSourceQty;

  const copyTitle = perpRoute
    ? perpRoute.kind === "refused"
      ? perpRoute.reason
      : quoteReadiness.copyBlockedReason ?? undefined
    : copyEligibilityReason
      ? copyEligibilityReason
      : quoteReadiness.copyBlockedReason
        ? quoteReadiness.copyBlockedReason
        : unsupportedOptionSignal
          ? "Option signal is incomplete or unsupported"
          : isOption && !hasCompleteOptionContract
            ? "Option contract details are missing"
            : isOption && !hasSupportedOptionAction
              ? "Option action is unsupported"
              : isOption && !optionReferencePrice
                ? "Option premium unavailable"
                : undefined;

  const buttonLabel =
    perpRoute?.kind === "perp"
      ? `Prefill ${perpBadgeLabel(perpRoute.side, perpRoute.leverage)}`
      : perpRoute?.kind === "refused"
        ? meta?.perpReduceOnly === true
          ? "Close shown"
          : "Unavailable"
        : copyDisabled
          ? side === "sell"
            ? "Sell shown"
            : "Copy"
          : isOption
            ? `Copy ${qty} ct`
            : `Copy ${qty} sh`;

  return {
    isOption,
    optionExpiration,
    optionStrike,
    optionType,
    tradeAction,
    unsupportedOptionSignal,
    hasCompleteOptionContract,
    hasSupportedOptionAction,
    optionReferencePrice,
    qty,
    ratioNeedsSourceQty,
    copyDisabled,
    copyTitle,
    buttonLabel,
  };
}

/** What the Copy button's onClick actually does: fire onCopy, fire onCopyPerp, or nothing. */
export type CopyDispatch =
  | { kind: "noop" }
  | { kind: "equity"; payload: CopyTradePayload }
  | { kind: "perp"; payload: CopyPerpTradePayload };

/**
 * Reclassify the row at dispatch: a partial/refused perp or an unknown
 * instrument cannot produce an equity payload, even with inconsistent inputs.
 * The panel revalidates the current quote and quantity before calling this.
 */
export function resolveCopyDispatch(args: {
  perpRoute: PerpTradeRowRoute;
  item: {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    source: string;
    meta: Record<string, unknown> | null | undefined;
  };
  isOption: boolean;
  optionExpiration?: string;
  optionStrike?: number;
  optionType?: CopyOptionType;
  tradeAction?: CopyTradeAction;
  qty: number;
}): CopyDispatch {
  const { perpRoute, item, optionExpiration, optionStrike, optionType, tradeAction, qty } = args;

  const instrument = classifyCopyTradeInstrument(item.meta);
  if (instrument === "perp") {
    if (!perpRoute || perpRoute.kind !== "perp") return { kind: "noop" };
    return {
      kind: "perp",
      payload: {
        itemId: item.id,
        coin: perpRoute.coin,
        side: perpRoute.side,
        ...(perpRoute.leverage !== undefined ? { leverage: perpRoute.leverage } : {}),
      },
    };
  }

  if (instrument === "unknown" || perpRoute) return { kind: "noop" };

  const resolvedIsOption = instrument === "option";

  return {
    kind: "equity",
    payload: {
      symbol: item.symbol,
      side: item.side,
      qty,
      copySourceItemId: item.id,
      assetType: resolvedIsOption ? "OPTION" : "EQUITY",
      optionExpiration: resolvedIsOption ? optionExpiration : undefined,
      optionStrike: resolvedIsOption ? optionStrike : undefined,
      optionType: resolvedIsOption ? optionType : undefined,
      tradeAction: resolvedIsOption ? tradeAction : undefined,
      signalId: item.source === "x_signal" ? String(item.meta?.signalId) : undefined,
    },
  };
}
