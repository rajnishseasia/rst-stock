/**
 * Domain-level types for the Hyperliquid wrapper. These are the shapes our
 * routers / worker consume — deliberately narrower and more stable than the
 * raw `@nktkas/hyperliquid` SDK response types, which we normalize at the edge.
 */

/** Order direction. Maps to the HL `b` (isBuy) boolean. */
export type PerpSide = "long" | "short";

/** Margin mode. Maps to the HL `isCross` boolean on updateLeverage. */
export type MarginMode = "cross" | "isolated";

/**
 * Supported order types.
 *   Market            = IoC limit at an aggressive price (`t: { limit: { tif: "Ioc" } }`).
 *   Limit             = Gtc limit (or Alo when post-only) (`t: { limit: { tif } }`).
 *   StopMarket        = trigger `{ isMarket: true,  tpsl: "sl" }` (aggressive `p` from triggerPx).
 *   StopLimit         = trigger `{ isMarket: false, tpsl: "sl" }` (`p` = user limit price).
 *   TakeProfitMarket  = trigger `{ isMarket: true,  tpsl: "tp" }` (aggressive `p` from triggerPx).
 *   TakeProfitLimit   = trigger `{ isMarket: false, tpsl: "tp" }` (`p` = user limit price).
 */
export type PerpOrderType =
  | "Market"
  | "Limit"
  | "StopMarket"
  | "StopLimit"
  | "TakeProfitMarket"
  | "TakeProfitLimit";

/**
 * The HL `tpsl` discriminator on a trigger order: stop-loss vs take-profit.
 * Maps directly onto the SDK `t: { trigger: { tpsl } }` picklist.
 */
export type PerpTpsl = "tp" | "sl";

/**
 * True for the trigger order types (stop / take-profit); false for
 * Market/Limit. Used to branch the `t` field in `placeOrder`.
 */
export function isTriggerOrderType(orderType: PerpOrderType): boolean {
  return (
    orderType === "StopMarket" ||
    orderType === "StopLimit" ||
    orderType === "TakeProfitMarket" ||
    orderType === "TakeProfitLimit"
  );
}

/**
 * Derive the HL trigger discriminator (`tp` | `sl`) + `isMarket` for a trigger
 * order type. Returns `null` for non-trigger (Market/Limit) types.
 */
export function triggerSpecForOrderType(
  orderType: PerpOrderType,
): { tpsl: PerpTpsl; isMarket: boolean } | null {
  switch (orderType) {
    case "StopMarket":
      return { tpsl: "sl", isMarket: true };
    case "StopLimit":
      return { tpsl: "sl", isMarket: false };
    case "TakeProfitMarket":
      return { tpsl: "tp", isMarket: true };
    case "TakeProfitLimit":
      return { tpsl: "tp", isMarket: false };
    default:
      return null;
  }
}

/**
 * Time-in-force for limit orders.
 *   Gtc = rest on book
 *   Ioc = immediate-or-cancel (used to synthesize a market order)
 *   Alo = add-liquidity-only (post-only)
 */
export type PerpTimeInForce = "Gtc" | "Ioc" | "Alo";

/**
 * A single tradable perp from `meta().universe`. `szDecimals` drives lot/size
 * rounding; `maxLeverage` is the per-asset clamp for the leverage slider.
 */
export interface PerpAssetMeta {
  /** Coin symbol, e.g. "BTC". */
  coin: string;
  /** Cached asset index used as `a` on orders/cancels/leverage. */
  assetIndex: number;
  /** Size decimals — order size must be truncated to this many decimals. */
  szDecimals: number;
  /** Maximum leverage the venue allows for this asset. */
  maxLeverage: number;
  /** Owning perpetual DEX. Empty string is Hyperliquid's validator-operated DEX. */
  dex?: string;
  /** HIP-3 market constraint: cross margin is unavailable for this asset. */
  isolatedOnly?: boolean;
  /** Whether the asset has been delisted. */
  isDelisted?: boolean;
}

