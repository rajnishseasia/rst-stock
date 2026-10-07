// Re-export or define missing types from the SDK
// The SDK types are often loose or missing, so we might need to define some interfaces here for better type safety.

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  replaced_at: string | null;
  replaced_by: string | null;
  replaces: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  notional: string | null;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  position_intent?: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close" | null;
  order_type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  side: "buy" | "sell";
  time_in_force: "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
  limit_price: string | null;
  stop_price: string | null;
  status: "new" | "partially_filled" | "filled" | "done_for_day" | "canceled" | "expired" | "replaced" | "pending_cancel" | "pending_replace" | "accepted" | "pending_new" | "accepted_for_bidding" | "stopped" | "rejected" | "suspended" | "calculated";
  extended_hours: boolean;
  legs: AlpacaOrder[] | null;
  trail_percent: string | null;
  trail_price: string | null;
  hwm: string | null;
}

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  crypto_status: string;
  currency: string;
  buying_power: string;
  regt_buying_power: string;
  daytrading_buying_power: string;
  non_marginable_buying_power: string;
  cash: string;
  portfolio_value: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
  created_at: string;
  trade_suspended_by_user: boolean;
  multiplier: string;
  shorting_enabled: boolean;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  initial_margin: string;
  maintenance_margin: string;
  last_maintenance_margin: string;
  sma: string;
  daytrade_count: number;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  qty_available: string;
  side: "long" | "short";
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  unrealized_intraday_pl: string;
  unrealized_intraday_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export interface StockMover {
  symbol: string;
  price: number;
  change: number;
  percent_change: number;
}

export interface StockMoversResponse {
  gainers: StockMover[];
  losers: StockMover[];
  market_type?: string;
  last_updated?: string;
}

export interface MostActiveStock {
  symbol: string;
  volume: number;
  trade_count: number;
}

export interface MostActiveStocksResponse {
  most_actives: MostActiveStock[];
  market_type?: string;
  last_updated?: string;
}

export interface StockSnapshotResponse {
  snapshots?: Record<string, unknown>;
  [symbol: string]: unknown;
}

export interface AlpacaNewsArticle {
  id: number | string;
  headline: string;
  summary?: string;
  author?: string;
  created_at: string;
  updated_at?: string;
  url: string;
  symbols?: string[];
  source?: string;
}

export interface AlpacaNewsResponse {
  news: AlpacaNewsArticle[];
  next_page_token?: string | null;
}

export interface CreateOrderRequest {
  symbol: string;
  qty?: number;
  notional?: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  time_in_force: "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
  limit_price?: number;
  stop_price?: number;
  trail_price?: number;
  trail_percent?: number;
  extended_hours?: boolean;
  client_order_id: string;
  order_class?: "simple" | "bracket" | "oco" | "oto";
  position_intent?: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
  take_profit?: {
    limit_price: number;
  };
  stop_loss?: {
    stop_price: number;
    limit_price?: number;
  };
}

/**
 * Extended order request for Bracket Orders (Entry + TP + SL)
 * order_class = "bracket"
 */
export interface BracketOrderRequest extends CreateOrderRequest {
  order_class: "bracket";
  take_profit: {
    limit_price: number;
  };
  stop_loss: {
    stop_price: number;
    limit_price?: number;
  };
}

/**
 * OCO Order - One Cancels Other (used for exit strategies)
 * order_class = "oco"
 * This creates 2 exit orders - when one fills, the other cancels
 */
export interface OCOOrderRequest extends CreateOrderRequest {
  order_class: "oco";
  take_profit: {
    limit_price: number;
  };
  stop_loss: {
    stop_price: number;
    limit_price?: number;
  };
}

/**
 * OTO Order - One Triggers Other (entry triggers exit)
 * order_class = "oto"
 */
export interface OTOOrderRequest extends CreateOrderRequest {
  order_class: "oto";
  take_profit?: {
    limit_price: number;
  };
  stop_loss?: {
    stop_price: number;
    limit_price?: number;
  };
}

/**
 * Trailing Stop Order
 * type = "trailing_stop"
 */
export interface TrailingStopOrderRequest {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "trailing_stop";
  time_in_force: "day" | "gtc";
  trail_price?: number; // Trail by $ amount
  trail_percent?: number; // Trail by % percentage
  client_order_id: string;
}

/**
 * Multi-TP Strategy with Trailing Stop
 * Since Alpaca doesn't natively support multiple TPs in one order,
 * we implement this by:
 * 1. Splitting the position into parts
 * 2. Creating separate limit orders for each TP
 * 3. Creating a trailing stop for the remaining shares
 *
 * Example: Buy 100 shares, set TP1 at $50 for 30 shares, TP2 at $55 for 30 shares,
 *          and trailing stop for remaining 40 shares
 */
