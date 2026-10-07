/**
 * Positions Router
 *
 * tRPC router for fetching and managing trading positions.
 * Provides real-time position data with P&L from Alpaca.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  orderStatusTransitionCondition,
  preserveBrokerOrderIdCondition,
  schema,
} from "@trade-bot/db";
import { createBrokerClientOrderId, isAlpacaAmbiguousOrderError, resolveTimeInForce } from "@trade-bot/alpaca";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getAlpacaClient, isPaperAccount } from "../lib/alpaca.js";
import { createHyperliquidInfoClient } from "../lib/hyperliquid.js";
import { resolveHlWalletAddress } from "../lib/hl-wallet.js";
import { realizedPnlForOpenPerps } from "../lib/perp-realized-pnl.js";
import { networkFromEnv } from "@trade-bot/hyperliquid";
import {
  normalizePortfolioHistory,
  portfolioHistoryPeriodParams,
} from "../lib/portfolio-history.js";
import { clientOrderIdSchema, resolveClientOrderId } from "../lib/order-idempotency.js";
import { resolveCloseAllSocialEvent } from "../lib/close-all-social.js";
import type { OrderStatus } from "@trade-bot/db";

const credentialSelectorSchema = {
  credentialId: z.string().uuid().optional(),
  accountId: z.string().optional(),
};

const optionalCredentialSelectorSchema = z.object(credentialSelectorSchema).optional();
const STOP_PRICE_CENTS = 100;
const STOP_PRICE_FLOATING_POINT_TOLERANCE = 1e-9;

type AuthoritativeCloseState = {
  id: string;
  status: OrderStatus;
  brokerOrderId: string | null;
};

async function readAuthoritativeCloseState(
  db: any,
  order: { id: string; userId: string; clientOrderId: string | null },
): Promise<AuthoritativeCloseState | null> {
  const findFirst = db?.query?.orders?.findFirst;
  if (typeof findFirst !== "function") return null;
  const conditions = [
    eq(schema.orders.id, order.id),
    eq(schema.orders.userId, order.userId),
  ];
  if (order.clientOrderId) conditions.push(eq(schema.orders.clientOrderId, order.clientOrderId));
  const current = await findFirst({
    where: and(...conditions),
    columns: { id: true, status: true, brokerOrderId: true },
  });
  return current ?? null;
}

function closeStateResponse(
  state: AuthoritativeCloseState,
  fallbackBrokerOrderId: string | null,
  message: string,
) {
  const stillSyncing = state.status === "PENDING" || state.status === "SYNCING";
  return {
    success: false,
    syncing: stillSyncing,
    status: state.status,
    orderId: state.id,
    brokerOrderId: state.brokerOrderId ?? fallbackBrokerOrderId,
    message,
  };
}

// Compact OCC contract symbol layout Alpaca uses for option `symbol` fields:
// root + YYMMDD(6) + C|P(1) + strike*1000 zero-padded to 8 digits (the
// inverse of buildOptionsSymbol in ../lib/options.ts). Alpaca's position
// object for an option carries only this compact symbol; it does not expose
// the underlying/expiration/strike/type as separate fields the way the order
// ticket does, so closing from the Positions panel has to recover them here.
const OCC_SUFFIX_RE = /^(\d{6})([CP])(\d{8})$/;

interface ParsedOptionContract {
  underlying: string;
  expiration: string;
  strike: number;
  type: "CALL" | "PUT";
}

function parseOccOptionSymbol(occSymbol: string): ParsedOptionContract | null {
  if (occSymbol.length <= 15) return null;
  const root = occSymbol.slice(0, occSymbol.length - 15);
  const suffix = occSymbol.slice(occSymbol.length - 15);
  const match = OCC_SUFFIX_RE.exec(suffix);
  if (!root || !match) return null;
  // `noUncheckedIndexedAccess` types capture groups as possibly undefined. The
  // regex above cannot match without all three, but an unreadable symbol must
  // return null rather than become a contract with a blank field: a close built
  // on a guessed expiration or strike would be a real order on the wrong option.
  const expiration = match[1];
  const typeChar = match[2];
  const strikeDigits = match[3];
  if (!expiration || !typeChar || !strikeDigits) return null;
  return {
    underlying: root,
    expiration,
    strike: Number(strikeDigits) / 1000,
    type: typeChar === "C" ? "CALL" : "PUT",
  };
}

function roundStopPriceUpToCents(stopPrice: number) {
  return Number(
    (
      Math.ceil(stopPrice * STOP_PRICE_CENTS - STOP_PRICE_FLOATING_POINT_TOLERANCE) /
      STOP_PRICE_CENTS
    ).toFixed(2)
  );
}

export interface PositionListResponse {
  symbol: string;
  assetClass: string;
  exchange: string;
  qty: number;
  qtyAvailable: number;
  side: string;
  avgEntryPrice: number;
  currentPrice: number;
  lastDayPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  unrealizedIntradayPL: number;
  unrealizedIntradayPLPercent: number;
  changeToday: number;
  stopLossOrders: { id: string; stopPrice: number; qty: number; type: string; }[];
  takeProfitOrders: { id: string; limitPrice: number; qty: number; }[];
  trailingStopOrders: { id: string; trailPercent: number | null; trailPrice: number | null; stopPrice: number | null; qty: number; }[];
  /**
   * Realized P&L banked on the CURRENTLY OPEN position, i.e. since the symbol
   * last went flat. Shown as "RPNL" beside unrealized P&L. Null when the
   * position predates the fetched fill window, so an understated number is
   * never passed off as the real one.
   */
  realizedPnl: number | null;
}

/**
 * How many closed orders a realized-P&L replay walks back through.
 *
 * It is the floor of the window `closedOrders` pairs across as well (that view
 * widens it when the user pages further back), so the Open view's RPNL and the
 * Closed view's per-order P&L are always reading at least the same history.
 */
export const REALIZED_PNL_FILL_WINDOW = 250;

/**
 * Realized P&L for one live Alpaca position, or null when the replay cannot
 * vouch for it.
 *
 * The replay starts from flat, so a position whose opening fills predate the
 * fetched window reconstructs as a smaller run than the broker actually holds
 * and would report only part of what was banked. Requiring the replayed
 * quantity to match the broker's is what turns that from a wrong number into
 * an absent one.
 */
export function resolveRealizedPnl(
  runs: Map<string, OpenRunRealizedPnl>,
  position: { symbol: string; qty: string; side: string },
): number | null {
  const run = runs.get(position.symbol);
  if (!run) return null;

  const magnitude = Math.abs(parseFloat(position.qty));
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  const signedQty = position.side === "short" ? -magnitude : magnitude;

  // Relative tolerance: fractional-share quantities carry up to nine decimals
  // and the replay sums them, so exact equality would drop real matches.
  const tolerance = Math.max(1e-6, Math.abs(signedQty) * 1e-6);
  if (Math.abs(run.qty - signedQty) > tolerance) return null;

  return Number.isFinite(run.realizedPnl) ? run.realizedPnl : null;
}

