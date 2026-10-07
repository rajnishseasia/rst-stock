import { parseCanonicalPerpCoin, type PerpCandle } from "@trade-bot/hyperliquid";
import { createMasterAlpacaClient } from "./alpaca.js";
import { createHyperliquidInfoClient } from "./hyperliquid.js";

export type XCallerMarketProvider = "alpaca" | "hyperliquid";

export interface XCallerMarketRef {
  provider: XCallerMarketProvider;
  /** Exact provider symbol. Hyperliquid casing and namespace are significant. */
  symbol: string;
  /** Stable map/cache identity, including the provider namespace. */
  key: string;
}

export function makeXCallerMarketRef(
  provider: XCallerMarketProvider,
  symbol: string,
): XCallerMarketRef {
  const trimmed = symbol.trim();
  return { provider, symbol: trimmed, key: `${provider}:${trimmed}` };
}

export interface XCallerDailyBar {
  time: number;
  close: number;
}

export interface XCallerMarketData {
  provider: XCallerMarketProvider;
  symbol: string;
  bars: XCallerDailyBar[];
  status: "available" | "unavailable";
  unavailableReason?: "provider" | "deadline" | "skipped";
}

export interface XCallerMarketDataHealth {
  /** Distinct provider-qualified markets discovered before any request cap. */
  totalMarketCount: number;
  /** Markets whose provider call was started. */
  requestedMarketCount: number;
  availableMarketCount: number;
  /** Requested markets that returned no usable data. */
  unavailableMarketCount: number;
  /** Started markets whose aggregate fetch deadline aborted the request. */
  deadlineMarketCount: number;
  /** Markets never started because the aggregate fetch budget was exhausted. */
  skippedMarketCount: number;
  /** Retained directional calls that had no safe provider-qualified ref. */
  unresolvedCandidateCount: number;
  /** Markets intentionally not requested because the caller cap was reached. */
  omittedMarketCount: number;
  /** True when the market set was truncated by an intentional cap. */
  capped: boolean;
  /** The cap applied by the caller, or null when no cap was applied. */
  marketCap: number | null;
  /** True when every requested provider market returned usable data. */
  providerComplete: boolean;
  complete: boolean;
  byProvider: Record<
    XCallerMarketProvider,
    { requested: number; available: number; unavailable: number; omitted: number }
  >;
}

export interface XCallerMarketDataSource {
  fetch(ref: XCallerMarketRef, signal?: AbortSignal): Promise<readonly XCallerDailyBar[]>;
}

export interface FetchXCallerMarketDataOptions {
  sources?: Partial<Record<XCallerMarketProvider, XCallerMarketDataSource>>;
  maxConcurrency?: number;
  nowMs?: number;
  providerTimeoutMs?: number;
  /** Aggregate budget for the entire distinct-market fetch stage. */
  marketDataBudgetMs?: number;
  signal?: AbortSignal;
}

export const X_CALLER_MARKET_DATA_CONCURRENCY = 4;
export const X_CALLER_PROVIDER_TIMEOUT_MS = 10_000;
/** Keep the whole market stage inside a typical serverless request budget. */
export const X_CALLER_MARKET_DATA_BUDGET_MS = 5_000;
const STOCK_BAR_LIMIT = 400;
const PERP_HISTORY_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_X_CALL_BAR_PRICE = 1_000_000_000;

