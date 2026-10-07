/**
 * Markets Router
 *
 * Unified, venue-aware symbol search. One query returns matches across BOTH
 * trading venues (Alpaca equities + Hyperliquid perps), each tagged with the
 * venues it lists on. A symbol tradable on both venues comes back as ONE item
 * whose `venues` array has both entries.
 *
 * Sources:
 *   - Equities: the same shared Alpaca `/v2/assets` cache the watchlist
 *     `symbols.search` uses (`getCachedAssets`).
 *   - Perps: the same Hyperliquid universe `hyperliquid.meta` reads
 *     (`createHyperliquidInfoClient().getUniverse()`), wrapped in a short-lived
 *     module cache so a per-keystroke typeahead doesn't re-fetch HL meta each
 *     time.
 *
 * Both sources degrade gracefully: if either the Alpaca master creds or the HL
 * universe are unavailable, that side contributes no matches instead of failing
 * the whole search.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { getCachedAssets } from "./symbols.js";
import { createHyperliquidInfoClient } from "../lib/hyperliquid.js";
import {
  mergeMarketSearchResults,
  tagRoutablePerpUniverse,
  type HlUniverseEntry,
} from "../lib/markets/market-search.js";
import { createProductionLogger } from "@trade-bot/logger";

const logger = createProductionLogger();

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;

// The HL universe changes slowly (new listings, delistings). 5 minutes keeps a
// typeahead responsive without re-fetching meta on every keystroke; the search
// tolerates a slightly stale listing set.
const HL_UNIVERSE_TTL_MS = 5 * 60 * 1000;

interface HlUniverseCache {
  fetchedAt: number;
  entries: HlUniverseEntry[];
}

let hlUniverseCache: HlUniverseCache | null = null;
let hlUniverseInflight: Promise<HlUniverseEntry[]> | null = null;

/**
 * The Hyperliquid universe (coin + delisted flag), cached in-process. Returns an
 * empty list if HL is unreachable/unconfigured so the equity side of the search
 * still resolves.
 */
async function getCachedHlUniverse(): Promise<HlUniverseEntry[]> {
  const now = Date.now();
  if (hlUniverseCache && now - hlUniverseCache.fetchedAt < HL_UNIVERSE_TTL_MS) {
    return hlUniverseCache.entries;
  }

  if (!hlUniverseInflight) {
    hlUniverseInflight = (async () => {
      const info = createHyperliquidInfoClient();
      const universe = await info.getUniverse();
      return universe.map((asset) => ({
        coin: asset.coin,
        isDelisted: asset.isDelisted,
      }));
    })()
      .then((entries) => {
        hlUniverseCache = { fetchedAt: Date.now(), entries };
        return entries;
      })
      .catch((error) => {
        logger.warn("api", "[markets] Failed to load Hyperliquid universe", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Prefer a stale cache to nothing; otherwise contribute no perp matches.
        return hlUniverseCache?.entries ?? [];
      })
      .finally(() => {
        hlUniverseInflight = null;
      });
  }

  return hlUniverseInflight;
}

const venueSchema = z.enum(["stocks", "perps"]);

export const marketsRouter = router({
  /**
   * Unified venue-aware symbol search. Returns up to `limit` items, each
   * `{ symbol, name, venues }`, ranked exact/prefix first. `venues` filters the
   * result set (omit or pass both for an "all venues" search).
   */
  // protectedProcedure is intentional (symbols.search is public): unified
  // search includes the HL perps universe and is only used inside the authed
  // terminal, so there is no anonymous caller to serve.
  search: protectedProcedure
    .input(
      z.object({
        // Deliberately NOT the shared symbolSchema (audit M7): this endpoint
        // also matches company names ("Apple Inc"), and symbolSchema's charset
        // rejects spaces. Length-capped free text is safe here because the
        // query is only used for in-memory catalog matching, never SQL.
        q: z.string().trim().max(32),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
        venues: z.array(venueSchema).optional(),
      }),
    )
    .query(async ({ input }) => {
      const q = input.q.trim();
      if (q.length === 0) return [];

      const limit = input.limit ?? SEARCH_LIMIT_DEFAULT;

      // Fetch both catalogs in parallel; each is independently resilient.
      const [equityCatalog, hlUniverse] = await Promise.all([
        getCachedAssets().catch((error) => {
          logger.warn("api", "[markets] Failed to load equity catalog", {
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }),
        getCachedHlUniverse(),
      ]);

      return mergeMarketSearchResults({
        query: q,
        equityCatalog,
        hlUniverse,
        limit,
        venues: input.venues,
      });
    }),

  /**
   * The tradable Hyperliquid perp universe, each coin tagged with whether the
   * SAME ticker is also an Alpaca equity. The terminal loads this ONCE and uses
   * it to route a picked ticker to the right venue synchronously: a coin that is
   * NOT also an equity (HYPE, BTC) is crypto-only and charts on perps, while a
   * coin that IS also an equity stays on stocks so a normal equity is never
   * hijacked. The equity join lives here because the browser never ships the full
   * Alpaca catalog. Delisted coins are excluded (they are not chartable).
   *
   * If the equity catalog is unavailable, only explicitly namespaced HIP-3
   * coins are returned. This keeps `xyz:NVDA` routable while bare symbols remain
   * fail-closed because names such as SOL and APT can collide with equities.
   */
  perpUniverse: protectedProcedure.query(async () => {
    const [equityCatalog, hlUniverse] = await Promise.all([
      getCachedAssets().catch((error) => {
        logger.warn("api", "[markets] Failed to load equity catalog for perp universe", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }),
      getCachedHlUniverse(),
    ]);

    return tagRoutablePerpUniverse(hlUniverse, equityCatalog);
  }),
});