/** Request shape for placing a perp order via the wrapper. */
export interface PlacePerpOrderRequest {
  coin: string;
  side: PerpSide;
  /** Order size in coin units (fractional). Rounded to `szDecimals`. */
  size: string | number;
  orderType: PerpOrderType;
  /**
   * Required for Limit orders and the non-market trigger types (StopLimit /
   * TakeProfitLimit), where it becomes the trigger order's limit price `p`.
   * Ignored for Market.
   */
  limitPrice?: string | number;
  /**
   * Trigger price (`triggerPx`). REQUIRED for the trigger order types
   * (StopMarket / StopLimit / TakeProfitMarket / TakeProfitLimit). For the
   * `isMarket` trigger types it also seeds the aggressive limit price `p`
   * (buy: `triggerPx * (1 + slippage)`, sell: `triggerPx * (1 - slippage)`).
   * Ignored for Market / Limit.
   */
  triggerPx?: string | number;
  /** Post-only (Alo). Only valid on Limit orders. */
  postOnly?: boolean;
  /** Reduce-only — never flips or increases the position. */
  reduceOnly?: boolean;
  /**
   * Time-in-force override. Defaults: Market → Ioc, Limit → Gtc (or Alo when
   * `postOnly`).
   */
  timeInForce?: PerpTimeInForce;
  /**
   * Idempotency key. Reused from `orders.clientOrderId`. When supplied it is
   * converted deterministically into the HL 128-bit `cloid`. Omit to let the
   * wrapper generate one from a stable seed.
   */
  clientOrderId?: string;
  /**
   * For Market orders: current mark/mid price used to compute the aggressive
   * IoC limit price. Required when `orderType === "Market"` and no explicit
   * `limitPrice` is given.
   */
  markPrice?: string | number;
  /** Slippage tolerance for the synthesized market price (default 0.05 = 5%). */
  slippage?: number;
}

/** Request shape for cancelling a resting perp order. */
export interface CancelPerpOrderRequest {
  coin: string;
  /** HL numeric order id (oid). */
  orderId: number;
}

/**
 * Request shape for attaching a reduce-only stop-loss and/or take-profit to an
 * OPEN position. The trigger orders are placed on the OPPOSITE side of the
 * position (a long is protected by SELL triggers, a short by BUY triggers) and
 * are reduce-only (`r: true`) so they only ever close, never flip/increase.
 */
export interface SetPositionTpSlRequest {
  coin: string;
  /** Side of the OPEN position being protected. */
  positionSide: PerpSide;
  /**
   * Size to protect, in coin units. Full or partial. Rounded to `szDecimals`.
   */
  size: string | number;
  /** Stop-loss trigger price. Omit to skip the SL leg. */
  stopLossPx?: string | number;
  /** Take-profit trigger price. Omit to skip the TP leg. */
  takeProfitPx?: string | number;
  /**
   * When true, the trigger fires a market (aggressive-limit) exit; when false,
   * a resting limit at the trigger price. Defaults to true (market exit) so a
   * protective stop always crosses. Applies to both legs.
   */
  isMarket?: boolean;
  /** Slippage for the aggressive market-trigger price. */
  slippage?: number;
  /**
   * Idempotency seed. When set, each leg's cloid is derived from
   * `${clientOrderId}:sl` / `${clientOrderId}:tp` so a retried call dedupes
   * broker-side per leg.
   */
  clientOrderId?: string;
}

/** Request shape for atomically modifying one resting position TP/SL order. */
export interface ModifyPositionTpSlRequest {
  coin: string;
  /** HL numeric order id (oid). */
  orderId: number;
  /** Side of the OPEN position being protected. */
  positionSide: PerpSide;
  /** Remaining trigger size in coin units. */
  size: string | number;
  /** New trigger price. */
  triggerPx: string | number;
  kind: PerpTpsl;
  /** Preserve whether the existing trigger exits at market or limit. */
  isMarket: boolean;
  /** Slippage for an aggressive market-trigger price. */
  slippage?: number;
}

