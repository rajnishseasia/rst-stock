import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { AlpacaConfigSchema, type AlpacaConfig } from "./config.js";
import { withRetry } from "@trade-bot/utils";
import type {
  AlpacaAccount,
  AlpacaOrder,
  AlpacaPosition,
  CreateOrderRequest,
  BracketOrderRequest,
  OCOOrderRequest,
  TrailingStopOrderRequest,
  MultiTPWithTrailingStopConfig,
  MultiLegOrderResult,
  GetOptionContractsParams,
  OptionContractsResponse,
  GetOptionChainParams,
  OptionSnapshotMap,
  OptionSnapshot,
  OptionQuote,
  PortfolioHistory,
  GetPortfolioHistoryParams,
  StockMoversResponse,
  MostActiveStocksResponse,
  StockSnapshotResponse,
  AlpacaNewsResponse,
} from "./types.js";

const require = createRequire(import.meta.url);
let AlpacaCtor: (new (config: Record<string, unknown>) => any) | undefined;

export const ALPACA_CLIENT_ORDER_ID_MAX_LENGTH = 48;

function digestId(value: string, length: number): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, length);
}

export function createBrokerClientOrderId(
  ownerId: string,
  logicalId: string,
  namespace: string = "order",
): string {
  const normalizedOwner = ownerId.trim();
  const normalizedLogicalId = logicalId.trim();
  const normalizedNamespace = namespace.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!normalizedOwner || !normalizedLogicalId || !normalizedNamespace) {
    throw new Error("Broker client order ID owner, logical ID, and namespace are required");
  }

  return `rst-${normalizedNamespace}-${digestId(
    `${normalizedNamespace}\0${normalizedOwner}\0${normalizedLogicalId}`,
    32,
  )}`;
}

export function deriveClientOrderId(base: string, suffix: string): string {
  const normalizedBase = base.trim();
  const normalizedSuffix = suffix.trim();
  if (!normalizedBase || !normalizedSuffix) {
    throw new Error("Client order ID base and suffix are required");
  }

  const suffixSlug = normalizedSuffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  if (!suffixSlug) {
    throw new Error("Client order ID suffix must contain letters or numbers");
  }
  const tail = `-${suffixSlug}-${digestId(`${normalizedBase}\0${normalizedSuffix}`, 10)}`;
  if (tail.length >= ALPACA_CLIENT_ORDER_ID_MAX_LENGTH) {
    throw new Error("Client order ID suffix is too long");
  }
  return `${normalizedBase.slice(0, ALPACA_CLIENT_ORDER_ID_MAX_LENGTH - tail.length)}${tail}`;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.response?.status ?? candidate.status;
  return typeof status === "number" ? status : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return errorStatus(error) === 404;
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const candidate = error as {
    message?: unknown;
    response?: { data?: unknown };
  };
  const responseData = candidate.response?.data;
  const responseMessage =
    responseData && typeof responseData === "object" && "message" in responseData
      ? (responseData as { message?: unknown }).message
      : responseData;
  return [candidate.message, responseMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function isDuplicateClientOrderIdError(error: unknown): boolean {
  return errorStatus(error) === 422 && /client[_ ]order[_ ]id.*unique|duplicate.*client[_ ]order/i.test(
    errorMessage(error),
  );
}

function isAmbiguousCreateError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500;
  }
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    request?: unknown;
    response?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  if (
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ERR_NETWORK",
      "ETIMEDOUT",
    ].includes(code) ||
    code.startsWith("UND_ERR_")
  ) {
    return true;
  }
  if (candidate.request && !candidate.response) return true;
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;

  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /fetch failed|network error|socket hang up|timed?\s*out|connection reset/i.test(message);
}

/**
 * Options-shape input for the list-orders endpoint. Used by list-driven pollers
 * (e.g. ExternalFillPoller) that need to page forward through an account's
 * order history by `submitted_at`. Timestamps may be passed as Date or ISO-8601
 * strings — the client normalizes to ISO before calling Alpaca.
 */
export interface GetOrdersOptions {
  status?: "open" | "closed" | "all";
  limit?: number;
  direction?: "asc" | "desc";
  nested?: boolean;
  after?: Date | string;
  until?: Date | string;
}

