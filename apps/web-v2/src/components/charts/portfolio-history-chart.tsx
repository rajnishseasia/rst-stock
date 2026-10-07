"use client";

import { useMemo, useState, type PointerEvent } from "react";
import { AlertTriangle, LineChart } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapseButton, useCollapsible } from "@/components/ui/section-collapse";
import { EmptyState, type EmptyStateAction } from "@/components/ui/empty-state";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatSignedNumber, formatUsd } from "@/lib/format";

const UP_COLOR = "#157A52";
const DOWN_COLOR = "#C0432F";
const GOLD = "#C59A3E";

type Period = "1D" | "1W" | "1M" | "ALL";
const PERIODS: Period[] = ["1D", "1W", "1M", "ALL"];

type PortfolioPoint = { t: number; equity: number; pnl: number; pnlPct: number };
type PortfolioHistoryData = {
  points: PortfolioPoint[];
  baseValue: number;
  period: string;
};

type ChartPoint = PortfolioPoint & { x: number; y: number };

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCompactUsd(value: number): string {
  return compactUsdFormatter.format(value);
}

function formatAxisTime(t: number, period: string): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  if (period === "1D") {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

function formatTooltipTime(t: number, period: string): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  if (period === "1D") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

function PeriodToggle({
  period,
  onPeriodChange,
}: {
  period: Period;
  onPeriodChange: (p: Period) => void;
}) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-md border p-0.5 text-xs">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPeriodChange(p)}
          aria-pressed={period === p}
          className={cn(
            "font-data rounded-sm px-2.5 py-1 transition-colors",
            period === p
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function getChartPoint(points: PortfolioPoint[], index: number, width: number, height: number) {
  const values = points.map((p) => p.equity);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = Math.max((maxValue - minValue) * 0.08, 1);
  const min = minValue - padding;
  const max = maxValue + padding;
  const span = max - min || 1;
  const point = points[index];
  const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
  const y = height - ((point.equity - min) / span) * height;

  return { ...point, x, y };
}

function useChartGeometry(points: PortfolioPoint[]) {
  return useMemo(() => {
    const width = 640;
    const height = 210;
    const chartPoints = points.map((_, index) => getChartPoint(points, index, width, height));
    const linePath = chartPoints
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    const areaPath =
      chartPoints.length > 0
        ? `${linePath} L ${chartPoints[chartPoints.length - 1].x.toFixed(2)} ${height} L ${chartPoints[0].x.toFixed(2)} ${height} Z`
        : "";

    return { width, height, chartPoints, linePath, areaPath };
  }, [points]);
}

function ChartTooltip({ point, period }: { point: ChartPoint; period: string }) {
  const up = point.pnl >= 0;
  // Flip tooltip below the point when it's in the upper ~40% of the chart so
  // it doesn't overflow outside the container and get clipped.
  const showBelow = point.y / 210 < 0.4;

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border bg-card px-3 py-2 text-xs shadow-floating"
      style={{
        left: `${Math.min(Math.max((point.x / 640) * 100, 12), 88)}%`,
        top: `${Math.min(Math.max((point.y / 210) * 100, 5), showBelow ? 55 : 88)}%`,
        transform: showBelow ? "translate(-50%, 8px)" : "translate(-50%, -110%)",
      }}
    >
      <div className="text-muted-foreground">{formatTooltipTime(point.t, period)}</div>
      <div className="font-data tabular-nums font-medium">{formatUsd(point.equity)}</div>
      <div className="font-data tabular-nums" style={{ color: up ? UP_COLOR : DOWN_COLOR }}>
        {up ? "+" : ""}
        {formatUsd(point.pnl)} ({formatSignedNumber(point.pnlPct, "%")})
      </div>
    </div>
  );
}

function PortfolioSvgChart({
  points,
  period,
}: {
  points: PortfolioPoint[];
  period: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { width, height, chartPoints, linePath, areaPath } = useChartGeometry(points);
  const activePoint = activeIndex == null ? undefined : chartPoints[activeIndex];
  const yTicks = useMemo(() => {
    const values = points.map((p) => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mid = (min + max) / 2;
    return [
      { value: max, y: 0 },
      { value: mid, y: height / 2 },
      { value: min, y: height },
    ];
  }, [height, points]);

  const xTicks = useMemo(() => {
    if (chartPoints.length === 0) return [];
    const middle = Math.floor((chartPoints.length - 1) / 2);
    const indexes = Array.from(new Set([0, middle, chartPoints.length - 1]));
    return indexes.map((index) => chartPoints[index]);
  }, [chartPoints]);

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - box.left, 0), box.width);
    const ratio = box.width === 0 ? 0 : x / box.width;
    const nextIndex = Math.round(ratio * (chartPoints.length - 1));
    setActiveIndex(Math.min(Math.max(nextIndex, 0), chartPoints.length - 1));
  }

  return (
    <div className="relative h-56 w-full">
      {activePoint && <ChartTooltip point={activePoint} period={period} />}
      <svg
        role="img"
        aria-label="Portfolio equity history"
        viewBox={`0 0 ${width} ${height + 34}`}
        className="h-full w-full overflow-visible"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id="portfolio-equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GOLD} stopOpacity="0.28" />
            <stop offset="100%" stopColor={GOLD} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, height / 2, height].map((y) => (
          <line
            key={y}
            x1="0"
            x2={width}
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeDasharray="3 5"
            className="text-border"
          />
        ))}
        {yTicks.map((tick) => (
          <text
            key={`${tick.value}-${tick.y}`}
            x={width}
            y={tick.y + (tick.y === 0 ? 10 : tick.y === height ? -4 : 4)}
            textAnchor="end"
            className="fill-muted-foreground font-data text-2xs"
          >
            {formatCompactUsd(tick.value)}
          </text>
        ))}
        {areaPath && <path d={areaPath} fill="url(#portfolio-equity-fill)" />}
        {linePath && <path d={linePath} fill="none" stroke={GOLD} strokeWidth="2.5" strokeLinecap="round" />}
        {activePoint && (
          <>
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1="0"
              y2={height}
              stroke={GOLD}
              strokeOpacity="0.35"
            />
            <circle cx={activePoint.x} cy={activePoint.y} r="4" fill={GOLD} stroke="var(--card)" strokeWidth="2" />
          </>
        )}
        {xTicks.map((tick) => (
          <text
            key={tick.t}
            x={tick.x}
            y={height + 24}
            textAnchor={tick.x < 24 ? "start" : tick.x > width - 24 ? "end" : "middle"}
            className="fill-muted-foreground font-data text-2xs"
          >
            {formatAxisTime(tick.t, period)}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function PortfolioHistoryCard({
  data,
  period,
  onPeriodChange,
  isLoading,
  error,
  collapsed,
  onToggleCollapse,
  embedded = false,
  onBrowseSignals,
  isConnected = false,
}: {
  data: PortfolioHistoryData | undefined;
  period: Period;
  onPeriodChange: (p: Period) => void;
  isLoading?: boolean;
  /**
   * A broker credential is selected. Without it the empty curve offered
   * "Connect Alpaca" to a user who HAD connected one, sending them to Settings
   * for something they had already done: a brand new account has no fills yet,
   * so a successful, empty history is the normal first state, not a sign that
   * nothing is connected.
   */
  isConnected?: boolean;
  error?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  embedded?: boolean;
  onBrowseSignals?: () => void;
}) {
  const points = data?.points ?? [];
  const hasPoints = points.length > 0;
  const latest = hasPoints ? points[points.length - 1] : undefined;
  const baseValue = data?.baseValue ?? 0;
  const latestEquity = latest?.equity ?? 0;
  const totalPnl = hasPoints ? latestEquity - baseValue : 0;
  const totalPnlPct = baseValue !== 0 ? (totalPnl / baseValue) * 100 : 0;
  const up = totalPnl >= 0;
  const accent = up ? UP_COLOR : DOWN_COLOR;
  const isCollapsed = embedded ? false : collapsed;

  return (
    <Card
      className={cn(
        embedded && "h-full min-h-0 gap-0 overflow-hidden rounded-none bg-transparent py-0 ring-0",
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 @md/card-header:flex-row @md/card-header:items-start @md/card-header:justify-between">
          <div className="min-w-0">
            {!embedded && <CardTitle className="text-lg">Portfolio</CardTitle>}
            {hasPoints ? (
              <CardDescription className="font-data max-w-full tabular-nums [overflow-wrap:anywhere]">
                <span className="text-foreground text-base font-semibold">
                  {formatUsd(latestEquity)}
                </span>{" "}
                <span className="font-medium" style={{ color: accent }}>
                  {up ? "+" : ""}
                  {formatUsd(totalPnl)} ({formatSignedNumber(totalPnlPct, "%")})
                </span>
              </CardDescription>
            ) : (
              <CardDescription>Equity over time</CardDescription>
            )}
          </div>
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2 self-end @md/card-header:shrink-0 @md/card-header:self-start">
            <PeriodToggle period={period} onPeriodChange={onPeriodChange} />
            {!embedded && (
              <CollapseButton
                collapsed={collapsed}
                onToggle={onToggleCollapse}
                label="Portfolio"
              />
            )}
          </div>
        </div>
      </CardHeader>
      {!isCollapsed && (
        <CardContent className={cn(embedded && "min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2")}>
          {isLoading ? (
            <div className="h-56 w-full animate-pulse rounded-md bg-muted" />
          ) : error ? (
            <div className="flex h-56 items-center justify-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : !hasPoints ? (
            // Signal-first: the way into a portfolio curve is a trade, and the
            // way into a trade here is a call in the feed. Connecting a broker
            // is the SECOND offer, not the headline.
            <EmptyState
              className="h-56 justify-center py-0"
              icon={LineChart}
              title="No portfolio history yet"
              body="The curve starts the day your first order fills."
              actions={[
                ...(onBrowseSignals
                  ? [{ label: "Browse signals", onClick: onBrowseSignals }]
                  : []),
                // Only offered when there is genuinely nothing connected.
                ...(isConnected
                  ? []
                  : [
                      {
                        label: "Connect Alpaca",
                        href: "/settings" as const,
                        emphasis: "secondary" as const,
                      },
                    ]),
              ] satisfies EmptyStateAction[]}
            />
          ) : (
            <PortfolioSvgChart points={points} period={period} />
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function PortfolioHistoryChartView({
  data,
  period,
  onPeriodChange,
  isLoading,
  error,
  embedded = false,
  onBrowseSignals,
  isConnected = false,
}: {
  data: PortfolioHistoryData | undefined;
  period: Period;
  onPeriodChange: (p: Period) => void;
  isLoading?: boolean;
  error?: string;
  embedded?: boolean;
  onBrowseSignals?: () => void;
  /** See `PortfolioHistoryCard`. Forwarded, not decided, here. */
  isConnected?: boolean;
}) {
  const { collapsed, toggle } = useCollapsible("portfolio");

  return (
    <PortfolioHistoryCard
      data={data}
      period={period}
      onPeriodChange={onPeriodChange}
      isLoading={isLoading}
      error={error}
      collapsed={collapsed}
      onToggleCollapse={toggle}
      embedded={embedded}
      onBrowseSignals={onBrowseSignals}
      isConnected={isConnected}
    />
  );
}

export function PortfolioHistoryChart({
  credentialId,
  embedded = false,
  onBrowseSignals,
}: {
  credentialId?: string;
  embedded?: boolean;
  /**
   * Route back to the signal feed from the empty curve. Only the mobile shell
   * passes this; on the terminal the feed is already on screen.
   */
  onBrowseSignals?: () => void;
}) {
  const [period, setPeriod] = useState<Period>("1M");

  const q = trpc.positions.portfolioHistory.useQuery(
    { credentialId, period },
    { enabled: !!credentialId, refetchInterval: 60000 }
  );

  return (
    <PortfolioHistoryChartView
      data={q.data}
      period={period}
      isLoading={q.isLoading}
      error={q.error?.message}
      onPeriodChange={setPeriod}
      embedded={embedded}
      onBrowseSignals={onBrowseSignals}
      isConnected={!!credentialId}
    />
  );
}