/** Request shape for a leverage/margin-mode update. */
export interface UpdateLeverageRequest {
  coin: string;
  leverage: number;
  marginMode: MarginMode;
}

/** Request shape for a reduce-only market close of the full position. */
export interface MarketCloseRequest {
  coin: string;
  /** Position signed size from clearinghouse state (`szi`). */
  positionSize: string | number;
  /** Current mark/mid price for the aggressive IoC close. */
  markPrice: string | number;
  slippage?: number;
  clientOrderId?: string;
}

/**
 * One-time master-signed setup: register the agent wallet on the master
 * account. Master-signed (User-Signed EIP-712 `ApproveAgent`). Consumed by the
 * `hyperliquid.enable` mutation (Stage 2).
 */
export interface ApproveAgentRequest {
  /** 0x-prefixed agent wallet address to authorize. */
  agentAddress: `0x${string}`;
  /**
   * Human-readable agent name (1..16 chars). Defaults to `"readysettrade"` when
   * omitted. An empty string registers an unnamed agent.
   */
  agentName?: string;
}

/**
 * One-time master-signed setup: approve a max builder fee rate. Only meaningful
 * when a builder is configured; the enable mutation skips this call entirely
 * when no builder is present. Master-signed (User-Signed EIP-712).
 */
export interface ApproveBuilderFeeRequest {
  /** 0x-prefixed builder address that collects the fee. */
  builder: `0x${string}`;
  /**
   * Max fee rate string in HL's percent format, e.g. `"0.1%"`. Approving a
   * higher max than currently charged avoids per-user re-onboarding on a fee bump.
   */
  maxFeeRate: `${string}%`;
}

/**
 * One approved agent wallet for a master account, as returned by HL
 * `extraAgents`. Consumed by `hyperliquid.markAgentRegistered` to verify the
 * stored agent was actually approved on-chain before flipping the account LIVE.
 */
export interface ExtraAgent {
  /** 0x-prefixed approved agent wallet address. */
  address: `0x${string}`;
  /** Agent name as registered via `approveAgent`. */
  name: string;
  /** Expiry as ms-since-epoch; `null` when the agent has no expiry. */
  validUntil: number | null;
}

/**
 * Fill side in buy/sell terms. The raw HL fill encodes this as `side: "B" | "A"`
 * ("B" = bid/buy, "A" = ask/sell); we normalize to the friendlier buy/sell.
 */
export type PerpFillSide = "buy" | "sell";

/**
 * Normalized perp fill (trade execution) row derived from HL `userFills` /
 * `userFillsByTime`. This is the shape the trade-history view consumes:
 * deliberately narrower than the raw SDK `UserFill`, exposing only the fields
 * the history table renders.
 */
export interface PerpFill {
  /** Timestamp the trade occurred (ms since epoch). */
  time: number;
  /** Asset symbol, e.g. "BTC". */
  coin: string;
  /** Buy/sell direction (raw HL "B"/"A" normalized). */
  side: PerpFillSide;
  /** Executed price (string, as HL reports it). */
  px: string;
  /** Executed size in coin units. */
  sz: string;
  /** Realized PnL for the portion this fill closed (signed). */
  closedPnl: string;
  /** Fee charged (negative indicates a rebate). */
  fee: string;
  /** HL direction label for display, e.g. "Open Long" / "Close Long". */
  dir: string;
  /** Order id (oid) this fill belongs to. */
  oid: number;
  /** L1 transaction hash. */
  hash: string;
  /** Unique per-partial-fill id. Useful as a stable render key. */
  tid: number;
  /** Client order ID supplied at placement, when this was an app order. */
  cloid: `0x${string}` | null;
}

/**
 * Normalized OPEN order row derived from HL `frontendOpenOrders`. This is the
 * shape `positions.listPerpOpenOrders` returns. `clearinghouseState` reports
 * POSITIONS only, never the resting trigger ORDERS a user attached (TP/SL), so
 * this is what lets the UI surface a position's stop-loss / take-profit legs and
 * offer a per-order cancel.
 */