/** Optional controls for the abortable, deterministic daily-bars path. */
export interface GetBarsOptions {
  /** Abort the underlying market-data request when the caller deadline fires. */
  signal?: AbortSignal;
  /** Anchor the request window to this instant instead of the wall clock. */
  asOf?: Date;
}

export type AlpacaAmbiguousOperation =
  | "create_order"
  | "close_position"
  | "close_all_positions";

export class AlpacaAmbiguousOrderError extends Error {
  readonly code = "ALPACA_AMBIGUOUS_ORDER" as const;

  constructor(
    readonly operation: AlpacaAmbiguousOperation,
    override readonly cause: unknown,
    readonly clientOrderId?: string,
    readonly reconciliation?: Record<string, unknown>,
  ) {
    super(`Alpaca ${operation.replaceAll("_", " ")} outcome is ambiguous and is syncing`);
    this.name = "AlpacaAmbiguousOrderError";
  }
}

export function isAlpacaAmbiguousOrderError(error: unknown): error is AlpacaAmbiguousOrderError {
  return error instanceof AlpacaAmbiguousOrderError ||
    (!!error && typeof error === "object" &&
      (error as { code?: unknown }).code === "ALPACA_AMBIGUOUS_ORDER");
}

function getAlpacaCtor(): new (config: Record<string, unknown>) => any {
  AlpacaCtor ??= require("@alpacahq/alpaca-trade-api") as new (
    config: Record<string, unknown>
  ) => any;
  return AlpacaCtor;
}

export class AlpacaClient {
  private alpaca: any; // The SDK type definitions are often missing or incomplete
  private config: AlpacaConfig;

  constructor(config: AlpacaConfig) {
    this.config = AlpacaConfigSchema.parse(config);

    const Alpaca = getAlpacaCtor();
    this.alpaca = new Alpaca({
      keyId: this.config.keyId,
      secretKey: this.config.secretKey,
      paper: this.config.paper,
      feed: this.config.paper ? "iex" : "sip", // Free paper accounts must use IEX feed for data
      baseUrl: this.config.baseUrl?.replace(/\/v2\/?$/, "").replace(/\/$/, ""),
    });
  }

  /**
   * Get account details
   */
  async getAccount(): Promise<AlpacaAccount> {
    return await withRetry(() => this.alpaca.getAccount());
  }

