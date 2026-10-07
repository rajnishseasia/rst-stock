/**
 * Symbols Router
 *
 * Lightweight typeahead for the watchlist "Add symbol" input. Backed by an
 * in-memory cache of Alpaca's `/v2/assets` list so users can confirm a ticker
 * exists (and discover the right one by company name) without burning a quote
 * call per keystroke.
 *
 * The cache is shared across users — it uses `ALPACA_MASTER_KEY` /
 * `ALPACA_MASTER_SECRET` (same env vars that already back chart bars in
 * `createMasterAlpacaClient`). If those aren't configured, we degrade
 * gracefully: the search query just returns an empty list and the input still
 * works as a plain text field via the existing submit handler.
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { rankEquityMatches } from "../lib/markets/market-search.js";

export interface SymbolEntry {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
}

interface AssetCache {
  fetchedAt: number;
  entries: SymbolEntry[];
}

// 24h is plenty: Alpaca's tradable equity list changes slowly. We refresh
// lazily on the first query after expiry rather than running a background
// timer, since the cost of a stale entry is just "user sees yesterday's
// listing set" which is fine for an autocomplete.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cache: AssetCache | null = null;
let inflightFetch: Promise<AssetCache> | null = null;

// Resolved at runtime once we know which base URL the configured master
// keys are valid against — paper keys only work on paper-api, live keys
// only work on api.alpaca.markets. Cached so we don't retry both bases on
// every refresh.
let resolvedAssetBase: string | null = null;

const DEFAULT_DEV_EQUITIES: SymbolEntry[] = [
  { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", tradable: true },
  { symbol: "TSLA", name: "Tesla Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", exchange: "NYSE", tradable: true },
  { symbol: "QQQ", name: "Invesco QQQ Trust", exchange: "NASDAQ", tradable: true },
  { symbol: "AMZN", name: "Amazon.com Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "GOOGL", name: "Alphabet Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "MSFT", name: "Microsoft Corporation", exchange: "NASDAQ", tradable: true },
  { symbol: "META", name: "Meta Platforms Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "AMD", name: "Advanced Micro Devices Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "COIN", name: "Coinbase Global Inc.", exchange: "NASDAQ", tradable: true },
  { symbol: "PLTR", name: "Palantir Technologies Inc.", exchange: "NYSE", tradable: true },
];

async function fetchAssetList(): Promise<AssetCache> {
  const keyId = process.env.ALPACA_MASTER_KEY;
  const secretKey = process.env.ALPACA_MASTER_SECRET;
  const paperPreferred = process.env.ALPACA_MASTER_PAPER !== "false";

  if (!keyId || !secretKey) {
    if (process.env.NODE_ENV !== "production") {
      // Master creds missing → return default popular equities catalog in dev/offline mode
      return { fetchedAt: Date.now(), entries: DEFAULT_DEV_EQUITIES };
    }
    console.warn("[symbols] ALPACA_MASTER_KEY or ALPACA_MASTER_SECRET missing in production");
    return { fetchedAt: Date.now(), entries: [] };
  }

  // /v2/assets is on the trading API host. Paper and live use different
  // hosts, and a paper key 401s on the live host (and vice versa). We don't
  // know up front which env the master keys belong to, so try the preferred
  // host first and fall back to the other on auth failure. The resolution is
  // cached so subsequent refreshes hit the right host directly.
  const headers = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secretKey,
  };
  const path = "/v2/assets?status=active&asset_class=us_equity";
  const bases = resolvedAssetBase
    ? [resolvedAssetBase]
    : paperPreferred
      ? ["https://paper-api.alpaca.markets", "https://api.alpaca.markets"]
      : ["https://api.alpaca.markets", "https://paper-api.alpaca.markets"];

  let res: Response | null = null;
  let lastErr = "";
  for (const base of bases) {
    const attempt = await fetch(`${base}${path}`, { headers });
    if (attempt.ok) {
      resolvedAssetBase = base;
      res = attempt;
      break;
    }
    lastErr = `${base} ${attempt.status}: ${await attempt.text()}`;
  }

  if (!res) {
    throw new Error(`Alpaca /v2/assets failed on all bases: ${lastErr}`);
  }

  const raw = (await res.json()) as Array<{
    symbol: string;
    name?: string;
    exchange?: string;
    tradable?: boolean;
  }>;

  const entries: SymbolEntry[] = raw.map((a) => ({
    symbol: a.symbol,
    name: a.name ?? "",
    exchange: a.exchange ?? "",
    tradable: a.tradable ?? false,
  }));

  return { fetchedAt: Date.now(), entries };
}

export async function getCachedAssets(): Promise<SymbolEntry[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.entries;
  }

  // De-dupe concurrent refreshes — under burst load (e.g. many users typing
  // at once right after a cold start) we don't want N parallel Alpaca calls.
  if (!inflightFetch) {
    inflightFetch = fetchAssetList()
      .then((next) => {
        cache = next;
        return next;
      })
      .catch((err) => {
        // Don't poison the cache on a transient failure; let the next caller
        // retry. If we already have a stale cache, prefer that to nothing.
        console.error("[symbols] Failed to refresh Alpaca asset list", err);
        if (cache) return cache;
        return { fetchedAt: Date.now(), entries: [] };
      })
      .finally(() => {
        inflightFetch = null;
      });
  }

  const result = await inflightFetch;
  return result.entries;
}

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;

export const symbolsRouter = router({
  /**
   * Prefix/substring search over the cached Alpaca asset list.
   *
   * Ranking:
   *   1. Exact symbol match
   *   2. Symbol prefix match
   *   3. Name word-prefix match
   *   4. Name substring match
   *
   * Returns an empty list if the master Alpaca catalog isn't configured —
   * the watchlist input will silently fall back to plain text entry.
   */
  search: publicProcedure
    .input(
      z.object({
        q: z.string().trim().max(32),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
      })
    )
    .query(async ({ input }) => {
      const q = input.q.trim();
      if (q.length === 0) return [] as SymbolEntry[];

      const limit = input.limit ?? SEARCH_LIMIT_DEFAULT;
      const assets = await getCachedAssets();
      if (assets.length === 0) return [];

      // Tiered ranking (exact symbol → symbol prefix → name matches), shared
      // with the unified `markets.search` so both stay consistent.
      return rankEquityMatches(q, assets, limit);
    }),
});
