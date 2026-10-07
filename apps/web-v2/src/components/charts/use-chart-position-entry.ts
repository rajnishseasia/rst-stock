"use client";

/**
 * Reads active user positions (avgEntryPrice for equities, entryPx for perps)
 * and folds them into PositionEntryLine objects for the current chart symbol.
 */

import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import {
  equityPositionEntryLines,
  perpPositionEntryLines,
  type PositionEntryLine,
} from "./position-entry-lines";

export const POSITION_ENTRY_POLL_MS = 30_000;

function pollWhileHealthy(active: boolean) {
  return (query: { state: { error: unknown } }) =>
    active && !query.state.error ? POSITION_ENTRY_POLL_MS : (false as const);
}

export function useChartPositionEntry({
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
  enabled?: boolean;
}): PositionEntryLine[] {
  const equityPositions = trpc.positions.list.useQuery(
    { credentialId, accountId },
    {
      enabled: enabled && !isPerps,
      refetchInterval: pollWhileHealthy(!isPerps),
      staleTime: POSITION_ENTRY_POLL_MS / 2,
      retry: false,
    },
  );

  const perpPositions = trpc.positions.listPerps.useQuery(undefined, {
    enabled: enabled && isPerps,
    refetchInterval: pollWhileHealthy(isPerps),
    staleTime: POSITION_ENTRY_POLL_MS / 2,
    retry: false,
  });

  return useMemo(() => {
    if (!enabled) return [];
    if (isPerps) {
      return perpPositionEntryLines(perpPositions.data?.positions ?? [], symbol);
    }
    return equityPositionEntryLines(equityPositions.data ?? [], symbol);
  }, [enabled, isPerps, symbol, perpPositions.data, equityPositions.data]);
}
