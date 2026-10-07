import {
  ExchangeClient,
  HttpRequestError,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { keccak256, stringToHex } from "viem";
import { isSafePositiveTradingPerpDecimal } from "@trade-bot/utils";
import {
  BuilderCodeSchema,
  DEFAULT_AGENT_NAME,
  HyperliquidNetworkSchema,
  isTestnet,
  type BuilderCode,
  type HyperliquidNetwork,
} from "./config.js";
import { triggerSpecForOrderType } from "./types.js";
import type {
  ApproveAgentRequest,
  ApproveBuilderFeeRequest,
  CancelPerpOrderRequest,
  ExtraAgent,
  MarginMode,
  MarketCloseRequest,
  ModifyPositionTpSlRequest,
  PerpAssetMeta,
  PerpAssetSnapshot,
  PerpL2Book,
  PerpL2Level,
  PerpCandle,
  PerpMarketStat,
  PerpFill,
  PerpFillSide,
  PerpOpenOrder,
  PerpOrderType,
  PerpCollateral,
  PerpCrossMargin,
  PerpPosition,
  PerpSide,
  PerpTimeInForce,
  PerpTpsl,
  PerpUniverseStatsResult,
  PlacePerpOrderRequest,
  SetPositionTpSlRequest,
  UpdateLeverageRequest,
} from "./types.js";

/** Default slippage tolerance used to synthesize market (IoC) prices. */
const DEFAULT_SLIPPAGE = 0.05;

/** HIP-3 builder-deployed perp asset ID base from Hyperliquid's asset-ID spec. */
const HIP3_ASSET_ID_BASE = 100_000;
const HIP3_DEX_ASSET_STRIDE = 10_000;
const POSITION_ADDITIVE_DATA_BUDGET_MS = 500;
const META_CACHE_TTL_MS = 10 * 60_000;
const READ_MAX_ATTEMPTS = 3;
const READ_INITIAL_DELAY_MS = 1_000;
const READ_MAX_DELAY_MS = 10_000;
const REST_WEIGHT_WINDOW_MS = 60_000;
/** Leave headroom for response-size surcharges and other instances on the IP. */
const REST_WEIGHT_BUDGET = 900;
/** Background reconciliation may not consume capacity reserved for live orders. */
export const REST_WEIGHT_BACKGROUND_BUDGET = 400;
const REST_WEIGHT_HARD_CEILING = 1_100;

export type HyperliquidTrafficClass =
  | "standard"
  | "background"
  | "open"
  | "protective"
  | "order-critical";

/** Select the rolling REST allowance for a request's operational priority. */
export function hyperliquidRestBudget(
  endpoint: "info" | "exchange" | "explorer",
  trafficClass: HyperliquidTrafficClass,
): number {
  if (trafficClass === "background") return REST_WEIGHT_BACKGROUND_BUDGET;
  if (
    trafficClass === "protective" ||
    trafficClass === "order-critical" ||
    (endpoint === "exchange" && trafficClass !== "open")
  ) {
    return REST_WEIGHT_HARD_CEILING;
  }
  return REST_WEIGHT_BUDGET;
}

function positionAdditiveSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(POSITION_ADDITIVE_DATA_BUDGET_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

type WeightEntry = { at: number; weight: number };
type RequestPriority = "protective" | "ordinary" | "background";

interface WeightWaiter {
  sequence: number;
  weight: number;
  priority: RequestPriority;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function requestPriority(
  endpoint: "info" | "exchange" | "explorer",
  payload: unknown,
  trafficClass: HyperliquidTrafficClass,
): RequestPriority {
  if (endpoint === "exchange") {
    const action = isRecord(payload) && isRecord(payload.action) ? payload.action : payload;
    if (isRecord(action)) {
      const orders = Array.isArray(action.orders) ? action.orders : null;
      if (orders?.length) {
        if (orders.every((order) => isRecord(order) && order.r === true)) {
          return "protective";
        }
        return trafficClass === "background" ? "background" : "ordinary";
      }
      if (Array.isArray(action.cancels)) return "protective";
      if (isRecord(action.order) && action.order.r === true) return "protective";
    }
  }
  if (trafficClass === "background") return "background";
  if (trafficClass === "protective") return "protective";
  return "ordinary";
}

function budgetForPriority(priority: RequestPriority): number {
  if (priority === "protective") return REST_WEIGHT_HARD_CEILING;
  if (priority === "background") return REST_WEIGHT_BACKGROUND_BUDGET;
  return REST_WEIGHT_BUDGET;
}

function priorityRank(priority: RequestPriority): number {
  if (priority === "protective") return 0;
  if (priority === "ordinary") return 1;
  return 2;
}

/** Shared weighted admission state for this process only. */
class HyperliquidRestScheduler {
  private entries: WeightEntry[] = [];
  private waiters: WeightWaiter[] = [];
  private sequence = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  acquire(
    weight: number,
    priority: RequestPriority,
    signal?: AbortSignal,
    timeoutMs: number | null = null,
    timeoutError: () => unknown = () => new Error("Hyperliquid request timed out"),
  ): Promise<void> {
    const budget = budgetForPriority(priority);
    if (!Number.isSafeInteger(weight) || weight <= 0 || weight > budget) {
      return Promise.reject(new Error("Hyperliquid request weight exceeds its traffic budget"));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Hyperliquid request aborted"));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let waiter!: WeightWaiter;
      const detach = () => {
        if (waiter.timeoutTimer !== undefined) {
          clearTimeout(waiter.timeoutTimer);
          waiter.timeoutTimer = undefined;
        }
        if (signal && waiter.abortListener) {
          signal.removeEventListener("abort", waiter.abortListener);
          waiter.abortListener = undefined;
        }
      };
      waiter = {
        sequence: this.sequence++,
        weight,
        priority,
        ...(signal ? { signal } : {}),
        resolve: () => {
          if (settled) return;
          settled = true;
          detach();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          detach();
          reject(error);
        },
      };
      if (signal) {
        waiter.abortListener = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          waiter.reject(signal.reason ?? new Error("Hyperliquid request aborted"));
          this.pump();
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
      if (timeoutMs !== null) {
        waiter.timeoutTimer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          waiter.reject(timeoutError());
          this.pump();
        }, Math.max(0, timeoutMs));
      }
      this.pump();
    });
  }

  snapshot(budget: number): {
    estimatedWeight: number;
    budget: number;
    windowMs: number;
  } {
    this.prune(Date.now());
    return {
      estimatedWeight: this.entries.reduce((sum, entry) => sum + entry.weight, 0),
      budget,
      windowMs: REST_WEIGHT_WINDOW_MS,
    };
  }

  private prune(now: number): void {
    this.entries = this.entries.filter(
      (entry) => now - entry.at < REST_WEIGHT_WINDOW_MS,
    );
  }

  private pump(): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }

    const now = Date.now();
    this.prune(now);
    this.waiters.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.sequence - b.sequence,
    );

    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      const used = this.entries.reduce((sum, entry) => sum + entry.weight, 0);
      // Priority order is strict, and sequence order within each class is
      // strict: a lighter request may not pass a blocked class head.
      if (used + waiter.weight > budgetForPriority(waiter.priority)) break;
      this.waiters.shift();
      this.entries.push({ at: now, weight: waiter.weight });
      waiter.resolve();
    }

    if (this.waiters.length === 0 || this.entries.length === 0) return;
    const oldest = this.entries[0]!;
    const waitMs = Math.max(1, REST_WEIGHT_WINDOW_MS - (now - oldest.at));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, waitMs);
  }
}

const processLocalRestScheduler = new HyperliquidRestScheduler();

function estimatedRequestWeight(
  endpoint: "info" | "exchange" | "explorer",
  payload: unknown,
): number {
  if (endpoint === "exchange") {
    if (!isRecord(payload)) return 1;
    const action = isRecord(payload.action) ? payload.action : payload;
    const batch = Array.isArray(action.orders)
      ? action.orders.length
      : Array.isArray(action.cancels)
        ? action.cancels.length
        : 0;
    return 1 + Math.floor(batch / 40);
  }
  if (endpoint === "explorer") return 40;
  const type =
    isRecord(payload) && typeof payload.type === "string" ? payload.type : "";
  if (
    [
      "l2Book",
      "allMids",
      "clearinghouseState",
      "orderStatus",
      "spotClearinghouseState",
      "exchangeStatus",
    ].includes(type)
  )
    return 2;
  if (type === "userRole") return 60;
  return 20;
}

/**
 * Process-local weighted limiter for Hyperliquid REST traffic. Independent
 * transports in this process share admission state; separate processes do not.
 */
export class RateLimitedHyperliquidTransport extends HttpTransport {
  private readonly trafficClass: HyperliquidTrafficClass;

  constructor(
    config: ConstructorParameters<typeof HttpTransport>[0],
    trafficClass: HyperliquidTrafficClass = "standard",
  ) {
    super(config);
    this.trafficClass = trafficClass;
  }

  override async request<T>(
    endpoint: "info" | "exchange" | "explorer",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const priority = requestPriority(endpoint, payload, this.trafficClass);
    const timeoutMs = this.timeout;
    await processLocalRestScheduler.acquire(
      estimatedRequestWeight(endpoint, payload),
      priority,
      signal,
      timeoutMs,
      () => new HttpRequestError({
        detail: `Request timed out after ${timeoutMs} ms`,
        cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        request: payload,
      }),
    );
    return await super.request<T>(endpoint, payload, signal);
  }
}

export function hyperliquidRestWeightSnapshot(
  trafficClass: HyperliquidTrafficClass = "standard",
) {
  return processLocalRestScheduler.snapshot(
    hyperliquidRestBudget("info", trafficClass),
  );
}

/** A safe, non-secret description of one partition that was not read. */
export interface HyperliquidReadFailure {
  source: string;
  transient: boolean;
  status?: number;
}

/**
 * The open-order rows plus the coverage needed by callers that infer absence.
 * `error` is retained only so the legacy throwing methods can preserve their
 * existing rejection behavior while newer workers can fail closed per source.
 */
export interface HyperliquidOpenOrdersSnapshot<T> {
  orders: T[];
  coveredDexes: string[];
  complete: boolean;
  failures: HyperliquidReadFailure[];
  error?: unknown;
}

const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ERR_NETWORK",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numericStatus(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 999
  ) {
    return value;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    const status = Number(value);
    return status >= 100 && status <= 999 ? status : undefined;
  }
  return undefined;
}