export interface ClosedOrderResponse {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  fillPrice: number | null;
  filledAt: string | null;
  submittedAt: string;
  status: string;
  orderType: string;
  assetClass: string;
  /**
   * Realized P&L for the orders that *closed* a position, computed by FIFO
   * pairing of fills (see computeRealizedPnlByOrder). null for orders that only
   * opened a position, never filled, or whose entry fell outside the fetched
   * history window (so a number is never guessed).
   */
  realizedPnl: number | null;
  /**
   * Display name of the trader this order was auto-mirrored from. Null for
   * all manually placed orders.
   */
  copySourceLabel: string | null;
}

/**
 * Compute realized P&L per order by FIFO-pairing fills within the given set.
 *
 * Alpaca exposes no per-trade realized-P&L endpoint, so we reconstruct it from
 * fills: each fill either extends a symbol's position or closes (part of) it,
 * realizing P&L against the oldest open lots first. The returned map is keyed
 * by the *closing* order id. Limitation: pairing only sees the fills passed in,
 * so a close whose entry is older than the fetched window can't be valued.
 */
export function computeRealizedPnlByOrder(
  orders: RealizedPnlFillOrder[]
): Map<string, number> {
  return walkFills(orders).pnlByOrder;
}

/** The subset of an Alpaca closed order the FIFO replay below reads. */
export interface RealizedPnlFillOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  submitted_at: string;
  status: string;
  asset_class: string;
}

/** The run a symbol is still holding at the end of the replay. */
export interface OpenRunRealizedPnl {
  /** Signed quantity still held: positive long, negative short. */
  qty: number;
  /** Realized P&L banked since this run opened, from partial closes. */
  realizedPnl: number;
  /** Time (ms) of the fill that took the symbol from flat into this run. */
  openedAt: number;
}

/**
 * Realized P&L banked on each symbol's CURRENTLY OPEN position, keyed by symbol.
 *
 * Alpaca's position payload carries unrealized P&L only, and a trader who has
 * scaled out of half a winner has already booked money that no field on the
 * position reports. This replays the same FIFO walk and keeps whatever the
 * still-open run has realized so far, resetting to zero every time the symbol
 * goes flat, so the number belongs to the position on screen and not to last
 * month's trade in the same ticker.
 *
 * Callers MUST reconcile `qty` against the broker's live position quantity
 * before showing the number: the replay only sees the fills passed in, so a
 * position opened before the fetched history window replays smaller than it is,
 * and its realized total would be understated rather than absent.
 */
export function computeRealizedPnlSinceOpen(
  orders: RealizedPnlFillOrder[]
): Map<string, OpenRunRealizedPnl> {
  return walkFills(orders).openRuns;
}

function walkFills(
  orders: RealizedPnlFillOrder[]
): { pnlByOrder: Map<string, number>; openRuns: Map<string, OpenRunRealizedPnl> } {
  type Lot = { qty: number; price: number; long: boolean };
  const lotsBySymbol = new Map<string, Lot[]>();
  const pnlByOrder = new Map<string, number>();
  const openRuns = new Map<string, OpenRunRealizedPnl>();

  // Any order that executed shares at a known price participates, regardless of
  // its final status — a partial fill that was later canceled/expired still has
  // filled_qty > 0 and realizes P&L. The post-map filter (positive qty + finite
  // price) is the single source of truth for "this counts." Oldest first.
  const fills = orders
    .map((o) => ({
      id: o.id,
      symbol: o.symbol,
      isBuy: o.side === "buy",
      qty: o.filled_qty != null ? parseFloat(o.filled_qty) : 0,
      price: o.filled_avg_price != null ? parseFloat(o.filled_avg_price) : NaN,
      ts: new Date(o.filled_at ?? o.submitted_at).getTime(),
      multiplier: o.asset_class === "us_option" ? 100 : 1,
    }))
    .filter((f) => Number.isFinite(f.qty) && f.qty > 0 && Number.isFinite(f.price))
    .sort((a, b) => a.ts - b.ts);

  for (const fill of fills) {
    const lots = lotsBySymbol.get(fill.symbol) ?? [];
    const run = openRuns.get(fill.symbol);
    let remaining = fill.qty;

    // A sell closes long lots; a buy closes short lots — i.e. match lots whose
    // direction is opposite the fill's. Close oldest first (FIFO).
    while (remaining > 1e-9) {
      const lot = lots[0];
      if (!lot || lot.long === fill.isBuy) break; // same direction → stop closing
      const matched = Math.min(remaining, lot.qty);
      const pnl = lot.long
        ? (fill.price - lot.price) * matched * fill.multiplier // long closed by sell
        : (lot.price - fill.price) * matched * fill.multiplier; // short closed by buy
      pnlByOrder.set(fill.id, (pnlByOrder.get(fill.id) ?? 0) + pnl);
      if (run) run.realizedPnl += pnl;
      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 1e-9) lots.shift();
    }

    // Flat again: the run this symbol was in has ended, and its realized total
    // belongs to that finished trade, not to whatever is opened next.
    if (lots.length === 0) openRuns.delete(fill.symbol);

    // Leftover quantity opens a new lot in this fill's direction (handles flips).
    if (remaining > 1e-9) {
      lots.push({ qty: remaining, price: fill.price, long: fill.isBuy });
      if (!openRuns.has(fill.symbol)) {
        openRuns.set(fill.symbol, { qty: 0, realizedPnl: 0, openedAt: fill.ts });
      }
    }
    lotsBySymbol.set(fill.symbol, lots);
  }

  // Signed quantity of each still-open run, for the caller's reconciliation
  // against the broker. Lots left standing all point the same way by then,
  // because an opposite fill closes them before it can open its own.
  for (const [symbol, lots] of lotsBySymbol) {
    const run = openRuns.get(symbol);
    if (!run) continue;
    if (lots.length === 0) {
      openRuns.delete(symbol);
      continue;
    }
    run.qty = lots.reduce((sum, lot) => sum + (lot.long ? lot.qty : -lot.qty), 0);
  }

  return { pnlByOrder, openRuns };
}

export function computeClosedOrderDisplayQty(order: {
  filled_qty: string | null | undefined;
  qty: string | null | undefined;
}) {
  const filledQty = order.filled_qty != null ? parseFloat(order.filled_qty) : NaN;
  if (Number.isFinite(filledQty) && filledQty > 0) {
    return filledQty;
  }

  const requestedQty = order.qty != null ? parseFloat(order.qty) : NaN;
  if (Number.isFinite(requestedQty)) {
    return requestedQty;
  }

  return 0;
}

