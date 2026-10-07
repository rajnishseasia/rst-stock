/**
 * Charts Router
 *
 * Provides normalized trade execution data for chart overlays.
 * Returns filled orders as ChartExecutionGroup objects that the
 * frontend LiveChart component renders as positioned bubbles.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { schema } from "@trade-bot/db";
import type { AlpacaOrder } from "@trade-bot/alpaca";
import { eq, and, inArray, isNotNull, asc } from "drizzle-orm";
import { getAlpacaClient } from "../lib/alpaca.js";

const BUY_ACTIONS = ["Buy", "BuyToCover", "BuyToOpen", "BuyToClose"];

export function isBuySide(tradeAction: string | null | undefined): boolean {
  return BUY_ACTIONS.includes(tradeAction ?? "");
}

export interface ChartExecutionGroup {
  id: string;
  kind: "execution_group";
  symbol: string;
  anchorTime: number;
  anchorPrice: number;
  side: "BUY" | "SELL";
  status: "self";
  quantity: number;
  orderType: string | null;
  tradeAction: string | null;
  assetType?: string | null;
  brokerOrderId?: string | null;
  source: "alpaca" | "db";
}

type DbFilledOrder = {
  id: string;
  symbol: string;
  tradeAction: string | null;
  orderType: string | null;
  executedAt: Date | null;
  statusUpdatedAt: Date | null;
  executedPrice: string | null;
  executedQuantity: number | null;
  quantity: number;
  assetType: string | null;
  brokerOrderId: string | null;
};

function finiteNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildDbExecutionGroup(order: DbFilledOrder): ChartExecutionGroup | null {
  const price = finiteNumber(order.executedPrice);
  if (price == null || price <= 0) return null;

  // Anchor only to a real fill timestamp. `executedAt` is the fill time;
  // `statusUpdatedAt` is when the row flipped to FILLED/PARTIAL (a close proxy
  // for legacy rows persisted before `executedAt` was tracked). We deliberately
  // do NOT fall back to `updatedAt`/`createdAt` — those are submission/last-touch
  // times and would pin the marker far from where the trade actually filled.
  const timestamp = order.executedAt ?? order.statusUpdatedAt;
  if (!timestamp) return null;
  const anchorTime = Math.floor(timestamp.getTime() / 1000);
  if (!Number.isFinite(anchorTime) || anchorTime <= 0) return null;

  return {
    id: order.brokerOrderId ? `broker:${order.brokerOrderId}` : `order:${order.id}`,
    kind: "execution_group",
    symbol: order.symbol,
    anchorTime,
    anchorPrice: price,
    side: isBuySide(order.tradeAction) ? "BUY" : "SELL",
    status: "self",
    quantity: order.executedQuantity ?? order.quantity ?? 0,
    orderType: order.orderType,
    tradeAction: order.tradeAction,
    assetType: order.assetType,
    brokerOrderId: order.brokerOrderId,
    source: "db",
  };
}

export function buildAlpacaExecutionGroup(
  order: AlpacaOrder,
  symbol: string
): ChartExecutionGroup | null {
  if (order.symbol.toUpperCase() !== symbol.toUpperCase()) return null;

  const quantity = finiteNumber(order.filled_qty);
  const price = finiteNumber(order.filled_avg_price);
  if (quantity == null || quantity <= 0 || price == null || price <= 0) return null;

  // Require the actual fill time. A (partial) fill without `filled_at` would
  // otherwise be pinned to submission/creation time, placing the bubble on an
  // unrelated candle. If Alpaca hasn't reported a fill time yet, skip it — the
  // local DB row (anchored on its own fill time) can still represent it.
  if (!order.filled_at) return null;
  const anchorTime = Math.floor(new Date(order.filled_at).getTime() / 1000);
  if (!Number.isFinite(anchorTime) || anchorTime <= 0) return null;

  const side = order.side === "buy" ? "BUY" : "SELL";

  return {
    id: `broker:${order.id}`,
    kind: "execution_group",
    symbol: order.symbol.toUpperCase(),
    anchorTime,
    anchorPrice: price,
    side,
    status: "self",
    quantity,
    orderType: order.order_type ?? order.type ?? null,
    tradeAction: side === "BUY" ? "Buy" : "Sell",
    assetType: order.asset_class,
    brokerOrderId: order.id,
    source: "alpaca",
  };
}

/**
 * Content signature for an execution, used to dedupe across sources when no
 * broker order id is available to match on. The worker persists `executedAt`
 * from Alpaca's `filled_at`, so the same fill produces an identical anchorTime
 * (and side/qty/price) on both the DB and Alpaca sides.
 */
function executionContentKey(group: ChartExecutionGroup): string {
  return `sig:${group.symbol}:${group.side}:${group.anchorTime}:${group.quantity}:${group.anchorPrice}`;
}

