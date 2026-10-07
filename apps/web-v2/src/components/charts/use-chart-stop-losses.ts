"use client";

/**
 * The stop-loss levels for the instrument currently on the chart.
 *
 * Reads the venue's resting protective orders (never the database's record of
 * what a stop was asked to be) and folds them with `stop-loss-lines.ts`. See
 * that module for why the live orders are the only honest source.
 *
 * Kept out of `advanced-chart.tsx`: that file is at the god-component
 * threshold in CLAUDE.md, and this is exactly the "stateful logic into a named
 * hook" extraction the rule asks for.
 */

import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import {
  equityStopLossLines,
  perpStopLossLines,
  type StopLossLine,
} from "./stop-loss-lines";

/**
 * Stops move rarely compared to price. A minute is fast enough to notice a
 * stop the user just placed and slow enough that a chart open all day is not
 * a meaningful load on either venue.
 */
export const STOP_LOSS_POLL_MS = 60_000;

/**
 * Poll while the read is healthy, and stop once it is not.
 *
 * A user with no broker credential gets a hard rejection from
 * `positions.list`, and a fixed interval would re-issue that same rejected
 * request every minute for as long as a chart is on screen. One failure is
 * enough: the query re-runs on mount, on window focus, and whenever the
 * instrument changes, so a credential added later is still picked up.
 */
function pollWhileHealthy(active: boolean) {
  return (query: { state: { error: unknown } }) =>
    active && !query.state.error ? STOP_LOSS_POLL_MS : (false as const);
}

export function useChartStopLosses({
  symbol,
  isPerps,
  credentialId,
  accountId,
  enabled = true,
}: {
  symbol: string;
  isPerps: boolean;
  credentialId?: string;
  accountId?: string;
  /** Off for preview / unauthenticated surfaces, which have no positions. */
  enabled?: boolean;
}): StopLossLine[] {
  // Both queries are declared unconditionally (rules of hooks) and only the
  // venue on screen is enabled, so a stock chart never calls Hyperliquid and a
  // perp chart never calls Alpaca.
  const equityPositions = trpc.positions.list.useQuery(
    { credentialId, accountId },
    {
      enabled: enabled && !isPerps,
      refetchInterval: pollWhileHealthy(!isPerps),
      staleTime: STOP_LOSS_POLL_MS / 2,
      retry: false,
    },
  );

  const perpOrders = trpc.positions.listPerpOpenOrders.useQuery(undefined, {
    enabled: enabled && isPerps,
    refetchInterval: pollWhileHealthy(isPerps),
    staleTime: STOP_LOSS_POLL_MS / 2,
    retry: false,
  });

  return useMemo(() => {
    if (!enabled) return [];
    if (isPerps) return perpStopLossLines(perpOrders.data?.orders ?? [], symbol);
    return equityStopLossLines(equityPositions.data ?? [], symbol);
  }, [enabled, isPerps, symbol, perpOrders.data, equityPositions.data]);
}
