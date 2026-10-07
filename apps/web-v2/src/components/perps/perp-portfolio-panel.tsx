"use client";

import { PerpFillsPanel } from "@/components/perps/perp-fills-panel";
import { formatUsd } from "@/lib/format";
import { trpc } from "@/lib/trpc";

/** Hyperliquid-only portfolio summary and realized account activity. */
export function PerpPortfolioPanel({ enabled }: { enabled: boolean }) {
  const statusQuery = trpc.hyperliquid.status.useQuery(undefined, {
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (!enabled) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        Set up Hyperliquid to view your perp portfolio.
      </div>
    );
  }

  const equity = statusQuery.data?.hlEquityUsd;
  const network = statusQuery.data?.network;

  return (
    <section
      aria-label="Perps portfolio"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="grid shrink-0 grid-cols-2 border-b">
        <PortfolioMetric
          label="Total equity"
          value={statusQuery.isLoading ? "Loading…" : equity != null ? formatUsd(equity) : "-"}
        />
        <PortfolioMetric
          label="Network"
          value={network ? network.replace(/^./, (char) => char.toUpperCase()) : "-"}
        />
      </div>
      {statusQuery.error && (
        <div className="border-b px-3 py-2 text-xs text-destructive">
          {statusQuery.error.message}
        </div>
      )}
      <div className="shrink-0 border-b px-3 py-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
        Realized activity
      </div>
      <div className="min-h-0 flex-1">
        <PerpFillsPanel enabled={enabled} />
      </div>
    </section>
  );
}

function PortfolioMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-r px-3 py-2 last:border-r-0">
      <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate font-data text-sm font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}