export const positionsRouter = router({
  /**
   * Get all positions with current market values and P&L
   */
  list: protectedProcedure
    .input(optionalCredentialSelectorSchema)
    .query(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input?.credentialId,
        accountId: input?.accountId,
      });

      try {
        // Fetch positions, open orders and recent closed orders in parallel.
        //
        // The closed history is what makes RPNL possible: Alpaca's position
        // payload reports unrealized P&L only, so realized P&L banked on a
        // still-open position (a scale-out, a partial take-profit) has to be
        // replayed from the fills. Same window the closed-orders view pairs
        // over, so the two views can never disagree about a symbol.
        const [positions, openOrders, closedOrders] = await Promise.all([
          client.getPositions(),
          client.getOrders("open", 100),
          // RPNL is an annotation on the positions table, not the table. A
          // history read that fails or times out must cost the user their
          // realized column, never the positions themselves, so this one
          // settles to an empty window instead of rejecting the whole query.
          client
            .getOrders("closed", REALIZED_PNL_FILL_WINDOW, false)
            .catch((error) => {
              console.error("[Positions] RPNL history read failed:", error);
              return [] as Awaited<ReturnType<typeof client.getOrders>>;
            }),
        ]);

        const realizedSinceOpen = computeRealizedPnlSinceOpen(closedOrders);

        // Group open orders by symbol for quick lookup, including child legs!
        const ordersBySymbol = new Map<string, any[]>();
        for (const order of openOrders) {
          const sym = order.symbol;
          if (!ordersBySymbol.has(sym)) ordersBySymbol.set(sym, []);
          ordersBySymbol.get(sym)!.push(order);

          // If this order has nested legs (like OCO sl/tp pairs), push them too
          if (order.legs && Array.isArray(order.legs)) {
            for (const leg of order.legs) {
              // Ensure the leg inherits the symbol from its parent just in case
              ordersBySymbol.get(sym)!.push({ ...leg, symbol: sym });
            }
          }
        }

        // Resolve copySourceLabel for each position from our own DB orders
        // table, by symbol. Two sources combine:
        //  1. Currently open exit legs (SL/TP/trailing) placed via
        //     copy-mirror - matched against both the raw clientOrderId and
        //     the bounded broker-facing hash the copy worker actually sends
        //     to Alpaca (see createBrokerClientOrderId); Alpaca's
        //     client_order_id on an open leg is the latter, not the former.
        //  2. The position's own entry order. A filled market/limit entry
        //     drops out of Alpaca's "open" order response the instant it
        //     fills, so it can never be matched via (1) - fall back to the
        //     most recently FILLED copy-mirrored order for this symbol.
        const copySourceByClientId = new Map<string, string>();
        const copySourceBySymbol = new Map<string, string>();
        if (positions.length > 0) {
          const dbRows = await ctx.db
            .select({
              symbol: schema.orders.symbol,
              status: schema.orders.status,
              clientOrderId: schema.orders.clientOrderId,
              copySourceLabel: schema.orders.copySourceLabel,
            })
            .from(schema.orders)
            .where(and(
              eq(schema.orders.userId, ctx.userId),
              isNotNull(schema.orders.copySourceLabel),
              inArray(schema.orders.symbol, positions.map((p) => p.symbol)),
            ))
            .orderBy(desc(schema.orders.statusUpdatedAt));
          for (const row of dbRows) {
            if (!row.clientOrderId || !row.copySourceLabel) continue;
            copySourceByClientId.set(row.clientOrderId, row.copySourceLabel);
            copySourceByClientId.set(
              createBrokerClientOrderId(ctx.userId, row.clientOrderId, "copy"),
              row.copySourceLabel,
            );
            if (row.status === "FILLED" && !copySourceBySymbol.has(row.symbol)) {
              copySourceBySymbol.set(row.symbol, row.copySourceLabel);
            }
          }
        }

        return positions.map((pos) => {
          // Find SL and TP orders linked to this position
          const relatedOrders = ordersBySymbol.get(pos.symbol) || [];

          const stopLossOrders = relatedOrders
            .filter((o: any) => o.type === "stop" || o.type === "stop_limit")
            .map((o: any) => ({
              id: o.id,
              stopPrice: parseFloat(o.stop_price || "0"),
              qty: parseFloat(o.qty || "0"),
              type: o.type,
            }));

          const takeProfitOrders = relatedOrders
            .filter((o: any) => o.type === "limit" && o.side === "sell")
            .map((o: any) => ({
              id: o.id,
              limitPrice: parseFloat(o.limit_price || "0"),
              qty: parseFloat(o.qty || "0"),
            }));

          const trailingStopOrders = relatedOrders
            .filter((o: any) => o.type === "trailing_stop")
            .map((o: any) => ({
              id: o.id,
              trailPercent: o.trail_percent ? parseFloat(o.trail_percent) : null,
              trailPrice: o.trail_price ? parseFloat(o.trail_price) : null,
              stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
              qty: parseFloat(o.qty || "0"),
            }));

          // Find copySourceLabel from any related open order that was placed
          // via copy trading, falling back to the position's own filled
          // entry order (see the DB query above for why both are needed).
          const copySourceLabel =
            relatedOrders
              .map((o: any) => copySourceByClientId.get(o.client_order_id as string))
              .find(Boolean) ?? copySourceBySymbol.get(pos.symbol) ?? null;

          return {
            symbol: pos.symbol,
            assetClass: pos.asset_class, // "us_equity" or "us_option"
            exchange: pos.exchange,
            qty: parseFloat(pos.qty),
            qtyAvailable: parseFloat(pos.qty_available),
            side: pos.side, // "long" or "short"
            avgEntryPrice: parseFloat(pos.avg_entry_price),
            currentPrice: parseFloat(pos.current_price),
            lastDayPrice: parseFloat(pos.lastday_price),
            marketValue: parseFloat(pos.market_value),
            costBasis: parseFloat(pos.cost_basis),
            unrealizedPL: parseFloat(pos.unrealized_pl),
            unrealizedPLPercent: parseFloat(pos.unrealized_plpc) * 100,
            unrealizedIntradayPL: parseFloat(pos.unrealized_intraday_pl),
            unrealizedIntradayPLPercent: parseFloat(pos.unrealized_intraday_plpc) * 100,
            changeToday: parseFloat(pos.change_today) * 100,
            // Realized P&L banked on THIS position since it was opened. Null
            // when the replay cannot vouch for it (see resolveRealizedPnl).
            realizedPnl: resolveRealizedPnl(realizedSinceOpen, pos),
            // Linked bracket orders
            stopLossOrders,
            takeProfitOrders,
            trailingStopOrders,
            // Copy-trade attribution (null for manually placed positions)
            copySourceLabel,
          };
        });
      } catch (error) {
        console.error("[Positions] Failed to fetch positions:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to fetch positions",
        });
      }
    }),

  /**
   * Get a single position by symbol
   */
  get: protectedProcedure
    .input(z.object({ symbol: z.string().min(1).max(50), ...credentialSelectorSchema }))
    .query(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      try {
        const pos = await client.getPosition(input.symbol);

        return {
          symbol: pos.symbol,
          assetClass: pos.asset_class,
          exchange: pos.exchange,
          qty: parseFloat(pos.qty),
          qtyAvailable: parseFloat(pos.qty_available),
          side: pos.side,
          avgEntryPrice: parseFloat(pos.avg_entry_price),
          currentPrice: parseFloat(pos.current_price),
          lastDayPrice: parseFloat(pos.lastday_price),
          marketValue: parseFloat(pos.market_value),
          costBasis: parseFloat(pos.cost_basis),
          unrealizedPL: parseFloat(pos.unrealized_pl),
          unrealizedPLPercent: parseFloat(pos.unrealized_plpc) * 100,
          unrealizedIntradayPL: parseFloat(pos.unrealized_intraday_pl),
          unrealizedIntradayPLPercent: parseFloat(pos.unrealized_intraday_plpc) * 100,
          changeToday: parseFloat(pos.change_today) * 100,
        };
      } catch (error) {
        // Position not found returns 404 from Alpaca
        if (error instanceof Error && error.message.includes("404")) {
          return null;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to fetch position",
        });
      }
    }),

  /**
   * Close a position.
   *
   * Backward-compatible default (no qty + market => existing full closePosition
   * path). When a qty is supplied, or a limit order is requested, we instead
   * place an explicit CLOSING order via client.createOrder. To guarantee we
   * never submit a wrong-side or wrong-qty order, the live position is fetched
   * server-side and used to derive the closing side and to validate qty.
   */
  close: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(50),
        ...credentialSelectorSchema,
        qty: z.number().int().positive().optional(),
        orderType: z.enum(["market", "limit"]).optional(),
        limitPrice: z.number().positive().optional(),
        idempotencyKey: clientOrderIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });
      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "close");

      const orderType = input.orderType ?? "market";

      if (orderType === "limit" && (input.limitPrice === undefined || input.limitPrice <= 0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A positive limit price is required for a limit close",
        });
      }

      // Helper to send Discord notification for position close
      const notifyDiscord = async (symbol: string, orderId: string, method: string) => {
        if (isPaperAccount(credentials.accountType)) return;
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        if (!webhookUrl) return;
        try {
          // Plain bolded text + newlines (no embed) to match the order-status
          // notifications and stay readable on mobile.
          const content = [
            "📤 **Position Closed**",
            "",
            `**Symbol:** ${symbol}`,
            `**Method:** ${method}`,
            `**Order ID:** \`${orderId.slice(0, 8)}...\``,
            "",
            "*TradeBot • Olympus*",
          ].join("\n");
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: "TradeBot",
              content,
            }),
          });
        } catch (err) {
          console.error("[Discord] Close position notification failed:", err);
        }
      };

      // `socialSymbol` defaults to input.symbol (equities close under their
      // own ticker) and is overridden below, once the position is known, to
      // the underlying for an OPTION close. copy-mirror-candidate-sources.ts
      // documents the invariant this preserves: "social_trades only stores
      // the underlying symbol" (it has no option_* columns of its own; a
      // mirror reads contract identity off the joined orders row).
      let socialSymbol = input.symbol;
      const publishClose = async (
        order: any,
        assetType: "EQUITY" | "OPTION",
        localOrderId: string,
      ) => {
        if (isPaperAccount(credentials.accountType)) return;
        try {
          await ctx.db.insert(schema.socialTrades).values({
            userId: ctx.userId,
            symbol: socialSymbol,
            side: order.side || "sell",
            qty: order.qty ? parseFloat(order.qty) : 1,
            orderType: "market",
            assetType,
            limitPrice: null,
            brokerOrderId: order.id,
            orderId: localOrderId,
          });
        } catch (error) {
          console.warn("[Social] Failed publishing position close", error);
        }
      };

      // Partial close and/or limit close: place an explicit closing order.
      // We fetch the live position to learn the true side + available qty so a
      // malicious/stale client can never force a wrong-side or oversized order.
      const isExplicitClose = input.qty !== undefined || orderType === "limit";
      const existingOrder = await ctx.db.query.orders.findFirst({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.clientOrderId, clientOrderId),
        ),
      });
      if (existingOrder?.userId === ctx.userId) {
        if (!existingOrder.brokerOrderId) {
          return {
            success: false,
            syncing: true,
            status: existingOrder.status === "SYNCING" ? "SYNCING" as const : "PENDING" as const,
            orderId: existingOrder.id,
            message: "Close outcome is still syncing with Alpaca",
          };
        }
        return {
          success: true,
          replayed: true,
          orderId: existingOrder.brokerOrderId,
          message: `Position ${input.symbol} close already submitted`,
        };
      }

      let localOrder: {
        id: string;
        userId: string;
        clientOrderId: string | null;
      } | undefined;
      try {
        const position = await client.getPosition(input.symbol);
        const availableQty = Math.abs(parseFloat(position.qty_available));
        const positionQty = Math.abs(parseFloat(position.qty));
        const closeSide = position.side === "long" ? "sell" : "buy";
        const closeAssetType = position.asset_class === "us_option" ? "OPTION" : "EQUITY";
        const requestedQty = input.qty ?? (isExplicitClose ? availableQty : positionQty);

        // Alpaca's option position `symbol` is the OCC contract
        // (AAPL260821C00255000); copy-mirror discovery needs the underlying
        // in `orders.symbol` plus the three option_* columns, exactly like
        // the open path (orders.ts) already records them, and a
        // close-specific trade action (sell_to_close / buy_to_close) rather
        // than the equity-style Sell/Buy the OPTION branch below used to
        // reuse. `parsedContract` is null for an equity close (parse is only
        // attempted below) or, defensively, if a contract symbol doesn't
        // match Alpaca's documented compact layout: in that unexpected case
        // we still close the position (never gate the exit on this) and fall
        // back to the pre-fix recording so nothing regresses.
        const parsedContract =
          closeAssetType === "OPTION" ? parseOccOptionSymbol(input.symbol) : null;
        if (closeAssetType === "OPTION" && !parsedContract) {
          console.warn(
            `[Positions] Could not parse OCC option symbol for mirror recording: ${input.symbol}`,
          );
        }
        if (parsedContract) {
          socialSymbol = parsedContract.underlying;
        }

        if (!Number.isFinite(availableQty) || availableQty <= 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `No available quantity to close for ${input.symbol}`,
          });
        }
        if (isExplicitClose && (!Number.isInteger(requestedQty) || requestedQty < 1)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Close quantity must be a positive integer" });
        }
        if (requestedQty > availableQty) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Close quantity ${requestedQty} exceeds available ${availableQty} for ${input.symbol}`,
          });
        }

        [localOrder] = await ctx.db.insert(schema.orders).values({
          userId: ctx.userId,
          symbol: parsedContract ? parsedContract.underlying : input.symbol,
          assetType: position.asset_class === "us_option" ? "OPTION" : "EQUITY",
          orderType: orderType === "limit" ? "Limit" : "Market",
          tradeAction: parsedContract
            ? (closeSide === "sell" ? "SellToClose" : "BuyToClose")
            : (closeSide === "sell" ? "Sell" : "Buy"),
          direction: position.side === "long" ? "long" : "short",
          quantity: isExplicitClose ? requestedQty : Math.max(1, Math.ceil(requestedQty)),
          limitPrice: input.limitPrice?.toString(),
          optionExpiration: parsedContract?.expiration,
          optionStrike: parsedContract?.strike.toString(),
          optionType: parsedContract?.type,
          status: "PENDING",
          clientOrderId,
          // Only the explicit-close path (client.createOrder, below) ever
          // sends clientOrderId to Alpaca: POST /v2/orders takes
          // client_order_id, but DELETE /v2/positions/{symbol} (the default
          // full-close) accepts only qty/percentage and no order id at all
          // (alpaca-05). Stamping the local id here for a DELETE close would
          // claim Alpaca had seen an id it was never given; on success this
          // gets corrected below to the id Alpaca actually assigned, but on
          // an ambiguous DELETE outcome (no response at all) nothing
          // overwrites it, and OrderSyncPoller would then look up that
          // fabricated id, get a 404, and misread it as proof the close was
          // never submitted when it may well have gone through. Leaving it
          // null there keeps the row honestly unlookupable instead of wrong.
          brokerClientOrderId: isExplicitClose ? clientOrderId : null,
          brokerAccountId: credentials.accountId,
          brokerCredentialId: credentials.credentialId,
        }).returning();
        if (!localOrder) {
          throw new Error("Failed to persist close intent");
        }

        let order;
        let method: string;
        if (isExplicitClose) {
          order = await client.createOrder({
            symbol: input.symbol,
            qty: requestedQty,
            side: closeSide,
            type: orderType,
            // Limit closes rest as GTC (valid for equity and option limit orders);
            // market closes are DAY. resolveTimeInForce enforces the option rule
            // that only limit orders may use GTC.
            time_in_force: resolveTimeInForce({
              assetType: closeAssetType,
              orderType,
              side: closeSide,
              requested: orderType === "limit" ? "gtc" : "day",
            }),
            client_order_id: clientOrderId,
            ...(orderType === "limit" && { limit_price: input.limitPrice }),
          });
          method = orderType === "limit" ? "Limit Close" : "Partial Market Close";
        } else {
          try {
            order = await client.closePosition(input.symbol);
            method = "Standard Close";
          } catch (error: any) {
            if (isAlpacaAmbiguousOrderError(error)) throw error;
            const isForbidden = error?.response?.status === 403 || error?.message?.includes("403");
            if (!isForbidden) throw error;
            order = await client.createOrder({
              symbol: input.symbol,
              qty: requestedQty,
              side: closeSide,
              type: "market",
              time_in_force: "day",
              client_order_id: clientOrderId,
            });
            method = "Manual Close (403 fallback)";
          }
        }

        const brokerClientOrderId = order.client_order_id || clientOrderId;
        try {
          const updated = await ctx.db.update(schema.orders).set({
            status: "SUBMITTED",
            brokerOrderId: order.id,
            brokerClientOrderId,
            syncReason: null,
            statusUpdatedAt: new Date(),
          }).where(and(
            eq(schema.orders.id, localOrder.id),
            eq(schema.orders.userId, ctx.userId),
            eq(schema.orders.clientOrderId, clientOrderId),
            orderStatusTransitionCondition("SUBMITTED"),
            preserveBrokerOrderIdCondition(order.id),
          )).returning({ id: schema.orders.id });
          if (updated.length !== 1) {
            throw new Error(
              `manual close acceptance CAS returned ${updated.length} order rows; exactly one is required`,
            );
          }
        } catch {
          let authoritative: AuthoritativeCloseState | null = null;
          try {
            authoritative = await readAuthoritativeCloseState(ctx.db, localOrder);
          } catch (readError) {
            console.error("[Positions] Failed to reread accepted close state", readError);
          }

          // A concurrent worker may already have advanced the local row. Do not
          // write SYNCING over that state or emit close side effects from a
          // transition this request did not win.
          if (
            authoritative &&
            authoritative.status !== "PENDING" &&
            authoritative.status !== "SYNCING"
          ) {
            return closeStateResponse(
              authoritative,
              order.id,
              "Alpaca accepted the close; another writer advanced local state",
            );
          }

          try {
            const syncing = await ctx.db.update(schema.orders).set({
              status: "SYNCING",
              brokerOrderId: order.id,
              brokerClientOrderId,
              syncReason: `Broker accepted ${order.id}; local acceptance persistence failed`,
              syncAttempts: sql`${schema.orders.syncAttempts} + 1`,
              lastSyncAttemptAt: new Date(),
              statusUpdatedAt: new Date(),
            }).where(and(
              eq(schema.orders.id, localOrder.id),
              eq(schema.orders.userId, ctx.userId),
              eq(schema.orders.clientOrderId, clientOrderId),
              orderStatusTransitionCondition("SYNCING"),
              preserveBrokerOrderIdCondition(order.id),
            )).returning({ id: schema.orders.id });
            if (syncing.length !== 1) {
              console.warn("[Positions] Accepted close reconciliation CAS did not win", {
                orderId: localOrder.id,
                brokerOrderId: order.id,
                returnedRows: syncing.length,
              });
            }
          } catch (syncError) {
            console.error("[Positions] Failed to mark accepted close for reconciliation", syncError);
          }

          try {
            authoritative = await readAuthoritativeCloseState(ctx.db, localOrder);
          } catch (readError) {
            console.error("[Positions] Failed to reread close reconciliation state", readError);
          }
          if (authoritative) {
            return closeStateResponse(
              authoritative,
              order.id,
              "Alpaca accepted the close; local status is syncing",
            );
          }
          return {
            success: false,
            syncing: true,
            status: "SYNCING" as const,
            orderId: localOrder.id,
            brokerOrderId: order.id,
            message: "Alpaca accepted the close; local status is syncing",
          };
        }
        await notifyDiscord(input.symbol, order.id, method);
        await publishClose(
          order,
          position.asset_class === "us_option" ? "OPTION" : "EQUITY",
          localOrder.id,
        );

        return {
          success: true,
          orderId: order.id,
          message: isExplicitClose
            ? `Submitted ${orderType} close for ${requestedQty} of ${input.symbol}`
            : `Position ${input.symbol} closed`,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        if (isAlpacaAmbiguousOrderError(error)) {
          if (localOrder) {
            let authoritative: AuthoritativeCloseState | null = null;
            try {
              authoritative = await readAuthoritativeCloseState(ctx.db, localOrder);
            } catch (readError) {
              console.error("[Positions] Failed to reread ambiguous close state", readError);
            }
            if (authoritative && !["PENDING", "SYNCING"].includes(authoritative.status)) {
              return closeStateResponse(
                authoritative,
                null,
                "Close outcome is ambiguous; another writer advanced local state",
              );
            }
            try {
              const syncingRows = await ctx.db.update(schema.orders).set({
                status: "SYNCING",
                syncReason: "Alpaca close outcome is ambiguous",
                syncAttempts: sql`${schema.orders.syncAttempts} + 1`,
                lastSyncAttemptAt: new Date(),
                statusUpdatedAt: new Date(),
              }).where(and(
                eq(schema.orders.id, localOrder.id),
                eq(schema.orders.userId, ctx.userId),
                eq(schema.orders.clientOrderId, clientOrderId),
                orderStatusTransitionCondition("SYNCING"),
              )).returning({ id: schema.orders.id });
              if (syncingRows.length !== 1) {
                console.warn("[Positions] Ambiguous close reconciliation CAS did not win", {
                  orderId: localOrder.id,
                  returnedRows: syncingRows.length,
                });
              }
            } catch (syncError) {
              console.error("[Positions] Failed to persist ambiguous close state", syncError);
            }
            try {
              authoritative = await readAuthoritativeCloseState(ctx.db, localOrder);
            } catch (readError) {
              console.error("[Positions] Failed to reread ambiguous close reconciliation state", readError);
            }
            if (authoritative) {
              return closeStateResponse(
                authoritative,
                null,
                "Close outcome is ambiguous and is syncing with Alpaca",
              );
            }
          }
          return {
            success: false,
            syncing: true,
            status: "SYNCING" as const,
            orderId: localOrder?.id,
            message: "Close outcome is ambiguous and is syncing with Alpaca",
          };
        }
        if (localOrder) {
          try {
            const rejectedRows = await ctx.db.update(schema.orders).set({
              status: "REJECTED",
              statusUpdatedAt: new Date(),
            }).where(and(
              eq(schema.orders.id, localOrder.id),
              eq(schema.orders.userId, ctx.userId),
              eq(schema.orders.clientOrderId, clientOrderId),
              orderStatusTransitionCondition("REJECTED"),
            )).returning({ id: schema.orders.id });
            if (rejectedRows.length !== 1) {
              const authoritative = await readAuthoritativeCloseState(ctx.db, localOrder);
              if (authoritative) {
                return closeStateResponse(
                  authoritative,
                  null,
                  "Close failed; local state was advanced by another writer",
                );
              }
              console.warn("[Positions] Close rejection CAS did not win", {
                orderId: localOrder.id,
                returnedRows: rejectedRows.length,
              });
            }
          } catch (persistError) {
            console.error("[Positions] Failed to persist rejected close state", persistError);
          }
        }
        const errorMsg = error?.response?.data?.message ??
          (error instanceof Error ? error.message : "Failed to close position");
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errorMsg });
      }
    }),

  /**
   * Close all positions
   */
  closeAll: protectedProcedure
    .input(z.object({
      cancelOrders: z.boolean().default(true),
      ...credentialSelectorSchema,
      idempotencyKey: clientOrderIdSchema.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client, credentials } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      try {
        // DELETE /v2/positions returns HTTP 207 Multi-Status: the SDK passes
        // the response body through unchanged, so this is really an array of
        // {symbol, status, body} envelopes (one per position), NOT an
        // AlpacaOrder[] the way the wrapper's return type claims (alpaca-06).
        // `status` is the per-position HTTP result of that individual close
        // and `body` holds the actual Order fields; reading side/qty/id off
        // the envelope itself reads undefined, and skipping the status check
        // would publish a refused close (e.g. a 403 wash-trade rejection) as
        // a completed trade.
        const closeResults = await client.closeAllPositions(input.cancelOrders) as unknown as Array<{
          symbol?: string;
          status?: number;
          body?: { id?: string; symbol?: string; side?: string; qty?: string | null } | null;
        }>;

        // Publish all accepted live-account closes to social. Paper/SIM closes
        // stay private and never enter the leaderboard.
        try {
          if (!isPaperAccount(credentials.accountType) && Array.isArray(closeResults)) {
            // Only the per-position envelopes Alpaca actually accepted. A
            // refused close (e.g. a 403 wash-trade rejection) carries no order
            // and must never be published as a completed trade.
            const acceptedOrderIds = closeResults
              .filter((result) => {
                const status = Number(result?.status);
                return Number.isFinite(status) && status >= 200 && status < 300;
              })
              .map((result) => result?.body?.id)
              .filter((id): id is string => typeof id === "string" && id.length > 0);
            const brokerOrderIds = acceptedOrderIds;
            const localOrders = brokerOrderIds.length === 0
              ? []
              : await ctx.db.query.orders.findMany({
                  where: and(
                    eq(schema.orders.userId, ctx.userId),
                    inArray(schema.orders.brokerOrderId, brokerOrderIds),
                    or(
                      credentials.accountId
                        ? eq(schema.orders.brokerAccountId, credentials.accountId)
                        : eq(schema.orders.brokerCredentialId, credentials.credentialId),
                      and(
                        eq(schema.orders.brokerCredentialId, credentials.credentialId),
                        credentials.accountId
                          ? or(
                              eq(schema.orders.brokerAccountId, credentials.accountId),
                              isNull(schema.orders.brokerAccountId),
                            )
                          : undefined,
                      ),
                    ),
                    or(eq(schema.orders.venue, "alpaca"), isNull(schema.orders.venue)),
                  ),
                  columns: {
                    id: true,
                    brokerOrderId: true,
                    symbol: true,
                    assetType: true,
                    tradeAction: true,
                    direction: true,
                    quantity: true,
                    orderType: true,
                    limitPrice: true,
                  },
                });
            const localOrdersByBrokerId = new Map<string, typeof localOrders>();
            for (const localOrder of localOrders) {
              if (!localOrder.brokerOrderId) continue;
              const matches = localOrdersByBrokerId.get(localOrder.brokerOrderId) ?? [];
              matches.push(localOrder);
              localOrdersByBrokerId.set(localOrder.brokerOrderId, matches);
            }
            for (const brokerOrderId of acceptedOrderIds) {
              // The local order row is what carries contract identity: symbol
              // (the UNDERLYING for an option), asset type, action and size.
              // Alpaca's 207 body gives the OCC contract string and no asset
              // class, so publishing from it directly would record an option
              // close as an equity trade under a symbol that is not a ticker.
              const event = resolveCloseAllSocialEvent(
                { id: brokerOrderId },
                localOrdersByBrokerId.get(brokerOrderId) ?? [],
              );
              if (!event) continue;
              await ctx.db.insert(schema.socialTrades).values({
                userId: ctx.userId,
                orderId: event.orderId,
                brokerOrderId: event.brokerOrderId,
                symbol: event.symbol,
                side: event.side,
                qty: event.qty,
                assetType: event.assetType,
                limitPrice: event.limitPrice,
                orderType: event.orderType.toLowerCase(),
              });
            }
          }
        } catch (e) {
           console.warn("[Social] Failed publishing closeAll", e);
        }

        return {
          success: true,
          message: "All positions closed",
        };
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) {
          return {
            success: false,
            syncing: true,
            status: "PENDING" as const,
            message: "Close-all outcome is ambiguous and is syncing with Alpaca",
          };
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to close all positions",
        });
      }
    }),

  /**
   * Get account summary (buying power, equity, etc.)
   */
  account: protectedProcedure
    .input(optionalCredentialSelectorSchema)
    .query(async ({ ctx, input }) => {
    // Audit M12: shared credential fetch + client construction; the factory
    // throws a friendly BAD_REQUEST when credentials are incomplete.
    const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
      credentialId: input?.credentialId,
      accountId: input?.accountId,
    });

    try {
      const account = await client.getAccount();

      return {
        accountNumber: account.account_number,
        status: account.status,
        currency: account.currency,
        // buying_power is margin-inflated (2x or 4x equity under margin rules). It is
        // not what Alpaca checks for non-marginable securities, so exposing
        // it as the primary display figure misleads users into thinking they
        // can spend that amount on any stock. Kept here for internal use
        // (e.g. copy-trade allocation math on marginable symbols).
        buyingPower: parseFloat(account.buying_power),
        // nonMarginableBuyingPower is the guaranteed floor: the cash Alpaca
        // will actually use for non-marginable securities. This is the
        // correct number to surface in the UI header and portfolio page.
        nonMarginableBuyingPower: parseFloat(account.non_marginable_buying_power),
        // regtBuyingPower is the overnight margin limit (2x equity) -- the
        // ceiling for marginable overnight positions.
        regtBuyingPower: parseFloat(account.regt_buying_power),
        cash: parseFloat(account.cash),
        portfolioValue: parseFloat(account.portfolio_value),
        equity: parseFloat(account.equity),
        lastEquity: parseFloat(account.last_equity),
        longMarketValue: parseFloat(account.long_market_value),
        shortMarketValue: parseFloat(account.short_market_value),
        initialMargin: parseFloat(account.initial_margin),
        maintenanceMargin: parseFloat(account.maintenance_margin),
        tradingBlocked: account.trading_blocked,
        shortingEnabled: account.shorting_enabled,
      };
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : "Failed to fetch account",
      });
    }
  }),

  /**
   * Get portfolio history (equity / P&L time series) for the active account.
   *
   * Maps the UI period to Alpaca's period/timeframe pair, calls the raw
   * portfolio-history endpoint, and returns a normalized series via
   * normalizePortfolioHistory (the unit under test).
   */
  portfolioHistory: protectedProcedure
    .input(
      z.object({
        credentialId: z.string().uuid().optional(),
        period: z.enum(["1D", "1W", "1M", "ALL"]).default("1M"),
      })
    )
    .query(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
      });

      try {
        const raw = await client.getPortfolioHistory(portfolioHistoryPeriodParams[input.period]);
        return normalizePortfolioHistory(raw, input.period);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to fetch portfolio history",
        });
      }
    }),

  /**
   * Create exit strategy for an existing position
   * Supports: Multiple Take Profits + Trailing Stop + Stop Loss
   */
  createExitStrategy: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(50),
        ...credentialSelectorSchema,
        /** "sell" closes a long; "buy" closes a short. Defaults to "sell". */
        exitSide: z.enum(["buy", "sell"]).optional(),
        takeProfits: z.array(
          z.object({
            price: z.number().positive(),
            qty: z.number().int().positive(),
          })
        ),
        trailingStop: z
          .object({
            qty: z.number().int().positive(),
            trailPercent: z.number().positive().optional(),
            trailPrice: z.number().positive().optional(),
          })
          .optional(),
        stopLoss: z
          .object({
            stopPrice: z.number().positive(),
            qty: z.number().int().positive(),
          })
          .optional(),
        idempotencyKey: clientOrderIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });
      const clientOrderId = resolveClientOrderId(ctx.userId, input.idempotencyKey, "exit");

      try {
        const result = await client.createExitStrategy({
          client_order_id: clientOrderId,
          symbol: input.symbol,
          exitSide: input.exitSide,
          takeProfits: input.takeProfits,
          trailingStop: input.trailingStop,
          stopLoss: input.stopLoss,
        });

        return {
          success: result.errors.length === 0,
          takeProfitOrderIds: result.takeProfitOrderIds,
          trailingStopOrderId: result.trailingStopOrderId,
          stopLossOrderId: result.stopLossOrderId,
          errors: result.errors,
          message:
            result.errors.length === 0
              ? "Exit strategy created successfully"
              : `Partial success with ${result.errors.length} error(s)`,
        };
      } catch (error) {
        if (isAlpacaAmbiguousOrderError(error)) {
          return {
            success: false,
            syncing: true,
            status: "PENDING" as const,
            takeProfitOrderIds: [],
            trailingStopOrderId: undefined,
            stopLossOrderId: undefined,
            errors: ["Exit strategy outcome is ambiguous and is syncing with Alpaca"],
            message: "Exit strategy outcome is ambiguous and is syncing with Alpaca",
          };
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to create exit strategy",
        });
      }
    }),

  /**
   * Get recent closed/filled orders (history) for the active account.
   *
   * MVP "Closed positions" view: this returns a flat list of recently closed
   * orders (filled, canceled, expired, etc.) rather than realized-P&L pairing.
   * Each row is shaped defensively so no string/null leaks to the client.
   */
  closedOrders: protectedProcedure
    .input(
      z.object({
        ...credentialSelectorSchema,
        limit: z.number().int().positive().max(200).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      try {
        const displayLimit = input.limit ?? 50;
        // Fetch a wider window than we display so a recent close can be paired
        // with its (older) opening fill when computing realized P&L.
        const fetchLimit = Math.min(500, Math.max(displayLimit, REALIZED_PNL_FILL_WINDOW));
        // Closed history is a flat execution/cancel log. With nested=true,
        // Alpaca can tuck a filled OCO/bracket exit leg under its canceled
        // sibling, causing the UI to show the canceled parent and hide the
        // actual fill. Fetch flat rows so each broker order keeps its own status.
        const orders = await client.getOrders("closed", fetchLimit, false);

        const realizedPnlByOrder = computeRealizedPnlByOrder(orders);

        // Batch-fetch copy-trade attribution from local DB by client_order_id.
        // Support legacy raw mirror IDs and the bounded broker-facing hash.
        const mirrorClientIds = orders
          .map((o) => o.client_order_id)
          .filter((id): id is string =>
            typeof id === "string" &&
            (id.startsWith("copymirror:") || id.startsWith("rst-copy-")),
          );

        const copySourceByClientId = new Map<string, string>();
        if (mirrorClientIds.length > 0) {
          const localOrders = await ctx.db
            .select({
              clientOrderId: schema.orders.clientOrderId,
              copySourceLabel: schema.orders.copySourceLabel,
            })
            .from(schema.orders)
            .where(and(
              eq(schema.orders.userId, ctx.userId),
              isNotNull(schema.orders.copySourceLabel),
            ));
          for (const row of localOrders) {
            if (row.clientOrderId && row.copySourceLabel) {
              copySourceByClientId.set(row.clientOrderId, row.copySourceLabel);
              copySourceByClientId.set(
                createBrokerClientOrderId(ctx.userId, row.clientOrderId, "copy"),
                row.copySourceLabel,
              );
            }
          }
        }

        const rows = orders.map((order): ClosedOrderResponse => {
          const qty = computeClosedOrderDisplayQty(order);

          const fillPriceRaw =
            order.filled_avg_price != null ? parseFloat(order.filled_avg_price) : null;

          const pnl = realizedPnlByOrder.get(order.id);

          return {
            id: order.id,
            symbol: order.symbol,
            side: order.side, // "buy" | "sell"
            qty: Number.isFinite(qty) ? qty : 0,
            fillPrice: fillPriceRaw != null && Number.isFinite(fillPriceRaw) ? fillPriceRaw : null,
            filledAt: order.filled_at ?? null,
            submittedAt: order.submitted_at,
            status: order.status,
            orderType: order.order_type,
            assetClass: order.asset_class,
            realizedPnl: pnl != null && Number.isFinite(pnl) ? pnl : null,
            copySourceLabel: copySourceByClientId.get(order.client_order_id) ?? null,
          };
        });

        // Pairing used the wider window; only return the requested page.
        return rows.slice(0, displayLimit);
      } catch (error) {
        console.error("[Positions] Failed to fetch closed orders:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to fetch closed orders",
        });
      }
    }),

  /**
   * Update the stop price of an existing stop-loss order
   */
  updateStopLoss: protectedProcedure
    .input(
      z.object({
        ...credentialSelectorSchema,
        stopOrderId: z.string().min(1),
        stopPrice: z.number().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });
      const stopPrice = roundStopPriceUpToCents(input.stopPrice);

      try {
        const order = await client.replaceOrder(input.stopOrderId, {
          stop_price: stopPrice,
        });
        return { success: true, orderId: order.id, stopPrice, message: "Stop loss updated" };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to update stop loss",
        });
      }
    }),

  /**
   * Update the limit price of an existing take-profit order
   */
  updateTakeProfit: protectedProcedure
    .input(
      z.object({
        ...credentialSelectorSchema,
        tpOrderId: z.string().min(1),
        limitPrice: z.number().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      try {
        const order = await client.replaceOrder(input.tpOrderId, {
          limit_price: input.limitPrice,
        });
        return {
          success: true,
          orderId: order.id,
          limitPrice: input.limitPrice,
          message: "Take profit updated",
        };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to update take profit",
        });
      }
    }),

  /**
   * Cancel an exit order (stop loss, take profit, or trailing stop) by order ID.
   * Calls Alpaca's DELETE /v2/orders/{id} endpoint.
   */
  cancelExitOrder: protectedProcedure
    .input(
      z.object({
        ...credentialSelectorSchema,
        orderId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Audit M12: shared credential fetch + client construction; the factory
      // throws a friendly BAD_REQUEST when credentials are incomplete.
      const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
        credentialId: input.credentialId,
        accountId: input.accountId,
      });

      try {
        // Alpaca cancels every order in a bracket/OCO group when any one member
        // is canceled, so a single stop-loss delete can silently take the
        // take-profit (or vice versa) with it. Find the linked group first so
        // the caller can be told the full set of orders that will disappear.
        const openOrders = await client.getOrders("open", 100);
        let cancelledOrderIds = [input.orderId];
        for (const order of openOrders) {
          const groupIds = [order.id, ...(order.legs ?? []).map((leg) => leg.id)];
          if (groupIds.includes(input.orderId) && groupIds.length > 1) {
            cancelledOrderIds = groupIds;
            break;
          }
        }

        await client.cancelOrder(input.orderId);

        const message =
          cancelledOrderIds.length > 1
            ? "This order was linked to another protective order, so both were cancelled together"
            : "Order cancelled";

        return { success: true, orderId: input.orderId, cancelledOrderIds, message };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to cancel order",
        });
      }
    }),

  /**
   * List Hyperliquid perp positions for the user (sibling — the equity `list`
   * above is untouched). Maps `clearinghouseState.assetPositions` to normalized
   * rows: coin, side, size, entryPx, markPx, liquidationPx, unrealizedPnl,
   * leverage + margin mode, marginUsed, funding. Returns an empty list when the
   * user has not enabled perps.
   */
  listPerps: protectedProcedure.query(async ({ ctx }) => {
    const network = networkFromEnv();
    const walletAddress = await resolveHlWalletAddress(ctx.db, ctx.userId);
    if (!walletAddress) {
      return { positions: [], crossMargin: null, network };
    }

    const info = createHyperliquidInfoClient({ network });
    // Cross-margin summary rides along from the SAME clearinghouseState round
    // trip the positions read already makes, so the size presets on the ticket
    // cost no extra request on this 30s poll.
    const { positions, crossMargin } = await info.perpAccountSnapshot(walletAddress);
    const knownFills = await ctx.db.query.orders.findMany({
      where: and(
        eq(schema.orders.userId, ctx.userId),
        eq(schema.orders.venue, "hyperliquid"),
        eq(schema.orders.assetType, "PERP"),
        inArray(schema.orders.status, ["FILLED", "PARTIAL"]),
        or(isNull(schema.orders.venueNetwork), eq(schema.orders.venueNetwork, network)),
      ),
      columns: {
        symbol: true,
        tradeAction: true,
        executedSizeDecimal: true,
        realizedPnl: true,
        executedAt: true,
      },
    });
    const realizedByCoin = realizedPnlForOpenPerps(knownFills, positions);
    return {
      positions: positions.map((position) => ({
        ...position,
        realizedPnl: realizedByCoin.get(position.coin) ?? null,
      })),
      crossMargin,
      network,
    };
  }),

  /**
   * List recent Hyperliquid perp fills (trade history) for the user. Reads HL
   * `userFills` via the keyless InfoClient for the master address and returns
   * normalized rows (time, coin, side, px, sz, closedPnl, fee, dir, oid, hash).
   * Cross-references each fill's `oid` against the DB `orders.brokerOrderId` to
   * attach `orderType` (e.g. "StopMarket", "TakeProfitMarket") so the UI can
   * display SL/TP badges on matched fills.
   * Returns an empty list when the user has not enabled perps. Read-only.
   */
  listPerpFills: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(500).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const network = networkFromEnv();
      const walletAddress = await resolveHlWalletAddress(ctx.db, ctx.userId);
      if (!walletAddress) {
        return { fills: [], network };
      }

      const info = createHyperliquidInfoClient({ network });
      const fills = await info.listFills(walletAddress, input?.limit ?? 50);

      // Cross-reference fill oids with DB orders to identify SL/TP fill types.
      // Only runs when there are fills to look up; uses a single IN query so it
      // does not fan out per fill.
      let oidToOrderType: Record<number, string> = {};
      if (fills.length > 0) {
        const oids = fills.map((f) => String(f.oid));
        const matchedOrders = await ctx.db.query.orders.findMany({
          where: and(
            eq(schema.orders.userId, ctx.userId),
            eq(schema.orders.venue, "hyperliquid"),
            inArray(schema.orders.brokerOrderId, oids),
          ),
          columns: { brokerOrderId: true, orderType: true },
        });
        for (const row of matchedOrders) {
          if (row.brokerOrderId) {
            oidToOrderType[Number(row.brokerOrderId)] = row.orderType;
          }
        }
      }

      const enrichedFills = fills.map((f) => ({
        ...f,
        orderType: oidToOrderType[f.oid] ?? null,
      }));

      return { fills: enrichedFills, network };
    }),

  /**
   * List the user's OPEN Hyperliquid orders (resting trigger / limit orders).
   *
   * `listPerps` above returns clearinghouse POSITIONS only, never the resting
   * trigger ORDERS a user attached (stop-loss / take-profit). This reads them
   * via HL `frontendOpenOrders` for the master address so the UI can surface a
   * position's attached TP/SL legs (and offer a per-order cancel). Read-only
   * (keyless InfoClient), so no agent-ready gate is required. Returns an empty
   * list when the user has not enabled perps.
   */
  listPerpOpenOrders: protectedProcedure.query(async ({ ctx }) => {
    const network = networkFromEnv();
    const walletAddress = await resolveHlWalletAddress(ctx.db, ctx.userId);
    if (!walletAddress) {
      return { orders: [], network };
    }

    const info = createHyperliquidInfoClient({ network });
    const orders = await info.listOpenOrders(walletAddress);
    return { orders, network };
  }),
});