export interface PerpOpenOrder {
  /** Coin symbol, e.g. "BTC". */
  coin: string;
  /** Order side, normalized from the HL `side` field ("B" bid → buy, "A" ask → sell). */
  side: "buy" | "sell";
  /** HL numeric order id (oid), the handle for cancellation. */
  oid: number;
  /** Client order id (cloid), when the order carried one; else null. */
  cloid: string | null;
  /** Remaining size in coin units. */
  sz: string;
  /** Original size at placement, before any partial fill. */
  origSz: string;
  /** Limit price (`0` for a pure market trigger). */
  limitPx: string;
  /** Whether this is a trigger order (stop / take-profit). */
  isTrigger: boolean;
  /** Trigger price; null for non-trigger (plain limit) orders. */
  triggerPx: string | null;
  /**
   * Trigger discriminator: "tp" for take-profit legs, "sl" for stop-loss legs,
   * null for non-trigger orders. Derived from the HL `orderType` string.
   */
  tpsl: PerpTpsl | null;
  /** Whether the order is reduce-only (a protective TP/SL always is). */
  reduceOnly: boolean;
  /** Whether HL flags this as a position-level TP/SL order. */
  isPositionTpsl: boolean;
  /** Human-readable HL order type, e.g. "Stop Market" / "Take Profit Limit". */
  orderType: string;
  /** Placement timestamp (ms since epoch). */
  timestamp: number;
}

/**
 * The cross-margin view of an account, as `clearinghouseState.crossMarginSummary`
 * reports it.
 *
 * CROSS specifically, not `marginSummary`: the latter's totals include isolated
 * positions, and isolated equity is locked to the asset it was allocated to, so
 * it cannot back a new order. Free collateral is `accountValueUsd` minus
 * `totalMarginUsedUsd`; both are passed through verbatim as Hyperliquid's own
 * decimal strings so the arithmetic (and its rounding) happens in one place at
 * the point of use rather than twice.
 */
export interface PerpCrossMargin {
  /** `crossMarginSummary.accountValue`. */
  accountValueUsd: string;
  /** `crossMarginSummary.totalMarginUsed`. */
  totalMarginUsedUsd: string;
}

/**
 * Normalized perp position row derived from `clearinghouseState`. This is the
 * shape `positions.listPerps` returns.
 */
export interface PerpPosition {
  coin: string;
  side: PerpSide;
  /** Absolute size in coin units. */
  size: string;
  entryPx: string | null;
  markPx: string | null;
  liquidationPx: string | null;
  unrealizedPnl: string;
  /** Venue-reported return on equity as a decimal (0.05 = 5%). */
  returnOnEquity: string | null;
  leverage: number;
  marginMode: MarginMode;
  marginUsed: string;
  /** Cumulative funding since the position opened (signed). */
  funding: string;
}

/**
 * Live market snapshot for a single perp coin, assembled from
 * `metaAndAssetCtxs` (per-asset ctx) and the top of the `l2Book`. Drives the
 * perps header strip (price / 24h change / bid-ask). All prices are HL's raw
 * decimal strings (kept string-typed to avoid precision loss); the day-change
 * percentage is derived on the client from `markPx` vs `prevDayPx`.
 */
export interface PerpAssetSnapshot {
  /** Canonical coin name as HL spells it (e.g. "BTC", "kPEPE"). */
  coin: string;
  /** Size precision required when submitting orders for this asset. */
  szDecimals: number;
  /** Maximum leverage allowed by this market. */
  maxLeverage: number;
  /** True when the market supports isolated margin only. */
  isolatedOnly: boolean;
  /** Mark price (the coin's headline price). */
  markPx: string | null;
  /** Mid price (top-of-book midpoint); null when the book is empty. */
  midPx: string | null;
  /** Oracle price. */
  oraclePx: string | null;
  /** Previous day's closing price (reference for the 24h change). */
  prevDayPx: string | null;
  /** Current hourly funding rate (signed decimal, e.g. "0.0000125"). */
  funding: string | null;
  /** 24h notional volume in USD. */
  dayNtlVlm: string | null;
  /**
   * Open interest in coin units (not USD). Multiply by `markPx` for the
   * notional figure a trader reads; the client does that conversion so the
   * raw venue value stays lossless here.
   */
  openInterest: string | null;
  /** Best (highest) bid price from the top of the L2 book. */
  bid: string | null;
  /** Best (lowest) ask price from the top of the L2 book. */
  ask: string | null;
}

