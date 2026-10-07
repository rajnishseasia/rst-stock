"use client";

/**
 * The bottom drawer's Balances tab, one component per venue.
 *
 * Both read data the terminal was already fetching and discarding: the stocks
 * grid comes out of the same `positions.account` response the header takes
 * portfolio value and buying power from, and the perps grid out of
 * `hyperliquid.status` plus the thin `hyperliquid.collateral` procedure that
 * exposes the free-collateral figure copy-mirror sizing already computed
 * server-side.
 *
 * The cells themselves are pure data (`balances-metrics.ts`); this file owns
 * only the queries and the chrome. Hairline separators, no filled cells: gold
 * is a seasoning here as everywhere (DESIGN.md).
 *
 * Scroll classes are `xl:`-gated. The drawer hosting this exists only at `xl`;
 * on anything narrower the page owns the single scroll region.
 */

import type { ReactNode } from "react";
import { BarChart2 } from "lucide-react";

import {
  perpBalanceMetrics,
  stockBalanceMetrics,
  type BalanceMetric,
} from "@/components/trade/balances-metrics";
import { EmptyState } from "@/components/ui/empty-state";
import { trpc } from "@/lib/trpc";

function BalancesGrid({ metrics }: { metrics: BalanceMetric[] }) {
  return (
    <div className="@container/balances min-w-0">
      <div className="grid grid-cols-2 gap-px bg-border @[560px]/balances:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 bg-background px-3 py-2" title={metric.hint}>
            <div className="truncate text-3xs font-medium uppercase tracking-wide text-muted-foreground">
              {metric.label}
            </div>
            <div className="truncate font-data text-sm font-semibold tabular-nums">
              {metric.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BalancesShell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col bg-background xl:h-full xl:min-h-0"
    >
      <div className="min-w-0 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
        {children}
      </div>
    </section>
  );
}

export function StockBalancesPanel({
  isSignedIn,
  activeCredentialId,
  credentialsLoading = false,
}: {
  isSignedIn: boolean;
  activeCredentialId?: string;
  credentialsLoading?: boolean;
}) {
  const accountQuery = trpc.positions.account.useQuery(
    { credentialId: activeCredentialId },
    {
      enabled: !!activeCredentialId,
      // Same cadence as the header's account read, so the two cannot disagree
      // about buying power for a minute at a time.
      refetchInterval: 60_000,
      retry: false,
    },
  );

  const awaitingCredentials = isSignedIn && credentialsLoading && !activeCredentialId;

  if (awaitingCredentials) {
    return (
      <BalancesShell label="Stock balances">
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Loading balances...
        </div>
      </BalancesShell>
    );
  }

  if (!isSignedIn) {
    return (
      <BalancesShell label="Stock balances">
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Sign in to see your balances.
        </div>
      </BalancesShell>
    );
  }

  if (!activeCredentialId) {
    return (
      <BalancesShell label="Stock balances">
        <EmptyState
          icon={BarChart2}
          title="No stock account connected"
          body="Cash, buying power and margin for your Alpaca account show up here. Perp collateral lives on the perps venue."
          actions={[
            {
              label: "Connect Alpaca",
              href: "/settings",
              emphasis: "secondary" as const,
            },
          ]}
        />
      </BalancesShell>
    );
  }

  return (
    <BalancesShell label="Stock balances">
      {accountQuery.error && (
        <div className="border-b px-3 py-2 text-xs text-destructive">
          {accountQuery.error.message}
        </div>
      )}
      {accountQuery.isLoading ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Loading balances...
        </div>
      ) : (
        <BalancesGrid metrics={stockBalanceMetrics(accountQuery.data)} />
      )}
    </BalancesShell>
  );
}

export function PerpBalancesPanel({ enabled }: { enabled: boolean }) {
  const statusQuery = trpc.hyperliquid.status.useQuery(undefined, {
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  // Free collateral is a second venue read rather than a field on `status`,
  // because it resolves the account's abstraction mode first (unified account
  // and portfolio margin keep collateral in the spot ledger). Its own failure
  // must not blank the equity and collateral cells, so it is a separate query
  // that fails soft to "-".
  const collateralQuery = trpc.hyperliquid.collateral.useQuery(undefined, {
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });

  if (!enabled) {
    return (
      <BalancesShell label="Perp balances">
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Set up Hyperliquid to view your perp balances.
        </div>
      </BalancesShell>
    );
  }

  return (
    <BalancesShell label="Perp balances">
      {statusQuery.error && (
        <div className="border-b px-3 py-2 text-xs text-destructive">
          {statusQuery.error.message}
        </div>
      )}
      {statusQuery.isLoading ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          Loading balances...
        </div>
      ) : (
        <BalancesGrid
          metrics={perpBalanceMetrics({
            status: statusQuery.data,
            collateral: collateralQuery.data,
          })}
        />
      )}
    </BalancesShell>
  );
}
