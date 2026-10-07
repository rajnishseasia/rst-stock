import type {
  AlpacaClient,
  AlpacaNewsArticle,
  MostActiveStock,
  StockMover,
  StockSnapshotResponse,
} from "@trade-bot/alpaca";
import type { PerpMarketStat } from "@trade-bot/hyperliquid";

export type MarketVenue = "stocks" | "perps";
export type MarketPulseStatus = "ok" | "partial" | "unavailable";
export type MarketPulseCacheState = "hit" | "miss" | "bypass";

export interface MarketTile {
  id: string;
  venue: MarketVenue;
  symbol: string;
  price: number;
  changePercent: number;
  volume: number;
  weight: number;
  trendScore: number;
  group: string;
  maxLeverage: number | null;
}

export interface PulseNewsSource {
  id: string;
  title: string;
  url: string;
  provider: string;
  publishedAt: string;
  symbols: string[];
}

export interface NormalizedStockSource {
  movers: {
    gainers: Array<{ symbol: string; price: number; change: number; percentChange: number }>;
    losers: Array<{ symbol: string; price: number; change: number; percentChange: number }>;
  };
  mostActive: Array<{ symbol: string; volume: number; tradeCount: number }>;
  snapshots: Record<string, { price: number; previousClose: number; volume: number }>;
  news: Array<{
    id: string;
    headline: string;
    summary: string;
    source: string;
    url: string;
    createdAt: string;
    symbols: string[];
  }>;
  warnings?: string[];
}

export interface MarketPulseSources {
  stocks: () => Promise<NormalizedStockSource>;
  perps: () => Promise<PerpMarketStat[] | NormalizedPerpSource>;
}

export interface NormalizedPerpSource {
  markets: PerpMarketStat[];
  warnings: string[];
}

export interface MarketPulseOverview {
  meta: {
    asOf: string;
    staleAfter: string;
    status: MarketPulseStatus;
    cacheState: MarketPulseCacheState;
  };
  brief: {
    headline: string;
    summary: string;
    sources: PulseNewsSource[];
  };
  stocks: {
    trending: MarketTile[];
    gainers: MarketTile[];
    losers: MarketTile[];
    mostActive: MarketTile[];
    heatmap: MarketTile[];
  };
  perps: {
    trending: MarketTile[];
    gainers: MarketTile[];
    losers: MarketTile[];
    heatmap: MarketTile[];
  };
  warnings: string[];
}