/** Normalize completed Hyperliquid 1D candles while excluding the current UTC day. */
export function normalizeHyperliquidDailyCandles(
  candles: readonly Partial<PerpCandle>[],
  asOfMs = Date.now(),
): XCallerDailyBar[] {
  const byTime = new Map<number, XCallerDailyBar>();
  const asOfDayStartMs = startOfUtcDay(asOfMs);
  if (asOfDayStartMs === null) return [];
  for (const candle of candles) {
    const start = finiteTimestamp(candle.t);
    const end = finiteTimestamp(candle.T);
    const close = finitePositiveNumber(candle.c);
    // A valid observation needs both ends. The venue may return a current-day
    // candle whose end is already before `asOfMs` but whose UTC day is still open.
    if (
      start === null ||
      end === null ||
      end <= start ||
      close === null ||
      end >= asOfDayStartMs
    ) {
      continue;
    }
    const time = Math.floor(end / 1000);
    if (time > 0) byTime.set(time, { time, close });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Normalize Alpaca bars while excluding the current and future UTC day. */
export function normalizeAlpacaDailyBars(
  raw: unknown,
  asOfMs = Date.now(),
): XCallerDailyBar[] {
  const byTime = new Map<number, XCallerDailyBar>();
  const asOfDayStartMs = startOfUtcDay(asOfMs);
  if (asOfDayStartMs === null) return [];
  for (const bar of Array.isArray(raw) ? raw : []) {
    if (!bar || typeof bar !== "object") continue;
    const record = bar as Record<string, unknown>;
    const timeMs = parseTimestamp(record.t ?? record.Timestamp ?? record.timestamp);
    const close = finitePositiveNumber(record.c ?? record.ClosePrice ?? record.close);
    if (timeMs === null || close === null) continue;
    if (timeMs >= asOfDayStartMs) continue;
    const time = Math.floor(timeMs / 1000);
    if (time <= 0) continue;
    byTime.set(time, { time, close });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function startOfUtcDay(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function finiteTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : parseTimestamp(value);
  }
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) * 1000 : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function finitePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_X_CALL_BAR_PRICE
    ? parsed
    : null;
}

function defaultSources(nowMs: number): Record<XCallerMarketProvider, XCallerMarketDataSource> {
  let stockClient: ReturnType<typeof createMasterAlpacaClient> | null | undefined;
  let perpClient: ReturnType<typeof createHyperliquidInfoClient> | null = null;

  return {
    alpaca: {
      async fetch(ref, signal) {
        if (stockClient === undefined) {
          try {
            stockClient = createMasterAlpacaClient();
          } catch {
            stockClient = null;
          }
        }
        if (!stockClient) return [];
        const raw = await stockClient.getBars(ref.symbol, "1D", STOCK_BAR_LIMIT, {
          asOf: new Date(nowMs),
          signal,
        });
        return normalizeAlpacaDailyBars(raw, nowMs);
      },
    },
    hyperliquid: {
      async fetch(ref, signal) {
        const coin = parseCanonicalPerpCoin(ref.symbol);
        if (!coin) return [];
        perpClient ??= createHyperliquidInfoClient();
        const raw = await perpClient.candleHistory({
          coin,
          startTime: nowMs - (PERP_HISTORY_DAYS + 10) * DAY_MS,
          endTime: nowMs,
        }, signal);
        return normalizeHyperliquidDailyCandles(raw, nowMs);
      },
    },
  };
}

function emptyHealth(): XCallerMarketDataHealth {
  return {
    totalMarketCount: 0,
    requestedMarketCount: 0,
    availableMarketCount: 0,
    unavailableMarketCount: 0,
    deadlineMarketCount: 0,
    skippedMarketCount: 0,
    unresolvedCandidateCount: 0,
    omittedMarketCount: 0,
    capped: false,
    marketCap: null,
    providerComplete: true,
    complete: true,
    byProvider: {
      alpaca: { requested: 0, available: 0, unavailable: 0, omitted: 0 },
      hyperliquid: { requested: 0, available: 0, unavailable: 0, omitted: 0 },
    },
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Run one provider request with a real abort deadline and deterministic cleanup. */
async function fetchWithProviderDeadline(
  source: XCallerMarketDataSource,
  ref: XCallerMarketRef,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<readonly XCallerDailyBar[]> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectParentAbort: ((reason: unknown) => void) | undefined;
  const onParentAbort = () => {
    const reason = parentSignal?.reason ?? abortError("X-caller market-data request aborted");
    controller.abort(reason);
    rejectParentAbort?.(reason);
  };
  const parentAbort = new Promise<never>((_, reject) => {
    rejectParentAbort = reject;
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = abortError(`X-caller ${ref.provider} market-data request timed out`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    return await Promise.race([source.fetch(ref, controller.signal), parentAbort, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/** Fetch unique markets with bounded concurrency and a provider-qualified key. */
export async function fetchXCallerMarketData(
  refs: readonly XCallerMarketRef[],
  _horizonDays: number,
  options: FetchXCallerMarketDataOptions = {},
): Promise<{
  data: Map<string, XCallerMarketData>;
  health: XCallerMarketDataHealth;
}> {
  const unique = new Map<string, XCallerMarketRef>();
  for (const ref of refs) {
    if (!unique.has(ref.key)) unique.set(ref.key, ref);
  }
  const uniqueRefs = [...unique.values()];
  const nowMs = Number.isFinite(options.nowMs) && options.nowMs! > 0
    ? options.nowMs!
    : Date.now();
  const defaults = defaultSources(nowMs);
  const sources = { ...defaults, ...options.sources };
  const configuredTimeout = options.providerTimeoutMs ?? X_CALLER_PROVIDER_TIMEOUT_MS;
  const providerTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : X_CALLER_PROVIDER_TIMEOUT_MS;
  const configuredConcurrency = options.maxConcurrency ?? X_CALLER_MARKET_DATA_CONCURRENCY;
  const maxConcurrency = Number.isFinite(configuredConcurrency)
    ? Math.min(
        X_CALLER_MARKET_DATA_CONCURRENCY,
        Math.max(1, Math.floor(configuredConcurrency)),
      )
    : X_CALLER_MARKET_DATA_CONCURRENCY;
  const configuredBudget = options.marketDataBudgetMs ?? X_CALLER_MARKET_DATA_BUDGET_MS;
  const marketDataBudgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
    ? Math.floor(configuredBudget)
    : X_CALLER_MARKET_DATA_BUDGET_MS;
  const deadlineAt = Date.now() + marketDataBudgetMs;
  const deadlineController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  const onParentAbort = () => {
    deadlineController.abort(options.signal?.reason ?? abortError("X-caller market-data request aborted"));
  };
  if (options.signal?.aborted) {
    onParentAbort();
  } else if (options.signal) {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  if (!deadlineController.signal.aborted) {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      deadlineController.abort(abortError("X-caller market-data aggregate deadline exceeded"));
    }, marketDataBudgetMs);
  }
  const aggregateSignal = deadlineController.signal;
  const results: Array<XCallerMarketData | undefined> = Array.from(
    { length: uniqueRefs.length },
    () => undefined,
  );
  let nextIndex = 0;

  const unavailableResult = (
    ref: XCallerMarketRef,
    reason: "provider" | "deadline" | "skipped",
  ): XCallerMarketData => ({
    provider: ref.provider,
    symbol: ref.symbol,
    bars: [],
    status: "unavailable",
    unavailableReason: reason,
  });

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      const ref = uniqueRefs[index];
      if (!ref) return;
      const aggregateDeadlineReached =
        aggregateSignal.aborted || deadlineExpired || Date.now() >= deadlineAt;
      if (aggregateDeadlineReached) {
        nextIndex = uniqueRefs.length;
        for (let remaining = index; remaining < uniqueRefs.length; remaining += 1) {
          const remainingRef = uniqueRefs[remaining];
          if (remainingRef && !results[remaining]) {
            results[remaining] = unavailableResult(remainingRef, "skipped");
          }
        }
        return;
      }
      nextIndex += 1;
      const remainingBudgetMs = Math.max(1, deadlineAt - Date.now());
      try {
        const bars = [
          ...(await fetchWithProviderDeadline(
            sources[ref.provider],
            ref,
            aggregateSignal,
            Math.min(providerTimeoutMs, remainingBudgetMs),
          )),
        ]
          .filter(
            (bar) =>
              Number.isFinite(bar.time) &&
              bar.time > 0 &&
              Number.isFinite(bar.close) &&
              bar.close > 0 &&
              bar.close <= MAX_X_CALL_BAR_PRICE,
          )
          .sort((a, b) => a.time - b.time);
        results[index] = {
          provider: ref.provider,
          symbol: ref.symbol,
          bars,
          status: bars.length > 0 ? "available" : "unavailable",
          ...(bars.length > 0 ? {} : { unavailableReason: "provider" as const }),
        };
      } catch {
        results[index] = unavailableResult(
          ref,
          deadlineExpired || Date.now() >= deadlineAt
            ? "deadline"
            : "provider",
        );
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, uniqueRefs.length) }, worker));
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }

  const data = new Map<string, XCallerMarketData>();
  const health = emptyHealth();
  health.totalMarketCount = uniqueRefs.length;
  for (const [index, ref] of uniqueRefs.entries()) {
    const result = results[index] ?? unavailableResult(ref, "skipped");
    data.set(ref.key, result);
    if (result.unavailableReason === "skipped") {
      health.skippedMarketCount += 1;
      continue;
    }
    health.requestedMarketCount += 1;
    health.byProvider[ref.provider].requested += 1;
    if (result.status === "available") {
      health.availableMarketCount += 1;
      health.byProvider[ref.provider].available += 1;
    } else {
      health.unavailableMarketCount += 1;
      health.byProvider[ref.provider].unavailable += 1;
      if (result.unavailableReason === "deadline") health.deadlineMarketCount += 1;
    }
  }
  health.providerComplete = health.unavailableMarketCount === 0;
  health.complete =
    health.providerComplete &&
    health.skippedMarketCount === 0 &&
    health.omittedMarketCount === 0 &&
    health.unresolvedCandidateCount === 0;
  return { data, health };
}