/** Extract only a numeric HTTP status, without copying provider error text. */
export function hyperliquidReadStatus(error: unknown): number | undefined {
  if (error instanceof ApiRequestError || !isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : undefined;
  return (
    numericStatus(response?.status) ??
    numericStatus(response?.statusCode) ??
    numericStatus(error.status) ??
    numericStatus(error.statusCode)
  );
}

/**
 * Classify reads that are safe to retry. API-level rejections and ordinary
 * client errors are deliberately excluded: they are deterministic failures.
 */
export function isTransientHyperliquidReadError(error: unknown): boolean {
  if (error instanceof ApiRequestError) return false;

  const httpRequestError =
    error instanceof HttpRequestError ||
    (isRecord(error) && error.name === "HttpRequestError");
  const status = hyperliquidReadStatus(error);
  if (status !== undefined) {
    if (status === 408 || status === 429 || (status >= 500 && status < 600))
      return true;
    // The SDK uses HttpRequestError for a malformed 2xx response as well as
    // transport failures. A successful status does not make invalid JSON safe
    // to treat as a definitive read.
    return httpRequestError && status >= 200 && status < 300;
  }

  if (httpRequestError) return true;
  if (!isRecord(error)) return false;

  const cause = isRecord(error.cause) ? error.cause : undefined;
  const codeValue = error.code ?? cause?.code;
  const code = typeof codeValue === "string" ? codeValue.toUpperCase() : "";
  if (TRANSIENT_TRANSPORT_CODES.has(code)) return true;

  const nameValue = error.name ?? cause?.name;
  const name = typeof nameValue === "string" ? nameValue : "";
  if (name === "AbortError") return false;
  if (name === "HttpRequestError" || name === "TimeoutError") return true;

  const messageParts = [error.message, cause?.message].filter(
    (value): value is string => typeof value === "string",
  );
  const message = messageParts.join(" ");
  return /fetch failed|network|socket|timed? ?out|unreachable|connection reset|connection refused/i.test(
    message,
  );
}

function retryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  const headers = error.response.headers;
  let raw: string | null | undefined;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get(name: string): string | null }).get("retry-after");
  } else if (isRecord(headers)) {
    const lower = headers["retry-after"] ?? headers["Retry-After"];
    raw = typeof lower === "string" ? lower : undefined;
  }
  if (!raw) return undefined;

  const value = raw.trim();
  const seconds = Number(value);
  if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(seconds)) {
    return Math.min(READ_MAX_DELAY_MS, Math.ceil(seconds * 1_000));
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(READ_MAX_DELAY_MS, Math.max(0, timestamp - Date.now()));
}

function waitForReadRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new Error("read retry aborted"));
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(signal?.reason ?? new Error("read retry aborted"));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bounded retry policy for idempotent InfoClient reads only. */
export async function retryHyperliquidRead<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt <= READ_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      // A 429 is the shared IP bucket telling every caller to stop. Retrying the
      // same weighted request inside this helper only makes that bucket more
      // negative and creates a synchronized retry storm across worker loops.
      // Scheduled pollers will naturally try again on their next cycle.
      if (hyperliquidReadStatus(error) === 429) throw error;
      if (
        attempt === READ_MAX_ATTEMPTS ||
        signal?.aborted ||
        !isTransientHyperliquidReadError(error)
      ) {
        throw error;
      }

      const exponential = Math.min(
        READ_MAX_DELAY_MS,
        READ_INITIAL_DELAY_MS * 2 ** (attempt - 1),
      );
      const delay = Math.min(
        READ_MAX_DELAY_MS,
        retryAfterMs(error) ?? Math.floor(exponential * (0.5 + Math.random())),
      );
      await waitForReadRetry(delay, signal);
    }
  }

  throw new Error("unreachable");
}

/** The DEX namespace in a canonical HL coin (`xyz:JPY` -> `xyz`). */
/**
 * Did this snapshot actually read the dex `coin` lives on?
 *
 * False means "we do not know", never "the account is flat there". Anything that
 * acts on a position must treat those differently: refusing to open is safe,
 * whereas reading an unread HIP-3 market as flat can net against a live position
 * or spend a one-shot close on a position that is still open.
 */
export function isPerpDexCovered(
  coveredDexes: readonly string[],
  coin: string,
): boolean {
  return coveredDexes.includes(perpDexName(coin));
}

export function perpDexName(coin: string): string {
  const separator = coin.indexOf(":");
  return separator > 0 ? coin.slice(0, separator) : "";
}

type PerpMetaUniverseLike = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: true;
  marginMode?: "strictIsolated" | "noCross";
  isDelisted?: true;
};

/**
 * Flatten `allPerpMetas()` into the coin cache used for order/cancel actions.
 * Main-DEX assets use their local universe index. HIP-3 assets use
 * `100000 + perpDexIndex * 10000 + indexInMeta`, per Hyperliquid's spec.
 */
export function buildPerpAssetCache(
  metas: readonly { universe: readonly PerpMetaUniverseLike[] }[],
): Map<string, PerpAssetMeta> {
  const cache = new Map<string, PerpAssetMeta>();
  metas.forEach((meta, perpDexIndex) => {
    meta.universe.forEach((asset, indexInMeta) => {
      const dex = perpDexName(asset.name);
      const assetIndex =
        perpDexIndex === 0
          ? indexInMeta
          : HIP3_ASSET_ID_BASE +
            perpDexIndex * HIP3_DEX_ASSET_STRIDE +
            indexInMeta;
      cache.set(asset.name, {
        coin: asset.name,
        assetIndex,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
        dex,
        isolatedOnly:
          asset.onlyIsolated === true ||
          asset.marginMode === "noCross" ||
          asset.marginMode === "strictIsolated",
        isDelisted: asset.isDelisted ?? false,
      });
    });
  });
  return cache;
}

/**
 * Convert an arbitrary idempotency key (e.g. `orders.clientOrderId`) into a
 * deterministic HL `cloid`: a 0x-prefixed 16-byte (128-bit) hex string, which
 * the SDK requires to be exactly 34 chars (`0x` + 32 hex). Deterministic so a
 * retried submit reuses the same cloid → HL dedupes broker-side.
 */
export function toCloid(seed: string): `0x${string}` {
  // keccak256 → 32 bytes; take the first 16 bytes (34-char string) for the cloid.
  const hash = keccak256(stringToHex(seed));
  return `0x${hash.slice(2, 34)}` as `0x${string}`;
}

/**
 * Clamp a requested leverage to `[1, maxLeverage]` and floor to an integer.
 * HL requires an integer leverage ≥ 1; the per-asset cap comes from
 * `meta().universe[].maxLeverage`.
 */
export function clampLeverage(requested: number, maxLeverage: number): number {
  const cap = Math.max(1, Math.floor(maxLeverage));
  const floored = Math.floor(requested);
  if (!Number.isFinite(floored) || floored < 1) return 1;
  return Math.min(floored, cap);
}

/**
 * Case-insensitive membership check: is `agentAddress` among the approved
 * agents returned by HL `extraAgents`? EVM addresses are compared lowercased so
 * a checksummed stored address matches an all-lowercase HL response (and vice
 * versa). Pure + exported so `markAgentRegistered` can verify agent approval
 * without a live client, and so it is unit-testable in isolation.
 */
export function isAgentApproved(
  agents: ReadonlyArray<{ address: string }>,
  agentAddress: string,
): boolean {
  const target = agentAddress.toLowerCase();
  return agents.some((a) => a.address.toLowerCase() === target);
}

/**
 * Compute an aggressive IoC limit price that simulates a market order:
 * buys pay up, sells hit down, by `slippage` fraction. Truncated to the
 * asset's tick rules via `formatPrice`.
 *
 * CROSS INVARIANT: `formatPrice` truncates with ROUND_DOWN. On a coarse-tick
 * asset (low price, high szDecimals) the downward truncation can erase the whole
 * slippage buffer, so a BUY rounds to — or below — the mark and the IoC order
 * never crosses (it cancels with zero fill, or a market-trigger rests passively).
 * We therefore verify the formatted price strictly crosses the formatted mark and,
 * if it doesn't, widen the buffer until it does. Since the order is IoC it fills
 * at the book, not at this limit, so an extra-aggressive cap is safe — it only
 * guarantees the cross. Bounded iteration; falls back to the last price computed.
 */
export function aggressivePrice(
  markPrice: string | number,
  side: PerpSide,
  szDecimals: number,
  slippage: number = DEFAULT_SLIPPAGE,
): string {
  const mid = typeof markPrice === "string" ? parseFloat(markPrice) : markPrice;
  const markRef = parseFloat(formatPrice(mid, szDecimals));
  const crosses = (px: string) =>
    side === "long" ? parseFloat(px) > markRef : parseFloat(px) < markRef;

  let mult = slippage;
  let px = formatPrice(
    side === "long" ? mid * (1 + mult) : mid * (1 - mult),
    szDecimals,
  );
  // Double the buffer until the truncated price strictly crosses the mark. In
  // practice this resolves in 0–2 iterations; the cap is a safety backstop.
  for (let i = 0; i < 16 && !crosses(px); i++) {
    mult *= 2;
    px = formatPrice(
      side === "long" ? mid * (1 + mult) : mid * (1 - mult),
      szDecimals,
    );
  }
  return px;
}

/**
 * Pure predicate: is `symbol` a tradable perp on the given HL meta universe?
 *
 * Case-insensitive on the coin symbol (HL universe names are uppercase, e.g.
 * "BTC"); surrounding whitespace is trimmed. A DELISTED asset is NOT tradable
 * even though it stays in the universe (its index is retained for stable
 * lookups). Pure + exported so a caller can gate a symbol against a cached
 * `getUniverse()` result with no live client, and so it is unit-testable
 * without the network.
 *
 * NOTE: intentional groundwork with no caller yet. It backs the deferred
 * "cross-reference which signal tickers are tradable on HL" task (HL7 follow-up);
 * wire it into the signal/watchlist surface when that lands.
 */
export function isTradableOnHl(
  universe: ReadonlyArray<Pick<PerpAssetMeta, "coin" | "isDelisted">>,
  symbol: string,
): boolean {
  const target = symbol.trim().toUpperCase();
  if (target === "") return false;
  return universe.some((a) => a.coin.toUpperCase() === target && !a.isDelisted);
}

/**
 * The `portfolio` periods whose `accountValueHistory` describes the WHOLE
 * account. Its `perpDay`/`perpWeek`/`perpMonth`/`perpAllTime` twins carry
 * perp-only equity: on a live unified account those read $1,113 against a
 * $35,086 account, so reading one as the total silently drops the spot side.
 */
const PORTFOLIO_ACCOUNT_PERIODS: ReadonlySet<string> = new Set([
  "day",
  "week",
  "month",
  "allTime",
]);

/** One `[period, data]` entry of an HL `portfolio` response. */
type PortfolioPeriodEntry = readonly [
  period: string,
  data: { accountValueHistory: readonly (readonly [number, string])[] },
];

/**
 * Newest whole-account value in an HL `portfolio` response, or null when no
 * period carries a usable point. Pure + exported so the period filtering is
 * testable without the network.
 *
 * Every whole-account period ends on the same freshly-computed point, so this
 * takes the newest across all of them rather than trusting one to be present:
 * that way a missing or empty `day` cannot turn a funded account into null.
 */
export function latestPortfolioAccountValue(
  portfolio: readonly PortfolioPeriodEntry[],
): string | null {
  let newest: { timestamp: number; value: string } | null = null;
  for (const [period, data] of portfolio) {
    if (!PORTFOLIO_ACCOUNT_PERIODS.has(period)) continue;
    const history = data?.accountValueHistory;
    if (!history?.length) continue;
    const [timestamp, value] = history[history.length - 1]!;
    // HL types the value as a decimal string; keep it verbatim rather than
    // round-tripping through Number and losing precision on large accounts.
    if (!Number.isFinite(Number(value))) continue;
    if (!newest || timestamp > newest.timestamp) newest = { timestamp, value };
  }
  return newest?.value ?? null;
}

/** A trigger leg that setPositionTpSl successfully placed (LIVE on-chain). */
export interface PlacedTpSlLeg {
  kind: "sl" | "tp";
  cloid?: string;
  result: unknown;
}

/**
 * Thrown by `setPositionTpSl` when an earlier leg was accepted (LIVE on-chain)
 * but a later leg failed. Carries the placed legs so the caller can surface them
 * to the user and reconcile, rather than treating the whole call as a clean
 * failure and silently orphaning a live stop-loss.
 */