  /**
   * Get portfolio history (equity / P&L time series).
   * RAW authenticated GET — the wrapped SDK has no wrapper for
   * GET /v2/account/portfolio/history. Returns the raw response untouched;
   * normalization happens in the router.
   */
  async getPortfolioHistory(params?: GetPortfolioHistoryParams): Promise<PortfolioHistory> {
    const base =
      this.config.baseUrl?.replace(/\/v2\/?$/, "") ||
      (this.config.paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets");

    const qs = new URLSearchParams();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) qs.set(key, String(value));
      }
    }

    const url = `${base}/v2/account/portfolio/history?${qs.toString()}`;

    return await withRetry(async () => {
      const res = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": this.config.keyId,
          "APCA-API-SECRET-KEY": this.config.secretKey,
        },
      });
      if (!res.ok) {
        throw new Error(`Alpaca account/portfolio/history ${res.status}: ${await res.text()}`);
      }
      return res.json() as Promise<PortfolioHistory>;
    });
  }

  /**
   * Get all positions with current market values
   */
  async getPositions(): Promise<AlpacaPosition[]> {
    return await withRetry(() => this.alpaca.getPositions());
  }

  /**
   * Get a specific position
   */
  async getPosition(symbol: string): Promise<AlpacaPosition> {
    return await withRetry(() => this.alpaca.getPosition(symbol));
  }

  /**
   * Get the broker's record for an asset (used to read `fractionable` for the
   * copy-mirror sizing path). Returns the raw underlying payload — typed loosely
   * because the underlying SDK's Asset shape varies by version and we only need
   * a couple of fields (`fractionable`, `tradable`, `symbol`).
   */
  async getAsset(symbol: string): Promise<{
    symbol: string;
    fractionable?: boolean;
    tradable?: boolean;
    [key: string]: unknown;
  }> {
    return await withRetry(() =>
      (this.alpaca as unknown as { getAsset: (s: string) => Promise<{ symbol: string }> }).getAsset(
        symbol,
      ),
    );
  }

  /**
   * Close a specific position
   */
  async closePosition(symbol: string): Promise<AlpacaOrder> {
    try {
      return await this.alpaca.closePosition(symbol);
    } catch (error) {
      if (!isAmbiguousCreateError(error)) throw error;

      const [position, orders] = await Promise.allSettled([
        this.alpaca.getPosition(symbol),
        this.alpaca.getOrders({ status: "all", limit: 50, direction: "desc", nested: true }),
      ]);
      throw new AlpacaAmbiguousOrderError("close_position", error, undefined, {
        position: position.status,
        orders: orders.status,
      });
    }
  }

  /**
   * Close all positions
   */
  async closeAllPositions(cancelOrders: boolean = false): Promise<AlpacaOrder[]> {
    try {
      // The installed SDK's closeAllPositions is bound directly to closeAll(),
      // which takes zero parameters and hard-codes queryParams to null
      // (dist/resources/position.js): whatever we pass to that wrapper is
      // discarded before it reaches the query string, so cancel_orders was
      // silently never sent no matter what the caller asked for (alpaca-07).
      // Call the SDK's own sendRequest directly so the documented
      // cancel_orders query parameter actually reaches Alpaca.
      return await this.alpaca.sendRequest(
        "/positions",
        { cancel_orders: cancelOrders },
        null,
        "DELETE",
      );
    } catch (error) {
      if (!isAmbiguousCreateError(error)) throw error;

      const [positions, orders] = await Promise.allSettled([
        this.alpaca.getPositions(),
        this.alpaca.getOrders({ status: "all", limit: 50, direction: "desc", nested: true }),
      ]);
      throw new AlpacaAmbiguousOrderError("close_all_positions", error, undefined, {
        positions: positions.status,
        orders: orders.status,
      });
    }
  }

  /**
   * Create a simple order
   */
  async createOrder(order: CreateOrderRequest): Promise<AlpacaOrder> {
    return await this.createOrderIdempotently(order);
  }

  private async createOrderIdempotently(order: CreateOrderRequest): Promise<AlpacaOrder> {
    const clientOrderId = order.client_order_id?.trim();
    if (!clientOrderId || clientOrderId.length > ALPACA_CLIENT_ORDER_ID_MAX_LENGTH) {
      throw new Error(
        `client_order_id must be between 1 and ${ALPACA_CLIENT_ORDER_ID_MAX_LENGTH} characters`,
      );
    }

    // No outer try/catch: it was a pure rethrow wrapper (lint: no-useless-catch).
    return await withRetry(
      async () => {
        try {
          return await this.alpaca.createOrder({ ...order, client_order_id: clientOrderId });
        } catch (error) {
          const ambiguous = isAmbiguousCreateError(error);
          const duplicate = isDuplicateClientOrderIdError(error);
          if (!ambiguous && !duplicate) throw error;

          try {
            // The recovery lookup can be rate-limited or time out for exactly
            // the same reason the create it is reconciling was: a single
            // transient blip here used to be enough, on its own, to declare
            // the create outcome permanently ambiguous (alpaca-01), even
            // though nothing yet proves whether the order exists at Alpaca.
            // Retried on the SAME transient shapes the outer retry already
            // trusts (429/408/5xx/network), so a second rate-limited request
            // gets a real chance to clear before we give up on reading the
            // answer. A clean 404 (genuinely never created) still resolves in
            // one shot below, unaffected.
            return await withRetry(
              () => this.alpaca.getOrderByClientId(clientOrderId),
              { maxAttempts: 3, initialDelayMs: 200, retryOn: (lookupErr) => isAmbiguousCreateError(lookupErr) },
            );
          } catch (lookupError) {
            if (isNotFoundError(lookupError)) throw error;
            throw new AlpacaAmbiguousOrderError(
              "create_order",
              lookupError,
              clientOrderId,
              { createError: errorMessage(error) },
            );
          }
        }
      },
      { retryOn: (error) => isAmbiguousCreateError(error) },
    );
  }

  /**
   * Create a Bracket Order (Entry + Take Profit + Stop Loss)
   *
   * Example: Buy 100 AAPL at market, with TP at $155 and SL at $145
   */
  async createBracketOrder(order: BracketOrderRequest): Promise<AlpacaOrder> {
    const bracketOrder: CreateOrderRequest = {
      symbol: order.symbol,
      qty: order.qty,
      side: order.side,
      type: order.type,
      time_in_force: order.time_in_force,
      order_class: "bracket",
      take_profit: {
        limit_price: order.take_profit.limit_price,
      },
      stop_loss: {
        stop_price: order.stop_loss.stop_price,
        limit_price: order.stop_loss.limit_price,
      },
      client_order_id: order.client_order_id,
      ...(order.limit_price && { limit_price: order.limit_price }),
    };

    return await this.createOrderIdempotently(bracketOrder);
  }

  /**
   * Create an OCO Order (One-Cancels-Other)
   * Used for exit strategies on existing positions
   *
   * Creates 2 linked orders: when one fills, the other cancels
   * Example: Sell 100 AAPL - TP at $155 OR SL at $145
   */
  async createOCOOrder(order: OCOOrderRequest): Promise<AlpacaOrder> {
    const ocoOrder: CreateOrderRequest = {
      symbol: order.symbol,
      qty: order.qty,
      side: order.side,
      type: "limit", // OCO requires limit type
      time_in_force: order.time_in_force,
      order_class: "oco",
      take_profit: {
        limit_price: order.take_profit.limit_price,
      },
      stop_loss: {
        stop_price: order.stop_loss.stop_price,
        limit_price: order.stop_loss.limit_price,
      },
      client_order_id: order.client_order_id,
    };

    return await this.createOrderIdempotently(ocoOrder);
  }

  /**
   * Create a Trailing Stop Order
   *
   * The stop price trails the market price by trail_price (dollars) or trail_percent (%)
   */
  async createTrailingStopOrder(order: TrailingStopOrderRequest): Promise<AlpacaOrder> {
    const trailingOrder: any = {
      symbol: order.symbol,
      qty: order.qty,
      side: order.side,
      type: "trailing_stop",
      time_in_force: order.time_in_force,
    };

    // Must specify one of trail_price or trail_percent
    if (order.trail_price) {
      trailingOrder.trail_price = order.trail_price;
    } else if (order.trail_percent) {
      trailingOrder.trail_percent = order.trail_percent;
    }

    trailingOrder.client_order_id = order.client_order_id;

    return await this.createOrderIdempotently(trailingOrder);
  }

  /**
   * Create Multi-TP with Trailing Stop Strategy
   *
   * Since Alpaca doesn't support multiple TPs natively, we:
   * 1. Submit entry order
   * 2. After entry fills, submit multiple limit sell orders for each TP
   * 3. Submit a trailing stop for remaining shares
   *
   * NOTE: This is a fire-and-forget approach - for production, you'd want
   * to use webhooks or polling to monitor the entry order fill before
   * submitting exit orders.
   *
   * For IMMEDIATE use (when you already have a position), use createExitStrategy()
   */
  async createMultiTPStrategy(config: MultiTPWithTrailingStopConfig): Promise<MultiLegOrderResult> {
    const results: MultiLegOrderResult = {
      entryOrderId: "",
      takeProfitOrderIds: [],
      trailingStopOrderId: undefined,
      stopLossOrderId: undefined,
      success: false,
      message: "",
    };

    try {
      // 1. Submit entry order
      const entryOrder = await this.createOrder({
        symbol: config.symbol,
        qty: config.totalQty,
        side: config.side,
        type: config.entryType,
        time_in_force: "gtc",
        client_order_id: deriveClientOrderId(config.client_order_id, "entry"),
        ...(config.entryLimitPrice && { limit_price: config.entryLimitPrice }),
      });
      results.entryOrderId = entryOrder.id;

      // Note: In real implementation, you'd wait for entry to fill
      // before submitting exit orders. This is a simplified version.

      results.success = true;
      results.message = `Entry order submitted (${entryOrder.id}). Exit orders should be submitted after entry fills.`;

      return results;
    } catch (error) {
      results.message = error instanceof Error ? error.message : "Failed to create multi-TP strategy";
      return results;
    }
  }

  /**
   * Create Exit Strategy for Existing Position
   *
   * Use this when you already have a position and want to set up:
   * - Multiple Take Profit levels
   * - Trailing stop for remaining shares
   *
   * Example: You own 100 AAPL shares, want:
   * - TP1: Sell 30 at $155
   * - TP2: Sell 30 at $160
   * - Trailing Stop: Sell remaining 40 with 2% trail
   */
  async createExitStrategy(config: {
    client_order_id: string;
    symbol: string;
    /**
     * Side of the EXIT orders. Defaults to "sell" (closing a long position).
     * Pass "buy" to close a short position (buy-to-cover).
     */
    exitSide?: "buy" | "sell";
    takeProfits: Array<{ price: number; qty: number }>;
    trailingStop?: { qty: number; trailPercent?: number; trailPrice?: number };
    stopLoss?: { stopPrice: number; qty: number };
  }): Promise<{
    takeProfitOrderIds: string[];
    trailingStopOrderId?: string;
    stopLossOrderId?: string;
    errors: string[];
  }> {
    const exitSide = config.exitSide ?? "sell";
    const result = {
      takeProfitOrderIds: [] as string[],
      trailingStopOrderId: undefined as string | undefined,
      stopLossOrderId: undefined as string | undefined,
      errors: [] as string[],
    };

    // Submit TP limit orders
    for (const [index, tp] of config.takeProfits.entries()) {
      try {
        const tpOrder = await this.createOrder({
          symbol: config.symbol,
          qty: tp.qty,
          side: exitSide,
          type: "limit",
          time_in_force: "gtc",
          limit_price: tp.price,
          client_order_id: deriveClientOrderId(config.client_order_id, `tp${index}`),
        });
        result.takeProfitOrderIds.push(tpOrder.id);
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) throw error;
        result.errors.push(`TP at $${tp.price}: ${error instanceof Error ? error.message : "Failed"}`);
      }
    }

    // Submit trailing stop
    if (config.trailingStop) {
      try {
        const tsOrder = await this.createTrailingStopOrder({
          symbol: config.symbol,
          qty: config.trailingStop.qty,
          side: exitSide,
          type: "trailing_stop",
          time_in_force: "gtc",
          trail_percent: config.trailingStop.trailPercent,
          trail_price: config.trailingStop.trailPrice,
          client_order_id: deriveClientOrderId(config.client_order_id, "trail"),
        });
        result.trailingStopOrderId = tsOrder.id;
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) throw error;
        result.errors.push(`Trailing stop: ${error instanceof Error ? error.message : "Failed"}`);
      }
    }

    // Submit stop loss if provided
    if (config.stopLoss) {
      try {
        const slOrder = await this.createOrder({
          symbol: config.symbol,
          qty: config.stopLoss.qty,
          side: exitSide,
          type: "stop",
          time_in_force: "gtc",
          stop_price: config.stopLoss.stopPrice,
          client_order_id: deriveClientOrderId(config.client_order_id, "stop"),
        });
        result.stopLossOrderId = slOrder.id;
      } catch (error: any) {
        if (isAlpacaAmbiguousOrderError(error)) throw error;
        // If 403, try with day time_in_force instead
        const is403 = error?.response?.status === 403 || error?.message?.includes("403");
        if (is403) {
          try {
            const slOrder = await this.createOrder({
              symbol: config.symbol,
              qty: config.stopLoss.qty,
              side: exitSide,
              type: "stop",
              time_in_force: "day",
              stop_price: config.stopLoss.stopPrice,
              client_order_id: deriveClientOrderId(config.client_order_id, "stop"),
            });
            result.stopLossOrderId = slOrder.id;
          } catch (retryError: any) {
            if (isAlpacaAmbiguousOrderError(retryError)) throw retryError;
            const msg = retryError?.response?.data?.message || retryError?.message || "Failed";
            result.errors.push(`Stop loss: ${msg}`);
          }
        } else {
          const msg = error?.response?.data?.message || error?.message || "Failed";
          result.errors.push(`Stop loss: ${msg}`);
        }
      }
    }

    return result;
  }

  /**
   * Get an order by ID
   */
  async getOrder(orderId: string): Promise<AlpacaOrder> {
    return await withRetry(() => this.alpaca.getOrder(orderId));
  }

  /**
   * Get an order by the caller-owned client order ID. This is the safe recovery
   * path when Alpaca may have accepted a create request before the response or
   * local broker ID was durably recorded.
   */
  async getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder> {
    return await withRetry(() => this.alpaca.getOrderByClientId(clientOrderId));
  }

  /**
   * Get orders. Two call shapes for backward compat:
   *   getOrders("all", 100, true)                    // legacy positional form
   *   getOrders({ status: "all", after, direction }) // options form used by
   *                                                  // list-driven pollers
   *                                                  // (ExternalFillPoller)
   *
   * The options form exposes `after` / `until` / `direction` so a poller can
   * page forward through the account's order history using `submitted_at` as
   * the cursor.
   */
  async getOrders(
    statusOrOptions: "open" | "closed" | "all" | GetOrdersOptions = "open",
    limit: number = 50,
    nested: boolean = true,
  ): Promise<AlpacaOrder[]> {
    const options: GetOrdersOptions =
      typeof statusOrOptions === "string"
        ? { status: statusOrOptions, limit, direction: "desc", nested }
        : {
            status: statusOrOptions.status ?? "open",
            limit: statusOrOptions.limit ?? 500,
            direction: statusOrOptions.direction ?? "desc",
            nested: statusOrOptions.nested ?? true,
            after: statusOrOptions.after,
            until: statusOrOptions.until,
          };
    // Alpaca expects ISO-8601 strings for `after`/`until`, not Date instances.
    const query: Record<string, unknown> = {
      status: options.status,
      limit: options.limit,
      direction: options.direction,
      nested: options.nested,
    };
    if (options.after !== undefined) {
      query.after = options.after instanceof Date
        ? options.after.toISOString()
        : options.after;
    }
    if (options.until !== undefined) {
      query.until = options.until instanceof Date
        ? options.until.toISOString()
        : options.until;
    }
    return await withRetry(() => this.alpaca.getOrders(query));
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<void> {
    await withRetry(() => this.alpaca.cancelOrder(orderId));
  }

  /**
   * Replace/modify an existing order
   * Allows changing qty, time_in_force, limit_price, stop_price, trail
   */
  async replaceOrder(orderId: string, updates: {
    qty?: number;
    time_in_force?: string;
    limit_price?: number;
    stop_price?: number;
    trail?: number;
    client_order_id?: string;
  }): Promise<AlpacaOrder> {
    return await withRetry(() => this.alpaca.replaceOrder(orderId, updates));
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<void> {
    await withRetry(() => this.alpaca.cancelAllOrders());
  }

  /**
   * Get Market Data (Bars)
   * Uses v2 Data API
   */
  async getBars(
    symbol: string,
    timeframe: "1Min" | "5Min" | "15Min" | "1H" | "1D",
    limit: number = 100,
    options?: GetBarsOptions,
  ): Promise<any[]> {
    const lookbackDaysByTimeframe: Record<typeof timeframe, number> = {
      "1Min": 5,
      "5Min": 10,
      "15Min": 20,
      "1H": 90,
      "1D": 400,
    };
    const end = options?.asOf ?? new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - lookbackDaysByTimeframe[timeframe]);

    // The legacy SDK path remains untouched for charts and other existing
    // callers. The leaderboard supplies an as-of and signal so it can exclude
    // the current UTC day and cancel a hung provider request at its deadline.
    if (options?.asOf || options?.signal) {
      return this.getBarsWithFetch(symbol, timeframe, limit, start, end, options?.signal);
    }

    const bars = [];
    // sort=desc anchors `limit` to the END of the window (now) instead of the
    // start. Alpaca defaults to ascending, which returns the OLDEST `limit`
    // bars from the lookback start — so the chart would show days-old data and
    // never reach the present once `limit` is hit. We collect newest-first then
    // reverse to the ascending order Lightweight Charts (and our live-candle
    // logic, which reads the last array element as "most recent") requires.
    const resp = this.alpaca.getBarsV2(symbol, {
      timeframe,
      limit,
      start: start.toISOString(),
      end: end.toISOString(),
      sort: "desc",
      feed: this.config.paper ? "iex" : "sip",
    });

    for await (const bar of resp) {
      bars.push(bar);
    }

    bars.reverse();

    return bars;
  }

  private async getBarsWithFetch(
    symbol: string,
    timeframe: "1Min" | "5Min" | "15Min" | "1H" | "1D",
    limit: number,
    start: Date,
    end: Date,
    signal?: AbortSignal,
  ): Promise<any[]> {
    const query = new URLSearchParams({
      timeframe,
      limit: String(limit),
      start: start.toISOString(),
      end: end.toISOString(),
      sort: "desc",
      feed: this.config.paper ? "iex" : "sip",
    });
    const url = `${this.dataBaseUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`;
    const response = await fetch(url, { headers: this.apcaHeaders, signal });
    if (!response.ok) {
      throw new Error(`Alpaca market data ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as { bars?: unknown };
    return Array.isArray(payload.bars) ? [...payload.bars].reverse() : [];
  }

  /**
   * Get latest snapshot (price, quote, trade) for a symbol
   */
  async getSnapshot(symbol: string): Promise<any> {
    return await this.alpaca.getSnapshot(symbol);
  }

  /**
   * Get latest quote (bid/ask) for a symbol
   */
  async getLatestQuote(symbol: string): Promise<any> {
    return await this.alpaca.getLatestQuote(symbol);
  }

  /**
   * Get latest trade for a symbol
   */
  async getLatestTrade(symbol: string): Promise<any> {
    return await this.alpaca.getLatestTrade(symbol);
  }

  private async getMarketDataJson<T>(path: string, query: URLSearchParams): Promise<T> {
    const url = `${this.dataBaseUrl}${path}?${query.toString()}`;
    return await withRetry(async () => {
      const response = await fetch(url, { headers: this.apcaHeaders });
      if (!response.ok) {
        throw new Error(`Alpaca market data ${response.status}: ${await response.text()}`);
      }
      return response.json() as Promise<T>;
    });
  }

  /** Top stock gainers and losers from Alpaca's screener service. */
  async getStockMovers(top = 20): Promise<StockMoversResponse> {
    const query = new URLSearchParams({ top: String(Math.min(Math.max(top, 1), 50)) });
    return this.getMarketDataJson("/v1beta1/screener/stocks/movers", query);
  }

  /** Most-active US stocks by share volume. */
  async getMostActiveStocks(top = 30): Promise<MostActiveStocksResponse> {
    const query = new URLSearchParams({
      by: "volume",
      top: String(Math.min(Math.max(top, 1), 100)),
    });
    return this.getMarketDataJson("/v1beta1/screener/stocks/most-actives", query);
  }

  /** Batch snapshots for a bounded list of US equity symbols. */
  async getStockSnapshots(symbols: string[]): Promise<StockSnapshotResponse> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
      .slice(0, 100);
    if (normalized.length === 0) return { snapshots: {} };
    const query = new URLSearchParams({
      symbols: normalized.join(","),
      feed: this.config.paper ? "iex" : "sip",
    });
    return this.getMarketDataJson("/v2/stocks/snapshots", query);
  }

  /** Recent sourced market news. */
  async getMarketNews(limit = 20): Promise<AlpacaNewsResponse> {
    const query = new URLSearchParams({
      limit: String(Math.min(Math.max(limit, 1), 50)),
      sort: "desc",
      exclude_contentless: "true",
    });
    return this.getMarketDataJson("/v1beta1/news", query);
  }

  // -------------------------------------------------------------------------
  // Options support (raw fetch — the SDK has no wrappers for these endpoints)
  // -------------------------------------------------------------------------

  /**
   * Trading host for /v2/options/contracts (paper vs live).
   */
  private get tradingBaseUrl(): string {
    return this.config.baseUrl
      ? this.config.baseUrl.replace(/\/v2\/?$/, "").replace(/\/$/, "")
      : this.config.paper
      ? "https://paper-api.alpaca.markets"
      : "https://api.alpaca.markets";
  }

  /**
   * Data host — same for paper + live (per Alpaca facts).
   */
  private get dataBaseUrl(): string {
    return "https://data.alpaca.markets";
  }

  /**
   * Auth headers reused by all raw-fetch option methods.
   */
  private get apcaHeaders(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.config.keyId,
      "APCA-API-SECRET-KEY": this.config.secretKey,
      Accept: "application/json",
    };
  }

  /**
   * Discover option contracts (strikes/expirations) for an underlying.
   * RAW fetch — the SDK has no wrapper for GET /v2/options/contracts.
   * Returns the raw response untouched; normalization happens in the router.
   */
  async getOptionContracts(params: GetOptionContractsParams): Promise<OptionContractsResponse> {
    const qs = new URLSearchParams();
    qs.set("underlying_symbols", params.underlying_symbols);
    if (params.type !== undefined) qs.set("type", params.type);
    qs.set("status", params.status ?? "active");
    if (params.expiration_date_gte !== undefined) qs.set("expiration_date_gte", params.expiration_date_gte);
    if (params.expiration_date_lte !== undefined) qs.set("expiration_date_lte", params.expiration_date_lte);
    if (params.strike_price_gte !== undefined) qs.set("strike_price_gte", String(params.strike_price_gte));
    if (params.strike_price_lte !== undefined) qs.set("strike_price_lte", String(params.strike_price_lte));
    qs.set("limit", String(params.limit ?? 1000));
    if (params.page_token !== undefined) qs.set("page_token", params.page_token);

    const url = `${this.tradingBaseUrl}/v2/options/contracts?${qs.toString()}`;

    return await withRetry(async () => {
      const res = await fetch(url, { headers: this.apcaHeaders });
      if (!res.ok) {
        throw new Error(`Alpaca options/contracts ${res.status}: ${await res.text()}`);
      }
      return res.json() as Promise<OptionContractsResponse>;
    });
  }

  /**
   * Option chain snapshots (live-ish bid/ask + greeks) for an underlying.
   * RAW fetch to the DATA host. Always uses feed=indicative (free, ~15-min
   * delayed) regardless of any feed in params.
   */
  async getOptionChainSnapshots(underlying: string, params?: GetOptionChainParams): Promise<OptionSnapshotMap> {
    const qs = new URLSearchParams();
    qs.set("feed", "indicative");
    if (params?.type !== undefined) qs.set("type", params.type);
    if (params?.strike_price_gte !== undefined) qs.set("strike_price_gte", String(params.strike_price_gte));
    if (params?.strike_price_lte !== undefined) qs.set("strike_price_lte", String(params.strike_price_lte));
    if (params?.expiration_date !== undefined) qs.set("expiration_date", params.expiration_date);
    if (params?.expiration_date_gte !== undefined) qs.set("expiration_date_gte", params.expiration_date_gte);
    if (params?.expiration_date_lte !== undefined) qs.set("expiration_date_lte", params.expiration_date_lte);
    qs.set("limit", String(Math.min(params?.limit ?? 1000, 1000)));
    if (params?.page_token !== undefined) qs.set("page_token", params.page_token);

    const url = `${this.dataBaseUrl}/v1beta1/options/snapshots/${encodeURIComponent(underlying.toUpperCase())}?${qs.toString()}`;

    return await withRetry(async () => {
      const res = await fetch(url, { headers: this.apcaHeaders });
      if (!res.ok) {
        throw new Error(`Alpaca options/snapshots ${res.status}: ${await res.text()}`);
      }
      return res.json() as Promise<OptionSnapshotMap>;
    });
  }

  /**
   * Lightweight single-contract latest quote (bp/bs/ap/as/t only — no
   * trade/greeks). RAW fetch to the DATA host.
   *
   * Feed is DELIBERATELY not forced on a live client.
   *
   * docs.alpaca.markets/us/reference/optionlatestquotes: the `feed` param
   * defaults to `opra` when the account is subscribed and `indicative`
   * otherwise, so omitting it always yields the best feed the account is
   * actually entitled to.
   *
   * This has been wrong in both directions. It first hardcoded `indicative`
   * unconditionally, which mattered because copy-mirror prices a mirrored
   * option order's real `limit_price` off this quote's bid/ask
   * (`fetchOptionPrice`), so live money moved on a feed the docs call
   * "delayed" with "modified" quotes (alpaca-16). The correction overshot to a
   * hardcoded `opra` for every non-paper client. That fails too: a live
   * TRADING account does not imply an OPRA MARKET-DATA subscription, and
   * `config.ts` defaults `paper: false`, so a client built without an explicit
   * flag lands there as well. An unsubscribed account then gets an entitlement
   * error and no quote at all, which is worse than a delayed one.
   *
   * Paper stays explicit: it has no subscription to discover, and naming the
   * free feed keeps the request deterministic.
   */
  async getLatestOptionQuote(occSymbol: string): Promise<OptionSnapshot | null> {
    const feedParam = this.config.paper ? "&feed=indicative" : "";
    const url = `${this.dataBaseUrl}/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(occSymbol)}${feedParam}`;

    return await withRetry(async () => {
      const res = await fetch(url, { headers: this.apcaHeaders });
      if (!res.ok) {
        throw new Error(`Alpaca options/quotes/latest ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { quotes: Record<string, OptionQuote> };
      return json.quotes?.[occSymbol] ? ({ latestQuote: json.quotes[occSymbol] } as OptionSnapshot) : null;
    });
  }
}
