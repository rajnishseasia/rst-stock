/**
 * Quotes Router
 *
 * tRPC router for fetching live stock and options quotes.
 * Uses Alpaca API for market data.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDecryptedCredentials } from "../lib/credentials.js";
import { createAlpacaClientFromCredentials, createMasterAlpacaClient } from "../lib/alpaca.js";
import {
  buildOptionsSymbol,
  normalizeExpirationToYYMMDD,
  normalizeExpirationToYYYYMMDD,
} from "../lib/options.js";
import { isTransientHttpError, retryAsync } from "../lib/retry.js";
import type {
  GetOptionContractsParams,
  GetOptionChainParams,
  OptionSnapshot,
} from "@trade-bot/alpaca";

const credentialSelectorSchema = {
  credentialId: z.string().uuid().optional(),
  accountId: z.string().optional(),
};

function fetchMarketData<T>(operation: () => Promise<T>): Promise<T> {
  return retryAsync(operation, {
    attempts: 3,
    baseDelayMs: 200,
    shouldRetry: isTransientHttpError,
  });
}

export interface QuoteResponse {
  symbol: string;
  last: string;
  change: string;
  changePercent: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
  volume: string;
}

/**
 * Normalized option contract returned by listOptionContracts.
 * Drives both the expiration dropdown (distinct `expiration`) and the strike
 * dropdown (filtered by expiration + type) in the trade form.
 */
export interface NormalizedOptionContract {
  symbol: string; // OCC symbol
  underlying: string;
  strike: number;
  expiration: string; // YYYY-MM-DD
  type: "call" | "put";
  style: string;
  tradable: boolean;
  name: string;
  size: string;
}