export class TpSlPartialError extends Error {
  readonly placed: PlacedTpSlLeg[];
  readonly failedLeg: "sl" | "tp";
  override readonly cause: unknown;
  constructor(failedLeg: "sl" | "tp", placed: PlacedTpSlLeg[], cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `TP/SL partially applied: ${placed
        .map((p) => p.kind.toUpperCase())
        .join(
          "+",
        )} placed, but the ${failedLeg.toUpperCase()} leg failed: ${causeMsg}`,
    );
    this.name = "TpSlPartialError";
    this.placed = placed;
    this.failedLeg = failedLeg;
    this.cause = cause;
  }
}

function makeReadFailure(
  source: string,
  error: unknown,
): HyperliquidReadFailure {
  const status = hyperliquidReadStatus(error);
  return {
    source,
    transient: isTransientHyperliquidReadError(error),
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Hyperliquid can resolve an order request successfully at the transport layer
 * while rejecting an individual order in `response.data.statuses`. Callers
 * need to distinguish that definitive broker rejection from an ambiguous
 * timeout, where the order may already be live.
 */
export class HyperliquidOrderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidOrderRejectedError";
  }
}

/**
 * Thrown when a coin is absent from the cached perp universe.
 *
 * Carries a `code` on purpose. An automated caller classifies a failure as
 * retryable or not from the error's shape, and a bare `Error` has neither a
 * status nor a code, which lands in the deliberate fail-safe ("unknown shape,
 * assume transient") that background retry queues use. An unlisted coin is
 * never transient: it is a permanent property of the symbol, so requeueing it
 * means requeueing it forever. That exact mistake already burned production on
 * the equity side (see `statusFromMessage` in the copy-mirror service).
 */
export class HyperliquidUnknownCoinError extends Error {
  readonly code = "HL_UNKNOWN_COIN";
  readonly coin: string;

  constructor(coin: string) {
    super(`Unknown Hyperliquid coin: ${coin}`);
    this.name = "HyperliquidUnknownCoinError";
    this.coin = coin;
  }
}

/**
 * Thrown when an order fails before the SDK reaches its HTTP transport. These
 * failures (formatting, validation, serialization, or wallet signing) are
 * definite non-submissions and are safe for callers to persist as rejected.
 */
export class HyperliquidOrderPreparationError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "HyperliquidOrderPreparationError";
    this.cause = cause;
  }
}

function topLevelRejectionMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const topLevelStatus = Reflect.get(result, "status");
  const response = Reflect.get(result, "response");
  if (topLevelStatus === "err") {
    return typeof response === "string" && response.trim() !== ""
      ? response
      : "Hyperliquid rejected the order.";
  }
  return undefined;
}