interface CacheClient {
  get(key: string): Promise<string | null>;
  getWithStatus?(key: string): Promise<{ ok: boolean; value: string | null }>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

const inFlightCacheComputations = new Map<
  string,
  Promise<{ data: unknown; cacheState: MarketPulseCacheState }>
>();

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPath(record: unknown, ...paths: string[][]): unknown {
  for (const path of paths) {
    let value: unknown = record;
    for (const key of path) {
      if (!value || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function percentileWeight(value: number, max: number): number {
  if (max <= 0) return 1;
  return Math.max(0.12, Math.sqrt(value / max));
}

function scoreTiles(tiles: Omit<MarketTile, "weight" | "trendScore">[]): MarketTile[] {
  const maxVolume = Math.max(...tiles.map((item) => item.volume), 1);
  const maxMove = Math.max(...tiles.map((item) => Math.abs(item.changePercent)), 1);
  return tiles.map((item) => {
    const activity = percentileWeight(item.volume, maxVolume);
    const movement = Math.min(Math.abs(item.changePercent) / maxMove, 1);
    return {
      ...item,
      weight: activity,
      trendScore: Math.round((movement * 0.65 + activity * 0.35) * 100),
    };
  });
}

function emptyVenue() {
  return { trending: [], gainers: [], losers: [], mostActive: [], heatmap: [] };
}

function buildStocks(source: NormalizedStockSource) {
  const gainers = new Map(source.movers.gainers.map((item) => [item.symbol.toUpperCase(), item]));
  const losers = new Map(source.movers.losers.map((item) => [item.symbol.toUpperCase(), item]));
  const active = new Map(source.mostActive.map((item) => [item.symbol.toUpperCase(), item]));
  const symbols = [...new Set([...gainers.keys(), ...losers.keys(), ...active.keys()])];

  const base = symbols.flatMap((symbol) => {
    const mover = gainers.get(symbol) ?? losers.get(symbol);
    const snapshot = source.snapshots[symbol];
    const price = finiteNumber(snapshot?.price ?? mover?.price);
    const previousClose = finiteNumber(snapshot?.previousClose);
    if (price === null || price <= 0) return [];
    const derivedChange = previousClose !== null && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : 0;
    const changePercent = mover?.percentChange ?? derivedChange;
    // The dedicated most-active endpoint is the ranking authority when it has
    // a row for this symbol. Snapshot volume is a useful fallback for movers.
    const volume = Math.max(active.get(symbol)?.volume ?? snapshot?.volume ?? 0, 0);
    const group = gainers.has(symbol) ? "Gainers" : losers.has(symbol) ? "Losers" : "Most Active";
    return [{
      id: `stocks:${symbol}`,
      venue: "stocks" as const,
      symbol,
      price,
      changePercent,
      volume,
      group,
      maxLeverage: null,
    }];
  });

  const heatmap = scoreTiles(base).sort((a, b) => b.volume - a.volume);
  return {
    trending: [...heatmap].sort((a, b) => b.trendScore - a.trendScore).slice(0, 8),
    gainers: heatmap.filter((item) => item.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, 8),
    losers: heatmap.filter((item) => item.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, 8),
    mostActive: [...heatmap].slice(0, 8),
    heatmap: heatmap.slice(0, 36),
  };
}

function buildPerps(source: PerpMarketStat[]) {
  const base = source.flatMap((item) => {
    const price = finiteNumber(item.markPx);
    const previous = finiteNumber(item.prevDayPx);
    const volume = finiteNumber(item.dayNtlVlm) ?? 0;
    if (price === null || price <= 0) return [];
    const changePercent = previous !== null && previous > 0 ? ((price - previous) / previous) * 100 : 0;
    const symbol = item.coin.trim();
    return [{
      id: `perps:${symbol}`,
      venue: "perps" as const,
      symbol,
      price,
      changePercent,
      volume: Math.max(volume, 0),
      group: changePercent >= 0 ? "Advancers" : "Decliners",
      maxLeverage: item.maxLeverage,
    }];
  });
  const heatmap = scoreTiles(base).sort((a, b) => b.volume - a.volume);
  return {
    trending: [...heatmap].sort((a, b) => b.trendScore - a.trendScore).slice(0, 8),
    gainers: heatmap.filter((item) => item.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, 8),
    losers: heatmap.filter((item) => item.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, 8),
    heatmap: heatmap.slice(0, 36),
  };
}

export async function buildMarketPulse(
  sources: MarketPulseSources,
  now = new Date(),
): Promise<MarketPulseOverview> {
  const [stocksResult, perpsResult] = await Promise.allSettled([sources.stocks(), sources.perps()]);
  const warnings: string[] = [];
  const stocks = stocksResult.status === "fulfilled" ? buildStocks(stocksResult.value) : emptyVenue();
  const perpSource = perpsResult.status === "fulfilled"
    ? Array.isArray(perpsResult.value)
      ? { markets: perpsResult.value, warnings: [] }
      : perpsResult.value
    : null;
  const perps = perpsResult.status === "fulfilled"
    ? buildPerps(perpSource?.markets ?? [])
    : { trending: [], gainers: [], losers: [], heatmap: [] };
  if (stocksResult.status === "rejected") warnings.push("Stocks are temporarily unavailable.");
  if (stocksResult.status === "fulfilled") warnings.push(...(stocksResult.value.warnings ?? []));
  if (perpsResult.status === "rejected") warnings.push("Perpetual markets are temporarily unavailable.");
  if (perpSource) warnings.push(...perpSource.warnings);

  const sourceNews = stocksResult.status === "fulfilled" ? stocksResult.value.news : [];
  const topStock = stocks.trending[0];
  const topPerp = perps.trending[0];
  const marketSummary = [
    topStock ? `${topStock.symbol} leads stock activity at ${topStock.changePercent >= 0 ? "+" : ""}${topStock.changePercent.toFixed(2)}%.` : null,
    topPerp ? `${topPerp.symbol} leads perpetual activity at ${topPerp.changePercent >= 0 ? "+" : ""}${topPerp.changePercent.toFixed(2)}%.` : null,
    sourceNews[0]?.summary || null,
  ].filter(Boolean).join(" ");

  const succeeded = Number(stocksResult.status === "fulfilled") + Number(perpsResult.status === "fulfilled");
  const status: MarketPulseStatus = succeeded === 2 && warnings.length === 0
    ? "ok"
    : succeeded > 0
      ? "partial"
      : "unavailable";
  return {
    meta: {
      asOf: now.toISOString(),
      staleAfter: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
      status,
      cacheState: "bypass",
    },
    brief: {
      headline: sourceNews[0]?.headline ?? "Market activity snapshot",
      summary: marketSummary || "Market activity is temporarily unavailable.",
      sources: sourceNews.slice(0, 5).map((article) => ({
        id: article.id,
        title: article.headline,
        url: article.url,
        provider: article.source,
        publishedAt: article.createdAt,
        symbols: article.symbols,
      })),
    },
    stocks,
    perps,
    warnings,
  };
}

function mover(item: StockMover) {
  return {
    symbol: item.symbol,
    price: item.price,
    change: item.change,
    percentChange: item.percent_change,
  };
}

function active(item: MostActiveStock) {
  return {
    symbol: item.symbol,
    volume: item.volume,
    tradeCount: item.trade_count,
  };
}

function snapshotMap(response: StockSnapshotResponse, symbols: string[]) {
  const root = response.snapshots && typeof response.snapshots === "object"
    ? response.snapshots
    : response as Record<string, unknown>;
  return Object.fromEntries(symbols.flatMap((symbol) => {
    const snapshot = root[symbol];
    const price = finiteNumber(readPath(snapshot, ["latestTrade", "p"], ["LatestTrade", "Price"], ["latestTrade", "Price"]));
    const previousClose = finiteNumber(readPath(snapshot, ["prevDailyBar", "c"], ["PrevDailyBar", "ClosePrice"], ["previousDailyBar", "ClosePrice"]));
    const volume = finiteNumber(readPath(snapshot, ["dailyBar", "v"], ["DailyBar", "Volume"], ["dailyBar", "Volume"]));
    return price !== null && previousClose !== null
      ? [[symbol, { price, previousClose, volume: volume ?? 0 }]]
      : [];
  }));
}

function news(article: AlpacaNewsArticle) {
  return {
    id: String(article.id),
    headline: article.headline,
    summary: article.summary ?? "",
    source: article.source ?? article.author ?? "Alpaca News",
    url: article.url,
    createdAt: article.created_at,
    symbols: article.symbols ?? [],
  };
}

export async function fetchAlpacaPulseSource(client: AlpacaClient): Promise<NormalizedStockSource> {
  const [moversResult, mostActiveResult, newsResult] = await Promise.allSettled([
    client.getStockMovers(20),
    client.getMostActiveStocks(30),
    client.getMarketNews(20),
  ]);

  if (moversResult.status === "rejected" && mostActiveResult.status === "rejected") {
    throw new Error("Alpaca stock screeners are unavailable");
  }

  const warnings: string[] = [];
  if (moversResult.status === "rejected") {
    warnings.push("Alpaca movers are temporarily unavailable.");
  }
  if (mostActiveResult.status === "rejected") {
    warnings.push("Alpaca most-active stocks are temporarily unavailable.");
  }
  if (newsResult.status === "rejected") {
    warnings.push("Alpaca market news is temporarily unavailable.");
  }

  const movers = moversResult.status === "fulfilled"
    ? moversResult.value
    : { gainers: [], losers: [] };
  const mostActive = mostActiveResult.status === "fulfilled"
    ? mostActiveResult.value
    : { most_actives: [] };
  const symbols = [...new Set([
    ...movers.gainers.map((item) => item.symbol),
    ...movers.losers.map((item) => item.symbol),
    ...mostActive.most_actives.map((item) => item.symbol),
  ].map((symbol) => symbol.toUpperCase()))];
  let snapshots: StockSnapshotResponse = { snapshots: {} };
  if (symbols.length > 0) {
    try {
      snapshots = await client.getStockSnapshots(symbols);
    } catch {
      // Mover rows already carry prices and changes, so keep that useful
      // market data even when the snapshot batch is temporarily unavailable.
      warnings.push("Alpaca stock snapshots are temporarily unavailable.");
    }
  }
  return {
    movers: { gainers: movers.gainers.map(mover), losers: movers.losers.map(mover) },
    mostActive: mostActive.most_actives.map(active),
    snapshots: snapshotMap(snapshots, symbols),
    news: newsResult.status === "fulfilled"
      ? newsResult.value.news.filter((article) => article.url).map(news)
      : [],
    warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasArray(value: unknown, key: string): boolean {
  return isRecord(value) && Array.isArray(value[key]);
}

export function isMarketPulseOverview(value: unknown): value is MarketPulseOverview {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.brief)) return false;
  if (!isRecord(value.stocks) || !isRecord(value.perps) || !Array.isArray(value.warnings)) return false;
  if (!hasArray(value.brief, "sources")) return false;
  if (!["ok", "partial", "unavailable"].includes(String(value.meta.status))) return false;
  if (!["hit", "miss", "bypass"].includes(String(value.meta.cacheState))) return false;
  return ["trending", "gainers", "losers", "mostActive", "heatmap"].every((key) =>
    hasArray(value.stocks, key),
  ) && ["trending", "gainers", "losers", "heatmap"].every((key) =>
    hasArray(value.perps, key),
  );
}

export async function cachedOrLive<T>(
  cacheKey: string,
  ttlSeconds: number | ((data: T) => number),
  compute: () => Promise<T>,
  getClient: () => Promise<CacheClient>,
  isValid?: (value: unknown) => value is T,
): Promise<{ data: T; cacheState: MarketPulseCacheState }> {
  const fullKey = `market-pulse:${cacheKey}`;
  const existing = inFlightCacheComputations.get(fullKey);
  if (existing) {
    return existing as Promise<{ data: T; cacheState: MarketPulseCacheState }>;
  }

  const operation = (async (): Promise<{ data: T; cacheState: MarketPulseCacheState }> => {
    let client: CacheClient | null = null;
    try {
      client = await getClient();
      const read = client.getWithStatus
        ? await client.getWithStatus(fullKey)
        : { ok: true, value: await client.get(fullKey) };
      if (!read.ok) {
        const data = await compute();
        return { data, cacheState: "bypass" };
      }
      const cached = read.value;
      if (cached !== null) {
        try {
          const parsed: unknown = JSON.parse(cached);
          if (!isValid || isValid(parsed)) {
            return { data: parsed as T, cacheState: "hit" };
          }
        } catch {
          // Ignore corrupt cache data and refresh it below.
        }
      }
    } catch {
      const data = await compute();
      return { data, cacheState: "bypass" };
    }

    const data = await compute();
    try {
      const resolvedTtlSeconds = typeof ttlSeconds === "function"
        ? ttlSeconds(data)
        : ttlSeconds;
      const written = await client.set(fullKey, JSON.stringify(data), resolvedTtlSeconds);
      if (written === false) {
        return { data, cacheState: "bypass" };
      }
    } catch {
      return { data, cacheState: "bypass" };
    }
    return { data, cacheState: "miss" };
  })();

  inFlightCacheComputations.set(fullKey, operation as Promise<{
    data: unknown;
    cacheState: MarketPulseCacheState;
  }>);
  try {
    return await operation;
  } finally {
    if (inFlightCacheComputations.get(fullKey) === operation) {
      inFlightCacheComputations.delete(fullKey);
    }
  }
}