/** Today's date in YYYY-MM-DD (UTC). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Today + `days` in YYYY-MM-DD (UTC). */
function todayPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const quotesRouter = router({
  /**
   * Get stock quotes for one or more symbols
   */
  getStockQuotes: protectedProcedure
    .input(
      z.object({
        symbols: z.array(z.string()).min(1).max(20),
        ...credentialSelectorSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alpaca credentials missing" });
      }

      const client = createAlpacaClientFromCredentials(credentials);

      const promises = input.symbols.map(async (sym) => {
        try {
          // IEX feed returns PascalCase: LatestTrade, LatestQuote, DailyBar, PrevDailyBar
          const snapshot = await fetchMarketData(() => client.getSnapshot(sym));
          const q = snapshot?.LatestQuote || snapshot?.latestQuote;
          const t = snapshot?.LatestTrade || snapshot?.latestTrade;
          const d = snapshot?.DailyBar || snapshot?.dailyBar;
          const prev = snapshot?.PrevDailyBar || snapshot?.prevDailyBar;

          const lastPrice = t?.Price ?? t?.p ?? 0;
          const bidPrice = q?.BidPrice ?? q?.bp ?? 0;
          const askPrice = q?.AskPrice ?? q?.ap ?? 0;
          const highPrice = d?.HighPrice ?? d?.h ?? 0;
          const lowPrice = d?.LowPrice ?? d?.l ?? 0;
          const vol = d?.Volume ?? d?.v ?? 0;
          const prevClose = prev?.ClosePrice ?? prev?.c ?? 0;

          let change = 0;
          let changePercent = 0;

          if (lastPrice && prevClose) {
            change = lastPrice - prevClose;
            changePercent = (change / prevClose) * 100;
          }

          return {
            symbol: sym,
            last: lastPrice ? lastPrice.toFixed(2) : "0.00",
            change: change.toFixed(2),
            changePercent: changePercent.toFixed(2),
            bid: bidPrice ? bidPrice.toFixed(2) : "0.00",
            ask: askPrice ? askPrice.toFixed(2) : "0.00",
            high: highPrice ? highPrice.toFixed(2) : "0.00",
            low: lowPrice ? lowPrice.toFixed(2) : "0.00",
            volume: vol ? vol.toLocaleString() : "0",
          };
        } catch (e) {
          console.error(`Failed to fetch quote for ${sym}`, e);
          return {
            symbol: sym,
            last: "0.00",
            change: "0.00",
            changePercent: "0.00",
            bid: "0.00",
            ask: "0.00",
            high: "0.00",
            low: "0.00",
            volume: "0",
          };
        }
      });

      return await Promise.all(promises);
    }),

  /**
   * Get a single stock quote
   */
  getStockQuote: protectedProcedure
    .input(z.object({ symbol: z.string().min(1).max(10), ...credentialSelectorSchema }))
    .query(async ({ ctx, input }) => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alpaca credentials missing" });
      }

      const client = createAlpacaClientFromCredentials(credentials);

      try {
        const snapshot = await fetchMarketData(() => client.getSnapshot(input.symbol));

        // IEX feed returns PascalCase: LatestTrade, LatestQuote, DailyBar, PrevDailyBar
        const q = snapshot?.LatestQuote || snapshot?.latestQuote;
        const t = snapshot?.LatestTrade || snapshot?.latestTrade;
        const d = snapshot?.DailyBar || snapshot?.dailyBar;
        const prev = snapshot?.PrevDailyBar || snapshot?.prevDailyBar;

        const lastPrice = t?.Price ?? t?.p ?? 0;
        const bidPrice = q?.BidPrice ?? q?.bp ?? 0;
        const askPrice = q?.AskPrice ?? q?.ap ?? 0;
        const highPrice = d?.HighPrice ?? d?.h ?? 0;
        const lowPrice = d?.LowPrice ?? d?.l ?? 0;
        const vol = d?.Volume ?? d?.v ?? 0;
        const prevClose = prev?.ClosePrice ?? prev?.c ?? 0;

        let change = 0;
        let changePercent = 0;

        if (lastPrice && prevClose) {
          change = lastPrice - prevClose;
          changePercent = (change / prevClose) * 100;
        }

        return {
          symbol: input.symbol,
          last: lastPrice ? lastPrice.toFixed(2) : "0.00",
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          bid: bidPrice ? bidPrice.toFixed(2) : "0.00",
          ask: askPrice ? askPrice.toFixed(2) : "0.00",
          high: highPrice ? highPrice.toFixed(2) : "0.00",
          low: lowPrice ? lowPrice.toFixed(2) : "0.00",
          volume: vol ? vol.toLocaleString() : "0",
        };
      } catch (e: any) {
        console.error(`[Quotes] Error fetching quote for ${input.symbol}`, e.response?.data || e.message);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: e.response?.data?.message || e.message || "Symbol not found or quote unavailable",
        });
      }
    }),

  /**
   * List option contracts for an underlying (contract discovery).
   *
   * Backs BOTH the expiration dropdown (distinct expiration_date) and the
   * strike dropdown (filtered by expiration + type) in the trade form.
   */
  listOptionContracts: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10).transform((v) => v.toUpperCase()),
        expiration: z.string().optional(),
        expirationGte: z.string().optional(),
        expirationLte: z.string().optional(),
        strikeGte: z.number().optional(),
        strikeLte: z.number().optional(),
        optionType: z.enum(["call", "put"]).optional(),
        limit: z.number().int().min(1).max(10000).default(1000),
        ...credentialSelectorSchema,
      })
    )
    .query(async ({ ctx, input }): Promise<NormalizedOptionContract[]> => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alpaca credentials missing" });
      }

      const client = createAlpacaClientFromCredentials(credentials);

      // ALWAYS pass an expiration window: with no filters Alpaca returns a
      // narrow set (contracts expiring before the next weekend).
      let expirationGte: string;
      let expirationLte: string;
      if (input.expiration) {
        // Single-day window (YYYY-MM-DD).
        const day = normalizeExpirationToYYYYMMDD(input.expiration);
        expirationGte = day;
        expirationLte = day;
      } else {
        expirationGte = input.expirationGte ?? today();
        expirationLte = input.expirationLte ?? todayPlusDays(730);
      }

      const params: GetOptionContractsParams = {
        underlying_symbols: input.symbol,
        status: "active",
        expiration_date_gte: expirationGte,
        expiration_date_lte: expirationLte,
        limit: input.limit,
      };
      if (input.optionType) params.type = input.optionType;
      if (input.strikeGte !== undefined) params.strike_price_gte = input.strikeGte;
      if (input.strikeLte !== undefined) params.strike_price_lte = input.strikeLte;

      try {
        const res = await fetchMarketData(() => client.getOptionContracts(params));

        return (res.option_contracts || []).map((c) => ({
          symbol: c.symbol,
          underlying: c.underlying_symbol,
          strike: parseFloat(c.strike_price),
          expiration: c.expiration_date,
          type: c.type,
          style: c.style,
          tradable: c.tradable,
          name: c.name,
          size: c.size,
        }));
      } catch (e: any) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            e?.response?.data?.message ||
            e?.message ||
            "Failed to load option contracts",
        });
      }
    }),

  /**
   * Get the option chain snapshots (live-ish bid/ask + greeks) for a symbol.
   */
  getOptionsChain: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10).transform((val) => val.toUpperCase()),
        expiration: z.string().optional(),
        strikeGte: z.number().optional(),
        strikeLte: z.number().optional(),
        optionType: z.enum(["call", "put"]).optional(),
        ...credentialSelectorSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alpaca credentials missing" });
      }

      const client = createAlpacaClientFromCredentials(credentials);

      const params: GetOptionChainParams = {};
      if (input.optionType) params.type = input.optionType;
      if (input.expiration) params.expiration_date = normalizeExpirationToYYYYMMDD(input.expiration);
      if (input.strikeGte !== undefined) params.strike_price_gte = input.strikeGte;
      if (input.strikeLte !== undefined) params.strike_price_lte = input.strikeLte;

      try {
        const res = await fetchMarketData(() =>
          client.getOptionChainSnapshots(input.symbol, params)
        );

        const snapshots = Object.entries(res.snapshots || {}).map(([osi, sn]) => {
          const s = sn as OptionSnapshot;
          return {
            symbol: osi,
            bid: s.latestQuote?.bp != null ? s.latestQuote.bp.toFixed(2) : "0.00",
            ask: s.latestQuote?.ap != null ? s.latestQuote.ap.toFixed(2) : "0.00",
            last: s.latestTrade?.p != null ? s.latestTrade.p.toFixed(2) : "0.00",
            impliedVolatility: s.impliedVolatility ?? null,
            delta: s.greeks?.delta ?? null,
            gamma: s.greeks?.gamma ?? null,
            theta: s.greeks?.theta ?? null,
            vega: s.greeks?.vega ?? null,
            rho: s.greeks?.rho ?? null,
          };
        });

        return {
          underlying: input.symbol,
          snapshots,
        };
      } catch (e: any) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            e?.response?.data?.message ||
            e?.message ||
            "Options chain not found or unavailable",
        });
      }
    }),

  /** Lightweight batch of side-ready option quotes for Copy Trade sizing. */
  getOptionQuotes: protectedProcedure
    .input(
      z.object({
        contracts: z
          .array(
            z.object({
              symbol: z.string().min(1).max(10).transform((value) => value.toUpperCase()),
              expiration: z.string().min(6).max(10),
              strike: z.number().positive(),
              optionType: z.enum(["call", "put"]),
            }),
          )
          .min(1)
          .max(20),
        ...credentialSelectorSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alpaca credentials missing" });
      }

      const client = createAlpacaClientFromCredentials(credentials);
      return Promise.all(
        input.contracts.map(async (contract) => {
          const expiration = normalizeExpirationToYYMMDD(contract.expiration);
          const occSymbol = buildOptionsSymbol(
            contract.symbol,
            expiration,
            contract.strike,
            contract.optionType.toUpperCase() as "CALL" | "PUT",
          );

          try {
            const snapshot = await fetchMarketData(() =>
              client.getLatestOptionQuote(occSymbol),
            );
            const bid = Number(snapshot?.latestQuote?.bp);
            const ask = Number(snapshot?.latestQuote?.ap);
            return {
              ...contract,
              expiration,
              occSymbol,
              bid: Number.isFinite(bid) && bid > 0 ? bid : 0,
              ask: Number.isFinite(ask) && ask > 0 ? ask : 0,
            };
          } catch {
            return { ...contract, expiration, occSymbol, bid: 0, ask: 0 };
          }
        }),
      );
    }),

  /**
   * Get a single option quote (with greeks/IV when available).
   *
   * Uses the OPTIONS data API (snapshot/quote) rather than the equity snapshot
   * endpoint. The UI reads .last/.bid/.ask/.volume/.openInterest, so those keys
   * are preserved; greeks/IV are additive optional keys.
   */
  getOptionQuote: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10).transform((val) => val.toUpperCase()),
        expiration: z.string(), // YYMMDD or YYYY-MM-DD
        strike: z.number(),
        optionType: z.enum(["call", "put"]),
        ...credentialSelectorSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      const credentials = await getDecryptedCredentials(ctx.db, ctx.userId, {
        provider: "alpaca",
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      if (!credentials.username || !credentials.accessToken) return null;

      const client = createAlpacaClientFromCredentials(credentials);

      // Build the OCC symbol from the compact (YYMMDD) expiration.
      const expiryYYMMDD = normalizeExpirationToYYMMDD(input.expiration);
      const osi = buildOptionsSymbol(
        input.symbol,
        expiryYYMMDD,
        input.strike,
        input.optionType.toUpperCase() as "CALL" | "PUT"
      );

      try {
        // Prefer the chain snapshot (richer: quote + trade + greeks + IV).
        let sn: OptionSnapshot | null = null;

        const chain = await fetchMarketData(() =>
          client.getOptionChainSnapshots(input.symbol, {
            type: input.optionType,
            expiration_date: normalizeExpirationToYYYYMMDD(input.expiration),
            strike_price_gte: input.strike,
            strike_price_lte: input.strike,
          })
        );

        if (chain?.snapshots && chain.snapshots[osi]) {
          sn = chain.snapshots[osi];
        } else if (chain?.snapshots) {
          // The chain may key on a slightly different symbol; fall back to the
          // single returned entry if there is exactly one.
          const entries = Object.values(chain.snapshots);
          if (entries.length === 1) sn = entries[0] ?? null;
        }

        // Fall back to the lightweight latest-quote endpoint if the chain map
        // is empty.
        if (!sn) {
          sn = await fetchMarketData(() => client.getLatestOptionQuote(osi));
        }

        if (!sn) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Option quote not found or unavailable",
          });
        }

        // Open interest is not on the snapshot endpoint; it only comes from the
        // /v2/options/contracts endpoint. Fetch it separately and fail soft so a
        // missing OI never breaks the rest of the quote (volume/greeks/bid/ask).
        let openInterest = 0;
        try {
          const expiryYYYYMMDD = normalizeExpirationToYYYYMMDD(input.expiration);
          const contracts = await fetchMarketData(() =>
            client.getOptionContracts({
              underlying_symbols: input.symbol,
              type: input.optionType,
              expiration_date_gte: expiryYYYYMMDD,
              expiration_date_lte: expiryYYYYMMDD,
              strike_price_gte: input.strike,
              strike_price_lte: input.strike,
            })
          );

          const list = contracts?.option_contracts ?? [];
          const contract =
            list.find((c) => c.symbol === osi) ??
            (list.length === 1 ? list[0] : undefined);

          const oi = Number(contract?.open_interest);
          if (Number.isFinite(oi)) openInterest = oi;
        } catch {
          // OI lookup is best-effort; fall back to 0 on any failure.
          openInterest = 0;
        }

        return {
          symbol: osi,
          last: sn.latestTrade?.p != null ? sn.latestTrade.p.toFixed(2) : "0.00",
          bid: sn.latestQuote?.bp != null ? sn.latestQuote.bp.toFixed(2) : "0.00",
          ask: sn.latestQuote?.ap != null ? sn.latestQuote.ap.toFixed(2) : "0.00",
          // Volume comes from the snapshot bars: today's daily bar, falling back
          // to the latest minute bar.
          volume: String(sn.dailyBar?.v ?? sn.minuteBar?.v ?? 0),
          openInterest, // sourced from /v2/options/contracts (see above)
          strike: input.strike,
          expiration: input.expiration,
          optionType: input.optionType,
          delta: sn.greeks?.delta ?? null,
          gamma: sn.greeks?.gamma ?? null,
          theta: sn.greeks?.theta ?? null,
          vega: sn.greeks?.vega ?? null,
          rho: sn.greeks?.rho ?? null,
          impliedVolatility: sn.impliedVolatility ?? null,
        };
      } catch (e: any) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            e?.response?.data?.message ||
            e?.message ||
            "Option symbol not found or unavailable",
        });
      }
    }),

  /**
   * Get historical OHLCV bars for a symbol using master Alpaca credentials.
   * Does not require the user to have linked their own Alpaca account.
   * Returns data formatted for Lightweight Charts (time in Unix seconds).
   */
  getHistoricalBars: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10).transform((v) => v.toUpperCase()),
        timeframe: z.enum(["1Min", "5Min", "15Min", "1H", "1D"]).default("5Min"),
        limit: z.number().int().min(1).max(1000).default(200),
      })
    )
    .query(async ({ input }) => {
      const client = createMasterAlpacaClient();

      try {
        const rawBars = await fetchMarketData(() =>
          client.getBars(input.symbol, input.timeframe, input.limit)
        );

        return rawBars.map((bar: any) => {
          const t = bar.t ?? bar.Timestamp ?? bar.timestamp;
          const o = bar.o ?? bar.OpenPrice ?? bar.open ?? 0;
          const h = bar.h ?? bar.HighPrice ?? bar.high ?? 0;
          const l = bar.l ?? bar.LowPrice ?? bar.low ?? 0;
          const c = bar.c ?? bar.ClosePrice ?? bar.close ?? 0;
          const v = bar.v ?? bar.Volume ?? bar.volume ?? 0;

          const unixTime = t ? Math.floor(new Date(t).getTime() / 1000) : 0;

          return {
            time: unixTime as number,
            open: Number(o),
            high: Number(h),
            low: Number(l),
            close: Number(c),
            volume: Number(v),
          };
        }).filter((b: any) => b.time > 0);
      } catch (e: unknown) {
        if (e instanceof TRPCError) throw e;
        const msg = e instanceof Error ? e.message : "Failed to fetch bars";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: msg,
        });
      }
    }),

  /**
   * Get a real-time stock quote using master Alpaca credentials for chart snapshot polling.
   * Does not require the user to have linked their own Alpaca account.
   */
  getChartQuote: protectedProcedure
    .input(z.object({ symbol: z.string().min(1).max(10).transform((v) => v.toUpperCase()) }))
    .query(async ({ input }) => {
      const client = createMasterAlpacaClient();

      try {
        const snapshot = await fetchMarketData(() => client.getSnapshot(input.symbol));

        const q = snapshot?.LatestQuote || snapshot?.latestQuote;
        const t = snapshot?.LatestTrade || snapshot?.latestTrade;
        const d = snapshot?.DailyBar || snapshot?.dailyBar;
        const prev = snapshot?.PrevDailyBar || snapshot?.prevDailyBar;

        const lastPrice = t?.Price ?? t?.p ?? 0;
        const prevClose = prev?.ClosePrice ?? prev?.c ?? 0;

        let change = 0;
        let changePercent = 0;
        if (lastPrice && prevClose) {
          change = lastPrice - prevClose;
          changePercent = (change / prevClose) * 100;
        }

        return {
          symbol: input.symbol,
          last: lastPrice ? lastPrice.toFixed(2) : "0.00",
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          bid: (q?.BidPrice ?? q?.bp ?? 0).toFixed(2),
          ask: (q?.AskPrice ?? q?.ap ?? 0).toFixed(2),
          high: (d?.HighPrice ?? d?.h ?? 0).toFixed(2),
          low: (d?.LowPrice ?? d?.l ?? 0).toFixed(2),
          volume: (d?.Volume ?? d?.v ?? 0).toLocaleString(),
        };
      } catch (e: unknown) {
        if (e instanceof TRPCError) throw e;
        const msg = e instanceof Error ? e.message : "Symbol not found or quote unavailable";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: msg,
        });
      }
    }),

  /**
   * Batch real-time quotes using master Alpaca credentials. Like getChartQuote
   * but for many symbols at once — backs the X Signals feed's per-symbol price
   * pills, which display to any signed-in user without a linked Alpaca account.
   * A failed symbol degrades to zeros rather than failing the whole batch.
   */
  getChartQuotes: protectedProcedure
    .input(
      z.object({
        symbols: z
          .array(z.string().min(1).max(10).transform((v) => v.toUpperCase()))
          .min(1)
          .max(30),
      })
    )
    .query(async ({ input }) => {
      const client = createMasterAlpacaClient();

      // Dedupe so repeated symbols across signals cost one snapshot each.
      const uniqueSymbols = [...new Set(input.symbols)];

      const promises = uniqueSymbols.map(async (sym) => {
        try {
          const snapshot = await client.getSnapshot(sym);
          const t = snapshot?.LatestTrade || snapshot?.latestTrade;
          const d = snapshot?.DailyBar || snapshot?.dailyBar;
          const prev = snapshot?.PrevDailyBar || snapshot?.prevDailyBar;

          const lastPrice = t?.Price ?? t?.p ?? 0;
          const prevClose = prev?.ClosePrice ?? prev?.c ?? 0;
          const vol = d?.Volume ?? d?.v ?? 0;

          let change = 0;
          let changePercent = 0;
          if (lastPrice && prevClose) {
            change = lastPrice - prevClose;
            changePercent = (change / prevClose) * 100;
          }

          return {
            symbol: sym,
            last: lastPrice ? lastPrice.toFixed(2) : "0.00",
            change: change.toFixed(2),
            changePercent: changePercent.toFixed(2),
            // Traded SHARE count for the session, in the same grouped-locale
            // shape `getStockQuotes` already returns, so one client-side
            // parser covers both. The snapshot that backs price and change
            // already carries it, so this costs no extra broker call.
            volume: vol ? vol.toLocaleString() : "0",
          };
        } catch (e) {
          console.error(`[Quotes] Failed to fetch chart quote for ${sym}`, e);
          return {
            symbol: sym,
            last: "0.00",
            change: "0.00",
            changePercent: "0.00",
            volume: "0",
          };
        }
      });

      return await Promise.all(promises);
    }),
});