function orderRejectionMessage(result: unknown): string | undefined {
  const topLevelRejection = topLevelRejectionMessage(result);
  if (topLevelRejection) return topLevelRejection;
  if (typeof result !== "object" || result === null) return undefined;
  const response = Reflect.get(result, "response");
  if (typeof response !== "object" || response === null) return undefined;
  const data = Reflect.get(response, "data");
  if (typeof data !== "object" || data === null) return undefined;
  const statuses = Reflect.get(data, "statuses");
  if (!Array.isArray(statuses)) return undefined;

  for (const status of statuses) {
    if (typeof status !== "object" || status === null) continue;
    const error = Reflect.get(status, "error");
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return undefined;
}

/**
 * Public config for the wrapper. The viem `wallet` is injected (Privy-backed
 * in production, a throwaway `privateKeyToAccount` in tests) so the client is
 * testable without binding to Privy.
 */
export interface HyperliquidClientConfig {
  network: HyperliquidNetwork;
  /** Operational priority used by the shared rolling REST limiter. */
  trafficClass?: HyperliquidTrafficClass;
  /**
   * Signing wallet for the ExchangeClient (agent wallet in production). Omit
   * for a read-only client — trading methods then throw.
   */
  wallet?: AbstractWallet;
  /** Builder code attached to every order. Required for order placement. */
  builder?: BuilderCode;
  /** Reuse an existing transport (share one across clients). */
  transport?: HttpTransport;
}

/**
 * Thin wrapper over `@nktkas/hyperliquid` mirroring `@trade-bot/alpaca`'s
 * `AlpacaClient`. Centralizes: coin→assetIndex resolution (cached from meta),
 * szDecimals/tick rounding, deterministic cloid generation, leverage clamping,
 * and builder-code attachment.
 */
/**
 * Render a computed USD figure as the decimal string the sizing helpers parse.
 * Fixed precision rather than exponential notation, because `Number()` on an
 * exponential string is fine but every downstream log and DB column reads
 * better as a plain decimal.
 */
function formatUsdAmount(value: number): string {
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export class HyperliquidClient {
  private readonly network: HyperliquidNetwork;
  private readonly builder?: BuilderCode;
  private readonly transport: HttpTransport;
  private readonly info: InfoClient;
  private readonly exchange?: ExchangeClient;

  /** coin → { assetIndex, szDecimals, maxLeverage } cache from `meta()`. */
  private assetCache: Map<string, PerpAssetMeta> | null = null;
  private assetCacheLoadedAt = 0;

  constructor(config: HyperliquidClientConfig) {
    this.network = HyperliquidNetworkSchema.parse(config.network);
    this.builder = config.builder
      ? BuilderCodeSchema.parse(config.builder)
      : undefined;
    this.transport =
      config.transport ??
      new RateLimitedHyperliquidTransport({
        isTestnet: isTestnet(this.network),
      }, config.trafficClass);
    this.info = new InfoClient({ transport: this.transport });
    if (config.wallet) {
      this.exchange = new ExchangeClient({
        transport: this.transport,
        wallet: config.wallet,
      });
    }
  }

  private requireExchange(): ExchangeClient {
    if (!this.exchange) {
      throw new Error(
        "HyperliquidClient was constructed without a signing wallet; trading methods are unavailable.",
      );
    }
    return this.exchange;
  }

  // -------------------------------------------------------------------------
  // Market data / metadata (keyless InfoClient)
  // -------------------------------------------------------------------------

  /**
   * Load and cache the perp universe. Returns the map of coin → asset meta.
   * Delisted assets are still cached (so index lookups remain stable) but
   * flagged `isDelisted`.
   */
  async loadMeta(
    force = false,
    signal?: AbortSignal,
  ): Promise<Map<string, PerpAssetMeta>> {
    if (
      this.assetCache &&
      !force &&
      (this.assetCacheLoadedAt === 0 ||
        Date.now() - this.assetCacheLoadedAt < META_CACHE_TTL_MS)
    ) {
      return this.assetCache;
    }
    const metas = await retryHyperliquidRead(
      () => this.info.allPerpMetas(signal),
      signal,
    );
    const cache = buildPerpAssetCache(metas);
    this.assetCache = cache;
    this.assetCacheLoadedAt = Date.now();
    return cache;
  }

  /** Full universe list (for symbol pickers / leverage caps). */
  async getUniverse(signal?: AbortSignal): Promise<PerpAssetMeta[]> {
    const cache = await this.loadMeta(false, signal);
    return [...cache.values()];
  }

  /**
   * Resolve a coin to its cached asset meta. Loads meta on first use.
   * @throws if the coin is unknown.
   */
  async resolveAsset(
    coin: string,
    signal?: AbortSignal,
  ): Promise<PerpAssetMeta> {
    const cache = await this.loadMeta(false, signal);
    const asset = cache.get(coin);
    if (!asset) {
      throw new HyperliquidUnknownCoinError(coin);
    }
    return asset;
  }

  /** Convenience: resolve just the numeric asset index. */
  async resolveAssetIndex(coin: string): Promise<number> {
    return (await this.resolveAsset(coin)).assetIndex;
  }

  /** All mids keyed by coin. */
  async allMids(
    coin?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const dex = coin ? perpDexName(coin) : "";
    return await retryHyperliquidRead(
      () => this.info.allMids(dex ? { dex } : undefined, signal),
      signal,
    );
  }

  /** Candle snapshot for the perp chart datafeed. */
  async candleSnapshot(
    params: {
      coin: string;
      interval:
        | "1m"
        | "3m"
        | "5m"
        | "15m"
        | "30m"
        | "1h"
        | "2h"
        | "4h"
        | "8h"
        | "12h"
        | "1d"
        | "3d"
        | "1w"
        | "1M";
      startTime: number;
      endTime?: number;
    },
    signal?: AbortSignal,
  ): Promise<PerpCandle[]> {
    return await retryHyperliquidRead(
      () =>
        this.info.candleSnapshot(
          {
            coin: params.coin,
            interval: params.interval,
            startTime: params.startTime,
            ...(params.endTime !== undefined
              ? { endTime: params.endTime }
              : {}),
          },
          signal,
        ),
      signal,
    );
  }

  /** Keyless completed-candle history used by forward-return measurements. */
  async candleHistory(
    params: {
      coin: string;
      startTime: number;
      endTime?: number;
    },
    signal?: AbortSignal,
  ): Promise<PerpCandle[]> {
    return this.candleSnapshot(
      {
        coin: params.coin,
        interval: "1d",
        startTime: params.startTime,
        ...(params.endTime !== undefined ? { endTime: params.endTime } : {}),
      },
      signal,
    );
  }

  /**
   * Live market snapshot for a single coin: mark / mid / oracle / prevDay
   * prices, funding, 24h volume (from `metaAndAssetCtxs`), plus top-of-book
   * bid/ask (from `l2Book`). Keyless / read-only, so it powers the perps header
   * strip without a wallet. The coin is matched case-insensitively against the
   * universe (HL spells the 1000x coins with a lowercase `k`, e.g. `kPEPE`), and
   * the returned `coin` is HL's canonical spelling. Throws for an unknown coin.
   */
  async assetSnapshot(coin: string): Promise<PerpAssetSnapshot> {
    const dex = perpDexName(coin);
    const [meta, assetCtxs] = await retryHyperliquidRead(() =>
      this.info.metaAndAssetCtxs(dex ? { dex } : undefined),
    );
    const target = coin.toLowerCase();
    const index = meta.universe.findIndex(
      (asset) => asset.name.toLowerCase() === target,
    );
    const asset = index === -1 ? undefined : meta.universe[index];
    if (!asset) {
      throw new HyperliquidUnknownCoinError(coin);
    }
    const canonicalCoin = asset.name;
    // A brand-new / illiquid market can have an empty book; tolerate that and
    // fall back to null bid/ask rather than failing the whole snapshot.
    const book = await retryHyperliquidRead(() =>
      this.info.l2Book({ coin: canonicalCoin }),
    ).catch(() => null);
    return buildPerpAssetSnapshot(
      canonicalCoin,
      assetCtxs[index] ?? null,
      book,
      {
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
        isolatedOnly:
          asset.onlyIsolated === true ||
          asset.marginMode === "noCross" ||
          asset.marginMode === "strictIsolated",
      },
    );
  }

  /**
   * Depth-limited L2 order book for one coin (keyless / read-only).
   *
   * `assetSnapshot` already reads this endpoint but keeps only the top of each
   * side, so a caller that wants the ladder had to refetch. This returns the
   * levels themselves: both sides best-first, capped at `depth` per side.
   *
   * The coin is resolved case-insensitively against the cached universe (HL
   * spells the 1000x coins with a lowercase `k`, e.g. `kPEPE`), which also
   * covers HIP-3 markets (`xyz:JPY`) because the cache spans every perp DEX.
   * The universe read is memoized behind `loadMeta`'s TTL, so a polling caller
   * costs one `l2Book` request per tick and not a metadata fan-out. An unknown
   * coin throws `HyperliquidUnknownCoinError`.
   *
   * A FAILED read throws rather than degrading to empty sides. Here the book is
   * the whole payload, so swallowing the error would render "no resting depth"
   * during an outage, which reads as a market with no liquidity rather than as
   * a venue we could not reach. That is the opposite of what a trader needs.
   * `assetSnapshot` still degrades on purpose: there the book only enriches a
   * snapshot with a top-of-book price, so the rest stays useful without it.
   * A successful response that carries no levels is still an empty book, not an
   * error, and `buildPerpL2Book` handles it.
   */
  async l2Book(
    coin: string,
    depth: number = PERP_L2_BOOK_DEFAULT_DEPTH,
  ): Promise<PerpL2Book> {
    const cache = await this.loadMeta();
    const target = coin.toLowerCase();
    let resolved = cache.get(coin)?.coin;
    if (!resolved) {
      for (const name of cache.keys()) {
        if (name.toLowerCase() === target) {
          resolved = name;
          break;
        }
      }
    }
    if (!resolved) {
      throw new HyperliquidUnknownCoinError(coin);
    }
    const canonicalCoin = resolved;
    const book = await retryHyperliquidRead(() =>
      this.info.l2Book({ coin: canonicalCoin }),
    );
    return buildPerpL2Book(canonicalCoin, book, depth);
  }

  /** Ensure the agent's principal uses an account mode that can trade HIP-3. */
  async ensureDexAbstraction(
    user: `0x${string}`,
    options: {
      waitForPropagation?: () => Promise<void>;
      maxReadyChecks?: number;
    } = {},
  ): Promise<void> {
    const isReady = (mode: Awaited<ReturnType<typeof this.userAbstraction>>) =>
      mode === "unifiedAccount" ||
      mode === "portfolioMargin" ||
      mode === "dexAbstraction";

    if (isReady(await this.userAbstraction(user))) return;

    // Submitting an XYZ order is explicit consent to the one-time account-mode
    // transition. Hyperliquid's current agentSetAbstraction action is designed
    // for an already-approved agent wallet and does not require the principal's
    // private key. This is intentionally different from the deprecated
    // agentEnableDexAbstraction action, which could fail with "transition not
    // allowed" on current accounts.
    let transitionError: unknown = null;
    try {
      const transitionResult = await this.requireExchange().agentSetAbstraction(
        {
          abstraction: "u",
        },
      );
      const rejection = topLevelRejectionMessage(transitionResult);
      if (rejection) transitionError = new Error(rejection);
    } catch (error) {
      transitionError = error;
    }

    const waitForPropagation =
      options.waitForPropagation ??
      (() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
    const maxReadyChecks = options.maxReadyChecks ?? 20;
    let lastReadError: unknown = null;

    for (let attempt = 0; attempt < maxReadyChecks; attempt += 1) {
      try {
        if (isReady(await this.userAbstraction(user))) return;
      } catch (error) {
        lastReadError = error;
      }
      if (attempt < maxReadyChecks - 1) await waitForPropagation();
    }

    if (transitionError) {
      const detail =
        transitionError instanceof Error
          ? transitionError.message
          : String(transitionError);
      throw new Error(
        `Hyperliquid could not enable unified account mode with the approved trading agent: ${detail}`,
      );
    }

    const readDetail =
      lastReadError instanceof Error ? ` (${lastReadError.message})` : "";
    throw new Error(
      `Hyperliquid accepted the unified-account update, but it is not visible yet${readDetail}. Try the order again in a moment.`,
    );
  }

  /** Current account-abstraction mode for a master address. */
  async userAbstraction(address: `0x${string}`) {
    return await retryHyperliquidRead(() =>
      this.info.userAbstraction({ user: address }),
    );
  }

  /**
   * USD COLLATERAL balance: the capital that can back a new order. Unified
   * accounts keep their USDC balance in spot state; legacy/default modes keep
   * it in perp state.
   *
   * This is NOT the account's total value, and callers that present "what the
   * user has on Hyperliquid" want `accountEquityUsd()` instead. What it leaves
   * out, by design:
   *   - unifiedAccount: every non-USDC spot asset.
   *   - portfolioMargin: every spot asset that is not eligible collateral.
   *   - default: the spot balance entirely (that mode keeps spot and perp
   *     balances separate) and every HIP-3 DEX's own balance.
   *
   * It does NOT leave out unrealized perp PnL. See `accountEquityUsd()` for the
   * measurements behind that, which are the opposite of the intuitive guess.
   */
  async accountBalanceUsd(address: `0x${string}`): Promise<string> {
    const abstraction = await this.userAbstraction(address);
    if (abstraction === "unifiedAccount") {
      const state = await retryHyperliquidRead(() =>
        this.info.spotClearinghouseState({ user: address }),
      );
      return (
        state.balances.find((balance) => balance.coin === "USDC")?.total ?? "0"
      );
    }
    if (abstraction === "portfolioMargin") {
      const [state, reserveStates] = await Promise.all([
        retryHyperliquidRead(() =>
          this.info.spotClearinghouseState({ user: address }),
        ),
        retryHyperliquidRead(() => this.info.allBorrowLendReserveStates()),
      ]);
      const reserveByToken = new Map(
        reserveStates.map(([token, reserve]) => [token, reserve]),
      );

      const collateralUsd = state.balances.reduce((total, balance) => {
        if (!("token" in balance)) return total;
        const coin = balance.coin.toUpperCase();
        const reserve = reserveByToken.get(balance.token);
        const reserveLtv = Number(reserve?.ltv);
        const isEligible =
          coin === "USDC" ||
          coin === "USDH" ||
          (Number.isFinite(reserveLtv) && reserveLtv > 0);
        const amount = Number(balance.total);
        const usdPrice = Number(reserve?.oraclePx);
        if (
          !isEligible ||
          !Number.isFinite(amount) ||
          !Number.isFinite(usdPrice) ||
          usdPrice <= 0
        ) {
          return total;
        }
        return total + amount * usdPrice;
      }, 0);

      return collateralUsd.toFixed(8).replace(/\.?0+$/, "") || "0";
    }
    const state = await this.clearinghouseState(address);
    return state.marginSummary.accountValue;
  }

  /**
   * FREE COLLATERAL that can back a new perp order, read from the ledger that
   * actually holds it for this account's abstraction mode.
   *
   * Why this exists rather than `crossMarginSummary.accountValue -
   * crossMarginSummary.totalMarginUsed`: under unified account and portfolio
   * margin the collateral moved to spot, and Hyperliquid says so on the perp
   * info endpoint itself ("Under unified account or portfolio margin, use spot
   * balances endpoint instead", and "Individual perp dex user states are not
   * meaningful"). The perp summary still REPORTS an accountValue, and it still
   * reports the full totalMarginUsed, so subtracting one from the other
   * subtracts a real liability from a balance that no longer contains the
   * asset. Measured on a live mainnet unified account, that subtraction
   * returned about -1,146,830 where the true free figure was about +2,010,430.
   *
   * The spot `hold` field is the key. On that same account it matched the perp
   * `totalMarginUsed` to the cent, which is what makes this simple: `hold`
   * already reflects margin committed across EVERY dex, so there is no need to
   * fetch and sum per-dex margin figures. `total - hold` is the whole answer.
   *
   * Returns null when the answer cannot be established: an unreadable mode, a
   * missing USDC balance, or unparseable numbers. Null MUST be treated by the
   * caller as "do not size an order", never as zero and never as a reason to
   * fall back to the perp summary. Overstating collateral opens leveraged
   * exposure the account cannot support, which is strictly worse than the bug
   * this replaces (that one failed closed and merely skipped every mirror).
   */
  async perpCollateral(address: `0x${string}`): Promise<PerpCollateral | null> {
    const abstraction = await this.userAbstraction(address);

    if (abstraction === "unifiedAccount") {
      const state = await retryHyperliquidRead(() =>
        this.info.spotClearinghouseState({ user: address }),
      );
      const usdc = state.balances.find((balance) => balance.coin === "USDC");
      if (!usdc) return null;
      const total = Number(usdc.total);
      // `hold` is absent on some responses. Absent is not zero: reading it as
      // zero would report every committed dollar as free.
      const hold = Number(usdc.hold ?? Number.NaN);
      if (!Number.isFinite(total) || !Number.isFinite(hold)) return null;
      return {
        freeUsd: formatUsdAmount(total - hold),
        accountValueUsd: formatUsdAmount(total),
        source: "spot-unified",
      };
    }

    if (abstraction === "portfolioMargin") {
      const [state, reserveStates] = await Promise.all([
        retryHyperliquidRead(() =>
          this.info.spotClearinghouseState({ user: address }),
        ),
        retryHyperliquidRead(() => this.info.allBorrowLendReserveStates()),
      ]);
      const reserveByToken = new Map(
        reserveStates.map(([token, reserve]) => [token, reserve]),
      );

      let freeUsd = 0;
      let totalUsd = 0;
      let sawEligible = false;
      for (const balance of state.balances) {
        if (!("token" in balance)) continue;
        const coin = balance.coin.toUpperCase();
        const reserve = reserveByToken.get(balance.token);
        const reserveLtv = Number(reserve?.ltv);
        const isEligible =
          coin === "USDC" ||
          coin === "USDH" ||
          (Number.isFinite(reserveLtv) && reserveLtv > 0);
        if (!isEligible) continue;

        const amount = Number(balance.total);
        const hold = Number(balance.hold ?? Number.NaN);
        // USDC and USDH are the quote assets and price at 1 by definition; only
        // the borrow-lend collateral needs an oracle price.
        const usdPrice =
          coin === "USDC" || coin === "USDH" ? 1 : Number(reserve?.oraclePx);
        if (
          !Number.isFinite(amount) ||
          !Number.isFinite(hold) ||
          !Number.isFinite(usdPrice) ||
          usdPrice <= 0
        ) {
          // One unreadable eligible balance makes the total unknowable. Fail the
          // whole read rather than silently sizing against a partial pool.
          return null;
        }
        sawEligible = true;
        freeUsd += (amount - hold) * usdPrice;
        totalUsd += amount * usdPrice;
      }
      if (!sawEligible) return null;
      return {
        freeUsd: formatUsdAmount(freeUsd),
        accountValueUsd: formatUsdAmount(totalUsd),
        source: "spot-portfolio-margin",
      };
    }

    // Default / standard abstraction genuinely keeps perp collateral in the perp
    // clearinghouse state, so the original read is correct here and is kept
    // verbatim. Note this branch is per-dex: for a HIP-3 coin on a standard
    // account the main-dex summary does not fund it, which is precisely why
    // `isDexAbstractionReady` refuses standard mode for dex-prefixed coins.
    const state = await this.clearinghouseState(address);
    const crossValue = Number(state.crossMarginSummary.accountValue);
    const marginUsed = Number(state.crossMarginSummary.totalMarginUsed);
    // The two fields come from DIFFERENT summaries on purpose.
    //
    // `freeUsd` is what can back a new order, so it nets committed margin out of
    // the CROSS summary, which is the pool a cross-margin order draws on.
    //
    // `accountValueUsd` is the `pct_equity` sizing base, meaning "how much is
    // this account worth", and it reads `marginSummary` instead.
    // `crossMarginSummary.accountValue` excludes equity locked in ISOLATED
    // positions, so using it here made the base shrink every time the follower
    // opened an isolated position: the same follow row would size a smaller
    // mirror after each one, for no reason the user could see. The unified and
    // portfolio-margin branches above already keep committed margin in their
    // equity base; this branch was the odd one out.
    const totalValue = Number(state.marginSummary.accountValue);
    if (
      !Number.isFinite(crossValue) ||
      !Number.isFinite(marginUsed) ||
      !Number.isFinite(totalValue)
    ) {
      return null;
    }
    return {
      freeUsd: formatUsdAmount(crossValue - marginUsed),
      accountValueUsd: formatUsdAmount(totalValue),
      source: "perp-cross-margin",
    };
  }

  /**
   * TOTAL USD value of everything the address holds on Hyperliquid: spot
   * balances plus perp equity (which carries unrealized PnL) across the main
   * DEX and every HIP-3 DEX. This is the number a cross-venue portfolio total
   * or an account-value header wants. For the capital that can back a NEW
   * order, use `accountBalanceUsd()`.
   *
   * Read from HL's own `portfolio` account-value series rather than assembled
   * per abstraction mode, for two measured reasons.
   *
   * FIRST, the intuitive assembly is wrong. "Equity = collateral + unrealized
   * PnL" holds for no mode here, because in unifiedAccount and portfolioMargin
   * the spot USDC balance ALREADY moves with unrealized PnL, so adding it
   * double-counts. Polled against live mainnet accounts in each mode at 12s
   * intervals, every sample in which no fill landed had the USDC balance and
   * summed unrealized PnL move by the same amount to four decimals:
   *
   *   unifiedAccount  0x2e0e..ffdf  d(USDC) -2.3980  d(uPnL) -2.3980
   *   unifiedAccount  0xf604..1615  d(USDC) 27.5606  d(uPnL) 27.5606
   *   portfolioMargin 0xe863..8bb8  d(USDC) 324.6679 d(uPnL) 324.6665
   *   portfolioMargin 0x75bf..6d9a  d(USDC) 23.0054  d(uPnL) 23.0054
   *
   * SECOND, what `accountBalanceUsd()` actually misses is spot assets, and the
   * gap is large: sampled against HL's own reported account value, a unified
   * account holding non-USDC spot read 88.9% low ($3.9k against $35.1k), and a
   * portfolio-margin account with ineligible spot read 59.1% low ($11.9k
   * against $29.1k). Pricing arbitrary spot tokens ourselves would mean
   * reimplementing HL's marks across 481 tokens and four quote currencies.
   *
   * The series' last point is computed per request (measured age < 0.5s over
   * 15 accounts), so this is a live number and not a lagging chart tail.
   */
  async accountEquityUsd(address: `0x${string}`): Promise<string> {
    const portfolio = await retryHyperliquidRead(() =>
      this.info.portfolio({ user: address }),
    );
    const equity = latestPortfolioAccountValue(portfolio);
    // A brand-new address still returns a zero-valued series, so an empty one
    // means the shape changed under us. Degrade to collateral rather than
    // reporting a venue the user has funded as having no value at all.
    return equity ?? (await this.accountBalanceUsd(address));
  }

  /**
   * Per-coin market stats for the whole tradable universe across the main DEX
   * and every discovered HIP-3 DEX:
   * mark price, previous-day price (for a client-derived 24h change), 24h
   * notional volume, and max leverage. Drives the HL Markets list's price +
   * 24h-change column. Read-only market data, so no wallet/credential needed.
   */
  async getUniverseStats(): Promise<PerpMarketStat[]> {
    const result = await this.getUniverseStatsWithStatus();
    if (result.unavailableDexes.length > 0) {
      throw new Error(
        `Hyperliquid market stats are incomplete; unavailable DEXes: ${result.unavailableDexes.join(", ")}`,
      );
    }
    return result.stats;
  }

  /**
   * Market stats with explicit DEX coverage. Callers that surface freshness or
   * health should use this method so a failed additive partition is not
   * mistaken for a complete market snapshot.
   */
  async getUniverseStatsWithStatus(): Promise<PerpUniverseStatsResult> {
    const universe = await this.getUniverse();
    const dexes = [
      ...new Set(
        universe
          .filter((asset) => !asset.isDelisted)
          .map((asset) => asset.dex ?? perpDexName(asset.coin)),
      ),
    ];
    const statsByDex = await Promise.allSettled(
      dexes.map(async (dex) => {
        const [meta, assetCtxs] = await retryHyperliquidRead(() =>
          this.info.metaAndAssetCtxs(dex ? { dex } : undefined),
        );
        return buildPerpMarketStats(meta.universe, assetCtxs);
      }),
    );
    const available = statsByDex.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (
      available.length === 0 &&
      statsByDex.some((result) => result.status === "rejected")
    ) {
      throw new Error("Hyperliquid market stats are unavailable");
    }
    return {
      stats: available,
      unavailableDexes: statsByDex.flatMap((result, index) =>
        result.status === "rejected" ? [dexes[index] || "main"] : [],
      ),
    };
  }

  /** Raw clearinghouse state for a master address (positions, PnL, funding). */
  async clearinghouseState(
    address: `0x${string}`,
    dex?: string,
    signal?: AbortSignal,
  ) {
    return await retryHyperliquidRead(
      () =>
        this.info.clearinghouseState(
          {
            user: address,
            ...(dex ? { dex } : {}),
          },
          signal,
        ),
      signal,
    );
  }

  /**
   * Recent user fills for a master address. Consumed by the worker order-sync
   * reconciler to move DB orders to FILLED/PARTIAL and record executed price /
   * size / funding. Read-only (keyless InfoClient) — no signing, no withdrawal.
   */
  async userFills(address: `0x${string}`) {
    return await retryHyperliquidRead(() =>
      this.info.userFills({ user: address }),
    );
  }

  /**
   * Read one order by its deterministic client order id. Unlike an aggregate
   * fills/open-orders snapshot this is authoritative for a handoff: a found
   * terminal order still proves that the earlier POST reached Hyperliquid.
   */
  async orderStatusByClientOrderId(
    address: `0x${string}`,
    clientOrderId: string,
  ) {
    return await retryHyperliquidRead(() =>
      this.info.orderStatus({ user: address, oid: toCloid(clientOrderId) }),
    );
  }

  /** Alias retained for callers that already use the venue endpoint name. */
  async orderStatus(address: `0x${string}`, orderId: string | number) {
    return await retryHyperliquidRead(() =>
      this.info.orderStatus({
        user: address,
        oid: typeof orderId === "number" ? orderId : toCloid(orderId),
      }),
    );
  }

  /**
   * Normalized recent fills (trade history) for a master address. Reads HL
   * `userFills` (keyless InfoClient, read-only) and maps each raw fill to our
   * narrower `PerpFill` shape (see `normalizePerpFill`). HL returns fills newest
   * first; we preserve that order and, when `limit` is given, return only the
   * first `limit` rows. Consumed by the perps trade-history view.
   */
  async listFills(address: `0x${string}`, limit?: number): Promise<PerpFill[]> {
    const raw = await this.userFills(address);
    const fills = raw.map(normalizePerpFill);
    return limit !== undefined && limit >= 0 ? fills.slice(0, limit) : fills;
  }

  /**
   * The HIP-3 dex namespaces to additionally query beyond the main dex (""),
   * from the cached/loaded perp universe. Metadata is part of the coverage
   * proof: a discovery failure must not be represented as an empty universe.
   */
  private async discoverExtraDexesWithStatus(): Promise<{
    dexes: string[];
    error: unknown | null;
  }> {
    try {
      const universe = await this.getUniverse();
      return {
        dexes: [
          ...new Set(
            universe
              .map((asset) => asset.dex ?? perpDexName(asset.coin))
              .filter((dex) => dex.length > 0),
          ),
        ],
        error: null,
      };
    } catch (error) {
      return { dexes: [], error };
    }
  }

  private async readOpenOrdersSnapshot<T>(
    address: `0x${string}`,
    read: (params: { user: `0x${string}`; dex?: string }) => Promise<T[]>,
    requestedDexes?: readonly string[],
  ): Promise<HyperliquidOpenOrdersSnapshot<T>> {
    const discovery = requestedDexes
      ? { dexes: [] as string[], error: null as unknown | null }
      : await this.discoverExtraDexesWithStatus();
    const dexes = requestedDexes
      ? [...new Set(requestedDexes.map((dex) => dex.trim()))]
      : ["", ...discovery.dexes];
    const partitions = await Promise.all(
      dexes.map(
        async (
          dex,
        ): Promise<
          | { dex: string; ok: true; orders: T[] }
          | { dex: string; ok: false; error: unknown }
        > => {
          try {
            const orders = await retryHyperliquidRead(() =>
              read({ user: address, ...(dex ? { dex } : {}) }),
            );
            return { dex, ok: true, orders };
          } catch (error) {
            return { dex, ok: false, error };
          }
        },
      ),
    );

    const orders: T[] = [];
    const coveredDexes: string[] = [];
    const failures: HyperliquidReadFailure[] = [];
    let firstError: unknown | undefined =
      discovery.error === null ? undefined : discovery.error;
    if (discovery.error !== null) {
      failures.push(makeReadFailure("metadata", discovery.error));
    }

    for (const partition of partitions) {
      if (partition.ok) {
        coveredDexes.push(partition.dex);
        orders.push(...partition.orders);
        continue;
      }
      failures.push(makeReadFailure(partition.dex || "main", partition.error));
      if (firstError === undefined) firstError = partition.error;
    }

    return {
      orders,
      coveredDexes,
      complete: failures.length === 0,
      failures,
      ...(firstError !== undefined ? { error: firstError } : {}),
    };
  }

  /**
   * Resting (open) orders for a master address, across the main dex AND every
   * discovered HIP-3 dex. Consumed by the reconciler to detect cancellations:
   * a DB order that is no longer in this list and never filled is treated as
   * CANCELLED. Read-only (keyless InfoClient).
   *
   * A bare `{ user }` request only ever covers the main perp dex; querying
   * every discovered dex is what makes a resting HIP-3 order visible here at
   * all. A failed partition is retained in the status result rather than
   * swallowed into an empty list, because this list is read as proof of absence
   * by the reconciler's CANCELLED verdict. The legacy method still throws on
   * incomplete coverage; workers that can reconcile positive fill evidence use
   * `openOrdersWithStatus` instead.
   */
  async openOrders(address: `0x${string}`, dexes?: readonly string[]) {
    const snapshot = await this.openOrdersWithStatus(address, dexes);
    if (!snapshot.complete) {
      throw (
        snapshot.error ??
        new Error("Hyperliquid open-order snapshot incomplete")
      );
    }
    return snapshot.orders;
  }

  /**
   * Raw open orders plus the DEX partitions that were actually read. This is
   * the fail-closed API for reconciliation callers.
   */
  async openOrdersWithStatus(
    address: `0x${string}`,
    dexes?: readonly string[],
  ): Promise<
    HyperliquidOpenOrdersSnapshot<
      Awaited<ReturnType<InfoClient["openOrders"]>>[number]
    >
  > {
    return await this.readOpenOrdersSnapshot(
      address,
      (params) => this.info.openOrders(params),
      dexes,
    );
  }

  /**
   * Normalized OPEN (resting) orders for a master address, read from HL
   * `frontendOpenOrders` across the main dex AND every discovered HIP-3 dex.
   * Unlike
   * `clearinghouseState` (which returns POSITIONS only), this surfaces the
   * resting trigger ORDERS a user attached to a position (stop-loss /
   * take-profit), which is what lets the UI show a position's TP/SL legs and
   * offer a per-order cancel (a HIP-3 position with an unseen TP/SL leg would
   * otherwise look unprotected and invite a duplicate stop). Read-only (keyless
   * InfoClient), no signing.
   */
  async listOpenOrders(address: `0x${string}`): Promise<PerpOpenOrder[]> {
    const snapshot = await this.listOpenOrdersWithStatus(address);
    if (!snapshot.complete) {
      throw (
        snapshot.error ??
        new Error("Hyperliquid open-order snapshot incomplete")
      );
    }
    return snapshot.orders;
  }

  /** Normalized open orders with per-DEX coverage for best-effort consumers. */
  async listOpenOrdersWithStatus(
    address: `0x${string}`,
    dexes?: readonly string[],
  ): Promise<HyperliquidOpenOrdersSnapshot<PerpOpenOrder>> {
    const snapshot = await this.readOpenOrdersSnapshot(
      address,
      (params) => this.info.frontendOpenOrders(params),
      dexes,
    );
    return { ...snapshot, orders: snapshot.orders.map(mapOpenOrderRow) };
  }

  /**
   * The list of agent wallets currently approved for a master address (HL
   * `extraAgents`). Consumed by `hyperliquid.markAgentRegistered` to verify the
   * stored agent was actually approved on-chain (with the SAME wallet the user
   * enabled with) before flipping the account LIVE. Read-only (keyless
   * InfoClient), no signing.
   */
  async extraAgents(address: `0x${string}`): Promise<ExtraAgent[]> {
    return await retryHyperliquidRead(() =>
      this.info.extraAgents({ user: address }),
    );
  }

  /**
   * Normalized perp positions for a master address, derived from
   * `clearinghouseState`. This is the mapping `positions.listPerps` consumes.
   *
   * Thin wrapper over `perpAccountSnapshot` for the three callers that only
   * want rows. Kept so the real-money copy-mirror and order paths are not
   * churned by a shape change they have no use for.
   */
  async listPositions(address: `0x${string}`, coin?: string): Promise<PerpPosition[]> {
    return (await this.perpAccountSnapshot(
      address, undefined, coin === undefined ? undefined : [perpDexName(coin)],
    )).positions;
  }

  /**
   * Positions PLUS the cross-margin summary, from the same `clearinghouseState`
   * round trip the positions read already makes.
   *
   * The summary is what a "size a percentage of my buying power" control has to
   * be built on, and CROSS is the correct view rather than `marginSummary`.
   * `marginSummary` totals include isolated positions, whose equity is locked
   * to the asset it was allocated to and cannot back a new order, so sizing off
   * it overstates capacity for anyone holding an isolated position. Opening an
   * isolated position draws from this same free cross collateral, so one number
   * serves both margin modes.
   *
   * Note `withdrawable` is deliberately NOT used: per the Hyperliquid docs its
   * rule is `max(initial_margin_required, 0.1 * total_position_value)`, a
   * transfer-specific floor that is stricter than the constraint on opening,
   * so it UNDERSTATES what can be opened whenever a position runs above 10x.
   */
  async perpAccountSnapshot(
    address: `0x${string}`,
    signal?: AbortSignal,
    requestedDexes?: readonly string[],
  ): Promise<{
    positions: PerpPosition[];
    /** Null when the response carried no usable cross summary. */
    crossMargin: PerpCrossMargin | null;
    /**
     * The dexes this snapshot actually READ, "" being the main dex.
     *
     * HIP-3 discovery and the per-dex clearinghouse reads are additive and are
     * deliberately caught so slow metadata cannot hold up ordinary positions.
     * That makes an absent HIP-3 position ambiguous: the account may hold
     * nothing there, or we may simply have failed to look. `positions` alone
     * cannot tell those apart, and for anything that acts on a position the
     * difference is the whole answer.
     *
     * Callers that care must check the candidate coin's dex against this list
     * (see `isPerpDexCovered`) rather than reading a missing position as flat.
     * The main dex is always present, because its failure throws.
     */
    coveredDexes: string[];
  }> {
    // Start the authoritative main request immediately so slow HIP-3 metadata
    // discovery cannot delay ordinary positions. Capture its outcome now to
    // avoid an unhandled rejection while discovery is still in flight.
    const mainStatePromise = this.clearinghouseState(address, undefined, signal).then(
      (state) => ({ ok: true as const, state }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    // HIP-3 discovery is additive. Bound it independently while the
    // authoritative main request is in flight so slow metadata cannot hold the
    // ordinary positions panel behind its retry schedule.
    const universePromise = requestedDexes ? Promise.resolve([] as PerpAssetMeta[]) : this.getUniverse(positionAdditiveSignal(signal)).catch(
      () => [] as PerpAssetMeta[],
    );
    const mainResult = await mainStatePromise;
    if (!mainResult.ok) throw mainResult.error;
    const universe = await universePromise;
    const dexes = [
      "",
      ...new Set(
        (requestedDexes ?? universe
          .map((asset) => asset.dex ?? perpDexName(asset.coin)))
          .filter((dex) => dex.length > 0),
      ),
    ];
    const extraStates = await Promise.all(
      dexes.slice(1).map((dex) =>
        this.clearinghouseState(
          address,
          dex,
          positionAdditiveSignal(signal),
        )
          .then((state) => ({ dex, state }))
          .catch(() => ({ dex, state: null })),
      ),
    );
    const mainState = mainResult.state;
    const states = [
      mainState,
      ...extraStates.flatMap((entry) => (entry.state ? [entry.state] : [])),
    ];
    // "" is unconditional: the main request throws rather than being caught, so
    // reaching here means it succeeded. A dex missing from this list was either
    // never discovered (universe lookup timed out) or failed its own read.
    const coveredDexes = [
      "",
      ...extraStates.flatMap((entry) => (entry.state ? [entry.dex] : [])),
    ];
    // HIP-3 coins include their DEX namespace (for example, `xyz:JPY`), so the
    // canonical coin is unique across the merged main and HIP-3 responses.
    const assetPositions = [
      ...new Map(
        states
          .flatMap((state) => state.assetPositions)
          .map((assetPosition) => [assetPosition.position.coin, assetPosition]),
      ).values(),
    ];
    const representativeCoinByDex = new Map<string, string>();
    for (const { position } of assetPositions) {
      const dex = perpDexName(position.coin);
      if (!representativeCoinByDex.has(dex)) {
        representativeCoinByDex.set(dex, position.coin);
      }
    }
    const mainCoin = representativeCoinByDex.get("");
    const mainMidsPromise = mainCoin
      ? this.allMids(mainCoin, signal).catch(() => ({}) as Record<string, string>)
      : Promise.resolve({} as Record<string, string>);
    const additiveMidsPromise = Promise.all(
      [...representativeCoinByDex.entries()]
        .filter(([dex]) => dex.length > 0)
        .map(([, coin]) =>
          this.allMids(
            coin,
            positionAdditiveSignal(signal),
          ).catch(() => ({}) as Record<string, string>),
        ),
    );
    const [mainMids, additiveMids] = await Promise.all([
      mainMidsPromise,
      additiveMidsPromise,
    ]);
    const mids = Object.assign({}, mainMids, ...additiveMids) as Record<
      string,
      string
    >;
    if (signal?.aborted) {
      throw signal.reason ?? new Error("perp account snapshot aborted");
    }
    return {
      positions: assetPositions.map((ap) => mapPositionRow(ap.position, mids)),
      // MAIN-DEX cross summary only, and which orders it backs depends on the
      // account's abstraction mode:
      //
      //  - Standard mode: each HIP-3 dex holds its own collateral, so this
      //    figure backs main-dex orders ONLY. Folding the HIP-3 summaries in
      //    here would report margin that cannot back a main-dex order.
      //  - Shared-collateral modes (unifiedAccount / portfolioMargin /
      //    dexAbstraction): collateral is pooled, so this is understood to be
      //    the pool that backs a HIP-3 order too.
      //
      // That second reading is an ASSUMPTION about venue behaviour, not
      // something this repo can prove. Callers that size a HIP-3 order from it
      // must first confirm the account is in a shared-collateral mode, and the
      // assumption itself is on the testnet checklist in
      // docs/deployment/perps-auto-mirror-testnet-checklist.md.
      crossMargin: readCrossMargin(mainState),
      coveredDexes,
    };
  }

  // -------------------------------------------------------------------------
  // Trading (signing ExchangeClient)
  //
  // NO RETRY on any state-changing HL call (order / cancel / updateLeverage /
  // marketClose / approveAgent / approveBuilderFee). A blind resubmit of an
  // order that already filled would DOUBLE the position; a resubmit of a
  // cancel/leverage/setup action after a network blip that actually succeeded
  // is at best redundant and at worst races. Reads keep `retryHyperliquidRead`. The `cloid`
  // provides broker-side dedupe for the specific case of a retried submit, but
  // we deliberately do not auto-retry here — the caller decides.
  //
  // Builder code is attached ONLY when configured (`this.builder`). Orders place
  // fine with no builder; `builder: undefined` is never sent to the SDK.
  // -------------------------------------------------------------------------

  /** Whether a builder code is configured on this client. */
  get hasBuilder(): boolean {
    return this.builder !== undefined;
  }

  /**
   * Resolve the tif for an order given its type and post-only flag.
   * Market → Ioc (aggressive price). Limit → Alo when post-only, else Gtc.
   */
  private resolveTif(
    orderType: PerpOrderType,
    postOnly: boolean | undefined,
    override: PerpTimeInForce | undefined,
  ): PerpTimeInForce {
    if (override) return override;
    if (orderType === "Market") return "Ioc";
    return postOnly ? "Alo" : "Gtc";
  }

  /**
   * Place a perp order. The builder code is attached ONLY when configured; the
   * client places orders fine with no builder (`builder: undefined` is never
   * sent). Size is rounded to `szDecimals`. A deterministic cloid is attached
   * for idempotency. NO auto-retry: a resubmit after a successful fill would
   * double the position.
   *
   * The `t` (order-type) field is one of:
   *   - `{ limit: { tif } }` for Market (Ioc, aggressive `p`) / Limit (Gtc/Alo).
   *   - `{ trigger: { isMarket, triggerPx, tpsl } }` for the stop / take-profit
   *     trigger types. For the `isMarket` trigger types `p` is derived
   *     aggressively from `triggerPx`; for the non-market (StopLimit /
   *     TakeProfitLimit) types `p` is the user's `limitPrice`.
   */
  async placeOrder(req: PlacePerpOrderRequest) {
    const prepared = await (async () => {
      const exchange = this.requireExchange();
      const builder = this.builder;
      const asset = await this.resolveAsset(req.coin);
      const isBuy = req.side === "long";
      const size = formatSize(req.size, asset.szDecimals);
      const cloid = req.clientOrderId ? toCloid(req.clientOrderId) : undefined;
      const trigger = triggerSpecForOrderType(req.orderType);

      let price: string;
      let t:
        | { limit: { tif: PerpTimeInForce } }
        | {
            trigger: {
              isMarket: boolean;
              triggerPx: string;
              tpsl: "tp" | "sl";
            };
          };

      if (trigger) {
        if (
          req.triggerPx === undefined ||
          req.triggerPx === null ||
          req.triggerPx === ""
        ) {
          throw new Error(`${req.orderType} orders require a triggerPx.`);
        }
        const triggerPx = formatPrice(req.triggerPx, asset.szDecimals);
        if (trigger.isMarket) {
          price = aggressivePrice(
            req.triggerPx,
            req.side,
            asset.szDecimals,
            req.slippage,
          );
        } else {
          if (req.limitPrice === undefined) {
            throw new Error(`${req.orderType} orders require a limitPrice.`);
          }
          price = formatPrice(req.limitPrice, asset.szDecimals);
        }
        t = {
          trigger: {
            isMarket: trigger.isMarket,
            triggerPx,
            tpsl: trigger.tpsl,
          },
        };
      } else if (req.orderType === "Limit") {
        if (req.limitPrice === undefined) {
          throw new Error("Limit orders require a limitPrice.");
        }
        price = formatPrice(req.limitPrice, asset.szDecimals);
        t = {
          limit: {
            tif: this.resolveTif(req.orderType, req.postOnly, req.timeInForce),
          },
        };
      } else {
        let mark = req.limitPrice ?? req.markPrice;
        if (mark === undefined || mark === null || mark === "") {
          const mids = await this.allMids(req.coin);
          const mid = mids[req.coin];
          if (mid === undefined) {
            throw new Error(
              `Market order for ${req.coin} needs a price: no markPrice supplied and no mid available.`,
            );
          }
          if (!isSafePositiveTradingPerpDecimal(mid)) {
            throw new Error(
              `Market order for ${req.coin} needs a safe positive mid before submission.`,
            );
          }
          mark = mid;
        }
        price = aggressivePrice(mark, req.side, asset.szDecimals, req.slippage);
        t = {
          limit: {
            tif: this.resolveTif(req.orderType, req.postOnly, req.timeInForce),
          },
        };
      }

      return {
        exchange,
        params: {
          orders: [
            {
              a: asset.assetIndex,
              b: isBuy,
              p: price,
              s: size,
              r: req.reduceOnly ?? false,
              t,
              ...(cloid ? { c: cloid } : {}),
            },
          ],
          grouping: "na" as const,
          ...(builder
            ? {
                builder: {
                  b: builder.address as `0x${string}`,
                  f: builder.feeTenthsBps,
                },
              }
            : {}),
        },
      };
    })().catch((error: unknown) => {
      throw new HyperliquidOrderPreparationError(error);
    });

    // NO automatic retry: a resubmit after a successful fill doubles the position.
    let result;
    try {
      result = await prepared.exchange.order(prepared.params);
    } catch (error) {
      // ApiRequestError: the HTTP round-trip completed successfully and
      // Hyperliquid returned a definitive venue rejection (bad margin, tick
      // size, reduce-only violation, unknown asset, etc.). The order was never
      // placed, so this is a hard REJECTED, not an ambiguous pending.
      if (error instanceof ApiRequestError)
        throw new HyperliquidOrderRejectedError(error.message);
      // HttpRequestError covers timeout, abort, network failure, non-JSON, and
      // non-2xx transport responses. Any may have happened after HL accepted
      // the payload, so callers must reconcile by cloid.
      if (error instanceof HttpRequestError) throw error;
      // Everything else (asset resolve, price/size formatting, signing,
      // serialization) is a definite pre-submission failure.
      throw new HyperliquidOrderPreparationError(error);
    }

    const rejection = orderRejectionMessage(result);
    if (rejection) throw new HyperliquidOrderRejectedError(rejection);
    return result;
  }

  /** Cancel a resting order by coin + oid. NO auto-retry. */
  async cancelOrder(req: CancelPerpOrderRequest) {
    const exchange = this.requireExchange();
    const assetIndex = await this.resolveAssetIndex(req.coin);
    // NO automatic retry: cancel is state-changing; a resubmit after success races.
    return await exchange.cancel({
      cancels: [{ a: assetIndex, o: req.orderId }],
    });
  }

  /** Atomically replace the price parameters of one resting position TP/SL. */
  async modifyPositionTpSl(req: ModifyPositionTpSlRequest) {
    const exchange = this.requireExchange();
    const asset = await this.resolveAsset(req.coin);
    const triggerPx = formatPrice(req.triggerPx, asset.szDecimals);
    const exitSide: PerpSide = req.positionSide === "long" ? "short" : "long";
    const price = req.isMarket
      ? aggressivePrice(
          req.triggerPx,
          exitSide,
          asset.szDecimals,
          req.slippage,
        )
      : triggerPx;

    return await exchange.modify({
      oid: req.orderId,
      order: {
        a: asset.assetIndex,
        b: exitSide === "long",
        p: price,
        s: formatSize(req.size, asset.szDecimals),
        r: true,
        t: {
          trigger: {
            isMarket: req.isMarket,
            triggerPx,
            tpsl: req.kind,
          },
        },
      },
    });
  }

  /**
   * Update leverage + margin mode for a coin. Requested leverage is clamped to
   * the asset's freshly-resolved `maxLeverage` before submission. NO auto-retry.
   */
  async updateLeverage(req: UpdateLeverageRequest) {
    const exchange = this.requireExchange();
    const asset = await this.resolveAsset(req.coin);
    const leverage = clampLeverage(req.leverage, asset.maxLeverage);
    // NO automatic retry: state-changing.
    return await exchange.updateLeverage({
      asset: asset.assetIndex,
      isCross: req.marginMode === "cross",
      leverage,
    });
  }

  /**
   * Reduce-only market close of the full position. Places an IoC order in the
   * opposite direction of the position, sized to the absolute position size.
   *
   * If no `markPrice` is supplied, a fresh mid is fetched via `allMids` for the
   * coin and used to synthesize the aggressive IoC price — a user must never be
   * left unable to close a position just because the caller didn't have a mark
   * on hand.
   */
  async marketClose(req: MarketCloseRequest) {
    const size =
      typeof req.positionSize === "string"
        ? parseFloat(req.positionSize)
        : req.positionSize;
    // A long position (positive szi) closes with a SELL; a short closes with a BUY.
    const side: PerpSide = size > 0 ? "short" : "long";

    let markPrice = req.markPrice;
    if (markPrice === undefined || markPrice === null || markPrice === "") {
      const mids = await this.allMids(req.coin);
      const mid = mids[req.coin];
      if (mid === undefined) {
        throw new Error(
          `Cannot market-close ${req.coin}: no markPrice supplied and no mid available from allMids().`,
        );
      }
      if (!isSafePositiveTradingPerpDecimal(mid)) {
        throw new Error(
          `Cannot market-close ${req.coin}: allMids() returned an unsafe positive mid.`,
        );
      }
      markPrice = mid;
    }

    return await this.placeOrder({
      coin: req.coin,
      side,
      size: Math.abs(size),
      orderType: "Market",
      reduceOnly: true,
      markPrice,
      ...(req.slippage !== undefined ? { slippage: req.slippage } : {}),
      ...(req.clientOrderId ? { clientOrderId: req.clientOrderId } : {}),
    });
  }

  /**
   * Attach a reduce-only stop-loss and/or take-profit to an OPEN position.
   * Places one trigger order per requested leg on the OPPOSITE side of the
   * position (see `buildTpSlLegs`). At least one of `stopLossPx` /
   * `takeProfitPx` must be supplied. Legs are placed sequentially; NO
   * auto-retry (each leg goes through `placeOrder`, which never retries).
   *
   * Returns the raw SDK order responses in leg order (SL before TP when both
   * are present).
   */
  async setPositionTpSl(req: SetPositionTpSlRequest) {
    const legs = buildTpSlLegs(req);
    if (legs.length === 0) {
      throw new Error(
        "setPositionTpSl requires at least one of stopLossPx / takeProfitPx.",
      );
    }
    const exchange = this.requireExchange();
    const asset = await this.resolveAsset(req.coin);
    const orders = legs.map((leg) => {
      const trigger = triggerSpecForOrderType(leg.orderType);
      if (!trigger || leg.triggerPx === undefined) {
        throw new Error(`Invalid TP/SL leg for ${req.coin}.`);
      }
      const triggerPx = formatPrice(leg.triggerPx, asset.szDecimals);
      const price = trigger.isMarket
        ? aggressivePrice(
            leg.triggerPx,
            leg.side,
            asset.szDecimals,
            leg.slippage,
          )
        : formatPrice(leg.limitPrice ?? leg.triggerPx, asset.szDecimals);
      const cloid = leg.clientOrderId ? toCloid(leg.clientOrderId) : undefined;

      return {
        a: asset.assetIndex,
        b: leg.side === "long",
        p: price,
        s: formatSize(leg.size, asset.szDecimals),
        r: true,
        t: {
          trigger: {
            isMarket: trigger.isMarket,
            triggerPx,
            tpsl: trigger.tpsl,
          },
        },
        ...(cloid ? { c: cloid } : {}),
      };
    });

    // Submit the exits atomically as a position-linked group. Hyperliquid
    // manages the legs with the position rather than leaving an independent
    // sibling resting after the position is closed.
    return await exchange.order({
      orders,
      grouping: "positionTpsl",
      ...(this.builder
        ? {
            builder: {
              b: this.builder.address as `0x${string}`,
              f: this.builder.feeTenthsBps,
            },
          }
        : {}),
    });
  }

  // -------------------------------------------------------------------------
  // One-time master-signed setup (consumed by `hyperliquid.enable`, Stage 2)
  //
  // These are master-signed (the client must be constructed with the MASTER
  // wallet, not the agent). NO auto-retry: a resubmit after a network blip that
  // actually succeeded is redundant and, for approveAgent, re-registers.
  // -------------------------------------------------------------------------

  /**
   * Register (approve) an agent wallet on the master account. Master-signed.
   * The agent may then sign orders on the master's behalf. NO auto-retry.
   */
  async approveAgent(req: ApproveAgentRequest) {
    const exchange = this.requireExchange();
    // NO automatic retry: state-changing, master-signed one-time setup.
    return await exchange.approveAgent({
      agentAddress: req.agentAddress,
      agentName: req.agentName ?? DEFAULT_AGENT_NAME,
    });
  }

  /**
   * Approve a max builder fee rate on the master account. Master-signed. Only
   * call this when a builder is configured; the enable mutation skips it
   * otherwise. NO auto-retry.
   */
  async approveBuilderFee(req: ApproveBuilderFeeRequest) {
    const exchange = this.requireExchange();
    // NO automatic retry: state-changing, master-signed one-time setup.
    return await exchange.approveBuilderFee({
      builder: req.builder,
      maxFeeRate: req.maxFeeRate,
    });
  }
}

/**
 * Build the reduce-only trigger `PlacePerpOrderRequest`s that attach a
 * stop-loss and/or take-profit to an OPEN position. Pure + exported so the
 * leg-derivation (opposite side, reduce-only, tpsl mapping, per-leg cloid) is
 * unit-testable without an ExchangeClient.
 *
 * The legs are placed on the OPPOSITE side of the position: a LONG is closed by
 * SELL (short-side) triggers, a SHORT by BUY (long-side) triggers. SL uses
 * `StopMarket`/`StopLimit` (tpsl "sl"); TP uses `TakeProfitMarket`/
 * `TakeProfitLimit` (tpsl "tp"). Every leg is `reduceOnly: true`.
 */
export function buildTpSlLegs(
  req: SetPositionTpSlRequest,
): PlacePerpOrderRequest[] {
  // Opposite side: long position → SELL (short) triggers; short → BUY (long).
  const exitSide: PerpSide = req.positionSide === "long" ? "short" : "long";
  const isMarket = req.isMarket ?? true;
  const legs: PlacePerpOrderRequest[] = [];

  const base = {
    coin: req.coin,
    side: exitSide,
    size: req.size,
    reduceOnly: true as const,
    ...(req.slippage !== undefined ? { slippage: req.slippage } : {}),
  };

  if (
    req.stopLossPx !== undefined &&
    req.stopLossPx !== null &&
    req.stopLossPx !== ""
  ) {
    legs.push({
      ...base,
      orderType: isMarket ? "StopMarket" : "StopLimit",
      triggerPx: req.stopLossPx,
      // Non-market trigger needs a limit price `p` = the trigger price.
      ...(isMarket ? {} : { limitPrice: req.stopLossPx }),
      // Per-leg cloid folds in THIS leg's trigger price, so editing the TP price
      // and retrying leaves the SL's cloid unchanged → HL dedupes the re-sent SL
      // instead of placing a duplicate (see the SetPositionTpSl idempotency note).
      ...(req.clientOrderId
        ? { clientOrderId: `${req.clientOrderId}:sl:${req.stopLossPx}` }
        : {}),
    });
  }

  if (
    req.takeProfitPx !== undefined &&
    req.takeProfitPx !== null &&
    req.takeProfitPx !== ""
  ) {
    legs.push({
      ...base,
      orderType: isMarket ? "TakeProfitMarket" : "TakeProfitLimit",
      triggerPx: req.takeProfitPx,
      ...(isMarket ? {} : { limitPrice: req.takeProfitPx }),
      // Per-leg cloid folds in THIS leg's trigger price (see the SL leg above).
      ...(req.clientOrderId
        ? { clientOrderId: `${req.clientOrderId}:tp:${req.takeProfitPx}` }
        : {}),
    });
  }

  return legs;
}

/**
 * Map a raw HL fill (`userFills` / `userFillsByTime` row) to our normalized
 * `PerpFill`. Pure + exported so the normalization (side mapping, field
 * selection) is unit-testable without a live InfoClient.
 *
 * The raw `side` is HL's order-book convention: "B" = bid/buy, "A" = ask/sell.
 * Everything else is passed through as-is (HL reports px / sz / closedPnl / fee
 * as strings, which we keep string-typed to avoid precision loss).
 */
export function normalizePerpFill(fill: {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A" | string;
  time: number;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  fee: string;
  tid: number;
  cloid?: `0x${string}`;
}): PerpFill {
  const side: PerpFillSide = fill.side === "B" ? "buy" : "sell";
  return {
    time: fill.time,
    coin: fill.coin,
    side,
    px: fill.px,
    sz: fill.sz,
    closedPnl: fill.closedPnl,
    fee: fill.fee,
    dir: fill.dir,
    oid: fill.oid,
    hash: fill.hash,
    tid: fill.tid,
    cloid: fill.cloid ?? null,
  };
}

/**
 * Derive our `tp` | `sl` trigger discriminator from the HL `orderType` display
 * string on a `frontendOpenOrders` row. Returns null for the non-trigger
 * (Market / Limit) types. HL only exposes the human-readable orderType here
 * (not the `tpsl` field it takes on placement), so we map off that.
 */
function tpslFromOrderType(orderType: string): PerpTpsl | null {
  if (orderType === "Take Profit Market" || orderType === "Take Profit Limit") {
    return "tp";
  }
  if (orderType === "Stop Market" || orderType === "Stop Limit") {
    return "sl";
  }
  return null;
}

/**
 * Map a raw HL `frontendOpenOrders` row to our normalized `PerpOpenOrder`.
 * Exported for direct unit testing of the mapping. `side` is normalized from
 * HL's `"B"`/`"A"` (bid/ask) to `"buy"`/`"sell"`; `triggerPx` is nulled for
 * non-trigger orders (HL sends a placeholder `"0"` there); `tpsl` is derived
 * from the display `orderType`.
 */
export function mapOpenOrderRow(order: {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  origSz: string;
  oid: number;
  timestamp: number;
  isTrigger: boolean;
  triggerPx: string;
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: string;
  cloid: string | null;
}): PerpOpenOrder {
  return {
    coin: order.coin,
    side: order.side === "B" ? "buy" : "sell",
    oid: order.oid,
    cloid: order.cloid ?? null,
    sz: order.sz,
    origSz: order.origSz,
    limitPx: order.limitPx,
    isTrigger: order.isTrigger,
    triggerPx: order.isTrigger ? order.triggerPx : null,
    tpsl: order.isTrigger ? tpslFromOrderType(order.orderType) : null,
    reduceOnly: order.reduceOnly,
    isPositionTpsl: order.isPositionTpsl,
    orderType: order.orderType,
    timestamp: order.timestamp,
  };
}

/**
 * Read the cross-margin summary out of a clearinghouse response, or null.
 *
 * Defensive on purpose. This summary exists to feed a sizing control, while
 * `listPositions` is on the copy-mirror and order-submission paths. A field
 * that only a convenience feature reads must never be able to throw a
 * real-money positions read, so anything unexpected here degrades to "we do
 * not know" and the caller's chips disable instead.
 */
function readCrossMargin(state: {
  crossMarginSummary?: { accountValue?: unknown; totalMarginUsed?: unknown };
}): PerpCrossMargin | null {
  const summary = state.crossMarginSummary;
  if (!summary) return null;
  const accountValueUsd = summary.accountValue;
  const totalMarginUsedUsd = summary.totalMarginUsed;
  if (
    typeof accountValueUsd !== "string" ||
    typeof totalMarginUsedUsd !== "string"
  ) {
    return null;
  }
  return { accountValueUsd, totalMarginUsedUsd };
}

/**
 * Map a raw clearinghouse `position` object to our normalized `PerpPosition`.
 * Exported for direct unit testing of the mapping.
 */
export function mapPositionRow(
  position: {
    coin: string;
    szi: string;
    leverage: { type: "cross" | "isolated"; value: number };
    entryPx: string;
    liquidationPx: string | null;
    unrealizedPnl: string;
    returnOnEquity?: string;
    marginUsed: string;
    cumFunding: { allTime: string; sinceOpen: string; sinceChange: string };
  },
  mids: Record<string, string>,
): PerpPosition {
  const szi = parseFloat(position.szi);
  const side: PerpSide = szi >= 0 ? "long" : "short";
  const marginMode: MarginMode = position.leverage.type;
  return {
    coin: position.coin,
    side,
    size: Math.abs(szi).toString(),
    entryPx: position.entryPx ?? null,
    markPx: mids[position.coin] ?? null,
    liquidationPx: position.liquidationPx,
    unrealizedPnl: position.unrealizedPnl,
    returnOnEquity: position.returnOnEquity ?? null,
    leverage: position.leverage.value,
    marginMode,
    marginUsed: position.marginUsed,
    // sinceOpen = funding accrued for the currently-open position.
    funding: position.cumFunding.sinceOpen,
  };
}

/** Structural subset of an HL `metaAndAssetCtxs` universe asset for stats. */
type PerpUniverseAssetLike = {
  name: string;
  maxLeverage: number;
  isDelisted?: boolean;
};

/**
 * Join a meta universe with its parallel per-asset contexts (same index space,
 * including delisted assets) into compact per-coin market stats. Pure +
 * exported so the join and the delisted-skip are unit-testable without a live
 * InfoClient. Delisted assets are dropped to mirror `getUniverse()`; a missing
 * ctx degrades that coin's prices to null rather than dropping the row.
 */
export function buildPerpMarketStats(
  universe: readonly PerpUniverseAssetLike[],
  assetCtxs: readonly (PerpAssetCtxLike | null)[],
): PerpMarketStat[] {
  const stats: PerpMarketStat[] = [];
  universe.forEach((asset, index) => {
    if (asset.isDelisted) return;
    const ctx = assetCtxs[index] ?? null;
    stats.push({
      coin: asset.name,
      maxLeverage: asset.maxLeverage,
      markPx: ctx?.markPx ?? null,
      prevDayPx: ctx?.prevDayPx ?? null,
      dayNtlVlm: ctx?.dayNtlVlm ?? null,
      openInterest: ctx?.openInterest ?? null,
      funding: ctx?.funding ?? null,
    });
  });
  return stats;
}

/** Structural subset of an HL `metaAndAssetCtxs` per-asset context. */
type PerpAssetCtxLike = {
  markPx: string | null;
  midPx: string | null;
  oraclePx: string | null;
  prevDayPx: string | null;
  funding: string | null;
  dayNtlVlm: string | null;
  openInterest?: string | null;
};

/** Structural subset of an HL `l2Book` response (`levels[0]`=bids, `[1]`=asks). */
type L2BookLike = {
  levels: [Array<{ px: string }>, Array<{ px: string }>];
} | null;

/**
 * Assemble a `PerpAssetSnapshot` from a single asset context and its L2 book.
 * Pure + exported so the field selection and top-of-book bid/ask extraction are
 * unit-testable without a live InfoClient. `levels[0][0]` is the best bid and
 * `levels[1][0]` the best ask; a missing ctx or empty book degrades to null
 * fields rather than throwing.
 */
export function buildPerpAssetSnapshot(
  coin: string,
  ctx: PerpAssetCtxLike | null,
  book: L2BookLike,
  meta: {
    szDecimals: number;
    maxLeverage: number;
    isolatedOnly: boolean;
  } = { szDecimals: 4, maxLeverage: 1, isolatedOnly: false },
): PerpAssetSnapshot {
  const bids = book?.levels?.[0] ?? [];
  const asks = book?.levels?.[1] ?? [];
  return {
    coin,
    szDecimals: meta.szDecimals,
    maxLeverage: meta.maxLeverage,
    isolatedOnly: meta.isolatedOnly,
    markPx: ctx?.markPx ?? null,
    midPx: ctx?.midPx ?? null,
    oraclePx: ctx?.oraclePx ?? null,
    prevDayPx: ctx?.prevDayPx ?? null,
    funding: ctx?.funding ?? null,
    dayNtlVlm: ctx?.dayNtlVlm ?? null,
    openInterest: ctx?.openInterest ?? null,
    bid: bids[0]?.px ?? null,
    ask: asks[0]?.px ?? null,
  };
}

/** Default number of levels per side returned by `HyperliquidClient.l2Book`. */
export const PERP_L2_BOOK_DEFAULT_DEPTH = 12;

/**
 * Hard ceiling on levels per side. HL's `l2Book` returns a bounded aggregated
 * ladder, and a deeper list is not renderable in a terminal rail anyway, so
 * this bounds what a caller can ask for.
 */
export const PERP_L2_BOOK_MAX_DEPTH = 20;

/** Structural subset of an HL `l2Book` response whose levels carry size/count. */
type L2BookDepthLike = {
  time?: number | null;
  levels: [
    Array<{ px: string; sz?: string; n?: number }>,
    Array<{ px: string; sz?: string; n?: number }>,
  ];
} | null;

/** Coerce one raw HL level into a `PerpL2Level`, defaulting missing fields. */
function toPerpL2Level(level: {
  px: string;
  sz?: string;
  n?: number;
}): PerpL2Level {
  return { px: level.px, sz: level.sz ?? "0", n: level.n ?? 0 };
}

/**
 * Assemble a depth-limited `PerpL2Book` from a raw HL `l2Book` response.
 *
 * Pure + exported so the side ordering (`levels[0]`=bids, `[1]`=asks), the
 * depth clamp and the empty/missing-book degradation are unit-testable without
 * a live InfoClient. A null response (unknown or brand-new market) yields an
 * empty book rather than throwing, so the caller renders "no depth" instead of
 * an error.
 */
export function buildPerpL2Book(
  coin: string,
  book: L2BookDepthLike,
  depth: number = PERP_L2_BOOK_DEFAULT_DEPTH,
): PerpL2Book {
  const requested = Number.isFinite(depth) ? Math.floor(depth) : 0;
  const limit = Math.min(
    PERP_L2_BOOK_MAX_DEPTH,
    requested > 0 ? requested : PERP_L2_BOOK_DEFAULT_DEPTH,
  );
  const bids = book?.levels?.[0] ?? [];
  const asks = book?.levels?.[1] ?? [];
  return {
    coin,
    time: typeof book?.time === "number" ? book.time : null,
    bids: bids.slice(0, limit).map(toPerpL2Level),
    asks: asks.slice(0, limit).map(toPerpL2Level),
  };
}