export interface MultiTPWithTrailingStopConfig {
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  totalQty: number;
  entryType: "market" | "limit";
  entryLimitPrice?: number;

  // Take Profit levels (each gets a portion of shares)
  takeProfits: Array<{
    price: number;
    qty: number; // Number of shares/contracts for this TP
  }>;

  // Trailing stop for remaining shares after TPs
  trailingStop: {
    qty: number; // Remaining shares for trailing stop
    trailPercent?: number;
    trailPrice?: number; // Dollar amount to trail
  };

  // Stop loss (emergency exit if price goes against)
  stopLoss?: {
    stopPrice: number;
    qty: number;
  };
}

/**
 * Result of submitting multi-leg orders
 */
export interface MultiLegOrderResult {
  entryOrderId: string;
  takeProfitOrderIds: string[];
  trailingStopOrderId?: string;
  stopLossOrderId?: string;
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

/**
 * Query params for GET {TRADING}/v2/options/contracts
 * Contract discovery (strikes/expirations).
 */
export interface GetOptionContractsParams {
  underlying_symbols: string;
  type?: "call" | "put";
  status?: string;
  expiration_date_gte?: string;
  expiration_date_lte?: string;
  strike_price_gte?: number;
  strike_price_lte?: number;
  limit?: number;
  page_token?: string;
}

/**
 * A single option contract as returned by /v2/options/contracts.
 * NOTE: strike_price comes back as a STRING — parse to number when normalizing.
 */
export interface OptionContract {
  id: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  expiration_date: string;
  underlying_symbol: string;
  type: "call" | "put";
  style: string;
  strike_price: string;
  size: string;
  // Open interest is the only source Alpaca exposes for OI (the data snapshot
  // endpoint omits it). Returned as a STRING; `open_interest_date` is the
  // as-of date (typically end of the prior trading day).
  open_interest?: string;
  open_interest_date?: string;
  close_price?: string;
  close_price_date?: string;
}

/**
 * Response shape for GET /v2/options/contracts.
 */
export interface OptionContractsResponse {
  option_contracts: OptionContract[];
  page_token?: string | null;
}

/**
 * Query params for GET {DATA}/v1beta1/options/snapshots/{underlying}
 */
export interface GetOptionChainParams {
  feed?: string;
  type?: "call" | "put";
  strike_price_gte?: number;
  strike_price_lte?: number;
  expiration_date?: string;
  expiration_date_gte?: string;
  expiration_date_lte?: string;
  limit?: number;
  page_token?: string;
}

/**
 * Option latest quote (bp/bs/ap/as/t).
 */
export interface OptionQuote {
  bp: number;
  bs: number;
  ap: number;
  as: number;
  t: string;
}

/**
 * Option latest trade.
 */
export interface OptionTrade {
  p: number;
  s: number;
  t: string;
}

/**
 * Option greeks.
 */
export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

/**
 * OHLCV bar as returned inside option snapshots (dailyBar/minuteBar/prevDailyBar).
 * `v` is the traded volume for the bar's period.
 */
export interface OptionBar {
  t: string; // timestamp (RFC-3339)
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  n?: number; // trade count
  vw?: number; // volume-weighted average price
}

/**
 * Snapshot for a single option contract.
 *
 * NOTE: the snapshot endpoint does NOT return open interest. Volume IS available
 * via `dailyBar.v` (today's traded volume); `minuteBar.v` is the latest minute.
 */
export interface OptionSnapshot {
  latestQuote?: OptionQuote;
  latestTrade?: OptionTrade;
  greeks?: OptionGreeks;
  impliedVolatility?: number;
  dailyBar?: OptionBar;
  minuteBar?: OptionBar;
  prevDailyBar?: OptionBar;
}

/**
 * Response shape for GET /v1beta1/options/snapshots/{underlying}
 * Keyed by OCC symbol.
 */
export interface OptionSnapshotMap {
  snapshots: Record<string, OptionSnapshot>;
  next_page_token?: string | null;
}

// ---------------------------------------------------------------------------
// Portfolio history types
// ---------------------------------------------------------------------------

/**
 * Response shape for GET /v2/account/portfolio/history.
 * Arrays are parallel — index i in each is the same point in time.
 * timestamp is in SECONDS (Unix epoch).
 */
export interface PortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: number[];
  base_value?: number;
  timeframe?: string;
}

/**
 * Query params for GET /v2/account/portfolio/history.
 */
export interface GetPortfolioHistoryParams {
  period?: string;
  timeframe?: string;
  intraday_reporting?: string;
  pnl_reset?: string;
}