export function mergeExecutionGroups(
  dbGroups: ChartExecutionGroup[],
  alpacaGroups: ChartExecutionGroup[]
): ChartExecutionGroup[] {
  // Alpaca is authoritative for a given execution (it carries the real
  // filled_at), so it always wins on a match. Index Alpaca rows by BOTH their
  // broker order id and a content signature: the signature lets us dedupe a
  // local DB fill whose `brokerOrderId` hasn't been linked yet against its
  // matching Alpaca row (the previous broker-id-only key let such a pair slip
  // through as two markers).
  const alpacaByBroker = new Map<string, ChartExecutionGroup>();
  const alpacaByContent = new Set<string>();
  for (const group of alpacaGroups) {
    if (group.brokerOrderId) alpacaByBroker.set(group.brokerOrderId, group);
    alpacaByContent.add(executionContentKey(group));
  }

  const merged: ChartExecutionGroup[] = [...alpacaGroups];
  for (const group of dbGroups) {
    if (group.brokerOrderId) {
      // Broker-confirmed DB row: it is unambiguously its own execution. Drop it
      // only when Alpaca reports the SAME broker order (Alpaca wins on fill-time
      // accuracy). Never drop it on a mere content-signature collision with a
      // *different* Alpaca order — that would lose a real, distinct fill.
      if (alpacaByBroker.has(group.brokerOrderId)) continue;
      merged.push(group);
      continue;
    }
    // No broker id linked yet: fall back to the content signature so we don't
    // double-render the same fill Alpaca already reported.
    if (alpacaByContent.has(executionContentKey(group))) continue;
    merged.push(group);
  }

  return merged.sort((a, b) => a.anchorTime - b.anchorTime);
}

export const chartsRouter = router({
  /**
   * Returns filled orders for a symbol formatted as chart execution groups.
   * These are rendered as trade marker bubbles on the LiveChart overlay.
   *
   * When credentialId or accountId is supplied the results are scoped to
   * that broker account so multi-account users see the right annotations.
   */
  getChartAnnotations: protectedProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(20).transform((v) => v.toUpperCase()),
        credentialId: z.string().uuid().optional(),
        accountId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Resolve a broker account ID filter from the supplied credential so
      // users with multiple accounts only see annotations for the active one.
      let brokerAccountId: string | undefined;

      if (input.credentialId) {
        const cred = await ctx.db.query.userApiCredentials.findFirst({
          where: (c, { eq: ceq, and: cand }) =>
            cand(ceq(c.userId, ctx.userId), ceq(c.id, input.credentialId!)),
          columns: { accountId: true },
        });
        brokerAccountId = cred?.accountId ?? undefined;
      } else if (input.accountId) {
        brokerAccountId = input.accountId;
      }

      const filledOrders = await ctx.db.query.orders.findMany({
        where: and(
          eq(schema.orders.userId, ctx.userId),
          eq(schema.orders.symbol, input.symbol),
          inArray(schema.orders.status, ["FILLED", "PARTIAL"]),
          isNotNull(schema.orders.executedPrice),
          // Only filter by broker account when we have a resolved ID; otherwise
          // show all accounts (single-account users, or no active credential).
          ...(brokerAccountId
            ? [eq(schema.orders.brokerAccountId, brokerAccountId)]
            : []),
        ),
        orderBy: [asc(schema.orders.executedAt)],
        columns: {
          id: true,
          symbol: true,
          tradeAction: true,
          orderType: true,
          executedAt: true,
          statusUpdatedAt: true,
          executedPrice: true,
          executedQuantity: true,
          quantity: true,
          status: true,
          assetType: true,
          brokerOrderId: true,
        },
      });

      const dbGroups = filledOrders
        .map((order) => buildDbExecutionGroup(order))
        .filter((group): group is ChartExecutionGroup => group !== null);

      let alpacaGroups: ChartExecutionGroup[] = [];
      if (input.credentialId || input.accountId) {
        try {
          const { client } = await getAlpacaClient(ctx.db, ctx.userId, {
            accountId: input.accountId,
            credentialId: input.credentialId,
          });
          const alpacaOrders = await client.getOrders("closed", 500, false);
          alpacaGroups = alpacaOrders
            .map((order) => buildAlpacaExecutionGroup(order, input.symbol))
            .filter((group): group is ChartExecutionGroup => group !== null);
        } catch (error) {
          // Do not break chart rendering if Alpaca history is temporarily
          // unavailable. Local DB annotations still render when present.
          console.warn("[Charts] Failed to fetch Alpaca execution history", error);
        }
      }

      const executionGroups = mergeExecutionGroups(dbGroups, alpacaGroups);

      return { executionGroups };
    }),
});