/**
 * One aggregated price level of Hyperliquid's L2 order book.
 *
 * Prices and sizes stay HL's raw decimal strings (no float round-trip), the
 * same convention `PerpAssetSnapshot` uses. `n` is the number of individual
 * resting orders that make up the level.
 */
export interface PerpL2Level {
  /** Level price. */
  px: string;
  /** Total resting size at this price, in coin units. */
  sz: string;
  /** Number of individual orders aggregated into this level. */
  n: number;
}

/**
 * A depth-limited L2 order book snapshot for one perp coin.
 *
 * Both sides are ordered best-first: `bids[0]` is the highest bid and
 * `asks[0]` the lowest ask, which is exactly how HL returns them. Either side
 * can be empty for a brand-new or illiquid market, so consumers must render an
 * empty book rather than assume a top level exists.
 */
export interface PerpL2Book {
  /** Canonical coin name as HL spells it (e.g. "BTC", "kPEPE"). */
  coin: string;
  /** Snapshot timestamp in ms since epoch; null when HL did not report one. */
  time: number | null;
  /** Bid levels, highest price first. */
  bids: PerpL2Level[];
  /** Ask levels, lowest price first. */
  asks: PerpL2Level[];
}

/**
 * Compact per-coin market stats for the whole tradable universe, from a single
 * `metaAndAssetCtxs` call. Drives the HL Markets list's price, 24h-change,
 * volume, open-interest and funding views without a per-coin
 * `assetSnapshot`/`l2Book` fan-out. Prices stay HL's raw decimal strings; the
 * 24h change and notional open interest are derived on the client.
 */
export interface PerpMarketStat {
  /** Canonical coin name as HL spells it (e.g. "BTC", "kPEPE"). */
  coin: string;
  /** Maximum leverage the venue allows for this asset. */
  maxLeverage: number;
  /** Mark price (the coin's headline price). */
  markPx: string | null;
  /** Previous day's closing price (reference for the 24h change). */
  prevDayPx: string | null;
  /** 24h notional volume in USD. */
  dayNtlVlm: string | null;
  /** Open interest in coin units. */
  openInterest: string | null;
  /**
   * Current hourly funding rate (signed decimal, e.g. "0.0000125"). The venue
   * already returns this in the same asset ctx as price and volume, so the
   * market list can show it without a per-coin snapshot fan-out.
   */
  funding: string | null;
}

/** Market stats plus coverage details when one or more DEX partitions fail. */
export interface PerpUniverseStatsResult {
  stats: PerpMarketStat[];
  unavailableDexes: string[];
}

/**
 * Free collateral for a new perp order, plus the account value that `pct_equity`
 * sizes against, read from whichever ledger the account's abstraction mode
 * actually keeps it in. Produced by `HyperliquidClient.perpCollateral()`.
 */
export interface PerpCollateral {
  /** Collateral that can back a NEW order, after committed margin. */
  freeUsd: string;
  /** Total account value in the funding ledger, the `pct_equity` base. */
  accountValueUsd: string;
  /** Which ledger answered, so an operator can tell modes apart in a log. */
  source: "spot-unified" | "spot-portfolio-margin" | "perp-cross-margin";
}

/** A keyless Hyperliquid Info API candle, preserved in the venue's raw shape. */
export interface PerpCandle {
  /** Opening timestamp in milliseconds since epoch. */
  t: number;
  /** Closing timestamp in milliseconds since epoch. */
  T: number;
  /** Exact Hyperliquid coin spelling. */
  s: string;
  /** Candle interval. */
  i: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}
